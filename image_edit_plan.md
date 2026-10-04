# Plan: Alexia local image editing

**Status (2026-10-04):** all packets A00–A10 are implemented, integrated and covered by tests; `pnpm check` is green (246 test files, 2,794 passed / 1 skipped; 36 invariants). The editor is reachable from *Edit pictures* beside *Attach* and from `edit_image` in chat. **It cannot yet produce an AI-edited picture, on purpose:** the two evidence gates below are open, so generation stops at `profile_unavailable` (no verified profile) and publication at `policy_unavailable` (no evaluated safety provider). Crop, resize, erase-to-transparency and export work now. Nothing is committed, merged or released.

## Progress

| Packet | State | Where | Tests |
|---|---|---|---|
| A00 contracts + integration | **Done** | Protocol 14 (`ALEXIA_PROTOCOL_MAX`), `attachments.scoped`, `alexia/attachments/{lease,release,live,register,share}`, `EDITOR_META` hidden tool, per-request `PRIVATE_CONTEXT_PROMISE` negotiation, `EditorCommand.mask` + `SelectionShape`, `EditorBackend.open`; `host.ts`, `plugins.ts` (`editorCall`), `tooling.ts` (attachment inputs → `_meta`), `serve.ts` (album, private conversations, `/api/editor*`, `forgetPictures()` + retry), `guard.ts`, `surface.ts` (deletion order); [contract doc](docs/spec/image-editor.md) | `private-context.test.ts`, `methods.test.ts`, `guard.test.ts` |
| A01 runtime | **Module done; hardware gate open** | `plugins/media/edit/{profiles,graph,runtime}.js`, `profiles/candidates.js` (one *unverified* Qwen-Image-Edit-2509 candidate), `benchmarks/run.mjs` (Step 0 harness), `models.js` SHA-256 checks, `comfy.forgetHistory`, `sweep()` of the worker's folders | `edit-runtime.test.js` (18), `models.test.js` (+2) |
| A02 attachments | **Done** | `packages/core/src/attachments/{images,index}.ts`, migration 11 | `attachment-lifecycle.test.ts` (11) |
| A03 private sampling | **Done** | `router.ts` (`placement: 'interaction'`, `onDevice`), `ollama.ts` (`relayed`), `provider.ts` (`response_format`), `serve.ts` (`privately()`, image modality), `agent.ts` (`placement`) | `private-sampling.test.ts` (10, captured HTTP) |
| A04 intent | **Done; real-model evaluation open** | `plugins/media/edit/{schema,validate,planner,compile}.js` | `edit-intent.test.js` (46) |
| A05 lifecycle | **Done** | `plugins/media/edit/{drafts,variants,log,run}.js`, `mount.js` (adapters) | `edit-lifecycle.test.js` (23) |
| A06 policy | **Control flow done; evidence gate open** | `plugins/media/edit/{safety.js,policy/rules.js,policy/providers.js,policy/evaluate.mjs}` | `edit-policy.test.js` (11, scripted evidence only) |
| A07 workspace | **Done; not yet seen on screen** | `packages/ui/src/image-editor.ts`, `image-editor-api.ts`, `image-editor-viewport.ts`, entry button in `index.html`/`main.ts`, styles in `app.css` | `image-editor-workspace.test.ts` (9) |
| A08 notes | **Done** | backend `plugins/media/edit/regions.js`; UI `packages/ui/src/image-editor-selection.ts` | `edit-regions.test.js` (13), UI test above |
| A09 deterministic tools | **Done** | `plugins/media/edit/transforms.js`, `transforms/png.js`; UI `packages/ui/src/image-editor-transforms.ts` | `edit-transforms.test.js` (17); crop parity checked against the UI |
| A10 verification | **Automated part done** | `packages/core/test/image-editor-integration.test.ts` (real core + real media plugin process: kept per conversation, cross-conversation refusal, no edit without a verified profile, crop end to end, export by token, confirm on removal, forget on both sides) | 7 |
| A11 | Not assigned (optional) | — | — |

### Release gates still open — these need the owner, real hardware or real evidence

