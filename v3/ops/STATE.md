# STATE

CEO: #15 next (chat CEO, A-08). CEO #14 handed off 2026-11-21 morning with P2 mid-flight.
Orca run: run_7a40b198ac83 (bind with run-use). Helpers in C:\dev\Alexia-wt:
- wait.sh (run in background, ONE at a time: check `ps -ef | grep "[w]ait.sh"` before starting; prints the first non-heartbeat message, acks heartbeats)
- msgs.py, esc.py (`python esc.py <dispatchId>` = latest question/escalation msg id, for `orchestration reply --id`)
- template.sh (source; `start <id> <phase> <model> [extra rule]`, `mk` builds a builder prompt). start writes start.json: read the dispatchId AFTER start returns (a backgrounded start once left a stale id on the board).
- rv.sh (source; `rv <id> <phase>`, own target), rv2.sh (`rv2`, shared target; avoid, see below), gate.sh (`CARGO_BUILD_JOBS=3 bash gate.sh`, now CARGO_INCREMENTAL=0), tg.sh (`tg 'text'`), tread.sh (`tread <dispatchId>`: last 25 lines of a worker's terminal)
- Fix round in same worktree: worker-start with --spec "$(mk <id> P2 "<extra>")".

P0 26/26, P1 35/35 merged. P2: 64 tasks, 41 merged.
Running: P2-20 agent loop (opus, ctx_446639742e4b), P2-61 file URI/undo (opus, ctx_69455708b062), P2-36 compare (sonnet, ctx_3160443697f5), P2-35 subscriptions (sonnet, ctx_afb10259da19).
Review: P2-54 store encryption crash-safety (opus reviewer ctx_b5955d2f2b66).
Ready: P2-55 (opus), P2-56 (opus): wait for an opus slot (max 2 opus builders).
Next unlocks: P2-20 -> P2-21, 25, 26, 27, 28 (all sonnet); P2-56 -> P2-60; P2-55 + P2-61 + P2-57 -> P2-62; then P2-38 (opus) wiring.
A-15: P2 builders sonnet except P2-12, 13, 20, 37, 38, 46, 47, 48 and the opus follow-ups. BOARD Model column is the authority.

MACHINE LIMITS (most important):
- Disk C: was 9.7 GB free twice this run. Causes found: (1) tests leak alexia-* temp dirs in %TEMP% (40k dirs, ~80 GB; deleted those older than 2 h: PowerShell Get-ChildItem $env:TEMP -Directory -Filter 'alexia-*' | ? LastWriteTime -lt (Get-Date).AddHours(-2) | Remove-Item -Recurse -Force). Do this every few rounds until a task fixes the leak. (2) main checkout v3/target/debug/incremental grew to 21 GB (gate now runs CARGO_INCREMENTAL=0). (3) each worktree target 8-15 GB: rm -rf <wt>/v3/target as soon as approved. 56 GB free at handoff.
- RAM 16 GB: max 4 builders. Workers get killed runs; builder and reviewer prompts now say: rerun with JOBS=1, per-crate ok, never stop to ask. Workers still sometimes sit idle asking "rerun?": check with tread when silent >30 min and answer with `orca terminal send --terminal <T> --text $'\x15'` then `--text '...' --enter`.
- Shared CARGO_TARGET_DIR (tgt-shared, 22 GB) mixes worktrees' artifacts and locks exes: do not use for new work; delete C:\dev\Alexia-wt\tgt-shared when no worker uses it (none of the running ones do).
- SQLCipher build needs OPENSSL_SRC_PERL=C:/dev/Alexia-wt/tools/strawberry-perl/perl/bin/perl.exe (gate/rv/template set it).
- A usage-limit pause stalled all workers 23:39-02:31; they resumed by themselves.

Owner standing rules: A-12 do every by-hand step yourself; A-13 subscriptions OFF, DB not encrypted until owner says how the key is backed up; A-14 50-msg run waived; A-15 cheaper builds; A-17 Telegram progress line after every merge (`tg`), overall % = (phases done + P2 fraction)/8.
Open owner asks: none. Telegram ops bot: last update_id processed 363458139.
Known flakes: alexia-hub telegram_e2e fifty_messages (load); alexia-mcp conn plugin_cancel_reaches_incoming (P2-55 fixes); alexia-store windows_credential_manager_round_trip (fixed real entry, races across worktrees); supervise hang_is_killed_by_heartbeat. On a gate test failure, rerun `cargo test --workspace --no-fail-fast` and push if only a known flake failed.
Merges since phase review 5: 9.

P1-33 hub: still running on this PC with the real Alexia bot. Env: ALEXIA_PLUGINS_DIR=C:\dev\Alexia-wt\hub-plugins, ALEXIA_V2_ROOT=C:\dev\Alexia-wt\base2. Runs from v3\target\release (exe locked). Don't move base2's HEAD.
