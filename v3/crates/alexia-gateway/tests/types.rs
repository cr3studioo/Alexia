// SPDX-License-Identifier: AGPL-3.0-only
//! The P1 channel contract: object safety, fixed values, and the stub gateway stopping.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use alexia_core::{Brain, BrainError, Budget, Bus, DraftSink, Lane, OutFile, Reply, Turn};
use alexia_gateway::{
    Channel, ChatRef, Gateway, GatewayConfig, InFile, InKind, Inbound, Media, MsgRef, Outbound,
    Result,
};
use alexia_store::{Content, Store};
use tokio_util::sync::CancellationToken;

// Integration tests (P1-09, P1-10) reach the adapter: this fails to compile if it goes private.
const _: Option<(
    alexia_gateway::channels::telegram::api::Api,
    alexia_gateway::channels::telegram::api::Update,
)> = None;
/// Echoes every `send` back as a message id, and answers every `ask` with yes.
struct FakeChannel;

#[async_trait::async_trait]
impl Channel for FakeChannel {
    fn name(&self) -> &'static str {
        "fake"
    }
    fn budget(&self) -> Budget {
        Budget::CHAT
    }
    async fn next(&self, _cancel: CancellationToken) -> Result<Vec<Inbound>> {
        Ok(vec![Inbound {
            chat: ChatRef { chat: "1".into() },
            msg: MsgRef { id: "10".into() },
            kind: InKind::Message,
            from_owner: true,
            content: Content::Text("hi".into()),
            files: vec![],
            at: 0,
        }])
    }
    async fn react(&self, _chat: &ChatRef, _msg: &MsgRef, _emoji: &str) -> Result<()> {
        Ok(())
    }
    async fn typing(&self, _chat: &ChatRef) -> Result<()> {
        Ok(())
    }
    async fn send(&self, _chat: &ChatRef, out: &Outbound) -> Result<MsgRef> {
        Ok(MsgRef {
            id: out.text.clone(),
        })
    }
    async fn draft(&self, _chat: &ChatRef, _text: Option<&str>) -> Result<()> {
        Ok(())
    }
    async fn edit(&self, _chat: &ChatRef, _msg: &MsgRef, _text: &str) -> Result<()> {
        Ok(())
    }
    async fn ask(
        &self,
        _chat: &ChatRef,
        _text: &str,
        _cancel: CancellationToken,
    ) -> Result<Option<bool>> {
        Ok(Some(true))
    }
}

struct FakeMedia;

#[async_trait::async_trait]
impl Media for FakeMedia {
    async fn transcribe(&self, _file: &InFile, _: CancellationToken) -> Result<Option<String>> {
        Ok(Some("hello".into()))
    }
    async fn speak(&self, _text: &str, _: CancellationToken) -> Result<Option<OutFile>> {
        Ok(None)
    }
}

struct NoBrain;

#[async_trait::async_trait]
impl Brain for NoBrain {
    async fn reply(
        &self,
        _turn: Turn,
        _draft: DraftSink,
        _cancel: CancellationToken,
    ) -> std::result::Result<Reply, BrainError> {
        Ok(Reply {
            text: String::new(),
            files: vec![],
            lane: Lane::Chat,
            model: None,
            spans: vec![],
        })
    }
}

#[tokio::test]
async fn channel_is_object_safe() {
    let channel: Arc<dyn Channel> = Arc::new(FakeChannel);
    assert_eq!(channel.name(), "fake");
    assert_eq!(channel.budget(), Budget::CHAT);
    let chat = ChatRef { chat: "1".into() };
    let got = channel.next(CancellationToken::new()).await.unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].kind, InKind::Message);
    let out = Outbound {
        text: "42".into(),
        files: vec![],
        voice: false,
    };
    assert_eq!(
        channel.send(&chat, &out).await.unwrap(),
        MsgRef { id: "42".into() }
    );
    assert_eq!(
        channel
            .ask(&chat, "ok?", CancellationToken::new())
            .await
            .unwrap(),
        Some(true)
    );
}

#[tokio::test]
async fn media_is_object_safe() {
    let media: Arc<dyn Media> = Arc::new(FakeMedia);
    let file = InFile {
        name: "note.ogg".into(),
        mime: "audio/ogg".into(),
        path: PathBuf::from("note.ogg"),
    };
    assert_eq!(
        media
            .transcribe(&file, CancellationToken::new())
            .await
            .unwrap()
            .as_deref(),
        Some("hello")
    );
    assert!(media
        .speak("hello", CancellationToken::new())
        .await
        .unwrap()
        .is_none());
}

#[test]
fn config_defaults() {
    let cfg = GatewayConfig::default();
    assert_eq!(cfg.merge_ms, 500);
    assert_eq!(cfg.draft_every_ms, 300);
    assert_eq!(cfg.ack_emoji, "👀");
}

#[tokio::test]
async fn stub_gateway_stops_on_cancel() {
    let store = Arc::new(Store::open_in_memory().unwrap());
    let mut gateway = Gateway::with_channels(
        GatewayConfig::default(),
        store,
        Bus::new(16),
        Arc::new(NoBrain),
        Arc::new(FakeMedia),
        alexia_gateway::ChannelSet::new(),
    );
    gateway.add(Arc::new(FakeChannel));
    let token = CancellationToken::new();
    token.cancel();
    let done = tokio::time::timeout(Duration::from_secs(1), gateway.run(token)).await;
    assert!(matches!(done, Ok(Ok(()))), "run did not stop on cancel");
}
