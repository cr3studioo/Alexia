// SPDX-License-Identifier: AGPL-3.0-only
import type { CallToolResult } from '@modelcontextprotocol/client'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { asModel, readInstalled } from '../installed.js'
import { ACCELERATOR_ASSETS, ensureRuntime, RUNTIME_ASSETS, runtimeReady, runtimeSupported } from '../llama.js'
import type { LocalRunners, RunnerLease } from '../localRunners.js'
import { ensureMlxRuntime, mlxRuntimeReady, mlxSupported } from '../mlx.js'
import type { Plugins } from '../plugins.js'
import { runnerBackendProfile, type BackendPreference, type RunnerBackend } from '../runnerBackend.js'
import type { JobOutput } from './protocol.js'
import type { Scheduler, WorkerHandle } from './scheduler.js'
import { ARTIFACT_RETENTION_MS, ComputeError, type HostCapability, type HostModel, type JobProgress, type SetupRequirement } from './types.js'

/**
 * Everything on a compute host that can hold model memory, as one kind of thing: the text
 * runners Alexia ships, and whatever enabled plugins declared `compute`. Nothing here starts
 * until it is asked to, and nothing here knows which plugin it is talking to.
 */

export interface JobIo {
  signal: AbortSignal
  /** The job's own directory. Inputs are already in it; outputs are adopted from it. */
  dir: string
  progress(progress: JobProgress): void
  output(output: JobOutput): void
}
export interface ComputeWorker extends WorkerHandle {
  /** A cancellation deadline stops the process without waiting for its release hook. */
  stop(options?: { force?: boolean }): Promise<void>
  capabilities(): Promise<HostCapability[]>
  setup(): Promise<SetupRequirement[]>
  install(requirementId: string, io: JobIo): Promise<void>
  /** Run one declared operation. Paths in the result are inside `io.dir` or are adopted from where the worker wrote them. */
  run(cap: string, args: Record<string, unknown>, io: JobIo): Promise<{ text?: string; files: string[] }>
}

export const TEXT_WORKER = 'text'
/** What a text requirement waits on. Chat is a job kind, not a declared operation, so no capability carries the name. */
const CHAT = 'chat'
const RELEASE_MS = 15_000
/** A worker's call is on core's clock, not MCP's: a job is cancelled by its signal, and a day is as long as its files are kept. */
const WORK_MS = ARTIFACT_RETENTION_MS
const MESSAGE_MAX = 300

const firstLine = (text: string): string => (text.trim().split(/\r?\n/)[0] ?? '').slice(0, MESSAGE_MAX)

/** A failure with a code. A cancelled job says so, whatever its worker threw while stopping. */
function failed(error: unknown, signal: AbortSignal | undefined, fallback: string): ComputeError {
  if (signal?.aborted) return new ComputeError('cancelled', 'The compute job was cancelled.')
  if (error instanceof ComputeError) return error
  return new ComputeError('worker-failure', (error instanceof Error && firstLine(error.message)) || fallback)
}

export interface TextWorkerOptions {
  dataDir: string
  /** The existing broker. Only these three are used, so a test can hand in a fake. */
  runners: Pick<LocalRunners, 'provider' | 'loaded' | 'stop'>
  /** The existing runtime checks and installers, replaceable in a test. */
  backend?(preference: BackendPreference): Promise<RunnerBackend>
  llamaSupported?(): boolean
  llamaReady?: typeof runtimeReady
  ensureLlama?: typeof ensureRuntime
  mlxSupported?(): boolean
  mlxReady?: typeof mlxRuntimeReady
  ensureMlx?: typeof ensureMlxRuntime
}

const LLAMA_RUNTIME = 'llama-runtime-'
const MLX_RUNTIME = 'mlx-runtime'
const BACKENDS: readonly RunnerBackend[] = ['cpu', 'metal', 'cuda', 'vulkan']

