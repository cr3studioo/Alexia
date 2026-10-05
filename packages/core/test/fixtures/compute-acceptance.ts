// SPDX-License-Identifier: AGPL-3.0-only
import { Manifest, MCP_PINNED, type ManifestInput } from '@alexia/protocol'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Artifacts } from '../../src/compute/artifacts.js'
import { Bridge } from '../../src/compute/bridge.js'
import type { Connect } from '../../src/compute/connect.js'
import { Controller } from '../../src/compute/controller.js'
import { HostProtocol } from '../../src/compute/hostProtocol.js'
import { Hosts } from '../../src/compute/hosts.js'
import { hostModels } from '../../src/compute/api.js'
import { Inventory } from '../../src/compute/inventory.js'
import { RemoteJobs } from '../../src/compute/jobs.js'
import { Operations } from '../../src/compute/operations.js'
import type { ControlEvent } from '../../src/compute/protocol.js'
import { Scheduler } from '../../src/compute/scheduler.js'
import { Setup } from '../../src/compute/setup.js'
import { rememberTarget } from '../../src/compute/target.js'
import type { ConnectionState } from '../../src/compute/types.js'
import { pluginWorkers, textWorker, Workers } from '../../src/compute/workers.js'
import { remember } from '../../src/installed.js'
import { LLAMA, type LlamaServer } from '../../src/llama.js'
import { LocalModels } from '../../src/localModels.js'
import type { Machine } from '../../src/machine.js'
import { Plugins } from '../../src/plugins.js'
import { memorySecrets } from '../../src/secrets.js'
import { Store } from '../../src/store.js'

/**
 * The two computers of plan §13, built from the real modules: a compute host (the real host
 * protocol, scheduler, workers, inventory, artifact store, setup and model picker, with a
 * fixture plugin as its worker) and an interaction computer's compute half (the real
 * controller, jobs, bridge and operations). Only the model runner's HTTP address, Hugging
 * Face, the hardware and, where a test asks, the clocks are stand-ins.
 */

const sdk = pathToFileURL(join(import.meta.dirname, '..', '..', '..', 'sdk', 'dist', 'src', 'index.js')).href

export const GB = 1024 ** 3
/** The compute host's hardware: nothing like the laptop's, so an answer that carries it came from the host. */
export const STUDIO_MACHINE: Machine = {
  platform: 'linux', arch: 'x64', chip: 'Studio GPU box', appleSilicon: false, ramBytes: 96 * GB, freeRamBytes: 64 * GB,
  freeDiskBytes: 500 * GB, diskKnown: true, budgetBytes: 80 * GB, cpuCores: 32,
}
export const LAPTOP_MACHINE: Machine = {
  platform: 'darwin', arch: 'arm64', chip: 'Laptop', appleSilicon: true, ramBytes: 16 * GB, freeRamBytes: 6 * GB,
  freeDiskBytes: 500 * GB, diskKnown: true, budgetBytes: 8 * GB, cpuCores: 8,
}

export interface Timer { fn(): void; ms: number; live: boolean }
/** Timers a test fires by hand. */
export function clock() {
  const timers: Timer[] = []
  const timer = (fn: () => void, ms: number): { clear(): void } => {
    const entry = { fn, ms, live: true }
    timers.push(entry)
    return { clear: () => { entry.live = false } }
  }
  /** Fire every live timer of exactly `ms`, once. */
  const fire = (ms: number): number => {
    const due = timers.filter((one) => one.live && one.ms === ms)
    for (const one of due) { one.live = false; one.fn() }
    return due.length
  }
  return { timers, timer, fire, live: (ms?: number) => timers.filter((one) => one.live && (ms === undefined || one.ms === ms)) }
}

export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

/** A WAV header and a little noise: bytes a text channel would mangle. */
export function recording(samples = 48_000): Buffer {
  const data = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index++) data.writeInt16LE(Math.round(Math.sin(index / 7) * 12_000) ^ (index & 0xff), index * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8); head.write('fmt ', 12)
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(24_000, 24)
  head.writeUInt32LE(48_000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

/** A PNG signature and an arbitrary body, which is all the worker below needs to be a picture. */
const PNG = (seed: string): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed.repeat(5000))])

