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
| P1-10 | Telegram channel: poll, pairing, offsets, buttons | P1 | opus | P1-09, P1-03 | alexia-gateway/{src/channels/mod.rs, src/channels/telegra... | merged | 3 | cr3studioo/v3-P1-10 |  |
| P1-11 | Gateway loop: ack, merge, steer, drafts, spans | P1 | opus | P1-02, P1-03 | alexia-gateway/{src/gateway.rs, tests/gateway.rs} | merged | 2 | cr3studioo/v3-P1-11 |  |
| P1-12 | Approvals and voice notes | P1 | opus | P1-11 | alexia-gateway/{src/ask.rs, src/voice.rs, tests/ask_voice... | merged | 1 | cr3studioo/v3-P1-12 |  |
| P1-13 | V2Bridge: v2 core as the task lane | P1 | opus | P1-02, P1-03 | alexia-hub/src/bridge.rs | merged | 2 | cr3studioo/v3-P1-13 |  |
| P1-14 | v2: parallel tool calls | P1 | opus | none | packages/core/src/agent.ts, packages/core/test/agent.test.ts | merged | 1 | cr3studioo/v3-P1-14 | |
| P1-15 | Latency dashboard | P1 | sonnet | P1-02, P1-03 | alexia-hub/src/latency.rs | merged | 2 | cr3studioo/v3-P1-15 |  |
| P1-16 | Hub watchdog | P1 | sonnet | P1-02 | alexia-hub/src/watchdog.rs | merged | 1 | cr3studioo/v3-P1-16 | |
| P1-17 | Hub wiring and CLI | P1 | sonnet | P1-07, P1-08, P1-10, P1-12, P1-13, P1-15, P1-16, P1-25 | v3/Cargo.toml, hub Cargo.toml/main.rs/media.rs/tests/cli_p1.rs, Cargo.lock | merged | 1 | cr3studioo/v3-P1-17 |  |
| P1-18 | End-to-end latency test | P1 | sonnet | P1-17, P1-26 | alexia-hub/tests/telegram_e2e.rs | merged | 2 | cr3studioo/v3-P1-18 | |
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
| P1-23 | Gateway: spawned tasks on the tracker | P1 | opus | none | alexia-gateway/{src/gateway.rs, tests/gateway.rs} | merged | 1 | cr3studioo/v3-P1-23 |  |
| P1-24 | v2 agent: dangling tool ids at the ceiling | P1 | sonnet | none | packages/core/src/agent.ts, test/agent.test.ts | merged | 1 | cr3studioo/v3-P1-24 |  |
| P1-25 | One time helper; brain spans measured from the turn | P1 | opus | P1-20, P1-22, P1-23, P0-25 | store types/db/import, core lib/catalog/router/lane/chat+tests, gateway.rs, hub bridge/watchdog/latency, INTERFACES | merged | 1 | cr3studioo/v3-P1-25 |  |
| P0-26 | De-flake junk_is_skipped_and_logged | P0 | sonnet | none | alexia-mcp tests/conn.rs | merged | 1 | cr3studioo/v3-P0-26 |  |
| P1-26 | Documents to task lane; no empty turns; bounded fetches | P1 | opus | P1-07, P1-17, P1-23, P1-25 | core brain/lane/chat+tests, gateway channel/gateway+test, hub bridge/Cargo.toml, INTERFACES.md | merged | 1 | cr3studioo/v3-P1-26 | |
| P1-27 | De-flake call_at_idle_deadline_never_gone | P1 | sonnet | none | alexia-mcp tests/supervise.rs | merged | 1 | cr3studioo/v3-P1-27 |  |
| P1-28 | Telegram stays inside the gateway; one base64 | P1 | sonnet | P1-10, P1-17 | ci/invariants.mjs, gateway Cargo.toml + telegram/mod.rs, Cargo.lock | merged | 1 | cr3studioo/v3-P1-28 | |
| P1-29 | Telegram: finish only what was delivered; pairing closes once paired | P1 | opus | P1-28 | gateway telegram/mod.rs, tests/telegram_channel.rs | merged | 1 | cr3studioo/v3-P1-29 | |
| P1-30 | Approvals: test the 10-minute give-up and scheduled jobs | P1 | sonnet | P1-28 | gateway Cargo.toml, tests/ask_voice.rs | merged | 1 | cr3studioo/v3-P1-30 | |
| P1-31 | v2 agent: dangling tool ids on a stop | P1 | sonnet | none | packages/core/src/agent.ts, test/agent.test.ts | merged | 1 | cr3studioo/v3-P1-31 | |
| P1-32 | Hub run: clean stop on every exit, Ctrl+C wins, boot prune | P1 | sonnet | none | alexia-hub src/main.rs, tests/cli_p1.rs | merged | 1 | cr3studioo/v3-P1-32 | |
| P1-33 | The 50-real-message latency run | P1 | sonnet | P1-18 | v3/ops/reports/P1-latency.md | merged | 1 | cr3studioo/v3 | owner waived 50; 3 real msgs, ack max 86 ms |
| P1-34 | secret import-v2: copy v2 secrets into v3, once | P1 | opus | none | store secrets.rs+tests/v2_secrets.rs, gateway channels/mod.rs, hub main.rs, INTERFACES.md | merged | 1 | cr3studioo/v3-P1-34 | owner runs import once |
| P1-35 | Time the bridge's save; synchronous = NORMAL in WAL | P1 | opus | none | hub bridge.rs, store db.rs | merged | 1 | cr3studioo/v3-P1-35 | |
| P2-01 | Core P2 types, module stubs, dependencies, INTERFACES.md | P2 | opus | P1-18 | v3/Cargo.toml, v3/Cargo.lock, v3/specs/INTERFACES.md, alexia-core/{Cargo.toml, src/lib.... | merged | 1 | cr3studioo/v3-P2-01 | |
| P2-02 | MCP host P2 interfaces: host calls, reviewed, wasm stub | P2 | sonnet | P2-01 | v3/Cargo.lock, v3/specs/INTERFACES.md, alexia-mcp/{Cargo.toml, src/lib.rs, src/wasm.rs ... | merged | 1 | cr3studioo/v3-P2-02 | P2-22: lock+fail-open notes |
| P2-03 | Store: migration 3 (audit, live runs, approvals, jobs) | P2 | opus | none | alexia-store/{src/lib.rs, src/types.rs, src/db.rs, src/migrations.rs, tests/p2.rs} | merged | 1 | cr3studioo/v3-P2-03 | |
| P2-04 | Tools on the OpenAI-compatible wire | P2 | sonnet | P2-01 | alexia-core/{src/openai.rs, tests/openai.rs} | merged | 1 | cr3studioo/v3-P2-04 | |
| P2-05 | Candidates know tools, vision and context; rank by what a re | P2 | sonnet | P2-01 | alexia-core/{src/catalog.rs, src/router.rs, tests/router.rs, tests/catalog.rs} | merged | 1 | cr3studioo/v3-P2-05 | |
| P2-06 | The asker exists before the gateway | P2 | sonnet | P2-01 | alexia-gateway/{src/lib.rs, src/gateway.rs, src/ask.rs, tests/gateway.rs, tests/ask_voi... | merged | 1 | cr3studioo/v3-P2-06 | |
| P2-07 | Steering into a running run | P2 | sonnet | P2-06 | alexia-core/{src/brain.rs, tests/types.rs, tests/chat.rs, tests/lane.rs}, alexia-gatewa... | merged | 2 | cr3studioo/v3-P2-07 | |
| P2-08 | Media takes a cancel token | P2 | sonnet | P2-07 | alexia-gateway/{src/channel.rs, src/voice.rs, src/gateway.rs, tests/ask_voice.rs}, alex... | merged | 1 | cr3studioo/v3-P2-08 | (see LOG) |
| P2-09 | Hub: dead code and stale allow(dead_code) | P2 | sonnet | none | alexia-hub/src/{latency.rs, watchdog.rs} | merged | 1 | cr3studioo/v3-P2-09 | stale comments watchdog.rs:2,4 |
| P2-10 | Secrets: no echo, read errors kept, in-memory only for tests | P2 | sonnet | none | alexia-store/{src/secrets.rs, tests/secrets.rs, tests/v2_secrets.rs}, alexia-hub/{src/m... | merged | 1 | cr3studioo/v3-P2-10 | |
| P2-11 | Channels exception narrowed to service names | P2 | sonnet | P2-01 | v3/ci/invariants.mjs, alexia-gateway/src/channels/mod.rs | merged | 2 | cr3studioo/v3-P2-11 | INTERFACES.md row needs bot-api marker |
| P2-12 | Permission modes, scope, never-touch, spoken boundaries | P2 | opus | P2-01 | alexia-core/{src/permissions.rs, tests/permissions.rs} | merged | 3 | cr3studioo/v3-P2-12 | follow-up P2-42 |
| P2-13 | The safety checker | P2 | opus | P2-01 | alexia-core/{src/checker.rs, tests/checker.rs} | merged | 1 | cr3studioo/v3-P2-13 | |
| P2-14 | Redaction before cloud | P2 | sonnet | P2-01 | alexia-core/{src/redact.rs, tests/redact.rs} | merged | 3 | cr3studioo/v3-P2-14 | |
| P2-15 | Trimming the step trace | P2 | sonnet | P2-01 | alexia-core/{src/trim.rs, tests/trim.rs} | merged | 2 | cr3studioo/v3-P2-15 | |
| P2-16 | System prompt, skills, injection guard | P2 | sonnet | P2-01 | alexia-core/{src/prompt.rs, tests/prompt.rs} | merged | 1 | cr3studioo/v3-P2-16 | |
| P2-17 | Router for task steps: model per job, $0 cap, catalog news | P2 | sonnet | P2-04, P2-05, P2-14 | alexia-core/{src/router.rs, src/catalog.rs, tests/router_steps.rs} | merged | 1 | cr3studioo/v3-P2-17 | ctx_c4932a2b7e3b |
| P2-18 | Tooling over the MCP host | P2 | sonnet | P2-02 | alexia-core/{src/tools.rs, tests/tools.rs} | merged | 2 | cr3studioo/v3-P2-18 | follow-up P2-50 |
| P2-19 | Trace, runs and the audit log | P2 | sonnet | P2-01, P2-03, P2-14 | alexia-core/{src/trace.rs, tests/trace.rs} | merged | 2 | cr3studioo/v3-P2-19 | |
| P2-20 | The agent loop | P2 | opus | P2-07, P2-12, P2-13, P2-14, P2-15, P2-16, P2-17, P2-18, P2-19, P2-45, P2-59 | alexia-core/{src/agent.rs, tests/agent.rs} | merged | 1 | cr3studioo/v3-P2-20 | |
| P2-21 | Upcalls: sampling, tasks for plugins, elicit, roots, attachm | P2 | sonnet | P2-20, P2-02, P2-72 | alexia-core/{src/upcalls.rs, tests/upcalls.rs} | merged | 2 | cr3studioo/v3-P2-21 | |
| P2-22 | MCP: compute/run locally, host-answered capabilities | P2 | sonnet | P2-02 | alexia-mcp/{src/serve.rs, src/host.rs, src/bin/mcp-fixture.rs, tests/compute.rs} | merged | 1 | cr3studioo/v3-P2-22 | follow-up P2-44 |
| P2-23 | Hot reload of plugins | P2 | sonnet | P2-22 | alexia-mcp/{src/host.rs, src/supervise.rs, tests/reload.rs} | merged | 1 | cr3studioo/v3-P2-23 | |
| P2-24 | WASM plugins in a capability sandbox | P2 | sonnet | P2-23, P2-47 | alexia-mcp/{src/wasm.rs, src/host.rs, fixtures/wasm-hello/**, tests/fixtures/wasm-hello... | merged | 1 | cr3studioo/v3-P2-24 | rust-version 1.87 follow-up |
| P2-25 | Commands | P2 | sonnet | P2-20, P2-45, P2-72, P2-36 | alexia-core/{src/commands.rs, tests/commands.rs} | merged | 3 | cr3studioo/v3-P2-25 | |
| P2-26 | Resume after restart; jobs that run for days | P2 | sonnet | P2-20, P2-72 | alexia-core/{src/resume.rs, tests/resume.rs} | merged | 1 | cr3studioo/v3-P2-26 | |
| P2-27 | Parallel helpers | P2 | sonnet | P2-20, P2-72 | alexia-core/{src/helpers.rs, tests/helpers.rs} | merged | 2 | cr3studioo/v3-P2-27 | |
| P2-28 | Undo | P2 | sonnet | P2-20, P2-72 | alexia-core/{src/undo.rs, tests/undo.rs} | merged | 1 | cr3studioo/v3-P2-28 | |
| P2-29 | Approvals inbox | P2 | sonnet | P2-03, P2-06, P2-08 | alexia-gateway/{src/ask.rs, tests/approvals.rs} | merged | 1 | cr3studioo/v3-P2-29 | ctx_fbfeef8c3b31 |
| P2-30 | Scheduled jobs | P2 | sonnet | P2-01, P2-03 | alexia-scheduler/{Cargo.toml, src/lib.rs, tests/scheduler.rs}, v3/Cargo.lock | merged | 2 | cr3studioo/v3-P2-30 | |
| P2-31 | Managed llama.cpp, speculative decoding | P2 | sonnet | P2-01 | alexia-core/{src/local.rs, tests/local.rs} | merged | 3 | cr3studioo/v3-P2-31 | |
| P2-32 | GPU: fit, load cap, steps aside for games | P2 | sonnet | P2-01 | alexia-core/{src/gpu.rs, tests/gpu.rs} | merged | 1 | cr3studioo/v3-P2-32 | |
| P2-33 | Hugging Face import and GGUF split files | P2 | sonnet | P2-01 | alexia-core/{src/hf.rs, tests/hf.rs} | merged | 2 | cr3studioo/v3-P2-33 | |
| P2-34 | Local vision, local embeddings, the local checker model | P2 | sonnet | P2-31, P2-32, P2-33, P2-21 | alexia-core/{src/local.rs, src/upcalls.rs, tests/local_jobs.rs} | merged | 1 | cr3studioo/v3-P2-34 | |
| P2-35 | Subscriptions through their official CLIs | P2 | sonnet | P2-17 | alexia-core/{src/subscription.rs, tests/subscription.rs} | merged | 1 | cr3studioo/v3-P2-35 | |
| P2-36 | Compare two models | P2 | sonnet | P2-17 | alexia-core/{src/compare.rs, tests/compare.rs} | merged | 4 | cr3studioo/v3-P2-36 | |
| P2-37 | Encrypted database at rest | P2 | opus | P2-02, P2-03, P2-10 | v3/Cargo.toml, v3/Cargo.lock, alexia-store/{Cargo.toml, src/db.rs, src/encrypt.rs, src/... | merged | 1 | cr3studioo/v3-P2-37 | crash-recovery follow-up (review) |
| P2-38 | Hub wiring: Agent is the brain, bridge deleted | P2 | opus | P2-08..P2-11, P2-20..P2-37, P2-42, P2-44, P2-45, P2-46, P2-47, P2-50, P2-60, P2-62, P2-73, P2-74 | alexia-hub/{Cargo.toml, src/main.rs, src/bridge.rs (delete), src/media.rs, tests/cli_p2... | merged | 1 | cr3studioo/v3-P2-38 | |
| P2-39 | End-to-end: the agent on the real binary | P2 | sonnet | P2-38, P2-43 | alexia-hub/tests/{agent_e2e.rs, telegram_e2e.rs, common/mod.rs} | merged | 1 | cr3studioo/v3-P2-39 | |
| P2-40 | Every v2 plugin on the Rust host | P2 | sonnet | P2-38 | alexia-hub/tests/v2_plugins.rs | merged | 1 | cr3studioo/v3-P2-40 | |
| P2-41 | Twenty real tasks on the PC | P2 | sonnet | P2-39, P2-40, P2-48 | v3/ops/reports/P2-tasks.md | dropped | 0 | | owner waived (A-19); P2D verifies on the real app |
| P2-42 | Permissions fail closed: trailing dots, bad boundary entries | P2 | sonnet | P2-12 | alexia-core/{src/permissions.rs, tests/permissions.rs} | merged | 1 | cr3studioo/v3-P2-42 | |
| P2-43 | telegram_e2e ack check survives a loaded machine | P2 | sonnet | none | alexia-hub/{tests/telegram_e2e.rs, src/latency.rs} | merged | 3 | cr3studioo/v3-P2-43 | |
| P2-44 | compute/run: checked path used; copies no collide/leak | P2 | sonnet | P2-22 | alexia-mcp/{src/serve.rs, tests/compute.rs} | merged | 1 | cr3studioo/v3-P2-44 | |
| P2-45 | McpHost::manifests, the agent's source of plugin commands and skills | P2 | sonnet | P2-23 | alexia-mcp/{src/host.rs, tests/manifests.rs} | merged | 1 | cr3studioo/v3-P2-45 | |
| P2-46 | Permissions fail closed: kv read errors, unannotated deletes, ~ and file:// paths | P2 | opus | P2-42 | alexia-core/{src/permissions.rs, tests/permissions.rs} | merged | 1 | cr3studioo/v3-P2-46 | FILE:// uppercase follow-up |
| P2-47 | MCP: plugin requests keep cancel and progress; tools unreviewed until read | P2 | opus | P2-45 | alexia-mcp/{src/conn.rs, src/host.rs, src/serve.rs, src/bin/mcp-fixture.rs, tests/conn.rs, tests/compute.rs} | merged | 1 | cr3studioo/v3-P2-47 | |
| P2-48 | Hub: the P2 CLI verbs | P2 | opus | P2-38 | alexia-hub/{src/main.rs, tests/cli_p2.rs} | merged | 1 | cr3studioo/v3-P2-48 | |
| P2-49 | Small cleanups: trim's helpers private, one now_ms | P2 | sonnet | none | alexia-core/{src/trim.rs, tests/trim.rs}, alexia-gateway/src/channels/telegram/mod.rs | merged | 1 | cr3studioo/v3-P2-49 | |
| P2-50 | Tooling: no UNC paths from file URIs; call() applies list() limits | P2 | sonnet | P2-18 | alexia-core/{src/tools.rs, tests/tools.rs} | merged | 1 | cr3studioo/v3-P2-50 | |
| P2-51 | Core safety edges: odd file URIs, skill symlinks, secret JSON keys | P2 | opus | none | alexia-core/{permissions,prompt,redact}+tests, INTERFACES.md | merged | 1 | cr3studioo/v3-P2-51 | ctx_32aa086e89a4 |
| P2-52 | rust-version 1.87 | P2 | sonnet | none | v3/Cargo.toml | merged | 1 | cr3studioo/v3-P2-52 | ctx_c2bdcdb7adbf |
| P2-53 | OpenAI wire: unanswered calls, odd deltas, nameless calls | P2 | sonnet | none | alexia-core/{src/openai.rs, tests/openai.rs} | merged | 1 | cr3studioo/v3-P2-53 | ctx_933217f350f0 |
| P2-54 | Store: encryption crash-safe, no keychain in tests; resume start | P2 | opus | P2-51 | alexia-store/{encrypt,db,tests}, alexia-core/{trace}+tests, INTERFACES.md | merged | 1 | cr3studioo/v3-P2-54 | |
| P2-55 | MCP: early cancel reaches request; WASM compile off runtime | P2 | opus | P2-52 | alexia-mcp/{conn,wasm,host}+tests | merged | 1 | cr3studioo/v3-P2-55 | |
| P2-56 | Scheduler: one-shot survives shutdown; Every no overlap | P2 | opus | none | alexia-scheduler/{src/lib.rs, tests/scheduler.rs} | merged | 1 | cr3studioo/v3-P2-56 | |
| P2-57 | Local models: hf hashing/cache/paths; GPU parsing | P2 | sonnet | none | alexia-core/{hf,gpu}+tests | merged | 1 | cr3studioo/v3-P2-57 | ctx_905ac878e85b |
| P2-58 | Gateway: file message not overtaken by steers | P2 | sonnet | P2-38 | alexia-gateway/{src/gateway.rs, tests/gateway.rs} | deferred | 0 | | after P2 (CEO: finish faster) |
| P2-59 | Chat lane redacted: hedged redacts every cloud request | P2 | opus | P2-17 | alexia-core/{router.rs, tests/router.rs, router_steps.rs, chat.rs} | merged | 1 | cr3studioo/v3-P2-59 | ctx_ede66379757c |
| P2-60 | Scheduler tools hold Weak<Scheduler>; no wiring cycle | P2 | opus | P2-56 | alexia-scheduler/{src/lib.rs, tests/scheduler.rs} | merged | 1 | cr3studioo/v3-P2-60 | |
| P2-61 | One file URI decoder; no network paths; undo stays in plugin | P2 | opus | P2-51 | alexia-mcp/{uri,lib,serve}+tests, alexia-core/{permissions,tools}+tests | merged | 2 | cr3studioo/v3-P2-61 | |
| P2-62 | New plugins unreviewed; GPU watcher hands hub what it needs | P2 | opus | P2-55, P2-57 | alexia-mcp/{host,supervise,tests/hold.rs}, alexia-core/{gpu}+tests | merged | 2 | cr3studioo/v3-P2-62 | |
| P2-63 | One redaction of secrets, in alexia-mcp | P2 | opus | P2-38, P2-61 | alexia-mcp/{Cargo.toml,redact,process,lib}+tests, Cargo.lock, alexia-core/redact | deferred | 0 | | after P2 (CEO: finish faster) |
| P2-64 | One Job Object, scheduled approvals own chat, stricter name check | P2 | sonnet | P2-38, P2-63 | alexia-mcp/lib.rs, alexia-core/local.rs, gateway/{ask.rs,approvals}, ci/invariants.mjs | deferred | 0 | | after P2 (CEO: finish faster) |
| P2-65 | Store: test dirs cleaned, keychain probe per process, plain kept | P2 | opus | P2-54 | alexia-store/{tests/*, src/secrets.rs, src/encrypt.rs} | merged | 1 | cr3studioo/v3-P2-65 | |
| P2-66 | MCP: test folders cleaned up | P2 | sonnet | P2-55, P2-61 | alexia-mcp/tests/{scratch,alexia_layer,compute,host,manifest(s),purge,reload,supervise,types_p2,wasm}.rs | merged | 1 | cr3studioo/v3-P2-66 | |
| P2-67 | Core: test dirs cleaned; registry export unique per call | P2 | opus | P2-61, P2-62 | alexia-core/{tests/*, src/gpu.rs} | merged | 1 | cr3studioo/v3-P2-67 | |
| P2-68 | Router: notes per run, keychain cached, bad pins said | P2 | opus | P2-20 | alexia-core/{src/router.rs, tests/router_steps.rs, src/agent.rs} | merged | 1 | cr3studioo/v3-P2-68 | |
| P2-69 | OpenAI wire: blank text empty; answered by next tool turns | P2 | sonnet | none | alexia-core/{src/openai.rs, tests/openai.rs} | merged | 1 | cr3studioo/v3-P2-69 | |
| P2-70 | Gateway: unsent question not a denial; test dirs cleaned | P2 | opus | P2-58, P2-64 | alexia-gateway/{src/ask.rs, tests/*} | deferred | 0 | | after P2 (CEO: finish faster) |
| P2-71 | Hub and MCP conn tests: test folders cleaned up | P2 | sonnet | P2-39, P2-48, P2-63, P2-66 | alexia-hub/{tests/*, src/media.rs}, alexia-mcp/tests/conn.rs | deferred | 0 | | after P2 (CEO: finish faster) |
| P2-72 | Agent exposes its parts | P2 | sonnet | P2-20 | alexia-core/{src/agent.rs, tests/agent.rs} | merged | 1 | cr3studioo/v3-P2-72 | |
| P2-73 | Agent: slash commands only from the owner's chat; attached f | P2 | opus | P2-21, P2-25, P2-68 | alexia-core/{src/agent.rs, tests/agent.rs, src/commands.rs, tests/commands.rs} | merged | 1 | cr3studioo/v3-P2-73 | |
| P2-74 | Scheduler: no slash-command prompts; only a shutdown keeps a | P2 | opus | none | alexia-scheduler/{src/lib.rs, tests/scheduler.rs} | merged | 1 | cr3studioo/v3-P2-74 | |
| P2-75 | Agent loop edges: a stop mid-gate is recorded, the asked mod | P2 | opus | P2-73, P2-27 | alexia-core/{src/agent.rs, tests/agent.rs} | deferred | 0 | | after P2 (CEO: finish faster) |
| P2-76 | One permission gate: undo and plugin commands go through the | P2 | opus | P2-75, P2-77, P2-25, P2-28 | alexia-core/{src/agent.rs, tests/agent.rs, src/undo.rs, tests/undo.rs, src/commands.rs, te | deferred | 0 | | after P2 (CEO: finish faster) |
| P2-77 | Router: a local job never leaves the computer; compare redac | P2 | opus | P2-68, P2-73 | alexia-core/{src/router.rs, tests/router_steps.rs, src/compare.rs, tests/compare.rs, src/c | deferred | 0 | | after P2 (CEO: finish faster) |
| P2-78 | Tooling: a plugin's file link is sent only from where the pl | P2 | opus | P2-67 | alexia-core/{src/tools.rs, tests/tools.rs} | deferred | 0 | | after P2 (CEO: finish faster) |
| P2-79 | Subscriptions: a clean environment, no Codex shell on tool o | P2 | opus | none | alexia-core/{src/subscription.rs, tests/subscription.rs} | merged | 2 | cr3studioo/v3-P2-79 | |
| P2-80 | Resume: a live job's age counts from its last step; every en | P2 | sonnet | none | alexia-core/{src/resume.rs, tests/resume.rs} | merged | 1 | cr3studioo/v3-P2-80 | |
| P2-81 | Say goes to its run's chat and carries the run's files | P2 | sonnet | P2-48, P2-70, P2-74, P2-80 | alexia-core/{src/bus.rs, src/resume.rs, tests/resume.rs}, alexia-scheduler/{src/lib.rs, te | deferred | 0 | | after P2 (CEO: finish faster) |
| P2-82 | MCP: a WASM start that is given up on stops the module; comp | P2 | opus | P2-66 | alexia-mcp/{src/wasm.rs, tests/wasm.rs, src/serve.rs, tests/compute.rs} | merged | 1 | cr3studioo/v3-P2-82 | |
| P2D-01 | alexia-api: server, gate, static shell, hub wiring | P2D | opus | P2-39 | alexia-api/**, alexia-hub/{main.rs,tests/window.rs}, INTERFACES.md, invariants.mjs | merged | 1 | cr3studioo/v3-P2D-01 | |
| P2D-02 | Contract: record v2 answers, replay against hub | P2D | sonnet | P2D-01 | alexia-hub/{tools/record-v2.mjs,tests/contract*} | merged | 1 | cr3studioo/v3-P2D-02 | |
| P2D-03 | Core seam: window origin, progress, step frames, asker | P2D | opus | none | alexia-core/**, alexia-gateway/{lib,ask,gateway}, alexia-scheduler/lib | merged | 1 | cr3studioo/v3-P2D-03 | |
| P2D-04 | State, setup and settings | P2D | opus | P2D-02 | alexia-api/{state.rs,tests/state.rs} | merged | 1 | cr3studioo/v3-P2D-04 | |
| P2D-05 | Chat in the window: stream, stop, approve, commands, files | P2D | opus | P2D-02, P2D-03 | alexia-api/{chat,offers}, alexia-hub/main.rs | merged | 2 | cr3studioo/v3-P2D-05 | |
| P2D-06 | Plugins screen: panes, settings, trust, install, servers | P2D | opus | P2D-02 | alexia-api/plugins, alexia-mcp/{host.rs,tests/servers.rs} | merged | 2 | cr3studioo/v3-P2D-06 | |
| P2D-07 | Board: tables, actions, learned skills | P2D | opus | P2D-02 | alexia-api/{board,learned} | merged | 1 | cr3studioo/v3-P2D-07 | |
| P2D-08 | Library: plugins and skills from the shelf | P2D | opus | P2D-02, P2D-06 | alexia-api/library | merged | 2 | cr3studioo/v3-P2D-08 | |
| P2D-09 | Local models and local stats | P2D | opus | P2D-02 | alexia-api/local_models, alexia-core/{hf.rs,local.rs} | merged | 1 | cr3studioo/v3-P2D-09 | |
| P2D-10 | Compute screen, no paired computers | P2D | opus | P2D-02 | alexia-api/compute | merged | 1 | cr3studioo/v3-P2D-10 | |
| P2D-11 | Image editor and research viewer | P2D | opus | P2D-02, P2D-03 | alexia-api/{editor,research} | merged | 1 | cr3studioo/v3-P2D-11 | |
| P2D-12 | PC actions proven; hub runs in owner session | P2D | opus | P2D-04, P2D-05, P2D-06 | alexia-hub/{Cargo.toml,watchdog.rs,tests/pc_actions.rs} | merged | 1 | cr3studioo/v3-P2D-12 | |
| P2D-13 | Tauri shell starts or attaches to the hub | P2D | opus | P2D-01 | src-tauri/src/main.rs, scripts/sidecar.mjs | merged | 2 | cr3studioo/v3-P2D-13 | |
| P2D-14 | Coverage and loopback checks | P2D | sonnet | P2D-04..P2D-13 | v3/ci/invariants.mjs, contract/gate.json | merged | 1 | cr3studioo/v3-P2D-14 | |
| P2D-15 | End to end on the real app on this PC | P2D | sonnet | P2D-01..P2D-14 | v3/ops/reports/P2D-e2e.md, p2d-e2e.ps1 | merged | 1 | cr3studioo/v3-P2D-15 | |
| P2D-16 | Computer plugin: real focus, no typing into the wrong window | P2D | opus | none | plugins/computer/{windows.js,index.js,test/windows.test.js} | merged | 1 | cr3studioo/v3-P2D-16 | |
| P2D-17 | Computer plugin: typing guard follows what a plan opens (front(), openApp, UWP, replay) | P2D | opus | P2D-16 | plugins/computer/{windows,index,task,replay,desktop}.js + tests | merged | 1 | cr3studioo/v3-P2D-17 | |
| P2D-18 | Computer plugin: open_url targets the browser only once it is in front | P2D | opus | P2D-17 | plugins/computer/{task,replay,index}.js + tests | merged | 1 | cr3studioo/v3-P2D-18 | |
| P2D-19 | Computer plugin: elements sees the window a turn just opened (pc_actions 5x) | P2D | opus | P2D-18 | plugins/computer/{windows,index}.js + test, pc_actions.rs if racy | merged | 1 | cr3studioo/v3-P2D-19 | |
| P3-00 | P2D carry-over: private sessions atomic, no user name in fixtures (L3, L5) | P3 | opus | none | alexia-store/{src/db.rs, tests/kv_update.rs}, alexia-api/{src/lib.rs, src/private.rs (n... | merged | 1 | cr3studioo/v3-P3-00 | tests weaker than spec; ok |
| P3-01 | P2D carry-over: one home for alexia-api's helpers, stale allows gone (L1, L2) | P3 | sonnet | P3-00 | alexia-api/src/{util.rs (new), lib.rs, json.rs, chat.rs, plugins.rs, offers.rs, gate.rs... | merged | 1 | cr3studioo/v3-P3-01 | CEO removed dead ResearchState |
| P3-02 | INTERFACES and capabilities for P3 | P3 | opus | none | v3/specs/INTERFACES.md, docs/spec/capabilities.md | merged | 1 | cr3studioo/v3-P3-02 | merged by planner, no review |
| P3-03 | Ten plugin skeletons and the lockfile | P3 | sonnet | P3-02 | plugins/{google-account, microsoft-account, day-planner, mail-desk, task-list, page-wat... | merged | 1 | cr3studioo/v3-P3-03 |  |
| P3-04 | Store migration 4 (notices, mutes) and the bus additions | P3 | opus | P3-00, P3-02 | alexia-store/{src/migrations.rs, src/db.rs, src/types.rs, src/lib.rs, tests/notices.rs}... | merged | 2 | cr3studioo/v3-P3-04 | |
| P3-05 | McpHost: call every provider of a capability | P3 | opus | P3-02 | alexia-mcp/{src/host.rs, src/bin/mcp-fixture.rs, tests/fanout.rs} | review | 2 | cr3studioo/v3-P3-05 | review ctx_933ac7197f73 |
| P3-06 | Act silently: the proactive permission rule and the owner's list | P3 | opus | P3-02 | alexia-core/{src/run.rs, src/permissions.rs, src/agent.rs, tests/silent.rs} | ready | 1 | cr3studioo/v3-P3-06 | planner work uncommitted in worktree; finish it |
| P3-07 | Scheduler: watches, quiet hours, pause | P3 | opus | P3-04 | alexia-scheduler/{src/lib.rs, src/watch.rs, src/quiet.rs, src/notices.rs, src/decide.rs... | ready | 1 | cr3studioo/v3-P3-07 | planner partial in worktree; finish after P3-04 |
| P3-08 | Scheduler: notice intake, the decider, deadline radar | P3 | opus | P3-05, P3-07 | alexia-scheduler/{src/notices.rs, src/decide.rs, src/lib.rs, tests/decide.rs, tests/int... | todo | 0 |  |  |
| P3-09 | Scheduler: morning brief, evening wrap-up, weekly review, while you were away | P3 | opus | P3-08 | alexia-scheduler/{src/brief.rs, src/lib.rs, tests/brief.rs} | todo | 0 |  |  |
| P3-10 | Scheduler: follow-through, check-ins, overnight errands, reminders and timers | P3 | opus | P3-09 | alexia-scheduler/{src/follow.rs, src/lib.rs, tests/follow.rs}, alexia-core/src/prompt.rs | todo | 0 |  |  |
| P3-11 | Scheduler: patterns, routine, automation and skill suggestions | P3 | opus | P3-10 | alexia-scheduler/{src/patterns.rs, src/lib.rs, tests/patterns.rs} | todo | 0 |  |  |
| P3-12 | Gateway: notice buttons, feedback, quick capture, owner activity | P3 | sonnet | P3-01, P3-04 | alexia-gateway/{src/gateway.rs, src/channel.rs, src/channels/telegram/mod.rs, src/chann... | review | 1 | cr3studioo/v3-P3-12 | built; review (see LOG) |
| P3-13 | Memory: recall by meaning, sources, corrections, forget | P3 | sonnet | P3-02 | plugins/memory/{search.js, capture.js, index.js, plugin.json, test/search.test.js, test... | merged | 2 | cr3studioo/v3-P3-13 |  |
| P3-14 | Memory: life graph, people, goals, contacts, people nudges | P3 | sonnet | P3-13 | plugins/memory/{graph.js (new), capture.js, index.js, plugin.json, test/graph.test.js} | merged | 2 | cr3studioo/v3-P3-14 | CEO added genitive weekdays |
| P3-15 | Memory: timeline, nightly tidy-up, profile file, import, locked facts | P3 | sonnet | P3-14 | plugins/memory/{timeline.js (new), import.js (new), garden.js, profile.js, index.js, pl... | merged | 3 | cr3studioo/v3-P3-15 | opus fixer; locks everywhere |
| P3-16 | Core: learn from every conversation, one memory, locked memory stays locked | P3 | opus | P3-00, P3-06, P3-12 | alexia-core/{src/agent.rs, src/chat.rs, tests/capture_everywhere.rs}, alexia-api/src/ch... | todo | 0 |  |  |
| P3-17 | Memory screen | P3 | sonnet | P3-15 | plugins/memory/{plugin.json, index.js, test/panel.test.js} | merged | 2 | cr3studioo/v3-P3-17 | manifest keys fixed |
| P3-18 | Document library and notes sync | P3 | sonnet | P3-03 | plugins/notes-library/** | merged | 2 | cr3studioo/v3-P3-18 | folder/Markdown; Apple Notes waits V3-4 |
| P3-19 | Screen memory | P3 | opus | P3-03 | plugins/screen-memory/** | merged | 1 | cr3studioo/v3-P3-19 | inert until P3-34 (front window) |
| P3-20 | Google: calendar, mail reading, contacts | P3 | opus | P3-03 | plugins/google-account/** | merged | 1 | cr3studioo/v3-P3-20 | token in memory only: follow-up |
| P3-21 | Microsoft 365: calendar, mail reading, contacts | P3 | opus | P3-03 | plugins/microsoft-account/** | merged | 1 | cr3studioo/v3-P3-21 | unconnected (no account) |
| P3-22 | Day planner: daily plan, smart scheduling, leave-now, meeting prep | P3 | sonnet | P3-03 | plugins/day-planner/** | merged | 2 | cr3studioo/v3-P3-22 | CEO fixed morning DST bounds |
| P3-23 | Mail desk: triage, inbox watch, packages, bills | P3 | sonnet | P3-03 | plugins/mail-desk/** | merged | 3 | cr3studioo/v3-P3-23 | opus fixer; time-window poll |
| P3-24 | Replies in your voice and sending email (always asks) | P3 | opus | P3-20, P3-21, P3-23 | plugins/google-account/{mail.js, index.js, plugin.json, test/send.test.js}, plugins/mic... | merged | 2 | cr3studioo/v3-P3-24 | sending waits for P3-35 |
| P3-25 | Commitments: keeps your promises, early | P3 | sonnet | P3-02 | plugins/commitments/{index.js, ledger.js, plugin.json, test/notice.test.js, test/due.te... | merged | 1 | cr3studioo/v3-P3-25 | |
| P3-26 | Tasks, and reminders by place or person | P3 | sonnet | P3-03 | plugins/task-list/** | merged | 1 | cr3studioo/v3-P3-26 | person items in brief (no recall since) |
| P3-27 | Page watch: website changes, school portal, your interests | P3 | sonnet | P3-03 | plugins/page-watch/** | merged | 3 | cr3studioo/v3-P3-27 | opus fixer; SSRF guarded |
| P3-28 | Health nudges | P3 | sonnet | P3-02 | plugins/apple-context/{nudges.js (new), index.js, plugin.json, test/nudges.test.js} | merged | 2 | cr3studioo/v3-P3-28 | heart on by default (A-21) |
| P3-29 | Study desk: study mode, meeting and lecture notes | P3 | sonnet | P3-03 | plugins/study-desk/** | merged | 2 | cr3studioo/v3-P3-29 | 7-day exam window |
| P3-30 | Errand kit: travel planner, bookings, forms and paperwork | P3 | sonnet | P3-03 | plugins/errand-kit/** | merged | 1 | cr3studioo/v3-P3-30 | CEO fixed listRoots guard |
| P3-31 | Hub: wiring, sources over the host, PC activity, CLI, slash commands | P3 | sonnet | P3-06, P3-11, P3-12, P3-16 | alexia-hub/{Cargo.toml, src/main.rs, src/proactive.rs (new), tests/cli_p3.rs}, alexia-c... | todo | 0 |  |  |
| P3-32 | A simulated week, proven | P3 | sonnet | P3-31, P3-14, P3-25 | alexia-hub/tests/week.rs | todo | 0 |  |  |
| P3-33 | On this PC: the real hub, the owner's week begins | P3 | sonnet | P3-00..P3-32 | v3/ops/reports/{P3-e2e.md, P3-week.md, p3-e2e.ps1} | todo | 0 |  |  |
| P3-34 | computer.screenshot reports the front window and lock state (screen memory needs it) | P3 | opus | P3-19 | plugins/computer/{index.js, windows.js, macos.js, test/**} | running | 1 | cr3studioo/v3-P3-34 | ctx_213bbd15b393 |
| P3-35 | Core offers elicitation to plugins: a plugin form becomes an owner prompt (window, Telegram) | P3 | opus | P3-24 | packages/core (supervisor.ts, ...), v3 hub host side; spec decides | todo | 0 |  | planning ctx_c28dab5d9bc2 |
