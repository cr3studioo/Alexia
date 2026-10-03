// SPDX-License-Identifier: AGPL-3.0-only
import { COMPUTE_META, ErrorCode, Manifest, MCP_PINNED, type ManifestInput } from '@alexia/protocol'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import { Host } from '../src/host.js'
import { Plugins, type PluginsOptions } from '../src/plugins.js'
import { memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'

const sdk = pathToFileURL(join(import.meta.dirname, '..', '..', 'sdk', 'dist', 'src', 'index.js')).href
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function folder(root: string, id: string, compute = true): { dir: string; marker: string; manifest: Manifest } {
  const dir = join(root, 'installed', id)
  const marker = join(root, `${id}-spawned`)
  mkdirSync(dir, { recursive: true })
  const manifest = Manifest.parse({
    manifest_version: 1,
    id,
    name: 'Fixture worker',
    summary: 'Exercises generic compute dispatch.',
    version: '0.1.0',
    license: 'AGPL-3.0-only',
    entry: { run: 'node', args: ['index.mjs'] },
    alexia_protocol: 13,
    mcp_protocol: MCP_PINNED,
    provides: compute ? ['demo.visible', 'demo.render', 'demo.resize'] : ['demo.visible'],
    requires: [{ cap: 'demo.remote', why: 'Runs a separately provided compute operation.' }],
    ...(compute && {
      compute: {
        operations: [
          { cap: 'demo.render', summary: 'Render a fixture file.' },
          { cap: 'demo.resize', summary: 'Resize a fixture file.', weight: 'light' },
        ],
        hooks: ['setup', 'install', 'prepare', 'release'],
      },
    }),
  } satisfies ManifestInput)
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'index.mjs'), `
import { writeFileSync } from 'node:fs'
import { plugin, fromJsonSchema } from ${JSON.stringify(sdk)}
writeFileSync(${JSON.stringify(marker)}, String(process.pid))
const alexia = plugin()
const inputSchema = fromJsonSchema({ type: 'object', additionalProperties: true })
const annotations = { readOnlyHint: true, openWorldHint: false }
alexia.tool('visible', {
  description: 'Return a fixture greeting.', annotations,
  _meta: { 'alexia/provides': ['demo.visible'] },
}, async () => ({ content: [{ type: 'text', text: 'Still here.' }] }))
alexia.tool('ask_compute', { description: 'Ask for a fixture operation.', inputSchema, annotations }, async (args, ctx) => {
  await alexia.settings()
  const progress = []
  const reply = await alexia.compute.run(args.cap, args.arguments, {
    inputs: args.inputs,
    signal: ctx.mcpReq.signal,
    ...(args.progress !== false && { onProgress: (value, total, message) => progress.push({ progress: value, total, message }) }),
  })
  return { content: [], structuredContent: { reply, progress } }
})
if (alexia.manifest.compute) {
  // A different name proves core dispatches by metadata, never by the SDK's name convention.
  alexia.tool('fixture_render', {
    description: 'Render a fixture file.', inputSchema, annotations,
    _meta: { 'alexia/compute': { op: 'demo.render' } },
  }, async (args, ctx) => {
    await alexia.progress(ctx, 1, 2, 'Rendering.')
    // Let core dispatch the progress notification before an immediate result closes its token.
    await alexia.settings()
    return { content: [], structuredContent: { text: JSON.stringify(args), files: [] } }
  })
  alexia.computeOperation('demo.resize', async (args) => ({ text: JSON.stringify(args), files: [] }))
  alexia.computeHooks({
    setup: async () => [{ id: 'runtime', kind: 'runtime', title: 'Fixture runtime', action: 'install', blocks: ['demo.render'] }],
    install: async (requirementId) => writeFileSync(${JSON.stringify(join(root, `${id}-installed`))}, requirementId),
    prepare: async (cap) => writeFileSync(${JSON.stringify(join(root, `${id}-prepared`))}, cap),
    release: async () => {},
  })
  alexia.tool('undeclared_operation', {
    description: 'An undeclared binding core must refuse.', annotations,
    _meta: { 'alexia/compute': { op: 'demo.secret' } },
  }, async () => ({ content: [] }))
  alexia.tool('malformed_compute', {
    description: 'A malformed compute marker is still hidden.', annotations,
    _meta: { 'alexia/compute': false },
  }, async () => ({ content: [] }))
}
await alexia.start()
`)
  return { dir, marker, manifest }
}

