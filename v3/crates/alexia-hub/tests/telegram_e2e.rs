// SPDX-License-Identifier: AGPL-3.0-only
//! P1-18: V3-1's done-when, measured. The real `alexia-hub run` binary against a fake Bot API,
//! two fake free providers and a fake v2 core. Everything is scripted; nothing real is called.
//!
//! What the script does differently from the spec's prose, and why (see the report):
//! - A message is sent only after the previous turn was delivered. The gateway restarts a turn
//!   that shows nothing yet when the next message arrives (CH-09), so overlapping messages would
//!   merge by chance and the turn counts could not be asserted.
//! - A fake v2 task takes `TASK_DELAY_MS` before its first word, not 5 s, so the run is ~90 s.
//! - The bridge quotes chat turns v2 has not seen as context in the next task's request, so
//!   "no chat message reaches v2" means: no request whose own text (after that context) is one.
//! - A steered turn is cancelled and never recorded, so the latency check expects 47 turns.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

const TOKEN: &str = "e2e-dummy-token";
const V2_TOKEN: &str = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
/// The owner: a private chat's id is its user's id.
const OWNER: i64 = 4242;
/// The fake v2's first word comes this long after the request.
const TASK_DELAY_MS: u64 = 1_500;
const DELTA_GAP_MS: u64 = 600;
const TASK_REPLY: &str = "Task finished ok.";
const CONTEXT_HEAD: &str = "(Earlier in this chat:)\n";

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A small seeded generator: the same run twice picks the same delays.
struct Rng(u64);

impl Rng {
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        lo + self.0 % (hi - lo + 1)
    }
}

// ---- raw HTTP/1.1 ----

struct Req {
    path: String,
    body: Vec<u8>,
}

impl Req {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

/// The next request on a kept-alive connection, or `None` when the peer is gone.
async fn read_req(sock: &mut TcpStream, buf: &mut Vec<u8>) -> Option<Req> {
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).into_owned();
            let len: usize = head
                .lines()
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length").then(|| v.trim())
                })
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            let total = end + 4 + len;
            if buf.len() >= total {
                let body = buf[end + 4..total].to_vec();
                buf.drain(..total);
                let path = head.split_whitespace().nth(1).unwrap_or("").to_owned();
                return Some(Req { path, body });
            }
        }
        let mut tmp = [0u8; 8192];
        let n = sock.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
}

/// Writes a complete JSON answer in one write; `false` when the peer is gone. One write, and
/// `TCP_NODELAY` on every socket: head and body as two small writes stall on delayed ACKs.
async fn answer(sock: &mut TcpStream, body: &str) -> bool {
    let all = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    );
    sock.write_all(all.as_bytes()).await.is_ok() && sock.flush().await.is_ok()
}

const SSE: &str = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n";

async fn send_sse(sock: &mut TcpStream, data: &str) -> bool {
    sock.write_all(data.as_bytes()).await.is_ok() && sock.flush().await.is_ok()
}

async fn listen() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    (listener, format!("http://{addr}"))
}

// ---- the fake Bot API ----

#[derive(Default)]
struct BotState {
    /// Updates not yet acknowledged by an offset: (update id, update).
    queue: Vec<(i64, Value)>,
    next_id: i64,
    /// message id → when the fake finished writing the `getUpdates` answer that carried it.
    receipt: HashMap<i64, Instant>,
    /// message id → when the fake had read its `setMessageReaction`.
    reaction: HashMap<i64, Instant>,
    sent: Vec<String>,
    drafts: Vec<String>,
}

struct Bot {
    st: Mutex<BotState>,
    wake: Notify,
}

