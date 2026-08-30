<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The visual language

> **What this doc is.** The house style, written down so it can be inherited rather than
> re-invented. M2-1's ten widgets conform to it. M15-5's step trace is drawn against it. A
> plugin never sees it, because a plugin never draws — that is the whole point of the UI
> schema, and this document is what makes "core renders" mean something specific.
>
> Companion files: [`Alexia.md`](../Alexia.md) (why) · [`plan.md`](../plan.md) (order) ·
> [`spec/ui-schema.md`](./spec/ui-schema.md) (the widgets that inherit this).
>
> Written 2026-08-28 as **M2-D1**. It replaces M1-D1's holding theme, which was one dark
> achromatic palette and said so.

---

## Why a product like this one needs a frame

Alexia asks a person to paste an API key, hand over a folder, and let something spend their
money. The copy already earns that: *"not yet checked — 7 of 7. Alexia will say so rather
than guess"*, the spend on screen at all times, a never-touch list nobody can edit.

A careful sentence in a careless frame reads as a prototype. Then the honesty is paying for
the presentation instead of the other way round, and the one thing this project has to sell —
that it tells you the truth about what it is doing — is discounted at the door.

So the frame is not decoration here. It is the thing that lets the sentences be believed.

---

## The type ramp

**Three faces, and none of them downloads.** A chat window that needs a webfont is a chat
window that is wrong on a plane, and every kilobyte here is one the Tauri shell carries at M5.
All three are already on the machine:

| Token | Stack | What it is for |
|---|---|---|
| — | `ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif` | Body, messages, controls — everything unmarked |
| `--serif` | `ui-serif, Georgia, 'Iowan Old Style', 'Times New Roman', serif` | The voice: her name, a conversation's title, the spend |
| `--mono` | `ui-monospace, 'Cascadia Mono', 'SF Mono', 'DejaVu Sans Mono', monospace` | What a machine said: a tool name, a capability, an argument, a result |

The split is the point. **A command must never look like prose.** When the live panel shows
what was sent to a tool, the difference between Alexia's sentence and the tool's arguments is
carried by the face before anybody reads a word — and the serif keeps identity and titles from
competing with either.

One family for the work, six sizes, three weights. Sizes are `rem` so they follow the browser,
and the scale is a flat 1.2 — big enough to separate, small enough that a step never shouts.

| Token | Size | Where |
|---|---|---|
| `--text-xs` | 0.75rem | the mode tag on a card, the step number |
| `--text-sm` | 0.8125rem | hints, secondary lines, the rail, the live panel |
| `--text-base` | 0.9375rem | body, messages, inputs — everything unmarked |
| `--text-md` | 1.0625rem | section headings |
| `--text-lg` | 1.375rem | the one question on a first-run step |
| `--text-xl` | 1.75rem | her name in the rail, and the empty state |

Weights are `400`, `500` and `600`. There is no bold body text and no italic anywhere except
where a browser puts it — emphasis in this product is a job for hierarchy, not for a heavier
version of the same sentence.

**Line height** is `1.55` for prose and `1.3` for anything of a single line — a heading, a
badge, a step. Long-form line length is capped at `--measure` (42rem), and a field whose
answer is a word rather than a paragraph at `--measure-short` (24rem) — a name in a 50rem box
looks like a mistake. Nothing else is capped, because nothing else is long enough to need it.

**Numbers that are compared use `font-variant-numeric: tabular-nums`.** The spend, the step
counter, any progress percentage. A number that changes width as it counts is a number that
looks like it is flickering.

---

## The spacing scale

A 4px base, doubling loosely. Every margin, padding and gap in the sheet comes from here;
none is typed as a literal.

| Token | Value | Reads as |
|---|---|---|
| `--space-1` | 0.25rem | inside a tag |
| `--space-2` | 0.5rem | between things that are one thing |
| `--space-3` | 0.75rem | inside a control |
| `--space-4` | 1rem | between controls; the page gutter |
| `--space-5` | 1.5rem | between groups |
| `--space-6` | 2rem | between sections |
| `--space-8` | 3rem | around a view that stands alone |

The rhythm rule, which matters more than the numbers: **the gap inside a group is always
smaller than the gap around it.** If a label and its input are `--space-2` apart, the next
field starts at `--space-4` or further. When a screen reads as mush, this is what has gone
wrong, every time.

---

## Colour

Colours are named for **what they do**, never for what they are. There is no `--grey-700` in
this sheet, because the moment there is, the light theme has to invert a name that means a
shade and the meaning is lost.

### The two grounds

