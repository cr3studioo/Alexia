// SPDX-License-Identifier: AGPL-3.0-only
//! P3-16: every finished exchange reaches `memory.capture` with its channel and session, in
//! both lanes; private and proactive turns never do; locked facts are unlocked only for the
//! owner's own chats; a model's own call to a memory tool never unlocks anything.
//!
//! A fake provider behind a real Router and Catalog, an in-memory store, fake capabilities
//! and fake tools. No network, no plugin process.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

mod scratch;
use scratch::Scratch;

use alexia_core::agent::{Agent, AgentParts};
use alexia_core::catalog::Catalog;
use alexia_core::chat::{Caps, FastChat};
use alexia_core::checker::Checker;
use alexia_core::free::{Auth, FreeRow};
use alexia_core::router::Router;
use alexia_core::{
    Ask, Brain, BrainError, Budget, Bus, ChatChunk, ChatDone, ChatRequest, JobId, Lane, Limits,
    ModelInfo, Origin, Provider, ProviderError, Question, Reply, Steer, ToolCtx, ToolOutcome,
    ToolSpec, Tooling, Turn,
};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, PluginId, Timings};
use alexia_store::{Content, Layout, Role, SessionId, Store, ToolCall};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Generous: a slow, loaded Windows machine still gets there.
const GENEROUS: Duration = Duration::from_secs(30);
const MODEL: &str = "fake-70b";

// ---- the fake model ----

/// What the model says to a request: chunks, or busy (`None`).
type Script = Arc<dyn Fn(&ChatRequest) -> Option<Vec<ChatChunk>> + Send + Sync>;

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
        let Some(chunks) = (self.script)(req) else {
            return Err(ProviderError::Busy {
                retry_after_ms: None,
            });
        };
        for c in chunks {
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

fn says(t: &'static str) -> Script {
    Arc::new(move |_| Some(vec![ChatChunk::Text(t.into())]))
}

fn busy() -> Script {
    Arc::new(|_| None)
}

// ---- the fake capabilities ----

/// Records every capability call; profile, recall and capture answer. `m` provides memory,
/// `n` provides notes: the two plugins the model's tools come from.
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
        matches!(cap, "memory.profile" | "memory.recall" | "memory.capture")
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
            _ => "ok".into(),
        })
    }
    fn provided_by(&self, plugin: &PluginId) -> Vec<String> {
        match plugin.0.as_str() {
            "m" => vec!["memory.recall".into(), "memory.profile".into()],
            "n" => vec!["notes.find".into()],
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

fn tool(name: &str, plugin: &str) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        description: format!("The {name} tool."),
        params: json!({ "type": "object", "properties": { "unlocked": { "type": "boolean" } } }),
        annotations: Some(
            serde_json::from_value(json!({ "readOnlyHint": true, "destructiveHint": false }))
                .unwrap(),
        ),
        reviewed: true,
        plugin: Some(PluginId(plugin.into())),
        words: format!("use {name}"),
    }
}

struct Yes;

#[async_trait::async_trait]
impl Ask for Yes {
    async fn confirm(&self, _: &Origin, _: &Question, _: CancellationToken) -> bool {
        true
    }
}

// ---- the world ----

struct World {
    agent: Arc<Agent>,
    chat: FastChat,
    caps: Arc<FakeCaps>,
    store: Arc<Store>,
    ran: Calls,
    host: McpHost,
    _root: Scratch,
}

