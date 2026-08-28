// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { Plugins } from '../src/plugins.js'
import { memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'
import { stage } from './staged.js'

/**
 * Quitting, and the plugin core had already forgotten.
 *
 * A folder that disappears is stopped and dropped from the map in the same breath, and the
 * stop is deliberately not awaited — noticing a deletion runs at the speed of the
 * filesystem, not at the speed of a process agreeing to exit. The cost of that is the thing
 * checked here: once the entry is gone, `stop()` had nothing left to wait for, so it
 * resolved while the process was still running and **nothing would ever stop it** — forgotten
 * is exactly why.
 *
 * It surfaced as a Windows `EPERM` in another suite's teardown, which is the mild version.
 * The real one is an orphaned plugin process outliving Alexia, still holding a working
 * directory inside the data folder that a purge is supposed to be able to empty.
 */

const dir = stage('hello')
const dataDir = mkdtempSync(join(tmpdir(), 'alexia-shutdown-'))
const store = new Store(':memory:')
const plugins = new Plugins({ dir, store, dataDir, secrets: memorySecrets() })

afterAll(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('quitting waits for a plugin whose folder went, not just the ones still there', async () => {
  plugins.load()
  for (const id of plugins.ids) plugins.enable(id)

  // Spawned: lazy spawn means nothing is running until something is asked of it.
  await plugins.process('hello')!.listTools()
  const pid = plugins.process('hello')!.pid
  expect(alive(pid)).toBe(true)

  rmSync(join(dir, 'hello'), { recursive: true, force: true })
  plugins.load()
  expect(plugins.ids).toEqual([])

  await plugins.stop()
  expect(alive(pid)).toBe(false)

  // And the proof that this is not a detail about process tables: the plugin's working
  // directory lives in here, and Windows will not delete a directory a live process is
  // sitting in. `stop()` resolving has to mean the data directory can go.
  expect(() => rmSync(dataDir, { recursive: true, force: true })).not.toThrow()
}, 30_000)

function alive(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
