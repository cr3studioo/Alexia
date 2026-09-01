// SPDX-License-Identifier: AGPL-3.0-only
import { Buffer } from 'node:buffer'

/**
 * ComfyUI, over its own HTTP API.
 *
 * ComfyUI's API takes a *graph*, not a prompt — every node of the pipeline, wired by id.
 * That is what makes it worth driving rather than replacing: the graph below is the plain
 * SDXL text-to-image pipeline, and anything a person can build in ComfyUI's editor can be
 * substituted for it later without this plugin learning anything new.
 *
 * ponytail: no websocket. ComfyUI's progress arrives over one, and polling `/history` every
 * second is a dependency and a reconnect story less for a job that takes twenty seconds. The
 * cost is progress in whole images rather than in steps. If a queue of long jobs makes that
 * unbearable, the websocket is the upgrade and it is the only thing that would change here.
 */

/**
 * The pipeline, as a graph.
 *
 * Node 8 is the decode and node 4 the checkpoint; **the VAE wiring is why `vae_fp32`
 * exists**. SDXL's own VAE overflows in fp16 on a lot of 8 GB cards and the symptom is a
 * black image with no error anywhere, which is among the least debuggable failures in this
 * whole project. Forcing the decode to full precision costs a little VRAM and removes it.
 */
export function graph({ prompt, negative, checkpoint, steps, width, height, seed, fp32 }) {
  return {
    3: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps,
        cfg: 7,
        sampler_name: 'dpmpp_2m',
        scheduler: 'karras',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    5: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
    8: {
      class_type: 'VAEDecode',
      // `VAEDecodeTiled` at full precision is the workaround that actually holds on 8 GB:
      // it decodes in tiles, so peak VRAM is a tile rather than the whole image.
      inputs: { samples: ['3', 0], vae: ['4', 2] },
    },
    ...(fp32 && {
      8: {
        class_type: 'VAEDecodeTiled',
        // Every one of these is *required* by the node, and a graph missing one is refused
        // outright with a 400 — which is how this was found, because `tile_size` alone was
        // all it sent and this is the **default** path. The two temporal inputs are for
        // video VAEs and do nothing to a still image; they are here because the node asks
        // for them, and ComfyUI's own defaults are what they are set to.
        inputs: { samples: ['3', 0], vae: ['4', 2], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 },
      },
    }),
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'alexia', images: ['8', 0] } },
  }
}

/**
 * What ComfyUI said in the body of a refusal.
 *
 * It is the whole of the useful information and the first version of this file threw it
 * away: a rejected graph is a 400 whose body names the node, the input and the reason, and
 * *ComfyUI answered 400 Bad Request* is a sentence nobody can act on. Reading it turned a
 * day's guessing into one line.
 */
const why = async (response) => {
  try {
    const body = await response.json()
    const nodes = Object.entries(body?.node_errors ?? {}).map(
      ([id, node]) =>
        `${node?.class_type ?? `node ${id}`}: ${(node?.errors ?? [])
          .map((one) => [one.message, one.details].filter(Boolean).join(' — '))
          .join('; ')}`,
    )
    const said = [body?.error?.message, ...nodes].filter(Boolean).join(' — ')
    return said ? ` — ${said}` : ''
  } catch {
    return ''
  }
}

const json = async (response) => {
  if (!response.ok) throw new Error(`ComfyUI answered ${response.status} ${response.statusText}${await why(response)}`)
  return response.json()
}

/**
 * Which of the installed checkpoints somebody meant.
 *
 * Checkpoint names are filenames people did not choose — `hassakuXLIllustrious_v22.safetensors`
 * — so *anything asking for a model by name has to match loosely or it will never match*. An
 * exact name wins, then a name that contains what was asked for, and nothing else counts: a
 * near-miss silently answered with a different model is how a request for an anime picture
 * comes back photographic, which is worse than being told the name was wrong.
 */
export function pick(available, wanted) {
  const asked = String(wanted ?? '').trim().toLowerCase()
  if (!asked) return undefined
  return (
    available.find((one) => one.toLowerCase() === asked) ??
    available.find((one) => one.toLowerCase().includes(asked))
  )
}

/**
 * What somebody typed in the Model box — or nothing, which is most of the time.
 *
 * `auto` is not a filename and must never be matched as one. It was the single option of the
 * dropdown this box replaced, so it is the value an existing install has saved, and it has to
 * go on meaning *whichever ComfyUI has* rather than start matching any checkpoint whose name
 * happens to contain those four letters.
 */
export function named(said) {
  const asked = String(said ?? '').trim()
  return asked.toLowerCase() === 'auto' ? '' : asked
}

