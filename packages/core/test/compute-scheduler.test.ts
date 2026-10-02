// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Scheduler, type Admission, type JobSpec, type SchedulerOptions, type WorkerHandle } from '../src/compute/scheduler.js'
import { ARTIFACT_RETENTION_MS, ComputeError, finished, IDLE_STOP_MS, type ArtifactRef, type JobSnapshot } from '../src/compute/types.js'

const fixtures: { scheduler: Scheduler; admissions: Admission[] }[] = []
const releases: (() => void)[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000) })
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const { scheduler, admissions } of fixtures.splice(0)) {
    for (const job of admissions) if (!finished(job.job.state)) job.finish({ state: 'cancelled' })
    await scheduler.close()
  }
  vi.useRealTimers()
})

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  releases.push(resolve)
  return { promise, resolve }
}

function backend(id: string, loaded = false) {
  const handle = {
    id, loaded: () => loaded,
    stop: vi.fn(async () => { loaded = false }),
  } satisfies WorkerHandle
  return { handle, load: () => { loaded = true } }
}

function fixture(options: SchedulerOptions = {}) {
  const timer = vi.fn((fn: () => void, ms: number) => {
    const handle = setTimeout(fn, ms)
    return { clear: () => clearTimeout(handle) }
  })
  const scheduler = new Scheduler({ now: () => Date.now(), timer, ...options })
  const admissions: Admission[] = []
  const submit = (id: string, worker = 'a', extra: Partial<JobSpec> = {}) => {
    const job = scheduler.submit({ id, worker, kind: 'operation', weight: 'heavy', label: id, ...extra })
    admissions.push(job)
    return job
  }
  const result = { scheduler, submit, admissions, timer }
  fixtures.push(result)
  return result
}

const flush = () => vi.advanceTimersByTimeAsync(0)

test('heavy jobs across workers and kinds run one at a time in FIFO order', async () => {
  const { scheduler, submit } = fixture()
  for (const id of ['a', 'b', 'c']) scheduler.register(backend(id).handle)
  const starts: string[] = []
  const first = submit('first', 'a', { kind: 'chat' })
  const second = submit('second', 'b')
  const third = submit('third', 'c', { kind: 'setup' })
  for (const job of [first, second, third]) void job.turn.then(() => { starts.push(job.job.id) })
  await first.turn
  expect(starts).toEqual(['first'])
  expect(scheduler.queue().waiting.map((job) => job.id)).toEqual(['second', 'third'])
  first.finish({ state: 'succeeded' })
  await second.turn
  expect(starts).toEqual(['first', 'second'])
  second.finish({ state: 'succeeded' })
  await third.turn
  expect(starts).toEqual(['first', 'second', 'third'])
  third.finish({ state: 'succeeded' })
  await flush()
  expect(scheduler.idle()).toBe(true)
})

test('two light jobs start at once independently of the heavy slot; the third waits', async () => {
  const { scheduler, submit } = fixture()
  scheduler.register(backend('a').handle)
  const heavy = submit('heavy')
  const first = submit('download-1', 'a', { weight: 'light', kind: 'setup' })
  const second = submit('download-2', 'a', { weight: 'light', kind: 'setup' })
  const third = submit('probe', 'a', { weight: 'light', kind: 'setup' })
  expect(first.job.state).toBe('running')
  expect(second.job.state).toBe('running')
  expect(third.job.state).toBe('queued')
  await Promise.all([heavy.turn, first.turn, second.turn])
  first.finish({ state: 'succeeded' })
  await third.turn
  expect(heavy.job.state).toBe('running')
  expect(second.job.state).toBe('running')
})

test('queued cancellation leaves the queue in the same tick and rejects its turn', async () => {
  const { scheduler, submit } = fixture()
  scheduler.register(backend('a').handle)
  const first = submit('first'), cancelled = submit('cancelled'), last = submit('last')
  await first.turn
  const rejection = expect(cancelled.turn).rejects.toMatchObject({ code: 'cancelled' })
  expect(scheduler.cancel('cancelled').state).toBe('cancelled')
  expect(cancelled.signal.aborted).toBe(true)
  expect(scheduler.queue().waiting.map((job) => job.id)).toEqual(['last'])
  expect(scheduler.status('cancelled')?.finishedAt).toBe(Date.now())
  await rejection
  first.finish({ state: 'succeeded' })
  await last.turn
})

