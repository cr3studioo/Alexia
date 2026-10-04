// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { rememberLocalChoice, setPin, type Ran } from './commands.js'
import { downloadAll, DownloadError, partial } from './download.js'
import { bestQuant, DEFAULT_CONTEXT, fit, recommend, type Fit, type Verdict } from './fit.js'
import { repo as hfRepo, resolveUrl, search as hfSearch, type HfHit } from './hf.js'
import { asModel, forget, modelsDir, readInstalled, remember, type Installed } from './installed.js'
import { ensureRuntime, llamaProvider, runtimeReady, runtimeSupported, type LlamaServer } from './llama.js'
import { entry as vetted, LOCAL_CATALOG, QUANT_NOTES, type LocalEntry, type ModelFile, type Quantized } from './localCatalog.js'
import { machine, summary, type Machine } from './machine.js'
import type { ChatRequest } from './provider.js'
import { send } from './router.js'
import { CORE, memorySecrets } from './secrets.js'
import type { Store } from './store.js'
import { contextPreview, installedEntry, maintenance, type Cache } from './localSettings.js'
import type { LocalRunners } from './localRunners.js'
import { readGguf } from './gguf.js'
import { importGguf } from './importModel.js'
import { ensureMlxRuntime, mlxRuntimeReady, mlxSupported } from './mlx.js'
import { MLX_CATALOG } from './mlxCatalog.js'
import { repo as mlxRepo, search as mlxSearch } from './mlxHf.js'

/**
 * **One button: a model that fits this machine, downloaded, checked, started and chosen.**
 *
 * Everything the Settings page and first run's step 4b ask of core lives here, so the HTTP
 * routes in `serve.ts` are one line each. The pieces are elsewhere, each testable on its own:
 * what this machine is (`machine.ts`), what fits it (`fit.ts`), what exists (`localCatalog.ts`,
 * `hf.ts`), how bytes arrive (`download.ts`), and what runs them (`llama.ts`).
 *
 * **One install at a time.** Two multi-gigabyte downloads side by side are each half as fast,
 * and a person watching two bars learns less than one watching one. A second press while one
 * runs is refused with the name of the one running.
 *
 * **The bar never goes silent** (`Alexia.md`, *First run*). Every step says what it is doing in
 * words, and the download step says how many bytes and how fast. A step that has no numbers —
 * starting a 20 GB model can take a minute — still has a name, and the page counts the time.
 */

export type Step = 'queued' | 'runtime' | 'download' | 'verify' | 'start' | 'test' | 'done' | 'failed' | 'cancelled'

export interface Job {
  id: string
  /** What was asked for: `<entry>:<quant>` or `<repo>:<quant>`. */
  target: string
  name: string
  step: Step
  done: number
  total: number
  bytesPerSecond?: number
  /** The step in words, for the line under the bar. */
  message: string
  error?: string
  /** The installed model's id, once it is on the disk. */
  modelId?: string
  startedAt: number
}

export interface QuantCard {
  quant: string
  bytes: number
  needBytes: number
  verdict: Verdict
  note?: string
}

/** One model as the page draws it: at the size this machine should take, and every other size. */
export interface Card {
  format?: 'gguf' | 'mlx'
  entry: string
  name: string
  blurb: string
  publisher: string
  params: number
  quant: string
  bytes: number
  needBytes: number
  verdict: Verdict
  tokensPerSecond?: number
  tools: boolean
  vision: boolean
  licence: { name: string; url: string; restrictive: boolean }
  abliterated: boolean
  installed: boolean
  quants: QuantCard[]
}

export interface InstalledRow {
  format?: 'gguf' | 'mlx'
  owned?: boolean
  imported?: boolean
  contextMax?: number
  lastUsedAt?: number
  kvCache?: Cache
  draftModelId?: string
  ready?: boolean
  id: string
  name: string
  quant: string
  bytes: number
  vetted: boolean
  abliterated: boolean
  tools: boolean
  vision: boolean
  context: number
  tokensPerSecond?: number
  pinned: boolean
  licence?: string
}

export type Mode = 'local' | 'combined' | 'cloud'

export interface Overview {
  machine: Pick<Machine, 'ramBytes' | 'freeDiskBytes' | 'budgetBytes' | 'appleSilicon' | 'chip'> & { summary: string }
  runtime: { installed: boolean; version: string; supported: boolean }
  runtimes?: { llama: { installed: boolean; version: string; supported: boolean }; mlx: { installed: boolean; version: string; supported: boolean } }
  picks: { best?: Card; fast?: Card; tools?: Card }
  all: Card[]
  uncensored: Card[]
  installed: InstalledRow[]
  jobs: Job[]
  mode: Mode
}

/** What an install is of: a vetted entry, or a repo somebody found through search. */
export type Target = ({ entry: string; quant: string } | { repo: string; revision?: string; quant: string }) & { mode?: Mode; format?: 'gguf' | 'mlx' }

/** A second install while one runs, or a target that does not exist. Said to the page as a 409 or 400. */
export class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface LocalModelsOptions {
  dataDir: string
  store: Store
  server: LlamaServer
  runners?: LocalRunners
  /** Mode activation shares the main-window lifecycle, including pending selections. */
  activate?: (mode: Mode, model: string) => Ran
  modePending?: () => boolean
  /** A Hugging Face token, for gated repos found through search. Asked for only when needed. */
  hfToken?: () => Promise<string | undefined>
  /** Seams for tests: what the machine is, and whether the runtime is fetched for real. */
  catalog?: readonly LocalEntry[]
  machine?: () => Promise<Machine>
  ensureRuntime?: typeof ensureRuntime
  runtimeReady?: typeof runtimeReady
  ensureMlxRuntime?: typeof ensureMlxRuntime
  mlxRuntimeReady?: typeof mlxRuntimeReady
  fetch?: typeof fetch
  /** The first answer after install. The real one asks the model to say a word. */
  smoke?: (id: string, signal: AbortSignal) => Promise<{ tokensPerSecond?: number }>
}

