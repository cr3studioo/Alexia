// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest'
import {
  ALEXIA_PROTOCOL_MAX, AttachmentCallContext, AttachmentInputs, PrivateSamplingMeta,
  SamplingFormat, PRIVATE_LIMITS, negotiatePrivateContext, supportedSamplingSchema,
  EditorDraft, EditorCommand, EditRenderEnvelope, ProfileDescriptor, CandidateRecord, CleanupReceipt, BatchRecord,
} from '../src/index.js'

const hash = 'a'.repeat(64)
const dimensions = { width: 512, height: 768 }
const source = {
  versionId: 'version-1', attachmentId: 'attachment-7', conversationId: 'chat-1', dimensions,
  sha256: hash, origin: 'original', parentVersionId: null,
}
const settings = { dimensions, preset: null, steps: null, changeAmount: null, seed: null }
const draft = {
  id: 'draft-1', revision: 0, conversationId: 'chat-1', source, referenceIds: ['attachment-9'],
  instruction: 'Make the bag blue', regions: [], operation: 'image_edit', transform: null,
  profile: null, settings, variantCount: 4,
}
const capabilities = {
  version: '1', attachmentContext: true, interactionOnlySampling: true,
  structuredSampling: true, revocablePublication: true, imageJobVersions: ['1.1'],
}
const attachment = {
  id: 'attachment-7', label: 'image_7', displayName: 'portrait.png', mime: 'image/png',
  dimensions, bytes: 100, sha256: hash, path: '/core-owned/uploads/attachment-7.png',
}
const context = {
  version: '1', conversationId: 'chat-1', requestId: 'request-1', selectionId: 'selection-1',
  leaseId: 'lease-1', attachments: [attachment, { ...attachment, id: 'attachment-9', label: 'image_9' }],
}
const schema = {
  type: 'object', properties: { target: { type: ['string', 'null'] } },
  required: ['target'], additionalProperties: false,
}

describe('private context negotiation', () => {
  test('a core at 14 negotiates the contract; a core at 13 cannot claim it', () => {
    expect(ALEXIA_PROTOCOL_MAX).toBe(14)
    expect(negotiatePrivateContext(ALEXIA_PROTOCOL_MAX, capabilities, '1.1')).toEqual({ ok: true })
    expect(negotiatePrivateContext(13, capabilities, '1.1')).toEqual({ ok: false, reason: 'protocol_unsupported' })
  })
  test('version alone and partial promises fail closed', () => {
    for (const value of [undefined, {}, { ...capabilities, interactionOnlySampling: false }]) {
      expect(negotiatePrivateContext(14, value, '1.1')).toEqual({ ok: false, reason: 'capability_unavailable' })
    }
  })
  test('regional output must be explicitly negotiated', () => {
    expect(negotiatePrivateContext(14, capabilities, '1.1')).toEqual({ ok: true })
    expect(negotiatePrivateContext(14, capabilities, '1.2')).toEqual({ ok: false, reason: 'schema_unsupported' })
    expect(negotiatePrivateContext(14, { ...capabilities, imageJobVersions: ['1.1', '1.2'] }, '1.2')).toEqual({ ok: true })
    expect(negotiatePrivateContext(NaN, capabilities, '1.1').ok).toBe(false)
  })
})

