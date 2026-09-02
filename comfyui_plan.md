# comfyui_plan.md

**Driving real ComfyUI workflows from Alexia, instead of one hardcoded SDXL graph.**

*Written 2026-09-01. Captured from the investigation session of the same date.*

> **Built 2026-09-01 as `M8-5`, decisions `D123`–`D128` in [`plan.md`](./plan.md).** The four
> questions in §13 were answered by the owner and are recorded there; §13 below carries the
> answers. **Two findings in this document turned out to be wrong and both were load-bearing** —
> see §4.1 and §7.1, corrected in place with the correction marked. Rungs 1–4 of §12 are done,
> plus half of 5 and all of the output half of 7; what is not built is named in `M8-5`.

---

## 0. What this document is — and is not

This is an **information capture**, not a schedule. It records what the picture
plugin actually does today, what ComfyUI actually offers over HTTP, which wall
sits between the two, and what was decided about the shape of the fix.

- **It does not schedule anything.** No milestones, no task IDs. When this becomes
  work it becomes a `D`-number and tasks in [`plan.md`](./plan.md).
- **It does not authorise anything.** Nothing here has been built. §9 describes a
  promise that is false in `main` right now; that is a finding, not a fix.
- **Every claim is sourced to a file and line**, in this repo or in the ComfyUI
  install it was read against. Where something is inferred rather than read, it
  says so.

> **Read order:** §2 is the goal. §4 is the wall. §5 is the decision. §7–§8 are
> the architecture. §9 is what is broken now. §13 is what needs a human answer.

---

## 1. Sources, and how these facts were verified

| Source | What it is | Read | Trust |
|---|---|---|---|
| `plugins/media/*` | The plugin as built — 930 lines across four files | 2026-09-01 | **Ground truth** |
| `packages/core/src/plugins.ts` | Capability routing | 2026-09-01 | **Ground truth** |
| `packages/core/src/host.ts`, `store.ts`, `settings.ts` | What a plugin may write, and where its data lives | 2026-09-01 | **Ground truth** |
| `docs/spec/ui-schema.md`, `plugin.schema.json` | The twelve widget types | 2026-09-01 | **Ground truth** |
| `C:\Users\vacla\Desktop\_\ComfyUI` | ComfyUI **0.27.0**, 26 custom node packs, the owner's own install | 2026-09-01 | **High** — source read, not documentation |
| `…\ComfyUI\server.py`, `execution.py`, `app/user_manager.py` | The HTTP surface | 2026-09-01 | **High** — route handlers read directly |
| `…\ComfyUI\user\default\workflows\*.json` | Three saved workflows, one empty folder | 2026-09-01 | **High** |

**Method.** Endpoints were read off the `@routes` decorators in `server.py` and
`app/user_manager.py` rather than from ComfyUI's docs, because the docs lag the
code and this install is a specific version. Nothing here has been exercised
against a running server yet — see §12.

---

## 2. The goal

> *"the quick photo gen is cool but we dont have any settings that are normal in
> comfyui workflows"*
> — the owner, 2026-09-01

Stated precisely, as something testable:

**A workflow the owner built in ComfyUI should be runnable from Alexia, with its
own knobs — tags, LoRAs, CFG, sampler, reference image — exposed as things the
model or the person can set.**

Two sub-goals fall out of it:

1. **The quick path stays quick.** *Make me a picture of a cat* must not grow a
   twelve-field form. Whatever is built is a second door, not a replacement.
2. **A workflow's own vocabulary survives.** A graph with a `tags` string node
   should present a `tags` field, not a generic `prompt` that silently lands in
   the wrong place.

---

## 3. What exists today

`plugins/media` is 930 lines: `comfy.js` (the API client), `launch.js` (finding
and starting ComfyUI), `index.js` (the tools and the promises), `plugin.json`.

**The pipeline is a literal.** `comfy.js:26` — `graph()` returns a seven-node
SDXL text-to-image graph, built fresh on every call:

