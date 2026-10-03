// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { checkpoints, classes, named, pick, stats, templates } from './comfy.js'
import { facts, split } from './compute.js'
import { alive, awake, install, loopback, port, ready, start, stop, tail } from './launch.js'
import { named_of, renderer } from './render.js'
import { COMFYUI, comfyStatus, installComfy, installed, nvidia, requirement as comfyRequirement } from './install.js'
import { RENDER, dedicated, fetchRequirement, onDisk, requirements } from './worker.js'
import {
  API_SUFFIX,
  FOLDER,
  apply,
  isApi,
  knobs,
  missing,
  fromWeb,
  pictures,
  read,
  remove,
  reseed,
  roles,
  saved,
  told,
  used,
  wired,
  write,
} from './workflows.js'
import { api as starterGraph, CHANGE, editor as starterDoc, STARTER } from './starter.js'
import { memory, merge, recall } from './memory.js'
import { picture } from './inputs.js'
import { measure } from './sizing.js'
import { fetchModel, have } from './models.js'
import { reading, vram } from './tier.js'
import { describe as line, flatten, runnable, search, shelf } from './catalog.js'
import { convert } from './convert.js'
import { LIBRARY, library } from './library/tools.js'

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
/** Where planning ends and rendering begins — see `compute.js`. */
const compute = split(alexia)
/** The workflow and model used last, and what the person set on each workflow — see `memory.js`. */
const mind = memory(alexia.storage)

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
    // **The card, said before anything is pressed rather than after.** M9-1e: a machine with no
    // graphics card can install this, ask for a picture, and wait minutes for it — and until now
    // the only place that was said was `setup`, which somebody reaches after committing.
    // ComfyUI's own reading is the authority (§6.1), so this is only asked once it is answering.
    const card = vram(await stats(await where(), signal).catch(() => undefined))
    if (!card) return { ok: true, said: `▲ Ready — ${many}, but no graphics card was found, so each picture will take minutes rather than seconds` }
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
  where_it_is = (await install(undefined, undefined, async () => (await installed(own))?.dir)) ?? null
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
async function wake(signal, ctx, report) {
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
      onProgress: (tick) => {
        const said = tick < 20 ? 'Starting ComfyUI' : 'Starting ComfyUI — loading its nodes and models'
        // An operation has a reporter rather than a call of its own to report on.
        if (report) report(said, tick, 90)
        else if (ctx) alexia.progress(ctx, tick, 90, said)
      },
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

const made = alexia.tool(
  'generate',
  {
    description:
      'Make an image on this machine from a description. The picture is handed straight to ' +
      'the user, so say what you made — do not describe where it was saved. Use when the ' +
      'user asks for a picture, an illustration, a logo or a mock-up, or to change a picture they ' +
      'attached (pass it in images). With no workflow named it uses the workflow and the model ' +
      'used last time, and anything the user set before (a size, more steps) until they say ' +
      'otherwise. The result says every setting it used, seed included. Starts ComfyUI first ' +
      'if it is not already running. Takes twenty seconds to a few minutes depending on the ' +
      'machine, and reports progress.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What the picture shows. Concrete and visual — subject, setting, style, lighting.',
        },
        negative: { type: 'string', description: 'What to keep out of it. Optional; kept for the next picture.' },
        width: { type: 'number', description: 'Pixels wide. Defaults to 768, or what the user set before; SDXL wants multiples of 64. Kept for the next picture.' },
        height: { type: 'number', description: 'Pixels tall. Defaults to 768, or what the user set before. Kept for the next picture.' },
        steps: {
          type: 'number',
          description: 'How many steps to take — more is slower and usually better. Use for *more detail*, *faster*. Kept for the next picture.',
        },
        seed: {
          type: 'number',
          description: 'Same seed and same prompt gives the same picture. Omit for a new one; every result says the seed it used.',
        },
        again: {
          type: 'boolean',
          description:
            'Reuse the last picture’s settings — including its seed — for anything not given here. ' +
            'Use when the user says *again*, *same seed*, *same settings*, *same but bigger*, *that one ' +
            'but at night*. Without this a new seed is rolled and the picture is a different one.',
        },
        model: {
          type: 'string',
          description:
            'Which installed checkpoint to paint with — any part of its filename is enough. ' +
            'Worth naming when the style matters (*use the anime model*), since the models installed ' +
            'are rarely interchangeable: `models` lists them. Omit to use the one used last time.',
        },
        workflow: {
          type: 'string',
          description:
            'Which saved workflow to make it with, by any part of its name — `workflows` lists them. ' +
            'Omit to use the one used last time; "starter" is Alexia’s own plain one.',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Pictures to start from — the paths of files the user attached or pointed at. The picture ' +
            'is redrawn from the first one (image-to-image); a saved workflow with picture fields ' +
            'takes them in order. Only paths the user gave you.',
        },
        strength: {
          type: 'number',
          description:
            'How much to change a picture given in images, from 0 (barely) to 1 (start over). ' +
            'Defaults to 0.6. Kept for the next picture.',
        },
      },
      required: ['prompt'],
    }),
    // It writes a file into this plugin's own folder and nothing else. Not read-only —
    // something new exists afterwards — and not destructive: nothing is overwritten.
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ prompt, negative, width, height, steps, seed, model, again, workflow, images, strength }, ctx) => {
    const signal = ctx?.mcpReq?.signal
    if (!own) return { isError: true, content: [{ type: 'text', text: 'Alexia has not given this plugin a folder to work in.' }] }
    const given = (Array.isArray(images) ? images : []).map(String).filter((one) => one.trim() !== '')
    for (const one of given) {
      try {
        picture(one)
      } catch (error) {
        return refuse(String(error?.message ?? error))
      }
    }

    // **Which workflow, before anything else.** A plain request is the workflow used last; the
    // list of saved ones is only read when that is not Alexia's own, so a person who never left
    // the plain pipeline never waits on a ComfyUI here to be asked anything.
    const remembered = await mind.remembered()
    const named = workflow !== undefined && String(workflow).trim() !== ''
    const elsewhere = remembered.workflow && remembered.workflow !== STARTER
    const notes = []
    if (named || elsewhere) {
      const state = await reachable(ctx)
      let rows = []
      if (state.ok) rows = await saved(await where(), signal).catch(() => [])
      else if (named) return refuse(state.said)
      const chosen =
        state.ok ?
          recall({ asked: workflow, remembered, rows, starter: STARTER, pick })
        : { starter: true, said: `The workflow used last time, ${remembered.workflow}, could not be read: ${state.said} So this used Alexia’s own instead.` }
      if (chosen.refused) return refuse(chosen.refused)
      if (chosen.said) notes.push(chosen.said)
      if (chosen.row) {
        const ran = await runSaved(chosen.row, { seed, images: given, again, plain: { prompt, negative, width, height, model, steps, strength } }, ctx)
        if (!ran.fallback) return ran
        notes.push(ran.fallback)
      }
    }

    // **The plan, which is everything that belongs to the person**: their words, their settings,
    // and the seed of the last picture they made. Which model is installed, whether ComfyUI is
    // running and how much memory is free are the rendering computer's to answer, and that may
    // not be this one — so none of it is asked here.
    const { steps: configured, vae_fp32: fp32 } = await settings()
    const last = (await alexia.storage.get('last').catch(() => undefined)) ?? {}
    const before = again === true ? last : {}
    const kept = await mind.kept(STARTER)
    const size = measure({ width, height, seed, again }, last, kept)
    const start = given[0]
    if (given.length > 1) notes.push(`Only the first picture was used — Alexia’s own workflow starts from one. A saved workflow with more picture fields can take the rest.`)
    // A size nobody asked for is the picture's own shape, not a square cut out of it.
    const sized = [width, height, before.width, before.height, kept.width, kept.height].some((one) => one !== undefined)
    const chosen = {
      steps: Number(steps ?? before.steps ?? kept.steps ?? configured) || 25,
      negative: String(negative ?? before.negative ?? kept.negative ?? 'blurry, low quality, watermark, text'),
      change: Math.min(1, Math.max(0, Number(strength ?? before.change ?? kept.change ?? CHANGE))),
    }
    let made
    try {
      made = await compute.run(
        RENDER,
        {
          kind: 'picture',
          prompt: String(prompt),
          negative: chosen.negative,
          // Rounded to 64 because SDXL's latent space is in units of 8 and its training is in
          // units of 64. A model handed 1000x1000 makes something subtly wrong rather than
          // refusing, which is the worst of both.
          width: size.width,
          height: size.height,
          seed: size.seed,
          steps: chosen.steps,
          fp32: fp32 !== false,
          ...(model && { model: String(model) }),
          // The model used last time, as a preference the rendering computer may not be able to
          // keep. *Again* means the last picture's own model, which is usually the same one.
          ...(!model && (before.model ?? remembered.checkpoint) && { remembered: String(before.model ?? remembered.checkpoint) }),
          preferred: await preferred(),
          ...(start && { images: [start], change: chosen.change, aspect: !sized }),
        },
        {
          signal,
          report: (message, done, total, work) => alexia.progress(ctx, done, total, message, work),
          ...(start && { inputs: [picture(start)] }),
        },
      )
    } catch (error) {
      // Not running and not startable, a model nobody has, a computer that is not ready: each
      // is one sentence, said by whichever computer was asked.
      return { isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] }
    }
    const { checkpoint = 'the model that was there', warning, here, forgotten } = facts(made.text)

    for (const to of made.files) {
      await alexia.storage
        .insert('images', { path: to, prompt: String(prompt), checkpoint, at: Date.now() })
        .catch(() => {})
    }
    // **What it took, so the next sentence can be about it.** *Same but bigger* means the same
    // seed — and a seed nobody wrote down is a different picture, which is the whole failure the
    // model remembering the conversation cannot fix: it never saw the number.
    await alexia.storage
      .set('last', {
        prompt: String(prompt),
        negative: chosen.negative,
        model: checkpoint,
        steps: chosen.steps,
        ...(start && { change: chosen.change }),
        ...size,
        at: Date.now(),
      })
      .catch(() => {})
    // What the person said this time is what they want from now on; the rest stays as it was.
    await mind.keep(STARTER, {
      width: width === undefined ? undefined : size.width,
      height: height === undefined ? undefined : size.height,
      steps: steps === undefined ? undefined : chosen.steps,
      negative,
      change: strength === undefined ? undefined : chosen.change,
    })
    if (made.files.length > 0) await mind.used({ workflow: STARTER, checkpoint: facts(made.text).checkpoint })
    await bind(signal)

    const from = (field, said) => (said !== undefined ? undefined : again === true && before[field] !== undefined ? 'again' : kept[field] !== undefined ? 'kept' : undefined)
    const report = [
      { field: 'model', value: checkpoint },
      start && !sized ?
        { field: 'size', value: `the picture’s own shape, ${size.height} tall` }
      : { field: 'width', value: size.width, kept: from('width', width) === 'kept' },
      ...(start && !sized ? [] : [{ field: 'height', value: size.height, kept: from('height', height) === 'kept' }]),
      { field: 'steps', value: chosen.steps, kept: from('steps', steps) === 'kept' },
      { field: 'negative', value: chosen.negative, kept: from('negative', negative) === 'kept' },
      ...(start ?
        [
          { field: 'picture', value: basename(start) },
          { field: 'how_much_to_change', value: chosen.change, kept: from('change', strength) === 'kept' },
        ]
      : []),
      { field: 'seed', value: size.seed },
    ]
    return {
      content: [
        {
          type: 'text',
          text: [
            // *Here* is only said when it was. The operation knows whether the tool that planned
            // it is in its own process, and that is all it says — not which computer it was.
            `Made ${here === false ? 'on the computer you chose' : 'here'} with ${STARTER}, using ${checkpoint}.`,
            forgotten ? `The model used last time, ${forgotten}, is not on that computer any more, so ${checkpoint} was used instead.` : undefined,
            ...notes,
            size.reused ? `Same seed as the last one (${size.seed}), so it is that picture again.` : undefined,
            `Settings used: ${told(report)}.`,
            warning ? `▲ ${warning}` : undefined,
          ]
            .filter(Boolean)
            .join(' '),
        },
        // The picture itself, not its path. The answer to *make me an image* used to open
        // with the filename — correct, nothing a person could press, and read straight back
        // to them by a model that could not see the difference. It is a row under the answer
        // now, on the window or as a photo over a channel, and the model is told only that.
        ...made.files.map((to) => alexia.file(to, { description: String(prompt) })),
      ],
    }
  },
)

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
    knob.type === 'image' ? 'a picture — the path of a file'
    : knob.options ?
      `one of ${knob.options.slice(0, 12).join(', ')}${knob.options.length > 12 ? `, and ${knob.options.length - 12} more` : ''}`
    : knob.type
  return `  ${knob.field} (${kind}) — ${knob.title}`
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
async function reachable(ctx, { signal = ctx?.mcpReq?.signal, report } = {}) {
  const state = await bind(signal)
  const up = state.ok ? state : await wake(signal, ctx, report)
  if (up.ok) await plant(signal)
  return up
}