test('active cancellation aborts the worker but keeps its slot until finish acknowledges it', async () => {
  const { scheduler, submit } = fixture()
  scheduler.register(backend('a').handle)
  const first = submit('first'), second = submit('second')
  await first.turn
  expect(scheduler.cancel('first').state).toBe('cancelling')
  expect(first.signal.aborted).toBe(true)
  await flush()
  expect(second.job.state).toBe('queued')
  expect(scheduler.idle()).toBe(false)
  first.finish({ state: 'succeeded' })
  expect(first.job.state).toBe('cancelled')
  await second.turn
})

test('every other loaded worker is stopped before a heavy turn resolves, including held workers', async () => {
  const { scheduler, submit } = fixture()
  const own = backend('a', true), other = backend('b', true), third = backend('c', true), unloaded = backend('d')
  const stopping = gate()
  other.handle.stop.mockImplementation(async () => { await stopping.promise })
  for (const worker of [own, other, third, unloaded]) scheduler.register(worker.handle)
  const release = scheduler.hold('b')
  const job = submit('job')
  let ready = false
  void job.turn.then(() => { ready = true })
  await flush()
  expect(other.handle.stop).toHaveBeenCalledTimes(1)
  expect(ready).toBe(false)
  stopping.resolve()
  await job.turn
  expect(third.handle.stop).toHaveBeenCalledTimes(1)
  expect(own.handle.stop).not.toHaveBeenCalled()
  expect(unloaded.handle.stop).not.toHaveBeenCalled()
  release()
  expect(vi.getTimerCount()).toBe(0)
})

test('a failed memory release fails admission without granting a turn; subsequent jobs still run', async () => {
  const { scheduler, submit } = fixture()
  const a = backend('a'), b = backend('b', true)
  b.handle.stop.mockRejectedValueOnce(new Error('stop failed'))
  scheduler.register(a.handle)
  scheduler.register(b.handle)
  const first = submit('first'), second = submit('second', 'b')
  await expect(first.turn).rejects.toMatchObject({ code: 'worker-failure' })
  expect(first.job).toMatchObject({ state: 'failed', failure: { code: 'worker-failure' } })
  await second.turn
})

test('cancelling during memory preparation never grants a turn or overlaps a pending stop', async () => {
  const { scheduler, submit } = fixture()
  const a = backend('a'), b = backend('b', true), stopping = gate()
  b.handle.stop.mockImplementation(async () => { await stopping.promise })
  scheduler.register(a.handle)
  scheduler.register(b.handle)
  const first = submit('first'), second = submit('second', 'b')
  await flush()
  expect(first.job.state).toBe('preparing')
  const rejection = expect(first.turn).rejects.toMatchObject({ code: 'cancelled' })
  scheduler.cancel('first')
  first.finish({ state: 'cancelled' })
  await flush()
  expect(second.job.state).toBe('queued')
  stopping.resolve()
  await rejection
  await second.turn
})

test('idle workers stop at exactly ten minutes after the last job, with no periodic wakeups', async () => {
  const { scheduler, submit, timer } = fixture()
  const worker = backend('a')
  scheduler.register(worker.handle)
  expect(timer).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  const job = submit('job')
  await job.turn
  worker.load()
  await vi.advanceTimersByTimeAsync(IDLE_STOP_MS * 2)
  expect(worker.handle.stop).not.toHaveBeenCalled()
  job.finish({ state: 'succeeded' })
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(IDLE_STOP_MS - 1)
  expect(worker.handle.stop).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(worker.handle.stop).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(IDLE_STOP_MS * 2)
  expect(worker.handle.stop).toHaveBeenCalledTimes(1)
})

test('a new job clears the old idle timer and the next finish starts a full interval', async () => {
  const { scheduler, submit } = fixture()
  const worker = backend('a')
  scheduler.register(worker.handle)
  const first = submit('first')
  await first.turn
  first.finish({ state: 'succeeded' })
  await vi.advanceTimersByTimeAsync(IDLE_STOP_MS - 1)
  const second = submit('second')
  await second.turn
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(IDLE_STOP_MS * 2)
  expect(worker.handle.stop).not.toHaveBeenCalled()
  second.finish({ state: 'succeeded' })
  await vi.advanceTimersByTimeAsync(IDLE_STOP_MS - 1)
  expect(worker.handle.stop).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(worker.handle.stop).toHaveBeenCalledTimes(1)
})

