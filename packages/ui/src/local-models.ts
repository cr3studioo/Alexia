// SPDX-License-Identifier: AGPL-3.0-only
import { el } from './widgets.js'

// Browser copies of core/localModels.ts's HTTP shapes. Never import core into the shell.
export type Mode = 'local' | 'combined' | 'cloud'
export type Format = 'gguf' | 'mlx'
interface Runtime { installed: boolean; version: string; supported: boolean }
interface Runtimes { llama: Runtime; mlx: Runtime }
export interface QuantCard {
  quant: string
  bytes: number
  needBytes: number
  verdict: string
  note?: string
}
export interface Card extends QuantCard {
  format?: Format
  entry: string
  name: string
  blurb: string
  publisher: string
  params: number
  tools: boolean
  vision: boolean
  tokensPerSecond?: number
  licence: { name: string; url: string; restrictive: boolean }
  abliterated: boolean
  installed: boolean
  quants: QuantCard[]
}
export interface InstalledRow {
  format?: Format
  owned?: boolean
  imported?: boolean
  contextMax?: number
  lastUsedAt?: number
  kvCache?: string
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
export interface Job {
  kind?: 'install' | 'import' | 'benchmark'
  id: string
  target: string
  name: string
  step: 'queued' | 'runtime' | 'download' | 'verify' | 'start' | 'test' | 'done' | 'failed' | 'cancelled'
  done: number
  total: number
  bytesPerSecond?: number
  message: string
  error?: string
  modelId?: string
  startedAt: number
}
export interface Overview {
  machine: { summary: string; ramBytes: number; freeDiskBytes: number; budgetBytes: number; appleSilicon: boolean; chip?: string }
  runtime: Runtime & { runtimes?: Runtimes }
  runtimes?: Runtimes
  picks: { best?: Card; fast?: Card; tools?: Card }
  all: Card[]
  uncensored: Card[]
  installed: InstalledRow[]
  jobs: Job[]
  mode: Mode
}
export type Target = ({ entry: string; quant: string } | { repo: string; revision?: string; quant: string; format?: Format }) & { mode?: 'local' | 'combined' }
interface ImportTarget { path: string; storage: 'copy' | 'reference'; mode?: 'local' | 'combined' }
type JobTarget = { endpoint: '/install'; body: Target } | { endpoint: '/import'; body: ImportTarget } | { endpoint: '/benchmark'; body: { id: string } }
interface ContextPreview { context: number; contextMax: number; needBytes: number; verdict: string; note?: string; drafts: { id: string; name: string }[]; kvOptions: string[] }
interface Maintenance { updates: { installedId: string; entry: string; name: string; reason: string }[]; cleanup: { id: string; name: string; bytes: number; lastUsedAt?: number; reason: string }[]; reclaimableBytes: number }
interface Hit { repo: string; downloads?: number; likes?: number; gated?: boolean }
interface Repo { repo: string; revision: string; licence?: string; gated: boolean; params?: number; quants: QuantCard[] }

/** Supplied by the screen's existing same-origin, token-authenticated helper. */
export type LocalRequest = (path: string, body: unknown, options?: { method?: 'GET' | 'POST' | 'DELETE'; signal?: AbortSignal }) => Promise<unknown>
export interface LocalModelsView {
  open(): void
  close(): void
  refresh(): Promise<void>
  explain(message: string): void
}
/**
 * A paired computer whose models this view shows instead of this one's. Every request then
 * names it, so the machine, the fit verdicts, the downloads and their progress are its own.
 */
export interface LocalHost {
  id: string
  name: string
  /** The screen's sentence for a state code core answered with, when it is one it shows as itself. */
  explain?(code: string): string | undefined
}
interface Options {
  request: LocalRequest
  /** Absent, or returning undefined, is this computer. Read once each time the view opens. */
  host?: () => LocalHost | undefined
  mode?: () => string
  changed?: () => void
  ready?: (ready: boolean) => void
  firstRun?: boolean
  /** Compute hosts install models for their controller, and cannot choose one for themselves. */
  selection?: boolean
}

const BASE = '/api/local-models'
const finished = (job: Job): boolean => ['done', 'failed', 'cancelled'].includes(job.step)
export const modelBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes)) return 'unknown'
  if (bytes <= 0) return '0 B'
  const unit = bytes >= 1024 ** 3 ? 'GB' : bytes >= 1024 ** 2 ? 'MB' : bytes >= 1024 ? 'KB' : 'B'
  const scale = { GB: 1024 ** 3, MB: 1024 ** 2, KB: 1024, B: 1 }[unit]
  return `${(bytes / scale).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`
}
const fitText = (quant: QuantCard, where = 'this machine'): string =>
  `${quant.verdict === 'fits' ? `Fits ${where}` : quant.verdict === 'tight' ? 'Memory will be tight' : quant.verdict === 'disk' ? 'Not enough disk space' : quant.verdict === 'too-big' ? `Too large for ${where}` : quant.verdict.replace(/[-_]/g, ' ')} · needs ${modelBytes(quant.needBytes)} memory`

