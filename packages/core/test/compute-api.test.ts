// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import { pins } from '../src/commands.js'
import { ComputeApi, hostModels, HINTS_KEY, localPicker, RoleSwitching, scrub, SHOWN_KEY } from '../src/compute/api.js'
import { Artifacts } from '../src/compute/artifacts.js'
import { memoryConnect, type Connect } from '../src/compute/connect.js'
import { HostProtocol } from '../src/compute/hostProtocol.js'
import { HOSTS_KEY, Hosts } from '../src/compute/hosts.js'
import { Inventory } from '../src/compute/inventory.js'
import { ROLE_KEY } from '../src/compute/role.js'
import { Scheduler, type Admission } from '../src/compute/scheduler.js'
import { Setup } from '../src/compute/setup.js'
import { TARGET_KEY } from '../src/compute/target.js'
import { ComputeError, type HostView, type JobSnapshot, type PairingStatus, type QueueSnapshot, type SetupRequirement } from '../src/compute/types.js'
import { textWorker, Workers, type ComputeWorker } from '../src/compute/workers.js'
import { refuse } from '../src/guard.js'
import { readInstalled, remember } from '../src/installed.js'
import { LLAMA, type LlamaServer } from '../src/llama.js'
import { LocalModels } from '../src/localModels.js'
import { LocalRunners, type ManagedRunner } from '../src/localRunners.js'
import type { Machine } from '../src/machine.js'
import type { ModeTransition } from '../src/modeTransition.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve } from '../src/serve.js'
import { Store } from '../src/store.js'
import { noPolling } from './staged.js'

/**
 * Two Alexias in one process, joined by the in-memory transport, and every route of
 * remote-compute.md §6 asked over HTTP. The interaction computer is the real `serve()`. The
 * compute host is its real modules with `ComputeApi` in front of them — `service.ts` is
 * another task's — and only the model runner's own HTTP address and Hugging Face are stubs.
 */

const cleanups: (() => Promise<void> | void)[] = []
afterAll(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function temp(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `alexia-compute-api-${name}-`))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  return root
}

const GB = 1024 ** 3
/** The compute host's hardware: nothing like the laptop's, so an answer that carries it came from the host. */
const hardware: Machine = {
  platform: 'linux', arch: 'x64', chip: 'Studio GPU box', appleSilicon: false, ramBytes: 96 * GB, freeRamBytes: 64 * GB,
  freeDiskBytes: 500 * GB, diskKnown: true, budgetBytes: 80 * GB, cpuCores: 32,
}
const laptop: Machine = { platform: 'darwin', arch: 'arm64', chip: 'Laptop', appleSilicon: true, ramBytes: 16 * GB, freeDiskBytes: 20 * GB, budgetBytes: 8 * GB }

const sse = (value: unknown): string => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
const ANSWER = [
  sse({ model: 'llama/test', choices: [{ delta: { content: 'Hello from ' } }] }),
  sse({ choices: [{ delta: { content: 'the studio, 世界.' } }] }),
  sse({ usage: { prompt_tokens: 12, completion_tokens: 6 }, choices: [] }),
  sse('[DONE]'),
].join('')

