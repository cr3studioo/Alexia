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
        │  initialize  { protocolVersion, … }          │
        │─────────────────────────────────────────────>│
        │<──────── protocolVersion, capabilities ──────│
        │  notifications/initialized ─────────────────>│
        │                                              │
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

*Decision G3, made 2026-08-27. Corrected the same day by D57, after the first supervisor
was built against it — see [Two eras](#11-two-eras-and-why-a-plugin-lives-on-the-older-one).*

| | |
|---|---|
| **What a plugin is built on** | `2025-11-25` |
| **Also accepted** | `2026-07-28`, for servers that speak only it |
| **Not accepted** | `2025-06-18`, `2025-03-26`, `2024-11-05`, `draft` |

**Core supports exactly two revisions at a time.** That is the whole policy, and it is
chosen for one reason — a plugin author who is asleep when MCP ships a revision should not
wake up to a broken plugin, and Alexia should not be carrying five wire dialects to promise
that.

When MCP publishes a new revision, core adds it in a **minor** release and drops the oldest
of the three one minor release later. Both steps are in the release notes, and the registry
warns the author of every plugin that will stop loading, before it stops loading.

### 1.1 Two eras, and why a plugin lives on the older one

`2026-07-28` is not a bigger `2025-11-25`; it is a different wire era. It deleted
`initialize` (version, client identity and capabilities ride in `params._meta` on every
request instead), replaced unsolicited server notifications with a `subscriptions/listen`
stream, and — the part that decides this — **removed the server-to-client request
channel entirely.** On `2026-07-28` a server cannot send its host a request. It can only
*answer* one with `input_required`, and the shapes it may ask for are MCP's own three:
elicitation, sampling, roots.

The `alexia/*` layer (§6) is five methods a plugin sends *to core*: its settings, its
storage, another plugin's capability, the host it is running on. On `2026-07-28` every one
of them is dropped by a conforming client, unanswered. Measured, not assumed:

```
era=modern  version=2026-07-28  ->  Dropped inbound request 'alexia/host/info':
                                    not servable on this connection's protocol era
era=legacy  version=2025-11-25  ->  answered: {"platform":"win32"}
```

So an Alexia plugin speaks `2025-11-25`, which is also what
`@modelcontextprotocol/server` v2 reports as its latest and serves by default over stdio.
Core still accepts a `2026-07-28` server — a plain MCP server added through compatibility
mode has no use for `alexia/*` and works fine — it simply has no Alexia layer.

> **What happens when MCP retires the older era.** The five methods move to a channel of
> Alexia's own and `@alexia/sdk` keeps the same shape, so the contract a plugin author
> writes against does not move. That is the reason the layer is called `alexia/*` and not
> an MCP extension.

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
  waits 2 s, then sends `SIGTERM`, then kills the process 2 s after that. Do not
  plan to flush anything slow at exit; write as you go.

Core also captures **stderr** for the whole life of the process. It is tagged with your
plugin id, ring-buffered, and shown in the plugin's log panel. Write freely there.

---

## 3. Starting up

### 3.1 Spawn

Core reads [`plugin.json`](./manifest.md) **before the process exists** and spawns
`entry.run` with `entry.args`.

`"run": "node"` gets **Alexia's bundled Node**, not a system install. Your users never
install a runtime. Anything else in `run` must be on `PATH` or be a path relative to the
plugin directory. `entry.run`, and any argument that names a file inside your folder, are
made absolute before the spawn; everything else is passed through untouched.

**Your working directory is not your folder**, and this is deliberate. Windows refuses to
delete a directory that is a running process's working directory, and *delete the folder
while Alexia is running* is the one thing this project has to be true. So:

| | |
|---|---|
| working directory | a directory core owns and purges with you: yours to write in |
| `ALEXIA_PLUGIN_DIR` | your folder — the one your `plugin.json` and your files are in |
| environment | a safe subset, plus that one variable. Not the user's whole environment. |

Read your own files from `ALEXIA_PLUGIN_DIR` (or, in a language that has it, from the
script's own directory). **Never build a path by hand**, and never assume the working
directory is anywhere in particular.

### 3.2 `initialize` — the handshake

Core's first message.

```jsonc
// core → plugin
{ "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": {
    "protocolVersion": "2025-11-25",
    "clientInfo": { "name": "Alexia", "version": "0.1.0" },
    // Only what core can serve. `elicitation` appears once there is a UI to ask the user
    // in; check what you were offered rather than assuming.
    "capabilities": { "roots": {}, "sampling": {} } } }
```

```jsonc
// plugin → core
{ "jsonrpc": "2.0", "id": 1, "result": {
  "protocolVersion": "2025-11-25",
  "serverInfo": { "name": "voice", "version": "0.3.1" },
  "capabilities": { "tools": { "listChanged": true } },
  "instructions": "Turns speech into text and text into speech."
} }
```

Core then sends `notifications/initialized` and the session is live.

`instructions` is optional natural-language guidance about the server as a whole. Alexia
puts it in the system prompt when any of your tools are in scope, so write it for the model,
not for the user — and do not repeat what your tool descriptions already say.

A plugin that does not answer within **10 seconds** is treated as failed to start. Answer it
before you load models, open files, or hit the network.

> **A server that speaks only `2026-07-28`** answers `server/discover` instead, and must be
> served through its SDK's era-owning stdio entry point (`serveStdio` in the TypeScript
> one) — a plain stdio server answers `server/discover` with `-32601` and the connection
> falls back to `2025-11-25`, which is usually what you wanted anyway. Core probes for
> `server/discover` first and falls back on its own.

### 3.3 The two version checks

They are different versions doing different jobs, and both run before your plugin may do
anything.

| Version | Whose | Where it is declared | What it means |
|---|---|---|---|
| `mcp_protocol` | MCP's | `plugin.json`, confirmed by the handshake | which MCP revision you speak |
| `alexia_protocol` | ours, an integer | `plugin.json` only | which Alexia contract you were written against |

**Check one — MCP.** Core intersects its two accepted revisions with what your process
actually serves, preferring `2025-11-25`. No overlap, or an overlap that does not include
the revision your manifest declared: refusal, §8. Declaring one revision and serving another
is a manifest core cannot trust about anything else either.

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

### 3.4 How core hears about changes

Send `notifications/tools/list_changed` whenever your tool list changes, and core re-reads
`tools/list`. Nothing to subscribe to: on `2025-11-25` a server may send it unprompted, and
core listens from the moment the handshake completes.

> **On `2026-07-28`** a server must not send a notification the client did not ask for, so
> core opens one long-lived `subscriptions/listen` request per connection instead, filtered
> to `toolsListChanged`. Notifications then carry
> `_meta["io.modelcontextprotocol/subscriptionId"]`, and answering that request ends the
> subscription — so answer it only when you are shutting down.

Progress notifications for an in-flight request are not part of this either way — they are
tied to the request that carried the `progressToken`.

### 3.5 Ready

After the handshake, core calls `tools/list` and the plugin is live. Total budget from spawn
to live: **2 seconds**, on the machine of someone who has never opened a terminal. Load your
model on first use, not at start.

---

## 4. What core told you it can do

The handshake's `capabilities` are what core can do **for this session**, and they are the
only thing you may rely on. Two of them matter to a plugin:

| Capability | Present when | Lets you |
|---|---|---|
| `sampling` | the user's privacy mode allows a model call for this plugin | `sampling/createMessage` |
| `elicitation` | there is a UI to ask the user in (M1 onward) | `elicitation/create` |
| `roots` | always | `roots/list` |

**Check what you were given rather than assuming**, every time: a capability core did not
offer is a `-32021` if you use it, and Alexia withdraws `sampling` when the user switches to
a privacy mode that forbids it.

`params._meta.progressToken`, when core sends one, is opaque — echo it in
`notifications/progress`.

> **On `2026-07-28`** there is no handshake, so the version, core's identity and core's
> capabilities travel in `params._meta` on **every** request, under the reserved
> `io.modelcontextprotocol/…` keys, and they must not be remembered between requests.

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
| a plugin needs the model | `sampling/createMessage`, carried in-band — see below |
| a plugin asks the user something | `elicitation/create`, carried the same way |
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

### Asking core for something, mid-call

A plugin is a server, and on `2025-11-25` a server may send its host a request at any time —
including while it is in the middle of serving a `tools/call`. That is how `alexia/*` (§6)
works, and how sampling, elicitation and roots work:

```jsonc
// plugin → core, while tools/call id 7 is still open
{ "jsonrpc": "2.0", "id": 101, "method": "sampling/createMessage",
  "params": { "messages": [ { "role": "user", "content": { "type": "text", "text": "…" } } ],
              "maxTokens": 256 } }
// core → plugin
{ "jsonrpc": "2.0", "id": 101, "result": { "role": "assistant", "model": "…",
              "content": { "type": "text", "text": "…" } } }
```

> **On `2026-07-28` this direction does not exist.** A server answers the call it is serving
> with an `input_required` result naming what it needs, core fulfils it and re-sends the same
> call with `inputResponses` attached and a fresh id — so a handler runs more than once per
> logical call, and anything it wants to remember between rounds goes in the opaque
> `requestState` (which comes back through the client, so treat it as untrusted). The MCP
> SDKs' `inputRequired(…)` / `inputResponse(…)` helpers write it once and work on both eras;
> `alexia/*` has no such fallback, which is [why a plugin lives on the older
> era](#11-two-eras-and-why-a-plugin-lives-on-the-older-one).

### Sampling

`sampling/createMessage` is how a plugin uses the model without shipping one, without an API
key, and without knowing which model it got. Core routes it exactly like its own calls —
tier, privacy mode, spend cap, all of it — so a plugin cannot spend the user's money behind
their back or leak a Local-mode prompt to a cloud provider.

Only available when the request's `clientCapabilities` include `sampling`. Check, do not
assume.

> **Deprecated upstream, kept here.** SEP-2577 deprecates `sampling/createMessage` and
> `roots/list` as of `2026-07-28` and tells hosts to call provider APIs directly instead.
> They remain in the spec for at least twelve months. Alexia keeps both, because the advice
> assumes the caller has an API key: a plugin does not have one, must not have one, and the
> whole point of routing through core is that the user's tier, privacy mode and spend cap
> apply to a plugin's model use exactly as they apply to Alexia's own. If MCP removes them,
> they become `alexia/*` methods — the contract a plugin author writes against does not move.

### Elicitation

`elicitation/create` is how a plugin asks the user a question — an API key, a folder, a
yes/no. It renders in Alexia's own UI from your schema. This is the *only* way a plugin gets
input from the user at runtime; see [`ui-schema.md`](./ui-schema.md) for settings, which are
the other half.

Only available when `clientCapabilities` include `elicitation` — which core does not offer
until it has a UI to ask in (M1). Check every time.

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

> **These require the `2025-11-25` era**, because four of the five are requests a plugin
> sends to core and `2026-07-28` has no such direction. A server that speaks only the newer
> revision still connects and its tools still work; it simply has no Alexia layer, and any
> `alexia/*` request it sends is dropped unanswered. See
> [§1.1](#11-two-eras-and-why-a-plugin-lives-on-the-older-one).

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
