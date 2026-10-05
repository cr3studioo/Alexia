// SPDX-License-Identifier: AGPL-3.0-only
import { readManifest } from '@alexia/sdk'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, test } from 'vitest'
import { cancel } from '../comfy.js'
import { facts, split } from '../compute.js'
import * as launch from '../launch.js'
import { renderer } from '../render.js'
import { TIERS } from '../tier.js'
import { RECORD, RENDER, USUAL_PORT, dedicated, fetchRequirement, onDisk, requirements } from '../worker.js'

/**
 * This plugin as a compute worker (remote-compute.md §4).
 *
 * Four promises, and each is one a wrong answer to would look like the plugin working: that
 * the heavy half is a declared operation and nothing else is; that planning stays where the
 * person is while rendering goes where they chose, **and never anywhere else**; that what is
 * missing is listed with its size and fetched only when asked; and that the ComfyUI a person
 * has open is not queued into, interrupted or stopped by any of it.
 *
 * No model is downloaded and nothing is rendered: ComfyUI is a few lines of HTTP that answer
 * the way it does, and the process that would be started is that same server on the port the
 * worker chose.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-media-compute-'))
const closing = []
afterEach(async () => {
  while (closing.length > 0) await closing.pop()()
})
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))

const folder = (name) => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Something that answers the way ComfyUI does, and writes down everything it was asked. */
async function comfyui({ at = 0, checkpoints = ['sd_xl_base_1.0.safetensors'], finishes = true, running = [] } = {}) {
  const asked = []
  const queued = []
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') : undefined
      asked.push({ method: request.method, path: url.pathname, body })
      const send = (said) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(said))
      }
      if (url.pathname === '/system_stats') return send({ devices: [{ type: 'cuda', name: 'cuda:0 Test', vram_total: 12e9, vram_free: 11e9 }] })
      if (url.pathname === '/object_info/CheckpointLoaderSimple') {
        return send({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [checkpoints] } } } })
      }
      if (url.pathname === '/object_info') return send({ KSampler: { display_name: 'KSampler' }, SaveImage: {} })
      if (request.method === 'POST' && url.pathname === '/prompt') {
        queued.push(body.prompt)
        return send({ prompt_id: `job-${queued.length}` })
      }
      if (url.pathname === '/queue') return send({ queue_running: running, queue_pending: [] })
      if (url.pathname === '/interrupt') return send({})
      if (url.pathname.startsWith('/history/')) {
        const id = url.pathname.split('/').pop()
        return send(finishes ? { [id]: { outputs: { 9: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } } : {})
      }
      if (url.pathname === '/view') {
        response.writeHead(200, { 'content-type': 'image/png' })
        return response.end(Buffer.from('a picture'))
      }
      response.writeHead(404)
      response.end()
    })
  })
  await new Promise((resolve) => server.listen(at, '127.0.0.1', resolve))
  const close = () =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(resolve)
    })
  closing.push(close)
  const port = server.address().port
  return { server: `http://127.0.0.1:${port}`, port, asked, queued, close }
}

/** This plugin's own key-value store, as a map. */
const storage = () => {
  const kept = new Map()
  return {
    kept,
    get: async (key) => kept.get(key),
    set: async (key, value) => void kept.set(key, value),
    remove: async (key) => void kept.delete(key),
  }
}

/**
 * `launch.js`, with the one part that would start a real program replaced: *starting ComfyUI*
 * brings the fake up on the port it was told, and a pid stands for it. Everything that asks
 * whether a port is free or a server is answering is the real code.
 */
function launcher() {
  const started = []
  const stopped = []
  const processes = new Map()
  let next = 4000
  return {
    started,
    stopped,
    vacant: launch.vacant,
    awake: launch.awake,
    ready: launch.ready,
    tail: launch.tail,
    alive: (pid) => processes.has(pid),
    start: async (dir, options) => {
      const pid = ++next
      const fake = await comfyui({ at: options.at })
      processes.set(pid, fake)
      started.push({ dir, ...options, pid, fake })
      return { pid, exe: 'python' }
    },
    stop: async (pid) => {
      stopped.push(pid)
      await processes.get(pid)?.close()
      return processes.delete(pid)
    },
  }
}

