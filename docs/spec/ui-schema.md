# The declarative UI schema

> **A plugin cannot style itself wrong because it never styles itself.** It declares what it
> needs; core renders it. Twelve widgets, one visual language, and screens that look the same
> whoever wrote the plugin.
>
> This document is the rendering half. The manifest half — every field, every constraint —
> is [`manifest.md`](./manifest.md#settings). Where a widget's fields are listed there, they
> are not repeated here.
>
> **Two lists, one renderer, since M6-2.** These widgets are also what a plugin's `panel`
> declares — the second half of its page, under the settings that drive it. Everything below
> is true of both: the same twelve, the same rules, the same file drawing them. What differs
> is what each half is *for*, and that difference is in [`manifest.md`](./manifest.md#panel)
> rather than here, because nothing about the rendering changes. (Until D118 a panel was a tab
> on a screen of its own, which is why some of the prose below still says *screen*.)
>
> Companions: [`manifest.md`](./manifest.md) · [`wire-protocol.md`](./wire-protocol.md)

---

## Why not a JSON Schema form renderer

`react-jsonschema-form` and JSON Forms both solve "a third party declares settings, the host
renders them", and both were looked at and left. A general schema renderer accepts arbitrary
nesting, arbitrary widgets and arbitrary layout hints — which re-opens the exact door this
design closed, and adds about 175 KB to do it.

Twelve hand-written widgets is a smaller amount of code than the adapter would have been.
**If you need a thirteenth, that is a conversation** — open an issue saying what the twelve
could not do. It is not a config option, and it is not a `"type": "custom"` with an escape
hatch.

**The eleventh was that conversation, held rather than skipped** (D83, M6-3). This document
promised one and then got one: `table`, *a list of things with actions on each one*, granted
on behavioural evidence — the previous Alexia's dashboard hand-wrote that same object four
times, and the second copy's own comment says so. `file` and `graph` were asked for at the
same time and refused, because each had exactly one user, which is the bar written here. A
bar that is only applied when it is convenient is not a bar.

**The twelfth was the same conversation, held twice more** (D115, M6-11). `graph` was refused
again at M6-7, and on a better argument than the bar: its one user stored flat sentences with
a category, so the edges would have had to be *inferred*, and a picture of inferred similarity
looks meaningful and is not — which is a worse failure than no picture, because nobody can
tell. M7-3 gave that store **authored** links, and then somebody asked to look at the shape of
their own memory, which is the use the refusal was waiting for.

**It still has one user, and it was granted anyway, on what the alternatives cost.** The three
ways to draw a map were written down at M6-7: a hand-written force layout, this widget, or a
sandboxed iframe. The first means core's own shell holding a canvas built for one plugin —
which is core naming a plugin, the thing invariant 1 exists to stop, and the previous Alexia's
480-line vendor panel arriving by the back door. The third hands a plugin the pixels and every
rule on this page goes with them: the labels, the focus ring, the contrast, the palette. **A
widget is the only one of the three where the shell still names nobody and the page still owns
the look.** The layout itself is the first option, drawn inside the third's rules rather than
instead of them — about a hundred and fifty lines of arithmetic in `packages/ui/src/force.ts`,
no dependency, and tested without a browser because it is only arithmetic.

**`file` got its real user, and it is still not a widget.** The refusal was recorded three
times on three different arguments, the last of them ending *"that argument is waiting on a
real user."* Uploading a document is that user — it is the whole of a feature rather than a
convenience — and what it produced is **a control in the composer**, which is core's own
surface, not a thirteenth widget. The two are different grants with different blast radii: the
composer is one control on one screen that core draws and core owns, and a `file` widget is a
thing *any* plugin may declare on a settings pane. Granting the first does not carry the second,
and nothing about the second has changed — it still has no user, and a bar that is waived
because a neighbouring case was granted is not a bar. The path obstacle is also unmoved and is
the reason the composer route works at all: **a browser will not tell a page where a file is**,
so a `path` can never be filled by picking — but drag-and-drop and paste hand the webview
*bytes*, with no path involved, and bytes are all an upload ever needed.

**There is one more, and it is not yours** (D112). Core's Models tab draws a `ladder` — the
spend slider and the running order under it — and it is deliberately **not in the manifest
schema**, so a plugin declaring one is refused by the same parser that refuses a misspelled
`toggle`. It has exactly one user, which is the bar above, and the bar is not waived for the
people who wrote it. What it answers is a gap only core has: **every widget core can declare
for its own tabs is read-only.** A plugin's values are written through `/api/settings` against
its manifest, and core has no manifest — so the screen that shows which model the router
picked had nowhere to decide it, and *recommended* stayed a word covering a rule. It presses
`/api/action` like a row action does, so it adds no write path and no gate, and it is drawn by
the same renderer as everything on this page. If you want it, the answer is the one above:
open an issue saying what the twelve could not do.

The shape of the declaration is borrowed from VS Code's `contributes.configuration`, which
has been proving this exact idea at enormous scale for a decade. The shape, narrowed — not
the size.

---

## The twelve

Every widget takes `key`, `label`, and an optional `hint`. The hint renders under the
control in smaller type; it is one sentence, and it says something the label does not.

### `text`

```jsonc
{ "key": "endpoint", "type": "text", "label": "Server address",
  "placeholder": "http://localhost:11434", "hint": "Where Ollama is listening." }
```

```
  Server address
  ┌──────────────────────────────────────────┐
  │ http://localhost:11434                   │
  └──────────────────────────────────────────┘
  Where Ollama is listening.
```

### `password`

```jsonc
{ "key": "api_key", "type": "password", "label": "API key" }
```

```
  API key
  ┌──────────────────────────────────────────┐
  │ ••••••••••••••••••••                     │
  └──────────────────────────────────────────┘
  Stored in Windows Credential Manager.        ← core writes this line, not you
```

Never has a default. The value goes to the OS keychain, comes back only to the plugin that
declared it, is never in an export, a log, or a bug report, and is replaced by `•` in every
screenshot core ever takes. Core adds the "stored in…" line itself, naming the real store on
that platform — do not write a `hint` that contradicts it.

### `number`

```jsonc
{ "key": "threads", "type": "number", "label": "Threads",
  "min": 1, "max": 16, "default": 4 }
```

```
  Threads
  ┌────────┐
  │   4  ▴▾│    1–16
  └────────┘
```

With `min` and `max` both set, the range renders beside the field. Out-of-range input is
refused at the control, not on save.

### `toggle`

```jsonc
{ "key": "start_muted", "type": "toggle", "label": "Start muted", "default": false }
```

```
  ( ●━━ )  Start muted
```

The label is a statement that is true when the toggle is on. `"Start muted"`, not
`"Muting"` and not `"Do you want to start muted?"`.

### `choice`

```jsonc
{ "key": "model_size", "type": "choice", "label": "Speech model",
  "options": ["tiny", "base", "small"], "default": "base",
  "hint": "Bigger is more accurate and slower." }
```

```
  Speech model
  ┌──────────────────────────────────────┐
  │ base                              ▾  │
  └──────────────────────────────────────┘
  Bigger is more accurate and slower.
```

Two or three options render as a segmented control instead of a dropdown; four or more as a
dropdown. That is core's decision, not yours, and it is why you do not get to pick.

### `multi-choice`

```jsonc
{ "key": "languages", "type": "multi-choice", "label": "Languages to detect",
  "options": ["en", "cs", "de"], "default": ["en"] }
```

```
  Languages to detect
  ☑ en   ☐ cs   ☐ de
```

### `path`

```jsonc
{ "key": "watch_dir", "type": "path", "label": "Folder to watch", "kind": "dir" }
```

```
  Folder to watch
  ┌────────────────────────────────┐  ┌──────────┐
  │ (not set)                      │  │ Browse…  │
  └────────────────────────────────┘  └──────────┘
```

`kind` is `file` or `dir` and picks the native dialog. No default: a path baked into a
manifest is wrong on somebody else's machine.

### `status`

```jsonc
{ "key": "model_state", "type": "status", "label": "Speech model" }
```

```
  Speech model      ● Ready (base, 142 MB)
```

Read-only to the user. **The plugin drives it at runtime** with
[`alexia/settings/set`](./wire-protocol.md#alexiasettingsset), which is the only setting type
that method will write; core renders whatever it last wrote and remembers it while the plugin
is not running, so the screen is honest before first spawn.

Three states, because a fourth would need a legend: a leading `●` is ready, `▲` is something
the user should look at, `■` is idle or unknown. **`●` is not green.** `docs/design.md`
settled that a colour on this screen means something happened, and amber and red are the only
two — so ready renders in ordinary ink, `▲` in `--caution`, and `■` faint. Ready is the normal
state of a working plugin and does not need to be announced in colour; the one that does is
the one already coloured.

### `progress`

```jsonc
{ "key": "download_state", "type": "progress", "label": "Speech model download" }
```

```
  Speech model download
  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░  54%   Downloading the speech model
```

Driven by `notifications/progress` against the `progressToken` core gave you — not by
writing a setting. Core sends a token with every tool call an `action` button starts, so the
bar beside the button is fed by the work the button began. Hidden entirely when there is no
progress in flight. This widget is why
the five-minute setup budget survives a 142 MB download: **a bar that moves is the
difference between waiting and quitting.**

### `action`

```jsonc
{ "key": "redownload", "type": "action", "label": "Download the model again",
  "tool": "download_model" }
```

```
  ┌────────────────────────────────┐
  │  Download the model again      │
  └────────────────────────────────┘
```

A button. Pressing it calls the named tool with no arguments. The tool must exist in your
`tools/list` at the moment it is pressed, or the button renders disabled with the reason on
hover — which is the correct behaviour when the model has not been downloaded yet and the
tool genuinely is not there.

If the tool's annotations say it is destructive, core asks before calling it, in every mode
except Full trust. Same rule as any other tool call, no exception for buttons.

### `graph`

```jsonc
{ "key": "shape", "type": "graph", "label": "The shape of it",
  "rows": "list_notes", "detail": "about_note", "filter": true,
  "hint": "A ring means Alexia worked that one out rather than being told it." }
```

```
  The shape of it
  A ring means Alexia worked that one out rather than being told it.
  ┌──────────────────────────────────────────┬─────────────────────┐
  │            ○───────●                     │  The grant deadline │
  │           ╱        │                     │                     │
  │       (●)──────────●────○                │  The grant deadline │
  │                    │                     │  is in March.       │
  │                    ○                     │  Filed under: The   │
  │                                          │  grant.      Close  │
  └──────────────────────────────────────────┴─────────────────────┘
```

The only widget that paints pixels, and it still declares none of them. A plugin names the
tool that answers with the nodes and, if it has one, the tool that says more about a single
node; the fields on a row are fixed by the contract (`id`, `label`, `links`, `mark`) and every
decision about how it looks is core's. Field list in
[`manifest.md`](./manifest.md#graphs).

What core owns, and what a plugin therefore cannot get wrong:

- **The physics.** A hand-written force layout — repulsion, springs, a weak pull toward the
  middle, and a collision pass that keeps two circles from ever touching. Drag a node and the
  rest follows it; scroll to zoom; drag the ground to pan. **It was tuned against a real graph
  rather than against d3's defaults**, which are for a few dozen dots with nothing written on
  them: sixty-three labelled notes drew a hairball, and dragging the hub everything hung off
  moved almost nothing. Four things fixed it, and each is a rule worth keeping — the layout is
  never recentred (it moved whatever a hand was holding), overlap is resolved as a position
  rather than as a force, links rest three times further apart because a node is drawn with a
  name beside it, and **a drag holds the temperature up for as long as it lasts**, which is
  d3's `alphaTarget` and the whole difference between a graph that follows a hand and one that
  stiffens under it.
- **The colours**, which are the page's own and stay scarce (`docs/design.md`). A node is
  drawn in the accent, a `mark` adds a ring in `--chosen` **after** the node rather than
  instead of it — so *what this is* and *where it came from* stay two signals rather than
  fighting over one pixel — and links are drawn in the line colour at half strength.
- **The labels.** Each name claims a rectangle, and a name whose rectangle is already taken is
  not drawn — in an order that decides who wins: whatever is being pointed at, then what it
  touches, then the busiest. Zooming in spreads the rectangles and the rest appear, which is
  the gesture somebody makes to read one anyway. **Drawing every label is the same as drawing
  none**, which is what a screenshot of sixty-three notes showed.
- **What is being pointed at.** Hovering a node brings its own links forward and quietens
  everything else. On a graph with a hub through the middle, that is the only thing that
  answers *what is this one joined to* — no layout does.
- **Motion, and not having any.** `prefers-reduced-motion` settles the layout in one pass and
  paints the answer once. Nothing on this screen animates at somebody who asked it not to.
- **The empty and the filtered-empty case**, in the widget's own voice: *nothing here yet*
  reads differently from *nothing matches that*, and both beat an empty canvas.

**Its reach is honest about what a canvas cannot do.** It carries the node and link counts as
its label for a reader who cannot see it, and the detail beside it is ordinary text — but a
map is not keyboard-reachable, and a plugin whose data a person must be able to *act* on
should put a `table` beside it, which is where a row has a button and a name.

---

## Layout

Widgets render **in manifest order**, in one column, on the plugin's own settings page.
There is no grouping, no tabs, no sections and no `order` field: a plugin with enough
settings to need tabs has a design problem that a tab control would hide. Settings itself has
two tabs, General and Plugins, and every plugin has a page of its own reached from a card on
the second — but that is navigation *between* plugins, and it stops at the page's edge.

The page is core's chrome — plugin name, version, licence, the enable toggle, the
capabilities it asked for with each `why` beside it, and a **Delete** button. None of that is
declared; all of it is rendered from the manifest.

---

## Reading and reacting

| | |
|---|---|
| Read your settings | `alexia/settings/get` → every declared key, with the user's value or your `default` |
| React to an edit | `alexia/settings/changed` notification, with only the keys that changed |
| Ask a question **not** in your settings | `elicitation/create` — a modal, at the moment you need the answer |

Settings are for standing choices the user changes when they feel like it. Elicitation is
for something you need *now* and cannot proceed without. Putting a one-time question in
settings makes the user hunt for it; putting a standing preference in a modal makes them
answer it forever.

A settings edit never restarts your process. Handle the notification or ignore it, but do
not exit — the user is looking at the screen when it happens.

---

## Accessibility is not a widget

Core owns it, which is the other reason plugins do not render their own UI. Every widget
above ships with a real label association, keyboard reach, focus that is visible, and
contrast that holds in both themes. A plugin cannot break that because a plugin cannot
reach it.