/**
 * What a workflow offers to be set, and whether anybody named it.
 *
 * **Titled boxes always win** — D128, because a title is the author saying *this is the knob*,
 * and a graph with its own vocabulary keeps it. The wiring is read only when a workflow names
 * nothing at all, which is every one of ComfyUI's own catalogue templates: without this they
 * install and then run with whatever prompt their author baked in, and *install this and run it
 * against what I asked for* is impossible for the whole catalogue.
 */
const fields = (graph, spec) => {
  const named = knobs(graph, spec)
  if (named.length > 0) return { found: named, derived: false }
  const found = wired(graph, spec)
  return { found, derived: found.length > 0 }
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
    const shown = []
    for (const row of rows) {
      said.push(`${row.name} — ${standing(row)}`)
      // One walk, two audiences: the sentences are for the model, the row is for the panel. A
      // second tool answering the same question off the same disk would be a second thing to
      // keep true, and `table` wants exactly the shape this loop already has in its hand.
      const seen = { id: row.name, name: row.name, state: standing(row), fields: '—' }
      shown.push(seen)
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
        const { found, derived } = fields(graph, spec)
        seen.fields =
          found.length === 0 ? 'none'
          : derived ? `${found.map((one) => one.field).join(', ')} (from its wiring)`
          : found.map((one) => one.field).join(', ')
        said.push(
          ...(found.length > 0 ? found.map(describe) : (
            ['  No fields — nothing in it is titled, so it runs exactly as exported.']
          )),
        )
        // Where the field came from changes how much to trust its name, so it is said rather
        // than left for somebody to notice.
        if (derived) said.push('  Nothing in it is titled, so these were read off its wiring.')
        const kept = Object.entries(await mind.kept(row.name))
          .filter(([field]) => found.some((one) => one.field === field))
          .map(([field, value]) => ({ field, value }))
        if (kept.length > 0) said.push(`  Set before and kept until changed: ${told(kept)}.`)
      } catch (error) {
        seen.fields = 'unreadable'
        said.push(`  Could not read the export: ${String(error?.message ?? error)}`)
      }
    }
    return { content: [{ type: 'text', text: said.join('\n') }], structuredContent: { rows: shown } }
  },
)

