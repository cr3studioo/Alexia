// SPDX-License-Identifier: AGPL-3.0-only
import type { Duplex } from 'node:stream'
import { CORE } from '../secrets.js'
import type { Store } from '../store.js'
import { Frames, send, type Controller } from './controller.js'
import { encodeFrame, type JobCancel, type JobEvent, type JobSubmit } from './protocol.js'
import { ComputeError, finished, isHostId, JOB_STATES, type JobSnapshot, type QueueSnapshot } from './types.js'

export const JOBS_KEY = 'compute_jobs'
export interface RunHandlers { onEvent?(event: JobEvent): void }

/** One job whose outcome is still wanted, as `compute_jobs` keeps it across a restart. */
interface Wanted { hostId: string; jobId: string; label: string; createdAt: number }

/** How many final words from a host are kept for a job nobody was following when it ended. */
const TOLD_MAX = 200
const EVENTS = ['state', 'progress', 'output', 'done']

const cancelled = (): ComputeError => new ComputeError('cancelled', 'The job is no longer being followed.')
const keyOf = (hostId: string, jobId: string): string => `${hostId}/${jobId}`

function wanted(value: unknown): value is Wanted {
  if (typeof value !== 'object' || value === null) return false
  const { hostId, jobId, label, createdAt } = value as Partial<Wanted>
  return isHostId(hostId) && typeof jobId === 'string' && jobId !== '' && typeof label === 'string' && typeof createdAt === 'number' && Number.isFinite(createdAt)
}

function snapshot(value: unknown): value is JobSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const job = value as Partial<JobSnapshot>
  return typeof job.id === 'string' && (JOB_STATES as readonly unknown[]).includes(job.state)
}

function jobEvent(frame: unknown): JobEvent | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined
  const event = frame as Partial<JobEvent> & { job?: unknown }
  if (!EVENTS.includes(event.type ?? '') || !Number.isSafeInteger(event.seq)) return undefined
  if ((event.type === 'state' || event.type === 'done') && !snapshot(event.job)) return undefined
  return event as JobEvent
}

/**
 * **The interaction computer's side of a job**: submit it once, hear it to the end, and
 * remember across a restart that its outcome is still wanted.
 *
 * A job id reaches a host in a submit exactly once, from {@link run}. Everything after that
 * — a broken stream, a lost session, this process starting again — only ever *asks*: the
 * session's `Hello` names the job, and the stream that follows it is an `attach`. So a job the
 * host lost is reported `interrupted` and stays that way; nothing here runs it again.
 */
export class RemoteJobs {
  private readonly controller: Controller
  private readonly store: Pick<Store, 'kvGet' | 'kvSet'>
  private readonly now: () => number
  /** Jobs whose submit has not gone out yet: the host cannot be asked about what it has never been sent. */
  private readonly submitting = new Set<string>()
  /** Whoever is in `run` or `attach` for a job right now, to be woken when the host says something. */
  private readonly following = new Map<string, Set<() => void>>()
  /** What the host last said on the control stream about a job that is wanted. */
  private readonly told = new Map<string, JobSnapshot>()

  constructor(options: { controller: Controller; store: Pick<Store, 'kvGet' | 'kvSet'>; now?(): number }) {
    this.controller = options.controller
    this.store = options.store
    this.now = options.now ?? Date.now
    this.controller.onEvent((hostId, event) => {
      if (event.event === 'job' && snapshot(event.job)) this.heard(hostId, event.job)
    })
  }

  async run(hostId: string, submit: JobSubmit, handlers?: RunHandlers, signal?: AbortSignal): Promise<JobSnapshot> {
    const key = keyOf(hostId, submit.jobId)
    if (signal?.aborted) throw cancelled()
    if (this.submitting.has(key) || this.find(hostId, submit.jobId)) throw new ComputeError('refused', 'That job has already been submitted.')
    this.submitting.add(key)
    this.remember({ hostId, jobId: submit.jobId, label: submit.cap, createdAt: this.now() })
    let stream: Duplex | undefined
    try {
      // The signal stops the wait for a session. It is kept off the job's own stream, which
      // is where stopping is said to the host rather than done to the stream.
      await this.controller.ensure(hostId, signal)
      stream = await this.controller.stream(hostId, { stream: 'job', submit })
    } catch (error) {
      // Only a stream that broke under the submit leaves it unknown whether the host read
      // it. That is followed like any job; every other failure means it was never sent.
      if (!(error instanceof ComputeError) || error.code !== 'interrupted') {
        this.forget(hostId, submit.jobId)
        throw error
      }
    } finally { this.submitting.delete(key) }
    return this.follow(hostId, submit.jobId, stream, handlers, signal, true)
  }

  attach(hostId: string, jobId: string, handlers?: RunHandlers, signal?: AbortSignal): Promise<JobSnapshot> {
    return this.follow(hostId, jobId, undefined, handlers, signal, false)
  }

  async cancel(hostId: string, jobId: string): Promise<JobSnapshot> {
    const job = await this.controller.call(hostId, 'job.cancel', { jobId })
    if (finished(job.state) && !this.following.has(keyOf(hostId, jobId))) this.forget(hostId, jobId)
    return job
  }

  outstanding(hostId: string): string[] {
    return this.wanted().filter((job) => job.hostId === hostId && !this.submitting.has(keyOf(hostId, job.jobId))).map((job) => job.jobId)
  }

  queue(hostId: string): QueueSnapshot | undefined {
    return this.controller.queue(hostId)
  }

