# STATE

CEO: #12 (chat CEO, A-08), running since 2026-11-20.
Orca run: run_7a40b198ac83 (bind with run-use). Helpers in C:\dev\Alexia-wt: wait.sh (background; prints the first non-heartbeat message, acks heartbeats), msgs.py, template.sh (source; `start <id> <phase> <model> [extra rule]`), rv.sh (source; `rv <id> <phase>`), gate.sh (integration gate on the main checkout: GATE OK or failures). Retry in the same worktree: write a file (see fix-P1-18.txt) and worker-start with --spec "$(cat file)". Set PYTHONIOENCODING=utf-8 before msgs.py/terminal reads (non-ASCII crashes cp1252).
P0: 26/26 merged. P1: 35/35 merged (P1-33 closed by owner A-14: 3 real msgs, ack max 86 ms). The hub keeps running on the real bot for the owner.
P2: planned (v3/specs/P2/PHASE.md, 41 tasks). Running:
- P2-01 (opus) ctx_1caa79a5d640: core P2 types, module stubs, INTERFACES.md. Unblocks almost everything.
- P2-03 (opus) ctx_4de98296dd61: store migration 3.
- P2-09 (sonnet) ctx_fcaa99248657: hub dead code.
Ready next: P2-10 (opus, no deps). After P2-01: P2-02, 04, 05, 06, 11..16, 30..33.
A-15: P2 builders are sonnet except P2-12, 13, 20, 37 (opus). Board Model column overrides the spec Model line. Reviews stay opus. Max 2 opus builders per batch.

P1-33 (the real run): the hub runs DETACHED on this PC with the real Alexia bot (started by CEO #11, PID in LOG; check with Get-Process alexia-hub). Env: ALEXIA_PLUGINS_DIR=C:\dev\Alexia-wt\hub-plugins (base2 plugins minus telegram/crasher/vanisher, mirrored with junctions/hardlinks because the scanner ignores junction dirs), ALEXIA_V2_ROOT=C:\dev\Alexia-wt\base2. Logs: C:\dev\Alexia-wt\hub-out.log / hub-err.log. Data: %LOCALAPPDATA%\AlexiaHub (v2 imported: 24 sessions, 370 messages; media's 46 GB hard-linked). Keys: secret import-v2 done (9 copied).
Owner PAIRED the bot 2026-11-20 00:49. Waiting for them to use it for 50 messages. Then run `alexia-hub latency --last 50 --check --html latency.html` (same env) and dispatch P1-33 (or write the report via a sonnet worker). Don't rebuild target/release while the hub runs from it (exe locked); stop it first if needed and restart with the same env.
If hub-err.log shows "Another program is reading this bot", v2 on the Mac still has its Telegram plugin on: tell the owner.

Owner standing rule (A-12): do every by-hand step on this PC yourself; ask only for what physically needs the owner (their Telegram account). A-13: P2 owner needs decided with defaults (subscriptions OFF; don't encrypt DB until owner says how to back up the key).
Open owner asks: none blocking. Telegram ops bot: vars set (read via PowerShell GetEnvironmentVariable User); last update_id processed: 363458138.
pnpm check: run in C:\dev\Alexia-wt\base2 (detached; `git checkout -q --detach <sha>`). NOTE base2 is now also the hub's v2 root and plugin source: don't check out another sha there while the hub runs; use a new detached worktree for pnpm check (needs pnpm install). No P2 task touches v2 paths.
Known flakes: alexia-mcp supervise.rs hang_is_killed_by_heartbeat under full load (rerun alone). pnpm: compute-connect paused reader (always), others pass alone.
Follow-ups not specced: importer copies plugin files with fs::copy (46 GB media models; should hard-link or skip model dirs); P1-18 e2e token-leak check sees only last 40 stderr lines; steered turn ack not recorded.
Merges since last phase review: 0 (review 3 done 2026-11-20, v3/ops/phase-review-3.md).
Leftover non-worktree folders in C:\dev\Alexia-wt: base\, plan-P1\ (locked; delete when free). v2-db-backup-20261120\ is a safety backup; keep.