/** Is it there, and what has it got? One call that answers both. */
export async function checkpoints(server, signal) {
  const info = await json(await fetch(`${server}/object_info/CheckpointLoaderSimple`, { signal }))
  const found = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]
  return Array.isArray(found) ? found : []
}

/** Queue a graph. What comes back is the id to ask about. */
export async function queue(server, prompt, clientId, signal) {
  const answered = await json(
    await fetch(`${server}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: clientId }),
      signal,
    }),
  )
  if (!answered.prompt_id) {
    // ComfyUI reports a bad graph as a 200 with an error object. Reading only the status
    // would leave this hanging on a job that was never queued.
    throw new Error(answered.error?.message ?? 'ComfyUI would not queue that.')
  }
  return answered.prompt_id
}

/**
 * Wait for it, reporting as it goes.
 *
 * The wait is bounded and the bound is generous: an SDXL image on a modest card is twenty
 * to sixty seconds, and a queue in front of it can make that minutes. What is not bounded
 * is what happens after a stop — `signal` reaches the fetch, and the loop ends with it.
 */
export async function wait(server, id, { signal, onProgress, timeoutMs = 15 * 60_000, expect = 'image' } = {}) {
  const until = Date.now() + timeoutMs
  for (let tick = 0; Date.now() < until; tick++) {
    if (signal?.aborted) throw new Error('Stopped.')
    const history = await json(await fetch(`${server}/history/${id}`, { signal }))
    const done = history?.[id]
    if (done) {
      const made = outputs(done)
      if (made.files.length === 0 && made.text.length === 0) throw new Error(`ComfyUI finished and produced no ${expect}.`)
      return made
    }
    // The queue position, which is the only honest thing to say while waiting: "still
    // queued behind two" is information, and a spinner is not.
    const { queue_running: running = [], queue_pending: pending = [] } = await json(
      await fetch(`${server}/queue`, { signal }),
    ).catch(() => ({}))
    const ahead = pending.findIndex((item) => item[1] === id)
    onProgress?.(
      ahead > 0 ? `${ahead} job${ahead === 1 ? '' : 's'} ahead in the queue`
      : running.some((item) => item[1] === id) ? 'Generating'
      : 'Waiting for ComfyUI',
      tick,
    )
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('ComfyUI did not finish in time.')
}

/** Fetch one finished output's bytes. Any kind — `/view` serves whatever the node wrote. */
export async function download(server, { filename, subfolder = '', type = 'output' }, signal) {
  const url = new URL(`${server}/view`)
  url.searchParams.set('filename', filename)
  url.searchParams.set('subfolder', subfolder)
  url.searchParams.set('type', type)
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`could not read the image back: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** The output keys ComfyUI writes a list of files under. */
export const KINDS = ['images', 'gifs', 'audio', 'video', 'files']

/**
 * What a finished run produced, whatever kind of thing that is.
 *
 * `generate` only ever had to find images. A workflow does not: one of the three saved on this
 * machine renders audio, and the folder named for image-to-video is empty only because that
 * workflow has not been built yet. So outputs are read by the shape ComfyUI writes them in — a
 * list of `{filename, subfolder, type}` under some key — rather than by the one key that used
 * to matter.
 */
export function outputs(done) {
  const nodes = Object.values(done?.outputs ?? {})
  return {
    files: nodes
      .flatMap((node) => KINDS.flatMap((kind) => (Array.isArray(node?.[kind]) ? node[kind] : [])))
      .filter((one) => typeof one?.filename === 'string'),
    // `ShowText` and its like put strings here. On these workflows that is the prompt the graph
    // actually built out of the plain English, which is the one thing a person cannot otherwise
    // see — the picture is the only other evidence it ran at all.
    text: nodes
      .flatMap((node) => (Array.isArray(node?.text) ? node.text : []))
      .map(String)
      .filter((one) => one.trim() !== ''),
  }
}

/**
 * Every node class this install has, and what each one takes.
 *
 * The whole of it, which is a megabyte or two on an install carrying twenty-six custom node
 * packs — so it is fetched when a workflow is about to be read and not on every call. It answers
 * two questions nothing else can: **is this class installed** (a graph naming one that is not is
 * a 400 whose body nobody reads), and **is that title the author's or the class's own**, because
 * an untitled node exports its display name and there is no other way to tell.
 */
export async function classes(server, signal) {
  return await json(await fetch(`${server}/object_info`, { signal }))
}

/**
 * Stop what ComfyUI is rendering.
 *
 * `signal` reaches the fetch and ends the poll, which is where this stopped before: the job kept
 * rendering, on a graphics card nobody was waiting for. Answers 200 with nothing in it, and
 * interrupting an empty queue is not an error.
 */
export async function interrupt(server, signal) {
  const response = await fetch(`${server}/interrupt`, { method: 'POST', signal })
  return response.ok
}
