// SPDX-License-Identifier: AGPL-3.0-only
import type { Manifest } from '@alexia/protocol'
import { render, type PaneOptions, type Rendered } from './settings.js'

/**
 * The control surface's tab list, assembled (M6-2).
 *
 * **This is M0's rule one screen later.** Core contributes the tabs whose data core owns.
 * Every other tab is here because a plugin declared a `panel` in its manifest and somebody
 * enabled that plugin — and for no other reason. Nothing in this file knows a plugin's name,
 * and there is no list of tabs anywhere that a person types into.
 *
 * That is not tidiness. The previous Alexia's dashboard listed nine tabs by hand in one
 * `App.tsx`, and one of them was a 480-line panel for a single text-to-speech vendor living
 * in the dashboard's own source tree. That is this project's founding complaint arriving by
 * the back door: not a feature you cannot remove, but a feature core cannot stop naming. A
 * dashboard is where an architecture like this usually breaks, because it is the one screen
 * that has to know about everything at once.
 *
 * **Nothing here spawns anything.** A panel draws from the manifest and the store, the same
 * way a settings pane does and for the same reason — with lazy spawn, *not running* is the
 * ordinary state of a plugin. Anything that genuinely needs the process is a tool call the
 * panel makes when somebody opens it, not a spawn at draw time. Core's own tabs work the
 * same way: their tables declare their shape here and fetch their rows on open.
 */

export interface Tab {
  /** Stable, and what the shell remembers between draws. */
  id: string
  label: string
  /** Core's own, or a plugin's. The shell draws both the same; only this says which. */
  from: 'core' | 'plugin'
  /** A plugin tab: whose. Absent on core's own, which belong to nobody. */
  plugin?: string
  /**
   * A plugin tab: whether its process is up.
   *
   * Enabled and not running is a **normal** state and reads as one. It is what lazy spawn
   * produces most of the time, and a tab that looked broken whenever nothing had called the
   * plugin lately would teach people to ignore the one that is actually broken.
   */
  running?: boolean
  /** The declared widgets, filled in. Core's tabs and a plugin's are the same shape. */
  widgets?: Rendered[]
  /**
   * A core tab whose panel is not built yet: what it will hold, and which task builds it.
   *
   * Deliberately a sentence rather than an empty pane. A blank tab is indistinguishable from
   * a broken one, and a placeholder that looked like working software would be worse than
   * either. These are deleted by the tasks named in them, and this field goes with the last.
   */
  soon?: string
}

/**
 * A `table` core owns, declared exactly the way a plugin declares one (M6-4).
 *
 * The point of writing them here rather than in the shell is the test M6-4 exists to run:
 * *if any of these needs a line of bespoke rendering, `table` was the wrong widget.* They
 * are configuration, and the shell draws them with the same function it draws a plugin's.
 *
 * `tool` on a row action names the operation core performs rather than an MCP tool. It is
 * the same string as `key`, and the shell sends the key either way — a press on a core table
 * reaches core's own dispatch, and a press on a plugin's reaches `rule()` and the plugin.
 */
const table = (declared: Extract<Rendered, { type: 'table' }>): Rendered => declared

const ACTIVITY: Rendered = table({
  type: 'table',
  key: 'activity',
  label: 'Runs',
  hint: 'The last five, in memory. They go when Alexia restarts — this was never meant to be a permanent log, and export is how one outlives it.',
  rows: 'activity',
  columns: [
    { key: 'task', label: 'What was asked' },
    { key: 'steps', label: 'Steps', align: 'right', hideNarrow: true },
    // What *that* cost, on the row that says what it was (M7-2). The ledger could answer
    // per session and per model before this and could not answer per run, which is the
    // question anybody actually has when a number surprises them.
    { key: 'cost', label: 'Cost', align: 'right' },
    { key: 'ended', label: 'How it ended' },
    { key: 'when', label: 'When', align: 'right', hideNarrow: true },
  ],
  // The second thing anybody does with a bad run is send it to somebody.
  rowActions: [{ key: 'export_run', label: 'Export', tool: 'export_run' }],
  detail: 'run',
  filter: true,
})

const SKILLS: Rendered = table({
  type: 'table',
  key: 'skills',
  label: 'Installed',
  rows: 'skills',
  columns: [
    { key: 'name', label: 'Name' },
    { key: 'where', label: 'Where from' },
    { key: 'state', label: 'State', hideNarrow: true },
  ],
  // One action, and it refuses on a bundled skill with a sentence rather than being absent:
  // *it came with something, and it goes when that does* is the answer to the question the
  // person is asking, and a missing button answers nothing.
  rowActions: [
    // The other end of the consent ladder (M6-9). A skill nobody has said yes to is not in
    // the model's index, and this is where the yes is given.
    { key: 'allow_skill', label: 'Allow', tool: 'allow_skill', confirm: 'Let Alexia use {name}?' },
    { key: 'forget_skill', label: 'Forget', tool: 'forget_skill', confirm: 'Forget {name}?' },
  ],
  detail: 'skill',
  filter: true,
})

