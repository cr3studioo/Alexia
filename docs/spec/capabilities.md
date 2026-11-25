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
| `net.listen` | an inbound listener, with interface and purpose declared in `why` | "receive data through a local network listener" |
| `audio.input` | the microphone | "hear you speak" |
| `audio.output` | the speakers | "play sound" |
| `screen.capture` | read the screen | "see your screen" |
| `input.control` | move the pointer and press keys | "control your mouse and keyboard" |
| `proc.spawn` | run a child process — one it ships, or one on this machine it names in `why` | "run the programs it came with", or "start *…*" |
| `notify` | a desktop notification | "notify you" |
| `attachments.scoped` | lease, register and share the pictures of one conversation at a time (`alexia_protocol` 14) | "edit the pictures you attach" |

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
| `context.current` | Nothing in; bounded timestamped factual context out. Core reads once per task, caps at 1,500 characters and waits at most two seconds. Failure or absence adds nothing. | `plugins/apple-context` |
| `demo.greet` | a name in, a greeting out | `plugins/hello` (M0) |
| `voice.transcribe` | audio file in, text out | `plugins/voice` (M2) |
| `voice.speak` | text in, audio played, nothing out | `plugins/voice` (M2) |
| `persona.personality` | nothing in, the chosen personality's standing instruction out — core appends it to the system prompt once per task. **Optionally in three lengths**: `structuredContent` may carry `{ high, medium?, small? }`, and core sends each model the one it can read, chosen as that model is asked. `text` is still the long one and still the whole contract | `plugins/persona` (M4) |
| `persona.in_use` | nothing in, the name of the personality in use out — one short line, for the chip in the chat header |     `plugins/persona` (M8-7) |
| `persona.not_her` | one answer and an optional line on what she should have said in, **nothing out** — core hands it over and forgets it | `plugins/persona` (M8-7) |
| `memory.remember` | a sentence in, **nothing out** — it is kept across conversations and read back by `memory.recall` | `plugins/memory` (M7) |
| `memory.recall` | words in, what was remembered about them out | `plugins/memory` (M7) |
| `memory.capture` | one finished exchange in, **nothing out** — core never reads it back, and `memory.profile` is the one exception | `plugins/memory` (M7) |
| `reply.finished` | one finished exchange in (`said`, `answered`, `at`), **nothing out** — core hands every answer over and forgets it, and whatever provides it decides whether to present it another way (out loud, in the Voice plugin's case). Not sent for a conversation holding private pictures | `plugins/voice` |
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


### Proactive and daily capabilities (v3, P3)

Added for v3's phase P3 (`v3/specs/P3/PHASE.md`); the exact argument and result shapes are in
`v3/specs/INTERFACES.md` §3.6. Arguments are snake_case; result fields are camelCase. The first
provider of each is a P3 task, not yet a shipped plugin, which is why the right-hand column
names the task.

| Name | Contract | First provided by |
|---|---|---|
| `notice.items` | `now`, `horizon_days`, `tz_offset_min` in; **what might be worth telling the owner unprompted out**, as `{ items: [{ key, text, why, urgency?, dueAt?, notBefore? }] }`. Read-only. Keys start with the provider's own prefix (`commitments:12`) | P3-25 (`plugins/commitments`), and most P3 plugins |
| `notice.done` | a `key` in, `{ closed }` out — the owner said the thing is done; the provider whose key it is closes it, every other one answers `closed: false` | P3-25, P3-26, P3-29, P3-30 |
| `brief.section` | `kind` (`morning`, `evening`, `weekly`), `now`, `tz_offset_min` in; `{ title, text }` out — one section of a brief, assembled by code. Read-only; empty text is nothing to say | P3-22 (`plugins/day-planner`), and several others |
| `calendar.events` | a time range in, the events in it out. Read-only | P3-20 (`plugins/google-account`), P3-21 (`plugins/microsoft-account`) |
| `calendar.create` | an event in, its id out. **`openWorldHint: true`**: a proactive run always asks | P3-20, P3-21 |
| `mail.list` | `since?`, `query?`, `limit` in, message headers and snippets out. Read-only; never marks anything read | P3-20, P3-21 |
| `mail.read` | a message id in, its text out. Read-only | P3-20, P3-21 |
| `mail.send` | a message in, its id out. **`openWorldHint: true`**, and refused without the one-time `approved_draft` token that only the owner's yes produces | P3-20, P3-21 (token: P3-24) |
| `contacts.find` | words in, matching contacts (name, emails, phones, birthday) out. Read-only | P3-20, P3-21 |
| `tasks.add` | `text`, `due?` (`YYYY-MM-DD`), `list?` in, the new item's id out — where quick captures land | P3-26 (`plugins/task-list`) |
| `page.text` | a URL in, the page's main text out (at most 20,000 characters). Read-only; what a scheduler watch on a page polls | P3-27 (`plugins/page-watch`) |

**`notice.items`, `notice.done` and `brief.section` are fanned out, not resolved.** Every other
row here resolves to one provider, as the rest of this table does. These three are asked of
*every* enabled provider at once (`McpHost::call_capability_all`), because each plugin knows
its own part of the owner's day and none of them is an alternative to another. The results
never say which plugin answered; the key prefix is the only thing that keeps two providers'
items apart, and only the provider that owns a key closes it.

### P4: devices and the PC

Added for v3's phase P4 (`v3/specs/P4/PHASE.md`). The first provider of each is a P4 plugin task
(P4-16..P4-29), named on the right; the hub calls some of them itself (P4-37, P4-38). **These names
are final**: plugin manifests copy them into `provides`, and the hub calls them by name. Field
names in arguments and results are exactly as written here — unlike the P3 section above, some results are
snake_case (`idle_ms`, `plan_id`), because the tasks that build them were specified that way.

| Name | Contract | First provided by |
|---|---|---|
| `clipboard.get` | nothing in; what is on this device's clipboard out. Read-only | P4-16 (`plugins/device-clipboard`) |
| `clipboard.set` | text in, nothing out — puts it on the clipboard | P4-16 |
| `clipboard.history` | `limit?`, `query?` in; the clipboard's recent text out. Read-only | P4-16 |
| `file.stat` | a path in, its size, SHA-256 and name out. Read-only | P4-17 (`plugins/file-courier`) |
| `file.read_chunk` | a path and a byte range in, those bytes out. Read-only | P4-17 |
| `file.write_chunk` | a piece of a file in, where it was written out. Never overwrites | P4-17 |
| `notify.show` | a notice in, shown on this device; the owner's button or reply out when one was asked for | P4-18 (`plugins/device-notify`) |
| `window.list` | nothing in; windows and monitors out. Read-only | P4-19 (`plugins/window-deck`) |
| `window.arrange` | a window and what to do with it in | P4-19 |
| `window.layout.save` | a name in; the current arrangement is kept under it | P4-19 |
| `window.layout.apply` | a name in; the kept arrangement is put back | P4-19 |
| `app.quit` | an app in; it quits. **Destructive** | P4-19 |
| `file.search` | words in, matching files out. Read-only | P4-20 (`plugins/file-finder`) |
| `folder.tidy` | a folder in, a plan of moves out; given back the plan, carries it out. **Destructive** when applying | P4-20 |
| `document.edit` | a document and edits in; an edited copy out (or the same file, when asked). **Destructive** in place | P4-21 (`plugins/documents`) |
| `system.get` | a setting in (`volume`, `mute`, `brightness`, `dark_mode`, `focus`), its value out. Read-only | P4-22 (`plugins/pc-care`) |
| `system.set` | a setting and a value in | P4-22 |
| `system.care` | a check in (`disk`, `startup`, `updates`, `temp`), a report out; with `apply`, the fix. **Destructive** when applying | P4-22 |
| `power.do` | `lock`, `sleep`, `restart` or `shutdown` in. **Destructive** | P4-22 |
| `shell.run` | a command in; exit code and output out. **Destructive, `openWorldHint: true`** | P4-23 (`plugins/shell-runner`) |
| `software.install` | a program's name in; installed from a package manager. **Destructive, `openWorldHint: true`** | P4-23 |
| `job.watch` | a process, command or file in; a watch out. The finish arrives later as a `notice.items` item | P4-23 |
| `browser.tabs` | nothing in; the owner's browser tabs out. Read-only | P4-24 (`plugins/browser-pilot`) |
| `browser.read` | a tab in; its text and controls out. Read-only | P4-24 |
| `browser.open` | a URL in; opened in the owner's browser. **`openWorldHint: true`** | P4-24 |
| `browser.click` | a control on a page in; clicked. **`openWorldHint: true`** | P4-24 |
| `browser.fill` | a field and a value in; filled. **`openWorldHint: true`** | P4-24 |
| `screen.draw` | shapes in; drawn over the screen for a while | P4-26 (`plugins/screen-ink`) |
| `screen.clear` | nothing in; everything drawn is removed | P4-26 |
| `cursor.show` | a point in; her own cursor glides there | P4-26 |
| `screen.look` | a question in, what is on the screen out. Read-only | P4-27 (`plugins/screen-look`) |
| `screen.help` | a question in, how to do it on this screen out. Read-only | P4-27 |
| `screen.text` | a region in, the text in it out. Read-only | P4-27 |
| `device.presence` | nothing in; how long since the owner touched this device, and whether it is locked, out. Read-only | P4-09 (`alexia-limb` itself, not a plugin) |

**Every one of these is a device capability, and the hub may see it more than once.** The hub
hosts its own plugins and every paired device's plugins (D-P4-4), so the same name can be offered
by the PC, the Mac and anything else paired. Every call to a capability in this section may carry
one extra argument, **`device`**: a device id as `alexia-hub devices` prints it. The hub strips
it before the call reaches the plugin, so no provider ever sees it, and it picks a device for
itself when it is absent, by D-P4-9: the `device` argument wins; else, for the interactive
prefixes (`screen.*`, `cursor.*`, `clipboard.*`, `notify.*`, `browser.*`, `window.*`, and
`computer.*`), the device where the owner is; else the hub's own plugin; else any online device.
The model sees one tool per `<plugin>.<tool>` with an optional `device` enum, never one tool per
device. `device` names a **computer**, never a plugin: *a caller learns nothing about who
answered* (below) still holds, and a named device that is offline or does not offer the
capability is `-32050` like any other absence.

**Open world is exact.** `openWorldHint: true` is what P3-06's silent rule (a proactive run never
calls it without asking) and P4-30's local-only rule (D-P4-11 blocks it) key on. In this section
it is set on what reaches a third party or the internet: a shell command or an installer can
fetch anything, and anything done in the owner's browser can send what it does to a website.
Everything else here stays on the owner's own devices, the mesh included, and is not open world.
`readOnlyHint` and `destructiveHint` are per tool, not per call, so a capability that is harmless
by default and destructive with a flag (`folder.tidy`, `system.care`, `document.edit`) declares the
destructive annotation and says in its description what the default does.

