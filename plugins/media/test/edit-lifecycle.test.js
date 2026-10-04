// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { CANDIDATES } from '../edit/profiles/candidates.js'
import { checkProfile, describeProfile } from '../edit/profiles.js'
import { editor } from '../edit/run.js'
import { decode, encode } from '../edit/transforms/png.js'
import { batchState, passCount, passSeed, seeds } from '../edit/variants.js'

/**
 * The editor's lifecycle, from a draft to published versions, with every outside dependency a
 * strict double: core's attachments, the planner, policy and the renderer. What is real is
 * everything this packet owns — drafts, batches, scheduling, compositing, publication order,
 * cancellation, deletion and recovery.
 *
 * These doubles are for tests only. The editor refuses to run without real adapters, which the
 * integration pass supplies.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-edit-lifecycle-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const sha = (b) => createHash('sha256').update(b).digest('hex')

/** The storage API plugins get, in memory, with the same equality `where`. */
/** The key rule core enforces on plugin storage, so a double cannot accept what core refuses. */
const key = (k) => {
  if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new Error(`bad storage key ${k}`)
  return k
}

function memoryStorage() {
  const tables = new Map()
  const kv = new Map()
  const rows = (t) => tables.get(t) ?? tables.set(t, []).get(t)
  const match = (row, where = {}) => Object.entries(where).every(([k, v]) => row[k] === v)
  return {
    insert: async (t, row) => rows(t).push(structuredClone(row)),
    select: async (t, { where, limit } = {}) => rows(t).filter((r) => match(r, where)).slice(0, limit ?? Infinity).map((r) => structuredClone(r)),
    update: async (t, set, where) => {
      let n = 0
      for (const r of rows(t)) if (match(r, where)) Object.assign(r, structuredClone(set), n++)
      return n
    },
    delete: async (t, where) => {
      const before = rows(t).length
      tables.set(t, rows(t).filter((r) => !(where.all || match(r, where))))
      return before - rows(t).length
    },
    count: async (t, where) => rows(t).filter((r) => match(r, where)).length,
    get: async (k) => structuredClone(kv.get(key(k))),
    set: async (k, v) => void kv.set(key(k), structuredClone(v)),
    remove: async (k) => void kv.delete(k),
    dump: () => ({ tables, kv }),
  }
}

const picture = (w, h, rgba) => encode({ width: w, height: h, data: Buffer.alloc(w * h * 4).fill(Buffer.from(rgba)) })

const candidate = CANDIDATES[0]
const verified = checkProfile({
  ...structuredClone(candidate), version: 'test-1', status: 'verified', operations: ['image_edit', 'inpaint', 'remove_fill'], jobVersions: ['1.1', '1.2'],
  artifacts: candidate.artifacts.map((a) => ({ ...a, bytes: 1, sha256: 'a'.repeat(64), url: 'https://example.invalid', license: 'test' })),
  evidence: { id: 'bench', gpuBytes: 1, hostBytes: 1 },
  settings: { ...candidate.settings, dimensions: [{ width: 16, height: 8 }] },
})