/**
 * A plugin on the host with the shapes of the real workers, so the transport and the protocol
 * carry what they would: an image render with ComfyUI-like progress and a picture as its
 * output, speech recognition over a recording sent as an input, speech synthesis with a
 * recording as its output, a job that never finishes, and a process that dies mid-job.
 */
export function fixturePlugin(root: string) {
  const id = 'acceptance-worker'
  const dir = join(root, 'installed', id)
  const at = (name: string): string => join(root, name)
  mkdirSync(dir, { recursive: true })
  mkdirSync(at('made'), { recursive: true })
  const manifest = Manifest.parse({
    manifest_version: 1, id, name: 'Acceptance worker', summary: 'Stands in for the image and voice workers.', version: '0.1.0',
    license: 'AGPL-3.0-only', entry: { run: 'node', args: ['index.mjs'] }, alexia_protocol: 13, mcp_protocol: MCP_PINNED,
    provides: ['image.render', 'voice.recognize', 'voice.synthesize', 'demo.wait', 'demo.crash'],
    compute: {
      operations: [
        { cap: 'image.render', summary: 'Render a prepared workflow.' },
        { cap: 'voice.recognize', summary: 'Recognize speech in a recording.', weight: 'light' },
        { cap: 'voice.synthesize', summary: 'Speak a sentence.', weight: 'light' },
        { cap: 'demo.wait', summary: 'Never finish.' },
        { cap: 'demo.crash', summary: 'Die mid-job.' },
      ],
      hooks: ['release'],
    },
  } satisfies ManifestInput)
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'index.mjs'), `
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { plugin } from ${JSON.stringify(sdk)}
const alexia = plugin()
const at = (name) => join(${JSON.stringify(root)}, name)
appendFileSync(at('pids'), process.pid + '\\n')
const ran = (cap) => appendFileSync(at('ran'), cap + '\\n')
const png = (seed) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed.repeat(5000))])
alexia.computeOperation('image.render', async (args, ctx) => {
  ran('image.render')
  for (const [step, node] of [[1, 'Loading checkpoint'], [2, 'KSampler'], [3, 'VAE decode']]) {
    alexia.progress(ctx, step, 3, node)
    // A render's steps are apart in time; spaced: 0 sends them all at once, just before the answer.
    await new Promise((resolve) => setTimeout(resolve, args.spaced ?? 50))
  }
  const made = join(at('made'), 'render-' + args.seed + '.png')
  writeFileSync(made, png(String(args.prompt)))
  return { text: 'Rendered with ' + args.steps + ' steps.', files: [made] }
})
alexia.computeOperation('voice.recognize', async (args) => {
  ran('voice.recognize')
  const heard = readFileSync(args.file)
  return { text: JSON.stringify({ bytes: heard.length, sha256: createHash('sha256').update(heard).digest('hex'), language: args.language }) }
})
alexia.computeOperation('voice.synthesize', async (args) => {
  ran('voice.synthesize')
  const made = join(at('made'), 'spoken.wav')
  writeFileSync(made, Buffer.from(args.wav, 'base64'))
  return { files: [made] }
})
alexia.computeOperation('demo.wait', async (_args, ctx) => {
  ran('demo.wait')
  ctx.mcpReq.signal.addEventListener('abort', () => appendFileSync(at('cancelled'), 'demo.wait\\n'), { once: true })
  await new Promise(() => {})
  return { files: [] }
})
alexia.computeOperation('demo.crash', async (_args, ctx) => {
  ran('demo.crash')
  await alexia.progress(ctx, 1, 2, 'About to fall over.')
  setTimeout(() => process.exit(9), 50)
  await new Promise(() => {})
  return { files: [] }
})
alexia.computeHooks({ release: async () => { appendFileSync(at('released'), String(process.pid) + '\\n') } })
await alexia.start()
`)
  const lines = (name: string): string[] => existsSync(at(name)) ? readFileSync(at(name), 'utf8').trim().split('\n').filter(Boolean) : []
  return { id, dir, at, png: PNG, ran: () => lines('ran'), pids: () => lines('pids').map(Number), released: () => lines('released'), cancelled: () => lines('cancelled') }
}