| Node | Class | What is variable |
|---|---|---|
| 3 | `KSampler` | `seed`, `steps` only — **`cfg` is frozen at 7, sampler at `dpmpp_2m`, scheduler at `karras`, denoise at 1** |
| 4 | `CheckpointLoaderSimple` | `ckpt_name` |
| 5 | `EmptyLatentImage` | `width`, `height` |
| 6 / 7 | `CLIPTextEncode` ×2 | positive and negative text |
| 8 | `VAEDecode` / `VAEDecodeTiled` | swapped by the `vae_fp32` setting |
| 9 | `SaveImage` | nothing |

There is **no LoRA node in the graph at all**. No ControlNet, no IPAdapter, no
img2img, no upscale, no second pass.

**What the tools expose.** `generate` takes `prompt`, `negative`, `width`,
`height`, `seed`, `model`. `models` lists checkpoints. `start_comfyui` and
`stop_comfyui` manage the process.

**The install it faces.** Six checkpoints, thirteen LoRAs, 26 custom node packs
including `rgthree-comfy`, `efficiency-nodes-comfyui`, `ComfyUI_IPAdapter_plus`,
`comfyui_controlnet_aux`, `ComfyUI-Easy-Use`, `was-node-suite-comfyui`. The
plugin can reach exactly one of those six checkpoints per call and none of the
rest of it.

> **The complaint, restated accurately.** It is not that Alexia sees one
> safetensors file — `models` correctly lists all six checkpoints, and `pick()`
> in `comfy.js:98` matches them loosely by filename. It is that **only a
> checkpoint can ever load**, and everything that makes a workflow a workflow is
> unreachable.

---

## 4. The wall: two JSON formats that look alike

This is the central finding and it shapes everything after it.

**The saved workflows are UI format.** `nodes`, `links`, `groups`, `extra`,
`widgets_values` — the editor's own document, positions and all.

**`POST /prompt` accepts API format only.** A flat map of node id →
`{class_type, inputs}`, every input either a literal or a `[node_id, slot]` pair.
That is what `comfy.js:26` builds by hand.

**There is no server-side converter.** Every `@routes` handler in `server.py` was
read; the conversion lives in the TypeScript frontend (`graphToPrompt`) and is
never exposed over HTTP.

### 4.1 Why re-implementing the conversion is a trap

It is possible in principle — `/object_info` gives each node's input names in
widget order, which is what `widgets_values` indexes into. It fails on **the
owner's actual workflows**:

| Obstacle | Where it appears | Why it breaks a naive converter |
|---|---|---|
| `Power Lora Loader (rgthree)` | Photo Reference, node 17 | `widgets_values` is an array of **objects** (`{on, lora, strength, strengthTwo}`) with a header sentinel, not scalars in widget order |
| `Eff. Loader SDXL`, `KSampler SDXL (Eff.)`, `LoRA Stacker` | Simple SDXL + LoRA, nodes 1–3 | Widget **count is dynamic**, driven by a `lora_count` widget; the array length is not derivable from `/object_info` alone |
| ~~`PrimitiveStringMultiline` → converted widget-input~~ | Photo Reference, nodes 18/19 → 22 → 4 | ~~Primitive nodes have no `class_type`~~ **— wrong, corrected 2026-09-01.** `PrimitiveStringMultiline` is a **real backend node** in 0.27 (`comfy_extras/nodes_primitive.py`, `node_id="PrimitiveStringMultiline"`), so it exports as an ordinary node carrying its title. The obstacle is real for the old frontend-only `PrimitiveNode`, and neither of these workflows has one. It matters because this is the node holding the tags |
| Bypass / mute (`mode` 2 and 4) | Any workflow, at any time | Bypassed nodes must be removed **and their links bridged** through matching types, or the graph is disconnected |
| `Reroute`, node groups, subgraphs | Not in these three, but one save away | Same class of problem, more of it |

Three of the five appear in the workflows this is being built for. A converter
that handles the plain cases and fails on these is worse than no converter,
because it fails *silently and specifically on the interesting graphs*.

### 4.2 The decision

**Consume API format. Ask for the export.**

