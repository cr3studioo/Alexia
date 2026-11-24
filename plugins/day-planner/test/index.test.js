// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { createPlanner, NO_CALENDAR } from '../tools.js'

const NOW = Date.parse('2026-11-26T06:00:00Z')
const reply = (structuredContent, text = '') => ({ content: [{ type: 'text', text }], structuredContent })

/** A planner whose capabilities are a table of fakes; a missing name throws, as a missing provider does. */
function make(fakes, settings = {}) {
  const calls = []
  const statuses = []
  const planner = createPlanner({
    capability: async (cap, args) => {
      calls.push([cap, args])
      if (!fakes[cap]) throw new Error('nothing answers')
      return fakes[cap](args)
    },
    settings: async () => settings,
    status: (s) => statuses.push(s),
    now: () => NOW,
    tz: () => 0,
  })
  return { planner, calls, statuses }
}

test('no_calendar_provider_says_so', async () => {
  const { planner, statuses } = make({})
  const section = await planner.briefSection({ kind: 'morning', now: NOW, tz_offset_min: 0 })
  expect(section.structuredContent.text).toBe('')
  await planner.briefSection({ kind: 'evening', now: NOW, tz_offset_min: 0 })
  // Said once, in the status.
  expect(statuses).toEqual([`▲ ${NO_CALENDAR}`])
  const found = await planner.findTime({ what: 'run', minutes: 30 })
  expect(found.isError).toBe(true)
  expect(found.content[0].text).toBe(NO_CALENDAR)
  expect((await planner.noticeItems({ now: NOW })).structuredContent.items).toEqual([])
})

test('book_slot_calls_create', async () => {
  const { planner, calls } = make({ 'calendar.create': () => reply({ id: 'new1' }) })
  const done = await planner.bookSlot({ what: 'Run', start: '2026-11-26T10:00:00+01:00', minutes: 45 })
  expect(done.isError).toBeUndefined()
  expect(done.structuredContent.id).toBe('new1')
  expect(calls).toEqual([['calendar.create', { title: 'Run', start: '2026-11-26T10:00:00+01:00', end: '2026-11-26T10:45:00+01:00' }]])
  // A start that is not a time is refused before anything is created.
  const bad = await planner.bookSlot({ what: 'Run', start: 'tomorrow-ish', minutes: 30 })
  expect(bad.isError).toBe(true)
  expect(calls).toHaveLength(1)
})

test('notice_items_gather_prep_from_optional_sources', async () => {
  const event = { id: 'm1', title: 'Budget', start: '2026-11-26T14:00:00Z', end: '2026-11-26T15:00:00Z', allDay: false, location: 'Office', attendees: ['a@x.test'] }
  const { planner } = make({
    'calendar.events': () => reply({ events: [event] }),
    'memory.recall': () => reply(undefined, 'Ann prefers short agendas.'),
    // mail.list has no provider: it must not break the item.
  })
  const { items } = (await planner.noticeItems({ now: NOW, horizon_days: 1, tz_offset_min: 0 })).structuredContent
  const prep = items.find((i) => i.key === 'planner:prep:m1')
  expect(prep.why).toContain('Ann prefers short agendas.')
  expect(items.some((i) => i.key === 'planner:leave:m1')).toBe(true)
})