test('the manifest declares the heavy half as a compute operation, and nothing else', () => {
  // `readManifest` is the schema core loads a plugin with, including the two rules compute
  // adds: an operation must be one of `provides`, and no capability is declared twice.
  const manifest = readManifest(join(import.meta.dirname, '..'))
  // 14: the image editor's attachments, private sampling and edit operation.
  expect(manifest.alexia_protocol).toBe(14)
  expect(manifest.compute.operations).toContainEqual(expect.objectContaining({ cap: RENDER, weight: 'heavy' }))
  // The library's own operation is a list and a note, never a render, so it never evicts a model.
  // An edit is a render too, of a fixed verified graph, and is declared beside it.
  expect(manifest.compute.operations.filter((one) => one.weight === 'heavy').map((one) => one.cap)).toEqual([RENDER, 'image.edit'])
  expect(manifest.provides).toEqual(expect.arrayContaining(['image.generate', RENDER]))
  // Planning the picture is not an operation: it stays with the person, whatever they paired.
  expect(manifest.compute.operations.map((one) => one.cap)).not.toContain('image.generate')
  expect([...manifest.compute.hooks].sort()).toEqual(['install', 'prepare', 'release', 'setup'])
})

/** The SDK as far as `split` uses it: where an operation is registered, and where one is run. */
function sdk(run) {
  const operations = new Map()
  const reported = []
  return {
    operations,
    reported,
    computeOperation: (cap, handler) => void operations.set(cap, handler),
    progress: (ctx, done, total, message, work) => reported.push({ ctx, done, total, message, work }),
    compute: { run: (cap, args, options) => run({ cap, args, options, operations }) },
  }
}

test('with nothing paired the operation runs in the planner’s own process, and the preview survives', async () => {
  // What core does when this computer is the one chosen: it calls the plugin's own operation.
  const alexia = sdk(async ({ cap, args, operations }) => operations.get(cap)(args, { mcpReq: {} }))
  const compute = split(alexia)
  const seen = []
  compute.operation(RENDER, async (plan, io) => {
    seen.push({ plan, here: io.here })
    io.report('step 3 of 25', 3, 25, { preview: 'data:image/png;base64,AAAA' })
    return { text: 'done', files: ['/somewhere/out.png'] }
  })

  const said = []
  const made = await compute.run(RENDER, { kind: 'picture', prompt: 'a boat' }, { report: (...frame) => said.push(frame) })

  expect(made).toEqual({ text: 'done', files: ['/somewhere/out.png'] })
  // The plan arrives as it was sent, without the marker that found its planner.
  expect(seen).toEqual([{ plan: { kind: 'picture', prompt: 'a boat' }, here: true }])
  // The planner's own reporter was handed over, so the picture-so-far is still there — and
  // nothing went out on the operation's own call, which would have been the same frame twice.
  expect(said).toEqual([['step 3 of 25', 3, 25, { preview: 'data:image/png;base64,AAAA' }]])
  expect(alexia.reported).toEqual([])
})

test('with a computer chosen the planner sends the plan and performs nothing itself', async () => {
  let sent
  const alexia = sdk(async ({ args, options }) => {
    sent = args
    // Core, carrying the job to another computer: only numbers and a sentence come back.
    options.onProgress(12, 28, 'KSampler — step 12 of 28')
    return { text: 'done', files: ['/mine/out.png'] }
  })
  const compute = split(alexia)
  let performed = 0
  compute.operation(RENDER, async () => {
    performed += 1
    return { files: [] }
  })

  const said = []
  const made = await compute.run(RENDER, { kind: 'picture', prompt: 'a boat' }, { report: (...frame) => said.push(frame) })

  expect(performed).toBe(0)
  expect(sent).toMatchObject({ kind: 'picture', prompt: 'a boat' })
  expect(made.files).toEqual(['/mine/out.png'])
  expect(said).toEqual([['KSampler — step 12 of 28', 12, 28]])
})

test('an operation sent by another computer is told its planner is not here', async () => {
  const alexia = sdk(async () => ({ files: [] }))
  const compute = split(alexia)
  let io
  compute.operation(RENDER, async (_plan, given) => {
    io = given
    given.report('Generating', 1, 2)
    return { files: [] }
  })
  // Core on a paired host, calling the tool the SDK registered: no planner in this process,
  // and a trace this process never issued changes nothing.
  const ctx = { mcpReq: {} }
  await alexia.operations.get(RENDER)({ kind: 'picture', trace: 'somebody-else' }, ctx)
  expect(io.here).toBe(false)
  expect(alexia.reported).toEqual([{ ctx, done: 1, total: 2, message: 'Generating', work: undefined }])
})

