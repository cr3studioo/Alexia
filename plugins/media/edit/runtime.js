// SPDX-License-Identifier: AGPL-3.0-only
import { EditRenderEnvelope } from '@alexia/sdk'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as comfyui from '../comfy.js'
import { bytesOf } from '../inputs.js'
import { buildGraph, missingNodes } from './graph.js'
import { find, graphSha256, inventory, manifestSha256, PROFILES, sha256File } from './profiles.js'
import { decode } from './transforms/png.js'

/**
 * One edit render, on the computer that has the graphics card — the `image.edit` operation.
 *
 * **Everything is checked before a single byte is uploaded.** The envelope's shape and version;
 * that the profile it names is one this computer knows, with the same manifest and graph
 * digests; that the ComfyUI is Alexia's own; that every model file on disk has the profile's
 * hash; that every node class exists; that each staged picture and mask is the exact file the
 * controller authorized. Only then are files uploaded and the graph — rebuilt here from the
 * profile, never received — queued.
 *
 * **Nothing generated leaves this function unchecked.** Previews are dropped at the progress
 * boundary, the single expected output goes into a private quarantine folder, and its format
 * and size are checked. Publication is the controller's decision, after its policy checks;
 * this hands back a quarantined file and the facts of what ran.
 *
 * **Everything lent to ComfyUI is taken back**, on success, failure, cancellation and a failed
 * upload halfway through a set.
 */

export const EDIT = 'image.edit'
export const EDIT_PLAN_VERSION = '1'

export class EditError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * `connect({ signal, report })` resolves to `{ server, managed, models, classes(signal), tidy(file) }`
 * for the ComfyUI on this computer. `own()` is this plugin's folder.
 */
