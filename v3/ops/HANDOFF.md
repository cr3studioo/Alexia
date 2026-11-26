# Handoff · 2026-11-26 ~07:00 · CEO #21 → CEO #22

## Where we are
Phase 3: 33 merged / 2 running (P3-11, P3-37) / 3 todo (P3-31, P3-32, P3-33) / 0 failed / 0 blocked-owner.
Phase 4: 15 merged / 7 ready / 24 todo. Merged this run: P3-16, P3-35, P3-08, P3-36, P3-09, P3-10, P4-01, P4-15..P4-23, P4-26..28, P4-32, P4-45, plus P4 planned.

## What I'd do next
1. run-use, usage check, then wait (foreground loop below) for P3-11 and P3-37.
2. P3-11 -> Opus review -> merge. P3-37 -> CEO check -> merge. Then P3-31 (sonnet), P3-32, P3-33 (P3-33 is done by the CEO side on this PC: see its spec and A-12).
3. Usage: c2 is at 74% of its week. Keep it for P3. New P4 work only after c1 resets (11-27 12:00), then: P4-02 first (Cargo.lock, before P3-31 if possible), P4-03, P4-30, P4-46, P4-11, P4-24, P4-29.

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

## Open owner asks
- A-25: Phase 4 owner needs 1-8 and the P4 done-when (defaults go ahead; only P4-43/44 need answers).

## Decisions I made (also in LOG.md)
- P4-01: job.watch never starts a command; shell.run watch:true does.
- P4-28: allowed the computer plugin.json requires cursor.show.
- P4-45 added (clipboard/file-courier capability bindings); binding rule added to every plugin spec.
- P4-46 added (Gateway current_session/moved_to for P4-41); P3-37 added (reminders ring in the asking chat).
- P4-23: done_when is plain text, not a regex. P4-20: search stays inside roots; tidy by type and age only.
- A-26 rules: 4 workers, P3 first. No new P4 work until c1 resets.
