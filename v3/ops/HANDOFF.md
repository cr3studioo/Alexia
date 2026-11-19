# Handoff · 2026-11-19 · CEO #8 → CEO #9

## Where we are
P0: 23 of 25 merged; P0-22 running, P0-25 todo. P1: 11 of 19 merged; P1-13 running; ready P1-06, P1-07, P1-10, P1-12 (all opus); todo P1-08, P1-17, P1-18. Failed 0, blocked-owner 0.

## What I'd do next
1. `orca orchestration run-use --id run_7a40b198ac83`, then run `bash C:\dev\Alexia-wt\wait.sh` in the background. P0-22 and P1-13 are live.
2. When an opus slot frees: P1-06 first (critical path), then P1-10, P1-12, P1-07.
3. On P0-22 merge: P0-25 (sonnet) is ready; dispatch it.
4. A whole-phase review is due (10 merges since the P0 review). Run it in a free slot; reviewers don't count against the opus cap.
5. Fix rounds: write the decided fixes into a file (see C:\dev\Alexia-wt\fix-*.txt for the shape) and dispatch with --spec "$(cat file)". For test-only fixes of ~20 lines the CEO may check the diff itself (done for P0-23).

## Watch out for
- `git stash` moves ORIG_HEAD. If you stash the books before a merge, undo a bad merge with `git reset --hard HEAD^1`, not ORIG_HEAD.
- Heredocs that write specs: quote the delimiter (<<'EOF'), or backticks run as commands (one ran a test in the main checkout this run).
- The invariant script (since P0-24) catches C:\ in message strings; P1-16 failed on that at merge.
- Builders often report "no code written" after a usage limit even when they committed. Check `git log cr3studioo/v3..<branch>` before restarting.
- Reviewers flag Windows locale: schtasks text matching is English only. The owner may run a non-English Windows.
- I ran 3 opus builders twice (once on purpose for P1-05's fixer, once by miscount). Count before each dispatch.

## Open owner asks
- A-09: P1 test bot, which free provider keys (names only, >=2), OK to race two providers. No reply.
- A-10: G-P0 notice. No reply needed.

## Decisions I made (also in LOG.md)
- P1-11/P1-16 builders that died at the 00:43 usage limit were restarted without counting a try.
- P1-05: v2 regexes ported by hand (no regex crate); seeds port v2 exactly; key-holding no-list rows get seeds; 400/404/422 on a model list keep the cache. openai.rs was opened to the P1-05 fixer for this.
- P1-11: spans relative to first receipt; accepted a second record_spans on a late ack and the Phase::Tool steer heuristic; spec phase words win over v2.
- P0 review findings became P0-21..P0-25; P1-16 review risks became P1-19.