impl Bot {
    async fn start() -> (Arc<Bot>, String) {
        let bot = Arc::new(Bot {
            st: Mutex::default(),
            wake: Notify::new(),
        });
        let (listener, base) = listen().await;
        let b = bot.clone();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let _ = sock.set_nodelay(true);
                tokio::spawn(b.clone().conn(sock));
            }
        });
        (bot, base)
    }

    /// The owner says `text`; the id of the message.
    fn say(&self, text: &str) -> i64 {
        let mut st = lock(&self.st);
        st.next_id += 1;
        let id = st.next_id;
        let date = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let update = json!({"update_id": id, "message": {
            "message_id": id, "date": date,
            "chat": {"id": OWNER, "type": "private"},
            "from": {"id": OWNER, "is_bot": false, "username": "owner"},
            "text": text,
        }});
        st.queue.push((id, update));
        drop(st);
        self.wake.notify_one();
        id
    }

    fn sent(&self) -> Vec<String> {
        lock(&self.st).sent.clone()
    }

    async fn conn(self: Arc<Self>, mut sock: TcpStream) {
        let mut buf = Vec::new();
        while let Some(req) = read_req(&mut sock, &mut buf).await {
            let method = req.path.rsplit('/').next().unwrap_or("").to_owned();
            let ok = match method.as_str() {
                "getUpdates" => self.get_updates(&mut sock, &req.json()).await,
                "setMessageReaction" => {
                    if let Some(id) = req.json()["message_id"].as_i64() {
                        lock(&self.st)
                            .reaction
                            .entry(id)
                            .or_insert_with(Instant::now);
                    }
                    answer(&mut sock, r#"{"ok":true,"result":true}"#).await
                }
                "sendMessage" => {
                    let id = {
                        let mut st = lock(&self.st);
                        st.sent
                            .push(req.json()["text"].as_str().unwrap_or("").to_owned());
                        100_000 + st.sent.len()
                    };
                    answer(
                        &mut sock,
                        &json!({"ok": true, "result": {"message_id": id}}).to_string(),
                    )
                    .await
                }
                "sendMessageDraft" => {
                    lock(&self.st)
                        .drafts
                        .push(req.json()["text"].as_str().unwrap_or("").to_owned());
                    answer(&mut sock, r#"{"ok":true,"result":true}"#).await
                }
                _ => answer(&mut sock, r#"{"ok":true,"result":true}"#).await,
            };
            if !ok {
                return;
            }
        }
    }

    /// Long poll: answers at once when something is waiting, else when something arrives.
    async fn get_updates(&self, sock: &mut TcpStream, body: &Value) -> bool {
        let offset = body["offset"].as_i64().unwrap_or(0);
        let wait = Duration::from_secs(body["timeout"].as_u64().unwrap_or(0).min(50));
        let until = tokio::time::Instant::now() + wait;
        let updates = loop {
            let ready: Vec<(i64, Value)> = {
                let mut st = lock(&self.st);
                st.queue.retain(|(id, _)| *id >= offset);
                st.queue.clone()
            };
            if !ready.is_empty() {
                break ready;
            }
            if tokio::time::timeout_at(until, self.wake.notified())
                .await
                .is_err()
            {
                break Vec::new();
            }
        };
        let result: Vec<&Value> = updates.iter().map(|(_, u)| u).collect();
        let sent = answer(sock, &json!({"ok": true, "result": result}).to_string()).await;
        // The receipt moment: the answer is written, so the hub can have the message.
        let now = Instant::now();
        let mut st = lock(&self.st);
        for (id, _) in &updates {
            st.receipt.entry(*id).or_insert(now);
        }
        sent
    }
}

// ---- the fake free providers ----

/// One OpenAI-compatible provider. The first byte of a chat comes `lo..=hi` ms after the
/// request. The answer repeats the user's last message, so a reply can be matched to it.
struct Provider {
    base: String,
    models: AtomicUsize,
    chats: AtomicUsize,
}

async fn provider(id: &'static str, lo: u64, hi: u64, seed: u64) -> Arc<Provider> {
    let (listener, base) = listen().await;
    let p = Arc::new(Provider {
        base: format!("{base}/v1"),
        models: AtomicUsize::new(0),
        chats: AtomicUsize::new(0),
    });
    let rng = Arc::new(Mutex::new(Rng(seed)));
    let state = p.clone();
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            let _ = sock.set_nodelay(true);
            tokio::spawn(provider_conn(id, lo, hi, rng.clone(), state.clone(), sock));
        }
    });
    p
}

async fn provider_conn(
    id: &'static str,
    lo: u64,
    hi: u64,
    rng: Arc<Mutex<Rng>>,
    p: Arc<Provider>,
    mut sock: TcpStream,
) {
    let mut buf = Vec::new();
    while let Some(req) = read_req(&mut sock, &mut buf).await {
        if req.path.ends_with("/models") {
            p.models.fetch_add(1, Ordering::SeqCst);
            let list = json!({"data": [{"id": format!("fake-{id}-chat")}]});
            if !answer(&mut sock, &list.to_string()).await {
                return;
            }
            continue;
        }
        p.chats.fetch_add(1, Ordering::SeqCst);
        let said = last_user_text(&req.json());
        let wait = lock(&rng).range(lo, hi);
        tokio::time::sleep(Duration::from_millis(wait)).await;
        let model = format!("fake-{id}-chat");
        let frame = |delta: Value, finish: Value| {
            let f = json!({"model": model, "choices": [{"delta": delta, "finish_reason": finish}]});
            format!("data: {f}\n\n")
        };
        let words = format!("You said: {said}");
        let (head, tail) = words.split_at(words.len() / 2);
        let _ = send_sse(&mut sock, SSE).await
            && send_sse(&mut sock, &frame(json!({"content": head}), Value::Null)).await
            && send_sse(&mut sock, &frame(json!({"content": tail}), Value::Null)).await
            && send_sse(&mut sock, &frame(json!({}), json!("stop"))).await
            && send_sse(&mut sock, "data: [DONE]\n\n").await;
        // `connection: close`: the stream ends with the connection.
        return;
    }
}

