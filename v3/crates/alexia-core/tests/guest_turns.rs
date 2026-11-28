// SPDX-License-Identifier: AGPL-3.0-only
//! P4-34 (TR-10, TR-11): the loop applies local-only and the guest rule to every call, and a
//! guest's turn runs as a guest: the short guest prompt, no profile or recall, no capture,
//! only the owner's guest list of tools, and a refusal instead of a question.
//!
//! A fake provider behind a real Router and Catalog, an in-memory store, fake capabilities,
//! fake tools and a fake `Ask`. No network, no plugin process.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

mod scratch;
use scratch::Scratch;

use alexia_core::agent::{Agent, AgentParts, GUEST_PROMPT};
use alexia_core::catalog::Catalog;
use alexia_core::chat::{Caps, FastChat};
use alexia_core::checker::Checker;
use alexia_core::free::{Auth, FreeRow};
use alexia_core::permissions::{GUEST_BLOCKED, LOCAL_ONLY_BLOCKED};
use alexia_core::router::Router;
use alexia_core::{
    Ask, Brain, BrainError, Budget, Bus, ChatChunk, ChatDone, ChatRequest, Limits, ModelInfo,
    Origin, Provider, ProviderError, Question, Reply, Steer, ToolCtx, ToolOutcome, ToolSpec,
    Tooling, Turn,
};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, PluginId, Timings};
use alexia_store::{Content, Layout, Role, SessionId, Store, ToolCall};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Generous: a slow, loaded Windows machine still gets there.
const GENEROUS: Duration = Duration::from_secs(30);
const MODEL: &str = "fake-70b";
const OWNER_CHAT: &str = "9";
const GUEST_CHAT: &str = "chat-1";

// ---- the fake model ----

/// What the model says, given the request.
type Script = Arc<dyn Fn(&ChatRequest) -> Vec<ChatChunk> + Send + Sync>;

struct FakeModel {
    script: Script,
    asked: Arc<Mutex<Vec<ChatRequest>>>,
}

#[async_trait::async_trait]
impl Provider for FakeModel {
    fn id(&self) -> &str {
        "p"
    }
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(vec![ModelInfo {
            id: MODEL.into(),
            context: 32_768,
            free: true,
            tools: true,
            vision: false,
        }])
    }
    async fn chat(
        &self,
        req: &ChatRequest,
        model: &str,
        out: mpsc::Sender<ChatChunk>,
        _: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        self.asked.lock().unwrap().push(req.clone());
        for c in (self.script)(req) {
            let _ = out.send(c).await;
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

fn text(t: &str) -> Vec<ChatChunk> {
    vec![ChatChunk::Text(t.into())]
}

fn call(id: &str, name: &str, args: Value) -> ChatChunk {
    ChatChunk::ToolCall(ToolCall {
        id: id.into(),
        name: name.into(),
        arguments: args.to_string(),
    })
}

/// How many assistant turns the request already holds.
fn turn_of(req: &ChatRequest) -> usize {
    req.messages
        .iter()
        .filter(|(r, _)| *r == Role::Assistant)
        .count()
}

/// One answer per model turn; past the end, the last answer again.
fn turns(answers: Vec<Vec<ChatChunk>>) -> Script {
    Arc::new(move |req| answers[turn_of(req).min(answers.len() - 1)].clone())
}

// ---- the fake capabilities ----

/// Records every capability call; profile, recall and capture answer.
#[derive(Default)]
struct FakeCaps {
    calls: Mutex<Vec<(String, Map<String, Value>)>>,
}

impl FakeCaps {
    fn calls_to(&self, cap: &str) -> Vec<Map<String, Value>> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(c, _)| c == cap)
            .map(|(_, a)| a.clone())
            .collect()
    }
}