`Workflow → Export (API)` in ComfyUI writes exactly what `/prompt` eats. It is one
menu click, it is done once per workflow, and it makes the frontend — which is the
only thing that has ever known how to do this correctly — do the conversion.

**What this costs:** a workflow edited in the editor and not re-exported goes
stale, and nothing detects that. Mitigation is a modified-time comparison between
the `.json` in `workflows/` and the exported copy, and an honest sentence. See
§13.1.

---

## 5. One plugin or two

The question asked: *should there be a new `comfyui` plugin, with `media` kept as
a simple generator with a model switcher?*

**Decision: one plugin.** Three reasons, in descending strength.

### 5.1 Capability routing has no tiebreak

`packages/core/src/plugins.ts:351`, in its own words:

> Call whatever provides this capability. **By name only** — the result does not
> say who answered and there is no way to ask, which is the invariant rather than
> politeness.

The implementation is a `for` loop over `#entries`; the first enabled plugin whose
manifest lists the capability *and* whose live tool carries the
`alexia/provides` binding answers. If `media` and `comfyui` both declared
`image.generate`, **Combined mode would get whichever iterated first**, and the
user would have no way to steer it.

Corroborating: across all thirteen plugins in `plugins/`, **no capability has two
providers**. `image.generate`, `document.extract`, `voice.transcribe`,
`code.task` — every one is claimed exactly once. That is not coincidence; the
routing has no way to choose, so single-provider is load-bearing.

*The clever workaround does not work either.* The binding is dynamic — `index.js`
does `made.update({_meta: {'alexia/provides': [...]}})` — so in principle two
plugins could take turns. Doing that safely needs them to agree on whose turn it
is, and §5.2 is exactly why they cannot.

### 5.2 The anti-double-start guard lives in per-plugin storage

`index.js` writes the pid of the ComfyUI it started to `alexia.storage`:

```js
await alexia.storage.set('started', { pid, dir: can.dir, port: at, at: Date.now() })
```

Storage is namespaced per plugin as `p_<namespace>_*` (`packages/core/src/store.ts:147`)
and a plugin may only touch its own tables — that is the point of
[`docs/spec/storage.md`](./docs/spec/storage.md). A second plugin gets
`p_comfyui_*` and **cannot see that `media` already started ComfyUI.**

That re-opens the failure `index.js` names in its own comment:

> two ComfyUIs on one graphics card is the worst end available here

And it breaks the promise `stop_comfyui` makes — *"a ComfyUI the user started
themselves is left alone"* — because neither plugin can verify the other's pid
record, so each would see a running server it has no record of starting and
correctly refuse to stop it. The GPU stays occupied and nothing can free it.

On an 8 GB card, with the fp16 black-image failure already documented as a
symptom of VRAM pressure (`comfy.js:20`), this is not theoretical.

### 5.3 `launch.js` would be duplicated

293 lines: install discovery (`install`, `search`, `isInstall`), venv-Python
detection (`interpreters`, `python` — the finding that the venv beside the install
is the only Python with PyTorch in it), spawn (`start`), readiness polling
(`ready`, `awake`), log tail (`tail`), process control (`alive`, `stop`).

`pnpm-workspace.yaml` covers `packages/*` and `plugins/*`, so extracting
`@alexia/comfy` is mechanically possible. It would be a shared package built to
serve one consumer and one near-consumer, to enable a split that §5.1 and §5.2
already argue against.

### 5.4 The honest case for splitting, and what it actually asks for

There is a real argument on the other side: `plugin.json` calls this **"Local
image generation"** and its summary is *"the picture-making half of Combined
mode."* A workflow runner does not fit that sentence — and one of the owner's
three saved workflows (`ScriptTTS - Voice Clone Script Reader.json`) produces
**audio**, not images.

But that is a **naming problem, not a boundary problem**. The plugin owns the
ComfyUI process; the fix is to let its name say so, not to add a second plugin
that fights it for the graphics card.

