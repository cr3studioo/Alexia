// SPDX-License-Identifier: AGPL-3.0-only
//! P4-32: notices follow the owner, and the conversation follows them across faces (HB-06,
//! HB-04). Two fake channels, "telegram" and "device", as `tests/gateway.rs` builds its one.
//! Real time; every wait is bounded by `until` (30 s).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::{
    Brain, BrainError, Budget, Bus, DraftFrame, DraftSink, Event, Lane, Origin, Reply, Turn,
    Urgency,
};
use alexia_gateway::{
    Channel, ChannelSet, ChatRef, Error, Gateway, GatewayConfig, InKind, Inbound, Media, MsgRef,
    Outbound, Result,
};
use alexia_store::{now_ms, Content, SessionId, Store};
use tokio::sync::{mpsc, Semaphore};
use tokio::time::{sleep, Instant};
use tokio_util::sync::CancellationToken;

const HANDOFF_MS: i64 = 30 * 60 * 1000;

// ---- fake channel ----

struct Fake {
    name: &'static str,
    inbox: tokio::sync::Mutex<mpsc::UnboundedReceiver<Vec<Inbound>>>,
    /// (chat, text) of every `send`.
    sent: Mutex<Vec<(String, String)>>,
    /// (chat, text) of every `draft(Some(..))`.
    drafts: Mutex<Vec<(String, String)>>,
    fail_send: AtomicBool,
    /// Sends to this one chat fail.
    dead_chat: Mutex<Option<String>>,
    /// The chat of every `draft(None)`.
    cleared: Mutex<Vec<String>>,
}

impl Fake {
    fn sent(&self) -> Vec<(String, String)> {
        self.sent.lock().unwrap().clone()
    }
    fn texts(&self) -> Vec<String> {
        self.sent().into_iter().map(|(_, t)| t).collect()
    }
}

#[async_trait::async_trait]
impl Channel for Fake {
    fn name(&self) -> &'static str {
        self.name
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
    async fn send(&self, chat: &ChatRef, out: &Outbound) -> Result<MsgRef> {
        if self.fail_send.load(Ordering::SeqCst)
            || self.dead_chat.lock().unwrap().as_deref() == Some(chat.chat.as_str())
        {
            return Err(Error::Unreachable);
        }
        self.sent
            .lock()
            .unwrap()
            .push((chat.chat.clone(), out.text.clone()));
        Ok(MsgRef { id: "m".into() })
    }
    async fn draft(&self, chat: &ChatRef, text: Option<&str>) -> Result<()> {
        match text {
            Some(t) => self
                .drafts
                .lock()
                .unwrap()
                .push((chat.chat.clone(), t.to_string())),
            None => self.cleared.lock().unwrap().push(chat.chat.clone()),
        }
        Ok(())
    }
    async fn edit(&self, _: &ChatRef, _: &MsgRef, _: &str) -> Result<()> {
        Ok(())
    }
    async fn ask(&self, _: &ChatRef, _: &str, _: CancellationToken) -> Result<Option<bool>> {
        Ok(None)
    }
}

struct NoMedia;

#[async_trait::async_trait]
impl Media for NoMedia {
    async fn transcribe(
        &self,
        _: &alexia_gateway::InFile,
        _: CancellationToken,
    ) -> Result<Option<String>> {
        Ok(None)
    }
    async fn speak(&self, _: &str, _: CancellationToken) -> Result<Option<alexia_core::OutFile>> {
        Ok(None)
    }
}

// ---- fake brain ----

/// Answers "re:<text>". A turn first shows a `part` draft (so it counts as visible), then waits
/// for a permit from `gate`; tests with no gate hand out plenty.
struct Brain1 {
    turns: Mutex<Vec<(SessionId, Origin, String)>>,
    gate: Arc<Semaphore>,
}

