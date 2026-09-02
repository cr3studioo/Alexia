// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'
import { noPolling, stage } from './staged.js'

/**
 * The panel for a plugin core has never heard of (M6-8).
 *
 * **This is `plugins/hello`'s job at the level of a screen.** Hello proves the wire carries
 * anything; this proves the control surface does. Every other panel in M6 attaches to
 * something core already ships, which means any of them could have been quietly
 * special-cased and still passed. This one cannot: `plugins/commitments` was written after
 * the panel mechanism, from the documents, and its tab appears because its manifest says so.
 *
 * The check at the bottom is the one that matters — the word does not appear in core or in
 * the shell, anywhere.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-commitments-'))
mkdirSync(join(root, 'cache'), { recursive: true })
noPolling(root)

const from = stage('commitments')

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

const ledger = async (): Promise<Row[]> =>
  ((await post('/api/rows', { plugin: 'commitments', key: 'ledger_list' })).rows ?? []) as Row[]

await post('/api/plugin', { id: 'commitments', action: 'enable' })

test('a plugin nobody built the screen for gets a panel, and its own words on it', async () => {
  const { panes } = (await (
    await fetch(new URL('/api/plugins', alexia.url), { headers: { 'x-alexia-token': alexia.token } })
  ).json()) as { panes: { id: string; panel?: { label: string; widgets: { type: string; key: string }[] } }[] }

  const mine = panes.find((pane) => pane.id === 'commitments')
  expect(mine?.panel?.label).toBe('Commitments')
  expect(mine?.panel?.widgets.map((widget) => `${widget.type}:${widget.key}`)).toEqual(['table:ledger_list'])
}, 20_000)

test('the ledger fills itself from the plugin, grouped the way the plugin decided', async () => {
  // Written the way the plugin writes them — the namespace exists because enabling it made
  // it, which is D73's line in one sentence.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  alexia.store.insert('commitments', 'promises', {
    text: 'Send the grant draft',
    by: yesterday,
    mine: 1,
    state: 'open',
    nudges: 2,
    at: Date.now(),
  })
  alexia.store.insert('commitments', 'promises', {
    text: 'Call the bank',
    mine: 0,
    state: 'kept',
    nudges: 0,
    at: Date.now(),
  })

  const rows = await ledger()
  expect(rows).toHaveLength(2)

  const late = rows.find((row) => String(row.text).includes('grant'))
  expect(late?.group).toBe('Overdue')
  expect(String(late?.state)).toBe('▲ overdue')
  // The field that makes this more than a to-do list: whose idea it was.
  expect(late?.whose).toBe('yours')
  expect(rows.find((row) => String(row.text).includes('bank'))?.whose).toBe('asked of you')
  expect(rows.find((row) => String(row.text).includes('bank'))?.group).toBe('Closed')
}, 20_000)

test('the detail says how often it has been raised, which is the point of counting', async () => {
  const [late] = (await ledger()).filter((row) => String(row.text).includes('grant'))
  const detail = await post('/api/detail', { plugin: 'commitments', key: 'ledger_list', row: String(late?.id) })
  expect(detail.ok).toBe(true)
  // *This is the third time* is what makes raising it again either fair or unkind, and it
  // is the person's call which.
  expect(String(detail.text)).toContain('raised 2 times')
  expect(String(detail.text)).toContain('was due')
}, 20_000)

test('the panel is read-only, on purpose', () => {
  // The assistant records a commitment in the conversation where it was said, and closes it
  // the same way. A second way in from a table would be a parallel mechanism into a record
  // whose whole value is that it only ever grows.
  const manifest = JSON.parse(readFileSync(join(from, 'commitments', 'plugin.json'), 'utf8')) as {
    panel: { widgets: { rowActions?: unknown }[] }
  }
  expect(manifest.panel.widgets[0]?.rowActions).toBeUndefined()
})

test('neither core nor the shell contains the word', () => {
  // The whole of M6's claim, checked against the one plugin that could not have been
  // special-cased because it did not exist when the screen was written. Invariant 1 does
  // this for every plugin on every run; this says it here, where it is the subject.
  const repo = join(import.meta.dirname, '..', '..', '..')
  const files = [
    join('packages', 'core', 'src', 'panels.ts'),
    join('packages', 'core', 'src', 'surface.ts'),
    join('packages', 'core', 'src', 'serve.ts'),
    join('packages', 'ui', 'src', 'control.ts'),
    join('packages', 'ui', 'src', 'widgets.ts'),
    join('packages', 'ui', 'index.html'),
  ]
  for (const file of files) {
    expect(readFileSync(join(repo, file), 'utf8'), file).not.toContain('commitments')
  }
})
