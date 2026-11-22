# P2D: the v2 desktop app on the Rust hub

> Planned 2026-11-23 from the owner's words in `v3/ops/OWNER.md` A-19 ("I want the app back, a
> full fledged app, just built on Rust, look the same but feel snappier, and have the
> features"; "it cannot even do stuff on my computer"), `v3-plan.md` (the authority),
> `v3/specs/INTERFACES.md` and `v3/specs/P2/PHASE.md`. `Alexia.md`, `plan.md`, `packages/core`,
> `packages/ui` and `src-tauri` are read only as facts about v2. The checklist is
> [`INVENTORY.md`](./INVENTORY.md). Comes between P2 (done, P2-41 waived) and P3.

## Goal

The Alexia desktop app opens on the owner's Windows 11 PC with the same screens and look as v2,
and everything behind them is answered by `alexia-hub`. `packages/ui` is served unchanged by the
hub over a loopback port, the same way v2 core serves it; every `/api/*` call in INVENTORY.md
gets v2's request and response shapes; the Tauri shell starts (or attaches to) the one hub
instead of the Node core, so the window and Telegram share one brain and one Telegram poller.
Alexia acts on the PC at least as well as v2: the computer, claude-code and documents plugins
run in the owner's desktop session, the window can switch them on, trust them and choose
folders, files can be opened and shown in Explorer, approvals for window runs appear in the
window, and the plan pill gets its checklist.

Feature IDs: **SP-01** (Rust core, the app's half), **CO-02** (status at a glance, pulled in;
v2 has it). PC-01..PC-20 stay V3-4: P2D brings back v2's PC abilities, it adds none.

## Done when

1. **The app opens on Windows and starts only the hub.** `pnpm app` builds on this PC;
   `src-tauri\target\release\alexia.exe` opens the window, the process tree under it has
   `alexia-hub.exe` and plugin processes and **no** process running `boot.mjs` or
   `packages/core` (P2D-15 checks with `Get-CimInstance Win32_Process`). With a hub already
   running (Task Scheduler or console), the app attaches to it and starts no second one.
2. **Every INVENTORY row answers with the v2 shape.** `cargo test -p alexia-hub --test contract`
   replays every recorded v2 call (P2D-02) against the real `alexia-hub run` binary and passes,
   and `node v3/ci/invariants.mjs` check 12 (P2D-14) fails if any INVENTORY row has no contract
   case or a case is still `"hub": "pending"`.
3. **The PC actions, scripted.** `cargo test -p alexia-hub --features pc-actions --test
   pc_actions` (P2D-12), run in the owner's desktop session on this PC, drives the agent through
   `/api/chat` with a scripted model and shows it: listing windows, opening Notepad, typing into
   it, reading it back, a screenshot file, `document.extract` on a file in a chosen folder, Open
   and Show in folder on a produced file, Allow/Deny in the window, and the `stages`/`plan`
   progress frames.
4. **On the real app** (P2D-15): the app built from this branch, on this PC, passes a scripted
   walk through every screen and the PC check above, a Telegram message is answered by the same
   hub while the window is open, and `v3/ops/reports/P2D-e2e.md` records it.
5. `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` and
   `cargo test --workspace` pass in `v3/`; `pnpm check` passes at the repo root.

## Decisions (planner; the owner may overrule)

- **D-P2D-1: one new crate, `alexia-api`** (lib), between `{core, gateway, scheduler}` and
  `alexia-hub`. It holds the HTTP server, the gate, the static shell and one module per screen.
  Separate files per screen let four workers run at once without sharing a file.
- **D-P2D-2: the hub opens one port, on `127.0.0.1` only**, for the window. This overrules
  INTERFACES §1.1's "the hub opens no port" (written for V3-1, when there was no window). Same
  protection as v2: a token minted per run, injected into the page, required on every `/api/*`
  call, and the `Host` check. The token is never written to a file or a log. The port is in
  `%LOCALAPPDATA%\AlexiaHub\window.json` (`{"port":u16,"pid":u32}`), which is not a secret.
- **D-P2D-3: one hub per PC.** `alexia-hub run` takes an exclusive lock on
  `%LOCALAPPDATA%\AlexiaHub\hub.lock`; a second one exits with a sentence. The app reads
  `window.json`, attaches if that hub answers, and otherwise starts `alexia-hub run` itself.
  Closing the window does not stop the hub (Telegram keeps working); the tray's Quit stops the
  hub only if the app started it.
