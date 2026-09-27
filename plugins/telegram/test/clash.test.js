// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TelegramError } from '../api.js'
import { CLASH_WAIT, clashed, Pause, PAUSED } from '../clash.js'

/**
 * Two Alexias on one bot. Telegram tells the older poll `409 Conflict`, and the copy that hears
 * it has to stand aside for minutes rather than retry in a second — which is what made the two
 * fight forever while both screens said *Listening*.
 */

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

test('a 409 is another copy polling, unless it is about a webhook', () => {
  expect(clashed(new TelegramError(409, 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'))).toBe(true)
  // Somebody's own setup, not a second Alexia: it keeps the ordinary retry and its own words.
  expect(clashed(new TelegramError(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first"))).toBe(false)
  expect(clashed(new TelegramError(401, 'Unauthorized'))).toBe(false)
  expect(clashed(new TelegramError(502, 'Bad Gateway'))).toBe(false)
  expect(clashed(new Error('fetch failed'))).toBe(false)
  expect(clashed(undefined)).toBe(false)
})

test('the paused line is a plain sentence, marked as something to look at', () => {
  expect(PAUSED.startsWith('▲ ')).toBe(true)
  expect(PAUSED).toContain('another copy of Alexia is using this bot')
  // Minutes, not seconds: a retry every second is the fight this exists to end.
  expect(CLASH_WAIT).toBeGreaterThanOrEqual(60_000)
})

test('a pause lasts its whole wait, and then it is over', async () => {
  const pause = new Pause()
  let over = false
  void pause.wait(CLASH_WAIT).then(() => (over = true))
  expect(pause.waiting).toBe(true)

  await vi.advanceTimersByTimeAsync(CLASH_WAIT - 1)
  expect(over).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(over).toBe(true)
  expect(pause.waiting).toBe(false)
})

test('Try again ends the wait at once, and says whether there was one', async () => {
  const pause = new Pause()
  expect(pause.wake()).toBe(false)
  let over = false
  void pause.wait(CLASH_WAIT).then(() => (over = true))
  expect(pause.wake()).toBe(true)
  await Promise.resolve()
  expect(over).toBe(true)
  expect(pause.waiting).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

test('a stopped loop is not left waiting out the pause', async () => {
  const pause = new Pause()
  const stopping = new AbortController()
  let over = false
  void pause.wait(CLASH_WAIT, stopping.signal).then(() => (over = true))
  stopping.abort()
  await Promise.resolve()
  expect(over).toBe(true)
  expect(pause.waiting).toBe(false)
  expect(vi.getTimerCount()).toBe(0)

  // And one that was already stopped does not start a wait at all.
  await pause.wait(CLASH_WAIT, stopping.signal)
  expect(pause.waiting).toBe(false)
})
