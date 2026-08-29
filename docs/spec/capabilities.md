# Capabilities

> **What a capability is.** A dotted name that stands for *a thing that can be done*, with
> no plugin attached to it. `voice.speak` is a capability. The `voice` plugin is not.
>
> That distinction is the invariant in one sentence. If a plugin could ask for `voice`, it
> would depend on `voice`, and deleting the folder would break something else. It can only
> ask for `voice.speak`, and if nothing provides that, the answer is a clean
> `-32050 CAPABILITY_NOT_AVAILABLE` and everything else keeps running.
>
> Companions: [`manifest.md`](./manifest.md) · [`wire-protocol.md`](./wire-protocol.md)

---

## Two kinds, one syntax

Both live in `requires[]`. They are resolved completely differently, and confusing them is
the main way to get this wrong.

| | **Permission** | **Service** |
|---|---|---|
| Means | "I need this from Alexia" | "I need some other plugin to do this" |
| Defined by | core — a fixed list, in this file | whichever plugin declares it in `provides[]` |
| Appears in `provides[]` | never | always |
| Resolved by | asking the user, once, at install | `alexia/capability/call` at runtime |
| If unavailable | the plugin does not install | `-32050`, and the caller re-plans |

```jsonc
"requires": [
  { "cap": "audio.input", "why": "to hear you speak" },     // permission
  { "cap": "voice.speak", "why": "to read replies aloud" }  // service
],
"provides": ["voice.transcribe", "voice.speak"]             // services only
```

Names are lowercase, dot-separated, `[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+`. The convention is
LSP's and MCP's, and it is chosen so a name reads as *area* then *thing*.

---

## The permission registry

This is the complete list. **Core defines every one of these**, and a plugin requiring a
name that is not here does not install.

| Name | What it grants | What the user is told |
|---|---|---|
| `fs.own_dir` | a private directory, purged with the plugin | "store files of its own" |
| `fs.read_scoped` | read inside the folders the user has put in scope (MCP `roots`) | "read the folders you've opened" |
| `fs.write_scoped` | write inside those same folders | "change files in the folders you've opened" |
| `net.download` | fetch from the hosts named in `why` | "download from *…*" |
| `net.request` | general outbound HTTP | "use the internet" |
| `audio.input` | the microphone | "hear you speak" |
| `audio.output` | the speakers | "play sound" |
| `screen.capture` | read the screen | "see your screen" |
| `input.control` | move the pointer and press keys | "control your mouse and keyboard" |
| `proc.spawn` | run a child process it ships | "run the programs it came with" |
| `notify` | a desktop notification | "notify you" |

`net.download` and `net.request` are separate on purpose. Almost every plugin that touches
the network is fetching one model file, once, from one host — and *"download the speech
model from huggingface.co"* is a sentence a person can agree to. *"Use the internet"* is
not. **If a download is what you do, say `net.download` and name the host in `why`.**

There is no `fs.read_all`, and there will not be one. Filesystem reach outside the user's
chosen roots is not a capability a plugin may ask for.

### Declared, not enforced — say it out loud

Alexia does not sandbox plugins. A plugin that declares `audio.input` and reads your
documents is not stopped by the runtime; it is caught because the manifest is public, the
source is public, and the registry has a revoke button.

That is a real limitation and it is stated here rather than implied. OS-level enforcement
stays possible later for the filesystem and the shell — the two places it is actually
achievable — and nowhere else.

---

## The service registry

Services are declared by whichever plugin provides them. This table is the list of names
that are **taken**, so a second plugin offering the same thing offers it under the same
name and becomes a drop-in alternative rather than a competitor.

| Name | Contract | First provided by |
|---|---|---|
| `demo.greet` | a name in, a greeting out | `plugins/hello` (M0) |
| `voice.transcribe` | audio file in, text out | `plugins/voice` (M2) |
| `voice.speak` | text in, audio played, nothing out | `plugins/voice` (M2) |
| `persona.personality` | nothing in, the chosen personality's standing instruction out — core appends it to the system prompt once per task | `plugins/persona` (M4) |
| `memory.capture` | one finished exchange in, **nothing out** — core never reads it back | `plugins/memory` (M7) |
| `ask.confirm` | a question and its options in, the chosen option out | `plugins/telegram` (M7) |
| `voice.render` | text in, **audio bytes out** — for audio that has to go somewhere other than these speakers | `plugins/voice` (M7) |

Seven entries, because seven exist. `demo.greet` is real: `plugins/hello` provides it and
`plugins/vanisher` requires it, which is how *delete the provider and the consumer keeps
running* stays a test rather than a claim. The last two are the ones **core itself** reaches
for — they are also in `CORE_CAPABILITIES`, and the rule for being there is that core works
completely when nothing provides them. **This table grows by pull request, never by a string
somebody typed.** A name invented locally is a name the next plugin will spell differently,
and then there are two capabilities that mean the same thing and no drop-in alternative for
either.

---

## Adding a name

1. **Check it is not a tool.** If only your own plugin will ever call it, it is a tool, and
   tools need no registry — they come from `tools/list`. A capability is for something
   *another plugin* calls, or something core grants.
2. **Open a pull request against this file** with the name, one line of contract, and the
   plugin that will provide or require it.
3. **A permission needs more than that.** Adding one widens what any plugin can ask for, so
   it needs the sentence the user will read, and a reason the existing names do not cover it.
4. Names are permanent once a released plugin uses one. Renaming is a contract break and
   waits for M4.

---

## How a capability reaches a tool

The manifest's `provides` is the **declaration** — what the library shows, what the registry
indexes, and what another plugin's `requires` resolves against before either is running.

The **binding** is on the tool, in MCP's own `_meta`:

```jsonc
{ "name": "transcribe",
  "description": "…",
  "_meta": { "alexia/provides": ["voice.transcribe"] } }
```

Two places, on purpose, and it is the same reason tools are not in the manifest: a plugin
whose model has not finished downloading *cannot* answer `voice.transcribe` yet and should
not claim it can. Declaring it in the manifest is a promise about the plugin; declaring it
on the tool is a statement about right now. If a plugin declares a capability in its
manifest and no running tool binds it, the call gets `-32050` — the same answer as if the
plugin were not installed, which is exactly what the caller needs to hear.

## What a caller learns

Nothing about who answered.

```jsonc
// → { "method": "alexia/capability/call",
//     "params": { "cap": "voice.speak", "arguments": { "text": "Done." } } }
// ← { "result": { "content": [...], "isError": false } }
```

There is no `provider` field in that result and no method to ask for one. If two plugins
provide `voice.speak`, core picks one — the user's preference if they set one, otherwise the
first enabled — and the caller cannot tell which, cannot pin one, and cannot detect the
switch.

This is deliberate to the point of being awkward, and it is what makes *delete the folder,
nothing else notices* true rather than aspirational.
