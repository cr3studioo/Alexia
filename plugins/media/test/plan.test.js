// SPDX-License-Identifier: AGPL-3.0-only
import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest'
import { STARTER } from '../starter.js'

/**
 * The planner, end to end: the real `index.js`, a fake Alexia around it and a fake ComfyUI in
 * front of it.
 *
 * What is being proved is the part of a picture that belongs to the person — which workflow a
 * plain request means, which model, what they set an hour ago, which seed *same seed* is, and
 * which file *this photo* is — so the plugin is loaded whole and its tools are called the way
 * core calls them. Nothing is rendered and nothing is downloaded: ComfyUI is a few routes that
 * answer the way it does and write down what they were asked. With no compute in this fake
 * core, every render runs in the planner's own process, which is what a computer with nothing
 * paired does.
 */

// The canonical spelling, as the code under test reads paths back: Windows' temp folder comes in a short 8.3 form.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'alexia-media-plan-')))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
const closing = []
afterEach(async () => {
  while (closing.length > 0) await closing.pop()()
})

/** `/object_info`, as much of it as binding reads. */
const CLASSES = {
  CheckpointLoaderSimple: { display_name: 'Load Checkpoint', input: { required: { ckpt_name: [[]] } } },
  CLIPTextEncode: { display_name: 'CLIP Text Encode (Prompt)', input: { required: { text: ['STRING', { multiline: true }] } } },
  EmptyLatentImage: { display_name: 'Empty Latent Image', input: { required: { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] } } },
  KSampler: {
    display_name: 'KSampler',
    input: { required: { seed: ['INT', {}], steps: ['INT', {}], cfg: ['FLOAT', {}], denoise: ['FLOAT', {}], sampler_name: [['euler']], scheduler: [['normal']] } },
  },
  VAEDecode: { display_name: 'VAE Decode', input: { required: {} } },
  VAEDecodeTiled: { display_name: 'VAE Decode (Tiled)', input: { required: {} } },
  VAEEncode: { display_name: 'VAE Encode', input: { required: {} } },
  ImageScale: { display_name: 'Upscale Image', input: { required: {} } },
  PrimitiveFloat: { display_name: 'Float', input: { required: { value: ['FLOAT', {}] } } },
  LoadImage: { display_name: 'Load Image', input: { required: { image: [['example.png']] } } },
  SaveImage: { display_name: 'Save Image', input: { required: { filename_prefix: ['STRING', {}] } } },
}

/** A workflow somebody built and titled: a model, a description, a canvas, a sampler and a reference picture. */
const ANIME = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'anime_v3.safetensors' }, _meta: { title: 'Model' } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: 'baked in', clip: ['1', 1] }, _meta: { title: 'Describe it' } },
  3: { class_type: 'CLIPTextEncode', inputs: { text: 'lowres', clip: ['1', 1] }, _meta: { title: 'CLIP Text Encode (Prompt)' } },
  4: { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 }, _meta: { title: 'Canvas' } },
  5: {
    class_type: 'KSampler',
    inputs: { seed: 5, steps: 28, cfg: 6, denoise: 1, sampler_name: 'euler', scheduler: 'normal', model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] },
    _meta: { title: 'Sampler' },
  },
  6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] }, _meta: { title: 'VAE Decode' } },
  7: { class_type: 'SaveImage', inputs: { filename_prefix: 'x', images: ['6', 0] }, _meta: { title: 'Save Image' } },
  8: { class_type: 'LoadImage', inputs: { image: 'example.png' }, _meta: { title: 'Reference' } },
}

