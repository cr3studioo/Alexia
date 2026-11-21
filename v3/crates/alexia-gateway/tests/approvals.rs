// SPDX-License-Identifier: AGPL-3.0-only
//! P2-29: every approval question is a row in `approvals`, answerable from any chat.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::{Ask, Budget, Bus, Event, Origin, Question, RunId};
use alexia_gateway::{Asker, Channel, ChannelSet, ChatRef, Inbound, MsgRef, Outbound, Result};
use alexia_store::Store;
use tokio::sync::Notify;
use tokio::time::{sleep, Instant};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
enum Mode {
    Yes,
    No,
    Hang,
    /// Taps Approve once the notify fires.
    Gated(Arc<Notify>),
}

struct Fake {
    mode: Mode,
    asks: Mutex<Vec<(String, String)>>,
    sent: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl Channel for Fake {
    fn name(&self) -> &'static str {
        "fake"
    }
    fn budget(&self) -> Budget {
        Budget::CHAT
    }
    async fn next(&self, cancel: CancellationToken) -> Result<Vec<Inbound>> {
        cancel.cancelled().await;
        Err(alexia_gateway::Error::Cancelled)
    }
    async fn react(&self, _: &ChatRef, _: &MsgRef, _: &str) -> Result<()> {
        Ok(())
    }
    async fn typing(&self, _: &ChatRef) -> Result<()> {
        Ok(())
    }
    async fn send(&self, _: &ChatRef, out: &Outbound) -> Result<MsgRef> {
        self.sent.lock().unwrap().push(out.text.clone());
        Ok(MsgRef { id: "m".into() })
    }
    async fn draft(&self, _: &ChatRef, _: Option<&str>) -> Result<()> {
        Ok(())
    }
    async fn edit(&self, _: &ChatRef, _: &MsgRef, _: &str) -> Result<()> {
        Ok(())
    }
    async fn ask(
        &self,
        chat: &ChatRef,
        text: &str,
        cancel: CancellationToken,
    ) -> Result<Option<bool>> {
        self.asks
            .lock()
            .unwrap()
            .push((chat.chat.clone(), text.to_string()));
        match &self.mode {
            Mode::Yes => Ok(Some(true)),
            Mode::No => Ok(Some(false)),
            Mode::Hang => {
                cancel.cancelled().await;
                Ok(None)
            }
            Mode::Gated(n) => {
                tokio::select! {
                    _ = n.notified() => Ok(Some(true)),
                    _ = cancel.cancelled() => Ok(None),
                }
            }
        }
    }
}

struct H {
    store: Arc<Store>,
    bus: Bus,
    ch: Arc<Fake>,
    asker: Arc<Asker>,
}

fn start(mode: Mode) -> H {
    let store = Arc::new(Store::open_in_memory().unwrap());
    let bus = Bus::new(64);
    let ch = Arc::new(Fake {
        mode,
        asks: Mutex::new(Vec::new()),
        sent: Mutex::new(Vec::new()),
    });
    let channels = ChannelSet::new();
    channels.add(ch.clone());
    let asker = Asker::new(channels, store.clone(), bus.clone());
    H {
        store,
        bus,
        ch,
        asker,
    }
}

fn question() -> Question {
    Question {
        run: RunId("run-9".into()),
        text: "Send the mail?".into(),
        detail: Some("to: bob".into()),
    }
}

fn origin() -> Origin {
    Origin::Channel {
        channel: "fake".into(),
        chat: "chat-a".into(),
    }
}

impl H {
    fn confirm(&self, cancel: CancellationToken) -> tokio::task::JoinHandle<bool> {
        let asker = self.asker.clone();
        tokio::spawn(async move { asker.confirm(&origin(), &question(), cancel).await })
    }
    async fn asked(&self) {
        let end = Instant::now() + Duration::from_secs(30);
        while self.ch.asks.lock().unwrap().is_empty() {
            assert!(Instant::now() < end, "never asked");
            sleep(Duration::from_millis(5)).await;
        }
    }
    fn sent(&self) -> Vec<String> {
        self.ch.sent.lock().unwrap().clone()
    }
}

