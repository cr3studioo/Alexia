// SPDX-License-Identifier: AGPL-3.0-only
import { optionValue, type Manifest, type Stage } from '@alexia/protocol'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { SecretStore } from './secrets.js'
import type { Store } from './store.js'

/**
 * The plugin's own page, from the manifest side (M2-1, D118).
 *
 * **A plugin cannot style itself wrong because it never styles itself.** It declares twelve
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

/**
 * **Core's own screen furniture, which a plugin may not declare** (D112).
 *
 * `docs/spec/ui-schema.md` sets the bar for a new widget — *one user is not enough*, and
 * `file` and `graph` were both refused on exactly that — and this does not clear it, so it is
 * not offered to plugins and is not in the manifest schema. (`graph` was granted two refusals
 * later, on what the alternatives cost rather than on a second user — D115. This was not, and
 * the difference is that a plugin has somewhere else to put a list of choices.) What it is
 * instead is the answer to a gap the twelve genuinely have: **every widget core can declare
 * for its own tabs is read-only.** `table` and `action` report and press; nothing in the set writes a core value,
 * because a plugin's values are written through `/api/settings` against a manifest, and core
 * has no manifest. So the Models tab could show what the router decided and could not offer
 * anywhere to decide it.
 *
 * It talks through `/api/action` like a row action does, which is why it needs no new write
 * path and no new gate. And it is still drawn by the one renderer both screens share, so the
 * property M6-4 actually protects — *the shell names no tab and no plugin* — is untouched.
 */
export interface CoreWidget {
  /** The routing ladder: the spend slider and the running order under it. */
  type: 'ladder'
  key: string
  label: string
  hint?: string
  /** Which rows source answers with the models. Read the same way a `table`'s is. */
  rows: string
  /** The stops, left to right, and the action each one presses with its own value. */
  stops: { value: string; label: string; hint: string }[]
  /** The action that takes the slider's new value, and the one that takes the running order. */
  chose: string
  ordered: string
}

/** A declaration plus what core knows about it right now. The shell renders this and nothing else. */
export type Rendered = (Setting | CoreWidget) & {
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
  /**
   * Whether some other widget on this page is drawn or not drawn because of this one's value.
   *
   * The shell needs it because saving normally does **not** redraw — a redraw takes the focus
   * off whoever is mid-keystroke, and the control already shows what they just set. A widget
   * that decides which other widgets exist is the exception: leaving the page as it was would
   * mean picking an engine and watching nothing happen.
   *
   * Core works it out rather than the author declaring it, because it is a fact about the
   * page and an author who had to remember to write it down would forget.
   */
  gates?: boolean
}

export interface Progress {
  progress: number
  total?: number
  message?: string
  /**
   * A picture of the thing being made, while it is being made.
   *
   * A `data:` URL and never a path: it is a frame that exists for a second and is replaced, so
   * writing each one to disk to serve it back would be a file per step of every render. It is
   * capped where it is produced rather than here — a progress channel is not a transport, and a
   * plugin sending megabytes through one is the thing that would make this a bad idea.
   *
   * Generic on purpose. Core has no notion of diffusion; it knows only that some work can show
   * itself midway, which is true of a render, a download preview and a page being laid out.
   */
  preview?: string
  /**
   * The job's own steps, in the order the plugin runs them.
   *
   * The bar above says how far through *everything* is; this says how many parts there are,
   * which one is live, and how far that one has got on its own. A plugin that has one step
   * sends nothing here and gets the bar, which is every plugin before this existed.
   */
  stages?: Stage[]
}