#[async_trait::async_trait]
impl Caps for FakeCaps {
    fn answers(&self, cap: &str) -> bool {
        matches!(
            cap,
            "memory.profile" | "memory.recall" | "memory.capture" | "persona.personality"
        )
    }
    async fn call(
        &self,
        cap: &str,
        args: Map<String, Value>,
        _: CancellationToken,
    ) -> Option<String> {
        self.calls.lock().unwrap().push((cap.into(), args));
        Some(match cap {
            "memory.profile" => "Lives in Brno.".into(),
            "memory.recall" => "Likes tea.".into(),
            "persona.personality" => "Warm and dry.".into(),
            _ => "ok".into(),
        })
    }
    fn provided_by(&self, plugin: &PluginId) -> Vec<String> {
        match plugin.0.as_str() {
            "m" => vec!["memory.recall".into(), "memory.profile".into()],
            _ => Vec::new(),
        }
    }
}

// ---- the fake tools ----

type Calls = Arc<Mutex<Vec<(String, Map<String, Value>)>>>;

struct FakeTools {
    specs: Vec<ToolSpec>,
    ran: Calls,
}

#[async_trait::async_trait]
impl Tooling for FakeTools {
    async fn list(&self) -> Vec<ToolSpec> {
        self.specs.clone()
    }
    async fn call(&self, name: &str, args: Map<String, Value>, _: ToolCtx) -> ToolOutcome {
        self.ran.lock().unwrap().push((name.into(), args));
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

fn tool(name: &str, plugin: &str, annotations: Value) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        description: format!("The {name} tool."),
        params: json!({ "type": "object" }),
        annotations: Some(serde_json::from_value(annotations).unwrap()),
        reviewed: true,
        plugin: Some(PluginId(plugin.into())),
        words: format!("use {name}"),
    }
}

