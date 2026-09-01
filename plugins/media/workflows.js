// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The workflows somebody built in ComfyUI, and the knobs on them.
 *
 * **Two JSON formats look alike and only one of them runs.** What the editor saves is its own
 * document — `nodes`, `links`, `groups`, `widgets_values`, positions and all. What
 * `POST /prompt` eats is a flat map of node id to `{class_type, inputs}`, every input either a
 * literal or a `[node_id, slot]` pair. ComfyUI converts between them in `graphToPrompt`, in its
 * TypeScript frontend, and **never over HTTP** — every `@routes` handler in `server.py` and
 * `app/user_manager.py` was read looking for it.
 *
 * So this file does not convert. It consumes the export ComfyUI already writes —
 * *Workflow → Export (API)* — and lets the frontend, the only thing that has ever known how to
 * do this correctly, do the conversion. Re-implementing it was worked through against the
 * graphs it would be built for and fails on three of them: `Power Lora Loader (rgthree)` stores
 * an array of *objects* where widget order says scalars, `LoRA Stacker` has a widget count
 * driven by another widget so the array length is not derivable from `/object_info` at all, and
 * a bypassed node must be removed *and its links bridged through matching types* or the graph
 * comes apart. A converter that handles the plain cases and fails on those is worse than none,
 * because it fails silently and specifically on the interesting graphs.
 *
 * **The cost of asking for the export is that it goes stale**, and a stale export makes a
 * picture rather than an error, which is the one failure nothing downstream can catch. `pair`
 * is the whole defence: ComfyUI's own listing carries the modified time of every file, so
 * *which of these two is newer* is arithmetic rather than a guess.
 *
 * Nothing here touches the filesystem. Exports live beside the workflows they came from, in
 * ComfyUI's own user directory, read and written over `GET`/`POST /userdata/{file}` — so the
 * only capability any of it needs is the `net.request` this plugin already has.
 */

/** `Foo.json` is what the editor saves. `Foo.api.json` is the one that runs. */
export const API_SUFFIX = '.api.json'

/** Where ComfyUI keeps them, relative to the user directory. Its own default, not ours. */
export const FOLDER = 'workflows'

const url = (server, path) => `${server}/userdata/${encodeURIComponent(path)}`

/**
 * The userdata routes answer plain text, not the `node_errors` JSON `/prompt` answers with, so
 * the body is the sentence — *File not found*, *Invalid directory* — and it is worth having.
 */
async function body(response, doing) {
  if (response.ok) return response
  const said = await response.text().catch(() => '')
  throw new Error(`ComfyUI answered ${response.status} ${doing}${said ? ` — ${said.trim()}` : ''}`)
}

/**
 * Pair each workflow with its export.
 *
 * One listing carries both, because they live in the same folder and differ only by suffix. A
 * workflow with no export cannot run; an export whose workflow was edited afterwards runs and
 * is wrong. Both of those are states to report rather than errors to throw.
 */
