// SPDX-License-Identifier: AGPL-3.0-only
//! The shapes every part of a run shares: tools, steps, rulings, scope, limits and results
//! (INTERFACES.md §2.3, `run` module). Re-exported from the crate root.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use alexia_mcp::types::ToolAnnotations;
use alexia_mcp::PluginId;
use alexia_store::{Ms, SessionId};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{Origin, OutFile, RunId};

/// One tool the model may call.
#[derive(Clone, Debug)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema of the arguments.
    pub params: Value,
    pub annotations: Option<ToolAnnotations>,
    /// false for an MCP-compatibility server nobody reviewed (wire-protocol §7).
    pub reviewed: bool,
    pub plugin: Option<PluginId>,
    /// What the call does in words a person reads (v2 `toolWords`).
    pub words: String,
}

/// A file a tool call made.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Produced {
    pub name: String,
    pub path: PathBuf,
    pub bytes: u64,
    pub mime: String,
}

/// `_meta["alexia/undo"]` on a result, or a builtin's own inverse (AC-11).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UndoCall {
    pub tool: String,
    pub arguments: Map<String, Value>,
    pub summary: String,
}

/// What a tool call came back with. A failure is `ok: false`, never an error.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolOutcome {
    pub text: String,
    pub ok: bool,
    pub files: Vec<Produced>,
    /// `alexia/final`
    pub final_text: Option<String>,
    pub undo: Option<UndoCall>,
    /// `alexia/card`, passed through
    pub card: Option<Value>,
}

/// What a tool call knows about the run it is part of.
#[derive(Clone, Debug)]
pub struct ToolCtx {
    pub session: SessionId,
    pub run: RunId,
    pub origin: Origin,
    pub background: bool,
    pub cancel: CancellationToken,
    /// Where the call's progress goes. Bounded, and sent to with `try_send`: a slow reader
    /// loses an update rather than stall the tool.
    pub progress: Option<mpsc::Sender<ToolProgress>>,
}

/// One progress report of a running call, with the detail a plugin put in its `_meta`
/// (v2 `tooling.ts` `onprogress`). Each field was checked on the way in.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolProgress {
    pub progress: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// A `data:image/…` URL, never a path or a host.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stages: Option<Value>,
    /// The stages are a plan; only ever true with `stages`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub plan: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controls: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub research: Option<Value>,
}

impl ToolProgress {
    /// The report as one line a person reads (what a chat shows).
    pub fn line(&self) -> String {
        let line = match (&self.message, self.total) {
            (Some(m), _) => m.clone(),
            (None, Some(t)) => format!("{} of {}", self.progress, t),
            (None, None) => self.progress.to_string(),
        };
        line.replace(['\r', '\n'], " ")
    }
}

/// What the loop may call. `McpTooling` (P2-18) and a test fake.
#[async_trait::async_trait]
pub trait Tooling: Send + Sync {
    /// Re-asked every step, on purpose: a plugin can vanish between steps.
    async fn list(&self) -> Vec<ToolSpec>;
    /// A failure is an outcome (`ok: false`), never an Err.
    async fn call(&self, name: &str, args: Map<String, Value>, ctx: ToolCtx) -> ToolOutcome;
}

/// A tool core itself offers (skills, schedules, helpers, undo). Several implementations.
#[async_trait::async_trait]
pub trait Builtin: Send + Sync {
    fn specs(&self) -> Vec<ToolSpec>;
    /// None: not one of mine.
    async fn call(
        &self,
        name: &str,
        args: &Map<String, Value>,
        ctx: &ToolCtx,
    ) -> Option<ToolOutcome>;
}

/// One tool call of a run. `outcome` is None while it runs (and for a dangling call).
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub n: u32,
    pub name: String,
    pub args: Map<String, Value>,
    pub outcome: Option<ToolOutcome>,
}

/// What the permission rules say about one call (`permissions::rule`, P2-12).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ruling {
    Run,
    /// The question to put to the owner.
    Ask(String),
    /// Why not, as a sentence.
    Blocked(String),
}

/// What a spoken boundary forbids.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Blocks {
    Destructive,
    Everything,
}

/// "Don't delete anything": a limit the owner said in words, kept until lifted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Boundary {
    pub said: String,
    pub blocks: Blocks,
    pub at: Ms,
}

/// The four permission modes (plan.md, "Permission modes"; TR-01).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    AskEveryTime,
    AskRisky,
    WatchAndWarn,
    FullTrust,
}

/// Everything the rules weigh a call against.
#[derive(Clone, Debug)]
pub struct Scope {
    pub mode: PermissionMode,
    /// Folders Alexia may work in.
    pub roots: Vec<PathBuf>,
    pub everywhere: bool,
    pub boundaries: Vec<Boundary>,
    /// Alexia's own data folder, never touched by a tool.
    pub data_dir: PathBuf,
}

/// v2 `Struggle` minus `expensive` (there is no money to spend, D212).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Struggle {
    Looping,
    Stuck,
    Spinning,
    Grinding,
}

/// MO-14. `Vision`, `Check`, `Local` may use the local GPU; the rest never (D213).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Job {
    Chat,
    Plan,
    Step,
    Code,
    Vision,
    Check,
    Local,
}

/// How a run ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunEnd {
    Answered,
    Stopped,
    /// A step limit was reached.
    Ceiling,
    /// Why, as a sentence.
    Refused(String),
}

#[derive(Clone, Debug)]
pub struct RunResult {
    pub run: RunId,
    pub end: RunEnd,
    pub steps: Vec<Step>,
    pub text: String,
    pub files: Vec<OutFile>,
    pub model: Option<String>,
}

/// A run in progress, as `live_runs` keeps it (SP-13).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveRun {
    pub run: RunId,
    pub session: SessionId,
    pub origin: Origin,
    pub started_at: Ms,
    pub steps: u32,
    pub background: bool,
}

/// Rails. `max_spend_usd` is gone: D212 fixes it at 0, the router enforces it (P2-17).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// A foreground run (v2 `MAX_STEPS`).
    pub max_steps: u32,
    /// A background run (AC-08).
    pub background_steps: u32,
    /// One parallel helper (AC-07).
    pub helper_steps: u32,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            max_steps: 24,
            background_steps: 200,
            helper_steps: 12,
        }
    }
}

/// Review 12: the one "ms since an Instant, capped at u32::MAX" helper. An instant in the
/// future counts as 0.
pub fn ms_since(t: Instant) -> u32 {
    capped_ms(t.elapsed())
}

fn capped_ms(d: Duration) -> u32 {
    u32::try_from(d.as_millis()).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capped_at_u32_max() {
        assert_eq!(capped_ms(Duration::from_millis(1234)), 1234);
        assert_eq!(
            capped_ms(Duration::from_millis(u64::from(u32::MAX))),
            u32::MAX
        );
        assert_eq!(
            capped_ms(Duration::from_millis(u64::from(u32::MAX) + 1)),
            u32::MAX
        );
        assert_eq!(capped_ms(Duration::MAX), u32::MAX);
    }
}
