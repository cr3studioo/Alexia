// SPDX-License-Identifier: AGPL-3.0-only
//! The brain contract: whatever answers a turn (INTERFACES.md §2.3).

use std::path::PathBuf;

use alexia_store::{Content, Ms, SessionId};
use tokio_util::sync::CancellationToken;

use crate::{Error, Lane, Origin, RunId, Span};

#[derive(Clone, Debug)]
pub struct Turn {
    pub session: SessionId,
    pub origin: Origin,
    pub content: Content,
    pub received_at: Ms,
}

/// What the reply is doing while it is written. Mirrors `alexia/stream` (wire-protocol.md §5).
#[derive(Clone, Debug)]
pub enum DraftFrame {
    Delta(String),
    Restart,
    Phase(Phase),
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

/// Whatever answers a turn. Implemented by `Agent` (V3-2) and by the hub's `V2Bridge` (V3-1),
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
}

#[derive(Clone, Debug)]
pub struct Question {
    pub run: RunId,
    pub text: String,
    pub detail: Option<String>,
}