test('a computer that cannot do the job is an error, and never quietly this computer instead', async () => {
  const refusal = Object.assign(new Error('MCP error -32050: That computer is not ready to run this capability.'), { code: -32050 })
  const alexia = sdk(async () => {
    throw refusal
  })
  const compute = split(alexia)
  let performed = 0
  compute.operation(RENDER, async () => {
    performed += 1
    return { files: [] }
  })
  await expect(compute.run(RENDER, { kind: 'picture' })).rejects.toThrow(/^That computer is not ready to run this capability\.$/)
  expect(performed).toBe(0)
})

test('a core with no compute at all still makes the picture, here', async () => {
  // The one refusal that means *there is no other computer to have chosen*.
  const none = Object.assign(new Error('MCP error -32050: compute is not available for image.render'), { code: -32050 })
  const alexia = sdk(async () => {
    throw none
  })
  const compute = split(alexia)
  compute.operation(RENDER, async (plan, io) => ({ text: `${plan.prompt} ${io.here}`, files: ['/own/out.png'] }))
  expect(await compute.run(RENDER, { prompt: 'a boat' })).toEqual({ text: 'a boat true', files: ['/own/out.png'] })
})

test('the rendering computer chooses the model, builds the graph and writes the file', async () => {
  const comfy = await comfyui({ checkpoints: ['hassakuXL_v22.safetensors', 'sd_xl_base_1.0.safetensors'] })
  const own = folder('render-own')
  const render = renderer({
    own: () => own,
    connect: async () => ({ server: comfy.server, classes: async () => ({ KSampler: { display_name: 'KSampler' } }) }),
    now: () => 1234,
  })
  const plan = { kind: 'picture', prompt: 'a paper boat', negative: 'blurry', width: 1024, height: 1024, seed: 7, steps: 12, fp32: true, preferred: 'hassaku' }

  const made = await render(plan, { here: false })

  // The planner sent a preference; which file that is, is this machine's to say.
  expect(facts(made.text)).toMatchObject({ here: false, checkpoint: 'hassakuXL_v22.safetensors' })
  expect(made.files).toEqual([join(own, '1234-out.png')])
  expect(readFileSync(made.files[0], 'utf8')).toBe('a picture')
  const graph = comfy.queued[0]
  const inputs = Object.values(graph).map((node) => node.inputs)
  expect(inputs.some((one) => one.ckpt_name === 'hassakuXL_v22.safetensors')).toBe(true)
  expect(inputs.some((one) => one.text === 'a paper boat')).toBe(true)
  expect(inputs.some((one) => one.seed === 7 && one.steps === 12)).toBe(true)

  // Named and not there is a question, not a picture painted by a different model.
  await expect(render({ ...plan, model: 'flux' }, { here: false })).rejects.toThrow(/no model here called flux/)
  expect(comfy.queued).toHaveLength(1)
})

test('a prepared workflow naming a node this machine lacks is refused before anything is queued', async () => {
  const comfy = await comfyui()
  const own = folder('workflow-own')
  const render = renderer({ own: () => own, connect: async () => ({ server: comfy.server, classes: async () => ({ SaveImage: {} }) }) })
  const graph = { 1: { class_type: 'SomebodysNode', inputs: {} }, 2: { class_type: 'SaveImage', inputs: { images: ['1', 0] } } }

  await expect(render({ kind: 'workflow', name: 'Portraits', graph }, { here: false })).rejects.toThrow(/Portraits needs SomebodysNode/)
  expect(comfy.queued).toEqual([])

  const fine = { 2: { class_type: 'SaveImage', inputs: {} } }
  const made = await render({ kind: 'workflow', name: 'Portraits', graph: fine }, { here: false })
  expect(comfy.queued).toEqual([fine])
  expect(made.files).toHaveLength(1)
})

