// SPDX-License-Identifier: AGPL-3.0-only
import { ADULT_META, ATTACHMENT_CONTEXT_META, ATTACHMENT_INPUTS_META, AttachmentCallContext, EDITOR_META, fromJsonSchema, negotiatePrivateContext, PRIVATE_CONTEXT_CAPABILITY } from '@alexia/sdk'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { facts, note } from '../compute.js'
import { plan as planEdit } from './planner.js'
import { visionProvider } from './policy/providers.js'
import { describeProfile, inventory, PROFILES } from './profiles.js'
import { editor, EditorFailure } from './run.js'
import { installProfile } from './install.js'
import { EDIT, EDIT_PLAN_VERSION, editRenderer, sweep } from './runtime.js'
import { safety } from './safety.js'
import { forModel } from './transforms.js'

/**
 * The image editor, connected to the running plugin (A00 integration).
 *
 * Everything the modules in this folder take as an adapter is supplied here from the real
 * thing: sampling is MCP's `sampling/createMessage` marked private, pictures are core's
 * `alexia/attachments/*`, rendering is `compute.run` on the computer the person chose, and
 * policy evidence comes from strict local-vision assessments of the inputs and output.
 *
 * Two tools: `alexia_editor`, which core calls for the editor screen and never shows a model,
 * and `edit_image`, the chat-facing one whose `images` core resolves into pinned, authorized
 * files before the call arrives.
 */

/** No evaluation report exists for the local-vision safety checks yet (release blocker 4). */
const EVALUATION = null

const anything = fromJsonSchema({ type: 'object' })
const EDIT_IMAGE_SCHEMA = fromJsonSchema({
  type: 'object',
  properties: {
    request: { type: 'string', description: 'What the person asked for, in their own words.' },
    images: { type: 'array', items: { type: 'string' }, maxItems: 3, description: 'Labels of the pictures to use, like image_1 — the one to change and up to two to take things from.' },
  },
  required: ['request', 'images'],
  additionalProperties: false,
})

/** How long a model on this computer may take over one look, when the caller set no deadline. */
const SAMPLE_MS = 5 * 60_000
/** The longest side a whole-picture edit's inputs are sent at. */
const RENDER_MOST = 2048