function fixture(compute?: PluginsOptions['compute']) {
  const root = mkdtempSync(join(tmpdir(), 'alexia-compute-plugins-'))
  const worker = folder(root, 'worker-fixture')
  const store = new Store(':memory:')
  const changed = vi.fn()
  const plugins = new Plugins({
    dir: join(root, 'installed'), dataDir: join(root, 'data'), store,
    secrets: memorySecrets(), compute, onToolsChanged: changed,
  })
  plugins.load()
  cleanups.push(async () => {
    await plugins.stop()
    store.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  return { root, worker, store, plugins, changed }
}

test('computeWorkers reads only enabled manifests, without spawning, and returns independent declarations', () => {
  const { plugins, worker } = fixture()
  expect(plugins.computeWorkers()).toEqual([])
  plugins.enable(worker.manifest.id)
  const workers = plugins.computeWorkers()
  expect(workers).toEqual([{
    handle: worker.manifest.id,
    operations: worker.manifest.compute!.operations,
    hooks: worker.manifest.compute!.hooks,
  }])
  expect(plugins.process(worker.manifest.id)?.pid).toBeUndefined()
  expect(existsSync(worker.marker)).toBe(false)
  workers[0]!.operations[0]!.cap = 'demo.changed'
  workers[0]!.hooks.pop()
  expect(plugins.computeWorkers()[0]!.operations[0]!.cap).toBe('demo.render')
  expect(plugins.computeWorkers()[0]!.hooks).toContain('release')
})

test('tools omits every COMPUTE_META tool, keeping ordinary tools and capabilities', async () => {
  const { plugins, worker } = fixture()
  plugins.enable(worker.manifest.id)
  const tools = await plugins.tools()
  expect(tools.map(({ tool }) => tool.name).sort()).toEqual(['ask_compute', 'visible'])
  expect(tools.every(({ tool }) => tool._meta?.[COMPUTE_META] === undefined)).toBe(true)
  expect((await plugins.capability('demo.visible')).content).toEqual([{ type: 'text', text: 'Still here.' }])
  await expect(plugins.capability('demo.render')).rejects.toMatchObject({ code: ErrorCode.CAPABILITY_NOT_AVAILABLE })
})

test('removing a worker folder removes only its capabilities and notifies the loader listener', async () => {
  const { root, plugins, worker, changed } = fixture()
  const other = folder(root, 'other-fixture')
  const ordinary = folder(root, 'ordinary-fixture', false)
  plugins.load()
  for (const id of plugins.ids) plugins.enable(id)
  expect(plugins.computeWorkers()).toHaveLength(2)
  plugins.watch()
  // The folder watcher comes up asynchronously (FSEvents on a Mac): a folder removed before it is up is never heard of.
  await new Promise((resolve) => setTimeout(resolve, 500))
  changed.mockClear()
  rmSync(worker.dir, { recursive: true, force: true })
  await vi.waitFor(() => expect(plugins.computeWorkers().map((worker) => worker.handle)).toEqual([other.manifest.id]), { timeout: 15_000 })
  expect(changed).toHaveBeenCalledWith(worker.manifest.id)
  expect(plugins.ids).toEqual([ordinary.manifest.id, other.manifest.id].sort())
  expect(plugins.answers('demo.render')).toBe(true)
  expect(existsSync(other.marker)).toBe(false)
  expect(existsSync(ordinary.marker)).toBe(false)
  expect((await plugins.capability('demo.visible')).content).toEqual([{ type: 'text', text: 'Still here.' }])
  await plugins.disable(other.manifest.id)
  expect(plugins.computeWorkers()).toEqual([])
})

test('computeCall selects the declared operation by metadata and forwards MCP progress options', async () => {
  const { plugins, worker } = fixture()
  plugins.enable(worker.manifest.id)
  const progress = vi.fn()
  const result = await plugins.computeCall(worker.manifest.id, 'run', {
    cap: 'demo.render', arguments: { prompt: 'fixture', cap: 'an operation argument' },
  }, { onprogress: progress })
  expect(result.structuredContent).toEqual({ text: '{"prompt":"fixture","cap":"an operation argument"}', files: [] })
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ progress: 1, total: 2, message: 'Rendering.' }))
  expect((await plugins.computeCall(worker.manifest.id, 'run', {
    cap: 'demo.resize', arguments: { width: 12 },
  })).structuredContent).toEqual({ text: '{"width":12}', files: [] })
  await plugins.stopProcess(worker.manifest.id)
  expect(plugins.process(worker.manifest.id)?.pid).toBeUndefined()
  expect(plugins.computeWorkers()).toHaveLength(1)
  expect((await plugins.computeCall(worker.manifest.id, 'run', { cap: 'demo.resize' })).structuredContent).toEqual({ text: '{}', files: [] })
})

