// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { pins, rememberLocalChoice, setPin, type Ran } from './commands.js'
import { rememberTarget, selectedTarget, TARGET_KEY } from './compute/target.js'
import { ComputeError, parseCatalogId, qualify, sameTarget, THIS_HOST, type ExecutionTarget, type HostView, type TargetStatus } from './compute/types.js'
import { readInstalled, remember, type Installed } from './installed.js'
import { runtimeReady, runtimeSupported } from './llama.js'
import type { LocalRunners } from './localRunners.js'
import { contextPreview } from './localSettings.js'
import { machine, memoryBudget, type Machine } from './machine.js'
import { mlxRuntimeReady, mlxSupported } from './mlx.js'
import { CORE } from './secrets.js'
import type { Store } from './store.js'

export type ModelMode = 'local' | 'cloud' | 'combined'
export interface ModeTransition {
  id: string
  targetMode: ModelMode
  selectedModel?: { id: string; name: string }
  /** An installed model here, offered only when the selected paired computer is offline. */
  alternative?: { id: string; name: string }
  phase: 'waiting' | 'loading' | 'unloading' | 'ready' | 'failed'
  message: string
  picker?: boolean
  /** Where the model being switched to runs: this computer, or the paired one that was selected. */
  target?: ExecutionTarget
  /** A paired computer's own progress — connecting, setup, queued, loading — or why it cannot serve. */
  targetStatus?: TargetStatus
}
export interface ModeTransitionOptions {
  store: Store
  dataDir: string
  runners: Pick<LocalRunners, 'ensure' | 'loaded' | 'stop'>
  busy(): boolean
  machine?: () => Promise<Machine>
  /** No runtime downloads during a switch. Install/retry in the picker prepares them. */
  available?: (one: Installed, here: Machine) => boolean
  /** Existing Ollama selections retain their external lifecycle, including onboarding. */
  external?: (id: string) => Promise<{ id: string; name: string } | undefined>
  /** Bound only the connection check, not a reachable computer's model preparation. */
  reachabilityMs?: number
  /**
   * A model on a paired computer (`compute/bridge.ts`). `select` resolves once that computer
   * has the model ready and rejects with the named reason it cannot; nothing else is tried.
   */
  remote?: {
    select(target: ExecutionTarget, signal: AbortSignal, onStatus?: (status: TargetStatus) => void): Promise<{ id: string; name: string }>
    deselect(): Promise<void>
    ensure?(hostId: string, signal: AbortSignal): Promise<void>
    views?(): HostView[]
    /** What the paired computer calls itself, for the line that says where the model runs. */
    hostName?(hostId: string): string | undefined
  }
}

/** One serialized lifecycle for every mode control. Only the latest request can commit. */
export class ModeTransitions {
  private current?: ModeTransition
  private controller?: AbortController
  private queue: Promise<void> = Promise.resolve()
  private closed = false

  constructor(private readonly options: ModeTransitionOptions) {
    const pinned = pins(options.store).model
    if (options.store.kvGet(CORE, 'last_local_model') === undefined && pinned && readInstalled(options.dataDir).some((one) => one.id === pinned)) {
      rememberLocalChoice(options.store, pinned)
    }
    // A selection saved before there were paired computers becomes one on this computer.
    selectedTarget(options.store)
    if (options.store.kvGet(CORE, 'mode') === 'local') this.request('local')
  }

  status(): ModeTransition | undefined {
    return this.current && { ...this.current,
      ...(this.current.selectedModel && { selectedModel: { ...this.current.selectedModel } }),
      ...(this.current.alternative && { alternative: { ...this.current.alternative } }),
    }
  }
  pending(): boolean { return !!this.current && !['ready', 'failed'].includes(this.current.phase) }

  request(targetMode: ModelMode, model?: string): Ran {
    if (this.closed) return { ok: false, note: 'Alexia is closing.' }
    const waiting = this.options.busy() || this.pending()
    const previous = this.current
    const keepTarget = targetMode === 'local' && model && previous?.phase === 'failed' && previous.alternative?.id === model
      && previous.target?.hostId !== THIS_HOST && sameTarget(selectedTarget(this.options.store), previous.target) ? previous.target : undefined
    this.controller?.abort(new Error('Another mode was selected.'))
    const controller = new AbortController()
    this.controller = controller
    const transition: ModeTransition = {
      id: randomUUID(), targetMode, phase: waiting ? 'waiting' : targetMode === 'local' ? 'loading' : 'unloading',
      message: waiting ? 'Switching after the current operation finishes.' : targetMode === 'local' ? 'Choosing an installed local model…' : 'Unloading local models…',
    }
    this.current = transition
    this.queue = this.queue.then(() => this.perform(transition, controller.signal, model, keepTarget))
    return { ok: true, note: transition.message, data: { transitionId: transition.id } }
  }

