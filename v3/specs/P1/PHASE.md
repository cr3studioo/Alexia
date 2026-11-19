# P1: V3-1, Telegram fast

> Planned 2026-11-18 from `v3-plan.md` *V3-1* (the authority for scope) and
> `v3/specs/INTERFACES.md` (the Rust shapes), on top of what the P0 specs promise (P0-10..P0-16
> are still being built). Where INTERFACES.md needs an addition for this phase, the addition is
> listed at the end and made by the task named there.

## Goal

Telegram answers from the always-on Windows PC, in Rust, without waiting on the wrong things.
A message gets a 👀 reaction the moment the hub receives it. Plain chat ("hi", "thanks", "what do
you think of…") goes down a fast lane: one hedged call to the two fastest free cloud models, with
no tools and no agent loop, a prompt whose prefix stays byte-identical so providers can cache it,
and recall that is never waited on for more than 250 ms. Anything that needs tools, files or
steps goes to the v2 core, which the hub runs on the PC and drives through v2's own HTTP API
(`V2Bridge`), with drafts streamed at Telegram's real rate, approval buttons, steering and
voice notes. Every turn is timed by stage, and `alexia-hub latency` shows where the seconds went.

Feature IDs: **CH-01** (the bot runs on the hub; long polling, nothing exposed), **CH-03** (instant
reaction), **CH-04** (drafts at Telegram's real rate, not v2's once a second), **CH-05** (voice
notes both ways, through `voice.transcribe` / `voice.render`), **CH-06** (photos and screenshots,
sent to the task lane as pictures), **CH-07** (one-tap approvals), **CH-08** (steer mid-task),
**CH-09** (merge quick messages), **SP-03** (chat fast path), **SP-04** (the model starts before
recall finishes), **SP-05** (prompt caching: a stable prefix), **SP-07** (latency budget per
channel), **SP-14** (stream everything: deltas, phases and tool steps into the draft), **SP-16**
(parallel tool calls, in v2's agent loop, which is the loop in use until V3-2), **MO-03** (routing
preference: free cloud first, D212), **MO-04** (free-tier aggregation: v2's free provider ladder,
ported), **HB-12** (hub watchdog), **hedged free requests** (D212), **SP-09** (latency dashboard,
pulled in).

## Done when (from v3-plan.md)

The reaction lands in under 300 ms, plain chat never enters the agent loop, and the dashboard
shows where every second goes on 50 real messages.

Measured, not claimed:
- `cargo test -p alexia-hub --test telegram_e2e` (P1-18) drives the real `alexia-hub run`
  binary against a fake Bot API, fake free providers and a fake v2 core, and asserts: for 50
  messages the reaction is sent within 300 ms of the update being received (p100, measured by
  the fake Bot API's own clock) even when the brain takes 5 s; no chat-lane message ever reaches
  the fake v2 `/api/chat`; every task-lane message does; every turn has spans covering receipt to
  delivery.
- On the PC, after the owner has sent 50 real messages: `alexia-hub latency --last 50 --check`
  exits 0. `--check` fails if any turn's `ack` span is ≥ 300 ms, if any `chat`-lane turn has a
  `bridge` span, or if any turn's spans leave more than 5 % of receipt → delivered unaccounted.
  `alexia-hub latency --last 50 --html latency.html` writes the dashboard page (P1-15).

## Crates and files this phase creates or changes

All under `v3/crates/` unless noted.

| Crate | P1 content |
|---|---|
| `alexia-store` | migration 2: `channel_chats`, `spans`; `Store` methods for both, `tries_since`, `request_count`; an environment fallback for secrets (CI and the e2e test) (P1-03) |
| `alexia-core` | `brain.rs` (Turn, DraftFrame, Reply, Brain, Ask, BrainError), `provider.rs` (Provider trait and chat types), `openai.rs` + `free.rs` (one OpenAI-compatible provider, v2's free ladder), `catalog.rs` (free chat models, refreshed every 6 h), `router.rs` (`Router::hedged`, budget), `lane.rs` (classifier, `Lanes` brain), `chat.rs` (`FastChat` brain) |
| `alexia-gateway` | `channel.rs` (Channel, Inbound, Outbound, Media), `gateway.rs` (the run loop), `ask.rs` (approvals), `voice.rs`, `channels/mod.rs`, `channels/telegram/{mod.rs, api.rs}` |
| `alexia-hub` | `bridge.rs` (V2Bridge), `latency.rs` (dashboard), `watchdog.rs` (HB-12), `main.rs` (wiring, `run`, `latency`, `secret`, `pair`, `install`, `uninstall`); `tests/telegram_e2e.rs` |
| v2 | `packages/core/src/agent.ts` and its test: parallel tool calls (P1-14, SP-16) |

Migrations: P1 ships **migration 2** only, as INTERFACES.md §5.3 planned, plus a `turn` column on
`spans` so stages group by message (P1-03).

`alexia-connect` is still not a dependency: v2 core runs on the PC beside the hub, so the bridge
is a loopback call (INTERFACES.md §8.2, decided here).

## Order of work

```
P1-01 core types + module stubs ──┬─ P1-04 openai + free ── P1-05 catalog ──┐
                                   ├─ P1-07 lanes                            │
                                   └─ P1-02 gateway types + stubs            │
P1-03 store migration 2 ───────────────────────────────── P1-06 router ◀──────┘
                                        P1-06 + P1-03 + P0-13 ── P1-08 fast chat
P1-02 ─┬─ P1-09 telegram api ── P1-10 telegram channel (+P1-03)
       ├─ P1-11 gateway loop (+P1-03) ── P1-12 approvals + voice
       ├─ P1-13 v2 bridge (+P1-03)
       ├─ P1-15 latency dashboard (+P1-03)
       └─ P1-16 watchdog
P1-14 v2 parallel tool calls (independent)
P1-07, P1-08, P1-10, P1-12, P1-13, P1-15, P1-16 ── P1-17 hub wiring ── P1-18 e2e + 50 real messages
```

P1-01 waits for P0-15 (both change `Cargo.lock`); P1-03 can start as soon as P0-07 is merged and
P1-14 at any time. Can run together: P1-01 ∥ P1-03 ∥ P1-14. After P1-01: P1-02 ∥ P1-04 ∥ P1-07. After P1-02 and
P1-03: P1-09 ∥ P1-11 ∥ P1-13 ∥ P1-15 ∥ P1-16 (and P1-05 → P1-06 → P1-08 on the core side). P1-01
and P1-02 create every new module as a stub and add every new dependency, so no two later tasks
share a `lib.rs`, `main.rs`, `Cargo.toml` or `Cargo.lock`.

## Tasks

Crate paths are under `v3/crates/`.

| ID | Title | Model | Depends on | Touches |
|---|---|---|---|---|
| P1-01 | Core shared types, module stubs, P1 dependencies | opus | P0-15 | `v3/Cargo.toml`, `v3/Cargo.lock`, `v3/specs/INTERFACES.md`, `alexia-core/{Cargo.toml, src/lib.rs, src/brain.rs, src/provider.rs, src/{openai,free,catalog,router,lane,chat}.rs (stubs), tests/types.rs}` |
| P1-02 | Gateway types, gateway and hub stubs | opus | P1-01 | `alexia-gateway/{Cargo.toml, src/lib.rs, src/channel.rs, src/{gateway,ask,voice}.rs (stubs), src/channels/mod.rs, src/channels/telegram/{mod,api}.rs (stubs), tests/types.rs}`, `alexia-hub/{Cargo.toml, src/main.rs, src/{bridge,latency,watchdog}.rs (stubs)}`, `v3/Cargo.lock` |
| P1-03 | Store: migration 2, channel chats, spans, tries_since, env secrets | opus | P0-07 | `alexia-store/{src/lib.rs, src/types.rs, src/db.rs, src/migrations.rs, src/secrets.rs, tests/channels.rs}` |
| P1-04 | OpenAI-compatible provider and v2's free ladder | opus | P1-01 | `alexia-core/{src/openai.rs, src/free.rs, tests/openai.rs}` |
| P1-05 | Free chat catalog | opus | P1-04 | `alexia-core/{src/catalog.rs, tests/catalog.rs}` |
| P1-06 | Router::hedged with a latency budget | opus | P1-05, P1-03 | `alexia-core/{src/router.rs, tests/router.rs}` |
| P1-07 | Lane classifier and the Lanes brain | opus | P1-01 | `alexia-core/{src/lane.rs, tests/lane.rs}` |
| P1-08 | FastChat: the chat lane brain | opus | P1-06, P1-03, P0-13 | `alexia-core/{src/chat.rs, tests/chat.rs}` |
| P1-09 | Telegram Bot API client | opus | P1-02 | `alexia-gateway/{src/channels/telegram/api.rs, tests/telegram_api.rs}` |
| P1-10 | Telegram channel: poll, pairing, offsets, buttons | opus | P1-09, P1-03 | `alexia-gateway/{src/channels/mod.rs, src/channels/telegram/mod.rs, tests/telegram_channel.rs}` |
| P1-11 | Gateway loop: ack, merge, steer, drafts, spans | opus | P1-02, P1-03 | `alexia-gateway/{src/gateway.rs, tests/gateway.rs}` |
| P1-12 | Approvals and voice notes | opus | P1-11 | `alexia-gateway/{src/ask.rs, src/voice.rs, tests/ask_voice.rs}` |
| P1-13 | V2Bridge: v2 core as the task lane | opus | P1-02, P1-03 | `alexia-hub/src/bridge.rs` |
| P1-14 | v2: parallel tool calls | opus | none | `packages/core/src/agent.ts`, `packages/core/test/agent.test.ts` |
| P1-15 | Latency dashboard | sonnet | P1-02, P1-03 | `alexia-hub/src/latency.rs` |
| P1-16 | Hub watchdog | sonnet | P1-02 | `alexia-hub/src/watchdog.rs` |
| P1-17 | Hub wiring and CLI | sonnet | P1-07, P1-08, P1-10, P1-12, P1-13, P1-15, P1-16 | `alexia-hub/{Cargo.toml, src/main.rs, src/media.rs, tests/cli_p1.rs}`, `v3/Cargo.lock` |
| P1-18 | End-to-end latency test and the 50-message run | sonnet | P1-17 | `alexia-hub/tests/telegram_e2e.rs`, `v3/ops/reports/P1-latency.md` |
| P1-20 | Hub: latency offsets and hidden console | sonnet | none | `alexia-hub/src/{latency.rs, watchdog.rs}`, `v3/specs/INTERFACES.md` |
| P1-21 | Telegram api: file transfers and retry_after | sonnet | none | `alexia-gateway/{src/channels/telegram/api.rs, tests/telegram_api.rs}` |
| P1-22 | Core: tool rows on the wire, catalog temp file | sonnet | none | `alexia-core/{src/openai.rs, src/catalog.rs, tests/openai.rs, tests/catalog.rs}` |
| P1-23 | Gateway: spawned tasks on the tracker | opus | none | `alexia-gateway/{src/gateway.rs, tests/gateway.rs}` |
| P1-24 | v2 agent: dangling tool ids at the ceiling | sonnet | none | `packages/core/src/agent.ts`, `packages/core/test/agent.test.ts` |
| P1-25 | One time helper | sonnet | P1-20, P1-22, P1-23, P1-17, P0-25 | `alexia-store/{src/types.rs, src/db.rs, src/import.rs, tests/time.rs}`, `alexia-core/src/catalog.rs`, `alexia-gateway/src/gateway.rs`, `alexia-hub/src/{watchdog.rs, latency.rs, main.rs}`, `v3/specs/INTERFACES.md` |
| P1-26 | Documents reach the task lane; no empty assistant turns; bounded prompt fetches | opus | P1-07, P1-17, P1-23 | `alexia-core/{src/brain.rs, src/lane.rs, src/chat.rs, tests/lane.rs, tests/chat.rs, tests/types.rs}`, `alexia-gateway/{src/channel.rs, src/gateway.rs, tests/gateway.rs}`, `alexia-hub/{src/bridge.rs, Cargo.toml}`, `v3/Cargo.lock`, `v3/specs/INTERFACES.md` |
| P1-27 | De-flake call_at_idle_deadline_never_gone | sonnet | none | `alexia-mcp/tests/supervise.rs` |

## Owner needs

- **The Telegram bot token.** The hub uses the owner's existing Alexia bot (the one v2's
  Telegram plugin uses), stored in Windows Credential Manager, service `alexia`, account
  `_core.telegram_bot_token`. The owner enters it once on the PC with
  `alexia-hub secret set telegram_bot_token` (read from stdin, never from the command line, never
  echoed). For P1-18's by-hand run before cutover, a second bot from @BotFather is safer: same
  command, and switch back later.
- **Only one program may read the bot.** Telegram answers a second long-poller with 409. Before
  the hub uses the real bot, switch off the Telegram plugin in v2 on the Mac, and in the v2 data
  copy the bridge uses (below). The hub says "Another program is reading this bot's messages"
  until that is done; it never disables anything itself.
- **Pairing once.** On first `alexia-hub run` (or `alexia-hub pair`) the hub prints a six-digit
  code; the owner sends it to the bot from their own Telegram account. v2's pairing is not reused
  (it lives in a plugin's namespace).
- **Free provider keys on the PC.** For whichever of Groq, Cerebras, Google AI Studio,
  OpenRouter, Mistral, NVIDIA, GitHub Models the owner has keys: `alexia-hub secret set
  provider_<id>` (Credential Manager `alexia` / `_core.provider_<id>`, v2's own names, so if
  P0-06 found keyring reads v2's Windows entries, keys entered into v2 on the PC already work).
  At least two keyed providers are needed for hedging to race anything.
- **Provider terms for hedging** (v3-plan *Still open*): hedging sends each chat message to two
  providers. The owner reads each keyed provider's free-tier terms before relying on it; a
  provider can be left out by not giving it a key.
- **v2 core on the PC for the bridge.** A checkout of this repo on the PC with Node 22 (the one
  `ALEXIA_NODE` or `PATH` names), `pnpm install && pnpm typecheck` run in it, and its path in
  `ALEXIA_V2_ROOT`. A v2 data folder for it at `%LOCALAPPDATA%\AlexiaBridge`: a copy of the
  Mac's `~/Library/Application Support/Alexia` taken with v2 quit (the same copy P0's
  `import-v2` used is fine), with its Telegram plugin switched off.
- **Machine permission for the watchdog.** `alexia-hub install`, run once from an elevated
  (Administrator) terminal, registers a Task Scheduler task "Alexia hub" that starts at boot and
  restarts on failure, running as the owner's Windows account. `schtasks` itself asks for the
  Windows password and Task Scheduler stores it; the hub never sees it. The PC's power plan must
  not sleep (HB-10's "keep the PC on").
- **Network.** Outbound HTTPS from the PC to `api.telegram.org` and the provider APIs. Nothing
  inbound, no port forwarding, no firewall rule: the hub listens on nothing but loopback to v2.
- **The 50 real messages** for the done-when: the owner uses Telegram normally over a day or two
  (a mix of chat and tasks), then runs `alexia-hub latency --last 50 --check --html latency.html`.

## INTERFACES.md additions this phase makes

All five are written into INTERFACES.md by P1-01, in one commit, so no two parallel tasks edit
that file. The task named after each is the one that implements it.

1. P1-01: `BrainError::NeedsTask` (the chat lane hands a turn to the task lane);
   `Budget { first_byte_ms }` as a third argument to `Router::hedged` (SP-07);
   `ChatDone.provider`.
2. (P1-02) `Inbound.kind: InKind` (`Message | Stop`) and `Inbound.files: Vec<InFile>` (photos,
   voice notes); `trait Media` (voice in and out, implemented in the hub over `McpHost`, and by a
   fake); `Channel::budget()`; `GatewayConfig` defaults `merge_ms: 500`, `draft_every_ms: 300`
   (v3-plan's CH-04 asks for Telegram's real rate, not 700 ms; P1-11 backs off on 429).
3. (P1-03) `spans` gets a `turn TEXT` column; `channel_chats.primary` is spelled `is_primary`
   (`PRIMARY` is an SQL keyword); store methods listed in P1-03.
4. (P1-15) the dashboard is a page the hub **writes** (`alexia-hub latency --html`), not one it
   serves, so the hub opens no port.
5. (P1-03, P1-17) `secrets::get` reads `ALEXIA_SECRET_<OWNER>_<KEY>` first (§0.3's "environment
   variables for CI"); §2.6 gains `secret set|clear|list`, `pair`, `latency`, `install`,
   `uninstall`; `V2Bridge` gains `V2Config` and `set_ask` (§2.6).

## Notes

- P1-22 skips tool rows on the no-tools path (`openai.rs` `wire`); V3-2 must map `calls` → `tool_calls` and `call_id` → `tool_call_id` when it sends tools.
