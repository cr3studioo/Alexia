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
| `proc.spawn` | run a child process — one it ships, or one on this machine it names in `why` | "run the programs it came with", or "start *…*" |
| `notify` | a desktop notification | "notify you" |

`net.download` and `net.request` are separate on purpose. Almost every plugin that touches
the network is fetching one model file, once, from one host — and *"download the speech
model from huggingface.co"* is a sentence a person can agree to. *"Use the internet"* is
not. **If a download is what you do, say `net.download` and name the host in `why`.**

**`proc.spawn` is not only what a plugin brought with it.** It was written as *a child
process it ships*, because every plugin that had one had downloaded it — and the first
plugin that needed to start a program **already on the machine** did not fit the sentence.
Widened rather than joined by a twelfth name: *spawn a process I shipped* and *spawn a
process that is already here* are the same power, told apart only by where the file came
from, and a permission that splits on that teaches nobody anything. What keeps it honest is
the `why`, which is the line the user actually reads — *"to start ComfyUI for you, if it is
installed on this machine and not already running"* is a sentence somebody can agree to, and
*"run a program"* is not. **Naming the program is the bar**, the same way naming the host is
the bar for `net.download`.

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
| `persona.personality` | nothing in, the chosen personality's standing instruction out — core appends it to the system prompt once per task. **Optionally in three lengths**: `structuredContent` may carry `{ high, medium?, small? }`, and core sends each model the one it can read, chosen as that model is asked. `text` is still the long one and still the whole contract | `plugins/persona` (M4) |
| `persona.in_use` | nothing in, the name of the personality in use out — one short line, for the chip in the chat header |     `plugins/persona` (M8-7) |
| `persona.not_her` | one answer and an optional line on what she should have said in, **nothing out** — core hands it over and forgets it | `plugins/persona` (M8-7) |
| `memory.remember` | a sentence in, **nothing out** — it is kept across conversations and read back by `memory.recall` | `plugins/memory` (M7) |
| `memory.recall` | words in, what was remembered about them out | `plugins/memory` (M7) |
| `memory.capture` | one finished exchange in, **nothing out** — core never reads it back, and `memory.profile` is the one exception | `plugins/memory` (M7) |
| `memory.profile` | nothing in, **a short block about the user out** (~600 characters: name, language, how to be spoken to, life stage) — assembled by code, read once per task and put in the system prompt before the personality. Empty text is nothing to say | `plugins/memory` |
| `ask.confirm` | a question and its options in, the chosen option out | `plugins/telegram` (M7) |
| `voice.render` | text in, **audio bytes out** — for audio that has to go somewhere other than these speakers | `plugins/voice` (M7) |
| `document.extract` | **a file in, markdown out** — what a document says | `plugins/documents` |
| `image.ocr` | **a picture in, the words in it out** — a path or the bytes, text in reading order | `plugins/ocr` |
| `commitments.due` | nothing in (or `today`, the caller's own date as `YYYY-MM-DD`), **what is due out** — the open commitments due today or already late, one per line, oldest first, and empty when there are none. `structuredContent` carries the same as `{ items: [{ id, text, by, overdue, mine }] }` | `plugins/commitments` |
| `channel.chat` | **a mark, not a call** — nothing in, nothing out, and no tool binds it. A plugin lists it in `provides` to say *somebody can talk to Alexia through me from somewhere else*. Core counts the enabled ones whose declared `password` settings are all stored and sends the number as `channels` on `/api/state`; the board asks before the Chat page is removed only when it is 0 | `plugins/telegram` (D204) |

**A plugin can ask whether any of them is going to be answered**, without learning who would:
`alexia/answers` takes a capability name and returns two booleans — *something enabled promises
it* and *something that promises it is installed and switched off*
([`wire-protocol.md`](./wire-protocol.md#alexiaanswers), `alexia_protocol` 10). It is the
reading half of `alexia/capability/call` and keeps the same invariant.

Fifteen entries, because fifteen exist — `memory.remember` and `memory.recall` were shipped by
`plugins/memory` from the day it existed and were missing from this table until 2026-09-19,
which is the failure mode the paragraph below warns about read from the other end: a name in a
manifest that the register never learned about. `demo.greet` is real: `plugins/hello` provides it and
`plugins/vanisher` requires it, which is how *delete the provider and the consumer keeps
running* stays a test rather than a claim. Seven of them are ones **core itself** reaches
for — they are also in `CORE_CAPABILITIES`, and the rule for being there is that core works
completely when nothing provides them. One of the seven, `channel.chat`, is never called at all:
it is a marker core counts (D204), so the board can tell whether anybody has another way in. **This table grows by pull request, never by a string
somebody typed.** A name invented locally is a name the next plugin will spell differently,
and then there are two capabilities that mean the same thing and no drop-in alternative for
either.

`channel.chat` is the one row that is **never called**. It marks a plugin as a way in — a
phone, a chat app — so that the board can tell *removing Chat leaves her unreachable* from
*removing Chat leaves the phone*, without core learning which plugin that is. *Connected* is
read without waking anything: enabled, and every `password` it declared is in the keychain. A
channel with no token reaches nobody and is not counted; one with a token and nobody paired
is, because telling those two apart needs the plugin's own process. Erring either way costs
one question at most. Conformance reports it as *declared but not bound*, and that is correct
for this row — there is nothing to bind. It is in `CORE_CAPABILITIES` as `channel`, and
nothing providing it means the board asks every time, as it did before the name existed.

`document.extract` is the newest and it is the clearest example of why the column on the
right says *first* provided by. What ships in the box is a text-layer reader: no Python, no
model, no network, and an honest refusal for a scan, a photograph or a screenshot. A stronger
extractor — one that recognises the words in a picture of a page — is a **second plugin
offering this same name**, and core cannot tell the difference, because core resolves it by
capability and never by plugin id. That is the whole mechanism, and it is why the answer to
*not every model can read a document* is the answer already given to *not every model can
hear*.

**It is deliberately not two names yet.** *Read the words off a scan* and *describe a
screenshot* are different jobs with different answers, and a single capability that quietly
accepted both would return an empty string for the second and let a model answer confidently
about a picture nobody read. So the extractor **refuses a picture by kind** and says which of
the two would read it. A `document.describe` belongs in this table on the day something can
provide it; a name with no provider is a promise, and this table is a record.

`image.ocr` is the first half of that arriving, and it is **`image.` rather than `document.`
on purpose**: the same call reads a scanned page, a photographed receipt and a rectangle of
somebody's screen, and only one of those is a document. It is also the first row here that
`plugins/documents` **requires** rather than provides — a plugin asking another plugin for
something, with core resolving the name and neither of them learning who the other is. The
property that matters is what happens when it is not there: `document.extract` catches the
`-32050` and answers with the refusal it already had, *word for word*, so a machine with no
OCR installed behaves exactly as it did before this row existed. There is a test that
compares the two.

The other half is still missing and still deliberately unnamed. `image.ocr` returns the words
in a picture; it cannot say what a photograph is *of*, and handed a chart it returns the axis
labels rather than the point. That is `document.describe`, it needs a model that can see, and
core's `sample` still maps every non-text block to the literal string `[image]`.

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