**When nothing provides one**, the call gets `-32050` as always, and a plugin that requires it
says the sentence in the last line of each entry below, word for word, instead of failing.
`alexia/answers` lets it check first.

#### The shapes

Each entry: arguments (a JSON Schema in prose: `?` is optional), the result (`CallToolResult`:
one short `text` for a model to read, and `structuredContent` for code), the annotations, and
what is said when nothing provides it. A failure is `isError: true` with one sentence in `text`.

**`clipboard.get`** — device-clipboard.
- In: `{}`.
- Out: `structuredContent: { text?: string, kind: "text" | "image" | "files", at: number, sensitive: boolean }`.
  `at` is when it was copied, in Unix milliseconds. `text` is absent for an image or files.
  `sensitive` is true when the OS or the copying app marked it so (a password manager's copy;
  Windows `ExcludeClipboardContentFromMonitorProcessing`, macOS `org.nspasteboard.ConcealedType`);
  then `text` is absent too. `text` (the content block): the clipboard's text, or a line saying
  what kind it is.
- Annotations: `readOnlyHint: true`, `openWorldHint: false`.
- Absent: "I can't see the clipboard on that computer."

**`clipboard.set`** — device-clipboard.
- In: `{ text: string }`.
- Out: `structuredContent: {}`; text "Copied."
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false`.
- Absent: "I can't put things on the clipboard on that computer."

**`clipboard.history`** — device-clipboard.
- In: `{ limit?: integer 1..50 (default 20), query?: string }`. `query` matches text, case-insensitive.
- Out: `structuredContent: { items: [{ id: string, text: string, at: number }] }`, newest first.
  Never holds anything that was `sensitive`. Empty when the owner turned history off.
- Annotations: `readOnlyHint: true`, `openWorldHint: false`.
- Absent: "I don't keep a clipboard history on that computer."

**`file.stat`** — file-courier.
- In: `{ path: string }`, inside the owner's roots (`fs.read_scoped`).
- Out: `structuredContent: { size: integer, sha256: string (hex), name: string }`.
- Annotations: `readOnlyHint: true`, `openWorldHint: false`.
- Absent: "I can't reach files on that computer."

**`file.read_chunk`** — file-courier.
- In: `{ path: string, offset: integer >= 0, length: integer 1..1048576 }`.
- Out: `structuredContent: { data: string (base64), eof: boolean }`. `eof` is true when this chunk
  reaches the end of the file.
- Annotations: `readOnlyHint: true`, `openWorldHint: false`.
- Absent: "I can't reach files on that computer."

**`file.write_chunk`** — file-courier.
- In: `{ name: string, folder?: string, offset: integer >= 0, data: string (base64), last: boolean, sha256?: string }`.
  Writes into the device's Downloads folder unless `folder` is inside the owner's roots
  (`fs.write_scoped`). Pieces go to `<name>.part`; on `last` the hash is checked when given and
  the file is renamed.
- Out: `structuredContent: { path: string }`, the file's final path. **It never overwrites**: an
  existing name becomes `<stem> (2).<ext>`, `(3)`, … A hash mismatch deletes the part and is
  `isError` "The file arrived damaged; nothing was kept."
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false`.
- Absent: "I can't send files to that computer."

