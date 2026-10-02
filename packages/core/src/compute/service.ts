// SPDX-License-Identifier: AGPL-3.0-only
import { APP_VERSION } from '@alexia/protocol'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { refuse } from '../guard.js'
import { LlamaServer, llamaProvider } from '../llama.js'
import { LocalModels } from '../localModels.js'
import { LocalRunners } from '../localRunners.js'
import type { Machine } from '../machine.js'
import { MlxServer, mlxProvider } from '../mlx.js'
import { Plugins } from '../plugins.js'
import { CORE, keychain, type SecretStore } from '../secrets.js'
import { dataDir, Store } from '../store.js'
import { ComputeApi, hostModels, localPicker, RoleSwitching, savedServices } from './api.js'
import { Artifacts } from './artifacts.js'
import { binaryPath, connect as launch, type Connect } from './connect.js'
import { HostProtocol } from './hostProtocol.js'
import { Hosts } from './hosts.js'
import { Inventory } from './inventory.js'
import { Scheduler } from './scheduler.js'
import { Setup } from './setup.js'
import { noShell, shellPipe, type Shell, type TrayAction } from './shell.js'
import { ComputeError } from './types.js'
import { pluginWorkers, textWorker, Workers } from './workers.js'

/** `true` while the compute role should keep its window for one launch: set by *Open window*, spent by the next start. */
export const WINDOW_KEY = 'compute_window'

export interface ComputeServeOptions {
  dataDir?: string
  uiDir?: string
  port?: number
  secrets?: SecretStore
  pluginsDir?: string
  /** Injectable for tests: `memoryConnect().b`. */
  connect?: Connect
  shell?: Shell
  /** Where the sidecar is. Default: `binaryPath()`. Ignored when `connect` is given. */
  binary?: string
  /** What the hardware is, for a test. Default: the existing `machine()`, asked only at setup, preparation and admission. */
  machine?: () => Promise<Machine>
}
export interface ComputeServing { url: string; token: string; close(): Promise<void> }

/**
 * The shell's files the compute page needs, and nothing of the assistant's. `/` is the setup
 * page too, because the app opens its window at the root whichever role it is in.
 */
