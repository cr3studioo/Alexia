// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { chunk, LIMIT } from '../api.js'

// The one piece of real logic in this plugin that is not a network call: Telegram refuses
// a message over 4096 characters, and a long answer arriving as an API error the user
// never sees is the failure that actually happens.

test('short messages are one message', () => {
  expect(chunk('hello')).toEqual(['hello'])
})

test('a long answer is split, and nothing is lost', () => {
  const text = `${'a'.repeat(5000)}\n${'b'.repeat(3000)}`
  const parts = chunk(text)
  expect(parts.length).toBeGreaterThan(1)
  for (const part of parts) expect(part.length).toBeLessThanOrEqual(LIMIT)
  expect(parts.join('')).toBe(text)
})

test('it breaks on a line when there is one within reach', () => {
  // A cut in the middle of a word reads as a bug. One at the end of a line does not.
  const text = `${'a'.repeat(3000)}\n${'b'.repeat(3000)}`
  const parts = chunk(text)
  expect(parts[0]).toBe('a'.repeat(3000))
  expect(parts[1]).toBe(`\n${'b'.repeat(3000)}`)
})

test('a message of exactly the limit is not split', () => {
  expect(chunk('c'.repeat(LIMIT))).toHaveLength(1)
})
