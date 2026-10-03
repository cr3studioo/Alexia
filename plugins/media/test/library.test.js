// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, expect, test } from 'vitest'
import { split } from '../compute.js'
import { installWorkflow } from '../library/setup.js'
import { TASKS, curated, fits, tasksFor } from '../library/tasks.js'
import { LIBRARY, library, requirementOf } from '../library/tools.js'
import { packsOf } from '../library/packs.js'

/**
 * The workflow library (W2): tasks, installs with everything a workflow needs, and the picker.
 *
 * Nothing real is downloaded, cloned or pip-installed. ComfyUI is a few lines of HTTP answering
 * the way it does; a download writes a few bytes where the model would go; git, tar and pip are
 * a runner that writes down what it was asked and does to the disk what they would have done.
 * The promises held here are the owner's: packs install by themselves, but only into Alexia's own
 * ComfyUI and only with its own Python, everything is recorded, a failure leaves ComfyUI as it
 * was, a person's own ComfyUI gets a list, and nothing installs on another computer except from
 * that computer's setup list.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-media-library-'))
const closing = []
afterEach(async () => {
  while (closing.length > 0) await closing.pop()()
})
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))

let made = 0
/** A ComfyUI install as the portable build lays it out: ComfyUI beside its own Python. */
function install({ embedded = true } = {}) {
  const base = join(root, `portable-${++made}`)
  const dir = join(base, 'ComfyUI')
  mkdirSync(join(dir, 'custom_nodes'), { recursive: true })
  writeFileSync(join(dir, 'main.py'), 'print()')
  writeFileSync(join(dir, 'nodes.py'), 'print()')
  if (embedded) {
    mkdirSync(join(base, 'python_embeded'), { recursive: true })
    writeFileSync(join(base, 'python_embeded', 'python.exe'), 'not really')
  }
  return { dir, python: join(base, 'python_embeded', 'python.exe') }
}

const CORE = {
  LoadImage: { input: { required: { image: [['photo.png']] } }, input_order: { required: ['image'] } },
  RemoveBackground: { input: { required: { image: ['IMAGE'], model_name: [['birefnet.safetensors']] } }, input_order: { required: ['image', 'model_name'] } },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', {}] } }, input_order: { required: ['images', 'filename_prefix'] } },
}
const FACE = {
  FaceRestoreCFWithModel: { input: { required: { image: ['IMAGE'], codeformer_fidelity: ['FLOAT', {}] } }, input_order: { required: ['image', 'codeformer_fidelity'] } },
}

/** An editor-format workflow of three nodes, the middle one `middle`, as ComfyUI saves it. */
const chain = (middle, widgets, props = {}, models = []) => ({
  nodes: [
    { id: 1, type: 'LoadImage', widgets_values: ['photo.png'], inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [1] }], properties: { cnr_id: 'comfy-core', ver: '0.3.40' } },
    { id: 2, type: middle, widgets_values: widgets, inputs: [{ name: 'image', type: 'IMAGE', link: 1 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [2] }], properties: { ...props, models } },
    { id: 3, type: 'SaveImage', widgets_values: ['out'], inputs: [{ name: 'images', type: 'IMAGE', link: 2 }], outputs: [], properties: { cnr_id: 'comfy-core' } },
  ],
  links: [
    [1, 1, 0, 2, 0, 'IMAGE'],
    [2, 2, 0, 3, 0, 'IMAGE'],
  ],
})

const BIREFNET = chain('RemoveBackground', ['birefnet.safetensors'], { cnr_id: 'comfy-core' }, [
  { name: 'birefnet.safetensors', directory: 'background_removal', url: 'https://huggingface.co/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors' },
])
const FACEDOC = chain('FaceRestoreCFWithModel', [0.5])

const INDEX = [
  {
    title: 'Image Tools',
    templates: [
      { name: 'utility_birefnet_remove_background', title: 'Remove Background: BiRefNet', size: 430_000_000, openSource: true, models: ['BiRefNet'], tags: ['Remove Background'] },
      { name: 'api_paid_thing', title: 'A paid one', openSource: false },
    ],
  },
]

