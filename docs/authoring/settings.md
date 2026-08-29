# Settings: the ten widgets

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
