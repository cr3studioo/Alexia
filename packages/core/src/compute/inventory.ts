// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { machine, type Machine } from '../machine.js'
import type { HostCapability, HostInventory, HostMachine, SetupRequirement } from './types.js'
import type { ComputeWorker, Workers } from './workers.js'
import { scrub } from './scrub.js'

export type RefreshReason = 'setup' | 'prepare' | 'admission' | 'workers' | 'models'
/** The only three reasons hardware is looked at. Nothing here samples on a timer. */
const PROBED: readonly RefreshReason[] = ['setup', 'prepare', 'admission']

const hostMachine = (m: Machine): HostMachine => ({
  platform: m.platform, arch: m.arch, chip: m.chip, appleSilicon: m.appleSilicon, ramBytes: m.ramBytes,
  ...(m.freeRamBytes !== undefined && { freeRamBytes: m.freeRamBytes }),
  freeDiskBytes: m.freeDiskBytes,
  ...(m.diskKnown !== undefined && { diskKnown: m.diskKnown }),
  budgetBytes: m.budgetBytes,
  ...(m.cpuCores !== undefined && { cpuCores: m.cpuCores }),
  ...(m.gpus && { gpus: m.gpus.map((gpu) => ({ ...gpu })) }),
  ...(m.gpuProbeError !== undefined && { gpuProbeError: scrub(m.gpuProbeError) }),
})

/** A requirement's id as the controller sees it: stable, and saying nothing about which worker asked. */
const published = (workerId: string, requirementId: string): string =>
  createHash('sha256').update(workerId).update('\0').update(requirementId).digest('hex').slice(0, 16)

/** What a requirement in the last inventory belongs to. `requirement.id` is the worker's own. */
export interface Requirement { worker: ComputeWorker; requirement: SetupRequirement }

/** What the host says about itself: built when something happens, and only then. */
export class Inventory {
  #last?: HostInventory
  #machine?: HostMachine
  /** What each worker last said it is missing. Asked on setup, and once of a worker never asked. */
  readonly #needs = new Map<ComputeWorker, SetupRequirement[]>()
  #index = new Map<string, Requirement>()
  #queue: Promise<unknown> = Promise.resolve()
  readonly #listeners = new Set<(inventory: HostInventory) => void>()
  readonly #unwatch: () => void

  constructor(private readonly options: { dataDir: string; name: string; appVersion: string; workers: Workers; machine?: () => Promise<Machine> }) {
    this.#unwatch = options.workers.onChange(() => { void this.refresh('workers').catch(() => {}) })
  }

  /** The last built inventory, building it the first time. */
  current(): Promise<HostInventory> {
    return this.#last ? Promise.resolve(structuredClone(this.#last)) : this.#build()
  }

  /** Something changed (an install finished, a plugin came or went, a job was admitted). Rebuilds and notifies. */
  refresh(reason: RefreshReason): Promise<HostInventory> {
    return this.#build(reason)
  }

  onChange(listener: (inventory: HostInventory) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** The worker and the worker's own requirement behind an id in the last inventory. */
  requirement(id: string): Requirement | undefined {
    return this.#index.get(id)
  }

  /** Stop following the worker list. */
  close(): void {
    this.#unwatch()
    this.#listeners.clear()
  }

  /** One rebuild at a time, in the order they were asked for. No reason is `current()` finding nothing built. */
  #build(reason?: RefreshReason): Promise<HostInventory> {
    const built = this.#queue.then(async () => {
      if (reason === undefined && this.#last) return structuredClone(this.#last)
      return this.#rebuild(reason)
    })
    this.#queue = built.catch(() => undefined)
    return built
  }

  async #rebuild(reason?: RefreshReason): Promise<HostInventory> {
    const { workers } = this.options
    const all = workers.all()
    // An inventory has to say what the hardware is, so the first one is a setup probe.
    const first = this.#last === undefined
    if (first || this.#machine === undefined || PROBED.includes(reason!)) {
      this.#machine = hostMachine(await (this.options.machine ?? (() => machine(this.options.dataDir)))())
    }
    for (const known of [...this.#needs.keys()]) if (!all.includes(known)) this.#needs.delete(known)

    const capabilities: HostCapability[] = []
    const setup: SetupRequirement[] = []
    const index = new Map<string, Requirement>()
    for (const worker of all) {
      const offered = await worker.capabilities().catch(() => [])
      // A model coming or going changes what the text worker is missing, and asking it starts nothing.
      const ask = first || reason === 'setup' || !this.#needs.has(worker) || (reason === 'models' && worker === workers.text)
      if (ask) {
        this.#needs.set(worker, await worker.setup().catch((): SetupRequirement[] => [{
          id: 'unchecked', kind: 'dependency', title: 'This worker could not be checked', action: 'instructions',
          instructions: 'Restart Alexia on this computer, then check again.', blocks: offered.map((one) => one.cap),
        }]))
      }
      for (const requirement of this.#needs.get(worker) ?? []) {
        const id = published(worker.id, requirement.id)
        if (index.has(id)) continue
        index.set(id, { worker, requirement })
        setup.push({ ...requirement, id, blocks: [...requirement.blocks] })
      }
      for (const one of offered) if (!capabilities.some((known) => known.cap === one.cap)) capabilities.push({ ...one })
    }
    for (const one of capabilities) one.ready = !setup.some((need) => need.blocks.includes(one.cap))

    const content = { name: this.options.name, appVersion: this.options.appVersion, machine: this.#machine, models: workers.text.models(), capabilities, setup }
    this.#index = index
    const last = this.#last
    if (last && JSON.stringify(content) === JSON.stringify({ ...content, ...last, revision: undefined })) return structuredClone(last)
    const next: HostInventory = structuredClone({ ...content, revision: (last?.revision ?? 0) + 1 })
    this.#last = next
    for (const listener of [...this.#listeners]) { try { listener(structuredClone(next)) } catch { /* A listener cannot stop the others hearing. */ } }
    return structuredClone(next)
  }
}
