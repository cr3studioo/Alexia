// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { CORE_TABS, type Tab } from '../src/panels.js'
import { memorySecrets } from '../src/secrets.js'
import type { Pane } from '../src/settings.js'
import { serve, type Serving } from '../src/serve.js'
import { noPolling, stage } from './staged.js'

/**
 * Where a plugin's `panel` goes, and where it does not (M6-2, D118).
 *
 * The whole of what this proves is that **core does not know what is on either screen**. The
 * control surface holds the tabs whose data core owns and nothing else; a plugin's panel is
 * the second half of its own page, there because a manifest says so and somebody enabled it,
 * and gone when the folder is. Nowhere does a person type a plugin's name.
 *
 * D118 is why the second half of that sentence changed screens. A plugin used to have a tab
 * here *and* a settings pane there, so *where do I go to use this thing* had two answers and
 * neither screen said which. One page now, and this file holds the split still: enabling puts
 * the widgets on the page, and nothing ever puts them on a tab.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-panels-'))
mkdirSync(join(root, 'cache'), { recursive: true })
noPolling(root)

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

const panes = async (): Promise<Pane[]> => ((await (await call('/api/plugins')).json()) as { panes: Pane[] }).panes

const mine = async (id: string): Promise<Pane | undefined> => (await panes()).find((pane) => pane.id === id)

test('core contributes the tabs whose data core owns, and every one of them holds something', async () => {
  const list = await tabs()
  expect(list.map((tab) => tab.id)).toEqual(CORE_TABS.map((tab) => tab.id))

  // Either a panel, or a sentence saying what it will hold and which task builds it. Never
  // both and never neither: a blank tab is indistinguishable from a broken one, and a
  // placeholder that looked like working software would be worse than either.
  for (const tab of list) {
    const built = (tab.widgets ?? []).length > 0
    expect(built !== (typeof tab.soon === 'string'), tab.id).toBe(true)
  }
})

test('a plugin that is installed and not enabled is a walkthrough, not a panel', async () => {
  // A folder appearing is not consent (D73). Core hands over what the manifest declared —
  // it has nothing else to hand over — and the page draws neither half until the yes is
  // given, because configuring something you have not agreed to run asks two questions at
  // once.
  const hello = await mine('hello')
  expect(hello?.enabled).toBe(false)
  expect(hello?.settings.length).toBeGreaterThan(0)
  expect(hello?.panel?.widgets.map((one) => one.key)).toEqual(['panel_state'])
})

test('enabling it puts the panel on the plugin’s own page, with the widgets it declared', async () => {
  await call('/api/plugin', { id: 'hello', action: 'enable' })

  const hello = await mine('hello')
  expect(hello?.enabled).toBe(true)
  // The label is the plugin's, and core never wrote it down anywhere.
  expect(hello?.panel?.label).toBe('Greetings')
  expect(hello?.panel?.widgets.map((one) => one.key)).toEqual(['panel_state'])

  // Enabled and not running is the ordinary state under lazy spawn, and the page is told so
  // rather than left to guess: drawing it started nothing.
  expect(hello?.running).toBe(false)
})

test('and it is on that page only — the control surface stays core’s own (D118)', async () => {
  // The property the move exists for. A tab here and a pane there was two homes for one
  // plugin, and neither screen said which held the thing somebody was after. `Greetings`
  // exists and is enabled; it is simply not on this list, and never will be.
  const list = await tabs()
  expect(list.map((tab) => tab.id)).toEqual(CORE_TABS.map((tab) => tab.id))
  expect(list.some((tab) => tab.label === 'Greetings')).toBe(false)
})

test('a plugin with no panel gets no second half, and is not asked to explain itself', async () => {
  await call('/api/plugin', { id: 'crasher', action: 'enable' })
  expect((await mine('crasher'))?.panel).toBeUndefined()
})

test('deleting the plugin takes its page with it', async () => {
  // The M6-G shape, without the browser. Nothing in core knew the panel's name, so there is
  // nothing in core to clean up — which is the entire point of the page being assembled.
  await call('/api/plugin', { id: 'hello', action: 'delete', confirm: true })

  expect(await mine('hello')).toBeUndefined()
  expect((await tabs()).map((tab) => tab.id)).toEqual(CORE_TABS.map((tab) => tab.id))
})

test('a panel declared against an older revision is refused where it stands', async () => {
  // `panel` arrived in alexia_protocol 3 (D86). Declaring it while claiming 2 is a load
  // error, because an integer a manifest can quietly ignore is an integer that means
  // nothing — and it is caught at the folder rather than found later as a missing half.
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
  expect(await mine('hello')).toBeUndefined()

  rmSync(backdated, { recursive: true, force: true })
})