/** Prefer 16k context when memory permits; smaller contexts remain available. */
const LARGE_CONTEXT = 16_384

const GB = 1024 ** 3

export class LocalModels {
  private readonly jobs = new Map<string, Job>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly pending = new Set<Promise<void>>()
  private mutating = false

  busy(): boolean { return this.mutating || [...this.jobs.values()].some((job) => !finished(job.step)) }

  private async mutation<T>(work: () => Promise<T>): Promise<T> {
    this.idle()
    this.mutating = true
    try { return await work() } finally { this.mutating = false }
  }

  constructor(private readonly options: LocalModelsOptions) {}

  private readonly catalog = (): readonly LocalEntry[] => this.options.catalog ?? [...LOCAL_CATALOG, ...MLX_CATALOG]
  private readonly curated = (id: string): LocalEntry | undefined => this.catalog().find((entry) => entry.id === id)

  private readonly runner = () => this.options.runners ?? this.options.server

  /** Older installations omitted cache and maximum-context metadata. Use only the same
   * pinned catalog revision and quantization; a catalog update must not relabel old weights. */
  private metadata(one: Installed): Installed {
    const entry = one.entry && this.curated(one.entry)
    const quant = entry && entry.quants.find((candidate) => candidate.quant === one.quant)
    if (!entry || !quant || entry.repo !== one.repo || entry.revision !== one.revision ||
      quant.bytes !== one.bytes || (entry.format ?? 'gguf') !== (one.format ?? 'gguf')) return one
    return {
      ...one,
      ...(one.contextMax === undefined && entry.contextMax > 0 && { contextMax: entry.contextMax }),
      ...(one.kvBytesPerToken === undefined && entry.kvBytesPerToken && { kvBytesPerToken: entry.kvBytesPerToken }),
    }
  }

  private one(id: string): Installed {
    const one = readInstalled(this.options.dataDir).find((model) => model.id === id)
    if (!one || !one.files.every((file) => existsSync(file))) throw new Refused(404, 'That model is not installed or its files are missing.')
    if (one.format === 'mlx' && !this.options.runners) throw new Refused(409, 'The MLX runner is not available.')
    return this.metadata(one)
  }

  private idle(): void {
    if (this.busy()) throw new Refused(409, 'Wait for the current local-model operation, or cancel its job first.')
  }

  async context(id: string, context?: number, kvCache?: Cache, draftModelId?: string | null) {
    const one = this.one(id)
    const m = await this.here()
    try {
      return contextPreview(m, one, readInstalled(this.options.dataDir), context ?? one.context,
        kvCache ?? one.kvCache ?? 'f16', draftModelId === undefined ? one.draftModelId : draftModelId)
    } catch (error) { throw new Refused(400, error instanceof Error ? error.message : String(error)) }
  }

  async configure(id: string, context: number, kvCache: Cache, draftModelId?: string | null) {
    return this.mutation(async () => {
      const one = this.one(id)
      if (one.ready === false) throw new Refused(409, 'Retry the installation before configuring this model.')
      let preview: Awaited<ReturnType<LocalModels['context']>>
      try { preview = await this.context(id, context, kvCache, draftModelId) }
      catch (error) { throw new Refused(400, error instanceof Error ? error.message : String(error)) }
      if (preview.verdict === 'too-big') throw new Refused(409, 'This context and draft exceed the available memory budget.')
      if (this.runner().loaded()) await this.runner().stop()
      const configured: Installed = { ...this.one(id), context, kvCache }
      if (draftModelId === null) delete configured.draftModelId
      else if (draftModelId !== undefined) configured.draftModelId = draftModelId
      remember(this.options.dataDir, configured)
      return { ok: true, said: `${one.name} will use ${context.toLocaleString()} tokens of context at its next start.` }
    })
  }

  async maintenance() {
    return maintenance(await this.here(), readInstalled(this.options.dataDir), this.catalog(), this.pinned())
  }

