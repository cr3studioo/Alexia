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

One family, six sizes, three weights. Sizes are `rem` so they follow the browser, and the
scale is a flat 1.2 — big enough to separate, small enough that a step never shouts.

| Token | Size | Where |
|---|---|---|
| `--text-xs` | 0.75rem | the mode tag on a card, the step number |
| `--text-sm` | 0.8125rem | hints, secondary lines, the trace |
| `--text-base` | 0.9375rem | body, messages, inputs — everything unmarked |
| `--text-md` | 1.0625rem | section headings, the name in the header |
| `--text-lg` | 1.375rem | the one question on a first-run step |
| `--text-xl` | 1.75rem | reserved: the empty state, and nothing else yet |

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

| Role | Job |
|---|---|
| `--surface` | the page |
| `--surface-raised` | a thing sitting on the page: card, input, panel, menu |
| `--surface-sunken` | the conversation's own ground, one step behind the page |
| `--ink` | body text |
| `--ink-quiet` | secondary text that is still meant to be read |
| `--ink-faint` | text that is there when you look for it: placeholders, step numbers |
| `--line` | a border between things |
| `--line-strong` | a border that is also an edge — the header rule, a focused input |
| `--accent` | what is yours and what is selected: your own messages, the chosen card, the primary button |
| `--on-accent` | text on `--accent` |
| `--focus` | the focus ring, and only the focus ring |
| `--caution` | it still works, but not the way you expected: a shadowed command, a step that failed |
| `--danger` | it did not happen and will not: a refusal, a hard error |

**Both themes are real.** Light is not dark inverted: each ramp is built for its own ground,
so `--ink-quiet` is genuinely quiet on white rather than merely paler, and the raised and
sunken surfaces are re-derived rather than mirrored — in light the page is off-white and a
raised thing is pure white, in dark the page is near-black and a raised thing is lighter than
it. Every pair in the table above is checked against WCAG at 4.5:1 for text and 3:1 for
borders and rings, in both themes, by `packages/ui/test/contrast.test.ts` — which reads the
declarations out of `app.css` rather than keeping a second copy of them. A palette that has to
agree with a test in two places is a palette that will disagree with it in one.

**The switch is the operating system.** `prefers-color-scheme`, with `color-scheme: light
dark` so scrollbars and native controls come along. There is no theme toggle, deliberately:
a toggle is a setting to persist, a control to keep in sync with a command, and a third state
("follow the system") to explain. Alexia is a tray-resident daemon that should look like the
desktop it is sitting in. `[data-theme]` on the root element overrides it if that judgement
ever changes — the hook is there, unused, and a control is all that would be missing.

`--caution` is amber and `--danger` is red, and they are the **only** hues on the screen.
Everything else is achromatic. That is not restraint for its own sake: it means a colour on
this screen always means something happened, and the eye can be trained on two colours in a
way it cannot be trained on nine.

---

## Shape

| | |
|---|---|
| `--radius-sm` 0.375rem | tags, menu rows, small controls |
| `--radius-md` 0.5rem | inputs, buttons |
| `--radius-lg` 0.75rem | cards, message bubbles, panels |
| `--radius-full` 999px | only where something is genuinely a pill: a status tag |

**No shadows.** Depth is carried by surface and border, which survives both themes without a
second set of values and does not smear on a scaled display. One exception is allowed and it
is not used yet: something that genuinely floats above the page rather than sitting on it.

Borders are `1px` and always `--line`, except an edge that separates two regions of the app
(`--line-strong`).

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

**First run** is its own view, not the chat page with a block swapped out, and it carries its
own identity: the header is gone entirely. A spend of `$0.00` and a model of *no model yet*
are noise before there is either, and with the header present the mark and the name were being
drawn twice, sixty pixels apart. The one question the view is really asking — *What should I
call you?* — is set in `--text-lg`; the two after it are `--text-md` headings. The composer
does not exist on this view at all, which is how *"first run and the composer are never on
screen together"* stops being a rule somebody has to remember.

The whole of it fits at 1280×800 with nothing scrolled: three mode cards on one row and the
Start button above the fold. That is a measurement, not a hope — the harness that takes the
screenshots reports `scrollHeight` against `clientHeight` for exactly this reason.

**The conversation** sits on `--surface-sunken`, so the messages are the raised things. Yours
are `--accent`, right; hers are `--surface-raised`, left; a refusal is dashed and quiet. Both
are capped at `--measure`.

**The composer** is pinned to the bottom with a `--line-strong` edge. It grows with the text
to `40vh` and stops. The primary button is the only `--accent` button on the screen.

**The step trace** is the hardest thing here to draw and the thing people will look at most.
It is a panel of rows, one per step, each: a tabular number, the tool's name, and what came
back on one line. The row appears **before** the work, not after — a step nobody can see until
it finishes is a spinner with extra steps. A failed row turns its result text `--caution` and
changes nothing else, because the panel is a log and a log that reflows is unreadable.

**The header** is identity, then controls, then status, then the number. In that order, left
to right, with the identity and the number as the two anchors.

**The note line** (`#note`) carries the spend preview, the monthly warning, a standing
boundary, and *Stopped.* It sits above the composer, `--text-sm`, `--ink-quiet`, with a rule
above it. It is one line and it is never a toast — a message that disappears on a timer is a
message the user is being tested on.

**The permission prompt** sits above the composer too, and never over the trace. What is
being decided is what just happened on screen; covering it would be the wrong shape entirely.

**Empty and error states** get `--text-xl`, centred, one sentence, and no illustration.

---

## What the ten widgets inherit

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
