# Storage, and what purge takes

One SQLite file. Alexia owns it, you get a namespace, and **purge drops the namespace**.
That last part is the reason the API looks the way it does.

## The typed API

You declare your tables in the manifest and use them by the name you declared:

```js
await alexia.storage.insert('asked', { question: 'coat?', at: Date.now() })
await alexia.storage.select('asked', { where: { at: { gt: yesterday } }, order: [['at', 'desc']], limit: 20 })
await alexia.storage.update('asked', { answered: 1 }, { rowid: 3 })
await alexia.storage.delete('asked', { at: { lt: lastMonth } })
await alexia.storage.count('asked')
```

Alexia creates them as `p_<your-id>_<table>`. You never see the prefix, and purge is
`DROP TABLE p_<your-id>_*`. Nothing to parse, nothing to get wrong, and the purge check can
prove the absence of residue exactly.

**A table you did not declare is not yours** — the call is refused with
`STORAGE_OUT_OF_NAMESPACE`, which is also how the conformance suite proves you stayed
inside your namespace without watching your disk.

**Columns appear as you use them.** A table starts as nothing but its rowid and grows a
column the first time a key shows up. No migrations, no schema block in the manifest.

### `where`

Keys are columns; a value is either a literal (equals) or exactly one operator. Multiple
keys are AND. No OR, no nesting, no joins.

`eq` `ne` `lt` `lte` `gt` `gte` `in` `like` `isNull`

**`delete` will not take an empty `where`.** To empty a table, say `{ all: true }` and mean
it.

### Raw SQL

There is an escape hatch and it currently refuses everything. It is an open question, and
the first plugin that genuinely needs a join is the evidence that will settle it. Say so.

## `kv`, for small things

```js
await alexia.storage.set('last_run', Date.now())
await alexia.storage.get('last_run')
await alexia.storage.remove('last_run')
```

JSON, up to 64 KB. Anything bigger belongs in a table or in a file.

## Files

Declare `"storage": { "dir": true }` and ask for `fs.own_dir`, then:

```js
const { paths } = await alexia.host()
// paths.ownDir — yours, purged with you, and the only directory you may assume exists
```

It is also your working directory, so a relative path lands there. It is **not** your plugin
folder — see [lifecycle.md](./lifecycle.md).

Do not write anywhere else. Anything outside `ownDir` and your own folder is residue that
purge cannot find, and the conformance suite fails you for it.

## Secrets

A `password` setting never touches the database. Alexia keeps it in the OS keychain and
hands it back through `alexia.settings()` — read it when you need it, do not cache it, do
not log it. Deleting your plugin deletes the keychain entry.
