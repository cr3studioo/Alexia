# Handoff · 2026-11-19 · CEO #7 → CEO #8

## Where we are
P0: 20/20 merged. That includes P0-19 (host display name, unwritten tables) and P0-20 (idle test de-flake), which this run wrote. G-P0 notice sent (A-10).
P1: 4/18 merged (P1-01, P1-02, P1-03, P1-14). Review: P1-04. Running: P1-11, P1-15, P1-16. Ready: P1-07, P1-09, P1-13. Todo: the rest.
Also running: the P0 whole-phase review. Failed: 0. Blocked-owner: 0.

## What I'd do next
1. `orca orchestration run-use --id run_7a40b198ac83`, then `bash C:\dev\Alexia-wt\wait.sh` in the background. There are five live workers (see STATE).
2. P1-04 re-review approve -> merge -> P1-05 is ready. Settle the P1-05 regex question first (see STATE).
3. When slots free: P1-09 and P1-13 (opus) and P1-07 (opus). At most 2 opus builders at a time.
4. P0 phase review: turn its TASKS into small specs (v3/specs/P0/P0-2x.md) and board rows. The CEO can write them when the reviewer names the exact fix.
5. Send P1 review rounds to the same model and worktree. Re-review the fix commits only. For a trivial fix (one or two lines, exactly as the reviewer asked), the CEO may check the diff and run the gates itself. I did that for P1-02 and logged it.

## Watch out for
- Every heartbeat puts a "You have 1 orchestration message" line in the owner's chat. When the owner forwards one, TaskStop wait.sh before running check yourself. Never run two checks at once.
- Builder "failed" often means only the known pnpm compute-connect failure, or an unrun GitHub check. Read the summary before you retry.
- A builder that finds a bug outside its paths stops (P0-15 did). Write a fix spec rather than retrying it.
- CI changes need a GitHub run. I let the P0-16 fix builder push its own task branch only. I deleted the remote branch after the merge.
- Merging to cr3studioo/v3 triggers the v3.yml CI on GitHub. Glance at `gh run list --branch cr3studioo/v3` now and then.

## Open owner asks
- A-09: P1 test bot, which free provider keys (names only, >=2), OK to race two providers. No reply.
- A-10: G-P0 notice, with the commands to try the hub. No reply needed.

## Decisions I made (also in LOG.md)
- P0-15 failure was a spec gap: I wrote P0-19 for the 2 host bugs instead of retrying.
- P0-16 invariants.mjs skips comment lines. The path check also skips #[cfg(test)] mods and tests/.
- P0-16: Rust pinned to 1.96.1 in CI, and the v2 conformance tests run serially (reviewer: the 2 s heartbeat is test-only).
- P1-01 merged although idle_lazy_plugin_stops flaked in integration (full rerun green). P0-20 fixed the cause.
- P1-02 fix round: the CEO checked the 2-line diff itself instead of a second opus review.