test('compute hooks use the documented setup, install, prepare and release wire shapes', async () => {
  const { plugins, worker, root } = fixture()
  plugins.enable(worker.manifest.id)
  const setup = await plugins.computeCall(worker.manifest.id, 'setup', {})
  expect(setup.structuredContent).toEqual({ requirements: [{
    id: 'runtime', kind: 'runtime', title: 'Fixture runtime', action: 'install', blocks: ['demo.render'],
  }] })
  await plugins.computeCall(worker.manifest.id, 'install', { requirementId: 'runtime' })
  await plugins.computeCall(worker.manifest.id, 'prepare', { cap: 'demo.render' })
  expect(readFileSync(join(root, `${worker.manifest.id}-installed`), 'utf8')).toBe('runtime')
  expect(readFileSync(join(root, `${worker.manifest.id}-prepared`), 'utf8')).toBe('demo.render')
  expect((await plugins.computeCall(worker.manifest.id, 'release', {})).isError).not.toBe(true)
})

test('disabled, removed and undeclared workers cannot be invoked, even if a tool claims the capability', async () => {
  const { plugins, worker } = fixture()
  await expect(plugins.computeCall(worker.manifest.id, 'setup', {})).rejects.toMatchObject({ code: ErrorCode.CAPABILITY_NOT_AVAILABLE })
  plugins.enable(worker.manifest.id)
  await expect(plugins.computeCall(worker.manifest.id, 'run', { cap: 'demo.secret' })).rejects.toMatchObject({ code: ErrorCode.CAPABILITY_NOT_PERMITTED })
  await expect(plugins.computeCall(worker.manifest.id, 'run', { cap: 'demo.render', arguments: [] })).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAMS })
  expect(existsSync(worker.marker)).toBe(false)
  rmSync(worker.dir, { recursive: true, force: true })
  plugins.load()
  await expect(plugins.computeCall(worker.manifest.id, 'setup', {})).rejects.toMatchObject({ code: ErrorCode.CAPABILITY_NOT_AVAILABLE })
  await expect(plugins.stopProcess(worker.manifest.id)).resolves.toBeUndefined()
})

test('undeclared hooks are refused before spawn, while a missing declared binding reports unavailable', async () => {
  const { plugins, worker } = fixture()
  plugins.enable(worker.manifest.id)
  plugins.manifest(worker.manifest.id)!.compute!.hooks = ['setup']
  await expect(plugins.computeCall(worker.manifest.id, 'install', { requirementId: 'runtime' })).rejects.toMatchObject({ code: ErrorCode.CAPABILITY_NOT_PERMITTED })
  expect(existsSync(worker.marker)).toBe(false)
  const list = vi.spyOn(plugins.process(worker.manifest.id)!, 'listTools').mockResolvedValue([])
  await expect(plugins.computeCall(worker.manifest.id, 'setup', {})).rejects.toMatchObject({ code: ErrorCode.CAPABILITY_NOT_AVAILABLE })
  await expect(plugins.computeCall(worker.manifest.id, 'run', { cap: 'demo.render' })).rejects.toMatchObject({ code: ErrorCode.CAPABILITY_NOT_AVAILABLE })
  list.mockRestore()
})

