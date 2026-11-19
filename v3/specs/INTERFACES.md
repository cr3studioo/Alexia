# v3 interfaces

> **What this is.** The contracts between the v3 crates, and between the hub and plugins. Every
> task spec copies its *Interfaces* section from here. Changing a signature here is a change for
> every task that uses it, so change this file first, in its own commit, and say why.
>
> **What it builds on.** `v3-plan.md` (*Shape*, D209–D217), `plan.md` *The contract*, `Alexia.md`
> (*The load-bearing invariant*, *Architecture*, *The plugin contract*, *The agent loop*). For
> plugin-facing behaviour, the v2 specs in `docs/spec/` stay normative (`wire-protocol.md`,
> `storage.md`, `capabilities.md`, `manifest.md`). This file fixes the Rust shapes and says which
> phase serves what. Where this file and `docs/spec/` disagree about what a plugin sees, the spec
> wins and this file has a bug.
>
> Written 2026-11-18 by the Architect.

---

## 0. Rules every crate follows

1. **The invariant.** Delete a plugin's folder and nothing breaks. No v3 source file names a
   plugin, imports from `plugins/`, or special-cases a plugin id. Plugins are found by scanning a
   directory and are reached only through their manifest and JSON-RPC. A plugin depends on
   capabilities (`voice.speak`), never on a plugin (`voice`). Core boots and `cargo test
   --workspace` passes with the plugins directory empty (§7).
2. **Licence.** Every crate is `license = "AGPL-3.0-only"`, set once in `[workspace.package]`.
   Every `.rs` file starts with `// SPDX-License-Identifier: AGPL-3.0-only`.
3. **No secrets in files.** Secrets live in Windows Credential Manager through the `keyring`
   crate (service `alexia`, account `<owner>.<key>`, the v2 naming), or in environment variables
   for CI. Never in the database, never in logs, specs, tests or fixtures.
   (V3-1) The environment variable is `ALEXIA_SECRET_<OWNER>_<KEY>`: owner and key uppercased,
   every character that is not A-Z or 0-9 becomes `_` (`_core.telegram_bot_token` →
   `ALEXIA_SECRET__CORE_TELEGRAM_BOT_TOKEN`). If set and non-empty it wins over the keychain.
4. **Windows first.** Paths are built with `Path::join`, never with literal separators or
   drive letters. The data directory comes from `%LOCALAPPDATA%` (§2.1). Child processes are
   created with `CREATE_NO_WINDOW` and placed in a Job Object (§3.2). Tests run on
   `windows-latest`.
5. **Time** is `Ms = i64`, Unix epoch milliseconds, everywhere: the database, the bus, the wire.
6. **Errors.** Each library crate has one `pub enum Error` (`thiserror`) and
   `pub type Result<T> = std::result::Result<T, Error>`. No `anyhow` in libraries; the two
   binaries may use it. A message a person will read is a full sentence and is never built from
   an `Error`'s `Debug` output.
7. **Async.** Tokio, multi-threaded runtime. Traits that are used as `dyn` use `async-trait`.
   Cancellation is `tokio_util::sync::CancellationToken`.
8. **No speculative traits.** A trait exists here only where there are two implementations
   (one of them may be a test fake) or where it breaks a dependency cycle. Everything else is a
   concrete struct.

---

## 1. The workspace

```
v3/
  Cargo.toml                 the workspace (below)
  crates/
    alexia-store/            lib
    alexia-mcp/              lib (+ a test-only fixture binary, §7)
    alexia-core/             lib
    alexia-gateway/          lib
    alexia-scheduler/        lib
    alexia-hub/              bin  alexia-hub.exe
    alexia-limb/             bin  alexia-limb(.exe)
  specs/
```

`connect/` (D208) is **not moved and not a workspace member**. It has its own lockfile, release
profile and exact pins (`iroh = "=1.3.0"`), and v2 still builds it. The two binaries use it as
a path dependency: `alexia-connect = { path = "../../../connect" }` from `v3/crates/<bin>/`.
Changing `connect/` itself needs a task spec that names it (CEO rule 4).

### 1.1 Crates and the dependencies they may have

| Crate | Kind | One line | May depend on (internal) |
|---|---|---|---|
| `alexia-store` | lib | One SQLite file: sessions, messages, settings, kv, ledger, plugin namespaces; secrets; the v2 importer. | nothing |
| `alexia-mcp` | lib | The MCP host: manifest loader, supervisor, JSON-RPC over stdio, the `alexia/*` layer, capability resolution. | `alexia-store` |
| `alexia-core` | lib | The event bus, the agent loop, router and providers, permissions and rails. | `alexia-store`, `alexia-mcp` |
| `alexia-gateway` | lib | Channels: instant ack, merging, drafts, delivery. | `alexia-store`, `alexia-core` |
| `alexia-scheduler` | lib | The proactivity engine: triggers, watches, do-not-disturb. | `alexia-store`, `alexia-core` |
| `alexia-hub` | bin | Wires everything together on the Windows PC; CLI; the v2 bridge (V3-1). | all five libs, `alexia-connect` |
| `alexia-limb` | bin | The per-device process (Mac first): exposes the device to the hub as an MCP server over the mesh. | `alexia-mcp`, `alexia-connect` |

The graph is a strict DAG: `store ← mcp ← core ← {gateway, scheduler} ← hub`. Nothing below
may depend on anything above. `gateway` and `scheduler` never depend on each other; they talk
through the bus. A CI step (`cargo metadata` + a 20-line script) fails on any edge not in this
table.

**Not crates, on purpose.** The GPU job arbiter (D213) is a module of `alexia-core`
(`alexia_core::gpu`, V3-6). The latency dashboard (SP-09) is a page the hub **writes** (`alexia-hub latency --html FILE`),
not one it serves, so the hub opens no port (V3-1).
The iOS app is `apps/ios`, outside the workspace (D215).

### 1.2 `v3/Cargo.toml`

```toml
[workspace]
resolver = "2"
members = ["crates/*"]

[workspace.package]
version = "3.0.0"
edition = "2021"
rust-version = "1.85"
license = "AGPL-3.0-only"
publish = false

[workspace.dependencies]
tokio = { version = "1", features = ["rt-multi-thread", "macros", "process", "io-util", "sync", "time", "signal"] }
tokio-util = { version = "0.7", features = ["rt"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
async-trait = "0.1"
tracing = "0.1"
rusqlite = { version = "0.37", features = ["bundled"] }
keyring = "4.2"          # same family as connect/
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json", "stream"] }

[workspace.lints.rust]
unsafe_code = "deny"     # alexia-mcp's Job Object code opts out with a module-level allow
```

Versions are the floor the first task builds with; the first task records what `cargo` actually
resolved in `Cargo.lock`, which is committed. A new external dependency needs a line in the task
spec saying why the standard library and the ones above do not cover it.

---

## 2. Crate APIs

Only public items are listed. Private helpers are the implementer's choice.

### 2.1 `alexia-store`

