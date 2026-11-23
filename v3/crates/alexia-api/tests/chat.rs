// SPDX-License-Identifier: AGPL-3.0-only
//! P2D-05: chat in the window, in-process. `Api::serve` on `127.0.0.1:0` with a scratch store,
//! the real `Asker` with the window's questions, and a scripted brain that behaves as the agent
//! does: it starts a run (`Event::RunStarted`, `Origin::Window`), sends step frames, asks
//! through the asker, and appends the turn to the store. Requests are written by hand over TCP,
//! and the SSE stream is read as it comes.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use alexia_api::{Api, ApiParts};
use alexia_core::agent::{Agent, AgentParts};
use alexia_core::catalog::Catalog;
use alexia_core::checker::Checker;
use alexia_core::local::{LocalJobs, Runtime};
use alexia_core::prompt::Skills;
use alexia_core::router::Router;
use alexia_core::tools::McpTooling;
use alexia_core::{
    Ask, Brain, BrainError, Bus, DraftFrame, DraftSink, Event, Lane, Limits, Origin, Phase,
    Produced, Question, Reply, RunId, StepFrame, StepOutcomeFrame, ToolProgress, Turn,
};
use alexia_gateway::{Asker, ChannelSet, WindowQuestions};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, Timings};
use alexia_scheduler::Scheduler;
use alexia_store::{now_ms, Content, Layout, MessageBody, Role, SessionId, Store};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

/// Generous: a loaded Windows machine is slow.
const WAIT: Duration = Duration::from_secs(60);

// ---- the scripted brain ----

/// Answers by the turn's text: "tool" runs a step that reports a plan and makes a file; "ask"
/// asks first and runs the step only on Allow; "slow" starts a step and waits to be stopped;
/// anything else is a plain answer. Every turn is appended to the store, as the agent does.
struct Scripted {
    store: Arc<Store>,
    bus: Bus,
    asker: Arc<Asker>,
    /// The folder the "tool" step makes its file in.
    made: PathBuf,
}

fn body(text: &str) -> MessageBody {
    serde_json::from_value(json!({ "content": text })).unwrap()
}

impl Scripted {
    fn start(&self, turn: &Turn) -> RunId {
        static N: AtomicUsize = AtomicUsize::new(0);
        let run = RunId(format!("test-run-{}", N.fetch_add(1, Ordering::Relaxed)));
        self.bus.publish(Event::RunStarted {
            at: now_ms(),
            run: run.clone(),
            session: turn.session,
            origin: turn.origin.clone(),
        });
        run
    }

