// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Ran } from '../commands.js'
import { Refused, type LocalModels, type Mode, type Target } from '../localModels.js'
import { CORE } from '../secrets.js'
import type { Store } from '../store.js'
import type { Bridge } from './bridge.js'
import { readConnectHints, type Connect, type ConnectHints, type PairedPeer } from './connect.js'
import type { Controller } from './controller.js'
import type { HostModels, HostProtocol } from './hostProtocol.js'
import type { Hosts } from './hosts.js'
import type { Inventory } from './inventory.js'
import { JOBS_KEY, type RemoteJobs } from './jobs.js'
import { HOST_MODEL_OPS, isHostModelOp, type HostModelOp } from './protocol.js'
import { RoleSwitcher, type RoleSwitch, type RoleSwitcherOptions } from './role.js'
import type { Scheduler } from './scheduler.js'
import { scrub } from './scrub.js'
import type { Setup } from './setup.js'
import { selectedHost } from './target.js'
import {
  ComputeError, connectionLabel, finished, isHostId, isRemoteId, parseCatalogId, ROLES, THIS_HOST,
  type ComputeErrorCode, type ComputeFailure, type ConnectionState, type HostView, type JobSnapshot,
  type PairingStatus, type QueueSnapshot, type Role, type TargetStatus,
} from './types.js'

/** `{ relay?, mailbox? }`: the connectivity services to use instead of the built-in defaults. */
export const SERVICES_KEY = 'compute_services'
/** The host whose models the picker shows. Not the selected target: looking at a host chooses nothing. */
export const SHOWN_KEY = 'compute_shown_host'
/** Host id → the address hints the sidecar last learned for it. They locate an identity; they never allow one. */
export const HINTS_KEY = 'compute_hints'

type Body = Record<string, unknown>

export { scrub } from './scrub.js'

const cleanFailure = (failure: ComputeFailure): ComputeFailure => ({ code: failure.code, message: scrub(String(failure.message ?? '')) })

/** A job as the screen may be shown it: its failure and its progress line with no path in them. */
export function cleanJob(job: JobSnapshot): JobSnapshot {
  return {
    ...job,
    ...(job.failure && { failure: cleanFailure(job.failure) }),
    ...(job.progress?.message !== undefined && { progress: { ...job.progress, message: scrub(job.progress.message) } }),
  }
}

const cleanQueue = (queue: QueueSnapshot): QueueSnapshot =>
  ({ ...(queue.running && { running: cleanJob(queue.running) }), waiting: queue.waiting.map(cleanJob), paused: queue.paused === true })
const cleanView = (view: HostView): HostView => ({ ...view, ...(view.failure && { failure: cleanFailure(view.failure) }) })
export const cleanTarget = (status: TargetStatus): TargetStatus => ({ ...status, message: scrub(status.message) })

/** A picker answer from a host: its jobs say what they are doing, never where on that computer. */
function cleanPicker(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const answer = { ...(value as Record<string, unknown>) }
  for (const key of ['target', 'message', 'error', 'said']) if (typeof answer[key] === 'string') answer[key] = scrub(answer[key])
  if (Array.isArray(answer.jobs)) answer.jobs = answer.jobs.map(cleanPicker)
  return answer
}

/** The HTTP status a named state is answered with. The code in the body is what the screen reads. */
const STATUS: Record<ComputeErrorCode, number> = {
  offline: 503, busy: 503, 'incompatible-version': 409, 'setup-required': 409, 'worker-failure': 502, unpaired: 404,
  cancelled: 409, interrupted: 409, 'not-found': 404, refused: 409, expired: 409,
}

/** A request this file refuses itself, with the status it is refused with. */
class Refusal extends Error {
  constructor(readonly status: number, message: string, readonly code: ComputeErrorCode = 'refused') { super(message) }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const without = (value: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))

/** Wait for `work`, but no longer than `ms`: a host that does not answer is one that is offline. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new ComputeError('offline', 'That computer did not answer in time.')) }, ms)
      timer.unref()
    })])
  } finally { clearTimeout(timer) }
}

/** How long a route waits for a host before saying it is offline. Shorter than the screen's own patience. */
const HOST_MS = 12_000
/** How long a read that only wants the latest view waits for a session to open. */
const GLANCE_MS = 1500
/** How long unpairing waits for the host to hear that its jobs are cancelled. */
const FAREWELL_MS = 3000

// ── the role switch, stoppable ───────────────────────────────────────────────────────────────

const STOPPED = 'The role switch was stopped. This computer keeps its role.'

/**
 * **A role switch that can be stopped, or told to stop waiting, while it waits** (T16 gap 2).
 *
 * `RoleSwitcher` refuses a second request while one is under way, so somebody who chose
 * *wait for the jobs* could only watch. This is the same switcher with two more things to
 * say to it, both only while its phase is `waiting` — once it has begun stopping services
 * there is nothing left to go back to.
 */
export class RoleSwitching extends RoleSwitcher {
  private readonly work: RoleSwitcherOptions
  private readonly held: { stop: boolean }

  constructor(options: RoleSwitcherOptions) {
    const held = { stop: false }
    // The wait asks `active()` every 100 ms; a stop is that question answered with a refusal.
    super({ ...options, active: () => { if (held.stop) throw new Error(STOPPED); return options.active() } })
    this.work = options
    this.held = held
  }

  /** A switch somebody stopped is not a failed one: it is no switch at all. */
  override status(): RoleSwitch | undefined {
    const now = super.status()
    return now?.phase === 'failed' && now.message === STOPPED ? undefined : now
  }

  override request(target: Role, options?: { cancel?: boolean }): { ok: boolean; note: string } {
    const now = super.status()
    if (!now || now.phase === 'failed') this.held.stop = false
    return super.request(target, options)
  }

