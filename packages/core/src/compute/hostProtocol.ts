// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { Readable, type Duplex } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { RunnerLease } from '../localRunners.js'
import { CORE } from '../secrets.js'
import type { Store } from '../store.js'
import type { Artifacts } from './artifacts.js'
import type { Connect } from './connect.js'
import { Frames, HANDSHAKE_MS, send } from './controller.js'
import type { Hosts } from './hosts.js'
import type { Inventory } from './inventory.js'
import {
  ARTIFACT_ARG, encodeFrame, isHostModelOp, negotiate, PREVIEW_MAX_CHARS, refused,
  type ArtifactHead, type ArtifactPut, type ArtifactPutResult, type ByeReason, type ControlEvent, type ControlOpened,
  type ControlResponse, type Hello, type HostFrame, type HostModelOp, type InferHead, type JobEvent, type JobOutput,
  type JobSubmit, type Lease, type StreamKind, type StreamOpen,
} from './protocol.js'
import type { Admission, Scheduler } from './scheduler.js'
import { scrub } from './scrub.js'
import { runWorker, Setup } from './setup.js'
import {
  COMPUTE_ERRORS, ComputeError, finished, queuePosition, RECONNECT_GRACE_MS,
  type ArtifactRef, type ComputeErrorCode, type ComputeFailure, type JobSnapshot, type JobState, type PairedHost,
} from './types.js'
import { TEXT_WORKER, type ComputeWorker, type Workers } from './workers.js'

/** Whether the host's owner paused it from the tray. Kept, so a restart comes back paused. */
export const PAUSED_KEY = 'compute_paused'

/** The largest request body an `infer` stream may carry: the bridge's own limit. */
const BODY_MAX_BYTES = 64 * 1024 * 1024
/** How many jobs a `Hello` may ask about. */
const RESUME_MAX = 500
/** How many of a job's events are kept for a controller that attaches late. */
const EVENTS_MAX = 500
/** How many released leases are remembered, so an answer naming one can load its model again. */
const RELEASED_MAX = 64
/** What a reader that stopped reading may leave unread before its stream is closed. */
const BACKLOG_MAX_BYTES = 8 * 1024 * 1024
/** One `text` output's size. Longer text is several outputs, which the controller joins. */
const TEXT_CHUNK_CHARS = 64 * 1024

type InferOpen = Extract<StreamOpen, { stream: 'infer' }>
type ArtifactOpen = Extract<StreamOpen, { stream: 'artifact' }>

export interface HostModels { call(op: HostModelOp, args: Record<string, unknown>): Promise<unknown> }

export interface HostProtocolOptions {
  connect: Connect
  hosts: Hosts
  scheduler: Scheduler
  workers: Workers
  artifacts: Artifacts
  inventory: Inventory
  /** The host's own picker operations: `LocalModels`, called by name from HOST_MODEL_OPS. */
  models: HostModels
  name: string
  appVersion: string
  /** Where {@link PAUSED_KEY} lives. Without it a pause lasts until the service stops. */
  store?: Pick<Store, 'kvGet' | 'kvSet'>
  /** The install button's other end. Default: one built over the same four modules. */
  setup?: Setup
  /** How the text runner's loopback address is asked. Replaceable in a test. */
  fetch?: typeof fetch
  maxBodyBytes?: number
  graceMs?: number                   // RECONNECT_GRACE_MS
  now?(): number
  timer?(fn: () => void, ms: number): { clear(): void }
  /** The running plugin job's cancellation deadline. Default: `timer`. */
  workerTimer?: HostProtocolOptions['timer']
  /** Told a stream's kind and why it was closed, and nothing else. */
  log?(line: string): void
}

interface Session {
  stream: Duplex
  endpointId: string
}

/** What a job has said, kept so a controller that attaches late hears what it missed. */
interface Track {
  seq: number
  events: JobEvent[]
  state?: JobState
  done: boolean
  listeners: Set<(event: JobEvent) => void>
}