export function pair(files) {
  const found = new Map()
  for (const one of files) {
    const path = String(one?.path ?? one ?? '')
    const lower = path.toLowerCase()
    if (!lower.endsWith('.json')) continue
    const exported = lower.endsWith(API_SUFFIX)
    const name = path.slice(0, -(exported ? API_SUFFIX.length : '.json'.length))
    const row = found.get(name) ?? { name }
    if (exported) {
      row.export = path
      row.exportedAt = Number(one?.modified) || 0
    } else {
      row.workflow = path
      row.editedAt = Number(one?.modified) || 0
    }
    found.set(name, row)
  }
  return [...found.values()]
    .map((row) => ({
      ...row,
      stale: row.export !== undefined && row.workflow !== undefined && row.editedAt > row.exportedAt,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Everything saved under `workflows/`, paired. An install with none is not an error.
 *
 * The listing is relative to the folder that was asked for and every other route is relative to
 * the user directory, so the prefix goes back on here — a `path` on one of these rows is a path
 * `read` and `write` accept, and nowhere else has to remember which of the two it is holding.
 */
export async function saved(server, signal) {
  const response = await fetch(`${server}/userdata?dir=${FOLDER}&recurse=true&full_info=true`, { signal })
  if (response.status === 404) return []
  return pair(await (await body(response, 'listing your workflows')).json()).map((row) => ({
    ...row,
    workflow: row.workflow && `${FOLDER}/${row.workflow}`,
    export: row.export && `${FOLDER}/${row.export}`,
  }))
}

/** Read one file out of the user directory. */
export async function read(server, path, signal) {
  return (await body(await fetch(url(server, path), { signal }), `reading ${path}`)).json()
}

/**
 * Delete one file out of the user directory (`app/user_manager.py:418`).
 *
 * A missing file is a success rather than an error: removing a workflow deletes both halves of
 * a pair, and a pair with only one half on disk is the ordinary case — an export with no
 * workflow beside it, or the other way round.
 */
export async function remove(server, path, signal) {
  const response = await fetch(url(server, path), { method: 'DELETE', signal })
  if (response.status === 404) return false
  await body(response, `deleting ${path}`)
  return true
}

/** Write one file into the user directory. ComfyUI writes a temp file and renames over it. */
export async function write(server, path, text, signal) {
  await body(
    await fetch(`${url(server, path)}?full_info=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: text,
      signal,
    }),
    `saving ${path}`,
  )
  return path
}

/**
 * Is this the format that runs?
 *
 * The two are told apart by shape rather than by filename, because a filename is a convention
 * somebody has to follow and the shape is a fact. An editor document has `nodes` as an *array*
 * and its other top-level values are numbers and objects carrying no `class_type`; an API graph
 * is nothing but node ids pointing at classes.
 */
export function isApi(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false
  const nodes = Object.values(doc)
  return (
    nodes.length > 0 && nodes.every((node) => node !== null && typeof node === 'object' && typeof node.class_type === 'string')
  )
}

/** A `[node_id, slot]` pair — something another node produces, and never a knob. */
const linked = (value) =>
  Array.isArray(value) &&
  value.length === 2 &&
  (typeof value[0] === 'string' || typeof value[0] === 'number') &&
  typeof value[1] === 'number'

/**
 * Which classes this graph needs that are not installed.
 *
 * Cheap, and it turns *ComfyUI answered 400* into *this workflow needs `IPAdapterAdvanced`,
 * which is not installed*. One uninstalled node pack is all it takes, and it is the same class
 * of error that cost a day when `VAEDecodeTiled` turned out to require four inputs.
 */
export function missing(graph, classes) {
  return [...new Set(Object.values(graph).map((node) => String(node?.class_type ?? '')))]
    .filter((one) => one !== '' && !(one in (classes ?? {})))
    .sort()
}

/**
 * The name a knob goes by, from the title its author gave the node.
 *
 * Titles are written for a person reading a canvas, so they carry a step number, a pictogram
 * and a parenthesis explaining themselves — *"3. Load Script (doubling + pauses)"*. The name is
 * the part before the explanation: everything up to the first bracket or dash, with whatever
 * comes before the first letter dropped, which takes the number and the pictogram with it. The
 * whole title survives as the field's description, so nothing is lost, only shortened.
 */
export function slug(title) {
  return String(title ?? '')
    .split(/[(—–[]| - /u)[0]
    .replace(/^[^\p{L}]+/u, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/, '')
}

/**
 * Has a person titled this node, or is that just what the class is called?
 *
 * **API format carries `_meta.title` on every node**, whether or not anybody typed one:
 * untitled nodes export the class's own display name. So presence proves nothing and the test
 * is *different from what it would have been* — which needs `/object_info`, because the default
 * is the display name (`Load Checkpoint`) rather than the class name (`CheckpointLoaderSimple`).
 */
export function titled(node, spec) {
  const said = String(node?._meta?.title ?? '').trim()
  if (said === '') return false
  const same = (other) => String(other ?? '').trim().toLowerCase() === said.toLowerCase()
  return !same(node?.class_type) && !same(spec?.display_name) && !same(spec?.name)
}

/** What `/object_info` says an input takes, in the three shapes a tool schema has. */
function shape(spec, input) {
  const declared = spec?.input?.required?.[input] ?? spec?.input?.optional?.[input]
  const kind = Array.isArray(declared) ? declared[0] : declared
  const opts = (Array.isArray(declared) ? declared[1] : undefined) ?? {}
  // A list where a type name would be is ComfyUI's combo, and the options *are* the type. This
  // is why a sampler or scheduler list must never be hardcoded: a custom node pack adds its own
  // and a frozen enum would refuse a value this install accepts.
  //
  // **There are two spellings and both are live on one install.** Older nodes put the list where
  // the type goes; V3 nodes say `COMBO` and move the list into the options. Reading only the
  // first meant a V3 node's field came back as free text with no list behind it — which looks
  // like it works and quietly stops validating what somebody typed.
  if (Array.isArray(kind)) return { type: 'string', options: kind.map(String) }
  if (String(kind ?? '').toUpperCase() === 'COMBO' && Array.isArray(opts.options)) {
    return { type: 'string', options: opts.options.map(String) }
  }
  const named = String(kind ?? '').toUpperCase()
  if (named === 'INT' || named === 'FLOAT') return { type: 'number', min: opts.min, max: opts.max }
  if (named === 'BOOLEAN') return { type: 'boolean' }
  return { type: 'string', multiline: opts.multiline === true }
}

/**
 * The knobs on a graph: every settable input of every node its author bothered to title.
 *
 * *A node the person named is a node the person meant*, and that reading was checked against
 * the workflows this was built for rather than assumed. In `Photo Reference (Pose + Style)`
 * sixteen of twenty nodes keep their default title and the four that do not are exactly the
 * knobs — the checkpoint, the plain-English box, the fixed tags, and the display showing what
 * the two became. `Simple SDXL + LoRA` carries three of those titles word for word. The
 * alternative was an `alexia:` prefix, unambiguous and requiring every knob of every workflow
 * to be re-titled before any of them could run.
 *
 * A titled node with nothing but links under it — a display, a preview — has no knob and is
 * skipped, which is what keeps *"Final prompt (fixed tags + generated)"* out of the schema.
 */
export function knobs(graph, classes) {
  const found = []
  for (const [node, one] of Object.entries(graph ?? {})) {
    const spec = classes?.[one?.class_type]
    if (!titled(one, spec)) continue
    for (const [input, value] of Object.entries(one?.inputs ?? {})) {
      if (linked(value)) continue
      found.push({ node, input, title: String(one._meta.title).trim(), value, ...shape(spec, input) })
    }
  }
  return named(found)
}

/**
 * One name per knob, and every one of them unique.
 *
 * A node with a single settable input is called by its title alone, because that is the word
 * its author chose and `fixed_tags` reads better than `fixed_tags_value`. A node with several
 * needs the input name to tell them apart, and two nodes that still collide get the node id,
 * which is the only thing in a graph guaranteed not to repeat.
 */
function named(found) {
  const base = found.map((one) => {
    const from = slug(one.title)
    const alone = found.filter((other) => other.node === one.node).length === 1
    return alone && from ? from : [from, one.input].filter(Boolean).join('_')
  })
  return found.map((one, i) => ({
    ...one,
    field: base.filter((other) => other === base[i]).length > 1 ? `${base[i]}_${one.node}` : base[i],
  }))
}

const coerce = (value, type) =>
  type === 'number' ? Number(value)
  : type === 'boolean' ? value === true || value === 'true'
  : String(value)

/**
 * The graph with the knobs turned. The original is never touched — a graph is read once and run
 * many times, and a run that mutated it would carry into the next one.
 */
/**
 * The prompt boxes, worked out from the graph's own wiring rather than from anybody's titles.
 *
 * **D128 is right and this does not weaken it.** A field is offered because its author named
 * the box, because a title is how an author says *this is the knob* — and that is what
 * {@link knobs} does. But ComfyUI's own catalogue templates rename nothing, so every one of
 * them arrives with no fields at all and runs with whatever prompt its author baked in. That
 * makes *install this and run it against what I asked for* impossible for the entire
 * catalogue, which is the one journey D137's `install_workflow` exists to serve.
 *
 * So this is the fallback, and it is a derivation rather than a guess:
 *
 *  - **A sampler is a node taking both a `positive` and a `negative` conditioning link.** That
 *    is read off the graph's shape, not off a list of class names — a hardcoded `KSampler`
 *    would miss every custom sampler, and this install has several.
 *  - **Which is which is stated by the node that consumes them**, so nothing has to be inferred
 *    from the words inside the box.
 *  - **The text box is found by its declared type** — `STRING` with `multiline` — out of
 *    `/object_info`, the same source {@link knobs} reads for everything else.
 *
 * **Every uncertainty returns nothing rather than a guess.** Two samplers and it cannot say
 * which pipeline somebody meant; a conditioning node with no text box, or with two, and it
 * cannot say which one carries the prompt. Offering the wrong box would put somebody's words
 * into a field that changes nothing, which is the failure that looks like it worked.
 */
export function wired(graph, classes) {
  const samplers = Object.entries(graph ?? {}).filter(
    ([, one]) => linked(one?.inputs?.positive) && linked(one?.inputs?.negative),
  )
  if (samplers.length !== 1) return []
  const [, sampler] = samplers[0]
  const found = []
  for (const [slot, field, title] of [
    ['positive', 'prompt', 'What to make'],
    ['negative', 'avoid', 'What to avoid'],
  ]) {
    const at = String(sampler.inputs[slot][0])
    const node = graph?.[at]
    if (!node) continue
    const spec = classes?.[node.class_type]
    const boxes = Object.entries(node.inputs ?? {}).filter(
      ([input, value]) => !linked(value) && typeof value === 'string' && shape(spec, input).multiline === true,
    )
    if (boxes.length !== 1) continue
    found.push({ node: at, input: boxes[0][0], field, title, value: boxes[0][1], type: 'string', multiline: true })
  }
  /**
   * The checkpoint, by walking the sampler's model chain to whatever chooses a file.
   *
   * **A catalogue template names a model this machine almost certainly does not have.** SDXL
   * Turbo asks for `sd_xl_turbo_1.0_fp16.safetensors`; this card holds six other checkpoints and
   * none of them is that, so the install succeeds and the run dies on a 400 from ComfyUI. Being
   * able to point it at a model you own is the difference between a shelf and a list.
   *
   * The walk is the graph's own: follow `model` while it is a link, because that is how LoRA and
   * patch loaders chain, and stop at the node that has a combo input instead. A combo's options
   * come from `/object_info`, so what is offered is what this install actually has — which is
   * also why the list is never hardcoded (D134 found two spellings of it live on one machine).
   */
  let at = sampler.inputs.model
  const seen = new Set()
  while (linked(at) && !seen.has(String(at[0]))) {
    const id = String(at[0])
    seen.add(id)
    const node = graph?.[id]
    if (!node) break
    const spec = classes?.[node.class_type]
    const combos = Object.entries(node.inputs ?? {}).filter(
      ([input, value]) => !linked(value) && Array.isArray(shape(spec, input).options),
    )
    if (combos.length === 1) {
      found.push({
        node: id,
        input: combos[0][0],
        field: 'model',
        title: 'Model',
        value: combos[0][1],
        ...shape(spec, combos[0][0]),
      })
      break
    }
    // More than one file to choose and no way to say which is the checkpoint, so it says none.
    if (combos.length > 1) break
    at = node.inputs?.model
  }

  // **Without the positive box there is nothing worth offering.** Handing back `avoid` alone
  // says the workflow can be steered when the thing it makes cannot be — somebody sets what to
  // avoid, the baked-in prompt runs anyway, and the result looks like the field was ignored.
  return found.some((one) => one.field === 'prompt') ? found : []
}

export function apply(graph, found, values) {
  const built = structuredClone(graph)
  for (const knob of found) {
    if (!Object.hasOwn(values ?? {}, knob.field)) continue
    built[knob.node].inputs[knob.input] = coerce(values[knob.field], knob.type)
  }
  return built
}

/**
 * Every seed in the graph, set to one number.
 *
 * **An export bakes the seed the editor happened to be showing.** The editor's own
 * `control_after_generate` — *randomize*, on every one of these workflows — is a frontend widget
 * and does not survive the export, so a graph run twice returns the identical picture and looks
 * like a cache. Re-rolling by default is what the editor does; a seed that was asked for wins
 * over it, which is what makes a picture repeatable when somebody wants that.
 */
export function reseed(graph, seed) {
  const built = structuredClone(graph)
  for (const node of Object.values(built)) {
    for (const input of ['seed', 'noise_seed']) {
      if (Object.hasOwn(node?.inputs ?? {}, input) && !linked(node.inputs[input])) node.inputs[input] = seed
    }
  }
  return built
}
