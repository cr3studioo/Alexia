// SPDX-License-Identifier: AGPL-3.0-only
import type { Duplex, Readable, Writable } from 'node:stream'
import { readConnectHints, setPeerHints, type Connect, type ConnectHints } from './connect.js'
import type { Hosts } from './hosts.js'
import {
  encodeFrame, isControlEvent, negotiate, SPEAKS, splitFrame,
  type ControlCalls, type ControlEvent, type ControlMethod, type ControllerBye, type Hello, type HostFrame, type StreamOpen, type Welcome,
} from './protocol.js'
import {
  COMPUTE_ERRORS, ComputeError,
  type ComputeErrorCode, type ComputeFailure, type HostInventory, type HostView, type PairedHost, type QueueSnapshot,
} from './types.js'

/** How long a host has to answer a `Hello` before the attempt is called offline. */
export const HANDSHAKE_MS = 20_000
/** The waits between reconnection attempts; after the last of them, every {@link RETRY_MS}. */
export const RETRY_BACKOFF_MS = [1000, 2000, 4000] as const
export const RETRY_MS = 5000

const broken = (): ComputeError => new ComputeError('interrupted', 'The compute stream was interrupted.')
const cancelled = (): ComputeError => new ComputeError('cancelled', 'The compute request was cancelled.')
const sessionLost = (): ComputeError => new ComputeError('offline', 'The connection to that computer was lost.')
const unpaired = (): ComputeError => new ComputeError('unpaired', 'That computer is not paired.')
const unreadable = (): ComputeError => new ComputeError('incompatible-version', 'That computer sent something this version of Alexia cannot read.')

/** Whatever broke a stream, as the error the rest of compute speaks. */
export const streamError = (error: unknown): ComputeError => error instanceof ComputeError ? error : broken()

/** A failure off the wire, with a code this build knows. Anything else is a refusal with no more to say. */
export function failureOf(value: unknown): ComputeFailure {
  const { code, message } = (typeof value === 'object' && value !== null ? value : {}) as Partial<ComputeFailure>
  return (COMPUTE_ERRORS as readonly unknown[]).includes(code) && typeof message === 'string'
    ? { code: code as ComputeErrorCode, message }
    : { code: 'refused', message: 'That computer refused the request.' }
}

/**
 * **A stream's bytes, read as frames and then as whatever follows them.** Pulled, never
 * pushed: nothing is taken off the stream until somebody asks, so a reader that stops asking
 * is the far side's writer slowing down.
 */
export class Frames {
  private buffer: Uint8Array = new Uint8Array(0)

  constructor(private readonly stream: Readable) {}

  /** The next frame, or undefined once the far side has finished cleanly. Rejects when the stream breaks. */
  async next(): Promise<unknown> {
    for (;;) {
      let split: ReturnType<typeof splitFrame>
      try { split = splitFrame(this.buffer) } catch { throw unreadable() }
      if (split) { this.buffer = split.rest; return split.frame }
      const chunk = await this.pull()
      if (!chunk) {
        if (this.buffer.length > 0) throw broken()
        return undefined
      }
      this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk
    }
  }

  /** The raw bytes after the last frame read: an answer's, or a file's. Ends when the far side does. */
  async *bytes(): AsyncGenerator<Uint8Array, void, void> {
    if (this.buffer.length > 0) {
      const held = this.buffer
      this.buffer = new Uint8Array(0)
      yield held
    }
    for (;;) {
      const chunk = await this.pull()
      if (!chunk) return
      yield chunk
    }
  }

  private pull(): Promise<Buffer | undefined> {
    const stream = this.stream
    return new Promise((resolve, reject) => {
      const take = (): boolean => {
        const chunk = stream.read() as Buffer | null
        if (chunk !== null) resolve(chunk)
        else if (stream.readableEnded) resolve(undefined)
        else if (stream.destroyed) reject(streamError(stream.errored))
        else return false
        return true
      }
      if (take()) return
      const stop = (): void => {
        stream.off('readable', readable)
        stream.off('end', end)
        stream.off('error', error)
        stream.off('close', close)
      }
      const readable = (): void => { if (take()) stop() }
      const end = (): void => { stop(); resolve(undefined) }
      const error = (cause: unknown): void => { stop(); reject(streamError(cause)) }
      const close = (): void => { stop(); if (stream.readableEnded) resolve(undefined); else reject(broken()) }
      stream.on('readable', readable)
      stream.on('end', end)
      stream.on('error', error)
      stream.on('close', close)
    })
  }
}

