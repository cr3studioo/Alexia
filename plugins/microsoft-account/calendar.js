// SPDX-License-Identifier: AGPL-3.0-only
import { GRAPH } from './oauth.js'

/**
 * The Outlook calendar through Microsoft Graph: request builders and response mappers. Pure —
 * nothing here touches the network, so every shape is tested on hand-written Graph JSON.
 *
 * Shapes are INTERFACES §3.6: `calendar.events` → `{events: [{id, title, start, end, allDay,
 * location?, attendees, calendar}]}`, `calendar.create` → `{id}`, and the `notice.items` this
 * plugin offers from the calendar (keys `microsoft:event:<id>`).
 *
 * Every read asks Graph for times in UTC (`Prefer: outlook.timezone="UTC"`), so a timed event's
 * `start` and `end` come out as ISO instants ending in `Z`. An all-day event's are days
 * (`YYYY-MM-DD`), its end exclusive, as Graph keeps them.
 */

/** The one calendar this plugin reads and writes: the account's default one. */
export const CALENDAR = 'primary'

const DAY_MS = 24 * 60 * 60 * 1000
const DATE = /^\d{4}-\d{2}-\d{2}$/
const UTC = { Prefer: 'outlook.timezone="UTC"' }

const SELECT = 'id,subject,start,end,isAllDay,isCancelled,location,attendees'

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

/** `GET` the default calendar's events between `from` and `to`, recurring ones expanded (`calendarView`). */
export function eventsRequest({ from, to } = {}) {
  const start = toMs(from)
  const end = toMs(to)
  if (start === undefined) throw new ArgumentError('`from` is not a date or time Alexia understands.')
  if (end === undefined) throw new ArgumentError('`to` is not a date or time Alexia understands.')
  if (end <= start) throw new ArgumentError('`to` has to be after `from`.')
  const url = new URL(`${GRAPH}/me/calendarView`)
  url.search = new URLSearchParams({
    startDateTime: new Date(start).toISOString(),
    endDateTime: new Date(end).toISOString(),
    $select: SELECT,
    $orderby: 'start/dateTime',
    $top: '100',
  }).toString()
  return { url: url.toString(), method: 'GET', headers: UTC }
}

/**
 * The next page of a Graph list, or `undefined`. Only a link back to Graph itself is followed:
 * the bearer token never goes anywhere else, whatever a response says.
 */
export function nextRequest(json, headers = UTC) {
  const link = json?.['@odata.nextLink']
  if (typeof link !== 'string') return undefined
  let url
  try {
    url = new URL(link)
  } catch {
    return undefined
  }
  if (url.origin !== new URL(GRAPH).origin || !url.pathname.startsWith('/v1.0/')) return undefined
  return { url: url.toString(), method: 'GET', headers }
}

/**
 * A Graph `dateTimeTimeZone` as an ISO instant. Asked for in UTC, Graph writes
 * `2030-03-04T08:00:00.0000000` with `timeZone: "UTC"` — no offset, seven decimals — which
 * this turns into `2030-03-04T08:00:00Z`. A time that already carries an offset is kept.
 */
export function instantOf(dtz) {
  const raw = typeof dtz?.dateTime === 'string' ? dtz.dateTime.trim() : ''
  if (raw === '') return undefined
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return raw
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?$/.exec(raw)
  if (!m) return undefined
  const zone = String(dtz?.timeZone ?? 'UTC').trim()
  if (zone !== '' && !/^(?:UTC|Etc\/UTC|GMT|Coordinated Universal Time)$/i.test(zone)) return undefined
  const ms = m[2] && /[1-9]/.test(m[2].slice(0, 3)) ? `.${m[2].slice(0, 3)}` : ''
  return `${m[1].length === 16 ? `${m[1]}:00` : m[1]}${ms}Z`
}

/** The day of a Graph `dateTimeTimeZone`: its `YYYY-MM-DD`. */
const dayOf = (dtz) => {
  const raw = typeof dtz?.dateTime === 'string' ? dtz.dateTime.trim() : ''
  return DATE.test(raw.slice(0, 10)) ? raw.slice(0, 10) : undefined
}

