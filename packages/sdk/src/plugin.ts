// SPDX-License-Identifier: Apache-2.0
import {
  ALEXIA_METHODS,
  CAPABILITY_CALL_MS,
  MCP_PINNED,
  CONVERSATION_ENDED,
  ConversationEnded,
  SETTINGS_CHANGED,
  SettingsChanged,
  type AlexiaMethod,
  type AlexiaParams,
  type AlexiaResult,
  type CallToolResult,
  type ComputeBinding,
  type HostInfo,
  type Manifest,
  type Stage,
  type Where,
  COMPUTE_META,
  CONTROLS_META,
  PREVIEW_META,
  PLAN_META,
  STAGES_META,
} from '@alexia/protocol'
import {
  fromJsonSchema,
  McpServer,
  type RequestOptions,
  type ServerContext,
  type StandardSchemaV1,
} from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { log } from './log.js'
import { readManifest } from './manifest.js'

/**
 * What a plugin author imports.
 *
 * It is a thin thing on purpose: your plugin *is* an MCP server, and everything MCP already
 * does — tools, progress, cancellation, sampling — you get from `@modelcontextprotocol/server`
 * unchanged. This package adds the two things that package cannot know about: the `alexia/*`
 * layer, and the fact that stdout is the wire.
 */

/** A row on the way in, exactly as the wire schema defines it. */
type Row = AlexiaParams<'alexia/storage/insert'>['row']
type Json = AlexiaParams<'alexia/storage/kv/set'>['value']
type Args = AlexiaParams<'alexia/capability/call'>['arguments']

/** Your namespace in Alexia's database. Tables come from your manifest; the prefix is core's. */
export interface Storage {
  insert(table: string, row: Row): Promise<number>
  select(
    table: string,
    query?: { where?: Where; order?: [string, 'asc' | 'desc'][]; limit?: number; offset?: number },
  ): Promise<Row[]>
  update(table: string, set: Row, where: Where): Promise<number>
  /** `where` is required. To empty a table, say `{ all: true }` and mean it. */
  delete(table: string, where: Where | { all: true }): Promise<number>
  count(table: string, where?: Where): Promise<number>
  /** Small values that do not deserve a table. JSON, up to 64 KB. */
  get(key: string): Promise<Json | undefined>
  set(key: string, value: Json): Promise<void>
  remove(key: string): Promise<void>
}

/**
 * What a long call can show about itself while it runs, beyond a number.
 *
 * An options bag rather than two more positional arguments: `progress(ctx, 12, 20, 'sampling',
 * shot, steps)` is four optional slots in a row, and the fifth thing anybody wants to send
 * would make it five. Both fields are extensions an older Alexia ignores.
 */
export interface Work {
  /**
   * **A picture of the work while it is still work** — a `data:` URL, replaced by the next one
   * and never stored. Keep them small: this is sent on every frame, and a progress channel is
   * not a transport.
   */
  preview?: string
  /**
   * **The job's own steps, in the order you run them.** The bar says how far through
   * everything is; this says how many parts there are and which one is live. Order is yours
   * and is never re-sorted — see {@link Stage}.
   */
  stages?: Stage[]
  /**
   * **The stages are a plan**, not a pipeline: drawn as named points joined in order, each
   * with its `label` and `detail` shown, rather than a bar of unnamed segments. For a handful
   * of steps a person reads — a pipeline of twenty-five is still better as the bar.
   */
  plan?: boolean
  /**
   * **Buttons for the person while it runs** — `{ key, label }`, each `key` one of your own
   * declared `action` widgets (*Take over*, *Continue*). Drawn on the running step.
   */
  controls?: { key: string; label: string }[]
}

/** One block of an MCP tool result. Shaped by MCP, not by this package. */
export interface ResourceLink {
  type: 'resource_link'
  uri: string
  name: string
  mimeType?: string
  description?: string
}

/**
 * One thing missing before your compute operations can run on this computer, as your `setup`
 * hook reports it. Alexia shows the list, with sizes, and installs nothing until the person
 * presses the button beside one.
 */
export interface ComputeRequirement {
  /** Stable for as long as the requirement stands. Your `install` hook is handed it back. */
  id: string
  kind: 'runtime' | 'model' | 'dependency'
  title: string
  detail?: string
  /** The download's size, where you know it. Shown before anything is installed. */
  bytes?: number
  /** `install` is a button your `install` hook carries out; `instructions` is something only a person can do. */
  action: 'install' | 'instructions'
  instructions?: string
  /** Which of your operations are waiting on it, by capability. */
  blocks: string[]
}

