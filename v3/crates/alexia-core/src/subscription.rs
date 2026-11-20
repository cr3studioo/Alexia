// SPDX-License-Identifier: AGPL-3.0-only
//! Subscriptions the owner already pays for, reached only through the vendor's own signed-in
//! CLI (MO-05). Stub: P2-35 fills it.
#![allow(unused_variables)] // stub: the filling task removes this

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{ChatChunk, ChatDone, ChatRequest, ModelInfo, Provider, ProviderError};

pub enum Cli {
    ClaudeCode,
    Codex,
}

pub struct SubscriptionCli {
    _todo: (),
}

impl SubscriptionCli {
    /// `ALEXIA_CLAUDE_CLI` / `ALEXIA_CODEX_CLI`, else the name on PATH. None if not installed.
    pub fn find(cli: Cli) -> Option<SubscriptionCli> {
        todo!("P2-35")
    }

    /// `claude --version` / `codex --version` and a no-op sign-in check; a sentence if not signed in.
    pub async fn check(&self) -> Result<(), String> {
        todo!("P2-35")
    }
}

/// id "subscription:claude-code" | "subscription:codex"; `models()` one entry, free: true, tools: false.
#[async_trait::async_trait]
impl Provider for SubscriptionCli {
    fn id(&self) -> &str {
        todo!("P2-35")
    }

    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        todo!("P2-35")
    }

    async fn chat(
        &self,
        req: &ChatRequest,
        model: &str,
        out: mpsc::Sender<ChatChunk>,
        cancel: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        todo!("P2-35")
    }
}
