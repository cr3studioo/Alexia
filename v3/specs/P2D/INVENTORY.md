# P2D inventory: every call the app makes to the v2 core

> Written 2026-11-23 by the P2D planner from `packages/core/src/serve.ts` (the router, lines
> 1849–3300, and `reply` at 3577), `packages/core/src/compute/api.ts` (lines 434–690),
> `packages/core/src/guard.ts` (the `ROUTES` table, which lists every route serve.ts answers and
> is kept complete by `guard.test.ts`), `packages/ui/src/*.ts` (every `/api/` string and every
> Tauri `invoke`/event) and `src-tauri/src/main.rs`. **This table is what P2D is checked
> against.** A row is done when its contract case in `v3/crates/alexia-hub/tests/contract/` is
> `"hub": "answers"` and `cargo test -p alexia-hub --test contract` passes (P2D-02, P2D-14).

## How v2 answers, for every row

- One loopback HTTP server on `127.0.0.1:<port>`; the Tauri shell picks the port and points the
  windows at `http://127.0.0.1:<port>/`.
- Static files (row S1) need no token. Every `/api/*` call needs header `x-alexia-token` equal
  to the token minted at start and substituted for `__TOKEN__` in the served text assets, and a
  `Host` header starting `127.0.0.1`. Otherwise `403 text/plain "not for you"`.
- A non-GET body that is not JSON: `400 {"ok":false,"said":"That request body is not JSON."}`.
- Before any route runs, `guard.ts` `refuse(path, method, body)` may answer
  `{status, {"ok":false,"said":..., "confirm"?:true}}`; a route with no classification is refused.