/** The lifecycle hooks a compute worker may answer. Every one is optional. */
export interface ComputeHooks {
  /** What is missing before your operations can run here, with sizes. Called on setup and after an install. */
  setup?(): Promise<ComputeRequirement[]>
  /** Install one requirement you returned. Report progress on `ctx`. Called only after the person pressed its button. */
  install?(requirementId: string, ctx: ServerContext): Promise<void>
  /** Get ready for an operation that is about to run: load the model, start your worker process. */
  prepare?(cap: string): Promise<void>
  /** Let go of model memory and stop processes you started. Called before another backend loads and at the idle stop. */
  release?(): Promise<void>
}

export interface AlexiaPlugin {
  /** Your own `plugin.json`, already validated. Your id, version and declared settings. */
  readonly manifest: Manifest
  /** The MCP server underneath, for anything this package does not wrap. */
  readonly server: McpServer
  /** Register a tool. The signature is MCP's, unchanged, including the type inference. */
  readonly tool: McpServer['registerTool']
  /** Tell Alexia your tool list changed. It re-reads `tools/list` and the loop re-plans. */
  toolsChanged(): void

  /** Every setting you declared, with the user's value or your default. */
  settings<T extends Record<string, unknown> = Record<string, unknown>>(): Promise<T>

  /**
   * Report yourself on the settings screen. `key` must be one of your own `status` widgets —
   * the only kind this writes, because everything else on that screen is the user's answer
   * and not yours to change.
   *
   * Core keeps it while you are stopped, so the screen is honest before your next spawn.
   * A leading `●` reads as ready, `▲` as something to look at, `■` as idle. Only `▲` is
   * coloured: on this screen a colour means something happened, and being ready is not
   * something happening.
   */
  status(key: string, value: string): Promise<void>
  /** The user edited a setting while you were running. React or ignore, but do not exit. */
  onSettingsChanged(handler: (changed: Record<string, unknown>) => void): void
  /**
   * The conversation somebody was having is over — they started a new one, or closed it.
   *
   * **Let go of anything expensive you were holding for it.** You are told nothing about the
   * conversation itself, on purpose; the only information here is that keeping something warm
   * for it has stopped being useful. Most plugins should ignore this. It is for the ones holding
   * a graphics card, a model in memory, or a process somebody else's machine is paying for.
   *
   * Do not exit, and do not treat it as a shutdown: another conversation may start immediately.
   */
  onConversationEnded(handler: () => void): void
  host(): Promise<HostInfo>
  /**
   * Call something another plugin provides, by capability name. You never learn who
   * answered, and there is no way to ask — that is the invariant, not politeness.
   */
  capability(cap: string, args?: Args): Promise<CallToolResult>
  /**
   * **Would anything here answer this capability?** — and, separately, is something that
   * would **installed and switched off**?
   *
   * For deciding whether to offer something at all, and for the sentence when you cannot. It
   * runs nothing and changes nothing, so unlike {@link capability} it does not need the name
   * in your `requires[]`: a plugin made to declare a dependency in order to check for one
   * would be declaring something untrue.
   *
   * It names nobody at either end. You ask about a capability and you are told two booleans —
   * *plan around it* and *the fix is a switch rather than an install*.
   */
  answers(cap: string): Promise<{ answers: boolean; here: boolean }>
  readonly storage: Storage
  /**
   * The context to pass is the one your handler was given — and **which argument that is
   * depends on your tool**: a tool with an `inputSchema` is called `(args, ctx)`, and a tool
   * without one is called `(ctx)`. Writing `(_args, ctx)` on a tool that takes no arguments
   * hands you the context as `_args` and `undefined` as `ctx`, and in a plain-JavaScript
   * plugin nothing will tell you.
   *
   * Report progress on the call you are serving. Send it for anything over about two
   * seconds; a bar that moves is the difference between waiting and quitting. Silently does
   * nothing when the caller did not ask for progress.
   *
   * `work` is the optional half: what the job looks like, and what shape it has. Both ride
   * under `_meta`, so an Alexia that has never heard of either draws the bar and ignores the
   * rest — send them only where seeing them is the point, because they cost bandwidth on
   * every frame and a bar already answers *is this working, and how long*.
   */
  progress(ctx: ServerContext, progress: number, total?: number, message?: string, work?: Work): void

