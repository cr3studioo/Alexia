// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'
import { ImageDimensions, OpaqueId, Sha256, PRIVATE_LIMITS, CleanupReceipt } from './private-context.js'

/** These are trusted editor envelopes, never the planner-owned ImageJob semantic schema. */
export const EditorOperation = z.enum(['image_edit', 'inpaint', 'remove_fill', 'crop', 'resize', 'erase_alpha'])
export type EditorOperation = z.infer<typeof EditorOperation>
export const VariantCount = z.union([z.literal(1), z.literal(2), z.literal(4)])
export const ProfileSelection = z.strictObject({ id: OpaqueId, version: z.string().min(1).max(128) })
export type ProfileSelection = z.infer<typeof ProfileSelection>
export const RenderDestination = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('interaction') }),
  z.strictObject({ kind: z.literal('paired'), hostId: OpaqueId, displayName: z.string().min(1).max(128) }),
])
export type RenderDestination = z.infer<typeof RenderDestination>

const Range = z.strictObject({ min: z.number().finite(), max: z.number().finite(), default: z.number().finite() })
  .refine((r) => r.min <= r.default && r.default <= r.max, 'default must be inside the range')
export const ProfileDescriptor = z.strictObject({
  selection: ProfileSelection,
  name: z.string().min(1).max(128),
  /** Documented by its publisher as not refusing adult content; preferred in adult mode. */
  uncensored: z.boolean(),
  operations: z.array(EditorOperation).min(1),
  jobVersions: z.array(z.enum(['1.1', '1.2'])).min(1),
  maxInputs: z.int().min(1).max(PRIVATE_LIMITS.imageInputs),
  destination: RenderDestination,
  availability: z.enum(['available', 'needs_installation', 'unverified', 'incompatible', 'offline']),
  reason: z.string().max(300).nullable(),
  evidenceId: OpaqueId.nullable(),
  measuredMemory: z.strictObject({ gpuBytes: z.int().nonnegative(), hostBytes: z.int().positive() }).nullable(),
  dimensions: z.array(ImageDimensions).min(1),
  controls: z.strictObject({
    presets: z.array(z.string().min(1).max(64)),
    steps: Range.nullable(),
    changeAmount: Range.nullable(),
    seed: z.strictObject({ min: z.int().nonnegative(), max: z.int().nonnegative() })
      .refine((r) => r.min <= r.max, 'invalid seed range'),
  }),
  batchSize: z.literal(1),
}).superRefine((p, ctx) => {
  if ((p.evidenceId === null) !== (p.measuredMemory === null)) {
    ctx.addIssue({ code: 'custom', message: 'benchmark evidence and measured memory must be supplied together' })
  }
  if (p.availability !== 'available' && !p.reason) {
    ctx.addIssue({ code: 'custom', message: 'unavailable profiles need an actionable reason' })
  }
  if (p.operations.some((o) => o === 'inpaint' || o === 'remove_fill') && !p.jobVersions.includes('1.2')) {
    ctx.addIssue({ code: 'custom', message: 'regional profiles require ImageJob 1.2' })
  }
})
export type ProfileDescriptor = z.infer<typeof ProfileDescriptor>

