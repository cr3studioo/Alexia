// SPDX-License-Identifier: AGPL-3.0-only
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { createRequest, eventsRequest, instantOf, isDeadline, mapEvents, nextRequest, noticeItems } from '../calendar.js'
import { fakeMicrosoft, settingsOf } from './fake.js'

process.env.ALEXIA_PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const { service, tools } = await import('../index.js')

/** A `calendarView` page in Graph's shape (asked for in UTC), written by hand. */
const page = {
  '@odata.context': "https://graph.microsoft.com/v1.0/$metadata#users('me')/calendarView(id,subject,start,end)",
  value: [
    {
      '@odata.etag': 'W/"abc"',
      id: 'AAMkAGevt1=',
      subject: '  Team call ',
      isAllDay: false,
      isCancelled: false,
      start: { dateTime: '2030-03-04T08:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2030-03-04T09:00:00.0000000', timeZone: 'UTC' },
      location: { displayName: 'Room 4', locationType: 'default' },
      attendees: [
        { type: 'required', status: { response: 'accepted' }, emailAddress: { name: 'A', address: 'a@example.com' } },
        { type: 'optional', emailAddress: { name: 'B', address: 'b@example.com' } },
        { type: 'resource', emailAddress: { name: 'No mail' } },
      ],
    },
    {
      id: 'evt2',
      subject: '',
      isAllDay: true,
      start: { dateTime: '2030-03-05T00:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2030-03-06T00:00:00.0000000', timeZone: 'UTC' },
      location: { displayName: '' },
      attendees: [],
    },
    { id: 'evt3', subject: 'Called off', isCancelled: true, isAllDay: false, start: { dateTime: '2030-03-04T12:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2030-03-04T13:00:00.0000000', timeZone: 'UTC' } },
  ],
}

