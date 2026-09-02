// SPDX-License-Identifier: AGPL-3.0-only
import { CONVERSATION_ENDED, ErrorCode, Manifest } from '@alexia/protocol'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { Host } from '../src/host.js'
import { memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'
import { PluginProcess } from '../src/supervisor.js'

// The first end-to-end pass through the whole contract: a real plugin folder, spawned as a
// real process, reading a real setting and writing a real row. Naming a plugin is fine
// here — invariant 1 forbids it in `packages/core/src`, which is the part that ships.

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const dir = join(repoRoot, 'plugins', 'hello')
const manifest = Manifest.parse(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')))

const store = new Store(':memory:')
const secrets = memorySecrets()
const host = new Host({
  store,
  secrets,
  dataDir: mkdtempSync(join(tmpdir(), 'alexia-data-')),
  manifest: (id) => (id === manifest.id ? manifest : undefined),
})

const plugin = new PluginProcess(manifest, dir, host)
afterEach(async () => {
  await plugin.stop()
})

test('a plugin answers, reads its setting, and writes a row core can see', async () => {
  expect((await plugin.listTools()).map((t) => t.name)).toEqual(['greet', 'greeted', 'warm_up'])

  // "Hello" is the manifest's default. Nothing was stored, and the plugin never learned
  // where the value came from — which is the point of core owning settings.
  const greeted = await plugin.callTool('greet', { who: 'Vaclav' })
  expect(greeted.content).toEqual([{ type: 'text', text: 'Hello, Vaclav.' }])

  const rows = store.select('hello', 'greetings')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ who: 'Vaclav' })

  // And the plugin can read back what it wrote, through the same namespace.
  expect((await plugin.callTool('greeted')).content).toEqual([{ type: 'text', text: '1' }])
}, 20_000)

test('a password comes back to the plugin, and never out of the database', async () => {
  await secrets.set('hello', 'api_key', 'sk-not-a-real-key')

  // Read at the moment of the call, from the keychain. Everything else still comes from
  // the store, with the manifest's default underneath it.
  const { settings } = (await host.alexia('hello', 'alexia/settings/get', {})) as {
    settings: Record<string, unknown>
  }
  // Every declared key, with the user's value or the manifest's default underneath it —
  // including the `status` Hello wrote about itself, which comes back like any other.
  expect(settings).toMatchObject({ greeting: 'Hello', api_key: 'sk-not-a-real-key', tone: 'plain' })
  expect(Object.keys(settings).sort()).toEqual(
    ['api_key', 'exclaim', 'extras', 'greeting', 'ready', 'tone', 'warm_up_ms'].sort(),
  )

  // The database has never heard of it. That is invariant 5's secret half, asserted here
  // where the settings table can be read directly — and asserted about the secret rather
  // than about the whole table, because a `status` a plugin wrote about itself lives there
  // too and an empty table stopped being the thing worth checking (M2-1).
  expect(store.settings('hello')).not.toHaveProperty('api_key')
  expect(JSON.stringify(store.settings('hello'))).not.toContain('sk-not-a-real-key')
})

test('the user changing a setting changes what the plugin says', async () => {
  store.setSetting('hello', 'greeting', 'Good evening')
  const greeted = await plugin.callTool('greet', { who: 'Vaclav' })
  expect(greeted.content).toEqual([{ type: 'text', text: 'Good evening, Vaclav.' }])
}, 20_000)

test('a table the plugin did not declare is not its table', async () => {
  // The namespace rule, tested where it is enforced rather than where it is obeyed. A
  // plugin that asks for someone else's rows gets a code, not a leak.
  await expect(
    host.alexia('hello', 'alexia/storage/insert', { table: 'sessions', row: { x: 1 } }),
  ).rejects.toMatchObject({ code: ErrorCode.STORAGE_OUT_OF_NAMESPACE })
})

test('purge means purge', async () => {
  await plugin.callTool('greet', { who: 'Someone' })
  store.kvSet('hello', 'last', { seen: true })
  expect(store.tables()).toContain('p_hello_greetings')

  store.purge('hello')

  expect(store.tables()).not.toContain('p_hello_greetings')
  expect(store.kvGet('hello', 'last')).toBeUndefined()
  expect(store.settings('hello')).toEqual({})
}, 20_000)

test('a plugin that does not care about the conversation ending is not disturbed by being told', async () => {
  // `alexia/conversation/ended` is broadcast to **every** running plugin, and almost none of them
  // will ever register a handler for it. So the case that matters is this one: an unhandled
  // notification must be shrugged off rather than raising, because it is sent on the path
  // somebody takes to start a new chat — and a plugin that choked on it would break that path
  // for everyone, over a message it had no interest in.
  await plugin.listTools()
  await expect(plugin.notify(CONVERSATION_ENDED, {})).resolves.toBeUndefined()

  // And it is still there and still working afterwards, which is the half a resolved promise
  // does not prove on its own.
  const after = await plugin.callTool('greet', { who: 'Still here' })
  expect(after.content).toEqual([{ type: 'text', text: 'Hello, Still here.' }])
})
