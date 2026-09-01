// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { Buffer } from 'node:buffer'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { checkpoints, classes, download, interrupt, named, pick, queue, stats, templates, wait } from './comfy.js'
import { alive, awake, install, loopback, port, ready, start, stop, tail } from './launch.js'
import { API_SUFFIX, FOLDER, apply, isApi, knobs, missing, read, reseed, saved, write } from './workflows.js'
import { api as starterGraph, editor as starterDoc, STARTER } from './starter.js'
import { measure, tight } from './sizing.js'
import { fetchModel, have } from './models.js'
import { reading, vram } from './tier.js'
import { describe as line, flatten, runnable, search, shelf } from './catalog.js'
import { convert } from './convert.js'

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
    if (available.length === 0) return { ok: false, said: '▲ ComfyUI is running but has no checkpoint installed' }
    const many = `${available.length} model${available.length === 1 ? '' : 's'}`
    // A model named in the settings that is not installed is the one thing this screen can
    // catch and nothing else will: pictures still come out, painted by a different model,
    // and they look like the plugin working. Naming it here costs a line and a colour.
    const asked = await preferred()
    return asked && !pick(available, asked) ?
        { ok: true, said: `▲ Ready — ${many}, and none of them is “${asked}”. Pictures use ${available[0]}.` }
      : { ok: true, said: `● Ready — ${many}` }
  } catch {
    available = []
    return { ok: false, said: `■ ComfyUI is not answering at ${await where()}` }
  }
}

/** The model the settings screen asks for, if it asks for one. `named` says what counts. */
const preferred = async () => named((await settings()).checkpoint)

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
      const fresh = await start(can.dir, { at, log: logFile(), own })
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
  const { steps, vae_fp32: fp32 } = await settings()
  const picked = pick(available, wanted) ?? pick(available, await preferred()) ?? available[0]
  return { checkpoint: picked, steps: Number(steps) || 25, fp32: fp32 !== false }
}

