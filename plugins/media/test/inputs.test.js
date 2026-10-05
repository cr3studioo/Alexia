// SPDX-License-Identifier: AGPL-3.0-only
import { Buffer } from 'node:buffer'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, test } from 'vitest'
import { pick } from '../comfy.js'
import { facts, split } from '../compute.js'
import { bytesOf, picture, sniff } from '../inputs.js'
import { memory, merge, recall } from '../memory.js'
import { renderer } from '../render.js'
import { api, CHANGE, editor, STARTER } from '../starter.js'
import { RENDER } from '../worker.js'
import { apply, knobs, pictures, roles, told, used } from '../workflows.js'

/**
 * Pictures to start from, and what is remembered between pictures.
 *
 * The promise that matters most is the one about computers: a picture somebody attached is on
 * *their* disk, and a render on a paired computer must get it by the job carrying it there —
 * core stages it beside the job and hands the operation that path — and then by uploading it to
 * *that* computer's ComfyUI. Never by assuming the host can see a path on another machine.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-media-inputs-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
const closing = []
afterEach(async () => {
  while (closing.length > 0) await closing.pop()()
})

const folder = (name) => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0])

/** A ComfyUI that takes uploads, and writes down what it was given and what it queued. */
async function comfyui({ checkpoints = ['sd_xl_base_1.0.safetensors'] } = {}) {
  const uploads = []
  const queued = []
  const asked = []
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks)
      asked.push({ method: request.method, path: url.pathname })
      const send = (said) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(said))
      }
      if (url.pathname === '/system_stats') return send({ devices: [] })
      if (url.pathname === '/object_info/CheckpointLoaderSimple') return send({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [checkpoints] } } } })
      if (request.method === 'POST' && url.pathname === '/upload/image') {
        const text = raw.toString('latin1')
        const name = /filename="([^"]+)"/.exec(text)?.[1]
        uploads.push({ name, type: /name="type"\r\n\r\n([^\r]+)/.exec(text)?.[1], body: text })
        return send({ name, subfolder: '', type: 'input' })
      }
      if (request.method === 'POST' && url.pathname === '/prompt') {
        queued.push(JSON.parse(raw.toString('utf8')).prompt)
        return send({ prompt_id: `job-${queued.length}` })
      }
      if (url.pathname === '/queue') return send({ queue_running: [], queue_pending: [] })
      if (url.pathname.startsWith('/history/')) {
        const id = url.pathname.split('/').pop()
        return send({ [id]: { outputs: { 9: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } })
      }
      if (url.pathname === '/view') {
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
  return { server: `http://127.0.0.1:${server.address().port}`, uploads, queued, asked }
}

/**
 * Core between two computers, as far as an input goes (`operations.ts`, `artifacts.ts`): every
 * input is copied to the host and named by an artifact id with no extension; every string in the
 * arguments equal to an input's path becomes the staged path there; and the operation is called
 * by the host's core, in a process that did not plan it.
 */
function paired(hostDir) {
  const operations = new Map()
  const sent = []
  let next = 0
  return {
    sent,
    operations,
    computeOperation: (cap, handler) => void operations.set(cap, handler),
    progress: () => {},
    compute: {
      run: async (cap, args, options = {}) => {
        sent.push({ args: structuredClone(args), inputs: options.inputs })
        const staged = new Map()
        for (const one of options.inputs ?? []) {
          const at = join(hostDir, 'inputs', `artifact-${++next}`)
          mkdirSync(join(hostDir, 'inputs'), { recursive: true })
          copyFileSync(one.path, at)
          staged.set(one.path, at)
        }
        const resolve = (value) =>
          typeof value === 'string' ? (staged.get(value) ?? value)
          : Array.isArray(value) ? value.map(resolve)
          : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]))
          : value
        // The planner's trace means nothing in the host's process.
        const made = await operations.get(cap)({ ...resolve(args), trace: 'from-another-computer' }, { mcpReq: {} })
        return { text: made.text, files: made.files }
      },
    },
  }
}

