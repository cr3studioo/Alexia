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
import { cpSync, readdirSync, readFileSync, realpathSync, rmSync, watch, type FSWatcher } from 'node:fs'
import { basename, join } from 'node:path'
import { Host } from './host.js'
import { tabs, type Tab } from './panels.js'
import { CORE, keychain, type SecretStore } from './secrets.js'
import { declaredWidgets, pane, refuse, write, type Pane, type PaneOptions, type Progress } from './settings.js'
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
  /**
   * The ids a person has said yes to (M2-5).
   *
   * **Installed is files on disk; enabled is this**, and the two are separate because the
   * line between them is consent. A folder appearing in the extensions directory — put there
   * by the library, by a person, or by something neither of them noticed — does not start
   * running because it is there. Somebody reads what it asked for, in its author's words,
   * and says yes.
   */
  readonly #enabled = new Set<string>()
  /** What each running plugin last said its tools were. Only ever filled from a live one. */
  readonly #toolNames = new Map<string, string[]>()
  /** One in-flight bar per plugin, for whatever an `action` started. */
  readonly #progress = new Map<string, Progress>()
  /**
   * Shutdowns already under way for plugins this map no longer holds.
   *
   * A folder that disappears is stopped and forgotten in the same breath, and nobody waits
   * for a process whose plugin has ceased to exist — there is nothing left to wait *for*.
   * Except at quit: `stop()` promises that nothing this object started is still running, and
   * without this set that promise was false for exactly the plugin the invariant is about.
   * Measured on Windows: the vanished plugin outlived `await stop()` and still held its own
   * working directory, so deleting the data directory it sits in failed with `EPERM`.
   */
  readonly #leaving = new Set<Promise<void>>()
  readonly #host: Host
  readonly #secrets: SecretStore
  #watcher?: FSWatcher
  #pending?: NodeJS.Timeout

  constructor(private readonly options: PluginsOptions) {
    this.#secrets = options.secrets ?? keychain
    const said = options.store.kvGet(CORE, 'enabled')
    if (Array.isArray(said)) for (const id of said) if (typeof id === 'string') this.#enabled.add(id)
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
      toolsChanged: (id) => {
        // Whatever it said before is stale, and the pane must not keep showing a button as
        // available because of a list from two minutes ago.
        this.#toolNames.delete(id)
        options.onToolsChanged?.(id)
      },
    })
  }

  get ids(): string[] {
    return [...this.#entries.keys()].sort()
  }

  /** Folders that could not be loaded, and why. The library shows these; nothing hides them. */
  get problems(): readonly Problem[] {
    return this.#problems
  }

  /** Whether the user has said yes to this one. Installed and not enabled is a real state. */
  enabled(id: string): boolean {
    return this.#enabled.has(id)
  }

  /**
   * Yes.
   *
   * The tables its manifest declared are created **now** rather than at load, because an
   * installed-but-not-enabled plugin owns nothing yet. That is what makes *disable* cheap and
   * *delete* the only thing in this file that removes anything.
   */
  enable(id: string): void {
    const entry = this.#entries.get(id)
    if (!entry || this.#enabled.has(id)) return
    this.#enabled.add(id)
    this.#persist()
    this.options.store.create(id, entry.manifest.storage?.tables)
    this.options.onToolsChanged?.(id)
    // A plugin that holds something open starts holding it now rather than at the first
    // call, because for this kind the first call may never come (D77).
    void entry.process.wake()
  }

  /**
   * No, for now.
   *
   * The process stops and **everything it owns stays exactly where it is** — tables, settings,
   * its directory, the model it spent twenty minutes downloading. That is why this is the
   * action the screen offers first and why delete sits one step further back: changing your
   * mind about a plugin should cost a click, not a download.
   */
  async disable(id: string): Promise<void> {
    if (!this.#enabled.delete(id)) return
    this.#persist()
    await this.#entries.get(id)?.process.stop()
    this.options.onToolsChanged?.(id)
  }

  /** The list survives a restart, because *yes* is an answer a person gave once. */
  #persist(): void {
    this.options.store.kvSet(CORE, 'enabled', [...this.#enabled].sort())
  }

  /**
   * A folder becomes an installed plugin (M2-5).
   *
   * Validated where it stands and copied second, so a folder that is not a plugin never lands
   * in the directory core watches — the alternative is a broken entry appearing in the list
   * for as long as it takes somebody to notice. **Installed, not enabled:** what it asked for
   * has not been read by anybody yet.
   */
  install(from: string): { id: string } | Problem {
    const found = this.#one(from, basename(from))
    if ('reason' in found) return found
    const id = found.manifest.id
    if (this.#entries.has(id)) {
      return { dir: from, reason: `${id} is already installed. Delete it first to replace it.` }
    }
    cpSync(from, join(this.options.dir, id), { recursive: true })
    this.load()
    return { id }
  }

  manifest(id: string): Manifest | undefined {
    return this.#entries.get(id)?.manifest
  }

  process(id: string): PluginProcess | undefined {
    return this.#entries.get(id)?.process
  }

  /**
   * The folder this plugin was installed from. Whatever it bundles — its skills (M2-2) —
   * is inside it, which is also why purge removing this one folder is enough.
   */
  folder(id: string): string | undefined {
    return this.#entries.get(id)?.dir
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
      if (existing) this.#release(existing.process)
      this.#entries.set(entry.manifest.id, {
        ...entry,
        process: new PluginProcess(entry.manifest, entry.dir, this.#host, this.options.timings),
      })
      // Only for one the user already said yes to. A plugin that has never been enabled owns
      // no tables, which is what makes the *Installed* box in the lifecycle diagram true.
      if (this.#enabled.has(entry.manifest.id)) {
        this.options.store.create(entry.manifest.id, entry.manifest.storage?.tables)
        void this.#entries.get(entry.manifest.id)?.process.wake()
      }
      this.options.onToolsChanged?.(entry.manifest.id)
    }

    // Gone. Stop what is left of it and tell whoever was planning around its tools.
    for (const [id, entry] of this.#entries) {
      if (found.has(id)) continue
      this.#entries.delete(id)
      this.#release(entry.process)
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
      [...this.#entries.values()].filter((e) => this.#enabled.has(e.manifest.id)).map(async (entry) => {
        const tools = await entry.process.listTools().catch(() => [])
        // Remembered on the way past, so a settings pane can say whether an `action` button
        // has a tool behind it without asking — and asking is what would spawn the plugin.
        this.#toolNames.set(entry.manifest.id, tools.map((tool) => tool.name))
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
      if (!this.#enabled.has(entry.manifest.id)) continue
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
   * Is anything enabled promising to answer this capability?
   *
   * Read off the manifests, so it costs nothing and spawns nothing — which is the whole
   * reason it exists separately from `capability()`. A caller that has to decide whether to
   * take a different route entirely cannot find out by trying and catching: trying wakes a
   * process, and catching happens after the work it was meant to replace.
   *
   * It answers the *promise*, not the runtime binding. A plugin whose model is still
   * downloading says yes here and `-32050` there, and that is the right way round — the
   * caller wants to know whether to plan around it, and the answer is *usually*.
   */
  answers(cap: string): boolean {
    for (const entry of this.#entries.values()) {
      if (this.#enabled.has(entry.manifest.id) && entry.manifest.provides?.includes(cap)) return true
    }
    return false
  }

  /** Whether a process is up, asked without starting one. Lazy spawn makes `false` normal. */
  running(id: string): boolean {
    return this.#entries.get(id)?.process.pid !== undefined
  }

  /**
   * Every installed plugin's settings pane (M2-1).
   *
   * **Nothing here spawns anything.** The whole reason the widget schema lives in the
   * manifest is that a settings screen has to draw itself while the processes are stopped,
   * which — with lazy spawn — is the ordinary case rather than the corner one.
   */
  async panes(): Promise<Pane[]> {
    const built: Pane[] = []
    for (const id of this.ids) {
      const manifest = this.manifest(id)
      if (!manifest) continue
      built.push(await pane(manifest, this.#drawing()))
    }
    return built
  }

  /**
   * The control surface's tab list (M6-2).
   *
   * Core's tabs plus one per enabled plugin that declared a panel. Core has no say in the
   * second half beyond *is it enabled*, which is what makes deleting a folder take its tab
   * with it — and what makes M6-G a test rather than a hope.
   */
  async tabs(): Promise<Tab[]> {
    return tabs({
      ...this.#drawing(),
      manifests: this.ids.flatMap((id) => this.manifest(id) ?? []),
    })
  }

  /** What both screens need to draw a declared widget, and neither of them spawns anything. */
  #drawing(): PaneOptions {
    return {
      store: this.options.store,
      enabled: (of) => this.enabled(of),
      running: (of) => this.running(of),
      tools: (of) => this.#toolNames.get(of),
      progress: (of) => this.#progress.get(of),
      hasSecret: async (of, key) => (await this.#secrets.get(of, key)) !== undefined,
    }
  }

  /**
   * The user changed a setting. **A `password` goes to the keychain and nowhere else** —
   * this is the only method that writes one, so the rule holds by construction rather than
   * by everybody remembering it.
   *
   * The value is checked against the declaration first, and the refusal is a sentence naming
   * what was wrong. The screen shows it beside the control; "invalid" would tell somebody
   * only that they have to guess again.
   *
   * A running plugin is told what changed; a stopped one reads the new value when it next
   * starts, which is why nothing is spawned here.
   */
  async setSetting(id: string, key: string, value: unknown): Promise<void> {
    const entry = this.#entries.get(id)
    // Either screen: settings and `panel.widgets` are one namespace, because the value is
    // stored once (D86). A widget the author put on the panel is not a second kind of thing.
    const declared = entry && declaredWidgets(entry.manifest).find((s) => s.key === key)
    if (!entry || !declared) {
      throw new ProtocolError(ErrorCode.INVALID_PARAMS, `${id} has no setting called "${key}"`)
    }
    const wrong = refuse(declared, value)
    if (wrong) throw new ProtocolError(ErrorCode.INVALID_PARAMS, wrong)

    await write(id, declared, value, { store: this.options.store, secrets: this.#secrets })
    // A cleared password is `null` rather than a missing key: the notification says what
    // changed, and "there is no longer one" is a change a plugin has to be able to see.
    const said = declared.type === 'password' && value === '' ? null : value
    await entry.process.notify(SETTINGS_CHANGED, { changed: { [key]: said } })
  }

  /**
   * Press an `action` button: call the plugin's own tool, with no arguments.
   *
   * A `progressToken` rides along, so a long job started from this screen feeds the bar
   * beside the button rather than going silent — which is the whole reason `progress` is one
   * of the ten. The permission gate is the caller's: an action is a tool call like any other
   * and core asks before a destructive one, in every mode except Full trust.
   */
  async action(id: string, key: string, signal?: AbortSignal): Promise<{ ok: boolean; said: string }> {
    const entry = this.#entries.get(id)
    // Either screen. A button on a panel is the same button (D86).
    const declared = entry && declaredWidgets(entry.manifest).find((s) => s.key === key)
    if (!entry || declared?.type !== 'action') {
      throw new ProtocolError(ErrorCode.INVALID_PARAMS, `${id} has no button called "${key}"`)
    }
    // Pressing a button is asking a plugin to do something, and a plugin nobody has said yes
    // to does not do things. The screen disables the button; this is what makes that true.
    if (!this.#enabled.has(id)) {
      throw new ProtocolError(ErrorCode.INVALID_PARAMS, `${id} is not enabled.`)
    }
    try {
      const result = await entry.process.callTool(declared.tool, undefined, {
        ...(signal && { signal }),
        onprogress: (update) => {
          this.#progress.set(id, {
            progress: update.progress,
            ...(update.total !== undefined && { total: update.total }),
            ...(update.message !== undefined && { message: update.message }),
          })
        },
      })
      const said = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
        .join('\n')
        .trim()
      return { ok: result.isError !== true, said: said || (result.isError === true ? 'That did not work.' : 'Done.') }
    } catch (error) {
      return { ok: false, said: error instanceof Error ? error.message : String(error) }
    } finally {
      // The bar goes when the work does. A bar left at 97% is worse than no bar.
      this.#progress.delete(id)
      await this.#remember(id)
    }
  }

  /**
   * What a running plugin currently calls its tools, cached so drawing a settings pane never
   * has to ask — and never has to spawn anything to find out.
   */
  async #remember(id: string): Promise<void> {
    const entry = this.#entries.get(id)
    if (!entry || entry.process.pid === undefined) {
      this.#toolNames.delete(id)
      return
    }
    try {
      this.#toolNames.set(id, (await entry.process.listTools()).map((tool) => tool.name))
    } catch {
      this.#toolNames.delete(id)
    }
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
    if (this.#enabled.delete(id)) this.#persist()
    await entry?.process.stop()
    // And anything already on its way out — including, in the one case that matters, *this*
    // plugin, when its folder was deleted by hand before the delete button was pressed.
    // `entry` is undefined there, so the line above waits for nothing, and the directory
    // being removed below is the one that process is still sitting in.
    await Promise.all(this.#leaving)
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

  /**
   * Stop a plugin nothing holds a reference to any more, without blocking on it.
   *
   * Deliberately not awaited by its callers: a folder disappearing must be noticed at the
   * speed of the filesystem, not at the speed of a process agreeing to exit. `stop()` is
   * where the wait happens instead.
   */
  #release(process: PluginProcess): void {
    const leaving = process.stop().catch(() => {})
    this.#leaving.add(leaving)
    void leaving.then(() => this.#leaving.delete(leaving))
  }

  async stop(): Promise<void> {
    this.#watcher?.close()
    this.#watcher = undefined
    clearTimeout(this.#pending)
    await Promise.all([
      ...[...this.#entries.values()].map((e) => e.process.stop()),
      // The ones already on their way out. Without these, quitting could leave a process
      // running whose plugin core has forgotten — and forgotten is exactly why nothing else
      // would ever stop it.
      ...this.#leaving,
    ])
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

    return names.map((name) => this.#one(join(this.options.dir, name), name))
  }

  /**
   * One folder, held to every rule.
   *
   * `install` and `load` share it deliberately: a folder that would not survive the loader
   * must not be copied into the directory the loader watches, and the only way to be sure of
   * that is for both of them to be asking the same question.
   */
  #one(dir: string, name: string): { manifest: Manifest; dir: string } | Problem {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
    } catch {
      // A folder with no readable manifest is not a plugin. Say so and move on.
      return { dir, reason: `${name} has no readable plugin.json` }
    }
    const parsed = Manifest.safeParse(raw)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      return { dir, reason: `${name}'s plugin.json is not valid: ${first?.path.join('.')} ${first?.message}` }
    }
    if (parsed.data.id !== name) {
      // The folder name is the id everywhere else — in storage, in the keychain, in the
      // library. One rule, mirroring agentskills.io, so authors learn it once.
      return { dir, reason: `${name}'s plugin.json calls it "${parsed.data.id}"` }
    }
    const unknown = (parsed.data.requires ?? []).filter(
      (r) => r.cap.startsWith('fs.') || r.cap.startsWith('net.') || r.cap.startsWith('proc.'),
    )
    const bad = unknown.find((r) => !isPermission(r.cap))
    if (bad) return { dir, reason: `${name} asks for "${bad.cap}", which is not a permission Alexia grants` }
    return { manifest: parsed.data, dir }
  }
}

/** The capability names a tool answers, from its `_meta`. */
function provided(tool: Tool): string[] {
  const declared = (tool._meta as Record<string, unknown> | undefined)?.[PROVIDES_META]
  return Array.isArray(declared) ? declared.filter((c) => typeof c === 'string') : []
}

const same = (a: Manifest, b: Manifest): boolean => JSON.stringify(a) === JSON.stringify(b)
