// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { detail, elapsed, GLYPH, isPhase, mountStatus, next, type Phase, pick, WORDS } from '../src/status.js'

/**
 * The line under an answer while it is made: a word for fun, the true detail, and a clock.
 *
 * The detail is the half that has a rule — it says what is actually happening, from the event's
 * own fields — so every stage is spelled out here, word for word. The word has a different rule,
 * *it only changes when the stage does*, and a flicker is the complaint that rule exists to
 * prevent. The clock is arithmetic somebody reads, and a timer that outlives its answer is a
 * leak nobody would ever see, so both are checked with fake time.
 */

/** A random source that says what it is told, in order, then keeps saying the last thing. */
const sequence = (...values: number[]): (() => number) => {
  let at = 0
  return () => values[Math.min(at++, values.length - 1)]!
}

beforeEach(() => {
  document.body.replaceChildren()
})

afterEach(() => {
  vi.useRealTimers()
})

// ---- the detail ---------------------------------------------------------------------------

test('every stage says what is happening, built from its own fields', () => {
  const cases: [Phase, string][] = [
    [{ kind: 'choosing' }, 'choosing a model'],
    [{ kind: 'reading' }, 'reading your files'],
    [{ kind: 'asking', model: 'Qwen 3.8' }, 'asking Qwen 3.8'],
    [{ kind: 'retrying', model: 'Qwen 3.8', attempt: 2 }, 'Qwen 3.8 is busy, trying again (2)'],
    [
      { kind: 'backup', model: 'Nemotron', behind: 'Qwen 3.8', why: 'busy' },
      'Qwen 3.8 is busy — asking Nemotron as backup',
    ],
    [
      { kind: 'backup', model: 'Nemotron', behind: 'Qwen 3.8', why: 'slow' },
      'Qwen 3.8 is slow to start — asking Nemotron too',
    ],
    [{ kind: 'thinking', model: 'Qwen 3.8' }, 'Qwen 3.8 is thinking'],
    [{ kind: 'writing', model: 'Qwen 3.8' }, 'Qwen 3.8 is writing'],
    [{ kind: 'tool', name: 'files__search' }, 'using search'],
  ]
  for (const [phase, said] of cases) expect(detail(phase)).toBe(said)
})

test('a tool without a plugin keeps its whole name', () => {
  // Core's own tools have no `__`. Cutting at a separator that is not there would eat a letter.
  expect(detail({ kind: 'tool', name: 'skill' })).toBe('using skill')
})

// ---- the word -----------------------------------------------------------------------------

test('every stage has words, and none of them is blank or doubled', () => {
  const all = Object.values(WORDS).flat()
  for (const [kind, pool] of Object.entries(WORDS)) {
    expect(pool.length, kind).toBeGreaterThanOrEqual(6)
    for (const word of pool) expect(word, kind).toMatch(/^[A-Z][a-z]+$/)
  }
  expect(new Set(all).size, 'a word in two pools would make two stages look like one').toBe(all.length)
})

test('pick takes its word from the stage, and survives a random source that says 1', () => {
  expect(pick('retrying', () => 0)).toBe(WORDS.retrying[0])
  expect(pick('retrying', () => 0.999)).toBe(WORDS.retrying.at(-1))
  expect(pick('retrying', () => 1)).toBe(WORDS.retrying.at(-1))
})

test('the word changes only when the stage does', () => {
  // A random source that would give a different word every time, so a word that stays is the
  // rule working rather than luck.
  const random = sequence(0, 0.5, 0.99, 0.25)
  const asking = next(undefined, { kind: 'asking', model: 'Qwen 3.8' }, random)
  expect(asking.word).toBe(WORDS.asking[0])

  // Same stage, another model: the detail follows, the word holds still.
  const again = next(asking, { kind: 'asking', model: 'Nemotron' }, random)
  expect(again.word).toBe(asking.word)
  expect(again.detail).toBe('asking Nemotron')

  // A new stage: a new word, from its own pool.
  const retrying = next(again, { kind: 'retrying', model: 'Qwen 3.8', attempt: 2 }, random)
  expect(WORDS.retrying).toContain(retrying.word)
  const still = next(retrying, { kind: 'retrying', model: 'Qwen 3.8', attempt: 3 }, random)
  expect(still.word).toBe(retrying.word)
  expect(still.detail).toBe('Qwen 3.8 is busy, trying again (3)')
})

test('a frame is drawn only if it is a stage this page knows', () => {
  expect(isPhase({ kind: 'asking', model: 'Qwen 3.8' })).toBe(true)
  expect(isPhase({ kind: 'choosing' })).toBe(true)
  // A stage from a newer core, and things that are not a phase at all.
  expect(isPhase({ kind: 'daydreaming' })).toBe(false)
  expect(isPhase({ kind: 'toString' })).toBe(false)
  expect(isPhase(undefined)).toBe(false)
  expect(isPhase('asking')).toBe(false)
})