  async importPreview(path: string) {
    if (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path)) throw new Refused(400, 'Choose an absolute path to a GGUF file on this computer.')
    try {
      const meta = await readGguf(path)
      return { name: meta.name, quant: meta.quant, bytes: meta.bytes, contextMax: meta.contextMax }
    } catch (error) { throw new Refused(400, error instanceof Error ? error.message : String(error)) }
  }

  /** Local imports are checked by the same chat path before they become selectable. */
  import(path: string, storage: 'copy' | 'reference' = 'copy', mode?: Mode): Job {
    if (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path)) throw new Refused(400, 'Choose an absolute path to a GGUF file on this computer.')
    if (!existsSync(path)) throw new Refused(400, 'That local model file is missing.')
    if (!['copy', 'reference'].includes(storage)) throw new Refused(400, 'Choose Copy or Reference for the imported files.')
    if (mode !== undefined && !['local', 'combined'].includes(mode)) throw new Refused(400, 'Choose Local or Combined.')
    if (this.mode() === 'cloud' && mode === undefined) throw new Refused(409, 'Choose Local or Combined before importing and using a local model.')
    const startingMode = this.mode()
    return this.launch(`import:${path}`, 'Importing a local model', async (job, signal) => {
      let previous: Installed | undefined
      const set = (change: Partial<Job>): void => void Object.assign(job, change)
      try {
        set({ step: 'verify', message: 'Reading and checking the local model' })
        const imported = await importGguf(path, this.options.dataDir, { mode: storage, signal, onProgress: (p) => set({ done: p.done, total: p.total }) })
        const m = await this.here()
        const entry = { ...installedEntry(imported), contextMax: imported.contextMax ?? imported.context }
        imported.context = contextFor(m, entry, entry.quants[0]!)
        const judged = contextPreview(m, imported, readInstalled(this.options.dataDir))
        if (judged.verdict === 'too-big') throw new Error('The imported model exceeds the available memory budget.')
        previous = readInstalled(this.options.dataDir).find((one) => one.id === imported.id)
        remember(this.options.dataDir, imported)
        set({ modelId: imported.id, step: 'runtime', message: 'Getting the model runner' })
        await (this.options.ensureRuntime ?? ensureRuntime)(this.options.dataDir, { signal, onProgress: (p) => set({ done: p.done, total: p.total }) })
        set({ step: 'start', message: 'Starting the imported model', done: 0, total: 0 })
        await this.runner().ensure(imported.id, signal)
        set({ step: 'test', message: 'Trying the imported model' })
        const tried = await (this.options.smoke ?? ((id, s) => this.smoke(id, s)))(imported.id, signal)
        signal.throwIfAborted()
        remember(this.options.dataDir, { ...this.one(imported.id), ...tried, ready: true, lastUsedAt: Date.now() })
        rememberLocalChoice(this.options.store, imported.id)
        const currentMode = this.mode()
        if (!this.options.modePending?.() && !(currentMode !== startingMode && currentMode === 'cloud')) {
          if (mode && this.options.activate) this.options.activate(mode, imported.id)
          else {
            if (mode && currentMode === startingMode) this.options.store.kvSet(CORE, 'mode', mode)
            setPin(this.options.store, { model: imported.id })
          }
        }
        set({ step: 'done', message: currentMode !== startingMode && currentMode === 'cloud' ? 'The model is imported. Choose Use when you want to activate it.' : 'The imported model is ready and chosen.' })
      } catch (error) {
        if (job.modelId && this.runner().loaded()?.model === job.modelId) await this.runner().stop().catch(() => {})
        if (previous) remember(this.options.dataDir, previous)
        else if (job.modelId) forget(this.options.dataDir, job.modelId)
        set(signal.aborted ? { step: 'cancelled', message: 'Import cancelled. Original files are kept.' } : { step: 'failed', message: 'Import did not finish.', error: error instanceof Error ? error.message : String(error) })
      }
    })
  }

  benchmark(id: string): Job {
    const one = this.one(id)
    if (one.ready === false) throw new Refused(409, 'Finish the installation check before measuring this model.')
    return this.launch(`benchmark:${id}`, `Measuring ${one.name}`, async (job, signal) => {
      try {
        Object.assign(job, { step: 'start', modelId: id, message: 'Starting the model for a short local measurement' })
        await this.runner().ensure(id, signal)
        Object.assign(job, { step: 'test', message: 'Measuring a short answer on this computer' })
        const tried = await this.smoke(id, signal)
        signal.throwIfAborted()
        remember(this.options.dataDir, { ...this.one(id), ...tried, lastUsedAt: Date.now() })
        Object.assign(job, { step: 'done', message: tried.tokensPerSecond === undefined ? 'The model answered; there were too few timed tokens for a useful speed figure.' : `${tried.tokensPerSecond} tokens per second on this computer.` })
      } catch (error) {
        Object.assign(job, signal.aborted ? { step: 'cancelled', message: 'Measurement cancelled.' } : { step: 'failed', message: 'Measurement did not finish.', error: error instanceof Error ? error.message : String(error) })
      }
    })
  }

  private launch(target: string, name: string, work: (job: Job, signal: AbortSignal) => Promise<void>): Job {
    this.idle()
    for (const [id, old] of this.jobs) if (finished(old.step)) this.jobs.delete(id)
    const job: Job = { id: randomUUID(), target, name, step: 'queued', done: 0, total: 0, message: 'Getting ready', startedAt: Date.now() }
    this.jobs.set(job.id, job)
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    const pending = work(job, controller.signal).finally(() => { this.controllers.delete(job.id); this.pending.delete(pending) })
    this.pending.add(pending)
    return job
  }

  private readonly here = (): Promise<Machine> => (this.options.machine ?? (() => machine(this.options.dataDir)))()

  /** Everything the page draws, asked fresh: free disk moves while a download runs. */
  async overview(): Promise<Overview> {
    const m = await this.here()
    const picks = recommend(m, this.catalog().filter((entry) => entry.format !== 'mlx' || (mlxSupported(m.platform, m.arch) && this.options.runners !== undefined)))
    const installed = readInstalled(this.options.dataDir).map((one) => this.metadata(one))
    const have = new Set(installed.filter((one) => one.ready !== false && one.files.every((file) => existsSync(file))).map((one) => `${one.entry}:${one.quant}`))
    const card = (f: Fit): Card => this.card(m, f, have.has(`${f.entry.id}:${f.quant.quant}`))
    const pinned = this.pinned()
    const ready = (this.options.runtimeReady ?? runtimeReady)(this.options.dataDir)
    const mlx = (this.options.mlxRuntimeReady ?? mlxRuntimeReady)(this.options.dataDir)
    const llamaRuntime = { installed: ready !== undefined, version: ready?.version ?? '', supported: supported(m) }
    const mlxRuntime = { installed: mlx !== undefined, version: mlx?.version ?? '', supported: mlxSupported(m.platform, m.arch) && this.options.runners !== undefined }
    return {
      machine: {
        summary: summary(m),
        ramBytes: m.ramBytes,
        freeDiskBytes: m.freeDiskBytes,
        budgetBytes: m.budgetBytes,
        appleSilicon: m.appleSilicon,
        chip: m.chip,
      },
      runtime: { ...llamaRuntime, supported: llamaRuntime.supported || mlxRuntime.supported },
      runtimes: { llama: llamaRuntime, mlx: mlxRuntime },
      picks: {
        ...(picks.best && { best: card(picks.best) }),
        ...(picks.fast && { fast: card(picks.fast) }),
        ...(picks.tools && { tools: card(picks.tools) }),
      },
      all: picks.all.map(card),
      uncensored: picks.uncensored.map(card),
      installed: installed
        .filter((one) => one.files.every((file) => existsSync(file)))
        .map((one) => ({
          id: one.id,
          format: one.format ?? 'gguf',
          owned: one.owned !== false,
          imported: one.imported === true,
          contextMax: one.contextMax ?? one.context,
          ...(one.lastUsedAt !== undefined && { lastUsedAt: one.lastUsedAt }),
          kvCache: one.kvCache ?? 'f16',
          ...(one.draftModelId && { draftModelId: one.draftModelId }),
          ready: one.ready !== false,
          name: one.name,
          quant: one.quant,
          bytes: one.bytes,
          vetted: one.vetted,
          abliterated: one.abliterated,
          tools: one.tools,
          vision: one.vision,
          context: one.context,
          pinned: one.id === pinned,
          ...(one.tokensPerSecond !== undefined && { tokensPerSecond: one.tokensPerSecond }),
          ...(one.licence !== undefined && { licence: one.licence }),
        })),
      jobs: [...this.jobs.values()],
      mode: this.mode(),
    }
  }

  private card(m: Machine, f: Fit, installed: boolean): Card {
    const e = f.entry
    return {
      entry: e.id,
      format: e.format ?? 'gguf',
      name: e.name,
      blurb: e.blurb,
      publisher: e.publisher,
      params: e.params,
      quant: f.quant.quant,
      bytes: f.quant.bytes,
      needBytes: f.needBytes,
      verdict: f.verdict,
      ...(f.tokensPerSecond !== undefined && { tokensPerSecond: f.tokensPerSecond }),
      tools: e.tools,
      vision: false,
      licence: e.licence,
      abliterated: e.abliterated,
      installed,
      quants: e.quants.map((q) => quantCard(fit(m, e, q), q.quant)),
    }
  }

  /** How the Hugging Face page of one repo fits this machine. Unvetted, and said so by the page. */
  async hf(repoId: string, format: 'gguf' | 'mlx' = 'gguf'): Promise<{ repo: string; revision: string; licence?: string; gated: boolean; params?: number; quants: QuantCard[] }> {
    const m = await this.here()
    const token = await this.options.hfToken?.()
    if (format === 'mlx' && !mlxSupported(m.platform, m.arch)) throw new Refused(400, 'MLX needs Apple Silicon.')
    const found = await (format === 'mlx' ? mlxRepo : hfRepo)(repoId, { ...(token !== undefined && { token }), ...(this.options.fetch && { fetch: this.options.fetch }) })
    const pseudo = searchEntry(found, format)
    return {
      repo: found.repo,
      revision: found.revision,
      gated: found.gated,
      ...(found.licence !== undefined && { licence: found.licence }),
      ...(found.params !== undefined && { params: found.params }),
      quants: found.quants.map((q) => quantCard(fit(m, pseudo, q, contextFor(m, pseudo, q)), q.quant)),
    }
  }

  async search(query: string, format: 'gguf' | 'mlx' = 'gguf'): Promise<HfHit[]> {
    const token = await this.options.hfToken?.()
    return (format === 'mlx' ? mlxSearch : hfSearch)(query, { ...(token !== undefined && { token }), ...(this.options.fetch && { fetch: this.options.fetch }) })
  }

  job(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  /** Start an install and return at once; the page polls {@link job}. */
  install(target: Target): Job {
    if (!target || typeof target.quant !== 'string' || !/^[A-Z0-9_]{2,20}$/i.test(target.quant)) throw new Refused(400, 'Choose a valid quantization.')
    if (!('entry' in target) && !('repo' in target)) throw new Refused(400, 'Choose a catalog entry or Hugging Face repository.')
    if ('repo' in target && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(target.repo)) throw new Refused(400, 'Use a Hugging Face publisher/model repository.')
    if (target.mode !== undefined && !['local', 'combined'].includes(target.mode)) throw new Refused(400, 'Choose Local or Combined to use this model.')
    if (target.format !== undefined && !['gguf', 'mlx'].includes(target.format)) throw new Refused(400, 'Choose GGUF or MLX.')
    if (this.mode() === 'cloud' && target.mode === undefined) throw new Refused(409, 'Choose Local or Combined before installing and using a local model.')
    if (this.mutating) this.idle()
    const running = [...this.jobs.values()].find((j) => !finished(j.step))
    if (running) throw new Refused(409, `${running.name} is still being installed. Wait for it, or cancel it first.`)
    if ('entry' in target && this.curated(target.entry) === undefined) throw new Refused(400, 'That model is not on the list any more.')
    if ('revision' in target && target.revision !== undefined && !/^[a-f0-9]{40}$/i.test(target.revision)) throw new Refused(400, 'Choose a full commit revision.')
    if ('entry' in target) {
      const entry = this.curated(target.entry)!
      if (target.format && target.format !== (entry.format ?? 'gguf')) throw new Refused(400, 'The requested format does not match this catalog entry.')
      if (!entry.quants.some((q) => q.quant === target.quant)) throw new Refused(400, 'Choose a quantization offered by this model.')
    }
    const name = 'entry' in target ? (this.curated(target.entry)?.name ?? target.entry) : target.repo.split('/').at(-1) ?? target.repo
    const job: Job = {
      id: randomUUID(),
      target: `${'entry' in target ? target.entry : target.repo}:${target.quant}`,
      name: `${name} (${target.quant})`,
      step: 'queued',
      done: 0,
      total: 0,
      message: 'Getting ready',
      startedAt: Date.now(),
    }
    // Finished jobs are kept only until the next one starts: the page needs the last result, not a history.
    for (const [id, old] of this.jobs) if (finished(old.step)) this.jobs.delete(id)
    this.jobs.set(job.id, job)
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    const pending = this.run(job, target, controller.signal, this.mode()).finally(() => {
      this.controllers.delete(job.id)
      this.pending.delete(pending)
    })
    this.pending.add(pending)
    return job
  }

  /** Stop an install. What has downloaded stays as a `.part`, so pressing Install again resumes. */
  cancel(id: string): boolean {
    const controller = this.controllers.get(id)
    if (!controller) return false
    controller.abort()
    return true
  }

  private async run(job: Job, target: Target, signal: AbortSignal, startingMode: Mode): Promise<void> {
    const set = (change: Partial<Job>): void => void Object.assign(job, change)
    let previous: Installed | undefined
    try {
      const m = await this.here()
      // What is being fetched, as one shape whichever list it came from.
      const plan = await this.resolve(target, m)
      if (plan.format === 'mlx' ? !mlxSupported(m.platform, m.arch) || !this.options.runners : !supported(m)) throw new Error(`This model runner is not available on ${m.platform}-${m.arch}.`)
      signal.throwIfAborted()
      const folder = join(modelsDir(this.options.dataDir), ...plan.repo.split('/'), plan.revision)
      const saved = plan.quant.files.reduce((total, file) => {
        const have = partial(within(folder, file.name))
        return total + Math.min(file.bytes, Math.max(have.done, have.part))
      }, 0)
      const judged = fit({ ...m, freeDiskBytes: m.freeDiskBytes + saved }, plan.entry ?? { ...pseudoEntry(plan.repo, plan.revision, plan.params, [plan.quant]), format: plan.format, contextMax: plan.contextMax, kvBytesPerToken: plan.kvBytesPerToken }, plan.quant, plan.context)
      if (judged.verdict === 'too-big' || judged.verdict === 'disk') throw new Error(judged.verdict === 'disk' ? 'There is not enough free disk space for this model.' : 'This model exceeds the available memory budget. Choose a smaller model or quantization.')
      if (plan.quant.files.some((file) => !/^[a-f0-9]{64}$/i.test(file.sha256))) throw new Error('This model has no verifiable SHA-256 checksum.')

      set({ step: 'runtime', message: 'Getting the model runner', done: 0, total: 0 })
      await (plan.format === 'mlx' ? this.options.ensureMlxRuntime ?? ensureMlxRuntime : this.options.ensureRuntime ?? ensureRuntime)(this.options.dataDir, {
        signal,
        onProgress: (p) => set({ done: p.done, total: p.total, ...(p.bytesPerSecond !== undefined && { bytesPerSecond: p.bytesPerSecond }) }),
      })

      set({ step: 'download', message: `Downloading ${plan.name}`, done: 0, total: plan.quant.bytes + (plan.projector?.bytes ?? 0) })
      const token = plan.vetted ? undefined : await this.options.hfToken?.()
      const part = (file: ModelFile) => ({
        url: resolveUrl(plan.repo, plan.revision, file.name),
        to: within(folder, file.name),
        bytes: file.bytes,
        ...(file.sha256 !== '' && { sha256: file.sha256 }),
      })
      const parts = plan.quant.files.map(part)
      // The projector comes from the same pinned revision and is checked the same way.
      const projector = plan.projector && part(plan.projector)
      if (plan.projector && !/^[a-f0-9]{64}$/i.test(plan.projector.sha256)) throw new Error('This model\'s projector has no verifiable SHA-256 checksum.')
      await downloadAll(projector ? [...parts, projector] : parts, {
        signal,
        // A gigabyte of room left over after the model, so the download is not what fills the disk.
        minFreeBytes: GB,
        ...(token !== undefined && { headers: { authorization: `Bearer ${token}` } }),
        ...(this.options.fetch && { fetch: this.options.fetch }),
        onProgress: (p) => {
          // The hash is checked as the bytes arrive, so the last bytes are also the check.
          const verifying = p.total > 0 && p.done >= p.total
          set({
            done: p.done,
            total: p.total,
            ...(p.bytesPerSecond !== undefined && { bytesPerSecond: p.bytesPerSecond }),
            ...(verifying && { step: 'verify' as const, message: 'Checking the file' }),
          })
        },
      })
      set({ step: 'verify', message: 'Checking the file' })

      const id = `${plan.format === 'mlx' ? 'mlx' : 'llama'}/${plan.id}:${plan.quant.quant}`.toLowerCase()
      previous = readInstalled(this.options.dataDir).find((one) => one.id === id)
      const record: Installed = {
        id,
        format: plan.format,
        owned: true,
        name: `${plan.name} ${plan.quant.quant}`,
        ...(plan.entry !== undefined && { entry: plan.entry.id }),
        repo: plan.repo,
        revision: plan.revision,
        quant: plan.quant.quant,
        files: parts.map((p) => p.to),
        ...(projector && { projector: projector.to }),
        bytes: plan.quant.bytes,
        ...(plan.params > 0 && { params: plan.params }),
        context: plan.context,
        ...(plan.contextMax > 0 && { contextMax: plan.contextMax }),
        ...(plan.kvBytesPerToken && { kvBytesPerToken: plan.kvBytesPerToken }),
        ...(plan.architecture && { architecture: plan.architecture }),
        ...(plan.tokenizerFingerprint && { tokenizerFingerprint: plan.tokenizerFingerprint }),
        tools: false,
        // Pictures need the projector beside the model: only an entry that brought one, now on
        // disk and checked, says *vision* — otherwise a picture would go to a model that cannot see it.
        vision: projector !== undefined,
        abliterated: plan.abliterated,
        nsfwOk: plan.entry?.nsfwOk ?? 'unknown',
        ...(plan.licence !== undefined && { licence: plan.licence }),
        vetted: plan.vetted,
        installedAt: Date.now(),
        ready: false,
      }
      if (plan.format === 'gguf') {
        // Metadata adds import/context/draft information; the runner's chat check remains
        // the compatibility check for hashes already pinned by the catalog.
        try {
          const meta = await readGguf(record.files[0]!)
          Object.assign(record, { tokenizerFingerprint: meta.tokenizerFingerprint, architecture: meta.architecture })
        } catch { /* No tokenizer identity means no speculative draft is offered. */ }
      }
      remember(this.options.dataDir, record)
      set({ modelId: id })

      set({ step: 'start', message: `Starting ${plan.name}`, done: 0, total: 0 })
      await this.runner().ensure(id, signal)

      set({ step: 'test', message: 'Trying it out' })
      const tried = await (this.options.smoke ?? ((one, s) => this.smoke(one, s)))(id, signal)
      signal.throwIfAborted()
      let tools = false
      if (plan.tools) tools = await this.probeTools(id, signal)
      signal.throwIfAborted()
      remember(this.options.dataDir, { ...this.one(id), tools, ...tried, ready: true, lastUsedAt: Date.now() })
      rememberLocalChoice(this.options.store, id)

      // Chosen, as *Use this* on the Models table would. The mode is not changed here: the
      // page asks when it is Cloud, because switching where everything runs is not implied by
      // having downloaded something.
      const currentMode = this.mode()
      if (this.options.modePending?.() || (currentMode !== startingMode && currentMode === 'cloud')) {
        set({ step: 'done', message: `${plan.name} is installed. ${this.options.modePending?.() ? 'The selected mode will be respected' : 'Cloud was selected during the download'}; choose Use when you want to activate it.`, done: 0, total: 0 })
        return
      }
      if (target.mode !== undefined && this.options.activate) {
        const activation = this.options.activate(target.mode, id)
        set({ step: 'done', message: `${plan.name} is installed. ${activation.note}`, done: 0, total: 0 })
        return
      }
      if (target.mode !== undefined && currentMode === startingMode) this.options.store.kvSet(CORE, 'mode', target.mode)
      setPin(this.options.store, { model: id })
      set({ step: 'done', message: `${plan.name} is ready and chosen${plan.tools && !tools ? ' for chat; its tool check did not pass' : ''}`, done: 0, total: 0 })
    } catch (error) {
      if (job.modelId !== undefined && this.runner().loaded()?.model === job.modelId) await this.runner().stop().catch(() => {})
      // A failed replacement must leave a previously checked installation usable.
      if (previous) remember(this.options.dataDir, previous)
      if (signal.aborted || (error instanceof DownloadError && error.kind === 'aborted')) {
        set({ step: 'cancelled', message: 'Cancelled. What was downloaded is kept, so installing again carries on from there.' })
        return
      }
      const said = error instanceof Error ? error.message : String(error)
      set({ step: 'failed', message: 'It did not finish', error: said })
    }
  }

  /** The one shape an install needs, from a vetted entry or a Hugging Face repo. */
  private async resolve(
    target: Target,
    m: Machine,
  ): Promise<{
    id: string
    name: string
    entry?: LocalEntry
    repo: string
    revision: string
    quant: Quantized
    format: 'gguf' | 'mlx'
    contextMax: number
    kvBytesPerToken?: number
    architecture?: string
    tokenizerFingerprint?: string
    params: number
    context: number
    tools: boolean
    abliterated: boolean
    licence?: string
    vetted: boolean
    /** A vision entry's projector, fetched and checked with the model. */
    projector?: ModelFile
  }> {
    if ('entry' in target) {
      const e = this.curated(target.entry)
      const quant = e?.quants.find((q) => q.quant === target.quant)
      if (!e || !quant) throw new Error(`${target.entry} has no ${target.quant} build.`)
      return {
        id: e.id,
        format: e.format ?? 'gguf',
        contextMax: e.contextMax,
        ...(e.kvBytesPerToken && { kvBytesPerToken: e.kvBytesPerToken }),
        name: e.name,
        entry: e,
        repo: e.repo,
        revision: e.revision,
        quant,
        params: e.params,
        context: contextFor(m, e, quant),
        tools: e.tools,
        abliterated: e.abliterated,
        licence: e.licence.name,
        vetted: true,
        ...(e.projector !== undefined && { projector: e.projector }),
      }
    }
    const token = await this.options.hfToken?.()
    const format = target.format ?? 'gguf'
    const found = await (format === 'mlx' ? mlxRepo : hfRepo)(target.repo, {
      ...(target.revision !== undefined && { revision: target.revision }),
      ...(token !== undefined && { token }),
      ...(this.options.fetch && { fetch: this.options.fetch }),
    })
    const quant = found.quants.find((q) => q.quant === target.quant)
    if (!quant) throw new Error(`${target.repo} has no ${target.quant} file.`)
    const params = found.params ?? 0
    const abliterated = /abliterat|uncensor/i.test(found.repo)
    return {
      id: slug(found.repo),
      format,
      contextMax: 'contextMax' in found && typeof found.contextMax === 'number' ? found.contextMax : DEFAULT_CONTEXT,
      ...('kvBytesPerToken' in found && typeof found.kvBytesPerToken === 'number' && { kvBytesPerToken: found.kvBytesPerToken }),
      ...('architecture' in found && typeof found.architecture === 'string' && { architecture: found.architecture }),
      ...('tokenizerFingerprint' in found && typeof found.tokenizerFingerprint === 'string' && { tokenizerFingerprint: found.tokenizerFingerprint }),
      name: found.repo.split('/').at(-1)?.replace(/-?GGUF$/i, '') ?? found.repo,
      repo: found.repo,
      revision: found.revision,
      quant,
      params,
      context: contextFor(m, searchEntry(found, format), quant),
      // Not known from the outside. A model whose tool use nobody checked is not offered for
      // work that needs it; the Models table's *Use this* can still pin it for talking.
      tools: false,
      abliterated,
      ...(found.licence !== undefined && { licence: found.licence }),
      vetted: false,
    }
  }

  /**
   * **The first answer**: one short question, answered. It catches the model that loads and then
   * cannot say anything — a broken file, a chat template the runner does not know — before it is
   * chosen, rather than on the person's first real question. How fast it answered is kept.
   */
  private async smoke(id: string, signal: AbortSignal): Promise<{ tokensPerSecond?: number }> {
    let firstWord: number | undefined
    const answered = await this.check(id, {
      messages: [{ role: 'user', content: 'Reply with this sentence: The local model is ready to answer on this computer. /no_think' }],
      maxTokens: 64,
      signal,
    }, () => { firstWord ??= Date.now() })
    const seconds = firstWord === undefined ? 0 : (Date.now() - firstWord) / 1000
    const text = typeof answered.message.content === 'string' ? answered.message.content : ''
    if (text.trim() === '') throw new Error('The model started but said nothing back.')
    return answered.usage.out > 0 && seconds >= 0.01 ? { tokensPerSecond: Math.round((answered.usage.out / seconds) * 10) / 10 } : {}
  }

  /** Installation checks take the same redaction and accounting path as every model call. */
  private async check(id: string, request: Omit<ChatRequest, 'model'>, onDelta?: (text: string) => void) {
    const one = readInstalled(this.options.dataDir).find((model) => model.id === id)
    if (!one) throw new Error('The model disappeared before it could be checked.')
    return send([{ model: asModel(one), provider: this.options.runners?.provider(id) ?? llamaProvider(this.options.server) }], request, this.options.store, memorySecrets(), { onDelta, source: 'test' })
  }

  private async probeTools(id: string, signal: AbortSignal): Promise<boolean> {
    try {
      const result = await this.check(id, {
        messages: [{ role: 'user', content: 'Call the readiness_check tool with value "ready". Do not answer in text. /no_think' }],
        tools: [{ name: 'readiness_check', description: 'Report that the model is ready.', parameters: { type: 'object', properties: { value: { type: 'string', enum: ['ready'] } }, required: ['value'], additionalProperties: false } }],
        maxTokens: 128,
        signal,
      })
      return result.message.calls?.some((call) => call.name === 'readiness_check' && (JSON.parse(call.arguments) as { value?: string }).value === 'ready') === true
    } catch (error) {
      if (signal.aborted) throw error
      return false
    }
  }

  /** Abort and settle downloads before the store and runner are closed. */
  async close(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort()
    await Promise.allSettled(this.pending)
  }

  /** Choose an installed model, and where everything runs if the person said. */
  use(id: string, mode?: Mode): { ok: boolean; said: string; data?: unknown } {
    this.idle()
    if (mode !== undefined && !['local', 'combined'].includes(mode)) throw new Refused(400, 'Choose Local or Combined.')
    const one = readInstalled(this.options.dataDir).find((i) => i.id === id)
    if (!one || !one.files.every((file) => existsSync(file))) return { ok: false, said: 'That model is not installed any more.' }
    if (one.format === 'mlx' && !this.options.runners) throw new Refused(409, 'The MLX runner is not available.')
    if (one.ready === false) return { ok: false, said: 'This model did not pass its installation check. Retry the installation before choosing it.' }
    if (this.mode() === 'cloud' && mode === undefined) return { ok: false, said: 'Choose Local or Combined to use a local model.' }
    if (this.options.activate && (mode !== undefined || this.mode() === 'local')) {
      const ran = this.options.activate(mode ?? 'local', id)
      return { ok: ran.ok, said: ran.note, ...(ran.data !== undefined && { data: ran.data }) }
    }
    setPin(this.options.store, { model: id })
    if (mode !== undefined) this.options.store.kvSet(CORE, 'mode', mode)
    const where = mode === 'local' ? ' Local mode is selected.' : mode === 'combined' ? ' Combined mode is selected.' : ''
    return { ok: true, said: `Every request now goes to ${one.name}, running here.${where}` }
  }

  /** Delete one: the files, its line on the list, and the pin if it was the chosen one. */
  async remove(id: string): Promise<{ ok: boolean; said: string }> {
    return this.mutation(async () => {
      const one = readInstalled(this.options.dataDir).find((model) => model.id === id)
      if (!one) return { ok: false, said: 'That model is not installed.' }
      const root = modelsDir(this.options.dataDir)
      for (const file of one.owned === false ? [] : one.files) {
        // `relative` spells a nested path with backslashes on Windows, which `within` refuses in a name.
        within(root, relative(root, file).split(sep).join('/'))
        if (existsSync(file)) within(realpathSync(root), relative(realpathSync(root), realpathSync(file)).split(sep).join('/'))
      }
      if (this.runner().loaded()?.model === id || readInstalled(this.options.dataDir).some((parent) => parent.draftModelId === id && this.runner().loaded()?.model === parent.id)) await this.runner().stop()
      const shared = new Set(readInstalled(this.options.dataDir).filter((model) => model.id !== id).flatMap((model) => model.files))
      for (const file of one.owned === false ? [] : one.files) {
        if (shared.has(file)) continue
        rmSync(file, { force: true })
        rmSync(`${file}.part`, { force: true })
      }
      forget(this.options.dataDir, id)
      for (const parent of readInstalled(this.options.dataDir)) if (parent.draftModelId === id) {
        const rest = { ...parent }
        delete rest.draftModelId
        remember(this.options.dataDir, rest)
      }
      // Empty folders are harmless and may contain another quantization or a resumable file.
      if (this.pinned() === id) setPin(this.options.store, { model: undefined })
      return { ok: true, said: one.owned === false ? `${one.name} is removed from Alexia. Its original files are kept.` : `${one.name} is removed, and ${(one.bytes / GB).toFixed(1)} GB is free again.` }
    })
  }

  private pinned(): string | undefined {
    return (this.options.store.kvGet(CORE, 'pins') as { model?: string } | undefined)?.model
  }

  private mode(): Mode {
    return (this.options.store.kvGet(CORE, 'mode') as Mode | undefined) ?? 'combined'
  }
}