test('through the compute worker, a picture staged on the host is uploaded to the host’s ComfyUI', async () => {
  const mine = folder('interaction')
  const original = join(mine, 'my holiday.png')
  writeFileSync(original, Buffer.concat([PNG, Buffer.from('a beach at noon')]))
  const host = await comfyui()
  const hostDir = folder('host-job')
  const tidied = []
  const connected = []

  const core = paired(hostDir)
  const compute = split(core)
  compute.operation(
    RENDER,
    renderer({
      own: () => folder('host-own'),
      connect: async ({ here }) => {
        connected.push(here)
        return { server: host.server, classes: async () => ({ PrimitiveFloat: {} }), tidy: async (one) => void tidied.push(one) }
      },
    }),
  )

  const made = await compute.run(
    RENDER,
    { kind: 'picture', prompt: 'the beach at night', width: 768, height: 768, seed: 3, steps: 12, images: [original], change: 0.5, aspect: true },
    { inputs: [picture(original)] },
  )

  // It ran as a worker — the host's own ComfyUI, not one the planner chose.
  expect(connected).toEqual([false])
  // The job carried the file: an input with the person's path, and that same path in the plan
  // for core to swap for the host's copy.
  expect(core.sent[0].inputs).toEqual([{ name: 'my holiday.png', path: original, mime: 'image/png' }])
  expect(core.sent[0].args.images).toEqual([original])
  // The host's ComfyUI received the bytes, by upload, under a name that says nothing about the person.
  expect(host.uploads).toHaveLength(1)
  expect(host.uploads[0].body).toContain('a beach at noon')
  expect(host.uploads[0].type).toBe('input')
  expect(host.uploads[0].name).toMatch(/^alexia-[0-9a-f]{20}\.png$/)
  expect(host.uploads[0].body).not.toContain('my holiday')
  // And the graph it queued points at that upload, not at any path on any disk.
  const graph = host.queued[0]
  const loader = Object.values(graph).find((node) => node.class_type === 'LoadImage')
  expect(loader.inputs.image).toBe(host.uploads[0].name)
  expect(JSON.stringify(graph)).not.toContain(mine)
  expect(JSON.stringify(graph)).not.toContain(hostDir)
  expect(Object.values(graph).find((node) => node._meta?.title === 'How much to change').inputs.value).toBe(0.5)
  // A worker keeps nothing it was lent.
  expect(tidied).toContainEqual(expect.objectContaining({ filename: host.uploads[0].name, type: 'input' }))
  expect(made.files).toHaveLength(1)
  expect(facts(made.text)).toMatchObject({ here: false })
})

test('through the compute worker, a saved workflow’s picture field is filled on the host', async () => {
  const mine = folder('interaction-workflow')
  const original = join(mine, 'pose.jpg')
  writeFileSync(original, Buffer.concat([JPEG, Buffer.from('a pose')]))
  const host = await comfyui()
  const core = paired(folder('host-job-workflow'))
  const compute = split(core)
  compute.operation(RENDER, renderer({ own: () => folder('host-own-workflow'), connect: async () => ({ server: host.server, classes: async () => ({ LoadImage: {}, SaveImage: {} }) }) }))

  const graph = {
    1: { class_type: 'LoadImage', inputs: { image: 'example.png' }, _meta: { title: 'Pose' } },
    2: { class_type: 'SaveImage', inputs: { images: ['1', 0] }, _meta: { title: 'Save Image' } },
  }
  await compute.run(RENDER, { kind: 'workflow', name: 'Poses', graph, images: [{ node: '1', input: 'image', path: original }] }, { inputs: [picture(original)] })

  expect(host.uploads).toHaveLength(1)
  // Staged with no extension, the format is read off the bytes.
  expect(host.uploads[0].name).toMatch(/\.jpg$/)
  expect(host.queued[0][1].inputs.image).toBe(host.uploads[0].name)
  // The planner's graph is not mutated by the run.
  expect(graph[1].inputs.image).toBe('example.png')
})

test('a workflow that cannot run on the host costs no upload', async () => {
  const original = join(folder('interaction-missing'), 'x.png')
  writeFileSync(original, PNG)
  const host = await comfyui()
  const render = renderer({ own: () => folder('host-own-missing'), connect: async () => ({ server: host.server, classes: async () => ({}) }) })
  const graph = { 1: { class_type: 'LoadImage', inputs: { image: 'a.png' } } }
  await expect(render({ kind: 'workflow', name: 'W', graph, images: [{ node: '1', input: 'image', path: original }] })).rejects.toThrow(/W needs LoadImage/)
  expect(host.uploads).toEqual([])
})