  /** How many things a switch would wait on right now. */
  active(): number { return this.work.active() }

  /** Give up a switch that is still waiting. Nothing has been stopped, so nothing has to be restarted. */
  stop(): { ok: boolean; note: string } {
    if (super.status()?.phase !== 'waiting') return { ok: false, note: 'No role switch is waiting.' }
    this.held.stop = true
    return { ok: true, note: STOPPED }
  }

  /** Stop waiting politely: cancel what the switch is waiting on. It then carries on by itself. */
  escalate(): { ok: boolean; note: string } {
    if (super.status()?.phase !== 'waiting') return { ok: false, note: 'No role switch is waiting.' }
    void this.work.cancelActive().catch(() => {})
    return { ok: true, note: 'Cancelling the current work before switching roles…' }
  }
}

// ── the picker's operations, by name ─────────────────────────────────────────────────────────

/** What a computer's own picker page may ask of it: a paired computer's ten, and three done only at the computer itself. */
export const LOCAL_MODEL_OPS = [...HOST_MODEL_OPS, 'maintenance', 'import', 'import-preview'] as const
export type LocalModelOp = (typeof LOCAL_MODEL_OPS)[number]
export interface LocalPicker { call(op: LocalModelOp, args: Record<string, unknown>): Promise<unknown> }

type Cache = 'f16' | 'q8_0' | 'q4_0'
const CACHES: readonly unknown[] = ['f16', 'q8_0', 'q4_0']

/**
 * **One picker operation, checked and run against a `LocalModels`.** The argument names are
 * the ones the HTTP routes already use, so this is the whole agreement between the computer
 * that asks ({@link ComputeApi.models}) and the one that answers ({@link hostModels}).
 */
async function pickerCall(local: LocalModels, op: LocalModelOp, args: Record<string, unknown>): Promise<unknown> {
  const text = (name: string, most = 300): string => {
    const value = args[name]
    if (typeof value !== 'string' || value.length > most) throw new Refused(400, `Supply a valid ${name}.`)
    return value
  }
  const format = (): 'gguf' | 'mlx' => {
    if (args.format !== undefined && args.format !== 'gguf' && args.format !== 'mlx') throw new Refused(400, 'Choose GGUF or MLX.')
    return args.format ?? 'gguf'
  }
  const draft = (): string | null | undefined => {
    const value = args.draftModelId
    if (value === undefined || value === null) return value
    if (typeof value !== 'string' || value === '' || value.length > 300) throw new Refused(400, 'Choose a valid draft model.')
    return value
  }
  const mode = (): Mode | undefined => {
    if (args.mode !== undefined && args.mode !== 'local' && args.mode !== 'combined') throw new Refused(400, 'Choose Local or Combined.')
    return args.mode
  }
  switch (op) {
    case 'overview': return local.overview()
    case 'search': return local.search(typeof args.q === 'string' ? args.q : '', format())
    case 'repo': return local.hf(typeof args.repo === 'string' ? args.repo : '', format())
    case 'context': {
      if (args.context !== undefined && typeof args.context !== 'number') throw new Refused(400, 'Choose a valid context size.')
      if (args.kvCache !== undefined && !CACHES.includes(args.kvCache)) throw new Refused(400, 'Choose a supported KV cache precision.')
      return local.context(typeof args.id === 'string' ? args.id : '', args.context, args.kvCache as Cache | undefined, draft())
    }
    case 'configure': {
      if (typeof args.context !== 'number' || !Number.isSafeInteger(args.context)) throw new Refused(400, 'Choose a valid context size.')
      if (!CACHES.includes(args.kvCache)) throw new Refused(400, 'Choose a supported KV cache precision.')
      return local.configure(text('id'), args.context, args.kvCache as Cache, draft())
    }
    case 'progress': {
      const job = local.job(typeof args.job === 'string' ? args.job : '')
      if (!job) throw new ComputeError('not-found', 'That installation job is no longer available.')
      return job
    }
    case 'install': {
      const quant = text('quant')
      if (args.revision !== undefined && (typeof args.revision !== 'string' || !/^[a-f0-9]{40}$/i.test(args.revision))) throw new Refused(400, 'Choose a full commit revision.')
      const chosen = mode()
      const target: Target = typeof args.entry === 'string'
        ? { entry: text('entry'), quant, ...(args.format !== undefined && { format: format() }) }
        : { repo: text('repo'), quant, ...(typeof args.revision === 'string' && { revision: args.revision }), ...(format() === 'mlx' && { format: 'mlx' as const }) }
      if (chosen !== undefined) target.mode = chosen
      return local.install(target)
    }
    case 'cancel': return { ok: local.cancel(text('job')) }
    case 'benchmark': return local.benchmark(text('id'))
    case 'remove': return local.remove(text('id'))
    case 'maintenance': return local.maintenance()
    case 'import-preview': return local.importPreview(typeof args.path === 'string' ? args.path : '')
    case 'import': {
      if (args.storage !== undefined && args.storage !== 'copy' && args.storage !== 'reference') throw new Refused(400, 'Choose Copy or Reference for the imported files.')
      return local.import(text('path', 4096), args.storage === 'reference' ? 'reference' : 'copy', mode())
    }
  }
}

/** This computer's own picker, for the page it serves itself. */
export function localPicker(local: LocalModels): LocalPicker {
  return { call: (op, args) => pickerCall(local, op, args) }
}

/**
 * The picker a compute host offers its controller (`HostProtocolOptions.models`). The ten
 * operations of `HOST_MODEL_OPS` and no other; a download never switches the host's own mode;
 * and what a job says about itself is scrubbed before it leaves this computer.
 */
