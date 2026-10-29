// SPDX-License-Identifier: AGPL-3.0-only
export type { ResearchUpdate, ResearchSource } from '@alexia/protocol'
import { ResearchUpdate, type ResearchUpdate as Snapshot } from '@alexia/protocol'

/** Latest run per provider and conversation. Owned by the call, never the open viewer. */
export class ResearchRuns {
  #owners = new Map<string, object>()
  begin(plugin: string, conversation: string, owner: object): void { this.#owners.set(this.#key(plugin, conversation), owner) }
  #runs = new Map<string, { owner: object; snapshot: Snapshot }>()
  #key(plugin: string, conversation: string): string { return JSON.stringify([plugin, conversation]) }

  accept(plugin: string, conversation: string, owner: object, raw: unknown): Snapshot | undefined {
    if (this.#owners.get(this.#key(plugin, conversation)) !== owner) return
    const parsed = ResearchUpdate.safeParse(raw)
    if (!parsed.success || parsed.data.conversationId !== conversation) return
    const next = parsed.data
    if (new Set(next.sources.map((s) => s.id)).size !== next.sources.length) return
    const key = this.#key(plugin, conversation)
    const before = this.#runs.get(key)
    if (before?.owner === owner && (next.runId !== before.snapshot.runId || next.sequence <= before.snapshot.sequence || before.snapshot.completion !== 'running')) return
    next.counters = {
      read: next.sources.filter((s) => s.state === 'complete').length,
      inProgress: next.sources.filter((s) => s.state === 'fetching').length,
      failed: next.sources.filter((s) => s.state === 'unavailable').length,
    }
    this.#runs.set(key, { owner, snapshot: next })
    if (this.#runs.size > 50) this.#runs.delete(this.#runs.keys().next().value!)
    return next
  }

  get(plugin: string, conversation: string): Snapshot | undefined {
    return this.#runs.get(this.#key(plugin, conversation))?.snapshot
  }

  close(plugin: string, conversation: string, owner: object, cancelled: boolean): void {
    const key = this.#key(plugin, conversation)
    if (this.#owners.get(key) === owner) this.#owners.delete(key)
    const run = this.#runs.get(key)
    if (run?.owner !== owner || run.snapshot.completion !== 'running') return
    const sources = run.snapshot.sources.map((s) => s.state === 'fetching' ? { ...s, state: 'unavailable' as const, error: 'Research stopped before extraction completed.' } : s)
    run.snapshot = { ...run.snapshot, sequence: run.snapshot.sequence + 1, stage: 'finished', completion: cancelled ? 'cancelled' : 'failed', sources, counters: { read: sources.filter((s) => s.state === 'complete').length, inProgress: 0, failed: sources.filter((s) => s.state === 'unavailable').length }, gaps: [...run.snapshot.gaps, cancelled ? 'Research cancelled.' : 'Worker stopped before completing research.'].slice(-20) }
  }

  forget(conversation: string): void {
    for (const [key, run] of this.#runs) if (run.snapshot.conversationId === conversation) { this.#runs.delete(key); this.#owners.delete(key) }
  }
}
