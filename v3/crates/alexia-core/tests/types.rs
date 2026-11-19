// SPDX-License-Identifier: AGPL-3.0-only
//! The P1 brain and provider contracts: object safety and fixed values.

use std::sync::Arc;

use alexia_core::{
    Brain, BrainError, Budget, ChatChunk, ChatDone, ChatRequest, DraftSink, Lane, ModelInfo,
    Origin, Provider, ProviderError, Reply, Turn,
};
use alexia_store::{Content, SessionId};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Echo;

#[async_trait::async_trait]
impl Brain for Echo {
    async fn reply(
        &self,
        turn: Turn,
        _draft: DraftSink,
        _cancel: CancellationToken,
    ) -> Result<Reply, BrainError> {
        let Content::Text(text) = turn.content else {
            return Err(BrainError::Unavailable("Only text is echoed.".into()));
        };
        Ok(Reply {
            text,
            files: vec![],
            lane: Lane::Chat,
            model: None,
            spans: vec![],
        })
    }
}

#[tokio::test]
async fn brain_is_object_safe() {
    let brain: Arc<dyn Brain> = Arc::new(Echo);
    let (draft, _rx) = mpsc::channel(4);
    let turn = Turn {
        session: SessionId(1),
        origin: Origin::Desktop,
        content: Content::Text("hello".into()),
        received_at: 0,
    };
    let reply = brain
        .reply(turn, draft, CancellationToken::new())
        .await
        .unwrap();
    assert!(matches!(reply, Reply { lane: Lane::Chat, .. }));
    assert_eq!(reply.text, "hello");
}

struct Two;

#[async_trait::async_trait]
impl Provider for Two {
    fn id(&self) -> &str {
        "two"
    }
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(vec![])
    }
    async fn chat(
        &self,
        _req: &ChatRequest,
        model: &str,
        out: mpsc::Sender<ChatChunk>,
        _cancel: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        for t in ["one ", "two"] {
            out.send(ChatChunk::Text(t.into()))
                .await
                .map_err(|_| ProviderError::Cancelled)?;
        }
        Ok(ChatDone {
            model: model.into(),
            provider: self.id().into(),
            tokens_in: 1,
            tokens_out: 2,
            cost: 0.0,
            first_byte_ms: Some(7),
        })
    }
}

#[tokio::test]
async fn provider_is_object_safe() {
    let p: Arc<dyn Provider> = Arc::new(Two);
    let req = ChatRequest {
        messages: vec![],
        system: None,
        tools: vec![],
        max_tokens: None,
    };
    let (tx, mut rx) = mpsc::channel(4);
    let done = p
        .chat(&req, "m", tx, CancellationToken::new())
        .await
        .unwrap();
    assert!(done.first_byte_ms.is_some());
    assert_eq!(done.provider, "two");
    assert_eq!(rx.recv().await, Some(ChatChunk::Text("one ".into())));
    assert_eq!(rx.recv().await, Some(ChatChunk::Text("two".into())));
    assert_eq!(rx.recv().await, None);
}

#[test]
fn needs_task_is_distinct() {
    assert_eq!(BrainError::NeedsTask.to_string(), "needs the task lane");
}

#[test]
fn budget_chat_value() {
    assert_eq!(Budget::CHAT.first_byte_ms, 2_500);
}
