// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { DEFAULT_TIMINGS } from '../src/supervisor.js'
import { Plugins } from '../src/plugins.js'
import { memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'
import { PluginTooling } from '../src/tooling.js'
import { stage } from './staged.js'

// The stop control, tested as its own case because the plan says so and because it is the
// one control that is worthless if it only mostly works. Two plugins, two ways of not
// stopping: one that honours cancellation, and one that cannot hear it at all.

const dir = stage('vanisher', 'crasher')
const store = new Store(':memory:')
const dataDir = mkdtempSync(join(tmpdir(), 'alexia-stop-'))

const plugins = new Plugins({
  dir,
  store,
  dataDir,
  secrets: memorySecrets(),
  // The hard stop, in milliseconds rather than the shipped two minutes. It is the only
  // thing standing between a wedged plugin and a task that never ends.
  timings: { ...DEFAULT_TIMINGS, callMs: 2_000 },
  onToolsChanged: () => tooling.invalidate(),
})
const tooling = new PluginTooling(plugins)
plugins.load()
// Installed is files on disk; enabled is a person having said yes (M2-5).
for (const id of plugins.ids) plugins.enable(id)

afterAll(async () => {
  await plugins.stop()
  store.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

test('stop reaches a plugin mid-call, and it does not wait for the call to finish', async () => {
  const stop = new AbortController()
  const started = Date.now()

  // A minute of work, stopped after a moment of it. If cancellation did not travel, this
  // test takes a minute and the control is a lie.
  const call = tooling.call('vanisher__slow', { ms: 60_000 }, stop.signal)
  setTimeout(() => stop.abort(), 200)
  const outcome = await call

  expect(outcome.ok).toBe(false)
  expect(Date.now() - started).toBeLessThan(10_000)
}, 30_000)

test('a plugin that cannot hear the cancellation is ended by the hard timeout instead', async () => {
  const stop = new AbortController()
  const started = Date.now()

  // `hang` blocks its own event loop, so `notifications/cancelled` arrives at a process
  // that will never read it. This is why the stop control is cancellation *plus* a
  // timeout: one of them is enough on its own only in the polite case.
  const call = tooling.call('crasher__hang', {}, stop.signal)
  setTimeout(() => stop.abort(), 200)
  const outcome = await call

  expect(outcome.ok).toBe(false)
  // Back well inside the plugin's 60-second wedge, and with a sentence rather than a hang.
  expect(Date.now() - started).toBeLessThan(20_000)
  expect(outcome.text.length).toBeGreaterThan(0)
}, 40_000)
