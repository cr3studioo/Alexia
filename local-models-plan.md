# Local models in Alexia

Approved scope: model installation and recommendations live in core alongside providers;
llama.cpp and MLX are managed runners. The picker has a curated list and advanced Hugging
Face search for GGUF and supported MLX models. Existing Ollama models remain supported.

## Installation contract

Settings → Models and first run share the picker. Install & use prepares the pinned runtime,
resumes and verifies every weight file, starts an authenticated loopback server, checks a
chat answer and advertised tool support, and chooses the model only after success. Cloud
mode requires an explicit Local or Combined choice, applied only after successful install.
A failed install retains the previous pin and mode. A failed tool probe leaves a chat model.

Weights are stored under `models/text/<publisher>/<repo>/<commit>/`. Installed IDs include
a `llama/` or `mlx/` prefix to avoid collisions with Ollama. The registry stores provenance, the actual
configured context, capability checks, quantization and any measured response speed. Unknown
Hugging Face capability or content-policy metadata remains unknown.

Downloads retain `.part` files for retry, validate HTTP ranges, file length and SHA-256,
and check the target filesystem's available space. Search results are unvetted, pinned to
a full commit before download, and never execute repository code. Gated repositories require
a token stored in the OS keychain and access granted by Hugging Face; Alexia does not bypass
gates or accept supplier terms on the user's behalf.

## Recommendation limits

Memory estimates include weights, KV cache and runtime buffers. Available memory and disk
are measured on the machine holding the model files. Apple unified memory is counted once;
dedicated VRAM is not added to RAM. Unknown architectures are marked conservatively. A
larger parameter count is a selection policy, not proof of higher quality, and a smaller
model is not assigned an invented throughput figure. Vision is not advertised until a
projector is installed and supported end to end.

Abliterated builds have their own expandable group and keep base-model licence information.
They are excluded from ordinary recommendations. Altering refusals does not establish tool
quality; capability checks still apply. Downloads and supplier metadata require a network
connection; inference uses loopback and can run offline after installation.

## Runtime and lifecycle

Runtime assets and hashes are pinned to a release, verified before extraction, and extracted
without archive traversal or external links. Upstream macOS signatures are verified; no
quarantine attributes are removed and Gatekeeper is not disabled. Notarized project-owned
builds, if required for distribution, belong to the release owner. Windows and Linux use
conservative backend selection: detected hardware must match an available runtime asset
before enabling CUDA or Vulkan, with CPU fallback otherwise.

Only one Alexia-managed model is loaded at a time. Active inference holds a lease to prevent
model swapping and idle unloading. Shutdown aborts jobs and stops the owned runner before
closing the database. Other applications' Ollama sessions belong to those applications;
Alexia must account for their memory rather than unload their work without consent.
An ownership pipe makes the runner exit even if core crashes. Runtime versions have separate
folders, while coordination remains scoped to the data directory across runtime upgrades.

## Verification and follow-up

Focused tests cover recommendations, pinned metadata and split files, resumable downloads,
checksum failures and cancellation, runner lifecycle, authenticated provider preparation,
install failure preserving the previous pin, removal, routing, first run and picker disposal.
Repository type checking, lint, unit tests and invariants are required before delivery. A
real small-model install in an isolated data directory checks the actual runtime and model.

Local verification on 2026-09-30: type checking and lint pass; all 188 unit-test files pass
(1,926 tests), including extraction, signature verification and execution of the pinned
upstream macOS archive. All 13 invariant files pass (36 tests). Failed reinstalls restore
the previously checked model record. The curated catalog contains nine pinned Qwen builds
with 39 quantizations; other publishers are available through advanced Hugging Face search.

The real isolated Qwen3 0.6B Q4_K_M workflow passed: runtime download, cancellation/resume,
checksums, chat, tool check, Models table and local stats, removal, and shutdown. Alexia Dev
was rebuilt and installed from the final code. An extra fresh repeat was stopped during the
resumed weight download because supplier transfer speed fell too low to finish promptly;
it did not produce a second complete end-to-end result. Automatic approval review denied
computer control of Alexia Dev and Comet, so visual inspection was not performed.

## Phase 2 delivered

- MLX on Apple Silicon with a private, pinned CPython runtime and hash-locked binary wheels.
  Installation does not depend on the user's Python. Curated Qwen3 0.6B and 1.7B 4-bit models
  include pinned revisions and hashes for weights, configuration and tokenizer files.
- Authenticated MLX chat streaming, token-based context limits, cancellation, ownership
  monitoring, idle unloading and coordination with llama.cpp through inference leases.
- Context controls with memory estimates and FP16, Q8 or Q4 KV cache. Compatible GGUF
  draft models can enable speculative decoding; the picker checks tokenizer, architecture,
  memory and context compatibility.
- Existing GGUF import, including split files, with copy or reference storage. Integrity is
  checked before use; removing a referenced model leaves the original files intact.
- A measured speed action, catalog revision update hints and suggestions for unused models.
  Removal remains an explicit user action. UI controls include retry and job cancellation.

Final verification on 2026-10-01: `pnpm check` passed lint, dependency boundaries, TypeScript,
195 unit-test files (2,033 passed, one optional test skipped) and all 36 invariants in 13 files.
A real isolated MLX Qwen3 0.6B installation on an Apple M4 passed runtime and weight setup,
verification, smoke chat, pinning, subsequent chat, authentication rejection, context overflow
rejection, Models table and local stats integration, context reconfiguration, Q4 KV cache,
speed measurement, maintenance, removal and shutdown.

The final `pnpm app:dev` build succeeded and opened `/Applications/Alexia Dev.app` from
workspace `local-model-picker`, branch `cr3studioo/local-model-picker`, preserving existing
Dev data. No release was published. This verifies packaging and launch; a final visual
inspection was not performed.

### Supported scope and remaining limits

MLX currently supports dense Qwen3 text chat on Apple Silicon, with no tools or vision claim.
Other MLX architectures are rejected until explicitly supported. Speculative decoding is
implemented for compatible GGUF models only. Measured speed is specific to the local run;
MLX is not advertised as universally faster. Windows/Linux GPU execution and other Mac
hardware have not been exercised on this machine. Automatic safety-model installation
remains a separate product decision. Neither downloads nor cleanup happen silently.

## Local-run correction on 2026-10-01

The existing Qwen3 4B Q4_K_M installation used 8,192 tokens of context. The enabled tool
definitions made even a greeting 11,612 tokens, and the runner returned `exceed_context_size_error`.
The model itself answered direct chat successfully. A 16,384-token context with a Q4 KV cache
passed the memory check and answered with the full tool list; that configuration was applied
through Alexia Dev's context API to the existing installation.

Legacy records now recover missing maximum-context and KV metadata only when repository,
revision, format, quantization and byte count match the pinned catalog. Context controls can
then persist that metadata without downloading weights again. Local context errors point to
context settings and plugin overhead. The pinned Metal device is `MTL0`; checking and launching
that device avoids the erroneous CPU fallback. The focused runner, router and phase-2 tests
passed (141 tests, one optional skip), lint passed, and Alexia Dev was rebuilt successfully.
