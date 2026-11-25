// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shape of a commitment, and the two questions anybody asks about one.
 *
 * Separated from `index.js` so it can be tested without a wire, a host or a process — which
 * is the same trade `plugins/memory` makes with its ranking. There is nothing in here that
 * knows about Alexia.
 */

/** Open until it is one of these. Kept and dropped are both endings, and both are honest. */
export const STATES = ['open', 'kept', 'dropped']

/**
 * A day, from however somebody said it.
 *
 * Deliberately narrow: an ISO date, or nothing. *Next Tuesday* is a thing a model can turn
 * into a date and a thing this plugin has no business guessing at — a ledger that quietly
 * decided which Tuesday you meant would be a ledger that nudges you on the wrong day and
 * cannot say why.
 */
export function day(said) {
  const text = String(said ?? '').trim()
  if (text === '') return undefined
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text)) ? text : undefined
}

/** Past its day and still open. `today` is passed in so this is testable without a clock. */
export const overdue = (row, today) =>
  row.state === 'open' && typeof row.by === 'string' && row.by !== '' && row.by < today

/**
 * **What wants saying this morning**: open, and due today or already past its day
 * (`commitments.due`).
 *
 * Oldest day first, because the one that has waited longest is the one a summary should lead
 * with. A commitment with no day is left out rather than listed every morning forever: it is
 * outstanding, and `promised` says so, but nothing about it is due — and a summary that repeats
 * the same undated line every day is a summary somebody stops reading.
 */
export const due = (rows, today) =>
  rows
    .filter((row) => row.state === 'open' && typeof row.by === 'string' && row.by !== '' && row.by <= today)
    .sort((a, b) => (a.by < b.by ? -1 : a.by > b.by ? 1 : 0))

/**
 * One line, as a person reads it.
 *
 * **Whether you imposed it yourself is on the line**, because it is the difference between
 * being reminded and being nagged — and the predecessor's ledger kept that field for exactly
 * that reason.
 */
export function line(row, today) {
  const when =
    typeof row.by === 'string' && row.by !== '' ? (overdue(row, today) ? ` — was due ${row.by}` : ` — by ${row.by}`) : ''
  const whose = row.mine === 1 || row.mine === true ? 'you said' : 'you were asked'
  const nudged = Number(row.nudges ?? 0)
  const raised = nudged > 0 ? ` (raised ${nudged} time${nudged === 1 ? '' : 's'})` : ''
  return `${String(row.text)}${when} — ${whose}${raised}`
}

/** `● open`, `▲ overdue`, `■ kept`. Only the one that wants looking at is coloured (D67). */
export function mark(row, today) {
  if (row.state === 'kept') return '■ kept'
  if (row.state === 'dropped') return '■ dropped'
  return overdue(row, today) ? '▲ overdue' : '● open'
}

const DAY_MS = 86_400_000

/** A promise with no day is raised again after this long, and not before. */
export const WEEK_MS = 7 * DAY_MS

/** The local date (`YYYY-MM-DD`) at `now` (epoch ms) for a zone `tz` minutes east of UTC. */
export const localDay = (now, tz = 0) => new Date(now + tz * 60_000).toISOString().slice(0, 10)

/** The instant `YYYY-MM-DD` is `hour`:00 local, for a zone `tz` minutes east of UTC. */
export const atLocal = (date, hour, tz = 0) => Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`) - tz * 60_000

const hasDay = (row) => typeof row.by === 'string' && row.by !== ''

/**
 * **What has a day close enough to say something about**: open, with a day that is today,
 * past, or within `days` days of `today` (`YYYY-MM-DD`). Overdue ones are included — they are
 * the ones that most want saying. Oldest day first.
 */
export const soon = (rows, today, days) => {
  const limit = localDay(Date.parse(`${today}T00:00:00Z`) + days * DAY_MS)
  return rows
    .filter((row) => row.state === 'open' && hasDay(row) && row.by <= limit)
    .sort((a, b) => (a.by < b.by ? -1 : a.by > b.by ? 1 : 0))
}

/**
 * **Open with no day, and not raised this week**: `raised_at` empty, or more than seven days
 * before `now` (epoch ms). A promise with no day is outstanding, not due, so it comes up
 * weekly rather than every morning.
 */
export const stale = (rows, now) =>
  rows.filter((row) => {
    if (row.state !== 'open' || hasDay(row)) return false
    const raised = Number(row.raised_at ?? 0)
    return !(raised > 0) || now - raised > WEEK_MS
  })

/** Whether the owner imposed it on themselves — the difference between reminded and nagged. */
const mineOf = (row) => row.mine === 1 || row.mine === true

/**
 * The notice items for these rows, pure. `now` is epoch ms, `tz` minutes east of UTC.
 * A dated promise gets `dueAt` (its day at 17:00 local) and no urgency — the scheduler's
 * radar decides how loudly. An undated one is Low, why "Still open, no day set.".
 */
export function items(rows, now, tz = 0, horizonDays = 7) {
  const today = localDay(now, tz)
  const dated = soon(rows, today, horizonDays).map((row) => ({
    key: `commitments:${String(row.rowid)}`,
    text: line(row, today),
    why: mineOf(row) ? 'You said you would.' : 'You were asked to.',
    dueAt: atLocal(row.by, 17, tz),
  }))
  const undated = stale(rows, now).map((row) => ({
    key: `commitments:${String(row.rowid)}`,
    text: line(row, today),
    why: 'Still open, no day set.',
    urgency: 'low',
  }))
  return [...dated, ...undated]
}

const KEY = /^commitments:(\d+)$/

/** The row id inside a `commitments:<rowid>` key, or `undefined` if the key is not ours. */
export const rowidOf = (key) => {
  const found = KEY.exec(String(key ?? ''))
  return found ? Number(found[1]) : undefined
}

/**
 * **Close the commitment a notice was about**, if the key is ours and it is still open: kept,
 * because the owner said Done. Any other key, a missing row or a closed one changes nothing.
 * `store` is `{ select, update }` over the `promises` table — the plugin's own storage.
 */
export async function closeByKey(store, key) {
  const rowid = rowidOf(key)
  if (rowid === undefined) return { closed: false }
  const [row] = await store.select('promises', { where: { rowid }, limit: 1 })
  if (!row || row.state !== 'open') return { closed: false }
  await store.update('promises', { state: 'kept' }, { rowid })
  return { closed: true }
}

/** The weekly brief's text: "Promises: N open, M overdue" and the overdue lines; empty if none open. */
export function weekly(rows, today) {
  const open = rows.filter((row) => row.state === 'open')
  if (open.length === 0) return ''
  const late = due(open, today).filter((row) => overdue(row, today))
  return [`Promises: ${open.length} open, ${late.length} overdue`, ...late.map((row) => `- ${line(row, today)}`)].join('\n')
}
