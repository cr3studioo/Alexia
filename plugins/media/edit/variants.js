// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomInt } from 'node:crypto'

/**
 * *Generate 4 versions* means four independent candidates from one frozen snapshot — same
 * source, same references, same validated intent, same settings — that differ only in their
 * recorded seeds. Never an edit applied to its own output.
 *
 * Pure bookkeeping: seeds, slots and what a batch's state is, given its candidates'.
 */

/** Distinct seeds inside the profile's range; a person's own seed is the first one. */
export function seeds(count, range, chosen = null, pick = randomInt) {
  if (range.max - range.min + 1 < count) throw new Error('The seed range is smaller than the number of versions.')
  const out = []
  if (chosen !== null) out.push(chosen)
  while (out.length < count) {
    // `randomInt` takes at most 2^48 - 1 as its span; the range is clamped to that.
    const span = Math.min(range.max - range.min + 1, 2 ** 48 - 1)
    const seed = range.min + pick(span)
    if (!out.includes(seed)) out.push(seed)
  }
  return out
}

/** The seed of pass `i` of a multi-note candidate, derived and recorded, never re-rolled. */
export function passSeed(seed, i, range) {
  const h = createHash('sha256').update(`${seed}:${i}`).digest()
  const span = range.max - range.min + 1
  return range.min + Number(h.readBigUInt64BE(0) % BigInt(span))
}

const TERMINAL = new Set(['completed', 'needs_clarification', 'unsupported', 'blocked', 'failed', 'cancelled'])
export const isTerminal = (state) => TERMINAL.has(state)

/** A batch is done when every slot is; partial when some, not all, completed. */
export function batchState(candidates) {
  if (candidates.some((c) => !isTerminal(c.state))) return 'active'
  const done = candidates.filter((c) => c.state === 'completed').length
  if (done === candidates.length) return 'completed'
  if (candidates.every((c) => c.state === 'cancelled')) return 'cancelled'
  if (done > 0) return 'partial'
  return candidates.some((c) => c.state === 'cancelled') && candidates.every((c) => c.state === 'cancelled' || c.state === 'failed') ? 'cancelled' : 'failed'
}

/** Progress words: *Version 2 of 4*. */
export const progressLabel = (slot, count) => (count === 1 ? 'Generating' : `Version ${slot} of ${count}`)

/** How many masked passes a request costs — shown before generating, never hidden. */
export const passCount = (variantCount, activeNotes) => variantCount * Math.max(1, activeNotes)
