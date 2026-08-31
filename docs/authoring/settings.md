# Settings: the twelve widgets

You declare; Alexia draws. **A plugin cannot style itself wrong because it never styles
itself**, and the screen works while your process is stopped — which, with lazy spawn, is
the ordinary case.

| Type | What it is | Notes |
|---|---|---|
| `text` | one line | `default`, `placeholder` |
| `password` | a secret | never has a default, goes to the OS keychain, never to the database |
| `number` | a number | `min`, `max`, `step` |
| `toggle` | on or off | the label is a statement that is true when it is on |
| `choice` | one of several | 2–3 options draw as a segmented control, 4+ as a dropdown |
| `multi-choice` | several of several | |
| `path` | a file or folder | `kind`, and no default — an absolute path in a manifest is wrong on somebody else's machine |
| `status` | your own report of yourself | read-only to the user, writable by you |
| `progress` | a bar | hidden entirely when nothing is in flight |
| `action` | a button that calls one of your tools with no arguments | `tool: "install"` |
| `table` | a list of things, with actions on each one | `rows`, `columns`, and see below |
| `graph` | things that point at each other, drawn as a map | `rows`, and see below |

## Reading them

```js
const settings = await alexia.settings()   // your keys, with the user's value or your default
```

And react while running, rather than exiting:

```js
alexia.onSettingsChanged((changed) => {
  if ('model_size' in changed) void rebind()
})
```

A cleared password arrives as `null` rather than a missing key — "there is no longer one"
is a change you have to be able to see.

## `status` is the only thing you may write

```js
await alexia.status('ready', '● Ready — base, lessac')
```

The narrowness is the design. A `status` is your own read-only report of yourself. Every
other widget on that screen is the user's answer, and a plugin that could quietly rewrite a
toggle would have to be trusted rather than read.

Three marks, no legend:

- `●` ready
- `▲` something to look at — **the only one that is coloured**, because on this screen a
  colour means something happened, and being ready is not something happening
- `■` idle, or not set up yet

Alexia remembers the value while you are stopped, so the screen is honest before your next
spawn.


## `table`: a list of things

*Needs `"alexia_protocol": 3`.*

```jsonc
{ "key": "clips", "type": "table", "label": "Clips",
  "rows": "list_clips",
  "columns": [{ "key": "name", "label": "Name" },
               { "key": "seconds", "label": "Length", "align": "right", "hideNarrow": true }],
  "rowActions": [{ "key": "drop_clip", "label": "Delete", "tool": "delete_clip",
                   "confirm": "Delete {name}?" }],
  "filter": true }
```

`rows` names one of your tools. Alexia calls it with no arguments and reads MCP's own
`structuredContent`:

```js
return {
  content: [{ type: 'text', text: 'ok' }],
  structuredContent: { rows: [{ id: 'a', name: 'Ada', seconds: 15 }] },
}
```

**Every row needs a string `id`.** It is the only field Alexia uses — a row action and a
detail are both *this row* — and everything else belongs to the columns you declared. If
`structuredContent.rows` is missing, or a row has no `id`, the panel says exactly that
rather than showing an empty list.

**This is the one widget that needs your process running.** Everything else draws while you
are stopped. A table asks for its contents when somebody opens the panel, so declare
`readOnlyHint` on your `rows` tool — one that has not is asked about before it runs, which
is the permission gate treating a lister that claimed nothing like anything else that
claimed nothing.

A `rowActions` tool is called with `{ id }` and goes through that same gate. `confirm` is a
second press, with `{column}` filled in from the row. Mark with `hideNarrow` the columns you
would drop first on a phone — the buttons are what has to stay reachable.

## `graph`: things that point at each other

*Needs `"alexia_protocol": 4`.*

```jsonc
{ "key": "shape", "type": "graph", "label": "The shape of it",
  "hint": "A ring means Alexia worked that one out rather than being told it.",
  "rows": "list_notes", "detail": "about_note", "filter": true }
```

Same `rows` tool as a table, same `structuredContent`, same string `id`. Three more fields on
a row, and no columns to declare:

```js
return {
  content: [{ type: 'text', text: '2 notes' }],
  structuredContent: {
    rows: [
      { id: '1', label: 'The grant', links: [], mark: false },
      // `links` holds ids, not labels. One pointing at an id you did not return is dropped.
      { id: '2', label: 'The grant deadline', links: ['1'], mark: true },
    ],
  },
}
```

`mark` draws a ring around a node and your `hint` is where you say what it means. Everything
else — the physics, the colours, the labels, zoom, drag, and settling without motion for
somebody who asked for that — is Alexia's.

**Only draw links somebody wrote.** If your edges come from a model deciding two things look
similar, a table grouped by category is the honest picture: a graph of guesses looks
meaningful and nobody looking at it can tell that it is not. And a map is not
keyboard-reachable, so if a person needs to *act* on one of these things, put a `table` beside
it — that is where a row has a name and a button.

## A panel: the same widgets, a different screen

*Needs `"alexia_protocol": 3`.*

```jsonc
"panel": {
  "label": "Voice",
  "widgets": [
    { "key": "which_voice", "type": "choice", "label": "Who speaks", "options": ["Ada", "Rowan"] },
    { "key": "clips", "type": "status", "label": "Clips" }
  ]
}
```

That is a **tab on the control surface** — the screen a person opens to ask what Alexia has
been doing and what it knows. Your tab is there because somebody enabled your plugin, and it
goes when your folder does. Nothing in Alexia writes your tab's name down.

Everything above still applies: the same widgets, the same rules, the same renderer. Use the
settings pane for values somebody sets once and a panel for something they come back to look
at — plus the one or two things they change while looking.

**One namespace.** A key may appear in `settings` or in `panel.widgets`, not both: the value
is stored once, so two declarations of it could disagree about its type. Declaring one twice
is a load error.

## `action` and `progress` together

An `action` button calls one of your tools with no arguments and carries a `progressToken`,
so `alexia.progress(ctx, …)` feeds the bar next to the button. That pairing is what makes a
"Download now" button worth having. The permission gate still applies: a destructive tool
behind a button is asked about, in every mode but Full trust.