const made = alexia.tool(
  'generate',
  {
    description:
      'Make an image on this machine from a description. The picture is handed straight to ' +
      'the user, so say what you made — do not describe where it was saved. Use when the ' +
      'user asks for a picture, an illustration, a logo or a mock-up. Starts ComfyUI first ' +
      'if it is not already running. Takes twenty seconds to a few minutes depending on the ' +
      'machine, and reports progress.',
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
        again: {
          type: 'boolean',
          description:
            'Reuse the last picture’s settings — including its seed — for anything not given here. ' +
            'Use when the user says *again*, *same but bigger*, *that one but at night*. Without this a ' +
            'new seed is rolled and the picture is a different one, because the seed was never in the ' +
            'conversation for you to repeat.',
        },
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
  async ({ prompt, negative, width, height, seed, model, again }, ctx) => {
    const signal = ctx?.mcpReq?.signal
    // Not running is a thing to fix rather than a thing to report. If it cannot be fixed —
    // no install, another machine, switched off — `reachable` says which, in one sentence. It
    // also plants the starter workflow the first time it succeeds, which is here rather than at
    // boot because this is the first moment ComfyUI is known to be up.
    const state = await reachable(ctx)
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
    const size = measure({ width, height, seed, again }, await alexia.storage.get('last').catch(() => undefined))
    const room = await free(server, signal)
    const warning = room === undefined ? undefined : tight(size, room)
    // **The same workflow the person can open**, rather than a second pipeline built in code.
    // `starter.js` renders it, `install` writes it into ComfyUI's own folder, and the two are
    // generated from one definition so the graph that runs and the graph they edit cannot drift.
    const built = starterGraph({
      prompt: String(prompt),
      negative: String(negative ?? 'blurry, low quality, watermark, text'),
      checkpoint,
      steps,
      // Rounded to 64 because SDXL's latent space is in units of 8 and its training is in
      // units of 64. A model handed 1000x1000 makes something subtly wrong rather than
      // refusing, which is the worst of both.
      width: size.width,
      height: size.height,
      seed: size.seed,
      fp32,
      display: named_of(await nodes(signal).catch(() => ({}))),
    })

    const id = await queue(server, built, signal)
    const found = await awaiting(server, id, {
      signal,
      label: naming(built),
      onProgress: (message, done, total, shown) => alexia.progress(ctx, done, total, message, shown),
    })

    const saved = []
    for (const one of found.files) {
      const bytes = await download(server, one, signal)
      const to = join(own, `${Date.now()}-${one.filename}`)
      writeFileSync(to, Buffer.from(bytes))
      saved.push(to)
      await alexia.storage
        .insert('images', { path: to, prompt: String(prompt), checkpoint, at: Date.now() })
        .catch(() => {})
    }
    // **What it took, so the next sentence can be about it.** *Same but bigger* means the same
    // seed — and a seed nobody wrote down is a different picture, which is the whole failure the
    // model remembering the conversation cannot fix: it never saw the number.
    await alexia.storage
      .set('last', { prompt: String(prompt), negative: String(negative ?? ''), model: checkpoint, ...size, at: Date.now() })
      .catch(() => {})
    await bind(signal)
    return {
      content: [
        {
          type: 'text',
          text:
            `Made here, with ${checkpoint}.` +
            (size.reused ? ` Same seed as the last one (${size.seed}), so it is that picture again.` : '') +
            (warning ? ` ▲ ${warning}` : ''),
        },
        // The picture itself, not its path. The answer to *make me an image* used to open
        // with the filename — correct, nothing a person could press, and read straight back
        // to them by a model that could not see the difference. It is a row under the answer
        // now, on the window or as a photo over a channel, and the model is told only that.
        ...saved.map((to) => alexia.file(to, { description: String(prompt) })),
      ],
    }
  },
)

/**
 * How much of the graphics card is free this second, or nothing if the question cannot be asked.
 *
 * `/system_stats` gives it away for free. A machine with no card, a ComfyUI that will not answer,
 * or a shape this does not recognise all come back the same way: undefined, and nothing is said.
 */
async function free(server, signal) {
  try {
    const machine = await stats(server, signal)
    const card = (machine?.devices ?? []).find((one) => one?.type === 'cuda' || one?.type === 'mps')
    return Number.isFinite(Number(card?.vram_free)) ? Number(card.vram_free) : undefined
  } catch {
    return undefined
  }
}

/** Class name → display name, which is what an export writes into `_meta.title` for an untitled node. */
const named_of = (spec) => Object.fromEntries(Object.entries(spec).map(([one, what]) => [one, what?.display_name ?? one]))


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

/**
 * Every node class this install has, cached for a few minutes.
 *
 * It is a megabyte or two on a machine carrying twenty-six custom node packs, and every question
 * about a workflow needs it: *is this class installed*, and *is that title the author's own or
 * the class's*. The plugin is stopped after five idle minutes so the cache cannot outlive the
 * process by much; the ceiling is here for the case where somebody installs a node pack and
 * restarts ComfyUI while Alexia stays up.
 */
let known
async function nodes(signal) {
  if (known && Date.now() - known.at < 5 * 60_000) return known.classes
  known = { classes: await classes(await where(), signal), at: Date.now() }
  return known.classes
}

/** The one sentence that fixes every state a workflow can be in short of running. */
const EXPORT_IT =
  'In ComfyUI: Workflow → Export (API). Then give Alexia the file it saves — add_workflow takes its path.'

const ago = (at) => {
  const days = Math.floor((Date.now() - Number(at)) / 86_400_000)
  return (
    days < 1 ? 'today'
    : days === 1 ? 'yesterday'
    : days < 60 ? `${days} days ago`
    : `${Math.round(days / 30)} months ago`
  )
}

/** Where a workflow stands, in the words of the thing that has to change for it to run. */
function standing(row) {
  if (!row.export) return `not exported. ${EXPORT_IT}`
  if (!row.workflow) return 'exported, though the workflow it came from is no longer saved here.'
  if (row.stale) return `edited ${ago(row.editedAt)}, exported ${ago(row.exportedAt)} — so the export is behind. ${EXPORT_IT}`
  return 'ready to run.'
}

/**
 * One knob, as a line somebody can act on.
 *
 * A combo's options are filenames on this machine and there can be a hundred of them, so the
 * list is cut and the count says what was cut. Nothing is guessed from it either way: a value
 * that is not on the list is refused by name rather than quietly replaced.
 */
function describe(knob) {
  const kind =
    knob.options ?
      `one of ${knob.options.slice(0, 12).join(', ')}${knob.options.length > 12 ? `, and ${knob.options.length - 12} more` : ''}`
    : knob.type
  return `  ${knob.field} (${kind}) — ${knob.title}`
}

/**
 * Wait for a job, and stop it if the waiting stops.
 *
 * `signal` used to reach only the fetch: the poll ended and **the job carried on rendering**, on
 * a graphics card nobody was waiting for and with the next request queued behind it. `/interrupt`
 * is a call this plugin never made. It is made without the signal, because the signal is the
 * thing that just aborted.
 */
async function awaiting(server, id, options) {
  try {
    return await wait(server, id, options)
  } catch (error) {
    if (options?.signal?.aborted) await interrupt(server).catch(() => {})
    throw error
  }
}

/**
 * Put the starter workflow where the person can find it, once.
 *
 * **Once, and remembered — because deleting it is a thing somebody is allowed to do.** A plugin
 * that rewrites a file every boot is a plugin arguing with its user, so the record of having
 * planted it lives in storage and is checked before planting rather than the file being checked.
 * The two renderings go down together: the editable one so it appears in ComfyUI’s own sidebar
 * and can be opened, changed and learned from, and the runnable one because that is what
 * `/prompt` eats.
 *
 * It is deliberately not fatal. A picture does not fail because a demonstration workflow could
 * not be written.
 */
async function plant(signal) {
  if (await alexia.storage.get('planted').catch(() => undefined)) return
  try {
    const { vae_fp32: fp32 } = await settings()
    const server = await where()
    const spec = await nodes(signal).catch(() => ({}))
    const graph = starterGraph({
      checkpoint: available[0],
      prompt: 'a paper boat on still water, soft morning light',
      negative: 'blurry, low quality, watermark, text',
      fp32: fp32 !== false,
      display: named_of(spec),
    })
    await write(server, `${FOLDER}/${STARTER}.json`, JSON.stringify(starterDoc({ ckpt_name: available[0] }, { fp32: fp32 !== false })))
    await write(server, `${FOLDER}/${STARTER}${API_SUFFIX}`, JSON.stringify(graph))
    await alexia.storage.set('planted', { at: Date.now(), name: STARTER })
    log.info(`wrote the starter workflow to ComfyUI as ${STARTER}`)
  } catch (error) {
    // Worth a line in the log and nothing more. Nothing downstream needs it to have worked.
    log.info(`could not write the starter workflow: ${String(error?.message ?? error)}`)
  }
}

/** Which saved workflow somebody meant. The names are long and nobody types one whole. */
async function which(server, wanted, signal) {
  const rows = await saved(server, signal)
  const found = pick(
    rows.map((one) => one.name),
    wanted,
  )
  return { rows, row: rows.find((one) => one.name === found) }
}

/** ComfyUI up, by whatever means are allowed. The two workflow tools open the same way. */
async function reachable(ctx) {
  const signal = ctx?.mcpReq?.signal
  const state = await bind(signal)
  const up = state.ok ? state : await wake(signal, ctx)
  if (up.ok) await plant(signal)
  return up
}

/**
 * What to call the node that is working, in the words its author used.
 *
 * The socket says `node: "12"`, which is true and says nothing. The graph being run is right
 * here, so the title wins over the class name and the class name over the id — *Load Model —
 * step 12 of 28* is a sentence about somebody’s own pipeline rather than about a graph.
 */
const naming = (built) => (node) => {
  const one = built?.[node]
  return String(one?._meta?.title ?? one?.class_type ?? '').trim() || undefined
}

const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

alexia.tool(
  'workflows',
  {
    description:
      'List the ComfyUI workflows saved on this machine, and for each one the fields ' +
      'run_workflow takes. Takes no arguments. Call this before run_workflow — a workflow’s ' +
      'fields are named by whoever built it and are different for every workflow. It also says ' +
      'which workflows cannot run yet and what would fix that.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async (ctx) => {
    const signal = ctx?.mcpReq?.signal
    const state = await reachable(ctx)
    if (!state.ok) return refuse(state.said)
    const server = await where()
    const rows = await saved(server, signal)
    if (rows.length === 0) {
      return { content: [{ type: 'text', text: 'ComfyUI has no workflows saved on this machine.' }] }
    }
    const spec = await nodes(signal).catch(() => ({}))
    const said = []
    for (const row of rows) {
      said.push(`${row.name} — ${standing(row)}`)
      if (!row.export) continue
      try {
        const graph = await read(server, row.export, signal)
        if (!isApi(graph)) {
          said.push('  That file is the editor’s own save rather than an API export, so it cannot be queued.')
          continue
        }
        const absent = missing(graph, spec)
        if (absent.length > 0) {
          said.push(`  It needs ${absent.join(', ')}, which ${absent.length === 1 ? 'is' : 'are'} not installed here.`)
        }
        const found = knobs(graph, spec)
        said.push(
          ...(found.length > 0 ? found.map(describe) : (
            ['  No fields — nothing in it is titled, so it runs exactly as exported.']
          )),
        )
      } catch (error) {
        said.push(`  Could not read the export: ${String(error?.message ?? error)}`)
      }
    }
    return { content: [{ type: 'text', text: said.join('\n') }] }
  },
)

alexia.tool(
  'run_workflow',
  {
    description:
      'Run one of the ComfyUI workflows saved on this machine — the whole pipeline its author ' +
      'built, with its LoRAs, ControlNet, reference images and its own settings, rather than the ' +
      'plain one generate uses. Call workflows first: it names each workflow and the fields this ' +
      'takes for it, which are different every time because the person who built it chose them. ' +
      'Whatever it makes — a picture, a sound, a video — is handed straight to the user, so say ' +
      'what you made rather than where it was saved. Can take minutes.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Which workflow. Any part of its name is enough.' },
        values: {
          type: 'object',
          description:
            'The workflow’s own fields, by the names workflows gives for it. Anything left out ' +
            'keeps the value it was exported with. Write these the way the field’s description ' +
            'asks — a field called plain English wants a sentence, not a tag list.',
          additionalProperties: true,
        },
        seed: {
          type: 'number',
          description:
            'Same seed and same fields gives the same result. Omit for a new one — an export ' +
            'carries whatever seed the editor last showed, so omitting this is what the editor’s ' +
            'own randomise does.',
        },
        stale: {
          type: 'boolean',
          description:
            'Run it even though the workflow was edited after it was exported. The export is ' +
            'what runs, so this means knowingly running the older version. Only when the user says so.',
        },
      },
      required: ['workflow'],
    }),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ workflow, values, seed, stale }, ctx) => {
    const signal = ctx?.mcpReq?.signal
    const state = await reachable(ctx)
    if (!state.ok) return refuse(state.said)
    if (!own) return refuse('Alexia has not given this plugin a folder to work in.')
    const server = await where()

    const { rows, row } = await which(server, workflow, signal)
    if (!row) {
      return refuse(
        rows.length === 0 ?
          'ComfyUI has no workflows saved on this machine.'
        : `There is no workflow here called ${String(workflow)}. What there is: ${rows.map((one) => one.name).join(', ')}`,
      )
    }
    if (!row.export) return refuse(`${row.name} has not been exported for the API, so there is nothing to queue. ${EXPORT_IT}`)
    // The one failure nothing downstream catches: a stale export runs, and what comes back is a
    // picture rather than an error. Refusing costs a menu click; not refusing costs the trust in
    // every picture after it, because none of them can be told apart from a right one.
    if (row.stale && stale !== true) {
      return refuse(
        `${row.name} was edited ${ago(row.editedAt)} and last exported ${ago(row.exportedAt)}, so the export is behind ` +
          `the workflow. Running it would quietly use the older version. ${EXPORT_IT} Or pass stale: true to run the ` +
          'older one on purpose.',
      )
    }

    const graph = await read(server, row.export, signal)
    if (!isApi(graph)) return refuse(`${row.export} is the editor’s own save rather than an API export. ${EXPORT_IT}`)
    const spec = await nodes(signal)
    const absent = missing(graph, spec)
    if (absent.length > 0) {
      return refuse(
        `${row.name} needs ${absent.join(', ')}, which ${absent.length === 1 ? 'is' : 'are'} not installed here. ` +
          `Install the node pack ${absent.length === 1 ? 'it comes' : 'they come'} from and it will run.`,
      )
    }

    const found = knobs(graph, spec)
    const given = { ...(values ?? {}) }
    const strange = Object.keys(given).filter((field) => !found.some((knob) => knob.field === field))
    if (strange.length > 0) {
      return refuse(
        `${row.name} has no field called ${strange.join(', ')}. It takes: ` +
          `${found.map((knob) => knob.field).join(', ') || 'nothing — it runs exactly as exported'}.`,
      )
    }
    for (const knob of found) {
      if (!knob.options || !Object.hasOwn(given, knob.field)) continue
      // A combo's options are filenames again, so the same loose match `generate` uses applies —
      // and the same refusal, because a near miss answered with a different LoRA is a picture
      // nobody can explain.
      const chose = pick(knob.options, String(given[knob.field]))
      if (!chose) {
        return refuse(`${knob.field} has nothing here called ${String(given[knob.field])}. It takes one of: ${knob.options.join(', ')}`)
      }
      given[knob.field] = chose
    }

    const rolled = Number.isFinite(Number(seed)) ? Number(seed) : Math.floor(Math.random() * 2 ** 31)
    const built = reseed(apply(graph, found, given), rolled)
    const id = await queue(server, built, signal)
    const made = await awaiting(server, id, {
      signal,
      expect: 'output',
      label: naming(built),
      onProgress: (message, done, total, shown) => alexia.progress(ctx, done, total, message, shown),
    })

    const kept = []
    for (const one of made.files) {
      const bytes = await download(server, one, signal)
      const to = join(own, `${Date.now()}-${one.filename}`)
      writeFileSync(to, Buffer.from(bytes))
      kept.push(to)
      await alexia.storage.insert('runs', { workflow: row.name, path: to, seed: rolled, at: Date.now() }).catch(() => {})
    }
    await bind(signal)
    return {
      content: [
        { type: 'text', text: `Ran ${row.name}${kept.length === 0 ? ', which produced no file' : ''}. Seed ${rolled}.` },
        // What the graph made of what it was given. On these workflows that is the prompt an
        // Ollama node wrote out of the plain English, and it is the only way to see why a
        // picture came out the way it did — the alternative is guessing at somebody else's graph.
        ...(made.text.length > 0 ? [{ type: 'text', text: `The workflow reported: ${made.text.join(' / ')}` }] : []),
        ...kept.map((to) => alexia.file(to, { description: row.name })),
      ],
    }
  },
)