test('the Host compute seam permits only the caller’s operations or requires, and forwards its request context', async () => {
  const compute = vi.fn(async () => ({ text: 'Done.', files: [] }))
  const { store, root, worker } = fixture()
  const host = new Host({ store, dataDir: join(root, 'host-data'), compute, manifest: () => worker.manifest })
  const params = { cap: 'demo.render', arguments: { prompt: 'test' }, inputs: [{ name: 'input', path: join(root, 'input'), mime: 'text/plain' }] }
  const signal = new AbortController().signal
  const progress = vi.fn()
  await expect(host.alexia(worker.manifest.id, 'alexia/compute/run', params, signal, progress)).resolves.toEqual({ text: 'Done.', files: [] })
  expect(compute).toHaveBeenCalledWith(worker.manifest.id, params, signal, progress)
  await host.alexia(worker.manifest.id, 'alexia/compute/run', { cap: 'demo.remote' })
  await expect(host.alexia(worker.manifest.id, 'alexia/compute/run', { cap: 'demo.visible' })).rejects.toMatchObject({ code: ErrorCode.CAPABILITY_NOT_PERMITTED })
  await expect(host.alexia(worker.manifest.id, 'alexia/compute/run', { cap: 'demo.secret' })).rejects.toMatchObject({ code: ErrorCode.CAPABILITY_NOT_PERMITTED })
  expect(compute).toHaveBeenCalledTimes(2)
})

test('an unwired compute handler returns CAPABILITY_NOT_AVAILABLE over the actual plugin wire', async () => {
  const { plugins, worker } = fixture()
  plugins.enable(worker.manifest.id)
  const result = await plugins.process(worker.manifest.id)!.callTool('ask_compute', { cap: 'demo.render' })
  expect(result.isError).toBe(true)
  expect(result.content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('compute is not available') })])
})

test('PluginsOptions.compute receives a plugin request and sends ordered progress before its result', async () => {
  const compute = vi.fn<NonNullable<PluginsOptions['compute']>>(async (_id, _params, _signal, progress) => {
    progress?.({ progress: 1, total: 2, message: 'Starting.' })
    progress?.({ progress: 2, total: 2, message: 'Done.' })
    return { text: 'Remote result.', files: [] }
  })
  const { plugins, worker } = fixture(compute)
  plugins.enable(worker.manifest.id)
  const result = await plugins.process(worker.manifest.id)!.callTool('ask_compute', { cap: 'demo.remote', arguments: { prompt: 'test' } })
  expect(result.structuredContent).toEqual({
    reply: { text: 'Remote result.', files: [] },
    progress: [{ progress: 1, total: 2, message: 'Starting.' }, { progress: 2, total: 2, message: 'Done.' }],
  })
  expect(compute).toHaveBeenCalledWith(worker.manifest.id, { cap: 'demo.remote', arguments: { prompt: 'test' } }, expect.any(AbortSignal), expect.any(Function))
  await plugins.process(worker.manifest.id)!.callTool('ask_compute', { cap: 'demo.render', progress: false })
  expect(compute.mock.calls[1]![3]).toBeUndefined()
})

test('cancelling a plugin tool propagates to the injected compute handler', async () => {
  const compute = vi.fn<NonNullable<PluginsOptions['compute']>>(async (_id, _params, signal) => {
    await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }))
    return { files: [] }
  })
  const { plugins, worker } = fixture(compute)
  plugins.enable(worker.manifest.id)
  const controller = new AbortController()
  const pending = plugins.process(worker.manifest.id)!.callTool('ask_compute', { cap: 'demo.render' }, { signal: controller.signal })
  const rejected = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(compute).toHaveBeenCalledOnce())
  controller.abort()
  await rejected
  await vi.waitFor(() => expect(compute.mock.calls[0]![2]!.aborted).toBe(true))
})
