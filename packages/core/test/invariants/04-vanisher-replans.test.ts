// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import { Plugins } from '../../src/plugins.js'
import { Store } from '../../src/store.js'
import { stage } from '../staged.js'

// Defends: the sentence the whole project is built on. A plugin's folder is deleted while a
// call against it is in flight — not between calls, not while it is idle, at the worst
// possible moment — and core notices, drops its tools, and says so. At M0 the loop is a
// stub, so the *event* is what is proved here; M1.5 is what re-plans on it.
//
// The Windows half of this is why the working directory is never the plugin's folder (D58):
// a directory that is a running process's cwd cannot be deleted at all.

const dir = stage('vanisher')
const store = new Store(':memory:')
const changed: string[] = []
const plugins = new Plugins({
  dir,
  store,
  dataDir: mkdtempSync(join(tmpdir(), 'alexia-invariant-')),
  onToolsChanged: (id) => changed.push(id),
})

afterAll(async () => {
  await plugins.stop()
  store.close()
})

test('vanisher-replans: a folder deleted mid-call, and core is the one that notices', async () => {
  plugins.load()
  plugins.watch()
  // Loading a plugin is itself a change of tools. Start counting from here.
  changed.length = 0

  const plugin = plugins.process('vanisher')
  expect(plugin).toBeDefined()
  expect((await plugin!.listTools()).map((t) => t.name)).toContain('slow')

  // In flight, and long enough that the deletion lands in the middle of it.
  const inFlight = plugin!.callTool('slow', { ms: 10_000 })
  inFlight.catch(() => {})
  const pid = plugin!.pid
  expect(typeof pid).toBe('number')

  rmSync(join(dir, 'vanisher'), { recursive: true })

  // Core noticed by itself. Nothing told it, and nothing asked it to look.
  await vi.waitFor(() => expect(changed).toContain('vanisher'), { timeout: 10_000 })
  expect(plugins.ids).toEqual([])

  // The call cannot complete, and says so rather than hanging until something times out.
  await expect(inFlight).rejects.toThrow()

  // And the process is gone, not orphaned.
  await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 })
}, 60_000)

function alive(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
