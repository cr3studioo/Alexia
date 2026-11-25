// SPDX-License-Identifier: AGPL-3.0-only
//! The brain contract: whatever answers a turn (INTERFACES.md §2.3).

use std::path::PathBuf;
use std::sync::Arc;

use alexia_store::{Content, Ms, SessionId};
use serde::Serialize;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{Error, Lane, Origin, Produced, RunId, Span, ToolProgress};

/// (V3-1) A file that came with a message, already downloaded under `layout.cache()`.
#[derive(Clone, Debug)]
pub struct InFile {
    pub name: String,
    pub mime: String,
    pub path: PathBuf,
}

/// Extra user messages for a run already going. Clone shares one receiver.
#[derive(Clone, Debug, Default)]
pub struct Steer(Option<Arc<tokio::sync::Mutex<mpsc::Receiver<Content>>>>);

impl Steer {
    pub fn none() -> Steer {
        Steer(None)
    }

    pub fn channel(capacity: usize) -> (mpsc::Sender<Content>, Steer) {
        let (tx, rx) = mpsc::channel(capacity);
        (tx, Steer(Some(Arc::new(tokio::sync::Mutex::new(rx)))))
    }

    /// Everything waiting now, without waiting. Empty for `none()`.
    pub async fn take(&self) -> Vec<Content> {
        let mut out = Vec::new();
        if let Some(rx) = &self.0 {
            let mut rx = rx.lock().await;
            while let Ok(c) = rx.try_recv() {
                out.push(c);
            }
        }
        out
    }
}

#[derive(Clone, Debug)]
pub struct Turn {
    pub session: SessionId,
    pub origin: Origin,
    pub content: Content,
    /// (V3-1) Documents and other files that came with the message, not voice notes (those
    /// are already text in `content`) and not photos (image parts of `content`).
    pub files: Vec<InFile>,
    pub received_at: Ms,
    /// Messages that arrive while the run is going; read only after `DraftFrame::Steerable`.
    pub steer: Steer,
}

/// What the reply is doing while it is written. Mirrors `alexia/stream` (wire-protocol.md §5).
// `Step` is unboxed as INTERFACES.md has it: a frame lives for one send, so the size costs
// nothing worth a `Box` in every match.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug)]
pub enum DraftFrame {
    Delta(String),
    Restart,
    Phase(Phase),
    /// The brain reads `turn.steer` from now on.
    Steerable,
    /// A tool step starting, moving or done (the window draws it; a chat ignores it).
    Step(StepFrame),
    /// A line for the person beside the answer: a boundary heard, a run stopped.
    Note(String),
    /// A question for the owner at the window; the answer comes back through the asker.
    Ask(String),
}

/// One tool step as the window is told it: `args` when it starts, `progress` while it runs,
/// `outcome` when it ends (v2 `serve.ts` `step` / `progress` / `done`).
#[derive(Clone, Debug, Serialize)]
pub struct StepFrame {
    pub n: u32,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<ToolProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<StepOutcomeFrame>,
}

/// How a step ended. The window gives the files their ids.
#[derive(Clone, Debug, Serialize)]
pub struct StepOutcomeFrame {
    pub text: String,
    pub ok: bool,
    pub files: Vec<Produced>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Choosing,
    Asking,
    Retrying,
    Backup,
    Thinking,
    Writing,
    Tool,
}

pub type DraftSink = tokio::sync::mpsc::Sender<DraftFrame>;

#[derive(Clone, Debug)]
pub struct OutFile {
    pub name: String,
    pub mime: String,
    pub path: PathBuf,
}

#[derive(Clone, Debug)]
pub struct Reply {
    pub text: String,
    pub files: Vec<OutFile>,
    pub lane: Lane,
    pub model: Option<String>,
    pub spans: Vec<Span>,
}