  /**
   * Hear a job to its last event. `stream` is the one its submit went out on, when there is
   * one; every stream opened here is an `attach`. `owns` is whether stopping means cancelling
   * the job (the caller that submitted it) or only no longer listening (one that attached).
   */
  private async follow(hostId: string, jobId: string, stream: Duplex | undefined, handlers: RunHandlers | undefined, signal: AbortSignal | undefined, owns: boolean): Promise<JobSnapshot> {
    const key = keyOf(hostId, jobId)
    let wake: (() => void) | undefined
    const waker = (): void => { wake?.() }
    const followers = this.following.get(key) ?? new Set()
    this.following.set(key, followers.add(waker))
    const off = this.controller.onChange((changed) => { if (changed === hostId) waker() })
    let current = stream
    const abort = (): void => {
      waker()
      if (!owns) { current?.destroy(); return }
      // The one thing a controller may say on a job stream; with no stream, the same on the session.
      if (current) send(current, encodeFrame({ type: 'cancel' } satisfies JobCancel)).catch(() => {})
      else this.controller.call(hostId, 'job.cancel', { jobId }).catch(() => {})
    }
    signal?.addEventListener('abort', abort, { once: true })
    // Stopped while the submit was still going out: the listener above will never hear it.
    if (signal?.aborted) abort()
    try {
      let last: number | undefined
      let attached = false
      let dry = false
      for (;;) {
        if (current) {
          const heard = await this.hear(current, last, handlers)
          dry = attached && heard.last === last
          last = heard.last
          current = undefined
          if (heard.done) return this.settle(hostId, jobId, heard.done)
        }
        if (signal?.aborted) throw cancelled()
        // Armed before asking, so nothing the host says while it is asked can be missed.
        let stirred = false
        wake = () => { stirred = true }
        try {
          await this.controller.ensure(hostId, signal)
          const told = this.told.get(key)
          const status = told?.state === 'interrupted' ? told : await this.controller.call(hostId, 'job.status', { jobId }, signal)
          // An attach that said nothing new about a finished job has nothing more to say.
          if (status.state === 'interrupted' || (dry && finished(status.state))) return this.settle(hostId, jobId, status)
          if (!dry) {
            current = await this.controller.stream(hostId, { stream: 'job', attach: jobId, ...(last !== undefined && { after: last }) }, owns ? undefined : signal)
            attached = true
            if (signal?.aborted) abort()
            continue
          }
        } catch (error) {
          if (signal?.aborted) throw cancelled()
          const code = error instanceof ComputeError ? error.code : 'offline'
          if (code === 'not-found') {
            const saved = this.find(hostId, jobId)
            if (!saved) throw error
            // The host has no memory of a job it was sent: it restarted, which is what `interrupted` means.
            return this.settle(hostId, jobId, {
              id: jobId, kind: 'operation', weight: 'heavy', state: 'interrupted', label: saved.label, createdAt: saved.createdAt,
              failure: { code: 'interrupted', message: 'That computer no longer has this job.' },
            })
          }
          if (code === 'unpaired' || code === 'incompatible-version') throw error
          // Its own failed attempt is not news. The controller says when the host is back.
          if (code === 'offline') stirred = false
        }
        // Unreachable, or quiet: wait for the host or the session to say something. The
        // controller keeps reconnecting while this job is wanted; nothing here is on a timer.
        if (!stirred) await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
        dry = false
        if (signal?.aborted) throw cancelled()
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      off()
      current?.destroy()
      followers.delete(waker)
      if (followers.size === 0 && this.following.get(key) === followers) this.following.delete(key)
    }
  }

  /** Read one job stream until its `done`, its end or its breaking. Events already heard are skipped. */
  private async hear(stream: Duplex, last: number | undefined, handlers: RunHandlers | undefined): Promise<{ last: number | undefined; done?: JobSnapshot }> {
    const frames = new Frames(stream)
    try {
      for (;;) {
        const event = jobEvent(await frames.next())
        if (!event) break
        if (last !== undefined && event.seq <= last) continue
        last = event.seq
        try { handlers?.onEvent?.(event) } catch { /* a listener's failure is not the job's */ }
        if (event.type === 'done') return { last, done: event.job }
      }
    } catch { /* The stream broke. The job may not have: the host is asked. */ }
    finally { stream.destroy() }
    return { last }
  }

  private heard(hostId: string, job: JobSnapshot): void {
    const key = keyOf(hostId, job.id)
    if (this.submitting.has(key) || (!this.following.has(key) && !this.find(hostId, job.id))) return
    this.told.delete(key)
    this.told.set(key, job)
    if (this.told.size > TOLD_MAX) this.told.delete(this.told.keys().next().value!)
    const followers = this.following.get(key)
    if (followers) for (const wake of [...followers]) wake()
    // `compute_jobs` holds unfinished jobs only. The final word is kept for whoever attaches next.
    else if (finished(job.state)) this.forget(hostId, job.id)
  }

  private settle(hostId: string, jobId: string, job: JobSnapshot): JobSnapshot {
    this.forget(hostId, jobId)
    this.told.delete(keyOf(hostId, jobId))
    return job
  }

  private wanted(): Wanted[] {
    const saved = this.store.kvGet(CORE, JOBS_KEY)
    return Array.isArray(saved) ? saved.filter(wanted) : []
  }

  private find(hostId: string, jobId: string): Wanted | undefined {
    return this.wanted().find((job) => job.hostId === hostId && job.jobId === jobId)
  }

  private remember(job: Wanted): void {
    this.store.kvSet(CORE, JOBS_KEY, [...this.wanted(), job])
  }

  private forget(hostId: string, jobId: string): void {
    const all = this.wanted()
    const kept = all.filter((job) => job.hostId !== hostId || job.jobId !== jobId)
    if (kept.length !== all.length) this.store.kvSet(CORE, JOBS_KEY, kept)
  }
}