alexia.tool(
  'add_workflow',
  {
    description:
      'Save a ComfyUI API export so run_workflow can use it. Takes the path of the file ComfyUI ' +
      'wrote when the user chose Workflow → Export (API) — usually in their Downloads folder. ' +
      'Use when the user has just exported a workflow, or when workflows says one is not ' +
      'exported or its export is behind. Refuses anything that is not an API export.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        file: { type: 'string', description: 'The path of the exported .json file.' },
        name: {
          type: 'string',
          description:
            'What to file it under. Defaults to the file’s own name, which is what ComfyUI names ' +
            'the export — matching the workflow, which is what pairs the two.',
        },
      },
      required: ['file'],
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ file, name }, ctx) => {
    const signal = ctx?.mcpReq?.signal
    const path = String(file ?? '').trim()
    if (path === '') return refuse('Which file? This needs the path of the export ComfyUI saved.')
    let doc
    try {
      doc = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      return refuse(
        error?.code === 'ENOENT' ? `There is no file at ${path}.`
          : `${basename(path)} could not be read as JSON: ${String(error?.message ?? error)}`,
      )
    }
    const state = await reachable(ctx)
    if (!state.ok) return refuse(state.said)
    const server = await where()

    // The wrong export is easy to make: *Export* and *Export (API)* sit next to each other in
    // the same menu and both save a `.json`. Told apart by shape, which is a fact about the
    // file, rather than by which menu entry somebody remembers pressing.
    let converted = false
    if (!isApi(doc)) {
      // **Try before refusing.** `convert.js` proves the mapping or says which node it could
      // not — measured across this install's own templates, it manages about one in seven, and
      // refuses the rest by name. That is a better answer than sending everybody back to a menu.
      const got = convert(doc, await nodes(signal).catch(() => ({})))
      if (!got.ok) {
        return refuse(
          `${basename(path)} is the editor’s own save rather than an API export, and Alexia could not turn ` +
            `it into one: ${got.why[0]}. In ComfyUI these are two entries in the same menu — open it there and ` +
            'use Workflow → Export (API), which always works because the editor does the conversion itself.',
        )
      }
      doc = got.graph
      converted = true
    }

    const called = String(name ?? '').trim() || basename(path).replace(/\.api\.json$|\.json$/i, '')
    const to = `${FOLDER}/${called}${API_SUFFIX}`
    await write(server, to, JSON.stringify(doc), signal)

    const { row } = await which(server, called, signal)
    const spec = await nodes(signal).catch(() => ({}))
    const absent = missing(doc, spec)
    const found = knobs(doc, spec)
    return {
      content: [
        {
          type: 'text',
          text: [
            `Saved as ${called}, next to the workflow it came from. run_workflow can use it now.`,
            converted ?
              'It was the editor’s own save and Alexia converted it — every input was read rather than assumed, ' +
                'and anything it could not prove would have stopped it instead.'
            : undefined,
            row?.workflow ? undefined : (
              `Nothing here is called ${called}.json, so it is not paired with a saved workflow — which means ` +
                'Alexia cannot tell when it goes out of date.'
            ),
            absent.length > 0 ?
              `It needs ${absent.join(', ')}, which ${absent.length === 1 ? 'is' : 'are'} not installed here, so it will not run yet.`
            : undefined,
            found.length > 0 ? `Its fields: ${found.map((knob) => knob.field).join(', ')}.` : (
              'Nothing in it is titled, so it takes no fields and runs exactly as exported.'
            ),
          ]
            .filter(Boolean)
            .join(' '),
        },
      ],
    }
  },
)

