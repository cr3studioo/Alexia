// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { Buffer } from 'node:buffer'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkpoints, graph, image, pick, queue, wait } from './comfy.js'
import { alive, awake, install, loopback, port, ready, start, stop, tail } from './launch.js'

/**
 * Local image generation (M4-6).
 *
 * **Without this, Combined mode is Cloud mode with extra words.** The whole claim is *the
 * cloud thinks, your machine makes the media* — and until something on this machine
 * actually makes media, the second half of that sentence is a plan rather than a fact.
 *
 * It drives ComfyUI rather than embedding a diffusion runtime, which is the same trade
 * voice makes with Whisper: the hard part is somebody else's, kept up to date by somebody
 * else, and what is here is a graph and an honest sentence about whether it is reachable.
 *
 * **It also starts ComfyUI.** That was not true for the first version of this plugin, and
 * the sentence it said instead — *start it and try again, it is a separate program, and
 * Alexia does not start it for you* — was correct, useless, and the commonest thing this
 * plugin ever said. Starting it is `launch.js`; everything about *whether it may* is here,
 * because that is a question about this plugin's promises rather than about processes.
 */

const alexia = plugin()

let own
/** What ComfyUI said it has, refreshed when it is reachable. Empty means not reached yet. */
let available = []
/** Where ComfyUI is installed, once somebody has looked. `null` means looked and not found. */
let where_it_is
/** One start at a time. Two pictures asked for at once must not become two ComfyUIs. */
let booting

const settings = () => alexia.settings()

const where = async () => String((await settings()).server ?? '').replace(/\/+$/, '') || 'http://127.0.0.1:8188'

const logFile = () => join(own ?? '.', 'comfyui.log')

/**
 * Is ComfyUI there?
 *
 * Asked rather than assumed, and the answer is a sentence a person can act on. *Not
 * running* is still the commonest state of this plugin and it is still not an error — it is
 * now a thing that can be fixed without asking anybody, which is a different sentence.
 */
async function look(signal) {
  try {
    available = await checkpoints(await where(), signal)
    return available.length > 0 ?
        { ok: true, said: `● Ready — ${available.length} model${available.length === 1 ? '' : 's'}` }
      : { ok: false, said: '▲ ComfyUI is running but has no checkpoint installed' }
  } catch {
    available = []
    return { ok: false, said: `■ ComfyUI is not answering at ${await where()}` }
  }
}

/**
 * Where ComfyUI lives on this machine.
 *
 * The search is done once and remembered, because it is a walk of a few folders and the
 * answer does not change between two pictures. The setting always wins and is never cached
 * over — somebody who types a path has said something more definite than a search result.
 */
async function found() {
  const { path } = await settings()
  const said = String(path ?? '').trim()
  if (said) return (await install(said)) ?? null
  if (where_it_is !== undefined) return where_it_is
  where_it_is = (await install()) ?? null
  return where_it_is
}

/**
 * Can this plugin keep its promise — now, or after starting something?
 *
 * The capability goes on when *making a picture would work*, which since starting is
 * allowed includes ComfyUI being installed and switched off. A promise this plugin cannot
 * keep is worse for a caller than an honest -32050; so is refusing one it can keep after a
 * minute of loading.
 */
async function bind(signal) {
  const state = await look(signal)
  const startable = state.ok ? undefined : await canStart()
  const said =
    state.ok ? state.said
    : startable?.ok ? '■ ComfyUI is not running — Alexia will start it when a picture is asked for'
    : `${state.said}. ${startable?.said ?? ''}`.trim()
  await alexia.status('state', said).catch(() => {})
  made.update({ _meta: state.ok || startable?.ok ? { 'alexia/provides': ['image.generate'] } : {} })
  return { ok: state.ok, said, startable: startable?.ok === true }
}

/** Everything that has to be true before Alexia may start ComfyUI itself. */
async function canStart() {
  const server = await where()
  const { autostart } = await settings()
  if (autostart === false) return { ok: false, said: 'Starting it automatically is switched off in this plugin’s settings.' }
  if (!loopback(server)) return { ok: false, said: `${server} is another machine, so there is nothing here to start.` }
  const dir = await found()
  return dir ?
      { ok: true, dir, said: `ComfyUI is installed at ${dir}.` }
    : { ok: false, said: 'ComfyUI could not be found on this machine — put its folder in this plugin’s settings.' }
}

/**
 * Start ComfyUI and wait for it, once.
 *
 * The wait is bounded at ninety seconds, which is **shorter than a slow start and that is
 * deliberate**: core gives a tool call two minutes, so a wait long enough to cover every
 * install would end as a dead call with nothing said. An install carrying thirty custom
 * node packs took six minutes on the machine this was written on. So the timeout is not an
 * error — the process is detached and still loading, *ask me again in a minute* is true,
 * and the next call finds it up.
 */
