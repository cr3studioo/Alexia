// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { dataDir, Store } from '../src/store.js'

// What storage gained at M1-1 over the M0 minimum: a real file in the platform's own place,
// forward-only migrations, and the transaction helper `node:sqlite` does not ship. The rest
// of the store is exercised end to end by plugins.test.ts and invariant 5.

/** A path whose parent does not exist yet — opening it has to make the directory. */
const tmp = (): string => join(mkdtempSync(join(tmpdir(), 'alexia-store-')), 'data', 'alexia.db')

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
  expect(version(path)).toBe(1)

  // Migration 1 is a plain CREATE TABLE. If it ran twice this line throws.
  const second = new Store(path)
  expect(second.kvGet('demo', 'model')).toBe('base')
  expect(second.tables()).toContain('kv')
  second.close()
  expect(version(path)).toBe(1)
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
  const repoRoot = join(import.meta.dirname, '..', '..', '..')
  expect(relative(repoRoot, dir).startsWith('..')).toBe(true)
})