1. **Verified profile (A01, blockers 1, 2, 6).** Run `node plugins/media/edit/benchmarks/run.mjs` on the target Windows + NVIDIA 8 GB / 16 GB machine against Alexia's own ComfyUI with the candidate's files, judge the outputs with the fixture rubric, then add a `status: 'verified'` profile with real hashes, sizes, sources, licences, `evidence` and the confirmed prompt slot syntax. No inpainting profile exists yet, so point edits and remove-and-fill cannot render either.
2. **Evaluated policy evidence (A06, blocker 4).** Build a licensed or consented labelled fixture set, run `node plugins/media/edit/policy/evaluate.mjs`, review the report, and only then set `EVALUATION` in `plugins/media/edit/mount.js`. Adult content and sensitive identity edits stay off (`SCOPE` in `policy/rules.js`) until a reviewed age-and-consent design exists.
3. **Owner decisions — accepted 2026-10-04 (answer 3A):** protocol 14 and `attachments.scoped`; three pictures as the release scope (blocker 3 answered); pictures in chat answered by on-device models whenever the editor is installed (`cloudVision: true` remains the explicit cloud choice, still without a UI control); the deviations in the contract doc.
- **Smaller model (answer 1C):** a second candidate, `qwen-image-edit-2509-q4` (4-bit GGUF diffusion model via ComfyUI-GGUF's `UnetLoaderGGUF`, fp8 text encoder offloaded), is in `profiles/candidates.js`. Unverified until the Step 0 harness runs on the 8 GB machine; the ComfyUI-GGUF node pack must be installed into Alexia's ComfyUI.
- **Adult mode (owner request, 2026-10-04):** Settings › Safety › *Adult content* (closed by default, needs “I am 18 or older”, guarded by a confirm) enables `/nsfw`, which pins uncensored chat models, puts uncensored local planners first, and sends `alexia/adult` to the editor. In adult mode the editor's content limit and consent check are lifted entirely; profiles carry an `uncensored` flag shown in the picker. **One rule is kept in every mode, by Claude's refusal to remove it:** nothing sexual is made of anyone who may be under 18 (`age_uncertain` only when an edit is not `sfw` *and* a person is not clearly adult). Because that check needs an evaluated provider (gate 2), adult edits stay blocked until gate 2 passes. No uncensored image profile exists yet; one is added like any other, once verified.

4. **On-screen check.** The editor UI has unit tests but has not been looked at in a running app. Say **preview** to build it into Alexia Dev.
5. **Real-model evaluation of the planner (A04)** on the Section 12 request cases, with a local vision model, once one is chosen.

**Known test that depends on the machine:** `packages/core/test/local-models-api.test.ts` › *context GET defaults…* fails when free memory is low (it reads `freemem()`); it is unrelated to this work and passes on other runs.

**Source:** `~/Downloads/alexia-image-system.md`, reviewed alongside the current repository. The contracts and acceptance criteria needed for implementation are restated here so that the Downloads file is not a build dependency.

**For agent assignments:** start with [Section 11](#11-agent-work-sections-and-execution-order). It contains independently assignable packets **A00–A10**, an optional **A11**, the parallel-work order, file ownership and a copyable dispatch prompt. Sections 1–10 are the shared specification; Section 12 is the release checklist. No agents are being dispatched by this plan revision.

## 1. Outcome and scope

A user attaches images and says, for example:

> Use my identity from image 1, the clothing and pose from image 2, and only the lighting from image 3.

A local vision planner assigns reference roles. Trusted code validates the resulting `ImageJob`, applies policy checks, compiles a deterministic instruction, builds a fixed ComfyUI graph, and returns only an approved output. Model output never chooses executable code, filesystem paths, node classes, model downloads or execution settings.

The intended product supports lawful, consensual adult creative work without hosted moderation, while rejecting sexual content involving minors or underage-looking subjects, non-consensual imagery and unauthorized sexualized depictions of identifiable people. Those requirements remain release gates. A classifier score or a camera capture must not be described as proof of age or consent.

### Foundation and requested editor scope

The backend foundation below is the first implementation milestone. The requested product also includes a visual editing workspace, multiple versions, a model picker, whole-image and point/region edits, crop/resize and removal tools, detailed in Section 2. Deliver those through U1 and U2 before calling the requested editor complete; they are planned product work, not an indefinite wishlist. Canvas expansion and AI upscaling are separate U3 extensions.

| Area | Backend foundation | Requested editor / additional gates |
|---|---|---|
| Inputs | 1–3 images total, including exactly one edit target; two- and three-image requests are core acceptance cases | The source's four-image requirement needs a separately validated graph; a three-image release is explicitly a reduced scope |
| Actions | Execute whole-image `image_edit` in the foundation | Add region editing and removal through a validated inpainting branch in U2; new text-to-image generation stays outside this editor's scope |
| Reference roles | All 16 source roles; multiple roles per reference; one identity source | Identity blending and multiple independently edited subjects |
| Edit quality | General instruction-based outfit, pose, lighting and style edits | U2 adds explicit masks and preservation outside the effective mask; exact pose control and dedicated relighting need separate profiles |
| Planner | Vision plus schema-constrained output on the interaction computer | Paired-computer planning would require its own explicit privacy contract |
| Renderer | Managed ComfyUI on this computer or the user's explicitly selected paired compute computer | Arbitrary external ComfyUI servers cannot satisfy the initial integrity and deletion contract |
| Hardware | Target: Windows + NVIDIA, 8 GB VRAM and 16 GB system RAM, subject to Step 0 measurements | Higher-memory profile; other operating systems after separate validation |
| Adult-content support | Enabled only when the age, consent and output-check release gate passes | An ordinary-editing milestone must not be reported as satisfying this source requirement |

`TextEncodeQwenImageEditPlus` exposes three image inputs. Count the target within that limit. Reject a fourth image before planning; never silently drop it or stitch a reference sheet. A four-image branch needs its own role-isolation and quality evaluation. [ComfyUI node documentation](https://docs.comfy.org/built-in-nodes/TextEncodeQwenImageEditPlus)

### Non-negotiable execution rules

- Keep image bytes, edit requests, planner output and sensitive follow-up history off hosted inference throughout this flow, including the outer chat that chooses a tool.
- Treat **on this computer** and **on the selected paired computer** as distinct placements. Rendering on a paired computer transfers inputs there; show that destination using the existing compute UI. An unavailable destination stops the job.
- Never substitute another checkpoint, hosted provider, workflow or reduced input set to recover from failure.
- Use trusted, versioned profiles. The model controls semantic edit intent only.
- Ask one focused clarification when intent is ambiguous; do not render while waiting.
- Publish no generated preview, thumbnail, gallery entry or downloadable output until its required checks pass. Local selection/crop/resize previews can use the user's source image or an already approved result.
- Make retained inputs, derived files and sensitive run records deletable together, with failures visible and retried.

## 2. Product experience — an image editor with versions

Open the editor from an attached image or an approved result. The user sees their image immediately, can describe a broad change or point to a specific area, chooses a compatible model and number of versions, then compares the results without losing the original.

### A. Image-first workspace

- Use a large central canvas with fit-to-screen, zoom and pan. Keep the application's existing visual language, a quiet neutral canvas surround and a checkerboard only where transparency exists. Editing controls should leave the image as the dominant element.
- Put the current version, undo/redo, Compare and Export in a compact top bar. Keep the original and approved versions in a thumbnail strip below the canvas, with clear selected, generating and failed states.
- Put editing tools beside the canvas and contextual controls in one side panel. The primary tools are **Whole image**, **Point edits**, **Remove**, and **Crop / Resize**. On smaller screens the panel becomes a bottom sheet, preserving canvas position and draft edits.
- Keep the prompt, **Model**, **Versions: 1 / 2 / 4**, supported quality preset and **Generate** together. Advanced controls stay collapsed. Explain disabled actions beside the relevant control instead of showing a generic error after submission.
- Keep drafts when the user switches tools or compares results. Never overwrite the original. Before generating, show a compact summary of the source version, whole-image instruction, active local notes, model, dimensions and version count.
- Support keyboard focus and labelled controls. Point notes must also be editable in a numbered list; precise editing cannot depend on pointer input alone. Pan/zoom gestures must not accidentally add notes.

### B. Multiple versions of the same image

**Generate 4 versions** means four independent candidates from the same selected source, references, instructions, masks and settings, with different recorded seeds. It does not mean applying the edit repeatedly to its own output. The number of output versions is independent of the three-input limit.

- Default to one version; offer two or four explicitly. Show an estimated total duration only when supported by measurements, including queue and model-loading time.
- On the low-memory profile, run candidates sequentially with model batch size one. Plan intent once, reuse the immutable validated plan and check each generated output before publishing it.
- Give the batch a parent ID and each candidate a stable child ID, seed, status and output record. Show progress such as “Version 2 of 4.” A failed candidate does not erase completed candidates or restart the batch.
- **Make more** keeps the same source and edit settings with fresh seeds. **Edit this version** makes the selected result a new source. **Retry failed** retries only the selected failed child using its recorded settings; a policy-blocked child cannot be retried this way.
- Let users compare two versions at matching zoom, compare with the source, mark favorites, remove one candidate, and export selected approved results. Retain parent/source links so the history explains where each version came from.
- **Cancel remaining** stops the active candidate and queued siblings while retaining already published candidates. Conversation deletion instead revokes the entire batch and its retained artifacts.

### C. Two ways to express an edit

| Mode | Interaction | Execution promise |
|---|---|---|
| **Whole image** | Type “make the lighting warmer” or “change the scene to winter” | Apply a broad instruction to the selected image; preservation remains subject to the general-edit profile's limits |
| **Point edits** | Tap/click an area, add a numbered note such as “make this bag blue,” and adjust the selected region | Tie each note to an explicit region and use a validated masked-edit branch; show the effective editable area before generating |

A tap locates an intention; it does not define an exact object boundary. Create a visible adjustable selection around the point. Allow brush and rectangle refinement with add/subtract controls and brush size. If a validated segmentation model is available, offer **Select object** to propose a mask that the user can inspect and correct. A point alone must never be presented as an exact mask.

Keep notes in a list linked to their markers. Users can edit, disable, move or delete a note before applying changes. Show a translucent mask overlay on demand. Start with at most eight active notes per edit; overlapping masks with conflicting instructions require resolution before generation.

For the first regional implementation, each candidate applies active notes in the visible list order, one masked pass per note. Intermediates remain private and receive required checks before reuse. Show that four versions with three notes require up to twelve edit passes; avoid pretending this costs one render. Any future profile that handles several regions in one pass needs separate validation.

Provide **Keep everything outside the selection** for the masked branch. Enforce it through compositing against the source, using the displayed effective mask, including feathering. Verify unchanged pixels outside that mask at the same working resolution before lossy export. This control is unavailable for whole-image edits; a prompt instruction alone cannot guarantee it.

Whole-image and point instructions may coexist, but their order must be explicit: apply the whole-image stage first, then let the user inspect the approved result and confirm/reposition local notes before regional generation. Do not reuse coordinates blindly after the scene or composition changes.

### D. Resize, crop and remove

| Tool | User controls | Behavior |
|---|---|---|
| **Crop** | Freeform or aspect-ratio presets; draggable frame | Deterministic crop with immediate local preview and undo; no generative model needed |
| **Resize** | Width, height, aspect lock; fit or fill | Deterministic resampling; explain that increasing pixel dimensions alone does not restore detail; show any crop/padding before applying |
| **Remove and fill** | Select/brush an area; optional fill instruction | Masked inpainting reconstructs background in the selected area; uses the chosen compatible model |
| **Erase to transparency** | Select/brush an area; edge feather | Deterministic alpha removal; show checkerboard and preserve transparency on export |
| **Expand canvas** — U3 | Drag a canvas edge or choose a larger aspect ratio | Outpainting generates new content outside the original; requires a separately validated profile |

Default aspect presets: Original, 1:1, 4:5, 3:2, 16:9 and custom. Validate requested dimensions against image-memory limits and the selected generative profile. If a model needs aligned dimensions, show the proposed adjustment rather than silently changing the user's size. Keep explicit destructive aspect stretching out of the default resize behavior.

Crop, resize and erase-to-transparency should remain usable without an installed generative model. Save each applied transform as a new version. Keep selection undo/redo separate from deleting generated results. If exporting transparency to JPEG, require an explicit background color or offer PNG; never silently replace transparent areas with black.

### E. Model picker and useful controls

The visible **Model** picker selects the model that edits the image. The local vision planner remains an advanced setting with its own eligibility checks; the user should not have to choose two models for every edit.

- Each editing-model row represents a verified execution profile: friendly model name, exact version in details, supported operations, input limit, measured memory requirement, installed/available state and rendering computer. Use measured speed/quality descriptions; do not invent rankings.
- Filter by the current operation and selected input count. Keep unavailable choices visible with a reason such as “Needs installation,” “Does not support selected-area edits,” or “Needs more memory.” Installation is a separate explicit action and preserves the draft.
- Persist the user's explicit selection. If it becomes unavailable or incompatible, explain why and require a new selection; do not replace it automatically. Changing the model leaves images and notes intact, highlights incompatible controls and shows any proposed dimension/settings changes before generating.
- Basic controls are output size/aspect, version count and only quality presets actually supported by that profile. A **Change amount** control appears only when a verified setting implements it; do not map arbitrary UI sliders to pretend precision.
- Advanced controls may expose seed/reuse-seed and profile-approved step ranges. The user chooses supported values through trusted UI/configuration; the planner cannot change them. Graph structure, file paths and artifact hashes remain protected.

### F. Editor data and execution contracts

Keep editable drafts as conversation-owned private records, separate from optional diagnostic logs. A draft stores its source attachment/version, selected references, whole-image instruction, region IDs and notes, masks, requested transform, chosen profile, supported settings and version count. Saving a draft does not queue a render. Include drafts, masks and version lineage in deletion and recovery.

- Store point/shape coordinates in normalized source-image space after orientation correction, bound to a specific source version and its dimensions. Convert through zoom, pan, crop and display scaling; do not save viewport pixels as image coordinates.
- Masks are core/plugin-created artifacts with their own IDs, source version, dimensions and checksums. Validate ownership, bounds, dimensions, decoded size and nonempty coverage. Stage masks with the image on paired compute, without counting masks as reference photographs.
- Extend the trusted envelope with `source_version_id`, `operation`, selected `profile_id`/version, validated UI settings, region/mask bindings, `variant_count`, and batch/child IDs. Core generates seeds unless the user explicitly supplies a valid supported seed. The model never supplies these controls.
- Keep the foundational `ImageJob` at `1.1`. U2 introduces negotiated `1.2` regional output, adding references to trusted region IDs and bounded per-region instructions. The model may interpret note wording but cannot invent or move masks. Reject unsupported schema/operation versions instead of flattening local notes into a whole-image prompt.
- Dispatch crop/resize/alpha-erasure through deterministic image operations; dispatch general edits, inpainting and eventual outpainting through their approved graphs. A common lifecycle owns artifacts, version history, cancellation and publication. Each child job has an explicit expected output count.
- On changing the source version, keep a copy of draft note text but mark geometric selections stale. Require reconfirmation after re-positioning; reopening a resized display of the same source must preserve correct alignment.

## 3. Repository findings and integration constraints

Use symbols rather than current line numbers as implementation anchors.

| Existing code | Verified behavior | Consequence for this plan |
|---|---|---|
| `packages/core/src/serve.ts`: `documents()`; `attach.ts`: `receive()` / `discard()` | Image uploads become data URLs, then the temporary files are discarded | Add durable attachment records; retaining the temporary path alone is insufficient |
| `packages/core/src/store.ts`: `Message`, `Part`, `append()` | Image data URLs live in persisted message content and are replayed with history | Deletion and privacy must cover message bodies and future replay as well as files |
| `serve.ts`: plain `sample` callback | Converts MCP image blocks, but its `route()` call does not pass image modality | Reuse `store.ts`'s `carries()` helper; cover both plain sampling and the tools-enabled path |
| `provider.ts`: `ChatRequest`, `chat()` | No schema-output field is forwarded to the completion request | Add a typed contract through sampling, routing and provider serialization |
| `plugins/media/render.js`: `renderer()` | Workflow plans bind `{node, input, path}` images, check node availability, queue and download | Reuse transport, but extend the render boundary for profile verification, quarantine and cleanup |
| `plugins/media/compute.js`: `split()` | Input files can be staged on the selected computer; same-process progress can include previews | Pass every bound input through compute staging; filter preview payloads before they reach UI or transport |
| `plugins/media/index.js`: `connect()` | Local planning can use a user-configured server without `tidy`; worker rendering supplies `tidy` | Existing local execution does not guarantee deletion from ComfyUI |
| `plugins/media/index.js`: `look()` / readiness path | Treats an empty checkpoint list as unavailable | A profile using separate diffusion/encoder/VAE files needs profile-specific readiness, even when `models/checkpoints` is empty |
| `plugins/media/models.js`: `fetchModel()` | New downloads are size-checked; an existing nonempty file short-circuits validation | Hash-check existing files, resumed downloads and final files, not just new downloads |
| `plugins/media/library/tasks.js`: `edit` | Qwen 2509 is listed at 22 GB VRAM; a smaller Flux entry is explicitly estimated | Catalogue estimates do not prove the required Qwen profile fits 8 GB / 16 GB |
| `plugins/media/plugin.json` | Declares `runs`, `image.generate`, `image.render` and compute lifecycle hooks | Extend the existing media plugin; do not introduce a competing capability provider |
| `packages/core/src/surface.ts`: conversation deletion | Calls `store.deleteSession()`; database message rows cascade | Add attachment/run cleanup to the lifecycle, including deletion outside the active chat |

D124 in `Alexia.md` concerns competing plugins claiming the same capability. Keep `generate` as the existing `image.generate` entry point; expose `edit_image` as a tool in that same plugin without an ambiguous second binding. Core additions must remain generic attachment, routing and lifecycle facilities, with image-role logic in the media plugin.

## 4. Step 0 — Prove one complete execution profile

**Dependency:** profile-dependent implementation follows this spike. Repository inspection and contract design can proceed independently. No model downloads or benchmark runs are part of this Markdown-only revision.

The low-memory default is a target, not a selected or proven model. Evaluate one exact Qwen edit build at a time. A compatible quantized build is a candidate; neither “GGUF” nor “int4” establishes memory use, edit quality, licensing or the required adult-content behavior. Do not assume that a standard quantization is equivalent to the source's requested fine-tune. The [ComfyUI-GGUF project](https://github.com/city96/ComfyUI-GGUF) supplies a loader route, not an 8 GB / 16 GB acceptance result.

The [Rapid AIO repository](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO) named by the source remains a candidate for a higher-memory profile. Its exact revision, artifacts and settings must be verified before selection. Do not hard-code an unverified v23 filename or call a model “abliterated” without author documentation.

### Required spike record

For each candidate, record:

- Model repository and immutable revision; exact filenames, byte sizes, SHA-256 values, provenance and applicable licenses for the diffusion model, text encoder, VAE and any LoRA.
- ComfyUI revision, custom-node revisions, Python/PyTorch/CUDA versions, GPU, driver, OS and physical system RAM.
- The exported API graph, graph digest, actual loader classes, prompt syntax and ordered image bindings. Separate UNet/encoder/VAE loaders and AIO loaders are different profile implementations.
- Quantization, offload behavior, launch flags, image preprocessing, supported dimensions, maximum input count, batch size, seed range, sampler, scheduler, steps and CFG. Verify any Lightning LoRA against that exact base and loader.
- Peak GPU memory and host RAM for the **whole application**, disk/pagefile use, cold-start latency, planner latency, render latency and total request time. File size and seconds per sampler step are insufficient.
- One cold and three consecutive warm runs for each supported input count at the proposed default resolution, plus the largest permitted resolution. Record role adherence, identity drift, unintended style transfer, OOMs, cancellation and cleanup.
- Before U1, measure a four-version sequence with no concurrent diffusion batches. Before U2, repeat the relevant measurements for the masked-edit profile and a multi-note request, including mask processing, intermediate checks and compositing. A whole-image profile benchmark does not validate those operations.

Plan around a GPU lease: finish local planning, release its model when it shares the render GPU, run preflight checks, render one job at a time, then release render resources before any post-check model needs them. Include model unload/reload time and policy-model memory in measurements. Do not terminate a user's unrelated model process.

**Exit gate:** one profile completes the measured matrix on the target machine without OOM or reliance on unreported swap, within an explicit total-job timeout chosen before benchmarking. Record available memory headroom and whether paging is required. If the profile cannot meet 8 GB / 16 GB, report that result and revise the hardware or model requirement; never relabel the profile as supported.

The future deliverables are `edit/profiles.js`, a fixed graph fixture and a benchmark record. Leave the low-memory profile unavailable until those artifacts contain real measurements. Higher-memory profiles require their own gate.

## 5. Step 1 — Durable, scoped image attachments

### Storage and naming

- Add a core-owned attachment record: opaque ID, conversation ID, message/request ID, user-visible ordinal, original display name, validated MIME type, dimensions, byte count, generated storage name, creation time and retention state.
- Store normalized editing inputs under `dataDir/uploads/<conversationId>/<opaque-id>.<validated-extension>`. Filenames and model text never determine paths. Keep the target's aspect ratio; make resizing explicit and profile-controlled.
- Enforce current upload byte/count limits plus decoded-pixel and format limits before expensive decoding. Check bytes against MIME, handle orientation, strip unnecessary metadata and reject unsupported animation or malformed images. The existing UI already resizes some uploads: define which normalized bytes are the editing source, and derive any smaller planner view separately from those bytes.
- Give images stable conversation labels (`image_1`, `image_2`, …), never recycled after deletion. Keep the model's visible label beside each image and show the same label in the composer/history. Resolve the user's “image 2” from the displayed selection, rather than assuming the second image in a later turn has the same identity.
- Bind each edit request to an immutable ordered selection of attachment IDs. Validation uses membership in that selection, **not** an `image_N <= N` check: valid labels can be non-contiguous. Historical images can be explicitly selected from the same conversation; other conversations are inaccessible.

### Tool handoff

Add a generic, declared attachment-input facility to the tool dispatch contract. Only fields explicitly declared as attachment references are resolved; never recursively replace every string that resembles `image_1`.

The model-facing `edit_image` arguments are `{ request: string, images: string[] }`. Core validates them against the active conversation and selection, then provides the plugin an ordered attachment map in trusted call context. The plugin receives only authorized resolved files; the model receives no raw paths. Keep labels in arguments and logs rather than rewriting them into paths. Define this context in the protocol/SDK before implementing either side, including calls outside a chat: absent conversation context is an error, not a global lookup.

Canonicalize resolved files, check directory containment and prevent symlink escape. Pin inputs for the run so replacement or deletion cannot silently change the bytes after validation. `compute/interaction.ts` already allows the uploads root for staging, but that filesystem permission is not conversation authorization.

### Retention and deletion

Prefer attachment references in persisted messages and materialize data URLs only at the provider boundary. Preserve compatibility with existing inline-image messages; migration must not require a model call.

“Forget pictures in this chat” and conversation deletion must:

1. Revoke handles and cancel dependent queued/running jobs before publication can race deletion.
2. Remove source images, planner derivatives, thumbnails, linked outputs and sensitive debug records owned by this flow.
3. Remove inline image data from legacy messages, clear live conversation/UI caches, and prevent later history replay or summary generation from reusing deleted image content. Remove image-derived summaries maintained by this flow as well.
4. Schedule cleanup of managed ComfyUI input/output/temp files, workflow history and paired-worker staging; record pending cleanup if a host is offline.
5. Recover interrupted cleanup after restart and collect orphan files left by partial upload or database failure.

Document the boundary: deleting app-managed copies does not erase user-exported copies, backups or storage hardware remnants. Do not retain original uploads in a second hidden location. Generic text/document attachment behavior must keep working.

**Exit gate:** attachments survive reload and clarification, remain conversation-scoped, and deletion prevents reuse on both local and paired paths.

## 6. Step 2 — Private vision and structured sampling

### Enforce privacy before inference

A local-only planner is insufficient if the outer chat first sends the user's images to a cloud model to choose `edit_image`. Apply the privacy constraint when the editing request enters core, before any model sees the request or image bytes.

For the first release, turns entering this retained-image editing flow use local vision from the outset, and conversations containing that private edit context retain the restriction on follow-ups. The UI must identify this placement before submission. If editing intent has not yet been determined, resolve it locally; cloud inference cannot be the classifier that decides whether an image was private. Ordinary cloud vision outside this flow needs a distinct, explicit user choice and must not reuse private edit context implicitly.

The planner always runs on the interaction computer. Rendering may use the already selected paired compute computer. Enforce the distinction using actual execution-target metadata: a provider being named “Ollama,” or answering on localhost, is not enough to establish on-device inference. Ollama's local server can also access cloud models. [Ollama compatibility documentation](https://docs.ollama.com/api/openai-compatibility)

### Sampling contract

- Add an optional schema field to `ChatRequest` and a documented sampling metadata contract, provisionally `_meta['alexia/format']`. Core bounds schema size/depth and accepts only its supported JSON Schema subset; no remote `$ref` fetching.
- Serialize the supported Ollama-compatible request as `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`. Ollama documents schema output through `response_format`; the exact pinned version/model, schema subset and streamed response still need an integration test. Native `/api/chat` uses `format`; do not send that native field to `/v1/chat/completions`. [Structured output documentation](https://docs.ollama.com/capabilities/structured-outputs)
- Pass `modality: carries(asked)` into routing. Cover both ordinary sampling and any tools-enabled sampling path rather than fixing only one caller.
- Add a hard per-request placement constraint, provisionally `_meta['alexia/local']`, whose defined meaning is **interaction computer only**. `modelPreferences` remains a preference and cannot enforce privacy.
- Filter all initial candidates, retries, hedges and fallbacks against vision, structured-output support and placement. Preserve existing user pins; report incompatible constraints rather than silently overriding them.
- Restrict the planner to one completion without tools or automatic conversation inclusion. Send the exact request, the selected ordered images, the schema and any explicit clarification answer. Treat text embedded in images as untrusted content.
- Propagate output-token limits, cancellation and a total deadline. Partial JSON from a cancelled or truncated stream cannot become a job. Unsupported schema output is an actionable capability error; never silently downgrade to unconstrained prose.
- Fail before sending private content if a required capability is missing. New privacy metadata cannot be an optional hint an older core ignores: advertise support and require a compatible protocol version before enabling the tool. Update protocol constants, SDK types and conformance coverage together.

**Exit gate:** request-capture tests prove image-bearing planning and its outer chat/retries never contact hosted providers, including Combined mode, unavailable local models and unsupported schema output.

## 7. Step 3 — Define the job and clarification contracts

### Trusted envelope versus model output

Core/plugin code creates the run ID, conversation/selection binding, original request, placement, profile version, seed, deadlines and policy state. Explicit UI choices such as the editing model, supported settings, dimensions and version count enter this envelope only after validation. None of those values are writable through `ImageJob`. Direct editor actions use the same validated backend as chat; the UI cannot bypass the profile or attachment checks.

Define `AlexiaImageJob` version `1.1` in `edit/schema.js`, requiring every field below and rejecting unknown keys at every object level. Nullable fields remain present with `null`. Use one schema as the planner contract and structural-validation source; keep cross-field checks in `validate.js`. Follow existing validation tooling and avoid an unreviewed second schema dialect or unnecessary dependency.

| Field | Contract |
|---|---|
| `schema_version` | Exactly `"1.1"`; unknown versions stop |
| `action` | `image_edit`, `image_generate` or `inpaint`; `1.1` executes `image_edit`; U2 enables `inpaint` only through the negotiated `1.2` regional contract and a compatible profile |
| `target` | One selected image handle for executable edits; `null` permitted only for a non-executable clarification or generation classification |
| `instruction` | Bounded plain-language change description preserving details that roles cannot express, such as a color or object removal; interpreted only as prompt text |
| `references` | Unique selected image handles with nonempty unique approved `roles` and finite `strength` in `[0,1]`; the target can also supply roles |
| `preserve` | Unique values from the approved role vocabulary, interpreted relative to the target |
| `exclude` | Unique `{ image, role }` pairs, both validated; replaces the source's free-form strings |
| `output_style` | Bounded plain text or `null` to retain target style; cannot choose execution settings |
| `needs_clarification` | Boolean; `true` always prevents execution |
| `clarification_question` | One bounded, nonempty question when clarification is needed; otherwise `null` |
| `confidence` | Finite number in `[0,1]`; below `0.6` requests clarification, never establishes correctness or safety |
| `content_rating` | `sfw`, `suggestive` or `explicit`; planner hint only |
| `named_real_people` | Bounded list of names explicitly present in the request/context; never ask the model to identify someone from their face; an empty list is not evidence of consent |

Approved roles: `identity`, `face`, `hairstyle`, `expression`, `body`, `clothing`, `accessories`, `pose`, `composition`, `camera_angle`, `framing`, `lighting`, `background`, `color_palette`, `art_style`, `texture`.

Normalize the source's `facial_features` and `body_proportions` preservation concepts to `face` and `body` in this version. The compiler expands those roles into precise preservation wording.

Proposed initial bounds: request text 8,000 characters, including global and local notes; `instruction` 4,000; `output_style` 200; clarification question 300; at most three references, 16 roles per reference, 16 preservation roles, 48 exclusions and eight names of 120 characters each. U2 allows at most eight active regions and 600 characters per region instruction. Use empty arrays when no assignment applies. Cap the planner response at 32 KiB before parsing; excess input/output is an explicit error, never silently truncated. Keep these bounds and the supported schema subset in one contract.

### Semantic validation

- Every target, reference and exclusion must belong to the immutable selected-input map and still be available.
- Exactly one target for executable edits. Human-subject identity edits have one primary identity source; object and landscape edits do not invent an identity assignment. Preserve target identity by default where applicable; changing identity requires explicit user intent. Identity blending is unsupported in this version.
- A role cannot be copied from conflicting sources or simultaneously preserved and replaced. An excluded `{image, role}` cannot also be assigned. Resolve ambiguity with a question, not last-write-wins ordering.
- Do not infer identity transfer from clothing, pose or lighting references. An explicit target or role instruction outranks image order.
- Define `strength` honestly: zero disables that reference's role contribution; positive values are semantic emphasis until a profile supports measured numeric weighting. The target is still loaded even if its reference contribution is zero. Report unused selected references, and never describe strength as exact blend control.
- Preserve the user's actual permitted edit intent, including details absent from the role list, in `instruction`. Keep the original request in the trusted envelope for policy checks and evaluation. Neither schema validity nor model confidence proves semantic fidelity.
- Reject paths, URLs, node definitions, checkpoint names and protected settings as execution fields. Text that looks like a command remains text and is never evaluated.

### Planner outcomes and follow-up

`planner.js` returns one of `ready`, `needs_clarification`, `unsupported` or `failed`, with a stable reason code. Policy produces a separate `blocked` outcome; it is not a planner-controlled flag.

Retry malformed JSON or schema-invalid output once using bounded validation errors, the same schema, the same images and the same placement. Do not use repair retries for policy blocks, unavailable models, unknown handles or genuine ambiguity.

Persist a small pending request bound to the conversation, original request and exact selection. A reply such as “only the outfit” resumes that request without requiring another upload. New image selections supersede the old pending request explicitly. Cancellation, deletion or expiry invalidates it. A low-confidence result with no useful question gets a deterministic focused question; it does not render.

## 8. Step 4 — Compile, render and publish through a fixed path

### Module responsibilities

| New file under `plugins/media/edit/` | Responsibility |
|---|---|
| `schema.js`, `validate.js` | Structural contract, semantic invariants, supported action and role checks |
| `planner.js` | Private sampling, bounded repair and clarification outcomes |
| `compile.js` | Pure deterministic instruction construction and semantic preservation/exclusion wording |
| `profiles.js` | Versioned trusted artifact manifest and supported limits; no guessed hashes or measured claims |
| `graph.js` | Fixed graph construction and exact image-slot mapping for each approved profile |
| `safety.js` | Policy orchestration over independently validated evidence; model hints never grant authorization |
| `run.js` | Lifecycle, cancellation, compute handoff, quarantine, output checks and atomic publication |
| `log.js` | Run status, reproducibility metadata and privacy-aware diagnostic retention |
| `variants.js` | Immutable batch snapshot, child seeds/status, sequential scheduling and version lineage |
| `regions.js` | Source-bound points/masks, per-region instruction validation, ordered edit passes and compositing |
| `transforms.js` | Deterministic crop, resize and alpha erasure with dimension/format validation |

### Deterministic compilation

Use a fixed role ordering and a single shared mapping from conversation handles to graph image slots. Put the target in slot 1; order other contributing images deterministically by the request selection. A target named `image_7` can therefore become graph slot `image1`. Rewrite every textual reference through that same mapping; do not concatenate labels independently of the graph. Inputs with no active contribution are not loaded unless they are the target; omit their exclusion clauses instead of referring to nonexistent slots, and report that they were unused.

Compile the requested changes, target-preservation clauses, reference-role clauses, exclusions and output style. Explicitly exclude unassigned identity/face/body/style transfer where applicable. Use only the prompt syntax verified in Step 0. Preserve permitted user wording without introducing sanitization or executable interpolation. The same normalized job and profile version must produce the same prompt and graph topology.

The seed and settings come from the trusted run envelope and profile, including validated user controls, never the planner. Record the seed for replay; identical seeds do not guarantee identical pixels across hardware or runtime versions. Variants reuse the same normalized job and source snapshot; only their recorded seeds differ. Multi-pass regional variants additionally record the derived seed of each pass.

### Trusted render boundary

1. `edit_image` validates input count, context, availability, request limits and runtime/protocol support.
2. Resolve planning and clarification, validate the job and run input/request policy checks before transferring images to ComfyUI.
3. Build a versioned edit render plan. On the selected render computer, verify profile identity, local artifact hashes, required node definitions and approved graph structure **before upload or `/prompt`**. Reconstruct the graph from trusted profile data, or compare it against the approved template; never accept an unrestricted graph because it is syntactically valid.
4. Reuse `compute.run()` and the renderer's upload/queue/progress/download primitives. Every resolved input must also appear in compute `inputs`, using the existing `picture(path)` staging pattern. Controller paths must never be sent as usable paths on a paired computer.
5. Give the edit path a dedicated trusted plan discriminator and version. Negotiate worker support before dispatch: the current renderer treats unknown kinds as ordinary picture plans, so never send an edit plan to a worker without advertised support. A compatible worker rejects unknown edit-plan versions, verifies the plan and returns executed profile/graph metadata. It must not fall through to the existing `picture` branch or its default checkpoint selection.
6. Download results into a per-run private quarantine directory. Check expected image count, decoded format, dimensions and file size; reject unexpected extra outputs. A version batch expects one final image per child, not an unrestricted multi-output graph. Regional passes keep intermediate files private and check them before reuse. Run output policy and any validated quality checks on the final composited image before exposing a file reference.
7. Atomically mark the run complete and publish approved outputs through `alexia.file()`. Only then create gallery records and thumbnails. Register outputs as new conversation attachments when the user wants another edit.

`/object_info` describes node types and their inputs; it is **not a model-file checksum API**. Use it for compatibility, and verify model bytes on the managed render host. [ComfyUI server routes](https://docs.comfy.org/development/comfyui-server/comms_routes)

### Installation and runtime ownership

- Extend library/setup to install immutable profile artifacts into Alexia-managed ComfyUI through the existing install flow. No downloads or custom-node installs during an edit request.
- Extend `fetchModel()` to verify SHA-256 before final rename and when considering an existing file reusable. Hash the complete resumed file; a mismatch is not a valid resumable checkpoint. Keep failed files unavailable and report the specific artifact.
- Cache verified inventory only with explicit invalidation on replacement or profile/runtime changes. Before use, detect changed files and reverify; a filename match never authorizes a checkpoint.
- Use `launch.js`'s existing `args` facility for measured profile flags. A process already running with incompatible flags is not fixed by changing a setting; use the managed lifecycle to reconfigure it once idle. Do not restart or modify a user's unrelated ComfyUI.
- Require a managed server for this flow's checksum and cleanup guarantees. A configured arbitrary server gets an explicit unsupported-server error rather than weaker silent behavior.
- Separate server reachability from profile readiness. A split-loader Qwen profile can be ready with no single-file checkpoints installed; its checks must inspect the pinned diffusion, encoder and VAE artifacts rather than reuse the generic `look()` checkpoint requirement.

## 9. Step 5 — Policy checks with an honest assurance boundary

The source's policy requirements apply before rendering and before publication. They must be independent of prompt wording and planner assertions. A trusted implementation can enforce “do not proceed without required evidence”; it cannot turn uncertain model predictions into certainty about people.

### Evidence and decisions

- Assess request text and every selected input before rendering, including references used only for clothing or lighting. Assess all outputs before publication. A planner's `content_rating` and `named_real_people` are hints; neither may lower independently assessed risk.
- Keep content rating, age uncertainty, identity evidence and consent authorization as separate values. Do not infer consent from a low NSFW score or adulthood from a missing face.
- Missing, failed or inconclusive checks stop the affected job. Support clear internal reasons such as `age_uncertain`, `consent_missing`, `policy_unavailable` and `output_blocked`, with plain user messages.
- Local face detectors, embeddings, age estimators and content classifiers are candidates to evaluate. Do not select SCRFD, ArcFace, an age model or `onnxruntime-node` as a proven complete solution without checking model/runtime licenses, supported platforms, memory, calibration and failure modes.
- Age estimation is not age verification. The earlier blanket “estimated under 25” threshold is not a defensible release criterion without evaluation. Cover underage-looking, stylized, occluded, multiple-subject and no-face cases; uncertainty cannot count as adult evidence.
- Face similarity is not consent, and identity can be carried by more than a face. A name supplied by the planner is not an identity registry.

### Consent design is a release blocker for sensitive identity edits

Specify how an adult gives informed, scoped consent, how that authorization binds to the depicted person and intended edit, when it expires, and how revocation affects pending jobs and retained data. An owner's assertion or a single camera frame alone does not establish those facts.

If biometric enrollment is selected after this review, it needs an explicit data lifecycle, spoof-resistance evaluation, encrypted local storage, access control, revocation and tested handling of false matches. Discard capture images unless retention is specifically required and explained. Validate the actual secret-storage bridge; `vault.rs` existing does not establish that the media plugin can safely store embeddings through it.

Do not make enrollment a prerequisite for ordinary non-sexual edits. Do not enable sensitive identity editing until its consent and age design has a reviewed acceptance suite. This is an unresolved source requirement, not something a stub classifier can satisfy.

### Publication and bypass boundaries

- Suppress binary preview images at the earliest render/progress boundary for all jobs in this flow. Numeric progress and stage text remain available. Removing a final output does not retract a preview already shown.
- Quarantine output files and scrub embedded workflow/prompt metadata from deliverable images where it would expose private requests. Keep required reproducibility records separately under the retention policy.
- Recheck consent revocation, conversation deletion and cancellation immediately before publication. A denied output is removed from quarantine and all managed render/staging locations.
- A blocked edit cannot be retried automatically through `generate`, a saved arbitrary workflow, a capability call or another compute operation. Carry the policy decision through the agent/task boundary and test those alternative entry points. If the product claims these rules for **all** Alexia image operations, apply shared enforcement to those paths before making that claim.
- The assurance boundary is Alexia's supported execution paths and managed runtime. Do not claim that application code can prevent an owner from modifying a local installation or independently using another renderer.

**Exit gate:** approved decision rules, evaluated local dependencies and request/input/output tests, including uncertainty and bypass cases. Passing only tests with mocked classifiers proves orchestration, not real-world detection accuracy.

## 10. Step 6 — Lifecycle, errors and diagnostics

Model runs explicitly: `received → planning → validating → checking_inputs → queued → rendering → checking_output → completed`. Terminal alternatives are `needs_clarification`, `unsupported`, `blocked`, `failed` and `cancelled`. Every transition belongs to a stable run ID; retries get attempt IDs.

Version batches aggregate these child states and distinguish complete success, partial completion and cancellation. The batch's immutable source/draft snapshot cannot change when the user edits the live draft. Publish each approved child as it finishes, retain the requested slot order, and attach a later retry to its existing slot instead of generating duplicate thumbnails. Deterministic crop/resize/alpha operations bypass model planning and rendering while retaining validation, version creation and artifact publication checks.

| Condition | Required behavior |
|---|---|
| More than supported inputs, missing/deleted image or wrong conversation | Stop before planning/transfer and identify the correction |
| Invalid JSON/schema | One repair attempt, then `planner_invalid`; no render |
| Ambiguous/conflicting roles or low confidence | One focused question; preserve the pending selection |
| Unsupported action or exact control requirement | Explain the limitation; no silent substitution |
| Selected model does not support the operation or output size | Keep the draft, explain the incompatibility and ask the user to choose compatible controls; no model switch |
| Region belongs to another source version or is empty/out of bounds | Stop before planning/rendering and highlight the invalid selection |
| No private vision/schema-capable planner | Stop with local setup guidance; no hosted fallback |
| Missing/mismatched profile, node pack or artifact | Stop before image upload; identify the required installation |
| Policy block, unavailable check or uncertain required evidence | Stop; no policy retry or alternate tool route |
| OOM, timeout or ComfyUI execution failure | Stop, release resources and clean partial files; no automatic quality/profile downgrade |
| Lost connection after submission | Reconcile the recorded prompt/job ID; do not blindly submit another render |
| Identity/pose/clothing drift | Report the limitation or ask for a revision; automatic retry only after a detector and retry branch are validated |
| User cancellation, deletion or consent revocation | Cancel this job, suppress late output and clean up; leave unrelated jobs alone |

Use one propagated cancellation signal, phase deadlines and a bounded total deadline. Reuse job-specific ComfyUI cancellation; extend cleanup to failures during upload, submission, download and post-checking. The current renderer's upload work begins outside its queue/download cleanup block, so partial upload failures need coverage too. Record cleanup failures and retry them after restart. Do not report successful deletion while paired-host cleanup remains outstanding.

Reserve a run before queueing and record the render host, attempt and ComfyUI prompt ID as soon as known. Deduplicate retries of the same tool invocation. If a crash leaves submission status unknown, mark it for reconciliation rather than generating twice. After restart, an unfinished render must still pass output checks before publication.

Default `runs` metadata: run/conversation IDs, batch/child/source-version IDs where applicable, state, reason code, timestamps, phase durations, input attachment and mask IDs, planner model/runtime, schema/compiler/graph/profile versions, model artifact hashes, seed/pass seeds, actual settings, render destination and cleanup status. Avoid raw images, embeddings, absolute paths and sensitive prompts in operational logs or stderr. Editable note text and masks belong in the private draft store, not these operational logs.

The source asks to retain the full job and compiled prompt. Make that an explicit private diagnostic mode with defined retention and conversation-linked deletion; metadata-only logging is the proposed default. This is a deliberate privacy-related deviation from the source, and replay is available only while the required inputs and diagnostics are retained. Redact provider error bodies and ComfyUI history that would otherwise copy the prompt into logs.

## 11. Agent work sections and execution order

### How to use these sections

Assign one packet ID to one agent. Every packet states its result, owned files, dependencies, handoff and acceptance checks. New paths below are proposed implementation locations; none are created by this plan-only revision. File ownership applies only after the user authorizes that packet's implementation. Paths are repository-relative; brace groups enumerate the named files, and test wildcards reserve only the stated prefix.

Start **A00** first to settle the shared contracts, then use the wave table. A00 has two passes: initial contracts and later integration. Its integration pass depends on the feature packets; its initial contract pass does not. This avoids making every feature depend on a coordinator task that can never finish until those same features finish.

| Packet | Assignment | Milestone coverage | Required for requested editor? |
|---|---|---|---|
| A00 | Contracts, shared wiring and integration | M1/M2 contracts; M6 integration | Yes |
| A01 | Model profiles, installation and ComfyUI execution | M0 hardware; M4 | Yes |
| A02 | Attachments, source versions and deletion | M1 | Yes |
| A03 | Private vision routing and structured sampling | M2 | Yes |
| A04 | Intent planner, validation and compiler | M3 | Yes |
| A05 | Drafts, run lifecycle and multiple versions | U1 backend; lifecycle | Yes |
| A06 | Policy evidence, consent and publication checks | M0 policy; M5 | Yes, for the advertised scope |
| A07 | Editor workspace, comparison and model picker | U1 frontend | Yes |
| A08 | Point notes, masks and remove-and-fill | U2 | Yes |
| A09 | Crop, resize, transparency and export | U1/U2 deterministic tools | Yes |
| A10 | Integration tests and release verification | M6 verification | Yes |
| A11 | Canvas expansion and AI upscaling | U3 | Optional; separate assignment |

### Shared ownership rules

1. **One owner per file.** Work in separately authorized branches/worktrees where available. Shared checkouts still require the same ownership rules. Do not overwrite, revert or refactor another agent's changes.
2. **A00 alone edits shared wiring:** `packages/core/src/serve.ts`, `surface.ts`, `plugins.ts`, `toolFit.ts`; `packages/protocol/src/*`; `packages/sdk/src/*`; `plugins/media/index.js`, `plugin.json`; `packages/ui/src/main.ts`, `packages/ui/app.css`; package manifests, lockfiles, shared build/test configuration and project decision/protocol documentation. This includes the plan itself during future coordination. Feature agents provide the exports and exact integration notes A00 needs.
3. **Feature owners edit their modules and focused tests.** UI ownership is divided by directories below. A07 owns the editor shell; A08 owns `selection/`, A09 owns `transforms/`, A06 owns `consent/`, and A11 owns `extensions/`. A07 must not edit those reserved subdirectories.
4. **Dependencies are contracts first, implementations second.** Agents can build against approved interfaces and test doubles after A00's first pass. They cannot mark an end-to-end feature complete while its real dependency or hardware evidence is missing. Test doubles never become a production fallback.
5. **Contract changes go through A00.** Report the producer/consumer impact and proposed migration instead of independently changing a shared type. If an owned-file change is needed in another packet, send a precise integration request to that owner; do not broaden scope silently.
6. **Each handoff is reviewable.** Return changed files, public exports/events, test commands and actual results, assumptions, remaining blockers and required integration edits. Distinguish module completion from hardware verification and release readiness. No agent marks another packet complete.

### A00: Contracts and shared integration

**Checkpoint (2026-10-04):** first pass and integration pass both done — protocol 14 is now supported and enforced; see the Progress table at the top and the [contract doc](docs/spec/image-editor.md).

**Outcome:** feature agents can work independently against one set of interfaces, and their work ultimately becomes a functioning editor in the existing app.

**Read:** Sections 1–3, the envelope/schema requirements in Sections 5–8, and all packet boundaries here. **Own:** the shared files listed above; protocol/SDK contract tests and existing core serve/tool-dispatch wiring tests. Cross-feature acceptance tests belong to A10. Feature implementation remains with its named owner.

**First pass — complete before the main parallel wave:**

- Define the generic attachment call context; private/schema sampling metadata and version negotiation; profile descriptor and compatible-operation inventory; private editor draft/source/mask descriptors; run/variant commands and progress events; publication and deletion callbacks.
- Define the editor canvas/selection/transform component interfaces so A07–A09 share source coordinates, selected version and undo semantics. Freeze payload shapes, error codes, cancellation behavior and who persists each record.
- Preserve ownership: core owns attachment bytes/authorization; the media layer owns drafts, runs and result lineage; UI state uses those APIs rather than maintaining a second durable history. Define how deletion reaches all owners.
- Record accepted interfaces and extension points in the protocol/spec and this plan. Negotiate `1.1` versus `1.2` rather than designing two incompatible ways to submit edits.

A00 defines generic wire envelopes and negotiable capabilities; A04 remains the sole owner of the media-specific `ImageJob` schema. Do not duplicate that schema in core or create a second validator in the UI.

**Integration pass:** wire A02/A03 helpers into core, A04–A06/A08/A09 into media tools, and A07's editor entry point into the UI. Register capabilities, storage, dependencies and version requirements. Keep direct UI actions and chat on the same validated backend. Resolve cross-packet wiring defects with their owners.

**Handoff:** accepted contract names/shapes and small valid/invalid examples after pass one; connected application and exact dependency revisions after integration. **Done when:** consumers agree on contracts, incompatible versions fail before dispatch, and A10 verifies real UI-to-core-to-worker paths. Initial contract completion is a separate checkpoint from final integration.

### A01: Model profiles and rendering runtime

**Outcome:** a selected, verified profile executes on the chosen managed computer with correct bindings, bounded memory, cancellation and private output handling.

**Read:** Sections 3–4 and 8; model controls in Section 2E. **Own:** `plugins/media/edit/{profiles,graph}.js`; `plugins/media/{render,compute,comfy,worker,models,launch,install}.js`; `plugins/media/library/{tasks,setup,tools}.js`; focused `plugins/media/test/edit-runtime*.test.js`, `plugins/media/test/fixtures/edit-runtime/` and profile benchmark records under `plugins/media/edit/benchmarks/`. Shared registration and dependency changes go to A00.

**Work:** pin and benchmark artifacts; add inventory/hash checks and managed installation; support readiness without single-file checkpoints; negotiate worker versions; stage authorized images/masks; construct fixed graphs; suppress generated previews; quarantine downloads; cancel only the affected job and clean partial artifacts. Provide separate capability evidence for whole-image and masked editing.

**Dependencies:** A00's profile/render contracts. Hardware research may start earlier because it does not choose shared API shapes. **Handoff:** profile inventory, renderer interface, graph fixtures, measured limits and benchmark evidence for A05/A07/A08. A06 supplies policy decisions; this packet provides hooks and cannot replace policy with a boolean from the planner.

**Done when:** hash/version mismatch stops before upload, remote staging works, failure cleanup is tested, and actual hardware runs establish the advertised limits. Without target hardware, deliver the reproducible harness and label the hardware gate unverified; do not claim profile readiness.

### A02: Attachments, source records and deletion

**Outcome:** images survive reload and clarification, remain scoped to their conversation, and can be deleted without later reuse.

**Read:** Sections 5 and 2F. **Own:** `packages/core/src/{attach,store}.ts` and generic helpers under `packages/core/src/attachments/`; `packages/core/test/{attach,store}.test.ts` and `packages/core/test/attachment-lifecycle*.test.ts`. A00 owns the `serve.ts`/`surface.ts` insertion points.

**Work:** durable opaque records and stable labels; normalized image validation; authorized immutable selections; call-context resolution; pin/revoke semantics; legacy inline-image compatibility; image/mask/output registration; orphan cleanup and restart recovery. Expose deletion hooks that A05/A01 use for drafts, runs and paired cleanup.

**Dependencies:** A00's attachment/context and deletion contracts. **Handoff:** ingest, resolve, pin, revoke and cleanup APIs, source metadata, migration behavior and the exact chat/deletion wiring A00 must apply. A07 renders these stable labels; it does not own the underlying IDs.

**Done when:** tests cover non-contiguous labels, wrong-conversation access, malformed images, symlink escape, restart, pending clarification and deletion during a run. The lifecycle must expose pending remote cleanup truthfully rather than mark everything deleted while a host is offline.

### A03: Private vision and structured sampling

**Outcome:** the outer chat and planner use eligible local vision models with schema output, including every retry and fallback.

**Read:** Section 6. **Own:** `packages/core/src/{provider,router,sampling-policy}.ts`; `packages/core/test/{provider,router}.test.ts` and `packages/core/test/private-sampling*.test.ts`. A00 owns sampling metadata declarations and `serve.ts` wiring.

**Work:** schema serialization and bounds; modality propagation; actual on-device eligibility; hard request placement; conflict handling for user pins; supported-version errors; streaming completion checks; cancellation and token/deadline limits. Supply helpers for both sampling paths and for privacy enforcement before the outer chat's first inference request.

**Dependencies:** A00's sampling contract. **Handoff:** request/response handling, eligibility predicates and wiring instructions for A00; one tested sampling interface for A04. Keep media-role logic out of generic routing.

**Done when:** captured requests prove zero hosted calls for private image requests in Combined mode, after local failures, during hedging and on both sampling paths. Schema-unsupported and text-only models fail before receiving images. Ordinary schema-free provider calls still work.

### A04: Intent planning and deterministic compilation

**Outcome:** a request and selected images become a validated semantic job, one clarification or an explicit unsupported result.

**Read:** Section 7, compilation in Section 8, and the source request cases in Section 12. **Own:** `plugins/media/edit/{schema,validate,planner,compile}.js`; focused `plugins/media/test/edit-intent*.test.js` and `plugins/media/test/fixtures/edit-intent/`. A00 owns shared protocol exports and tool registration.

**Work:** implement `1.1` and the agreed `1.2` regional extension; bounds and cross-field rules; one JSON repair; explicit clarification outcomes; target/reference-role separation; source-to-graph-slot mapping; canonical prompt construction. Regional output references trusted region IDs from A08 and cannot alter geometry.

**Dependencies:** A00's schema/sampling interfaces. Use a stubbed sampler until A03 is integrated; regional contract fixtures can precede A08's UI. **Handoff:** schema and validator, planner outcomes, compiler exports, error codes and golden cases to A05/A08. A05 persists pending requests; do not build a second clarification store here.

**Done when:** all six interpretation cases pass, clarification never renders, conflicting/unknown references stop, protected execution settings cannot come from the planner, and identical normalized jobs produce identical compiled instructions. Include non-person/object edits and literal changes such as colors, not only reference-role examples.

### A05: Drafts, job lifecycle and image versions

**Outcome:** users can save an edit draft, generate 1/2/4 candidates, resume a clarification, retry a failed candidate and continue from a chosen version.

**Read:** Sections 2B/2F and 10; orchestration/publication boundaries in Section 8. **Own:** `plugins/media/edit/{drafts,run,variants,log}.js`; focused `plugins/media/test/edit-lifecycle*.test.js` and `plugins/media/test/edit-variants*.test.js`. A00 registers storage tables and tool/UI entry points.

**Work:** private draft persistence and version lineage; immutable batch snapshots; independent child seeds and sequential scheduling; pending clarification; stable run/slot IDs; progress events; reconciliation after disconnect/restart; cancellation; cleanup status; revocation before atomic publication. Store note text in drafts, not operational logs.

**Dependencies:** A00 contracts; integrate A02 attachment access, A04 planning, A01 rendering, A06 policy and later A08/A09 operations. Module work may use strict test doubles. **Handoff:** draft/run/variant APIs and events for A07, plus registration and deletion hooks for A00. Inject policy/render/transform adapters; do not reimplement their internals.

**Done when:** four candidates reuse the same source and intent, run sequentially on the low-memory path, retain successful siblings on failure, and never publish an unchecked or revoked output. Retries cannot duplicate gallery slots; deletion cancels dependent work and removes retained drafts/intermediates.

### A06: Policy evidence and publication checks

**Outcome:** trusted checks gate rendering/publication, with honest limits on the age and consent evidence available.

**Read:** Section 9 and its release blockers. **Own:** `plugins/media/edit/safety.js`, `plugins/media/edit/policy/`; focused `plugins/media/test/edit-policy*.test.js` and properly sourced fixtures under `plugins/media/test/fixtures/edit-policy/`. If a consent UI is justified and specified, own only `packages/ui/src/image-editor/consent/` and `packages/ui/test/image-editor-consent*.test.ts`. Runtime/dependency registration goes through A00; managed artifact installation goes through A01.

**Work:** evaluate dependencies and licenses; implement request/input/output decisions and uncertainty handling; define consent scope/revocation; expose policy results to A05 and runtime hooks to A01. Supply enforcement requirements for legacy tools so A00 closes alternate automatic routes around a block. Check final composited outputs as well as intermediate reuse where required.

**Dependencies:** A00's evidence/publication contract. Evidence research starts early, independently of rendering. **Handoff:** decision interface, reason codes, artifact requirements, evaluation report, consent lifecycle and any unresolved scope decision.

**Done when:** orchestration tests and relevant real-model evaluation both support the advertised scope. Mocked classifiers prove only control flow. Sensitive identity editing remains disabled if its evidence gate is unresolved; record that as an outstanding requirement rather than declaring the packet fully complete.

### A07: Editor workspace and model picker

**Outcome:** a usable image-first workspace with whole-image instructions, versions, comparisons and compatible controls.

**Read:** Sections 2A/2B/2E and the common UI/data contracts. **Own:** `packages/ui/src/image-editor/` except the reserved `selection/`, `transforms/`, `consent/` and `extensions/` subdirectories; scoped editor styles and `packages/ui/test/image-editor-workspace*.test.ts`. A00 owns `main.ts`, global CSS imports and app entry wiring.

**Work:** canvas viewport, toolbar, whole-image prompt, version strip, favorites, comparison, responsive panel/bottom sheet, keyboard access, draft recovery, model picker, capability-based settings and progress/failure states. Provide mounted component slots for A08's selection tools and A09's transform/export controls.

**Dependencies:** A00's editor/profile/run contracts. Build against clearly identified fixtures while A01/A05 finish, then replace them with real adapters before acceptance. **Handoff:** editor mount/unmount API, event bindings, required imports and responsive/accessibility evidence for A00/A10.

**Done when:** users can generate and compare versions, explicitly select a compatible model, retain drafts across tool changes and see actionable errors without losing notes. Labels/controls must reflect actual capabilities. Include at least one small-laptop layout and one narrow layout in visual verification. This packet owns presentation, not a second job scheduler or storage database.

### A08: Point notes, selections and remove-and-fill

**Outcome:** users can tap an area, write a local instruction, refine its mask and apply precise regional edits or background filling.

**Read:** Sections 2C/2F, `1.2` semantics and the masked-edit execution requirements. **Own:** `plugins/media/edit/regions.js`, `plugins/media/edit/regions/`; `packages/ui/src/image-editor/selection/`; `plugins/media/test/edit-regions*.test.js` and `packages/ui/test/image-editor-selection*.test.ts`. A01 owns profiles/graph templates, A04 owns semantic schemas, and A07 owns the host canvas shell.

**Work:** numbered notes; point/brush/rectangle selections; add/subtract and feathering; source-coordinate transforms; source/version binding; stale-mask rejection; overlapping-note handling; ordered masked passes; compositing and preservation outside the effective mask. Implement remove-and-fill using the same checked regional path. Object segmentation is optional and must not block manual selections.

**Dependencies:** A00's mask/canvas contract. For integration, A02 registers/stages masks, A04 validates regional intent, A05 schedules jobs, A01 supplies a verified inpainting graph, and A07 hosts the controls. **Handoff:** selection component API, mask artifacts/validation and regional-operation adapter; document mask semantics for A09's transparency tool.

**Done when:** notes stay aligned during zoom/pan/display resizing, changed source versions invalidate stale selections, paired execution stages masks correctly, and tests prove unchanged lossless pixels outside the effective mask. A tap with no reviewed boundary cannot masquerade as an exact selection. Whole-image edits followed by notes require the planned source review step.

### A09: Crop, resize, transparency and export

**Outcome:** deterministic image tools work even without an installed generative model, and users can export approved images correctly.

**Read:** Section 2D and common artifact/version/selection contracts. **Own:** `plugins/media/edit/transforms.js`, `plugins/media/edit/transforms/`; `packages/ui/src/image-editor/transforms/`; `plugins/media/test/edit-transforms*.test.js` and `packages/ui/test/image-editor-transforms*.test.ts`. A00 alone updates dependencies and shared registration.

**Work:** crop frames and aspect presets; dimension inputs and aspect lock; fit/fill preview; alpha erasure from a validated mask; undoable draft transforms; creating new versions; selected-result export; explicit transparency/JPEG handling. Preserve originals and enforce decoded-image/dimension bounds.

**Dependencies:** A00's artifact/transform contract. Implement against mask fixtures before A08 is ready; integrate A08 selections for transparency, A05 version/publication operations and A07's control slots. **Handoff:** transform/export adapters and UI panel API, exact supported formats, interpolation/alpha rules and any dependency request.

**Done when:** crop/resize/alpha operations make no model request, previews match the saved transform, invalid dimensions stop, source versions remain intact, and exported transparent images keep their alpha. AI upscaling and generated canvas expansion belong to A11, not this packet.

### A10: Integration verification and release evidence

**Outcome:** the connected editor meets the user-visible requirements and its advertised hardware/privacy guarantees are supported by evidence.

**Read:** the entire Section 12 checklist and the handoffs from A00–A09. **Own:** `plugins/media/test/plan.test.js`; `packages/core/test/image-editor-integration*.test.ts`, `packages/ui/test/image-editor-integration*.test.ts`, `plugins/media/test/image-editor-integration*.test.js`, and `fixtures/image-editor-integration/` under those test directories. Production changes stay with their feature owners/A00; existing owner-specific unit tests remain with those owners.

**Work:** exercise real UI-to-core-to-plugin-to-worker paths; capture outgoing network requests for privacy assertions; test alternative tool routes, schema/version mismatch, model selection, four-version cancellation, regional compositing, export, restart and full deletion. Run focused suites and then `pnpm check`; compare actual image quality and hardware results against the agreed rubric. Do not create a competing test configuration or change dependencies independently.

**Dependencies:** test planning can start after A00's contracts; release verification needs integrated A00–A09 and A01/A06 evidence. **Handoff:** acceptance matrix with pass/fail/unverified per row, exact commands/results, visual evidence, hardware records and defects assigned to their production-file owner.

**Done when:** all requirements in the release's declared scope pass and no required item is merely mocked or unverified. An unavailable GPU or unresolved consent design is reported as a release gap. A00 coordinates fixes; A10 reruns affected checks and the final required suite rather than editing production files outside its scope.

### A11: Optional canvas expansion and AI upscaling

**Outcome:** separately validated outpainting/upscaling extend the released editor without changing the promises of ordinary resize.

**Read:** U3 requirements in Section 2 and profile/quality gates in Sections 4/12. **Own:** new operation modules under `plugins/media/edit/extensions/`, UI under `packages/ui/src/image-editor/extensions/`, and focused extension tests. Existing profiles, renderer and shared wiring stay with A01/A00 unless ownership is explicitly transferred after those packets settle.

**Work:** explicit expand-canvas controls and previewed bounds; outpainting with protected original content; explicit AI-upscale options; measured memory/latency and quality limits. Both operations use the existing draft, version, policy and publication systems.

**Dependencies:** completed requested-editor release and an explicit assignment to this optional packet; new profiles pass A01's verification process. **Handoff:** extension adapters, profile requirements and evidence. **Done when:** the new operations meet their own quality/resource tests and preserve existing crop/resize/edit behavior. A11 does not block A00–A10 completion.

### Parallel-work order

| Wave | Packets to assign | What must be settled before advancing |
|---|---|---|
| 0: shared contracts and research | A00 first pass; A01 hardware research; A06 evidence research | A00 publishes accepted interfaces and ownership. A01/A06 research may continue into later waves |
| 1: independent foundations | A01 runtime, A02, A03, A04, A06 implementation, A07 workspace, A09 deterministic tools | Each module hands off usable exports and focused checks; missing hardware/policy evidence remains explicitly open |
| 2: orchestration and precise editing | A05 and A08; A00 integrates completed foundations | Real attachment, planner, profile, policy and canvas dependencies become available; test doubles are removed from shipped paths |
| 3: connected product | A00 integration pass; A07–A09 connect their adapters; A10 runs acceptance | Requested U1/U2 behavior and Section 12 gates pass with actual runtime evidence |
| 4: optional extensions | A11 only if assigned | Separate extension acceptance; no reopening unrelated ownership |

Waves show dependency eligibility, not a requirement to launch every listed agent at once. With three feature-agent slots, queue ready packets in those slots; a long hardware investigation must not prevent UI or pure-module work against accepted contracts. A05/A08 may start earlier with approved fixtures, but their integration cannot be marked complete before the real dependencies arrive. At most one live owner edits each shared file during integration.

### Copyable assignment prompt

Use this only when ready to authorize implementation. Replace `A07` with the desired packet ID; the future message explicitly grants that packet's file scope rather than relying on this Markdown-only planning turn.

> Implement packet **A07** from `image_edit_plan.md`. For this assignment, I authorize implementation edits only to that packet's owned files and focused tests. Read its referenced specification sections, Section 11's shared ownership rules, and the accepted A00 contracts. Produce its stated outcome and acceptance evidence. Do not edit another packet's files, shared wiring, manifests or this plan; send the responsible owner a precise integration request instead. Use approved test doubles only for development, and report unmet real dependencies. Do not dispatch additional agents or expand scope. Return changed files, public interfaces, actual test results, integration instructions and remaining blockers.

For **A00**, replace the prohibition on shared wiring/plan edits with “You own the shared wiring, contracts and plan updates listed for A00; do not implement feature-owner modules.” Assign its **first contract pass** initially and its **integration pass** once feature handoffs are ready. Merely sending the plan for review does not authorize code changes.

## 12. Verification and definition of done

### Automated checks for future implementation

- **Attachments:** duplicate names, MIME mismatch, malformed images, decoded-size limits, wrong-conversation handles, non-contiguous labels, symlinks, reload, pending clarification, concurrent deletion, orphan cleanup and legacy inline-image removal.
- **Sampling/provider/router:** image modality on both sampling paths; correct schema wire shape; unsupported versions/models; malformed/truncated streams; cancellation; Combined-mode outer chat; pinned-cloud conflicts; retries and hedges making zero hosted requests for private jobs.
- **Schema/semantics:** unknown nested keys, bad versions, finite numeric limits, unknown handles, conflicting roles, exclusions, target selection, multiple identity sources, clarification consistency and unsupported actions.
- **Compiler/graph:** all six source examples; target supplied after reference images; stable role ordering; handle-to-slot mapping; exclusions; literal non-role instructions; permitted wording retention; no model-controlled graph/settings; fourth-image rejection.
- **Renderer/compute:** extend the fake ComfyUI in `plugins/media/test/plan.test.js` and compute coverage. Assert exact loaders, bindings, prompt and pinned settings; allow a verified split-loader profile with an empty checkpoint list; enforce host-side profile checks; stage every input; refuse unsupported workers before dispatch; no image upload or `/prompt` for input-blocked jobs.
- **Policy/publication:** input and output blocks, failed/uncertain evidence, multiple/no-face subjects, revocation, no preview/file/gallery leak, blocked-job attempts through existing tools, and output metadata cleanup. Keep orchestration mocks separate from evaluated model accuracy.
- **Install/lifecycle:** wrong bytes under the right filename, existing-file hash mismatch, resumed downloads, partial upload failure, OOM, timeout, disconnect after submission, cancellation during each phase, restart reconciliation and paired-host cleanup while offline.
- **Variants:** same immutable source/intent with distinct valid seeds; four sequential batch-size-one runs; stable candidate order despite retries; partial failure; cancel remaining; retry only the selected failed child; no publication of unchecked siblings; deleting a batch removes its private intermediates.
- **Regional edits:** point/mask alignment after zoom, pan, display resize, orientation correction and crop; stale-source rejection; mask staging; conflicting overlaps; ordered note passes; cancellation between passes; pixel equality outside the effective mask in the lossless working image.
- **Editor/controls:** keyboard and touch note creation; pan without accidental markers; draft recovery; narrow-screen layout; model incompatibility without losing notes; profile-only controls; comparison at matching zoom; deterministic crop/resize without model requests; transparent exports and explicit JPEG background handling.
- **Regression:** existing `generate`, user workflows, provider requests without schemas, text attachments and conversation deletion remain usable. Check tool selection behavior so multi-reference edits reach `edit_image` instead of the legacy generic workflow path.

Run focused Vitest coverage during implementation, then the repository's `pnpm check` for the completed code change. These commands are future verification work; a plan-only edit does not require a build or test run that creates artifacts.

### User-visible acceptance matrix

| Request | Expected result |
|---|---|
| “Put me in her clothes.” | Preserve target identity/body/pose; borrow clothing |
| “Use her clothes and pose on me.” | Preserve target identity; borrow clothing and pose |
| “Keep my pose but use her outfit.” | Preserve target pose; borrow clothing/accessories only |
| “Only use the lighting from this.” | Borrow lighting; retain target identity, outfit, pose and style within the documented general-edit limits |
| “Use image 2's outfit and image 3's pose.” | Keep the two role sources separate |
| “Make me look like this.” | Ask which attributes to copy; no render until answered |
| Three-image identity/outfit/lighting example | Correct target and role assignment; no unintended reference identity or anime-style transfer |
| Four attached images | Explain the three-image limit before planning; all four remain available for a corrected selection |
| Missing profile / local planner / selected compute host | Specific setup error; no alternative provider or model used |
| Forget images during a queued or active job | Job cannot publish; local deletion completes and remote cleanup status is truthful |
| “Make four versions of this edit.” | Four independent candidates from the selected source; distinct recorded seeds; sequential execution on the low-memory profile |
| Select version 3, then “Edit this version.” | Version 3 becomes the new source; the original and sibling versions remain available |
| Tap the bag and write “make this blue.” | Numbered note plus visible adjustable selection; masked change after Apply; outside the effective mask stays unchanged |
| Add separate notes on a hat and a bag | Editable note list and visible masks; execute in displayed order; explain extra passes; resolve conflicting overlap |
| Choose Whole image and write “warmer evening lighting.” | General edit mode; local-selection controls and preservation claims match the selected mode |
| Brush a distracting object, choose Remove and fill | Inpaint only the selected area using a compatible profile; inspect the filled result alongside its source |
| Choose Erase to transparency | Remove selected pixels to alpha with undo; PNG export preserves transparency |
| Crop to 4:5 or resize to an explicit width | Preview the exact crop/fit/padding; apply a deterministic transform as a new version; no generative model needed |
| Choose a different installed editing model | Show its supported controls and actual version; preserve the draft; honor that profile without fallback |
| Cancel after two of four candidates finish | Keep the two published versions; stop the active candidate and remaining work; remove unpublished intermediates |

Evaluate visual adherence with a fixed, licensed or consented fixture set and a rubric covering identity, clothing, pose, lighting and unwanted style transfer. In fixtures using “me,” supply an explicit target selection or prior user statement; the planner must not infer the user's identity from a face. Record the actual success rate and failure examples across seeds; graph snapshots alone do not establish editing quality. Choose the quality pass threshold before running the benchmark. Exact preservation or automatic drift detection must not be advertised without supporting results.

### Release blockers to resolve, without inventing answers

1. Which immutable low-memory checkpoint, encoder, VAE and runtime actually meet both the hardware and content-behavior requirements?
2. What resolution, memory headroom and total latency are supported by measurements?
3. Is a three-image first release accepted as reduced scope, or must a validated four-image branch precede release?
4. What evaluated age/consent evidence is sufficient for the advertised sensitive-editing scope, and how is revocation enforced?
5. What protocol support proves that private sampling, attachment context and edit-plan validation cannot be ignored by older core/worker versions?
6. Which validated inpainting profile supports the U2 note/removal workflow on the target hardware, and does final compositing preserve pixels outside the displayed effective mask?

The feature is complete only when the advertised scope passes these gates with recorded evidence. A successful single render, schema-valid JSON, or passing mocked safety tests does not close the outstanding requirements.
