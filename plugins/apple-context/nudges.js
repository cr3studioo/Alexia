// SPDX-License-Identifier: AGPL-3.0-only
// Gentle health nudges for the proactivity engine. Pure: summaries and records in, notice items
// out. Every nudge is Low, worded as an observation, and says nothing when the data is missing
// or older than two days. Numbers only ever go into the text the owner reads; nothing is logged.
import { dateKey, selected, unionSeconds } from './summary.js'

const DAY_MS = 86400000
export const DEFAULTS = { nudge_sleep: true, nudge_activity: true, nudge_heart: true, sleep_hours: 6, rest_days: 5 }
const STALE_DAYS = 2
const HEART_RISE = 10
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const shift = (day, by) => new Date(Date.parse(`${day}T12:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10)
const between = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS)
const fresh = (day, today) => day !== undefined && between(day, today) >= 0 && between(day, today) <= STALE_DAYS
const num = (value, fallback) => (value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback)
const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

/** The settings with their defaults filled in. */
export function options(config = {}) {
  return {
    sleep: flag(config.nudge_sleep, DEFAULTS.nudge_sleep),
    activity: flag(config.nudge_activity, DEFAULTS.nudge_activity),
    heart: flag(config.nudge_heart, DEFAULTS.nudge_heart),
    sleepHours: num(config.sleep_hours, DEFAULTS.sleep_hours),
    restDays: Math.max(1, num(config.rest_days, DEFAULTS.rest_days)),
  }
}

/** "5 h 10": hours as the owner says them. */
export function hm(hours) {
  const minutes = Math.round(hours * 60)
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}

/**
 * Hours slept per night, keyed by the local day the night ended. Raw asleep records are grouped
 * into sessions (a gap over two hours starts a new one), so a night that crosses midnight is one
 * night, not two part-days. Returns [{ day, hours }] oldest first.
 */
export function nights(records, zone, preferred) {
  const asleep = selected(records.filter((r) => r.metric === 'sleep'), preferred)
    .filter((r) => [1, 3, 4, 5].includes(r.value)).sort((a, b) => a.start - b.start)
  const sessions = []
  for (const row of asleep) {
    const last = sessions.at(-1)
    if (!last || row.start - last.end > 2 * 3600000) sessions.push({ end: row.end, intervals: [[row.start, row.end]] })
    else { last.end = Math.max(last.end, row.end); last.intervals.push([row.start, row.end]) }
  }
  const byDay = new Map()
  for (const s of sessions) {
    const day = dateKey(s.end, zone)
    byDay.set(day, (byDay.get(day) ?? 0) + unionSeconds(s.intervals) / 3600)
  }
  return [...byDay].map(([day, hours]) => ({ day, hours })).filter((n) => n.hours > 0).sort((a, b) => a.day.localeCompare(b.day))
}

const metricDays = (days, metric) => days.filter((r) => r.metric === metric && Number.isFinite(r.value))
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length

/** Sleep under the limit on each of the last two nights, the latest being recent. */
function sleepNudge(nightList, o, today) {
  const [a, b] = nightList.slice(-2)
  if (!a || !b || !fresh(b.day, today) || between(a.day, b.day) !== 1) return null
  if (!(a.hours < o.sleepHours && b.hours < o.sleepHours)) return null
  return { key: `health:sleep:${b.day}`, text: `Two short nights: ${hm(a.hours)} and ${hm(b.hours)}.`, why: 'From your sleep data.', urgency: 'low' }
}

/** No workout for `rest_days` days, while other data shows the feed is alive. */
function activityNudge(days, o, today) {
  const seen = days.map((r) => r.day).sort().at(-1)
  const last = metricDays(days, 'workout').filter((r) => r.day <= today).map((r) => r.day).sort().at(-1)
  if (!last || !fresh(seen, today) || between(last, today) < o.restDays) return null
  const when = WEEKDAYS[new Date(`${last}T12:00:00Z`).getUTCDay()]
  const text = between(last, today) <= 6 ? `No workout since ${when}.` : `No workout since ${when} ${last}.`
  return { key: `health:activity:${last}`, text, why: 'From your workouts.', urgency: 'low' }
}

const heartFigures = (days, today) => {
  const rows = metricDays(days, 'resting_heart_rate').filter((r) => r.day <= today)
  const latest = rows.map((r) => r.day).sort().at(-1)
  if (!fresh(latest, today)) return null
  const recent = rows.filter((r) => between(r.day, latest) < 3).map((r) => r.value)
  const month = rows.filter((r) => between(r.day, latest) < 30).map((r) => r.value)
  // Too little history says nothing: a baseline from a few days is a guess.
  if (recent.length < 2 || month.length < 10) return null
  return { latest, recent: mean(recent), baseline: median(month) }
}

/** The 3-day mean of resting heart rate well above its 30-day median. */
function heartNudge(days, today) {
  const f = heartFigures(days, today)
  if (!f || f.recent - f.baseline < HEART_RISE) return null
  return { key: `health:heart:${f.latest}`, text: 'Resting heart rate is higher than usual this week.', why: 'Compared with your last 30 days.', urgency: 'low' }
}

/**
 * The notices worth raising now. Input: `today` (local YYYY-MM-DD), `zone`, `config` (the
 * plugin's settings), `records` (raw health rows; only sleep is read), `days` (daily summaries).
 */
export function noticeItems({ today, zone, config, records = [], days = [], preferred }) {
  const o = options(config)
  const out = []
  if (o.sleep) out.push(sleepNudge(nights(records, zone, preferred), o, today))
  if (o.activity) out.push(activityNudge(days, o, today))
  if (o.heart) out.push(heartNudge(days, today))
  return out.filter(Boolean)
}

/** One line per switched-on kind, with the week's numbers. Kinds with no data in the week are left out. */
export function weeklyLines({ today, zone, config, records = [], days = [], preferred }) {
  const o = options(config), from = shift(today, -6), lines = []
  if (o.sleep) {
    const week = nights(records, zone, preferred).filter((n) => n.day >= from && n.day <= today)
    if (week.length) lines.push(`Sleep: ${hm(mean(week.map((n) => n.hours)))} on average over ${week.length} ${week.length === 1 ? 'night' : 'nights'}, ${week.filter((n) => n.hours < o.sleepHours).length} under ${hm(o.sleepHours)}.`)
  }
  if (o.activity && days.some((r) => r.day >= from && r.day <= today)) {
    const count = metricDays(days, 'workout').filter((r) => r.day >= from && r.day <= today).reduce((sum, r) => sum + (r.workouts ?? 1), 0)
    lines.push(`Workouts: ${count} this week.`)
  }
  if (o.heart) {
    const f = heartFigures(days, today)
    if (f) lines.push(`Resting heart rate: ${Math.round(f.recent)} bpm over the last 3 days, ${Math.round(f.baseline)} bpm usual over 30 days.`)
  }
  return lines
}
