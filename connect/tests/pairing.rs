// SPDX-License-Identifier: AGPL-3.0-only

//! Pairing, end to end: sidecars in one process, real iroh endpoints on this machine, and a
//! mailbox server that is a stub — just enough of Magic Wormhole's rendezvous protocol, over a
//! real WebSocket, for the `magic-wormhole` client to run its whole exchange against.
//!
//! What this cannot show is in `README.md` under "Not exercised by tests": no deployed mailbox
//! server, no TLS to one, no second machine, no network between the two endpoints.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alexia_connect::pairing::{Settings, Timing, ALPN};
use alexia_connect::{start, Network, Options, Running};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::Incoming;
use hyper::header::{HeaderMap, AUTHORIZATION};
use hyper::{Request, StatusCode};
use hyper_util::rt::TokioIo;
use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, RelayMode, SecretKey, TransportAddr};
use magic_wormhole::{AppConfig, AppID, MailboxConnection, Wormhole};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Notify};
use tokio::task::JoinSet;
use tokio::time::{sleep, timeout};
use tokio_tungstenite::tungstenite::Message;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

const APP_ID: &str = "dev.alexia.pairing.v1";

// ---------------------------------------------------------------------------------------------
// The log, as the binary would write it
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Everything logged by any test in this file, through the binary's own filter but at `trace`,
/// which is more than the binary can be asked for.
fn log() -> String {
    static LOG: OnceLock<Captured> = OnceLock::new();
    let captured = LOG.get_or_init(|| {
        let captured = Captured::default();
        let writer = captured.clone();
        let lines = tracing_subscriber::fmt::layer().with_writer(move || writer.clone());
        tracing_subscriber::registry().with(lines).with(alexia_connect::logged(LevelFilter::TRACE)).init();
        captured
    });
    String::from_utf8_lossy(&captured.0.lock().unwrap()).into_owned()
}

/// A code that was used in a test, and what the log may not hold of it.
fn unlogged(code: &str) {
    let log = log();
    let words = code.split_once('-').expect("a number and words").1;
    assert!(log.contains("pairing started"), "the log was captured at all");
    assert!(!log.contains(code), "a code was logged");
    assert!(!log.contains(words), "a code's words were logged");
    // Nothing of the wormhole crate's, which prints the messages it sends.
    assert!(!log.contains("magic_wormhole") && !log.contains("Sending"), "the wormhole's own lines were logged");
}

// ---------------------------------------------------------------------------------------------
// The mailbox stub
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
struct Plate {
    mailbox: String,
    /// The sides holding a claim. As on the real server, a claim outlives its connection.
    sides: HashSet<String>,
}

#[derive(Default)]
struct Box_ {
    messages: Vec<Value>,
    /// Every side that ever opened it. Two, and no more.
    sides: HashSet<String>,
    listeners: HashMap<String, mpsc::UnboundedSender<String>>,
}

#[derive(Default)]
struct Boxes {
    allocated: u32,
    plates: HashMap<String, Plate>,
    mailboxes: HashMap<String, Box_>,
    /// Everything any client sent, for a test to look through.
    heard: Vec<Value>,
}

struct Mailbox {
    url: String,
    boxes: Arc<Mutex<Boxes>>,
    gone: Arc<Notify>,
}

impl Mailbox {
    /// Drop every connection, mid-sentence, as a server that fell over would.
    fn fall_over(&self) {
        self.gone.notify_waiters();
        // Each listener holds its socket's writing half open.
        for mailbox in self.boxes.lock().unwrap().mailboxes.values_mut() {
            mailbox.listeners.clear();
        }
    }

    /// The numbers that could still be claimed by a newcomer.
    fn open_numbers(&self) -> usize {
        self.boxes.lock().unwrap().plates.len()
    }

    fn heard(&self, kind: &str) -> usize {
        self.boxes.lock().unwrap().heard.iter().filter(|message| message["type"] == kind).count()
    }
}

async fn mailbox() -> Mailbox {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let url = format!("ws://127.0.0.1:{}/v1", listener.local_addr().unwrap().port());
    let (boxes, gone) = (Arc::new(Mutex::new(Boxes::default())), Arc::new(Notify::new()));
    let shared = (boxes.clone(), gone.clone());
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let (boxes, gone) = shared.clone();
            tokio::spawn(async move {
                tokio::select! {
                    () = serve_mailbox(stream, boxes) => {}
                    () = gone.notified() => {}
                }
            });
        }
    });
    Mailbox { url, boxes, gone }
}

