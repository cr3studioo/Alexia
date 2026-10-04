// SPDX-License-Identifier: AGPL-3.0-only
import { EditorCommand } from '@alexia/sdk'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from './compile.js'
import { referenceJob } from './references.js'
import { DraftError, records as recordsOf } from './drafts.js'
import { runLog } from './log.js'
import { graphSha256, manifestSha256, settingsProblem, slotNamer } from './profiles.js'
import { composite, describeMask, maskPng, passes as notePasses, preserved, rasterize, readMask, rebase, RegionError, sha256 } from './regions.js'
import { MESSAGES } from './policy/rules.js'
import { apply as applyTransform, prepareExport, TransformError } from './transforms.js'
import { decode, encode, isPng } from './transforms/png.js'
import { batchState, isTerminal, passSeed, progressLabel, seeds as rollSeeds } from './variants.js'

/**
 * The editor's backend: drafts in, checked versions out.
 *
 * **One path for chat and for the editor.** Every generation — a whole-image edit, notes on
 * areas, remove-and-fill — goes through `generate()`: the draft is checked against its revision
 * and the chosen profile, the pictures are leased from core, the planner runs once, policy
 * checks the request and every input, and only then is a batch frozen and queued. Crop, resize
 * and erase-to-transparency take the same entrance and skip the model.
 *
 * **One candidate at a time.** Candidates from every conversation share one queue, so a single
 * graphics card renders one job and its memory is released before the next. A batch's
 * candidates all start from the same frozen snapshot and differ only in their seeds.
 *
 * **Nothing unchecked is published, and nothing is published after revocation.** A candidate's
 * output stays in quarantine until its own policy check passes; publication then rechecks
 * cancellation, conversation revocation and the lease under the same lock revocation takes.
 * The one exception is ComfyUI's live preview while a candidate renders, which the person
 * chose to see: it is held in memory, replaced by the next frame, dropped when the render
 * ends, and never becomes a version.
 *
 * Every dependency is an adapter: core's attachments (`lease`, `isLive`, `release`, `register`,
 * `share`), the planner, policy, the renderer and the profile list. Test doubles stand in for
 * them in tests and never in a shipped path.
 */

/**
 * A failure's own words, fit to keep and show: no file paths (they name the person's folders),
 * one line, and short. Empty when there is nothing more to say than the reason code.
 */
export function said(message) {
  const text = String(message ?? '')
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\s'"\\/:]+[\\/])+[^\s'"\\/:]*/g, '…')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 300 ? `${text.slice(0, 299)}…` : text
}

export class EditorFailure extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.code = code
    Object.assign(this, extra)
  }
}

const JOB_DEADLINE_MS = 30 * 60_000
const DEFAULT_FILL = 'Remove what is in the selected area and fill it in so it matches its surroundings.'
const REGIONAL = new Set(['inpaint', 'remove_fill'])
const TRANSFORMS = new Set(['crop', 'resize', 'erase_alpha'])
const newId = (prefix) => `${prefix}_${randomBytes(12).toString('base64url')}`

