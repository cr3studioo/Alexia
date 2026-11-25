// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, expect, test } from 'vitest'
import { createLoop, createScreenMemory, frontOf, readSettings, screenshotPath, TABLE } from '../capture.js'
import { REMOVED } from '../filter.js'
import { memoryStore } from './store.js'

const base = mkdtempSync(join(tmpdir(), 'screen-memory-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-25T10:00:00Z')
const FRONT = { app: 'Code.exe', title: 'build.log – Visual Studio Code', fullscreen: false, titleBar: true }

/**
 * Two directions of meaning, so a question and a moment can match with no word in common:
 * anything about failures points one way, anything about travel the other.
 */
const vectorOf = (text) => (/error|exception|failed|failure|crash/i.test(text) ? [1, 0, 0] : /flight|price|lisbon|fare/i.test(text) ? [0, 1, 0] : [0, 0, 1])

/**
 * Fake capabilities. Each screenshot writes a real file, so the test can see it deleted. `ocr`
 * is what reading it does: a string, an error result, or a throw.
 */
function setup({ settings = { on: true }, ocr = 'NullReferenceException at Program.Main', front = FRONT, embeds = true, now = () => NOW } = {}) {
  const store = memoryStore()
  const calls = []
  const shots = []
  const memory = createScreenMemory({
    storage: store,
    settings: async () => settings,
    answers: async (cap) => ({ answers: cap !== 'text.embed' || embeds, here: true }),
    capability: async (cap, args) => {
      calls.push(cap)
      if (cap === 'computer.screenshot') {
        const path = join(base, `screen-${String(shots.length)}-${String(Math.random()).slice(2)}.png`)
        writeFileSync(path, 'png')
        shots.push(path)
        return {
          content: [{ type: 'text', text: `Saved ${path} (1920x1080).` }, { type: 'resource_link', uri: pathToFileURL(path).href, name: 'screen' }],
          structuredContent: { front },
        }
      }
      if (cap === 'image.ocr') {
        // Reading needs the picture still there.
        expect(existsSync(args.file)).toBe(true)
        if (ocr instanceof Error) throw ocr
        if (typeof ocr === 'object') return ocr
        return { content: [{ type: 'text', text: ocr }] }
      }
      if (cap === 'text.embed') return { structuredContent: { vectors: args.texts.map(vectorOf) } }
      throw new Error(`unexpected ${cap}`)
    },
    unlink: (path) => rm(path),
    now,
  })
  return { memory, store, calls, shots }
}

test('off_by_default_takes_nothing', async () => {
  expect(readSettings({}).on).toBe(false)
  expect(readSettings({ on: 'yes' }).on).toBe(false)
  const { memory, calls, store } = setup({ settings: {} })
  expect(await memory.captureOnce()).toEqual({ kept: false, reason: 'off' })
  expect(calls).toEqual([])
  expect(store.table(TABLE)).toEqual([])

  // The loop does not even start a capture timer while off.
  const timers = []
  const loop = createLoop({ memory, set: (fn, ms) => (timers.push(ms), { ms }), clear: () => {} })
  await loop.arm()
  expect(timers).toEqual([DAY])
})

test('image_deleted_even_when_ocr_fails', async () => {
  for (const ocr of [new Error('the recogniser crashed'), { isError: true, content: [{ type: 'text', text: 'found no text' }] }]) {
    const { memory, shots, store, calls } = setup({ ocr })
    expect(await memory.captureOnce()).toEqual({ kept: false, reason: 'ocr_failed' })
    expect(calls).toEqual(['computer.screenshot', 'image.ocr'])
    expect(shots).toHaveLength(1)
    expect(existsSync(shots[0])).toBe(false)
    expect(store.table(TABLE)).toEqual([])
  }
  // A window that rules the moment out is deleted without being read.
  const { memory, shots, calls } = setup({ front: { ...FRONT, title: 'Sign in – Bank' } })
  expect(await memory.captureOnce()).toEqual({ kept: false, reason: 'sign_in' })
  expect(calls).toEqual(['computer.screenshot'])
  expect(existsSync(shots[0])).toBe(false)
  // So is one whose provider does not say which window is in front.
  const blind = setup({ front: null })
  expect((await blind.memory.captureOnce()).reason).toBe('unknown_window')
  expect(existsSync(blind.shots[0])).toBe(false)
})

test('a kept moment has its secrets cut out and the picture gone', async () => {
  const card = ['4111', '1111', '1111', '1111'].join(' ')
  const { memory, store, shots } = setup({ ocr: `Payment failed for card ${card}` })
  expect(await memory.captureOnce()).toEqual({ kept: true, reason: 'kept' })
  expect(existsSync(shots[0])).toBe(false)
  const [row] = store.table(TABLE)
  expect(row).toEqual(expect.objectContaining({ at: NOW, app: 'Code.exe', title: FRONT.title, text: `Payment failed for card ${REMOVED}` }))
  expect(JSON.parse(row.vec)).toEqual([1, 0, 0])
  expect((await store.get('last')).outcome).toBe('kept')
})

test('prune_after_keep_days', async () => {
  const { memory, store } = setup({ settings: { on: false, keep_days: '3' } })
  for (const days of [0, 1, 2.9, 3.1, 10, 20]) {
    await store.insert(TABLE, { at: NOW - days * DAY, app: 'a', title: 't', text: `day ${String(days)}`, vec: null })
  }
  expect(await memory.prune()).toBe(3)
  expect(store.table(TABLE).map((r) => r.text)).toEqual(['day 0', 'day 1', 'day 2.9'])

  // The loop prunes on arm and then once a day, whether capture is on or not.
  const timers = []
  const loop = createLoop({ memory, set: (fn, ms) => (timers.push({ fn, ms }), {}), clear: () => {} })
  await store.insert(TABLE, { at: NOW - 5 * DAY, app: 'a', title: 't', text: 'old', vec: null })
  await loop.arm()
  expect(store.table(TABLE)).toHaveLength(3)
  expect(timers.map((t) => t.ms)).toEqual([DAY])
  await store.insert(TABLE, { at: NOW - 4 * DAY, app: 'a', title: 't', text: 'old again', vec: null })
  await timers[0].fn()
  await new Promise((r) => setTimeout(r, 10))
  expect(store.table(TABLE)).toHaveLength(3)
  // 14 is the default.
  expect(readSettings({}).keep_days).toBe(14)
})

test('recall_by_meaning', async () => {
  const clock = { t: NOW - 3 * 60 * 60 * 1000 }
  const s = setup({ now: () => clock.t, ocr: 'NullReferenceException at Program.Main line 42' })
  await s.memory.captureOnce()
  clock.t = NOW - 60 * 60 * 1000
  const flights = setup({ now: () => clock.t, ocr: 'Prague → Lisbon, return, 2 190 Kč' })
  // Same table: one memory writing, the other only reading.
  const both = createScreenMemory({
    storage: s.store,
    settings: async () => ({ on: true }),
    answers: async () => ({ answers: true }),
    capability: async (cap, args) => (cap === 'text.embed' ? { structuredContent: { vectors: args.texts.map(vectorOf) } } : undefined),
    unlink: async () => {},
    now: () => NOW,
  })
  await flights.memory.captureOnce()
  for (const row of flights.store.table(TABLE)) await s.store.insert(TABLE, row)

  // Not one word in common with the moment it should find.
  const found = await both.recall({ query: 'what was that crash this morning' })
  expect(found.byMeaning).toBe(true)
  expect(found.results[0].text).toMatch(/NullReferenceException/)
  const fare = await both.recall({ query: 'the fare I had open' })
  expect(fare.results[0].text).toMatch(/Lisbon/)

  // A window of time narrows it.
  const later = await both.recall({ query: 'crash', from: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() })
  expect(later.results.every((r) => !/NullReference/.test(r.text))).toBe(true)

  // And forgetting a span removes exactly that span.
  const gone = await both.forget({ from: NOW - 4 * 60 * 60 * 1000, to: NOW - 2 * 60 * 60 * 1000 })
  expect(gone.deleted).toBe(1)
  expect(s.store.table(TABLE).map((r) => r.text)).toEqual(['Prague → Lisbon, return, 2 190 Kč'])
  expect((await both.forget({ from: NOW })).error).toMatch(/both/)
})

test('recall falls back to words when nothing can embed', async () => {
  const { memory } = setup({ embeds: false, ocr: 'Error 0x80070005 access denied' })
  await memory.captureOnce()
  const found = await memory.recall({ query: 'access denied' })
  expect(found.byMeaning).toBe(false)
  expect(found.results).toHaveLength(1)
  expect((await memory.recall({ query: '' })).error).toBeDefined()
})

test('the loop captures every few minutes only while on', async () => {
  const { memory } = setup({ settings: { on: true, every_minutes: '2' } })
  const timers = []
  const loop = createLoop({ memory, set: (fn, ms) => (timers.push(ms), {}), clear: () => {} })
  await loop.arm()
  expect(timers.sort((a, b) => a - b)).toEqual([2 * 60_000, DAY])
})

test('the screenshot result is read for its path and its window', () => {
  expect(screenshotPath({ content: [{ type: 'text', text: 'Saved /tmp/screen-1.png (800x600). You cannot see it' }] })).toBe('/tmp/screen-1.png')
  expect(screenshotPath({ structuredContent: { path: '/x/y.png' } })).toBe('/x/y.png')
  expect(screenshotPath({ isError: true, content: [{ type: 'text', text: 'no folder' }] })).toBeUndefined()
  expect(frontOf({ structuredContent: { window: { process: 'a.exe', title: 't', full_screen: true, title_bar: false } } })).toEqual({
    front: { app: 'a.exe', title: 't', fullscreen: true, titleBar: false },
    locked: false,
  })
  expect(frontOf({}).front).toBeUndefined()
})