test('a remembered model the rendering computer lacks is a preference, not a refusal', async () => {
  const host = await comfyui({ checkpoints: ['a.safetensors', 'b.safetensors'] })
  const render = renderer({ own: () => folder('remembered-own'), connect: async () => ({ server: host.server, classes: async () => ({}) }) })
  const plan = { kind: 'picture', prompt: 'x', width: 512, height: 512, seed: 1 }

  expect(facts((await render({ ...plan, remembered: 'b.safetensors' })).text)).toMatchObject({ checkpoint: 'b.safetensors' })
  expect(facts((await render({ ...plan, remembered: 'b.safetensors' })).text).forgotten).toBeUndefined()
  const gone = facts((await render({ ...plan, remembered: 'c.safetensors' })).text)
  expect(gone).toMatchObject({ checkpoint: 'a.safetensors', forgotten: 'c.safetensors' })
  // A model named in the call still wins over the remembered one.
  expect(facts((await render({ ...plan, model: 'a', remembered: 'b.safetensors' })).text)).toMatchObject({ checkpoint: 'a.safetensors' })
  // Without `PrimitiveFloat` on the rendering ComfyUI, the change goes straight onto the sampler.
  const original = join(folder('primitive'), 'x.png')
  writeFileSync(original, PNG)
  await render({ ...plan, images: [original], change: 0.4 })
  const graph = host.queued.at(-1)
  expect(Object.values(graph).some((node) => node.class_type === 'PrimitiveFloat')).toBe(false)
  expect(graph[5].inputs.denoise).toBe(0.4)
})

