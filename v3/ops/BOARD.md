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
| P0-15 | v2 plugins conformance test | P0 | sonnet | P0-14, P0-19 | alexia-hub tests/v2_plugins | todo | 1 | cr3studioo/v3-P0-15 | waits P0-19; branch kept, rerun listing test after |
| P0-16 | CI: v3 workflow, invariant script | P0 | sonnet | P0-15 | .github/workflows/v3.yml, v3/ci | todo | 0 | | Builder prompt must lift workflow rule for v3.yml only |
| P0-17 | Purge and settings parity follow-ups | P0 | opus | P0-13 | alexia-mcp host/serve, tests/purge, tests/alexia_layer | merged | 1 | cr3studioo/v3-P0-17 | |
| P0-18 | De-flake idle_lazy_plugin_stops | P0 | sonnet | P0-12 | alexia-mcp tests/supervise.rs | merged | 1 | cr3studioo/v3-P0-18 | |
| P1-01 | Core shared types, module stubs, P1 dependencies | P1 | opus | P0-15 | v3/Cargo.toml, v3/Cargo.lock, v3/specs/INTERFACES.md, ale... | todo | 0 | | |
| P1-02 | Gateway types, gateway and hub stubs | P1 | opus | P1-01 | alexia-gateway/{Cargo.toml, src/lib.rs, src/channel.rs, s... | todo | 0 | | |
| P1-03 | Store: migration 2, channel chats, spans, tries_since, env secrets | P1 | opus | P0-07 | alexia-store/{src/lib.rs, src/types.rs, src/db.rs, src/mi... | merged | 1 | cr3studioo/v3-P1-03 | |
| P1-04 | OpenAI-compatible provider and v2's free ladder | P1 | opus | P1-01 | alexia-core/{src/openai.rs, src/free.rs, tests/openai.rs} | todo | 0 | | |
| P1-05 | Free chat catalog | P1 | opus | P1-04 | alexia-core/{src/catalog.rs, tests/catalog.rs} | todo | 0 | | |
| P1-06 | Router::hedged with a latency budget | P1 | opus | P1-05, P1-03 | alexia-core/{src/router.rs, tests/router.rs} | todo | 0 | | |
| P1-07 | Lane classifier and the Lanes brain | P1 | opus | P1-01 | alexia-core/{src/lane.rs, tests/lane.rs} | todo | 0 | | |
| P1-08 | FastChat: the chat lane brain | P1 | opus | P1-06, P1-03, P0-13 | alexia-core/{src/chat.rs, tests/chat.rs} | todo | 0 | | |
| P1-09 | Telegram Bot API client | P1 | opus | P1-02 | alexia-gateway/{src/channels/telegram/api.rs, tests/teleg... | todo | 0 | | |
| P1-10 | Telegram channel: poll, pairing, offsets, buttons | P1 | opus | P1-09, P1-03 | alexia-gateway/{src/channels/mod.rs, src/channels/telegra... | todo | 0 | | |
| P1-11 | Gateway loop: ack, merge, steer, drafts, spans | P1 | opus | P1-02, P1-03 | alexia-gateway/{src/gateway.rs, tests/gateway.rs} | todo | 0 | | |
| P1-12 | Approvals and voice notes | P1 | opus | P1-11 | alexia-gateway/{src/ask.rs, src/voice.rs, tests/ask_voice... | todo | 0 | | |
| P1-13 | V2Bridge: v2 core as the task lane | P1 | opus | P1-02, P1-03 | alexia-hub/src/bridge.rs | todo | 0 | | |
| P1-14 | v2: parallel tool calls | P1 | opus | none | packages/core/src/agent.ts, packages/core/test/agent.test.ts | merged | 1 | cr3studioo/v3-P1-14 | |
| P1-15 | Latency dashboard | P1 | sonnet | P1-02, P1-03 | alexia-hub/src/latency.rs | todo | 0 | | |
| P1-16 | Hub watchdog | P1 | sonnet | P1-02 | alexia-hub/src/watchdog.rs | todo | 0 | | |
| P1-17 | Hub wiring and CLI | P1 | sonnet | P1-07, P1-08, P1-10, P1-12, P1-13, P1-15, P1-16 | alexia-hub/{Cargo.toml, src/main.rs, src/media.rs, tests/... | todo | 0 | | |
| P1-18 | End-to-end latency test and the 50-message run | P1 | sonnet | P1-17 | alexia-hub/tests/telegram_e2e.rs, v3/ops/reports/P1-laten... | todo | 0 | | |
| P0-19 | Host display name and unwritten tables | P0 | opus | P0-13 | alexia-mcp lib.rs, tests/alexia_layer; alexia-store namespace | running | 2 | cr3studioo/v3-P0-19 | fix ctx_f9c4f514203f (check_ident on unwritten) |