- **D-P2D-4: no `tauri.conf.json` change.** The hub binary and the UI ship under
  `src-tauri/resources/` (already bundled by `"resources": ["resources/**/*"]`), copied there by
  `scripts/sidecar.mjs`. The `alexia-core` sidecar binary stays: it is the Node runtime, now used
  only to run plugins (`ALEXIA_NODE`). `alexia-connect` stays bundled and unused by P2D.
- **D-P2D-5: the app uses the hub's data**, `%LOCALAPPDATA%\AlexiaHub` (already imported from
  v2, P0/P1). v2's `%LOCALAPPDATA%\Alexia` is not touched. Secrets come from the hub's own
  Credential Manager entries; the shell's vault (`vault.rs`) is not started for the hub.
- **D-P2D-6: v3 never pays (D212).** Routes about paid models answer in v2's shapes with
  `spent: 0`, `cap: 0`, `cross: false`; `set_spend`/`set_cross`/a positive `daily` answer v2's
  refusal shape `{ok:false, said}` with "Alexia v3 only uses free models." No `paid`/`paused`
  frame is ever sent.
- **D-P2D-7: pairing other computers waits for the mesh (V3-4).** The compute routes answer in
  v2's shapes as a hub with no paired computers whose role is `interaction`; `POST role` to
  `compute`, `pair/start` and `discover` answer `{ok:false, said:"Pairing another computer comes
  with the mesh in a later version."}` (status 409). The local job queue, pause and setup work
  on this PC. **No UI change**: the screen already shows a refusal's `said`.
- **D-P2D-8: the window is its own origin.** `Origin::Window` (new, P2D-03): slash commands are
  allowed from it (it is the owner at the keyboard, like their Telegram chat, P2-73), its
  approvals go to the window's Allow/Deny and fall back to the primary chat only when no window
  is attached.
- **UI changes: none.** If a worker finds one unavoidable, it stops and asks; the spec that
  allows it must name the file and the reason.

## Crates and files this phase creates or changes

| Where | P2D content |
|---|---|
| `v3/Cargo.toml`, `v3/Cargo.lock` | `axum` 0.8, `tokio-stream` 0.1 (P2D-01 only) |
| `v3/specs/INTERFACES.md` | §1.1 table and DAG with `alexia-api`, the port rule; §1.2 deps; §2.3 `Origin::Window`, `ToolProgress`, `DraftFrame::{Step, Note, Ask}`, `McpTooling::research`; §2.4 `WindowQuestions`; §2.6 step 12, `hub.lock`, `window.json`; new §2.8 `alexia-api` (P2D-01 only) |
| `alexia-api` (new) | `lib.rs`, `gate.rs`, `statics.rs`, `json.rs` (P2D-01); `state.rs` (P2D-04); `chat.rs`, `offers.rs` (P2D-05); `plugins.rs` (P2D-06); `board.rs`, `learned.rs` (P2D-07); `library.rs` (P2D-08); `local_models.rs` (P2D-09); `compute.rs` (P2D-10); `editor.rs`, `research.rs` (P2D-11); a test file per module |
| `alexia-core` | `Origin::Window`; structured tool progress, step/note/ask draft frames, research snapshots (P2D-03); `hf.rs`/`local.rs` cancel, maintenance, benchmark (P2D-09) |
| `alexia-gateway` | `WindowQuestions`; the asker asks the window for `Origin::Window` (P2D-03); gateway ignores the new frames |
| `alexia-scheduler` | `Origin::Window`'s session in `session_of` (P2D-03) |
| `alexia-mcp` | added MCP servers and folder installs in `host.rs` (P2D-06) |
| `alexia-hub` | `Cargo.toml` (+`alexia-api`), `main.rs` step 12, lock, `window.json` (P2D-01); asker gets the window (P2D-05); `watchdog.rs` logon task in the owner's session (P2D-12); `tests/contract.rs`, `tests/contract/*.json`, `tests/common/mod.rs` helpers, `tools/record-v2.mjs` (P2D-02); `tests/pc_actions.rs` (P2D-12) |
| `v3/ci/invariants.mjs` | `alexia-api` in the dependency table, check 11 skips the crate that serves `/api/chat` (P2D-01); check 12, INVENTORY coverage; check 13, the API binds loopback only (P2D-14) |
| v2 | `src-tauri/src/main.rs` (start/attach the hub, P2D-13), `scripts/sidecar.mjs` (copy the hub and UI into resources, P2D-13). **Nothing else.** `packages/ui`, `packages/core`, `plugins/`, `tauri*.json`, `.github/workflows/` untouched |
| reports | `v3/ops/reports/P2D-e2e.md` (P2D-15) |