```rust
pub type Ms = i64;

/// Where v3 keeps its data. `%LOCALAPPDATA%\AlexiaHub` on Windows,
/// `~/Library/Application Support/AlexiaHub` on macOS (the limb's fallback brain),
/// `$XDG_DATA_HOME/AlexiaHub` elsewhere. `ALEXIA_V3_DATA`, if set to an absolute path, wins
/// (tests and the dev build use it). Deliberately not v2's `Alexia` folder: v3 never writes there.
pub fn data_dir() -> std::path::PathBuf;

/// The layout under `data_dir()`. The same relative layout v2 uses, so the importer copies
/// folders one-to-one.
pub struct Layout { pub root: PathBuf }
impl Layout {
    pub fn new(root: PathBuf) -> Self;
    pub fn db(&self) -> PathBuf;                       // alexia.db
    pub fn own_dir(&self, plugin: &str) -> PathBuf;    // plugins\<id>   (a plugin's cwd and ownDir)
    pub fn extensions(&self) -> PathBuf;               // extensions\    (installed plugin folders)
    pub fn skills(&self) -> PathBuf;                   // skills\
    pub fn uploads(&self) -> PathBuf;                  // uploads\<session>\
    pub fn cache(&self) -> PathBuf;                    // cache\
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub i64);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MessageId(pub i64);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role { System, User, Assistant, Tool }

/// One part of a turn. The v2 shape, so v2 rows parse unchanged.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Part {
    Text { text: String },
    /// A full `data:` URL.
    Image { url: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Content { Text(String), Parts(Vec<Part>) }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCall { pub id: String, pub name: String, /** JSON text, as the provider sent it */ pub arguments: String }

/// `messages.body`: everything about a turn except `role` and `model`, which are columns.
/// Field names are v2's, including its camelCase `callId`. Unknown keys are kept in `extra`
/// and written back, so a v2 field nobody ported yet is never lost.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageBody {
    pub content: Content,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub calls: Option<Vec<ToolCall>>,
    #[serde(default, rename = "callId", skip_serializing_if = "Option::is_none")] pub call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub notes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub bad: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub stopped: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub typed: Option<String>,
    #[serde(flatten)] pub extra: serde_json::Map<String, serde_json::Value>,
}

pub struct Message { pub id: MessageId, pub session: SessionId, pub role: Role, pub model: Option<String>, pub body: MessageBody, pub at: Ms }
pub struct Session { pub id: SessionId, pub title: Option<String>, pub created_at: Ms, pub updated_at: Ms }

// ---- the plugin storage grammar (storage.md). mcp's wire params reuse these types. ----

/// A bound parameter. Nothing a plugin sends is ever concatenated into SQL.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Scalar { Null, Bool(bool), Num(serde_json::Number), Str(String) }

/// Exactly one field set; `validate()` rejects zero or two. Unknown keys are a parse error.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Operator {
    pub eq: Option<Scalar>, pub ne: Option<Scalar>,
    pub lt: Option<Scalar>, pub lte: Option<Scalar>, pub gt: Option<Scalar>, pub gte: Option<Scalar>,
    #[serde(rename = "in")] pub in_: Option<Vec<Scalar>>,
    pub like: Option<String>,
    /// Only `true` is valid.
    pub is_null: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Cond { Op(Operator), Eq(Scalar) }

/// Column → condition. Several keys are AND. Column names match `^[a-z][a-z0-9_]*$`.
pub type Where = std::collections::BTreeMap<String, Cond>;
/// A row in: objects and arrays are stored as JSON text, booleans as 0/1.
pub type Row = serde_json::Map<String, serde_json::Value>;

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dir { Asc, Desc }

#[derive(Clone, Debug, Default)]
pub struct Select { pub filter: Option<Where>, pub order: Vec<(String, Dir)>, pub limit: Option<u64>, pub offset: Option<u64> }

pub enum DeleteScope<'a> { Where(&'a Where), All }

/// Usage and the model record (v2 migrations 4–9), written by the router.
pub struct Usage { pub at: Ms, pub session: Option<SessionId>, pub plugin: Option<String>, pub model: String,
                   pub asked: Option<String>, pub provider: String, pub tokens_in: i64, pub tokens_out: i64,
                   pub cost: f64, pub run_id: Option<String>, pub writing_ms: Option<i64> }
pub struct Try { pub at: Ms, pub provider: String, pub model: String, pub outcome: String, pub status: i64,
                 pub source: String, pub waited_ms: Option<i64> }

/// One connection behind a mutex.
/// ponytail: one writer at a time is fine for one owner; a reader pool if the dashboard ever waits on it.
pub struct Store { /* Mutex<rusqlite::Connection> */ }

impl Store {
    /// Creates the file and parent folder if missing, sets `journal_mode=WAL`, `foreign_keys=ON`,
    /// runs every migration not yet run (§5.3). Refuses a database whose `user_version` is newer
    /// than this build or whose `application_id` is not v3's.
    pub fn open(path: &Path) -> Result<Store>;
    pub fn open_in_memory() -> Result<Store>;
    pub fn transaction<T>(&self, f: impl FnOnce(&rusqlite::Transaction) -> Result<T>) -> Result<T>;

    // sessions and history (core's)
    pub fn create_session(&self, title: Option<&str>) -> Result<SessionId>;
    pub fn sessions(&self) -> Result<Vec<Session>>;                       // newest first
    pub fn set_title(&self, id: SessionId, title: &str) -> Result<()>;
    pub fn delete_session(&self, id: SessionId) -> Result<()>;            // cascades messages, attachments
    pub fn append(&self, id: SessionId, role: Role, model: Option<&str>, body: &MessageBody) -> Result<MessageId>;
    pub fn history(&self, id: SessionId, limit: Option<u32>) -> Result<Vec<Message>>;   // oldest first, newest `limit`

    // kv: core uses ns "_core"; a plugin's kv uses its plugin id
    pub fn kv_get(&self, ns: &str, key: &str) -> Result<Option<serde_json::Value>>;
    pub fn kv_set(&self, ns: &str, key: &str, value: &serde_json::Value) -> Result<()>;
    pub fn kv_delete(&self, ns: &str, key: &str) -> Result<()>;

    // settings: non-secret values only; `password` settings live in `secrets`
    pub fn settings(&self, plugin: &str) -> Result<serde_json::Map<String, serde_json::Value>>;
    pub fn set_setting(&self, plugin: &str, key: &str, value: &serde_json::Value) -> Result<()>;

    // plugin namespaces: physical tables are p_<ns>_<table>, hyphens in ns become underscores
    pub fn create_tables(&self, ns: &str, tables: &[String]) -> Result<()>;
    pub fn insert(&self, ns: &str, table: &str, row: &Row) -> Result<i64>;          // rowid
    pub fn select(&self, ns: &str, table: &str, q: &Select) -> Result<Vec<Row>>;
    pub fn update(&self, ns: &str, table: &str, set: &Row, filter: &Where) -> Result<u64>;  // filter non-empty
    pub fn delete(&self, ns: &str, table: &str, scope: DeleteScope<'_>) -> Result<u64>;
    pub fn count(&self, ns: &str, table: &str, filter: Option<&Where>) -> Result<u64>;
    /// storage.md's escape hatch: refuses any identifier it cannot prove is inside p_<ns>_.
    pub fn raw(&self, ns: &str, sql: &str, params: &[Scalar]) -> Result<Vec<Row>>;
    /// DROP every p_<ns>_* table, DELETE kv where ns = plugin id, DELETE settings where plugin = id.
    /// The caller (mcp) deletes the own dir and the secrets.
    pub fn purge(&self, plugin: &str, ns: Option<&str>) -> Result<()>;

    // the ledger
    pub fn record_request(&self, provider: &str, at: Ms) -> Result<()>;
    pub fn record_usage(&self, u: &Usage) -> Result<()>;
    pub fn record_try(&self, t: &Try) -> Result<()>;

    // (V3-1) channel chats and spans, migration 2 (§5.3)
    /// The session for this chat, created (titled "<channel>") on first sight. The first chat ever
    /// seen on a channel becomes its primary.
    pub fn channel_session(&self, channel: &str, chat: &str) -> Result<SessionId>;
    /// Point the chat at a fresh session (`/new`). Returns it.
    pub fn new_channel_session(&self, channel: &str, chat: &str) -> Result<SessionId>;
    pub fn primary_chat(&self, channel: &str) -> Result<Option<String>>;
    /// Exactly one primary per channel.
    pub fn set_primary_chat(&self, channel: &str, chat: &str) -> Result<()>;
    pub fn record_spans(&self, rows: &[SpanRow]) -> Result<()>;                // one transaction
    /// The newest `n` turns' rows, oldest turn first, rows in `start` order.
    pub fn last_turns(&self, n: u32) -> Result<Vec<SpanRow>>;
    pub fn tries_since(&self, at: Ms) -> Result<Vec<TryRow>>;                  // oldest first
    /// Requests counted by `record_request` in the `"minute"` or `"day"` bucket that holds `at`.
    /// 0 when there is no row.
    pub fn request_count(&self, provider: &str, span: &str, at: Ms) -> Result<u64>;
    /// Spans older than `before` are deleted (the dashboard keeps 30 days).
    pub fn prune_spans(&self, before: Ms) -> Result<u64>;
}

/// (V3-1) `at`: epoch ms of the turn's first receipt. `start`: ms from that receipt (`at`) to
/// the span's start, not an epoch time. `ms`: the span's length.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpanRow { pub turn: String, pub at: Ms, pub origin: String, pub lane: String,
                     pub name: String, pub start: Ms, pub ms: i64 }
/// (V3-1)
#[derive(Clone, Debug, PartialEq)]
pub struct TryRow { pub at: Ms, pub provider: String, pub model: String, pub outcome: String,
                    pub status: i64, pub waited_ms: Option<i64> }

pub mod secrets {
    /// Windows Credential Manager via `keyring`. Service "alexia", account "<owner>.<key>",
    /// where owner is a plugin id or "_core". Never logged, never cached by callers.
    /// (V3-1) Reads the environment variable `env_name(owner, key)` first; set and non-empty, it wins.
    pub fn get(owner: &str, key: &str) -> super::Result<Option<String>>;
    /// (V3-1) `ALEXIA_SECRET_<OWNER>_<KEY>`, spelled as §0.3 says.
    pub fn env_name(owner: &str, key: &str) -> String;
    pub fn set(owner: &str, key: &str, secret: &str) -> super::Result<()>;
    pub fn delete(owner: &str, key: &str) -> super::Result<()>;
    pub fn delete_all(owner: &str, keys: &[String]) -> super::Result<()>;
}

pub mod import {
    pub struct ImportReport { pub v2_schema: i64, pub rows: Vec<(String, u64)>, pub files: u64, pub skipped: Vec<String> }
    /// §6. `v2_root` is a v2 data folder (copied whole, with v2 quit). Refuses if `store` already
    /// holds an import or any session.
    pub fn import_v2(store: &super::Store, v2_root: &Path, v3: &super::Layout) -> super::Result<ImportReport>;
}
```

### 2.2 `alexia-mcp`

```rust
pub use alexia_store::{Cond, Dir, Operator, Row, Scalar, Where};

/// A plugin's id as read from its manifest. Opaque to everything above this crate: core may
/// hold one at runtime (to route a tool call back) and must never compare it to a literal.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PluginId(pub String);

pub mod jsonrpc { /* §3.1 */ }
pub mod types   { /* MCP shapes, §3.3 */ }
pub mod alexia  { /* the alexia/* layer, §3.4 */ }
pub mod manifest;

// ---- manifest (plugin.json, manifest_version 1; manifest.md is normative) ----

pub const ALEXIA_PROTOCOL_MIN: u32 = 2;
pub const ALEXIA_PROTOCOL_MAX: u32 = 15;     // same window as v2 core today
pub const MCP_REVISIONS: [&str; 1] = ["2025-11-25"];   // §3.2
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");   // "3.0.0", what min_app/max_app compare to

/// Strict at the top level like v2 (`deny_unknown_fields`): a typo'd key is a load error.
/// Sub-objects the hub does not interpret yet (`panel`, `page`, a setting's widget fields) are
/// kept as raw JSON so a v2 manifest that is valid today parses unchanged.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    #[serde(rename = "$schema")] pub schema: Option<String>,
    pub manifest_version: u32,                // must be 1
    pub id: String,                           // ^[a-z][a-z0-9-]*$
    pub name: String,
    pub summary: String,
    pub version: String,
    pub license: String,
    pub entry: Entry,
    pub alexia_protocol: u32,
    pub mcp_protocol: String,
    pub min_app: Option<String>,
    pub max_app: Option<String>,
    #[serde(default)] pub requires: Vec<Require>,
    #[serde(default)] pub provides: Vec<String>,
    #[serde(default)] pub settings: Vec<Setting>,
    pub storage: Option<StorageDecl>,
    #[serde(default)] pub commands: Vec<Command>,
    #[serde(default)] pub skills: Vec<String>,
    #[serde(default)] pub assets: Vec<String>,
    pub min_tier: Option<String>,             // T0..T3
    pub lifetime: Option<Lifetime>,
    pub panel: Option<serde_json::Value>,
    pub page: Option<serde_json::Value>,
    pub compute: Option<ComputeDecl>,
}
#[derive(Clone, Debug, Deserialize)] #[serde(deny_unknown_fields)]
pub struct Entry { pub run: String, #[serde(default)] pub args: Vec<String> }
#[derive(Clone, Debug, Deserialize)] #[serde(deny_unknown_fields)]
pub struct Require { pub cap: String, pub why: String }
/// `key` and `type` are what the host reads; everything else is the widget's (ui-schema.md).
#[derive(Clone, Debug, Deserialize)]
pub struct Setting {
    pub key: String,
    #[serde(rename = "type")] pub kind: String,          // "password" and "status" matter to the host
    pub default: Option<serde_json::Value>,
    #[serde(flatten)] pub widget: serde_json::Map<String, serde_json::Value>,
}
#[derive(Clone, Debug, Deserialize)] #[serde(deny_unknown_fields)]
pub struct StorageDecl { pub namespace: String, #[serde(default)] pub tables: Vec<String>, #[serde(default)] pub dir: bool }
#[derive(Clone, Debug, Deserialize)] #[serde(deny_unknown_fields)]
pub struct Command { pub name: String, pub summary: String }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)] #[serde(rename_all = "lowercase")]
pub enum Lifetime { Lazy, Resident }
#[derive(Clone, Debug, Deserialize)] #[serde(deny_unknown_fields)]
pub struct ComputeDecl { pub operations: Vec<ComputeOp>, #[serde(default)] pub hooks: Vec<String> }
#[derive(Clone, Debug, Deserialize)] #[serde(deny_unknown_fields)]
pub struct ComputeOp { pub cap: String, pub summary: String, pub weight: Option<String> }

impl Manifest {
    /// Parse and run manifest.md's cross-field checks (ids, capability syntax, duplicates,
    /// permission names from capabilities.md's registry).
    pub fn parse(json: &str) -> Result<Manifest, ManifestError>;
    /// Check two of wire-protocol.md §3.3 plus min_app/max_app. Err is the sentence the owner reads.
    pub fn compatible(&self) -> Result<(), String>;
}

/// A folder with a readable plugin.json. Reading one never spawns anything.
pub struct PluginDir { pub path: PathBuf, pub manifest: Manifest }
/// Every `<dir>/*/plugin.json`. A folder whose manifest fails is reported, never fatal.
pub fn discover(dir: &Path) -> Vec<Result<PluginDir, (PathBuf, ManifestError)>>;

// ---- the host ----

pub struct Timings {
    pub start_ms: u64,        // 10_000  spawn → initialize answered
    pub heartbeat_ms: u64,    // 15_000  ping interval and ping deadline
    pub call_ms: u64,         // 120_000 one tools/call
    pub capability_ms: u64,   // 140_000 alexia/capability/call budget; must stay < 150_000 (SDK's CAPABILITY_CALL_MS)
    pub idle_ms: u64,         // 300_000 no traffic → stop (lazy plugins only)
    pub backoff_ms: u64,      // 500, doubling
    pub max_backoff_ms: u64,  // 30_000
    pub crash_window_ms: u64, // 60_000
    pub crash_limit: u32,     // 3
    pub exit_grace_ms: u64,   // 2_000   stdin closed → kill
}
impl Default for Timings { /* the values above */ }

