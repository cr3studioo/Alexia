// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { ACTIONS, action, decode, encode, keyboard, PANEL_VERSION, panelUrl, stateOf } from '../panel.js'

// State rides in the URL fragment, which a static page can read but a host never sees — so
// `encode`/`decode` are the whole of the privacy story, and `panelUrl` is what has to refuse
// to build a URL that is unsafe or too big. `action` is the other side of the same coin: the
// page is trusted, the message that claims to be from it is not.

test('encode/decode round trip, including unicode', () => {
  const state = {
    v: 1,
    at: 1_700_000_000_000,
    mode: 'combined',
    prefer: 'cheap',
    today: { spent: 0.12, allowance: 1 },
    month: { spent: 3.4, cap: 20 },
    running: true,
    waiting: 2,
    voice: 'mirror',
    paired: 1,
    note: 'héllo — 😀',
  }
  const fragment = encode(state)
  expect(decode(fragment)).toEqual(state)
  // The panel page reads `location.hash`, which keeps the leading #.
  expect(decode(`#${fragment}`)).toEqual(state)
})

test('decode returns undefined for garbage, not a throw', () => {
  expect(decode('not base64url at all !!!')).toBeUndefined()
  expect(decode('')).toBeUndefined()
  expect(decode('#')).toBeUndefined()
  expect(decode(undefined)).toBeUndefined()
  // Valid base64url that decodes to JSON that is not an object.
  expect(decode(Buffer.from('"just a string"', 'utf8').toString('base64url'))).toBeUndefined()
  expect(decode(Buffer.from('42', 'utf8').toString('base64url'))).toBeUndefined()
})

const STATE = { v: 1, at: 1, running: false, waiting: 0, voice: 'mirror', paired: 1 }

test('panelUrl rejects a non-https base', () => {
  expect(panelUrl('http://example.com/telegram/', STATE)).toBeUndefined()
  expect(panelUrl('not a url', STATE)).toBeUndefined()
  expect(panelUrl('ftp://example.com/', STATE)).toBeUndefined()
  expect(panelUrl(undefined, STATE)).toBeUndefined()
})

test('panelUrl replaces an existing hash rather than appending to it', () => {
  const url = panelUrl('https://example.com/telegram/#stale-state', STATE)
  expect(url.startsWith('https://example.com/telegram/#')).toBe(true)
  expect(url).not.toContain('stale-state')
  expect(url).toBe(`https://example.com/telegram/#${encode(STATE)}`)
})

test('panelUrl is undefined once the URL would exceed 2048 characters', () => {
  const huge = { ...STATE, note: 'x'.repeat(3000) }
  expect(panelUrl('https://example.com/telegram/', huge)).toBeUndefined()
  // The same base, with a state that does fit, still works.
  expect(panelUrl('https://example.com/telegram/', STATE)).toBeDefined()
})

test('action accepts only what is on the allowlist', () => {
  expect(action(JSON.stringify({ do: 'new' }))).toEqual(ACTIONS.new)
  expect(action(JSON.stringify({ do: 'stop' }))).toEqual({ stop: true })
  expect(action(JSON.stringify({ do: 'voice:always' }))).toEqual({ voice: 'always' })
  expect(action(JSON.stringify({ do: 'cheap' }))).toEqual({ command: '/cheap' })
})

test('action rejects anything not on the allowlist, including prototype keys', () => {
  expect(action(JSON.stringify({ do: 'nope' }))).toBeUndefined()
  expect(action(JSON.stringify({ do: '__proto__' }))).toBeUndefined()
  expect(action(JSON.stringify({ do: 'constructor' }))).toBeUndefined()
  expect(action(JSON.stringify({ do: 'toString' }))).toBeUndefined()
  expect(action(JSON.stringify({ do: 'hasOwnProperty' }))).toBeUndefined()
})