### `src-tauri/tauri.conf.json`

**Not changed.** Bundling the hub needs no key: `bundle.resources` is `["resources/**/*"]`, so
`resources/hub/alexia-hub.exe` and `resources/ui/**` are bundled as they are. `externalBin`
keeps `binaries/alexia-core` (Node, for plugins) and `binaries/alexia-connect`.
`tauri.dev.conf.json`, `scripts/dev-app.mjs`, `ALEXIA_DEV_NAME` and `ALEXIA_KEYCHAIN` are not
referenced by any P2D task.

## Windows: what the app needs on this PC

- **WebView2**: part of Windows 11; nothing to install. The window loads
  `http://127.0.0.1:<port>/` as a remote origin; `capabilities/default.json` already allows
  `http://127.0.0.1:*`.
- **Loopback only**: binding `127.0.0.1` raises no Windows Firewall prompt (binding `0.0.0.0`
  would). Check 13 (P2D-14) keeps it that way.
- **Node** for plugins: the bundled `alexia-core` sidecar (`ALEXIA_NODE`), or `node` on PATH when
  the hub runs from a console.
- **The desktop session**: the hub must run in the owner's interactive session for the computer
  plugin (G1). Started by the app, it is. Started by Task Scheduler, only with P2D-12's logon
  task.
- **Credential Manager**: the hub's secrets (service `alexia`) are already there (P1-34).
- **Build tools**: Rust stable ≥ 1.87 with MSVC, Node 22 + pnpm, the Tauri CLI from
  `node_modules`. `pnpm app` runs `scripts/sidecar.mjs`, then `tauri build` (NSIS). P2D-15 runs
  the unbundled `src-tauri\target\release\alexia.exe`; it does not install over v2.
- **Only one hub**: the console hub (`Desktop\Alexia.cmd`) or the Task Scheduler hub is attached
  to, not duplicated (D-P2D-3).
