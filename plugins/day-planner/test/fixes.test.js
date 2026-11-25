// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { createPlanner, NO_CALENDAR } from '../tools.js'

const NOW = Date.parse('2026-11-26T06:00:00Z')
const reply = (structuredContent, text = '') => ({ content: [{ type: 'text', text }], structuredContent })

/** Europe/Prague's offset in minutes at an instant, from the real rules (changes 25 Oct 2026, 28 Mar 2027). */
const prague = (ms) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Prague', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(ms))
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]))
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60000) * 60000) / 60000)
}

const noProvider = () => Object.assign(new Error('capability not available'), { code: -32050 })

function make(fakes, over = {}) {
  const statuses = []
  const p = createPlanner({
    capability: async (cap, args) => {
      if (!fakes[cap]) throw noProvider()
      return fakes[cap](args)
    },
    settings: async () => ({}),
    status: (s) => statuses.push(s),
    now: () => NOW,
    tz: () => 0,
    ...over,
  })
  return { p, statuses }
}

test('prague_helper_knows_the_switch', () => {
  expect(prague(Date.parse('2026-10-24T12:00:00Z'))).toBe(120)
  expect(prague(Date.parse('2026-10-25T12:00:00Z'))).toBe(60)
  expect(prague(Date.parse('2027-03-28T12:00:00Z'))).toBe(120)
})

test('find_time_tool_path_and_dst_week', async () => {
  // Thu 22 Oct 2026 06:00 Prague (CEST). Clocks go back on Sun 25 Oct.
  const now = Date.parse('2026-10-22T04:00:00Z')
  const busy = (day, from, to, off) => {
    const at = (h) => new Date(Date.parse(`${day}T00:00:00Z`) + (h * 60 - off) * 60000).toISOString()
    return { id: `b${day}`, title: 'Busy', start: at(from), end: at(to), allDay: false }
  }
  // Busy 08:00–22:00 wall clock every day, except Mon 26 Oct (CET) where 20:00–22:00 is free.
  const events = [busy('2026-10-22', 8, 22, 120), busy('2026-10-23', 8, 22, 120), busy('2026-10-24', 8, 22, 120), busy('2026-10-25', 8, 22, 60), busy('2026-10-26', 8, 20, 60)]
  const { p } = make({ 'calendar.events': () => reply({ events }) }, { now: () => now, tz: prague })
  const res = await p.findTime({ what: 'run', minutes: 60, within_days: 7 })
  expect(res.isError).toBeUndefined()
  const [slot] = res.structuredContent.slots
  expect(slot.start).toBe('2026-10-26T20:00:00+01:00')
  expect(slot.end).toBe('2026-10-26T21:00:00+01:00')
  expect(slot.label).toBe('Mon 26 Oct 20:00–21:00')
  expect(res.content[0].text).toContain('Free for run:')
})

test('find_time_day_bounds_follow_each_days_offset_october', async () => {
  const now = Date.parse('2026-10-24T05:00:00Z')
  const { p } = make({ 'calendar.events': () => reply({ events: [] }) }, { now: () => now, tz: prague })
  const res = await p.findTime({ what: 'x', minutes: 30, within_days: 4, after: '08:00', before: '08:30' })
  expect(res.structuredContent.slots.map((s) => s.start)).toEqual(['2026-10-24T08:00:00+02:00', '2026-10-25T08:00:00+01:00', '2026-10-26T08:00:00+01:00'])
})

test('find_time_day_bounds_follow_each_days_offset_march', async () => {
  const now = Date.parse('2027-03-26T05:00:00Z')
  const { p } = make({ 'calendar.events': () => reply({ events: [] }) }, { now: () => now, tz: prague })
  const res = await p.findTime({ what: 'x', minutes: 30, within_days: 5, after: '08:00', before: '08:30' })
  expect(res.structuredContent.slots.map((s) => s.start)).toEqual(['2027-03-26T08:00:00+01:00', '2027-03-27T08:00:00+01:00', '2027-03-28T08:00:00+02:00'])
})