/**
 * Everything this machine has made, newest first.
 *
 * **The honest half of never deleting anything.** Keeping every picture is the right default —
 * the one you wanted is the one you would have lost — but a folder that only ever grows and is
 * never shown is a slow leak nobody notices until it is large. So the pictures are on a screen,
 * and so is what they weigh.
 */
alexia.tool(
  'pictures',
  {
    description:
      'List the pictures made on this machine, newest first. Takes no arguments. This is what ' +
      'the Pictures panel draws; it is rarely worth calling in a conversation, because the ' +
      'pictures themselves are already in it.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    const made = await alexia.storage.select('images', { order: [['at', 'desc']], limit: 300 }).catch(() => [])
    const rows = made.map((one) => ({
      id: String(one.rowid ?? one.path),
      src: String(one.path ?? ''),
      caption: String(one.prompt ?? ''),
      // What a screen reader is given. The prompt is what the picture was *asked* to be, which
      // is the nearest true thing anybody has — nothing here has looked at the result.
      alt: one.prompt ? `Asked for: ${String(one.prompt)}` : 'A picture made on this machine',
    }))
    await weigh().catch(() => {})
    return { structuredContent: { rows }, content: [{ type: 'text', text: `${rows.length} picture${rows.length === 1 ? '' : 's'}.` }] }
  },
)

