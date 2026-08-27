# The wire protocol

> **The bar this document is written to:** someone could write an Alexia plugin in a
> language with no SDK, using only this file. If you hit something you have to guess,
> that is a bug in this document — open an issue.
>
> Companion specs: [`manifest.md`](./manifest.md) · [`capabilities.md`](./capabilities.md) ·
> [`storage.md`](./storage.md) · [`ui-schema.md`](./ui-schema.md) ·
> [`skills.md`](./skills.md) · [`invariants.md`](./invariants.md)
>
> Written 2026-08-27 against MCP revision `2026-07-28`.

---

## In one page

A plugin is **an MCP server in its own process**. Alexia's core is **an MCP client**. They
talk JSON-RPC 2.0 over the plugin's stdin and stdout.

```
  core (MCP client)                         plugin process (MCP server)
        │                                              │
        │  spawn: entry.run + entry.args               │
        │─────────────────────────────────────────────>│
        │                                              │
        │  server/discover                             │
        │─────────────────────────────────────────────>│
        │<───────── supportedVersions, capabilities ───│
        │                                              │
        │  two version checks, then:                   │
        │  subscriptions/listen  { toolsListChanged }  │
        │─────────────────────────────────────────────>│   (stays open)
        │  tools/list                                  │
        │─────────────────────────────────────────────>│
        │<─────────────────────────── tools            │
        │                                              │
        │  tools/call ─────────────────────────────────>│
        │<───────────────────── alexia/storage/insert  │
        │  ────────────────────────────────────────────>│
        │<──────────────────── notifications/progress  │
        │<─────────────────────────── CallToolResult   │
```

Everything above except the `alexia/*` calls is plain MCP, used exactly as specified. The
five `alexia/*` methods are the only thing Alexia adds, and they exist only where MCP has
nothing.

**The one rule that breaks everything if you get it wrong:**