const STATIC: Record<string, [string, string]> = {
  '/': ['compute.html', 'text/html; charset=utf-8'],
  '/compute.html': ['compute.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/alexia.png': ['alexia.png', 'image/png'],
  '/alexia-mark.svg': ['alexia-mark.svg', 'image/svg+xml'],
}

/** Where the shell is: beside the bundle when packaged, or up from `src`/`dist/src` in the repo. */
function shellDir(): string {
  const candidates = ['ui', join('..', '..', '..', 'ui'), join('..', '..', '..', '..', 'ui')].map((up) => join(import.meta.dirname, up))
  return candidates.find((dir) => existsSync(join(dir, 'compute.html'))) ?? candidates[1]!
}

/** A transport that is not there: no sidecar on this computer. Nothing can reach it, and it can pair with nobody. */
function absent(): Connect {
  const gone = async (): Promise<never> => { throw new ComputeError('setup-required', 'The part of Alexia that connects two computers is not installed on this computer.') }
  return {
    identity: gone, open: gone, pairOpen: gone, pairJoin: gone,
    allow: async () => {}, accept: () => {}, state: () => 'offline', onState: () => () => {}, close: async () => {},
  }
}

async function body(request: IncomingMessage): Promise<string> {
  let raw = ''
  for await (const chunk of request) raw += String(chunk)
  return raw || '{}'
}

/**
 * **The compute role's whole service** (`docs/spec/remote-compute.md` §1.6): what a paired
 * computer needs to do work for its controller, and nothing of the assistant.
 *
 * `serve()` is never called in this role, so nothing it constructs exists here: no chat
 * history, no agents, no memory maintenance, no provider or catalog polling, no model tests,
 * no update checks and no hardware sampling on a timer. What is left waits for an event — a
 * stream from the paired controller, a tray click, a request from the setup page, a plugin
 * folder changing — and the only clocks are the ones those events arm: the scheduler's idle
 * stop, the reconnect grace, and the artifact store's expiry.
 *
 * Quitting or switching role stops the protocol, every job and worker, the runners, the
 * plugins and the sidecar, in that order, and leaves no child process. Chats are untouched:
 * they are rows in the same database, and nothing here reads them.
 */
export async function computeServe(options: ComputeServeOptions = {}): Promise<ComputeServing> {
  const root = options.dataDir ?? dataDir()
  const ui = options.uiDir ?? shellDir()
  const secrets = options.secrets ?? keychain
  const shell = options.shell ?? (process.env.ALEXIA_TAURI ? shellPipe() : noShell())
  const name = (): string => hostname().replace(/\.(local|lan|home)$/i, '')
  const store = new Store(join(root, 'alexia.db'))
  const token = randomUUID()

  // The host's own picker: the existing runners and models, for the operations a controller asks for by name.
  const llama = new LlamaServer({ dataDir: root })
  const mlx = new MlxServer({ dataDir: root })
  const runners = new LocalRunners(root, [
    { id: 'llama', server: llama, provider: llamaProvider(llama) },
    { id: 'mlx', server: mlx, provider: mlxProvider(mlx) },
  ])
  const localModels = new LocalModels({
    dataDir: root, store, server: llama, runners,
    hfToken: () => secrets.get(CORE, 'huggingface_token'),
    ...(options.machine && { machine: options.machine }),
  })

  // Plugins are read, never started: a worker's process is spawned by its first job. No sampling, no roots.
  const late: { workers?: Workers } = {}
  const plugins = new Plugins({
    dir: options.pluginsDir ?? join(root, 'extensions'), store, dataDir: root, secrets,
    log: (id, line) => console.error(`[${id}] ${line}`),
    onToolsChanged: () => late.workers?.changed(),
  })
  plugins.load()
  plugins.watch()

  const hosts = new Hosts(store, 'compute')
  let transport: Connect | undefined = options.connect
  if (!transport) {
    const binary = options.binary ?? binaryPath()
    // No sidecar, or one that would not start: the setup page says pairing is unavailable, and nothing else changes.
    if (binary !== undefined) {
      transport = await launch({ dataDir: root, role: 'compute', allow: hosts.allowlist(), services: savedServices(store), binary }).catch(() => undefined)
    }
  }
  const connect = transport ?? absent()
  await connect.allow(hosts.allowlist())

  const scheduler = new Scheduler()
  const text = textWorker({ dataDir: root, runners })
  const workers = late.workers = new Workers(text, () => pluginWorkers(plugins))
  workers.bind(scheduler)
  const artifacts = new Artifacts({ dir: join(root, 'compute', 'jobs') })
  // What a crash or an earlier run left behind goes now; the store arms its own expiry timer while anything is left.
  await artifacts.sweep().catch(() => 0)
  const inventory = new Inventory({ dataDir: root, name: name(), appVersion: APP_VERSION, workers, ...(options.machine && { machine: options.machine }) })
  const setup = new Setup({ workers, scheduler, artifacts, inventory })
  const protocol = new HostProtocol({
    connect, hosts, scheduler, workers, artifacts, inventory, setup, store,
    models: hostModels(localModels), name: name(), appVersion: APP_VERSION,
  })

  let status = { line: 'Alexia · Compute', paused: false }
  const unsubscribe = [protocol.onStatus((line, paused) => {
    status = { line, paused }
    shell.status(line, paused)
  })]
  protocol.start()

  /** Everything but the listener and the store, in the contract's order. Once, whoever asks first. */
  let stopping: Promise<void> | undefined
  const stopServices = (reason: 'quitting' | 'role-switch'): Promise<void> => stopping ??= (async () => {
    for (const off of unsubscribe.splice(0)) off()
    api.close()
    await protocol.close(reason).catch(() => {})
    await scheduler.close().catch(() => {})
    await localModels.close().catch(() => {})
    await runners.stop().catch(() => {})
    await plugins.stop().catch(() => {})
    inventory.close()
    await connect.close().catch(() => {})
  })()

  const roles = new RoleSwitching({
    store,
    active: () => { const queue = scheduler.queue(); return (queue.running ? 1 : 0) + queue.waiting.length },
    cancelActive: () => scheduler.cancelAll('cancelled'),
    stop: () => stopServices('role-switch'),
    // Under the app the whole app comes back, and `entry.ts` reads the new role; from a checkout the process ends.
    restart: () => { shell.relaunch() },
  })

  const api = new ComputeApi({
    role: 'compute', hosts, scheduler, protocol, roles, store, name, appVersion: APP_VERSION,
    ...(transport && { connect: transport }),
    available: () => transport !== undefined,
    inventory, setup, models: localPicker(localModels),
    token: async (secret) => { if (secret === '') await secrets.delete(CORE, 'huggingface_token'); else await secrets.set(CORE, 'huggingface_token', secret) },
    closeWindow: () => { shell.computeReady(status.line) },
  })

  // The tray, which in this role has no page behind it to ask.
  const tray = async (action: TrayAction): Promise<void> => {
    switch (action) {
      case 'pause': protocol.pause(true); return
      case 'resume': protocol.pause(false); return
      case 'unpair': await protocol.revoke(); return
      case 'role': roles.request('interaction'); return
      case 'window':
        // Kept for one launch, and the app brought back with its windows. Stopped first, so a restart that kills core leaves nothing behind.
        store.kvSet(CORE, WINDOW_KEY, true)
        await stopServices('quitting')
        shell.relaunch()
    }
  }
  unsubscribe.push(shell.onTray((action) => { void tray(action).catch((error: unknown) => { console.error(`compute: the tray's ${action} failed: ${String(error)}`) }) }))

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
      response.end(String(error))
    })
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const target = request.url ?? '/'
    const url = new URL(`http://127.0.0.1${target.startsWith('/') ? target : `/${target}`}`)
    // The setup page's compiled modules, by name only: no dots, no slashes, nothing to climb out with.
    const module = /^\/([a-z][a-z0-9-]*)\.js$/.exec(url.pathname)
    const asset = STATIC[url.pathname] ?? (module ? ([join('dist', 'src', `${module[1]!}.js`), 'text/javascript; charset=utf-8'] as const) : undefined)
    if (asset && existsSync(join(ui, asset[0]))) {
      const [file, type] = asset
      const bytes = readFileSync(join(ui, file))
      response.writeHead(200, { 'content-type': type })
      response.end(type.startsWith('text/') ? bytes.toString('utf8').replace('__TOKEN__', token) : bytes)
      return
    }

    // The same check `serve.ts` makes: this computer's page, on loopback, and nobody else.
    if (request.headers['x-alexia-token'] !== token || !(request.headers.host ?? '').startsWith('127.0.0.1')) {
      response.writeHead(403, { 'content-type': 'text/plain' })
      response.end('not for you')
      return
    }
    let sent: Record<string, unknown> = {}
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try {
        const parsed: unknown = JSON.parse(await body(request))
        if (typeof parsed === 'object' && parsed !== null) sent = parsed as Record<string, unknown>
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, said: 'That request body is not JSON.' }))
        return
      }
    }
    // The guard first, as `serve.ts` runs it: the confirm on a role switch or an unpair is asked here, before any route.
    const refusal = refuse(url.pathname, request.method ?? 'GET', sent)
    if (refusal) {
      response.writeHead(refusal.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, said: refusal.said, ...(refusal.confirmable && { confirm: true }) }))
      return
    }
    if (url.pathname === '/api/state' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ compute: api.state() }))
      return
    }
    if (await api.handle(request, response, url, sent)) return
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, said: 'There is no such page on a computer that does the computing.' }))
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  // The window stays while setup needs it: nothing paired yet, or *Open window* asked for one launch of it.
  const keep = store.kvGet(CORE, WINDOW_KEY) === true
  if (keep) store.kvSet(CORE, WINDOW_KEY, false)
  else if (hosts.list().some((host) => host.peerRole === 'interaction')) shell.computeReady(status.line)

  let closing: Promise<void> | undefined
  return {
    url: `http://127.0.0.1:${port}/`,
    token,
    close: () => closing ??= (async () => {
      await stopServices('quitting')
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      store.close()
    })(),
  }
}