type Answer<T> = { status: number; body: T }
const client = (base: string, token: string) => async <T = Record<string, unknown>>(path: string, body?: unknown, method?: string): Promise<Answer<T>> => {
  const response = await fetch(new URL(path, base), {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'x-alexia-token': token, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: response.status, body: parsed as T }
}

/** A worker made by hand: one missing requirement whose install waits to be let through, and one operation. */
function fixtureWorker() {
  const state = { missing: true, release: (): void => {}, installs: 0 }
  const need: SetupRequirement = { id: 'engine', kind: 'runtime', title: 'Render engine', bytes: 2048, action: 'install', blocks: ['demo.render'] }
  const worker: ComputeWorker = {
    id: 'fixture-worker', loaded: () => false, stop: async () => {},
    capabilities: async () => [{ cap: 'demo.render', summary: 'Render a fixture file.', weight: 'heavy', ready: true }],
    setup: async () => (state.missing ? [need] : []),
    install: async (_id, io) => {
      state.installs++
      io.progress({ progress: 512, total: 2048, message: 'Downloading to /srv/alexia/engine/part' })
      await new Promise<void>((resolve) => {
        state.release = resolve
        io.signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      if (io.signal.aborted) return
      state.missing = false
    },
    run: async () => ({ files: [] }),
  }
  return { worker, state }
}

/** The compute host: the real scheduler, workers, inventory, host protocol and picker, with `ComputeApi` in front. */
async function studio(connect: Connect) {
  const root = temp('studio')
  const store = new Store(':memory:')
  store.kvSet(CORE, ROLE_KEY, 'compute')
  const hosts = new Hosts(store, 'compute')
  const scheduler = new Scheduler()
  const weights = join(root, 'weights')
  writeFileSync(weights, 'weights')
  remember(root, {
    id: 'llama/test', format: 'gguf', name: 'Test', repo: 'test/first', revision: 'a'.repeat(40), quant: 'Q4', files: [weights], bytes: 7,
    context: 8192, tools: true, vision: false, abliterated: false, nsfwOk: 'unknown', vetted: false, ready: true, installedAt: 1,
  })
  let loaded: string | undefined
  const text = textWorker({
    dataDir: root,
    runners: {
      provider: () => ({ ...LLAMA, prepare: async (id: string) => { loaded = id; return { baseUrl: 'http://127.0.0.1:1/v1', key: 'secret', release: () => {} } } }),
      loaded: () => (loaded ? { model: loaded, baseUrl: 'http://127.0.0.1:1/v1', since: 1 } : undefined),
      stop: async () => { loaded = undefined },
    },
    backend: async () => 'cpu', llamaSupported: () => true, llamaReady: () => ({}) as never, mlxSupported: () => false,
  })
  const fixture = fixtureWorker()
  const workers = new Workers(text, () => [fixture.worker])
  const artifacts = new Artifacts({ dir: join(root, 'compute', 'jobs') })
  const inventory = new Inventory({ dataDir: root, name: 'Studio', appVersion: '2.0.0', workers, machine: async () => hardware })
  const setup = new Setup({ workers, scheduler, artifacts, inventory })

  // The host's own picker, with Hugging Face answered from here: one small file, and its hash.
  const content = Buffer.from('fake GGUF data')
  const sha256 = createHash('sha256').update(content).digest('hex')
  const hub = vi.fn(async (url: string | URL | Request) => {
    const path = String(url)
    if (path.includes('/tree/')) return Response.json([{ type: 'file', path: 'Test-Q4_K_M.gguf', size: content.length, lfs: { size: content.length, oid: sha256 } }])
    if (path.includes('/api/models/')) return Response.json({ sha: 'b'.repeat(40), gated: false, cardData: { license: 'apache-2.0' }, gguf: { total: 8e9 } })
    return new Response(content)
  }) as unknown as typeof fetch
  let serving: { model: string } | undefined
  const server = { ensure: async (model: string) => { serving = { model }; return 'http://127.0.0.1:1/v1' }, loaded: () => serving, stop: async () => { serving = undefined } } as unknown as LlamaServer
  const local = new LocalModels({
    dataDir: root, store, server, machine: async () => hardware, fetch: hub,
    ensureRuntime: (async () => ({ version: 'test' })) as never, smoke: async () => ({ tokensPerSecond: 10 }),
  })
  const asked: { op: string; args: Record<string, unknown> }[] = []
  const offered = hostModels(local)

  const runner = { calls: [] as string[] }
  const protocol = new HostProtocol({
    connect, hosts, scheduler, workers, artifacts, inventory, setup, name: 'Studio', appVersion: '2.0.0', store,
    models: { call: (op, args) => { asked.push({ op, args }); return offered.call(op, args) } },
    fetch: (async (_input: unknown, init?: RequestInit) => {
      runner.calls.push(Buffer.from(init!.body as Uint8Array).toString('utf8'))
      return new Response(ANSWER, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
    }) as typeof fetch,
  })
  protocol.start()

  const stop = vi.fn(async () => {})
  const restart = vi.fn()
  const roles = new RoleSwitching({
    store,
    active: () => { const queue = scheduler.queue(); return (queue.running ? 1 : 0) + queue.waiting.length },
    cancelActive: () => scheduler.cancelAll('cancelled'),
    stop, restart,
  })
  const token = vi.fn(async () => {})
  const closeWindow = vi.fn()
  const api = new ComputeApi({
    role: 'compute', hosts, connect, scheduler, protocol, roles, store, name: () => 'Studio', appVersion: '2.0.0',
    inventory, setup, models: localPicker(local), token, closeWindow, platform: 'linux',
  })
  const http = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const sent = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {}
      const url = new URL(`http://127.0.0.1${request.url!}`)
      // The same guard `serve.ts` runs before any handler: a confirm is asked for here, not in a route.
      const refusal = refuse(url.pathname, request.method ?? 'GET', sent)
      if (refusal) {
        response.writeHead(refusal.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, said: refusal.said, ...(refusal.confirmable && { confirm: true }) }))
      } else if (!(await api.handle(request, response, url, sent))) response.writeHead(404).end()
    })()
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    api.close()
    await protocol.close()
    await scheduler.close()
    await local.close()
    inventory.close()
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    store.close()
  })
  /** A heavy job that runs until it is cancelled, as a worker's operation would. */
  const hold = (id: string): Admission => {
    const admission = scheduler.submit({ id, kind: 'operation', weight: 'heavy', label: 'demo.render', worker: fixture.worker.id })
    void admission.turn.then(() => {
      admission.progress({ progress: 1, total: 4, message: 'Rendering.' })
      admission.signal.addEventListener('abort', () => { admission.finish({ state: 'cancelled' }) }, { once: true })
    }, () => {})
    return admission
  }
  return {
    root, store, hosts, scheduler, fixture, asked, offered, runner, roles, stop, restart, token, closeWindow, hold,
    ask: client(`http://127.0.0.1:${(http.address() as AddressInfo).port}/`, ''),
  }
}

/** The interaction computer: `serve()` itself, with one end of the transport handed in. */
async function desk(connect: Connect, root = temp('laptop')) {
  noPolling(root)
  const baseUrl = 'http://127.0.0.1:1/v1'
  let loaded: string | undefined
  const runner: ManagedRunner = {
    ensure: async (id) => { loaded = id; return baseUrl },
    acquire: async (id) => { loaded = id; return { baseUrl, key: 'k', release: () => undefined } },
    loaded: () => loaded ? { model: loaded, baseUrl, since: 1 } : undefined,
    stop: async () => { loaded = undefined },
  }
  const restart = vi.fn()
  const alexia = await serve({
    dataDir: root, uiDir: join(import.meta.dirname, '..', '..', 'ui'), local: false, providers: [], secrets: memorySecrets(),
    pluginsDir: join(root, 'extensions'), localRunners: new LocalRunners(root, [{ id: 'llama', server: runner, provider: LLAMA }]),
    modeTransitions: { available: () => true, machine: async () => laptop },
    compute: { connect, name: () => 'Laptop', restart },
  })
  let closed = false
  const close = async (): Promise<void> => { if (!closed) { closed = true; await alexia.close() } }
  cleanups.push(close)
  return { root, alexia, restart, close, ask: client(alexia.url, alexia.token) }
}

