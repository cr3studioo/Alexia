// SPDX-License-Identifier: AGPL-3.0-only
import { Manifest, MCP_PINNED, type ManifestInput } from '@alexia/protocol'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import { Artifacts } from '../src/compute/artifacts.js'
import { memoryConnect } from '../src/compute/connect.js'
import { Controller, Frames, send } from '../src/compute/controller.js'
import { HostProtocol } from '../src/compute/hostProtocol.js'
import { Hosts } from '../src/compute/hosts.js'
import { Inventory } from '../src/compute/inventory.js'
import { JOBS_KEY, RemoteJobs } from '../src/compute/jobs.js'
import type { ControlEvent, InferHead, JobEvent, Lease } from '../src/compute/protocol.js'
import { Scheduler } from '../src/compute/scheduler.js'
import { CANCEL_STOP_MS } from '../src/compute/setup.js'
import { fetchArtifact, upload } from '../src/compute/transfer.js'
import { ComputeError, RECONNECT_GRACE_MS } from '../src/compute/types.js'
import { pluginWorkers, textWorker, Workers } from '../src/compute/workers.js'
import { remember } from '../src/installed.js'
import { LLAMA } from '../src/llama.js'
import type { Machine } from '../src/machine.js'
import { Plugins } from '../src/plugins.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'

/**
 * Both ends, for the first time: the real `Controller`, `RemoteJobs` and transfer on one side,
 * the real `HostProtocol`, scheduler, artifact store and a plugin worker on the other, joined
 * by the in-memory transport. Only the text runner's HTTP address and the clocks are stubs.
 */

const sdk = pathToFileURL(join(import.meta.dirname, '..', '..', 'sdk', 'dist', 'src', 'index.js')).href
const cleanups: (() => Promise<void> | void)[] = []
// A plugin worker is a real process, and starting or stopping one takes more than vitest's one second
// on a loaded Windows runner. Every wait here is for that, so every wait gets room.
const waitFor: typeof vi.waitFor = (callback, options) => vi.waitFor(callback, { timeout: 15_000, ...(typeof options === 'number' ? { timeout: options } : options) })
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
}, 30_000)

const GB = 1024 ** 3
const hardware: Machine = {
  platform: 'linux', arch: 'x64', chip: 'Test CPU', appleSilicon: false, ramBytes: 64 * GB, freeRamBytes: 48 * GB,
  freeDiskBytes: 200 * GB, diskKnown: true, budgetBytes: 44 * GB, cpuCores: 16,
}

const sse = (value: unknown): string => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
const RUNNER_SSE = Buffer.from([
  ': keep alive\n\n',
  sse({ model: 'llama/test', choices: [{ delta: { reasoning_content: 'Think carefully.' } }] }),
  sse({ choices: [{ delta: { content: 'Hello, 世界', tool_calls: [{ index: 0, id: 'call-1', function: { name: 'inspect', arguments: '{"name":"a"}' } }] } }] }),
  sse({ usage: { prompt_tokens: 31, completion_tokens: 17 }, choices: [] }),
  sse('[DONE]'),
].join(''))

function temp(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `alexia-compute-${name}-`))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  return root
}

interface Timer { fn(): void; ms: number; live: boolean }
function clock() {
  const timers: Timer[] = []
  const timer = (fn: () => void, ms: number): { clear(): void } => {
    const entry = { fn, ms, live: true }
    timers.push(entry)
    return { clear: () => { entry.live = false } }
  }
  return { timers, timer }
}

