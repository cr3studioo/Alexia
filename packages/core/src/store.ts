// SPDX-License-Identifier: AGPL-3.0-only
import { IDENT, type Where } from '@alexia/protocol'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * The database. One file, core owns it, and every plugin gets a namespace it alone can
 * touch — `docs/spec/storage.md` is the contract this implements.
 *
 * The reason it exists this early: *purge means purge* is the transition worth testing
 * hardest (invariant 5), and a purge cannot be proved against storage that does not exist.
 *
 * ponytail: no keychain yet. M1-3 adds it, and until it does nothing writes a secret here.
 */

/**
 * The platform's per-user application data directory — never beside the executable, so an
 * update or a reinstall cannot take someone's history with it. On Windows that is the local
 * one rather than the roaming one: a roaming profile syncing a live SQLite file is a
 * corrupted database waiting for a slow network.
 */
export function dataDir(): string {
  const home = homedir()
  const base =
    process.platform === 'win32' ? (process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'))
    : process.platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : (process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'))
  return join(base, 'Alexia')
}

/**
 * Forward-only. Append, never edit: a migration that has already run on someone's machine is
 * history, and editing one means two databases with the same version and different schemas.
 * The index in this array is the version, so nothing is ever removed either.
 */
const MIGRATIONS: string[] = [
  // 1 — the two tables core owns for everyone. Per-plugin tables are not here: they are
  // created on first insert and dropped by purge, which is what storage.md promises.
  `CREATE TABLE kv (ns TEXT, key TEXT, value TEXT, PRIMARY KEY (ns, key));
   CREATE TABLE settings (plugin TEXT, key TEXT, value TEXT, PRIMARY KEY (plugin, key));`,
]

/** What SQLite actually stores. `encode` turns everything else into one of these. */
type Value = string | number | null
type Row = Record<string, unknown>

/** Every identifier that reaches SQL passes through here. Nothing is ever concatenated. */
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`not a usable name: ${name}`)
  return name
}

/** `p_<namespace>_<table>`. The plugin says `transcripts` and never learns about the prefix. */
const physical = (ns: string, table: string): string => `p_${ident(ns)}_${ident(table)}`

/** Objects and arrays are stored as JSON text, and come back as text. storage.md says so. */
function encode(value: unknown): Value {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' || typeof value === 'number') return value
  return String(value)
}

const columnType = (value: unknown): string =>
  typeof value === 'number' ? (Number.isInteger(value) ? 'INTEGER' : 'REAL')
  : typeof value === 'boolean' ? 'INTEGER'
  : 'TEXT'

interface Clause {
  sql: string
  params: Value[]
}

/**
 * The `where` grammar, compiled. Keys are columns, values a literal (equals) or exactly one
 * operator; multiple keys are AND. No OR, no nesting, no joins — and every value is bound.
 */
function where(clause: Where | undefined): Clause {
  const parts: string[] = []
  const params: Value[] = []
  for (const [column, condition] of Object.entries(clause ?? {})) {
    const c = ident(column)
    if (condition === null || typeof condition !== 'object') {
      parts.push(`${c} = ?`)
      params.push(encode(condition))
      continue
    }
    const [op, value] = Object.entries(condition)[0] as [string, unknown]
    switch (op) {
      case 'eq':
      case 'ne':
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte': {
        const sql = { eq: '=', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=' }[op]
        parts.push(`${c} ${sql} ?`)
        params.push(encode(value))
        break
      }
      case 'in': {
        const values = value as unknown[]
        parts.push(`${c} IN (${values.map(() => '?').join(', ')})`)
        params.push(...values.map(encode))
        break
      }
      case 'like':
        parts.push(`${c} LIKE ?`)
        params.push(encode(value))
        break
      case 'isNull':
        parts.push(`${c} IS NULL`)
        break
      default:
        throw new Error(`unknown operator: ${op}`)
    }
  }
  return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params }
}

export interface SelectQuery {
  where?: Where
  order?: [string, 'asc' | 'desc'][]
  limit?: number
  offset?: number
}

export class Store {
  readonly #db: DatabaseSync

