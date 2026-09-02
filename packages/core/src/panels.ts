// SPDX-License-Identifier: AGPL-3.0-only
import { pins } from './commands.js'
import type { Rendered } from './settings.js'
import type { Store } from './store.js'

/**
 * The control surface's tab list (M6-2, narrowed by D118).
 *
 * **Every tab here is one whose data core owns**, and there is still no list anywhere that a
 * person types into: a tab exists because core has a table to put on it. Until D118 a plugin
 * could declare a `panel` and get a tab of its own beside these, which meant one plugin had
 * two homes — its settings on the plugins page and its panel over here — and no way for
 * anybody to guess which held the thing they were after. A plugin's panel is now the second
 * half of its own page, drawn by `pane()` in `settings.ts`, and this screen is core's alone.
 *
 * **The rule that put plugin tabs here in the first place did not move.** The previous
 * Alexia's dashboard listed nine tabs by hand in one `App.tsx`, and one of them was a
 * 480-line panel for a single text-to-speech vendor living in the dashboard's own source
 * tree — this project's founding complaint arriving by the back door. What stops that is
 * that no screen in core names a plugin, and the plugins page is assembled from manifests
 * exactly the way this list used to be. Deleting a folder still takes its page with it.
 *
 * **Nothing here spawns anything.** A tab draws from the store and declares its tables;
 * their rows are fetched when somebody opens it, never at draw time.
 */

