// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { findSlots, freeBlocks, MIN } from '../slots.js'

const at = (hhmm) => Date.parse(`2026-11-26T${hhmm}:00Z`)
const ev = (id, a, b, over = {}) => ({ id, title: id, start: `2026-11-26T${a}:00Z`, end: `2026-11-26T${b}:00Z`, allDay: false, ...over })

test('free_blocks_between_events', () => {
  const blocks = freeBlocks([ev('b', '12:00', '13:00'), ev('a', '09:00', '10:00')], at('08:00'), at('22:00'))
  expect(blocks).toEqual([
    { start: at('08:00'), end: at('09:00') },
    { start: at('10:00'), end: at('12:00') },
    { start: at('13:00'), end: at('22:00') },
  ])
  // Overlapping events merge, and an event past the window is ignored.
  expect(freeBlocks([ev('a', '09:00', '11:00'), ev('b', '10:00', '12:00')], at('08:00'), at('13:00'))).toEqual([
    { start: at('08:00'), end: at('09:00') },
    { start: at('12:00'), end: at('13:00') },
  ])
})

test('all_day_blocks_nothing', () => {
  const day = { id: 'x', title: 'Holiday', start: '2026-11-26', end: '2026-11-27', allDay: true }
  expect(freeBlocks([day], at('08:00'), at('22:00'))).toEqual([{ start: at('08:00'), end: at('22:00') }])
})

test('three_slots_at_most', () => {
  const now = Date.parse('2026-11-26T06:00:00Z')
  const slots = findSlots([ev('a', '09:00', '10:00'), ev('b', '11:00', '12:00')], { now, tz: 0, minutes: 30, withinDays: 7 })
  expect(slots).toHaveLength(3)
  expect(slots[0]).toEqual({ start: at('08:00'), end: at('08:30') })
  expect(slots[1].start).toBe(at('10:00'))
  expect(slots[2].start).toBe(at('12:00'))
  for (const s of slots) expect(s.end - s.start).toBe(30 * MIN)
  // `after` and `before` limit the time of day; a slot that does not fit is not offered.
  const narrow = findSlots([ev('a', '09:00', '09:45')], { now, tz: 0, minutes: 30, withinDays: 1, after: '09:00', before: '10:00' })
  expect(narrow).toEqual([])
})
