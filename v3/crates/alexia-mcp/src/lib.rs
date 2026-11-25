// SPDX-License-Identifier: AGPL-3.0-only
//! The MCP host: manifest loader, supervisor, JSON-RPC over stdio, the `alexia/*` layer, capability resolution.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

pub mod alexia;
mod conn;
mod error;
mod host;
mod job;
pub mod jsonrpc;
pub mod manifest;
mod process;
mod serve;
mod supervise;
pub mod types;
mod uri;
pub mod wasm;

/// Crate-private pieces, re-exported only so `tests/conn.rs` can drive them.
#[doc(hidden)]
pub mod testing {
    pub use crate::conn::{Conn, Incoming};
    pub use crate::job::Job;
    pub use crate::process::{spawn, stop, Proc, StderrLog};
}

pub use alexia_store::{Cond, Dir, Operator, Row, Scalar, Where};
pub use error::{Error, Result};
pub use host::McpHost;
pub use manifest::{discover, Manifest, ManifestError, PluginDir};
pub use process::redact;
pub use uri::{file_uri_path, is_network_path};

/// A plugin's id as read from its manifest. Opaque to everything above this crate: core may
/// hold one at runtime (to route a tool call back) and must never compare it to a literal.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PluginId(pub String);

// ---- versions (manifest.md and wire-protocol.md §3.3) ----

pub const ALEXIA_PROTOCOL_MIN: u32 = 2;
/// Same window as v2 core today.
pub const ALEXIA_PROTOCOL_MAX: u32 = 15;
/// INTERFACES.md §3.2.
pub const MCP_REVISIONS: [&str; 1] = ["2025-11-25"];
/// "3.0.0", what `min_app`/`max_app` compare to.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

// ---- the host ----

pub struct Timings {
    /// Spawn → `initialize` answered.
    pub start_ms: u64,
    /// Ping interval and ping deadline.
    pub heartbeat_ms: u64,
    /// One `tools/call`.
    pub call_ms: u64,
    /// `alexia/capability/call` budget; must stay < 150_000 (the SDK's `CAPABILITY_CALL_MS`).
    pub capability_ms: u64,
    /// No traffic → stop (lazy plugins only).
    pub idle_ms: u64,
    /// Doubling.
    pub backoff_ms: u64,
    pub max_backoff_ms: u64,
    pub crash_window_ms: u64,
    pub crash_limit: u32,
    /// stdin closed → kill.
    pub exit_grace_ms: u64,
}

impl Default for Timings {
    fn default() -> Self {
        Timings {
            start_ms: 10_000,
            heartbeat_ms: 15_000,
            call_ms: 120_000,
            capability_ms: 140_000,
            idle_ms: 300_000,
            backoff_ms: 500,
            max_backoff_ms: 30_000,
            crash_window_ms: 60_000,
            crash_limit: 3,
            exit_grace_ms: 2_000,
        }
    }
}

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
pub enum PluginState {
    Stopped,
    Running,
    Unhealthy,
    Refused,
    /// P2-23: the plugin's folder is being re-read.
    Reloading,
}

#[derive(Clone, Debug, Serialize)]
pub struct PluginStatus {
    pub id: PluginId,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    pub state: PluginState,
    pub sentence: Option<String>,
    pub provides: Vec<String>,
}

/// A tool as the host knows it. `provides` is read off `_meta["alexia/provides"]`;
/// `hidden` is true when the tool carries `alexia/compute` or `alexia/editor` (never shown to a model).
#[derive(Clone, Debug)]
pub struct HostedTool {
    pub plugin: PluginId,
    pub tool: types::Tool,
    pub provides: Vec<String>,
    pub hidden: bool,
    /// false when kv `_core`/`unreviewed` (v2's list) holds the plugin id.
    pub reviewed: bool,
}

pub type ProgressSink = tokio::sync::mpsc::Sender<types::ProgressParams>;

