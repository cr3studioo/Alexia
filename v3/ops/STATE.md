# STATE

CEO: #23 (started by CEO #22 with a sleep until 2026-11-26 10:55, on c2). Two accounts (CEO.md §16): c1 98% week until 11-27 12:00; c2 5h hit 97% at 08:10 (resets 10:50), 77% week (resets 12-02 03:00).
Orca run: run_538b6a8b3c5a (bind with `orca orchestration run-use --id run_538b6a8b3c5a` first; again after any Orca restart, when handles go stale).
Helpers in C:\dev\Alexia-wt (source them in the Bash tool):
- template.sh: `start <id> <phase> <model> <extra>` (worktree + Claude terminal on `Use next` + dispatch; mk builds the builder prompt). term.sh: `wterm`, `wdispatch`, `wtpath`. rv.sh: `rv <id> <phase>` (Opus reviewer). tread.sh: `tread <dispatchId>` (worker screen). tg.sh: `tg 'text'`. msgs.py prints a check result.
- Waiting: Claude Code kills background shells when memory is low. Wait in the FOREGROUND: the loop in HANDOFF.md (orca check --wait 180 s, up to 3 times, acks heartbeat-only deliveries). waitreal.sh is the background version.
- Usage: `powershell -NoProfile -File C:\Users\vacla\.claude-usage\usage.ps1`.
- Main-checkout Rust checks: CARGO_TARGET_DIR=D:/alexia-target/main, OPENSSL_SRC_PERL=C:/dev/Alexia-wt/tools/strawberry-perl/perl/bin/perl.exe, CARGO_INCREMENTAL=0, CARGO_BUILD_JOBS=1, run in the foreground.
- After a worktree merge: `git worktree unlock <path>` before `git worktree remove --force <path>` (worktrees show "locked: initializing").

P0, P1, P2, P2D done. NOW: Phase 3 (Proactive): 35 of 38 merged. Phase 4 (devices) runs beside it: 15 of 46 merged.
Running (Orca workers):
- P3-31 ctx_509befc893a0 (sonnet, c2, terminal term_81f1966c-95e8-4ffe-ab16-fc654371f08a): hub wiring, HostSources, PC activity, CLI, slash commands. Touches alexia-core commands.rs: Opus review before merge. It was mid-build when c2 hit 97% of 5h at 08:10; it may be paused at the limit: read its screen (tread) and type continue into its terminal if so (no try counted).
P3 left after that: P3-32 (simulated week, sonnet) -> P3-33 (on this PC: settings from A-21, screen memory on, by-hand checks listed in its spec).
P4 ready: P4-02, P4-03, P4-11, P4-24, P4-29, P4-30 (all opus), P4-46 (sonnet, gateway). P4-02 changes Cargo.lock; P3-31 may too (windows-sys features): whichever merges second rebases the lock.
Owner standing rules: A-12 do by-hand steps yourself; A-13 subscriptions off; A-17 Telegram line after every merge; A-18 two accounts; A-22/A-23 Rust build output on D:\alexia-target\<id> (never C:), Defender excludes build folders; A-24 (B) low-risk Sonnet tasks get a CEO check instead of an Opus reviewer, security/core/Opus tasks keep full review; A-26 at most 4 workers, one full JS test run at a time (builders test only their plugin), Phase 3 before Phase 4.
CEO check for a JS plugin: allowed paths, every declared capability bound with _meta alexia/provides, text to PowerShell/AppleScript only via stdin or env, destructive annotations, plugin vitest, `node v3/ci/invariants.mjs` AND `pnpm invariants` (07 catches '\n' + concatenation in embedded scripts; 11 fails on rate-limited free models, known), pnpm lint, pnpm typecheck.
Known failures: D: same-drive (trust_makes_tools_reviewed, servers_persist, add_server_hosted_unreviewed); pnpm unit: compute-connect paused reader, compute-plugins cancel, plugin-panels memory panel (every run), plugins/memory locked.test.js (date); invariant 11 (rate limits).
Open owner asks: A-25 (P4 owner needs; defaults go ahead; needed only by P4-43/44). sccache NOT installed (owner rejected). Telegram: last update_id processed 363458139 (no new messages this run).
P1-33 hub still runs on this PC with the real bot (ALEXIA_PLUGINS_DIR=C:\dev\Alexia-wt\hub-plugins, old copy).
