// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Remote compute, as the screen shows it (`docs/spec/remote-compute.md` §6 and §10): which
 * computer runs local models, how it is reached, pairing another one, this computer's role,
 * and the paired computer's queue and setup list.
 *
 * **The screen never chooses for anybody.** A host that is offline, busy or missing something
 * stays in the list with its own sentence, and nothing here selects another host, another
 * model or a cloud service to avoid showing one. Core sends a code; the sentence is written
 * here, once per state, in {@link stateSentence}.
 *
 * No Node in here, ever (invariant 6). Shared types are erased from the browser module.
 */

import { modelBytes, type LocalRequest } from './local-models.js'
import { arm, el } from './widgets.js'
import type {
  Role, ConnectionState, ComputeErrorCode, ComputeFailure, ExecutionTarget, TargetStatus,
  PairingPhase, PairingStatus, JobSnapshot, QueueSnapshot, HostInventory, HostView,
} from '../../core/src/compute/types.js'
import type { RoleSwitch } from '../../core/src/compute/role.js'

export type {
  Role, ConnectionState, ComputeErrorCode, ComputeFailure, ExecutionTarget, TargetPhase, TargetStatus,
  PairingPhase, PairingStatus, JobState, JobSnapshot, QueueSnapshot, SetupRequirement,
  HostCapability, HostInventory, PairedHost, HostView,
} from '../../core/src/compute/types.js'
export type { RoleSwitch } from '../../core/src/compute/role.js'

export const THIS_HOST = 'this'
/** What `/api/state` carries under `compute`. */
export interface ComputeState { role: Role; switching?: RoleSwitch; available: boolean; target?: TargetStatus; pairing?: Omit<PairingStatus, 'code'>; hosts: HostView[] }

/** The computer a view is about: a paired host's id and the name it gave when it was paired. */
export interface HostChoice { id: string; name: string }

/** `Direct`, `Relayed` or `Offline`: the three words the screen shows, and no fourth. */
export const connectionLabel = (state: ConnectionState): string => state === 'direct' ? 'Direct' : state === 'relayed' ? 'Relayed' : 'Offline'

const QUALIFIED = /^@([a-z0-9]{8,32})\/(.+)$/s
/** A catalog id read back as where it runs. Anything without a host prefix is this computer's. */
export const parseCatalogId = (id: string): ExecutionTarget => {
  const found = QUALIFIED.exec(id)
  return found ? { hostId: found[1]!, modelId: found[2]! } : { hostId: THIS_HOST, modelId: id }
}
/** A paired host's model as the one id the router and the pin carry: `@<host>/<model>`. */
export const qualify = (hostId: string, modelId: string): string => hostId === THIS_HOST ? modelId : `@${hostId}/${modelId}`

/** The seven states a person can be shown (§10). Each has exactly one sentence. */
export const SHOWN_STATES = ['offline', 'busy', 'incompatible-version', 'setup-required', 'worker-failure', 'interrupted', 'unpaired'] as const
export type ShownState = (typeof SHOWN_STATES)[number]

/**
 * A state's own plain sentence, about the computer it happened on. Undefined for any other
 * code, so a caller falls back to what core said rather than to a sentence about something else.
 */
export function stateSentence(code: string, name: string): string | undefined {
  switch (code) {
    case 'offline': return `${name} is offline. Its models cannot be used until it can be reached again.`
    case 'busy': return `${name} is busy with other work. It runs one heavy job at a time, so wait for it or cancel a job in its queue.`
    case 'incompatible-version': return `${name} runs a version of Alexia that this one cannot work with. Update Alexia on both computers, then try again.`
    case 'setup-required': return `${name} is missing something this needs. Install it from the setup list for ${name}.`
    case 'worker-failure': return `The worker on ${name} stopped with an error. The job was not run again; start it again when you are ready.`
    case 'interrupted': return `The job on ${name} was interrupted before it finished. It was not started again; run it again if you still want it.`
    case 'unpaired': return `${name} no longer accepts this computer. Pair again with a fresh code to use it.`
    default: return undefined
  }
}
/** A failure's sentence: the state's own, or core's line for a code that is not one of the seven. */
export const failureSentence = (failure: { code: string; message?: string }, name: string): string =>
  stateSentence(failure.code, name) ?? (failure.message || 'That did not go through. Try again.')

/** What one job is doing, in a few words; a job that ended badly gets its state's sentence. */
export function jobSentence(job: JobSnapshot, name: string): string {
  switch (job.state) {
    case 'queued': return 'Waiting in the queue'
    case 'preparing': return 'Getting ready'
    case 'running': return 'Running'
    case 'cancelling': return 'Stopping'
    case 'succeeded': return 'Finished.'
    case 'cancelled': return 'Cancelled.'
    case 'interrupted': return stateSentence('interrupted', name)!
    case 'failed': return job.failure ? failureSentence(job.failure, name) : stateSentence('worker-failure', name)!
  }
}

const ROLE_NAME: Record<Role, string> = { interaction: 'Interaction', compute: 'Compute' }
const OPEN_PAIRING: readonly PairingPhase[] = ['waiting', 'connecting', 'verifying']
const finishedJob = (job: JobSnapshot): boolean => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.state)
const count = (n: number, one: string, many: string): string => n === 1 ? `One ${one}` : `${String(n)} ${many}`

type Answer<T> = { ok: true; value: T } | { ok: false; said: string; code?: string }

/**
 * One view's life. Everything a mounted view asks or schedules goes through this, so closing
 * it stops its timers, aborts what is in flight, and makes a late answer a no-op.
 */
class Life {
  #active = false
  #generation = 0
  readonly #timers = new Set<number>()
  readonly #controllers = new Set<AbortController>()
  constructor(private readonly request: LocalRequest) {}

