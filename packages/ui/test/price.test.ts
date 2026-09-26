// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { priceText } from '../src/pages.js'

/**
 * The Price page's words, without a page. The figure, the word over it and the lines under it
 * come from one function, because the word used to be fixed at *this month* over today's
 * figure, and after an answer the month's total was glued onto *of $1.00 today*.
 */

test('with a daily allowance, the figure is the day, and the label says so', () => {
  const said = priceText({ spent: 7.5, cap: 20, today: { spent: 0.25, allowance: 1 } })
  expect(said.label).toBe('today')
  expect(said.figure).toBe('$0.25 of $1.00')
  expect(said.bar).toBe(25)
  expect(said.against).toBe('of $1.00 allowed today')
  expect(said.both).toBe('This month $7.50 of $20.00 · today $0.25 of $1.00')
  // The month's total is never the number over the word *today*.
  expect(said.figure).not.toContain('7.50')
})

test('without one, the figure is the month, and the label says that instead', () => {
  const capped = priceText({ spent: 7.5, cap: 20, today: { spent: 0.25, allowance: 0 } })
  expect(capped.label).toBe('this month')
  expect(capped.figure).toBe('$7.50 of $20.00')
  expect(capped.bar).toBe(38)
  expect(capped.against).toBe('of $20.00 this month')

  const open = priceText({ spent: 3 })
  expect(open.label).toBe('this month')
  expect(open.figure).toBe('$3.00')
  expect(open.bar).toBe(0)
  expect(open.against).toBe('No monthly cap set.')
  expect(open.title).toBe('No daily allowance, so nothing is spent without you asking for it.')
})

test('a day spent past its allowance fills the bar and no further', () => {
  expect(priceText({ spent: 5, today: { spent: 1.4, allowance: 1 } }).bar).toBe(100)
})