function harness({ planOutcome, inputDecision = 'allowed', outputDecision = () => 'allowed', renderFails = () => null, renderPixels = [0, 0, 255, 255], hold } = {}) {
  const dir = mkdtempSync(join(root, 'h-'))
  const core = join(dir, 'core')
  mkdirSync(core)
  const conversation = 'conv1'
  const attachments = new Map()
  let labels = 0
  const attach = (bytes, mime = 'image/png') => {
    const id = `att${attachments.size + 1}`
    const path = join(core, `${id}.png`)
    writeFileSync(path, bytes)
    attachments.set(id, { id, label: `image_${++labels}`, displayName: `${id}.png`, mime, dimensions: decode(bytes), bytes: bytes.length, sha256: sha(bytes), path, conversation })
    return attachments.get(id)
  }
  const leases = new Map()
  const calls = { plan: [], render: [], register: [], checkInputs: [], checkOutput: [], released: [] }
  const events = []
  const storage = memoryStorage()
  const e = editor({
    storage,
    dir,
    lease: async (conv, ids) => {
      if (conv !== conversation) throw Object.assign(new Error('wrong conversation'), { code: 'selection_mismatch' })
      const leaseId = `lease${leases.size + 1}`
      leases.set(leaseId, true)
      return { version: '1', conversationId: conv, requestId: 'req', selectionId: `sel_${leaseId}`, leaseId, attachments: ids.map((id) => {
        const a = attachments.get(id)
        return { id: a.id, label: a.label, displayName: a.displayName, mime: a.mime, dimensions: { width: a.dimensions.width, height: a.dimensions.height }, bytes: a.bytes, sha256: a.sha256, path: a.path }
      }) }
    },
    isLive: async (leaseId) => leases.get(leaseId) === true,
    release: async (leaseId) => {
      calls.released.push(leaseId)
      leases.set(leaseId, 'released')
    },
    register: async ({ conversationId, path, sha256, dimensions, origin, parentVersionId }) => {
      calls.register.push({ origin, parentVersionId })
      const id = `att${attachments.size + 1}`
      const to = join(core, `${id}.png`)
      copyFileSync(path, to)
      attachments.set(id, { id, label: `image_${++labels}`, displayName: `${id}.png`, mime: 'image/png', dimensions, bytes: 1, sha256, path: to, conversation: conversationId })
      return { versionId: `v_${id}`, attachmentId: id, conversationId, dimensions, sha256, origin, parentVersionId }
    },
    share: async (_c, path) => `alexia://file/${path.split('/').at(-1)}`,
    plan: async (request) => {
      calls.plan.push(request)
      return planOutcome?.(request) ?? {
        outcome: 'ready', unused: [], attempts: 1,
        job: {
          schema_version: request.version, action: request.version === '1.2' ? 'inpaint' : 'image_edit', target: request.images[0].label,
          instruction: request.request || '', references: [], preserve: [], exclude: [], output_style: null, needs_clarification: false,
          clarification_question: null, confidence: 0.9, content_rating: 'sfw', named_real_people: [],
          ...(request.version === '1.2' && { regions: request.regions.map((r) => ({ region_id: r.id, instruction: r.instruction })) }),
        },
      }
    },
    policy: {
      checkInputs: async (run) => {
        calls.checkInputs.push(run)
        return inputDecision === 'allowed' ? { decision: 'allowed', reason: null, rating: 'sfw' } : { decision: 'blocked', reason: inputDecision, rating: null }
      },
      checkOutput: async (run) => {
        calls.checkOutput.push(run)
        const d = outputDecision(calls.checkOutput.length)
        return d === 'allowed' ? { decision: 'allowed', reason: null, rating: 'sfw' } : { decision: 'blocked', reason: d, rating: null }
      },
      forget: async () => {},
    },
    render: async (envelope, files, { signal }) => {
      calls.render.push({ envelope, files })
      if (hold) await hold(calls.render.length, signal)
      if (signal.aborted) throw Object.assign(new Error('Stopped.'), { code: 'cancelled' })
      const failure = renderFails(calls.render.length)
      if (failure) throw Object.assign(new Error(failure), { code: failure })
      const out = join(dir, `render-${calls.render.length}.png`)
      writeFileSync(out, picture(16, 8, renderPixels))
      return { file: out, width: 16, height: 8, promptId: `p${calls.render.length}`, cleanup: 'complete' }
    },
    profiles: async () => [{ profile: verified, descriptor: describeProfile(verified, { destination: { kind: 'interaction' }, installed: { ready: true, missing: [], mismatched: [] } }) }],
    emit: (conv, event) => events.push({ conv, event }),
    random: (() => {
      let n = 100
      return () => n++
    })(),
  })
  const source = attach(picture(16, 8, [200, 10, 10, 255]))
  return { e, dir, conversation, source, attach, attachments, calls, events, storage, leases }
}

const open = async (h, over = {}) => {
  const draft = await h.e.open(h.conversation, { attachmentId: h.source.id, sha256: h.source.sha256, dimensions: { width: 16, height: 8 } }, { profile: { id: verified.id, version: verified.version } })
  if (Object.keys(over).length === 0) return draft
  return (await h.e.command(h.conversation, { type: 'save', draft: { ...draft, ...over }, expectedRevision: draft.revision })).draft
}
const generate = (h, draft, invocationId = 'inv1') => h.e.command(h.conversation, { type: 'generate', draftId: draft.id, revision: draft.revision, invocationId })

