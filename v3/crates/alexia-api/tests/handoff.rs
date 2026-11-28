// SPDX-License-Identifier: AGPL-3.0-only
//! P4-41: the window joins the handoff (HB-04). `Api::serve` on `127.0.0.1:0` beside a running
//! `Gateway`, as the hub wires them: one store, one bus, one brain, a fake "telegram" channel and
//! the real `WindowChannel`. Requests are written by hand over TCP, as in `tests/chat.rs`.
//! Real time; every wait is bounded by `WAIT`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alexia_api::{Api, ApiParts, WindowChannel};
use alexia_core::agent::{Agent, AgentParts};
use alexia_core::catalog::Catalog;
use alexia_core::checker::Checker;
use alexia_core::local::{LocalJobs, Runtime};
use alexia_core::prompt::Skills;
use alexia_core::router::Router;
use alexia_core::tools::McpTooling;
use alexia_core::{
    Brain, BrainError, Budget, Bus, DraftFrame, DraftSink, Event, Lane, Limits, Origin, Reply,
    Turn, Urgency,
};
use alexia_gateway::{
    Asker, Channel, ChannelSet, ChatRef, Error, Gateway, GatewayConfig, InFile, InKind, Inbound,
    Media, MsgRef, Outbound, WindowQuestions,
};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, Timings};
use alexia_scheduler::Scheduler;
use alexia_store::{now_ms, Content, Layout, MessageBody, Role, SessionId, Store};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Semaphore};
use tokio_util::sync::CancellationToken;

/// Generous: a loaded Windows machine is slow.
const WAIT: Duration = Duration::from_secs(60);
const HANDOFF_MS: i64 = 30 * 60 * 1000;
const MINUTE: i64 = 60 * 1000;