/** ComfyUI as far as these tools reach it, with a userdata folder and a record of what was asked. */
async function comfyui({ checkpoints = ['anime_v3.safetensors', 'photo_v1.safetensors'], workflows = { Anime: ANIME } } = {}) {
  const files = new Map()
  for (const [name, graph] of Object.entries(workflows)) {
    files.set(`${name}.json`, { text: '{}', modified: 1 })
    files.set(`${name}.api.json`, { text: JSON.stringify(graph), modified: 2 })
  }
  const state = { checkpoints, files, queued: [], uploads: [] }
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks)
      const send = (said, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(said))
      }
      const path = decodeURIComponent(url.pathname)
      if (path === '/system_stats') return send({ devices: [{ type: 'cuda', name: 'cuda:0', vram_total: 12e9, vram_free: 11e9 }] })
      if (path === '/object_info/CheckpointLoaderSimple') return send({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [state.checkpoints] } } } })
      if (path === '/object_info') {
        const info = structuredClone(CLASSES)
        info.CheckpointLoaderSimple.input.required.ckpt_name = [state.checkpoints]
        return send(info)
      }
      if (path === '/userdata' && url.searchParams.get('dir') === 'workflows') {
        return send([...state.files.entries()].map(([file, one]) => ({ path: file, modified: one.modified })))
      }
      if (path.startsWith('/userdata/workflows/')) {
        const file = path.slice('/userdata/workflows/'.length)
        if (request.method === 'POST') {
          state.files.set(file, { text: raw.toString('utf8'), modified: Date.now() })
          return send({ path: file })
        }
        if (request.method === 'DELETE') return send({}, state.files.delete(file) ? 204 : 404)
        const one = state.files.get(file)
        if (!one) return send({ error: 'File not found' }, 404)
        response.writeHead(200, { 'content-type': 'application/json' })
        return response.end(one.text)
      }
      if (request.method === 'POST' && path === '/upload/image') {
        const text = raw.toString('latin1')
        const name = /filename="([^"]+)"/.exec(text)?.[1]
        state.uploads.push({ name, body: text })
        return send({ name, subfolder: '', type: 'input' })
      }
      if (request.method === 'POST' && path === '/prompt') {
        state.queued.push(JSON.parse(raw.toString('utf8')).prompt)
        return send({ prompt_id: `job-${state.queued.length}` })
      }
      if (path === '/queue') return send({ queue_running: [], queue_pending: [] })
      if (path.startsWith('/history/')) {
        const id = path.split('/').pop()
        return send({ [id]: { outputs: { 9: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } })
      }
      if (path === '/view') {
        response.writeHead(200, { 'content-type': 'image/png' })
        return response.end(Buffer.from('a picture'))
      }
      response.writeHead(404)
      response.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  closing.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      }),
  )
  return { ...state, server: `http://127.0.0.1:${server.address().port}`, last: () => state.queued.at(-1) }
}

/** Alexia, as far as this plugin reaches it: tools registered, storage kept, no compute anywhere. */
function host(server, own) {
  const tools = new Map()
  const kv = new Map()
  const tables = new Map()
  return {
    tools,
    kv,
    tool: (name, _spec, handler) => {
      tools.set(name, handler)
      return { update: () => {} }
    },
    settings: async () => ({ server, autostart: false, checkpoint: '', steps: 25, vae_fp32: true }),
    status: async () => {},
    progress: () => {},
    file: (path, options) => ({ type: 'resource_link', uri: path, ...options }),
    storage: {
      get: async (key) => structuredClone(kv.get(key)),
      set: async (key, value) => void kv.set(key, structuredClone(value)),
      remove: async (key) => void kv.delete(key),
      insert: async (table, row) => void (tables.get(table) ?? tables.set(table, []).get(table)).push(row),
      select: async (table) => [...(tables.get(table) ?? [])],
    },
    computeOperation: () => {},
    computeHooks: () => {},
    // This core has no compute, which is the one refusal that means *render here*.
    compute: {
      run: async () => {
        throw Object.assign(new Error('MCP error -32050: compute is not available for image.render'), { code: -32050 })
      },
    },
    onConversationEnded: () => {},
    onSettingsChanged: () => {},
    manifest: { name: 'Local media generation' },
    start: async () => {},
    host: async () => ({ paths: { ownDir: own } }),
  }
}

vi.mock('@alexia/sdk', () => ({
  fromJsonSchema: (schema) => schema,
  log: { info: () => {}, warn: () => {}, error: () => {} },
  plugin: () => globalThis.__alexiaMediaHost,
}))

let comfy
let alexia
let picture
let count = 0

/** One tool call, as core makes it. Answers the result and its text, joined. */
const call = async (name, args = {}) => {
  const result = await alexia.tools.get(name)(args, { mcpReq: {} })
  const text = result.content.filter((one) => one.type === 'text').map((one) => one.text).join('\n')
  return { ...result, text }
}

beforeEach(async () => {
  comfy = await comfyui()
  const own = join(root, `own-${++count}`)
  mkdirSync(own, { recursive: true })
  picture = join(root, `cat-${count}.png`)
  writeFileSync(picture, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('a cat, in pixels')]))
  alexia = host(comfy.server, own)
  globalThis.__alexiaMediaHost = alexia
  vi.resetModules()
  await import('../index.js')
})

const seedOf = (graph) => Object.values(graph).find((node) => node.class_type === 'KSampler').inputs.seed

test('a plain request uses the workflow used last, with its prompt on that workflow’s own box', async () => {
  const ran = await call('run_workflow', { workflow: 'anime', values: { sampler_steps: 40 } })
  expect(ran.isError).toBeUndefined()
  expect(alexia.kv.get('remembered')).toMatchObject({ workflow: 'Anime' })

  const made = await call('generate', { prompt: 'a fox in snow' })
  expect(made.isError).toBeUndefined()
  expect(made.text).toMatch(/^Ran Anime\./)
  const graph = comfy.last()
  // The description went into the box the workflow's wiring says is the positive one.
  expect(graph[2].inputs.text).toBe('a fox in snow')
  // And what the person set on this workflow an hour ago is still set.
  expect(graph[5].inputs.steps).toBe(40)
  expect(made.text).toMatch(/sampler_steps = 40 \(kept from before\)/)
})