alexia.tool(
  'about_picture',
  {
    description: 'What made one picture — its prompt, its model and when. Takes the picture’s id.',
    inputSchema: fromJsonSchema({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ id }) => {
    const made = await alexia.storage.select('images', { order: [['at', 'desc']], limit: 300 }).catch(() => [])
    const one = made.find((row) => String(row.rowid ?? row.path) === String(id))
    if (!one) return { content: [{ type: 'text', text: 'That picture is not in the record any more.' }] }
    const when = new Date(Number(one.at) || 0)
    return {
      content: [
        {
          type: 'text',
          text: [
            String(one.prompt ?? '(no prompt recorded)'),
            '',
            `Model: ${String(one.checkpoint ?? 'not recorded')}`,
            `Made: ${Number.isFinite(when.getTime()) ? when.toLocaleString() : 'not recorded'}`,
            `File: ${String(one.path ?? '')}`,
          ].join('\n'),
        },
      ],
    }
  },
)

/**
 * What the pictures weigh, on the screen that holds them.
 *
 * Every picture is kept for ever, which is a decision rather than an oversight — so the number
 * goes where the decision is visible. A folder growing out of sight is the version of this that
 * would be dishonest.
 */
async function weigh() {
  if (!own) return
  let bytes = 0
  let count = 0
  for (const entry of readdirSync(own, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(png|jpe?g|webp|gif|mp4|webm|mp3|flac|wav)$/i.test(entry.name)) continue
    count += 1
    bytes += statSync(join(own, entry.name)).size
  }
  const size = bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
  await alexia
    .status('disk', count === 0 ? '■ Nothing made yet' : `● ${count} file${count === 1 ? '' : 's'}, ${size} — kept for ever, in this plugin’s own folder`)
    .catch(() => {})
}

/**
 * What this machine could run that it does not have yet — journey 3's search.
 *
 * **It filters on the card before it ranks on the words**, and the numbers are why. Measured
 * against the live catalogue and the card in this machine: 468 workflows, of which 255 call a
 * paid service and 168 of the rest want more video memory than there is — leaving 45. Offering
 * all 468 would mean five in six answers being a disappointment, either a card somebody does
 * not have or a credit card they did not expect to need.
 *
 * **It can find and it cannot yet install**, and it says so rather than pretending. ComfyUI
 * ships these in the editor's own format, and turning one into something `/prompt` will accept
 * needs the conversion that lives in ComfyUI's frontend (D123). Until that bridge exists, this
 * points at the thing and names the one menu click.
 */
alexia.tool(
  'find_workflow',
  {
    description:
      'Search the workflows ComfyUI ships for one that does something Alexia has no tool for — ' +
      'background removal, upscaling, video, speech, 3D. Use when nothing installed fits what ' +
      'the user asked for, before telling them it cannot be done. Only shows what this machine ' +
      'can actually run: ones needing more video memory than this card has, and ones calling ' +
      'paid services, are left out unless asked for.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        looking_for: { type: 'string', description: 'What the user wants done, in their own words.' },
        include_paid: {
          type: 'boolean',
          description: 'Also show workflows that call paid hosted services and need an API key. Off by default.',
        },
      },
      required: ['looking_for'],
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ looking_for: asked, include_paid: paid }, ctx) => {
    const signal = ctx?.mcpReq?.signal
    const state = await reachable(ctx)
    if (!state.ok) return refuse(state.said)
    const server = await where()
    const all = flatten(await templates(server, signal).catch(() => []))
    if (all.length === 0) {
      return { content: [{ type: 'text', text: 'This ComfyUI does not offer a workflow catalogue.' }] }
    }
    const card = vram(await stats(server, signal).catch(() => undefined))
    const mine = runnable(all, { vram: card?.total, paid: paid === true })
    const hits = search(mine, asked)
    const counts = shelf(all, card?.total)
    if (hits.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `Nothing in ComfyUI’s own workflows matches “${String(asked)}”. ${counts.said}`,
          },
        ],
      }
    }
    return {
      content: [
        {
          type: 'text',
          text: [
            `${hits.length} of ComfyUI’s own workflows look like “${String(asked)}”:`,
            ...hits.map((one) => `  • ${line(one)}`),
            '',
            // The honest end of the chain. Finding it is done; installing it is not.
            'Alexia cannot install one yet — ComfyUI ships these in its editor’s format, and turning ' +
              'one into something that can be queued is a conversion only ComfyUI’s own editor does. ' +
              'To use one: open it in ComfyUI (Workflow → Browse Templates), then Workflow → Export (API), ' +
              'and hand Alexia the file with add_workflow.',
            counts.said,
          ].join('\n'),
        },
      ],
    }
  },
)

