// SPDX-License-Identifier: AGPL-3.0-only
import { Manifest, MCP_PINNED, type ManifestInput } from '@alexia/protocol'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import { Artifacts } from '../src/compute/artifacts.js'
import { memoryConnect, type Connect } from '../src/compute/connect.js'
import { Controller } from '../src/compute/controller.js'
import { HOSTS_KEY, Hosts } from '../src/compute/hosts.js'
import { RemoteJobs } from '../src/compute/jobs.js'
import { ROLE_KEY } from '../src/compute/role.js'
import { computeServe, WINDOW_KEY, type ComputeServing } from '../src/compute/service.js'
import type { Shell, TrayAction } from '../src/compute/shell.js'
import type { JobSnapshot } from '../src/compute/types.js'
import { start } from '../src/entry.js'
import type { Machine } from '../src/machine.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve } from '../src/serve.js'
import { Store } from '../src/store.js'

/**
 * The compute role's service, started the way the app starts it: no assistant, the setup
 * page and `/api/compute/*` on loopback, the tray handled here, and nothing left running —
 * no timer while idle, no child process after it closes.
 */

// The interaction role's `serve()` is the whole assistant; here only *which one starts* is in question.
vi.mock('../src/serve.js', async (original) => ({
  ...await original<typeof import('../src/serve.js')>(),
  serve: vi.fn(async () => ({ url: 'http://127.0.0.1:1/', token: 'interaction', store: undefined, close: async () => {} })),
}))

const sdk = pathToFileURL(join(import.meta.dirname, '..', '..', 'sdk', 'dist', 'src', 'index.js')).href
const uiDir = join(import.meta.dirname, '..', '..', 'ui')
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function temp(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `alexia-compute-service-${name}-`))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  return root
}

const GB = 1024 ** 3
const hardware: Machine = {
  platform: 'linux', arch: 'x64', chip: 'Studio GPU box', appleSilicon: false, ramBytes: 64 * GB, freeRamBytes: 48 * GB,
  freeDiskBytes: 200 * GB, diskKnown: true, budgetBytes: 44 * GB, cpuCores: 16,
}

/** The desktop shell as a recorder, with a hand on its tray. */
function fakeShell() {
  const said: string[] = []
  const listeners = new Set<(action: TrayAction) => void>()
  const shell: Shell = {
    computeReady: (status) => { said.push(`compute ${status}`) },
    status: (line, paused) => { said.push(`status ${paused ? 1 : 0} ${line}`) },
    relaunch: () => { said.push('relaunch') },
    onTray: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { shell, said, listeners, click: (action: TrayAction) => { for (const listener of listeners) listener(action) } }
}

/** Write to a data folder's database before the service opens it. */
function seed(root: string, write: (store: Store) => void): void {
  const store = new Store(join(root, 'alexia.db'))
  try { write(store) } finally { store.close() }
}

/** A plugin with one compute operation that records its pid and then never finishes. */
function holdingPlugin(root: string) {
  const id = 'holding-worker'
  const dir = join(root, 'extensions', id)
  const pidFile = join(root, 'worker.pid')
  mkdirSync(dir, { recursive: true })
  const manifest = Manifest.parse({
    manifest_version: 1, id, name: 'Holding worker', summary: 'Holds a job until it is stopped.', version: '0.1.0',
    license: 'AGPL-3.0-only', entry: { run: 'node', args: ['index.mjs'] }, alexia_protocol: 13, mcp_protocol: MCP_PINNED,
    provides: ['demo.hold'], compute: { operations: [{ cap: 'demo.hold', summary: 'Never finish.' }] },
  } satisfies ManifestInput)
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'index.mjs'), `
import { writeFileSync } from 'node:fs'
import { plugin } from ${JSON.stringify(sdk)}
const alexia = plugin()
alexia.computeOperation('demo.hold', async () => {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
  await new Promise(() => {})
  return { files: [] }
})
await alexia.start()
`)
  return { id, pid: (): number | undefined => existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined }
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

