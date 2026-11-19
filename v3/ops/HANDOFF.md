# Handoff · 2026-11-19 · CEO #10 → CEO #11

## Where we are
Phase 0: 26/26 merged. Phase 1: 26 of 31 merged; running P1-26 (opus) and P1-28 (sonnet); todo P1-29, P1-30 (after P1-28), P1-18 (after P1-26, needs A-09). Failed 0, blocked-owner 0.

## What I'd do next
1. `orca orchestration run-use --id run_7a40b198ac83`, then `bash C:/dev/Alexia-wt/wait.sh` in the background (timeout 7200000; it can time out, so just restart it).
2. On P1-28 done: `rv P1-28 P1`; after its merge start P1-29 (opus) and P1-30 (sonnet) together.
3. On P1-26 done: review, merge, then P1-18 if A-09 is answered. If not, P1-18's code part (fake Bot API e2e test) can still be built; only the 50 real messages need the owner. Consider splitting it.
4. Have a Planner spec the P1-17 review minors (STATE.md, Follow-ups) as one sonnet task touching alexia-hub/src/main.rs.
5. When P1 is fully merged: phase review, the P1 phase notice to the owner (§9), then plan P2 (V3-2) and hand off (phase merged = handoff rule).

## Watch out for
- The owner asked in chat what P1 and the task numbers mean. Explain status in plain words with a phase table; they are not following the jargon.
- The owner often types "You have 1 orchestration message". Most are heartbeats: check, ack, and say so in one line.
- gate.sh is the merge gate; for v2 paths also pnpm check in base2 (STATE.md). Load flakes: rerun the single file 2-3 times on its own before calling it a real failure.
- Workers ask questions mid-task (orca reply --id msg_... ). Answer fast. I allowed: P1-10 to edit telegram/api.rs (download returns bytes), P1-17 to loosen tests/cli.rs run_starts_and_stops.
- Orca sends the same worker_done twice sometimes; check the dispatch id.

## Open owner asks
- A-09: test bot, free provider key names (2+), OK to race two providers. No reply; Telegram reminder sent.
- A-10: G-P0 notice. No reply needed.

## Decisions I made (also in LOG.md)
- Phase review 2 findings: P1-25 widened to opus (span start fix); P1-17 re-planned; new P1-26..P1-31 follow-ups.
- P1-12 shipped without the 10-min paused-time test (P1-30 adds it).
- noticing.test, compute-acceptance and provider.test failures treated as load flakes (pass alone).
