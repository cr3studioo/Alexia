// SPDX-License-Identifier: AGPL-3.0-only
import { Manifest, MCP_PINNED, type ManifestInput } from '@alexia/protocol'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import { Inventory } from '../src/compute/inventory.js'
import type { HostInventory, SetupRequirement } from '../src/compute/types.js'
import { pluginWorkers, textWorker, Workers, type ComputeWorker } from '../src/compute/workers.js'
import { remember } from '../src/installed.js'
import { LLAMA } from '../src/llama.js'
import type { Machine } from '../src/machine.js'
import { Plugins } from '../src/plugins.js'
import { memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'

const sdk = pathToFileURL(join(import.meta.dirname, '..', '..', 'sdk', 'dist', 'src', 'index.js')).href
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const GB = 1024 ** 3
const hardware: Machine = {
  platform: 'linux', arch: 'x64', chip: 'Test CPU', appleSilicon: false, ramBytes: 64 * GB, freeRamBytes: 48 * GB,
  freeDiskBytes: 200 * GB, diskKnown: true, budgetBytes: 44 * GB, cpuCores: 16, gpus: [{ name: 'Test GPU', vramBytes: 24 * GB }],
}

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'alexia-compute-inventory-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  return root
}

/** The text worker over runners that load nothing, with one model installed and its runtime present. */
function text(root: string) {
  const file = join(root, 'weights')
  writeFileSync(file, 'weights')
  remember(root, {
    id: 'llama/test', format: 'gguf', name: 'Test', repo: 'test/model', revision: 'a'.repeat(40), quant: 'Q4', files: [file], bytes: 7,
    context: 8192, tools: true, vision: false, abliterated: false, nsfwOk: 'unknown', vetted: false, ready: true, installedAt: 1,
  })
  return textWorker({
    dataDir: root, runners: { provider: () => LLAMA, loaded: () => undefined, stop: async () => {} },
    backend: async () => 'cpu', llamaSupported: () => true, llamaReady: () => ({}) as never, mlxSupported: () => false,
  })
}

/** A worker made by hand: what it offers and what it is missing are whatever the test last set. */
function fake(id: string, caps: string[]) {
  const state = { needs: [] as SetupRequirement[], asked: 0 }
  const worker: ComputeWorker = {
    id, loaded: () => false, stop: async () => {},
    capabilities: async () => caps.map((cap) => ({ cap, summary: `Does ${cap}.`, weight: 'heavy' as const, ready: true })),
    setup: async () => { state.asked++; return structuredClone(state.needs) },
    install: async () => {}, run: async () => ({ files: [] }),
  }
  return { worker, state }
}

function inventory(plugins: () => ComputeWorker[]) {
  const root = temp()
  const probe = vi.fn(async () => structuredClone(hardware))
  const workers = new Workers(text(root), plugins)
  const made = new Inventory({ dataDir: root, name: 'Tower', appVersion: '1.2.3', workers, machine: probe })
  cleanups.push(() => made.close())
  return { root, probe, workers, inventory: made }
}

test('the inventory says what the host is: its name, its hardware, its models and what its workers offer', async () => {
  const image = fake('image-worker', ['demo.render'])
  const { inventory: host } = inventory(() => [image.worker])
  expect(await host.current()).toEqual({
    name: 'Tower', appVersion: '1.2.3', revision: 1, setup: [],
    machine: { ...hardware },
    models: [{ id: 'llama/test', name: 'Test', engine: 'llama', context: 8192, supportsTools: true, modality: ['text'], quant: 'Q4', diskBytes: 7, abliterated: false, loaded: false }],
    capabilities: [{ cap: 'demo.render', summary: 'Does demo.render.', weight: 'heavy', ready: true }],
  })
})