**If a rename happens:** `id` is `media`, and the storage namespace is `media`.
`store.ts:141` notes that nothing migrates namespaces. So a rename is a display
name and summary change only — the id stays.

---

## 6. The ComfyUI HTTP surface, as actually implemented in 0.27.0

Everything below is already covered by the plugin's existing `net.request`
capability. None of it needs a new permission.

| Endpoint | Verified at | What it gives | Used today |
|---|---|---|---|
| `GET /userdata?dir=workflows&recurse=true` | `app/user_manager.py:150` | **Lists the user's saved workflows over HTTP.** `full_info=true` adds path, size and modified time | ✗ |
| `GET /v2/userdata?path=workflows` | `app/user_manager.py:214` | Structured listing: name, type, path, size, modified | ✗ |
| `GET /userdata/{file}` | `app/user_manager.py:334` | Reads one workflow's JSON | ✗ |
| `GET /models` | `server.py:342` | **Every model folder name** — `loras`, `controlnet`, `ipadapter`, `vae`, `upscale_models`, … | ✗ |
| `GET /models/{folder}` | `server.py:348` | The filenames in one folder. 404 if the folder is unknown | ✗ |
| `GET /object_info` | `server.py:790` | Every installed node class and its inputs | ✗ |
| `GET /object_info/{node_class}` | `server.py:803` | One class — **already used**, for `CheckpointLoaderSimple` (`comfy.js:110`) | ✓ (once) |
| `POST /upload/image` | `server.py:464` | Multipart upload; returns `{name, subfolder, type}` — exactly the shape a `LoadImage` node's input wants | ✗ |
| `POST /prompt` | `server.py:1062` | Queue a graph | ✓ |
| `GET /history/{id}`, `GET /queue`, `GET /view` | `server.py:1049`, `1054`, `516` | Poll, position, fetch bytes | ✓ |
| `POST /interrupt` | `server.py:1150` | **Cancel the running job.** The plugin's `signal` currently only abandons the poll — the job keeps rendering | ✗ |
| `GET /system_stats` | `server.py:676` | VRAM and device info | ✗ |

### 6.1 Two findings in 0.27's `/prompt` worth writing down

**Client-supplied `prompt_id`** (`server.py:1078-1090`). A caller may pass its own
UUID; the server validates it is canonical lowercase hyphenated and uses it, or
mints one when the field is absent or null. **This makes queueing idempotent** —
a retry after a dropped connection can reuse the id instead of queueing a second
render. The plugin currently lets the server mint it, so a retry double-queues.

**`partial_execution_targets`** (`server.py:1097`). A graph can be run to a subset
of output nodes. Potentially useful for previewing one branch of a large workflow
without paying for the rest; not needed for the first version. Unverified against
a running server.

### 6.2 The websocket, still not needed

`comfy.js:11` argues polling over the websocket and the argument holds. But note
`server.py:283` — sockets carry `feature_flags` and `supports_preview_metadata`,
so **live step-by-step previews are a websocket-only feature.** If per-step
progress or a live preview image is ever wanted, that is the upgrade, and it is
the only thing that would change.

---

## 7. Binding a workflow's knobs

Given an API-format graph, the problem is: *which node is the prompt?* Two layers,
in this order.

### 7.1 Titles — the explicit contract

**API format carries `_meta.title` per node**, and the backend reads it —
`execution.py:1126` and `execution.py:1143`:

```python
node_title = node_data.get('_meta', {}).get('title')
node_title = node_data.get('_meta', {}).get('title', class_type)
```

So a title survives the export and is legible to the plugin.

> **Correction, 2026-09-01.** A title surviving is not the same as a title being *the author's*.
> **API format carries `_meta.title` on every node**, and an untitled one exports the class's
> **display name** — `Load Checkpoint`, not `CheckpointLoaderSimple`. So *has a title* is true of
> every node and proves nothing; the test is *differs from what it would have been*, which needs
> `GET /object_info` and cannot be done on the graph alone. Four lines in `workflows.js:titled`,
> and a silent bug in every version of this that assumed otherwise.

Proposal: a prefix claims a node.