**`notify.show`** — device-notify.
- In: `{ title: string, text: string, urgency: "low" | "normal" | "high" | "urgent", buttons?: [{ label: string, data: string }] (at most 3), reply?: boolean, id?: string }`.
  `id` replaces an earlier notice with the same id instead of stacking another.
- Out: `structuredContent: { shown: boolean, answer?: { data?: string, text?: string } | null }`.
  With `buttons` or `reply` the tool waits up to 60 s and returns the button's `data` or the typed
  `text`; `answer: null` when nobody answered in time. An answer given after that, or typed on the
  device unprompted, reaches the hub as a face message (`POST /alexia/face/1`, D-P4-5) — never as
  a `notice.items` item.
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false` (it shows
  something on the owner's own screen; nothing leaves the device).
- Absent: "I can't show notifications on that computer." (The hub then says it where the owner
  last talked to her, as before P4.)

**`window.list`** — window-deck.
- In: `{}`.
- Out: `structuredContent: { windows: [{ id, app, title, x, y, w, h, minimized: boolean, monitor }], monitors: [{ id, x, y, w, h, primary: boolean }] }`;
  coordinates in screen pixels.
- Annotations: `readOnlyHint: true`, `openWorldHint: false`.
- Absent: "I can't see the windows on that computer."

**`window.arrange`** — window-deck.
- In: `{ id, do: "move" | "resize" | "snap_left" | "snap_right" | "maximize" | "minimize" | "restore" | "close", x?, y?, w?, h?, monitor? }`.
  `close` asks the window to close, so the app can still ask to save.
- Out: `structuredContent: {}`; text says what was done.
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false`.
- Absent: "I can't arrange windows on that computer."