/// Memory's own recall, a notes skill that reads the owner's files, a local read-only weather
/// tool, a destructive local wipe, and a read-only web fetch that reaches outside.
fn specs() -> Vec<ToolSpec> {
    let local_read =
        json!({ "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false });
    vec![
        tool("memory__recall", "m", local_read.clone()),
        tool("notes__find", "n", local_read.clone()),
        tool("weather__now", "w", local_read),
        tool(
            "files__wipe",
            "f",
            json!({ "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false }),
        ),
        // No openWorldHint: MCP's default is true, so it reaches out (P3-42).
        tool(
            "web__fetch",
            "x",
            json!({ "readOnlyHint": true, "destructiveHint": false }),
        ),
    ]
}

struct FakeAsk {
    asked: Arc<Mutex<Vec<String>>>,
}

#[async_trait::async_trait]
impl Ask for FakeAsk {
    async fn confirm(&self, _: &Origin, q: &Question, _: CancellationToken) -> bool {
        self.asked.lock().unwrap().push(q.text.clone());
        true
    }
}

// ---- the world ----

struct World {
    agent: Arc<Agent>,
    chat: FastChat,
    caps: Arc<FakeCaps>,
    store: Arc<Store>,
    asked: Arc<Mutex<Vec<ChatRequest>>>,
    ran: Calls,
    questions: Arc<Mutex<Vec<String>>>,
    router: Arc<Router>,
    /// The one fake model, for a test that makes it a local one.
    model: Arc<dyn Provider>,
    host: McpHost,
    _root: Scratch,
}

/// A sha256 hex stand-in: 64 copies of one hex digit.
fn hash(c: char) -> String {
    std::iter::repeat_n(c, 64).collect()
}

/// The owner's telegram chat is `OWNER_CHAT` (the first seen, so the primary); Eva, a guest,
/// holds `GUEST_CHAT`. The owner is called Sam.
async fn world(script: Script) -> World {
    let root = Scratch::new("guest-turns");
    std::fs::create_dir_all(root.join("ext")).unwrap();
    std::fs::create_dir_all(root.join("data")).unwrap();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let p: Arc<dyn Provider> = Arc::new(FakeModel {
        script,
        asked: asked.clone(),
    });
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
    store.channel_session("telegram", OWNER_CHAT).unwrap();
    store.guest_add("Eva", "telegram", &hash('a'), 10).unwrap();
    store
        .guest_claim("telegram", &hash('a'), GUEST_CHAT)
        .unwrap()
        .unwrap();
    store
        .kv_set("_core", "display_name", &json!("Sam"))
        .unwrap();
    let router = Arc::new(Router::new(vec![p.clone()], catalog, store.clone()));
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
    let caps = Arc::new(FakeCaps::default());
    let ran: Calls = Arc::default();
    let questions = Arc::new(Mutex::new(Vec::new()));
    let agent = Agent::new(AgentParts {
        router: router.clone(),
        tools: Arc::new(FakeTools {
            specs: specs(),
            ran: ran.clone(),
        }),
        store: store.clone(),
        bus: Bus::new(64),
        ask: Arc::new(FakeAsk {
            asked: questions.clone(),
        }),
        checker: Arc::new(Checker::new(None)),
        caps: caps.clone(),
        layout: Layout::new(root.join("data")),
        limits: Limits::default(),
        host: host.clone(),
    });
    let chat = FastChat::new(router.clone(), caps.clone(), store.clone(), Budget::CHAT);
    World {
        agent,
        chat,
        caps,
        store,
        asked,
        ran,
        questions,
        router,
        model: p,
        host,
        _root: root,
    }
}

fn telegram(chat: &str) -> Origin {
    Origin::Channel {
        channel: "telegram".into(),
        chat: chat.into(),
    }
}

/// One task-lane turn from `chat`, in that chat's session.
async fn turn_in(w: &World, chat: &str, said: &str) -> Result<Reply, BrainError> {
    let session = w.store.channel_session("telegram", chat).unwrap();
    reply_via(&*w.agent, telegram(chat), session, said).await
}

async fn reply_via(
    brain: &dyn Brain,
    origin: Origin,
    session: SessionId,
    said: &str,
) -> Result<Reply, BrainError> {
    let (tx, mut rx) = mpsc::channel(256);
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let t = Turn {
        session,
        origin,
        content: Content::Text(said.into()),
        files: Vec::new(),
        received_at: 0,
        steer: Steer::none(),
    };
    tokio::time::timeout(GENEROUS, brain.reply(t, tx, CancellationToken::new()))
        .await
        .expect("the turn finished")
}

fn guest_list(w: &World, tools: &[&str]) {
    w.store
        .kv_set("_core", "guest_tools", &json!(tools))
        .unwrap();
}

/// The tool names the model was offered in its first request.
fn offered(w: &World) -> Vec<String> {
    let asked = w.asked.lock().unwrap();
    asked[0].tools.iter().map(|t| t.name.clone()).collect()
}

fn system(w: &World) -> String {
    w.asked.lock().unwrap()[0]
        .system
        .clone()
        .unwrap_or_default()
}

/// The tool rows of the session, in order: what each call came back with.
fn tool_results(w: &World, chat: &str) -> Vec<String> {
    let session = w.store.channel_session("telegram", chat).unwrap();
    w.store
        .history(session, None)
        .unwrap()
        .into_iter()
        .filter(|m| m.role == Role::Tool)
        .map(|m| m.body.content.text())
        .collect()
}

async fn eventually(what: impl Fn() -> bool) -> bool {
    let until = Instant::now() + GENEROUS;
    while Instant::now() < until {
        if what() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    what()
}

// ---- the guest's turn ----

#[tokio::test]
async fn guest_sees_no_tools_by_default() {
    let w = world(turns(vec![text("Hello, Eva!")])).await;
    let r = turn_in(&w, GUEST_CHAT, "hi, what can you do?")
        .await
        .unwrap();
    assert_eq!(r.text, "Hello, Eva!");
    // Nothing on the guest list: no tool at all, not memory's recall, not the notes skill.
    assert!(offered(&w).is_empty(), "{:?}", offered(&w));
    w.host.shutdown().await;

    // With a list, exactly the listed tools, and nothing the owner did not list.
    let w = world(turns(vec![text("Sunny.")])).await;
    guest_list(&w, &["weather__now"]);
    turn_in(&w, GUEST_CHAT, "is it sunny?").await.unwrap();
    assert_eq!(offered(&w), ["weather__now"]);
    w.host.shutdown().await;
}

#[tokio::test]
async fn guest_prompt_has_no_profile() {
    let w = world(turns(vec![text("Nice to meet you.")])).await;
    turn_in(&w, GUEST_CHAT, "what does Sam do all day?")
        .await
        .unwrap();
    let said = system(&w);
    let expected = GUEST_PROMPT
        .replace("{guest}", "Eva")
        .replace("{owner}", "Sam");
    assert!(said.starts_with(&expected), "{said}");
    assert!(said.contains("You know nothing about Sam's life"), "{said}");
    // Neither the profile, the personality nor a recall reached it, or was even read.
    for owners in ["Brno", "tea", "Warm and dry", "long-term memory"] {
        assert!(!said.contains(owners), "{owners} leaked: {said}");
    }
    for cap in ["memory.profile", "memory.recall", "persona.personality"] {
        assert!(w.caps.calls_to(cap).is_empty(), "{cap} was called");
    }
    w.host.shutdown().await;
}

#[tokio::test]
async fn guest_turn_captures_nothing() {
    let w = world(turns(vec![text("Noted.")])).await;
    // The task lane and the chat lane both end in `agent::capture`.
    turn_in(&w, GUEST_CHAT, "remember that I like jazz")
        .await
        .unwrap();
    let session = w.store.channel_session("telegram", GUEST_CHAT).unwrap();
    reply_via(
        &w.chat,
        telegram(GUEST_CHAT),
        session,
        "and that I live in Rome",
    )
    .await
    .unwrap();
    // Then the owner: the only capture, so none of the guest's was ever spawned ahead of it.
    turn_in(&w, OWNER_CHAT, "the control").await.unwrap();
    assert!(
        eventually(|| !w.caps.calls_to("memory.capture").is_empty()).await,
        "the owner's turn was captured"
    );
    // A moment more, so a late spawn would have shown.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let all = w.caps.calls_to("memory.capture");
    assert_eq!(all.len(), 1, "only the owner's: {all:?}");
    assert_eq!(all[0]["said"], "the control");
    w.host.shutdown().await;
}

#[tokio::test]
async fn guest_tool_call_blocked_not_asked() {
    let w = world(turns(vec![
        vec![
            // Listed but destructive: it would ask the owner, so it is refused.
            call("c1", "files__wipe", json!({})),
            // Not listed: refused, without saying the owner has it.
            call("c2", "notes__find", json!({ "q": "Sam" })),
            // A tool that does not exist: refused the same way.
            call("c3", "secret__thing", json!({})),
            // Listed, read-only, names no place: runs.
            call("c4", "weather__now", json!({ "city": "Prague" })),
        ],
        text("I can only tell you the weather."),
    ]))
    .await;
    guest_list(&w, &["files__wipe", "weather__now"]);
    let r = turn_in(&w, GUEST_CHAT, "wipe Sam's files").await.unwrap();
    assert_eq!(r.text, "I can only tell you the weather.");
    assert!(
        w.questions.lock().unwrap().is_empty(),
        "the owner was asked"
    );
    let ran: Vec<String> = w
        .ran
        .lock()
        .unwrap()
        .iter()
        .map(|(n, _)| n.clone())
        .collect();
    assert_eq!(ran, ["weather__now"]);
    let results = tool_results(&w, GUEST_CHAT);
    assert_eq!(results.len(), 4);
    for refused in &results[..3] {
        assert_eq!(refused, GUEST_BLOCKED);
    }
    assert!(results[3].contains("weather__now done"), "{}", results[3]);
    // The audit keeps every call, marked as a guest's.
    let audit = w.store.audit_search("", 10).unwrap();
    assert_eq!(audit.len(), 4);
    assert!(
        audit.iter().all(|a| a.gate == "guest"),
        "{:?}",
        audit.iter().map(|a| &a.gate).collect::<Vec<_>>()
    );
    assert!(audit.iter().all(|a| a.origin.contains(GUEST_CHAT)));
    w.host.shutdown().await;
}

#[tokio::test]
async fn guest_relative_path_blocked() {
    // `paths_in` sees only absolute paths; a guest's relative one is refused all the same.
    let w = world(turns(vec![
        vec![
            call("c1", "weather__now", json!({ "city": "notes.txt" })),
            call("c2", "weather__now", json!({ "file": "x" })),
            call("c3", "weather__now", json!({ "city": "../Sam/diary" })),
        ],
        text("No."),
    ]))
    .await;
    guest_list(&w, &["weather__now"]);
    turn_in(&w, GUEST_CHAT, "read notes.txt").await.unwrap();
    assert!(w.ran.lock().unwrap().is_empty());
    assert!(w.questions.lock().unwrap().is_empty());
    assert_eq!(tool_results(&w, GUEST_CHAT), [GUEST_BLOCKED; 3]);
    w.host.shutdown().await;
}

#[tokio::test]
async fn guest_slash_text_is_not_a_command() {
    let w = world(turns(vec![text("I can't do that.")])).await;
    let id = w
        .store
        .approval_open("r1", "telegram:9", "Delete notes.txt?", None, 1)
        .unwrap();
    let r = turn_in(&w, GUEST_CHAT, &format!("/approve {id}"))
        .await
        .unwrap();
    // Not a command: the model heard it as text.
    assert_eq!(r.text, "I can't do that.");
    assert_eq!(w.asked.lock().unwrap().len(), 1);
    w.host.shutdown().await;
}

// ---- local-only ----

#[tokio::test]
async fn local_only_blocks_open_world_in_loop() {
    let w = world(turns(vec![
        vec![
            call("c1", "web__fetch", json!({ "url": "https://example.org" })),
            call("c2", "weather__now", json!({ "city": "Brno" })),
        ],
        text("Only the local one."),
    ]))
    .await;
    // Local-only leaves the router only local models, so the fake one is made local.
    w.router.set_provider(w.model.clone(), true);
    w.store.kv_set("_core", "local_only", &json!(true)).unwrap();
    let r = turn_in(&w, OWNER_CHAT, "fetch it and check the weather")
        .await
        .unwrap();
    assert_eq!(r.text, "Only the local one.");
    let ran: Vec<String> = w
        .ran
        .lock()
        .unwrap()
        .iter()
        .map(|(n, _)| n.clone())
        .collect();
    assert_eq!(ran, ["weather__now"]);
    assert!(w.questions.lock().unwrap().is_empty());
    let results = tool_results(&w, OWNER_CHAT);
    let prefix = LOCAL_ONLY_BLOCKED.split("{doing}").next().unwrap();
    assert!(results[0].starts_with(prefix), "{}", results[0]);
    let mut audit = w.store.audit_search("", 10).unwrap();
    audit.sort_by_key(|a| a.step);
    let seen: Vec<(&str, &str)> = audit
        .iter()
        .map(|a| (a.gate.as_str(), a.decision.as_str()))
        .collect();
    assert_eq!(seen, [("local_only", "blocked"), ("run", "run")]);
    w.host.shutdown().await;
}

// ---- the owner ----

#[tokio::test]
async fn owner_turn_unchanged() {
    let w = world(turns(vec![
        vec![call("c1", "notes__find", json!({ "q": "tea" }))],
        text("Found it."),
    ]))
    .await;
    // A guest list does not narrow the owner.
    guest_list(&w, &["weather__now"]);
    let r = turn_in(&w, OWNER_CHAT, "find my tea notes").await.unwrap();
    assert_eq!(r.text, "Found it.");
    assert_eq!(offered(&w).len(), specs().len());
    let said = system(&w);
    assert!(!said.contains("a guest of"), "{said}");
    assert!(said.contains("Lives in Brno."), "{said}");
    assert!(said.contains("Warm and dry."), "{said}");
    assert_eq!(w.caps.calls_to("memory.profile").len(), 1);
    let ran: Vec<String> = w
        .ran
        .lock()
        .unwrap()
        .iter()
        .map(|(n, _)| n.clone())
        .collect();
    assert_eq!(ran, ["notes__find"]);
    let audit = w.store.audit_search("", 10).unwrap();
    assert_eq!(audit.len(), 1);
    assert_eq!(
        (audit[0].gate.as_str(), audit[0].decision.as_str()),
        ("run", "run")
    );
    assert!(
        eventually(|| w.caps.calls_to("memory.capture").len() == 1).await,
        "the owner's turn was captured"
    );
    w.host.shutdown().await;
}