export interface Pane {
  id: string
  name: string
  summary: string
  version: string
  license: string
  /**
   * Whether the user has said yes to it (M2-5). Installed and not enabled is a real state,
   * and it is the one a plugin arrives in — so the screen shows what it asked for and a
   * button, rather than its settings.
   */
  enabled: boolean
  /** Whether a process is up. Not a promise that one will stay up — lazy spawn owns that. */
  running: boolean
  /** The author's own sentences, never rewritten: this is what the user reads. */
  requires: { cap: string; why: string }[]
  settings: Rendered[]
  /**
   * The rest of the same page: what the plugin is *doing*, under its own heading (D118).
   *
   * `panel` used to be a tab on the control surface, one screen away from the values that
   * drive it — so cloning a voice meant typing a path on this page, going to another screen
   * and pressing a button there. Two places for one plugin is one of them being the wrong
   * guess, so both lists arrive together and one page draws them. Absent when the manifest
   * declares no panel, which most plugins do not.
   */
  panel?: { label: string; widgets: Rendered[] }
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

/**
 * Read-only widgets: the plugin drives them, the user cannot type into them.
 *
 * The list was `status | progress | action | table | graph` and stayed that way while `image`,
 * `cards` and the row-filling widgets after them arrived — the same list-somebody-has-to-
 * remember-to-extend that invariant 13 was written about. So the rule is stated instead: a
 * widget that fills itself from a tool is not one you type into, whatever it is called.
 */
const DRIVEN = new Set(['status', 'progress', 'action'])

const driven = (declared: Setting): boolean => DRIVEN.has(declared.type) || 'rows' in declared

export interface PaneOptions {
  store: Store
  /** Whether the user has said yes to it (M2-5). Absent means yes, for callers with no view. */
  enabled?(pluginId: string): boolean
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

/**
 * Every widget this plugin declared, in either list.
 *
 * `settings` and `panel.widgets` are one namespace (D86) because a widget's value is stored
 * once. So *is this key declared* has one answer, and the two places that ask it — an edit
 * arriving and a button being pressed — get it from here rather than each searching the list
 * they happen to know about. Since D118 the two lists are also one page, which is what the
 * namespace was already describing.
 */
export function declaredWidgets(manifest: Manifest): Setting[] {
  return [...(manifest.settings ?? []), ...(manifest.panel?.widgets ?? [])]
}

/**
 * Every `action` this plugin declared, by key — the buttons and the row actions on its
 * tables, which are the same thing pressed in a different place (D83).
 *
 * The manifest forbids two of them sharing a key, so this is a lookup rather than a search
 * with a tie-break: a press has one meaning.
 *
 * **Any widget that has row actions, not a list of the ones that did.** It used to test
 * `type === 'table'`, which was true when `table` was the only widget with rows under it and
 * quietly false from the day `cards` arrived — so every button on every card answered *there
 * is no action called that*. The identical mistake in the identical shape one function down
 * is what invariant 13 was written about; the rule is stated here instead of the list.
 */
export function declaredAction(
  manifest: Manifest,
  key: string,
): { tool: string; row: boolean } | undefined {
  for (const widget of declaredWidgets(manifest)) {
    if (widget.type === 'action' && widget.key === key) return { tool: widget.tool, row: false }
    if (!('rowActions' in widget)) continue
    const found = widget.rowActions?.find((one) => one.key === key)
    if (found) return { tool: found.tool, row: true }
  }
  return undefined
}

/**
 * A widget this plugin declared that fetches its own contents, by key — a `table` or a
 * `graph` (D115).
 *
 * One function rather than two because `/api/rows` and `/api/detail` ask the same two
 * questions of both: *which tool answers with the contents*, and *which one says more about
 * one of them*. A second lookup would be a second place to forget a widget type.
 */
/**
 * The widget a `/api/rows` or `/api/detail` call is asking about, by its key.
 *
 * **Every widget that fills itself from a tool belongs here, and two did not.** The list was
 * `table | graph` and stayed that way while `image` (D132) and `cards` (D141) were added, so
 * core answered *there is no list called that* for both — which is what the picture gallery has
 * been saying since the day it shipped. The name says `table` and the rule is *anything with a
 * `rows` tool*, so it is written as that rather than as a list somebody has to remember to
 * extend the next time a widget grows one.
 */
export function declaredTable(
  manifest: Manifest,
  key: string,
): Extract<Setting, { rows: string }> | undefined {
  const found = declaredWidgets(manifest).find((widget) => widget.key === key)
  return found !== undefined && 'rows' in found && typeof found.rows === 'string' ?
      (found as Extract<Setting, { rows: string }>)
    : undefined
}

/**
 * A declared list of widgets, filled in with what core knows right now.
 *
 * Called twice for one plugin — once for `settings` and once for `panel.widgets` — because
 * they are two halves of one page, and a second renderer would be a second set of rules
 * about `password`.
 */
export async function render(
  manifest: Manifest,
  declaredList: readonly Setting[],
  options: PaneOptions,
): Promise<Rendered[]> {
  const stored = options.store.settings(manifest.id)
  const tools = options.tools(manifest.id)
  const where = secretStoreName(options.platform)

  /**
   * What every widget on this page holds, both halves of it.
   *
   * Both, because `settings` and `panel.widgets` are one namespace (D86) and `when` names a
   * key rather than a list — a panel widget gated on a setting above it is the ordinary case
   * and would be the one that quietly never drew if this only looked at the list being
   * rendered.
   */
  const all = declaredWidgets(manifest)
  const valueOf = (key: string): unknown => {
    const found = all.find((widget) => widget.key === key)
    return stored[key] ?? (found !== undefined && 'default' in found ? found.default : undefined)
  }

  /**
   * Whether the widget behind this key holds anything.
   *
   * A `password` is the one whose value core does not have, and it is also the common case
   * for `needs` — *this engine needs a key* — so it is asked of the keychain rather than
   * guessed from an empty string that is empty for a different reason.
   */
  const filled = async (key: string): Promise<boolean> => {
    if (all.find((widget) => widget.key === key)?.type === 'password') {
      return options.hasSecret(manifest.id, key)
    }
    const value = valueOf(key)
    if (Array.isArray(value)) return value.length > 0
    return value !== undefined && value !== '' && value !== false
  }

  /** Which widgets some other widget's existence, or an option's availability, depends on. */
  const gating = new Set<string>()
  for (const widget of all) {
    if (widget.when !== undefined) gating.add(widget.when.key)
    if (widget.type !== 'choice') continue
    for (const one of widget.options) {
      if (typeof one !== 'string' && one.needs !== undefined) gating.add(one.needs)
    }
  }

  const settings: Rendered[] = []
  for (const declared of declaredList) {
    // Gone rather than greyed. A widget that does not apply to what is chosen never reaches
    // the screen, which is the whole of what this page was asked to become.
    if (declared.when !== undefined) {
      const wanted = Array.isArray(declared.when.is) ? declared.when.is : [declared.when.is]
      if (!wanted.includes(String(valueOf(declared.when.key) ?? ''))) continue
    }
    const gates = gating.has(declared.key) ? { gates: true } : {}

    if (declared.type === 'choice') {
      // `needs` answered against what is actually stored. Dimmed and explained rather than
      // dropped: the person who cannot pick this is the one who needs to know what to do.
      const resolved = []
      for (const one of declared.options) {
        if (typeof one === 'string' || one.needs === undefined) {
          resolved.push(one)
          continue
        }
        // The author's `reason` is taken out of the spread rather than left in it: a sentence
        // saying why this cannot be picked, riding on an option that can be, is a page
        // carrying an answer to a question nobody is asking.
        const { reason, ...rest } = one
        const there = await filled(one.needs)
        resolved.push({
          ...rest,
          available: there && one.available !== false,
          ...(there ? {} : { reason: reason ?? `Needs “${all.find((w) => w.key === one.needs)?.label ?? one.needs}”.` }),
        })
      }
      settings.push({ ...declared, options: resolved, ...gates, ...(stored[declared.key] !== undefined || declared.default !== undefined ? { value: stored[declared.key] ?? declared.default } : {}) })
      continue
    }
    if (declared.type === 'password') {
      // The secret itself is not put on the screen. What the screen needs is whether there is
      // one and which store holds it — the two facts a person actually wants, and neither of
      // them is the secret. (Invariant 8 caught the first draft of this comment, which said
      // something stronger about where the value goes than this module can promise.)
      settings.push({ ...declared, ...gates, set: await options.hasSecret(manifest.id, declared.key), stored: where })
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
        ...gates,
        available: !missing,
        ...(missing && { reason: `${manifest.name} has no tool called "${declared.tool}" right now.` }),
      })
      continue
    }
    if (declared.type === 'progress') {
      const live = options.progress(manifest.id)
      settings.push({ ...declared, ...gates, ...(live && { live }) })
      continue
    }
    const value = stored[declared.key] ?? ('default' in declared ? declared.default : undefined)
    settings.push({ ...declared, ...gates, ...(value !== undefined && { value }) })
  }
  return settings
}

