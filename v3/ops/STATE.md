# STATE

CEO: #18 (started 2026-11-24 by the P3 planner, on c2). Two Claude accounts: CEO.md §16, A-18. c1 is 97% weekly until 11-27 12:00: use c2; when c2 hits 95% 5h, wait for its reset.
Orca run: run_538b6a8b3c5a (bind with run-use). CEO terminal term_fea9a643-f1a8-4767-b275-eda3cee5a054. Helpers in C:\dev\Alexia-wt:
- term.sh (source): `wdispatch <wt> <title> <model> <spec> [c1|c2]` starts Claude in an Orca terminal on the account usage.ps1 picks, then worker-start --terminal. template.sh `start <id> <phase> <model> <extra>` and rv.sh `rv <id> <phase>` use it. Never --agent claude.
- wait.sh (background, ONE at a time), msgs.py, esc.py, gate.sh (`CARGO_BUILD_JOBS=3 bash gate.sh`), tg.sh (`tg 'text'`), tread.sh (`tread <dispatchId>`).
- Usage: `powershell -NoProfile -File C:\Users\vacla\.claude-usage\usage.ps1`.

P0, P1, P2, P2D done. NOW: Phase 3 (Proactive), v3/specs/P3 (34 tasks). P3-02 merged (planner, unreviewed).
Running: P3-00/04/05/06/07 in the P3 planner terminal term_e6335cba (it builds, writes reports, does not merge; messages the CEO "P3 carry-over ready"). Then review + merge each (§8).
Running (round 1, sonnet, c2): P3-03 ctx_368c30bcc6d5, P3-13 ctx_d7380e504946, P3-25 ctx_e521558df823.
Next: P3-28 (add to its notes: owner wants sleep, activity AND resting heart rate nudges, A-21); after P3-03 the plugin tasks (P3-18..23, 26, 27, 29, 30); after the planner's five: P3-01, P3-08 on. Max 4 workers (planner counts), max 2 compiling Rust.

MACHINE LIMITS (most important):
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
