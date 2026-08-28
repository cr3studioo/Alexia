// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { D1Database, D1Statement } from '../src/d1.js'

/**
 * D1, standing in as `node:sqlite`.
 *
 * D1 *is* SQLite over a binding, so the interesting half — the schema, the queries, the
 * conflict clauses — is exactly the same code path. What this cannot test is the network
 * and the deploy, and neither of those is testable anywhere except against the real thing.
 *
 * ponytail: no miniflare. It would run the real Workers runtime and would also be a
 * hundred megabytes of dependency to prove that `SELECT * FROM plugins` selects.
 */
export function sqliteD1(): D1Database {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(join(import.meta.dirname, '..', 'src', 'schema.sql'), 'utf8'))

  const statement = (sql: string, bound: unknown[] = []): D1Statement => ({
    bind: (...values) => statement(sql, values),
    first: async <T>() => (db.prepare(sql).get(...(bound as never[])) as T | undefined) ?? null,
    all: async <T>() => ({ results: db.prepare(sql).all(...(bound as never[])) as T[] }),
    run: async () => {
      db.prepare(sql).run(...(bound as never[]))
      return { success: true }
    },
  })

  return {
    prepare: (sql) => statement(sql),
    exec: async (sql) => db.exec(sql),
  }
}