  /**
   * **Hand a file you made back to the person**, as one block in your tool result.
   *
   * ```js
   * return { content: [{ type: 'text', text: 'Made it.' }, alexia.file(path)] }
   * ```
   *
   * They get a row under the answer with the file on it — open it, save it, show it in a
   * folder, copy where it is. Without this, a path in your result text is a path in a
   * sentence, and there is nothing a person can press.
   *
   * **This is MCP's own `resource_link` and nothing of Alexia's**, which is why it is four
   * lines here rather than a method on the wire. Alexia reads the block out of the result
   * the standard already lets you put it in; a host that does not understand it shows your
   * text and ignores this, which is exactly what happened before it existed.
   *
   * The path must be absolute and the file must already be written when you return — Alexia
   * checks, and names a file that is not there as missing rather than offering it. Write it
   * somewhere that survives the call: your own directory (`fs.own_dir`) is the obvious
   * place, and it is deleted when the user deletes you, which is the right lifetime.
   */
  file(path: string, about?: { name?: string; mime?: string; description?: string }): ResourceLink

  /**
   * Register the tool that performs one of your declared `compute.operations`. Never shown to
   * the model. `args` arrive with every staged input replaced by a path you can read; return
   * the files you made and Alexia carries them back.
   */
  computeOperation(
    cap: string,
    handler: (args: Record<string, unknown>, ctx: ServerContext) => Promise<{ text?: string; files?: string[] }>,
  ): void
  /** The lifecycle hooks you listed in `compute.hooks`. Every one is optional. */
  computeHooks(hooks: ComputeHooks): void
  readonly compute: {
    /**
     * Run one of your operations where the person chose: this computer or their paired host.
     *
     * With nothing paired it is your own {@link AlexiaPlugin.computeOperation} handler, here,
     * so a plugin written against this behaves the same either way. `inputs` are files to send
     * with the job, each one you may already read; `files` are what came back, in your own
     * directory. A place that cannot do the work is an error, and never quietly another place.
     */
    run(
      cap: string,
      args?: Args,
      options?: {
        inputs?: { name: string; path: string; mime: string }[]
        /** `preview`, when there is one, is the picture so far as a `data:image/…` URL: show it, replace it, never keep it. */
        onProgress?(progress: number, total?: number, message?: string, preview?: string): void
        signal?: AbortSignal
      },
    ): Promise<{ text?: string; files: string[] }>
  }

  /** The raw `alexia/*` call, typed against the protocol package. */
  call<M extends AlexiaMethod>(method: M, params: AlexiaParams<M>): Promise<AlexiaResult<M>>
  /** Connect stdio and start serving. Register your tools first. */
  start(): Promise<void>
}

export interface PluginOptions {
  /** Where `plugin.json` lives. Defaults to the working directory, which is your folder. */
  dir?: string
}

/**
 * How long `compute.run` waits before giving up on its own.
 *
 * **Core is the clock here too** (D149): a job waits its turn behind another, loads a model,
 * and then does minutes of work, and every one of those ends with core answering — done,
 * failed, cancelled or interrupted. MCP's sixty seconds would throw away any job that had to
 * queue. A day is how long a finished job's files are kept for collection, so past that there
 * is nothing left to wait for.
 */
const COMPUTE_RUN_MS = 24 * 60 * 60 * 1000

/** A compute tool's name. Reserved: the binding core reads is `COMPUTE_META`, never this. */
const computeTool = (role: string): string => `alexia_compute_${role}`

/** Any JSON object. An operation's arguments are its author's own, and core passes them through. */
const anyArguments = fromJsonSchema<Record<string, unknown>>({ type: 'object' })

