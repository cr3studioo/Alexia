// SPDX-License-Identifier: AGPL-3.0-only
import { Manifest, MCP_PINNED, type ManifestInput } from '@alexia/protocol'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import { Artifacts } from '../src/compute/artifacts.js'
import { Scheduler } from '../src/compute/scheduler.js'
import { CANCEL_STOP_MS, runWorker } from '../src/compute/setup.js'
import { ComputeError, type JobProgress } from '../src/compute/types.js'
import { pluginWorkers, TEXT_WORKER, textWorker, Workers, type ComputeWorker, type JobIo, type TextWorkerOptions } from '../src/compute/workers.js'
import { remember } from '../src/installed.js'
import { LLAMA } from '../src/llama.js'
import { Plugins } from '../src/plugins.js'
import { memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'

const sdk = pathToFileURL(join(import.meta.dirname, '..', '..', 'sdk', 'dist', 'src', 'index.js')).href
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'alexia-compute-workers-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  return root
}

/** A broker with one engine in it that loads nothing: it only remembers what it was asked. */
function text(overrides: Partial<TextWorkerOptions> = {}) {
  const root = temp()
  const file = join(root, 'weights')
  writeFileSync(file, 'weights')
  for (const [id, format] of [['llama/test', 'gguf'], ['mlx/test', 'mlx']] as const) remember(root, {
    id, format, name: 'Test', repo: 'test/model', revision: 'a'.repeat(40), quant: 'Q4', files: [file], bytes: 7,
    context: 8192, tools: true, vision: false, abliterated: false, nsfwOk: 'unknown', vetted: false, ready: true, installedAt: 1,
  })
  let model: string | undefined
  const released = vi.fn()
  const prepare = vi.fn(async (id: string) => { model = id; return { baseUrl: 'http://127.0.0.1:1/v1', key: 'secret', release: released } })
  const stop = vi.fn(async () => { model = undefined })
  const runners: TextWorkerOptions['runners'] = {
    provider: () => ({ ...LLAMA, prepare }),
    loaded: () => (model ? { model, baseUrl: 'http://127.0.0.1:1/v1', since: 1 } : undefined),
    stop,
  }
  const worker = textWorker({
    dataDir: root, runners, backend: async () => 'cpu', llamaSupported: () => true, llamaReady: () => ({}) as never,
    mlxSupported: () => false, ...overrides,
  })
  return { root, worker, prepare, stop, released }
}

function fixture(options: { hangRelease?: boolean } = {}) {
  const root = temp()
  const id = 'worker-fixture'
  const dir = join(root, 'installed', id)
  const at = (name: string): string => join(root, name)
  mkdirSync(dir, { recursive: true })
  mkdirSync(at('made'))
  const manifest = Manifest.parse({
    manifest_version: 1, id, name: 'Fixture worker', summary: 'Exercises the generic worker contract.', version: '0.1.0',
    license: 'AGPL-3.0-only', entry: { run: 'node', args: ['index.mjs'] }, alexia_protocol: 13, mcp_protocol: MCP_PINNED,
    provides: ['demo.render', 'demo.slow'],
    compute: {
      operations: [
        { cap: 'demo.render', summary: 'Render a fixture file.' },
        { cap: 'demo.slow', summary: 'Never finish.', weight: 'light' },
      ],
      hooks: ['prepare', 'release'],
    },
  } satisfies ManifestInput)
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'index.mjs'), `
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { plugin } from ${JSON.stringify(sdk)}
writeFileSync(${JSON.stringify(at('spawned'))}, String(process.pid))
const alexia = plugin()
alexia.computeOperation('demo.render', async (args, ctx) => {
  await alexia.progress(ctx, 1, 2, 'Rendering.')
  await alexia.settings()
  const made = join(${JSON.stringify(at('made'))}, 'picture.txt')
  writeFileSync(made, readFileSync(args.source, 'utf8').toUpperCase() + ' x' + args.scale)
  return { text: 'Rendered.', files: [made] }
})
alexia.computeOperation('demo.slow', async () => {
  writeFileSync(${JSON.stringify(at('slow'))}, 'started')
  await new Promise(() => {})
  return { files: [] }
})
alexia.computeHooks({
  prepare: async (cap) => writeFileSync(${JSON.stringify(at('prepared'))}, cap),
  release: async () => {
    writeFileSync(${JSON.stringify(at('released'))}, 'released')
    if (${JSON.stringify(options.hangRelease ?? false)}) {
      process.stdin.removeAllListeners('end')
      process.stdin.removeAllListeners('close')
      process.on('SIGTERM', () => {})
      setInterval(() => {}, 1000)
      await new Promise(() => {})
    }
  },
})
await alexia.start()
`)
  const store = new Store(':memory:')
  const late: { workers?: Workers } = {}
  // A host: no `sample`, no roots, and the one listener every plugin change lands on.
  const plugins = new Plugins({
    dir: join(root, 'installed'), dataDir: join(root, 'data'), store, secrets: memorySecrets(),
    onToolsChanged: () => late.workers?.changed(),
  })
  plugins.load()
  plugins.enable(id)
  cleanups.push(async () => { await plugins.stop(); store.close() })
  const workers = late.workers = new Workers(text().worker, () => pluginWorkers(plugins))
  const artifacts = new Artifacts({ dir: join(root, 'data', 'compute', 'jobs') })
  return { root, dir, at, plugins, workers, artifacts }
}

