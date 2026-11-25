// SPDX-License-Identifier: AGPL-3.0-only

/** A table in memory with the storage calls capture.js makes, `where` operators included. A helper, not a test. */
export function memoryStore() {
  const tables = new Map()
  const kv = new Map()
  let next = 0
  const of = (name) => {
    if (!tables.has(name)) tables.set(name, [])
    return tables.get(name)
  }
  const matches = (row, where = {}) =>
    Object.entries(where).every(([column, test]) => {
      const v = row[column]
      if (test === null || typeof test !== 'object') return v === test
      const [[op, arg]] = Object.entries(test)
      if (op === 'eq') return v === arg
      if (op === 'lt') return v < arg
      if (op === 'lte') return v <= arg
      if (op === 'gt') return v > arg
      if (op === 'gte') return v >= arg
      if (op === 'in') return arg.includes(v)
      throw new Error(`the test store does not know ${op}`)
    })
  return {
    table: of,
    insert: async (table, row) => {
      next += 1
      of(table).push({ rowid: next, ...row })
      return next
    },
    select: async (table, { where, order, limit } = {}) => {
      const rows = of(table).filter((r) => matches(r, where))
      for (const [column, dir] of [...(order ?? [])].reverse()) {
        rows.sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (dir === 'desc' ? -1 : 1))
      }
      return rows.slice(0, limit ?? 1e9).map((r) => ({ ...r }))
    },
    delete: async (table, where) => {
      const rows = of(table)
      const keep = 'all' in where ? [] : rows.filter((r) => !matches(r, where))
      const deleted = rows.length - keep.length
      tables.set(table, keep)
      return deleted
    },
    count: async (table, where) => of(table).filter((r) => matches(r, where)).length,
    get: async (key) => kv.get(key),
    set: async (key, value) => void kv.set(key, value),
    remove: async (key) => void kv.delete(key),
  }
}
