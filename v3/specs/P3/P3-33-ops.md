# P3-33-ops: Apply the owner's Phase 3 settings to the real hub data

Model: sonnet
Depends on: P3-33 (script merged)
Feature IDs: none (operations on this PC; no code changes)

## Goal
The owner's real v3 data (`%LOCALAPPDATA%\AlexiaHub`) carries the owner's Phase 3 answers (A-21
in `v3/ops/OWNER.md`), so that when the coordinator starts the real hub the owner's week can
begin. You change **data, not code**, through the hub's own CLI or HTTP API wherever one exists.

## Touch only these paths
- `v3/ops/reports/P3-33-ops.md`   (create: your report)
- The owner's hub data folder, only as listed in Steps, and only after the backup in step 1.

## Must not touch
Any code, spec, plugin or workflow file. `main`. `%LOCALAPPDATA%\Alexia` (v2's data).
`extensions.v2-old-20261126` (the coordinator's backup). Secrets: never print, copy or log a key.

## Steps
1. No hub may be running (`Get-Process alexia-hub`); if one is, stop and report. Back up the
   data folder: copy `alexia.db` (and any `-wal`/`-shm`) and `plugins\` to
   `D:\alexia-backup\hub-20261126\` (create it). Print the backup size.
2. Hub binary: `D:\alexia-target\main\release\alexia-hub.exe` (built by the coordinator from
   `cr3studioo/v3`). Read `alexia-hub` usage and `v3/crates/alexia-hub/src/main.rs`'s command
   table, and where the scheduler reads its config (`alexia-scheduler`: quiet hours,
   `brief_earliest`, `brief_fallback`, evening and weekly times), to learn how each setting below
   is stored. Prefer a CLI verb; else the hub's HTTP API (start the hub on the real data with
   `ALEXIA_PLUGINS_DIR=C:\dev\Alexia\plugins`, use the API, stop it cleanly); write the store
   directly only if neither exists, and say so in the report.
3. Apply A-21:
   - Quiet hours 00:00-08:00, only Urgent gets through (`alexia-hub quiet 00:00 08:00 urgent`
     or the verb's real form).
   - Morning brief: first sign of the owner after 05:00, else 09:00. Evening wrap-up 22:00.
     Weekly review Sunday 18:00.
   - Silent list: the tools of the *Owner needs 1* list in `v3/specs/P3/PHASE.md` (her own
     memory; her own notices and reminders; add/tick tasks and shopping, never delete; record
     commitments; drafts kept on this PC; index and summarise chosen folders). Use
     `alexia-hub silent allow <tool>` per tool id. Only tools that are local, reversible, not
     outward-facing, and not on the PHASE.md "Always asks" list. List each tool id you add.
   - Enable these P3 plugins (they need no account): commitments, task-list, memory,
     notes-library, day-planner, errand-kit, study-desk, screen-memory, documents, persona,
     telegram, file-finder, web-research, page-watch, apple-context, google-account (it stays idle
     until the owner adds the Google client; no Microsoft: leave microsoft-account disabled).
     Leave plugins already enabled as they are. Skip any id that does not exist in `plugins/`
     or would refuse to load; report why.
   - Screen memory on (A-21 #8), with its defaults (text only, never while a private chat,
     password field or game is in front).
4. Prove it: with the hub stopped, run
   `powershell -File v3/ops/reports/p3-e2e.ps1 -DryRun` from `C:\dev\Alexia`. Expected: step 4
   lists the plugins above as enabled; step 5 will now FAIL because the silent list is no longer
   empty. Say so in the report, it is expected (P3-33's notes).
5. Leave no hub or node process of yours running.

## Done when
- The backup exists and its size is printed.
- `alexia-hub quiet`, `alexia-hub silent list` and `alexia-hub plugins` show the settings above.
- The dry run's only FAIL is step 5 (silent list not empty).
- `v3/ops/reports/P3-33-ops.md` (at most 40 lines): what was set, how (CLI / API / store), the
  silent tool ids, enabled plugins, anything skipped and why. No secrets, no notice text, no user
  paths beyond `%LOCALAPPDATA%`.

## Notes for the worker
- The database may or may not be encrypted (P3-33 found it unencrypted). Do not run
  `alexia-hub encrypt`.
- Only one hub per PC: start one at a time, and stop it with the same clean stop the e2e script
  uses (read `p3-e2e.ps1` step 8).
- Telegram: starting the hub on the real data starts the real bot. Keep such runs short and
  send nothing.
