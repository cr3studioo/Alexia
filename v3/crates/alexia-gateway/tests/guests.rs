// SPDX-License-Identifier: AGPL-3.0-only
//! P4-33 (TR-11): guests on Telegram. The real Telegram channel against a fake Bot API (as
//! `tests/telegram_channel.rs` uses), alone or inside a running gateway with a fake brain and a
//! fake "device" channel. Real time; every wait is bounded (30 s).

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::{
    Brain, BrainError, Budget, Bus, DraftSink, Event, Lane, Origin, Reply, Turn, Urgency,
};
use alexia_gateway::channels::telegram::api::Api;
use alexia_gateway::channels::telegram::Telegram;
use alexia_gateway::{
    Channel, ChannelSet, ChatRef, Error, Gateway, GatewayConfig, InKind, Inbound, Media, MsgRef,
    Outbound, Result,
};
use alexia_store::{now_ms, Content, SessionId, Store};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::{sleep, Instant};
use tokio_util::sync::CancellationToken;

const WAIT: Duration = Duration::from_secs(30);
const OWNER: i64 = 7;
const GUEST: i64 = 9;
/// Built at runtime, so no code-shaped secret sits in the source as one literal.
fn code() -> String {
    format!("{}{}", "4829", "13")
}

fn token() -> String {
    format!("{}:{}", "123456", "fake-test-secret-value")
}

fn sha(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// ---- fake Bot API ----

#[derive(Clone, Debug)]
struct Seen {
    path: String,
    body: Vec<u8>,
}

impl Seen {
    fn method(&self) -> &str {
        self.path.rsplit('/').next().unwrap_or("")
    }
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

/// `getUpdates` answers the next queued batch, or an empty one after 100 ms. Everything else
/// answers success.
#[derive(Clone)]
struct Bot {
    base: String,
    log: Arc<Mutex<Vec<Seen>>>,
    updates: Arc<Mutex<VecDeque<Value>>>,
    next_id: Arc<AtomicUsize>,
}

impl Bot {
    async fn start() -> Bot {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let bot = Bot {
            base: format!("http://{}", listener.local_addr().unwrap()),
            log: Arc::default(),
            updates: Arc::default(),
            next_id: Arc::new(AtomicUsize::new(100)),
        };
        let b = bot.clone();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                tokio::spawn(b.clone().serve(sock));
            }
        });
        bot
    }

    async fn serve(self, mut sock: tokio::net::TcpStream) {
        let mut buf = Vec::new();
        let mut byte = [0u8; 8192];
        let header_end = loop {
            let n = sock.read(&mut byte).await.unwrap_or(0);
            if n == 0 {
                return;
            }
            buf.extend_from_slice(&byte[..n]);
            if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break at + 4;
            }
        };
        let headers = String::from_utf8_lossy(&buf[..header_end]).to_lowercase();
        let length: usize = headers
            .lines()
            .find_map(|l| l.strip_prefix("content-length:"))
            .map_or(0, |v| v.trim().parse().unwrap());
        while buf.len() < header_end + length {
            let n = sock.read(&mut byte).await.unwrap_or(0);
            if n == 0 {
                return;
            }
            buf.extend_from_slice(&byte[..n]);
        }
        let seen = Seen {
            path: headers.split(' ').nth(1).unwrap_or("").to_owned(),
            body: buf[header_end..].to_vec(),
        };
        let value = match seen.method() {
            "getupdates" => {
                let next = self.updates.lock().unwrap().pop_front();
                self.log.lock().unwrap().push(seen);
                match next {
                    Some(batch) => ok(batch),
                    None => {
                        sleep(Duration::from_millis(100)).await;
                        ok(json!([]))
                    }
                }
            }
            "sendmessage" => {
                self.log.lock().unwrap().push(seen);
                ok(json!({"message_id": 77, "date": 1, "chat": {"id": 5, "type": "private"}}))
            }
            _ => {
                self.log.lock().unwrap().push(seen);
                ok(json!(true))
            }
        };
        let body = value.to_string().into_bytes();
        let head = format!(
            "HTTP/1.1 200 X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        );
        let _ = sock.write_all(head.as_bytes()).await;
        let _ = sock.write_all(&body).await;
        let _ = sock.flush().await;
    }

    /// Queues one private-chat text message from `user`.
    fn text(&self, user: i64, text: &str) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) as i64;
        let m = json!({
            "update_id": id,
            "message": {
                "message_id": id * 10,
                "date": 1_700_000_000,
                "chat": {"id": user, "type": "private"},
                "from": {"id": user, "is_bot": false, "first_name": "U"},
                "text": text,
            }
        });
        self.updates.lock().unwrap().push_back(json!([m]));
    }

    fn seen(&self, method: &str) -> Vec<Seen> {
        let log = self.log.lock().unwrap();
        log.iter()
            .filter(|s| s.method() == method.to_lowercase())
            .cloned()
            .collect()
    }

    /// (chat, text) of every `sendMessage`.
    fn sent(&self) -> Vec<(i64, String)> {
        self.seen("sendMessage")
            .iter()
            .map(|s| {
                let j = s.json();
                (
                    j["chat_id"].as_i64().unwrap(),
                    j["text"].as_str().unwrap_or("").to_owned(),
                )
            })
            .collect()
    }

    fn sent_to(&self, chat: i64) -> Vec<String> {
        self.sent()
            .into_iter()
            .filter(|(c, _)| *c == chat)
            .map(|(_, t)| t)
            .collect()
    }

    /// Waits until every queued batch was taken and one more poll came after it, so the last
    /// batch has been handled.
    async fn drained(&self) {
        let start = self.seen("getUpdates").len();
        let queued = self.updates.lock().unwrap().len();
        until("the queued updates", || {
            self.updates.lock().unwrap().is_empty()
                && self.seen("getUpdates").len() > start + queued
        })
        .await;
    }

    fn channel(&self, store: &Arc<Store>) -> Arc<Telegram> {
        Arc::new(Telegram::new(
            Api::new(&self.base, token()),
            store.clone(),
            cache(),
        ))
    }
}