/** One Graph event in the INTERFACES shape. `undefined` for a cancelled or unreadable one. */
export function mapEvent(ev, calendar = CALENDAR) {
  if (!ev || typeof ev !== 'object' || ev.isCancelled === true || typeof ev.id !== 'string') return undefined
  const allDay = ev.isAllDay === true
  const start = allDay ? dayOf(ev.start) : instantOf(ev.start)
  if (start === undefined) return undefined
  const end = (allDay ? dayOf(ev.end) : instantOf(ev.end)) ?? start
  const place = typeof ev.location?.displayName === 'string' ? ev.location.displayName.trim() : ''
  return {
    id: ev.id,
    title: typeof ev.subject === 'string' && ev.subject.trim() !== '' ? ev.subject.trim() : '(no title)',
    start,
    end,
    allDay,
    ...(place !== '' && { location: place }),
    attendees: (Array.isArray(ev.attendees) ? ev.attendees : [])
      .map((a) => a?.emailAddress?.address)
      .filter((e) => typeof e === 'string' && e.trim() !== '')
      .map((e) => e.trim()),
    calendar,
  }
}

/** Every event of one `calendarView` page, mapped. */
export const mapEvents = (json, calendar = CALENDAR) =>
  (Array.isArray(json?.value) ? json.value : []).map((ev) => mapEvent(ev, calendar)).filter(Boolean)

/** Pages of events, one list, in start order, each event once. */
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

const nextDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)

/** Graph's `dateTime`: no offset, read with `timeZone: "UTC"`. */
const graphTime = (ms) => new Date(ms).toISOString().slice(0, 23)

const asTime = (value, name) => {
  if (typeof value === 'string' && DATE.test(value.trim())) return { date: value.trim() }
  const ms = toMs(value)
  if (ms === undefined) throw new ArgumentError(`\`${name}\` is not a date or time Alexia understands.`)
  return { ms }
}

/**
 * `POST` a new event to the default calendar. A `YYYY-MM-DD` start makes an all-day event
 * (Graph wants its start and end at midnight, the end the day after the last). A missing
 * `end` is an hour after the start, or the next day for all-day. Graph sends an invitation to
 * every attendee — which is why this capability is open-world and always asks first.
 */
export function createRequest({ title, start, end, location, attendees } = {}) {
  const subject = String(title ?? '').trim()
  if (subject === '') throw new ArgumentError('The event needs a title.')
  const from = asTime(start, 'start')
  const to =
    end === undefined || end === null || end === '' ?
      from.date ? { date: nextDay(from.date) }
      : { ms: from.ms + 60 * 60 * 1000 }
    : asTime(end, 'end')
  if (Boolean(from.date) !== Boolean(to.date)) throw new ArgumentError('`start` and `end` must both be days, or both be times.')
  const allDay = Boolean(from.date)
  const a = allDay ? Date.parse(`${from.date}T00:00:00Z`) : from.ms
  let b = allDay ? Date.parse(`${to.date}T00:00:00Z`) : to.ms
  if (b < a || (b === a && !allDay)) throw new ArgumentError('The end has to be after the start.')
  // The all-day end is exclusive: a one-day event ends the next midnight.
  if (allDay && b === a) b = a + DAY_MS
  const guests = [
    ...new Set(
      (Array.isArray(attendees) ? attendees : typeof attendees === 'string' ? attendees.split(/[\s,;]+/) : [])
        .map((e) => String(e).trim())
        .filter((e) => e.includes('@')),
    ),
  ]
  const where = typeof location === 'string' && location.trim() !== '' ? location.trim() : undefined
  return {
    url: `${GRAPH}/me/events`,
    method: 'POST',
    body: {
      subject,
      start: { dateTime: graphTime(a), timeZone: 'UTC' },
      end: { dateTime: graphTime(b), timeZone: 'UTC' },
      isAllDay: allDay,
      ...(where !== undefined && { location: { displayName: where } }),
      ...(guests.length > 0 && { attendees: guests.map((address) => ({ emailAddress: { address }, type: 'required' })) }),
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
 *   deadline word becomes an item, `dueAt` its start, key `microsoft:event:<id>`. A timed one
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
        key: `microsoft:event:${ev.id}`,
        text: ev.title,
        why: ev.allDay ? `On your calendar ${dayWord}.` : `On your calendar ${dayWord} at ${localTime(at, tz)}.`,
        dueAt: at,
      })
    } else if (!deadline && ev.allDay && ev.start <= today && (today < ev.end || ev.start === today)) {
      // The all-day end is exclusive, so a three-day trip counts on each of its days.
      allDayToday.push(ev.title)
    }
  }
  if (allDayToday.length > 0) {
    items.push({
      key: `microsoft:today:${today}`,
      text: `Today: ${allDayToday.join(', ')}`,
      why: 'All day on your calendar.',
      urgency: 'low',
    })
  }
  return items
}