test('hardware is probed for setup, preparation and admission, and for nothing else', async () => {
  vi.useFakeTimers()
  const { inventory: host, probe, workers } = inventory(() => [])
  expect(probe).not.toHaveBeenCalled()

  // There is no inventory without hardware in it, so building the first one is the setup probe.
  await Promise.all([host.current(), host.current()])
  expect(probe).toHaveBeenCalledTimes(1)
  await host.current()
  await host.refresh('workers')
  await host.refresh('models')
  workers.changed()
  expect(probe).toHaveBeenCalledTimes(1)

  // An hour with nothing to do: no timer was armed, and nothing looks at the hardware.
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
  expect(probe).toHaveBeenCalledTimes(1)

  await host.refresh('setup')
  expect(probe).toHaveBeenCalledTimes(2)
  await host.refresh('prepare')
  expect(probe).toHaveBeenCalledTimes(3)
  await host.refresh('admission')
  expect(probe).toHaveBeenCalledTimes(4)
})

test('the revision rises only when something changed, and only then are listeners told', async () => {
  const { inventory: host, probe } = inventory(() => [])
  const heard: HostInventory[] = []
  host.onChange((one) => heard.push(one))
  expect((await host.current()).revision).toBe(1)
  expect((await host.refresh('admission')).revision).toBe(1)
  expect(heard.map((one) => one.revision)).toEqual([1])

  probe.mockResolvedValueOnce({ ...hardware, freeRamBytes: 8 * GB })
  const next = await host.refresh('prepare')
  expect(next).toMatchObject({ revision: 2, machine: { freeRamBytes: 8 * GB } })
  expect(heard.map((one) => one.revision)).toEqual([1, 2])
  // What is handed out is a copy.
  next.models.length = 0
  expect((await host.current()).models).toHaveLength(1)
})

test('a capability is not ready while a requirement blocks it, and a requirement says nothing of who asked', async () => {
  const image = fake('image-worker', ['demo.render', 'demo.upscale'])
  const voice = fake('voice-worker', ['demo.speak'])
  image.state.needs = [{ id: 'weights', kind: 'model', title: 'Fixture weights', bytes: 1234, action: 'install', blocks: ['demo.render'] }]
  voice.state.needs = [{ id: 'weights', kind: 'model', title: 'Voice weights', action: 'instructions', instructions: 'Fetch them.', blocks: ['demo.speak'] }]
  const { inventory: host } = inventory(() => [image.worker, voice.worker])
  const first = await host.current()
  expect(first.capabilities.map((one) => [one.cap, one.ready])).toEqual([['demo.render', false], ['demo.upscale', true], ['demo.speak', false]])
  expect(first.setup).toMatchObject([{ title: 'Fixture weights', bytes: 1234, action: 'install' }, { title: 'Voice weights', action: 'instructions' }])
  // Two workers used the same id of their own; the host's list keeps them apart without naming either.
  expect(new Set(first.setup.map((need) => need.id)).size).toBe(2)
  expect(JSON.stringify(first)).not.toMatch(/image-worker|voice-worker/)
  expect(host.requirement(first.setup[0]!.id)).toEqual({ worker: image.worker, requirement: image.state.needs[0] })
  expect(host.requirement('weights')).toBeUndefined()

  // What a worker is missing is asked again for setup, and not when a job is admitted.
  image.state.needs = []
  expect((await host.refresh('admission')).capabilities[0]).toMatchObject({ cap: 'demo.render', ready: false })
  expect(image.state.asked).toBe(1)
  const after = await host.refresh('setup')
  expect(after.capabilities[0]).toMatchObject({ cap: 'demo.render', ready: true })
  expect(after.setup.map((need) => need.id)).toEqual([first.setup[1]!.id])
  expect(host.requirement(first.setup[0]!.id)).toBeUndefined()
})

test('a worker whose setup cannot be asked is shown as blocked, and the rest of the inventory stands', async () => {
  const broken = fake('broken-worker', ['demo.render'])
  broken.worker.setup = async () => { throw new Error('gone') }
  const { inventory: host } = inventory(() => [broken.worker])
  const built = await host.current()
  expect(built.capabilities).toEqual([{ cap: 'demo.render', summary: 'Does demo.render.', weight: 'heavy', ready: false }])
  expect(built.setup).toMatchObject([{ kind: 'dependency', action: 'instructions', blocks: ['demo.render'] }])
  expect(built.models).toHaveLength(1)
})

