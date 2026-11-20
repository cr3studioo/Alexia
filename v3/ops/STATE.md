# STATE

CEO: #13 next (chat CEO, A-08). CEO #12 handed off 2026-11-20 ~12:00 UTC with P2 mid-flight.
Orca run: run_7a40b198ac83 (bind with run-use). Helpers in C:\dev\Alexia-wt: wait.sh (run in background; prints the first non-heartbeat message, acks heartbeats; run ONE at a time), msgs.py, template.sh (source; `start <id> <phase> <model> [extra rule]`, `mk` builds a builder prompt), rv.sh (source; `rv <id> <phase>`), gate.sh (integration gate; stops at first failing test binary, so on a telegram flake rerun with `cargo test --workspace --no-fail-fast`). Fix round in same worktree: write a file (fix-*.txt) and worker-start with --spec "$(cat file)". PYTHONIOENCODING=utf-8 for msgs.py and terminal reads.

P0 26/26, P1 35/35 merged (P1 done; owner waived the 50-message run, A-14).
P2: 50 tasks (41 planned + P2-42..50 follow-ups). 12 merged: P2-01, 02, 03, 09, 10, 12, 15, 18, 22, 23, 42, 44.
Running (dispatch id in BOARD Note):
- P2-04 tools on wire, P2-05 router, P2-16 prompt (sonnet; slow, machine overloaded)
- P2-14 fix try 2 (redact: location keys in tool args, 2nd postcode)
- P2-43 spec change 2 (p95 rule moves into latency.rs check; test uses --check again)
- P2-46 (opus) permissions fail closed (review-4 #3-5)
In review: P2-06 (asker; review running 6+ h, alive), P2-11 review 2 (honest markers).
P2-13 (checker) built, waits: after P2-14 merges, `git -C C:/dev/Alexia-wt/P2-13 merge cr3studioo/v3`, run its tests (5 tests need real redact), then `rv P2-13 P2`.
Ready: P2-50 (security, do first), P2-45 (unblocks P2-20/25/47), P2-49, P2-30, 31, 32, 33 (sonnet), P2-37 (opus).
A-15: P2 builders sonnet except P2-12, 13, 20, 37, 38, 46, 47, 48 (opus). BOARD Model column overrides spec Model line. Reviews opus. Max 2 opus builders at once.
Keep builders <= 5: each worker runs cargo test --workspace (15+ min under load) and load causes flakes.
Notes to pass to builders when dispatching:
- P2-17: redact_request has no known-secrets param; builder must pass keychain values.
- P2-20: tool calls need unique ids per run (trim collapses by call id); fills Agent constructors first (spec).
- P2-21: picture attachments (alexia/attachmentInputs) still refused in tools.rs; check P2-21 covers it, else file a task.
- P2-40: watch compute workers getting verbatim \?\ paths, and plugins run as `node .` reloading every heartbeat (supervise.rs:106).

P1-33 hub: still running detached on this PC with the real Alexia bot (paired by owner 2026-11-20 00:49). Owner uses it.
Hub env: ALEXIA_PLUGINS_DIR=C:\dev\Alexia-wt\hub-plugins (base2 plugins minus telegram/crasher/vanisher, junction/hardlink mirror), ALEXIA_V2_ROOT=C:\dev\Alexia-wt\base2. Logs C:\dev\Alexia-wt\hub-out.log / hub-err.log. Data %LOCALAPPDATA%\AlexiaHub. Runs from v3\target\release (exe locked: stop it before a release build, restart with the same env). base2 worktree is its v2 root and plugin source: don't move base2's HEAD while it runs. Latency: `alexia-hub latency --last 50 --check` (same env).
If hub-err.log shows "Another program is reading this bot", v2 on the Mac still has its Telegram plugin on: tell the owner.

Owner standing rules: A-12 do every by-hand step yourself; A-13 subscriptions OFF, DB not encrypted until owner says how the key is backed up (P2-37 must keep encryption off by default); A-14 50-msg run waived; A-15 cheaper builds.
Open owner asks: none. Telegram ops bot: last update_id processed 363458138.
Known flakes: alexia-hub telegram_e2e fifty_messages (P2-43 fixes); alexia-mcp conn::out_of_order_answers and supervise hang_is_killed_by_heartbeat under load (rerun alone).
Merges since last phase review: 2 (review 4 done, v3/ops/phase-review-4.md). Next review after 10.
Leftover non-worktree folders in C:\dev\Alexia-wt: base\, plan-P1\ (locked; delete when free). v2-db-backup-20261120\ is a safety backup; keep.
