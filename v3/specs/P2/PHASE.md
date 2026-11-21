# P2: V3-2, Core in Rust

> Planned 2026-11-20 from `v3-plan.md` *V3-2* (the authority for scope), `v3/specs/INTERFACES.md`
> (the Rust shapes) and phase review 3 (`phase-review-3.md`, 12 findings, all covered below).
> `Alexia.md`, `plan.md` and `packages/core/src` are read only as facts about v2's behaviour,
> which this phase ports. Where INTERFACES.md needs an addition, it is listed at the end and
> written by P2-01 or P2-02.

## Goal

The hub answers every turn itself. The agent loop, the router for task steps, permission modes,
the safety checker, redaction, trimming, the trace and the audit log are ported from v2's
TypeScript to Rust in `alexia-core`. Plugins keep running unchanged as MCP processes through the
Rust host, and get from it what only v2 core gave them so far: sampling (including
`alexia/tools` tasks and `alexia/local` private requests), elicitation, roots, attachments and
`alexia/compute/run`. `V2Bridge` is deleted and the hub never starts v2 core again.

On top of the port: runs survive a restart (SP-13, AC-08), scheduled jobs (AC-09), parallel
helpers (AC-07), an approvals inbox (AC-10), undo (AC-11), a searchable activity log with replay
(AC-12, TR-08), an encrypted database (TR-09), a managed llama.cpp on the GPU for the non-chat
jobs D213 allows (MO-01, MO-02, MO-06, MO-07, MO-08, MO-09, MO-13, SP-17), model per job and
subscriptions (MO-05, MO-14), model comparison (MO-10), and plugins that are hot-reloaded (EX-12)
or run in-process as sandboxed WASM (SP-10, TR-06).

Feature IDs: **SP-01** (Rust core: port core, keep plugins as they are), **SP-10** (WASM and
process plugins), **SP-13** (update without losing a task), **SP-17** (speculative decoding,
local non-chat jobs only, see *Owner needs*), **TR-01** (permission modes), **TR-02** (safety
checker), **TR-03** (secrets in the OS keychain, now for plugin settings too), **TR-04**
(redaction before cloud), **TR-08** (audit log and replay), **TR-09** (encrypted memory at
rest), **TR-12** (prompt-injection guard), **AC-07** (parallel helpers), **AC-08** (jobs that run
for days), **AC-09** (scheduled jobs), **AC-10** (approvals inbox), **AC-11** (undo), **AC-12**
(activity log), **MO-01** (managed llama.cpp), **MO-02** (models that fit the VRAM), **MO-05**
(use your subscriptions), **MO-06** (local vision), **MO-07** (local embeddings), **MO-08** (GPU
load cap), **MO-09** (steps aside for games), **MO-10** (compare models), **MO-11** (fresh model
catalog), **MO-12** (spending caps), **MO-13** (Hugging Face import), **MO-14** (model per job),
**EX-12** (hot reload), and **TR-06** (sandbox per plugin, pulled in by SP-10; owner confirms).

## Done when (written by the P2 planner; v3-plan.md has none for V3-2)

*Written 2026-11-20 by the P2 planner from v3-plan.md's "v2 core is retired". The owner may
overrule it.*

v2 core is retired: the hub serves every turn itself, the v2 bridge is no longer needed, and
every plugin still works through the Rust MCP host. Measured, not claimed:

1. **No v2 core in the hub.** `v3/crates/alexia-hub/src/bridge.rs` is gone, and
   `node v3/ci/invariants.mjs` check 11 (P2-38) fails on any `V2Bridge`, `ALEXIA_V2_ROOT`,
   `ALEXIA_V2_URL` or `/api/chat` in `v3/crates/*/src`. `alexia-hub run` with no `ALEXIA_V2_*`
   variable set answers chat, task, command and scheduled turns.
2. **The loop end to end** (`cargo test -p alexia-hub --test agent_e2e`, P2-39): the real
   `alexia-hub run` binary against a fake Bot API, fake free providers that script tool calls,
   and the `mcp-fixture` plugin. A task turn calls a plugin tool; a risky call gets Approve/Deny
   buttons and runs only on Approve; a message sent mid-task steers the run without losing its
   finished steps; the audit log has one row per call; the run resumes after the hub is killed
   mid-task and restarted; a scheduled job fires; `/undo` reverses the fixture's undoable call.
   The P1 latency test (`telegram_e2e`) still passes, with no fake v2 core.
3. **Every v2 plugin on the Rust host** (`cargo test -p alexia-hub --features v2-conformance
   --test v2_plugins`, P2-40, on the PC with a built checkout): every folder under `plugins/`
   loads and lists its tools; `hello`'s sampling round trip, with and without `alexia/tools`,
   answers through the Rust agent; `crasher` and `vanisher` behave as INTERFACES §7 checks 3 and
   4, and the vanisher's half of check 4 now re-plans.
4. **On the PC** (P2-41): over Telegram the owner runs 20 real tasks that use at least 5
   different plugins, with the hub as the only Alexia core on the PC. The report lists each
   task, its run id and whether it finished; `alexia-hub activity --last 20` shows them.

## Crates and files this phase creates or changes

All under `v3/crates/` unless noted.