/**
 * Run one saved workflow: its fields applied, its pictures sent, its seed rolled or repeated.
 *
 * Both `run_workflow` and a plain `generate` arrive here. `values` and `images` are what
 * `run_workflow` was given; `plain` is `generate`'s fixed vocabulary — a description, a size, a
 * model — put onto whichever fields of this workflow do those things (`roles`). A workflow with
 * nowhere to put the description answers `{ fallback }` rather than running with the prompt its
 * author baked in, which would be a picture of something nobody asked for.
 */
async function runSaved(row, { values, seed, stale, images = [], again, plain }, ctx) {
  const signal = ctx?.mcpReq?.signal
  if (!own) return refuse('Alexia has not given this plugin a folder to work in.')
  const server = await where()
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

  const { found: titledFound } = fields(graph, spec)
  const found = [...titledFound]
  const said = { ...(values ?? {}) }
  const notes = []
  const role = roles(graph, spec, titledFound)
  if (plain) {
    if (!role.prompt) return { fallback: `${row.name} has no box for the description, so this used Alexia’s own workflow instead.` }
    // A picture to start from that the workflow has nowhere to put would be quietly ignored;
    // Alexia's own can start from one, so it is the better answer to the request.
    if (images.length > 0 && !titledFound.some((knob) => knob.type === 'image')) {
      return { fallback: `${row.name} takes no picture to start from, so this used Alexia’s own workflow, which does.` }
    }
    const left = []
    for (const [name, value] of Object.entries(plain)) {
      if (value === undefined || value === null || value === '') continue
      const knob = role[name === 'strength' ? 'change' : name]
      if (!knob) {
        left.push(name === 'strength' ? 'how much to change' : name)
        continue
      }
      // A role found only on the wiring is not one of the workflow's fields; it is set all the same.
      if (!found.includes(knob)) found.push(knob)
      said[knob.field] = value
    }
    if (left.length > 0) notes.push(`${row.name} has nothing to set ${left.join(', ')} on, so ${left.length === 1 ? 'that was' : 'those were'} left as the workflow has ${left.length === 1 ? 'it' : 'them'}.`)
  }
  const strange = Object.keys(said).filter((field) => !found.some((knob) => knob.field === field))
  if (strange.length > 0) {
    return refuse(
      `${row.name} has no field called ${strange.join(', ')}. It takes: ` +
        `${found.map((knob) => knob.field).join(', ') || 'nothing — it runs exactly as exported'}.`,
    )
  }
  for (const knob of found) {
    if (!knob.options || !Object.hasOwn(said, knob.field)) continue
    // A combo's options are filenames again, so the same loose match `generate` uses applies —
    // and the same refusal, because a near miss answered with a different LoRA is a picture
    // nobody can explain.
    const chose = pick(knob.options, String(said[knob.field]))
    if (!chose) {
      return refuse(`${knob.field} has nothing here called ${String(said[knob.field])}. It takes one of: ${knob.options.join(', ')}`)
    }
    said[knob.field] = chose
  }

  // **What the person said before, and what this workflow last ran with.** Pictures are never
  // carried over — each request brings its own — and neither is the description, which is what
  // a new request is *for*.
  const settable = found.filter((knob) => knob.type !== 'image')
  const describes = role.prompt?.field
  const last = again === true ? await mind.last(row.name) : undefined
  const kept = await mind.kept(row.name)
  const carried = { ...(last?.values ?? {}) }
  if (describes && Object.hasOwn(said, describes)) delete carried[describes]
  const { values: merged, from } = merge({
    fields: settable.map((knob) => knob.field),
    said: Object.fromEntries(Object.entries(said).filter(([field]) => settable.some((knob) => knob.field === field))),
    again: carried,
    kept: Object.fromEntries(Object.entries(kept).filter(([field]) => field !== describes)),
  })
  // A kept model that has since been deleted is history, not a refusal: it is said and dropped.
  for (const knob of settable) {
    if (!knob.options || from[knob.field] === 'said' || !Object.hasOwn(merged, knob.field)) continue
    if (knob.options.includes(String(merged[knob.field]))) continue
    notes.push(`${knob.field} was set to ${String(merged[knob.field])} before, which is not here any more, so the workflow’s own was used.`)
    delete merged[knob.field]
  }

  const { bound, unused } = pictures(found, said, images)
  for (const one of bound) {
    try {
      picture(one.path)
    } catch (error) {
      return refuse(String(error?.message ?? error))
    }
  }
  if (unused.length > 0) {
    notes.push(
      found.some((knob) => knob.type === 'image') ?
        `${row.name} takes fewer pictures than were given, so ${unused.map((one) => basename(one)).join(', ')} ${unused.length === 1 ? 'was' : 'were'} not used.`
      : `${row.name} has no picture to start from — nothing in it that loads one is titled — so ${unused.map((one) => basename(one)).join(', ')} ${unused.length === 1 ? 'was' : 'were'} not used.`,
    )
  }

  const rolled =
    Number.isFinite(Number(seed)) ? Number(seed)
    : Number.isFinite(Number(last?.seed)) ? Number(last.seed)
    : Math.floor(Math.random() * 2 ** 31)
  // **Prepared here, rendered where the person chose.** The workflow is theirs and is read
  // off the ComfyUI on this computer, with their fields applied and the seed rolled; what is
  // handed over is the finished graph, and the rendering computer checks it against its own
  // nodes before it queues anything — and uploads the pictures to its own ComfyUI.
  const built = reseed(apply(graph, found, merged), rolled)
  let made
  try {
    made = await compute.run(
      RENDER,
      { kind: 'workflow', name: row.name, graph: built, ...(bound.length > 0 && { images: bound.map(({ node, input, path }) => ({ node, input, path })) }) },
      {
        signal,
        report: (message, done, total, work) => alexia.progress(ctx, done, total, message, work),
        ...(bound.length > 0 && { inputs: bound.map((one) => picture(one.path)) }),
      },
    )
  } catch (error) {
    return refuse(String(error?.message ?? error))
  }
  const { text: reported = [] } = facts(made.text)

  for (const to of made.files) {
    await alexia.storage.insert('runs', { workflow: row.name, path: to, seed: rolled, at: Date.now() }).catch(() => {})
  }
  // What was said is kept for this workflow — never the description — and the run as a whole
  // is written down for *again*.
  await mind.keep(row.name, Object.fromEntries(Object.entries(merged).filter(([field]) => from[field] === 'said' && field !== describes)))
  await mind.ran(row.name, { values: merged, seed: rolled })
  if (made.files.length > 0) await mind.used({ workflow: row.name })
  await bind(signal)
  const shown = used(found, built, { pictures: bound }).map((one) => ({ ...one, kept: from[one.field] === 'kept' }))
  return {
    content: [
      {
        type: 'text',
        text: [
          `Ran ${row.name}${made.files.length === 0 ? ', which produced no file' : ''}.`,
          ...notes,
          last && !Number.isFinite(Number(seed)) && Number.isFinite(Number(last.seed)) ? `Same settings and seed as the last run (${rolled}).` : undefined,
          `Fields used: ${told(shown) || 'none — it ran as exported'}. Seed ${rolled}.`,
        ]
          .filter(Boolean)
          .join(' '),
      },
      // What the graph made of what it was given. On these workflows that is the prompt an
      // Ollama node wrote out of the plain English, and it is the only way to see why a
      // picture came out the way it did — the alternative is guessing at somebody else's graph.
      ...(reported.length > 0 ? [{ type: 'text', text: `The workflow reported: ${reported.join(' / ')}` }] : []),
      ...made.files.map((to) => alexia.file(to, { description: row.name })),
    ],
  }
}

