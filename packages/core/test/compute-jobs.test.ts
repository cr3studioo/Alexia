// SPDX-License-Identifier: AGPL-3.0-only
import type { Duplex } from 'node:stream'
import { afterEach, expect, test, vi } from 'vitest'
import { memoryConnect, type Connect } from '../src/compute/connect.js'
import { Controller, Frames } from '../src/compute/controller.js'
import { Hosts } from '../src/compute/hosts.js'
import { JOBS_KEY, RemoteJobs } from '../src/compute/jobs.js'
import { encodeFrame, type ControlEvent, type ControlRequest, type Hello, type JobEvent, type JobSubmit, type StreamKind, type StreamOpen } from '../src/compute/protocol.js'
import { ComputeError, type HostInventory, type JobSnapshot, type QueueSnapshot } from '../src/compute/types.js'
import { CORE } from '../src/secrets.js'
import { Store } from '../src/store.js'

const inventory: HostInventory = {
  name: 'Studio', appVersion: '2.0.0', revision: 1, models: [], capabilities: [], setup: [],
  machine: { platform: 'win32', arch: 'x64', chip: 'Test', appleSilicon: false, ramBytes: 64, freeDiskBytes: 64, budgetBytes: 32 },
}
const job = (id: string, state: JobSnapshot['state'], more: Partial<JobSnapshot> = {}): JobSnapshot => ({ id, kind: 'operation', weight: 'heavy', state, label: 'image.render', createdAt: 1, ...more })
const submit: JobSubmit = { jobId: 'job-1', cap: 'image.render', arguments: { prompt: 'a lighthouse' } }

interface Opened { kind: StreamKind; open: StreamOpen; stream: Duplex; frames: Frames }

/** A compute host that says exactly what a test tells it to, over the in-memory transport. */
class Script {
  readonly opened: Opened[] = []
  readonly requests: ControlRequest[] = []
  control?: Duplex
  queue: QueueSnapshot = { waiting: [], paused: false }
  /** Where each resumed job is said to stand. A job absent from here is one the host has lost. */
  readonly known = new Map<string, JobSnapshot>()
  answer: (request: ControlRequest) => unknown = (request) => {
    if (request.method !== 'job.status' && request.method !== 'job.cancel') return {}
    const found = this.known.get(request.params.jobId)
    if (!found) throw new ComputeError('not-found', 'No such job.')
    return found
  }

  async accept(stream: Duplex, kind: StreamKind): Promise<void> {
    const frames = new Frames(stream)
    const open = await frames.next() as StreamOpen
    this.opened.push({ kind, open, stream, frames })
    if (open.stream !== 'control') return
    const jobs = (open.hello.resume ?? []).map((id) => this.known.get(id) ?? job(id, 'interrupted', { failure: { code: 'interrupted', message: 'The host restarted.' } }))
    stream.write(encodeFrame({ type: 'welcome', welcome: { protocol: 1, appVersion: '2.0.0', name: 'Studio', inventory, queue: this.queue, jobs } }))
    this.control = stream
    for (;;) {
      const request = await frames.next().catch(() => undefined) as ControlRequest | undefined
      if (!request) return
      this.requests.push(request)
      try { stream.write(encodeFrame({ id: request.id, ok: true, result: this.answer(request) })) }
      catch (error) { stream.write(encodeFrame({ id: request.id, ok: false, failure: (error as ComputeError).failure() })) }
    }
  }

  say(event: ControlEvent): void { this.control!.write(encodeFrame(event)) }
  hellos(): Hello[] { return this.opened.flatMap((one) => one.open.stream === 'control' ? [one.open.hello] : []) }
  jobs(): Opened[] { return this.opened.filter((one) => one.kind === 'job') }
  submits(): Opened[] { return this.jobs().filter((one) => 'submit' in one.open) }
  attaches(): StreamOpen[] { return this.jobs().flatMap((one) => 'attach' in one.open ? [one.open] : []) }
  /** The whole connection goes: the session and every stream on it. */
  cut(): void { for (const one of this.opened) one.stream.destroy() }
}

const closing: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close() })
const database = (): Store => {
  const store = new Store(':memory:')
  closing.push(() => store.close())
  return store
}

