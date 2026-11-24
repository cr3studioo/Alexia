# P2D phase review (end of phase)

Reviewer, 2026-11-24. Branch `cr3studioo/v3` at `01a5c7b` (clean). Phase diff from `e235c18`
(the commit before P2D-03 merged). Read: CLAUDE.md, CEO.md §1-3, §8, specs/P2D/PHASE.md, the P2D
reports, `P2D-e2e.md`. No file changed except this one.

## Verdict: **fail**: 3 BLOCKERs (1 security, 2 Done-when gaps), all small

The code is in good shape. The invariants hold, the crate boundaries are clean, the contract
covers every INVENTORY row, and fmt, clippy and tests are green. The 3 BLOCKERs are a one-line
Host check that is weaker than it looks, one missing step in `pc_actions`, and the Telegram
check, which the owner has not done yet.

## Commands run (this review)

| Command | Result |
|---|---|
| `cargo fmt --all --check` | pass |
| `cargo clippy --workspace --all-targets -- -D warnings` | pass |
| `cargo test --workspace --no-fail-fast` | pass except `alexia-mcp --test supervise`: `call_at_idle_deadline_never_gone` hung for more than 10 min under workspace load, so I killed it. Rerun alone: 16/16 pass, twice (58 s each). The listed known flakes all passed. `contract` 7/7, `window` 3/3, all `alexia-api` test files green |
| `node v3/ci/invariants.mjs` / `--self-test` | ok / ok |
| `pnpm check` (repo root) | lint, typecheck and invariants pass. `pnpm test`: 2895 pass, 1 fails: `packages/core/test/compute-connect.test.ts` "a paused request reader stalls uploads too". It fails the same way alone, twice. P2D did not touch that file or `packages/core/src` (last changed 2026-10-03). It is a known failure on Windows/Node 24 (LOG 2026-11-18, 2026-11-23) |
| `pc_actions` | **not run** by me: it takes over the mouse and keyboard in the owner's session. I used the evidence below |

## Done-when

| # | Done when | Status | Evidence |
|---|---|---|---|
| 1 | The app opens on Windows and starts only the hub; it attaches to an existing hub | **met** (with a note) | P2D-e2e step 3: one `alexia-hub.exe` whose parent is the app, 0 `boot.mjs`/`packages\core` processes, 9 plugin node processes under the hub. Step 7: it attaches to console hub pid 22012 and starts no second hub. Note: the build was `pnpm sidecar` + `tauri build --no-bundle`, not `pnpm app`, so the NSIS bundling step was never run (LATER L9) |
| 2 | Every INVENTORY row answers with the v2 shape; check 12 | **met** | `contract` passes (this run). All 121 cases are `"hub": "answers"`, none `pending`. No case ignores the whole body. Check 12 passes and its self-test catches a planted gap |
| 3 | PC actions scripted (`pc_actions`) | **not fully met** | P2D-12 report: windows, open_app, screenshot (PNG), plan progress (4 `stages` frames), docx `document.extract`, Allow and Deny (`pc_actions.rs:1129-1160`), reveal. After P2D-19 it passed 3/3 (CEO note in P2D-e2e.md). Character Map replaces Notepad (coordinator decision, justified in P2D-12). **Open on a produced file is never exercised**: only `"action": "reveal"` is sent (`pc_actions.rs:1162`). The Open path is only unit-tested with a recorder, and refuses `.exe` (`alexia-api/tests/chat.rs:949`). See B2 |
| 4 | On the real app: a scripted walk through every screen, the PC check, a Telegram message answered by the same hub with the window open, recorded | **not met** | Screens: 34 pass, 2 differ (accepted), 44 skipped, and every screen group (S A C P B L M R E) has at least one pass. PC check: passed after P2D-19. **Step 6 "One brain" not observed**: the owner never sent "p2d ping" (P2D-e2e.md table, step 6). See B3 |
| 5 | fmt, clippy and `cargo test --workspace` pass in `v3/`; `pnpm check` passes | **met for P2D** | Cargo is green (one mcp test hung under load and passes alone, L7). `pnpm check` is red only on the known v2 compute-connect failure, which predates P2D (L8) |

