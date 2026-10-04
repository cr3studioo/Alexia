# Private image editor contracts

Status (2026-10-04): contracts, modules and integration are implemented, and core now supports
**Alexia protocol 14**. The editor is reachable — *Edit pictures* beside *Attach*, `edit_image`
in chat — but **cannot produce an edited picture yet**, by design: no editing profile is
verified (no benchmark on target hardware) and no safety provider has an evaluation report, so
generation stops at `profile_unavailable` and publication at `policy_unavailable`. Crop, resize,
erase-to-transparency and export work without either. See *Integration* below and the plan's
progress table for what each gate needs.

The executable contracts are exported from `@alexia/protocol` and `@alexia/sdk`:
`private-context.ts` defines generic authorization and sampling; `image-editor.ts` defines
trusted media/editor envelopes. A04 alone owns `ImageJob` schema/semantic validation. A valid
wire envelope is not authorization, policy approval, artifact verification or semantic fidelity.

## Negotiation and metadata

Require protocol **14 or later**, plus the current request's
`alexia/privateContext` capability value matching `PrivateContextCapabilities`. Require the
chosen `imageJobVersions` entry, `1.1` for foundation or `1.2` for regional edits.
`negotiatePrivateContext(protocol, capabilityValue, jobVersion)` returns `ok`, or
`protocol_unsupported`, `capability_unavailable`, `schema_unsupported`. Never cache these
per-request promises. Worker negotiation must apply the same gate before staging files.
Core and conformance-host advertisement belongs to A00's integration pass.

A compliant future capability value is:

```json
{
  "version": "1",
  "attachmentContext": true,
  "interactionOnlySampling": true,
  "structuredSampling": true,
  "revocablePublication": true,
  "imageJobVersions": ["1.1", "1.2"]
}
```

A version alone, a missing promise, or `interactionOnlySampling: false` is invalid.
The present core fails negotiation even with this value. No change to the supported
protocol maximum is part of this checkpoint.

Tool `alexia/attachmentInputs` metadata declares top-level argument fields with `name`,
`cardinality`, `mimeTypes`, `maxCount`. For `edit_image`, declare `images` as `many`, max 3,
PNG/JPEG/WebP. The model-facing arguments remain `{request, images}` with stable labels.
Core rejects absent conversation context, resolves only declared fields against an immutable
selection, canonicalizes files, authorizes and pins them, then injects an
`alexia/attachmentContext` value matching `AttachmentCallContext`. Do not accept this value
from model arguments, direct UI requests or plugin-provided metadata. The receiving plugin
must get core's value after caller metadata has been stripped. Paths exist only here and
at trusted compute staging boundaries; UI and planner receive path-free descriptors.

The ordered context carries `conversationId`, `requestId`, `selectionId`, `leaseId` and
unique attachment IDs/labels, normalized dimensions/bytes/SHA-256, validated MIME,
display name and authorized path. `image_7, image_9` is valid; ordinal bounds are not
selection authorization. Core/A02 persists bytes, labels and leases. A05 releases leases
in all terminal paths; revocation immediately makes a lease unusable for publication.

Sampling metadata is `alexia/local: true` and `alexia/format: SamplingFormat`
(`{name, schema, strict:true}`). Local means **interaction computer only** throughout
routing, retries and hedging. A03 rejects incompatible user pins before inference.
`PrivateSamplingOptions` adds a propagated signal, max token count and absolute total
deadline. These constraints apply to both sampling paths and before the first outer-chat
inference. Planner requests have no tools or automatic conversation inclusion.

The supported schema subset is checked by `supportedSamplingSchema`: type (including
nullable type arrays), properties, required, additionalProperties=false, items, enum and
const with scalar values, numeric bounds, string/array length bounds, title and description.
No `$ref`, regex, combinators or remote schema resolution. Limits are 32 KiB UTF-8 schema,
16 nested schema edges, 32 KiB planner response, 8,000 characters total active instruction
text, three images and eight regions with at most 600 characters each. A04 must produce a
schema in this subset. A03 must validate metadata before serialization and reject truncated,
cancelled or oversized completions rather than parse partial JSON.

## Source, drafts and UI adapters

`SourceVersion` binds a version ID to its core attachment ID, conversation, normalized
orientation-corrected dimensions, checksum, origin and parent version. A05 owns lineage;
A02 owns attachment authorization. Original and approved outputs are separate versions.