#[derive(Debug, thiserror::Error)]
pub enum BrainError {
    /// A sentence: nothing could answer right now.
    #[error("{0}")]
    Unavailable(String),
    #[error("stopped")]
    Cancelled,
    /// P1: the chat lane decided this turn needs tools; nothing was shown or stored yet.
    #[error("needs the task lane")]
    NeedsTask,
    #[error(transparent)]
    Other(#[from] Error),
}

/// Whatever answers a turn. Implemented by `Agent` (V3-2) and the fast chat lane,
/// plus a fake in tests. The gateway and the scheduler hold an `Arc<dyn Brain>`.
#[async_trait::async_trait]
pub trait Brain: Send + Sync {
    /// Appends the user turn and the reply to the session itself.
    async fn reply(
        &self,
        turn: Turn,
        draft: DraftSink,
        cancel: CancellationToken,
    ) -> Result<Reply, BrainError>;
}

/// (P3-35) How long the owner has to answer a plugin's question. Below `Timings::call_ms`
/// (120 s) with margin, so the answer always reaches the plugin while its tool call is still
/// alive.
pub const ELICIT_WAIT: std::time::Duration = std::time::Duration::from_secs(100);

/// (P3-35) A plugin's yes/no form, put to the owner.
#[derive(Clone, Debug)]
pub struct Elicitation {
    /// The run whose tool call asked (so the window watching it can show it), else
    /// `RunId(format!("elicit-{plugin}-{ms}"))`.
    pub run: RunId,
    /// The plugin's id.
    pub plugin: String,
    /// The plugin's manifest name.
    pub name: String,
    /// The form's `message`, exactly as the plugin sent it.
    pub message: String,
    pub wait: std::time::Duration,
}

impl Elicitation {
    /// What the owner reads. Always names the plugin, by name and id (two plugins can share
    /// a name).
    pub fn prompt(&self) -> String {
        format!(
            "{} ({}) asks:

{}",
            self.name, self.plugin, self.message
        )
    }
}

/// (P3-35) MCP's three answers. Accept only on the owner's own yes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Elicited {
    Accept,
    Decline,
    Cancel,
}

impl Elicited {
    /// "accept" | "decline" | "cancel": the only thing ever logged about an answer.
    pub fn as_str(self) -> &'static str {
        match self {
            Elicited::Accept => "accept",
            Elicited::Decline => "decline",
            Elicited::Cancel => "cancel",
        }
    }
}

/// A yes/no a run needs from the owner (approval gates, `ask.confirm`). Implemented by the
/// gateway (asks in the chat the turn came from) and by a fake that always says no.
#[async_trait::async_trait]
pub trait Ask: Send + Sync {
    async fn confirm(
        &self,
        origin: &Origin,
        question: &Question,
        cancel: CancellationToken,
    ) -> bool;

    /// (P3-35) A plugin's form. Default, for the test fakes: `confirm` with `prompt()` as the
    /// text, inside `e.wait`. true → Accept, false → Decline, the wait over or `cancel` →
    /// Cancel. A yes that comes once `cancel` fired is still Cancel. The gateway overrides it
    /// (P3-36).
    async fn elicit(
        &self,
        origin: &Origin,
        e: &Elicitation,
        cancel: CancellationToken,
    ) -> Elicited {
        let question = Question {
            run: e.run.clone(),
            text: e.prompt(),
            detail: None,
        };
        // Whatever ends this wait withdraws the question too.
        let stop = cancel.child_token();
        let _withdraw = stop.clone().drop_guard();
        let answer = tokio::select! {
            biased;
            () = cancel.cancelled() => None,
            r = tokio::time::timeout(e.wait, self.confirm(origin, &question, stop.clone())) => r.ok(),
        };
        match answer {
            _ if cancel.is_cancelled() => Elicited::Cancel,
            Some(true) => Elicited::Accept,
            Some(false) => Elicited::Decline,
            None => Elicited::Cancel,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Question {
    pub run: RunId,
    pub text: String,
    pub detail: Option<String>,
}