export const SourceVersion = z.strictObject({
  versionId: OpaqueId,
  attachmentId: OpaqueId,
  conversationId: OpaqueId,
  dimensions: ImageDimensions,
  sha256: Sha256,
  origin: z.enum(['original', 'approved_result', 'deterministic_transform']),
  parentVersionId: OpaqueId.nullable(),
})
export type SourceVersion = z.infer<typeof SourceVersion>
export const SourcePoint = z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
export type SourcePoint = z.infer<typeof SourcePoint>
export const MaskDescriptor = z.strictObject({
  id: OpaqueId,
  artifactId: OpaqueId,
  sourceVersionId: OpaqueId,
  dimensions: ImageDimensions,
  sha256: Sha256,
  coverage: z.number().positive().max(1),
  featherPixels: z.number().finite().nonnegative(),
})
export type MaskDescriptor = z.infer<typeof MaskDescriptor>
export const RegionNote = z.strictObject({
  id: OpaqueId,
  sourceVersionId: OpaqueId,
  point: SourcePoint,
  instruction: z.string().max(PRIVATE_LIMITS.regionCharacters),
  enabled: z.boolean(),
  reviewed: z.boolean(),
  stale: z.boolean(),
  mask: MaskDescriptor.nullable(),
}).refine((r) => !r.mask || r.mask.sourceVersionId === r.sourceVersionId, 'mask belongs to another source version')
export type RegionNote = z.infer<typeof RegionNote>
export const TransformRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('crop'), rect: z.strictObject({
    x: z.number().min(0).max(1), y: z.number().min(0).max(1),
    width: z.number().positive().max(1), height: z.number().positive().max(1),
  }).refine((r) => r.x + r.width <= 1 && r.y + r.height <= 1, 'crop exceeds source bounds') }),
  z.strictObject({ kind: z.literal('resize'), dimensions: ImageDimensions, fit: z.enum(['fit', 'fill']), background: z.string().regex(/^#[a-fA-F0-9]{8}$/) }),
  z.strictObject({ kind: z.literal('erase_alpha'), maskId: OpaqueId }),
])
export type TransformRequest = z.infer<typeof TransformRequest>
export const EditorSettings = z.strictObject({
  dimensions: ImageDimensions,
  preset: z.string().min(1).max(64).nullable(),
  steps: z.int().positive().nullable(),
  changeAmount: z.number().finite().nullable(),
  seed: z.int().nonnegative().nullable(),
})
export type EditorSettings = z.infer<typeof EditorSettings>
export const EditorDraft = z.strictObject({
  id: OpaqueId,
  revision: z.int().nonnegative(),
  conversationId: OpaqueId,
  source: SourceVersion,
  referenceIds: z.array(OpaqueId).max(PRIVATE_LIMITS.imageInputs - 1),
  referenceRoles: z.array(z.strictObject({
    attachmentId: OpaqueId,
    roles: z.array(z.enum(['identity', 'face', 'clothing', 'pose', 'hairstyle', 'expression', 'lighting', 'background', 'art_style', 'accessories'])).min(1).max(10),
  })).max(PRIVATE_LIMITS.imageInputs - 1).default([]),
  instruction: z.string().max(PRIVATE_LIMITS.requestCharacters),
  regions: z.array(RegionNote).max(PRIVATE_LIMITS.regions),
  operation: EditorOperation,
  transform: TransformRequest.nullable(),
  profile: ProfileSelection.nullable(),
  settings: EditorSettings,
  variantCount: VariantCount,
}).superRefine((d, ctx) => {
  if (d.source.conversationId !== d.conversationId) ctx.addIssue({ code: 'custom', message: 'source belongs to another conversation' })
  if (d.instruction.length + d.regions.filter((r) => r.enabled).reduce((n, r) => n + r.instruction.length, 0) > PRIVATE_LIMITS.requestCharacters) {
    ctx.addIssue({ code: 'custom', message: 'whole-image and active note text exceeds the request limit' })
  }
  if (new Set(d.referenceIds).size !== d.referenceIds.length || d.referenceIds.includes(d.source.attachmentId)) {
    ctx.addIssue({ code: 'custom', message: 'references must be unique and exclude the source' })
  }
  if (new Set(d.referenceRoles.map((r) => r.attachmentId)).size !== d.referenceRoles.length || d.referenceRoles.some((r) => !d.referenceIds.includes(r.attachmentId))) {
    ctx.addIssue({ code: 'custom', message: 'reference roles must name unique selected references' })
  }
  if (new Set(d.regions.map((r) => r.id)).size !== d.regions.length) ctx.addIssue({ code: 'custom', message: 'region IDs must be unique' })
  if (d.regions.some((r) => r.sourceVersionId !== d.source.versionId && !r.stale)) {
    ctx.addIssue({ code: 'custom', message: 'notes from another source must be marked stale' })
  }
})
export type EditorDraft = z.infer<typeof EditorDraft>

export const EditorReason = z.enum([
  'context_required', 'protocol_unsupported', 'capability_unavailable', 'schema_unsupported',
  'input_limit', 'attachment_unavailable', 'selection_mismatch', 'request_limit',
  'planner_unavailable', 'planner_invalid', 'ambiguous_intent', 'unsupported_action',
  'profile_unavailable', 'profile_mismatch', 'unsupported_server', 'settings_incompatible',
  'region_invalid', 'region_stale', 'region_conflict', 'source_review_required',
  'policy_unavailable', 'age_uncertain', 'consent_missing', 'consent_revoked', 'input_blocked', 'output_blocked',
  'revoked', 'cancelled', 'timeout', 'out_of_memory', 'render_failed', 'connection_lost',
  'reconciliation_required', 'cleanup_failed', 'draft_conflict', 'export_incompatible',
])
export type EditorReason = z.infer<typeof EditorReason>
export const RunState = z.enum([
  'received', 'planning', 'validating', 'checking_inputs', 'queued', 'rendering',
  'checking_output', 'completed', 'needs_clarification', 'unsupported', 'blocked', 'failed', 'cancelled',
])
export type RunState = z.infer<typeof RunState>
export const CandidateRecord = z.strictObject({
  id: OpaqueId, batchId: OpaqueId, runId: OpaqueId, attemptId: OpaqueId,
  slot: z.int().min(1).max(4), seed: z.int().nonnegative(), passSeeds: z.array(z.int().nonnegative()).max(PRIVATE_LIMITS.regions),
  state: RunState, reason: EditorReason.nullable(), outputVersionId: OpaqueId.nullable(),
  /** What went wrong, in the words the failure gave, without paths. Absent when nothing did. */
  detail: z.string().max(300).optional(),
}).refine((c) => c.state === 'completed' ? c.outputVersionId !== null : c.outputVersionId === null,
  'only completed candidates have published versions')
export type CandidateRecord = z.infer<typeof CandidateRecord>
export const EditorEvent = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('candidate'), sequence: z.int().nonnegative(), candidate: CandidateRecord }),
  z.strictObject({ type: z.literal('clarification'), sequence: z.int().nonnegative(), draftId: OpaqueId, question: z.string().min(1).max(300) }),
  z.strictObject({ type: z.literal('cleanup'), sequence: z.int().nonnegative(), conversationId: OpaqueId, receipt: CleanupReceipt }),
])
export type EditorEvent = z.infer<typeof EditorEvent>

