# Handoff · 2026-11-26 17:50 · CEO #24 → CEO #25

## Where we are
Phase 3: 42 of 45 merged. Whole-phase review done; its two high findings (P3-39, P3-40) merged and running in the real hub. P3-41 ready; P3-42, P3-43 todo.
Phase 4: 17 merged / 6 ready (all opus) / 0 running / 23 todo. Nothing running, no open dispatches.
Handed off by rule: owner's tonight scope (A-28) done; c1 full until 11-27 12:00 and c2 week at 93%, so you start 11-27 12:05 on c1.

## What I'd do next
1. run-use, usage check, Telegram (A-25/A-27 answers?). If "A-27 4 yes": set User env ALEXIA_PLUGINS_DIR=C:\dev\Alexia\plugins, stop the hub, then `C:\dev\Alexia-wt\hub-bin\alexia-hub.exe install` (watchdog.rs install uses only the exe path, so the env var must be in the User env).
2. Round on c1, at most 4 workers, at most 2 Opus builders: P3-41 (owner wants the P3 fixes first), P4-02 (Cargo.lock, unblocks most), P4-30, P4-03. Then P3-43 (after P3-41), P4-11, P4-24, P4-29; P3-42 after P4-30/P4-31.
3. After each merge: delete D:\alexia-target\<id>; Telegram line (A-17). Update the real hub after P3-41/P3-43 merge (see STATE.md: start it only via WMI with the new-process-group flags).
4. By-hand P3 checks still open (P3-e2e.md "Not yet checked"): plugin elicitation Approve/Deny/timeout in Telegram, screen-memory capture, lock-screen screen-check.

Foreground wait (Claude Code does not reap it):
```
cd /c/dev/Alexia-wt && F=chk_fg.json; for i in 1 2 3 4 5; do orca orchestration check --run run_538b6a8b3c5a --wait --types 'worker_done,escalation,question' --timeout-ms 100000 --json > $F 2>&1; if grep -q '"type": *"\(worker_done\|escalation\|question\)"' $F; then break; fi; for D in $(grep -o 'delivery_[0-9a-f]*' $F | sort -u); do orca orchestration check --run run_538b6a8b3c5a --ack $D --json >/dev/null 2>&1; done; done; PYTHONIOENCODING=utf-8 python msgs.py < $F | tail -14
```
Question id: `grep -B3 -A3 '"type": *"question"' chk_fg.json | grep -o 'msg_[0-9a-f]*' | head -1`. Start the reply body with "For <task id>:". Ack every delivery after acting.

## Watch out for
- `orca terminal close` sent Ctrl+C to the real hub twice on 11-26 (it had been started from a CEO shell). It is now started in its own process group with no console and survived later closes. Keep it that way.
- D: filled to 0 bytes from old task targets. Delete each task's target after merge.
- Low memory kills cargo runs. Tell builders/reviewers CARGO_BUILD_JOBS=1-2 and touched crates only; answer their "may I rerun" questions with "report, the CEO runs the full workspace".
- `cargo test` stops at the first failing binary: the known servers.rs failures hide later alexia-mcp tests. Use --no-fail-fast.
- The owner was upset that "Phase 3 done" was said before the whole-phase review. Say "planned tasks merged" until the phase review and its fixes are in.

## Open owner asks
- A-25: P4 owner needs (defaults go ahead; only P4-43/44 need answers).
- A-27: trust 11 new plugins, Google client, Moodle login, autostart (`alexia-hub install`).

## Decisions I made (also in LOG.md)
- P3 review findings #1-#6 -> P3-39..43 (scope rule: security / fail-open); #7-#12 LATER.
- Accepted planner layout: P3-43 deps P3-39+P3-41; P3-42 only permissions.rs, deps P4-30/31.
- P3-40 built by Sonnet (c2 week budget), Opus review. P3-39 Opus.
- Deleted 17 merged tasks' D: targets.
- Gateway follow.rs x3 load flake logged LATER.