/** The one chat model held for the controller, and every lease that names it. */
interface Held {
  modelId: string
  leases: Map<string, Lease>
  /** Its load's place in the queue, until that job ends. */
  jobId?: string
  runner?: RunnerLease
  unhold?: () => void
  /** Answers streaming from the runner right now. Its lease outlives the selection until they end. */
  answering: number
  dropped: boolean
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((one) => typeof one === 'string')
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function text(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new ComputeError('refused', 'That request is missing something it needs.')
  return value
}

/** Whatever went wrong, as a code and one line a person can be shown. */
function failureOf(error: unknown, fallback: string, said = false, code: ComputeErrorCode = 'worker-failure'): ComputeFailure {
  if (error instanceof ComputeError && (COMPUTE_ERRORS as readonly unknown[]).includes(error.code)) return { code: error.code, message: scrub(error.message) || fallback }
  return { code, message: (said && error instanceof Error && scrub(error.message)) || fallback }
}

/** A stream's first frame, when it is one this build understands. */
function opening(frame: unknown): StreamOpen | undefined {
  const open = record(frame)
  if (open.stream === 'control') {
    const hello = record(open.hello), protocol = record(hello.protocol)
    if (typeof protocol.min !== 'number' || typeof protocol.max !== 'number' || typeof hello.appVersion !== 'string' || typeof hello.name !== 'string') return undefined
    if (hello.resume !== undefined && !strings(hello.resume)) return undefined
    return frame as StreamOpen
  }
  if (open.stream === 'infer') {
    return typeof open.jobId === 'string' && open.jobId !== '' && typeof open.leaseId === 'string' && count(open.bodyBytes) ? frame as StreamOpen : undefined
  }
  if (open.stream === 'job') {
    if (typeof open.attach === 'string') return open.after === undefined || count(open.after) ? frame as StreamOpen : undefined
    const submit = record(open.submit)
    if (typeof submit.jobId !== 'string' || typeof submit.cap !== 'string' || submit.cap === '') return undefined
    if (submit.arguments !== undefined && submit.arguments !== record(submit.arguments)) return undefined
    return submit.inputs === undefined || strings(submit.inputs) ? frame as StreamOpen : undefined
  }
  if (open.stream === 'artifact') {
    if (typeof open.get === 'string') return open.offset === undefined || count(open.offset) ? frame as StreamOpen : undefined
    return open.put === record(open.put) ? frame as StreamOpen : undefined
  }
  return undefined
}

const fresh = (modelId: string): Held => ({ modelId, leases: new Map(), answering: 0, dropped: false })

/** The next `bytes` raw bytes of a stream, and no more of it than that. */
async function* exactly(frames: Frames, bytes: number): AsyncGenerator<Uint8Array, void, void> {
  if (!(bytes > 0)) return
  let seen = 0
  for await (const chunk of frames.bytes()) {
    seen += chunk.length
    yield chunk
    if (seen >= bytes) return
  }
}

/** Say one last thing, finish, and read whatever the far side still sends so its writer is never left waiting. */
function bow(stream: Duplex, last?: unknown): void {
  if (!stream.destroyed && !stream.writableEnded) stream.end(last === undefined ? undefined : encodeFrame(last))
  stream.on('data', () => {})
}

/**
 * **The compute protocol's host end**: the paired controller's streams, turned into calls on
 * the scheduler, the artifact store and the workers.
 *
 * It holds no policy of its own. What may run and when is the scheduler's, where a file lives
 * is the artifact store's, and what an operation does is its worker's. What is here is the
 * session: who is speaking, what they are owed an answer about, and what happens to their
 * work when they go quiet. A job belongs to that session and never to the stream that
 * submitted it; nothing a controller did not ask for by id is ever run, and nothing is run twice.
 */
export class HostProtocol {
  private readonly setup: Setup
  private readonly fetch: typeof fetch
  private readonly maxBodyBytes: number
  private readonly graceMs: number
  private readonly now: () => number
  private readonly timer: NonNullable<HostProtocolOptions['timer']>
  private readonly subscriptions: (() => void)[] = []
  private readonly streams = new Set<Duplex>()
  private readonly tracks = new Map<string, Track>()
  /** Jobs whose submit is still being checked, so two submits of one id are one job. */
  private readonly admitting = new Map<string, Promise<ComputeFailure | undefined>>()
  /** Lease id → model, for leases this host released itself. */
  private readonly released = new Map<string, string>()
  private readonly listeners = new Set<(line: string, paused: boolean) => void>()
  private session?: Session
  private held?: Held
  private grace?: { clear(): void }
  private revoking?: Promise<void>
  private queueSaid = ''
  /** The controller's name, for the tray's line. Read when the records change, not when a job does. */
  private paired?: string
  private statusSaid = ''
  private modelsSeen = ''
  private started = false
  private closed = false

