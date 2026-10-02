// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  SHOWN_STATES, connectionLabel, jobSentence, mountHost, mountHostPicker, mountPairing, mountQueue, mountRole, mountServices, parseCatalogId, qualify, stateSentence,
  type ComputeFailure, type HostInventory, type HostView, type JobSnapshot, type PairingStatus, type QueueSnapshot, type RoleSwitch,
} from '../src/compute.js'
import { computeRequest, mountComputeSetup } from '../src/compute-setup.js'
import { mountSettings } from '../src/settings.js'
import { mountLocalModels, type Job } from '../src/local-models.js'

/**
 * The screen for remote compute, against `fetch` answering as `remote-compute.md` §6 says core
 * will. Every request goes through the same token-carrying helper Settings uses, so what is
 * pinned here is the route, the method and the body, and what a person is shown for each answer.
 */

const GB = 1024 ** 3
const STUDIO = 'studio0001'
const TOWER = 'tower00002'
const CODE = '7-crossover-clockwork-guitarist-tonic'

const flush = async (): Promise<void> => { for (let i = 0; i < 40; i += 1) await Promise.resolve() }
const view = (id: string, name: string, changes: Partial<HostView> = {}): HostView => ({
  host: { id, name, endpointId: `endpoint-${id}`, peerRole: 'compute', pairedAt: 1, platform: 'darwin', appVersion: '2.4.0' },
  connection: 'direct', ...changes,
})
const failed = (code: ComputeFailure['code']): ComputeFailure => ({ code, message: `core said ${code}` })
const job = (id: string, changes: Partial<JobSnapshot> = {}): JobSnapshot => ({ id, kind: 'operation', weight: 'heavy', state: 'queued', label: `Image ${id}`, createdAt: 1, ...changes })
const inventory = (changes: Partial<HostInventory> = {}): HostInventory => ({
  name: 'Studio', appVersion: '2.4.0', models: [], capabilities: [], setup: [], revision: 1,
  machine: { platform: 'darwin', arch: 'arm64', chip: 'M2', appleSilicon: true, ramBytes: 16 * GB, freeDiskBytes: 50 * GB, budgetBytes: 12 * GB },
  ...changes,
})
const overview = (summary: string, changes: Record<string, unknown> = {}): Record<string, unknown> => ({
  machine: { summary, ramBytes: 64 * GB, freeDiskBytes: 500 * GB, budgetBytes: 48 * GB, appleSilicon: false },
  runtime: { installed: true, version: '1', supported: true },
  picks: {
    best: {
      entry: 'qwen', name: 'Qwen', blurb: 'A chat model.', publisher: 'Qwen', params: 32, quant: 'Q4_K_M', bytes: 20 * GB, needBytes: 24 * GB, verdict: 'fits',
      tools: true, vision: false, licence: { name: 'Apache 2.0', url: 'https://example.org/licence', restrictive: false }, installed: false, abliterated: false,
      quants: [{ quant: 'Q4_K_M', bytes: 20 * GB, needBytes: 24 * GB, verdict: 'fits' }],
    },
  },
  all: [], uncensored: [], jobs: [], mode: 'local',
  installed: [{ id: 'llama/qwen:Q4_K_M', name: 'Qwen Q4_K_M', quant: 'Q4_K_M', bytes: 20 * GB, vetted: true, abliterated: false, tools: true, vision: false, context: 8192, pinned: false }],
  ...changes,
})

interface Call { method: string; path: string; query: Record<string, string>; body?: Record<string, unknown> }
interface Core {
  hosts: HostView[]
  selected: string
  available: boolean
  pairing?: PairingStatus
  role: { role: 'interaction' | 'compute'; switching?: RoleSwitch; active: number }
  queues: Record<string, QueueSnapshot>
  jobs: Record<string, JobSnapshot[]>
  inventories: Record<string, { inventory?: HostInventory; connection: string; failure?: ComputeFailure }>
  overviews: Record<string, Record<string, unknown>>
  /** A host whose every `/api/local-models` operation is refused with this code. */
  refused: Record<string, ComputeFailure['code']>
  calls: Call[]
  routes: Record<string, (call: Call) => { status?: number; body: unknown }>
}

function core(partial: Partial<Core> = {}): Core {
  const state: Core = {
    hosts: [], selected: 'this', available: true, role: { role: 'interaction', active: 0 },
    queues: {}, jobs: {}, inventories: {}, overviews: { this: overview('Apple M2 · 16 GB RAM') }, refused: {}, calls: [], routes: {}, ...partial,
  }
  const answer = (call: Call): { status?: number; body: unknown } => {
    const custom = state.routes[`${call.method} ${call.path}`]
    if (custom) return custom(call)
    const host = String(call.query.host ?? call.body?.host ?? 'this')
    switch (`${call.method} ${call.path}`) {
      case 'GET /api/compute/hosts': return { body: { hosts: state.hosts, selected: state.selected, available: state.available } }
      case 'POST /api/compute/select': state.selected = host; return { body: { ok: true } }
      case 'GET /api/compute/pair': return { body: state.pairing ? { pairing: state.pairing } : {} }
      case 'POST /api/compute/pair/start':
        state.pairing = call.body?.code === undefined ? { phase: 'waiting', code: CODE, expiresAt: Date.now() + 5 * 60_000 } : { phase: 'connecting' }
        return { body: { ok: true, pairing: state.pairing } }
      case 'POST /api/compute/pair/cancel': state.pairing = { phase: 'cancelled' }; return { body: { ok: true } }
      case 'POST /api/compute/unpair':
        state.hosts = state.hosts.filter((one) => one.host.id !== host)
        if (state.selected === host) state.selected = 'this'
        return { body: { ok: true } }
      case 'GET /api/compute/inventory': return { body: state.inventories[host] ?? { connection: 'offline' } }
      case 'GET /api/compute/queue': return { body: { queue: state.queues[host] ?? { waiting: [], paused: false } } }
      case 'GET /api/compute/jobs': return { body: { jobs: state.jobs[host] ?? [] } }
      case 'GET /api/compute/job': {
        const found = state.jobs[host]?.find((one) => one.id === call.query.job)
        return found ? { body: { job: found } } : { status: 404, body: { ok: false, code: 'not-found', said: 'That job is no longer available.' } }
      }
      case 'POST /api/compute/jobs/cancel': {
        const queue = state.queues[host]!
        const gone = queue.waiting.find((one) => one.id === call.body?.job)!
        queue.waiting = queue.waiting.filter((one) => one !== gone)
        return { body: { ok: true, job: { ...gone, state: 'cancelled' } } }
      }
      case 'POST /api/compute/setup/install': {
        const started = job('setup-1', { kind: 'setup', weight: 'light', state: 'running', label: 'Runtime' })
        state.jobs[host] = [started]
        return { body: { ok: true, job: started } }
      }
      case 'GET /api/compute/role': return { body: state.role }
      case 'POST /api/compute/role':
        // Core's switcher is waiting from the moment it accepts, which is what the next read says.
        state.role = { ...state.role, switching: { target: call.body?.role === 'compute' ? 'compute' : 'interaction', phase: 'waiting', message: '', active: state.role.active } }
        return { body: { ok: true, note: 'Switching.' } }
      case 'POST /api/compute/role/cancel':
        delete state.role.switching
        return { body: { ok: true, note: 'The role switch was stopped. This computer keeps its role.' } }
      case 'GET /api/state': {
        const pairing = state.pairing && { ...state.pairing }
        delete pairing?.code
        return { body: { setup: { mode: 'local' }, compute: { role: state.role.role, available: state.available, hosts: state.hosts, ...(pairing && { pairing }) } } }
      }
      case 'GET /api/panels': return { body: { tabs: [] } }
      case 'GET /api/plugins': return { body: { panes: [], problems: [] } }
      case 'GET /api/library': return { body: { ok: true, registry: 'x', plugins: [], skills: [] } }
    }
    if (call.path.startsWith('/api/local-models')) {
      const code = state.refused[host]
      if (code && call.path !== '/api/local-models/use') return { status: code === 'unpaired' ? 404 : code === 'offline' || code === 'busy' ? 503 : code === 'worker-failure' ? 502 : 409, body: { ok: false, said: `core said ${code}`, code } }
      if (call.path === '/api/local-models') return { body: state.overviews[host] }
      if (call.path === '/api/local-models/install' || call.path === '/api/local-models/progress') {
        return { body: { id: 'download-1', target: 'qwen:Q4_K_M', name: 'Qwen Q4_K_M', step: 'download', done: GB, total: 20 * GB, message: 'Downloading', startedAt: Date.now() } }
      }
      return { body: { ok: true, said: 'Chosen.' } }
    }
    return { body: { ok: true } }
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const at = new URL(url, 'http://alexia.test')
    const call: Call = { method: init?.method ?? 'GET', path: at.pathname, query: Object.fromEntries(at.searchParams), ...(init?.body !== undefined && { body: JSON.parse(init.body) as Record<string, unknown> }) }
    state.calls.push(call)
    const { status = 200, body } = answer(call)
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }
  }))
  return state
}

