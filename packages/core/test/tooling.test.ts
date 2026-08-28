// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { Plugins } from '../src/plugins.js'
import { memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'
import { Skills } from '../src/skills.js'
import { PluginTooling } from '../src/tooling.js'
import { stage } from './staged.js'

// The join between the supervisor and the loop: real plugins, really spawned, and the list
// the model would be handed. Nothing here fakes `tools/list` — the point is the aggregate.

const dir = stage('hello', 'crasher')
const store = new Store(':memory:')
const dataDir = mkdtempSync(join(tmpdir(), 'alexia-tooling-'))

const logged: string[] = []
const plugins = new Plugins({
  dir,
  store,
  dataDir,
  secrets: memorySecrets(),
  onToolsChanged: () => {
    tooling.invalidate()
    skills.invalidate()
  },
})
const skills = new Skills({
  dir: join(dataDir, 'skills'),
  bundled: () =>
    plugins.ids.flatMap((id) => {
      const folder = plugins.folder(id)
      return folder === undefined ? []
        : (plugins.manifest(id)?.skills ?? []).map((path) => ({ dir: join(folder, path), pluginId: id }))
    }),
})
const tooling = new PluginTooling(plugins, (line) => logged.push(line), skills)
plugins.load()
// Installed is files on disk; enabled is a person having said yes (M2-5). These tests are
// about plugins that run, so they say yes — the same one line the settings screen sends.
for (const id of plugins.ids) plugins.enable(id)

afterAll(async () => {
  await plugins.stop()
  store.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

test('every plugin’s tools arrive as one list, prefixed by who answers', async () => {
  const list = await tooling.list()
  const names = list.map((t) => t.name).sort()

  expect(names).toContain('hello__greet')
  expect(names).toContain('hello__greeted')

  // Not a dot. A model-facing name goes into an OpenAI-shaped `function.name`, which is
  // specified as `^[a-zA-Z0-9_-]{1,64}$` — so a dot would be the provider rejecting the
  // whole request rather than a cosmetic choice.
  for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)

  // Tool descriptions are prompt text, so they are carried through untouched — core never
  // rewrites an author's sentence, and never invents one that is missing.
  const greet = list.find((t) => t.name === 'hello__greet')
  expect(greet?.description).toBe('Greet someone by name. Use when the user introduces themselves or says hello.')
  expect(greet?.parameters).toMatchObject({ properties: { who: { type: 'string' } } })
})

test('a call routes back by the prefix core wrote, and the plugin never sees it', async () => {
  const outcome = await tooling.call('hello__greet', { who: 'Vaclav' })
  expect(outcome).toEqual({ ok: true, text: 'Hello, Vaclav.' })
})

test('a tool that fails is an outcome the model can read, not a thrown error', async () => {
  // `greet` requires `who`. Calling it without one is the shape of every mistake a model
  // makes with a schema, and it has to come back as something to plan around.
  const outcome = await tooling.call('hello__greet', {})
  expect(outcome.ok).toBe(false)
  expect(outcome.text.length).toBeGreaterThan(0)
})

test('a name nothing answers comes back with what there is instead', async () => {
  const outcome = await tooling.call('hello__sing', {})
  expect(outcome.ok).toBe(false)
  expect(outcome.text).toContain('no tool called hello__sing')
  // The list is the useful half: a model that guessed a name can correct itself from it.
  expect(outcome.text).toContain('hello__greet')
})

test('know-how rides the same list as capability, and reading it needs no permission', async () => {
  const list = await tooling.list()
  // One tool for every skill installed, not one per skill: the index is its description.
  expect(list.filter((t) => t.name === 'skill')).toHaveLength(1)
  expect(list.find((t) => t.name === 'skill')?.description).toContain('- greeting-well:')

  // Text core already has on disk. Without this the default mode asks permission every time
  // the model opens its own instructions.
  expect(await tooling.about('skill')).toEqual({ annotations: { readOnlyHint: true, destructiveHint: false } })

  const read = await tooling.call('skill', { name: 'greeting-well' })
  expect(read.ok).toBe(true)
  expect(read.text).toContain('A greeting is one line')
  expect(read.text).not.toContain('description:')
})

test('deleting a plugin folder empties its half of the list, and nothing else notices', async () => {
  expect((await tooling.list()).some((t) => t.name.startsWith('hello'))).toBe(true)

  rmSync(join(dir, 'hello'), { recursive: true, force: true })
  plugins.load()

  const after = await tooling.list()
  expect(after.some((t) => t.name.startsWith('hello'))).toBe(false)

  // And a call the model had already decided on is an observation, not a crash — which is
  // the path invariant 4 takes through the loop.
  const outcome = await tooling.call('hello__greet', { who: 'Vaclav' })
  expect(outcome.ok).toBe(false)
  expect(outcome.text).toContain('hello__greet')
})

test('a skill bundled with a plugin goes when the plugin does', async () => {
  // The folder above was deleted, and with it the only thing that knew this skill existed.
  // Nothing to unregister, no index to invalidate by hand — the next read finds one folder
  // fewer, which is the same mechanism as invariant 4 and the reason it holds for free.
  expect(await tooling.about('skill')).toBeUndefined()
  expect((await tooling.list()).map((t) => t.name)).not.toContain('skill')
})