test('what is missing is listed with its size before anything is installed', async () => {
  const [small, mid] = TIERS
  // No ComfyUI: something only a person can do, with the words for it and no button.
  expect(requirements({ dir: undefined })).toEqual([
    expect.objectContaining({ id: 'comfyui', kind: 'runtime', action: 'instructions', blocks: [RENDER] }),
  ])
  expect(requirements({ dir: undefined })[0].instructions).toMatch(/comfy\.org/)
  expect(requirements({ dir: undefined })[0].bytes).toBeUndefined()

  // ComfyUI and no model: one download, and its size is on the list.
  expect(requirements({ dir: '/comfy', installed: [] })).toEqual([
    expect.objectContaining({ id: `model:${mid.file}`, kind: 'model', action: 'install', bytes: mid.bytes, blocks: [RENDER] }),
  ])
  // The card decides which, where it has been read — and a machine without one gets the smallest.
  expect(requirements({ dir: '/comfy', installed: [], card: { total: 4e9 } })[0].bytes).toBe(small.bytes)
  expect(requirements({ dir: '/comfy', installed: [], card: null })[0].bytes).toBe(small.bytes)
  // A model already there means there is nothing to ask for.
  expect(requirements({ dir: '/comfy', installed: ['anything.safetensors'] })).toEqual([])
})

test('the models already on disk are found without starting ComfyUI', async () => {
  const install = folder('install-with-model')
  mkdirSync(join(install, 'models', 'checkpoints', 'sdxl'), { recursive: true })
  writeFileSync(join(install, 'models', 'checkpoints', 'sdxl', 'mine.safetensors'), 'x')
  writeFileSync(join(install, 'models', 'checkpoints', 'put_checkpoints_here'), '')
  expect(await onDisk([install, folder('empty-own'), undefined])).toEqual(['mine.safetensors'])
})

test('a model is downloaded by the install hook and by nothing else', async () => {
  const own = folder('install-own')
  const fetched = []
  const fetch = async (url, to, options) => {
    fetched.push({ url, to, expect: options.expect })
    return { path: to, bytes: options.expect, already: false }
  }
  const [small] = TIERS

  // Starting the worker, asking what it has and letting go of it fetch nothing at all.
  const stub = launcher()
  const worker = dedicated({ storage: storage(), own: () => own, dir: async () => folder('install-comfy'), launch: stub })
  await worker.ensure()
  await worker.running()
  await worker.release()
  expect(fetched).toEqual([])

  await fetchRequirement(`model:${small.file}`, { own, fetch })
  expect(fetched).toEqual([{ url: small.url, to: join(own, 'models', 'checkpoints', small.file), expect: small.bytes }])

  // ComfyUI itself is never installed from here, and neither is anything that was not offered.
  await expect(fetchRequirement('comfyui', { own, fetch })).rejects.toThrow(/comfy\.org/)
  await expect(fetchRequirement('model:something-else.safetensors', { own, fetch })).rejects.toThrow(/nothing here to install/)
  expect(fetched).toHaveLength(1)
})

test('release stops the worker’s ComfyUI, which is what gives the model memory back', async () => {
  const own = folder('release-own')
  const stub = launcher()
  const kept = storage()
  const worker = dedicated({ storage: kept, own: () => own, dir: async () => folder('release-comfy'), launch: stub })

  const up = await worker.ensure()
  const { pid, port } = kept.kept.get(RECORD)
  expect(up.server).toBe(`http://127.0.0.1:${port}`)
  // Asked for twice, started once: two jobs must not become two ComfyUIs.
  await worker.ensure()
  expect(stub.started).toHaveLength(1)

  expect(await worker.release()).toBe(true)
  expect(stub.stopped).toEqual([pid])
  expect(kept.kept.has(RECORD)).toBe(false)
  expect(await launch.awake(up.server)).toBe(false)
  // Nothing left to let go of is not a failure, and stops nothing.
  expect(await worker.release()).toBe(false)
  expect(stub.stopped).toEqual([pid])
})

