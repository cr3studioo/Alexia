// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Free time, from events and the owner's day bounds. Pure: every function takes its clock and
 * its offset from UTC, so none of it depends on where the computer happens to be.
 *
 * All-day events (a birthday, a holiday, "working from home") block nothing: they say what the
 * day is, not when the owner is busy.
 */

export const MIN = 60_000
export const DAY = 86_400_000

/** "08:30" → minutes after midnight, or `fallback` when it is not a time. */
export function parseHM(value, fallback) {
  // Already minutes after midnight (the settings are parsed once, then handed on).
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 1440 ? value : fallback
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(value ?? ''))
  if (!m) return fallback
  const h = Number(m[1])
  const min = Number(m[2])
  return min < 60 && h * 60 + min <= 1440 ? h * 60 + min : fallback
}

/**
 * `tz` is minutes east of UTC: one number, or a function `(epochMs) => minutes` giving the
 * offset in force at that instant. A function lets every day have its own offset, so a week
 * with a daylight-saving change keeps its slots and labels right.
 */
export function offsetAt(tz, ms) {
  const v = typeof tz === 'function' ? tz(ms) : tz
  return Number.isFinite(Number(v)) ? Number(v) : 0
}

/** The instant at which a local wall clock reads `local` (written as if it were UTC). */
export function wallToMs(local, tz = 0) {
  return local - offsetAt(tz, local - offsetAt(tz, local) * MIN) * MIN
}

/** The local calendar day (days since 1970-01-01) that contains `ms`. */
export function localDay(ms, tz = 0) {
  return Math.floor((ms + offsetAt(tz, ms) * MIN) / DAY)
}

/** Epoch ms of the local midnight that starts local day number `day`. */
export function dayStart(day, tz = 0) {
  return wallToMs(day * DAY, tz)
}

/** Epoch ms of local midnight for the local day that contains `ms`. */
export function localMidnight(ms, tz = 0) {
  return dayStart(localDay(ms, tz), tz)
}

/** The timed events with `startMs` / `endMs`, sorted; all-day and unreadable ones dropped. */
export function timed(events) {
  const out = []
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || ev.allDay) continue
    const start = Date.parse(ev.start)
    if (!Number.isFinite(start)) continue
    const end = Date.parse(ev.end)
    out.push({ ...ev, startMs: start, endMs: Number.isFinite(end) && end > start ? end : start })
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}

/** Free blocks `[{start, end}]` inside `[from, to)` once the timed events are taken out. */
export function freeBlocks(events, from, to) {
  const blocks = []
  let cursor = from
  for (const ev of timed(events)) {
    if (ev.endMs <= cursor) continue
    if (ev.startMs >= to) break
    if (ev.startMs > cursor) blocks.push({ start: cursor, end: ev.startMs })
    cursor = Math.max(cursor, ev.endMs)
    if (cursor >= to) break
  }
  if (cursor < to) blocks.push({ start: cursor, end: to })
  return blocks
}

/** Round up to a quarter of an hour, so a proposal reads "10:15" and not "10:07". */
export function roundUp(ms, step = 15 * MIN) {
  return Math.ceil(ms / step) * step
}

/**
 * Up to `max` (3) free slots of `minutes`, earliest first, one per free block.
 * `after` / `before` are "HH:MM" limits on the time of day; `dayStarts` / `dayEnds` bound the day.
 */
export function findSlots(events, o) {
  const tz = o.tz ?? 0
  const minutes = Math.max(5, Number(o.minutes) || 30)
  const days = Math.min(30, Math.max(1, Math.floor(Number(o.withinDays) || 7)))
  const max = Math.min(3, o.max ?? 3)
  const dayStarts = parseHM(o.dayStarts, 8 * 60)
  const dayEnds = parseHM(o.dayEnds, 22 * 60)
  const after = Math.max(dayStarts, parseHM(o.after, dayStarts))
  const before = Math.min(dayEnds, parseHM(o.before, dayEnds))
  const first = localDay(o.now, tz)
  const out = []
  for (let d = 0; d < days && out.length < max; d++) {
    // Each day gets its own offset: 08:00 stays 08:00 on the wall clock after the clocks change.
    const local = (first + d) * DAY
    const from = Math.max(wallToMs(local + after * MIN, tz), roundUp(o.now))
    const to = wallToMs(local + before * MIN, tz)
    if (to <= from) continue
    for (const block of freeBlocks(events, from, to)) {
      const start = roundUp(block.start)
      if (start + minutes * MIN <= block.end) {
        out.push({ start, end: start + minutes * MIN })
        if (out.length >= max) break
      }
    }
  }
  return out
}
