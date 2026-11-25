# Handoff · 2026-11-25 · CEO #19 → CEO #20

## Where we are
- Phase 3 (Proactive): 16 merged / 6 ready / 1 running / 0 failed / 0 blocked-owner / 11 todo.
- This run merged (all plugins): P3-00, P3-14, P3-15, P3-17, P3-18, P3-20, P3-22, P3-23, P3-26,
  P3-27, P3-28, P3-29, plus a CEO fix to packages/core/test/noticing.test.ts (memory's tables
  now come from its manifest).
- Running: P3-30 errand kit build (ctx_a4d1adf3a233, C:\dev\Alexia-wt\P3-30).

## What I'd do next
1. `orca orchestration run-use --id run_538b6a8b3c5a`, run the usage check, start `wait.sh`.
2. Review P3-30 when it reports (§8; plugin reviewer prompt as in rv.sh plus the Manifest parse
   and noticing test).
3. Rust work, max 2 compiling at once: finish P3-05 and P3-06 in their worktrees (Opus builder,
   uncommitted planner work is there), P3-04 (committed by the planner, unbuilt), then P3-07
   (partial worktree, after P3-04), and P3-01 (Sonnet).
4. Plugins: P3-19 screen memory (opus; turn it on after merge, A-21 item 8), P3-21 Microsoft
   (opus; stays unconnected, A-21 item 4). P3-24 needs P3-21.
5. Delete merged worktrees (P3-00, 14, 15, 17, 18, 20, 22, 23, 26, 27, 28, 29) and their
   D:\alexia-target\<id> dirs; `git worktree prune`.

## Watch out for
- Claude Code kills background shells "for low memory" (it killed the gate and wait.sh) and
  then asks not to restart them without the owner's go. Keep at most one Rust build beside the
  workers.
- Worker TEMP is D:\alexia-tmp (exFAT): Rust tests that make junctions or use encryption fail
  there ('Local NTFS volumes are required', 'Incorrect function'). Reviewers rerun them with
  TEMP on C:. Consider moving worker TEMP back to C: and cleaning alexia-* there.
- D: worktrees cannot run pnpm check, so a plugin change that breaks a packages/core test goes
  unseen (P3-14 broke noticing.test.ts). Plugin reviews must run that test and a Manifest parse.
- My fix-reason extraction once sent an empty list (the VERDICT line starts with a space):
  take lines starting with '- '.
- Known pnpm flake under load: packages/core compute-connect 'paused request reader stalls
  uploads too' (fails on pre-merge commits too).
- c1 is at 98% of its week until 11-27 12:00. Use c2 (week reset 11-25 03:00).

## Open owner asks
- none in OWNER.md. In chat I asked for "go" to re-run the reaped gate and push (see LOG).

## Decisions I made (also in LOG.md)
- CEO one-line fixes in worktrees: P3-14 Czech genitive weekdays, P3-22 morning DST bounds,
  plus the noticing.test.ts table list on the integration branch.
- Accepted: mail-desk keeps sender name + short reason (notice text needs it); heart nudge on by
  default (A-21); P3-26 lists person reminders in the brief (recall has no 'since').
- Added a note to the P3-16 spec: core must strip a model-set `unlocked` on memory calls.
