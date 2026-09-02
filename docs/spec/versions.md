# `alexia_protocol` — the revisions, and what changed

Two versions do two different jobs. `mcp_protocol` is upstream's, negotiated by the
handshake, handled by the SDK. **`alexia_protocol` is ours**: an integer, bumped when the
`alexia/*` layer or the manifest changes, and checked *before your process is spawned*.

```
you say alexia_protocol 3    Alexia speaks 2..4   ->  loads
you say alexia_protocol 1    Alexia speaks 2..4   ->  "X was written for an older version"
you say alexia_protocol 5    Alexia speaks 2..4   ->  "X needs a newer Alexia"
```

## The other version: `min_app` *(2026-08-31, D118)*

`alexia_protocol` describes the **shape of the contract**. It says nothing about the build,
and since plugins stopped shipping inside the installer that gap is a real one: a plugin
needing a capability that arrived in Alexia 0.2.0 declares the same revision as everything
else, handshakes perfectly on 0.1.9, and does not work.

```
you say min_app 0.2.0        this build is 0.2.1  ->  loads
you say min_app 0.3.0        this build is 0.2.1  ->  not on the shelf, not offered as an
                                                      update, refused if asked anyway
```

Optional, and absent means *any*. Declare the oldest build you actually tested against —
`max_app` is for a plugin that is *known* broken above a version, not one nobody has tested.
Both are checked by the same `versionVerdict` as the integer above, in three places: the
shelf, the install, and the loader.

## The promise, from v2 onwards

**One revision back is supported.** Alexia at revision *n* loads plugins declaring *n* and
*n−1*. That refusal is the entire reason third-party plugins were safe to accept while the
contract was still moving.

**It was kept at 3, on 2026-08-29.** Plugins declaring 1 stopped loading and said so in a
sentence rather than crashing, exactly as written here while it was still hypothetical. The
migration for a revision-1 plugin that uses nothing from 2 is one character.

## 3 → 4 *(2026-08-31, M6-11)*

**One widget.** `graph`.

A `table` says what is there; a `graph` says **what points at what** — nodes, edges, and a
force layout core draws (D115). It reads the same `rows` tool a table does, over the same
`structuredContent`, and adds three optional fields to a row: `label`, `links` (an array of
the **ids** it points at) and `mark` (a ring, whose meaning your `hint` gives).

```jsonc
{
  "alexia_protocol": 4,
  "panel": {
    "label": "Memory",
    "widgets": [
      { "key": "shape", "type": "graph", "label": "The shape of it",
        "rows": "memory_graph", "detail": "about_memory", "filter": true }
    ]
  }
}
```

