# STATE

CEO: #17 (started by the owner on c2, 2026-11-22/23). Two Claude accounts: CEO.md §16, A-18.
Orca run: run_7a40b198ac83 (bind with run-use). Helpers in C:\dev\Alexia-wt:
- term.sh (source): `wdispatch <wt> <title> <model> <spec> [c1|c2]` starts Claude in an Orca terminal on the account usage.ps1 picks, then worker-start --terminal. template.sh `start` and rv.sh `rv` use it. Never --agent claude (runs on the Orca app's account).
- wait.sh (background, ONE at a time), msgs.py, esc.py, gate.sh (`CARGO_BUILD_JOBS=3 bash gate.sh`), tg.sh (`tg 'text'`), tread.sh (`tread <dispatchId>`).
- Usage: `powershell -NoProfile -File C:\Users\vacla\.claude-usage\usage.ps1`.

P0 26/26, P1 35/35, P2 all build tasks merged (gate 77 suites); P2-41 dropped (A-19, owner waived); 10 P2 follow-ups deferred.
NOW: Phase 2D (A-19): the v2 app (packages/ui + src-tauri) on alexia-hub, same look, all features, plus PC actions.
Running (c2): review P2D-12 ctx_823f26498050; build P2D-16 ctx_6d1eb6947f29. Merged: P2D-01..11, 13. Left: 12, 14, 15, 16.
Next: P2D-02 unlocks 04,06,07,09,10 (+05,11 with 03). Max 2 opus per batch. c1 is ~97% weekly until 11-27: when c2 hits 95% 5h, wait for its reset.

MACHINE LIMITS (most important):
- Disk C: was 9.7 GB free twice this run. Causes found: (1) tests leak alexia-* temp dirs in %TEMP% (40k dirs, ~80 GB; deleted those older than 2 h: PowerShell Get-ChildItem $env:TEMP -Directory -Filter 'alexia-*' | ? LastWriteTime -lt (Get-Date).AddHours(-2) | Remove-Item -Recurse -Force). Do this every few rounds until a task fixes the leak. (2) main checkout v3/target/debug/incremental grew to 21 GB (gate now runs CARGO_INCREMENTAL=0). (3) each worktree target 8-15 GB: rm -rf <wt>/v3/target as soon as approved. 37 GB free at handoff (CEO #15 deleted tgt-shared). rm -rf <wt>/v3/target once a task is approved.
- RAM 16 GB: max 4 builders. Workers get killed runs; builder and reviewer prompts now say: rerun with JOBS=1, per-crate ok, never stop to ask. Workers still sometimes sit idle asking "rerun?": check with tread when silent >30 min and answer with `orca terminal send --terminal <T> --text $'\x15'` then `--text '...' --enter`.
- Shared CARGO_TARGET_DIR (tgt-shared, 22 GB) mixes worktrees' artifacts and locks exes: do not use for new work; delete C:\dev\Alexia-wt\tgt-shared when no worker uses it (none of the running ones do).
- SQLCipher build needs OPENSSL_SRC_PERL=C:/dev/Alexia-wt/tools/strawberry-perl/perl/bin/perl.exe (gate/rv/template set it).
- A usage-limit pause stalled all workers 23:39-02:31; they resumed by themselves.

Owner standing rules: A-12 do every by-hand step yourself; A-13 subscriptions OFF, DB not encrypted until owner says how the key is backed up; A-14 50-msg run waived; A-15 cheaper builds; A-17 Telegram progress line after every merge (`tg`), overall % = (phases done + P2 fraction)/8.
Open owner asks: none. Telegram ops bot: last update_id processed 363458139.
Known flakes: alexia-core local.rs idle_stops_after_10_min; alexia-hub telegram_e2e fifty_messages (load); alexia-mcp conn plugin_cancel_reaches_incoming (P2-55 fixes); alexia-store windows_credential_manager_round_trip (fixed real entry, races across worktrees); supervise hang_is_killed_by_heartbeat. On a gate test failure, rerun `cargo test --workspace --no-fail-fast` and push if only a known flake failed.
Merges since phase review 5: 21; phase review 6 running. Next one ~10 merges after it.

P1-33 hub: still running on this PC with the real Alexia bot. Env: ALEXIA_PLUGINS_DIR=C:\dev\Alexia-wt\hub-plugins, ALEXIA_V2_ROOT=C:\dev\Alexia-wt\base2. Runs from v3\target\release (exe locked). Don't move base2's HEAD.