interface State { compute: { role: string; available: boolean; hosts: HostView[]; pairing?: PairingStatus; target?: { phase: string } }; modeTransition?: ModeTransition; setup: { mode: string } }

const { a, b } = memoryConnect()
const host = await studio(b)
const here = await desk(a)
let hostId = ''
let controllerId = ''

/** Pair the two over their HTTP routes, exactly as the two screens do. */
async function pair(): Promise<string> {
  const opened = await host.ask<{ ok: boolean; pairing: PairingStatus }>('/api/compute/pair/start', {})
  expect(opened.status).toBe(200)
  expect(opened.body.pairing).toMatchObject({ phase: 'waiting', code: expect.stringMatching(/^\d+(-[a-z]+){4}$/), expiresAt: expect.any(Number) })
  const joined = await here.ask<{ ok: boolean; pairing: PairingStatus }>('/api/compute/pair/start', { code: opened.body.pairing.code })
  expect(joined.body).toMatchObject({ ok: true, pairing: { phase: 'connecting' } })
  // The side that typed the code is never told it back.
  expect(JSON.stringify(joined.body)).not.toContain(opened.body.pairing.code!)
  let paired: PairingStatus | undefined
  await vi.waitFor(async () => {
    paired = (await here.ask<{ pairing?: PairingStatus }>('/api/compute/pair')).body.pairing
    expect(paired).toMatchObject({ phase: 'paired', peerName: 'Studio' })
  })
  await vi.waitFor(async () => {
    const theirs = (await host.ask<{ pairing?: PairingStatus }>('/api/compute/pair')).body.pairing
    expect(theirs).toMatchObject({ phase: 'paired', peerName: 'Laptop' })
    // The code is spent the moment the pairing settles.
    expect(theirs!.code).toBeUndefined()
    controllerId = theirs!.hostId!
  })
  return paired!.hostId!
}

test('the shell serves the compute page and its script', async () => {
  const page = await fetch(new URL('/compute.html', here.alexia.url))
  expect(page.status).toBe(200)
  const html = await page.text()
  expect(html).toContain('id="compute-setup"')
  expect(html).toContain(`data-token="${here.alexia.token}"`)
  const script = await fetch(new URL('/compute-setup.js', here.alexia.url))
  expect(script.status).toBe(200)
  expect(script.headers.get('content-type')).toContain('javascript')
})

test('before anything is paired: both roles say what they are, and nothing is listed', async () => {
  const state = (await here.ask<State>('/api/state')).body
  expect(state.compute).toEqual({ role: 'interaction', available: true, hosts: [] })
  expect((await here.ask('/api/compute/role')).body).toEqual({ role: 'interaction', active: 0 })
  expect((await here.ask('/api/compute/hosts')).body).toEqual({ hosts: [], selected: 'this', available: true })
  expect((await here.ask('/api/compute/pair')).body).toEqual({})
  expect((await host.ask('/api/compute/role')).body).toEqual({ role: 'compute', active: 0 })
  expect((await host.ask('/api/compute/hosts')).body).toEqual({ hosts: [], selected: 'this', available: true })

  // A route answers only in the role it belongs to; in the other it is a 409 that says refused.
  expect(await here.ask('/api/compute/pause', { paused: true })).toMatchObject({ status: 409, body: { ok: false, code: 'refused' } })
  expect(await here.ask('/api/compute/window/close', {})).toMatchObject({ status: 409, body: { code: 'refused' } })
  expect(await host.ask('/api/compute/select', { host: 'this' })).toMatchObject({ status: 409, body: { code: 'refused' } })
  // And a host that is not paired is said to be that, not guessed at.
  expect(await here.ask('/api/compute/inventory?host=abcdefgh1234')).toMatchObject({ status: 404, body: { ok: false, code: 'unpaired' } })
  expect(await here.ask('/api/compute/queue')).toMatchObject({ status: 400 })
  expect(await here.ask('/api/compute/nothing')).toMatchObject({ status: 404, body: { ok: false } })
})

test('unpairing an unknown host answers 404 unpaired in both roles', async () => {
  for (const computer of [here, host]) {
    expect(await computer.ask('/api/compute/unpair', { host: 'abcdefgh1234', confirm: true })).toMatchObject({
      status: 404, body: { ok: false, code: 'unpaired' },
    })
  }
})

test('a code that is wrong records nothing, and a pairing can be cancelled', async () => {
  const opened = await host.ask<{ pairing: PairingStatus }>('/api/compute/pair/start', {})
  const [number] = opened.body.pairing.code!.split('-')
  expect((await here.ask('/api/compute/pair/start', { code: `${number}-wrong-wrong-wrong-wrong` })).status).toBe(200)
  await vi.waitFor(async () => { expect((await here.ask<{ pairing: PairingStatus }>('/api/compute/pair')).body.pairing).toMatchObject({ phase: 'failed', message: expect.stringContaining('fresh code') }) })
  // One attempt per code: the host's code died with the wrong guess.
  await vi.waitFor(async () => { expect((await host.ask<{ pairing: PairingStatus }>('/api/compute/pair')).body.pairing.phase).toBe('failed') })
  expect(here.alexia.store.kvGet(CORE, HOSTS_KEY)).toBeUndefined()
  expect(await here.ask('/api/compute/pair/start', {})).toMatchObject({ status: 400 })

  await host.ask('/api/compute/pair/start', {})
  expect((await host.ask('/api/compute/pair/cancel', {})).body).toEqual({ ok: true })
  expect((await host.ask<{ pairing: PairingStatus }>('/api/compute/pair')).body.pairing).toEqual({ phase: 'cancelled', message: expect.any(String) })
})

