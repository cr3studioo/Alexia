// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { MARKERS, MAX, prompt, sanitize, strip } from '../expression.js'

/**
 * Expression (M7-4), and the one thing it exists to stop.
 *
 * An unrecognised tag is not dropped by the engine — it is **spoken**. So a model inventing
 * `[sultry]` ships a literal bracket into somebody's ears, and instructing it not to is not
 * enough: the output is filtered against the vendor's own published list afterwards.
 */

test('an invented marker never reaches the audio', () => {
  const said = sanitize('[sultry]Here it is. [happy]All done.', 'Here it is. All done.')
  expect(said).toBe('Here it is. [happy]All done.')
  expect(said).not.toContain('sultry')

  // The vocabulary is quoted, not invented, so a spot check is a spot check of the quote.
  expect(MARKERS.has('happy')).toBe(true)
  expect(MARKERS.has('long-break')).toBe(true)
  expect(MARKERS.has('in a hurry tone')).toBe(true)
  expect(MARKERS.has('sultry')).toBe(false)
})

test('a model that decorates every clause is trimmed to the ceiling', () => {
  const over = Array.from({ length: MAX + 3 }, (_, i) => `[happy]word${String(i)}`).join(' ')
  const plain = Array.from({ length: MAX + 3 }, (_, i) => `word${String(i)}`).join(' ')
  expect([...sanitize(over, plain).matchAll(/\[happy\]/g)]).toHaveLength(MAX)
})

test('an annotator that rewrote the words is discarded entirely', () => {
  // The worst failure of the three, because nobody can see it: a voice saying something
  // slightly different from the answer on the screen. Its job is to mark up, never to edit.
  const original = 'The grant is due in March.'
  expect(sanitize('[happy]The grant is due in April.', original)).toBe(original)
  expect(sanitize('[happy]The grant is due in March.', original)).toBe('[happy]The grant is due in March.')

  // Whitespace around an inserted marker may legitimately move, so the comparison is on
  // letters and digits. Otherwise every real annotation would be thrown away.
  expect(sanitize('[happy] The grant is due in March.', original)).toBe('[happy] The grant is due in March.')
})

test('the plain words are always recoverable, and the prompt carries the list', () => {
  expect(strip('[happy]Hello there. [sighing] Again.')).toBe('Hello there. Again.')
  expect(sanitize('', 'nothing was annotated')).toBe('nothing was annotated')

  const asked = prompt('Hello there.')
  expect(asked).toContain('Hello there.')
  expect(asked).toContain('[happy]')
  // The markers are in the instruction rather than described, because a model asked to use
  // "emotion words" invents them and the filter then eats every one.
  expect(asked).toContain('curious')
})