/** Write, and wait until the stream has taken it. A stream that is gone is a rejection, never a hang. */
export function send(stream: Writable, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (stream.destroyed || stream.writableEnded) { reject(streamError(stream.errored)); return }
    stream.write(bytes, (error) => { if (error) reject(streamError(error)); else resolve() })
  })
}

export interface ControllerOptions {
  connect: Connect
  hosts: Hosts
  name: string
  appVersion: string
  /** Jobs to name in `Hello.resume`: what `RemoteJobs` still wants the outcome of. */
  resume?(hostId: string): string[]
  /**
   * Where a paired host's address hints live between launches. They only help find an
   * identity that is already allowed, so a stale or missing one costs a slower connection.
   */
  hints?: { load(hostId: string): ConnectHints | undefined; save(hostId: string, hints: ConnectHints): void }
  now?(): number
  timer?(fn: () => void, ms: number): { clear(): void }
}

interface Waiting {
  resolve(result: unknown): void
  reject(error: ComputeError): void
}
interface Session {
  hostId: string
  /** The open control stream. Absent is no session, which is not by itself a failure. */
  stream?: Duplex
  opening?: Promise<void>
  abort?: AbortController
  pending: Map<number, Waiting>
  nextId: number
  inventory?: HostInventory
  queue?: QueueSnapshot
  /** Why the last attempt to open a session failed, or what the host said when it ended one. */
  failure?: ComputeFailure
  retry?: { clear(): void }
  attempt: number
  dropped: boolean
  controllerUnpair?: boolean
}

/** Asking again changes neither of these: one needs a new pairing, the other a new version. */
const final = (failure: ComputeFailure | undefined): boolean => failure?.code === 'unpaired' || failure?.code === 'incompatible-version'

/** The host's first frame on a control stream, as a session or as the reason there is none. */
function accepted(frame: unknown): Welcome {
  if (frame === undefined) throw new ComputeError('offline', 'That computer closed the connection.')
  if (typeof frame !== 'object' || frame === null) throw unreadable()
  const opened = frame as { type?: unknown; welcome?: Partial<Welcome>; failure?: unknown }
  if (opened.type === 'refused') {
    const failure = failureOf(opened.failure)
    throw new ComputeError(failure.code, failure.message)
  }
  const welcome = opened.welcome
  if (opened.type !== 'welcome' || typeof welcome !== 'object' || welcome === null || typeof welcome.protocol !== 'number' ||
    typeof welcome.inventory !== 'object' || welcome.inventory === null || typeof welcome.queue !== 'object' || welcome.queue === null) throw unreadable()
  if (negotiate({ min: welcome.protocol, max: welcome.protocol }) === undefined) {
    throw new ComputeError('incompatible-version', 'That computer runs a version of Alexia this one cannot work with.')
  }
  return welcome as Welcome
}

/**
 * **The interaction computer's sessions with its paired hosts**: one control stream per host,
 * opened when something needs it, and what that host last said about itself.
 *
 * It reports and it reconnects; it decides nothing about work. A reconnect is a fresh `Hello`
 * naming the jobs whose outcome is still wanted — never a submit, so nothing a host lost is
 * ever run again on its behalf. A host that cannot be reached stays in {@link views} with
 * its last inventory and the reason, and no failure here removes a pairing: an unreachable
 * host and one that has forgotten this computer can look the same from this side.
 */
export class Controller {
  private readonly connect: Connect
  private readonly hosts: Hosts
  private readonly sessions = new Map<string, Session>()
  private readonly changes = new Set<(hostId: string) => void>()
  private readonly events = new Set<(hostId: string, event: ControlEvent) => void>()
  private readonly subscriptions: (() => void)[]
  private readonly now: () => number
  private readonly timer: NonNullable<ControllerOptions['timer']>
  private closed = false

