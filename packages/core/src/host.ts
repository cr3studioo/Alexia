// SPDX-License-Identifier: AGPL-3.0-only
import { ErrorCode, type AlexiaMethod, type AlexiaParams, type HostInfo, type Manifest } from '@alexia/protocol'
import { ProtocolError, type CallToolResult, type CreateMessageRequestParams, type CreateMessageResult, type Root } from '@modelcontextprotocol/client'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { keychain, type SecretStore } from './secrets.js'
import { declaredWidgets } from './settings.js'
import { ALEXIA_VERSION, type HostServices } from './supervisor.js'
import type { Store } from './store.js'

/**
 * The other side of the `alexia/*` layer: what core answers when a plugin asks.
 *
 * Everything here is answered from the manifest and the store, and every answer is scoped
 * to the plugin that asked. There is no method that takes another plugin's id, and adding
 * one would end the invariant — a plugin that can name another plugin can depend on it.
 */

export interface HostOptions {
  store: Store
  /** Alexia's own data directory. Plugin directories are created inside it, never elsewhere. */
  dataDir: string
  /** Where `password` settings come from. The OS keychain unless a test says otherwise. */
  secrets?: SecretStore
  /** The manifest of an enabled plugin, or nothing. The loader owns this map (M0-7). */
  manifest(pluginId: string): Manifest | undefined
  /** What the user renamed Alexia to. Plugins show this, not "Alexia". */
  displayName?: string
  privacyMode?: HostInfo['privacyMode']
  /** The router (M1-8). Absent means core cannot answer for the model yet, and says so. */
  sample?(pluginId: string, params: CreateMessageRequestParams): Promise<CreateMessageResult>
  /** The folders the user has put in scope. A fixed stub until the UI has a way to add one. */
  roots?(pluginId: string): Root[]
  /** Route a capability to whichever plugin provides it. The resolver lands at M0-7. */
  capability?(cap: string, args?: Record<string, unknown>): Promise<CallToolResult>
  log?(pluginId: string, line: string): void
  /** A plugin's tool list changed under us. The aggregate the model sees is now stale. */
  toolsChanged?(pluginId: string): void
}

const fail = (code: number, message: string): never => {
  throw new ProtocolError(code, message)
}

export class Host implements HostServices {
  constructor(private readonly options: HostOptions) {
    // Core's own layout, made once. A plugin's directory lives inside this one; the
    // container is core's and outlives every plugin, which is what lets the purge check
    // diff the data directory and expect *nothing* left behind.
    mkdirSync(join(options.dataDir, 'plugins'), { recursive: true })
  }

