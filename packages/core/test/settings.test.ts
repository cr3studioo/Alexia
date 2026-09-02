// SPDX-License-Identifier: AGPL-3.0-only
import { Manifest } from '@alexia/protocol'
import { ProtocolError } from '@modelcontextprotocol/client'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Host } from '../src/host.js'
import { keyOf, PROVIDERS } from '../src/provider.js'
import { account, ACCOUNT_ALLOWED, CORE, memorySecrets } from '../src/secrets.js'
import { pane, refuse, secretStoreName, write, type PaneOptions, type Rendered, type Setting } from '../src/settings.js'
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
  alexia_protocol: 2,
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
    ['some-long-plugin-name', 'a_key_2'],
  ] as const) {
    expect(account(plugin, key)).toMatch(ACCOUNT_ALLOWED)
  }

  // And the keys nothing here invents: every provider's, from the function that builds them.
  // This line used to read `['_core', 'openrouter']` — a key typed out by hand, next to a
  // `keyOf` that was returning `provider/openrouter`. It passed while the real account name
  // threw, which is the whole of why a pasted key never reached the keychain.
  for (const provider of PROVIDERS) expect(account(CORE, keyOf(provider))).toMatch(ACCOUNT_ALLOWED)

  // And it still splits exactly one way: neither alphabet contains a dot.
  expect(account('hello', 'api_key')).toBe('hello.api_key')
  expect(account('hello', 'api_key').split('.')).toHaveLength(2)
})

/**
 * A page that shows what applies (`alexia_protocol` 7).
 *
 * Its own manifest rather than a `when` bolted onto the one above, because the thing under
 * test is a **page**: which widgets are on it, and what a value change does to the rest of
 * them. Four engines with sentences, three of them gated on something else being filled in,
 * and widgets that only exist for one of them — which is the shape that made this necessary.
 */
const gated = Manifest.parse({
  manifest_version: 1,
  id: 'demo',
  name: 'Demo',
  summary: 'A page whose widgets appear and disappear with the one at the top of it.',
  version: '0.1.0',
  license: 'AGPL-3.0-only',
  entry: { run: 'node', args: ['index.js'] },
  alexia_protocol: 7,
  mcp_protocol: '2025-11-25',
  settings: [
    {
      type: 'choice',
      key: 'engine',
      label: 'Engine',
      default: 'here',
      options: [
        { value: 'here', label: 'On this machine', hint: 'Fast, and it cannot clone.' },
        { value: 'away', label: 'A service', hint: 'It can clone, and it needs a key.', needs: 'api_key', reason: 'Add a key below.' },
        { value: 'other', label: 'Something else', hint: 'It needs a program.', needs: 'exe' },
      ],
    },
    { type: 'text', key: 'clip_text', label: 'What the clip says', multiline: true, when: { key: 'engine', is: 'away' } },
    { type: 'file', key: 'clip', label: 'A recording', accept: '.wav', when: { key: 'engine', is: ['away', 'other'] } },
    { type: 'text', key: 'local_only', label: 'Only here', when: { key: 'engine', is: 'here' } },
    { type: 'password', key: 'api_key', label: 'Service key' },
    { type: 'text', key: 'exe', label: 'Program' },
  ],
})

const shown = async (extra: Partial<PaneOptions> = {}): Promise<Rendered[]> =>
  (await pane(gated, { ...options, ...extra })).settings

test('a widget that does not apply to what is chosen is not on the page at all', async () => {
  // Gone rather than greyed. A greyed control promises something could be typed there.
  const first = await shown()
  expect(first.map((one) => one.key)).toEqual(['engine', 'local_only', 'api_key', 'exe'])

  store.setSetting('demo', 'engine', 'away')
  const away = await shown()
  expect(away.map((one) => one.key)).toEqual(['engine', 'clip_text', 'clip', 'api_key', 'exe'])

  // A list `is`, so one widget can belong to two engines without being declared twice.
  store.setSetting('demo', 'engine', 'other')
  expect((await shown()).map((one) => one.key)).toEqual(['engine', 'clip', 'api_key', 'exe'])
  store.setSetting('demo', 'engine', 'here')
})

test('the widgets that decide what else is on the page say so, and the rest do not', async () => {
  const page = await shown()
  // Core works this out; an author who had to declare it would forget. `exe` and `api_key`
  // are in because an option's availability turns on them, not only because a `when` does.
  const gates = page.filter((one) => one.gates === true).map((one) => one.key)
  expect(gates.sort()).toEqual(['api_key', 'engine', 'exe'])
  expect(page.find((one) => one.key === 'local_only')).not.toHaveProperty('gates')
})

test('an option that needs something is dimmed with the reason, and lit once it is there', async () => {
  const options0 = (page: Rendered[]): Record<string, unknown>[] => {
    const engine = page.find((one) => one.key === 'engine')
    return (engine !== undefined && 'options' in engine ? engine.options : []) as Record<string, unknown>[]
  }

  const before = options0(await shown())
  expect(before[0]).toEqual({ value: 'here', label: 'On this machine', hint: 'Fast, and it cannot clone.' })
  expect(before[1]).toMatchObject({ available: false, reason: 'Add a key below.' })
  // No `reason` of the author's, so core writes one naming the widget it is waiting on —
  // which it can, because that is a fact about this page rather than about what the key does.
  expect(before[2]).toMatchObject({ available: false, reason: 'Needs “Program”.' })

  // The key is in the keychain rather than the database, so this is asked of the keychain.
  await secrets.set('demo', 'api_key', 'sk-not-a-real-key')
  store.setSetting('demo', 'exe', 'C:/python/python.exe')
  const after = options0(await shown())
  expect(after[1]).toMatchObject({ available: true })
  expect(after[1]).not.toHaveProperty('reason')
  expect(after[2]).toMatchObject({ available: true })

  // An empty string is not a value. It is what a box somebody cleared holds.
  store.setSetting('demo', 'exe', '')
  expect(options0(await shown())[2]).toMatchObject({ available: false })
})

test('a file is chosen, not typed — so the page may not write one', () => {
  const declaredIn = (key: string): Setting => gated.settings!.find((one) => one.key === key)!
  // The bytes go to `/api/upload`, which puts them somewhere safe and stores the path it
  // made. A path arriving here instead is a page asking core to remember somewhere nobody
  // uploaded anything to.
  expect(refuse(declaredIn('clip'), 'C:/Users/someone/secrets.wav')).toBe(
    '"A recording" is a file you choose, not a path you type.',
  )
  // And a `choice` refusal still names the values, not the labels a person reads.
  expect(refuse(declaredIn('engine'), 'nowhere')).toBe('"nowhere" is not one of here, away, other.')
  expect(refuse(declaredIn('engine'), 'away')).toBeUndefined()
})