## Invariants (item 1): all hold

- No crate names a plugin: no quoted plugin id in any `v3/crates/*/src`. The `"telegram"` hits
  are the gateway's built-in channel (P1), not the plugin. The `computer` hits are English
  sentences. `pc_actions.rs` finds plugins by capability and names only tool names (P2D-12 report).
- No hard-coded user paths in crate `src/`. The only `C:\Users\…` strings are inside `#[cfg(test)]`
  (`alexia-core/src/permissions.rs:589`, `alexia-store/src/import.rs:410`). Contract fixtures: L5.
- Loopback only: the two binds are `alexia-hub/src/main.rs:576` (`"127.0.0.1"`) and
  `alexia-core/src/local.rs:886` (`"127.0.0.1"`). Check 13 passes.
- Alexia Dev: `tauri.dev.conf.json`, `dev-app.mjs`, `ALEXIA_DEV_NAME` and `ALEXIA_KEYCHAIN` appear
  nowhere in `tauri.conf.json`, `tauri.macos.conf.json` or `.github/workflows`.
- v2 paths changed: `src-tauri/src/{main,hub}.rs`, `scripts/sidecar.mjs`, 3 tests in
  `packages/core/test` (CEO-approved, LOG 2026-11-23) and `plugins/computer` (P2D-16..19 specs).
  `hub.rs` is new, outside PHASE.md's "Nothing else" list, and recorded as approved in the P2D-13 report.

## Crate boundaries (item 2): clean

`alexia-api` depends on store, mcp, core, gateway and scheduler only (`alexia-api/Cargo.toml:13-17`).
Only `alexia-hub` depends on `alexia-api`. That matches the PHASE DAG, Cargo rules out cycles, and
invariants check 2 passes. `alexia-api` uses core only through `pub` paths (prompt, local, tools,
router, permissions, catalog, hf, …). Its public surface (`lib.rs`: `ApiParts`, `Api`, `serve`,
`token`, `session`, `busy`) is what INTERFACES §2.8 lists. One placement nit: L6.

## BLOCKER

- **B1 (security): the window API's Host check is a prefix match, and the page with the token is
  served before any Host check.**
  - Where: `alexia-api/src/gate.rs:45-48` accepts any Host that *starts with* `127.0.0.1`. That
    includes `127.0.0.1.attacker.example:<port>`. `gate.rs:37` serves `/` (and every text asset)
    with `__TOKEN__` filled in before both the token check and the Host check.
  - Why it matters: a web page using DNS rebinding on a name like `127.0.0.1.attacker.example`
    becomes same-origin with the hub. It can read the token from `/`, then call every `/api/*`
    route with a Host that passes the check, including `/api/chat` (computer control, files).
    The Host check exists to stop exactly this (PHASE.md "Risky", D-P2D-2), and no test covers
    the case: `alexia-api/tests/gate.rs:360` tries only `localhost`, `evil.example` and `[::1]`.
  - Background: v2 has the same bug (`packages/core/src/serve.ts:1862-1875`). But the v3 hub runs
    all the time (logon task) and holds the computer plugin, so the exposure is now always on.
  - Fix, about 5 lines: accept Host only if it is exactly `127.0.0.1` or `127.0.0.1:<bound
    port>`, apply the same check in front of `statics::answer`, and add `127.0.0.1.evil.example`
    to the gate test.
- **B2 (Done-when 3): `pc_actions` never presses Open on a produced file.**
  - Done-when 3 names "Open and Show in folder on a produced file". The test only sends
    `reveal` (`alexia-hub/tests/pc_actions.rs:1162`).
  - Fix: one more `/api/file` call with `{"action":"open","confirm":true}` on the screenshot
    PNG, asserting `{"ok":true}` and a new process. Close that process afterwards.
- **B3 (Done-when 4): "a Telegram message is answered by the same hub while the window is open"
  was never observed** (P2D-e2e.md step 6). This needs the owner, not code: send "p2d ping"
  while `p2d-e2e.ps1` waits at step 6, and record it in P2D-e2e.md.

