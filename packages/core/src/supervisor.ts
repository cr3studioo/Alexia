// SPDX-License-Identifier: AGPL-3.0-only
import {
  ALEXIA_METHODS,
  MCP_REVISIONS,
  mcpRefusal,
  versionVerdict,
  type AlexiaMethod,
  type AlexiaParams,
  type Manifest,
} from '@alexia/protocol'
import {
  Client,
  UnsupportedProtocolVersionError,
  type CallToolRequestOptions,
  type CallToolResult,
  type CreateMessageRequestParams,
  type CreateMessageResult,
  type Root,
  type StandardSchemaV1,
  type Tool,
} from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { Readable } from 'node:stream'
import { createInterface } from 'node:readline'
import { negotiate } from './handshake.js'

/**
 * One supervised plugin process.
 *
 * The whole of M0 rests on this file: a plugin runs in a separate process precisely so it
 * can crash, hang, leak, or have its folder deleted underneath it without core noticing
 * anything worse than a tool going away. Everything here exists to make that true — lazy
 * spawn, a heartbeat, bounded restarts, and an idle plugin that is simply not running.
 *
 * What it deliberately does not do is know *which* plugin this is. It is handed a manifest
 * and a directory by the loader and behaves identically for every one of them.
 */

export const ALEXIA_VERSION = '0.1.0'

/** Core, as the plugin sees it in `clientInfo`. Not the name the user renamed Alexia to. */
const HOST = { name: 'Alexia', version: ALEXIA_VERSION } as const

export interface HostServices {
  /**
   * A plugin asked for the model. The router lands at M1-8; at M0 this is a stub. The
   * plugin id travels with it so the spend lands on whoever spent it.
   */
  sampling(pluginId: string, params: CreateMessageRequestParams): Promise<CreateMessageResult>
  /** The folders the user has put in scope. A fixed stub at M0. */
  roots(pluginId: string): Root[] | Promise<Root[]>
  /** One line the plugin wrote to stderr. stdout is the wire; stderr is the log. */
  log?(pluginId: string, line: string): void
  /**
   * This plugin's tools changed — it published a new list, or it stopped existing. Either
   * way, whatever was planning around them re-plans instead of calling a tool that is no
   * longer there (invariant 4).
   */
  toolsChanged?(pluginId: string): void
  /** Stopped too often to keep restarting. One line for the user, and a Restart button. */
  unhealthy?(pluginId: string, message: string): void
  /**
   * Answer an `alexia/*` request. Params arrive already parsed against the wire schema, so
   * this never sees a shape a plugin made up. Absent means core offers no Alexia layer and
   * a plugin asking gets `-32601`, which is the honest answer.
   */
  alexia?<M extends AlexiaMethod>(pluginId: string, method: M, params: AlexiaParams<M>): Promise<unknown>
}

/** Every timeout in one place, so a test can run the five-minute ones in milliseconds. */
export interface Timings {
  /** Spawn to answering `server/discover`. The spec's budget is 2 s; this is the ceiling. */
  startMs: number
  /** `ping` interval, and the time a plugin has to answer one before it is killed. */
  heartbeatMs: number
  /** How long a `tools/call` may take before the caller gets an error instead of a hang. */
  callMs: number
  /** No traffic for this long and the process exits. The next call brings it back. */
  idleMs: number
  /** First restart delay. Doubles per consecutive failure, up to `maxBackoffMs`. */
  backoffMs: number
  maxBackoffMs: number
  /** `crashLimit` stops inside `crashWindowMs` and the plugin is switched off. */
  crashWindowMs: number
  crashLimit: number
}

export const DEFAULT_TIMINGS: Timings = {
  startMs: 10_000,
  heartbeatMs: 15_000,
  callMs: 120_000,
  idleMs: 5 * 60_000,
  backoffMs: 500,
  maxBackoffMs: 30_000,
  crashWindowMs: 60_000,
  crashLimit: 3,
}

export type PluginState = 'stopped' | 'running' | 'unhealthy'

/** Thrown to a caller whose plugin is switched off. Carries the sentence the user reads. */
export class PluginUnavailable extends Error {}

interface Session {
  client: Client
  transport: StdioClientTransport
  /** Set the moment this session stops being the current one, so its handlers go quiet. */
  done: boolean
  /**
   * One process death is one crash. The SDK closes the transport inside its own failed
   * `connect()`, so `onclose` and the `catch` below can both see the same death — without
   * this flag a plugin that dies on start counts double and hits the limit an attempt early.
   */
  counted: boolean
}

export class PluginProcess {
  #session?: Session
  #starting?: Promise<Session>
  #state: PluginState = 'stopped'
  #reason?: string
  /** Stop times inside the window. Three is the limit, and the window slides. */
  #crashes: number[] = []
  #inFlight = 0
  #idleTimer?: NodeJS.Timeout
  #heartbeat?: NodeJS.Timeout
  #retry?: NodeJS.Timeout

