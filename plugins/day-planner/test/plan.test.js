// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { leaveItems, morningSection, prepItems } from '../plan.js'
import { MIN } from '../slots.js'

const NOW = Date.parse('2026-11-26T06:00:00Z')
const ev = (id, a, b, over = {}) => ({ id, title: `T-${id}`, start: `2026-11-26T${a}:00Z`, end: `2026-11-26T${b}:00Z`, allDay: false, ...over })

test('morning_section_lines', () => {
  const text = morningSection(
    [ev('a', '09:00', '10:00', { location: 'Office' }), ev('b', '10:30', '11:00'), { id: 'h', title: 'Holiday', start: '2026-11-26', end: '2026-11-27', allDay: true }],
    { now: NOW, tz: 0 },
  )
  const lines = text.split('\n')
  expect(lines[0]).toBe('Today:')
  expect(lines).toContain('- All day: Holiday')
  expect(lines).toContain('- 09:00 T-a (Office)')
  expect(lines).toContain('- 10:30 T-b')
  // Free blocks over an hour only: 08:00–09:00 is exactly an hour and is left out.
  expect(lines.at(-1)).toBe('Free: 11:00–22:00')
})

test('morning_all_day_without_end_is_that_one_day', () => {
  const o = { now: NOW, tz: 0 }
  const day = (over) => ({ id: 'a', title: 'Birthday', start: '2026-11-26', allDay: true, ...over })
  for (const e of [day({}), day({ end: '' }), day({ end: '2026-11-26' })]) expect(morningSection([e], o)).toContain('- All day: Birthday')
  expect(morningSection([day({ start: '2026-11-27' })], o)).not.toContain('Birthday')
  expect(morningSection([day({ start: '2026-11-25', end: '2026-11-25' })], o)).not.toContain('Birthday')
})

test('leave_now_from_travel_minutes', () => {
  const start = Date.parse('2026-11-26T09:00:00Z')
  const [item] = leaveItems([ev('a', '09:00', '10:00', { location: 'Dentist' })], { now: NOW, tz: 0, travel: 45, home: 'Home' })
  expect(item.key).toBe('planner:leave:a')
  expect(item.dueAt).toBe(start - 45 * MIN)
  // 08:15 is more than 30 minutes after 06:00: not yet high.
  expect(item.urgency).toBe('normal')
  const [soon] = leaveItems([ev('a', '09:00', '10:00', { location: 'Dentist' })], { now: Date.parse('2026-11-26T08:00:00Z'), tz: 0, travel: 45 })
  expect(soon.urgency).toBe('high')
})

test('home_events_have_no_leave_now', () => {
  const events = [ev('a', '09:00', '10:00', { location: ' home ' }), ev('b', '11:00', '12:00'), ev('c', '13:00', '14:00', { location: '' })]
  expect(leaveItems(events, { now: NOW, tz: 0, travel: 30, home: 'Home' })).toEqual([])
})

test('prep_not_before_an_hour', () => {
  const start = Date.parse('2026-11-26T14:00:00Z')
  const events = [ev('m', '14:00', '15:00', { attendees: ['a@x.test', 'b@x.test'] }), ev('solo', '16:00', '17:00')]
  const items = prepItems(events, { now: NOW, tz: 0, prep: 60 }, { m: 'What I know: Ann likes tea.' })
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ key: 'planner:prep:m', urgency: 'low', notBefore: start - 60 * MIN, why: 'What I know: Ann likes tea.' })
  expect(items[0].text).toBe("T-m at 14:00: 2 people, I've gathered what I know.")
})
