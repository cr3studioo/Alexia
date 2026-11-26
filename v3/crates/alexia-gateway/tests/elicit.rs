// SPDX-License-Identifier: AGPL-3.0-only
//! P3-36: a plugin's yes/no form put to the owner by the gateway's `Asker` — in the window
//! watching the run, else the primary chat, else nowhere (cancel). Only the owner's Approve
//! is `Accept`; the form's text is never stored.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::{
    Ask, Budget, Bus, DraftFrame, Elicitation, Elicited, JobId, Origin, Question, RunId,
    ELICIT_WAIT,
};
use alexia_gateway::{
    Asker, Channel, ChannelSet, ChatRef, Error, MsgRef, Outbound, Result, WindowQuestions,
};
use alexia_store::{now_ms, Store};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

/// How long any wait here may take before the test fails.
const WAIT: Duration = Duration::from_secs(30);
/// What every form here carries, so the store can be searched for it.
const MARKER: &str = "MARKER-7f3a-secret-body";

// ---- fake channel ----

/// What the fake channel's buttons do.
#[derive(Clone, Copy)]
enum Buttons {
    Yes,
    No,
    /// Never pressed: waits until the question is withdrawn.
    Wait,
}

struct FakeChannel {
    buttons: Mutex<Buttons>,
    fail_send: Mutex<bool>,
    asks: Mutex<Vec<(String, String)>>,
    sent: Mutex<Vec<String>>,
}