    /// As the agent: the window learns of the run from the bus, while the model is asked.
    async fn until_attached(&self, run: &RunId) {
        let w = self.asker.window().expect("the asker has the window");
        let began = std::time::Instant::now();
        while !w.attached(run.clone()) {
            assert!(began.elapsed() < WAIT, "the window never attached {run:?}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn step(n: u32, name: &str) -> StepFrame {
        StepFrame {
            n,
            name: name.into(),
            args: None,
            progress: None,
            outcome: None,
        }
    }
}

#[async_trait::async_trait]
impl Brain for Scripted {
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
        let send = |f: DraftFrame| {
            let draft = draft.clone();
            async move {
                let _ = draft.send(f).await;
            }
        };
        send(DraftFrame::Phase(Phase::Choosing)).await;
        let mut answer = "Hello.".to_owned();
        if said.contains("tool") {
            self.start(&turn);
            let file = self.made.join("report.txt");
            std::fs::write(&file, b"made by a tool").unwrap();
            send(DraftFrame::Step(StepFrame {
                args: Some(json!({ "ms": 300 })),
                ..Scripted::step(1, "fixture__crunch")
            }))
            .await;
            send(DraftFrame::Phase(Phase::Tool)).await;
            send(DraftFrame::Step(StepFrame {
                progress: Some(ToolProgress {
                    progress: 1.0,
                    total: Some(2.0),
                    message: Some("press".into()),
                    stages: Some(json!([
                        { "label": "open", "state": "done" },
                        { "label": "press", "state": "running" }
                    ])),
                    plan: true,
                    ..ToolProgress::default()
                }),
                ..Scripted::step(1, "fixture__crunch")
            }))
            .await;
            send(DraftFrame::Step(StepFrame {
                outcome: Some(StepOutcomeFrame {
                    text: "crunched".into(),
                    ok: true,
                    files: vec![Produced {
                        name: "report.txt".into(),
                        path: file,
                        bytes: 14,
                        mime: "text/plain".into(),
                    }],
                }),
                ..Scripted::step(1, "fixture__crunch")
            }))
            .await;
            answer = "Done.".into();
        } else if said.contains("ask") {
            let run = self.start(&turn);
            send(DraftFrame::Step(StepFrame {
                args: Some(json!({ "key": "colour", "value": "blue" })),
                ..Scripted::step(1, "undoable__set")
            }))
            .await;
            send(DraftFrame::Phase(Phase::Tool)).await;
            self.until_attached(&run).await;
            let q = Question {
                run,
                text: "May I set colour to blue?".into(),
                detail: None,
            };
            let allowed = self
                .asker
                .confirm(&Origin::Window, &q, cancel.clone())
                .await;
            let (text, ok) = if allowed {
                ("set", true)
            } else {
                ("not run: the owner said no", false)
            };
            send(DraftFrame::Step(StepFrame {
                outcome: Some(StepOutcomeFrame {
                    text: text.into(),
                    ok,
                    files: vec![],
                }),
                ..Scripted::step(1, "undoable__set")
            }))
            .await;
            answer = if allowed { "Set." } else { "Left it." }.into();
        } else if said.contains("slow") {
            let _run = self.start(&turn);
            send(DraftFrame::Step(StepFrame {
                args: Some(json!({ "ms": 600000 })),
                ..Scripted::step(1, "fixture__crunch")
            }))
            .await;
            tokio::select! {
                _ = cancel.cancelled() => {
                    send(DraftFrame::Step(StepFrame {
                        outcome: Some(StepOutcomeFrame {
                            text: "not run: stopped".into(),
                            ok: false,
                            files: vec![],
                        }),
                        ..Scripted::step(1, "fixture__crunch")
                    }))
                    .await;
                    return Err(BrainError::Cancelled);
                }
                _ = tokio::time::sleep(Duration::from_secs(600)) => {}
            }
        }
        send(DraftFrame::Phase(Phase::Writing)).await;
        let (a, b) = answer.split_at(answer.len() / 2);
        send(DraftFrame::Delta(a.into())).await;
        send(DraftFrame::Delta(b.into())).await;
        self.store
            .append(
                turn.session,
                Role::Assistant,
                Some("fake-model"),
                &body(&answer),
            )
            .unwrap();
        Ok(Reply {
            text: answer,
            files: vec![],
            lane: Lane::Task,
            model: Some("fake-model".into()),
            spans: vec![],
        })
    }
}

// ---- the world ----

struct World {
    api: Arc<Api>,
    brain: Arc<Scripted>,
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
    let dir = std::env::temp_dir().join(format!("alexia-chat-{name}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn world(name: &str) -> World {
    world_where(name, None).await
}

/// `world`, with `other` answering in place of the scripted brain when given.
async fn world_where(name: &str, other: Option<Arc<dyn Brain>>) -> World {
    let root = scratch(name);
    let data = root.join("data");
    let ext = root.join("ext");
    let made = root.join("made");
    std::fs::create_dir_all(&ext).unwrap();
    std::fs::create_dir_all(&made).unwrap();
    let store = Arc::new(Store::open_in_memory().unwrap());
    let bus = Bus::new(256);
    let host = McpHost::new(
        HostConfig {
            layout: Layout::new(data.clone()),
            plugin_dirs: vec![ext],
            node: PathBuf::from("node"),
            timings: Timings::default(),
        },
        store.clone(),
        Arc::new(NoUpcalls),
        Arc::new(|_| {}),
    );
    host.start(&[]).await.unwrap();
    let catalog = Arc::new(Catalog::new(vec![], vec![], root.join("catalog.json")));
    let router = Arc::new(Router::new(vec![], catalog.clone(), store.clone()));
    let channels = ChannelSet::new();
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
    let scripted = Arc::new(Scripted {
        store: store.clone(),
        bus: bus.clone(),
        asker: asker.clone(),
        made,
    });
    let brain: Arc<dyn Brain> = other.unwrap_or_else(|| scripted.clone());
    let scheduler = Scheduler::new(store.clone(), bus.clone(), brain.clone());
    let (skills, _) = Skills::load(&[]);
    let runtime = Runtime::new(Layout::new(data.clone()), reqwest::Client::new());
    let jobs = LocalJobs::new(runtime.clone(), store.clone(), router.clone());
    let api = Api::new(ApiParts {
        layout: Layout::new(data),
        store,
        bus,
        host,
        tooling,
        agent,
        brain,
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
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    tokio::spawn(api.clone().serve(listener, cancel.clone()));
    World {
        api,
        brain: scripted,
        port,
        root,
        cancel,
    }
}

// ---- HTTP by hand ----

struct Answer {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Answer {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|_| panic!("not JSON: {}", String::from_utf8_lossy(&self.body)))
    }
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
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

fn head_of(raw: &[u8]) -> Option<(usize, u16, Vec<(String, String)>)> {
    let split = raw.windows(4).position(|x| x == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines.next()?.split(' ').nth(1)?.parse().ok()?;
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect();
    Some((split + 4, status, headers))
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
    let (at, status, headers) = head_of(&raw).expect("a full head");
    let mut rest = raw[at..].to_vec();
    let chunked = headers
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("transfer-encoding") && v.contains("chunked"));
    let body = if chunked {
        let mut out = Vec::new();
        dechunk(&mut rest, &mut out);
        out
    } else {
        rest
    };
    Answer {
        status,
        headers,
        body,
    }
}

/// `/api/chat`, read frame by frame as the server writes them.
struct Sse {
    sock: TcpStream,
    status: u16,
    headers: Vec<(String, String)>,
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
        let (at, status, headers) = loop {
            if let Some(h) = head_of(&raw) {
                break h;
            }
            let mut buf = [0u8; 4096];
            let n = tokio::time::timeout(WAIT, sock.read(&mut buf))
                .await
                .expect("a head in time")
                .unwrap();
            assert!(n > 0, "the server closed before answering");
            raw.extend_from_slice(&buf[..n]);
        };
        raw.drain(..at);
        Sse {
            sock,
            status,
            headers,
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

    /// Frames until one has `key`; that one is the last returned.
    async fn until(&mut self, key: &str) -> Vec<Value> {
        let mut all = Vec::new();
        while let Some(f) = self.next().await {
            let hit = f.get(key).is_some();
            all.push(f);
            if hit {
                return all;
            }
        }
        panic!("the stream ended before a {key} frame: {all:?}");
    }
}

fn keys(frames: &[Value]) -> Vec<String> {
    frames
        .iter()
        .map(|f| f.as_object().unwrap().keys().next().unwrap().clone())
        .collect()
}

fn texts(store: &Store, session: SessionId) -> Vec<(Role, String)> {
    store
        .history(session, None)
        .unwrap()
        .into_iter()
        .map(|m| (m.role, m.body.content.text()))
        .collect()
}

// ---- the tests ----

#[tokio::test]
async fn plain_answer_frames() {
    let w = world("plain").await;
    let mut s = Sse::open(&w, json!({ "text": "Say hello." })).await;
    assert_eq!(s.status, 200);
    let kind = s
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"));
    assert_eq!(kind.map(|(_, v)| v.as_str()), Some("text/event-stream"));
    let cache = s
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("cache-control"));
    assert_eq!(cache.map(|(_, v)| v.as_str()), Some("no-store"));
    let frames = s.rest().await;
    assert_eq!(
        keys(&frames),
        ["phase", "phase", "delta", "delta", "done"],
        "{frames:?}"
    );
    assert_eq!(frames[0]["phase"], json!({ "kind": "choosing" }));
    assert_eq!(frames[1]["phase"]["kind"], "writing");
    let said: String = frames[2..4]
        .iter()
        .map(|f| f["delta"].as_str().unwrap())
        .collect();
    assert_eq!(said, "Hello.");
    let done = &frames[4]["done"];
    assert_eq!(done["model"], "fake-model");
    assert_eq!(done["ended"], "answered");
    assert_eq!(done["steps"], 0);
    assert_eq!(done["spent"], 0);
    assert_eq!(done["today"], json!({ "spent": 0, "allowance": 0 }));
    for f in &frames {
        assert!(f.get("paid").is_none() && f.get("paused").is_none());
    }
    // The turn landed in the window's session, and the window is free again.
    let session = w.api.session();
    assert_eq!(
        texts(&w.api.parts.store, session),
        [
            (Role::User, "Say hello.".to_owned()),
            (Role::Assistant, "Hello.".to_owned())
        ]
    );
    assert!(!w.api.busy());
    // Nothing typed and nothing attached is not a message.
    assert_eq!(
        send(&w, "POST", "/api/chat", Some(&json!({}))).await.status,
        400
    );
}

#[tokio::test]
async fn tool_step_frames_with_plan() {
    let w = world("tool").await;
    let mut s = Sse::open(&w, json!({ "text": "Use the tool." })).await;
    let frames = s.rest().await;
    assert_eq!(
        keys(&frames),
        ["phase", "step", "phase", "step", "step", "phase", "delta", "delta", "done"],
        "{frames:?}"
    );
    assert_eq!(
        frames[1]["step"],
        json!({ "n": 1, "name": "fixture__crunch", "args": { "ms": 300 } })
    );
    assert_eq!(
        frames[2]["phase"],
        json!({ "kind": "tool", "name": "fixture__crunch" })
    );
    // The stages and the plan reach the client.
    let progress = &frames[3]["step"]["progress"];
    assert_eq!(progress["plan"], true);
    assert_eq!(progress["stages"][1]["label"], "press");
    assert_eq!(progress["total"], 2.0);
    assert_eq!(progress["message"], "press");
    let outcome = &frames[4]["step"];
    assert_eq!(outcome["text"], "crunched");
    assert_eq!(outcome["ok"], true);
    let file = &outcome["files"][0];
    assert_eq!(file["name"], "report.txt");
    assert_eq!(file["openable"], true);
    assert_eq!(file["mime"], "text/plain");
    assert!(file["id"].as_str().is_some_and(|id| !id.is_empty()));
    assert_eq!(frames[8]["done"]["steps"], 1);
    assert_eq!(frames[8]["done"]["ended"], "answered");
}

#[tokio::test]
async fn ask_then_approve_runs() {
    let w = world("approve").await;
    // Nothing waiting: the answer says so.
    let none = send(
        &w,
        "POST",
        "/api/approve",
        Some(&json!({ "allowed": true })),
    )
    .await;
    assert_eq!(none.json(), json!({ "ok": false }));

    let mut s = Sse::open(&w, json!({ "text": "Please ask before you set it." })).await;
    let before = s.until("ask").await;
    assert_eq!(
        keys(&before),
        ["phase", "step", "phase", "ask"],
        "{before:?}"
    );
    assert_eq!(before[3]["ask"], "May I set colour to blue?");
    let a = send(
        &w,
        "POST",
        "/api/approve",
        Some(&json!({ "allowed": true })),
    )
    .await;
    assert_eq!(a.status, 200);
    assert_eq!(a.json(), json!({ "ok": true }));
    let after = s.rest().await;
    assert_eq!(after[0]["step"]["ok"], true, "{after:?}");
    assert_eq!(after[0]["step"]["text"], "set");
    assert_eq!(after.last().unwrap()["done"]["ended"], "answered");
    // The window's answer is a real approval row, answered from the window.
    let rows = w.api.parts.store.approvals_pending().unwrap();
    assert!(rows.is_empty(), "nothing is left waiting");
}

#[tokio::test]
async fn ask_then_deny_skips() {
    let w = world("deny").await;
    let mut s = Sse::open(&w, json!({ "text": "Please ask before you set it." })).await;
    s.until("ask").await;
    let a = send(
        &w,
        "POST",
        "/api/approve",
        Some(&json!({ "allowed": false })),
    )
    .await;
    assert_eq!(a.json(), json!({ "ok": true }));
    let after = s.rest().await;
    assert_eq!(after[0]["step"]["ok"], false, "{after:?}");
    let said: String = after.iter().filter_map(|f| f["delta"].as_str()).collect();
    assert_eq!(said, "Left it.");
    // An approve with a missing or non-true `allowed` is never an Allow.
    let mut s = Sse::open(&w, json!({ "text": "Please ask before you set it." })).await;
    s.until("ask").await;
    let a = send(
        &w,
        "POST",
        "/api/approve",
        Some(&json!({ "allowed": "yes" })),
    )
    .await;
    assert_eq!(a.json(), json!({ "ok": true }));
    assert_eq!(s.rest().await[0]["step"]["ok"], false);
}

#[tokio::test]
async fn stop_mid_tool_ends_with_done_or_error_as_v2() {
    let w = world("stop").await;
    // Nothing running.
    let idle = send(&w, "POST", "/api/stop", Some(&json!({}))).await;
    assert_eq!(idle.json(), json!({ "stopping": false }));

    let mut s = Sse::open(&w, json!({ "text": "Be slow about it." })).await;
    s.until("step").await;
    let stop = send(&w, "POST", "/api/stop", Some(&json!({}))).await;
    assert_eq!(stop.status, 200);
    assert_eq!(stop.json(), json!({ "stopping": true }));
    let after = tokio::time::timeout(WAIT, s.rest()).await.expect("ended");
    assert_eq!(after[0]["step"]["text"], "not run: stopped", "{after:?}");
    let last = after.last().unwrap();
    assert_eq!(last["done"]["ended"], "stopped", "{after:?}");
    // The window is free for the next message.
    let mut again = Sse::open(&w, json!({ "text": "Say hello." })).await;
    assert_eq!(again.status, 200);
    assert!(again.rest().await.last().unwrap().get("done").is_some());
}

#[tokio::test]
async fn stop_answers_the_open_question_no() {
    let w = world("stop-ask").await;
    let mut s = Sse::open(&w, json!({ "text": "Please ask before you set it." })).await;
    s.until("ask").await;
    let stop = send(&w, "POST", "/api/stop", Some(&json!({}))).await;
    assert_eq!(stop.json(), json!({ "stopping": true }));
    let after = s.rest().await;
    assert_eq!(after[0]["step"]["ok"], false, "{after:?}");
}

#[tokio::test]
async fn busy_423() {
    let w = world("busy").await;
    let mut first = Sse::open(&w, json!({ "text": "Please ask before you set it." })).await;
    first.until("ask").await;
    let second = send(
        &w,
        "POST",
        "/api/chat",
        Some(&json!({ "text": "A second message." })),
    )
    .await;
    assert_eq!(second.status, 423);
    assert_eq!(second.header("content-type"), Some("application/json"));
    assert_eq!(
        second.json(),
        json!({
            "ok": false,
            "busy": true,
            "said": "Alexia is still answering — wait for her or press Stop."
        })
    );
    send(
        &w,
        "POST",
        "/api/approve",
        Some(&json!({ "allowed": false })),
    )
    .await;
    first.rest().await;
}

#[tokio::test]
async fn closed_stream_is_never_an_allow() {
    let w = world("closed").await;
    let mut s = Sse::open(&w, json!({ "text": "Please ask before you set it." })).await;
    s.until("ask").await;
    // The window goes away mid-question.
    drop(s);
    // With no chat to take the question to, the run hears no, and the window is free again.
    let began = std::time::Instant::now();
    while w.api.busy() {
        assert!(began.elapsed() < WAIT, "the turn never ended");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let session = w.api.session();
    let said = texts(&w.api.parts.store, session);
    assert_eq!(said.last().unwrap().1, "Left it.", "{said:?}");
}

#[tokio::test]
async fn command_new_chat_switches_session() {
    let w = world("command").await;
    let before = w.api.session();
    let a = send(
        &w,
        "POST",
        "/api/command",
        Some(&json!({ "input": "/new" })),
    )
    .await;
    assert_eq!(a.status, 200);
    let v = a.json();
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["moved"], true);
    assert!(v["note"]
        .as_str()
        .unwrap()
        .starts_with("Started a new conversation"));
    assert_eq!(v["setup"]["name"], "Alexia");
    assert_eq!(v["setup"]["mode"], "combined");
    assert_eq!(v["pins"], json!({ "uncensored": false }));
    let after = w.api.session();
    assert_ne!(after, before);
    // The window remembers it.
    let kept = w.api.parts.store.kv_get("_core", "window_session").unwrap();
    assert_eq!(kept, Some(json!(after.0)));

    let help = send(
        &w,
        "POST",
        "/api/command",
        Some(&json!({ "input": "/help" })),
    )
    .await
    .json();
    assert_eq!(help["ok"], true);
    let data = help["data"].as_array().unwrap();
    assert!(data.iter().any(|c| c["name"] == "new"), "{help}");
    assert!(help.get("moved").is_none());
    assert_eq!(w.api.session(), after);

    let nope = send(
        &w,
        "POST",
        "/api/command",
        Some(&json!({ "input": "/nope" })),
    )
    .await
    .json();
    assert_eq!(nope["ok"], false);
    assert_eq!(
        nope["note"],
        "There is no /nope. Type /help to see what there is."
    );
}

#[tokio::test]
async fn window_and_telegram_share_history_store() {
    let w = world("shared").await;
    let store = w.api.parts.store.clone();
    // A Telegram turn, answered by the same brain the window uses.
    let telegram = store.channel_session("telegram", "42").unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    w.api
        .parts
        .brain
        .reply(
            Turn {
                session: telegram,
                origin: Origin::Channel {
                    channel: "telegram".into(),
                    chat: "42".into(),
                },
                content: Content::Text("Hi from the phone.".into()),
                files: vec![],
                received_at: now_ms(),
                steer: alexia_core::Steer::none(),
            },
            tx,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    // A window turn.
    let mut s = Sse::open(&w, json!({ "text": "Hi from the window." })).await;
    s.rest().await;
    let window = w.api.session();
    assert_ne!(window, telegram, "each in its own session");
    assert_eq!(
        texts(&store, telegram)[0],
        (Role::User, "Hi from the phone.".to_owned())
    );
    assert_eq!(
        texts(&store, window)[0],
        (Role::User, "Hi from the window.".to_owned())
    );
    // One store: both sessions are listed by it.
    let sessions: Vec<SessionId> = store.sessions().unwrap().iter().map(|s| s.id).collect();
    assert!(sessions.contains(&telegram) && sessions.contains(&window));
}

/// Offers the window a file through a "tool" turn and answers its id.
async fn offered(w: &World) -> (String, Value) {
    let mut s = Sse::open(w, json!({ "text": "Use the tool." })).await;
    let frames = s.rest().await;
    let file = frames
        .iter()
        .find_map(|f| f["step"]["files"].get(0).cloned())
        .expect("a file was offered");
    (file["id"].as_str().unwrap().to_owned(), file)
}

#[tokio::test]
async fn file_download_headers() {
    let w = world("download").await;
    let (id, _) = offered(&w).await;
    let a = send(&w, "GET", &format!("/api/file?id={id}"), None).await;
    assert_eq!(a.status, 200);
    assert_eq!(a.body, b"made by a tool");
    assert_eq!(a.header("content-type"), Some("text/plain"));
    assert_eq!(a.header("content-length"), Some("14"));
    assert_eq!(
        a.header("content-disposition"),
        Some("attachment; filename=\"report.txt\"")
    );
    assert_eq!(a.header("cache-control"), Some("no-store"));

    let unknown = send(&w, "GET", "/api/file?id=nope", None).await;
    assert_eq!(unknown.status, 404);
    assert_eq!(
        unknown.json(),
        json!({ "ok": false, "said": "That file is not one anything offered here." })
    );

    std::fs::remove_file(w.brain.made.join("report.txt")).unwrap();
    let gone = send(&w, "GET", &format!("/api/file?id={id}"), None).await;
    assert_eq!(gone.status, 410);
    assert_eq!(
        gone.json(),
        json!({ "ok": false, "said": "report.txt is no longer where it was made." })
    );
}

#[tokio::test]
async fn file_open_refuses_exe() {
    let root = scratch("exe-made");
    let exe = root.join("setup.exe");
    std::fs::write(&exe, b"MZ").unwrap();
    let w = world_where("open-exe", Some(Arc::new(ExeBrain(exe)))).await;
    let mut s = Sse::open(&w, json!({ "text": "Make an installer." })).await;
    let all = s.rest().await;
    let file = all
        .iter()
        .find_map(|f| f["step"]["files"].get(0).cloned())
        .expect("offered");
    assert_eq!(file["openable"], false);
    let id = file["id"].as_str().unwrap();
    let a = send(
        &w,
        "POST",
        "/api/file",
        Some(&json!({ "id": id, "action": "open", "confirm": true })),
    )
    .await;
    assert_eq!(a.status, 409);
    assert_eq!(
        a.json(),
        json!({
            "ok": false,
            "said": "setup.exe is the sort of file that runs when it is opened, so Alexia will not open it for you. Show in folder still works, and from there it is your decision."
        })
    );
    // Show in folder for an id nothing offered: 404, nothing started.
    let none = send(
        &w,
        "POST",
        "/api/file",
        Some(&json!({ "id": "nope", "action": "reveal", "confirm": true })),
    )
    .await;
    assert_eq!(none.status, 404);
    let _ = std::fs::remove_dir_all(&root);
}

/// A brain whose one step makes `setup.exe`.
struct ExeBrain(PathBuf);

#[async_trait::async_trait]
impl Brain for ExeBrain {
    async fn reply(
        &self,
        _turn: Turn,
        draft: DraftSink,
        _cancel: CancellationToken,
    ) -> Result<Reply, BrainError> {
        let _ = draft
            .send(DraftFrame::Step(StepFrame {
                n: 1,
                name: "fixture__build".into(),
                args: None,
                progress: None,
                outcome: Some(StepOutcomeFrame {
                    text: "built".into(),
                    ok: true,
                    files: vec![Produced {
                        name: "setup.exe".into(),
                        path: self.0.clone(),
                        bytes: 2,
                        mime: "application/octet-stream".into(),
                    }],
                }),
            }))
            .await;
        Ok(Reply {
            text: "Built.".into(),
            files: vec![],
            lane: Lane::Task,
            model: None,
            spans: vec![],
        })
    }
}

#[tokio::test]
async fn uploads_are_saved_then_discarded() {
    let w = world("uploads").await;
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD.encode(b"notes");
    let mut s = Sse::open(
        &w,
        json!({ "text": "", "files": [{ "name": "a.txt", "data": data }, { "name": "e.txt", "data": "" }] }),
    )
    .await;
    let frames = s.rest().await;
    assert_eq!(
        frames[0]["phase"],
        json!({ "kind": "reading" }),
        "{frames:?}"
    );
    assert_eq!(frames[1]["note"], "e.txt is empty.");
    assert!(frames.last().unwrap().get("done").is_some());
    // Written, read, gone.
    let left = std::fs::read_dir(w.api.parts.layout.uploads())
        .map(|d| d.count())
        .unwrap_or(0);
    assert_eq!(left, 0);
}

#[tokio::test]
async fn not_her_with_nothing_to_mark() {
    let w = world("not-her").await;
    let a = send(&w, "POST", "/api/not-her", Some(&json!({}))).await;
    assert_eq!(
        a.json(),
        json!({ "ok": false, "said": "There is no answer to mark yet." })
    );
    // After an answer, the press is taken; nothing provides persona.not_her here, so nothing
    // heard it.
    Sse::open(&w, json!({ "text": "Say hello." }))
        .await
        .rest()
        .await;
    let a = send(
        &w,
        "POST",
        "/api/not-her",
        Some(&json!({ "said": "too formal" })),
    )
    .await;
    assert_eq!(a.json(), json!({ "ok": true, "heard": false }));
}
