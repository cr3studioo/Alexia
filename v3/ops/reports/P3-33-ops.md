# P3-33-ops report (2026-11-26, data in `%LOCALAPPDATA%\AlexiaHub`)

Status: done. Read problem 1 before the week starts: 5 of the 12 silent entries have no effect yet.

What I built (settings only, no code):
- Backup first, no hub running: `D:\alexia-backup\hub-20261126\`, 438 files, 303,233,099 bytes (289.2 MB); `alexia.db` hash matched (no `-wal`/`-shm` existed). Left out `plugins\media\comfyui` and `\models` (49.3 GB, D: had 49.3 GB free; coordinator approved; never touched).
- CLI: `quiet 00:00 08:00 urgent`; `silent allow` for the 10 plugin tools below.
- Store (no CLI verb or API route exists): kv `_core`/`proactive` `brief_earliest` 05:00, `brief_fallback` 09:00, `evening` 22:00, `weekly` Sunday 18:00 (hub stopped, one transaction, `quiet` kept).
- HTTP API, one hub run of 4 s: `/api/plugin` enable; `/api/settings` screen-memory `on` = true (other settings stay default); `/api/command` `/silent allow` for the 2 built-in tools (the CLI refuses those).
- That run: secrets in memory (no bot token read, nothing sent), `quiet pause 15` before and `quiet resume` after; clean stop (exit 0, "Stopped."); no job, notice or brief recorded.

Silent list (12): `schedule.add`, `follow_up`, `memory__remember`, `memory__no_longer_true`, `memory__sort_now`, `commitments__commit`, `commitments__nudge`, `task-list__add_task`, `task-list__tasks_add`, `task-list__done_task`, `notes-library__reindex`, `study-desk__lecture_notes`.
Enabled now by me: commitments, task-list, notes-library, day-planner, errand-kit, study-desk, screen-memory, file-finder, web-research, page-watch, apple-context, google-account (idle, no Google client), and ocr (not in the spec's list: only provider of `image.ocr`, coordinator said enable).
Already enabled, left so: memory, documents, persona, telegram, claude-code, computer, hello, media, voice (22 in all). Left disabled: microsoft-account (spec), mail-desk (not listed). No listed id was missing or refused.

Left off the silent list:
- `schedule.cancel`, `telegram__forget_reminder`: they cancel any reminder, not only ones she made. No tool moves one. `telegram__remind`: marked outward-facing.
- `*__notice_done`: closes the promise or task behind a notice. No tool holds or snoozes notices (the scheduler does that itself).
- Reply drafts: only mail-desk has them, and it is disabled.
- Not named by PHASE.md: memory goal/goal_done/still_true/pin/move/branch/suggestion/import/capture tools, `commitments__close_commitment`, study cards and exams, paperwork add/done.

Files changed: `v3/ops/reports/P3-33-ops.md` (this report).
Tests added: none. No crate changed, so no `cargo test -p`; `cargo test --workspace` was not run. The only cargo run was the dry run's step 1 (`D:\alexia-target\main`, as the coordinator chose).

Done-when results:
- Backup exists, size printed: pass
- `alexia-hub quiet` ("00:00 to 08:00. Only urgent things get through."), `silent list` (the 12), `plugins` (22 enabled): pass
- Dry run from `C:\dev\Alexia` at 7da1b98a: 4 PASS, 1 FAIL, 4 SKIPPED; only FAIL is step 5, expected (list no longer empty): pass. Step 4: 14 of 14 P3 plugins; WARN mail-desk and microsoft-account disabled, old copies hide claude-code, hello, media.
- This report, at most 40 lines: pass. No hub, node or cargo process of mine left: pass

Problems or doubts:
1. Unreviewed ids (`_core`/`unreviewed`), not trusted by me (owner's decision): enabled apple-context, day-planner, errand-kit, file-finder, google-account, notes-library, page-watch, screen-memory, study-desk, task-list, web-research; disabled browser-pilot, crasher, device-clipboard, device-notify, file-courier, mail-desk, microsoft-account, pc-care, screen-ink, screen-look, shell-runner, vanisher, window-deck. Until trusted, their tools always ask, reads included: the task-list, notes-library and study-desk silent entries do nothing.
2. Screen memory says "On, every 5 minutes", 0 moments: no capture was proven (the run was too short). Check after some minutes of the real hub.
3. The data changes used the 14:18 hub build; the coordinator rebuilt it at 14:31, and the final `quiet`/`silent list`/`plugins` check and dry run came after.
4. No morning brief is recorded for today, so the real hub may give one at the first PC input after it starts.