test('pairing: a code shown on the host, typed on the interaction computer, and both keep a record', async () => {
  hostId = await pair()
  expect(here.alexia.store.kvGet(CORE, HOSTS_KEY)).toEqual([expect.objectContaining({ id: hostId, name: 'Studio', peerRole: 'compute', endpointId: await b.identity(), platform: 'linux' })])
  expect(host.hosts.list()).toEqual([expect.objectContaining({ id: controllerId, name: 'Laptop', peerRole: 'interaction', endpointId: await a.identity() })])
  // Pairing only proved the peer. Core allowed it, and kept where to find it.
  expect(here.alexia.store.kvGet(CORE, HINTS_KEY)).toEqual({ [hostId]: { relayUrl: null, directAddresses: [] } })
  // `/api/state` says a pairing happened and never carries a code.
  const state = (await here.ask<State>('/api/state')).body
  expect(state.compute.pairing).toEqual({ phase: 'paired', peerName: 'Studio', hostId })
  expect(state.compute.hosts).toEqual([expect.objectContaining({ host: expect.objectContaining({ id: hostId, name: 'Studio' }) })])

  // A compute host works for one computer: a second pairing is refused until it is unpaired.
  expect(await host.ask('/api/compute/pair/start', {})).toMatchObject({ status: 409, body: { ok: false, said: 'Unpair the current computer first.', code: 'refused' } })
})

test('the host list, selecting a host, and its inventory', async () => {
  await vi.waitFor(async () => {
    const listed = (await here.ask<{ hosts: HostView[]; selected: string; available: boolean }>('/api/compute/hosts')).body
    expect(listed).toMatchObject({ selected: 'this', available: true, hosts: [{ host: { id: hostId, name: 'Studio' }, connection: 'direct', inventory: { name: 'Studio' } }] })
    expect(listed.hosts[0]!.failure).toBeUndefined()
  })
  expect((await host.ask<{ hosts: HostView[] }>('/api/compute/hosts')).body).toMatchObject({ selected: 'this', hosts: [{ host: { name: 'Laptop' }, connection: 'direct' }] })

  expect(await here.ask('/api/compute/select', { host: 'nobody' })).toMatchObject({ status: 404, body: { code: 'unpaired' } })
  expect((await here.ask('/api/compute/select', { host: hostId })).body).toEqual({ ok: true })
  expect((await here.ask<{ selected: string }>('/api/compute/hosts')).body.selected).toBe(hostId)
  // Looking at a host chooses nothing.
  expect(here.alexia.store.kvGet(CORE, TARGET_KEY)).toBeUndefined()
  expect(pins(here.alexia.store).model).toBeUndefined()

  const read = (await here.ask<{ inventory: { machine: Machine; models: { id: string }[]; setup: SetupRequirement[]; capabilities: { cap: string; ready: boolean }[] }; connection: string }>(`/api/compute/inventory?host=${hostId}`)).body
  expect(read.connection).toBe('direct')
  expect(read.inventory.machine).toMatchObject({ chip: 'Studio GPU box', ramBytes: 96 * GB })
  expect(read.inventory.models.map((model) => model.id)).toEqual(['llama/test'])
  expect(read.inventory.setup).toEqual([expect.objectContaining({ title: 'Render engine', bytes: 2048, action: 'install' })])
  expect(read.inventory.capabilities).toEqual([expect.objectContaining({ cap: 'demo.render', ready: false })])

  expect((await here.ask(`/api/compute/status?host=${hostId}`)).body).toEqual({ connection: 'direct', label: 'Direct' })
  expect((await host.ask('/api/compute/status')).body).toEqual({ connection: 'direct', label: 'Direct' })
  // The compute role reads its own setup list from the same route, with no host to name.
  expect((await host.ask<{ inventory: { setup: SetupRequirement[] } }>('/api/compute/inventory')).body.inventory.setup).toHaveLength(1)
})