const LEARNED: Rendered = table({
  type: 'table',
  key: 'learned',
  label: 'Written by Alexia',
  hint: 'Distilled from a task you watched happen. A learned skill can be wrong, which is why it says what it came from.',
  rows: 'learned',
  columns: [
    { key: 'name', label: 'Name' },
    { key: 'from', label: 'Learned from' },
    { key: 'state', label: 'State' },
    { key: 'when', label: 'When', align: 'right', hideNarrow: true },
  ],
  // The same two keys as the list above. A row action is looked up by key, so declaring
  // them twice on one screen would be a press with two meanings — hence `allow_here` and
  // `forget_here`, which reach the same two operations.
  rowActions: [
    { key: 'allow_here', label: 'Allow', tool: 'allow_skill', confirm: 'Let Alexia use {name}?' },
    { key: 'forget_here', label: 'Forget', tool: 'forget_skill', confirm: 'Forget {name}?' },
  ],
  detail: 'skill',
  filter: true,
})

const TOOLS: Rendered = table({
  type: 'table',
  key: 'tools',
  label: 'Tools',
  hint: 'Everything every enabled plugin puts in front of the model. Read-only: the plugins are the write path, and a second one here would be a parallel mechanism.',
  rows: 'tools',
  columns: [
    { key: 'name', label: 'Tool' },
    { key: 'kind', label: 'Kind', hideNarrow: true },
  ],
  detail: 'tool',
  filter: true,
  groupBy: 'plugin',
})

const LIBRARY: Rendered = table({
  type: 'table',
  key: 'library',
  label: 'Installed',
  hint: 'What is on this machine. Browsing, installing and removing are on the plugins screen, which owns the write path.',
  rows: 'library',
  columns: [
    { key: 'name', label: 'Name' },
    { key: 'version', label: 'Version', align: 'right', hideNarrow: true },
    { key: 'state', label: 'State' },
  ],
  detail: 'plugin',
  filter: true,
})

/**
 * Which model, chosen by hand rather than by the router (the Models tab).
 *
 * Grouped by provider because that is the shape of the question — each one publishes a
 * different list in a different format with different things left out, and putting them in
 * one flat run would imply a comparability that is not there. The columns are the four
 * facts a choice actually turns on: what it costs, how much it will read, and whether it
 * can be reached at all.
 */
const MODELS: Rendered = table({
  type: 'table',
  key: 'models',
  label: 'Models',
  hint: 'Each provider publishes its own list, and they do not agree on what to include — a blank column is something that provider does not say, not a zero. Use pins every request to one model; Automatic gives the choice back to the router.',
  rows: 'models',
  columns: [
    { key: 'name', label: 'Model' },
    { key: 'price', label: 'Per 1M in', align: 'right' },
    { key: 'context', label: 'Context', align: 'right', hideNarrow: true },
    { key: 'tier', label: 'Tier', align: 'right', hideNarrow: true },
    { key: 'state', label: 'State' },
  ],
  rowActions: [
    { key: 'use_model', label: 'Use', tool: 'use_model' },
    { key: 'automatic', label: 'Automatic', tool: 'automatic' },
  ],
  detail: 'model',
  filter: true,
  groupBy: 'provider',
})

/**
 * The tabs whose data core owns, in the order they are read rather than built.
 *
 * *Activity* first because *what has this been doing* is the question that brings somebody
 * to this screen. The rest follow it: what it knows, what it can do, what is installed.
 */
export const CORE_TABS: readonly { id: string; label: string; soon?: string; widgets?: Rendered[] }[] = [
  { id: 'activity', label: 'Activity', widgets: [ACTIVITY] },
  { id: 'skills', label: 'Skills', widgets: [SKILLS, LEARNED] },
  { id: 'tools', label: 'Tools', widgets: [TOOLS] },
  { id: 'models', label: 'Models', widgets: [MODELS] },
  { id: 'library', label: 'Library', widgets: [LIBRARY] },
]

/** Which core table a `rows` or `detail` name belongs to. Used to reject an unknown one. */
export const CORE_TABLES: readonly string[] = CORE_TABS.flatMap((tab) =>
  (tab.widgets ?? []).flatMap((widget) => (widget.type === 'table' ? [widget.key] : [])),
)

export interface TabOptions extends PaneOptions {
  /** Every installed plugin's manifest, enabled or not. The rule below is core's, not the caller's. */
  manifests: readonly Manifest[]
}

/** Core's tabs, then everyone else's. */
export async function tabs(options: TabOptions): Promise<Tab[]> {
  const theirs: Tab[] = []
  for (const manifest of options.manifests) {
    if (manifest.panel === undefined) continue
    // A folder appearing is not consent (D73). Installed and not enabled has no tab at all —
    // not a greyed-out one, because a tab that is there and does nothing is a question.
    if (options.enabled?.(manifest.id) === false) continue
    theirs.push({
      id: `plugin:${manifest.id}`,
      label: manifest.panel.label,
      from: 'plugin',
      plugin: manifest.id,
      running: options.running(manifest.id),
      widgets: await render(manifest, manifest.panel.widgets, options),
    })
  }
  // By label, so the row does not reorder itself because a folder was read in a different
  // order. Nothing about install time is visible on this screen, so nothing should depend on it.
  theirs.sort((a, b) => a.label.localeCompare(b.label))

  return [...CORE_TABS.map((tab) => ({ ...tab, from: 'core' as const })), ...theirs]
}
