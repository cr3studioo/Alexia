// SPDX-License-Identifier: AGPL-3.0-only
import type { Duplex } from 'node:stream'
import { afterEach, expect, test, vi } from 'vitest'
import { memoryConnect, type ConnectHints } from '../src/compute/connect.js'
import { Controller, Frames, HANDSHAKE_MS, type ControllerOptions } from '../src/compute/controller.js'
import { Hosts } from '../src/compute/hosts.js'
import { encodeFrame, type ControlEvent, type ControlOpened, type ControlRequest, type ControllerBye, type ControllerFrame, type Hello, type StreamKind, type StreamOpen } from '../src/compute/protocol.js'
import { ComputeError, type HostInventory, type JobSnapshot } from '../src/compute/types.js'
import { Store } from '../src/store.js'

const inventory = (revision = 1): HostInventory => ({
  name: 'Studio', appVersion: '2.0.0', revision, models: [], capabilities: [], setup: [],
  machine: { platform: 'win32', arch: 'x64', chip: 'Test', appleSilicon: false, ramBytes: 64, freeDiskBytes: 64, budgetBytes: 32 },
})
const job = (id: string, state: JobSnapshot['state']): JobSnapshot => ({ id, kind: 'operation', weight: 'heavy', state, label: 'image.render', createdAt: 1 })

interface Opened { kind: StreamKind; open: StreamOpen; stream: Duplex; frames: Frames }

/** A compute host that says exactly what a test tells it to, over the in-memory transport. */
class Script {
  readonly opened: Opened[] = []
  readonly requests: ControlRequest[] = []
  readonly byes: ControllerBye[] = []
  control?: Duplex
  /** What a `Hello` is answered with. Undefined is a host that accepts the stream and says nothing. */
  welcome: (hello: Hello) => ControlOpened | undefined = (hello) => ({ type: 'welcome', welcome: {
    protocol: 1, appVersion: '2.0.0', name: 'Studio', inventory: inventory(), queue: { waiting: [], paused: false },
    jobs: (hello.resume ?? []).map((id) => job(id, 'running')),
  } })
  /** A request's result. Throwing a ComputeError refuses it; returning `Script.SILENT` never answers. */
  answer: (request: ControlRequest) => unknown = () => ({})
  static readonly SILENT = Symbol('silent')

  async accept(stream: Duplex, kind: StreamKind): Promise<void> {
    const frames = new Frames(stream)
    const open = await frames.next() as StreamOpen
    this.opened.push({ kind, open, stream, frames })
    if (open.stream !== 'control') return
    const said = this.welcome(open.hello)
    if (!said) return
    stream.write(encodeFrame(said))
    if (said.type !== 'welcome') { stream.end(); return }
    this.control = stream
    for (;;) {
      const request = await frames.next().catch(() => undefined) as ControllerFrame | undefined
      if (!request) return
      if ('event' in request) { this.byes.push(request); continue }
      this.requests.push(request)
      try {
        const result = this.answer(request)
        if (result !== Script.SILENT) stream.write(encodeFrame({ id: request.id, ok: true, result }))
      } catch (error) { stream.write(encodeFrame({ id: request.id, ok: false, failure: (error as ComputeError).failure() })) }
    }
  }

  say(event: ControlEvent): void { this.control!.write(encodeFrame(event)) }
  hellos(): Hello[] { return this.opened.flatMap((one) => one.open.stream === 'control' ? [one.open.hello] : []) }
}

const closing: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close() })

async function rig(options: Partial<ControllerOptions> = {}) {
  const store = new Store(':memory:')
  const { a, b } = memoryConnect()
  const [mine, theirs] = [await a.identity(), await b.identity()]
  await a.allow([theirs])
  await b.allow([mine])
  const hosts = new Hosts(store, 'interaction')
  const host = hosts.add({ name: 'Paired computer', endpointId: theirs, peerRole: 'compute' }, 1)
  const script = new Script()
  b.accept((stream, from) => { void script.accept(stream, from.kind) })
  const timers: { fn(): void; ms: number; live: boolean }[] = []
  const controller = new Controller({
    connect: a, hosts, name: 'Laptop', appVersion: '1.0.0', now: () => 5000,
    timer: (fn, ms) => {
      const entry = { fn, ms, live: true }
      timers.push(entry)
      return { clear: () => { entry.live = false } }
    },
    ...options,
  })
  closing.push(() => store.close(), () => a.close(), () => b.close(), () => controller.close())
  /** The reconnection timers still armed: every one but the handshake deadline. */
  const armed = () => timers.filter((timer) => timer.live && timer.ms !== HANDSHAKE_MS)
  const fire = (ms: number): void => {
    const timer = timers.find((one) => one.live && one.ms === ms)
    if (!timer) throw new Error(`No timer of ${ms} ms is armed.`)
    timer.live = false
    timer.fn()
  }
  return { store, a, b, hosts, host, script, controller, timers, armed, fire, theirs }
}

