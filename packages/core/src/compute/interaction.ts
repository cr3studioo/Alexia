// SPDX-License-Identifier: AGPL-3.0-only
import { APP_VERSION, PREVIEW_META } from '@alexia/protocol'
import { mkdirSync, realpathSync } from 'node:fs'
import { hostname } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Model } from '../catalog.js'
import type { Ran } from '../commands.js'
import type { Plugins, PluginsOptions } from '../plugins.js'
import type { Provider } from '../provider.js'
import type { Store } from '../store.js'
import { cleanTarget, ComputeApi, hintStore, RoleSwitching, savedServices, scrub } from './api.js'
import { Bridge, REMOTE } from './bridge.js'
import { binaryPath, connect as launch, type Connect } from './connect.js'
import { Controller } from './controller.js'
import { Hosts } from './hosts.js'
import { RemoteJobs } from './jobs.js'
import { Operations } from './operations.js'
import { PREVIEW_MAX_CHARS } from './protocol.js'
import { rememberModels, remoteModels, seenModels, selectedHost } from './target.js'
import { ComputeError, parseCatalogId, previewOf, THIS_HOST, type ExecutionTarget, type RunProgress, type TargetStatus } from './types.js'
import { Link, type LinkDeps } from './link.js'
import { Tailscale } from './tailscale.js'

export type { Connect } from './connect.js'

/** How long startup waits for the sidecar before carrying on without it. It is still adopted when it arrives. */
const BOOT_MS = 3000

export interface InteractionOptions {
  store: Store
  dataDir: string
  /** Tailscale, and finding the other computer through it. `false` for none; an object to stand in for parts. */
  link?: false | { tailscale?: LinkDeps['tailscale']; port?: number }
  plugins: Plugins
  /** A task, a reply or a model operation on this computer. */
  busy(): boolean
  /** Stop everything this computer runs, leaving the store open: a role switch writes the role after it. */
  stop(): Promise<void>
  /** Injectable for tests: one end of `memoryConnect()`. Absent, the sidecar is looked for and spawned. */
  connect?: Connect
  /** The desktop shell (`compute/shell.ts`). Only `relaunch` is used here. */
  shell?: { relaunch(): void }
  /** Cancel what `busy()` counts. Called only when a role switch was asked to cancel. */
  cancel?(): void | Promise<void>
  /** Choose a paired computer's model: `ModeTransitions.request`. */
  activate?(mode: 'local', id: string): Ran
  /** The folders the person put in scope. A plugin may send a paired computer a file from one of them, from its own directory, or one the person attached. */
  roots?(): { uri: string }[]
  /** Come back in the role just written. Default: `shell.relaunch()`, or leave the process when there is no shell. */
  restart?(): void
  /** What this computer calls itself to a paired one. Default: its host name. */
  name?(): string
  /** Where the sidecar is. Default: `binaryPath()`. */
  binary?: string
}

/** Everything `serve.ts` needs, behind one constructor. */
export interface InteractionCompute {
  api: ComputeApi
  provider: Provider                     // remoteProvider(bridge)
  models(): Model[]                      // remoteModels(controller.views(), selectedHost(store), seenModels)
  remote: Pick<Bridge, 'select' | 'deselect' | 'status'> & Pick<Controller, 'ensure' | 'views'> & { hostName(hostId: string): string | undefined }
  operations: Operations
  /** `PluginsOptions.compute`: one of the calling plugin's operations, run where the person chose. */
  run: NonNullable<PluginsOptions['compute']>
  active(): number
  close(): Promise<void>
}

/** A transport that is not there. Every paired host reads as offline, and nothing can be opened. */
function absent(): Connect {
  const gone = async (): Promise<never> => { throw new ComputeError('offline', 'That computer cannot be reached: the part of Alexia that connects two computers is not running.') }
  return {
    identity: gone, open: gone, pairOpen: gone, pairJoin: gone,
    allow: async () => {}, accept: () => {}, state: () => 'offline', onState: () => () => {}, close: async () => {},
  }
}

/**
 * The words core uses when it has no compute seam at all. A plugin that hears them (with
 * `CAPABILITY_NOT_AVAILABLE`) runs the job in its own process, which is right only when there
 * was never another computer to choose. Nothing a paired computer's refusal says may read so.
 */
const NO_COMPUTE = /compute is not available/gi

/**
 * What a plugin is told when its operation did not run on the paired computer the person
 * chose: that computer's own named state, as a `ComputeError` — never a protocol error, whose
 * code a plugin could take as leave to do the work here instead.
 */
export function chosenHostRefusal(error: unknown): ComputeError {
  const message = scrub(error instanceof Error ? error.message : String(error)).replace(NO_COMPUTE, 'that computer cannot run it')
  return new ComputeError(error instanceof ComputeError ? error.code : 'worker-failure', message || 'The paired computer could not run that.')
}

interface Live { transport?: Connect; controller: Controller; jobs: RemoteJobs; bridge: Bridge; operations: Operations }

