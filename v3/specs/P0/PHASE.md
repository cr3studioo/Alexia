# P0: V3-0, the skeleton

> Planned 2026-11-18 from `v3-plan.md` *V3-0* (the authority for scope) and
> `v3/specs/INTERFACES.md` (the Rust shapes). Where the two disagree, this plan follows
> `v3-plan.md`; the disagreements are listed at the end so INTERFACES.md can be fixed.

## Goal

A Rust hub that boots on the Windows PC, runs every v2 plugin unchanged through a Rust MCP host,
keeps everything in one SQLite file, and has imported v2's chats and memory. Nothing user-facing
beyond the CLI: this is the floor every later phase stands on.

Feature IDs: **SP-11** (keep MCP compatibility: the host speaks `2025-11-25` and the `alexia/*`
layer, so v2 plugins run as they are), **SP-12** (a single small binary: `alexia-hub.exe`, size-
optimised release profile, no runtime beyond the Node the v2 plugins themselves need), **SP-15**
(one database file: sessions, settings, plugin data and, from day one, `sqlite-vec` vector
search in the same file), **SP-18** (import everything from v2: chats, memory and the other
plugins' data, kv, settings, skills, own dirs), **EX-01** (delete the folder, nothing breaks: CI
runs core with `plugins/` empty and greps core for plugin names).

## Done when (from v3-plan.md)

The hub boots on Windows, lists the v2 plugins' tools, and has imported v2's chats and memory.
CI runs core with `plugins/` empty.

Concretely:
- `alexia-hub run` starts and stops cleanly on Ctrl+C on Windows (P0-14).
- `alexia-hub tools` with `ALEXIA_PLUGINS_DIR=<repo>\plugins` prints the tools of every v2
  plugin; the conformance test spawns each one through the host and lists its tools (P0-15).
- `alexia-hub import-v2 <copy of a v2 data folder>` imports sessions, messages and every
  `p_<ns>_*` table, the memory plugin's included (P0-07, P0-14).
- `.github/workflows/v3.yml` runs fmt, clippy and `cargo test --workspace` on `windows-latest`
  with `plugins/` moved away, plus the invariant script and the conformance job (P0-16).

## Crates and files this phase creates or changes

All under `v3/` unless noted. Nothing in `packages/`, `plugins/`, `src-tauri/` or `connect/`
changes.

| Crate | P0 content |
|---|---|
| `alexia-store` | types, `Layout`/`data_dir`, `Store` (migration 1, sessions, history, kv, settings, ledger, sqlite-vec), plugin namespaces, `secrets`, `import` |
| `alexia-mcp` | `jsonrpc`, `types`, `alexia` wire types; host-facing types; `manifest` + `discover`; process + connection (Job Object, `CREATE_NO_WINDOW`); `McpHost`; supervision; the `alexia/*` layer, capabilities, purge; `src/bin/mcp-fixture.rs` |
| `alexia-core` | the bus (`Bus`, `Event`) and the small types `Event` needs (`Origin`, `RunId`, `JobId`, `Lane`, `Span`, `Urgency`). No agent, router or providers (V3-2) |
| `alexia-gateway`, `alexia-scheduler` | empty library crates, so the dependency graph is fixed from day one |
| `alexia-hub` | the binary: `run`, `tools`, `plugins`, `import-v2`; the v2 conformance test |
| `alexia-limb` | an empty binary (V3-4) |

Other files: `v3/Cargo.toml`, `v3/Cargo.lock`, `v3/ci/invariants.mjs`,
`.github/workflows/v3.yml` (a new file; `ci.yml` and `release.yml` are not touched).

Migrations: P0 ships migration 1 only (INTERFACES.md §5.1). sqlite-vec is registered on every
connection; no vector table exists until something stores embeddings (V3-3).

`alexia-connect` is not a dependency yet: nothing in P0 uses the mesh. V3-1 adds it.

## Order of work

```
P0-01 workspace
  └─ P0-02 store types
       ├─ P0-03 mcp wire types + core bus ──┬─ P0-08 manifest ─┐
       │                                    └─ P0-09 fixture ──┴─ P0-10 process + conn
       └─ P0-04 store db ── P0-05 namespaces ── P0-06 secrets ── P0-07 importer
                       P0-10 + P0-04 ── P0-11 host ── P0-12 supervision
                       P0-12 + P0-06 ── P0-13 alexia/* layer, capabilities, purge
                       P0-13 + P0-07 ── P0-14 hub CLI ── P0-15 v2 conformance ── P0-16 CI
```

At most two at a time until P0-03 is merged (CEO.md *Phase 0 is special*). Then these can run
together: P0-04 ∥ P0-03; P0-05 ∥ P0-08 ∥ P0-09; P0-06 ∥ P0-10; P0-07 ∥ P0-11, P0-12 or P0-13.
The store chain (04 → 05 → 06 → 07) and the host chain (10 → 11 → 12 → 13) are serial because
each step adds a `mod` line to the same `lib.rs`.

