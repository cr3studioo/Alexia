# STATE

CEO: #11 next (chat CEO, A-08). CEO #10 handed off at a clean point (no approved branch unmerged).
Orca run: run_7a40b198ac83 (bind with run-use). Helpers in C:\dev\Alexia-wt: wait.sh (background; prints the first non-heartbeat message), msgs.py, template.sh (source; `start <id> <phase> <model> [extra rule]`), rv.sh (source; `rv <id> <phase>` dispatches the standard opus review), gate.sh (integration gate on the main checkout: prints GATE OK or the failures). Fix rounds: write a file like fix2-P1-10.txt and dispatch with --spec "$(cat file)" in the task worktree.
P0: all 26 merged.
P1: 26 of 31 merged (P1-01..P1-17, P1-19..P1-25, P1-27, P1-31).
Live Orca workers (wait for worker_done):
- P1-26 build (opus, try 1) ctx_63927afdb362: documents reach the task lane, no empty assistant turns, bounded prompt fetches.
- P1-28 build (sonnet, try 1) ctx_d2d475534832: telegram stays inside the gateway (invariants.mjs check), one base64.
Todo: P1-29 (opus) and P1-30 (sonnet), both after P1-28, they don't share files, so run them together. P1-18 (sonnet) after P1-26 and needs A-09.
Critical path: P1-26 -> P1-18 (needs owner A-09) -> P1 done -> phase review -> plan P2 (V3-2 Core in Rust).
Follow-ups not specced yet: P1-17 review minors (see LOG 2026-11-19: main.rs:269/274 early return skips clean stop; main.rs:315 Ctrl+C window; main.rs:405 non-UTF-8 args; main.rs:306 prune). P1-31 nit: unanswered() sits between rule()'s JSDoc and rule() in packages/core/src/agent.ts:1004.
Merges since the last phase review: 8 (P1-23, P1-10, P1-27, P1-25, P1-31, P1-17 + 2 plan merges not counted).
Open owner asks: A-09 (test bot, free provider key names, OK to race two providers): no reply; Telegram reminder sent 2026-11-19. Only P1-18 waits on it. A-10 is a notice.
Telegram: vars set (user env; read via PowerShell GetEnvironmentVariable User). getUpdates empty at handoff; no update_id processed yet.
pnpm check: the main checkout has no node_modules. Run it in C:\dev\Alexia-wt\base2: git checkout -q --detach <merge sha>, pnpm check. Known failures: compute-connect 'a paused request reader stalls uploads too' (always). Load flakes that pass alone: compute-acceptance, provider.test, noticing.test, compute-plugins cancel, plugins/media ComfyUI and models.test.js bytes=.
Rust load flakes: fixed by P0-26 (conn.rs) and P1-27 (supervise.rs). If gate.sh fails on an alexia-mcp test, rerun once.
CI: .github/workflows/v3.yml runs on pushes to cr3studioo/v3 and cr3studioo/v3-*. node v3/ci/invariants.mjs (run from repo root) is part of gate.sh.
v2 conformance test: --features v2-conformance, run in base2 with ALEXIA_V2_PLUGINS=C:\dev\Alexia-wt\base2\plugins.
Every builder prompt: no fake credentials in any key shape; generous timing bounds; no hard-coded absolute paths in src/.
Leftover folders base\ and plan-P1\ in C:\dev\Alexia-wt are locked non-worktrees; delete when free.
