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

  // 2 — the conversation. Core's, not any plugin's: deleting the memory plugin makes
  // Alexia forget you across sessions, and must not touch what you are saying right now.
  `CREATE TABLE sessions (
     id INTEGER PRIMARY KEY,
     title TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE messages (
     id INTEGER PRIMARY KEY,
     session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
     role TEXT NOT NULL,
     model TEXT,
     body TEXT NOT NULL,
     at INTEGER NOT NULL
   );
   CREATE INDEX messages_by_session ON messages (session_id, id);`,

  // 3 — the rate-limit ledger (M1-6). Counting what has already been sent is the only way
  // the router can know a free tier is exhausted *before* it sends and collects a 429.
  `CREATE TABLE provider_usage (
     provider TEXT NOT NULL,
     span TEXT NOT NULL,
     bucket INTEGER NOT NULL,
     count INTEGER NOT NULL,
     PRIMARY KEY (provider, span, bucket)
   );`,

  // 4 — what was spent, and by whom (M1-9). Per session, per model and per plugin, because
  // "which plugin is costing me money" is a question with no other way to answer it.
  `CREATE TABLE usage (
     id INTEGER PRIMARY KEY,
     at INTEGER NOT NULL,
     session_id INTEGER,
     plugin TEXT,
     model TEXT NOT NULL,
     provider TEXT NOT NULL,
     tokens_in INTEGER NOT NULL,
     tokens_out INTEGER NOT NULL,
     cost REAL NOT NULL
   );
   CREATE INDEX usage_at ON usage (at);`,

  // 5 — the run a charge belongs to, and the model that was asked for it (M7-2). A session
  // is not a run: ten tasks in one sitting share a `session_id`, so without this the ledger
  // can say what today cost and cannot say what *that* cost, which is the question anybody
  // actually has. `asked` is the router's first choice and `model` is whoever answered —
  // they differ on a 429 fallback, which is exactly when a cost is surprising.
  `ALTER TABLE usage ADD COLUMN run_id TEXT;
   ALTER TABLE usage ADD COLUMN asked TEXT;
   CREATE INDEX usage_by_run ON usage (run_id);`,
]

/**
 * The two windows a free tier is rationed by, and how long each lasts.
 *
 * ponytail: the day is a UTC day, and a provider whose quota resets at some other hour will
 * disagree for a few hours after the boundary. The cost of being wrong is one 429 and a
 * fallback that already exists; the fix, if it ever matters, is a reset hour on the row.
 */
export const SPANS = [
  ['minute', 60_000],
  ['day', 24 * 60 * 60 * 1000],
] as const

/** What SQLite actually stores. `encode` turns everything else into one of these. */
type Value = string | number | null
type Row = Record<string, unknown>

/** Every identifier that reaches SQL passes through here. Nothing is ever concatenated. */
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`not a usable name: ${name}`)
  return name
}

/**
 * A plugin id, as a SQL identifier.
 *
 * An id is `lowercase-with-hyphens` (`ID` in the manifest schema) and an identifier here is
 * `lowercase_with_underscores` (`IDENT`) — so **a plugin whose id contains a hyphen had no
 * table name at all**. One declared storage the schema accepts, `create` threw inside `load`,
 * and it took the whole of `serve()` down before the port was open: the app did not start,
 * and that plugin could not be purged either, because `purge` builds the same prefix.
 *
 * The mapping is one way and cannot collide: an id may not contain an underscore, so no two
 * ids can arrive at the same name. Nothing migrates, because a hyphenated namespace has
 * never successfully written a table.
 */
const namespace = (ns: string): string => ident(ns.replace(/-/g, '_'))

/** `p_<namespace>_<table>`. The plugin says `transcripts` and never learns about the prefix. */
const physical = (ns: string, table: string): string => `p_${namespace(ns)}_${ident(table)}`

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

/**
 * One turn of a conversation, in the shape a provider takes it. `tool` and the call fields
 * are the agent's step trace: the loop (M15) writes them, and core stores them so a reload
 * shows the same steps the user watched happen.
 */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Assistant: what this turn asked to run. */
  calls?: { id: string; name: string; arguments: string }[]
  /** Tool: which of those calls this is the answer to. */
  callId?: string
  /** Which model produced it. Kept per message, so switching models cannot make it lie. */
  model?: string
}

export interface Session {
  id: number
  title: string | null
  createdAt: number
  updatedAt: number
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
    // Off by default in SQLite, and per connection. Deleting a conversation has to take
    // its messages with it, and that is the cascade doing it.
    this.#db.exec('PRAGMA foreign_keys = ON')
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