const code = async (work: Promise<unknown>): Promise<string> => work.then(() => 'resolved', (error: unknown) => error instanceof ComputeError ? error.code : `threw ${String(error)}`)
const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

test('a session opens on demand with a Hello, and the host is shown with what it said', async () => {
  const { controller, script, host, hosts } = await rig()
  expect(script.opened).toEqual([])
  expect(controller.views()).toEqual([{ host, connection: 'offline', failure: { code: 'offline', message: expect.any(String) } }])
  const changed = vi.fn()
  controller.onChange(changed)
  await controller.ensure(host.id)
  await controller.ensure(host.id)
  expect(script.hellos()).toEqual([{ protocol: { min: 1, max: 1 }, appVersion: '1.0.0', name: 'Laptop' }])
  const view = controller.view(host.id)!
  expect(view).toMatchObject({ connection: 'direct', inventory: inventory() })
  expect(view.failure).toBeUndefined()
  expect(changed).toHaveBeenCalledWith(host.id)
  expect(hosts.get(host.id)).toMatchObject({ name: 'Studio', appVersion: '2.0.0', platform: 'win32', lastSeenAt: 5000 })
  expect(controller.queue(host.id)).toEqual({ waiting: [], paused: false })
  expect(await code(controller.ensure('nobodypaired'))).toBe('unpaired')
})

test('an incompatible protocol version is reported as itself, and is not retried', async () => {
  const { controller, script, host, armed, hosts } = await rig({ resume: () => ['job-1'] })
  script.welcome = () => ({ type: 'refused', failure: { code: 'incompatible-version', message: 'Update Alexia on this computer.' } })
  expect(await code(controller.ensure(host.id))).toBe('incompatible-version')
  expect(controller.view(host.id)).toMatchObject({ connection: 'direct', failure: { code: 'incompatible-version', message: 'Update Alexia on this computer.' } })
  expect(armed()).toEqual([])
  expect(hosts.list()).toHaveLength(1)

  // A host that welcomes with a version this build does not speak is the same state.
  script.welcome = (hello) => ({ type: 'welcome', welcome: { protocol: 2, appVersion: '9', name: 'Studio', inventory: inventory(), queue: { waiting: [], paused: false }, jobs: hello.resume!.map((id) => job(id, 'running')) } })
  expect(await code(controller.ensure(host.id))).toBe('incompatible-version')
  expect(controller.view(host.id)!.inventory).toBeUndefined()
  expect(script.opened.every((one) => one.kind === 'control')).toBe(true)
})

test('an offline host stays listed with its last inventory and its reason', async () => {
  const { controller, script, host, hosts, b } = await rig()
  await controller.ensure(host.id)
  script.say({ event: 'inventory', inventory: inventory(2) })
  await vi.waitFor(() => expect(controller.view(host.id)!.inventory!.revision).toBe(2))
  await b.close()
  await vi.waitFor(() => expect(controller.view(host.id)!.connection).toBe('offline'))
  expect(await code(controller.ensure(host.id))).toBe('offline')
  expect(controller.views()).toEqual([{ host: hosts.get(host.id), connection: 'offline', failure: { code: 'offline', message: expect.any(String) }, inventory: inventory(2) }])
  expect(hosts.list()).toHaveLength(1)
})

test('a host that drops the stream before answering is offline, never forgotten', async () => {
  const { controller, script, host, hosts } = await rig()
  script.welcome = () => { script.opened.at(-1)!.stream.destroy(); return undefined }
  expect(await code(controller.ensure(host.id))).toBe('offline')
  expect(controller.view(host.id)!.failure!.code).toBe('offline')
  expect(hosts.get(host.id)).toBeDefined()
})

test('a host that never answers the Hello is offline once the handshake deadline passes', async () => {
  const { controller, script, host, fire } = await rig()
  script.welcome = () => undefined
  const opening = code(controller.ensure(host.id))
  await vi.waitFor(() => expect(script.hellos()).toHaveLength(1))
  fire(HANDSHAKE_MS)
  expect(await opening).toBe('offline')
})

