// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { EVERY, Presence } from '../presence.js'

/**
 * *Typing…*, kept up for as long as an answer takes (D192).
 *
 * Telegram shows a chat action for five seconds at most, so the whole of this is a heartbeat
 * and the thing worth holding still is its rhythm: sent at once, sent again every four
 * seconds, and never a gap long enough for the phone to go quiet while somebody is still
 * waiting. The rest is the edges — a switch, a pause under a question, a stop that can be
 * called twice — and the one promise a cosmetic thing has to keep: it never costs an answer.
 */

let sent
const record = (chatId, action) => {
  sent.push({ chatId, action, at: Date.now() })
  return Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
})

afterEach(() => {
  vi.useRealTimers()
})

test('it is sent at once, then every four seconds, and the phone is never left without it', () => {
  const presence = new Presence(record)
  presence.start(7)
  expect(sent).toEqual([{ chatId: 7, action: 'typing', at: Date.now() }])

  vi.advanceTimersByTime(60_000)
  expect(sent).toHaveLength(1 + 60_000 / EVERY)
  // Telegram's own limit is five seconds. A gap as long as that is a blink the person sees.
  for (let at = 1; at < sent.length; at++) expect(sent[at].at - sent[at - 1].at).toBeLessThan(5000)
  expect(sent.every((one) => one.action === 'typing')).toBe(true)
  presence.stopAll()
})

test('a switch is said at once and on every tick after', () => {
  const presence = new Presence(record)
  presence.start(7)
  vi.advanceTimersByTime(1000)
  presence.as(7, 'upload_photo')
  expect(sent.at(-1).action).toBe('upload_photo')
  expect(sent).toHaveLength(2)

  vi.advanceTimersByTime(EVERY * 3)
  expect(sent.slice(1).map((one) => one.action)).toEqual(Array(4).fill('upload_photo'))
  // And the switch restarted the beat, so no tick was about to fire right behind it.
  for (let at = 1; at < sent.length; at++) expect(sent[at].at - sent[at - 1].at).toBeLessThan(5000)
  presence.stopAll()
})

test('a chat nobody started is left alone, and starting one twice is still one heartbeat', () => {
  const presence = new Presence(record)
  // A file sent outside an answer: nothing to keep alive, and no timer nobody would stop.
  presence.as(7, 'upload_document')
  presence.pause(7)
  presence.resume(7)
  vi.advanceTimersByTime(EVERY * 3)
  expect(sent).toEqual([])

  presence.start(7)
  presence.start(7, 'record_voice')
  expect(sent).toHaveLength(1)
  vi.advanceTimersByTime(EVERY)
  expect(sent.map((one) => one.action)).toEqual(['typing', 'record_voice'])
  presence.stopAll()
})

test('under a question it says nothing, and it comes back the moment the question settles', () => {
  const presence = new Presence(record)
  presence.start(7)
  presence.pause(7)
  vi.advanceTimersByTime(EVERY * 10)
  expect(sent).toHaveLength(1)

  // What the answer is doing can still change while the question is open; it just is not said.
  presence.as(7, 'upload_voice')
  expect(sent).toHaveLength(1)

  presence.resume(7)
  expect(sent).toHaveLength(2)
  expect(sent[1].action).toBe('upload_voice')
  vi.advanceTimersByTime(EVERY)
  expect(sent).toHaveLength(3)
  presence.stopAll()
})

test('two questions open at once need two answers before it comes back', () => {
  const presence = new Presence(record)
  presence.start(7)
  presence.pause(7)
  presence.pause(7)
  presence.resume(7)
  vi.advanceTimersByTime(EVERY * 3)
  expect(sent).toHaveLength(1)
  presence.resume(7)
  expect(sent).toHaveLength(2)
  // A resume with nothing paused does not send a second beat on top of the first.
  presence.resume(7)
  expect(sent).toHaveLength(2)
  presence.stopAll()
})

test('a stop is a stop, and a second one is harmless', () => {
  const presence = new Presence(record)
  presence.start(7)
  presence.stop(7)
  presence.stop(7)
  presence.stop(99)
  vi.advanceTimersByTime(EVERY * 5)
  expect(sent).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})

test('chats keep their own beat, and stopping one leaves the other', () => {
  const presence = new Presence(record)
  presence.start(1)
  vi.advanceTimersByTime(1000)
  presence.start(2, 'upload_document')
  presence.pause(1)
  vi.advanceTimersByTime(EVERY)
  expect(sent.filter((one) => one.chatId === 1)).toHaveLength(1)
  expect(sent.filter((one) => one.chatId === 2).map((one) => one.action)).toEqual(['upload_document', 'upload_document'])

  presence.resume(1)
  presence.stop(2)
  vi.advanceTimersByTime(EVERY)
  expect(sent.filter((one) => one.chatId === 1)).toHaveLength(3)
  expect(sent.filter((one) => one.chatId === 2)).toHaveLength(2)

  // A number from a message and a string from storage are the same chat.
  presence.pause('1')
  vi.advanceTimersByTime(EVERY * 2)
  expect(sent.filter((one) => one.chatId === 1)).toHaveLength(3)

  presence.stopAll()
  expect(vi.getTimerCount()).toBe(0)
})

test('a send that throws or rejects never reaches the answer, and is logged once', async () => {
  const warned = []
  let calls = 0
  const broken = () => {
    calls++
    if (calls % 2 === 0) throw new Error('thrown')
    return Promise.reject(new Error('rejected'))
  }
  const presence = new Presence(broken, EVERY, (error) => warned.push(error.message))

  expect(() => {
    presence.start(7)
    presence.as(7, 'upload_photo')
    presence.pause(7)
    presence.resume(7)
    vi.advanceTimersByTime(EVERY * 5)
  }).not.toThrow()
  // Let the rejections land, so an unhandled one would fail the run here rather than later.
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toBeGreaterThan(5)
  expect(warned).toHaveLength(1)

  // A log that throws is cosmetic too.
  const loud = new Presence(broken, EVERY, () => {
    throw new Error('the log is broken as well')
  })
  expect(() => loud.start(8)).not.toThrow()
  await vi.advanceTimersByTimeAsync(0)
  presence.stopAll()
  loud.stopAll()
})
