# `plugin.json` v1

> **What this file is.** The manifest is everything core needs to know about your plugin
> **while it is not running**: what to show in the library, what settings to render, what it
> requires, what it provides, and what to delete when the user is done with it.
>
> The complete, valid example this document refers to throughout is
> [`plugin.example.json`](./plugin.example.json). A test parses that exact file, so it
> cannot rot.
>
> Machine-readable schema: [`plugin.schema.json`](./plugin.schema.json), generated from
> `packages/protocol/src/manifest.ts`. Point your editor at it and the manifest validates as
> you type.
>
> Companions: [`wire-protocol.md`](./wire-protocol.md) ·
> [`capabilities.md`](./capabilities.md) · [`storage.md`](./storage.md) ·
> [`ui-schema.md`](./ui-schema.md) · [`skills.md`](./skills.md)

---

## Where it lives, and when it is read

`plugin.json` sits next to your entry point, in a folder whose name **is** your `id`:

```
plugins/
  voice/
    plugin.json
    index.js
    skills/dictating-well/SKILL.md
```

Core reads it **before your process exists** and before it is even willing to spawn one.
That is the whole reason the file exists: the library page, the settings screen, the
permission list and the purge plan all have to work for a plugin that is installed but has
never run, and for one that is disabled, and for one that is broken.

Anything that can only be known at runtime — your tools, most obviously — is **not** in
here. Tools come from `tools/list`, because they change.

---

## The fields

### Identity

| Field | Required | Notes |
|---|---|---|
| `manifest_version` | ✅ | `1`. Bumped only when this document's shape changes. |
| `id` | ✅ | Lowercase letters, digits and hyphens. Max 64 chars. **Must match the folder name.** |
| `name` | ✅ | What a person sees. `"Voice"`, not `"voice"`. |
| `summary` | ✅ | One line, ≤ 200 chars, shown in the library list. |
| `version` | ✅ | Semantic version. `0.1.0`. |
| `license` | ✅ | SPDX identifier. Yours, not Alexia's — the SDK is Apache-2.0 precisely so this can be anything. |
| `$schema` | — | Ignored by core; there so your editor finds the schema. |

**The `id` rule is one rule, deliberately.** agentskills.io requires a skill's `name` to
match its folder; Alexia requires a plugin's `id` to match its folder. Same rule, so you
learn it once. It is also what makes a purge provable: the folder, the storage namespace and
the settings keys all derive from one string.

### Running it

```jsonc
"entry": { "run": "node", "args": ["index.js"] }
```

`run` is a command on `PATH` or a path **relative to your plugin folder**. An absolute path
is rejected — it is right on your machine and wrong on everyone else's.

> **`"run": "node"` gets Alexia's bundled Node, not a system install.** Your users never
> install a runtime, and you never write an install guide that begins "first, install
> Node." This is a real advantage over every extension system that assumes a system
> runtime, and it is free.
>
> Anything else in `run` has to already be on the user's machine, and you have to say so.
> Whether Alexia ships a Python runtime the same way is [open question
> G2](../../questions.md), to be answered at M3.

### The two versions

```jsonc
"alexia_protocol": 1,          // ours: which Alexia contract you were written against
"mcp_protocol": "2025-11-25"   // MCP's: which revision your server speaks
```

They do different jobs and both are checked before you get a process.

`alexia_protocol` is an integer that goes up when the `alexia/*` layer changes. Core speaks
a range. Outside it, your plugin does not load and the user is told something they can act
on:

```
Voice needs a newer Alexia.
Update Alexia, or install an earlier version of Voice.
```

