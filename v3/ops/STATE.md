# STATE

CEO: #19 (started 2026-11-24, on c2). Two Claude accounts: CEO.md §16, A-18. c1 is 97% weekly until 11-27 12:00: use c2; when c2 hits 95% 5h, wait for its reset.
Orca run: run_538b6a8b3c5a (bind with run-use). CEO terminal term_fea9a643-f1a8-4767-b275-eda3cee5a054. Helpers in C:\dev\Alexia-wt:
- term.sh (source): `wdispatch <wt> <title> <model> <spec> [c1|c2]` starts Claude in an Orca terminal on the account usage.ps1 picks, then worker-start --terminal. template.sh `start <id> <phase> <model> <extra>` and rv.sh `rv <id> <phase>` use it. Never --agent claude.
- wait.sh (background, ONE at a time), msgs.py, esc.py, gate.sh (`CARGO_BUILD_JOBS=3 bash gate.sh`), tg.sh (`tg 'text'`), tread.sh (`tread <dispatchId>`).
- Usage: `powershell -NoProfile -File C:\Users\vacla\.claude-usage\usage.ps1`.

P0, P1, P2, P2D done. NOW: Phase 3 (Proactive), v3/specs/P3 (34 tasks): 16 merged, 1 review, 6 ready, 11 todo.
Merged: P3-00, 02, 03, 13, 14, 15, 17, 18, 20, 22, 23, 25, 26, 27, 28, 29. Review: P3-30 (errand kit, built 0ac7236, C:/dev/Alexia-wt/P3-30) -> review it first (§8). Running: none.
Ready: P3-01 (sonnet, Rust), P3-05 and P3-06 (opus, Rust; planner's UNCOMMITTED work sits in their worktrees: hire one builder per task in that worktree to finish, commit, test, report), P3-19 (opus, screen memory; owner wants it on once merged, A-21 item 8), P3-21 (opus, Microsoft; builds, stays unconnected). P3-04 (planner committed, unbuilt; needs P3-00, now merged: ready too) then P3-07 (partial worktree).
- After every worker-start, read its screen ~30 s later. A new CEO must `orca orchestration run-use --id run_538b6a8b3c5a` first, or worker-start fails with consumer_fenced.
- Plugin builders/reviewers: run `pnpm vitest run --project unit packages/core/test/noticing.test.ts` and parse plugin.json with the protocol Manifest (camelCase keys fail IDENT: P3-17 nearly dropped memory). Fix-reason extraction: worker_done body lines start '- '; the VERDICT line starts with a space.
- Claude Code reaps background shells under memory pressure (gate and wait.sh were killed). Owner must say go before re-running a reaped command.

MACHINE LIMITS (most important):
- A-22: D: is exFAT (no symlinks; pnpm tests break there). New worktrees on C:\dev\Alexia-wt again; each worker builds Rust into D:\alexia-target\<id> (set in the prompt). P3-14 and P3-20 worktrees are on D: (rv.sh finds them with wtpath). Worker TEMP=D:\alexia-tmp, gate target D:\alexia-target\main. TODO when the planner is done: delete C:\dev\Alexia\v3\target\debug (keep release).
- Disk C: was 9.7 GB free twice this run. Causes found: (1) tests leak alexia-* temp dirs in %TEMP% (40k dirs, ~80 GB; deleted those older than 2 h: PowerShell Get-ChildItem $env:TEMP -Directory -Filter 'alexia-*' | ? LastWriteTime -lt (Get-Date).AddHours(-2) | Remove-Item -Recurse -Force). Do this every few rounds until a task fixes the leak. (2) main checkout v3/target/debug/incremental grew to 21 GB (gate now runs CARGO_INCREMENTAL=0). (3) each worktree target 8-15 GB: rm -rf <wt>/v3/target as soon as approved. 37 GB free at handoff (CEO #15 deleted tgt-shared). rm -rf <wt>/v3/target once a task is approved.
- RAM 16 GB: max 4 builders. Workers get killed runs; builder and reviewer prompts now say: rerun with JOBS=1, per-crate ok, never stop to ask. Workers still sometimes sit idle asking "rerun?": check with tread when silent >30 min and answer with `orca terminal send --terminal <T> --text $'\x15'` then `--text '...' --enter`.
- Shared CARGO_TARGET_DIR (tgt-shared, 22 GB) mixes worktrees' artifacts and locks exes: do not use for new work; delete C:\dev\Alexia-wt\tgt-shared when no worker uses it (none of the running ones do).
- SQLCipher build needs OPENSSL_SRC_PERL=C:/dev/Alexia-wt/tools/strawberry-perl/perl/bin/perl.exe (gate/rv/template set it).
- A usage-limit pause stalled all workers 23:39-02:31; they resumed by themselves.

Owner standing rules: A-12 do every by-hand step yourself; A-13 subscriptions OFF, DB not encrypted until owner says how the key is backed up; A-14 50-msg run waived; A-15 cheaper builds; A-17 Telegram progress line after every merge (`tg`), overall % = (phases done + P2 fraction)/8.
Open owner asks: none (A-21 answered: settings to apply in P3-31/P3-33, Moodle for P3-27). Telegram ops bot: last update_id processed 363458139.
Known flakes: alexia-core local.rs idle_stops_after_10_min; alexia-hub telegram_e2e fifty_messages (load); alexia-mcp conn plugin_cancel_reaches_incoming (P2-55 fixes); alexia-store windows_credential_manager_round_trip (fixed real entry, races across worktrees); supervise hang_is_killed_by_heartbeat. On a gate test failure, rerun `cargo test --workspace --no-fail-fast` and push if only a known flake failed.
Merges since phase review 5: 21; phase review 6 running. Next one ~10 merges after it.

P1-33 hub: still running on this PC with the real Alexia bot. Env: ALEXIA_PLUGINS_DIR=C:\dev\Alexia-wt\hub-plugins, ALEXIA_V2_ROOT=C:\dev\Alexia-wt\base2. Runs from v3\target\release (exe locked). Don't move base2's HEAD.
