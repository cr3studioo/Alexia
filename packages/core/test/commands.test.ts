// SPDX-License-Identifier: AGPL-3.0-only
import { Manifest } from '@alexia/protocol'
import { expect, test } from 'vitest'
import { commands, pins, run } from '../src/commands.js'
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
    alexia_protocol: 1,
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
