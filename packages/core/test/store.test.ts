// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { dataDir, Store } from '../src/store.js'

// What storage gained at M1-1 over the M0 minimum: a real file in the platform's own place,
// forward-only migrations, and the transaction helper `node:sqlite` does not ship. The rest
// of the store is exercised end to end by plugins.test.ts and invariant 5.

/** A path whose parent does not exist yet — opening it has to make the directory. */
const tmp = (): string => join(mkdtempSync(join(tmpdir(), 'alexia-store-')), 'data', 'alexia.db')

/** How many migrations this build knows. Every fresh database should be at this version. */
const MIGRATIONS = 5

/** The schema version as SQLite holds it, read without going through `Store`. */
function version(path: string): number {
  const db = new DatabaseSync(path)
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  db.close()
  return row.user_version
}

test('migrations run once, and reopening keeps what was written', () => {
  const path = tmp()
  const first = new Store(path)
  first.kvSet('demo', 'model', 'base')
  first.close()
  expect(version(path)).toBe(MIGRATIONS)

  // Every migration is a plain CREATE TABLE. If one ran twice this line throws.
  const second = new Store(path)
  expect(second.kvGet('demo', 'model')).toBe('base')
  expect(second.tables()).toContain('kv')
  second.close()
  expect(version(path)).toBe(MIGRATIONS)
})

test('a database written by a newer Alexia is refused, not opened', () => {
  const path = tmp()
  new Store(path).close()

  const db = new DatabaseSync(path)
  db.exec('PRAGMA user_version = 99')
  db.close()

  // Forward-only: an older build cannot know what a newer one added, so it stops rather
  // than writing into a shape it does not understand.
  expect(() => new Store(path)).toThrow(/newer Alexia/)
})

test('a transaction that throws leaves nothing behind', () => {
  const store = new Store(':memory:')
  store.insert('demo', 'notes', { text: 'first' })

  expect(() =>
    store.transaction(() => {
      store.insert('demo', 'notes', { text: 'second' })
      throw new Error('halfway')
    }),
  ).toThrow('halfway')

  expect(store.count('demo', 'notes')).toBe(1)
  store.close()
})

test('the data directory is per-user and absolute, never beside the executable', () => {
  const dir = dataDir()
  expect(isAbsolute(dir)).toBe(true)
  expect(dir.endsWith('Alexia')).toBe(true)

  // A checkout is where the executable lives during development. History does not go there.
  // `relative` hands back an absolute path when the two are on different drives — which is
  // the *most* outside-the-repo answer there is, and reading it as "not outside" is how this
  // check failed on a Windows runner that builds on D: and keeps app data on C:.
  const repoRoot = join(import.meta.dirname, '..', '..', '..')
  const step = relative(repoRoot, dir)
  expect(step !== '' && !step.startsWith('..') && !isAbsolute(step)).toBe(false)
})

// M1-2: the conversation. Core owns it, so deleting the memory plugin (M4) forgets you
// across sessions without touching what you are saying right now.

test('a database from the previous schema is carried forward, not rebuilt', () => {
  const path = tmp()
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE kv (ns TEXT, key TEXT, value TEXT, PRIMARY KEY (ns, key))')
  db.exec('CREATE TABLE settings (plugin TEXT, key TEXT, value TEXT, PRIMARY KEY (plugin, key))')
  db.exec(`INSERT INTO kv VALUES ('demo', 'model', '"base"')`)
  db.exec('PRAGMA user_version = 1')
  db.close()

  const store = new Store(path)
  expect(store.kvGet('demo', 'model')).toBe('base') // migration 1 did not run a second time
  expect(store.tables()).toContain('sessions') //     migration 2 did run
  expect(version(path)).toBe(MIGRATIONS)
  store.close()
})

test('a conversation comes back in order, and switching models does not lose it', () => {
  const store = new Store(':memory:')
  const session = store.createSession('First conversation')

  store.append(session, { role: 'user', content: 'sort my downloads' })
  store.append(session, {
    role: 'assistant',
    content: '',
    model: 'qwen3:8b',
    calls: [{ id: 'c1', name: 'fs.list', arguments: '{"path":"Downloads"}' }],
  })
  store.append(session, { role: 'tool', content: '340 files', callId: 'c1' })
  // The model changed mid-conversation. The history is core's, so nothing is lost — and
  // each turn still says which model produced it.
  store.append(session, { role: 'assistant', content: 'Six groups.', model: 'gpt-oss-120b' })

  const history = store.history(session)
  expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  expect(history[1]?.calls?.[0]?.name).toBe('fs.list')
  expect(history[2]?.callId).toBe('c1')
  expect(history.map((m) => m.model)).toEqual([undefined, 'qwen3:8b', undefined, 'gpt-oss-120b'])

  // A limit keeps the newest turns and still hands them back in order.
  expect(store.history(session, 2).map((m) => m.content)).toEqual(['340 files', 'Six groups.'])
  store.close()
})

test('the session list is newest-touched first, and deleting one takes its messages', async () => {
  const store = new Store(':memory:')
  const first = store.createSession('First')
  const second = store.createSession('Second')
  await new Promise((resolve) => setTimeout(resolve, 2)) // a real gap, not a same-millisecond tie
  store.append(first, { role: 'user', content: 'still here' })
  store.append(second, { role: 'user', content: 'and here' })

  expect(store.sessions().map((s) => s.title)).toEqual(['Second', 'First'])
  store.renameSession(first, 'Sorting downloads')
  expect(store.sessions().map((s) => s.title)).toEqual(['Second', 'Sorting downloads'])

  store.deleteSession(second)
  expect(store.sessions().map((s) => s.id)).toEqual([first])
  expect(store.history(second)).toEqual([]) //         the cascade took the messages
  expect(store.history(first)).toHaveLength(1) //      and left the other conversation alone
  store.close()
})

test('a message cannot be appended to a conversation that does not exist', () => {
  const store = new Store(':memory:')
  // Foreign keys are on, so this is caught here rather than becoming an orphan row nobody
  // can see and nothing deletes.
  expect(() => store.append(404, { role: 'user', content: 'hello?' })).toThrow()
  store.close()
})

test('a hyphenated plugin id has a table name, and purge still finds it', () => {
  // A plugin id is `lowercase-with-hyphens` and a SQL identifier here is
  // `lowercase_with_underscores`, so until these two agreed a hyphenated id had **no table
  // name at all**: `claude-code` declared storage the manifest schema accepts, `create` threw
  // inside `load`, and the process died before the port was ever opened. Purge had the same
  // hole from the other end — the one namespace that could not be created also could not be
  // dropped, which is invariant 5 quietly not holding.
  const store = new Store(':memory:')
  store.create('claude-code', ['runs'])
  expect(store.tables()).toContain('p_claude_code_runs')

  store.insert('claude-code', 'runs', { task: 'ship it' })
  expect(store.select('claude-code', 'runs')).toMatchObject([{ task: 'ship it' }])

  store.purge('claude-code')
  expect(store.tables()).not.toContain('p_claude_code_runs')
  store.close()
})