alexia.tool(
  'run_workflow',
  {
    description:
      'Run one of the ComfyUI workflows saved on this machine — the whole pipeline its author ' +
      'built, with its LoRAs, ControlNet, reference images and its own settings, rather than the ' +
      'plain one generate uses. Call workflows first: it names each workflow and the fields this ' +
      'takes for it, which are different every time because the person who built it chose them. ' +
      'Values set here are kept for that workflow until changed or cleared with reset_workflow, ' +
      'and the result lists every field and the seed it actually ran with. ' +
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
            'keeps the value set last time, or else the one it was exported with. Write these the ' +
            'way the field’s description asks — a field called plain English wants a sentence, not ' +
            'a tag list. A picture field takes the path of a file.',
          additionalProperties: true,
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Pictures for the workflow’s picture fields, in order — the paths of files the user ' +
            'attached or pointed at. Only paths the user gave you.',
        },
        seed: {
          type: 'number',
          description:
            'Same seed and same fields gives the same result. Omit for a new one — an export ' +
            'carries whatever seed the editor last showed, so omitting this is what the editor’s ' +
            'own randomise does. Every result says the seed it used.',
        },
        again: {
          type: 'boolean',
          description:
            'Reuse the last run of this workflow — every field and its seed — for anything not given ' +
            'here. Use for *again*, *same seed*, *same settings but …*.',
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
  async ({ workflow, values, images, seed, again, stale }, ctx) => {
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
    return runSaved(row, { values, seed, stale, again, images: (Array.isArray(images) ? images : []).map(String) }, ctx)
  },
)

alexia.tool(
  'reset_workflow',
  {
    description:
      'Forget what the user set on a workflow — a size, steps, a model — so it goes back to its own ' +
      'defaults. Use when they say *back to normal*, *reset the settings*, *forget the size*. Makes ' +
      'nothing. Takes the workflow (omit for the one used last) and optionally which fields to forget.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Which workflow; any part of its name. Omit for the one used last.' },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only these fields, by the names the last result listed. Omit to forget them all.',
        },
      },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ workflow, fields }, ctx) => {
    const asked = String(workflow ?? '').trim()
    let name = (await mind.remembered()).workflow || STARTER
    if (asked) {
      // Values are kept under a workflow's whole name, so a loose one is matched against the saved
      // list — which needs ComfyUI here, but only for a name that is not Alexia's own.
      const plain = recall({ asked, rows: [], starter: STARTER, pick })
      if (plain.starter) name = STARTER
      else {
        const state = await reachable(ctx)
        if (!state.ok) return refuse(state.said)
        const chosen = recall({ asked, rows: await saved(await where(), ctx?.mcpReq?.signal).catch(() => []), starter: STARTER, pick })
        if (chosen.refused) return refuse(chosen.refused)
        name = chosen.row.name
      }
    }
    const only = Array.isArray(fields) && fields.length > 0 ? fields.map(String) : undefined
    // For Alexia's own, `model` is the model used last rather than a kept field, and forgetting
    // it is what puts the settings screen's choice back in charge.
    const model = name === STARTER && (!only || only.includes('model')) && (await mind.remembered()).checkpoint
    if (model) await mind.forgetModel()
    const cleared = await mind.reset(name, only?.filter((one) => !(name === STARTER && one === 'model')))
    if (model) cleared.push('model')
    return {
      content: [
        {
          type: 'text',
          text:
            cleared.length === 0 ?
              `Nothing was set on ${name}, so it already uses its own defaults.`
            : `${name} is back to its own defaults for ${cleared.join(', ')}. The next picture uses them.`,
        },
      ],
    }
  },
)

