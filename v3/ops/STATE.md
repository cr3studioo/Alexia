# STATE

CEO: #8 next (chat CEO, A-08). CEO #7 handed off because Phase 0 was fully merged (rounds 13-15).
Phase: P0 (V3-0 skeleton) is merged: P0-01..P0-20, 20/20. G-P0 notice sent (A-10, no wait per A-03).
P1 (V3-1 Telegram fast): merged P1-01, P1-02, P1-03, P1-14. Ready: P1-07, P1-09, P1-13 (all opus).
Running (Orca run run_7a40b198ac83). All are live workers; wait for their worker_done:
- P1-04 re-review (opus) ctx_777b035eb210, worktree C:\dev\Alexia-wt\P1-04. Approve -> merge -> P1-05 ready.
- P1-11 build (opus) ctx_6020295b50a7, C:\dev\Alexia-wt\P1-11. Then opus review, merge.
- P1-15 build (sonnet) ctx_3d4e57320c00, C:\dev\Alexia-wt\P1-15. Then review, merge.
- P1-16 build (sonnet) ctx_669d952b5bc3, C:\dev\Alexia-wt\P1-16. Then review, merge.
- P0 whole-phase review (opus) ctx_a1fa6738f47e, detached worktree C:\dev\Alexia-wt\P0-review
  (remove it after). Its TASKS become new P0-2x specs/board rows. Merge count is 0 since it.
Critical path for P1: P1-04 -> P1-05 -> P1-06 -> P1-08 -> P1-17 -> P1-18. Also P1-09 -> P1-10 and P1-11 -> P1-12.
Open owner asks: A-09 (test bot, free provider key names, OK to race two providers), no reply. Only P1-18 waits on it. A-10 is a notice.
Telegram: vars set (user env; read via PowerShell GetEnvironmentVariable User). getUpdates is empty; no update_id processed yet.
pnpm check on Windows: known pre-existing failures that merges did not cause: compute-connect 'a paused request reader stalls uploads too' (always), compute-plugins 'cancelling a plugin tool propagates' and plugins/media compute 'ComfyUI the person is running' (load-flaky). Gate v2-path merges on lint, typecheck and invariants being green, with test failures limited to these.
CI: .github/workflows/v3.yml runs on pushes to cr3studioo/v3 and cr3studioo/v3-*. Rust is pinned to 1.96.1 (stable 1.100 moved the test exes). The v2 conformance tests run serially. node v3/ci/invariants.mjs is now a local gate too.
C:\dev\Alexia-wt\base2: detached worktree WITH node_modules, for running pnpm on a commit (git checkout --detach <sha> there). The base\ and plan-P1\ folders are locked leftovers, not worktrees. Delete them when free.
Helpers in C:\dev\Alexia-wt: wait.sh (background wait loop, filters heartbeats), msgs.py (parses check output), template.sh (source it; `start <id> <phase> <model> ['extra rule']` creates the worktree and dispatches the standard builder prompt; `mk` prints the prompt). start does NOT update BOARD.md; edit rows by ID with a split-on-| script. A regex on 'P1-01' also hits the Depends column.
Every builder prompt: no fake credentials in any key shape (even split); generous timing bounds in tests.
Later-spec notes: P1-05 says 'keep v2 regexes', but core has no regex crate and P1-05 may not touch Cargo.toml. Decide before dispatching P1-05: allow alexia-core/Cargo.toml + Cargo.lock for regex, or port by hand. P1-09/P1-10 tests reach alexia_gateway::channels::telegram::api (now pub, doc(hidden)).
