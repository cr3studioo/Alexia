// SPDX-License-Identifier: AGPL-3.0-only
//! P3-06 (D214): a turn from the scheduler runs a tool without asking only if it reads or the
//! owner listed it; outward-facing tools always ask. The harness is a trimmed copy of
//! `tests/agent.rs`'s: a scripted model, fake tools and a fake asker.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::agent::{Agent, AgentParts, Task};
use alexia_core::catalog::Catalog;
use alexia_core::chat::Caps;
use alexia_core::checker::Checker;
use alexia_core::free::{Auth, FreeRow};
use alexia_core::router::Router;
use alexia_core::{
    Ask, Bus, ChatChunk, ChatDone, ChatRequest, JobId, Limits, ModelInfo, Origin, Provider,
    ProviderError, Question, RunEnd, RunResult, Steer, ToolCtx, ToolOutcome, ToolSpec, Tooling,
};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, Timings};
use alexia_store::{Layout, MessageBody, Role, SessionId, Store, ToolCall};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// What the scripted model says, given the request.
type Script = Arc<dyn Fn(&ChatRequest) -> Vec<ChatChunk> + Send + Sync>;

struct FakeModel {
    script: Script,
}

#[async_trait::async_trait]
impl Provider for FakeModel {
    fn id(&self) -> &str {
        "p"
    }
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(vec![ModelInfo {
            id: "big-70b".into(),
            context: 32_768,
            free: true,
            tools: true,
            vision: true,
        }])
    }
    async fn chat(
        &self,
        req: &ChatRequest,
        model: &str,
        out: mpsc::Sender<ChatChunk>,
        _: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        for chunk in (self.script)(req) {
            let _ = out.send(chunk).await;
        }
        Ok(ChatDone {
            model: model.into(),
            provider: "p".into(),
            tokens_in: 1,
            tokens_out: 1,
            cost: 0.0,
            first_byte_ms: None,
        })
    }
}

struct FakeTools {
    specs: Vec<ToolSpec>,
    /// Names of every call that ran, in order.
    ran: Arc<Mutex<Vec<String>>>,
}

#[async_trait::async_trait]
impl Tooling for FakeTools {
    async fn list(&self) -> Vec<ToolSpec> {
        self.specs.clone()
    }
    async fn call(&self, name: &str, _: Map<String, Value>, _: ToolCtx) -> ToolOutcome {
        self.ran.lock().unwrap().push(name.into());
        ToolOutcome {
            text: format!("{name} done"),
            ok: true,
            files: Vec::new(),
            final_text: None,
            undo: None,
            card: None,
        }
    }
}

/// Answers every question with `yes` and remembers what was asked.
struct FakeAsk {
    yes: bool,
    asked: Arc<Mutex<Vec<String>>>,
}

#[async_trait::async_trait]
impl Ask for FakeAsk {
    async fn confirm(&self, _: &Origin, q: &Question, _: CancellationToken) -> bool {
        self.asked.lock().unwrap().push(q.text.clone());
        self.yes
    }
}

struct NoCaps;

#[async_trait::async_trait]
impl Caps for NoCaps {
    fn answers(&self, _: &str) -> bool {
        false
    }
    async fn call(&self, _: &str, _: Map<String, Value>, _: CancellationToken) -> Option<String> {
        None
    }
}

struct World {
    agent: Arc<Agent>,
    store: Arc<Store>,
    session: SessionId,
    ran: Arc<Mutex<Vec<String>>>,
    questions: Arc<Mutex<Vec<String>>>,
    host: McpHost,
    root: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn temp() -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "alexia-silent-test-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ))
}

/// The scripted model calls tools from `specs`; the asker answers `yes`.
async fn world(script: Script, specs: Vec<ToolSpec>, yes: bool) -> World {
    let root = temp();
    std::fs::create_dir_all(root.join("ext")).unwrap();
    std::fs::create_dir_all(root.join("data")).unwrap();
    let p: Arc<dyn Provider> = Arc::new(FakeModel { script });
    let row = FreeRow {
        id: "p".into(),
        base_url: "http://p.invalid/v1".into(),
        models_path: Some("/models".into()),
        headers: Vec::new(),
        auth: Auth::Optional,
        all_free: true,
        rpm: None,
        rpd: None,
        router: false,
    };
    let catalog = Arc::new(Catalog::new(
        vec![p.clone()],
        vec![row],
        root.join("catalog.json"),
    ));
    catalog.refresh().await;
    let store = Arc::new(Store::open_in_memory().unwrap());
    let session = store.create_session(None).unwrap();
    let router = Arc::new(Router::new(vec![p], catalog, store.clone()));
    let host = McpHost::new(
        HostConfig {
            layout: Layout::new(root.join("data")),
            plugin_dirs: vec![root.join("ext")],
            node: PathBuf::from("node"),
            timings: Timings::default(),
            dial: None,
        },
        store.clone(),
        Arc::new(NoUpcalls),
        Arc::new(|_| {}),
    );
    host.start(&[]).await.unwrap();
    let ran = Arc::new(Mutex::new(Vec::new()));
    let questions = Arc::new(Mutex::new(Vec::new()));
    let agent = Agent::new(AgentParts {
        router,
        tools: Arc::new(FakeTools {
            specs,
            ran: ran.clone(),
        }),
        store: store.clone(),
        bus: Bus::new(64),
        ask: Arc::new(FakeAsk {
            yes,
            asked: questions.clone(),
        }),
        checker: Arc::new(Checker::new(None)),
        caps: Arc::new(NoCaps),
        layout: Layout::new(root.join("data")),
        limits: Limits::default(),
        host: host.clone(),
    });
    World {
        agent,
        store,
        session,
        ran,
        questions,
        host,
        root,
    }
}

