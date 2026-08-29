# `alexia_protocol` — the revisions, and what changed

Two versions do two different jobs. `mcp_protocol` is upstream's, negotiated by the
handshake, handled by the SDK. **`alexia_protocol` is ours**: an integer, bumped when the
`alexia/*` layer or the manifest changes, and checked *before your process is spawned*.

```
you say alexia_protocol 2    Alexia speaks 2..3   ->  loads
you say alexia_protocol 1    Alexia speaks 2..3   ->  "X was written for an older version"
you say alexia_protocol 4    Alexia speaks 2..3   ->  "X needs a newer Alexia"
```

## The promise, from v2 onwards

**One revision back is supported.** Alexia at revision *n* loads plugins declaring *n* and
*n−1*. That refusal is the entire reason third-party plugins were safe to accept while the
contract was still moving.

**It was kept at 3, on 2026-08-29.** Plugins declaring 1 stopped loading and said so in a
sentence rather than crashing, exactly as written here while it was still hypothetical. The
migration for a revision-1 plugin that uses nothing from 2 is one character.

## 2 → 3 *(2026-08-29, M6-2)*

**One field.** `panel`.

A plugin declaring a tab on the control surface, the same way it declares settings (D86). The
tab list on that screen is **assembled**: core contributes the tabs whose data core owns, and
every other one is a `panel` in the manifest of a plugin somebody has enabled. The previous
Alexia's dashboard listed nine tabs by hand in one file and grew a 480-line panel for a single
text-to-speech vendor inside its own source tree — this field is what makes that impossible
rather than merely discouraged, and deleting a plugin folder takes its tab with it.

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
