// SPDX-License-Identifier: AGPL-3.0-only
import type { Manifest } from '@alexia/protocol'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { SecretStore } from './secrets.js'
import type { Store } from './store.js'

/**
 * The settings screen, from the manifest side (M2-1).
 *
 * **A plugin cannot style itself wrong because it never styles itself.** It declares ten
 * possible widgets; this module turns those declarations plus the stored values into
 * something the shell can render, and turns an edit coming back the other way into a value
 * that is checked before it is kept.
 *
 * Everything here reads the manifest and the store, and **nothing here spawns a plugin**.
 * That is the point of the schema living in `plugin.json`: lazy spawn means "not running" is
 * the normal state, and a settings screen that had to wake three processes to draw itself
 * would wake them every time somebody looked at it.
 */

/** One of the ten, as the manifest declares it. */
export type Setting = NonNullable<Manifest['settings']>[number]

/** A declaration plus what core knows about it right now. The shell renders this and nothing else. */
export type Rendered = Setting & {
  /** The user's value, or the manifest's default. Never a password. */
  value?: unknown
  /** `password` only: whether one is stored, and the sentence saying where. */
  set?: boolean
  stored?: string
  /** `action` only: whether the named tool is there. Unknown while the plugin is stopped. */
  available?: boolean
  reason?: string
  /** `progress` only: whatever the last `notifications/progress` said. Absent means idle. */
  live?: Progress
}

export interface Progress {
  progress: number
  total?: number
  message?: string
}

export interface Pane {
  id: string
  name: string
  summary: string
  version: string
  license: string
  /** Whether a process is up. Not a promise that one will stay up — lazy spawn owns that. */
  running: boolean
  /** The author's own sentences, never rewritten: this is what the user reads. */
  requires: { cap: string; why: string }[]
  settings: Rendered[]
}

/**
 * Where a `password` actually goes, named for this machine.
 *
 * `ui-schema.md` makes core write this line rather than the author: a plugin that promised
 * the wrong store would be lying on core's screen, in core's voice.
 */
export function secretStoreName(platform: string = process.platform): string {
  if (platform === 'win32') return 'Stored in Windows Credential Manager.'
  if (platform === 'darwin') return 'Stored in the macOS keychain.'
  return 'Stored in the system secret service.'
}

/** Read-only widgets: the plugin drives them, the user cannot type into them. */
const DRIVEN = new Set(['status', 'progress', 'action'])

export interface PaneOptions {
  store: Store
  /** Whether a process is up, asked without starting one. */
  running(pluginId: string): boolean
  /** A running plugin's tool names, or undefined while it is stopped. Never spawns. */
  tools(pluginId: string): string[] | undefined
  /**
   * In-flight progress for this plugin, from whatever tool call is running.
   *
   * One bar per plugin, not one per key: progress is about the work a plugin is doing now,
   * and the manifest has no way to say which bar a given tool feeds. A plugin that declares
   * two `progress` widgets therefore sees the same bar twice, which is a design smell its
   * author will notice before anybody else does.
   */
  progress(pluginId: string): Progress | undefined
  /** Whether a password is stored. Asked of the keychain, so it is a promise. */
  hasSecret(pluginId: string, key: string): Promise<boolean>
  platform?: string
}