pub struct HostConfig {
    pub layout: alexia_store::Layout,
    /// Folders scanned for plugins, in order; the first folder holding an id wins.
    /// Hub default: `[layout.extensions()]`, plus `ALEXIA_PLUGINS_DIR` if set (a v2 checkout's `plugins\`).
    pub plugin_dirs: Vec<PathBuf>,
    /// What `"run": "node"` resolves to. `ALEXIA_NODE` if set, else `node` on PATH.
    pub node: PathBuf,
    pub timings: Timings,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginState { Stopped, Running, Unhealthy, Refused }

#[derive(Clone, Debug, Serialize)]
pub struct PluginStatus { pub id: PluginId, pub name: String, pub version: String, pub enabled: bool,
                          pub state: PluginState, pub sentence: Option<String>, pub provides: Vec<String> }

/// A tool as the host knows it. `provides` is read off `_meta["alexia/provides"]`;
/// `hidden` is true when the tool carries `alexia/compute` or `alexia/editor` (never shown to a model).
#[derive(Clone, Debug)]
pub struct HostedTool { pub plugin: PluginId, pub tool: types::Tool, pub provides: Vec<String>, pub hidden: bool }

pub type ProgressSink = tokio::sync::mpsc::Sender<types::ProgressParams>;

#[derive(Clone, Default)]
pub struct CallCtx {
    /// Becomes `_meta["alexia/call-context"] = {"conversationId": "<id>"}`.
    pub conversation: Option<String>,
    /// When set, the request carries a progressToken and frames are forwarded here.
    pub progress: Option<ProgressSink>,
    pub cancel: tokio_util::sync::CancellationToken,
    /// Extra request `_meta` keys core sets (§3.5), merged as-is.
    pub meta: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Answers { pub answers: bool, pub here: bool }

#[derive(Debug, thiserror::Error)]
pub enum CallError {
    #[error("{0}")] Rpc(jsonrpc::RpcError),         // the plugin answered with a JSON-RPC error
    #[error("{sentence}")] Off { sentence: String }, // switched off, refused, unhealthy
    #[error("the plugin did not answer in time")] Timeout,
    #[error("the plugin stopped while answering")] Gone,  // crashed, killed, or folder deleted
    #[error("stopped")] Cancelled,
}

/// What a plugin's requests need from above this crate. Implemented by `alexia-core`
/// (V3-2) and by `NoUpcalls` (V3-0, tests). This is the cycle-breaker: core calls mcp for
/// tools, mcp calls core for the model.
#[async_trait::async_trait]
pub trait Upcalls: Send + Sync {
    /// What `initialize` offers this plugin right now (wire-protocol.md §4).
    fn offers(&self, plugin: &PluginId) -> types::ClientCapabilities;
    /// display name, privacy mode, locale for alexia/host/info.
    fn host_facts(&self) -> HostFacts;
    async fn sample(&self, plugin: &PluginId, params: types::CreateMessageParams,
                    progress: Option<ProgressSink>, cancel: CancellationToken)
        -> Result<serde_json::Value, jsonrpc::RpcError>;
    async fn elicit(&self, plugin: &PluginId, params: serde_json::Value) -> Result<serde_json::Value, jsonrpc::RpcError>;
    async fn roots(&self, plugin: &PluginId) -> Vec<types::Root>;
    /// alexia/attachments/* (protocol 14). Default: METHOD_NOT_FOUND.
    async fn attachments(&self, plugin: &PluginId, call: alexia::AttachmentsCall) -> Result<serde_json::Value, jsonrpc::RpcError> {
        let _ = (plugin, call); Err(jsonrpc::RpcError::method_not_found())
    }
}
pub struct HostFacts { pub display_name: String, pub privacy_mode: alexia::PrivacyMode, pub locale: String }
/// Offers `{roots:{}}` only; `sample`/`elicit` answer -32021; roots empty.
pub struct NoUpcalls;

#[derive(Clone, Debug)]
pub enum PluginEvent {
    Loaded { plugin: PluginId },
    Refused { plugin: PluginId, sentence: String },    // version or manifest check failed; no process
    Started { plugin: PluginId, pid: u32 },
    Stopped { plugin: PluginId, reason: StopReason },
    Crashed { plugin: PluginId, exit_code: Option<i32> },
    Unhealthy { plugin: PluginId, sentence: String },  // crash_limit hit; switched off
    ToolsChanged { plugin: PluginId },
    Removed { plugin: PluginId },                       // folder gone
}
#[derive(Clone, Copy, Debug)] pub enum StopReason { Idle, Disabled, Shutdown, Heartbeat }
pub type EventSink = std::sync::Arc<dyn Fn(PluginEvent) + Send + Sync>;

pub struct McpHost { /* Arc inside; Clone is cheap */ }
impl Clone for McpHost { /* ... */ }

impl McpHost {
    pub fn new(cfg: HostConfig, store: Arc<alexia_store::Store>, up: Arc<dyn Upcalls>, events: EventSink) -> McpHost;
    /// Swap the upcalls. The hub builds the host with `NoUpcalls`, builds `Agent` (which needs
    /// the host), then hands the agent back here. Takes effect for the next spawn's `initialize`.
    pub fn set_upcalls(&self, up: Arc<dyn Upcalls>);
    /// Scan `plugin_dirs`, load every manifest, apply `enabled`, create declared tables.
    /// Spawns only `lifetime: resident` plugins that are enabled. Watches the folders: a folder
    /// that disappears is `unload`ed (its process killed, its tools dropped, `Removed` emitted).
    pub async fn start(&self, enabled: &[PluginId]) -> Result<(), Error>;
    pub fn plugins(&self) -> Vec<PluginStatus>;
    pub async fn set_enabled(&self, id: &PluginId, on: bool) -> Result<(), Error>;
    /// Every enabled plugin's tools, spawning lazily as needed; cached until `ToolsChanged` or exit.
    pub async fn tools(&self) -> Vec<HostedTool>;
    pub async fn call_tool(&self, plugin: &PluginId, name: &str, args: serde_json::Map<String, serde_json::Value>, ctx: CallCtx)
        -> Result<types::CallToolResult, CallError>;
    /// By capability name only. Picks the provider; the result never says which one.
    pub async fn call_capability(&self, cap: &str, args: serde_json::Map<String, serde_json::Value>, ctx: CallCtx)
        -> Result<types::CallToolResult, CallError>;
    pub fn answers(&self, cap: &str) -> Answers;
    /// `alexia/settings/changed` to a running plugin (nothing if it is not running).
    pub async fn settings_changed(&self, id: &PluginId, changed: serde_json::Map<String, serde_json::Value>);
    /// `alexia/conversation/ended` to every running plugin.
    pub async fn conversation_ended(&self);
    /// Stop now (D213: a game started). Not a crash; the next call respawns.
    pub async fn stop(&self, id: &PluginId);
    pub fn pid(&self, id: &PluginId) -> Option<u32>;
    /// Last 500 stderr lines, tagged and secret-redacted. Never on the bus.
    pub fn log(&self, id: &PluginId) -> Vec<String>;
    /// Stop, then: store.purge, secrets of password settings, own dir. Leaves no residue (§7).
    pub async fn purge(&self, id: &PluginId) -> Result<(), Error>;
    pub async fn shutdown(&self);
}
```

Capability resolution rule (unchanged from v2): a call for `cap` goes to the enabled plugin whose
running tool lists `cap` in `_meta["alexia/provides"]`; if more than one, the one installed
first (lowest `installed_at` in kv `_core.provenance`, else alphabetical by id). The caller must
have `cap` in `requires[]` (else `-32051`); no provider is `-32050`. `answers` reads manifests'
`provides[]` only and starts nothing.

### 2.3 `alexia-core`

```rust
pub mod bus;   // §4
pub use bus::{Bus, Event};

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)] #[serde(transparent)]
pub struct RunId(pub String);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)] #[serde(transparent)]
pub struct JobId(pub i64);

/// Where a turn came from and where its answer goes.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Origin {
    /// `channel` is the channel's own name ("telegram", "whatsapp"); `chat` its chat id as text.
    Channel { channel: String, chat: String },
    Desktop,
    Scheduler { job: JobId },
}

#[derive(Clone, Debug)]
pub struct Turn { pub session: SessionId, pub origin: Origin, pub content: Content, pub received_at: Ms }

/// What the reply is doing while it is written. Mirrors `alexia/stream` (wire-protocol.md §5).
#[derive(Clone, Debug)]
pub enum DraftFrame { Delta(String), Restart, Phase(Phase) }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase { Choosing, Asking, Retrying, Backup, Thinking, Writing, Tool }
pub type DraftSink = tokio::sync::mpsc::Sender<DraftFrame>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lane { Command, Chat, Task }   // Chat = the fast path: one model call, no tools, no loop