  constructor(private readonly options: ControllerOptions) {
    this.connect = options.connect
    this.hosts = options.hosts
    this.now = options.now ?? Date.now
    this.timer = options.timer ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms).unref()
      return { clear: () => clearTimeout(timer) }
    })
    this.subscriptions = [
      this.connect.onState((endpointId, state) => { this.reached(endpointId, state !== 'offline') }),
      // An unpaired host has no session to keep, and nothing left to wait for.
      this.hosts.onChange(() => { for (const hostId of [...this.sessions.keys()]) if (!this.hosts.get(hostId)) void this.drop(hostId) }),
    ]
  }

  views(): HostView[] {
    return this.hosts.list().map((host) => this.viewOf(host))
  }

  view(hostId: string): HostView | undefined {
    const host = this.hosts.get(hostId)
    return host && this.viewOf(host)
  }

  /** The host's queue as it last described it. Undefined until a session has heard one. */
  queue(hostId: string): QueueSnapshot | undefined {
    return this.sessions.get(hostId)?.queue
  }

  onChange(listener: (hostId: string) => void): () => void {
    this.changes.add(listener)
    return () => { this.changes.delete(listener) }
  }

  /**
   * Everything a host says unasked. A `welcome` is heard here too, as the `inventory`, `queue`
   * and `job` events it amounts to, so a listener learns where resumed jobs stand the same way
   * it learns anything else.
   */
  onEvent(listener: (hostId: string, event: ControlEvent) => void): () => void {
    this.events.add(listener)
    return () => { this.events.delete(listener) }
  }

  async ensure(hostId: string, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw sessionLost()
    const host = this.hosts.get(hostId)
    if (!host) throw unpaired()
    if (signal?.aborted) throw cancelled()
    const session = this.session(hostId)
    // A stream that has been destroyed is a session already lost, a tick before its reader hears so.
    if (session.stream?.destroyed) this.lost(session, session.stream)
    if (session.stream) return
    if (!session.opening) {
      const opening = this.open(session, host)
      session.opening = opening
      const settled = (): void => { if (session.opening === opening) session.opening = undefined }
      opening.then(settled, () => { settled(); this.schedule(session) })
    }
    await abortable(session.opening, signal)
  }

  async call<M extends ControlMethod>(hostId: string, method: M, params: ControlCalls[M]['params'], signal?: AbortSignal): Promise<ControlCalls[M]['result']> {
    await this.ensure(hostId, signal)
    const session = this.sessions.get(hostId)
    const stream = session?.stream
    if (!session || !stream) throw sessionLost()
    const id = session.nextId++
    let frame: Uint8Array
    try { frame = encodeFrame({ id, method, params }) } catch { throw new ComputeError('refused', 'That request is too large to send.') }
    return new Promise<ControlCalls[M]['result']>((resolve, reject) => {
      const abort = (): void => { settle(); reject(cancelled()) }
      const settle = (): void => { session.pending.delete(id); signal?.removeEventListener('abort', abort) }
      session.pending.set(id, {
        resolve: (result) => { settle(); resolve(result as ControlCalls[M]['result']) },
        reject: (error) => { settle(); reject(error) },
      })
      signal?.addEventListener('abort', abort, { once: true })
      stream.write(frame, (error) => { if (error) session.pending.get(id)?.reject(sessionLost()) })
    })
  }

  async stream(hostId: string, open: Exclude<StreamOpen, { stream: 'control' }>, signal?: AbortSignal): Promise<Duplex> {
    // A host refuses every other stream while no control session from this computer is open.
    await this.ensure(hostId, signal)
    const host = this.hosts.get(hostId)
    if (!host) throw unpaired()
    let frame: Uint8Array
    try { frame = encodeFrame(open) } catch { throw new ComputeError('refused', 'That request is too large to send.') }
    let stream: Duplex
    try { stream = await this.connect.open(host.endpointId, open.stream, signal) } catch (error) { throw error instanceof ComputeError ? error : sessionLost() }
    try { await send(stream, frame) } catch (error) {
      stream.destroy()
      throw streamError(error)
    }
    return stream
  }

  /** Tell a reachable host to forget this controller, then stop the session and its retries. */
  async unpair(hostId: string): Promise<void> {
    try {
      if (this.view(hostId)?.connection !== 'offline') {
        await this.ensure(hostId)
        const session = this.sessions.get(hostId)
        if (session?.controllerUnpair && session.stream) await send(session.stream, encodeFrame({ event: 'bye', reason: 'unpaired' } satisfies ControllerBye))
      }
    } catch { /* An unreachable host keeps its record until unpaired there. */ }
    finally { await this.drop(hostId) }
  }

  async drop(hostId: string): Promise<void> {
    const session = this.sessions.get(hostId)
    if (!session) return
    this.sessions.delete(hostId)
    session.dropped = true
    session.retry?.clear()
    session.retry = undefined
    session.abort?.abort()
    const stream = session.stream
    session.stream = undefined
    stream?.destroy()
    for (const waiting of [...session.pending.values()]) waiting.reject(sessionLost())
    this.changed(hostId)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const off of this.subscriptions) off()
    for (const hostId of [...this.sessions.keys()]) await this.drop(hostId)
    this.changes.clear()
    this.events.clear()
  }

  private viewOf(host: PairedHost): HostView {
    const session = this.sessions.get(host.id)
    const connection = this.connect.state(host.endpointId)
    const failure = final(session?.failure) ? session?.failure
      : session?.stream ? undefined
      : connection === 'offline' ? { code: 'offline' as const, message: 'That computer cannot be reached right now.' }
      : session?.failure
    return { host, connection, ...(failure && { failure }), ...(session?.inventory && { inventory: session.inventory }) }
  }

  private session(hostId: string): Session {
    let session = this.sessions.get(hostId)
    if (!session) {
      session = { hostId, pending: new Map(), nextId: 1, attempt: 0, dropped: false }
      this.sessions.set(hostId, session)
    }
    return session
  }

  /** One attempt: a stream, a `Hello` with what is still wanted, and the host's answer. */
  private async open(session: Session, host: PairedHost): Promise<void> {
    session.retry?.clear()
    session.retry = undefined
    const abort = new AbortController()
    session.abort = abort
    let slow = false
    const deadline = this.timer(() => { slow = true; abort.abort() }, HANDSHAKE_MS)
    let stream: Duplex | undefined
    try {
      await this.supplyHints(host)
      stream = await this.connect.open(host.endpointId, 'control', abort.signal)
      const frames = new Frames(stream)
      const resume = this.options.resume?.(session.hostId) ?? []
      const hello: Hello = { protocol: SPEAKS, appVersion: this.options.appVersion, name: this.options.name, ...(resume.length > 0 && { resume }) }
      await send(stream, encodeFrame({ stream: 'control', hello } satisfies StreamOpen))
      const welcome = accepted(await frames.next())
      if (session.dropped || this.closed) throw cancelled()
      session.stream = stream
      session.failure = undefined
      session.attempt = 0
      session.inventory = welcome.inventory
      session.queue = welcome.queue
      session.controllerUnpair = welcome.controllerUnpair === true
      void this.listen(session, stream, frames)
      this.hosts.touch(host.id, { name: welcome.name, appVersion: welcome.appVersion, platform: welcome.inventory.machine?.platform, lastSeenAt: this.now() })
      void this.keepHints(host)
      this.changed(session.hostId)
      this.emit(session.hostId, { event: 'inventory', inventory: welcome.inventory })
      this.emit(session.hostId, { event: 'queue', queue: welcome.queue })
      for (const job of Array.isArray(welcome.jobs) ? welcome.jobs : []) this.emit(session.hostId, { event: 'job', job })
    } catch (error) {
      stream?.destroy()
      if (session.dropped || this.closed) throw cancelled()
      // A stream that opens and then dies before the host answers is a host that could not
      // be reached: the far side's allowlist turning this computer away looks exactly so.
      const failure: ComputeFailure = slow || !(error instanceof ComputeError) || error.code === 'interrupted' || error.code === 'cancelled'
        ? { code: 'offline', message: 'That computer cannot be reached right now.' }
        : error.failure()
      const was = session.failure?.code
      session.failure = failure
      if (was !== failure.code) this.changed(session.hostId)
      throw new ComputeError(failure.code, failure.message)
    } finally {
      deadline.clear()
      if (session.abort === abort) session.abort = undefined
    }
  }

  private async listen(session: Session, stream: Duplex, frames: Frames): Promise<void> {
    try {
      for (;;) {
        const frame = await frames.next()
        if (frame === undefined || session.stream !== stream) break
        this.heard(session, stream, frame)
      }
    } catch { /* A session that broke and one that ended are lost the same way. */ }
    this.lost(session, stream)
  }

  private heard(session: Session, stream: Duplex, frame: unknown): void {
    if (typeof frame !== 'object' || frame === null) return
    const said = frame as HostFrame
    if (!isControlEvent(said)) {
      const waiting = session.pending.get(said.id)
      if (!waiting) return
      if (said.ok) waiting.resolve(said.result)
      else {
        const failure = failureOf(said.failure)
        waiting.reject(new ComputeError(failure.code, failure.message))
      }
      return
    }
    if (said.event === 'inventory') {
      session.inventory = said.inventory
      this.changed(session.hostId)
    } else if (said.event === 'queue') session.queue = said.queue
    this.emit(session.hostId, said)
    if (said.event === 'bye') {
      // `unpaired` is final: the record stays, as the reason shown, and nothing asks again.
      if (said.reason === 'unpaired') session.failure = { code: 'unpaired', message: 'That computer is no longer paired with this one.' }
      this.lost(session, stream)
    }
  }

  private lost(session: Session, stream: Duplex): void {
    if (session.stream !== stream) return
    session.stream = undefined
    stream.destroy()
    for (const waiting of [...session.pending.values()]) waiting.reject(sessionLost())
    this.changed(session.hostId)
    this.schedule(session)
  }

  /** Arm one retry, and only while a job's outcome is still wanted from that host. */
  private schedule(session: Session): void {
    if (this.closed || session.dropped || session.retry || session.stream || session.opening || final(session.failure)) return
    if (!this.hosts.get(session.hostId) || !this.wanted(session.hostId)) return
    // Only a retry that was waited for moves the backoff on: an attempt somebody asked for
    // in between is theirs, and leaves the next wait as long as it was.
    session.retry = this.timer(() => {
      session.retry = undefined
      session.attempt++
      if (this.wanted(session.hostId)) this.ensure(session.hostId).catch(() => {})
    }, RETRY_BACKOFF_MS[session.attempt] ?? RETRY_MS)
  }

  private wanted(hostId: string): boolean {
    return (this.options.resume?.(hostId) ?? []).length > 0
  }

  /** The transport found the host again, or lost it. Found is the moment to stop waiting out a backoff. */
  private reached(endpointId: string, reachable: boolean): void {
    const host = this.hosts.byEndpoint(endpointId)
    if (!host) return
    const session = this.sessions.get(host.id)
    if (reachable && session?.failure?.code === 'offline') session.failure = undefined
    this.changed(host.id)
    if (!reachable || !session || session.stream || session.opening || final(session.failure) || !this.wanted(host.id)) return
    session.attempt = 0
    this.ensure(host.id).catch(() => {})
  }

  private async supplyHints(host: PairedHost): Promise<void> {
    const hints = this.options.hints?.load(host.id)
    if (hints) await setPeerHints(this.connect, host.endpointId, hints).catch(() => {})
  }

  private async keepHints(host: PairedHost): Promise<void> {
    if (!this.options.hints) return
    try { this.options.hints.save(host.id, await readConnectHints(this.connect, host.endpointId)) } catch { /* none learned yet */ }
  }

  private changed(hostId: string): void {
    for (const listener of [...this.changes]) listener(hostId)
  }

  private emit(hostId: string, event: ControlEvent): void {
    for (const listener of [...this.events]) listener(hostId, event)
  }
}

/** A shared attempt, given up on by one caller without being stopped for the others. */
function abortable(work: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return work
  return new Promise((resolve, reject) => {
    const abort = (): void => { reject(cancelled()) }
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}