test('a preparation lease resets the clock and stops exactly ten minutes after its release', async () => {
  const { scheduler } = fixture()
  const worker = backend('a', true)
  scheduler.register(worker.handle)
  await vi.advanceTimersByTimeAsync(IDLE_STOP_MS - 1)
  const release = scheduler.hold('a')
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(100)
  release()
  release()
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(IDLE_STOP_MS - 1)
  expect(worker.handle.stop).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(worker.handle.stop).toHaveBeenCalledTimes(1)
})

test('an unreleased preparation lease expires; a stale release cannot restart the idle clock', async () => {
  const { scheduler, timer } = fixture()
  const worker = backend('a', true)
  scheduler.register(worker.handle)
  const release = scheduler.hold('a')
  await vi.advanceTimersByTimeAsync(IDLE_STOP_MS - 1)
  expect(worker.handle.stop).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(worker.handle.stop).toHaveBeenCalledTimes(1)
  const arms = timer.mock.calls.length
  release()
  expect(timer).toHaveBeenCalledTimes(arms)
  expect(vi.getTimerCount()).toBe(0)
})

test('held idle time starts at the later of the hold start and the last job end', async () => {
  const { scheduler, submit } = fixture()
  const worker = backend('a')
  scheduler.register(worker.handle)
  const release = scheduler.hold('a')
  const job = submit('job')
  await job.turn
  await vi.advanceTimersByTimeAsync(IDLE_STOP_MS * 2)
  expect(worker.handle.stop).not.toHaveBeenCalled()
  job.finish({ state: 'succeeded' })
  await vi.advanceTimersByTimeAsync(IDLE_STOP_MS - 1)
  expect(worker.handle.stop).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(worker.handle.stop).toHaveBeenCalledTimes(1)
  release()
  worker.load()
  const second = submit('second')
  await second.turn
  second.finish({ state: 'succeeded' })
  await vi.advanceTimersByTimeAsync(100)
  scheduler.hold('a')
  await vi.advanceTimersByTimeAsync(IDLE_STOP_MS - 1)
  expect(worker.handle.stop).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(worker.handle.stop).toHaveBeenCalledTimes(2)
})

test('overlapping light jobs do not start idle time until the last one ends', async () => {
  const { scheduler, submit } = fixture()
  const worker = backend('a')
  scheduler.register(worker.handle)
  const first = submit('first', 'a', { weight: 'light' }), second = submit('second', 'a', { weight: 'light' })
  await Promise.all([first.turn, second.turn])
  first.finish({ state: 'succeeded' })
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(IDLE_STOP_MS * 2)
  expect(worker.handle.stop).not.toHaveBeenCalled()
  second.finish({ state: 'succeeded' })
  await vi.advanceTimersByTimeAsync(IDLE_STOP_MS)
  expect(worker.handle.stop).toHaveBeenCalledTimes(1)
})

test('a job waits for an idle stop already in progress before it uses that worker', async () => {
  const { scheduler, submit } = fixture()
  const worker = backend('a', true), stopping = gate()
  worker.handle.stop.mockImplementation(async () => { await stopping.promise })
  scheduler.register(worker.handle)
  await vi.advanceTimersByTimeAsync(IDLE_STOP_MS)
  const job = submit('job')
  await flush()
  expect(job.job.state).toBe('preparing')
  stopping.resolve()
  await job.turn
  expect(worker.handle.stop).toHaveBeenCalledTimes(1)
})

test('pause queues heavy and light jobs, preserves running work, and resumes FIFO', async () => {
  const { scheduler, submit } = fixture()
  scheduler.register(backend('a').handle)
  const first = submit('first')
  await first.turn
  scheduler.pause(true)
  const second = submit('second'), third = submit('third'), light = submit('download', 'a', { weight: 'light' })
  expect(first.job.state).toBe('running')
  expect(first.signal.aborted).toBe(false)
  first.finish({ state: 'succeeded' })
  await flush()
  expect(scheduler.queue()).toMatchObject({ paused: true, waiting: [{ id: 'second' }, { id: 'third' }, { id: 'download' }] })
  expect(light.job.state).toBe('queued')
  scheduler.pause(false)
  await Promise.all([second.turn, light.turn])
  expect(third.job.state).toBe('queued')
  second.finish({ state: 'succeeded' })
  await third.turn
})