fn ok(result: Value) -> Value {
    json!({"ok": true, "result": result})
}

fn cache() -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("alexia-p4-33-{}-{n}", std::process::id()))
}

/// Paired to OWNER, whose chat is the primary, with one guest "Jana" holding `code()`.
fn paired_store() -> (Arc<Store>, i64) {
    let store = Store::open_in_memory().unwrap();
    store
        .kv_set("_core", "telegram_owners", &json!([OWNER]))
        .unwrap();
    store
        .channel_session("telegram", &OWNER.to_string())
        .unwrap();
    store
        .set_primary_chat("telegram", &OWNER.to_string())
        .unwrap();
    let id = store
        .guest_add("Jana", "telegram", &sha(&code()), now_ms())
        .unwrap();
    (Arc::new(store), id)
}

async fn until(what: &str, f: impl Fn() -> bool) {
    let end = Instant::now() + WAIT;
    while !f() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        sleep(Duration::from_millis(10)).await;
    }
}

/// Runs the channel's `next()` until the bot has handled every queued update; what it returned.
async fn take(bot: &Bot, ch: &Telegram) -> Vec<Inbound> {
    let cancel = CancellationToken::new();
    let mut got = Vec::new();
    let end = Instant::now() + WAIT;
    loop {
        let run = ch.next(cancel.clone());
        tokio::pin!(run);
        tokio::select! {
            r = &mut run => got.extend(r.expect("next() failed")),
            () = bot.drained() => {
                cancel.cancel();
                if let Ok(Ok(more)) = tokio::time::timeout(WAIT, run).await {
                    got.extend(more);
                }
                return got;
            }
        }
        assert!(Instant::now() < end, "next() kept returning");
    }
}

fn welcome() -> String {
    "Hi Jana, I'm Alexia. My owner invited you. I can chat; I can't see anything of theirs.".into()
}