describe('variants', () => {
  test('seeds are distinct and the person\'s own comes first', () => {
    let n = 0
    expect(seeds(4, { min: 0, max: 100 }, 7, () => n++ % 3)).toEqual([7, 0, 1, 2])
    expect(() => seeds(4, { min: 0, max: 1 })).toThrow(/smaller/)
  })

  test('pass seeds are derived and stable', () => {
    expect(passSeed(42, 1, { min: 0, max: 1000 })).toBe(passSeed(42, 1, { min: 0, max: 1000 }))
    expect(passSeed(42, 1, { min: 0, max: 1000 })).not.toBe(passSeed(42, 2, { min: 0, max: 1000 }))
  })

  test('batch state follows its candidates', () => {
    const c = (state) => ({ state })
    expect(batchState([c('completed'), c('queued')])).toBe('active')
    expect(batchState([c('completed'), c('failed')])).toBe('partial')
    expect(batchState([c('completed'), c('completed')])).toBe('completed')
    expect(batchState([c('cancelled'), c('cancelled')])).toBe('cancelled')
    expect(batchState([c('failed'), c('blocked')])).toBe('failed')
    expect(passCount(4, 3)).toBe(12)
  })
})

describe('drafts', () => {
  test('opening a picture makes its original version and a draft; saving needs the current revision', async () => {
    const h = harness()
    const draft = await open(h)
    expect(draft).toMatchObject({ revision: 1, source: { origin: 'original', attachmentId: h.source.id } })
    const saved = (await h.e.command(h.conversation, { type: 'save', draft: { ...draft, instruction: 'warmer' }, expectedRevision: 1 })).draft
    expect(saved.revision).toBe(2)
    await expect(h.e.command(h.conversation, { type: 'save', draft: { ...draft, instruction: 'colder' }, expectedRevision: 1 })).rejects.toMatchObject({ code: 'draft_conflict' })
    await expect(h.e.loadDraft('other', draft.id)).rejects.toMatchObject({ code: 'context_required' })
  })

  test('saving never generates', async () => {
    const h = harness()
    await open(h, { instruction: 'warmer' })
    expect(h.calls.plan).toHaveLength(0)
    expect(h.calls.render).toHaveLength(0)
  })
})