export function hostModels(local: LocalModels): HostModels {
  return {
    async call(op, args) {
      if (!isHostModelOp(op)) throw new ComputeError('refused', 'That model operation is not offered to a paired computer.')
      return cleanPicker(await pickerCall(local, op, without(args, 'mode')))
    },
  }
}

/** One `/api/local-models…` request as the operation it asks for, or undefined when the family has no such route. */
function pickerRequest(method: string, url: URL, sent: Body): { op: LocalModelOp | 'use' | 'token'; args: Record<string, unknown> } | undefined {
  const tail = url.pathname.slice('/api/local-models'.length).replace(/^\//, '')
  const query = url.searchParams
  const body = without(sent, 'host')
  if (method === 'GET') {
    const asked = (name: string): Record<string, unknown> => query.has(name) ? { [name]: query.get(name)! } : {}
    switch (tail) {
      case '': return { op: 'overview', args: {} }
      case 'search': return { op: 'search', args: { q: query.get('q') ?? '', ...asked('format') } }
      case 'repo': return { op: 'repo', args: { repo: query.get('repo') ?? '', ...asked('format') } }
      case 'context': return { op: 'context', args: {
        id: query.get('id') ?? '', ...asked('kvCache'),
        ...(query.has('context') && { context: Number(query.get('context')) }),
        ...(query.has('draftModelId') && { draftModelId: query.get('draftModelId') || null }),
      } }
      case 'maintenance': return { op: 'maintenance', args: {} }
      case 'import-preview': return { op: 'import-preview', args: { path: query.get('path') ?? '' } }
      case 'progress': return { op: 'progress', args: { job: query.get('job') ?? '' } }
      default: return undefined
    }
  }
  if (method === 'DELETE') {
    // The model is in the path. The reserved words are the routes, which a model id is never one of.
    if (tail === '' || tail.includes('/') || ['install', 'use', 'cancel', 'progress', 'search', 'repo', 'token', 'remove'].includes(tail)) return undefined
    return { op: 'remove', args: { id: decodeURIComponent(tail) } }
  }
  if (method !== 'POST') return undefined
  switch (tail) {
    case 'install': case 'cancel': case 'import': case 'benchmark': case 'remove': case 'use': case 'token': return { op: tail, args: body }
    case 'context': return { op: 'configure', args: body }
    default: return undefined
  }
}

/** The paired host a picker request names: in the query on a GET and a DELETE, in the body on a POST, and read from either on any of them. */
function named(url: URL, sent: Body): string | undefined {
  const host = url.searchParams.get('host') ?? (typeof sent.host === 'string' ? sent.host : undefined)
  return host === undefined || host === '' || host === THIS_HOST ? undefined : host
}

/** Whether a picker request is about a paired host at all: it names one, or it chooses one's model. */
const names = (request: IncomingMessage, url: URL, sent: Body): boolean =>
  named(url, sent) !== undefined || (request.method === 'POST' && url.pathname === '/api/local-models/use' && typeof sent.id === 'string' && isRemoteId(sent.id))

// ── what the routes need ─────────────────────────────────────────────────────────────────────

/** The address hints of paired hosts, kept between launches. A stale one costs a slower connection and nothing else. */
export function hintStore(store: Pick<Store, 'kvGet' | 'kvSet'>): { load(hostId: string): ConnectHints | undefined; save(hostId: string, hints: ConnectHints): void; forget(hostId: string): void } {
  const all = (): Record<string, ConnectHints> => ({ ...record(store.kvGet(CORE, HINTS_KEY)) }) as Record<string, ConnectHints>
  return {
    load: (hostId) => {
      const { relayUrl, directAddresses } = record(all()[hostId]) as ConnectHints
      const direct = Array.isArray(directAddresses) ? directAddresses.filter((one): one is string => typeof one === 'string').slice(0, 16) : []
      const relay = typeof relayUrl === 'string' ? relayUrl : undefined
      return relay === undefined && direct.length === 0 ? undefined : { ...(relay !== undefined && { relayUrl: relay }), directAddresses: direct }
    },
    save: (hostId, hints) => {
      const next = { ...all(), [hostId]: { relayUrl: hints.relayUrl ?? null, directAddresses: [...(hints.directAddresses ?? [])].slice(0, 16) } }
      if (JSON.stringify(next) !== JSON.stringify(all())) store.kvSet(CORE, HINTS_KEY, next)
    },
    forget: (hostId) => {
      const { [hostId]: gone, ...kept } = all()
      if (gone !== undefined) store.kvSet(CORE, HINTS_KEY, kept)
    },
  }
}

/** The saved connectivity services. Absent, or an empty field, is the built-in default. */
export function savedServices(store: Pick<Store, 'kvGet'>): { relay?: string; mailbox?: string } {
  const { relay, mailbox } = record(store.kvGet(CORE, SERVICES_KEY))
  return {
    ...(typeof relay === 'string' && relay !== '' && { relay }),
    ...(typeof mailbox === 'string' && mailbox !== '' && { mailbox }),
  }
}

/** How many jobs of one computer are kept to be asked about after they end. */
const LOG_MAX = 50

/**
 * **What recently happened to a computer's jobs**, kept as the host says it (T16 gap 1). An
 * install is a light job that never shows in the queue, and a job that failed or was
 * interrupted has left it: this is where the screen can still read either. In memory, by
 * design — it is what this run of Alexia heard, not a history.
 */
class JobLog {
  private readonly hosts = new Map<string, Map<string, JobSnapshot>>()

  note(hostId: string, job: JobSnapshot): void {
    // One answer is one chat job. The ones that worked are not news, and would push the rest out.
    if (typeof job.id !== 'string') return
    if (job.kind === 'chat' && job.state === 'succeeded') { this.hosts.get(hostId)?.delete(job.id); return }
    const jobs = this.hosts.get(hostId) ?? new Map<string, JobSnapshot>()
    this.hosts.set(hostId, jobs)
    jobs.delete(job.id)
    jobs.set(job.id, job)
    while (jobs.size > LOG_MAX) jobs.delete(jobs.keys().next().value!)
  }

  get(hostId: string, jobId: string): JobSnapshot | undefined { return this.hosts.get(hostId)?.get(jobId) }
  /** Newest first. */
  list(hostId: string): JobSnapshot[] { return [...(this.hosts.get(hostId)?.values() ?? [])].reverse() }
  forget(hostId: string): void { this.hosts.delete(hostId) }
}

export interface ComputeApiDeps {
  role: Role
  hosts: Hosts
  connect?: Connect                      // undefined when the sidecar binary is absent, or not started yet
  controller?: Controller                // interaction role
  bridge?: Bridge                        // interaction role
  jobs?: RemoteJobs                      // interaction role
  scheduler?: Scheduler                  // compute role
  protocol?: HostProtocol                // compute role
  roles: RoleSwitcher
  store: Pick<Store, 'kvGet' | 'kvSet'>
  name(): string
  appVersion: string
  /** Resolves once the transport's own start, if one is under way, has settled. Asked before every route. */
  ready?(): Promise<void>
  /** Start the transport if it is not running, for a pairing. Undefined is no sidecar on this computer. */
  start?(): Promise<Connect | undefined>
  /** Whether pairing can be offered at all: a sidecar exists here, running or not. Default: `connect` is set. */
  available?(): boolean
  /** How many things a role switch would wait on. Default: what a {@link RoleSwitching} counts. */
  active?(): number
  /** Where a paired host's address hints are kept. Default: {@link hintStore} over `store`. */
  hints?: ReturnType<typeof hintStore>
  /** Interaction role: choose a paired computer's model. `ModeTransitions.request`. */
  activate?(mode: 'local', id: string): Ran
  /** Compute role: this computer's own inventory and installs, for its setup page. */
  inventory?: Inventory
  setup?: Setup
  /** Compute role: this computer's own picker, for its setup page. */
  models?: LocalPicker
  /** Compute role: store or remove the Hugging Face token entered at this computer. */
  token?(secret: string): Promise<void>
  /** Compute role: the window may go. */
  closeWindow?(): void
  platform?: string
}

export interface ComputeState { role: Role; switching?: RoleSwitch; available: boolean; target?: TargetStatus; pairing?: PairingStatus; hosts: HostView[] }

/** A name the sidecar will carry: one line, no control characters, never empty. */
const pairingName = (name: string): string =>
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must not be sent
  name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60) || 'Alexia'