**`window.layout.save`** — window-deck.
- In: `{ name: string }`.
- Out: `structuredContent: { saved: string, windows: integer }` — the name and how many windows it holds.
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false`.
- Absent: "I can't remember window layouts on that computer."

**`window.layout.apply`** — window-deck.
- In: `{ name: string, open_missing?: boolean (default false) }`.
- Out: `structuredContent: { placed: integer, missing: [string] }` — `missing` lists apps that were
  not running (opened only when `open_missing`).
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false`.
- Absent: "I can't arrange windows on that computer."

**`app.quit`** — window-deck.
- In: `{ app: string, force?: boolean (default false) }`. `force` only when the owner said so.
- Out: `structuredContent: {}`; text says whether it quit or is asking to save.
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `openWorldHint: false`.
- Absent: "I can't quit apps on that computer."

**`file.search`** — file-finder.
- In: `{ query: string, kind?: "document" | "image" | "video" | "audio" | "archive" | "folder", folder?: string, modified_after?: string (ISO date), limit?: integer 1..50 (default 20) }`.
- Out: `structuredContent: { items: [{ path, name, modified: number (Unix ms), size: integer }] }`.
  Results outside the owner's roots are dropped.
- Annotations: `readOnlyHint: true`, `openWorldHint: false`.
- Absent: "I can't search files on that computer."

