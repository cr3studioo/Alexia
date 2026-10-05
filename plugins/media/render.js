// SPDX-License-Identifier: AGPL-3.0-only
import { Buffer } from 'node:buffer'
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import * as comfyui from './comfy.js'
import { note } from './compute.js'
import { bytesOf } from './inputs.js'
import { tight } from './sizing.js'
import { api as starterGraph } from './starter.js'
import { isApi, missing } from './workflows.js'

/**
 * The heavy half of a picture: a plan in, files out (`image.render`).
 *
 * **Everything in here is something only the computer with the graphics card can answer.**
 * Which checkpoints are installed, how much memory is free this second, whether a node a
 * workflow names exists — those are facts about the machine doing the rendering, and when
 * that is a paired computer they are not facts the planner has. So the planner sends what the
 * person asked for and this decides the rest.
 *
 * A plan is one of two shapes. `picture` is the words and numbers of an ordinary request, and
 * the starter workflow is built here around a model this machine actually has. `workflow` is a
 * graph the planner already prepared from one the person saved — their fields applied, the
 * seed rolled — and it is checked against this machine's nodes and run as it stands.
 *
 * It answers with the files it wrote into this plugin's own folder, and one line about them.
 */

/** Class name → display name, which is what an export writes into `_meta.title` for an untitled node. */
export const named_of = (spec) => Object.fromEntries(Object.entries(spec).map(([one, what]) => [one, what?.display_name ?? one]))

/**
 * What to call the node that is working, in the words its author used.
 *
 * The socket says `node: "12"`, which is true and says nothing. The graph being run is right
 * here, so the title wins over the class name and the class name over the id — *Load Model —
 * step 12 of 28* is a sentence about somebody’s own pipeline rather than about a graph.
 */
export const naming = (built) => (node) => {
  const one = built?.[node]
  return String(one?._meta?.title ?? one?.class_type ?? '').trim() || undefined
}

/**
 * How much of the graphics card is free this second, or nothing if the question cannot be asked.
 *
 * `/system_stats` gives it away for free. A machine with no card, a ComfyUI that will not answer,
 * or a shape this does not recognise all come back the same way: undefined, and nothing is said.
 */
export async function free(server, signal, comfy = comfyui) {
  try {
    const machine = await comfy.stats(server, signal)
    const card = (machine?.devices ?? []).find((one) => one?.type === 'cuda' || one?.type === 'mps')
    return Number.isFinite(Number(card?.vram_free)) ? Number(card.vram_free) : undefined
  } catch {
    return undefined
  }
}

/**
 * `connect({ here, signal, report })` is the one question this cannot answer for itself: which
 * ComfyUI. It resolves to `{ server, classes(signal), tidy?(file) }` or throws the sentence
 * that says why there is none — and it is the caller's, because *the one the person has open*
 * and *one of Alexia's own* are promises this plugin makes rather than things a renderer knows.
 */
