// SPDX-License-Identifier: AGPL-3.0-only
import { dirname, join, resolve, sep } from 'node:path'

/** A base every test path hangs off: absolute on any machine, and nowhere that exists. */
export const BASE = resolve('/alexia-fake-home')
export const at = (...parts) => join(BASE, ...parts)

/**
 * A file system in memory. `files` maps an absolute path to `{ text | bytes, mtime }`.
 * It counts every `readFile`, because "only what changed is read again" is a claim about reads.
 */
export function fakeFs(files = {}) {
  const table = new Map(Object.entries(files))
  const reads = []
  const isDirOf = (dir) => [...table.keys()].some((path) => path.startsWith(dir + sep))
  return {
    reads,
    set(path, value) {
      table.set(path, value)
    },
    delete(path) {
      table.delete(path)
    },
    async readdir(dir) {
      if (!isDirOf(dir)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      const names = new Map()
      for (const path of table.keys()) {
        if (!path.startsWith(dir)) continue
        const rest = path.slice(dir.length).replace(/^[\\/]+/, '')
        if (rest === '' || path === dir) continue
        const [first, ...more] = rest.split(/[\\/]/)
        if (!names.has(first)) names.set(first, more.length > 0 ? 'dir' : 'file')
        else if (more.length > 0) names.set(first, 'dir')
      }
      return [...names].map(([name, type]) => ({ name, type }))
    },
    async stat(path) {
      const one = table.get(path)
      if (!one) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { size: Buffer.byteLength(one.text ?? ''), mtimeMs: one.mtime ?? 1000 }
    },
    async readFile(path) {
      reads.push(path)
      const one = table.get(path)
      if (!one) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return Buffer.from(one.text ?? '')
    },
    parentOf: dirname,
  }
}

/** A table that behaves like plugin storage for the calls the library makes. */
export function fakeTable() {
  const rows = []
  let next = 1
  const matches = (row, where) => Object.entries(where ?? {}).every(([k, v]) => row[k] === v)
  return {
    rows,
    async select(_table, query = {}) {
      return rows.filter((row) => matches(row, query.where)).map((row) => ({ ...row }))
    },
    async insert(_table, row) {
      rows.push({ rowid: next, ...row })
      next += 1
      return next - 1
    },
    async update(_table, set, where) {
      const hit = rows.filter((row) => matches(row, where))
      for (const row of hit) Object.assign(row, set)
      return hit.length
    },
    async delete(_table, where) {
      let n = 0
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (matches(rows[i], where)) {
          rows.splice(i, 1)
          n += 1
        }
      }
      return n
    },
    async count() {
      return rows.length
    },
  }
}