- **macOS-only commands** (`glass`, `haptic`, `sheet_snapshot`'s native path) are already no-ops
  off macOS in `src-tauri`.

## Order of work

```
P2D-01 api skeleton, gate, statics, hub step 12, INTERFACES ─┬─ P2D-02 contract: record v2, replay harness ─┐
P2D-03 core seam: Window origin, progress, frames, asker ────┤                                              │
                                                             └─ P2D-13 Tauri shell on the hub               │
 after P2D-02 (and P2D-03 where marked), at most 4 at once:                                                 │
   P2D-04 state/settings   P2D-05 chat (+03)   P2D-06 plugins   P2D-07 board                               │
   P2D-08 library (+06)    P2D-09 local models P2D-10 compute   P2D-11 editor+research (+03)               │
 P2D-04 + P2D-05 + P2D-06 ── P2D-12 PC actions proven, hub in the owner's session                          │
 P2D-04..P2D-13 ── P2D-14 coverage + loopback checks                                                       │
 everything ── P2D-15 end to end on the real app on this PC ───────────────────────────────────────────────┘
```

Shared files and the order they force: `INTERFACES.md`, `v3/Cargo.toml`, `Cargo.lock`,
`alexia-api/src/lib.rs` and `alexia-hub/Cargo.toml` are P2D-01's only (it writes every interface
other tasks implement, including P2D-03's). `alexia-hub/src/main.rs`: P2D-01 → P2D-05 (one line,
the asker's window). `alexia-hub/tests/common/mod.rs`: P2D-02 → P2D-12. `alexia-core/src/local.rs`,
`hf.rs`: P2D-09 only. `alexia-mcp/src/host.rs`: P2D-06 → P2D-08. `v3/ci/invariants.mjs`: P2D-01 →
P2D-14. `alexia-hub/Cargo.toml`: P2D-01 → P2D-12. `tests/contract/gate.json`: P2D-02 → P2D-14. Each area task owns its module,
its `tests/<area>.rs` and its `tests/contract/<area>.json`, and nothing else in `alexia-api`.

Can run together: P2D-01 ∥ P2D-03. Then P2D-02 ∥ P2D-13. Then the eight area tasks, four at a
time (suggested: 05, 04, 06, 09 first; then 07, 10, 11, 08). The machine has 16 GB: never more
than 4 workers compiling.

## Tasks

Crate paths are under `v3/crates/`.

| ID | Title | Model | Depends on | Touches |
|---|---|---|---|---|
| P2D-01 | alexia-api: server, gate, static shell, hub wiring, INTERFACES | opus | P2-39 | `v3/Cargo.toml`, `v3/Cargo.lock`, `v3/specs/INTERFACES.md`, `alexia-api/**` (new: `Cargo.toml`, `src/{lib,gate,statics,json}.rs`, stub `src/{state,chat,offers,plugins,board,learned,library,local_models,compute,editor,research}.rs`, `tests/gate.rs`), `alexia-hub/{Cargo.toml, src/main.rs, tests/window.rs}`, `v3/ci/invariants.mjs` (graph table, check 11 scope) |
| P2D-02 | Contract: record v2's answers, replay them against the hub | sonnet | P2D-01 | `alexia-hub/{tools/record-v2.mjs, tests/contract.rs, tests/contract/*.json, tests/common/mod.rs}` |
| P2D-03 | Core seam: the window's origin, structured progress, step frames, the window asker | opus | none | `alexia-core/{src/lib.rs, src/brain.rs, src/run.rs, src/tools.rs, src/agent.rs, src/commands.rs, src/undo.rs, src/upcalls.rs, src/resume.rs, tests/window_seam.rs, tests/helpers.rs, tests/prompt.rs, tests/tools.rs, tests/undo.rs}`, `alexia-gateway/{src/lib.rs, src/ask.rs, src/gateway.rs, tests/window_ask.rs}`, `alexia-mcp/tests/compute.rs`, `alexia-scheduler/{src/lib.rs, tests/scheduler.rs}` (Window origin's session, ToolCtx literals) |
| P2D-04 | State, setup and settings | opus | P2D-02 | `alexia-api/{src/state.rs, tests/state.rs}`, `alexia-hub/tests/contract/state.json` |
| P2D-05 | Chat in the window: stream, stop, approve, commands, files | opus | P2D-02, P2D-03 | `alexia-api/{src/chat.rs, src/offers.rs, tests/chat.rs}`, `alexia-hub/{src/main.rs (asker line), tests/contract/chat.json}` |
| P2D-06 | Plugins screen: panes, settings, trust, install, servers | opus | P2D-02 | `alexia-api/{src/plugins.rs, tests/plugins.rs}`, `alexia-mcp/{src/host.rs, tests/servers.rs}`, `alexia-hub/tests/contract/plugins.json` |
| P2D-07 | Board: core tables and actions, plugin tables, learned skills | opus | P2D-02 | `alexia-api/{src/board.rs, src/learned.rs, tests/board.rs}`, `alexia-hub/tests/contract/board.json` |
| P2D-08 | Library: plugins and skills from the shelf | opus | P2D-02, P2D-06 | `alexia-api/{src/library.rs, tests/library.rs}`, `alexia-hub/tests/contract/library.json` |
| P2D-09 | Local models and local stats | opus | P2D-02 | `alexia-api/{src/local_models.rs, tests/local_models.rs}`, `alexia-core/{src/hf.rs, src/local.rs, tests/hf_p2d.rs}`, `alexia-hub/tests/contract/local_models.json` |
| P2D-10 | Compute screen on a hub with no paired computers | opus | P2D-02 | `alexia-api/{src/compute.rs, tests/compute.rs}`, `alexia-hub/tests/contract/compute.json` |
| P2D-11 | Image editor and research viewer | opus | P2D-02, P2D-03 | `alexia-api/{src/editor.rs, src/research.rs, tests/editor.rs, tests/research.rs}`, `alexia-hub/tests/contract/editor.json` |
| P2D-12 | PC actions proven; the hub runs in the owner's session | opus | P2D-04, P2D-05, P2D-06 | `alexia-hub/{Cargo.toml ([features] pc-actions), src/watchdog.rs (and its in-file tests), tests/pc_actions.rs}` |
| P2D-13 | The Tauri shell starts or attaches to the hub | opus | P2D-01 | `src-tauri/src/main.rs`, `scripts/sidecar.mjs` |
| P2D-14 | Coverage and loopback checks | sonnet | P2D-04..P2D-13 | `v3/ci/invariants.mjs`, `alexia-hub/tests/contract/gate.json` (T4 only) |
| P2D-15 | End to end on the real app on this PC | sonnet | P2D-01..P2D-14 | `v3/ops/reports/P2D-e2e.md`, `v3/ops/reports/p2d-e2e.ps1` |