## Tasks

Crate paths are under `v3/crates/`.

| ID | Title | Model | Depends on | Touches |
|---|---|---|---|---|
| P0-01 | Cargo workspace skeleton | sonnet | none | `v3/Cargo.toml`, `v3/Cargo.lock`, `*/Cargo.toml`, `*/src/lib.rs` or `main.rs`, `alexia-hub/tests/skeleton.rs` |
| P0-02 | Store shared types, layout, error | opus | P0-01 | `alexia-store/{Cargo.toml, src/lib.rs, src/types.rs, src/layout.rs, src/error.rs, tests/types.rs}` |
| P0-03 | MCP wire types, host types, core bus | opus | P0-02 | `alexia-mcp/{Cargo.toml, src/lib.rs, src/error.rs, src/jsonrpc.rs, src/types.rs, src/alexia.rs, tests/wire.rs}`, `alexia-core/{Cargo.toml, src/lib.rs, src/bus.rs}` |
| P0-04 | Store: open, migration 1, history, kv, settings, ledger, sqlite-vec | opus | P0-02 | `alexia-store/{Cargo.toml, src/lib.rs, src/db.rs, src/migrations.rs, tests/store.rs}` |
| P0-05 | Store: plugin namespaces | opus | P0-04 | `alexia-store/{src/lib.rs, src/namespace.rs, tests/namespace.rs}` |
| P0-06 | Store: secrets in Credential Manager | opus | P0-05 | `alexia-store/{src/lib.rs, src/secrets.rs, tests/secrets.rs}` |
| P0-07 | Store: the v2 importer | opus | P0-06 | `alexia-store/{src/lib.rs, src/import.rs, tests/import.rs, tests/fixtures/v2_migrations.sql}` |
| P0-08 | Manifest parsing, compatibility, discovery | opus | P0-03 | `alexia-mcp/{src/lib.rs, src/manifest.rs, tests/manifest.rs}` |
| P0-09 | The mcp-fixture test server | sonnet | P0-03 | `alexia-mcp/{src/bin/mcp-fixture.rs, tests/fixture.rs}` |
| P0-10 | Plugin process and JSON-RPC connection | opus | P0-08, P0-09 | `alexia-mcp/{Cargo.toml, src/lib.rs, src/process.rs, src/job.rs, src/conn.rs, tests/conn.rs}` |
| P0-11 | McpHost: start, handshake, tools, call_tool | opus | P0-10, P0-04 | `alexia-mcp/{src/lib.rs, src/host.rs, tests/host.rs}` |
| P0-12 | Supervision: lazy, idle, heartbeat, backoff, vanish | opus | P0-11 | `alexia-mcp/{src/lib.rs, src/host.rs, src/supervise.rs, tests/supervise.rs}` |
| P0-13 | The alexia/* layer, capabilities, purge | opus | P0-12, P0-06 | `alexia-mcp/{src/lib.rs, src/host.rs, src/serve.rs, tests/alexia_layer.rs, tests/purge.rs}` |
| P0-14 | alexia-hub CLI | sonnet | P0-13, P0-07 | `alexia-hub/{Cargo.toml, src/main.rs, tests/skeleton.rs (delete), tests/cli.rs}` |
| P0-15 | v2 plugins conformance test | sonnet | P0-14 | `alexia-hub/{Cargo.toml, tests/v2_plugins.rs}` |
| P0-16 | CI: v3 workflow, no-plugins run, invariant script | sonnet | P0-15 | `.github/workflows/v3.yml`, `v3/ci/invariants.mjs` |

## Where INTERFACES.md contradicts v3-plan.md (this plan follows v3-plan.md)

1. **§5.3** puts `sqlite-vec` in migration 4 at V3-3. v3-plan picks SP-15 (one file with vector
   search) for V3-0, so P0-04 registers sqlite-vec on every connection now (no table yet).
2. **§6** says secrets are not imported, against SP-18 "imports … settings" in V3-0. A data folder
   holds no secrets, so P0-07 imports every non-secret setting and lists each `password` setting
   with no secret on this machine in `ImportReport.skipped`. §6 should say that.
3. **§7 check V2** lists only `hello`'s tools; v3-plan's done-when is "lists the v2 plugins'
   tools". P0-15 requires every plugin's tools.

INTERFACES.md bugs P0 works around (not v3-plan conflicts):
- **§7 fixture modes** `hello | crasher-* | vanisher` would put quoted plugin folder names into
  `src/bin/mcp-fixture.rs`, which check 1 forbids. P0-09 names them
  `greet | exit | hang | junk | vanish | storage`.
- **§7 check V2** says `pnpm build`; the repo has no such script. `pnpm typecheck` (`tsc -b`)
  builds the SDK's `dist/`.
- **§7 check 1** as written (bare word, case-insensitive) fires on ordinary English such as
  "memory" or "media". P0-16 ports v2's rule instead: an id quoted, or after `plugins/`.