const client = (serving: Pick<ComputeServing, 'url' | 'token'>) => async <T = Record<string, unknown>>(path: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const response = await fetch(new URL(path, serving.url), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-alexia-token': serving.token, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: response.status, body: parsed as T }
}

/** A compute host already paired with a controller on the other end of `memoryConnect()`. */
async function pairedHost(options: { plugin?: boolean } = {}) {
  const root = temp('studio')
  const { a, b } = memoryConnect()
  const [laptop, studio] = [await a.identity(), await b.identity()]
  await a.allow([studio])
  const plugin = options.plugin ? holdingPlugin(root) : undefined
  seed(root, (store) => {
    store.kvSet(CORE, ROLE_KEY, 'compute')
    new Hosts(store, 'compute').add({ name: 'Laptop', endpointId: laptop, peerRole: 'interaction' }, 1)
    if (plugin) store.kvSet(CORE, 'enabled', [plugin.id])
  })
  const fake = fakeShell()
  const service = await computeServe({ dataDir: root, uiDir, secrets: memorySecrets(), connect: b, shell: fake.shell, machine: async () => hardware })
  cleanups.push(() => service.close())
  cleanups.push(() => a.close())
  return { root, a, b, laptop, studio, plugin, fake, service, ask: client(service) }
}

test('start() in the compute role serves the setup page and /api/compute/*, and nothing of the assistant', async () => {
  const root = temp('entry-compute')
  vi.stubEnv('ALEXIA_CONNECT_BIN', join(root, 'no-such-sidecar'))
  seed(root, (store) => { store.kvSet(CORE, ROLE_KEY, 'compute') })

  // Every database call, by name: chats are rows in the same database, and nothing here may read one.
  const called = new Set<string>()
  for (const name of Object.getOwnPropertyNames(Store.prototype)) {
    const method = Object.getOwnPropertyDescriptor(Store.prototype, name)?.value as unknown
    if (name === 'constructor' || typeof method !== 'function') continue
    vi.spyOn(Store.prototype as unknown as Record<string, (...args: unknown[]) => unknown>, name).mockImplementation(function (this: Store, ...args: unknown[]) {
      called.add(name)
      return (method as (...args: unknown[]) => unknown).apply(this, args)
    })
  }
  // Nothing goes to the network on its own: no catalog poll, no provider list, no update check.
  const network = vi.spyOn(globalThis, 'fetch')

  const fake = fakeShell()
  const started = await start({ dataDir: root, uiDir, secrets: memorySecrets(), shell: fake.shell })
  cleanups.push(() => started.close())
  expect(started.role).toBe('compute')
  expect(serve).not.toHaveBeenCalled()
  const page = await fetch(started.url)
  const html = await page.text()
  expect(html).toContain('compute-setup.js')
  const token = /data-token="([^"]+)"/.exec(html)![1]!
  expect((await fetch(new URL('/compute-setup.js', started.url))).status).toBe(200)

  const ask = client({ url: started.url, token })
  expect((await ask('/api/compute/role')).body).toMatchObject({ role: 'compute', active: 0 })
  // No sidecar here: the page can say so, and pairing is refused rather than broken.
  expect((await ask('/api/compute/hosts')).body).toMatchObject({ hosts: [], available: false })
  expect((await ask('/api/state')).body).toMatchObject({ compute: { role: 'compute', available: false } })
  expect((await ask('/api/compute/pair/start', {})).status).toBe(409)
  // The assistant's routes are not here at all.
  for (const path of ['/api/sessions', '/api/chat', '/api/models', '/api/plugins']) expect((await ask(path)).status).toBe(404)
  // And a request without the token is turned away, as `serve.ts` turns it away.
  expect((await fetch(new URL('/api/compute/role', started.url))).status).toBe(403)

  expect([...called].filter((name) => !['kvGet', 'kvSet', 'close'].includes(name))).toEqual([])
  expect(network.mock.calls.map(([url]) => String(url)).filter((url) => !url.startsWith(started.url))).toEqual([])
  // Setup is not finished (nothing is paired), so the window stays.
  expect(fake.said.filter((line) => line.startsWith('compute '))).toEqual([])
})