async function staged(artifacts: Artifacts, jobId: string, words: string): Promise<{ args: Record<string, unknown>; io: JobIo; progress: JobProgress[] }> {
  const bytes = Buffer.from(words)
  const input = await artifacts.put({ jobId, name: 'source.txt', mime: 'text/plain', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, Readable.from([bytes]))
  artifacts.claimed(jobId)
  const progress: JobProgress[] = []
  return {
    args: artifacts.resolve(jobId, { source: { $artifact: input.id }, scale: 2 }),
    io: { signal: new AbortController().signal, dir: artifacts.jobDir(jobId), progress: (one) => progress.push(one), output: () => {} },
    progress,
  }
}

test('the text worker loads a model through the runners it was given, and says what is installed', async () => {
  const { worker, prepare } = text()
  expect(worker.id).toBe(TEXT_WORKER)
  expect(worker.loaded()).toBe(false)
  expect(prepare).not.toHaveBeenCalled()
  expect(worker.models().map((model) => [model.id, model.engine, model.loaded])).toEqual([['llama/test', 'llama', false], ['mlx/test', 'mlx', false]])

  const lease = await worker.acquire('llama/test')
  expect(lease).toMatchObject({ baseUrl: 'http://127.0.0.1:1/v1', key: 'secret' })
  expect(prepare).toHaveBeenCalledWith('llama/test', undefined)
  expect(worker.loaded()).toBe(true)
  expect(worker.models().find((model) => model.id === 'llama/test')).toMatchObject({ loaded: true, context: 8192, supportsTools: true, modality: ['text'], quant: 'Q4', diskBytes: 7 })
  expect(await worker.capabilities()).toEqual([])
  await expect(worker.run('demo.render', {}, {} as JobIo)).rejects.toMatchObject({ code: 'not-found' })
})

test('stopping the text worker ends its leases and releases the memory, and the model is reacquired afterwards', async () => {
  const { worker, prepare, stop, released } = text()
  const lease = await worker.acquire('llama/test')
  await worker.stop()
  expect(released).toHaveBeenCalledTimes(1)
  expect(stop).toHaveBeenCalledTimes(1)
  expect(worker.loaded()).toBe(false)
  lease.release()
  expect(released).toHaveBeenCalledTimes(1)
  await worker.stop()

  await worker.acquire('llama/test')
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(worker.loaded()).toBe(true)
})

test('the scheduler stops an idle text worker after its timeout, and selecting the model again loads it again', async () => {
  const { worker, prepare, stop } = text()
  const timers: (() => void)[] = []
  const scheduler = new Scheduler({ idleMs: 10, timer: (fn) => { timers.push(fn); return { clear: () => { timers.splice(timers.indexOf(fn), 1) } } } })
  scheduler.register(worker)
  const release = scheduler.hold(worker.id)
  await worker.acquire('llama/test')
  expect(timers).toHaveLength(1)
  timers[0]!()
  await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
  expect(worker.loaded()).toBe(false)
  release()

  scheduler.hold(worker.id)
  await worker.acquire('llama/test')
  expect(prepare).toHaveBeenCalledTimes(2)
  await scheduler.close()
})

test('the text worker refuses to load what would need an install nobody asked for', async () => {
  const ensureLlama = vi.fn()
  const { worker, prepare } = text({ llamaReady: () => undefined, mlxReady: () => undefined, ensureLlama })
  await expect(worker.acquire('llama/test')).rejects.toMatchObject({ code: 'setup-required' })
  await expect(worker.acquire('mlx/test')).rejects.toMatchObject({ code: 'setup-required' })
  await expect(worker.acquire('llama/absent')).rejects.toMatchObject({ code: 'setup-required' })
  expect(prepare).not.toHaveBeenCalled()
  expect(ensureLlama).not.toHaveBeenCalled()
})

test('a cancelled load is cancelled, and a runner that fails is a worker failure', async () => {
  const stopped = new AbortController()
  stopped.abort()
  const { worker, prepare } = text()
  prepare.mockRejectedValueOnce(new Error('aborted'))
  await expect(worker.acquire('llama/test', stopped.signal)).rejects.toMatchObject({ code: 'cancelled' })
  prepare.mockRejectedValueOnce(new Error('The runner exited.\nstack'))
  await expect(worker.acquire('llama/test')).rejects.toMatchObject({ code: 'worker-failure', message: 'The runner exited.' })
})

test('plugin workers are found without starting anything, and one runs an operation whose output is adopted', async () => {
  const { workers, artifacts, at } = fixture()
  const worker = (await workers.forCapability('demo.render'))!
  expect(worker).toBeDefined()
  expect(workers.all()).toEqual([workers.text, worker])
  expect(await worker.capabilities()).toEqual([
    { cap: 'demo.render', summary: 'Render a fixture file.', weight: 'heavy', ready: true },
    { cap: 'demo.slow', summary: 'Never finish.', weight: 'light', ready: true },
  ])
  expect(await worker.setup()).toEqual([])
  expect(await workers.forCapability('demo.absent')).toBeUndefined()
  expect(worker.loaded()).toBe(false)
  expect(existsSync(at('spawned'))).toBe(false)

  const { args, io, progress } = await staged(artifacts, 'job-1', 'a staged input')
  const result = await worker.run('demo.render', args, io)
  expect(result.text).toBe('Rendered.')
  expect(readFileSync(at('prepared'), 'utf8')).toBe('demo.render')
  expect(progress).toEqual([{ progress: 1, total: 2, message: 'Rendering.' }])
  expect(worker.loaded()).toBe(true)

  const output = await artifacts.adopt('job-1', result.files[0]!, { mime: 'text/plain' })
  expect(output).toMatchObject({ jobId: 'job-1', name: 'picture.txt', mime: 'text/plain', bytes: 'A STAGED INPUT x2'.length })
  expect(existsSync(result.files[0]!)).toBe(false)
  const chunks: Buffer[] = []
  for await (const chunk of artifacts.open(output.id).bytes) chunks.push(chunk as Buffer)
  expect(Buffer.concat(chunks).toString()).toBe('A STAGED INPUT x2')

  await expect(worker.run('demo.absent', {}, io)).rejects.toMatchObject({ code: 'not-found' })
  await expect(worker.install('anything', io)).rejects.toMatchObject({ code: 'refused' })
})

test('stopping a plugin worker releases it and stops only its own process; its next job starts it again', async () => {
  const { workers, plugins, artifacts, at } = fixture()
  // Something the person runs for themselves. Nothing in the worker contract can reach it.
  const personal = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  cleanups.push(() => { personal.kill() })
  const worker = (await workers.forCapability('demo.render'))!

  await worker.stop()
  expect(existsSync(at('spawned'))).toBe(false)
  expect(existsSync(at('released'))).toBe(false)

  const first = await staged(artifacts, 'job-1', 'one')
  await worker.run('demo.render', first.args, first.io)
  const pid = readFileSync(at('spawned'), 'utf8')
  await worker.stop()
  expect(readFileSync(at('released'), 'utf8')).toBe('released')
  expect(worker.loaded()).toBe(false)
  expect(plugins.process(worker.id)?.pid).toBeUndefined()
  expect(personal.exitCode).toBeNull()
  expect(() => process.kill(personal.pid!, 0)).not.toThrow()

  const second = await staged(artifacts, 'job-2', 'two')
  expect((await worker.run('demo.render', second.args, second.io)).files).toHaveLength(1)
  expect(readFileSync(at('spawned'), 'utf8')).not.toBe(pid)
})

test('cancellation stops a process with a hanging release at fifteen seconds and holds its slot until exit', async () => {
  const { workers, plugins, artifacts, at } = fixture({ hangRelease: true })
  const scheduler = new Scheduler()
  cleanups.push(() => scheduler.close())
  workers.bind(scheduler)
  const worker = (await workers.forCapability('demo.slow'))!
  const active = scheduler.submit({ id: 'job-1', kind: 'operation', weight: 'heavy', label: 'demo.slow', worker: worker.id })
  await active.turn
  artifacts.claimed('job-1')
  let elapsed = 0
  let deadline!: { fn(): void; at: number }
  const running = runWorker(worker, active.signal, () => worker.run('demo.slow', {}, {
    signal: active.signal, dir: artifacts.jobDir('job-1'), progress: () => {}, output: () => {},
  }), (fn, ms) => {
    deadline = { fn, at: elapsed + ms }
    return { clear: () => {} }
  }).catch(() => { active.finish({ state: 'cancelled' }) })
  await vi.waitFor(() => expect(existsSync(at('slow'))).toBe(true))
  const pid = Number(readFileSync(at('spawned'), 'utf8'))
  const queued = scheduler.submit({ id: 'job-2', kind: 'operation', weight: 'heavy', label: 'demo.slow', worker: worker.id })
  let admitted = false
  const next = queued.turn.then(() => {
    admitted = true
    expect(() => process.kill(pid, 0)).toThrow()
  })
  void next.catch(() => {})
  const stopProcess = plugins.stopProcess.bind(plugins)
  let acknowledgeExit!: () => void
  const exited = new Promise<void>((resolve) => { acknowledgeExit = resolve })
  let terminated = false
  const stop = vi.spyOn(plugins, 'stopProcess').mockImplementation(async (handle, options) => {
    expect(elapsed).toBe(CANCEL_STOP_MS)
    expect(admitted).toBe(false)
    await stopProcess(handle, options)
    expect(() => process.kill(pid, 0)).toThrow()
    terminated = true
    await exited
  })
  cleanups.push(async () => {
    acknowledgeExit()
    stop.mockRestore()
    await stopProcess(worker.id, { force: true })
    active.finish({ state: 'cancelled' })
    queued.finish({ state: 'cancelled' })
  })
  // An ordinary stop is already stuck inside a release hook that never resolves.
  const releasing = worker.stop()
  await vi.waitFor(() => expect(existsSync(at('released'))).toBe(true))
  scheduler.cancel('job-1')
  expect(deadline.at).toBe(CANCEL_STOP_MS)
  elapsed = CANCEL_STOP_MS - 1
  expect(stop).not.toHaveBeenCalled()
  expect(() => process.kill(pid, 0)).not.toThrow()
  elapsed = deadline.at
  deadline.fn()
  await vi.waitFor(() => expect(terminated).toBe(true))
  expect(stop).toHaveBeenCalledWith(worker.id, { force: true })
  expect(scheduler.status('job-1')).toMatchObject({ state: 'cancelling' })
  expect(scheduler.status('job-2')).toMatchObject({ state: 'queued' })
  expect(admitted).toBe(false)
  acknowledgeExit()
  await Promise.all([running, releasing, next])
  expect(scheduler.status('job-1')).toMatchObject({ state: 'cancelled' })
  expect(admitted).toBe(true)
  queued.finish({ state: 'succeeded' })
  stop.mockRestore()
})

test('a plugin that vanishes mid-job fails that job as a worker failure and its worker is unregistered', async () => {
  const { workers, plugins, artifacts, dir, at } = fixture()
  const scheduler = new Scheduler()
  cleanups.push(() => scheduler.close())
  const changed = vi.fn()
  workers.onChange(changed)
  workers.bind(scheduler)
  plugins.watch()
  const worker = (await workers.forCapability('demo.slow'))!

  artifacts.claimed('job-1')
  const admission = scheduler.submit({ id: 'job-1', kind: 'operation', weight: 'light', label: 'demo.slow', worker: worker.id })
  await admission.turn
  const running = worker.run('demo.slow', {}, { signal: admission.signal, dir: artifacts.jobDir('job-1'), progress: () => {}, output: () => {} })
  const outcome = running.catch((error: unknown) => error)
  await vi.waitFor(() => expect(existsSync(at('slow'))).toBe(true))

  rmSync(dir, { recursive: true, force: true })
  await vi.waitFor(() => expect(scheduler.status('job-1')).toMatchObject({ state: 'failed', failure: { code: 'worker-failure' } }))
  expect(await outcome).toBeInstanceOf(ComputeError)
  expect(changed).toHaveBeenCalled()
  expect(workers.all()).toEqual([workers.text])
  expect(await workers.forCapability('demo.slow')).toBeUndefined()
  expect(() => scheduler.submit({ id: 'job-2', kind: 'operation', weight: 'light', label: 'demo.slow', worker: worker.id })).toThrow(ComputeError)
  // Chat is untouched: the text worker is still registered and still takes a job.
  const chat = scheduler.submit({ id: 'job-3', kind: 'chat', weight: 'heavy', label: 'llama/test', worker: TEXT_WORKER })
  await chat.turn
  chat.finish({ state: 'succeeded' })
  expect(scheduler.status('job-3')).toMatchObject({ state: 'succeeded' })
})

test('a re-read keeps a worker whose declaration did not change, and replaces one whose did', () => {
  const declared = [{ handle: 'one', operations: [{ cap: 'demo.one', summary: 'One.' }], hooks: [] as never[] }]
  const seam = { computeWorkers: () => structuredClone(declared), computeCall: vi.fn(), stopProcess: vi.fn(async () => {}) }
  const workers = new Workers(text().worker, () => pluginWorkers(seam))
  const changed = vi.fn()
  workers.onChange(changed)
  const [, before] = workers.all() as [ComputeWorker, ComputeWorker]
  workers.changed()
  expect(workers.all()[1]).toBe(before)
  expect(changed).not.toHaveBeenCalled()

  declared[0]!.operations.push({ cap: 'demo.two', summary: 'Two.' })
  expect(workers.all()[1]).not.toBe(before)
  expect(changed).toHaveBeenCalledTimes(1)
})
