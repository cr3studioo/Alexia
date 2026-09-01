// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { outputs } from '../comfy.js'
import { apply, isApi, knobs, missing, pair, read, reseed, saved, slug, titled, write } from '../workflows.js'

/**
 * `Photo Reference (Pose + Style)`, as ComfyUI would export it for the API — trimmed to the
 * nodes that decide something, with every title exactly as it is saved on the machine this was
 * written for. It is the shape of the fixture that matters: **`_meta.title` is on every node**,
 * whether a person typed one or not, so four of these are the author's words and five are the
 * class's own display name, and nothing but `/object_info` can tell them apart.
 */
const PHOTO = {
  2: {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'hassakuXLIllustrious_v22.safetensors' },
    _meta: { title: 'Load Model' },
  },
  4: { class_type: 'CLIPTextEncode', inputs: { text: ['22', 0], clip: ['17', 1] }, _meta: { title: 'CLIP Text Encode (Prompt)' } },
  11: { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 }, _meta: { title: 'Empty Latent Image' } },
  12: {
    class_type: 'KSampler',
    inputs: {
      seed: 90212,
      steps: 28,
      cfg: 6.5,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 1,
      model: ['17', 0],
      positive: ['10', 0],
      negative: ['10', 1],
      latent_image: ['11', 0],
    },
    _meta: { title: 'KSampler' },
  },
  14: { class_type: 'PreviewImage', inputs: { images: ['13', 0] }, _meta: { title: 'Preview Image' } },
  18: { class_type: 'PrimitiveStringMultiline', inputs: { value: '' }, _meta: { title: '✏️ PLAIN ENGLISH — describe what you want' } },
  19: {
    class_type: 'PrimitiveStringMultiline',
    inputs: { value: 'bartolomeobari, rebecca, bighand, 1girl, solo' },
    _meta: { title: 'Fixed tags (triggers/character — always kept)' },
  },
  22: {
    class_type: 'StringConcatenate',
    inputs: { string_a: ['19', 0], string_b: ['21', 0], delimiter: ', ' },
    _meta: { title: 'Concatenate' },
  },
  23: { class_type: 'ShowText|pysssss', inputs: { text: ['22', 0] }, _meta: { title: 'Final prompt (fixed tags + generated)' } },
}

const CHECKPOINTS = ['CyberRealisticPony_V18.0_F16.safetensors', 'hassakuXLIllustrious_v22.safetensors']

/** `/object_info`, cut to what binding actually reads: the display name and the input types. */
const CLASSES = {
  CheckpointLoaderSimple: { name: 'CheckpointLoaderSimple', display_name: 'Load Checkpoint', input: { required: { ckpt_name: [CHECKPOINTS] } } },
  CLIPTextEncode: { name: 'CLIPTextEncode', display_name: 'CLIP Text Encode (Prompt)', input: { required: { text: ['STRING', { multiline: true }] } } },
  EmptyLatentImage: {
    name: 'EmptyLatentImage',
    display_name: 'Empty Latent Image',
    input: { required: { width: ['INT', { min: 16, max: 16384 }], height: ['INT', {}], batch_size: ['INT', {}] } },
  },
  KSampler: { name: 'KSampler', display_name: 'KSampler', input: { required: { seed: ['INT', {}], steps: ['INT', {}], cfg: ['FLOAT', {}] } } },
  PreviewImage: { name: 'PreviewImage', display_name: 'Preview Image', input: { required: {} } },
  PrimitiveStringMultiline: { name: 'PrimitiveStringMultiline', display_name: 'String (Multiline)', input: { required: { value: ['STRING', { multiline: true }] } } },
  StringConcatenate: { name: 'StringConcatenate', display_name: 'Concatenate', input: { required: { delimiter: ['STRING', {}] } } },
  'ShowText|pysssss': { name: 'ShowText|pysssss', display_name: 'Show Text 🐍', input: { required: {} } },
}

test('the two formats are told apart by shape, not by filename', () => {
  // *Export* and *Export (API)* are two entries in the same menu and both save a `.json`. The
  // wrong one queues nothing and the error ComfyUI gives for it explains none of that.
  expect(isApi(PHOTO)).toBe(true)
  expect(isApi({ nodes: [{ id: 4, type: 'CLIPTextEncode' }], links: [], version: 0.4 })).toBe(false)
  expect(isApi({})).toBe(false)
  expect(isApi(null)).toBe(false)
  expect(isApi([PHOTO])).toBe(false)
})

