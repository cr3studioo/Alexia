// SPDX-License-Identifier: AGPL-3.0-only
//! V2Bridge: the v2 core as the task lane (CH-06, CH-07, CH-08, SP-14, HB-12).
//!
//! v2 core runs on the PC as a child process; the bridge is a client of the same loopback API
//! v2's desktop window uses (`/api/chat` as server-sent events, `/api/approve`, `/api/stop`).
//! v2 is not changed. Deleted at V3-2, when the Rust agent loop replaces it.
//!
//! v2 internals this depends on (not a contract; acceptable for one phase):
//! - `packages/core/src/entry.ts` prints `Alexia (<role>) is at <url>` on stdout.
//! - `packages/core/src/serve.ts` substitutes the token for `__TOKEN__` in text assets served
//!   at `GET /`, and checks `x-alexia-token` plus a `Host` starting `127.0.0.1`.
//! - `serve.ts` `reply()`: the `say({…})` event names, and 423 while another answer runs.
#![allow(dead_code)] // main.rs wires the bridge in P1-17.

use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use alexia_core::{
    Ask, Brain, BrainError, DraftFrame, DraftSink, Lane, Phase, Question, Reply, RunId, Span, Turn,
};
use alexia_store::{Content, MessageBody, Part, Role, Store};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

const DEFAULT_DATA_NAME: &str = "AlexiaBridge";
const START_TIMEOUT: Duration = Duration::from_secs(30);
const BUSY_RETRY: Duration = Duration::from_millis(500);
const BUSY_FOR: Duration = Duration::from_secs(10);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
const CONTEXT_TURNS: usize = 6;
const CONTEXT_CHARS: usize = 300;
const CONTEXT_HEAD: &str = "(Earlier in this chat:)\n";
const FREE_ONLY: &str = "I only use free models.";
const BUSY: &str = "I'm still finishing the last task.";
const STARTING: &str = "The task engine is still starting. Try again in a moment.";
const LOST: &str = "I lost the connection to the task engine.";

pub struct V2Config {
    /// The v2 checkout (`ALEXIA_V2_ROOT`). Its `packages/core/dist/src/entry.js` must exist.
    pub root: PathBuf,
    /// Node (`ALEXIA_NODE`, else `node` on PATH).
    pub node: PathBuf,
    /// `ALEXIA_DATA_NAME` for the child: the v2 data folder under `%LOCALAPPDATA%`. Default "AlexiaBridge".
    pub data_name: String,
    /// Test hook and escape hatch: `ALEXIA_V2_URL` + `ALEXIA_V2_TOKEN` → don't spawn, use these.
    pub attach: Option<(String, String)>,
}

impl V2Config {
    /// From the environment; `None` when `ALEXIA_V2_ROOT` is unset and nothing is attached.
    pub fn from_env() -> Option<V2Config> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let attach = var("ALEXIA_V2_URL").zip(var("ALEXIA_V2_TOKEN"));
        let root = var("ALEXIA_V2_ROOT").map(PathBuf::from);
        if root.is_none() && attach.is_none() {
            return None;
        }
        Some(V2Config {
            root: root.unwrap_or_default(),
            node: var("ALEXIA_NODE").map_or_else(|| PathBuf::from("node"), PathBuf::from),
            data_name: DEFAULT_DATA_NAME.into(),
            attach,
        })
    }
}

pub struct V2Bridge {
    cfg: V2Config,
    /// (url, token). The token lives only here; it is never logged.
    conn: RwLock<Option<(String, String)>>,
    http: reqwest::Client,
    store: Arc<Store>,
    ask: OnceLock<Arc<dyn Ask>>,
}

impl V2Bridge {
    pub fn new(cfg: V2Config, store: Arc<Store>) -> V2Bridge {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .no_proxy()
            .build()
            .unwrap_or_default();
        let conn = RwLock::new(cfg.attach.clone());
        V2Bridge {
            cfg,
            conn,
            http,
            store,
            ask: OnceLock::new(),
        }
    }

    /// The gateway's asker (CH-07). Set once after the gateway exists (the gateway needs the
    /// bridge as its brain first); until then every question is answered no.
    pub fn set_ask(&self, ask: Arc<dyn Ask>) {
        let _ = self.ask.set(ask);
    }