const sent = (state: Core, method: string, path: string): Call[] => state.calls.filter((call) => call.method === method && call.path === path)
const root = (): HTMLElement => {
  const element = document.createElement('section')
  document.body.append(element)
  return element
}
const button = (within: ParentNode, label: string): HTMLButtonElement => {
  const found = [...within.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent === label)
  expect(found, `Missing button: ${label}`).toBeDefined()
  return found!
}
const closers: (() => void)[] = []
const request = computeRequest('token')

beforeEach(() => { vi.useFakeTimers(); document.body.replaceChildren(); delete document.body.dataset.view })
afterEach(() => { for (const close of closers.splice(0)) close(); vi.useRealTimers(); vi.unstubAllGlobals() })

// ---- the vocabulary ------------------------------------------------------------------------

test('each of the seven shown states has its own plain sentence about the computer it happened on', () => {
  expect([...SHOWN_STATES]).toEqual(['offline', 'busy', 'incompatible-version', 'setup-required', 'worker-failure', 'interrupted', 'unpaired'])
  const sentences = SHOWN_STATES.map((code) => stateSentence(code, 'Studio')!)
  expect(new Set(sentences).size).toBe(7)
  for (const sentence of sentences) expect(sentence).toContain('Studio')
  // A code that is not one of the seven has no sentence here, so core's own line is shown.
  expect(stateSentence('refused', 'Studio')).toBeUndefined()
  expect(jobSentence(job('a', { state: 'interrupted' }), 'Studio')).toBe(stateSentence('interrupted', 'Studio'))
  expect(jobSentence(job('a', { state: 'failed', failure: failed('worker-failure') }), 'Studio')).toBe(stateSentence('worker-failure', 'Studio'))
  expect(jobSentence(job('a', { state: 'failed', failure: { code: 'refused', message: 'The host refused it.' } }), 'Studio')).toBe('The host refused it.')
})

test('a catalog id carries its host, and the three connection words are the only ones', () => {
  expect(qualify(STUDIO, 'llama/qwen:Q4_K_M')).toBe(`@${STUDIO}/llama/qwen:Q4_K_M`)
  expect(qualify('this', 'llama/qwen:Q4_K_M')).toBe('llama/qwen:Q4_K_M')
  expect(parseCatalogId(`@${STUDIO}/llama/qwen:Q4_K_M`)).toEqual({ hostId: STUDIO, modelId: 'llama/qwen:Q4_K_M' })
  expect(parseCatalogId('llama/qwen:Q4_K_M')).toEqual({ hostId: 'this', modelId: 'llama/qwen:Q4_K_M' })
  expect((['direct', 'relayed', 'offline'] as const).map(connectionLabel)).toEqual(['Direct', 'Relayed', 'Offline'])
})

// ---- the connection services ---------------------------------------------------------------

test('connection services: the saved mailbox is shown, a new one is saved, and a bad one is refused in core\'s words', async () => {
  let saved: Record<string, string> = { mailbox: 'ws://old.example:4000/v1' }
  const state = core({ routes: {
    'GET /api/compute/services': () => ({ body: { ...saved, defaults: false } }),
    'POST /api/compute/services': (call) => {
      if (call.body?.mailbox === 'not a url') return { status: 400, body: { ok: false, said: 'Supply a valid mailbox address.' } }
      saved = Object.fromEntries(Object.entries(call.body ?? {}).filter(([, value]) => value !== '')) as Record<string, string>
      return { body: { ...saved, defaults: false } }
    },
  } })
  const element = root()
  const mounted = mountServices(element, request)
  closers.push(mounted.close)
  mounted.open()
  await flush()
  const [mailbox, relay] = [...element.querySelectorAll<HTMLInputElement>('input')]
  const form = element.querySelector<HTMLFormElement>('form')!
  expect(mailbox!.value).toBe('ws://old.example:4000/v1')
  expect(relay!.value).toBe('')
  mailbox!.value = ' ws://192.168.1.20:4000/v1 '
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
  expect(sent(state, 'POST', '/api/compute/services')[0]!.body).toEqual({ mailbox: 'ws://192.168.1.20:4000/v1', relay: '' })
  expect(element.textContent).toContain('Quit and open Alexia again')
  mailbox!.value = 'not a url'
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
  expect(element.querySelector('.error')!.textContent).toBe('Supply a valid mailbox address.')
})

// ---- pairing -------------------------------------------------------------------------------

function pairing(role: 'interaction' | 'compute', state: Core, blocked?: () => string | undefined) {
  const element = root()
  const paired = vi.fn()
  const mounted = mountPairing(element, request, { role, paired, ...(blocked && { blocked }) })
  closers.push(mounted.close)
  mounted.open()
  return { element, paired, state }
}

test('pairing start: the compute host shows the code with its expiry, and says it works once and needs the mailbox', async () => {
  const state = core()
  const { element } = pairing('compute', state)
  await flush()
  expect(element.querySelector<HTMLElement>('.pair-code')!.hidden).toBe(true)
  expect(element.textContent).toContain('pairing mailbox service')
  expect(element.textContent).toContain('a number and four words')
  button(element, 'Show a pairing code').click()
  await flush()
  expect(sent(state, 'POST', '/api/compute/pair/start')[0]!.body).toEqual({})
  const code = element.querySelector<HTMLElement>('.pair-code')!
  expect(code.hidden).toBe(false)
  expect(code.textContent).toBe(CODE)
  expect(element.querySelector('.pair-countdown')!.textContent).toBe('Expires in 5:00. It works once.')
  // The countdown follows the clock, read once a second while the pairing is open.
  await vi.advanceTimersByTimeAsync(61_000)
  expect(element.querySelector('.pair-countdown')!.textContent).toBe('Expires in 3:59. It works once.')
  expect(sent(state, 'GET', '/api/compute/pair').length).toBeGreaterThan(30)
  expect(button(element, 'Show a pairing code').disabled).toBe(true)
})