impl FakeChannel {
    fn new(buttons: Buttons) -> Arc<FakeChannel> {
        Arc::new(FakeChannel {
            buttons: Mutex::new(buttons),
            fail_send: Mutex::new(false),
            asks: Mutex::new(Vec::new()),
            sent: Mutex::new(Vec::new()),
        })
    }
    fn set(&self, b: Buttons) {
        *self.buttons.lock().unwrap() = b;
    }
    fn asks(&self) -> Vec<(String, String)> {
        self.asks.lock().unwrap().clone()
    }
    fn sent(&self) -> Vec<String> {
        self.sent.lock().unwrap().clone()
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
    async fn next(&self, cancel: CancellationToken) -> Result<Vec<alexia_gateway::Inbound>> {
        cancel.cancelled().await;
        Err(Error::Cancelled)
    }
    async fn react(&self, _: &ChatRef, _: &MsgRef, _: &str) -> Result<()> {
        Ok(())
    }
    async fn typing(&self, _: &ChatRef) -> Result<()> {
        Ok(())
    }
    async fn send(&self, _: &ChatRef, out: &Outbound) -> Result<MsgRef> {
        if *self.fail_send.lock().unwrap() {
            return Err(Error::Cancelled);
        }
        self.sent.lock().unwrap().push(out.text.clone());
        Ok(MsgRef { id: "s".into() })
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
        let b = *self.buttons.lock().unwrap();
        match b {
            Buttons::Yes => Ok(Some(true)),
            Buttons::No => Ok(Some(false)),
            Buttons::Wait => {
                cancel.cancelled().await;
                Ok(None)
            }
        }
    }
}

// ---- the asker ----

struct H {
    ch: Arc<FakeChannel>,
    store: Arc<Store>,
    window: WindowQuestions,
    asker: Arc<Asker>,
}

/// An asker with the window's questions and one fake channel; `primary` is its primary chat.
fn asker(primary: Option<&str>, buttons: Buttons) -> H {
    let store = Arc::new(Store::open_in_memory().unwrap());
    if let Some(chat) = primary {
        store.channel_session("fake", chat).unwrap();
        store.set_primary_chat("fake", chat).unwrap();
    }
    let ch = FakeChannel::new(buttons);
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

fn form(run: &str, message: &str) -> Elicitation {
    Elicitation {
        run: RunId(run.into()),
        plugin: "mail-fixture".into(),
        name: "Mail Fixture".into(),
        message: message.into(),
        wait: ELICIT_WAIT,
    }
}

fn mail() -> String {
    format!("Send this email?\nTo: owner@example.org\nSubject: Test\n\n{MARKER}")
}

/// Elicits in the background.
fn elicit(
    h: &H,
    origin: Origin,
    e: Elicitation,
    cancel: CancellationToken,
) -> tokio::task::JoinHandle<Elicited> {
    let asker = h.asker.clone();
    tokio::spawn(async move { asker.elicit(&origin, &e, cancel).await })
}

async fn settled<T>(pending: tokio::task::JoinHandle<T>) -> T {
    timeout(WAIT, pending)
        .await
        .expect("the question was never settled")
        .unwrap()
}

/// The next frame the window was sent, which must be a question.
async fn asked(rx: &mut mpsc::Receiver<DraftFrame>) -> String {
    match timeout(WAIT, rx.recv()).await {
        Ok(Some(DraftFrame::Ask(q))) => q,
        other => panic!("expected a question, got {other:?}"),
    }
}

/// Waits until the fake channel has been asked `n` times.
async fn chat_asked(ch: &FakeChannel, n: usize) {
    timeout(WAIT, async {
        while ch.asks().len() < n {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the chat was never asked");
}

fn row(store: &Store, id: i64) -> alexia_store::ApprovalRow {
    store.approval(id).unwrap().expect("an approvals row")
}

/// No text in any column of any table holds `marker`.
fn assert_not_stored(store: &Store, marker: &str) {
    let found = stored_in(store, marker);
    assert!(found.is_empty(), "the form's text was stored in {found:?}");
}

/// The tables that hold `marker` in some text or blob column.
fn stored_in(store: &Store, marker: &str) -> Vec<String> {
    store
        .transaction(|tx| {
            let tables: Vec<String> = tx
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<_, _>>()?;
            let mut found = Vec::new();
            for t in tables {
                let Ok(mut st) = tx.prepare(&format!("SELECT * FROM \"{t}\"")) else {
                    continue; // a virtual table's module refuses a full scan: it holds vectors
                };
                let n = st.column_count();
                let mut rows = st.query([])?;
                while let Some(r) = rows.next()? {
                    for i in 0..n {
                        let v = r.get_ref(i)?;
                        let text = v.as_str().map(str::to_string).ok().or_else(|| {
                            v.as_blob().ok().map(|b| String::from_utf8_lossy(b).into())
                        });
                        if text.is_some_and(|s| s.contains(marker)) {
                            found.push(t.clone());
                        }
                    }
                }
            }
            Ok(found)
        })
        .unwrap()
}

// ---- tests ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn window_run_asks_in_window() {
    let h = asker(Some("chat-p"), Buttons::Yes);
    let run = RunId("run-1".into());
    let (tx, mut rx) = mpsc::channel(8);
    h.window.attach(run.clone(), tx);

    let pending = elicit(
        &h,
        Origin::Window,
        form("run-1", &mail()),
        CancellationToken::new(),
    );
    let q = asked(&mut rx).await;
    assert!(q.starts_with("Mail Fixture (mail-fixture) asks:"), "{q}");
    assert!(q.contains(&mail()), "{q}");
    assert!(h.window.answer(true), "no question was open");
    assert_eq!(settled(pending).await, Elicited::Accept);

    let pending = elicit(
        &h,
        Origin::Window,
        form("run-1", &mail()),
        CancellationToken::new(),
    );
    asked(&mut rx).await;
    assert!(h.window.answer(false), "no question was open");
    assert_eq!(settled(pending).await, Elicited::Decline);

    // Both rows: the run, the window, the generic text and no detail. No chat was asked.
    let r = row(&h.store, 1);
    assert_eq!(r.run, "run-1");
    assert_eq!(
        r.text,
        "Mail Fixture (mail-fixture) asks you to confirm something."
    );
    assert_eq!(r.detail, None);
    assert_eq!((r.answer, r.via.as_deref()), (Some(true), Some("window")));
    let r = row(&h.store, 2);
    assert_eq!((r.answer, r.via.as_deref()), (Some(false), Some("window")));
    assert!(h.ch.asks().is_empty(), "{:?}", h.ch.asks());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn telegram_when_window_not_watching() {
    let h = asker(Some("chat-p"), Buttons::Yes);
    assert!(!h.window.attached(RunId("run-1".into())));
    let pending = elicit(
        &h,
        Origin::Window,
        form("run-1", &mail()),
        CancellationToken::new(),
    );
    assert_eq!(settled(pending).await, Elicited::Accept);

    let asks = h.ch.asks();
    assert_eq!(asks.len(), 1, "{asks:?}");
    assert_eq!(asks[0].0, "chat-p");
    assert!(
        asks[0].1.starts_with("Mail Fixture (mail-fixture) asks:"),
        "{}",
        asks[0].1
    );
    assert!(asks[0].1.contains(&mail()));
    assert!(asks[0].1.ends_with("(#1)"), "{}", asks[0].1);
    assert_eq!(row(&h.store, 1).via.as_deref(), Some("fake"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scheduler_run_asks_primary_chat() {
    let h = asker(Some("chat-p"), Buttons::No);
    let origin = Origin::Scheduler { job: JobId(3) };
    let pending = elicit(&h, origin, form("run-s", &mail()), CancellationToken::new());
    assert_eq!(settled(pending).await, Elicited::Decline);
    let asks = h.ch.asks();
    assert_eq!(asks.len(), 1, "{asks:?}");
    assert_eq!(asks[0].0, "chat-p");
    assert!(asks[0].1.starts_with("Mail Fixture (mail-fixture) asks:"));
}

#[tokio::test(start_paused = true)]
async fn nowhere_to_ask_cancels_at_once() {
    // No primary chat and no window watching: nobody can answer.
    let h = asker(None, Buttons::Yes);
    for origin in [Origin::Window, Origin::Scheduler { job: JobId(1) }] {
        let answer = timeout(
            Duration::from_millis(50),
            h.asker
                .elicit(&origin, &form("run-1", &mail()), CancellationToken::new()),
        )
        .await
        .expect("it waited");
        assert_eq!(answer, Elicited::Cancel);
    }
    assert!(h.store.approval(1).unwrap().is_none(), "a row was written");
    assert!(h.store.approvals_pending().unwrap().is_empty());
    assert!(h.ch.asks().is_empty());
    assert!(h.ch.sent().is_empty());
}

#[tokio::test(start_paused = true)]
async fn timeout_is_cancel() {
    let h = asker(Some("chat-p"), Buttons::Wait);
    let started = tokio::time::Instant::now();
    let answer = h
        .asker
        .elicit(
            &Origin::Window,
            &form("run-1", &mail()),
            CancellationToken::new(),
        )
        .await;
    assert_eq!(answer, Elicited::Cancel);
    let waited = started.elapsed();
    assert!(
        waited >= ELICIT_WAIT && waited < ELICIT_WAIT + Duration::from_secs(1),
        "{waited:?}"
    );
    let r = row(&h.store, 1);
    assert_eq!((r.answer, r.via.as_deref()), (Some(false), Some("timeout")));
    assert_eq!(
        h.ch.sent(),
        vec!["— no answer, so nothing was done".to_string()]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_is_cancel_not_decline() {
    let h = asker(Some("chat-p"), Buttons::Yes);
    let run = RunId("run-1".into());
    let (tx, mut rx) = mpsc::channel(8);
    h.window.attach(run.clone(), tx);

    let pending = elicit(
        &h,
        Origin::Window,
        form("run-1", &mail()),
        CancellationToken::new(),
    );
    asked(&mut rx).await;
    h.window.cancel_open();
    assert_eq!(settled(pending).await, Elicited::Cancel);
    let r = row(&h.store, 1);
    assert_eq!(
        (r.answer, r.via.as_deref()),
        (Some(false), Some("cancelled"))
    );

    // A run's own question, stopped: still a plain no, as before.
    let asker = h.asker.clone();
    let q = Question {
        run: run.clone(),
        text: "Delete the old backups?".into(),
        detail: None,
    };
    let pending = tokio::spawn(async move {
        asker
            .confirm(&Origin::Window, &q, CancellationToken::new())
            .await
    });
    asked(&mut rx).await;
    h.window.cancel_open();
    assert!(!settled(pending).await);
    let r = row(&h.store, 2);
    assert_eq!((r.answer, r.via.as_deref()), (Some(false), Some("window")));
    assert!(h.ch.asks().is_empty(), "{:?}", h.ch.asks());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_token_is_cancel() {
    let h = asker(Some("chat-p"), Buttons::Wait);
    let cancel = CancellationToken::new();
    let pending = elicit(&h, Origin::Window, form("run-1", &mail()), cancel.clone());
    chat_asked(&h.ch, 1).await;
    cancel.cancel();
    assert_eq!(settled(pending).await, Elicited::Cancel);

    let r = row(&h.store, 1);
    assert_eq!(
        (r.answer, r.via.as_deref()),
        (Some(false), Some("cancelled"))
    );
    // Settled, so nothing can answer it later.
    assert!(!h
        .store
        .approval_answer(1, true, "telegram", now_ms())
        .unwrap());
    assert_eq!(row(&h.store, 1).answer, Some(false));

    // Withdrawn before anything was asked: cancel, and nothing written.
    let gone = CancellationToken::new();
    gone.cancel();
    let answer = h
        .asker
        .elicit(&Origin::Window, &form("run-2", &mail()), gone)
        .await;
    assert_eq!(answer, Elicited::Cancel);
    assert!(h.store.approval(2).unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_answer_only() {
    let h = asker(Some("chat-p"), Buttons::Yes);
    let pending = elicit(
        &h,
        Origin::Window,
        form("run-1", &mail()),
        CancellationToken::new(),
    );
    assert_eq!(settled(pending).await, Elicited::Accept);
    // A late `/approve` or second press is refused: the first answer stands.
    assert!(!h
        .store
        .approval_answer(1, false, "other", now_ms())
        .unwrap());
    let r = row(&h.store, 1);
    assert_eq!((r.answer, r.via.as_deref()), (Some(true), Some("fake")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn long_message_sent_then_asked() {
    let h = asker(Some("chat-p"), Buttons::Yes);
    let long = format!("{MARKER}{}", "x".repeat(6_000));
    let e = form("run-1", &long);
    let pending = elicit(&h, Origin::Window, e.clone(), CancellationToken::new());
    assert_eq!(settled(pending).await, Elicited::Accept);

    // The whole prompt went first, as one send (the channel splits it), then one short ask.
    assert_eq!(h.ch.sent(), vec![e.prompt()]);
    assert!(h.ch.sent()[0].contains(&long));
    let asks = h.ch.asks();
    assert_eq!(asks.len(), 1, "{asks:?}");
    assert_eq!(
        asks[0].1,
        "Mail Fixture (mail-fixture) asks: yes to the message above? (#1)"
    );

    // The message cannot be sent: the owner never saw it, so cancel, and no ask.
    *h.ch.fail_send.lock().unwrap() = true;
    let pending = elicit(&h, Origin::Window, e, CancellationToken::new());
    assert_eq!(settled(pending).await, Elicited::Cancel);
    assert_eq!(h.ch.asks().len(), 1);
    let r = row(&h.store, 2);
    assert_eq!((r.answer, r.via.as_deref()), (Some(false), Some("failed")));
}

#[tokio::test(start_paused = true)]
async fn text_never_stored() {
    let h = asker(Some("chat-p"), Buttons::Yes);
    let run = RunId("run-w".into());
    let (tx, mut rx) = mpsc::channel(8);
    h.window.attach(run.clone(), tx);
    let none = CancellationToken::new;

    // Accept in the chat.
    let a = h
        .asker
        .elicit(&Origin::Window, &form("run-1", &mail()), none())
        .await;
    assert_eq!(a, Elicited::Accept);
    assert_not_stored(&h.store, MARKER);

    // Decline in the chat.
    h.ch.set(Buttons::No);
    let a = h
        .asker
        .elicit(&Origin::Window, &form("run-1", &mail()), none())
        .await;
    assert_eq!(a, Elicited::Decline);
    assert_not_stored(&h.store, MARKER);

    // No answer: timeout.
    h.ch.set(Buttons::Wait);
    let a = h
        .asker
        .elicit(&Origin::Window, &form("run-1", &mail()), none())
        .await;
    assert_eq!(a, Elicited::Cancel);
    assert_not_stored(&h.store, MARKER);

    // In the window: Deny, then Stop.
    let pending = elicit(&h, Origin::Window, form("run-w", &mail()), none());
    asked(&mut rx).await;
    assert!(h.window.answer(false));
    assert_eq!(settled(pending).await, Elicited::Decline);
    let pending = elicit(&h, Origin::Window, form("run-w", &mail()), none());
    asked(&mut rx).await;
    h.window.cancel_open();
    assert_eq!(settled(pending).await, Elicited::Cancel);
    assert_not_stored(&h.store, MARKER);

    // A long one, accepted.
    h.ch.set(Buttons::Yes);
    let long = format!("{MARKER}{}", "y".repeat(6_000));
    let a = h
        .asker
        .elicit(&Origin::Window, &form("run-1", &long), none())
        .await;
    assert_eq!(a, Elicited::Accept);
    assert_not_stored(&h.store, MARKER);
    // Six rows, all with the generic text.
    for id in 1..=6 {
        assert_eq!(
            row(&h.store, id).text,
            "Mail Fixture (mail-fixture) asks you to confirm something."
        );
    }
    // The walk does find text it is looking for (it is not passing by seeing nothing).
    h.store
        .approval_open("run-x", "{}", MARKER, None, now_ms())
        .unwrap();
    assert!(stored_in(&h.store, MARKER).contains(&"approvals".to_string()));
}
