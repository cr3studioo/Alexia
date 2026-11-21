# Phase review 5: v3 workspace, merges 4f5c7fd..HEAD (cr3studioo/v3 @ 4dcc604)

Read-only review; no cargo run. `node v3/ci/invariants.mjs` passes. Items already in HANDOFF.md
"Follow-ups from reviews" are not repeated.

## Checked and fine
- Invariant: no source names a plugin outside a capability name (`memory.profile`, `voice.transcribe`, ...);
  channel exceptions are marked. Plugin ids are `[a-z0-9-]` (manifest.rs:422), so no plugin can get the
  `_core` kv namespace through `alexia/kv.*` (serve.rs:78).
- Crate graph matches INTERFACES §1.1 (store ← mcp ← core ← {gateway, scheduler} ← hub; limb → mcp).
- `todo!()` stubs left: agent (P2-20), upcalls (P2-21), commands (P2-25), resume (P2-26), helpers (P2-27),
  undo (P2-28), LocalJobs (P2-34), subscription (P2-35), compare (P2-36). Every one has an owner.
  `Router::step`/`StepAsk`/pins are missing, owned by P2-17 (running).
- Raw SQL is refused (namespace.rs:412). WASM: no inherit, empty env, `/data` preopen only, fuel + epoch + memory cap.
- Unused pub fns (`ensure`, `import_repo`, `set_upcalls`, `resume_all`, `set_local_jobs`, ...) are all for P2-38/P2-48.

## Findings

1. **high**: `crates/alexia-core/src/chat.rs:249` (`Router::hedged`, router.rs:227).
   The chat lane, which answers most turns, sends its requests to free cloud providers without redaction:
   history, recalled memory, profile and the new turn. v2's router.ts redacted every cloud call. P2-17 only
   redacts `Router::step`, and compare (P2-36) will use the same unredacted path.
   **Fix:** redact inside `hedged` (non-local providers), so `step`, FastChat and compare all go through
   `redact_request`. This changes the P2-17 spec line.

2. **high**: INTERFACES.md §2.6 step 4 vs `crates/alexia-scheduler/src/lib.rs:137,330`.
   `Scheduler::new` takes the brain (the Agent), and `Scheduler::tools()` needs that `Arc<Scheduler>`.
   Step 4 says to put the scheduler's builtins into `McpTooling::new` before the Agent exists (step 5).
   That is a cycle, so P2-38 cannot follow the order as written. If it is forced with `Arc`s, it also
   creates a strong cycle: Agent → tooling → ScheduleTools → Scheduler → Agent. Helpers and Undo use
   `Weak` to avoid exactly that.
   **Fix:** amend §2.6 so step 4 is `McpTooling::new(host, vec![])`. Step 11 builds `Scheduler::new(.., agent)`
   and then calls `tooling.add_builtin(scheduler.tools())`, which is already allowed after construction.
   Have ScheduleTools hold a `Weak<Scheduler>`.

3. **medium**: `crates/alexia-mcp/src/serve.rs:205,238,280,331` (compute/run).
   `inside()` calls `fs::canonicalize` on a path the plugin supplies (`inputs[].path`) and on the worker's
   `resource_link` URI. This happens before the roots check. `\\host\share\x` or `file:////host/share/x`
   makes Windows open SMB to that host, which can leak NTLM. `file_uri_path` there also ignores the URI's
   host. P2-50 fixed this only in core's tools.rs.
   **Fix:** reject UNC, `\\?\UNC\` and non-local URI hosts before any filesystem call, using the shared
   decoder from finding 4.

4. **medium**: three `file://` decoders: `alexia-core/src/permissions.rs:332,374`, `alexia-core/src/tools.rs:240`
   and `alexia-mcp/src/serve.rs:214,238`. They follow different rules for hosts, drive-relative `/x` and UNC.
   So the gate can judge a different path from the one the acting code uses.
   **Fix:** one `pub fn file_uri_path` in alexia-mcp (the lowest crate that needs it), used by permissions,
   tools and serve.

5. **medium**: `crates/alexia-core/src/tools.rs:197-215`.
   A plugin's `_meta["alexia/undo"]` keeps its target unchanged when it names another installed plugin's
   `<id>__tool` or any core builtin (`schedule`, `helpers.run`, ...). One plugin can therefore plant an
   "undo" that runs another plugin's tool or a core builtin. This is a confused deputy, even though undo is
   gated.
   **Fix:** always namespace the undo target to the plugin that returned it, and drop it if it names a
   builtin or another plugin.

6. **medium**: `crates/alexia-mcp/src/host.rs:360-382`.
   `reviewed` comes from a denylist (`_core.unreviewed`) that no v3 code ever writes. Only the v2 import
   fills it. Any newly dropped-in plugin, including a third-party MCP-compat server, is therefore
   `reviewed: true`, and its own `readOnlyHint` lets calls run unasked in AskRisky. That is fail-open.
   **Fix:** default unseen plugin ids to unreviewed (the scan appends them to `_core.unreviewed` and an owner
   verb removes them), or switch to a `_core.reviewed` allowlist seeded from the v2 import.

7. **medium**: `crates/alexia-core/src/gpu.rs:406-410`.
   `Watch::run` takes sync `Fn()` callbacks and no process list. §2.6 step 11 needs async
   `Runtime::stop_all`, `McpHost::stop` for the plugins using the GPU, and `set_paused(true/false)`. P2-38
   would have to spawn detached tasks and run nvidia-smi a second time to find the PIDs. Also, a stopped
   lazy plugin respawns on its next call while the game is still running.
   **Fix:** pass `&[GpuProc]` to `step_aside` and take async callbacks (or send events over an mpsc), and give
   McpHost a "don't spawn GPU plugins while paused" flag.

8. **medium**: two ports of v2 `redactSecrets`, at `crates/alexia-mcp/src/process.rs:195` (hand-written
   matchers, `•••`) and `crates/alexia-core/src/redact.rs` (regex, `[redacted]`). chat.rs:295 uses the mcp
   one for memory capture. They will drift, and a secret one catches may pass the other.
   **Fix:** keep one implementation in alexia-mcp and make `core::redact::redact_secrets` call it.

9. **low**: `crates/alexia-core/src/local.rs:483-610`.
   This is a second hand-written Job Object FFI, with its own kernel32 struct layouts and `#[allow(unsafe_code)]`
   in core. INTERFACES says only alexia-mcp's job code opts out, and `alexia_mcp::job` already does this.
   **Fix:** make `alexia_mcp::job::Job` public (pub use) and reuse it from local.rs.

10. **low**: `crates/alexia-gateway/src/ask.rs:61` with `crates/alexia-scheduler/src/lib.rs:278`.
    A scheduled turn carries `Origin::Scheduler`, so its approval questions go to the first channel's primary
    chat, not the chat that created the job. The job row stores that origin.
    **Fix:** let the Asker look up the job's stored origin for `Origin::Scheduler`, with the primary chat
    only as the fallback.

11. **low**: `v3/ci/invariants.mjs:58`.
    The plugin-name check only matches an id as a whole quoted literal. Ids inside a string pass, such as
    the planned `"subscription:claude-code"` (P2-35) next to `plugins/claude-code`, and so do ids in
    `format!` pieces. The check is weaker than §0.1.
    **Fix:** also match ids at word boundaries inside string literals, with an explicit `// invariant:`
    allow-comment for real exceptions.