test('pairing enter: the typed code is sent once, cleared from the field, and followed to paired', async () => {
  const state = core()
  const { element, paired } = pairing('interaction', state)
  await flush()
  const input = element.querySelector<HTMLInputElement>('input')!
  const form = element.querySelector<HTMLFormElement>('form')!
  input.value = 'not a code'
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
  expect(sent(state, 'POST', '/api/compute/pair/start')).toHaveLength(0)
  expect(element.querySelector('.error')!.textContent).toContain('a number and four words')
  input.value = `  ${CODE.toUpperCase()} `
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  expect(input.value).toBe('')
  await flush()
  expect(sent(state, 'POST', '/api/compute/pair/start').map((call) => call.body)).toEqual([{ code: CODE }])
  expect(element.textContent).toContain('Connecting to the other computer…')
  // The interaction side never shows a code: it has none to show.
  expect(element.querySelector<HTMLElement>('.pair-code')!.hidden).toBe(true)
  state.pairing = { phase: 'verifying', peerName: 'Studio' }
  await vi.advanceTimersByTimeAsync(1000)
  expect(element.textContent).toContain('Checking that Studio is the computer that exchanged the code…')
  state.pairing = { phase: 'paired', peerName: 'Studio', hostId: STUDIO }
  await vi.advanceTimersByTimeAsync(1000)
  expect(element.textContent).toContain('Paired with Studio.')
  expect(paired).toHaveBeenCalledExactlyOnceWith(STUDIO)
  const reads = sent(state, 'GET', '/api/compute/pair').length
  await vi.advanceTimersByTimeAsync(5000)
  expect(sent(state, 'GET', '/api/compute/pair')).toHaveLength(reads)
})

test('pairing cancel: either side can cancel, and the code it had is dead', async () => {
  const state = core()
  const { element } = pairing('compute', state)
  await flush()
  button(element, 'Show a pairing code').click()
  await flush()
  button(element, 'Cancel pairing').click()
  await flush()
  expect(sent(state, 'POST', '/api/compute/pair/cancel')).toHaveLength(1)
  expect(element.querySelector<HTMLElement>('.pair-code')!.hidden).toBe(true)
  expect(element.querySelector('.pair-code')!.textContent).toBe('')
  expect(element.querySelector('.error')!.textContent).toContain('a fresh one is needed')
  expect(button(element, 'Cancel pairing').hidden).toBe(true)
  // Asking again is a new request for a new code, never the old one shown again.
  const again = button(element, 'Show a new code')
  expect(again.disabled).toBe(false)
  const reads = sent(state, 'GET', '/api/compute/pair').length
  await vi.advanceTimersByTimeAsync(5000)
  expect(sent(state, 'GET', '/api/compute/pair')).toHaveLength(reads)
})

test('pairing expired: after five minutes the code is gone from the screen and a fresh one is asked for', async () => {
  const state = core()
  const { element } = pairing('compute', state)
  await flush()
  button(element, 'Show a pairing code').click()
  await flush()
  // The clock runs out here before core has said so: the code stops being shown at once.
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(element.querySelector<HTMLElement>('.pair-code')!.hidden).toBe(true)
  expect(element.querySelector('.error')!.textContent).toBe('That code expired. A code lasts five minutes; get a fresh one and try again.')
  state.pairing = { phase: 'expired' }
  await vi.advanceTimersByTimeAsync(1000)
  expect(element.querySelector('.error')!.textContent).toContain('That code expired')
  expect(button(element, 'Show a new code').disabled).toBe(false)
})

test('pairing failed: one attempt per code, so the field is empty and nothing is sent again without a fresh one', async () => {
  const state = core()
  const { element, paired } = pairing('interaction', state)
  await flush()
  const input = element.querySelector<HTMLInputElement>('input')!
  const form = element.querySelector<HTMLFormElement>('form')!
  input.value = CODE
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
  state.pairing = { phase: 'failed', message: 'pairing_wrong_code' }
  await vi.advanceTimersByTimeAsync(1000)
  expect(element.querySelector('.error')!.textContent).toBe('Pairing did not go through. A code works for one attempt, so get a fresh one and try again.')
  expect(input.value).toBe('')
  expect(input.disabled).toBe(false)
  expect(paired).not.toHaveBeenCalled()
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
  expect(sent(state, 'POST', '/api/compute/pair/start')).toHaveLength(1)
  // A refusal before any attempt (no sidecar) says why instead of asking for another code.
  state.routes['POST /api/compute/pair/start'] = () => ({ status: 409, body: { ok: false, said: 'no sidecar', code: 'setup-required' } })
  input.value = CODE
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
  expect(element.querySelector('.error')!.textContent).toContain('Pairing is not available here')
})

// ---- the host list -------------------------------------------------------------------------

function picker(state: Core, role?: 'compute') {
  const element = root()
  const chosen = vi.fn()
  const changed = vi.fn()
  const mounted = mountHostPicker(element, request, { chosen, changed, ...(role && { role }) })
  closers.push(mounted.close)
  mounted.open()
  return { element, chosen, changed, mounted }
}
const rowOf = (element: HTMLElement, host: string): HTMLElement => element.querySelector<HTMLElement>(`.host-row[data-host="${host}"]`)!

test('the list is This computer, every paired computer with Direct, Relayed or Offline, and Pair another computer', async () => {
  const state = core({ hosts: [view(STUDIO, 'Studio'), view(TOWER, 'Tower', { connection: 'relayed' }), view('laptop0003', 'Laptop', { connection: 'offline' })] })
  const { element } = picker(state)
  await flush()
  expect([...element.querySelectorAll<HTMLElement>('.host-row')].map((row) => row.dataset.host)).toEqual(['this', STUDIO, TOWER, 'laptop0003'])
  expect(button(element, 'This computer').getAttribute('aria-pressed')).toBe('true')
  expect([...element.querySelectorAll('.host-connection')].map((pill) => pill.textContent)).toEqual(['Direct', 'Relayed', 'Offline'])
  // Offline is not removed: it stays where it was, with its reason under its name.
  expect(rowOf(element, 'laptop0003').querySelector('.host-state')!.textContent).toBe(stateSentence('offline', 'Laptop'))
  expect(rowOf(element, STUDIO).querySelector('.host-state')).toBeNull()
  button(element, 'Pair another computer').click()
  await flush()
  expect(element.querySelector('.host-pairing')!.textContent).toContain('pairing mailbox service')
  expect(element.querySelector('.host-pairing input')).not.toBeNull()
})

test('each state is shown on its own host as its own sentence, and choosing nothing else is offered', async () => {
  const codes = ['offline', 'busy', 'incompatible-version', 'setup-required', 'worker-failure', 'interrupted', 'unpaired'] as const
  const state = core({ hosts: codes.map((code, at) => view(`host${String(at).padStart(6, '0')}`, `Host ${String(at)}`, { connection: code === 'offline' ? 'offline' : 'direct', failure: failed(code) })) })
  const { element, chosen } = picker(state)
  await flush()
  const shown = [...element.querySelectorAll('.host-state')].map((line) => line.textContent)
  expect(shown).toEqual(codes.map((code, at) => stateSentence(code, `Host ${String(at)}`)))
  expect(new Set(shown).size).toBe(7)
  // Core's own wording for the code is not what is shown, and no host was chosen for anybody.
  expect(element.textContent).not.toContain('core said')
  expect(chosen).toHaveBeenCalledExactlyOnceWith(undefined)
  expect(sent(state, 'POST', '/api/compute/select')).toHaveLength(0)
})

