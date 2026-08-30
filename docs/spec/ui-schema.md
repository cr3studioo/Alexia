# The declarative UI schema

> **A plugin cannot style itself wrong because it never styles itself.** It declares what it
> needs; core renders it. Eleven widgets, one visual language, and screens that look the same
> whoever wrote the plugin.
>
> This document is the rendering half. The manifest half — every field, every constraint —
> is [`manifest.md`](./manifest.md#settings). Where a widget's fields are listed there, they
> are not repeated here.
>
> **Two screens, one renderer, since M6-2.** These widgets are also what a plugin's `panel`
> declares — its tab on the control surface. Everything below is true on both: the same ten,
> the same rules, the same file drawing them. What differs is what each screen is *for*, and
> that difference is in [`manifest.md`](./manifest.md#panel) rather than here, because
> nothing about the rendering changes.
>
> Companions: [`manifest.md`](./manifest.md) · [`wire-protocol.md`](./wire-protocol.md)

---

## Why not a JSON Schema form renderer

`react-jsonschema-form` and JSON Forms both solve "a third party declares settings, the host
renders them", and both were looked at and left. A general schema renderer accepts arbitrary
nesting, arbitrary widgets and arbitrary layout hints — which re-opens the exact door this
design closed, and adds about 175 KB to do it.

Eleven hand-written widgets is a smaller amount of code than the adapter would have been.
**If you need a twelfth, that is a conversation** — open an issue saying what the eleven
could not do. It is not a config option, and it is not a `"type": "custom"` with an escape
hatch.

**The eleventh was that conversation, held rather than skipped** (D83, M6-3). This document
promised one and then got one: `table`, *a list of things with actions on each one*, granted
on behavioural evidence — the previous Alexia's dashboard hand-wrote that same object four
times, and the second copy's own comment says so. `file` and `graph` were asked for at the
same time and refused, because each had exactly one user, which is the bar written here. A
bar that is only applied when it is convenient is not a bar.

The shape of the declaration is borrowed from VS Code's `contributes.configuration`, which
has been proving this exact idea at enormous scale for a decade. The shape, narrowed — not
the size.

---

## The eleven

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