alexia.tool(
  'add_workflow',
  {
    description:
      'Save a workflow so run_workflow can use it, from a file on this machine or from an https ' +
      'link the user gave. A path is what ComfyUI wrote for Workflow → Export (API), usually in ' +
      'Downloads; a link is one the user pasted — to the workflow file itself, not to the page ' +
      'showing it. Use when the user has just exported one, has found one online, or when ' +
      'workflows says one is not exported. Never invent a link: only use one the user gave.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description:
            'The path of the exported .json file, or an https link to one the user gave you.',
        },
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
    if (path === '') return refuse('Which one? This needs a path on this machine, or an https link to the file.')
    // A link and a file are the same thing once they are JSON, and D139 is why a link is
    // allowed at all: the converter refuses any node this machine does not have, so nothing
    // arrives but text that either maps onto what is installed or is turned away by name.
    const web = /^https?:/i.test(path)
    let doc
    if (web) {
      try {
        doc = await fromWeb(path, signal)
      } catch (error) {
        return refuse(String(error?.message ?? error))
      }
    } else {
      try {
        doc = JSON.parse(readFileSync(path, 'utf8'))
      } catch (error) {
        return refuse(
          error?.code === 'ENOENT' ? `There is no file at ${path}.`
            : `${basename(path)} could not be read as JSON: ${String(error?.message ?? error)}`,
        )
      }
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

    const called =
      String(name ?? '').trim() ||
      (web ? decodeURIComponent(new URL(path).pathname.split('/').filter(Boolean).pop() ?? 'workflow') : basename(path))
        .replace(/\.api\.json$|\.json$/i, '')
    const to = `${FOLDER}/${called}${API_SUFFIX}`
    await write(server, to, JSON.stringify(doc), signal)

    const { row } = await which(server, called, signal)
    const spec = await nodes(signal).catch(() => ({}))
    const absent = missing(doc, spec)
    const { found, derived } = fields(doc, spec)
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
            found.length === 0 ?
              'Nothing in it is titled and its wiring did not say, so it takes no fields and runs exactly as exported.'
            : derived ?
              `Nothing in it is titled, so its fields were read off its wiring: ${found.map((knob) => knob.field).join(', ')}.`
            : `Its fields: ${found.map((knob) => knob.field).join(', ')}.`,
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
            'Say which one and install_workflow will set it up. Some cannot be converted outside ' +
              'ComfyUI’s own editor — that is refused by name rather than guessed at, and the way ' +
              'round it is Workflow → Export (API) there, then add_workflow.',
            counts.said,
          ].join('\n'),
        },
      ],
    }
  },
)

