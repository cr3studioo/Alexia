// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'
import { APP_VERSION, newer } from './version.js'

/**
 * `plugin.json` v1 — the file core reads **before the plugin process exists**.
 *
 * The document this implements is `docs/spec/manifest.md`. Where the two disagree, the
 * document is the brief and this file is the bug.
 *
 * Two layers on purpose:
 *
 * - {@link ManifestShape} is plain structure, and is what `z.toJSONSchema` turns into the
 *   editor-facing JSON Schema. Nothing in it needs to look at another field.
 * - {@link Manifest} adds the cross-field rules a JSON Schema cannot express. Core
 *   validates with this one.
 */

/**
 * The Alexia contract revisions core speaks. Not MCP's — see `mcp_protocol`.
 *
 * **Frozen at 2 on 2026-08-28 (M4-9).** M4 was where the contract was expected to crack,
 * and it cracked exactly once: lazy spawn assumed every plugin is something core calls
 * into, and a plugin receiving messages from *outside* is not (D77). `lifetime` is the
 * whole of the difference between 1 and 2, and it is additive — a plugin written against 1
 * loads unchanged and simply has no opinion about being stopped.
 *
 * From here on, **one revision back is supported**. `MIN` is what makes that a promise
 * rather than a habit, and raising it is what deprecating a revision looks like.
 * `docs/spec/versions.md` is the migration note.
 *
 * **3 on 2026-08-29 (D86).** `panel` — a plugin declaring a screen of its own, the same way
 * it declares settings. Additive again, and the promise being kept for the first time rather
 * than described: `MIN` rises with `MAX`, so a manifest declaring 1 now says so in a sentence
 * instead of loading. *(D118 moved where a panel is drawn — onto the plugin's own page,
 * under its settings — and left the field alone, so there was no revision in it.)*
 *
 * **4 on 2026-08-31 (D115).** `graph` — a widget for rows that point at each other. Additive
 * like the two before it, and **the floor did not rise with the ceiling this time.** The
 * promise above is that one revision back is *supported*, and supporting two costs nothing:
 * seven first-party plugins declare 2, use nothing from 3, and dropping them to make a point
 * about deprecation would be breaking working software to keep a number tidy. Raising `MIN`
 * is what deprecating a revision looks like, and there is nothing here worth deprecating.
 *
 * **5 on 2026-09-01.** `image` — a widget for pictures a plugin has made. Additive, and the
 * floor stays at 2 for the same reason it did last time: nothing below is worth deprecating,
 * and the plugins declaring 2 still work.
 *
 * **6 on 2026-09-01 (D141).** `cards` — things a plugin holds, drawn the way core draws
 * plugins.
 *
 * **7 on 2026-09-02.** Four at once, and they are one change: a page that shows what applies.
 * `when` on every widget, so a widget that does not apply is not drawn; `choice` options that
 * carry a sentence, so a choice that is really a decision reads as one; `file`, so a person
 * can point at a file rather than type where one is (D89's obstacle removed, not waived); and
 * `multiline` on `text`. All four are optional and none of them changes what an existing
 * manifest means, which is why the floor stays at 2 again.
 */
export const ALEXIA_PROTOCOL_MIN = 2
export const ALEXIA_PROTOCOL_MAX = 7

/**
 * The two MCP revisions core speaks, in preference order (D55, corrected by D57).
 *
 * `2025-11-25` is first because it is the one an Alexia plugin is built on: it is what the
 * reference SDK still treats as latest, and it is the last revision where a server may send
 * its host a request — which is the entire `alexia/*` layer. `2026-07-28` is accepted for
 * MCP servers that speak only it; on that revision the `alexia/*` layer is unavailable.
 */
export const MCP_REVISIONS = ['2025-11-25', '2026-07-28'] as const
/** What an Alexia plugin declares, and what `@alexia/sdk` serves. */
export const MCP_PINNED = MCP_REVISIONS[0]

/** Lowercase, hyphen-separated, and it must match the folder name. Mirrors agentskills.io. */
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
/** Dotted namespaces, LSP and MCP style: `voice.transcribe`, `fs.own_dir`. */
const CAPABILITY = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/
/**
 * A plain identifier: a setting key, a table name, a column name. SQLite-safe, so core can
 * build `p_<namespace>_<table>` without quoting and without parsing. Shared with the wire
 * schemas in `methods.ts` — one rule, written once.
 */