test('a chosen computer that goes offline stays chosen and listed: nothing is selected in its place', async () => {
  const state = core({ hosts: [view(STUDIO, 'Studio'), view(TOWER, 'Tower')], selected: STUDIO })
  const { element, chosen, changed, mounted } = picker(state)
  await flush()
  expect(chosen).toHaveBeenCalledExactlyOnceWith({ id: STUDIO, name: 'Studio' })
  state.hosts = [view(STUDIO, 'Studio', { connection: 'offline', failure: failed('offline') }), view(TOWER, 'Tower')]
  await vi.advanceTimersByTimeAsync(3000)
  expect(mounted.selected()).toBe(STUDIO)
  expect(rowOf(element, STUDIO).classList.contains('on')).toBe(true)
  expect(rowOf(element, STUDIO).querySelector('.host-connection')!.textContent).toBe('Offline')
  expect(rowOf(element, STUDIO).querySelector('.host-state')!.textContent).toBe(stateSentence('offline', 'Studio'))
  expect(chosen).toHaveBeenCalledOnce()
  expect(changed).toHaveBeenCalledOnce()
  expect(sent(state, 'POST', '/api/compute/select')).toHaveLength(0)
  // Unpaired from the other side while chosen: said as that, still not replaced.
  state.hosts = [view(TOWER, 'Tower')]
  await vi.advanceTimersByTimeAsync(3000)
  expect(mounted.selected()).toBe(STUDIO)
  expect(rowOf(element, STUDIO).textContent).toContain('no longer accepts this computer')
  expect(button(element, 'This computer').getAttribute('aria-pressed')).toBe('false')
})

test('unpair takes two presses, sends the confirmation, and the computer leaves the list', async () => {
  const state = core({ hosts: [view(STUDIO, 'Studio')], selected: STUDIO })
  const { element, chosen, mounted } = picker(state)
  await flush()
  const unpair = button(rowOf(element, STUDIO), 'Unpair')
  unpair.click()
  expect(unpair.textContent).toBe('Unpair for good')
  expect(rowOf(element, STUDIO).textContent).toContain('Jobs it is running for this computer are cancelled')
  expect(sent(state, 'POST', '/api/compute/unpair')).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1100)
  unpair.click()
  await flush()
  expect(sent(state, 'POST', '/api/compute/unpair').map((call) => call.body)).toEqual([{ host: STUDIO, confirm: true }])
  expect(rowOf(element, STUDIO)).toBeNull()
  expect(element.textContent).toContain('Studio is unpaired.')
  expect(mounted.selected()).toBe('this')
  expect(button(element, 'This computer').getAttribute('aria-pressed')).toBe('true')
  expect(chosen).toHaveBeenLastCalledWith(undefined)
  expect(sent(state, 'POST', '/api/compute/select')).toHaveLength(0)
})

test('a compute host with a controller cannot start another pairing until that one is unpaired', async () => {
  const state = core({ hosts: [view(STUDIO, 'MacBook', { host: { ...view(STUDIO, 'MacBook').host, peerRole: 'interaction' } })], role: { role: 'compute', active: 0 } })
  const { element } = picker(state, 'compute')
  await flush()
  // No *This computer* row here: the list is the one computer this one works for.
  expect([...element.querySelectorAll<HTMLElement>('.host-row')].map((row) => row.dataset.host)).toEqual([STUDIO])
  const pair = button(element, 'Pair this computer')
  expect(pair.disabled).toBe(true)
  expect(element.textContent).toContain('This computer is paired with MacBook. Unpair it before pairing with another computer.')
  pair.click()
  await flush()
  expect(sent(state, 'POST', '/api/compute/pair/start')).toHaveLength(0)
  const unpair = button(rowOf(element, STUDIO), 'Unpair')
  unpair.click()
  expect(rowOf(element, STUDIO).textContent).toContain('Its jobs running here are cancelled and its connection is closed')
  await vi.advanceTimersByTimeAsync(1100)
  unpair.click()
  await flush()
  expect(button(element, 'Pair this computer').disabled).toBe(false)
  button(element, 'Pair this computer').click()
  await flush()
  button(element, 'Show a pairing code').click()
  await flush()
  expect(element.querySelector('.pair-code')!.textContent).toBe(CODE)
})

test('with no connection component the list is This computer alone, and says why pairing is absent', async () => {
  const state = core({ available: false })
  const { element } = picker(state)
  await flush()
  expect([...element.querySelectorAll<HTMLElement>('.host-row')].map((row) => row.dataset.host)).toEqual(['this'])
  expect(button(element, 'Pair another computer').hidden).toBe(true)
  expect(element.textContent).toContain('Pairing with another computer is not available here')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(sent(state, 'GET', '/api/compute/hosts')).toHaveLength(1)
})

// ---- one host: setup, capabilities, queue --------------------------------------------------

test('a host shows only the capabilities it reports, and setup sizes are on the button before anything installs', async () => {
  const state = core({
    inventories: {
      [STUDIO]: {
        connection: 'relayed',
        inventory: inventory({
          capabilities: [{ cap: 'image.generate', summary: 'Image generation', weight: 'heavy', ready: false }, { cap: 'speech.transcribe', summary: 'Transcription', weight: 'heavy', ready: true }],
          setup: [
            { id: 'runtime-llama', kind: 'runtime', title: 'Model runner', detail: 'llama.cpp for this hardware', bytes: 1.5 * GB, action: 'install', blocks: ['chat'] },
            { id: 'weights', kind: 'model', title: 'Image model', action: 'install', blocks: ['image.generate'] },
            { id: 'comfyui', kind: 'dependency', title: 'ComfyUI', action: 'instructions', instructions: 'Install ComfyUI on Studio, then check again.', blocks: ['image.generate'] },
          ],
        }),
      },
    },
  })
  const element = root()
  const mounted = mountHost(element, request)
  closers.push(mounted.close)
  mounted.open({ id: STUDIO, name: 'Studio' })
  await flush()
  expect(sent(state, 'GET', '/api/compute/inventory')[0]!.query).toEqual({ host: STUDIO })
  expect(element.querySelector('.host-connection')!.textContent).toBe('Relayed')
  expect([...element.querySelectorAll<HTMLElement>('.host-capability')].map((line) => line.textContent)).toEqual(['Image generation · Needs setup', 'Transcription · Ready'])
  expect([...element.querySelectorAll<HTMLButtonElement>('button[data-install]')].map((one) => one.textContent)).toEqual(['Install on Studio · 1.5 GB', 'Install on Studio · size not reported'])
  // A thing only a person can do at the host is words, never a button.
  const manual = element.querySelector<HTMLElement>('[data-requirement="comfyui"]')!
  expect(manual.querySelector('button')).toBeNull()
  expect(manual.textContent).toContain('Install ComfyUI on Studio, then check again.')
  expect(sent(state, 'POST', '/api/compute/setup/install')).toHaveLength(0)
  button(element, 'Install on Studio · 1.5 GB').click()
  await flush()
  expect(sent(state, 'POST', '/api/compute/setup/install').map((call) => call.body)).toEqual([{ host: STUDIO, requirement: 'runtime-llama' }])
  expect(element.querySelector('[data-requirement="runtime-llama"]')!.textContent).toContain('Installing on Studio…')
  expect(element.querySelector('[data-requirement="runtime-llama"] button')).toBeNull()
  // Inventory can change before a light setup job ends; its job is still followed.
  state.inventories[STUDIO]!.inventory = inventory({ revision: 2 })
  await vi.advanceTimersByTimeAsync(2000)
  expect(element.querySelector('[data-requirement="runtime-llama"]')!.textContent).toContain('Installing on Studio…')
  expect(element.textContent).toContain('Studio reports nothing beyond its chat models.')
})

