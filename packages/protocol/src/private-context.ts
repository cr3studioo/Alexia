// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'

/** Reserved until core enforces every constraint. Do not raise MAX merely to expose types. */
export const PRIVATE_CONTEXT_PROTOCOL = 14
export const ATTACHMENT_INPUTS_META = 'alexia/attachmentInputs'
export const ATTACHMENT_CONTEXT_META = 'alexia/attachmentContext'
export const LOCAL_META = 'alexia/local'
export const FORMAT_META = 'alexia/format'
export const PRIVATE_CONTEXT_CAPABILITY = 'alexia/privateContext'
/**
 * Request `_meta` core sets when the person turned adult content on in Settings (saying they are
 * 18 or older) and `/nsfw` is on. Only core sets it; a plugin never reads it from arguments.
 */
export const ADULT_META = 'alexia/adult'

export const PRIVATE_LIMITS = {
  schemaBytes: 32_768,
  schemaDepth: 16,
  plannerBytes: 32_768,
  requestCharacters: 8_000,
  imageInputs: 3,
  regions: 8,
  regionCharacters: 600,
} as const

export const OpaqueId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
export const AttachmentLabel = z.string().regex(/^image_[1-9][0-9]*$/).max(64)
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/)
export const ImageDimensions = z.strictObject({ width: z.int().positive(), height: z.int().positive() })

/** Tool declarations name only top-level fields; ordinary prompt strings are never resolved. */
export const AttachmentInputs = z.strictObject({
  fields: z.array(z.strictObject({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    cardinality: z.enum(['one', 'many']),
    mimeTypes: z.array(z.string().min(1)).min(1),
    maxCount: z.int().positive(),
  })).min(1),
}).superRefine(({ fields }, ctx) => {
  if (new Set(fields.map((f) => f.name)).size !== fields.length) {
    ctx.addIssue({ code: 'custom', message: 'attachment fields must be unique' })
  }
  if (fields.some((f) => f.cardinality === 'one' && f.maxCount !== 1)) {
    ctx.addIssue({ code: 'custom', message: 'a single attachment field has maxCount 1' })
  }
})
export type AttachmentInputs = z.infer<typeof AttachmentInputs>

export const AttachmentDescriptor = z.strictObject({
  id: OpaqueId,
  label: AttachmentLabel,
  displayName: z.string().min(1).max(512),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  dimensions: ImageDimensions,
  bytes: z.int().positive(),
  sha256: Sha256,
})
export type AttachmentDescriptor = z.infer<typeof AttachmentDescriptor>

/** Core creates this after authorization and pinning. Never put it in model arguments. */
export const AttachmentCallContext = z.strictObject({
  version: z.literal('1'),
  conversationId: OpaqueId,
  requestId: OpaqueId,
  selectionId: OpaqueId,
  leaseId: OpaqueId,
  attachments: z.array(AttachmentDescriptor.extend({ path: z.string().min(1) })).min(1),
}).superRefine(({ attachments }, ctx) => {
  for (const field of ['id', 'label'] as const) {
    if (new Set(attachments.map((a) => a[field])).size !== attachments.length) {
      ctx.addIssue({ code: 'custom', message: `attachment ${field}s must be unique` })
    }
  }
})
export type AttachmentCallContext = z.infer<typeof AttachmentCallContext>

/** These are enforcement promises, scoped to the current request, not cached preferences. */
export const PrivateContextCapabilities = z.strictObject({
  version: z.literal('1'),
  attachmentContext: z.literal(true),
  interactionOnlySampling: z.literal(true),
  structuredSampling: z.literal(true),
  revocablePublication: z.literal(true),
  imageJobVersions: z.array(z.enum(['1.1', '1.2'])).min(1),
})
export type PrivateContextCapabilities = z.infer<typeof PrivateContextCapabilities>

/**
 * **What a core that enforces all of this sends with each private call** — in request `_meta`
 * under {@link PRIVATE_CONTEXT_CAPABILITY}, as `{ protocol, capabilities }`. Sent per request,
 * never cached: a plugin checks it with {@link negotiatePrivateContext} before it acts.
 */
export const PRIVATE_CONTEXT_PROMISE: PrivateContextCapabilities = {
  version: '1',
  attachmentContext: true,
  interactionOnlySampling: true,
  structuredSampling: true,
  revocablePublication: true,
  imageJobVersions: ['1.1', '1.2'],
}