The palette is Delft: blue-and-white porcelain, and specifically **the painting that was on
the pot rather than the pot**. Five colours, and the two themes are the same painting with the
glaze and the paint changing places.

| | Dark — *the cobalt ground* | Light — *the champagne ground* |
|---|---|---|
| `--surface` | `#030d1b` | `#efe4cf` |
| `--surface-raised` | `#0a1b30` | `#fffbf3` |
| `--surface-sunken` | `#05111e` | `#e8dcc4` |
| `--ink` | `#ede7da` | `#12253d` |
| `--accent` | `#e8d6b6` | `#18385f` |

**Light is not dark inverted.** Each ramp is built for its own ground, so `--ink-quiet` is
genuinely quiet on champagne rather than merely paler, and the raised and sunken surfaces are
re-derived rather than mirrored. In the dark the page is deep cobalt and a panel is lighter
than it; in the light the page is champagne and a panel is the glaze sitting on it.

**Body ink is not the brightest thing available.** `--ink` is `#ede7da`, not the full
`#fff9ef` — the pure glaze is kept for nothing, because a screenful of text set in it is what
made the first pass of this palette hard to look at. If a heading ever needs to be brighter
than the body, that is a hierarchy problem to solve with size and weight.

### Colour is scarce, and it is split by meaning

| Role | Job |
|---|---|
| `--accent` | **you, and what you chose** — your own messages, the option you picked, the primary button, the mark, the painting |
| `--on-accent` | text on `--accent` |
| `--chosen` | **the machine, working** — a run in flight, progress, a plugin switched on, the live dot |
| `--chosen-wash` | the ground a `--chosen` badge sits on |
| `--caution` | it still works, but not the way you expected: a shadowed command, a step that failed |
| `--danger` | it did not happen and will not: a refusal, a hard error |
| `--focus` | the focus ring, and only the focus ring |
| `--ink-quiet` | secondary text that is still meant to be read |
| `--ink-faint` | text that is there when you look for it: placeholders, step numbers |
| `--line` | a border between things |
| `--line-strong` | a border that is also an edge — a focused input, a dashed refusal |

That split is the rule that matters, and it is the one this screen kept getting wrong. When
the accent did every job at once — the button *and* your messages *and* six plugin switches
*and* the labels — a warm colour at that chroma sat on a cold ground in a dozen places and the
whole screen vibrated. **Two meanings, two colours.** Amber and red are the only other hues,
which is what makes a colour on this screen always mean that something happened.

`--wash` and `--accent-wash` carry hover states and tinted fills. They are `color-mix` off the
tokens above rather than a second set of hexes nobody would keep in step, and they carry no
text — which is why they are not in the contrast table.

### Both themes are measured

Every pair above is checked against WCAG at 4.5:1 for text and 3:1 for borders and rings, in
both themes, by `packages/ui/test/contrast.test.ts` — which reads the declarations out of
`app.css` rather than keeping a second copy of them. A palette that has to agree with a test
in two places is a palette that will disagree with it in one.

**The switch is the operating system.** `prefers-color-scheme`, with `color-scheme: light
dark` so scrollbars and native controls come along. There is no theme toggle, deliberately: a
toggle is a setting to persist, a control to keep in sync with a command, and a third state
("follow the system") to explain. Alexia is a tray-resident daemon that should look like the
desktop it is sitting in. `[data-theme]` on the root element overrides it if that judgement
ever changes — the hook is there, unused, and a control is all that would be missing.

---

## Shape

| | |
|---|---|
| `--radius-sm` 0.375rem | tags, menu rows, small controls |
| `--radius-md` 0.5rem | inputs, buttons, code blocks |
| `--radius-lg` 0.75rem | panels, cards, message bubbles |
| `--radius-full` 999px | **badges only** |

`--radius-full` is the one worth spelling out. A pill is now the mark of a badge — *running*,
*waiting on you*, which model answered — and nothing else. When containers and primary buttons
were pills too, the badge stopped meaning anything.

**No shadows.** Depth is carried by surface and border, which survives both themes without a
second set of values and does not smear on a scaled display. One exception is allowed and it
is not used yet: something that genuinely floats above the page rather than sitting on it.

Borders are `1px` and always `--line`, except an edge that separates two regions of the app
(`--line-strong`).

---

## The painting

Delft brushwork rather than a Delft vase: what was on the pot, not the pot. It is the app icon
and two foliate motifs, and it exists to make a careful sentence look like it was meant.

**Three files, and they are masks rather than pictures.**

| File | Where |
|---|---|
| `alexia-mark.svg` | the mark in the rail — the icon, filled, in a double-ringed medallion |
| `alexia-band.svg` | one tile of a running scroll, repeated under the mark |
| `alexia-panel.svg` | the panel behind the conversation — the figure as linework, with a spray and a peony framing her |