test('a host that cannot serve shows its state and offers nothing from anywhere else', async () => {
  const state = core({ inventories: { [STUDIO]: { connection: 'direct', failure: failed('incompatible-version') } } })
  const element = root()
  const mounted = mountHost(element, request)
  closers.push(mounted.close)
  mounted.open({ id: STUDIO, name: 'Studio' })
  await flush()
  expect(element.querySelector('.host-state')!.textContent).toBe(stateSentence('incompatible-version', 'Studio'))
  expect(element.textContent).toContain('Nothing else is chosen in its place.')
  expect(element.querySelector('.host-capabilities')).toBeNull()
  // The route itself refusing is the same state, said the same way.
  state.routes['GET /api/compute/inventory'] = () => ({ status: 404, body: { ok: false, said: 'gone', code: 'unpaired' } })
  await vi.advanceTimersByTimeAsync(5000)
  expect(element.querySelector('.host-state')!.textContent).toBe(stateSentence('unpaired', 'Studio'))
})

test('a light setup install follows its job through progress and failure even after inventory stops listing it', async () => {
  const need = { id: 'runner', kind: 'runtime' as const, title: 'Runner', bytes: GB, action: 'install' as const, blocks: ['chat'] }
  const state = core({ inventories: { [STUDIO]: { connection: 'direct', inventory: inventory({ setup: [need] }) } } })
  const element = root()
  const mounted = mountHost(element, request)
  closers.push(mounted.close)
  mounted.open({ id: STUDIO, name: 'Studio' })
  await flush()
  button(element, 'Install on Studio · 1 GB').click()
  await flush()
  expect(sent(state, 'GET', '/api/compute/job').at(-1)!.query).toEqual({ host: STUDIO, job: 'setup-1' })
  expect(state.queues[STUDIO]).toBeUndefined()
  state.jobs[STUDIO] = [job('setup-1', { kind: 'setup', weight: 'light', state: 'running', progress: { progress: 3, total: 8, message: 'Fetching runner' } })]
  state.inventories[STUDIO]!.inventory = inventory({ revision: 2 })
  await vi.advanceTimersByTimeAsync(2000)
  const row = (): HTMLElement => element.querySelector<HTMLElement>('[data-requirement="runner"]')!
  expect(row().textContent).toContain('Fetching runner')
  expect(row().querySelector('progress')!.value).toBe(3)
  expect(row().querySelector('progress')!.max).toBe(8)
  state.jobs[STUDIO] = [job('setup-1', { kind: 'setup', weight: 'light', state: 'failed', failure: { code: 'worker-failure', message: 'The runner download failed.' } })]
  await vi.advanceTimersByTimeAsync(2000)
  expect(row().textContent).toContain('The runner download failed.')
  expect(row().textContent).toContain(stateSentence('worker-failure', 'Studio'))
  expect(row().querySelector('progress')).toBeNull()
  const reads = sent(state, 'GET', '/api/compute/job').length
  await vi.advanceTimersByTimeAsync(10_000)
  expect(sent(state, 'GET', '/api/compute/job')).toHaveLength(reads)
  expect(sent(state, 'POST', '/api/compute/setup/install')).toHaveLength(1)
})

test('a succeeded setup job finishes while its requirement is still in the last inventory', async () => {
  const state = core({ inventories: { [STUDIO]: { connection: 'direct', inventory: inventory({ setup: [{ id: 'runner', kind: 'runtime', title: 'Runner', bytes: GB, action: 'install', blocks: ['chat'] }] }) } } })
  const element = root()
  const mounted = mountHost(element, request)
  closers.push(mounted.close)
  mounted.open({ id: STUDIO, name: 'Studio' })
  await flush()
  button(element, 'Install on Studio · 1 GB').click()
  await flush()
  state.jobs[STUDIO] = [job('setup-1', { kind: 'setup', weight: 'light', state: 'succeeded' })]
  await vi.advanceTimersByTimeAsync(2000)
  expect(element.querySelector('[data-requirement="runner"]')!.textContent).toContain('Finished.')
  expect(element.querySelector('[data-requirement="runner"]')!.textContent).not.toContain('Installing')
})

test('the queue reads finished, failed and interrupted jobs from history without starting them again', async () => {
  const state = core({ jobs: { [STUDIO]: [
    job('lost', { state: 'interrupted' }), job('bad', { state: 'failed', failure: failed('worker-failure') }), job('done', { state: 'succeeded' }),
  ] } })
  const element = root()
  const mounted = mountQueue(element, request)
  closers.push(mounted.close)
  mounted.open({ id: STUDIO, name: 'Studio' })
  await flush()
  expect(sent(state, 'GET', '/api/compute/jobs')[0]!.query).toEqual({ host: STUDIO })
  expect(element.querySelector('[data-job="lost"]')!.textContent).toContain(stateSentence('interrupted', 'Studio'))
  expect(element.querySelector('[data-job="bad"]')!.textContent).toContain(stateSentence('worker-failure', 'Studio'))
  expect(element.querySelector('[data-job="done"]')!.textContent).toContain('Finished.')
  expect(element.querySelectorAll('[data-job] button')).toHaveLength(0)
  state.jobs[STUDIO]!.unshift(job('later', { state: 'interrupted' }))
  await vi.advanceTimersByTimeAsync(5000)
  expect(element.querySelector('[data-job="later"]')!.textContent).toContain('interrupted')
  expect([...element.querySelectorAll<HTMLElement>('[data-job]')].map((one) => one.dataset.job)).toEqual(['later', 'lost', 'bad', 'done'])
  expect(state.calls.every((call) => call.method === 'GET')).toBe(true)
})

test('the queue is first in first out, and cancelling a queued job removes it and says so', async () => {
  const state = core({
    queues: {
      [STUDIO]: {
        running: job('one', { state: 'running', label: 'Image one', progress: { progress: 4, total: 20, message: 'Step 4 of 20' } }),
        waiting: [job('two', { label: 'Image two' }), job('three', { label: 'Image three' })],
        paused: false,
      },
    },
  })
  const element = root()
  const mounted = mountQueue(element, request)
  closers.push(mounted.close)
  mounted.open({ id: STUDIO, name: 'Studio' })
  await flush()
  expect(sent(state, 'GET', '/api/compute/queue')[0]!.query).toEqual({ host: STUDIO })
  expect(element.querySelector('h3')!.textContent).toBe('Queue on Studio')
  expect(element.querySelector('.local-job')!.textContent).toContain('Image one')
  expect(element.querySelector('.local-job')!.textContent).toContain('Running · Step 4 of 20')
  expect(element.querySelector<HTMLProgressElement>('progress')!.value).toBe(4)
  expect([...element.querySelectorAll<HTMLElement>('.host-waiting li')].map((item) => item.dataset.job)).toEqual(['two', 'three'])
  element.querySelector<HTMLButtonElement>('.host-waiting li[data-job="two"] button')!.click()
  await flush()
  expect(sent(state, 'POST', '/api/compute/jobs/cancel').map((call) => call.body)).toEqual([{ host: STUDIO, job: 'two' }])
  expect([...element.querySelectorAll<HTMLElement>('.host-waiting li')].map((item) => item.dataset.job)).toEqual(['three'])
  expect(element.querySelector('p[data-job="two"]')!.textContent).toBe('Image two: Cancelled.')
  // The running job was left alone, and the queue keeps being read while something is in it.
  expect(element.querySelector('.local-job')!.textContent).toContain('Image one')
  const reads = sent(state, 'GET', '/api/compute/queue').length
  await vi.advanceTimersByTimeAsync(2000)
  expect(sent(state, 'GET', '/api/compute/queue').length).toBe(reads + 1)
  // A job the host lost is said as interrupted, and nothing submits it again.
  mounted.track(job('four', { label: 'Image four', state: 'interrupted' }))
  expect(element.querySelector('p[data-job="four"]')!.textContent).toBe(`Image four: ${stateSentence('interrupted', 'Studio')!}`)
  mounted.close()
  const after = state.calls.length
  await vi.advanceTimersByTimeAsync(10_000)
  expect(state.calls).toHaveLength(after)
})