// ---- the clock ----------------------------------------------------------------------------

test('the counter reads as a person would say it', () => {
  expect(elapsed(0)).toBe('0s')
  expect(elapsed(999)).toBe('0s')
  expect(elapsed(3_000)).toBe('3s')
  expect(elapsed(59_999)).toBe('59s')
  expect(elapsed(60_000)).toBe('1m 00s')
  expect(elapsed(65_000)).toBe('1m 05s')
  expect(elapsed(754_000)).toBe('12m 34s')
  // A clock that went backwards is not negative time.
  expect(elapsed(-5_000)).toBe('0s')
})

// ---- on the page --------------------------------------------------------------------------

test('mounted: one line at the end of its host, announced politely, the counter hidden', () => {
  vi.useFakeTimers()
  const host = document.createElement('div')
  host.append(document.createTextNode('Her words so far.'))
  document.body.append(host)

  mountStatus(host, { random: () => 0 })
  const line = host.lastElementChild as HTMLElement
  expect(line.className).toBe('status-line')

  const region = line.querySelector('[role="status"]')!
  expect(region.getAttribute('aria-live')).toBe('polite')
  expect(region.textContent).toBe(`${GLYPH} ${WORDS.choosing[0]!}… · choosing a model`)
  // The mark and the dot are decoration; the word and the detail are what is read aloud.
  expect(region.querySelector('.status-glyph')!.getAttribute('aria-hidden')).toBe('true')
  expect(region.querySelector('.status-dot')!.getAttribute('aria-hidden')).toBe('true')

  const time = line.querySelector('.status-time')!
  expect(time.getAttribute('aria-hidden')).toBe('true')
  // Beside the live region, not in it: a region re-reads itself whole when anything inside
  // changes, and the counter changes every second.
  expect(region.contains(time)).toBe(false)
  expect(time.textContent).toBe('0s')
})

test('starts on the stage it is given — reading, when the message carries files', () => {
  const host = document.createElement('div')
  const status = mountStatus(host, { first: { kind: 'reading' }, random: () => 0 })
  expect(host.querySelector('.status-detail')!.textContent).toBe('reading your files')
  expect(host.querySelector('.status-word')!.textContent).toBe(`${WORDS.reading[0]!}…`)
  status.stop()
})

test('set: the detail follows every event, the word only the stage', () => {
  const host = document.createElement('div')
  const status = mountStatus(host, { random: sequence(0, 0.5, 0.99) })
  const word = (): string => host.querySelector('.status-word')!.textContent ?? ''
  const what = (): string => host.querySelector('.status-detail')!.textContent ?? ''

  status.set({ kind: 'asking', model: 'Qwen 3.8' })
  const asking = word()
  expect(WORDS.asking.map((one) => `${one}…`)).toContain(asking)
  expect(what()).toBe('asking Qwen 3.8')

  status.set({ kind: 'asking', model: 'Nemotron' })
  expect(word()).toBe(asking)
  expect(what()).toBe('asking Nemotron')

  status.set({ kind: 'writing', model: 'Nemotron' })
  expect(WORDS.writing.map((one) => `${one}…`)).toContain(word())
  expect(what()).toBe('Nemotron is writing')
  status.stop()
})

test('set puts the line back at the end, under anything added after it', () => {
  const host = document.createElement('div')
  const status = mountStatus(host)
  const file = document.createElement('div')
  host.append(file)
  expect(host.lastElementChild).toBe(file)
  status.set({ kind: 'choosing' })
  expect(host.lastElementChild!.className).toBe('status-line')
  status.stop()
})

test('the counter ticks once a second, and past a minute says minutes', () => {
  vi.useFakeTimers()
  const host = document.createElement('div')
  const status = mountStatus(host)
  const time = host.querySelector('.status-time')!

  vi.advanceTimersByTime(3_000)
  expect(time.textContent).toBe('3s')
  vi.advanceTimersByTime(62_000)
  expect(time.textContent).toBe('1m 05s')
  status.stop()
})

test('stop takes the line away and its clock with it; a late event does not bring it back', () => {
  vi.useFakeTimers()
  const host = document.createElement('div')
  const status = mountStatus(host)
  expect(vi.getTimerCount()).toBe(1)

  status.stop()
  expect(host.querySelector('.status-line')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)

  // Twice is safe, and a phase that arrives after the answer ended draws nothing.
  status.stop()
  status.set({ kind: 'asking', model: 'Qwen 3.8' })
  expect(host.querySelector('.status-line')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})
