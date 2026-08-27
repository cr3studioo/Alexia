// SPDX-License-Identifier: AGPL-3.0-only
import { Manifest, MCP_PINNED, SETTINGS_CHANGED } from '@alexia/protocol'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import {
  DEFAULT_TIMINGS,
  PluginProcess,
  PluginUnavailable,
  type HostServices,
  type Timings,
} from '../src/supervisor.js'

// These tests spawn real processes on purpose. The thesis is that a plugin is a process
// that may die at any moment, and an in-memory transport cannot die.

const fixtures = join(import.meta.dirname, 'fixtures')
const pluginsDir = join(import.meta.dirname, '..', '..', '..', 'plugins')

/** A real plugin folder, read the way core reads it. */
const shipped = (id: string): { manifest: Manifest; dir: string } => {
  const dir = join(pluginsDir, id)
  return { manifest: Manifest.parse(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))), dir }
}

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    manifest_version: 1,
    id: 'fixture',
    name: 'Fixture',
    summary: 'A plugin that misbehaves on request.',
    version: '0.1.0',
    license: 'AGPL-3.0-only',
    entry: { run: 'node', args: ['plugin.js'] },
    alexia_protocol: 1,
    mcp_protocol: MCP_PINNED,
    ...over,
  }
}

interface Spy extends HostServices {
  samplingFor: string[]
  logs: string[]
  changed: string[]
  off: string[]
}

function host(): Spy {
  const spy: Spy = {
    samplingFor: [],
    logs: [],
    changed: [],
    off: [],
    sampling: async (pluginId) => {
      spy.samplingFor.push(pluginId)
      return { model: 'stub', role: 'assistant', content: { type: 'text', text: 'here' } }
    },
    roots: () => [{ uri: 'file:///scope', name: 'scope' }],
    log: (id, line) => spy.logs.push(`${id}: ${line}`),
    toolsChanged: (id) => spy.changed.push(id),
    unhealthy: (id, message) => spy.off.push(message),
  }
  return spy
}

const alive = (pid: number | null | undefined): boolean => {
  if (typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const running: PluginProcess[] = []
const start = (
  m: Manifest,
  h: HostServices,
  t: Partial<Timings> = {},
  dir = fixtures,
): PluginProcess => {
  const p = new PluginProcess(m, dir, h, { ...DEFAULT_TIMINGS, ...t })
  running.push(p)
  return p
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((p) => p.stop()))
})

test('nothing runs until something is asked of it, and then it answers', async () => {
  const plugin = start(manifest(), host())
  expect(plugin.state).toBe('stopped')
  expect(plugin.pid).toBeUndefined()

  const tools = await plugin.listTools()
  expect(tools.map((t) => t.name)).toContain('echo')
  expect(plugin.state).toBe('running')
  expect(alive(plugin.pid)).toBe(true)

  const result = await plugin.callTool('echo', { say: 'hello' })
  expect(result.content).toEqual([{ type: 'text', text: 'hello' }])
}, 20_000)

test('an idle plugin is not a running process, and comes back without anyone noticing', async () => {
  const plugin = start(manifest(), host(), { idleMs: 50 })
  await plugin.listTools()
  const first = plugin.pid

  await vi.waitFor(() => expect(plugin.state).toBe('stopped'), { timeout: 5_000 })
  // The invariant the memory budget rests on: idle means gone, not sleeping.
  await vi.waitFor(() => expect(alive(first)).toBe(false), { timeout: 5_000 })

  const result = await plugin.callTool('echo', { say: 'back' })
  expect(result.content).toEqual([{ type: 'text', text: 'back' }])
  expect(plugin.pid).not.toBe(first)
}, 20_000)

test('a wedged plugin fails its call and gets killed, rather than hanging the chat', async () => {
  const spy = host()
  const crasher = shipped('crasher')
  const plugin = start(crasher.manifest, spy, { heartbeatMs: 200, callMs: 500, backoffMs: 50 }, crasher.dir)
  await plugin.listTools()
  const wedged = plugin.pid

  await expect(plugin.callTool('hang')).rejects.toThrow()
  await vi.waitFor(() => expect(alive(wedged)).toBe(false), { timeout: 10_000 })
  expect(spy.logs.join('\n')).toContain('stopped answering')
}, 20_000)

