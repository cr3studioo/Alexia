// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { brief, clean, LONGEST, nameFrom, SHAPE, unique, usable } from '../writing.js'

/**
 * Adapting (M4-4), minus the model.
 *
 * Everything here is a shape the model's answer can arrive in, and the reason each check
 * exists is that the answer is the *only* thing between rough notes and a document that
 * goes into the system prompt. What a model returns is not a promise.
 */

test('the brief carries the description and forbids inventing around it', () => {
  const said = brief('blunt, calls me Vacen, no emojis')
  expect(said).toContain('blunt, calls me Vacen, no emojis')
  expect(said).toContain(SHAPE)
  expect(said).toMatch(/Invent nothing/)
  // A personality goes into the system prompt now, so the one thing it must never be
  // allowed to write is a rule that turns the gate off.
  expect(said).toMatch(/skip asking permission/)
})

test('code fences come off, because a model told not to use them still does', () => {
  expect(clean('```markdown\n# Chief of staff\n\nBe blunt.\n```')).toBe('# Chief of staff\n\nBe blunt.')
  expect(clean('```\n# Chief of staff\n```')).toBe('# Chief of staff')
  expect(clean('  # Chief of staff  ')).toBe('# Chief of staff')
  expect(clean(undefined)).toBe('')
})

test('a model talking about the document is not the document', () => {
  expect(usable(SHAPE)).toBe(true)
  // No heading: a chatty paragraph, which is what a small model returns when it decides to
  // be helpful instead of doing as it was told.
  expect(usable('Sure! Here is a personality for Alexia that is blunt and to the point.')).toBe(false)
  expect(usable('# Hi')).toBe(false)
  expect(usable(`# Long\n${'word '.repeat(LONGEST)}`)).toBe(false)
})

test('an untyped name comes from the user’s own words, never the model’s', () => {
  expect(nameFrom('Chief of staff', 'blunt, no emojis')).toBe('Chief of staff')
  expect(nameFrom('   ', 'blunt, calls me Vacen, chases my dates')).toBe('Blunt calls me Vacen')
  expect(nameFrom('', '# **heading noise**')).toBe('Heading noise')
  expect(nameFrom('', '   ')).toBe('Personality')
  expect(nameFrom('x'.repeat(80), 'anything')).toHaveLength(40)
})

test('two rows never share a name, which is what makes a list readable a week later', () => {
  expect(unique('Chief of staff', [])).toBe('Chief of staff')
  expect(unique('Chief of staff', ['Chief of staff'])).toBe('Chief of staff 2')
  expect(unique('Chief of staff', ['Chief of staff', 'Chief of staff 2'])).toBe('Chief of staff 3')
})