**`folder.tidy`** — file-finder.
- In: `{ folder: string, apply?: string }`. Without `apply` it only proposes. `apply` is a
  `plan_id` this provider returned in the last hour and carries out exactly that plan.
- Out: proposing: `structuredContent: { plan_id: string, moves: [{ from, to, why }] }`; applying:
  `{ moved: integer, skipped: integer }`. Never touches folders, hidden files or anything younger
  than a day.
- Annotations: `readOnlyHint: false`, `destructiveHint: true` (when applying; the description says
  that without `apply` nothing moves), `openWorldHint: false`.
- Absent: "I can't tidy folders on that computer."

**`document.edit`** — documents.
- In: `{ path: string, edits?: [{ find: string, replace: string, all?: boolean }], append?: { text: string }, append_row?: [string], in_place?: boolean (default false) }`
  — exactly one of `edits`, `append`, `append_row`.
- Out: `structuredContent: { path: string, changed: integer }`. By default it writes a copy
  `<stem> (edited).<ext>` (then `(edited 2)`, …) and the original is untouched; `in_place: true`
  rewrites the file itself.
- Annotations: `readOnlyHint: false`, `destructiveHint: true` (because of `in_place`; the default
  copy is not), `openWorldHint: false`.
- Absent: "I can read that document but I can't edit documents on this computer."

**`system.get`** — pc-care.
- In: `{ what: "volume" | "mute" | "brightness" | "dark_mode" | "focus" }`.
- Out: `structuredContent: { what, value: number | boolean }` (`volume`, `brightness` 0..100; the
  rest booleans).
- Annotations: `readOnlyHint: true`, `openWorldHint: false`.
- Absent: "I can't read that computer's settings."

