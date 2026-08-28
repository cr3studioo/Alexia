// SPDX-License-Identifier: Apache-2.0
import {
  ALEXIA_METHODS,
  MCP_PINNED,
  SETTINGS_CHANGED,
  SettingsChanged,
  type AlexiaMethod,
  type AlexiaParams,
  type AlexiaResult,
  type CallToolResult,
  type HostInfo,
  type Manifest,
  type Where,
} from '@alexia/protocol'
import { McpServer, type ServerContext, type StandardSchemaV1 } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
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
  host(): Promise<HostInfo>
  /**
   * Call something another plugin provides, by capability name. You never learn who
   * answered, and there is no way to ask — that is the invariant, not politeness.
   */
  capability(cap: string, args?: Args): Promise<CallToolResult>
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
   */
  progress(ctx: ServerContext, progress: number, total?: number, message?: string): void

  /** The raw `alexia/*` call, typed against the protocol package. */
  call<M extends AlexiaMethod>(method: M, params: AlexiaParams<M>): Promise<AlexiaResult<M>>
  /** Connect stdio and start serving. Register your tools first. */
  start(): Promise<void>
}

export interface PluginOptions {
  /** Where `plugin.json` lives. Defaults to the working directory, which is your folder. */
  dir?: string
}

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

  const call = <M extends AlexiaMethod>(method: M, params: AlexiaParams<M>): Promise<AlexiaResult<M>> =>
    server.server.request(
      { method, params },
      // The schemas the protocol package already owns. One source, both ends of the wire.
      ALEXIA_METHODS[method].result as unknown as StandardSchemaV1<unknown, AlexiaResult<M>>,
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
    host: () => call('alexia/host/info', {}),
    capability: (cap, args) => call('alexia/capability/call', { cap, arguments: args }),
    storage,
    progress: (ctx, progress, total, message) => {
      const progressToken = ctx.mcpReq._meta?.progressToken
      if (progressToken === undefined) return
      void ctx.mcpReq
        .notify({
          method: 'notifications/progress',
          params: { progressToken, progress, total, message },
        })
        .catch((error: unknown) => log.warn('could not report progress', error))
    },
    call,
    start: () => server.connect(new StdioServerTransport()),
  }
}