test('pausing while memory is being released prevents the prepared job from starting', async () => {
  const { scheduler, submit } = fixture()
  const other = backend('b', true), stopping = gate()
  other.handle.stop.mockImplementation(async () => { await stopping.promise })
  scheduler.register(backend('a').handle)
  scheduler.register(other.handle)
  const job = submit('job')
  await flush()
  scheduler.pause(true)
  stopping.resolve()
  await flush()
  expect(job.job.state).toBe('preparing')
  expect(job.job.startedAt).toBeUndefined()
  scheduler.pause(false)
  await job.turn
  expect(job.job.state).toBe('running')
})

test('finished outcomes survive reconnect queries until exactly the retention limit without timers', async () => {
  const { scheduler, submit } = fixture()
  scheduler.register(backend('a').handle)
  const job = submit('job')
  await job.turn
  const artifact: ArtifactRef = { id: 'file', jobId: 'job', name: 'result', mime: 'text/plain', bytes: 3, sha256: 'a'.repeat(64), expiresAt: Date.now() + ARTIFACT_RETENTION_MS }
  job.finish({ state: 'succeeded', artifacts: [artifact] })
  artifact.name = 'changed'
  expect(scheduler.status('job')?.artifacts?.[0]?.name).toBe('result')
  await vi.advanceTimersByTimeAsync(ARTIFACT_RETENTION_MS - 1)
  expect(scheduler.status('job')?.state).toBe('succeeded')
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(1)
  expect(scheduler.status('job')).toBeUndefined()
})

test('a prepared job cancelled while paused finishes without waiting for a worker that never ran', async () => {
  const { scheduler, submit } = fixture()
  const other = backend('b', true), stopping = gate()
  other.handle.stop.mockImplementation(async () => { await stopping.promise })
  scheduler.register(backend('a').handle)
  scheduler.register(other.handle)
  const job = submit('job')
  await flush()
  scheduler.pause(true)
  stopping.resolve()
  await flush()
  expect(job.job.state).toBe('preparing')
  await scheduler.cancelAll('interrupted')
  expect(job.job.state).toBe('interrupted')
  expect(job.job.startedAt).toBeUndefined()
  await expect(job.turn).rejects.toMatchObject({ code: 'interrupted' })
  expect(scheduler.idle()).toBe(true)
})

test('custom injected timer durations and finished-history duration are honored', async () => {
  const { scheduler, submit, timer } = fixture({ idleMs: 50, keepFinishedMs: 100 })
  const worker = backend('a')
  scheduler.register(worker.handle)
  const job = submit('job')
  await job.turn
  job.finish({ state: 'failed', failure: { code: 'worker-failure', message: 'Failed.' } })
  expect(timer.mock.calls.at(-1)?.[1]).toBe(50)
  await vi.advanceTimersByTimeAsync(49)
  expect(worker.handle.stop).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(worker.handle.stop).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(49)
  expect(scheduler.status('job')?.state).toBe('failed')
  await vi.advanceTimersByTimeAsync(1)
  expect(scheduler.status('job')).toBeUndefined()
})

test('jobs submitted from a running observer are admitted without waiting for another event', async () => {
  const { scheduler, submit } = fixture()
  scheduler.register(backend('a').handle)
  let second: Admission | undefined
  scheduler.onJob((job) => {
    if (job.id !== 'first' || job.state !== 'running') return
    second = submit('second', 'a', { weight: 'light' })
  })
  const first = submit('first', 'a', { weight: 'light' })
  await first.turn
  expect(second?.job.state).toBe('running')
  await second?.turn
})

test('finished history is bounded at 200 outcomes and eviction follows completion order', async () => {
  const { scheduler, submit } = fixture()
  scheduler.register(backend('a').handle)
  scheduler.pause(true)
  const old = submit('old')
  for (let i = 0; i < 200; i++) { const job = submit(`job-${i}`); scheduler.cancel(job.job.id) }
  expect(scheduler.status('job-0')?.state).toBe('cancelled')
  old.finish({ state: 'failed', failure: { code: 'worker-failure', message: 'Failed.' } })
  expect(scheduler.status('job-0')).toBeUndefined()
  expect(scheduler.status('job-1')?.state).toBe('cancelled')
  expect(scheduler.status('old')?.state).toBe('failed')
})

