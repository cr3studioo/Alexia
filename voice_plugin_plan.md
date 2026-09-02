# Voice plugin page — redesign

## Context

The Voice plugin page today is a flat list of nineteen widgets in manifest order: Whisper
settings, Piper settings, a fish.audio key, an expression toggle, then a voices table, three
path boxes, two search filters and a catalogue table. Everything is visible at once whether or
not it applies, and the page never says which engine is actually speaking — `plugins/voice/index.js:47`
records that as a deliberate decision (*"There is no engine switch"*), and it has stopped paying:
`expression` needs a hint plus a clause in the status line to explain that it does nothing with
Piper, and the `tiny/base/small` dropdown reads as a voice model when it is Whisper's
speech-to-**text** size.

The reference is the Voice tab of the **Alexia Control** app running on `127.0.0.1:8771` — a
separate React app, not this repo. Its organising idea is one sentence: **the engine picker is
the top of the page, and everything below is the material that engine works with.** Everything
that does not apply to the chosen engine is gone rather than greyed.

The goal is that shape, in Alexia's own visual language, plus two features the reference has
that we lack: inline audio previews, and a real file picker for the clone clip.

## Decisions taken

| Question | Answer |
|---|---|
| What is "local" | **Both** — Piper for fast local speech, Qwen3-TTS for better local speech *and* local cloning |
| How Qwen3-TTS lands | Find an existing Python env, never ship one — mirrors `plugins/media/launch.js` |
| Preview audio | An audio node appears next to the voice when generation finishes; ephemeral, never stored |
| Clone clip | Real file picker |
| Visual | Reference's *structure*, Alexia's existing look — no `app.css` restyle |
| Whisper | Its own clearly-labelled "Hearing" section, always visible |
| Page frame | Stays a sub-page of Settings → Plugins (D118 and invariant 1 untouched) |

Decided here, flag if wrong: one preview-text box for the whole page (not per voice); the
`expression` toggle disappears, becoming the fourth engine; one voice list at the bottom,
grouped by engine via `cards`' existing `group` field.

## What the page becomes

Four engines, not three — Piper and Qwen3-TTS are both local.

```
Voice engine                          ← choice, stacked cards with blurbs
  ( ) Piper            Fast, on this machine. Three published voices. No cloning, no expression.
  ( ) Qwen3-TTS        Better, and the only local engine that can clone. Needs Python and a GPU.
  (•) fish.audio — plain      Cloud. Fast, no GPU. Reads the text exactly as written.
  ( ) fish.audio — expressive Same, plus [emotion] marks. One extra model call per reply.

Find a voice                          ← when: engine is fish_*
  [ spongebob            ] [Search fish.audio]
  Language:  English  Spanish  Chinese  …
  Kind:      female  male  young  character-voice  …
  ┌ SpongeBob ─────────────────────────────────────────┐
  │ A high-pitched, enthusiastic male voice…           │  ← description, newly kept
  │ character-voice · energetic · 266 likes            │
  │ ▶ ──────────────  [Save]  [Preview in my words]    │  ← samples[0].audio
  └────────────────────────────────────────────────────┘

Preview text
  [ This is what I sound like.                        ]

Your voices                           ← the picker, grouped by engine
  Piper        lessac ● speaking · ryan ■ not downloaded — 114 MB
  Qwen3-TTS    reze ● ready   ▶ ──────────
  fish.audio   Reze ● ready   ▶ ──────────  [Use] [Preview] [Remove]

Add a voice / Clone a voice           ← when: engine
  Piper:  [Choose file… .onnx]  [Add]
  Qwen3/fish:  [name] [Choose file… .wav] [transcript…] [Build clone]

Hearing                               ← always visible, all engines
  Speech model (tiny/base/small) · Threads · State · Download

Advanced
  Whisper program · Piper program · Qwen install · fish.audio key
```

## Work

### Phase 0 — core plumbing

Four changes, all additive and all in core's own vocabulary. None of them names a plugin, so
invariant 1 stays green; none touches `rows`, so invariant 13 stays green.

**1. `choice` gains per-option blurbs.** The reference's engine picker is a radio group of
bordered cards with a title and an explanation. Today `packages/ui/src/widgets.ts` renders
`choice` as a segmented control at ≤3 options (`SEGMENTED_UP_TO`) and a `<select>` above that —
neither of which can carry a blurb, and four engines would land in a dropdown.