A mask and not an `<img>`, because the painting has to take the theme's colour: champagne line
on cobalt in the dark, cobalt line on champagne in the light, which is the icon's own polarity
the second way round. An `<img>` cannot inherit a colour; a mask is alpha, and the element
behind it is whatever `background` says. Every one is registered in `serve.ts`'s `STATIC` and
copied by `scripts/package.mjs`, and `packages/ui/test/shell.test.ts` holds those three facts
together — a mask that 404s is not a broken image with a border round it, it is a solid
champagne rectangle over the conversation.

**Three appearances and no more**: the mark, one band under it, one panel behind the
conversation. Any more and it competes with a live trace, which is the thing on this screen
people actually need to read.

**In the backdrop the figure is stroked, never filled.** Filled, she is a heavy silhouette
that fights the text at any opacity worth having; stroked, she is linework at the same weight
as the flowers around her, which is what puts her behind the conversation rather than in it.
She is also held at 55% of the flowers' opacity, so she recedes rather than matching them.

`--paint` is the only lever — how strongly the brushwork shows through, and the only thing
about it anybody would ever want to change. It is lower in the light theme than in the dark,
because the same line reads louder on champagne than on cobalt.

---

## States

Every interactive thing has all of these, and they are defined once rather than per component.

| State | How it looks |
|---|---|
| Rest | `--surface-raised`, `--line` |
| Hover | border to `--line-strong`. Nothing moves, nothing grows |
| Focus | `2px` `--focus` ring at `2px` offset, on `:focus-visible`. Never removed, never replaced by a colour change |
| Active | no separate treatment; the click is its own feedback |
| Selected | border and ring in `--accent` |
| Disabled | 55% opacity, `cursor: default`. Still readable — a disabled control a person cannot read is a control they cannot understand the return of |
| Running | the step's own row, with an ellipsis. **Never a spinner** |
| Failed | `--caution` on the text that failed, nothing else |
| Refused | dashed `--line`, `--ink-quiet` text. A refusal is an answer, not an error box shouting at somebody who has done nothing wrong |

**Focus is visible on everything, including things that are not buttons** — a card, a menu
row, the composer. If `:focus-visible` does not reach it, it is not reachable, and that is a
bug in the markup rather than a decision about the ring.

---

## Hierarchy

The rule the header was breaking, generalised: **a control, a status and a number are three
different things and must not look the same.**

| Kind | Treatment |
|---|---|
| **Control** — you can change it | Looks pressable: `--surface-raised`, a border, a hover state, a focus ring. Mode and permission |
| **Status** — the app telling you where it is | `--ink-quiet`, no border, no box. Which model answered |
| **Number that matters** | `--ink`, tabular, with a label beside it so it is never a bare figure. The spend |
| **Identity** | the mark and the name, first, and never competing with any of the above |

Three identical pills is what this looked like before, and it made a dropdown you can change
indistinguishable from a figure you cannot.

---

## The surfaces

Each one has a job, and the job is what settles the layout.

**The shell is three panels on a ground that is allowed to show between them.** Not three
columns with rules between them: the gaps are the design. A panel that runs edge to edge
against its neighbour needs a rule to separate them, and a screen of rules is what made the
old header read as a stack of pills — here the ground does that job and costs nothing. The
gutters carry a grip apiece, because the three widths are the reader's to set.

**The rail** is identity, then which conversation, then the four things somebody changes:
which model answers, where the work happens, what Alexia may do unasked, and which plugins are
on. It is the one panel that never goes away — Settings and Control swap the middle out from
under it. Everything in it opens **in place**: a popover anchored to a row in a column that
scrolls is a popover that gets left behind. Nothing in it is a second source of truth, either;
every list is core's own — the same `chats` and `models` tables the Control surface draws, the
same `/api/plugins` the settings screen reads. The rail is a shorter route to them, never a
parallel one.

**The conversation** is her words as text on the panel, not a box on a box. A raised bubble on
a raised surface is two borders and a fill to carry one sentence, and a screenful of them
reads as a stack of cards rather than as somebody talking. Yours keep a shape, because on a
page of her prose the thing worth finding is what you asked. A refusal is dashed and quiet.

**The conversation says almost nothing about a tool call**: the names, and a way through. One
line, and it is a control rather than a caption.

