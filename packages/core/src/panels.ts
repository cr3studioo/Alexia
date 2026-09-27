// SPDX-License-Identifier: AGPL-3.0-only
import { pins } from './commands.js'
import { SAYS } from './health.js'
import { keylessOn, speedOf } from './pool.js'
import { caps } from './usage.js'
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
   * Which sheet draws it (D205). Absent is Activity, which holds what happened; `settings` is
   * a core section drawn inside a Settings page, which holds what you choose. The shell reads
   * this and nothing else to decide, so moving a section is one word here.
   */
  screen?: 'settings'
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
  hint: 'What Alexia did for each thing you asked, newest first. She keeps the last 200 for up to 30 days. Export saves one as a file you can send.',
  rows: 'activity',
  columns: [
    { key: 'task', label: 'What was asked' },
    // Tool calls, which is what a step is here — *Steps* read as the steps of the task.
    { key: 'steps', label: 'Tools used', align: 'right', hideNarrow: true },
    // What *that* cost, on the row that says what it was (M7-2). The ledger could answer
    // per session and per model before this and could not answer per run, which is the
    // question anybody actually has when a number surprises them.
    { key: 'cost', label: 'Cost', align: 'right' },
    { key: 'ended', label: 'How it ended' },
    { key: 'when', label: 'When', align: 'right', hideNarrow: true },
  ],
  // The second thing anybody does with a bad run is send it to somebody. The first is going
  // back to the conversation it happened in.
  rowActions: [
    { key: 'open_run_chat', label: 'Open chat', tool: 'open_run_chat' },
    { key: 'export_run', label: 'Export', tool: 'export_run' },
  ],
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
    hint: 'Starts an empty conversation and opens it.',
  },
  table({
    type: 'table',
    key: 'chats',
    label: 'Conversations',
    hint: 'Each chat is named by the first thing you said in it. Open takes you back into one; Forget deletes it for good.',
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

/**
 * What a skill that nobody has said yes to says in its State column (M6-9). One constant, because
 * the *Allow* button is shown only on rows that say exactly this, and a second spelling in
 * `surface.ts` would quietly hide the button everywhere.
 */
export const WAITING = '▲ waiting for your yes'

/**
 * Every skill, in one list (D205).
 *
 * Installed skills and the ones Alexia wrote herself used to be two tables on an Activity tab,
 * and a third list on the General page that disagreed with both. They are one thing to the
 * person looking — instructions Alexia can read — so they are one table on the Skills page,
 * and *Where from* says which kind each is.
 */
const SKILLS: Rendered = table({
  type: 'table',
  key: 'skills',
  label: 'Your skills',
  hint: 'A skill is written instructions Alexia can read. One that says “waiting for your yes” is not used until you press Allow. Forget deletes it.',
  rows: 'skills',
  columns: [
    { key: 'name', label: 'Name' },
    { key: 'where', label: 'Where from' },
    { key: 'state', label: 'State', hideNarrow: true },
  ],
  // Forget refuses on a bundled skill with a sentence rather than being absent: *it came with
  // something, and it goes when that does* is the answer to the question the person is asking.
  rowActions: [
    // The other end of the consent ladder (M6-9), and only where there is a yes to give.
    { key: 'allow_skill', label: 'Allow', tool: 'allow_skill', confirm: 'Let Alexia use {name}?', when: { field: 'state', is: WAITING } },
    { key: 'forget_skill', label: 'Forget', tool: 'forget_skill', confirm: 'Forget {name}?' },
  ],
  detail: 'skill',
  filter: true,
})

const TOOLS: Rendered = table({
  type: 'table',
  key: 'tools',
  label: 'Tools',
  hint: 'Every tool your plugins give Alexia. To change one, open that plugin.',
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
 * The routing ladder, above the table (D112, D155).
 *
 * **What *recommended* was hiding.** The ★ has always been the router's own answer rather
 * than a second opinion, which made it honest and left it unmoveable: the rule behind it is
 * *cheapest that fits*, and the word people read on the screen is *recommended*, which means
 * free to one person and best to the one paying. So the setting everybody thought they were
 * looking at did not exist, and the one that did was not on the screen.
 *
 * Two controls and no third. The slider says **which side of the price line may answer** —
 * the question the word *recommended* was quietly answering for everybody — and the ladder
 * under it says **which models, in what order**, as a short list somebody drags rather than a
 * catalog of four hundred rows with a number typed beside each. **Empty is Automatic**, so a
 * preference screen nobody finishes is still a working one. D112 let everything left off the
 * list answer behind it; D155 turned that round, because somebody who chose three models did
 * not choose the other four hundred — the list is the plan, and it stops at its end.
 */
const LADDER: Rendered = {
  type: 'ladder',
  key: 'routing',
  label: 'What may answer, and in what order',
  hint: 'The slider decides whether Alexia may spend money. Put models in the lists to choose which answer, in order; leave them empty and she picks the best one the slider allows.',
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
      hint: 'The free models answer until they are busy or cannot do the job. Then the cheapest paid one does, and she tells you before you are charged.',
    },
    {
      value: 'paid',
      label: 'Paid only',
      hint: 'Every answer is paid for, through an AI service you connected. Good when the free models are what makes answers slow.',
    },
  ],
  chose: 'set_spend',
  ordered: 'set_order',
  crossing: 'set_cross',
  floor: 'set_keyless',
  speed: 'set_speed',
}

/**
 * **The Models table's four groups** (D161), in the order they are drawn. `surface.ts` names each
 * row's group from here and the declaration's `groupOrder` reads the same list, so the two cannot
 * spell a group differently and quietly put it at the end.
 */
export const MODEL_GROUPS = {
  chosen: 'Your choice',
  listed: 'Your list',
  automatic: 'Automatic, free',
  aside: 'Set aside by Alexia',
  paid: 'Paid',
} as const

const MODELS: Rendered = table({
  type: 'table',
  key: 'models',
  label: 'Models',
  hint: 'Every model you can reach, in the order Alexia would ask them. Use this sends every request to one model until you press Automatic.',
  rows: 'models',
  columns: [
    // The place in its group, and the ★ or ◆ when the row is one.
    { key: 'rank', label: '#', align: 'right' },
    { key: 'name', label: 'Model, and why it is here' },
    { key: 'via', label: 'Where', hideNarrow: true },
    { key: 'size', label: 'Size', align: 'right', hideNarrow: true },
    { key: 'can', label: 'What it can do', hideNarrow: true },
    // How much the world put through it last week, and whose figure it is when it was lent.
    { key: 'week', label: 'Used worldwide, last week', align: 'right', hideNarrow: true },
    { key: 'answered', label: 'Answered here', align: 'right' },
    { key: 'price', label: 'Price per 750k words sent', align: 'right', hideNarrow: true },
    { key: 'tags', label: 'Tags' },
  ],
  rowActions: [
    { key: 'use_model', label: 'Use this', tool: 'use_model' },
    { key: 'automatic', label: 'Automatic', tool: 'automatic' },
  ],
  detail: 'model',
  filter: true,
  groupBy: 'group',
  groupOrder: Object.values(MODEL_GROUPS),
  /**
   * What each group is, said once under its heading rather than in the table's hint, where the
   * five of them together were a paragraph nobody reads to find the one line they wanted.
   */
  groupNotes: {
    [MODEL_GROUPS.chosen]: 'Every request goes to this one until you press Automatic. It never falls back: if it cannot answer, Alexia stops and says why.',
    [MODEL_GROUPS.listed]: 'Your own running order. While anything is listed here, only these models answer, each one tried when the one above it fails.',
    [MODEL_GROUPS.automatic]: 'What Automatic walks for an ordinary free request, best first. The sentence under a row says why it sits below the one above.',
    [MODEL_GROUPS.aside]: 'Models Alexia stopped asking on her own: after repeated refusals or empty answers, or when one was retired or now needs a key. One good reply brings a model back.',
    [MODEL_GROUPS.paid]: 'The order Automatic would pay in, once the free models are done and the slider allows it: tools first, then cheapest.',
  },
  /**
   * The mock-up's three chips (D161). Each is a question somebody arrives at this table already
   * asking — *what is broken*, *what is new*, *what has Alexia given up on* — and each is one
   * press rather than a word typed into the filter box and spelled right.
   */
  chips: [
    { key: 'attention', label: 'Needs attention', tags: [SAYS.errors, SAYS.bad, SAYS.busy] },
    { key: 'new', label: 'New', tags: [SAYS.untested] },
    { key: 'aside', label: 'Set aside', group: MODEL_GROUPS.aside },
  ],
})

/**
 * The sections whose data core owns, and which sheet draws each (D205).
 *
 * **Settings = things you choose. Activity = things that happened.** Activity is *Runs* and
 * *Chats* and nothing else — the two records of what Alexia has done. The money ladder and the
 * model table, the skills and the list of every tool are choices or configuration, so they
 * are drawn inside Settings pages (`screen: 'settings'`), by the same renderer, from this same
 * list. Until D205 they were Activity tabs, and a person looking for *how much may she spend*
 * had to know it sat behind a button called Activity.
 *
 * **There is no Library tab here any more (M8-3), and no plugin tabs either (D118).** One thing
 * in two places is one of them being out of date. `library` is still a source in `surface.ts`,
 * because the palette indexes it: what moved is the screen it opens, not the read.
 */
export const CORE_TABS: readonly { id: string; label: string; soon?: string; widgets?: Rendered[]; screen?: 'settings' }[] = [
  // First, because *what has she been doing* is the question that brings somebody to Activity.
  { id: 'runs', label: 'Runs', widgets: [ACTIVITY] },
  { id: 'chats', label: 'Chats', widgets: CHATS },
  // Drawn on Settings pages. The ids are the page names the palette and the rail open.
  { id: 'models', label: 'Models & money', widgets: [LADDER, MODELS], screen: 'settings' },
  { id: 'skills', label: 'Skills', widgets: [SKILLS], screen: 'settings' },
  { id: 'tools', label: 'Every tool', widgets: [TOOLS], screen: 'settings' },
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
    widget.type === 'ladder' ?
      {
        ...widget,
        value: standing.spend ?? 'mixed',
        cross: caps(options.store).cross === true,
        daily: caps(options.store).daily ?? 0,
        keyless: keylessOn(options.store),
        fastest: speedOf(options.store) === 'fastest',
      }
    : widget

  return CORE_TABS.map((tab) => ({ ...tab, widgets: tab.widgets?.map(live) }))
}
