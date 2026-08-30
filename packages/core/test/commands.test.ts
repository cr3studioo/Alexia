// SPDX-License-Identifier: AGPL-3.0-only
import { Manifest } from '@alexia/protocol'
import { expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll } from 'vitest'
import { commands, pins, run } from '../src/commands.js'
import type { Provider } from '../src/provider.js'
import { MODES } from '../src/router.js'
import { Store } from '../src/store.js'

// M1-12. Commands come off manifests, so deleting a folder removes them — which is the
// invariant again, wearing a different hat. Naming plugins here is fine: the rule is about
// what is in `packages/core/src`.

const plugin = (id: string, ...names: string[]): Manifest =>
  Manifest.parse({
    manifest_version: 1,
    id,
    name: id,
    summary: `${id}, for the test`,
    version: '0.1.0',
    license: 'AGPL-3.0-only',
    entry: { run: 'node', args: ['index.js'] },
    alexia_protocol: 2,
    mcp_protocol: '2025-11-25',
    commands: names.map((name) => ({ name, summary: `does ${name}` })),
  })

test('the three axes are core, and a plugin cannot take one of their words', async () => {
  const store = new Store(':memory:')
  expect(pins(store).placement).toEqual(MODES.combined)

  expect((await run('/local', { store })).note).toContain('everything runs on this machine')
  expect(pins(store).placement).toEqual(MODES.local)
  await run('/nsfw', { store })
  await run('/best', { store })
  expect(pins(store)).toEqual({ placement: MODES.local, uncensored: true, prefer: 'best' })

  // Back again, and the other pins are untouched by the one that changed.
  await run('/cloud', { store })
  await run('/sfw', { store })
  expect(pins(store)).toEqual({ placement: MODES.cloud, uncensored: false, prefer: 'best' })

  // A plugin declaring `local` does not get it. `/local` meaning something other than
  // local, for anyone, ever, is the surprise this project exists against.
  const list = commands([plugin('mischief', 'local')])
  expect(list.filter((c) => c.name === 'local')).toEqual([
    { name: 'local', summary: 'Run everything on this machine.' },
  ])
  expect(list.find((c) => c.plugin === 'mischief')).toMatchObject({
    name: 'mischief.local',
    shadowed: true,
  })
  store.close()
})

test('first installed wins the bare word, and the long form always works', () => {
  const list = commands([plugin('voice', 'mute'), plugin('speakers', 'mute')])

  expect(list.find((c) => c.plugin === 'voice')).toEqual({
    name: 'mute',
    alias: 'voice.mute',
    summary: 'does mute',
    plugin: 'voice',
  })
  // The second one is not broken, only longer — and it says so in the list.
  expect(list.find((c) => c.plugin === 'speakers')).toEqual({
    name: 'speakers.mute',
    alias: 'speakers.mute',
    summary: 'does mute',
    plugin: 'speakers',
    shadowed: true,
  })
})

test('a plugin command calls the plugin tool of the same name', async () => {
  const store = new Store(':memory:')
  const manifests = [plugin('voice', 'mute'), plugin('speakers', 'mute')]
  const called: string[] = []
  const call = async (plugin: string, tool: string): Promise<string> => {
    called.push(`${plugin}/${tool}`)
    return 'stopped listening'
  }

  expect(await run('/mute', { store, manifests, call })).toEqual({ ok: true, note: 'stopped listening' })
  // The namespaced form reaches the same tool, and the shadowed plugin reaches its own.
  await run('/voice.mute', { store, manifests, call })
  await run('/speakers.mute', { store, manifests, call })
  expect(called).toEqual(['voice/mute', 'voice/mute', 'speakers/mute'])

  // The plugin's own words when it fails, never core's guess at them.
  const broken = async (): Promise<string> => {
    throw new Error('the microphone is unplugged')
  }
  expect(await run('/mute', { store, manifests, call: broken })).toEqual({
    ok: false,
    note: 'the microphone is unplugged',
  })
  store.close()
})

test('a command that is not there says so, and says where to look', async () => {
  const store = new Store(':memory:')
  expect(await run('/nope', { store })).toEqual({
    ok: false,
    note: 'there is no /nope — type / to see what there is',
  })

  // The folder is gone, so the command is gone with it. No core file to edit.
  expect(await run('/mute', { store, manifests: [] })).toMatchObject({ ok: false })
  store.close()
})

