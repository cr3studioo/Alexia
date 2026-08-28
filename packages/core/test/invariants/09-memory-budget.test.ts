// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { Plugins } from '../../src/plugins.js'
import { Store } from '../../src/store.js'
import { stage } from '../staged.js'

// Defends risk 2: a process per plugin looking like an architectural mistake for reasons
// that are really an unimplemented optimisation. If lazy spawn or idle shutdown slips, the
// argument gets had about the wrong thing — so the numbers are a test, not a claim.
//
// Core stays under 150 MB resident, and an enabled-but-idle plugin runs **no process at
// all**. The measured numbers are printed and recorded in `docs/memory.md` at each
// milestone, so the trend is visible rather than remembered.

const MB = 1024 * 1024
const CORE_BUDGET = 150 * MB

const dir = stage('hello')
const store = new Store(':memory:')
const plugins = new Plugins({ dir, store, dataDir: mkdtempSync(join(tmpdir(), 'alexia-mem-')) })

afterAll(async () => {
  await plugins.stop()
  store.close()
})

/** A child process's resident set, from whatever the platform will tell us. */
function rss(pid: number): number {
  if (process.platform === 'win32') {
    const row = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
    })
    // "name","pid","session","#","12,345 K"
    const kilobytes = row.split('","').at(-1)?.replace(/[^0-9]/g, '')
    return Number(kilobytes ?? 0) * 1024
  }
  return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) * 1024
}

test('memory-budget: core alone stays inside its budget', () => {
  // Measured in a process containing core and nothing else. Measuring in here would be
  // measuring vitest.
  const out = execFileSync(process.execPath, [join(import.meta.dirname, 'core-alone.js')], {
    encoding: 'utf8',
  })
  const { rss: core, plugins: loaded } = JSON.parse(out) as { rss: number; plugins: string[] }

  console.error(`core resident: ${(core / MB).toFixed(1)} MB (budget ${CORE_BUDGET / MB} MB)`)
  expect(loaded).toEqual([])
  expect(core).toBeLessThan(CORE_BUDGET)
}, 30_000)

test('memory-budget: an enabled plugin that nobody has used is not a process', async () => {
  plugins.load()
  for (const id of plugins.ids) plugins.enable(id)
  expect(plugins.ids).toEqual(['hello'])

  // Enabled, loaded, listed in the library — and costing nothing. This is the half of the
  // argument that makes a process per plugin affordable.
  expect(plugins.process('hello')?.pid).toBeUndefined()

  const used = plugins.process('hello')!
  await used.callTool('greet', { who: 'the budget' })
  const pid = used.pid
  expect(typeof pid).toBe('number')
  console.error(`plugin resident: ${(rss(pid as number) / MB).toFixed(1)} MB`)
  expect(rss(pid as number)).toBeGreaterThan(0)
}, 30_000)