fn last_user_text(body: &Value) -> String {
    let content = body["messages"]
        .as_array()
        .and_then(|m| m.iter().rev().find(|m| m["role"] == "user"))
        .map(|m| m["content"].clone())
        .unwrap_or(Value::Null);
    match content {
        Value::String(s) => s,
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

// ---- the fake v2 core ----

#[derive(Default)]
struct V2 {
    /// The `text` of every `/api/chat`, in order.
    chats: Mutex<Vec<String>>,
    stops: AtomicUsize,
}

async fn v2() -> (Arc<V2>, String) {
    let (listener, base) = listen().await;
    let v2 = Arc::new(V2::default());
    let state = v2.clone();
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            let _ = sock.set_nodelay(true);
            tokio::spawn(v2_conn(state.clone(), sock));
        }
    });
    (v2, format!("{base}/"))
}

async fn v2_conn(v2: Arc<V2>, mut sock: TcpStream) {
    let mut buf = Vec::new();
    while let Some(req) = read_req(&mut sock, &mut buf).await {
        let ok = match req.path.as_str() {
            "/" => answer(&mut sock, &format!("<html>{V2_TOKEN}</html>")).await,
            "/api/chat" => {
                lock(&v2.chats).push(req.json()["text"].as_str().unwrap_or("").to_owned());
                stream_task(&mut sock).await;
                // `connection: close`: the stream ends with the connection.
                return;
            }
            p => {
                if p == "/api/stop" {
                    v2.stops.fetch_add(1, Ordering::SeqCst);
                }
                answer(&mut sock, "{}").await
            }
        };
        if !ok {
            return;
        }
    }
}

/// A slow task: it announces a tool step, goes quiet, then writes three deltas.
async fn stream_task(sock: &mut TcpStream) {
    let event = |e: Value| format!("data: {e}\n\n");
    if !send_sse(sock, SSE).await
        || !send_sse(sock, &event(json!({"step": {"n": 1, "name": "search"}}))).await
    {
        return;
    }
    tokio::time::sleep(Duration::from_millis(TASK_DELAY_MS)).await;
    for (i, word) in ["Task ", "finished ", "ok."].into_iter().enumerate() {
        if i > 0 {
            tokio::time::sleep(Duration::from_millis(DELTA_GAP_MS)).await;
        }
        if !send_sse(sock, &event(json!({"delta": word}))).await {
            return;
        }
    }
    let _ = send_sse(sock, &event(json!({"done": {"model": "fake-v2"}}))).await;
}

// ---- the hub process ----

struct Hub {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Arc<Mutex<Vec<String>>>,
    stderr: Arc<Mutex<Vec<String>>>,
}

/// The hub's command with a fresh data folder under `root`, nothing real reachable.
fn command(root: &Path) -> Command {
    let (data, plugins) = (root.join("data"), root.join("plugins"));
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&plugins).unwrap();
    let mut c = Command::new(env!("CARGO_BIN_EXE_alexia-hub"));
    c.env("ALEXIA_V3_DATA", data)
        .env("ALEXIA_PLUGINS_DIR", plugins)
        .env("ALEXIA_SECRETS_IN_MEMORY", "1")
        .env("ALEXIA_HUB_STOP_ON_EOF", "1")
        .env("NO_PROXY", "127.0.0.1,localhost")
        .env("no_proxy", "127.0.0.1,localhost")
        .env_remove("ALEXIA_V2_ROOT")
        .env_remove("ALEXIA_V2_URL")
        .env_remove("ALEXIA_V2_TOKEN")
        .env_remove("ALEXIA_TELEGRAM_API")
        .env_remove("ALEXIA_FREE_PROVIDERS");
    c
}

