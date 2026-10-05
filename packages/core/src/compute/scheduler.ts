// SPDX-License-Identifier: AGPL-3.0-only
import {
  ARTIFACT_RETENTION_MS, ComputeError, finished, IDLE_STOP_MS,
  type ArtifactRef, type ComputeFailure, type JobKind, type JobProgress,
  type JobSnapshot, type JobWeight, type QueueSnapshot,
} from './types.js'

/** A backend Alexia started that holds model memory. */
export interface WorkerHandle {
  readonly id: string
  loaded(): boolean
  stop(): Promise<void>
}
export interface JobSpec { id: string; kind: JobKind; weight: JobWeight; label: string; worker: string }
type Outcome = { state: 'succeeded'; artifacts?: ArtifactRef[] } | { state: 'failed' | 'cancelled' | 'interrupted'; failure?: ComputeFailure }
export interface Admission {
  readonly job: JobSnapshot
  readonly signal: AbortSignal
  readonly turn: Promise<void>
  progress(progress: JobProgress): void
  finish(outcome: Outcome): void
}
export interface SchedulerOptions {
  idleMs?: number
  keepFinishedMs?: number
  now?(): number
  timer?(fn: () => void, ms: number): { clear(): void }
}

interface Worker {
  handle: WorkerHandle
  holds: Set<symbol>
  idleTimer?: { clear(): void }
  stopping?: Promise<void>
  unregistering?: Promise<void>
}
interface Job {
  spec: JobSpec
  snapshot: JobSnapshot
  admission: Admission
  abort: AbortController
  resolveTurn(): void
  rejectTurn(error: ComputeError): void
  done: Promise<void>
  resolveDone(): void
  prepared: boolean
  granted: boolean
  cancellation?: { state: 'cancelled' | 'interrupted'; failure?: ComputeFailure }
}

const snapshot = (job: Job): JobSnapshot => structuredClone(job.snapshot)

/** Event-driven scheduling and memory policy; workers own execution and acknowledge cancellation. */
export class Scheduler {
  private readonly workers = new Map<string, Worker>()
  private readonly jobs = new Map<string, Job>()
  private readonly active = new Set<Job>()
  private waiting: Job[] = []
  private remembered: Job[] = []
  private heavy?: Job
  private switching?: Promise<void>
  private pumping = false
  private pumpRequested = false
  private paused = false
  private closed = false
  private closing?: Promise<void>
  private readonly changes = new Set<() => void>()
  private readonly events = new Set<(job: JobSnapshot) => void>()
  private readonly idleMs: number
  private readonly keepFinishedMs: number
  private readonly now: () => number
  private readonly timer: NonNullable<SchedulerOptions['timer']>