| Crate | P2 content |
|---|---|
| `alexia-store` | migration 3: `audit`, `live_runs`, `approvals`, `jobs`, `job_runs`; methods for them and for `runs` (P2-03); secrets fixes (P2-10); SQLCipher at rest, `encrypt.rs` (P2-37) |
| `alexia-mcp` | `Upcalls::host_call`, `HostedTool.reviewed`, `wasm.rs` stub (P2-02); `alexia/compute/run` served locally and host-answered capabilities (P2-22); hot reload (P2-23); WASM plugins under a capability sandbox (P2-24) |
| `alexia-core` | seams first: tools on the wire (P2-04), candidates that know tools/vision/context (P2-05), `Turn.steer` (P2-07). Then `run.rs`, `permissions.rs`, `checker.rs`, `redact.rs`, `trim.rs`, `prompt.rs`, `tools.rs`, `trace.rs`, `agent.rs`, `upcalls.rs`, `commands.rs`, `resume.rs`, `helpers.rs`, `undo.rs`, `local.rs`, `gpu.rs`, `hf.rs`, `subscription.rs`, `compare.rs`; `router.rs` gains `step` and per-job models (P2-17) |
| `alexia-gateway` | the asker exists before the gateway (P2-06); steering into a running run (P2-07); `Media` takes a cancel token (P2-08); channels exception narrowed (P2-11); approvals persisted and answerable from any channel (P2-29) |
| `alexia-scheduler` | `Scheduler` with `At`/`Every`/`Daily` triggers and its builtin tools (P2-30) |
| `alexia-hub` | dead code removed (P2-09); `secret set` no longer echoes (P2-10); `bridge.rs` **deleted**; `main.rs` wires `Agent` as task brain and `Upcalls`, the scheduler, resume and the GPU watcher; CLI `activity`, `runs`, `models`, `scope`, `encrypt`, `secret set <plugin>.<key>` (P2-38); `tests/agent_e2e.rs`, `tests/telegram_e2e.rs` (P2-39); `tests/v2_plugins.rs` (P2-40) |
| `v3/ci/invariants.mjs` | check 1's `channels/` exception narrowed (P2-11); check 11, no v2 core (P2-38) |
| v2 | **nothing.** No P2 task touches a v2 path, so none needs `pnpm check`. v2 keeps working on the Mac as it is. |

Migrations: P2 ships **migration 3** only. INTERFACES §5.3 planned `audit` there; P2 also moves
`jobs`/`job_runs` from 4 to 3 (AC-09 is a V3-2 pick) and adds `live_runs` and `approvals`.
Migration 4 (V3-3) keeps vectors and the life graph.

## Phase review 3, finding by finding

| # | Finding | Covered by |
|---|---|---|
| 1 | Candidate drops tools/vision; router can't pick a tool- or image-capable model | P2-05 (before the agent loop) |
| 2 | Agent ↔ Gateway Ask cycle | P2-06 (asker built from a channels handle before the gateway; §2.3/§2.6 rewritten by P2-01) |
| 3 | Steering cancels the run; Brain can't receive a steer | P2-07 (`Turn.steer`, `DraftFrame::Steerable`) |
| 4 | OpenAiCompat refuses tools and drops tool turns | P2-04 (the first core seam task) |
| 5 | Dead `supervise*`, stale `allow(dead_code)` | P2-09 for `latency.rs` and `watchdog.rs`; `bridge.rs`'s allow and `V2Bridge::ready` **go with the bridge deletion in P2-38** |
| 6 | `v2_secret_names` names the plugin id; check 1 skips `channels/` | P2-11 (exception narrowed, §8 item written by P2-01) |
| 7 | `secret set` echoes an unknown key | P2-10 |
| 8 | Bridge logs v2 core's lines unredacted | **Removed by the bridge deletion (P2-38)**; no other code logs a child's output except `alexia-mcp`, which already redacts |
| 9 | `import_v2` treats a read error as "no entry" | P2-10 |
| 10 | `ALEXIA_SECRETS_IN_MEMORY` silently in the real hub | P2-10 |
| 11 | `Media` has no cancel token | P2-08 |
| 12 | Code ahead of INTERFACES.md; duplicate helpers | P2-01 lists every public item in §1.2/§2 and adds `alexia_core::ms_since`; P2-05 and P2-06 replace `router.rs` `elapsed_ms` and `gateway.rs` `ms_since` with it; the bridge duplicate (`bridge.rs:333`) goes with the bridge (P2-38) |

## Phase review 4, finding by finding

Planned 2026-11-20 from `v3/ops/phase-review-4.md`. Specs of tasks already merged or running are
not changed; their files get new tasks (P2-45 to P2-49).

