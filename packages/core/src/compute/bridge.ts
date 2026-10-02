// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable, type Duplex } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Provider } from '../provider.js'
import { failureOf, Frames, type Controller } from './controller.js'
import type { InferHead, Lease } from './protocol.js'
import {
  ComputeError, isHostId, parseCatalogId, REMOTE_PROVIDER, sameTarget, THIS_HOST,
  type ComputeErrorCode, type ExecutionTarget, type TargetPhase, type TargetStatus,
} from './types.js'

export const REMOTE: Provider = {
  id: REMOTE_PROVIDER, name: 'Paired computer', baseUrl: '', auth: 'none',
  timeoutMs: 180_000, idleMs: 180_000, trainsOnYourData: 'no',
}

export interface BridgeLease {
  baseUrl: string
  key: string
  model: string
  release(): void
}

interface Preparation {
  target: ExecutionTarget
  leaseId: string
  lease?: Lease
  sent?: boolean
  selection: boolean
  report?: (status: TargetStatus) => void
  ready(): void
  fail(error: ComputeError): void
}
interface HttpLease { preparation: Preparation; key: string; abort: AbortController }

const cancelled = (): ComputeError => new ComputeError('cancelled', 'The preparation was cancelled.')
const interrupted = (): ComputeError => new ComputeError('interrupted', 'The answer was interrupted.')
const FAILURE_STATUS: Partial<Record<ComputeErrorCode, number>> = {
  busy: 503, 'setup-required': 409, 'worker-failure': 502, 'incompatible-version': 426, unpaired: 401,
}
const failureStatus = (code: ComputeErrorCode): number => FAILURE_STATUS[code] ?? 500
const failurePhase = (code: ComputeErrorCode): TargetPhase =>
  code === 'busy' || code === 'setup-required' || code === 'worker-failure' || code === 'incompatible-version' ? code : 'offline'

/** The address is only a transport adapter. The target, never its URL, says where inference runs. */
export class Bridge {
  private readonly controller: Controller
  private readonly maxBodyBytes: number
  private readonly preparations = new Map<string, Preparation>()
  private readonly leases = new Map<string, HttpLease>()
  private readonly listeners = new Set<(status: TargetStatus) => void>()
  private readonly releasing = new Set<Promise<void>>()
  private readonly lifetime = new AbortController()
  private readonly subscriptions: (() => void)[]
  private selected?: Preparation
  private selecting?: AbortController
  private selection = 0
  private current?: TargetStatus
  private server?: Server
  private starting?: Promise<string>
  private stopping?: Promise<void>
  private reserving = 0

  constructor(options: { controller: Controller; maxBodyBytes?: number }) {
    this.controller = options.controller
    this.maxBodyBytes = options.maxBodyBytes ?? 64 * 1024 * 1024
    if (!Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes < 1) throw new Error('The bridge needs a positive body size limit.')
    this.subscriptions = [
      this.controller.onEvent((hostId, event) => {
        if (event.event === 'lease') {
          const preparation = this.preparations.get(event.lease.leaseId)
          if (preparation?.target.hostId === hostId) this.heard(preparation, event.lease)
        } else if (event.event === 'bye') {
          this.hostFailed(hostId, new ComputeError(event.reason === 'unpaired' ? 'unpaired' : 'offline', 'That computer ended the compute session.'))
        }
      }),
      this.controller.onChange((hostId) => {
        const view = this.controller.view(hostId)
        if (!view) this.hostFailed(hostId, new ComputeError('unpaired', 'That computer is not paired.'))
        else if (view.failure) this.hostFailed(hostId, new ComputeError(view.failure.code, view.failure.message))
        else if (this.current?.target.hostId === hostId) this.publish({ ...this.current, connection: view.connection })
      }),
    ]
  }

  async select(target: ExecutionTarget, signal: AbortSignal, onStatus?: (status: TargetStatus) => void): Promise<{ id: string; name: string }> {
    const selection = ++this.selection
    this.selecting?.abort()
    const selecting = new AbortController()
    this.selecting = selecting
    const previous = this.selected
    this.selected = undefined
    if (previous) await this.releasePreparation(previous)
    const report = (status: TargetStatus): void => {
      if (selection !== this.selection) return
      this.publish(status)
      try { onStatus?.(this.status()!) } catch { /* the observer does not own preparation */ }
    }
    try {
      const preparation = await this.acquire(target, AbortSignal.any([signal, selecting.signal]), report, true)
      if (selection !== this.selection) {
        await this.releasePreparation(preparation)
        throw cancelled()
      }
      this.selected = preparation
      const model = this.controller.view(target.hostId)?.inventory?.models.find((model) => model.id === target.modelId)
      return { id: target.modelId, name: model?.name ?? target.modelId }
    } finally {
      if (this.selecting === selecting) this.selecting = undefined
    }
  }