  /**
   * `path` is a file, `:memory:`, or nothing — which means the real one, in the data
   * directory. Core decides where; a plugin never learns the path.
   */
  constructor(path: string = join(dataDir(), 'alexia.db')) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#migrate()
  }

  /**
   * Every migration this database has not run yet, each in its own transaction with the
   * version it sets. A database written by a newer Alexia is refused rather than opened: an
   * older build cannot know what a newer one added, and guessing costs someone their history.
   */
  #migrate(): void {
    const { user_version: at } = this.#db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    if (at > MIGRATIONS.length) {
      throw new Error(
        `this database was written by a newer Alexia (schema ${at}, this build knows ${MIGRATIONS.length})`,
      )
    }
    MIGRATIONS.slice(at).forEach((sql, i) => {
      this.transaction(() => {
        this.#db.exec(sql)
        // A pragma value cannot be bound. This one is an array index, not anybody's input.
        this.#db.exec(`PRAGMA user_version = ${at + i + 1}`)
      })
    })
  }

  /**
   * `node:sqlite` has no transaction helper, so this is it: run `fn`, commit, roll back if it
   * throws. Not nestable — SQLite refuses a `BEGIN` inside a `BEGIN`, loudly, which is the
   * failure mode to want.
   *
   * ponytail: no savepoints. Add them the day two writers genuinely have to compose.
   */
  transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN')
    try {
      const result = fn()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.#db.close()
  }

  /**
   * The table, and every column this row needs. A table starts as nothing but its rowid and
   * grows a column the first time a key appears — no migrations, and no schema block in the
   * manifest (storage.md).
   */
  #ensure(ns: string, table: string, row: Row): string {
    const name = physical(ns, table)
    this.#db.exec(`CREATE TABLE IF NOT EXISTS ${name} (rowid INTEGER PRIMARY KEY)`)
    const existing = new Set(
      this.#db.prepare(`PRAGMA table_info(${name})`).all().map((c) => String(c.name)),
    )
    for (const [key, value] of Object.entries(row)) {
      if (!existing.has(key)) {
        this.#db.exec(`ALTER TABLE ${name} ADD COLUMN ${ident(key)} ${columnType(value)}`)
      }
    }
    return name
  }

  /** Created empty at enable, so a plugin that has never run still has its namespace. */
  create(ns: string, tables: string[] = []): void {
    for (const table of tables) this.#ensure(ns, table, {})
  }

  insert(ns: string, table: string, row: Row): number {
    const name = this.#ensure(ns, table, row)
    const keys = Object.keys(row).map(ident)
    if (keys.length === 0) throw new Error('nothing to insert')
    const statement = this.#db.prepare(
      `INSERT INTO ${name} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    )
    return Number(statement.run(...Object.values(row).map(encode)).lastInsertRowid)
  }

  select(ns: string, table: string, query: SelectQuery = {}): Row[] {
    const clause = where(query.where)
    const order = (query.order ?? [])
      .map(([column, direction]) => `${ident(column)} ${direction === 'desc' ? 'DESC' : 'ASC'}`)
      .join(', ')
    // LIMIT is required for OFFSET in SQLite; -1 means "all of them".
    const limit = query.limit ?? (query.offset === undefined ? undefined : -1)
    const sql =
      `SELECT * FROM ${physical(ns, table)}${clause.sql}` +
      (order ? ` ORDER BY ${order}` : '') +
      (limit === undefined ? '' : ` LIMIT ${Number(limit)}`) +
      (query.offset === undefined ? '' : ` OFFSET ${Number(query.offset)}`)
    return this.#db.prepare(sql).all(...clause.params) as Row[]
  }

  update(ns: string, table: string, set: Row, clause: Where): number {
    const name = this.#ensure(ns, table, set)
    const assignments = Object.keys(set).map((k) => `${ident(k)} = ?`)
    const filter = where(clause)
    const statement = this.#db.prepare(`UPDATE ${name} SET ${assignments.join(', ')}${filter.sql}`)
    return Number(statement.run(...Object.values(set).map(encode), ...filter.params).changes)
  }

  delete(ns: string, table: string, clause: Where | undefined): number {
    const filter = where(clause)
    return Number(
      this.#db.prepare(`DELETE FROM ${physical(ns, table)}${filter.sql}`).run(...filter.params).changes,
    )
  }

  count(ns: string, table: string, clause?: Where): number {
    const filter = where(clause)
    const row = this.#db
      .prepare(`SELECT count(*) AS n FROM ${physical(ns, table)}${filter.sql}`)
      .get(...filter.params) as { n: number }
    return row.n
  }

  kvGet(ns: string, key: string): unknown {
    const row = this.#db.prepare('SELECT value FROM kv WHERE ns = ? AND key = ?').get(ns, key) as
      | { value: string }
      | undefined
    return row === undefined ? undefined : JSON.parse(row.value)
  }

  kvSet(ns: string, key: string, value: unknown): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO kv (ns, key, value) VALUES (?, ?, ?)')
      .run(ns, key, JSON.stringify(value))
  }

  kvDelete(ns: string, key: string): void {
    this.#db.prepare('DELETE FROM kv WHERE ns = ? AND key = ?').run(ns, key)
  }

  /** Every setting the user has actually changed. Defaults live in the manifest, not here. */
  settings(plugin: string): Record<string, unknown> {
    const rows = this.#db
      .prepare('SELECT key, value FROM settings WHERE plugin = ?')
      .all(plugin) as { key: string; value: string }[]
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))
  }

  setSetting(plugin: string, key: string, value: unknown): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO settings (plugin, key, value) VALUES (?, ?, ?)')
      .run(plugin, ident(key), JSON.stringify(value))
  }

  /**
   * Purge means purge. Every table in the namespace, every kv entry, every setting — in one
   * transaction, so a crash halfway cannot leave half a plugin behind. The caller removes
   * the directory afterwards, in that order and for the reason storage.md gives.
   */
  purge(ns: string): void {
    const prefix = `p_${ident(ns)}_`
    const tables = this.#db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'")
      .all(`${prefix.replace(/_/g, '\\_')}%`) as { name: string }[]
    this.transaction(() => {
      for (const { name } of tables) this.#db.exec(`DROP TABLE ${name}`)
      this.#db.prepare('DELETE FROM kv WHERE ns = ?').run(ns)
      this.#db.prepare('DELETE FROM settings WHERE plugin = ?').run(ns)
    })
  }

  /** Every table in the file, for the purge check to diff against. */
  tables(): string[] {
    return this.#db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => String(r.name))
  }
}
