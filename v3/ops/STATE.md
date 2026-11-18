# STATE

CEO: #7 next (chat CEO, A-08). CEO #6 handed off after 6 rounds (7-12). Phase: P0 (V3-0 skeleton) finishing; P1 (V3-1 Telegram fast) planned, 18 tasks.
P0 merged: P0-01..P0-13, P0-17. P1 merged: P1-03, P1-14.
Running (Orca run run_7a40b198ac83):
- P0-14 fix round (try 2), ctx_09570616babe, sonnet, worktree C:\dev\Alexia-wt\P0-14. After worker_done: re-review (opus), merge.
- P0-18 build (de-flake idle_lazy_plugin_stops), ctx_c1ef1998cf44, sonnet, worktree C:\dev\Alexia-wt\P0-18. Then review, merge.
Next: P0-14 merged -> P0-15 (sonnet) -> P0-16 (sonnet; builder prompt must allow .github/workflows/v3.yml and v3/ci/ only). P0-15 merged -> P1-01 (opus) -> P1-02 unlocks most of P1.
Open owner asks: A-09 (P1: test bot, free provider key names, hedging terms OK), sent on Telegram, no reply. Standing owner rules A-05..A-08 in OWNER.md.
Telegram: vars set (user env; read via PowerShell GetEnvironmentVariable User). Last update_id processed: none (getUpdates empty).
pnpm check on Windows: known pre-existing failures, not caused by merges: compute-connect 'a paused request reader stalls uploads too' (always), compute-plugins 'cancelling a plugin tool propagates' and plugins/media compute 'ComfyUI the person is running' (load-flaky). Gate v2-path merges on lint+typecheck+invariants green and test failures limited to these.
C:\dev\Alexia-wt\base2: detached worktree WITH node_modules for running pnpm on a commit (git checkout --detach <sha> there). Folders base\ and plan-P1\ are locked leftovers, not worktrees; delete when free.
Helpers: C:\dev\Alexia-wt\wait.sh (background wait loop, filters heartbeats), msgs.py (parse check output), template.sh (source it; start <id> <phase> <model> ['extra rule'] creates worktree + dispatches the standard builder prompt).
Every builder prompt: no fake credentials as one literal (build from halves); generous timing bounds in tests.
Follow-ups for later tasks: INTERFACES.md §3.3 optional fields omitted not null; P0-05 u64 > i64::MAX stored as REAL; alexia-store secrets::delete_all stops at first failing key (v2 tries each, secrets.rs:56) and is not atomic; tests/secrets.rs:12 uses real plugin id hello; INTERFACES.md §6 import rule (empty hub p_* replaced, non-empty refused); P0-12 spec idle row wording (idle = host last-call, matches v2); fixture mode for list_changed mid-tools/list; serve.rs idle-stop vs incoming call race (same as v2).