/** The transport, with a switch for the network going away: nothing opens and the host reads as offline. */
function flaky(connect: Connect): Connect & { down: boolean } {
  return {
    down: false,
    identity: () => connect.identity(),
    allow: (ids) => connect.allow(ids),
    async open(endpointId, kind, signal) {
      if (this.down) throw new ComputeError('offline', 'The compute connection is offline.')
      return connect.open(endpointId, kind, signal)
    },
    accept: (handler) => { connect.accept(handler) },
    state(endpointId) { return this.down ? 'offline' : connect.state(endpointId) },
    onState: (listener) => connect.onState(listener),
    pairOpen: (me, signal) => connect.pairOpen(me, signal),
    pairJoin: (code, me, signal) => connect.pairJoin(code, me, signal),
    close: () => connect.close(),
  }
}

async function rig(store = database()) {
  const { a: real, b } = memoryConnect()
  const a = flaky(real)
  const [mine, theirs] = [await a.identity(), await b.identity()]
  await a.allow([theirs])
  await b.allow([mine])
  const hosts = new Hosts(store, 'interaction')
  const host = hosts.add({ name: 'Studio', endpointId: theirs, peerRole: 'compute' }, 1)
  const script = new Script()
  b.accept((stream, from) => { void script.accept(stream, from.kind) })
  const timers: { fn(): void; ms: number; live: boolean }[] = []
  const start = () => {
    // The two need each other: the controller names in `Hello.resume` what the jobs still want.
    const controller: Controller = new Controller({
      connect: a, hosts, name: 'Laptop', appVersion: '1.0.0', resume: (hostId) => jobs.outstanding(hostId),
      timer: (fn, ms) => {
        const entry = { fn, ms, live: true }
        timers.push(entry)
        return { clear: () => { entry.live = false } }
      },
    })
    const jobs: RemoteJobs = new RemoteJobs({ controller, store, now: () => 700 })
    closing.push(() => controller.close())
    return { controller, jobs }
  }
  closing.push(() => a.close(), () => b.close())
  const fire = (ms: number): void => {
    const timer = timers.find((one) => one.live && one.ms === ms)
    if (!timer) throw new Error(`No timer of ${ms} ms is armed.`)
    timer.live = false
    timer.fn()
  }
  return { store, a, b, hosts, host, script, timers, fire, start, ...start() }
}

const events = (seen: JobEvent[]) => ({ onEvent: (event: JobEvent) => { seen.push(event) } })
const say = (stream: Duplex, ...frames: JobEvent[]): void => { for (const frame of frames) stream.write(encodeFrame(frame)) }
const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

test('run submits once, reports every event in order, and remembers the job only until it ends', async () => {
  const { jobs, script, host, store } = await rig()
  const seen: JobEvent[] = []
  const running = jobs.run(host.id, submit, events(seen))
  await vi.waitFor(() => expect(script.submits()).toHaveLength(1))
  // The submit went out on a session that did not name it: a host is never asked about a job it has not been sent.
  expect(script.hellos()).toEqual([{ protocol: { min: 1, max: 1 }, appVersion: '1.0.0', name: 'Laptop' }])
  expect(script.submits()[0]!.open).toEqual({ stream: 'job', submit })
  expect(store.kvGet(CORE, JOBS_KEY)).toEqual([{ hostId: host.id, jobId: 'job-1', label: 'image.render', createdAt: 700 }])
  expect(jobs.outstanding(host.id)).toEqual(['job-1'])
  expect(jobs.outstanding('otherhost1')).toEqual([])
  const artifact = { id: 'a1', jobId: 'job-1', name: 'out.png', mime: 'image/png', bytes: 3, sha256: 'f'.repeat(64), expiresAt: 9 }
  const done = job('job-1', 'succeeded', { artifacts: [artifact] })
  const said: JobEvent[] = [
    { type: 'state', seq: 1, job: job('job-1', 'running') },
    { type: 'progress', seq: 2, progress: { progress: 1, total: 2 } },
    { type: 'output', seq: 3, output: { type: 'text', text: 'halfway' } },
    { type: 'done', seq: 4, job: done },
  ]
  say(script.submits()[0]!.stream, ...said)
  expect(await running).toEqual(done)
  expect(seen).toEqual(said)
  expect(store.kvGet(CORE, JOBS_KEY)).toEqual([])
  expect(jobs.outstanding(host.id)).toEqual([])
  expect(script.submits()).toHaveLength(1)
})

