// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The workflow somebody gets before they have built one.
 *
 * **It is a file rather than a graph built in code, and that is the point.** `comfy.js:graph()`
 * held the only pipeline this plugin knew, in JavaScript, where nobody could look at it and
 * nothing could edit it. A person who wants to know what Alexia does when they ask for a picture
 * has to be able to open it — so it is written into ComfyUI's own workflows folder like any
 * other, and opening it in the editor is how you find out.
 *
 * **Its nodes are titled, and the titles are the documentation.** `workflows.js` binds a knob to
 * any node its author bothered to title, so the first workflow anybody sees is one whose fields
 * have names — and if they rename *What to make* to *scene*, the field in Alexia is called
 * `scene` the next time it runs. That is the whole convention, taught by example rather than by
 * a paragraph nobody reads.
 *
 * **One definition, two renderings, so they cannot drift.** ComfyUI keeps two formats — the
 * editor's document and the flat map `/prompt` eats — and shipping two hand-written files means
 * shipping the day they disagree. Both are generated from `PIPELINE` below. This is emphatically
 * *not* the `graphToPrompt` this project refused to re-implement (D123): that one converts an
 * arbitrary graph somebody else drew, which is the hard and unsafe problem. This renders one
 * pipeline whose shape is known here, which is arithmetic.
 */