/** A ComfyUI that answers templates, workflows and node classes, and writes down what was saved. */
async function comfyui({ classes = CORE } = {}) {
  const files = new Map()
  const known = { ...classes }
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const send = (said, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(said))
      }
      if (url.pathname === '/templates/index.json') return send(INDEX)
      if (url.pathname === '/templates/utility_birefnet_remove_background.json') return send(BIREFNET)
      if (url.pathname === '/object_info') return send(known)
      if (url.pathname === '/system_stats') return send({ devices: [{ type: 'cuda', name: 'cuda:0 NVIDIA GeForce RTX 4060 Ti', vram_total: 8_585_740_288, vram_free: 8e9 }] })
      if (url.pathname === '/userdata' && request.method === 'GET') {
        return send([...files.keys()].filter((one) => one.startsWith('workflows/')).map((one) => ({ path: one.slice('workflows/'.length), modified: 1 })))
      }
      if (url.pathname.startsWith('/userdata/') && request.method === 'POST') {
        files.set(decodeURIComponent(url.pathname.slice('/userdata/'.length)), Buffer.concat(chunks).toString('utf8'))
        return send({})
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
  return { server: `http://127.0.0.1:${server.address().port}`, files, known }
}

/**
 * git, tar and pip, as a runner: each call written down, and the disk changed the way the real
 * program would have changed it. `pip freeze` answers from a list that `install` and `uninstall`
 * move, so a rollback can be checked by what is installed afterwards.
 */
