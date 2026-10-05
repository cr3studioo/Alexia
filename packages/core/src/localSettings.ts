// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs'
import { fit, type Verdict } from './fit.js'
import type { Installed } from './installed.js'
import type { LocalEntry } from './localCatalog.js'
import { modelBudget, type Machine } from './machine.js'

export type Cache = 'f16' | 'q8_0' | 'q4_0'
const caches: readonly Cache[] = ['f16', 'q8_0', 'q4_0']
const DAY = 24 * 60 * 60 * 1000

export function installedEntry(one: Installed, cache: Cache = one.kvCache ?? 'f16'): LocalEntry {
  const fraction = cache === 'q8_0' ? 0.6 : cache === 'q4_0' ? 0.35 : 1
  return {
    id: one.id, format: one.format, name: one.name, publisher: 'Installed', repo: one.repo,
    revision: one.revision, params: one.params ?? 0, contextMax: one.contextMax ?? one.context,
    tools: one.tools, vision: one.vision, licence: { name: one.licence ?? 'unknown', url: '', restrictive: false },
    gated: false, abliterated: one.abliterated, nsfwOk: one.nsfwOk, blurb: '',
    quants: [{ quant: one.quant, bytes: one.bytes, files: [] }],
    ...(one.kvBytesPerToken !== undefined && { kvBytesPerToken: Math.ceil(one.kvBytesPerToken * fraction) }),
  }
}

/** Exact tokenizer identity is required before offering a draft, even if filenames look alike. */
export function draftCandidates(one: Installed, all: readonly Installed[]): Installed[] {
  // The pinned upstream MLX sampler has known greedy-decoding issues for Qwen3. Keep its
  // drafts disabled until an upstream release passes the correctness probe.
  if ((one.format ?? 'gguf') !== 'gguf') return []
  return all.filter((draft) => draft.id !== one.id && draft.ready !== false && draft.files.every((file) => existsSync(file)) &&
    (draft.format ?? 'gguf') === (one.format ?? 'gguf') && !!one.tokenizerFingerprint &&
    draft.tokenizerFingerprint === one.tokenizerFingerprint && (!one.architecture || !draft.architecture || one.architecture === draft.architecture) && !!one.params && !!draft.params &&
    draft.params < one.params && !draft.draftModelId)
}

export function contextPreview(m: Machine, one: Installed, all: readonly Installed[], context = one.context, cache: Cache = one.kvCache ?? 'f16', draftId: string | null | undefined = one.draftModelId): {
  context: number; contextMax: number; needBytes: number; verdict: Verdict; note?: string;
  drafts: { id: string; name: string }[]; kvOptions: readonly Cache[]
} {
  const max = one.contextMax ?? one.context
  if (!Number.isSafeInteger(context) || context < 256 || context > max) throw new Error(`Choose a context from 256 to ${max} tokens.`)
  if (!caches.includes(cache)) throw new Error('Choose a supported KV cache precision.')
  if (cache !== 'f16' && !one.kvBytesPerToken) throw new Error('KV quantization requires known model cache metadata.')
  const entry = installedEntry(one, cache)
  const judged = fit({ ...m, freeDiskBytes: Number.MAX_SAFE_INTEGER, diskKnown: true }, entry, entry.quants[0]!, context)
  const drafts = draftCandidates(one, all)
  let extra = 0
  if (draftId) {
    const draft = drafts.find((candidate) => candidate.id === draftId)
    if (!draft) throw new Error('Choose a smaller installed draft with the same tokenizer and model format.')
    if ((draft.contextMax ?? draft.context) < context) throw new Error('The draft cannot hold this context size.')
    const draftEntry = installedEntry(draft, 'f16')
    extra = fit({ ...m, freeDiskBytes: Number.MAX_SAFE_INTEGER, diskKnown: true }, draftEntry, draftEntry.quants[0]!, context).needBytes
  }
  const needBytes = judged.needBytes + extra
  const budget = modelBudget(m)
  const verdict = needBytes > budget ? 'too-big' : extra > 0 && needBytes > budget * 0.9 ? 'tight' : judged.verdict
  return { context, contextMax: max, needBytes, verdict, ...(judged.note && { note: judged.note }),
    drafts: drafts.map(({ id, name }) => ({ id, name })), kvOptions: one.kvBytesPerToken ? caches : ['f16'] }
}

/** Suggestions are data only: no downloads, pins or files are changed. */
export function maintenance(m: Machine, all: readonly Installed[], catalog: readonly LocalEntry[], pinned?: string, now = Date.now()) {
  const updates = all.flatMap((one) => {
    const exact = catalog.find((entry) => entry.id === one.entry)
    if (!exact || exact.revision === one.revision) return []
    const quant = exact.quants.find((candidate) => candidate.quant === one.quant)
    if (!quant || !['fits', 'tight'].includes(fit(m, exact, quant).verdict)) return []
    return [{ installedId: one.id, entry: exact.id, name: exact.name, reason: 'The curated catalog has a different pinned revision in this quantization. Review its release notes; installing checks it before changing your choice.' }]
  })
  const cleanup = all.filter((one) => one.id !== pinned && one.owned !== false && now - (one.lastUsedAt ?? one.installedAt) >= 30 * DAY)
    .map((one) => ({ id: one.id, name: one.name, bytes: one.bytes, ...(one.lastUsedAt !== undefined && { lastUsedAt: one.lastUsedAt }), reason: 'Not used in the last 30 days.' }))
  return { updates, cleanup, reclaimableBytes: cleanup.reduce((total, one) => total + one.bytes, 0) }
}
