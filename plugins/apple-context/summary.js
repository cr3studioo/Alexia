// SPDX-License-Identifier: AGPL-3.0-only
import { DAY } from './schema.js'
export const dateKey = (at, zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at))
export function unionSeconds(intervals) {
  let total = 0, through = -Infinity
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, end - Math.max(start, through))
    through = Math.max(through, end)
  }
  return total / 1000
}
export function selected(rows, preferred) {
  if (!rows.length) return []
  const sources = [...new Map(rows.map((r) => [r.source, r.rank])).entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
  const chosen = sources.some(([s]) => s === preferred) ? preferred : sources[0][0]
  return rows.filter((r) => r.source === chosen)
}
// Split elapsed intervals at local calendar boundaries, including 23/25-hour days.
export function pieces(start, end, zone) {
  if (start === end) return [[dateKey(start, zone), start, end]]
  const result = []
  let cursor = start
  while (cursor < end) {
    const day = dateKey(cursor, zone)
    let boundary = Math.min(end, cursor + 26 * 3600000)
    if (dateKey(boundary - 1, zone) !== day) {
      let lo = cursor + 1, hi = boundary
      while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (dateKey(mid, zone) === day) lo = mid + 1; else hi = mid }
      boundary = lo
    }
    result.push([day, cursor, boundary]); cursor = boundary
  }
  return result
}
export function daily(rows, zone, preferences = {}) {
  const groups = new Map()
  for (const r of rows) {
    const segments = r.metric === 'workout' ? [[dateKey(r.start, zone), r.start, r.end]] : pieces(r.start, r.end, zone)
    for (const [day, start, end] of segments) {
      const key = `${day}/${r.metric}`
      if (!groups.has(key)) groups.set(key, [])
      const fraction = r.end === r.start ? 1 : (end - start) / (r.end - r.start)
      groups.get(key).push({ ...r, start, end, value: ['steps', 'active_energy', 'exercise_minutes'].includes(r.metric) ? r.value * fraction : r.value })
    }
  }
  return [...groups].map(([key, all]) => {
    const [day, metric] = key.split('/')
    const rows = selected(all, preferences[metric])
    let value
    if (metric === 'sleep') value = unionSeconds(rows.filter((r) => [1, 3, 4, 5].includes(r.value)).map((r) => [r.start, r.end])) / 3600
    else if (['hrv', 'resting_heart_rate'].includes(metric)) value = rows.reduce((sum, r) => sum + r.value, 0) / rows.length
    else value = rows.reduce((sum, r) => sum + r.value, 0)
    return { day, metric, value: Math.round(value * 100) / 100, unit: metric === 'sleep' ? 'h' : rows[0].unit, samples: rows.length, ids: rows.map((r) => r.id), workouts: metric === 'workout' ? rows.length : undefined }
  })
}
export function weekKey(day) {
  const at = new Date(`${day}T12:00:00Z`)
  at.setUTCDate(at.getUTCDate() - (at.getUTCDay() + 6) % 7)
  return at.toISOString().slice(0, 10)
}
export function weekly(days) {
  const groups = new Map()
  for (const row of days) {
    const key = `${weekKey(row.day)}/${row.metric}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return [...groups].map(([key, rows]) => {
    const [week, metric] = key.split('/')
    const total = rows.reduce((sum, r) => sum + r.value, 0)
    return { week, metric, value: Math.round((['sleep', 'hrv', 'resting_heart_rate'].includes(metric) ? total / rows.length : total) * 100) / 100, observedDays: rows.length, unit: rows[0].unit }
  })
}
export function workoutPattern(rows, zone) {
  if (rows.length < 8 || Math.max(...rows.map((r) => r.start)) - Math.min(...rows.map((r) => r.start)) < 28 * DAY) return null
  const buckets = { morning: 0, afternoon: 0, evening: 0, night: 0 }
  for (const row of rows) {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(row.start))
    buckets[hour >= 6 && hour < 12 ? 'morning' : hour < 18 && hour >= 12 ? 'afternoon' : hour >= 18 ? 'evening' : 'night']++
  }
  const [period, count] = Object.entries(buckets).sort((a, b) => b[1] - a[1])[0]
  return count > rows.length / 2 ? { period, count, total: rows.length, from: dateKey(Math.min(...rows.map((r) => r.start)), zone), through: dateKey(Math.max(...rows.map((r) => r.start)), zone) } : null
}

export function latestSleep(rows, now, preferred) {
  const asleep = selected(rows.filter((r) => r.metric === 'sleep' && r.end <= now && r.end >= now - 3 * DAY), preferred)
    .filter((r) => [1, 3, 4, 5].includes(r.value)).sort((a, b) => a.start - b.start)
  const sessions = []
  for (const row of asleep) {
    let session = sessions.at(-1)
    if (!session || row.start - session.end > 2 * 3600000) {
      session = { start: row.start, end: row.end, intervals: [] }; sessions.push(session)
    }
    session.end = Math.max(session.end, row.end); session.intervals.push([row.start, row.end])
  }
  const last = sessions.at(-1)
  return last ? { start: new Date(last.start).toISOString(), end: new Date(last.end).toISOString(), hours: Math.round(unionSeconds(last.intervals) / 36) / 100, label: 'Latest received sleep session; coverage may be incomplete' } : null
}
