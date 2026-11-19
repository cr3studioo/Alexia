# BOARD
| ID | Title | Phase | Model | Depends | Touches | Status | Tries | Branch | Note |
| -- | ----- | ----- | ----- | ------- | ------- | ------ | ----- | ------ | ---- |
| P0-01 | Cargo workspace skeleton | P0 | sonnet | none | v3/Cargo.toml, crate stubs | merged | 1 | cr3studioo/v3-P0-01 | |
| P0-02 | Store shared types, layout, error | P0 | opus | P0-01 | alexia-store types/layout/error | merged | 1 | cr3studioo/v3-P0-02 | |
| P0-03 | MCP wire types, host types, core bus | P0 | opus | P0-02 | alexia-mcp wire, alexia-core bus | merged | 1 | cr3studioo/v3-P0-03 | |
| P0-04 | Store: open, migration 1, sqlite-vec | P0 | opus | P0-02 | alexia-store db/migrations | merged | 1 | cr3studioo/v3-P0-04 | |
| P0-05 | Store: plugin namespaces | P0 | opus | P0-04 | alexia-store namespace | merged | 2 | cr3studioo/v3-P0-05 | |
| P0-06 | Store: secrets in Credential Manager | P0 | opus | P0-05 | alexia-store secrets | merged | 1 | cr3studioo/v3-P0-06 | |
| P0-07 | Store: the v2 importer | P0 | opus | P0-06 | alexia-store import | merged | 2 | cr3studioo/v3-P0-07 | |
| P0-08 | Manifest parsing, compatibility, discovery | P0 | opus | P0-03 | alexia-mcp manifest | merged | 3 | cr3studioo/v3-P0-08 | |
| P0-09 | The mcp-fixture test server | P0 | sonnet | P0-03 | alexia-mcp bin/mcp-fixture | merged | 1 | cr3studioo/v3-P0-09 | |
| P0-10 | Plugin process and JSON-RPC connection | P0 | opus | P0-08, P0-09 | alexia-mcp process/job/conn, Cargo.toml | merged | 2 | cr3studioo/v3-P0-10 | |
| P0-11 | McpHost: start, handshake, tools, call_tool | P0 | opus | P0-10, P0-04 | alexia-mcp host | merged | 1 | cr3studioo/v3-P0-11 | |
| P0-12 | Supervision: lazy, idle, heartbeat, backoff | P0 | opus | P0-11 | alexia-mcp host/supervise | merged | 2 | cr3studioo/v3-P0-12 | |
| P0-13 | The alexia/* layer, capabilities, purge | P0 | opus | P0-12, P0-06 | alexia-mcp host/serve | merged | 1 | cr3studioo/v3-P0-13 | |
| P0-14 | alexia-hub CLI | P0 | sonnet | P0-13, P0-07 | alexia-hub main/tests | merged | 2 | cr3studioo/v3-P0-14 | |
| P0-15 | v2 plugins conformance test | P0 | sonnet | P0-14, P0-19 | alexia-hub tests/v2_plugins | merged | 2 | cr3studioo/v3-P0-15 | |
| P0-16 | CI: v3 workflow, invariant script | P0 | sonnet | P0-15 | .github/workflows/v3.yml, v3/ci | merged | 2 | cr3studioo/v3-P0-16 |  |
| P0-17 | Purge and settings parity follow-ups | P0 | opus | P0-13 | alexia-mcp host/serve, tests/purge, tests/alexia_layer | merged | 1 | cr3studioo/v3-P0-17 | |
| P0-18 | De-flake idle_lazy_plugin_stops | P0 | sonnet | P0-12 | alexia-mcp tests/supervise.rs | merged | 1 | cr3studioo/v3-P0-18 | |
| P1-01 | Core shared types, module stubs, P1 dependencies | P1 | opus | P0-15 | v3/Cargo.toml, v3/Cargo.lock, v3/specs/INTERFACES.md, ale... | merged | 1 | cr3studioo/v3-P1-01 | |
| P1-02 | Gateway types, gateway and hub stubs | P1 | opus | P1-01 | alexia-gateway/{Cargo.toml, src/lib.rs, src/channel.rs, s... | merged | 2 | cr3studioo/v3-P1-02 |  |
| P1-03 | Store: migration 2, channel chats, spans, tries_since, env secrets | P1 | opus | P0-07 | alexia-store/{src/lib.rs, src/types.rs, src/db.rs, src/mi... | merged | 1 | cr3studioo/v3-P1-03 | |
| P1-04 | OpenAI-compatible provider and v2's free ladder | P1 | opus | P1-01 | alexia-core/{src/openai.rs, src/free.rs, tests/openai.rs} | merged | 2 | cr3studioo/v3-P1-04 |  |
| P1-05 | Free chat catalog | P1 | opus | P1-04 | alexia-core/{src/catalog.rs, tests/catalog.rs} | merged | 3 | cr3studioo/v3-P1-05 |  |
| P1-06 | Router::hedged with a latency budget | P1 | opus | P1-05, P1-03 | alexia-core/{src/router.rs, tests/router.rs} | merged | 1 | cr3studioo/v3-P1-06 |  |
| P1-07 | Lane classifier and the Lanes brain | P1 | opus | P1-01 | alexia-core/{src/lane.rs, tests/lane.rs} | merged | 1 | cr3studioo/v3-P1-07 |  |
| P1-08 | FastChat: the chat lane brain | P1 | opus | P1-06, P1-03, P0-13 | alexia-core/{src/chat.rs, tests/chat.rs} | merged | 1 | cr3studioo/v3-P1-08 |  |
| P1-09 | Telegram Bot API client | P1 | opus | P1-02 | alexia-gateway/{src/channels/telegram/api.rs, tests/teleg... | merged | 1 | cr3studioo/v3-P1-09 |  |
| P1-10 | Telegram channel: poll, pairing, offsets, buttons | P1 | opus | P1-09, P1-03 | alexia-gateway/{src/channels/mod.rs, src/channels/telegra... | running | 3 | cr3studioo/v3-P1-10 | fixer ctx_0cbbe5ec941a (review 2: flaky photo, leak, offset) |
| P1-11 | Gateway loop: ack, merge, steer, drafts, spans | P1 | opus | P1-02, P1-03 | alexia-gateway/{src/gateway.rs, tests/gateway.rs} | merged | 2 | cr3studioo/v3-P1-11 |  |
| P1-12 | Approvals and voice notes | P1 | opus | P1-11 | alexia-gateway/{src/ask.rs, src/voice.rs, tests/ask_voice... | merged | 1 | cr3studioo/v3-P1-12 |  |
| P1-13 | V2Bridge: v2 core as the task lane | P1 | opus | P1-02, P1-03 | alexia-hub/src/bridge.rs | merged | 2 | cr3studioo/v3-P1-13 |  |
| P1-14 | v2: parallel tool calls | P1 | opus | none | packages/core/src/agent.ts, packages/core/test/agent.test.ts | merged | 1 | cr3studioo/v3-P1-14 | |
| P1-15 | Latency dashboard | P1 | sonnet | P1-02, P1-03 | alexia-hub/src/latency.rs | merged | 2 | cr3studioo/v3-P1-15 |  |
| P1-16 | Hub watchdog | P1 | sonnet | P1-02 | alexia-hub/src/watchdog.rs | merged | 1 | cr3studioo/v3-P1-16 | |
| P1-17 | Hub wiring and CLI | P1 | sonnet | P1-07, P1-08, P1-10, P1-12, P1-13, P1-15, P1-16 | alexia-hub/{Cargo.toml, src/main.rs, src/media.rs, tests/... | todo | 0 | | |
| P1-18 | End-to-end latency test and the 50-message run | P1 | sonnet | P1-17, P1-26 | alexia-hub/tests/telegram_e2e.rs, v3/ops/reports/P1-laten... | todo | 0 | | |
| P0-19 | Host display name and unwritten tables | P0 | opus | P0-13 | alexia-mcp lib.rs, tests/alexia_layer; alexia-store namespace | merged | 2 | cr3studioo/v3-P0-19 | |
| P0-20 | De-flake idle_lazy_plugin_stops, round 2 | P0 | sonnet | P0-18 | alexia-mcp tests/supervise.rs | merged | 1 | cr3studioo/v3-P0-20 | |
| P0-21 | Purge keeps going when one step fails | P0 | sonnet | P0-17 | alexia-store secrets, alexia-mcp host purge, tests/purge | merged | 1 | cr3studioo/v3-P0-21 | |
| P0-22 | Close idle-stop vs incoming-call race | P0 | opus | P0-21 | alexia-mcp host, supervise, tests/supervise | merged | 1 | cr3studioo/v3-P0-22 |  |
| P0-23 | v2 conformance: real junction assert, temp cleanup | P0 | sonnet | P0-15 | alexia-hub tests/v2_plugins | merged | 2 | cr3studioo/v3-P0-23 | |
| P0-24 | invariants.mjs: out-of-line test mod, header | P0 | sonnet | P0-16 | v3/ci/invariants.mjs | merged | 1 | cr3studioo/v3-P0-24 | |
| P0-25 | One plugin-id rule | P0 | sonnet | P0-21, P0-22 | alexia-store lib/namespace/secrets/import, alexia-mcp manifest/host, alexia-hub main | merged | 1 | cr3studioo/v3-P0-25 |  |
| P1-19 | Watchdog hardening | P1 | sonnet | P1-16 | alexia-hub/src/watchdog.rs | merged | 1 | cr3studioo/v3-P1-19 | |
| P1-20 | Hub: latency offsets and hidden console | P1 | sonnet | none | alexia-hub/src/{latency.rs, watchdog.rs}, INTERFACES.md | merged | 1 | cr3studioo/v3-P1-20 |  |
| P1-21 | Telegram api: file transfers and retry_after | P1 | sonnet | none | alexia-gateway telegram/api.rs, tests/telegram_api.rs | merged | 1 | cr3studioo/v3-P1-21 |  |
| P1-22 | Core: tool rows on the wire, catalog temp file | P1 | sonnet | none | alexia-core openai.rs, catalog.rs, tests | merged | 1 | cr3studioo/v3-P1-22 |  |
| P1-23 | Gateway: spawned tasks on the tracker | P1 | opus | none | alexia-gateway/{src/gateway.rs, tests/gateway.rs} | running | 1 | cr3studioo/v3-P1-23 | ctx_b62926f71720 |
| P1-24 | v2 agent: dangling tool ids at the ceiling | P1 | sonnet | none | packages/core/src/agent.ts, test/agent.test.ts | merged | 1 | cr3studioo/v3-P1-24 |  |
| P1-25 | One time helper | P1 | sonnet | P1-20, P1-22, P1-23, P1-17, P0-25 | alexia-store types/db/import, core catalog, gateway, hub watchdog/latency/main, INTERFACES.md | todo | 0 | | |
| P0-26 | De-flake junk_is_skipped_and_logged | P0 | sonnet | none | alexia-mcp tests/conn.rs | merged | 1 | cr3studioo/v3-P0-26 |  |
| P1-26 | Documents to task lane; no empty turns; bounded fetches | P1 | opus | P1-07, P1-17, P1-23 | core brain/lane/chat+tests, gateway channel/gateway+test, hub bridge/Cargo.toml, INTERFACES.md | todo | 0 | | run after or before P1-25, not alongside |
| P1-27 | De-flake call_at_idle_deadline_never_gone | P1 | sonnet | none | alexia-mcp tests/supervise.rs | running | 1 | cr3studioo/v3-P1-27 | |