Full field list in [`manifest.md`](./manifest.md#graphs); what core draws and what it refuses
to let you decide is in [`ui-schema.md`](./ui-schema.md#graph).

**The floor did not rise this time**, and that is a decision rather than an oversight. The
promise above is that one revision back is *supported* — supporting two costs nothing, and
seven first-party plugins declare 2 and use nothing from 3. Dropping them to keep a number
tidy would be breaking working software to make a point about deprecation. Raising `MIN` is
what deprecating a revision looks like, and there is nothing here worth deprecating yet.

**Nothing was removed and nothing changed meaning.** A manifest written against revision 2 or
3 is still valid and loads unchanged.

### If you are updating a plugin

**You want a `graph`.** Set `"alexia_protocol": 4` and declare one. Declaring it while still
saying `3` is a load error, the same rule `panel` and `lifetime` set — an older Alexia would
otherwise refuse your manifest as unparseable, which tells you nothing about which end is out
of date.

## 2 → 3 *(2026-08-29, M6-2 and M6-3)*

**One field and one widget.** `panel`, and `table`.

A plugin declaring a screen of its own, the same way it declares settings (D86). What it
declares is **assembled** rather than typed anywhere: the widgets are there because a manifest
says so and somebody enabled the plugin. The previous Alexia's dashboard listed nine tabs by
hand in one file and grew a 480-line panel for a single text-to-speech vendor inside its own
source tree — this field is what makes that impossible rather than merely discouraged, and
deleting a plugin folder takes its panel with it.

*Where that panel is drawn changed at D118 and the field did not: it was a tab on the control
surface, and it is now the second half of the plugin's own page, under the settings that drive
it. No revision, because nothing a manifest says about it changed.*

```jsonc
{
  "alexia_protocol": 3,
  "panel": {
    "label": "Voice",
    "widgets": [
      { "key": "which_voice", "type": "choice", "label": "Who speaks", "options": ["Ada", "Rowan"] }
    ]
  }
}
```

The widgets are the settings widgets, unchanged — a plugin that cannot style itself wrong on
one screen must not be able to on another. What makes a panel not a settings pane is what it
is *for*: settings are values you change, a panel is a record you read, and the one or two
things you change while reading it.

**`settings` and `panel.widgets` are one namespace.** A widget's value is stored once, in the
plugin's own settings, so a key declared in both lists would be one value with two
declarations that could disagree about its type. Declaring a key twice is a load error;
choosing which screen a widget belongs on is yours.

### `table`, the eleventh widget

`ui-schema.md` promised that an eleventh widget *"is a conversation"*. That conversation was
held here (D83) and the answer was yes, once: **a list of things with actions on each one**.
The evidence was behavioural rather than aesthetic — the previous Alexia's dashboard
hand-wrote that same object four times, its second copy admitting in a comment that it
*"mirrors SkillsTab's own shape, since the lifecycle is identical by design"*.

```jsonc
{ "key": "installed", "type": "table", "label": "Installed",
  "rows": "list_things",
  "columns": [{ "key": "name", "label": "Name" }],
  "rowActions": [{ "key": "remove", "label": "Remove", "tool": "remove_thing",
                   "confirm": "Remove {name}?" }] }
```

Full field list in [`manifest.md`](./manifest.md#tables). Two things about it are contract
rather than convenience: **a row action is an `action`** — the same permission gate, the
question beside the row, no second concept — and **rows arrive over MCP's own
`structuredContent`**, shaped `{ "rows": [ … ] }` with a string `id` on each, because Alexia
adds no envelope of its own where the protocol already has one.

`file` and `graph` were asked for in the same conversation and **refused**. Each had exactly
one user, which is this schema's own bar for no, and both are attached to the task where
their single user is the evidence rather than granted for sounding useful. `graph` was refused
a second time at M6-7 and granted at M6-11 — see *3 → 4* above for what changed.

**Nothing was removed and nothing changed meaning.** A manifest written against revision 2 is
a valid revision 2 manifest and loads unchanged.

### If you are updating a plugin

Two cases, and only one of them is work.

- **You declared `alexia_protocol: 1`.** Change it to `2` or `3`. Nothing else. Revision 1
  and revision 2 differ by one optional field, so a manifest that never mentioned `lifetime`
  is already a valid revision 2 manifest and says so by changing one character.
- **You want a `panel`.** Set `"alexia_protocol": 3` and add the field. Declaring it while
  still saying `2` is a load error, on purpose — the same rule `lifetime` set, for the same
  reason: an integer that a manifest can quietly ignore is an integer that means nothing.

## 1 → 2 *(2026-08-28, M4-9)*

**One field.** `lifetime`.

M4 existed to break the contract before anyone else depended on it, and it broke in exactly
one place. Lazy spawn — quiet for five minutes and the process exits, the next call brings
it back — assumes every plugin is something core *calls into*. The first plugin where
messages arrive from **outside** proved that false: a chat bridge holding a long poll is not
idle when nobody has typed at it for an hour, it is working, and stopping it is the same as
switching it off (D77).

```jsonc
{
  "alexia_protocol": 2,
  "lifetime": "resident"     // or "lazy", which is the default and what almost everything is
}
```

`resident` means *I hold something open*. It costs memory forever, so it is opt-in, it is
visible in the library, and invariant 9 names it as the exception rather than widening to
accommodate it.

**Nothing was removed and nothing changed meaning.** A manifest written against revision 1
is a valid revision 1 manifest and loads unchanged.

### If you are updating a plugin

Only if you want `lifetime`. Then: set `"alexia_protocol": 2` and add the field. Declaring
`lifetime` while still saying `1` is a load error, on purpose — an integer that a manifest
can quietly ignore is an integer that means nothing.

*Since 3, revision 1 no longer loads at all — see the section above.*

### What was considered and not added

**A `channel` abstraction** (M4-8). Deferred at n=2 deliberately, revisited here at n=3, and
the answer is still no — see D78. The three surfaces differ in the one thing an abstraction
would have to unify: who owns the conversation, and where a permission question goes. The
honest answer on a phone chat is *nowhere*, which is why that surface has no tools rather
than a shared abstraction with a hole in it. The cost of waiting is a little duplicated
plumbing; the cost of guessing wrong is a permanent tax on every plugin.

**Environment variables in `entry`.** MCP servers added through compatibility mode often
want an API key in the environment. Not added, because the moment a manifest can name an
environment variable, a plugin can name one it did not declare — and settings plus the
keychain already solve this for plugins that are ours. Revisit when somebody has an MCP
server they actually cannot use without it.
