// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { afterEach, expect, test, vi } from 'vitest'
import { Artifacts } from '../src/compute/artifacts.js'
import { memoryConnect } from '../src/compute/connect.js'
import { Frames, HANDSHAKE_MS } from '../src/compute/controller.js'
import { HostProtocol, PAUSED_KEY, type HostProtocolOptions } from '../src/compute/hostProtocol.js'
import { Hosts } from '../src/compute/hosts.js'
import { Inventory } from '../src/compute/inventory.js'
import {
  encodeFrame, SPEAKS,
  type ControlEvent, type ControlMethod, type ControlResponse, type Hello, type JobEvent, type StreamKind, type Welcome,
} from '../src/compute/protocol.js'
import { Scheduler } from '../src/compute/scheduler.js'
import { CANCEL_STOP_MS } from '../src/compute/setup.js'
import { ComputeError, IDLE_STOP_MS, RECONNECT_GRACE_MS, type ArtifactRef } from '../src/compute/types.js'
import { textWorker, Workers, type ComputeWorker } from '../src/compute/workers.js'
import { remember } from '../src/installed.js'
import { LLAMA } from '../src/llama.js'
import type { Machine } from '../src/machine.js'
import { CORE } from '../src/secrets.js'
import { Store } from '../src/store.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const GB = 1024 ** 3
const hardware: Machine = {
  platform: 'linux', arch: 'x64', chip: 'Test CPU', appleSilicon: false, ramBytes: 64 * GB, freeRamBytes: 48 * GB,
  freeDiskBytes: 200 * GB, diskKnown: true, budgetBytes: 44 * GB, cpuCores: 16,
}

const sse = (value: unknown): string => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
/** An answer with everything in it that must survive untouched: a comment, reasoning, a tool call, usage, and text that is not ASCII. */
const RUNNER_SSE = Buffer.from([
  ': keep alive\n\n',
  sse({ model: 'llama/test', choices: [{ delta: { reasoning_content: 'Think carefully.' } }] }),
  sse({ choices: [{ delta: { content: 'Hello, 世界', tool_calls: [{ index: 0, id: 'call-1', function: { name: 'inspect', arguments: '{"name":"a"}' } }] } }] }),
  sse({ usage: { prompt_tokens: 31, completion_tokens: 17 }, choices: [] }),
  sse('[DONE]'),
].join(''))
const EVENT_STREAM = { 'content-type': 'text/event-stream; charset=utf-8' }

/** The text runner's loopback address, with nothing behind it but what a test says it answers. */
function stubRunner() {
  const calls: { url: string; authorization: string | null; body: Buffer }[] = []
  const state = {
    aborted: 0,
    // Cut where a character is half sent, so nothing in between may decode and re-encode.
    respond: ((): Response => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const cut = RUNNER_SSE.indexOf('世') + 1
        for (const part of [RUNNER_SSE.subarray(0, 9), RUNNER_SSE.subarray(9, cut), RUNNER_SSE.subarray(cut)]) controller.enqueue(new Uint8Array(part))
        controller.close()
      },
    }), { status: 200, headers: EVENT_STREAM })) as (signal: AbortSignal) => Response,
  }
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const signal = init!.signal!
    calls.push({ url: String(input), authorization: new Headers(init!.headers).get('authorization'), body: Buffer.from(init!.body as Uint8Array) })
    signal.addEventListener('abort', () => { state.aborted++ }, { once: true })
    return state.respond(signal)
  }) as typeof globalThis.fetch
  return { calls, state, fetch }
}

/** An answer that says one thing and then waits until its request is aborted. */
const hanging = (signal: AbortSignal): Response => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(sse({ choices: [{ delta: { content: 'One' } }] })))
    signal.addEventListener('abort', () => { controller.error(signal.reason) }, { once: true })
  },
}), { status: 200, headers: EVENT_STREAM })

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'alexia-compute-host-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  return root
}

const installed = (root: string, id: string): void => {
  const file = join(root, 'weights')
  writeFileSync(file, 'weights')
  remember(root, {
    id, format: 'gguf', name: id, repo: 'test/model', revision: 'a'.repeat(40), quant: 'Q4', files: [file], bytes: 7,
    context: 8192, tools: true, vision: false, abliterated: false, nsfwOk: 'unknown', vetted: false, ready: true, installedAt: 1,
  })
}

/** The text worker over a broker that loads nothing: it only remembers what it was asked. */
function text(root: string) {
  for (const id of ['llama/test', 'llama/other']) installed(root, id)
  let model: string | undefined
  const prepare = vi.fn(async (id: string) => { model = id; return { baseUrl: 'http://127.0.0.1:1/v1', key: 'secret', release: () => {} } })
  const worker = textWorker({
    dataDir: root,
    runners: {
      provider: () => ({ ...LLAMA, prepare }),
      loaded: () => (model ? { model, baseUrl: 'http://127.0.0.1:1/v1', since: 1 } : undefined),
      stop: async () => { model = undefined },
    },
    backend: async () => 'cpu', llamaSupported: () => true, llamaReady: () => ({}) as never, mlxSupported: () => false,
  })
  return { worker, prepare }
}