  /**
   * A declared table nothing has ever been written to.
   *
   * `create` makes it with a `rowid` and no columns, because nothing knows what the columns
   * are until a row arrives — which means **`ORDER BY at` on a fresh install is a crash**,
   * not an empty list. It bit the memory panel on the one path nobody tests: enable the
   * plugin, open the screen before anything has been remembered.
   *
   * Guarded here rather than at the four call sites, and narrowly: a table with no columns
   * has no rows, so reading it, changing it and deleting from it are all *nothing*. A typo
   * in a column name on a table that has rows still fails loudly, which is the half worth
   * keeping.
   */
  #unwritten(ns: string, table: string): boolean {
    const columns = this.#db.prepare(`PRAGMA table_info(${physical(ns, table)})`).all()
    return columns.length <= 1
  }

  select(ns: string, table: string, query: SelectQuery = {}): Row[] {
    if (this.#unwritten(ns, table)) return []
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
    if (this.#unwritten(ns, table)) return 0
    const name = this.#ensure(ns, table, set)
    const assignments = Object.keys(set).map((k) => `${ident(k)} = ?`)
    const filter = where(clause)
    const statement = this.#db.prepare(`UPDATE ${name} SET ${assignments.join(', ')}${filter.sql}`)
    return Number(statement.run(...Object.values(set).map(encode), ...filter.params).changes)
  }

  delete(ns: string, table: string, clause: Where | undefined): number {
    if (this.#unwritten(ns, table)) return 0
    const filter = where(clause)
    return Number(
      this.#db.prepare(`DELETE FROM ${physical(ns, table)}${filter.sql}`).run(...filter.params).changes,
    )
  }

  count(ns: string, table: string, clause?: Where): number {
    if (this.#unwritten(ns, table)) return 0
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
   * A new conversation. The title usually arrives later, from what was actually said.
   */
  createSession(title?: string): number {
    const now = Date.now()
    return Number(
      this.#db
        .prepare('INSERT INTO sessions (title, created_at, updated_at) VALUES (?, ?, ?)')
        .run(title ?? null, now, now).lastInsertRowid,
    )
  }

  /** Newest first, which is the order a list of conversations is read in. */
  sessions(): Session[] {
    return this.#db
      .prepare(
        'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM sessions' +
          ' ORDER BY updated_at DESC, id DESC',
      )
      .all() as unknown as Session[]
  }

  renameSession(id: number, title: string): void {
    this.#db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id)
  }

  /** The messages go with it, by `ON DELETE CASCADE` — hence `foreign_keys` in the constructor. */
  deleteSession(id: number): void {
    this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  /**
   * Append a turn. `role` and `model` are columns because they are what gets asked about;
   * the rest is stored as the provider's own shape, so a new field costs no migration.
   */
  append(sessionId: number, message: Message): number {
    const { role, model, ...rest } = message
    const at = Date.now()
    return this.transaction(() => {
      const { lastInsertRowid } = this.#db
        .prepare('INSERT INTO messages (session_id, role, model, body, at) VALUES (?, ?, ?, ?, ?)')
        .run(sessionId, role, model ?? null, JSON.stringify(rest), at)
      this.#db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(at, sessionId)
      return Number(lastInsertRowid)
    })
  }

  /**
   * The conversation, oldest first — exactly what gets re-sent to whichever model is
   * selected now. Models are stateless and the history is ours, which is the whole reason
   * switching one mid-conversation loses nothing.
   *
   * `limit` keeps the newest N and still returns them in order: the trailing window is the
   * useful one. Trimming the middle intelligently is M15-6, and it belongs to the loop.
   */
  history(sessionId: number, limit?: number): Message[] {
    const rows = this.#db
      .prepare('SELECT role, model, body FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?')
      .all(sessionId, limit ?? -1) as { role: string; model: string | null; body: string }[]
    return rows.reverse().map((row) => ({
      role: row.role as Message['role'],
      ...(row.model !== null && { model: row.model }),
      ...(JSON.parse(row.body) as Omit<Message, 'role' | 'model'>),
    }))
  }

  /** One more request sent to this provider, counted in both windows at once. */
  recordRequest(provider: string, at: number = Date.now()): void {
    this.transaction(() => {
      for (const [span, size] of SPANS) {
        const bucket = Math.floor(at / size)
        this.#db
          .prepare(
            'INSERT INTO provider_usage (provider, span, bucket, count) VALUES (?, ?, ?, 1)' +
              ' ON CONFLICT (provider, span, bucket) DO UPDATE SET count = count + 1',
          )
          .run(provider, span, bucket)
        // Last minute's counter is nobody's business. Pruned here so nothing else has to
        // remember to, and so the table stays the size of the number of providers.
        this.#db
          .prepare('DELETE FROM provider_usage WHERE provider = ? AND span = ? AND bucket < ?')
          .run(provider, span, bucket)
      }
    })
  }

  /** How many requests have gone to this provider inside the current minute, and day. */
  requests(provider: string, at: number = Date.now()): { minute: number; day: number } {
    const count = (span: string, size: number): number => {
      const row = this.#db
        .prepare('SELECT count FROM provider_usage WHERE provider = ? AND span = ? AND bucket = ?')
        .get(provider, span, Math.floor(at / size)) as { count: number } | undefined
      return row?.count ?? 0
    }
    return { minute: count(...SPANS[0]), day: count(...SPANS[1]) }
  }

  /**
   * One answered request, in tokens and in money. No foreign key on the session on
   * purpose: deleting a conversation must not quietly rewrite last month's total.
   */
  recordUsage(row: {
    session?: number
    plugin?: string
    /** The task this was part of (M7-2). Absent for a call that belongs to no run. */
    run?: string
    /** Who answered. */
    model: string
    /** Who the router asked for first. The same as `model` unless something fell back. */
    asked?: string
    provider: string
    tokensIn: number
    tokensOut: number
    cost: number
    at?: number
  }): void {
    this.#db
      .prepare(
        'INSERT INTO usage (at, session_id, plugin, run_id, model, asked, provider, tokens_in, tokens_out, cost)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.at ?? Date.now(),
        row.session ?? null,
        row.plugin ?? null,
        row.run ?? null,
        row.model,
        row.asked ?? null,
        row.provider,
        row.tokensIn,
        row.tokensOut,
        row.cost,
      )
  }

  /**
   * Every charge made for one run, oldest first (M7-2).
   *
   * The join the ledger could not do until it had the id: this is *what did that cost*,
   * answered by lookup rather than by subtracting one running total from another. The old
   * way was a difference across the run, which two overlapping runs — a Telegram task and
   * one at the keyboard — would quietly split between them.
   *
   * An empty list means nothing was recorded against this run, which is a fact the caller
   * says out loud rather than rendering as $0.0000.
   */
  callsIn(run: string): { asked: string | null; model: string; provider: string; cost: number }[] {
    return this.#db
      .prepare(
        'SELECT asked, model, provider, cost FROM usage WHERE run_id = ? ORDER BY id',
      )
      .all(run) as unknown as { asked: string | null; model: string; provider: string; cost: number }[]
  }

  /** What has been spent since `since`, narrowed to one session, plugin or model. */
  spend(since: number, filter: { session?: number; plugin?: string; model?: string } = {}): number {
    const parts = ['at >= ?']
    const params: (string | number)[] = [since]
    for (const [column, value] of [
      ['session_id', filter.session],
      ['plugin', filter.plugin],
      ['model', filter.model],
    ] as const) {
      if (value === undefined) continue
      parts.push(`${column} = ?`)
      params.push(value)
    }
    const row = this.#db
      .prepare(`SELECT total(cost) AS spent FROM usage WHERE ${parts.join(' AND ')}`)
      .get(...params) as { spent: number }
    return row.spent
  }

  /** The same, grouped — which is what the spend panel is. */
  spendBy(field: 'model' | 'plugin' | 'session', since: number): { key: string; cost: number }[] {
    // Not interpolation of anything a caller typed: three names, mapped to three columns.
    const column = { model: 'model', plugin: 'plugin', session: 'session_id' }[field]
    return this.#db
      .prepare(
        `SELECT ${column} AS key, total(cost) AS cost FROM usage WHERE at >= ? AND ${column} IS NOT NULL` +
          ` GROUP BY ${column} ORDER BY cost DESC`,
      )
      .all(since) as unknown as { key: string; cost: number }[]
  }

  /**
   * Tokens and calls per model since a moment — *what have I actually been using*.
   *
   * Separate from {@link spendBy} rather than folded into it, because they answer different
   * questions and one of them has to stay cheap: the spend panel wants money, and money is
   * the wrong axis for a free tier. Every model worth recommending on this machine costs
   * exactly $0.00, and sorting four hundred of them by that tells you nothing. Tokens are
   * what a free model spends, so tokens are what the record has to count.
   */
  usedBy(field: 'model' | 'provider', since: number): { key: string; tokens: number; calls: number }[] {
    // Not interpolation of anything a caller typed: two names, mapped to two columns.
    const column = { model: 'model', provider: 'provider' }[field]
    return this.#db
      .prepare(
        `SELECT ${column} AS key, total(tokens_in + tokens_out) AS tokens, count(*) AS calls FROM usage` +
          ` WHERE at >= ? GROUP BY ${column} ORDER BY tokens DESC`,
      )
      .all(since) as unknown as { key: string; tokens: number; calls: number }[]
  }

  /**
   * Purge means purge. Every table in the namespace, every kv entry, every setting — in one
   * transaction, so a crash halfway cannot leave half a plugin behind. The caller removes
   * the directory afterwards, in that order and for the reason storage.md gives.
   */
  purge(ns: string): void {
    const prefix = `p_${namespace(ns)}_`
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
