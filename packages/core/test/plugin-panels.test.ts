// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'
import { noPolling, stage } from './staged.js'

/**
 * The two plugin-owned panels, end to end (M6-6, M6-7).
 *
 * These are the first tabs core has never heard the name of, and the thing being held still
 * is that it still has not: the tabs are here because two manifests say so and somebody
 * enabled them. Everything below goes through the same routes a plugin written by a stranger
 * would use — nothing in this file reaches into either plugin.
 *
 * The tests name the plugins because a test is allowed to; invariant 1 reads `packages/core`
 * and `packages/ui`, which is where naming one would actually matter.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-plugin-panels-'))
mkdirSync(join(root, 'cache'), { recursive: true })
noPolling(root)

const from = stage('voice', 'memory')

const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  pluginsDir: from,
  secrets: memorySecrets(),
})

afterAll(async () => {
  await alexia.close()
  for (const path of [from, root]) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

interface Row {
  id: string
  [field: string]: unknown
}

const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
  (await (
    await fetch(new URL(path, alexia.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
      body: JSON.stringify(body),
    })
  ).json()) as Record<string, unknown>

const rows = async (plugin: string, key: string): Promise<Row[]> =>
  ((await post('/api/rows', { plugin, key })).rows ?? []) as Row[]

interface Tab {
  label: string
  plugin?: string
  running?: boolean
  widgets?: { type: string; key: string }[]
}
const tabs = async (): Promise<Tab[]> =>
  ((await (
    await fetch(new URL('/api/panels', alexia.url), { headers: { 'x-alexia-token': alexia.token } })
  ).json()) as { tabs: Tab[] }).tabs

test('two plugins declare two tabs, and neither is enabled yet so neither is there', async () => {
  expect((await tabs()).some((tab) => tab.plugin !== undefined)).toBe(false)

  await post('/api/plugin', { id: 'voice', action: 'enable' })
  await post('/api/plugin', { id: 'memory', action: 'enable' })

  const mine = (await tabs()).filter((tab) => tab.plugin !== undefined)
  expect(mine.map((tab) => tab.label).sort()).toEqual(['Memory', 'Voice'])
  // Both drew from their manifests with their processes stopped, which is what lets this
  // screen exist at all under lazy spawn.
  expect(mine.every((tab) => tab.running === false)).toBe(true)
})

test('the voice panel lists every voice this machine could speak in', async () => {
  const voices = await rows('voice', 'voices')
  // The three published ones are always offered, downloaded or not: *not downloaded* is a
  // state somebody can act on and an absence is not.
  expect(voices.map((row) => row.name).sort()).toEqual(['amy', 'lessac', 'ryan'])
  expect(voices.filter((row) => String(row.state).includes('speaking'))).toHaveLength(1)
}, 20_000)

test('picking a voice sticks, and removing a published one is refused with the reason', async () => {
  const picked = await post('/api/action', { plugin: 'voice', key: 'use_voice', row: 'ryan', approved: true })
  expect(picked.ok).toBe(true)

  const after = await rows('voice', 'voices')
  expect(String(after.find((row) => row.name === 'ryan')?.state)).toContain('speaking')
  expect(String(after.find((row) => row.name === 'lessac')?.state)).not.toContain('speaking')

  // A published voice is downloaded, so removing it only means fetching it again — and
  // saying that is more use than a button that is simply missing.
  const refused = await post('/api/action', { plugin: 'voice', key: 'drop_voice', row: 'amy', approved: true })
  expect(refused.ok).toBe(false)
  expect(String(refused.said)).toContain('published voices')
}, 20_000)

test('the memory panel forgets exactly the row it was pointed at', async () => {
  // Written the way the plugin writes them, into the namespace enabling it created.
  for (const [text, kind] of [
    ['Vaclav’s grant deadline is in March', 'fact'],
    ['He prefers short answers', 'preference'],
    ['His sister is called Marta', 'person'],
  ]) {
    alexia.store.insert('memory', 'facts', { text, kind, at: Date.now() })
  }

  const remembered = await rows('memory', 'remembered_list')
  expect(remembered).toHaveLength(3)
  // Grouped by what sort of thing it is, which is the only structure this store has.
  expect(remembered.map((row) => row.kind).sort()).toEqual(['fact', 'person', 'preference'])

  const going = remembered.find((row) => String(row.text).includes('Marta'))
  expect(going).toBeDefined()

  // `forget` already existed and takes *words from the thing to forget*, which is right in a
  // conversation and wrong on a screen: here the person is pointing at a row. So this takes
  // the row, and no best-match guess stands between what they pointed at and what goes.
  const gone = await post('/api/action', { plugin: 'memory', key: 'forget_one', row: String(going?.id), approved: true })
  expect(gone.ok).toBe(true)
  expect(String(gone.said)).toContain('Marta')

  const left = await rows('memory', 'remembered_list')
  expect(left.map((row) => row.text)).toEqual(['He prefers short answers', 'Vaclav’s grant deadline is in March'])
}, 20_000)

test('a detail is the whole sentence, because a column has to truncate and this does not', async () => {
  const [one] = await rows('memory', 'remembered_list')
  const detail = await post('/api/detail', { plugin: 'memory', key: 'remembered_list', row: String(one?.id) })
  expect(detail.ok).toBe(true)
  expect(String(detail.text)).toContain('Written down')
}, 20_000)

test('deleting a plugin takes its tab with it, and the other one is untouched', async () => {
  // M6-G's shape with two plugins installed, which is the case where a tab list that was
  // written by hand somewhere would take the wrong one.
  await post('/api/plugin', { id: 'memory', action: 'delete', confirm: true })

  const left = await tabs()
  expect(left.filter((tab) => tab.plugin !== undefined).map((tab) => tab.label)).toEqual(['Voice'])
  // And the one that stayed still answers, so nothing was torn down with it.
  expect((await rows('voice', 'voices')).length).toBeGreaterThan(0)
}, 20_000)
