# Handoff · 2026-11-28 18:05 · CEO #25 → CEO #26

## Where we are
Phase 3: 44 of 45 merged. P3-42 ready (deps P4-30, P4-31 merged). After it, P3 is fully merged (whole-phase review already done 11-26).
Phase 4: 27 of 46 merged / 7 ready (P4-05, P4-06, P4-13, P4-25, P4-33, P4-34, P3-42; all opus) / 0 running / 0 failed. No live dispatches.
CEO #25 merged 13 tasks on 11-28: P3-41, P3-43, P4-02, P4-03, P4-04, P4-07, P4-11, P4-12, P4-24, P4-29, P4-30, P4-31 (+ connect/ rustfmt commit).
Handed off by rule (5 rounds, long context); the owner paused for D: (A-29) and plugged it back in at 18:00.

## What I'd do next
1. run-use, usage check, Telegram. Round on c1: P3-42 (owner wants P3 finished first) + P4-05 or P4-33 (each unblocks the most). At most 2 Opus builders, 4 workers total.
2. Fill free slots with reviews and P4-06, P4-13, P4-25, P4-34.
3. The first gate on D:/alexia-target/main rebuilds a lot (stale since 11-26). Run it in the background.
4. Update the real hub after a few more merges (current exe = 11-28 14:55 build).

## Watch out for
- Spec notes from reviews were APPENDED to P4-05, P4-33, P4-34, P4-37 ("From the P4-xx review" sections). They are security requirements (guest_of fail-open, relative paths for guests, run:mesh from any manifest, unbounded dial, revoke order). Reviewers must check them.
- Builders often need one-line edits outside their touch list (struct literals, schema-version asserts). They ask; say yes when it is mechanical and in its own commit.
- New load flakes (LATER): gateway notice_buttons.rs, follow.rs x3, alexia-api local_models token_not_echoed, mcp wasm slow_compile. Rerun alone before failing a merge.
- When several approved branches touch disjoint crates, merging them as a stack and gating once saved hours (done once 11-28, logged).
- If the branch base equals the current tip (only books differ), the reviewer's full workspace run is the gate.
- Use `date` for LOG timestamps. I guessed times once and had to fix them.
- If the PC reboots: the hub doesn't come back on its own (A-27 4 open). Start it via WMI (STATE.md). Check D: is mounted.

## Open owner asks
- A-25: P4 owner needs (defaults go ahead; only P4-43/44 need answers).
- A-27: trust 11 plugins, Google client, Moodle login, autostart (`alexia-hub install`).

## Decisions I made (also in LOG.md)
- While D: was out: cargo targets on C:\dev\Alexia-wt\target (now deleted; helpers back on D:).
- connect/ rustfmt-ed (whitespace only) so `cargo fmt --all` stays green with the alexia-connect path dep.
- P4-24 review minors fixed by the CEO in the worktree; P4-29 got a fix round (4 bugs) and re-review.
- Cap for computer recordings = replay MAX_STEPS (60).
