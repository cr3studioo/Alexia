# P4: Limbs and the mesh (V3-4)

> Planned 2026-11-25 from `v3-plan.md` (the authority: *Shape*, D211, D214, D216, *V3-4*,
> *Still open*), `Alexia.md` (*The load-bearing invariant*, *Architecture*, *The plugin contract*,
> *The agent loop*), `v3/specs/INTERFACES.md` (§1.1, §2.2, §2.6, §2.7, §4), `connect/README.md`
> (the transport this phase builds on), `v3/specs/P3/PHASE.md`, `v3/ops/BOARD.md` and the code under
> `v3/crates/` and `plugins/` as merged on 2026-11-25. Feature titles are from `v3/picks.md`.

## Goal

Alexia stops being one PC. The owner's other computers (the Mac first) join the hub over an
end-to-end encrypted mesh, paired once with a code or a QR. Each runs a small limb that offers
that device's plugins to the hub as ordinary tools, so "take a screenshot of my Mac" is one more
capability call. Alexia knows which device the owner is using: notices, the conversation, the
clipboard and files follow them there. The hub picks the best device for each job and can wake
the PC. When the PC is off, the Mac answers on Telegram with what it has and gives the turns back
when the PC returns. A kill switch on every device stops everything at once. On the PC itself she
gets better hands: accessibility-first control with her own cursor, windows and layouts, file
search and tidying, system and power controls, shell and installs, browser automation through an
extension, drawing on screen and reading anything on it. Two new trust modes arrive: local-only
(nothing leaves the owner's devices) and guests (family can talk to her without reaching the
owner's data).

## Feature IDs (the owner's picks)

| ID | Title | Task(s) |
|---|---|---|
| HB-02 | Encrypted device mesh | P4-02, P4-04, P4-06, P4-37 |
| HB-03 | Limb agent on every device | P4-09, P4-10, P4-14 |
| HB-04 | Handoff mid-conversation | P4-32, P4-41 |
| HB-05 | Knows where you are active | P4-07, P4-37 |
| HB-06 | Notifications follow you | P4-18, P4-32, P4-37 |
| HB-07 | Shared clipboard | P4-16, P4-38 |
| HB-08 | Move files between devices | P4-17, P4-38 |
| HB-09 | Run each job on the best device | P4-12, P4-13 |
| HB-10 | Wake the PC when needed | P4-07, P4-36 |
| HB-11 | Fallback when the hub is down | P4-36, P4-40 (scope: D-P4-6) |
| HB-17 | Browser extension limb | P4-24, P4-25 |
| HB-18 | Pair a device with a QR code | P4-05 |
| PC-01 | Computer use with her own cursor | P4-26, P4-28 |
| PC-02 | Fast control through accessibility APIs | P4-28 |
| PC-03 | Apps and windows | P4-19 |
| PC-04 | Saved window layouts | P4-19 |
| PC-05 | Instant file search | P4-20 |
| PC-06 | Keeps folders tidy | P4-20 |
| PC-07 | Reads and edits documents | P4-21 |
| PC-08 | System controls | P4-22 |
| PC-09 | PC maintenance | P4-22 |
| PC-10 | Power actions | P4-22 |
| PC-11 | Browser automation | P4-24, P4-25 |
| PC-12 | "Look at my screen" | P4-27 |
| PC-13 | Help based on what's on screen | P4-27 |
| PC-14 | Recorded workflows | P4-29 |
| PC-15 | Shell and scripts | P4-23 |
| PC-16 | Installs software | P4-23 |
| PC-17 | Watches for finished jobs | P4-23 |
| PC-18 | Clipboard history | P4-16 |
| PC-19 | Reads any text on screen | P4-27 |
| PC-20 | Draws on screen | P4-26 |
| TR-05 | End-to-end encrypted mesh | P4-04, P4-06, P4-08 |
| TR-07 | Kill switch from any device | P4-39 |
| TR-10 | Local-only mode | P4-30, P4-34, P4-39 |
| TR-11 | Guest and family mode | P4-03, P4-31, P4-33, P4-34, P4-39 |

## Done when

`v3-plan.md` gives V3-4 no done-when. Proposed here (the owner may change it):

**Proven by tasks:**

1. **A day across devices, simulated** (P4-42): `cargo test -p alexia-hub --test mesh_day` runs, in
   one process on loopback with throwaway identities, the real hub wiring and one limb hosting the
   `mcp-fixture` plugin, and asserts:
   - the limb pairs from the text of the hub's QR; an endpoint that did not pair is refused;
   - the limb's fixture tool appears to the model as **one** tool with a `device` argument, and a
     call without it runs on the device the owner last used;
   - while the owner is active on the limb, a `Say` reaches the limb's `notify.show` and not the
     fake Telegram chat; when they write on Telegram again, the next one goes to Telegram;
   - `alexia-limb kill` (through the limb's code path) stops a running hub run within 2 s and
     nothing proactive runs until `/resume`;
   - with the hub stopped, the limb sends a wake packet, then answers the fake Telegram within its
     fallback deadline (paused clock); when the hub returns, those turns appear in the hub's session
     exactly once and the limb stops polling.
2. **The pieces hold on their own**: each task's tests, `node v3/ci/invariants.mjs`, `pnpm check`.
3. **On the owner's devices** (P4-43, P4-44): the Mac limb paired by code; "take a screenshot of my
   Mac" from Telegram works; a notice follows the owner to the Mac; a file moved Mac → PC; the
   clipboard follows; kill from the Mac; the PC switched off, the Mac answers Telegram, a wake
   packet wakes the PC (if the owner enabled it), and the turns sync back. The browser extension
   reads and clicks a page in the owner's browser. Recorded in `v3/ops/reports/P4-e2e.md`.
4. `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
   `cargo test --workspace` pass in `v3/`; `pnpm check` passes at the repo root (apart from known
   LATER failures).

## Decisions (planner; the owner may overrule)

- **D-P4-1: the mesh is `connect/`, in-process.** `alexia-connect` is used as a library
  (`alexia_connect::start(Options)`), not as a sidecar process, by a new lib crate
  **`alexia-mesh`** (deps: `alexia-store`, `alexia-connect`, `iroh =1.3.0`). Hub and limb both
  depend on it. `connect/` itself is not changed. Its QUIC/TLS with pinned endpoint ids and the
  allowlist checked on every stream is the end-to-end encryption (TR-05). Identity keys live in
  the OS keychain under service `dev.alexia.hub.mesh` (hub) or `dev.alexia.limb.mesh` (limb), never
  v2's `dev.alexia.connect`, so v3 never takes over v2's paired identity.
- **D-P4-2: no relay, no mailbox, no paid or third-party service** (D212, connect's own rule).
  Pairing is connect's **direct** pairing (`"direct": true`, four-word code, SPAKE2 over iroh).
  Devices reach each other on the home network, or anywhere over **Tailscale** if the owner
  installs it (free); the hub tells connect its Tailscale address with `PUT /v1/self/addresses`.
  Away from home without Tailscale, the Mac is cut off and falls back (D-P4-6).
- **D-P4-3: QR = the pairing text.** `alexia-hub devices pair` prints a pairing URI
  `alexia-pair:1?e=<endpoint id>&c=<code>&a=<ip:port>,..&n=<hub name>`, the same text as a QR
  (terminal blocks) and as an SVG file. The Mac limb takes the text (`alexia-limb pair "<uri>"`),
  because a Mac cannot easily scan a PC's screen; the iPhone app (V3-5) scans the QR.
- **D-P4-4: a limb is an MCP server, seen by the hub as one added server.** On pairing the hub
  adds the device with `McpHost::add_server(ServerEntry { id: <device id>, run: "mesh",
  args: [<endpoint id>] })` and marks it reviewed (the owner paired it). `run: "mesh"` makes the
  host ask a `Dial` (set by the hub) for the plugin's stdio instead of spawning a process. The
  limb hosts its device's plugins with its own `McpHost` and store, and serves their tools as
  `<plugin>.<tool>` with `_meta` (`alexia/provides`, annotations) carried. Plugin storage stays on
  the device. Sampling, capability calls and compute from a limb's plugins go up to the hub over
  the same link (P4-14).
- **D-P4-5: the link.** One long `POST /alexia/mcp/1` from hub to limb through connect's bridge,
  newline-delimited JSON-RPC in both directions (request body up, response body down, which the
  bridge streams both ways). Each side writes a bare `\n` every 5 s (connect closes a connection
  idle for 15 s) and drops empty lines it reads. A dropped link is the plugin stopping, never a
  crash: a limb offline is `Stopped`, not counted toward `crash_limit`. Limb → hub messages that
  are not replies use small hub operations: `POST /alexia/kill/1`, `POST /alexia/presence/1`,
  `POST /alexia/face/1` (a message typed or replied on the device).
- **D-P4-6: the Mac fallback scope** (*Still open* in `v3-plan.md`, decided here). The fallback
  brain lives **in `alexia-limb`** (so the limb may depend on `alexia-core` and `alexia-gateway`,
  a change to INTERFACES §1.1). It starts when the hub has been unreachable for 2 minutes **after**
  a wake packet had 90 seconds to work, and does only: Telegram chat through the agent loop, with
  free cloud providers, the Mac's own plugins, and the last 50 messages of each owner chat the hub
  pushed down while it was up. It does **not** run the scheduler, proactive notices, memory
  capture or anything that asks for approval of an outward-facing tool (those answer "I'll do that
  when the PC is back."). Telegram itself is the lock: a `409 Conflict` means the hub is polling
  again, and the fallback stops at once. On return the hub pulls the fallback's turns and appends
  them to the same sessions, idempotently (`fallback_sync`), in time order. Nothing is merged
  except appended messages, so there is nothing to conflict.
- **D-P4-7: presence is "last input".** Each device reports seconds since its last keyboard or
  mouse input; a message on a channel counts as that channel (Telegram = the phone). The owner is
  "at" the device with the most recent input within the last 5 minutes, else at their last
  channel. Pure function `alexia_mesh::presence::here`.
- **D-P4-8: notices and the conversation follow presence.** A `Say` with `to: None` goes to where
  the owner is (`Origin::Channel { channel: "device", chat: <device id> }` when it is a device),
  else as today. A turn from a different face within 30 minutes of the last turn continues the same
  session (handoff); `/new` still starts fresh.
- **D-P4-9: best device** (HB-09). When several providers answer a capability: a `device`
  argument wins; else for interactive capabilities (`computer.*`, `screen.*`, `clipboard.*`,
  `notify.*`, `browser.*`, `window.*`) the device where the owner is; else the hub's own plugin;
  else any online device. The model sees one tool per `<plugin>.<tool>` with an optional `device`
  enum, not one per device.
- **D-P4-10: kill switch.** "Kill" (Telegram `/kill`, the window's stop-all, `alexia-limb kill`,
  `alexia-hub kill`) stops every run, pauses the scheduler, holds every plugin on every device, and
  sets kv `_core`/`killed`. Only `/resume` from an owner channel undoes it. It never needs the model.
- **D-P4-11: local-only** (TR-10) is stronger than Local privacy mode: kv `_core`/`local_only`
  makes every model call local (no cloud fallback: with no local model she says so), blocks
  every `openWorldHint: true` tool, holds plugins that require `net.request` or `net.download`, and
  pauses channels that cross a service (Telegram) after one message saying so. The mesh stays on
  (it is the owner's own devices, end to end). Wording discipline from `Alexia.md` applies.
- **D-P4-12: guests** (TR-11). The owner adds a guest (`/guest add <name>` → a one-time code the
  guest sends the bot). A guest's chat gets its own sessions, a guest prompt, no memory capture or
  recall, no owner sessions, notices or approvals, and only tools on kv `_core`/`guest_tools`
  (empty by default: talk only). Guests are rows in a `guests` table (migration 5).
- **D-P4-13: new plugin ids are distinctive** (check 1 of `invariants.mjs`): `device-clipboard`,
  `file-courier`, `device-notify`, `window-deck`, `file-finder`, `pc-care`, `shell-runner`,
  `browser-pilot`, `screen-ink`, `screen-look`. P4-15 creates them all, so `pnpm-lock.yaml` changes
  in one task only.
- **D-P4-14: the browser extension talks to its own plugin on 127.0.0.1.** `browser-pilot` (a
  plugin on whichever device it runs, the hub PC or a limb) listens on `127.0.0.1` on a port it
  picks, with a token the owner pastes into the extension once. The extension (MV3, Chrome and
  Edge, in `plugins/browser-pilot/extension/`) connects over WebSocket. No native messaging host,
  no store listing. "Any computer" means any computer with the hub or a limb.

## Crates and files this phase creates or changes

| Where | P4 content |
|---|---|
| `docs/spec/capabilities.md` | the P4 capabilities (P4-01) |
| `v3/specs/INTERFACES.md` | §1.1 crates and edges, §2.2 `Dial`/remote servers, §2.7 the limb, §2.9 `alexia-mesh`, §3.6 P4 capabilities, §4 device events, §5.3 migration 5 (P4-35, after P3-35) |
| `alexia-mesh` (new lib) | types, errors, deps (P4-02); node (P4-04); pairing, QR (P4-05); link, ops (P4-06); presence, wake (P4-07); security tests (P4-08) |
| `alexia-store` | migration 5: `devices`, `fallback_sync`, `guests`; `src/devices.rs` (P4-03) |
| `alexia-mcp` | remote servers through a `Dial`, offline is not a crash (P4-11); best device (P4-12) |
| `alexia-core` | local-only rule (P4-30); guest rule (P4-31); one tool per capability across devices (P4-13); both rules applied in the loop (P4-34); `/kill`, `/resume`, `/localonly`, `/guest` (P4-39) |
| `alexia-gateway` | follow the owner: notices, handoff (P4-32); guests (P4-33) |
| `alexia-api` | the window joins the handoff (P4-41) |
| `alexia-limb` | serve, CLI (P4-09); service (P4-10); upcalls (P4-14); fallback, watch (P4-36); kill (P4-39) |
| `alexia-hub` | mesh wiring, devices, faces (P4-37); carry (P4-38); kill (P4-39); fallback sync (P4-40); `tests/mesh_day.rs` (P4-42) |
| `v3/ci/invariants.mjs` | the new crate and edges (P4-02) |
| `plugins/` | new: the ten in D-P4-13 (P4-15 skeletons, then one task each); `computer` (P4-28, P4-29); `documents` (P4-21); `pnpm-lock.yaml` (P4-15 only) |
| reports | `v3/ops/reports/P4-mesh-security.md` (P4-08), `P4-e2e.md`, `p4-mac.sh` (P4-43, P4-44) |

`connect/`, `packages/`, `src-tauri`, `.github/workflows/` are not touched. Alexia Dev
(`scripts/dev-app.mjs`) is not used by any task.

## Order of work, and what can start now

Open P3 work on 2026-11-25 and the files it holds: the scheduler chain P3-08..P3-11
(`alexia-scheduler/**`, `alexia-core/src/prompt.rs`), P3-16 (`alexia-core/{agent.rs, chat.rs}`,
`alexia-api/src/chat.rs`), P3-31..P3-33 (`alexia-hub/**`, `alexia-core/src/commands.rs`,
`v3/Cargo.lock`), P3-35 (`alexia-mcp/{lib.rs, types.rs, host.rs, bin/mcp-fixture.rs}`,
`alexia-core/{brain.rs, upcalls.rs}`, `INTERFACES.md`), P3-36 (`alexia-core/upcalls.rs`,
`alexia-gateway/src/ask.rs`, `docs/spec/wire-protocol.md`). No P4 task touches any of these until
the named P3 task has merged.

```
START NOW (no P3 file, only merged code):
P4-01 capabilities.md ── P4-15 ten plugin skeletons + pnpm-lock ─┬─ P4-16 clipboard  P4-17 courier  P4-18 notify
                      │                                        ├─ P4-19 window-deck  P4-20 file-finder  P4-22 pc-care
                      │                                        ├─ P4-23 shell-runner  P4-26 screen-ink  P4-27 screen-look
                      │                                        └─ P4-24 browser-pilot ── P4-25 extension
                      ├─ P4-21 documents edits
                      └─ P4-28 computer: accessibility, own cursor ── P4-29 recorded workflows
P4-02 alexia-mesh skeleton + lockfile ─┬─ P4-07 presence, wake-on-LAN
P4-03 store migration 5 ───────────────┴─ P4-04 node ─┬─ P4-05 pairing/QR ─┐
                                                       └─ P4-06 link, ops ──┴─ P4-08 TR-05 proven
                                                            P4-06 ── P4-09 limb serve ── P4-10 limb service
P4-30 core local-only ── P4-31 core guests (+P4-03)
P4-32 gateway follows the owner ── P4-33 gateway guests (+P4-03, P4-31)

WAIT FOR P3:
P3-35 ── P4-35 INTERFACES.md (+P4-01..P4-07 merged, so it records what landed)
P3-35 ── P4-11 host: remote servers ─┬─ P4-12 best device
                                      └─ P4-13 core: one tool across devices
P3-35 + P4-09 ── P4-14 limb upcalls
P3-16 + P4-30 + P4-31 ── P4-34 core: rules applied in the loop
P3-16 + P4-32 ── P4-41 window joins the handoff
P3-16 + P3-36 + P4-07 + P4-14 + P4-33 ── P4-36 limb fallback brain + wake
P3-31 + P4-05 + P4-06 + P4-07 + P4-11 + P4-12 + P4-13 + P4-32 ── P4-37 hub wiring
P4-37 + P4-16 + P4-17 ── P4-38 hub: clipboard follows, files move
P4-37 + P4-34 + P4-33 + P4-36 ── P4-39 kill switch, local-only, guest commands
P4-37 + P4-36 ── P4-40 hub: fallback sync back
P4-38 + P4-39 + P4-40 + P4-41 ── P4-42 a day across devices, simulated
OWNER'S HANDS (last):  P4-42 ── P4-43 the Mac limb, paired ── P4-44 fallback drill, wake, extension
```

**Can start now: P4-01, P4-02, P4-03, P4-30, P4-32** (no deps), then as their deps merge P4-04..P4-10,
P4-15..P4-29, P4-31, P4-33. That is 29 of 44 tasks.

**Must wait:** P4-11, P4-12, P4-13, P4-14, P4-35 (P3-35); P4-34, P4-41 (P3-16); P4-36 (P3-16,
P3-36); P4-37..P4-40, P4-42 (P3-31); P4-43, P4-44 (everything, and the owner).

Shared files and the order they force: `v3/Cargo.lock`: P4-02 → (P3-31) → P4-37. **P4-02 should
merge before P3-31 starts**; if it cannot, P3-31 rebases the lockfile (`cargo update -w`), or P4-02
waits for P3-31. `pnpm-lock.yaml`: P4-15 only. `alexia-mesh/src/lib.rs`: P4-02 only (it declares
every module as a stub). `alexia-limb/Cargo.toml`: P4-02 only. `alexia-limb/src/main.rs`, `serve.rs`: P4-09 → P4-14 → P4-36; `cli.rs`: P4-09 → P4-39. `alexia-mcp/src/host.rs`: (P3-35) → P4-11 → P4-12.
`alexia-mcp/src/lib.rs`: (P3-35) → P4-11. `alexia-core/src/permissions.rs`, `run.rs`: P4-30 → P4-31.
`alexia-core/src/agent.rs`: (P3-16) → P4-34. `alexia-core/src/commands.rs`: (P3-31) → P4-39.
`alexia-gateway/src/gateway.rs`: P4-32 → P4-33. `alexia-hub/src/main.rs`: (P3-31) → P4-37 → P4-38
→ P4-39 → P4-40 (one line each after P4-37). `plugins/computer/**`: P4-28 → P4-29.

**This PC has 16 GB: at most 4 workers at once, and at most 2 compiling Rust**
(`CARGO_BUILD_JOBS=1`, per-crate tests). P4-02 brings iroh into the workspace: the first build of
`alexia-mesh` takes several minutes and about 2 GB more target space on D:. Plugin tasks compile
no Rust (only the invariants check), so they are the ones to run beside the scheduler chain.

## Tasks

Crate paths are under `v3/crates/`.

| ID | Title | Model | Depends on | Touches |
|---|---|---|---|---|
| P4-01 | Capabilities for P4 | opus | none | `docs/spec/capabilities.md` |
| P4-02 | `alexia-mesh` crate: types, errors, module stubs, dependencies, lockfile | opus | none | `alexia-mesh/{Cargo.toml, src/lib.rs, src/types.rs, src/error.rs, src/{node,control,pair,qr,link,ops,presence,wol}.rs (stubs), tests/types.rs}`, `alexia-limb/Cargo.toml`, `v3/Cargo.lock`, `v3/ci/invariants.mjs` |
| P4-03 | Store migration 5: devices, fallback sync, guests | opus | none | `alexia-store/{src/migrations.rs, src/devices.rs (new), src/types.rs, src/lib.rs, tests/devices.rs}` |
| P4-04 | Mesh node: connect in-process, identity, allowlist, peer events | opus | P4-02, P4-03 | `alexia-mesh/{src/node.rs, src/control.rs, tests/node.rs}` |
| P4-05 | Pair a device with a code or a QR | opus | P4-04 | `alexia-mesh/{src/pair.rs, src/qr.rs, tests/pair.rs}` |
| P4-06 | The link: MCP over the mesh, and the hub's operations | opus | P4-04 | `alexia-mesh/{src/link.rs, src/ops.rs, tests/link.rs}` |
| P4-07 | Presence and wake-on-LAN | sonnet | P4-02 | `alexia-mesh/{src/presence.rs, src/wol.rs, tests/presence.rs, tests/wol.rs}` |
| P4-08 | TR-05 proven: the mesh refuses what it must | opus | P4-05, P4-06 | `alexia-mesh/tests/security.rs`, `v3/ops/reports/P4-mesh-security.md` |
| P4-09 | Limb: the device's plugins served to the hub | opus | P4-06 | `alexia-limb/{src/main.rs, src/cli.rs, src/serve.rs, src/service.rs (stub), tests/limb.rs}` |
| P4-10 | Limb: runs at login, logs, status | sonnet | P4-09 | `alexia-limb/{src/service.rs, tests/service.rs}` |
| P4-11 | McpHost: remote servers through a dialer; offline is not a crash | opus | P3-35 | `alexia-mcp/{src/lib.rs, src/host.rs, tests/remote.rs}` |
| P4-12 | McpHost: each call on the best device | opus | P4-11 | `alexia-mcp/{src/host.rs, tests/prefer.rs}` |
| P4-13 | Core: one tool across devices, with a `device` argument | opus | P4-11 | `alexia-core/{src/tools.rs, tests/device_tools.rs}` |
| P4-14 | Limb: its plugins' upcalls go to the hub | opus | P4-09, P3-35 | `alexia-limb/{src/upcalls.rs, tests/upcalls.rs, src/main.rs (one line), src/serve.rs (one fn)}` |
| P4-15 | Ten plugin skeletons and the lockfile | sonnet | P4-01 | `plugins/{device-clipboard, file-courier, device-notify, window-deck, file-finder, pc-care, shell-runner, browser-pilot, screen-ink, screen-look}/{package.json, plugin.json, index.js, test/load.test.js}`, `pnpm-lock.yaml` |
| P4-16 | device-clipboard: clipboard, history | sonnet | P4-15 | `plugins/device-clipboard/**` |
| P4-17 | file-courier: files in chunks between devices | sonnet | P4-15 | `plugins/file-courier/**` |
| P4-18 | device-notify: native notifications with a reply | sonnet | P4-15 | `plugins/device-notify/**` |
| P4-19 | window-deck: apps, windows, saved layouts | sonnet | P4-15 | `plugins/window-deck/**` |
| P4-20 | file-finder: instant search, tidy folders | sonnet | P4-15 | `plugins/file-finder/**` |
| P4-21 | documents: edits | sonnet | P4-01 | `plugins/documents/{edit.js (new), index.js, plugin.json, test/edit.test.js}` |
| P4-22 | pc-care: system controls, maintenance, power | sonnet | P4-15 | `plugins/pc-care/**` |
| P4-23 | shell-runner: shell, scripts, installs, finished jobs | opus | P4-15 | `plugins/shell-runner/**` |
| P4-24 | browser-pilot: the plugin and its local socket | opus | P4-15 | `plugins/browser-pilot/{index.js, socket.js, pilot.js, plugin.json, test/**}` |
| P4-25 | browser-pilot: the extension | opus | P4-24 | `plugins/browser-pilot/extension/**`, `plugins/browser-pilot/test/extension.test.js` |
| P4-26 | screen-ink: draws on screen, her cursor | sonnet | P4-15 | `plugins/screen-ink/**` |
| P4-27 | screen-look: look at my screen, help, read any text | sonnet | P4-15 | `plugins/screen-look/**` |
| P4-28 | computer: accessibility first, her own cursor | opus | P4-01 | `plugins/computer/{windows.js, macos.js, index.js, ghost.js (new), test/ghost.test.js, test/windows.test.js, test/macos.test.js}` |
| P4-29 | computer: recorded workflows | opus | P4-28 | `plugins/computer/{record.js (new), index.js, windows.js, macos.js, test/record.test.js}` |
| P4-30 | Core: the local-only rule | opus | none | `alexia-core/{src/router.rs, src/permissions.rs, src/run.rs, tests/local_only.rs}` |
| P4-31 | Core: the guest rule | opus | P4-30, P4-03 | `alexia-core/{src/permissions.rs, src/run.rs, tests/guest.rs}` |
| P4-32 | Gateway: notices and the conversation follow the owner | sonnet | none | `alexia-gateway/{src/gateway.rs, tests/follow.rs}` |
| P4-33 | Gateway: guests on Telegram | opus | P4-03, P4-31, P4-32 | `alexia-gateway/{src/gateway.rs, src/channels/telegram/mod.rs, tests/guests.rs}` |
| P4-34 | Core: local-only and guests applied in the loop | opus | P4-30, P4-31, P3-16 | `alexia-core/{src/agent.rs, tests/guest_turns.rs}` |
| P4-35 | INTERFACES.md for P4 | opus | P3-35, P4-01..P4-07 | `v3/specs/INTERFACES.md` |
| P4-36 | Limb: wake the PC, then the fallback brain | opus | P4-07, P4-14, P4-33, P3-16, P3-36 | `alexia-limb/{src/watch.rs (new), src/fallback.rs (new), tests/fallback.rs, src/main.rs (two lines), src/serve.rs (hidden tools)}` |
| P4-37 | Hub: mesh, devices, presence, notices that follow | opus | P3-31, P4-05, P4-06, P4-07, P4-11, P4-12, P4-13, P4-32 | `alexia-hub/{Cargo.toml, src/main.rs, src/devices.rs (new), src/face.rs (new), tests/devices.rs}`, `v3/Cargo.lock` |
| P4-38 | Hub: the clipboard follows, files move between devices | sonnet | P4-37, P4-16, P4-17 | `alexia-hub/{src/carry.rs (new), src/main.rs, tests/carry.rs}` |
| P4-39 | Kill switch from any device; local-only and guest commands | opus | P4-37, P4-34, P4-33, P4-36 | `alexia-hub/{src/kill.rs (new), src/main.rs, tests/kill.rs}`, `alexia-core/src/commands.rs`, `alexia-limb/src/cli.rs` |
| P4-40 | Hub: the fallback's turns come home | opus | P4-37, P4-36 | `alexia-hub/{src/fallback.rs (new), src/main.rs, tests/fallback_sync.rs}` |
| P4-41 | The window joins the handoff | sonnet | P3-16, P4-32 | `alexia-api/{src/chat.rs, tests/handoff.rs}` |
| P4-42 | A day across devices, simulated | sonnet | P4-38, P4-39, P4-40, P4-41 | `alexia-hub/tests/mesh_day.rs` |
| P4-43 | Owner: the Mac limb, paired, the hands on both computers | sonnet | P4-42, all plugin tasks | `v3/ops/reports/{P4-e2e.md, p4-mac.sh}` |
| P4-44 | Owner: the PC off, wake, fallback, the browser extension | sonnet | P4-43 | `v3/ops/reports/{P4-e2e.md, P4-fallback.md}` |

44 tasks.

## Owner needs

Asked now so nothing waits. None blocks a task before P4-43.

1. **The Mac.** P4-43 needs about 30 minutes at the Mac: build `alexia-limb` (the Rust toolchain
   `pnpm app:dev` already uses), run `alexia-limb pair "<text>"`, grant Accessibility and Screen
   Recording to it, choose which plugins it runs. Which other computers should get a limb?
2. **Away from home.** Without a relay (D-P4-2) the Mac reaches the PC only on the same network,
   or over Tailscale. Install Tailscale (free) on the PC and the Mac? If not, away from home the
   Mac falls back (D-P4-6).
3. **Wake-on-LAN (HB-10).** Enable "Wake on LAN" / "Power on by PCI-E" in the PC's BIOS and "Wake
   on Magic Packet" on its network adapter, and keep the PC on Ethernet. It works from sleep
   reliably and from shut-down only if the board supports it, and only on the home network.
4. **Fallback secrets (HB-11).** For the Mac to answer Telegram while the PC is off, it needs the
   bot token and the free providers' keys in the Mac's keychain. P4-39 adds
   `alexia-limb secret set <key>` on the Mac (typed there, never sent over the mesh). Agree?
5. **Act silently, new tools.** Proposed additions to the P3 list (owner approves): show a
   notification on a device, copy to a device's clipboard, draw on screen and clear it, save a
   window layout. **Always asks:** power actions, installs, shell commands that are not read-only,
   moving or deleting files, moving a file to another device, browser clicks and form fills,
   anything a guest asks for.
6. **Guests (TR-11).** Who, and may a guest use any tool at all (weather, timers)? Default: talk
   only.
7. **Local-only (TR-10).** Confirm that local-only pauses Telegram (it crosses Telegram's
   servers) and leaves the mesh on.
8. **Browser.** Chrome or Edge, and on which computers? P4-44 loads the extension unpacked.

## INTERFACES.md additions this phase makes

Written by P4-35, after P3-35 merges, recording what P4-01..P4-07 landed. Until then each
task's *Interfaces* section and this file are the contract.

1. §1.1: `alexia-mesh` (lib, deps `alexia-store`, `alexia-connect`); `alexia-limb` may depend on
   `alexia-store`, `alexia-mcp`, `alexia-core`, `alexia-gateway`, `alexia-mesh`; `alexia-hub` also on
   `alexia-mesh`. `connect/` stays outside the workspace.
2. §2.1: migration 5 and the `devices`, `fallback_sync`, `guests` API (P4-03).
3. §2.2: `Dial`, `HostConfig.dial`, `run: "mesh"`, `HostedTool.device`, `McpHost::set_prefer` (P4-11, P4-12).
4. §2.3: `Scope.local_only`, `permissions::local_only`, `permissions::guest`, `Guest` (P4-30, P4-31).
5. §2.4: `Gateway::set_follow` (P4-32).
6. §2.7 rewritten: the limb (P4-09, P4-14, P4-36); new §2.9 `alexia-mesh` (P4-02..P4-07).
7. §3.6: the P4 capabilities (P4-01).
8. §4: `PeerOnline`/`PeerOffline` carry a device id; `Killed`, `Resumed`.
9. §5.3: migration 5.

## Risky or unclear

- **iroh in the workspace** (P4-02). The workspace resolves `iroh =1.3.0` and its tree itself, not
  through `connect/Cargo.lock`, so versions under it may differ from what connect's tests ran with.
  P4-02 runs connect's own tests against the workspace's resolution once (`cargo test --manifest-path
  connect/Cargo.toml` is unaffected; the check is P4-04's node tests). Build time and target size grow.
- **A full-duplex HTTP/1 request through the bridge** (D-P4-5) is unusual. The bridge streams the
  upload beside the answer (`connect/src/bridge.rs`), and hyper's server can read a body while it
  writes one, but nobody has run an hour-long one. P4-06's first test is exactly that; if it fails,
  the fallback is one `POST` per JSON-RPC message plus a long `GET` for server → client messages,
  inside `link.rs` only.
- **The hub dials the limb, not the reverse.** A limb behind a network that refuses incoming
  connections is reached only through Tailscale.
- **HB-11 is the riskiest feature.** Split brain is avoided by Telegram's 409 only for Telegram;
  the window and other channels do not run on the Mac in fallback. Ids of fallback turns are
  remapped through `fallback_sync` (INTERFACES §8.6 foresaw this).
- **The Mac's plugins need Node** on the Mac and an owner-chosen plugin folder (the v2 checkout's
  `plugins/`). The limb enables nothing by default.
- **HB-04 handoff** covers Telegram, device faces (a notification reply on the Mac) and the window
  (P4-41). There is no chat window on the Mac in P4 (D217: presence is a tray and orb, V3-7).
- **PC-14 recorded workflows** records keyboard and mouse. It records element names and actions,
  never typed text in password fields, and only while a visible recording indicator is on.
- **PC-10 power actions and PC-16 installs** are destructive or outward; they always ask, in every
  mode, and never run from a proactive turn (D214 rule from P3-06 holds).
- **Browser automation in the owner's real browser** sees their logged-in sessions. The socket is
  127.0.0.1 with a token, the extension accepts commands only from it, and every click or fill
  asks unless the owner lists it.
- **Scope.** 36 features, 44 tasks. If the phase runs long, the CEO can ship the mesh, the limb,
  HB-06 and the PC plugins, and move HB-11 (P4-36, P4-40) to a P4b without changing the rest.
