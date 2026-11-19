# STATE

CEO: #9 next (chat CEO, A-08). CEO #8 handed off at a clean point (no approved branch unmerged).
Orca run: run_7a40b198ac83 (bind with run-use). Helpers in C:\dev\Alexia-wt: wait.sh, msgs.py, template.sh (start/mk), rv.sh (source it; `rv <id> <phase>` dispatches the standard opus review).
P0: P0-01..P0-24 merged except P0-22 (running) and P0-25 (todo, deps P0-21 merged + P0-22).
P1 (V3-1 Telegram fast): merged P1-01..P1-05, P1-09, P1-11, P1-14, P1-15, P1-16, P1-19.
Ready (all opus): P1-06 (router, critical path), P1-10 (Telegram channel), P1-12 (approvals/voice), P1-07 (lanes).
Running (live Orca workers; wait for worker_done):
- P0-22 build (opus) ctx_35314f1a56ef, C:\dev\Alexia-wt\P0-22. Then opus review, merge -> P0-25 ready (sonnet).
- P1-13 build (opus) ctx_74d44b24d360, C:\dev\Alexia-wt\P1-13. Then opus review, merge.
Critical path: P1-06 -> P1-08 -> P1-17 -> P1-18. Also P1-10, P1-12, P1-07, P1-13 feed P1-17.
Opus cap (2 builders) is the bottleneck: every ready P1 task is opus. Reviewers are not counted.
Merge count since the P0 phase review: 10 (P1-04, P0-24, P1-16, P0-21, P1-15, P1-09, P1-19, P0-23, P1-05, P1-11). Per CEO.md 8, a whole-phase review is due: run one on cr3studioo/v3 (P1 so far) when a slot is free.
Open owner asks: A-09 (test bot, free provider key names, OK to race two providers), no reply. Only P1-18 waits on it. A-10 is a notice.
Telegram: vars set (user env; read via PowerShell GetEnvironmentVariable User). getUpdates empty at 04:36 UTC; no update_id processed yet.
pnpm check on Windows: known pre-existing failures that merges did not cause: compute-connect 'a paused request reader stalls uploads too' (always), compute-plugins 'cancelling a plugin tool propagates' and plugins/media compute 'ComfyUI the person is running' (load-flaky). Gate v2-path merges on lint, typecheck and invariants green, test failures limited to these.
CI: .github/workflows/v3.yml runs on pushes to cr3studioo/v3 and cr3studioo/v3-*. Rust pinned 1.96.1. node v3/ci/invariants.mjs is a local merge gate; it now rejects C:\ even inside message strings in src/.
v2 conformance test needs --features v2-conformance and node_modules: run it in C:\dev\Alexia-wt\base2 (detached, has node_modules; currently at the P0-23 commit) with ALEXIA_V2_PLUGINS=C:\dev\Alexia-wt\base2\plugins.
Every builder prompt: no fake credentials in any key shape; generous timing bounds; no hard-coded absolute paths in src/.
Later-spec notes: P1-17 spec has notes from the P1-16/P1-19 reviews (heartbeat before clean_stop; schtasks /RP prompt visibility). P1-10 spec has the 5xx->Service retry note. P1-07/P1-17: Lanes should report the lane early so the gateway can steer task turns that write text first (P1-11 uses a Phase::Tool heuristic). Design note for V3-1 library uninstall: purge after vanish returns UnknownPlugin (host.rs:551, :914).
Leftover folders base\ and plan-P1\ in C:\dev\Alexia-wt are locked non-worktrees; delete when free.