test('the picker for a paired host is the host’s: its machine, its downloads, its disk', async () => {
  const theirs = (await here.ask<{ machine: { chip: string; ramBytes: number }; installed: { id: string }[] }>(`/api/local-models?host=${hostId}`)).body
  expect(theirs.machine).toMatchObject({ chip: 'Studio GPU box', ramBytes: 96 * GB })
  expect(theirs.installed.map((one) => one.id)).toEqual(['llama/test'])
  // The same route with no host is still this computer's own picker.
  const mine = (await here.ask<{ machine: { chip: string }; installed: unknown[] }>('/api/local-models')).body
  expect(mine.machine.chip).toBe('Laptop')
  expect(mine.installed).toEqual([])
  expect((await here.ask<{ machine: { chip: string } }>('/api/local-models?host=this')).body.machine.chip).toBe('Laptop')
  // And the host's own page reads the same thing from the host itself.
  expect((await host.ask<{ machine: { chip: string } }>('/api/local-models')).body.machine.chip).toBe('Studio GPU box')

  // A download asked for here lands there. The mode it carried is this computer's business and is not sent.
  const started = await here.ask<{ id: string; step: string }>('/api/local-models/install', { host: hostId, repo: 'test/model', quant: 'Q4_K_M', mode: 'local' })
  expect(started.status).toBe(202)
  expect(host.asked.at(-1)).toEqual({ op: 'install', args: { repo: 'test/model', quant: 'Q4_K_M' } })
  await vi.waitFor(async () => {
    const progress = await here.ask<{ step: string }>(`/api/local-models/progress?host=${hostId}&job=${started.body.id}`)
    expect(progress.body.step).toBe('done')
  })
  expect(readInstalled(host.root).map((one) => one.repo).sort()).toEqual(['test/first', 'test/model'])
  expect(readInstalled(here.root)).toEqual([])
  // The host says its inventory changed, unasked.
  await vi.waitFor(async () => {
    expect((await here.ask<{ inventory: { models: unknown[] } }>(`/api/compute/inventory?host=${hostId}`)).body.inventory.models).toHaveLength(2)
  })

  // What is only ever done at the host itself is refused from here, and a wrong request keeps the host's own sentence.
  expect(await here.ask('/api/local-models/token', { host: hostId, token: 'hf_secret' })).toMatchObject({ status: 400, body: { ok: false } })
  expect(await here.ask('/api/local-models/import', { host: hostId, path: '/tmp/model.gguf' })).toMatchObject({ status: 400 })
  expect(await here.ask(`/api/local-models/import-preview?host=${hostId}&path=/tmp/model.gguf`)).toMatchObject({ status: 400 })
  expect(await here.ask(`/api/local-models/progress?host=${hostId}&job=gone`)).toMatchObject({ status: 404, body: { ok: false, code: 'not-found' } })
  expect(await here.ask('/api/local-models/install', { host: hostId, repo: 'not a repo', quant: 'Q4_K_M' })).toMatchObject({ status: 409, body: { ok: false, code: 'refused', said: 'Use a Hugging Face publisher/model repository.' } })
  expect(await here.ask('/api/local-models', undefined, 'GET').then(() => here.ask('/api/local-models?host=abcdefgh1234'))).toMatchObject({ status: 404, body: { code: 'unpaired' } })

  // DELETE carries the host in the query, where the screen puts it.
  const added = readInstalled(host.root).find((one) => one.repo === 'test/model')!
  const removed = await here.ask<{ ok: boolean }>(`/api/local-models/${encodeURIComponent(added.id)}?host=${hostId}`, undefined, 'DELETE')
  expect(removed).toMatchObject({ status: 200, body: { ok: true } })
  expect(host.asked.at(-1)).toEqual({ op: 'remove', args: { id: added.id } })
  expect(readInstalled(host.root).map((one) => one.id)).toEqual(['llama/test'])

  // The host's own page keeps the token and import routes, which never cross the link.
  expect((await host.ask('/api/local-models/token', { token: ' hf_secret ' })).body).toMatchObject({ ok: true })
  expect(host.token).toHaveBeenCalledWith('hf_secret')
  expect(await host.ask('/api/local-models/use', { id: 'llama/test' })).toMatchObject({ status: 409 })
})

test('an unpaired error returned by a host answers 404 with its code', async () => {
  const call = vi.spyOn(host.offered, 'call').mockRejectedValueOnce(new ComputeError('unpaired', 'That computer is no longer paired.'))
  try {
    expect(await here.ask(`/api/local-models/repo?host=${hostId}&repo=test/model`)).toMatchObject({
      status: 404, body: { ok: false, code: 'unpaired', said: 'That computer is no longer paired.' },
    })
  } finally { call.mockRestore() }
})

