// SPDX-License-Identifier: AGPL-3.0-only
import { ErrorCode, isPermission, Manifest, PROVIDES_META, SETTINGS_CHANGED } from '@alexia/protocol'
import {
  ProtocolError,
  type CallToolResult,
  type CreateMessageRequestParams,
  type CreateMessageResult,
  type Root,
  type Tool,
} from '@modelcontextprotocol/client'
import { readdirSync, readFileSync, realpathSync, rmSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { Host } from './host.js'
import { keychain, type SecretStore } from './secrets.js'
import type { Store } from './store.js'
import { PluginProcess, type Timings } from './supervisor.js'

/**
 * Everything installed, and nothing that names any of it.
 *
 * This is the file where the invariant is either true or it is not. It reads a directory,
 * validates what it finds, and routes calls by capability name — and there is no branch
 * anywhere in it that asks *which* plugin it is dealing with. Delete a folder and the map
 * loses an entry; nothing else changes.
 */

export interface PluginsOptions {
  /** The folder that holds plugin folders. Deleting one of them is the whole point. */
  dir: string
  store: Store
  /** Alexia's own data directory: plugin working directories are created inside it. */
  dataDir: string
  /** Where `password` settings live. The OS keychain unless a test says otherwise. */
  secrets?: SecretStore
  /** The router (M1-8). Absent means core cannot answer for the model yet, and says so. */
  sample?(pluginId: string, params: CreateMessageRequestParams): Promise<CreateMessageResult>
  roots?(pluginId: string): Root[]
  log?(pluginId: string, line: string): void
  /** A plugin's tools changed, or the plugin itself went away. The loop re-plans. */
  onToolsChanged?(pluginId: string): void
  timings?: Timings
}

/** A folder that does not hold a loadable plugin, and the sentence explaining why. */
export interface Problem {
  dir: string
  reason: string
}

/** Something a plugin asked for that nothing installed provides. */
export interface Unmet {
  cap: string
  /** The author's own sentence. It is what the user reads, so it is never rewritten. */
  why: string
}

interface Entry {
  manifest: Manifest
  dir: string
  process: PluginProcess
}

export class Plugins {
  readonly #entries = new Map<string, Entry>()
  readonly #problems: Problem[] = []
  readonly #host: Host
  readonly #secrets: SecretStore
  #watcher?: FSWatcher
  #pending?: NodeJS.Timeout

  constructor(private readonly options: PluginsOptions) {
    this.#secrets = options.secrets ?? keychain
    this.#host = new Host({
      store: options.store,
      dataDir: options.dataDir,
      secrets: this.#secrets,
      manifest: (id) => this.#entries.get(id)?.manifest,
      capability: (cap, args) => this.capability(cap, args),
      sample: options.sample,
      roots: options.roots,
      log: options.log,
      // A plugin saying its own tools changed lands in exactly the same place as core
      // noticing a folder appear or disappear. One event, one listener.
      toolsChanged: (id) => options.onToolsChanged?.(id),
    })
  }

  get ids(): string[] {
    return [...this.#entries.keys()].sort()
  }

  /** Folders that could not be loaded, and why. The library shows these; nothing hides them. */
  get problems(): readonly Problem[] {
    return this.#problems
  }

  manifest(id: string): Manifest | undefined {
    return this.#entries.get(id)?.manifest
  }

  process(id: string): PluginProcess | undefined {
    return this.#entries.get(id)?.process
  }

  /**
   * Read the folder. Every plugin that validates loads, including one whose requirements
   * nothing satisfies — that plugin runs and explains itself, because a plugin that
   * silently vanished would be indistinguishable from one that was never installed.
   */
  load(): void {
    const found = new Set<string>()
    this.#problems.length = 0

    for (const entry of this.#read()) {
      if ('reason' in entry) {
        this.#problems.push(entry)
        continue
      }
      found.add(entry.manifest.id)
      const existing = this.#entries.get(entry.manifest.id)
      if (existing && existing.dir === entry.dir && same(existing.manifest, entry.manifest)) continue
      void existing?.process.stop()
      this.#entries.set(entry.manifest.id, {
        ...entry,
        process: new PluginProcess(entry.manifest, entry.dir, this.#host, this.options.timings),
      })
      this.options.store.create(entry.manifest.id, entry.manifest.storage?.tables)
      this.options.onToolsChanged?.(entry.manifest.id)
    }

    // Gone. Stop what is left of it and tell whoever was planning around its tools.
    for (const [id, entry] of this.#entries) {
      if (found.has(id)) continue
      this.#entries.delete(id)
      void entry.process.stop()
      this.options.onToolsChanged?.(id)
    }
  }

  /**
   * Notice a folder appearing or disappearing. Non-recursive on purpose: a plugin is a
   * folder, and every platform reports a folder coming and going at this level. Watching
   * every file inside every plugin would buy nothing M0 needs and is where the portability
   * problems live.
   */
  watch(): void {
    if (this.#watcher) return
    try {
      // Windows' fs-event backend compares the path it was handed against the one the OS
      // reports for each event, and **aborts the process** — not throws — when they differ.
      // An 8.3 short path — `RUNNER~1` standing in for `runneradmin` — is enough to
      // trigger it, which is how CI found this and a laptop never would. Ask the OS what
      // it calls the directory
      // first. ponytail: if the Windows watcher bites again, chokidar is the sanctioned
      // replacement and the parts list already carries it.
      const dir = realpathSync.native(this.options.dir)
      this.#watcher = watch(dir, () => {
        // Deleting a folder is several events. Coalesce, or the reload runs four times.
        clearTimeout(this.#pending)
        this.#pending = setTimeout(() => this.load(), 100).unref()
      })
      // A folder that cannot be watched means core stops noticing changes to it. That is a
      // degraded install, worth saying out loud, and not a reason to bring anything down.
      this.#watcher.on('error', (error) => this.#unwatchable(error))
    } catch (error) {
      this.#unwatchable(error)
    }
  }

  #unwatchable(error: unknown): void {
    this.#problems.push({
      dir: this.options.dir,
      reason: `cannot watch for changes: ${String(error)}`,
    })
  }

  /** What every enabled plugin can do right now, tagged with who answers. */
  async tools(): Promise<{ pluginId: string; tool: Tool }[]> {
    const lists = await Promise.all(
      [...this.#entries.values()].map(async (entry) => {
        const tools = await entry.process.listTools().catch(() => [])
        return tools.map((tool) => ({ pluginId: entry.manifest.id, tool }))
      }),
    )
    return lists.flat()
  }

  /**
   * Call whatever provides this capability. **By name only** — the result does not say who
   * answered and there is no way to ask, which is the invariant rather than politeness.
   */
  async capability(cap: string, args?: Record<string, unknown>): Promise<CallToolResult> {
    for (const entry of this.#entries.values()) {
      if (!entry.manifest.provides?.includes(cap)) continue
      // The manifest is the declaration; the binding is on the tool, because a plugin whose
      // model has not downloaded yet cannot answer and should not claim to.
      const tool = (await entry.process.listTools().catch(() => [])).find((t) =>
        provided(t).includes(cap),
      )
      if (tool) return entry.process.callTool(tool.name, args)
    }
    throw new ProtocolError(ErrorCode.CAPABILITY_NOT_AVAILABLE, `nothing enabled provides ${cap}`)
  }

  /**
   * The user changed a setting. **A `password` goes to the keychain and nowhere else** —
   * this is the only method that writes one, so the rule holds by construction rather than
   * by everybody remembering it.
   *
   * A running plugin is told what changed; a stopped one reads the new value when it next
   * starts, which is why nothing is spawned here.
   */
  async setSetting(id: string, key: string, value: unknown): Promise<void> {
    const entry = this.#entries.get(id)
    const declared = entry?.manifest.settings?.find((s) => s.key === key)
    if (!entry || !declared) {
      throw new ProtocolError(ErrorCode.INVALID_PARAMS, `${id} has no setting called "${key}"`)
    }
    if (declared.type === 'password') {
      await this.#secrets.set(id, key, String(value))
    } else {
      this.options.store.setSetting(id, key, value)
    }
    await entry.process.notify(SETTINGS_CHANGED, { changed: { [key]: value } })
  }

  /** What this plugin asked for that nothing provides. Its author's sentence, verbatim. */
  unmet(id: string): Unmet[] {
    const manifest = this.#entries.get(id)?.manifest
    if (!manifest) return []
    const provided = new Set([...this.#entries.values()].flatMap((e) => e.manifest.provides ?? []))
    return (manifest.requires ?? [])
      .filter((r) => !isPermission(r.cap) && !provided.has(r.cap))
      .map((r) => ({ cap: r.cap, why: r.why }))
  }

  /**
   * Everything this plugin owns, gone: its process, its namespace, its directory, and the
   * folder it was installed from. The database transaction commits **before** the
   * directories go — a crash between them leaves a directory with no namespace, which the
   * next start can clean up, while the reverse would look exactly like a plugin that has
   * never been enabled and would sit there forever (storage.md).
   */
  async purge(id: string): Promise<void> {
    const entry = this.#entries.get(id)
    this.#entries.delete(id)
    await entry?.process.stop()
    this.options.store.purge(id)
    // Then the keychain, one entry per declared `password`.
    // ponytail: the key names come from the manifest, so a folder someone deleted by hand
    // before asking Alexia to purge it takes its own list with it. Record the names in the
    // settings table the day that stops being a corner case.
    for (const setting of entry?.manifest.settings ?? []) {
      if (setting.type === 'password') await this.#secrets.delete(id, setting.key)
    }
    rmSync(this.#host.ownDir(id), { recursive: true, force: true })
    if (entry) rmSync(entry.dir, { recursive: true, force: true })
    this.options.onToolsChanged?.(id)
  }

  async stop(): Promise<void> {
    this.#watcher?.close()
    this.#watcher = undefined
    clearTimeout(this.#pending)
    await Promise.all([...this.#entries.values()].map((e) => e.process.stop()))
  }

  /** One pass over the folder. A folder that is not a plugin is a problem, not a crash. */
  #read(): ({ manifest: Manifest; dir: string } | Problem)[] {
    let names: string[]
    try {
      names = readdirSync(this.options.dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      // No plugins folder at all is not an error. Core works with zero plugins (rule 4).
      return []
    }

    return names.flatMap((name): ({ manifest: Manifest; dir: string } | Problem)[] => {
      const dir = join(this.options.dir, name)
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
      } catch {
        // A folder with no readable manifest is not a plugin. Say so and move on.
        return [{ dir, reason: `${name} has no readable plugin.json` }]
      }
      const parsed = Manifest.safeParse(raw)
      if (!parsed.success) {
        const first = parsed.error.issues[0]
        return [{ dir, reason: `${name}'s plugin.json is not valid: ${first?.path.join('.')} ${first?.message}` }]
      }
      if (parsed.data.id !== name) {
        // The folder name is the id everywhere else — in storage, in the keychain, in the
        // library. One rule, mirroring agentskills.io, so authors learn it once.
        return [{ dir, reason: `${name}'s plugin.json calls it "${parsed.data.id}"` }]
      }
      const unknown = (parsed.data.requires ?? []).filter(
        (r) => r.cap.startsWith('fs.') || r.cap.startsWith('net.') || r.cap.startsWith('proc.'),
      )
      const bad = unknown.find((r) => !isPermission(r.cap))
      if (bad) return [{ dir, reason: `${name} asks for "${bad.cap}", which is not a permission Alexia grants` }]
      return [{ manifest: parsed.data, dir }]
    })
  }
}

/** The capability names a tool answers, from its `_meta`. */
function provided(tool: Tool): string[] {
  const declared = (tool._meta as Record<string, unknown> | undefined)?.[PROVIDES_META]
  return Array.isArray(declared) ? declared.filter((c) => typeof c === 'string') : []
}

const same = (a: Manifest, b: Manifest): boolean => JSON.stringify(a) === JSON.stringify(b)