describe('generating versions', () => {
  test('four versions: one plan, one input check, four sequential renders with distinct seeds, each checked before publishing', async () => {
    const h = harness()
    const draft = await open(h, { instruction: 'warmer light', variantCount: 4 })
    const { batch } = await generate(h, draft)
    expect(batch.candidates.map((c) => c.state)).toEqual(['queued', 'queued', 'queued', 'queued'])
    await h.e.idle()
    const done = await h.e.batch(h.conversation, batch.id)
    expect(done.state).toBe('completed')
    expect(h.calls.plan).toHaveLength(1)
    expect(h.calls.checkInputs).toHaveLength(1)
    expect(h.calls.render).toHaveLength(4)
    expect(h.calls.checkOutput).toHaveLength(4)
    expect(new Set(h.calls.render.map((r) => r.envelope.seed)).size).toBe(4)
    // Every candidate started from the same source and the same compiled instruction.
    expect(new Set(h.calls.render.map((r) => r.envelope.inputs[0].sha256))).toEqual(new Set([h.source.sha256]))
    expect(new Set(h.calls.render.map((r) => r.envelope.instruction)).size).toBe(1)
    expect(h.calls.register.every((r) => r.origin === 'approved_result' && r.parentVersionId === draft.source.versionId)).toBe(true)
    expect((await h.e.versions(h.conversation)).length).toBe(5)
    // The lease is released once the batch is done.
    expect(h.leases.get(batch.candidates[0] && 'lease1')).toBe('released')
  })

  test('explicit clothes and pose slots reach both planning and the actual render prompt', async () => {
    const h = harness()
    const clothes = h.attach(picture(16, 8, [0, 200, 0, 255]))
    const pose = h.attach(picture(16, 8, [200, 200, 0, 255]))
    const draft = await open(h, {
      instruction: 'standing outdoors',
      referenceIds: [clothes.id, pose.id],
      referenceRoles: [{ attachmentId: clothes.id, roles: ['clothing'] }, { attachmentId: pose.id, roles: ['pose'] }],
    })
    await generate(h, draft)
    await h.e.idle()
    expect(h.calls.plan[0].request).toContain(`Use only the clothing from ${clothes.label}.`)
    expect(h.calls.plan[0].request).toContain(`Use only the pose from ${pose.label}.`)
    expect(h.calls.render).toHaveLength(1)
    expect(h.calls.render[0].envelope.instruction).toContain('Use only the clothing from Picture 2.')
    expect(h.calls.render[0].envelope.instruction).toContain('Use only the pose from Picture 3.')
  })

  test('the same invocation twice is one batch', async () => {
    const h = harness()
    const draft = await open(h, { instruction: 'warmer' })
    const a = await generate(h, draft, 'same')
    const b = await generate(h, draft, 'same')
    expect(b.batch.id).toBe(a.batch.id)
    await h.e.idle()
    expect(h.calls.render).toHaveLength(1)
  })

  test('a failed candidate keeps its siblings, and retry reruns only that slot', async () => {
    const h = harness({ renderFails: (n) => (n === 2 ? 'out_of_memory' : null) })
    const draft = await open(h, { instruction: 'warmer', variantCount: 2 })
    const { batch } = await generate(h, draft)
    await h.e.idle()
    let b = await h.e.batch(h.conversation, batch.id)
    expect(b.state).toBe('partial')
    const failed = b.candidates.find((c) => c.state === 'failed')
    expect(failed.reason).toBe('out_of_memory')
    await h.e.command(h.conversation, { type: 'retry_failed', candidateId: failed.id, invocationId: 'retry1' })
    await h.e.idle()
    b = await h.e.batch(h.conversation, batch.id)
    expect(b.state).toBe('completed')
    const retried = b.candidates.find((c) => c.id === failed.id)
    expect(retried.slot).toBe(failed.slot)
    expect(retried.seed).toBe(failed.seed)
    expect(retried.attemptId).not.toBe(failed.attemptId)
    expect(h.calls.plan).toHaveLength(1)
  })

  test('a blocked output is never published, and cannot be retried', async () => {
    const h = harness({ outputDecision: () => 'output_blocked' })
    const draft = await open(h, { instruction: 'warmer' })
    const { batch } = await generate(h, draft)
    await h.e.idle()
    const b = await h.e.batch(h.conversation, batch.id)
    expect(b.candidates[0]).toMatchObject({ state: 'blocked', reason: 'output_blocked', outputVersionId: null })
    expect(h.calls.register).toHaveLength(0)
    expect(readdirSync(join(h.dir, 'quarantine'))).toEqual([])
    await expect(h.e.command(h.conversation, { type: 'retry_failed', candidateId: b.candidates[0].id, invocationId: 'r' })).rejects.toMatchObject({ code: 'output_blocked' })
  })

  test('a blocked input stops before anything renders', async () => {
    const h = harness({ inputDecision: 'policy_unavailable' })
    const draft = await open(h, { instruction: 'warmer' })
    await expect(generate(h, draft)).rejects.toMatchObject({ code: 'policy_unavailable' })
    expect(h.calls.render).toHaveLength(0)
    expect(h.calls.released).toEqual(['lease1'])
  })

  test('a question is saved, never rendered, and the answer resumes the same draft', async () => {
    let asked = false
    const h = harness({ planOutcome: () => (asked ? null : (asked = true, { outcome: 'needs_clarification', reason: 'ambiguous_intent', question: 'Which parts?' })) })
    const draft = await open(h, { instruction: 'make me look like this' })
    const first = await generate(h, draft)
    expect(first.batch).toBeNull()
    expect(h.calls.render).toHaveLength(0)
    expect(h.events.at(-1).event).toMatchObject({ type: 'clarification', question: 'Which parts?' })
    expect((await h.e.pending(h.conversation, draft.id)).question).toBe('Which parts?')
    const { batch } = await h.e.command(h.conversation, { type: 'clarify', draftId: draft.id, revision: draft.revision, answer: 'only the outfit', invocationId: 'c1' })
    expect(h.calls.plan[1]).toMatchObject({ request: 'make me look like this', answer: 'only the outfit' })
    await h.e.idle()
    expect((await h.e.batch(h.conversation, batch.id)).state).toBe('completed')
    expect(await h.e.pending(h.conversation, draft.id)).toBeNull()
  })

  test('cancel remaining keeps what was published and stops the rest', async () => {
    let release
    const h = harness({ hold: (n) => (n === 2 ? new Promise((r) => (release = r)) : undefined) })
    const draft = await open(h, { instruction: 'warmer', variantCount: 4 })
    const { batch } = await generate(h, draft)
    while (h.calls.render.length < 2) await new Promise((r) => setTimeout(r, 5))
    await h.e.command(h.conversation, { type: 'cancel_remaining', batchId: batch.id })
    release()
    await h.e.idle()
    const b = await h.e.batch(h.conversation, batch.id)
    expect(b.candidates.map((c) => c.state)).toEqual(['completed', 'cancelled', 'cancelled', 'cancelled'])
    expect(h.calls.render).toHaveLength(2)
    expect(h.calls.register).toHaveLength(1)
  })

  test('edit this version makes it the source; the original and siblings stay', async () => {
    const h = harness()
    const draft = await open(h, { instruction: 'warmer', variantCount: 2 })
    const { batch } = await generate(h, draft)
    await h.e.idle()
    const b = await h.e.batch(h.conversation, batch.id)
    const next = (await h.e.command(h.conversation, { type: 'edit_version', draftId: draft.id, revision: draft.revision, versionId: b.candidates[1].outputVersionId })).draft
    expect(next.source.versionId).toBe(b.candidates[1].outputVersionId)
    expect((await h.e.versions(h.conversation)).map((v) => v.source.origin)).toEqual(['original', 'approved_result', 'approved_result'])
  })

  test('a model that cannot do the edit keeps the draft and says why', async () => {
    const h = harness()
    const draft = await open(h, { instruction: 'warmer', settings: { dimensions: { width: 99, height: 99 }, preset: null, steps: null, changeAmount: null, seed: null } })
    await expect(generate(h, draft)).rejects.toMatchObject({ code: 'settings_incompatible', message: expect.stringMatching(/99×99.*draft is kept/) })
    expect((await h.e.loadDraft(h.conversation, draft.id)).instruction).toBe('warmer')
    const none = await open(h, { instruction: 'warmer', profile: null })
    await expect(generate(h, none)).rejects.toMatchObject({ code: 'settings_incompatible' })
  })
})