const within = (dir: string, path: string): boolean => {
  const from = relative(dir, path)
  return from !== '' && from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from)
}

/**
 * **Remote compute on the interaction computer**: the paired hosts, the sessions with them,
 * the bridge a remote model answers through, and the routes the screen calls.
 *
 * **It never throws for a missing sidecar.** With no binary, `available` is false, pairing
 * answers `setup-required`, a host paired earlier stays listed as offline, and everything
 * else in Alexia behaves as it did before any of this existed. The sidecar is started at
 * launch only when a computer is already paired; otherwise the first pairing starts it, so
 * an installation that never pairs never runs it.
 */
export async function interactionCompute(options: InteractionOptions): Promise<InteractionCompute> {
  const { store, plugins } = options
  const hosts = new Hosts(store, 'interaction')
  const hints = hintStore(store)
  const name = options.name ?? (() => hostname().replace(/\.(local|lan|home)$/i, ''))
  const binary = options.connect ? undefined : options.binary ?? binaryPath()
  let closed = false
  let running = 0
  /** Who is listening to a run on this computer, by the signal the run was started with. */
  const hearing = new WeakMap<AbortSignal, (progress: RunProgress) => void>()
  /** The sidecar is here and would not start. Pairing is not offered until a start works. */
  let broken = false

  /** This computer's own worker for a capability, found by what it declares and never by who it is. */
  const local: ConstructorParameters<typeof Operations>[0]['local'] = async (cap, args, signal) => {
    const worker = plugins.computeWorkers().find((one) => one.operations.some((op) => op.cap === cap))
    if (!worker) throw new ComputeError('setup-required', 'Nothing installed on this computer can run that.')
    // On core's clock, not MCP's sixty seconds: the job ends when it ends, or when its signal says so.
    const heard = signal && hearing.get(signal)
    return plugins.computeCall(worker.handle, 'run', { cap, arguments: args }, {
      timeout: 24 * 60 * 60 * 1000, ...(signal && { signal }),
      ...(heard && {
        onprogress: (update) => {
          const { progress, total, message } = update
          // On this computer the picture so far goes straight to whoever asked, never through a queue.
          const shown = previewOf((update as { _meta?: Record<string, unknown> })._meta?.[PREVIEW_META], PREVIEW_MAX_CHARS)
          heard({ progress, ...(total !== undefined && { total }), ...(message !== undefined && { message }), ...(shown && { preview: `data:${shown.mime};base64,${shown.data}` }) })
        },
      }),
    })
  }

  const build = (transport?: Connect): Live => {
    const late: { jobs?: RemoteJobs } = {}
    const controller = new Controller({
      connect: transport ?? absent(), hosts, name: name(), appVersion: APP_VERSION, hints,
      resume: (hostId) => late.jobs?.outstanding(hostId) ?? [],
      keep: (hostId) => selectedHost(store) === hostId,
    })
    // What a host holds outlives its session (`remoteModels`): kept as it is heard.
    controller.onEvent((hostId, event) => { if (event.event === 'inventory') rememberModels(store, hostId, event.inventory.models) })
    const jobs = late.jobs = new RemoteJobs({ controller, store })
    return { ...(transport && { transport }), controller, jobs, bridge: new Bridge({ controller }), operations: new Operations({ store, jobs, controller, local }) }
  }
  const retire = async (old: Live): Promise<void> => {
    await old.bridge.close().catch(() => {})
    await old.controller.close().catch(() => {})
  }

  // Until a transport is running, the same objects over one that is not there.
  let live = build()
  let starting: Promise<Connect | undefined> | undefined
  const start = (): Promise<Connect | undefined> => starting ??= (async () => {
    let transport = options.connect
    try {
      if (transport) await transport.allow(hosts.allowlist())
      else if (binary !== undefined) transport = await launch({ dataDir: options.dataDir, role: 'interaction', allow: hosts.allowlist(), services: savedServices(store), binary })
    } catch {
      // A sidecar that would not start. Asked again by the next pairing, not on a timer.
      starting = undefined
      broken = true
      return undefined
    }
    if (!transport) return undefined
    if (closed) { await transport.close().catch(() => {}); return undefined }
    broken = false
    const old = live
    live = build(transport)
    await retire(old)
    // What a restart left unanswered: ask each host how its jobs ended. Asking is never running them again.
    // And the computer whose model is chosen: its session is what keeps its models listed and its state current.
    const chosen = selectedHost(store)
    for (const host of hosts.list()) if (host.id === chosen || live.jobs.outstanding(host.id).length > 0) void live.controller.ensure(host.id).catch(() => {})
    return transport
  })()
  // A paired computer is the only reason to run the sidecar before somebody asks for a pairing.
  const boot: Promise<unknown> = options.connect || (binary !== undefined && hosts.list().length > 0) ? start() : Promise.resolve()
  const settled = boot.then(() => {}, () => {})
  let timer: NodeJS.Timeout | undefined
  await Promise.race([settled, new Promise<void>((resolve) => { timer = setTimeout(resolve, BOOT_MS); timer.unref() })])
  clearTimeout(timer)

  const active = (): number => (running > 0 ? running : options.busy() ? 1 : 0)
  const roles = new RoleSwitching({
    store,
    active,
    cancelActive: async () => { await options.cancel?.() },
    stop: async () => {
      // Sessions say goodbye before the services under them stop; the store stays open for the role to be written.
      await shut()
      await options.stop()
    },
    restart: options.restart ?? (() => { if (options.shell) options.shell.relaunch(); else process.exit(0) }),
  })

  // A transport handed in is a test's or a harness's: it gets no real Tailscale unless one is handed in too.
  const link = options.link === false || (options.link === undefined && options.connect !== undefined) ? undefined : new Link({
    ...(options.link?.port !== undefined && { port: options.link.port }),
    role: 'interaction', tailscale: options.link?.tailscale ?? new Tailscale({ downloads: join(options.dataDir, 'downloads') }), connect: () => live.transport,
    hosts, hints, name,
  })
  link?.start()

  const api = new ComputeApi({
    // `serve()` is the interaction service: in the compute role it is never called.
    ...(link && { link }),
    role: 'interaction', hosts, roles, store, hints, name, appVersion: APP_VERSION,
    get connect() { return live.transport },
    get controller() { return live.controller },
    get bridge() { return live.bridge },
    get jobs() { return live.jobs },
    ready: () => settled,
    start,
    available: () => live.transport !== undefined || (binary !== undefined && !broken),
    active,
    ...(options.activate && { activate: options.activate }),
  })

  const said = (status: TargetStatus): TargetStatus => cleanTarget(status)
  /** A failure from a host, with no path of that host left in its sentence. */
  const clean = (error: unknown): unknown => error instanceof ComputeError ? new ComputeError(error.code, scrub(error.message)) : error
  const approved = (pluginId: string, path: string): boolean => {
    let real: string
    try { real = realpathSync(path) } catch { return false }
    // Its own directory, what the person attached to a message, and the folders they put in scope.
    const dirs = [plugins.ownDir(pluginId), join(options.dataDir, 'uploads'), ...(options.roots?.() ?? []).flatMap((root) => { try { return [fileURLToPath(root.uri)] } catch { return [] } })]
    return dirs.some((dir) => { try { return within(realpathSync(dir), real) } catch { return false } })
  }

  let shutting: Promise<void> | undefined
  const shut = (): Promise<void> => shutting ??= (async () => {
    closed = true
    link?.close()
    api.close()
    await settled
    await retire(live)
    await live.transport?.close().catch(() => {})
  })()

  return {
    api,
    provider: { ...REMOTE, prepare: async (model, signal) => { await settled; return live.bridge.prepare(parseCatalogId(model), signal) } },
    models: () => remoteModels(live.controller.views(), selectedHost(store), (hostId) => seenModels(store, hostId)),
    remote: {
      ensure: async (hostId, signal) => {
        await settled
        try { await live.controller.ensure(hostId, signal) } catch (error) { throw clean(error) }
      },
      views: () => live.controller.views(),
      select: async (target: ExecutionTarget, signal: AbortSignal, onStatus?: (status: TargetStatus) => void) => {
        await settled
        try { return await live.bridge.select(target, signal, onStatus && ((status) => { onStatus(said(status)) })) }
        catch (error) { throw clean(error) }
      },
      deselect: () => live.bridge.deselect(),
      status: () => { const status = live.bridge.status(); return status && said(status) },
      hostName: (hostId) => hosts.get(hostId)?.name,
    },
    get operations() { return live.operations },
    run: async (pluginId, params, signal, onProgress) => {
      const inputs = params.inputs ?? []
      // Read once, before anything is awaited: what may be sent, and how a failure is told, depend on where the job goes.
      const elsewhere = selectedHost(store) !== THIS_HOST
      // The host never asks for a file, and a plugin may send it only one it was given leave to read.
      // A job that runs on this computer moves no file, so there is nothing to approve.
      const refused = elsewhere ? inputs.find((file) => !approved(pluginId, file.path)) : undefined
      if (refused) throw new ComputeError('refused', `${refused.name} is not a file this plugin may send to another computer.`)
      const toDir = plugins.ownDir(pluginId)
      mkdirSync(toDir, { recursive: true })
      running++
      if (signal && onProgress) hearing.set(signal, onProgress)
      try {
        await settled
        return await live.operations.run({ cap: params.cap, args: params.arguments ?? {}, inputs, toDir }, { ...(signal && { signal }), ...(onProgress && { onProgress }) })
      } catch (error) { throw elsewhere ? chosenHostRefusal(error) : clean(error) }
      finally {
        running--
        if (signal) hearing.delete(signal)
      }
    },
    active: () => running,
    close: shut,
  }
}