test('start() reads the persisted role: no role, or interaction, starts serve()', async () => {
  const root = temp('entry-interaction')
  const fake = fakeShell()
  const started = await start({ dataDir: root, uiDir, port: 0, secrets: memorySecrets(), shell: fake.shell })
  expect(started).toMatchObject({ role: 'interaction', url: 'http://127.0.0.1:1/' })
  expect(serve).toHaveBeenCalledWith(expect.objectContaining({ dataDir: root, port: 0, compute: { shell: fake.shell } }))
  await started.close()
})

test('a paired host gives up its windows, keeps one for a launch after Open window, and reports status to the tray', async () => {
  const h = await pairedHost()
  // Paired: setup is finished, so the windows may go, with the status line the tray will show.
  expect(h.fake.said.filter((line) => line.startsWith('compute '))).toHaveLength(1)
  expect(h.fake.said.find((line) => line.startsWith('status 0 '))).toContain('Laptop')

  h.fake.click('pause')
  await vi.waitFor(async () => { expect((await h.ask<{ queue: { paused: boolean } }>('/api/compute/queue')).body.queue.paused).toBe(true) })
  expect(h.fake.said.at(-1)).toMatch(/^status 1 /)
  h.fake.click('resume')
  await vi.waitFor(async () => { expect((await h.ask<{ queue: { paused: boolean } }>('/api/compute/queue')).body.queue.paused).toBe(false) })
  expect(h.fake.said.at(-1)).toMatch(/^status 0 /)

  // The page's Close window is the same message as the tray's setup being done.
  expect((await h.ask('/api/compute/window/close', {})).status).toBe(200)
  expect(h.fake.said.filter((line) => line.startsWith('compute '))).toHaveLength(2)

  h.fake.click('unpair')
  await vi.waitFor(async () => { expect((await h.ask<{ hosts: unknown[] }>('/api/compute/hosts')).body.hosts).toEqual([]) })
})

test("the tray's Open window keeps the window for one launch and restarts with everything stopped", async () => {
  const h = await pairedHost()
  h.fake.click('window')
  await vi.waitFor(() => { expect(h.fake.said.at(-1)).toBe('relaunch') })
  await h.service.close()
  seed(h.root, (store) => { expect(store.kvGet(CORE, WINDOW_KEY)).toBe(true) })

  // The next launch keeps its window and spends the flag; the one after gives it up again.
  const once = fakeShell()
  const next = await computeServe({ dataDir: h.root, uiDir, secrets: memorySecrets(), connect: memoryConnect().b, shell: once.shell })
  expect(once.said.filter((line) => line.startsWith('compute '))).toEqual([])
  await next.close()
  seed(h.root, (store) => { expect(store.kvGet(CORE, WINDOW_KEY)).toBe(false) })
})

test("the tray's Switch role writes the interaction role after stopping, then relaunches; chats are untouched", async () => {
  const h = await pairedHost()
  h.fake.click('role')
  await vi.waitFor(() => { expect(h.fake.said.at(-1)).toBe('relaunch') }, { timeout: 5000 })
  await h.service.close()
  seed(h.root, (store) => {
    expect(store.kvGet(CORE, ROLE_KEY)).toBe('interaction')
    // The pairing record is the compute role's own and stays for a switch back.
    expect(store.kvGet(CORE, HOSTS_KEY)).toHaveLength(1)
  })
})

