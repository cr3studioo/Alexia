# Storage, namespaces, and what a purge removes

> **One SQLite file. Core owns it. Each plugin gets a namespace it alone may touch. Delete
> the plugin and the namespace goes with it, provably.**
>
> The proof is [invariant check 5](./invariants.md): snapshot the database and the
> filesystem, install → enable → use → delete, diff. **The diff must be empty.** Everything
> in this document exists to make that check possible to write.
>
> Companions: [`manifest.md`](./manifest.md) · [`wire-protocol.md`](./wire-protocol.md)

---

## The file

One SQLite database in the platform's standard per-user application data directory, opened
by core with WAL enabled. Plugins never see the path and never open it. `node:sqlite` — the
one built into Node — so there is no native module to compile on the machine of someone
whose entire experience of Alexia is a double-click.

## The namespace

A plugin declares one in its manifest, and it must equal the plugin's `id`:

```jsonc
"storage": { "namespace": "voice", "tables": ["transcripts"], "dir": true }
```

Core creates each declared table as `p_<namespace>_<table>` — `p_voice_transcripts`. The
plugin says `transcripts` and never learns about the prefix. Everything a plugin owns is
therefore reachable by one glob, which is the point:

| What | Where | Purged by |
|---|---|---|
| tables | `p_voice_*` | `DROP TABLE` per match |
| key-value entries | `kv` rows where `ns = 'voice'` | `DELETE FROM kv WHERE ns = ?` |
| settings | `settings` rows where `plugin = 'voice'` | `DELETE FROM settings WHERE plugin = ?` |
| secrets | OS keychain, service `alexia`, account `voice/<key>` | one delete per `password` setting |
| its directory | `<dataDir>/plugins/voice/` | recursive remove |
| its skills | inside that directory | goes with it |
| its commands | derived from the manifest, never stored | gone when the folder is |

Nothing a plugin owns lives outside that list. If something ever needs to, it does not get
added to this table — it gets designed differently.

---

## The typed API

Core has to enforce the namespace **without parsing arbitrary SQL**, so v1 is a small typed
API over the tables declared in the manifest. Nothing to parse, nothing to get wrong, and a
purge that can be proved exactly.

All of these are `alexia/storage/*` requests, plugin → core.

### `insert`

```jsonc
// → { "table": "transcripts", "row": { "text": "hello", "at": 1756300000 } }
// ← { "rowid": 41 }
```

Columns are created on first insert from the JSON types of the values: string → `TEXT`,
number → `REAL` (or `INTEGER` if integral), boolean → `INTEGER`, null → nullable, object or
array → `TEXT` holding JSON. Every row also gets an implicit `rowid`. A later insert with a
new key adds a column; **no migrations, and no schema block in the manifest.**

### `select`

```jsonc
// → { "table": "transcripts",
//     "where": { "at": { "gte": 1756000000 } },
//     "order": [["at", "desc"]], "limit": 20, "offset": 0 }
// ← { "rows": [ { "rowid": 41, "text": "hello", "at": 1756300000 } ] }
```

### `update`, `delete`, `count`

```jsonc
// → update  { "table": "transcripts", "set": { "text": "…" }, "where": { "rowid": 41 } }
// ← { "changed": 1 }
// → delete  { "table": "transcripts", "where": { "at": { "lt": 1756000000 } } }
// ← { "deleted": 12 }
// → count   { "table": "transcripts", "where": {} }
// ← { "count": 41 }
```

`where` on `update` and `delete` is **required**, and `{}` is not accepted. Deleting a whole
table is `delete` with an explicit `"all": true`. This costs one keystroke and prevents the
oldest bug in the world.

### The `where` grammar

An object. Keys are column names; values are either a literal (meaning equals) or one
operator object. Multiple keys are `AND`. There is no `OR`, no nesting, and no joins.

| Operator | SQL |
|---|---|
| `{ "eq": v }` or a bare literal | `= ?` |
| `{ "ne": v }` | `!= ?` |
| `{ "lt": v }` `{ "lte": v }` `{ "gt": v }` `{ "gte": v }` | the obvious |
| `{ "in": [v, …] }` | `IN (?, …)` |
| `{ "like": "abc%" }` | `LIKE ?` |
| `{ "isNull": true }` | `IS NULL` |

Every value is a bound parameter. **No value from a plugin is ever concatenated into SQL.**

### `kv`

For small values that do not deserve a table — a cursor, a last-run timestamp, a cached
etag. No manifest declaration needed.

```jsonc
// → alexia/storage/kv/set  { "key": "last_model", "value": { "name": "base" } }
// → alexia/storage/kv/get  { "key": "last_model" }   ← { "value": { "name": "base" } }
// → alexia/storage/kv/delete { "key": "last_model" }
```

Values are JSON, capped at **64 KB**. Something larger belongs in a table, or in a file in
your own directory.

### Errors

| Code | When |
|---|---|
| `-32052` `STORAGE_OUT_OF_NAMESPACE` | a table not in your manifest, or a raw statement core cannot prove is yours |
| `-32602` `INVALID_PARAMS` | a malformed `where`, a missing `where` on update/delete, an oversized `kv` value |

---

## The raw SQL escape hatch, and why it is grudging

There is one, and it refuses more than it strictly needs to:

```jsonc
// → alexia/storage/raw
//   { "sql": "SELECT count(*) c FROM transcripts WHERE at > ?", "params": [1756000000] }
```

Core rewrites bare table names to their prefixed form, then **scans the statement for every
identifier it can find and rejects the whole thing if any of them is not inside your
prefix.** No `ATTACH`, no `PRAGMA`, no `sqlite_master`, no second statement, no CTE naming
an unknown table. When core is not sure, it says no.

> **This is [open question G1](../../questions.md), on purpose.** The typed API above has no
> joins and no aggregates beyond `count`, which is either fine or obviously not — and the
> first plugin that genuinely needs a join is the evidence. **Decide at M2, with voice as
> the evidence.** If it turns out one grudging regex is standing between plugin authors and
> ordinary work, the answer is a real query layer, not a more permissive regex.

---

## The plugin's directory

`"dir": true` gets you `<dataDir>/plugins/<id>/`, reachable as `paths.ownDir` from
`alexia/host/info`. It is created before your first spawn and removed with you.

**Never build a path by hand.** Take `ownDir` and join onto it — [invariant check
7](./invariants.md) fails the build over a literal `C:\` or `/home/`, and it is right to.

Your own files, your own model downloads, your own caches. Not the user's documents: that is
`fs.read_scoped` and the roots the user has actually opened.

---

## Lifecycle

| Stage | Storage state |
|---|---|
| **installed, never enabled** | nothing. No tables, no directory, no keychain entry. |
| **enabled** | directory created, declared tables created empty, settings rows written with their defaults |
| **disabled** | everything stays. Disabling is reversible and must not lose data — a user disabling a plugin to test something is the most common reason to disable one. |
| **deleted / purged** | the whole table above, executed in one transaction, then the directory, then the keychain entries |

Purge order matters: the database transaction commits **before** the directory is removed.
If the process dies between them, the next start finds a directory with no namespace and
removes it. The reverse — a namespace with no directory — would look exactly like a plugin
that has not been enabled yet, and would never be cleaned up.

---

## What core stores, which is not this

Sessions, message history, the step trace, usage and spend, the model catalog cache and the
settings table itself are core's, in the same file, without a `p_` prefix. Plugins cannot
read them through this API and there is no method that would let them try. Long-term recall
is a *plugin* ([`memory`](../../plan.md), M4) and gets a namespace like everyone else.
