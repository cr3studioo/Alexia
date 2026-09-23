// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Draft, draftId, FLUSH_MS, KEEP_MS } from '../draft.js'
import { forRich } from '../format.js'

/**
 * A draft is ephemeral (30 s) and a model is fast, so this class exists to throttle and to
 * keep the draft alive — and to give up gracefully, once, if Telegram stops accepting them.
 * Every one of those is a timing behaviour, which is why every test here runs on fake time
 * and records exactly what would have gone out over the wire.
 */

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** A `Draft` wired to recording fakes, so a test can assert on exactly what was sent. */
function harness(overrides = {}) {
  const plainCalls = []
  const richCalls = []
  const session = overrides.session ?? { off: false }
  const plainBehavior = overrides.plain
  const richBehavior = overrides.rich
  const plain = (id, text) => {
    plainCalls.push([id, text])
    return plainBehavior ? plainBehavior(id, text) : Promise.resolve()
  }
  const rich = (id, markdown) => {
    richCalls.push([id, markdown])
    return richBehavior ? richBehavior(id, markdown) : Promise.resolve()
  }
  const draft = new Draft({
    plain,
    rich,
    session,
    flushMs: overrides.flushMs ?? FLUSH_MS,
    keepMs: overrides.keepMs ?? KEEP_MS,
    log: overrides.log,
  })
  return { draft, plainCalls, richCalls, session }
}

test('draftId is a non-zero 31-bit integer', () => {
  for (let i = 0; i < 50; i++) {
    const id = draftId()
    expect(Number.isInteger(id)).toBe(true)
    expect(id).toBeGreaterThanOrEqual(1)
    expect(id).toBeLessThanOrEqual(2 ** 31 - 1)
  }
})

test('open sends an empty plain draft — Thinking…', () => {
  const { draft, plainCalls, richCalls } = harness()
  draft.open()
  expect(plainCalls).toEqual([[draft.id, '']])
  expect(richCalls).toEqual([])
})

test('open does nothing when the session is already off', async () => {
  const { draft, plainCalls, richCalls } = harness({ session: { off: true } })
  draft.open()
  await vi.advanceTimersByTimeAsync(KEEP_MS * 2)
  expect(plainCalls).toEqual([])
  expect(richCalls).toEqual([])
})

test('many adds inside one flush window produce a single send with the latest text', async () => {
  const { draft, richCalls } = harness({ flushMs: 1000, keepMs: 100_000 })
  draft.open()
  draft.add('a')
  draft.add('b')
  draft.add('c')
  await vi.advanceTimersByTimeAsync(1000)
  expect(richCalls).toEqual([[draft.id, forRich('abc')]])
})

test('a second burst after a flush produces its own, separate send', async () => {
  const { draft, richCalls } = harness({ flushMs: 1000, keepMs: 100_000 })
  draft.open()
  draft.add('a')
  await vi.advanceTimersByTimeAsync(1000)
  draft.add('b')
  await vi.advanceTimersByTimeAsync(1000)
  expect(richCalls).toEqual([
    [draft.id, forRich('a')],
    [draft.id, forRich('ab')],
  ])
})

test('the keep-alive re-sends the current state every keepMs', async () => {
  const { draft, richCalls, plainCalls } = harness({ flushMs: 1000, keepMs: 5000 })
  draft.open()
  draft.add('hello')
  await vi.advanceTimersByTimeAsync(1000) // the throttled flush
  expect(richCalls).toEqual([[draft.id, forRich('hello')]])
  await vi.advanceTimersByTimeAsync(4000) // reaches the 5 s keep-alive mark
  expect(richCalls).toEqual([
    [draft.id, forRich('hello')],
    [draft.id, forRich('hello')],
  ])
  expect(plainCalls).toEqual([[draft.id, '']]) // still just the original Thinking…
})

test('the keep-alive sends plain empty while there is still no text', async () => {
  const { draft, plainCalls } = harness({ flushMs: 1000, keepMs: 5000 })
  draft.open()
  await vi.advanceTimersByTimeAsync(5000)
  expect(plainCalls).toEqual([
    [draft.id, ''],
    [draft.id, ''],
  ])
})

test('restart clears the text and sends an empty draft again', async () => {
  const { draft, plainCalls } = harness({ flushMs: 1000, keepMs: 100_000 })
  draft.open()
  draft.add('partial answer')
  await vi.advanceTimersByTimeAsync(1000)
  expect(draft.text).toBe('partial answer')

  draft.restart()
  expect(draft.text).toBe('')
  await vi.advanceTimersByTimeAsync(0)
  expect(plainCalls.at(-1)).toEqual([draft.id, ''])
})