fn call(id: &str, name: &str, args: Value) -> ChatChunk {
    ChatChunk::ToolCall(ToolCall {
        id: id.into(),
        name: name.into(),
        arguments: args.to_string(),
    })
}

/// One call to `name` with `args` on the first model turn, then an answer.
fn calls(name: &str, args: Value) -> Script {
    let first = vec![call("c1", name, args)];
    Arc::new(move |req| {
        let turn = req
            .messages
            .iter()
            .filter(|(r, _)| *r == Role::Assistant)
            .count();
        if turn == 0 {
            first.clone()
        } else {
            vec![ChatChunk::Text("Done.".into())]
        }
    })
}

/// Stores the user's words and makes a task for them from `origin`.
fn task(w: &World, words: &str, origin: Origin) -> Task {
    let body: MessageBody = serde_json::from_value(json!({ "content": words })).unwrap();
    w.store.append(w.session, Role::User, None, &body).unwrap();
    let messages = w
        .store
        .history(w.session, None)
        .unwrap()
        .into_iter()
        .map(|m| (m.role, m.body))
        .collect();
    let background = matches!(origin, Origin::Scheduler { .. });
    Task {
        session: w.session,
        origin,
        messages,
        standing: Vec::new(),
        background,
        plugin: None,
        run: None,
        parent: None,
        max_steps: None,
        steer: Steer::none(),
        steps_done: None,
    }
}

/// A task from the scheduler: Alexia acting on her own.
fn scheduled(w: &World, words: &str) -> Task {
    task(w, words, Origin::Scheduler { job: JobId(1) })
}

async fn go(w: &World, t: Task) -> RunResult {
    let (tx, mut rx) = mpsc::channel(256);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let result = tokio::time::timeout(
        Duration::from_secs(60),
        w.agent.run(t, tx, CancellationToken::new()),
    )
    .await
    .expect("the run finished")
    .expect("the run did not fail");
    drain.await.unwrap();
    result
}

fn ran(w: &World) -> Vec<String> {
    w.ran.lock().unwrap().clone()
}

fn questions(w: &World) -> Vec<String> {
    w.questions.lock().unwrap().clone()
}

fn set_mode(w: &World, mode: &str) {
    w.store
        .kv_set("_core", "scope", &json!({ "mode": mode }))
        .unwrap();
}

/// Puts `tools` on the owner's "do it without asking" list.
fn list(w: &World, tools: &[&str]) {
    w.store.kv_set("_core", "silent", &json!(tools)).unwrap();
}

/// (gate, decision) of the one audit row.
fn gate(w: &World) -> (String, String) {
    let audit = w.store.audit_search("", 10).unwrap();
    assert_eq!(audit.len(), 1, "one audit row");
    (audit[0].gate.clone(), audit[0].decision.clone())
}

/// A path on the never-touch list on every machine: the user's SSH keys.
fn ssh_key() -> String {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    PathBuf::from(std::env::var(var).unwrap())
        .join(".ssh")
        .join("id_rsa")
        .display()
        .to_string()
}

/// The tool the model calls, with these annotations (`reviewed` as given).
fn tool(name: &str, ann: Value, reviewed: bool) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        description: format!("The {name} tool."),
        params: json!({ "type": "object" }),
        annotations: Some(serde_json::from_value(ann).unwrap()),
        reviewed,
        plugin: None,
        words: format!("use {name}"),
    }
}

fn writes() -> Value {
    json!({ "readOnlyHint": false, "destructiveHint": false })
}

async fn world_with(name: &str, spec: ToolSpec, yes: bool) -> World {
    world(calls(name, json!({})), vec![spec], yes).await
}

#[tokio::test]
async fn scheduler_turn_reading_runs() {
    let spec = tool(
        "look",
        json!({ "readOnlyHint": true, "destructiveHint": false }),
        true,
    );
    let w = world_with("look", spec, false).await;
    let r = go(&w, scheduled(&w, "check the page")).await;
    assert_eq!(r.end, RunEnd::Answered);
    assert_eq!(ran(&w), ["look"]);
    assert!(questions(&w).is_empty());
    assert_eq!(gate(&w), ("run".into(), "run".into()));
    w.host.shutdown().await;
}