test('a running plugin job is stopped on close, and no child process or open handle is left', async () => {
  const before = process.getActiveResourcesInfo().filter((kind) => kind !== 'Timeout')
  const h = await pairedHost({ plugin: true })

  // The interaction computer's side, as `interaction.ts` builds it.
  const store = new Store(':memory:')
  const hosts = new Hosts(store, 'interaction')
  const host = hosts.add({ name: 'Studio', endpointId: h.studio, peerRole: 'compute' }, 1)
  const controller = new Controller({ connect: h.a, hosts, name: 'Laptop', appVersion: '1.0.0' })
  const jobs = new RemoteJobs({ controller, store })
  // The controller keeps waiting for a host that went away (it never resubmits), so the run is left to its own end.
  void jobs.run(host.id, { jobId: 'job-hold', cap: 'demo.hold', arguments: {}, inputs: [] }).catch(() => {})
  const said: JobSnapshot[] = []
  controller.onEvent((_hostId, event) => { if (event.event === 'job') said.push(event.job) })

  await vi.waitFor(() => { expect(h.plugin!.pid()).toBeDefined() }, { timeout: 60_000, interval: 50 })
  const pid = h.plugin!.pid()!
  expect(alive(pid)).toBe(true)

  await h.service.close()
  // Quitting stops every worker Alexia started: the plugin's process is gone.
  await vi.waitFor(() => { expect(alive(pid)).toBe(false) }, { timeout: 30_000, interval: 50 })
  // It was a running job, held by the worker's process, when the service quit.
  expect(said.filter((job) => job.id === 'job-hold').map((job) => job.state)).toContain('running')

  await controller.close()
  await h.a.close()
  store.close()
  await vi.waitFor(() => {
    const after = process.getActiveResourcesInfo().filter((kind) => kind !== 'Timeout')
    const count = (list: string[]): Record<string, number> => list.reduce<Record<string, number>>((all, kind) => ({ ...all, [kind]: (all[kind] ?? 0) + 1 }), {})
    const was = count(before)
    for (const [kind, n] of Object.entries(count(after))) expect(`${kind}: ${n}`).toBe(`${kind}: ${Math.min(n, was[kind] ?? 0)}`)
  }, { timeout: 15_000, interval: 100 })
}, 150_000)

/** The service, started under fake clocks, then left alone for five minutes. Returns the timers that exist and the ones armed meanwhile. */
async function idleFor5Minutes(root: string, connect: Connect) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  const service = await computeServe({ dataDir: root, uiDir, secrets: memorySecrets(), connect, shell: fakeShell().shell, machine: async () => hardware })
  cleanups.push(() => service.close())
  const pending = vi.getTimerCount()
  const armed = [vi.spyOn(globalThis, 'setTimeout'), vi.spyOn(globalThis, 'setInterval')]
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
  return { pending, armedMeanwhile: armed.reduce((sum, spy) => sum + spy.mock.calls.length, 0), left: vi.getTimerCount() }
}

test('idle for five minutes with nothing stored, the service has no timer at all', async () => {
  const root = temp('idle')
  seed(root, (store) => { store.kvSet(CORE, ROLE_KEY, 'compute') })
  expect(await idleFor5Minutes(root, memoryConnect().b)).toEqual({ pending: 0, armedMeanwhile: 0, left: 0 })
})

test('idle for five minutes with one stored artifact, the only timer is its expiry sweep', async () => {
  const root = temp('idle-artifact')
  seed(root, (store) => { store.kvSet(CORE, ROLE_KEY, 'compute') })
  const content = Buffer.from('an input')
  const earlier = new Artifacts({ dir: join(root, 'compute', 'jobs') })
  await earlier.put({ jobId: 'job-1', name: 'input.txt', mime: 'text/plain', bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') }, Readable.from([content]))
  earlier.claimed('job-1')
  expect(await idleFor5Minutes(root, memoryConnect().b)).toEqual({ pending: 1, armedMeanwhile: 0, left: 1 })
})
