// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { day, line, mark, overdue } from '../ledger.js'

/**
 * The ledger's own rules, tested without a wire, a host or a process (M6-8).
 *
 * There are only three of them and each is a decision rather than a mechanism: a date is
 * understood or it is not, *overdue* is a fact about a day rather than a feeling, and whose
 * idea it was goes on the line.
 */

const TODAY = '2026-08-29'
const open = { text: 'Send the grant draft', by: '2026-08-25', mine: 1, state: 'open', nudges: 0 }

test('a date is understood or it is not, and nothing in between', () => {
  expect(day('2026-08-25')).toBe('2026-08-25')
  expect(day('  2026-08-25 ')).toBe('2026-08-25')
  // *Next Tuesday* is a thing a model can resolve and this plugin has no business guessing
  // at. A ledger that quietly picked a Tuesday would nudge on the wrong day and not say why.
  expect(day('next Tuesday')).toBeUndefined()
  expect(day('2026-13-01')).toBeUndefined()
  expect(day('')).toBeUndefined()
  expect(day(undefined)).toBeUndefined()
})

test('overdue is a fact about a day, and a commitment with no day is never one', () => {
  expect(overdue(open, TODAY)).toBe(true)
  expect(overdue({ ...open, by: '2026-09-30' }, TODAY)).toBe(false)
  // Closed is closed, whatever the date said.
  expect(overdue({ ...open, state: 'kept' }, TODAY)).toBe(false)
  // No day means it can be outstanding forever and still not be late, which is honest: a
  // deadline nobody set is not a deadline somebody missed.
  expect(overdue({ ...open, by: undefined }, TODAY)).toBe(false)
})

test('whose idea it was is on the line, because that is the difference between the two', () => {
  // Reminded or nagged. The predecessor kept this field for exactly this reason.
  expect(line(open, TODAY)).toContain('you said')
  expect(line({ ...open, mine: 0 }, TODAY)).toContain('you were asked')
})

test('a line says whether the day has passed, in the tense that has', () => {
  expect(line(open, TODAY)).toContain('was due 2026-08-25')
  expect(line({ ...open, by: '2026-09-30' }, TODAY)).toContain('by 2026-09-30')
  expect(line({ ...open, by: undefined }, TODAY)).not.toContain('due')
})

test('how often it has been raised is counted, and shown once there is anything to show', () => {
  expect(line(open, TODAY)).not.toContain('raised')
  expect(line({ ...open, nudges: 1 }, TODAY)).toContain('raised 1 time')
  expect(line({ ...open, nudges: 4 }, TODAY)).toContain('raised 4 times')
})

test('only the state that wants looking at is coloured', () => {
  // D67: a colour on these screens means something happened, and being open has not
  // happened to anybody.
  expect(mark(open, TODAY)).toBe('▲ overdue')
  expect(mark({ ...open, by: '2026-09-30' }, TODAY)).toBe('● open')
  expect(mark({ ...open, state: 'kept' }, TODAY)).toBe('■ kept')
  expect(mark({ ...open, state: 'dropped' }, TODAY)).toBe('■ dropped')
})
