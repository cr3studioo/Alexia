// SPDX-License-Identifier: AGPL-3.0-only
//! P2-20: the agent loop. A fake provider scripts the model's turns from the request it gets,
//! a fake `Tooling` answers calls, a fake `Ask` says yes or no.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::agent::{Agent, AgentParts, Task};
use alexia_core::catalog::Catalog;
use alexia_core::checker::Checker;
use alexia_core::chat::Caps;
use alexia_core::free::{Auth, FreeRow};
use alexia_core::router::Router;
use alexia_core::{
    Ask, Bus, ChatChunk, ChatDone, ChatRequest, DraftFrame, Limits, ModelInfo, Origin, Provider,
    ProviderError, Question, Steer, ToolCtx, ToolOutcome, ToolSpec, Tooling,
};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, Timings};
use alexia_store::{Content, Layout, MessageBody, Role, SessionId, Store, ToolCall};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// What the scripted model says, given the request and the model asked.
type Script = Arc<dyn Fn(&ChatRequest, &str) -> Vec<ChatChunk> + Send + Sync>;

struct FakeModel {
    script: Script,
    /// (model, request) of every call.
    asked: Arc<Mutex<Vec<(String, ChatRequest)>>>,
    /// Set: after the first text chunk the model waits here until stopped.
    hang: bool,
}

#[async_trait::async_trait]
impl Provider for FakeModel {
    fn id(&self) -> &str {
        "p"
    }
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(vec![info("big-70b"), info("small-8b")])
    }
    async fn chat(
        &self,
        req: &ChatRequest,
        model: &str,
        out: mpsc::Sender<ChatChunk>,
        cancel: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        self.asked.lock().unwrap().push((model.into(), req.clone()));
        for chunk in (self.script)(req, model) {
            let _ = out.send(chunk).await;
            if self.hang {
                cancel.cancelled().await;
                return Err(ProviderError::Cancelled);
            }
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

fn info(id: &str) -> ModelInfo {
    ModelInfo {
        id: id.into(),
        context: 32_768,
        free: true,
        tools: true,
        vision: false,
    }
}

/// The checker's model: flags every call.
struct Flagger;

#[async_trait::async_trait]
impl Provider for Flagger {
    fn id(&self) -> &str {
        "checker"
    }
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(Vec::new())
    }
    async fn chat(
        &self,
        _: &ChatRequest,
        model: &str,
        out: mpsc::Sender<ChatChunk>,
        _: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        let _ = out
            .send(ChatChunk::Text("1. YES\n2. NO\n3. NO".into()))
            .await;
        Ok(ChatDone {
            model: model.into(),
            provider: "checker".into(),
            tokens_in: 1,
            tokens_out: 1,
            cost: 0.0,
            first_byte_ms: None,
        })
    }
}

type Behave = Arc<dyn Fn(&str, &Map<String, Value>) -> (ToolOutcome, u64) + Send + Sync>;

struct FakeTools {
    specs: Mutex<Vec<ToolSpec>>,
    /// (name, args) of every call that ran, in the order they started.
    ran: Arc<Mutex<Vec<(String, Map<String, Value>)>>>,
    /// Outcome and how long to take, in ms.
    behave: Behave,
    /// Run after each `list`: lets a test change the tools between steps.
    on_list: Mutex<Option<Box<dyn FnMut(&mut Vec<ToolSpec>) + Send>>>,
    /// Set: every call waits here for the others, so calls run one at a time never meet.
    barrier: Option<Arc<tokio::sync::Barrier>>,
}

#[async_trait::async_trait]
impl Tooling for FakeTools {
    async fn list(&self) -> Vec<ToolSpec> {
        let mut specs = self.specs.lock().unwrap();
        let now = specs.clone();
        if let Some(f) = self.on_list.lock().unwrap().as_mut() {
            f(&mut specs);
        }
        now
    }
    async fn call(&self, name: &str, args: Map<String, Value>, _: ToolCtx) -> ToolOutcome {
        self.ran.lock().unwrap().push((name.into(), args.clone()));
        if let Some(b) = &self.barrier {
            if tokio::time::timeout(Duration::from_secs(30), b.wait())
                .await
                .is_err()
            {
                return ok("alone");
            }
        }
        let (outcome, ms) = (self.behave)(name, &args);
        tokio::time::sleep(Duration::from_millis(ms)).await;
        outcome
    }
}

fn spec(name: &str, read_only: bool) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        description: format!("The {name} tool."),
        params: json!({ "type": "object" }),
        annotations: Some(
            serde_json::from_value(json!({
                "readOnlyHint": read_only,
                "destructiveHint": !read_only,
            }))
            .unwrap(),
        ),
        reviewed: true,
        plugin: None,
        words: format!("use {name}"),
    }
}