#[derive(Clone, Default)]
pub struct CallCtx {
    /// Becomes `_meta["alexia/call-context"] = {"conversationId": "<id>"}`.
    pub conversation: Option<String>,
    /// When set, the request carries a progressToken and frames are forwarded here.
    pub progress: Option<ProgressSink>,
    pub cancel: CancellationToken,
    /// Extra request `_meta` keys core sets (INTERFACES.md §3.5), merged as-is.
    pub meta: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Answers {
    pub answers: bool,
    pub here: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum CallError {
    /// The plugin answered with a JSON-RPC error.
    #[error("{0}")]
    Rpc(jsonrpc::RpcError),
    /// Switched off, refused, unhealthy.
    #[error("{sentence}")]
    Off { sentence: String },
    #[error("the plugin did not answer in time")]
    Timeout,
    /// Crashed, killed, or folder deleted.
    #[error("the plugin stopped while answering")]
    Gone,
    #[error("stopped")]
    Cancelled,
}

/// (P3-35) The `tools/call` an `elicitation/create` arrived during: the newest call to that
/// plugin still in flight when the request came. None when no call was in flight.
#[derive(Clone, Debug)]
pub struct During {
    /// That call's `CallCtx.conversation` (a `SessionId` as a decimal string), if it had one.
    pub conversation: Option<String>,
    /// Cancelled when that call ends however it ends: answered, timed out, cancelled, or the
    /// plugin gone.
    pub ended: CancellationToken,
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
    async fn sample(
        &self,
        plugin: &PluginId,
        params: types::CreateMessageParams,
        progress: Option<ProgressSink>,
        cancel: CancellationToken,
    ) -> std::result::Result<serde_json::Value, jsonrpc::RpcError>;
    /// `elicitation/create`. `during` is the tool call it belongs to; the question must not
    /// outlive `during.ended`. `cancel` fires when the plugin cancels its request
    /// (`notifications/cancelled`) or the connection ends.
    async fn elicit(
        &self,
        plugin: &PluginId,
        params: serde_json::Value,
        during: Option<During>,
        cancel: CancellationToken,
    ) -> std::result::Result<serde_json::Value, jsonrpc::RpcError>;
    async fn roots(&self, plugin: &PluginId) -> Vec<types::Root>;
    /// alexia/attachments/* (protocol 14). Default: METHOD_NOT_FOUND.
    async fn attachments(
        &self,
        plugin: &PluginId,
        call: alexia::AttachmentsCall,
    ) -> std::result::Result<serde_json::Value, jsonrpc::RpcError> {
        let _ = (plugin, call);
        Err(jsonrpc::RpcError::method_not_found())
    }
    /// Capabilities core answers itself (P2-34: `vision.describe`, `text.embed`). Default: none.
    fn host_caps(&self) -> Vec<String> {
        Vec::new()
    }
    /// `alexia/capability/call` for a cap no enabled plugin provides. None = not mine (-32050).
    async fn host_call(
        &self,
        plugin: &PluginId,
        cap: &str,
        args: serde_json::Map<String, serde_json::Value>,
        cancel: CancellationToken,
    ) -> Option<std::result::Result<types::CallToolResult, jsonrpc::RpcError>> {
        let _ = (plugin, cap, args, cancel);
        None
    }
}

pub struct HostFacts {
    pub display_name: String,
    pub privacy_mode: alexia::PrivacyMode,
    pub locale: String,
}

/// Offers `{roots:{}}` only; `sample`/`elicit` answer -32021; roots empty.
pub struct NoUpcalls;

#[async_trait::async_trait]
impl Upcalls for NoUpcalls {
    fn offers(&self, _plugin: &PluginId) -> types::ClientCapabilities {
        types::ClientCapabilities {
            roots: Some(types::Empty {}),
            ..Default::default()
        }
    }

    fn host_facts(&self) -> HostFacts {
        HostFacts {
            // v2 host.ts: `displayName: this.options.displayName ?? 'Alexia'`. The SDK
            // refuses an empty one and the plugin exits.
            display_name: "Alexia".into(),
            privacy_mode: alexia::PrivacyMode::Cloud,
            locale: "en-GB".into(),
        }
    }

    async fn sample(
        &self,
        _plugin: &PluginId,
        _params: types::CreateMessageParams,
        _progress: Option<ProgressSink>,
        _cancel: CancellationToken,
    ) -> std::result::Result<serde_json::Value, jsonrpc::RpcError> {
        Err(cannot_yet())
    }

    async fn elicit(
        &self,
        _plugin: &PluginId,
        _params: serde_json::Value,
        _during: Option<During>,
        _cancel: CancellationToken,
    ) -> std::result::Result<serde_json::Value, jsonrpc::RpcError> {
        Err(cannot_yet())
    }

    async fn roots(&self, _plugin: &PluginId) -> Vec<types::Root> {
        vec![]
    }
}

fn cannot_yet() -> jsonrpc::RpcError {
    jsonrpc::RpcError::new(
        jsonrpc::code::MISSING_REQUIRED_CLIENT_CAPABILITY,
        "This host cannot do that yet.",
    )
}

#[derive(Clone, Debug)]
pub enum PluginEvent {
    Loaded {
        plugin: PluginId,
    },
    /// Version or manifest check failed; no process.
    Refused {
        plugin: PluginId,
        sentence: String,
    },
    Started {
        plugin: PluginId,
        pid: u32,
    },
    Stopped {
        plugin: PluginId,
        reason: StopReason,
    },
    Crashed {
        plugin: PluginId,
        exit_code: Option<i32>,
    },
    /// `crash_limit` hit; switched off.
    Unhealthy {
        plugin: PluginId,
        sentence: String,
    },
    ToolsChanged {
        plugin: PluginId,
    },
    /// Folder gone.
    Removed {
        plugin: PluginId,
    },
}

#[derive(Clone, Copy, Debug)]
pub enum StopReason {
    Idle,
    Disabled,
    Shutdown,
    Heartbeat,
}

pub type EventSink = std::sync::Arc<dyn Fn(PluginEvent) + Send + Sync>;
