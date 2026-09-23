// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { StatusMessage, statusOf } from '../status.js'

// The words under *typing…* (D198): one line per stage, plain, naming the model or the tool
// when core says which — and nothing at all for a frame that is not a stage, so an unknown
// one leaves the last line standing rather than blanking it.

test('each stage has its line, with the model or tool when core names one', () => {
  expect(statusOf({ phase: 'choosing' })).toBe('Choosing a model…')
  expect(statusOf({ phase: 'reading' })).toBe('Reading what you sent…')
  expect(statusOf({ phase: 'asking', model: 'small-v1' })).toBe('Asking small-v1…')
  expect(statusOf({ phase: 'retrying', model: 'small-v1' })).toBe('small-v1 is busy, trying again…')
  expect(statusOf({ phase: 'backup', model: 'big-v2' })).toBe('Also asking big-v2…')
  expect(statusOf({ phase: 'thinking', model: 'small-v1' })).toBe('Thinking (small-v1)…')
  expect(statusOf({ phase: 'writing', model: 'small-v1' })).toBe('Generating answer…')
  expect(statusOf({ phase: 'tool', tool: 'web_search' })).toBe('Using web_search…')
})

test('an older core, with no names on its stages, still gets words', () => {
  expect(statusOf({ phase: 'asking' })).toBe('Asking a model…')
  expect(statusOf({ phase: 'thinking' })).toBe('Thinking…')
  expect(statusOf({ phase: 'tool' })).toBe('Working…')
})

test('a frame that is not a stage, or a stage not heard of yet, says nothing', () => {
  expect(statusOf({ delta: 'hi' })).toBeUndefined()
  expect(statusOf({ phase: 'dreaming' })).toBeUndefined()
  expect(statusOf(undefined)).toBeUndefined()
})

/** A `StatusMessage` wired to a record of the calls it would make. */
function harness(fail) {
  const calls = []
  const logged = []
  const note = new StatusMessage({
    send: async (text) => {
      calls.push(['send', text])
      if (fail === 'send') throw new Error('no')
      return 7
    },
    edit: async (id, text) => {
      calls.push(['edit', id, text])
    },
    remove: async (id) => {
      calls.push(['remove', id])
    },
    log: (message) => logged.push(message),
  })
  return { note, calls, logged }
}

test('sent once, edited after, deleted at the end — and the same line is no call', async () => {
  const { note, calls } = harness()
  void note.set('Thinking…')
  void note.set('Thinking…')
  await note.set('Asking small-v1…')
  // A line still waiting when the answer lands is never sent: it would be deleted at once.
  void note.set('Generating answer…')
  await note.clear()
  await note.set('too late')
  expect(calls).toEqual([
    ['send', 'Thinking…'],
    ['edit', 7, 'Asking small-v1…'],
    ['remove', 7],
  ])
})

test('nothing was said, so nothing is deleted', async () => {
  const { note, calls } = harness()
  await note.clear()
  expect(calls).toEqual([])
})

test('a failure is logged once and never thrown', async () => {
  const { note, logged } = harness('send')
  await note.set('Thinking…')
  await note.set('Asking…')
  await note.clear()
  expect(logged).toHaveLength(1)
})