alexia.tool(
  'setup',
  {
    description:
      'Set local media generation up on this machine: find ComfyUI, read what the graphics card ' +
      'can hold, and download one image model if there are none. Takes no arguments. Safe to ' +
      'call again — it downloads nothing that is already there, and resumes a download that was ' +
      'interrupted rather than starting it over. The first run can take half an hour.',
    // Something large arrives on the person's disk that was not there before, and it is theirs
    // to approve. Not destructive — nothing is overwritten — and asking twice is harmless.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (ctx) => {
    const signal = ctx?.mcpReq?.signal
    const dir = await found()
    if (!dir) {
      // **Hand off rather than build.** Getting PyTorch right for a specific card and driver is
      // the commonest way this breaks for people, and ComfyUI's own installer already owns that
      // problem. Alexia's job is to find the result and carry on.
      return {
        content: [
          {
            type: 'text',
            text:
              'ComfyUI is not on this machine, and it is what makes the pictures. Install it from ' +
              'comfy.org — their own installer handles the graphics-card half, which is the part that ' +
              'goes wrong. Alexia will find it afterwards; run this again once it is there, or just ' +
              'ask for a picture. If it is installed somewhere unusual, put the folder in this ' +
              'plugin’s settings instead.',
          },
        ],
      }
    }

    const state = await reachable(ctx)
    if (!state.ok) return refuse(state.said)
    const server = await where()
    const machine = await stats(server, signal).catch(() => undefined)
    const said = reading(machine, available)
    if (!said.ok) return { content: [{ type: 'text', text: said.said }] }
    if (!said.download) {
      return { content: [{ type: 'text', text: `${said.said} Ready — ask for a picture.` }] }
    }
    if (!own) return refuse('Alexia has not given this plugin a folder to work in.')

    const rung = said.download
    const to = join(own, 'models', 'checkpoints', rung.file)
    await alexia.status('state', `▲ Downloading ${rung.label}…`).catch(() => {})
    try {
      const got = await fetchModel(rung.url, to, {
        expect: rung.bytes,
        signal,
        onProgress: (done, total, text) => alexia.progress(ctx, done, total, text),
      })
      // ComfyUI only learns about a new folder when it starts, and it was started before this.
      await bind(signal)
      return {
        content: [
          {
            type: 'text',
            text:
              (got.already ? `${rung.label} was already here.` : `${rung.label} downloaded (${(got.bytes / 1e9).toFixed(1)} GB, ${rung.licence}).`) +
              ' Restart ComfyUI — stop_comfyui then ask for a picture — so it picks the model up, and it is ready.',
          },
        ],
      }
    } catch (error) {
      await bind(signal)
      const part = (await have(to)).part
      return refuse(
        `${String(error?.message ?? error)}${part > 0 ? ` ${(part / 1e9).toFixed(1)} GB is saved, so asking again carries on from there.` : ''}`,
      )
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
/**
 * The conversation is over, so give the graphics card back.
 *
 * **ComfyUI outlives the plugin that started it on purpose** — it takes the better part of a
 * minute to import PyTorch and load a checkpoint, and this plugin is stopped after five idle
 * minutes, so tying one to the other would mean paying that minute again after every pause.
 * The cost of that decision is that nothing ever said *stop*: a card stayed occupied all night
 * because somebody asked for one picture at lunchtime.
 *
 * Starting a new conversation is the clearest signal a person gives that they have finished with
 * what the last one was about, and it is the only one that arrives without anybody having to
 * remember a command. **Only a ComfyUI Alexia started is stopped** — the same two conditions
 * `stop_comfyui` uses, because one somebody opened themselves is not Alexia's to close, and
 * finishing a chat is not permission to close somebody else's program.
 */
alexia.onConversationEnded(() => {
  void (async () => {
    try {
      const mine = await alexia.storage.get('started').catch(() => undefined)
      if (!mine?.pid || !alive(mine.pid)) return
      if (!(await awake(await where()))) {
        await alexia.storage.remove('started').catch(() => {})
        return
      }
      if (await stop(mine.pid)) {
        await alexia.storage.remove('started').catch(() => {})
        log.info('a new conversation started, so the ComfyUI Alexia started was stopped')
        await bind()
      }
    } catch {
      // Letting go of a graphics card is never worth failing over.
    }
  })()
})

alexia.onSettingsChanged((changed) => {
  // `path` moves where it would be started from, so a cached search result is stale.
  if ('path' in changed) where_it_is = undefined
  // A different address is a different install, with its own node packs. Nothing about the one
  // that was cached is true of it, and a workflow bound against the wrong one binds silently.
  if ('server' in changed) known = undefined
  if ('server' in changed || 'checkpoint' in changed || 'path' in changed || 'autostart' in changed) void bind()
})
log.info(`${alexia.manifest.name} is ready`)
