# Handoff · 2026-11-26 15:10 · CEO #23 → CEO #24

## Where we are
Phase 3: ALL MERGED (40 rows). The owner's Phase 3 week has begun on the real hub (they saw its morning brief in Telegram).
Phase 4: 17 merged / 6 ready (all opus) / 0 running / 23 todo. Merged this run: P3-31, P3-32, P3-33 (+ops), P3-38, P4-46, P4-41.
Handed off by rule: phase fully merged.

## What I'd do next
1. run-use, usage check, read Telegram (A-27 answers: if "4 yes", run `C:\dev\Alexia-wt\hub-bin\alexia-hub.exe install`, but first check that the scheduled task gets ALEXIA_PLUGINS_DIR: it does not by itself (watchdog.rs install uses only the exe path). Set it as a User env var `ALEXIA_PLUGINS_DIR=C:\dev\Alexia\plugins` before install, stop the detached hub, then install).
2. Phase 3 whole-phase Reviewer (CEO.md §8): invariant, crate boundaries, dead code, duplication. Then plan the P3 LATER lines from LOG.md (search "LATER") as a small follow-up set, per the scope rule.
3. Phase 4 on c1 after it resets (11-27 12:00); c2 has ~11% of its week left: keep it for the CEO and reviews. Order: P4-02 first (Cargo.lock), P4-03, P4-30, P4-11, P4-24, P4-29. At most 2 Opus builders per batch, 4 workers total.
4. By-hand P3 checks still open (P3-e2e.md "Not yet checked"): plugin elicitation Approve/Deny/timeout in Telegram, screen-memory capture (check `alexia-hub` screen memory moments after an hour), lock-screen screen-check.

Foreground wait (Claude Code does not reap it):
```
cd /c/dev/Alexia-wt && F=chk_fg.json; for i in 1 2 3; do orca orchestration check --run run_538b6a8b3c5a --wait --types 'worker_done,escalation,question' --timeout-ms 180000 --json > $F 2>&1; if grep -q '"type": *"\(worker_done\|escalation\|question\)"' $F; then break; fi; D=$(grep -o 'delivery_[0-9a-f]*' $F | head -1); [ -n "$D" ] && orca orchestration check --run run_538b6a8b3c5a --ack $D --json >/dev/null 2>&1; done; PYTHONIOENCODING=utf-8 python msgs.py < $F; grep -B3 -A3 '"type": *"question"' $F | grep -o 'msg_[0-9a-f]*' | head -1
```
The last line prints the question's own msg id: reply to THAT id (`orca orchestration reply --id <it> --body '...'`). Ack every delivery after acting.

## Watch out for
- Replying to the wrong msg id sends the answer to another worker (happened twice this run). Use the question's id; start the body with "For <task id>:".
- The owner gets "You have 1 orchestration message" notices in the CEO chat for heartbeats too: check, ack, say one line.
- Memory: closing finished CEO terminals freed ~3 GB (orca terminal list; close those showing ALEXIA-CEO: HANDOFF). Close CEO #23's terminal once you run.
- Builders' foreground cargo runs over 10 min move to background, and Claude Code kills those when memory is low. Tell them CARGO_BUILD_JOBS=1.
- The real hub now runs: anything that starts a hub on the real data (e2e script with -RealData, ops tasks) must stop it first or it exits on the lock.
- The hub data DB is NOT encrypted (spec assumed it was). Don't run `alexia-hub encrypt` without the owner. LATER, check with P4-03 store work.

## Open owner asks
- A-25: P4 owner needs (defaults go ahead; only P4-43/44 need answers).
- A-27: trust 11 new plugins, Google client, Moodle login, autostart (`alexia-hub install`).

## Decisions I made (also in LOG.md)
- P4-46 run on c2 beside P3-31 (fresh 5h window); option C for the window channel.
- P3-32: test-util dev-dep allowed; Sunday brief asserted at the 09:00 fallback (code matches P3-09).
- P4-41 spec widened (api lib.rs, hub main.rs wiring); CEO one-line fix: Live drops before BusyGuard.
- New P3-38 (per-plugin mute), scope rule: phase spec not met.
- Moved 8 outdated v2 plugin copies out of hub data extensions/ (to extensions.v2-old-20261126).
- P3-33-ops applied A-21 (silent list of 12 local, reversible tools; 22 plugins on; screen memory on).
- No new Opus P4 work on c2 (week 87%).