`mcp_protocol` is the upstream revision, and your process must actually serve the one you
declare — core confirms it at the handshake. Two are accepted: `2025-11-25`, which is what
an Alexia plugin speaks, and `2026-07-28`, which connects but has **no `alexia/*` layer**
because that revision removed the direction those methods travel in
([`wire-protocol.md` §1.1](./wire-protocol.md#11-two-eras-and-why-a-plugin-lives-on-the-older-one)).
If your plugin reads a setting, writes a row, or calls a capability, declare `2025-11-25`.

The schema only checks the *shape* of this field on purpose: an unaccepted-but-well-formed
revision should produce the readable refusal in
[`wire-protocol.md` §8](./wire-protocol.md#8-errors-and-the-exact-words), not a schema error
nobody can decode.

### What you need, and what you offer

```jsonc
"requires": [
  { "cap": "audio.input", "why": "to hear you speak" },
  { "cap": "net.download", "why": "to fetch the model once, from huggingface.co" }
],
"provides": ["voice.transcribe", "voice.speak"]
```

**`why` is not documentation.** It is the sentence the user reads when Alexia asks whether
to allow this, so write it for them: what you do with it, and where it goes. `"to fetch the
model once, from huggingface.co"` tells someone what will happen. `"needs network"` does
not. It is required, ≤ 120 chars, and a manifest without it is rejected.

Capability names are dotted, come from [`capabilities.md`](./capabilities.md), and adding
one is a pull request rather than a string you invent. `provides` is how another plugin
reaches you — **by capability, never by your id**, so that deleting your folder degrades a
capability instead of breaking a dependent.

Alexia's permissions are **declared and trusted, not enforced.** A plugin that declares
`audio.input` and reads your files is not stopped by the runtime. What stops it is that the
manifest is public, the source is public, and the registry has a revoke button. That
limitation is stated plainly rather than papered over; OS-level enforcement stays possible
later for the filesystem and the shell, and nowhere else.

### Settings

```jsonc
"settings": [
  { "key": "model_size", "type": "choice", "label": "Speech model",
    "options": ["tiny", "base", "small"], "default": "base",
    "hint": "Bigger is more accurate and slower." }
]
```

There are **ten widget types and no eleventh**:

| Type | Extra fields | For |
|---|---|---|
| `text` | `default`, `placeholder` | a short string |
| `password` | — | a secret. No `default`, ever. Stored in the OS keychain, handed back only to you. |
| `number` | `default`, `min`, `max`, `step` | a number |
| `toggle` | `default` | on or off |
| `choice` | `options` ✅, `default` | one of a fixed list |
| `multi-choice` | `options` ✅, `default` (array) | several of a fixed list |
| `path` | `kind`: `file` \| `dir` | a file or folder on this machine. No `default` — see below. |
| `status` | — | read-only text you drive at runtime |
| `progress` | — | a bar you drive at runtime |
| `action` | `tool` ✅ | a button that calls one of your tools with no arguments |

Every widget takes `key` (lowercase, digits, underscores), `label`, and optional `hint`.

**Why a fixed list and not a schema renderer.** A plugin cannot style itself wrong because
it never styles itself. A general JSON-Schema form renderer re-opens that door, and adds
175 KB to do it. If you genuinely need an eleventh widget, that is a conversation — open an
issue and say what the tenth could not do.

`path` takes no default and `password` takes no default, for the same underlying reason: a
value baked into a manifest is a value that is wrong on someone else's machine, and in the
password case, a secret in a public repo.

Reading and reacting to settings at runtime is `alexia/settings/get` and
`alexia/settings/changed`; rendering is [`ui-schema.md`](./ui-schema.md).

### Storage

```jsonc
"storage": { "namespace": "voice", "tables": ["transcripts"], "dir": true }
```

`namespace` **must equal `id`**. Core creates your tables as `p_<namespace>_<table>`; you
never see the prefix. `dir: true` gets you a directory of your own, reachable as
`paths.ownDir` from `alexia/host/info`.

All of it goes when the user deletes you. Tables, settings, secrets, directory — and a CI
check diffs the filesystem and the database before and after to prove there is nothing left.
See [`storage.md`](./storage.md).

### Commands and skills

```jsonc
"commands": [ { "name": "mute", "summary": "Stop listening" } ],
"skills": ["skills/dictating-well"]
```

A command is a slash command. **Core calls your tool of the same name, with no arguments**
— the command declares no binding because there is only one it could have. Declare **one** name; core derives the namespaced
`/voice.mute` automatically and it always works. If another plugin already owns the bare
word, yours shows in amber with a one-click switch to the namespaced form — so resolving a
collision never breaks a command that was already working.

`skills` are folders inside your plugin, in the agentskills.io format. They install and
purge with you. Paths are relative and may not climb out of your folder. See
[`skills.md`](./skills.md).

### `min_tier`

```jsonc
"min_tier": "T0"
```

The cheapest router rung your work is safe on — `T0` local, `T1` free hosted, `T2` small
paid, `T3` frontier. Core will not route a `sampling/createMessage` from you below it.

Default `T0`, and think before raising it: **a plugin that demands T3 does not work for a
user with no paid key**, and working with no paid key is a founding goal, not a nice-to-have.

---

## What gets rejected

The manifest is **strict**: an unknown top-level key is an error, not a shrug. This is the
one place being permissive costs more than it gives — `"provide"` instead of `"provides"`
would otherwise produce a plugin that declares nothing, loads happily, and fails at the
first capability call, a long way from the typo.

`packages/protocol/test/manifest.test.ts` holds the schema to this. Each of these is a
mistake a real author makes:

| Mistake | Caught as |
|---|---|
| `"id": "Voice_Plugin"` | `id` — lowercase, digits and hyphens only |
| `"manifest_version": 2` | `manifest_version` |
| a `requires` entry with no `why` | `requires.0.why` |
| a `choice` whose `default` is not one of its `options` | `settings.0.default` |
| `storage.namespace` that no longer matches `id` after a rename | `storage.namespace` |
| `"type": "slider"` | not one of the ten widgets |
| `"provide"` instead of `"provides"` | unrecognised key `provide` |
| `"run": "C:\\Program Files\\node.exe"` | `entry.run` — relative or on PATH |
| `"version": "v0.1"` | `version` — semantic versions only |
| `"skills": ["../../etc/passwd"]` | `skills.0` — stay inside your folder |

Cross-field rules — the last one in each pair above — cannot be expressed in JSON Schema.
They live in the zod schema and run when core loads your plugin. **Your editor will not
catch them; `pnpm check` and core will.**

---

## Validating one

```bash
# in the Alexia repo
pnpm --filter @alexia/protocol gen:schema   # regenerate plugin.schema.json from zod
pnpm test                                    # includes the manifest suite
```

From M3 there is a conformance suite and a `create-plugin` scaffold that starts you from a
manifest that already passes. Until then, copy [`plugin.example.json`](./plugin.example.json)
and delete what you do not need.

---

## This will change

The plugin contract is **unstable until M4** and breaking it is what M4 is for. When it
breaks, `alexia_protocol` goes to `2` and a plugin declaring `1` gets the refusal message
above rather than a crash. That mechanism is the entire reason third-party plugins can be
accepted this early.