/** One plugin's page: its chrome, its form filled in, and its panel under it (D118). */
export async function pane(manifest: Manifest, options: PaneOptions): Promise<Pane> {
  return {
    id: manifest.id,
    name: manifest.name,
    summary: manifest.summary,
    version: manifest.version,
    license: manifest.license,
    enabled: options.enabled?.(manifest.id) ?? true,
    running: options.running(manifest.id),
    requires: manifest.requires?.map((r) => ({ cap: r.cap, why: r.why })) ?? [],
    settings: await render(manifest, manifest.settings ?? [], options),
    // Rendered by the same function as the settings above it, which is what stops the two
    // halves of one page drifting into two sets of rules about where a `password` goes.
    ...(manifest.panel !== undefined && {
      panel: {
        label: manifest.panel.label,
        widgets: await render(manifest, manifest.panel.widgets, options),
      },
    }),
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
  if (driven(declared)) {
    if (declared.type === 'action') return `"${declared.label}" is a button, not a value.`
    // A table is edited a row at a time, through the actions its author declared on it.
    if (declared.type === 'table') return `"${declared.label}" is a list, not a value.`
    return `"${declared.label}" is driven by the plugin, not by you.`
  }
  // The one value the user has but core writes. Its bytes arrive at `/api/upload`, which puts
  // them somewhere safe and stores the path it made — so a path arriving here instead is a
  // page asking core to remember somewhere nobody uploaded anything to.
  if (declared.type === 'file') return `"${declared.label}" is a file you choose, not a path you type.`

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

    case 'choice': {
      const values = declared.options.map(optionValue)
      return values.includes(value as string) ? undefined : `"${String(value)}" is not one of ${values.join(', ')}.`
    }

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