async fn serve_mailbox(stream: TcpStream, boxes: Arc<Mutex<Boxes>>) {
    let Ok(socket) = tokio_tungstenite::accept_async(stream).await else { return };
    let (mut sink, mut source) = socket.split();
    let (out, mut queued) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(text) = queued.recv().await {
            if sink.send(Message::text(text)).await.is_err() {
                break;
            }
        }
    });
    let say = |value: Value| drop(out.send(value.to_string()));
    say(json!({ "type": "welcome", "welcome": {} }));

    let mut side = String::new();
    while let Some(Ok(message)) = source.next().await {
        let Message::Text(text) = message else { continue };
        let ask: Value = serde_json::from_str(text.as_str()).unwrap();
        say(json!({ "type": "ack" }));
        let mut boxes = boxes.lock().unwrap();
        boxes.heard.push(ask.clone());
        let named = |field: &str| ask[field].as_str().unwrap_or_default().to_owned();
        match ask["type"].as_str().unwrap_or_default() {
            "bind" => side = named("side"),
            "list" => {
                let listed: Vec<Value> = boxes.plates.keys().map(|id| json!({ "id": id })).collect();
                say(json!({ "type": "nameplates", "nameplates": listed }));
            }
            "allocate" => {
                boxes.allocated += 1;
                say(json!({ "type": "allocated", "nameplate": boxes.allocated.to_string() }));
            }
            "claim" => {
                let fresh = format!("mailbox-{}", boxes.plates.len() + boxes.mailboxes.len() + boxes.heard.len());
                let plate = boxes.plates.entry(named("nameplate")).or_insert_with(|| Plate { mailbox: fresh, ..Plate::default() });
                if plate.sides.len() >= 2 && !plate.sides.contains(&side) {
                    say(json!({ "type": "error", "error": "crowded", "orig": ask }));
                    continue;
                }
                plate.sides.insert(side.clone());
                say(json!({ "type": "claimed", "mailbox": plate.mailbox }));
            }
            "release" => {
                let number = named("nameplate");
                if let Some(plate) = boxes.plates.get_mut(&number) {
                    plate.sides.remove(&side);
                    if plate.sides.is_empty() {
                        boxes.plates.remove(&number);
                    }
                }
                say(json!({ "type": "released" }));
            }
            "open" => {
                let mailbox = boxes.mailboxes.entry(named("mailbox")).or_default();
                if mailbox.sides.len() >= 2 && !mailbox.sides.contains(&side) {
                    say(json!({ "type": "error", "error": "crowded", "orig": ask }));
                    continue;
                }
                mailbox.sides.insert(side.clone());
                mailbox.listeners.insert(side.clone(), out.clone());
                for message in &mailbox.messages {
                    say(message.clone());
                }
            }
            "add" => {
                let said = json!({ "type": "message", "side": side, "phase": ask["phase"], "body": ask["body"], "id": "m" });
                let holding = boxes.mailboxes.values_mut().find(|mailbox| mailbox.listeners.contains_key(&side));
                if let Some(mailbox) = holding {
                    mailbox.messages.push(said.clone());
                    // To everybody listening, the sender too: the real server echoes.
                    mailbox.listeners.retain(|_, listener| listener.send(said.to_string()).is_ok());
                }
            }
            "close" => {
                if let Some(mailbox) = boxes.mailboxes.get_mut(&named("mailbox")) {
                    mailbox.listeners.remove(&side);
                }
                say(json!({ "type": "closed" }));
            }
            _ => {}
        }
    }
    // Gone without a word: it stops listening, and what it claimed stays claimed.
    for mailbox in boxes.lock().unwrap().mailboxes.values_mut() {
        mailbox.listeners.remove(&side);
    }
}

// ---------------------------------------------------------------------------------------------
// A client for the loopback port, as core would be
// ---------------------------------------------------------------------------------------------

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Incoming,
    _connection: JoinSet<()>,
}

impl Reply {
    async fn json(self) -> Value {
        serde_json::from_slice(&self.body.collect().await.expect("a whole body").to_bytes()).expect("json")
    }

    fn error(&self) -> Option<&str> {
        self.headers.get("x-alexia-connect-error").and_then(|value| value.to_str().ok())
    }
}

async fn call(port: u16, secret: Option<&str>, method: &str, path: &str, body: Option<Value>) -> Reply {
    let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.unwrap();
    let mut held = JoinSet::new();
    held.spawn(async move {
        let _ = connection.await;
    });
    let mut request = Request::builder().method(method).uri(path).header("host", format!("127.0.0.1:{port}"));
    if let Some(secret) = secret {
        request = request.header(AUTHORIZATION, format!("Bearer {secret}"));
    }
    let request = match body {
        Some(body) => request.header("content-type", "application/json").body(Full::new(Bytes::from(body.to_string())).boxed()),
        None => request.body(Empty::new().boxed()),
    };
    let (parts, body) = sender.send_request(request.unwrap()).await.expect("an answer").into_parts();
    Reply { status: parts.status, headers: parts.headers, body, _connection: held }
}

/// Short enough that a test of a failure does not take a minute; long enough for a slow machine.
fn quick() -> Timing {
    Timing {
        join_timeout: Duration::from_secs(8),
        mailbox_timeout: Duration::from_secs(5),
        proof_timeout: Duration::from_secs(4),
        ..Timing::default()
    }
}

struct Side {
    running: Running,
    port: u16,
    id: String,
    secret: String,
    name: String,
}

async fn side_with(name: &str, mailbox: Option<&Mailbox>, timing: Timing) -> Side {
    log();
    let secret = format!("{name}-secret-0123456789abcdef0123456789abcdef");
    let mailbox_url = mailbox.map(|mailbox| Settings::mailbox(&mailbox.url).unwrap());
    let pairing = Settings { mailbox_url, timing, loopback_hints: true };
    let options = Options { secret: secret.clone(), key: SecretKey::generate(), network: Network::default(), pairing };
    let running = start(options).await.expect("start");
    Side { port: running.port(), id: running.endpoint_id(), running, secret, name: name.to_owned() }
}

async fn side(name: &str, mailbox: &Mailbox) -> Side {
    side_with(name, Some(mailbox), quick()).await
}

impl Side {
    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> Reply {
        call(self.port, Some(&self.secret), method, path, body).await
    }

