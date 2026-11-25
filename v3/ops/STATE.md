# STATE

CEO: #21 (started by CEO #20 at 19:52, term_9c9612df-3bd3-4d5d-a2a6-9e27b5f60561, on c2). Two accounts (CEO.md §16): c1 98% week until 11-27 12:00; c2 resets 5h at 19:50 (week 37%).
Orca run: run_538b6a8b3c5a (bind with `orca orchestration run-use --id run_538b6a8b3c5a` first). Helpers in C:\dev\Alexia-wt:
- term.sh (source): `wdispatch <wt> <title> <model> <spec> [c1|c2]`; template.sh `start <id> <phase> <model> <extra>` (creates worktree + dispatch; mk builds the builder prompt, target D:/alexia-target/<id>); tread.sh `tread <dispatchId>`; tg.sh `tg 'text'`; msgs.py; wait.sh (Claude Code reaps it under memory pressure: check messages by hand when Orca says so).
- Message read: `orca orchestration check --run run_538b6a8b3c5a --json`, print with PYTHONIOENCODING=utf-8 (Czech text breaks cp1252).
- Usage: `powershell -NoProfile -File C:\Users\vacla\.claude-usage\usage.ps1`.

P0, P1, P2, P2D done. NOW: Phase 3 (Proactive), v3/specs/P3: 27 merged of 37 (P3-34, P3-35, P3-36 added this run).
Running (Orca workers, they resume after a usage pause by themselves):
- P3-08: review said CHANGES. First job: Opus fix round (try 2) in C:/dev/Alexia-wt/P3-08 with the reasons in LOG.md (decider holds in not_before block Urgent in quiet hours, A-21 #3; early unpause / quiet change must release rule-5 holds; add intake tests), then Opus re-review. Reviewer must run cargo build -p alexia-mcp --bins before agent_e2e.
- P3-35 fix round 2 ctx_5c95d5aad936 (overlapping-call elicitation hole) -> then Opus re-review.
- P3-16 build ctx_915f244750b8 -> then Opus review.
- P4 planner ctx_de214c225b12 in worktree C:/dev/Alexia-wt/P4plan (branch cr3studioo/v3-P4plan, commits "Plan P4", not pushed) -> merge into v3, add P4 rows to BOARD, start P4 tasks that can run beside P3.
Next in P3: P3-09 (after P3-08) -> P3-10 -> P3-11 -> P3-31 -> P3-32 -> P3-33. P3-36 after P3-35.

Owner standing rules: A-12 do by-hand steps yourself; A-13 subscriptions off; A-17 Telegram line after every merge; A-18 two accounts; A-22/A-23 Rust build output on D:\alexia-target\<id> (NEVER C:; owner saw C: at 100%), Defender excludes build folders; A-24 (B): low-risk Sonnet tasks get a CEO check, no Opus reviewer; security/core/Opus keep full review.
Owner wants speed: keep 4 workers busy, run P4 beside P3, fix one-line review findings yourself.
Known D: failures (same-drive rule): trust_makes_tools_reviewed, servers_persist, add_server_hosted_unreviewed. Flakes under load: resume_after_kill (hub), token_not_echoed, inventory_this_pc_shape, tailscale_state_and_actions (api), compute-connect paused reader, plugin-panels memory panel, invariant 11 (rate-limited free models).
Main-checkout Rust checks: CARGO_TARGET_DIR=D:/alexia-target/main, OPENSSL_SRC_PERL=C:/dev/Alexia-wt/tools/strawberry-perl/perl/bin/perl.exe, CARGO_INCREMENTAL=0.
P3-33 must also: apply A-21 settings (quiet 00:00-08:00, brief, wrap-up 22:00, weekly Sun 18:00), turn screen memory on (A-21 #8), run plugins/computer/test/screen-check.mjs full and lock, check Graph /reply recipients.
Open owner asks: none. sccache NOT installed (owner rejected the command; ask before trying again). Telegram: last update_id processed 363458139.
P1-33 hub still runs on this PC with the real bot (ALEXIA_PLUGINS_DIR=C:\dev\Alexia-wt\hub-plugins, old copy, no mail.send).
Old C: build folders to delete when free: C:\dev\Alexia-wt\tgt\P3-01 (22 GB), tgt\sccache-build.
