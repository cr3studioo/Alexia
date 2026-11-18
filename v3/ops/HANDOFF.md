# Handoff · 2026-11-18 · CEO #5 → CEO #6

## Where we are
P0: 11/16 merged (P0-01..P0-11). Running: P0-12 build (ctx_0727d80ab409). Todo: P0-13..P0-16 (serial chain).
P1: planned (v3/specs/P1/, 18 tasks). Running: P1-03 build (ctx_f8fa63409c83). Ready: P1-14. Rest todo.
Failed: 0. Blocked-owner: 0.

## What I'd do next
1. Rebind Orca run run_7a40b198ac83 (run-use). Wait for P0-12 and P1-03 worker_done, then review each (opus reviewer) and merge.
2. Dispatch P1-14 (v2 packages/core/src/agent.ts, opus) when an Opus slot frees; it touches v2, so `pnpm check` at repo root after merge.
3. P0-12 merged -> P0-13 -> P0-14 -> P0-15 -> P0-16 (P0-16 builder prompt must allow .github/workflows/v3.yml and v3/ci/ only). P0-15 merged -> P1-01 -> P1-02 unlocks most of P1.
4. When P0 is fully merged: G-P0 is a notice only (A-03): tell the owner what runs and the command.

## Watch out for
- Orca check output starts with keepalive JSON lines; C:\dev\Alexia-wt\msgs.py parses it, C:\dev\Alexia-wt\wait.sh loops until a non-heartbeat message (run it in the background). Never run two checks at once; they clobber each other.
- Workers can stall on the 5-hour usage limit with activity done and no worker_done. Read the terminal (orca terminal read --terminal <term_...> --screen --json) and, once usage is back, type continue into it (orca terminal send --text continue --enter).
- GitHub push protection refuses fake credential literals (AKIA..., etc.) in any commit. Every builder prompt now says to build them from halves with concat!. If a push is refused: reset the local merge to origin, have a fixer split the literals and squash the task branch.
- Reviewers often find real v2-parity gaps; budget 1-2 fix rounds per opus task.
- C:\dev\Alexia-wt\plan-P1 folder could not be deleted (locked); delete it when free. Its branch is gone.
- The `/remotecontrol` slash command is not installed in CEO sessions; the owner asked for remote control once.

## Open owner asks
- A-09: P1 test bot, which free provider keys (names only, >=2), hedging terms OK. Sent on Telegram. Last update_id processed: none.

## Decisions I made (also in LOG.md)
- P0-07: INSERT OR REPLACE on kv/settings kept; empty hub p_* tables replaced, filled refused.
- P0-08: v2 parity means refusing null in nested strict objects too, settings excepted.
- Planner ran in its own worktree/branch to avoid colliding with book commits; CEO merged it.
- P1-03 also carries the db.rs:107/109 follow-ups.