```
alexia:tags        → a `tags` string field
alexia:prompt      → the positive prompt
alexia:negative    → the negative prompt
alexia:image       → a reference image slot, uploaded via POST /upload/image
alexia:seed        → the seed
```

This is what makes the missing tag editor work. In `Photo Reference (Pose +
Style).json`, node 19 is a `PrimitiveStringMultiline` holding
`"bartolomeobari, rebecca, bighand, 1girl, solo"`, concatenated with the Ollama
output and fed to `CLIPTextEncode`. Titling it `alexia:tags` turns that literal
into an editable field with **no schema invention and no guessing**.

*The prefix is a proposal, not a finding.* An alternative is to treat any node the
user has bothered to title as exposed, on the theory that ComfyUI's default titles
are class names and a custom title means intent. That is friendlier and less
precise. See §13.2.

### 7.2 Heuristics — for graphs nobody has titled

Walk backwards from the output. A first table, to be checked against real graphs
rather than trusted:

| Found | Becomes |
|---|---|
| `KSampler`'s `positive` link → a `CLIPTextEncode` | the positive prompt |
| `KSampler`'s `negative` link → a `CLIPTextEncode` | the negative prompt |
| `KSampler`'s own `seed`, `steps`, `cfg`, `sampler_name`, `scheduler`, `denoise` | numeric and choice knobs |
| `EmptyLatentImage`'s `width`, `height` | size |
| `CheckpointLoaderSimple`'s `ckpt_name` | the model switcher, validated against `GET /models/checkpoints` |
| any `LoadImage` | a reference image slot |
| `LoraLoader` / `Power Lora Loader (rgthree)` | the LoRA stack, validated against `GET /models/loras` |
| `SaveImage` / `PreviewImage` | where the output comes from |

**Sampler and scheduler must come from `/object_info`, not a hardcoded list.**
Custom node packs add samplers, and a hardcoded enum would refuse valid values.

### 7.3 Where the knobs land

**Not the settings pane.** This is a hard constraint, read at
`packages/core/src/host.ts:122`:

> The narrowness is the whole design. A `status` is the plugin's own report of
> itself and nobody else writes it; everything else on this screen is the user's
> answer, and a plugin that could rewrite a toggle could quietly undo a decision
> the person made.

A plugin may write **only `status` widgets**. `choice` options are static in the
manifest. The twelve widget types (`docs/spec/ui-schema.md:89`) are `text`,
`password`, `number`, `toggle`, `choice`, `multi-choice`, `path`, `status`,
`progress`, `action`, `graph`, `table` — none of which takes a list the plugin
supplies at runtime.

**The tool schema is the flexible surface.** `packages/sdk/src/plugin.ts:70`
exposes `toolsChanged()`, and `alexia.tool()` returns a handle with `.update()` —
`index.js` already uses it to bind and unbind `image.generate`. So a workflow's
discovered knobs become **tool input schema**, rebuilt when the workflow list
changes and republished with `toolsChanged()`.

---

## 8. The proposed tool surface

Two doors on one plugin.

**`generate` — unchanged in spirit.** Prompt in, picture out, hardcoded graph,
fast, no workflow to choose. Remains the `image.generate` provider and Combined
mode's path. §2's first sub-goal is this tool not growing.

**`workflows` — read-only.** Lists what is exported and runnable, what is stale,
and what cannot run because a node pack is missing.

**`run_workflow` — the new door.** Takes a workflow name plus its discovered
knobs. **Declares no capability.** The model reaches it by name when the ask
exceeds the quick path, which keeps §5.1's single-provider rule intact and means
adding it cannot destabilise Combined mode.

**Validation before queueing.** `GET /object_info` names every installed class. A
workflow referencing a class that is not there should produce *"this workflow
needs `IPAdapterAdvanced`, which is not installed"* — not the 400 that `why()` in
`comfy.js:69` had to be written to decode. That function exists because a missing
required input on `VAEDecodeTiled` cost a day; the same class of error is one
uninstalled node pack away, and it is cheap to pre-empt.