## LATER

- **L1, duplication in `alexia-api/src`.** These helpers are copied between modules:
  - `safe_name`: `chat.rs:563` and `plugins.rs:850`, identical.
  - `megabytes`: `chat.rs:581` and `plugins.rs:868`, identical.
  - `mime_of`: `offers.rs:204` and `plugins.rs:913`, the same table.
  - `js_string`: `gate.rs:151` and `plugins.rs:214`. These two have **diverged**: gate prints
    `1.0` as `"1.0"`, plugins prints it as `"1"`.
  - The private-sessions list: `board.rs:367` (`pub(crate) is_private`), redone in `chat.rs:537-557`
    and `editor.rs:148`.
  - `persist_enabled`: `library.rs:953` and `plugins.rs:495`.
  - `kv`: `chat.rs:763`, `local_models.rs:665` and `state.rs:91`.
  - `adult_on`: `editor.rs:166` and `state.rs:170`.
  - `lock<T>`: four copies (`chat.rs:77`, `compute.rs:88`, `library.rs:88`, `state.rs:433`).
  - `const CORE = "_core"`: five copies, plus `"_core"` literals in `chat.rs` and `plugins.rs`.

  Move them into `json.rs` or a `kv.rs`.
- **L2, stale `#[allow(dead_code)]` from the P2D-01 scaffold.** The items they cover are used now:
  `gate.rs:31` (`Sent`, used in board and chat), `json.rs:13` (`ok`), `lib.rs:84` (`Api`) and
  `local_models.rs:1700` (`busy`, used at `chat.rs:107`). Remove them so real dead code shows up.
- **L3, lost update on the private-sessions list.** `chat.rs:551` and `editor.rs:148` read, modify
  and write kv `private_sessions` with no lock. If two chats are marked private at the same time,
  one mark can be lost, and that chat then shows on the board and feeds learned skills
  (`learned.rs:419`).
- **L4, the plan-progress check in `pc_actions` can be skipped.** `pc_actions.rs:1093-1103` passes
  when `run_task` did not run and only prints "NOT CHECKED". P2D-12's run did see 4 frames, but
  a later regression would not fail the test.
- **L5, the owner's Windows user name is in git**, in contract fixtures:
  `alexia-hub/tests/contract/local_models.json:283,397` and `plugins.json:73`
  (`C:\Users\<owner>\AppData\Local\Temp\…`). Use a placeholder that is filled in at run time.
- **L6, the local-model catalog sits in the wrong crate.** v2's `LOCAL_CATALOG` JSON
  (`alexia-api/src/local_models.rs:111`) is data about local models and belongs next to
  `alexia-core/src/{local,hf}.rs`, not in the HTTP crate.
- **L7, a new flaky test.** `alexia-mcp/tests/supervise.rs` `call_at_idle_deadline_never_gone` hangs
  under full-workspace load (left a `mcp-fixture.exe` running). It passes alone and is not on the
  known-flake list. It was de-flaked once before (`d323aa3`).
- **L8, a known v2 failure.** `pnpm check` fails on `compute-connect.test.ts` "a paused request
  reader stalls uploads too" on Windows/Node 24.16. It is not caused by P2D.
- **L9, gaps in the end-to-end evidence:**
  - `pnpm app` (NSIS) was never run. Only `tauri build --no-bundle`.
  - The 3/3 `pc_actions` pass after P2D-19 is recorded only as text. The log on disk
    (`%TEMP%\p2d-e2e\5-pc-actions.log`, 03:45) is from the failing run before the fix.
  - Step 7b's "Start again" button was never pressed.
  - The A1 and R21 shape differences were accepted as optional keys. They are not yet
    `optional_keys` in the fixtures.
- **L10, notes from earlier reviews, still open:**
  - A second hub exits 1, not 0 (LOG P2D-12).
  - `replay_plan` has no starting pid (LOG P2D-17).
  - `record-v2 --check` shows a machine-dependent drift in the local-models picks (LOG P2D-16).