describe('declared attachment handoff', () => {
  test('non-contiguous labels are valid; no label-to-index assumption', () => {
    expect(AttachmentCallContext.parse(context).attachments.map((a) => a.label)).toEqual(['image_7', 'image_9'])
  })
  test('context and ordered unique identities are mandatory', () => {
    expect(AttachmentCallContext.safeParse({ ...context, conversationId: undefined }).success).toBe(false)
    expect(AttachmentCallContext.safeParse({ ...context, attachments: [attachment, attachment] }).success).toBe(false)
    expect(AttachmentCallContext.safeParse({ ...context, attachments: [{ ...attachment, sha256: 'wrong' }] }).success).toBe(false)
    expect(AttachmentCallContext.safeParse({ ...context, arbitrary: true }).success).toBe(false)
  })
  test('only named top-level fields may request resolution', () => {
    const field = { name: 'images', cardinality: 'many', mimeTypes: ['image/png'], maxCount: 3 }
    expect(AttachmentInputs.safeParse({ fields: [field] }).success).toBe(true)
    expect(AttachmentInputs.safeParse({ fields: [field, field] }).success).toBe(false)
    expect(AttachmentInputs.safeParse({ fields: [{ ...field, name: 'nested.images' }] }).success).toBe(false)
    expect(AttachmentInputs.safeParse({ fields: [{ ...field, cardinality: 'one' }] }).success).toBe(false)
  })
})

describe('bounded structured sampling', () => {
  test('strict schema and hard interaction placement travel together', () => {
    expect(PrivateSamplingMeta.safeParse({ 'alexia/local': true, 'alexia/format': { name: 'image_job', schema, strict: true } }).success).toBe(true)
    expect(PrivateSamplingMeta.safeParse({ 'alexia/local': false, 'alexia/format': { name: 'image_job', schema, strict: true } }).success).toBe(false)
  })
  test.each([
    { $ref: 'https://example.org/schema' }, { $ref: '#/local' }, { type: 'string', pattern: '.*' },
    { type: 'object', additionalProperties: true }, { minimum: Infinity }, { type: 'magic' },
    { enum: [{ node: 'anything' }] }, { required: ['a', 'a'] }, {}, null,
  ])('rejects unsupported schema %j', (value) => {
    expect(supportedSamplingSchema(value)).toBe(false)
  })
  test('caps UTF-8 bytes and recursive depth without truncation', () => {
    expect(supportedSamplingSchema({ type: 'string', description: 'é'.repeat(PRIVATE_LIMITS.schemaBytes) })).toBe(false)
    let deep: unknown = { type: 'string' }
    for (let n = 0; n < PRIVATE_LIMITS.schemaDepth + 1; n++) deep = { type: 'array', items: deep }
    expect(supportedSamplingSchema(deep)).toBe(false)
    expect(SamplingFormat.safeParse({ name: 'job', schema, strict: false }).success).toBe(false)
    const cyclic: Record<string, unknown> = { type: 'array' }
    cyclic.items = cyclic
    expect(supportedSamplingSchema(cyclic)).toBe(false)
  })
})