---

## 9. What is false in `main` right now

`plugins/media/plugin.json` declares:

```json
{ "type": "choice", "key": "checkpoint", "label": "Model",
  "options": ["auto"], "default": "auto",
  "hint": "Auto uses whatever checkpoint ComfyUI has loaded. The list fills in once it can reach ComfyUI." }
```

**The list does not fill in, and cannot.** `choice` options are fixed in the
manifest, and `host.ts:122` refuses any plugin write to a non-`status` widget.
Nothing in `index.js` even attempts it. So the dropdown offers `auto` forever, on
a machine with six checkpoints installed, while the hint promises otherwise.

This is a **shipped false promise on a user-facing screen**, in a project whose
stated bar is that the author's own sentences are what the user reads.

Two ways out:

1. **Make the widget honest** — replace `choice` with `text`, placeholder `auto`,
   hint naming the `models` tool. `pick()` already does loose filename matching,
   so typing `hassaku` works. Roughly ten lines, no spec change.
2. **Make the promise true** — add plugin-supplied options to the widget
   protocol. That is a change to `ui-schema.md`, the schema, `settings.ts` and the
   renderer, and it reopens the question `host.ts:122` deliberately closed. It
   would also solve the workflow-picker problem in §7.3.

**(1) is a bug fix and should not wait for this plan.** (2) is a design question —
see §13.3.

> Note: the model switcher the owner asked about **already exists at the tool
> level.** `generate`'s `model` parameter → `chosen()` → `pick()` matches any part
> of a filename across all six checkpoints. Only the settings-pane dropdown is
> broken.

---

## 10. The owner's workflows, specifically

Four entries in `…\ComfyUI\user\default\workflows`. All three JSON files are UI
format; **none is exported for the API**, so none is runnable today.

### 10.1 `Photo Reference (Pose + Style).json` — 20 nodes

The interesting one, and the one this plan is really about.

```
LoadImage ─┬─ OpenposePreprocessor ─ ControlNetApplyAdvanced ─┐
           └─ IPAdapterAdvanced ────────────────┐             │
CheckpointLoaderSimple ─ Power Lora Loader ─────┴──────────── KSampler ─ VAEDecode ─ PreviewImage
OllamaGenerateV2 ─ StringConcatenate ─ CLIPTextEncode ────────┘
PrimitiveStringMultiline ("bartolomeobari, rebecca, …") ──┘
```

- **Two LoRAs**, stacked in `Power Lora Loader (rgthree)` (node 17)
- **ControlNet openpose** — `xinsir_openpose_sdxl.safetensors`, strength 0.6
- **IPAdapter** — `PLUS (high strength)`, style transfer, weight 0.7
- **KSampler**: seed 90212 / randomize, 28 steps, **cfg 6.5**, `dpmpp_2m` /
  `karras` — note cfg 6.5, where the plugin's graph is frozen at 7
- **832×1216**, where the plugin defaults to 1024×1024
- Node 19 is the **tags** the owner cannot currently edit

Everything §2 asks for is in this one graph. It is the right first target.

**⚠ It calls Ollama.** Nodes 20 and 21 (`OllamaConnectivityV2`,
`OllamaGenerateV2`) hit `http://127.0.0.1:11434` with `dolphin3:8b` and a system
prompt that converts a description into danbooru tags. Alexia has its own
`packages/core/src/ollama.ts`. **Two prompt-rewriters in one pipeline is a bug
waiting to happen** — the model writes a prompt, the graph rewrites it, and nobody
can see where a bad result came from. See §13.4.

### 10.2 `Simple SDXL + LoRA.json` — 10 nodes

`LoRA Stacker` → `Eff. Loader SDXL` → `KSampler SDXL (Eff.)`, all from
`efficiency-nodes-comfyui`. **The worst case for the converter argued against in
§4.1** — dynamic widget counts driven by `lora_count`. In API format it is
unremarkable, which is the whole point of §4.2.

### 10.3 `ScriptTTS - Voice Clone Script Reader.json` — 10 nodes