    /// Start (or attach), then keep v2 core alive until cancelled: if the child exits, log it and
    /// start it again with backoff 1 s doubling to 60 s (HB-12). Kills the child on cancel.
    pub async fn run(&self, cancel: CancellationToken) {
        if self.cfg.attach.is_some() {
            cancel.cancelled().await;
            return;
        }
        let mut wait = Duration::from_secs(1);
        loop {
            let began = Instant::now();
            // Dropping `life` on cancel drops the child, and `kill_on_drop` kills it.
            tokio::select! {
                _ = cancel.cancelled() => break,
                why = self.life() => tracing::warn!("{why}"),
            }
            self.set_conn(None);
            if began.elapsed() >= MAX_BACKOFF {
                wait = Duration::from_secs(1);
            }
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep(wait) => {}
            }
            wait = (wait * 2).min(MAX_BACKOFF);
        }
        self.set_conn(None);
    }

    /// Ready to answer (child up and its token read).
    pub fn ready(&self) -> bool {
        self.conn().is_some()
    }

    fn conn(&self) -> Option<(String, String)> {
        self.conn.read().map_or(None, |c| c.clone())
    }

    fn set_conn(&self, to: Option<(String, String)>) {
        if let Ok(mut c) = self.conn.write() {
            *c = to;
        }
    }

    /// One life of the child: start it, read its token, wait for it to exit. Returns why it ended.
    async fn life(&self) -> String {
        let (mut child, url) = match self.start_child().await {
            Ok(up) => up,
            Err(why) => return why,
        };
        let token = match fetch_token(&self.http, &url).await {
            Some(t) => t,
            None => return format!("v2 core at {url} did not hand out a token."),
        };
        tracing::info!("v2 core is up at {url}");
        self.set_conn(Some((url, token)));
        match child.wait().await {
            Ok(status) => format!("v2 core stopped ({status}); starting it again."),
            Err(e) => format!("v2 core could not be watched ({e}); starting it again."),
        }
    }

    async fn start_child(&self) -> Result<(Child, String), String> {
        let entry = self.cfg.root.join("packages/core/dist/src/entry.js");
        if !entry.is_file() {
            return Err(format!(
                "v2 core is not built: {} is missing.",
                entry.display()
            ));
        }
        let mut cmd = Command::new(&self.cfg.node);
        cmd.arg(&entry)
            .current_dir(&self.cfg.root)
            .env("ALEXIA_DATA_NAME", &self.cfg.data_name)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("v2 core could not be started: {e}"))?;
        if let Some(err) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(target: "v2", "{line}");
                }
            });
        }
        let Some(out) = child.stdout.take() else {
            return Err("v2 core has no stdout.".into());
        };
        let mut lines = BufReader::new(out).lines();
        let found = tokio::time::timeout(START_TIMEOUT, async {
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "v2", "{line}");
                if let Some(url) = url_in(&line) {
                    return Some(url);
                }
            }
            None
        })
        .await;
        match found {
            Ok(Some(url)) => {
                // Keep draining, or a chatty child blocks on a full pipe.
                tokio::spawn(async move {
                    while let Ok(Some(line)) = lines.next_line().await {
                        tracing::debug!(target: "v2", "{line}");
                    }
                });
                Ok((child, url))
            }
            Ok(None) => Err("v2 core exited before it started.".into()),
            Err(_) => Err("v2 core did not start.".into()),
        }
    }

    /// Text for v2: the turn, prefixed with chat-lane turns v2 has not seen (step 6).
    fn with_context(&self, turn: &Turn) -> Result<String, BrainError> {
        let typed = turn.content.text();
        let history = self.store.history(turn.session, None).map_err(store_err)?;
        let since = history
            .iter()
            .rposition(is_task)
            .map_or(&history[..], |i| &history[i + 1..]);
        // ponytail: quoted context; V3-2's agent reads the v3 session directly.
        let lines: Vec<String> = since
            .iter()
            .filter_map(|m| {
                let who = match m.role {
                    Role::User => "You",
                    Role::Assistant => "Alexia",
                    _ => return None,
                };
                let said: String = m.body.content.text().chars().take(CONTEXT_CHARS).collect();
                Some(format!("{who}: {said}"))
            })
            .collect();
        if lines.is_empty() {
            return Ok(typed);
        }
        let last = &lines[lines.len().saturating_sub(CONTEXT_TURNS)..];
        Ok(format!("{CONTEXT_HEAD}{}\n\n{typed}", last.join("\n")))
    }

    /// POST `/api/chat`, retrying a 423 for up to 10 s. `None` when cancelled meanwhile; a
    /// cancel while a request is in flight has already POSTed `/api/stop`.
    async fn post_chat(
        &self,
        url: &str,
        token: &str,
        body: &Value,
        cancel: &CancellationToken,
    ) -> Result<Option<reqwest::Response>, BrainError> {
        let until = Instant::now() + BUSY_FOR;
        loop {
            let send = self
                .http
                .post(format!("{url}api/chat"))
                .header("x-alexia-token", token)
                .json(body)
                .send();
            let resp = tokio::select! {
                _ = cancel.cancelled() => {
                    // The body may be in v2 already; a stop when v2 is idle does nothing.
                    self.post(url, token, "api/stop", json!({})).await;
                    return Ok(None);
                }
                r = send => r.map_err(|_| BrainError::Unavailable(LOST.into()))?,
            };
            match resp.status().as_u16() {
                200 => return Ok(Some(resp)),
                423 if Instant::now() < until => {}
                423 => return Err(BrainError::Unavailable(BUSY.into())),
                s => {
                    tracing::warn!("v2 core answered /api/chat with {s}");
                    return Err(BrainError::Unavailable(LOST.into()));
                }
            }
            tokio::select! {
                _ = cancel.cancelled() => return Ok(None),
                _ = tokio::time::sleep(BUSY_RETRY) => {}
            }
        }
    }

    async fn post(&self, url: &str, token: &str, path: &str, body: Value) {
        let sent = self
            .http
            .post(format!("{url}{path}"))
            .header("x-alexia-token", token)
            .timeout(Duration::from_secs(5))
            .json(&body)
            .send()
            .await;
        if let Err(e) = sent {
            tracing::warn!("v2 core {path} failed: {e}");
        }
    }

    /// Reads the SSE body to its end; the cancel check covers the stream and every ask.
    async fn stream(
        &self,
        st: &mut Run,
        mut resp: reqwest::Response,
        turn: &Turn,
        draft: &DraftSink,
        cancel: &CancellationToken,
    ) -> Result<(), BrainError> {
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let chunk = tokio::select! {
                _ = cancel.cancelled() => return Err(BrainError::Cancelled),
                c = resp.chunk() => c.map_err(|_| BrainError::Unavailable(LOST.into()))?,
            };
            let Some(chunk) = chunk else {
                return Ok(());
            };
            buf.extend_from_slice(&chunk);
            while let Some(i) = buf.windows(2).position(|w| w == b"\n\n") {
                let block: Vec<u8> = buf.drain(..i + 2).collect();
                let data: Vec<String> = String::from_utf8_lossy(&block)
                    .lines()
                    .filter_map(|l| l.strip_prefix("data:"))
                    .map(|l| l.strip_prefix(' ').unwrap_or(l))
                    .map(str::to_owned)
                    .collect();
                let Ok(event) = serde_json::from_str::<Value>(&data.join("\n")) else {
                    continue;
                };
                self.event(st, &event, turn, draft, cancel).await?;
            }
        }
    }

    async fn event(
        &self,
        st: &mut Run,
        e: &Value,
        turn: &Turn,
        draft: &DraftSink,
        cancel: &CancellationToken,
    ) -> Result<(), BrainError> {
        let now = Instant::now();
        let step = e.get("step");
        let n = step.and_then(|s| s.get("n")).and_then(Value::as_i64);
        // A tool span runs from its step's start to a delta or another step's event.
        if let Some((open, name, start)) = st.tool {
            if e.get("delta").is_some() || n.is_some_and(|n| n != open) {
                st.spans.push(Span::since(name, st.began, start));
                st.tool = None;
            }
        }
        let (url, token) = (&st.url, &st.token);
        if let Some(d) = e.get("delta").and_then(Value::as_str) {
            if st.first.is_none() {
                st.first = Some(now);
                st.spans
                    .push(Span::since("bridge-first-byte", st.began, st.sent));
            }
            st.text.push_str(d);
            let _ = draft.send(DraftFrame::Delta(d.to_owned())).await;
        } else if e.get("restart").is_some() {
            st.text.clear();
            let _ = draft.send(DraftFrame::Restart).await;
        } else if let Some(kind) = e.pointer("/phase/kind").and_then(Value::as_str) {
            // v2 follows each step with phase{tool}; the step already said Tool.
            match phase(kind) {
                Some(Phase::Tool) if st.tool.is_some() => {}
                Some(p) => {
                    let _ = draft.send(DraftFrame::Phase(p)).await;
                }
                None => {}
            }
        } else if let Some(step) = step {
            let name = step.get("name").and_then(Value::as_str).unwrap_or("?");
            // Steps count up from 1; one seen before (its done event) never reopens.
            if let Some(n) = n.filter(|&n| n > st.last_step) {
                st.last_step = n;
                st.tool = Some((n, intern(format!("tool:{name}")), now));
                let _ = draft.send(DraftFrame::Phase(Phase::Tool)).await;
            }
        } else if let Some(why) = e.get("ask").and_then(Value::as_str) {
            let q = Question {
                run: RunId(format!("v2-{}", turn.received_at)),
                text: why.to_owned(),
                detail: None,
            };
            let allowed = match self.ask.get() {
                Some(ask) => ask.confirm(&turn.origin, &q, cancel.clone()).await,
                None => false,
            };
            if cancel.is_cancelled() {
                return Err(BrainError::Cancelled);
            }
            self.post(url, token, "api/approve", json!({ "allowed": allowed }))
                .await;
        } else if e.get("paused").is_some() || e.get("paid").is_some() {
            // D212: a yes to spending money is never sent.
            self.post(url, token, "api/approve", json!({ "allowed": false }))
                .await;
            st.refused_paid = true;
        } else if let Some(err) = e.get("error") {
            let said = err.as_str().map_or_else(|| err.to_string(), str::to_owned);
            return Err(BrainError::Unavailable(said));
        } else if let Some(to) = e.pointer("/switch/to").and_then(Value::as_str) {
            st.model = Some(to.to_owned());
        } else if let Some(m) = e.pointer("/done/model").and_then(Value::as_str) {
            if st.model.is_none() && !m.is_empty() {
                st.model = Some(m.to_owned());
            }
        }
        Ok(())
    }

    fn save(&self, turn: &Turn, st: &Run) -> Result<(), BrainError> {
        let task = |content: Content| {
            let mut extra = serde_json::Map::new();
            extra.insert("lane".into(), json!("task"));
            MessageBody {
                content,
                calls: None,
                call_id: None,
                provider: None,
                notes: None,
                bad: None,
                stopped: None,
                typed: None,
                extra,
            }
        };
        self.store
            .append(turn.session, Role::User, None, &task(turn.content.clone()))
            .map_err(store_err)?;
        self.store
            .append(
                turn.session,
                Role::Assistant,
                st.model.as_deref(),
                &task(Content::Text(st.text.clone())),
            )
            .map_err(store_err)?;
        Ok(())
    }
}

