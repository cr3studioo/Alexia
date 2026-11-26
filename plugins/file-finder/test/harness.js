// SPDX-License-Identifier: AGPL-3.0-only
// These tests run under `node --test` and under the repo's vitest alike: one `test`, and node's own assert.
const runner = process.env.VITEST ? await import('vitest') : await import('node:test')
export const test = runner.test
export { default as assert } from 'node:assert/strict'

/**
 * The plugin's storage, in memory, behaving as storage.md says where this plugin relies on it:
 * values only (copies, no shared objects), `where` by equality and `lt`, `where` required on update
 * and delete, ordering, and a table nothing was written to answering with nothing.
 */
export function memoryStorage() {
  const tables = { plans: [], moves: [] }
  let rowid = 0
  const rowsOf = (name) => {
    if (!tables[name]) throw new Error(`${name} is not one of this plugin's tables.`)
    return tables[name]
  }
  const matches = (where = {}) => (row) =>
    Object.entries(where).every(([column, wanted]) => {
      if (!(column in row)) throw new Error(`${column} is not a column.`)
      return typeof wanted === 'object' && wanted !== null ? row[column] < wanted.lt : row[column] === wanted
    })
  const required = (where) => {
    if (!where || Object.keys(where).length === 0) throw new Error('a where is required')
  }
  return {
    tables,
    async insert(name, row) {
      rowid += 1
      rowsOf(name).push({ ...structuredClone(row), rowid })
      return rowid
    },
    async select(name, { where, order = [], limit } = {}) {
      const found = rowsOf(name).filter(matches(where))
      for (const [column, dir] of [...order].reverse()) {
        found.sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (dir === 'desc' ? -1 : 1))
      }
      return structuredClone(found.slice(0, limit ?? found.length))
    },
    async update(name, set, where) {
      required(where)
      const found = rowsOf(name).filter(matches(where))
      for (const row of found) Object.assign(row, structuredClone(set))
      return found.length
    },
    async delete(name, where) {
      required(where)
      const gone = new Set(rowsOf(name).filter(matches(where)))
      tables[name] = tables[name].filter((row) => !gone.has(row))
      return gone.size
    },
  }
}