15 tasks.

## Owner needs

Asked now so nothing waits.

- **Which hub starts at sign-in.** After P2D the app starts the hub. Keep `alexia-hub install`
  (P2D-12 makes it a logon task in your session, which means no hub before you sign in), or rely
  on the app's own "start at sign-in" (Settings), or both (the app then attaches). Default in
  P2D: both allowed, the app attaches.
- **Installing over v2.** `pnpm app` makes an NSIS installer with the same identifier as the v2
  app installed on this PC (`%LOCALAPPDATA%\Alexia`). Installing it replaces v2's app (v2's data
  stays). And an installed build keeps v2's updater, which would replace it with the next v2
  release. P2D-15 runs the unbundled exe and installs nothing; installing is your call.
- **The Mac's v2 paired to this PC for compute.** If the Mac's v2 app uses this PC as a compute
  host, that pairing is v2-core-to-v2-core and stops when v2 on this PC is no longer running.
  P2D does not port pairing (D-P2D-7); the Mac becomes a limb at V3-4.
- **Turn on what she may do.** In the app: Plugins › Computer control › *Allow her to press
  things*, *Trust* for the plugins you want her to use without asking each step, Settings ›
  Permissions › folders. P2D gives the controls; it does not switch them on for you.
- **Paid features are gone** (D-P2D-6): the spending controls stay on screen and say so.

## INTERFACES.md additions this phase makes

All written by P2D-01, in one commit, before anyone implements them.

1. §1.1: `alexia-api` row (lib; may depend on store, mcp, core, gateway, scheduler); DAG
   `store ← mcp ← core ← {gateway, scheduler} ← api ← hub`; the latency sentence amended: the
   hub opens exactly one port, `127.0.0.1` only, for the window (D-P2D-2).
2. §1.2: `axum = { version = "0.8", default-features = false, features = ["http1", "tokio",
   "json", "query"] }` and `tokio-stream = "0.1"` in the workspace table, with why.
3. §2.3: `Origin::Window`; `ToolProgress`; `ToolCtx.progress: Option<mpsc::Sender<ToolProgress>>`;
   `DraftFrame::{Step(StepFrame), Note(String), Ask(String)}`; `StepFrame`; `McpTooling::research`.
4. §2.4: `WindowQuestions`, `Asker::with_window(channels, store, bus, window) -> Arc<Asker>`, `Asker::window() -> Option<WindowQuestions>` (`Asker::new` unchanged: no window).
5. §2.6: step 12 (the window API), `hub.lock`, `window.json`, `ALEXIA_WINDOW_PORT`,
   `ALEXIA_UI_DIR`.
6. New §2.8 `alexia-api`: `ApiParts`, `Api`, `Api::serve`, the area state structs and the
   cross-area functions (P2D-01 spec, *Interfaces*).

## Risky or unclear

- **Shapes come from v2 itself.** The contract fixtures are recorded from v2 core (P2D-02) where
  v2 can run headless with a scratch data folder; calls that need a model or a plugin v2 cannot
  reach in a scratch folder are written from the serve.ts lines and marked `"source": "hand"`.
  Comparison is by shape (keys, types, status), not values.
- **The biggest ports are chat (P2D-05) and the board (P2D-07).** Both are opus and touch only
  their own files; if either does not fit one worker, the CEO splits it by route, not by layer.
- **The page reads the token from the served HTML**, as v2's did: any local process that can
  GET `http://127.0.0.1:<port>/` can read it. Parity with v2, not new exposure; the `Host` check
  still stops web pages.