  constructor(private readonly options: HostProtocolOptions) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.maxBodyBytes = options.maxBodyBytes ?? BODY_MAX_BYTES
    this.graceMs = options.graceMs ?? RECONNECT_GRACE_MS
    this.now = options.now ?? Date.now
    this.timer = options.timer ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms).unref()
      return { clear: () => clearTimeout(timer) }
    })
    this.setup = options.setup ?? new Setup({ ...options, timer: options.workerTimer ?? this.timer })
  }

  start(): void {
    if (this.started || this.closed) return
    this.started = true
    const { connect, hosts, scheduler, workers, inventory, store } = this.options
    if (store?.kvGet(CORE, PAUSED_KEY) === true) scheduler.pause(true)
    this.modelsSeen = this.installed()
    this.subscriptions.push(
      // Registering twice is harmless, so a service that binds the workers itself changes nothing.
      workers.bind(scheduler),
      scheduler.onJob((job) => { this.jobChanged(job) }),
      scheduler.onChange(() => { this.schedulerChanged() }),
      inventory.onChange((next) => { this.push({ event: 'inventory', inventory: next }) }),
      hosts.onChange(() => { this.hostsChanged() }),
    )
    connect.accept((stream, from) => { void this.accepted(stream, from) })
    this.hostsChanged()
  }

  /** The tray's pause: jobs queue and none starts; the controller sees `QueueSnapshot.paused`. */
  pause(paused: boolean): void {
    this.options.store?.kvSet(CORE, PAUSED_KEY, paused)
    this.options.scheduler.pause(paused)
    this.status()
  }

  /** Unpair from this side: `bye unpaired`, cancel every job, drop the allowlist entry, forget the record. */
  revoke(): Promise<void> {
    this.revoking ??= this.unpair().finally(() => { this.revoking = undefined })
    return this.revoking
  }

  /** One line for the tray: who is paired, and idle, working or paused. */
  onStatus(listener: (line: string, paused: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Say `bye` and stop listening. Jobs are the scheduler's to cancel, which the service does next. */
  async close(reason: ByeReason = 'quitting'): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.clearGrace()
    for (const off of this.subscriptions.splice(0)) off()
    const session = this.session
    this.session = undefined
    if (session) bow(session.stream, { event: 'bye', reason } satisfies ControlEvent)
    for (const stream of [...this.streams]) if (stream !== session?.stream) stream.destroy()
    if (this.held) this.drop(this.held)
    this.released.clear()
    this.tracks.clear()
    this.listeners.clear()
  }

  // ── streams ────────────────────────────────────────────────────────────────────────────

  /** The one controller this host is paired with, when `endpointId` is it. */
  private controller(endpointId: string): PairedHost | undefined {
    const paired = this.options.hosts.list().find((host) => host.peerRole === 'interaction')
    return paired?.endpointId === endpointId ? paired : undefined
  }

  private shut(stream: Duplex, kind: StreamKind, reason: string): void {
    this.options.log?.(`compute: closed a ${kind} stream: ${reason}`)
    stream.destroy()
  }

  private async accepted(stream: Duplex, from: { endpointId: string; kind: StreamKind }): Promise<void> {
    // A stream that breaks says so to whoever is reading it. Unheard, it would stop the process.
    stream.on('error', () => {})
    try {
      const host = this.closed ? undefined : this.controller(from.endpointId)
      if (!host) { this.shut(stream, from.kind, 'not the paired controller'); return }
      this.streams.add(stream)
      stream.once('close', () => { this.streams.delete(stream) })
      const frames = new Frames(stream)
      const deadline = this.timer(() => { this.shut(stream, from.kind, 'first frame timed out') }, HANDSHAKE_MS)
      let open: StreamOpen | undefined
      try { open = opening(await frames.next()) }
      finally { deadline.clear() }
      if (!open || open.stream !== from.kind) { this.shut(stream, from.kind, 'unexpected first frame'); return }
      if (open.stream === 'control') { await this.control(stream, frames, open.hello, host); return }
      if (this.session?.endpointId !== from.endpointId) { this.shut(stream, from.kind, 'no control session'); return }
      if (open.stream === 'infer') await this.infer(stream, frames, open)
      else if (open.stream === 'artifact') await this.artifact(stream, frames, open)
      else if ('submit' in open) await this.submitted(stream, frames, open.submit)
      else this.follow(stream, frames, open.attach, open.after ?? 0)
    } catch {
      if (!stream.destroyed) this.shut(stream, from.kind, 'the stream could not be read')
    }
  }

  // ── control ────────────────────────────────────────────────────────────────────────────

  private async control(stream: Duplex, frames: Frames, hello: Hello, host: PairedHost): Promise<void> {
    const { scheduler, hosts } = this.options
    const version = negotiate(hello.protocol)
    if (version === undefined) {
      this.options.log?.('compute: closed a control stream: incompatible version')
      bow(stream, { type: 'refused', failure: {
        code: 'incompatible-version', message: 'The paired computer runs a version of Alexia this one cannot work with.',
      } } satisfies ControlOpened)
      return
    }
    const inventory = await this.options.inventory.current()
    if (stream.destroyed || this.closed || !this.controller(host.endpointId)) { stream.destroy(); return }
    // One controller, one session: a second replaces the first, and is the reconnect the grace waits for.
    const session: Session = { stream, endpointId: host.endpointId }
    const previous = this.session
    this.session = session
    this.clearGrace()
    previous?.stream.destroy()
    const queue = scheduler.queue()
    this.queueSaid = JSON.stringify(queue)
    const at = this.now()
    // Where each job stands. One this host no longer knows was lost with a restart or the grace: never run again.
    const jobs = (hello.resume ?? []).slice(0, RESUME_MAX).map((id): JobSnapshot => scheduler.status(id) ?? {
      id, kind: 'operation', weight: 'heavy', state: 'interrupted', label: '', createdAt: at, finishedAt: at,
      failure: { code: 'interrupted', message: 'The paired computer no longer has this job.' },
    })
    this.write(session, { type: 'welcome', welcome: { protocol: version, appVersion: this.options.appVersion, name: this.options.name, inventory, queue, jobs, controllerUnpair: true } })
    hosts.touch(host.id, { name: hello.name, appVersion: hello.appVersion, lastSeenAt: at })
    this.status()
    try {
      for (;;) {
        const frame = await frames.next()
        if (frame === undefined || this.session !== session) break
        if (record(frame).event === 'bye' && record(frame).reason === 'unpaired') { await this.revoke(); break }
        void this.answer(session, frame)
      }
    } catch { /* A session that broke and one that ended are lost the same way. */ }
    this.lost(session)
  }

  /** The session is gone. Its work carries on for one grace, armed once and cleared by a reconnect. */
  private lost(session: Session): void {
    session.stream.destroy()
    if (this.session !== session) return
    this.session = undefined
    if (!this.closed && !this.grace) this.grace = this.timer(() => { this.grace = undefined; void this.expired() }, this.graceMs)
    this.status()
  }

  private clearGrace(): void {
    this.grace?.clear()
    this.grace = undefined
  }

  /** Nobody came back: what was unfinished is interrupted, and it stays that way. */
  private async expired(): Promise<void> {
    if (this.session || this.closed) return
    const failure: ComputeFailure = { code: 'interrupted', message: 'The connection to the controlling computer was lost.' }
    const cancelling = this.options.scheduler.cancelAll('interrupted', failure)
    this.letGo(failure.message)
    for (const stream of [...this.streams]) stream.destroy()
    await cancelling.catch(() => {})
  }

  private write(session: Session, message: HostFrame | ControlOpened): boolean {
    const { stream } = session
    if (stream.destroyed || stream.writableEnded) return false
    let frame: Uint8Array
    try { frame = encodeFrame(message) } catch { return false }
    // A controller that stopped reading is one that has gone, a little before the transport says so.
    if (stream.writableLength > BACKLOG_MAX_BYTES) { this.lost(session); return false }
    stream.write(frame)
    return true
  }

  private push(event: ControlEvent): void {
    if (this.session) this.write(this.session, event)
  }

  private async answer(session: Session, frame: unknown): Promise<void> {
    const { id, method, params } = record(frame)
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return
    let response: ControlResponse
    try { response = { id, ok: true, result: await this.call(method, record(params)) } as ControlResponse }
    catch (error) { response = refused(id, failureOf(error, 'The paired computer could not answer that.', method === 'models', 'refused')) }
    if (this.session !== session) return
    if (!this.write(session, response) && this.session === session) this.write(session, refused(id, { code: 'refused', message: 'That answer is too large to send.' }))
  }

  /** Every request there is. Anything else is refused: no message runs a plugin by name or reads a path. */
  private async call(method: unknown, params: Record<string, unknown>): Promise<unknown> {
    const { scheduler, inventory, artifacts } = this.options
    switch (method) {
      case 'inventory.get': return inventory.current()
      case 'queue.get': return scheduler.queue()
      case 'prepare': return this.prepare(text(params.leaseId), text(params.modelId))
      case 'release': this.release(text(params.leaseId)); return {}
      case 'job.status': {
        const job = scheduler.status(text(params.jobId))
        if (!job) throw new ComputeError('not-found', 'That compute job is not known.')
        return job
      }
      case 'job.cancel': return scheduler.cancel(text(params.jobId))
      case 'setup.install': return this.setup.install(text(params.requirementId), text(params.jobId))
      case 'models': {
        if (!isHostModelOp(params.op)) throw new ComputeError('refused', 'That model operation is not offered to a paired computer.')
        try { return await this.options.models.call(params.op, record(params.args)) }
        finally { this.modelsChanged() }
      }
      case 'artifact.ack': {
        if (!strings(params.artifactIds)) throw new ComputeError('refused', 'That request is missing something it needs.')
        await artifacts.ack(params.artifactIds)
        return {}
      }
      case 'ping': return {}
      default: throw new ComputeError('refused', 'That is not a request a compute host answers.')
    }
  }

  private installed(): string {
    try { return this.options.workers.text.models().map((model) => model.id).join('\n') } catch { return '' }
  }

  /** A picker operation may have installed or removed a model. Asked after each, and cheap: one small file. */
  private modelsChanged(): void {
    const now = this.installed()
    if (now === this.modelsSeen) return
    this.modelsSeen = now
    void this.options.inventory.refresh('models').catch(() => {})
  }

  // ── leases ─────────────────────────────────────────────────────────────────────────────

  /**
   * One model is held at a time. Leases naming it share it; a `prepare` for another model
   * releases them all. The load waits its turn in the queue like any heavy job, so other
   * workers have let go of their memory before the model asks for it.
   */
  private prepare(leaseId: string, modelId: string): Lease {
    const { scheduler, workers, inventory } = this.options
    void inventory.refresh('prepare').catch(() => {})
    const stopped = (phase: 'setup-required' | 'busy', message: string): Lease => ({ leaseId, modelId, phase, message, failure: { code: phase, message } })
    if (!workers.text.models().some((model) => model.id === modelId)) return stopped('setup-required', 'That model is not installed on the paired computer.')
    if (scheduler.queue().paused) return stopped('busy', 'The paired computer is paused.')
    if (this.held && this.held.modelId !== modelId) this.letGo('Another model was selected.')
    const held = this.held ??= fresh(modelId)
    this.released.delete(leaseId)
    const ready = held.runner !== undefined && workers.text.loaded()
    held.leases.set(leaseId, { leaseId, modelId, phase: ready ? 'ready' : 'loading', message: ready ? 'Ready.' : 'Loading the model.' })
    if (!ready && held.jobId === undefined) this.load(held)
    else if (held.jobId !== undefined) this.placed(held)
    return held.leases.get(leaseId)!
  }

  private release(leaseId: string): void {
    this.released.delete(leaseId)
    const held = this.held
    if (!held?.leases.delete(leaseId) || held.leases.size > 0) return
    // The last lease on it: the worker's idle clock starts, and the model stays until it runs out.
    this.drop(held)
  }

  /** Tell every lease on the held model where it stands, once per change. */
  private say(held: Held, phase: Lease['phase'], message: string, more: { position?: number; failure?: ComputeFailure } = {}): void {
    for (const [leaseId, was] of [...held.leases]) {
      if (was.phase === phase && was.position === more.position) continue
      const lease: Lease = { leaseId, modelId: held.modelId, phase, message, ...more }
      held.leases.set(leaseId, lease)
      this.push({ event: 'lease', lease })
    }
  }

  /** Where the load stands in the queue, while it waits. */
  private placed(held: Held): void {
    if (held.jobId === undefined) return
    const { scheduler } = this.options
    if (scheduler.status(held.jobId)?.state !== 'queued') return
    const position = queuePosition(scheduler.queue(), held.jobId)
    this.say(held, 'queued', 'Waiting for other work on the paired computer.', { ...(position !== undefined && { position }) })
  }

  private load(held: Held): void {
    const { scheduler, workers } = this.options
    const id = `prepare-${randomUUID()}`
    let admission: Admission
    try { admission = scheduler.submit({ id, kind: 'chat', weight: 'heavy', label: held.modelId, worker: TEXT_WORKER }) }
    catch (error) { this.failed(held, error); return }
    held.jobId = id
    this.placed(held)
    void (async () => {
      try {
        await admission.turn
        // An answer that could not wait for this turn may have loaded it already.
        if (!held.runner || !workers.text.loaded()) await this.loadHere(held, admission.signal)
        else this.say(held, 'ready', 'Ready.')
        admission.finish({ state: 'succeeded' })
        if (held.jobId === id) held.jobId = undefined
      } catch (error) {
        const stopped = admission.signal.aborted || held.dropped
        admission.finish(stopped ? { state: 'cancelled' } : { state: 'failed', failure: failureOf(error, 'The model could not be loaded.', true) })
        if (held.jobId === id) held.jobId = undefined
        if (held.dropped) return
        if (!stopped) this.failed(held, error)
        else if (this.held === held) this.letGo('Loading the model was cancelled.')
      }
    })()
  }

  /** Load the held model now. Only ever inside a heavy job's turn, so nothing else holds the memory. */
  private async loadHere(held: Held, signal: AbortSignal): Promise<void> {
    const { scheduler, workers } = this.options
    this.say(held, 'loading', 'Loading the model.')
    held.unhold?.()
    held.unhold = undefined
    held.runner?.release()
    held.runner = undefined
    const runner = await workers.text.acquire(held.modelId, signal)
    if (held.dropped) {
      runner.release()
      throw new ComputeError('cancelled', 'The model is no longer selected.')
    }
    held.runner = runner
    held.unhold = scheduler.hold(TEXT_WORKER)
    this.say(held, 'ready', 'Ready.')
  }

  /** The held model for one answer, loading it again in place when the idle stop released it. */
  private async selected(leaseId: string, signal: AbortSignal): Promise<Held> {
    let held = this.held
    if (!held?.leases.has(leaseId)) {
      const modelId = this.released.get(leaseId)
      if (modelId === undefined) throw new ComputeError('refused', 'That model is no longer selected on the paired computer.')
      if (held && held.modelId !== modelId) this.letGo('Another model was selected.')
      held = this.held ??= fresh(modelId)
      this.released.delete(leaseId)
      held.leases.set(leaseId, { leaseId, modelId, phase: 'loading', message: 'Loading the model.' })
    }
    if (!held.runner || !this.options.workers.text.loaded()) {
      try { await this.loadHere(held, signal) }
      catch (error) {
        if (!signal.aborted) this.failed(held, error)
        throw error
      }
    }
    return held
  }

  /** The load failed: every lease on it says why, and none of them is remembered. */
  private failed(held: Held, error: unknown): void {
    if (held.dropped) return
    const failure = failureOf(error, 'The model could not be loaded.', true)
    this.say(held, failure.code === 'setup-required' || failure.code === 'busy' ? failure.code : 'worker-failure', failure.message, { failure })
    this.drop(held)
  }

  /** Release every lease on the held model, remembering them: an answer naming one loads the model again. */
  private letGo(message: string): void {
    const held = this.held
    if (!held) return
    this.held = undefined
    this.say(held, 'released', message)
    for (const leaseId of held.leases.keys()) {
      this.released.delete(leaseId)
      this.released.set(leaseId, held.modelId)
    }
    while (this.released.size > RELEASED_MAX) this.released.delete(this.released.keys().next().value!)
    this.drop(held)
  }

  private drop(held: Held): void {
    held.dropped = true
    if (this.held === held) this.held = undefined
    const loading = held.jobId
    held.jobId = undefined
    if (loading !== undefined) { try { this.options.scheduler.cancel(loading) } catch { /* already forgotten */ } }
    held.unhold?.()
    held.unhold = undefined
    if (held.answering === 0) {
      held.runner?.release()
      held.runner = undefined
    }
  }

  // ── infer ──────────────────────────────────────────────────────────────────────────────

  private async infer(stream: Duplex, frames: Frames, open: InferOpen): Promise<void> {
    const { scheduler, inventory } = this.options
    const refuse = (failure: ComputeFailure): void => { bow(stream, { type: 'refused', failure } satisfies InferHead) }
    if (open.bodyBytes > this.maxBodyBytes) { refuse({ code: 'refused', message: 'That request is too large for the paired computer.' }); return }
    const modelId = this.held?.leases.get(open.leaseId)?.modelId ?? this.released.get(open.leaseId)
    if (modelId === undefined) { refuse({ code: 'refused', message: 'That model is no longer selected on the paired computer.' }); return }
    if (scheduler.queue().paused) { refuse({ code: 'busy', message: 'The paired computer is paused.' }); return }
    if (scheduler.status(open.jobId)) { refuse({ code: 'refused', message: 'That request has already been made.' }); return }

    const chunks: Uint8Array[] = []
    let got = 0
    for await (const chunk of exactly(frames, open.bodyBytes)) { chunks.push(chunk); got += chunk.length }
    if (got !== open.bodyBytes) { stream.destroy(); return }
    const body = Buffer.concat(chunks)

    // The answer has nowhere to go once its stream has: closing it is the cancellation.
    const abort = new AbortController()
    let settled = false
    const gone = (): void => {
      // Closed with the whole answer written is the end of an answer, not somebody giving up on one.
      if (settled || stream.writableFinished) return
      abort.abort()
      try { scheduler.cancel(open.jobId) } catch { /* not admitted yet, or already forgotten */ }
    }
    stream.once('close', gone)
    if (stream.destroyed) return
    let admission: Admission
    try { admission = scheduler.submit({ id: open.jobId, kind: 'chat', weight: 'heavy', label: modelId, worker: TEXT_WORKER }) }
    catch (error) {
      stream.off('close', gone)
      refuse(failureOf(error, 'The paired computer could not take that request.'))
      return
    }
    const signal = AbortSignal.any([abort.signal, admission.signal])
    let headed = false
    let held: Held | undefined
    try {
      await admission.turn
      void inventory.refresh('admission').catch(() => {})
      held = await this.selected(open.leaseId, signal)
      held.answering++
      const runner = held.runner!
      const response = await this.fetch(`${runner.baseUrl}/chat/completions`, {
        method: 'POST', body, signal,
        headers: { 'content-type': 'application/json', ...(runner.key !== '' && { authorization: `Bearer ${runner.key}` }) },
      })
      await send(stream, encodeFrame({ type: 'head', status: response.status, contentType: response.headers.get('content-type') ?? 'application/octet-stream' } satisfies InferHead))
      headed = true
      // The engine's bytes exactly as it wrote them: nothing here reads, buffers or reframes an answer.
      if (response.body) await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), stream, { signal })
      else stream.end()
      settled = true
      admission.finish({ state: 'succeeded' })
      stream.on('data', () => {})
    } catch (error) {
      settled = true
      const stopped = signal.aborted || stream.destroyed
      const failure = failureOf(error, 'The model on the paired computer could not answer.', true)
      admission.finish(stopped ? { state: 'cancelled' } : { state: 'failed', failure })
      // A head already sent promised bytes that will not come: a broken stream says so, a second frame could not.
      if (headed || stopped) stream.destroy()
      else refuse(failure)
    } finally {
      stream.off('close', gone)
      if (held) {
        held.answering--
        if (held.dropped && held.answering === 0) { held.runner?.release(); held.runner = undefined }
      }
    }
  }

  // ── jobs ───────────────────────────────────────────────────────────────────────────────

  /** Every job the scheduler knows says what happens to it here, whoever is listening. */
  private jobChanged(job: JobSnapshot): void {
    this.push({ event: 'job', job })
    let track = this.tracks.get(job.id)
    if (!track) {
      const { scheduler } = this.options
      for (const id of [...this.tracks.keys()]) if (!scheduler.status(id)) this.tracks.delete(id)
      track = { seq: 0, events: [], done: false, listeners: new Set() }
      this.tracks.set(job.id, track)
    }
    if (track.done) return
    if (finished(job.state)) this.tell(track, (seq) => ({ type: 'done', seq, job }))
    else if (track.state === job.state && job.progress) {
      const progress = job.progress
      this.tell(track, (seq) => ({ type: 'progress', seq, progress }))
    } else this.tell(track, (seq) => ({ type: 'state', seq, job }))
    track.state = job.state
  }

  /** One more event of a job. `seq` only ever rises; what is kept is what a late attach is owed. */
  private tell(track: Track, make: (seq: number) => JobEvent, keep = true): void {
    const event = make(++track.seq)
    if (event.type === 'done') track.done = true
    if (keep) {
      // Only the latest progress is worth telling somebody who was not there for the rest.
      if (event.type === 'progress' && track.events.at(-1)?.type === 'progress') track.events[track.events.length - 1] = event
      else track.events.push(event)
      if (track.events.length > EVENTS_MAX) track.events.shift()
    }
    for (const listener of [...track.listeners]) listener(event)
  }

  private output(jobId: string, output: JobOutput): void {
    const track = this.tracks.get(jobId)
    if (!track || track.done) return
    if (output.type === 'preview') {
      // A picture of work in progress is shown and never stored.
      if (typeof output.data === 'string' && output.data.length <= PREVIEW_MAX_CHARS) this.tell(track, (seq) => ({ type: 'output', seq, output }), false)
    } else if (output.type === 'text') {
      for (let at = 0; at < output.text.length; at += TEXT_CHUNK_CHARS) {
        const part = output.text.slice(at, at + TEXT_CHUNK_CHARS)
        this.tell(track, (seq) => ({ type: 'output', seq, output: { type: 'text', text: part } }))
      }
    } else this.tell(track, (seq) => ({ type: 'output', seq, output }))
  }

  private async submitted(stream: Duplex, frames: Frames, submit: JobSubmit): Promise<void> {
    const { scheduler } = this.options
    // Idempotent on the job id: a job this host already has is followed, never started again.
    if (!scheduler.status(submit.jobId)) {
      let admitting = this.admitting.get(submit.jobId)
      if (!admitting) {
        admitting = this.admit(stream, submit).finally(() => { this.admitting.delete(submit.jobId) })
        this.admitting.set(submit.jobId, admitting)
      }
      const failure = await admitting
      if (failure) {
        const at = this.now()
        bow(stream, { type: 'done', seq: 1, job: {
          id: submit.jobId, kind: 'operation', weight: 'heavy', state: 'failed', label: submit.cap, createdAt: at, finishedAt: at, failure,
        } } satisfies JobEvent)
        return
      }
    }
    this.follow(stream, frames, submit.jobId, 0)
  }

  /** Check one submit and queue it. Only a declared operation of an installed worker ever passes. */
  private async admit(stream: Duplex, submit: JobSubmit): Promise<ComputeFailure | undefined> {
    const { scheduler, workers, artifacts, inventory } = this.options
    const { jobId, cap } = submit
    const inputs = submit.inputs ?? []
    try {
      const worker = await workers.forCapability(cap)
      const offered = (await worker?.capabilities())?.find((one) => one.cap === cap)
      if (!worker || !offered) throw new ComputeError('setup-required', 'That capability is not installed on the paired computer.')
      if ((await inventory.current()).capabilities.find((one) => one.cap === cap)?.ready === false) {
        throw new ComputeError('setup-required', 'The paired computer needs setup before it can run that.')
      }
      // Whoever submitted it has gone, or been unpaired, while this was checked: it was never started.
      if (this.closed || stream.destroyed) throw new ComputeError('cancelled', 'The compute job was not started.')
      artifacts.claimed(jobId)
      // Inputs become paths here and nowhere else, and only this job's own inputs resolve at all.
      artifacts.resolve(jobId, { inputs: inputs.map((id) => ({ [ARTIFACT_ARG]: id })) })
      const args = artifacts.resolve(jobId, submit.arguments ?? {})
      const admission = scheduler.submit({ id: jobId, kind: 'operation', weight: offered.weight, label: cap, worker: worker.id })
      void this.operate(admission, jobId, worker, cap, args, inputs)
      return undefined
    } catch (error) {
      void artifacts.sweep().catch(() => {})
      return failureOf(error, 'The paired computer could not take that job.')
    }
  }

  /** Admit, prepare, run, adopt (§4.4): the worker's `run` prepares itself, and paths end here. */
  private async operate(admission: Admission, jobId: string, worker: ComputeWorker, cap: string, args: Record<string, unknown>, inputs: string[]): Promise<void> {
    const { artifacts, inventory } = this.options
    try {
      await admission.turn
      // Another job's cleanup may have removed this one's empty folder while it waited.
      artifacts.claimed(jobId)
      void inventory.refresh('admission').catch(() => {})
      const result = await runWorker(worker, admission.signal, () => worker.run(cap, args, {
        signal: admission.signal, dir: artifacts.jobDir(jobId),
        progress: (progress) => { admission.progress(progress) },
        output: (output) => { this.output(jobId, output) },
      }), this.options.workerTimer ?? this.timer)
      admission.signal.throwIfAborted()
      const made: ArtifactRef[] = []
      for (const file of result.files) made.push(await artifacts.adopt(jobId, file, { name: basename(file) }))
      if (result.text) this.output(jobId, { type: 'text', text: result.text })
      admission.finish({ state: 'succeeded', artifacts: made })
    } catch (error) {
      admission.finish(admission.signal.aborted ? { state: 'cancelled' } : { state: 'failed', failure: failureOf(error, 'The compute worker failed.', true) })
    } finally {
      // The job has read its inputs. What it made waits to be fetched; everything else goes.
      await artifacts.ack(inputs).catch(() => {})
      await artifacts.sweep().catch(() => {})
    }
  }

  /** Write a job's events from `after` until its last. The stream closing ends the listening, not the job. */
  private follow(stream: Duplex, frames: Frames, jobId: string, after: number): void {
    const { scheduler } = this.options
    const track = this.tracks.get(jobId)
    if (!track || !scheduler.status(jobId)) {
      this.tracks.delete(jobId)
      bow(stream)
      return
    }
    const write = (event: JobEvent): void => {
      if (stream.destroyed || stream.writableEnded) return
      if (stream.writableLength > BACKLOG_MAX_BYTES) { stream.destroy(); return }
      try { stream.write(encodeFrame(event)) } catch { return }
      if (event.type === 'done') {
        track.listeners.delete(write)
        stream.end()
      }
    }
    for (const event of [...track.events]) if (event.seq > after) write(event)
    if (!track.done) {
      track.listeners.add(write)
      stream.once('close', () => { track.listeners.delete(write) })
    }
    void (async () => {
      try {
        for (;;) {
          const frame = await frames.next()
          if (frame === undefined) return
          // The one thing a controller may say on a job stream.
          if (record(frame).type === 'cancel') { try { scheduler.cancel(jobId) } catch { /* already forgotten */ } }
        }
      } catch { /* The stream broke. The job did not. */ }
    })()
  }

  // ── artifacts ──────────────────────────────────────────────────────────────────────────

  private async artifact(stream: Duplex, frames: Frames, open: ArtifactOpen): Promise<void> {
    const { artifacts } = this.options
    if ('put' in open) {
      const put = open.put as ArtifactPut
      let result: ArtifactPutResult
      try { result = { type: 'stored', artifact: await artifacts.put(put, Readable.from(exactly(frames, put.bytes), { objectMode: false })) } }
      catch (error) { result = { type: 'refused', failure: failureOf(error, 'The paired computer could not store that file.') } }
      bow(stream, result)
      return
    }
    const offset = open.offset ?? 0
    let found: ReturnType<Artifacts['open']>
    try { found = artifacts.open(open.get, offset) }
    catch (error) {
      bow(stream, { type: 'refused', failure: failureOf(error, 'That file is not available.') } satisfies ArtifactHead)
      return
    }
    try {
      await send(stream, encodeFrame({ type: 'head', artifact: found.artifact, offset } satisfies ArtifactHead))
      // The stream ends after the last byte: that end is how the controller knows it has them all.
      await pipeline(found.bytes, stream)
      stream.on('data', () => {})
    } catch {
      found.bytes.destroy()
      stream.destroy()
    }
  }

  // ── what changes around it ─────────────────────────────────────────────────────────────

  private schedulerChanged(): void {
    const { scheduler, workers } = this.options
    const queue = scheduler.queue()
    const said = JSON.stringify(queue)
    if (said !== this.queueSaid) {
      this.queueSaid = said
      this.push({ event: 'queue', queue })
    }
    const held = this.held
    if (held?.jobId !== undefined) this.placed(held)
    // The idle stop, or another backend's turn, took the model out of memory: the leases go with it.
    else if (held?.runner && held.answering === 0 && !workers.text.loaded()) this.letGo('The model was released on the paired computer.')
    this.status()
  }

  /** The record went without `revoke` being asked: it is the same thing, and nothing is left running for nobody. */
  private hostsChanged(): void {
    this.paired = this.options.hosts.list().find((host) => host.peerRole === 'interaction')?.name
    if (!this.revoking && !this.closed && this.session && !this.controller(this.session.endpointId)) void this.revoke()
    this.status()
  }

  private async unpair(): Promise<void> {
    const { connect, hosts, scheduler } = this.options
    const session = this.session
    this.session = undefined
    this.clearGrace()
    if (session) bow(session.stream, { event: 'bye', reason: 'unpaired' } satisfies ControlEvent)
    const failure: ComputeFailure = { code: 'unpaired', message: 'The paired computer was unpaired.' }
    const cancelling = scheduler.cancelAll('cancelled', failure)
    if (this.held) {
      this.say(this.held, 'released', failure.message)
      this.drop(this.held)
    }
    this.released.clear()
    for (const stream of [...this.streams]) stream.destroy()
    for (const host of hosts.list()) hosts.remove(host.id)
    // Replacing the allowlist is what closes the connection itself, before this resolves.
    await Promise.allSettled([connect.allow(hosts.allowlist()), cancelling])
    this.hostsChanged()
  }

  private status(): void {
    const { scheduler } = this.options
    const paused = scheduler.queue().paused
    const line = this.paired !== undefined ? `Paired with ${this.paired} · ${paused ? 'Paused' : scheduler.idle() ? 'Idle' : 'Working'}` : 'Not paired'
    const said = `${line}\n${paused}`
    if (said === this.statusSaid) return
    this.statusSaid = said
    for (const listener of [...this.listeners]) { try { listener(line, paused) } catch { /* A listener cannot stop the others hearing. */ } }
  }
}