export const IDENT = /^[a-z][a-z0-9_]*$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
/** Shape only. Whether core *accepts* a revision is a separate check with a readable refusal. */
const MCP_REVISION = /^\d{4}-\d{2}-\d{2}$/

const id = z.string().min(1).max(64).regex(ID, 'lowercase letters, digits and hyphens only')

/**
 * **When this widget is on the page at all** (`alexia_protocol` 7).
 *
 * Every widget carries it, because *which of these apply* is a question about the page and
 * not about one kind of control. It names a sibling's key and the value or values that make
 * this one relevant; core reads the stored value before it renders, and a widget that does
 * not match never reaches the screen.
 *
 * **Hidden, not greyed.** A greyed control is a promise that something could be typed there,
 * and the page it produces is nineteen widgets of which four apply — which is the page this
 * arrived to fix. What is gone is gone, and the setting it depends on is the thing that
 * brings it back.
 *
 * It is not a general expression language and should not become one: one key, one set of
 * values, resolved by a string compare. A plugin that needs *and* has two settings, and a
 * plugin that needs arithmetic has a tool.
 */
const gated = {
  when: z
    .object({
      key: z.string().regex(IDENT),
      is: z.union([z.string(), z.array(z.string()).min(1)]),
    })
    .strict()
    .optional(),
}

/**
 * One option of a `choice`, either as a bare value or as a value with something to read.
 *
 * A bare string is what almost every choice is — three model sizes, two formats — and it
 * renders exactly as it always did. An object is for a choice that is really a **decision**:
 * four engines, each with a cost and a trade-off, where the difference between them is a
 * sentence rather than a word. Core draws those as stacked cards; that it does so is core's
 * call, exactly as segmented-versus-dropdown is.
 *
 * `needs` names another widget that must hold a value before this option can be picked, and
 * `reason` is the author's own sentence saying so. Core dims the card and shows the sentence
 * rather than hiding the option, for the same reason D120 dims a plugin that is not
 * installed: the person who cannot pick it is the person who needs to know what to do about it.
 */
const option = z.union([
  z.string().min(1),
  z
    .object({
      value: z.string().min(1),
      label: z.string().min(1),
      hint: z.string().min(1).optional(),
      needs: z.string().regex(IDENT).optional(),
      reason: z.string().min(1).max(160).optional(),
      /**
       * Whether it can be picked. Core computes this from `needs` and overwrites whatever is
       * here; declaring `false` outright is for an option that is permanently out on this
       * build, which is a thing an author knows and core does not.
       */
      available: z.boolean().optional(),
    })
    .strict(),
])

/** One `choice` option as it reaches the screen, whichever way it was declared. */
export type ChoiceOption = z.infer<typeof option>

/** The value a `choice` option stands for, however it was written. */
export const optionValue = (one: string | { value: string }): string =>
  typeof one === 'string' ? one : one.value

