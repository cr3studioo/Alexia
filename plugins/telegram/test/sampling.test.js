// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { ANSWER_WAIT, frameOf, sampling, STREAM, wasStopped } from '../sampling.js'

/**
 * The three per-call details that have to be identical on every call into core (D195).
 *
 * This module exists because they were written inline and one call site was missing them: a
 * command carried the SDK's sixty-second default, so a plugin command that had to ask a person
 * for permission was cancelled while they were still reading the question. Nothing about that
 * failure points at the missing argument, which is exactly why it is a test now.
 */

test('the option bag is the one both call sites need', () => {
  const controller = new AbortController()
  const bag = sampling(controller.signal)
  expect(bag.signal).toBe(controller.signal)
  expect(bag.timeout).toBe(ANSWER_WAIT)
  expect(bag.resetTimeoutOnProgress).toBe(true)
  // Not the SDK's minute, which a question waiting on a person outlasts.
  expect(bag.timeout).toBeGreaterThan(60_000)
})

test('progress is always asked for, because asking is what creates the channel', () => {
  // MCP puts a progressToken on a request only when `onprogress` is a function, and core
  // sends stream frames on that token and nowhere else.
  expect(typeof sampling(new AbortController().signal).onprogress).toBe('function')
  expect(() => sampling(new AbortController().signal).onprogress({ progress: 1 })).not.toThrow()
})

test('a handler that was passed is the one that gets the frames', () => {
  const seen = []
  const bag = sampling(new AbortController().signal, (params) => seen.push(params))
  bag.onprogress({ progress: 1 })
  expect(seen).toEqual([{ progress: 1 }])
})

test('frameOf finds the frame core sent', () => {
  expect(frameOf({ progress: 1, _meta: { [STREAM]: { delta: 'hi' } } })).toEqual({ delta: 'hi' })
  expect(frameOf({ progress: 2, _meta: { [STREAM]: { restart: true } } })).toEqual({ restart: true })
  expect(frameOf({ progress: 3, _meta: { [STREAM]: { phase: 'tool' } } })).toEqual({ phase: 'tool' })
})

test('progress with nothing on it reads as nothing to draw, not as a fault', () => {
  // An Alexia older than D193 reports progress and sends no `_meta` at all.
  expect(frameOf({ progress: 1 })).toBeUndefined()
  expect(frameOf({ progress: 1, _meta: {} })).toBeUndefined()
  expect(frameOf({ progress: 1, _meta: { 'alexia/other': { delta: 'x' } } })).toBeUndefined()
  expect(frameOf({ progress: 1, _meta: { [STREAM]: null } })).toBeUndefined()
  expect(frameOf(undefined)).toBeUndefined()
})

test('an aborted signal is a stop, whatever the error looks like', () => {
  const controller = new AbortController()
  controller.abort()
  expect(wasStopped(controller.signal, new Error('something else entirely'))).toBe(true)
})

test('an abort is a stop when it arrives under its own name', () => {
  const error = new Error('This operation was aborted')
  error.name = 'AbortError'
  expect(wasStopped(new AbortController().signal, error)).toBe(true)
})

test('what MCP wraps a cancelled request in is a stop too', () => {
  // The SDK turns the signal's reason into one of its own errors on the way back, so the
  // name is gone by the time this sees it and the sentence is all that is left.
  const live = new AbortController().signal
  expect(wasStopped(live, new Error('AbortError: This operation was aborted'))).toBe(true)
  expect(wasStopped(live, new Error('The request was cancelled'))).toBe(true)
  expect(wasStopped(live, new Error('MCP error -32800: Request canceled'))).toBe(true)
})

test('an ordinary failure is not a stop, and is still worth saying out loud', () => {
  const live = new AbortController().signal
  expect(wasStopped(live, new Error('Request timed out'))).toBe(false)
  expect(wasStopped(live, new Error('no model is configured'))).toBe(false)
  expect(wasStopped(live, undefined)).toBe(false)
})