export function renderer({ own, connect, comfy = comfyui, now = Date.now }) {
  return async function render(plan, { here = false, signal, report = () => {} } = {}) {
    const dir = own()
    if (!dir) throw new Error('Alexia has not given this plugin a folder to work in.')
    const at = await connect({ here, signal, report })
    const { server } = at

    /**
     * Every picture this job was given, uploaded to the ComfyUI about to render it.
     *
     * The path is one this computer can read: the person's own file when the planner is here,
     * and core's staged copy when the job came from another computer. Either way the bytes go to
     * ComfyUI over its own upload, so a ComfyUI on another port, or one that is not this
     * process's at all, never has to be able to see the folder they came from.
     */
    const uploaded = []
    const place = async (path) => {
      let picture
      try {
        picture = bytesOf(path)
      } catch (error) {
        throw new Error(`The picture to start from could not be read on this computer: ${String(error?.message ?? error)}`, { cause: error })
      }
      const up = await comfy.upload(server, picture, signal)
      uploaded.push(up)
      return up.name
    }

    let built
    let said = { here }
    let expect = 'image'
    if (plan?.kind === 'workflow') {
      built = plan.graph
      const called = String(plan.name ?? 'That workflow')
      if (!isApi(built)) throw new Error(`${called} is not a graph ComfyUI can queue.`)
      for (const one of Array.isArray(plan.images) ? plan.images : []) {
        if (!built[one?.node]?.inputs) throw new Error(`${called} has no node ${String(one?.node)} to put a picture on.`)
      }
      // Asked again here, whatever the planner found: the nodes that matter are the ones on
      // the machine that is about to run it, and a graph naming one it lacks is a 400 whose
      // body nobody reads.
      const absent = missing(built, await at.classes(signal))
      if (absent.length > 0) {
        throw new Error(
          `${called} needs ${absent.join(', ')}, which ${absent.length === 1 ? 'is' : 'are'} not installed here. ` +
            `Install the node pack ${absent.length === 1 ? 'it comes' : 'they come'} from and it will run.`,
        )
      }
      expect = 'output'
      // Checked first and placed second, so a workflow that cannot run never costs an upload.
      if (Array.isArray(plan.images) && plan.images.length > 0) {
        built = structuredClone(built)
        for (const one of plan.images) built[one.node].inputs[one.input ?? 'image'] = await place(one.path)
      }
    } else {
      const available = await comfy.checkpoints(server, signal)
      if (available.length === 0) throw new Error('ComfyUI is running but has no checkpoint installed.')
      if (plan?.model && !comfy.pick(available, plan.model)) {
        // Named and not found is a question, not a picture. Answering it with a different
        // model would be the plugin deciding something the asker was explicit about.
        throw new Error(`There is no model here called ${plan.model}. What there is: ${available.join(', ')}`)
      }
      // **The one asked for, the one chosen, or whatever is there — and the order matters.**
      // *Whatever is there* means the first checkpoint in the folder, and on a machine with six
      // of them that is a coin toss: a request for an anime picture answered by a photographic
      // model is the plugin working perfectly and getting it wrong. A name in the call is how
      // the asker says which.
      //
      // **The one used last time sits between the two, and is only ever a preference.** It was
      // true of whichever computer rendered last, which need not be this one — so a remembered
      // name that is not here is said and stepped past, never refused like a name in the call.
      const remembered = comfy.pick(available, plan?.remembered)
      const checkpoint = comfy.pick(available, plan?.model) ?? remembered ?? comfy.pick(available, plan?.preferred) ?? available[0]
      const forgotten = plan?.remembered && !plan?.model && !remembered ? String(plan.remembered) : undefined
      const room = await free(server, signal, comfy)
      const warning = room === undefined ? undefined : tight({ width: plan.width, height: plan.height }, room)
      const spec = await at.classes(signal).catch(() => ({}))
      const start = Array.isArray(plan?.images) ? plan.images.find(Boolean) : undefined
      // **The same workflow the person can open**, rather than a second pipeline built in code.
      built = starterGraph({
        prompt: String(plan.prompt ?? ''),
        negative: String(plan.negative ?? ''),
        checkpoint,
        steps: Number(plan.steps) || 25,
        width: plan.width,
        height: plan.height,
        seed: plan.seed,
        fp32: plan.fp32 !== false,
        display: named_of(spec),
        ...(start && {
          image: await place(start),
          ...(Number.isFinite(Number(plan.change)) && { change: Number(plan.change) }),
          aspect: plan.aspect === true,
          primitive: 'PrimitiveFloat' in spec,
        }),
      })
      said = { ...said, checkpoint, ...(warning && { warning }), ...(forgotten && { forgotten }) }
    }

    let found
    const files = []
    try {
      const id = await comfy.queue(server, built, signal)
      try {
        found = await comfy.wait(server, id, {
          signal,
          expect,
          label: naming(built),
          // The pipeline, worked out from the graph rather than waited for: ComfyUI only names a
          // node once it has started, and a strip that grew as it went would draw the reporting.
          stages: comfy.order(built),
          onProgress: report,
        })
      } catch (error) {
        // The signal reaches the fetch and ends the poll; the job would carry on rendering, on a
        // graphics card nobody is waiting for. Made without the signal, because the signal is the
        // thing that just aborted — and for this job only, because the queue may hold somebody
        // else's.
        if (signal?.aborted) await comfy.cancel(server, id).catch(() => {})
        throw error
      }

      for (const one of found.files) {
        const bytes = await comfy.download(server, one, signal)
        const to = join(dir, `${now()}-${basename(one.filename)}`)
        writeFileSync(to, Buffer.from(bytes))
        files.push(to)
        await at.tidy?.(one)
      }
    } finally {
      // A worker keeps nothing it was lent, whether or not the job finished. On the person's own
      // ComfyUI `tidy` is not offered, and an upload there stays among their inputs like any
      // picture they loaded themselves.
      for (const one of uploaded) await at.tidy?.(one)
    }
    return { text: note({ ...said, ...(found.text.length > 0 && { text: found.text }) }), files }
  }
}
