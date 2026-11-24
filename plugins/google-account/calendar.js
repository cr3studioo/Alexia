// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Google Calendar: request builders and response mappers. Pure — nothing here touches the
 * network, so every shape is tested on hand-written JSON.
 *
 * Shapes are INTERFACES §3.6: `calendar.events` → `{events: [{id, title, start, end, allDay,
 * location?, attendees, calendar}]}`, `calendar.create` → `{id}`, and the `notice.items` this
 * plugin offers from the calendar.
 */

export const API = 'https://www.googleapis.com/calendar/v3'

const DAY_MS = 24 * 60 * 60 * 1000
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** A bad argument, said as a sentence. */
export class ArgumentError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ArgumentError'
  }
}

/** Epoch ms from a number, an ISO string or a `YYYY-MM-DD` day. `undefined` when it is neither. */
export function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const text = value.trim()
  if (/^\d+$/.test(text)) return Number(text)
  const ms = Date.parse(DATE.test(text) ? `${text}T00:00:00Z` : text)
  return Number.isFinite(ms) ? ms : undefined
}

/** The calendar ids from the `calendars` setting: comma, space or newline separated; `primary` by default. */
export function calendarIds(setting) {
  const ids = String(setting ?? '')
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean)
  return ids.length > 0 ? [...new Set(ids)] : ['primary']
}

/** `GET` one calendar's events between `from` and `to`, recurring events expanded. */
export function eventsRequest(calendarId, { from, to }, pageToken) {
  const start = toMs(from)
  const end = toMs(to)
  if (start === undefined) throw new ArgumentError('`from` is not a date or time Alexia understands.')
  if (end === undefined) throw new ArgumentError('`to` is not a date or time Alexia understands.')
  if (end <= start) throw new ArgumentError('`to` has to be after `from`.')
  const url = new URL(`${API}/calendars/${encodeURIComponent(calendarId)}/events`)
  url.search = new URLSearchParams({
    timeMin: new Date(start).toISOString(),
    timeMax: new Date(end).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
    ...(typeof pageToken === 'string' && pageToken !== '' && { pageToken }),
  }).toString()
  return { url: url.toString(), method: 'GET' }
}

/** One Google event in the INTERFACES shape. `undefined` for a cancelled one. */
export function mapEvent(ev, calendar) {
  if (!ev || typeof ev !== 'object' || ev.status === 'cancelled') return undefined
  const allDay = typeof ev.start?.date === 'string' && typeof ev.start?.dateTime !== 'string'
  const start = ev.start?.dateTime ?? ev.start?.date
  const end = ev.end?.dateTime ?? ev.end?.date ?? start
  if (typeof ev.id !== 'string' || typeof start !== 'string') return undefined
  const location = typeof ev.location === 'string' && ev.location.trim() !== '' ? ev.location.trim() : undefined
  return {
    id: ev.id,
    title: typeof ev.summary === 'string' && ev.summary.trim() !== '' ? ev.summary.trim() : '(no title)',
    start,
    end,
    allDay,
    ...(location !== undefined && { location }),
    attendees: Array.isArray(ev.attendees) ? ev.attendees.map((a) => a?.email).filter((e) => typeof e === 'string') : [],
    calendar,
  }
}

/** Every event of one `events.list` page, mapped. */
export const mapEvents = (json, calendar) =>
  (Array.isArray(json?.items) ? json.items : []).map((ev) => mapEvent(ev, calendar)).filter(Boolean)

/** Several calendars' events, one list, in start order, each event once. */
export function merge(lists) {
  const seen = new Set()
  const out = []
  for (const ev of lists.flat()) {
    if (seen.has(ev.id)) continue
    seen.add(ev.id)
    out.push(ev)
  }
  return out.sort((a, b) => (startMs(a) ?? 0) - (startMs(b) ?? 0))
}

/** An event's start in epoch ms. An all-day event starts at local midnight (`tz` minutes east of UTC). */
export function startMs(ev, tz = 0) {
  if (ev.allDay) return Date.parse(`${ev.start}T00:00:00Z`) - tz * 60_000
  const ms = Date.parse(ev.start)
  return Number.isFinite(ms) ? ms : undefined
}

/** One readable line per event, for the text block beside `structuredContent`. */
export function eventLine(ev) {
  const when = ev.allDay ? `${ev.start} (all day)` : `${ev.start} – ${ev.end}`
  return `- ${when}: ${ev.title}${ev.location ? ` @ ${ev.location}` : ''}`
}

const asTime = (value, name) => {
  if (typeof value === 'string' && DATE.test(value.trim())) return { date: value.trim() }
  const ms = toMs(value)
  if (ms === undefined) throw new ArgumentError(`\`${name}\` is not a date or time Alexia understands.`)
  return { dateTime: new Date(ms).toISOString() }
}

const nextDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)

