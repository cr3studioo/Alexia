// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs'
import { readInstalled, remember } from './installed.js'
import type { Provider } from './provider.js'

export interface RunnerLease {
  baseUrl: string
  key: string
  release(): void
}
export interface ManagedRunner {
  ensure(model: string, signal?: AbortSignal, options?: { download?: boolean }): Promise<string>
  acquire(model: string, signal?: AbortSignal): Promise<RunnerLease>
  loaded(): { model: string; baseUrl: string; since: number; pid?: number } | undefined
  stop(): Promise<void>
}
interface Entry { id: 'llama' | 'mlx'; server: ManagedRunner; provider: Provider }

/** Coordinate the two engines: stop the previous backend before loading the next one.
 * Broker leases keep active answers alive even when an engine's stop forces termination. */
export class LocalRunners {
  private queue: Promise<unknown> = Promise.resolve()
  private stopping = new AbortController()
  private stopPromise?: Promise<void>
  private readonly leases = new Map<Entry, number>()
  private readonly drained = new Set<() => void>()

  private async drain(entries: readonly Entry[], signal?: AbortSignal): Promise<void> {
    const busy = (): boolean => entries.some((entry) => (this.leases.get(entry) ?? 0) > 0)
    signal?.throwIfAborted()
    if (!busy()) return
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { this.drained.delete(check); signal?.removeEventListener('abort', abort) }
      const check = (): void => { if (!busy()) { cleanup(); resolve() } }
      const abort = (): void => { cleanup(); reject(signal?.reason) }
      this.drained.add(check)
      signal?.addEventListener('abort', abort, { once: true })
      check()
    })
  }

  private track(entry: Entry, lease: RunnerLease): RunnerLease {
    this.leases.set(entry, (this.leases.get(entry) ?? 0) + 1)
    let released = false
    return { ...lease, release: () => {
      if (released) return
      released = true
      try { lease.release() } finally {
        this.leases.set(entry, this.leases.get(entry)! - 1)
        for (const check of this.drained) check()
      }
    } }
  }
  constructor(private readonly dataDir: string, private readonly entries: readonly Entry[]) {}

  private entry(model: string): Entry {
    const one = readInstalled(this.dataDir).find((row) => row.id === model)
    if (!one || !one.files.every((file) => existsSync(file))) throw new Error('The local model is not installed or its files are missing.')
    const entry = this.entries.find((row) => row.id === (one.format === 'mlx' ? 'mlx' : 'llama'))
    if (!entry) throw new Error('The runner for this model is not available on this computer.')
    return entry
  }

  private async start<T>(model: string, signal: AbortSignal | undefined, action: (runner: ManagedRunner, signal: AbortSignal) => Promise<T>, expected?: Entry): Promise<T> {
    const combined = AbortSignal.any([this.stopping.signal, ...(signal ? [signal] : [])])
    combined.throwIfAborted()
    const pending = this.queue.then(async () => {
      combined.throwIfAborted()
      const entry = this.entry(model)
      if (expected && entry !== expected) throw new Error('This model belongs to another local runner.')
      const others = this.entries.filter((other) => other !== entry)
      await this.drain(entry.server.loaded()?.model !== model ? this.entries : others, combined)
      for (const other of others) await other.server.stop()
      combined.throwIfAborted()
      const value = await action(entry.server, combined)
      if (combined.aborted) {
        if (typeof value === 'object' && value !== null && 'release' in value) (value as unknown as RunnerLease).release()
        combined.throwIfAborted()
      }
      return value
    })
    this.queue = pending.catch(() => undefined)
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => reject(combined.reason)
      combined.addEventListener('abort', abort, { once: true })
      pending.then((value) => {
        combined.removeEventListener('abort', abort)
        if (combined.aborted) {
          if (typeof value === 'object' && value !== null && 'release' in value) (value as unknown as RunnerLease).release()
          reject(combined.reason)
        } else resolve(value)
      }, (error) => { combined.removeEventListener('abort', abort); reject(error) })
    })
  }

  ensure(model: string, signal?: AbortSignal, options?: { download?: boolean }): Promise<string> {
    return this.start(model, signal, (runner, combined) => runner.ensure(model, combined, options))
  }

  providers(): Provider[] {
    return this.entries.map((entry) => ({ ...entry.provider, prepare: (model, signal) => this.start(model, signal, async (runner, combined) => {
      const lease = await runner.acquire(model, combined)
      const one = readInstalled(this.dataDir).find((row) => row.id === model)
      try {
        if (one) {
          const lastUsedAt = Date.now()
          remember(this.dataDir, { ...one, lastUsedAt })
          const draft = one.draftModelId && readInstalled(this.dataDir).find((row) => row.id === one.draftModelId)
          if (draft) remember(this.dataDir, { ...draft, lastUsedAt })
        }
      }
      catch (error) { lease.release(); throw error }
      return this.track(entry, lease)
    }, entry) }))
  }

  provider(model: string): Provider {
    const id = this.entry(model).id
    return this.providers().find((provider) => provider.id === id)!
  }

  loaded(): ReturnType<ManagedRunner['loaded']> {
    return this.entries.map((entry) => entry.server.loaded()).find((one) => one !== undefined)
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopping.abort(new Error('Local runners stopped.'))
    this.stopPromise = this.queue.then(async () => {
      await this.drain(this.entries)
      const results = await Promise.allSettled(this.entries.map((entry) => entry.server.stop()))
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }).finally(() => { this.stopping = new AbortController(); this.stopPromise = undefined })
    return this.stopPromise
  }
}
