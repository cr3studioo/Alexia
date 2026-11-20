# STATE

CEO: #14 next (chat CEO, A-08). CEO #13 handed off 2026-11-20 evening with P2 mid-flight.
Orca run: run_7a40b198ac83 (bind with run-use). Helpers in C:\dev\Alexia-wt:
- wait.sh (run in background, ONE at a time; prints the first non-heartbeat message, acks heartbeats)
- msgs.py, esc.py (`python esc.py <dispatchId>` = latest question/escalation msg id, for `orchestration reply --id`)
- template.sh (source; `start <id> <phase> <model> [extra rule]`, `mk` builds a builder prompt; sets OPENSSL_SRC_PERL + low CARGO_BUILD_JOBS)
- rv.sh (source; `rv <id> <phase>`), gate.sh (integration gate; run as `CARGO_BUILD_JOBS=3 bash gate.sh`), tg.sh (source; `tg 'text'`)
- Fix round in same worktree: write fix-<id>.txt (no double quotes), worker-start with --spec "$(cat file)".

P0 26/26, P1 35/35 merged. P2: 50 tasks, 33 merged.
Running: P2-17 router for task steps (sonnet, ctx_c4932a2b7e3b), P2-08 media cancel token (sonnet, ctx_f7b06ec7596f).
Nothing in review. Nothing ready: next unlocks are P2-20 (opus, agent loop; needs P2-17), P2-29 (needs P2-08), P2-35/36 (need P2-17), P2-34 (needs P2-21).
A-15: P2 builders sonnet except P2-12, 13, 20, 37, 38, 46, 47, 48 (opus). BOARD Model column overrides spec. Reviews opus. Max 2 opus builders.

MACHINE LIMITS (most important):
- Disk C: 931 GB, ~25-35 GB free; the owner's own data fills the rest. Each worktree target/ is 8-14 GB. Delete <wt>/v3/target as soon as a task is approved (rm -rf). Check `df -h /c` each round. A full disk gives os error 112 in link.exe.
- RAM 16 GB: max 4 builders. Workers' runs get killed for low memory; tell them: commit first, rerun with CARGO_BUILD_JOBS=1, retry 3x with 5 min waits. Per-crate checks are acceptable for builders; reviewers and gate.sh run the workspace.
- SQLCipher build needs full Perl: OPENSSL_SRC_PERL=C:/dev/Alexia-wt/tools/strawberry-perl/perl/bin/perl.exe (portable; gate/rv/template set it). Owner said yes to winget Strawberry Perl (A-16) but the install got 1602 (admin prompt unanswered).
- Orca can show frozen "active" terminals for workers that died (seen after an Orca restart). Proof of death: no matching claude.exe (Get-CimInstance Win32_Process, CommandLine 'claude'). Then worker-stop and restart in the same worktree with a resume note (no try counted).

Owner standing rules: A-12 do every by-hand step yourself; A-13 subscriptions OFF, DB not encrypted until owner says how the key is backed up; A-14 50-msg run waived; A-15 cheaper builds; A-17 Telegram progress line after every merge (`tg`), overall % = (phases done + P2 fraction)/8.
Open owner asks: none. Telegram ops bot: last update_id processed 363458139.
Known flakes: alexia-hub telegram_e2e fifty_messages (load); alexia-mcp conn plugin_cancel_reaches_incoming (failed once with a 10 s wait, passes alone: maybe a real race, filed below); supervise hang_is_killed_by_heartbeat. On a gate test failure, rerun `cargo test --workspace --no-fail-fast` (with OPENSSL_SRC_PERL) and push if only a known flake failed.
Merges since last phase review: 23 (review 4 done). A whole-phase review is overdue: do it next (§8).

P1-33 hub: still running on this PC (pid from 01:46 2026-11-20) with the real Alexia bot. Env: ALEXIA_PLUGINS_DIR=C:\dev\Alexia-wt\hub-plugins, ALEXIA_V2_ROOT=C:\dev\Alexia-wt\base2. Runs from v3\target\release (exe locked). Don't move base2's HEAD.

Follow-ups to file as tasks (from reviews this run): see HANDOFF.md.
