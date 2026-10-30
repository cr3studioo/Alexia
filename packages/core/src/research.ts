// SPDX-License-Identifier: AGPL-3.0-only
export type { ResearchUpdate, ResearchSource } from '@alexia/protocol'
import { ResearchUpdate, type ResearchUpdate as Snapshot } from '@alexia/protocol'

/** How a call that reported research ended. */
export type Ending = 'complete' | 'failed' | 'cancelled'

/**
 * Latest run per provider and conversation. Owned by the call, never the open viewer.
 * Several calls to one plugin can be open at once; each keeps reporting until it ends, and the
 * newest call that has reported holds the viewer, so an older call cannot take it back.
 */
export class ResearchRuns {
  #owners = new Map<string, Map<object, number>>()
  #begun = 0
  begin(plugin: string, conversation: string, owner: object): void {
    const key = this.#key(plugin, conversation)
    const open = this.#owners.get(key) ?? new Map<object, number>()
    open.set(owner, ++this.#begun)
    this.#owners.set(key, open)
  }
  #runs = new Map<string, { owner: object; snapshot: Snapshot }>()
  #key(plugin: string, conversation: string): string { return JSON.stringify([plugin, conversation]) }

  accept(plugin: string, conversation: string, owner: object, raw: unknown): Snapshot | undefined {
    const open = this.#owners.get(this.#key(plugin, conversation))
    const order = open?.get(owner)
    if (order === undefined) return
    const parsed = ResearchUpdate.safeParse(raw)
    if (!parsed.success || parsed.data.conversationId !== conversation) return
    const next = parsed.data
    if (new Set(next.sources.map((s) => s.id)).size !== next.sources.length) return
    const key = this.#key(plugin, conversation)
    const before = this.#runs.get(key)
    if (before !== undefined && before.owner !== owner && (open!.get(before.owner) ?? 0) > order) return
    if (before?.owner === owner && (next.runId !== before.snapshot.runId || next.sequence <= before.snapshot.sequence || before.snapshot.completion !== 'running')) return
    next.counters = {
      read: next.sources.filter((s) => s.state === 'complete').length,
      inProgress: next.sources.filter((s) => s.state === 'fetching').length,
      failed: next.sources.filter((s) => s.state === 'unavailable').length,
    }
    // Re-inserted, so the cap below drops the run that went quiet longest, not the oldest one.
    this.#runs.delete(key)
    this.#runs.set(key, { owner, snapshot: next })
    if (this.#runs.size > 50) this.#runs.delete(this.#runs.keys().next().value!)
    return next
  }

  get(plugin: string, conversation: string): Snapshot | undefined {
    return this.#runs.get(this.#key(plugin, conversation))?.snapshot
  }

  /**
   * The call is over. A run still marked running is settled by how the call ended: a tool that
   * returned its answer completed the research, even if its last progress report said otherwise.
   */
  close(plugin: string, conversation: string, owner: object, ending: Ending): void {
    const key = this.#key(plugin, conversation)
    const open = this.#owners.get(key)
    open?.delete(owner)
    if (open?.size === 0) this.#owners.delete(key)
    const run = this.#runs.get(key)
    if (run?.owner !== owner || run.snapshot.completion !== 'running') return
    const sources = run.snapshot.sources.map((s) => s.state === 'fetching' ? { ...s, state: 'unavailable' as const, error: 'Research stopped before extraction completed.' } : s)
    const gap = ending === 'cancelled' ? ['Research cancelled.'] : ending === 'failed' ? ['Worker stopped before completing research.'] : []
    run.snapshot = { ...run.snapshot, sequence: run.snapshot.sequence + 1, stage: 'finished', completion: ending, sources, counters: { read: sources.filter((s) => s.state === 'complete').length, inProgress: 0, failed: sources.filter((s) => s.state === 'unavailable').length }, gaps: [...run.snapshot.gaps, ...gap].slice(-20) }
  }

  forget(conversation: string): void {
    for (const [key, run] of this.#runs) if (run.snapshot.conversationId === conversation) { this.#runs.delete(key); this.#owners.delete(key) }
  }
}