/** A plugin that declares three operations: one that renders a staged input, one that waits to be let through, one that never ends. */
function fixturePlugin(root: string) {
  const id = 'worker-fixture'
  const dir = join(root, 'installed', id)
  const at = (name: string): string => join(root, name)
  mkdirSync(dir, { recursive: true })
  mkdirSync(at('made'))
  const manifest = Manifest.parse({
    manifest_version: 1, id, name: 'Fixture worker', summary: 'Exercises the compute round trip.', version: '0.1.0',
    license: 'AGPL-3.0-only', entry: { run: 'node', args: ['index.mjs'] }, alexia_protocol: 13, mcp_protocol: MCP_PINNED,
    provides: ['demo.render', 'demo.gate', 'demo.wait'],
    compute: { operations: [
      { cap: 'demo.render', summary: 'Render a fixture file.' },
      { cap: 'demo.gate', summary: 'Wait to be let through.' },
      { cap: 'demo.wait', summary: 'Never finish.' },
    ] },
  } satisfies ManifestInput)
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'index.mjs'), `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { plugin } from ${JSON.stringify(sdk)}
const alexia = plugin()
writeFileSync(${JSON.stringify(at('pid'))}, String(process.pid))
const ran = (cap) => appendFileSync(${JSON.stringify(at('ran'))}, cap + '\\n')
alexia.computeOperation('demo.render', async (args, ctx) => {
  ran('demo.render')
  await alexia.progress(ctx, 1, 2, 'Rendering.')
  const made = join(${JSON.stringify(at('made'))}, 'picture.txt')
  writeFileSync(made, readFileSync(args.source, 'utf8').toUpperCase() + ' x' + args.scale)
  return { text: 'Rendered.', files: [made] }
})
alexia.computeOperation('demo.gate', async () => {
  ran('demo.gate')
  while (!existsSync(${JSON.stringify(at('go'))})) await new Promise((resolve) => setTimeout(resolve, 20))
  const made = join(${JSON.stringify(at('made'))}, 'gate.txt')
  writeFileSync(made, 'through the gate')
  return { files: [made] }
})
alexia.computeOperation('demo.wait', async (_args, ctx) => {
  ran('demo.wait')
  ctx.mcpReq.signal.addEventListener('abort', () => writeFileSync(${JSON.stringify(at('cancelled'))}, 'MCP cancellation'), { once: true })
  await new Promise(() => {})
  return { files: [] }
})
await alexia.start()
`)
  const ran = (): string[] => existsSync(at('ran')) ? readFileSync(at('ran'), 'utf8').trim().split('\n') : []
  return { id, at, ran }
}