/**
 * A selection in normalized source coordinates. The backend (A08) rasterizes the effective mask
 * from these shapes, so the mask that is shown, stored, staged and composited is one artifact
 * the UI never has to draw identically. Radii are fractions of the shorter source side.
 */
const unit = z.number().min(0).max(1)
export const SelectionShape = z.discriminatedUnion('shape', [
  z.strictObject({ mode: z.enum(['add', 'subtract']), shape: z.literal('ellipse'), cx: unit, cy: unit, rx: unit, ry: unit }),
  z.strictObject({ mode: z.enum(['add', 'subtract']), shape: z.literal('rect'), x: unit, y: unit, width: unit, height: unit }),
  z.strictObject({ mode: z.enum(['add', 'subtract']), shape: z.literal('brush'), points: z.array(SourcePoint).min(1).max(2_000), radius: unit }),
])
export type SelectionShape = z.infer<typeof SelectionShape>

/** A05 persists drafts/lineage. Commands use revision checks and idempotent invocation IDs. */
export const EditorCommand = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('mask'), draftId: OpaqueId, revision: z.int().nonnegative(), regionId: OpaqueId, shapes: z.array(SelectionShape).min(1).max(64), featherPixels: z.int().min(0).max(64) }),
  z.strictObject({ type: z.literal('save'), draft: EditorDraft, expectedRevision: z.int().nonnegative() }),
  z.strictObject({ type: z.literal('generate'), draftId: OpaqueId, revision: z.int().nonnegative(), invocationId: OpaqueId }),
  z.strictObject({ type: z.literal('clarify'), draftId: OpaqueId, revision: z.int().nonnegative(), answer: z.string().min(1).max(PRIVATE_LIMITS.requestCharacters), invocationId: OpaqueId }),
  z.strictObject({ type: z.literal('make_more'), batchId: OpaqueId, variantCount: VariantCount, invocationId: OpaqueId }),
  z.strictObject({ type: z.literal('retry_failed'), candidateId: OpaqueId, invocationId: OpaqueId }),
  z.strictObject({ type: z.literal('cancel_remaining'), batchId: OpaqueId }),
  z.strictObject({ type: z.literal('edit_version'), draftId: OpaqueId, revision: z.int().nonnegative(), versionId: OpaqueId }),
  z.strictObject({ type: z.literal('favorite'), versionId: OpaqueId, favorite: z.boolean() }),
  z.strictObject({ type: z.literal('remove_version'), versionId: OpaqueId }),
  z.strictObject({ type: z.literal('export'), versionIds: z.array(OpaqueId).min(1).max(4), format: z.enum(['png', 'webp', 'jpeg']), background: z.string().regex(/^#[a-fA-F0-9]{6}$/).nullable() }),
])
export type EditorCommand = z.infer<typeof EditorCommand>

export const EditorVersion = z.strictObject({
  source: SourceVersion,
  batchId: OpaqueId.nullable(),
  candidateId: OpaqueId.nullable(),
  favorite: z.boolean(),
  createdAt: z.int().nonnegative(),
})
export type EditorVersion = z.infer<typeof EditorVersion>
export const BatchRecord = z.strictObject({
  id: OpaqueId,
  draftId: OpaqueId,
  sourceVersionId: OpaqueId,
  variantCount: VariantCount,
  state: z.enum(['active', 'completed', 'partial', 'failed', 'cancelled']),
  candidates: z.array(CandidateRecord).min(1).max(4),
}).superRefine((b, ctx) => {
  if (b.candidates.length !== b.variantCount || b.candidates.some((c) => c.batchId !== b.id) ||
      new Set(b.candidates.map((c) => c.slot)).size !== b.variantCount ||
      b.candidates.some((c) => c.slot > b.variantCount) ||
      new Set(b.candidates.map((c) => c.id)).size !== b.variantCount) {
    ctx.addIssue({ code: 'custom', message: 'batch requires one stable candidate per requested slot' })
  }
})
export type BatchRecord = z.infer<typeof BatchRecord>
export interface EditorCommandResult {
  draft: EditorDraft | null
  batch: BatchRecord | null
  /** Core grants scoped artifact URLs after authorization; no absolute paths in UI responses. */
  exports: { artifactId: string; name: string; mime: string; url: string }[]
}
export interface EditorBackend {
  /** Open an authorized attachment in the editor: its original version and a fresh draft. */
  open(attachmentId: string, signal: AbortSignal): Promise<EditorDraft>
  loadDraft(id: string, signal: AbortSignal): Promise<EditorDraft>
  profiles(signal: AbortSignal): Promise<ProfileDescriptor[]>
  versions(conversationId: string, signal: AbortSignal): Promise<EditorVersion[]>
  batch(id: string, signal: AbortSignal): Promise<BatchRecord>
  command(command: EditorCommand, signal: AbortSignal): Promise<EditorCommandResult>
  subscribe(conversationId: string, listener: (event: EditorEvent) => void): () => void
}
/** Atomic media publication rechecks the core lease and revocation in the same commit boundary. */
export interface PublicationCallbacks {
  checkInputs(runId: string, signal: AbortSignal): Promise<{ allowed: boolean; reason: EditorReason | null }>
  checkOutput(runId: string, artifactId: string, signal: AbortSignal): Promise<{ allowed: boolean; reason: EditorReason | null }>
  publish(runId: string, artifactId: string, leaseId: string, signal: AbortSignal): Promise<SourceVersion>
  discard(runId: string, artifactId: string): Promise<CleanupReceipt>
}
/** Pure UI adapters. Coordinates refer to the orientation-corrected source, never the viewport. */
export interface CanvasViewport {
  source: SourceVersion
  zoom: number
  pan: { x: number; y: number }
  viewportToSource(point: { x: number; y: number }): SourcePoint | null
  sourceToViewport(point: SourcePoint): { x: number; y: number }
}
export interface EditorComponentContext {
  viewport: CanvasViewport
  draft: EditorDraft
  signal: AbortSignal
  /** Host owns the undo stack; A05 owns durable revisions. One user operation is one undo entry. */
  commit(label: string, next: EditorDraft): void
  overlay(mask: MaskDescriptor | null): void
}
export interface EditorComponent<Container> {
  mount(container: Container, context: EditorComponentContext): void
  update(context: EditorComponentContext): void
  unmount(): void
}

/** A05 creates this immutable snapshot once; candidates all start from this same source. */
export const BatchSnapshot = z.strictObject({
  id: OpaqueId,
  invocationId: OpaqueId,
  draft: EditorDraft,
  leaseId: OpaqueId,
  selectionId: OpaqueId,
  jobVersion: z.enum(['1.1', '1.2']),
  normalizedJob: z.record(z.string(), z.json()),
  compilerVersion: z.string().min(1).max(128),
  destination: RenderDestination,
  createdAt: z.int().nonnegative(),
  deadlineAt: z.int().positive(),
}).refine((b) => b.deadlineAt > b.createdAt, 'deadline must follow creation')
export type BatchSnapshot = z.infer<typeof BatchSnapshot>

/** A01 verifies manifest/graph digests on the selected managed host before any upload. */
export const EditRenderEnvelope = z.strictObject({
  version: z.literal('1'),
  runId: OpaqueId, batchId: OpaqueId, childId: OpaqueId, attemptId: OpaqueId,
  sourceVersionId: OpaqueId, leaseId: OpaqueId, selectionId: OpaqueId,
  operation: z.enum(['image_edit', 'inpaint', 'remove_fill']),
  profile: ProfileSelection,
  manifestSha256: Sha256,
  graphSha256: Sha256,
  compilerVersion: z.string().min(1).max(128),
  instruction: z.string().min(1).max(PRIVATE_LIMITS.plannerBytes),
  settings: EditorSettings,
  seed: z.int().nonnegative(),
  expectedOutputs: z.literal(1),
  suppressPreviews: z.literal(true),
  destination: RenderDestination,
  deadlineAt: z.int().positive(),
  inputs: z.array(z.strictObject({
    attachmentId: OpaqueId, sha256: Sha256, slot: z.int().min(1).max(PRIVATE_LIMITS.imageInputs),
  })).min(1).max(PRIVATE_LIMITS.imageInputs),
  masks: z.array(MaskDescriptor).max(PRIVATE_LIMITS.regions),
}).superRefine((e, ctx) => {
  if (new Set(e.inputs.map((i) => i.slot)).size !== e.inputs.length ||
      new Set(e.inputs.map((i) => i.attachmentId)).size !== e.inputs.length ||
      !e.inputs.some((i) => i.slot === 1)) {
    ctx.addIssue({ code: 'custom', message: 'input slots and attachments must be unique with the target in slot 1' })
  }
  if (e.masks.some((m) => m.sourceVersionId !== e.sourceVersionId)) {
    ctx.addIssue({ code: 'custom', message: 'mask belongs to another source version' })
  }
  if (e.operation !== 'image_edit' && e.masks.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'regional rendering requires a mask' })
  }
})
export type EditRenderEnvelope = z.infer<typeof EditRenderEnvelope>
