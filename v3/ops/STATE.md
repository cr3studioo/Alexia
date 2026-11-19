# STATE

CEO: #8 (chat CEO, A-08). Round 1 of this run. Orca run run_7a40b198ac83.
Phase: P0 merged 20/20; review follow-ups P0-21..P0-25 (ready: P0-21, P0-23; running P0-24; todo P0-22, P0-25).
P1 (V3-1 Telegram fast): merged P1-01..P1-04, P1-14. Ready: P1-07, P1-09, P1-13 (all opus).
Running (live Orca workers; wait for worker_done):
- P1-05 build (opus) ctx_87081118145d. Regexes ported by hand (decided).
- P1-11 build (opus) ctx_8ddd88f91663, continues commit 01ffde9 from an earlier attempt.
- P1-16 build (sonnet) ctx_39226e05765c.
- P0-24 build (sonnet) ctx_a47d0c516c4b.
- P1-15 review (opus) ctx_798dd98bcdaf. Approve -> merge.
Merge count since the P0 phase review: 1 (P1-04).
Design note for the V3-1 library uninstall planner: purge after vanish returns UnknownPlugin (host.rs:551, :914).
Critical path for P1: P1-04 -> P1-05 -> P1-06 -> P1-08 -> P1-17 -> P1-18. Also P1-09 -> P1-10 and P1-11 -> P1-12.
Open owner asks: A-09 (test bot, free provider key names, OK to race two providers), no reply. Only P1-18 waits on it. A-10 is a notice.
Telegram: vars set (user env; read via PowerShell GetEnvironmentVariable User). getUpdates is empty; no update_id processed yet.
pnpm check on Windows: known pre-existing failures that merges did not cause: compute-connect 'a paused request reader stalls uploads too' (always), compute-plugins 'cancelling a plugin tool propagates' and plugins/media compute 'ComfyUI the person is running' (load-flaky). Gate v2-path merges on lint, typecheck and invariants being green, with test failures limited to these.
CI: .github/workflows/v3.yml runs on pushes to cr3studioo/v3 and cr3studioo/v3-*. Rust is pinned to 1.96.1 (stable 1.100 moved the test exes). The v2 conformance tests run serially. node v3/ci/invariants.mjs is now a local gate too.
C:\dev\Alexia-wt\base2: detached worktree WITH node_modules, for running pnpm on a commit (git checkout --detach <sha> there). The base\ and plan-P1\ folders are locked leftovers, not worktrees. Delete them when free.
Helpers in C:\dev\Alexia-wt: wait.sh (background wait loop, filters heartbeats), msgs.py (parses check output), template.sh (source it; `start <id> <phase> <model> ['extra rule']` creates the worktree and dispatches the standard builder prompt; `mk` prints the prompt). start does NOT update BOARD.md; edit rows by ID with a split-on-| script. A regex on 'P1-01' also hits the Depends column.
Every builder prompt: no fake credentials in any key shape (even split); generous timing bounds in tests.
Later-spec notes: P1-09/P1-10 tests reach alexia_gateway::channels::telegram::api (now pub, doc(hidden)).