test('the starter’s picture-to-picture path is there only when a picture is', () => {
  const plain = api({ checkpoint: 'a.safetensors', prompt: 'p', seed: 1 })
  expect(Object.keys(plain).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7'])
  expect(plain[5].inputs.denoise).toBe(1)
  // The editable rendering is the text-to-image workflow, as it always was.
  expect(editor().nodes.map((one) => one.type)).not.toContain('LoadImage')

  const g = api({ checkpoint: 'a.safetensors', prompt: 'p', seed: 1, image: 'alexia-1.png', width: 1024, height: 768 })
  expect(g[4]).toBeUndefined()
  expect(g[8]).toMatchObject({ class_type: 'LoadImage', inputs: { image: 'alexia-1.png' }, _meta: { title: 'Picture to start from' } })
  expect(g[9]).toMatchObject({ class_type: 'ImageScale', inputs: { image: ['8', 0], width: 1024, height: 768, upscale_method: 'lanczos', crop: 'disabled' } })
  expect(g[10]).toMatchObject({ class_type: 'VAEEncode', inputs: { pixels: ['9', 0], vae: ['1', 2] } })
  expect(g[11]).toMatchObject({ class_type: 'PrimitiveFloat', inputs: { value: CHANGE }, _meta: { title: 'How much to change' } })
  expect(g[5].inputs.latent_image).toEqual(['10', 0])
  expect(g[5].inputs.denoise).toEqual(['11', 0])
  expect(CHANGE).toBe(0.6)
  // A picture's own shape, when nobody asked for a size.
  expect(api({ image: 'x.png', height: 768, aspect: true })[9].inputs).toMatchObject({ width: 0, height: 768 })

  // Bound by the same code as anybody's workflow: the picture and the change are fields.
  const found = knobs(g, { LoadImage: { display_name: 'Load Image' }, PrimitiveFloat: { display_name: 'Float', input: { required: { value: ['FLOAT', {}] } } } })
  expect(found.find((one) => one.field === 'picture_to_start_from')).toMatchObject({ type: 'image', node: '8' })
  expect(found.find((one) => one.field === 'how_much_to_change')).toMatchObject({ type: 'number', value: CHANGE })
})

test('a titled LoadImage is a picture field, and pictures are bound by name, then in order', () => {
  const graph = {
    1: { class_type: 'LoadImage', inputs: { image: 'a.png' }, _meta: { title: 'Face' } },
    2: { class_type: 'LoadImage', inputs: { image: 'b.png' }, _meta: { title: 'Style' } },
    3: { class_type: 'LoadImage', inputs: { image: 'c.png' }, _meta: { title: 'Load Image' } },
  }
  const found = knobs(graph, { LoadImage: { display_name: 'Load Image', input: { required: { image: [['a.png', 'b.png']] } } } })
  // The untitled loader is not a field, as with every other node.
  expect(found.map((one) => [one.field, one.type])).toEqual([
    ['face', 'image'],
    ['style', 'image'],
  ])
  expect(pictures(found, {}, ['/p/1.png', '/p/2.png', '/p/3.png'])).toEqual({
    bound: [
      { node: '1', input: 'image', field: 'face', path: '/p/1.png' },
      { node: '2', input: 'image', field: 'style', path: '/p/2.png' },
    ],
    unused: ['/p/3.png'],
  })
  expect(pictures(found, { style: '/p/s.png' }, ['/p/1.png']).bound).toEqual([
    { node: '2', input: 'image', field: 'style', path: '/p/s.png' },
    { node: '1', input: 'image', field: 'face', path: '/p/1.png' },
  ])
  // A path is never written into the graph by `apply`: only the render, after uploading, does that.
  expect(apply(graph, found, { face: '/p/1.png' })[1].inputs.image).toBe('a.png')
  // Read back, a picture field is the file it came from.
  expect(used(found, graph, { pictures: [{ node: '1', path: '/p/1.png' }] })).toEqual([
    { field: 'face', value: '/p/1.png' },
    { field: 'style', value: 'b.png' },
  ])
})

test('a plain request’s vocabulary finds the fields that do those things', () => {
  const graph = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' }, _meta: { title: 'Load Checkpoint' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: 'baked', clip: ['1', 1] }, _meta: { title: 'CLIP Text Encode (Prompt)' } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'bad', clip: ['1', 1] }, _meta: { title: 'CLIP Text Encode (Prompt)' } },
    4: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 }, _meta: { title: 'Canvas' } },
    5: { class_type: 'KSampler', inputs: { seed: 1, steps: 20, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] }, _meta: { title: 'KSampler' } },
  }
  const classes = {
    CheckpointLoaderSimple: { display_name: 'Load Checkpoint', input: { required: { ckpt_name: [['x.safetensors']] } } },
    CLIPTextEncode: { display_name: 'CLIP Text Encode (Prompt)', input: { required: { text: ['STRING', { multiline: true }] } } },
    EmptyLatentImage: { display_name: 'Empty Latent Image', input: { required: { width: ['INT', {}], height: ['INT', {}] } } },
    KSampler: { display_name: 'KSampler', input: { required: { seed: ['INT', {}], steps: ['INT', {}] } } },
  }
  const role = roles(graph, classes)
  // Titled where a title sits on the input; read off the wiring where none does.
  expect(role.width).toMatchObject({ field: 'canvas_width', node: '4' })
  expect(role.height).toMatchObject({ field: 'canvas_height', node: '4' })
  expect(role.prompt).toMatchObject({ node: '2', input: 'text' })
  expect(role.negative).toMatchObject({ node: '3', input: 'text' })
  expect(role.model).toMatchObject({ node: '1', input: 'ckpt_name' })
  // The sampler is not titled, so there is no steps field to put *more steps* on.
  expect(role.steps).toBeUndefined()
})

test('what a run used is said as one line a model can repeat', () => {
  expect(told([
    { field: 'prompt', value: 'a fox' },
    { field: 'steps', value: 40, kept: true },
    { field: 'nothing', value: undefined },
    { field: 'long', value: 'x'.repeat(400) },
  ])).toBe(`prompt = "a fox"; steps = 40 (kept from before); long = "${'x'.repeat(300)}…"`)
})

test('said beats again beats kept beats the workflow’s own, and a field that is gone is dropped', () => {
  expect(
    merge({
      fields: ['steps', 'width', 'model'],
      said: { width: 1024 },
      again: { width: 640, steps: 30 },
      kept: { steps: 40, model: 'm', renamed: 1 },
    }),
  ).toEqual({ values: { width: 1024, steps: 30, model: 'm' }, from: { width: 'said', steps: 'again', model: 'kept' } })
})