test('a model installed afterwards appears on a models refresh, with the text worker asked again', async () => {
  const image = fake('image-worker', ['demo.render'])
  const { inventory: host, root } = inventory(() => [image.worker])
  await host.current()
  remember(root, {
    id: 'llama/second', format: 'gguf', name: 'Second', repo: 'test/second', revision: 'b'.repeat(40), quant: 'Q8', files: [join(root, 'weights')], bytes: 9,
    context: 4096, tools: false, vision: true, abliterated: false, nsfwOk: 'unknown', vetted: false, ready: true, installedAt: 2,
  })
  const next = await host.refresh('models')
  expect(next.models.map((model) => model.id)).toEqual(['llama/test', 'llama/second'])
  expect(next.models[1]).toMatchObject({ modality: ['text', 'image'], supportsTools: false })
  expect(next.revision).toBe(2)
  expect(image.state.asked).toBe(1)
})

test('only installed workers are listed, and removing the fixture folder drops its capabilities and nothing else', async () => {
  const root = temp()
  const id = 'worker-fixture'
  const dir = join(root, 'installed', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(Manifest.parse({
    manifest_version: 1, id, name: 'Fixture worker', summary: 'Exercises the generic worker contract.', version: '0.1.0',
    license: 'AGPL-3.0-only', entry: { run: 'node', args: ['index.mjs'] }, alexia_protocol: 13, mcp_protocol: MCP_PINNED,
    provides: ['demo.render', 'demo.visible'],
    compute: { operations: [{ cap: 'demo.render', summary: 'Render a fixture file.' }], hooks: ['setup'] },
  } satisfies ManifestInput)))
  writeFileSync(join(dir, 'index.mjs'), `
import { writeFileSync } from 'node:fs'
import { plugin } from ${JSON.stringify(sdk)}
writeFileSync(${JSON.stringify(join(root, 'spawned'))}, String(process.pid))
const alexia = plugin()
alexia.computeOperation('demo.render', async () => ({ files: [] }))
alexia.computeHooks({ setup: async () => [
  { id: 'nodes', kind: 'dependency', title: 'Fixture nodes', action: 'instructions', instructions: 'Add the nodes.', blocks: ['demo.render', 'demo.elsewhere'] },
  { id: '', kind: 'dependency', title: 'Malformed', action: 'install', blocks: [] },
] })
await alexia.start()
`)
  const store = new Store(':memory:')
  const late: { workers?: Workers } = {}
  const plugins = new Plugins({
    dir: join(root, 'installed'), dataDir: join(root, 'data'), store, secrets: memorySecrets(),
    onToolsChanged: () => late.workers?.changed(),
  })
  plugins.load()
  cleanups.push(async () => { await plugins.stop(); store.close() })
  const workers = late.workers = new Workers(text(root), () => pluginWorkers(plugins))
  const host = new Inventory({ dataDir: root, name: 'Tower', appVersion: '1.2.3', workers, machine: async () => structuredClone(hardware) })
  cleanups.push(() => host.close())
  const heard: HostInventory[] = []
  host.onChange((one) => heard.push(one))

  // Installed and not enabled is not a worker: nothing is listed, and nothing was started to find that out.
  expect((await host.current()).capabilities).toEqual([])
  expect(existsSync(join(root, 'spawned'))).toBe(false)

  plugins.enable(id)
  const enabled = await host.refresh('workers')
  // Only what the manifest declared as an operation, and blocked only by what the worker itself offers.
  expect(enabled.capabilities).toEqual([{ cap: 'demo.render', summary: 'Render a fixture file.', weight: 'heavy', ready: false }])
  expect(enabled.setup).toMatchObject([{ title: 'Fixture nodes', action: 'instructions', blocks: ['demo.render'] }])
  expect(JSON.stringify(enabled)).not.toContain(id)

  plugins.watch()
  // The folder watcher comes up asynchronously (FSEvents on a Mac): a folder removed before it is up is never heard of.
  await new Promise((resolve) => setTimeout(resolve, 500))
  rmSync(dir, { recursive: true, force: true })
  await vi.waitFor(() => expect(heard.at(-1)).toMatchObject({ capabilities: [], setup: [] }), { timeout: 15_000 })
  const gone = await host.current()
  expect(gone.revision).toBeGreaterThan(enabled.revision)
  expect(gone.models.map((model) => model.id)).toEqual(['llama/test'])
  expect(host.requirement(enabled.setup[0]!.id)).toBeUndefined()
})
