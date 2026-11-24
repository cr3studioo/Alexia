// SPDX-License-Identifier: AGPL-3.0-only
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { calendarIds, createRequest, eventsRequest, isDeadline, mapEvents, noticeItems } from '../calendar.js'
import { fakeGoogle, settingsOf } from './fake.js'

process.env.ALEXIA_PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const { service, tools } = await import('../index.js')

/** An `events.list` page in Google's shape, written by hand. */
const page = {
  kind: 'calendar#events',
  summary: 'Test calendar',
  items: [
    {
      kind: 'calendar#event',
      id: 'evt1',
      status: 'confirmed',
      summary: '  Team call ',
      location: 'Room 4',
      start: { dateTime: '2030-03-04T09:00:00+01:00', timeZone: 'Europe/Prague' },
      end: { dateTime: '2030-03-04T10:00:00+01:00', timeZone: 'Europe/Prague' },
      attendees: [{ email: 'a@example.com', responseStatus: 'accepted' }, { email: 'b@example.com', self: true }, { displayName: 'No mail' }],
    },
    { kind: 'calendar#event', id: 'evt2', status: 'confirmed', start: { date: '2030-03-05' }, end: { date: '2030-03-06' } },
    { kind: 'calendar#event', id: 'evt3', status: 'cancelled' },
  ],
}

