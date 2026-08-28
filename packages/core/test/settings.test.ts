// SPDX-License-Identifier: AGPL-3.0-only
import { Manifest } from '@alexia/protocol'
import { ProtocolError } from '@modelcontextprotocol/client'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Host } from '../src/host.js'
import { account, ACCOUNT_ALLOWED, memorySecrets } from '../src/secrets.js'
import { pane, refuse, secretStoreName, write, type Setting } from '../src/settings.js'
import { Store } from '../src/store.js'

/**
 * The settings screen, from core's side (M2-1). Ten widgets, one manifest, and the two rules
 * that matter: a password is never rendered, and a plugin may write only its own `status`.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-settings-'))
const store = new Store(join(root, 'alexia.db'))
const secrets = memorySecrets()

/** All ten, in one manifest, because the renderer's job is to handle all ten. */
const manifest = Manifest.parse({
  manifest_version: 1,
  id: 'demo',
  name: 'Demo',
  summary: 'Every widget there is, so nothing is rendered for the first time in production.',
  version: '0.1.0',
  license: 'AGPL-3.0-only',
  entry: { run: 'node', args: ['index.js'] },
  alexia_protocol: 1,
  mcp_protocol: '2025-11-25',
  requires: [{ cap: 'audio.input', why: 'To hear you when you press the hotkey.' }],
  settings: [
    { type: 'text', key: 'endpoint', label: 'Server address', default: 'http://localhost:11434' },
    { type: 'password', key: 'api_key', label: 'API key' },
    { type: 'number', key: 'threads', label: 'Threads', min: 1, max: 16, default: 4 },
    { type: 'toggle', key: 'start_muted', label: 'Start muted', default: false },
    { type: 'choice', key: 'size', label: 'Speech model', options: ['tiny', 'base', 'small'], default: 'base' },
    { type: 'multi-choice', key: 'languages', label: 'Languages', options: ['en', 'cs', 'de'], default: ['en'] },
    { type: 'path', key: 'watch_dir', label: 'Folder to watch', kind: 'dir' },
    { type: 'status', key: 'model_state', label: 'Speech model' },
    { type: 'progress', key: 'download', label: 'Download' },
    { type: 'action', key: 'redownload', label: 'Download again', tool: 'download_model' },
  ],
})

const declared = (key: string): Setting => manifest.settings!.find((s) => s.key === key)!

const options = {
  store,
  running: () => false,
  tools: () => undefined,
  progress: () => undefined,
  hasSecret: async (_id: string, key: string) => (await secrets.get('demo', key)) !== undefined,
}

test('a pane is drawn from the manifest alone, with nothing running', async () => {
  const drawn = await pane(manifest, options)

  // The whole reason the schema lives in `plugin.json`: lazy spawn means "stopped" is the
  // normal state, and a screen that had to wake a process to draw itself would wake it every
  // time anybody looked.
  expect(drawn.running).toBe(false)
  expect(drawn.settings).toHaveLength(10)
  expect(drawn.settings.map((s) => s.type)).toEqual([
    'text',
    'password',
    'number',
    'toggle',
    'choice',
    'multi-choice',
    'path',
    'status',
    'progress',
    'action',
  ])

  // Defaults show through where the user has stored nothing.
  expect(drawn.settings[0]).toMatchObject({ value: 'http://localhost:11434' })
  expect(drawn.settings[2]).toMatchObject({ value: 4 })
  expect(drawn.settings[5]).toMatchObject({ value: ['en'] })

  // The author's own sentence, verbatim. It is what the user reads.
  expect(drawn.requires).toEqual([{ cap: 'audio.input', why: 'To hear you when you press the hotkey.' }])
})

test('a password is reported as set or not, and the secret itself is not in the pane', async () => {
  await secrets.set('demo', 'api_key', 'sk-not-a-real-key')
  const drawn = await pane(manifest, options)
  const password = drawn.settings[1]!

  expect(password).toMatchObject({ set: true })
  expect(password).not.toHaveProperty('value')
  // The one sentence core writes rather than the author: a plugin promising the wrong store
  // would be lying on core's screen, in core's voice.
  expect(password.stored).toBe(secretStoreName())
  expect(JSON.stringify(drawn)).not.toContain('sk-not-a-real-key')
})

test('an action button is live while the plugin is stopped, and honest while it is running', async () => {
  // Stopped: nothing to ask, and asking would spawn it. Pressing the button is what starts it.
  expect((await pane(manifest, options)).settings[9]).toMatchObject({ available: true })

  const withTools = { ...options, running: () => true, tools: () => ['greet'] }
  expect(await pane(manifest, withTools).then((p) => p.settings[9])).toMatchObject({
    available: false,
    reason: 'Demo has no tool called "download_model" right now.',
  })

  const withIt = { ...options, running: () => true, tools: () => ['download_model'] }
  expect(await pane(manifest, withIt).then((p) => p.settings[9])).toMatchObject({ available: true })
})

test('a progress bar is absent until there is progress, and then it is the plugin’s own', async () => {
  expect((await pane(manifest, options)).settings[8]).not.toHaveProperty('live')

  const busy = { ...options, progress: () => ({ progress: 41, total: 100, message: 'Downloading' }) }
  expect((await pane(manifest, busy)).settings[8]).toMatchObject({
    live: { progress: 41, total: 100, message: 'Downloading' },
  })
})