`EditorDraft` carries revision, source, up to two reference IDs, whole-image instruction,
ordered regions, operation, optional transform, selected profile/version, supported settings
and explicit variant count 1/2/4. Saving never generates. Profile null permits drafts and
deterministic transforms without installation; generation requires a compatible profile.
Each backend command authenticates the conversation and checks source, references and
revision again. Runtime compatibility is enforced by A05/A01, not this structural parser.

`RegionNote` uses normalized source coordinates and a source-version binding. Its mask
has an artifact ID, dimensions, checksum, nonempty coverage and effective feather pixels.
A08 owns mask interpretation/compositing. A02 registers the bytes. Changing source retains
text but marks selections stale. Generating needs reviewed, current, validated masks and
resolved overlaps. Whole-image generation followed by regional notes requires review of the
new source before applying notes; the backend returns `source_review_required` until then.

`TransformRequest` is crop (normalized bounded rectangle), resize (dimensions, fit/fill,
RGBA background), or erase-alpha (trusted mask ID). A09 defines rounding, resampling,
decoded-image limits and saved-preview equivalence. Transparent JPEG exports require an
explicit opaque background; `export_incompatible` prevents silent alpha loss.

`CanvasViewport` maps source/viewport coordinates and carries zoom/pan. `EditorComponent`
is generic in its host container type (UI uses HTMLElement); `mount`, `update`, `unmount`
share `EditorComponentContext`. A07 owns the transient undo stack and `commit(label,next)`
for one operation per undo entry. A08/A09 use this callback rather than saving independent
histories. The context's signal stops listeners/work, and `overlay` displays the effective
mask. A07 converts committed drafts to A05 save commands with optimistic revision checks.
Unmount removes listeners and does not cancel already authorized generation implicitly.

## Profiles, rendering and publication

`ProfileDescriptor` exposes selected ID/version, supported operations/job versions, input
limit, destination, actual availability/reason, evidence ID, measured memory, supported sizes,
profile-approved presets/ranges and seed limits. Available requires benchmark evidence and
measured memory. Inpainting/removal requires 1.2. Batch size is one. No artifact hashes,
filenames, quality rankings or memory numbers are invented by this checkpoint. A01 owns
trusted artifact manifests and profile validation. The UI presents incompatibilities and
retains drafts; it never substitutes a profile or destination.

`EditRenderEnvelope` is created by A05/A01, never by the planner: run/batch/child/attempt,
source/selection/lease, operation, profile/version, manifest and graph digests, bounded compiled instruction/compiler version, settings,
seed, expectedOutputs=1, suppressPreviews=true, selected destination, total deadline,
ordered attachment slots/checksums, and masks. Target occupies slot 1. A04's compiler
supplies deterministic contributing-slot order; A01 reconstructs the fixed graph and
verifies runtime/artifact hashes on the managed host **before upload or prompt submission**.
No arbitrary graph or node-class field is accepted. Mask files are staged alongside inputs
and do not count toward the three-image limit. Partial upload cleanup is mandatory.

`PublicationCallbacks` separates input checks, output checks, atomic publish and discard.
A06 owns evidence/decision internals; A01 owns quarantine bytes; A05 coordinates. The publish
commit must recheck live lease, cancellation, conversation/consent revocation and approved
output evidence under synchronization shared with revocation. A separate preflight read
followed by an unsynchronized insert is insufficient. Progress must suppress previews at
the earliest boundary, including thumbnails, gallery and file links. Completed candidates
alone have output version IDs. Source previews and deterministic local previews may use
source or previously approved bytes.

## Commands, scheduling and deletion

`EditorBackend` provides loadDraft, profiles, versions, batch, command and subscribe. Commands return
the updated draft/batch and any scoped export artifacts. Version/batch reads recover the
selected source, favorites and candidate slots after reload; UI receives authorized URLs,
never absolute filesystem paths. Commands are save,
generate, clarify, make_more, retry_failed, cancel_remaining, edit_version, favorite,
remove_version and export. Generate/clarify carry draft revision and an idempotent invocation
ID; retries target a stable candidate slot. A05 authenticates every command, persists pending
clarification, refuses policy-blocked retries, and serializes low-memory candidates.

`BatchSnapshot` captures the immutable validated draft, lease/selection, normalized A04 job,
job/compiler versions, destination and creation/deadline times. A04 validates the semantic
job before snapshot creation. Every candidate starts from that source; only recorded seeds
vary. Child IDs/slots survive retry; attempt IDs change. A05 persists candidates before
queueing and the ComfyUI prompt ID immediately after submission. Unknown submission state
requires reconciliation, never automatic resubmission.

