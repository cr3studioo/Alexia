// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'
import { noPolling, stage } from './staged.js'

/**
 * The two plugin-owned panels, end to end (M6-6, M6-7; on their own pages since D118).
 *
 * These are the first panels core has never heard the name of, and the thing being held still
 * is that it still has not: they are here because two manifests say so and somebody enabled
 * them. Everything below goes through the same routes a plugin written by a stranger would
 * use — nothing in this file reaches into either plugin.
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

interface Pane {
  id: string
  settings: { type: string; key: string; gates?: boolean }[]
  enabled: boolean
  running: boolean
  panel?: { label: string; widgets: { type: string; key: string; value?: unknown }[] }
}
const panes = async (): Promise<Pane[]> =>
  ((await (
    await fetch(new URL('/api/plugins', alexia.url), { headers: { 'x-alexia-token': alexia.token } })
  ).json()) as { panes: Pane[] }).panes

const paneled = async (): Promise<Pane[]> => (await panes()).filter((pane) => pane.enabled && pane.panel !== undefined)

test('two plugins declare two panels, and neither is enabled yet so neither is drawn', async () => {
  expect(await paneled()).toEqual([])

  await post('/api/plugin', { id: 'voice', action: 'enable' })
  await post('/api/plugin', { id: 'memory', action: 'enable' })

  const mine = await paneled()
  expect(mine.map((pane) => pane.panel?.label).sort()).toEqual(['Memory', 'Voice'])
  // Both drew from their manifests with their processes stopped, which is what lets these
  // pages exist at all under lazy spawn.
  expect(mine.every((pane) => !pane.running)).toBe(true)
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

test('the map is the same notes, with the links the sorter wrote (M6-11)', async () => {
  // Two notes and a link between them, written the way the sorter writes them: a link is a
  // note's *name*, and the panel needs something it can hand back to `about_memory`.
  const at = Date.now()
  alexia.store.insert('memory', 'facts', {
    name: 'The grant',
    text: 'The grant is the thing everything else this month hangs off',
    kind: 'other',
    links: '[]',
    source: 'stated',
    at,
  })
  alexia.store.insert('memory', 'facts', {
    name: 'The grant deadline',
    text: 'The grant deadline is in March',
    kind: 'fact',
    links: JSON.stringify(['The grant']),
    // Worked out rather than said, which is what the ring on the map means.
    source: 'inferred',
    at: at + 1,
  })

  const mine = (await panes()).find((one) => one.id === 'memory')
  // Declared by the plugin, drawn by core: the shell has one more widget type and still no
  // idea which plugin asked for one.
  expect(mine?.panel?.widgets.map((widget) => widget.type)).toEqual(['graph', 'table'])

  const nodes = await rows('memory', 'remembered_map')
  const child = nodes.find((row) => row.label === 'The grant deadline')
  const parent = nodes.find((row) => row.label === 'The grant')
  expect(child?.links).toEqual([String(parent?.id)])
  expect(child?.mark).toBe(true)
  expect(parent?.mark).toBe(false)

  // Every link points at a node that is on the map. Half an edge is a lie about the shape,
  // and the plugin drops one rather than drawing it to nowhere.
  const there = new Set(nodes.map((row) => String(row.id)))
  expect(nodes.flatMap((row) => row.links as string[]).filter((id) => !there.has(id))).toEqual([])

  // The same tool the table's rows expand through, reached from a node instead of a row.
  const detail = await post('/api/detail', { plugin: 'memory', key: 'remembered_map', row: String(child?.id) })
  expect(detail.ok).toBe(true)
  expect(String(detail.text)).toContain('Filed under: The grant')
}, 20_000)

test('a detail is the whole sentence, because a column has to truncate and this does not', async () => {
  const [one] = await rows('memory', 'remembered_list')
  const detail = await post('/api/detail', { plugin: 'memory', key: 'remembered_list', row: String(one?.id) })
  expect(detail.ok).toBe(true)
  expect(String(detail.text)).toContain('Written down')
}, 20_000)

/**
 * The `file` widget, end to end — and the thing D89 said could not be done.
 *
 * *A browser will not tell a page where a file is*, so this does not ask: bytes go up, core
 * writes them inside the plugin's own folder, and **the value the plugin reads is a path core
 * made**. Which is why the plugin side of `add_voice` needed no change at all — it takes a
 * path, exactly as it did when somebody had to type one.
 */