test('a remembered workflow that is gone falls back to Alexia’s own, and says so', async () => {
  await call('run_workflow', { workflow: 'Anime' })
  comfy.files.delete('Anime.api.json')
  comfy.files.delete('Anime.json')

  const made = await call('generate', { prompt: 'a fox' })
  expect(made.isError).toBeUndefined()
  expect(made.text).toMatch(new RegExp(`Made here with ${STARTER}`))
  expect(made.text).toMatch(/The workflow used last time, Anime, is not saved here any more, so this used Alexia’s own instead\./)
  // The starter's own pipeline, with the words that were asked for.
  expect(Object.values(comfy.last()).some((node) => node.class_type === 'EmptyLatentImage')).toBe(true)
  expect(alexia.kv.get('remembered')).toMatchObject({ workflow: STARTER })
})

test('the model used last is used again, and one that is gone is said and stepped past', async () => {
  await call('generate', { prompt: 'a castle', model: 'photo' })
  expect(alexia.kv.get('remembered')).toMatchObject({ workflow: STARTER, checkpoint: 'photo_v1.safetensors' })

  await call('generate', { prompt: 'a castle at dusk' })
  expect(comfy.last()[1].inputs.ckpt_name).toBe('photo_v1.safetensors')

  comfy.checkpoints.splice(1, 1)
  const made = await call('generate', { prompt: 'a castle at night' })
  expect(made.isError).toBeUndefined()
  expect(comfy.last()[1].inputs.ckpt_name).toBe('anime_v3.safetensors')
  expect(made.text).toMatch(/The model used last time, photo_v1\.safetensors, is not on that computer any more, so anime_v3\.safetensors was used instead\./)
})

test('every result says the settings and the seed it used, and *again* is that seed', async () => {
  const first = await call('generate', { prompt: 'a lighthouse', width: 1024 })
  const seed = seedOf(comfy.last())
  expect(first.text).toMatch(new RegExp(`seed = ${seed}`))
  expect(first.text).toMatch(/model = "anime_v3\.safetensors"; width = 1024; height = 768; steps = 25; negative = "blurry, low quality, watermark, text"/)

  const again = await call('generate', { prompt: 'a lighthouse at night', again: true })
  expect(seedOf(comfy.last())).toBe(seed)
  expect(again.text).toMatch(new RegExp(`Same seed as the last one \\(${seed}\\)`))

  // A saved workflow: the fields as they ran, read back off the graph, and the seed.
  const ran = await call('run_workflow', { workflow: 'Anime', values: { describe_it: 'a fox', canvas_width: 640 } })
  const runSeed = seedOf(comfy.last())
  expect(ran.text).toMatch(/model = "anime_v3\.safetensors"/)
  expect(ran.text).toMatch(/describe_it = "a fox"/)
  expect(ran.text).toMatch(/canvas_width = 640; canvas_height = 1216/)
  expect(ran.text).toMatch(new RegExp(`Seed ${runSeed}\\.`))

  const repeat = await call('run_workflow', { workflow: 'Anime', again: true })
  expect(seedOf(comfy.last())).toBe(runSeed)
  expect(comfy.last()[2].inputs.text).toBe('a fox')
  expect(repeat.text).toMatch(new RegExp(`Same settings and seed as the last run \\(${runSeed}\\)`))

  // A seed named in the call is the seed used, and said back.
  const named = await call('run_workflow', { workflow: 'Anime', seed: 1234 })
  expect(seedOf(comfy.last())).toBe(1234)
  expect(named.text).toMatch(/Seed 1234\./)
})

