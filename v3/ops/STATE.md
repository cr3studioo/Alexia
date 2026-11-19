# STATE

CEO: #10 running (chat CEO, A-08).
Orca run: run_7a40b198ac83 (bind with run-use). Helpers in C:\dev\Alexia-wt: wait.sh, msgs.py, template.sh (source; `start <id> <phase> <model> [extra rule]`), rv.sh (source; `rv <id> <phase>` dispatches the standard opus review). Fix rounds: file like fix-P1-13.txt, dispatch with --spec "$(cat file)" in the task worktree.
P0: all 25 merged. P0-26 (de-flake conn.rs) in review ctx_69127b377058.
P1 merged: P1-01..P1-06, P1-08, P1-09, P1-11, P1-13..P1-16, P1-19..P1-22.
Live Orca workers (wait for worker_done):
- P1-24 review (opus) ctx_0f7a6c70cacd (also judges plugins/media models.test.js bytes=500- vs base).
- P0-26 review (opus) ctx_69127b377058.
- P1-10 fix round 1 (opus builder, try 2) ctx_47b851e49707.
- P1-12 build (opus builder, try 1) ctx_57bb946afe73.
- Planner for follow-ups (opus) ctx_89d86a6448bb in worktree C:\dev\Alexia-wt\plan-fu, branch cr3studioo/v3-plan-fu (not pushed): writes P1-26+ specs. Merge that branch into cr3studioo/v3 (books commit), add its rows to BOARD, remove worktree.
Ready (opus, wait for a free opus builder slot): P1-07 (lanes), P1-23 (gateway tracker). Todo: P1-17 (needs P1-07, P1-10, P1-12), P1-18 (needs P1-17, A-09), P1-25 (needs P1-17, P1-23).
Integration gate: bash C:/dev/Alexia-wt/gate.sh after each merge (prints GATE OK or failures).
Critical path: P1-10 fix, P1-12, P1-07 -> P1-17 -> P1-18.
Opus cap (2 builders) is the bottleneck. Reviewers are not counted, but the 5-worker cap counts everyone.
Merges since the last phase review: 8 (P0-22, P1-20, P1-22, P1-06, P0-25, P1-08, P1-13, P1-21).
Follow-ups: being specced by the planner above (Turn files field, supervise.rs de-flake, chat.rs bounds/empty turns, P1-22 note).
Open owner asks: A-09 (test bot, free provider key names, OK to race two providers), no reply. Only P1-18 waits on it. A-10 is a notice.
Telegram: vars set (user env; read via PowerShell GetEnvironmentVariable User). getUpdates empty at handoff; no update_id processed yet.
pnpm check on Windows: known pre-existing failures: compute-connect 'a paused request reader stalls uploads too' (always), compute-plugins 'cancelling a plugin tool propagates' and plugins/media compute 'ComfyUI the person is running' (load-flaky). Possibly also plugins/media models.test.js bytes=500- (P1-24 reviewer is checking).
CI: .github/workflows/v3.yml runs on pushes to cr3studioo/v3 and cr3studioo/v3-*. node v3/ci/invariants.mjs (run from repo root) is a local merge gate; it rejects C:\ even inside message strings in src/.
v2 conformance test: --features v2-conformance, run in C:\dev\Alexia-wt\base2 (detached, has node_modules) with ALEXIA_V2_PLUGINS=C:\dev\Alexia-wt\base2\plugins.
Every builder prompt: no fake credentials in any key shape; generous timing bounds; no hard-coded absolute paths in src/.
Leftover folders base\ and plan-P1\ in C:\dev\Alexia-wt are locked non-worktrees; delete when free.