  constructor(options: SchedulerOptions = {}) {
    this.idleMs = options.idleMs ?? IDLE_STOP_MS
    this.keepFinishedMs = options.keepFinishedMs ?? ARTIFACT_RETENTION_MS
    this.now = options.now ?? Date.now
    this.timer = options.timer ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms).unref()
      return { clear: () => clearTimeout(timer) }
    })
  }

  register(handle: WorkerHandle): void {
    this.open()
    const known = this.workers.get(handle.id)
    if (known?.handle === handle && !known.unregistering) return
    if (known) throw new ComputeError('refused', 'That worker is already registered.')
    const worker: Worker = { handle, holds: new Set() }
    this.workers.set(handle.id, worker)
    if (handle.loaded()) this.armIdle(worker)
    this.changed()
  }

  unregister(workerId: string): Promise<void> {
    const worker = this.workers.get(workerId)
    if (!worker) return Promise.resolve()
    if (worker.unregistering) return worker.unregistering
    this.clearIdle(worker)
    worker.holds.clear()
    // Keep the handle registered until stop settles, so another turn waits for its memory.
    const unregistering = Promise.resolve().then(async () => {
      try { await this.stopWorker(worker) } finally {
        this.workers.delete(workerId)
        this.changed()
      }
    })
    worker.unregistering = unregistering
    const failure: ComputeFailure = { code: 'worker-failure', message: 'The compute worker was removed.' }
    for (const job of [...this.jobs.values()]) {
      if (job.spec.worker !== workerId || finished(job.snapshot.state)) continue
      job.cancellation = undefined
      this.complete(job, { state: 'failed', failure })
      job.abort.abort(new ComputeError(failure.code, failure.message))
    }
    return unregistering
  }

  submit(spec: JobSpec): Admission {
    this.open()
    this.prune()
    const known = this.jobs.get(spec.id)
    if (known) {
      if (finished(known.snapshot.state)) throw new ComputeError('refused', 'That compute job has already finished.')
      return known.admission
    }
    this.worker(spec.worker)
    let resolveTurn!: () => void, rejectTurn!: (error: ComputeError) => void, resolveDone!: () => void
    const turn = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject })
    // Cancellation may precede the caller attaching to turn; it still rejects for that caller.
    void turn.catch(() => {})
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const abort = new AbortController()
    const job: Job = {
      spec: { ...spec },
      snapshot: { id: spec.id, kind: spec.kind, weight: spec.weight, label: spec.label, state: 'queued', createdAt: this.now() },
      admission: {
        get job() { return snapshot(job) },
        signal: abort.signal, turn,
        progress: (progress) => {
          if (job.snapshot.state !== 'running') return
          job.snapshot.progress = { ...progress }
          this.changed(job)
        },
        finish: (outcome) => this.complete(job, outcome),
      },
      abort, resolveTurn, rejectTurn, done, resolveDone, prepared: false, granted: false,
    }
    this.jobs.set(spec.id, job)
    this.waiting.push(job)
    this.changed(job)
    this.pump()
    return job.admission
  }

  cancel(jobId: string): JobSnapshot {
    this.prune()
    const job = this.jobs.get(jobId)
    if (!job) throw new ComputeError('not-found', 'That compute job is not known.')
    this.cancelJob(job, 'cancelled')
    return snapshot(job)
  }

  async cancelAll(state: 'cancelled' | 'interrupted', failure?: ComputeFailure): Promise<void> {
    const jobs = [...this.jobs.values()].filter((job) => !finished(job.snapshot.state))
    // Cancel waiting jobs first: finishing an active one must not admit the next in this batch.
    for (const job of jobs.filter((job) => job.snapshot.state === 'queued')) this.cancelJob(job, state, failure)
    for (const job of jobs) this.cancelJob(job, state, failure)
    await Promise.all(jobs.map((job) => job.done))
  }

  status(jobId: string): JobSnapshot | undefined {
    this.prune()
    const job = this.jobs.get(jobId)
    return job && snapshot(job)
  }

  queue(): QueueSnapshot {
    const running = this.heavy ?? this.active.values().next().value
    return { ...(running ? { running: snapshot(running) } : {}), waiting: this.waiting.map(snapshot), paused: this.paused }
  }

  pause(paused: boolean): void {
    if (this.closed || this.paused === paused) return
    this.paused = paused
    this.changed()
    this.pump()
  }

  hold(workerId: string): () => void {
    this.open()
    const worker = this.worker(workerId)
    const hold = Symbol()
    worker.holds.add(hold)
    // Selection is idle time too: an unreleased lease expires after one idle interval.
    this.armIdle(worker)
    this.changed()
    return () => {
      if (!worker.holds.delete(hold)) return
      if (worker.holds.size === 0) this.armIdle(worker)
      this.changed()
    }
  }

  idle(): boolean { return this.active.size === 0 && this.waiting.length === 0 && !this.switching }

  onChange(listener: () => void): () => void {
    this.changes.add(listener)
    return () => { this.changes.delete(listener) }
  }

  onJob(listener: (job: JobSnapshot) => void): () => void {
    this.events.add(listener)
    return () => { this.events.delete(listener) }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    for (const worker of this.workers.values()) { this.clearIdle(worker); worker.holds.clear() }
    this.closing = (async () => {
      await this.cancelAll('cancelled')
      await this.switching
      const stopped = await Promise.allSettled([...this.workers.values()].map((worker) => this.stopWorker(worker)))
      this.workers.clear()
      this.changes.clear()
      this.events.clear()
      const failure = stopped.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })()
    return this.closing
  }

  private open(): void {
    if (this.closed) throw new ComputeError('refused', 'The compute scheduler is closed.')
  }

  private worker(id: string): Worker {
    const worker = this.workers.get(id)
    if (!worker || worker.unregistering) throw new ComputeError('worker-failure', 'That compute worker is not available.')
    return worker
  }

  private changed(job?: Job): void {
    if (job) for (const listener of this.events) { try { listener(snapshot(job)) } catch { /* Observers cannot change admission. */ } }
    for (const listener of this.changes) { try { listener() } catch { /* Observers cannot change admission. */ } }
  }

  private prune(): void {
    const at = this.now()
    this.remembered = this.remembered.filter((job) => {
      if (at - job.snapshot.finishedAt! < this.keepFinishedMs) return true
      this.jobs.delete(job.spec.id)
      return false
    })
    while (this.remembered.length > 200) this.jobs.delete(this.remembered.shift()!.spec.id)
  }

  private cancelJob(job: Job, state: 'cancelled' | 'interrupted', failure?: ComputeFailure): void {
    if (finished(job.snapshot.state)) return
    job.cancellation = { state, ...(failure ? { failure: { ...failure } } : {}) }
    const error = new ComputeError(state, failure?.message ?? 'The compute job was cancelled.')
    if (job.snapshot.state === 'queued' || (job.prepared && !job.granted)) this.complete(job, job.cancellation)
    else {
      job.snapshot.state = 'cancelling'
      job.rejectTurn(error)
      this.changed(job)
    }
    job.abort.abort(error)
  }

  private complete(job: Job, outcome: Outcome): void {
    if (finished(job.snapshot.state)) return
    const final = job.cancellation ?? outcome
    const wasActive = this.active.delete(job)
    this.waiting = this.waiting.filter((one) => one !== job)
    if (this.heavy === job) this.heavy = undefined
    job.snapshot.state = final.state
    job.snapshot.finishedAt = this.now()
    if (final.state === 'succeeded' && final.artifacts) job.snapshot.artifacts = structuredClone(final.artifacts)
    if (final.state !== 'succeeded' && final.failure) job.snapshot.failure = { ...final.failure }
    if (!job.granted) job.rejectTurn(new ComputeError(
      final.state === 'succeeded' ? 'refused' : final.failure?.code ?? (final.state === 'failed' ? 'worker-failure' : final.state),
      final.state === 'succeeded' ? 'The job finished before its turn.' : final.failure?.message ?? 'The compute job ended before its turn.',
    ))
    this.remembered.push(job)
    this.prune()
    const worker = this.workers.get(job.spec.worker)
    if (wasActive && worker && !worker.unregistering) this.armIdle(worker)
    job.resolveDone()
    this.changed(job)
    this.pump()
  }

  private pump(): void {
    if (this.closed || this.paused) return
    if (this.pumping) { this.pumpRequested = true; return }
    this.pumping = true
    try {
      do {
        this.pumpRequested = false
        for (const job of this.active) if (job.prepared && job.snapshot.state === 'preparing' && !this.paused && !this.closed) this.grant(job)
        for (const job of [...this.waiting]) {
          if (this.closed || this.paused) break
          if (job.snapshot.state !== 'queued') continue
          const light = [...this.active].filter((one) => one.spec.weight === 'light').length
          if (job.spec.weight === 'heavy' ? this.heavy || this.switching : light >= 2) continue
          const worker = this.workers.get(job.spec.worker)
          if (!worker || worker.unregistering) continue
          this.waiting = this.waiting.filter((one) => one !== job)
          this.active.add(job)
          if (job.spec.weight === 'heavy') this.heavy = job
          this.clearIdle(worker)
          job.snapshot.state = 'preparing'
          this.changed(job)
          if (job.spec.weight === 'light' && !worker.stopping) {
            job.prepared = true
            if (!this.paused && !this.closed && job.snapshot.state === 'preparing') this.grant(job)
          } else {
            const preparing = this.prepare(job, worker).then(() => {
              if (finished(job.snapshot.state)) return
              if (job.cancellation) this.complete(job, job.cancellation)
              else { job.prepared = true; this.pump() }
            }, () => {
              if (finished(job.snapshot.state)) return
              this.complete(job, job.cancellation ?? {
                state: 'failed', failure: { code: 'worker-failure', message: 'A compute worker could not release its memory.' },
              })
            }).finally(() => {
              if (this.switching === preparing) { this.switching = undefined; this.changed() }
              this.pump()
            })
            if (job.spec.weight === 'heavy') this.switching = preparing
          }
        }
      } while (this.pumpRequested && !this.closed && !this.paused)
    } finally { this.pumping = false }
  }

  private async prepare(job: Job, worker: Worker): Promise<void> {
    if (finished(job.snapshot.state)) return
    job.abort.signal.throwIfAborted()
    await worker.stopping
    if (job.spec.weight === 'heavy') for (const other of this.workers.values()) {
      if (finished(job.snapshot.state)) return
      job.abort.signal.throwIfAborted()
      if (other !== worker && (other.stopping || other.handle.loaded())) await this.stopWorker(other)
    }
    job.abort.signal.throwIfAborted()
  }

  private grant(job: Job): void {
    job.granted = true
    job.snapshot.state = 'running'
    job.snapshot.startedAt = this.now()
    job.resolveTurn()
    this.changed(job)
  }

  private busy(worker: Worker): boolean { return [...this.active].some((job) => job.spec.worker === worker.handle.id) }

  private clearIdle(worker: Worker): void {
    worker.idleTimer?.clear()
    worker.idleTimer = undefined
  }

  private armIdle(worker: Worker): void {
    this.clearIdle(worker)
    if (this.closed || worker.unregistering || this.busy(worker)) return
    worker.idleTimer = this.timer(() => {
      worker.idleTimer = undefined
      worker.holds.clear()
      void this.stopWorker(worker).catch(() => {})
    }, this.idleMs)
  }

  private stopWorker(worker: Worker): Promise<void> {
    this.clearIdle(worker)
    worker.holds.clear()
    if (worker.stopping) return worker.stopping
    const stopping = (async () => { await worker.handle.stop() })().finally(() => {
      if (worker.stopping === stopping) worker.stopping = undefined
      this.changed()
    })
    worker.stopping = stopping
    return stopping
  }
}
