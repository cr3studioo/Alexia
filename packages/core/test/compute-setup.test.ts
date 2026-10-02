// SPDX-License-Identifier: AGPL-3.0-only
import { Manifest, MCP_PINNED, type ManifestInput } from '@alexia/protocol'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import { Artifacts } from '../src/compute/artifacts.js'
import { Inventory } from '../src/compute/inventory.js'
import { Scheduler } from '../src/compute/scheduler.js'
import { CANCEL_STOP_MS, Setup } from '../src/compute/setup.js'
import { ComputeError, type JobProgress, type JobSnapshot } from '../src/compute/types.js'
import { pluginWorkers, textWorker, Workers, type TextWorkerOptions } from '../src/compute/workers.js'
import { LLAMA, RUNTIME_ASSETS } from '../src/llama.js'
import type { Machine } from '../src/machine.js'
import { Plugins } from '../src/plugins.js'
import { memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'

const sdk = pathToFileURL(join(import.meta.dirname, '..', '..', 'sdk', 'dist', 'src', 'index.js')).href
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const GB = 1024 ** 3
const hardware: Machine = { platform: 'linux', arch: 'x64', chip: 'Test CPU', appleSilicon: false, ramBytes: 64 * GB, freeDiskBytes: 200 * GB, budgetBytes: 44 * GB }
const runtimeBytes = (RUNTIME_ASSETS as Record<string, { bytes: number } | undefined>)[`${process.platform}-${process.arch}`]?.bytes

/**
 * A compute host with nothing set up: no runtime, no model, and one enabled worker whose
 * engine is somebody else's program — present when the `engine` folder is, absent otherwise.
 */
function host(options: { engine?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'alexia-compute-setup-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  const at = (name: string): string => join(root, name)
  if (options.engine) mkdirSync(at('engine'))
  const id = 'worker-fixture'
  const dir = join(root, 'installed', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(Manifest.parse({
    manifest_version: 1, id, name: 'Fixture worker', summary: 'Exercises guided setup.', version: '0.1.0',
    license: 'AGPL-3.0-only', entry: { run: 'node', args: ['index.mjs'] }, alexia_protocol: 13, mcp_protocol: MCP_PINNED,
    provides: ['demo.render'],
    compute: { operations: [{ cap: 'demo.render', summary: 'Render a fixture file.' }], hooks: ['setup', 'install', 'release'] },
  } satisfies ManifestInput)))
  writeFileSync(join(dir, 'index.mjs'), `
import { existsSync, writeFileSync } from 'node:fs'
import { plugin } from ${JSON.stringify(sdk)}
const alexia = plugin()
const engine = ${JSON.stringify(at('engine'))}, configured = ${JSON.stringify(at('configured'))}, weights = ${JSON.stringify(at('weights.bin'))}
alexia.computeOperation('demo.render', async () => ({ files: [] }))
alexia.computeHooks({
  // The engine is found, never fetched: there it is pointed at, absent it is a thing to go and install.
  setup: async () => {
    const needs = []
    if (existsSync(engine)) writeFileSync(configured, engine)
    else needs.push({ id: 'engine', kind: 'dependency', title: 'Image engine', action: 'instructions',
      instructions: 'Install the image engine from its own site, then check again.', blocks: ['demo.render'] })
    if (!existsSync(weights)) needs.push({ id: 'weights', kind: 'model', title: 'Fixture weights', bytes: 1234, action: 'install', blocks: ['demo.render'] })
    return needs
  },
  install: async (requirementId, ctx) => {
    if (requirementId !== 'weights') throw new Error('The fixture cannot install that.\\nat somewhere')
    await alexia.progress(ctx, 617, 1234, 'Downloading.')
    await alexia.settings()
    writeFileSync(weights, 'weights')
  },
  release: async () => writeFileSync(${JSON.stringify(at('released'))}, 'released'),
})
await alexia.start()
`)
  const store = new Store(':memory:')
  const late: { workers?: Workers } = {}
  const plugins = new Plugins({
    dir: join(root, 'installed'), dataDir: join(root, 'data'), store, secrets: memorySecrets(),
    onToolsChanged: () => late.workers?.changed(),
  })
  plugins.load()
  plugins.enable(id)
  cleanups.push(async () => { await plugins.stop(); store.close() })

  const runtimes = new Set<string>()
  const ensureLlama = vi.fn<NonNullable<TextWorkerOptions['ensureLlama']>>(async (_dir, runtime = {}) => {
    runtime.onProgress?.({ done: 5, total: 10 })
    runtime.signal?.throwIfAborted()
    runtimes.add(runtime.backend!)
    return {} as never
  })
  const text = textWorker({
    dataDir: root, runners: { provider: () => LLAMA, loaded: () => undefined, stop: async () => {} },
    backend: async () => 'cpu', llamaSupported: () => true, llamaReady: (_dir, runtime) => (runtimes.has(runtime!.backend!) ? ({} as never) : undefined),
    ensureLlama, mlxSupported: () => false,
  })
  const workers = late.workers = new Workers(text, () => pluginWorkers(plugins))
  const scheduler = new Scheduler()
  cleanups.push(() => scheduler.close())
  workers.bind(scheduler)
  const jobs = join(root, 'data', 'compute', 'jobs')
  const artifacts = new Artifacts({ dir: jobs })
  const probe = vi.fn(async () => structuredClone(hardware))
  const inventory = new Inventory({ dataDir: root, name: 'Tower', appVersion: '1.2.3', workers, machine: probe })
  cleanups.push(() => inventory.close())
  const setup = new Setup({ workers, scheduler, artifacts, inventory })
  const done = (jobId: string): Promise<JobSnapshot> => vi.waitFor(() => {
    const job = scheduler.status(jobId)
    expect(['succeeded', 'failed', 'cancelled']).toContain(job?.state)
    return job!
  })
  return { root, at, jobs, plugins, workers, scheduler, artifacts, inventory, setup, ensureLlama, probe, done }
}

test('setup lists what is missing with its size, and listing installs nothing', async () => {
  const { setup, at, ensureLlama, inventory, scheduler, probe } = host()
  const needs = await setup.requirements()
  expect(needs.map((need) => ({ ...need, id: undefined }))).toEqual([
    { kind: 'runtime', title: 'llama.cpp runtime', detail: 'Runs GGUF models on this computer.', ...(runtimeBytes !== undefined && { bytes: runtimeBytes }), action: 'install', blocks: ['chat'] },
    { kind: 'model', title: 'No model installed', action: 'instructions', instructions: 'Choose a model for this computer.', blocks: ['chat'] },
    { kind: 'dependency', title: 'Image engine', action: 'instructions', instructions: 'Install the image engine from its own site, then check again.', blocks: ['demo.render'] },
    { kind: 'model', title: 'Fixture weights', bytes: 1234, action: 'install', blocks: ['demo.render'] },
  ])
  expect(runtimeBytes).toBeGreaterThan(0)
  expect(needs).toEqual((await inventory.current()).setup)
  expect(probe).toHaveBeenCalledTimes(1)

  await setup.requirements()
  expect(ensureLlama).not.toHaveBeenCalled()
  expect(existsSync(at('weights.bin'))).toBe(false)
  expect(scheduler.queue()).toEqual({ waiting: [], paused: false })
  expect((await inventory.current()).capabilities).toEqual([{ cap: 'demo.render', summary: 'Render a fixture file.', weight: 'heavy', ready: false }])
})

test('one explicit install runs as a light setup job and takes its requirement off the list', async () => {
  const { setup, scheduler, ensureLlama, done, jobs, root } = host()
  const needs = await setup.requirements()
  const progress: (JobProgress | undefined)[] = []
  scheduler.onJob((job) => { if (job.progress) progress.push(job.progress) })

  const job = setup.install(needs[0]!.id, 'job-runtime')
  expect(job).toMatchObject({ id: 'job-runtime', kind: 'setup', weight: 'light', label: 'llama.cpp runtime' })
  // Asking twice is the same job, and a second job for the same requirement is refused.
  expect(setup.install(needs[0]!.id, 'job-runtime').id).toBe('job-runtime')
  expect(() => setup.install(needs[0]!.id, 'job-other')).toThrow(expect.objectContaining({ code: 'refused' }))
  expect(await done('job-runtime')).toMatchObject({ state: 'succeeded' })
  expect(ensureLlama).toHaveBeenCalledTimes(1)
  expect(ensureLlama).toHaveBeenCalledWith(root, expect.objectContaining({ backend: 'cpu' }))
  expect(progress[0]).toEqual({ progress: 5, total: 10 })

  await vi.waitFor(async () => expect((await setup.requirements()).map((need) => need.title)).toEqual(['No model installed', 'Image engine', 'Fixture weights']))
  await vi.waitFor(() => expect(readdirSync(jobs)).toEqual([]))
  expect(() => setup.install(needs[0]!.id, 'job-again')).toThrow(expect.objectContaining({ code: 'not-found' }))
})

test('a plugin worker installs only the requirement that was pressed, with its progress, and then says it is no longer missing', async () => {
  const { setup, scheduler, inventory, at, done, ensureLlama } = host({ engine: true })
  const needs = await setup.requirements()
  // The engine was already on this computer: the worker's own setup hook found it and pointed itself at it.
  expect(needs.map((need) => need.title)).toEqual(['llama.cpp runtime', 'No model installed', 'Fixture weights'])
  expect(readFileSync(at('configured'), 'utf8')).toBe(at('engine'))
  const progress: JobProgress[] = []
  scheduler.onJob((job) => { if (job.progress) progress.push(job.progress) })

  setup.install(needs[2]!.id, 'job-weights')
  expect(await done('job-weights')).toMatchObject({ state: 'succeeded', kind: 'setup' })
  expect(readFileSync(at('weights.bin'), 'utf8')).toBe('weights')
  expect(progress).toContainEqual({ progress: 617, total: 1234, message: 'Downloading.' })
  expect(ensureLlama).not.toHaveBeenCalled()
  await vi.waitFor(async () => expect((await inventory.current()).capabilities).toEqual([{ cap: 'demo.render', summary: 'Render a fixture file.', weight: 'heavy', ready: true }]))
})

test('an absent engine is instructions and never an install, and an unknown requirement is not found', async () => {
  const { setup, scheduler, at } = host()
  const needs = await setup.requirements()
  const engine = needs.find((need) => need.title === 'Image engine')!
  expect(engine).toMatchObject({ action: 'instructions', instructions: expect.stringContaining('Install') })
  expect(engine.bytes).toBeUndefined()
  expect(() => setup.install(engine.id, 'job-engine')).toThrow(expect.objectContaining({ code: 'refused' }))
  expect(() => setup.install('weights', 'job-raw')).toThrow(expect.objectContaining({ code: 'not-found' }))
  expect(() => setup.install(needs[0]!.id, '../escape')).toThrow(expect.objectContaining({ code: 'refused' }))
  expect(scheduler.status('job-engine')).toBeUndefined()
  expect(scheduler.queue().waiting).toEqual([])
  expect(existsSync(at('engine'))).toBe(false)
  expect(existsSync(at('configured'))).toBe(false)
})

test('nothing is known to install before the list was asked for', () => {
  const { setup } = host()
  expect(() => setup.install('weights', 'job-1')).toThrow(ComputeError)
})

test('a failed install fails its job with the worker\'s own first line, and a cancelled one is cancelled', async () => {
  const { setup, scheduler, ensureLlama, done } = host()
  const needs = await setup.requirements()
  ensureLlama.mockRejectedValueOnce(new Error('Not enough room on the disk.\nat download'))
  setup.install(needs[0]!.id, 'job-fails')
  expect(await done('job-fails')).toMatchObject({ state: 'failed', failure: { code: 'worker-failure', message: 'Not enough room on the disk.' } })
  await vi.waitFor(() => expect(() => setup.install(needs[0]!.id, 'job-fails')).toThrow(expect.objectContaining({ code: 'refused' })))

  ensureLlama.mockImplementationOnce((_dir, runtime = {}) => new Promise((_resolve, reject) => {
    runtime.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }))
  setup.install(needs[0]!.id, 'job-cancelled')
  await vi.waitFor(() => expect(scheduler.status('job-cancelled')).toMatchObject({ state: 'running' }))
  expect(scheduler.cancel('job-cancelled')).toMatchObject({ state: 'cancelling' })
  expect(await done('job-cancelled')).toMatchObject({ state: 'cancelled' })
  // Still missing, and still installable.
  await vi.waitFor(async () => expect((await setup.requirements())[0]).toMatchObject({ title: 'llama.cpp runtime', action: 'install' }))
})

test('stopping the worker after setup stops what Alexia started and leaves a program of the person\'s own running', async () => {
  const { setup, workers, plugins, at, done } = host({ engine: true })
  const personal = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  cleanups.push(() => { personal.kill() })
  const needs = await setup.requirements()
  setup.install(needs[2]!.id, 'job-weights')
  await done('job-weights')

  const worker = (await workers.forCapability('demo.render'))!
  await worker.stop()
  expect(plugins.process(worker.id)?.pid).toBeUndefined()
  // Nothing was loaded by a setup, so there is nothing to release.
  expect(existsSync(at('released'))).toBe(false)
  expect(personal.exitCode).toBeNull()
  expect(() => process.kill(personal.pid!, 0)).not.toThrow()
  expect(existsSync(at('engine'))).toBe(true)
})

test('install failures remove POSIX and Windows host paths before the scheduler publishes them', async () => {
  const { setup, scheduler, ensureLlama, done } = host()
  const needs = await setup.requirements()
  for (const [index, path] of ['/home/sam/models/weights.bin', 'C:\\Users\\sam\\weights.bin'].entries()) {
    const jobId = `job-path-${index}`
    const events: JobSnapshot[] = []
    const off = scheduler.onJob((job) => { if (job.id === jobId) events.push(job) })
    ensureLlama.mockRejectedValueOnce(new ComputeError('worker-failure', `Cannot write ${path}: see https://example.com/help.\nat private stack`))
    setup.install(needs[0]!.id, jobId)
    expect(await done(jobId)).toMatchObject({ state: 'failed', failure: { code: 'worker-failure', message: 'Cannot write a file on that computer: see https://example.com/help.' } })
    expect(JSON.stringify(events)).not.toContain(path)
    off()
    await vi.waitFor(() => expect(() => setup.install(needs[0]!.id, jobId)).toThrow(expect.objectContaining({ code: 'refused' })))
  }
})

test('a plugin install that ignores cancellation is stopped after fifteen seconds', async () => {
  const r = host({ engine: true })
  const needs = await r.setup.requirements()
  const need = needs.find((one) => one.title === 'Fixture weights')!
  const worker = r.inventory.requirement(need.id)!.worker
  let signal: AbortSignal | undefined
  vi.spyOn(worker, 'install').mockImplementation(async (_id, io) => {
    signal = io.signal
    return await new Promise<never>(() => {})
  })
  const stop = vi.spyOn(worker, 'stop').mockResolvedValue()
  const deadlines: { fn(): void; ms: number; live: boolean }[] = []
  const setup = new Setup({ ...r, timer: (fn, ms) => {
    const deadline = { fn, ms, live: true }
    deadlines.push(deadline)
    return { clear: () => { deadline.live = false } }
  } })
  setup.install(need.id, 'job-hung-install')
  await vi.waitFor(() => { expect(signal).toBeDefined() })
  expect(r.scheduler.cancel('job-hung-install')).toMatchObject({ state: 'cancelling' })
  expect(signal!.aborted).toBe(true)
  expect(stop).not.toHaveBeenCalled()
  expect(deadlines).toHaveLength(1)
  expect(deadlines[0]!.ms).toBe(CANCEL_STOP_MS)
  deadlines[0]!.fn()
  expect(await r.done('job-hung-install')).toMatchObject({ state: 'cancelled' })
  expect(stop).toHaveBeenCalledTimes(1)
  expect(stop).toHaveBeenCalledWith({ force: true })
  expect(deadlines[0]!.live).toBe(false)
})