const setting = z.discriminatedUnion('type', [
  z.object({
    ...gated,
    type: z.literal('text'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    default: z.string().optional(),
    placeholder: z.string().optional(),
    /**
     * A box that takes more than a line (`alexia_protocol` 7).
     *
     * Not a new widget: it is the same value, saved the same way, and the only thing that
     * changes is how much of it you can see while you type. The case is a transcript — the
     * words somebody said in a fifteen-second clip, typed into a control that showed forty
     * characters of them.
     */
    multiline: z.boolean().optional(),
  }),
  z.object({
    // Never carries a default and never appears in a log or an export: core keeps the
    // value in the OS keychain and hands it back only to the plugin that declared it.
    ...gated,
    type: z.literal('password'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
  }),
  z.object({
    ...gated,
    type: z.literal('number'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    default: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
  }),
  z.object({
    ...gated,
    type: z.literal('toggle'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    default: z.boolean().optional(),
  }),
  z.object({
    ...gated,
    type: z.literal('choice'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    /** Bare strings, or {@link option} objects for a choice that is really a decision. */
    options: z.array(option).min(1),
    default: z.string().optional(),
  }),
  z.object({
    ...gated,
    type: z.literal('multi-choice'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    options: z.array(z.string().min(1)).min(1),
    default: z.array(z.string()).optional(),
  }),
  z.object({
    ...gated,
    type: z.literal('path'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    kind: z.enum(['file', 'dir']),
    // No default: an absolute path baked into a manifest is wrong on someone else's machine.
  }),
  z.object({
    ...gated,
    /**
     * The fifteenth widget: **a file somebody picks** (`alexia_protocol` 7).
     *
     * **Refused three times, and the obstacle that stopped it is gone rather than waived.**
     * D89's refusal was not about taste, it was arithmetic: *a browser will not tell a page
     * where a file is*, so a `file` widget could never fill a `path`, and a plugin that takes
     * paths would be handed a control that cannot produce one. Every argument since then went
     * round the same wall — including this plugin's own comment at `clone_voice`, which
     * accepted `path` because the alternative it was offered was building a wav recorder.
     *
     * What changed is that core grew the other half. `attach.ts` already takes bytes from a
     * browser, writes them somewhere safe, hands over a path, and enforces the ceilings — for
     * the composer, which D89 explicitly said did *not* carry this grant. It still does not
     * carry it on its own. What carries it is that **core creates the path, so nothing has to
     * be told where the file was**: the widget's stored value is an absolute path core wrote,
     * inside the asking plugin's own folder, and a plugin reads it exactly as it reads a
     * `path` today. `clone_voice` and `add_voice` needed no change at all.
     *
     * So this is not a way for a plugin to reach into a filesystem. It is a `path` whose value
     * a person produces by pointing at a file instead of by typing where one is, which is what
     * everybody asking for it meant.
     */
    type: z.literal('file'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    /**
     * What the picker offers, in the browser's own syntax — `.wav,.mp3` or `audio/*`.
     *
     * Advisory, as it is everywhere else: a picker that offers every file when one extension
     * works is a worse picker, and it is not a check. The plugin still refuses what it cannot
     * read, because the person can always choose *all files*.
     */
    accept: z.string().min(1).optional(),
  }),
  z.object({
    // Read-only. The plugin drives it; core renders whatever it last wrote.
    ...gated,
    type: z.literal('status'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
  }),
  z.object({
    ...gated,
    type: z.literal('progress'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
  }),
  z.object({
    // A button. Pressing it calls one of the plugin's own tools with no arguments.
    ...gated,
    type: z.literal('action'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    tool: z.string().min(1),
  }),
  z.object({
    /**
     * The eleventh widget: **a list of things with actions on each one** (D83, M6-3).
     *
     * `ui-schema.md` promised that an eleventh "is a conversation — open an issue saying
     * what the tenth could not do". This is the answer to that, and the evidence was
     * behavioural rather than aesthetic: the previous Alexia's dashboard hand-wrote this
     * exact object four times, and the second copy's own comment admits it *"mirrors
     * SkillsTab's own shape, since the lifecycle is identical by design"*. Four independent
     * copies of one shape is the strongest case this schema will ever be handed.
     *
     * **A row action is an `action`.** It goes through the permission gate M2-1 already
     * built and the question appears beside the row, where the thing being decided is. No
     * second gate and no new concept — which is what stopped this being a bigger idea than
     * it needed to be.
     */
    ...gated,
    type: z.literal('table'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    /**
     * The tool that answers with the rows. Called with no arguments when somebody opens the
     * panel — **not** while it is being drawn, because drawing must not start a process.
     * It answers `structuredContent: { rows: [...] }`, and every row carries a string `id`.
     */
    rows: z.string().min(1),
    columns: z
      .array(
        z
          .object({
            key: z.string().regex(IDENT),
            label: z.string().min(1),
            align: z.enum(['left', 'right']).optional(),
            /**
             * Dropped on a narrow screen. Seven columns on a 375px screen forced sideways
             * scrolling to reach the Delete button — usable in the sense that the scroll
             * stayed inside the table, and not usable at all in the sense that matters.
             */
            hideNarrow: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1),
    rowActions: z
      .array(
        z
          .object({
            key: z.string().regex(IDENT),
            label: z.string().min(1),
            /** Called with `{ id }` — the row's own. */
            tool: z.string().min(1),
            /**
             * A second press that has already said what goes, with `{column}` filled in from
             * the row. The old dashboard's Delete → Confirm delete, which is a good pattern
             * because the first press costs nothing and the second one is unambiguous.
             */
            confirm: z.string().min(1).max(160).optional(),
          })
          .strict(),
      )
      .optional(),
    /** A tool called with `{ id }`, whose text expands under the row. */
    detail: z.string().min(1).optional(),
    /** A filter box, applied in the page over the declared columns. */
    filter: z.boolean().optional(),
    /** A field to group rows under. It need not be a column — grouping is not showing. */
    groupBy: z.string().regex(IDENT).optional(),
  }),
  z.object({
    /**
     * The twelfth widget: **things that point at each other** (D115, M6-11).
     *
     * Refused twice before this, and both refusals were right at the time: `ui-schema.md`'s
     * bar is *more than one user* (D83), and when it was asked again the one user had no
     * edges to draw — flat sentences with a category, where a link would have to be inferred
     * and a picture of inferred similarity looks meaningful and is not (D90). M7-3 gave that
     * store **authored** links, which is the condition D90 named, and then somebody asked to
     * look at the shape of their own memory, which is the use G8 was waiting for.
     *
     * **It is granted on what the alternatives cost rather than on a second user.** The other
     * two answers were a bespoke canvas in the shell — which is core naming one plugin, this
     * project's founding complaint arriving by the back door — and a sandboxed iframe, which
     * is a plugin drawing its own pixels and every rule in `ui-schema.md` gone with it. A
     * widget core draws for anybody who declares one is the only answer of the three that
     * leaves the shell naming nobody.
     *
     * Deliberately barer than `table`. No columns, no grouping, no row actions: the fields a
     * node needs are fixed by the contract — `id`, `label`, `links`, and an optional `mark` —
     * because a graph offers no choices about column order that a reader would notice, and
     * every knob here would be one more thing an author can get wrong.
     */
    ...gated,
    type: z.literal('graph'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    /**
     * The tool that answers with the nodes, called with no arguments when somebody opens the
     * panel. It answers `structuredContent: { rows: [...] }` like a `table`'s does, and each
     * row carries a string `id`, a `label`, a `links` array of the ids it points at, and an
     * optional boolean `mark` — whatever this plugin's `hint` says the ring means.
     */
    rows: z.string().min(1),
    /** A tool called with `{ id }`, whose text opens beside the map when a node is clicked. */
    detail: z.string().min(1).optional(),
    /** A filter box, applied in the page over the node labels. */
    filter: z.boolean().optional(),
  }),

  z.object({
    /**
     * The fourteenth widget: **things a plugin holds, drawn the way core draws plugins**
     * (`alexia_protocol` 6).
     *
     * §8.1 of the engine plan asked for the plugins page applied one level down: a grid of
     * cards, the ones you have first, then a labelled row, then the rest dimmed rather than
     * hidden (D118, D120). The line that makes it legal was already written at `settings.ts:16`
     * — *nothing here names a plugin: every card is whatever is in the folder* — and this
     * generalises it to *whatever the plugin declares*. Core learns that a plugin can contain
     * things; it never learns the word *workflow*.
     *
     * **Granted after a `table` was tried and was the wrong shape.** Forty rows of a
     * spreadsheet are forty things nobody can judge; the plugins page answers the same question
     * with a name, a sentence and a state, and people already read it. That is a difference in
     * what the reader can do rather than in decoration, which is the bar `ui-schema.md` sets.
     *
     * A row is `id`, `name`, `summary`, and optionally `meta`, `state` and `group` — fixed by
     * the contract the way `graph`'s is, because a card offers no choices about layout that a
     * reader would notice and every knob here is one more thing an author can get wrong.
     */
    ...gated,
    type: z.literal('cards'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    /**
     * The tool that answers with the cards, called with no arguments when the panel opens.
     *
     * `structuredContent: { rows: [...] }`, as `table` and `image` answer. `state` is the
     * plugin's own word and is drawn as the pill; `group` puts a labelled row across the grid
     * before the first card carrying it, in the order the rows arrive — grouping is not
     * sorting, and the plugin decides what comes first.
     */
    rows: z.string().min(1),
    /** A tool called with `{ id }`, whose text opens under the card that was pressed. */
    detail: z.string().min(1).optional(),
    /** A filter box, applied over each card's name and summary. */
    filter: z.boolean().optional(),
    /**
     * The `state` that means *not here yet*, drawn dimmed rather than hidden (D120).
     *
     * Dimmed and labelled, never absent: the first person to delete something and want it back
     * could not find where things come from, which is the one journey that starts on a page
     * like this and cannot be finished anywhere else.
     */
    dim: z.string().min(1).optional(),
    rowActions: z
      .array(
        z
          .object({
            key: z.string().regex(IDENT),
            label: z.string().min(1),
            /** Called with `{ id }` — the card's own. */
            tool: z.string().min(1),
            confirm: z.string().min(1).max(160).optional(),
            /**
             * Only on cards whose `state` is this.
             *
             * *Install* belongs on the ones that are not here and *Remove* on the ones that
             * are; without it both sit on every card, which is how somebody presses Remove on
             * something they never installed.
             */
            when: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
  }),

  z.object({
    /**
     * `image` — the thirteenth, and the second that paints pixels.
     *
     * **The twelve could describe a picture and could not show one.** `file` was refused twice
     * (D89) and the refusal still stands: that was about a plugin asking somebody to *choose* a
     * file, which a browser cannot express, and this is the opposite direction — a plugin that
     * has made something and has nowhere to put it.
     *
     * **Granted the way `graph` was: on what the alternatives cost.** The other two answers were
     * the shell drawing a picture for one named plugin, which is this project's founding
     * complaint arriving by the back door, and a sandboxed iframe, which hands a plugin the
     * pixels and the palette and the focus ring with them. A widget core draws for anybody who
     * declares one is again the only answer that leaves the shell naming nobody.
     *
     * **And it arrives with three users rather than one**, which D115 was uneasy about: a
     * gallery of what a generator has made, the thumbnail on an item in a plugin's own library,
     * and a preview of something being worked on while it is still being worked on.
     *
     * Barer than `table` for the same reason `graph` is. A plugin says what the pictures are
     * and what each one is called. **How big, how they sit, what fills the gap while one loads,
     * what a screen reader says, and what any of it does in the dark are core's**, because they
     * are the decisions that make a page look like one page.
     */
    ...gated,
    type: z.literal('image'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    /**
     * The tool that answers with the pictures, called with no arguments when the panel opens.
     *
     * It answers `structuredContent: { rows: [...] }` the way a `table`'s does. A row carries a
     * string `id`, a `src` — an absolute path to a file, or a `data:` URL for something held in
     * memory — and an optional `caption` and `alt`. A row whose `src` cannot be read draws as a
     * gap with its caption, rather than as a broken picture or as nothing at all.
     */
    rows: z.string().min(1),
    /** A tool called with `{ id }`, whose text opens beside the picture when one is clicked. */
    detail: z.string().min(1).optional(),
    /**
     * One picture rather than a grid.
     *
     * The difference between *here is everything you have made* and *here is the one thing
     * happening now*, which are different screens and should not be one widget pretending.
     */
    single: z.boolean().optional(),
  }),
])

export const ManifestShape = z
  .object({
    /** Editors read this to find the schema. Core ignores it. */
    $schema: z.string().optional(),

    manifest_version: z.literal(1),

    id,
    name: z.string().min(1).max(64),
    summary: z.string().min(1).max(200),
    version: z.string().regex(SEMVER, 'semantic version, e.g. 0.1.0'),
    license: z.string().min(1),

    entry: z
      .object({
        run: z.string().min(1),
        args: z.array(z.string()).optional(),
      })
      .strict(),

    /** Ours. An integer, bumped when the `alexia/*` layer changes. */
    alexia_protocol: z.int().positive(),
    /** MCP's. Pinned by the plugin, negotiated at `server/discover`. */
    mcp_protocol: z.string().regex(MCP_REVISION, 'an MCP revision date, e.g. 2026-07-28'),

    /**
     * The Alexia builds this plugin runs on (D118).
     *
     * **The field that a shelf needs and `alexia_protocol` cannot supply.** The integer above
     * describes the *shape* of the contract; these describe the *build*. A plugin that calls
     * a capability which arrived in 0.2.0 speaks protocol 2 perfectly well and still does
     * nothing useful on 0.1.9, and before plugins were distributed on their own schedule that
     * gap did not exist — everything shipped inside one installer, so the app you had was the
     * app every plugin was built against.
     *
     * Both are optional and absent means *any*, which is the right answer for almost every
     * plugin: a range is a promise, and narrowing one that did not need narrowing takes a
     * working plugin off somebody's shelf. `max_app` in particular is for a plugin that is
     * known broken above some version, not for one nobody has got round to testing.
     */
    min_app: z.string().regex(SEMVER, 'semantic version, e.g. 0.2.0').optional(),
    max_app: z.string().regex(SEMVER, 'semantic version, e.g. 0.2.0').optional(),

    requires: z
      .array(
        z
          .object({
            cap: z.string().regex(CAPABILITY),
            // Not decoration: this sentence is what the user reads when asked to allow it.
            why: z.string().min(1).max(120),
          })
          .strict(),
      )
      .optional(),
    provides: z.array(z.string().regex(CAPABILITY)).optional(),

    settings: z.array(setting).optional(),

    storage: z
      .object({
        namespace: id,
        tables: z.array(z.string().regex(IDENT)).optional(),
        dir: z.boolean().optional(),
      })
      .strict()
      .optional(),

    commands: z
      .array(
        z
          .object({
            name: z.string().regex(ID),
            summary: z.string().min(1).max(120),
          })
          .strict(),
      )
      .optional(),

    /** Paths relative to the plugin folder. They install and purge with the plugin. */
    skills: z.array(z.string().min(1)).optional(),

    /** The cheapest router rung this plugin's work is safe on. */
    min_tier: z.enum(['T0', 'T1', 'T2', 'T3']).optional(),

    /**
     * Whether this plugin may be stopped when nothing is asking it anything.
     *
     * **The first thing M4 broke, and it broke for the reason M4 exists** (D77). Lazy spawn
     * assumes every plugin is a thing core calls into: quiet for five minutes and the
     * process exits, and the next call brings it back. That is true of every plugin written
     * before this field and it is false of the first one where messages arrive from
     * *outside* — a chat bridge holding a long poll is not idle when nobody has typed at it
     * for an hour, it is working, and stopping it is the same as switching it off.
     *
     * `resident` is therefore a plugin saying *I hold something open*, and it costs real
     * memory forever — so it is opt-in, it is visible in the library, and invariant 9 names
     * it as the exception rather than quietly widening to accommodate it. Absent means
     * `lazy`, which is what almost everything should be.
     */
    lifetime: z.enum(['lazy', 'resident']).optional(),

    /**
     * The second half of the plugin's own page, declared the same way settings are (M6-2,
     * D86; moved off the control surface by D118).
     *
     * **Core never types a plugin's name into a screen.** The plugins page is assembled: a
     * card and a page exist because a manifest is in a folder, and this half of that page
     * exists because that manifest declared it and somebody enabled the plugin — which is
     * the whole reason it goes when the folder does. The previous Alexia's dashboard listed
     * nine tabs by hand in one file and grew a 480-line panel for one vendor inside its own
     * source tree; this field is what makes that impossible rather than discouraged.
     *
     * The widgets are the settings widgets, unchanged, because a plugin that cannot style
     * itself wrong in one list must not be able to in another. What makes a panel not a
     * settings pane is what it is *for*: settings are values you change, a panel is a record
     * you read — and the one or two things you change *while* reading it. **Both are on one
     * page**, which is what a hint saying *the box above* may now rely on.
     *
     * **`settings` and `panel.widgets` are one namespace.** A widget's value lives in the
     * plugin's settings store either way, so a key declared in both lists would be one value
     * with two declarations that could disagree about its type. Declaring a key twice is a
     * load error; choosing which half a widget belongs in is the author's job.
     */
    panel: z
      .object({
        /**
         * What the section says, where it says anything.
         *
         * Drawn only when it is not the plugin's own name, because a heading repeating the
         * one above it is a section break that marks nothing. Short either way.
         */
        label: z.string().min(1).max(32),
        widgets: z.array(setting).min(1),
      })
      .strict()
      .optional(),
  })
  // Strict on purpose. A typo'd `provide` that is silently ignored is a plugin that asks
  // for nothing and fails at runtime, which is a far worse morning than a load error.
  .strict()

export type ManifestInput = z.infer<typeof ManifestShape>

const dupes = (xs: string[]): string[] => xs.filter((x, i) => xs.indexOf(x) !== i)

export const Manifest = ManifestShape.superRefine((m, ctx) => {
  const fail = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message })

  // One namespace, one plugin, one thing to drop on purge.
  if (m.storage && m.storage.namespace !== m.id) {
    fail(['storage', 'namespace'], `storage.namespace must equal id ("${m.id}")`)
  }

  // A field that arrived in a later revision may only be used by a plugin that declared
  // that revision. Without this the integer means nothing: a manifest could quietly use
  // whatever core happens to understand today and break on the machine running yesterday's
  // build — which is the exact failure `alexia_protocol` exists to make readable.
  if (m.lifetime !== undefined && m.alexia_protocol < 2) {
    fail(['lifetime'], 'lifetime arrived in alexia_protocol 2 — declare "alexia_protocol": 2 to use it')
  }
  if (m.panel !== undefined && m.alexia_protocol < 3) {
    fail(['panel'], 'panel arrived in alexia_protocol 3 — declare "alexia_protocol": 3 to use it')
  }
  if (/^([A-Za-z]:|[\\/])/.test(m.entry.run)) {
    fail(['entry', 'run'], 'entry.run must be a command on PATH or a path relative to the plugin folder')
  }

  /**
   * Every widget, checked once, in whichever list it was declared in.
   *
   * **One loop rather than one per rule per list.** It used to be four: a copy of the
   * revision gate for each half, and a copy of the default check for each half — which is
   * how `cards` shipped with no revision gate at all while `graph` and `image` had two
   * each. The list that is easy to forget to extend is the one that gets forgotten.
   */
  const declared = new Set([...(m.settings ?? []), ...(m.panel?.widgets ?? [])].map((w) => w.key))
  for (const [field, widgets] of [
    ['settings', m.settings ?? []],
    ['panel', m.panel?.widgets ?? []],
  ] as const) {
    // `panel.widgets`, so the path a reader is handed points at the thing they wrote.
    const at = (i: number): (string | number)[] => (field === 'panel' ? ['panel', 'widgets', i] : [field, i])
    widgets.forEach((s, i) => {
      /**
       * A field that arrived in a later revision may only be used by a plugin that declared
       * it. Without this the integer means nothing: a manifest could quietly use whatever
       * core happens to understand today and be refused as unparseable on the machine
       * running yesterday's build — which is the exact failure it exists to make readable.
       */
      const since = (revision: number, what: string, where: (string | number)[] = at(i)): void => {
        if (m.alexia_protocol < revision) {
          fail(where, `${what} arrived in alexia_protocol ${String(revision)} — declare "alexia_protocol": ${String(revision)} to use it`)
        }
      }
      if (s.type === 'graph') since(4, 'graph')
      if (s.type === 'image') since(5, 'image')
      if (s.type === 'cards') since(6, 'cards')
      if (s.type === 'file') since(7, 'file')
      if (s.type === 'text' && s.multiline !== undefined) since(7, 'multiline', [...at(i), 'multiline'])
      if (s.when !== undefined) {
        since(7, 'when', [...at(i), 'when'])
        // A `when` naming a key nobody declared is a widget that is never drawn, silently.
        // Both lists, because they are one namespace (D86) and a panel widget may perfectly
        // well turn on a setting above it.
        if (!declared.has(s.when.key)) {
          fail([...at(i), 'when', 'key'], `when.key "${s.when.key}" is not a widget this plugin declares`)
        }
        if (s.when.key === s.key) fail([...at(i), 'when', 'key'], 'a widget cannot be gated on itself')
      }

      if (s.type === 'choice') {
        const values = s.options.map(optionValue)
        if (s.options.some((o) => typeof o !== 'string')) since(7, 'a choice option with a label', [...at(i), 'options'])
        for (const [n, one] of s.options.entries()) {
          if (typeof one === 'string' || one.needs === undefined) continue
          if (!declared.has(one.needs)) {
            fail([...at(i), 'options', n, 'needs'], `needs "${one.needs}" is not a widget this plugin declares`)
          }
        }
        for (const d of new Set(dupes(values))) fail([...at(i), 'options'], `option "${d}" is declared twice`)
        if (s.default !== undefined && !values.includes(s.default)) {
          fail([...at(i), 'default'], `default "${s.default}" is not one of options`)
        }
      }
      if (s.type === 'multi-choice' && s.default) {
        for (const d of s.default) {
          if (!s.options.includes(d)) fail([...at(i), 'default'], `default "${d}" is not one of options`)
        }
      }
    })
  }

  m.skills?.forEach((p, i) => {
    if (/^([A-Za-z]:|[\\/])/.test(p) || p.split(/[\\/]/).includes('..')) {
      fail(['skills', i], 'a skill path must stay inside the plugin folder')
    }
  })

  // One namespace across both screens, because both write to one store: a key declared in
  // `settings` and again in `panel.widgets` is one value with two declarations that can
  // disagree about its type. Which screen a widget belongs on is the author's choice to make.
  //
  // A table's row actions are in it too. A row action *is* an `action` — pressed by key,
  // through the same gate — so a second `remove` somewhere else would be a press with two
  // possible meanings, and core would have to guess which.
  const everyKey = [...(m.settings ?? []), ...(m.panel?.widgets ?? [])].flatMap((w) => [
    w.key,
    ...(w.type === 'table' ? (w.rowActions ?? []).map((a) => a.key) : []),
  ])
  for (const d of new Set(dupes(everyKey))) {
    fail(
      [m.panel?.widgets.some((w) => w.key === d) === true ? 'panel' : 'settings'],
      `"${d}" is declared twice — settings and panel are one namespace, because a widget's value is stored once`,
    )
  }

  for (const [field, names] of [
    ['commands', (m.commands ?? []).map((c) => c.name)],
    ['provides', m.provides ?? []],
    ['requires', (m.requires ?? []).map((r) => r.cap)],
  ] as const) {
    for (const d of new Set(dupes([...names]))) fail([field], `duplicate entry "${d}"`)
  }
})

export type Manifest = z.infer<typeof Manifest>

/**
 * Whether core will load this manifest's declared contract versions, and why not.
 *
 * Both halves of compatibility, in one place on purpose: the shelf asks this before
 * offering a download and the loader asks it before spawning a process, and two functions
 * would be two chances for the sentence a user reads to differ from the reason they were
 * refused. `app` is a seam for the tests — everything real passes {@link APP_VERSION}.
 */
export function versionVerdict(
  m: Pick<Manifest, 'name' | 'alexia_protocol' | 'mcp_protocol'> & { min_app?: string; max_app?: string },
  app: string = APP_VERSION,
): { ok: true } | { ok: false; reason: string } {
  // The declared build range first, because it is the one an author writes deliberately —
  // and its refusal names a version number, which is more use than a protocol integer to
  // somebody deciding whether to update.
  if (m.min_app !== undefined && newer(m.min_app, app)) {
    return {
      ok: false,
      reason: `${m.name} needs Alexia ${m.min_app} or later, and this is ${app}.\nUpdate Alexia, or install an earlier version of ${m.name}.`,
    }
  }
  if (m.max_app !== undefined && newer(app, m.max_app)) {
    return {
      ok: false,
      reason: `${m.name} says it runs on Alexia ${m.max_app} and earlier, and this is ${app}.\nCheck whether ${m.name} has an update.`,
    }
  }
  if (m.alexia_protocol > ALEXIA_PROTOCOL_MAX) {
    return {
      ok: false,
      reason: `${m.name} needs a newer Alexia.\nUpdate Alexia, or install an earlier version of ${m.name}.`,
    }
  }
  if (m.alexia_protocol < ALEXIA_PROTOCOL_MIN) {
    return {
      ok: false,
      reason: `${m.name} was written for an older version of Alexia and can't load.\nCheck whether ${m.name} has an update.`,
    }
  }
  if (!(MCP_REVISIONS as readonly string[]).includes(m.mcp_protocol)) {
    return { ok: false, reason: mcpRefusal(m.name, m.mcp_protocol) }
  }
  return { ok: true }
}

/**
 * The refusal a person reads when the revisions do not overlap — written once, because it
 * is said twice: from the manifest before spawn, and from `server/discover` after it.
 * `speaks` is what the plugin offered, in its own words.
 */
export function mcpRefusal(name: string, speaks: string): string {
  return (
    `${name} speaks a version of MCP that Alexia doesn't.\n` +
    `Alexia speaks ${MCP_REVISIONS.join(' and ')}; ${name} speaks ${speaks}.`
  )
}