- No route matched: `404` with an empty body. Compute's own fallthrough: `404
  {"ok":false,"said":"That compute endpoint or method is not available."}`.
- Every JSON answer is `content-type: application/json`. Only `/api/chat` streams: `200
  text/event-stream`, frames `data: <json>\n\n` (row C1).

"v3 today" says what in `v3/crates` already has the logic. **No row is answered over HTTP
today: the hub opens no port** (INTERFACES §1.1). "logic" means a Rust function exists that the
route can call; "missing" means the behaviour itself must be ported.

## Calls

### Static shell and the gate (P2D-01)

| # | Call | Method | UI uses it for | v3 today | Task |
|---|---|---|---|---|---|
| S1 | `/`, `/compute.html`, `/app.css`, `/main.js`, `/<name>.js` (`^[a-z][a-z0-9-]*$`), `/alexia.png`, `/alexia-mark.svg`, `/alexia-panel.svg`, `/alexia-band.svg`, `/theme-light.webp`, `/theme-dark.webp` | GET | the page itself; `__TOKEN__` replaced in `text/*` assets only (serve.ts 272–298, 1859–1872) | missing | P2D-01 |
| S2 | any `/api/*` without the token or Host | any | refusal `403 not for you` | missing | P2D-01 |
| S3 | any `/api/*` with a bad JSON body, or refused by the guard | non-GET | `400` / guard refusal with `confirm` (guard.ts 440–481) | missing | P2D-01 |
| S4 | an unknown `/api/*` path | any | `404`, empty body | missing | P2D-01 |

### State, setup and the settings screen (P2D-04)

| # | Call | Method | UI uses it for | v3 today | Task |
|---|---|---|---|---|---|
| A1 | `/api/state` | GET | everything the window draws on load and after each change: setup, mode transition, compute, editor, adult, layout, channels, app version, commands, pins, messages of the open chat, spent/cap/warning/today, personality chip, ceilings, permissions, providers with `connected`/`keyStored` (serve.ts 1915–2041) | logic: store `history`, `kv_get`, `free::ladder`, `secrets`, `commands`, `permissions` scope; missing: layout, setup, pins, personality chip | P2D-04 |
| A2 | `/api/setup` | POST | first run and Settings: name, mode, theme, glass, glassLook, updates, layout, provider key add/remove (serve.ts 2215–2360) | logic: `secrets` set/clear for `provider_<id>`; missing: the rest | P2D-04 |
| A3 | `/api/permissions` | POST | Settings › Permissions: mode, roots, everywhere, lift boundaries; answers `{mode, roots, everywhere, boundaries}` | logic: `permissions` (`_core.scope`) | P2D-04 |
| A4 | `/api/ceilings` | POST | Settings › Limits: steps, askAbove, daily | logic: `Limits.max_steps`; missing: ceilings kv (v3 never pays: daily stays 0, D212) | P2D-04 |
| A5 | `/api/adult` | POST | Settings › Safety: 18+ confirm on/off | missing | P2D-04 |
| A6 | `/api/panels` | GET | the board's core tabs (`{tabs}`, panels.ts) | missing | P2D-04 |
| A7 | `/api/search?q=` | GET | the command palette (`{hits}`, palette.ts + surface.ts `searchable`) | missing | P2D-04 |

### Chat (P2D-05)

| # | Call | Method | UI uses it for | v3 today | Task |
|---|---|---|---|---|---|
| C1 | `/api/chat` | POST → SSE | sending a message; frames `delta`, `restart`, `phase`, `note`, `ask`, `switch`, `paid`, `paused`, `step` (start, progress with `stages`/`plan`/`controls`/`preview`/`research`, outcome with `files`), `learned`, `learn`, `error`, `done`; `423 {ok:false,busy:true,said}` while busy (serve.ts 3281–3297, 3577–3975) | logic: `Lanes`/`Agent` brain (`DraftFrame::{Delta,Restart,Phase}`); missing: step/note/ask/progress-detail frames (P2D-03), the window as an asker | P2D-05 |
| C2 | `/api/stop` | POST | Stop button; tray "Stop" (`stop-task` event); `{stopping}` | logic: run cancel token | P2D-05 |
| C3 | `/api/approve` | POST | Allow/Deny on an `ask` frame; `{ok}` | logic: `Asker`, approvals; missing: window target (P2D-03) | P2D-05 |
| C4 | `/api/command` | POST | slash commands typed in the window, `{input, approved}` (serve.ts 2396–2445) | logic: `commands::run` (window is `Origin::Desktop`, P2-73 refuses it: changed by P2D-05) | P2D-05 |
| C5 | `/api/not-her` | POST | "That wasn't her" (capability `persona.not_her`) | logic: capability call via `McpHost` | P2D-05 |
| C6 | `/api/file?id=` | GET | download a file a tool made | logic: `Produced` files; missing: offer ids | P2D-05 |
| C7 | `/api/file` `{id, action: open\|reveal}` | POST | Open / Show in folder (`explorer.exe`, offered.ts 136) | missing (**PC action**) | P2D-05 |

### Plugins screen (P2D-06)

| # | Call | Method | UI uses it for | v3 today | Task |
|---|---|---|---|---|---|
| P1 | `/api/plugins` | GET | Plugins/Settings panes: `{panes, problems, skills, unreviewed, offers, skillProblems}` (serve.ts 2534–2547) | logic: `McpHost::status/manifests`, `Skills`, `_core.unreviewed`; missing: panes (setting values, status widgets) | P2D-06 |
| P2 | `/api/plugin` `{id, action: enable\|disable\|delete\|restart}` | POST | plugin toggles | logic: `McpHost::set_enabled`, purge, reload | P2D-06 |
| P3 | `/api/install` `{path}` | POST | install a plugin folder | missing | P2D-06 |
| P4 | `/api/server` `{id,name,run,args,action}` | POST | add an MCP server; `trust` marks reviewed | logic: `McpHost::set_reviewed`; missing: added servers | P2D-06 |
| P5 | `/api/settings` `{plugin,key,value}` | POST | change a plugin setting (e.g. computer `allow_input`) | logic: store `set_setting`, `secrets` for `password`, `alexia/settings/changed` | P2D-06 |
| P6 | `/api/upload` `{plugin,key,name,data}` | POST | a `file` setting's upload | missing | P2D-06 |
| P7 | `/api/plugin-file?plugin=&path=` | GET | a file inside a plugin's own dir (pictures in panels) | logic: `Layout::plugin_dir` | P2D-06 |

### Board tables and actions (P2D-07)

| # | Call | Method | UI uses it for | v3 today | Task |
|---|---|---|---|---|---|
| B1 | `/api/rows` `{plugin,key}` | POST | a table's rows. Core (`plugin:""`): `chats`, `models`, `routing`, `activity`, `last_run`, `skills`, `learned`, `tools`, `library`; plugins: a tool named by the widget's `rows` | logic: store `sessions`/`runs`/`audit`, `Catalog`, `McpTooling::list`, `Skills`; missing: learned, library rows, row shapes | P2D-07 |
| B2 | `/api/detail` `{plugin,key,row}` | POST | a row's detail | as B1 | P2D-07 |
| B3 | `/api/action` `{plugin,key,row,approved}` | POST | buttons. Core: `new_chat`, `open_chat`, `forget_chat`, `use_model`, `set_spend`, `set_order`, `set_cross`, `set_keyless`, `set_speed`, `automatic`, `export_run`, `open_run_chat`, `allow_skill`, `forget_skill`, `allow_here`, `forget_here` (surface.ts 1230–1297); plugins: their `action`/`rowActions` tools through the permission gate | logic: store, `Router` pins (`models use`), `Agent` gate; missing: the rest | P2D-07 |
| B4 | `/api/learn` `{action: forget\|edit\|save..., name, text}` | POST | "Learn this" offer after a task, learned-skill edits (learned.ts) | missing | P2D-07 |

### Library (P2D-08)

| # | Call | Method | UI uses it for | v3 today | Task |
|---|---|---|---|---|---|
| L1 | `/api/library` | GET | the plugin and skill marketplace: available, offered skills, revoked, updates (library.ts) | missing | P2D-08 |
| L2 | `/api/library/progress?id=` | GET | download progress `{done,total}` | missing | P2D-08 |
| L3 | `/api/library/install` `{id,kind,update,enable}` | POST | install/update a plugin or skill | missing | P2D-08 |

### Local models (P2D-09)

| # | Call | Method | UI uses it for | v3 today | Task |
|---|---|---|---|---|---|
| M1 | `/api/local-models` | GET | overview: machine facts, recommendations, installed | logic: `gpu::fit`, `hf::installed` | P2D-09 |
| M2 | `/api/local-models/search?q=&format=` | GET | Hugging Face search | logic: `hf` | P2D-09 |
| M3 | `/api/local-models/repo?repo=&format=` | GET | repo preview (files, sizes, licence) | logic: `hf` | P2D-09 |
| M4 | `/api/local-models/context` | GET | context size, cache precision, draft | logic: `local` runtime settings | P2D-09 |
| M5 | `/api/local-models/context` | POST | set them | logic: `local` | P2D-09 |
| M6 | `/api/local-models/maintenance` | GET | update/cleanup suggestions | missing | P2D-09 |
| M7 | `/api/local-models/import-preview?path=` | GET | GGUF header of a local file | logic: `hf` GGUF reading | P2D-09 |
| M8 | `/api/local-models/progress` | GET | running install job | logic: `hf` import progress | P2D-09 |
| M9 | `/api/local-models/install` | POST | install `{entry,quant}` or `{repo,quant,format}` | logic: `hf::import` | P2D-09 |
| M10 | `/api/local-models/cancel` `{job}` | POST | cancel install | missing (cancel token) | P2D-09 |
| M11 | `/api/local-models/import` | POST | import a local GGUF (copy or reference) | logic: `hf` import-file | P2D-09 |
| M12 | `/api/local-models/benchmark` `{id}` | POST | short local speed test | logic: `local::Runtime` | P2D-09 |
| M13 | `/api/local-models/use` `{id,mode}` | POST | choose a local model / run mode | logic: `models use local:<id>` | P2D-09 |
| M14 | `/api/local-models/remove` `{id}` | POST | remove weights | logic: `hf` | P2D-09 |
| M15 | `/api/local-models/<id>` | DELETE | same as M14 | as M14 | P2D-09 |
| M16 | `/api/local-models/token` | POST | Hugging Face token into the keychain | logic: `secrets` `hf_token` | P2D-09 |
| M17 | `/api/local-stats` | GET | Local stats page: runners, installed, loaded, speed, system stats | logic: `gpu`, `local::Runtime` | P2D-09 |

### Compute (P2D-10)

All in `compute/api.ts` 491–690. The UI calls them from Settings › Compute and `compute.html`.

| # | Call | Method | UI uses it for | v3 today | Task |
|---|---|---|---|---|---|
| R1 | `/api/compute/role` | GET | this computer's role | missing | P2D-10 |
| R2 | `/api/compute/role` | POST | switch role (guard: confirm) | missing | P2D-10 |
| R3 | `/api/compute/role/cancel` | POST | stop a waiting switch | missing | P2D-10 |
| R4 | `/api/compute/hosts` | GET | paired computers | missing | P2D-10 |
| R5 | `/api/compute/tailscale` | GET | Tailscale state | missing | P2D-10 |
| R6 | `/api/compute/tailscale` | POST | use Tailscale or not | missing | P2D-10 |
| R7 | `/api/compute/discover` | GET | find a computer waiting to pair | missing | P2D-10 |
| R8 | `/api/compute/pair/start` | POST | open a pairing code | missing | P2D-10 |
| R9 | `/api/compute/pair` | GET | pairing state and code | missing | P2D-10 |
| R10 | `/api/compute/pair/cancel` | POST | cancel pairing | missing | P2D-10 |
| R11 | `/api/compute/unpair` | POST | forget a computer (guard: confirm) | missing | P2D-10 |
| R12 | `/api/compute/inventory` | GET | a computer's hardware/models/capabilities | logic: `gpu` facts for this PC | P2D-10 |
| R13 | `/api/compute/status` | GET | how a computer is reached | missing | P2D-10 |
| R14 | `/api/compute/select` | POST | whose models the picker shows | missing | P2D-10 |
| R15 | `/api/compute/setup/install` | POST | install a missing requirement | logic: `local` llama.cpp runtime download | P2D-10 |
| R16 | `/api/compute/queue` | GET | running + waiting jobs | logic: `LocalJobs` | P2D-10 |
| R17 | `/api/compute/job?id=` | GET | one job | logic: `LocalJobs` | P2D-10 |
| R18 | `/api/compute/jobs` | GET | jobs heard about | logic: `LocalJobs` | P2D-10 |
| R19 | `/api/compute/jobs/cancel` | POST | cancel a job | logic: `LocalJobs` | P2D-10 |
| R20 | `/api/compute/pause` | POST | pause a compute host | logic: `LocalJobs::set_paused` | P2D-10 |
| R21 | `/api/compute/services` | GET | relay/mailbox addresses | missing | P2D-10 |
| R22 | `/api/compute/services` | POST | set them | missing | P2D-10 |
| R23 | `/api/compute/window/close` | POST | compute host window to tray | missing | P2D-10 |

### Image editor and research (P2D-11)

| # | Call | Method | UI uses it for | v3 today | Task |
|---|---|---|---|---|---|
| E1 | `/api/editor` | POST | every editor call, forwarded to the `image.edit` capability's tool with the conversation checked (serve.ts 2101–2128) | logic: capability call via `McpHost`, `alexia/editor` layer | P2D-11 |
| E2 | `/api/editor/file?token=` | GET | a file the editor shared | missing (share tokens) | P2D-11 |
| E3 | `/api/editor/picture?...` | GET | a picture the conversation owns | logic: attachments | P2D-11 |
| E4 | `/api/editor/forget` | POST | forget editor pictures | missing | P2D-11 |
| E5 | `/api/editor/upload` | POST | upload a picture into the editor | logic: attachments register | P2D-11 |
| E6 | `/api/research` `{plugin}` | POST | the research viewer's latest snapshot `{snapshot}` | missing (`alexia/research` progress meta is dropped by `McpTooling`, P2D-03) | P2D-11 |
| E7 | `/api/research-file?plugin=&run=&source=&kind=` | GET | a research preview or report file | missing | P2D-11 |

### Tauri: commands and events the UI uses

Answered by `src-tauri` itself, not by core. They stay as they are; listed so nothing is lost.

| # | Call | Kind | UI uses it for | Reaches core? | Task |
|---|---|---|---|---|---|
| T1 | `tray_state`, `hide_overlay`, `control_overlay`, `relaunch`, `system_temps`, `sheet_snapshot`, `glass`, `haptic` | command | tray, overlay, the edge-of-screen pill while she uses the computer, temperatures, genie snapshot; `glass`/`haptic` are macOS-only no-ops on Windows | no | unchanged |
| T2 | `plugin:autostart\|is_enabled/enable/disable`, `plugin:updater\|check`, `plugin:updater\|download_and_install` | plugin command | start at sign-in, updates | no (but see PHASE.md *Updater*) | unchanged |
| T3 | event `plan` (main → control window) | event | the plan checklist under the pill; fed by C1 `step.progress.plan`/`stages` | indirectly: needs C1's progress frames | P2D-05 |
| T4 | event `start-core-again` (placeholder page → shell) | event | "Start again" when core is not answering | **yes: restarts core** → restarts or re-attaches the hub | P2D-13 |
| T5 | event `stop-task` (shell → main) | event | tray Stop → the page posts C2 | via C2 | P2D-05 |

## Counts

| | Rows |
|---|---|
| UI-to-core calls (S1–S4, A1–A7, C1–C7, P1–P7, B1–B4, L1–L3, M1–M17, R1–R23, E1–E7, T4) | **80** |
| Answered by the v3 hub today | **0** (no HTTP server) |
| Some logic already in v3, the route missing ("logic" above, often partial) | 43 (A1–A4, C1–C6, P1, P2, P4, P5, P7, B1–B3, M1–M5, M7–M9, M11–M17, R12, R15–R20, E1, E3, E5) |
| Logic missing (must be ported) | 37 (S1–S4, A5–A7, C7, P3, P6, B4, L1–L3, M6, M10, R1–R11, R13, R14, R21–R23, E2, E4, E6, E7, T4) |
| Shell-local, unchanged (T1–T3, T5) | 4 groups, 15 commands/events |

## The PC-action gap

What v2 can do on this Windows PC, and what stops the hub doing the same today.

### What v2 does on the PC

1. **The `computer` plugin** (28 tools; Windows engine `plugins/computer/windows.js`, PowerShell
   and UI Automation): `windows`, `focus`, `elements`, `read`, `check`, `press`, `click`, `move`,
   `scroll`, `type`, `key`, `open_app`, `open_url`, a screenshot after each action, `run_task`
   (plans a whole goal then carries it out), saved plans (`save_plan`, `plans`, `replay_plan`,
   `forget_plan`, `rerun_last`, `save_last`), `pause_task`/`resume_task`, Laya grounding
   (`laya`, `laya_export`). `run_script`/`run_shortcut` are macOS-only in v2 too. Input only when
   its `allow_input` setting is on.
2. **The `claude-code` plugin** (`code.task`): runs the signed-in `claude` CLI in a folder, which
   reads and writes files and runs shell commands there. This is v2's shell.
3. **`documents`** (`document.extract`, reads PDF/DOCX/… in scope), **`ocr`**, **`media`** (images
   on the GPU), **`voice`** (the PC's mic and speakers), **`web-research`** (a browser).
4. **Core itself**: Open / Show in folder for a file a tool made (`/api/file`, `explorer.exe`,
   C7); `alexia/compute/run` for plugins; the edge-of-screen pill and plan checklist while she
   uses the computer (T1 `control_overlay` + T3, fed by `alexia/plan`/`alexia/stages` progress).
5. **Owner controls in the window** that decide whether any of that runs: the computer plugin's
   `allow_input` (P5), trusting a plugin so its annotations count (P4 `trust`), permission mode
   and folders (A3), Stop (C2) and Allow/Deny (C3).

### What the hub cannot do today, and the task that closes it

| # | Gap | Evidence | Closed by |
|---|---|---|---|
| G1 | **The hub runs where there is no desktop.** `alexia-hub install` registers a Task Scheduler task with `LogonType=Password` ("run whether the user is logged on or not") and a boot trigger, so it runs in session 0: screenshots are black or fail, clicks and typing go nowhere, `open_app` starts invisible programs. | `v3/crates/alexia-hub/src/watchdog.rs` `task_xml` | P2D-12 (logon task, `InteractiveToken`), P2D-13 (the app starts the hub in the owner's session) |
| G2 | **No way to change a plugin setting.** `allow_input` defaults to false; on the hub only Telegram exists, and it cannot set plugin settings. | no settings route; `alexia-mcp` has `settings/get` only for plugins | P2D-06 (P5) |
| G3 | **Every new plugin is unreviewed** (P2-62), so every computer tool counts as destructive and asks, step by step; there is no "trust" control. | `alexia-mcp/src/host.rs` `UNREVIEWED`, `alexia-core/src/permissions.rs` 103–110 | P2D-06 (P4 `trust` → `McpHost::set_reviewed`) |
| G4 | **No folders chosen** (TR-01 scope empty): every path-bearing call asks; only `alexia-hub scope add` changes it. | P2 PHASE *Owner needs* | P2D-04 (A3 roots) |
| G5 | **No Open / Show in folder** for files a tool made. | no `/api/file` | P2D-05 (C7) |
| G6 | **The pill and plan checklist get nothing**: `McpTooling` flattens progress to a line and drops `alexia/stages`, `alexia/plan`, `alexia/controls`, `alexia/preview`, `alexia/research`. | `alexia-core/src/tools.rs` `progress_line`, `ToolCtx.progress: Sender<String>` | P2D-03, then P2D-05 (C1 `step.progress`) |
| G7 | **Approvals for window runs go to Telegram** (P2-70: Desktop asks the primary chat), not to the window's Allow/Deny. | `alexia-gateway/src/ask.rs` | P2D-03 (window asker), P2D-05 |
| G8 | **Plugins need Node.** The hub finds `node` on PATH or `ALEXIA_NODE`; the packaged app's Node is the `alexia-core` sidecar binary. | `alexia-hub/src/main.rs` `node()` | P2D-13 (the shell passes `ALEXIA_NODE`) |
| G9 | **Not proven end to end.** P2-40 only loads and lists the computer plugin's tools; nothing has run one on the hub. | `v3/ops/reports/P2-40.md` line 17 | P2D-12 (`pc_actions` test), P2D-15 (on the real app) |

Not a gap: a general shell or file tool in core. v2 has none; its shell is the `claude-code`
plugin and its files go through `documents` and scoped plugin access. P2D adds no new tools
(owner: no sprawl); PC-01..PC-20 stay V3-4.