    async fn ok(&self, method: &str, path: &str, body: Option<Value>) -> Value {
        let reply = self.call(method, path, body).await;
        assert_eq!(reply.status, StatusCode::OK, "{method} {path}");
        reply.json().await
    }

    /// A request that is refused, and the code it is refused with.
    async fn refused(&self, method: &str, path: &str, body: Option<Value>) -> (u16, String) {
        let reply = self.call(method, path, body).await;
        let (status, code) = (reply.status.as_u16(), reply.error().expect("an error header").to_owned());
        assert_eq!(reply.json().await["error"]["code"], code.as_str());
        (status, code)
    }

    fn me(&self) -> Value {
        json!({ "name": self.name, "payload": { "role": "compute", "said-by": self.name } })
    }

    /// Open a pairing: its id and its code.
    async fn host(&self) -> (String, String) {
        let opened = self.ok("POST", "/v1/pairing/host", Some(self.me())).await;
        let text = |field: &str| opened[field].as_str().unwrap().to_owned();
        (text("pairingId"), text("code"))
    }

    async fn join(&self, code: &str) -> String {
        let mut ask = self.me();
        ask["code"] = json!(code);
        self.ok("POST", "/v1/pairing/join", Some(ask)).await["pairingId"].as_str().unwrap().to_owned()
    }

    /// The pairing, once it has settled.
    async fn settled(&self, pairing: &str) -> Value {
        let path = format!("/v1/pairing/{pairing}?wait=true");
        let said = timeout(Duration::from_secs(30), self.ok("GET", &path, None)).await.expect("a pairing settles");
        assert_ne!(said["state"], "waiting");
        said
    }

    async fn failed(&self, pairing: &str) -> String {
        let said = self.settled(pairing).await;
        assert_eq!(said["state"], "failed", "{said}");
        assert!(said.get("peer").is_none(), "a failed pairing names nobody");
        said["error"]["code"].as_str().unwrap().to_owned()
    }

    async fn allowlist(&self) -> Vec<Value> {
        self.ok("GET", "/v1/status", None).await["allowlist"].as_array().unwrap().clone()
    }

    /// Where this side's endpoint can be dialled on this machine.
    async fn loopback(&self) -> std::net::SocketAddr {
        let status = self.ok("GET", "/v1/status", None).await;
        let bound = status["boundAddresses"].as_array().unwrap().iter().filter_map(Value::as_str);
        let port = bound.filter_map(|address| address.strip_prefix("0.0.0.0:")).next().expect("an IPv4 socket");
        format!("127.0.0.1:{port}").parse().unwrap()
    }
}

