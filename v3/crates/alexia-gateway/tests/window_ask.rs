// SPDX-License-Identifier: AGPL-3.0-only
//! P2D-03: questions asked in Alexia's window (`WindowQuestions`), the fallback to the primary
//! chat, and a chat that ignores the window's frames.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::{
    Ask, Brain, BrainError, Budget, Bus, DraftFrame, DraftSink, Lane, Origin, OutFile, Question,
    Reply, RunId, StepFrame, Turn,
};
use alexia_gateway::{
    Asker, Channel, ChannelSet, ChatRef, Error, Gateway, GatewayConfig, InFile, InKind, Inbound,
    Media, MsgRef, Outbound, Result, WindowQuestions,
};
use alexia_store::{Content, Store};
use tokio::sync::mpsc;
use tokio::time::{sleep, timeout, Instant};
use tokio_util::sync::CancellationToken;

/// How long any wait here may take before the test fails.
const WAIT: Duration = Duration::from_secs(30);

// ---- fake channel ----

struct FakeChannel {
    inbox: tokio::sync::Mutex<mpsc::UnboundedReceiver<Vec<Inbound>>>,
    /// What its buttons answer.
    answer: bool,
    asks: Mutex<Vec<(String, String)>>,
    sent: Mutex<Vec<String>>,
    drafts: Mutex<Vec<String>>,
}

