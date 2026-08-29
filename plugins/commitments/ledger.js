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