test('a reconnect re-sends Hello with resume, and never a submit', async () => {
  const wanted = ['job-1', 'job-2']
  const { controller, script, host, armed, fire } = await rig({ resume: () => wanted })
  const events: ControlEvent[] = []
  controller.onEvent((_hostId, event) => { events.push(event) })
  await controller.ensure(host.id)
  expect(script.hellos()[0]!.resume).toEqual(wanted)
  script.control!.destroy()
  await vi.waitFor(() => expect(armed().map((timer) => timer.ms)).toEqual([1000]))
  expect(script.hellos()).toHaveLength(1)
  events.length = 0
  fire(1000)
  await vi.waitFor(() => expect(script.hellos()).toHaveLength(2))
  expect(script.hellos()[1]).toEqual({ protocol: { min: 1, max: 1 }, appVersion: '1.0.0', name: 'Laptop', resume: wanted })
  // The welcome is heard as events, so whoever follows those jobs learns where they stand.
  await vi.waitFor(() => expect(events.filter((event) => event.event === 'job')).toEqual(wanted.map((id) => ({ event: 'job', job: job(id, 'running') }))))
  expect(script.opened.map((one) => one.kind)).toEqual(['control', 'control'])
  expect(armed()).toEqual([])
})

test('reconnection backs off 1 s, 2 s, 4 s, then every 5 s, and only while something is wanted', async () => {
  let wanted = ['job-1']
  const { controller, host, armed, fire, b } = await rig({ resume: () => wanted })
  await controller.ensure(host.id)
  await b.close()
  for (const ms of [1000, 2000, 4000, 5000, 5000]) {
    await vi.waitFor(() => expect(armed().map((timer) => timer.ms)).toEqual([ms]))
    fire(ms)
  }
  await vi.waitFor(() => expect(armed().map((timer) => timer.ms)).toEqual([5000]))
  wanted = []
  fire(5000)
  await quiet()
  expect(armed()).toEqual([])
  expect(controller.view(host.id)!.failure!.code).toBe('offline')
})

test('a lost session that nothing is waiting on is not reopened', async () => {
  const { controller, script, host, armed } = await rig()
  await controller.ensure(host.id)
  const pending = code(controller.call(host.id, 'ping', {}))
  script.answer = () => Script.SILENT
  await vi.waitFor(() => expect(script.requests).toHaveLength(1))
  script.control!.destroy()
  expect(await pending).toBe('offline')
  await quiet()
  expect(armed()).toEqual([])
  expect(script.hellos()).toHaveLength(1)
})

test('the host whose model is chosen gets a session as soon as the transport finds it, with no job waiting', async () => {
  // Without one its models are not listed and its state reads offline, until somebody presses Use this model.
  const kept = new Set<string>()
  const { controller, script, host, a, theirs } = await rig({ keep: (hostId) => kept.has(hostId) })
  const reach = (state: 'direct' | 'offline'): void => { (a as unknown as { change(id: string, state: string): void }).change(theirs, state) }
  reach('direct')
  await quiet()
  expect(script.hellos()).toEqual([])
  reach('offline')
  kept.add(host.id)
  reach('direct')
  await vi.waitFor(() => expect(controller.view(host.id)).toMatchObject({ inventory: inventory() }))
  expect(script.hellos()).toHaveLength(1)
})

test('calls are answered by id, refusals keep their code, and a cancelled call stops waiting', async () => {
  const { controller, script, host } = await rig()
  script.answer = (request) => {
    if (request.method === 'job.status') throw new ComputeError('not-found', 'No such job.')
    if (request.method === 'queue.get') return Script.SILENT
    return request.method === 'inventory.get' ? inventory(7) : {}
  }
  const [first, second] = await Promise.all([controller.call(host.id, 'inventory.get', {}), controller.call(host.id, 'ping', {})])
  expect(first).toEqual(inventory(7))
  expect(second).toEqual({})
  expect(script.requests.map((request) => request.id)).toEqual([1, 2])
  await expect(controller.call(host.id, 'job.status', { jobId: 'nope' })).rejects.toMatchObject({ code: 'not-found', message: 'No such job.' })
  const abort = new AbortController()
  const waiting = code(controller.call(host.id, 'queue.get', {}, abort.signal))
  await vi.waitFor(() => expect(script.requests).toHaveLength(4))
  abort.abort()
  expect(await waiting).toBe('cancelled')
})