test('a reconnect asks about the job by id and attaches from the last event: it never submits again', async () => {
  const { jobs, script, host, store } = await rig()
  const seen: JobEvent[] = []
  const running = jobs.run(host.id, submit, events(seen))
  await vi.waitFor(() => expect(script.submits()).toHaveLength(1))
  say(script.submits()[0]!.stream, { type: 'state', seq: 1, job: job('job-1', 'running') }, { type: 'progress', seq: 2, progress: { progress: 1 } })
  await vi.waitFor(() => expect(seen).toHaveLength(2))
  script.known.set('job-1', job('job-1', 'running'))
  script.cut()
  await vi.waitFor(() => expect(script.attaches()).toHaveLength(1))
  expect(script.hellos()).toHaveLength(2)
  expect(script.hellos()[1]!.resume).toEqual(['job-1'])
  expect(script.attaches()).toEqual([{ stream: 'job', attach: 'job-1', after: 2 }])
  expect(store.kvGet(CORE, JOBS_KEY)).toHaveLength(1)
  // A host that replays from before `after` is heard once, not twice.
  const done = job('job-1', 'succeeded')
  say(script.jobs().at(-1)!.stream, { type: 'progress', seq: 2, progress: { progress: 1 } }, { type: 'progress', seq: 3, progress: { progress: 2 } }, { type: 'done', seq: 4, job: done })
  expect(await running).toEqual(done)
  expect(seen.map((event) => event.seq)).toEqual([1, 2, 3, 4])
  expect(script.submits()).toHaveLength(1)
  expect(store.kvGet(CORE, JOBS_KEY)).toEqual([])
})

test('a job the host reports interrupted resolves run() with that state and is not resubmitted', async () => {
  const { jobs, script, host, store } = await rig()
  const seen: JobEvent[] = []
  const running = jobs.run(host.id, submit, events(seen))
  await vi.waitFor(() => expect(script.submits()).toHaveLength(1))
  say(script.submits()[0]!.stream, { type: 'state', seq: 1, job: job('job-1', 'running') })
  await vi.waitFor(() => expect(seen).toHaveLength(1))
  // The grace ran out, or the host restarted: it no longer has the job, and says so in its welcome.
  script.cut()
  const final = await running
  expect(final).toEqual(job('job-1', 'interrupted', { failure: { code: 'interrupted', message: 'The host restarted.' } }))
  expect(script.hellos()[1]!.resume).toEqual(['job-1'])
  await quiet()
  expect(script.submits()).toHaveLength(1)
  expect(script.attaches()).toEqual([])
  expect(store.kvGet(CORE, JOBS_KEY)).toEqual([])
})

test('a host with no memory of a job it was sent is the job interrupted', async () => {
  const { jobs, script, host, controller } = await rig()
  const running = jobs.run(host.id, submit)
  await vi.waitFor(() => expect(script.submits()).toHaveLength(1))
  // Only the job's stream breaks, so there is no welcome to say where it stands: the host is asked.
  script.submits()[0]!.stream.destroy()
  expect(await running).toEqual({
    id: 'job-1', kind: 'operation', weight: 'heavy', state: 'interrupted', label: 'image.render', createdAt: 700,
    failure: { code: 'interrupted', message: expect.any(String) },
  })
  expect(script.requests.map((request) => request.method)).toEqual(['job.status'])
  expect(script.hellos()).toHaveLength(1)
  expect(script.submits()).toHaveLength(1)
  expect(controller.view(host.id)!.failure).toBeUndefined()
})