/**
 * `POST` a new event. A `YYYY-MM-DD` start makes an all-day event. A missing `end` is an hour
 * after the start (or the next day, for all-day). Guests named in `attendees` are invited by
 * Google — which is why this capability is open-world and always asks first.
 */
export function createRequest({ title, start, end, location, attendees } = {}, calendarId = 'primary') {
  const summary = String(title ?? '').trim()
  if (summary === '') throw new ArgumentError('The event needs a title.')
  const from = asTime(start, 'start')
  let to
  if (end === undefined || end === null || end === '') {
    to = from.date ? { date: nextDay(from.date) } : { dateTime: new Date(Date.parse(from.dateTime) + 60 * 60 * 1000).toISOString() }
  } else {
    to = asTime(end, 'end')
  }
  if (Boolean(from.date) !== Boolean(to.date)) throw new ArgumentError('`start` and `end` must both be days, or both be times.')
  const a = from.date ? Date.parse(`${from.date}T00:00:00Z`) : Date.parse(from.dateTime)
  const b = to.date ? Date.parse(`${to.date}T00:00:00Z`) : Date.parse(to.dateTime)
  if (b < a || (b === a && !from.date)) throw new ArgumentError('The end has to be after the start.')
  // Google's all-day end is exclusive: a one-day event ends the next day.
  if (from.date && b === a) to = { date: nextDay(to.date) }
  const guests = (Array.isArray(attendees) ? attendees : typeof attendees === 'string' ? attendees.split(/[\s,;]+/) : [])
    .map((e) => String(e).trim())
    .filter((e) => e.includes('@'))
  const where = typeof location === 'string' && location.trim() !== '' ? location.trim() : undefined
  const url = new URL(`${API}/calendars/${encodeURIComponent(calendarId)}/events`)
  url.searchParams.set('sendUpdates', guests.length > 0 ? 'all' : 'none')
  return {
    url: url.toString(),
    method: 'POST',
    body: {
      summary,
      start: from,
      end: to,
      ...(where !== undefined && { location: where }),
      ...(guests.length > 0 && { attendees: guests.map((email) => ({ email })) }),
    },
  }
}

/** The words that make an event a deadline, English and Czech, any case, accents optional. */
const DEADLINE = /(?:^|[^\p{L}\p{N}])(?:deadline|due|odevzdat|term[ií]n)(?=$|[^\p{L}\p{N}])/iu

export const isDeadline = (title) => DEADLINE.test(String(title ?? ''))

/** `YYYY-MM-DD` of an instant in the owner's zone. */
export const localDay = (ms, tz = 0) => new Date(ms + tz * 60_000).toISOString().slice(0, 10)

const localTime = (ms, tz = 0) => new Date(ms + tz * 60_000).toISOString().slice(11, 16)

/**
 * **What the calendar has worth saying now** (`notice.items`), pure.
 *
 * - An event in the next `horizonDays` days (today counts as the first) whose title carries a
 *   deadline word becomes an item, `dueAt` its start, key `google:event:<id>`. A timed one
 *   that has already started is left out; an all-day one counts all day.
 * - Today's other all-day events become one Low item, "Today: <titles>".
 */
export function noticeItems(events, { now, horizonDays = 2, tz = 0 }) {
  const today = localDay(now, tz)
  const todayStart = Date.parse(`${today}T00:00:00Z`) - tz * 60_000
  const horizonEnd = todayStart + Math.max(1, Math.floor(horizonDays)) * DAY_MS
  const tomorrow = localDay(todayStart + DAY_MS + 1, tz)
  const items = []
  const allDayToday = []
  const seen = new Set()
  for (const ev of events) {
    if (seen.has(ev.id)) continue
    seen.add(ev.id)
    const at = startMs(ev, tz)
    if (at === undefined) continue
    const deadline = isDeadline(ev.title)
    if (deadline && at < horizonEnd && (ev.allDay ? at >= todayStart : at >= now)) {
      const day = ev.allDay ? ev.start : localDay(at, tz)
      const dayWord = day === today ? 'today' : day === tomorrow ? 'tomorrow' : day
      items.push({
        key: `google:event:${ev.id}`,
        text: ev.title,
        why: ev.allDay ? `On your calendar ${dayWord}.` : `On your calendar ${dayWord} at ${localTime(at, tz)}.`,
        dueAt: at,
      })
    } else if (!deadline && ev.allDay && ev.start <= today && (today < ev.end || ev.start === today)) {
      // Google's all-day end is exclusive, so a three-day trip counts on each of its days.
      allDayToday.push(ev.title)
    }
  }
  if (allDayToday.length > 0) {
    items.push({
      key: `google:today:${today}`,
      text: `Today: ${allDayToday.join(', ')}`,
      why: 'All day on your calendar.',
      urgency: 'low',
    })
  }
  return items
}
