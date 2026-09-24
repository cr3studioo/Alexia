// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import { PLUGIN_PAGE, withoutGone, type Layout } from '../src/layout.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'
import { Store } from '../src/store.js'
import { noPolling, stage } from './staged.js'

/**
 * **M10-G, core's half**: the board with no plugins, one arriving, switched off, deleted by
 * hand, and one that crashed (D204).
 *
 * Driven over the same HTTP the shell uses, with this test standing in for the shell where the
 * shell would write — it saves the layout the way `board.ts` does, through `/api/setup`. What
 * is checked is what core keeps and what core says: the panes the board draws plugin pages
 * from, and the `layout` in kv. Where a page lands on the dots is `packages/ui`'s to test.
 *
 * Naming plugins is fine here — invariant 1 is about `packages/core/src`.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-board-'))
noPolling(root)
// Where plugins come from: the real voice manifest, and the crasher given a page and told to
// die before it answers — resident, so switching it on is what starts it.
const from = stage('voice', 'crasher')
const crasherJson = join(from, 'crasher', 'plugin.json')
const crasher = JSON.parse(readFileSync(crasherJson, 'utf8')) as Record<string, unknown> & { entry: { args: string[] } }
crasher.entry.args.push('--die-on-start')
Object.assign(crasher, {
  alexia_protocol: 12,
  lifetime: 'resident',
  settings: [{ type: 'toggle', key: 'loud', label: 'Loud' }],
  page: { title: 'Crasher', sizes: { S: { at: [8, 4], show: ['loud'] } } },
})
writeFileSync(crasherJson, JSON.stringify(crasher, null, 2))

// And where they are installed to: empty, as `plugins/` is on a fresh machine.
const extensions = mkdtempSync(join(tmpdir(), 'alexia-board-ext-'))

/** A board somebody arranged once, when a plugin that is long gone was still here. */
const arranged: Layout = {
  v: 1,
  cols: 52,
  guides: [11, 38],
  pages: [
    { id: 'general', w: 11, h: 30, anchor: { x: 0, y: 0 } },
    { id: 'chat', w: 26, h: 30, anchor: { x: 12, y: 0 } },
    { id: 'local-stats', w: 13, h: 10, anchor: { x: 39, y: 0 } },
    { id: `${PLUGIN_PAGE}long-gone`, w: 12, h: 10, anchor: { x: 39, y: 11 } },
  ],
}
{
  const before = new Store(join(root, 'alexia.db'))
  before.kvSet(CORE, 'layout', arranged)
  before.close()
}

const alexia: Serving = await serve({ dataDir: root, pluginsDir: extensions, secrets: memorySecrets(), local: false })
afterAll(async () => {
  await alexia.close()
  for (const path of [root, from, extensions]) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch (error) {
      // Say which files are still held, and by nothing this test can see: the folder alone is
      // not enough to find a handle left open on Windows.
      throw new Error(`${String(error)}\nstill held: ${held(path).join(', ') || '(only the folder)'}`, { cause: error })
    }
  }
}, 30_000)

/** Every file and folder under `dir` that cannot be deleted, deepest first. */
function held(dir: string): string[] {
  const stuck: string[] = []
  for (const name of readdirSync(dir, { recursive: true }).map(String).sort((a, b) => b.length - a.length)) {
    try {
      rmSync(join(dir, name), { recursive: true, force: true })
    } catch {
      stuck.push(name)
    }
  }
  return stuck
}

const call = (path: string, body?: unknown): Promise<Response> =>
  fetch(new URL(path, alexia.url), {
    ...(body !== undefined && { method: 'POST', body: JSON.stringify(body) }),
    headers: { 'x-alexia-token': alexia.token, 'content-type': 'application/json' },
  })

interface Pane {
  id: string
  enabled: boolean
  state?: string
  reason?: string
  page: { title: string; sizes: Record<string, { at: number[]; show: string[] }> } | null
}
const panes = async (): Promise<Pane[]> => ((await (await call('/api/plugins')).json()) as { panes: Pane[] }).panes
const paneOf = async (id: string): Promise<Pane | undefined> => (await panes()).find((one) => one.id === id)
const layout = async (): Promise<Layout | null> => ((await (await call('/api/state')).json()) as { layout: Layout | null }).layout
const ids = async (): Promise<string[]> => ((await layout())?.pages ?? []).map((p) => p.id)

const voicePage = `${PLUGIN_PAGE}voice`

test('with nothing installed: no plugin pages, the core pages kept, and a gone plugin’s id pruned at start', async () => {
  expect(await panes()).toEqual([])
  expect((await call('/api/local-stats')).status).toBe(200)
  // The page of a plugin that was deleted while Alexia was closed is not in the kept layout,
  // and nothing else of the arrangement moved.
  expect(await layout()).toEqual({ ...arranged, pages: arranged.pages.filter((p) => !p.id.startsWith(PLUGIN_PAGE)) })
})