/**
 * **The routes the screen calls** (`docs/spec/remote-compute.md` §6), for both roles.
 *
 * It decides nothing about work: a route reads what the controller, the scheduler or the
 * host already knows, or passes on one explicit request. What it does own is pairing's last
 * step — the sidecar proving a peer does not authorise it, so the record, the allowlist and
 * the address hints are written here, in that order, and undone here on unpair.
 *
 * Two things never leave it: a pairing code goes only to the page that shows it, never to
 * `/api/state` or a log, and every line a host wrote passes through {@link scrub}.
 */
export class ComputeApi {
  private readonly log = new JobLog()
  private readonly hints: ReturnType<typeof hintStore>
  private readonly subscriptions: (() => void)[] = []
  private followed?: Controller
  private unfollow?: () => void
  private pairing?: { status: PairingStatus; abort: AbortController }
  /** One allowlist write at a time, in the order they were asked for. */
  private allowing: Promise<void> = Promise.resolve()

  constructor(private readonly deps: ComputeApiDeps) {
    this.hints = deps.hints ?? hintStore(deps.store)
    if (deps.scheduler) this.subscriptions.push(deps.scheduler.onJob((job) => { this.log.note(THIS_HOST, job) }))
    this.follow()
  }

  /** True when the path was `/api/compute/…` — or `/api/local-models…` for a paired host — and has been answered. */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL, sent: Record<string, unknown>): Promise<boolean> {
    const picker = url.pathname === '/api/local-models' || url.pathname.startsWith('/api/local-models/')
    if (!picker && !url.pathname.startsWith('/api/compute/')) return false
    // This computer's own picker is not held up by anything here, a transport still starting included.
    if (picker && this.deps.role === 'interaction' && !names(request, url, sent)) return false
    try {
      await this.deps.ready?.()
      this.follow()
      if (picker) return await this.picker(request, response, url, sent)
      await this.route(request, response, url, sent)
    } catch (error) { this.refuse(response, error, picker) }
    return true
  }

  /** What `/api/state` carries under `compute`. The pairing code is not in it: only the page that asked for one reads it. */
  state(): ComputeState {
    this.follow()
    const switching = this.deps.roles.status()
    const target = this.deps.bridge?.status()
    const pairing = this.pairing && { ...this.pairing.status }
    delete pairing?.code
    return {
      role: this.deps.role, ...(switching && { switching }), available: this.available(),
      ...(target && { target: cleanTarget(target) }), ...(pairing && { pairing }), hosts: this.views(),
    }
  }

  /** `/api/local-models…` for a paired host: forwarded as a `models` call. */
  async models(hostId: string, op: HostModelOp, args: Record<string, unknown>): Promise<unknown> {
    const { controller } = this.deps
    if (!controller || !this.deps.hosts.get(hostId)) throw new ComputeError('unpaired', 'That computer is not paired.')
    return cleanPicker(await controller.call(hostId, 'models', { op, args }))
  }

  /** Stop listening, and give up a pairing that is still open. */
  close(): void {
    this.pairing?.abort.abort()
    this.unfollow?.()
    this.followed = undefined
    for (const off of this.subscriptions.splice(0)) off()
  }

  // ── the routes ─────────────────────────────────────────────────────────────────────────

  private async route(request: IncomingMessage, response: ServerResponse, url: URL, sent: Body): Promise<void> {
    const { deps } = this
    const json = (value: unknown, status = 200): void => { answer(response, status, value) }
    const only = (role: Role): void => {
      if (deps.role !== role) throw new Refusal(409, role === 'compute' ? 'That is done on the computer that does the computing.' : 'That is done on the computer you talk to.')
    }
    const asked = (): string | undefined => {
      const host = request.method === 'GET' ? url.searchParams.get('host') ?? undefined : sent.host
      if (host !== undefined && typeof host !== 'string') throw new Refusal(400, 'Supply a valid host.')
      return host === '' ? undefined : host
    }

    if (url.pathname === '/api/compute/role' && request.method === 'GET') {
      const switching = deps.roles.status()
      json({ role: deps.role, ...(switching && { switching }), active: this.active() })
      return
    }
    if (url.pathname === '/api/compute/role' && request.method === 'POST') {
      if (!(ROLES as readonly unknown[]).includes(sent.role)) throw new Refusal(400, 'Choose Interaction or Compute.')
      const now = deps.roles.status()
      // The same switch asked for again with `cancel`, while it waits, is *stop waiting and cancel them*.
      const ran = sent.cancel === true && now?.phase === 'waiting' && now.target === sent.role && deps.roles instanceof RoleSwitching
        ? deps.roles.escalate()
        : deps.roles.request(sent.role as Role, { cancel: sent.cancel === true })
      json(ran, ran.ok ? 200 : 409)
      return
    }
    if (url.pathname === '/api/compute/role/cancel' && request.method === 'POST') {
      const ran = deps.roles instanceof RoleSwitching ? deps.roles.stop() : { ok: false, note: 'A role switch cannot be stopped here.' }
      json(ran, ran.ok ? 200 : 409)
      return
    }

    if (url.pathname === '/api/compute/hosts' && request.method === 'GET') {
      // A host-list read is one of the things a session is opened for. Not waited on: the list says what is known now.
      for (const host of deps.controller ? deps.hosts.list() : []) void deps.controller!.ensure(host.id).catch(() => {})
      json({ hosts: this.views(), selected: this.shown(), available: this.available() })
      return
    }

    if (url.pathname === '/api/compute/pair/start' && request.method === 'POST') {
      json({ ok: true, pairing: await this.pair(sent) })
      return
    }
    if (url.pathname === '/api/compute/pair' && request.method === 'GET') {
      json({ ...(this.pairing && { pairing: { ...this.pairing.status } }) })
      return
    }
    if (url.pathname === '/api/compute/pair/cancel' && request.method === 'POST') {
      const open = this.pairing
      if (open && ['waiting', 'connecting', 'verifying'].includes(open.status.phase)) {
        open.status = { phase: 'cancelled', message: 'Pairing was cancelled. A fresh code is needed to try again.' }
        open.abort.abort()
      }
      json({ ok: true })
      return
    }
    if (url.pathname === '/api/compute/unpair' && request.method === 'POST') {
      if (typeof sent.host !== 'string' || !deps.hosts.get(sent.host)) throw new Refusal(404, 'That computer is not paired.', 'unpaired')
      await this.unpair(sent.host)
      json({ ok: true })
      return
    }

    if (url.pathname === '/api/compute/inventory' && request.method === 'GET') {
      if (deps.role === 'compute') {
        // The compute role's own setup list. Read as it was last built: looking at a page probes nothing.
        if (!deps.inventory) throw new Refusal(409, 'This computer has no inventory to read.', 'setup-required')
        json({ inventory: await deps.inventory.current(), connection: this.reach() })
        return
      }
      const host = this.paired(asked())
      await within(this.controller().ensure(host), GLANCE_MS).catch(() => {})
      const view = cleanView(this.controller().view(host)!)
      json({ ...(view.inventory && { inventory: view.inventory }), connection: view.connection, ...(view.failure && { failure: view.failure }) })
      return
    }
    if (url.pathname === '/api/compute/status' && request.method === 'GET') {
      const target = deps.bridge?.status()
      if (deps.role === 'compute') {
        const connection = this.reach()
        json({ connection, label: connectionLabel(connection) })
        return
      }
      const host = this.paired(asked() ?? selectedHost(deps.store))
      const view = cleanView(this.controller().view(host)!)
      json({
        connection: view.connection, label: connectionLabel(view.connection), ...(view.failure && { failure: view.failure }),
        ...(target?.target.hostId === host && { target: cleanTarget(target) }),
      })
      return
    }
    if (url.pathname === '/api/compute/select' && request.method === 'POST') {
      only('interaction')
      if (sent.host !== THIS_HOST) this.paired(typeof sent.host === 'string' ? sent.host : undefined)
      deps.store.kvSet(CORE, SHOWN_KEY, sent.host)
      if (sent.host !== THIS_HOST) void deps.controller?.ensure(sent.host as string).catch(() => {})
      json({ ok: true })
      return
    }

    if (url.pathname === '/api/compute/setup/install' && request.method === 'POST') {
      if (typeof sent.requirement !== 'string' || sent.requirement === '' || sent.requirement.length > 200) throw new Refusal(400, 'Supply a valid requirement.')
      if (deps.role === 'compute') {
        if (!deps.setup) throw new Refusal(409, 'Nothing can be installed from here.', 'setup-required')
        json({ ok: true, job: cleanJob(deps.setup.install(sent.requirement, randomUUID())) })
        return
      }
      const host = this.paired(asked())
      const job = await within(this.controller().call(host, 'setup.install', { jobId: randomUUID(), requirementId: sent.requirement }), HOST_MS)
      this.log.note(host, job)
      json({ ok: true, job: cleanJob(job) })
      return
    }

    if (url.pathname === '/api/compute/queue' && request.method === 'GET') {
      if (deps.role === 'compute') {
        json({ queue: cleanQueue(this.scheduler().queue()) })
        return
      }
      const host = this.paired(asked())
      await within(this.controller().ensure(host), HOST_MS)
      json({ queue: cleanQueue(this.controller().queue(host) ?? await within(this.controller().call(host, 'queue.get', {}), HOST_MS)) })
      return
    }
    if (url.pathname === '/api/compute/job' && request.method === 'GET') {
      const id = url.searchParams.get('job') ?? ''
      if (id === '' || id.length > 200) throw new Refusal(400, 'Supply a valid job.')
      json({ job: cleanJob(await this.job(asked(), id)) })
      return
    }
    if (url.pathname === '/api/compute/jobs' && request.method === 'GET') {
      const host = deps.role === 'compute' ? THIS_HOST : this.paired(asked())
      json({ jobs: this.log.list(host).map(cleanJob) })
      return
    }
    if (url.pathname === '/api/compute/jobs/cancel' && request.method === 'POST') {
      if (typeof sent.job !== 'string' || sent.job === '' || sent.job.length > 200) throw new Refusal(400, 'Supply a valid job.')
      if (deps.role === 'compute') {
        // Its own queue, named `this` or not named at all: whoever is at the host may cancel what runs on it.
        const job = this.scheduler().cancel(sent.job)
        json({ ok: true, job: cleanJob(job) })
        return
      }
      const host = this.paired(asked())
      if (!deps.jobs) throw new ComputeError('offline', 'That computer cannot be reached right now.')
      const job = await within(deps.jobs.cancel(host, sent.job), HOST_MS)
      this.log.note(host, job)
      json({ ok: true, job: cleanJob(job) })
      return
    }

    if (url.pathname === '/api/compute/pause' && request.method === 'POST') {
      only('compute')
      if (typeof sent.paused !== 'boolean') throw new Refusal(400, 'Say whether this computer is paused.')
      if (deps.protocol) deps.protocol.pause(sent.paused)
      else this.scheduler().pause(sent.paused)
      json({ ok: true })
      return
    }

    if (url.pathname === '/api/compute/services' && request.method === 'GET') {
      const saved = savedServices(deps.store)
      json({ ...saved, defaults: Object.keys(saved).length === 0 })
      return
    }
    if (url.pathname === '/api/compute/services' && request.method === 'POST') {
      const address = (name: 'relay' | 'mailbox'): string | undefined => {
        const value = sent[name]
        if (value === undefined || value === null || value === '') return undefined
        if (typeof value !== 'string' || value.length > 2048 || !URL.canParse(value.split(',')[0]!.trim())) throw new Refusal(400, `Supply a valid ${name} address.`)
        return value.trim()
      }
      const [relay, mailbox] = [address('relay'), address('mailbox')]
      deps.store.kvSet(CORE, SERVICES_KEY, { ...(relay !== undefined && { relay }), ...(mailbox !== undefined && { mailbox }) })
      const saved = savedServices(deps.store)
      json({ ...saved, defaults: Object.keys(saved).length === 0 })
      return
    }

    if (url.pathname === '/api/compute/window/close' && request.method === 'POST') {
      only('compute')
      if (!deps.closeWindow) throw new Refusal(409, 'There is no window to close here.')
      deps.closeWindow()
      json({ ok: true })
      return
    }

    json({ ok: false, said: 'That compute endpoint or method is not available.' }, 404)
  }

  /**
   * `/api/local-models…`. On the interaction computer only a request that names a paired
   * host is answered here — `false` hands everything else back to the picker `serve.ts`
   * already has. On a compute host it is that computer's own picker, all of it.
   */
  private async picker(request: IncomingMessage, response: ServerResponse, url: URL, sent: Body): Promise<boolean> {
    const { deps } = this
    const host = named(url, sent)
    const call = pickerRequest(request.method ?? 'GET', url, sent)
    const lasting = call !== undefined && ['install', 'benchmark', 'import'].includes(call.op)
    const done = (value: unknown): void => {
      const said = record(value)
      answer(response, lasting ? 202 : call?.op === 'remove' && said.ok === false ? 404 : 200, value)
    }

    if (deps.role === 'compute') {
      if (!deps.models) return false
      if (!call) throw new Refusal(404, 'That local-model endpoint or method is not available.', 'not-found')
      if (call.op === 'use') throw new Refusal(409, 'A compute host does not choose a model for itself. Choose one from the computer it is paired with.')
      if (call.op === 'token') {
        if (!deps.token) throw new Refusal(409, 'A token cannot be stored from here.')
        const secret = typeof call.args.token === 'string' && call.args.token.length <= 300 ? call.args.token.trim() : undefined
        if (secret === undefined) throw new Refusal(400, 'Supply a valid token.')
        await deps.token(secret)
        done({ ok: true, said: secret ? 'Hugging Face token saved in your keychain.' : 'Hugging Face token removed.' })
        return true
      }
      done(await deps.models.call(call.op, call.args))
      return true
    }

    if (call?.op === 'use' && typeof call.args.id === 'string' && isRemoteId(call.args.id)) {
      // Choosing a paired computer's model is this computer's decision, so it is made here and never forwarded.
      const target = parseCatalogId(call.args.id)
      this.paired(target.hostId)
      if (call.args.mode !== undefined && call.args.mode !== 'local') throw new Refusal(409, 'A paired computer’s model runs in Local mode. Choose Local to use it.')
      if (!deps.activate) throw new Refusal(409, 'A paired computer’s model cannot be chosen here.')
      const ran = deps.activate('local', call.args.id)
      answer(response, ran.ok ? 200 : 409, { ok: ran.ok, said: ran.note, ...(ran.data !== undefined && { data: ran.data }) })
      return true
    }
    if (host === undefined) return false
    this.paired(host)
    if (!call) throw new Refusal(404, 'That local-model endpoint or method is not available.', 'not-found')
    if (!isHostModelOp(call.op)) throw new Refusal(400, 'That is done at the paired computer itself, not from here.')
    // A download onto a host changes nothing about this computer's mode: choosing the model afterwards is `use`.
    done(await within(this.models(host, call.op, without(call.args, 'mode')), HOST_MS))
    return true
  }

  // ── pairing ────────────────────────────────────────────────────────────────────────────

  /**
   * Open a pairing (compute) or join one by its code (interaction). Answers at once; the
   * outcome is read from `GET /api/compute/pair`. The code is held only in the status the
   * page that shows it reads, and is dropped from it the moment the pairing settles.
   */
  private async pair(sent: Body): Promise<PairingStatus> {
    const { deps } = this
    const hosting = deps.role === 'compute'
    if (hosting && deps.hosts.list().length > 0) throw new Refusal(409, 'Unpair the current computer first.')
    const code = hosting ? undefined : typeof sent.code === 'string' ? sent.code.trim() : ''
    if (code !== undefined && (code === '' || code.length > 200)) throw new Refusal(400, 'Type the code the other computer is showing.')
    const connect = deps.connect ?? await deps.start?.()
    if (!connect) throw new ComputeError('setup-required', 'Pairing is not available: the part of Alexia that connects two computers is not installed.')

    // One pairing at a time. Asking again gives up the one that was open, and its code with it.
    this.pairing?.abort.abort()
    const abort = new AbortController()
    const pairing = { status: { phase: hosting ? 'waiting' : 'connecting' } as PairingStatus, abort }
    this.pairing = pairing
    const me = { name: pairingName(deps.name()), role: deps.role, platform: deps.platform ?? process.platform, appVersion: deps.appVersion }
    const settle = (done: Promise<PairedPeer>): void => {
      void done.then((peer) => this.trust(connect, peer, pairing)).catch((error: unknown) => {
        // A status somebody already settled (a cancel, a newer pairing) is not overwritten by its own echo.
        if (!['waiting', 'connecting', 'verifying'].includes(pairing.status.phase)) return
        const code = error instanceof ComputeError ? error.code : 'refused'
        pairing.status = code === 'expired' ? { phase: 'expired', message: 'That code expired. A fresh code is needed to try again.' }
          : code === 'cancelled' ? { phase: 'cancelled', message: 'Pairing was cancelled. A fresh code is needed to try again.' }
          : { phase: 'failed', message: error instanceof ComputeError && code !== 'refused' ? scrub(error.message) : 'Pairing did not go through. A fresh code is needed to try again.' }
      })
    }
    try {
      if (code === undefined) {
        const opened = await connect.pairOpen(me, abort.signal)
        pairing.status = { phase: 'waiting', code: opened.code, expiresAt: opened.expiresAt }
        settle(opened.done)
      } else settle(connect.pairJoin(code, me, abort.signal))
    } catch (error) {
      if (this.pairing === pairing) this.pairing = undefined
      throw error
    }
    return { ...pairing.status }
  }

  /**
   * The sidecar proved the peer. **That is not yet permission to compute**: this writes the
   * nonsecret record, tells the sidecar to allow the endpoint, and keeps its address hints,
   * and only then calls the pairing `paired`.
   */
  private async trust(connect: Connect, peer: PairedPeer, pairing: { status: PairingStatus; abort: AbortController }): Promise<void> {
    const { deps } = this
    if (pairing.abort.signal.aborted) throw new ComputeError('cancelled', 'Pairing was cancelled.')
    pairing.status = { phase: 'verifying', peerName: peer.name }
    // An interaction computer pairs with a compute host, and the reverse. Two of a kind have nothing to say to each other.
    if (peer.role === deps.role) {
      pairing.status = { phase: 'failed', message: deps.role === 'compute'
        ? 'The other computer is a compute host too. Pair from the computer you talk to.'
        : 'The other computer is not a compute host. Switch its role to Compute, then pair again with a fresh code.' }
      return
    }
    const host = deps.hosts.add({ name: peer.name, endpointId: peer.endpointId, peerRole: peer.role, platform: peer.platform, appVersion: peer.appVersion })
    await this.allow(connect)
    try { this.hints.save(host.id, await readConnectHints(connect, peer.endpointId)) } catch { /* none learned: the next handshake keeps them */ }
    pairing.status = { phase: 'paired', peerName: peer.name, hostId: host.id }
  }

  /** Make the sidecar's allowlist exactly the paired endpoints. A dropped one has its connections closed before this resolves. */
  private allow(connect: Connect): Promise<void> {
    const next = this.allowing.then(() => connect.allow(this.deps.hosts.allowlist()))
    this.allowing = next.catch(() => {})
    return next
  }

  /**
   * Forget a computer, from whichever side asks. Its jobs are cancelled first, while it can
   * still be told; then the record goes, and the allowlist with it, which closes every
   * connection to it. A reachable host is told to forget this controller too. An unreachable
   * host keeps its record until somebody unpairs there.
   */
  private async unpair(hostId: string): Promise<void> {
    const { deps } = this
    if (deps.role === 'compute' && deps.protocol) {
      await deps.protocol.revoke()
      this.hints.forget(hostId)
      return
    }
    if (deps.role === 'compute') await deps.scheduler?.cancelAll('cancelled', { code: 'unpaired', message: 'The paired computer was unpaired.' })
    const { controller, jobs, bridge } = deps
    if (controller) {
      const queue = controller.queue(hostId)
      const mine = new Set([
        ...(jobs?.outstanding(hostId) ?? []),
        ...[...(queue?.running ? [queue.running] : []), ...(queue?.waiting ?? []), ...this.log.list(hostId)].filter((job) => !finished(job.state)).map((job) => job.id),
      ])
      const farewell = [...mine].map((jobId) => controller.call(hostId, 'job.cancel', { jobId }).catch(() => {}))
      if (bridge?.status()?.target.hostId === hostId) farewell.push(bridge.deselect().catch(() => {}))
      // Only a host that is listening can be told. One that is not loses its jobs to its own grace.
      if (controller.view(hostId)?.connection !== 'offline') await within(Promise.all(farewell), FAREWELL_MS).catch(() => {})
      await within(controller.unpair(hostId), FAREWELL_MS).catch(() => {})
      await controller.drop(hostId)
    }
    deps.hosts.remove(hostId)
    this.hints.forget(hostId)
    this.log.forget(hostId)
    if (deps.store.kvGet(CORE, SHOWN_KEY) === hostId) deps.store.kvSet(CORE, SHOWN_KEY, THIS_HOST)
    // Nobody is left to tell this computer how those jobs ended.
    const wanted = deps.store.kvGet(CORE, JOBS_KEY)
    if (Array.isArray(wanted) && wanted.some((job) => record(job).hostId === hostId)) deps.store.kvSet(CORE, JOBS_KEY, wanted.filter((job) => record(job).hostId !== hostId))
    const connect = deps.connect
    if (connect) await this.allow(connect).catch(() => {})
  }

  // ── what the routes read ───────────────────────────────────────────────────────────────

  /** One job's state: what the host says now, or the last thing it said when it cannot be asked. */
  private async job(asked: string | undefined, jobId: string): Promise<JobSnapshot> {
    if (this.deps.role === 'compute') {
      const job = this.scheduler().status(jobId) ?? this.log.get(THIS_HOST, jobId)
      if (!job) throw new ComputeError('not-found', 'That compute job is not known.')
      return job
    }
    const host = this.paired(asked)
    const known = this.log.get(host, jobId)
    try {
      const job = await within(this.controller().call(host, 'job.status', { jobId }), HOST_MS)
      this.log.note(host, job)
      return job
    } catch (error) {
      if (!known) throw error
      if (error instanceof ComputeError && error.code === 'not-found' && !finished(known.state)) {
        // The host has no memory of a job it was running: it restarted, which is what `interrupted` means.
        const lost: JobSnapshot = { ...known, state: 'interrupted', failure: { code: 'interrupted', message: 'That computer no longer has this job.' } }
        this.log.note(host, lost)
        return lost
      }
      return known
    }
  }

  private views(): HostView[] {
    const { controller, connect, hosts } = this.deps
    return (controller ? controller.views() : hosts.list().map((host): HostView => ({ host, connection: connect?.state(host.endpointId) ?? 'offline' }))).map(cleanView)
  }

  /** How this compute host reaches its controller right now. */
  private reach(): ConnectionState {
    const host = this.deps.hosts.list()[0]
    return (host && this.deps.connect?.state(host.endpointId)) || 'offline'
  }

  /** The host the picker shows: what was last looked at while it is still paired, else where the selected model runs. */
  private shown(): string {
    if (this.deps.role === 'compute') return THIS_HOST
    const { store, hosts } = this.deps
    const saved = store.kvGet(CORE, SHOWN_KEY)
    if (saved === THIS_HOST || (isHostId(saved) && hosts.get(saved))) return saved
    return selectedHost(store)
  }

  private available(): boolean { return this.deps.available?.() ?? this.deps.connect !== undefined }
  private active(): number { return this.deps.active?.() ?? (this.deps.roles instanceof RoleSwitching ? this.deps.roles.active() : 0) }

  /** A host id that names a paired computer, or the refusal that says it does not. */
  private paired(host: string | undefined): string {
    if (host === undefined || host === THIS_HOST) throw new Refusal(400, 'Choose a paired computer.')
    if (!isHostId(host) || !this.deps.hosts.get(host)) throw new Refusal(404, 'That computer is not paired.', 'unpaired')
    return host
  }

  private controller(): Controller {
    if (this.deps.role !== 'interaction' || !this.deps.controller) throw new Refusal(409, 'That is done on the computer you talk to.')
    return this.deps.controller
  }

  private scheduler(): Scheduler {
    if (!this.deps.scheduler) throw new Refusal(409, 'That is done on the computer that does the computing.')
    return this.deps.scheduler
  }

  /** Hear what the controller's hosts say about their jobs. The controller may arrive late, or be replaced. */
  private follow(): void {
    const controller = this.deps.controller
    if (controller === this.followed) return
    this.unfollow?.()
    this.followed = controller
    this.unfollow = controller?.onEvent((hostId, event) => { if (event.event === 'job') this.log.note(hostId, event.job) })
  }

  private refuse(response: ServerResponse, error: unknown, picker: boolean): void {
    if (response.headersSent) { response.end(); return }
    const [status, code, message] = error instanceof ComputeError ? [STATUS[error.code], error.code, error.message]
      : error instanceof Refusal ? [error.status, error.code, error.message]
      : error instanceof Refused ? [error.status, undefined, error.message]
      : [picker ? 502 : 500, undefined, error instanceof Error ? error.message : String(error)]
    const said = scrub(message)
    // The picker's own page reads `error`; everything else reads `said`.
    answer(response, status, { ok: false, said, ...(code !== undefined && { code }), ...(picker && { error: said }) })
  }
}

function answer(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}
