// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { Buffer } from 'node:buffer'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { checkpoints, classes, download, graph, interrupt, named, pick, queue, wait } from './comfy.js'
import { alive, awake, install, loopback, port, ready, start, stop, tail } from './launch.js'
import { API_SUFFIX, FOLDER, apply, isApi, knobs, missing, read, reseed, saved, write } from './workflows.js'

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
    const found = await awaiting(server, id, {
      signal,
      onProgress: (message, tick) => alexia.progress(ctx, tick, 0, message),
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
    await bind(signal)
    return {
      content: [
        { type: 'text', text: `Made here, with ${checkpoint}.` },
        // The picture itself, not its path. The answer to *make me an image* used to open
        // with the filename — correct, nothing a person could press, and read straight back
        // to them by a model that could not see the difference. It is a row under the answer
        // now, on the window or as a photo over a channel, and the model is told only that.
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
  return state.ok ? state : await wake(signal, ctx)
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
    const id = await queue(server, built, 'alexia', signal)
    const made = await awaiting(server, id, {
      signal,
      expect: 'output',
      onProgress: (message, tick) => alexia.progress(ctx, tick, 0, message),
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
    // The whole point of this tool is that the wrong export is easy to make: *Export* and
    // *Export (API)* sit next to each other in the same menu and both save a `.json`. Told apart
    // by shape, which is a fact about the file, rather than by which menu entry it came from.
    if (!isApi(doc)) {
      return refuse(
        `${basename(path)} is the editor’s own save rather than an API export — it has nodes and links in it ` +
          'where an API export has node ids and class names. In ComfyUI these are two entries in the same menu: ' +
          'the one to use is Workflow → Export (API).',
      )
    }
    const state = await reachable(ctx)
    if (!state.ok) return refuse(state.said)
    const server = await where()

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
  // A different address is a different install, with its own node packs. Nothing about the one
  // that was cached is true of it, and a workflow bound against the wrong one binds silently.
  if ('server' in changed) known = undefined
  if ('server' in changed || 'checkpoint' in changed || 'path' in changed || 'autostart' in changed) void bind()
})
log.info(`${alexia.manifest.name} is ready`)