fn ok(text: &str) -> ToolOutcome {
    ToolOutcome {
        text: text.into(),
        ok: true,
        files: Vec::new(),
        final_text: None,
        undo: None,
        card: None,
    }
}

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
    asked: Arc<Mutex<Vec<(String, ChatRequest)>>>,
    ran: Arc<Mutex<Vec<(String, Map<String, Value>)>>>,
    questions: Arc<Mutex<Vec<String>>>,
    tools: Arc<FakeTools>,
    host: McpHost,
    root: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

struct Setup {
    script: Script,
    specs: Vec<ToolSpec>,
    behave: Behave,
    yes: bool,
    hang: bool,
    checker: bool,
    limits: Limits,
    barrier: Option<usize>,
}

impl Setup {
    fn new(script: Script) -> Setup {
        Setup {
            script,
            specs: vec![spec("look", true), spec("wipe", false)],
            behave: Arc::new(|name, _| (ok(&format!("{name} done")), 0)),
            yes: true,
            hang: false,
            checker: false,
            limits: Limits::default(),
            barrier: None,
        }
    }
}

fn temp() -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "alexia-agent-test-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ))
}

async fn world(s: Setup) -> World {
    let root = temp();
    std::fs::create_dir_all(root.join("ext")).unwrap();
    std::fs::create_dir_all(root.join("data")).unwrap();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let p: Arc<dyn Provider> = Arc::new(FakeModel {
        script: s.script,
        asked: asked.clone(),
        hang: s.hang,
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
    let session = store.create_session(None).unwrap();
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
    let ran = Arc::new(Mutex::new(Vec::new()));
    let tools = Arc::new(FakeTools {
        specs: Mutex::new(s.specs),
        ran: ran.clone(),
        behave: s.behave,
        on_list: Mutex::new(None),
        barrier: s.barrier.map(|n| Arc::new(tokio::sync::Barrier::new(n))),
    });
    let questions = Arc::new(Mutex::new(Vec::new()));
    let checker = if s.checker {
        Checker::new(Some((Arc::new(Flagger) as Arc<dyn Provider>, "c".into())))
    } else {
        Checker::new(None)
    };
    let agent = Agent::new(AgentParts {
        router,
        tools: tools.clone(),
        store: store.clone(),
        bus: Bus::new(64),
        ask: Arc::new(FakeAsk {
            yes: s.yes,
            asked: questions.clone(),
        }),
        checker: Arc::new(checker),
        caps: Arc::new(NoCaps),
        layout: Layout::new(root.join("data")),
        limits: s.limits,
        host: host.clone(),
    });
    World {
        agent,
        store,
        session,
        asked,
        ran,
        questions,
        tools,
        host,
        root,
    }
}

fn body(content: &str) -> MessageBody {
    serde_json::from_value(json!({ "content": content })).unwrap()
}

#[tokio::test]
async fn agent_builds_without_running() {
    let w = world(Setup::new(Arc::new(|_, _| Vec::new()))).await;
    assert!(Arc::ptr_eq(w.agent.store(), &w.store));
    assert!(w.agent.host().plugins().is_empty());
    assert!(w.agent.local_jobs().is_none());
    assert!(w.asked.lock().unwrap().is_empty());
    w.host.shutdown().await;
}