export interface Tab {
  /** Stable, and what the shell remembers between draws. */
  id: string
  label: string
  /** The declared widgets, filled in. */
  widgets?: Rendered[]
  /**
   * A tab whose panel is not built yet: what it will hold, and which task builds it.
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

/**
 * Every conversation, and the way back into one (M8-2).
 *
 * **The only core tab that is not a report.** The other five say what Alexia has been doing;
 * this one is the doing. It is a `table` like the rest — the widget was built for exactly
 * this shape and a conversation list is the case it was always going to meet.
 *
 * *New chat* is a plain `action` above the table rather than a row action, because it is the
 * one thing on this screen that is not about a row that already exists.
 */
const CHATS: Rendered[] = [
  {
    type: 'action',
    key: 'new_chat',
    label: 'New chat',
    tool: 'new_chat',
    hint: 'Starts an empty conversation and opens it. Pressing it twice does nothing the second time — an empty chat is reused rather than stacked.',
  },
  table({
    type: 'table',
    key: 'chats',
    label: 'Conversations',
    hint: 'Named by the first thing you said in each — Alexia does not write a title for them, because your own words are already on disk and a second name is a second thing that can be wrong. Open one and press Back to be in it. Forget takes everything said in it, and refuses on the one you are in.',
    rows: 'chats',
    columns: [
      { key: 'title', label: 'Chat' },
      { key: 'turns', label: 'Turns', align: 'right', hideNarrow: true },
      { key: 'when', label: 'Last said', align: 'right', hideNarrow: true },
      { key: 'state', label: 'State' },
    ],
    rowActions: [
      { key: 'open_chat', label: 'Open', tool: 'open_chat' },
      { key: 'forget_chat', label: 'Forget', tool: 'forget_chat', confirm: 'Forget “{title}” and everything in it?' },
    ],
    detail: 'chats',
    filter: true,
  }),
]

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

/**
 * Which model, chosen by hand rather than by the router (the Models tab).
 *
 * Grouped by provider because that is the shape of the question — each one publishes a
 * different list in a different format with different things left out, and putting them in
 * one flat run would imply a comparability that is not there. The columns are the four
 * facts a choice actually turns on: what it costs, how much it will read, and whether it
 * can be reached at all.
 */
/**
 * The routing ladder, above the table (D112).
 *
 * **What *recommended* was hiding.** The ★ has always been the router's own answer rather
 * than a second opinion, which made it honest and left it unmoveable: the rule behind it is
 * *cheapest that fits*, and the word people read on the screen is *recommended*, which means
 * free to one person and best to the one paying. So the setting everybody thought they were
 * looking at did not exist, and the one that did was not on the screen.
 *
 * Two controls and no third. The slider says **which side of the price line may answer** —
 * the question the word *recommended* was quietly answering for everybody — and the ladder
 * under it says **in what order**, as a shortlist somebody drags rather than a catalog of
 * four hundred rows with a number typed beside each. Everything left off it still answers,
 * behind the list, exactly as before; a preference screen you have to finish is a preference
 * screen nobody starts.
 */
const LADDER: Rendered = {
  type: 'ladder',
  key: 'routing',
  label: 'What may answer, and in what order',
  hint:
    'The slider is the money question, and it is a wall rather than a preference: on the left nothing that costs money is ever asked, even when every free model is rate-limited — Alexia says so instead. ' +
    'The middle is what Automatic always did, and it is the default: free first, paid only when the free rungs are gone, with one plain line before the first charge. ' +
    'The lists under it are your own running order within each side. Drag to reorder, and anything you do not list still answers behind the ones you did, cheapest first — so an empty list is the same behaviour this screen had before you touched it.',
  rows: 'routing',
  stops: [
    {
      value: 'free',
      label: 'Free only',
      hint: 'Nothing is ever billed. When every free model is busy or too small, Alexia says so rather than reaching for one that costs money.',
    },
    {
      value: 'mixed',
      label: 'Free, then paid',
      hint: 'The free models answer until they are rate-limited or cannot do the job, then the cheapest paid one does — and says one line before it charges you.',
    },
    {
      value: 'paid',
      label: 'Paid only',
      hint: 'Every request is billed to a provider you connected. The free tiers are left alone, which is what you want when they are the thing making answers slow.',
    },
  ],
  chose: 'set_spend',
  ordered: 'set_order',
}

const MODELS: Rendered = table({
  type: 'table',
  key: 'models',
  label: 'Models',
  hint:
    'Normally Alexia picks a model per request — the cheapest one that can do the job, falling to the next when one is rate-limited. That is Automatic, and it is what happens when nothing here is chosen. ' +
    'The ★ is the one Automatic would pick right now for a request that needs tools: it is the router’s own answer rather than a second opinion, so it moves when your keys, the catalog, a rate limit — or the slider above — move. ' +
    '"Tokens / week" is how much the whole world put through that model in the provider’s last published week, refreshed daily and again whenever you open this tab. ' +
    'Only OpenRouter publishes that figure today, so every other provider shows a dash there and its models are ordered by price instead — a dash means nobody says, not nobody uses it. ' +
    'Use sends every request to one model instead, until you press Automatic on any row to hand the choice back. The chosen row is marked and coloured. ' +
    'Only providers you have connected are listed, so this is what you can actually send a request to right now — add a key in settings and that provider’s models appear here. ' +
    'Each provider publishes its own list and they do not agree on what to include, so a dash is something that provider does not say rather than a zero.',
  rows: 'models',
  columns: [
    { key: 'name', label: 'Model' },
    { key: 'price', label: 'Per 1M in', align: 'right' },
    // How much the world put through it last week. Only one provider publishes this, which
    // is why the sentence above the table says so — an empty column on six providers looks
    // like a bug, and *nobody publishes this* is the fact that stops it looking like one.
    { key: 'week', label: 'Tokens / week', align: 'right' },
    { key: 'context', label: 'Context', align: 'right', hideNarrow: true },
    { key: 'tier', label: 'Tier', align: 'right', hideNarrow: true },
    { key: 'state', label: 'State' },
  ],
  rowActions: [
    { key: 'use_model', label: 'Use this', tool: 'use_model' },
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
 * to this screen. The rest follow it: what it knows, and what it can do.
 *
 * **There is no Library tab here any more (M8-3), and no plugin tabs either (D118).** The
 * first was a read-only copy of a list the settings screen owns the write path for; the
 * second was a plugin's second home, one screen away from the settings that drive it. One
 * thing in two places is one of them being out of date, and both moved the same way — onto
 * the page that already owned the write path. `library` is still a source in `surface.ts`,
 * because the palette indexes it: what moved is the screen it opens, not the read.
 */
export const CORE_TABS: readonly { id: string; label: string; soon?: string; widgets?: Rendered[] }[] = [
  // First, and ahead of *Activity*, because it is the only tab somebody opens mid-sentence:
  // the others are read after the fact, and this one is a way back into what you were saying.
  { id: 'chats', label: 'Chats', widgets: CHATS },
  { id: 'activity', label: 'Activity', widgets: [ACTIVITY] },
  { id: 'skills', label: 'Skills', widgets: [SKILLS, LEARNED] },
  { id: 'tools', label: 'Tools', widgets: [TOOLS] },
  { id: 'models', label: 'Models', widgets: [LADDER, MODELS] },
]

/** Which core table a `rows` or `detail` name belongs to. Used to reject an unknown one. */
export const CORE_TABLES: readonly string[] = CORE_TABS.flatMap((tab) =>
  (tab.widgets ?? []).flatMap((widget) => (widget.type === 'table' ? [widget.key] : [])),
)

export interface TabOptions {
  /** Where the standing choices live. The only thing on this screen that is not a declaration. */
  store: Store
}

/**
 * The tabs, filled in.
 *
 * These are declarations rather than a render pass — they hold no plugin's stored values, so
 * there is nothing to fill in. The one exception is the ladder's own setting (D112), which is
 * a pin rather than a plugin setting and so has nowhere else to arrive from: the rows come
 * from `/api/rows` when the widget is drawn, and the slider's position has to be right on the
 * first paint or the screen opens showing the wrong answer.
 */
export function tabs(options: TabOptions): Tab[] {
  const standing = pins(options.store)
  const live = (widget: Rendered): Rendered =>
    widget.type === 'ladder' ? { ...widget, value: standing.spend ?? 'mixed' } : widget

  return CORE_TABS.map((tab) => ({ ...tab, widgets: tab.widgets?.map(live) }))
}