async function wake(signal, ctx) {
  const can = await canStart()
  if (!can.ok) return { ok: false, said: can.said }
  booting ??= (async () => {
    const server = await where()
    const at = port(server)
    // A ComfyUI already loading is not a reason to start a second one. This plugin is
    // stopped after five idle minutes and a heavy install takes longer than that to come
    // up, so *started, timed out, asked again* is the ordinary sequence rather than a
    // corner — and two ComfyUIs on one graphics card is the worst end available here.
    const mine = await alexia.storage.get('started').catch(() => undefined)
    let pid = mine?.port === at && Number.isInteger(mine?.pid) && alive(mine.pid) ? mine.pid : undefined
    if (pid === undefined) {
      const fresh = await start(can.dir, { at, log: logFile() })
      pid = fresh.pid
      log.info(`started ComfyUI (pid ${pid}) from ${can.dir} with ${fresh.exe}`)
      // Written down before the wait, so a plugin stopped mid-start still knows what it
      // left running. This is the only record that a ComfyUI is Alexia's to stop.
      await alexia.storage.set('started', { pid, dir: can.dir, port: at, at: Date.now() }).catch(() => {})
    }
    await alexia.status('state', '▲ Starting ComfyUI…').catch(() => {})
    const up = await ready(server, {
      signal,
      onProgress: (tick) =>
        ctx && alexia.progress(ctx, tick, 90, tick < 20 ? 'Starting ComfyUI' : 'Starting ComfyUI — loading its nodes and models'),
    })
    if (!up) {
      const said =
        alive(pid) ?
          'ComfyUI is still starting — it keeps loading in the background. Ask again in a minute; an install with a lot of custom nodes can take several.'
        : `ComfyUI stopped while starting: ${(await tail(logFile())) || 'nothing in its log to say why.'}`
      return { ok: false, said }
    }
    return { ok: true, said: `ComfyUI is up on port ${at}.` }
  })().finally(() => {
    booting = undefined
  })
  const done = await booting
  return done.ok ? await bind(signal) : done
}

/**
 * Which checkpoint to use: the one asked for, the one chosen, or whatever is there.
 *
 * The order matters and the first entry is new. *Whatever is there* means the first
 * checkpoint in the folder, and on a machine with six of them that is a coin toss — a
 * request for an anime picture answered by a photographic model is the plugin working
 * perfectly and getting it wrong. A name in the call is how the asker says which.
 */
async function chosen(wanted) {
  const { checkpoint, steps, vae_fp32: fp32 } = await settings()
  const picked = pick(available, wanted) ?? (available.includes(checkpoint) ? checkpoint : available[0])
  return { checkpoint: picked, steps: Number(steps) || 25, fp32: fp32 !== false }
}

const made = alexia.tool(
  'generate',
  {
    description:
      'Make an image on this machine from a description, and save it. Returns the file path. ' +
      'Use when the user asks for a picture, an illustration, a logo or a mock-up. Starts ' +
      'ComfyUI first if it is not already running. Takes twenty seconds to a few minutes ' +
      'depending on the machine, and reports progress.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What the picture shows. Concrete and visual — subject, setting, style, lighting.',
        },
        negative: { type: 'string', description: 'What to keep out of it. Optional.' },
        width: { type: 'number', description: 'Pixels wide. Defaults to 1024; SDXL wants multiples of 64.' },
        height: { type: 'number', description: 'Pixels tall. Defaults to 1024.' },
        seed: { type: 'number', description: 'Same seed and same prompt gives the same picture. Omit for a new one.' },
        model: {
          type: 'string',
          description:
            'Which installed checkpoint to paint with — any part of its filename is enough. ' +
            'Worth naming when the style matters, since the models installed are rarely ' +
            'interchangeable: `models` lists them. Omit to use whichever ComfyUI has.',
        },
      },
      required: ['prompt'],
    }),
    // It writes a file into this plugin's own folder and nothing else. Not read-only —
    // something new exists afterwards — and not destructive: nothing is overwritten.
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ prompt, negative, width, height, seed, model }, ctx) => {
    const signal = ctx?.mcpReq?.signal
    let state = await bind(signal)
    // Not running is a thing to fix rather than a thing to report. If it cannot be fixed —
    // no install, another machine, switched off — `wake` says which, in one sentence.
    if (!state.ok) state = await wake(signal, ctx)
    if (!state.ok) return { isError: true, content: [{ type: 'text', text: state.said }] }
    if (!own) return { isError: true, content: [{ type: 'text', text: 'Alexia has not given this plugin a folder to work in.' }] }

    const server = await where()
    if (model && !pick(available, model)) {
      // Named and not found is a question, not a picture. Answering it with a different
      // model would be the plugin deciding something the asker was explicit about.
      return {
        isError: true,
        content: [{ type: 'text', text: `There is no model here called ${model}. What there is: ${available.join(', ')}` }],
      }
    }
    const { checkpoint, steps, fp32 } = await chosen(model)
    const built = graph({
      prompt: String(prompt),
      negative: String(negative ?? 'blurry, low quality, watermark, text'),
      checkpoint,
      steps,
      // Rounded to 64 because SDXL's latent space is in units of 8 and its training is in
      // units of 64. A model handed 1000x1000 makes something subtly wrong rather than
      // refusing, which is the worst of both.
      width: round64(width ?? 1024),
      height: round64(height ?? 1024),
      seed: Number.isFinite(Number(seed)) ? Number(seed) : Math.floor(Math.random() * 2 ** 31),
      fp32,
    })

    const id = await queue(server, built, 'alexia', signal)
    const found = await wait(server, id, {
      signal,
      onProgress: (message, tick) => alexia.progress(ctx, tick, 0, message),
    })

    const saved = []
    for (const one of found) {
      const bytes = await image(server, one, signal)
      const to = join(own, `${Date.now()}-${one.filename}`)
      writeFileSync(to, Buffer.from(bytes))
      saved.push(to)
      await alexia.storage
        .insert('images', { path: to, prompt: String(prompt), checkpoint, at: Date.now() })
        .catch(() => {})
    }
    await bind(signal)
    return {
      content: [
        { type: 'text', text: `${saved.join('\n')}\nMade here, with ${checkpoint}.` },
        // The picture itself, not only its path. Until this line the answer to *make me an
        // image* was a sentence containing a filename — correct, and nothing a person could
        // press. Now it is a row under the answer with the picture on it.
        ...saved.map((to) => alexia.file(to, { description: String(prompt) })),
      ],
    }
  },
)

