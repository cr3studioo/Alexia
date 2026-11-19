# STATE

CEO: #10 running (chat CEO, A-08).
Orca run: run_7a40b198ac83 (bind with run-use). Helpers in C:\dev\Alexia-wt: wait.sh, msgs.py, template.sh (source; `start <id> <phase> <model> [extra rule]`), rv.sh (source; `rv <id> <phase>` dispatches the standard opus review). Fix rounds: file like fix-P1-13.txt, dispatch with --spec "$(cat file)" in the task worktree.
P0: all 26 merged.
P1 merged: P1-01..P1-16, P1-19..P1-24, P1-27.
Live Orca workers (wait for worker_done):
- P1-25 build (opus, try 1) ctx_9d1b12648b46: one time helper + brain spans measured from the turn (phase review 2 high finding).
- Planner ctx_42985a622eac in C:\dev\Alexia-wt\plan-fu2, branch cr3studioo/v3-plan-fu2 (not pushed): follow-up specs from P1-29. Merge into cr3studioo/v3, add rows to BOARD, remove worktree.
Next: P1-17 (sonnet, re-planned) when P1-25 merges. Then P1-26 (opus) and P1-28 (sonnet) after P1-17. P1-18 needs P1-17, P1-26 and A-09.
pnpm check: main checkout has no node_modules; run it in base2 (git checkout --detach <merge sha>, pnpm install --offline, pnpm check). compute-acceptance and provider.test also flake under load.
Integration gate: bash C:/dev/Alexia-wt/gate.sh after each merge (prints GATE OK or failures).
Critical path: P1-25 -> P1-17 -> P1-26 -> P1-18.
Opus cap (2 builders) is the bottleneck. Reviewers are not counted, but the 5-worker cap counts everyone.
Merges since the last phase review: 3 (P1-23, P1-10, P1-27).
Open owner asks: A-09 (test bot, free provider key names, OK to race two providers), no reply. Only P1-18 waits on it. A-10 is a notice.
Telegram: vars set (user env; read via PowerShell GetEnvironmentVariable User). getUpdates empty at handoff; no update_id processed yet.
pnpm check on Windows: known pre-existing failures: compute-connect 'a paused request reader stalls uploads too' (always), compute-plugins 'cancelling a plugin tool propagates' and plugins/media compute 'ComfyUI the person is running' (load-flaky). Possibly also plugins/media models.test.js bytes=500- (P1-24 reviewer is checking).
CI: .github/workflows/v3.yml runs on pushes to cr3studioo/v3 and cr3studioo/v3-*. node v3/ci/invariants.mjs (run from repo root) is a local merge gate; it rejects C:\ even inside message strings in src/.
v2 conformance test: --features v2-conformance, run in C:\dev\Alexia-wt\base2 (detached, has node_modules) with ALEXIA_V2_PLUGINS=C:\dev\Alexia-wt\base2\plugins.
Every builder prompt: no fake credentials in any key shape; generous timing bounds; no hard-coded absolute paths in src/.
Leftover folders base\ and plan-P1\ in C:\dev\Alexia-wt are locked non-worktrees; delete when free.