/** The download a llama.cpp runtime is, where its pinned asset table states one. */
function runtimeBytes(backend: RunnerBackend): number | undefined {
  type Asset = { bytes: number; companion?: { bytes: number } }
  const host = `${process.platform}-${process.arch}`
  const asset = backend === 'cpu' || backend === 'metal'
    ? (RUNTIME_ASSETS as Record<string, Asset | undefined>)[host]
    : (ACCELERATOR_ASSETS as Record<string, Asset | undefined>)[`${host}-${backend}`]
  return asset && asset.bytes + (asset.companion?.bytes ?? 0)
}

/** llama.cpp and MLX through the existing `LocalRunners`. `stop()` is `runners.stop()`. */
export function textWorker(options: TextWorkerOptions): ComputeWorker & {
  models(): HostModel[]
  acquire(modelId: string, signal?: AbortSignal): Promise<RunnerLease>
} {
  const { dataDir, runners } = options
  const backend = options.backend ?? (async (preference) => (await runnerBackendProfile({ preference })).backend)
  const llamaSupported = options.llamaSupported ?? (() => runtimeSupported())
  const llamaReady = options.llamaReady ?? runtimeReady
  const mlxAvailable = options.mlxSupported ?? (() => mlxSupported())
  const mlxReady = options.mlxReady ?? mlxRuntimeReady
  const leases = new Set<RunnerLease>()
  const usable = () => readInstalled(dataDir).filter((one) => one.ready !== false && one.files.every((file) => existsSync(file)))

  return {
    id: TEXT_WORKER,
    loaded: () => runners.loaded() !== undefined,
    async stop() {
      // The broker waits for every lease before it stops an engine. A stop from the scheduler
      // means nothing is answering, so what is left is a selection: end it, and it is reacquired.
      for (const lease of [...leases]) lease.release()
      await runners.stop()
    },
    capabilities: async () => [],
    models() {
      const loaded = runners.loaded()?.model
      return usable().map((one) => {
        const row = asModel(one)
        return {
          id: row.id, name: row.name, engine: row.provider, context: row.context, supportsTools: row.supportsTools,
          modality: [...row.modality],
          ...(row.params !== undefined && { params: row.params }),
          ...(row.quant !== undefined && { quant: row.quant }),
          ...(row.diskBytes !== undefined && { diskBytes: row.diskBytes }),
          ...(row.abliterated !== undefined && { abliterated: row.abliterated }),
          loaded: loaded === one.id,
        }
      })
    },
    async setup() {
      const needs: SetupRequirement[] = []
      if (llamaSupported()) {
        const chosen = await backend('auto')
        const bytes = runtimeBytes(chosen)
        if (!llamaReady(dataDir, { backend: chosen })) needs.push({
          id: `${LLAMA_RUNTIME}${chosen}`, kind: 'runtime', title: 'llama.cpp runtime',
          detail: 'Runs GGUF models on this computer.',
          ...(bytes !== undefined && { bytes }), action: 'install', blocks: [CHAT],
        })
      }
      if (mlxAvailable() && !mlxReady(dataDir)) needs.push({
        id: MLX_RUNTIME, kind: 'runtime', title: 'MLX runtime',
        detail: 'Runs MLX models on Apple silicon.', action: 'install', blocks: [],
      })
      if (usable().length === 0) needs.push({
        id: 'model', kind: 'model', title: 'No model installed', action: 'instructions',
        instructions: 'Choose a model for this computer.', blocks: [CHAT],
      })
      return needs
    },
    async install(requirementId, io) {
      const onProgress = (p: { done: number; total: number }): void => io.progress({ progress: p.done, ...(p.total > 0 && { total: p.total }) })
      try {
        if (requirementId === MLX_RUNTIME) await (options.ensureMlx ?? ensureMlxRuntime)(dataDir, { signal: io.signal, onProgress })
        else {
          const chosen = BACKENDS.find((one) => requirementId === `${LLAMA_RUNTIME}${one}`)
          if (!chosen) throw new ComputeError('not-found', 'That setup requirement is not known.')
          await (options.ensureLlama ?? ensureRuntime)(dataDir, { backend: chosen, signal: io.signal, onProgress })
        }
      } catch (error) { throw failed(error, io.signal, 'The runtime could not be installed.') }
    },
    // An answer is streamed from the runner's own loopback address under a lease; it is not an operation.
    run: async () => { throw new ComputeError('not-found', 'That operation is not available on this computer.') },
    async acquire(modelId, signal) {
      const model = usable().find((one) => one.id === modelId)
      if (!model) throw new ComputeError('setup-required', 'That model is not installed on this computer.')
      try {
        // A missing runtime would be downloaded by the runner on first use. Here it is a
        // requirement with a button, so loading stops rather than install something unasked.
        const ready = model.format === 'mlx' ? mlxReady(dataDir) : llamaReady(dataDir, { backend: await backend(model.backend ?? 'auto') })
        if (!ready) throw new ComputeError('setup-required', 'The runtime for that model is not installed on this computer.')
        const prepared = await runners.provider(modelId).prepare!(modelId, signal)
        const inner = typeof prepared === 'string' ? { baseUrl: prepared } : prepared
        let released = false
        const lease: RunnerLease = {
          baseUrl: inner.baseUrl, key: inner.key ?? '',
          release: () => {
            if (released) return
            released = true
            leases.delete(lease)
            inner.release?.()
          },
        }
        leases.add(lease)
        return lease
      } catch (error) { throw failed(error, signal, 'The model could not be loaded.') }
    },
  }
}