/** One plugin's pane: its chrome, and its ten-widget form filled in. */
export async function pane(manifest: Manifest, options: PaneOptions): Promise<Pane> {
  const stored = options.store.settings(manifest.id)
  const running = options.running(manifest.id)
  const tools = options.tools(manifest.id)
  const where = secretStoreName(options.platform)

  const settings: Rendered[] = []
  for (const declared of manifest.settings ?? []) {
    if (declared.type === 'password') {
      // The secret itself is not put on the screen. What the screen needs is whether there is
      // one and which store holds it — the two facts a person actually wants, and neither of
      // them is the secret. (Invariant 8 caught the first draft of this comment, which said
      // something stronger about where the value goes than this module can promise.)
      settings.push({ ...declared, set: await options.hasSecret(manifest.id, declared.key), stored: where })
      continue
    }
    if (declared.type === 'action') {
      // Availability is only knowable while the plugin is up, and asking a stopped one would
      // start it — which is the exact cost lazy spawn exists to avoid. So a stopped plugin's
      // button is live, and pressing it starts the plugin, which is what somebody pressing
      // "Download the model again" is asking for anyway.
      const missing = tools !== undefined && !tools.includes(declared.tool)
      settings.push({
        ...declared,
        available: !missing,
        ...(missing && { reason: `${manifest.name} has no tool called "${declared.tool}" right now.` }),
      })
      continue
    }
    if (declared.type === 'progress') {
      const live = options.progress(manifest.id)
      settings.push({ ...declared, ...(live && { live }) })
      continue
    }
    const value = stored[declared.key] ?? ('default' in declared ? declared.default : undefined)
    settings.push({ ...declared, ...(value !== undefined && { value }) })
  }

  return {
    id: manifest.id,
    name: manifest.name,
    summary: manifest.summary,
    version: manifest.version,
    license: manifest.license,
    running,
    requires: manifest.requires?.map((r) => ({ cap: r.cap, why: r.why })) ?? [],
    settings,
  }
}

/**
 * Is this a value the user may put here?
 *
 * Returns the sentence to show them, or nothing if it is fine. Every message names the value
 * and what was wrong with it, because "invalid" tells somebody only that they must guess
 * again.
 */
export function refuse(declared: Setting, value: unknown): string | undefined {
  if (DRIVEN.has(declared.type)) {
    return declared.type === 'action' ?
        `"${declared.label}" is a button, not a value.`
      : `"${declared.label}" is driven by the plugin, not by you.`
  }

  switch (declared.type) {
    case 'text':
    case 'password':
      return typeof value === 'string' ? undefined : `"${declared.label}" takes text.`

    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `"${declared.label}" takes a number.`
      if (declared.min !== undefined && value < declared.min) {
        return `"${declared.label}" must be at least ${declared.min}.`
      }
      if (declared.max !== undefined && value > declared.max) {
        return `"${declared.label}" must be at most ${declared.max}.`
      }
      return undefined
    }

    case 'toggle':
      return typeof value === 'boolean' ? undefined : `"${declared.label}" is on or off.`

    case 'choice':
      return declared.options.includes(value as string) ? undefined : (
          `"${String(value)}" is not one of ${declared.options.join(', ')}.`
        )

    case 'multi-choice': {
      if (!Array.isArray(value)) return `"${declared.label}" takes a list.`
      const stray = value.find((one) => !declared.options.includes(one as string))
      return stray === undefined ? undefined : `"${String(stray)}" is not one of ${declared.options.join(', ')}.`
    }

    case 'path': {
      if (typeof value !== 'string') return `"${declared.label}" takes a path.`
      if (value === '') return undefined
      // Checked here rather than at the control, because only this side of the loopback can
      // see the disk. A path that is wrong is worth catching now: the alternative is a
      // plugin failing later, somewhere that does not mention the setting at all.
      if (!isAbsolute(value)) return `${value} is not a full path.`
      if (!existsSync(value)) return `There is nothing at ${value}.`
      const directory = statSync(value).isDirectory()
      if (declared.kind === 'dir' && !directory) return `${value} is a file, and this wants a folder.`
      if (declared.kind === 'file' && directory) return `${value} is a folder, and this wants a file.`
      return undefined
    }
  }
  return undefined
}

export interface WriteOptions {
  store: Store
  secrets: SecretStore
}

/**
 * Keep one edited value. A `password` goes to the OS keychain and never to the database —
 * the same path core's own provider key takes, and the same one the purge check proves.
 *
 * An empty password clears it, because the alternative is a screen where a secret can be
 * replaced and never removed.
 */
export async function write(
  pluginId: string,
  declared: Setting,
  value: unknown,
  { store, secrets }: WriteOptions,
): Promise<void> {
  if (declared.type === 'password') {
    const secret = value as string
    if (secret === '') await secrets.delete(pluginId, declared.key)
    else await secrets.set(pluginId, declared.key, secret)
    return
  }
  store.setSetting(pluginId, declared.key, value)
}