test('what a host says unasked reaches listeners, and unpaired is final without forgetting the host', async () => {
  const { controller, script, host, hosts, armed } = await rig({ resume: () => ['job-1'] })
  const events: ControlEvent[] = []
  controller.onEvent((hostId, event) => { if (hostId === host.id) events.push(event) })
  await controller.ensure(host.id)
  events.length = 0
  const queue = { running: job('job-1', 'running'), waiting: [], paused: true }
  script.say({ event: 'queue', queue })
  script.say({ event: 'bye', reason: 'unpaired' })
  await vi.waitFor(() => expect(controller.view(host.id)!.failure).toEqual({ code: 'unpaired', message: expect.any(String) }))
  expect(events).toEqual([{ event: 'queue', queue }, { event: 'bye', reason: 'unpaired' }])
  expect(controller.queue(host.id)).toEqual(queue)
  expect(hosts.list()).toHaveLength(1)
  await quiet()
  expect(armed()).toEqual([])
  expect(script.hellos()).toHaveLength(1)
  // Asked outright, it tries again: the same endpoint may have been paired anew.
  await controller.ensure(host.id)
  expect(controller.view(host.id)!.failure).toBeUndefined()
})

test('a stream opens the session first and carries its open frame', async () => {
  const { controller, script, host } = await rig()
  const stream = await controller.stream(host.id, { stream: 'job', attach: 'job-1', after: 3 })
  await vi.waitFor(() => expect(script.opened).toHaveLength(2))
  expect(script.opened.map((one) => one.kind)).toEqual(['control', 'job'])
  expect(script.opened[1]!.open).toEqual({ stream: 'job', attach: 'job-1', after: 3 })
  script.opened[1]!.stream.write(encodeFrame({ hello: 'back' }))
  expect(await new Frames(stream).next()).toEqual({ hello: 'back' })
  stream.destroy()
})

test('drop closes the session and stops reconnecting; removing the host does the same', async () => {
  const { controller, script, host, hosts, armed } = await rig({ resume: () => ['job-1'] })
  await controller.ensure(host.id)
  await controller.drop(host.id)
  await vi.waitFor(() => expect(script.control!.destroyed).toBe(true))
  await quiet()
  expect(armed()).toEqual([])
  await controller.ensure(host.id)
  expect(script.hellos()).toHaveLength(2)
  hosts.remove(host.id)
  await vi.waitFor(() => expect(script.control!.destroyed).toBe(true))
  expect(controller.views()).toEqual([])
  expect(await code(controller.ensure(host.id))).toBe('unpaired')
  expect(armed()).toEqual([])
})

test('unpair sends bye unpaired to a reachable host that advertises it and stops reconnecting', async () => {
  const { controller, script, host, armed } = await rig({ resume: () => ['job-1'] })
  const welcome = script.welcome
  script.welcome = (hello) => {
    const opened = welcome(hello)!
    if (opened.type === 'welcome') opened.welcome.controllerUnpair = true
    return opened
  }
  await controller.ensure(host.id)
  await controller.unpair(host.id)
  await vi.waitFor(() => { expect(script.byes).toEqual([{ event: 'bye', reason: 'unpaired' }]) })
  expect(armed()).toEqual([])
  expect(script.requests).toEqual([])
  expect(script.control!.destroyed).toBe(true)
})

test('unpair leaves legacy and unreachable hosts to forget their controller at the host', async () => {
  const { controller, script, host, a, hosts } = await rig()
  await controller.ensure(host.id)
  await controller.unpair(host.id)
  expect(script.byes).toEqual([])
  expect(hosts.get(host.id)).toBeDefined()
  await a.allow([])
  const open = vi.spyOn(a, 'open')
  await controller.unpair(host.id)
  expect(open).not.toHaveBeenCalled()
  expect(script.byes).toEqual([])
})

test('address hints are supplied before connecting and kept after a welcome', async () => {
  const saved: [string, ConnectHints][] = []
  const load = vi.fn((): ConnectHints | undefined => ({ relayUrl: null, directAddresses: ['192.168.1.20:4433'] }))
  const { controller, host } = await rig({ hints: { load, save: (hostId, hints) => { saved.push([hostId, hints]) } } })
  await controller.ensure(host.id)
  expect(load).toHaveBeenCalledWith(host.id)
  await vi.waitFor(() => expect(saved).toEqual([[host.id, { relayUrl: null, directAddresses: [] }]]))
})

test('close ends every session and refuses to open another', async () => {
  const { controller, script, host } = await rig({ resume: () => ['job-1'] })
  await controller.ensure(host.id)
  await controller.close()
  await vi.waitFor(() => expect(script.control!.destroyed).toBe(true))
  expect(await code(controller.ensure(host.id))).toBe('offline')
  expect(script.hellos()).toHaveLength(1)
})