// ---- the channel alone ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn code_claims_guest() {
    let bot = Bot::start().await;
    let (store, _) = paired_store();
    let ch = bot.channel(&store);
    bot.text(GUEST, &format!("/start {}", code()));
    assert!(take(&bot, &ch).await.is_empty(), "a code is no turn");
    assert_eq!(bot.sent(), vec![(GUEST, welcome())]);
    let g = store.guest_of("telegram", &GUEST.to_string()).unwrap();
    assert_eq!(g.map(|g| g.name), Some("Jana".to_string()));
    // From now on the chat is heard, as a guest.
    bot.text(GUEST, "hello");
    let got = take(&bot, &ch).await;
    assert_eq!(got.len(), 1);
    assert!(!got[0].from_owner, "a guest is never the owner");
    assert_eq!(got[0].chat.chat, GUEST.to_string());
    assert_eq!(got[0].content, Content::Text("hello".into()));
    // The code is spent: a second chat sending it learns nothing.
    bot.text(11, &code());
    assert!(take(&bot, &ch).await.is_empty());
    assert!(bot.sent_to(11).is_empty());
    // The bare code works too, for a second guest.
    store
        .guest_add("Petr", "telegram", &sha("777000"), now_ms())
        .unwrap();
    bot.text(12, " 777000 ");
    assert!(take(&bot, &ch).await.is_empty());
    assert_eq!(bot.sent_to(12).len(), 1);
    assert!(bot.sent_to(12)[0].starts_with("Hi Petr,"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wrong_code_silent() {
    let bot = Bot::start().await;
    let (store, _) = paired_store();
    let ch = bot.channel(&store);
    bot.text(GUEST, "/start 000000");
    bot.text(GUEST, "123456");
    assert!(take(&bot, &ch).await.is_empty());
    assert!(bot.sent().is_empty(), "an unknown chat learns nothing");
    assert!(bot.seen("setMessageReaction").is_empty());
    assert_eq!(
        store.guest_of("telegram", &GUEST.to_string()).unwrap(),
        None
    );
    // The right code still works afterwards: wrong guesses did not spend it.
    bot.text(GUEST, &code());
    take(&bot, &ch).await;
    assert_eq!(bot.sent(), vec![(GUEST, welcome())]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rate_limited_tries() {
    let bot = Bot::start().await;
    let (store, _) = paired_store();
    let ch = bot.channel(&store);
    for i in 0..5 {
        bot.text(GUEST, &format!("99999{i}"));
    }
    // The sixth try this hour is not even looked at, though it is the right code.
    bot.text(GUEST, &code());
    assert!(take(&bot, &ch).await.is_empty());
    assert!(bot.sent().is_empty());
    assert_eq!(
        store.guest_of("telegram", &GUEST.to_string()).unwrap(),
        None
    );
    // The limit is per chat: another chat can still use it.
    bot.text(13, &code());
    take(&bot, &ch).await;
    assert_eq!(bot.sent(), vec![(13, welcome())]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn removed_guest_ignored() {
    let bot = Bot::start().await;
    let (store, id) = paired_store();
    let ch = bot.channel(&store);
    bot.text(GUEST, &code());
    take(&bot, &ch).await;
    bot.text(GUEST, "first");
    assert_eq!(take(&bot, &ch).await.len(), 1);
    assert!(store.guest_remove(id, now_ms()).unwrap());
    let before = bot.sent().len();
    bot.text(GUEST, "second");
    bot.text(GUEST, &code());
    assert!(take(&bot, &ch).await.is_empty(), "removed is nobody");
    assert_eq!(bot.sent().len(), before, "and hears nothing");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stranger_still_ignored() {
    let bot = Bot::start().await;
    let (store, _) = paired_store();
    let ch = bot.channel(&store);
    bot.text(21, "hello");
    bot.text(21, "/start");
    bot.text(21, "/help");
    assert!(take(&bot, &ch).await.is_empty());
    assert!(bot.sent().is_empty());
    assert!(bot.seen("setMessageReaction").is_empty());
}

/// P4-31 review: a store error is never owner rights, nor a guest.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn store_error_is_nobody() {
    let bot = Bot::start().await;
    let (store, _) = paired_store();
    let ch = bot.channel(&store);
    bot.text(GUEST, &code());
    take(&bot, &ch).await;
    store
        .transaction(|tx| {
            tx.execute_batch("DROP TABLE guests")?;
            Ok(())
        })
        .unwrap();
    assert!(store.guest_of("telegram", &GUEST.to_string()).is_err());
    let before = bot.sent().len();
    bot.text(GUEST, "hello");
    bot.text(22, &code());
    assert!(take(&bot, &ch).await.is_empty());
    assert_eq!(bot.sent().len(), before);
    // The owner is still the owner.
    bot.text(OWNER, "still me");
    let got = take(&bot, &ch).await;
    assert_eq!(got.len(), 1);
    assert!(got[0].from_owner);
}

// ---- inside a gateway ----

/// Answers "re:<text>" and remembers (session, origin, text) of every turn.
#[derive(Default)]
struct Echo {
    turns: Mutex<Vec<(SessionId, Origin, String)>>,
}

impl Echo {
    fn turns(&self) -> Vec<(SessionId, Origin, String)> {
        self.turns.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl Brain for Echo {
    async fn reply(
        &self,
        turn: Turn,
        _: DraftSink,
        _: CancellationToken,
    ) -> std::result::Result<Reply, BrainError> {
        let text = match &turn.content {
            Content::Text(t) => t.clone(),
            Content::Parts(_) => "<parts>".into(),
        };
        self.turns
            .lock()
            .unwrap()
            .push((turn.session, turn.origin.clone(), text.clone()));
        Ok(Reply {
            text: format!("re:{text}"),
            files: vec![],
            lane: Lane::Chat,
            model: None,
            spans: vec![],
        })
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

/// The owner's "device" face: fed by a channel, records what is sent.
struct Device {
    inbox: tokio::sync::Mutex<mpsc::UnboundedReceiver<Vec<Inbound>>>,
    sent: Mutex<Vec<(String, String)>>,
}

#[async_trait::async_trait]
impl Channel for Device {
    fn name(&self) -> &'static str {
        "device"
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
        self.sent
            .lock()
            .unwrap()
            .push((chat.chat.clone(), out.text.clone()));
        Ok(MsgRef { id: "m".into() })
    }
    async fn draft(&self, _: &ChatRef, _: Option<&str>) -> Result<()> {
        Ok(())
    }
    async fn edit(&self, _: &ChatRef, _: &MsgRef, _: &str) -> Result<()> {
        Ok(())
    }
    async fn ask(&self, _: &ChatRef, _: &str, _: CancellationToken) -> Result<Option<bool>> {
        Ok(None)
    }
}

struct H {
    bot: Bot,
    store: Arc<Store>,
    brain: Arc<Echo>,
    bus: Bus,
    dev: Arc<Device>,
    dev_in: mpsc::UnboundedSender<Vec<Inbound>>,
    follow: Arc<Mutex<Option<Origin>>>,
    events: tokio::sync::broadcast::Receiver<Arc<Event>>,
    gw: Gateway,
    cancel: CancellationToken,
    run: tokio::task::JoinHandle<Result<()>>,
}

/// A running gateway on the real Telegram channel, with GUEST already claimed.
async fn gateway() -> H {
    let bot = Bot::start().await;
    let (store, _) = paired_store();
    store
        .guest_claim("telegram", &sha(&code()), &GUEST.to_string())
        .unwrap()
        .unwrap();
    store.channel_session("device", "dev1").unwrap();
    let (dev_in, rx) = mpsc::unbounded_channel();
    let dev = Arc::new(Device {
        inbox: tokio::sync::Mutex::new(rx),
        sent: Mutex::default(),
    });
    let brain = Arc::new(Echo::default());
    let bus = Bus::new(256);
    let events = bus.subscribe();
    let channels = ChannelSet::new();
    channels.add(bot.channel(&store));
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
    let follow = Arc::new(Mutex::new(None));
    let seen = follow.clone();
    gw.set_follow(Arc::new(move || seen.lock().unwrap().clone()));
    let cancel = CancellationToken::new();
    let run = tokio::spawn(gw.clone().run(cancel.clone()));
    H {
        bot,
        store,
        brain,
        bus,
        dev,
        dev_in,
        follow,
        events,
        gw,
        cancel,
        run,
    }
}

fn telegram(chat: i64) -> Origin {
    Origin::Channel {
        channel: "telegram".into(),
        chat: chat.to_string(),
    }
}

fn device(id: &str) -> Origin {
    Origin::Channel {
        channel: "device".into(),
        chat: id.into(),
    }
}

impl H {
    /// A Telegram message, and the wait for its reply in that chat.
    async fn tg(&self, from: i64, text: &str) {
        self.bot.text(from, text);
        let want = format!("re:{text}");
        until(&want, || self.bot.sent_to(from).contains(&want)).await;
    }

    async fn dev(&self, text: &str) {
        self.dev_in
            .send(vec![Inbound {
                chat: ChatRef {
                    chat: "dev1".into(),
                },
                msg: MsgRef { id: text.into() },
                kind: InKind::Message,
                from_owner: true,
                content: Content::Text(text.into()),
                files: vec![],
                at: now_ms(),
                button: None,
                reply_to: None,
            }])
            .unwrap();
        let want = ("dev1".to_string(), format!("re:{text}"));
        until(&want.1, || self.dev.sent.lock().unwrap().contains(&want)).await;
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

    /// Every `Active` the bus carried so far.
    fn actives(&mut self) -> usize {
        let mut n = 0;
        while let Ok(ev) = self.events.try_recv() {
            if matches!(&*ev, Event::Active { .. }) {
                n += 1;
            }
        }
        n
    }

    async fn stop(self) {
        self.cancel.cancel();
        let r = tokio::time::timeout(WAIT, self.run).await;
        assert!(matches!(r, Ok(Ok(Ok(())))), "the gateway did not stop");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn guest_gets_own_session() {
    let mut h = gateway().await;
    h.tg(OWNER, "owner here").await;
    let owner = h.gw.current_session(30 * 60 * 1000).expect("the owner's");
    assert_eq!(h.actives(), 1);
    h.tg(GUEST, "guest here").await;
    h.tg(GUEST, "again").await;
    let turns = h.brain.turns();
    assert_eq!(turns.len(), 3);
    let guest = h
        .store
        .channel_session("telegram", &GUEST.to_string())
        .unwrap();
    assert_eq!(turns[1].0, guest);
    assert_eq!(turns[2].0, guest, "the guest keeps their session");
    assert_ne!(guest, owner.0, "never the owner's");
    assert_eq!(turns[1].1, telegram(GUEST));
    // A guest moves nothing of the owner's: not the current conversation, not Active.
    assert_eq!(h.gw.current_session(30 * 60 * 1000), Some(owner));
    assert_eq!(h.actives(), 0, "a guest is no sign the owner is up");
    assert!(
        h.bot.sent_to(OWNER).iter().all(|t| !t.contains("guest")),
        "nothing of the guest's reaches the owner"
    );
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn say_never_to_guest() {
    let h = gateway().await;
    h.tg(GUEST, "hi").await;
    // Named, followed, urgent: none of them reach the guest.
    h.say("named", Urgency::Normal, Some(telegram(GUEST)));
    *h.follow.lock().unwrap() = Some(telegram(GUEST));
    h.say("followed", Urgency::Normal, None);
    h.say("fire", Urgency::Urgent, None);
    h.say("last", Urgency::Normal, None);
    // Says are handled in order: the last one at the owner's means all were handled.
    until("the last say", || {
        h.bot.sent_to(OWNER).contains(&"last".to_string())
    })
    .await;
    assert_eq!(h.bot.sent_to(GUEST), vec!["re:hi".to_string()]);
    // What could not go to the guest went where it goes without them: the owner's primary.
    assert_eq!(
        h.bot.sent_to(OWNER),
        vec!["followed".to_string(), "‼️ fire".into(), "last".into()]
    );
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_handoff_for_guest() {
    let h = gateway().await;
    h.dev("on the mac").await;
    let owner = h.gw.current_session(30 * 60 * 1000).expect("the owner's");
    assert_eq!(owner.1, device("dev1"));
    // Within the handoff window, on another face: a guest's message must not take it.
    h.tg(GUEST, "guest").await;
    assert_eq!(h.gw.current_session(30 * 60 * 1000), Some(owner.clone()));
    h.dev("still on the mac").await;
    let turns = h.brain.turns();
    assert_eq!(turns.len(), 3);
    assert_eq!(turns[0].0, owner.0);
    assert_eq!(
        turns[2].0, owner.0,
        "the owner's conversation is where it was"
    );
    assert_ne!(turns[1].0, owner.0);
    assert_eq!(turns[2].1, device("dev1"));
    // Nobody was told "Continued on …".
    assert!(h
        .bot
        .sent()
        .iter()
        .all(|(_, t)| !t.starts_with("Continued")));
    assert!(h
        .dev
        .sent
        .lock()
        .unwrap()
        .iter()
        .all(|(_, t)| !t.starts_with("Continued")));
    // `moved_to` with the owner's session never lands in the guest's chat either.
    h.gw.moved_to(owner.0, device("dev1"));
    h.tg(GUEST, "after").await;
    assert_eq!(h.brain.turns()[3].0, turns[1].0);
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn owner_unaffected() {
    let bot = Bot::start().await;
    let (store, _) = paired_store();
    let ch = bot.channel(&store);
    // The owner sending something code-shaped is just a message, never a claim.
    bot.text(OWNER, &code());
    let got = take(&bot, &ch).await;
    assert_eq!(got.len(), 1);
    assert!(got[0].from_owner);
    assert!(bot.sent().is_empty());
    assert_eq!(
        store.guest_of("telegram", &OWNER.to_string()).unwrap(),
        None
    );
    drop(ch);
    // And in a gateway, with a guest talking too, the owner is answered as before.
    let h = gateway().await;
    h.tg(GUEST, "guest").await;
    h.tg(OWNER, "owner").await;
    let turns = h.brain.turns();
    assert_eq!(turns[1].1, telegram(OWNER));
    assert_eq!(
        Some(turns[1].0),
        h.gw.current_session(30 * 60 * 1000).map(|c| c.0)
    );
    assert_eq!(h.bot.sent_to(OWNER), vec!["re:owner".to_string()]);
    h.stop().await;
}
