// SPDX-License-Identifier: AGPL-3.0-only
import { clock, dayLabel, eveningSection, leaveItems, morningSection, prepItems, weeklySection } from './plan.js'
import { DAY, findSlots, MIN, parseHM } from './slots.js'

/**
 * The planner's behaviour with its dependencies handed in, so a test can give it a fake
 * calendar. `deps`: `capability(name, args)`, `settings()`, `status(text)`, `now()`, `tz()`.
 * Nothing here knows who provides a calendar; it asks for `calendar.events` and takes what comes.
 */

export const NO_CALENDAR = 'No calendar is connected.'
const PREP_LIMIT_MS = 5000

const num = (v, fallback) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback)
const text = (t, extra = {}) => ({ content: [{ type: 'text', text: t }], ...extra })
const fail = (t) => ({ isError: true, content: [{ type: 'text', text: t }] })

/** ISO date-time with the owner's offset: 2026-11-26T09:00:00+01:00. */
export function isoLocal(ms, tz = 0) {
  const sign = tz < 0 ? '-' : '+'
  const a = Math.abs(tz)
  const off = `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`
  return `${new Date(ms + tz * MIN).toISOString().slice(0, 19)}${off}`
}

/** A promise that gives up after `ms` and says nothing, so a slow source never holds up the rest. */
function limited(promise, ms = PREP_LIMIT_MS) {
  let timer
  const quiet = Promise.resolve(promise).catch(() => undefined)
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  return Promise.race([quiet, timeout]).finally(() => clearTimeout(timer))
}

export function createPlanner(deps) {
  let told = false
  const clockNow = () => (deps.now ? deps.now() : Date.now())

  async function config() {
    const s = (await deps.settings()) ?? {}
    return {
      travel: num(s.travel_minutes, 30),
      home: typeof s.home === 'string' ? s.home : '',
      prep: num(s.prep_minutes, 60),
      dayStarts: parseHM(s.day_starts, 480),
      dayEnds: parseHM(s.day_ends, 1320),
    }
  }

  const tzOf = (given) => num(given, deps.tz ? deps.tz() : 0)

  /** The events in `[from, to)`, or `undefined` when nothing answers `calendar.events`. */
  async function events(from, to) {
    let result
    try {
      result = await deps.capability('calendar.events', { from: isoLocal(from, 0), to: isoLocal(to, 0) })
    } catch {
      result = undefined
    }
    const list = result && !result.isError ? result.structuredContent?.events : undefined
    if (!Array.isArray(list)) {
      if (!told) {
        told = true
        await Promise.resolve(deps.status(`▲ ${NO_CALENDAR}`)).catch(() => {})
      }
      return undefined
    }
    if (told) {
      told = false
      await Promise.resolve(deps.status('● Calendar connected')).catch(() => {})
    }
    return list
  }

  /** What is known about one meeting, each source optional and limited to five seconds. */
  async function gather(ev) {
    const people = (Array.isArray(ev.attendees) ? ev.attendees : []).map(String)
    const [known, mail] = await Promise.all([
      limited(deps.capability('memory.recall', { about: [ev.title, ...people].filter(Boolean).join(' ') })),
      limited(deps.capability('mail.list', { query: String(ev.title ?? ''), limit: 3 })),
    ])
    const parts = []
    const recalled = known && !known.isError ? known.content?.map((c) => c.text ?? '').join('\n').trim() : ''
    if (recalled) parts.push(`What I know: ${recalled.slice(0, 600)}`)
    const messages = mail && !mail.isError ? mail.structuredContent?.messages : undefined
    if (Array.isArray(messages) && messages.length) {
      parts.push(`Related mail: ${messages.slice(0, 3).map((m) => `${m.subject ?? '(no subject)'} (${m.from ?? 'unknown'})`).join('; ')}`)
    }
    return parts.join('\n')
  }

  async function briefSection({ kind, now, tz_offset_min } = {}) {
    const at = num(now, clockNow())
    const tz = tzOf(tz_offset_min)
    const cfg = await config()
    const list = await events(at - DAY, at + 8 * DAY)
    let body = ''
    if (list) {
      const o = { now: at, tz, ...cfg }
      body = kind === 'evening' ? eveningSection(list, o) : kind === 'weekly' ? weeklySection(list, o) : kind === 'morning' ? morningSection(list, o) : ''
    }
    return text(body, { structuredContent: { title: 'Plan', text: body } })
  }

  async function noticeItems({ now, horizon_days, tz_offset_min } = {}) {
    const at = num(now, clockNow())
    const tz = tzOf(tz_offset_min)
    const cfg = await config()
    const days = Math.max(1, num(horizon_days, 1))
    const list = await events(at, at + days * DAY + 2 * DAY)
    if (!list) return text('', { structuredContent: { items: [] } })
    const o = { now: at, tz, ...cfg }
    const upcoming = list.filter((e) => Date.parse(e.start) < at + days * DAY)
    const withPeople = upcoming.filter((e) => !e.allDay && Array.isArray(e.attendees) && e.attendees.length > 0 && Date.parse(e.start) > at).slice(0, 5)
    const prep = {}
    await Promise.all(
      withPeople.map(async (ev) => {
        prep[ev.id] = await gather(ev)
      }),
    )
    const items = [...leaveItems(upcoming, o), ...prepItems(upcoming, { ...o, prep: cfg.prep }, prep)]
    return text(items.map((i) => `- ${i.text}`).join('\n'), { structuredContent: { items } })
  }

  async function findTime({ what, minutes, within_days, after, before } = {}) {
    const at = clockNow()
    const tz = tzOf()
    const cfg = await config()
    const days = Math.min(30, Math.max(1, Math.floor(num(within_days, 7))))
    const list = await events(at - DAY, at + (days + 1) * DAY)
    if (!list) return fail(NO_CALENDAR)
    const slots = findSlots(list, { now: at, tz, minutes: num(minutes, 30), withinDays: days, after, before, ...cfg })
    if (slots.length === 0) return text(`No free ${num(minutes, 30)} minutes in the next ${days} days.`, { structuredContent: { slots: [] } })
    const shown = slots.map((s) => ({ start: isoLocal(s.start, tz), end: isoLocal(s.end, tz), label: `${dayLabel(s.start, tz)} ${clock(s.start, tz)}–${clock(s.end, tz)}` }))
    const lead = what ? `Free for ${String(what)}:\n` : 'Free:\n'
    return text(lead + shown.map((s, i) => `${i + 1}. ${s.label}`).join('\n'), { structuredContent: { slots: shown } })
  }

  async function bookSlot({ what, start, minutes } = {}) {
    const title = String(what ?? '').trim()
    const from = Date.parse(String(start ?? ''))
    if (title === '') return fail('What should I put in the calendar?')
    if (!Number.isFinite(from)) return fail('I did not understand that start time. Use one of the slots find_time gave.')
    const length = Math.max(5, num(minutes, 30))
    let result
    try {
      result = await deps.capability('calendar.create', { title, start: String(start), end: isoLocal(from + length * MIN, tzOfIso(String(start))) })
    } catch {
      return fail(NO_CALENDAR)
    }
    if (result?.isError) return result
    return text(`Put “${title}” in your calendar.`, { structuredContent: { id: result?.structuredContent?.id } })
  }

  return { briefSection, noticeItems, findTime, bookSlot, gather }
}

/** The offset in minutes written at the end of an ISO date-time, or 0 for Z / none. */
export function tzOfIso(value) {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(value)
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0
}
