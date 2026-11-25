// SPDX-License-Identifier: AGPL-3.0-only
import { dayStart, freeBlocks, localDay, MIN, offsetAt, parseHM, timed } from './slots.js'

/**
 * The day's plan as text, and the notice items that come from the calendar. Pure.
 * Leave-now uses a fixed travel time: there is no live traffic here, by design.
 */

const pad = (n) => String(n).padStart(2, '0')

/** "09:30" in the owner's zone (`tz` minutes east of UTC). */
export function clock(ms, tz = 0) {
  const d = new Date(ms + offsetAt(tz, ms) * MIN)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Mon 30 Nov" */
export function dayLabel(ms, tz = 0) {
  const d = new Date(ms + offsetAt(tz, ms) * MIN)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

const isoDay = (day) => new Date(day * 86_400_000).toISOString().slice(0, 10)
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
  const today = localDay(o.now, tz)
  const midnight = dayStart(today, tz)
  const day = isoDay(today)
  const allDay = (Array.isArray(events) ? events : []).filter((e) => {
    if (!e?.allDay) return false
    const start = String(e.start ?? '').slice(0, 10)
    const end = String(e.end ?? '').slice(0, 10)
    // Google's all-day end is exclusive; no end, or one that is not after the start, is that one day.
    return end > start ? start <= day && day < end : start === day
  })
  const lines = ['Today:']
  for (const e of allDay) lines.push(`- All day: ${e.title ?? 'Untitled'}`)
  for (const e of within(events, midnight, dayStart(today + 1, tz))) lines.push(eventLine(e, tz))
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
  const today = localDay(o.now, tz)
  const [first] = within(events, dayStart(today + 1, tz), dayStart(today + 2, tz))
  if (!first) return 'Tomorrow: nothing in your calendar.'
  let text = `Tomorrow: first is ${first.title ?? 'Untitled'} at ${clock(first.startMs, tz)}${placeOf(first) ? ` (${placeOf(first)})` : ''}.`
  if (needsTravel(first, o.home)) text += ` Leave by ${clock(first.startMs - (o.travel ?? 30) * MIN, tz)}.`
  return text
}

/** The weekly section: the week ahead, one line per day that has events. */
export function weeklySection(events, o) {
  const tz = o.tz ?? 0
  const first = localDay(o.now, tz)
  const lines = ['The week ahead:']
  for (let d = 0; d < 7; d++) {
    const from = dayStart(first + d, tz)
    const list = within(events, from, dayStart(first + d + 1, tz))
    if (!list.length) continue
    lines.push(`- ${dayLabel(from, tz)}: ${list.map((e) => `${clock(e.startMs, tz)} ${e.title ?? 'Untitled'}`).join('; ')}`)
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