  private available(one: Installed, here: Machine): boolean {
    if (one.ready === false || !one.files.every((file) => { try { return statSync(file).isFile() } catch { return false } })) return false
    return this.options.available?.(one, here) ?? (one.format === 'mlx'
      ? mlxSupported(here.platform, here.arch) && mlxRuntimeReady(this.options.dataDir) !== undefined
      : runtimeSupported(here.platform, here.arch) && (one.backend ? runtimeReady(this.options.dataDir, { backend: one.backend }) !== undefined : (['cpu', 'metal', 'cuda', 'vulkan'] as const).some((backend) => runtimeReady(this.options.dataDir, { backend }) !== undefined)))
  }

  private fits(one: Installed, here: Machine, all: Installed[]): boolean {
    try { return contextPreview(here, one, all).verdict !== 'too-big' } catch { return false }
  }

  private candidates(here: Machine, wanted?: string, explicit?: string): { all: Installed[]; possible: Installed[] } {
    const all = readInstalled(this.options.dataDir)
    const candidates = all.filter((one) => this.available(one, here)).sort((a, b) =>
      Number(b.id === wanted) - Number(a.id === wanted) || Number(b.tools) - Number(a.tools) ||
      (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.id.localeCompare(b.id))
    const capacity = { ...here, budgetBytes: memoryBudget(here.ramBytes) }
    return { all, possible: candidates.filter((one) => (!explicit || one.id === explicit) && this.fits(one, capacity, all)) }
  }

  private async reachable(target: ExecutionTarget, signal: AbortSignal): Promise<void> {
    const remote = this.options.remote
    if (!remote?.ensure) return
    const probe = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        remote.ensure(target.hostId, AbortSignal.any([signal, probe.signal])),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new ComputeError('offline', 'That computer cannot be reached right now.'))
            probe.abort()
          }, this.options.reachabilityMs ?? 3000)
        }),
      ])
    } finally { clearTimeout(timer) }
  }

  private async perform(transition: ModeTransition, signal: AbortSignal, explicit?: string, keepTarget?: ExecutionTarget): Promise<void> {
    let loading = false
    const { runners, store, dataDir } = this.options
    try {
      signal.throwIfAborted()
      while (this.options.busy()) await delay(100, undefined, { signal })
      signal.throwIfAborted()
      if (transition.targetMode !== 'local') {
        transition.phase = 'unloading'
        transition.message = 'Unloading local models…'
        // The remembered choice is already written on explicit selection or activation.
        const selected = explicit ?? pins(store).model
        if (selected && (explicit || store.kvGet(CORE, 'last_local_model') === undefined) && readInstalled(dataDir).some((one) => one.id === selected)) rememberLocalChoice(store, selected)
        await runners.stop()
        await this.options.remote?.deselect()
        signal.throwIfAborted()
        setPin(store, { model: undefined, order: undefined })
        store.kvSet(CORE, 'mode', transition.targetMode)
        transition.phase = 'ready'
        transition.message = `${transition.targetMode === 'cloud' ? 'Cloud' : 'Combined'} · Automatic`
        return
      }

      // A paired computer that was selected stays the selection until somebody chooses otherwise,
      // and one that was unpaired leaves nothing selected: the picker, never another model.
      const saved = selectedTarget(store)
      if (!explicit && !saved && store.kvGet(CORE, TARGET_KEY) !== undefined) {
        transition.picker = true
        throw new Error('The selected model is no longer available. Choose a model below.')
      }
      const wanted = explicit ?? (saved && saved.hostId !== THIS_HOST ? qualify(saved) : undefined) ?? store.kvGet(CORE, 'last_local_model') as string | undefined ?? pins(store).model
      const target = wanted ? parseCatalogId(wanted) : undefined
      if (target && target.hostId !== THIS_HOST) {
        // Strict: this computer's models are not a fallback for a paired one, so every way out
        // of this branch is that target ready or a failure that opens the picker.
        const { remote } = this.options
        transition.target = target
        try {
          if (!remote) throw new Error('Paired computers are not available. Choose a model below.')
          transition.phase = 'unloading'
          transition.message = 'Unloading Alexia’s local models…'
          await runners.stop()
          signal.throwIfAborted()
          transition.phase = 'loading'
          transition.message = 'Connecting to the paired computer…'
          transition.targetStatus = { target, phase: 'connecting', connection: remote.views?.().find((view) => view.host.id === target.hostId)?.connection ?? 'offline', message: transition.message }
          await this.reachable(target, signal)
          signal.throwIfAborted()
          const selected = await remote.select(target, signal, (status) => {
            transition.targetStatus = status
            transition.message = status.message
          })
          signal.throwIfAborted()
          rememberTarget(store, target)
          setPin(store, { model: qualify(target), order: undefined })
          store.kvSet(CORE, 'mode', 'local')
          transition.selectedModel = { id: qualify(target), name: selected.name }
          transition.phase = 'ready'
          transition.message = `Local · ${selected.name} · ${remote.hostName?.(target.hostId) ?? 'Paired computer'}`
        } catch (error) {
          transition.picker = true
          if (!signal.aborted && error instanceof ComputeError && transition.targetStatus?.phase === 'connecting') {
            // A refusal during the connection check has the same state as one during preparation.
            const phase = error.code === 'busy' || error.code === 'setup-required' || error.code === 'worker-failure' || error.code === 'incompatible-version' ? error.code : 'offline'
            transition.targetStatus = { target, phase, connection: this.options.remote?.views?.().find((view) => view.host.id === target.hostId)?.connection ?? 'offline', message: error.message }
          } else if (!(error instanceof ComputeError) && transition.targetStatus?.phase === 'connecting') transition.targetStatus = undefined
          if (!signal.aborted && error instanceof ComputeError && error.code === 'offline') {
            transition.targetStatus = { target, phase: 'offline', connection: 'offline', message: error.message }
            // Offer the same choice this computer would make, without loading or remembering it.
            try {
              const here = await (this.options.machine ?? (() => machine(dataDir)))()
              signal.throwIfAborted()
              const { all, possible } = this.candidates(here, store.kvGet(CORE, 'last_local_model') as string | undefined)
              const alternative = possible.find((one) => this.fits(one, here, all))
              if (alternative) transition.alternative = { id: alternative.id, name: alternative.name }
            } catch { /* The paired computer's failure remains the reason for the picker. */ }
          }
          throw error
        }
        return
      }
      if (wanted && !/^(llama|mlx)\//.test(wanted)) {
        const external = await this.options.external?.(wanted)
        signal.throwIfAborted()
        if (external) {
          transition.phase = 'unloading'
          transition.message = 'Unloading Alexia’s local models…'
          await runners.stop()
          await this.options.remote?.deselect()
          signal.throwIfAborted()
          rememberLocalChoice(store, external.id)
          setPin(store, { model: external.id, order: undefined })
          store.kvSet(CORE, 'mode', 'local')
          transition.selectedModel = external
          transition.phase = 'ready'
          transition.message = `Local · ${external.name} (Ollama)`
          return
        }
      }
      let here = await (this.options.machine ?? (() => machine(dataDir)))()
      signal.throwIfAborted()
      // Check total capacity first. An already loaded model must not be counted twice
      // against free RAM, but a changed context/draft still has to fit the machine.
      const { all, possible } = this.candidates(here, wanted, explicit)
      let chosen = possible[0]
      if (!chosen) {
        transition.picker = true
        throw new Error(explicit ? 'That local model is missing, unchecked, unsupported, or too large. Choose a usable model below.' : 'No checked local model fits this computer with an installed runner. Install, retry, or choose a model below.')
      }
      if (runners.loaded()?.model !== chosen.id) {
        // Releasing the old target makes the available-memory probe meaningful.
        transition.phase = 'unloading'
        transition.message = 'Unloading the previous local model…'
        await runners.stop()
        await this.options.remote?.deselect()
        signal.throwIfAborted()
        here = await (this.options.machine ?? (() => machine(dataDir)))()
        signal.throwIfAborted()
        chosen = possible.find((one) => this.available(one, here) && this.fits(one, here, all))
        if (!chosen) {
          transition.picker = true
          throw new Error('No installed local model fits the available memory. Close other applications or choose a smaller model below.')
        }
      }
      transition.selectedModel = { id: chosen.id, name: chosen.name }
      transition.target = { hostId: THIS_HOST, modelId: chosen.id }
      transition.phase = 'loading'
      transition.message = `Loading ${chosen.name}…`
      loading = true
      // ensure resolves only after the runner's authenticated readiness check.
      await runners.ensure(chosen.id, signal, { download: false })
      signal.throwIfAborted()
      const checked = readInstalled(dataDir).find((one) => one.id === chosen.id)
      if (!checked || !this.available(checked, here)) throw new Error('The selected local model changed while it was loading. Choose it again.')
      remember(dataDir, { ...checked, lastUsedAt: Date.now() })
      setPin(store, { model: chosen.id, order: undefined })
      // This explicit offline offer is temporary; the next Local entry tries the paired target.
      if (keepTarget) rememberTarget(store, keepTarget)
      store.kvSet(CORE, 'mode', 'local')
      transition.phase = 'ready'
      transition.message = `Local · ${chosen.name}`
    } catch (error) {
      // A runner can finish after cancellation. Drain it before the replacement request
      // starts, even if its implementation took time to observe the signal.
      if (loading) await runners.stop().catch(() => undefined)
      if (signal.aborted) return
      transition.phase = 'failed'
      transition.message = error instanceof Error ? error.message : String(error)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.controller?.abort(new Error('Alexia is closing.'))
    await this.queue
  }
}