async fn world(script: Script) -> World {
    let root = Scratch::new("capture");
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
    let router = Arc::new(Router::new(vec![p], catalog, store.clone()));
    let host = McpHost::new(
        HostConfig {
            layout: Layout::new(root.join("data")),
            plugin_dirs: vec![root.join("ext")],
            node: PathBuf::from("node"),
            timings: Timings::default(),
        },
        store.clone(),
        Arc::new(NoUpcalls),
        Arc::new(|_| {}),
    );
    host.start(&[]).await.unwrap();
    let caps = Arc::new(FakeCaps::default());
    let ran: Calls = Arc::default();
    let tools = Arc::new(FakeTools {
        specs: vec![tool("memory__recall", "m"), tool("notes__find", "n")],
        ran: ran.clone(),
    });
    let agent = Agent::new(AgentParts {
        router: router.clone(),
        tools,
        store: store.clone(),
        bus: Bus::new(64),
        ask: Arc::new(Yes),
        checker: Arc::new(Checker::new(None)),
        caps: caps.clone(),
        layout: Layout::new(root.join("data")),
        limits: Limits::default(),
        host: host.clone(),
    });
    let chat = FastChat::new(router, caps.clone(), store.clone(), Budget::CHAT);
    World {
        agent,
        chat,
        caps,
        store,
        ran,
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

fn scheduler() -> Origin {
    Origin::Scheduler { job: JobId(1) }
}

#[derive(Clone, Copy)]
enum Via {
    Chat,
    Task,
}

/// One turn through the chosen lane's brain, as the gateway hands it over.
async fn turn(
    w: &World,
    via: Via,
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
    let brain: &dyn Brain = match via {
        Via::Chat => &w.chat,
        Via::Task => &*w.agent,
    };
    tokio::time::timeout(GENEROUS, brain.reply(t, tx, CancellationToken::new()))
        .await
        .expect("the turn finished")
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

/// Waits for the `n`th capture and returns them all.
async fn captures(w: &World, n: usize) -> Vec<Map<String, Value>> {
    assert!(
        eventually(|| w.caps.calls_to("memory.capture").len() >= n).await,
        "{n} capture(s) arrived"
    );
    w.caps.calls_to("memory.capture")
}

/// A turn that is never captured leaves nothing behind: a captured turn after it (in a fresh
/// session, from the owner's window) is the only capture, so none of the first was ever
/// spawned ahead of it.
async fn only_the_control_is_captured(w: &World, via: Via) {
    let control = w.store.create_session(None).unwrap();
    turn(w, via, Origin::Desktop, control, "the control")
        .await
        .unwrap();
    captures(w, 1).await;
    // A moment more, so a late spawn would have shown.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let all = w.caps.calls_to("memory.capture");
    assert_eq!(all.len(), 1, "only the control: {all:?}");
    assert_eq!(all[0]["session"], control.0);
    assert_eq!(all[0]["said"], "the control");
}

fn mark_private(store: &Store, session: SessionId) {
    store
        .kv_set("_core", "private_sessions", &json!([session.0]))
        .unwrap();
}

fn unlocked_of(args: &Map<String, Value>) -> Option<bool> {
    args.get("unlocked").and_then(Value::as_bool)
}

// ---- capture ----

#[tokio::test]
async fn task_lane_reply_is_captured_with_channel_and_session() {
    let w = world(says("Noted.")).await;
    let session = w.store.channel_session("telegram", "9").unwrap();
    // Built from halves so no credential-shaped literal sits in the source.
    let key = format!("{}{}", "sk-", "abcdefghijklmnopqrstuvwx");
    let said = format!("my key is {key}, remember I like tea");
    let r = turn(&w, Via::Task, telegram("9"), session, &said)
        .await
        .unwrap();
    assert_eq!(r.lane, Lane::Task);
    let got = captures(&w, 1).await;
    assert_eq!(got.len(), 1);
    let args = &got[0];
    assert_eq!(args["channel"], "telegram");
    assert_eq!(args["session"], session.0);
    assert_eq!(args["answered"], "Noted.");
    let captured = args["said"].as_str().unwrap();
    assert!(captured.contains("remember I like tea"));
    assert!(!captured.contains(&key), "redacted as today: {captured}");
    assert!(args["at"].as_i64().unwrap() > 0);
    w.host.shutdown().await;
}

#[tokio::test]
async fn chat_lane_capture_has_channel_and_session() {
    let w = world(says("Noted.")).await;
    let session = w.store.channel_session("telegram", "9").unwrap();
    let r = turn(&w, Via::Chat, telegram("9"), session, "I like tea")
        .await
        .unwrap();
    assert_eq!(r.lane, Lane::Chat);
    let got = captures(&w, 1).await;
    assert_eq!(got[0]["channel"], "telegram");
    assert_eq!(got[0]["session"], session.0);
    assert_eq!(got[0]["said"], "I like tea");
    assert_eq!(got[0]["answered"], "Noted.");

    // The desktop is a channel of its own too.
    let desk = w.store.create_session(None).unwrap();
    turn(&w, Via::Chat, Origin::Desktop, desk, "and coffee")
        .await
        .unwrap();
    let got = captures(&w, 2).await;
    let second = got.iter().find(|a| a["session"] == desk.0).unwrap();
    assert_eq!(second["channel"], "desktop");
    w.host.shutdown().await;
}

#[tokio::test]
async fn scheduler_turn_is_not_captured() {
    for via in [Via::Task, Via::Chat] {
        let w = world(says("Done for you.")).await;
        let session = w.store.create_session(None).unwrap();
        turn(&w, via, scheduler(), session, "the morning brief")
            .await
            .unwrap();
        only_the_control_is_captured(&w, via).await;
        w.host.shutdown().await;
    }
}

#[tokio::test]
async fn private_session_is_not_captured() {
    for via in [Via::Task, Via::Chat] {
        let w = world(says("Noted.")).await;
        let session = w.store.channel_session("telegram", "9").unwrap();
        mark_private(&w.store, session);
        turn(&w, via, telegram("9"), session, "a secret")
            .await
            .unwrap();
        only_the_control_is_captured(&w, via).await;
        w.host.shutdown().await;
    }
}

#[tokio::test]
async fn failed_run_is_not_captured() {
    for via in [Via::Task, Via::Chat] {
        let w = world(busy()).await;
        let session = w.store.channel_session("telegram", "9").unwrap();
        let r = turn(&w, via, telegram("9"), session, "hello?").await;
        assert!(r.is_err(), "the model was busy, so no answer");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            w.caps.calls_to("memory.capture").is_empty(),
            "no answer, nothing to learn"
        );
        w.host.shutdown().await;
    }
}

#[tokio::test]
async fn window_task_lane_is_left_to_the_window_route() {
    // The api's chat route hands the window's task-lane exchange to memory itself (with
    // `channel: "window"`), so core does not offer it a second time.
    let w = world(says("Noted.")).await;
    let session = w.store.create_session(None).unwrap();
    turn(&w, Via::Task, Origin::Window, session, "from the window")
        .await
        .unwrap();
    only_the_control_is_captured(&w, Via::Task).await;
    w.host.shutdown().await;
}

#[tokio::test]
async fn window_chat_lane_capture_says_window() {
    let w = world(says("Noted.")).await;
    let session = w.store.create_session(None).unwrap();
    turn(&w, Via::Chat, Origin::Window, session, "from the window")
        .await
        .unwrap();
    let got = captures(&w, 1).await;
    assert_eq!(got[0]["channel"], "window");
    assert_eq!(got[0]["session"], session.0);
    w.host.shutdown().await;
}

// ---- locked facts ----

/// The `unlocked` core sent on its own profile and recall reads, in both lanes.
async fn unlocks(origin: Origin, session: impl Fn(&Store) -> SessionId) -> Vec<Option<bool>> {
    let mut seen = Vec::new();
    for via in [Via::Chat, Via::Task] {
        let w = world(says("Hello.")).await;
        let s = session(&w.store);
        turn(&w, via, origin.clone(), s, "what do you know?")
            .await
            .unwrap();
        let profile = w.caps.calls_to("memory.profile");
        assert_eq!(profile.len(), 1, "the profile is read once");
        seen.push(unlocked_of(&profile[0]));
        if let Via::Chat = via {
            let recall = w.caps.calls_to("memory.recall");
            assert_eq!(recall.len(), 1, "recall starts with the turn");
            assert_eq!(recall[0]["about"], "what do you know?");
            seen.push(unlocked_of(&recall[0]));
        }
        w.host.shutdown().await;
    }
    seen
}

#[tokio::test]
async fn primary_chat_is_unlocked() {
    // The first chat a channel ever sees is its primary.
    let got = unlocks(telegram("9"), |s| {
        s.channel_session("telegram", "9").unwrap()
    })
    .await;
    assert_eq!(got, vec![Some(true); 3]);
}

#[tokio::test]
async fn other_chat_is_locked() {
    let got = unlocks(telegram("7"), |s| {
        s.channel_session("telegram", "9").unwrap();
        let other = s.channel_session("telegram", "7").unwrap();
        assert_eq!(s.primary_chat("telegram").unwrap().as_deref(), Some("9"));
        other
    })
    .await;
    assert_eq!(got, vec![Some(false); 3]);
}

#[tokio::test]
async fn scheduler_is_locked() {
    let got = unlocks(scheduler(), |s| s.create_session(None).unwrap()).await;
    assert_eq!(got, vec![Some(false); 3]);
}

#[tokio::test]
async fn window_is_unlocked() {
    let got = unlocks(Origin::Window, |s| s.create_session(None).unwrap()).await;
    assert_eq!(got, vec![Some(true); 3]);
    let desk = unlocks(Origin::Desktop, |s| s.create_session(None).unwrap()).await;
    assert_eq!(desk, vec![Some(true); 3]);
}

#[tokio::test]
async fn chat_prefix_never_hands_locked_facts_to_another_chat() {
    // The chat lane caches its system prompt; the one built with locked facts must not serve a
    // chat that may not read them.
    let w = world(says("Hello.")).await;
    let primary = w.store.channel_session("telegram", "9").unwrap();
    let other = w.store.channel_session("telegram", "7").unwrap();
    turn(&w, Via::Chat, telegram("9"), primary, "hi")
        .await
        .unwrap();
    turn(&w, Via::Chat, telegram("7"), other, "hi")
        .await
        .unwrap();
    turn(&w, Via::Chat, telegram("9"), primary, "hi again")
        .await
        .unwrap();
    let profile: Vec<_> = w
        .caps
        .calls_to("memory.profile")
        .iter()
        .map(unlocked_of)
        .collect();
    assert_eq!(
        profile,
        vec![Some(true), Some(false)],
        "one read per lock, then cached"
    );
    w.host.shutdown().await;
}

#[tokio::test]
async fn model_memory_call_never_unlocks() {
    // The model asks the memory provider's tool for locked facts, and a notes tool for its own
    // `unlocked` flag. Only the memory provider's (known by capability) is forced to false.
    let script: Script = Arc::new(|req: &ChatRequest| {
        let answered = req.messages.iter().any(|(r, _)| *r == Role::Assistant);
        Some(if answered {
            vec![ChatChunk::Text("Here is what I found.".into())]
        } else {
            vec![
                ChatChunk::ToolCall(ToolCall {
                    id: "c1".into(),
                    name: "memory__recall".into(),
                    arguments: json!({ "about": "passwords", "unlocked": true }).to_string(),
                }),
                ChatChunk::ToolCall(ToolCall {
                    id: "c2".into(),
                    name: "notes__find".into(),
                    arguments: json!({ "about": "tea", "unlocked": true }).to_string(),
                }),
            ]
        })
    });
    let w = world(script).await;
    // The owner's own window: core's reads are unlocked, the model's call is not.
    let session = w.store.create_session(None).unwrap();
    let r = turn(&w, Via::Task, Origin::Window, session, "find my passwords")
        .await
        .unwrap();
    assert_eq!(r.text, "Here is what I found.");
    let ran: HashMap<String, Map<String, Value>> = w.ran.lock().unwrap().iter().cloned().collect();
    let memory = &ran["memory__recall"];
    assert_eq!(memory["unlocked"], Value::Bool(false), "{memory:?}");
    assert_eq!(memory["about"], "passwords");
    assert_eq!(ran["notes__find"]["unlocked"], Value::Bool(true));
    assert_eq!(
        unlocked_of(&w.caps.calls_to("memory.profile")[0]),
        Some(true)
    );
    w.host.shutdown().await;
}