alexia.tool(
  'remove_workflow',
  {
    description:
      'Delete a workflow saved on this machine, by the name workflows lists it under. Removes both ' +
      'halves — the workflow and its API export. Use when the user asks to get rid of one.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { id: { type: 'string', description: 'The workflow’s name, as workflows lists it.' } },
      required: ['id'],
    }),
    // The one destructive thing this plugin does to something a person may have built by hand,
    // so it goes through the gate rather than round it.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ id }, ctx) => {
    const signal = ctx?.mcpReq?.signal
    const name = String(id ?? '').trim()
    if (name === '') return refuse('Which one? workflows lists what is saved here.')
    const state = await reachable(ctx)
    if (!state.ok) return refuse(state.said)
    const server = await where()
    const row = (await saved(server, signal)).find((one) => one.name === name)
    if (!row) return refuse(`Nothing saved here is called ${name}.`)
    // Both halves, and a half that was not there is not a failure — a pair with one side
    // missing is the ordinary case, not a broken one.
    const gone = []
    for (const path of [row.workflow, row.export]) {
      if (path && (await remove(server, path, signal))) gone.push(path)
    }
    return {
      content: [
        {
          type: 'text',
          text:
            gone.length === 0 ?
              `${name} was listed but its files were already gone.`
            : `Deleted ${name} — ${gone.length === 2 ? 'the workflow and its export' : gone[0]}. It is not in ComfyUI any more either; this is ComfyUI’s own folder.`,
        },
      ],
    }
  },
)

