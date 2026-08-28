# `alexia_protocol` — the revisions, and what changed

Two versions do two different jobs. `mcp_protocol` is upstream's, negotiated by the
handshake, handled by the SDK. **`alexia_protocol` is ours**: an integer, bumped when the
`alexia/*` layer or the manifest changes, and checked *before your process is spawned*.

```
you say alexia_protocol 1    Alexia speaks 1..2   ->  loads
you say alexia_protocol 3    Alexia speaks 1..2   ->  "X needs a newer Alexia"
```

## The promise, from v2 onwards

**One revision back is supported.** Alexia at revision *n* loads plugins declaring *n* and
*n−1*. When *n* becomes 3, plugins declaring 1 stop loading and say so in a sentence rather
than crashing — that refusal is the entire reason third-party plugins were safe to accept
while the contract was still moving.

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