test('known unfinished ids return the same admission, finished ids are refused, and snapshots are copies', async () => {
  const { scheduler, submit } = fixture()
  scheduler.register(backend('a').handle)
  const job = submit('job')
  expect(scheduler.submit({ id: 'job', worker: 'missing', kind: 'setup', weight: 'light', label: 'different' })).toBe(job)
  await job.turn
  const progress = { progress: 1, total: 10 }
  job.progress(progress)
  progress.progress = 9
  const status = scheduler.status('job')!
  status.state = 'failed'
  status.progress!.progress = 8
  expect(job.job).toMatchObject({ state: 'running', progress: { progress: 1 } })
  job.finish({ state: 'succeeded' })
  job.finish({ state: 'failed' })
  job.progress({ progress: 10 })
  expect(scheduler.status('job')?.state).toBe('succeeded')
  expect(() => submit('job')).toThrow(ComputeError)
  expect(() => scheduler.cancel('missing')).toThrow(ComputeError)
})

test('cancelAll reports interrupted after running workers acknowledge cancellation, without starting queued jobs', async () => {
  const { scheduler, submit } = fixture()
  scheduler.register(backend('a').handle)
  const first = submit('first'), light = submit('light', 'a', { weight: 'light' }), queued = submit('queued')
  await Promise.all([first.turn, light.turn])
  const failure = { code: 'interrupted' as const, message: 'The controller disconnected.' }
  const cancelled = scheduler.cancelAll('interrupted', failure)
  expect(queued.job.state).toBe('interrupted')
  expect(first.job.state).toBe('cancelling')
  expect(light.signal.aborted).toBe(true)
  let done = false
  void cancelled.then(() => { done = true })
  first.finish({ state: 'cancelled' })
  await flush()
  expect(done).toBe(false)
  light.finish({ state: 'failed' })
  await cancelled
  expect(first.job).toMatchObject({ state: 'interrupted', failure })
  expect(light.job).toMatchObject({ state: 'interrupted', failure })
  expect(queued.job.startedAt).toBeUndefined()
  expect(scheduler.idle()).toBe(true)
})

test('removing a worker fails its jobs, aborts its work, and releases its memory before another turn', async () => {
  const { scheduler, submit } = fixture()
  const a = backend('a', true), b = backend('b'), stopping = gate()
  a.handle.stop.mockImplementation(async () => { await stopping.promise })
  scheduler.register(a.handle)
  scheduler.register(b.handle)
  const running = submit('running'), queued = submit('queued'), next = submit('next', 'b')
  await running.turn
  const removed = scheduler.unregister('a')
  expect(scheduler.unregister('a')).toBe(removed)
  expect(running.job).toMatchObject({ state: 'failed', failure: { code: 'worker-failure' } })
  expect(running.signal.aborted).toBe(true)
  expect(queued.job.state).toBe('failed')
  expect(() => submit('unavailable')).toThrow(ComputeError)
  await flush()
  expect(next.job.state).toBe('preparing')
  stopping.resolve()
  await removed
  await next.turn
  expect(a.handle.stop).toHaveBeenCalledTimes(1)
})

test('observers receive state and progress changes, can unsubscribe, and cannot mutate snapshots', async () => {
  const { scheduler, submit } = fixture()
  scheduler.register(backend('a').handle)
  const states: JobSnapshot['state'][] = []
  const unsubscribe = scheduler.onJob((job) => { states.push(job.state); job.state = 'failed' })
  const change = vi.fn()
  const unchange = scheduler.onChange(change)
  const job = submit('job')
  await job.turn
  job.progress({ progress: 1 })
  job.finish({ state: 'succeeded' })
  expect(states).toEqual(['queued', 'preparing', 'running', 'running', 'succeeded'])
  expect(scheduler.status('job')?.state).toBe('succeeded')
  expect(change).toHaveBeenCalled()
  unsubscribe()
  unchange()
  const count = change.mock.calls.length
  scheduler.pause(true)
  expect(change).toHaveBeenCalledTimes(count)
})

test('close is shared, waits for active cancellation, stops every worker, and clears idle timers', async () => {
  const { scheduler, submit } = fixture()
  const a = backend('a'), b = backend('b')
  scheduler.register(a.handle)
  scheduler.register(b.handle)
  scheduler.hold('b')
  const first = submit('first'), queued = submit('queued')
  await first.turn
  const closing = scheduler.close()
  expect(scheduler.close()).toBe(closing)
  expect(first.job.state).toBe('cancelling')
  expect(queued.job.state).toBe('cancelled')
  expect(() => submit('later')).toThrow(ComputeError)
  expect(() => scheduler.hold('a')).toThrow(ComputeError)
  first.finish({ state: 'cancelled' })
  await closing
  expect(a.handle.stop).toHaveBeenCalledTimes(1)
  expect(b.handle.stop).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  expect(scheduler.idle()).toBe(true)
})
