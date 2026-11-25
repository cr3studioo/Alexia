// SPDX-License-Identifier: AGPL-3.0-only

/** Tables in memory with the three calls the tools make, rowids counted per table. A helper, not a test. */
export function memoryStore() {
  const tables = new Map()
  const of = (name) => {
    if (!tables.has(name)) tables.set(name, [])
    return tables.get(name)
  }
  return {
    // Every row of every table, for a test that reaches in.
    get rows() {
      return [...tables.values()].flat()
    },
    table: of,
    insert: async (table, row) => {
      const rows = of(table)
      rows.push({ rowid: rows.length + 1, ...row })
      return rows.length
    },
    select: async (table, { where, limit } = {}) =>
      of(table).filter((r) => !where || Object.entries(where).every(([k, v]) => r[k] === v)).slice(0, limit ?? 1e6),
    update: async (table, set, where) => {
      for (const r of of(table).filter((x) => x.rowid === where.rowid)) Object.assign(r, set)
    },
  }
}