> ## stdout is the wire.
>
> Anything your plugin prints to stdout that is not a JSON-RPC message corrupts the
> stream and Alexia will drop your plugin. **All logging goes to stderr.** `print()`,
> `console.log`, a stray debugger banner, a progress bar from a library you called — all of
> it. Alexia captures your stderr, tags it with your plugin id, and shows it in the plugin's
> log panel, so you lose nothing by moving it.
>
> If you want structured logs that reach the user's log panel *as MCP*, send
> `notifications/message` (see [Logging](#logging)).

---

## 1. Which MCP revision, and the policy for moving

*Decision G3, made 2026-08-27.*

| | |
|---|---|
| **Pinned revision** | `2026-07-28` |
| **Also accepted** | `2025-11-25` |
| **Not accepted** | `2025-06-18`, `2025-03-26`, `2024-11-05`, `draft` |

**Core supports exactly two revisions at a time: the pinned one and its immediate
predecessor.** That is the whole policy, and it is chosen for one reason — a plugin author
who is asleep when MCP ships a revision should not wake up to a broken plugin, and Alexia
should not be carrying five wire dialects to promise that.

When MCP publishes a new revision:

1. Core adds it as the pinned revision in a **minor** release. The old pin becomes the
   predecessor. Nothing breaks.
2. One minor release later, the revision that was the predecessor is dropped, and plugins
   still speaking it fail the version check with the message in §8.
3. Both steps are in the release notes, and the registry warns the author of every plugin
   that will stop loading, before it stops loading.

`2025-11-25` is on the list because it is the last revision with the `initialize` handshake,
which is what most of the MCP ecosystem still speaks and what `@modelcontextprotocol/server`
v2 still serves as its *legacy era*. It is a bridge, not a commitment.

> **Why 2026-07-28 and not the comfortable older one.** The 2026 revision deleted
> `initialize`. Version, client identity and client capabilities now travel in `_meta` on
> **every request**, and a server advertises itself through `server/discover` instead. That
> is a better fit for Alexia than the handshake was: a plugin that is spawned lazily,
> killed when idle, and restarted after a crash has no long-lived session to initialise —
> and under the 2026 rules it does not need one.

---

## 2. Transport

**stdio, one process per plugin.** No ports, no sockets, no localhost, no inbound firewall
rule, nothing for another program on the machine to connect to. Core writes JSON-RPC
messages to the plugin's stdin and reads them from its stdout.

- **Framing:** one JSON-RPC message per line, UTF-8, terminated by `\n`. Messages must not
  contain a raw newline (escape it as `\n` inside JSON strings, which JSON requires anyway).
- **Ordering:** requests may be answered out of order. Match on `id`.
- **Batching:** not used. Send one message per line.
- **Exit:** when core closes your stdin, finish in-flight work if you can and exit. Core
  waits 5 s, then sends `SIGTERM`, then 2 s later kills the process.

Core also captures **stderr** for the whole life of the process. It is tagged with your
plugin id, ring-buffered, and shown in the plugin's log panel. Write freely there.

---

## 3. Starting up

### 3.1 Spawn

Core reads [`plugin.json`](./manifest.md) **before the process exists** and spawns
`entry.run` with `entry.args`, with the plugin's own directory as the working directory.

`"run": "node"` gets **Alexia's bundled Node**, not a system install. Your users never
install a runtime. Anything else in `run` must be on `PATH` or be a path relative to the
plugin directory.

### 3.2 `server/discover` — the handshake

Core's first message. It is a normal request, and per MCP a server **MUST** implement it.

```jsonc
// core → plugin
{ "jsonrpc": "2.0", "id": 1, "method": "server/discover",
  "params": { "_meta": {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { "name": "Alexia", "version": "0.1.0" },
    "io.modelcontextprotocol/clientCapabilities": {
      "roots": {}, "sampling": { "tools": {} }, "elicitation": { "form": {} }
    }
  } } }
```

```jsonc
// plugin → core
{ "jsonrpc": "2.0", "id": 1, "result": {
  "supportedVersions": ["2026-07-28", "2025-11-25"],
  "capabilities": { "tools": { "listChanged": true } },
  "instructions": "Turns speech into text and text into speech."
} }
```

`instructions` is optional natural-language guidance about the server as a whole. Alexia
puts it in the system prompt when any of your tools are in scope, so write it for the model,
not for the user — and do not repeat what your tool descriptions already say.

A plugin that does not answer `server/discover` within **10 seconds** is treated as failed to
start. Answer it before you load models, open files, or hit the network.

### 3.3 The two version checks

They are different versions doing different jobs, and both run before your plugin may do
anything.

| Version | Whose | Where it is declared | What it means |
|---|---|---|---|
| `mcp_protocol` | MCP's | `plugin.json`, confirmed by `server/discover` | which MCP revision you speak |
| `alexia_protocol` | ours, an integer | `plugin.json` only | which Alexia contract you were written against |

**Check one — MCP.** Core intersects its two accepted revisions with your
`supportedVersions` and uses the newest match. No match: refusal, §8.

**Check two — Alexia.** Core reads `alexia_protocol` from the manifest and compares it to
the range core speaks.

```
plugin says: alexia_protocol 1     core speaks 1..3   ->  loads
plugin says: alexia_protocol 3     core speaks 1..3   ->  loads
plugin says: alexia_protocol 4     core speaks 1..3   ->  does not load, and says so
plugin says: alexia_protocol 0     core speaks 1..3   ->  does not load, and says so
```

Check two reads a file. It happens **before spawn**, so a plugin written for a newer Alexia
never gets a process at all.

### 3.4 `subscriptions/listen` — how core hears about changes

Under `2026-07-28` a server **must not** send a notification the client did not ask for —
on stdio exactly as on HTTP. So core opens one long-lived subscription per plugin,
immediately after the version checks:

```jsonc
// core → plugin
{ "jsonrpc": "2.0", "id": 2, "method": "subscriptions/listen",
  "params": { "notifications": { "toolsListChanged": true }, "_meta": { /* envelope */ } } }
```

This request stays open for the life of the process. Notifications you send on it carry
`_meta["io.modelcontextprotocol/subscriptionId"]` equal to its id. Responding to it ends the
subscription, so respond only when you are shutting down.

Core subscribes to `toolsListChanged` always. It subscribes to the other filters only if
your `server/discover` capabilities advertise them.

Progress notifications for an in-flight request do **not** go on this stream — they are tied
to the request that carried the `progressToken`.

### 3.5 Ready

After `subscriptions/listen`, core calls `tools/list` and the plugin is live. Total budget
from spawn to live: **2 seconds**, on the machine of someone who has never opened a
terminal. Load your model on first use, not at start.

---

## 4. The per-request envelope

Every request core sends carries these keys in `params._meta`:

| Key | Always? | Value |
|---|---|---|
| `io.modelcontextprotocol/protocolVersion` | **yes** | the negotiated revision, e.g. `"2026-07-28"` |
| `io.modelcontextprotocol/clientCapabilities` | **yes** | what core can do *for this request* |
| `io.modelcontextprotocol/clientInfo` | yes | `{ "name": "Alexia", "version": "0.1.0" }` |
| `progressToken` | when core wants progress | opaque; echo it in `notifications/progress` |

Capabilities are per-request and **must not be remembered between requests**. If core sends
`sampling` on one call and not the next, the second call may not use `sampling/createMessage`.
This is MCP's rule, not ours, and it exists so a host can withdraw a capability mid-session —
which is exactly what Alexia does when the user switches to a privacy mode that forbids it.

Your own requests to core carry the same `protocolVersion` key. Core rejects a request whose
version is not the negotiated one with `-32022`.

---

## 5. What MCP covers

Used exactly as MCP specifies. No reinterpretation — the moment Alexia gives an MCP method
a private meaning, sharing an ecosystem with every other MCP host stops being worth anything.

| Alexia concept | MCP |
|---|---|
| the handshake | `server/discover` + per-request `_meta` |
| core calls a plugin | `tools/call` |
| what a plugin can do, right now | `tools/list` |
| **a tool can vanish mid-task** | `notifications/tools/list_changed` on the listen stream |
| a plugin needs the model | `sampling/createMessage` |
| a plugin asks the user something | `elicitation/create` |
| a long download, with a bar | `notifications/progress` against a `progressToken` |
| stop, and mean it | `notifications/cancelled` |
| a plugin logs | `notifications/message` |
| where Alexia is allowed to work | `roots` + `roots/list` |
| how risky is this tool call | `annotations` on the `Tool` |

### Tools

Tools are **not** in the manifest. They come from `tools/list` at runtime, because they can
change — a voice plugin with no model downloaded yet has no `transcribe` tool, and gains one
the moment the download finishes. That is a `notifications/tools/list_changed`, and Alexia
re-plans around it mid-task rather than crashing.

```jsonc
{ "name": "transcribe",
  "title": "Transcribe speech",
  "description": "Turn a recorded audio file into text. Use when the user has audio to read.",
  "inputSchema": { "type": "object",
    "properties": { "path": { "type": "string" } }, "required": ["path"] },
  "outputSchema": { "type": "object", "properties": { "text": { "type": "string" } } },
  "annotations": { "readOnlyHint": true, "openWorldHint": false } }
```

`annotations` decide whether a call needs the user's permission — see
[Permission modes](#7-permission-modes-are-read-off-your-annotations). Get them right.

A tool result is a `CallToolResult`:

```jsonc
{ "content": [ { "type": "text", "text": "…" } ],
  "structuredContent": { "text": "…" },     // required if you declared outputSchema
  "isError": false }
```

**A tool that failed at its job returns `isError: true` with the failure in `content`, not a
JSON-RPC error.** The model has to see the failure to recover from it; a protocol error is
invisible to the model and just ends the step. Reserve JSON-RPC errors for "this request was
malformed" and "this tool does not exist".

### Sampling

`sampling/createMessage` is how a plugin uses the model without shipping one, without an API
key, and without knowing which model it got. Core routes it exactly like its own calls —
tier, privacy mode, spend cap, all of it — so a plugin cannot spend the user's money behind
their back or leak a Local-mode prompt to a cloud provider.

Only available when the request's `clientCapabilities` include `sampling`. Check, do not
assume.

### Elicitation

`elicitation/create` is how a plugin asks the user a question — an API key, a folder, a
yes/no. It renders in Alexia's own UI from your schema. This is the *only* way a plugin gets
input from the user at runtime; see [`ui-schema.md`](./ui-schema.md) for settings, which are
the other half.

Only available when `clientCapabilities` include `elicitation`.

### Logging

`notifications/message` — level, optional `logger`, and `data`. Core opts in per request via
`_meta["io.modelcontextprotocol/logLevel"]`; **with no level set, do not send them.**

That key is already deprecated upstream (SEP-2577) and stays in the spec for at least twelve
months. Alexia sends it while it exists. Either way, stderr is the reliable channel and the
one the log panel always shows.

---

## 6. The `alexia/*` layer

Five methods. Everything MCP covers is MCP; this is the remainder. **If you want a sixth,
argue it against MCP first** — the whole value of adopting MCP evaporates one private
extension at a time.

All five are called **plugin → core**, except `alexia/settings/changed`, which is a
notification core sends you.

### `alexia/settings/get`

Read your own settings. Core owns the values; the manifest declares their shape and defaults.
You cannot read another plugin's settings, and there is no method to try.

```jsonc
// → { "jsonrpc":"2.0", "id":9, "method":"alexia/settings/get", "params": { "_meta": {…} } }
// ← { "jsonrpc":"2.0", "id":9, "result": { "settings": { "model_size": "base" } } }
```

Every key you declared in `settings[]` is present, with the user's value or your `default`.
A `password`-type setting comes back as the real secret, read from the OS keychain at the
moment of the call — so do not cache it, and do not log it.

### `alexia/settings/changed`

Notification, core → plugin, sent when the user edits a setting while you are running.

```jsonc
{ "jsonrpc": "2.0", "method": "alexia/settings/changed",
  "params": { "changed": { "model_size": "small" } } }
```

Only the keys that changed. React or ignore, but do not exit — core will not restart you for
a settings edit and the user is watching.

### `alexia/storage/*`

Namespaced reads and writes against the tables you declared in the manifest. Core creates
them as `p_<namespace>_<table>`; you never see the prefix and never write SQL that spans it.

```jsonc
// → { …, "method": "alexia/storage/insert",
//      "params": { "table": "transcripts", "row": { "text": "…", "at": 1756300000 } } }
// ← { …, "result": { "rowid": 41 } }
```

The operations are `insert`, `select`, `update`, `delete`, `count`, and a `kv` store for
small values. Full shapes, the `where` grammar, the raw-SQL escape hatch and exactly what a
purge removes are in [`storage.md`](./storage.md).

Two things that belong here rather than there: **core owns the database**, and **purge means
purge**. When the user deletes your folder, every `p_<namespace>_*` table, every settings key,
every secret and your whole directory go with it, and a CI check diffs the filesystem to
prove it.

### `alexia/capability/call`

Call something another plugin provides — **by capability name, never by plugin id.**

```jsonc
// → { …, "method": "alexia/capability/call",
//      "params": { "cap": "voice.speak", "arguments": { "text": "Done." } } }
// ← { …, "result": { "content": [ { "type": "text", "text": "spoken" } ], "isError": false } }
```

The result is a `CallToolResult`. **It does not say who answered, and there is no way to
ask.** That is not politeness, it is the invariant in code: if a plugin could learn that
`voice.speak` was answered by the `voice` plugin, it could depend on `voice`, and deleting
the folder would break something else.

If no enabled plugin provides the capability, core answers `-32050` (§8). Declare what you
need in `requires[]` so the user is told at install time instead of at failure time. Names
come from [`capabilities.md`](./capabilities.md); adding one is a pull request, not a string
you invent.

### `alexia/host/info`

```jsonc
// ← { …, "result": {
//   "platform": "win32", "arch": "x64",
//   "alexiaVersion": "0.1.0", "alexiaProtocol": 1,
//   "displayName": "Alexia",
//   "privacyMode": "combined",
//   "paths": { "ownDir": "…", "cacheDir": "…" },
//   "locale": "en-GB"
// } }
```

- `displayName` is what the user renamed Alexia to. **Use it in anything the user reads.**
  It is data, never code — never compare it to `"Alexia"`.
- `privacyMode` is `local` | `combined` | `cloud`. If it is `local`, do not reach the network
  for anything the user did not explicitly ask for.
- `paths.ownDir` exists only if you asked for `fs.own_dir`. It is yours, it is purged with
  you, and it is the only directory you may assume. **Never build a path by hand** — take
  `ownDir` and join onto it.

---

## 7. Permission modes are read off your annotations

Core decides whether a `tools/call` needs the user's approval by reading the tool's MCP
`annotations`. Nothing Alexia-specific, and nothing you declare twice.

| Mode | What happens to a call |
|---|---|
| Ask me every time | every call waits for the user |
| **Ask before anything risky** *(default)* | `readOnlyHint: true` runs; anything else waits |
| Watch and warn me | runs; the safety checker reviews it; flagged ones stop |
| Full trust | no prompts — the never-touch list still applies |

`destructiveHint: true` gates in every mode except Full trust.

**Annotations are a hint from an unreviewed process, and MCP says so itself.** Alexia trusts
them for plugins installed from its own registry, which are reviewed. A server added through
MCP compatibility mode is treated as if every tool were destructive until a human says
otherwise.

Marking a destructive tool `readOnlyHint: true` to skip a prompt is grounds for removal from
the registry. It is also the fastest way to lose a user who trusted you once.

---

## 8. Errors, and the exact words

### Codes

| Code | Name | Meaning |
|---|---|---|
| `-32700`…`-32603` | JSON-RPC standard | parse error, invalid request, method not found, invalid params, internal error |
| `-32021` | `MISSING_REQUIRED_CLIENT_CAPABILITY` | MCP: you used a capability the caller did not offer |
| `-32022` | `UNSUPPORTED_PROTOCOL_VERSION` | MCP: `data.supported[]`, `data.requested` |
| `-32050` | `CAPABILITY_NOT_AVAILABLE` | no enabled plugin provides that capability |
| `-32051` | `CAPABILITY_NOT_PERMITTED` | you did not declare it in `requires[]` |
| `-32052` | `STORAGE_OUT_OF_NAMESPACE` | that table is not yours |
| `-32053` | `SETTING_UNKNOWN` | no such key in your manifest |
| `-32054` | `DENIED_BY_USER` | the user refused the permission prompt |
| `-32055` | `CAP_EXCEEDED` | the spend or step ceiling for this task is spent |

`-32050`…`-32059` is Alexia's block. MCP holds `-32020`…`-32022`; leave the rest of that
range alone.

### What the user is told

Refusals are shown to a person who does not know what a protocol revision is, so they name
the plugin, say what is wrong, and say what to do. Verbatim:

```
Voice needs a newer Alexia.
Update Alexia, or install an earlier version of Voice.

Voice was written for an older version of Alexia and can't load.
Check whether Voice has an update.

Voice speaks a version of MCP that Alexia doesn't.
Alexia speaks 2026-07-28 and 2025-11-25; Voice speaks 2024-11-05.

Voice stopped three times in a minute, so Alexia has switched it off.
Everything else is still running. [Turn it back on]
```

That last line is the load-bearing one, and it is a test
([`invariants.md`](./invariants.md), check 3), not a promise.

**None of these strings may claim more than Alexia delivers.** Invariant check 8 greps
every user-facing string for over-claiming privacy language, and it fails the build. Local
mode means *the model runs on this machine*. It does not mean nothing left it — Telegram
alone disproves that.

---

## 9. Cancellation, progress, and a tool that disappears

### Stop must always work

The user's stop control sends `notifications/cancelled` with the `requestId`. On receiving
it: stop, free what you allocated, and **do not answer the cancelled request**. Core has
already stopped waiting.

A plugin that ignores cancellation gets killed instead, and killed is worse than stopped —
you do not get to finish a write.

### Progress

If the request's `_meta` carried a `progressToken`, echo it:

```jsonc
{ "jsonrpc": "2.0", "method": "notifications/progress",
  "params": { "progressToken": "t-7", "progress": 41, "total": 100,
              "message": "Downloading the speech model" } }
```

Send it for anything over about two seconds. First-run downloads are the whole reason the
five-minute setup budget holds, and a bar that moves is the difference between waiting and
quitting.

### A tool that disappears

Your tool list may change at any time. Send
`notifications/tools/list_changed` on the listen stream and core re-reads `tools/list`.

Core handles the harder direction too: if your **process is gone** mid-task — crashed,
killed, or its folder deleted while Alexia was running — the loop drops your tools, tells
the model they are gone, and re-plans. That is invariant check 4, and there is a test plugin
(`plugins/vanisher`) whose entire job is to disappear at the worst moment.

---

## 10. What Alexia does not use

Not forbidden, just not wired to anything yet. A plugin that offers them is fine; core will
not call them.

| MCP feature | Why not |
|---|---|
| `prompts/*` | Alexia's equivalent is skills, which are files, not a wire feature. See [`skills.md`](./skills.md). |
| `resources/*`, `subscriptions` on resources | Nothing in core reads resources yet. Likely at M4 with the memory plugin. |
| `completion/complete` | Alexia's settings UI renders from a schema; there is no free-text field to complete. |
| HTTP transport, `MCP-Protocol-Version` headers, `HeaderMismatchError` | stdio only. No ports by design. |
| `elicitation` URL mode | Only `form` mode is offered. A plugin sending the user to a browser is a decision, not a default. |

---

## Changing this document

The contract is **unstable until M4** and will break there — that is what M4 is for. Until
then:

- A change here is a change to `packages/protocol` in the same commit, or the two drift and
  the code wins by accident.
- Anything that changes what a *conforming plugin* must do bumps `alexia_protocol`.
- Anything that changes what core *offers* but not what a plugin must do does not.
