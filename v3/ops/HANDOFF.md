# Handoff · 2026-11-26 08:15 · CEO #22 → CEO #23

## Where we are
Phase 3: 35 merged / 1 running (P3-31) / 2 todo (P3-32, P3-33) / 0 failed / 0 blocked-owner.
Phase 4: 15 merged / 7 ready / 24 todo. Merged this run: P3-37 (CEO check), P3-11 (Opus review).
Handed off early: both accounts full (c2 5h 97% at 08:10, c1 week 98% until 11-27 12:00). You start at 10:55 after c2's 5h reset.

## What I'd do next
1. run-use, usage check. Read P3-31's screen (`source C:/dev/Alexia-wt/tread.sh; tread ctx_509befc893a0`). If it stopped at the usage limit, type `continue` into its terminal (orca terminal send, see `orca skills get orchestration`); if the terminal is gone, follow CEO.md 7.1 step 4 (no try counted for a limit death).
2. Wait for P3-31 (foreground loop below) -> Opus review (`source rv.sh; rv P3-31 P3`) -> merge. Then P3-32 (sonnet) -> P3-33 (CEO does the by-hand parts on this PC, A-12).
3. c2 has 77% of its week used with 6 days left. Keep it for P3. New P4 work after c1 resets (11-27 12:00): P4-02 first (Cargo.lock), P4-03, P4-30, P4-46, P4-11, P4-24, P4-29. At most 2 Opus builders per batch, 4 workers total (A-26).

Foreground wait (Claude Code does not reap it):
```
cd /c/dev/Alexia-wt && F=chk_fg.json; for i in 1 2 3; do orca orchestration check --run run_538b6a8b3c5a --wait --types 'worker_done,escalation,question' --timeout-ms 180000 --json > $F 2>&1; if grep -q '"type": *"\(worker_done\|escalation\|question\)"' $F; then break; fi; D=$(grep -o 'delivery_[0-9a-f]*' $F | head -1); [ -n "$D" ] && orca orchestration check --run run_538b6a8b3c5a --ack $D --json >/dev/null 2>&1; done; PYTHONIOENCODING=utf-8 python msgs.py < $F
```
Answer a question with `orca orchestration reply --id <msg_id> --body '...'` (msg id: grep -B2 -A2 '"type": "question"' chk_fg.json). Ack every delivery after acting.

## Watch out for
- Memory: 16 GB. Two Rust reviews at once (cargo test --workspace) leave 2 GB free and Claude Code kills background shells. Keep at most 2 Rust jobs, run CEO checks in the foreground.
- The PC rebooted once (2026-11-25 23:11): workers die, Orca handles go stale. Recover: run-use, map terminals with `orca terminal list --json` (worktreePath), re-dispatch with a RESUME note; no try counted.
- Reviews keep finding real security holes in JS plugins that run PowerShell (P4-23 took 3 rounds). Keep Opus reviews on anything that runs commands or moves files.
- Test strings in Rust src/ that name a plugin (e.g. "telegram") fail node v3/ci/invariants.mjs; tests/ dirs are fine.
- `git reset --hard ORIG_HEAD` in the main checkout also drops uncommitted books: commit books before every merge.
- Backslashes get mangled in heredocs through the Bash tool: build them with chr(92) in Python.

- c2's 5h window burns fast: one Opus review + one Sonnet builder took it from 79% to 97% in an hour. Check usage before every dispatch.

## Open owner asks
- A-25: Phase 4 owner needs 1-8 and the P4 done-when (defaults go ahead; only P4-43/44 need answers).

## Decisions I made (also in LOG.md)
- P3-37 merged on a CEO check (scheduler-only, low-risk Sonnet). LATER: window-origin reminders go to channel primary chats (fix with P4-41/46).
- P3-11 merged on approve. LATER: mute drops counted as waved off (patterns.rs:512).
- No P4 work started (kept CEO #21's rule). Handed off on both-accounts-full with a sleep (CEO.md §16).