test('while the host is unreachable the job waits, the host stays listed offline, and nothing is resubmitted when it returns', async () => {
  const { jobs, script, host, controller, a, timers, fire, store } = await rig()
  const running = jobs.run(host.id, submit)
  let settled = false
  void running.then(() => { settled = true }, () => { settled = true })
  await vi.waitFor(() => expect(script.submits()).toHaveLength(1))
  a.down = true
  script.cut()
  await vi.waitFor(() => expect(timers.filter((timer) => timer.live).map((timer) => timer.ms)).toEqual([1000]))
  expect(controller.views()).toMatchObject([{ host: { id: host.id }, connection: 'offline', failure: { code: 'offline' }, inventory }])
  expect(store.kvGet(CORE, JOBS_KEY)).toHaveLength(1)
  fire(1000)
  await vi.waitFor(() => expect(timers.filter((timer) => timer.live).map((timer) => timer.ms)).toEqual([2000]))
  expect(settled).toBe(false)
  script.known.set('job-1', job('job-1', 'running'))
  a.down = false
  fire(2000)
  await vi.waitFor(() => expect(script.attaches()).toHaveLength(1))
  expect(script.hellos().at(-1)!.resume).toEqual(['job-1'])
  say(script.jobs().at(-1)!.stream, { type: 'done', seq: 9, job: job('job-1', 'succeeded') })
  expect(await running).toEqual(job('job-1', 'succeeded'))
  expect(script.submits()).toHaveLength(1)
})

test('a controller restart resumes from compute_jobs: Hello names the job, and it is attached, not submitted', async () => {
  const first = await rig()
  const { store } = first
  const before = first.jobs.run(first.host.id, submit)
  before.catch(() => {})
  await vi.waitFor(() => expect(first.script.submits()).toHaveLength(1))
  // The interaction computer goes away mid-job. Only the store survives it.
  await first.controller.close()
  first.script.cut()
  expect(store.kvGet(CORE, JOBS_KEY)).toEqual([{ hostId: first.host.id, jobId: 'job-1', label: 'image.render', createdAt: 700 }])

  const { script, start, host } = first
  const { jobs } = start()
  script.known.set('job-1', job('job-1', 'running'))
  expect(jobs.outstanding(host.id)).toEqual(['job-1'])
  const seen: JobEvent[] = []
  const following = jobs.attach(host.id, 'job-1', events(seen))
  await vi.waitFor(() => expect(script.attaches()).toHaveLength(1))
  expect(script.hellos().at(-1)!.resume).toEqual(['job-1'])
  expect(script.attaches()).toEqual([{ stream: 'job', attach: 'job-1' }])
  const done = job('job-1', 'succeeded')
  say(script.jobs().at(-1)!.stream, { type: 'state', seq: 1, job: job('job-1', 'running') }, { type: 'done', seq: 2, job: done })
  expect(await following).toEqual(done)
  expect(seen).toHaveLength(2)
  expect(script.submits()).toHaveLength(1)
  expect(store.kvGet(CORE, JOBS_KEY)).toEqual([])
})

test('after a restart, a job the host finished or lost meanwhile leaves compute_jobs, and its last word is kept for an attach', async () => {
  const { script, controller, jobs, store, host: { id: hostId } } = await rig()
  store.kvSet(CORE, JOBS_KEY, [
    { hostId, jobId: 'finished', label: 'image.render', createdAt: 1 },
    { hostId, jobId: 'lost', label: 'image.render', createdAt: 2 },
    { hostId, jobId: 'working', label: 'image.render', createdAt: 3 },
    'not a record',
  ])
  script.known.set('finished', job('finished', 'succeeded'))
  script.known.set('working', job('working', 'running'))
  expect(jobs.outstanding(hostId)).toEqual(['finished', 'lost', 'working'])
  await controller.ensure(hostId)
  expect(script.hellos()[0]!.resume).toEqual(['finished', 'lost', 'working'])
  expect(jobs.outstanding(hostId)).toEqual(['working'])
  expect((await jobs.attach(hostId, 'lost')).state).toBe('interrupted')
  // What the host says later, unasked, settles the rest.
  script.say({ event: 'job', job: job('working', 'failed', { failure: { code: 'worker-failure', message: 'The worker stopped.' } }) })
  await vi.waitFor(() => expect(store.kvGet(CORE, JOBS_KEY)).toEqual([]))
  expect(script.jobs()).toEqual([])
})