function programs({ pipFails = false } = {}) {
  const calls = []
  let installed = ['numpy==1.26.0']
  const unpack = (into) => {
    mkdirSync(into, { recursive: true })
    writeFileSync(join(into, '__init__.py'), '')
    writeFileSync(join(into, 'requirements.txt'), 'facexlib\n')
  }
  const run = async (command, args, { cwd } = {}) => {
    calls.push({ command, args, cwd })
    if (command === 'git' && args[0] === 'clone') {
      unpack(args[3])
      return { code: 0, stdout: '', stderr: '' }
    }
    if (command === 'git' && args.includes('rev-parse')) return { code: 0, stdout: 'ff4d7a5c102441d8f058dd6135797ffb57b6c6ad\n', stderr: '' }
    if (command === 'git') return { code: 0, stdout: '', stderr: '' }
    if (command === 'tar') {
      unpack(join(args[3], 'pack'))
      return { code: 0, stdout: '', stderr: '' }
    }
    if (args.includes('freeze')) return { code: 0, stdout: installed.join('\n'), stderr: '' }
    if (args.includes('uninstall')) {
      const gone = new Set(args.slice(args.indexOf('-y') + 1))
      installed = installed.filter((line) => !gone.has(line.split('==')[0]))
      return { code: 0, stdout: '', stderr: '' }
    }
    if (args.includes('pip') && args.includes('install')) {
      // What a half-finished pip leaves: one package in, then the one that could not be found.
      installed = [...installed, 'facexlib==0.3.0']
      return pipFails ? { code: 1, stdout: '', stderr: 'ERROR: No matching distribution found for basicsr==9.9' } : { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls, installed: () => installed }
}

/** Downloads, faked: a few bytes where the model goes, and every one written down. */
function downloads() {
  const got = []
  const download = async (url, to, { onProgress } = {}) => {
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, 'weights')
    onProgress?.(7, 7)
    got.push({ url, to })
    return { path: to, bytes: 7, already: false }
  }
  return { got, download }
}

/** The plugin as `library()` uses it: tools, storage, progress, and the compute seam. */
function plugin({ run } = {}) {
  const tools = new Map()
  const kept = new Map()
  const operations = new Map()
  const progress = []
  const alexia = {
    tools,
    kept,
    operations,
    progress: (...frame) => progress.push(frame),
    reported: progress,
    tool: (name, def, handler) => tools.set(name, { def, handler }),
    storage: {
      get: async (key) => (kept.has(key) ? structuredClone(kept.get(key)) : undefined),
      set: async (key, value) => void kept.set(key, structuredClone(value)),
    },
    settings: async () => ({}),
    computeOperation: (cap, handler) => void operations.set(cap, handler),
    // Nothing paired: core has no compute, so the operation runs in the planner's own process.
    compute: {
      run:
        run ??
        (async () => {
          throw Object.assign(new Error('Method not found'), { code: -32601 })
        }),
    },
  }
  return alexia
}

const ctx = { mcpReq: {} }
const call = (alexia, name, args) => {
  const tool = alexia.tools.get(name)
  return tool.def.inputSchema ? tool.handler(args ?? {}, ctx) : tool.handler(ctx)
}
const text = (result) => result.content.map((one) => one.text).join('\n')

/** One computer's library: its ComfyUI (`place`), and the installer with fakes for the world. */
function computer({ comfy, dir, own = true, programs: runner = programs(), files = downloads(), run, sources, comfyRequirement } = {}) {
  const alexia = plugin({ run })
  const released = []
  const place = async () => ({
    dir,
    own,
    server: async () => comfy.server,
    running: async () => comfy?.server,
    release: async () => {
      released.push(Date.now())
      // A restart loads the packs that went into custom_nodes.
      if (comfy && dir && existsSync(join(dir, 'custom_nodes', 'facerestore_cf'))) Object.assign(comfy.known, FACE)
    },
    card: async () => undefined,
  })
  const shelf = library({
    alexia,
    compute: split(alexia),
    place,
    classes: async (server) => (await fetch(`${server}/object_info`)).json(),
    fromWeb: async () => {
      throw new Error('no web in tests')
    },
    comfy: async () => comfyRequirement,
    ...(sources && { sources }),
    installer: (want, at, deps) => installWorkflow(want, at, { ...deps, run: runner.run, download: files.download, platform: 'win32', fetch: fakeWeb }),
  })
  return { alexia, shelf, released, runner, files }
}

/** The internet as the installer sees it: model sizes on HEAD, and the Comfy registry's one pack. */
const fakeWeb = async (url, { method } = {}) => {
  if (method === 'HEAD') return new globalThis.Response(null, { status: 200, headers: { 'content-length': '430000000' } })
  if (url === 'https://api.comfy.org/nodes/comfyui-kokoro/install?version=1.1.4') {
    return globalThis.Response.json({ downloadUrl: 'https://cdn.comfy.org/stavsap/comfyui-kokoro/1.1.4/node.zip', version: '1.1.4' })
  }
  if (url === 'https://cdn.comfy.org/stavsap/comfyui-kokoro/1.1.4/node.zip') return new globalThis.Response('PK zip bytes')
  return new globalThis.Response('nope', { status: 404 })
}

/** The community sources, as a double of `sources/index.js` — one source with one face-restore workflow. */
const community = async () => ({
  sources: [
    {
      id: 'fake-source',
      name: 'Fake source',
      search: async () => [{ id: 'face-1', title: 'Face restore', description: 'CodeFormer', author: 'someone' }],
      fetch: async () => ({ workflow: FACEDOC, format: 'editor', url: 'https://example.invalid/face.json', models: [] }),
    },
  ],
})

test('the tasks are named, each maps to real workflows, and the 8 GB fit is marked on every one', () => {
  const ids = TASKS.map((one) => one.id)
  expect(ids).toEqual(['background', 'upscale', 'edit', 'inpaint', 'face', 'style', 'speech', 'clone', 'video'])
  for (const one of TASKS) {
    expect(one.workflows.length).toBeGreaterThan(0)
    // Every workflow says whether it fits an 8 GB NVIDIA card, and every task has one that does.
    for (const workflow of one.workflows) {
      expect(typeof workflow.fits8gb).toBe('boolean')
      expect(workflow.note.length).toBeGreaterThan(20)
    }
    expect(one.workflows.some((workflow) => workflow.fits8gb)).toBe(true)
  }
  // Community entries pin every pack they need: a registry version or a commit, never "latest".
  for (const one of curated().filter((workflow) => workflow.source === 'community')) {
    for (const pack of one.packs) expect(pack.version ?? pack.commit).toMatch(/^(\d+\.\d+\.\d+|[0-9a-f]{40})$/)
  }
  const card = { total: 8_585_740_288 }
  expect(fits({ vram: 2e9 }, card)).toBe(true)
  expect(fits({ vram: 20e9 }, card)).toBe(false)
  expect(fits({ vram: 2e9 }, undefined)).toBeUndefined()
})

test('a sentence finds its task', () => {
  expect(tasksFor('remove the background of this photo')[0].id).toBe('background')
  expect(tasksFor('read this text aloud in a calm voice')[0].id).toBe('speech')
  expect(tasksFor('make this picture move')[0].id).toBe('video')
  expect(tasksFor('upscale this to 4k')[0].id).toBe('upscale')
  expect(tasksFor('what is the weather')).toEqual([])
})

test('the library page is grouped by task and says what fits the card that renders', async () => {
  const comfy = await comfyui()
  const { dir } = install()
  const { alexia, files } = computer({ comfy, dir })
  const answer = await call(alexia, 'library')
  const rows = answer.structuredContent.rows
  const groups = [...new Set(rows.map((one) => one.group))]
  expect(groups.slice(0, TASKS.length)).toEqual(TASKS.map((one) => one.title))
  const birefnet = rows.find((one) => one.id === 'utility_birefnet_remove_background')
  expect(birefnet).toMatchObject({ state: 'available', group: 'Background remover / changer' })
  expect(birefnet.meta).toContain('0.4 GB to download')
  expect(birefnet.meta).toContain('fits this 8.6 GB card')
  expect(rows.find((one) => one.id === 'image_qwen_image_2_1_background_removal').meta).toContain('needs more than this 8.6 GB card')
  // A workflow that calls a paid service is not on the shelf.
  expect(rows.some((one) => one.id === 'api_paid_thing')).toBe(false)
  // Drawing a page downloads nothing.
  expect(files.got).toEqual([])
})

test('an official template installs only on the install action: saved with its export, its model in the right folder', async () => {
  const comfy = await comfyui()
  const { dir } = install()
  const { alexia, files, runner } = computer({ comfy, dir })

  // Asking about it, picking it, and being told its size all leave the disk as it was.
  const offered = await call(alexia, 'pick_workflow', { asked: 'remove the background of this photo' })
  expect(offered.structuredContent).toMatchObject({ task: 'background', installed: false, offer: 'utility_birefnet_remove_background', bytes: 430_000_000 })
  expect(text(offered)).toContain('0.4 GB to download')
  const told = await call(alexia, 'install_workflow', { workflow: 'utility_birefnet_remove_background' })
  expect(text(told)).toContain('confirmed: true')
  await call(alexia, 'about_workflow', { id: 'utility_birefnet_remove_background' })
  expect(files.got).toEqual([])
  expect(comfy.files.size).toBe(0)

  // The press on the library page: a row action carries the id.
  const done = await call(alexia, 'install_workflow', { id: 'utility_birefnet_remove_background' })
  expect(done.isError).toBeUndefined()
  expect(text(done)).toContain('run_workflow can use it now')
  expect(files.got).toEqual([
    {
      url: 'https://huggingface.co/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors',
      to: join(dir, 'models', 'background_removal', 'birefnet.safetensors'),
    },
  ])
  expect(JSON.parse(comfy.files.get('workflows/utility_birefnet_remove_background.json'))).toEqual(BIREFNET)
  expect(JSON.parse(comfy.files.get('workflows/utility_birefnet_remove_background.api.json'))['2']).toMatchObject({ class_type: 'RemoveBackground' })
  // An official template needs no pack, so nothing was run.
  expect(runner.calls).toEqual([])

  // And now the picker chooses it rather than offering it.
  const picked = await call(alexia, 'pick_workflow', { asked: 'cut out the background please' })
  expect(picked.structuredContent).toEqual({ task: 'background', workflow: 'utility_birefnet_remove_background', installed: true })
  const rows = (await call(alexia, 'library')).structuredContent.rows
  expect(rows.find((one) => one.id === 'utility_birefnet_remove_background').state).toBe('installed')
})

test('a workflow that needs a node pack gets it, with ComfyUI’s own Python, and it is recorded', async () => {
  const comfy = await comfyui()
  const { dir, python } = install()
  const { alexia, runner, released } = computer({ comfy, dir, sources: community })

  const done = await call(alexia, 'install_workflow', { id: 'community:facerestore_cf' })
  expect(done.isError).toBeUndefined()
  expect(text(done)).toContain('Node packs installed: facerestore_cf ff4d7a5c1024')

  // Cloned at the pinned commit, into custom_nodes, under its own name.
  expect(runner.calls[0]).toMatchObject({ command: 'git', args: ['clone', '--recurse-submodules', 'https://github.com/mav-rik/facerestore_cf', expect.any(String)] })
  expect(runner.calls.some((one) => one.command === 'git' && one.args.includes('checkout') && one.args.includes('ff4d7a5c102441d8f058dd6135797ffb57b6c6ad'))).toBe(true)
  expect(existsSync(join(dir, 'custom_nodes', 'facerestore_cf', '__init__.py'))).toBe(true)
  // Every Python call is the embedded one. Not `python`, not `python3`.
  const pythons = runner.calls.filter((one) => one.command !== 'git' && one.command !== 'tar')
  expect(pythons.length).toBeGreaterThan(0)
  expect(new Set(pythons.map((one) => one.command))).toEqual(new Set([python]))
  expect(pythons.some((one) => one.args.join(' ').includes('pip install -r'))).toBe(true)
  // ComfyUI was let go of so the next start loads the pack — and the export was then made against it.
  expect(released.length).toBeGreaterThan(0)
  expect(JSON.parse(comfy.files.get('workflows/facerestore_cf.api.json'))['2']).toMatchObject({ class_type: 'FaceRestoreCFWithModel' })

  const about = text(await call(alexia, 'about_workflow', { id: 'community:facerestore_cf' }))
  expect(about).toMatch(/facerestore_cf at commit ff4d7a5c102441d8f058dd6135797ffb57b6c6ad — https:\/\/github\.com\/mav-rik\/facerestore_cf, installed \d{4}-\d{2}-\d{2}/)
  const record = alexia.kept.get('library')['community:facerestore_cf']
  expect(record.packs).toEqual([
    expect.objectContaining({ name: 'facerestore_cf', url: 'https://github.com/mav-rik/facerestore_cf', commit: 'ff4d7a5c102441d8f058dd6135797ffb57b6c6ad', from: 'git', at: expect.any(String) }),
  ])
  // The model it needs went into its own folder.
  expect(existsSync(join(dir, 'models', 'facerestore_models', 'codeformer.pth'))).toBe(true)
})

test('a registry pack comes as its published version, without git', async () => {
  const comfy = await comfyui()
  const { dir, python } = install()
  const speech = async () => ({
    sources: [{ id: 'fake', name: 'Fake', search: async () => [{ id: 'tts', title: 'Kokoro' }], fetch: async () => ({ workflow: FACEDOC, format: 'editor' }) }],
  })
  const { alexia, runner } = computer({ comfy, dir, sources: speech })
  const done = await call(alexia, 'install_workflow', { id: 'community:kokoro' })
  expect(text(done)).toContain('Node packs installed: comfyui-kokoro 1.1.4')
  expect(runner.calls.some((one) => one.command === 'git')).toBe(false)
  expect(runner.calls.find((one) => one.command === 'tar').args.slice(0, 2)).toEqual(['-xf', expect.stringMatching(/comfyui-kokoro\.zip$/)])
  expect(existsSync(join(dir, 'custom_nodes', 'comfyui-kokoro', 'requirements.txt'))).toBe(true)
  expect(runner.calls.filter((one) => one.args.includes('pip')).every((one) => one.command === python)).toBe(true)
  expect(alexia.kept.get('library')['community:kokoro'].packs).toEqual([
    expect.objectContaining({ name: 'comfyui-kokoro', version: '1.1.4', url: 'https://github.com/stavsap/comfyui-kokoro', from: 'registry' }),
  ])
})

test('a pack that fails is named, and ComfyUI is left as it was', async () => {
  const comfy = await comfyui()
  const { dir } = install()
  const runner = programs({ pipFails: true })
  const { alexia, files } = computer({ comfy, dir, sources: community, programs: runner })

  const before = readdirSync(join(dir, 'custom_nodes'))
  const failed = await call(alexia, 'install_workflow', { id: 'community:facerestore_cf' })
  expect(failed.isError).toBe(true)
  expect(text(failed)).toContain('The node pack facerestore_cf could not be installed')
  expect(text(failed)).toContain('No matching distribution found for basicsr==9.9')
  expect(text(failed)).toContain('ComfyUI was left as it was')
  // Nothing in custom_nodes, the half-installed Python package taken out again, nothing downloaded.
  expect(readdirSync(join(dir, 'custom_nodes'))).toEqual(before)
  expect(runner.installed()).toEqual(['numpy==1.26.0'])
  expect(files.got).toEqual([])
  expect(comfy.files.size).toBe(0)
  // And the details say which pack it was.
  expect(alexia.kept.get('library_failed')['community:facerestore_cf']).toMatchObject({ pack: 'facerestore_cf' })
  expect(text(await call(alexia, 'about_workflow', { id: 'community:facerestore_cf' }))).toContain('failed on the node pack facerestore_cf')
})

test('a pack is never installed without ComfyUI’s own Python', async () => {
  const comfy = await comfyui()
  const { dir } = install({ embedded: false })
  const runner = programs()
  const { alexia } = computer({ comfy, dir, sources: community, programs: runner })
  const failed = await call(alexia, 'install_workflow', { id: 'community:facerestore_cf' })
  expect(text(failed)).toContain('Alexia never uses the system’s')
  expect(runner.calls.filter((one) => one.command !== 'git')).toEqual([])
  expect(readdirSync(join(dir, 'custom_nodes'))).toEqual([])
})

test('a ComfyUI the person installed gets a list of what to add, and nothing added to it', async () => {
  const comfy = await comfyui()
  const { dir } = install()
  const { alexia, files, runner } = computer({ comfy, dir, own: false, sources: community })

  const done = await call(alexia, 'install_workflow', { id: 'community:facerestore_cf' })
  expect(text(done)).toContain('Alexia added nothing to it')
  expect(text(done)).toContain('node pack facerestore_cf at ff4d7a5c1024 from https://github.com/mav-rik/facerestore_cf')
  expect(text(done)).toContain('model codeformer.pth → models/facerestore_models (0.4 GB)')
  expect(files.got).toEqual([])
  expect(runner.calls).toEqual([])
  expect(readdirSync(join(dir, 'custom_nodes'))).toEqual([])
  // Their workflows folder gets the file, which is all that was ever written there.
  expect(comfy.files.has('workflows/facerestore_cf.json')).toBe(true)
})

test('with no ComfyUI, installing a workflow names ComfyUI first', async () => {
  const requirement = { id: 'comfyui', kind: 'runtime', title: 'ComfyUI', detail: 'The program that makes the pictures.', bytes: 2_596_951_145, action: 'install', blocks: ['image.render'] }
  const { alexia, files } = computer({ comfy: undefined, dir: undefined, comfyRequirement: requirement })
  const rows = (await call(alexia, 'library')).structuredContent.rows
  expect(rows[0]).toMatchObject({ id: 'comfyui', state: 'needed', meta: '2.6 GB to download' })
  const refused = await call(alexia, 'install_workflow', { id: 'utility_birefnet_remove_background' })
  expect(refused.isError).toBe(true)
  expect(text(refused)).toContain('ComfyUI is not on the computer that renders yet. It comes first')
  expect(text(await call(alexia, 'pick_workflow', { asked: 'upscale this photo' }))).toMatch(/^ComfyUI is not on the computer that renders yet/)
  expect(files.got).toEqual([])
})

test('a paired computer: the planner asks, the setup list shows the size, and only its Install installs there', async () => {
  // The PC in the other room: Alexia's own ComfyUI, and nothing paired to it.
  const comfy = await comfyui()
  const { dir } = install()
  const pc = computer({ comfy, dir })
  // The Mac: no ComfyUI at all. Its compute seam sends every operation to the PC, the way core
  // does — without the planner's trace, so the PC knows the job came from elsewhere.
  const mac = computer({
    comfy: undefined,
    dir: undefined,
    run: async (cap, args) => pc.alexia.operations.get(cap)(args, ctx),
  })

  const rows = (await call(mac.alexia, 'library')).structuredContent.rows
  expect(rows.find((one) => one.id === 'utility_birefnet_remove_background').meta).toContain('fits this 8.6 GB card')

  const asked = await call(mac.alexia, 'install_workflow', { id: 'utility_birefnet_remove_background' })
  expect(text(asked)).toContain('Press Install beside “Workflow: Remove Background: BiRefNet” in that computer’s setup list')
  // Nothing downloaded anywhere, nothing saved: a conversation on the Mac installs nothing on the PC.
  expect(pc.files.got).toEqual([])
  expect(mac.files.got).toEqual([])
  expect(comfy.files.size).toBe(0)

  const list = await pc.shelf.requirements()
  expect(list).toEqual([
    expect.objectContaining({ id: requirementOf('utility_birefnet_remove_background'), kind: 'dependency', bytes: 430_000_000, action: 'install', blocks: [] }),
  ])

  // The press beside it, which core turns into the PC's install hook.
  expect(await pc.shelf.install(requirementOf('utility_birefnet_remove_background'), ctx)).toBe(true)
  expect(pc.files.got.map((one) => one.to)).toEqual([join(dir, 'models', 'background_removal', 'birefnet.safetensors')])
  expect(comfy.files.has('workflows/utility_birefnet_remove_background.api.json')).toBe(true)
  expect(pc.alexia.reported.length).toBeGreaterThan(0)
  expect(await pc.shelf.requirements()).toEqual([])
  // A requirement that is not a workflow is the other hooks' business.
  expect(await pc.shelf.install('comfyui', ctx)).toBe(false)

  // The Mac's page and picker now see what the PC has.
  const after = (await call(mac.alexia, 'library')).structuredContent.rows
  expect(after.find((one) => one.id === 'utility_birefnet_remove_background').state).toBe('installed')
  expect((await call(mac.alexia, 'pick_workflow', { asked: 'remove the background' })).structuredContent).toMatchObject({ installed: true })
})

test('a paired computer with the person’s own ComfyUI is listed, never installed into', async () => {
  const comfy = await comfyui()
  const { dir } = install()
  const pc = computer({ comfy, dir, own: false })
  const mac = computer({ comfy: undefined, dir: undefined, run: async (cap, args) => pc.alexia.operations.get(cap)(args, ctx) })
  const asked = await call(mac.alexia, 'install_workflow', { id: 'utility_birefnet_remove_background' })
  expect(text(asked)).toContain('one the user installed')
  const [line] = await pc.shelf.requirements()
  expect(line.detail).toContain('adds nothing else to it')
  await pc.shelf.install(line.id, ctx)
  expect(pc.files.got).toEqual([])
  expect(pc.runner.calls).toEqual([])
  expect(pc.alexia.kept.get('library')['utility_birefnet_remove_background'].lines[0]).toContain('model birefnet.safetensors → models/background_removal')
})

test('the operation is the library’s, light, and declared', async () => {
  const { readManifest } = await import('@alexia/sdk')
  const manifest = readManifest(join(import.meta.dirname, '..'))
  expect(manifest.version).toBe('0.8.0')
  expect(manifest.compute.operations).toContainEqual(expect.objectContaining({ cap: LIBRARY, weight: 'light' }))
  expect(manifest.provides).toContain(LIBRARY)
  expect(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'plugin.json'), 'utf8')).page.sizes.L.show).toEqual(
    expect.arrayContaining(['library', 'community_search', 'search_community']),
  )
})

test('the packs an editor file names are read off what ComfyUI stamped on its nodes', () => {
  const doc = {
    nodes: [
      { id: 1, type: 'KSampler', properties: { cnr_id: 'comfy-core', ver: '0.3.40' } },
      { id: 2, type: 'KokoroGenerator', properties: { cnr_id: 'comfyui-kokoro', ver: '1.1.4' } },
      { id: 3, type: 'Thing', properties: { aux_id: 'someone/comfy-thing', ver: 'a28b6d5ff9185a3383f6e8e9036f786015fc6651' } },
    ],
    definitions: { subgraphs: [{ nodes: [{ id: 4, type: 'KokoroSpeaker', properties: { cnr_id: 'comfyui-kokoro', ver: '1.1.4' } }] }] },
  }
  expect(packsOf(doc)).toEqual([
    { name: 'comfyui-kokoro', registry: 'comfyui-kokoro', version: '1.1.4', nodes: ['KokoroGenerator', 'KokoroSpeaker'] },
    { name: 'comfy-thing', url: 'https://github.com/someone/comfy-thing', commit: 'a28b6d5ff9185a3383f6e8e9036f786015fc6651', nodes: ['Thing'] },
  ])
})