`LoadAudio` → `FB_Qwen3TTSVoiceClonePrompt` → `ScriptTTS_Render` →
`SaveAudioMP3`. **This is audio.** A runner that can only return `image.generate`
has nowhere to put it. It is also the only workflow here with hand-written titles
on every node (`"1. Your Voice Recording"`, `"3. Load Script (doubling + pauses)"`)
— which is evidence for §7.1's alternative reading: the owner titles nodes when
they mean something.

### 10.4 `WAN2.2 - IMG to VIDEO/` — empty

An empty folder. Named for an image-to-video workflow that is not there. Two
`wan22_i2v_lightning_4steps_*.safetensors` LoRAs **are** installed, so the intent
is real and the workflow is coming. Whatever is built should not assume the output
is a still image.

---

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| A workflow is edited and not re-exported; Alexia runs the old graph | **High** — silent wrong output | Compare modified times of `workflows/x.json` and the exported copy via `GET /userdata?full_info=true`; say so plainly |
| Heuristic binding picks the wrong node as "the prompt" | **High** — silently wrong picture, §3's own argument about a coin toss | Titles win over heuristics always; `workflows` shows what was bound to what, before anything runs |
| A workflow needs an uninstalled node pack | Medium | Pre-flight against `GET /object_info` (§8) |
| A big workflow exhausts VRAM and produces a black image or an OOM | Medium | The `vae_fp32` lesson (`comfy.js:20`) says this fails silently. `GET /system_stats` before a heavy graph |
| `run_workflow`'s schema changes under the model mid-conversation | Low | `toolsChanged()` exists for this; rebuild only when the workflow list changes |
| A long workflow outruns core's two-minute tool call | Medium | Already the shape of `wake()`'s ninety-second bound — return honestly and let the next call collect the result |
| A cancelled call leaves ComfyUI rendering | Low, but wasteful | `POST /interrupt` (§6). Not wired today |

---

## 12. A scope ladder

Not a schedule. Rungs, cheapest first, each one useful alone.

1. **Fix the false model dropdown** (§9, option 1). Ten lines. Independent of
   everything else here.
2. **Discovery.** `workflows` tool over `GET /userdata`. Read-only, lists what is
   there and whether it is exported. Proves the endpoint and costs nothing.
3. **Run an API-format workflow with no knobs at all.** Load, validate against
   `/object_info`, queue, collect. This is the whole risk of §4 retired in one
   step.
4. **Title-bound knobs** (§7.1), then heuristics (§7.2). `Photo Reference` is the
   test case; `tags` is the acceptance criterion.
5. **Model and LoRA lists** from `GET /models/{folder}`, so a knob's valid values
   are real filenames.
6. **Reference images** via `POST /upload/image` — unlocks ControlNet, IPAdapter
   and img2img.
7. **Non-image outputs** (§10.3, §10.4) — only once there is a second workflow
   that needs it.

---

## 13. What needed a human answer — answered 2026-09-01

All four were put to the owner with the evidence attached, and all four are decisions in
[`plan.md`](./plan.md) now. The answers sit under each question rather than replacing it,
because the reasoning that was open is why the answer is what it is.

### 13.1 Export staleness — how loud?
A re-exported workflow is a manual step and will be forgotten. Options: refuse to
run a stale export; run it with a warning; run it silently and show the age in
`workflows`. **The project's habit is the honest sentence over the refusal**, but
this one produces a *wrong picture* rather than a failure, which is the case the
habit is weakest against.

> **Answered: refuse, and name the fix (D126).** The refusal says what was edited and when, what
> was exported and when, and the one menu entry that fixes it. `stale: true` is the escape, so it
> is never a dead end — running the older graph stays possible and has to be asked for. The habit
> lost this one on the argument the question itself makes: a picture nobody can tell from a right
> one costs the trust in every picture after it.