/** Both version and explicit promises are required; an unknown metadata key is insufficient. */
export function negotiatePrivateContext(
  protocol: number,
  capabilities: unknown,
  jobVersion: '1.1' | '1.2',
): { ok: true } | { ok: false; reason: 'protocol_unsupported' | 'capability_unavailable' | 'schema_unsupported' } {
  if (!Number.isSafeInteger(protocol) || protocol < PRIVATE_CONTEXT_PROTOCOL) {
    return { ok: false, reason: 'protocol_unsupported' }
  }
  const parsed = PrivateContextCapabilities.safeParse(capabilities)
  if (!parsed.success) return { ok: false, reason: 'capability_unavailable' }
  if (!parsed.data.imageJobVersions.includes(jobVersion)) return { ok: false, reason: 'schema_unsupported' }
  return { ok: true }
}

/** No references, executable formats, regexes or open-ended schema dialects. A03 serializes it. */
export function supportedSamplingSchema(value: unknown): boolean {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > PRIVATE_LIMITS.schemaBytes) return false
    const node = (v: unknown, depth: number): boolean => {
      if (depth > PRIVATE_LIMITS.schemaDepth || v === null || typeof v !== 'object' || Array.isArray(v)) return false
      const o = v as Record<string, unknown>
      const types = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
      const validType = (t: unknown) => typeof t === 'string' && types.includes(t)
      for (const [key, entry] of Object.entries(o)) {
        switch (key) {
          case 'type':
            if (!(validType(entry) || (Array.isArray(entry) && entry.length > 0 && entry.every(validType)))) return false
            break
          case 'properties':
            if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false
            if (!Object.values(entry).every((child) => node(child, depth + 1))) return false
            break
          case 'items':
            if (!node(entry, depth + 1)) return false
            break
          case 'required':
            if (!Array.isArray(entry) || !entry.every((s) => typeof s === 'string') || new Set(entry).size !== entry.length) return false
            break
          case 'additionalProperties':
            if (entry !== false) return false
            break
          case 'enum':
            if (!Array.isArray(entry) || entry.length === 0 || !entry.every(scalar)) return false
            break
          case 'const':
            if (!scalar(entry)) return false
            break
          case 'minimum': case 'maximum':
            if (typeof entry !== 'number' || !Number.isFinite(entry)) return false
            break
          case 'minLength': case 'maxLength': case 'minItems': case 'maxItems':
            if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0) return false
            break
          case 'description': case 'title':
            if (typeof entry !== 'string') return false
            break
          default: return false
        }
      }
      return Object.keys(o).length > 0
    }
    return node(value, 0)
  } catch {
    return false
  }
}
function scalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
}
export const SamplingFormat = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  schema: z.record(z.string(), z.json()).refine(supportedSamplingSchema, 'unsupported or oversized sampling schema'),
  strict: z.literal(true),
})
export type SamplingFormat = z.infer<typeof SamplingFormat>
export const PrivateSamplingMeta = z.strictObject({
  [LOCAL_META]: z.literal(true),
  [FORMAT_META]: SamplingFormat,
})
export type PrivateSamplingMeta = z.infer<typeof PrivateSamplingMeta>

/** The local placement is the interaction computer, including every retry and hedge. */
export interface PrivateSamplingOptions {
  meta: PrivateSamplingMeta
  maxTokens: number
  deadlineAt: number
  signal: AbortSignal
}

/** A02 owns bytes; revocation precedes callbacks and publication checks the same lease. */
export interface AttachmentLifecycle {
  resolve(conversationId: string, selectionId: string, labels: readonly string[], signal: AbortSignal): Promise<AttachmentCallContext>
  release(leaseId: string): Promise<void>
  isLive(leaseId: string): Promise<boolean>
  revoke(conversationId: string): Promise<CleanupReceipt>
}
export const CleanupReceipt = z.strictObject({
  revocationId: OpaqueId,
  local: z.enum(['pending', 'complete', 'failed']),
  remote: z.array(z.strictObject({
    hostId: OpaqueId,
    state: z.enum(['pending', 'complete', 'failed']),
    reason: z.string().max(200).nullable(),
  })),
})
export type CleanupReceipt = z.infer<typeof CleanupReceipt>
export interface PrivateDeletionParticipant {
  revoke(conversationId: string, revocationId: string): Promise<void>
  cleanup(conversationId: string, revocationId: string): Promise<CleanupReceipt>
}