test('every refusal names the value and what was wrong with it', () => {
  // "Invalid" tells somebody only that they have to guess again.
  expect(refuse(declared('threads'), 20)).toBe('"Threads" must be at most 16.')
  expect(refuse(declared('threads'), 0)).toBe('"Threads" must be at least 1.')
  expect(refuse(declared('threads'), 'four')).toBe('"Threads" takes a number.')
  expect(refuse(declared('size'), 'huge')).toBe('"huge" is not one of tiny, base, small.')
  expect(refuse(declared('languages'), ['en', 'fr'])).toBe('"fr" is not one of en, cs, de.')
  expect(refuse(declared('start_muted'), 'yes')).toBe('"Start muted" is on or off.')
  expect(refuse(declared('endpoint'), 7)).toBe('"Server address" takes text.')

  // And the ones that pass.
  expect(refuse(declared('threads'), 16)).toBeUndefined()
  expect(refuse(declared('size'), 'tiny')).toBeUndefined()
  expect(refuse(declared('languages'), ['cs', 'de'])).toBeUndefined()
  expect(refuse(declared('start_muted'), true)).toBeUndefined()
})

test('the three the plugin drives are not the user’s to type into', () => {
  expect(refuse(declared('model_state'), '● Ready')).toBe('"Speech model" is driven by the plugin, not by you.')
  expect(refuse(declared('download'), 50)).toBe('"Download" is driven by the plugin, not by you.')
  expect(refuse(declared('redownload'), true)).toBe('"Download again" is a button, not a value.')
})

test('a path is checked against the disk, because only this side can see it', () => {
  const folder = mkdtempSync(join(tmpdir(), 'alexia-path-'))
  const file = join(folder, 'a-file')
  writeFileSync(file, 'x')

  expect(refuse(declared('watch_dir'), folder)).toBeUndefined()
  expect(refuse(declared('watch_dir'), '')).toBeUndefined()
  expect(refuse(declared('watch_dir'), file)).toBe(`${file} is a file, and this wants a folder.`)
  expect(refuse(declared('watch_dir'), 'notes')).toBe('notes is not a full path.')
  expect(refuse(declared('watch_dir'), join(folder, 'nowhere'))).toBe(
    `There is nothing at ${join(folder, 'nowhere')}.`,
  )
})

test('a password is written to the keychain and an empty one clears it', async () => {
  await write('demo', declared('api_key'), 'sk-second', { store, secrets })
  expect(await secrets.get('demo', 'api_key')).toBe('sk-second')
  expect(store.settings('demo')).not.toHaveProperty('api_key')

  // A screen where a secret can be replaced but never removed keeps secrets somebody has
  // decided to stop trusting it with.
  await write('demo', declared('api_key'), '', { store, secrets })
  expect(await secrets.get('demo', 'api_key')).toBeUndefined()
})

test('a plugin may write its own status, and nothing else on that screen', async () => {
  const dataDir = join(root, 'host')
  mkdirSync(dataDir, { recursive: true })
  const host = new Host({ store, dataDir, secrets, manifest: () => manifest })

  await host.alexia('demo', 'alexia/settings/set', { key: 'model_state', value: '● Ready (base, 142 MB)' })
  expect(store.settings('demo')).toMatchObject({ model_state: '● Ready (base, 142 MB)' })

  // The narrowness is the design. A plugin that could rewrite a toggle the user set could
  // quietly undo a person's decision, and would have to be trusted rather than read.
  await expect(
    host.alexia('demo', 'alexia/settings/set', { key: 'start_muted', value: true }),
  ).rejects.toThrow(/may only write its own status settings; "start_muted" is a toggle/)

  await expect(host.alexia('demo', 'alexia/settings/set', { key: 'nope', value: 1 })).rejects.toThrow(
    /did not declare a setting called "nope"/,
  )
  await expect(
    host.alexia('demo', 'alexia/settings/set', { key: 'nope', value: 1 }),
  ).rejects.toMatchObject({ code: -32053 } satisfies Partial<ProtocolError>)
})

test('a keychain account name is one the keychain will actually accept', () => {
  // Found by M2-1's settings screen, which was the first thing to touch the real store: the
  // account was `<plugin>/<key>`, and `cross-keychain` refuses a slash — so every read and
  // every write threw, on a real machine, including the provider key somebody pastes at
  // first run. Every test used `memorySecrets`, which has no such rule and never noticed.
  //
  // The constraint lives outside this repo, so it is written down here as the thing it is:
  // a rule about the string we build, checked against the character set that store allows.
  for (const [plugin, key] of [
    ['hello', 'api_key'],
    ['_core', 'openrouter'],
    ['some-long-plugin-name', 'a_key_2'],
  ] as const) {
    expect(account(plugin, key)).toMatch(ACCOUNT_ALLOWED)
  }

  // And it still splits exactly one way: neither alphabet contains a dot.
  expect(account('hello', 'api_key')).toBe('hello.api_key')
  expect(account('hello', 'api_key').split('.')).toHaveLength(2)
})