export interface StudioOptions {
  name?: string
  /** Where the host's text runner answers. Default: nowhere (a test that infers passes `stubRunner().baseUrl`). */
  runnerUrl?: string
  plugin?: boolean
  /** The scheduler's and the host protocol's clock. Default: real timers. */
  timer?: (fn: () => void, ms: number) => { clear(): void }
  /** The plugin job's cancellation deadline. Default: `timer`. */
  workerTimer?: (fn: () => void, ms: number) => { clear(): void }
  /** Hugging Face, as the host's picker asks it. */
  hub?: typeof fetch
  models?: string[]
  /** Notice plugin folders coming and going, as `computeServe` does from its start. */
  watch?: boolean
}

/** The compute host. `connect` is its end of the transport; `controller` is the endpoint it is paired with. */
export async function studio(root: string, connect: Connect, controller: string, options: StudioOptions = {}) {
  const name = options.name ?? 'Studio'
  const store = new Store(':memory:')
  const hosts = new Hosts(store, 'compute')
  hosts.add({ name: 'Laptop', endpointId: controller, peerRole: 'interaction' }, 1)
  await connect.allow(hosts.allowlist())
  const scheduler = new Scheduler(options.timer ? { timer: options.timer } : {})
  for (const id of options.models ?? ['llama/test']) {
    const weights = join(root, `${id.replace(/\W/g, '-')}.gguf`)
    writeFileSync(weights, 'weights')
    remember(root, {
      id, format: 'gguf', name: 'Test', repo: `test/${id.replace(/\W/g, '-')}`, revision: 'a'.repeat(40), quant: 'Q4', files: [weights], bytes: 7,
      context: 8192, tools: true, vision: true, abliterated: false, nsfwOk: 'unknown', vetted: false, ready: true, installedAt: 1,
    })
  }
  const runnerUrl = options.runnerUrl ?? 'http://127.0.0.1:1/v1'
  const text = { loads: [] as string[], stops: 0, loaded: undefined as string | undefined }
  const worker = textWorker({
    dataDir: root,
    runners: {
      provider: () => ({ ...LLAMA, prepare: async (id: string) => { text.loaded = id; text.loads.push(id); return { baseUrl: runnerUrl, key: 'runner-key', release: () => {} } } }),
      loaded: () => (text.loaded ? { model: text.loaded, baseUrl: runnerUrl, since: 1 } : undefined),
      stop: async () => { text.stops++; text.loaded = undefined },
    },
    backend: async () => 'cpu', llamaSupported: () => true, llamaReady: () => ({}) as never, mlxSupported: () => false,
  })
  const plugin = options.plugin ? fixturePlugin(root) : undefined
  const late: { workers?: Workers } = {}
  const plugins = new Plugins({
    dir: join(root, 'installed'), dataDir: join(root, 'data'), store, secrets: memorySecrets(),
    onToolsChanged: () => late.workers?.changed(),
  })
  plugins.load()
  if (plugin) plugins.enable(plugin.id)
  if (options.watch) plugins.watch()
  const workers = late.workers = new Workers(worker, () => pluginWorkers(plugins))
  const artifacts = new Artifacts({ dir: join(root, 'data', 'compute', 'jobs') })
  const inventory = new Inventory({ dataDir: root, name, appVersion: '2.0.0', workers, machine: async () => STUDIO_MACHINE })
  const setup = new Setup({ workers, scheduler, artifacts, inventory })
  const serving = { model: undefined as string | undefined }
  const server = { ensure: async (model: string) => { serving.model = model; return runnerUrl }, loaded: () => serving.model ? { model: serving.model } : undefined, stop: async () => { serving.model = undefined } } as unknown as LlamaServer
  const local = new LocalModels({
    dataDir: root, store, server, machine: async () => STUDIO_MACHINE, ...(options.hub && { fetch: options.hub }),
    ensureRuntime: (async () => ({ version: 'test' })) as never, smoke: async () => ({ tokensPerSecond: 10 }),
  })
  const protocol = new HostProtocol({
    connect, hosts, scheduler, workers, artifacts, inventory, setup, name, appVersion: '2.0.0', store,
    models: hostModels(local),
    ...(options.timer && { timer: options.timer }),
    ...(options.workerTimer && { workerTimer: options.workerTimer }),
  })
  protocol.start()
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await protocol.close()
    await scheduler.close()
    await local.close()
    await plugins.stop()
    inventory.close()
    store.close()
  }
  return { root, name, store, hosts, scheduler, workers, artifacts, inventory, protocol, plugins, plugin, text, local, close }
}

