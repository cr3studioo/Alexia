// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The paperwork checklist, as pure functions: what is open, what the scheduler's radar should
 * hear about, and which `notice.done` key is ours. No wire, no store, no clock.
 */

const PREFIX = 'errands'

/** A day as YYYY-MM-DD, or nothing. A date this does not understand is not guessed at. */
export function day(said) {
  const text = String(said ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined
  const parsed = new Date(`${text}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? undefined : text
}

function parse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return []
  }
}

/** The names of papers to bring or file, as a clean list of short strings. */
export function docsOf(value) {
  const list = typeof value === 'string' ? parse(value) : value
  if (!Array.isArray(list)) return []
  return list.map((one) => String(one ?? '').trim()).filter((one) => one !== '')
}

export const keyOf = (rowid) => `${PREFIX}:${String(rowid)}`

/** The row id a key names, only when the key is ours (`errands:<digits>`). */
export function rowidOf(key) {
  const found = /^errands:(\d+)$/.exec(String(key ?? ''))
  return found ? Number(found[1]) : undefined
}

export const localDay = (now, tz = 0) => new Date(now + tz * 60_000).toISOString().slice(0, 10)
const atLocal = (date, hour, tz) => Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`) - tz * 60_000

const hasDue = (row) => typeof row.due === 'string' && row.due !== ''

/** One line for the checklist. */
export function line(row, today) {
  const docs = docsOf(row.docs)
  const done = row.state === 'done'
  let when = ''
  if (hasDue(row)) when = !done && row.due < today ? `, overdue since ${row.due}` : `, by ${row.due}`
  const bring = docs.length > 0 ? ` (needs: ${docs.join(', ')})` : ''
  return `${String(row.rowid)}. [${done ? 'x' : ' '}] ${String(row.what)}${when}${bring}`
}

/**
 * **What the radar should hear** (`notice.items`): open paperwork that has a day. Undated
 * paperwork is on the list but never raised: nothing about it is due.
 */
export function items(rows, now, tz = 0) {
  return rows
    .filter((row) => row.state === 'open' && hasDue(row))
    .sort((a, b) => String(a.due).localeCompare(String(b.due)))
    .map((row) => {
      const docs = docsOf(row.docs)
      return {
        key: keyOf(row.rowid),
        text: `${String(row.what)}, by ${String(row.due)}`,
        why: docs.length > 0 ? `Paperwork with a deadline; bring ${docs.join(', ')}.` : 'Paperwork with a deadline.',
        dueAt: atLocal(row.due, 17, tz),
      }
    })
}

/** `notice.done`: close an open item whose key is ours, and nothing else. */
export async function closeByKey(store, key) {
  const rowid = rowidOf(key)
  if (rowid === undefined) return { closed: false }
  const [row] = await store.select('items', { where: { rowid }, limit: 1 })
  if (!row || row.state !== 'open') return { closed: false }
  await store.update('items', { state: 'done' }, { rowid })
  return { closed: true }
}
