// SPDX-License-Identifier: AGPL-3.0-only
import type { StreamFrame } from '@alexia/protocol'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ALIVE_EVERY, STREAM_EVERY, streamer } from '../src/streaming.js'

/**
 * **The gathering** behind `alexia/stream`, on a fake clock.
 *
 * A provider streams a few characters at a time, and a frame per token is a pipe to another
 * process busy with framing. What is held still here is the order of things: the first words
 * at once, the rest at most every {@link STREAM_EVERY}, nothing overtaking words written
 * before it, and the tail dropped rather than raced against the result it would lose to. The
 * wire half — a real plugin, a real token — is `serve.stream.test.ts`.
 */

let sent: StreamFrame[] = []
beforeEach(() => {
  vi.useFakeTimers()
  sent = []
})
afterEach(() => vi.useRealTimers())

const words = (): string[] => sent.flatMap((frame) => (frame.delta === undefined ? [] : [frame.delta]))

test('the first words go at once, and the rest are gathered into one frame on the clock', () => {
  const live = streamer((frame) => sent.push(frame))
  live.delta('Hel')
  expect(sent).toEqual([{ delta: 'Hel' }])

  live.delta('lo, ')
  live.delta('there')
  expect(sent).toHaveLength(1)
  vi.advanceTimersByTime(STREAM_EVERY - 1)
  expect(sent).toHaveLength(1)
  vi.advanceTimersByTime(1)
  expect(sent).toEqual([{ delta: 'Hel' }, { delta: 'lo, there' }])

  // Quiet for longer than the clock, and the next words go at once again.
  vi.advanceTimersByTime(STREAM_EVERY * 3)
  live.delta('!')
  expect(words()).toEqual(['Hel', 'lo, there', '!'])
  live.end()
})

test('what is still held when the answer ends is dropped, not raced against it', () => {
  const live = streamer((frame) => sent.push(frame))
  live.delta('a')
  live.delta('b')
  live.end()
  /**
   * The held `b` never goes. A response is dispatched by the receiving SDK as it is read and a
   * notification a microtask later, so a frame written just before the result is handled after
   * it — against a request that has finished, which earns the plugin *a progress notification
   * for an unknown token* in its log instead of the word. The result carries `ab` regardless.
   */
  expect(words().join('')).toBe('a')
  // No clock left running, and nothing after the end: the request has been answered.
  expect(vi.getTimerCount()).toBe(0)
  live.delta('late')
  live.phase({ kind: 'writing', model: 'm' })
  live.restart()
  vi.advanceTimersByTime(ALIVE_EVERY * 2)
  live.alive()
  expect(words().join('')).toBe('a')
  expect(sent).toHaveLength(1)
})

test('a stage never overtakes the words written before it', () => {
  const live = streamer((frame) => sent.push(frame))
  live.delta('one ')
  live.delta('two')
  live.phase({ kind: 'tool', name: 'look' })
  expect(sent).toEqual([{ delta: 'one ' }, { delta: 'two' }, { phase: 'tool', tool: 'look' }])
  live.end()
})

test('a restart drops what it voids rather than sending it to be thrown away', () => {
  const live = streamer((frame) => sent.push(frame))
  live.delta('Half ')
  live.delta('of')
  live.restart()
  live.delta('Whole')
  // The clock, not `end()`: what is held at the end of an answer is dropped, so a test that
  // asked `end()` for it would be asking the one question the answer is allowed to refuse.
  vi.advanceTimersByTime(STREAM_EVERY)
  live.end()
  // `of` was held when the model failed: the plugin is never shown it at all.
  expect(sent).toEqual([{ delta: 'Half ' }, { restart: true }, { delta: 'Whole' }])
})

test('the words after a tool are set apart from the words before it', () => {
  const live = streamer((frame) => sent.push(frame))
  live.delta('Let me look.')
  live.phase({ kind: 'tool', name: 'look' })
  live.phase({ kind: 'asking', model: 'm' })
  live.delta('Found it.')
  vi.advanceTimersByTime(STREAM_EVERY)
  live.end()
  expect(words().join('')).toBe('Let me look.\n\nFound it.')

  // A tool with nothing said before it is not a break in anything.
  sent = []
  const fresh = streamer((frame) => sent.push(frame))
  fresh.phase({ kind: 'tool', name: 'look' })
  fresh.delta('Found it.')
  vi.advanceTimersByTime(STREAM_EVERY)
  fresh.end()
  expect(words()).toEqual(['Found it.'])
})

test('a busy tool keeps the line alive every few seconds, not every time it reports', () => {
  const live = streamer((frame) => sent.push(frame))
  live.phase({ kind: 'tool', name: 'render' })
  // The stage was just said, so a keep-alive before five seconds would say it again for nothing:
  // six seconds of a tool reporting ten times a second is one keep-alive.
  for (let i = 0; i < 60; i += 1) {
    live.alive()
    vi.advanceTimersByTime(100)
  }
  expect(sent).toEqual([{ phase: 'tool', tool: 'render' }, { phase: 'tool', tool: 'render' }])
  vi.advanceTimersByTime(ALIVE_EVERY)
  live.alive()
  live.alive()
  expect(sent).toHaveLength(3)
  live.end()
})

test('a stage about a model names it, so a phone can say which', () => {
  const live = streamer((frame) => sent.push(frame))
  live.phase({ kind: 'choosing' })
  live.phase({ kind: 'thinking', model: 'small-v1' })
  live.phase({ kind: 'backup', model: 'big-v2', behind: 'small-v1', why: 'slow' })
  expect(sent).toEqual([
    { phase: 'choosing' },
    { phase: 'thinking', model: 'small-v1' },
    { phase: 'backup', model: 'big-v2' },
  ])
  live.end()
})

test('a send that throws is contained — the answer is not the plugin’s pipe’s problem', () => {
  const live = streamer(() => {
    throw new Error('gone')
  })
  expect(() => {
    live.delta('a')
    live.delta('b')
    vi.advanceTimersByTime(STREAM_EVERY)
    live.phase({ kind: 'writing', model: 'm' })
    live.restart()
    live.end()
  }).not.toThrow()
})
