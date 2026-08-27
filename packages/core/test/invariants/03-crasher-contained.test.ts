// SPDX-License-Identifier: AGPL-3.0-only
import { Manifest } from '@alexia/protocol'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { Host } from '../../src/host.js'
import { Store } from '../../src/store.js'
import { DEFAULT_TIMINGS, PluginProcess, type Timings } from '../../src/supervisor.js'
import { repoRoot } from './_repo.js'

// Defends: process isolation earning its memory. A plugin gets its own process precisely so
// that it can exit mid-call, wedge itself, or allocate until the runtime gives up — and
// none of that reaches core or any other plugin. If a crashing plugin can take core with
// it, the memory a process costs is buying nothing.

const load = (id: string) => {
  const dir = join(repoRoot, 'plugins', id)
  return { manifest: Manifest.parse(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))), dir }
}

const crasher = load('crasher')
const hello = load('hello')

const store = new Store(':memory:')
const host = new Host({
  store,
  dataDir: mkdtempSync(join(tmpdir(), 'alexia-invariant-')),
  manifest: (id) => (id === crasher.manifest.id ? crasher.manifest : hello.manifest),
})

/** The bystander. It is running for the whole file and must never notice a thing. */
const bystander = new PluginProcess(hello.manifest, hello.dir, host)

const fast: Partial<Timings> = { heartbeatMs: 200, callMs: 1_000, backoffMs: 20, startMs: 10_000 }
const started: PluginProcess[] = [bystander]
const start = (over: Partial<Timings> = {}): PluginProcess => {
  const p = new PluginProcess(crasher.manifest, crasher.dir, host, {
    ...DEFAULT_TIMINGS,
    ...fast,
    ...over,
  })
  started.push(p)
  return p
}

afterAll(async () => {
  await Promise.all(started.map((p) => p.stop()))
  store.close()
})

const stillStanding = async (): Promise<void> => {
  const answer = await bystander.callTool('greet', { who: 'the bystander' })
  expect(answer.content).toEqual([{ type: 'text', text: 'Hello, the bystander.' }])
}

describe('crasher-contained: three ways to die, and core stands through each', () => {
  test('it exits in the middle of a call', async () => {
    const plugin = start()
    await plugin.listTools()
    await expect(plugin.callTool('exit')).rejects.toThrow()
    await stillStanding()
  }, 30_000)

  test('it hangs without answering, and is killed rather than waited on', async () => {
    const plugin = start()
    await plugin.listTools()
    const pid = plugin.pid
    await expect(plugin.callTool('hang')).rejects.toThrow()
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false)
    await stillStanding()
  }, 30_000)

  test('it allocates until the runtime gives up', async () => {
    const plugin = start()
    await plugin.listTools()
    await expect(plugin.callTool('leak', undefined, { timeout: 20_000 })).rejects.toThrow()
    await stillStanding()
  }, 40_000)

  test('three stops in a minute and it is switched off, in one line a person can act on', async () => {
    const messages: string[] = []
    const plugin = new PluginProcess(crasher.manifest, crasher.dir, {
      ...host,
      sampling: host.sampling.bind(host),
      roots: host.roots.bind(host),
      alexia: host.alexia.bind(host),
      unhealthy: (_id, message) => messages.push(message),
    }, { ...DEFAULT_TIMINGS, ...fast })
    started.push(plugin)

    for (let i = 0; i < 3; i++) {
      await plugin.listTools().catch(() => {})
      await plugin.callTool('exit').catch(() => {})
    }

    await expect.poll(() => plugin.state, { timeout: 20_000 }).toBe('unhealthy')
    expect(messages.at(-1)).toBe(
      'Crasher stopped 3 times in a minute, so Alexia has switched it off.\nEverything else is still running.',
    )
    // The load-bearing half of that sentence, and the reason it is a test.
    await stillStanding()
  }, 60_000)
})

function alive(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