test('three stops in a minute and it is switched off, in words a person can act on', async () => {
  const spy = host()
  const crasher = shipped('crasher')
  const plugin = start(
    { ...crasher.manifest, entry: { ...crasher.manifest.entry, args: [...(crasher.manifest.entry.args ?? []), '--die-on-start'] } },
    spy,
    { backoffMs: 10, startMs: 5_000 },
    crasher.dir,
  )

  await expect(plugin.listTools()).rejects.toThrow()
  await vi.waitFor(() => expect(plugin.state).toBe('unhealthy'), { timeout: 20_000 })

  expect(plugin.reason).toBe(
    'Crasher stopped 3 times in a minute, so Alexia has switched it off.\nEverything else is still running.',
  )
  expect(spy.off).toEqual([plugin.reason])
  // And it stays off: the loop stops, and a human decides when to try again.
  await expect(plugin.listTools()).rejects.toBeInstanceOf(PluginUnavailable)
  plugin.restart()
  expect(plugin.state).toBe('stopped')
}, 30_000)

test('a plugin reaches the model and the folder scope through core, tagged with its id', async () => {
  const spy = host()
  const plugin = start(manifest(), spy)

  const asked = await plugin.callTool('ask')
  expect(asked.content).toEqual([{ type: 'text', text: 'here' }])
  // Attribution: the router is told who spent the tokens, not just that someone did.
  expect(spy.samplingFor).toEqual(['fixture'])

  const scope = await plugin.callTool('where')
  expect(scope.content).toEqual([{ type: 'text', text: 'file:///scope' }])
}, 20_000)

test('a tool list that changes mid-session reaches core', async () => {
  const spy = host()
  const plugin = start(manifest(), spy)
  await plugin.listTools()

  await plugin.callTool('grow')
  await vi.waitFor(() => expect(spy.changed).toContain('fixture'), { timeout: 10_000 })
  expect((await plugin.listTools()).map((t) => t.name)).toContain('grown')
}, 20_000)

test('the newer MCP revision connects, and cannot reach back into core', async () => {
  // Both halves of D57 in one test. Core speaks `2026-07-28`, so a server that speaks only
  // it still works. And on that era there is no server-to-client request channel, which is
  // why an Alexia plugin is built on the older revision: `alexia/*` needs one.
  const spy = host()
  const plugin = start(
    manifest({
      id: 'modern',
      name: 'Modern',
      mcp_protocol: '2026-07-28',
      entry: { run: 'node', args: ['modern-plugin.js'] },
    }),
    spy,
  )

  expect((await plugin.listTools()).map((t) => t.name)).toEqual(['reach_back'])
  const reached = await plugin.callTool('reach_back')
  expect(reached.content[0]).toMatchObject({ text: expect.stringContaining('refused') })
  expect(spy.logs.join('\n')).toContain('Dropped inbound request')
}, 20_000)

test('a running plugin is told a setting changed, and a stopped one is left alone', async () => {
  const plugin = start(manifest(), host())
  const said = async (): Promise<string> =>
    String(((await plugin.callTool('changed')).content[0] as { text?: string }).text)

  expect(await said()).toBe('null') // this is also what spawns it

  // A notification is one-way: `notify` resolves when it has been written, not when the
  // plugin has acted on it, and the plugin validates the params before its handler runs.
  // So it arrives when it arrives — asserting on the very next call passed on a fast laptop
  // and failed on both CI runners, which is the useful way round.
  await plugin.notify(SETTINGS_CHANGED, { changed: { greeting: 'Good evening' } })
  await expect.poll(said, { timeout: 5_000 }).toBe(JSON.stringify({ greeting: 'Good evening' }))

  // A stopped plugin reads the new value when it next starts, so telling it costs nothing
  // and must not cost a process.
  const asleep = start(manifest(), host())
  await asleep.notify(SETTINGS_CHANGED, { changed: { greeting: 'Good evening' } })
  expect(asleep.pid).toBeUndefined()
  expect(asleep.state).toBe('stopped')
}, 20_000)

test('a plugin written for a newer Alexia never gets a process', async () => {
  const spy = host()
  const plugin = start(manifest({ alexia_protocol: 99 }), spy)

  await expect(plugin.listTools()).rejects.toBeInstanceOf(PluginUnavailable)
  expect(plugin.pid).toBeUndefined()
  expect(plugin.reason).toContain('Fixture needs a newer Alexia')
  // Not a crash loop: restarting cannot make it a different version.
  expect(spy.off).toHaveLength(1)
})