/// The next server-sent event of one kind.
async fn event(reply: &mut Reply, buffer: &mut String, kind: &str) -> Value {
    loop {
        if let Some(end) = buffer.find("\n\n") {
            let text: String = buffer.drain(..end + 2).collect();
            let field = |name: &str| text.lines().find_map(|line| line.strip_prefix(name));
            if let (Some(event), Some(data)) = (field("event: "), field("data: ")) {
                if event == kind {
                    return serde_json::from_str(data).unwrap();
                }
            }
            continue;
        }
        let frame = timeout(Duration::from_secs(30), reply.body.frame()).await.expect("an event in time");
        let data = frame.expect("an open stream").expect("no error").into_data().unwrap_or_default();
        buffer.push_str(std::str::from_utf8(&data).unwrap());
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

/// The same number, and four words that are not the code's.
fn mistyped(code: &str) -> String {
    let number = code.split_once('-').unwrap().0;
    let wrong = format!("{number}-wrong-words-entirely-typed");
    assert_ne!(wrong, code);
    wrong
}

// ---------------------------------------------------------------------------------------------
// A peer that is not this crate, speaking the wormhole's side of the protocol by hand
// ---------------------------------------------------------------------------------------------

fn hello(endpoint_id: &str, addresses: &[String]) -> Value {
    let hello = json!({
        "endpointId": endpoint_id,
        "name": "Somebody else",
        "payload": null,
        "hints": { "relayUrl": null, "directAddresses": addresses },
    });
    json!({ "alexia": 1, "hello": hello.to_string() })
}

fn config(mailbox: &Mailbox, said: Value) -> AppConfig<Value> {
    AppConfig { id: AppID::new(APP_ID), rendezvous_url: Cow::Owned(mailbox.url.clone()), app_version: said }
}

// ---------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_computers_pair_and_each_proves_the_identity_it_named() {
    let mailbox = mailbox().await;
    let (host, joiner) = (side("studio", &mailbox).await, side("laptop", &mailbox).await);
    let mut host_events = host.call("GET", "/v1/events", None).await;
    let mut joiner_events = joiner.call("GET", "/v1/events", None).await;
    let (mut host_buffer, mut joiner_buffer) = (String::new(), String::new());

    let before = now();
    let opened = host.ok("POST", "/v1/pairing/host", Some(host.me())).await;
    let (pairing, code) = (opened["pairingId"].as_str().unwrap(), opened["code"].as_str().unwrap());

    // A mailbox number and four words, good for five minutes.
    let (number, words) = code.split_once('-').unwrap();
    assert!(number.parse::<u32>().is_ok(), "a number first");
    let words: Vec<&str> = words.split('-').collect();
    assert_eq!(words.len(), 4);
    assert!(words.iter().all(|word| !word.is_empty() && word.bytes().all(|byte| byte.is_ascii_lowercase())));
    let expires = opened["expiresAt"].as_u64().unwrap();
    assert!((before + 299_000..=now() + 300_000).contains(&expires), "five minutes: {expires}");

    // The code is said once. Asking about the pairing does not say it again.
    let listed = host.ok("GET", "/v1/pairing", None).await;
    assert_eq!(listed["mailboxUrl"], mailbox.url.as_str());
    assert_eq!(listed["pairings"], json!([{ "pairingId": pairing, "role": "host", "state": "waiting", "expiresAt": expires }]));
    let one = host.ok("GET", &format!("/v1/pairing/{pairing}"), None).await;
    assert_eq!(one["state"], "waiting");
    assert!(!listed.to_string().contains(code) && !one.to_string().contains(code));

    let joined = joiner.join(code).await;

    // Each is told, once, the other — the id it proved, and what its core sent along.
    let told_host = event(&mut host_events, &mut host_buffer, "pairing").await;
    let told_joiner = event(&mut joiner_events, &mut joiner_buffer, "pairing").await;
    assert_eq!(told_host["pairingId"], pairing);
    assert_eq!((&told_host["role"], &told_host["state"]), (&json!("host"), &json!("paired")));
    assert_eq!(told_host["peer"]["endpointId"], joiner.id.as_str());
    assert_eq!(told_host["peer"]["name"], "laptop");
    assert_eq!(told_host["peer"]["payload"], json!({ "role": "compute", "said-by": "laptop" }));
    assert_eq!(told_joiner["pairingId"], joined.as_str());
    assert_eq!((&told_joiner["role"], &told_joiner["state"]), (&json!("join"), &json!("paired")));
    assert_eq!(told_joiner["peer"]["endpointId"], host.id.as_str());
    assert_eq!(told_joiner["peer"]["name"], "studio");
    // Asking says the same thing the event did.
    assert_eq!(host.settled(pairing).await, told_host);
    assert_eq!(joiner.settled(&joined).await, told_joiner);
    assert!(!told_host.to_string().contains(code) && !told_joiner.to_string().contains(code));

    // The sidecar proved a peer. It paired nobody: that is core's to do.
    assert!(host.allowlist().await.is_empty() && joiner.allowlist().await.is_empty());
    let connect = format!("/v1/peers/{}/connect", host.id);
    assert_eq!(joiner.refused("POST", &connect, None).await, (403, "peer_not_allowed".to_owned()));

    // Core does it, with what it was told and nothing else — and the two can talk.
    for (this, told) in [(&host, &told_host), (&joiner, &told_joiner)] {
        let peer = told["peer"]["endpointId"].as_str().unwrap();
        this.ok("PUT", "/v1/allowlist", Some(json!({ "endpointIds": [peer] }))).await;
        this.ok("PUT", &format!("/v1/peers/{peer}/hints"), Some(told["peer"]["hints"].clone())).await;
    }
    assert_eq!(joiner.ok("POST", &connect, None).await["status"], "direct");

    // The mailbox was left tidy: the number released, the box closed, by both.
    assert_eq!(mailbox.open_numbers(), 0);
    assert_eq!(mailbox.heard("close"), 2);

    // A used code is no code.
    let late = side("latecomer", &mailbox).await;
    let again = late.join(code).await;
    assert_eq!(late.failed(&again).await, "pairing_code_unknown");
    assert_eq!(host.settled(pairing).await["state"], "paired", "what settled stays settled");

    unlogged(code);
    for side in [host, joiner, late] {
        side.running.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_wrong_code_fails_and_is_the_only_attempt_the_code_gets() {
    let mailbox = mailbox().await;
    let (host, guesser, owner) = (side("studio", &mailbox).await, side("guesser", &mailbox).await, side("laptop", &mailbox).await);
    let (pairing, code) = host.host().await;

    let guess = guesser.join(&mistyped(&code)).await;
    assert_eq!(guesser.failed(&guess).await, "pairing_wrong_code");
    assert_eq!(host.failed(&pairing).await, "pairing_wrong_code");

    // The right code, a moment later, is too late: the attempt was spent.
    let late = owner.join(&code).await;
    let why = owner.failed(&late).await;
    assert!(["pairing_code_unknown", "pairing_timeout"].contains(&why.as_str()), "{why}");
    assert_eq!(host.failed(&pairing).await, "pairing_wrong_code");
    for side in [&host, &guesser, &owner] {
        assert!(side.allowlist().await.is_empty());
    }

    // A fresh code is a fresh start.
    let (pairing, fresh) = host.host().await;
    assert_ne!(fresh, code);
    let joined = owner.join(&fresh).await;
    assert_eq!(owner.settled(&joined).await["peer"]["endpointId"], host.id.as_str());
    assert_eq!(host.settled(&pairing).await["peer"]["endpointId"], owner.id.as_str());

    unlogged(&code);
    unlogged(&fresh);
    for side in [host, guesser, owner] {
        side.running.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_code_expires() {
    let mailbox = mailbox().await;
    let brief = Timing { code_ttl: Duration::from_millis(1500), join_timeout: Duration::from_secs(3), ..quick() };
    let (host, joiner) = (side_with("studio", Some(&mailbox), brief).await, side_with("laptop", Some(&mailbox), brief).await);
    let mut events = host.call("GET", "/v1/events", None).await;
    let mut buffer = String::new();

    let before = now();
    let opened = host.ok("POST", "/v1/pairing/host", Some(host.me())).await;
    let (pairing, code) = (opened["pairingId"].as_str().unwrap(), opened["code"].as_str().unwrap());
    assert!(opened["expiresAt"].as_u64().unwrap() <= now() + 1500);

    // Nobody comes. It is over when it said it would be, and not before.
    let told = event(&mut events, &mut buffer, "pairing").await;
    assert_eq!((&told["pairingId"], &told["state"]), (&json!(pairing), &json!("failed")));
    assert_eq!(told["error"]["code"], "pairing_expired");
    assert!(now() - before >= 1500, "not before its time");

    // The code went with it: the host is no longer there to answer for it.
    let late = joiner.join(code).await;
    let why = joiner.failed(&late).await;
    assert!(["pairing_code_unknown", "pairing_timeout"].contains(&why.as_str()), "{why}");
    assert_eq!(host.failed(pairing).await, "pairing_expired");
    assert!(host.allowlist().await.is_empty() && joiner.allowlist().await.is_empty());

    unlogged(code);
    host.running.close().await;
    joiner.running.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelling_kills_the_code() {
    let mailbox = mailbox().await;
    let brief = Timing { join_timeout: Duration::from_secs(3), ..quick() };
    let (host, joiner) = (side("studio", &mailbox).await, side_with("laptop", Some(&mailbox), brief).await);
    let mut events = host.call("GET", "/v1/events", None).await;
    let mut buffer = String::new();
    let (pairing, code) = host.host().await;

    assert_eq!(host.ok("DELETE", &format!("/v1/pairing/{pairing}"), None).await, json!({ "cancelled": true }));
    let told = event(&mut events, &mut buffer, "pairing").await;
    assert_eq!((&told["pairingId"], &told["error"]["code"]), (&json!(pairing), &json!("pairing_cancelled")));
    // Cancelling what is over changes nothing, and what was never there is not found.
    assert_eq!(host.ok("DELETE", &format!("/v1/pairing/{pairing}"), None).await, json!({ "cancelled": false }));
    assert_eq!(host.refused("DELETE", "/v1/pairing/0123456789abcdef", None).await, (404, "not_found".to_owned()));
    assert_eq!(host.refused("GET", "/v1/pairing/0123456789abcdef", None).await, (404, "not_found".to_owned()));

    let late = joiner.join(&code).await;
    let why = joiner.failed(&late).await;
    assert!(["pairing_code_unknown", "pairing_timeout"].contains(&why.as_str()), "{why}");
    assert_eq!(host.failed(&pairing).await, "pairing_cancelled");

    // A join is cancelled the same way: here, one waiting for a host that will never answer.
    let waiting = joiner.join(&code).await;
    assert_eq!(joiner.ok("DELETE", &format!("/v1/pairing/{waiting}"), None).await, json!({ "cancelled": true }));
    assert_eq!(joiner.failed(&waiting).await, "pairing_cancelled");
    assert!(host.allowlist().await.is_empty() && joiner.allowlist().await.is_empty());

    unlogged(&code);
    host.running.close().await;
    joiner.running.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_mailbox_that_falls_over_fails_the_pairing_and_nothing_else() {
    let mailbox = mailbox().await;
    let (host, joiner) = (side("studio", &mailbox).await, side("laptop", &mailbox).await);
    let (pairing, code) = host.host().await;

    mailbox.fall_over();
    assert_eq!(host.failed(&pairing).await, "pairing_mailbox_failed");

    // The sidecar is still there, and a server that is back is one it can use.
    let (pairing, fresh) = host.host().await;
    let joined = joiner.join(&fresh).await;
    assert_eq!(joiner.settled(&joined).await["peer"]["endpointId"], host.id.as_str());
    assert_eq!(host.settled(&pairing).await["peer"]["endpointId"], joiner.id.as_str());

    unlogged(&code);
    unlogged(&fresh);
    host.running.close().await;
    joiner.running.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_pairings_at_once_do_not_cross() {
    let mailbox = mailbox().await;
    let (studio, garage) = (side("studio", &mailbox).await, side("garage", &mailbox).await);
    let (laptop, tablet, phone) = (side("laptop", &mailbox).await, side("tablet", &mailbox).await, side("phone", &mailbox).await);

    // One computer with two codes out, and another with a third, all at the same mailbox.
    let allow_more = |side: &Side| {
        let mut ask = side.me();
        ask["exclusive"] = json!(false);
        ask
    };
    let first = studio.ok("POST", "/v1/pairing/host", Some(allow_more(&studio))).await;
    let second = studio.ok("POST", "/v1/pairing/host", Some(allow_more(&studio))).await;
    let third = garage.ok("POST", "/v1/pairing/host", Some(allow_more(&garage))).await;
    let code = |opened: &Value| opened["code"].as_str().unwrap().to_owned();
    let id = |opened: &Value| opened["pairingId"].as_str().unwrap().to_owned();
    let numbers: HashSet<String> = [&first, &second, &third].map(|opened| code(opened).split_once('-').unwrap().0.to_owned()).into();
    assert_eq!(numbers.len(), 3, "a number each");

    // All three joined together.
    let (codes, ids) = ([code(&first), code(&second), code(&third)], [id(&first), id(&second), id(&third)]);
    let (by_laptop, by_tablet, by_phone) = tokio::join!(laptop.join(&codes[0]), tablet.join(&codes[1]), phone.join(&codes[2]));

    let peer = |said: Value| said["peer"]["endpointId"].as_str().expect("a peer").to_owned();
    assert_eq!(peer(laptop.settled(&by_laptop).await), studio.id);
    assert_eq!(peer(tablet.settled(&by_tablet).await), studio.id);
    assert_eq!(peer(phone.settled(&by_phone).await), garage.id);
    // Each code brought the computer that typed it, and no other.
    assert_eq!(peer(studio.settled(&ids[0]).await), laptop.id);
    assert_eq!(peer(studio.settled(&ids[1]).await), tablet.id);
    assert_eq!(peer(garage.settled(&ids[2]).await), phone.id);
    assert_eq!(studio.settled(&ids[1]).await["peer"]["name"], "tablet");

    for code in &codes {
        unlogged(code);
    }
    for side in [studio, garage, laptop, tablet, phone] {
        side.running.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_joiner_that_names_an_identity_it_does_not_hold_is_not_trusted() {
    let mailbox = mailbox().await;
    let (host, victim) = (side("studio", &mailbox).await, side("victim", &mailbox).await);
    let (pairing, code) = host.host().await;

    // Somebody who has the code — so the wormhole opens for them — and says they are the
    // victim, at an address of their own.
    let impostor = Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::generate())
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(RelayMode::Disabled)
        .bind()
        .await
        .unwrap();
    let theirs: Vec<String> = impostor.bound_sockets().iter().map(|bound| format!("127.0.0.1:{}", bound.port())).collect();
    let said = hello(&victim.id, &theirs[..1]);
    let wormhole = MailboxConnection::connect(config(&mailbox, said), code.parse().unwrap(), false).await.unwrap();
    let wormhole = Wormhole::connect(wormhole).await.expect("the code was right, so the wormhole opens");
    assert!(wormhole.peer_version()["hello"].as_str().unwrap().contains(&host.id), "and the host said who it is");

    // The host now expects the victim. The impostor dials as what it is, and gets nothing: no
    // stream, and above all no MAC to carry anywhere.
    let dialled = async {
        let address = EndpointAddr::from_parts(host.id.parse().unwrap(), [TransportAddr::Ip(host.loopback().await)]);
        let connection = impostor.connect(address, ALPN).await.ok()?;
        let (mut send, mut recv) = connection.open_bi().await.ok()?;
        send.write_all(&[7; 32]).await.ok()?;
        let mut answer = [0; 64];
        recv.read_exact(&mut answer).await.ok()?;
        Some(answer)
    };
    assert!(timeout(Duration::from_secs(10), dialled).await.expect("refused promptly").is_none(), "the gate answered a stranger");

    // Nobody proved they hold the victim's key. Nobody is reported.
    assert_eq!(host.failed(&pairing).await, "pairing_proof_failed");
    assert!(host.allowlist().await.is_empty());
    let pairings = victim.ok("GET", "/v1/pairing", None).await;
    assert_eq!(pairings["pairings"], json!([]), "the victim was never part of it");

    unlogged(&code);
    impostor.close().await;
    host.running.close().await;
    victim.running.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_host_that_names_an_identity_it_does_not_hold_is_not_trusted() {
    let mailbox = mailbox().await;
    let (joiner, victim) = (side("laptop", &mailbox).await, side("victim", &mailbox).await);

    // Somebody opens a pairing by hand and says they are the victim — a real computer, at its
    // real address, which is not pairing with anybody.
    let said = hello(&victim.id, &[victim.loopback().await.to_string()]);
    let opened = MailboxConnection::create(config(&mailbox, said), 4).await.unwrap();
    let code = opened.code().to_string();
    let impostor = tokio::spawn(Wormhole::connect(opened));

    let joined = joiner.join(&code).await;
    assert!(impostor.await.unwrap().is_ok(), "the wormhole itself opens: the code was right");

    // The joiner dials the victim, whose gate has no pairing that names the joiner.
    assert_eq!(joiner.failed(&joined).await, "pairing_proof_failed");
    assert!(joiner.allowlist().await.is_empty() && victim.allowlist().await.is_empty());
    assert_eq!(victim.ok("GET", "/v1/peers", None).await["peers"], json!([]));

    // And one that names nobody at all — an id with no computer behind it — fares no better.
    let nobody = SecretKey::generate().public().to_string();
    let opened = MailboxConnection::create(config(&mailbox, hello(&nobody, &["127.0.0.1:9".to_owned()])), 4).await.unwrap();
    let second = opened.code().to_string();
    let impostor = tokio::spawn(Wormhole::connect(opened));
    let joined = joiner.join(&second).await;
    assert!(impostor.await.unwrap().is_ok());
    assert_eq!(joiner.failed(&joined).await, "pairing_proof_failed");

    // Nor one that is not this protocol: another version, or a message past the size limit.
    for said in [json!({ "alexia": 2, "hello": "{}" }), json!({ "alexia": 1, "hello": " ".repeat(5000) })] {
        let opened = MailboxConnection::create(config(&mailbox, said), 4).await.unwrap();
        let code = opened.code().to_string();
        let other = tokio::spawn(Wormhole::connect(opened));
        let joined = joiner.join(&code).await;
        assert_eq!(joiner.failed(&joined).await, "pairing_peer_invalid");
        let _ = other.await;
    }

    unlogged(&code);
    unlogged(&second);
    joiner.running.close().await;
    victim.running.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_mailbox_no_pairing_and_one_controller_at_a_time() {
    let mailbox = mailbox().await;
    let host = side_with("studio", None, quick()).await;
    let joiner = side("laptop", &mailbox).await;
    let refused = |status: u16, code: &str| (status, code.to_owned());
    let code = "7-crossover-clockwork-guitarist-tonic";
    let join = |code: &str| Some(json!({ "code": code, "name": "studio" }));

    // No secret, no pairing; and with no mailbox server there is nowhere to meet.
    assert_eq!(call(host.port, None, "POST", "/v1/pairing/host", Some(host.me())).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(host.ok("GET", "/v1/pairing", None).await, json!({ "mailboxUrl": null, "pairings": [] }));
    assert_eq!(host.refused("POST", "/v1/pairing/host", Some(host.me())).await, refused(503, "mailbox_not_configured"));
    assert_eq!(host.refused("POST", "/v1/pairing/join", join(code)).await, refused(503, "mailbox_not_configured"));

    let set = |url: Value| Some(json!({ "url": url }));
    assert_eq!(host.refused("PUT", "/v1/pairing/mailbox", set(json!("https://mailbox.example.org"))).await, refused(400, "bad_request"));
    assert_eq!(host.refused("PUT", "/v1/pairing/mailbox", Some(json!({}))).await, refused(400, "bad_request"));
    assert_eq!(host.ok("PUT", "/v1/pairing/mailbox", set(json!("ws://127.0.0.1:9/v1"))).await["mailboxUrl"], "ws://127.0.0.1:9/v1");
    assert_eq!(host.ok("PUT", "/v1/pairing/mailbox", set(json!(null))).await, json!({ "mailboxUrl": null }));
    assert_eq!(host.ok("PUT", "/v1/pairing/mailbox", set(json!(mailbox.url))).await, json!({ "mailboxUrl": mailbox.url }));

    // What is not a name, a payload or a code is refused before anything is attempted.
    let named = |name: &str, payload: Value| Some(json!({ "name": name, "payload": payload }));
    for bad in [named("", json!(null)), named(&"x".repeat(129), json!(null)), named("studio", json!("x".repeat(1024)))] {
        assert_eq!(host.refused("POST", "/v1/pairing/host", bad).await, refused(400, "bad_request"));
    }
    assert_eq!(host.refused("POST", "/v1/pairing/host", Some(json!({ "name": "studio", "code": code }))).await, refused(400, "bad_request"));
    for bad in ["7", "7-crossover", "crossover-clockwork-guitarist-tonic", "7-crossover-clockwork-guitarist-tonic-extra", "7 crossover clockwork guitarist tonic"] {
        assert_eq!(host.refused("POST", "/v1/pairing/join", join(bad)).await, refused(400, "bad_request"), "{bad}");
    }
    assert_eq!(mailbox.heard("bind"), 0, "none of that reached the mailbox");

    // A mailbox that is not there is said so, and leaves no pairing behind.
    host.ok("PUT", "/v1/pairing/mailbox", set(json!("ws://127.0.0.1:9/v1"))).await;
    assert_eq!(host.refused("POST", "/v1/pairing/host", Some(host.me())).await, refused(502, "pairing_mailbox_failed"));
    host.ok("PUT", "/v1/pairing/mailbox", set(json!(mailbox.url))).await;
    assert_eq!(host.ok("GET", "/v1/pairing", None).await["pairings"], json!([]));

    // One controller: while anybody is on the allowlist, a compute host opens no pairing.
    let controller = SecretKey::generate().public().to_string();
    host.ok("PUT", "/v1/allowlist", Some(json!({ "endpointIds": [controller] }))).await;
    assert_eq!(host.refused("POST", "/v1/pairing/host", Some(host.me())).await, refused(409, "already_paired"));
    let mut exclusive_join = join(code).unwrap();
    exclusive_join["exclusive"] = json!(true);
    assert_eq!(host.refused("POST", "/v1/pairing/join", Some(exclusive_join)).await, refused(409, "already_paired"));
    assert_eq!(host.allowlist().await, vec![json!(controller)], "and the one that is paired stays paired");

    // Until core unpairs it. Then a pairing opens — and if core pairs somebody else while it
    // is open, the pairing does not hand over a second.
    host.ok("DELETE", &format!("/v1/allowlist/{controller}"), None).await;
    let (pairing, code) = host.host().await;
    host.ok("PUT", "/v1/allowlist", Some(json!({ "endpointIds": [controller] }))).await;
    let joined = joiner.join(&code).await;
    assert_eq!(host.failed(&pairing).await, "already_paired");
    assert_eq!(host.allowlist().await, vec![json!(controller)]);
    let _ = joiner.settled(&joined).await;

    // A computer that may have several says so, and is limited only in how many at once.
    let mut several = host.me();
    several["exclusive"] = json!(false);
    let mut open = Vec::new();
    for _ in 0..4 {
        open.push(host.ok("POST", "/v1/pairing/host", Some(several.clone())).await);
    }
    assert_eq!(host.refused("POST", "/v1/pairing/host", Some(several.clone())).await, refused(429, "pairing_limit"));
    let first = open[0]["pairingId"].as_str().unwrap();
    host.ok("DELETE", &format!("/v1/pairing/{first}"), None).await;
    open.push(host.ok("POST", "/v1/pairing/host", Some(several)).await);

    // Shutting down leaves nothing waiting.
    let mut events = host.call("GET", "/v1/events", None).await;
    let mut buffer = String::new();
    let _ = event(&mut events, &mut buffer, "snapshot").await;
    let waiting = host.ok("GET", "/v1/pairing", None).await["pairings"].as_array().unwrap().iter().filter(|pairing| pairing["state"] == "waiting").count();
    assert_eq!(waiting, 4);
    sleep(Duration::from_millis(50)).await;

    unlogged(&code);
    for opened in &open {
        unlogged(opened["code"].as_str().unwrap());
    }
    host.running.close().await;
    joiner.running.close().await;
}

// ---- pairing without a mailbox ----------------------------------------------------------------

impl Side {
    /// Open a direct pairing: its id, its code and the endpoint id a joiner dials.
    async fn host_direct(&self) -> (String, String) {
        let mut ask = self.me();
        ask["direct"] = json!(true);
        let opened = self.ok("POST", "/v1/pairing/host", Some(ask)).await;
        assert_eq!(opened["endpointId"], self.id.as_str());
        (opened["pairingId"].as_str().unwrap().to_owned(), opened["code"].as_str().unwrap().to_owned())
    }

    async fn join_direct(&self, code: &str, host: &Side) -> String {
        let mut ask = self.me();
        ask["code"] = json!(code);
        ask["direct"] = json!({ "endpointId": host.id, "addresses": [host.loopback().await.to_string()] });
        self.ok("POST", "/v1/pairing/join", Some(ask)).await["pairingId"].as_str().unwrap().to_owned()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_computers_pair_directly_without_a_mailbox() {
    let (host, joiner) = (side_with("studio", None, quick()).await, side_with("laptop", None, quick()).await);
    let (pairing, code) = host.host_direct().await;
    // Four words, and no mailbox number: there is no mailbox.
    let words: Vec<&str> = code.split('-').collect();
    assert_eq!(words.len(), 4);
    assert!(words.iter().all(|word| !word.is_empty() && word.bytes().all(|byte| byte.is_ascii_lowercase())));

    let joined = joiner.join_direct(&code, &host).await;
    let (told_host, told_joiner) = (host.settled(&pairing).await, joiner.settled(&joined).await);
    assert_eq!(told_host["state"], "paired", "{told_host}");
    assert_eq!(told_joiner["state"], "paired", "{told_joiner}");
    assert_eq!(told_host["peer"]["endpointId"], joiner.id.as_str());
    assert_eq!(told_joiner["peer"]["endpointId"], host.id.as_str());
    assert_eq!(told_joiner["peer"]["name"], "studio");
    assert!(!told_host.to_string().contains(&code) && !told_joiner.to_string().contains(&code));

    // Proven, not trusted: core still decides, and then the two can talk.
    assert!(host.allowlist().await.is_empty() && joiner.allowlist().await.is_empty());
    for (this, told) in [(&host, &told_host), (&joiner, &told_joiner)] {
        let peer = told["peer"]["endpointId"].as_str().unwrap();
        this.ok("PUT", "/v1/allowlist", Some(json!({ "endpointIds": [peer] }))).await;
        this.ok("PUT", &format!("/v1/peers/{peer}/hints"), Some(told["peer"]["hints"].clone())).await;
    }
    assert_eq!(joiner.ok("POST", &format!("/v1/peers/{}/connect", host.id), None).await["status"], "direct");

    // The gate shut behind the one joiner: a second connection under the direct ALPN is turned away.
    let late = side_with("latecomer", None, quick()).await;
    let again = late.join_direct(&code, &host).await;
    assert_eq!(late.failed(&again).await, "pairing_code_unknown");

    unlogged(&code);
    for side in [host, joiner, late] {
        side.running.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_wrong_direct_code_fails_on_both_sides_and_spends_the_code() {
    let (host, guesser, owner) =
        (side_with("studio", None, quick()).await, side_with("guesser", None, quick()).await, side_with("laptop", None, quick()).await);
    let (pairing, code) = host.host_direct().await;
    let wrong = "wrong-words-entirely-typed";
    assert_ne!(wrong, code);
    let guess = guesser.join_direct(wrong, &host).await;
    assert_eq!(guesser.failed(&guess).await, "pairing_wrong_code");
    assert_eq!(host.failed(&pairing).await, "pairing_wrong_code");
    // The right code after a wrong one finds nobody waiting.
    let late = owner.join_direct(&code, &host).await;
    assert_eq!(owner.failed(&late).await, "pairing_code_unknown");
    for side in [&host, &guesser, &owner] {
        assert!(side.allowlist().await.is_empty());
    }
    unlogged(&code);
    for side in [host, guesser, owner] {
        side.running.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn addresses_core_adds_are_said_in_the_hints_with_the_endpoints_port() {
    let (host, joiner) = (side_with("studio", None, quick()).await, side_with("laptop", None, quick()).await);
    host.ok("PUT", "/v1/self/addresses", Some(json!({ "addresses": ["100.101.102.103"] }))).await;
    assert_eq!(host.refused("PUT", "/v1/self/addresses", Some(json!({ "addresses": ["not an ip"] }))).await.0, 400);
    let (pairing, code) = host.host_direct().await;
    let joined = joiner.join_direct(&code, &host).await;
    let told = joiner.settled(&joined).await;
    let port = host.loopback().await.port();
    let hinted: Vec<&str> = told["peer"]["hints"]["directAddresses"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(hinted.contains(&format!("100.101.102.103:{port}").as_str()), "{hinted:?}");
    host.settled(&pairing).await;
    for side in [host, joiner] {
        side.running.close().await;
    }
}