test('a file chosen in the page becomes a path the plugin can read', async () => {
  const bytes = Buffer.from('not really an onnx, and this route does not care')
  const put = await post('/api/upload', {
    plugin: 'voice',
    key: 'add_voice',
    name: 'en_US-someone-medium.onnx',
    data: bytes.toString('base64'),
  })
  expect(put.ok).toBe(true)
  // The person's own name for it, not a timestamp: Piper names a voice after its file, so a
  // widget that renamed it would have thrown away the one thing the filename carried.
  expect(basename(String(put.path))).toBe('en_US-someone-medium.onnx')
  expect(readFileSync(String(put.path))).toEqual(bytes)
  // Inside the asking plugin's own folder, which is what makes invariant 5 keep holding: the
  // purge that takes the folder takes this with it.
  expect(String(put.path).startsWith(join(root, 'plugins', 'voice'))).toBe(true)

  // And it is the widget's value now, which is the whole point — the plugin reads a path.
  const pane = (await panes()).find((one) => one.id === 'voice')
  const widget = pane?.panel?.widgets.find((one) => one.key === 'add_voice') as { value?: string } | undefined
  expect(widget?.value).toBe(String(put.path))

  // One widget holds one file. A second choice replaces the first rather than accumulating a
  // folder of every recording anybody ever cloned from.
  const again = await post('/api/upload', { plugin: 'voice', key: 'add_voice', name: 'other.onnx', data: bytes.toString('base64') })
  expect(again.ok).toBe(true)
  expect(existsSync(String(put.path))).toBe(false)

  // The ceilings are `attach.ts`'s, unchanged, because this is the same seam.
  const empty = await post('/api/upload', { plugin: 'voice', key: 'add_voice', name: 'nothing.onnx', data: '' })
  expect(empty.ok).toBe(false)
  expect(String(empty.why)).toContain('empty')

  // And a widget that does not take a file says so rather than quietly storing a path.
  const wrong = await post('/api/upload', { plugin: 'voice', key: 'preview_text', name: 'x.wav', data: bytes.toString('base64') })
  expect(wrong.ok).toBe(false)
  expect(String(wrong.why)).toContain('does not take a file')
}, 20_000)

/**
 * Choosing an engine changes which widgets are on the page (`alexia_protocol` 7).
 *
 * The page this arrived to fix showed nineteen widgets of which four applied. What is being
 * held still is that a widget belonging to an engine nobody picked is **not on the page** —
 * not greyed, not disabled, absent — and that the widget deciding it says so, because a save
 * that changes the shape of a page has to redraw it and the shell is told by core rather than
 * by guessing.
 */
test('picking an engine decides which widgets the page has at all', async () => {
  const keys = async (): Promise<string[]> =>
    ((await panes()).find((one) => one.id === 'voice')?.panel?.widgets ?? []).map((one) => one.key)

  const local = await keys()
  expect(local).toContain('add_voice')
  expect(local).not.toContain('clip')
  expect(local).not.toContain('catalogue')

  const saved = await post('/api/settings', { plugin: 'voice', key: 'engine', value: 'fish_plain' })
  expect(saved.ok).toBe(true)

  const cloud = await keys()
  expect(cloud).toContain('clip')
  expect(cloud).toContain('catalogue')
  expect(cloud).not.toContain('add_voice')

  // Core marks the widget the rest of the page turns on, so the shell knows to redraw after
  // a save it otherwise deliberately never redraws for.
  const engine = (await panes()).find((one) => one.id === 'voice')?.settings.find((one) => one.key === 'engine')
  expect(engine).toMatchObject({ gates: true })
  // The cloud engines are dimmed with the author's own sentence until there is a key.
  const options = (engine as { options?: { value: string; available?: boolean; reason?: string }[] }).options ?? []
  expect(options.find((one) => one.value === 'fish_plain')).toMatchObject({ available: false })
  expect(options.find((one) => one.value === 'piper')?.available).toBeUndefined()

  await post('/api/settings', { plugin: 'voice', key: 'engine', value: 'piper' })
}, 20_000)

test('deleting a plugin takes its page with it, and the other one is untouched', async () => {
  // M6-G's shape with two plugins installed, which is the case where a list that was written
  // by hand somewhere would take the wrong one.
  await post('/api/plugin', { id: 'memory', action: 'delete', confirm: true })

  expect((await paneled()).map((pane) => pane.panel?.label)).toEqual(['Voice'])
  // And the one that stayed still answers, so nothing was torn down with it.
  expect((await rows('voice', 'voices')).length).toBeGreaterThan(0)
}, 20_000)
