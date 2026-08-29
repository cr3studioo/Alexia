// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { CORE_TABS, type Tab } from '../src/panels.js'
import { memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'
import { stage } from './staged.js'

/**
 * The control surface's tab list, assembled (M6-2).
 *
 * The whole of what this proves is that **core does not know what is on that screen**. Core
 * contributes the tabs whose data core owns; every other one is here because a plugin
 * declared a `panel` and somebody enabled it. Installed and not enabled is no tab at all,
 * because a folder appearing is not consent (D73), and deleting the folder takes the tab
 * with it — which is M0-G one screen further in, and the thing M6-G tests with the screen
 * actually open.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-panels-'))
mkdirSync(join(root, 'cache'), { recursive: true })
writeFileSync(join(root, 'cache', 'models.json'), JSON.stringify({ fetchedAt: Date.now(), models: [] }))

/**
 * Two staged plugins: one that declares a panel and one that does not.
 *
 * The panel is added to the staged manifest rather than to the plugin, because what is being
 * tested is core's side of the field. The plugins that declare real panels are M6-6 to M6-8,
 * and by then this test is already holding the mechanism still.
 */
const from = stage('hello', 'crasher')
const paneled = join(from, 'hello', 'plugin.json')
writeFileSync(
  paneled,
  JSON.stringify(
    {
      ...(JSON.parse(readFileSync(paneled, 'utf8')) as Record<string, unknown>),
      alexia_protocol: 3,
      panel: {
        label: 'Greetings',
        widgets: [{ key: 'panel_state', type: 'status', label: 'State' }],
      },
    },
    null,
    2,
  ),
)

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

const call = (path: string, body?: unknown): Promise<Response> =>
  fetch(new URL(path, alexia.url), {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
  })

const tabs = async (): Promise<Tab[]> => ((await (await call('/api/panels')).json()) as { tabs: Tab[] }).tabs

test('core contributes the tabs whose data core owns, and every one of them holds something', async () => {
  const list = await tabs()
  expect(list.filter((tab) => tab.from === 'core').map((tab) => tab.id)).toEqual(CORE_TABS.map((tab) => tab.id))

  // Either a panel, or a sentence saying what it will hold and which task builds it. Never
  // both and never neither: a blank tab is indistinguishable from a broken one, and a
  // placeholder that looked like working software would be worse than either.
  for (const tab of list.filter((one) => one.from === 'core')) {
    const built = (tab.widgets ?? []).length > 0
    expect(built !== (typeof tab.soon === 'string'), tab.id).toBe(true)
  }
})

test('a plugin that is installed and not enabled has no tab at all', async () => {
  // Not a greyed-out one. A folder appearing is not consent (D73), and a tab that is there
  // and does nothing is a question rather than an answer.
  expect((await tabs()).some((tab) => tab.from === 'plugin')).toBe(false)
})

test('enabling it puts its tab on the screen, with the widgets it declared', async () => {
  await call('/api/plugin', { id: 'hello', action: 'enable' })

  const mine = (await tabs()).filter((tab) => tab.from === 'plugin')
  expect(mine).toHaveLength(1)
  // The label is the plugin's, and core never wrote it down anywhere.
  expect(mine[0]?.label).toBe('Greetings')
  expect(mine[0]?.widgets?.map((w) => w.key)).toEqual(['panel_state'])

  // Enabled and not running is the ordinary state under lazy spawn, and the screen is told
  // so rather than left to guess: drawing this list started nothing.
  expect(mine[0]?.running).toBe(false)
})

test('a plugin with no panel gets no tab, and is not asked to explain itself', async () => {
  await call('/api/plugin', { id: 'crasher', action: 'enable' })
  const mine = (await tabs()).filter((tab) => tab.from === 'plugin')
  expect(mine.map((tab) => tab.plugin)).toEqual(['hello'])
})

test('deleting the plugin takes its tab with it', async () => {
  // The M6-G shape, without the browser. Nothing in core knew the tab's name, so there is
  // nothing in core to clean up — which is the entire point of the tab list being assembled.
  await call('/api/plugin', { id: 'hello', action: 'delete', confirm: true })

  const list = await tabs()
  expect(list.some((tab) => tab.from === 'plugin')).toBe(false)
  expect(list.map((tab) => tab.id)).toEqual(CORE_TABS.map((tab) => tab.id))
})

test('a panel declared against an older revision is refused where it stands', async () => {
  // `panel` arrived in alexia_protocol 3 (D86). Declaring it while claiming 2 is a load
  // error, because an integer a manifest can quietly ignore is an integer that means
  // nothing — and it is caught at the folder rather than found later as a missing tab.
  const backdated = mkdtempSync(join(tmpdir(), 'alexia-backdated-'))
  const folder = join(backdated, 'hello')
  mkdirSync(folder)
  writeFileSync(
    join(folder, 'plugin.json'),
    JSON.stringify({
      ...(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'plugins', 'hello', 'plugin.json'), 'utf8')) as Record<string, unknown>),
      alexia_protocol: 2,
      panel: { label: 'Nope', widgets: [{ key: 'panel_state', type: 'status', label: 'State' }] },
    }),
  )

  const said = (await (await call('/api/install', { path: folder })).json()) as { ok: boolean; said: string }
  expect(said.ok).toBe(false)
  expect(said.said).toContain('alexia_protocol')
  expect((await tabs()).some((tab) => tab.from === 'plugin')).toBe(false)

  rmSync(backdated, { recursive: true, force: true })
})
