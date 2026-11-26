# P3-33: end to end on this PC

Date 2026-11-26. Branch `cr3studioo/v3-P3-33`, built from commit `d63809f`. Windows 11 Home, 16 GB RAM.
Script: `v3/ops/reports/p3-e2e.ps1`. Logs: `%TEMP%\p3-e2e\` (transcript.txt, results.json, one log per step).

**The real run has not happened yet.** The coordinator does it with the owner nearby. Everything below is `-DryRun`.

## Results (`-DryRun`, twice in a row, same result)

| Step | Result | Evidence |
|---|---|---|
| 1 build | PASS | `pnpm install --frozen-lockfile`, plugin SDK, `cargo build -p alexia-hub --release` (1281 s the first time, `CARGO_BUILD_JOBS=1`) |
| 2 data | PASS | copy of the hub's data folder: 464 files, 162.4 MB; left out 3 model or image-engine folders and files over 100 MB. The database is **not** encrypted |
| 3 start | SKIPPED | `-DryRun` starts no hub |
| 4 plugins | PASS, 2 WARN | 35 listed; P3 plugins loaded from this checkout 14 of 14, none refused or unhealthy. Warnings below |
| 5 silent list | PASS | the list is empty |
| 6 brief | SKIPPED | `-DryRun` sends nothing to Telegram |
| 7 notices | SKIPPED | `-DryRun` does steps 1, 2, 4 and 5 only (no counts yet) |
| 8 stop | SKIPPED | `-DryRun` started no hub |
| 8 nothing left | PASS | no process the run started is still running; no `alexia-hub` afterwards; scratch copy removed |

Total: 5 PASS, 0 FAIL, 4 SKIPPED. Exit 0.

## Plugins hidden by copies in the data folder

A copy in the data folder's `extensions/` wins over the same plugin in the checkout. Step 4 FAILs when that hides a P3 plugin.

The first dry run did not look for this and passed. The first run with the check FAILed step 4:

| P3 plugin | Data folder | Repo |
|---|---|---|
| commitments | 0.1.0 | 0.2.0 |
| computer | 0.2.0 | 1.0.0 |
| memory | 0.1.0 | 0.8.0 |

The coordinator then moved the old copies out of `extensions/` (2026-11-26 13:39); no P3 plugin has been hidden since.
Still hidden (not P3, warning only): claude-code 0.1.0 (repo 0.1.0), hello 0.1.0 (0.1.0), media 0.9.0 (0.9.0).
Also hidden in the first run and cleared since: documents 0.2.0 (0.3.0), ocr 0.1.0 (0.2.0), persona 0.2.0 (0.5.1), telegram 0.1.1 (0.5.2), voice 0.1.0 (0.5.0).

## WARN: P3 plugins that are disabled (12 of 14)

apple-context, commitments, day-planner, errand-kit, google-account, mail-desk, microsoft-account,
notes-library, page-watch, screen-memory, study-desk, task-list.
Enabled: computer, memory. A disabled plugin offers no notices or brief sections.

## Steps 3 and 6-8, tested in isolation (approved by the coordinator)

A throwaway copy of the script (not committed): an empty fake data folder, secrets in memory (no token, no
channel, nothing sent), the "no channel" guard off. This proves the script's mechanics, **not** delivery.
- With `-Seen y`: 9 PASS (hub up in 1.8 s; brief said after 52 s; 0 notices; exit 0; nothing left of 99 processes).
- No `-Seen`, no console: 8 PASS, step 6 SKIPPED (brief said after 22 s, nobody confirmed).
- With another hub running: exit 2, the hub named and not stopped (process check, and the lock check).

## For the real run
- No hub may be running. Run from the owner's own terminal to be asked in step 6, or pass `-Seen`.
- The scratch hub uses the real bot and runs whatever is due in the copied data.
- The `telegram` plugin is enabled and resident. If it has its own bot token it would compete with the hub's
  channel (not checked: the script reads no secrets).
- Step 5 FAILs if the silent list has been filled (the owner approved a list in A-21): run first, add it after.
- Enable the P3 plugins before the owner's week starts; then record steps 3 and 6-8 here.

## Other checks
`cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`: pass. `node v3/ci/invariants.mjs`: ok.

## Not done by this task
Turning screen memory on (A-21 #8), the quiet hours and brief times from A-21, and the by-hand checks (elicitation
Approve/Deny/no answer on Telegram; lock-screen check) are not in the script and were not done.
