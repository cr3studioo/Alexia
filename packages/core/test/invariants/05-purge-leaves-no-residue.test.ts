// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { Plugins } from '../../src/plugins.js'
import { memorySecrets } from '../../src/secrets.js'
import { Store } from '../../src/store.js'
import { stage } from '../staged.js'

// Defends: purge means purge — the transition worth testing hardest. Snapshot the database
// and the filesystem, install → enable → use → delete, diff. **The diff must be empty.**
// Everything in `docs/spec/storage.md` exists to make this check possible to write.

const dataDir = mkdtempSync(join(tmpdir(), 'alexia-purge-'))
// A real file rather than `:memory:`, because half of this check is reading the bytes back
// and proving a secret is not among them. It lives outside `dataDir`, which is diffed.
const dbDir = mkdtempSync(join(tmpdir(), 'alexia-purge-db-'))
const store = new Store(join(dbDir, 'alexia.db'))
const dir = stage('hello')
// A CI runner has no keychain daemon and should not grow one. What is being proved is that
// the secret goes somewhere that is not the database, and this is somewhere else.
const secrets = memorySecrets()
const plugins = new Plugins({ dir, store, dataDir, secrets })

/** The database, as bytes — the file, its write-ahead log, and whatever else is beside it. */
const everyByte = (): string =>
  tree(dbDir)
    .map((name) => readFileSync(join(dbDir, name), 'latin1'))
    .join('')

const SECRET = 'sk-alexia-not-a-real-key-9f3c'

afterAll(async () => {
  await plugins.stop()
  store.close()
})

/** Every path under a directory, relative and sorted. The filesystem half of the diff. */
const tree = (root: string): string[] => {
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort()
}

const snapshot = () => ({ tables: store.tables(), files: tree(dataDir) })

test('purge-leaves-no-residue: install, enable, use, delete, and diff', async () => {
  const before = snapshot()

  // Install and enable: the namespace and the directory come into existence here.
  plugins.load()
  expect(plugins.ids).toEqual(['hello'])

  // Use it, so there is something to remove. A row, a kv entry, a setting the user changed,
  // and the plugin's own directory — every row of the table in storage.md.
  await plugins.process('hello')!.callTool('greet', { who: 'Vaclav' })
  store.kvSet('hello', 'last_seen', { at: 1 })
  await plugins.setSetting('hello', 'greeting', 'Good evening')
  await plugins.setSetting('hello', 'api_key', SECRET)

  // The secret half: a `password` reaches the keychain and never the file. Checked as
  // bytes, because a column nobody thought to look in is exactly how this would be missed.
  expect(await secrets.get('hello', 'api_key')).toBe(SECRET)
  // The scan is looking at real content — the ordinary setting written a line earlier is in
  // there. Without this, `not.toContain` would pass just as well against an empty string.
  expect(everyByte()).toContain('Good evening')
  expect(everyByte()).not.toContain(SECRET)

  const during = snapshot()
  expect(during.tables).toContain('p_hello_greetings')
  expect(during.files).toContain('plugins/hello')
  expect(store.count('hello', 'greetings')).toBe(1)

  // Delete.
  await plugins.purge('hello')

  const after = snapshot()
  expect(after).toEqual(before)
  expect(store.settings('hello')).toEqual({})
  expect(store.kvGet('hello', 'last_seen')).toBeUndefined()
  expect(await secrets.get('hello', 'api_key')).toBeUndefined()
  // And the folder it was installed from is gone with it.
  expect(existsSync(join(dir, 'hello'))).toBe(false)
}, 30_000)