`EditorEvent` has monotonic conversation-scoped sequence numbers for candidate,
clarification and cleanup events, with no generated bytes or prompt in progress. A07 loads
a fresh snapshot after reconnect or a sequence gap. Terminal run states and `EditorReason`
are defined in code. Renderer/compiler/policy implementations must map detailed internal
errors to these stable codes and redact sensitive provider/ComfyUI bodies.

One signal travels through planning, checks, staging, rendering and output handling, with
phase budgets bounded by the total deadline. Cancel remaining retains already published
siblings, cancels active/queued candidates, removes unpublished artifacts and emits final
states. Late callbacks cannot publish after cancellation.

A02's `AttachmentLifecycle.revoke` invalidates leases before deletion. A00 calls registered
`PrivateDeletionParticipant.revoke` hooks, waits for all to acknowledge suppression, then
runs their idempotent cleanup hooks. Media owns drafts, runs, masks and lineage; core owns
attachments, inline legacy messages and caches. Participants persist cleanup failures and
retry after restart. `CleanupReceipt` keeps local and each remote host state separately;
local complete plus remote pending is **not** full deletion. Errors do not roll back
revocation. The existing conversation-ended notification is not deletion and is unchanged.

## Integration handoff

A02 implements attachment/lease lifecycle; A03 uses the sampling metadata/schema helpers;
A04 supplies the sole 1.1/1.2 semantic validator/compiler; A01 supplies verified runtime and
profile descriptors; A06 supplies policy evidence/checks; A05 implements editor commands,
snapshots and publication. A07–A09 consume the shared drafts and component interfaces.

A00's later integration pass adds authenticated entry points, conversation privacy before
inference, trusted tool context injection, capabilities/version gating, deletion hooks,
worker enforcement and editor mounting. Do not enable a tool against these contract types
using production stubs. A10 must capture real traffic and validate connected behavior,
hardware limits and policy evidence before release. Changes to these contracts go through
A00 with producer/consumer impact recorded here.

## Integration (A00 second pass)

- **Protocol 14.** `ALEXIA_PROTOCOL_MAX = 14`. New permission `attachments.scoped` (refused below
  14). New plugin → core methods `alexia/attachments/{lease,release,live,register,share}`; `register`
  and `share` accept only real files inside the plugin's own folder. Core sends
  `alexia/privateContext: { protocol, capabilities: PRIVATE_CONTEXT_PROMISE }` with every editor
  and attachment-input call, and the media plugin refuses any call whose negotiation fails.
- **Attachment inputs.** `PluginTooling` reads `alexia/attachmentInputs` from a tool, resolves only
  the declared top-level fields as labels in the calling conversation, rejects counts and types
  outside the declaration, injects `alexia/attachmentContext` in request `_meta`, and releases the
  lease when the call returns. `Tooling.call` gained an optional `{ conversationId }`.
- **Editor binding.** A tool carrying `alexia/editor` is hidden from models (like compute tools);
  core reaches it with `plugins.editorCall`. The screen talks to `/api/editor` (one POST for every
  call, the conversation checked by core), `/api/editor/picture` and `/api/editor/file` (GET by id
  or share token), `/api/editor/upload` and `/api/editor/forget`; all are in the route guard, and
  `remove_version` and `forget` need a confirm.
- **Privacy before inference.** With the editor installed, a picture sent in chat (unless
  `cloudVision: true`), opening the editor or uploading to it marks the conversation private; every
  agent step of a private conversation routes with `placement: 'interaction'`, and the memory
  hand-off and learn offer are skipped for it. Plugin sampling with `alexia/local` is served by
  `privately()`: interaction-only route, no tools, no slash commands, no paid rungs.
- **Deletion.** `forgetPictures()` revokes core leases, then the editor's jobs (`revoke`), then
  cleans up both sides; unfinished work is recorded in `pending_picture_cleanup` and retried after
  start. Conversation deletion runs it before the messages go. Render hosts sweep what an edit lent
  their ComfyUI when the worker prepares or releases.

**Deviations from the plan, for review:** UI modules are flat `packages/ui/src/image-editor*.ts`
files rather than an `image-editor/` folder, because core serves shell modules by flat name only;
legacy and new chat messages keep inline `data:` URLs (scrubbed on deletion) rather than
attachment references; the planner and policy samplers use MCP `sampling/createMessage` with
private metadata rather than a new method.

## Checkpoint verification

On 2026-10-04, `pnpm check` passed lint/dependency checks, TypeScript, 236 unit test
files (2,627 passed, one skipped) and 36 invariant tests. The private-context suite
contains 25 contract tests. These establish wire/structural behavior and regression
compatibility; they do not establish end-to-end privacy, policy accuracy or render quality.
