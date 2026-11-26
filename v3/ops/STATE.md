# STATE

CEO: #24 (started by CEO #23 on 2026-11-26 ~15:10, on c2). Two accounts (CEO.md §16): c1 98% week until 11-27 12:00; c2 5h 74% (resets 15:50), week 87% (resets 12-02 03:00).
Orca run: run_538b6a8b3c5a (bind with `orca orchestration run-use --id run_538b6a8b3c5a` first; again after any Orca restart, when handles go stale).
Helpers in C:\dev\Alexia-wt (source them in the Bash tool):
- template.sh: `start <id> <phase> <model> <extra>` (worktree + Claude terminal on `Use next` + dispatch). term.sh: `wterm`, `wdispatch`, `wtpath`. rv.sh: `rv <id> <phase>` (Opus reviewer). tread.sh: `tread <dispatchId>` (worker screen). tg.sh: `tg 'text'` (export V3_OPS_TG_CHAT from the User env first). msgs.py prints a check result.
- Waiting: in the FOREGROUND, the loop in HANDOFF.md. Answer a question with the msg id of THAT question (grep -B3 -A3 '"type": *"question"' chk_fg.json | grep -o 'msg_...'), never the first msg id in the file.
- Usage: `powershell -NoProfile -File C:\Users\vacla\.claude-usage\usage.ps1`.
- Main-checkout Rust checks: CARGO_TARGET_DIR=D:/alexia-target/main, OPENSSL_SRC_PERL=C:/dev/Alexia-wt/tools/strawberry-perl/perl/bin/perl.exe, CARGO_INCREMENTAL=0, CARGO_BUILD_JOBS=1. Long ones: run_in_background + Monitor.
- After a worktree merge: `git worktree unlock <path>` before `git worktree remove --force <path>`.

P0, P1, P2, P2D, P3 done (P3: 40 rows merged, incl. P3-38 mute fix and P3-33-ops settings). Phase 3 end-of-phase whole-phase Reviewer NOT run yet (CEO.md §8): do it first.
Phase 4 (devices): 17 of 46 merged. Ready (all opus): P4-02 (Cargo.lock), P4-03 (store migration 5), P4-11, P4-24, P4-29, P4-30. Nothing running.
THE REAL HUB RUNS on this PC since 2026-11-26 14:35 (owner's Phase 3 week): C:\dev\Alexia-wt\hub-bin\alexia-hub.exe run, detached, ALEXIA_PLUGINS_DIR=C:\dev\Alexia\plugins, logs C:\dev\Alexia-wt\hub-out.log / hub-err.log. Data %LOCALAPPDATA%\AlexiaHub (backup D:\alexia-backup\hub-20261126). Not autostarted (A-27 4). To update it: stop it (Stop-Process the alexia-hub pid; check window.json gone), copy the new release exe over hub-bin, start it the same way. Never run a second hub (lock).
Owner standing rules: A-12 do by-hand steps yourself; A-13 subscriptions off; A-17 Telegram line after every merge; A-18 two accounts; A-22/A-23 Rust output on D:\alexia-target\<id>; A-24 (B) low-risk Sonnet tasks get a CEO check, security/core/Opus tasks keep full review; A-26 at most 4 workers, one full JS test run at a time, Phase 3 before Phase 4 (P3 is done now).
CEO check for a JS plugin: allowed paths, capabilities bound with _meta alexia/provides, text to PowerShell/AppleScript only via stdin or env, destructive annotations, plugin vitest, `node v3/ci/invariants.mjs` AND `pnpm invariants`, pnpm lint, pnpm typecheck.
Known failures: D: same-drive (trust_makes_tools_reviewed, servers_persist, add_server_hosted_unreviewed); pnpm unit: compute-connect paused reader, compute-plugins cancel, plugin-panels memory panel, plugins/memory locked.test.js (date); invariant 11 (rate limits).
Open owner asks: A-25 (P4 owner needs; defaults go ahead; only P4-43/44), A-27 (trust 11 plugins, Google client, Moodle login, autostart). Telegram: last update_id processed 363458139.
D: has ~49 GB free only (owner's media models are 49 GB in hub data).