Extend `options` to accept `{ value, label, hint, available?, reason? }` objects alongside
today's plain strings (plain strings keep the current rendering exactly, so no other plugin
moves). When any option carries a `hint`, render the stacked-card form. `available: false`
dims the card and shows `reason` inline — this is what the reference does with 55% opacity and
*"— pick a fish.audio voice below first."*

This must be a `choice` **setting**, not a `cards` widget, because a plugin cannot write its
own settings (`alexia.settings()` reads; only `/api/settings` writes) — and step 2 needs to gate
on a value core can read.

**2. `when` — conditional visibility.** Add `when: { key, is: string | string[] }` to every
widget branch in `docs/spec/plugin.schema.json` and the `Manifest` type in `packages/protocol`.
`packages/core/src/settings.ts` (`render()` / `pane()`) drops widgets whose `when` does not match
the current stored value, so hidden widgets never reach the page at all.

The UI half: `save()` in `widgets.ts` deliberately never redraws (a redraw steals focus
mid-keystroke), with `password` the sole exception. Add a second — core marks a widget `gates: true`
when any sibling's `when` names its key, and the host redraws the pane on save. Keep the reason in
a comment; the existing one is precise about why redrawing is normally wrong.

**3. Row-level audio previews.** *Not* a fourteenth widget. Add an optional `preview` field to
`Row`, and have `cards()` (and `table()`) render `<audio controls preload="none" src=…>` in the
row when it is present. `preload="none"` means nothing is fetched until play is pressed — the
reference relies on this too.