#[async_trait::async_trait]
impl Brain for Brain1 {
    async fn reply(
        &self,
        turn: Turn,
        draft: DraftSink,
        cancel: CancellationToken,
    ) -> std::result::Result<Reply, BrainError> {
        let text = match &turn.content {
            Content::Text(t) => t.clone(),
            Content::Parts(_) => "<parts>".into(),
        };
        self.turns
            .lock()
            .unwrap()
            .push((turn.session, turn.origin.clone(), text.clone()));
        let _ = draft.send(DraftFrame::Delta("part".into())).await;
        tokio::select! {
            _ = cancel.cancelled() => return Err(BrainError::Cancelled),
            p = self.gate.acquire() => p.expect("gate open").forget(),
        }
        Ok(Reply {
            text: format!("re:{text}"),
            files: vec![],
            lane: Lane::Chat,
            model: None,
            spans: vec![],
        })
    }
}

// ---- harness ----

struct H {
    tg: Arc<Fake>,
    dev: Arc<Fake>,
    tg_in: mpsc::UnboundedSender<Vec<Inbound>>,
    dev_in: mpsc::UnboundedSender<Vec<Inbound>>,
    brain: Arc<Brain1>,
    store: Arc<Store>,
    bus: Bus,
    /// What `follow` answers.
    at: Arc<Mutex<Option<Origin>>>,
    cancel: CancellationToken,
    run: tokio::task::JoinHandle<Result<()>>,
}

fn fake(name: &'static str) -> (Arc<Fake>, mpsc::UnboundedSender<Vec<Inbound>>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let f = Arc::new(Fake {
        name,
        inbox: tokio::sync::Mutex::new(rx),
        sent: Mutex::new(Vec::new()),
        drafts: Mutex::new(Vec::new()),
        fail_send: AtomicBool::new(false),
        dead_chat: Mutex::new(None),
        cleared: Mutex::new(Vec::new()),
    });
    (f, tx)
}

fn start(permits: usize) -> H {
    let store = Arc::new(Store::open_in_memory().unwrap());
    let (tg, tg_in) = fake("telegram");
    let (dev, dev_in) = fake("device");
    let brain = Arc::new(Brain1 {
        turns: Mutex::new(Vec::new()),
        gate: Arc::new(Semaphore::new(permits)),
    });
    let bus = Bus::new(256);
    let channels = ChannelSet::new();
    channels.add(tg.clone());
    channels.add(dev.clone());
    let gw = Gateway::with_channels(
        GatewayConfig {
            merge_ms: 20,
            ..GatewayConfig::default()
        },
        store.clone(),
        bus.clone(),
        brain.clone(),
        Arc::new(NoMedia),
        channels,
    );
    let at = Arc::new(Mutex::new(None));
    let seen = at.clone();
    gw.set_follow(Arc::new(move || seen.lock().unwrap().clone()));
    let cancel = CancellationToken::new();
    let run = tokio::spawn(gw.run(cancel.clone()));
    H {
        tg,
        dev,
        tg_in,
        dev_in,
        brain,
        store,
        bus,
        at,
        cancel,
        run,
    }
}

impl H {
    fn follow(&self, to: Option<Origin>) {
        *self.at.lock().unwrap() = to;
    }
    fn say(&self, text: &str, urgency: Urgency, to: Option<Origin>) {
        self.bus.publish(Event::Say {
            at: now_ms(),
            text: text.into(),
            urgency,
            job: None,
            notice: None,
            to,
        });
    }
    fn sessions(&self) -> Vec<SessionId> {
        self.brain
            .turns
            .lock()
            .unwrap()
            .iter()
            .map(|t| t.0)
            .collect()
    }
    fn turns(&self) -> usize {
        self.brain.turns.lock().unwrap().len()
    }
    async fn stop(self) {
        self.cancel.cancel();
        let r = tokio::time::timeout(Duration::from_secs(30), self.run).await;
        assert!(matches!(r, Ok(Ok(Ok(())))), "the gateway did not stop");
    }
}

fn device(id: &str) -> Origin {
    Origin::Channel {
        channel: "device".into(),
        chat: id.into(),
    }
}

fn inbound(chat: &str, id: &str, text: &str, at: i64) -> Inbound {
    Inbound {
        chat: ChatRef { chat: chat.into() },
        msg: MsgRef { id: id.into() },
        kind: InKind::Message,
        from_owner: true,
        content: Content::Text(text.into()),
        files: vec![],
        at,
        button: None,
        reply_to: None,
    }
}