**`system.set`** — pc-care.
- In: `{ what: "volume" | "mute" | "brightness" | "dark_mode" | "focus", value: number | boolean }`.
- Out: `structuredContent: { what, value }`, the value now in force. Where the setting can't be
  changed (brightness on a desktop monitor, focus where it isn't scriptable): `isError` with a sentence.
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false`.
- Absent: "I can't change that computer's settings."

**`system.care`** — pc-care.
- In: `{ check: "disk" | "startup" | "updates" | "temp", apply?: boolean, disable?: string }`.
  Without `apply`/`disable` it only reports. `{check:"temp", apply:true}` deletes temp files older
  than 7 days that are not open; `{check:"startup", disable:<name>}` disables one startup item.
  `updates` only ever reports.
- Out: `structuredContent: { check, report: string, freed_bytes?: integer, items?: [string] }`.
- Annotations: `readOnlyHint: false`, `destructiveHint: true` (when applying), `openWorldHint: false`.
- Absent: "I can't look after that computer."

**`power.do`** — pc-care.
- In: `{ action: "lock" | "sleep" | "restart" | "shutdown", in_s?: integer }`. Restart and
  shutdown are announced 60 s ahead and can be cancelled (`power.cancel`, a tool of the same plugin).
- Out: `structuredContent: { action, at: number (Unix ms) }`.
- Annotations: `readOnlyHint: false`, `destructiveHint: true` (`lock` alone would not be; one tool,
  one annotation), `openWorldHint: false`.
- Absent: "I can't lock, sleep or restart that computer."

**`shell.run`** — shell-runner.
- In: `{ command: string, shell?: "powershell" | "zsh" | "bash", cwd?: string (inside the roots), timeout_s?: integer 1..600 }`.
- Out: `structuredContent: { exit: integer, stdout: string, stderr: string, truncated: boolean }`.
  Each stream is at most 64 KiB, cut with a note saying so. The child gets a minimal environment
  and its process tree is killed on timeout or cancel.
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, **`openWorldHint: true`** (a command
  can reach anything).
- Absent: "I can't run commands on that computer."

**`software.install`** — shell-runner.
- In: `{ name: string, source?: "winget" | "brew" }` (default: the device's own).
- Out: `structuredContent: { installed: string, version: string }`; text names the publisher.
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, **`openWorldHint: true`**.
- Absent: "I can't install programs on that computer."

**`job.watch`** — shell-runner.
- In: exactly one of `{ pid: integer }`, `{ command: string }`, `{ file: string }`, plus
  `says?: string` (how to name it when it finishes). A command watch runs the command itself, under
  `shell.run`'s rules.
- Out: `structuredContent: { watch: string }`. When the job finishes, the same plugin's
  `notice.items` (the P3 section above) carries an item "<says or the job> finished (exit N)", urgency
  `normal`, and it reaches the owner like any notice.
- Annotations: `readOnlyHint: true`, `openWorldHint: false` (watching changes nothing; a command
  watch is described as running the command).
- Absent: "I can't keep an eye on jobs on that computer."

**`browser.tabs`** — browser-pilot.
- In: `{}`.
- Out: `structuredContent: { tabs: [{ tabId: integer, title, url, active: boolean }] }`.
- Annotations: `readOnlyHint: true`, `openWorldHint: false`.
- Absent: "I can't see your browser on that computer."

**`browser.read`** — browser-pilot.
- In: `{ tabId?: integer }` (the active tab by default).
- Out: `structuredContent: { title, url, text (at most 200 KB), controls: [{ ref, role, name }] }`.
  Never cookies, never what a password field already held.
- Annotations: `readOnlyHint: true`, `openWorldHint: false` (it reads a page already open, and
  fetches nothing).
- Absent: "I can't see your browser on that computer."

**`browser.open`** — browser-pilot.
- In: `{ url: string, newTab?: boolean }`.
- Out: `structuredContent: { tabId: integer }`.
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, **`openWorldHint: true`**.
- Absent: "I can't open pages in your browser on that computer."

**`browser.click`** — browser-pilot.
- In: `{ tabId?: integer, ref?: string, text?: string }` — one of `ref` (from `browser.read`) or
  the control's visible `text`.
- Out: `structuredContent: {}`; text says what was clicked.
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, **`openWorldHint: true`**.
- Absent: "I can't work in your browser on that computer."

**`browser.fill`** — browser-pilot.
- In: `{ tabId?: integer, ref?: string, label?: string, value: string }` — one of `ref` or `label`.
- Out: `structuredContent: {}`.
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, **`openWorldHint: true`**.
- Absent: "I can't work in your browser on that computer."

When browser-pilot is installed but its extension is not connected, it is present, and its tools
answer `isError` "Alexia's browser extension isn't connected. Open the extension and paste the code
from Alexia's Browser settings."

**`screen.draw`** — screen-ink.
- In: `{ shapes: [{ kind: "box" | "arrow" | "text" | "dot", x, y, w?, h?, to?: { x, y }, text?, color? }], ttl_ms?: integer <= 60000 (default 8000) }`,
  in screen pixels (the space `computer.screenshot` reports).
- Out: `structuredContent: { drawn: integer }`.
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false`.
- Absent: "I can't draw on that screen." (A caller that only wanted to point carries on without it.)

**`screen.clear`** — screen-ink.
- In: `{}`. Out: `structuredContent: {}`.
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false`.
- Absent: nothing is said; there is nothing to clear.

**`cursor.show`** — screen-ink.
- In: `{ x: number, y: number, label?: string (default "Alexia") }`.
- Out: `structuredContent: {}`. Hidden again after 3 s idle.
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false`.
- Absent: nothing is said; her cursor is a nicety, and `computer` acts without it.

**`screen.look`** — screen-look.
- In: `{ question?: string, whole_screen?: boolean (default false) }`.
- Out: text: a description of the front window (or the whole screen); `structuredContent: { description, text, window: { app, title } }`
  where `text` is what OCR read.
- Annotations: `readOnlyHint: true`, `openWorldHint: false`.
- Absent: "I can't look at that screen."

**`screen.help`** — screen-look.
- In: `{ question: string, draw?: boolean (default false) }`.
- Out: `structuredContent: { answer: string, steps?: [string] }`, naming controls by their visible labels.
- Annotations: `readOnlyHint: true`, `openWorldHint: false` (it samples through the host, which
  applies the owner's own model rules).
- Absent: "I can't look at that screen, so I can't walk you through it."

**`screen.text`** — screen-look.
- In: `{ region?: { x, y, w, h }, whole_screen?: boolean }`.
- Out: `structuredContent: { text: string }` — OCR only, no model.
- Annotations: `readOnlyHint: true`, `openWorldHint: false`.
- Absent: "I can't read text off that screen."

On a locked screen or a private window, screen-look is present and answers "Your screen is locked
or private, so I didn't look." Without `vision.describe` (not yet in this table: nothing provides
it), `screen.look` and `screen.help` fall back to the OCR text and say so.

**`device.presence`** — the limb itself (`alexia-limb`, P4-09), not a plugin: a built-in tool
every limb serves next to its plugins' tools.
- In: `{}`.
- Out: `structuredContent: { idle_ms: integer, locked: boolean }` — milliseconds since the last
  keyboard or mouse input (D-P4-7).
- Annotations: `readOnlyHint: true`, `openWorldHint: false`.
- Absent (a device that is not a limb, or offline): the hub treats it as not present; nothing is said.

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

## How a compute operation reaches a tool

*`alexia_protocol` 13.* A capability listed in the manifest's
[`compute.operations`](./manifest.md#compute) is **work core may run as a job** — on this
computer or on one the person paired with it ([`remote-compute.md`](./remote-compute.md)). It
is declared and bound the same two ways, with a different key:

```jsonc
{ "name": "alexia_compute_image.render",
  "description": "Render an image from a prepared workflow",
  "_meta": { "alexia/compute": { "op": "image.render" } } }

{ "name": "alexia_compute_setup",
  "_meta": { "alexia/compute": { "hook": "setup" } } }
```

`{ "op": "<cap>" }` marks the tool that performs that operation; `{ "hook": "<name>" }` marks
the one that answers a lifecycle hook — `setup`, `install`, `prepare` or `release`. The names
are what `@alexia/sdk` gives them and are reserved, but **the binding is the `_meta`**: core
finds the tool by it and never by its name.

**A tool carrying `alexia/compute` is never offered to a model.** It is work core schedules —
one heavy job at a time, on the computer the person chose — and not a thing to be picked from a
list mid-answer. Core leaves it out of the tool list and calls it by capability.

What each one is handed, and what it answers:

| Binding | `arguments` | `structuredContent` |
|---|---|---|
| `{ "op": cap }` | the operation's own, with every file that was sent replaced by a path the tool can read | `{ "text"?: string, "files": string[] }` — the paths of the files it made |
| `{ "hook": "setup" }` | none | `{ "requirements": [...] }` — what is missing, see below |
| `{ "hook": "install" }` | `{ "requirementId": string }` | — |
| `{ "hook": "prepare" }` | `{ "cap": string }` | — |
| `{ "hook": "release" }` | none | — |

A requirement is `{ id, kind, title, detail?, bytes?, action, instructions?, blocks }`: `kind`
is `runtime`, `model` or `dependency`; `action` is `install` (a button your `install` hook
carries out) or `instructions` (something only a person can do, said in `instructions`);
`bytes` is the download's size where you know it; `blocks` is the capabilities waiting on it.
**Nothing is installed until the person presses that button.**

A failure is a tool failure like any other: `isError: true` with the reason in `content`.
Progress is `notifications/progress` and stopping is `notifications/cancelled`, both MCP's own.

**An operation is asked for with `alexia/compute/run`, not `alexia/capability/call`**
([`wire-protocol.md`](./wire-protocol.md#alexiacomputerun)). The second answers from this
computer and carries no files; the first goes wherever the person chose. Neither says who
answered.

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

`web.research` is an optional service capability for bounded, multi-source public-web
research. A provider returns a concise sourced answer through `alexia/final` and a
Markdown report through ordinary `resource_link` file attachments, with typed research
progress for passive viewers. Core does not require or directly call this capability.
