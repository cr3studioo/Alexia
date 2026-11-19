// SPDX-License-Identifier: AGPL-3.0-only
//! The channel contract: what every chat surface implements, and what the gateway hands on.


use alexia_core::{Budget, OutFile};
use alexia_store::{Content, Ms};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ChatRef {
    pub chat: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct MsgRef {
    pub id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InKind {
    Message,
    Stop,
}

/// A file that came with a message (INTERFACES.md §2.3); `Turn.files` carries it on.
pub use alexia_core::InFile;

#[derive(Clone, Debug)]
pub struct Inbound {
    pub chat: ChatRef,
    pub msg: MsgRef,
    pub kind: InKind,
    pub from_owner: bool,
    pub content: Content,
    pub files: Vec<InFile>,
    pub at: Ms,
}

#[derive(Clone, Debug)]
pub struct Outbound {
    pub text: String,
    pub files: Vec<OutFile>,
    /// Send as a voice note.
    pub voice: bool,
}

#[async_trait::async_trait]
pub trait Channel: Send + Sync {
    fn name(&self) -> &'static str;
    /// SP-07: how long this surface can wait for a first word.
    fn budget(&self) -> Budget;
    async fn next(&self, cancel: CancellationToken) -> Result<Vec<Inbound>>;
    async fn react(&self, chat: &ChatRef, msg: &MsgRef, emoji: &str) -> Result<()>;
    async fn typing(&self, chat: &ChatRef) -> Result<()>;
    async fn send(&self, chat: &ChatRef, out: &Outbound) -> Result<MsgRef>;
    /// Show `text` as the message being written. `None` clears it. Rate limits come back as
    /// `Error::RateLimited`; the gateway paces itself.
    async fn draft(&self, chat: &ChatRef, text: Option<&str>) -> Result<()>;
    async fn edit(&self, chat: &ChatRef, msg: &MsgRef, text: &str) -> Result<()>;
    async fn ask(
        &self,
        chat: &ChatRef,
        text: &str,
        cancel: CancellationToken,
    ) -> Result<Option<bool>>;
}

/// Voice in and out (CH-05). The hub implements it over `McpHost::call_capability`
/// (`voice.transcribe`, `voice.render`); tests use a fake. `None` = nothing installed can do it.
#[async_trait::async_trait]
pub trait Media: Send + Sync {
    async fn transcribe(&self, file: &InFile) -> Result<Option<String>>;
    async fn speak(&self, text: &str) -> Result<Option<OutFile>>;
}

#[derive(Clone, Debug)]
pub struct GatewayConfig {
    pub merge_ms: u64,
    pub draft_every_ms: u64,
    pub ack_emoji: String,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        GatewayConfig {
            merge_ms: 500,
            draft_every_ms: 300,
            ack_emoji: "👀".into(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A sentence the owner can read.
    #[error("{0}")]
    Service(String),
    #[error("rate limited")]
    RateLimited { retry_after_ms: u64 },
    /// HTTP 409.
    #[error("another program is reading this bot's messages")]
    Conflict,
    /// HTTP 401.
    #[error("the token was refused")]
    Unauthorized,
    #[error("unreachable")]
    Unreachable,
    #[error("stopped")]
    Cancelled,
    #[error(transparent)]
    Store(#[from] alexia_store::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