  constructor(
    readonly manifest: Manifest,
    /** The plugin's own folder: its working directory, and the root of its relative paths. */
    readonly dir: string,
    private readonly host: HostServices,
    private readonly t: Timings = DEFAULT_TIMINGS,
  ) {}

  get id(): string {
    return this.manifest.id
  }

  get state(): PluginState {
    return this.#state
  }

  /** Why it is off, in the words the user is shown. Only set when `state` is unhealthy. */
  get reason(): string | undefined {
    return this.#reason
  }

  /** The process id, or nothing when nothing is running — which is most of the time. */
  get pid(): number | null | undefined {
    return this.#session?.transport.pid
  }

  /** What this plugin can do right now. Spawns it if it is not running. */
  async listTools(): Promise<Tool[]> {
    const { client } = await this.#ready()
    return this.#track(async () => (await client.listTools()).tools)
  }

  async callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: CallToolRequestOptions,
  ): Promise<CallToolResult> {
    const { client } = await this.#ready()
    return this.#track(() =>
      client.callTool({ name, arguments: args }, { timeout: this.t.callMs, ...options }),
    )
  }

  /** The *Restart* button. Clears the crash tally; the next call spawns again. */
  restart(): void {
    this.#crashes = []
    this.#state = 'stopped'
    this.#reason = undefined
  }

  /** Deliberate shutdown — idle, disabled, or Alexia quitting. Never counted as a crash. */
  async stop(): Promise<void> {
    clearTimeout(this.#retry)
    const session = this.#take()
    if (!session) return
    await session.transport.close().catch(() => {})
  }

  // ---- the machinery -------------------------------------------------------------------

  /** Lazy spawn: nothing runs until something is actually asked of it. */
  async #ready(): Promise<Session> {
    if (this.#state === 'unhealthy') throw new PluginUnavailable(this.#reason)
    if (this.#session) return this.#session
    this.#starting ??= this.#spawn()
    try {
      return await this.#starting
    } finally {
      this.#starting = undefined
    }
  }

  async #spawn(): Promise<Session> {
    // Check two, ours, read off the manifest — before anything is spawned, so a plugin
    // written for a newer Alexia never gets a process at all (wire-protocol.md 3.3).
    const declared = versionVerdict(this.manifest)
    if (!declared.ok) throw this.#off(declared.reason)

    // `"run": "node"` means *Alexia's* Node — the one the user never had to install.
    const command = this.manifest.entry.run === 'node' ? process.execPath : this.manifest.entry.run
    const transport = new StdioClientTransport({
      command,
      args: this.manifest.entry.args,
      cwd: this.dir,
      stderr: 'pipe',
    })

    const client = new Client(HOST, {
      // At M0 core can answer for the model and for the folder scope. It cannot yet ask the
      // user anything, so it does not claim `elicitation`: a plugin that checks, as the
      // spec tells it to, correctly finds it missing.
      capabilities: { roots: {}, sampling: {} },
      // `auto`, not a pin: the window is two revisions wide and they are two different
      // wire eras. A plugin built on `@alexia/sdk` serves `2025-11-25` and lands here on
      // the era where it can call back into core; a third-party MCP server that speaks only
      // `2026-07-28` connects too, and simply has no `alexia/*` layer. Checked below.
      supportedProtocolVersions: [...MCP_REVISIONS],
      versionNegotiation: { mode: 'auto' },
      listChanged: { tools: { onChanged: () => this.host.toolsChanged?.(this.id) } },
    })
    client.setRequestHandler('sampling/createMessage', (request) =>
      this.host.sampling(this.id, request.params),
    )
    client.setRequestHandler('roots/list', async () => ({ roots: await this.host.roots(this.id) }))

    // The `alexia/*` layer, straight off the protocol package's table: one handler per
    // method, each parsing untrusted plugin params against the schema that documents them.
    const alexia = this.host.alexia?.bind(this.host)
    if (alexia) {
      // The table is keyed by method, so params and method agree by construction. Saying
      // that to a `for` loop costs one widening: the schemas still parse, the types stop
      // trying to intersect twelve unrelated results.
      const methods = Object.entries(ALEXIA_METHODS) as [
        AlexiaMethod,
        { params: StandardSchemaV1; result: StandardSchemaV1 },
      ][]
      for (const [method, schemas] of methods) {
        client.setRequestHandler(method, schemas, (params) =>
          alexia(this.id, method, params as AlexiaParams<AlexiaMethod>),
        )
      }
    }

    const session: Session = { client, transport, done: false, counted: false }
    client.onclose = () => this.#onClose(session)
    client.onerror = (error) => this.host.log?.(this.id, `[core] ${error.message}`)

    try {
      // ponytail: the SDK probes `server/discover` on a throwaway sibling process, so a
      // cold start spawns twice. If the spec's 2 s spawn-to-live budget bites, cache the
      // DiscoverResult and pass it as `connect({ prior })` — measure at M2, with voice.
      await client.connect(transport, { timeout: this.t.startMs })
    } catch (error) {
      session.done = true
      await transport.close().catch(() => {})
      throw this.#failed(session, startupRefusal(this.manifest.name, error))
    }

    // The plugin is up. Now: are we speaking a revision core actually knows? The manifest
    // said so before the spawn; this is the same question asked of the running process.
    const spoken = client.getDiscoverResult()?.supportedVersions ?? [
      client.getNegotiatedProtocolVersion() ?? '',
    ]
    const verdict = negotiate(this.manifest, spoken)
    if (!verdict.ok) {
      session.done = true
      await transport.close().catch(() => {})
      // Not a crash: restarting it cannot make it speak a different version of MCP.
      throw this.#off(verdict.reason)
    }

    if (transport.stderr) {
      // The transport types its pipe as the general `Stream`; with `stderr: 'pipe'` it is a
      // readable one.
      createInterface({ input: transport.stderr as Readable }).on('line', (line) =>
        this.host.log?.(this.id, line),
      )
    }

    this.#session = session
    this.#state = 'running'
    this.#crashes = []
    this.#heartbeat = setInterval(() => void this.#beat(session), this.t.heartbeatMs).unref()
    this.#touch()
    return session
  }

  /** A hung plugin must never hang the chat: miss one ping and the process is killed. */
  async #beat(session: Session): Promise<void> {
    try {
      await session.client.ping({ timeout: this.t.heartbeatMs })
    } catch {
      if (session.done) return
      this.host.log?.(this.id, '[core] stopped answering, killing it')
      this.#take()
      // Not awaited: closing a wedged process takes seconds and nothing is waiting on it.
      void session.transport.close().catch(() => {})
      this.#crashed(session)
    }
  }

  /** The process went away on its own: crashed, was killed, or its folder was deleted. */
  #onClose(session: Session): void {
    if (session.done) return
    session.done = true
    if (this.#session === session) {
      this.#session = undefined
      this.#clearTimers()
    }
    this.#crashed(session)
  }

  #crashed(session: Session): void {
    if (session.counted) return
    session.counted = true
    const now = Date.now()
    this.#crashes = this.#crashes.filter((at) => now - at < this.t.crashWindowMs)
    this.#crashes.push(now)
    // Its tools went with it. Whatever was planning around them re-plans.
    this.host.toolsChanged?.(this.id)

    if (this.#crashes.length >= this.t.crashLimit) {
      this.#off(
        `${this.manifest.name} stopped ${this.t.crashLimit} times in a minute, so Alexia has switched it off.\n` +
          `Everything else is still running.`,
      )
      return
    }
    this.#state = 'stopped'
    // Exponential backoff, so a plugin that dies on start does not spin the CPU doing it.
    const wait = Math.min(this.t.backoffMs * 2 ** (this.#crashes.length - 1), this.t.maxBackoffMs)
    clearTimeout(this.#retry)
    this.#retry = setTimeout(() => void this.#ready().catch(() => {}), wait).unref()
  }

  /** Switched off until a human presses Restart. Returns the error callers are given. */
  #off(reason: string): PluginUnavailable {
    this.#state = 'unhealthy'
    this.#reason = reason
    this.#clearTimers()
    clearTimeout(this.#retry)
    this.host.unhealthy?.(this.id, reason)
    return new PluginUnavailable(reason)
  }

  /** A start that never got as far as a working session. Counts against the crash tally. */
  #failed(session: Session, message: string): Error {
    this.host.log?.(this.id, `[core] ${message}`)
    this.#crashed(session)
    return this.#state === 'unhealthy' ? new PluginUnavailable(this.#reason) : new Error(message)
  }

  /** Detach the current session so its handlers stop counting, and hand it back. */
  #take(): Session | undefined {
    const session = this.#session
    if (!session) return undefined
    session.done = true
    this.#session = undefined
    this.#state = 'stopped'
    this.#clearTimers()
    return session
  }

  #clearTimers(): void {
    clearInterval(this.#heartbeat)
    clearTimeout(this.#idleTimer)
    this.#heartbeat = undefined
    this.#idleTimer = undefined
  }

  /** Idle shutdown: quiet for long enough and the process exits, invisibly. */
  #touch(): void {
    clearTimeout(this.#idleTimer)
    if (this.#inFlight > 0 || !this.#session) return
    this.#idleTimer = setTimeout(() => void this.stop(), this.t.idleMs).unref()
  }

  async #track<T>(work: () => Promise<T>): Promise<T> {
    this.#inFlight++
    this.#touch()
    try {
      return await work()
    } finally {
      this.#inFlight--
      this.#touch()
    }
  }
}

/** What the user is told when a plugin could not be started at all. */
function startupRefusal(name: string, error: unknown): string {
  // The MCP revisions did not overlap. Same sentence as the manifest check, same words.
  if (error instanceof UnsupportedProtocolVersionError) {
    return mcpRefusal(name, error.supported.join(', '))
  }
  return `${name} didn't start: ${error instanceof Error ? error.message : String(error)}`
}
