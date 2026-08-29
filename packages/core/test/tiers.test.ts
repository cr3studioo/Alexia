// SPDX-License-Identifier: AGPL-3.0-only
import { Manifest } from '@alexia/protocol'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { Host } from '../src/host.js'
import { memorySecrets } from '../src/secrets.js'
import { PluginProcess } from '../src/supervisor.js'
import { Store } from '../src/store.js'

/**
 * M7-6's acceptance, from core's side: **a recorded sequence replays with zero rows added to
 * `usage`.**
 *
 * The other half of that sentence — *proven by a check that the module cannot reach the
 * provider layer at all* — is in `plugins/computer/test/replay.test.js`, where it belongs,
 * because it is a fact about that module's imports. This is the same claim measured from the
 * outside: a real plugin process, the real `alexia/*` layer, and a `sample` that records
 * every time anything asks for a model. It is never called, and the ledger stays empty.
 */

const dir = join(import.meta.dirname, '..', '..', '..', 'plugins', 'computer')
const manifest = Manifest.parse(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')))
const root = mkdtempSync(join(tmpdir(), 'alexia-tiers-'))
const store = new Store(join(root, 'alexia.db'))
store.create(manifest.id, manifest.storage?.tables ?? [])

/** Every time anything asks for a model. The whole test is that this stays empty. */
const sampled: string[] = []

const host = new Host({
  store,
  dataDir: root,
  secrets: memorySecrets(),
  manifest: (id) => (id === manifest.id ? manifest : undefined),
  sample: (id) => {
    sampled.push(id)
    return Promise.resolve({ model: 'stub', role: 'assistant', content: { type: 'text', text: 'no' } })
  },
})

const plugin = new PluginProcess(manifest, dir, host)
afterAll(async () => {
  await plugin.stop()
  store.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const result = await plugin.callTool(name, args)
  return (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('')
}

test('a sequence is recorded out of the log that was already being written', async () => {
  // Only `wait` steps, on purpose: this test runs on a real machine, and a replay that moved
  // the mouse would be a test that moves somebody's mouse.
  for (let i = 0; i < 3; i += 1) {
    store.insert('computer', 'actions', {
      what: 'wait',
      detail: '',
      step: JSON.stringify({ do: 'wait', ms: 0 }),
      at: Date.now() + i,
    })
  }

  expect(await call('save_plan', { name: 'the usual', steps: 3 })).toContain('3 steps')
  // The row says what it costs, because that is the thing this whole task is about.
  expect(await call('plans')).toContain('1 plans')
  const rows = (await plugin.callTool('plans', {})).structuredContent as { rows: Record<string, unknown>[] }
  expect(rows.rows[0]).toMatchObject({ name: 'the usual', steps: 3, cost: 'nothing — no model in the path' })

  // Recording asked nothing of anybody. The log was already there.
  expect(sampled).toEqual([])
}, 30_000)

test('replaying it adds not one row to the ledger', async () => {
  store.setSetting('computer', 'allow_input', true)
  sampled.length = 0

  const said = await call('replay_plan', { name: 'the usual' })
  if (process.platform === 'win32') {
    expect(said).toContain('costing nothing')
    expect(said).toContain('3 steps')
  } else {
    // Windows only so far, and that is a sentence rather than a silence. The claim below is
    // measured either way: nothing asked for a model on this path.
    expect(said).toContain(process.platform)
  }

  // The acceptance, in one line. Not *cheap* — none.
  expect(sampled).toEqual([])
  expect(store.spend(0)).toBe(0)
}, 30_000)

test('a plan naming something the registry does not hold never reaches the machine', async () => {
  // Written straight into the plugin's own store, which is the worst case: somebody editing
  // a plan by hand. It is data, and it stays data.
  store.kvSet('computer', 'plans', { bad: [{ do: 'powershell', script: 'whatever' }] })
  const said = await call('replay_plan', { name: 'bad' })
  expect(said).toContain('not something a plan can do')
  expect(sampled).toEqual([])
}, 30_000)
