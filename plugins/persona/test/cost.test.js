// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { BUDGET, CHARS_PER_TOKEN, budgetLine, costLine, costOf, STEPS, tokensIn } from '../cost.js'
import { LONGEST } from '../writing.js'

/**
 * What a personality costs (plan-personality.md step 4c, improvement 7).
 *
 * Scoped to one document on purpose: §2's small/medium/high do not exist yet, so a test that
 * asserted three sizes would be asserting something nothing writes. What is pinned here is
 * the arithmetic and the hedging — the two things item 15 must not quietly change when it
 * calls `costOf` three times instead of once.
 */

test('the estimate is characters ÷ 4, and a step is the unit because it is sent every step', () => {
  expect(CHARS_PER_TOKEN).toBe(4)
  expect(tokensIn('a'.repeat(400))).toBe(100)
  expect(tokensIn('')).toBe(0)
  const { perStep, perTask } = costOf('a'.repeat(400))
  expect(perStep).toBe(100)
  // A personality is not paid for once — it goes into the system prompt on every step.
  expect(perTask).toBe(100 * STEPS)
})

test('the number is always labelled an estimate, because one presented as a fact is a lie', () => {
  const line = costLine('a'.repeat(400))
  expect(line).toMatch(/Roughly|about/)
  expect(line).toContain('An estimate')
  expect(line).toContain(`÷ ${CHARS_PER_TOKEN}`)
  expect(line).toContain(`${STEPS}-step task`)
})

test('a personality that obeys its own brief is under budget; one that overran is not', () => {
  // brief() asks for under 400 words ≈ 2,600 characters. That is the case the budget is
  // drawn around, so it must not fire on a document that did as it was told.
  const obedient = 'a'.repeat(2600)
  expect(costOf(obedient).over).toBe(false)
  expect(budgetLine(obedient)).toBe('')

  // And the longest document `usable()` will accept must trip it, or the line never fires.
  const longest = 'a'.repeat(LONGEST)
  expect(costOf(longest).over).toBe(true)
  const warned = budgetLine(longest)
  expect(warned).toContain('every step')
  expect(warned).toMatch(/400 words/)
  expect(warned).toMatch(/Re-adapt/)
})

test('the budget sits between the two, which is what makes it a threshold and not a rounding', () => {
  expect(BUDGET).toBeGreaterThan(costOf('a'.repeat(2600)).perTask)
  expect(BUDGET).toBeLessThan(costOf('a'.repeat(LONGEST)).perTask)
})

test('an empty document costs nothing and warns about nothing', () => {
  expect(costOf('').perTask).toBe(0)
  expect(budgetLine('')).toBe('')
  expect(budgetLine(undefined)).toBe('')
})

/**
 * The two assumptions this file makes about things outside it, checked rather than trusted.
 *
 * `BUDGET` is not a round number somebody liked — it is derived from the word limit `brief()`
 * asks for, so the line fires exactly when a document overran what it was told. That makes it
 * a cross-file assumption, and the sort that rots silently when the brief is reworded.
 */
test('the budget is still derived from the word limit the brief actually asks for', () => {
  const written = readFileSync(new URL('../writing.js', import.meta.url), 'utf8')
  const asked = /under (\d+) words/.exec(written)
  expect(asked, 'brief() no longer states a word limit — BUDGET has nothing to stand on').not.toBeNull()
  const words = Number(asked[1])
  // ~6.5 characters a word including spaces, then characters ÷ 4, then a 15-step task.
  const expected = Math.round((words * 6.5) / CHARS_PER_TOKEN) * STEPS
  // Within a fifth: this is a threshold, not a measurement, and it should track the brief
  // rather than match an arithmetic identity.
  expect(Math.abs(BUDGET - expected) / BUDGET).toBeLessThan(0.2)
})

test('every button that saves a document says what it costs, not just the first one', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  // One reply() carries the cost, and every button that saves a document goes through it.
  // Four of them now: Adapt, Re-adapt, Refine and Edit. The count is the assertion — a fifth
  // way to save that did not reach reply() would be a document whose cost is never said.
  expect(source).toMatch(/costLine\(doc\), budgetLine\(doc\), doc/)
  expect(source.match(/reply\(/g)).toHaveLength(4)
  expect(source).toMatch(/reply\(headline, written\.removed, written\.doc\)/)
  expect(source).toMatch(/reply\(\s*`Wrote /)
  expect(source).toMatch(/reply\(\s*`Changed /)
  expect(source).toMatch(/reply\(\s*`Saved your own /)
  // And the row itself says so later, which is when somebody actually wonders.
  expect(source).toMatch(/costLine\(String\(row\.doc\)\)/)
})
