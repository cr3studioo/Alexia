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

### The three versions

```jsonc
"alexia_protocol": 3,          // ours: which Alexia contract you were written against
"mcp_protocol": "2025-11-25",  // MCP's: which revision your server speaks
"min_app": "0.2.0"             // which builds of Alexia you run on (optional)
```

They do different jobs and all three are checked before you get a process — and, since
plugins are downloads rather than something that ships inside the installer, before the
download too.

`alexia_protocol` is an integer that goes up when the `alexia/*` layer or this file changes.
Core speaks a range — **2 to 3 today** — and one revision back is supported, which is what
makes raising the floor a deprecation rather than a surprise. Outside the range your plugin
does not load and the user is told something they can act on:

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

`min_app` and `max_app` are the **build** range, and they exist because the protocol integer
cannot express one. A capability that arrived in Alexia 0.2.0 is not a new contract revision:
a plugin that needs it declares the same `alexia_protocol` as everything else, handshakes
perfectly on 0.1.9, and does not work. Both are optional and absent means *any*.

```
My Plugin needs Alexia 0.2.0 or later, and this is 0.1.9.
Update Alexia, or install an earlier version of My Plugin.
```

The same check runs in three places, so there is no path that installs something which cannot
load: the shelf does not offer it, the install refuses it, and the loader will not spawn it.
On the Plugins screen the user sees a count — *two plugins and one plugin update need a newer
Alexia* — rather than a list of names they cannot act on.

**A range is a promise.** `min_app` should name the oldest build you actually tested against,
and `max_app` is for a plugin that is *known* broken above some version rather than one nobody
has got round to testing. Narrowing a range that did not need narrowing takes your plugin off
somebody's shelf without telling them what they are missing.

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

There are **fifteen widget types**. Ten, and then five, each argued for one at a time — see
the notes below the table:

| Type | Extra fields | For |
|---|---|---|
| `text` | `default`, `placeholder`, `multiline` | a string. `multiline` (7) gives it a box rather than a line. |
| `password` | — | a secret. No `default`, ever. Stored in the OS keychain, handed back only to you. |
| `number` | `default`, `min`, `max`, `step` | a number |
| `toggle` | `default` | on or off |
| `choice` | `options` ✅, `default` | one of a fixed list — see [Choices](#choices) |
| `multi-choice` | `options` ✅, `default` (array) | several of a fixed list |
| `path` | `kind`: `file` \| `dir` | a file or folder on this machine, typed. No `default` — see below. |
| `file` | `accept` | a file the person **picks**. Core writes the bytes and stores the path — see [Files](#files). *(7)* |
| `status` | — | read-only text you drive at runtime |
| `progress` | — | a bar you drive at runtime |
| `action` | `tool` ✅ | a button that calls one of your tools with no arguments |
| `table` | `rows` ✅, `columns` ✅, `rowActions`, `detail`, `filter`, `groupBy` | a list of things, with actions on each one — see [Tables](#tables) |
| `graph` | `rows` ✅, `detail`, `filter` | things that point at each other, drawn as a map — see [Graphs](#graphs). *(4)* |
| `image` | `rows` ✅, `detail`, `single` | pictures you have made. *(5)* |
| `cards` | `rows` ✅, `rowActions`, `detail`, `filter`, `dim` | things you hold, drawn the way core draws plugins. *(6)* |

Every widget takes `key` (lowercase, digits, underscores), `label`, an optional `hint`, and an
optional `when` — see [Showing what applies](#showing-what-applies). The bracketed number is the
`alexia_protocol` revision that type or field arrived in; declare at least that.

**Why a fixed list and not a schema renderer.** A plugin cannot style itself wrong because
it never styles itself. A general JSON-Schema form renderer re-opens that door, and adds
175 KB to do it. If you genuinely need a twelfth widget, that is a conversation — open an
issue and say what the twelve could not do.

**The eleventh was that conversation, held** (D83, 2026-08-29). `table` was granted because
the previous Alexia's dashboard hand-wrote the same object four times, and the second copy's
own comment admits it *"mirrors SkillsTab's own shape, since the lifecycle is identical by
design"*. Four independent copies of one shape is the strongest case this schema will ever be
handed. Two others were asked for in the same conversation and refused: a `file` picker and a
`graph`, each with exactly one user, which is this schema's own bar for no. The bar is only
worth having if it is applied when it is inconvenient.

**The twelfth was granted two refusals later** (D115, 2026-08-31). `graph` was asked for at
M6-3 and refused on the bar, asked again at M6-7 and refused for a better reason — its one
user stored flat sentences, so the links would have been *inferred*, and a picture of inferred
similarity looks meaningful and is not. Authored links arrived at M7-3, somebody asked to look
at the shape of their own memory, and the argument that carried it was **what the alternatives
cost**: the other two ways to draw a map were a bespoke canvas in core's own shell, which
means core naming one plugin, and a sandboxed iframe, which means a plugin drawing its own
pixels and every rule on this page gone with it. It still has one user. That is written down
rather than argued away.

**The fifteenth was `file`, refused three times before it** (D89, and again at M7-4). Every
refusal turned on one fact rather than on taste: *a browser will not tell a page where a file
is*, so a `file` widget could not fill a `path`, and a plugin that takes paths would have been
handed a control unable to produce one. What changed at revision 7 is that core grew the other
half — the composer's upload seam already took bytes from a browser, wrote them somewhere safe
and handed over a path. **Core creates the path, so nothing has to be told where the file was.**
It is a `path` whose value a person produces by pointing instead of typing, which is what
everybody asking for it meant; see [Files](#files).

`path` takes no default and `password` takes no default, for the same underlying reason: a
value baked into a manifest is a value that is wrong on someone else's machine, and in the
password case, a secret in a public repo.

### Showing what applies

Every widget takes an optional `when`, naming another widget of yours and the value or values
that make this one relevant:

```jsonc
{ "key": "clip", "type": "file", "label": "A recording to clone", "accept": ".wav",
  "when": { "key": "engine", "is": ["qwen", "fish"] } }
```

A widget whose `when` does not match **is not on the page at all**. Not greyed, not disabled —
absent, because a greyed control is a promise that something could be typed into it. Core reads
the stored value before it renders, so a hidden widget never reaches the screen and never has to
be reasoned about by whoever is looking at one.

One key, one set of values, compared as strings. It is deliberately not an expression language:
if you need *and*, that is two settings; if you need arithmetic, that is a tool. `when.key` must
name a widget you declared, in either list — a `when` pointing at nothing is a load error rather
than a widget that silently never draws.

Core works out for itself which widgets other widgets depend on, and redraws the page when one
of those is saved. You do not declare that and cannot get it wrong.

### Choices

An option is a bare string, or an object when the choice is really a **decision**:

```jsonc
{ "key": "engine", "type": "choice", "label": "Voice engine", "default": "local",
  "options": [
    "local",
    { "value": "cloud", "label": "A service",
      "hint": "Fast, no graphics card, and the words leave this machine.",
      "needs": "api_key", "reason": "Add a key at the bottom of this page." }
  ] }
```

Bare strings render exactly as they always did — a segmented control at two or three options, a
dropdown above that. An option carrying a `hint` makes the whole group render as stacked cards
with the sentence under each name, because three model sizes are a word each and four engines
are not. Which of those you get is core's decision, the same way segmented-versus-dropdown
already was.

`needs` names another widget of yours that must hold a value before this option can be picked,
and `reason` is your own sentence saying so. Core dims the option and shows the sentence rather
than hiding it: the person who cannot pick it is the person who needs to know what to do about
that. Leave `reason` out and core writes one naming the widget — which it can, because *this box
is empty* is a fact about the page rather than about what filling it would mean.

`default` must be one of the option **values**, and two options may not share one.

### Files

```jsonc
{ "key": "clip", "type": "file", "label": "A recording to clone", "accept": ".wav,.mp3" }
```

The person picks a file in their own picker. Core writes the bytes inside **your** plugin's
folder and stores the path it made, so the value you read is an absolute path — exactly what a
`path` gives you, and the same code reads both. The bytes purge with your folder.

- `accept` is advisory, in the browser's own syntax. It makes the picker useful; it is not a
  check, because a person can always choose *all files*. Refuse what you cannot read.
- The ceilings are the ones an attachment gets: 25 MB for one file.
- **One widget holds one file.** A second choice replaces the first, and the file keeps its own
  name — so a voice named after its file is still named after its file. Two files that belong
  together are two widgets: that is honest about what your plugin needs rather than relying on a
  folder convention nobody was told.
- Your page cannot write this value itself: `/api/settings` refuses a `file`, because the path
  is core's to create.

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

### Tables

```jsonc
{ "key": "installed", "type": "table", "label": "Installed",
  "rows": "list_things",                       // your tool, called with no arguments
  "columns": [
    { "key": "name", "label": "Name" },
    { "key": "uses", "label": "Uses", "align": "right", "hideNarrow": true }
  ],
  "rowActions": [{ "key": "remove", "label": "Remove", "tool": "remove_thing",
                   "confirm": "Remove {name}?" }],
  "detail": "explain_thing",                   // optional, expands under the row
  "filter": true,                              // a box, applied in the page
  "groupBy": "category" }
```

*Arrived in `alexia_protocol` 3.*

**`rows` is a tool of yours, called with no arguments.** It answers with MCP's own
`structuredContent`, shaped `{ "rows": [ … ] }`, and **every row carries a string `id`** —
that is the only field Alexia uses, because a row action and a detail are both *this row*.
Everything else on a row belongs to the columns you declared. Get any of that wrong and the
panel says so in a sentence naming what was expected; it never quietly shows an empty list.

**This is the one widget that needs your process.** Everything else draws from the manifest
and the store while you are stopped. A table asks for its contents when somebody opens the
panel — once, because a person is looking at it — which is why `rows` should declare
`readOnlyHint`. One that does not gets asked about before it will run, in every mode but Full
trust, which is the permission gate doing its job to a lister that claimed nothing.

**A row action is an `action`.** `tool` is called with `{ id }`, it goes through the same
permission gate any tool call does, and the question appears beside the row. `confirm` is a
second press that has already said what goes, with `{column}` filled in from the row — the
first press costs nothing and the second one is unambiguous.

**`hideNarrow` is not decoration.** Seven columns on a 375px screen put the Delete button
past the edge: usable in the sense that the scroll stayed inside the table, and not usable at
all in the sense that matters. Mark the columns you would drop first.

Row action keys share the one widget namespace, so a `remove` here and a `remove` anywhere
else in your manifest is a load error — a press has to have one meaning.

### Graphs

```jsonc
{ "key": "shape", "type": "graph", "label": "The shape of it",
  "hint": "A ring means Alexia worked that one out rather than being told it.",
  "rows": "list_notes",                        // your tool, called with no arguments
  "detail": "about_note",                      // optional, opens beside the map
  "filter": true }                             // a box, applied in the page over the labels
```

*Arrived in `alexia_protocol` 4. Declaring one while claiming 3 is a load error.*

**A `table` says what is there; a `graph` says what points at what.** Same `rows` tool, same
`structuredContent: { "rows": [ … ] }`, same string `id` on every row — so a plugin that
already has a table has most of a map. What a graph reads on top of the `id`:

| Field | |
|---|---|
| `label` | what the node is called. Falls back to the `id`. |
| `links` | an array of the **ids** this node points at. A link to an id that is not in the answer is dropped rather than drawn to nowhere. |
| `mark` | optional boolean. Draws a ring around the node; your `hint` is where you say what the ring means. |

**No columns, no grouping, no row actions**, and that is deliberate rather than unfinished. A
table's columns are choices a reader notices; a map's are not, so the fields above are fixed
by the contract and there is nothing here to get wrong. Anything a person needs to *do* to one
of these things belongs on a table beside it, where the row is unambiguous and has a button.

**Links must be authored, not guessed.** This widget was refused once for exactly that reason:
a graph of inferred similarity looks meaningful and is not, and nobody looking at it can tell.
If your edges come out of a model's judgement rather than out of something somebody wrote, a
table grouped by category is the honest picture.

Core owns the drawing — the physics, the colours, the labels, the pointer, and settling it
without motion for a reader who asked for that. See [`ui-schema.md`](./ui-schema.md#graph).

### Panel

```jsonc
"panel": {
  "label": "Voice",
  "widgets": [
    { "key": "which_voice", "type": "choice", "label": "Who speaks", "options": ["Ada", "Rowan"] }
  ]
}
```

*Arrived in `alexia_protocol` 3. Declaring it while claiming 2 is a load error.*

**The second half of your plugin's own page** — the one a person reaches through Settings →
Plugins → your plugin. It is drawn below your `settings`, under a rule, with `label` above it
where that says something the page has not already: most plugins name the panel after
themselves, and *Voice* under *Voice* is not a section break. It is there because your plugin
is installed and enabled and for no other reason, and it goes when your folder does. Core
never writes your panel's name down anywhere; that page is assembled from manifests.

The widgets are the widgets above, unchanged. Settings and a panel are two halves of one
declaration, and what separates them is what they are *for*: settings are values somebody
changes, a panel is a record somebody reads, plus the one or two things they change while
reading it. **They are on one page, so write your hints that way.** A hint may say *the box
above*; it may not send anybody to another screen, because there is no longer another screen
to send them to.

*Until D118 a panel was a tab on the control surface instead, which put a plugin's settings on
one screen and the thing they drove on another — so the voice plugin had to tell people which
of the two held the other half. If you are reading an older plugin, that is what its hints are
about.*

**`settings` and `panel.widgets` are one namespace.** A widget's value is stored once, so a
key in both lists would be one value with two declarations that could disagree about its
type. Declaring a key twice is a load error. Which half a widget belongs in is your call.

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
| `"type": "slider"` | not one of the twelve widgets |
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

The plugin contract broke at M4, which is what M4 was for: `alexia_protocol` went to `2` for
`lifetime`, and to `3` at M6 for `panel`. Both were additive, and both were the mechanism
working — a plugin outside the range gets the refusal message above rather than a crash,
which is the entire reason third-party plugins could be accepted this early.

`1` no longer loads. See [`versions.md`](./versions.md) for what each revision added and what
updating costs.
