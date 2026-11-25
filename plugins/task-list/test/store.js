// SPDX-License-Identifier: AGPL-3.0-only

/** An `items` table in memory with the three calls the tools make. A helper, not a test. */
export function memoryStore() {
  const rows = []
  return {
    rows,
    insert: async (_table, row) => {
      rows.push({ rowid: rows.length + 1, ...row })
      return rows.length
    },
    select: async (_table, { where, limit } = {}) =>
      rows.filter((r) => !where || Object.entries(where).every(([k, v]) => r[k] === v)).slice(0, limit ?? 1e6),
    update: async (_table, set, where) => {
      for (const r of rows.filter((x) => x.rowid === where.rowid)) Object.assign(r, set)
    },
  }
}