// ---- the role ------------------------------------------------------------------------------

function role() {
  const element = root()
  const mounted = mountRole(element, request)
  closers.push(mounted.close)
  mounted.open()
  return { element, mounted }
}

test('a waiting role switch can be stopped, and the next role read carries no switching', async () => {
  const state = core({ role: { role: 'interaction', active: 2, switching: { target: 'compute', phase: 'waiting', message: '', active: 2 } } })
  const { element } = role()
  await flush()
  expect(button(element, 'Cancel them and switch').disabled).toBe(false)
  button(element, 'Stop waiting').click()
  await flush()
  expect(sent(state, 'POST', '/api/compute/role/cancel').map((call) => call.body)).toEqual([undefined])
  expect(state.role.switching).toBeUndefined()
  expect(state.calls.at(-1)!.path).toBe('/api/compute/role')
  expect(state.calls.at(-1)!.method).toBe('GET')
  expect(element.textContent).toContain('This computer keeps its role.')
  expect(element.textContent).not.toContain('Stop waiting')
  expect(button(element, 'Interaction').disabled).toBe(false)
  expect(button(element, 'Interaction').getAttribute('aria-pressed')).toBe('true')
  const reads = sent(state, 'GET', '/api/compute/role').length
  await vi.advanceTimersByTimeAsync(5000)
  expect(sent(state, 'GET', '/api/compute/role')).toHaveLength(reads)
})

test('a waiting role switch can cancel the work and continue the same switch', async () => {
  const state = core({ role: { role: 'compute', active: 1, switching: { target: 'interaction', phase: 'waiting', message: '', active: 1 } } })
  state.routes['POST /api/compute/role'] = () => {
    state.role.switching = { target: 'interaction', phase: 'stopping', message: '' }
    return { body: { ok: true, note: 'Cancelling work.' } }
  }
  const { element } = role()
  await flush()
  button(element, 'Cancel them and switch').click()
  await flush()
  expect(sent(state, 'POST', '/api/compute/role').map((call) => call.body)).toEqual([{ role: 'interaction', cancel: true, confirm: true }])
  expect(element.textContent).toContain('Stopping Alexia’s services')
  expect(element.textContent).not.toContain('Stop waiting')
  expect(element.textContent).not.toContain('Cancel them and switch')
  expect(button(element, 'Compute').getAttribute('aria-pressed')).toBe('true')
})

test('a stop refused after stopping begins is shown without claiming the role was kept', async () => {
  const state = core({ role: { role: 'interaction', active: 1, switching: { target: 'compute', phase: 'waiting', message: '', active: 1 } } })
  state.routes['POST /api/compute/role/cancel'] = () => {
    state.role.switching = { target: 'compute', phase: 'stopping', message: '' }
    return { status: 409, body: { ok: false, note: 'No role switch is waiting.' } }
  }
  const { element } = role()
  await flush()
  button(element, 'Stop waiting').click()
  await flush()
  expect(element.querySelector('.error')!.textContent).toBe('No role switch is waiting.')
  expect(element.textContent).not.toContain('This computer keeps its role.')
  await vi.advanceTimersByTimeAsync(1000)
  expect(element.textContent).not.toContain('Stop waiting')
})

test('role switch waits for active jobs: nothing is sent until the person chooses to wait or to cancel them', async () => {
  const state = core({ role: { role: 'interaction', active: 2 } })
  const { element } = role()
  await flush()
  expect(button(element, 'Interaction').getAttribute('aria-pressed')).toBe('true')
  expect(element.textContent).toContain('Existing chats are kept when you switch.')
  button(element, 'Compute').click()
  await flush()
  expect(element.querySelector('.confirm')!.textContent).toContain('2 jobs are still running or waiting. Switching to Compute waits for them to finish, unless you cancel them. Existing chats are kept.')
  expect(sent(state, 'POST', '/api/compute/role')).toHaveLength(0)
  button(element, 'Wait for them, then switch').click()
  await flush()
  // No `cancel`: core waits for the jobs, and the screen follows it.
  expect(sent(state, 'POST', '/api/compute/role').map((call) => call.body)).toEqual([{ role: 'compute', confirm: true }])
  expect(element.querySelector('.confirm')).toBeNull()
  expect(button(element, 'Compute').disabled).toBe(true)
  state.role = { role: 'interaction', active: 2, switching: { target: 'compute', phase: 'waiting', message: '', active: 2 } }
  await vi.advanceTimersByTimeAsync(1000)
  expect(element.textContent).toContain('Waiting for 2 jobs to finish before switching to Compute. Existing chats are kept.')
  state.role = { role: 'interaction', active: 1, switching: { target: 'compute', phase: 'waiting', message: '', active: 1 } }
  await vi.advanceTimersByTimeAsync(1000)
  expect(element.textContent).toContain('Waiting for one job to finish')
  expect(button(element, 'Interaction').getAttribute('aria-pressed')).toBe('true')
  state.role = { role: 'interaction', active: 0, switching: { target: 'compute', phase: 'stopping', message: '' } }
  await vi.advanceTimersByTimeAsync(1000)
  expect(element.textContent).toContain('Stopping Alexia’s services and workers before the switch…')
  // Core goes away while it restarts; that is the switch, not an error.
  state.routes['GET /api/compute/role'] = () => ({ status: 503, body: { ok: false, said: 'down' } })
  await vi.advanceTimersByTimeAsync(1000)
  expect(element.textContent).toContain('Restarting in the Compute role…')
  expect(element.querySelector('.error')).toBeNull()
  delete state.routes['GET /api/compute/role']
  state.role = { role: 'compute', active: 0 }
  await vi.advanceTimersByTimeAsync(1000)
  expect(button(element, 'Compute').getAttribute('aria-pressed')).toBe('true')
  expect(element.textContent).toContain('This computer is now in the Compute role.')
  const reads = sent(state, 'GET', '/api/compute/role').length
  await vi.advanceTimersByTimeAsync(5000)
  expect(sent(state, 'GET', '/api/compute/role')).toHaveLength(reads)
})

test('role switch: cancelling the jobs is its own explicit button, and keeping the role sends nothing', async () => {
  const state = core({ role: { role: 'interaction', active: 1 } })
  const { element } = role()
  await flush()
  button(element, 'Compute').click()
  await flush()
  expect(element.querySelector('.confirm')!.textContent).toContain('One job is still running or waiting.')
  button(element, 'Keep Interaction').click()
  expect(element.querySelector('.confirm')).toBeNull()
  expect(sent(state, 'POST', '/api/compute/role')).toHaveLength(0)
  button(element, 'Compute').click()
  await flush()
  button(element, 'Cancel it and switch').click()
  await flush()
  expect(sent(state, 'POST', '/api/compute/role').map((call) => call.body)).toEqual([{ role: 'compute', confirm: true, cancel: true }])
})

test('role switch with nothing running still asks once, and a refusal is shown with the role unchanged', async () => {
  const state = core({ role: { role: 'compute', active: 0 } })
  state.routes['POST /api/compute/role'] = () => ({ status: 409, body: { ok: false, said: 'A switch is already under way.', code: 'refused' } })
  const { element } = role()
  await flush()
  button(element, 'Interaction').click()
  await flush()
  expect(element.querySelector('.confirm')!.textContent).toContain('Switch this computer to Interaction?')
  button(element, 'Switch to Interaction').click()
  await flush()
  expect(element.querySelector('.error')!.textContent).toBe('A switch is already under way.')
  expect(button(element, 'Compute').getAttribute('aria-pressed')).toBe('true')
})

// ---- Settings: the picker above the picked computer's models -------------------------------