test('a plain request means the workflow used last, and a gone one falls back with a sentence', () => {
  const rows = [
    { name: 'Anime', export: 'workflows/Anime.api.json' },
    { name: 'Stale', export: 'workflows/Stale.api.json', stale: true },
    { name: STARTER, export: 'x' },
  ]
  const ask = (asked, remembered) => recall({ asked, remembered, rows, starter: STARTER, pick })
  expect(ask(undefined, {})).toEqual({ starter: true })
  expect(ask(undefined, { workflow: STARTER })).toEqual({ starter: true })
  expect(ask(undefined, { workflow: 'Anime' })).toEqual({ row: rows[0] })
  expect(ask(undefined, { workflow: 'Gone' })).toEqual({ starter: true, said: expect.stringMatching(/Gone, is not saved here any more/) })
  expect(ask(undefined, { workflow: 'Stale' }).said).toMatch(/edited after it was exported/)
  // Named beats remembered, and a name that matches nothing is a question rather than a picture.
  expect(ask('starter', { workflow: 'Anime' })).toEqual({ starter: true })
  expect(ask('anim', {})).toEqual({ row: rows[0] })
  expect(ask('portrait', {}).refused).toMatch(/no workflow called portrait/)
})

test('memory keeps per workflow, never an empty value, and resets one field or all', async () => {
  const kept = new Map()
  const mind = memory({ get: async (key) => kept.get(key), set: async (key, value) => void kept.set(key, value) })
  await mind.used({ workflow: 'Anime', checkpoint: 'a.safetensors' })
  await mind.used({ workflow: STARTER })
  expect(await mind.remembered()).toMatchObject({ workflow: STARTER, checkpoint: 'a.safetensors' })
  await mind.forgetModel()
  expect((await mind.remembered()).checkpoint).toBeUndefined()

  await mind.keep('Anime', { steps: 40, width: undefined, negative: '' })
  await mind.keep('Anime', { width: 1024 })
  await mind.keep('Other', { steps: 10 })
  expect(await mind.kept('Anime')).toEqual({ steps: 40, width: 1024 })
  expect(await mind.reset('Anime', ['steps', 'nothing'])).toEqual(['steps'])
  expect(await mind.kept('Anime')).toEqual({ width: 1024 })
  expect(await mind.reset('Anime')).toEqual(['width'])
  expect(await mind.kept('Anime')).toEqual({})
  expect(await mind.kept('Other')).toEqual({ steps: 10 })

  await mind.ran('Anime', { values: { steps: 40 }, seed: 7 })
  expect(await mind.last('Anime')).toMatchObject({ values: { steps: 40 }, seed: 7 })
})

test('a picture is checked where it is and named by its content where it goes', () => {
  const dir = folder('pictures')
  const png = join(dir, 'a.png')
  writeFileSync(png, Buffer.concat([PNG, Buffer.from('x')]))
  expect(picture(png)).toEqual({ name: 'a.png', path: png, mime: 'image/png' })
  expect(() => picture(join(dir, 'missing.png'))).toThrow(/There is no file at/)
  expect(() => picture(join(dir, 'notes.txt'))).toThrow(/not a picture/)
  expect(() => picture(dir)).toThrow(/not a picture/)
  expect(() => picture('')).toThrow(/needs the path/)

  // Same bytes, same name, whatever the file is called; the format comes from the bytes.
  const staged = join(dir, 'artifact-123')
  writeFileSync(staged, Buffer.concat([PNG, Buffer.from('x')]))
  expect(bytesOf(staged).name).toBe(bytesOf(png).name)
  expect(sniff(JPEG)).toBe('.jpg')
  expect(sniff(Buffer.from('RIFF0000WEBP'))).toBe('.webp')
  expect(sniff(Buffer.from('nothing'))).toBeUndefined()
  // Whatever a path is called, bytes that are not a picture never reach a ComfyUI.
  const secret = join(dir, 'secret.png')
  writeFileSync(secret, 'not a picture at all')
  expect(() => bytesOf(secret)).toThrow(/not a picture/)
})
