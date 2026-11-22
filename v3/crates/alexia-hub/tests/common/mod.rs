// SPDX-License-Identifier: AGPL-3.0-only
//! Shared by `agent_e2e.rs` and `telegram_e2e.rs`: a raw HTTP/1.1 server kit, the fake Bot API
//! (with receipt and reaction times, drafts, buttons and button presses), and the `alexia-hub run`
//! process. Each test file uses a part, so unused items are fine.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

pub const TOKEN: &str = "e2e-dummy-token";
/// The owner: a private chat's id is its user's id.
pub const OWNER: i64 = 4242;

pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Polls `cond` every 20 ms for up to `secs`.
pub async fn until(secs: u64, mut cond: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    cond()
}

pub fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("alexia-hub-e2e-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

// ---- raw HTTP/1.1 ----

pub struct Req {
    pub path: String,
    pub body: Vec<u8>,
}

impl Req {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

/// The next request on a kept-alive connection, or `None` when the peer is gone.
pub async fn read_req(sock: &mut TcpStream, buf: &mut Vec<u8>) -> Option<Req> {
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
pub async fn answer(sock: &mut TcpStream, body: &str) -> bool {
    let all = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    );
    sock.write_all(all.as_bytes()).await.is_ok() && sock.flush().await.is_ok()
}

pub const SSE: &str =
    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n";

pub async fn send_sse(sock: &mut TcpStream, data: &str) -> bool {
    sock.write_all(data.as_bytes()).await.is_ok() && sock.flush().await.is_ok()
}

pub async fn listen() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    (listener, format!("http://{addr}"))
}

/// The last user text of a chat request body.
pub fn last_user_text(body: &Value) -> String {
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

// ---- the fake Bot API ----

/// A message the hub sent with buttons: a question to the owner.
#[derive(Clone, Debug)]
pub struct Question {
    pub message: i64,
    pub text: String,
    /// (label, callback data)
    pub buttons: Vec<(String, String)>,
}

#[derive(Default)]
pub struct BotState {
    /// Updates not yet acknowledged by an offset: (update id, update).
    pub queue: Vec<(i64, Value)>,
    pub next_id: i64,
    /// message id → when the fake finished writing the `getUpdates` answer that carried it.
    pub receipt: HashMap<i64, Instant>,
    /// message id → when the fake had read its `setMessageReaction`.
    pub reaction: HashMap<i64, Instant>,
    pub sent: Vec<String>,
    pub drafts: Vec<String>,
    pub questions: Vec<Question>,
}

pub struct Bot {
    pub st: Mutex<BotState>,
    wake: Notify,
}

impl Bot {
    pub async fn start() -> (Arc<Bot>, String) {
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

    fn push(&self, make: impl FnOnce(i64) -> Value) -> i64 {
        let mut st = lock(&self.st);
        st.next_id += 1;
        let id = st.next_id;
        st.queue.push((id, make(id)));
        drop(st);
        self.wake.notify_one();
        id
    }

    /// The owner says `text`; the id of the message.
    pub fn say(&self, text: &str) -> i64 {
        let date = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        self.push(|id| {
            json!({"update_id": id, "message": {
                "message_id": id, "date": date,
                "chat": {"id": OWNER, "type": "private"},
                "from": {"id": OWNER, "is_bot": false, "username": "owner"},
                "text": text,
            }})
        })
    }

    /// The owner presses the button labelled `label` on `q`.
    pub fn press(&self, q: &Question, label: &str) {
        let data = q
            .buttons
            .iter()
            .find(|(l, _)| l == label)
            .unwrap_or_else(|| panic!("no {label} button on {q:?}"))
            .1
            .clone();
        self.push(|id| {
            json!({"update_id": id, "callback_query": {
                "id": format!("cb-{id}"),
                "from": {"id": OWNER, "is_bot": false, "username": "owner"},
                "message": {
                    "message_id": q.message, "date": 0,
                    "chat": {"id": OWNER, "type": "private"},
                    "text": q.text,
                },
                "data": data,
            }})
        });
    }

    pub fn sent(&self) -> Vec<String> {
        lock(&self.st).sent.clone()
    }

    pub fn questions(&self) -> Vec<Question> {
        lock(&self.st).questions.clone()
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
                    let body = req.json();
                    let id = {
                        let mut st = lock(&self.st);
                        let text = body["text"].as_str().unwrap_or("").to_owned();
                        st.sent.push(text.clone());
                        let id = 100_000 + st.sent.len() as i64;
                        let row = body["reply_markup"]["inline_keyboard"][0].as_array();
                        if let Some(row) = row {
                            let buttons = row
                                .iter()
                                .map(|b| {
                                    (
                                        b["text"].as_str().unwrap_or("").to_owned(),
                                        b["callback_data"].as_str().unwrap_or("").to_owned(),
                                    )
                                })
                                .collect();
                            st.questions.push(Question {
                                message: id,
                                text,
                                buttons,
                            });
                        }
                        id
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

// ---- the hub process ----

pub struct Hub {
    pub child: Child,
    stdin: Option<ChildStdin>,
    pub stdout: Arc<Mutex<Vec<String>>>,
    pub stderr: Arc<Mutex<Vec<String>>>,
}

/// The hub's command with a fresh data folder under `root` (kept if already there), nothing
/// real reachable: no subscription CLI, no channel, no provider.
pub fn command(root: &Path) -> Command {
    let (data, plugins) = (root.join("data"), root.join("plugins"));
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&plugins).unwrap();
    let none = root.join("not-installed");
    let mut c = Command::new(env!("CARGO_BIN_EXE_alexia-hub"));
    c.env("ALEXIA_V3_DATA", data)
        .env("ALEXIA_PLUGINS_DIR", plugins)
        .env("ALEXIA_SECRETS_IN_MEMORY", "1")
        .env("ALEXIA_HUB_STOP_ON_EOF", "1")
        .env("ALEXIA_CLAUDE_CLI", &none)
        .env("ALEXIA_CODEX_CLI", &none)
        .env("NO_PROXY", "127.0.0.1,localhost")
        .env("no_proxy", "127.0.0.1,localhost")
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
    pub fn run(mut c: Command) -> Hub {
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

    pub fn said(&self, needle: &str) -> bool {
        lock(&self.stdout).iter().any(|l| l.contains(needle))
    }

    /// What the hub printed, for a failure message.
    pub fn log(&self) -> String {
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

    pub async fn up(&self) {
        assert!(
            until(120, || self.said("Alexia hub is running")).await,
            "the hub did not come up\n{}",
            self.log()
        );
    }

    /// Prints the pairing code; the owner sends it to the bot, and the bot says "Paired".
    pub async fn pair(&self, bot: &Bot) {
        assert!(
            until(120, || self.said("to pair it")).await,
            "the hub never printed a pairing code\n{}",
            self.log()
        );
        let code = lock(&self.stdout)
            .iter()
            .find(|l| l.contains("to pair it"))
            .and_then(|l| l.split_whitespace().nth(1).map(str::to_owned))
            .unwrap();
        bot.say(&code);
        assert!(
            until(60, || bot.sent().iter().any(|m| m.starts_with("Paired"))).await,
            "the hub did not pair\n{}",
            self.log()
        );
    }

    /// EOF on stdin is the stop signal (`ALEXIA_HUB_STOP_ON_EOF`). Its exit code, or `None`
    /// when it did not stop within 60 s (it is then killed).
    pub async fn stop(&mut self) -> Option<i32> {
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

    /// A crash: the process is ended with no chance to say goodbye.
    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
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