const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8')
const body = html.slice(html.indexOf('<body'), html.indexOf('</body>')).replace(/<script[^>]*><\/script>/g, '')

function settings() {
  document.body.innerHTML = body
  document.body.dataset.view = 'settings'
  const mounted = mountSettings('token')
  closers.push(mounted.close)
  mounted.open('models')
  const page = document.querySelector<HTMLElement>('#models-page')!
  return { mounted, page, local: (): HTMLElement => page.querySelector<HTMLElement>('.local-models')! }
}

test('selecting a host shows its models and its hardware fit, and a download targets that host', async () => {
  const state = core({ hosts: [view(STUDIO, 'Studio')], overviews: { this: overview('Apple M2 · 16 GB RAM'), [STUDIO]: overview('RTX 4090 · 64 GB RAM') }, inventories: { [STUDIO]: { connection: 'direct', inventory: inventory() } } })
  const { page, local } = settings()
  await flush()
  expect(local().textContent).toContain('Apple M2 · 16 GB RAM')
  expect(local().textContent).toContain('Fits this machine')
  // This computer's own view keeps its file import and its token field.
  expect(local().textContent).toContain('Import an existing GGUF')
  button(page, 'Studio').click()
  await flush()
  expect(sent(state, 'POST', '/api/compute/select').map((call) => call.body)).toEqual([{ host: STUDIO }])
  expect(sent(state, 'GET', '/api/local-models').at(-1)!.query).toEqual({ host: STUDIO })
  expect(local().querySelector('h2')!.textContent).toBe('Models on Studio')
  // The machine and the verdict are the host's own answer, not this computer's.
  expect(local().textContent).toContain('RTX 4090 · 64 GB RAM')
  expect(local().textContent).not.toContain('Apple M2')
  expect(local().textContent).toContain('Fits Studio · needs 24 GB memory')
  expect(local().textContent).toContain('Downloads go onto Studio, not this computer.')
  expect(local().textContent).toContain('Installed on Studio')
  expect(local().textContent).not.toContain('Import an existing GGUF')
  expect(local().textContent).not.toContain('Hugging Face token')
  expect(page.querySelector('.host-detail .host-connection')!.textContent).toBe('Direct')

  button(local(), 'Install').click()
  await flush()
  expect(sent(state, 'POST', '/api/local-models/install').map((call) => call.body)).toEqual([{ entry: 'qwen', quant: 'Q4_K_M', host: STUDIO }])
  expect(local().querySelector('progress')!.getAttribute('aria-label')).toBe('Installing Qwen Q4_K_M')
  await vi.advanceTimersByTimeAsync(1000)
  expect(sent(state, 'GET', '/api/local-models/progress').at(-1)!.query).toEqual({ job: 'download-1', host: STUDIO })
})

test('switching target: choosing a host’s model sends its host-qualified id, and it is not forwarded to the host', async () => {
  const state = core({ hosts: [view(STUDIO, 'Studio')], selected: STUDIO, overviews: { [STUDIO]: overview('RTX 4090 · 64 GB RAM') }, inventories: { [STUDIO]: { connection: 'direct', inventory: inventory() } } })
  const { local } = settings()
  await flush()
  expect(local().querySelector('h2')!.textContent).toBe('Models on Studio')
  button(local(), 'Use this').click()
  await flush()
  expect(sent(state, 'POST', '/api/local-models/use').map((call) => call.body)).toEqual([{ id: `@${STUDIO}/llama/qwen:Q4_K_M` }])
  // Back to this computer: the plain id, and no host on the request.
  button(document.querySelector<HTMLElement>('#models-page')!, 'This computer').click()
  await flush()
  expect(sent(state, 'POST', '/api/compute/select').map((call) => call.body)).toEqual([{ host: 'this' }])
  state.overviews.this = overview('Apple M2 · 16 GB RAM')
  await flush()
  expect(local().querySelector('h2')!.textContent).toBe('Local models')
  expect(document.querySelector('#models-page .host-detail')!.childElementCount).toBe(0)
})

test('a chosen host that is offline shows that sentence where its models would be, and no other models', async () => {
  const state = core({
    hosts: [view(STUDIO, 'Studio', { connection: 'offline', failure: failed('offline') })], selected: STUDIO,
    refused: { [STUDIO]: 'offline' }, inventories: { [STUDIO]: { connection: 'offline', failure: failed('offline') } },
  })
  const { page, local } = settings()
  await flush()
  expect(local().querySelector('.host-state')!.textContent).toBe(stateSentence('offline', 'Studio'))
  expect(local().querySelector('.local-model-card')).toBeNull()
  expect(local().textContent).not.toContain('Apple M2')
  expect(page.querySelector('.host-detail .host-connection')!.textContent).toBe('Offline')
  expect(page.querySelector('.host-picker .host-row.on')!.textContent).toContain('Studio')
  // The screen asked for the chosen host's models and for nobody else's, and chose nothing.
  expect(sent(state, 'GET', '/api/local-models').map((call) => call.query)).toEqual([{ host: STUDIO }])
  expect(sent(state, 'POST', '/api/compute/select')).toHaveLength(0)
  expect(sent(state, 'POST', '/api/local-models/use')).toHaveLength(0)
  // It comes back: the same host's models, with no press.
  state.hosts = [view(STUDIO, 'Studio')]
  state.refused = {}
  state.overviews[STUDIO] = overview('RTX 4090 · 64 GB RAM')
  state.inventories[STUDIO] = { connection: 'direct', inventory: inventory() }
  await vi.advanceTimersByTimeAsync(5000)
  expect(local().textContent).toContain('RTX 4090 · 64 GB RAM')
})

test('each refusal code from a host’s models is drawn as that state’s sentence', async () => {
  for (const code of ['busy', 'incompatible-version', 'setup-required', 'worker-failure', 'unpaired'] as const) {
    const state = core({ hosts: [view(STUDIO, 'Studio')], selected: STUDIO, refused: { [STUDIO]: code }, inventories: { [STUDIO]: { connection: 'direct', failure: failed(code) } } })
    const { mounted, local } = settings()
    await flush()
    expect(local().querySelector('.host-state')!.textContent, code).toBe(stateSentence(code, 'Studio'))
    expect(local().querySelector('.local-model-card'), code).toBeNull()
    expect(sent(state, 'GET', '/api/local-models').every((call) => call.query.host === STUDIO), code).toBe(true)
    mounted.close()
  }
})

test('General holds the role block, and leaving the page stops its reads', async () => {
  const state = core({ hosts: [view(STUDIO, 'Studio')], role: { role: 'interaction', active: 0, switching: { target: 'compute', phase: 'waiting', message: '', active: 3 } } })
  document.body.innerHTML = body
  document.body.dataset.view = 'settings'
  const mounted = mountSettings('token')
  closers.push(mounted.close)
  mounted.open('general')
  await flush()
  expect(document.querySelector('#general .compute-role')!.textContent).toContain('Waiting for 3 jobs to finish before switching to Compute.')
  await vi.advanceTimersByTimeAsync(2000)
  const reads = sent(state, 'GET', '/api/compute/role').length
  expect(reads).toBeGreaterThan(1)
  document.querySelector<HTMLButtonElement>('[data-settings="models"]')!.click()
  await flush()
  await vi.advanceTimersByTimeAsync(5000)
  expect(sent(state, 'GET', '/api/compute/role')).toHaveLength(reads)
  mounted.close()
  const after = state.calls.length
  await vi.advanceTimersByTimeAsync(20_000)
  expect(state.calls).toHaveLength(after)
})

// ---- the compute role's page ---------------------------------------------------------------

