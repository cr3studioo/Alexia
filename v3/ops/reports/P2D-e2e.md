# P2D-15: end to end on the real app, this PC

Date 2026-11-24. Branch `cr3studioo/v3-P2D-15`, built from commit `2e975fd` + the script commits
(run commit `96bf58a`). Machine: Windows 11 Home build 26200, 15.9 GB RAM, NVIDIA GeForce RTX 4060 Ti,
8188 MiB. Script: `v3/ops/reports/p2d-e2e.ps1` (run 1 full with build; runs 2 and 3 with `-SkipBuild`
after two bugs in the script itself, both fixed: a Node top-level `await`, and a one-element PowerShell
array that lost its `.Count`). Logs: `%TEMP%\p2d-e2e\` (results.json, one log per step).

## Results

| Step | Result | Evidence |
|---|---|---|
| 1 Build | pass | `pnpm install --frozen-lockfile` 8 s, `pnpm sidecar` 1122 s, `pnpm tauri build --no-bundle` 329 s (no missing tool). `src-tauri\target\release\alexia.exe` |
| 2 Before | info | no v2 app, no hub, no `window.json`, no scheduled task. The v2 app was not running, so nothing was stopped or restarted. |
| 3 Open | pass | window.json after 2.3-4.5 s, `GET /` 200, token read from the page. One `alexia-hub.exe` (parent = the app). 0 processes with `boot.mjs` / `packages\core`. 9 plugin node processes, all under the hub (0 outside). |
| 4 Screens | pass with 2 differences (run 3) | 80 rows: 34 pass, 2 differ, 44 skipped (table below) |
| 5 pc_actions | **pass after P2D-19** (first runs: pass once, then fail) | see Failures and Rerun |
| 6 One brain | **not observed** | The owner did not send "p2d ping" (5 min in run 1, 60 s in runs 2 and 3). Same hub pid throughout. The app's chat list does show a `telegram` chat from the owner's earlier use, so the app reads the same store Telegram writes to; that is not the ping. |
| 7 Attach | pass | app quit, hub it started stopped itself within 30 s. Console hub pid 22012 started; app started again: still one `alexia-hub.exe`, pid 22012, none under the app, `window.json` pid 22012. Quitting the app left the console hub running. |
| 7b Start again | partly | stopped the app's hub by pid. Within 20 s the app **started a new hub by itself** (pid 9284 -> 19016) and `window.json` answered. The button was therefore never shown/pressed. 1 s after the stop, UI Automation saw only the window frame ("Alexia": Minimize, Maximize, Close); the page inside is not exposed in that moment. The button path (press through UI Automation) is **not tested**. |
| 8 After | pass | nothing of ours left running |

## Screen table (run 3)

Pass (34): S1 S2 S3 S4 A6 A7 C6 P1 P7 B1 L1 L2 M1 M2 M3 M4 M6 M7 M8 M17 R1 R4 R5 R7 R9 R12 R13 R16 R17 R18 E2 E3 E6 E7.

Differ (2), against shapes recorded from a fresh v2, on the owner's real data:
- A1 `GET /api/state`: 200, but keys `/pins/model` and `/pins/spend` are present (the owner has pins; the fresh case has none).
- R21 `GET /api/compute/services`: 200, key `/mailbox` present that the recorded shape lacks.
Both look like real-state differences (optional keys), not broken routes; the reviewer should decide.

Skipped (44), not requests the script may send to the owner's live hub: C1 (runs the owner's model), C2 C3 C4 C5, C7 (open file), A2 A3 A4 A5 (write settings), P2 (plugin delete), P3 P4 P5 P6, B2 (needs a fixture chat), B3 (includes forget_chat), B4, L3 (library install), M5, M9-M16 (installs, benchmark, model remove, token), R2 (role switch), R3 R6 R8 R10, R11 (unpair), R14 R15 R19 R20 R22 R23, E1 E4 E5, T4 (see 7b).

## Failures

**pc_actions** (`cargo test -p alexia-hub --features pc-actions --test pc_actions -- --nocapture`):
run 1: `1 passed` (18 s). Runs 2 and 3, and 4 more manual runs: `FAILED`, same place: the scripted model opens
Character Map (pid 7128), `focus` works, then `computer__elements` returns "Nothing there names itself" and the
turn ends `charmap has no Characters to copy box.`; `computer__click: []` assertion at `pc_actions.rs:773`. Not caused by the
app (also fails with no app open). A plain UI Automation read of a freshly started Character Map on this PC
does list "Characters to copy :" (id 104). Not fixed here; looks like a P2D-12 / `plugins/computer` finding
(the plugin's `elements` does not see the window the test just opened).

**One brain**: not observed, see above.

## What the owner must still do (PHASE.md Owner needs)
- Send "p2d ping" on Telegram while `p2d-e2e.ps1` waits (step 6), or tell me to rerun.
- Decide which hub starts at sign-in; whether to install the NSIS build over v2; turn on Computer control (Allow her to press things, Trust), Permissions folders.

## Rerun after P2D-19 (CEO, 2026-11-24)

P2D-19 found the cause of the step 5 failure: the computer plugin picked Character Map's tooltip-shadow
window (SysShadow, same pid, in front of the dialog) instead of the dialog, so `elements` saw nothing.
After merging `cr3studioo/v3` (with P2D-19, 9e23e0b) into this branch, step 5 was run again from
PowerShell in the owner's session, 3 times: all passed (23 s, 22 s, 16 s), each typing "alexia p2d" into
Character Map and reading it back ("read back: \"alexia p2d\"", `test result: ok. 1 passed`).

Accepted by the CEO: A1/R21 differences are optional keys from the owner's real data; 7b shows the app
restarting a stopped hub by itself (the Start again button is not needed in that case); step 6 is open
until the owner sends "p2d ping".