test('choosing a paired host’s model, and an answer streamed through the bridge', async () => {
  const id = `@${hostId}/llama/test`
  expect(await here.ask('/api/local-models/use', { id, mode: 'combined' })).toMatchObject({ status: 409 })
  expect(await here.ask('/api/local-models/use', { id: '@abcdefgh1234/llama/test' })).toMatchObject({ status: 404, body: { code: 'unpaired' } })
  const used = await here.ask<{ ok: boolean }>('/api/local-models/use', { id })
  expect(used).toMatchObject({ status: 200, body: { ok: true } })
  let state!: State
  await vi.waitFor(async () => {
    state = (await here.ask<State>('/api/state')).body
    expect(['ready', 'failed']).toContain(state.modeTransition?.phase)
  })
  // The mode line names the model and the computer it runs on, by the name that computer gave.
  expect(state.modeTransition).toMatchObject({ phase: 'ready', targetMode: 'local', target: { hostId, modelId: 'llama/test' }, targetStatus: { phase: 'ready', connection: 'direct' }, message: 'Local · Test · Studio' })
  expect(state.setup.mode).toBe('local')
  expect(state.compute.target).toMatchObject({ phase: 'ready' })
  expect(pins(here.alexia.store).model).toBe(id)
  expect(here.alexia.store.kvGet(CORE, TARGET_KEY)).toEqual({ hostId, modelId: 'llama/test' })
  expect((await here.ask<{ target: { phase: string } }>(`/api/compute/status?host=${hostId}`)).body.target).toMatchObject({ phase: 'ready' })

  const answer = await fetch(new URL('/api/chat', here.alexia.url), {
    method: 'POST', headers: { 'x-alexia-token': here.alexia.token, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Say hello from wherever you are.' }),
  })
  expect(answer.status).toBe(200)
  const words = await answer.text()
  expect(words).toContain('Hello from ')
  expect(words).toContain('the studio, 世界.')
  // One request reached the host's runner, naming the model by the host's own id.
  expect(host.runner.calls).toHaveLength(1)
  expect(JSON.parse(host.runner.calls[0]!)).toMatchObject({ model: 'llama/test', stream: true })
  expect(host.runner.calls[0]).toContain('Say hello from wherever you are.')
})

test('the queue, one job’s state, and cancelling from either computer', async () => {
  expect((await here.ask<{ queue: QueueSnapshot }>(`/api/compute/queue?host=${hostId}`)).body.queue).toEqual({ waiting: [], paused: false })
  host.hold('render-1')
  host.hold('render-2')
  host.hold('render-3')
  await vi.waitFor(async () => {
    const queue = (await here.ask<{ queue: QueueSnapshot }>(`/api/compute/queue?host=${hostId}`)).body.queue
    expect(queue.running).toMatchObject({ id: 'render-1', state: 'running', progress: { progress: 1, total: 4 } })
    expect(queue.waiting.map((job) => job.id)).toEqual(['render-2', 'render-3'])
  })
  expect((await host.ask<{ queue: QueueSnapshot }>('/api/compute/queue')).body.queue.waiting).toHaveLength(2)
  expect((await host.ask('/api/compute/role')).body).toEqual({ role: 'compute', active: 3 })
  expect((await here.ask<{ job: JobSnapshot }>(`/api/compute/job?host=${hostId}&job=render-2`)).body.job).toMatchObject({ id: 'render-2', state: 'queued' })
  expect(await here.ask(`/api/compute/job?host=${hostId}&job=never`)).toMatchObject({ status: 404, body: { code: 'not-found' } })

  // A queued job is gone at once; this computer has no queue of its own to cancel in.
  expect(await here.ask('/api/compute/jobs/cancel', { host: 'this', job: 'render-2' })).toMatchObject({ status: 400 })
  expect((await here.ask<{ ok: boolean; job: JobSnapshot }>('/api/compute/jobs/cancel', { host: hostId, job: 'render-2' })).body).toMatchObject({ ok: true, job: { id: 'render-2', state: 'cancelled' } })
  // The host cancels in its own queue under the name `this`, which is what its page sends.
  expect((await host.ask<{ job: JobSnapshot }>('/api/compute/jobs/cancel', { host: 'this', job: 'render-3' })).body.job).toMatchObject({ state: 'cancelled' })
  expect(await host.ask('/api/compute/jobs/cancel', { host: 'this', job: 'never' })).toMatchObject({ status: 404, body: { code: 'not-found' } })
  // A running one is stopped in its worker.
  await here.ask('/api/compute/jobs/cancel', { host: hostId, job: 'render-1' })
  await vi.waitFor(async () => {
    expect((await here.ask<{ job: JobSnapshot }>(`/api/compute/job?host=${hostId}&job=render-1`)).body.job.state).toBe('cancelled')
    expect((await here.ask<{ queue: QueueSnapshot }>(`/api/compute/queue?host=${hostId}`)).body.queue).toEqual({ waiting: [], paused: false })
  })
  // Jobs that have left the queue can still be read, on both computers.
  const finished = (await here.ask<{ jobs: JobSnapshot[] }>(`/api/compute/jobs?host=${hostId}`)).body.jobs
  expect(finished.filter((job) => job.id.startsWith('render-')).map((job) => job.state)).toEqual(['cancelled', 'cancelled', 'cancelled'])
  expect((await host.ask<{ jobs: JobSnapshot[] }>('/api/compute/jobs')).body.jobs.some((job) => job.id === 'render-1' && job.state === 'cancelled')).toBe(true)

  // Pause is the host's own switch, and the paired computer sees it.
  expect((await host.ask('/api/compute/pause', { paused: true })).body).toEqual({ ok: true })
  await vi.waitFor(async () => { expect((await here.ask<{ queue: QueueSnapshot }>(`/api/compute/queue?host=${hostId}`)).body.queue.paused).toBe(true) })
  expect((await host.ask('/api/compute/pause', { paused: false })).body).toEqual({ ok: true })
  await vi.waitFor(async () => { expect((await here.ask<{ queue: QueueSnapshot }>(`/api/compute/queue?host=${hostId}`)).body.queue.paused).toBe(false) })
  expect(await host.ask('/api/compute/pause', {})).toMatchObject({ status: 400 })
})

test('an install: started by a button, read by its job id, with no host path in what is shown', async () => {
  const need = (await here.ask<{ inventory: { setup: SetupRequirement[] } }>(`/api/compute/inventory?host=${hostId}`)).body.inventory.setup[0]!

  // The compute role installs from its own page, reads the job by its id, and can stop it there.
  expect(await host.ask('/api/compute/setup/install', { requirement: 'no-such-thing' })).toMatchObject({ status: 404, body: { code: 'not-found' } })
  const own = (await host.ask<{ ok: boolean; job: JobSnapshot }>('/api/compute/setup/install', { host: 'this', requirement: need.id })).body.job
  expect(own).toMatchObject({ kind: 'setup', weight: 'light', label: 'Render engine' })
  await vi.waitFor(async () => { expect((await host.ask<{ job: JobSnapshot }>(`/api/compute/job?job=${own.id}`)).body.job.state).toBe('running') })
  await host.ask('/api/compute/jobs/cancel', { host: 'this', job: own.id })
  await vi.waitFor(async () => { expect((await host.ask<{ job: JobSnapshot }>(`/api/compute/job?job=${own.id}`)).body.job.state).toBe('cancelled') })
  await vi.waitFor(() => { expect(host.scheduler.idle()).toBe(true) })

  const started = await here.ask<{ ok: boolean; job: JobSnapshot }>('/api/compute/setup/install', { host: hostId, requirement: need.id })
  expect(started.body).toMatchObject({ ok: true, job: { kind: 'setup', weight: 'light', label: 'Render engine' } })
  const jobId = started.body.job.id
  // Its state and its progress are read by id, whether or not the queue is showing it.
  await vi.waitFor(async () => {
    const job = (await here.ask<{ job: JobSnapshot }>(`/api/compute/job?host=${hostId}&job=${jobId}`)).body.job
    expect(job).toMatchObject({ state: 'running', progress: { progress: 512, total: 2048, message: 'Downloading to a file on that computer' } })
  })
  expect(await here.ask('/api/compute/setup/install', { host: hostId, requirement: 'no-such-thing' })).toMatchObject({ status: 404, body: { code: 'not-found' } })
  host.fixture.state.release()
  await vi.waitFor(async () => {
    expect((await here.ask<{ job: JobSnapshot }>(`/api/compute/job?host=${hostId}&job=${jobId}`)).body.job.state).toBe('succeeded')
    const now = (await here.ask<{ inventory: { setup: unknown[]; capabilities: { ready: boolean }[] } }>(`/api/compute/inventory?host=${hostId}`)).body.inventory
    expect(now.setup).toEqual([])
    expect(now.capabilities[0]!.ready).toBe(true)
  })
  expect((await here.ask<{ jobs: JobSnapshot[] }>(`/api/compute/jobs?host=${hostId}`)).body.jobs.find((job) => job.id === jobId)).toMatchObject({ state: 'succeeded' })
})

test('connectivity services: saved for the next start, and cleared back to the defaults', async () => {
  expect((await here.ask('/api/compute/services')).body).toEqual({ defaults: true })
  expect((await here.ask('/api/compute/services', { relay: 'https://relay.example.org', mailbox: 'wss://mailbox.example.org/v1' })).body)
    .toEqual({ relay: 'https://relay.example.org', mailbox: 'wss://mailbox.example.org/v1', defaults: false })
  expect((await here.ask('/api/compute/services')).body).toMatchObject({ defaults: false, relay: 'https://relay.example.org' })
  expect(await here.ask('/api/compute/services', { relay: 'not an address' })).toMatchObject({ status: 400 })
  expect((await here.ask('/api/compute/services', {})).body).toEqual({ defaults: true })
  expect((await host.ask('/api/compute/services')).body).toEqual({ defaults: true })
})

test('the compute host’s window may go, when it says so', async () => {
  expect((await host.ask('/api/compute/window/close', {})).body).toEqual({ ok: true })
  expect(host.closeWindow).toHaveBeenCalledTimes(1)
})

test('a role switch on a working host waits, can be stopped, and can be told to cancel instead', async () => {
  host.hold('render-4')
  await vi.waitFor(() => { expect(host.scheduler.queue().running?.state).toBe('running') })
  expect((await host.ask('/api/compute/role', { role: 'interaction' })).status).toBe(409)
  const asked = await host.ask<{ ok: boolean }>('/api/compute/role', { role: 'interaction', confirm: true })
  expect(asked.body.ok).toBe(true)
  await vi.waitFor(async () => { expect((await host.ask('/api/compute/role')).body).toMatchObject({ role: 'compute', active: 1, switching: { target: 'interaction', phase: 'waiting', active: 1 } }) })
  // A second request is refused while one waits, which is why stopping is a route of its own.
  expect(await host.ask('/api/compute/role', { role: 'interaction', confirm: true })).toMatchObject({ status: 409, body: { ok: false } })

  expect((await host.ask('/api/compute/role/cancel', {})).body).toMatchObject({ ok: true })
  await vi.waitFor(async () => { expect((await host.ask('/api/compute/role')).body).toEqual({ role: 'compute', active: 1 }) })
  expect(await host.ask('/api/compute/role/cancel', {})).toMatchObject({ status: 409, body: { ok: false } })
  // Nothing was stopped, nothing was written, and the job never noticed.
  expect(host.stop).not.toHaveBeenCalled()
  expect(host.store.kvGet(CORE, ROLE_KEY)).toBe('compute')
  expect(host.scheduler.status('render-4')!.state).toBe('running')

  // Waiting again, and this time told to cancel what it waits for.
  expect((await host.ask<{ ok: boolean }>('/api/compute/role', { role: 'interaction', confirm: true })).body.ok).toBe(true)
  await vi.waitFor(async () => { expect((await host.ask<{ switching?: { phase: string } }>('/api/compute/role')).body.switching?.phase).toBe('waiting') })
  expect((await host.ask<{ ok: boolean }>('/api/compute/role', { role: 'interaction', cancel: true, confirm: true })).body.ok).toBe(true)
  await vi.waitFor(async () => { expect((await host.ask<{ switching?: { phase: string } }>('/api/compute/role')).body.switching?.phase).toBe('restarting') })
  expect(host.scheduler.status('render-4')!.state).toBe('cancelled')
  // The role is written only after the stop, and the restart only after the role.
  expect(host.stop).toHaveBeenCalledTimes(1)
  expect(host.store.kvGet(CORE, ROLE_KEY)).toBe('interaction')
  expect(host.restart).toHaveBeenCalledTimes(1)
  // The test's host carries on in the role it was started in: put the stored one back.
  host.store.kvSet(CORE, ROLE_KEY, 'compute')
})

test('unpairing from the interaction computer: its jobs are cancelled, its connection closes, and the target is cleared', async () => {
  host.hold('render-5')
  await vi.waitFor(async () => { expect((await here.ask<{ queue: QueueSnapshot }>(`/api/compute/queue?host=${hostId}`)).body.queue.running?.id).toBe('render-5') })

  const unasked = await here.ask<{ ok: boolean; confirm: boolean }>('/api/compute/unpair', { host: hostId })
  expect(unasked).toMatchObject({ status: 409, body: { ok: false, confirm: true } })
  expect(await here.ask('/api/compute/unpair', { host: 'abcdefgh1234', confirm: true })).toMatchObject({ status: 404, body: { code: 'unpaired' } })
  expect((await here.ask('/api/compute/unpair', { host: hostId, confirm: true })).body).toEqual({ ok: true })

  // The job it was running there was told to stop before the link went.
  await vi.waitFor(() => { expect(host.scheduler.status('render-5')!.state).toBe('cancelled') })
  expect((await here.ask<{ hosts: HostView[]; selected: string }>('/api/compute/hosts')).body).toMatchObject({ hosts: [], selected: 'this' })
  expect(here.alexia.store.kvGet(CORE, HOSTS_KEY)).toEqual([])
  expect(here.alexia.store.kvGet(CORE, HINTS_KEY)).toEqual({})
  expect(here.alexia.store.kvGet(CORE, SHOWN_KEY)).toBe('this')
  // The saved target and the pin went with it; the mode stays, and nothing was chosen in its place.
  expect(here.alexia.store.kvGet(CORE, TARGET_KEY)).toBeNull()
  expect(pins(here.alexia.store).model).toBeUndefined()
  expect((await here.ask<State>('/api/state')).body.setup.mode).toBe('local')
  // The endpoint is off the allowlist: nothing can be opened to it any more.
  await expect(a.open(await b.identity(), 'control')).rejects.toMatchObject({ code: 'unpaired' })
  expect(await here.ask(`/api/compute/queue?host=${hostId}`)).toMatchObject({ status: 404, body: { code: 'unpaired' } })

  await vi.waitFor(() => { expect(host.hosts.list()).toEqual([]) })
  expect(await host.ask('/api/compute/pair/start', {})).toMatchObject({ status: 200, body: { pairing: { phase: 'waiting' } } })
})

test('revoking from the host: jobs are cancelled and the connection is closed at once', async () => {
  hostId = await pair()
  await vi.waitFor(async () => { expect((await here.ask<{ hosts: HostView[] }>('/api/compute/hosts')).body.hosts[0]).toMatchObject({ connection: 'direct', inventory: { name: 'Studio' } }) })
  host.hold('render-6')
  await vi.waitFor(() => { expect(host.scheduler.queue().running?.id).toBe('render-6') })

  expect((await host.ask('/api/compute/unpair', { host: controllerId, confirm: true })).body).toEqual({ ok: true })
  expect(host.scheduler.status('render-6')!.state).toBe('cancelled')
  expect(host.hosts.list()).toEqual([])
  await expect(a.open(await b.identity(), 'control')).rejects.toBeDefined()
  // The interaction computer keeps the record, and says why the host no longer serves it.
  await vi.waitFor(async () => {
    const [view] = (await here.ask<{ hosts: HostView[] }>('/api/compute/hosts')).body.hosts
    expect(view).toMatchObject({ host: { id: hostId }, failure: { code: expect.stringMatching(/^(unpaired|offline)$/) } })
  })
  expect((await here.ask('/api/compute/unpair', { host: hostId, confirm: true })).body).toEqual({ ok: true })
})

test('a pairing survives a restart, and switching the interaction computer’s role keeps its chats', async () => {
  hostId = await pair()
  // The record that matters: which identity was trusted, under which id. When it was last seen moves on.
  const said = [expect.objectContaining({ id: hostId, name: 'Studio', peerRole: 'compute', endpointId: await b.identity() })]
  // A real restart starts a new sidecar. The in-memory transport cannot be opened twice, so it is kept.
  const kept = vi.spyOn(a, 'close').mockResolvedValue(undefined)
  await here.close()
  kept.mockRestore()

  // The same data folder, started again: the record is read back and the endpoint allowed from the first moment.
  const again = await desk(a, here.root)
  expect(again.alexia.store.kvGet(CORE, HOSTS_KEY)).toEqual(said)
  await vi.waitFor(async () => {
    expect((await again.ask<{ hosts: HostView[] }>('/api/compute/hosts')).body.hosts[0]).toMatchObject({ host: { id: hostId }, connection: 'direct', inventory: { name: 'Studio' } })
  })

  // The conversation the answer above was given in.
  const conversations = again.alexia.store.conversations().length
  expect(conversations).toBeGreaterThan(0)
  expect((await again.ask('/api/compute/role', { role: 'interaction', confirm: true }))).toMatchObject({ status: 409, body: { ok: false } })
  expect((await again.ask<{ ok: boolean }>('/api/compute/role', { role: 'compute', confirm: true })).body.ok).toBe(true)
  await vi.waitFor(async () => { expect((await again.ask<{ switching?: { phase: string } }>('/api/compute/role')).body.switching?.phase).toBe('restarting') })
  expect(again.restart).toHaveBeenCalledTimes(1)
  expect(again.alexia.store.kvGet(CORE, ROLE_KEY)).toBe('compute')
  // The same database, untouched: the chats are where they were, and so is the pairing.
  expect(again.alexia.store.conversations().length).toBe(conversations)
  expect(again.alexia.store.kvGet(CORE, HOSTS_KEY)).toEqual(said)
})

test('scrub takes a path out of a sentence and leaves the rest of it alone', () => {
  expect(scrub('Could not read /home/sam/models/x.gguf: permission denied')).toBe('Could not read a file on that computer: permission denied')
  expect(scrub('C:\\Users\\sam\\weights.bin is missing')).toBe('a file on that computer is missing')
  expect(scrub('Fetch https://huggingface.co/test/model failed\nat /usr/lib/node')).toBe('Fetch https://huggingface.co/test/model failed')
  expect(scrub('test/model (Q4_K_M) needs 8 GB')).toBe('test/model (Q4_K_M) needs 8 GB')
})