export function plugin(options: PluginOptions = {}): AlexiaPlugin {
  const manifest = readManifest(options.dir)

  if (manifest.mcp_protocol !== MCP_PINNED) {
    // Refusing here beats the alternative, which is `alexia/*` requests quietly dropped on
    // the newer wire era with nothing in any log to explain it. See wire-protocol.md §1.1.
    throw new Error(
      `@alexia/sdk serves MCP ${MCP_PINNED}, and ${manifest.id} declares ${manifest.mcp_protocol}.\n` +
        `The alexia/* layer needs a revision where a server can call its host — see docs/spec/wire-protocol.md §1.1.`,
    )
  }

  const server = new McpServer(
    { name: manifest.id, version: manifest.version },
    {
      capabilities: { tools: { listChanged: true } },
      supportedProtocolVersions: [MCP_PINNED],
      instructions: manifest.summary,
    },
  )

  const call = <M extends AlexiaMethod>(
    method: M,
    params: AlexiaParams<M>,
    patience?: RequestOptions,
  ): Promise<AlexiaResult<M>> =>
    server.server.request(
      { method, params },
      // The schemas the protocol package already owns. One source, both ends of the wire.
      ALEXIA_METHODS[method].result as unknown as StandardSchemaV1<unknown, AlexiaResult<M>>,
      patience,
    )

  const storage: Storage = {
    insert: async (table, row) => (await call('alexia/storage/insert', { table, row })).rowid,
    select: async (table, query = {}) =>
      (await call('alexia/storage/select', { table, ...query })).rows,
    update: async (table, set, where) =>
      (await call('alexia/storage/update', { table, set, where })).changed,
    delete: async (table, where) =>
      (await call('alexia/storage/delete', 'all' in where ? { table, all: true } : { table, where }))
        .deleted,
    count: async (table, where) => (await call('alexia/storage/count', { table, where })).count,
    get: async (key) => (await call('alexia/storage/kv/get', { key })).value,
    set: async (key, value) => void (await call('alexia/storage/kv/set', { key, value })),
    remove: async (key) => void (await call('alexia/storage/kv/delete', { key })),
  }

  /**
   * One compute tool: an ordinary MCP tool with a reserved name and the binding in `_meta`,
   * which is the only part core reads. Declared first, because a tool core has no declaration
   * for is a tool it will never call — and saying so here beats a job that never starts.
   */
  const bind = (binding: ComputeBinding): [name: string, tool: { _meta: Record<string, unknown> }] => {
    const declared =
      'op' in binding ?
        manifest.compute?.operations.some((o) => o.cap === binding.op) === true
      : manifest.compute?.hooks?.includes(binding.hook) === true
    if (!declared) {
      const [what, list] = 'op' in binding ? [binding.op, 'compute.operations'] : [binding.hook, 'compute.hooks']
      throw new Error(`${manifest.id} registers "${what}" and its plugin.json does not list it in ${list}.`)
    }
    return [computeTool('op' in binding ? binding.op : binding.hook), { _meta: { [COMPUTE_META]: binding } }]
  }
  const done = { content: [] }
  const flushProgress = async (ctx: ServerContext): Promise<void> => {
    // MCP dispatches notifications in a microtask but removes their progress token as soon
    // as the result arrives. A round trip lets core dispatch progress before that result.
    if (ctx.mcpReq._meta?.progressToken !== undefined) await server.server.ping()
  }

  return {
    manifest,
    server,
    tool: server.registerTool.bind(server) as McpServer['registerTool'],
    toolsChanged: () => server.sendToolListChanged(),

    settings: async <T extends Record<string, unknown>>() =>
      (await call('alexia/settings/get', {})).settings as T,

    status: async (key, value) => {
      await call('alexia/settings/set', { key, value })
    },
    onSettingsChanged: (handler) =>
      server.server.setNotificationHandler(
        SETTINGS_CHANGED,
        { params: SettingsChanged },
        ({ changed }) => handler(changed),
      ),
    onConversationEnded: (handler) =>
      server.server.setNotificationHandler(CONVERSATION_ENDED, { params: ConversationEnded }, () => handler()),
    host: () => call('alexia/host/info', {}),
    // Another plugin's work rather than a row in core's database, so it gets core's patience
    // for that work instead of MCP's sixty seconds (D149).
    capability: (cap, args) => call('alexia/capability/call', { cap, arguments: args }, { timeout: CAPABILITY_CALL_MS }),
    answers: (cap) => call('alexia/answers', { cap }),
    storage,
    progress: (ctx, progress, total, message, work) => {
      const progressToken = ctx.mcpReq._meta?.progressToken
      if (progressToken === undefined) return
      // Under `_meta`, so an Alexia that has never heard of either still draws the bar — the
      // same door `alexia/tools` and `alexia/files` go through. One bag, so a plugin sending
      // both does not pay for two.
      const meta = {
        ...(work?.preview !== undefined && { [PREVIEW_META]: work.preview }),
        ...(work?.stages !== undefined && { [STAGES_META]: work.stages }),
        ...(work?.plan === true && { [PLAN_META]: true }),
        ...(work?.controls !== undefined && { [CONTROLS_META]: work.controls }),
      }
      void ctx.mcpReq
        .notify({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress,
            total,
            message,
            ...(Object.keys(meta).length > 0 && { _meta: meta }),
          },
        })
        .catch((error: unknown) => log.warn('could not report progress', error))
    },
    file: (path, about = {}) => ({
      type: 'resource_link',
      // `pathToFileURL` rather than `file://` and a template, because a Windows path has
      // backslashes, a drive letter and quite possibly a space in it, and every one of those
      // is a different way to write a URL by hand and get it wrong.
      uri: pathToFileURL(path).href,
      name: about.name ?? basename(path),
      ...(about.mime !== undefined && { mimeType: about.mime }),
      ...(about.description !== undefined && { description: about.description }),
    }),
    computeOperation: (cap, handler) => {
      const [name, tool] = bind({ op: cap })
      const summary = manifest.compute?.operations.find((o) => o.cap === cap)?.summary
      server.registerTool(
        name,
        { ...tool, description: summary, inputSchema: anyArguments, annotations: { readOnlyHint: false, openWorldHint: false } },
        async (args, ctx) => {
          const { text, files = [] } = await handler(args, ctx)
          await flushProgress(ctx)
          // `structuredContent` is what core reads; the text is repeated as content because
          // that is where MCP puts words, and a host that is not Alexia reads only that.
          return {
            content: text === undefined ? [] : [{ type: 'text', text }],
            structuredContent: { ...(text !== undefined && { text }), files },
          }
        },
      )
    },
    computeHooks: ({ setup, install, prepare, release }) => {
      const register = server.registerTool.bind(server)
      const text = (key: string) =>
        fromJsonSchema<Record<string, string>>({ type: 'object', properties: { [key]: { type: 'string' } }, required: [key] })
      const changes = { readOnlyHint: false, openWorldHint: false }

      if (setup) {
        const [name, tool] = bind({ hook: 'setup' })
        // Read-only, and it has to be: it runs whenever the list is drawn, before anybody
        // has agreed to anything.
        register(name, { ...tool, annotations: { readOnlyHint: true, openWorldHint: false } }, async () => ({
          content: [],
          structuredContent: { requirements: await setup() },
        }))
      }
      if (install) {
        const [name, tool] = bind({ hook: 'install' })
        const annotations = { readOnlyHint: false, openWorldHint: true }
        register(name, { ...tool, inputSchema: text('requirementId'), annotations }, async (args, ctx) => {
          await install(args.requirementId!, ctx)
          await flushProgress(ctx)
          return done
        })
      }
      if (prepare) {
        const [name, tool] = bind({ hook: 'prepare' })
        register(name, { ...tool, inputSchema: text('cap'), annotations: changes }, async (args) => {
          await prepare(args.cap!)
          return done
        })
      }
      if (release) {
        const [name, tool] = bind({ hook: 'release' })
        register(name, { ...tool, annotations: changes }, async () => {
          await release()
          return done
        })
      }
    },
    compute: {
      run: (cap, args, { inputs, onProgress, signal } = {}) =>
        call(
          'alexia/compute/run',
          { cap, arguments: args, inputs },
          {
            timeout: COMPUTE_RUN_MS,
            ...(signal && { signal }),
            // A progress callback is what makes MCP attach a token, and the token is what core
            // answers on — so no callback, no frames, as with `alexia/stream`.
            ...(onProgress && {
              onprogress: (update) => {
                const shown = (update as { _meta?: Record<string, unknown> })._meta?.[PREVIEW_META]
                onProgress(update.progress, update.total, update.message, typeof shown === 'string' && shown.startsWith('data:image/') ? shown : undefined)
              },
            }),
          },
        ),
    },
    call,
    start: async () => {
      await server.connect(new StdioServerTransport())
      // **Core gone is this plugin gone.** stdin is the pipe core writes to, so its end is the
      // one sign that arrives however core left: a tidy stop, a crash, or a kill it never
      // heard. MCP's transport listens for data and errors and not for the end, so without
      // this a plugin with a timer or an open poll carried on alone — a Telegram bot still
      // collecting messages for an Alexia that had quit, and fighting the next one for them.
      process.stdin.once('end', leave)
      process.stdin.once('close', leave)
    },
  }
}

/** Nothing is listening any more, so there is nothing to finish: every answer went to core. */
function leave(): never {
  process.exit(0)
}