test('nothing is recorded or sent when the host cannot be reached, and a job id is submitted once', async () => {
  const { jobs, script, host, store, b } = await rig()
  await b.close()
  await expect(jobs.run(host.id, submit)).rejects.toMatchObject({ code: 'offline' })
  expect(store.kvGet(CORE, JOBS_KEY)).toEqual([])
  expect(script.opened).toEqual([])

  const again = await rig()
  const running = again.jobs.run(again.host.id, submit)
  await vi.waitFor(() => expect(again.script.submits()).toHaveLength(1))
  await expect(again.jobs.run(again.host.id, submit)).rejects.toMatchObject({ code: 'refused' })
  expect(again.script.submits()).toHaveLength(1)
  say(again.script.submits()[0]!.stream, { type: 'done', seq: 1, job: job('job-1', 'succeeded') })
  await running
})

test('stopping a run cancels the job on its stream and still reports the host\'s last word', async () => {
  const { jobs, script, host } = await rig()
  const abort = new AbortController()
  const running = jobs.run(host.id, submit, undefined, abort.signal)
  await vi.waitFor(() => expect(script.submits()).toHaveLength(1))
  const { stream, frames } = script.submits()[0]!
  abort.abort()
  expect(await frames.next()).toEqual({ type: 'cancel' })
  const done = job('job-1', 'cancelled', { failure: { code: 'cancelled', message: 'Cancelled.' } })
  say(stream, { type: 'done', seq: 1, job: done })
  expect(await running).toEqual(done)
})

test('a run stopped before it has a session sends nothing and remembers nothing', async () => {
  const { jobs, script, host, store } = await rig()
  const abort = new AbortController()
  const running = jobs.run(host.id, submit, undefined, abort.signal)
  abort.abort()
  await expect(running).rejects.toMatchObject({ code: 'cancelled' })
  await quiet()
  expect(script.submits()).toEqual([])
  expect(store.kvGet(CORE, JOBS_KEY)).toEqual([])
  await expect(jobs.run(host.id, submit, undefined, abort.signal)).rejects.toMatchObject({ code: 'cancelled' })
})

test('stopping an attach only stops listening: the job is left alone and still wanted', async () => {
  const { jobs, script, host, store } = await rig()
  const original = jobs.run(host.id, submit)
  await vi.waitFor(() => expect(script.submits()).toHaveLength(1))
  script.known.set('job-1', job('job-1', 'running'))
  const abort = new AbortController()
  const following = jobs.attach(host.id, 'job-1', undefined, abort.signal)
  await vi.waitFor(() => expect(script.attaches()).toHaveLength(1))
  abort.abort()
  await expect(following).rejects.toMatchObject({ code: 'cancelled' })
  await quiet()
  expect(script.requests.some((request) => request.method === 'job.cancel')).toBe(false)
  expect(store.kvGet(CORE, JOBS_KEY)).toHaveLength(1)
  say(script.submits()[0]!.stream, { type: 'done', seq: 1, job: job('job-1', 'succeeded') })
  expect((await original).state).toBe('succeeded')
})

test('cancel asks the host, and the queue is the host\'s own', async () => {
  const { jobs, script, host, store, controller } = await rig()
  store.kvSet(CORE, JOBS_KEY, [{ hostId: host.id, jobId: 'queued', label: 'image.render', createdAt: 1 }])
  script.queue = { waiting: [job('queued', 'queued')], paused: false }
  script.known.set('queued', job('queued', 'cancelled'))
  expect(jobs.queue(host.id)).toBeUndefined()
  expect(await jobs.cancel(host.id, 'queued')).toEqual(job('queued', 'cancelled'))
  expect(script.requests.at(-1)).toMatchObject({ method: 'job.cancel', params: { jobId: 'queued' } })
  expect(jobs.queue(host.id)).toEqual({ waiting: [job('queued', 'queued')], paused: false })
  expect(controller.queue(host.id)).toEqual(jobs.queue(host.id))
  expect(store.kvGet(CORE, JOBS_KEY)).toEqual([])
  await expect(jobs.cancel(host.id, 'never')).rejects.toMatchObject({ code: 'not-found' })
})
