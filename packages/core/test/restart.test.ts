// SPDX-License-Identifier: AGPL-3.0-only
import { CORE_CAPABILITIES } from '@alexia/protocol'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import { Plugins } from '../src/plugins.js'
import { memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'
import { DEFAULT_TIMINGS } from '../src/supervisor.js'
import { stage } from './staged.js'

/**
 * Two things a board page reads off core that core did not used to say (D199).
 *
 * - **A plugin the supervisor switched off** arrives on its pane as `state: 'unhealthy'` with
 *   the supervisor's own sentence, and `restart` takes it back to an ordinary stopped plugin.
 *   Disable-then-enable was what the page pressed before, and it cleared nothing.
 * - **How many other ways in are connected**: enabled plugins providing `channel.chat` whose
 *   declared keys are all stored. The board asks before Chat comes off only when it is zero.
 *
 * Naming plugins is fine here — invariant 1 is about `packages/core/src`.
 */

const from = stage('crasher', 'hello')
// The crasher that never gets as far as answering, so three spawns are three stops.
const crasherJson = join(from, 'crasher', 'plugin.json')
const crasher = JSON.parse(readFileSync(crasherJson, 'utf8')) as { entry: { args: string[] } }
crasher.entry.args.push('--die-on-start')
writeFileSync(crasherJson, JSON.stringify(crasher, null, 2))
// Hello standing in for a channel: it declares a `password`, which is what *connected* reads.
const helloJson = join(from, 'hello', 'plugin.json')
const hello = JSON.parse(readFileSync(helloJson, 'utf8')) as { provides?: string[] }
hello.provides = [...(hello.provides ?? []), CORE_CAPABILITIES.channel]
writeFileSync(helloJson, JSON.stringify(hello, null, 2))

const dataDir = mkdtempSync(join(tmpdir(), 'alexia-restart-'))
const store = new Store(':memory:')
const secrets = memorySecrets()
const plugins = new Plugins({
  dir: from,
  store,
  dataDir,
  secrets,
  timings: { ...DEFAULT_TIMINGS, backoffMs: 10, startMs: 5_000 },
})
plugins.load()

afterAll(async () => {
  await plugins.stop()
  store.close()
  for (const path of [from, dataDir]) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const paneOf = async (id: string) => (await plugins.panes()).find((pane) => pane.id === id)

test('a plugin that stopped too often says so on its pane, and restart clears it', async () => {
  plugins.enable('crasher')
  expect((await paneOf('crasher'))?.state).toBeUndefined()

  await expect(plugins.process('crasher')!.listTools()).rejects.toThrow()
  await vi.waitFor(() => expect(plugins.process('crasher')!.state).toBe('unhealthy'), { timeout: 20_000 })

  const off = await paneOf('crasher')
  expect(off?.state).toBe('unhealthy')
  expect(off?.reason).toContain('stopped 3 times in a minute')

  plugins.restart('crasher')
  const back = await paneOf('crasher')
  expect(back?.state).toBeUndefined()
  expect(back?.reason).toBeUndefined()
  expect(plugins.process('crasher')!.state).toBe('stopped')
}, 30_000)

test('a channel counts once it is enabled and every key it declared is stored', async () => {
  // Installed and not enabled: nobody said yes, so nobody can reach her through it.
  expect(await plugins.reachable(CORE_CAPABILITIES.channel)).toBe(0)

  plugins.enable('hello')
  // Enabled with no key: a bot with no token reaches nobody.
  expect(await plugins.reachable(CORE_CAPABILITIES.channel)).toBe(0)

  await secrets.set('hello', 'api_key', 'not-a-real-key')
  expect(await plugins.reachable(CORE_CAPABILITIES.channel)).toBe(1)

  await plugins.disable('hello')
  expect(await plugins.reachable(CORE_CAPABILITIES.channel)).toBe(0)
})