describe('point notes', () => {
  const withNote = async (h, operation = 'inpaint', instruction = 'make this blue') => {
    let draft = await open(h, { operation, regions: [{ id: 'n1', sourceVersionId: `v_${h.source.id}`, point: { x: 0.25, y: 0.5 }, instruction, enabled: true, reviewed: false, stale: false, mask: null }] })
    draft = (await h.e.command(h.conversation, { type: 'mask', draftId: draft.id, revision: draft.revision, regionId: 'n1', shapes: [{ mode: 'add', shape: 'rect', x: 0, y: 0, width: 0.5, height: 1 }], featherPixels: 0 })).draft
    return draft
  }

  test('an unreviewed area stops; a reviewed one renders and only the selection changes', async () => {
    const h = harness()
    let draft = await withNote(h)
    await expect(generate(h, draft)).rejects.toMatchObject({ code: 'region_invalid' })
    draft = (await h.e.command(h.conversation, { type: 'save', draft: { ...draft, regions: draft.regions.map((r) => ({ ...r, reviewed: true })) }, expectedRevision: draft.revision })).draft
    const { batch } = await generate(h, draft, 'inv2')
    await h.e.idle()
    const b = await h.e.batch(h.conversation, batch.id)
    expect(b.candidates[0].state).toBe('completed')
    expect(h.calls.render[0].envelope.masks).toHaveLength(1)
    expect(h.calls.render[0].files.masks).toHaveLength(1)
    const out = decode(require_(h, b.candidates[0].outputVersionId))
    const at = (x, y) => [...out.data.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)]
    expect(at(2, 2)).toEqual([0, 0, 255, 255])
    expect(at(12, 2)).toEqual([200, 10, 10, 255])
  })

  test('whole-image words with notes need the whole-image result reviewed first', async () => {
    const h = harness()
    let draft = await withNote(h)
    draft = (await h.e.command(h.conversation, { type: 'save', draft: { ...draft, instruction: 'warmer', regions: draft.regions.map((r) => ({ ...r, reviewed: true })) }, expectedRevision: draft.revision })).draft
    await expect(generate(h, draft)).rejects.toMatchObject({ code: 'source_review_required' })
  })

  test('remove and fill needs no words', async () => {
    const h = harness()
    let draft = await withNote(h, 'remove_fill', '')
    draft = (await h.e.command(h.conversation, { type: 'save', draft: { ...draft, regions: draft.regions.map((r) => ({ ...r, reviewed: true })) }, expectedRevision: draft.revision })).draft
    await generate(h, draft)
    await h.e.idle()
    expect(h.calls.plan[0].regions[0].instruction).toMatch(/fill it in/)
  })

  test('a different source marks notes stale', async () => {
    const h = harness()
    const draft = await withNote(h)
    const other = h.attach(picture(16, 8, [1, 2, 3, 255]))
    const opened = await h.e.open(h.conversation, { attachmentId: other.id, sha256: other.sha256, dimensions: { width: 16, height: 8 } })
    const moved = (await h.e.command(h.conversation, { type: 'edit_version', draftId: draft.id, revision: draft.revision, versionId: opened.source.versionId })).draft
    expect(moved.regions[0]).toMatchObject({ stale: true, reviewed: false, instruction: 'make this blue' })
  })
})