  async deselect(): Promise<void> {
    ++this.selection
    this.selecting?.abort()
    this.selecting = undefined
    const selected = this.selected
    const pending = [...this.preparations.values()].filter((preparation) => preparation.selection && preparation !== selected)
    this.selected = undefined
    this.current = undefined
    await Promise.all([...(selected ? [selected] : []), ...pending].map((preparation) => this.releasePreparation(preparation)))
  }

  status(): TargetStatus | undefined { return this.current && { ...this.current, target: { ...this.current.target } } }

  onStatus(listener: (status: TargetStatus) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async prepare(target: ExecutionTarget, signal?: AbortSignal): Promise<BridgeLease> {
    // A request owns a separate host lease: deselecting cannot stop an answer already underway.
    const report = sameTarget(this.selected?.target, target) ? this.selected?.report : undefined
    const preparation = await this.acquire(target, signal, report)
    ++this.reserving
    try {
      const base = await this.listen()
      if (signal?.aborted || this.lifetime.signal.aborted) throw cancelled()
      const token = randomBytes(32).toString('hex')
      const lease: HttpLease = { preparation, key: randomBytes(32).toString('hex'), abort: new AbortController() }
      this.leases.set(token, lease)
      return {
        baseUrl: `${base}/${token}`, key: lease.key, model: preparation.lease!.modelId,
        release: () => {
          if (!this.leases.delete(token)) return
          lease.abort.abort()
          void this.releasePreparation(preparation)
          this.stopIfIdle()
        },
      }
    } catch (error) {
      await this.releasePreparation(preparation)
      throw error
    } finally { --this.reserving; this.stopIfIdle() }
  }

  async close(): Promise<void> {
    this.lifetime.abort()
    for (const lease of this.leases.values()) lease.abort.abort()
    this.leases.clear()
    this.stopIfIdle()
    await this.deselect()
    for (const off of this.subscriptions) off()
    for (const preparation of [...this.preparations.values()]) await this.releasePreparation(preparation)
    if (this.starting) await this.starting.catch(() => {})
    this.stopIfIdle()
    await this.stopping
    await Promise.all([...this.releasing])
    this.listeners.clear()
  }

  private async acquire(target: ExecutionTarget, signal?: AbortSignal, report?: Preparation['report'], selection = false): Promise<Preparation> {
    if (this.lifetime.signal.aborted || signal?.aborted) throw cancelled()
    if (target.hostId === THIS_HOST || !isHostId(target.hostId) || !target.modelId) throw new ComputeError('refused', 'Choose a model on a paired computer.')
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    let ready!: () => void, fail!: (error: ComputeError) => void
    const waiting = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject })
    void waiting.catch(() => {})
    const preparation: Preparation = { target: { ...target }, leaseId: randomUUID(), selection, report, ready, fail }
    this.preparations.set(preparation.leaseId, preparation)
    const abort = (): void => fail(cancelled())
    combined.addEventListener('abort', abort, { once: true })
    this.announce(preparation, 'connecting', 'Connecting to the paired computer.')
    try {
      await this.controller.ensure(target.hostId, combined)
      if (combined.aborted) throw cancelled()
      const before = preparation.lease
      preparation.sent = true
      const lease = await this.controller.call(target.hostId, 'prepare', { leaseId: preparation.leaseId, modelId: target.modelId }, combined)
      // A lease event can precede this reply. The newer event must not be replaced by the earlier reply.
      if (preparation.lease === before) this.heard(preparation, lease)
      await waiting
      if (combined.aborted) throw cancelled()
      return preparation
    } catch (error) {
      const cause = error instanceof ComputeError ? error : new ComputeError('worker-failure', 'That computer could not prepare the model.')
      this.announce(preparation, failurePhase(cause.code), cause.message)
      await this.releasePreparation(preparation)
      throw cause
    } finally { combined.removeEventListener('abort', abort) }
  }

  private heard(preparation: Preparation, lease: Lease): void {
    if (!lease || lease.leaseId !== preparation.leaseId || lease.modelId !== preparation.target.modelId) {
      preparation.fail(new ComputeError('incompatible-version', 'That computer prepared a different model.'))
      return
    }
    const previous = preparation.lease
    preparation.lease = lease
    // An idle stop is normal. The next request acquires its own fresh preparation.
    if (lease.phase === 'released' && previous?.phase === 'ready' && !lease.failure) return
    if (lease.phase === 'ready') {
      this.announce(preparation, 'ready', lease.message)
      preparation.ready()
    } else if (lease.phase === 'queued' || lease.phase === 'loading') this.announce(preparation, lease.phase, lease.message, lease.position)
    else {
      const failure = lease.failure ?? { code: lease.phase === 'released' ? 'worker-failure' : lease.phase, message: lease.message }
      this.announce(preparation, failurePhase(failure.code), failure.message)
      preparation.fail(new ComputeError(failure.code, failure.message))
    }
  }

  private hostFailed(hostId: string, error: ComputeError): void {
    for (const preparation of this.preparations.values()) {
      if (preparation.target.hostId !== hostId) continue
      preparation.fail(error)
      this.announce(preparation, failurePhase(error.code), error.message)
    }
  }

  private announce(preparation: Preparation, phase: TargetPhase, message: string, position?: number): void {
    preparation.report?.({ target: { ...preparation.target }, phase, message,
      connection: this.controller.view(preparation.target.hostId)?.connection ?? 'offline',
      ...(position !== undefined && { position }),
    })
  }

  private publish(status: TargetStatus): void {
    this.current = status
    for (const listener of this.listeners) { try { listener(this.status()!) } catch { /* the observer does not own preparation */ } }
  }

  private releasePreparation(preparation: Preparation): Promise<void> {
    if (!this.preparations.delete(preparation.leaseId)) return Promise.resolve()
    preparation.fail(cancelled())
    if (!preparation.sent) return Promise.resolve()
    const work = this.controller.call(preparation.target.hostId, 'release', { leaseId: preparation.leaseId }).then(() => {}, () => {})
    this.releasing.add(work)
    void work.then(() => { this.releasing.delete(work) })
    return work
  }

  private async listen(): Promise<string> {
    await this.stopping
    if (this.starting) return this.starting
    if (this.server?.listening) return this.address(this.server)
    const server = createServer((request, response) => { void this.forward(request, response) })
    this.server = server
    const starting = new Promise<string>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(this.address(server)) })
    })
    this.starting = starting
    try { return await starting } finally { if (this.starting === starting) this.starting = undefined }
  }

  private address(server: Server): string {
    const address = server.address()
    if (!address || typeof address === 'string') throw new ComputeError('offline', 'The inference bridge could not start.')
    return `http://127.0.0.1:${address.port}`
  }

  private stopIfIdle(): void {
    if (this.leases.size || this.reserving || !this.server) return
    const server = this.server
    this.server = undefined
    this.stopping = new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
  }

  private async forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = /^\/([a-f0-9]{64})\/chat\/completions$/.exec(request.url ?? '')?.[1]
    const lease = token && this.leases.get(token)
    if (!lease || request.headers.authorization !== `Bearer ${lease.key}`) { response.writeHead(401).end(); request.resume(); return }
    if (request.method !== 'POST') { response.writeHead(405).end(); request.resume(); return }
    const length = request.headers['content-length']
    const bodyBytes = typeof length === 'string' && /^\d+$/.test(length) ? Number(length) : NaN
    if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0) { response.writeHead(411).end(); request.resume(); return }
    if (bodyBytes > this.maxBodyBytes) { response.writeHead(413).end(); request.resume(); return }
    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, lease.abort.signal, this.lifetime.signal])
    let stream: Duplex | undefined
    const gone = (): void => { if (!response.writableFinished) abort.abort() }
    request.once('aborted', gone)
    response.once('close', gone)
    try {
      stream = await this.controller.stream(lease.preparation.target.hostId, {
        stream: 'infer', jobId: randomUUID(), leaseId: lease.preparation.leaseId, bodyBytes,
      }, signal)
      const frames = new Frames(stream)
      // Read the head while uploading: a host can refuse before consuming the body.
      // Destroying an upload must not destroy its HTTP response before an early refusal is sent.
      const body = Readable.from(request.iterator({ destroyOnReturn: false }), { objectMode: false })
      const upload = pipeline(body, stream, { signal })
      void upload.catch(() => {})
      const head = await frames.next() as InferHead | undefined
      if (head?.type === 'refused') {
        const failure = failureOf(head.failure)
        response.writeHead(failureStatus(failure.code), { 'content-type': 'text/plain; charset=utf-8' }).end(failure.message)
        return
      }
      if (head?.type !== 'head' || !Number.isInteger(head.status) || head.status < 200 || head.status > 599 || typeof head.contentType !== 'string') throw interrupted()
      response.writeHead(head.status, { 'content-type': head.contentType })
      response.flushHeaders()
      await pipeline(Readable.from(frames.bytes(), { objectMode: false }), response, { signal })
      await upload
    } catch (error) {
      if (signal.aborted || response.headersSent) response.destroy()
      else {
        const failure = error instanceof ComputeError ? error.failure() : interrupted().failure()
        response.writeHead(failureStatus(failure.code), { 'content-type': 'text/plain; charset=utf-8' }).end(failure.message)
      }
    } finally {
      stream?.destroy()
      request.resume()
      request.off('aborted', gone)
      response.off('close', gone)
    }
  }
}

export function remoteProvider(bridge: Bridge): Provider {
  return { ...REMOTE, prepare: (model, signal) => bridge.prepare(parseCatalogId(model), signal) }
}