async function rig(saved: unknown[] = []) {
  const laptopRoot = temp('laptop')
  const studioRoot = temp('studio')
  const { a, b } = memoryConnect()
  const [laptop, studio] = [await a.identity(), await b.identity()]
  await a.allow([studio])
  await b.allow([laptop])

  // The compute host.
  const hostStore = new Store(':memory:')
  const paired = new Hosts(hostStore, 'compute')
  paired.add({ name: 'Laptop', endpointId: laptop, peerRole: 'interaction' }, 1)
  const hostClock = clock()
  const workerClock = clock()
  const scheduler = new Scheduler({ timer: hostClock.timer })
  const weights = join(studioRoot, 'weights')
  writeFileSync(weights, 'weights')
  remember(studioRoot, {
    id: 'llama/test', format: 'gguf', name: 'Test', repo: 'test/model', revision: 'a'.repeat(40), quant: 'Q4', files: [weights], bytes: 7,
    context: 8192, tools: true, vision: false, abliterated: false, nsfwOk: 'unknown', vetted: false, ready: true, installedAt: 1,
  })
  let loaded: string | undefined
  const text = textWorker({
    dataDir: studioRoot,
    runners: {
      provider: () => ({ ...LLAMA, prepare: async (id: string) => { loaded = id; return { baseUrl: 'http://127.0.0.1:1/v1', key: 'secret', release: () => {} } } }),
      loaded: () => (loaded ? { model: loaded, baseUrl: 'http://127.0.0.1:1/v1', since: 1 } : undefined),
      stop: async () => { loaded = undefined },
    },
    backend: async () => 'cpu', llamaSupported: () => true, llamaReady: () => ({}) as never, mlxSupported: () => false,
  })
  const plugin = fixturePlugin(studioRoot)
  const late: { workers?: Workers } = {}
  const plugins = new Plugins({
    dir: join(studioRoot, 'installed'), dataDir: join(studioRoot, 'data'), store: hostStore, secrets: memorySecrets(),
    onToolsChanged: () => late.workers?.changed(),
  })
  plugins.load()
  plugins.enable(plugin.id)
  const workers = late.workers = new Workers(text, () => pluginWorkers(plugins))
  const artifacts = new Artifacts({ dir: join(studioRoot, 'data', 'compute', 'jobs') })
  const inventory = new Inventory({ dataDir: studioRoot, name: 'Studio', appVersion: '2.0.0', workers, machine: async () => hardware })
  const runner = { calls: [] as Buffer[] }
  const protocol = new HostProtocol({
    connect: b, hosts: paired, scheduler, workers, artifacts, inventory, name: 'Studio', appVersion: '2.0.0', store: hostStore,
    models: { call: async () => ({}) }, timer: hostClock.timer, workerTimer: workerClock.timer,
    fetch: (async (_input: unknown, init?: RequestInit) => {
      runner.calls.push(Buffer.from(init!.body as Uint8Array))
      return new Response(RUNNER_SSE, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
    }) as typeof fetch,
  })
  protocol.start()

  // The interaction computer.
  const store = new Store(':memory:')
  const hosts = new Hosts(store, 'interaction')
  const host = hosts.add({ name: 'Studio', endpointId: studio, peerRole: 'compute' }, 1)
  if (saved.length > 0) store.kvSet(CORE, JOBS_KEY, saved.map((jobId) => ({ hostId: host.id, jobId, label: 'demo.render', createdAt: 1 })))
  const controllerClock = clock()
  const late2: { jobs?: RemoteJobs } = {}
  const controller = new Controller({
    connect: a, hosts, name: 'Laptop', appVersion: '1.0.0', timer: controllerClock.timer,
    resume: (hostId) => late2.jobs?.outstanding(hostId) ?? [],
  })
  const jobs = late2.jobs = new RemoteJobs({ controller, store })
  const heard: ControlEvent[] = []
  controller.onEvent((_hostId, event) => { heard.push(event) })

  cleanups.push(async () => {
    await controller.close()
    await protocol.close()
    await scheduler.close()
    await plugins.stop()
    inventory.close()
    await a.close()
    await b.close()
    store.close()
    hostStore.close()
  })

  /** The transport drops every stream, as a lost connection does, and stays down until `up()`. */
  const down = async (): Promise<() => void> => {
    const open = vi.spyOn(a, 'open').mockRejectedValue(new ComputeError('offline', 'That computer cannot be reached right now.'))
    await Promise.all([b.allow([]), b.allow([laptop])])
    return () => { open.mockRestore() }
  }
  const grace = (): Timer[] => hostClock.timers.filter((one) => one.ms === RECONNECT_GRACE_MS)
  /** The controller's next reconnection attempt, taken now rather than after its backoff. */
  const retry = (): void => { controllerClock.timers.filter((one) => one.live && one.ms < RECONNECT_GRACE_MS).at(-1)!.fn() }
  const stopCancelled = async (): Promise<void> => {
    await waitFor(() => { expect(workerClock.timers.filter((one) => one.live)).toHaveLength(1) })
    const deadline = workerClock.timers.find((one) => one.live)!
    expect(deadline.ms).toBe(CANCEL_STOP_MS)
    deadline.fn()
  }
  return { laptopRoot, studioRoot, a, b, laptop, studio, host, hosts, store, controller, jobs, heard, paired, scheduler, artifacts, plugin, protocol, runner, hostClock, workerClock, controllerClock, down, grace, retry, stopCancelled }
}

const rising = (events: JobEvent[]): boolean => events.every((event, at) => at === 0 || event.seq > events[at - 1]!.seq)
const states = (events: JobEvent[]): string[] => events.flatMap((event) => event.type === 'state' || event.type === 'done' ? [event.job.state] : [])

test('a text inference: prepare a lease, ask over an infer stream, and get the runner\'s bytes back unchanged', async () => {
  const r = await rig()
  const leases: Lease[] = []
  r.controller.onEvent((_hostId, event) => { if (event.event === 'lease') leases.push(event.lease) })

  const lease = await r.controller.call(r.host.id, 'prepare', { leaseId: 'lease-1', modelId: 'llama/test' })
  expect(lease).toMatchObject({ leaseId: 'lease-1', modelId: 'llama/test', phase: 'loading' })
  await waitFor(() => { expect(leases.at(-1)).toMatchObject({ leaseId: 'lease-1', phase: 'ready' }) })
  // The controller's view is the host's own inventory, with the host's model id unqualified.
  expect(r.controller.view(r.host.id)).toMatchObject({ connection: 'direct', inventory: { name: 'Studio', models: [{ id: 'llama/test' }] } })
  expect(r.controller.view(r.host.id)!.inventory!.capabilities.map((one) => one.cap)).toEqual(['demo.render', 'demo.gate', 'demo.wait'])

  const body = Buffer.from(JSON.stringify({ model: 'llama/test', stream: true, messages: [{ role: 'user', content: 'Hello' }] }))
  const stream = await r.controller.stream(r.host.id, { stream: 'infer', jobId: 'chat-1', leaseId: 'lease-1', bodyBytes: body.length })
  const frames = new Frames(stream)
  await send(stream, body)
  stream.end()
  expect(await frames.next() as InferHead).toEqual({ type: 'head', status: 200, contentType: 'text/event-stream; charset=utf-8' })
  const chunks: Uint8Array[] = []
  for await (const chunk of frames.bytes()) chunks.push(chunk)
  expect(Buffer.concat(chunks).equals(RUNNER_SSE)).toBe(true)
  expect(r.runner.calls).toHaveLength(1)
  expect(r.runner.calls[0]!.equals(body)).toBe(true)

  await waitFor(async () => { expect(await r.controller.call(r.host.id, 'job.status', { jobId: 'chat-1' })).toMatchObject({ kind: 'chat', state: 'succeeded' }) })
  expect(await r.controller.call(r.host.id, 'release', { leaseId: 'lease-1' })).toEqual({})
  expect(r.plugin.ran()).toEqual([])
})

test('a plugin operation: a staged input goes up, the job runs once, and its output is fetched, verified and acknowledged', async () => {
  const r = await rig()
  const source = join(r.laptopRoot, 'source.txt')
  writeFileSync(source, 'a staged input')

  const input = await upload(r.controller, r.host.id, 'job-1', { path: source, name: 'source.txt', mime: 'text/plain' })
  expect(input).toMatchObject({ jobId: 'job-1', name: 'source.txt', mime: 'text/plain', bytes: 14 })
  const inputs = join(r.studioRoot, 'data', 'compute', 'jobs', 'job-1', 'inputs')
  expect(readdirSync(inputs)).toEqual([input.id])

  const events: JobEvent[] = []
  const final = await r.jobs.run(r.host.id, { jobId: 'job-1', cap: 'demo.render', arguments: { source: { $artifact: input.id }, scale: 2 }, inputs: [input.id] },
    { onEvent: (event) => { events.push(event) } })
  expect(final).toMatchObject({ id: 'job-1', kind: 'operation', weight: 'heavy', state: 'succeeded', label: 'demo.render' })
  expect(final.artifacts).toEqual([expect.objectContaining({ jobId: 'job-1', name: 'picture.txt', bytes: 'A STAGED INPUT x2'.length })])
  expect(states(events)).toEqual(['queued', 'preparing', 'running', 'succeeded'])
  expect(events.filter((event) => event.type === 'progress')).toEqual([expect.objectContaining({ progress: { progress: 1, total: 2, message: 'Rendering.' } })])
  expect(events.filter((event) => event.type === 'output')).toEqual([expect.objectContaining({ output: { type: 'text', text: 'Rendered.' } })])
  expect(events.at(-1)).toEqual({ type: 'done', seq: expect.any(Number), job: final })
  expect(rising(events)).toBe(true)
  expect(r.plugin.ran()).toEqual(['demo.render'])
  // The job read its input; that copy is gone, and the job is no longer waited for.
  expect(existsSync(inputs) ? readdirSync(inputs) : []).toEqual([])
  expect(r.jobs.outstanding(r.host.id)).toEqual([])

  // Nothing the host said names a place on its disk.
  const said = JSON.stringify([input, events, final, r.heard])
  expect(said).not.toContain(r.studioRoot)
  expect(said).not.toContain('inputs')
  expect(said).not.toContain('outputs')

  // A transfer that broke earlier left the first bytes: the rest is asked for from there, and the stream ends with the file.
  const artifact = final.artifacts![0]!
  const home = join(r.laptopRoot, 'home')
  mkdirSync(home)
  writeFileSync(join(home, `${artifact.id}.part`), 'A STAG')
  const path = await fetchArtifact(r.controller, r.host.id, artifact, home)
  expect(path).toBe(join(home, 'picture.txt'))
  expect(readFileSync(path, 'utf8')).toBe('A STAGED INPUT x2')
  expect(readdirSync(home)).toEqual(['picture.txt'])

  // Acknowledged: the host's copy is deleted now, not at its expiry.
  await waitFor(() => { expect(() => r.artifacts.open(artifact.id)).toThrow(expect.objectContaining({ code: 'not-found' })) })
  expect(existsSync(join(r.studioRoot, 'data', 'compute', 'jobs', 'job-1'))).toBe(false)
  await expect(fetchArtifact(r.controller, r.host.id, artifact, join(r.laptopRoot, 'again'))).rejects.toMatchObject({ code: 'not-found' })
})

test('a queued job is cancelled at once and never reaches the worker; a running one is cancelled in it', async () => {
  const r = await rig()
  const active = new AbortController()
  const activeEvents: JobEvent[] = []
  const running = r.jobs.run(r.host.id, { jobId: 'job-active', cap: 'demo.wait' }, { onEvent: (event) => { activeEvents.push(event) } }, active.signal)
  await waitFor(() => { expect(r.plugin.ran()).toEqual(['demo.wait']) })

  const queued = new AbortController()
  const queuedEvents: JobEvent[] = []
  const waiting = r.jobs.run(r.host.id, { jobId: 'job-queued', cap: 'demo.gate' }, { onEvent: (event) => { queuedEvents.push(event) } }, queued.signal)
  await waitFor(() => { expect(states(queuedEvents)).toEqual(['queued']) })
  expect(r.jobs.queue(r.host.id)).toMatchObject({ running: { id: 'job-active' }, waiting: [{ id: 'job-queued' }] })

  queued.abort()
  expect(await waiting).toMatchObject({ id: 'job-queued', state: 'cancelled' })
  expect(states(queuedEvents)).toEqual(['queued', 'cancelled'])
  expect(r.plugin.ran()).toEqual(['demo.wait'])
  expect(r.scheduler.status('job-active')).toMatchObject({ state: 'running' })

  const pid = Number(readFileSync(r.plugin.at('pid'), 'utf8'))
  active.abort()
  await waitFor(() => { expect(existsSync(r.plugin.at('cancelled'))).toBe(true) })
  expect(r.scheduler.status('job-active')).toMatchObject({ state: 'cancelling' })
  expect(() => process.kill(pid, 0)).not.toThrow()
  await r.stopCancelled()
  expect(await running).toMatchObject({ id: 'job-active', state: 'cancelled' })
  await waitFor(() => { expect(() => process.kill(pid, 0)).toThrow() })
  expect(states(activeEvents)).toEqual(['queued', 'preparing', 'running', 'cancelling', 'cancelled'])
  expect(rising(activeEvents)).toBe(true)
  expect(r.jobs.outstanding(r.host.id)).toEqual([])
  expect(await r.jobs.cancel(r.host.id, 'job-active')).toMatchObject({ state: 'cancelled' })

  // The slot is free again, and the same worker takes the next job.
  writeFileSync(r.plugin.at('go'), '')
  expect(await r.jobs.run(r.host.id, { jobId: 'job-next', cap: 'demo.gate' })).toMatchObject({ state: 'succeeded', artifacts: [{ name: 'gate.txt' }] })
  expect(r.plugin.ran()).toEqual(['demo.wait', 'demo.gate'])
})

test('a connection lost and found within the grace resumes the same job by id, and nothing is submitted twice', async () => {
  const r = await rig()
  const events: JobEvent[] = []
  const submit = vi.spyOn(r.scheduler, 'submit')
  const running = r.jobs.run(r.host.id, { jobId: 'job-1', cap: 'demo.gate' }, { onEvent: (event) => { events.push(event) } })
  await waitFor(() => { expect(r.plugin.ran()).toEqual(['demo.gate']) })
  await waitFor(() => { expect(states(events)).toContain('running') })

  const up = await r.down()
  await waitFor(() => { expect(r.grace().filter((one) => one.live)).toHaveLength(1) })
  await waitFor(() => { expect(r.controller.view(r.host.id)?.failure?.code).toBe('offline') })
  expect(r.scheduler.status('job-1')).toMatchObject({ state: 'running' })

  up()
  r.retry()
  await waitFor(() => { expect(r.controller.view(r.host.id)?.failure).toBeUndefined() })
  // The reconnect is what clears the one timer; no second one was ever armed.
  expect(r.grace()).toHaveLength(1)
  expect(r.grace()[0]!.live).toBe(false)

  writeFileSync(r.plugin.at('go'), '')
  expect(await running).toMatchObject({ id: 'job-1', state: 'succeeded', artifacts: [{ name: 'gate.txt' }] })
  expect(rising(events)).toBe(true)
  expect(states(events).at(-1)).toBe('succeeded')
  expect(r.plugin.ran()).toEqual(['demo.gate'])
  expect(submit).toHaveBeenCalledTimes(1)
  expect(r.jobs.outstanding(r.host.id)).toEqual([])
})

test('a grace that runs out interrupts the job once, and the controller is told so instead of running it again', async () => {
  const r = await rig()
  const submit = vi.spyOn(r.scheduler, 'submit')
  const cancelAll = vi.spyOn(r.scheduler, 'cancelAll')
  const running = r.jobs.run(r.host.id, { jobId: 'job-1', cap: 'demo.wait' })
  await waitFor(() => { expect(r.plugin.ran()).toEqual(['demo.wait']) })

  const up = await r.down()
  await waitFor(() => { expect(r.grace().filter((one) => one.live)).toHaveLength(1) })
  r.grace()[0]!.fn()
  await r.stopCancelled()
  await waitFor(() => { expect(r.scheduler.status('job-1')).toMatchObject({ state: 'interrupted', failure: { code: 'interrupted' } }) })

  up()
  r.retry()
  expect(await running).toMatchObject({ id: 'job-1', state: 'interrupted' })
  expect(cancelAll).toHaveBeenCalledTimes(1)
  expect(submit).toHaveBeenCalledTimes(1)
  expect(r.plugin.ran()).toEqual(['demo.wait'])
  expect(r.grace()).toHaveLength(1)
  expect(r.jobs.outstanding(r.host.id)).toEqual([])
})

test('a job the host has never heard of is reported interrupted to a controller that was waiting on it, and not found to one that was not', async () => {
  // What a controller restart finds in `compute_jobs` after the host itself restarted.
  const r = await rig(['job-lost'])
  expect(r.jobs.outstanding(r.host.id)).toEqual(['job-lost'])
  expect(await r.jobs.attach(r.host.id, 'job-lost')).toMatchObject({ id: 'job-lost', state: 'interrupted' })
  expect(r.jobs.outstanding(r.host.id)).toEqual([])

  // With the session already open the host is asked directly: the attach stream closes and job.status says not-found.
  r.store.kvSet(CORE, JOBS_KEY, [{ hostId: r.host.id, jobId: 'job-lost-too', label: 'demo.render', createdAt: 1 }])
  expect(await r.jobs.attach(r.host.id, 'job-lost-too')).toMatchObject({ id: 'job-lost-too', state: 'interrupted' })
  await expect(r.jobs.attach(r.host.id, 'job-never')).rejects.toMatchObject({ code: 'not-found' })
  expect(r.plugin.ran()).toEqual([])
})

test('revoking from the host cancels the job, closes every stream and leaves the controller unpaired', async () => {
  const r = await rig()
  const running = r.jobs.run(r.host.id, { jobId: 'job-1', cap: 'demo.wait' })
  void running.catch(() => {})
  await waitFor(() => { expect(r.plugin.ran()).toEqual(['demo.wait']) })

  const revoking = r.protocol.revoke()
  await r.stopCancelled()
  await revoking
  expect(r.scheduler.status('job-1')).toMatchObject({ state: 'cancelled', failure: { code: 'unpaired' } })
  expect(r.paired.list()).toEqual([])
  await expect(running).rejects.toMatchObject({ code: 'unpaired' })
  expect(r.controller.view(r.host.id)).toMatchObject({ failure: { code: 'unpaired' } })
  expect(r.heard.at(-1)).toEqual({ event: 'bye', reason: 'unpaired' })
  // The record on the interaction computer stays, as the reason shown; asking again is refused the same way.
  expect(r.hosts.get(r.host.id)).toBeDefined()
  await expect(r.controller.ensure(r.host.id)).rejects.toMatchObject({ code: 'unpaired' })
})

test('unpair from the controller revokes its host record, cancels jobs and closes streams', async () => {
  const r = await rig()
  const running = r.jobs.run(r.host.id, { jobId: 'job-1', cap: 'demo.wait' }).catch((error: unknown) => error)
  await waitFor(() => { expect(r.plugin.ran()).toEqual(['demo.wait']) })
  const queued = r.jobs.run(r.host.id, { jobId: 'job-2', cap: 'demo.render' }).catch((error: unknown) => error)
  await waitFor(() => { expect(r.scheduler.queue().waiting.map((job) => job.id)).toEqual(['job-2']) })
  const input = await r.controller.stream(r.host.id, { stream: 'artifact', put: {
    jobId: 'job-3', name: 'input.txt', mime: 'text/plain', bytes: 10, sha256: 'a'.repeat(64),
  } })
  input.on('error', () => {})

  await r.controller.unpair(r.host.id)
  await r.stopCancelled()
  await waitFor(() => {
    expect(r.paired.list()).toEqual([])
    expect(r.scheduler.status('job-1')).toMatchObject({ state: 'cancelled', failure: { code: 'unpaired' } })
    expect(r.scheduler.status('job-2')).toMatchObject({ state: 'cancelled', failure: { code: 'unpaired' } })
    expect(input.destroyed).toBe(true)
  })
  await expect(r.b.open(r.laptop, 'control')).rejects.toMatchObject({ code: 'unpaired' })
  expect(r.plugin.ran()).toEqual(['demo.wait'])
  expect(r.paired.add({ name: 'Another computer', endpointId: 'c'.repeat(64), peerRole: 'interaction' }, 2)).toMatchObject({ name: 'Another computer' })
  await Promise.all([running, queued])
})

test('unpair while unreachable leaves the host record until unpaired at the host', async () => {
  const r = await rig()
  await r.controller.ensure(r.host.id)
  await r.a.allow([])
  const open = vi.spyOn(r.a, 'open')
  await r.controller.unpair(r.host.id)
  expect(open).not.toHaveBeenCalled()
  expect(r.paired.list()).toHaveLength(1)
  await r.protocol.revoke()
  expect(r.paired.list()).toEqual([])
})