The source is either a public URL (fish's R2 bucket) or a `data:` URI (a generated preview).
**Verify the shell's CSP allows `media-src https: data:`** before building on it.

**4. Plugin-facing file upload.** `packages/core/src/attach.ts` already is this seam and its
header explains the shape: base64 in a JSON body rather than multipart (`node:http` has no
multipart parser), `MOST_PER_FILE` at 25 MB, `safeName()`, `receive()`, and *"the bytes do not
stay"*. Reuse it directly.

Add a `file` widget that posts base64 to a new `/api/upload` scoped to `{ plugin, key }`. Core
writes the bytes to a temp path inside the plugin's own dir via `receive()` and sets the widget's
value to that path. **The plugin then reads a path exactly as it does today** — `clone_voice` and
`fish.clone()` need no change at all, because `fish.clone` already wants bytes and only takes a
path to get them.

This is the direct answer to D89's objection that *"a browser will not tell a page where a file
is"*: core creates the path, so nothing has to.

### Phase 1 — fish.audio data and the preview tool

**`plugins/voice/fish.js`.** `listing()` maps the vendor's response down to
`{id, name, tags, likes, by}` and discards the rest. Verified live against the API with the key at
`C:\Users\vacla\Desktop\.env`, each item also carries:

- `samples[0].audio` — a public R2 URL, e.g. `https://platform.r2.fish.audio/task/<id>.mp3`.
  No key needed to play it, no proxying, nothing stored. (There is **no** top-level `preview_url`;
  the reference app renames this field in its own API.)
- `description` — a real sentence about the voice, better than our tag list as a card summary
- `default_text` — the vendor's own suggested preview line

Keep all three. Carry the sample URL through `search_voices` and `voices` rows as `preview`.

**New `preview_voice` tool.** Takes the text from the page's preview box and a voice id; calls
`fish.say()` (or the local engine); holds the returned bytes in an **in-memory `Map` keyed by
voice id**, never on disk. `reloadTables()` in `widgets.ts` already re-fetches rows after every
action, so the row comes back carrying a `data:` URI and the audio node appears next to that
voice — which is exactly the behaviour asked for, with "not stored anywhere" true by construction
rather than by a cleanup routine. The map is bounded (keep the last few) and dies with the process.

### Phase 2 — the page

Almost entirely `plugins/voice/plugin.json`, plus the tools behind it.

- `engine` — the new `choice`, four options with blurbs; `fish_*` unavailable without a key,
  `qwen` unavailable without an install, each with its `reason`
- Delete the `expression` toggle; `chosen()` derives `expressive` from `engine === 'fish_expressive'`
- `when: { key: 'engine', is: [...] }` on every engine-specific widget
- Language options become `[{value:'en',label:'English'}, …]` — same values, readable labels
- `find`/`find_tags`/`find_langs`/`catalogue` gated to the fish engines
- One `voices` list at the bottom as `cards`, `group` per engine, each row carrying `preview`
- `preview_text` box + a `preview_voice` row action on both lists
- Clone clip and `.onnx` add become `file` widgets
- `clip_text` needs multi-line — `text` renders a single-line `<input>` today; add `multiline: true`
- A "Hearing" section: Whisper size, threads, state, progress, download. Always visible
- Binary paths and the fish key move to the bottom

`state()` in `index.js` gets simpler: the engine is now on screen, so the status line stops
having to explain why expression did nothing.

### Phase 3 — Qwen3-TTS

A new `plugins/voice/qwen.js` presenting the same surface as `piper.js` (`ready`, `catalogue`,
`say`, `where`) so `bind()` and `use_voice` treat it as one more engine, plus `clone()`.

Follow `plugins/media/launch.js` rather than inventing a second pattern — it already solves the
whole problem for ComfyUI: `isInstall()`, `search()`, `install(hint)`, `interpreters()`,
`python()`, `start()`, `alive()`, `stop()`, `tail()`. Its doctrine holds here and is the reason
this is Phase 3 rather than Phase 0:

> Nothing here embeds ComfyUI or ships a copy of it… a plugin that quietly pulls six gigabytes
> of PyTorch because somebody asked for a picture is a plugin that has decided something for you.

So: find an existing install, or take a `qwen_path` setting. Never download torch. `plugins/media/tier.js`
(`vram()`, `tier()`, `reading()`) answers whether the card can take it, and the engine card shows
that as its `reason` when it cannot.

Plugins cannot import each other, so this is a sibling implementation of the same shape — worth
considering lifting the Python-discovery half into `@alexia/sdk` if it stays close.

## Files

| File | Change |
|---|---|
| `packages/ui/src/widgets.ts` | `choice` blurb cards; `Row.preview` audio; `file` widget; `multiline`; redraw on gating save |
| `packages/core/src/settings.ts` | `when` filtering in `render()`/`pane()`; `gates` flag |
| `packages/core/src/serve.ts` | `/api/upload` route |
| `packages/core/src/attach.ts` | reused as-is — `receive()`, `safeName()`, ceilings |
| `docs/spec/plugin.schema.json` | `when`, rich `choice` options, `file`, `multiline` |
| `docs/spec/{manifest,ui-schema}.md` | document the above |
| `packages/protocol` | `Manifest` types to match |
| `plugins/voice/plugin.json` | the page itself |
| `plugins/voice/index.js` | `engine` setting, `preview_voice`, simpler `state()` |
| `plugins/voice/fish.js` | keep `samples[0].audio`, `description`, `default_text` |
| `plugins/voice/qwen.js` | new — Phase 3 |

## Verification

- `pnpm check` — lint, types, unit tests, then all 13 invariants. Watch 1 (`core-names-no-plugin`),
  6 (`no-node-apis-in-ui`) and 13 (`widgets-can-fill-themselves`).
- New unit tests: `when` filtering in core; `choice` blurb rendering and `Row.preview` in
  `packages/ui/test/`; upload round-trip against `attach.ts`'s ceilings.
- Live, with the key at `C:\Users\vacla\Desktop\.env` (testing only, never committed or logged —
  `fish.js:call()` already scrubs it from error text): search returns previews → play one in the
  page → save it → preview it in your own words → clone from an uploaded clip → speak.
- Piper path unchanged: pick lessac, hear it, confirm the engine card and status line agree.
- Both themes, and the narrow breakpoint where `hideNarrow` columns drop.

**Known unverified:** `fish.js` records that the clone-creation call has never been run live from
this repo. The key now available makes this the first real confirmation — if the published shape
is wrong, that surfaces in Phase 1 rather than at the end.

## Risks

- **Phase 3 is much larger than Phases 0–2.** Phases 0–2 deliver the page you asked for with Piper
  and fish.audio working; Qwen3-TTS is a separate engine with a Python dependency, GPU
  requirements, and a download story. Worth shipping 0–2 first with the Qwen card showing
  *not installed*.
- **`when` changes the plugin contract**, so every manifest is re-validated against the new
  schema. Additive and optional, so existing plugins are unaffected — but the schema is the thing
  that catches a misspelled `toggle`, and it is worth keeping strict.
- **CSP on `media-src`** could block audio previews; check before building Phase 1 on it.
- The plan touches four `docs/spec` files. Those documents currently argue *against* some of this
  (D89 on `file`, the "thirteenth widget" bar). They should be updated to record what changed and
  why, not quietly contradicted.