test('a ComfyUI the person is running is never queued into, interrupted or stopped', async () => {
  /**
   * Their ComfyUI, where it usually is. If that port is taken on the machine running this —
   * by a real ComfyUI, quite possibly — theirs is stood up beside it and named the way the
   * plugin's `server` setting would name it. Either way it is a port the worker must not use.
   */
  const personal = await comfyui({ at: (await launch.vacant(USUAL_PORT)) ? USUAL_PORT : 0, running: [[0, 'their-own-render']] })
  const own = folder('personal-own')
  const stub = launcher()
  const kept = storage()
  const worker = dedicated({
    storage: kept,
    own: () => own,
    dir: async () => folder('personal-comfy'),
    avoid: async () => [personal.port],
    launch: stub,
  })
  const connect = async ({ signal }) => {
    const up = await worker.ensure({ signal })
    return { server: up.server, classes: async () => ({}), tidy: worker.tidy }
  }
  const render = renderer({ own: () => own, connect })
  const plan = { kind: 'picture', prompt: 'a boat', width: 512, height: 512, seed: 1 }

  // A whole job: the worker starts a ComfyUI of its own, somewhere else, and renders there.
  const made = await render(plan, { here: false })
  expect(made.files).toHaveLength(1)
  const [mine] = stub.started
  expect(mine.at).not.toBe(USUAL_PORT)
  expect(mine.at).not.toBe(personal.port)
  // What it renders is kept in Alexia's folder rather than among the person's pictures.
  expect(mine.args).toEqual([
    '--output-directory',
    join(own, 'worker', 'output'),
    '--temp-directory',
    join(own, 'worker', 'temp'),
    '--input-directory',
    join(own, 'worker', 'input'),
  ])
  expect(mine.fake.queued).toHaveLength(1)

  // A job given up on halfway: it is the worker's own job that is stopped, on the worker's own ComfyUI.
  await mine.fake.close()
  const busy = await comfyui({ at: mine.at, finishes: false, running: [[0, 'job-1']] })
  const giving = new AbortController()
  const abandoned = render(plan, { here: false, signal: giving.signal })
  // Wait until the renderer has received the job id and started waiting for it. The
  // server recording the prompt does not mean its response has reached the client yet.
  await expect.poll(() => busy.asked.some((one) => one.method === 'GET' && one.path === '/history/job-1'), { timeout: 5000 }).toBe(true)
  giving.abort()
  await expect(abandoned).rejects.toThrow()
  await expect.poll(() => busy.asked.some((one) => one.method === 'POST' && one.path === '/interrupt'), { timeout: 5000 }).toBe(true)
  expect(busy.asked.find((one) => one.path === '/interrupt').body).toEqual({ prompt_id: 'job-1' })

  // The host goes idle and lets go.
  await worker.release()
  expect(stub.stopped).toEqual([mine.pid])

  // Theirs was never spoken to — not a prompt, not an interrupt, not so much as a question.
  expect(personal.asked).toEqual([])
  expect(await launch.awake(personal.server)).toBe(true)

  // And with nothing of Alexia's left running, another release still stops nothing.
  expect(await worker.release()).toBe(false)
  expect(stub.stopped).toEqual([mine.pid])
  expect(await launch.awake(personal.server)).toBe(true)
}, 30_000)

test('the worker never takes the usual port, even when it is free', async () => {
  const stub = { ...launcher(), vacant: async () => true }
  const worker = dedicated({ storage: storage(), own: () => folder('port-own'), dir: async () => folder('port-comfy'), avoid: async () => [8288, 8289], launch: stub })
  await worker.ensure()
  expect(stub.started[0].at).toBe(8290)
  await worker.release()
})

test('giving up on a job that is still waiting does not end the render in front of it', async () => {
  // The person's ComfyUI on this computer, rendering something of their own, with Alexia's
  // job queued behind it. Stopping Alexia's must take only Alexia's out.
  const theirs = await comfyui({ running: [[0, 'their-own-render']] })
  expect(await cancel(theirs.server, 'alexia-job')).toBe(false)
  expect(theirs.asked.filter((one) => one.method === 'POST')).toEqual([{ method: 'POST', path: '/queue', body: { delete: ['alexia-job'] } }])

  // Running, and ours: now it is interrupted, by name.
  const ours = await comfyui({ running: [[0, 'alexia-job']] })
  expect(await cancel(ours.server, 'alexia-job')).toBe(true)
  expect(ours.asked.at(-1)).toEqual({ method: 'POST', path: '/interrupt', body: { prompt_id: 'alexia-job' } })
})

test('a rendered file is removed from the worker’s folder once it is safe, and nothing outside it is touched', async () => {
  const own = folder('tidy-own')
  const worker = dedicated({ storage: storage(), own: () => own, dir: async () => undefined, launch: launcher() })
  mkdirSync(join(own, 'worker', 'output'), { recursive: true })
  const rendered = join(own, 'worker', 'output', 'out.png')
  const precious = join(own, 'keep.png')
  writeFileSync(rendered, 'x')
  writeFileSync(precious, 'x')

  await worker.tidy({ filename: 'out.png', subfolder: '', type: 'output' })
  await worker.tidy({ filename: 'keep.png', subfolder: join('..', '..'), type: 'output' })
  await worker.tidy({ filename: 'keep.png', subfolder: '', type: 'input' })

  expect(existsSync(rendered)).toBe(false)
  expect(existsSync(precious)).toBe(true)
})