impl FakeChannel {
    fn new(answer: bool) -> (Arc<FakeChannel>, mpsc::UnboundedSender<Vec<Inbound>>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let ch = Arc::new(FakeChannel {
            inbox: tokio::sync::Mutex::new(rx),
            answer,
            asks: Mutex::new(Vec::new()),
            sent: Mutex::new(Vec::new()),
            drafts: Mutex::new(Vec::new()),
        });
        (ch, tx)
    }
    fn asks(&self) -> Vec<(String, String)> {
        self.asks.lock().unwrap().clone()
    }
    fn sent(&self) -> Vec<String> {
        self.sent.lock().unwrap().clone()
    }
    fn drafts(&self) -> Vec<String> {
        self.drafts.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl Channel for FakeChannel {
    fn name(&self) -> &'static str {
        "fake"
    }
    fn budget(&self) -> Budget {
        Budget::CHAT
    }
    async fn next(&self, cancel: CancellationToken) -> Result<Vec<Inbound>> {
        let mut inbox = self.inbox.lock().await;
        tokio::select! {
            _ = cancel.cancelled() => Err(Error::Cancelled),
            b = inbox.recv() => match b {
                Some(b) => Ok(b),
                None => {
                    cancel.cancelled().await;
                    Err(Error::Cancelled)
                }
            },
        }
    }
    async fn react(&self, _: &ChatRef, _: &MsgRef, _: &str) -> Result<()> {
        Ok(())
    }
    async fn typing(&self, _: &ChatRef) -> Result<()> {
        Ok(())
    }
    async fn send(&self, _: &ChatRef, out: &Outbound) -> Result<MsgRef> {
        self.sent.lock().unwrap().push(out.text.clone());
        Ok(MsgRef { id: "s".into() })
    }
    async fn draft(&self, _: &ChatRef, text: Option<&str>) -> Result<()> {
        if let Some(t) = text {
            self.drafts.lock().unwrap().push(t.to_string());
        }
        Ok(())
    }
    async fn edit(&self, _: &ChatRef, _: &MsgRef, _: &str) -> Result<()> {
        Ok(())
    }
    async fn ask(&self, chat: &ChatRef, text: &str, _: CancellationToken) -> Result<Option<bool>> {
        self.asks
            .lock()
            .unwrap()
            .push((chat.chat.clone(), text.to_string()));
        Ok(Some(self.answer))
    }
}

// ---- the asker ----

struct H {
    ch: Arc<FakeChannel>,
    store: Arc<Store>,
    window: WindowQuestions,
    asker: Arc<Asker>,
}

/// An asker with the window's questions; `primary` is the fake channel's primary chat.
fn asker(primary: Option<&str>) -> H {
    let store = Arc::new(Store::open_in_memory().unwrap());
    if let Some(chat) = primary {
        store.channel_session("fake", chat).unwrap();
        store.set_primary_chat("fake", chat).unwrap();
    }
    let (ch, _inbox) = FakeChannel::new(true);
    let channels = ChannelSet::new();
    channels.add(ch.clone());
    let window = WindowQuestions::new();
    let asker = Asker::with_window(channels, store.clone(), Bus::new(64), window.clone());
    H {
        ch,
        store,
        window,
        asker,
    }
}

fn question(run: &str, text: &str) -> Question {
    Question {
        run: RunId(run.into()),
        text: text.into(),
        detail: Some("wipe(path=old)".into()),
    }
}

/// Asks from a window run in the background.
fn confirm(h: &H, q: Question) -> tokio::task::JoinHandle<bool> {
    let asker = h.asker.clone();
    tokio::spawn(async move {
        asker
            .confirm(&Origin::Window, &q, CancellationToken::new())
            .await
    })
}

/// The next frame the window was sent, which must be a question.
async fn asked(rx: &mut mpsc::Receiver<DraftFrame>) -> String {
    match timeout(WAIT, rx.recv()).await {
        Ok(Some(DraftFrame::Ask(q))) => q,
        other => panic!("expected a question, got {other:?}"),
    }
}

async fn settled(pending: tokio::task::JoinHandle<bool>) -> bool {
    timeout(WAIT, pending)
        .await
        .expect("the question was never settled")
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn asks_attached_window() {
    let h = asker(Some("chat-p"));
    let run = RunId("run-1".into());
    let (tx, mut rx) = mpsc::channel(8);
    h.window.attach(run.clone(), tx);
    assert!(h.window.attached(run.clone()));
    assert!(h.asker.window().is_some());

    let pending = confirm(&h, question("run-1", "Delete the old backups?"));
    assert_eq!(asked(&mut rx).await, "Delete the old backups?");
    assert!(h.window.answer(true), "no question was open");
    assert!(settled(pending).await);

    // Recorded like any other approval, answered by the window; no chat was bothered.
    let row = h.store.approval(1).unwrap().expect("an approvals row");
    assert_eq!(row.run, "run-1");
    assert_eq!(row.answer, Some(true));
    assert_eq!(row.via.as_deref(), Some("window"));
    let origin: Origin = serde_json::from_str(&row.origin).unwrap();
    assert_eq!(origin, Origin::Window);
    assert!(h.ch.asks().is_empty(), "{:?}", h.ch.asks());
    // Nothing is open any more.
    assert!(!h.window.answer(true));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn falls_back_to_primary_chat() {
    // Not watched: the primary chat gets the buttons.
    let h = asker(Some("chat-p"));
    assert!(!h.window.attached(RunId("run-1".into())));
    let pending = confirm(&h, question("run-1", "Delete the old backups?"));
    assert!(settled(pending).await);
    assert_eq!(
        h.ch.asks(),
        vec![(
            "chat-p".to_string(),
            "Delete the old backups?\n\nwipe(path=old) (#1)".to_string()
        )]
    );
    assert_eq!(
        h.store.approval(1).unwrap().unwrap().via.as_deref(),
        Some("fake")
    );

    // A window that lets go mid-question is never a yes: the question moves to the chat.
    let h = asker(Some("chat-p"));
    let run = RunId("run-2".into());
    let (tx, mut rx) = mpsc::channel(8);
    h.window.attach(run.clone(), tx);
    let pending = confirm(&h, question("run-2", "Send the email?"));
    asked(&mut rx).await;
    h.window.detach(run.clone());
    assert!(!h.window.attached(run));
    assert!(settled(pending).await);
    assert_eq!(h.ch.asks().len(), 1, "the chat was not asked");
    assert_eq!(
        h.store.approval(1).unwrap().unwrap().via.as_deref(),
        Some("fake")
    );
    assert!(!h.window.answer(true), "the window still held the question");

    // Not watched and no chat: nowhere to ask, so no.
    let h = asker(None);
    let pending = confirm(&h, question("run-3", "Pay the bill?"));
    assert!(!settled(pending).await);
    assert!(h.ch.asks().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_answers_false() {
    let h = asker(Some("chat-p"));
    let run = RunId("run-1".into());
    let (tx, mut rx) = mpsc::channel(8);
    h.window.attach(run, tx);
    let pending = confirm(&h, question("run-1", "Delete the old backups?"));
    asked(&mut rx).await;
    h.window.cancel_open();
    assert!(!settled(pending).await);
    let row = h.store.approval(1).unwrap().unwrap();
    assert_eq!(row.answer, Some(false));
    assert_eq!(row.via.as_deref(), Some("window"));
    assert!(h.ch.asks().is_empty());
    // Stop with nothing open does nothing.
    h.window.cancel_open();
    assert!(!h.window.answer(false));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_question_at_a_time() {
    let h = asker(None);
    let (tx1, mut rx1) = mpsc::channel(8);
    let (tx2, mut rx2) = mpsc::channel(8);
    h.window.attach(RunId("run-1".into()), tx1);
    h.window.attach(RunId("run-2".into()), tx2);
    assert!(!h.window.answer(true), "nothing is open yet");

    let first = confirm(&h, question("run-1", "First?"));
    assert_eq!(asked(&mut rx1).await, "First?");
    let second = confirm(&h, question("run-2", "Second?"));
    // The second waits while the first is open.
    let early = timeout(Duration::from_millis(500), rx2.recv()).await;
    assert!(
        early.is_err(),
        "asked a second question while one was open: {early:?}"
    );
    assert!(!second.is_finished());

    // One answer settles one question.
    assert!(h.window.answer(true));
    assert!(settled(first).await);
    assert_eq!(asked(&mut rx2).await, "Second?");
    assert!(h.window.answer(false));
    assert!(!settled(second).await);
    assert_eq!(h.store.approval(1).unwrap().unwrap().answer, Some(true));
    assert_eq!(h.store.approval(2).unwrap().unwrap().answer, Some(false));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn answer_from_a_chat_closes_the_window_question() {
    // `/approve` from a chat answers the same row: the window's question goes away.
    let h = asker(None);
    let run = RunId("run-1".into());
    let (tx, mut rx) = mpsc::channel(8);
    h.window.attach(run, tx);
    let bus = Bus::new(64);
    let asker = Asker::with_window(
        ChannelSet::new(),
        h.store.clone(),
        bus.clone(),
        h.window.clone(),
    );
    let q = question("run-1", "Delete the old backups?");
    let pending = tokio::spawn(async move {
        asker
            .confirm(&Origin::Window, &q, CancellationToken::new())
            .await
    });
    asked(&mut rx).await;
    assert!(h.store.approval_answer(1, true, "telegram", 1).unwrap());
    bus.publish(alexia_core::Event::Answered {
        at: 1,
        approval: 1,
        answer: true,
    });
    assert!(settled(pending).await);
    assert!(!h.window.answer(false), "the window question stayed open");
}

// ---- the gateway ignores the window's frames ----

/// "Hello", then a step, a note and a question, then " there".
struct WindowyBrain;

#[async_trait::async_trait]
impl Brain for WindowyBrain {
    async fn reply(
        &self,
        _: Turn,
        draft: DraftSink,
        _: CancellationToken,
    ) -> std::result::Result<Reply, BrainError> {
        let step = StepFrame {
            n: 1,
            name: "look".into(),
            args: Some(serde_json::json!({ "where": "here" })),
            progress: None,
            outcome: None,
        };
        let frames = [
            DraftFrame::Delta("Hello".into()),
            DraftFrame::Step(step),
            DraftFrame::Note("Understood.".into()),
            DraftFrame::Ask("Allow it?".into()),
            DraftFrame::Delta(" there".into()),
        ];
        for f in frames {
            let _ = draft.send(f).await;
            sleep(Duration::from_millis(400)).await;
        }
        Ok(Reply {
            text: "Hello there".into(),
            files: vec![],
            lane: Lane::Task,
            model: None,
            spans: vec![],
        })
    }
}

struct NoMedia;

#[async_trait::async_trait]
impl Media for NoMedia {
    async fn transcribe(&self, _: &InFile, _: CancellationToken) -> Result<Option<String>> {
        Ok(None)
    }
    async fn speak(&self, _: &str, _: CancellationToken) -> Result<Option<OutFile>> {
        Ok(None)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn telegram_ignores_new_frames() {
    let store = Arc::new(Store::open_in_memory().unwrap());
    let (ch, inbox) = FakeChannel::new(true);
    let channels = ChannelSet::new();
    channels.add(ch.clone());
    let gw = Gateway::with_channels(
        GatewayConfig {
            merge_ms: 10,
            ..GatewayConfig::default()
        },
        store,
        Bus::new(64),
        Arc::new(WindowyBrain),
        Arc::new(NoMedia),
        channels,
    );
    let cancel = CancellationToken::new();
    let run = tokio::spawn(gw.run(cancel.clone()));
    inbox
        .send(vec![Inbound {
            chat: ChatRef { chat: "a".into() },
            msg: MsgRef { id: "1".into() },
            kind: InKind::Message,
            from_owner: true,
            content: Content::Text("look around".into()),
            files: vec![],
            at: 0,
            button: None,
            reply_to: None,
        }])
        .unwrap();
    let end = Instant::now() + WAIT;
    while ch.sent().is_empty() {
        assert!(Instant::now() < end, "timed out waiting for the reply");
        sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(ch.sent(), vec!["Hello there".to_string()]);
    // The draft moved with the text alone: no step, note or question reached the chat.
    assert_eq!(
        ch.drafts(),
        vec!["Hello".to_string(), "Hello there".to_string()]
    );
    assert!(ch.asks().is_empty());
    cancel.cancel();
    let r = timeout(WAIT, run).await;
    assert!(matches!(r, Ok(Ok(Ok(())))), "the gateway did not stop");
}

#[test]
fn asker_without_window_has_none() {
    let store = Arc::new(Store::open_in_memory().unwrap());
    let a = Asker::new(ChannelSet::new(), store, Bus::new(4));
    assert!(a.window().is_none());
    // `Ask` is still what the agent holds.
    let _: Arc<dyn Ask> = a;
}