describe('deterministic tools', () => {
  test('crop makes a new version without any model, and the source is untouched', async () => {
    const h = harness()
    const draft = await open(h, { operation: 'crop', transform: { kind: 'crop', rect: { x: 0, y: 0, width: 0.5, height: 1 } } })
    const { draft: next } = await generate(h, draft)
    expect(h.calls.plan).toHaveLength(0)
    expect(h.calls.render).toHaveLength(0)
    expect(next.source).toMatchObject({ origin: 'deterministic_transform', dimensions: { width: 8, height: 8 } })
    expect(sha(require_(h, `v_${h.source.id}`))).toBe(h.source.sha256)
  })

  test('export of a transparent picture to JPEG needs a background', async () => {
    const h = harness()
    const clear = h.attach(picture(4, 4, [10, 10, 10, 0]))
    const opened = await h.e.open(h.conversation, { attachmentId: clear.id, sha256: clear.sha256, dimensions: { width: 4, height: 4 } })
    await expect(h.e.command(h.conversation, { type: 'export', versionIds: [opened.source.versionId], format: 'jpeg', background: null })).rejects.toMatchObject({ code: 'export_incompatible' })
    const ok = await h.e.command(h.conversation, { type: 'export', versionIds: [opened.source.versionId], format: 'png', background: null })
    expect(ok.exports[0]).toMatchObject({ name: 'edit-1.png', mime: 'image/png' })
  })
})

describe('deletion and restart', () => {
  test('revocation during a render: nothing publishes, and cleanup removes every record and file', async () => {
    let release
    const h = harness({ hold: () => new Promise((r) => (release = r)) })
    const draft = await open(h, { instruction: 'warmer' })
    await generate(h, draft)
    while (h.calls.render.length < 1) await new Promise((r) => setTimeout(r, 5))
    await h.e.participant.revoke(h.conversation)
    release()
    await h.e.idle()
    expect(h.calls.register).toHaveLength(0)
    const receipt = await h.e.participant.cleanup(h.conversation, 'rev1')
    expect(receipt).toEqual({ revocationId: 'rev1', local: 'complete', remote: [] })
    expect([...h.storage.dump().tables.get('edits')].length).toBe(0)
    expect(existsSync(join(h.dir, 'edits', h.conversation))).toBe(false)
    await expect(h.e.command(h.conversation, { type: 'save', draft, expectedRevision: 1 })).rejects.toMatchObject({ code: 'revoked' })
  })

  test('a render host that could not clean up is reported pending, not complete', async () => {
    const h = harness({ renderFails: () => null })
    const draft = await open(h, { instruction: 'warmer' })
    await h.storage.set('edit_untidy', [{ conversation: h.conversation, hostId: 'studio' }])
    await generate(h, draft)
    await h.e.idle()
    const receipt = await h.e.participant.cleanup(h.conversation, 'rev2')
    expect(receipt.remote).toEqual([{ hostId: 'studio', state: 'pending', reason: expect.any(String) }])
    await h.e.hostSwept('studio')
    expect((await h.e.participant.cleanup(h.conversation, 'rev3')).remote).toEqual([])
  })

  test('after a restart, unfinished candidates wait for reconciliation instead of rendering twice', async () => {
    let release
    const h = harness({ hold: () => new Promise((r) => (release = r)) })
    const draft = await open(h, { instruction: 'warmer' })
    const { batch } = await generate(h, draft)
    while (h.calls.render.length < 1) await new Promise((r) => setTimeout(r, 5))
    await h.e.recover()
    const b = await h.e.batch(h.conversation, batch.id)
    expect(b.candidates[0]).toMatchObject({ state: 'failed', reason: 'reconciliation_required' })
    release()
  })
})

/** Bytes of a version, through the fake core. */
function require_(h, versionId) {
  return readFileSync(h.attachments.get(versionId.replace(/^v_/, '')).path)
}