test('installing voice and switching it on: its page is on its pane, declared in its manifest', async () => {
  const installed = (await (await call('/api/install', { path: join(from, 'voice') })).json()) as { ok: boolean }
  expect(installed.ok).toBe(true)
  // Installed and not enabled: the page is declared, and the board draws it only once enabled.
  expect((await paneOf('voice'))?.enabled).toBe(false)
  expect((await paneOf('voice'))?.page?.title).toBe('Voice in/out')

  expect(((await (await call('/api/plugin', { id: 'voice', action: 'enable' })).json()) as { ok: boolean }).ok).toBe(true)
  const voice = await paneOf('voice')
  expect(voice?.enabled).toBe(true)
  expect(voice?.page?.sizes.M?.at).toEqual([12, 8])

  // The shell adds it unanchored — the first free spot — and saves; core keeps it as sent.
  const current = (await layout())!
  const saved = await call('/api/setup', { layout: { ...current, pages: [...current.pages, { id: voicePage, w: 12, h: 8 }] } })
  expect(saved.status).toBe(200)
  expect(await ids()).toContain(voicePage)
})

test('switched off: the page is not drawn, and its spot is kept', async () => {
  // Where the person put it, so there is a spot to keep.
  const current = (await layout())!
  const placed = current.pages.map((p) => (p.id === voicePage ? { ...p, anchor: { x: 39, y: 11 } } : p))
  expect((await call('/api/setup', { layout: { ...current, pages: placed } })).status).toBe(200)

  await call('/api/plugin', { id: 'voice', action: 'disable' })
  expect((await paneOf('voice'))?.enabled).toBe(false)
  // A reload of the folder — anything that touches it — does not take a disabled plugin's spot.
  await call('/api/install', { path: join(from, 'voice') })
  expect((await layout())?.pages.find((p) => p.id === voicePage)).toEqual({ id: voicePage, w: 12, h: 8, anchor: { x: 39, y: 11 } })

  await call('/api/plugin', { id: 'voice', action: 'enable' })
  expect((await layout())?.pages.find((p) => p.id === voicePage)?.anchor).toEqual({ x: 39, y: 11 })
})

test('the folder deleted by hand: the plugin is gone, and layout keeps no id for it', async () => {
  rmSync(join(extensions, 'voice'), { recursive: true, force: true })
  // The folder watcher notices, with no window asking.
  await vi.waitFor(async () => expect(await paneOf('voice')).toBeUndefined(), { timeout: 10_000 })
  await vi.waitFor(async () => expect(await ids()).not.toContain(voicePage), { timeout: 10_000 })
  // Only its page: the rest of the board is exactly where it was.
  expect(await ids()).toEqual(['general', 'chat', 'local-stats'])
})

test('deleted from the screen: the same, without waiting for the watcher', async () => {
  await call('/api/install', { path: join(from, 'voice') })
  await call('/api/plugin', { id: 'voice', action: 'enable' })
  const current = (await layout())!
  await call('/api/setup', { layout: { ...current, pages: [...current.pages, { id: voicePage, w: 12, h: 8 }] } })
  expect(await ids()).toContain(voicePage)

  // Delete asks first (M6-1); `confirm` is the person's yes.
  expect(((await (await call('/api/plugin', { id: 'voice', action: 'delete', confirm: true })).json()) as { ok: boolean }).ok).toBe(true)
  expect(await ids()).not.toContain(voicePage)
})

test('a crashed plugin’s page carries its reason, and Restart clears it', async () => {
  await call('/api/install', { path: join(from, 'crasher') })
  expect((await paneOf('crasher'))?.page?.title).toBe('Crasher')
  await call('/api/plugin', { id: 'crasher', action: 'enable' })

  await vi.waitFor(async () => expect((await paneOf('crasher'))?.state).toBe('unhealthy'), { timeout: 20_000 })
  const off = await paneOf('crasher')
  expect(off?.reason).toContain('stopped 3 times in a minute')
  // Still on its page's terms: the board draws the reason where the widgets would be.
  expect(off?.page).not.toBeNull()

  const restarted = (await (await call('/api/plugin', { id: 'crasher', action: 'restart' })).json()) as { ok: boolean; panes: Pane[] }
  expect(restarted.ok).toBe(true)
  const back = restarted.panes.find((one) => one.id === 'crasher')
  expect(back?.state).toBeUndefined()
  expect(back?.reason).toBeUndefined()
  // Off again before the folders go: a crasher that dies on start is respawned, and on Windows a
  // process still starting holds its folder open when afterAll deletes it.
  await call('/api/plugin', { id: 'crasher', action: 'disable' })
}, 30_000)

test('pruning touches plugin pages whose plugin is not here, and nothing else', () => {
  const here = new Set(['kept'])
  const layout: Layout = {
    v: 1,
    cols: 40,
    guides: [10, 30],
    pages: [
      { id: 'chat', w: 10, h: 10 },
      { id: 'gone-looking-core-id', w: 10, h: 10 },
      { id: `${PLUGIN_PAGE}kept`, w: 10, h: 10 },
      { id: `${PLUGIN_PAGE}gone`, w: 10, h: 10 },
    ],
  }
  expect(withoutGone(layout, here)?.pages.map((p) => p.id)).toEqual(['chat', 'gone-looking-core-id', `${PLUGIN_PAGE}kept`])
  // Nothing to prune is no new layout, so nothing is written.
  expect(withoutGone({ ...layout, pages: layout.pages.slice(0, 3) }, here)).toBeUndefined()
})

test('the plugin page prefix is the one the shell writes', () => {
  const pages = readFileSync(join(import.meta.dirname, '..', '..', 'ui', 'src', 'pages.ts'), 'utf8')
  expect(pages).toContain(`const PLUGIN = '${PLUGIN_PAGE}'`)
})