| # | Finding | Covered by |
|---|---|---|
| 1 | Resume collides with the surviving `live_runs` row; step count restarts | No store change: `Trace::resume(.., steps_done)` uses `live_touch`, never `live_begin` (P2-19); `Task.steps_done` and the resume branch (P2-20); P2-26 sets `steps_done`. INTERFACES §2.3 written |
| 2 | `AgentParts` has no source of plugin manifests | `McpHost::manifests()` (P2-45, new); `AgentParts.host` + `Agent::host()` (P2-20, now depends on P2-45); P2-25 reads it; P2-38 loads plugin skills from it. INTERFACES §2.2/§2.3 written |
| 3 | `scope()` fails open on a kv read error | P2-46 (new) |
| 4 | Unannotated destructive tool treated as safe | P2-46 |
| 5 | `paths_in` misses `file://`, `~`, `%VAR%` | P2-46 |
| 6 | compute/capability calls drop the plugin's cancel and progress | P2-47 (new; `Incoming::request` gains both, sampling too). INTERFACES §2.2 written |
| 7 | P2-38 too big for sonnet; construction order unwritten | P2-38 (wiring, bridge delete, opus) and P2-48 (CLI verbs, opus, new); INTERFACES §2.6 has the order, steps 1 to 11 |
| 8 | `hosted()` defaults `reviewed: true` | P2-47 |
| 9 | `trim::{floor, summary, collapse}` public | P2-49 (new) |
| 10 | Duplicated helpers | telegram `now_ms`: P2-49. `serve.rs` vs `permissions` file-URI/containment: kept two on purpose (different rules, crate direction), comment by P2-47. `permissions.rs` `home()`: kept (sharing needs the store's `lib.rs`, P2-37's now), noted in P2-46 |
| 11 | Agent constructors `todo!()` block follow-on tests | P2-20 step 0 fills `new`/`store`/`host`/`set_local_jobs`/`local_jobs` (OnceLock) first |
| 12 | telegram latency test flaky under load | Already P2-43; no change |

## Phase review 5, finding by finding

Planned 2026-11-21 from `v3/ops/phase-review-5.md`. All 11 findings were checked against the
code and are real; none dropped. Specs of running tasks (P2-08, P2-17) are not changed. INTERFACES
§2.2, §2.3 (`Router::hedged`, `gpu`), §2.5 and §2.6 are written by this planner, so no new task
edits INTERFACES.md (P2-51 and P2-54 do).