**The live panel** has the rest, and it is the reason the trace left the log. One card for
what is running, one for the steps, one for the step you have open — and that last one carries
what the old trace could not: which plugin offers the tool, what that plugin holds and **the
manifest's own sentence for why**, the arguments the model actually sent, and what came back.
Nothing in it is invented. Where core does not say something — which single capability a given
call used, as opposed to which the plugin holds — the panel says what it knows rather than
guessing. A screen whose whole purpose is *this is what happened* cannot afford one confident
wrong line.

**The step rows appear before the work, not after it.** A step nobody can see until it finishes
is a spinner with extra steps, and a spinner during a five-minute run is how trust goes. A
failed row recolours its result and changes nothing else, because the panel is a log and a log
that reflows is unreadable.

**First run** is its own view, not the chat page with a block swapped out, and it carries its
own identity: the rail is gone entirely. A spend of `$0.00` and a model of *no model yet* are
noise before there is either, and with the rail present the mark and the name were being drawn
twice. The one question the view is really asking — *What should I call you?* — is set in
`--text-lg`; the two after it are `--text-md` headings. The composer does not exist on this
view at all, which is how *"first run and the composer are never on screen together"* stops
being a rule somebody has to remember.

**The composer** is pinned to the bottom of the conversation panel. It grows with the text to
`40vh` and stops. Its primary button is the only `--accent` fill on the screen.

**The note line** (`#note`) carries the spend preview, the monthly warning, a standing
boundary, and *Stopped.* It sits above the composer, `--text-sm`, `--ink-quiet`. It is one
line and it is never a toast — a message that disappears on a timer is a message the user is
being tested on.

**The permission prompt** sits above the composer too, and never over the panel beside it.
What is being decided is what the live panel is showing; covering either would be the wrong
shape entirely.

**The spend** sits at the foot of the live panel, on the ground rather than in a card, with
its label beside it. It is on screen whenever the conversation is, which is the whole of what
*nobody is ever surprised by a bill* requires.

**Empty and error states** get one sentence and no illustration. An empty panel says what
empty means: *Nothing is running* is a fact, and a blank rectangle is a bug somebody is about
to report.

---

## What the widgets inherit

M2-1 declares no styles. Every widget in [`spec/ui-schema.md`](./spec/ui-schema.md) is built
from the same four parts, and this is the anatomy:

```
label            --text-base, --ink,       margin-bottom --space-2
control          --surface-raised, --line, --radius-md, padding --space-3
hint             --text-sm,   --ink-quiet, margin-top    --space-2
error            --text-sm,   --danger,    margin-top    --space-2
```

Fields are `--space-5` apart. A widget with no hint does not reserve room for one. `status`
and `progress` are the two that are not inputs: `status` is a pill using the state colours
above, `progress` is a `--space-1` tall bar on `--surface-sunken` filled with `--accent`, with
its percentage tabular beside it.

A plugin cannot style itself wrong because a plugin never styles itself. That promise is only
true while this document is the single place the answer lives.

---

## The rules that do not bend

- **Colour is split by meaning, and the split does not blur.** `--accent` is the user and
  what they chose; `--chosen` is the machine working. A pass that reaches for the accent
  because something needs to stand out is the pass that made this screen vibrate.
- **The painting appears three times.** The mark, the band, the panel. It is stroked, it is
  masked so it takes the theme's colour, and `--paint` is its only lever.
- **Every id the shell asserts is in the markup**, and every id in the markup is reached for.
  `packages/ui/test/shell.test.ts` holds both directions, because a renamed id is not a wrong
  colour — it is `null.addEventListener` thrown while the module loads, and a blank window.
- **No webfonts.** Three stacks, all already on the machine.
- **The honest strings are load-bearing.** No pass over this screen may soften, shorten or
  bury the training-data line, the spend, or any refusal. A sentence that is awkward because
  it is true stays awkward. Invariant 8 enforces the first half of that; the second half is
  on whoever is holding the CSS.
- **One stylesheet, no framework, no bundler.** A chat window is not a build problem, and
  every kilobyte here is one the Tauri shell carries at M5.
- **`packages/ui` imports no Node builtin** (invariant 6). It all has to live in a webview.
- **Light and dark, both real**, both measured.
- **Every command keeps its UI equivalent** (M1-12). A command is a shortcut for people who
  like them, never the only route.
- **Keyboard reachable throughout, focus always visible.**
- **No value is typed twice.** If a size, a space or a colour appears as a literal in
  `app.css`, it is either a mistake or a token this document is missing.
- **Width belongs to the container, not to the control.** An `input` or `select` is as wide as
  where it sits: full width inside a field, its own width in the header. A blanket
  `width: 100%` on the element is what made the header's two dropdowns 1233px each and pushed
  the spend off the side of the screen.