test('action rejects malformed input without throwing', () => {
  expect(action('not json')).toBeUndefined()
  expect(action('{"do":')).toBeUndefined()
  expect(action(JSON.stringify(['do', 'new']))).toBeUndefined()
  expect(action(JSON.stringify('new'))).toBeUndefined()
  expect(action(JSON.stringify(null))).toBeUndefined()
  expect(action(JSON.stringify({ do: 5 }))).toBeUndefined()
  expect(action(JSON.stringify({}))).toBeUndefined()
})

test('action rejects the wrong type or an oversize payload', () => {
  expect(action(undefined)).toBeUndefined()
  expect(action(42)).toBeUndefined()
  expect(action({ do: 'new' })).toBeUndefined()
  expect(action(JSON.stringify({ do: 'new', pad: 'x'.repeat(5000) }))).toBeUndefined()
})

test('keyboard builds a persistent reply keyboard with one web_app button', () => {
  expect(keyboard('https://example.com/telegram/#abc')).toEqual({
    keyboard: [[{ text: '⚙ Panel', web_app: { url: 'https://example.com/telegram/#abc' } }]],
    resize_keyboard: true,
    is_persistent: true,
  })
})

/**
 * The snapshot itself (D196): half of it is core's `/status` and half is this plugin's own.
 *
 * The rule the page depends on is *absent rather than empty* — a field core did not send has
 * to be missing, so the page can draw "—" instead of a zero that reads as a real number. An
 * Alexia older than D193 sends no `alexia/command` at all, and the panel still has to work.
 */

const OWN = { at: 1_700_000_000_000, running: false, waiting: 0, voice: 'mirror', paired: 1 }

test('stateOf carries every field core sent', () => {
  const facts = {
    mode: 'cloud',
    prefer: 'best',
    today: { spent: 0.5, allowance: 2 },
    month: { spent: 9, cap: 20 },
    running: true,
  }
  expect(stateOf(facts, OWN)).toEqual({
    v: PANEL_VERSION,
    at: OWN.at,
    mode: 'cloud',
    prefer: 'best',
    today: { spent: 0.5, allowance: 2 },
    month: { spent: 9, cap: 20 },
    running: true,
    waiting: 0,
    voice: 'mirror',
    paired: 1,
  })
})

test('an older Alexia that sent nothing still gets a panel, minus what it could not say', () => {
  const state = stateOf(undefined, { ...OWN, running: true, waiting: 3, paired: 2 })
  // Core's half is absent, not zeroed — the page draws "—" for these rather than a number.
  expect('mode' in state).toBe(false)
  expect('prefer' in state).toBe(false)
  expect('today' in state).toBe(false)
  expect('month' in state).toBe(false)
  // This plugin's own half is all there, including its own view of whether it is busy.
  expect(state).toMatchObject({ v: PANEL_VERSION, running: true, waiting: 3, voice: 'mirror', paired: 2 })
})

test("core's answer about what is running wins over this end's guess", () => {
  expect(stateOf({ running: false }, { ...OWN, running: true }).running).toBe(false)
  expect(stateOf({ running: true }, { ...OWN, running: false }).running).toBe(true)
  // And when core did not say, this end's own view is better than nothing.
  expect(stateOf({}, { ...OWN, running: true }).running).toBe(true)
})

test('stateOf refuses a field of the wrong shape rather than passing it on', () => {
  const state = stateOf({ mode: 42, prefer: ['cheap'], today: 'lots', month: null }, OWN)
  expect('mode' in state).toBe(false)
  expect('prefer' in state).toBe(false)
  expect('today' in state).toBe(false)
  expect('month' in state).toBe(false)
})

test('a state built with nothing at all is still a state the page can read', () => {
  const state = stateOf(undefined, undefined)
  expect(state.v).toBe(PANEL_VERSION)
  expect(state).toMatchObject({ at: 0, running: false, waiting: 0, paired: 0 })
  // And it survives the trip it was built for.
  expect(decode(encode(state))).toEqual(state)
})