describe('calendar', () => {
  test('events_mapped_to_interfaces_shape', async () => {
    expect(mapEvents(page, 'primary')).toEqual([
      {
        id: 'evt1',
        title: 'Team call',
        start: '2030-03-04T09:00:00+01:00',
        end: '2030-03-04T10:00:00+01:00',
        allDay: false,
        location: 'Room 4',
        attendees: ['a@example.com', 'b@example.com'],
        calendar: 'primary',
      },
      { id: 'evt2', title: '(no title)', start: '2030-03-05', end: '2030-03-06', allDay: true, attendees: [], calendar: 'primary' },
    ])

    const req = new URL(eventsRequest('work@group.calendar.google.com', { from: '2030-03-04', to: Date.parse('2030-03-05T00:00:00Z') }).url)
    expect(req.pathname).toBe('/calendar/v3/calendars/work%40group.calendar.google.com/events')
    expect(req.searchParams.get('timeMin')).toBe('2030-03-04T00:00:00.000Z')
    expect(req.searchParams.get('timeMax')).toBe('2030-03-05T00:00:00.000Z')
    expect(req.searchParams.get('singleEvents')).toBe('true')
    expect(() => eventsRequest('primary', { from: 'soon', to: '2030-01-01' })).toThrow('`from`')
    expect(calendarIds('')).toEqual(['primary'])
    expect(calendarIds('primary, work@x , primary')).toEqual(['primary', 'work@x'])

    // Through the tool: two calendars, merged in start order, the same event once.
    const google = fakeGoogle((url) => {
      if (url.includes('/calendars/primary/')) return { status: 200, json: page }
      if (url.includes('/calendars/second/')) {
        return { status: 200, json: { items: [{ id: 'evt0', summary: 'Early', start: { dateTime: '2030-03-04T07:00:00Z' }, end: { dateTime: '2030-03-04T07:30:00Z' } }, page.items[0]] } }
      }
      return undefined
    })
    const svc = service({ ...settingsOf(google, { calendars: 'primary,second' }), keep: async () => {}, fetch: google.fetch })
    const result = await svc.calendarEvents({ from: '2030-03-04', to: '2030-03-06' })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent.events.map((e) => [e.id, e.calendar])).toEqual([
      ['evt0', 'second'],
      ['evt1', 'primary'],
      ['evt2', 'primary'],
    ])
    expect(result.content[0].text).toContain('Team call @ Room 4')
    const api = google.calls.filter((c) => c.url.includes('/calendar/v3/'))
    expect(api.every((c) => c.method === 'GET' && c.headers.authorization === `Bearer ${google.access}`)).toBe(true)
  })

  test('deadline_words_become_notice_items', () => {
    for (const title of ['Deadline: report', 'Thesis due', 'ODEVZDAT úkol', 'Termín přihlášky', 'termin zkousky', 'Due!']) {
      expect(isDeadline(title), title).toBe(true)
    }
    for (const title of ['Dueling pianos', 'Overdue library book', 'Terminál', 'Lunch', 'Deadlines review']) {
      expect(isDeadline(title), title).toBe(false)
    }

    // 2030-03-04 08:00 in Prague (UTC+1).
    const tz = 60
    const now = Date.parse('2030-03-04T07:00:00Z')
    const ev = (id, title, start, end = start, allDay = start.length === 10) => ({ id, title, start, end, allDay, attendees: [], calendar: 'primary' })
    const events = [
      ev('gone', 'Deadline: form', '2030-03-04T06:00:00Z'), // already past
      ev('later', 'Odevzdat úkol', '2030-03-04T15:00:00Z'),
      ev('tom', 'Deadline report', '2030-03-05T09:00:00+01:00'),
      ev('allday', 'Termín přihlášky', '2030-03-05', '2030-03-06'),
      ev('far', 'Taxes due', '2030-03-09T10:00:00Z'), // beyond two days
      ev('lunch', 'Lunch', '2030-03-04T11:00:00Z'),
      ev('hol', 'Holiday', '2030-03-04', '2030-03-05'),
      ev('trip', 'Trip', '2030-03-03', '2030-03-06'), // started yesterday, still on
      ev('next', 'Birthday', '2030-03-05', '2030-03-06'), // tomorrow, not today
    ]
    const items = noticeItems(events, { now, horizonDays: 2, tz })
    expect(items).toEqual([
      { key: 'google:event:later', text: 'Odevzdat úkol', why: 'On your calendar today at 16:00.', dueAt: Date.parse('2030-03-04T15:00:00Z') },
      { key: 'google:event:tom', text: 'Deadline report', why: 'On your calendar tomorrow at 09:00.', dueAt: Date.parse('2030-03-05T08:00:00Z') },
      { key: 'google:event:allday', text: 'Termín přihlášky', why: 'On your calendar tomorrow.', dueAt: Date.parse('2030-03-04T23:00:00Z') },
      { key: 'google:today:2030-03-04', text: 'Today: Holiday, Trip', why: 'All day on your calendar.', urgency: 'low' },
    ])
    expect(noticeItems(events, { now, horizonDays: 7, tz }).map((i) => i.key)).toContain('google:event:far')
    expect(noticeItems([], { now, horizonDays: 2, tz })).toEqual([])
  })

  test('notice items come from the configured calendars, and nothing when not connected', async () => {
    const now = Date.parse('2030-03-04T07:00:00Z')
    const google = fakeGoogle((url) =>
      url.includes('/calendar/v3/') ?
        { status: 200, json: { items: [{ id: 'd1', summary: 'Due: essay', start: { dateTime: '2030-03-05T10:00:00Z' }, end: { dateTime: '2030-03-05T11:00:00Z' } }] } }
      : undefined,
    )
    const svc = service({ ...settingsOf(google), keep: async () => {}, fetch: google.fetch })
    const result = await svc.noticeItems({ now, horizon_days: 2, tz_offset_min: 60 })
    expect(result.structuredContent.items).toEqual([
      { key: 'google:event:d1', text: 'Due: essay', why: 'On your calendar tomorrow at 11:00.', dueAt: Date.parse('2030-03-05T10:00:00Z') },
    ])
    const asked = new URL(google.calls.find((c) => c.url.includes('/calendar/v3/')).url)
    expect(asked.searchParams.get('timeMin')).toBe('2030-03-03T23:00:00.000Z')
    expect(asked.searchParams.get('timeMax')).toBe('2030-03-05T23:00:00.000Z')

    const offline = fakeGoogle()
    const quiet = service({ ...settingsOf(offline, { refresh_token: '' }), keep: async () => {}, fetch: offline.fetch })
    const none = await quiet.noticeItems({ now })
    expect(none.isError).toBeUndefined()
    expect(none.structuredContent).toEqual({ items: [] })
    expect(offline.calls).toEqual([])
  })

  test('create_is_open_world', async () => {
    const google = fakeGoogle((url, init) => (url.includes('/calendar/v3/') && init.method === 'POST' ? { status: 200, json: { id: 'new1', status: 'confirmed' } } : undefined))
    const svc = service({ ...settingsOf(google, { calendars: 'work@x, primary' }), keep: async () => {}, fetch: google.fetch })
    const [, config] = tools(svc).find(([name]) => name === 'calendar_create')
    expect(config.annotations).toMatchObject({ openWorldHint: true, destructiveHint: false, readOnlyHint: false })
    expect(config._meta['alexia/provides']).toEqual(['calendar.create'])
    // Everything else this plugin provides is read-only.
    for (const [name, c] of tools(svc)) {
      if (c._meta?.['alexia/provides'] && name !== 'calendar_create') expect(c.annotations.readOnlyHint, name).toBe(true)
    }

    const result = await svc.calendarCreate({ title: 'Dentist', start: '2030-03-04T09:00:00+01:00', end: '2030-03-04T09:30:00+01:00', location: 'Main St', attendees: ['x@example.com'] })
    expect(result.structuredContent).toEqual({ id: 'new1' })
    const post = google.calls.find((c) => c.method === 'POST' && c.url.includes('/calendar/v3/'))
    expect(new URL(post.url).pathname).toBe('/calendar/v3/calendars/work%40x/events')
    expect(new URL(post.url).searchParams.get('sendUpdates')).toBe('all')
    expect(JSON.parse(post.body)).toEqual({
      summary: 'Dentist',
      start: { dateTime: '2030-03-04T08:00:00.000Z' },
      end: { dateTime: '2030-03-04T08:30:00.000Z' },
      location: 'Main St',
      attendees: [{ email: 'x@example.com' }],
    })

    expect(createRequest({ title: 'Holiday', start: '2030-03-04' }).body).toEqual({ summary: 'Holiday', start: { date: '2030-03-04' }, end: { date: '2030-03-05' } })
    expect(new URL(createRequest({ title: 'Solo', start: '2030-03-04T09:00:00Z' }).url).searchParams.get('sendUpdates')).toBe('none')
    const bad = await svc.calendarCreate({ title: 'x', start: '2030-03-04T10:00:00Z', end: '2030-03-04T09:00:00Z' })
    expect(bad).toMatchObject({ isError: true, content: [{ text: 'The end has to be after the start.' }] })
    expect((await svc.calendarCreate({ start: '2030-03-04' })).content[0].text).toBe('The event needs a title.')
  })
})