export function mountEditor({ alexia, compute, own, connectManaged, installManaged, releaseManaged = async () => {}, log = () => {} }) {
  /** A picture's copy for the renderer, made once per picture; the picture itself is never changed. */
  const forRender = (path, conversation) => {
    try {
      const bytes = readFileSync(path)
      // With the conversation's other edit files, in this plugin's own folder: a place it may
      // write and send from, and forgotten with the conversation's pictures.
      const dir = join(own(), 'edits', String(conversation), 'render-inputs')
      const copy = join(dir, `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.png`)
      if (!existsSync(copy)) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(copy, Buffer.from(forModel(bytes.toString('base64'), RENDER_MOST), 'base64'))
      }
      return copy
    } catch {
      return path
    }
  }
  /** Pictures shrunk for a model, by their bytes, so the planner and the policy check share the work. */
  const shrunk = new Map()
  const small = (content) => {
    if (content?.type !== 'image' || content.mimeType !== 'image/png' || typeof content.data !== 'string') return content
    const key = createHash('sha256').update(content.data).digest('hex')
    if (!shrunk.has(key)) {
      shrunk.set(key, forModel(content.data))
      if (shrunk.size > 8) shrunk.delete(shrunk.keys().next().value)
    }
    return { ...content, data: shrunk.get(key) }
  }
  const sample = (request) => alexia.server.server.createMessage(
    {
      // A message to core is at most 10 MB; a phone photo is more. See `forModel`.
      messages: request.messages.map((m) => ({ ...m, content: Array.isArray(m.content) ? m.content.map(small) : small(m.content) })),
      ...(request.systemPrompt !== undefined && { systemPrompt: request.systemPrompt }),
      includeContext: 'none',
      maxTokens: request.maxTokens ?? 2048,
      _meta: request._meta,
    },
    {
      ...(request.signal && { signal: request.signal }),
      // A model on this computer reading two photos takes a minute or two on a laptop, far past
      // MCP's sixty-second default: the planner's own deadline, or five minutes, is the limit.
      timeout: Math.max(1_000, (request.deadlineAt ?? Date.now() + SAMPLE_MS) - Date.now()),
    },
  )
  const kv = { get: (k) => alexia.storage.get(k), set: (k, v) => alexia.storage.set(k, v) }
  const policy = safety({ provider: visionProvider({ sample, evaluation: EVALUATION }), store: kv })
  const call = (method, params) => alexia.call(method, params)
  /**
   * **This request's core must enforce the whole private contract**, or nothing happens. Checked
   * on every call from what core sent with it — never remembered from an earlier one.
   */
  const negotiated = (ctx, jobVersion = '1.1') => {
    const said = ctx?.mcpReq?._meta?.[PRIVATE_CONTEXT_CAPABILITY]
    return negotiatePrivateContext(Number(said?.protocol), said?.capabilities, jobVersion)
  }

  /**
   * The newest look at the picture being made, per conversation: ComfyUI's preview, as the
   * screen asks for it while a version renders. Held in memory only and replaced by the next.
   */
  const previews = new Map()

  /** Events for the screen, kept briefly per conversation; a gap means reload the batch. */
  const events = new Map()
  const emit = (conversation, event) => {
    const list = events.get(conversation) ?? []
    list.push(event)
    events.set(conversation, list.slice(-200))
  }

  /** The profiles the picker shows, checked against what is installed for this computer's own renders. */
  async function localProfiles() {
    const managed = await connectManaged({ probe: true }).catch(() => undefined)
    return Promise.all(PROFILES.map(async (profile) => {
      const installed = managed?.models && profile.status !== 'candidate' ? await inventory(profile, managed.models).catch(() => null) : null
      const descriptor = describeProfile(profile, { destination: { kind: 'interaction' }, installed })
      if (!managed?.managed) {
        descriptor.availability = 'needs_installation'
        descriptor.reason = 'Install the managed ComfyUI on the computer selected for pictures.'
      }
      return { profile, descriptor }
    }))
  }

  /**
   * `patience` is for the picker: the check waits in the picture computer's queue like any
   * job, and behind a model download that is hours. The picker answers "busy" instead and
   * asks again when the queue is free. The check itself is left to finish, not cancelled: its
   * first run on a computer hashes the model files, and that is what makes the next one quick.
   */
  async function profiles({ patience } = {}) {
    let waited = false
    try {
      const check = compute.run(EDIT, { kind: 'profiles', version: EDIT_PLAN_VERSION })
      const ran = patience
        ? await Promise.race([check, new Promise((resolve) => setTimeout(resolve, patience).unref?.())])
        : await check
      if (ran === undefined) {
        waited = true
        check.catch(() => undefined)
        throw new Error('busy')
      }
      const result = facts(ran.text)
      if (!Array.isArray(result.profiles)) throw new Error('Update the media plugin on the picture computer to check editing models.')
      return result.profiles.map((descriptor) => ({
        descriptor,
        profile: PROFILES.find((p) => p.id === descriptor.selection.id && p.version === descriptor.selection.version),
      })).filter((p) => p.profile)
    } catch (error) {
      return PROFILES.map((profile) => ({ profile, descriptor: {
        ...describeProfile(profile, { destination: { kind: 'interaction' } }),
        availability: 'offline',
        reason: waited ? 'The picture computer is busy. This updates when it is free.' : String(error?.message ?? error).slice(0, 300),
      } }))
    }
  }

  const backend = editor({
    storage: alexia.storage,
    dir: own,
    lease: (conversationId, attachmentIds) => call('alexia/attachments/lease', { conversationId, attachmentIds }),
    isLive: async (leaseId) => (await call('alexia/attachments/live', { leaseId })).live,
    release: (leaseId) => call('alexia/attachments/release', { leaseId }),
    register: async ({ conversationId, path, origin, parentVersionId }) => {
      const kept = await call('alexia/attachments/register', { conversationId, path, origin })
      return { versionId: `v_${kept.id}`, attachmentId: kept.id, conversationId, dimensions: kept.dimensions, sha256: kept.sha256, origin, parentVersionId }
    },
    share: async (conversationId, path, mime) => (await call('alexia/attachments/share', { conversationId, path, mime })).url,
    plan: (request) => planEdit({ ...request, sample }),
    policy,
    profiles,
    emit,
    render: async (envelope, files, { signal, label, conversation, candidateId }) => {
      try {
        // A whole-picture edit sends each picture at most 2048 on its long side: Qwen Image Edit
        // works at about a megapixel, and a phone photo is twelve, sent over the network. A
        // masked edit keeps its pictures as they are, because the mask matches them pixel for pixel.
        if (files.masks.length === 0) {
          files = { ...files, inputs: files.inputs.map((input) => ({ ...input, path: forRender(input.path, conversation) })) }
          // The renderer checks every picture against the hash it was authorized with, so the
          // smaller copy is authorized as itself.
          const hashes = new Map(files.inputs.map((input) => [Number(input.slot), createHash('sha256').update(readFileSync(input.path)).digest('hex')]))
          envelope = { ...envelope, inputs: envelope.inputs.map((input) => (hashes.has(Number(input.slot)) ? { ...input, sha256: hashes.get(Number(input.slot)) } : input)) }
        }
        const out = await compute.run(EDIT, { kind: 'edit', version: EDIT_PLAN_VERSION, envelope, inputs: files.inputs, masks: files.masks }, {
          signal,
          report: (message, done, total, work) => {
            log(`${label}: ${message}`)
            if (work?.preview && conversation !== undefined) previews.set(conversation, { candidateId, preview: work.preview, at: Date.now(), done, total })
          },
          inputs: [...files.inputs, ...files.masks].map((f) => ({ name: basename(f.path), path: f.path, mime: 'image/png' })),
        })
        const said = facts(out.text)
        if (!out.files[0]) throw new EditorFailure('render_failed', 'The edit produced no picture.')
        return { file: out.files[0], ...said }
      } finally {
        // The finished picture is checked before it is shown; the preview of it goes now.
        if (conversation !== undefined && previews.get(conversation)?.candidateId === candidateId) previews.delete(conversation)
      }
    },
  })

  // The heavy half: runs on whichever computer the person chose, against Alexia's own ComfyUI.
  const renderEdit = editRenderer({ own, connect: (io) => connectManaged(io) })
  compute.operation(EDIT, async (plan, io) => {
    if (plan.kind === 'install_profile') {
      let at = await connectManaged({ probe: true })
      if (!at.managed && installManaged) {
        await installManaged({ signal: io.signal, report: io.report })
        at = await connectManaged({ probe: true })
      }
      if (!at.managed) throw new Error('Install the managed ComfyUI on the picture computer first.')
      await releaseManaged()
      await installProfile(plan.profile, { ...at, signal: io.signal, report: io.report })
      return { text: note({ installed: true }) }
    }
    if (plan.kind === 'profiles') return { text: note({ profiles: (await localProfiles()).map((p) => p.descriptor) }) }
    const out = await renderEdit(plan, {
      signal: io.signal,
      // Words, numbers and ComfyUI's preview of the work so far — the person chose to see it.
      report: (r) => {
        if (r.message !== undefined) io.report(r.message, r.value ?? 0, r.total ?? 0, r.preview ? { preview: r.preview } : undefined)
      },
    })
    return { text: note({ width: out.width, height: out.height, promptId: out.promptId, executed: out.executed, cleanup: out.cleanup }), files: [out.file] }
  })

  /** What the editor's own tool answers: JSON, with failures as `{ code, message }`. */
  const answer = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
  const refuse = (error) => ({
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code: error?.code ?? 'render_failed', message: String(error?.message ?? error) }) }],
  })

  alexia.tool(
    'alexia_editor',
    {
      description: 'The image editor screen. Called by Alexia for the person at the screen; never by a model.',
      inputSchema: anything,
      _meta: { [EDITOR_META]: { editor: '1' } },
    },
    async (args, ctx) => {
      const conversation = String(args.conversationId ?? '')
      const signal = ctx?.mcpReq?.signal
      const deal = negotiated(ctx)
      if (!deal.ok) return refuse({ code: deal.reason, message: 'This version of Alexia cannot keep the promises editing needs. Update Alexia.' })
      try {
        switch (args.call) {
          case 'open': {
            const context = await call('alexia/attachments/lease', { conversationId: conversation, attachmentIds: [String(args.attachmentId)] })
            await call('alexia/attachments/release', { leaseId: context.leaseId })
            const a = context.attachments[0]
            const chosen = await alexia.storage.get('edit_profile').catch(() => undefined)
            return answer({ draft: await backend.open(conversation, { attachmentId: a.id, sha256: a.sha256, dimensions: a.dimensions }, { profile: chosen ?? null }) })
          }
          case 'loadDraft': return answer({ draft: await backend.loadDraft(conversation, String(args.draftId)) })
          case 'profiles': return answer({ profiles: (await profiles({ patience: 8_000 })).map((p) => p.descriptor), selected: (await alexia.storage.get('edit_profile').catch(() => undefined)) ?? null })
          case 'install_profile': {
            await compute.run(EDIT, { kind: 'install_profile', profile: args.profile }, { signal, report: log })
            return answer({ profiles: (await profiles()).map((p) => p.descriptor) })
          }
          case 'select_profile': {
            // The person's explicit choice, kept until they change it — never replaced for them.
            await alexia.storage.set('edit_profile', args.profile ?? null)
            return answer({ selected: args.profile ?? null })
          }
          case 'versions': return answer({ versions: await backend.versions(conversation) })
          case 'batch': return answer({ batch: await backend.batch(conversation, String(args.batchId)) })
          case 'pending': return answer({ pending: await backend.pending(conversation, String(args.draftId)) })
          case 'preview': {
            const now = previews.get(conversation)
            return answer({ preview: now ? { candidateId: now.candidateId ?? null, preview: now.preview, at: now.at, done: now.done ?? 0, total: now.total ?? 0 } : null })
          }
          case 'events': {
            const after = Number(args.after ?? -1)
            return answer({ events: (events.get(conversation) ?? []).filter((e) => e.sequence > after) })
          }
          // Adult mode is core's to say — set only when the person confirmed 18+ in Settings and typed /nsfw.
          case 'command': return answer(await backend.command(conversation, args.command, signal, { adult: ctx?.mcpReq?._meta?.[ADULT_META] === true }))
          case 'revoke':
            await backend.participant.revoke(conversation)
            return answer({ ok: true })
          case 'cleanup': return answer(await backend.participant.cleanup(conversation, String(args.revocationId)))
          default: return refuse({ code: 'schema_unsupported', message: 'The editor does not do that.' })
        }
      } catch (error) {
        return refuse(error)
      }
    },
  )

  alexia.tool(
    'edit_image',
    {
      description:
        'Edit a picture the person attached, using up to two other attached pictures as references — for example "use my face from image_1 and the outfit from image_2". ' +
        'Pass the person\'s request in their words and the labels of every picture it involves (at most three, including the one to change). ' +
        'Runs on this computer only. If it asks a question, ask the person and call it again with their answer added to the request.',
      inputSchema: EDIT_IMAGE_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      _meta: {
        [ATTACHMENT_INPUTS_META]: { fields: [{ name: 'images', cardinality: 'many', mimeTypes: ['image/png', 'image/jpeg', 'image/webp'], maxCount: 3 }] },
      },
    },
    async (args, ctx) => {
      const deal = negotiated(ctx)
      if (!deal.ok) return { isError: true, content: [{ type: 'text', text: 'This version of Alexia cannot keep the promises editing needs. Update Alexia.' }] }
      const parsed = AttachmentCallContext.safeParse(ctx?.mcpReq?._meta?.[ATTACHMENT_CONTEXT_META])
      if (!parsed.success) return { isError: true, content: [{ type: 'text', text: 'This needs the pictures from the conversation, and Alexia did not hand them over. Update Alexia.' }] }
      const context = parsed.data
      const conversation = context.conversationId
      const signal = ctx?.mcpReq?.signal
      try {
        const profile = (await alexia.storage.get('edit_profile').catch(() => undefined)) ?? null
        if (!profile) throw new EditorFailure('settings_incompatible', 'No editing model is chosen yet. Open a picture in the editor and choose one under Model.')
        const images = context.attachments.map((a) => ({ label: a.label, mimeType: a.mime, data: readFileSync(a.path).toString('base64') }))
        const planned = await planEdit({ request: String(args.request ?? ''), images, sample, signal, deadlineAt: Date.now() + 5 * 60_000 })
        if (planned.outcome === 'needs_clarification') return { content: [{ type: 'text', text: `Before editing, ask the person: ${planned.question}` }] }
        if (planned.outcome !== 'ready') throw new EditorFailure(planned.reason, planned.message)
        const started = await backend.fromChat(conversation, { context, request: String(args.request ?? ''), planned, profile, invocationId: `chat_${context.requestId}`, signal, adult: ctx?.mcpReq?._meta?.[ADULT_META] === true })
        const done = await backend.waitBatch(conversation, started.batch.id, {
          signal,
          onChange: (b) => alexia.progress(ctx, b.candidates.filter((c) => ['completed', 'failed', 'blocked', 'cancelled'].includes(c.state)).length, b.candidates.length, 'Editing the picture'),
        })
        const made = done.candidates.filter((c) => c.state === 'completed')
        if (made.length === 0) {
          const why = done.candidates[0]?.reason ?? 'render_failed'
          return { isError: true, content: [{ type: 'text', text: `The edit was not made (${why}). Nothing was shown.` }] }
        }
        // A copy for this answer, kept with the conversation's editing files and deleted with them.
        const versions = await backend.versions(conversation)
        const out = join(own(), 'edits', conversation, 'chat')
        mkdirSync(out, { recursive: true })
        const files = []
        for (const c of made) {
          const v = versions.find((x) => x.source.versionId === c.outputVersionId)
          const lease = await call('alexia/attachments/lease', { conversationId: conversation, attachmentIds: [v.source.attachmentId] })
          try {
            const path = join(out, `${v.source.versionId}.png`)
            writeFileSync(path, readFileSync(lease.attachments[0].path))
            files.push(alexia.file(path, { name: `${lease.attachments[0].label}.png`, mime: 'image/png', description: String(args.request ?? '') }))
            files.unshift({ type: 'text', text: `Made ${lease.attachments[0].label} from ${planned.job.target}. It is also in the editor, beside the original.` })
          } finally {
            await call('alexia/attachments/release', { leaseId: lease.leaseId })
          }
        }
        return { content: files }
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] }
      }
    },
  )

  return {
    backend,
    /** After a restart: unfinished work waits for the person, and Alexia's own ComfyUI is swept. */
    async recover(comfyDir) {
      await backend.recover().catch(() => {})
      if (comfyDir) {
        try {
          sweep(comfyDir)
          await backend.hostSwept('interaction')
        } catch {
          // A sweep that could not run leaves the pending cleanup recorded, to be tried again.
        }
      }
    },
  }
}