/** One picker, used by Settings and first run. Closing stops requests and progress polling. */
export function mountLocalModels(root: HTMLElement, options: Options): LocalModelsView {
  root.classList.add('local-models', 'group')
  let active = false
  let generation = 0
  let reading = 0
  let busy = false
  let polling = false
  let ollamaReady = false
  let overview: Overview | undefined
  let pollTimer: number | undefined
  let searchVersion = 0
  let repoVersion = 0
  let selectedFormat: Format | undefined
  let host: LocalHost | undefined
  const previewTimers = new Set<number>()
  const controllers = new Map<AbortController, number>()
  const targets = new Map<string, JobTarget>()
  const notified = new Set<string>()
  let jobs: Job[] = []
  let jobArea: HTMLElement
  let content: HTMLElement
  let modeArea: HTMLElement
  let said: HTMLElement
  let refreshButton: HTMLButtonElement

  const button = (label: string, press: () => void): HTMLButtonElement => {
    const one = el('button', 'quiet-button', label)
    one.type = 'button'
    one.addEventListener('click', press)
    return one
  }
  const report = (message: string, error = false): void => {
    said.textContent = message
    said.className = error ? 'error' : 'hint'
  }
  const requestAt = async <T>(path: string, body?: unknown, method: 'GET' | 'POST' | 'DELETE' = 'GET'): Promise<T> => {
    if (!active) throw new Error('This page is closed.')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 20_000)
    controllers.set(controller, timeout)
    try {
      const result = await options.request(path, body, { method, signal: controller.signal })
      if (controller.signal.aborted) throw new Error('Alexia did not answer in time. Try again.')
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        const failed = result as { said?: string; why?: string; error?: string; code?: unknown }
        // A paired host's refusal keeps its code, so its own sentence can be shown for it.
        throw Object.assign(new Error(failed.said ?? failed.why ?? failed.error ?? 'That did not go through. Try again.'), typeof failed.code === 'string' && { code: failed.code })
      }
      return result as T
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Alexia did not answer in time. Try again.', { cause: error })
      throw error
    } finally {
      window.clearTimeout(timeout)
      controllers.delete(controller)
    }
  }
  const api = <T>(path: string, body?: unknown, method: 'GET' | 'POST' | 'DELETE' = 'GET'): Promise<T> => {
    if (!host) return requestAt<T>(`${BASE}${path}`, body, method)
    // A paired host is named on every request: in the body where there is one, in the query otherwise.
    if (method === 'POST') return requestAt<T>(`${BASE}${path}`, { ...(body as Record<string, unknown> | undefined), host: host.id }, method)
    return requestAt<T>(`${BASE}${path}${path.includes('?') ? '&' : '?'}host=${encodeURIComponent(host.id)}`, body, method)
  }
  /** `this machine` in a fit verdict, or the paired computer the verdict is about. */
  const where = (): string => host?.name ?? 'this machine'
  const here = (): string => host?.name ?? 'this computer'
  const messageOf = (error: unknown): string => error instanceof Error ? error.message : 'Alexia could not be reached. Try again.'
  const runtimes = (): Runtimes | undefined => overview?.runtime.runtimes ?? overview?.runtimes
  const supports = (format: Format): boolean => format === 'mlx'
    ? overview?.machine.appleSilicon === true && runtimes()?.mlx.supported === true
    : (runtimes()?.llama.supported ?? overview?.runtime.supported) !== false
  const format = (): Format => selectedFormat && supports(selectedFormat) ? selectedFormat : supports('mlx') && (runtimes()?.mlx.installed || !supports('gguf')) ? 'mlx' : 'gguf'
  const lock = (): void => {
    // Downloads lock only install buttons; selecting sizes and browsing can still be done.
    const installing = jobs.some((one) => !finished(one))
    for (const one of root.querySelectorAll<HTMLButtonElement>('button[data-install]')) {
      one.disabled = busy || installing || !supports(one.dataset.format === 'mlx' ? 'mlx' : 'gguf') || one.dataset.allowed !== 'true'
    }
    for (const one of root.querySelectorAll<HTMLButtonElement>('button[data-mutate]')) one.disabled = busy || installing || one.dataset.allowed === 'false'
  }
  const action = async (control: HTMLButtonElement, work: () => Promise<void>): Promise<void> => {
    if (!active || busy) return
    const mine = generation
    busy = true
    control.disabled = true
    lock()
    report('')
    try { await work() }
    catch (error) { if (active && mine === generation) report(messageOf(error), true) }
    finally {
      if (active && mine === generation) {
        busy = false
        control.disabled = false
        lock()
      }
    }
  }

  const use = (id: string, name: string, control: HTMLButtonElement): void => {
    if (options.selection === false) return
    const choose = async (mode?: Mode): Promise<void> => {
      const mine = generation
      // Choosing is this computer's own decision, so it is not forwarded: the host is in the id.
      const result = await requestAt<{ said?: string }>(`${BASE}/use`, { id: host ? `@${host.id}/${id}` : id, ...(mode !== undefined && { mode }) }, 'POST')
      if (!active || mine !== generation) return
      modeArea.replaceChildren()
      options.changed?.()
      await refresh()
      if (active && mine === generation) report(result.said ?? `${name} is chosen.`)
    }
    const currentMode = options.mode?.() ?? overview?.mode
    if (currentMode !== 'cloud') { void action(control, () => choose(options.firstRun || host && currentMode !== 'local' ? 'local' : undefined)); return }
    const field = el('fieldset', 'local-mode-choice')
    field.append(el('legend', undefined, `Where should Alexia run with ${name}?`), el('p', 'hint', 'Cloud is selected. Downloading a model does not change that choice.'))
    for (const [mode, label] of [['local', 'Use Local'], ['combined', 'Use Combined']] as const) {
      if (host && mode === 'combined') continue
      const pick = button(label, () => void action(pick, () => choose(mode)))
      field.append(pick)
    }
    field.append(button('Keep Cloud — go back', () => modeArea.replaceChildren()))
    modeArea.replaceChildren(field)
  }

  const startJob = (target: JobTarget, control: HTMLButtonElement): void => {
    void action(control, async () => {
      const mine = generation
      const job = await api<Job>(target.endpoint, target.body, 'POST')
      if (!active || mine !== generation) return
      targets.set(job.id, target)
      modeArea.replaceChildren()
      jobs = [job]
      drawJobs()
      schedulePoll()
    })
  }
  const chooseJob = (target: JobTarget, control: HTMLButtonElement): void => {
    if (!active || busy || control.disabled || jobs.some((one) => !finished(one))) return
    if (target.endpoint === '/benchmark') { startJob(target, control); return }
    if (host || options.selection === false) {
      const body = { ...target.body }
      delete body.mode
      startJob({ ...target, body } as JobTarget, control)
      return
    }
    const mode = options.mode?.() ?? overview?.mode
    if (mode !== 'cloud') {
      const currentTarget = { ...target.body }
      delete currentTarget.mode
      // A retry in Local or Combined needs no mode override.
      // First run can have selected Local before that choice is saved to core.
      if ((options.firstRun || overview?.mode === 'cloud') && (mode === 'local' || mode === 'combined')) currentTarget.mode = mode
      startJob({ ...target, body: currentTarget } as JobTarget, control)
      return
    }
    const field = el('fieldset', 'local-mode-choice')
    field.append(el('legend', undefined, target.endpoint === '/import' ? 'Choose a mode before importing' : 'Choose a mode before downloading'), el('p', 'hint', 'Cloud is selected. To install and use a local model, choose where Alexia should run.'))
    for (const [mode, label] of [['local', 'Install and use Local'], ['combined', 'Install and use Combined']] as const) {
      const pick = button(target.endpoint === '/import' ? label.replace('Install', 'Import') : label, () => startJob({ ...target, body: { ...target.body, mode } } as JobTarget, pick))
      field.append(pick)
    }
    field.append(button('Keep Cloud — go back', () => modeArea.replaceChildren()))
    modeArea.replaceChildren(field)
    field.scrollIntoView?.({ block: 'nearest' })
  }
  const install = (target: Target, control: HTMLButtonElement): void => chooseJob({ endpoint: '/install', body: target }, control)
  const quantPicker = (quants: QuantCard[], recommended: string, name: string, target: (quant: string) => Target, installedQuant?: string, modelFormat: Format = 'gguf'): HTMLElement => {
    const group = el('div', 'local-quant')
    const label = el('label', 'field')
    label.append(el('span', 'label', `Download size for ${name}`))
    const select = el('select')
    for (const quant of quants) {
      const option = el('option', undefined, `${quant.quant} · ${modelBytes(quant.bytes)}${quant.quant === recommended ? ' · recommended' : ''}`)
      option.value = quant.quant
      select.append(option)
    }
    select.value = recommended
    if (!select.value && quants[0]) select.value = quants[0].quant
    label.append(select)
    const note = el('p', 'hint')
    const installLabel = host || options.selection === false ? 'Install' : 'Install & use'
    const get = button(installLabel, () => install(target(select.value), get))
    get.dataset.install = 'true'
    get.dataset.format = modelFormat
    const update = (): void => {
      const quant = quants.find((one) => one.quant === select.value)
      note.textContent = quant ? `${fitText(quant, where())}${quant.note ? `. ${quant.note}` : ''}` : `No downloadable ${modelFormat.toUpperCase()} sizes were found.`
      // Core decides fit. Never encourage a download it says cannot fit.
      const installed = select.value === installedQuant
      get.textContent = installed ? 'Installed — see below' : installLabel
      get.dataset.allowed = String(!installed && (quant?.verdict === 'fits' || quant?.verdict === 'tight'))
      lock()
      get.disabled = busy || jobs.some((one) => !finished(one)) || !supports(modelFormat) || get.dataset.allowed !== 'true'
    }
    select.addEventListener('change', update)
    group.append(label, note, get)
    update()
    return group
  }

  const card = (model: Card, badge?: string): HTMLElement => {
    const one = el('article', 'local-model-card')
    if (badge) one.append(el('span', 'flag good', badge))
    one.append(el('h3', undefined, model.name), el('p', undefined, model.blurb))
    const traits = [(model.format ?? 'gguf').toUpperCase(), model.publisher, `${model.params}B parameters`, model.tools ? 'Tool use is provisional; checked during install' : '', model.vision ? 'Vision build' : '', model.abliterated ? 'Uncensored' : '', model.installed ? 'Installed' : ''].filter(Boolean)
    one.append(el('p', 'hint', traits.join(' · ')))
    const licence = el('p', 'hint', `Licence: ${model.licence.name}${model.licence.restrictive ? ' · restrictions apply' : ''}`)
    // Remote metadata is always text; licence links accept only web URLs.
    try {
      const url = new URL(model.licence.url)
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        const link = el('a', undefined, 'Read licence')
        link.href = url.href
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        licence.append(' · ', link)
      }
    } catch { /* A missing or invalid link leaves the licence name readable. */ }
    one.append(licence, quantPicker(model.quants, model.quant, model.name, (quant) => ({ entry: model.entry, quant }), model.installed ? model.quant : undefined, model.format ?? 'gguf'))
    return one
  }

  const contextControls = (model: InstalledRow): HTMLElement => {
    const fold = el('details', 'advanced local-context')
    fold.append(el('summary', undefined, 'Context and performance'))
    const fields = el('div', 'local-config-fields')
    const label = el('label', 'field')
    label.append(el('span', 'label', `Context tokens for ${model.name}`))
    const range = el('input')
    range.type = 'range'
    range.min = String(Math.min(512, model.context))
    range.max = String(model.contextMax ?? model.context)
    range.step = '1'
    range.value = String(model.context)
    const tokens = el('output', 'hint', `${model.context.toLocaleString()} tokens`)
    label.append(range, tokens)
    const kvField = el('label', 'field')
    kvField.append(el('span', 'label', 'KV cache precision'))
    const kv = el('select')
    for (const value of ['f16', 'q8_0', 'q4_0']) {
      const option = el('option', undefined, value === 'f16' ? 'Full precision (f16)' : value === 'q8_0' ? '8 bit (q8_0)' : '4 bit (q4_0)')
      option.value = value
      kv.append(option)
    }
    kv.value = model.kvCache ?? 'f16'
    kvField.append(kv)
    const draftField = el('label', 'field')
    draftField.append(el('span', 'label', 'Draft model for speculative decoding'))
    const draft = el('select')
    const none = el('option', undefined, 'None')
    none.value = ''
    draft.append(none)
    if (model.draftModelId) {
      const current = el('option', undefined, overview?.installed.find((one) => one.id === model.draftModelId)?.name ?? model.draftModelId)
      current.value = model.draftModelId
      draft.append(current)
      draft.value = model.draftModelId
    }
    draftField.append(draft, el('span', 'hint', 'Draft compatibility and extra memory are checked when saving.'))
    const note = el('p', 'hint', 'Open this section to check memory before changing context.')
    note.setAttribute('role', 'status')
    let preview: ContextPreview | undefined
    let version = 0
    let timer: number | undefined
    const apply = button('Save configuration', () => void action(apply, async () => {
      if (!preview || !['fits', 'tight'].includes(preview.verdict)) return
      const mine = generation
      const result = await api<{ said?: string }>('/context', { id: model.id, context: Number(range.value), kvCache: kv.value, draftModelId: draft.value || null }, 'POST')
      if (!active || mine !== generation || !fold.isConnected) return
      options.changed?.()
      await refresh()
      if (active && mine === generation) report(result.said ?? 'Configuration saved.')
    }))
    apply.dataset.mutate = 'true'
    apply.dataset.allowed = 'false'
    apply.disabled = true
    const read = async (): Promise<void> => {
      window.clearTimeout(timer)
      if (timer !== undefined) previewTimers.delete(timer)
      const mine = generation
      const mineVersion = ++version
      preview = undefined
      apply.dataset.allowed = 'false'
      lock()
      note.textContent = 'Checking memory…'
      const oldDraft = draft.value
      try {
        const got = await api<ContextPreview>(`/context?id=${encodeURIComponent(model.id)}&context=${encodeURIComponent(range.value)}&kvCache=${encodeURIComponent(kv.value)}&draftModelId=${encodeURIComponent(oldDraft)}`)
        if (!active || mine !== generation || mineVersion !== version || !fold.isConnected) return
        if (!Number.isFinite(got.context) || !Number.isFinite(got.contextMax) || !Array.isArray(got.kvOptions) || !Array.isArray(got.drafts)) throw new Error('The memory preview could not be read. Try again.')
        range.max = String(got.contextMax)
        range.value = String(got.context)
        tokens.textContent = `${got.context.toLocaleString()} tokens`
        for (const option of kv.options) option.disabled = !got.kvOptions.includes(option.value)
        if (!got.kvOptions.includes(kv.value)) {
          const next = got.kvOptions.find((one) => ['f16', 'q8_0', 'q4_0'].includes(one))
          if (next) { kv.value = next; void read(); return }
        }
        kvField.hidden = got.kvOptions.length <= 1
        draft.replaceChildren(none, ...got.drafts.map((one) => {
          const option = el('option', undefined, one.name)
          option.value = one.id
          return option
        }))
        draft.value = got.drafts.some((one) => one.id === oldDraft) ? oldDraft : ''
        if (draft.value !== oldDraft) { void read(); return }
        draftField.hidden = !got.drafts.length
        preview = got
        note.textContent = `${fitText({ ...got, quant: '', bytes: 0 }, where())}${got.note ? `. ${got.note}` : ''}`
        apply.dataset.allowed = String(['fits', 'tight'].includes(got.verdict))
        lock()
      } catch (error) {
        if (active && mine === generation && mineVersion === version && fold.isConnected) note.textContent = messageOf(error)
      }
    }
    const changed = (): void => {
      ++version
      preview = undefined
      apply.dataset.allowed = 'false'
      lock()
      tokens.textContent = `${Number(range.value).toLocaleString()} tokens`
      note.textContent = 'Checking memory…'
      window.clearTimeout(timer)
      if (timer !== undefined) previewTimers.delete(timer)
      timer = window.setTimeout(() => { previewTimers.delete(timer!); if (active && fold.isConnected) void read() }, 200)
      previewTimers.add(timer)
    }
    range.addEventListener('input', changed)
    kv.addEventListener('change', changed)
    draft.addEventListener('change', changed)
    fold.addEventListener('toggle', () => { if (fold.open && !preview) void read() })
    fields.append(label, kvField, draftField)
    fold.append(fields, note, apply, button('Check memory again', () => void read()))
    return fold
  }

  const removeButton = (model: Pick<InstalledRow, 'id' | 'name' | 'bytes' | 'owned'>, row: HTMLElement): HTMLButtonElement => {
    let confirmation: HTMLButtonElement | undefined
    const remove = button('Remove', () => {
      if (!confirmation) {
        remove.textContent = model.owned === false ? 'Remove reference? Source file stays.' : `Remove ${modelBytes(model.bytes)} from disk?`
        confirmation = button('Keep it', () => { confirmation?.remove(); confirmation = undefined; remove.textContent = 'Remove' })
        row.append(confirmation)
        return
      }
      void action(remove, async () => {
        const mine = generation
        await api(`/${encodeURIComponent(model.id)}`, undefined, 'DELETE')
        if (!active || mine !== generation) return
        options.changed?.()
        await refresh()
      })
    })
    remove.dataset.mutate = 'true'
    return remove
  }

  const drawInstalled = (): HTMLElement => {
    const section = el('section', 'local-installed')
    section.append(el('h3', undefined, `Installed on ${here()}`))
    if (!overview?.installed.length) section.append(el('p', 'hint', 'No local models installed yet.'))
    for (const model of overview?.installed ?? []) {
      const row = el('article', 'local-installed-row')
      row.append(el('b', undefined, model.name), el('p', 'hint', [(model.format ?? 'gguf').toUpperCase(), model.quant, modelBytes(model.bytes), `${model.context.toLocaleString()} context`, model.pinned ? 'Chosen' : '', model.imported ? model.owned === false ? 'Imported reference · source file stays on Remove' : 'Imported copy' : '', !model.vetted ? 'Not reviewed by Alexia' : '', model.abliterated ? 'Uncensored' : '', model.tools ? 'Tool use checked' : 'For chat', model.vision ? 'Vision' : '', model.licence ?? '', model.tokensPerSecond !== undefined ? `${model.tokensPerSecond} tokens/s measured` : '', model.lastUsedAt ? `Last used ${new Date(model.lastUsedAt).toLocaleDateString()}` : ''].filter(Boolean).join(' · ')))
      const choose = button('Use this', () => use(model.id, model.name, choose))
      choose.dataset.mutate = 'true'
      const remove = removeButton(model, row)
      const benchmark = button('Measure speed', () => chooseJob({ endpoint: '/benchmark', body: { id: model.id } }, benchmark))
      benchmark.dataset.mutate = 'true'
      if (model.ready === false) {
        choose.disabled = true
        choose.dataset.allowed = 'false'
        benchmark.dataset.allowed = 'false'
        row.append(el('p', 'hint', 'Installation check did not pass. Retry the installation before using this model.'))
      }
      if (options.selection !== false) row.append(choose)
      row.append(remove)
      if (model.ready !== false) row.append(benchmark, contextControls(model))
      section.append(row)
    }
    return section
  }

  const searchPicker = (): HTMLElement => {
    const fold = el('details', 'advanced')
    fold.append(el('summary', undefined, 'Search Hugging Face'))
    const modelFormat = format()
    fold.append(el('p', 'hint', `Find ${modelFormat.toUpperCase()} repositories. These models have not been reviewed by Alexia; tool use and image support are not checked.`))
    const form = el('form', 'local-search')
    const input = el('input')
    input.type = 'search'
    input.placeholder = 'Model name or owner/repository'
    input.setAttribute('aria-label', 'Search Hugging Face models')
    const find = button('Search', () => undefined)
    find.type = 'submit'
    form.append(input, find)
    const status = el('p', 'hint')
    status.setAttribute('role', 'status')
    const results = el('div', 'local-search-results')
    const repoArea = el('div', 'local-repo')
    const openRepo = async (id: string): Promise<void> => {
      const mine = generation
      const version = ++repoVersion
      repoArea.replaceChildren(el('p', 'hint', 'Reading the repository…'))
      try {
        const repo = await api<Repo>(`/repo?repo=${encodeURIComponent(id)}&format=${modelFormat}`)
        if (!active || mine !== generation || version !== repoVersion || !repoArea.isConnected) return
        repoArea.replaceChildren(el('h3', undefined, repo.repo), el('p', 'hint', `Not reviewed by Alexia · Licence: ${repo.licence ?? 'not supplied'}${repo.gated ? ' · Hugging Face access required' : ''}`))
        const link = el('a', undefined, 'Read the repository licence and access terms')
        link.href = `https://huggingface.co/${repo.repo.split('/').map(encodeURIComponent).join('/')}`
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        repoArea.append(link)
        if (repo.gated) repoArea.append(el('p', 'hint', host
          ? `Accept the repository’s access terms on Hugging Face. A token for it is entered on ${host.name} itself, not here.`
          : 'Accept the repository’s access terms on Hugging Face and save a token with permission to read it below.'))
        const best = repo.quants.find((one) => one.verdict === 'fits') ?? repo.quants[0]
        repoArea.append(quantPicker(repo.quants, best?.quant ?? '', repo.repo, (quant) => ({ repo: repo.repo, revision: repo.revision, quant, format: modelFormat }), undefined, modelFormat))
      } catch (error) {
        if (!active || mine !== generation || version !== repoVersion) return
        repoArea.replaceChildren(el('p', 'error', messageOf(error)), button('Retry repository', () => void openRepo(id)))
      }
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const query = input.value.trim()
      if (!query) { status.textContent = 'Type a model name or repository first.'; return }
      const mine = generation
      const version = ++searchVersion
      ++repoVersion
      repoArea.replaceChildren()
      results.replaceChildren()
      status.textContent = 'Searching Hugging Face…'
      find.disabled = true
      void api<Hit[]>(`/search?q=${encodeURIComponent(query)}&format=${modelFormat}`).then((hits) => {
        if (!active || mine !== generation || version !== searchVersion || !results.isConnected) return
        status.textContent = hits.length ? `${hits.length} repositories found. Choose one to see its download sizes.` : `No ${modelFormat.toUpperCase()} repositories found. Try another name.`
        results.replaceChildren(...hits.map((hit) => button(hit.repo, () => void openRepo(hit.repo))))
      }).catch((error: unknown) => {
        if (active && mine === generation && version === searchVersion) status.textContent = `${messageOf(error)} Press Search to retry.`
      }).finally(() => { if (mine === generation && version === searchVersion) find.disabled = false })
    })
    const tokenFold = el('details', 'advanced')
    tokenFold.append(el('summary', undefined, 'Hugging Face token for gated repositories'))
    const tokenForm = el('form', 'local-search')
    const token = el('input')
    token.type = 'password'
    token.autocomplete = 'off'
    token.placeholder = 'Paste a read token'
    token.setAttribute('aria-label', 'Hugging Face token')
    const save = button('Save token', () => undefined)
    save.type = 'submit'
    const stored = el('p', 'hint', 'Saved in the system keychain.')
    stored.setAttribute('role', 'status')
    tokenForm.append(token, save)
    tokenForm.addEventListener('submit', (event) => {
      event.preventDefault()
      const typed = token.value.trim()
      if (!typed) { stored.textContent = 'Paste a token first.'; return }
      void action(save, async () => {
        const mine = generation
        // Empty immediately; the token is never placed in a message or persisted in the UI.
        token.value = ''
        await api('/token', { token: typed }, 'POST')
        if (active && mine === generation) stored.textContent = 'Token saved in the system keychain. Retry the repository or install.'
      })
    })
    tokenFold.append(tokenForm, stored)
    // A token is typed at the computer that will use it; this field only reaches this one's keychain.
    fold.append(form, status, results, repoArea)
    if (!host) fold.append(tokenFold)
    return fold
  }

  const importPicker = (): HTMLElement => {
    const fold = el('details', 'advanced local-import')
    fold.append(el('summary', undefined, 'Import an existing GGUF'))
    fold.append(el('p', 'hint', options.selection === false
      ? 'Import a GGUF already on this computer. Alexia checks the file and tries a short chat; choose the model from the paired computer afterwards.'
      : 'Use a GGUF already on this computer. Alexia checks the file and tries a short chat before choosing it.'))
    const form = el('form', 'local-config-fields')
    const pathField = el('label', 'field')
    pathField.append(el('span', 'label', 'GGUF file path on this computer'))
    const path = el('input')
    path.type = 'text'
    path.placeholder = '/path/to/model.gguf'
    path.autocomplete = 'off'
    pathField.append(path, el('span', 'hint', 'Paste the full path. Browser file selection cannot supply a local path.'))
    const storageField = el('label', 'field')
    storageField.append(el('span', 'label', 'Store the model'))
    const storage = el('select')
    for (const [value, text] of [['copy', 'Copy into Alexia (recommended)'], ['reference', 'Use the existing file']] as const) {
      const option = el('option', undefined, text)
      option.value = value
      storage.append(option)
    }
    storage.value = 'copy'
    const storageNote = el('p', 'hint')
    const storageChanged = (): void => {
      storageNote.textContent = storage.value === 'reference'
        ? 'No extra copy. Keep the file at this path. Remove only removes Alexia’s reference; it does not delete the source file.'
        : 'Uses additional disk space for a managed copy. Remove deletes the copy; your original file stays.'
    }
    storage.addEventListener('change', storageChanged)
    storageChanged()
    storageField.append(storage, storageNote)
    const note = el('p', 'hint')
    note.setAttribute('role', 'status')
    let version = 0
    path.addEventListener('input', () => { ++version; note.textContent = '' })
    const preview = button('Check file', () => {
      const typed = path.value.trim()
      if (!typed) { note.textContent = 'Paste a GGUF file path first.'; return }
      const mine = generation
      const mineVersion = ++version
      note.textContent = 'Reading GGUF metadata…'
      void api<{ name: string; quant: string; bytes: number; contextMax: number }>(`/import-preview?path=${encodeURIComponent(typed)}`).then((got) => {
        if (!active || mine !== generation || mineVersion !== version || !fold.isConnected) return
        note.textContent = `${got.name} · ${got.quant} · ${modelBytes(got.bytes)} · up to ${got.contextMax.toLocaleString()} context tokens. Memory and compatibility are checked during import.`
      }).catch((error: unknown) => {
        if (active && mine === generation && mineVersion === version && fold.isConnected) note.textContent = `File preview unavailable: ${messageOf(error)} Import will still check the file.`
      })
    })
    const start = button(options.selection === false ? 'Import' : 'Import & use', () => undefined)
    start.type = 'submit'
    start.dataset.install = 'true'
    start.dataset.allowed = 'true'
    start.dataset.format = 'gguf'
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (!path.value.trim()) { note.textContent = 'Paste a GGUF file path first.'; return }
      chooseJob({ endpoint: '/import', body: { path: path.value.trim(), storage: storage.value === 'reference' ? 'reference' : 'copy' } }, start)
    })
    const actions = el('div', 'local-config-actions')
    actions.append(preview, start)
    form.append(pathField, storageField, note, actions)
    fold.append(form)
    return fold
  }

  const maintenance = (): HTMLElement => {
    const fold = el('details', 'advanced local-maintenance')
    fold.append(el('summary', undefined, 'Updates and disk space'))
    const body = el('div')
    fold.append(body)
    let version = 0
    let loaded = false
    const load = async (): Promise<void> => {
      const mine = generation
      const mineVersion = ++version
      body.replaceChildren(el('p', 'hint', 'Checking installed models…'))
      try {
        const got = await api<Maintenance>('/maintenance')
        if (!active || mine !== generation || mineVersion !== version || !fold.isConnected) return
        if (!Array.isArray(got.updates) || !Array.isArray(got.cleanup)) throw new Error('Maintenance hints could not be read.')
        loaded = true
        body.replaceChildren(el('p', 'hint', 'Updates and removal are your choice. Alexia never deletes models automatically.'))
        for (const hint of got.updates) {
          const row = el('article', 'local-installed-row')
          row.append(el('b', undefined, hint.name), el('p', 'hint', hint.reason))
          const entry = [...(overview?.all ?? []), ...(overview?.uncensored ?? [])].find((one) => one.entry === hint.entry)
          if (entry) row.append(card({ ...entry, installed: false }, 'Update available'))
          else row.append(el('p', 'hint', 'Refresh the catalog to see this model’s current sizes.'))
          body.append(row)
        }
        if (!got.updates.length) body.append(el('p', 'hint', 'No model updates are suggested.'))
        body.append(el('h3', undefined, `Potential disk savings: ${modelBytes(got.reclaimableBytes)}`))
        for (const hint of got.cleanup) {
          const row = el('article', 'local-installed-row')
          const held = overview?.installed.find((one) => one.id === hint.id)
          row.append(el('b', undefined, hint.name), el('p', 'hint', `${hint.reason} · ${modelBytes(hint.bytes)}${hint.lastUsedAt ? ` · last used ${new Date(hint.lastUsedAt).toLocaleDateString()}` : ''}`), removeButton({ ...hint, owned: held?.owned }, row))
          body.append(row)
        }
        if (!got.cleanup.length) body.append(el('p', 'hint', 'No unused models are suggested for removal.'))
        body.append(button('Check suggestions again', () => void load()))
        lock()
      } catch (error) {
        if (!active || mine !== generation || mineVersion !== version || !fold.isConnected) return
        body.replaceChildren(el('p', 'error', messageOf(error)), button('Retry suggestions', () => void load()))
      }
    }
    fold.addEventListener('toggle', () => { if (fold.open && !loaded) void load() })
    return fold
  }

  const ollamaEscape = (): HTMLElement => {
    const section = el('section', 'local-installed')
    section.append(el('h3', undefined, 'Already have a model in Ollama?'))
    const status = el('p', 'hint', 'Checking for installed Ollama models…')
    const list = el('div', 'local-search-results')
    section.append(status, list)
    const load = async (): Promise<void> => {
      const mine = generation
      try {
        const got = await requestAt<{ rows: { id: string; name: string; state?: string }[] }>('/api/rows', { key: 'models' }, 'POST')
        if (!active || mine !== generation || !section.isConnected) return
        const models = [...new Map(got.rows.filter((row) => row.id.startsWith('ollama\n')).map((row) => [row.id, row])).values()]
        status.textContent = models.length ? 'Use an existing Ollama model without another download.' : 'No Ollama model is available to Alexia. Start Ollama with an installed model, then check again.'
        list.replaceChildren(...models.map((model) => {
          const choose = button(`Use ${model.name} from Ollama`, () => void action(choose, async () => {
            const mine = generation
            const result = await requestAt<{ said?: string }>('/api/action', { key: 'use_model', row: model.id }, 'POST')
            if (!active || mine !== generation) return
            ollamaReady = true
            options.ready?.(true)
            options.changed?.()
            report(result.said ?? `${model.name} from Ollama is chosen.`)
          }))
          return choose
        }), button('Check Ollama again', () => void load()))
      } catch (error) {
        if (!active || mine !== generation || !section.isConnected) return
        status.textContent = messageOf(error)
        list.replaceChildren(button('Check Ollama again', () => void load()))
      }
    }
    // The section is appended synchronously before this request returns.
    void load()
    return section
  }

  const draw = (): void => {
    if (!overview) return
    const modelFormat = format()
    const matchesFormat = (model: Card): boolean => (model.format ?? 'gguf') === modelFormat
    const machine = el('p', 'hint', `${host ? `${host.name} · ` : ''}${overview.machine.summary} · ${modelBytes(overview.machine.freeDiskBytes)} free on disk${host ? `. Downloads go onto ${host.name}, not this computer.` : ''}`)
    const runtime = modelFormat === 'mlx' ? runtimes()?.mlx : runtimes()?.llama ?? overview.runtime
    const runner = el('p', 'hint', supports(modelFormat) ? runtime?.installed ? `${modelFormat.toUpperCase()} model runner ${runtime.version} is installed.` : `The ${modelFormat.toUpperCase()} model runner will be downloaded with your first model.` : `Local models are not supported on ${here()} yet.`)
    const formats = el('fieldset', 'local-format')
    formats.append(el('legend', undefined, 'Model format'))
    for (const value of ['gguf', 'mlx'] as const) {
      if (!supports(value)) continue
      const choose = button(value === 'mlx' ? 'MLX · Apple Silicon' : 'GGUF', () => {
        selectedFormat = value
        ++searchVersion
        ++repoVersion
        draw()
      })
      choose.setAttribute('aria-pressed', String(value === modelFormat))
      formats.append(choose)
    }
    formats.hidden = formats.querySelectorAll('button').length < 2
    const picks = el('div', 'local-model-grid')
    const seen = new Set<string>()
    for (const [key, label] of [['best', `Recommended for ${where()}`], ['fast', 'Smaller download'], ['tools', 'For tool use']] as const) {
      const model = overview.picks[key]
      if (!model || !matchesFormat(model)) continue
      // A model can be both fastest and recommended; one card keeps its quant choice clear.
      if (seen.has(model.entry)) continue
      seen.add(model.entry)
      picks.append(card(model, label))
    }
    if (!seen.size) picks.append(el('p', 'hint', 'No recommended model fits right now. Check the other sizes below or free some disk space.'))
    const all = el('details', 'advanced')
    all.append(el('summary', undefined, 'More local models'))
    const other = el('div', 'local-model-grid')
    other.append(...overview.all.filter((model) => matchesFormat(model) && !seen.has(model.entry) && !model.abliterated).map((model) => card(model)))
    if (!other.childElementCount) other.append(el('p', 'hint', seen.size ? 'All available recommendations are shown above.' : `No curated ${modelFormat.toUpperCase()} models are available. Try searching Hugging Face below.`))
    all.append(other)
    const uncensored = el('details', 'advanced')
    uncensored.append(el('summary', undefined, 'Uncensored'), el('p', 'hint', 'These builds have safety refusals reduced or removed. They can produce explicit or harmful content. Read their licences before downloading.'))
    const uncensoredCards = el('div', 'local-model-grid')
    uncensoredCards.append(...overview.uncensored.filter(matchesFormat).map((model) => card(model)))
    if (!uncensoredCards.childElementCount) uncensoredCards.append(el('p', 'hint', `No uncensored builds are available for ${where()}.`))
    uncensored.append(uncensoredCards)
    content.replaceChildren(machine, formats, runner, picks, drawInstalled(), all, uncensored, searchPicker())
    // A file path and an Ollama install are this computer's; neither is offered for a paired one.
    if (!host) content.append(importPicker())
    if (!host) content.append(maintenance())
    if (options.firstRun && !host) content.append(ollamaEscape())
    lock()
  }
  const retryTarget = (job: Job): JobTarget | undefined => {
    const known = targets.get(job.id)
    if (known) return known
    if (job.target.startsWith('benchmark:')) return { endpoint: '/benchmark', body: { id: job.target.slice('benchmark:'.length) } }
    // Import paths do not preserve the user's copy/reference choice across sessions.
    if (job.kind === 'import' || job.target.startsWith('import:')) return undefined
    const at = job.target.lastIndexOf(':')
    if (at < 1) return undefined
    const id = job.target.slice(0, at)
    const quant = job.target.slice(at + 1)
    if ([...(overview?.all ?? []), ...(overview?.uncensored ?? [])].some((one) => one.entry === id)) return { endpoint: '/install', body: { entry: id, quant } }
    return id.includes('/') ? { endpoint: '/install', body: { repo: id, quant, format: job.modelId?.startsWith('mlx/') ? 'mlx' : 'gguf' } } : undefined
  }
  function drawJobs(): void {
    jobArea.replaceChildren(...jobs.map((job) => {
      const target = retryTarget(job)
      const kind = job.kind ?? (job.target.startsWith('benchmark:') ? 'benchmark' : job.target.startsWith('import:') ? 'import' : 'install')
      const row = el('section', 'local-job')
      row.append(el('b', undefined, job.name))
      const status = el('p', job.step === 'failed' ? 'error' : 'hint', `${job.message}${job.error ? `: ${job.error}` : ''}`)
      status.setAttribute('role', 'status')
      row.append(status)
      if (!finished(job)) {
        const progress = el('progress', 'local-progress')
        progress.setAttribute('aria-label', `${kind === 'benchmark' ? 'Measuring' : kind === 'import' ? 'Importing' : 'Installing'} ${job.name}`)
        if (job.total > 0) {
          progress.max = job.total
          progress.value = Math.max(0, Math.min(job.done, job.total))
        }
        const elapsed = Math.max(0, Math.floor((Date.now() - job.startedAt) / 1000))
        const numbers = [job.total > 0 ? `${modelBytes(job.done)} of ${modelBytes(job.total)}` : '', job.bytesPerSecond && ['download', 'runtime'].includes(job.step) ? `${modelBytes(job.bytesPerSecond)}/s` : '', `${elapsed}s elapsed`].filter(Boolean)
        const cancel = button(kind === 'benchmark' ? 'Cancel benchmark' : kind === 'import' ? 'Cancel import' : 'Cancel download', () => void action(cancel, async () => {
          const mine = generation
          await api('/cancel', { job: job.id }, 'POST')
          if (active && mine === generation) report(kind === 'install' ? 'Cancellation requested. Downloaded parts are kept for retry.' : 'Cancellation requested.')
        }))
        row.append(progress, el('p', 'hint', numbers.join(' · ')), cancel)
      } else if (job.step !== 'done') {
        if (target) {
          const retry = button(target.endpoint === '/benchmark' ? 'Retry benchmark' : target.endpoint === '/import' ? 'Retry import' : job.step === 'cancelled' ? 'Resume download' : 'Retry install', () => chooseJob(target, retry))
          if (target.endpoint === '/benchmark') retry.dataset.mutate = 'true'
          else {
            retry.dataset.install = 'true'
            const body = target.body
            retry.dataset.format = 'entry' in body
              ? [...(overview?.all ?? []), ...(overview?.uncensored ?? [])].find((one) => one.entry === body.entry)?.format ?? 'gguf'
              : 'repo' in body ? body.format ?? 'gguf' : 'gguf'
          }
          retry.dataset.allowed = 'true'
          row.append(retry)
        } else if (kind === 'import') row.append(el('p', 'hint', 'To retry, open Import an existing GGUF and choose the file and storage option again.'))
      } else if (host && kind === 'install' && job.modelId && options.selection !== false) {
        const choose = button('Use this model', () => use(job.modelId!, job.name, choose))
        choose.dataset.mutate = 'true'
        row.append(choose)
      }
      return row
    }))
    lock()
  }
  function schedulePoll(): void {
    window.clearTimeout(pollTimer)
    if (!active || polling || !jobs.some((one) => !finished(one))) return
    pollTimer = window.setTimeout(() => void poll(), 1000)
  }
  async function poll(): Promise<void> {
    if (!active || polling) return
    const mine = generation
    polling = true
    try {
      const running = jobs.filter((one) => !finished(one))
      const updates = await Promise.all(running.map((job) => api<Job>(`/progress?job=${encodeURIComponent(job.id)}`)))
      if (!active || mine !== generation) return
      jobs = jobs.map((job) => updates.find((one) => one.id === job.id) ?? job)
      report('')
      drawJobs()
      const ended = updates.filter(finished)
      if (ended.length) {
        await refresh()
        if (!active || mine !== generation) return
        for (const job of ended) {
          if (job.step !== 'done' || notified.has(job.id)) continue
          notified.add(job.id)
          options.changed?.()
        }
      }
    } catch (error) {
      if (active && mine === generation) report(`Progress could not be read: ${messageOf(error)} Still trying; Refresh checks now.`, true)
    } finally {
      if (active && mine === generation) {
        polling = false
        schedulePoll()
      }
    }
  }
  async function refresh(): Promise<void> {
    if (!active) return
    const mine = generation
    const version = ++reading
    try {
      const got = await api<Overview>('')
      if (!active || mine !== generation || version !== reading) return
      if (!got.machine || !got.runtime || !Array.isArray(got.installed)) throw new Error('The local model list could not be read. Try Refresh.')
      overview = got
      jobs = host ? [...got.jobs, ...jobs.filter((job) => finished(job) && !got.jobs.some((one) => one.id === job.id))] : got.jobs
      draw()
      drawJobs()
      report('')
      options.ready?.(got.installed.some((model) => model.ready !== false) || ollamaReady)
      schedulePoll()
    } catch (error) {
      if (!active || mine !== generation || version !== reading) return
      const code = (error as { code?: unknown } | null)?.code
      const sentence = host && typeof code === 'string' ? host.explain?.(code) : undefined
      if (!sentence) { report(messageOf(error), true); return }
      // The host's own state, in place of its models. Nothing from another computer is drawn instead.
      overview = undefined
      jobs = []
      window.clearTimeout(pollTimer)
      jobArea.replaceChildren()
      modeArea.replaceChildren()
      content.replaceChildren(el('p', 'error host-state', sentence))
      report('')
      options.ready?.(false)
    }
  }
  const close = (): void => {
    active = false
    ++generation
    ++reading
    window.clearTimeout(pollTimer)
    for (const timer of previewTimers) window.clearTimeout(timer)
    previewTimers.clear()
    for (const [controller, timeout] of controllers) {
      window.clearTimeout(timeout)
      controller.abort()
    }
    controllers.clear()
    busy = false
    polling = false
    for (const input of root.querySelectorAll<HTMLInputElement>('input[type="password"]')) input.value = ''
  }
  return {
    close,
    refresh,
    explain: (message) => {
      root.querySelector('.local-explanation')?.remove()
      const line = el('p', 'hint local-explanation', message)
      line.setAttribute('role', 'status')
      root.querySelector('.local-model-head')?.after(line)
    },
    open: () => {
      close()
      active = true
      const next = options.host?.()
      // Another computer's machine and models are not this one's: nothing read for one is kept for the other.
      if (next?.id !== host?.id) {
        overview = undefined
        jobs = []
        targets.clear()
        selectedFormat = undefined
      }
      host = next
      const heading = el('h2', 'step-heading', host ? `Models on ${host.name}` : options.firstRun ? 'Download a model for this computer' : 'Local models')
      refreshButton = button('Refresh', () => void refresh())
      const head = el('div', 'local-model-head')
      head.append(heading, refreshButton)
      said = el('p', 'hint', `Reading ${here()} and its models…`)
      said.setAttribute('role', 'status')
      jobArea = el('div', 'local-jobs')
      modeArea = el('div', 'local-mode')
      content = el('div', 'local-model-content')
      root.replaceChildren(head, said, jobArea, modeArea, content)
      void refresh()
    },
  }
}