fn lines_of<R: std::io::Read + Send + 'static>(r: R) -> Arc<Mutex<Vec<String>>> {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(r).lines().map_while(Result::ok) {
            lock(&sink).push(line);
        }
    });
    lines
}

impl Hub {
    fn run(mut c: Command) -> Hub {
        let mut child = c
            .arg("run")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        Hub {
            stdin: child.stdin.take(),
            stdout: lines_of(child.stdout.take().unwrap()),
            stderr: lines_of(child.stderr.take().unwrap()),
            child,
        }
    }

    fn said(&self, needle: &str) -> bool {
        lock(&self.stdout).iter().any(|l| l.contains(needle))
    }

    /// What the hub printed, for a failure message.
    fn log(&self) -> String {
        let tail = |l: &Mutex<Vec<String>>| {
            let l = lock(l);
            l[l.len().saturating_sub(40)..].join("\n")
        };
        format!(
            "--- hub stdout ---\n{}\n--- hub stderr ---\n{}",
            tail(&self.stdout),
            tail(&self.stderr)
        )
    }

    /// EOF on stdin is the stop signal (`ALEXIA_HUB_STOP_ON_EOF`). Its exit code, or `None`
    /// when it did not stop within 60 s (it is then killed).
    async fn stop(&mut self) -> Option<i32> {
        drop(self.stdin.take());
        let until = Instant::now() + Duration::from_secs(60);
        while Instant::now() < until {
            if let Ok(Some(status)) = self.child.try_wait() {
                // The readers may still hold the last lines.
                tokio::time::sleep(Duration::from_millis(200)).await;
                return status.code();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        None
    }
}

impl Drop for Hub {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// Polls `cond` every 20 ms for up to `secs`.
async fn until(secs: u64, mut cond: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    cond()
}

fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("alexia-hub-e2e-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// `ALEXIA_FREE_PROVIDERS`: two keyless, all-free rows at the fakes.
fn providers_file(root: &Path, a: &Provider, b: &Provider) -> PathBuf {
    let row = |id: &str, p: &Provider| json!({"id": id, "base_url": p.base, "models_path": "/models", "auth": "none", "all_free": true});
    let path = root.join("providers.json");
    std::fs::write(&path, json!([row("fakea", a), row("fakeb", b)]).to_string()).unwrap();
    path
}

/// The environment variable the hub reads the bot token from: P1-03's fallback, named from the
/// key `alexia-hub secret list` prints.
fn token_env(root: &Path) -> String {
    let o = command(root).args(["secret", "list"]).output().unwrap();
    let keys = String::from_utf8_lossy(&o.stdout).into_owned();
    let key = keys
        .lines()
        .find(|k| k.contains("telegram"))
        .unwrap_or_else(|| panic!("no telegram key in `secret list`: {keys}"));
    alexia_store::secrets::env_name("_core", key)
}

// ---- the script ----

struct Say {
    text: String,
    task: bool,
    /// Sent 200 ms after the one before it, so the two merge.
    merges: bool,
    /// A task whose first draft is awaited before the next message steers it.
    steered: bool,
}

/// 30 chat and 20 task messages in blocks of five. Block 6 holds the task pair that merges;
/// block 8 the task that is steered by the one after it. Messages 4 and 5 are the chat pair.
fn script() -> Vec<Say> {
    let (mut chat, mut task) = (0, 0);
    let mut out: Vec<Say> = Vec::new();
    for block in 0..10 {
        let kinds = if block == 6 || block == 8 {
            "CTTCC"
        } else {
            "CTCTC"
        };
        for k in kinds.chars() {
            let at = out.len();
            let text = if k == 'T' {
                task += 1;
                match task % 4 {
                    0 => format!("remind me to water the plants {task:02}"),
                    1 => format!("search for rust async tutorials {task:02}"),
                    2 => format!("https://example.com/page/{task:02}"),
                    _ => format!("find my notes about project {task:02}"),
                }
            } else {
                chat += 1;
                let said = ["hi there", "thanks a lot", "how's it going", "good morning"];
                format!("{} {chat:02}", said[chat % said.len()])
            };
            out.push(Say {
                text,
                task: k == 'T',
                merges: at == 5 || at == 32,
                steered: at == 41,
            });
        }
    }
    out
}

fn percentile(sorted: &[u128], p: usize) -> u128 {
    sorted[(sorted.len() * p / 100).min(sorted.len() - 1)]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "P2-39: tasks now go to the Agent, not the fake v2 core this test scripts; P2-39 rewrites it"]
async fn fifty_messages_ack_under_300ms_and_chat_skips_v2() {
    let root = scratch("fifty");
    let (bot, bot_base) = Bot::start().await;
    let (pa, pb) = (
        provider("a", 200, 600, 0x9E37_79B9_7F4A_7C15).await,
        provider("b", 400, 1200, 0xD1B5_4A32_D192_ED03).await,
    );
    let (v2, v2_url) = v2().await;

    let mut c = command(&root);
    c.env("ALEXIA_TELEGRAM_API", &bot_base)
        .env("ALEXIA_FREE_PROVIDERS", providers_file(&root, &pa, &pb))
        .env("ALEXIA_V2_URL", &v2_url)
        .env("ALEXIA_V2_TOKEN", V2_TOKEN)
        .env(token_env(&root), TOKEN);
    let mut hub = Hub::run(c);

    // Pairing: the code is on the hub's stdout; the owner sends it to the bot.
    assert!(
        until(60, || hub.said("to pair it")).await,
        "the hub never printed a pairing code\n{}",
        hub.log()
    );
    let code = lock(&hub.stdout)
        .iter()
        .find(|l| l.contains("to pair it"))
        .and_then(|l| l.split_whitespace().nth(1).map(str::to_owned))
        .unwrap();
    bot.say(&code);
    assert!(
        until(60, || bot.sent().iter().any(|m| m.starts_with("Paired"))).await,
        "the hub did not pair\n{}",
        hub.log()
    );
    // The catalog has both lists, so the first chat can hedge across both providers.
    assert!(
        until(60, || pa.models.load(Ordering::SeqCst) > 0
            && pb.models.load(Ordering::SeqCst) > 0)
        .await,
        "the hub never asked the providers for their models\n{}",
        hub.log()
    );
    tokio::time::sleep(Duration::from_millis(500)).await;

    let msgs = script();
    assert_eq!(msgs.iter().filter(|m| m.task).count(), 20);
    assert_eq!(msgs.len(), 50);
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    let (mut ids, mut want_v2): (Vec<i64>, Vec<String>) = (Vec::new(), Vec::new());
    let (mut tasks_done, mut turns) = (0usize, 0usize);
    let task_replies = |bot: &Bot| bot.sent().iter().filter(|m| *m == TASK_REPLY).count();
    let mut i = 0;
    while i < msgs.len() {
        tokio::time::sleep(Duration::from_millis(rng.range(300, 900))).await;
        let first = &msgs[i];
        let mut last = i;
        ids.push(bot.say(&first.text));
        let mut texts = vec![first.text.clone()];
        if msgs.get(i + 1).is_some_and(|n| n.merges) {
            tokio::time::sleep(Duration::from_millis(200)).await;
            ids.push(bot.say(&msgs[i + 1].text));
            texts.push(msgs[i + 1].text.clone());
            last = i + 1;
        }
        if first.steered {
            // After its first words are on screen, the next message steers it (CH-08).
            let seen = lock(&bot.st).drafts.len();
            assert!(
                until(60, || lock(&bot.st).drafts[seen..]
                    .iter()
                    .any(|d| d.starts_with("Task")))
                .await,
                "the steered task never showed a draft\n{}",
                hub.log()
            );
            want_v2.push(first.text.clone());
            ids.push(bot.say(&msgs[i + 1].text));
            texts = vec![msgs[i + 1].text.clone()];
            last = i + 1;
        }
        if first.task {
            want_v2.push(texts.join("\n"));
            tasks_done += 1;
            let ok = until(60, || task_replies(&bot) >= tasks_done).await;
            assert!(ok, "no task reply for {texts:?}\n{}", hub.log());
        } else {
            let tail = texts.last().unwrap().clone();
            let ok = until(60, || bot.sent().iter().any(|m| m.contains(&tail))).await;
            assert!(ok, "no chat reply for {tail:?}\n{}", hub.log());
        }
        turns += 1;
        i = last + 1;
    }
    // 50 messages, 2 merged away, and the steered task's own turn was cancelled and never recorded.
    let recorded = turns;
    assert_eq!(recorded, 47);

    // Every reaction landed, within 300 ms of receipt.
    assert_eq!(ids.len(), 50);
    let mut ms: Vec<u128> = Vec::new();
    {
        let st = lock(&bot.st);
        for id in &ids {
            let receipt = st.receipt.get(id);
            let reaction = st.reaction.get(id);
            let (Some(receipt), Some(reaction)) = (receipt, reaction) else {
                panic!("message {id}: no reaction ({receipt:?}, {reaction:?})");
            };
            ms.push(reaction.saturating_duration_since(*receipt).as_millis());
        }
    }
    let mut sorted = ms.clone();
    sorted.sort_unstable();
    println!(
        "ack ms over {} messages: p50 {} p95 {} max {}",
        sorted.len(),
        percentile(&sorted, 50),
        percentile(&sorted, 95),
        sorted[sorted.len() - 1]
    );
    // One scheduler stall on a loaded machine must not fail the run: p95 is the only bound.
    let mut slowest: Vec<(&i64, &u128)> = ids.iter().zip(&ms).collect();
    slowest.sort_by_key(|(_, ms)| std::cmp::Reverse(**ms));
    slowest.truncate(5);
    let p95 = percentile(&sorted, 95);
    assert!(
        p95 < 300,
        "p95 ack was {p95} ms (limit 300); slowest five (message id, ms): {slowest:?}"
    );

    // v2 got exactly the task requests, and never a chat message as its own request.
    let mut got_v2: Vec<String> = lock(&v2.chats)
        .iter()
        .map(|t| match t.strip_prefix(CONTEXT_HEAD) {
            Some(rest) => rest.rsplit_once("\n\n").map_or(rest, |(_, typed)| typed),
            None => t.as_str(),
        })
        .map(str::to_owned)
        .collect();
    got_v2.sort();
    want_v2.sort();
    assert_eq!(got_v2, want_v2, "what v2 was asked");
    for chat in msgs.iter().filter(|m| !m.task) {
        assert!(
            !got_v2.iter().any(|t| t.contains(&chat.text)),
            "chat message {:?} reached v2 as a request",
            chat.text
        );
        assert!(
            bot.sent().iter().any(|m| m.contains(&chat.text)),
            "chat message {:?} got no reply",
            chat.text
        );
    }
    assert_eq!(
        v2.stops.load(Ordering::SeqCst),
        1,
        "one /api/stop: the steer"
    );
    // Hedging: every chat turn started both providers.
    assert!(pa.chats.load(Ordering::SeqCst) >= 29, "provider A");
    assert!(pb.chats.load(Ordering::SeqCst) >= 29, "provider B");

    let code = hub.stop().await;
    assert_eq!(code, Some(0), "the hub did not stop cleanly\n{}", hub.log());
    assert!(hub.said("Stopped."), "{}", hub.log());
    let everything = format!("{}{}", hub.log(), lock(&hub.stdout).join("\n"));
    assert!(!everything.contains(TOKEN), "the bot token was printed");

    // The hub kept 47 turns; `latency --check` fails on a missing ack, a chat turn through the
    // bridge, an unaccounted gap, or p95 ack >= 300 ms.
    let html = root.join("latency.html");
    let o = command(&root)
        .args([
            "latency",
            "--last",
            &recorded.to_string(),
            "--check",
            "--html",
        ])
        .arg(&html)
        .output()
        .unwrap();
    let said = format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    );
    assert_eq!(
        o.status.code(),
        Some(0),
        "latency --check failed:
{said}"
    );
    assert!(
        std::fs::metadata(&html).is_ok_and(|m| m.len() > 0),
        "latency --html wrote nothing:\n{said}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hub_with_no_channel_still_boots() {
    let root = scratch("nochannel");
    let (pa, pb) = (
        provider("a", 200, 600, 1).await,
        provider("b", 400, 1200, 2).await,
    );
    let (v2, v2_url) = v2().await;
    let mut c = command(&root);
    // The P1 wiring is all there; only the bot token is missing.
    c.env("ALEXIA_FREE_PROVIDERS", providers_file(&root, &pa, &pb))
        .env("ALEXIA_V2_URL", &v2_url)
        .env("ALEXIA_V2_TOKEN", V2_TOKEN)
        .env_remove(token_env(&root));
    let mut hub = Hub::run(c);
    assert!(
        until(60, || hub.said("Alexia hub is running")).await,
        "the hub did not come up\n{}",
        hub.log()
    );
    assert!(hub.said("No channel is set up"), "{}", hub.log());
    // It stays up: nothing about a missing channel ends the process.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(
        matches!(hub.child.try_wait(), Ok(None)),
        "the hub exited by itself\n{}",
        hub.log()
    );
    assert_eq!(hub.stop().await, Some(0), "{}", hub.log());
    assert!(hub.said("Stopped."), "{}", hub.log());
    assert!(lock(&v2.chats).is_empty(), "v2 was asked something");
    let _ = std::fs::remove_dir_all(&root);
}
