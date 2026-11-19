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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use alexia_core::{
    Ask, Brain, BrainError, DraftFrame, DraftSink, Lane, Phase, Question, Reply, RunId, Span, Turn,
};
use alexia_store::{Content, MessageBody, Ms, Part, Role, Store};
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
            return Err(format!("v2 core is not built: {} is missing.", entry.display()));
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
        let typed = text_of(&turn.content);
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
                let said: String = text_of(&m.body.content).chars().take(CONTEXT_CHARS).collect();
                Some(format!("{who}: {said}"))
            })
            .collect();
        if lines.is_empty() {
            return Ok(typed);
        }
        let last = &lines[lines.len().saturating_sub(CONTEXT_TURNS)..];
        Ok(format!("{CONTEXT_HEAD}{}\n\n{typed}", last.join("\n")))
    }

    /// POST `/api/chat`, retrying a 423 for up to 10 s. `None` when cancelled meanwhile.
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
                _ = cancel.cancelled() => return Ok(None),
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
        let now = now_ms();
        let step = e.get("step");
        let n = step.and_then(|s| s.get("n")).and_then(Value::as_i64);
        // A tool span runs from its step's start to the next event that is not that step.
        if let Some((open, name, start)) = st.tool {
            if n != Some(open) {
                st.spans.push(span(name, start, now));
                st.tool = None;
            }
        }
        let (url, token) = (&st.url, &st.token);
        if let Some(d) = e.get("delta").and_then(Value::as_str) {
            if st.first.is_none() {
                st.first = Some(now);
                st.spans.push(span("bridge-first-byte", st.sent, now));
            }
            st.text.push_str(d);
            let _ = draft.send(DraftFrame::Delta(d.to_owned())).await;
        } else if e.get("restart").is_some() {
            st.text.clear();
            let _ = draft.send(DraftFrame::Restart).await;
        } else if let Some(kind) = e.pointer("/phase/kind").and_then(Value::as_str) {
            if let Some(p) = phase(kind) {
                let _ = draft.send(DraftFrame::Phase(p)).await;
            }
        } else if let Some(step) = step {
            let name = step.get("name").and_then(Value::as_str).unwrap_or("?");
            if st.tool.is_none() {
                if let Some(n) = n {
                    st.tool = Some((n, intern(format!("tool:{name}")), now));
                    let _ = draft.send(DraftFrame::Phase(Phase::Tool)).await;
                }
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
    sent: Ms,
    first: Option<Ms>,
    text: String,
    model: Option<String>,
    spans: Vec<Span>,
    /// The open tool step: (n, span name, start).
    tool: Option<(i64, &'static str, Ms)>,
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
        let Some((url, token)) = self.conn() else {
            return Err(BrainError::Unavailable(STARTING.into()));
        };
        let text = self.with_context(&turn)?;
        let body = json!({ "text": text, "files": uploads(&turn.content) });
        let sent = now_ms();
        let Some(resp) = self.post_chat(&url, &token, &body, &cancel).await? else {
            // Nothing of ours is running in v2, so there is nothing to stop.
            return Err(BrainError::Cancelled);
        };
        let mut st = Run {
            url,
            token,
            sent,
            first: None,
            text: String::new(),
            model: None,
            spans: Vec::new(),
            tool: None,
            refused_paid: false,
        };
        let out = self.stream(&mut st, resp, &turn, &draft, &cancel).await;
        if let Err(BrainError::Cancelled) = out {
            // CH-08: the gateway sends the steering message as the next turn.
            self.post(&st.url, &st.token, "api/stop", json!({})).await;
        }
        out?;
        let end = now_ms();
        if let Some((_, name, start)) = st.tool.take() {
            st.spans.push(span(name, start, end));
        }
        st.spans.push(span("bridge", sent, end));
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

fn text_of(c: &Content) -> String {
    match c {
        Content::Text(t) => t.clone(),
        Content::Parts(parts) => parts
            .iter()
            .filter_map(|p| match p {
                Part::Text { text } => Some(text.as_str()),
                Part::Image { .. } => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
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

fn span(name: &'static str, start: Ms, end: Ms) -> Span {
    Span {
        name,
        start,
        ms: u32::try_from((end - start).max(0)).unwrap_or(u32::MAX),
    }
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

fn now_ms() -> Ms {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as Ms)
}