test('the compute page pairs, shows its own queue, pauses, switches role and closes its window', async () => {
  const state = core({ role: { role: 'compute', active: 0 }, queues: { this: { waiting: [job('two', { label: 'Image two' })], paused: false } } })
  const element = root()
  const mounted = mountComputeSetup(element, 'token')
  closers.push(mounted.close)
  await flush()
  expect(element.textContent).toContain('No computer is paired yet.')
  expect(element.querySelector('.host-queue h3')!.textContent).toBe('Queue on this computer')
  expect(sent(state, 'GET', '/api/compute/queue').every((call) => call.query.host === undefined)).toBe(true)
  expect([...element.querySelectorAll<HTMLElement>('.host-waiting li')].map((item) => item.dataset.job)).toEqual(['two'])
  button(element, 'Pause this computer').click()
  await flush()
  expect(sent(state, 'POST', '/api/compute/pause').map((call) => call.body)).toEqual([{ paused: true }])
  expect(button(element, 'Resume this computer').getAttribute('aria-pressed')).toBe('true')
  button(element, 'Close window').click()
  await flush()
  expect(sent(state, 'POST', '/api/compute/window/close')).toHaveLength(1)
  expect(button(element, 'Compute').getAttribute('aria-pressed')).toBe('true')
})

test('the compute page reads its own setup, follows its own install and offers installation without Use', async () => {
  const state = core({
    role: { role: 'compute', active: 0 },
    inventories: { this: { connection: 'offline', inventory: inventory({ setup: [{ id: 'runner', kind: 'runtime', title: 'Runner', bytes: GB, action: 'install', blocks: ['chat'] }] }) } },
    overviews: { this: overview('Apple M2', { mode: 'cloud' }) },
  })
  const element = root()
  const mounted = mountComputeSetup(element, 'token')
  closers.push(mounted.close)
  await flush()
  expect(sent(state, 'GET', '/api/compute/inventory').map((call) => call.query)).toEqual([{}])
  expect([...element.querySelectorAll('button')].some((one) => /^Use\b/.test(one.textContent ?? ''))).toBe(false)
  expect(element.textContent).not.toContain('Install & use')
  button(element, 'Install on This computer · 1 GB').click()
  await flush()
  expect(sent(state, 'POST', '/api/compute/setup/install').map((call) => call.body)).toEqual([{ requirement: 'runner' }])
  expect(sent(state, 'GET', '/api/compute/job').at(-1)!.query).toEqual({ job: 'setup-1' })
  state.jobs.this = [job('setup-1', { kind: 'setup', weight: 'light', state: 'failed', failure: { code: 'refused', message: 'Runner installation failed.' } })]
  await vi.advanceTimersByTimeAsync(2000)
  expect(element.querySelector('[data-requirement="runner"]')!.textContent).toContain('Runner installation failed.')
  button(element.querySelector('.local-models')!, 'Install').click()
  await flush()
  expect(sent(state, 'POST', '/api/local-models/install').map((call) => call.body)).toEqual([{ entry: 'qwen', quant: 'Q4_K_M' }])
  expect(sent(state, 'POST', '/api/local-models/use')).toHaveLength(0)
  expect(sent(state, 'GET', '/api/compute/jobs').every((call) => Object.keys(call.query).length === 0)).toBe(true)
})

test.each(['local', 'combined', 'cloud'] as const)('a remote download in %s leaves choosing its model to a later use in Local', async (mode) => {
  const current: Job = { id: 'remote/download', name: 'Qwen', target: 'qwen:Q4_K_M', step: 'download', done: 1, total: 2, message: 'Downloading onto Studio', startedAt: Date.now() }
  const state = core({ overviews: { [STUDIO]: overview('RTX 4090', { mode, jobs: [] }) } })
  state.routes['POST /api/local-models/install'] = () => ({ status: 202, body: current })
  state.routes['GET /api/local-models/progress'] = () => ({ body: { ...current, step: 'done', modelId: 'llama/qwen:Q4_K_M', message: 'Installed on Studio.' } })
  const element = root()
  const mounted = mountLocalModels(element, { request, host: () => ({ id: STUDIO, name: 'Studio' }), mode: () => mode })
  closers.push(mounted.close)
  mounted.open()
  await flush()
  expect(element.querySelector('.local-maintenance')).toBeNull()
  button(element, 'Install').click()
  await flush()
  expect(sent(state, 'POST', '/api/local-models/install').map((call) => call.body)).toEqual([{ host: STUDIO, entry: 'qwen', quant: 'Q4_K_M' }])
  expect(element.querySelector('.local-mode-choice')).toBeNull()
  await vi.advanceTimersByTimeAsync(1000)
  expect(sent(state, 'GET', '/api/local-models/progress').at(-1)!.query).toEqual({ host: STUDIO, job: 'remote/download' })
  expect(sent(state, 'POST', '/api/local-models/use')).toHaveLength(0)
  expect(element.textContent).toContain('Installed on Studio.')
  button(element, 'Use this model').click()
  await flush()
  if (mode === 'cloud') {
    expect(element.textContent).not.toContain('Use Combined')
    expect(sent(state, 'POST', '/api/local-models/use')).toHaveLength(0)
    button(element, 'Use Local').click()
    await flush()
  }
  expect(sent(state, 'POST', '/api/local-models/use').map((call) => call.body)).toEqual([
    { id: `@${STUDIO}/llama/qwen:Q4_K_M`, ...(mode !== 'local' && { mode: 'local' }) },
  ])
})

test.each([{ code: 'unpaired', status: 404 }, { code: 'offline', status: 503 }, { code: 'busy', status: 503 }] as const)(
  'host refusals retain $code from HTTP $status and draw its sentence without selecting anything', async ({ code, status }) => {
    const state = core({ hosts: [view(STUDIO, 'Studio')], selected: STUDIO, refused: { [STUDIO]: code } })
    state.routes['GET /api/compute/inventory'] = () => ({ status, body: { ok: false, code, said: `Host refused: ${code}` } })
    const { local, page } = settings()
    await flush()
    expect(local().querySelector('.host-state')!.textContent).toBe(stateSentence(code, 'Studio'))
    expect(page.querySelector('.host-detail .host-state')!.textContent).toBe(stateSentence(code, 'Studio'))
    expect(await request(`/api/compute/inventory?host=${STUDIO}`, undefined, { method: 'GET' })).toEqual({ ok: false, code, said: `Host refused: ${code}` })
    expect(sent(state, 'POST', '/api/compute/select')).toHaveLength(0)
    expect(sent(state, 'POST', '/api/local-models/use')).toHaveLength(0)
  },
)

test('state carries pairing without its code; only pair/start and the dedicated pairing read supply it', async () => {
  const state = core({ role: { role: 'compute', active: 0 } })
  const { element } = pairing('compute', state)
  await flush()
  button(element, 'Show a pairing code').click()
  await flush()
  expect(element.querySelector('.pair-code')!.textContent).toBe(CODE)
  const general = await request('/api/state', undefined, { method: 'GET' }) as { compute: { pairing: Omit<PairingStatus, 'code'> } }
  expect(general.compute.pairing.phase).toBe('waiting')
  expect(general.compute.pairing).not.toHaveProperty('code')
  const dedicated = await request('/api/compute/pair', undefined, { method: 'GET' }) as { pairing: PairingStatus }
  expect(dedicated.pairing.code).toBe(CODE)
  state.pairing = { phase: 'paired', hostId: STUDIO, peerName: 'MacBook' }
  await vi.advanceTimersByTimeAsync(1000)
  expect(element.querySelector('.pair-code')!.textContent).toBe('')
  expect((await request('/api/compute/pair', undefined, { method: 'GET' }) as { pairing: PairingStatus }).pairing).not.toHaveProperty('code')
})