export function editRenderer({ own, connect, comfy = comfyui, profiles = PROFILES, now = Date.now, verify = inventory }) {
  return async function renderEdit(plan, { signal, report = () => {} } = {}) {
    if (plan?.kind !== 'edit' || plan.version !== EDIT_PLAN_VERSION) {
      throw new EditError('schema_unsupported', 'This computer does not understand that edit plan version.')
    }
    const parsed = EditRenderEnvelope.safeParse(plan.envelope)
    if (!parsed.success) throw new EditError('schema_unsupported', 'The edit plan is not one this computer can run.')
    const envelope = parsed.data
    if (Date.now() >= envelope.deadlineAt) throw new EditError('timeout', 'The edit ran out of time before it started.')

    const profile = find(envelope.profile, profiles)
    if (!profile) throw new EditError('profile_unavailable', 'This computer does not have that editing model.')
    if (manifestSha256(profile) !== envelope.manifestSha256 || graphSha256(profile) !== envelope.graphSha256) {
      throw new EditError('profile_mismatch', 'This computer has a different version of that editing model. Update Alexia on both computers.')
    }
    if (profile.status === 'candidate') throw new EditError('profile_unavailable', 'That editing model has not been verified, so it cannot run.')
    if (!profile.operations.includes(envelope.operation)) throw new EditError('profile_mismatch', 'That editing model does not do this kind of edit.')

    const at = await connect({ signal, report: (message) => report({ message }) })
    if (!at.managed) throw new EditError('unsupported_server', 'Editing runs only on Alexia\'s own copy of the picture program, which can check its models and clean up after itself.')
    const installed = await verify(profile, at.models, { signal })
    if (!installed.ready) {
      const which = [...installed.missing, ...installed.mismatched][0]
      throw new EditError('profile_unavailable', `${which} is ${installed.missing.includes(which) ? 'not installed' : 'not the expected file'}. Install the editing model again.`)
    }
    const absent = missingNodes(profile, await at.classes(signal))
    if (absent.length > 0) throw new EditError('profile_unavailable', `The picture program is missing ${absent.join(', ')}.`)

    // The staged files must be exactly the ones the controller authorized.
    const staged = new Map((plan.inputs ?? []).map((i) => [Number(i.slot), i.path]))
    for (const input of envelope.inputs) {
      const path = staged.get(input.slot)
      if (!path || (await sha256File(path, signal)) !== input.sha256) {
        throw new EditError('attachment_unavailable', `Picture ${input.slot} did not arrive intact.`)
      }
    }
    const maskPaths = new Map((plan.masks ?? []).map((m) => [m.id, m.path]))
    for (const mask of envelope.masks) {
      const path = maskPaths.get(mask.id)
      if (!path || (await sha256File(path, signal)) !== mask.sha256) throw new EditError('region_invalid', 'A selected area did not arrive intact.')
    }

    const lent = []
    const made = []
    const quarantine = join(own(), 'quarantine', envelope.runId, envelope.attemptId)
    let promptId = null
    let result = null
    let failure = null
    try {
      const images = {}
      for (const input of [...envelope.inputs].sort((a, b) => a.slot - b.slot)) {
        const up = await comfy.upload(at.server, { ...bytesOf(staged.get(input.slot)), name: `${input.sha256}.png` }, signal)
        lent.push(up)
        images[input.slot] = up.name
      }
      let mask
      if (envelope.masks.length > 0) {
        const m = envelope.masks[0]
        const up = await comfy.upload(at.server, { ...bytesOf(maskPaths.get(m.id)), name: `${m.sha256}.png` }, signal)
        lent.push(up)
        mask = up.name
      }
      const graph = buildGraph(profile, {
        images,
        mask,
        prompt: envelope.instruction,
        seed: envelope.seed,
        steps: envelope.settings.steps ?? profile.settings.steps?.default,
        width: envelope.settings.dimensions.width,
        height: envelope.settings.dimensions.height,
      })
      if (signal?.aborted) throw new EditError('cancelled', 'Stopped.')
      promptId = await comfy.queue(at.server, graph, signal)
      report({ promptId })
      let found
      try {
        found = await comfy.wait(at.server, promptId, {
          signal,
          timeoutMs: Math.max(1, envelope.deadlineAt - Date.now()),
          // ComfyUI's picture so far goes with the numbers, as it does in ComfyUI. It is shown
          // and replaced, never kept; the finished picture is still checked before it is shown.
          onProgress: (message, value, total, work) => report({ message, value, total, ...(work?.preview && { preview: work.preview }) }),
        })
      } catch (error) {
        if (signal?.aborted) {
          await comfy.cancel(at.server, promptId).catch(() => {})
          throw new EditError('cancelled', 'Stopped.')
        }
        throw new EditError(/out of memory|OOM/i.test(String(error?.message)) ? 'out_of_memory' : /in time/.test(String(error?.message)) ? 'timeout' : 'render_failed', String(error?.message ?? error).slice(0, 200))
      }
      made.push(...found.files)
      const images_ = found.files.filter((f) => /\.png$/i.test(f.filename))
      if (found.files.length !== envelope.expectedOutputs || images_.length !== envelope.expectedOutputs) {
        throw new EditError('render_failed', `The edit produced ${found.files.length} files, not ${envelope.expectedOutputs} picture.`)
      }
      mkdirSync(quarantine, { recursive: true })
      const bytes = Buffer.from(await comfy.download(at.server, images_[0], signal))
      let picture
      try {
        picture = decode(bytes)
      } catch (error) {
        throw new EditError('render_failed', `The edit did not produce a readable picture: ${error.message}`)
      }
      const file = join(quarantine, `${now()}.png`)
      writeFileSync(file, bytes)
      result = {
        cleanup: 'complete',
        file,
        width: picture.width,
        height: picture.height,
        promptId,
        executed: { profile: { ...envelope.profile }, manifestSha256: envelope.manifestSha256, graphSha256: envelope.graphSha256, seed: envelope.seed },
      }
      return result
    } catch (error) {
      rmSync(quarantine, { recursive: true, force: true })
      failure = error instanceof EditError ? error : new EditError(signal?.aborted ? 'cancelled' : 'render_failed', String(error?.message ?? error).slice(0, 200))
      failure.promptId = promptId
      failure.cleanup = 'complete'
      throw failure
    } finally {
      if (promptId !== null) {
        try {
          await comfy.forgetHistory(at.server, promptId)
        } catch {
          if (result) result.cleanup = 'pending'
          if (failure) failure.cleanup = 'pending'
        }
      }
      for (const one of [...made, ...lent]) {
        try {
          await at.tidy?.(one)
        } catch {
          // Reported as pending cleanup for the run to retry; a failed tidy never replaces the outcome.
          if (result) result.cleanup = 'pending'
          if (failure) failure.cleanup = 'pending'
        }
      }
    }
  }
}

/**
 * Remove everything editing ever lent Alexia's own ComfyUI: uploads named by their hash, outputs
 * with the edit prefix, and its temp folder — under `comfyDir`, the worker's folder holding its
 * `input`, `output` and `temp` (the directories it is launched with). Run when the worker starts and when it releases —
 * never while an edit is running — so a cleanup that failed mid-job, or a crash, is finished the
 * next time this computer is used. Only the managed install is ever swept.
 */
export function sweep(comfyDir) {
  let removed = 0
  const clear = (folder, match) => {
    let names
    try {
      names = readdirSync(join(comfyDir, folder))
    } catch {
      return
    }
    for (const name of names.filter(match)) {
      rmSync(join(comfyDir, folder, name), { force: true, recursive: true })
      removed++
    }
  }
  clear('input', (n) => /^[a-f0-9]{64}\.png$/.test(n))
  clear('output', (n) => n.startsWith('alexia-edit'))
  clear('temp', () => true)
  return removed
}