test('what the person sets is kept per workflow until they change it or ask for the defaults back', async () => {
  await call('run_workflow', { workflow: 'Anime', values: { sampler_steps: 40, model: 'photo' } })
  await call('run_workflow', { workflow: 'Anime' })
  expect(comfy.last()[5].inputs.steps).toBe(40)
  expect(comfy.last()[1].inputs.ckpt_name).toBe('photo_v1.safetensors')

  // Changed: the new value replaces the kept one, and the rest stays.
  await call('run_workflow', { workflow: 'Anime', values: { sampler_steps: 30 } })
  await call('run_workflow', { workflow: 'Anime' })
  expect(comfy.last()[5].inputs.steps).toBe(30)
  expect(comfy.last()[1].inputs.ckpt_name).toBe('photo_v1.safetensors')

  // Kept per workflow: Alexia's own does not inherit Anime's steps.
  await call('generate', { prompt: 'a boat', workflow: 'starter', width: 1024 })
  expect(comfy.last()[5].inputs.steps).toBe(25)
  await call('generate', { prompt: 'a boat again' })
  expect(comfy.last()[4].inputs.width).toBe(1024)

  // One field forgotten, then all of them.
  const one = await call('reset_workflow', { workflow: 'Anime', fields: ['model'] })
  expect(one.text).toMatch(/Anime is back to its own defaults for model\./)
  await call('run_workflow', { workflow: 'Anime' })
  expect(comfy.last()[1].inputs.ckpt_name).toBe('anime_v3.safetensors')
  expect(comfy.last()[5].inputs.steps).toBe(30)

  await call('reset_workflow', { workflow: 'Anime' })
  await call('run_workflow', { workflow: 'Anime' })
  expect(comfy.last()[5].inputs.steps).toBe(28)

  // With no workflow named it is the one used last — Anime, just now, with nothing left to forget.
  expect((await call('reset_workflow', {})).text).toMatch(/Nothing was set on Anime/)
  // Alexia's own: its size goes back to the default.
  const starter = await call('reset_workflow', { workflow: 'starter' })
  expect(starter.text).toMatch(new RegExp(`${STARTER} is back to its own defaults for width`))
  await call('generate', { prompt: 'a boat', workflow: 'starter' })
  expect(comfy.last()[4].inputs.width).toBe(768)
})

test('a picture given to a workflow is uploaded and set on its titled LoadImage node', async () => {
  const ran = await call('run_workflow', { workflow: 'Anime', images: [picture] })
  expect(ran.isError).toBeUndefined()
  expect(comfy.uploads).toHaveLength(1)
  const [upload] = comfy.uploads
  expect(upload.body).toContain('a cat, in pixels')
  // Named by its content, not by the person's file, and with the format its bytes say.
  expect(upload.name).toMatch(/^alexia-[0-9a-f]{20}\.png$/)
  expect(comfy.last()[8].inputs.image).toBe(upload.name)
  // The path as the text prints it: JSON-quoted, so a Windows path's backslashes are doubled.
  expect(ran.text).toContain(`reference = ${JSON.stringify(picture)}`)

  // By field name works too, and a picture is never kept for the next run.
  await call('run_workflow', { workflow: 'Anime', values: { reference: picture } })
  expect(comfy.uploads).toHaveLength(2)
  await call('run_workflow', { workflow: 'Anime' })
  expect(comfy.uploads).toHaveLength(2)
  expect(comfy.last()[8].inputs.image).toBe('example.png')

  // Something that is not a picture is refused before anything is queued.
  const queued = comfy.queued.length
  const refused = await call('run_workflow', { workflow: 'Anime', images: [join(root, 'nothing-here.png')] })
  expect(refused.isError).toBe(true)
  expect(refused.text).toMatch(/There is no file at/)
  expect(comfy.queued).toHaveLength(queued)
})

test('a picture given to a plain request takes the starter’s picture-to-picture path', async () => {
  const made = await call('generate', { prompt: 'the same cat as an oil painting', images: [picture], workflow: 'starter' })
  expect(made.isError).toBeUndefined()
  const graph = comfy.last()
  const [upload] = comfy.uploads
  const loader = Object.entries(graph).find(([, node]) => node.class_type === 'LoadImage')
  expect(loader[1].inputs.image).toBe(upload.name)
  expect(Object.values(graph).some((node) => node.class_type === 'EmptyLatentImage')).toBe(false)
  const encode = Object.entries(graph).find(([, node]) => node.class_type === 'VAEEncode')
  expect(graph[5].inputs.latent_image).toEqual([encode[0], 0])
  // *How much to change* is a node of its own, so it is a field, and it starts at 0.6.
  const change = Object.entries(graph).find(([, node]) => node._meta.title === 'How much to change')
  expect(change[1].inputs.value).toBe(0.6)
  expect(graph[5].inputs.denoise).toEqual([change[0], 0])
  expect(made.text).toMatch(/how_much_to_change = 0\.6/)
  expect(made.text).toMatch(/size = "the picture’s own shape, 768 tall"/)

  const less = await call('generate', { prompt: 'barely changed', images: [picture], strength: 0.3 })
  expect(Object.values(comfy.last()).find((node) => node._meta.title === 'How much to change').inputs.value).toBe(0.3)
  expect(less.text).toMatch(/how_much_to_change = 0\.3/)

  // With no picture, the text-to-image pipeline is exactly what it always was.
  await call('generate', { prompt: 'a cat' })
  const plain = comfy.last()
  expect(Object.values(plain).map((node) => node.class_type).sort()).toEqual(
    ['CheckpointLoaderSimple', 'CLIPTextEncode', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'SaveImage', 'VAEDecodeTiled'].sort(),
  )
  expect(plain[5].inputs.denoise).toBe(1)
})
