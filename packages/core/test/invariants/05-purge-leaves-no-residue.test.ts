// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { Plugins } from '../../src/plugins.js'
import { Store } from '../../src/store.js'
import { stage } from '../staged.js'

// Defends: purge means purge — the transition worth testing hardest. Snapshot the database
// and the filesystem, install → enable → use → delete, diff. **The diff must be empty.**
// Everything in `docs/spec/storage.md` exists to make this check possible to write.

const dataDir = mkdtempSync(join(tmpdir(), 'alexia-purge-'))
const store = new Store(':memory:')
const dir = stage('hello')
const plugins = new Plugins({ dir, store, dataDir })

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
  store.setSetting('hello', 'greeting', 'Good evening')

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
  // And the folder it was installed from is gone with it.
  expect(existsSync(join(dir, 'hello'))).toBe(false)
}, 30_000)