test('/new is the caller’s to answer, because "here" is a different place for each of them', async () => {
  const store = new Store(':memory:')

  // The window rotates the conversation on screen; a plugin rotates its own. This file
  // knows about neither, which is why it is a hook rather than something done here.
  let started = 0
  const ran = await run('/new', {
    store,
    newChat: () => {
      started += 1
      return Promise.resolve({ ok: true, note: 'Started a new chat.' })
    },
  })
  expect(ran).toEqual({ ok: true, note: 'Started a new chat.' })
  expect(started).toBe(1)

  // And a caller with nowhere to start one says so rather than pretending it did.
  expect((await run('/new', { store })).ok).toBe(false)
})

test('/help is the list, so a place with no palette still has one', async () => {
  const store = new Store(':memory:')
  // The reason it exists: on a phone there is no `/` menu to open and no buttons beside it,
  // so a command surface with no way to read it is a surface nobody uses.
  const note = (await run('/help', { store, manifests: [plugin('telegram', 'paired')] })).note
  expect(note).toContain('/new —')
  expect(note).toContain('/local —')
  expect(note).toContain('/paired —')
})

// `/providers`. Free tiers die monthly, and a table copied from somewhere goes stale in
// silence — the failure it produces looks like a bug in Alexia, which is the expensive kind
// of wrong because it gets chased in the wrong file.

const listing: Server = createServer((request, response) => {
  const status = request.url === '/keyed/models' ? 401 : request.url === '/gone/models' ? 500 : 200
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ data: [] }))
})
await new Promise<void>((resolve) => listing.listen(0, '127.0.0.1', resolve))
afterAll(() => void listing.close())

test('/providers says which rows answered and how old each check is', async () => {
  const host = `http://127.0.0.1:${String((listing.address() as AddressInfo).port)}`
  const noon = Date.UTC(2026, 7, 30, 12)
  const table: Provider[] = [
    { id: 'live', name: 'Live', baseUrl: `${host}/live`, models: '/models', verified: '2026-08-30' },
    { id: 'keyed', name: 'Keyed', baseUrl: `${host}/keyed`, models: '/models', verified: '2026-08-01' },
    { id: 'gone', name: 'Gone', baseUrl: `${host}/gone`, models: '/models', verified: '2026-06-30' },
    { id: 'quiet', name: 'Quiet', baseUrl: `${host}/quiet`, verified: '2026-08-30' },
    { id: 'templated', name: 'Templated', baseUrl: `${host}/{account}/v1`, models: '/models' },
  ]

  const store = new Store(':memory:')
  const said = await run('/providers', { store, providers: table })
  expect(said.ok).toBe(true)
  const note = String(said.note)

  // Four states, because they want four different things done about them.
  expect(note).toContain('Live — answered')
  expect(note).toContain('Keyed — needs a key (401)')
  expect(note).toContain('Gone — failed (500)')
  expect(note).toContain('Quiet — no list')
  // An address with an account id in it cannot be reached without one. That is the row
  // working as designed, not the row broken.
  expect(note).toContain('Templated — needs a key (its address contains an account id)')

  // Broken first, because that is the line somebody is running this to find.
  expect(note.indexOf('Gone —')).toBeLessThan(note.indexOf('Live —'))
  expect(note).toContain('5 providers checked, 1 not answering.')

  // Staleness is the other half. A row nobody has confirmed for two months is not the same
  // row as one confirmed today, even when both answer.
  expect(note).toMatch(/Gone — failed \(500\) · checked \d+ days ago/)
  expect(note).toContain('never checked')

  // And it reports rather than acts: nothing is disabled, and no date is written by a ping.
  expect(note).toContain('Dates are not updated by this')
  expect(table.map((p) => p.verified)).toEqual([
    '2026-08-30',
    '2026-08-01',
    '2026-06-30',
    '2026-08-30',
    undefined,
  ])
  expect(noon).toBeGreaterThan(0)
  store.close()
})

test('/providers is a command somebody types, not a check that fails a build', () => {
  // It needs the network, so wiring it into CI would fail somebody's pull request because a
  // third party was rebooting. It is in the list you get by typing `/`.
  expect(commands().map((c) => c.name)).toContain('providers')
})