async fn until(what: &str, f: impl Fn() -> bool) {
    let began = Instant::now();
    while !f() {
        assert!(began.elapsed() < WAIT, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

// ---- the brain ----

/// Answers "re:<text>" and records both sides in the turn's session, as the agent does. A text
/// starting "hold" is answered only once the test releases it.
struct Echo {
    store: Arc<Store>,
    turns: Mutex<Vec<(SessionId, Origin, String)>>,
    gates: Mutex<HashMap<String, Arc<Semaphore>>>,
}

impl Echo {
    fn gate(&self, text: &str) -> Arc<Semaphore> {
        let mut gates = self.gates.lock().unwrap();
        gates
            .entry(text.to_owned())
            .or_insert_with(|| Arc::new(Semaphore::new(0)))
            .clone()
    }
    fn release(&self, text: &str) {
        self.gate(text).add_permits(1);
    }
    fn turn(&self, text: &str) -> Option<(SessionId, Origin)> {
        let turns = self.turns.lock().unwrap();
        let found = turns.iter().find(|t| t.2 == text);
        found.map(|t| (t.0, t.1.clone()))
    }
}

fn body(text: &str) -> MessageBody {
    serde_json::from_value(json!({ "content": text })).unwrap()
}

#[async_trait::async_trait]
impl Brain for Echo {
    async fn reply(
        &self,
        turn: Turn,
        draft: DraftSink,
        cancel: CancellationToken,
    ) -> Result<Reply, BrainError> {
        let said = turn.content.text();
        self.store
            .append(turn.session, Role::User, None, &body(&said))
            .unwrap();
        self.turns
            .lock()
            .unwrap()
            .push((turn.session, turn.origin.clone(), said.clone()));
        if said.starts_with("hold") {
            let gate = self.gate(&said);
            tokio::select! {
                _ = cancel.cancelled() => return Err(BrainError::Cancelled),
                p = gate.acquire() => p.expect("gate open").forget(),
            }
        }
        let answer = format!("re:{said}");
        let _ = draft.send(DraftFrame::Delta(answer.clone())).await;
        self.store
            .append(turn.session, Role::Assistant, Some("echo"), &body(&answer))
            .unwrap();
        Ok(Reply {
            text: answer,
            files: vec![],
            lane: Lane::Chat,
            model: Some("echo".into()),
            spans: vec![],
        })
    }
}

// ---- the phone ----

struct Phone {
    inbox: tokio::sync::Mutex<mpsc::UnboundedReceiver<Vec<Inbound>>>,
    sent: Mutex<Vec<String>>,
    /// The gateway has asked for messages: it is running.
    polled: AtomicBool,
}

impl Phone {
    fn sent(&self) -> Vec<String> {
        self.sent.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl Channel for Phone {
    fn name(&self) -> &'static str {
        "telegram"
    }
    fn budget(&self) -> Budget {
        Budget::CHAT
    }
    async fn next(&self, cancel: CancellationToken) -> alexia_gateway::Result<Vec<Inbound>> {
        self.polled.store(true, Ordering::SeqCst);
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
    async fn react(&self, _: &ChatRef, _: &MsgRef, _: &str) -> alexia_gateway::Result<()> {
        Ok(())
    }
    async fn typing(&self, _: &ChatRef) -> alexia_gateway::Result<()> {
        Ok(())
    }
    async fn send(&self, _: &ChatRef, out: &Outbound) -> alexia_gateway::Result<MsgRef> {
        self.sent.lock().unwrap().push(out.text.clone());
        Ok(MsgRef { id: "m".into() })
    }
    async fn draft(&self, _: &ChatRef, _: Option<&str>) -> alexia_gateway::Result<()> {
        Ok(())
    }
    async fn edit(&self, _: &ChatRef, _: &MsgRef, _: &str) -> alexia_gateway::Result<()> {
        Ok(())
    }
    async fn ask(
        &self,
        _: &ChatRef,
        _: &str,
        _: CancellationToken,
    ) -> alexia_gateway::Result<Option<bool>> {
        Ok(None)
    }
}

struct NoMedia;

#[async_trait::async_trait]
impl Media for NoMedia {
    async fn transcribe(
        &self,
        _: &InFile,
        _: CancellationToken,
    ) -> alexia_gateway::Result<Option<String>> {
        Ok(None)
    }
    async fn speak(
        &self,
        _: &str,
        _: CancellationToken,
    ) -> alexia_gateway::Result<Option<alexia_core::OutFile>> {
        Ok(None)
    }
}

// ---- the world ----

struct World {
    api: Arc<Api>,
    gateway: Gateway,
    brain: Arc<Echo>,
    phone: Arc<Phone>,
    inbox: mpsc::UnboundedSender<Vec<Inbound>>,
    store: Arc<Store>,
    bus: Bus,
    /// The window's own chat, open before anything happened.
    own: SessionId,
    port: u16,
    root: PathBuf,
    cancel: CancellationToken,
}

impl Drop for World {
    fn drop(&mut self) {
        self.cancel.cancel();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn scratch(name: &str) -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir =
        std::env::temp_dir().join(format!("alexia-handoff-{name}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Wired in the hub's order: the window channel and the gateway's clone before it runs, the api
/// after, then `join_handoff`.
async fn world(name: &str) -> World {
    let root = scratch(name);
    let data = root.join("data");
    let ext = root.join("ext");
    std::fs::create_dir_all(&ext).unwrap();
    let store = Arc::new(Store::open_in_memory().unwrap());
    let bus = Bus::new(256);
    let host = McpHost::new(
        HostConfig {
            layout: Layout::new(data.clone()),
            plugin_dirs: vec![ext],
            node: PathBuf::from("node"),
            timings: Timings::default(),
            dial: None,
        },
        store.clone(),
        Arc::new(NoUpcalls),
        Arc::new(|_| {}),
    );
    host.start(&[]).await.unwrap();
    let catalog = Arc::new(Catalog::new(vec![], vec![], root.join("catalog.json")));
    let router = Arc::new(Router::new(vec![], catalog.clone(), store.clone()));
    let channels = ChannelSet::new();
    let (inbox, rx) = mpsc::unbounded_channel();
    let phone = Arc::new(Phone {
        inbox: tokio::sync::Mutex::new(rx),
        sent: Mutex::new(Vec::new()),
        polled: AtomicBool::new(false),
    });
    channels.add(phone.clone());
    let asker = Asker::with_window(
        channels.clone(),
        store.clone(),
        bus.clone(),
        WindowQuestions::default(),
    );
    let tooling = Arc::new(McpTooling::new(host.clone(), vec![]));
    let agent = Agent::new(AgentParts {
        router: router.clone(),
        tools: tooling.clone(),
        store: store.clone(),
        bus: bus.clone(),
        ask: asker.clone(),
        checker: Arc::new(Checker::new(None)),
        caps: Arc::new(host.clone()),
        layout: Layout::new(data.clone()),
        limits: Limits::default(),
        host: host.clone(),
    });
    let brain = Arc::new(Echo {
        store: store.clone(),
        turns: Mutex::new(Vec::new()),
        gates: Mutex::new(HashMap::new()),
    });
    let gateway = Gateway::with_channels(
        GatewayConfig {
            merge_ms: 20,
            ..GatewayConfig::default()
        },
        store.clone(),
        bus.clone(),
        brain.clone(),
        Arc::new(NoMedia),
        channels.clone(),
    );
    let window = Arc::new(WindowChannel::new(&bus));
    channels.add(window.clone());
    let handoff = gateway.clone();
    let cancel = CancellationToken::new();
    tokio::spawn(gateway.run(cancel.clone()));
    let scheduler = Scheduler::new(store.clone(), bus.clone(), brain.clone());
    let (skills, _) = Skills::load(&[]);
    let runtime = Runtime::new(Layout::new(data.clone()), reqwest::Client::new());
    let jobs = LocalJobs::new(runtime.clone(), store.clone(), router.clone());
    let api = Api::new(ApiParts {
        layout: Layout::new(data),
        store: store.clone(),
        bus: bus.clone(),
        host,
        tooling,
        agent,
        brain: brain.clone(),
        router,
        catalog,
        scheduler,
        asker,
        channels,
        skills: Arc::new(skills),
        runtime,
        jobs,
        ui_dir: None,
        app_version: "3.0.0".into(),
    })
    .unwrap();
    api.join_handoff(handoff.clone(), &window);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(api.clone().serve(listener, cancel.clone()));
    until("the gateway to run", || phone.polled.load(Ordering::SeqCst)).await;
    World {
        own: api.session(),
        api,
        gateway: handoff,
        brain,
        phone,
        inbox,
        store,
        bus,
        port,
        root,
        cancel,
    }
}

impl World {
    /// A message from the phone, sent `at`.
    fn phone_says(&self, text: &str, at: i64) {
        self.inbox
            .send(vec![Inbound {
                chat: ChatRef { chat: "42".into() },
                msg: MsgRef { id: text.into() },
                kind: InKind::Message,
                from_owner: true,
                content: Content::Text(text.into()),
                files: vec![],
                at,
                button: None,
                reply_to: None,
            }])
            .unwrap();
    }

    /// A whole exchange on the phone; returns the session it was in.
    async fn phone_exchange(&self, text: &str, at: i64) -> SessionId {
        self.phone_says(text, at);
        let answer = format!("re:{text}");
        until(&answer, || self.phone.sent().contains(&answer)).await;
        self.brain.turn(text).expect("the brain had the turn").0
    }

    /// What the page reads to draw itself: the open chat's messages, as text.
    async fn page(&self) -> Vec<String> {
        let a = send(self, "GET", "/api/state", None).await;
        assert_eq!(a.status, 200);
        let state: Value = serde_json::from_slice(&a.body).expect("JSON");
        state["messages"]
            .as_array()
            .expect("messages")
            .iter()
            .map(|m| m["content"].as_str().expect("text").to_owned())
            .collect()
    }

    /// A message from the window, its stream read to the end.
    async fn window_says(&self, body: Value) -> Vec<Value> {
        let mut s = Sse::open(self, body).await;
        let frames = s.rest().await;
        assert!(
            frames.last().is_some_and(|f| f.get("done").is_some()),
            "{frames:?}"
        );
        // The stream can end a moment before the answer's hold is let go.
        until("the window to be free", || !self.api.busy()).await;
        frames
    }

    fn history(&self, session: SessionId) -> Vec<String> {
        self.store
            .history(session, None)
            .unwrap()
            .iter()
            .map(|m| m.body.content.text())
            .collect()
    }

    fn say(&self, text: &str, urgency: Urgency) {
        self.bus.publish(Event::Say {
            at: now_ms(),
            text: text.into(),
            urgency,
            job: None,
            notice: None,
            to: None,
        });
    }
}

/// So that what follows is later, to the millisecond, than what came before.
async fn a_moment() {
    tokio::time::sleep(Duration::from_millis(30)).await;
}

// ---- HTTP by hand ----

struct Answer {
    status: u16,
    body: Vec<u8>,
}

fn request(w: &World, method: &str, path: &str, body: Option<&Value>) -> String {
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nx-alexia-token: {}\r\n",
        w.port,
        w.api.token()
    );
    let body = body.map(Value::to_string).unwrap_or_default();
    if method != "GET" {
        req.push_str(&format!(
            "content-type: application/json\r\ncontent-length: {}\r\n",
            body.len()
        ));
    }
    req.push_str("\r\n");
    req.push_str(&body);
    req
}

/// Where the body starts and the status, once the head is complete.
fn head_of(raw: &[u8]) -> Option<(usize, u16, bool)> {
    let split = raw.windows(4).position(|x| x == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    let status = head.split(' ').nth(1)?.parse().ok()?;
    let chunked = head.contains("transfer-encoding: chunked");
    Some((split + 4, status, chunked))
}

/// Takes the complete chunks off the front of `raw` into `out`; true once the last one came.
fn dechunk(raw: &mut Vec<u8>, out: &mut Vec<u8>) -> bool {
    loop {
        let Some(end) = raw.windows(2).position(|x| x == b"\r\n") else {
            return false;
        };
        let size = usize::from_str_radix(std::str::from_utf8(&raw[..end]).unwrap().trim(), 16)
            .expect("a chunk size");
        if size == 0 {
            return true;
        }
        if raw.len() < end + 2 + size + 2 {
            return false;
        }
        out.extend_from_slice(&raw[end + 2..end + 2 + size]);
        raw.drain(..end + 4 + size);
    }
}

async fn send(w: &World, method: &str, path: &str, body: Option<&Value>) -> Answer {
    let mut s = TcpStream::connect(("127.0.0.1", w.port)).await.unwrap();
    s.write_all(request(w, method, path, body).as_bytes())
        .await
        .unwrap();
    let mut raw = Vec::new();
    tokio::time::timeout(WAIT, s.read_to_end(&mut raw))
        .await
        .expect("the server answered in time")
        .unwrap();
    let (at, status, chunked) = head_of(&raw).expect("a full head");
    let mut rest = raw[at..].to_vec();
    let body = if chunked {
        let mut out = Vec::new();
        dechunk(&mut rest, &mut out);
        out
    } else {
        rest
    };
    Answer { status, body }
}

/// `/api/chat`, read frame by frame as the server writes them.
struct Sse {
    sock: TcpStream,
    raw: Vec<u8>,
    text: Vec<u8>,
    ended: bool,
}

impl Sse {
    async fn open(w: &World, body: Value) -> Sse {
        let mut sock = TcpStream::connect(("127.0.0.1", w.port)).await.unwrap();
        sock.write_all(request(w, "POST", "/api/chat", Some(&body)).as_bytes())
            .await
            .unwrap();
        let mut raw = Vec::new();
        let (at, status) = loop {
            if let Some((at, status, _)) = head_of(&raw) {
                break (at, status);
            }
            let mut buf = [0u8; 4096];
            let n = tokio::time::timeout(WAIT, sock.read(&mut buf))
                .await
                .expect("a head in time")
                .unwrap();
            assert!(n > 0, "the server closed before answering");
            raw.extend_from_slice(&buf[..n]);
        };
        assert_eq!(status, 200);
        raw.drain(..at);
        Sse {
            sock,
            raw,
            text: Vec::new(),
            ended: false,
        }
    }

    /// The next frame, or None when the stream ended.
    async fn next(&mut self) -> Option<Value> {
        loop {
            if let Some(end) = self.text.windows(2).position(|x| x == b"\n\n") {
                let frame: Vec<u8> = self.text.drain(..end + 2).collect();
                let line = String::from_utf8(frame).unwrap();
                let data = line
                    .trim_end()
                    .strip_prefix("data: ")
                    .unwrap_or_else(|| panic!("not an SSE data frame: {line:?}"));
                return Some(serde_json::from_str(data).unwrap());
            }
            if self.ended {
                return None;
            }
            self.ended = dechunk(&mut self.raw, &mut self.text);
            if self.ended || self.text.windows(2).any(|x| x == b"\n\n") {
                continue;
            }
            let mut buf = [0u8; 4096];
            let n = tokio::time::timeout(WAIT, self.sock.read(&mut buf))
                .await
                .expect("a frame in time")
                .unwrap();
            if n == 0 {
                self.ended = true;
                continue;
            }
            self.raw.extend_from_slice(&buf[..n]);
        }
    }

    /// Every frame until the stream ends.
    async fn rest(&mut self) -> Vec<Value> {
        let mut all = Vec::new();
        while let Some(f) = self.next().await {
            all.push(f);
        }
        all
    }

    /// The text of the next `note` frame.
    async fn note(&mut self) -> String {
        while let Some(f) = self.next().await {
            if let Some(note) = f["note"].as_str() {
                return note.to_owned();
            }
        }
        panic!("the stream ended without a note");
    }
}

// ---- what the window opens ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn window_opens_telegram_session_within_30_min() {
    let w = world("opens").await;
    assert_eq!(w.page().await, Vec::<String>::new());
    let phone = w
        .phone_exchange("from the bus", now_ms() - 20 * MINUTE)
        .await;
    assert_ne!(phone, w.own);
    assert_eq!(w.page().await, ["from the bus", "re:from the bus"]);
    assert_eq!(w.api.session(), phone);
    // And it continues it.
    w.window_says(json!({ "text": "at the desk" })).await;
    assert_eq!(w.brain.turn("at the desk"), Some((phone, Origin::Window)));
    assert_eq!(
        w.page().await,
        [
            "from the bus",
            "re:from the bus",
            "at the desk",
            "re:at the desk"
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn older_session_not_taken() {
    let w = world("older").await;
    let phone = w
        .phone_exchange("long ago", now_ms() - HANDOFF_MS - MINUTE)
        .await;
    assert_ne!(phone, w.own);
    assert_eq!(w.page().await, Vec::<String>::new());
    assert_eq!(w.api.session(), w.own);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_chat_chosen_in_the_window_stays_until_the_owner_writes_elsewhere() {
    let w = world("chosen").await;
    let phone = w.phone_exchange("first", now_ms()).await;
    assert_eq!(w.page().await, ["first", "re:first"]);
    // The owner starts a new chat here: the phone's older turn does not take it back.
    a_moment().await;
    let a = send(
        &w,
        "POST",
        "/api/command",
        Some(&json!({ "input": "/new" })),
    )
    .await;
    assert_eq!(a.status, 200);
    let fresh = w.api.session();
    assert_ne!(fresh, phone);
    assert_eq!(w.page().await, Vec::<String>::new());
    assert_eq!(w.api.session(), fresh);
    // A new message on the phone is newer than that choice.
    a_moment().await;
    assert_eq!(w.phone_exchange("second", now_ms()).await, phone);
    // The old conversation (with the `/new` typed in it) and what the phone added since.
    let shown = w.page().await;
    assert_eq!(w.api.session(), phone);
    assert_eq!(shown[..2], ["first", "re:first"]);
    assert_eq!(shown[shown.len() - 2..], ["second", "re:second"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_conversation_deleted_here_is_not_reopened() {
    let w = world("deleted").await;
    let phone = w.phone_exchange("soon gone", now_ms()).await;
    w.store.delete_session(phone).unwrap();
    assert_eq!(w.page().await, Vec::<String>::new());
    assert_eq!(w.api.session(), w.own);
}

// ---- the window as a face ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn window_message_moves_face() {
    let w = world("moves").await;
    let phone = w.phone_exchange("on the way", now_ms()).await;
    let before = w.gateway.current_session(HANDOFF_MS);
    assert!(
        matches!(&before, Some((s, Origin::Channel { channel, .. })) if *s == phone && channel == "telegram"),
        "{before:?}"
    );
    // Opening the window alone moves nothing: only a message does.
    w.page().await;
    assert_eq!(w.gateway.current_session(HANDOFF_MS), before);
    w.window_says(json!({ "text": "home now" })).await;
    until("the conversation at the window", || {
        w.gateway.current_session(HANDOFF_MS) == Some((phone, Origin::Window))
    })
    .await;
    // So what she says unprompted comes here, into the open conversation, and not to the phone.
    w.say("Drink water", Urgency::Normal);
    w.say("Drink water", Urgency::Normal);
    w.say("Leave now", Urgency::High);
    until("three lines in the conversation", || {
        w.history(phone).len() == 7
    })
    .await;
    assert_eq!(
        w.history(phone)[4..],
        ["Drink water", "Drink water", "❗ Leave now"]
    );
    assert_eq!(w.phone.sent(), ["re:on the way"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_phone_continues_the_window_conversation() {
    let w = world("reverse").await;
    // The phone has a chat of its own from before.
    let old = w
        .phone_exchange("last week", now_ms() - 7 * 24 * 60 * MINUTE)
        .await;
    a_moment().await;
    w.window_says(json!({ "text": "started at the desk" }))
        .await;
    assert_eq!(
        w.gateway.current_session(HANDOFF_MS),
        Some((w.own, Origin::Window))
    );
    let next = w.phone_exchange("finishing outside", now_ms()).await;
    assert_eq!(next, w.own);
    assert_ne!(next, old);
    assert_eq!(
        w.history(w.own),
        [
            "started at the desk",
            "re:started at the desk",
            "finishing outside",
            "re:finishing outside"
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_private_conversation_is_not_handed_to_the_phone() {
    let w = world("private").await;
    w.window_says(json!({ "text": "between us", "private": true }))
        .await;
    assert_eq!(w.gateway.current_session(HANDOFF_MS), None);
    let phone = w.phone_exchange("hello", now_ms()).await;
    assert_ne!(phone, w.own);
}

// ---- what the gateway says to the window ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn inflight_reply_reaches_window() {
    let w = world("inflight").await;
    w.phone_says("hold on the phone", now_ms());
    until("the phone's turn to start", || {
        w.brain.turn("hold on the phone").is_some()
            && w.gateway.current_session(HANDOFF_MS).is_some()
    })
    .await;
    let phone = w.brain.turn("hold on the phone").unwrap().0;
    assert_eq!(w.page().await, ["hold on the phone"]);

    let mut s = Sse::open(&w, json!({ "text": "hold at the desk" })).await;
    until("the phone to hear it moved", || {
        w.phone.sent().contains(&"Continued on window.".to_owned())
            && w.brain.turn("hold at the desk").is_some()
    })
    .await;
    // The reply still being written on the phone's turn arrives in the window's stream.
    w.brain.release("hold on the phone");
    assert_eq!(s.note().await, "re:hold on the phone");
    w.brain.release("hold at the desk");
    let rest = s.rest().await;
    assert!(
        rest.last().is_some_and(|f| f.get("done").is_some()),
        "{rest:?}"
    );
    until("the window to be free", || !w.api.busy()).await;

    // Recorded once, by the brain, and never sent to the phone.
    assert_eq!(
        w.history(phone),
        [
            "hold on the phone",
            "hold at the desk",
            "re:hold on the phone",
            "re:hold at the desk"
        ]
    );
    assert_eq!(w.phone.sent(), ["Continued on window."]);
    assert_eq!(w.page().await, w.history(phone));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_line_said_during_an_answer_is_kept_after_it() {
    let w = world("during").await;
    let mut s = Sse::open(&w, json!({ "text": "hold please" })).await;
    until("the turn to start", || {
        w.brain.turn("hold please").is_some()
    })
    .await;
    w.say("Stretch", Urgency::Urgent);
    assert_eq!(s.note().await, "‼️ Stretch");
    // Not between a question and its answer.
    assert_eq!(w.history(w.own), ["hold please"]);
    // The owner starts another conversation on the phone meanwhile. Opening a page now does
    // not move the window off the chat being answered.
    a_moment().await;
    w.phone_says("/new", now_ms());
    until("a new conversation on the phone", || {
        w.phone.sent().contains(&"New conversation.".to_owned())
    })
    .await;
    let other = w.phone_exchange("meanwhile", now_ms()).await;
    assert_ne!(other, w.own);
    assert_eq!(w.page().await, ["hold please"]);
    assert_eq!(w.api.session(), w.own);

    w.brain.release("hold please");
    s.rest().await;
    until("the line in the conversation", || {
        w.history(w.own).len() == 3
    })
    .await;
    assert_eq!(
        w.history(w.own),
        ["hold please", "re:hold please", "‼️ Stretch"]
    );
    // Once the answer is done, opening the window goes where the owner is.
    let began = Instant::now();
    while w.page().await != ["meanwhile", "re:meanwhile"] {
        assert!(began.elapsed() < WAIT, "the window never followed");
        a_moment().await;
    }
    assert_eq!(w.api.session(), other);
}

#[tokio::test]
async fn a_window_channel_not_joined_takes_nothing_and_asks_nobody() {
    let window = WindowChannel::new(&Bus::new(8));
    assert_eq!(window.name(), "window");
    let chat = ChatRef {
        chat: "main".into(),
    };
    let out = Outbound {
        text: "hello".into(),
        files: vec![],
        voice: false,
    };
    // An error, so the gateway says it in the chats instead.
    assert!(window.send(&chat, &out).await.is_err());
    assert!(window
        .ask(&chat, "May I?", CancellationToken::new())
        .await
        .is_err());
}