async fn done(h: tokio::task::JoinHandle<bool>) -> bool {
    tokio::time::timeout(Duration::from_secs(30), h)
        .await
        .expect("confirm hung")
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn row_per_question() {
    let h = start(Mode::Hang);
    let cancel = CancellationToken::new();
    let t = h.confirm(cancel.clone());
    h.asked().await;
    let rows = h.store.approvals_pending().unwrap();
    assert_eq!(rows.len(), 1);
    let r = &rows[0];
    assert_eq!(r.run, "run-9");
    assert_eq!(r.text, "Send the mail?");
    assert_eq!(r.detail.as_deref(), Some("to: bob"));
    assert!(r.origin.contains("chat-a"), "origin: {}", r.origin);
    let (chat, text) = h.ch.asks.lock().unwrap()[0].clone();
    assert_eq!(chat, "chat-a");
    assert_eq!(text, format!("Send the mail?\n\nto: bob (#{})", r.id));
    cancel.cancel();
    done(t).await;

    // A second question is a second row.
    let t = h.confirm(CancellationToken::new());
    let end = Instant::now() + Duration::from_secs(30);
    while h.store.approvals_pending().unwrap().len() < 2 {
        assert!(Instant::now() < end, "no second row");
        sleep(Duration::from_millis(5)).await;
    }
    t.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn button_answers() {
    for (mode, want) in [(Mode::Yes, true), (Mode::No, false)] {
        let h = start(mode);
        assert_eq!(done(h.confirm(CancellationToken::new())).await, want);
        let r = h.store.approval(1).unwrap().unwrap();
        assert_eq!(r.answer, Some(want));
        assert_eq!(r.via.as_deref(), Some("fake"));
        assert!(r.answered_at.is_some());
        assert!(
            h.sent().is_empty(),
            "a note went to the chat that was tapped"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn slash_approve_from_other_chat_answers() {
    let h = start(Mode::Hang);
    let t = h.confirm(CancellationToken::new());
    h.asked().await;
    // What `/approve 1` does in another chat: record it, then say so on the bus.
    assert!(h.store.approval_answer(1, true, "telegram", 5).unwrap());
    h.bus.publish(Event::Answered {
        at: 5,
        approval: 1,
        answer: true,
    });
    assert!(done(t).await);
    assert_eq!(h.sent(), vec!["— Approved from telegram".to_string()]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn first_answer_wins() {
    let gate = Arc::new(Notify::new());
    let h = start(Mode::Gated(gate.clone()));
    let t = h.confirm(CancellationToken::new());
    h.asked().await;
    // `/deny 1` lands first, but its bus event is lost; the button then says yes.
    assert!(h.store.approval_answer(1, false, "telegram", 5).unwrap());
    gate.notify_one();
    assert!(!done(t).await, "the later button answer overrode the first");
    let r = h.store.approval(1).unwrap().unwrap();
    assert_eq!(r.answer, Some(false));
    assert_eq!(r.via.as_deref(), Some("telegram"));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn timeout_is_no_and_recorded() {
    let h = start(Mode::Hang);
    let t = h.confirm(CancellationToken::new());
    while h.ch.asks.lock().unwrap().is_empty() {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_secs(9 * 60 + 59)).await;
    tokio::task::yield_now().await;
    assert!(!t.is_finished(), "gave up before ten minutes");
    assert!(h.store.approval(1).unwrap().unwrap().answer.is_none());
    tokio::time::advance(Duration::from_secs(2)).await;
    assert!(!t.await.unwrap());
    let r = h.store.approval(1).unwrap().unwrap();
    assert_eq!(r.answer, Some(false));
    assert_eq!(r.via.as_deref(), Some("timeout"));
    assert!(h.store.approvals_pending().unwrap().is_empty());
    assert_eq!(h.sent(), vec!["— no answer, so I didn't".to_string()]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_leaves_row_unanswered() {
    let h = start(Mode::Hang);
    let cancel = CancellationToken::new();
    let t = h.confirm(cancel.clone());
    h.asked().await;
    cancel.cancel();
    assert!(!done(t).await);
    let r = h.store.approval(1).unwrap().unwrap();
    assert!(r.answer.is_none() && r.answered_at.is_none());
    assert_eq!(h.store.approvals_pending().unwrap().len(), 1);
    assert!(h.sent().is_empty());
}