/** The interaction computer's compute half, as `interaction.ts` builds it, with one host record per paired host. */
export function laptop(connect: Connect, paired: { name: string; endpointId: string }[], options: { timer?: (fn: () => void, ms: number) => { clear(): void }; store?: Store } = {}) {
  const store = options.store ?? new Store(':memory:')
  const hosts = new Hosts(store, 'interaction')
  const records = paired.map((one) => hosts.add({ ...one, peerRole: 'compute' }, 1))
  const late: { jobs?: RemoteJobs } = {}
  const controller = new Controller({
    connect, hosts, name: 'Laptop', appVersion: '1.0.0', resume: (hostId) => late.jobs?.outstanding(hostId) ?? [],
    ...(options.timer && { timer: options.timer }),
  })
  const jobs = late.jobs = new RemoteJobs({ controller, store })
  const bridge = new Bridge({ controller })
  const local: { calls: string[] } = { calls: [] }
  const operations = new Operations({
    store, jobs, controller,
    local: async (cap): Promise<CallToolResult> => { local.calls.push(cap); return { content: [{ type: 'text', text: 'ran on this computer' }] } },
  })
  const heard: { hostId: string; event: ControlEvent }[] = []
  controller.onEvent((hostId, event) => { heard.push({ hostId, event }) })
  /** Send everything placed local to this host, as choosing its model does. */
  const choose = (hostId: string, modelId = 'llama/test'): void => { rememberTarget(store, { hostId, modelId }) }
  const close = async (): Promise<void> => {
    await bridge.close()
    await controller.close()
    store.close()
  }
  return { store, hosts, records, controller, jobs, bridge, operations, local, heard, choose, close }
}

/**
 * One interaction computer joined to two hosts. `memoryConnect()` joins two ends; this is the
 * interaction computer's two links presented as the one `Connect` its controller is given,
 * routed by the endpoint it opens to, which is what the sidecar does.
 */
export function twoLinks(first: Connect, firstPeer: string, second: Connect, secondPeer: string): Connect {
  const route = (endpointId: string): Connect => (endpointId === secondPeer ? second : first)
  return {
    identity: () => first.identity(),
    allow: async (ids) => {
      await first.allow(ids.filter((id) => id === firstPeer))
      await second.allow(ids.filter((id) => id === secondPeer))
    },
    open: (endpointId, kind, signal) => route(endpointId).open(endpointId, kind, signal),
    accept: (handler) => { first.accept(handler); second.accept(handler) },
    state: (endpointId): ConnectionState => route(endpointId).state(endpointId),
    onState: (listener) => {
      const offs = [first.onState(listener), second.onState(listener)]
      return () => { for (const off of offs) off() }
    },
    pairOpen: (me, signal) => first.pairOpen(me, signal),
    pairJoin: (code, me, signal) => first.pairJoin(code, me, signal),
    close: async () => { await first.close(); await second.close() },
  }
}