/** What the person is offered, in the order the editor lays widgets out. */
const PIPELINE = {
  1: {
    type: 'CheckpointLoaderSimple',
    title: 'Model',
    pos: [40, 200],
    size: [340, 100],
    widgets: ['ckpt_name'],
    outputs: [
      ['MODEL', 'MODEL'],
      ['CLIP', 'CLIP'],
      ['VAE', 'VAE'],
    ],
  },
  2: {
    type: 'CLIPTextEncode',
    title: 'What to make',
    pos: [420, 60],
    size: [420, 200],
    widgets: ['text'],
    inputs: [['clip', 'CLIP', [1, 1]]],
    outputs: [['CONDITIONING', 'CONDITIONING']],
  },
  3: {
    type: 'CLIPTextEncode',
    title: 'What to avoid',
    pos: [420, 300],
    size: [420, 160],
    widgets: ['text'],
    inputs: [['clip', 'CLIP', [1, 1]]],
    outputs: [['CONDITIONING', 'CONDITIONING']],
  },
  4: {
    type: 'EmptyLatentImage',
    title: 'Size',
    pos: [420, 500],
    size: [340, 110],
    widgets: ['width', 'height', 'batch_size'],
    outputs: [['LATENT', 'LATENT']],
  },
  5: {
    type: 'KSampler',
    pos: [900, 200],
    size: [340, 260],
    // `control_after_generate` sits between `seed` and `steps` in the editor and belongs to no
    // input at all — it is a frontend widget, and it is why an exported seed never changes.
    widgets: ['seed', null, 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
    inputs: [
      ['model', 'MODEL', [1, 0]],
      ['positive', 'CONDITIONING', [2, 0]],
      ['negative', 'CONDITIONING', [3, 0]],
      ['latent_image', 'LATENT', [4, 0]],
    ],
    outputs: [['LATENT', 'LATENT']],
  },
  6: {
    type: 'VAEDecode',
    pos: [1300, 200],
    size: [220, 60],
    widgets: [],
    inputs: [
      ['samples', 'LATENT', [5, 0]],
      ['vae', 'VAE', [1, 2]],
    ],
    outputs: [['IMAGE', 'IMAGE']],
  },
  // Node 6 becomes this one when the full-precision decode is asked for. **SDXL's own VAE
  // overflows in fp16 on a lot of 8 GB cards and the symptom is a black image with no error
  // anywhere**, which is among the least debuggable failures in this project — the lesson is
  // older than this file and moving the pipeline into a workflow must not lose it. Decoding in
  // tiles keeps peak memory to a tile rather than the whole image. Every one of those four
  // numbers is *required* by the node, and a graph missing one is refused outright with a 400.
  '6-tiled': {
    type: 'VAEDecodeTiled',
    pos: [1300, 200],
    size: [260, 150],
    widgets: ['tile_size', 'overlap', 'temporal_size', 'temporal_overlap'],
    inputs: [
      ['samples', 'LATENT', [5, 0]],
      ['vae', 'VAE', [1, 2]],
    ],
    outputs: [['IMAGE', 'IMAGE']],
  },
  7: {
    type: 'SaveImage',
    pos: [1580, 200],
    size: [340, 300],
    widgets: ['filename_prefix'],
    inputs: [['images', 'IMAGE', [6, 0]]],
    outputs: [],
  },
}

/** What each widget holds, before anybody changes anything. */
export const DEFAULTS = {
  ckpt_name: '',
  text: '',
  width: 768,
  height: 768,
  batch_size: 1,
  seed: 0,
  steps: 12,
  cfg: 7,
  sampler_name: 'dpmpp_2m',
  scheduler: 'karras',
  denoise: 1,
  filename_prefix: 'alexia',
  tile_size: 512,
  overlap: 64,
  temporal_size: 64,
  temporal_overlap: 8,
}

/** The name it is filed under, and the name the person sees in ComfyUI's sidebar. */
export const STARTER = 'Alexia — Picture'

const linked = (value) => Array.isArray(value) && value.length === 2

/**
 * The pipeline, with the decode the machine needs.
 *
 * Two nodes are declared for slot 6 and exactly one is ever in the graph — chosen here so that
 * the runnable rendering and the editable one can never disagree about which is wired in.
 */
const shaped = (fp32) => {
  const { '6-tiled': tiled, ...rest } = PIPELINE
  return fp32 ? { ...rest, 6: tiled } : rest
}

/**
 * The runnable rendering: node id → `{class_type, inputs, _meta}`.
 *
 * `_meta.title` carries what the editor would export, which is the node's own title where there
 * is one and the class's display name where there is not — so the binding in `workflows.js` sees
 * exactly what it would see for a workflow a person exported by hand.
 */
export function api({ checkpoint, prompt, negative, width, height, steps, seed, cfg, fp32 = true, display = {} } = {}) {
  const chosen = { ckpt_name: checkpoint, width, height, steps, seed, cfg }
  const built = {}
  for (const [id, node] of Object.entries(shaped(fp32))) {
    const inputs = {}
    for (const name of node.widgets ?? []) {
      if (name === null) continue
      const value = chosen[name] ?? undefined
      inputs[name] = value === undefined ? DEFAULTS[name] : value
    }
    if (node.type === 'CLIPTextEncode') inputs.text = id === '2' ? (prompt ?? '') : (negative ?? '')
    for (const [name, , from] of node.inputs ?? []) inputs[name] = [String(from[0]), from[1]]
    built[id] = { class_type: node.type, inputs, _meta: { title: node.title ?? display[node.type] ?? node.type } }
  }
  return built
}

/**
 * The editable rendering: the document ComfyUI's own editor saves and opens.
 *
 * Positions, sizes and link ids are the editor's furniture — meaningless to `/prompt` and the
 * whole reason the two formats exist. `widgets_values` is a bare array indexed by widget order,
 * which is exactly the fragility that made re-implementing the reverse direction a trap.
 */
export function editor(values = {}, { fp32 = true } = {}) {
  const pipeline = shaped(fp32)
  const nodes = []
  const links = []
  let link = 0
  for (const [id, node] of Object.entries(pipeline)) {
    for (const [, type, from] of node.inputs ?? []) {
      if (!linked(from)) continue
      link += 1
      links.push([link, Number(from[0]), from[1], Number(id), (node.inputs ?? []).findIndex(([, , f]) => f === from), type])
    }
  }
  let seen = 0
  for (const [id, node] of Object.entries(pipeline)) {
    const mine = links.filter((one) => one[3] === Number(id))
    nodes.push({
      id: Number(id),
      type: node.type,
      pos: node.pos,
      size: node.size,
      flags: {},
      order: seen++,
      mode: 0,
      ...(node.title ? { title: node.title } : {}),
      inputs: (node.inputs ?? []).map(([name, type], at) => ({
        name,
        type,
        link: mine.find((one) => one[4] === at)?.[0] ?? null,
      })),
      outputs: (node.outputs ?? []).map(([name, type], at) => ({
        name,
        type,
        links: links.filter((one) => one[1] === Number(id) && one[2] === at).map((one) => one[0]),
      })),
      properties: { 'Node name for S&R': node.type },
      widgets_values: (node.widgets ?? []).map((name) =>
        // The null slot is `control_after_generate`, which has no input behind it. `randomize`
        // is what makes the editor re-roll, and what an API export silently drops.
        name === null ? 'randomize' : (values[name] ?? DEFAULTS[name]),
      ),
    })
  }
  return {
    id: 'alexia-starter',
    revision: 0,
    last_node_id: Math.max(...Object.keys(pipeline).map(Number)),
    last_link_id: link,
    nodes,
    links,
    groups: [],
    config: {},
    extra: {},
    version: 0.4,
  }
}