/// One timed stretch of answering, for the latency dashboard (SP-09).
#[derive(Clone, Debug, Serialize)]
pub struct Span { pub name: &'static str, pub start: Ms, pub ms: u32 }

#[derive(Clone, Debug)]
pub struct OutFile { pub name: String, pub mime: String, pub path: PathBuf }
#[derive(Clone, Debug)]
pub struct Reply { pub text: String, pub files: Vec<OutFile>, pub lane: Lane, pub model: Option<String>, pub spans: Vec<Span> }

#[derive(Debug, thiserror::Error)]
pub enum BrainError {
    #[error("{0}")] Unavailable(String),   // a sentence: nothing could answer right now
    #[error("stopped")] Cancelled,
    /// (V3-1) The chat lane decided this turn needs tools; nothing was shown or stored yet.
    #[error("needs the task lane")] NeedsTask,
    #[error(transparent)] Other(#[from] Error),
}

/// Whatever answers a turn. Implemented by `Agent` (V3-2) and by the hub's `V2Bridge` (V3-1),
/// plus a fake in tests. The gateway and the scheduler hold an `Arc<dyn Brain>`.
#[async_trait::async_trait]
pub trait Brain: Send + Sync {
    /// Appends the user turn and the reply to the session itself.
    async fn reply(&self, turn: Turn, draft: DraftSink, cancel: CancellationToken) -> Result<Reply, BrainError>;
}

/// A yes/no a run needs from the owner (approval gates, `ask.confirm`). Implemented by the
/// gateway (asks in the chat the turn came from) and by a fake that always says no.
#[async_trait::async_trait]
pub trait Ask: Send + Sync {
    async fn confirm(&self, origin: &Origin, question: &Question, cancel: CancellationToken) -> bool;
}
#[derive(Clone, Debug)]
pub struct Question { pub run: RunId, pub text: String, pub detail: Option<String> }

// ---- permissions (plan.md, "Permission modes") ----
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode { AskEveryTime, AskRisky, WatchAndWarn, FullTrust }
pub enum Gate { Run, Ask, Refuse(String) }
/// `reviewed` is false for MCP-compatibility servers: their annotations count as destructive.
pub fn gate(mode: PermissionMode, annotations: Option<&alexia_mcp::types::ToolAnnotations>, reviewed: bool) -> Gate;

// ---- rails ----
#[derive(Clone, Copy, Debug)]
pub struct Limits { pub max_steps: u32, pub max_spend_usd: f64 }   // default 25 steps, 0.0 (D212)

// ---- providers and the router ----
#[derive(Clone, Debug)]
pub struct ChatRequest { pub messages: Vec<(Role, MessageBody)>, pub system: Option<String>,
                         pub tools: Vec<alexia_mcp::types::Tool>, pub max_tokens: Option<u32> }
#[derive(Clone, Debug, PartialEq)]
pub enum ChatChunk { Text(String), Reasoning(String), ToolCall(ToolCall) }
#[derive(Clone, Debug)]
pub struct ChatDone { pub model: String, /** (V3-1) */ pub provider: String, pub tokens_in: i64, pub tokens_out: i64,
                      pub cost: f64, pub first_byte_ms: Option<u32> }
#[derive(Debug, thiserror::Error)]
pub enum ProviderError { #[error("busy")] Busy { retry_after_ms: Option<u64> }, #[error("needs a key")] NeedsKey,
                         #[error("refused: {0}")] Refused(String), #[error("unreachable")] Unreachable,
                         #[error("stopped")] Cancelled, #[error("{0}")] Other(String) }
#[derive(Clone, Debug)]
pub struct ModelInfo { pub id: String, pub context: u32, pub free: bool, pub tools: bool, pub vision: bool }

#[async_trait::async_trait]
pub trait Provider: Send + Sync {
    fn id(&self) -> &str;
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError>;
    async fn chat(&self, req: &ChatRequest, model: &str, out: tokio::sync::mpsc::Sender<ChatChunk>,
                  cancel: CancellationToken) -> Result<ChatDone, ProviderError>;
}

/// (V3-1) SP-07: how long a channel can wait for the first byte. The router starts another
/// candidate each time this passes with nothing back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Budget { pub first_byte_ms: u32 }
impl Budget { pub const CHAT: Budget = Budget { first_byte_ms: 2_500 }; }

pub struct Router { /* providers by id, catalog, store */ }
impl Router {
    pub fn new(providers: Vec<Arc<dyn Provider>>, catalog: Arc<Catalog>, store: Arc<Store>) -> Router;
    /// D212 + SP-07: starts the best two free candidates at once; whichever sends a first chunk
    /// wins and the other is cancelled. Each time `budget.first_byte_ms` passes with no first
    /// chunk, one more candidate starts (at most 4 running). Records every try in `tries`.
    /// (V3-1) `budget` is the new third argument.
    pub async fn hedged(&self, req: &ChatRequest, budget: Budget, out: tokio::sync::mpsc::Sender<ChatChunk>,
                        cancel: CancellationToken) -> Result<ChatDone, ProviderError>;
    /// (V3-1) The ranked list `hedged` would use now, for the dashboard and tests.
    pub fn ranked(&self, now: Ms) -> Vec<Candidate>;
}

// ---- the agent loop (V3-2) ----
pub struct Agent { /* router, mcp, store, bus, ask, limits */ }
impl Agent {
    pub fn new(router: Arc<Router>, mcp: McpHost, store: Arc<Store>, bus: Bus, ask: Arc<dyn Ask>, limits: Limits) -> Agent;
}
impl Brain for Agent { /* ... */ }
/// `Agent` is also core's `Upcalls`: sampling from plugins goes through the same router and rails.
impl alexia_mcp::Upcalls for Agent { /* ... */ }
```

### 2.4 `alexia-gateway`

The gateway is the one place core speaks to outside messaging services. A channel is an adapter
for a **service** (Telegram's Bot API), compiled into the hub, not a plugin, and is the same kind
of deliberate exception as core's model providers (`Alexia.md`, *What core owns*). It lives only
under `crates/alexia-gateway/src/channels/`. See §8 for what this means for invariant check 1.

```rust
#[derive(Clone, Debug, PartialEq, Eq, Hash)] pub struct ChatRef { pub chat: String }   // the service's chat id, as text
#[derive(Clone, Debug, PartialEq, Eq, Hash)] pub struct MsgRef { pub id: String }
/// (V3-1) `Stop`: the owner asks to stop the answer being written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)] pub enum InKind { Message, Stop }
/// (V3-1) A file that came with a message, already downloaded under `layout.cache()`.
#[derive(Clone, Debug)] pub struct InFile { pub name: String, pub mime: String, pub path: PathBuf }
#[derive(Clone, Debug)]
pub struct Inbound { pub chat: ChatRef, pub msg: MsgRef, /** (V3-1) */ pub kind: InKind, pub from_owner: bool,
                     pub content: Content, /** (V3-1) */ pub files: Vec<InFile>, pub at: Ms }
#[derive(Clone, Debug)]
pub struct Outbound { pub text: String, pub files: Vec<OutFile>, /** (V3-1) send as a voice note */ pub voice: bool }

#[async_trait::async_trait]
pub trait Channel: Send + Sync {
    /// "telegram". Goes into `Origin::Channel { channel }` and the session map.
    fn name(&self) -> &'static str;
    /// (V3-1) SP-07: how long this surface can wait for a first word.
    fn budget(&self) -> alexia_core::Budget;
    /// Long-poll for the next batch. Nothing is exposed to the internet (CH-01).
    async fn next(&self, cancel: CancellationToken) -> Result<Vec<Inbound>>;
    /// The instant reaction (target: < 300 ms from receipt, V3-1).
    async fn react(&self, chat: &ChatRef, msg: &MsgRef, emoji: &str) -> Result<()>;
    async fn typing(&self, chat: &ChatRef) -> Result<()>;
    async fn send(&self, chat: &ChatRef, out: &Outbound) -> Result<MsgRef>;
    /// (V3-1) Show `text` as the message being written. `None` clears it. Rate limits come back
    /// as `Error::RateLimited`; the gateway paces itself.
    async fn draft(&self, chat: &ChatRef, text: Option<&str>) -> Result<()>;
    /// Replace a sent message in place.
    async fn edit(&self, chat: &ChatRef, msg: &MsgRef, text: &str) -> Result<()>;
    /// A yes/no with two buttons; `None` if the owner did not answer before `cancel`.
    async fn ask(&self, chat: &ChatRef, text: &str, cancel: CancellationToken) -> Result<Option<bool>>;
}

/// (V3-1) Voice in and out (CH-05). The hub implements it over `McpHost::call_capability`
/// (`voice.transcribe`, `voice.render`); tests use a fake. `None` = nothing installed can do it.
#[async_trait::async_trait]
pub trait Media: Send + Sync {
    async fn transcribe(&self, file: &InFile) -> Result<Option<String>>;
    async fn speak(&self, text: &str) -> Result<Option<OutFile>>;
}

#[derive(Clone, Debug)]
pub struct GatewayConfig {
    /// Messages from one chat this close together are merged into one turn.
    pub merge_ms: u64,            // (V3-1) 500
    /// Minimum gap between draft updates: Telegram's real rate; the gateway backs off on 429.
    pub draft_every_ms: u64,      // (V3-1) 300
    pub ack_emoji: String,        // "👀"
}
impl Default for GatewayConfig { /* 500, 300, "👀" */ }

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")] Service(String),                         // a sentence the owner can read
    #[error("rate limited")] RateLimited { retry_after_ms: u64 },
    #[error("another program is reading this bot's messages")] Conflict,   // 409
    #[error("the token was refused")] Unauthorized,           // 401
    #[error("unreachable")] Unreachable,
    #[error("stopped")] Cancelled,
    #[error(transparent)] Store(#[from] alexia_store::Error),
}
pub type Result<T> = std::result::Result<T, Error>;

pub struct Gateway { /* ... */ }
impl Gateway {
    /// (V3-1) `media` is new.
    pub fn new(cfg: GatewayConfig, store: Arc<Store>, bus: Bus, brain: Arc<dyn Brain>, media: Arc<dyn Media>) -> Gateway;
    pub fn add(&mut self, channel: Arc<dyn Channel>);
    /// Polls every channel, acks, merges, calls the brain with a draft sink, delivers.
    /// Also delivers `Event::Say` from the bus to the owner's primary chat.
    pub async fn run(self, cancel: CancellationToken) -> Result<()>;
    /// The gateway's `Ask`, for `Agent::new`.
    pub fn asker(&self) -> Arc<dyn alexia_core::Ask>;
}

pub mod channels {
    /// (V3-1) The `_core` secret keys channels read, for `alexia-hub secret set`.
    pub fn secret_keys() -> &'static [&'static str];
    /// (V3-1) Every channel whose secret is present.
    pub fn configured(store: Arc<Store>, layout: &Layout) -> Vec<Arc<dyn Channel>>;
}
```

The owner's chat on each channel maps to one session, stored in kv `_core.channel_sessions` as
`{"<channel>:<chat>": <session id>}` until the V3-1 migration gives it a table (§5.3).
(V3-1) That table is migration 2's `channel_chats`, reached through `Store::channel_session`.

### 2.5 `alexia-scheduler` (V3-3; types fixed now so the bus is stable)

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Trigger {
    At { at: Ms },
    Every { period_ms: u64, from: Ms },
    /// Local wall-clock time, every day (the morning brief).
    Daily { hour: u8, minute: u8 },
    /// Poll a capability; fire when its text result changes.
    Watch { cap: String, every_ms: u64 },
}
pub use alexia_core::{JobId, Urgency};             // Urgency { Low, Normal, High, Urgent }, PR-06
pub struct Job { pub id: JobId, pub trigger: Trigger, pub prompt: String, pub urgency: Urgency, pub created_at: Ms }
pub struct Quiet { pub from: (u8, u8), pub to: (u8, u8), pub lets_through: Urgency }   // PR-07

pub struct Scheduler { /* ... */ }
impl Scheduler {
    pub fn new(store: Arc<Store>, bus: Bus, brain: Arc<dyn Brain>) -> Scheduler;
    pub fn add(&self, trigger: Trigger, prompt: &str, urgency: Urgency) -> Result<JobId>;
    pub fn cancel(&self, id: JobId) -> Result<()>;
    pub fn jobs(&self) -> Result<Vec<Job>>;
    /// Fires due jobs through the brain (`Origin::Scheduler`); publishes `Event::Say` with the
    /// reply unless quiet hours hold it back, in which case it is kept and said at `to`.
    pub async fn run(self, cancel: CancellationToken) -> Result<()>;
}
pub fn held(now_local: (u8, u8), quiet: &Quiet, urgency: Urgency) -> bool;
```

