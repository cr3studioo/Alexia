# STATE

CEO: #10 next (chat CEO, A-08). CEO #9 handed off at a clean point (no approved branch unmerged).
Orca run: run_7a40b198ac83 (bind with run-use). Helpers in C:\dev\Alexia-wt: wait.sh, msgs.py, template.sh (source; `start <id> <phase> <model> [extra rule]`), rv.sh (source; `rv <id> <phase>` dispatches the standard opus review). Fix rounds: file like fix-P1-13.txt, dispatch with --spec "$(cat file)" in the task worktree.
P0: all 25 merged. P0-26 (de-flake conn.rs junk_is_skipped_and_logged, sonnet) running.
P1 merged: P1-01..P1-06, P1-09, P1-11, P1-14, P1-15, P1-16, P1-19, P1-20, P1-22.
Live Orca workers (wait for worker_done):
- P1-08 build (opus) ctx_d6df95888b92. Allowed by CEO answer to make alexia-mcp process::redact public (process.rs + lib.rs, 2 lines).
- P1-13 re-review (opus) ctx_01fc0222f8ed, after fix round 1 (try 2).
- P1-21 review ctx_00b95a0f5956.
- P1-24 review ctx_0f7a6c70cacd (also judges plugins/media models.test.js bytes=500- failure vs base).
- P0-26 build (sonnet) ctx_d965db584aa9.
Queued: P1-10 fix round 1 (opus, try 2): C:\dev\Alexia-wt\fix-P1-10.txt, worktree C:\dev\Alexia-wt\P1-10 exists. Dispatch it in the first free opus slot.
Ready (opus): P1-23 (gateway tracker), P1-07 (lanes), P1-12 (approvals/voice). Todo: P1-17 (needs P1-07, P1-08, P1-10, P1-12, P1-13), P1-18 (needs P1-17, A-09), P1-25 (needs P1-17, P1-20, P1-22, P1-23, P0-25).
Critical path: P1-08 -> P1-17 -> P1-18. P1-10 fix, P1-12, P1-07, P1-13 also feed P1-17.
Opus cap (2 builders) is the bottleneck. Reviewers are not counted, but the 5-worker cap counts everyone.
Merges since the last phase review: 5 (P0-22, P1-20, P1-22, P1-06, P0-25).
Follow-ups to plan (no spec yet): (1) Turn has no files field, so documents cannot reach V2Bridge (needs alexia-core Turn change; plan before or with P1-17). (2) De-flake alexia-mcp tests/supervise.rs call_at_idle_deadline_never_gone (new in P0-22, flaked under load in the P1-13 fix run). (3) P1-22 skips tool rows on the no-tools path; V3-2 must map calls/call_id when tools are sent.
Open owner asks: A-09 (test bot, free provider key names, OK to race two providers), no reply. Only P1-18 waits on it. A-10 is a notice.
Telegram: vars set (user env; read via PowerShell GetEnvironmentVariable User). getUpdates empty at handoff; no update_id processed yet.
pnpm check on Windows: known pre-existing failures: compute-connect 'a paused request reader stalls uploads too' (always), compute-plugins 'cancelling a plugin tool propagates' and plugins/media compute 'ComfyUI the person is running' (load-flaky). Possibly also plugins/media models.test.js bytes=500- (P1-24 reviewer is checking).
CI: .github/workflows/v3.yml runs on pushes to cr3studioo/v3 and cr3studioo/v3-*. node v3/ci/invariants.mjs (run from repo root) is a local merge gate; it rejects C:\ even inside message strings in src/.
v2 conformance test: --features v2-conformance, run in C:\dev\Alexia-wt\base2 (detached, has node_modules) with ALEXIA_V2_PLUGINS=C:\dev\Alexia-wt\base2\plugins.
Every builder prompt: no fake credentials in any key shape; generous timing bounds; no hard-coded absolute paths in src/.
Leftover folders base\ and plan-P1\ in C:\dev\Alexia-wt are locked non-worktrees; delete when free.