alexia.tool(
  'setup',
  {
    description:
      'Set local media generation up on this machine: find ComfyUI — or, on a Windows PC with an ' +
      'NVIDIA card and none installed, install Alexia’s own copy of it (about 2 GB) — read what the ' +
      'graphics card can hold, and download one image model if there are none. Takes no arguments. ' +
      'Safe to call again — it downloads nothing that is already there, and resumes a download that ' +
      'was interrupted rather than starting it over. The first run can take half an hour.',
    // Something large arrives on the person's disk that was not there before, and it is theirs
    // to approve. Not destructive — nothing is overwritten — and asking twice is harmless.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (ctx) => {
    const signal = ctx?.mcpReq?.signal
    let dir = await found()
    if (!dir) {
      // **Alexia's own copy, where there is one to install** (`install.js`): the pinned portable
      // build, into this plugin's folder, on a Windows PC with an NVIDIA card. Everywhere else
      // ComfyUI's own installer is still the right hand-off, and `comfyStatus` says which.
      const status = await comfyStatus({ own })
      if (status.state !== 'missing') {
        return {
          content: [
            {
              type: 'text',
              text:
                `ComfyUI is not on this machine, and it is what makes the pictures. ${status.said ?? ''} ` +
                'If it is installed somewhere unusual, put the folder in this plugin’s settings instead.',
            },
          ],
        }
      }
      try {
        await installComfy({ own, signal, onProgress: (done, total, text) => alexia.progress(ctx, done, total, text) })
      } catch (error) {
        return refuse(String(error?.message ?? error))
      }
      where_it_is = undefined
      dir = await found()
      if (!dir) return refuse('ComfyUI was installed, but Alexia could not find it afterwards.')
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

/**
 * The ComfyUI this plugin runs as a compute worker — its own, and never the person's.
 *
 * `avoid` is the port in this plugin's settings: that address is where the person's ComfyUI
 * lives or will, so the worker neither starts there nor speaks to whatever answers there.
 */
const worker = dedicated({
  storage: alexia.storage,
  own: () => own,
  dir: () => found(),
  avoid: async () => [port(await where())],
  log: (line) => log.info(line),
})

/**
 * Which ComfyUI renders this job.
 *
 * **Planned in this process, it is the one this plugin has always used**: whatever answers at
 * the address in the settings — the person's own if they have it open, on this machine or on
 * another — and otherwise one Alexia starts there. That is the behaviour of a computer with
 * nothing paired, kept exactly.
 *
 * **Sent by another computer, it is the worker's own and nothing else.** See `worker.js`.
 */
async function connect({ here, signal, report }) {
  if (here) {
    // Not running is a thing to fix rather than a thing to report. If it cannot be fixed —
    // no install, another machine, switched off — `reachable` says which, in one sentence. It
    // also plants the starter workflow the first time it succeeds, which is here rather than at
    // boot because this is the first moment ComfyUI is known to be up.
    const state = await reachable(undefined, { signal, report })
    if (!state.ok) throw new Error(state.said)
    return { server: await where(), classes: (signal) => nodes(signal) }
  }
  const up = await worker.ensure({
    signal,
    onProgress: (tick) => report(tick < 20 ? 'Starting ComfyUI' : 'Starting ComfyUI — loading its nodes and models', tick, 0),
  })
  return { server: up.server, classes: (signal) => workerNodes(up.server, signal), tidy: worker.tidy }
}

/** The worker's own node classes, kept for as long as it is the same ComfyUI answering. */
let workerKnown
async function workerNodes(server, signal) {
  if (workerKnown?.server === server && Date.now() - workerKnown.at < 5 * 60_000) return workerKnown.classes
  workerKnown = { server, classes: await classes(server, signal), at: Date.now() }
  return workerKnown.classes
}

compute.operation(RENDER, renderer({ own: () => own, connect }))

/**
 * Which ComfyUI a workflow is installed into, as `library/tools.js` asks it.
 *
 * **The same two answers as `connect`**, for the same reasons: planned here, it is the install
 * this plugin has always used — the one at the address in the settings, if that address is this
 * machine — and sent by another computer, it is the install the worker starts its own ComfyUI
 * from. Either way **`own` is true only for the copy `install.js` put in this plugin's folder**,
 * and that is the only one the library ever installs a node pack or a model into.
 */
async function place({ here, signal, report } = {}) {
  const server = await where()
  const dir = here && !loopback(server) ? undefined : ((await found()) ?? undefined)
  const mine = await installed(own).catch(() => undefined)
  const forget = () => {
    // New packs are new node classes, and a cached list would refuse the workflow that needs them.
    known = undefined
    workerKnown = undefined
  }
  return {
    dir,
    own: Boolean(dir && mine?.dir && resolve(dir) === resolve(mine.dir)),
    server:
      here ?
        async (asked = signal) => {
          const up = await reachable(undefined, { signal: asked, report })
          if (!up.ok) throw new Error(up.said)
          return server
        }
      : async (asked = signal) => (await worker.ensure({ signal: asked })).server,
    running: here ? async (asked = signal) => ((await awake(server, asked)) ? server : undefined) : async (asked = signal) => (await worker.running(asked))?.server,
    // A restart, as this plugin does one: stopped now, and started by the next thing that needs it.
    release: async () => {
      forget()
      await worker.release().catch(() => {})
      await letGo().catch(() => {})
    },
    card: async () => {
      const card = await nvidia().catch(() => undefined)
      return card ? { total: card.vram, name: card.name } : undefined
    },
  }
}

/** The workflow library — by task, installed with what it needs, picked by what was asked. */
const librarian = library({
  alexia,
  compute,
  place,
  classes,
  fromWeb,
  comfy: async () => comfyRequirement(await comfyStatus({ own })),
})

/**
 * Give back a ComfyUI that Alexia started for this computer's own pictures.
 *
 * **Only a ComfyUI Alexia started is stopped** — the same two conditions `stop_comfyui` uses,
 * because one somebody opened themselves is not Alexia's to close.
 */
async function letGo() {
  const mine = await alexia.storage.get('started').catch(() => undefined)
  if (!mine?.pid || !alive(mine.pid)) return false
  if (!(await awake(await where()))) {
    await alexia.storage.remove('started').catch(() => {})
    return false
  }
  if (!(await stop(mine.pid))) return false
  await alexia.storage.remove('started').catch(() => {})
  await bind()
  return true
}

/**
 * The worker's lifecycle, as core runs it on a computer somebody paired (`worker.js`).
 *
 * `setup` reads and starts nothing; `install` is the only one that downloads, and only what
 * its requirement named; `prepare` starts the worker's ComfyUI; `release` stops it, which is
 * what returns the model memory. None of them reaches a ComfyUI the person started.
 */
/** The setup list as it was before the library: ComfyUI, then one model. */
async function basics() {
  const dir = await found()
    // No ComfyUI anywhere: Alexia's own copy, with its size, where one can be installed here.
  if (!dir) return [comfyRequirement(await comfyStatus({ own }))].filter(Boolean)
  const up = await worker.running().catch(() => undefined)
  // ComfyUI is the authority on what it has when it is running. When it is not, the disk
  // is read instead: drawing a list is not a reason to start a program.
  if (!up) return requirements({ dir, installed: await onDisk([dir, own]) })
  return requirements({
    dir,
    installed: await checkpoints(up.server),
    card: vram(await stats(up.server).catch(() => undefined)) ?? null,
  })
}

alexia.computeHooks({
  // Then every workflow somebody asked for from another computer, each with its size.
  setup: async () => [...(await basics()), ...(await librarian.requirements().catch(() => []))],
  install: async (requirementId, ctx) => {
    if (await librarian.install(requirementId, ctx)) return
    if (requirementId === COMFYUI) {
      const onProgress = (done, total, text) => alexia.progress(ctx, done, total, text)
      await installComfy({ own, signal: ctx?.mcpReq?.signal, onProgress })
      // A search that found nothing was remembered; there is something to find now.
      where_it_is = undefined
      return
    }
    await fetchRequirement(requirementId, {
      own,
      signal: ctx?.mcpReq?.signal,
      onProgress: (done, total, text) => alexia.progress(ctx, done, total, text),
    })
    // ComfyUI reads its model folders when it starts, so one that was already running is let
    // go of here and the next job starts one that can see what just arrived.
    await worker.release().catch(() => {})
  },
  prepare: async (cap) => {
    // Reading the library is a list, and a list is not a reason to start a program.
    if (cap === LIBRARY) return
    await worker.ensure()
  },
  release: async () => {
    await worker.release().catch(() => {})
    await letGo().catch(() => {})
  },
})

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
      if (await letGo()) log.info('a new conversation started, so the ComfyUI Alexia started was stopped')
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
  // A model chosen on the settings screen is newer than the one remembered from the last picture.
  if ('checkpoint' in changed) void mind.forgetModel()
  if ('server' in changed || 'checkpoint' in changed || 'path' in changed || 'autostart' in changed) void bind()
})
log.info(`${alexia.manifest.name} is ready`)