type PluginSeam = Pick<Plugins, 'computeWorkers' | 'computeCall' | 'stopProcess'>
type Declared = ReturnType<Plugins['computeWorkers']>[number]

/** What each plugin worker was built from, so a re-read can tell an unchanged one from a new one. */
const declarations = new WeakMap<ComputeWorker, string>()

const words = (result: CallToolResult): string =>
  firstLine((result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('\n'))

/** Read a `setup` hook's answer. Anything malformed is dropped; a worker can block only what it declared. */
function requirements(result: CallToolResult, caps: readonly string[]): SetupRequirement[] {
  const said = (result.structuredContent as { requirements?: unknown } | undefined)?.requirements
  if (!Array.isArray(said)) return []
  return said.flatMap((item): SetupRequirement[] => {
    if (typeof item !== 'object' || item === null) return []
    const one = item as Record<string, unknown>
    const text = (key: string): string | undefined => (typeof one[key] === 'string' && one[key] !== '' ? one[key] : undefined)
    const id = text('id'), title = text('title'), kind = text('kind'), action = text('action'), detail = text('detail'), instructions = text('instructions')
    if (!id || !title || (kind !== 'runtime' && kind !== 'model' && kind !== 'dependency') || (action !== 'install' && action !== 'instructions')) return []
    return [{
      id, kind, title,
      ...(detail && { detail }),
      ...(typeof one.bytes === 'number' && Number.isSafeInteger(one.bytes) && one.bytes >= 0 && { bytes: one.bytes }),
      action,
      ...(instructions && { instructions }),
      blocks: Array.isArray(one.blocks) ? one.blocks.filter((cap): cap is string => typeof cap === 'string' && caps.includes(cap)) : [],
    }]
  })
}

function pluginWorker(plugins: PluginSeam, declared: Declared): ComputeWorker {
  const { handle, operations, hooks } = declared
  const caps = operations.map((op) => op.cap)
  // Whether a job has reached it since it was last stopped. The process is the plugin's own.
  let used = false
  const call = async (role: Parameters<Plugins['computeCall']>[1], args: Record<string, unknown>, io?: JobIo, timeout = WORK_MS): Promise<CallToolResult> => {
    let result: CallToolResult
    try {
      result = await plugins.computeCall(handle, role, args, {
        timeout,
        ...(io && { signal: io.signal, onprogress: ({ progress, total, message }) => io.progress({ progress, ...(total !== undefined && { total }), ...(message !== undefined && { message }) }) }),
      })
    } catch (error) { throw failed(error, io?.signal, 'The compute worker stopped answering.') }
    if (result.isError) throw failed(new Error(words(result)), io?.signal, 'The compute worker reported a failure.')
    return result
  }
  const worker: ComputeWorker = {
    id: handle,
    loaded: () => used,
    async stop(options) {
      if (!options?.force && used && hooks.includes('release')) await call('release', {}, undefined, RELEASE_MS).catch(() => {})
      used = false
      await plugins.stopProcess(handle, options)
    },
    capabilities: async () => operations.map((op) => ({ cap: op.cap, summary: op.summary, weight: op.weight ?? 'heavy', ready: true })),
    setup: async () => (hooks.includes('setup') ? requirements(await call('setup', {}), caps) : []),
    async install(requirementId, io) {
      if (!hooks.includes('install')) throw new ComputeError('refused', 'That requirement cannot be installed from here.')
      await call('install', { requirementId }, io)
    },
    async run(cap, args, io) {
      if (!caps.includes(cap)) throw new ComputeError('not-found', 'That operation is not available on this computer.')
      used = true
      if (hooks.includes('prepare')) await call('prepare', { cap }, { ...io, progress: () => {} })
      const result = await call('run', { cap, arguments: args }, io)
      const body = result.structuredContent as { text?: unknown; files?: unknown } | undefined
      const files = body?.files ?? []
      if (!Array.isArray(files) || !files.every((file): file is string => typeof file === 'string' && isAbsolute(file))) {
        throw new ComputeError('worker-failure', 'The compute worker returned files that cannot be read.')
      }
      return { ...(typeof body?.text === 'string' && { text: body.text }), files }
    },
  }
  declarations.set(worker, JSON.stringify(declared))
  return worker
}

/** One worker per enabled plugin that declares `compute` (§4). Re-read whenever the plugin list changes. */
export function pluginWorkers(plugins: PluginSeam): ComputeWorker[] {
  return plugins.computeWorkers().map((declared) => pluginWorker(plugins, declared))
}

export class Workers {
  #plugins: ComputeWorker[] = []
  readonly #listeners = new Set<() => void>()

  constructor(readonly text: ReturnType<typeof textWorker>, private readonly plugins: () => ComputeWorker[]) {
    this.#read()
  }

  all(): ComputeWorker[] {
    this.changed()
    return [this.text, ...this.#plugins]
  }

  /** The worker that declares this capability, or undefined. Never a name comparison. */
  async forCapability(cap: string): Promise<ComputeWorker | undefined> {
    for (const worker of this.all()) {
      if ((await worker.capabilities().catch(() => [])).some((one) => one.cap === cap)) return worker
    }
    return undefined
  }

  /** The plugin list may have changed: re-read it, and tell the listeners if the workers did. */
  changed(): void {
    if (!this.#read()) return
    for (const listener of [...this.#listeners]) { try { listener() } catch { /* A listener cannot stop the others hearing. */ } }
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /**
   * Keep a scheduler's registrations the same as this list. A worker that went away is
   * unregistered, which stops it and fails whatever job it was running `worker-failure`.
   */
  bind(scheduler: Scheduler): () => void {
    const bound = new Map<string, ComputeWorker>()
    const leaving = new Map<string, Promise<void>>()
    const sync = (): void => {
      const now = [this.text, ...this.#plugins]
      for (const [id, worker] of bound) {
        if (now.includes(worker)) continue
        bound.delete(id)
        const gone = scheduler.unregister(id).catch(() => {})
        leaving.set(id, gone)
        void gone.then(() => { if (leaving.get(id) === gone) leaving.delete(id) })
      }
      for (const worker of now) {
        if (bound.has(worker.id)) continue
        bound.set(worker.id, worker)
        const register = (): void => {
          if (bound.get(worker.id) !== worker) return
          try { scheduler.register(worker) } catch { bound.delete(worker.id) }
        }
        // A replaced worker shares its id with the one still stopping.
        const wait = leaving.get(worker.id)
        if (wait) void wait.then(register)
        else register()
      }
    }
    this.changed()
    sync()
    return this.onChange(sync)
  }

  /** Re-read the plugin workers, keeping each one whose declaration did not change. Returns whether the list did. */
  #read(): boolean {
    let fresh: ComputeWorker[]
    try { fresh = this.plugins() } catch { fresh = [] }
    const next = fresh.map((worker) =>
      this.#plugins.find((known) => known.id === worker.id && declarations.get(known) === declarations.get(worker)) ?? worker)
    const same = next.length === this.#plugins.length && next.every((worker, at) => worker === this.#plugins[at])
    this.#plugins = next
    return !same
  }
}