export function editor({
  storage, dir, lease, isLive, release, register, share, plan, policy, render, profiles, emit = () => {},
  ids = newId, now = Date.now, random,
}) {
  /** This plugin's folder, known only once it has started — hence asked for when needed. */
  const base = () => (typeof dir === 'function' ? dir() : dir)
  const records = recordsOf(storage)
  const log = runLog(records, now)
  const revoked = new Set()
  const active = new Map() // batchId → AbortController
  const locks = new Map()
  /** Hosts that may still hold files a run lent them, persisted so a restart still knows. */
  const untidyKey = 'edit_untidy'
  const markUntidy = async (conversation, hostId) => {
    const all = (await storage.get(untidyKey).catch(() => undefined)) ?? []
    if (!all.some((u) => u.conversation === conversation && u.hostId === hostId)) all.push({ conversation, hostId })
    await storage.set(untidyKey, all).catch(() => {})
  }
  let queue = Promise.resolve()

  /** Publication and revocation of one conversation never interleave. */
  const withLock = (conversation, fn) => {
    const before = locks.get(conversation) ?? Promise.resolve()
    const next = before.then(fn, fn)
    locks.set(conversation, next.catch(() => {}))
    return next
  }
  const say = async (conversationId, event) => {
    try {
      emit(conversationId, { ...event, sequence: await records.nextSequence(conversationId) })
    } catch {
      // A listener's failure never changes what happened to the edit.
    }
  }
  const editsDir = (conversation) => join(base(), 'edits', conversation)
  const maskPath = (conversation, maskId) => join(editsDir(conversation), 'masks', `${maskId}.png`)
  const guard = (conversation) => {
    if (revoked.has(conversation)) throw new EditorFailure('revoked', 'This conversation\'s pictures were deleted.')
  }

  async function chosenProfile(draft) {
    if (!draft.profile) throw new EditorFailure('settings_incompatible', 'Choose a model to edit with.')
    const found = (await profiles()).find((p) => p.descriptor.selection.id === draft.profile.id && p.descriptor.selection.version === draft.profile.version)
    if (!found) throw new EditorFailure('profile_unavailable', 'The chosen model is not available any more. Choose another — your draft is kept.')
    if (found.descriptor.availability !== 'available') throw new EditorFailure('profile_unavailable', found.descriptor.reason ?? 'The chosen model cannot be used right now.')
    const problem = settingsProblem(found.profile, draft.operation, draft.settings, 1 + draft.referenceIds.length)
    if (problem) throw new EditorFailure('settings_incompatible', `${problem} Your draft is kept.`)
    return found
  }

  async function masksOf(draft) {
    const masks = new Map()
    for (const r of draft.regions.filter((x) => x.enabled && x.mask)) {
      let png
      try {
        png = readFileSync(maskPath(draft.conversationId, r.mask.id))
      } catch {
        throw new EditorFailure('region_invalid', 'A selected area is missing. Select it again.')
      }
      masks.set(r.mask.id, readMask(png, r.mask, draft.source))
    }
    return masks
  }

  async function picturesFor(context) {
    return context.attachments.map((a) => ({ label: a.label, mimeType: a.mime, data: readFileSync(a.path).toString('base64'), sha256: a.sha256 }))
  }

  /** The request, the planner and the input checks: everything that happens once per batch. */
  async function prepare(draft, { answer = null, invocationId, signal, planned: given = null, adult = false }) {
    guard(draft.conversationId)
    const regional = REGIONAL.has(draft.operation)
    if (regional && draft.instruction.trim() !== '') {
      throw new EditorFailure('source_review_required', 'Make the whole-picture change first, then check your notes on the result before applying them.')
    }
    const { profile, descriptor } = await chosenProfile(draft)
    const masks = regional ? await masksOf(draft) : new Map()
    let order
    try {
      order = regional ? notePasses(draft, masks) : []
    } catch (error) {
      if (error instanceof RegionError) throw new EditorFailure(error.code, error.message, { regionId: error.regionId })
      throw error
    }
    const context = await lease(draft.conversationId, [draft.source.attachmentId, ...draft.referenceIds], signal)
    try {
      const images = await picturesFor(context)
      const sourceLabel = context.attachments.find((a) => a.id === draft.source.attachmentId)?.label
      const regions = order.map(({ regionId }) => {
        const note = draft.regions.find((r) => r.id === regionId)
        return { id: regionId, instruction: note.instruction.trim() || DEFAULT_FILL }
      })
      const version = regional ? '1.2' : '1.1'
      if (regional && context.attachments[0]?.mime !== 'image/png') {
        throw new EditorFailure('attachment_unavailable', 'Open this picture in the editor first, so its selected areas can be kept exactly.')
      }
      // A plan made a moment ago for the same request and pictures (the chat path) is not made twice.
      const referenceInstructions = (draft.referenceRoles ?? []).map((reference) => {
        const label = context.attachments.find((a) => a.id === reference.attachmentId)?.label
        return label ? `Use only the ${reference.roles.map((r) => r.replaceAll('_', ' ')).join(' and ')} from ${label}.` : ''
      }).filter(Boolean)
      const request = referenceInstructions.length ? [`Edit ${sourceLabel}.`, draft.instruction, ...referenceInstructions].join('\n') : draft.instruction
      const planned = given ?? await plan({ request, images, version, regions, answer, signal, deadlineAt: now() + 5 * 60_000 })
      if (planned.outcome === 'needs_clarification') {
        await records.savePending({ draftId: draft.id, revision: draft.revision, question: planned.question, at: now() }, draft.conversationId)
        await say(draft.conversationId, { type: 'clarification', draftId: draft.id, question: planned.question })
        await release(context.leaseId)
        return { clarification: planned.question }
      }
      if (planned.outcome !== 'ready') throw new EditorFailure(planned.reason, planned.message ?? 'The edit could not be planned.')
      if (planned.job.target !== sourceLabel) {
        const question = `Should the change be made to ${sourceLabel}, the picture open in the editor?`
        await records.savePending({ draftId: draft.id, revision: draft.revision, question, at: now() }, draft.conversationId)
        await say(draft.conversationId, { type: 'clarification', draftId: draft.id, question })
        await release(context.leaseId)
        return { clarification: question }
      }
      planned.job = referenceJob(planned.job, draft.referenceRoles, context.attachments)
      const compiled = compile(planned.job, context.attachments.map((a) => a.label), { slotName: slotNamer(profile) })
      const batchId = ids('batch')
      const checked = await policy.checkInputs({
        runId: batchId, conversationId: draft.conversationId, request: [draft.instruction, ...regions.map((r) => r.instruction)].join('\n'),
        hint: planned.job, images: images.filter((i) => compiled.slots.some((s) => s.label === i.label)), adult,
      }, signal)
      if (checked.decision !== 'allowed') throw new EditorFailure(checked.reason, MESSAGES[checked.reason] ?? 'This edit was not made.')
      await records.clearPending(draft.id, draft.conversationId)
      const snapshot = {
        id: batchId, invocationId, draft, leaseId: context.leaseId, selectionId: context.selectionId, jobVersion: version,
        normalizedJob: planned.job, compilerVersion: compiled.compilerVersion, destination: descriptor.destination,
        createdAt: now(), deadlineAt: now() + JOB_DEADLINE_MS,
      }
      await records.saveSnapshot(snapshot, draft.conversationId)
      await records.write('compiled', batchId, draft.conversationId, { compiled, order, inputs: checked, adult, attachments: context.attachments.map((a) => ({ id: a.id, label: a.label, sha256: a.sha256 })) })
      return { snapshot, compiled, order, profile, context, inputDecision: checked, adult }
    } catch (error) {
      await release(context.leaseId)
      throw error
    }
  }

  async function startBatch(prepared, variantCount, batchId = prepared.snapshot.id) {
    const { snapshot, profile } = prepared
    const chosen = snapshot.draft.settings.seed
    const list = rollSeeds(variantCount, profile.settings.seed, chosen, random)
    const batch = {
      id: batchId, draftId: snapshot.draft.id, sourceVersionId: snapshot.draft.source.versionId, variantCount, state: 'active',
      candidates: list.map((seed, i) => ({
        id: ids('cand'), batchId, runId: ids('run'), attemptId: ids('att'), slot: i + 1, seed, passSeeds: [],
        state: 'queued', reason: null, outputVersionId: null,
      })),
    }
    await records.saveBatch({ ...batch, snapshotId: snapshot.id }, snapshot.draft.conversationId)
    for (const c of batch.candidates) await say(snapshot.draft.conversationId, { type: 'candidate', candidate: c })
    schedule(snapshot.draft.conversationId, batch.id, batch.candidates.map((c) => c.id), prepared)
    return batch
  }

  function schedule(conversation, batchId, candidateIds, prepared) {
    const controller = active.get(batchId) ?? new AbortController()
    active.set(batchId, controller)
    queue = queue.then(async () => {
      for (const candidateId of candidateIds) {
        if (controller.signal.aborted) break
        await runCandidate(conversation, batchId, candidateId, prepared, controller.signal).catch(() => {})
      }
      await finishBatch(conversation, batchId, prepared)
    })
    return queue
  }

  async function finishBatch(conversation, batchId, prepared) {
    const batch = await records.batch(batchId, conversation)
    if (!batch) return
    if (batch.candidates.every((c) => isTerminal(c.state))) {
      active.delete(batchId)
      await release(prepared.context.leaseId).catch(() => {})
    }
  }

  async function updateCandidate(conversation, batchId, candidateId, change) {
    const batch = await records.batch(batchId, conversation)
    const c = batch.candidates.find((x) => x.id === candidateId)
    Object.assign(c, change)
    batch.state = batchState(batch.candidates)
    await records.saveBatch(batch, conversation)
    await say(conversation, { type: 'candidate', candidate: c })
    return c
  }

  async function runCandidate(conversation, batchId, candidateId, prepared, signal) {
    const { snapshot, compiled, order, profile, context, inputDecision, adult = false } = prepared
    const draft = snapshot.draft
    const batch = await records.batch(batchId, conversation)
    let c = batch.candidates.find((x) => x.id === candidateId)
    if (isTerminal(c.state) && c.state !== 'failed') return
    const quarantine = join(base(), 'quarantine', c.runId, c.attemptId)
    const fail = async (code, message) => {
      rmSync(join(base(), 'quarantine', c.runId), { recursive: true, force: true })
      const state = code === 'cancelled' || code === 'revoked' ? 'cancelled'
        : ['policy_unavailable', 'age_uncertain', 'consent_missing', 'consent_revoked', 'input_blocked', 'output_blocked'].includes(code) ? 'blocked' : 'failed'
      const detail = said(message)
      await log.transition(c.runId, conversation, state, { reason: code, ...(detail && { detail }) }).catch(() => {})
      await updateCandidate(conversation, batchId, candidateId, { state, reason: code, ...(detail && { detail }) })
      return message
    }
    try {
      guard(conversation)
      await log.start({
        runId: c.runId, conversationId: conversation, batchId, childId: c.id, slot: c.slot, attemptId: c.attemptId,
        sourceVersionId: draft.source.versionId, operation: draft.operation, inputs: compiled.slots.map((s) => s.label),
        masks: order.map((o) => o.maskId), jobVersion: snapshot.jobVersion, compilerVersion: compiled.compilerVersion,
        profile: draft.profile, manifestSha256: manifestSha256(profile), graphSha256: graphSha256(profile), seed: c.seed,
        settings: draft.settings, destination: snapshot.destination,
      })
      const passSeeds = order.length > 1 ? order.map((_, i) => passSeed(c.seed, i, profile.settings.seed)) : []
      c = await updateCandidate(conversation, batchId, candidateId, { state: 'rendering', passSeeds })
      await log.transition(c.runId, conversation, 'rendering', { passSeeds })
      mkdirSync(quarantine, { recursive: true })
      const label = progressLabel(c.slot, batch.variantCount)
      const byLabel = new Map(context.attachments.map((a) => [a.label, a]))
      const envelopeFor = (over) => ({
        version: '1', runId: c.runId, batchId, childId: c.id, attemptId: c.attemptId,
        sourceVersionId: draft.source.versionId, leaseId: context.leaseId, selectionId: context.selectionId,
        operation: draft.operation, profile: draft.profile, manifestSha256: manifestSha256(profile), graphSha256: graphSha256(profile),
        compilerVersion: compiled.compilerVersion, instruction: compiled.instruction, settings: draft.settings, seed: c.seed,
        expectedOutputs: 1, suppressPreviews: true, destination: snapshot.destination, deadlineAt: snapshot.deadlineAt,
        inputs: compiled.slots.map((s) => ({ attachmentId: byLabel.get(s.label).id, sha256: byLabel.get(s.label).sha256, slot: s.slot })),
        masks: [],
        ...over,
      })
      const noteCleanup = (out) => {
        if (out?.cleanup === 'pending') {
          markUntidy(conversation, snapshot.destination.kind === 'paired' ? snapshot.destination.hostId : 'interaction').catch(() => {})
          log.transition(c.runId, conversation, 'rendering', { cleanup: 'pending' }).catch(() => {})
        }
      }
      const report = (r) => {
        if (r.promptId) log.transition(c.runId, conversation, 'rendering', { promptId: r.promptId }).catch(() => {})
      }
      let finalPath
      if (order.length === 0) {
        const out = await render(envelopeFor({}), { inputs: compiled.slots.map((s) => ({ slot: s.slot, path: byLabel.get(s.label).path })), masks: [] }, { signal, report, label, conversation, candidateId: c.id })
        noteCleanup(out)
        finalPath = out.file
      } else {
        // One masked pass per note, in the order shown; each composited onto its own source and checked.
        const sourceAttachment = byLabel.get(compiled.slots[0].label)
        let current = { path: sourceAttachment.path, sha256: sourceAttachment.sha256, id: sourceAttachment.id }
        const masks = await masksOf(draft)
        for (const [i, pass] of order.entries()) {
          const note = draft.regions.find((r) => r.id === pass.regionId)
          const out = await render(envelopeFor({
            instruction: compiled.passes.find((p) => p.regionId === pass.regionId)?.instruction ?? compiled.instruction,
            seed: passSeeds[i] ?? c.seed,
            inputs: [{ attachmentId: current.id, sha256: current.sha256, slot: 1 }],
            masks: [note.mask],
          }), { inputs: [{ slot: 1, path: current.path }], masks: [{ id: note.mask.id, path: maskPath(conversation, note.mask.id) }] }, { signal, report, label, conversation, candidateId: c.id })
          noteCleanup(out)
          const before = decode(readFileSync(current.path))
          const mask = masks.get(note.mask.id)
          const merged = composite(before, decode(readFileSync(out.file)), mask)
          if (!preserved(before, merged, mask)) throw new EditorFailure('render_failed', 'The edit changed pixels outside the selected area.')
          const bytes = encode(merged)
          const path = join(quarantine, `pass-${i + 1}.png`)
          writeFileSync(path, bytes)
          rmSync(out.file, { force: true })
          // An intermediate is checked before it is used as the next pass's source.
          if (i < order.length - 1) {
            const check = await policy.checkOutput({ runId: c.runId, conversationId: conversation, inputs: inputDecision, adult, output: { sha256: sha256(bytes), mimeType: 'image/png', data: bytes.toString('base64') } }, signal)
            if (check.decision !== 'allowed') throw new EditorFailure(check.reason, MESSAGES[check.reason])
          }
          current = { path, sha256: sha256(bytes), id: `${c.id}_p${i + 1}` }
        }
        finalPath = current.path
      }
      if (signal.aborted) throw new EditorFailure('cancelled', 'Stopped.')
      c = await updateCandidate(conversation, batchId, candidateId, { state: 'checking_output' })
      await log.transition(c.runId, conversation, 'checking_output')
      const bytes = readFileSync(finalPath)
      if (!isPng(bytes)) throw new EditorFailure('render_failed', 'The edit did not produce a PNG.')
      // Re-encoded from pixels: whatever workflow or prompt ComfyUI wrote into the file is gone.
      const clean = encode(decode(bytes))
      const check = await policy.checkOutput({ runId: c.runId, conversationId: conversation, inputs: inputDecision, adult, output: { sha256: sha256(clean), mimeType: 'image/png', data: clean.toString('base64') } }, signal)
      if (check.decision !== 'allowed') throw new EditorFailure(check.reason, MESSAGES[check.reason])
      const publishable = join(quarantine, 'approved.png')
      writeFileSync(publishable, clean)
      const version = await withLock(conversation, async () => {
        if (signal.aborted) throw new EditorFailure('cancelled', 'Stopped.')
        guard(conversation)
        if (!(await isLive(context.leaseId))) throw new EditorFailure('revoked', 'The pictures this edit used were deleted.')
        const image = decode(clean)
        const source = await register({
          conversationId: conversation, path: publishable, sha256: sha256(clean), dimensions: { width: image.width, height: image.height },
          origin: 'approved_result', parentVersionId: draft.source.versionId,
        })
        await records.saveVersion({ source, batchId, candidateId: c.id, favorite: false, createdAt: now(), removed: false }, conversation)
        return source
      })
      rmSync(join(base(), 'quarantine', c.runId), { recursive: true, force: true })
      await log.transition(c.runId, conversation, 'completed', { outputVersionId: version.versionId, cleanup: 'complete' })
      await updateCandidate(conversation, batchId, candidateId, { state: 'completed', reason: null, outputVersionId: version.versionId })
    } catch (error) {
      if (error?.cleanup === 'pending') await markUntidy(conversation, snapshot.destination.kind === 'paired' ? snapshot.destination.hostId : 'interaction')
      const code = signal.aborted ? 'cancelled' : (error?.code ?? 'render_failed')
      await fail(code, String(error?.message ?? error))
    }
  }

  async function transform(draft, signal) {
    guard(draft.conversationId)
    const context = await lease(draft.conversationId, [draft.source.attachmentId], signal)
    try {
      const source = context.attachments[0]
      const png = readFileSync(source.path)
      if (!isPng(png)) throw new EditorFailure('attachment_unavailable', 'This picture has to be opened in the editor again before it can be changed.')
      let mask
      if (draft.transform.kind === 'erase_alpha') {
        const note = draft.regions.find((r) => r.mask?.id === draft.transform.maskId)
        if (!note || note.stale) throw new EditorFailure('region_stale', 'Select the area to erase on this version first.')
        mask = maskPng(readMask(readFileSync(maskPath(draft.conversationId, note.mask.id)), note.mask, draft.source), draft.source.dimensions)
      }
      const out = applyTransform(png, draft.transform, { mask })
      const at = join(base(), 'quarantine', ids('xf'))
      mkdirSync(at, { recursive: true })
      const path = join(at, 'result.png')
      writeFileSync(path, out.png)
      const version = await withLock(draft.conversationId, async () => {
        guard(draft.conversationId)
        const registered = await register({
          conversationId: draft.conversationId, path, sha256: sha256(out.png), dimensions: { width: out.width, height: out.height },
          origin: 'deterministic_transform', parentVersionId: draft.source.versionId,
        })
        await records.saveVersion({ source: registered, batchId: null, candidateId: null, favorite: false, createdAt: now(), removed: false }, draft.conversationId)
        return registered
      })
      rmSync(at, { recursive: true, force: true })
      const next = { ...draft, source: version, transform: null, operation: 'image_edit', regions: rebase(draft.regions, version.versionId) }
      return await records.saveDraft(next, draft.revision, draft.conversationId)
    } catch (error) {
      if (error instanceof TransformError) throw new EditorFailure(error.code === 'export_incompatible' ? 'export_incompatible' : 'settings_incompatible', error.message)
      if (error instanceof RegionError) throw new EditorFailure(error.code, error.message)
      throw error
    } finally {
      await release(context.leaseId)
    }
  }

  const result = (draft = null, batch = null, exports = []) => ({ draft, batch: batch && wireBatch(batch), exports })
  const wireBatch = (b) => {
    const out = { ...b }
    delete out.snapshotId
    return out
  }

  async function command(conversation, raw, signal = new AbortController().signal, { adult = false } = {}) {
    const parsed = EditorCommand.safeParse(raw)
    if (!parsed.success) throw new EditorFailure('schema_unsupported', 'That editor command is not valid.')
    const cmd = parsed.data
    guard(conversation)
    if (cmd.invocationId) {
      const seen = await records.invocation(cmd.invocationId, conversation)
      if (seen) return seen
    }
    const remember = async (value) => {
      if (cmd.invocationId) await records.saveInvocation(cmd.invocationId, conversation, value)
      return value
    }
    switch (cmd.type) {
      case 'save':
        return result(await records.saveDraft(cmd.draft, cmd.expectedRevision, conversation))
      case 'mask': {
        const draft = await current(conversation, cmd.draftId, cmd.revision)
        const note = draft.regions.find((r) => r.id === cmd.regionId)
        if (!note) throw new EditorFailure('region_invalid', 'That note is not in this draft.')
        let mask
        try {
          mask = rasterize(draft.source.dimensions, cmd.shapes, cmd.featherPixels)
        } catch (error) {
          throw new EditorFailure('region_invalid', error.message)
        }
        const png = maskPng(mask, draft.source.dimensions)
        const maskId = ids('mask')
        let descriptor
        try {
          descriptor = describeMask({ id: maskId, artifactId: maskId, source: draft.source, mask, png, featherPixels: cmd.featherPixels })
        } catch (error) {
          throw new EditorFailure('region_invalid', error.message)
        }
        mkdirSync(join(editsDir(conversation), 'masks'), { recursive: true })
        writeFileSync(maskPath(conversation, maskId), png)
        const regions = draft.regions.map((r) => (r.id === cmd.regionId ? { ...r, mask: descriptor, sourceVersionId: draft.source.versionId, stale: false, reviewed: false } : r))
        return result(await records.saveDraft({ ...draft, regions }, draft.revision, conversation), null, [{ artifactId: maskId, name: `${maskId}.png`, mime: 'image/png', url: await share(conversation, maskPath(conversation, maskId), 'image/png') }])
      }
      case 'generate':
      case 'clarify': {
        const draft = await current(conversation, cmd.draftId, cmd.revision)
        if (TRANSFORMS.has(draft.operation)) {
          if (cmd.type === 'clarify' || !draft.transform || draft.transform.kind !== draft.operation) throw new EditorFailure('settings_incompatible', 'Set up the crop, resize or erase first.')
          return remember(result(await transform(draft, signal)))
        }
        let answer = null
        if (cmd.type === 'clarify') {
          const pending = await records.pending(draft.id, conversation)
          if (!pending || pending.revision !== draft.revision) throw new EditorFailure('ambiguous_intent', 'There is no open question for this draft.')
          answer = cmd.answer
        }
        const prepared = await prepare(draft, { answer, invocationId: cmd.invocationId, signal, adult })
        if (prepared.clarification) return remember(result(draft))
        return remember(result(draft, await startBatch(prepared, draft.variantCount)))
      }
      case 'make_more': {
        const old = await records.batch(cmd.batchId, conversation)
        if (!old) throw new EditorFailure('context_required', 'That batch is not in this conversation.')
        const snapshot = await records.snapshot(old.snapshotId ?? old.id, conversation)
        // Fresh seeds, same frozen source and intent — but new checks: the lease and policy are current-state facts.
        const draft = { ...snapshot.draft, settings: { ...snapshot.draft.settings, seed: null }, variantCount: cmd.variantCount }
        const prepared = await prepare(draft, { invocationId: cmd.invocationId, signal, adult })
        if (prepared.clarification) return remember(result(snapshot.draft))
        return remember(result(snapshot.draft, await startBatch(prepared, cmd.variantCount)))
      }
      case 'retry_failed': {
        const { batch, candidate } = await findCandidate(conversation, cmd.candidateId)
        if (candidate.state !== 'failed') throw new EditorFailure(candidate.state === 'blocked' ? candidate.reason : 'draft_conflict', candidate.state === 'blocked' ? 'A blocked version cannot be retried.' : 'Only a failed version can be retried.')
        const snapshot = await records.snapshot(batch.snapshotId ?? batch.id, conversation)
        const saved = await records.read('compiled', snapshot.id, conversation)
        const prepared = await reprepare(snapshot, saved, signal)
        await updateCandidate(conversation, batch.id, candidate.id, { state: 'queued', reason: null, attemptId: ids('att'), runId: ids('run') })
        schedule(conversation, batch.id, [candidate.id], prepared)
        return remember(result(snapshot.draft, await records.batch(batch.id, conversation)))
      }
      case 'cancel_remaining': {
        const batch = await records.batch(cmd.batchId, conversation)
        if (!batch) throw new EditorFailure('context_required', 'That batch is not in this conversation.')
        active.get(batch.id)?.abort()
        for (const c of batch.candidates.filter((x) => x.state === 'queued')) {
          await updateCandidate(conversation, batch.id, c.id, { state: 'cancelled', reason: 'cancelled' })
        }
        return result(null, await records.batch(batch.id, conversation))
      }
      case 'edit_version': {
        const draft = await current(conversation, cmd.draftId, cmd.revision)
        const version = await records.version(cmd.versionId, conversation)
        if (!version || version.removed) throw new EditorFailure('context_required', 'That version is not in this conversation.')
        const next = { ...draft, source: version.source, regions: rebase(draft.regions, version.source.versionId), transform: null, referenceIds: draft.referenceIds.filter((id) => id !== version.source.attachmentId), referenceRoles: (draft.referenceRoles ?? []).filter((r) => r.attachmentId !== version.source.attachmentId) }
        return result(await records.saveDraft(next, draft.revision, conversation))
      }
      case 'favorite': {
        const version = await records.version(cmd.versionId, conversation)
        if (!version) throw new EditorFailure('context_required', 'That version is not in this conversation.')
        await records.saveVersion({ ...version, favorite: cmd.favorite }, conversation)
        return result()
      }
      case 'remove_version': {
        const version = await records.version(cmd.versionId, conversation)
        if (!version) throw new EditorFailure('context_required', 'That version is not in this conversation.')
        if (version.source.origin === 'original') throw new EditorFailure('draft_conflict', 'The original picture cannot be removed from its history.')
        await records.saveVersion({ ...version, removed: true }, conversation)
        return result()
      }
      case 'export': {
        const exports = []
        const versions = []
        for (const id of cmd.versionIds) {
          const v = await records.version(id, conversation)
          if (!v || v.removed) throw new EditorFailure('context_required', 'That version is not in this conversation.')
          versions.push(v)
        }
        const context = await lease(conversation, versions.map((v) => v.source.attachmentId), signal)
        try {
          for (const [i, v] of versions.entries()) {
            const a = context.attachments.find((x) => x.id === v.source.attachmentId)
            let ready
            try {
              ready = prepareExport(readFileSync(a.path), { format: cmd.format, background: cmd.background })
            } catch (error) {
              throw new EditorFailure(error.code === 'export_incompatible' ? 'export_incompatible' : 'attachment_unavailable', error.message)
            }
            const out = join(editsDir(conversation), 'exports')
            mkdirSync(out, { recursive: true })
            const path = join(out, `${v.source.versionId}.png`)
            writeFileSync(path, ready.png)
            exports.push({ artifactId: `${v.source.versionId}_export`, name: `edit-${i + 1}.${cmd.format === 'jpeg' ? 'jpg' : cmd.format}`, mime: 'image/png', url: await share(conversation, path, 'image/png') })
          }
        } finally {
          await release(context.leaseId)
        }
        return result(null, null, exports)
      }
    }
    throw new EditorFailure('schema_unsupported', 'That editor command is not valid.')
  }

  async function current(conversation, draftId, revision) {
    let draft
    try {
      draft = await records.draft(draftId, conversation)
    } catch (error) {
      if (error instanceof DraftError) throw new EditorFailure(error.code, error.message)
      throw error
    }
    if (draft.revision !== revision) throw new EditorFailure('draft_conflict', 'This draft changed somewhere else. Reload it to see the latest.')
    return draft
  }

  async function findCandidate(conversation, candidateId) {
    for (const batch of await records.list('batch', conversation)) {
      const candidate = batch.candidates.find((c) => c.id === candidateId)
      if (candidate) return { batch, candidate }
    }
    throw new EditorFailure('context_required', 'That version is not in this conversation.')
  }

  /** A retry reuses the frozen snapshot and compiled intent, with a fresh lease of the same pictures. */
  async function reprepare(snapshot, saved, signal) {
    const { profile } = await chosenProfile(snapshot.draft)
    const context = await lease(snapshot.draft.conversationId, saved.attachments.map((a) => a.id), signal)
    if (context.attachments.some((a) => saved.attachments.find((s) => s.id === a.id)?.sha256 !== a.sha256)) {
      await release(context.leaseId)
      throw new EditorFailure('attachment_unavailable', 'The pictures this edit used have changed.')
    }
    return { snapshot: { ...snapshot, leaseId: context.leaseId }, compiled: saved.compiled, order: saved.order, profile, context, inputDecision: saved.inputs, adult: saved.adult === true }
  }

  return {
    command,

    /** Open a picture in the editor: its original version and a fresh draft. */
    async open(conversation, { attachmentId, sha256: hash, dimensions }, { profile = null, settings } = {}) {
      guard(conversation)
      const versionId = `v_${attachmentId}`
      let version = await records.version(versionId, conversation)
      if (!version) {
        version = { source: { versionId, attachmentId, conversationId: conversation, dimensions, sha256: hash, origin: 'original', parentVersionId: null }, batchId: null, candidateId: null, favorite: false, createdAt: now(), removed: false }
        await records.saveVersion(version, conversation)
      }
      const draft = {
        id: ids('draft'), revision: 1, conversationId: conversation, source: version.source, referenceIds: [], instruction: '', regions: [],
        operation: 'image_edit', transform: null, profile,
        settings: settings ?? { dimensions: { ...dimensions }, preset: null, steps: null, changeAmount: null, seed: null },
        variantCount: 1,
      }
      return await records.saveDraft(draft, 0, conversation)
    },
    loadDraft: (conversation, id) => records.draft(id, conversation),
    versions: async (conversation) => (await records.versions(conversation)).filter((v) => !v.removed).map((v) => ({ source: v.source, batchId: v.batchId, candidateId: v.candidateId, favorite: v.favorite, createdAt: v.createdAt })),
    batch: async (conversation, id) => {
      const b = await records.batch(id, conversation)
      if (!b) throw new EditorFailure('context_required', 'That batch is not in this conversation.')
      return wireBatch(b)
    },
    pending: (conversation, draftId) => records.pending(draftId, conversation),
    runs: (conversation) => log.list(conversation),
    /** Resolves when everything queued so far has finished. For tests and orderly shutdown. */
    idle: () => queue,

    /** Until every candidate of one batch has finished, reporting as they do. */
    async waitBatch(conversation, batchId, { signal, onChange = () => {} } = {}) {
      for (;;) {
        const b = await records.batch(batchId, conversation)
        if (!b) throw new EditorFailure('context_required', 'That batch is not in this conversation.')
        onChange(wireBatch(b))
        if (b.candidates.every((c) => isTerminal(c.state))) return wireBatch(b)
        if (signal?.aborted) throw new EditorFailure('cancelled', 'Stopped.')
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    },

    /**
     * **An edit asked for in chat**: the plan is already made (the tool made it to find the
     * target), so the draft is built around that target and the same checks run from there.
     */
    async fromChat(conversation, { context, request, planned, profile, invocationId, signal, adult = false }) {
      guard(conversation)
      const target = context.attachments.find((a) => a.label === planned.job.target)
      if (!target) throw new EditorFailure('selection_mismatch', 'The picture to change is not one of those selected.')
      const contributing = planned.job.references.filter((r) => r.strength > 0 && r.image !== target.label).map((r) => r.image)
      const references = context.attachments.filter((a) => contributing.includes(a.label)).map((a) => a.id)
      const opened = await this.open(conversation, { attachmentId: target.id, sha256: target.sha256, dimensions: target.dimensions }, { profile })
      const found = (await profiles()).find((p) => p.descriptor.selection.id === profile?.id && p.descriptor.selection.version === profile?.version)
      const size = found?.profile.settings.dimensions.find((d) => d.width === target.dimensions.width && d.height === target.dimensions.height) ?? found?.profile.settings.dimensions[0] ?? target.dimensions
      const draft = await records.saveDraft({ ...opened, instruction: request, referenceIds: references, settings: { ...opened.settings, dimensions: { ...size } } }, opened.revision, conversation)
      const seen = await records.invocation(invocationId, conversation)
      if (seen) return seen
      const prepared = await prepare(draft, { invocationId, signal, planned, adult })
      const out = result(draft, await startBatch(prepared, 1))
      await records.saveInvocation(invocationId, conversation, out)
      return out
    },

    /** Deletion, as a `PrivateDeletionParticipant`: suppress first, then clean up. */
    participant: {
      async revoke(conversation) {
        revoked.add(conversation)
        for (const batch of await records.list('batch', conversation)) active.get(batch.id)?.abort()
        // Wait for any publication already inside the lock to finish; none can start after this.
        await withLock(conversation, async () => {})
      },
      async cleanup(conversation, revocationId) {
        const runs = (await log.list(conversation)).map((r) => r.runId)
        for (const r of runs) rmSync(join(base(), 'quarantine', r), { recursive: true, force: true })
        rmSync(editsDir(conversation), { recursive: true, force: true })
        await policy.forget(conversation, runs)
        await records.forget(conversation)
        // Render hosts sweep what Alexia lent them (`sweep()` in runtime.js) whenever they start or
        // release; a host that has not confirmed since a run left files behind is still pending.
        const untidy = (await storage.get(untidyKey).catch(() => undefined)) ?? []
        const remote = [...new Map(untidy.filter((u) => u.conversation === conversation).map((u) => [u.hostId, { hostId: u.hostId, state: 'pending', reason: 'Waiting for that computer to clean up.' }])).values()]
        return { revocationId, local: 'complete', remote }
      },
    },

    /** A host reported its sweep finished: nothing Alexia lent it remains. */
    async hostSwept(hostId) {
      const all = (await storage.get(untidyKey).catch(() => undefined)) ?? []
      await storage.set(untidyKey, all.filter((u) => u.hostId !== hostId))
    },

    /**
     * After a restart: nothing that was mid-flight is resubmitted blindly. A candidate whose
     * submission state is unknown is marked for reconciliation and can be retried by the person.
     */
    async recover() {
      for (const conversation of await records.conversations('batch')) {
        for (const batch of await records.list('batch', conversation)) {
          for (const c of batch.candidates.filter((x) => !isTerminal(x.state))) {
            rmSync(join(base(), 'quarantine', c.runId), { recursive: true, force: true })
            Object.assign(c, { state: 'failed', reason: 'reconciliation_required' })
          }
          batch.state = batchState(batch.candidates)
          await records.saveBatch(batch, conversation)
        }
      }
    },
  }
}
