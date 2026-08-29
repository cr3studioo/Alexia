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
 * panel makes when somebody opens it, not a spawn at draw time.
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
  /** A plugin tab: its declared widgets, filled in. */
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
 * The tabs whose data core owns, in the order they are read rather than built.
 *
 * *Activity* first because *what has this been doing* is the question that brings somebody
 * to this screen. The rest follow it: what it knows, what it can do, what is installed.
 */
export const CORE_TABS: readonly { id: string; label: string; soon?: string }[] = [
  {
    id: 'activity',
    label: 'Activity',
    soon: 'What Alexia has been doing: the last few runs, every step, and what each one cost. The trace exists and streams already — this is the half that outlives the task that made it. M6-5.',
  },
  {
    id: 'skills',
    label: 'Skills',
    soon: 'Every skill installed, where it came from, and the ones Alexia wrote for itself. M6-4.',
  },
  {
    id: 'tools',
    label: 'Tools',
    soon: 'Every tool every enabled plugin puts in front of the model — the only screen that answers what Alexia can actually do right now. M6-4.',
  },
  {
    id: 'library',
    label: 'Library',
    soon: 'What is installed, what the registry has, and what has an update. It is on the plugins screen today and moves here with the skills list. M6-4.',
  },
]

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