const finished = (step: Step): boolean => step === 'done' || step === 'failed' || step === 'cancelled'

/** Where there is a runner build for. The rest are told so rather than shown a button that fails. */
const supported = (m: Pick<Machine, 'platform' | 'arch'>): boolean =>
  runtimeSupported(m.platform, m.arch)

const quantCard = (f: Fit, quant: string): QuantCard => ({
  quant,
  bytes: f.quant.bytes,
  needBytes: f.needBytes,
  verdict: f.verdict,
  ...([QUANT_NOTES[quant], f.note].filter(Boolean).length > 0 && { note: [QUANT_NOTES[quant], f.note].filter(Boolean).join(' ') }),
})

/** The bigger context when it still fits, which is when Alexia's longer prompts go through whole. */
function contextFor(m: Machine, e: LocalEntry, quant: Quantized): number {
  const most = e.contextMax > 0 ? e.contextMax : DEFAULT_CONTEXT
  const memory = { ...m, freeDiskBytes: Number.MAX_SAFE_INTEGER, diskKnown: true }
  const choices = [...new Set([LARGE_CONTEXT, DEFAULT_CONTEXT, 4096, 2048, 512, 256].map((size) => Math.min(most, size)))]
  return choices.find((size) => fit(memory, e, quant, size).verdict === 'fits')
    ?? choices.find((size) => fit(memory, e, quant, size).verdict === 'tight')
    ?? Math.min(most, 256)
}

