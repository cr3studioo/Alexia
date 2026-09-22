// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reminders pushed to the phone (#9), and the morning summary's own sense of "once a day" —
 * pure helpers, deliberately kept apart from the storage table and the 30-second interval
 * that use them, so the two ways this can go wrong (a reminder fired at the wrong time, a
 * summary sent twice in a day or never) are checked without a database or a real clock.
 *
 * **`at` is the user's local time, and the model is the one resolving "at 5pm" into it** —
 * this file only validates the ISO string that comes back: unreadable, already past by more
 * than a minute (a model's own delay in calling the tool should not itself reject "in one
 * minute"), or so far out that it is almost certainly a mistake rather than a plan.
 *
 * **A reminder that was due while the machine was off is still sent, just late, and says so**
 * — `dueNow` does not care how late `at` is, and `reminderText` is what adds the confession,
 * because a reminder that quietly arrives an hour late is a reminder that looks like it fired
 * on time and did not.
 *
 * **The morning summary tracks the last calendar day it ran, in local time, not a timestamp**
 * — `morningDue` is true once, at or after `HH:MM`, and false again the moment `dayKey`
 * changes underneath it, which is what makes "once a day" survive the plugin being restarted
 * at 8:31 having already sent the 8:30 summary.
 */

/** More than this far in the past, "in five minutes" is not a typo, it is not going to happen. */
const PAST_GRACE_MS = 60 * 1000

/** More than this far out, `at` is almost certainly a model's mistake, not a plan. */
const FUTURE_LIMIT_MS = 366 * 24 * 60 * 60 * 1000

/** More than this late, a reminder says so rather than arriving as if it were on time. */
const LATE_AFTER_MS = 2 * 60 * 1000

/** An ISO date-time, checked against `now` — unreadable, too far past, or too far ahead. */
export function parseAt(at, now = Date.now()) {
  const ms = Date.parse(String(at ?? ''))
  const nowMs = Number(now)
  if (Number.isNaN(ms)) return { ok: false, why: "that doesn't read as a date and time" }
  if (ms < nowMs - PAST_GRACE_MS) return { ok: false, why: 'that time has already passed' }
  if (ms > nowMs + FUTURE_LIMIT_MS) return { ok: false, why: "that's more than a year away" }
  return { ok: true, at: ms }
}

/** The rows due to fire right now — not yet sent, and their time has come — earliest first. */
export function dueNow(rows, now) {
  const nowMs = Number(now)
  return (Array.isArray(rows) ? rows : []).filter((row) => !row.sent && row.at <= nowMs).sort((a, b) => a.at - b.at)
}

/** What a due reminder says — plain, unless it is arriving late enough to need saying so. */
export function reminderText(row, now) {
  const late = Number(now) - row.at > LATE_AFTER_MS
  return late ? `⏰ ${row.text} (was due ${new Date(row.at).toLocaleString()})` : `⏰ ${row.text}`
}

/** The local calendar day a moment falls on, as `setting.morning_summary` compares against. */
export function dayKey(ms) {
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** `'8:30'` or `'08:30'` → `{ h, m }`, or `undefined` for anything that is not a real time. */
export function parseHHMM(s) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim())
  if (!match) return undefined
  const h = Number(match[1])
  const m = Number(match[2])
  if (h < 0 || h > 23 || m < 0 || m > 59) return undefined
  return { h, m }
}

/** Whether the morning summary should fire now — the time has come, and it has not fired today. */
export function morningDue(hhmm, lastDay, now) {
  const time = parseHHMM(hhmm)
  if (!time) return false
  const nowMs = Number(now)
  const target = new Date(nowMs)
  target.setHours(time.h, time.m, 0, 0)
  if (nowMs < target.getTime()) return false
  return lastDay !== dayKey(nowMs)
}
