// SPDX-License-Identifier: AGPL-3.0-only
import { DAY, freeBlocks, localMidnight, MIN, parseHM, timed } from './slots.js'

/**
 * The day's plan as text, and the notice items that come from the calendar. Pure.
 * Leave-now uses a fixed travel time: there is no live traffic here, by design.
 */

const pad = (n) => String(n).padStart(2, '0')

/** "09:30" in the owner's zone (`tz` minutes east of UTC). */
export function clock(ms, tz = 0) {
  const d = new Date(ms + tz * MIN)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Mon 30 Nov" */
export function dayLabel(ms, tz = 0) {
  const d = new Date(ms + tz * MIN)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

const isoDay = (ms, tz) => new Date(ms + tz * MIN).toISOString().slice(0, 10)
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()

/** Does this event have a place that needs travel? Not when there is none, or it is "home". */
export function needsTravel(ev, home) {
  const place = String(ev.location ?? '').trim()
  if (place === '') return false
  const h = String(home ?? '').trim()
  return !(h !== '' && same(place, h))
}

const placeOf = (ev) => String(ev.location ?? '').trim()
const eventLine = (ev, tz) => `- ${clock(ev.startMs, tz)} ${ev.title ?? 'Untitled'}${placeOf(ev) ? ` (${placeOf(ev)})` : ''}`
const span = (b, tz) => `${clock(b.start, tz)}–${clock(b.end, tz)}`

/** Timed events starting inside `[from, to)`. */
const within = (events, from, to) => timed(events).filter((e) => e.startMs >= from && e.startMs < to)

/** The morning section: "Today:", one line per event, then free blocks over an hour. */
export function morningSection(events, o) {
  const tz = o.tz ?? 0
  const midnight = localMidnight(o.now, tz)
  const day = isoDay(midnight, tz)
  const allDay = (Array.isArray(events) ? events : []).filter(
    (e) => e?.allDay && String(e.start ?? '').slice(0, 10) <= day && day < String(e.end ?? e.start).slice(0, 10),
  )
  const lines = ['Today:']
  for (const e of allDay) lines.push(`- All day: ${e.title ?? 'Untitled'}`)
  for (const e of within(events, midnight, midnight + DAY)) lines.push(eventLine(e, tz))
  if (lines.length === 1) lines.push('- Nothing in your calendar.')
  const from = Math.max(midnight + parseHM(o.dayStarts, 480) * MIN, o.now)
  const to = midnight + parseHM(o.dayEnds, 1320) * MIN
  const free = to > from ? freeBlocks(events, from, to).filter((b) => b.end - b.start > 60 * MIN) : []
  if (free.length) lines.push(`Free: ${free.map((b) => span(b, tz)).join(', ')}`)
  return lines.join('\n')
}

/** The evening section: tomorrow's first event and when to leave for it. */
export function eveningSection(events, o) {
  const tz = o.tz ?? 0
  const tomorrow = localMidnight(o.now, tz) + DAY
  const [first] = within(events, tomorrow, tomorrow + DAY)
  if (!first) return 'Tomorrow: nothing in your calendar.'
  let text = `Tomorrow: first is ${first.title ?? 'Untitled'} at ${clock(first.startMs, tz)}${placeOf(first) ? ` (${placeOf(first)})` : ''}.`
  if (needsTravel(first, o.home)) text += ` Leave by ${clock(first.startMs - (o.travel ?? 30) * MIN, tz)}.`
  return text
}

/** The weekly section: the week ahead, one line per day that has events. */
export function weeklySection(events, o) {
  const tz = o.tz ?? 0
  const first = localMidnight(o.now, tz)
  const lines = ['The week ahead:']
  for (let d = 0; d < 7; d++) {
    const list = within(events, first + d * DAY, first + (d + 1) * DAY)
    if (!list.length) continue
    lines.push(`- ${dayLabel(first + d * DAY, tz)}: ${list.map((e) => `${clock(e.startMs, tz)} ${e.title ?? 'Untitled'}`).join('; ')}`)
  }
  if (lines.length === 1) lines.push('- Nothing in your calendar.')
  return lines.join('\n')
}

/** Leave-now items: events with a place away from home, due `travel` minutes before they start. */
export function leaveItems(events, o) {
  const tz = o.tz ?? 0
  const travel = o.travel ?? 30
  const out = []
  for (const ev of timed(events)) {
    if (ev.startMs <= o.now || !needsTravel(ev, o.home) || !ev.id) continue
    const dueAt = ev.startMs - travel * MIN
    out.push({
      key: `planner:leave:${ev.id}`,
      text: `Time to leave for ${ev.title ?? 'your event'} at ${clock(ev.startMs, tz)} (${placeOf(ev)}).`,
      why: `Travel is set to ${travel} minutes; no live traffic is used.`,
      urgency: dueAt - o.now <= 30 * MIN ? 'high' : 'normal',
      dueAt,
    })
  }
  return out
}

/** Meeting-prep items for events with attendees, not before `prep` minutes ahead. `prepText` is `{[id]: string}`. */
export function prepItems(events, o, prepText = {}) {
  const tz = o.tz ?? 0
  const prep = o.prep ?? 60
  const out = []
  for (const ev of timed(events)) {
    const n = Array.isArray(ev.attendees) ? ev.attendees.length : 0
    if (ev.startMs <= o.now || n === 0 || !ev.id) continue
    out.push({
      key: `planner:prep:${ev.id}`,
      text: `${ev.title ?? 'Your meeting'} at ${clock(ev.startMs, tz)}: ${n} ${n === 1 ? 'person' : 'people'}, I've gathered what I know.`,
      why: prepText[ev.id] || 'Nothing else is known about it yet.',
      urgency: 'low',
      notBefore: ev.startMs - prep * MIN,
    })
  }
  return out
}