"Act silently" (D214) is decided by core's permission gate, not here: a scheduled run uses the
same `gate()` and `Ask`, and anything outward-facing still asks.

### 2.6 `alexia-hub` (binary)

```
alexia-hub run                     start everything; Ctrl+C or the tray's Quit stops it cleanly
alexia-hub tools                   load plugins, print every enabled plugin's tools, exit (V3-0 done-when)
alexia-hub import-v2 <v2-folder>   §6; prints the ImportReport
alexia-hub plugins                 print PluginStatus for every plugin found
alexia-hub secret set <key>        (V3-1) reads the value without echo; key ∈ channels::secret_keys()
                                   or "provider_<id>" for an id in free::ladder()
alexia-hub secret clear <key>      (V3-1)
alexia-hub secret list             (V3-1) the allowed key names, never values
alexia-hub pair                    (V3-1) prints "<channel>\t<code>" per unpaired channel
alexia-hub latency [--last N] [--html FILE] [--check]   (V3-1) SP-09; --html writes the page
alexia-hub install | uninstall     (V3-1) watchdog::install / uninstall
```

Wiring in `run`: `Store::open(layout.db())` → `Bus::new(1024)` → `McpHost::new(.., Arc::new(NoUpcalls), sink)`
where `sink` publishes `Event::Plugin` → (V3-2) `Agent::new(.., host.clone(), ..)` then
`host.set_upcalls(agent.clone())` → (V3-1) `V2Bridge` or (V3-2) `Agent` as the `Brain` →
`Gateway` → `Scheduler`. Each `run` is a tokio task under one root `CancellationToken`.

```rust
/// V3-1 only: the v2 core answers. Speaks v2's local HTTP API at `base` (reached through
/// connect's forwarder when v2 runs on the Mac). Deleted at V3-2.
/// (V3-1)
pub struct V2Config {
    /// The v2 checkout (`ALEXIA_V2_ROOT`). Its `packages/core/dist/src/entry.js` must exist.
    pub root: PathBuf,
    /// Node (`ALEXIA_NODE`, else `node` on PATH).
    pub node: PathBuf,
    /// `ALEXIA_DATA_NAME` for the child: the v2 data folder under `%LOCALAPPDATA%`. Default "AlexiaBridge".
    pub data_name: String,
    /// Test hook and escape hatch: `ALEXIA_V2_URL` + `ALEXIA_V2_TOKEN` → don't spawn, use these.
    pub attach: Option<(String, String)>,
}
pub struct V2Bridge { /* config, child handle, url+token behind a RwLock, reqwest client, store, asker */ }
impl V2Bridge {
    /// (V3-1) Takes a `V2Config` and the store instead of a base url.
    pub fn new(cfg: V2Config, store: Arc<Store>) -> V2Bridge;
    /// (V3-1) The gateway's asker (CH-07). Set once after the gateway exists (the gateway needs
    /// the bridge as its brain first); until then every question is answered no.
    pub fn set_ask(&self, ask: Arc<dyn alexia_core::Ask>);
    /// (V3-1) Start (or attach), then keep v2 core alive until cancelled: if the child exits,
    /// start it again with backoff 1 s doubling to 60 s (HB-12). Kills the child on cancel.
    pub async fn run(&self, cancel: CancellationToken);
    /// (V3-1) Ready to answer (child up and its token read).
    pub fn ready(&self) -> bool;
}
impl Brain for V2Bridge { /* ... */ }
```

### 2.7 `alexia-limb` (binary, V3-4)

A limb is **an MCP server** (revision `2025-11-25`) that serves its device's tools, each with
`_meta["alexia/provides"]` (for example `screen.capture`-backed `computer.screenshot`), carried
over a connect stream. On the hub it appears to `McpHost` as one more plugin source whose
transport is the mesh instead of stdio. So the hub needs no limb-specific API: capabilities are
resolved exactly as for local plugins, and a limb going offline is a `Removed` event. The mesh
transport is specified in V3-4's phase plan; nothing in V3-0..3 depends on it.

---

## 3. The plugin wire

Everything here is what v2 core does today, so every plugin in `plugins/` runs unchanged.
Behaviour is in `docs/spec/wire-protocol.md`; this section fixes the Rust shapes and the subset
v3 serves in each phase.

### 3.1 JSON-RPC framing (`alexia_mcp::jsonrpc`)

- stdio, **one JSON message per line**, UTF-8, `\n`-terminated. No batches. stdout is the wire;
  stderr is captured into `McpHost::log`.
- Requests may be answered out of order; match on `id`. Core's ids are integers counting from 1
  per process. A plugin's ids may be strings or integers and are echoed verbatim.
- Exit: close stdin, wait `exit_grace_ms`, then terminate the Job Object (Windows has no SIGTERM).

```rust
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Id { Num(i64), Str(String) }

/// Serializes as "2.0"; deserializing anything else is an error.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct V2;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Request { pub jsonrpc: V2, pub id: Id, pub method: String,
                     #[serde(default, skip_serializing_if = "Option::is_none")] pub params: Option<Value> }
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Notification { pub jsonrpc: V2, pub method: String,
                          #[serde(default, skip_serializing_if = "Option::is_none")] pub params: Option<Value> }
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Response { pub jsonrpc: V2, pub id: Id, #[serde(flatten)] pub outcome: Outcome }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome { Result(Value), Error(RpcError) }
#[derive(Clone, Debug, Serialize, Deserialize, thiserror::Error)]
#[error("{code}: {message}")]
pub struct RpcError { pub code: i32, pub message: String,
                      #[serde(default, skip_serializing_if = "Option::is_none")] pub data: Option<Value> }

/// Tried in this order: a line with `id` and `method` is a Request, `id` and `result|error` a
/// Response, `method` alone a Notification.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Message { Request(Request), Response(Response), Notification(Notification) }

pub mod code {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
    pub const MISSING_REQUIRED_CLIENT_CAPABILITY: i32 = -32021;
    pub const UNSUPPORTED_PROTOCOL_VERSION: i32 = -32022;   // data: {supported: [..], requested}
    pub const CAPABILITY_NOT_AVAILABLE: i32 = -32050;
    pub const CAPABILITY_NOT_PERMITTED: i32 = -32051;
    pub const STORAGE_OUT_OF_NAMESPACE: i32 = -32052;
    pub const SETTING_UNKNOWN: i32 = -32053;
    pub const DENIED_BY_USER: i32 = -32054;
    pub const CAP_EXCEEDED: i32 = -32055;
}
impl RpcError { pub fn new(code: i32, message: impl Into<String>) -> Self; pub fn method_not_found() -> Self; }
```

### 3.2 Spawn and handshake

