# Handoff · 2026-11-19 · CEO #6 → CEO #7

## Where we are
P0: 14/18 merged (P0-01..P0-13, P0-17). Running: P0-14 fix round (ctx_09570616babe), P0-18 build (ctx_c1ef1998cf44). Todo: P0-15, P0-16.
P1: 2/18 merged (P1-03, P1-14). Rest todo (P1-01 waits on P0-15).
Failed: 0. Blocked-owner: 0.

## What I'd do next
1. Rebind run_7a40b198ac83 (orca orchestration run-use --id ...). Wait (bash C:\dev\Alexia-wt\wait.sh in background) for P0-14 fix and P0-18 worker_done.
2. P0-14: opus re-review of the fix commits only, then merge. P0-18: opus review, merge.
3. P0-15 (sonnet) right after P0-14 merges; it is the gate to all of P1 via P1-01.
4. P0-16 after P0-15: its builder prompt must lift the workflow rule for .github/workflows/v3.yml and v3/ci/ only (template.sh start takes a 4th arg for an extra rule line; replace the workflows line by hand instead).
5. When P0 is fully merged: G-P0 notice to the owner (A-03): what runs and the command (v3\target\release\alexia-hub.exe tools / run), and the by-hand v2-plugins tools check P0-14 left for the owner. Run the whole-phase P0 review (§8, also due by merge count).

## Watch out for
- The owner's chat gets a "You have 1 orchestration message" line for every heartbeat. wait.sh filters heartbeats; when the owner forwards one, stop wait.sh (TaskStop) before running check yourself — never two checks at once.
- Orca sometimes redelivers a worker_done already handled; just ack it.
- pnpm check on Windows is never fully green (see STATE). Compare against a base run in base2 before blaming a branch.
- Timing tests flake under load; ask builders for generous bounds (now in template.sh).
- GitHub push protection refuses fake credential literals; rule is in every builder prompt.

## Open owner asks
- A-09: P1 test bot, which free provider keys (names only, >=2), hedging terms OK. No reply yet.

## Decisions I made (also in LOG.md)
- P1-03 allowed a 2-line user_version assert bump in alexia-store/tests/store.rs.
- P0-13 allowed one stderr logging line in mcp-fixture.rs.
- v2-path merges gate on pnpm check minus the known Windows failures listed in STATE.
- Small follow-up specs written by the CEO directly when the reviewer named the exact fixes (P0-17, P0-18).
- P0-17: keychain-delete-failure test skipped rather than adding a test hook to alexia-store prod code.
