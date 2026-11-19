// SPDX-License-Identifier: AGPL-3.0-only
//! The provider contract: one model service (INTERFACES.md §2.3).

use alexia_store::{MessageBody, Role, ToolCall};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
pub struct ChatRequest {
    pub messages: Vec<(Role, MessageBody)>,
    pub system: Option<String>,
    pub tools: Vec<alexia_mcp::types::Tool>,
    pub max_tokens: Option<u32>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ChatChunk {
    Text(String),
    Reasoning(String),
    ToolCall(ToolCall),
}

#[derive(Clone, Debug)]
pub struct ChatDone {
    pub model: String,
    /// P1: the id of the provider that answered.
    pub provider: String,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub cost: f64,
    pub first_byte_ms: Option<u32>,
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("busy")]
    Busy { retry_after_ms: Option<u64> },
    #[error("needs a key")]
    NeedsKey,
    #[error("refused: {0}")]
    Refused(String),
    #[error("unreachable")]
    Unreachable,
    #[error("stopped")]
    Cancelled,
    #[error("{0}")]
    Other(String),
}

#[derive(Clone, Debug)]
pub struct ModelInfo {
    pub id: String,
    pub context: u32,
    pub free: bool,
    pub tools: bool,
    pub vision: bool,
}

#[async_trait::async_trait]
pub trait Provider: Send + Sync {
    fn id(&self) -> &str;
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError>;
    async fn chat(
        &self,
        req: &ChatRequest,
        model: &str,
        out: tokio::sync::mpsc::Sender<ChatChunk>,
        cancel: CancellationToken,
    ) -> Result<ChatDone, ProviderError>;
}

/// P1, SP-07: how long a channel can wait for the first byte. The router starts another
/// candidate each time this passes with nothing back (P1-06).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Budget {
    pub first_byte_ms: u32,
}

impl Budget {
    pub const CHAT: Budget = Budget {
        first_byte_ms: 2_500,
    };
}