/// What one reply has gathered so far.
struct Run {
    url: String,
    token: String,
    /// When `reply` was handed the turn; every span's `start` is measured from it.
    began: Instant,
    sent: Instant,
    first: Option<Instant>,
    text: String,
    model: Option<String>,
    spans: Vec<Span>,
    /// The open tool step: (n, span name, start).
    tool: Option<(i64, &'static str, Instant)>,
    /// The highest step n opened so far.
    last_step: i64,
    refused_paid: bool,
}

#[async_trait::async_trait]
impl Brain for V2Bridge {
    async fn reply(
        &self,
        turn: Turn,
        draft: DraftSink,
        cancel: CancellationToken,
    ) -> Result<Reply, BrainError> {
        let began = Instant::now();
        let Some((url, token)) = self.conn() else {
            return Err(BrainError::Unavailable(STARTING.into()));
        };
        let text = self.with_context(&turn)?;
        let body = json!({ "text": text, "files": uploads(&turn.content) });
        let sent = Instant::now();
        let Some(resp) = self.post_chat(&url, &token, &body, &cancel).await? else {
            return Err(BrainError::Cancelled);
        };
        let mut st = Run {
            url,
            token,
            began,
            sent,
            first: None,
            text: String::new(),
            model: None,
            spans: Vec::new(),
            tool: None,
            last_step: 0,
            refused_paid: false,
        };
        let out = self.stream(&mut st, resp, &turn, &draft, &cancel).await;
        if let Err(BrainError::Cancelled) = out {
            // CH-08: the gateway sends the steering message as the next turn.
            self.post(&st.url, &st.token, "api/stop", json!({})).await;
        }
        out?;
        if let Some((_, name, start)) = st.tool.take() {
            st.spans.push(Span::since(name, began, start));
        }
        st.spans.push(Span::since("bridge", began, sent));
        if st.refused_paid {
            if !st.text.is_empty() {
                st.text.push(' ');
            }
            st.text.push_str(FREE_ONLY);
        }
        self.save(&turn, &st)?;
        Ok(Reply {
            text: st.text,
            files: Vec::new(),
            lane: Lane::Task,
            model: st.model,
            spans: st.spans,
        })
    }
}

fn store_err(e: alexia_store::Error) -> BrainError {
    BrainError::Other(e.into())
}

fn is_task(m: &alexia_store::Message) -> bool {
    m.body.extra.get("lane").and_then(Value::as_str) == Some("task")
}

/// The turn's image parts as v2 `Upload { name, data, type }` (base64 without the prefix).
fn uploads(c: &Content) -> Vec<Value> {
    let Content::Parts(parts) = c else {
        return Vec::new();
    };
    parts
        .iter()
        .filter_map(|p| match p {
            Part::Image { url } => url.strip_prefix("data:")?.split_once(";base64,"),
            Part::Text { .. } => None,
        })
        .enumerate()
        .map(|(i, (mime, data))| {
            let ext = mime.rsplit('/').next().unwrap_or("bin");
            json!({ "name": format!("image-{}.{ext}", i + 1), "data": data, "type": mime })
        })
        .collect()
}

fn phase(kind: &str) -> Option<Phase> {
    Some(match kind {
        "reading" | "choosing" => Phase::Choosing,
        "asking" => Phase::Asking,
        "thinking" => Phase::Thinking,
        "writing" => Phase::Writing,
        "tool" => Phase::Tool,
        "retrying" => Phase::Retrying,
        "backup" => Phase::Backup,
        _ => return None,
    })
}

/// `Span.name` is `&'static str`; each distinct tool name is leaked once.
// ponytail: grows with distinct tool names (a few dozen); fine for one phase.
fn intern(name: String) -> &'static str {
    static NAMES: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    let mut names = NAMES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if let Some(n) = names.get(name.as_str()) {
        return n;
    }
    let leaked: &'static str = Box::leak(name.into_boxed_str());
    names.insert(leaked);
    leaked
}

