// SPDX-License-Identifier: AGPL-3.0-only
import {
  closeByKey, dueItems, finish, line, localDay, morning, newItem, summary, weekly, isOpen, listName,
} from './lists.js'
import { PERSON_WINDOW_MS, mentionedSince, personFires, placeEvent, placeFires } from './triggers.js'

/**
 * The tools, over what they are handed: storage, a way to call a capability, and a clock.
 * Kept apart from `index.js` so every one of them runs in a test without a wire.
 */

const CALL_LIMIT_MS = 5_000
const say = (text, structuredContent) => ({ content: [{ type: 'text', text }], ...(structuredContent && { structuredContent }) })
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] })
const num = (value, fallback) => (value !== undefined && value !== null && Number.isFinite(Number(value)) ? Number(value) : fallback)

export function createTasks({ storage, capability, now = () => Date.now(), tz = () => 0 }) {
  const all = () => storage.select('items', { order: [['at', 'desc']], limit: 5000 })

  /** An optional capability, bounded: a missing or slow provider is `undefined`, never an error. */
  const optional = async (cap, args) => {
    let timer
    try {
      return await Promise.race([
        capability(cap, args),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), CALL_LIMIT_MS)
          timer.unref?.()
        }),
      ])
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  async function add(args) {
    const made = newItem(args, now())
    if (made.error) return fail(made.error)
    const id = await storage.insert('items', made.row)
    return say(`Written down: ${made.row.text}`, { id: String(id) })
  }

  return {
    add,

    async done({ id } = {}) {
      const rowid = Number(id)
      const [row] = Number.isInteger(rowid) ? await storage.select('items', { where: { rowid }, limit: 1 }) : []
      if (!row) return fail('There is no task with that id.')
      if (row.state !== 'open') return say('That one is already done.')
      await finish(storage, rowid, now())
      return say(`Done: ${String(row.text)}`)
    },

    async tasks({ list, state } = {}) {
      const wanted = state === 'done' || state === 'all' ? state : 'open'
      const rows = (await all()).filter(
        (row) => (list === undefined || String(row.list) === listName(list)) && (wanted === 'all' || row.state === wanted),
      )
      const today = localDay(now(), tz(now()))
      const out = rows.map((row) => ({
        id: String(row.rowid), list: String(row.list), text: String(row.text), due: row.due ?? null,
        state: String(row.state), place: row.place ?? null, person: row.person ?? null,
      }))
      return say(rows.length === 0 ? 'Nothing here.' : rows.map((row) => `- #${String(row.rowid)} ${line(row, today)}`).join('\n'), { items: out })
    },

    async lists() {
      const found = summary(await all())
      return say(found.length === 0 ? 'No lists yet.' : found.map((one) => `- ${one.name}: ${one.open} open`).join('\n'), { lists: found })
    },

    /**
     * `notice.items`. Items with a day; items for a place the owner just arrived at; items for
     * a person who was just named. Each optional source is asked only if some item needs it,
     * and one that is missing means those items wait.
     */
    async noticeItems({ now: at, horizon_days, tz_offset_min } = {}) {
      const moment = num(at, now())
      const rows = (await all()).filter(isOpen)
      const found = dueItems(rows, moment, num(tz_offset_min, 0), num(horizon_days, 7))
      const taken = new Set(found.map((item) => item.key))

      const places = rows.filter((row) => row.place)
      if (places.length > 0) {
        const event = placeEvent(await optional('context.current', {}))
        for (const item of placeFires(places, event, moment)) {
          if (taken.has(item.key)) continue
          taken.add(item.key)
          found.push(item)
        }
      }

      const people = rows.filter((row) => row.person)
      if (people.length > 0) {
        const named = []
        const asked = new Set()
        for (const row of people) {
          const name = String(row.person).trim().toLowerCase()
          if (asked.has(name)) continue
          asked.add(name)
          const since = moment - PERSON_WINDOW_MS
          if (mentionedSince(await optional('memory.recall', { about: String(row.person), since }), since)) named.push(name)
        }
        for (const item of personFires(people, named)) {
          if (taken.has(item.key)) continue
          taken.add(item.key)
          found.push(item)
        }
      }
      return say(found.map((item) => `- ${item.text}`).join('\n'), { items: found })
    },

    async noticeDone({ key } = {}) {
      const result = await closeByKey(storage, key, now())
      return say(result.closed ? 'Closed.' : 'Nothing to close.', result)
    },

    async briefSection({ kind, now: at, tz_offset_min } = {}) {
      const today = localDay(num(at, now()), num(tz_offset_min, 0))
      const rows = await all()
      const text = kind === 'morning' ? morning(rows, today) : kind === 'weekly' ? weekly(rows, today) : ''
      return say(text, { title: 'Tasks', text })
    },
  }
}