test('book_slot_only_says_no_calendar_for_no_provider', async () => {
  const start = '2026-11-26T10:00:00+01:00'
  const none = await make({}).p.bookSlot({ what: 'Run', start, minutes: 30 })
  expect(none.content[0].text).toBe(NO_CALENDAR)
  const broke = await make({ 'calendar.create': () => { throw new Error('disk on fire') } }).p.bookSlot({ what: 'Run', start, minutes: 30 })
  expect(broke.isError).toBe(true)
  expect(broke.content[0].text).toContain('disk on fire')
  expect(broke.content[0].text).not.toContain(NO_CALENDAR)
  const refused = { isError: true, content: [{ type: 'text', text: 'Quota exceeded' }] }
  expect(await make({ 'calendar.create': () => refused }).p.bookSlot({ what: 'Run', start, minutes: 30 })).toBe(refused)
})

test('book_slot_refuses_minutes_outside_1_to_1440', async () => {
  const { p } = make({ 'calendar.create': () => reply({ id: 'x' }) })
  const start = '2026-11-26T10:00:00+01:00'
  for (const minutes of [0, -5, 1441, 1e15, 1e30]) {
    const r = await p.bookSlot({ what: 'Run', start, minutes })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('1 to 1440')
  }
  expect((await p.bookSlot({ what: 'Run', start, minutes: 1440 })).isError).toBeUndefined()
  expect((await p.bookSlot({ what: 'Run', start, minutes: 1 })).isError).toBeUndefined()
})

test('provider_error_is_not_reported_as_no_calendar', async () => {
  const expired = { isError: true, content: [{ type: 'text', text: 'Login expired, sign in again' }] }
  const { p, statuses } = make({ 'calendar.events': () => expired })
  const found = await p.findTime({ what: 'run', minutes: 30 })
  expect(found.isError).toBe(true)
  expect(found.content[0].text).toContain('Login expired')
  expect(found.content[0].text).not.toBe(NO_CALENDAR)
  expect(statuses).toHaveLength(1)
  expect(statuses[0]).toContain('Login expired')
  const thrown = await make({ 'calendar.events': () => { throw new Error('socket hang up') } }).p.findTime({ what: 'run', minutes: 30 })
  expect(thrown.content[0].text).toContain('socket hang up')
})

test('evening_and_weekly_sections_through_brief_section', async () => {
  const events = [
    { id: 'e1', title: 'Dentist', start: '2026-11-27T08:30:00Z', end: '2026-11-27T09:00:00Z', allDay: false, location: 'Clinic' },
    { id: 'e2', title: 'Lunch', start: '2026-11-27T11:00:00Z', end: '2026-11-27T12:00:00Z', allDay: false },
    { id: 'e3', title: 'Review', start: '2026-11-30T13:00:00Z', end: '2026-11-30T14:00:00Z', allDay: false },
  ]
  const { p } = make({ 'calendar.events': () => reply({ events }) }, { settings: async () => ({ travel_minutes: 20 }) })
  const evening = await p.briefSection({ kind: 'evening', now: NOW, tz_offset_min: 0 })
  expect(evening.structuredContent.text).toBe('Tomorrow: first is Dentist at 08:30 (Clinic). Leave by 08:10.')
  const weekly = await p.briefSection({ kind: 'weekly', now: NOW, tz_offset_min: 0 })
  expect(weekly.structuredContent.text.split('\n')).toEqual(['The week ahead:', '- Fri 27 Nov: 08:30 Dentist; 11:00 Lunch', '- Mon 30 Nov: 13:00 Review'])
  const none = await make({ 'calendar.events': () => reply({ events: [] }) }).p.briefSection({ kind: 'evening', now: NOW, tz_offset_min: 0 })
  expect(none.structuredContent.text).toBe('Tomorrow: nothing in your calendar.')
})