test('a title is the author’s only when it is not what the class is already called', () => {
  // The trap: **every** node exports a `_meta.title`, so presence proves nothing. An untitled
  // node carries its display name — `Load Checkpoint`, not `CheckpointLoaderSimple` — which is
  // why this needs `/object_info` and cannot be done on the graph alone.
  expect(titled(PHOTO[12], CLASSES.KSampler)).toBe(false)
  expect(titled(PHOTO[4], CLASSES.CLIPTextEncode)).toBe(false)
  expect(titled(PHOTO[22], CLASSES.StringConcatenate)).toBe(false)
  expect(titled(PHOTO[2], CLASSES.CheckpointLoaderSimple)).toBe(true)
  expect(titled(PHOTO[19], CLASSES.PrimitiveStringMultiline)).toBe(true)
})

test('a knob is named for the part of the title that is a name', () => {
  // Titles are written for somebody reading a canvas, so they carry a step number, a pictogram
  // and a parenthesis explaining themselves. The name is what is left of that.
  expect(slug('✏️ PLAIN ENGLISH — describe what you want')).toBe('plain_english')
  expect(slug('Fixed tags (triggers/character — always kept)')).toBe('fixed_tags')
  expect(slug('3. Load Script (doubling + pauses)')).toBe('load_script')
  expect(slug('1. Your Voice Recording')).toBe('your_voice_recording')
  expect(slug('Load Model')).toBe('load_model')
  expect(slug('Optional: Save Voice (bypassed - set to Always to use)')).toBe('optional_save_voice')
  expect(slug('   ')).toBe('')
})

test('the knobs of a real graph are the nodes its author titled, and nothing else', () => {
  const found = knobs(PHOTO, CLASSES)
  expect(found.map((one) => one.field)).toEqual(['load_model', 'plain_english', 'fixed_tags'])

  // Node 19 is the tags nobody could edit before this existed — the whole point of §2.
  const tags = found.find((one) => one.field === 'fixed_tags')
  expect(tags.node).toBe('19')
  expect(tags.input).toBe('value')
  expect(tags.value).toBe('bartolomeobari, rebecca, bighand, 1girl, solo')

  // A combo's options are the type, and they come from this install rather than a hardcoded
  // list — a node pack that adds a sampler must not be refused by an enum written last year.
  expect(found.find((one) => one.field === 'load_model').options).toEqual(CHECKPOINTS)

  // Two exclusions worth stating out loud. A display node is titled and is not a knob, because
  // everything under it is a link. And `Empty Latent Image` keeps its default title, so 832×1216
  // is *not* exposed: title-binding is the whole rule, and untitled means untouched.
  expect(found.some((one) => one.node === '23')).toBe(false)
  expect(found.some((one) => one.node === '11')).toBe(false)
})

test('a graph is never turned in place', () => {
  const found = knobs(PHOTO, CLASSES)
  const built = apply(PHOTO, found, { fixed_tags: 'rebecca, solo', plain_english: 'a cat on a roof' })
  expect(built[19].inputs.value).toBe('rebecca, solo')
  expect(built[18].inputs.value).toBe('a cat on a roof')
  // Read once, run many times. A run that edited the graph would carry into the next one.
  expect(PHOTO[19].inputs.value).toBe('bartolomeobari, rebecca, bighand, 1girl, solo')
  expect(PHOTO[18].inputs.value).toBe('')
})

test('an export bakes one seed, and running it twice must not return the same picture', () => {
  // `control_after_generate` is a frontend widget and does not survive the export, so the graph
  // carries whatever the editor last showed — 90212 — for ever. Re-rolling is what the editor
  // does; without it the second picture is identical and looks like a cache.
  expect(PHOTO[12].inputs.seed).toBe(90212)
  expect(reseed(PHOTO, 7)[12].inputs.seed).toBe(7)
  expect(PHOTO[12].inputs.seed).toBe(90212)
})

test('a class that is not installed is named before the graph is queued', () => {
  expect(missing(PHOTO, CLASSES)).toEqual([])
  const without = Object.fromEntries(Object.entries(CLASSES).filter(([one]) => one !== 'PreviewImage'))
  expect(missing(PHOTO, without)).toEqual(['PreviewImage'])
})

