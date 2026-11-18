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
| P0-10 | Plugin process and JSON-RPC connection | P0 | opus | P0-08, P0-09 | alexia-mcp process/job/conn, Cargo.toml | review | 1 | cr3studioo/v3-P0-10 | review ctx_6f80e723ae85 |
| P0-11 | McpHost: start, handshake, tools, call_tool | P0 | opus | P0-10, P0-04 | alexia-mcp host | todo | 0 | | |
| P0-12 | Supervision: lazy, idle, heartbeat, backoff | P0 | opus | P0-11 | alexia-mcp host/supervise | todo | 0 | | |
| P0-13 | The alexia/* layer, capabilities, purge | P0 | opus | P0-12, P0-06 | alexia-mcp host/serve | todo | 0 | | |
| P0-14 | alexia-hub CLI | P0 | sonnet | P0-13, P0-07 | alexia-hub main/tests | todo | 0 | | |
| P0-15 | v2 plugins conformance test | P0 | sonnet | P0-14 | alexia-hub tests/v2_plugins | todo | 0 | | |
| P0-16 | CI: v3 workflow, invariant script | P0 | sonnet | P0-15 | .github/workflows/v3.yml, v3/ci | todo | 0 | | Builder prompt must lift workflow rule for v3.yml only |