describe('trusted editor envelopes', () => {
  test('drafts accept only explicit counts, unique references and scoped source records', () => {
    expect(EditorDraft.safeParse(draft).success).toBe(true)
    for (const bad of [
      { ...draft, variantCount: 3 }, { ...draft, referenceIds: ['a', 'b', 'c'] },
      { ...draft, referenceIds: ['a', 'a'] }, { ...draft, referenceIds: [source.attachmentId] },
      { ...draft, conversationId: 'other-chat' }, { ...draft, settings: { ...settings, checkpoint: 'chosen-by-model' } },
    ]) expect(EditorDraft.safeParse(bad).success).toBe(false)
  })
  test('source changes retain stale note text; current notes must bind to their source', () => {
    const note = { id: 'note-1', sourceVersionId: 'old-version', point: { x: 0.5, y: 0.5 }, instruction: 'blue', enabled: true, reviewed: false, stale: true, mask: null }
    expect(EditorDraft.safeParse({ ...draft, regions: [note] }).success).toBe(true)
    expect(EditorDraft.safeParse({ ...draft, regions: [{ ...note, stale: false }] }).success).toBe(false)
    expect(EditorDraft.safeParse({ ...draft, instruction: 'x'.repeat(8000), regions: [note] }).success).toBe(false)
  })
  test('crop bounds and revision/idempotency keys are part of the command contract', () => {
    expect(EditorDraft.safeParse({ ...draft, transform: { kind: 'crop', rect: { x: 0.8, y: 0, width: 0.5, height: 1 } } }).success).toBe(false)
    expect(EditorCommand.safeParse({ type: 'generate', draftId: 'draft-1', revision: 0, invocationId: 'call-1' }).success).toBe(true)
    expect(EditorCommand.safeParse({ type: 'generate', draftId: 'draft-1' }).success).toBe(false)
  })
  test('render envelope rejects previews, duplicate slots, missing masks and extra execution fields', () => {
    const envelope = {
      version: '1', runId: 'run-1', batchId: 'batch-1', childId: 'child-1', attemptId: 'attempt-1',
      sourceVersionId: 'version-1', leaseId: 'lease-1', selectionId: 'selection-1', operation: 'image_edit',
      profile: { id: 'profile-1', version: 'rev-1' }, manifestSha256: hash, graphSha256: hash,
      compilerVersion: '1', instruction: 'Make the bag blue', settings, seed: 123, expectedOutputs: 1, suppressPreviews: true,
      destination: { kind: 'interaction' }, deadlineAt: 1000,
      inputs: [{ attachmentId: 'attachment-7', sha256: hash, slot: 1 }], masks: [],
    }
    expect(EditRenderEnvelope.safeParse(envelope).success).toBe(true)
    for (const bad of [
      { ...envelope, suppressPreviews: false }, { ...envelope, nodeClasses: ['custom'] },
      { ...envelope, inputs: [...envelope.inputs, ...envelope.inputs] }, { ...envelope, operation: 'inpaint' },
    ]) expect(EditRenderEnvelope.safeParse(bad).success).toBe(false)
  })
  test('profiles cannot claim availability without measurements or regional support without 1.2', () => {
    const profile = {
      selection: { id: 'profile-1', version: 'rev-1' }, name: 'Candidate', uncensored: false, operations: ['image_edit'],
      jobVersions: ['1.1'], maxInputs: 3, destination: { kind: 'interaction' },
      availability: 'unverified', reason: 'Needs target-hardware benchmark', evidenceId: null,
      measuredMemory: null, dimensions: [dimensions], batchSize: 1,
      controls: { presets: [], steps: null, changeAmount: null, seed: { min: 0, max: 4294967295 } },
    }
    expect(ProfileDescriptor.safeParse(profile).success).toBe(true)
    expect(ProfileDescriptor.safeParse({ ...profile, availability: 'available' }).success).toBe(false)
    expect(ProfileDescriptor.safeParse({ ...profile, operations: ['inpaint'] }).success).toBe(false)
  })
  test('batch recovery requires each stable candidate slot exactly once', () => {
    const child = { id: 'child-1', batchId: 'batch-1', runId: 'run-1', attemptId: 'attempt-1', slot: 1, seed: 1, passSeeds: [], state: 'queued', reason: null, outputVersionId: null }
    const batch = { id: 'batch-1', draftId: 'draft-1', sourceVersionId: 'version-1', variantCount: 2, state: 'active', candidates: [child, { ...child, id: 'child-2', slot: 2, seed: 2 }] }
    expect(BatchRecord.safeParse(batch).success).toBe(true)
    expect(BatchRecord.safeParse({ ...batch, candidates: [child, child] }).success).toBe(false)
    expect(BatchRecord.safeParse({ ...batch, candidates: [child] }).success).toBe(false)
  })
  test('unchecked candidates never carry a published output; cleanup preserves offline state', () => {
    const candidate = { id: 'child-1', batchId: 'batch-1', runId: 'run-1', attemptId: 'attempt-1', slot: 1, seed: 123, passSeeds: [], state: 'checking_output', reason: null, outputVersionId: 'output-1' }
    expect(CandidateRecord.safeParse(candidate).success).toBe(false)
    expect(CandidateRecord.safeParse({ ...candidate, state: 'completed' }).success).toBe(true)
    expect(CleanupReceipt.parse({ revocationId: 'revoked-1', local: 'complete', remote: [{ hostId: 'paired-1', state: 'pending', reason: 'offline' }] }).remote[0]?.state).toBe('pending')
  })
})