/** A worker made by hand, with one declared operation that can be held open. */
function fixtureWorker() {
  const state = { runs: 0, hold: false, release: (): void => {}, signals: [] as AbortSignal[] }
  const worker: ComputeWorker = {
    id: 'fixture-worker', loaded: () => false, stop: async () => {},
    capabilities: async () => [{ cap: 'demo.render', summary: 'Render a fixture file.', weight: 'heavy', ready: true }],
    setup: async () => [], install: async () => {},
    run: async (_cap, args, io) => {
      state.runs++
      state.signals.push(io.signal)
      io.progress({ progress: 1, total: 2, message: 'Rendering.' })
      if (state.hold) await new Promise<void>((resolve) => {
        state.release = resolve
        io.signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      if (io.signal.aborted) return { files: [] }
      const made = join(io.dir, 'picture.txt')
      writeFileSync(made, `rendered x${String(args.scale)}`)
      return { text: 'Rendered.', files: [made] }
    },
  }
  return { worker, state }
}

interface Timer { fn(): void; ms: number; live: boolean }

/** A controller that says exactly what a test tells it to, over the in-memory transport. */
class Session {
  readonly events: ControlEvent[] = []
  ended = false
  private readonly waiting = new Map<number, (response: ControlResponse) => void>()
  private id = 0

  constructor(readonly stream: Duplex, frames: Frames, readonly welcome: Welcome) {
    void (async () => {
      try {
        for (;;) {
          const frame = await frames.next() as ControlEvent | ControlResponse | undefined
          if (!frame) break
          if ('event' in frame) this.events.push(frame)
          else this.waiting.get(frame.id)?.(frame)
        }
      } catch { /* a session that broke */ }
      this.ended = true
    })()
  }

  ask(method: ControlMethod | string, params: Record<string, unknown> = {}): Promise<ControlResponse> {
    const id = ++this.id
    return new Promise((resolve) => {
      this.waiting.set(id, resolve)
      this.stream.write(encodeFrame({ id, method, params }))
    })
  }

  async call<T = unknown>(method: ControlMethod | string, params: Record<string, unknown> = {}): Promise<T> {
    const response = await this.ask(method, params)
    if (!response.ok) throw new ComputeError(response.failure.code, response.failure.message)
    return response.result as T
  }

  leases(leaseId: string): string[] {
    return this.events.flatMap((event) => event.event === 'lease' && event.lease.leaseId === leaseId ? [event.lease.phase] : [])
  }
}

async function rig(options: { paired?: boolean; paused?: boolean } & Partial<HostProtocolOptions> = {}) {
  const { paired = true, paused = false, ...overrides } = options
  const root = temp()
  const store = new Store(':memory:')
  if (paused) store.kvSet(CORE, PAUSED_KEY, true)
  const { a, b } = memoryConnect()
  const [laptop, studio] = [await a.identity(), await b.identity()]
  await a.allow([studio])
  await b.allow([laptop])
  const hosts = new Hosts(store, 'compute')
  if (paired) hosts.add({ name: 'Laptop', endpointId: laptop, peerRole: 'interaction' }, 1)
  const timers: Timer[] = []
  const workerTimers: Timer[] = []
  const timer = (fn: () => void, ms: number): { clear(): void } => {
    const entry = { fn, ms, live: true }
    timers.push(entry)
    return { clear: () => { entry.live = false } }
  }
  const workerTimer = (fn: () => void, ms: number): { clear(): void } => {
    const entry = { fn, ms, live: true }
    workerTimers.push(entry)
    return { clear: () => { entry.live = false } }
  }
  const scheduler = new Scheduler({ timer, now: () => 5000 })
  const model = text(root)
  const plugin = fixtureWorker()
  const workers = new Workers(model.worker, () => [plugin.worker])
  const artifacts = new Artifacts({ dir: join(root, 'compute', 'jobs') })
  const machine = vi.fn(async () => hardware)
  const inventory = new Inventory({ dataDir: root, name: 'Studio', appVersion: '2.0.0', workers, machine })
  const runner = stubRunner()
  const models = { call: vi.fn(async (op: string, args: Record<string, unknown>): Promise<unknown> => ({ op, args })) }
  const log: string[] = []
  const protocol = new HostProtocol({
    connect: b, hosts, scheduler, workers, artifacts, inventory, models, name: 'Studio', appVersion: '2.0.0', store,
    fetch: runner.fetch, timer, workerTimer, now: () => 5000, log: (line) => { log.push(line) }, ...overrides,
  })
  protocol.start()
  cleanups.push(async () => {
    await protocol.close()
    await scheduler.close()
    inventory.close()
    await a.close()
    await b.close()
    store.close()
  })

  const open = async (kind: StreamKind, first: unknown): Promise<{ stream: Duplex; frames: Frames }> => {
    const stream = await a.open(studio, kind)
    stream.on('error', () => {})
    stream.write(encodeFrame(first))
    return { stream, frames: new Frames(stream) }
  }
  const session = async (hello: Partial<Hello> = {}): Promise<Session> => {
    const { stream, frames } = await open('control', { stream: 'control', hello: { protocol: SPEAKS, appVersion: '1.0.0', name: 'Laptop', ...hello } })
    const opened = await frames.next() as { type: string; welcome: Welcome }
    expect(opened.type).toBe('welcome')
    return new Session(stream, frames, opened.welcome)
  }
  /** A lease on a model, once the host says it is ready. */
  const lease = async (control: Session, leaseId: string, modelId = 'llama/test'): Promise<void> => {
    await control.call('prepare', { leaseId, modelId })
    await vi.waitFor(() => { expect(control.leases(leaseId)).toContain('ready') })
  }
  /** One answer, asked the way the bridge asks: the open frame, the body, then the head and the bytes. */
  const infer = async (jobId: string, leaseId: string, body = Buffer.from(JSON.stringify({ model: 'llama/test', stream: true }))) => {
    const { stream, frames } = await open('infer', { stream: 'infer', jobId, leaseId, bodyBytes: body.length })
    stream.end(body)
    return { stream, frames, body, head: await frames.next() as { type: string; status?: number; contentType?: string; failure?: { code: string } } }
  }
  const grace = (): Timer[] => timers.filter((one) => one.ms === RECONNECT_GRACE_MS)
  return { root, store, a, b, laptop, studio, hosts, timers, workerTimers, scheduler, model, plugin, workers, artifacts, machine, inventory, runner, models, log, protocol, open, session, lease, infer, grace }
}

async function rest(frames: Frames): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of frames.bytes()) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/** Read a job stream until `until` is satisfied or the stream ends. */
async function hear(frames: Frames, until: (event: JobEvent) => boolean): Promise<JobEvent[]> {
  const heard: JobEvent[] = []
  for (;;) {
    const event = await frames.next() as JobEvent | undefined
    if (!event) return heard
    heard.push(event)
    if (until(event)) return heard
  }
}

const rising = (events: JobEvent[]): boolean => events.every((event, at) => at === 0 || event.seq > events[at - 1]!.seq)
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

test('a controller that speaks no common version is refused as incompatible-version, and gets no session', async () => {
  const r = await rig()
  const { frames } = await r.open('control', { stream: 'control', hello: { protocol: { min: 2, max: 3 }, appVersion: '9.0.0', name: 'Laptop' } })
  expect(await frames.next()).toEqual({ type: 'refused', failure: { code: 'incompatible-version', message: expect.any(String) } })
  expect(await frames.next()).toBeUndefined()

  // Refused is not a session: every other stream is still closed unanswered.
  const job = await r.open('job', { stream: 'job', attach: 'job-1' })
  await expect(job.frames.next()).rejects.toMatchObject({ code: 'interrupted' })
  expect(r.grace()).toHaveLength(0)
  expect(r.log).toEqual(['compute: closed a control stream: incompatible version', 'compute: closed a job stream: no control session'])
})

test('a welcome carries the inventory, the queue and where every resumed job stands', async () => {
  const r = await rig()
  const control = await r.session({ resume: ['never-seen'] })
  expect(control.welcome).toMatchObject({ protocol: 1, appVersion: '2.0.0', name: 'Studio', queue: { waiting: [], paused: false } })
  expect(control.welcome.inventory.models.map((model) => model.id)).toEqual(['llama/test', 'llama/other'])
  expect(control.welcome.inventory.capabilities).toEqual([{ cap: 'demo.render', summary: 'Render a fixture file.', weight: 'heavy', ready: true }])
  // A job this host does not know was lost with a restart: it is reported, never run.
  expect(control.welcome.jobs).toEqual([expect.objectContaining({ id: 'never-seen', state: 'interrupted', failure: expect.objectContaining({ code: 'interrupted' }) })])
  expect(r.plugin.state.runs).toBe(0)
  expect(r.hosts.list()[0]).toMatchObject({ name: 'Laptop', appVersion: '1.0.0', lastSeenAt: 5000 })
  expect(await control.call('ping')).toEqual({})
  expect(await control.call('queue.get')).toEqual({ waiting: [], paused: false })
  expect(await control.call<{ revision: number }>('inventory.get')).toMatchObject({ name: 'Studio', revision: control.welcome.inventory.revision })
})

test('only the paired controller is heard, and only a stream that opens the way its kind does', async () => {
  const stranger = await rig({ paired: false })
  const refused = await stranger.open('control', { stream: 'control', hello: { protocol: SPEAKS, appVersion: '1.0.0', name: 'Laptop' } })
  await expect(refused.frames.next()).rejects.toMatchObject({ code: 'interrupted' })
  expect(stranger.log).toEqual(['compute: closed a control stream: not the paired controller'])

  const r = await rig()
  await r.session()
  // A first frame for another kind, one that is no open frame, and one too long to be a frame.
  const wrong = await r.open('artifact', { stream: 'job', attach: 'job-1' })
  await expect(wrong.frames.next()).rejects.toMatchObject({ code: 'interrupted' })
  const unknown = await r.open('job', { stream: 'job', run: 'rm -rf' })
  await expect(unknown.frames.next()).rejects.toMatchObject({ code: 'interrupted' })
  const long = await r.a.open(r.studio, 'job')
  long.on('error', () => {})
  long.write(Buffer.alloc(1024 * 1024 + 1, 0x61))
  await expect(new Frames(long).next()).rejects.toMatchObject({ code: 'interrupted' })
  expect(r.log).toEqual([
    'compute: closed a artifact stream: unexpected first frame',
    'compute: closed a job stream: unexpected first frame',
    'compute: closed a job stream: the stream could not be read',
  ])
})

test('a second control session from the controller replaces the first, and arms no grace', async () => {
  const r = await rig()
  const first = await r.session()
  const second = await r.session()
  await vi.waitFor(() => { expect(first.ended).toBe(true) })
  expect(first.stream.destroyed).toBe(true)
  expect(r.grace().filter((one) => one.live)).toHaveLength(0)
  r.protocol.pause(true)
  await vi.waitFor(() => { expect(second.events).toContainEqual({ event: 'queue', queue: { waiting: [], paused: true } }) })
  expect(first.events).toEqual([])
})

test('an infer stream returns the runner\'s answer byte for byte', async () => {
  const r = await rig()
  const control = await r.session()
  await r.lease(control, 'lease-1')
  const probes = r.machine.mock.calls.length

  const answer = await r.infer('chat-1', 'lease-1')
  expect(answer.head).toEqual({ type: 'head', status: 200, contentType: 'text/event-stream; charset=utf-8' })
  expect((await rest(answer.frames)).equals(RUNNER_SSE)).toBe(true)

  // The runner was asked once, at its own loopback address, with its own key and the body as sent.
  expect(r.runner.calls).toHaveLength(1)
  expect(r.runner.calls[0]).toMatchObject({ url: 'http://127.0.0.1:1/v1/chat/completions', authorization: 'Bearer secret' })
  expect(r.runner.calls[0]!.body.equals(answer.body)).toBe(true)
  await vi.waitFor(async () => { expect(await control.call('job.status', { jobId: 'chat-1' })).toMatchObject({ kind: 'chat', state: 'succeeded', label: 'llama/test' }) })
  // Hardware is looked at when a job is admitted, and at no other time while the host sits there.
  await vi.waitFor(() => { expect(r.machine.mock.calls.length).toBe(probes + 1) })
  expect(r.runner.state.aborted).toBe(0)
})

test('an engine\'s own refusal is forwarded as its status, and a request with no lease is refused', async () => {
  const r = await rig()
  const control = await r.session()
  await r.lease(control, 'lease-1')
  r.runner.state.respond = () => new Response('{"error":"context too long"}', { status: 400, headers: { 'content-type': 'application/json' } })
  const answer = await r.infer('chat-1', 'lease-1')
  expect(answer.head).toEqual({ type: 'head', status: 400, contentType: 'application/json' })
  expect((await rest(answer.frames)).toString()).toBe('{"error":"context too long"}')

  const unleased = await r.infer('chat-2', 'lease-nobody-took')
  expect(unleased.head).toMatchObject({ type: 'refused', failure: { code: 'refused' } })
  expect(r.runner.calls).toHaveLength(1)
})

test('closing an infer stream aborts the runner request', async () => {
  const r = await rig()
  const control = await r.session()
  await r.lease(control, 'lease-1')
  r.runner.state.respond = hanging

  const answer = await r.infer('chat-1', 'lease-1')
  expect(answer.head).toMatchObject({ type: 'head', status: 200 })
  const bytes = answer.frames.bytes()
  expect(Buffer.from((await bytes.next()).value!).toString()).toContain('One')
  expect(r.runner.state.aborted).toBe(0)

  answer.stream.destroy()
  await vi.waitFor(() => { expect(r.runner.state.aborted).toBe(1) })
  await vi.waitFor(async () => { expect(await control.call('job.status', { jobId: 'chat-1' })).toMatchObject({ state: 'cancelled' }) })
  expect(r.runner.calls).toHaveLength(1)
})

test('a job survives its stream closing, and a later attach hears the rest in rising seq', async () => {
  const r = await rig()
  const control = await r.session()
  r.plugin.state.hold = true
  const probes = r.machine.mock.calls.length

  const first = await r.open('job', { stream: 'job', submit: { jobId: 'job-1', cap: 'demo.render', arguments: { scale: 2 } } })
  const before = await hear(first.frames, (event) => event.type === 'progress')
  expect(before.map((event) => event.type === 'state' ? event.job.state : event.type)).toEqual(['queued', 'preparing', 'running', 'progress'])
  expect(rising(before)).toBe(true)
  first.stream.destroy()
  await vi.waitFor(() => { expect(first.stream.closed).toBe(true) })

  // Closing the stream is not a cancel: the job belongs to the session.
  expect(await control.call('job.status', { jobId: 'job-1' })).toMatchObject({ state: 'running' })
  expect(r.plugin.state.signals[0]!.aborted).toBe(false)
  await vi.waitFor(() => { expect(r.machine.mock.calls.length).toBe(probes + 1) })

  const later = await r.open('job', { stream: 'job', attach: 'job-1', after: before.at(-1)!.seq })
  r.plugin.state.release()
  const after = await hear(later.frames, () => false)
  expect(after.map((event) => event.type)).toEqual(['output', 'done'])
  expect(rising([...before, ...after])).toBe(true)
  expect(after[0]).toMatchObject({ output: { type: 'text', text: 'Rendered.' } })
  const done = after[1] as Extract<JobEvent, { type: 'done' }>
  expect(done.job).toMatchObject({ id: 'job-1', state: 'succeeded', artifacts: [{ jobId: 'job-1', name: 'picture.txt', bytes: 11 }] })
  expect(r.plugin.state.runs).toBe(1)

  // A submit of the same id is the same job: it is replayed from the start and nothing runs again.
  const again = await r.open('job', { stream: 'job', submit: { jobId: 'job-1', cap: 'demo.render', arguments: { scale: 9 } } })
  const replay = await hear(again.frames, () => false)
  expect(replay.at(-1)).toEqual(done)
  expect(rising(replay)).toBe(true)
  expect(r.plugin.state.runs).toBe(1)

  // No frame said where anything is on this computer.
  const said = JSON.stringify([control.welcome, control.events, before, after, replay])
  expect(said).not.toContain(r.root)
  expect(said).not.toContain(join('compute', 'jobs'))

  // The output is fetched by id, and its stream ends after the last byte.
  const artifact = done.job.artifacts![0]!
  const fetched = await r.open('artifact', { stream: 'artifact', get: artifact.id })
  expect(await fetched.frames.next()).toEqual({ type: 'head', artifact, offset: 0 })
  expect((await rest(fetched.frames)).toString()).toBe('rendered x2')
  const partial = await r.open('artifact', { stream: 'artifact', get: artifact.id, offset: 9 })
  expect(await partial.frames.next()).toEqual({ type: 'head', artifact, offset: 9 })
  expect((await rest(partial.frames)).toString()).toBe('x2')
  expect(await control.call('artifact.ack', { artifactIds: [artifact.id] })).toEqual({})
  const gone = await r.open('artifact', { stream: 'artifact', get: artifact.id })
  expect(await gone.frames.next()).toMatchObject({ type: 'refused', failure: { code: 'not-found' } })
})

test('an attach for a job this host does not know closes the stream, and job.status answers not-found', async () => {
  const r = await rig()
  const control = await r.session()
  const attached = await r.open('job', { stream: 'job', attach: 'never-submitted' })
  expect(await attached.frames.next()).toBeUndefined()
  expect(await control.ask('job.status', { jobId: 'never-submitted' })).toMatchObject({ ok: false, failure: { code: 'not-found' } })
  expect(await control.ask('job.cancel', { jobId: 'never-submitted' })).toMatchObject({ ok: false, failure: { code: 'not-found' } })
})

test('a cancel frame on a job stream cancels a queued job at once and a running one in its worker', async () => {
  const r = await rig()
  await r.session()
  r.plugin.state.hold = true
  const running = await r.open('job', { stream: 'job', submit: { jobId: 'job-1', cap: 'demo.render' } })
  await hear(running.frames, (event) => event.type === 'progress')
  const queued = await r.open('job', { stream: 'job', submit: { jobId: 'job-2', cap: 'demo.render' } })
  expect((await hear(queued.frames, () => true))[0]).toMatchObject({ type: 'state', job: { state: 'queued' } })

  queued.stream.write(encodeFrame({ type: 'cancel' }))
  expect((await hear(queued.frames, () => false)).at(-1)).toMatchObject({ type: 'done', job: { id: 'job-2', state: 'cancelled' } })
  expect(r.plugin.state.runs).toBe(1)

  running.stream.write(encodeFrame({ type: 'cancel' }))
  const rest = await hear(running.frames, () => false)
  expect(rest.map((event) => event.type === 'state' || event.type === 'done' ? event.job.state : event.type)).toEqual(['cancelling', 'cancelled'])
  expect(r.plugin.state.signals[0]!.aborted).toBe(true)
  expect(r.plugin.state.runs).toBe(1)
})

test('losing the control session arms one 15 second timer, and its expiry interrupts unfinished jobs exactly once', async () => {
  const r = await rig()
  const control = await r.session()
  await r.lease(control, 'lease-1')
  r.plugin.state.hold = true
  const job = await r.open('job', { stream: 'job', submit: { jobId: 'job-1', cap: 'demo.render' } })
  await hear(job.frames, (event) => event.type === 'progress')
  const waiting = await r.open('job', { stream: 'job', submit: { jobId: 'job-2', cap: 'demo.render' } })
  await hear(waiting.frames, () => true)
  const cancelAll = vi.spyOn(r.scheduler, 'cancelAll')
  expect(r.grace()).toHaveLength(0)

  control.stream.destroy()
  await vi.waitFor(() => { expect(r.grace()).toHaveLength(1) })
  expect(r.grace()[0]).toMatchObject({ ms: 15_000, live: true })
  // The job carries on through the grace, and nothing new is taken while nobody is in session.
  expect(r.scheduler.status('job-1')).toMatchObject({ state: 'running' })
  expect(r.scheduler.status('job-2')).toMatchObject({ state: 'queued' })
  const refused = await r.open('job', { stream: 'job', submit: { jobId: 'job-3', cap: 'demo.render' } })
  await expect(refused.frames.next()).rejects.toMatchObject({ code: 'interrupted' })
  expect(cancelAll).not.toHaveBeenCalled()

  r.grace()[0]!.fn()
  await vi.waitFor(() => { expect(r.scheduler.status('job-1')).toMatchObject({ state: 'interrupted', failure: { code: 'interrupted' } }) })
  expect(r.scheduler.status('job-2')).toMatchObject({ state: 'interrupted' })
  expect(r.scheduler.status('job-3')).toBeUndefined()
  expect(r.plugin.state.signals[0]!.aborted).toBe(true)
  expect(cancelAll).toHaveBeenCalledTimes(1)
  expect(cancelAll).toHaveBeenCalledWith('interrupted', expect.objectContaining({ code: 'interrupted' }))
  expect(r.grace()).toHaveLength(1)
  await vi.waitFor(() => { expect(job.stream.destroyed).toBe(true) })

  // Coming back after the grace is told the outcome. Nothing is run again, and no second timer was armed.
  const back = await r.session({ resume: ['job-1', 'job-2'] })
  expect(back.welcome.jobs.map((one) => one.state)).toEqual(['interrupted', 'interrupted'])
  expect(r.plugin.state.runs).toBe(1)
  expect(cancelAll).toHaveBeenCalledTimes(1)
  expect(r.grace()).toHaveLength(1)

  // The lease went with the grace, and an answer naming it loads the same model again in place.
  const loads = r.model.prepare.mock.calls.length
  const answer = await r.infer('chat-1', 'lease-1')
  expect(answer.head).toMatchObject({ type: 'head', status: 200 })
  expect((await rest(answer.frames)).equals(RUNNER_SSE)).toBe(true)
  expect(r.model.prepare.mock.calls.length).toBe(loads + 1)
})

test('a reconnect within the grace clears the timer and resumes with the job ids it already has', async () => {
  const r = await rig()
  const control = await r.session()
  r.plugin.state.hold = true
  const job = await r.open('job', { stream: 'job', submit: { jobId: 'job-1', cap: 'demo.render', arguments: { scale: 3 } } })
  const before = await hear(job.frames, (event) => event.type === 'progress')
  const cancelAll = vi.spyOn(r.scheduler, 'cancelAll')

  control.stream.destroy()
  job.stream.destroy()
  await vi.waitFor(() => { expect(r.grace().filter((one) => one.live)).toHaveLength(1) })

  const back = await r.session({ resume: ['job-1'] })
  expect(back.welcome.jobs).toEqual([expect.objectContaining({ id: 'job-1', state: 'running' })])
  expect(r.grace()).toHaveLength(1)
  expect(r.grace()[0]!.live).toBe(false)

  const attached = await r.open('job', { stream: 'job', attach: 'job-1', after: before.at(-1)!.seq })
  r.plugin.state.release()
  const after = await hear(attached.frames, () => false)
  expect(after.at(-1)).toMatchObject({ type: 'done', job: { state: 'succeeded' } })
  expect(rising([...before, ...after])).toBe(true)
  expect(r.plugin.state.runs).toBe(1)
  expect(cancelAll).not.toHaveBeenCalled()
  await vi.waitFor(() => { expect(back.events).toContainEqual({ event: 'job', job: expect.objectContaining({ id: 'job-1', state: 'succeeded' }) }) })
})

test('revoke replaces the allowlist, cancels every job and closes every stream at once', async () => {
  const r = await rig()
  const control = await r.session()
  await r.lease(control, 'lease-1')
  r.plugin.state.hold = true
  const job = await r.open('job', { stream: 'job', submit: { jobId: 'job-1', cap: 'demo.render' } })
  await hear(job.frames, (event) => event.type === 'progress')
  const waiting = await r.open('job', { stream: 'job', submit: { jobId: 'job-2', cap: 'demo.render' } })
  await hear(waiting.frames, () => true)
  const lines: string[] = []
  r.protocol.onStatus((line) => { lines.push(line) })
  const allow = vi.spyOn(r.b, 'allow')

  const revoking = r.protocol.revoke()
  // Before anything is awaited: the streams are closed, the queued job is gone and the running one is told to stop.
  expect([control.stream.destroyed, job.stream.destroyed, waiting.stream.destroyed]).toEqual([true, true, true])
  expect(r.scheduler.status('job-2')).toMatchObject({ state: 'cancelled', failure: { code: 'unpaired' } })
  expect(r.plugin.state.signals[0]!.aborted).toBe(true)
  expect(r.hosts.list()).toEqual([])
  expect(allow).toHaveBeenCalledWith([])
  await revoking

  expect(r.scheduler.status('job-1')).toMatchObject({ state: 'cancelled', failure: { code: 'unpaired' } })
  expect(r.plugin.state.runs).toBe(1)
  await vi.waitFor(() => { expect(control.ended).toBe(true) })
  expect(control.events.at(-1)).toEqual({ event: 'bye', reason: 'unpaired' })
  expect(control.leases('lease-1').at(-1)).toBe('released')
  expect(lines.at(-1)).toBe('Not paired')
  expect(r.grace()).toHaveLength(0)
  // The transport turns the old controller away, and so would the host if a stream arrived.
  await expect(r.a.open(r.studio, 'control')).rejects.toMatchObject({ code: 'unpaired' })
})

test('an input lands in its job\'s own directory, a wrong hash leaves nothing, and no path is ever said', async () => {
  const r = await rig()
  await r.session()
  const bytes = Buffer.from('a staged input')
  const put = { jobId: 'job-9', name: join('..', '..', 'evil.txt'), mime: 'text/plain', bytes: bytes.length, sha256: sha256(bytes) }

  const stored = await r.open('artifact', { stream: 'artifact', put })
  stored.stream.end(bytes)
  const answer = await stored.frames.next() as { type: string; artifact: ArtifactRef }
  expect(answer).toMatchObject({ type: 'stored', artifact: { jobId: 'job-9', name: '....evil.txt', bytes: bytes.length, sha256: put.sha256 } })
  expect(JSON.stringify(answer)).not.toContain(r.root)
  const inputs = join(r.root, 'compute', 'jobs', 'job-9', 'inputs')
  expect(readdirSync(inputs)).toEqual([answer.artifact.id])

  const wrong = await r.open('artifact', { stream: 'artifact', put: { ...put, jobId: 'job-10', sha256: sha256(Buffer.from('something else')) } })
  wrong.stream.end(bytes)
  expect(await wrong.frames.next()).toMatchObject({ type: 'refused', failure: { code: 'refused' } })
  expect(existsSync(join(r.root, 'compute', 'jobs', 'job-10'))).toBe(false)

  // Turned away before the file was read: the reason still arrives, and the sender is not left writing.
  const invalid = await r.open('artifact', { stream: 'artifact', put: { ...put, jobId: join('..', 'escape') } })
  invalid.stream.end(Buffer.alloc(300 * 1024, 1))
  expect(await invalid.frames.next()).toMatchObject({ type: 'refused', failure: { code: 'refused' } })
  expect(existsSync(join(r.root, 'compute', 'escape'))).toBe(false)
})

test('only declared operations and the listed requests are served', async () => {
  const r = await rig()
  const control = await r.session()

  // A capability no installed worker declared is not a job: it ends at once and was never queued.
  const job = await r.open('job', { stream: 'job', submit: { jobId: 'job-1', cap: 'shell.exec', arguments: { command: 'whoami' } } })
  const said = await hear(job.frames, () => false)
  expect(said).toEqual([expect.objectContaining({ type: 'done', job: expect.objectContaining({ id: 'job-1', state: 'failed', failure: expect.objectContaining({ code: 'setup-required' }) }) })])
  expect(await control.ask('job.status', { jobId: 'job-1' })).toMatchObject({ ok: false, failure: { code: 'not-found' } })
  expect(r.plugin.state.runs).toBe(0)

  // An input that belongs to another job is not handed to this one.
  const bytes = Buffer.from('somebody else\'s input')
  const other = await r.open('artifact', { stream: 'artifact', put: { jobId: 'job-other', name: 'in.txt', mime: 'text/plain', bytes: bytes.length, sha256: sha256(bytes) } })
  other.stream.end(bytes)
  const input = (await other.frames.next() as { artifact: ArtifactRef }).artifact
  const borrowed = await r.open('job', { stream: 'job', submit: { jobId: 'job-2', cap: 'demo.render', arguments: { source: { $artifact: input.id } } } })
  expect((await hear(borrowed.frames, () => false)).at(-1)).toMatchObject({ type: 'done', job: { state: 'failed', failure: { code: 'refused' } } })
  expect(r.plugin.state.runs).toBe(0)

  for (const method of ['plugin.call', 'tools/call', 'fs.read']) {
    expect(await control.ask(method, { name: 'anything' })).toMatchObject({ ok: false, failure: { code: 'refused' } })
  }
  // The picker's own operations are forwarded by name; importing a path and storing a token are not among them.
  expect(await control.call('models', { op: 'overview', args: { q: 1 } })).toEqual({ op: 'overview', args: { q: 1 } })
  for (const op of ['import', 'import-preview', 'token']) {
    expect(await control.ask('models', { op, args: { path: '/etc/passwd' } })).toMatchObject({ ok: false, failure: { code: 'refused' } })
  }
  expect(r.models.call).toHaveBeenCalledTimes(1)

  // A model that arrives through the picker reaches the controller as a new inventory, unasked.
  r.models.call.mockImplementationOnce(async () => { installed(r.root, 'llama/new'); return { ok: true } })
  await control.call('models', { op: 'install', args: {} })
  await vi.waitFor(() => {
    expect(control.events.some((event) => event.event === 'inventory' && event.inventory.models.some((model) => model.id === 'llama/new'))).toBe(true)
  })
  r.models.call.mockRejectedValueOnce(new Error('There is not enough room in /Users/somebody/models/big.gguf for that.\nat stack'))
  const failed = await control.ask('models', { op: 'install', args: {} }) as Extract<ControlResponse, { ok: false }>
  expect(failed.failure).toEqual({ code: 'refused', message: 'There is not enough room in a file on that computer for that.' })
})

test('leases on one model share it, another model releases them, and an idle stop is reacquired in place', async () => {
  const r = await rig()
  const control = await r.session()
  const probes = r.machine.mock.calls.length
  expect(await control.call('prepare', { leaseId: 'lease-1', modelId: 'llama/test' })).toMatchObject({ leaseId: 'lease-1', modelId: 'llama/test', phase: 'loading' })
  await vi.waitFor(() => { expect(control.leases('lease-1')).toEqual(['ready']) })
  // Preparation is one of the three times hardware is looked at.
  await vi.waitFor(() => { expect(r.machine.mock.calls.length).toBe(probes + 1) })
  expect(r.model.prepare).toHaveBeenCalledTimes(1)

  // A second lease on the same model is ready at once and loads nothing; releasing it leaves the first.
  expect(await control.call('prepare', { leaseId: 'lease-2', modelId: 'llama/test' })).toMatchObject({ phase: 'ready' })
  expect(await control.call('release', { leaseId: 'lease-2' })).toEqual({})
  expect(await control.call('release', { leaseId: 'lease-nobody-took' })).toEqual({})
  expect(r.model.prepare).toHaveBeenCalledTimes(1)
  expect((await r.infer('chat-1', 'lease-1')).head).toMatchObject({ type: 'head' })

  expect(await control.call('prepare', { leaseId: 'lease-3', modelId: 'llama/absent' })).toMatchObject({ phase: 'setup-required', failure: { code: 'setup-required' } })
  expect(control.leases('lease-1')).toEqual(['ready'])

  await control.call('prepare', { leaseId: 'lease-4', modelId: 'llama/other' })
  await vi.waitFor(() => { expect(control.leases('lease-4')).toContain('ready') })
  expect(control.leases('lease-1')).toEqual(['ready', 'released'])
  expect(r.model.prepare).toHaveBeenLastCalledWith('llama/other', expect.anything())

  // Ten idle minutes: the worker is stopped, the lease is released, and the next answer loads the same model again.
  const idle = r.timers.filter((one) => one.ms === IDLE_STOP_MS && one.live)
  expect(idle).toHaveLength(1)
  idle[0]!.fn()
  await vi.waitFor(() => { expect(control.leases('lease-4').at(-1)).toBe('released') })
  expect(r.workers.text.loaded()).toBe(false)
  const loads = r.model.prepare.mock.calls.length
  const answer = await r.infer('chat-2', 'lease-4')
  expect(answer.head).toMatchObject({ type: 'head', status: 200 })
  expect((await rest(answer.frames)).equals(RUNNER_SSE)).toBe(true)
  expect(r.model.prepare.mock.calls.length).toBe(loads + 1)
  expect(r.model.prepare).toHaveBeenLastCalledWith('llama/other', expect.anything())
  expect(control.leases('lease-4').at(-1)).toBe('ready')
})

test('a pause is kept, shown in the queue and the tray line, and answered as busy', async () => {
  const r = await rig()
  const control = await r.session()
  await r.lease(control, 'lease-1')
  const lines: [string, boolean][] = []
  r.protocol.onStatus((line, paused) => { lines.push([line, paused]) })

  r.protocol.pause(true)
  expect(r.store.kvGet(CORE, PAUSED_KEY)).toBe(true)
  expect(lines).toEqual([['Paired with Laptop · Paused', true]])
  await vi.waitFor(() => { expect(control.events).toContainEqual({ event: 'queue', queue: { waiting: [], paused: true } }) })
  expect(await control.call('prepare', { leaseId: 'lease-2', modelId: 'llama/test' })).toMatchObject({ phase: 'busy', failure: { code: 'busy' } })
  expect((await r.infer('chat-1', 'lease-1')).head).toMatchObject({ type: 'refused', failure: { code: 'busy' } })
  expect(r.runner.calls).toHaveLength(0)

  // A job still queues while paused, and starts when the pause ends.
  const job = await r.open('job', { stream: 'job', submit: { jobId: 'job-1', cap: 'demo.render', arguments: { scale: 1 } } })
  expect((await hear(job.frames, () => true))[0]).toMatchObject({ type: 'state', job: { state: 'queued' } })
  expect(r.plugin.state.runs).toBe(0)
  r.protocol.pause(false)
  expect(r.store.kvGet(CORE, PAUSED_KEY)).toBe(false)
  expect((await hear(job.frames, () => false)).at(-1)).toMatchObject({ type: 'done', job: { state: 'succeeded' } })
  expect(lines.map(([line]) => line)).toEqual(['Paired with Laptop · Paused', 'Paired with Laptop · Working', 'Paired with Laptop · Idle'])

  // A host that was paused when it stopped comes back paused.
  const restarted = await rig({ paused: true })
  expect((await restarted.session()).welcome.queue.paused).toBe(true)
})

test('close says bye, stops listening and arms nothing', async () => {
  const r = await rig()
  const control = await r.session()
  await r.protocol.close('role-switch')
  await vi.waitFor(() => { expect(control.ended).toBe(true) })
  expect(control.events.at(-1)).toEqual({ event: 'bye', reason: 'role-switch' })
  expect(r.grace()).toHaveLength(0)
  const late = await r.open('control', { stream: 'control', hello: { protocol: SPEAKS, appVersion: '1.0.0', name: 'Laptop' } })
  await expect(late.frames.next()).rejects.toMatchObject({ code: 'interrupted' })
})

test('failures preserve URLs while removing POSIX and Windows host paths', async () => {
  const r = await rig()
  const control = await r.session()
  for (const path of ['/home/sam/models/weights.bin', 'C:\\Users\\sam\\weights.bin']) {
    r.models.call.mockRejectedValueOnce(new ComputeError('worker-failure', `Cannot read ${path}: see https://example.com/help.\nat private stack`))
    expect(await control.ask('models', { op: 'install' })).toEqual(expect.objectContaining({
      ok: false, failure: { code: 'worker-failure', message: 'Cannot read a file on that computer: see https://example.com/help.' },
    }))
  }
})

test('every stream has a twenty-second deadline for a complete first frame, cleared once it arrives', async () => {
  const r = await rig()
  const control = await r.session()
  expect(r.timers.filter((one) => one.ms === HANDSHAKE_MS && one.live)).toEqual([])
  for (const kind of ['control', 'job', 'infer', 'artifact'] as const) {
    const stream = await r.a.open(r.studio, kind)
    stream.on('error', () => {})
    // A partial frame cannot keep the connection forever either.
    if (kind === 'job') stream.write('{"stream":"job"')
    const ended = new Frames(stream).next().catch((error: unknown) => error)
    const deadline = r.timers.filter((one) => one.ms === HANDSHAKE_MS && one.live)
    expect(deadline).toHaveLength(1)
    deadline[0]!.fn()
    expect(await ended).toMatchObject({ code: 'interrupted' })
    await vi.waitFor(() => { expect(deadline[0]!.live).toBe(false) })
  }
  expect(await control.call('ping')).toEqual({})
  expect(r.grace()).toEqual([])
})

test('a plugin operation that ignores cancellation is stopped after fifteen seconds before another job starts', async () => {
  const r = await rig()
  const control = await r.session()
  let signal: AbortSignal | undefined
  let finishRun!: (result: { files: string[] }) => void
  const run = vi.spyOn(r.plugin.worker, 'run').mockImplementationOnce(async (_cap, _args, io) => {
    signal = io.signal
    return await new Promise<{ files: string[] }>((resolve) => { finishRun = resolve })
  }).mockResolvedValue({ files: [] })
  let releaseStop!: () => void
  const stop = vi.spyOn(r.plugin.worker, 'stop').mockImplementationOnce(() => new Promise<void>((resolve) => { releaseStop = resolve }))
  const active = await r.open('job', { stream: 'job', submit: { jobId: 'job-1', cap: 'demo.render' } })
  await vi.waitFor(() => { expect(run).toHaveBeenCalledTimes(1) })
  const queued = await r.open('job', { stream: 'job', submit: { jobId: 'job-2', cap: 'demo.render' } })
  await vi.waitFor(() => { expect(r.scheduler.queue().waiting).toHaveLength(1) })

  expect(await control.call('job.cancel', { jobId: 'job-1' })).toMatchObject({ state: 'cancelling' })
  expect(await control.call('job.cancel', { jobId: 'job-1' })).toMatchObject({ state: 'cancelling' })
  expect(signal!.aborted).toBe(true)
  expect(stop).not.toHaveBeenCalled()
  expect(run).toHaveBeenCalledTimes(1)
  expect(r.workerTimers).toHaveLength(1)
  expect(r.workerTimers[0]).toMatchObject({ ms: CANCEL_STOP_MS, live: true })
  r.workerTimers[0]!.fn()
  r.workerTimers[0]!.fn()
  await vi.waitFor(() => { expect(stop).toHaveBeenCalledTimes(1) })
  expect(stop).toHaveBeenCalledWith({ force: true })
  finishRun({ files: [] })
  await control.call('ping')
  expect(r.scheduler.status('job-1')).toMatchObject({ state: 'cancelling' })
  expect(run).toHaveBeenCalledTimes(1)
  releaseStop()
  expect((await hear(active.frames, () => false)).at(-1)).toMatchObject({ type: 'done', job: { state: 'cancelled' } })
  const next = (await hear(queued.frames, () => false)).at(-1) as Extract<JobEvent, { type: 'done' }>
  expect(next.job.failure).toBeUndefined()
  expect(next).toMatchObject({ type: 'done', job: { state: 'succeeded' } })
  expect(run).toHaveBeenCalledTimes(2)
  expect(r.workerTimers[0]!.live).toBe(false)
  r.workerTimers[0]!.fn()
  expect(stop).toHaveBeenCalledTimes(1)
})

test('a worker that returns after cancellation clears its stop deadline', async () => {
  const r = await rig()
  const control = await r.session()
  r.plugin.state.hold = true
  const stop = vi.spyOn(r.plugin.worker, 'stop')
  const active = await r.open('job', { stream: 'job', submit: { jobId: 'job-1', cap: 'demo.render' } })
  await hear(active.frames, (event) => event.type === 'progress')
  await control.call('job.cancel', { jobId: 'job-1' })
  expect((await hear(active.frames, () => false)).at(-1)).toMatchObject({ type: 'done', job: { state: 'cancelled' } })
  expect(r.workerTimers).toHaveLength(1)
  expect(r.workerTimers[0]!.live).toBe(false)
  r.workerTimers[0]!.fn()
  expect(stop).not.toHaveBeenCalled()
})