  get active(): boolean { return this.#active }
  open(): void { this.close(); this.#active = true }
  close(): void {
    this.#active = false
    this.#generation++
    for (const timer of this.#timers) window.clearTimeout(timer)
    this.#timers.clear()
    for (const controller of this.#controllers) controller.abort()
    this.#controllers.clear()
  }
  /** True only while the view that asked is still the one open. */
  mark(): () => boolean {
    const mine = this.#generation
    return () => this.#active && mine === this.#generation
  }
  after(ms: number, work: () => void): number {
    const timer = window.setTimeout(() => { this.#timers.delete(timer); if (this.#active) work() }, ms)
    this.#timers.add(timer)
    return timer
  }
  /** One watch per view: asking for the next read replaces the one already waiting. */
  #watch: number | undefined
  watch(ms: number, read: () => void): void {
    if (this.#watch !== undefined) { window.clearTimeout(this.#watch); this.#timers.delete(this.#watch) }
    // Only a visible page follows what changes on its own; a hidden one looks again later.
    this.#watch = this.after(ms, () => { if (document.visibilityState === 'visible') read(); else this.watch(ms, read) })
  }
  /** Both request helpers end here: one refuses with `ok: false`, the other throws. */
  async ask<T>(path: string, body?: unknown, method: 'GET' | 'POST' = 'GET'): Promise<Answer<T>> {
    const controller = new AbortController()
    this.#controllers.add(controller)
    try {
      const got = await this.request(path, body, { method, signal: controller.signal })
      if (got && typeof got === 'object' && 'ok' in got && got.ok === false) {
        const failed = got as { said?: unknown; why?: unknown; note?: unknown; code?: unknown }
        const said = [failed.said, failed.why, failed.note].find((value): value is string => typeof value === 'string' && value !== '') ?? 'That did not go through. Try again.'
        return { ok: false, said, ...(typeof failed.code === 'string' && { code: failed.code }) }
      }
      return { ok: true, value: got as T }
    } catch (error) {
      return { ok: false, said: error instanceof Error && error.message ? error.message : 'Alexia could not be reached. Try again.' }
    } finally {
      this.#controllers.delete(controller)
    }
  }
}

const quiet = (label: string, press?: () => void): HTMLButtonElement => {
  const one = el('button', 'quiet-button', label)
  one.type = 'button'
  if (press) one.addEventListener('click', press)
  return one
}
const status = (className = 'hint'): HTMLElement => {
  const line = el('p', className)
  line.setAttribute('role', 'status')
  return line
}
const hostQuery = (host: HostChoice | undefined): string => host ? `?host=${encodeURIComponent(host.id)}` : ''

// ---- this computer's role ------------------------------------------------------------------

export interface RoleView {
  open(): void
  close(): void
  /** What `/api/state` already knows, so the block is right before its own read lands. */
  show(state: Pick<ComputeState, 'role' | 'switching'> | undefined): void
}

/**
 * The role switch. **A switch waits for running work** unless somebody says to cancel it:
 * the question names how many jobs there are before anything is sent, and afterwards the
 * line follows core's own phases until Alexia restarts in the new role.
 */
export function mountRole(root: HTMLElement, request: LocalRequest): RoleView {
  root.classList.add('compute-role', 'group')
  const life = new Life(request)
  let role: Role = 'interaction'
  let switching: RoleSwitch | undefined
  let picks: HTMLButtonElement[] = []
  let said: HTMLElement = status()
  let choice: HTMLElement = el('div')
  let changing = false
  interface RoleAnswer { role: Role; switching?: RoleSwitch; active?: number }

  const pending = (): boolean => switching !== undefined && switching.phase !== 'failed'
  const say = (message: string, error = false): void => { said.textContent = message; said.className = error ? 'error' : 'hint' }
  const progress = (now: RoleSwitch): string =>
    now.phase === 'waiting' ? `Waiting for ${now.active === undefined ? 'running work' : count(now.active, 'job', 'jobs').toLowerCase()} to finish before switching to ${ROLE_NAME[now.target]}. Existing chats are kept.`
    : now.phase === 'stopping' ? 'Stopping Alexia’s services and workers before the switch…'
    : now.phase === 'restarting' ? `Restarting in the ${ROLE_NAME[now.target]} role…`
    : now.message || 'The role switch did not go through. Try again.'
  const draw = (): void => {
    for (const pick of picks) {
      pick.setAttribute('aria-pressed', String(pick.dataset.role === role))
      pick.disabled = pending()
    }
  }
  const adopt = (state: RoleAnswer): void => {
    const was = switching
    role = state.role === 'compute' ? 'compute' : 'interaction'
    switching = state.switching
    draw()
    if (switching) {
      if (!changing) {
        choice.replaceChildren()
        if (switching.phase === 'waiting') {
          const stop = quiet('Stop waiting', () => void stopWaiting(stop))
          const target = switching.target
          const active = switching.active ?? 0
          const cancel = quiet('Cancel them and switch', () => start(target, true, cancel, active))
          cancel.classList.add('danger-button')
          choice.append(stop, cancel)
        }
      }
      say(progress(switching), switching.phase === 'failed')
      if (pending()) life.watch(1000, () => void watch())
    } else if (was && was.phase !== 'failed') {
      choice.replaceChildren()
      say(role === was.target ? `This computer is now in the ${ROLE_NAME[role]} role.` : '')
    }
  }
  async function watch(): Promise<void> {
    const live = life.mark()
    const got = await life.ask<RoleAnswer>('/api/compute/role')
    if (!live()) return
    if (got.ok) { adopt(got.value); return }
    // Core stops answering while it restarts, which is the switch working and not a failure.
    if (!pending()) { say(got.said, true); return }
    if (switching!.phase !== 'waiting') say(`Restarting in the ${ROLE_NAME[switching!.target]} role…`)
    life.watch(1000, () => void watch())
  }
  async function stopWaiting(control: HTMLButtonElement): Promise<void> {
    if (changing || switching?.phase !== 'waiting') return
    const live = life.mark()
    changing = true
    for (const one of choice.querySelectorAll('button')) one.disabled = true
    const got = await life.ask<{ note?: string }>('/api/compute/role/cancel', undefined, 'POST')
    if (!live()) return
    changing = false
    if (!got.ok) {
      for (const one of choice.querySelectorAll('button')) one.disabled = false
      say(got.said, true)
      control.focus()
      return
    }
    // Invalidate reads of the switch made before the stop was accepted.
    life.open()
    switching = undefined
    choice.replaceChildren()
    draw()
    say(got.value.note ?? 'The role switch was stopped. This computer keeps its role.')
    await watch()
  }
  const start = (target: Role, cancel: boolean, control: HTMLButtonElement, active: number): void => {
    if (changing) return
    const live = life.mark()
    changing = true
    for (const one of choice.querySelectorAll('button')) one.disabled = true
    void life.ask<{ note?: string }>('/api/compute/role', { role: target, confirm: true, ...(cancel && { cancel: true }) }, 'POST').then((got) => {
      if (!live()) return
      changing = false
      if (!got.ok) {
        for (const one of choice.querySelectorAll('button')) one.disabled = false
        say(got.said, true)
        control.focus()
        return
      }
      choice.replaceChildren()
      switching = { target, phase: 'waiting', message: '', active }
      draw()
      say(active > 0 && !cancel ? progress(switching) : 'Switching…')
      void watch()
    })
  }
  const propose = async (target: Role): Promise<void> => {
    if (!life.active || target === role || pending()) return
    const live = life.mark()
    say('Checking for running work…')
    const got = await life.ask<RoleAnswer>('/api/compute/role')
    if (!live()) return
    if (!got.ok) { say(got.said, true); return }
    if (got.value.switching && got.value.switching.phase !== 'failed') { adopt(got.value); return }
    role = got.value.role === 'compute' ? 'compute' : 'interaction'
    switching = undefined
    draw()
    say('')
    if (role === target) return
    const active = Math.max(0, Number(got.value.active) || 0)
    const box = el('div', 'confirm')
    const them = active === 1 ? 'it' : 'them'
    box.append(el('p', undefined, active > 0
      ? `${count(active, 'job is', 'jobs are')} still running or waiting. Switching to ${ROLE_NAME[target]} waits for ${them} to finish, unless you cancel ${them}. Existing chats are kept.`
      : `Switch this computer to ${ROLE_NAME[target]}? Alexia stops its services and workers, then restarts in the new role. Existing chats are kept.`))
    const row = el('div', 'row')
    if (active > 0) {
      const wait = quiet(`Wait for ${them}, then switch`, () => start(target, false, wait, active))
      const cancel = quiet(`Cancel ${them} and switch`, () => start(target, true, cancel, active))
      cancel.classList.add('danger-button')
      row.append(wait, cancel)
    } else {
      const go = quiet(`Switch to ${ROLE_NAME[target]}`, () => start(target, false, go, 0))
      row.append(go)
    }
    row.append(quiet(`Keep ${ROLE_NAME[role]}`, () => choice.replaceChildren()))
    box.append(row)
    choice.replaceChildren(box)
  }

  return {
    close: () => life.close(),
    show: (state) => { if (life.active && state && !pending()) adopt(state) },
    open: () => {
      life.open()
      changing = false
      const field = el('fieldset', 'local-format compute-role-choice')
      field.append(el('legend', undefined, 'This computer’s role'))
      picks = (['interaction', 'compute'] as const).map((value) => {
        const pick = quiet(ROLE_NAME[value], () => void propose(value))
        pick.dataset.role = value
        return pick
      })
      field.append(...picks)
      said = status()
      choice = el('div', 'compute-role-ask')
      root.replaceChildren(
        el('h2', 'step-heading', 'Role'),
        el('p', 'hint', 'Interaction is the computer you talk to: the chats, the agents and the permissions are here. Compute only runs models and other heavy work for the one computer it is paired with, and has no chat window. Existing chats are kept when you switch.'),
        field, said, choice,
      )
      draw()
      void watch()
    },
  }
}

// ---- Tailscale ------------------------------------------------------------------------------

export type TailscalePhase = 'not-installed' | 'installing' | 'stopped' | 'needs-login' | 'starting' | 'running' | 'unavailable'
export interface TailscaleState {
  phase: TailscalePhase
  said: string
  self?: { name: string; ips: string[] }
  peers: { name: string; os: string; ips: string[]; online: boolean }[]
  loginUrl?: string
  instructions?: string
}

/**
 * **Reaching the other computer from anywhere** (`/api/compute/tailscale`). One button at a time
 * — install, turn on, sign in — and what Tailscale says about the computers on it. At home the
 * two still connect directly; Tailscale is what carries the connection when they are apart.
 */
export function mountTailscale(root: HTMLElement, request: LocalRequest): { open(): void; close(): void } {
  root.classList.add('compute-tailscale', 'group')
  const life = new Life(request)
  let said: HTMLElement = status()
  let peers: HTMLElement = el('p', 'hint')
  let action: HTMLButtonElement = quiet('')
  let help: HTMLElement = el('p', 'hint')
  let state: TailscaleState | undefined
  const verbs: Record<TailscalePhase, [label: string, act: 'install' | 'start' | 'login' | 'read'] | undefined> = {
    'not-installed': ['Install Tailscale', 'install'],
    installing: ['Check again', 'read'],
    stopped: ['Turn on Tailscale', 'start'],
    'needs-login': ['Sign in to Tailscale', 'login'],
    starting: ['Check again', 'read'],
    running: ['Refresh', 'read'],
    unavailable: ['Turn on Tailscale', 'start'],
  }
  const draw = (): void => {
    if (!state) return
    said.textContent = state.said
    said.className = state.phase === 'unavailable' ? 'error' : 'hint'
    const others = state.peers.map((peer) => `${peer.name}${peer.online ? '' : ' (offline)'}`)
    peers.textContent = state.phase === 'running'
      ? (others.length > 0 ? `Your computers on Tailscale: ${others.join(', ')}.` : 'No other computer is on your Tailscale yet. Sign in on the other computer with the same account.')
      : ''
    peers.hidden = peers.textContent === ''
    const verb = state.instructions ? undefined : verbs[state.phase]
    action.hidden = verb === undefined
    if (verb) action.textContent = verb[0]
    help.textContent = state.instructions ?? (state.phase === 'needs-login'
      ? 'A page opens in your browser. Sign in with the same account on both computers — that is what puts them on one private network.'
      : state.phase === 'installing' ? 'Finish the installer that opened, then press Check again.' : '')
    help.hidden = help.textContent === ''
  }
  async function read(act: 'install' | 'start' | 'login' | 'read' = 'read'): Promise<void> {
    const live = life.mark()
    action.disabled = true
    const got = act === 'read'
      ? await life.ask<{ tailscale: TailscaleState }>('/api/compute/tailscale')
      : await life.ask<{ tailscale: TailscaleState }>('/api/compute/tailscale', { action: act, ...(act === 'install' && { confirm: true }) }, 'POST')
    if (!live()) return
    action.disabled = false
    if (!got.ok) {
      said.textContent = got.code === 'setup-required' ? 'Connecting over Tailscale is not available in this version.' : got.said
      said.className = 'error'
      return
    }
    // An older core, or one that does not offer it: nothing to show.
    if (!got.value?.tailscale) { root.hidden = true; return }
    root.hidden = false
    state = got.value.tailscale
    draw()
    // Until it is running, look again every few seconds: an installer or a sign-in finishes elsewhere.
    if (state.phase !== 'running') life.after(4000, () => void read())
  }
  return {
    close: () => life.close(),
    open: () => {
      life.open()
      said = status()
      peers = el('p', 'hint')
      help = el('p', 'hint')
      action = quiet('', () => {
        const verb = state && verbs[state.phase]
        if (!verb) return
        if (verb[1] === 'install' && !window.confirm('Download Tailscale from tailscale.com and open its installer? It is a separate free app; your computer will ask for permission to install it.')) return
        void read(verb[1])
      })
      action.hidden = true
      root.replaceChildren(
        el('h2', 'step-heading', 'Reach your other computer from anywhere'),
        el('p', 'hint', 'At home your two computers connect directly. When they are not on the same network, Alexia connects them through Tailscale, a free app. Set it up once on both computers, signed in with the same account.'),
        said, peers, action, help,
      )
      void read()
    },
  }
}

// ---- the connection services ---------------------------------------------------------------

export interface ServicesView { open(): void; close(): void }
interface ServicesAnswer { mailbox?: string; relay?: string; defaults: boolean }

/**
 * Where pairing and relaying go (`/api/compute/services`). Both computers need the same
 * mailbox to pair; the relay is only for computers that cannot reach each other directly.
 * Core keeps the addresses and the connection picks them up the next time Alexia starts.
 */
export function mountServices(root: HTMLElement, request: LocalRequest): ServicesView {
  root.classList.add('compute-services', 'group')
  const life = new Life(request)
  const field = (label: string, placeholder: string): HTMLInputElement => {
    const one = el('input')
    one.type = 'url'
    one.autocomplete = 'off'
    one.spellcheck = false
    one.placeholder = placeholder
    one.setAttribute('aria-label', label)
    return one
  }
  let mailbox = field('Pairing mailbox address', 'ws://192.168.1.20:4000/v1')
  let relay = field('Relay address', 'https://relay.example.org')
  let said: HTMLElement = status()
  let save: HTMLButtonElement = quiet('Save')
  const say = (message: string, error = false): void => { said.textContent = message; said.className = error ? 'error' : 'hint' }
  const adopt = (got: ServicesAnswer): void => {
    mailbox.value = got.mailbox ?? ''
    relay.value = got.relay ?? ''
  }
  async function read(): Promise<void> {
    const live = life.mark()
    const got = await life.ask<ServicesAnswer>('/api/compute/services')
    if (!live()) return
    if (got.ok) adopt(got.value)
    else say(got.said, true)
  }
  async function store(): Promise<void> {
    const live = life.mark()
    save.disabled = true
    const got = await life.ask<ServicesAnswer>('/api/compute/services', { mailbox: mailbox.value.trim(), relay: relay.value.trim() }, 'POST')
    if (!live()) return
    save.disabled = false
    if (!got.ok) { say(got.said, true); return }
    adopt(got.value)
    say('Saved. Quit and open Alexia again on this computer to use them.')
  }
  let reach = mountTailscale(el('div'), request)
  return {
    close: () => { reach.close(); life.close() },
    open: () => {
      life.open()
      mailbox = field('Pairing mailbox address', 'ws://192.168.1.20:4000/v1')
      relay = field('Relay address', 'https://relay.example.org')
      said = status()
      const form = el('form', 'local-search services-form')
      save = quiet('Save')
      save.type = 'submit'
      form.append(
        el('label', undefined, 'Pairing mailbox'), mailbox,
        el('label', undefined, 'Relay (optional)'), relay,
        save,
      )
      form.addEventListener('submit', (event) => { event.preventDefault(); if (!save.disabled) void store() })
      const tailscale = el('div')
      reach.close()
      reach = mountTailscale(tailscale, request)
      const advanced = el('details', 'group')
      advanced.append(
        el('summary', undefined, 'Your own servers (advanced)'),
        el('p', 'hint', 'Only if you run your own pairing mailbox or relay. Without them, the two computers find each other on this network or over Tailscale. Enter the same mailbox address on both computers.'),
        form, said,
      )
      root.replaceChildren(tailscale, advanced)
      reach.open()
      void read()
    },
  }
}

// ---- pairing -------------------------------------------------------------------------------

export interface PairingView { open(): void; close(): void }
interface PairingOptions {
  role: Role
  /** A pairing ended `paired`: the host list has one more row. */
  paired?(hostId: string | undefined): void
  /** Why a new pairing cannot start, when it cannot: a compute host that already has its controller. */
  blocked?(): string | undefined
}

/** A mailbox code (a number and four words) or a direct one (four words). */
const CODE_SHAPE = /^(?:\d+-)?[a-z]+(?:-[a-z]+){3}$/
interface FoundComputer { name: string; platform: string; endpointId: string; addresses: string[]; tailnet: boolean }
const clock = (ms: number): string => {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * One pairing, from either side. The compute host shows the code and a countdown; the
 * interaction computer types it. **A code that failed, expired or was cancelled is dead**:
 * the field is emptied and the sentence asks for a fresh one, so nothing here can send the
 * same code twice.
 */
export function mountPairing(root: HTMLElement, request: LocalRequest, options: PairingOptions): PairingView {
  root.classList.add('pairing')
  const life = new Life(request)
  const hosting = options.role === 'compute'
  let pairing: PairingStatus | undefined
  let reported = ''
  let code: HTMLElement = el('output')
  let countdown: HTMLElement = el('p')
  let said: HTMLElement = status()
  let begin: HTMLButtonElement = quiet('')
  let cancel: HTMLButtonElement = quiet('')
  let input: HTMLInputElement | undefined
  /** The computer chosen from those found waiting (pairing without a mailbox). */
  let chosen: FoundComputer | undefined
  let finding: HTMLElement = el('div')

  const phaseOf = (now: PairingStatus): PairingPhase =>
    now.phase === 'waiting' && now.expiresAt !== undefined && Date.now() >= now.expiresAt ? 'expired' : now.phase
  const sentence = (now: PairingStatus): [string, boolean] => {
    const peer = now.peerName || 'the other computer'
    switch (phaseOf(now)) {
      case 'waiting': return [hosting ? 'Type this code into Alexia on the computer you talk to.' : 'Waiting for the other computer…', false]
      case 'connecting': return [`Connecting to ${peer}…`, false]
      case 'verifying': return [`Checking that ${peer} is the computer that exchanged the code…`, false]
      case 'paired': return [`Paired with ${peer}.`, false]
      case 'expired': return ['That code expired. A code lasts five minutes; get a fresh one and try again.', true]
      case 'cancelled': return ['Pairing was cancelled. That code can no longer be used; a fresh one is needed to try again.', true]
      case 'failed': return ['Pairing did not go through. A code works for one attempt, so get a fresh one and try again.', true]
    }
  }
  const draw = (): void => {
    const phase = pairing ? phaseOf(pairing) : undefined
    const open = phase !== undefined && OPEN_PAIRING.includes(phase)
    const stopped = options.blocked?.()
    const shown = hosting && open && phase === 'waiting' && pairing?.code ? pairing.code : ''
    code.textContent = shown
    code.hidden = shown === ''
    countdown.textContent = open && phase === 'waiting' && pairing?.expiresAt !== undefined ? `Expires in ${clock(pairing.expiresAt - Date.now())}. It works once.` : ''
    countdown.hidden = countdown.textContent === ''
    cancel.hidden = !open
    begin.disabled = open || (stopped !== undefined && phase !== 'paired')
    begin.textContent = hosting ? (pairing && !open && phase !== 'paired' ? 'Show a new code' : 'Show a pairing code') : 'Pair'
    if (input) input.disabled = open
    if (pairing) {
      const [text, error] = sentence(pairing)
      said.textContent = text
      said.className = error ? 'error' : 'hint'
    } else if (stopped !== undefined) {
      said.textContent = stopped
      said.className = 'hint'
    }
  }
  const adopt = (now: PairingStatus | undefined): void => {
    pairing = now
    draw()
    if (!now) return
    const phase = phaseOf(now)
    if (OPEN_PAIRING.includes(phase)) { life.after(1000, () => void poll()); return }
    // Whatever was typed or shown is spent. The field is already empty; this is the belt.
    if (input) input.value = ''
    if (phase === 'paired' && reported !== (now.hostId ?? 'paired')) {
      reported = now.hostId ?? 'paired'
      options.paired?.(now.hostId)
    }
  }
  async function poll(): Promise<void> {
    const live = life.mark()
    const got = await life.ask<{ pairing?: PairingStatus }>('/api/compute/pair')
    if (!live()) return
    if (!got.ok) {
      // The countdown still runs, and the next read may land.
      draw()
      if (pairing && OPEN_PAIRING.includes(phaseOf(pairing))) life.after(1000, () => void poll())
      return
    }
    // A pairing core no longer knows of is over; the code it had is dead with it.
    adopt(got.value.pairing ?? (pairing && OPEN_PAIRING.includes(pairing.phase) ? { phase: 'cancelled' } : pairing))
  }
  const start = (typed?: string): void => {
    const live = life.mark()
    begin.disabled = true
    reported = ''
    said.textContent = hosting ? 'Getting a code…' : 'Sending the code…'
    said.className = 'hint'
    const body = typed === undefined ? {} : { code: typed, ...(chosen && { target: { endpointId: chosen.endpointId, addresses: chosen.addresses } }) }
    void life.ask<{ pairing?: PairingStatus }>('/api/compute/pair/start', body, 'POST').then((got) => {
      if (!live()) return
      if (!got.ok) {
        pairing = undefined
        draw()
        said.textContent = got.code === 'setup-required'
          ? 'Pairing is not available here: the part of Alexia that connects two computers is missing from this installation.'
          : hosting ? got.said : `${got.said} If the code was used, get a fresh one before trying again.`
        said.className = 'error'
        return
      }
      adopt(got.value.pairing ?? { phase: 'waiting' })
    })
  }

  /** The computers waiting to pair that this one can see, to choose one. */
  async function look(): Promise<void> {
    const live = life.mark()
    finding.replaceChildren(el('p', 'hint', 'Looking for your other computer…'))
    const got = await life.ask<{ found: FoundComputer[] }>('/api/compute/discover')
    if (!live()) return
    if (!got.ok) {
      // A mailbox is set up, or this version cannot look: the code alone is how to pair.
      finding.replaceChildren()
      return
    }
    const found = got.value.found
    if (found.length === 0) {
      chosen = undefined
      finding.replaceChildren(el('p', 'hint', 'No computer is waiting yet. Show a pairing code on the other computer, then press Look again. If it is not on this network, set up Tailscale on both computers first.'))
      return
    }
    if (!chosen || !found.some((one) => one.endpointId === chosen!.endpointId)) chosen = found[0]
    finding.replaceChildren(...found.map((one) => {
      const row = el('label', 'pair-found-row')
      const pick = el('input')
      pick.type = 'radio'
      pick.name = 'pair-target'
      pick.checked = one.endpointId === chosen?.endpointId
      pick.addEventListener('change', () => { if (pick.checked) chosen = one })
      row.append(pick, document.createTextNode(` ${one.name} — ${one.tailnet ? 'over Tailscale' : 'on this network'}`))
      return row
    }))
  }

  return {
    close: () => life.close(),
    open: () => {
      life.open()
      pairing = undefined
      chosen = undefined
      reported = ''
      code = el('output', 'pair-code')
      code.hidden = true
      code.setAttribute('aria-label', 'Pairing code')
      countdown = el('p', 'hint pair-countdown')
      said = status()
      cancel = quiet('Cancel pairing', () => {
        const live = life.mark()
        cancel.disabled = true
        void life.ask('/api/compute/pair/cancel', {}, 'POST').then((got) => {
          if (!live()) return
          cancel.disabled = false
          if (!got.ok) { said.textContent = got.said; said.className = 'error'; return }
          life.close()
          life.open()
          adopt({ phase: 'cancelled' })
        })
      })
      cancel.hidden = true
      const parts: HTMLElement[] = [el('h3', undefined, hosting ? 'Pair with the computer you talk to' : 'Pair another computer')]
      if (hosting) {
        input = undefined
        begin = quiet('Show a pairing code', () => start())
        parts.push(el('p', 'hint', 'Show a code here, then type it into Alexia on the computer you talk to. The code works for one attempt and expires after five minutes.'), begin)
      } else {
        const form = el('form', 'local-search pair-form')
        const typed = el('input')
        typed.type = 'text'
        typed.autocomplete = 'off'
        typed.spellcheck = false
        typed.placeholder = 'word-word-word-word'
        typed.setAttribute('aria-label', 'Pairing code')
        input = typed
        begin = quiet('Pair')
        begin.type = 'submit'
        form.append(typed, begin)
        form.addEventListener('submit', (event) => {
          event.preventDefault()
          if (begin.disabled) return
          const value = typed.value.trim().toLowerCase().replace(/\s+/g, '-')
          if (!CODE_SHAPE.test(value)) {
            said.textContent = 'A code is four words, like word-word-word-word (with a number first if you use your own mailbox). Read it from the other computer.'
            said.className = 'error'
            return
          }
          if (!chosen && !/^\d/.test(value)) {
            said.textContent = 'Choose the computer to pair with from the list first.'
            said.className = 'error'
            return
          }
          // Emptied before it is sent: a code is good for one attempt and is not kept on screen.
          typed.value = ''
          start(value)
        })
        finding = el('div', 'pair-found')
        finding.setAttribute('role', 'group')
        finding.setAttribute('aria-label', 'Computers waiting to pair')
        parts.push(
          el('p', 'hint', 'On the other computer, switch Alexia to the Compute role and press Show a pairing code. It appears below — on this network, or over Tailscale when it is somewhere else. Choose it, then type its code.'),
          finding, quiet('Look again', () => void look()), form,
        )
        void look()
      }
      parts.push(code, countdown, said, cancel)
      root.replaceChildren(...parts)
      draw()
      // A pairing opened before this page was (another window, or a reload) is picked up.
      void poll()
    },
  }
}

// ---- the host list -------------------------------------------------------------------------

export interface HostPickerView {
  open(): void
  close(): void
  refresh(): Promise<void>
  /** What `/api/state` already knows, so the list is right before its own read lands. */
  update(compute: Pick<ComputeState, 'hosts' | 'available'> | undefined): void
  /** The host whose models are on screen: `'this'` or a paired host's id. */
  selected(): string
  /** Whether core has said which host is chosen yet. Before that, nothing is assumed to be. */
  known(): boolean
}
interface HostPickerOptions {
  role?: Role
  /** Which host is on screen: once when core first says, then whenever it changes. Undefined is this computer. */
  chosen?(host: HostChoice | undefined): void
  /** The host on screen is the same one, and how it is reached or why it cannot serve changed. */
  changed?(): void
}

/** A paired host that the list no longer holds keeps a name, so its state can still be said. */
const FORGOTTEN = 'That computer'

/**
 * Where local models run: *This computer*, every paired computer, and *Pair another computer*.
 *
 * **A paired computer is not dropped from the list because it cannot serve.** Offline, busy, too old
 * or missing something, it stays where it was with its reason under it, and stays chosen if
 * it was chosen. In the compute role the same list is the one computer this one works for.
 */
export function mountHostPicker(root: HTMLElement, request: LocalRequest, options: HostPickerOptions = {}): HostPickerView {
  root.classList.add('host-picker', 'group')
  const life = new Life(request)
  const serving = options.role === 'compute'
  let hosts: HostView[] = []
  let selected = THIS_HOST
  let available = true
  let known = false
  let drawn = ''
  /** What was last announced. Empty until core has answered once. */
  let told = ''
  let list: HTMLElement = el('div')
  let said: HTMLElement = status()
  /** The standing fact about pairing here, when there is one. Never overwritten by a press's answer. */
  let rule: HTMLElement = status()
  let pairRoot: HTMLElement = el('div')
  let pairButton: HTMLButtonElement = quiet('')
  let pairing: PairingView | undefined

  const choice = (): HostChoice | undefined =>
    selected === THIS_HOST ? undefined : { id: selected, name: hosts.find((view) => view.host.id === selected)?.host.name ?? FORGOTTEN }
  const signature = (): string => {
    const view = hosts.find((one) => one.host.id === selected)
    return `${selected} ${view?.connection ?? ''} ${view?.failure?.code ?? ''}`
  }
  const tell = (): void => {
    if (!known) return
    const now = signature()
    if (now === told) return
    const moved = now.split(' ')[0] !== told.split(' ')[0]
    told = now
    if (moved) options.chosen?.(choice())
    else options.changed?.()
  }
  const say = (message: string, error = false): void => { said.textContent = message; said.className = error ? 'error' : 'hint' }
  const blocked = (): string | undefined =>
    serving && hosts[0] ? `This computer is paired with ${hosts[0].host.name}. Unpair it before pairing with another computer.` : undefined

  const select = (id: string, control: HTMLButtonElement): void => {
    if (id === selected) return
    const live = life.mark()
    control.disabled = true
    void life.ask('/api/compute/select', { host: id }, 'POST').then((got) => {
      if (!live()) return
      control.disabled = false
      if (!got.ok) { say(got.said, true); return }
      selected = id
      known = true
      say('')
      draw(true)
      tell()
    })
  }
  const row = (view: HostView): HTMLElement => {
    const { host } = view
    const one = el('article', 'host-row')
    one.dataset.host = host.id
    const head = el('div', 'host-head')
    if (serving) head.append(el('b', undefined, host.name))
    else {
      const pick = quiet(host.name, () => select(host.id, pick))
      pick.classList.add('host-pick')
      pick.setAttribute('aria-pressed', String(host.id === selected))
      head.append(pick)
    }
    one.classList.toggle('on', !serving && host.id === selected)
    const reach = el('span', `pill${view.connection === 'offline' ? ' danger' : view.connection === 'relayed' ? ' caution' : ''}`, connectionLabel(view.connection))
    reach.classList.add('host-connection')
    head.append(reach)
    one.append(head)
    const meta = [host.platform ?? '', host.appVersion ? `Alexia ${host.appVersion}` : '', view.connection === 'offline' && host.lastSeenAt ? `last reached ${new Date(host.lastSeenAt).toLocaleString()}` : ''].filter(Boolean)
    if (meta.length) one.append(el('p', 'hint', meta.join(' · ')))
    // Its own reason, under its own name. An offline host with no failure sent is still offline.
    const reason = view.failure ? failureSentence(view.failure, host.name) : view.connection === 'offline' ? stateSentence('offline', host.name) : undefined
    if (reason) one.append(el('p', 'error host-state', reason))
    const note = el('p', 'hint')
    const unpair = quiet('Unpair')
    unpair.classList.add('danger-button')
    arm(unpair, 'Unpair for good', () => {
      const live = life.mark()
      unpair.disabled = true
      void life.ask('/api/compute/unpair', { host: host.id, confirm: true }, 'POST').then(async (got) => {
        if (!live()) return
        unpair.disabled = false
        if (!got.ok) { note.textContent = got.said; note.className = 'error'; return }
        say(`${host.name} is unpaired.`)
        await refresh()
      })
    }, {
      onArm: () => {
        note.className = 'hint'
        note.textContent = serving
          ? `This forgets ${host.name}. Its jobs running here are cancelled and its connection is closed. Pairing again needs a fresh code.`
          : `This forgets ${host.name}. Jobs it is running for this computer are cancelled, and its models are no longer offered here. Pairing again needs a fresh code.`
      },
      onDisarm: () => { note.textContent = '' },
    })
    one.append(unpair, note)
    return one
  }
  function draw(force = false): void {
    const now = JSON.stringify([hosts, selected, available])
    // A list rebuilt under an armed Unpair would take the second press away from it.
    if (!force && (now === drawn || list.querySelector('.armed') !== null)) return
    drawn = now
    const rows: HTMLElement[] = []
    if (!serving) {
      const here = el('article', 'host-row')
      here.dataset.host = THIS_HOST
      here.classList.toggle('on', selected === THIS_HOST)
      const pick = quiet('This computer', () => select(THIS_HOST, pick))
      pick.classList.add('host-pick')
      pick.setAttribute('aria-pressed', String(selected === THIS_HOST))
      here.append(pick)
      rows.push(here)
    }
    rows.push(...hosts.map(row))
    // Chosen, and no longer paired: said as that, where it was, and nothing chosen in its place.
    if (!serving && selected !== THIS_HOST && !hosts.some((view) => view.host.id === selected)) {
      const gone = el('article', 'host-row on')
      gone.dataset.host = selected
      gone.append(el('b', undefined, FORGOTTEN), el('p', 'error host-state', stateSentence('unpaired', FORGOTTEN)!))
      rows.push(gone)
    }
    if (serving && hosts.length === 0) rows.push(el('p', 'hint', 'No computer is paired yet. Show a pairing code to pair with the computer you talk to.'))
    list.replaceChildren(...rows)
    pairButton.hidden = !available
    pairButton.disabled = blocked() !== undefined
    rule.textContent = blocked() ?? (available ? '' : 'Pairing with another computer is not available here: the part of Alexia that connects two computers is missing from this installation.')
    rule.hidden = rule.textContent === ''
  }
  const adopt = (got: { hosts?: HostView[]; selected?: string; available?: boolean }): void => {
    hosts = Array.isArray(got.hosts) ? got.hosts : []
    if (typeof got.selected === 'string' && got.selected !== '') selected = got.selected
    available = got.available === true
    known = true
    draw()
    tell()
    schedule()
  }
  // Only paired computers change on their own, so a list without one is read once.
  const schedule = (): void => { if (hosts.length > 0) life.watch(3000, () => void refresh()) }
  async function refresh(): Promise<void> {
    if (!life.active) return
    const live = life.mark()
    const got = await life.ask<{ hosts?: HostView[]; selected?: string; available?: boolean }>('/api/compute/hosts')
    if (!live()) return
    if (!got.ok) {
      say(`Paired computers could not be read: ${got.said}`, true)
      // What was chosen before still is. With nothing ever read, that is this computer.
      known = true
      tell()
      schedule()
      return
    }
    if (said.textContent?.startsWith('Paired computers could not be read')) say('')
    adopt(got.value)
  }
  const closePairing = (): void => {
    pairing?.close()
    pairing = undefined
    pairRoot.replaceChildren()
    pairButton.setAttribute('aria-expanded', 'false')
  }

  return {
    refresh,
    selected: () => selected,
    known: () => known,
    close: () => { pairing?.close(); pairing = undefined; life.close() },
    update: (compute) => {
      if (!compute) return
      hosts = Array.isArray(compute.hosts) ? compute.hosts : []
      available = compute.available === true
      if (life.active) { draw(); tell() }
    },
    open: () => {
      pairing?.close()
      pairing = undefined
      life.open()
      drawn = ''
      list = el('div', 'host-list')
      said = status()
      rule = status()
      rule.hidden = true
      pairRoot = el('div', 'host-pairing')
      pairButton = quiet(serving ? 'Pair this computer' : 'Pair another computer', () => {
        if (pairing) { closePairing(); return }
        say('')
        pairing = mountPairing(pairRoot, request, {
          role: serving ? 'compute' : 'interaction',
          blocked,
          paired: () => void refresh(),
        })
        pairButton.setAttribute('aria-expanded', 'true')
        pairing.open()
        pairRoot.append(quiet('Close pairing', closePairing))
      })
      pairButton.setAttribute('aria-expanded', 'false')
      root.replaceChildren(
        el('h2', 'step-heading', serving ? 'Paired computer' : 'Where local models run'),
        el('p', 'hint', serving
          ? 'This computer runs models and other heavy work for one computer. To work for a different one, unpair the current one first.'
          : 'Choose the computer whose models are listed below. A paired computer that cannot be used right now stays in this list with the reason, and nothing else is chosen in its place.'),
        list, pairButton, rule, said, pairRoot,
      )
      draw(true)
      void refresh()
    },
  }
}

// ---- a host's queue ------------------------------------------------------------------------

export interface QueueView {
  open(host?: HostChoice): void
  close(): void
  refresh(): Promise<void>
  /** A job this screen started or cancelled, so its outcome can be said after it leaves the queue. */
  track(job: JobSnapshot): void
  /** The latest the queue or recent history said about one job. */
  find(id: string): JobSnapshot | undefined
}

/**
 * The queue of one computer: what is running, then what waits, first in first out, each with
 * *Cancel*. With no host it is this computer's own queue (the compute role's page).
 */
export function mountQueue(root: HTMLElement, request: LocalRequest): QueueView {
  root.classList.add('host-queue')
  const life = new Life(request)
  let host: HostChoice | undefined
  let queue: QueueSnapshot | undefined
  let drawn = ''
  let body: HTMLElement = el('div')
  let said: HTMLElement = status()
  const settled = new Map<string, JobSnapshot>()
  const name = (): string => host?.name ?? 'This computer'

  const cancelButton = (job: JobSnapshot): HTMLButtonElement => {
    const cancel = quiet('Cancel', () => {
      const live = life.mark()
      cancel.disabled = true
      void life.ask<{ job?: JobSnapshot }>('/api/compute/jobs/cancel', { host: host?.id ?? THIS_HOST, job: job.id }, 'POST').then(async (got) => {
        if (!live()) return
        if (!got.ok) { cancel.disabled = false; said.textContent = got.said; said.className = 'error'; return }
        said.textContent = ''
        if (got.value.job) track(got.value.job)
        await refresh()
      })
    })
    cancel.setAttribute('aria-label', `Cancel ${job.label}`)
    return cancel
  }
  const draw = (): void => {
    const now = JSON.stringify([queue, [...settled.values()]])
    if (now === drawn) return
    drawn = now
    const parts: HTMLElement[] = []
    if (queue?.paused) parts.push(el('p', 'hint', `${name()} is paused by whoever is at it. Jobs wait in the queue until it is resumed.`))
    if (queue?.running) {
      const job = queue.running
      const row = el('section', 'local-job')
      row.dataset.job = job.id
      row.append(el('b', undefined, job.label), el('p', 'hint', [jobSentence(job, name()), job.progress?.message ?? ''].filter(Boolean).join(' · ')))
      const total = job.progress?.total
      if (job.progress && total !== undefined && total > 0) {
        const bar = el('progress', 'local-progress')
        bar.setAttribute('aria-label', `Progress of ${job.label}`)
        bar.max = total
        bar.value = Math.max(0, Math.min(job.progress.progress, total))
        row.append(bar)
      }
      if (job.state !== 'cancelling') row.append(cancelButton(job))
      parts.push(row)
    }
    if (queue?.waiting.length) {
      const waiting = el('ol', 'host-waiting')
      for (const job of queue.waiting) {
        const item = el('li')
        item.dataset.job = job.id
        item.append(el('span', undefined, job.label), el('span', 'hint', jobSentence(job, name())), cancelButton(job))
        waiting.append(item)
      }
      parts.push(waiting)
    }
    if (queue && !queue.running && queue.waiting.length === 0) parts.push(el('p', 'hint', 'Nothing is running or waiting.'))
    for (const job of settled.values()) {
      if (!finishedJob(job) || queue?.running?.id === job.id || queue?.waiting.some((waiting) => waiting.id === job.id)) continue
      const line = el('p', job.state === 'failed' || job.state === 'interrupted' ? 'error host-state' : 'hint', `${job.label}: ${jobSentence(job, name())}`)
      line.dataset.job = job.id
      parts.push(line)
    }
    body.replaceChildren(...parts)
  }
  const track = (job: JobSnapshot): void => { settled.set(job.id, job); draw() }
  const find = (id: string): JobSnapshot | undefined => queue?.running?.id === id ? queue.running : queue?.waiting.find((job) => job.id === id) ?? settled.get(id)
  // Quick while there is something to watch, slow while there is not.
  const schedule = (): void => life.watch(queue?.running || queue?.waiting.length ? 2000 : 5000, () => void refresh())
  async function refresh(): Promise<void> {
    if (!life.active) return
    const live = life.mark()
    const [got, recent] = await Promise.all([
      life.ask<{ queue?: QueueSnapshot }>(`/api/compute/queue${hostQuery(host)}`),
      life.ask<{ jobs: JobSnapshot[] }>(`/api/compute/jobs${hostQuery(host)}`),
    ])
    if (!live()) return
    if (!got.ok) {
      // Its own sentence for its own state; the queue last read is not shown as if it were current.
      queue = undefined
      drawn = ''
      body.replaceChildren()
      const sentence = got.code !== undefined ? stateSentence(got.code, name()) : undefined
      said.textContent = sentence ? `The queue cannot be read: ${sentence}` : got.said
      said.className = 'error'
    } else {
      if (got.value.queue && Array.isArray(got.value.queue.waiting)) queue = got.value.queue
      if (recent.ok) {
        const tracked = new Map(settled)
        settled.clear()
        for (const job of recent.value.jobs) settled.set(job.id, job)
        for (const [id, job] of tracked) if (!settled.has(id)) settled.set(id, job)
      }
      for (const [id, job] of settled) settled.set(id, find(id) ?? job)
      said.textContent = recent.ok ? '' : `Recent jobs could not be read: ${(recent.code !== undefined ? stateSentence(recent.code, name()) : undefined) ?? recent.said}`
      said.className = recent.ok ? 'hint' : 'error'
      draw()
    }
    schedule()
  }

  return {
    refresh, track, find,
    close: () => life.close(),
    open: (which) => {
      life.open()
      if (which?.id !== host?.id) settled.clear()
      host = which
      queue = undefined
      drawn = ''
      body = el('div', 'local-jobs')
      said = status()
      root.replaceChildren(el('h3', undefined, `Queue on ${host ? host.name : 'this computer'}`), el('p', 'hint', 'One heavy job runs at a time. The rest wait in the order they arrived.'), said, body)
      void refresh()
    },
  }
}

// ---- one paired host: how it is reached, what it can run, what it needs --------------------

export interface HostDetailView { open(host: HostChoice): void; close(): void; refresh(): Promise<void> }

/**
 * The chosen paired computer, under the list: `Direct`, `Relayed` or `Offline`, its state's
 * sentence, what it says it can run, what it is missing, and its queue.
 *
 * **Only what the host reports is shown.** A capability is listed because its inventory lists
 * it, and a missing piece is installed only by its own button, which carries the download's
 * size before it is pressed.
 */
export function mountHost(root: HTMLElement, request: LocalRequest, options: { changed?(): void; own?: boolean; queue?: boolean } = {}): HostDetailView {
  root.classList.add('host-detail', 'group')
  const life = new Life(request)
  let host: HostChoice | undefined
  let drawn = ''
  let body: HTMLElement = el('div')
  let said: HTMLElement = status()
  let queue: QueueView | undefined
  /** Installs this screen started, by requirement id. */
  const installing = new Map<string, JobSnapshot>()
  const installErrors = new Map<string, string>()
  interface Read { inventory?: HostInventory; connection?: ConnectionState; failure?: ComputeFailure }
  let read: Read | undefined

  const draw = (): void => {
    if (!host || !read) return
    const now = JSON.stringify([read, [...installing], [...installErrors]])
    if (now === drawn) return
    drawn = now
    const name = host.name
    const connection: ConnectionState = read.connection ?? 'offline'
    const parts: HTMLElement[] = []
    const head = el('div', 'host-head')
    const reach = el('span', `pill host-connection${connection === 'offline' ? ' danger' : connection === 'relayed' ? ' caution' : ''}`, connectionLabel(connection))
    head.append(el('h2', 'step-heading', name))
    if (!options.own) head.append(reach)
    parts.push(head)
    const reason = read.failure ? failureSentence(read.failure, name) : !options.own && connection === 'offline' ? stateSentence('offline', name) : undefined
    if (reason) {
      parts.push(el('p', 'error host-state', reason))
      if (!options.own) parts.push(el('p', 'hint', 'Nothing else is chosen in its place. Pick another computer above if you want one.'))
    }
    const inventory = read.inventory
    if (inventory) {
      if (inventory.setup.length) {
        const setup = el('section', 'local-installed host-setup')
        setup.append(el('h3', undefined, `Missing on ${name}`), el('p', 'hint', `Nothing is downloaded until you press its button. Downloads go onto ${name}.`))
        for (const need of inventory.setup) {
          const item = el('article', 'local-installed-row')
          item.dataset.requirement = need.id
          const waits = need.blocks.length ? `Needed for ${need.blocks.join(', ')}` : ''
          item.append(el('b', undefined, need.title), el('p', 'hint', [need.detail ?? '', waits].filter(Boolean).join(' · ')))
          const job = installing.get(need.id)
          if (job) item.append(installStatus(need.id, job))
          if ((!job || finishedJob(job) && job.state !== 'succeeded') && need.action === 'install') {
            const size = need.bytes !== undefined && Number.isFinite(need.bytes) ? modelBytes(need.bytes) : 'size not reported'
            const install = quiet(`Install on ${name} · ${size}`, () => {
              const live = life.mark()
              install.disabled = true
              void life.ask<{ job: JobSnapshot }>('/api/compute/setup/install', { ...(!options.own && { host: host!.id }), requirement: need.id }, 'POST').then(async (got) => {
                if (!live()) return
                if (!got.ok) {
                  install.disabled = false
                  said.textContent = (got.code !== undefined ? stateSentence(got.code, name) : undefined) ?? got.said
                  said.className = 'error'
                  return
                }
                said.textContent = ''
                installing.set(need.id, got.value.job)
                installErrors.delete(need.id)
                draw()
                await Promise.all([refresh(), queue?.refresh()])
              })
            })
            install.dataset.install = need.id
            item.append(install)
          } else if (!job && need.action === 'instructions') {
            item.append(el('p', 'hint', need.instructions ?? `This has to be done at ${name} itself.`))
          }
          setup.append(item)
        }
        parts.push(setup)
      }
      const can = el('section', 'local-installed host-capabilities')
      can.append(el('h3', undefined, `What ${name} can run`))
      if (inventory.capabilities.length === 0) can.append(el('p', 'hint', `${name} reports nothing beyond its chat models.`))
      for (const capability of inventory.capabilities) {
        const line = el('p', 'hint host-capability')
        line.dataset.cap = capability.cap
        line.append(el('b', undefined, capability.summary || capability.cap), ` · ${capability.ready ? 'Ready' : 'Needs setup'}`)
        can.append(line)
      }
      parts.push(can)
    }
    for (const [id, job] of installing) {
      if (inventory?.setup.some((need) => need.id === id)) continue
      const item = el('section', 'local-job')
      item.dataset.requirement = id
      item.append(el('b', undefined, job.label), installStatus(id, job))
      parts.push(item)
    }
    body.replaceChildren(...parts)
  }
  const installStatus = (id: string, job: JobSnapshot): HTMLElement => {
    const item = el('div')
    const ended = finishedJob(job)
    const sentence = jobSentence(job, host!.name)
    item.append(el('p', job.state === 'failed' || job.state === 'interrupted' ? 'error host-state' : 'hint',
      [ended ? sentence : `Installing on ${host!.name}… ${sentence}`, job.failure?.message !== sentence ? job.failure?.message : '', job.progress?.message ?? ''].filter(Boolean).join(' · ')))
    if (!ended && job.progress) {
      const bar = el('progress', 'local-progress')
      bar.setAttribute('aria-label', `Progress of ${job.label}`)
      if (job.progress.total !== undefined && job.progress.total > 0) {
        bar.max = job.progress.total
        bar.value = Math.max(0, Math.min(job.progress.progress, job.progress.total))
      }
      item.append(bar)
    }
    if (installErrors.has(id)) item.append(el('p', 'error', installErrors.get(id)!))
    return item
  }
  const schedule = (): void => life.watch([...installing.values()].some((job) => !finishedJob(job)) ? 2000 : 5000, () => void refresh())
  async function refresh(): Promise<void> {
    if (!life.active || !host) return
    const live = life.mark()
    const query = hostQuery(options.own ? undefined : host)
    const [got, updates] = await Promise.all([
      life.ask<Read>(`/api/compute/inventory${query}`),
      Promise.all([...installing].filter(([, job]) => !finishedJob(job)).map(async ([id, job]) => ({
        id, answer: await life.ask<{ job: JobSnapshot }>(`/api/compute/job${query}${query ? '&' : '?'}job=${encodeURIComponent(job.id)}`),
      }))),
    ])
    if (!live()) return
    for (const { id, answer } of updates) {
      if (answer.ok) {
        installing.set(id, answer.value.job)
        installErrors.delete(id)
        if (finishedJob(answer.value.job)) options.changed?.()
      } else installErrors.set(id, `Install progress could not be read: ${(answer.code !== undefined ? stateSentence(answer.code, host.name) : undefined) ?? answer.said}`)
    }
    const was = `${read?.connection ?? ''} ${read?.failure?.code ?? ''} ${String(read?.inventory?.revision ?? '')}`
    if (got.ok) {
      read = got.value
      said.textContent = ''
    } else if (got.code !== undefined && stateSentence(got.code, host.name) !== undefined) {
      read = { connection: got.code === 'offline' ? 'offline' : read?.connection ?? 'offline', failure: { code: got.code as ComputeErrorCode, message: got.said } }
      said.textContent = ''
    } else {
      said.textContent = got.said
      said.className = 'error'
    }
    draw()
    if (read && was !== `${read.connection ?? ''} ${read.failure?.code ?? ''} ${String(read.inventory?.revision ?? '')}` && was.trim() !== '') options.changed?.()
    schedule()
  }

  return {
    refresh,
    close: () => { queue?.close(); life.close() },
    open: (which) => {
      queue?.close()
      life.open()
      if (which.id !== host?.id) { installing.clear(); installErrors.clear() }
      host = which
      read = undefined
      drawn = ''
      body = el('div', 'host-body')
      said = status()
      const queueRoot = el('section')
      queue = options.queue === false ? undefined : mountQueue(queueRoot, request)
      root.replaceChildren(body, said, ...(queue ? [queueRoot] : []))
      queue?.open(options.own ? undefined : which)
      void refresh()
    },
  }
}