  /** The plugin's own directory, created on demand. Purged with the plugin, and only there. */
  ownDir(pluginId: string): string {
    const dir = join(this.options.dataDir, 'plugins', pluginId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  log(pluginId: string, line: string): void {
    this.options.log?.(pluginId, line)
  }

  /**
   * `notifications/tools/list_changed`, and the restart path that raises it too.
   *
   * It was a no-op until M15-2 because nothing downstream had a list to invalidate. Now the
   * model is handed one every step, and a plugin that gained a tool after its model finished
   * downloading has no other way to say so.
   */
  toolsChanged(pluginId: string): void {
    this.options.toolsChanged?.(pluginId)
  }

  unhealthy(pluginId: string, message: string): void {
    this.options.log?.(pluginId, message)
  }

  roots(pluginId: string): Root[] {
    return this.options.roots?.(pluginId) ?? []
  }

  async sampling(pluginId: string, params: CreateMessageRequestParams): Promise<CreateMessageResult> {
    if (!this.options.sample) {
      // Honest rather than convenient: a canned answer here would look like a working model
      // to every plugin author who tried it before M1-8.
      return fail(ErrorCode.INTERNAL_ERROR, 'Alexia has no model wired up yet.')
    }
    return this.options.sample(pluginId, params)
  }

  /** Every `alexia/*` request, already validated against the wire schema by the supervisor. */
  async alexia<M extends AlexiaMethod>(pluginId: string, method: M, params: AlexiaParams<M>): Promise<unknown> {
    const manifest = this.options.manifest(pluginId)
    if (!manifest) return fail(ErrorCode.INTERNAL_ERROR, `${pluginId} is not an enabled plugin`)
    const { store } = this.options

    /** The namespace rule, in one place: a table you did not declare is not yours. */
    const table = (name: string): string => {
      if (!manifest.storage?.tables?.includes(name)) {
        return fail(ErrorCode.STORAGE_OUT_OF_NAMESPACE, `${pluginId} did not declare a table called "${name}"`)
      }
      return name
    }

    switch (method) {
      case 'alexia/settings/get':
        return { settings: await this.#settings(manifest) }

      case 'alexia/settings/set': {
        const p = params as AlexiaParams<'alexia/settings/set'>
        // Either screen: a `status` a plugin drives is the same `status` whether the author
        // put it in the settings pane or on its panel (D86).
        const declared = declaredWidgets(manifest).find((setting) => setting.key === p.key)
        if (!declared) {
          return fail(ErrorCode.SETTING_UNKNOWN, `${pluginId} did not declare a setting called "${p.key}"`)
        }
        // The narrowness is the whole design. A `status` is the plugin's own report of
        // itself and nobody else writes it; everything else on this screen is the user's
        // answer, and a plugin that could rewrite a toggle could quietly undo a decision the
        // person made. That plugin would have to be trusted rather than read.
        if (declared.type !== 'status') {
          return fail(
            ErrorCode.INVALID_PARAMS,
            `${pluginId} may only write its own status settings; "${p.key}" is a ${declared.type}`,
          )
        }
        store.setSetting(pluginId, p.key, p.value)
        return {}
      }

      case 'alexia/host/info':
        return this.#info(manifest)

      case 'alexia/capability/call': {
        const p = params as AlexiaParams<'alexia/capability/call'>
        if (!manifest.requires?.some((r) => r.cap === p.cap)) {
          return fail(ErrorCode.CAPABILITY_NOT_PERMITTED, `${pluginId} did not ask for ${p.cap} in requires[]`)
        }
        if (!this.options.capability) {
          return fail(ErrorCode.CAPABILITY_NOT_AVAILABLE, `nothing enabled provides ${p.cap}`)
        }
        return this.options.capability(p.cap, p.arguments)
      }

      case 'alexia/storage/insert': {
        const p = params as AlexiaParams<'alexia/storage/insert'>
        return { rowid: store.insert(pluginId, table(p.table), p.row) }
      }
      case 'alexia/storage/select': {
        const { table: name, ...query } = params as AlexiaParams<'alexia/storage/select'>
        return { rows: store.select(pluginId, table(name), query) }
      }
      case 'alexia/storage/update': {
        const p = params as AlexiaParams<'alexia/storage/update'>
        return { changed: store.update(pluginId, table(p.table), p.set, p.where) }
      }
      case 'alexia/storage/delete': {
        const p = params as AlexiaParams<'alexia/storage/delete'>
        return { deleted: store.delete(pluginId, table(p.table), p.where) }
      }
      case 'alexia/storage/count': {
        const p = params as AlexiaParams<'alexia/storage/count'>
        return { count: store.count(pluginId, table(p.table), p.where) }
      }

      case 'alexia/storage/kv/get': {
        const p = params as AlexiaParams<'alexia/storage/kv/get'>
        return { value: store.kvGet(pluginId, p.key) }
      }
      case 'alexia/storage/kv/set': {
        const p = params as AlexiaParams<'alexia/storage/kv/set'>
        store.kvSet(pluginId, p.key, p.value)
        return {}
      }
      case 'alexia/storage/kv/delete': {
        const p = params as AlexiaParams<'alexia/storage/kv/delete'>
        store.kvDelete(pluginId, p.key)
        return {}
      }

      case 'alexia/storage/raw':
        // ponytail: the escape hatch is open question G1, to be decided at M2 with voice as
        // the evidence. Refusing beats a permissive regex nobody can defend.
        return fail(ErrorCode.STORAGE_OUT_OF_NAMESPACE, 'raw SQL is not available yet')

      default:
        return fail(ErrorCode.METHOD_NOT_FOUND, `${method} is not an Alexia method`)
    }
  }

  /** Declared defaults, with whatever the user changed on top. */
  async #settings(manifest: Manifest): Promise<Record<string, unknown>> {
    const stored = this.options.store.settings(manifest.id)
    const settings: Record<string, unknown> = {}
    // Both screens, because this is a plugin reading its own declared values back and a
    // widget it put on its panel is one of those (D86).
    for (const setting of declaredWidgets(manifest)) {
      if (setting.type === 'password') {
        // Read now, from the keychain, and never from the database — which is what the
        // purge check proves rather than trusts. The plugin is told not to cache it.
        const secret = await this.#secret(manifest.id, setting.key)
        if (secret !== undefined) settings[setting.key] = secret
        continue
      }
      const value = stored[setting.key] ?? ('default' in setting ? setting.default : undefined)
      if (value !== undefined) settings[setting.key] = value
    }
    return settings
  }

  /**
   * A machine with no usable keychain has no secret, which is not the same as a crash: a
   * `password` nobody has filled in is already absent, and that is what the plugin sees.
   * It says so in the log rather than failing the whole settings read.
   */
  async #secret(pluginId: string, key: string): Promise<string | undefined> {
    try {
      return await (this.options.secrets ?? keychain).get(pluginId, key)
    } catch (error) {
      this.options.log?.(pluginId, `[core] cannot read "${key}" from the keychain: ${String(error)}`)
      return undefined
    }
  }

  #info(manifest: Manifest): HostInfo {
    return {
      platform: process.platform,
      arch: process.arch,
      alexiaVersion: ALEXIA_VERSION,
      alexiaProtocol: manifest.alexia_protocol,
      displayName: this.options.displayName ?? 'Alexia',
      privacyMode: this.options.privacyMode ?? 'combined',
      paths: {
        // Only if it asked for one. A plugin without `fs.own_dir` gets no directory and no
        // path to build one from.
        ...(manifest.requires?.some((r) => r.cap === 'fs.own_dir') && { ownDir: this.ownDir(manifest.id) }),
        cacheDir: join(this.options.dataDir, 'cache'),
      },
      locale: new Intl.DateTimeFormat().resolvedOptions().locale,
    }
  }
}