describe('calendar', () => {
  test('events_mapped_to_interfaces_shape', async () => {
    expect(mapEvents(page)).toEqual([
      {
        id: 'AAMkAGevt1=',
        title: 'Team call',
        start: '2030-03-04T08:00:00Z',
        end: '2030-03-04T09:00:00Z',
        allDay: false,
        location: 'Room 4',
        attendees: ['a@example.com', 'b@example.com'],
        calendar: 'primary',
      },
      { id: 'evt2', title: '(no title)', start: '2030-03-05', end: '2030-03-06', allDay: true, attendees: [], calendar: 'primary' },
    ])
    expect(instantOf({ dateTime: '2030-03-04T08:00:00.1230000', timeZone: 'UTC' })).toBe('2030-03-04T08:00:00.123Z')
    expect(instantOf({ dateTime: '2030-03-04T08:00:00+01:00' })).toBe('2030-03-04T08:00:00+01:00')
    // A zone Graph was not asked for is not guessed at.
    expect(instantOf({ dateTime: '2030-03-04T08:00:00.0000000', timeZone: 'Pacific Standard Time' })).toBeUndefined()

    const req = eventsRequest({ from: '2030-03-04', to: Date.parse('2030-03-05T00:00:00Z') })
    const url = new URL(req.url)
    expect(url.origin + url.pathname).toBe('https://graph.microsoft.com/v1.0/me/calendarView')
    expect(url.searchParams.get('startDateTime')).toBe('2030-03-04T00:00:00.000Z')
    expect(url.searchParams.get('endDateTime')).toBe('2030-03-05T00:00:00.000Z')
    expect(url.searchParams.get('$select')).toContain('isAllDay')
    expect(req.headers).toEqual({ Prefer: 'outlook.timezone="UTC"' })
    expect(() => eventsRequest({ from: 'soon', to: '2030-01-01' })).toThrow('`from`')
    expect(() => eventsRequest({ from: '2030-01-02', to: '2030-01-01' })).toThrow('after')

    // A next page is followed only back to Graph: the bearer token goes nowhere else.
    expect(nextRequest({ '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?$skip=100' })?.url).toContain('$skip=100')
    expect(nextRequest({ '@odata.nextLink': 'https://evil.example/v1.0/me' })).toBeUndefined()
    expect(nextRequest({ '@odata.nextLink': 'https://graph.microsoft.com/beta/me' })).toBeUndefined()
    expect(nextRequest({})).toBeUndefined()

    // Through the tool: two pages, merged in start order, the same event once.
    const ms = fakeMicrosoft((url) => {
      const u = new URL(url)
      if (u.pathname !== '/v1.0/me/calendarView') return undefined
      if (u.searchParams.get('$skiptoken') === 'p2') {
        return { status: 200, json: { value: [{ id: 'evt0', subject: 'Early', isAllDay: false, start: { dateTime: '2030-03-04T07:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2030-03-04T07:30:00.0000000', timeZone: 'UTC' } }, page.value[0]] } }
      }
      return { status: 200, json: { ...page, '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=p2' } }
    })
    const svc = service({ ...settingsOf(ms), keep: async () => {}, fetch: ms.fetch })
    const result = await svc.calendarEvents({ from: '2030-03-04', to: '2030-03-06' })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent.events.map((e) => e.id)).toEqual(['evt0', 'AAMkAGevt1=', 'evt2'])
    expect(result.content[0].text).toContain('Team call @ Room 4')
    const api = ms.calls.filter((c) => c.url.startsWith('https://graph.microsoft.com'))
    expect(api).toHaveLength(2)
    expect(api.every((c) => c.method === 'GET' && c.headers.authorization === `Bearer ${ms.access}` && c.headers.Prefer === 'outlook.timezone="UTC"')).toBe(true)
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
      ev('tom', 'Deadline report', '2030-03-05T08:00:00Z'),
      ev('allday', 'Termín přihlášky', '2030-03-05', '2030-03-06'),
      ev('far', 'Taxes due', '2030-03-09T10:00:00Z'), // beyond two days
      ev('lunch', 'Lunch', '2030-03-04T11:00:00Z'),
      ev('hol', 'Holiday', '2030-03-04', '2030-03-05'),
      ev('trip', 'Trip', '2030-03-03', '2030-03-06'), // started yesterday, still on
      ev('next', 'Birthday', '2030-03-05', '2030-03-06'), // tomorrow, not today
    ]
    expect(noticeItems(events, { now, horizonDays: 2, tz })).toEqual([
      { key: 'microsoft:event:later', text: 'Odevzdat úkol', why: 'On your calendar today at 16:00.', dueAt: Date.parse('2030-03-04T15:00:00Z') },
      { key: 'microsoft:event:tom', text: 'Deadline report', why: 'On your calendar tomorrow at 09:00.', dueAt: Date.parse('2030-03-05T08:00:00Z') },
      { key: 'microsoft:event:allday', text: 'Termín přihlášky', why: 'On your calendar tomorrow.', dueAt: Date.parse('2030-03-04T23:00:00Z') },
      { key: 'microsoft:today:2030-03-04', text: 'Today: Holiday, Trip', why: 'All day on your calendar.', urgency: 'low' },
    ])
    expect(noticeItems(events, { now, horizonDays: 7, tz }).map((i) => i.key)).toContain('microsoft:event:far')
    expect(noticeItems([], { now, horizonDays: 2, tz })).toEqual([])
  })

  test('notice items come from the calendar, and nothing when not connected', async () => {
    const now = Date.parse('2030-03-04T07:00:00Z')
    const ms = fakeMicrosoft((url) =>
      url.includes('/me/calendarView') ?
        { status: 200, json: { value: [{ id: 'd1', subject: 'Due: essay', isAllDay: false, start: { dateTime: '2030-03-05T10:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2030-03-05T11:00:00.0000000', timeZone: 'UTC' } }] } }
      : undefined,
    )
    const svc = service({ ...settingsOf(ms), keep: async () => {}, fetch: ms.fetch })
    const result = await svc.noticeItems({ now, horizon_days: 2, tz_offset_min: 60 })
    expect(result.structuredContent.items).toEqual([
      { key: 'microsoft:event:d1', text: 'Due: essay', why: 'On your calendar tomorrow at 11:00.', dueAt: Date.parse('2030-03-05T10:00:00Z') },
    ])
    const asked = new URL(ms.calls.find((c) => c.url.includes('/me/calendarView')).url)
    expect(asked.searchParams.get('startDateTime')).toBe('2030-03-03T23:00:00.000Z')
    expect(asked.searchParams.get('endDateTime')).toBe('2030-03-05T23:00:00.000Z')

    const offline = fakeMicrosoft()
    const quiet = service({ ...settingsOf(offline, { refresh_token: '' }), keep: async () => {}, fetch: offline.fetch })
    const none = await quiet.noticeItems({ now })
    expect(none.isError).toBeUndefined()
    expect(none.structuredContent).toEqual({ items: [] })
    expect(offline.calls).toEqual([])
  })

  test('create_is_open_world', async () => {
    const ms = fakeMicrosoft((url, init) => (url === 'https://graph.microsoft.com/v1.0/me/events' && init.method === 'POST' ? { status: 201, json: { id: 'new1', subject: 'Dentist' } } : undefined))
    const svc = service({ ...settingsOf(ms), keep: async () => {}, fetch: ms.fetch })
    const [, config] = tools(svc).find(([name]) => name === 'calendar_create')
    expect(config.annotations).toMatchObject({ openWorldHint: true, destructiveHint: false, readOnlyHint: false })
    expect(config._meta['alexia/provides']).toEqual(['calendar.create'])
    // Everything else this plugin provides is read-only.
    for (const [name, c] of tools(svc)) {
      if (c._meta?.['alexia/provides'] && name !== 'calendar_create') expect(c.annotations.readOnlyHint, name).toBe(true)
    }

    const result = await svc.calendarCreate({ title: 'Dentist', start: '2030-03-04T09:00:00+01:00', end: '2030-03-04T09:30:00+01:00', location: 'Main St', attendees: ['x@example.com', 'x@example.com', 'not-an-email'] })
    expect(result.structuredContent).toEqual({ id: 'new1' })
    const post = ms.calls.find((c) => c.method === 'POST' && c.url.startsWith('https://graph.microsoft.com'))
    expect(post.headers['content-type']).toBe('application/json')
    expect(JSON.parse(post.body)).toEqual({
      subject: 'Dentist',
      start: { dateTime: '2030-03-04T08:00:00.000', timeZone: 'UTC' },
      end: { dateTime: '2030-03-04T08:30:00.000', timeZone: 'UTC' },
      isAllDay: false,
      location: { displayName: 'Main St' },
      attendees: [{ emailAddress: { address: 'x@example.com' }, type: 'required' }],
    })

    expect(createRequest({ title: 'Holiday', start: '2030-03-04' }).body).toEqual({
      subject: 'Holiday',
      start: { dateTime: '2030-03-04T00:00:00.000', timeZone: 'UTC' },
      end: { dateTime: '2030-03-05T00:00:00.000', timeZone: 'UTC' },
      isAllDay: true,
    })
    expect(createRequest({ title: 'Trip', start: '2030-03-04', end: '2030-03-04' }).body.end.dateTime).toBe('2030-03-05T00:00:00.000')
    expect(createRequest({ title: 'Solo', start: '2030-03-04T09:00:00Z' }).body.end.dateTime).toBe('2030-03-04T10:00:00.000')
    const bad = await svc.calendarCreate({ title: 'x', start: '2030-03-04T10:00:00Z', end: '2030-03-04T09:00:00Z' })
    expect(bad).toMatchObject({ isError: true, content: [{ text: 'The end has to be after the start.' }] })
    expect((await svc.calendarCreate({ start: '2030-03-04' })).content[0].text).toBe('The event needs a title.')
    expect((await svc.calendarCreate({ title: 'x', start: '2030-03-04', end: '2030-03-04T10:00:00Z' })).content[0].text).toContain('both be days')
  })
})