test('an export is stale when the workflow is newer than it', () => {
  const rows = pair([
    { path: 'Photo Reference.json', modified: 2000 },
    { path: 'Photo Reference.api.json', modified: 3000 },
    { path: 'Simple SDXL + LoRA.json', modified: 5000 },
    { path: 'Simple SDXL + LoRA.api.json', modified: 4000 },
    { path: 'ScriptTTS.json', modified: 1000 },
    { path: 'notes.txt', modified: 9000 },
  ])
  expect(rows.map((one) => one.name)).toEqual(['Photo Reference', 'ScriptTTS', 'Simple SDXL + LoRA'])
  expect(rows.find((one) => one.name === 'Photo Reference').stale).toBe(false)
  // Edited at 5000, exported at 4000: the export is a picture of an older graph, and running it
  // returns something that looks entirely correct. This comparison is the only thing that knows.
  expect(rows.find((one) => one.name === 'Simple SDXL + LoRA').stale).toBe(true)
  // Never exported is not stale — it is a different sentence with a different fix.
  expect(rows.find((one) => one.name === 'ScriptTTS').stale).toBe(false)
  expect(rows.find((one) => one.name === 'ScriptTTS').export).toBeUndefined()
})

test('a run’s outputs are read by shape, so audio comes back as readily as a picture', () => {
  const made = outputs({
    outputs: {
      14: { images: [{ filename: 'ComfyUI_0001.png', subfolder: '', type: 'output' }] },
      6: { audio: [{ filename: 'script.mp3', subfolder: 'audio', type: 'output' }] },
      23: { text: ['1girl, solo, mint green hair'] },
    },
  })
  // In node-id order, which is the graph's own, rather than in the order the kinds are listed.
  expect(made.files.map((one) => one.filename)).toEqual(['script.mp3', 'ComfyUI_0001.png'])
  expect(made.text).toEqual(['1girl, solo, mint green hair'])
  expect(outputs({ outputs: {} })).toEqual({ files: [], text: [] })
})

/**
 * The userdata round trip, against a server that answers the way `app/user_manager.py` does.
 *
 * Two things are being held here and neither is provable by reading. **A workflow name is not a
 * URL** — the ones on this machine carry spaces, brackets and a `+` — and the path is one
 * `encodeURIComponent` of the whole relative path, which is what ComfyUI's own frontend sends.
 * That was checked against aiohttp 3.14.1 out of ComfyUI's own venv before this was written: the
 * encoded slash routes, and the handler is given it decoded.
 */
let comfy
let at
const wrote = new Map()

beforeAll(async () => {
  comfy = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/userdata' && url.searchParams.get('dir') === 'workflows') {
      const files = [
        { path: 'Photo Reference (Pose + Style).json', size: 13026, modified: 1000 },
        { path: 'Photo Reference (Pose + Style).api.json', size: 4096, modified: 2000 },
        ...[...wrote.keys()].map((path) => ({ path: path.replace(/^workflows\//, ''), size: 1, modified: 9000 })),
      ]
      response.writeHead(200, { 'content-type': 'application/json' })
      return response.end(JSON.stringify(files))
    }
    const file = decodeURIComponent(url.pathname.slice('/userdata/'.length))
    if (request.method === 'POST') {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      return request.on('end', () => {
        wrote.set(file, Buffer.concat(chunks).toString('utf8'))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ path: file, size: 1, modified: 9000 }))
      })
    }
    if (file === 'workflows/Photo Reference (Pose + Style).api.json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      return response.end(JSON.stringify(PHOTO))
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('File not found')
  })
  await new Promise((resolve) => comfy.listen(0, '127.0.0.1', resolve))
  at = `http://127.0.0.1:${comfy.address().port}`
})

afterAll(() => new Promise((resolve) => comfy.close(resolve)))

test('workflows are listed, read and written over ComfyUI’s own API, names and all', async () => {
  const rows = await saved(at)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ name: 'Photo Reference (Pose + Style)', stale: false })

  // The row already carries the path the other routes take, which is the bug this holds shut:
  // the listing is relative to `workflows/` and every other route is relative to the user root.
  expect(rows[0].export).toBe('workflows/Photo Reference (Pose + Style).api.json')
  const graph = await read(at, rows[0].export)
  expect(isApi(graph)).toBe(true)
  expect(knobs(graph, CLASSES).map((one) => one.field)).toEqual(['load_model', 'plain_english', 'fixed_tags'])

  await write(at, 'workflows/Simple SDXL + LoRA.api.json', JSON.stringify(PHOTO))
  expect(JSON.parse(wrote.get('workflows/Simple SDXL + LoRA.api.json'))[19].inputs.value).toContain('bartolomeobari')
  expect((await saved(at)).map((one) => one.name)).toContain('Simple SDXL + LoRA')
})

test('a file that is not there says so in ComfyUI’s own words', async () => {
  await expect(read(at, 'workflows/nothing.api.json')).rejects.toThrow(/404.*File not found/s)
})