async fn until(what: &str, f: impl Fn() -> bool) {
    let end = Instant::now() + Duration::from_secs(30);
    while !f() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        sleep(Duration::from_millis(5)).await;
    }
}

/// Sends one message and waits for the brain's answer to it on that face.
async fn exchange(h: &H, face: &str, chat: &str, text: &str, at: i64) {
    let (tx, fake) = match face {
        "telegram" => (&h.tg_in, &h.tg),
        _ => (&h.dev_in, &h.dev),
    };
    tx.send(vec![inbound(chat, text, text, at)]).unwrap();
    let want = (chat.to_string(), format!("re:{text}"));
    until(&want.1, || fake.sent().contains(&want)).await;
}

/// Telegram has a primary chat "42" and the device channel one "dev1".
fn seen_chats(h: &H) {
    h.store.channel_session("telegram", "42").unwrap();
    h.store.channel_session("device", "dev1").unwrap();
}

// ---- HB-06: where a notice goes ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn say_goes_to_followed_face_only() {
    let h = start(100);
    seen_chats(&h);
    h.follow(Some(device("dev1")));
    h.say("first", Urgency::Normal, None);
    until("the device message", || !h.dev.sent().is_empty()).await;
    // A second say with nobody followed reaches Telegram: by then the first has been handled.
    h.follow(None);
    h.say("second", Urgency::Normal, None);
    until("the telegram message", || !h.tg.sent().is_empty()).await;
    assert_eq!(
        h.tg.texts(),
        vec!["second"],
        "the first must not reach Telegram"
    );
    assert_eq!(h.dev.sent()[0], ("dev1".to_string(), "first".to_string()));
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn follow_none_is_today() {
    let h = start(100);
    seen_chats(&h);
    h.follow(None);
    h.say("hello", Urgency::Normal, None);
    until("both primary chats", || {
        !h.tg.sent().is_empty() && !h.dev.sent().is_empty()
    })
    .await;
    assert_eq!(h.tg.sent(), vec![("42".to_string(), "hello".to_string())]);
    assert_eq!(
        h.dev.sent(),
        vec![("dev1".to_string(), "hello".to_string())]
    );
    // A channel that is not configured is no face either: also as before.
    h.follow(Some(Origin::Channel {
        channel: "nowhere".into(),
        chat: "x".into(),
    }));
    h.say("again", Urgency::Normal, None);
    until("both again", || {
        h.tg.sent().len() == 2 && h.dev.sent().len() == 2
    })
    .await;
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failed_follow_send_falls_back() {
    let h = start(100);
    seen_chats(&h);
    h.dev.fail_send.store(true, Ordering::SeqCst);
    h.follow(Some(device("dev1")));
    h.say("careful", Urgency::Normal, None);
    until("the fallback to Telegram", || !h.tg.sent().is_empty()).await;
    assert_eq!(h.tg.texts(), vec!["careful"]);
    assert!(h.dev.sent().is_empty());
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn urgent_goes_to_both() {
    let h = start(100);
    seen_chats(&h);
    h.follow(Some(device("dev1")));
    h.say("fire", Urgency::Urgent, None);
    until("both faces", || {
        !h.tg.sent().is_empty() && !h.dev.sent().is_empty()
    })
    .await;
    assert_eq!(h.tg.texts(), vec!["‼️ fire"]);
    assert_eq!(h.dev.texts(), vec!["‼️ fire"]);
    // `to: Some(..)` stays as it was: only that chat.
    h.say("named", Urgency::Normal, Some(device("dev9")));
    until("the named chat", || h.dev.sent().len() == 2).await;
    assert_eq!(h.dev.sent()[1], ("dev9".to_string(), "named".to_string()));
    assert_eq!(h.tg.sent().len(), 1);
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failed_urgent_follow_send_falls_back() {
    let h = start(100);
    seen_chats(&h);
    // The followed device is gone; the device channel's primary chat is not.
    *h.dev.dead_chat.lock().unwrap() = Some("dev9".into());
    h.follow(Some(device("dev9")));
    h.say("fire", Urgency::Urgent, None);
    h.follow(None);
    until("the fallback to the primary device", || {
        !h.dev.sent().is_empty()
    })
    .await;
    assert_eq!(
        h.dev.sent(),
        vec![("dev1".to_string(), "‼️ fire".to_string())]
    );
    // A later say marks the end of the first one's handling.
    h.say("after", Urgency::Normal, None);
    until("the later say", || h.tg.texts().len() >= 2).await;
    assert_eq!(h.tg.texts(), vec!["‼️ fire", "after"], "Telegram once");
    h.stop().await;
}

// ---- HB-04: the conversation follows ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn handoff_within_30_min_same_session() {
    let h = start(100);
    h.tg_in
        .send(vec![inbound("42", "1", "from phone", 0)])
        .unwrap();
    until("the first reply", || {
        h.tg.texts().contains(&"re:from phone".to_string())
    })
    .await;
    h.dev_in
        .send(vec![inbound("dev1", "2", "from mac", 0)])
        .unwrap();
    until("the second reply", || {
        h.dev.texts().contains(&"re:from mac".to_string())
    })
    .await;
    let s = h.sessions();
    assert_eq!(s.len(), 2);
    assert_eq!(s[0], s[1], "the second face joined the same session");
    // The reply went to the face the owner is on, not the old one.
    assert!(!h.tg.texts().contains(&"re:from mac".to_string()));
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn after_30_min_new_session() {
    let h = start(100);
    let long_ago = now_ms() - HANDOFF_MS - 10 * 60 * 1000;
    h.tg_in
        .send(vec![inbound("42", "1", "old", long_ago)])
        .unwrap();
    until("the first reply", || {
        h.tg.texts().contains(&"re:old".to_string())
    })
    .await;
    h.dev_in
        .send(vec![inbound("dev1", "2", "new", now_ms())])
        .unwrap();
    until("the second reply", || {
        h.dev.texts().contains(&"re:new".to_string())
    })
    .await;
    let s = h.sessions();
    assert_ne!(s[0], s[1], "30 minutes apart is a new conversation");
    assert_eq!(h.store.channel_session("device", "dev1").unwrap(), s[1]);
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn inflight_reply_goes_to_new_face_with_note() {
    // No permits: the first turn shows a draft, then waits.
    let h = start(0);
    h.tg_in.send(vec![inbound("42", "1", "long", 0)]).unwrap();
    until("the draft on Telegram", || {
        !h.tg.drafts.lock().unwrap().is_empty()
    })
    .await;
    sleep(Duration::from_millis(500)).await;
    h.dev_in
        .send(vec![inbound("dev1", "2", "again", 0)])
        .unwrap();
    until("the handoff note", || !h.tg.sent().is_empty()).await;
    assert_eq!(h.tg.texts(), vec!["Continued on dev1."]);
    until("the old draft cleared", || {
        !h.tg.cleared.lock().unwrap().is_empty()
    })
    .await;
    // Let both turns run: the one in flight, then the one the owner added on the new face.
    h.brain.gate.add_permits(2);
    until("both replies on the device", || {
        let t = h.dev.texts();
        t.contains(&"re:long".to_string()) && t.contains(&"re:again".to_string())
    })
    .await;
    assert_eq!(
        h.tg.texts(),
        vec!["Continued on dev1."],
        "nothing else on the old face"
    );
    let s = h.sessions();
    assert_eq!(s.len(), 2);
    assert_eq!(s[0], s[1]);
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn new_command_still_fresh() {
    let h = start(100);
    h.tg_in.send(vec![inbound("42", "1", "hi", 0)]).unwrap();
    until("the first reply", || {
        h.tg.texts().contains(&"re:hi".to_string())
    })
    .await;
    h.dev_in
        .send(vec![inbound("dev1", "2", "/new", 0)])
        .unwrap();
    until("the /new answer", || {
        h.dev.texts().contains(&"New conversation.".to_string())
    })
    .await;
    h.dev_in
        .send(vec![inbound("dev1", "3", "fresh", 0)])
        .unwrap();
    until("the fresh reply", || {
        h.dev.texts().contains(&"re:fresh".to_string())
    })
    .await;
    let s = h.sessions();
    assert_eq!(s.len(), 2);
    assert_ne!(s[0], s[1], "/new starts a fresh session on any face");
    assert_eq!(h.store.channel_session("device", "dev1").unwrap(), s[1]);
    assert_eq!(h.turns(), 2, "/new is not a turn for the brain");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn same_face_keeps_the_conversation_after_a_gap() {
    let h = start(100);
    let t0 = now_ms() - 4 * HANDOFF_MS;
    exchange(&h, "telegram", "42", "start", t0).await;
    exchange(&h, "device", "dev1", "moved", t0 + 1_000).await;
    // Hours later on the same face: still the conversation that was here.
    exchange(&h, "device", "dev1", "later", t0 + 3 * HANDOFF_MS).await;
    let s = h.sessions();
    assert_eq!(s, vec![s[0]; 3]);
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_face_left_long_ago_returns_to_its_own_session() {
    let h = start(100);
    let t0 = now_ms() - 6 * HANDOFF_MS;
    exchange(&h, "device", "dev1", "mine", t0).await;
    // Over 30 min on, Telegram starts its own; the device then joins it.
    exchange(&h, "telegram", "42", "theirs", t0 + 2 * HANDOFF_MS).await;
    exchange(&h, "device", "dev1", "joined", t0 + 2 * HANDOFF_MS + 1_000).await;
    // Telegram again, much later; then the device, much later than that.
    exchange(&h, "telegram", "42", "phone", t0 + 4 * HANDOFF_MS).await;
    exchange(&h, "device", "dev1", "back", t0 + 6 * HANDOFF_MS).await;
    let s = h.sessions();
    assert_ne!(s[0], s[1]);
    assert_eq!(s[1], s[2], "within 30 min the device joined Telegram");
    assert_eq!(s[3], s[1], "Telegram's own session");
    assert_eq!(s[4], s[0], "the device's own session again");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn another_chat_of_the_same_channel_does_not_join() {
    let h = start(100);
    exchange(&h, "telegram", "42", "here", 0).await;
    exchange(&h, "telegram", "7", "there", 0).await;
    exchange(&h, "telegram", "42", "here again", 0).await;
    let s = h.sessions();
    assert_ne!(s[0], s[1], "one channel is one face; its chats stay apart");
    assert_eq!(s[0], s[2]);
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn displaced_turn_still_finishes() {
    let h = start(0);
    let mut events = h.bus.subscribe();
    let t0 = now_ms() - 4 * HANDOFF_MS;
    // A long turn on the device, still running when the owner has long since gone to Telegram.
    h.dev_in
        .send(vec![inbound("dev1", "1", "long", t0)])
        .unwrap();
    until("the device draft", || {
        !h.dev.drafts.lock().unwrap().is_empty()
    })
    .await;
    h.tg_in
        .send(vec![inbound("42", "2", "phone", t0 + 2 * HANDOFF_MS)])
        .unwrap();
    until("the Telegram draft", || {
        !h.tg.drafts.lock().unwrap().is_empty()
    })
    .await;
    sleep(Duration::from_millis(500)).await;
    // Back on the device within 30 min: the Telegram conversation moves over the old one.
    h.dev_in
        .send(vec![inbound(
            "dev1",
            "3",
            "home",
            t0 + 2 * HANDOFF_MS + 1_000,
        )])
        .unwrap();
    until("the handoff note", || !h.tg.sent().is_empty()).await;
    h.brain.gate.add_permits(3);
    until("all three replies on the device", || {
        let t = h.dev.texts();
        ["re:long", "re:phone", "re:home"]
            .iter()
            .all(|r| t.contains(&r.to_string()))
    })
    .await;
    // The displaced turn was not just sent: it was recorded and announced like any other.
    let mut delivered = Vec::new();
    let end = Instant::now() + Duration::from_secs(30);
    while delivered.len() < 3 {
        let ev = tokio::time::timeout_at(end, events.recv())
            .await
            .expect("three turns delivered")
            .expect("the bus is open");
        if let Event::Delivered { session, .. } = &*ev {
            delivered.push(*session);
        }
    }
    let s = h.sessions();
    assert_eq!(delivered.iter().filter(|d| **d == s[0]).count(), 1);
    assert_eq!(delivered.iter().filter(|d| **d == s[1]).count(), 2);
    assert_eq!(s[1], s[2]);
    h.stop().await;
}