function searchEntry(found: { repo: string; revision: string; params?: number; quants: Quantized[]; contextMax?: number; kvBytesPerToken?: number }, format: 'gguf' | 'mlx'): LocalEntry {
  return { ...pseudoEntry(found.repo, found.revision, found.params ?? 0, found.quants), format,
    contextMax: found.contextMax ?? DEFAULT_CONTEXT, kvBytesPerToken: found.kvBytesPerToken }
}

/** A search result dressed as an entry, so the same fit arithmetic judges it. */
function pseudoEntry(repo: string, revision: string, params: number, quants: Quantized[]): LocalEntry {
  return {
    id: slug(repo),
    name: repo,
    publisher: repo.split('/')[0] ?? repo,
    repo,
    revision,
    params,
    contextMax: 0,
    tools: false,
    vision: false,
    licence: { name: 'unknown', url: `https://huggingface.co/${repo}`, restrictive: false },
    gated: false,
    abliterated: /abliterat|uncensor/i.test(repo),
    nsfwOk: 'unknown',
    blurb: '',
    quants,
  }
}

/** `bartowski/Qwen_Qwen3-8B-GGUF` → `qwen_qwen3-8b`: an id that reads as the model, not the uploader. */
const slug = (repo: string): string =>
  repo.replace('/', '--')
    .replace(/-?GGUF$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')

/** The quant this machine should take of a vetted entry, for first run's one card. */
export const suggested = (m: Machine, id: string): Fit | undefined => {
  const e = vetted(id)
  return e === undefined ? undefined : bestQuant(m, e)
}

/** Only children of the managed model directory can be written or deleted. */
function within(root: string, name: string): string {
  const file = resolve(root, name)
  const rel = relative(resolve(root), file)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || name.includes('\\')) throw new Refused(400, 'The model file path is invalid.')
  return file
}