test('pause suppresses every send, and resume re-sends the current state immediately', async () => {
  const { draft, richCalls } = harness({ flushMs: 1000, keepMs: 100_000 })
  draft.open()
  draft.pause()
  draft.add('hello')
  await vi.advanceTimersByTimeAsync(1000) // the flush fires, but paused swallows it
  expect(richCalls).toEqual([])

  draft.resume()
  await vi.advanceTimersByTimeAsync(0)
  expect(richCalls).toEqual([[draft.id, forRich('hello')]])
})

test('a rich failure falls back to plain, and is remembered for the rest of this draft', async () => {
  const { draft, plainCalls, richCalls, session } = harness({
    flushMs: 1000,
    keepMs: 100_000,
    rich: () => Promise.reject(new Error('rich is down')),
  })
  draft.open()
  draft.add('hello')
  await vi.advanceTimersByTimeAsync(1000)
  expect(richCalls).toHaveLength(1)
  expect(plainCalls.at(-1)).toEqual([draft.id, 'hello'])
  expect(session.off).toBe(false)

  draft.add(' world')
  await vi.advanceTimersByTimeAsync(1000)
  // Rich is not tried again this draft — straight to plain.
  expect(richCalls).toHaveLength(1)
  expect(plainCalls.at(-1)).toEqual([draft.id, 'hello world'])
})

test('plain truncates to 4096 characters when it is the one sending the text', async () => {
  const long = 'x'.repeat(5000)
  const { draft, plainCalls } = harness({
    flushMs: 1000,
    keepMs: 100_000,
    rich: () => Promise.reject(new Error('rich is down')),
  })
  draft.open()
  draft.add(long)
  await vi.advanceTimersByTimeAsync(1000)
  expect(plainCalls.at(-1)[1]).toHaveLength(4096)
})

test('both methods failing turns drafts off for the session, stops timers, and logs once', async () => {
  const log = vi.fn()
  const session = { off: false }
  const { draft } = harness({
    flushMs: 1000,
    keepMs: 5000,
    rich: () => Promise.reject(new Error('rich is down')),
    plain: () => Promise.reject(new Error('plain is down too')),
    session,
    log,
  })
  draft.open()
  await vi.advanceTimersByTimeAsync(0)
  expect(session.off).toBe(true)
  expect(log).toHaveBeenCalledTimes(1)

  // The keep-alive that open() started must have been stopped as part of the failure.
  await vi.advanceTimersByTimeAsync(20_000)
  expect(log).toHaveBeenCalledTimes(1)
})

test('close stops every timer, and nothing is sent after it', async () => {
  const { draft, plainCalls, richCalls } = harness({ flushMs: 1000, keepMs: 2000 })
  draft.open()
  draft.add('hello')
  draft.close()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(plainCalls).toEqual([[draft.id, '']]) // only the original open()
  expect(richCalls).toEqual([])
})

test('close is idempotent', () => {
  const { draft } = harness()
  draft.open()
  draft.close()
  expect(() => draft.close()).not.toThrow()
})

test('a send never throws or rejects to the caller, even when both methods fail', async () => {
  const { draft } = harness({
    rich: () => Promise.reject(new Error('rich is down')),
    plain: () => Promise.reject(new Error('plain is down too')),
    flushMs: 1000,
  })
  expect(() => draft.open()).not.toThrow()
  expect(() => draft.add('hello')).not.toThrow()
  await vi.advanceTimersByTimeAsync(1000)
})

test('a status line is the whole draft before the first word, and sent at once', () => {
  const { draft, plainCalls, richCalls } = harness()
  draft.status('Thinking…')
  // Nothing before `open()` — the status is what the first draft says, not a draft of its own.
  expect(plainCalls).toEqual([])
  draft.open()
  draft.status('Asking small_v1…')
  expect(plainCalls).toEqual([
    [draft.id, 'Thinking…'],
    [draft.id, 'Asking small_v1…'],
  ])
  expect(richCalls).toEqual([])
  draft.close()
})

test('a status line sits under the words so far, escaped, and comes off with an empty string', () => {
  const { draft, richCalls } = harness()
  draft.open()
  draft.add('Found *it*.')
  vi.advanceTimersByTime(FLUSH_MS)
  draft.status('Using web_search…')
  draft.status('')
  expect(richCalls).toEqual([
    [draft.id, forRich('Found *it*.')],
    [draft.id, `${forRich('Found *it*.')}\n\nUsing web\\_search…`],
    [draft.id, forRich('Found *it*.')],
  ])
  draft.close()
})

test('the same status twice is one send', () => {
  const { draft, plainCalls } = harness()
  draft.open()
  draft.status('Thinking…')
  draft.status('Thinking…')
  expect(plainCalls).toEqual([
    [draft.id, ''],
    [draft.id, 'Thinking…'],
  ])
  draft.close()
})
