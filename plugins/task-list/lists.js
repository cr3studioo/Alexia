// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shape of a task and the questions asked about one: pure, with no wire and no clock.
 *
 * There is deliberately no function here that removes a row. Done is the end of a task; the
 * proposed silent list for `tasks.add` says "never delete", and this plugin keeps to it.
 */

export const DEFAULT_LIST = 'tasks'
export const SHOPPING_LIST = 'shopping'
const DAY_MS = 86_400_000

/** A day, ISO only: `YYYY-MM-DD` and a real calendar date, or `undefined`. "tomorrow" is the brain's job. */
export function day(said) {
  const text = String(said ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined
  const parsed = Date.parse(`${text}T00:00:00Z`)
  return Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== text ? undefined : text
}

/** A list name as stored: trimmed, lower case, at most 60 characters, "tasks" when empty. */
export const listName = (said) => {
  const text = String(said ?? '').trim().toLowerCase().slice(0, 60)
  return text === '' ? DEFAULT_LIST : text
}

const label = (said) => {
  const text = String(said ?? '').trim().slice(0, 80)
  return text === '' ? undefined : text
}

/**
 * Turn what a tool was given into a row to insert, or say why not: `{ row }` or `{ error }`.
 * A `due` that is not an ISO day is refused rather than dropped: a task that quietly lost
 * its day would never be called overdue.
 */
export function newItem({ text, due, list, place, person } = {}, at = Date.now()) {
  const said = String(text ?? '').trim()
  if (said === '') return { error: 'There was nothing to write down.' }
  const given = due !== undefined && due !== null && String(due).trim() !== ''
  const when = given ? day(due) : undefined
  if (given && when === undefined) return { error: `“${String(due)}” is not a day. Use YYYY-MM-DD.` }
  return {
    row: {
      list: listName(list),
      text: said,
      due: when ?? null,
      state: 'open',
      place: label(place) ?? null,
      person: label(person) ?? null,
      at,
    },
  }
}

/** The local date at `now` (epoch ms) for a zone `tz` minutes east of UTC. */
export const localDay = (now, tz = 0) => new Date(now + tz * 60_000).toISOString().slice(0, 10)

/** The instant `YYYY-MM-DD` is `hour`:00 local, for a zone `tz` minutes east of UTC. */
export const atLocal = (date, hour, tz = 0) => Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`) - tz * 60_000

export const isOpen = (row) => row.state === 'open'
const hasDue = (row) => typeof row.due === 'string' && row.due !== ''
export const overdue = (row, today) => isOpen(row) && hasDue(row) && row.due < today

/** One line, as a person reads it. */
export function line(row, today) {
  const when = hasDue(row) ? (overdue(row, today) ? ` — was due ${row.due}` : ` — by ${row.due}`) : ''
  const where = row.place ? ` — at ${String(row.place)}` : ''
  const who = row.person ? ` — when you talk to ${String(row.person)}` : ''
  const list = row.list && row.list !== DEFAULT_LIST ? ` [${String(row.list)}]` : ''
  return `${String(row.text)}${when}${where}${who}${list}`
}

/** Open items with a day on or before `today` plus `days`, oldest day first. */
export const dueWithin = (rows, today, days) => {
  const limit = localDay(Date.parse(`${today}T00:00:00Z`) + days * DAY_MS)
  return rows
    .filter((row) => isOpen(row) && hasDue(row) && row.due <= limit)
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0))
}

export const keyOf = (row) => `tasks:${String(row.rowid)}`

/** The notice items for what has a day: `dueAt` that day 18:00 local, and no urgency (the radar decides). */
export function dueItems(rows, now, tz = 0, horizonDays = 7) {
  const today = localDay(now, tz)
  return dueWithin(rows, today, horizonDays).map((row) => ({
    key: keyOf(row),
    text: line(row, today),
    why: overdue(row, today) ? 'Past its day.' : 'It has a day.',
    dueAt: atLocal(row.due, 18, tz),
  }))
}

const KEY = /^tasks:(\d+)$/

/** The row id inside a `tasks:<rowid>` key, or `undefined` if the key is not ours. */
export const rowidOf = (key) => {
  const found = KEY.exec(String(key ?? ''))
  return found ? Number(found[1]) : undefined
}

/** Mark one open item done. `store` is `{ select, update }` over `items`. Returns whether it changed. */
export async function finish(store, rowid, now = Date.now()) {
  if (!Number.isInteger(rowid)) return false
  const [row] = await store.select('items', { where: { rowid }, limit: 1 })
  if (!row || row.state !== 'open') return false
  await store.update('items', { state: 'done', done_at: now }, { rowid })
  return true
}

/** `notice.done`: closes `tasks:<id>` if the key is ours and the item is still open; nothing else. */
export async function closeByKey(store, key, now) {
  const rowid = rowidOf(key)
  return { closed: rowid === undefined ? false : await finish(store, rowid, now) }
}

/** The names of the lists with how many items are open in each, most open first. */
export function summary(rows) {
  const counts = new Map()
  for (const row of rows) {
    const name = String(row.list ?? DEFAULT_LIST)
    counts.set(name, (counts.get(name) ?? 0) + (isOpen(row) ? 1 : 0))
  }
  return [...counts].map(([name, open]) => ({ name, open })).sort((a, b) => b.open - a.open || a.name.localeCompare(b.name))
}

/** The morning section: today's due and overdue, then person reminders still waiting. Empty if neither. */
export function morning(rows, today) {
  const late = dueWithin(rows, today, 0)
  const people = rows.filter((row) => isOpen(row) && row.person && !late.includes(row))
  const lines = [...late, ...people].map((row) => `- ${line(row, today)}`)
  return lines.length === 0 ? '' : ['Tasks:', ...lines].join('\n')
}

/** The weekly section: the week's due ones and how long the shopping list is. Empty if neither. */
export function weekly(rows, today) {
  const week = dueWithin(rows, today, 7)
  const shopping = rows.filter((row) => isOpen(row) && row.list === SHOPPING_LIST).length
  if (week.length === 0 && shopping === 0) return ''
  return [
    ...(week.length > 0 ? [`Tasks due this week: ${week.length}`, ...week.map((row) => `- ${line(row, today)}`)] : []),
    ...(shopping > 0 ? [`Shopping list: ${shopping} item${shopping === 1 ? '' : 's'}`] : []),
  ].join('\n')
}
