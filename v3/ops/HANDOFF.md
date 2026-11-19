# Handoff · 2026-11-19 · CEO #9 → CEO #10

## Where we are
Phase 0: 25/25 merged; P0-26 (de-flake) running. Phase 1: 14 of 25 merged; P1-08 running; P1-13, P1-21, P1-24 in review; P1-10 fix queued; ready P1-07, P1-12, P1-23 (opus); todo P1-17, P1-18, P1-25. Failed 0, blocked-owner 0.

## What I'd do next
1. `orca orchestration run-use --id run_7a40b198ac83`, then `bash C:/dev/Alexia-wt/wait.sh` in the background. Five workers are live (see STATE.md).
2. First free opus builder slot: the P1-10 fix (fix-P1-10.txt, already written). Then P1-12, P1-07, P1-23.
3. Merge approved reviews one at a time: pull, merge --no-ff, fmt/clippy/test in v3/, invariants from repo root, push, remove worktree.
4. Have a Planner spec the three follow-ups in STATE.md (Turn files field, supervise.rs de-flake, and note the tool-row mapping for V3-2).
5. Phase review is due again at 10 merges (5 so far).

## Watch out for
- Full-workspace test runs are flaky under load in alexia-mcp: conn.rs junk_is_skipped_and_logged (P0-26 fixing) and supervise.rs call_at_idle_deadline_never_gone. A rerun passes; don't fail a merge on those alone.
- Orca often sends the same worker_done twice. Check the dispatch id before acting.
- One `start` call for a worktree with packages/ can take more than 2 min; the Bash tool backgrounds it. Read its output file for the dispatch id.
- invariants.mjs must run from the repo root (it fails with ENOENT from v3/).

## Open owner asks
- A-09: P1 test bot, which free provider keys (names only, >=2), OK to race two providers. No reply.
- A-10: G-P0 notice. No reply needed.

## Decisions I made (also in LOG.md)
- Phase review findings became P1-20..P1-25 (Planner); conn.rs flake became P0-26 (CEO wrote the spec, test-only).
- P1-08 may make alexia-mcp process::redact public instead of copying it.
- P1-10 fixes: asks keyed by (chat, message id) with a time-seeded seq; failed downloads still deliver text with a note; stale presses don't edit; pairing code rotates after 5 misses.
- P1-13 fixes: one span per step through phase/progress events; cancel during POST always sends /api/stop; documents gap tracked separately.
- P1-08 went ahead of the P1-10 fix for the opus slot (critical path).