### 13.2 How does a node say "I am a knob"?
`alexia:` prefix (§7.1), or any custom title (§7.2's alternative). The prefix is
explicit and ugly and requires the owner to re-title nodes. Any-custom-title is
friendly and would expose `"3. Load Script (doubling + pauses)"` as a field name.
~~**Unresolved.**~~

> **Answered: any custom title (D125)**, on evidence rather than taste. The titles were counted
> before the question was asked. `Photo Reference (Pose + Style)` has **twenty nodes and four
> titles**, and the four are the checkpoint, the plain-English box, the fixed tags, and the
> display showing what the two became; `Simple SDXL + LoRA` has ten nodes and three titles, and
> they are the same three strings word for word. The owner already titles what they mean, so the
> prefix would have bought precision by making every existing workflow unrunnable until re-titled.
>
> `"3. Load Script (doubling + pauses)"` becoming a field name was the stated objection, and it
> is handled rather than accepted: the name is the part before the explanation and after the step
> number — `load_script` — and the whole title survives as the field's description, so nothing is
> lost. **The real difficulty turned out to be elsewhere**: see the correction in §7.1.

### 13.3 Should widgets get plugin-supplied options?
§9's option 2. It would fix the model dropdown properly *and* give the workflow
picker a home in the settings pane instead of the tool schema. It also reopens
what `host.ts:122` deliberately closed, and the reasoning there is sound. **This
is a spec question, not a plugin question**, and it should be answered on its own
merits rather than because ComfyUI wants it.

> **Left open, deliberately, and no longer blocking.** §9's option 1 shipped (D127) and the knobs
> went to the tool schema (§7.3), so nothing built here depends on it. It stays a question about
> `host.ts:122`, to be argued on its own merits.

### 13.4 Who writes the tags — Alexia or the graph?
§10.1. Either the plugin drives `OllamaGenerateV2` and Alexia's model stays out of
prompt-writing, or Alexia writes the tags and that node gets bypassed. Doing both
is the failure. ~~**Owner's call**~~, and it is about how the assistant should feel
rather than about code.

> **Answered: the graph writes them (D128).** Alexia fills the plain-English box and the
> fixed-tags box and stays out of the rest; `OllamaGenerateV2` does what it was built to do, with
> the system prompt its author tuned. §2's second sub-goal is that a workflow's own vocabulary
> survives, and the rewriter is part of that vocabulary. No bypass logic, and the field carries
> the author's own title — which is what tells the model to write a sentence rather than tags.

### 13.5 Does the plugin get renamed?
§5.4. `media` / "Local image generation" does not describe something that runs
audio workflows. The id and namespace must stay `media` regardless
(`store.ts:141` — nothing migrates). **Cosmetic, but it is on a screen the user
reads.**

> **Answered: not yet.** It keeps the name until a workflow that is not a picture is actually run
> — §12's rung 7. Nothing on the screen is false while everything anyone runs makes pictures, and
> the audio workflow has not been run. The runner itself assumes nothing: outputs are read by
> shape, so on the day that changes the rename is the only thing left to do.

---

## 14. Decisions recorded here

| # | Decision | Section |
|---|---|---|
| 1 | Consume API-format exports; do not re-implement `graphToPrompt` | §4.2 |
| 2 | One plugin, not two — capability routing has no tiebreak and the pid record is namespaced | §5 |
| 3 | Knobs live in the tool schema, not the settings pane | §7.3 |
| 4 | `run_workflow` declares no capability; `generate` stays the sole `image.generate` provider | §8 |
| 5 | The `checkpoint` dropdown's hint is false and is a bug independent of this plan | §9 |
| 6 | A node its author titled is a node they meant — no `alexia:` prefix | §13.2 |
| 7 | A stale export is refused, and the refusal names the menu click | §13.1 |
| 8 | The workflow's own rewriter writes the tags; Alexia writes plain English | §13.4 |
| 9 | The plugin keeps its name until a workflow that is not a picture is actually run | §13.5 |

*All nine were built on 2026-09-01 as `M8-5`, and are `D123`–`D128` in
[`plan.md`](./plan.md) — which is now where they live. This file is the input they were written
from, kept for the reasoning rather than for the conclusions.*