#[tokio::test]
async fn scheduler_turn_writing_asks_when_not_listed() {
    // Full trust would run it at the window; on her own she asks.
    let w = world_with("note", tool("note", writes(), true), false).await;
    set_mode(&w, "full-trust");
    let r = go(&w, scheduled(&w, "write it down")).await;
    assert_eq!(r.end, RunEnd::Answered);
    assert!(ran(&w).is_empty(), "denied, so it did not run");
    assert_eq!(
        questions(&w),
        ["Alexia wants to use note on her own. Allow it?"]
    );
    assert_eq!(gate(&w), ("proactive".into(), "denied".into()));
    w.host.shutdown().await;
}

#[tokio::test]
async fn scheduler_turn_listed_tool_runs() {
    // Default mode (Ask when risky) would ask; the owner's list lets it run.
    let w = world_with("note", tool("note", writes(), true), false).await;
    list(&w, &["note"]);
    let r = go(&w, scheduled(&w, "write it down")).await;
    assert_eq!(r.end, RunEnd::Answered);
    assert_eq!(ran(&w), ["note"]);
    assert!(questions(&w).is_empty());
    assert_eq!(gate(&w), ("proactive".into(), "run".into()));
    w.host.shutdown().await;
}

#[tokio::test]
async fn open_world_always_asks_even_full_trust_and_listed() {
    let ann = json!({ "readOnlyHint": true, "destructiveHint": false, "openWorldHint": true });
    let w = world_with("send", tool("send", ann, true), false).await;
    set_mode(&w, "full-trust");
    list(&w, &["send"]);
    let r = go(&w, scheduled(&w, "send it")).await;
    assert_eq!(r.end, RunEnd::Answered);
    assert!(ran(&w).is_empty());
    assert_eq!(
        questions(&w),
        ["Alexia wants to use send on her own. Allow it?"]
    );
    assert_eq!(gate(&w), ("proactive".into(), "denied".into()));
    w.host.shutdown().await;
}

#[tokio::test]
async fn unreviewed_plugin_asks() {
    // Says it only reads and is on the list, but nobody reviewed it.
    let ann = json!({ "readOnlyHint": true, "destructiveHint": false });
    let w = world_with("look", tool("look", ann, false), false).await;
    set_mode(&w, "full-trust");
    list(&w, &["look"]);
    let r = go(&w, scheduled(&w, "check the page")).await;
    assert_eq!(r.end, RunEnd::Answered);
    assert!(ran(&w).is_empty());
    assert_eq!(questions(&w).len(), 1);
    assert_eq!(gate(&w), ("proactive".into(), "denied".into()));
    w.host.shutdown().await;
}

#[tokio::test]
async fn never_touch_still_blocks_listed_tool() {
    let w = world(
        calls("note", json!({ "path": ssh_key() })),
        vec![tool("note", writes(), true)],
        true,
    )
    .await;
    set_mode(&w, "full-trust");
    list(&w, &["note"]);
    go(&w, scheduled(&w, "write to my key")).await;
    assert!(ran(&w).is_empty());
    assert!(questions(&w).is_empty(), "blocked, never asked");
    assert_eq!(gate(&w), ("blocked".into(), "blocked".into()));
    w.host.shutdown().await;
}

#[tokio::test]
async fn window_turn_unchanged() {
    // The same writing and outward calls from the owner at the window in Full trust: `rule`
    // alone, no Ask, whatever the list says.
    let w = world_with("note", tool("note", writes(), true), false).await;
    set_mode(&w, "full-trust");
    let r = go(&w, task(&w, "write it down", Origin::Window)).await;
    assert_eq!(r.end, RunEnd::Answered);
    assert_eq!(ran(&w), ["note"]);
    assert!(questions(&w).is_empty());
    assert_eq!(gate(&w), ("run".into(), "run".into()));
    w.host.shutdown().await;

    let ann = json!({ "readOnlyHint": false, "destructiveHint": false, "openWorldHint": true });
    let w = world_with("send", tool("send", ann, true), false).await;
    set_mode(&w, "full-trust");
    let r = go(&w, task(&w, "send it", Origin::Window)).await;
    assert_eq!(r.end, RunEnd::Answered);
    assert_eq!(ran(&w), ["send"]);
    assert!(questions(&w).is_empty());
    assert_eq!(gate(&w), ("run".into(), "run".into()));
    w.host.shutdown().await;

    // Default mode at the window: `rule`'s own sentence, not the proactive one.
    let w = world_with("note", tool("note", writes(), true), false).await;
    go(&w, task(&w, "write it down", Origin::Window)).await;
    assert!(ran(&w).is_empty());
    assert_eq!(
        questions(&w),
        ["Alexia wants to use note. This may change something. Allow it?"]
    );
    assert_eq!(gate(&w), ("ask".into(), "denied".into()));
    w.host.shutdown().await;
}
