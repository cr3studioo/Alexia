// SPDX-License-Identifier: AGPL-3.0-only
import type { LocalEntry, Quantized } from './localCatalog.js'
import { modelBudget, type Machine } from './machine.js'
import { PLANNER } from './catalog.js'

const GB = 1024 ** 3
export const DEFAULT_CONTEXT = 8192
export type Verdict = 'fits' | 'tight' | 'too-big' | 'disk'

export interface Fit {
  entry: LocalEntry
  quant: Quantized
  verdict: Verdict
  needBytes: number
  kvBytes: number
  overheadBytes: number
  context: number
  /** Only a real runner measurement can supply this; fit() never estimates throughput. */
  tokensPerSecond?: number
  note?: string
}

/**
 * FP16 K+V: 2 tensors × 2 bytes × layers × KV heads × head dimension, per token.
 * https://github.com/ggml-org/llama.cpp/blob/master/src/llama-kv-cache.cpp
 * Unknown architectures use a deliberately generous policy allowance, not a measured size.
 * It cannot establish that a model fits: those entries receive at most 'tight'.
 */
export function kvBytesPerToken(e: LocalEntry): number {
  return Number.isFinite(e.kvBytesPerToken) && (e.kvBytesPerToken ?? 0) > 0
    ? Math.ceil(e.kvBytesPerToken!) : Number.isFinite(e.params) && e.params > 0
      ? Math.max(64 * 1024, Math.ceil(e.params * 64 * 1024)) : 1024 ** 2
}

export function fit(m: Machine, e: LocalEntry, quant: Quantized, context = DEFAULT_CONTEXT): Fit {
  const requested = Number.isSafeInteger(context) && context > 0 ? context : DEFAULT_CONTEXT
  const length = e.contextMax > 0 ? Math.min(requested, e.contextMax) : requested
  // Cache allocation aligns token slots; leave an extra 10% for buffers and padding.
  const kvBytes = Math.ceil(Math.ceil(length / 256) * 256 * kvBytesPerToken(e) * 1.1)
  const validWeights = Number.isSafeInteger(quant.bytes) && quant.bytes > 0
  const overheadBytes = validWeights ? Math.ceil(Math.max(GB, quant.bytes * 0.15)) : GB
  const needBytes = validWeights ? quant.bytes + kvBytes + overheadBytes : Infinity
  const budget = modelBudget(m)
  // A reserve remains on the download volume for runtime, partial-file metadata and other work.
  const diskNeed = validWeights ? quant.bytes + GB : Infinity
  const knownKv = Number.isFinite(e.kvBytesPerToken) && (e.kvBytesPerToken ?? 0) > 0
  let verdict: Verdict = needBytes <= budget * 0.9 && knownKv ? 'fits' : needBytes <= budget ? 'tight' : 'too-big'
  if (!Number.isFinite(m.freeDiskBytes) || m.freeDiskBytes < diskNeed || m.diskKnown === false) verdict = 'disk'
  return { entry: e, quant, verdict, needBytes, kvBytes, overheadBytes, context: length,
    ...(!knownKv && { note: 'KV layout is unknown; memory is a cautious allowance. Check the runner before use.' }),
    ...(m.diskKnown === false && { note: 'Available disk space could not be read.' }) }
}

/** Prefer Q4_K_M for the initial download; do not silently trade it for a 3-bit build. */
export function bestQuant(m: Machine, e: LocalEntry): Fit | undefined {
  const preference = ['Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'Q3_K_M', 'IQ3_M']
  const choices = e.quants.map((q) => fit(m, e, q)).sort((a, b) => {
    const order = (q: string): number => { const n = preference.indexOf(q); return n < 0 ? preference.length : n }
    return order(a.quant.quant) - order(b.quant.quant) || a.quant.bytes - b.quant.bytes
  })
  return choices.find((f) => f.verdict === 'fits') ?? choices.find((f) => f.verdict === 'tight') ?? choices[0]
}

export interface Recommendations {
  best?: Fit
  /** Smaller memory footprint; the legacy name does not promise a measured speed. */
  fast?: Fit
  tools?: Fit
  all: Fit[]
  uncensored: Fit[]
}

/** Size ordering is a selection policy, not a quality benchmark. Only comfortable fits are picks. */
export function recommend(m: Machine, catalog: readonly LocalEntry[]): Recommendations {
  const selected = catalog.flatMap((e) => { const f = bestQuant(m, e); return f ? [f] : [] })
  const all = selected.filter((f) => !f.entry.abliterated).sort((a, b) => b.entry.params - a.entry.params || a.entry.id.localeCompare(b.entry.id))
  const uncensored = selected.filter((f) => f.entry.abliterated).sort((a, b) => b.entry.params - a.entry.params || a.entry.id.localeCompare(b.entry.id))
  const eligible = all.filter((f) => f.verdict === 'fits' && !f.entry.gated && !f.entry.licence.restrictive && f.entry.licence.name !== 'unknown')
  const smaller = [...eligible].sort((a, b) => a.needBytes - b.needBytes || a.entry.id.localeCompare(b.entry.id))
  return { all, uncensored, best: eligible[0], fast: smaller[0], tools: eligible.find((f) => f.entry.tools && f.entry.params >= PLANNER) }
}
