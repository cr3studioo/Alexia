// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomUUID } from 'node:crypto'
import { MAX_TEXT_BYTES } from './clip.js'

/**
 * The short history of what was copied: text only, local to this computer, never anything the
 * OS marked as a secret. The caller hands in `storage` (the plugin's own table `clips`), so the
 * tests give it an in-memory one.
 */

export const MAX_ROWS = 500
const DAY = 86_400_000

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** 1, 7 or 30; anything else is the default of 7. */
export function keepDays(value) {
  const n = Number(value)
  return n === 1 || n === 7 || n === 30 ? n : 7
}

export function createHistory({ storage, now = Date.now }) {
  /** Delete what is older than the window, then what is past the row cap. */
  async function prune(days) {
    await storage.delete('clips', { at: { lt: now() - keepDays(days) * DAY } })
    const over = (await storage.count('clips')) - MAX_ROWS
    if (over > 0) {
      const oldest = await storage.select('clips', { order: [['at', 'asc']], limit: over })
      const ids = oldest.map((row) => row.id)
      if (ids.length > 0) await storage.delete('clips', { id: { in: ids } })
    }
  }

  return {
    prune,

    /**
     * Remember one copy. Returns whether anything was written. Empty, over-size and
     * all-whitespace text is skipped; a repeat of something already kept just moves it to the top.
     */
    async record(text, days) {
      if (typeof text !== 'string' || text.trim() === '') return false
      if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return false
      const hash = sha256(text)
      const at = now()
      const same = await storage.select('clips', { where: { sha256: hash }, limit: 1 })
      if (same.length > 0) await storage.update('clips', { at }, { sha256: hash })
      else await storage.insert('clips', { id: randomUUID(), text, at, sha256: hash })
      await prune(days)
      return true
    },

    /** Newest first. `query` matches the text, ignoring case. */
    async list({ limit = 20, query } = {}) {
      const rows = await storage.select('clips', { order: [['at', 'desc']], limit: MAX_ROWS })
      const needle = typeof query === 'string' ? query.toLowerCase() : ''
      return rows
        .filter((row) => needle === '' || String(row.text).toLowerCase().includes(needle))
        .slice(0, limit)
        .map((row) => ({ id: String(row.id), text: String(row.text), at: Number(row.at) }))
    },

    async clear() {
      return storage.delete('clips', { all: true })
    },
  }
}
