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

/**
 * How many times a reminder that will not send is tried before it is given up on.
 *
 * **A bound is the whole point, not the number.** Telegram refuses for two very different
 * reasons and they look identical from here: a connection that will be back in a minute, and a
 * chat that is gone for good because the account blocked the bot or deleted it. Retrying the
 * first is right; retrying the second is a row that is due forever, tried every thirty seconds,
 * with every reminder behind it and the morning summary never reached. Three tries is about a
 * minute and a half of a blip, and then the row is dropped with a line in the log — because
 * there is, by construction, nowhere to send *a reminder could not be delivered* to.
 */
export const TRIES = 3

/** An ISO date-time, checked against `now` — unreadable, too far past, or too far ahead. */
export function parseAt(at, now = Date.now()) {
  const ms = Date.parse(String(at ?? ''))
  const nowMs = Number(now)
  if (Number.isNaN(ms)) return { ok: false, why: "that doesn't read as a date and time" }
  if (ms < nowMs - PAST_GRACE_MS) return { ok: false, why: 'that time has already passed' }
  if (ms > nowMs + FUTURE_LIMIT_MS) return { ok: false, why: "that's more than a year away" }
  return { ok: true, at: ms }
}

/**
 * The rows due to fire right now — not yet sent, not given up on, and their time has come —
 * earliest first.
 *
 * The `tries` half is the belt to the clock's braces: a row that has run out of tries is
 * dropped the moment it does, so one should never be seen here. Should is not the same as
 * cannot — a crash between the last failed send and the row being deleted would leave one
 * behind, and a reminder nobody can deliver must not become a reminder nobody can get past.
 */
export function dueNow(rows, now) {
  const nowMs = Number(now)
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => !row.sent && (Number(row.tries) || 0) < TRIES && row.at <= nowMs)
    .sort((a, b) => a.at - b.at)
}

/**
 * Which chat a reminder belongs in.
 *
 * **The one who asked, not the one who spoke last.** The chat is written on the row when the
 * reminder is made, because the home chat is whichever paired account messaged most recently —
 * so with two accounts paired, a reminder set by one could arrive in the other's chat, which is
 * somebody else's private business read out on the wrong phone. `fallback` is for a row written
 * before the column existed, where the home chat is the only guess there is.
 */
export function sendTo(row, fallback) {
  const held = row?.chat_id
  return held === undefined || held === null || held === '' ? fallback : held
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
