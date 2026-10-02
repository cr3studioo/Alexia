// SPDX-License-Identifier: AGPL-3.0-only
import type { Artifacts } from './artifacts.js'
import type { Inventory } from './inventory.js'
import type { Admission, Scheduler } from './scheduler.js'
import { scrub } from './scrub.js'
import { ComputeError, type JobSnapshot, type SetupRequirement } from './types.js'
import type { ComputeWorker, Workers } from './workers.js'

export const CANCEL_STOP_MS = 15_000
export type WorkerTimer = (fn: () => void, ms: number) => { clear(): void }
const timer: WorkerTimer = (fn, ms) => {
  const deadline = setTimeout(fn, ms).unref()
  return { clear: () => clearTimeout(deadline) }
}

/** MCP abort rejects locally before the process acknowledges it: keep its slot until it stops. */
export async function runWorker<T>(worker: ComputeWorker, signal: AbortSignal, run: () => Promise<T>, clock: WorkerTimer = timer): Promise<T> {
  signal.throwIfAborted()
  let live = true
  let stopping = false
  let deadline: { clear(): void } | undefined
  let resolveStop!: () => void
  const stopped = new Promise<never>((_resolve, reject) => { resolveStop = () => { reject(signal.reason) } })
  // It may reject after `run` already rejected; both paths are observed before the timer can fire.
  void stopped.catch(() => {})
  const cancel = (): void => {
    deadline = clock(() => {
      if (!live || stopping) return
      stopping = true
      void Promise.resolve().then(() => worker.stop({ force: true })).catch(() => {}).finally(resolveStop)
    }, CANCEL_STOP_MS)
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    try {
      const result = await Promise.race([run(), stopped])
      // Once stop started, a late result cannot let the next job use a process still stopping.
      if (stopping) await stopped.catch(() => {})
      return result
    }
    catch (error) {
      // A normal returned result confirms completion. An aborted MCP rejection does not.
      if (signal.aborted && deadline) await stopped.catch(() => {})
      throw error
    }
  } finally {
    live = false
    signal.removeEventListener('abort', cancel)
    deadline?.clear()
  }
}

/**
 * Guided setup on the host: a list of what is missing, and one install per press of a button.
 * Listing never installs, and an install is only ever one requirement the last list named.
 */
export class Setup {
  /** Job id → the requirement it installs, while it runs. */
  readonly #running = new Map<string, string>()

  constructor(private readonly options: { workers: Workers; scheduler: Scheduler; artifacts: Artifacts; inventory: Inventory; timer?: WorkerTimer }) {}

  /** Everything missing, from every worker. Sizes where the worker knows them. */
  async requirements(): Promise<SetupRequirement[]> {
    return (await this.options.inventory.refresh('setup')).setup
  }

  /** Start one install as a light `setup` job named by the controller. Throws ComputeError('not-found' | 'refused'). */
  install(requirementId: string, jobId: string): JobSnapshot {
    const { scheduler, artifacts, inventory, workers } = this.options
    const found = inventory.requirement(requirementId)
    if (!found || !workers.all().includes(found.worker)) throw new ComputeError('not-found', 'That setup requirement is not known.')
    if (found.requirement.action !== 'install') throw new ComputeError('refused', 'That requirement has to be done by a person on that computer.')
    const known = this.#running.get(jobId)
    if (known === requirementId) return scheduler.submit({ id: jobId, kind: 'setup', weight: 'light', label: found.requirement.title, worker: found.worker.id }).job
    if (known !== undefined) throw new ComputeError('refused', 'That job is installing something else.')
    if ([...this.#running.values()].includes(requirementId)) throw new ComputeError('refused', 'That requirement is already being installed.')

    // The job's folder comes first: an id the artifact store would not take is refused before anything is queued.
    artifacts.claimed(jobId)
    let admission: Admission
    try {
      admission = scheduler.submit({ id: jobId, kind: 'setup', weight: 'light', label: found.requirement.title, worker: found.worker.id })
    } catch (error) {
      void artifacts.sweep().catch(() => {})
      throw error instanceof ComputeError && error.code !== 'worker-failure' ? error : new ComputeError('refused', 'That worker is not available.')
    }
    this.#running.set(jobId, requirementId)
    void (async () => {
      try {
        await admission.turn
        artifacts.claimed(jobId)
        const install = (): Promise<void> => found.worker.install(found.requirement.id, {
          signal: admission.signal, dir: artifacts.jobDir(jobId),
          progress: (progress) => admission.progress(progress), output: () => {},
        })
        if (found.worker === workers.text) await install()
        else await runWorker(found.worker, admission.signal, install, this.options.timer)
        admission.finish({ state: 'succeeded' })
      } catch (error) {
        admission.finish(admission.signal.aborted ? { state: 'cancelled' } : {
          state: 'failed',
          failure: error instanceof ComputeError ? { code: error.code, message: scrub(error.message) } : { code: 'worker-failure', message: 'The install could not finish.' },
        })
      } finally {
        this.#running.delete(jobId)
        await artifacts.sweep().catch(() => {})
        // Whatever happened, the list is asked again: an install that half worked is still missing.
        await inventory.refresh('setup').catch(() => {})
      }
    })()
    return admission.job
  }
}