const round64 = (n) => Math.max(256, Math.min(2048, Math.round(Number(n) / 64) * 64))

alexia.tool(
  'models',
  {
    description:
      'List the image models ComfyUI has installed on this machine. Takes no arguments. ' +
      'Any of these names can be passed to generate, which is worth doing when the style matters.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async (ctx) => {
    const state = await bind(ctx?.mcpReq?.signal)
    return {
      content: [{ type: 'text', text: available.length > 0 ? available.join('\n') : state.said }],
    }
  },
)

alexia.tool(
  'start_comfyui',
  {
    description:
      'Start ComfyUI on this machine and wait until it answers. Takes no arguments. ' +
      'Generating a picture does this on its own, so it is only worth calling to warm it up ' +
      'first, or to find out why it will not start.',
    // Something is running afterwards that was not running before, and it is a program on
    // the user's machine — so the permission model gets to ask, and should.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (ctx) => {
    const signal = ctx?.mcpReq?.signal
    if (await awake(await where(), signal)) {
      const state = await bind(signal)
      return { content: [{ type: 'text', text: `ComfyUI is already running. ${state.said}` }] }
    }
    const state = await wake(signal, ctx)
    return { isError: !state.ok, content: [{ type: 'text', text: state.said }] }
  },
)

alexia.tool(
  'stop_comfyui',
  {
    description:
      'Stop the ComfyUI that Alexia started, freeing the graphics card. Takes no arguments. ' +
      'A ComfyUI the user started themselves is left alone.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (ctx) => {
    const signal = ctx?.mcpReq?.signal
    const server = await where()
    const mine = await alexia.storage.get('started').catch(() => undefined)
    const running = await awake(server, signal)
    if (!running) {
      if (mine) await alexia.storage.remove('started').catch(() => {})
      await bind(signal)
      return { content: [{ type: 'text', text: 'ComfyUI is not running.' }] }
    }
    // Two conditions, and both are needed: a pid alone could have been reused by the OS,
    // and a running server alone could be somebody else's.
    if (!mine?.pid || !alive(mine.pid)) {
      return {
        content: [
          { type: 'text', text: 'ComfyUI is running, but Alexia did not start it — so it is not Alexia’s to stop. Close it the way you opened it.' },
        ],
      }
    }
    const ended = await stop(mine.pid)
    await alexia.storage.remove('started').catch(() => {})
    await bind(signal)
    return {
      isError: !ended,
      content: [{ type: 'text', text: ended ? 'ComfyUI stopped, and the graphics card is free.' : `Could not stop ComfyUI (pid ${mine.pid}).` }],
    }
  },
)

await alexia.start()
own = (await alexia.host()).paths.ownDir
await bind()
alexia.onSettingsChanged((changed) => {
  // `path` moves where it would be started from, so a cached search result is stale.
  if ('path' in changed) where_it_is = undefined
  if ('server' in changed || 'checkpoint' in changed || 'path' in changed || 'autostart' in changed) void bind()
})
log.info(`${alexia.manifest.name} is ready`)
