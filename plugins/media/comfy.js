// SPDX-License-Identifier: AGPL-3.0-only
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'

/**
 * ComfyUI, over its own HTTP API.
 *
 * ComfyUI's API takes a *graph*, not a prompt — every node of the pipeline, wired by id.
 * That is what makes it worth driving rather than replacing: the graph below is the plain
 * SDXL text-to-image pipeline, and anything a person can build in ComfyUI's editor can be
 * substituted for it later without this plugin learning anything new.
 *
 * **The websocket, adopted — and this comment used to argue the other way.** It said polling
 * `/history` was a dependency and a reconnect story less, at the cost of progress in whole images
 * rather than steps, and that *the websocket is the upgrade and it is the only thing that would
 * change here*. That was right for what it was deciding and it is what changed: per-step progress
 * is websocket-only, and a person watching a thirty-second render wants to know it is at step 12.
 *
 * **`/history` is still what decides the job is finished.** The socket only makes the waiting
 * legible — it is opened per job, it is allowed to fail, and everything degrades to exactly the
 * old behaviour when it does. That is the reconnect story the original comment was avoiding: there
 * isn't one, because nothing depends on the socket staying up.
 */

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

/**
 * Who Alexia is, to ComfyUI — one id for this process, and the same one twice on purpose.
 *
 * **This is the whole of the trap.** Every progress message ComfyUI sends goes to
 * `server_instance.client_id` and nobody else (`main.py:437`, and the socket table is keyed by
 * the `clientId` query parameter at `server.py:273`). So the socket and the queued prompt must
 * carry *the same* id — and when they do not, the socket connects, stays silent, and the whole
 * feature reads as ComfyUI being slow. There is no error to see.
 *
 * So it is one constant used by both, rather than a string passed to each. A caller cannot get
 * this wrong because a caller is not asked. It is per process rather than a literal, so two
 * Alexias pointed at one ComfyUI do not read each other’s progress.
 */
export const CLIENT_ID = `alexia-${randomUUID()}`

/**
 * The step counter, over the socket that is the only thing carrying it.
 *
 * Opened per job and allowed to fail: a socket that never connects, drops, or answers rubbish
 * leaves `wait` polling exactly as it did before, which is why this needs no reconnect story.
 * Binary frames are preview images and are ignored here — those are their own decision, and a
 * widget that could show one does not exist yet.
 */
export function listen(server, id, onStep) {
  let socket
  try {
    const url = new URL(server)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = '/ws'
    url.searchParams.set('clientId', CLIENT_ID)
    socket = new WebSocket(url)
  } catch {
    return () => {}
  }
  // Nothing here throws into the caller. A progress bar is not worth failing a render for.
  socket.addEventListener('error', () => {})
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return
    let said
    try {
      said = JSON.parse(event.data)
    } catch {
      return
    }
    const data = said?.data ?? {}
    // ComfyUI talks to one client about everything it is doing, including jobs somebody queued
    // from a browser tab. Only this job’s messages mean anything here.
    if (data.prompt_id !== undefined && data.prompt_id !== id) return
    if (said.type === 'progress') onStep({ value: Number(data.value), max: Number(data.max), node: String(data.node ?? '') })
    else if (said.type === 'executing' && data.node) onStep({ node: String(data.node) })
  })
  return () => {
    try {
      socket.close()
    } catch {
      /* already gone */
    }
  }
}

/** Queue a graph. What comes back is the id to ask about. */
export async function queue(server, prompt, signal) {
  const answered = await json(
    await fetch(`${server}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: CLIENT_ID }),
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
export async function wait(server, id, { signal, onProgress, timeoutMs = 15 * 60_000, expect = 'image', label } = {}) {
  const until = Date.now() + timeoutMs
  let step
  const hush = listen(server, id, (at) => {
    step = { ...step, ...at }
  })
  try {
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
    // Queue position first, because *two jobs ahead* explains a wait that steps cannot — nothing
    // is stepping yet. Once it is running the socket has better words than this loop ever had.
    const stepping = Number.isFinite(step?.max) && step.max > 0
    onProgress?.(
      ahead > 0 ? `${ahead} job${ahead === 1 ? '' : 's'} ahead in the queue`
      : stepping ? `${label?.(step.node) ?? 'Generating'} — step ${step.value} of ${step.max}`
      : running.some((item) => item[1] === id) ? 'Generating'
      : 'Waiting for ComfyUI',
      stepping ? step.value : tick,
      stepping ? step.max : 0,
    )
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('ComfyUI did not finish in time.')
  } finally {
    hush()
  }
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
 * The workflows ComfyUI ships, as a catalogue it serves itself.
 *
 * No scraping and no mirror: this is on the machine already, it arrives with ComfyUI, and it
 * moves when ComfyUI moves. `GET /templates/{name}.json` fetches one.
 */
export async function templates(server, signal) {
  const response = await fetch(`${server}/templates/index.json`, { signal })
  if (!response.ok) return []
  return await response.json()
}

/**
 * What the machine has — the card, its memory, and how much of it is free right now.
 *
 * Two questions turn on this: whether a heavy job has room (a decode that runs out does not
 * always throw — it can return a black image), and, later, which size of model an install
 * should fetch. `vram_free` moves; `vram_total` does not.
 */
export async function stats(server, signal) {
  return await json(await fetch(`${server}/system_stats`, { signal }))
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