| | |
|---|---|
| command | `entry.run`; `"node"` → `HostConfig::node`. Otherwise and for every arg naming a file in the plugin folder: made absolute against the folder. |
| cwd | `layout.own_dir(id)`, created before spawn, **never the plugin folder** (Windows can't delete a running process's cwd). |
| env | Only: `APPDATA HOMEDRIVE HOMEPATH LOCALAPPDATA PATH PATHEXT PROCESSOR_ARCHITECTURE PROGRAMFILES SYSTEMDRIVE SYSTEMROOT TEMP TMP USERNAME USERPROFILE` (what v2's MCP SDK passes on Windows), plus `ALEXIA_PLUGIN_DIR=<plugin folder>`. |
| Windows | `CREATE_NO_WINDOW`; assigned to a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so a plugin's own children die with it and with the hub. |
| before spawn | `Manifest::compatible()` (alexia_protocol in 2..=15, min_app/max_app). Fail → `Refused`, no process. |

v3 speaks **`2025-11-25` only**. Every plugin in `plugins/` declares it. `2026-07-28`-only
servers (MCP compatibility mode) are added when that mode is ported; until then they are refused
with v2's sentence. Core does not probe `server/discover`.

```jsonc
// core → plugin
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion":"2025-11-25",
  "clientInfo":{"name":"Alexia","version":"3.0.0"},
  "capabilities":{"roots":{}}}}                 // + "sampling":{} from V3-2, + "elicitation":{} when there is somewhere to ask
// plugin → core
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25",
  "serverInfo":{"name":"…","version":"…"},"capabilities":{"tools":{"listChanged":true}},
  "instructions":"…"}}
// core → plugin
{"jsonrpc":"2.0","method":"notifications/initialized"}
// core → plugin
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

A returned `protocolVersion` other than the manifest's `mcp_protocol` is a refusal. No answer in
`start_ms` is a failed start (counts toward `crash_limit`).

### 3.3 MCP messages v3 uses (`alexia_mcp::types`, all camelCase on the wire)

| Method | Direction | V3 phase |
|---|---|---|
| `initialize`, `notifications/initialized` | core → plugin | V3-0 |
| `ping` | both; core every `heartbeat_ms`, answers plugin pings with `{}` | V3-0 |
| `tools/list` (follows `nextCursor`), `tools/call` | core → plugin | V3-0 |
| `notifications/tools/list_changed` | plugin → core | V3-0 |
| `notifications/progress` | both directions, against a `progressToken` | V3-0 |
| `notifications/cancelled` `{requestId, reason?}` | both | V3-0 |
| `notifications/message` | plugin → core (only if core set a log level; v3 sets none) | ignored |
| `roots/list` → `{roots:[{uri,name?}]}` | plugin → core | V3-0 (from `Upcalls::roots`) |
| `sampling/createMessage` | plugin → core | V3-2 (`-32021` before) |
| `elicitation/create` (form mode) | plugin → core | when offered |
| `prompts/*`, `resources/*`, `completion/*` | not used | — |

```rust
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Empty {}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Implementation { pub name: String, pub version: String }
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ClientCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")] pub roots: Option<Empty>,
    #[serde(skip_serializing_if = "Option::is_none")] pub sampling: Option<Empty>,
    #[serde(skip_serializing_if = "Option::is_none")] pub elicitation: Option<Empty>,
}
#[derive(Clone, Debug, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct InitializeParams { pub protocol_version: String, pub client_info: Implementation, pub capabilities: ClientCapabilities }
#[derive(Clone, Debug, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct InitializeResult { pub protocol_version: String, pub server_info: Implementation,
                              #[serde(default)] pub capabilities: Value, pub instructions: Option<String> }

#[derive(Clone, Debug, Default, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct ToolAnnotations { pub title: Option<String>, pub read_only_hint: Option<bool>, pub destructive_hint: Option<bool>,
                             pub idempotent_hint: Option<bool>, pub open_world_hint: Option<bool> }
#[derive(Clone, Debug, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct Tool {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub description: Option<String>,
    pub input_schema: Value,
    #[serde(skip_serializing_if = "Option::is_none")] pub output_schema: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")] pub annotations: Option<ToolAnnotations>,
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")] pub meta: Option<Map<String, Value>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct ListToolsResult { pub tools: Vec<Tool>, pub next_cursor: Option<String> }
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CallToolParams { pub name: String, #[serde(skip_serializing_if = "Option::is_none")] pub arguments: Option<Map<String, Value>>,
                            #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")] pub meta: Option<Map<String, Value>> }
/// MCP owns this shape; core passes `content` through unread (v2's loose CallToolResult).
#[derive(Clone, Debug, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct CallToolResult {
    pub content: Vec<Value>,                       // each has a "type"
    #[serde(skip_serializing_if = "Option::is_none")] pub structured_content: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub is_error: Option<bool>,
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")] pub meta: Option<Map<String, Value>>,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)] #[serde(untagged)]
pub enum ProgressToken { Num(i64), Str(String) }
#[derive(Clone, Debug, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct ProgressParams { pub progress_token: ProgressToken, pub progress: f64, pub total: Option<f64>, pub message: Option<String>,
                            #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")] pub meta: Option<Map<String, Value>> }
#[derive(Clone, Debug, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct CancelledParams { pub request_id: crate::jsonrpc::Id, pub reason: Option<String> }
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Root { pub uri: String, #[serde(skip_serializing_if = "Option::is_none")] pub name: Option<String> }  // file:///C:/…
/// Fields core reads; the rest is kept and forwarded.
#[derive(Clone, Debug, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct CreateMessageParams {
    pub messages: Vec<Value>, pub system_prompt: Option<String>, pub max_tokens: Option<u32>,
    pub model_preferences: Option<Value>,
    #[serde(rename = "_meta")] pub meta: Option<Map<String, Value>>,
    #[serde(flatten)] pub rest: Map<String, Value>,
}
```

A tool that failed at its job returns `isError: true` in a normal result. JSON-RPC errors from a
plugin mean "malformed" or "no such tool" and end the step.

### 3.4 The `alexia/*` layer (`alexia_mcp::alexia`)

Requests a plugin sends to core during a session. Unknown keys in `params` (notably `_meta`) are
ignored. All are answered by `McpHost` itself except where the table says `Upcalls`.

| Method | params | result | Served by / from |
|---|---|---|---|
| `alexia/settings/get` | `{}` | `{"settings":{<key>:<value>}}` every declared key, user value or default; `password` read from Credential Manager now | host, V3-0 |
| `alexia/settings/set` | `{"key","value"}` — only a declared `status` key; value ≤ 65536 B of JSON | `{}`; `-32053` unknown key, `-32602` not a `status` | host, V3-0 |
| `alexia/storage/insert` | `{"table","row"}` | `{"rowid":n}` | host, V3-0 |
| `alexia/storage/select` | `{"table","where"?,"order"?:[[col,"asc"\|"desc"]],"limit"?,"offset"?}` | `{"rows":[…]}` | host, V3-0 |
| `alexia/storage/update` | `{"table","set","where"}` (where non-empty) | `{"changed":n}` | host, V3-0 |
| `alexia/storage/delete` | `{"table","where"}` xor `{"table","all":true}` | `{"deleted":n}` | host, V3-0 |
| `alexia/storage/count` | `{"table","where"?}` | `{"count":n}` | host, V3-0 |
| `alexia/storage/kv/get` | `{"key"}` | `{"value"?}` (absent when unset) | host, V3-0 |
| `alexia/storage/kv/set` | `{"key","value"}` (≤ 65536 B) | `{}` | host, V3-0 |
| `alexia/storage/kv/delete` | `{"key"}` | `{}` | host, V3-0 |
| `alexia/storage/raw` | `{"sql","params"?:[scalar]}` | `{"rows":[…]}`; `-32052` outside namespace | host, V3-0 |
| `alexia/capability/call` | `{"cap","arguments"?}` | a `CallToolResult`, provider never named; `-32050`/`-32051` | host, V3-0 |
| `alexia/answers` | `{"cap"}` | `{"answers":bool,"here":bool}` | host, V3-0 |
| `alexia/host/info` | `{}` | `HostInfo` below | host + `Upcalls::host_facts`, V3-0 |
| `alexia/compute/run` | `{"cap","arguments"?,"inputs"?:[{"name","path","mime"}]}` | `{"text"?,"files":[abs path]}` | host, V3-2 local only; V3-4 paired; `-32050` before |
| `alexia/attachments/lease` | `{"conversationId","attachmentIds":[1..8]}` | v2 `AttachmentCallContext` | `Upcalls::attachments`, V3-2 |
| `alexia/attachments/release` | `{"leaseId"}` | `{}` | same |
| `alexia/attachments/live` | `{"leaseId"}` | `{"live":bool}` | same |
| `alexia/attachments/register` | `{"conversationId","path","origin":"approved_result"\|"deterministic_transform"\|"normalized","name"?}` | v2 `AttachmentDescriptor` | same |
| `alexia/attachments/share` | `{"conversationId","path","mime"}` | `{"url"}` | same |

Notifications core sends to plugins:

| Method | params | When |
|---|---|---|
| `alexia/settings/changed` | `{"changed":{<key>:<value>}}` only changed keys | owner edits a setting while the plugin runs |
| `alexia/conversation/ended` | `{}` (deliberately nothing about the conversation) | a session ends (`/new`, or a channel's idle cut) |

```rust
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrivacyMode { Local, Combined, Cloud }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub platform: String,        // Node's names: "win32" | "darwin" | "linux"
    pub arch: String,            // Node's names: "x64" | "arm64"
    pub alexia_version: String,  // APP_VERSION
    pub alexia_protocol: u32,    // ALEXIA_PROTOCOL_MAX
    pub display_name: String,    // data, never compared to a name
    pub privacy_mode: PrivacyMode,
    pub paths: HostPaths,
    pub locale: String,          // BCP 47, e.g. "en-GB"
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPaths { #[serde(skip_serializing_if = "Option::is_none")] pub own_dir: Option<String>,  // only with fs.own_dir
                       pub cache_dir: String }

/// One request from a plugin, parsed by method name. `params: None` parses as `{}`.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum AlexiaCall {
    #[serde(rename = "alexia/settings/get")]      SettingsGet(Empty),
    #[serde(rename = "alexia/settings/set")]      SettingsSet(KeyValue),
    #[serde(rename = "alexia/storage/insert")]    Insert(InsertParams),
    #[serde(rename = "alexia/storage/select")]    Select(SelectParams),
    #[serde(rename = "alexia/storage/update")]    Update(UpdateParams),
    #[serde(rename = "alexia/storage/delete")]    Delete(DeleteParams),
    #[serde(rename = "alexia/storage/count")]     Count(CountParams),
    #[serde(rename = "alexia/storage/kv/get")]    KvGet(Key),
    #[serde(rename = "alexia/storage/kv/set")]    KvSet(KeyValue),
    #[serde(rename = "alexia/storage/kv/delete")] KvDelete(Key),
    #[serde(rename = "alexia/storage/raw")]       Raw(RawParams),
    #[serde(rename = "alexia/capability/call")]   CapabilityCall(CapabilityCallParams),
    #[serde(rename = "alexia/answers")]           Answers(Cap),
    #[serde(rename = "alexia/host/info")]         HostInfo(Empty),
    #[serde(rename = "alexia/compute/run")]       ComputeRun(ComputeRunParams),
    #[serde(rename = "alexia/attachments/lease")]    AttachmentsLease(Value),
    #[serde(rename = "alexia/attachments/release")]  AttachmentsRelease(Value),
    #[serde(rename = "alexia/attachments/live")]     AttachmentsLive(Value),
    #[serde(rename = "alexia/attachments/register")] AttachmentsRegister(Value),
    #[serde(rename = "alexia/attachments/share")]    AttachmentsShare(Value),
}
impl AlexiaCall {
    /// Ok(None): not an alexia/* method. Err: an alexia/* method with bad params (-32602).
    pub fn parse(method: &str, params: Option<Value>) -> Result<Option<AlexiaCall>, RpcError>;
}
/// What `Upcalls::attachments` receives: the method's last segment and its raw params.
/// Shapes are v2's `packages/protocol/src/private-context.ts`, ported when V3-2 implements them.
pub struct AttachmentsCall { pub op: &'static str, pub params: Value }

#[derive(Clone, Debug, Deserialize)] pub struct Key { pub key: String }
#[derive(Clone, Debug, Deserialize)] pub struct KeyValue { pub key: String, pub value: Value }
#[derive(Clone, Debug, Deserialize)] pub struct Cap { pub cap: String }
#[derive(Clone, Debug, Deserialize)] pub struct InsertParams { pub table: String, pub row: Row }
#[derive(Clone, Debug, Deserialize)] pub struct SelectParams { pub table: String, #[serde(rename = "where")] pub filter: Option<Where>,
                                                               #[serde(default)] pub order: Vec<(String, Dir)>, pub limit: Option<u64>, pub offset: Option<u64> }
#[derive(Clone, Debug, Deserialize)] pub struct UpdateParams { pub table: String, pub set: Row, #[serde(rename = "where")] pub filter: Where }
#[derive(Clone, Debug, Deserialize)] pub struct DeleteParams { pub table: String, #[serde(rename = "where")] pub filter: Option<Where>, pub all: Option<bool> }
#[derive(Clone, Debug, Deserialize)] pub struct CountParams { pub table: String, #[serde(rename = "where")] pub filter: Option<Where> }
#[derive(Clone, Debug, Deserialize)] pub struct RawParams { pub sql: String, #[serde(default)] pub params: Vec<Scalar> }
#[derive(Clone, Debug, Deserialize)] pub struct CapabilityCallParams { pub cap: String, pub arguments: Option<Map<String, Value>> }
#[derive(Clone, Debug, Deserialize)] pub struct ComputeInput { pub name: String, pub path: String, pub mime: String }
#[derive(Clone, Debug, Deserialize)] pub struct ComputeRunParams { pub cap: String, pub arguments: Option<Map<String, Value>>,
                                                                   #[serde(default)] pub inputs: Vec<ComputeInput> }
```

Example (the shapes `@alexia/sdk` sends and expects; argument names and error wording are illustrative):

```jsonc
→ {"jsonrpc":"2.0","id":9,"method":"alexia/settings/get","params":{"_meta":{}}}
← {"jsonrpc":"2.0","id":9,"result":{"settings":{"greeting":"Hello","tone":"warm","exclaim":false,"extras":[]}}}
→ {"jsonrpc":"2.0","id":10,"method":"alexia/capability/call","params":{"cap":"demo.greet","arguments":{"who":"Sam"}}}
← {"jsonrpc":"2.0","id":10,"result":{"content":[{"type":"text","text":"Hello, Sam — good to see you."}],"isError":false}}
← {"jsonrpc":"2.0","id":11,"error":{"code":-32050,"message":"Nothing installed and switched on can do demo.greet."}}
```

### 3.5 `_meta` keys

`_meta` is MCP's extension point. v3 reads only the keys marked **read**; every other key is
passed through untouched in both directions, so a newer plugin loses nothing on an older hub.

| Key | Where | v3 |
|---|---|---|
| `progressToken` | any request `_meta` | read; echoed on progress |
| `alexia/provides` `[cap]` | `Tool._meta` | **read** (V3-0): capability binding |
| `alexia/compute` `{op}`\|`{hook}` | `Tool._meta` | **read** (V3-0): hide from model; compute target |
| `alexia/editor` `{editor:"1"}` | `Tool._meta` | **read** (V3-0): hide from model |
| `alexia/attachmentInputs` | `Tool._meta` | V3-2 |
| `alexia/call-context` `{conversationId}` | `tools/call` request, core sets | V3-0 when `CallCtx.conversation` is set |
| `alexia/privateContext` `{protocol,capabilities}` | `tools/call` request, core sets | V3-2 |
| `alexia/attachmentContext`, `alexia/adult` | `tools/call` request, core sets | V3-2 |
| `alexia/tools` `true` | `sampling/createMessage` request | V3-2: run the agent loop |
| `alexia/lengths` | sampling request and result | V3-2 |
| `alexia/local` `true`, `alexia/format` | sampling request | V3-2: this computer only, schema-held answer; refused if no local model |
| `alexia/stream` `{delta?,restart?,phase?}` | progress core → plugin during sampling | V3-2 |
| `alexia/command`, `alexia/files` `[{name,mime,data}]` | sampling result | V3-2 |
| `alexia/final`, `alexia/timing`, `alexia/card` | `CallToolResult._meta` | V3-2 (agent loop) |
| `alexia/preview`, `alexia/stages`, `alexia/plan`, `alexia/controls`, `alexia/research` | progress plugin → core | passed to the trace / dashboard; V3-2 |

---

## 4. The event bus (`alexia_core::bus`)

The bus says **what happened**. It is never the only record of anything: state lives in the
store, and a subscriber that lags and loses events must recover by reading the store. Commands
("do X") are method calls, not events.

```rust
#[derive(Clone)]
pub struct Bus { tx: tokio::sync::broadcast::Sender<std::sync::Arc<Event>> }
impl Bus {
    pub fn new(capacity: usize) -> Bus;                 // hub uses 1024
    /// Never blocks, never fails; with no subscribers the event is dropped.
    pub fn publish(&self, event: Event);
    /// A lagging receiver gets `RecvError::Lagged(n)` and continues; handle it, never unwrap.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<std::sync::Arc<Event>>;
}

#[derive(Debug)]
pub enum Event {
    // ---- gateway ----
    /// A turn was accepted (after merging) and handed to the brain.
    Received { at: Ms, origin: Origin, session: SessionId },
    /// The instant reaction landed. `ms` is receipt → reaction.
    Acked { at: Ms, origin: Origin, ms: u32 },
    /// A reply was delivered. `spans` feed the latency dashboard.
    Delivered { at: Ms, origin: Origin, session: SessionId, lane: Lane, spans: Vec<Span> },
    /// Something to tell the owner unprompted. The gateway delivers it to the primary chat.
    Say { at: Ms, text: String, urgency: Urgency, job: Option<JobId> },

    // ---- core ----
    RunStarted { at: Ms, run: RunId, session: SessionId, origin: Origin },
    RunStep { at: Ms, run: RunId, step: u32, summary: String },
    RunEnded { at: Ms, run: RunId, outcome: RunOutcome },
    ConversationEnded { at: Ms, session: SessionId },
    SettingsChanged { at: Ms, owner: String /* plugin id or "_core" */, keys: Vec<String> },
    Plugin(alexia_mcp::PluginEvent),

    // ---- scheduler ----
    Fired { at: Ms, job: JobId },

    // ---- limbs (V3-4) ----
    PeerOnline { at: Ms, peer: String },
    PeerOffline { at: Ms, peer: String },

    // ---- hub ----
    ShuttingDown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunOutcome { Done, Stopped, Limit, Failed }
