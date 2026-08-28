// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { Plugins } from '../src/plugins.js'
import { memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'
import { stage } from './staged.js'

/**
 * The lifecycle (M2-5).
 *
 * ```
 * In library --install--> Installed --enable--> Enabled --disable--> Disabled --delete--> Purged
 * ```
 *
 * The line that matters is the one between *installed* and *enabled*: files arriving on disk
 * is not consent, and nothing runs on the strength of a folder appearing. Invariant 5 owns
 * the last arrow; what is checked here is the three before it, and that **disable keeps
 * everything delete would take**.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'alexia-lifecycle-'))
const store = new Store(join(dataDir, 'alexia.db'))
// An empty extensions folder, so `install` is the only way anything gets into it.
const dir = mkdtempSync(join(tmpdir(), 'alexia-lifecycle-into-'))
const from = stage('hello')

const plugins = new Plugins({ dir, store, dataDir, secrets: memorySecrets() })

afterAll(async () => {
  await plugins.stop()
  store.close()
  // Windows can hold a directory handle for a moment after the process using it as its cwd
  // has gone. Retrying is cheaper than a CI flake nobody can reproduce.
  for (const path of [dataDir, dir, from]) {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a folder that is not a plugin never lands in the folder core watches', () => {
  const rubbish = join(mkdtempSync(join(tmpdir(), 'alexia-rubbish-')), 'notaplugin')
  mkdirSync(rubbish, { recursive: true })
  writeFileSync(join(rubbish, 'readme.txt'), 'hello')

  const said = plugins.install(rubbish)
  expect('reason' in said && said.reason).toContain('no readable plugin.json')
  // The point of validating where it stands: a broken entry never appears in the list at all.
  expect(existsSync(join(dir, 'notaplugin'))).toBe(false)
  expect(plugins.ids).toEqual([])
})

test('install puts files on disk and nothing else — no process, no namespace, no consent', () => {
  const said = plugins.install(join(from, 'hello'))
  expect(said).toEqual({ id: 'hello' })
  expect(plugins.ids).toEqual(['hello'])

  // Installed. Everything else about it is still false.
  expect(plugins.enabled('hello')).toBe(false)
  expect(plugins.running('hello')).toBe(false)
  expect(store.tables()).not.toContain('p_hello_greetings')
})

test('a plugin nobody has said yes to answers nothing and offers nothing', async () => {
  expect(await plugins.tools()).toEqual([])
  await expect(plugins.capability('demo.greet', { who: 'nobody' })).rejects.toThrow(/nothing enabled provides/)
  // Its button too: the screen greys it out, and this is what makes that true rather than
  // decorative.
  await expect(plugins.action('hello', 'warm_up')).rejects.toThrow(/not enabled/)
  // But it is in the list, with everything a person needs in order to decide — in its
  // author's own words, which is the whole of the walkthrough.
  const pane = (await plugins.panes()).find((p) => p.id === 'hello')
  expect(pane?.enabled).toBe(false)
  expect(pane?.summary).toContain('Answers when spoken to')
})

test('enable is the moment the namespace exists, and the tools appear', async () => {
  plugins.enable('hello')
  expect(plugins.enabled('hello')).toBe(true)
  expect(store.tables()).toContain('p_hello_greetings')
  expect((await plugins.tools()).map((t) => t.tool.name)).toContain('greet')

  const answered = await plugins.capability('demo.greet', { who: 'Vaclav' })
  expect(answered.content).toEqual([{ type: 'text', text: 'Hello, Vaclav.' }])
  expect(store.count('hello', 'greetings')).toBe(1)
}, 30_000)

test('disable stops the process and keeps every last thing it owns', async () => {
  await plugins.setSetting('hello', 'greeting', 'Good evening')
  expect(plugins.running('hello')).toBe(true)

  await plugins.disable('hello')

  expect(plugins.enabled('hello')).toBe(false)
  expect(plugins.running('hello')).toBe(false)
  expect(await plugins.tools()).toEqual([])
  // Everything delete would take is still here. That is the whole argument for disable being
  // the action the screen offers first: changing your mind costs a click, not a download.
  expect(store.tables()).toContain('p_hello_greetings')
  expect(store.count('hello', 'greetings')).toBe(1)
  expect(store.settings('hello').greeting).toBe('Good evening')
  expect(existsSync(join(dir, 'hello'))).toBe(true)
}, 30_000)

test('re-enabling is instant and finds everything where it was left', async () => {
  plugins.enable('hello')
  const answered = await plugins.capability('demo.greet', { who: 'again' })
  // The setting survived, so the plugin reads back the word the user chose rather than the
  // manifest's default.
  expect(answered.content).toEqual([{ type: 'text', text: 'Good evening, again.' }])
  expect(store.count('hello', 'greetings')).toBe(2)
}, 30_000)

test('the answer survives a restart, because yes is something a person said once', () => {
  // A second `Plugins` over the same store: enabled is not in memory, it is a row.
  const again = new Plugins({ dir, store, dataDir, secrets: memorySecrets() })
  again.load()
  expect(again.enabled('hello')).toBe(true)
})

test('delete is the only one that removes anything', async () => {
  await plugins.purge('hello')
  expect(plugins.ids).toEqual([])
  expect(store.tables()).not.toContain('p_hello_greetings')
  expect(existsSync(join(dir, 'hello'))).toBe(false)
  // And the answer goes with it, so re-installing later starts at the walkthrough again
  // rather than at a yes somebody gave to a different copy.
  expect(plugins.enabled('hello')).toBe(false)
}, 30_000)