| # | Finding | Covered by |
|---|---|---|
| 1 | Chat lane `Router::hedged` sends unredacted requests to cloud | P2-59 (redact inside the race, non-local only; after P2-17); P2-20 depends on it |
| 2 | Scheduler/Agent wiring cycle in §2.6 step 4 | §2.6 amended: step 4 `McpTooling::new(host, vec![])`, step 6 builds the scheduler and adds its tools; P2-60 `ScheduleTools` holds `Weak<Scheduler>`; P2-38 depends on it |
| 3 | compute/run canonicalizes UNC paths before the roots check | P2-61 |
| 4 | Three `file://` decoders | P2-61 (`alexia_mcp::file_uri_path`, `is_network_path`) |
| 5 | A plugin's undo can target another plugin or a builtin | P2-61 (same file as #4, `tools.rs`) |
| 6 | `reviewed` fail-open for new plugins | P2-62 (`_core.known_plugins`, `McpHost::set_reviewed`) |
| 7 | `gpu::Watch` sync callbacks, no process list; held plugins respawn | P2-62 (`GpuEvent` over mpsc, `McpHost::hold`/`release`); P2-38 depends on it |
| 8 | Two ports of v2 `redactSecrets` | P2-63 (regex rows move to alexia-mcp; after P2-38 because of `Cargo.lock`) |
| 9 | Second Job Object FFI in core | P2-64 (`pub use job::Job`; after P2-34 via P2-38) |
| 10 | Scheduled approvals go to the primary chat | P2-64 (`ask.rs` reads the job's stored origin; after P2-29 via P2-38) |
| 11 | invariants check 1 misses ids inside strings | P2-64 (narrow rule: hyphenated or `:`/`/`/`__`-prefixed ids; after P2-38) |

## Order of work

```
P2-01 core types + stubs + deps + INTERFACES ─┬─ P2-02 mcp interfaces ─┬─ P2-18 tooling
                                               │                         └─ P2-22 compute ─ P2-23 reload ─ P2-24 wasm
  seams:                                       ├─ P2-04 wire tools ─┐
                                               ├─ P2-05 candidates ─┴─ P2-17 router steps (+P2-14)
                                               ├─ P2-06 ask seam ── P2-07 steering ── P2-08 media cancel
  ports:                                       ├─ P2-12 permissions, P2-13 checker, P2-14 redact,
                                               │  P2-15 trim, P2-16 prompt
P2-03 store migration 3 ───────────────────────┴─ P2-19 trace
P2-07, P2-12..P2-19 ── P2-20 AGENT ─┬─ P2-21 upcalls (+P2-02)
                                    ├─ P2-25 commands
                                    ├─ P2-26 resume
                                    ├─ P2-27 helpers
                                    └─ P2-28 undo
P2-03 + P2-06 + P2-08 ── P2-29 approvals inbox     P2-01 + P2-03 ── P2-30 scheduler
P2-01 ─┬─ P2-31 llama.cpp ─┐
       ├─ P2-32 gpu ───────┼─ P2-34 local vision + embeddings + checker model (+P2-21)
       └─ P2-33 hf import ─┘
P2-17 ─┬─ P2-35 subscriptions     P2-02 + P2-03 + P2-10 ── P2-37 encrypted store
       └─ P2-36 compare
cleanups, independent: P2-09 hub dead code, P2-10 secrets, P2-11 channels exception (+P2-01)
review 4: P2-23 ── P2-45 manifests ─┬─ P2-20 (above)     P2-42 ── P2-46 permissions fail closed
                                    └─ P2-47 cancel/progress, reviewed ── P2-24 wasm
          P2-49 trim/now_ms cleanup, independent
review 5: P2-17 ── P2-59 hedged redacts ── P2-20     P2-56 ── P2-60 Weak scheduler ── P2-38
          P2-51 ── P2-61 file URIs, undo ─┐          P2-55 + P2-57 ── P2-62 reviewed, GPU hold ── P2-38
          P2-38 ──────────────────────────┴─ P2-63 one redaction ── P2-64 Job, scheduled ask, check 1
everything ── P2-38 hub wiring, bridge deleted ─┬─ P2-39 e2e ──────┐
                                                ├─ P2-40 v2 plugins ┼─ P2-41 20 real tasks (owner)
                                                └─ P2-48 CLI verbs ─┘

```

P2-01 and P2-02 create every new module as a stub and add every new dependency, so no later
task shares a `lib.rs`, `Cargo.toml` or `Cargo.lock` with another, except P2-30 (scheduler's own
`Cargo.toml`), P2-37 (workspace rusqlite feature) and P2-38 (hub), which are ordered after
anything that shares those files. P2-02 waits for P2-01 (both change `Cargo.lock` and
INTERFACES.md). P2-03, P2-09 and P2-10 can start at once.

Shared files and the order they force: `openai.rs` P2-04 → P2-17; `router.rs`/`catalog.rs`
P2-05 → P2-17; `gateway.rs` P2-06 → P2-07 → P2-08; `ask.rs` P2-06 → P2-29; `host.rs` P2-02 →
P2-22 → P2-23 → P2-45 → P2-47 → P2-24; `serve.rs` P2-22 → P2-44 → P2-47; `permissions.rs` P2-12 →
P2-42 → P2-46; hub `main.rs`/`tests/cli_p2.rs` P2-38 → P2-48; `local.rs` P2-31 → P2-34; `upcalls.rs` P2-21 → P2-34; store `secrets.rs`
P2-10 only; store `db.rs` P2-03 → P2-37; hub `main.rs` P2-10 → P2-38; `invariants.mjs` P2-11 →
P2-38. Every Turn literal in core, gateway and hub tests is touched by P2-07 only.

Can run together: P2-01 ∥ P2-03 ∥ P2-09 ∥ P2-10. After P2-01: P2-02 ∥ P2-04 ∥ P2-05 ∥ P2-06 ∥
P2-11 ∥ P2-12 ∥ P2-13 ∥ P2-14 ∥ P2-15 ∥ P2-16 ∥ P2-31 ∥ P2-32 ∥ P2-33 (and P2-19, P2-30 once
P2-03 is in). After P2-20: P2-21 ∥ P2-25 ∥ P2-26 ∥ P2-27 ∥ P2-28 (each owns its file; `agent.rs`
already calls their stub functions, which P2-01 created with their final signatures).

## Tasks

Crate paths are under `v3/crates/`.

| ID | Title | Model | Depends on | Touches |
|---|---|---|---|---|
| P2-01 | Core P2 types, module stubs, dependencies, INTERFACES.md | opus | P1-18 | `v3/Cargo.toml`, `v3/Cargo.lock`, `v3/specs/INTERFACES.md`, `alexia-core/{Cargo.toml, src/lib.rs, src/bus.rs, src/run.rs, src/<18 modules>.rs (stubs), tests/types_p2.rs}` |
| P2-02 | MCP host P2 interfaces: host calls, reviewed, wasm stub | opus | P2-01 | `v3/Cargo.lock`, `v3/specs/INTERFACES.md`, `alexia-mcp/{Cargo.toml, src/lib.rs, src/wasm.rs (stub), src/host.rs, tests/types_p2.rs}` |
| P2-03 | Store: migration 3 (audit, live runs, approvals, jobs) | opus | none | `alexia-store/{src/lib.rs, src/types.rs, src/db.rs, src/migrations.rs, tests/p2.rs}` |
| P2-04 | Tools on the OpenAI-compatible wire | opus | P2-01 | `alexia-core/{src/openai.rs, tests/openai.rs}` |
| P2-05 | Candidates know tools, vision and context; rank by what a request needs | opus | P2-01 | `alexia-core/{src/catalog.rs, src/router.rs, tests/router.rs, tests/catalog.rs}` |
| P2-06 | The asker exists before the gateway | opus | P2-01 | `alexia-gateway/{src/lib.rs, src/gateway.rs, src/ask.rs, tests/gateway.rs, tests/ask_voice.rs}` |
| P2-07 | Steering into a running run | opus | P2-06 | `alexia-core/{src/brain.rs, tests/types.rs, tests/chat.rs, tests/lane.rs}`, `alexia-gateway/{src/gateway.rs, tests/gateway.rs}`, `alexia-hub/src/bridge.rs` |
| P2-08 | Media takes a cancel token | sonnet | P2-07 | `alexia-gateway/{src/channel.rs, src/voice.rs, src/gateway.rs, tests/ask_voice.rs}`, `alexia-hub/src/media.rs` |
| P2-09 | Hub: dead code and stale allow(dead_code) | sonnet | none | `alexia-hub/src/{latency.rs, watchdog.rs}` |
| P2-10 | Secrets: no echo, read errors kept, in-memory only for tests | opus | none | `alexia-store/{src/secrets.rs, tests/secrets.rs, tests/v2_secrets.rs}`, `alexia-hub/{src/main.rs, tests/cli_p1.rs}` |
| P2-11 | Channels exception narrowed to service names | sonnet | P2-01 | `v3/ci/invariants.mjs`, `alexia-gateway/src/channels/mod.rs` |
| P2-12 | Permission modes, scope, never-touch, spoken boundaries | opus | P2-01 | `alexia-core/{src/permissions.rs, tests/permissions.rs}` |
| P2-13 | The safety checker | opus | P2-01 | `alexia-core/{src/checker.rs, tests/checker.rs}` |
| P2-14 | Redaction before cloud | opus | P2-01 | `alexia-core/{src/redact.rs, tests/redact.rs}` |
| P2-15 | Trimming the step trace | opus | P2-01 | `alexia-core/{src/trim.rs, tests/trim.rs}` |
| P2-16 | System prompt, skills, injection guard | opus | P2-01 | `alexia-core/{src/prompt.rs, tests/prompt.rs}` |
| P2-17 | Router for task steps: model per job, $0 cap, catalog news | opus | P2-04, P2-05, P2-14 | `alexia-core/{src/router.rs, src/catalog.rs, tests/router_steps.rs}` |
| P2-18 | Tooling over the MCP host | opus | P2-02 | `alexia-core/{src/tools.rs, tests/tools.rs}` |
| P2-19 | Trace, runs and the audit log | opus | P2-01, P2-03, P2-14 | `alexia-core/{src/trace.rs, tests/trace.rs}` |
| P2-20 | The agent loop | opus | P2-07, P2-12, P2-13, P2-14, P2-15, P2-16, P2-17, P2-18, P2-19, P2-45, P2-59 | `alexia-core/{src/agent.rs, tests/agent.rs}` |
| P2-21 | Upcalls: sampling, tasks for plugins, elicit, roots, attachments | opus | P2-20, P2-02 | `alexia-core/{src/upcalls.rs, tests/upcalls.rs}` |
| P2-22 | MCP: compute/run locally, host-answered capabilities | opus | P2-02 | `alexia-mcp/{src/serve.rs, src/host.rs, src/bin/mcp-fixture.rs, tests/compute.rs}` |
| P2-23 | Hot reload of plugins | opus | P2-22 | `alexia-mcp/{src/host.rs, src/supervise.rs, tests/reload.rs}` |
| P2-24 | WASM plugins in a capability sandbox | opus | P2-23, P2-47 | `alexia-mcp/{src/wasm.rs, src/host.rs, fixtures/wasm-hello/**, tests/fixtures/wasm-hello.wasm, tests/wasm.rs}` |
| P2-25 | Commands | opus | P2-20, P2-45 | `alexia-core/{src/commands.rs, tests/commands.rs}` |
| P2-26 | Resume after restart; jobs that run for days | opus | P2-20 | `alexia-core/{src/resume.rs, tests/resume.rs}` |
| P2-27 | Parallel helpers | opus | P2-20 | `alexia-core/{src/helpers.rs, tests/helpers.rs}` |
| P2-28 | Undo | opus | P2-20 | `alexia-core/{src/undo.rs, tests/undo.rs}` |
| P2-29 | Approvals inbox | opus | P2-03, P2-06, P2-08 | `alexia-gateway/{src/ask.rs, tests/approvals.rs}` |
| P2-30 | Scheduled jobs | opus | P2-01, P2-03 | `alexia-scheduler/{Cargo.toml, src/lib.rs, tests/scheduler.rs}`, `v3/Cargo.lock` |
| P2-31 | Managed llama.cpp, speculative decoding | opus | P2-01 | `alexia-core/{src/local.rs, tests/local.rs}` |
| P2-32 | GPU: fit, load cap, steps aside for games | opus | P2-01 | `alexia-core/{src/gpu.rs, tests/gpu.rs}` |
| P2-33 | Hugging Face import and GGUF split files | opus | P2-01 | `alexia-core/{src/hf.rs, tests/hf.rs}` |
| P2-34 | Local vision, local embeddings, the local checker model | opus | P2-31, P2-32, P2-33, P2-21 | `alexia-core/{src/local.rs, src/upcalls.rs, tests/local_jobs.rs}` |
| P2-35 | Subscriptions through their official CLIs | opus | P2-17 | `alexia-core/{src/subscription.rs, tests/subscription.rs}` |
| P2-36 | Compare two models | sonnet | P2-17 | `alexia-core/{src/compare.rs, tests/compare.rs}` |
| P2-37 | Encrypted database at rest | opus | P2-02, P2-03, P2-10 | `v3/Cargo.toml`, `v3/Cargo.lock`, `alexia-store/{Cargo.toml, src/db.rs, src/encrypt.rs, src/lib.rs, src/import.rs, tests/encrypt.rs}` |
| P2-38 | Hub wiring: Agent is the brain, bridge deleted | opus | P2-08..P2-11, P2-20..P2-37, P2-42, P2-44, P2-45, P2-46, P2-47, P2-50, P2-60, P2-62 | `alexia-hub/{Cargo.toml, src/main.rs, src/bridge.rs (delete), src/media.rs, tests/cli_p2.rs}`, `alexia-gateway/src/gateway.rs` (delete P2-06's shims), `v3/Cargo.lock`, `v3/ci/invariants.mjs` |
| P2-39 | End-to-end: the agent on the real binary | sonnet | P2-38 | `alexia-hub/tests/{agent_e2e.rs, telegram_e2e.rs, common/mod.rs}` |
| P2-40 | Every v2 plugin on the Rust host | sonnet | P2-38 | `alexia-hub/tests/v2_plugins.rs` |
| P2-41 | Twenty real tasks on the PC | sonnet | P2-39, P2-40, P2-48 | `v3/ops/reports/P2-tasks.md` |
| P2-42 | Permissions fail closed: trailing dots, bad boundary entries | sonnet | P2-12 | `alexia-core/{src/permissions.rs, tests/permissions.rs}` |
| P2-43 | telegram_e2e ack check survives a loaded machine | sonnet | none | `alexia-hub/tests/telegram_e2e.rs` |
| P2-44 | compute/run: checked path used; copies no collide/leak | sonnet | P2-22 | `alexia-mcp/{src/serve.rs, tests/compute.rs}` |
| P2-45 | McpHost::manifests, the agent's source of plugin commands and skills | sonnet | P2-23 | `alexia-mcp/{src/host.rs, tests/manifests.rs}` |
| P2-46 | Permissions fail closed: kv read errors, unannotated deletes, ~ and file:// paths | opus | P2-42 | `alexia-core/{src/permissions.rs, tests/permissions.rs}` |
| P2-47 | MCP: plugin requests keep their cancel and progress; tools unreviewed until read | opus | P2-45 | `alexia-mcp/{src/conn.rs, src/host.rs, src/serve.rs, src/bin/mcp-fixture.rs, tests/conn.rs, tests/compute.rs}` |
| P2-48 | Hub: the P2 CLI verbs | opus | P2-38 | `alexia-hub/{src/main.rs, tests/cli_p2.rs}` |
| P2-49 | Small cleanups: trim's helpers private, one now_ms | sonnet | none | `alexia-core/{src/trim.rs, tests/trim.rs}`, `alexia-gateway/src/channels/telegram/mod.rs` |
| P2-51 | Core safety edges: odd file URIs, skill symlinks, secret-named JSON keys | opus | none | `alexia-core/{src/permissions.rs, tests/permissions.rs, src/prompt.rs, tests/prompt.rs, src/redact.rs, tests/redact.rs}`, `v3/specs/INTERFACES.md` |
| P2-52 | rust-version 1.87 | sonnet | none | `v3/Cargo.toml` |
| P2-53 | OpenAI wire: unanswered calls, odd delta shapes, nameless calls | sonnet | none | `alexia-core/{src/openai.rs, tests/openai.rs}` |
| P2-54 | Store: encryption survives a crash, no keychain in tests; resumed runs keep their start | opus | P2-51 | `alexia-store/{src/encrypt.rs, src/db.rs, tests/encrypt.rs, tests/p2.rs}`, `alexia-core/{src/trace.rs, tests/trace.rs}`, `v3/specs/INTERFACES.md` |
| P2-55 | MCP: a cancel that beats its request still reaches it; WASM compiles off the runtime | opus | P2-52 | `alexia-mcp/{src/conn.rs, tests/conn.rs, src/wasm.rs, src/host.rs, tests/wasm.rs}` |
| P2-56 | Scheduler: a cut-short one-shot survives shutdown; Every never overlaps itself | opus | none | `alexia-scheduler/{src/lib.rs, tests/scheduler.rs}` |
| P2-57 | Local models: hashing off the runtime, cache repair, plain paths; GPU parsing and games | sonnet | none | `alexia-core/{src/hf.rs, tests/hf.rs, src/gpu.rs, tests/gpu.rs}` |
| P2-58 | Gateway: a waiting file message is not overtaken by steers; tests wait for events | sonnet | P2-38 | `alexia-gateway/{src/gateway.rs, tests/gateway.rs}` |
| P2-59 | Chat lane redacted: Router::hedged redacts every cloud request | opus | P2-17 | `alexia-core/{src/router.rs, tests/router.rs, tests/router_steps.rs, tests/chat.rs}` |
| P2-60 | Scheduler tools hold a Weak<Scheduler>; no wiring cycle | opus | P2-56 | `alexia-scheduler/{src/lib.rs, tests/scheduler.rs}` |
| P2-61 | One file URI decoder; compute/run never opens a network path; undo stays in its plugin | opus | P2-51 | `alexia-mcp/{src/uri.rs, src/lib.rs, src/serve.rs, tests/compute.rs, tests/uri.rs}`, `alexia-core/{src/permissions.rs, tests/permissions.rs, src/tools.rs, tests/tools.rs}` |
| P2-62 | New plugins start unreviewed; the GPU watcher hands the hub what it needs | opus | P2-55, P2-57 | `alexia-mcp/{src/host.rs, src/supervise.rs, tests/hold.rs}`, `alexia-core/{src/gpu.rs, tests/gpu.rs}` |
| P2-63 | One redaction of secrets, in alexia-mcp | opus | P2-38, P2-61 | `alexia-mcp/{Cargo.toml, src/redact.rs, src/process.rs, src/lib.rs, tests/conn.rs, tests/redact.rs}`, `v3/Cargo.lock`, `alexia-core/{src/redact.rs, tests/redact.rs}` |
| P2-64 | After the wiring: one Job Object, scheduled approvals in their own chat, a stricter plugin-name check | sonnet | P2-38, P2-63 | `alexia-mcp/src/lib.rs`, `alexia-core/src/local.rs`, `alexia-gateway/{src/ask.rs, tests/approvals.rs}`, `v3/ci/invariants.mjs`, `// invariant:` comments on flagged lines |
| P2-65 | Store: test folders cleaned up, a keychain probe per process, a plain leftover kept until its key proves right | opus | P2-54 | `alexia-store/{tests/scratch/mod.rs, tests/channels.rs, tests/import.rs, tests/store.rs, tests/p2.rs, tests/encrypt.rs, src/secrets.rs, src/encrypt.rs}` |
| P2-66 | MCP: test folders cleaned up | sonnet | P2-55, P2-61 | `alexia-mcp/tests/{scratch/mod.rs, alexia_layer.rs, compute.rs, host.rs, manifest.rs, manifests.rs, purge.rs, reload.rs, supervise.rs, types_p2.rs, wasm.rs}` |
| P2-67 | Core: test folders cleaned up; the registry export file is unique per call | opus | P2-61, P2-62 | `alexia-core/{tests/scratch/mod.rs, tests/catalog.rs, tests/chat.rs, tests/hf.rs, tests/local.rs, tests/permissions.rs, tests/prompt.rs, tests/tools.rs, src/gpu.rs, tests/gpu.rs}` |
| P2-68 | Router: notes per run, keychain keys cached, unreadable pins said out loud | opus | P2-20 | `alexia-core/{src/router.rs, tests/router_steps.rs, src/agent.rs}` |
| P2-69 | OpenAI wire: blank assistant text is empty; a call is answered only by the tool turns right after it | sonnet | none | `alexia-core/{src/openai.rs, tests/openai.rs}` |
| P2-70 | Gateway: a question that could not be sent is not a denial; test folders cleaned up | opus | P2-58, P2-64 | `alexia-gateway/{src/ask.rs, tests/approvals.rs, tests/scratch/mod.rs, tests/gateway.rs, tests/telegram_channel.rs}` |
| P2-71 | Hub and MCP conn tests: test folders cleaned up | sonnet | P2-39, P2-48, P2-63, P2-66 | `alexia-hub/{tests/scratch/mod.rs or tests/common/mod.rs, tests/cli.rs, tests/cli_p1.rs, tests/cli_p2.rs, tests/telegram_e2e.rs, tests/agent_e2e.rs, src/media.rs}`, `alexia-mcp/tests/conn.rs` |

## Owner needs

Asked a phase ahead, so nothing in P2 waits on them.

- **Confirm TR-06 is pulled in** (v3-plan *Parked*: SP-10's WASM plugins depend on it). P2-24
  sandboxes WASM plugins only; process plugins stay *declared, not enforced* (Alexia.md).
- **MO-05, which subscriptions.** P2-35 reaches a subscription only through the vendor's own
  signed-in CLI (Claude Code `claude`, OpenAI `codex`), never by copying a token. The owner says
  which, installs and signs in to each on the PC, reads each plan's terms for automated use, and
  confirms that using a plan already paid for does not break D212 (Alexia never starts a paid
  plan or pays per token). Off until `alexia-hub models use <job> subscription:<cli>`.
- **Where the checker runs.** Alexia.md wants a local checker; D213 says the GPU is not for chat.
  P2-34 runs it as an on-demand local job (a small model, unloaded after 10 minutes idle,
  stopped for games), like vision. Confirm, and accept the default model (the smallest instruct
  GGUF `gpu::fit` says fits). With no local model able to run, *Watch and warn me* asks instead.
- **SP-17 vs D213.** Speculative decoding only applies to a local model generating text: in P2
  the checker and plugins' `alexia/local` requests, never chat. Keep it at that scope, or drop it.
- **TR-09, the database key.** `alexia-hub encrypt` creates a random key in Credential Manager
  (`alexia` / `_core.store_key`) and encrypts the database in place. Losing the key loses
  everything. The owner decides how to back the key up; the hub never prints it.
- **Downloads on the PC.** The llama.cpp CUDA runtime (pinned `b11146`, about 650 MB with
  cudart) and any model imported. Optional Hugging Face token: `alexia-hub secret set hf_token`.
- **Game folders** for MO-09 beyond Steam's and Epic's default libraries:
  `alexia-hub models games add <folder>`.
- **Folders Alexia may work in on the PC** (TR-01 scope). Until some are chosen, every call that
  names a path asks. `alexia-hub scope add <folder>`. The permission mode is v2's imported
  `_core.mode`, default *Ask before anything risky*.
- **Plugin secrets on the PC.** Plugins' `password` settings resolve on the hub:
  `alexia-hub secret set <plugin>.<key>` (or `secret import-v2` from P1-34).
- **Retire the bridge's v2 copy.** After P2-38 is merged and previewed, the owner may delete
  `%LOCALAPPDATA%\AlexiaBridge` and unset `ALEXIA_V2_*`. The v2 app on the Mac is untouched.
- **The 20 real tasks** for done-when 4 (P2-41).

## INTERFACES.md additions this phase makes

Written by P2-01 (core, gateway, store, scheduler, hub, §7, §8) and P2-02 (mcp), each in its own
commit. The task named after each implements it.

1. (P2-01) §2.3 `run` module: Step, ToolOutcome, Produced, UndoCall, ToolSpec, ToolCtx,
   `trait Tooling`, `trait Builtin`, Ruling, Scope, Boundary, Blocks, Struggle, Job, RunEnd,
   RunResult, LiveRun. `gate()`/`Gate` replaced by `permissions::rule() -> Ruling` (P2-12).
   `Limits.max_steps` default 24 (v2 `MAX_STEPS`). `Agent::new(AgentParts)` (P2-20).
   `Router::step` + `StepAsk` (P2-17). `Candidate.{tools, vision, context}` and `needs()` (P2-05).
   `pub fn ms_since(Instant) -> u32` (review 12). Every new module's public items.
2. (P2-01) §2.3/§2.4 the Ask seam (review 2): `alexia_gateway::Asker::new(channels: ChannelSet,
   store)` and `ChannelSet`, built before `Gateway::new(.., asker, ..)` (P2-06).
3. (P2-01) §2.3 steering (review 3): `Turn.steer: Steer`, `Steer` (cloneable receiver of extra
   user messages), `DraftFrame::Steerable` (P2-07).
4. (P2-01) §2.4 `Media::transcribe/speak` take a `CancellationToken` (review 11, P2-08).
5. (P2-01) §1.2/§2 every public item the code already has and the spec lacks (review 12):
   reqwest `multipart`, `McpHost::scan`, `Manifest::password_keys`, `import_v2_files`,
   `Catalog::{refresh, candidates, row}`, `OpenAiCompat::with_timeouts`,
   `catalog::{chats, routes, size_of, same}`, `Telegram::pairing_code`.
6. (P2-01) §2.1 and §5.3: migration 3 as P2-03 writes it; `jobs`/`job_runs` move from 4 to 3.
   `secrets::MEMORY_BACKEND_ENV` honoured only as P2-10 says.
7. (P2-01) §2.5: P2's `Scheduler` is `At | Every | Daily`; `Watch` and `Quiet` stay V3-3.
8. (P2-01) §2.6: `V2Bridge`/`V2Config` removed; new CLI verbs; wiring without the bridge.
9. (P2-01) §3.5: `alexia/undo` `{tool, arguments, summary}` on `CallToolResult._meta`, read
   (P2-18, P2-28). v3-only; v2 ignores it; `docs/spec/` is not changed this phase.
10. (P2-01) §7: check 1's `channels/` exception narrowed (P2-11); check 11, no v2 core (P2-38);
    check 4's re-plan half (P2-20). §8 item 9: `channels::v2_secret_names` names v2's plugin
    account on purpose, to import it once (review 6).
11. (P2-02) §2.2: `Upcalls::host_call` (default: not mine), `HostedTool.reviewed`,
    `McpHost::reload`, `PluginState::Reloading`; §3.2 `entry.run == "wasm"`.
12. (review-4 planner, already written) §2.2 `McpHost::manifests` (P2-45), `conn::Incoming::request`
    with cancel and progress, `reviewed` built false (P2-47); §2.3 `Trace::resume`, `Task.steps_done`,
    `AgentParts.host`, `Agent::host`, constructors first (P2-19, P2-20), `permissions` fail-closed
    behaviour (P2-46); §2.6 the construction order in eleven steps (P2-38).
13. (review-5 planner, already written) §2.2 `file_uri_path`, `is_network_path` (P2-61),
    `redact_secrets`, `redact`, `is_secret_key` (P2-63), `pub use job::Job` (P2-64), `reviewed`
    for new plugins, `McpHost::{hold, release, set_reviewed}` (P2-62); §2.3 `Router::hedged`
    redacts (P2-59), `gpu::GpuEvent` and `Watch::run` (P2-62); §2.5 `ScheduleTools` holds a
    `Weak` (P2-60); §2.6 steps 4, 6 and 11 without the scheduler cycle (P2-38).


## Risky or unclear (decided here, owner may overrule)

- **"v2 core is retired"** means the hub no longer runs or needs v2 core. v2's code and the v2
  app on the Mac stay as they are (hard rule: v2 keeps working). Deleting `packages/core` is in
  no phase yet.
- **v2's paid tiers are not ported.** v2's router has T2/T3, the paid switch, allowances and
  pauses. v3 never pays (D212), so MO-12 is a cap fixed at $0: a model whose price is not known
  to be zero is never asked, and a cost > 0 reported by a provider is a loud warning that sets the
  model aside. No pause/allow flow.
- **Undo needs plugins to say how.** MCP has no undo. P2-28 undoes what core did (settings,
  schedules) and any call whose result carries `_meta["alexia/undo"]`; nothing else claims to be
  undoable.
- **llama-server listens on loopback.** It is a child on `127.0.0.1`, a random port and an API
  key; the hub itself still opens no port.
- **WASM fixture is a committed binary** (`tests/fixtures/wasm-hello.wasm`, built from source in
  `fixtures/wasm-hello/` by a documented command), so CI needs no `wasm32-wasip1` target.