```

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Urgency { Low, Normal, High, Urgent }     // PR-06; re-exported by alexia-scheduler
```

`Urgency` lives in core, not the scheduler, so the bus never depends upward. Events carry no message text
except `Say` and `RunStep.summary` (which is redacted like v2's trace); a debugging subscriber
cannot leak a conversation.

Adding a variant is allowed in any task that needs it (all matches use `_ =>`); renaming or
removing one is a change to this file.

---

## 5. The database

One file, `layout.db()`. SQLite (bundled), WAL, `foreign_keys=ON`. Core owns it; plugins reach
only their namespace through §3.4.

### 5.1 Migration 1 — the first v3 schema

It is v2's schema after its eleven migrations, collapsed into one, with v3's markers. Column
names and meanings are v2's so the importer copies rows without transforming them.

```sql
PRAGMA application_id = 1095522355;   -- 0x414C5833, 'ALX3': refuses to be mistaken for a v2 file

-- core's settings and small values. ns "_core" is core's; a plugin's kv uses its plugin id.
CREATE TABLE kv (
  ns    TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,            -- JSON
  PRIMARY KEY (ns, key)
);
-- every non-secret setting value; plugin = plugin id or "_core". Secrets are in Credential Manager.
CREATE TABLE settings (
  plugin TEXT NOT NULL,
  key    TEXT NOT NULL,
  value  TEXT NOT NULL,           -- JSON
  PRIMARY KEY (plugin, key)
);

CREATE TABLE sessions (
  id            INTEGER PRIMARY KEY,
  title         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  image_ordinal INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  model      TEXT,
  body       TEXT NOT NULL,       -- JSON MessageBody (§2.1)
  at         INTEGER NOT NULL
);
CREATE INDEX messages_by_session ON messages (session_id, id);

-- the router's ledgers
CREATE TABLE provider_usage (
  provider TEXT NOT NULL,
  span     TEXT NOT NULL,         -- 'minute' | 'day'
  bucket   INTEGER NOT NULL,
  count    INTEGER NOT NULL,
  PRIMARY KEY (provider, span, bucket)
);
CREATE TABLE usage (
  id         INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL,
  session_id INTEGER,             -- no FK: the ledger outlives a deleted conversation
  plugin     TEXT,
  model      TEXT NOT NULL,
  provider   TEXT NOT NULL,
  tokens_in  INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost       REAL NOT NULL,
  run_id     TEXT,
  asked      TEXT,
  writing    INTEGER              -- ms, first sign of life → last byte
);
CREATE INDEX usage_at ON usage (at);
CREATE INDEX usage_by_run ON usage (run_id);
CREATE TABLE tries (
  at       INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model    TEXT NOT NULL,
  outcome  TEXT NOT NULL,         -- v2's Outcome strings
  status   INTEGER NOT NULL,
  source   TEXT NOT NULL,         -- 'chat' | 'plugin' | 'test' | 'person'
  waited   INTEGER                -- ms to first sign of life
);
CREATE INDEX tries_at ON tries (at);
CREATE TABLE seen (
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  list_known INTEGER NOT NULL,
  gone_at    INTEGER,
  PRIMARY KEY (provider, model)
);

-- run history (the trace), newest 200 / 30 days
CREATE TABLE runs (
  id   TEXT PRIMARY KEY,
  at   INTEGER NOT NULL,
  body TEXT NOT NULL              -- JSON, credentials stripped before writing
);
CREATE INDEX runs_at ON runs (at);

-- pictures that stay with their conversation; files under uploads\<session>\
CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  label        TEXT NOT NULL,
  display_name TEXT NOT NULL,
  mime         TEXT NOT NULL,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  file         TEXT NOT NULL,     -- relative to uploads\
  origin       TEXT NOT NULL,
  state        TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX attachments_session ON attachments (session_id);
CREATE TABLE attachment_leases (
  id             TEXT PRIMARY KEY,
  session_id     INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  attachment_ids TEXT NOT NULL,   -- JSON array
  state          TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

-- v3's own: one row per v2 import, so it happens once
CREATE TABLE imports (
  id          INTEGER PRIMARY KEY,
  at          INTEGER NOT NULL,
  v2_schema   INTEGER NOT NULL,   -- the v2 file's user_version
  report      TEXT NOT NULL       -- JSON ImportReport
);

PRAGMA user_version = 1;
```

### 5.2 Plugin tables

Not in any migration. `p_<ns>_<table>` (ns with `-` → `_`) is created at enable as
`CREATE TABLE IF NOT EXISTS p_<ns>_<table> (rowid INTEGER PRIMARY KEY)` and grows a column the
first time an insert carries a new key: `INTEGER` for integers and booleans, `REAL` for other
numbers, `TEXT` for strings, objects and arrays (JSON). Exactly v2 (`storage.md`). Purge drops
them all.

### 5.3 How the schema grows

Forward-only migrations in `alexia-store/src/migrations.rs`: a `const MIGRATIONS: &[&str]`
whose index + 1 is the `user_version`. Each runs in its own transaction with its version bump.
Never edit or remove one that has merged. Planned, so tasks don't collide on numbers (each phase
plan confirms its own):