/// `… is at http://127.0.0.1:<port>/` → the URL.
fn url_in(line: &str) -> Option<String> {
    const AT: &str = "is at http://127.0.0.1:";
    let rest = &line[line.find(AT)? + AT.len()..];
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    (digits > 0 && rest[digits..].starts_with('/'))
        .then(|| format!("http://127.0.0.1:{}/", &rest[..digits]))
}

/// The first lowercase UUID in `s`.
fn find_uuid(s: &str) -> Option<&str> {
    let b = s.as_bytes();
    (0..b.len().saturating_sub(35)).find_map(|i| {
        let w = &b[i..i + 36];
        let ok = w.iter().enumerate().all(|(j, &c)| match j {
            8 | 13 | 18 | 23 => c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(&c),
        });
        ok.then(|| &s[i..i + 36])
    })
}

/// `GET <url>` and the token v2 put in place of `__TOKEN__`.
async fn fetch_token(http: &reqwest::Client, url: &str) -> Option<String> {
    let page = http
        .get(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    find_uuid(&page).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alexia_core::Origin;
    use alexia_store::SessionId;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::mpsc;

    const TOKEN: &str = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";

    enum Step {
        /// One `data:` event (JSON text).
        Send(&'static str),
        /// Hold the stream until the fake has received a request for this path.
        Wait(&'static str),
        /// Hold the stream this many ms.
        Pause(u64),
    }
    use Step::{Pause, Send, Wait};

    #[derive(Default)]
    struct Opts {
        /// Statuses for the first `/api/chat` requests, in order; then 200.
        first: Vec<u16>,
        /// Every `/api/chat` gets this status.
        always: Option<u16>,
        /// Hold `/api/chat`'s response headers until a request for this path arrives.
        headers_after: Option<&'static str>,
    }

    #[derive(Clone, Default)]
    struct Log(Arc<Mutex<Vec<(String, String)>>>);
    impl Log {
        fn all(&self) -> Vec<(String, String)> {
            self.0.lock().unwrap().clone()
        }
        fn bodies(&self, path: &str) -> Vec<Value> {
            self.all()
                .into_iter()
                .filter(|(p, _)| p == path)
                .map(|(_, b)| serde_json::from_str(&b).unwrap_or(Value::Null))
                .collect()
        }
        fn count(&self, path: &str) -> usize {
            self.all().iter().filter(|(p, _)| p == path).count()
        }
    }

    async fn fake(script: Vec<Step>, opts: Opts) -> (String, Log) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let log = Log::default();
        let script = Arc::new(script);
        let opts = Arc::new(opts);
        let chats = Arc::new(AtomicUsize::new(0));
        let l = log.clone();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let (log, script, opts, chats) =
                    (l.clone(), script.clone(), opts.clone(), chats.clone());
                tokio::spawn(serve(sock, log, script, opts, chats));
            }
        });
        (url, log)
    }

    async fn serve(
        mut sock: TcpStream,
        log: Log,
        script: Arc<Vec<Step>>,
        opts: Arc<Opts>,
        chats: Arc<AtomicUsize>,
    ) {
        let mut buf = Vec::new();
        let head_end = loop {
            let mut b = [0u8; 4096];
            let n = sock.read(&mut b).await.unwrap_or(0);
            if n == 0 {
                return;
            }
            buf.extend_from_slice(&b[..n]);
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).to_lowercase();
        let path = head.split_whitespace().nth(1).unwrap_or("").to_owned();
        let header = |name: &str| {
            head.lines()
                .find_map(|l| l.strip_prefix(&format!("{name}: ")))
                .map(|v| v.trim().to_owned())
        };
        let len: usize = header("content-length")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        while buf.len() < head_end + len {
            let mut b = [0u8; 4096];
            let n = sock.read(&mut b).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&b[..n]);
        }
        let body = String::from_utf8_lossy(&buf[head_end..]).into_owned();
        log.0.lock().unwrap().push((path.clone(), body));

        let plain = |status: &str, body: &str| {
            format!(
                "HTTP/1.1 {status}\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
        };
        if path == "/" {
            let page = format!("<html><script>window.token = \"{TOKEN}\"</script></html>");
            let _ = sock.write_all(plain("200 OK", &page).as_bytes()).await;
            return;
        }
        if header("x-alexia-token").as_deref() != Some(TOKEN)
            || !header("host").unwrap_or_default().starts_with("127.0.0.1")
        {
            let _ = sock
                .write_all(plain("403 Forbidden", "not for you").as_bytes())
                .await;
            return;
        }
        if path != "/api/chat" {
            let _ = sock
                .write_all(plain("200 OK", "{\"ok\":true}").as_bytes())
                .await;
            return;
        }
        let i = chats.fetch_add(1, Ordering::SeqCst);
        let status = opts
            .always
            .or_else(|| opts.first.get(i).copied())
            .unwrap_or(200);
        if status != 200 {
            let _ = sock
                .write_all(plain(&format!("{status} No"), "{}").as_bytes())
                .await;
            return;
        }
        if let Some(p) = opts.headers_after {
            let until = Instant::now() + Duration::from_secs(30);
            while log.count(p) == 0 && Instant::now() < until {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        let _ = sock
            .write_all(
                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
            )
            .await;
        for step in script.iter() {
            match step {
                Send(event) => {
                    let _ = sock
                        .write_all(format!("data: {event}\n\n").as_bytes())
                        .await;
                    let _ = sock.flush().await;
                }
                Pause(ms) => tokio::time::sleep(Duration::from_millis(*ms)).await,
                Wait(p) => {
                    let until = Instant::now() + Duration::from_secs(30);
                    while log.count(p) == 0 && Instant::now() < until {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                }
            }
        }
    }

    fn attached(url: &str) -> (Arc<V2Bridge>, Arc<Store>, SessionId) {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let session = store.create_session(None).unwrap();
        let cfg = V2Config {
            root: PathBuf::from("no-such-v2-checkout"),
            node: PathBuf::from("no-such-node"),
            data_name: DEFAULT_DATA_NAME.into(),
            attach: Some((url.to_owned(), TOKEN.to_owned())),
        };
        (Arc::new(V2Bridge::new(cfg, store.clone())), store, session)
    }

    fn turn(session: SessionId, text: &str) -> Turn {
        Turn {
            session,
            origin: Origin::Desktop,
            content: Content::Text(text.into()),
            received_at: alexia_store::now_ms(),
        }
    }

    async fn ask_once(bridge: &V2Bridge, t: Turn) -> (Result<Reply, BrainError>, Vec<DraftFrame>) {
        let (tx, mut rx) = mpsc::channel(256);
        let out = bridge.reply(t, tx, CancellationToken::new()).await;
        let mut frames = Vec::new();
        while let Ok(f) = rx.try_recv() {
            frames.push(f);
        }
        (out, frames)
    }

    struct FakeAsk {
        says: bool,
        asked: Mutex<Vec<String>>,
    }
    #[async_trait::async_trait]
    impl Ask for FakeAsk {
        async fn confirm(&self, _: &Origin, q: &Question, _: CancellationToken) -> bool {
            self.asked.lock().unwrap().push(q.text.clone());
            self.says
        }
    }
    fn asker(says: bool) -> Arc<FakeAsk> {
        Arc::new(FakeAsk {
            says,
            asked: Mutex::new(Vec::new()),
        })
    }

    fn node_on_path() -> Option<PathBuf> {
        let name = format!("node{}", std::env::consts::EXE_SUFFIX);
        std::env::split_paths(&std::env::var_os("PATH")?)
            .map(|d| d.join(&name))
            .find(|p| p.is_file())
    }

    /// A temp "v2 checkout" whose entry.js serves the token page, prints the line, records each
    /// start (with `ALEXIA_DATA_NAME`) in `starts.txt`, and exits after `exit_ms`.
    fn fake_checkout(tag: &str, exit_ms: u64) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "alexia-bridge-{tag}-{}-{}-{}",
            std::process::id(),
            alexia_store::now_ms(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let src = root.join("packages/core/dist/src");
        std::fs::create_dir_all(&src).unwrap();
        let js = format!(
            r#"const http = require('node:http')
const fs = require('node:fs')
fs.appendFileSync('starts.txt', (process.env.ALEXIA_DATA_NAME || '') + '\n')
const s = http.createServer((q, r) => r.end('<script>const token = "{TOKEN}"</script>'))
s.listen(0, '127.0.0.1', () => {{
  console.log(`Alexia (interaction) is at http://127.0.0.1:${{s.address().port}}/`)
  setTimeout(() => process.exit(0), {exit_ms})
}})
"#
        );
        std::fs::write(src.join("entry.js"), js).unwrap();
        root
    }

    fn spawned(root: &std::path::Path, node: PathBuf) -> Arc<V2Bridge> {
        let cfg = V2Config {
            root: root.to_path_buf(),
            node,
            data_name: "AlexiaBridgeTest".into(),
            attach: None,
        };
        Arc::new(V2Bridge::new(
            cfg,
            Arc::new(Store::open_in_memory().unwrap()),
        ))
    }

    /// The two tests that spawn node. Serialized: `tracing` caches a callsite's interest, and
    /// the same `info!` hit on another thread with no subscriber would hide it from the capture.
    static NODE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    async fn until(secs: u64, mut ok: impl FnMut() -> bool) -> bool {
        let end = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < end {
            if ok() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        ok()
    }

    fn body(text: &str) -> MessageBody {
        MessageBody {
            content: Content::Text(text.into()),
            calls: None,
            call_id: None,
            provider: None,
            notes: None,
            bad: None,
            stopped: None,
            typed: None,
            extra: Default::default(),
        }
    }

    #[tokio::test]
    async fn attach_mode_reads_no_child() {
        let (url, _log) = fake(vec![Send(r#"{"delta":"hi"}"#)], Opts::default()).await;
        let (bridge, _, session) = attached(&url);
        assert!(bridge.ready(), "attached is ready without a child");
        let cancel = CancellationToken::new();
        let (b, c) = (bridge.clone(), cancel.clone());
        let running = tokio::spawn(async move { b.run(c).await });
        // A spawn attempt would fail (no checkout, no such node) and clear the connection.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert!(bridge.ready(), "attach mode never tried to start a child");
        let (out, _) = ask_once(&bridge, turn(session, "good morning")).await;
        assert_eq!(out.unwrap().text, "hi");
        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(10), running)
            .await
            .expect("run returns on cancel")
            .unwrap();
    }

    #[tokio::test]
    async fn deltas_become_draft_and_reply() {
        let (url, log) = fake(
            vec![
                Send(r#"{"phase":{"kind":"writing"}}"#),
                Send(r#"{"delta":"Hel"}"#),
                Send(r#"{"delta":"lo"}"#),
                Send(r#"{"restart":true}"#),
                Send(r#"{"note":"ignored"}"#),
                Send(r#"{"switch":{"from":["a"],"to":"model-b","reasons":[],"says":"x"}}"#),
                Send(r#"{"delta":"Hello "}"#),
                Send(r#"{"delta":"there"}"#),
                Send(r#"{"done":{"model":"model-z","steps":0}}"#),
            ],
            Opts::default(),
        )
        .await;
        let (bridge, store, session) = attached(&url);
        let (out, frames) = ask_once(&bridge, turn(session, "say hello")).await;
        let reply = out.unwrap();
        assert_eq!(reply.text, "Hello there");
        assert_eq!(reply.model.as_deref(), Some("model-b"));
        assert_eq!(reply.lane, Lane::Task);
        let deltas: Vec<String> = frames
            .iter()
            .filter_map(|f| match f {
                DraftFrame::Delta(d) => Some(d.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(deltas, ["Hel", "lo", "Hello ", "there"]);
        assert!(frames.iter().any(|f| matches!(f, DraftFrame::Restart)));
        let names: Vec<&str> = reply.spans.iter().map(|s| s.name).collect();
        assert!(names.contains(&"bridge") && names.contains(&"bridge-first-byte"));
        assert_eq!(log.bodies("/api/chat")[0]["text"], "say hello");
        let history = store.history(session, None).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].role, Role::User);
        assert_eq!(history[0].body.content, Content::Text("say hello".into()));
        assert_eq!(history[1].body.content, Content::Text("Hello there".into()));
        assert_eq!(history[1].model.as_deref(), Some("model-b"));
        assert!(history.iter().all(is_task));
    }

    #[tokio::test]
    async fn images_go_as_uploads() {
        let (url, log) = fake(vec![Send(r#"{"delta":"a cat"}"#)], Opts::default()).await;
        let (bridge, _, session) = attached(&url);
        let mut t = turn(session, "");
        t.content = Content::Parts(vec![
            Part::Text {
                text: "what is this".into(),
            },
            Part::Image {
                url: "data:image/png;base64,iVBORw0KGgo=".into(),
            },
        ]);
        ask_once(&bridge, t).await.0.unwrap();
        let sent = &log.bodies("/api/chat")[0];
        assert_eq!(sent["text"], "what is this");
        assert_eq!(
            sent["files"],
            json!([{ "name": "image-1.png", "data": "iVBORw0KGgo=", "type": "image/png" }])
        );
    }

    #[tokio::test]
    async fn phase_and_step_frames_map() {
        let (url, _log) = fake(
            vec![
                Send(r#"{"phase":{"kind":"reading"}}"#),
                Send(r#"{"phase":{"kind":"choosing"}}"#),
                Send(r#"{"phase":{"kind":"thinking"}}"#),
                Send(r#"{"phase":{"kind":"retrying"}}"#),
                Send(r#"{"phase":{"kind":"backup"}}"#),
                // As agent.ts sends a step: step, phase{tool}, progress, then done (same n).
                Send(r#"{"step":{"n":1,"name":"web_search","args":{}}}"#),
                Send(r#"{"phase":{"kind":"tool","name":"web_search"}}"#),
                Pause(150),
                Send(r#"{"step":{"n":1,"name":"web_search","progress":0.5}}"#),
                Pause(150),
                Send(r#"{"step":{"n":1,"name":"web_search","text":"found"}}"#),
                Send(r#"{"phase":{"kind":"writing"}}"#),
                Send(r#"{"step":{"n":2,"name":"read_file","args":{}}}"#),
                Send(r#"{"phase":{"kind":"tool","name":"read_file"}}"#),
                Pause(150),
                Send(r#"{"step":{"n":2,"name":"read_file","text":"done"}}"#),
                Send(r#"{"delta":"ok"}"#),
            ],
            Opts::default(),
        )
        .await;
        let (bridge, _, session) = attached(&url);
        let (out, frames) = ask_once(&bridge, turn(session, "search")).await;
        let reply = out.unwrap();
        let phases: Vec<Phase> = frames
            .iter()
            .filter_map(|f| match f {
                DraftFrame::Phase(p) => Some(*p),
                _ => None,
            })
            .collect();
        use Phase::*;
        assert_eq!(
            phases,
            [Choosing, Choosing, Thinking, Retrying, Backup, Tool, Writing, Tool]
        );
        let tools: Vec<&Span> = reply
            .spans
            .iter()
            .filter(|s| s.name.starts_with("tool:"))
            .collect();
        let names: Vec<&str> = tools.iter().map(|s| s.name).collect();
        assert_eq!(names, ["tool:web_search", "tool:read_file"]);
        // The script holds 300 ms and 150 ms inside the steps; generous lower bounds.
        let took: Vec<u32> = tools.iter().map(|s| s.ms).collect();
        assert!(
            took[0] >= 200 && took[1] >= 100,
            "tool spans too short: {took:?}"
        );
    }

    #[tokio::test]
    async fn spans_are_offsets_from_the_turn() {
        let (url, _log) = fake(
            vec![
                Send(r#"{"step":{"n":1,"name":"web_search","args":{}}}"#),
                Pause(100),
                Send(r#"{"step":{"n":1,"name":"web_search","text":"found"}}"#),
                Send(r#"{"delta":"ok"}"#),
            ],
            Opts::default(),
        )
        .await;
        let (bridge, _, session) = attached(&url);
        let reply = ask_once(&bridge, turn(session, "search")).await.0.unwrap();
        let names: Vec<&str> = reply.spans.iter().map(|s| s.name).collect();
        assert_eq!(names, ["tool:web_search", "bridge-first-byte", "bridge"]);
        assert!(
            reply.spans.iter().all(|s| s.start < 60_000),
            "a span start is not an offset from the turn: {:?}",
            reply.spans
        );
        let bridge_span = reply.spans.iter().find(|s| s.name == "bridge").unwrap();
        assert!(bridge_span.start < 1_000, "{bridge_span:?}");
    }

    #[tokio::test]
    async fn ask_goes_to_asker_and_answer_is_posted() {
        let script = || {
            vec![
                Send(r#"{"ask":"Delete report.txt?"}"#),
                Wait("/api/approve"),
                Send(r#"{"delta":"done"}"#),
            ]
        };
        let (url, log) = fake(script(), Opts::default()).await;
        let (bridge, _, session) = attached(&url);
        let yes = asker(true);
        bridge.set_ask(yes.clone());
        let (out, _) = ask_once(&bridge, turn(session, "clean up")).await;
        assert_eq!(out.unwrap().text, "done");
        assert_eq!(*yes.asked.lock().unwrap(), ["Delete report.txt?"]);
        assert_eq!(log.bodies("/api/approve"), [json!({ "allowed": true })]);

        // No asker set yet: the answer is no.
        let (url, log) = fake(script(), Opts::default()).await;
        let (bridge, _, session) = attached(&url);
        let (out, _) = ask_once(&bridge, turn(session, "clean up")).await;
        assert!(out.is_ok());
        assert_eq!(log.bodies("/api/approve"), [json!({ "allowed": false })]);
    }

    #[tokio::test]
    async fn paid_is_always_refused() {
        let (url, log) = fake(
            vec![
                Send(r#"{"delta":"Working."}"#),
                Send(r#"{"paid":"This answer costs $0.02."}"#),
                Wait("/api/approve"),
                Send(r#"{"paused":"The free models are done.","daily":0}"#),
            ],
            Opts::default(),
        )
        .await;
        let (bridge, _, session) = attached(&url);
        let yes = asker(true);
        bridge.set_ask(yes.clone());
        let (out, _) = ask_once(&bridge, turn(session, "big job")).await;
        let reply = out.unwrap();
        assert_eq!(reply.text, format!("Working. {FREE_ONLY}"));
        assert!(
            yes.asked.lock().unwrap().is_empty(),
            "spending is never asked"
        );
        let approvals = log.bodies("/api/approve");
        assert_eq!(approvals.len(), 2);
        assert!(approvals.iter().all(|a| *a == json!({ "allowed": false })));
    }

    #[tokio::test]
    async fn busy_423_retries_then_sentence() {
        let (url, log) = fake(
            vec![Send(r#"{"delta":"after the wait"}"#)],
            Opts {
                first: vec![423, 423],
                always: None,
                ..Opts::default()
            },
        )
        .await;
        let (bridge, _, session) = attached(&url);
        let (out, _) = ask_once(&bridge, turn(session, "go")).await;
        assert_eq!(out.unwrap().text, "after the wait");
        assert_eq!(log.count("/api/chat"), 3);

        let (url, log) = fake(
            vec![],
            Opts {
                first: vec![],
                always: Some(423),
                ..Opts::default()
            },
        )
        .await;
        let (bridge, store, session) = attached(&url);
        let began = Instant::now();
        let (out, _) = ask_once(&bridge, turn(session, "go")).await;
        match out {
            Err(BrainError::Unavailable(s)) => assert_eq!(s, BUSY),
            other => panic!("expected the busy sentence, got {other:?}"),
        }
        assert!(began.elapsed() >= Duration::from_secs(9));
        // Every 500 ms for 10 s; a loaded machine may fit fewer in.
        assert!(log.count("/api/chat") >= 3, "retried");
        assert!(store.history(session, None).unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancel_posts_stop() {
        let (url, log) = fake(
            vec![Send(r#"{"delta":"partial"}"#), Wait("/api/stop")],
            Opts::default(),
        )
        .await;
        let (bridge, store, session) = attached(&url);
        let (tx, mut rx) = mpsc::channel(16);
        let cancel = CancellationToken::new();
        let (b, c) = (bridge.clone(), cancel.clone());
        let t = turn(session, "long task");
        let job = tokio::spawn(async move { b.reply(t, tx, c).await });
        let first = tokio::time::timeout(Duration::from_secs(20), rx.recv()).await;
        assert!(matches!(first, Ok(Some(DraftFrame::Delta(_)))));
        cancel.cancel();
        let out = tokio::time::timeout(Duration::from_secs(20), job)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(out, Err(BrainError::Cancelled)));
        assert_eq!(log.count("/api/stop"), 1);
        assert!(
            store.history(session, None).unwrap().is_empty(),
            "nothing stored"
        );
    }

    #[tokio::test]
    async fn cancel_while_waiting_for_headers_posts_stop() {
        let opts = Opts {
            headers_after: Some("/api/stop"),
            ..Opts::default()
        };
        let (url, log) = fake(vec![Send(r#"{"delta":"late"}"#)], opts).await;
        let (bridge, store, session) = attached(&url);
        let (tx, _rx) = mpsc::channel(16);
        let cancel = CancellationToken::new();
        let (b, c) = (bridge.clone(), cancel.clone());
        let t = turn(session, "long task");
        let job = tokio::spawn(async move { b.reply(t, tx, c).await });
        assert!(until(20, || log.count("/api/chat") == 1).await, "chat sent");
        cancel.cancel();
        let out = tokio::time::timeout(Duration::from_secs(20), job)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(out, Err(BrainError::Cancelled)));
        assert_eq!(log.count("/api/stop"), 1);
        assert!(store.history(session, None).unwrap().is_empty());
    }

    #[tokio::test]
    async fn error_event_is_the_sentence_and_nothing_is_stored() {
        let (url, _log) = fake(
            vec![
                Send(r#"{"delta":"half"}"#),
                Send(r#"{"error":"No model could answer."}"#),
            ],
            Opts::default(),
        )
        .await;
        let (bridge, store, session) = attached(&url);
        let (out, _) = ask_once(&bridge, turn(session, "x")).await;
        match out {
            Err(BrainError::Unavailable(s)) => assert_eq!(s, "No model could answer."),
            other => panic!("expected the error sentence, got {other:?}"),
        }
        assert!(store.history(session, None).unwrap().is_empty());
    }

    #[tokio::test]
    async fn token_from_index_page() {
        let (url, _log) = fake(vec![], Opts::default()).await;
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        assert_eq!(fetch_token(&http, &url).await.as_deref(), Some(TOKEN));
        assert_eq!(find_uuid("x = '__TOKEN__'"), None);
        assert_eq!(find_uuid(&format!("a{TOKEN}b")), Some(TOKEN));
        assert_eq!(
            url_in("Alexia (interaction) is at http://127.0.0.1:5173/").as_deref(),
            Some("http://127.0.0.1:5173/")
        );
        assert_eq!(url_in("Alexia is at http://127.0.0.1:/"), None);
        assert_eq!(url_in("Alexia is at http://example.com:80/"), None);
    }

    #[derive(Clone, Default)]
    struct Logs(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Logs {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Logs {
        fn text(&self) -> String {
            String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
        }
    }

    #[tokio::test]
    async fn token_never_logged() {
        let _node = NODE.lock().await;
        let logs = Logs::default();
        let w = logs.clone();
        let sub = tracing_subscriber::fmt()
            .with_writer(move || w.clone())
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .finish();
        let _guard = tracing::subscriber::set_default(sub);

        // The attached path: a refused chat logs a warning.
        let (url, _log) = fake(
            vec![],
            Opts {
                first: vec![],
                always: Some(500),
                ..Opts::default()
            },
        )
        .await;
        let (bridge, _, session) = attached(&url);
        assert!(ask_once(&bridge, turn(session, "x")).await.0.is_err());
        assert!(logs.text().contains("v2 core answered /api/chat with 500"));

        // The spawn path, where the token is actually read.
        match node_on_path() {
            Some(node) => {
                let root = fake_checkout("log", 60_000);
                let bridge = spawned(&root, node);
                let cancel = CancellationToken::new();
                let (b, c) = (bridge.clone(), cancel.clone());
                let running = tokio::spawn(async move { b.run(c).await });
                assert!(until(40, || bridge.ready()).await, "fake v2 came up");
                cancel.cancel();
                let _ = tokio::time::timeout(Duration::from_secs(20), running).await;
                let _ = std::fs::remove_dir_all(&root);
                let text = logs.text();
                assert!(text.contains("v2 core is up at"), "{text}");
                assert!(
                    text.contains("is at http://127.0.0.1:"),
                    "stdout line logged"
                );
            }
            None => eprintln!("token_never_logged: node is not on PATH; spawn path not run"),
        }
        let text = logs.text();
        assert_eq!(find_uuid(&text), None, "a token was logged: {text}");
    }

    #[tokio::test]
    async fn chat_context_is_prefixed_once() {
        let (url, log) = fake(vec![Send(r#"{"delta":"ok"}"#)], Opts::default()).await;
        let (bridge, store, session) = attached(&url);
        let chat = |role: Role, text: &str| {
            store.append(session, role, None, &body(text)).unwrap();
        };
        let long = "y".repeat(400);
        for (i, said) in ["one", "two", "three", "four", "five", "six", "seven"]
            .iter()
            .enumerate()
        {
            chat(
                if i % 2 == 0 {
                    Role::User
                } else {
                    Role::Assistant
                },
                said,
            );
        }
        chat(Role::Assistant, &long);

        ask_once(&bridge, turn(session, "task one"))
            .await
            .0
            .unwrap();
        ask_once(&bridge, turn(session, "task two"))
            .await
            .0
            .unwrap();
        chat(Role::User, "hi again");
        ask_once(&bridge, turn(session, "task three"))
            .await
            .0
            .unwrap();

        let texts: Vec<String> = log
            .bodies("/api/chat")
            .iter()
            .map(|b| b["text"].as_str().unwrap().to_owned())
            .collect();
        let cut = "y".repeat(300);
        assert_eq!(
            texts[0],
            format!(
                "{CONTEXT_HEAD}You: three\nAlexia: four\nYou: five\nAlexia: six\nYou: seven\nAlexia: {cut}\n\ntask one"
            )
        );
        assert_eq!(texts[1], "task two", "no chat turns since the last task");
        assert_eq!(
            texts[2],
            format!("{CONTEXT_HEAD}You: hi again\n\ntask three")
        );
        // v3 keeps what was typed, not the quoted context.
        let history = store.history(session, None).unwrap();
        assert_eq!(history[8].body.content, Content::Text("task one".into()));
    }

    #[tokio::test]
    async fn child_restarts_after_exit() {
        let _node = NODE.lock().await;
        let Some(node) = node_on_path() else {
            eprintln!("child_restarts_after_exit: skipped, node is not on PATH");
            return;
        };
        let root = fake_checkout("restart", 1000);
        let bridge = spawned(&root, node);
        let cancel = CancellationToken::new();
        let (b, c) = (bridge.clone(), cancel.clone());
        let running = tokio::spawn(async move { b.run(c).await });
        let starts = root.join("starts.txt");
        let count = || {
            std::fs::read_to_string(&starts)
                .map(|s| s.lines().count())
                .unwrap_or(0)
        };
        assert!(
            until(40, || bridge.ready()).await,
            "first start became ready"
        );
        assert!(
            until(40, || count() >= 2 && bridge.ready()).await,
            "restarted after exit; starts = {}",
            count()
        );
        let recorded = std::fs::read_to_string(&starts).unwrap();
        assert!(
            recorded.lines().all(|l| l == "AlexiaBridgeTest"),
            "{recorded}"
        );
        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(20), running)
            .await
            .expect("run returns on cancel")
            .unwrap();
        assert!(!bridge.ready());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// By hand, with a built v2 checkout:
    /// `ALEXIA_V2_ROOT=<checkout> cargo test -p alexia-hub bridge -- --ignored live_v2 --nocapture`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs ALEXIA_V2_ROOT pointing at a built v2 checkout"]
    async fn live_v2() {
        let cfg = V2Config::from_env().expect("set ALEXIA_V2_ROOT");
        let store = Arc::new(Store::open_in_memory().unwrap());
        let session = store.create_session(None).unwrap();
        let bridge = Arc::new(V2Bridge::new(cfg, store));
        let cancel = CancellationToken::new();
        let (b, c) = (bridge.clone(), cancel.clone());
        let running = tokio::spawn(async move { b.run(c).await });
        assert!(until(120, || bridge.ready()).await, "v2 core came up");
        let (tx, mut rx) = mpsc::channel(256);
        let printer = tokio::spawn(async move {
            use std::io::Write;
            while let Some(f) = rx.recv().await {
                match f {
                    DraftFrame::Delta(d) => print!("{d}"),
                    other => print!("[{other:?}]"),
                }
                let _ = std::io::stdout().flush();
            }
        });
        let reply = bridge
            .reply(
                turn(session, "list the plugins you have"),
                tx,
                CancellationToken::new(),
            )
            .await;
        let _ = printer.await;
        println!();
        cancel.cancel();
        let _ = running.await;
        let reply = reply.expect("v2 answered");
        println!("model: {:?}\nspans: {:?}", reply.model, reply.spans);
        assert!(!reply.text.trim().is_empty());
    }
}
