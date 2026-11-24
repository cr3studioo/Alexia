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
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(value ?? ''))
  if (!m) return fallback
  const h = Number(m[1])
  const min = Number(m[2])
  return min < 60 && h * 60 + min <= 1440 ? h * 60 + min : fallback
}

/** Epoch ms of local midnight for the local day that contains `ms`. `tz` is minutes east of UTC. */
export function localMidnight(ms, tz = 0) {
  return Math.floor((ms + tz * MIN) / DAY) * DAY - tz * MIN
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
  const first = localMidnight(o.now, tz)
  const out = []
  for (let d = 0; d < days && out.length < max; d++) {
    const midnight = first + d * DAY
    const from = Math.max(midnight + after * MIN, roundUp(o.now))
    const to = midnight + before * MIN
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