| # | Phase | Adds |
|---|---|---|
| 2 | V3-1 | `channel_chats (channel, chat, session_id, is_primary)`, `spans (turn, at, origin, lane, name, start, ms)` for SP-09 (V3-1: below) |
| 3 | V3-2 | `audit (at, run_id, plugin, tool, gate, decision)` |
| 4 | V3-3 | `jobs`, `job_runs`; `sqlite-vec` virtual table for embeddings; life graph tables |

(V3-1) Migration 2. `primary` is spelled `is_primary` (`PRIMARY` is an SQL keyword); `spans`
gains `turn`, which groups the stages of one message.

```sql
CREATE TABLE channel_chats (
  channel    TEXT NOT NULL,
  chat       TEXT NOT NULL,
  session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  is_primary INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel, chat)
);
CREATE TABLE spans (
  turn   TEXT NOT NULL,
  at     INTEGER NOT NULL,      -- when the turn was received (ms)
  origin TEXT NOT NULL,         -- JSON Origin
  lane   TEXT NOT NULL,         -- 'command' | 'chat' | 'task'
  name   TEXT NOT NULL,
  start  INTEGER NOT NULL,      -- ms
  ms     INTEGER NOT NULL
);
CREATE INDEX spans_at ON spans (at);
CREATE INDEX spans_turn ON spans (turn);
```

---

## 6. The v2 importer

`alexia-hub import-v2 <folder>` → `alexia_store::import::import_v2`. The folder is a **copy of
a whole v2 data folder taken while v2 was quit** (on the Mac it is
`~/Library/Application Support/Alexia`, on Windows `%LOCALAPPDATA%\Alexia`). It must include
`alexia.db-wal` if one exists. The importer first opens the copy once to run
`PRAGMA wal_checkpoint(TRUNCATE)`, closes it, then reads it only through a read-only `ATTACH`. It
never opens v2's live folder.

Checks first, in this order, each refusing with a sentence:
1. `<folder>\alexia.db` exists and `application_id` is 0 (a v2 file, not a v3 one).
2. Its `user_version` is 1..=11 (the v2 migrations this build knows). Newer: "This v2 data is
   from a newer Alexia than the importer knows."
3. The v3 store has no row in `imports` and no session.

Then one transaction on the v3 store (`ATTACH` the v2 file read-only as `v2`):

| v2 | v3 | How |
|---|---|---|
| `sessions` | `sessions` | ids kept; `image_ordinal` 0 if v2 < 11 |
| `messages` | `messages` | ids and `body` copied verbatim; rows whose `body` does not parse as `MessageBody` are copied anyway and listed in `skipped` as a warning |
| `kv` | `kv` | verbatim, every ns (`_core` keys such as `mode`, `display_name`, `enabled`, `pins`, `ceilings`, `caps`, `scope`, `boundaries`, and each plugin's own) |
| `settings` | `settings` | verbatim |
| `provider_usage`, `usage`, `tries`, `seen`, `runs` | same names | verbatim; columns a v2 file lacks (older user_version) are NULL. `strikes` (v2 6, dropped in 7) ignored |
| `attachments` | `attachments` | verbatim |
| `attachment_leases` | — | **not copied**: a lease is a live authorization, not history |
| `p_<ns>_<table>` | `p_<ns>_<table>` | `CREATE` from v2's `sqlite_master.sql`, then `INSERT … SELECT *`. This is where plugin data lives, including the memory plugin's long-term memory |
| anything else | — | listed in `skipped` |

Then files, copied (never moved), each only if present:

| v2 folder | v3 folder |
|---|---|
| `plugins\<id>\` (plugins' own dirs) | `layout.own_dir(id)` |
| `extensions\<id>\` (installed plugins) | `layout.extensions()\<id>\` |
| `skills\` | `layout.skills()` |
| `uploads\` | `layout.uploads()` |
| `cache\` | not copied |

Finally a row in `imports` with the `ImportReport` (table → row count, files, skipped). The
import is all or nothing for the database; a file-copy failure after commit is reported and can
be repeated with `--files-only`.

**Secrets are not imported.** They are in the v2 machine's keychain, not the data folder. v3
uses the same service and account names (`alexia`, `<owner>.<key>`), so on a Windows machine
that ran v2 they may already resolve; on the PC importing from the Mac, the owner re-enters
them once (the hub lists which `password` settings are empty).

**Done when (V3-0):** a test builds a v2 file by running v2's eleven migrations' SQL (copied
into a test fixture from `packages/core/src/store.ts`) plus a `p_memory_notes` table, imports it,
and asserts every row count, one message body round-trip, and that `history()` returns the v2
conversation in order.

---

## 7. Invariant checks for v3

Run in CI on `windows-latest`, every push to `cr3studioo/v3` and every task branch.

| # | Check | How |
|---|---|---|
| 1 | **no crate names a plugin** | For every folder name under `plugins/`, grep `v3/crates/*/src` (word boundary, case-insensitive). Fails on any hit, except a channel adapter file under `crates/alexia-gateway/src/channels/` naming the *service* it speaks to (§8). Also fails on any path containing `plugins/` or `plugins\` in v3 source. |
| 2 | **boots with no plugins** | `cargo test --workspace` with `ALEXIA_PLUGINS_DIR` pointing at an empty temp folder and `plugins/` renamed away. Host tests use the fixture below, never `plugins/`. |
| 3 | **crasher contained** | fixture exits, hangs, floods stdout with junk; the host stays up, backs off, marks it `Unhealthy` after 3 crashes in 60 s. |
| 4 | **vanisher** | fixture's folder deleted mid-call: `CallError::Gone`, `Removed` emitted, its tools gone from `tools()`. (The re-plan half lands with the agent loop, V3-2.) |
| 5 | **purge leaves no residue** | snapshot DB schema + rows and the data folder; enable, use storage/kv/settings/own dir, purge; diff is empty. |
| 7 | **no hard-coded paths** | grep v3 source for `C:\\`, `/home/`, `/Users/`, `"\\"` in path building. |
| 8 | **no over-claiming strings** | v2's word list, over v3 user-facing strings. |
| 9 | **memory budget** | `alexia-hub run` with plugins enabled but idle: hub < 60 MB working set (a first target, tightened once measured); zero plugin processes for `lazy` plugins. |
| V2 | **v2 plugins conformance** (separate job, not part of 2) | `pnpm install && pnpm build`, then `alexia-hub tools` with `ALEXIA_PLUGINS_DIR=<repo>\plugins` lists `hello`'s tools; a `hello` → `capability/call` round trip; `crasher` and `vanisher` behave as 3 and 4. |

**The fixture.** `alexia-mcp` has `src/bin/mcp-fixture.rs`, a ~150-line MCP server in Rust,
`mcp-fixture <mode>` with modes `hello | crasher-exit | crasher-hang | crasher-junk | vanisher |
storage`. Tests write a `plugin.json` into a temp folder whose `entry.run` is
`env!("CARGO_BIN_EXE_mcp-fixture")`, so host tests need neither Node nor `plugins/`.

(v2 check 6 is about `packages/ui` and check 10 about Rust line count in `src-tauri`; neither
applies to v3.)

---

## 8. Risky or unclear — decided here, owner may overrule

1. **Telegram in the gateway vs "Telegram is a plugin".** `Alexia.md` puts every channel,
   Telegram included, in the plugin column; `v3-plan.md` *Shape* and D210 put channels in the
   hub's gateway. This file follows the plan (D209–D217 are settled). The invariant still holds,
   because there is no plugin folder to delete for a built-in channel, but check 1's grep would
   trip on `telegram`, hence the narrow exception for `crates/alexia-gateway/src/channels/`.
   **Also:** the v2 `telegram` plugin and the gateway must not long-poll the same bot. Telegram
   answers the second poller with `409 Conflict`; the gateway shows that as "Another program is
   reading this bot's messages" and backs off. It does not detect or disable any plugin by name.
2. **V3-1 bridge reach.** "In front of the v2 core" means the hub (PC) talks to v2 core, which
   today runs on the Mac. `V2Bridge` goes through connect's HTTP forwarder; if the Mac sleeps,
   V3-1 answers nothing. Running v2 core on the PC for V3-1 avoids that; the V3-1 planner decides.
3. **Only MCP `2025-11-25`** at first. Every plugin in `plugins/` uses it; `2026-07-28` comes
   back with compatibility mode.
4. **Hand-written JSON-RPC instead of an MCP crate.** Core's main job is serving `alexia/*`
   requests *from* servers during a call. That is about 300 lines of serde over line-delimited
   stdio, and an SDK that hides the server → client direction would cost more than it saves.
5. **Running v2 plugins from source** needs Node plus `pnpm install && pnpm build` (they import
   `@alexia/sdk` from `dist/`). Registry-installed copies are self-contained. The hub finds Node
   through `ALEXIA_NODE` or `PATH`; bundling Node with the hub is a V3-2 packaging decision.
6. **Integer ids and the Mac fallback (D211).** Session and message ids stay v2's integers so the
   import copies them as-is. When the Mac answers while the hub is off (V3-4), its new rows need
   remapping on sync. That is V3-4's problem, and nothing earlier relies on ids being global.
7. **Keychain compatibility.** v2 on Windows wrote credentials through `cross-keychain`. Whether
   `keyring` 4 reads those same entries is unverified. The V3-0 store task checks it on a Windows
   machine with one dummy secret and records the result in its report.
8. **GPU stepping aside (D213, MO-09).** v2 manifests have no field that says "uses the GPU",
   and strict parsing means v3 cannot add one without breaking v2. The hub finds GPU-holding
   plugin processes by pid (`McpHost::pid`, NVML) and `stop`s them. That is designed at V3-6.
```
