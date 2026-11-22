// SPDX-License-Identifier: AGPL-3.0-only
//! P2-20: the agent loop. A fake provider scripts the model's turns from the request it gets,
//! a fake `Tooling` answers calls, a fake `Ask` says yes or no.

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
    Ask, Bus, ChatChunk, ChatDone, ChatRequest, DraftFrame, Limits, ModelInfo, Origin, Provider,
    ProviderError, Question, Steer, ToolCtx, ToolOutcome, ToolSpec, Tooling,
};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, Timings};
use alexia_store::{Content, Layout, MessageBody, Part, Role, SessionId, Store, ToolCall};
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
        vision: true, // photos reach the model (P2-73)
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

type Calls = Arc<Mutex<Vec<(String, Map<String, Value>)>>>;
type OnList = Box<dyn FnMut(&mut Vec<ToolSpec>) + Send>;
type Behave = Arc<dyn Fn(&str, &Map<String, Value>) -> (ToolOutcome, u64) + Send + Sync>;

struct FakeTools {
    specs: Mutex<Vec<ToolSpec>>,
    /// (name, args) of every call that ran, in the order they started.
    ran: Calls,
    /// Outcome and how long to take, in ms.
    behave: Behave,
    /// Run after each `list`: lets a test change the tools between steps.
    on_list: Mutex<Option<OnList>>,
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
    ran: Calls,
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
async fn parts_exposes_what_agent_was_built_from() {
    let mut s = Setup::new(Arc::new(|_, _| Vec::new()));
    s.limits.max_steps = 7;
    let w = world(s).await;
    assert!(Arc::ptr_eq(&w.agent.parts().store, w.agent.store()));
    assert_eq!(w.agent.parts().limits.max_steps, 7);
    w.host.shutdown().await;
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

// ---- the loop ----

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

/// Which model turn a request is for: how many assistant turns it already holds.
fn turn_of(req: &ChatRequest) -> usize {
    req.messages
        .iter()
        .filter(|(r, _)| *r == Role::Assistant)
        .count()
}

/// Everything the request says, as one string.
fn said(req: &ChatRequest) -> String {
    req.messages
        .iter()
        .map(|(_, b)| b.content.text())
        .collect::<Vec<_>>()
        .join("\n")
}

/// A script from one answer per model turn; past the end, the last answer again.
fn turns(answers: Vec<Vec<ChatChunk>>) -> Script {
    Arc::new(move |req, _| {
        let t = turn_of(req).min(answers.len() - 1);
        answers[t].clone()
    })
}

/// Stores the user's words and makes the task for them.
fn task(w: &World, words: &str) -> Task {
    w.store
        .append(w.session, Role::User, None, &body(words))
        .unwrap();
    Task {
        session: w.session,
        origin: Origin::Desktop,
        messages: rows(w).into_iter().map(|m| (m.role, m.body)).collect(),
        standing: Vec::new(),
        background: false,
        plugin: None,
        run: None,
        parent: None,
        max_steps: None,
        steer: Steer::none(),
        steps_done: None,
    }
}

fn rows(w: &World) -> Vec<alexia_store::Message> {
    w.store.history(w.session, None).unwrap()
}

/// Runs the task to its end; the draft frames it sent come back with the result.
async fn go(w: &World, t: Task) -> (RunResult, Vec<DraftFrame>) {
    let (tx, mut rx) = mpsc::channel(256);
    let frames = tokio::spawn(async move {
        let mut all = Vec::new();
        while let Some(f) = rx.recv().await {
            all.push(f);
        }
        all
    });
    let result = tokio::time::timeout(
        Duration::from_secs(60),
        w.agent.run(t, tx, CancellationToken::new()),
    )
    .await
    .expect("the run finished")
    .expect("the run did not fail");
    (result, frames.await.unwrap())
}

fn tool_rows(w: &World) -> Vec<(String, String)> {
    rows(w)
        .into_iter()
        .filter(|m| m.role == Role::Tool)
        .map(|m| (m.body.call_id.unwrap_or_default(), m.body.content.text()))
        .collect()
}

fn ran(w: &World) -> Vec<String> {
    w.ran
        .lock()
        .unwrap()
        .iter()
        .map(|(n, _)| n.clone())
        .collect()
}

fn set_mode(w: &World, mode: &str) {
    w.store
        .kv_set("_core", "scope", &json!({ "mode": mode }))
        .unwrap();
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

/// Every call id the stored assistant rows made has exactly one tool row.
fn every_call_answered(w: &World) {
    let all = rows(w);
    for m in &all {
        for c in m.body.calls.iter().flatten() {
            let n = all
                .iter()
                .filter(|r| r.role == Role::Tool && r.body.call_id.as_deref() == Some(&c.id))
                .count();
            assert_eq!(n, 1, "call {} has {n} results", c.id);
        }
    }
}

fn notes(w: &World) -> Vec<String> {
    rows(w)
        .into_iter()
        .flat_map(|m| m.body.notes.unwrap_or_default())
        .collect()
}

use alexia_core::{Brain, InFile, JobId, Lane, Phase, Reply, RunEnd, RunId, RunResult, Turn};

#[tokio::test]
async fn answers_without_tools() {
    let w = world(Setup::new(turns(vec![text("Hello.")]))).await;
    let (tx, _rx) = mpsc::channel(256);
    let turn = Turn {
        session: w.session,
        origin: Origin::Desktop,
        content: Content::Text("hi".into()),
        files: Vec::new(),
        received_at: 0,
        steer: Steer::none(),
    };
    let reply = w
        .agent
        .reply(turn, tx, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(reply.text, "Hello.");
    assert_eq!(reply.lane, Lane::Task);
    assert!(ran(&w).is_empty());
    let all = rows(&w);
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].role, Role::User);
    assert_eq!(all[1].role, Role::Assistant);
    assert_eq!(all[1].body.content.text(), "Hello.");
    assert_eq!(
        all[1].model.as_deref(),
        Some(reply.model.as_deref().unwrap())
    );
    w.host.shutdown().await;
}

#[tokio::test]
async fn one_tool_then_answer() {
    let w = world(Setup::new(turns(vec![
        vec![call("c1", "look", json!({ "q": "x" }))],
        text("Found it."),
    ])))
    .await;
    let (r, frames) = go(&w, task(&w, "look for x")).await;
    assert_eq!(r.end, RunEnd::Answered);
    assert_eq!(r.text, "Found it.");
    assert_eq!(r.steps.len(), 1);
    assert!(r.steps[0].outcome.as_ref().unwrap().ok);
    assert_eq!(ran(&w), ["look"]);
    let tools = tool_rows(&w);
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].0, "c1");
    // TR-12: the tool's words reach the model fenced.
    assert!(tools[0].1.contains("⟦untrusted: look⟧"));
    assert!(tools[0].1.contains("look done"));
    let roles: Vec<Role> = rows(&w).iter().map(|m| m.role).collect();
    assert_eq!(
        roles,
        [Role::User, Role::Assistant, Role::Tool, Role::Assistant]
    );
    // The second model turn saw the result.
    let asked = w.asked.lock().unwrap().clone();
    assert!(said(&asked.last().unwrap().1).contains("look done"));
    assert!(matches!(
        frames.first(),
        Some(DraftFrame::Phase(Phase::Choosing))
    ));
    assert_eq!(
        frames
            .iter()
            .filter(|f| matches!(f, DraftFrame::Steerable))
            .count(),
        1
    );
    assert!(frames
        .iter()
        .any(|f| matches!(f, DraftFrame::Phase(Phase::Tool))));
    assert!(frames
        .iter()
        .any(|f| matches!(f, DraftFrame::Delta(d) if d == "Found it.")));
    w.host.shutdown().await;
}

#[tokio::test]
async fn parallel_calls_results_in_model_order() {
    let mut s = Setup::new(turns(vec![
        vec![call("c1", "slow", json!({})), call("c2", "fast", json!({}))],
        text("Both done."),
    ]));
    s.specs = vec![spec("slow", true), spec("fast", true)];
    // The slow one finishes last; both wait for each other first, so run one at a time
    // they would never meet and each would say "alone".
    s.behave = Arc::new(|name, _| {
        (
            ok(&format!("{name} result")),
            if name == "slow" { 300 } else { 0 },
        )
    });
    s.barrier = Some(2);
    let w = world(s).await;
    let (r, _) = go(&w, task(&w, "do both")).await;
    assert_eq!(r.end, RunEnd::Answered);
    let tools = tool_rows(&w);
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0].0, "c1");
    assert!(tools[0].1.contains("slow result"), "{}", tools[0].1);
    assert_eq!(tools[1].0, "c2");
    assert!(tools[1].1.contains("fast result"), "{}", tools[1].1);
    assert_eq!(r.steps[0].name, "slow");
    assert_eq!(r.steps[1].name, "fast");
    w.host.shutdown().await;
}

#[tokio::test]
async fn refusal_is_an_outcome() {
    let w = world(Setup::new(turns(vec![
        vec![call("c1", "look", json!({ "path": ssh_key() }))],
        text("I could not read it."),
    ])))
    .await;
    let (r, _) = go(&w, task(&w, "read my key")).await;
    assert_eq!(r.end, RunEnd::Answered);
    assert_eq!(r.text, "I could not read it.");
    assert!(ran(&w).is_empty());
    let o = r.steps[0].outcome.as_ref().unwrap();
    assert!(!o.ok);
    assert!(o.text.contains("never-touch"), "{}", o.text);
    // The model planned around it: its next turn was given the reason.
    let asked = w.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 2);
    assert!(said(&asked[1].1).contains("never-touch"));
    w.host.shutdown().await;
}

#[tokio::test]
async fn ask_denied_does_not_run() {
    let mut s = Setup::new(turns(vec![
        vec![call("c1", "wipe", json!({}))],
        text("Left it alone."),
    ]));
    s.yes = false;
    let w = world(s).await;
    let (r, _) = go(&w, task(&w, "clean up")).await;
    assert_eq!(r.end, RunEnd::Answered);
    assert!(ran(&w).is_empty());
    assert_eq!(w.questions.lock().unwrap().len(), 1);
    let tools = tool_rows(&w);
    assert!(
        tools[0].1.starts_with("The user did not approve it"),
        "{}",
        tools[0].1
    );
    w.host.shutdown().await;
}

#[tokio::test]
async fn watch_mode_checker_flag_asks() {
    let mut s = Setup::new(turns(vec![
        vec![call("c1", "look", json!({}))],
        text("Done."),
    ]));
    s.checker = true;
    let w = world(s).await;
    set_mode(&w, "watch");
    let (r, _) = go(&w, task(&w, "have a look")).await;
    assert_eq!(r.end, RunEnd::Answered);
    // The rules let a read-only call run; the checker flagged it, so the owner was asked,
    // said yes, and it ran.
    let q = w.questions.lock().unwrap().clone();
    assert_eq!(q.len(), 1);
    assert!(q[0].contains("checker stopped look"), "{}", q[0]);
    assert_eq!(ran(&w), ["look"]);
    let audit = w.store.audit_search("", 10).unwrap();
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0].gate, "checker");
    assert_eq!(audit[0].decision, "approved");
    w.host.shutdown().await;
}

#[tokio::test]
async fn never_touch_blocks_in_full_trust() {
    let w = world(Setup::new(turns(vec![
        vec![call("c1", "wipe", json!({ "path": ssh_key() }))],
        text("Not allowed."),
    ])))
    .await;
    set_mode(&w, "full-trust");
    let (r, _) = go(&w, task(&w, "delete my key")).await;
    assert_eq!(r.end, RunEnd::Answered);
    assert!(ran(&w).is_empty());
    assert!(w.questions.lock().unwrap().is_empty());
    let audit = w.store.audit_search("", 10).unwrap();
    assert_eq!(audit[0].decision, "blocked");
    w.host.shutdown().await;
}

#[tokio::test]
async fn ceiling_answers_dangling_calls() {
    let mut s = Setup::new(turns(vec![vec![
        call("c1", "look", json!({ "q": 1 })),
        call("c2", "look", json!({ "q": 2 })),
        call("c3", "look", json!({ "q": 3 })),
    ]]));
    s.limits.max_steps = 2;
    let w = world(s).await;
    let (r, _) = go(&w, task(&w, "look three times")).await;
    assert_eq!(r.end, RunEnd::Ceiling);
    assert_eq!(r.steps.len(), 2);
    assert_eq!(ran(&w).len(), 2);
    let tools = tool_rows(&w);
    assert_eq!(tools.len(), 3);
    assert_eq!(
        tools[2],
        ("c3".into(), "not run: step limit reached".into())
    );
    every_call_answered(&w);
    assert_eq!(w.asked.lock().unwrap().len(), 1);
    w.host.shutdown().await;
}

#[tokio::test]
async fn stop_keeps_written_text() {
    let mut s = Setup::new(turns(vec![text("Half an ans")]));
    s.hang = true;
    let w = world(s).await;
    let t = task(&w, "write me something long");
    let (tx, mut rx) = mpsc::channel(256);
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let watch = tokio::spawn(async move {
        while let Some(f) = rx.recv().await {
            if matches!(f, DraftFrame::Delta(_)) {
                stop.cancel();
            }
        }
    });
    let r = tokio::time::timeout(Duration::from_secs(60), w.agent.run(t, tx, cancel))
        .await
        .unwrap()
        .unwrap();
    watch.await.unwrap();
    assert_eq!(r.end, RunEnd::Stopped);
    let last = rows(&w).pop().unwrap();
    assert_eq!(last.role, Role::Assistant);
    assert_eq!(last.body.content.text(), "Half an ans");
    assert_eq!(last.body.stopped, Some(true));
    w.host.shutdown().await;
}

#[tokio::test]
async fn looping_escalates_once() {
    // The same call four times, then an answer.
    let w = world(Setup::new(Arc::new(|req, _| {
        let n = turn_of(req);
        if n < 4 {
            vec![call(&format!("c{n}"), "look", json!({ "q": 1 }))]
        } else {
            text("Gave up looking.")
        }
    })))
    .await;
    let (r, _) = go(&w, task(&w, "look again and again")).await;
    assert_eq!(r.end, RunEnd::Answered);
    let all = notes(&w);
    let said_why = all
        .iter()
        .filter(|n| n.contains("so the next plan goes to a better model"))
        .count();
    assert_eq!(said_why, 1, "{all:?}");
    assert!(all[0].starts_with("That call has come back twice"));
    // The turn after the second identical call went to a model other than the one that made it.
    let answered: Vec<String> = rows(&w)
        .into_iter()
        .filter(|m| m.role == Role::Assistant)
        .map(|m| m.model.unwrap())
        .collect();
    let asked = w.asked.lock().unwrap().clone();
    let third: Vec<&str> = asked
        .iter()
        .filter(|(_, req)| turn_of(req) == 2)
        .map(|(m, _)| m.as_str())
        .collect();
    assert!(!third.is_empty());
    assert!(
        third.iter().all(|m| *m != answered[1]),
        "{third:?} vs {answered:?}"
    );
    w.host.shutdown().await;
}

#[tokio::test]
async fn final_ends_without_model_turn() {
    let mut s = Setup::new(turns(vec![
        vec![call("c1", "look", json!({}))],
        text("A model turn that should not happen."),
    ]));
    s.behave = Arc::new(|_, _| {
        let mut o = ok("Song: Blue");
        o.final_text = Some("Playing Blue.".into());
        (o, 0)
    });
    let w = world(s).await;
    let (r, frames) = go(&w, task(&w, "play blue")).await;
    assert_eq!(r.end, RunEnd::Answered);
    assert_eq!(r.text, "Playing Blue.");
    assert_eq!(w.asked.lock().unwrap().len(), 1);
    assert_eq!(rows(&w).pop().unwrap().body.content.text(), "Playing Blue.");
    assert!(frames
        .iter()
        .any(|f| matches!(f, DraftFrame::Delta(d) if d == "Playing Blue.")));
    w.host.shutdown().await;
}

#[tokio::test]
async fn vanished_tool_replans() {
    let mut s = Setup::new(turns(vec![
        vec![call("c1", "look", json!({}))],
        vec![call("c2", "gone", json!({}))],
        text("Did it another way."),
    ]));
    s.specs = vec![spec("look", true), spec("gone", true)];
    let w = world(s).await;
    // The plugin behind `gone` goes away after the first step's list.
    *w.tools.on_list.lock().unwrap() = Some(Box::new(|specs: &mut Vec<ToolSpec>| {
        specs.retain(|t| t.name != "gone");
    }));
    let (r, _) = go(&w, task(&w, "do it")).await;
    assert_eq!(r.end, RunEnd::Answered);
    assert_eq!(ran(&w), ["look"]);
    let o = r.steps[1].outcome.as_ref().unwrap();
    assert!(!o.ok);
    assert!(o.text.contains("not available any more"), "{}", o.text);
    let asked = w.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 3);
    assert!(asked[1].1.tools.iter().all(|t| t.name != "gone"));
    assert!(said(&asked[2].1).contains("not available any more"));
    w.host.shutdown().await;
}

#[tokio::test]
async fn steer_message_used_next_step() {
    let w = world(Setup::new(Arc::new(|req, _| {
        if turn_of(req) == 0 {
            vec![call("c1", "look", json!({}))]
        } else if said(req).contains("in French") {
            text("En francais.")
        } else {
            text("In English.")
        }
    })))
    .await;
    let (tx, steer) = Steer::channel(4);
    tx.send(Content::Text("answer in French".into()))
        .await
        .unwrap();
    let mut t = task(&w, "look it up");
    t.steer = steer;
    let (r, _) = go(&w, t).await;
    assert_eq!(r.text, "En francais.");
    let users: Vec<String> = rows(&w)
        .into_iter()
        .filter(|m| m.role == Role::User)
        .map(|m| m.body.content.text())
        .collect();
    assert_eq!(users, ["look it up", "answer in French"]);
    // Read between steps: the first model turn did not see it.
    assert!(!said(&w.asked.lock().unwrap()[0].1).contains("French"));
    w.host.shutdown().await;
}

#[tokio::test]
async fn boundary_heard_blocks_delete() {
    let w = world(Setup::new(turns(vec![
        vec![call("c1", "wipe", json!({}))],
        text("I left it."),
    ])))
    .await;
    let (r, _) = go(&w, task(&w, "tidy the folder but don't delete anything")).await;
    assert_eq!(r.end, RunEnd::Answered);
    assert!(ran(&w).is_empty());
    assert!(w.questions.lock().unwrap().is_empty());
    let o = r.steps[0].outcome.as_ref().unwrap();
    assert!(o.text.contains("You said"), "{}", o.text);
    let saved = w.store.kv_get("_core", "boundaries").unwrap().unwrap();
    assert_eq!(saved.as_array().unwrap().len(), 1);
    assert!(notes(&w)[0].starts_with("Understood"), "{:?}", notes(&w));
    w.host.shutdown().await;
}

#[tokio::test]
async fn every_call_audited() {
    let mut s = Setup::new(turns(vec![
        vec![
            call("c1", "look", json!({})),
            call("c2", "wipe", json!({})),
            call("c3", "gone", json!({})),
            call("c4", "look", json!({ "path": ssh_key() })),
        ],
        text("Done what I could."),
    ]));
    s.yes = false;
    let w = world(s).await;
    let (r, _) = go(&w, task(&w, "do four things")).await;
    assert_eq!(r.end, RunEnd::Answered);
    let mut audit = w.store.audit_search("", 10).unwrap();
    audit.sort_by_key(|a| a.step);
    let seen: Vec<(u32, &str, &str, &str)> = audit
        .iter()
        .map(|a| {
            (
                a.step,
                a.tool.as_str(),
                a.gate.as_str(),
                a.decision.as_str(),
            )
        })
        .collect();
    assert_eq!(
        seen,
        [
            (1, "look", "run", "run"),
            (2, "wipe", "ask", "denied"),
            (3, "gone", "blocked", "gone"),
            (4, "look", "blocked", "blocked"),
        ]
    );
    assert_eq!(audit[0].ok, Some(true));
    assert!(audit.iter().all(|a| a.run == r.run.0));
    w.host.shutdown().await;
}

fn turn_from(w: &World, origin: Origin, said: &str, files: Vec<InFile>) -> Turn {
    Turn {
        session: w.session,
        origin,
        content: Content::Text(said.into()),
        files,
        received_at: 0,
        steer: Steer::none(),
    }
}

async fn reply(w: &World, turn: Turn) -> Reply {
    let (tx, _rx) = mpsc::channel(256);
    w.agent
        .reply(turn, tx, CancellationToken::new())
        .await
        .unwrap()
}

fn telegram() -> Origin {
    Origin::Channel {
        channel: "telegram".into(),
        chat: "9".into(),
    }
}

/// Every part of the last request's last user message.
fn last_user_parts(w: &World) -> Vec<Part> {
    let asked = w.asked.lock().unwrap();
    let (_, req) = asked.last().expect("the model was asked");
    let (_, b) = req
        .messages
        .iter()
        .rev()
        .find(|(r, _)| *r == Role::User)
        .unwrap();
    match &b.content {
        Content::Parts(p) => p.clone(),
        Content::Text(t) => vec![Part::Text { text: t.clone() }],
    }
}

#[tokio::test]
async fn channel_slash_text_is_a_command() {
    let w = world(Setup::new(turns(vec![text("A model should not answer.")]))).await;
    let r = reply(&w, turn_from(&w, telegram(), "/help", Vec::new())).await;
    assert_eq!(r.lane, Lane::Command);
    assert!(r.text.contains("/approve"), "{}", r.text);
    assert!(w.asked.lock().unwrap().is_empty());
    assert!(w.store.live_runs().unwrap().is_empty());
    w.host.shutdown().await;
}

#[tokio::test]
async fn scheduled_slash_text_is_not_a_command() {
    let w = world(Setup::new(turns(vec![text("Noted.")]))).await;
    let id = w
        .store
        .approval_open("r1", "telegram:9", "Delete notes.txt?", None, 1)
        .unwrap();
    let job = Origin::Scheduler { job: JobId(1) };
    let r = reply(
        &w,
        turn_from(&w, job, &format!("/approve {id}"), Vec::new()),
    )
    .await;
    assert_eq!(r.lane, Lane::Task);
    assert_eq!(r.text, "Noted.");
    assert_eq!(w.store.approval(id).unwrap().unwrap().answer, None);
    {
        let asked = w.asked.lock().unwrap();
        assert!(said(&asked[0].1).contains(&format!("/approve {id}")));
    }
    w.host.shutdown().await;
}

#[tokio::test]
async fn scheduled_turn_runs_in_background() {
    // Every model turn calls a tool; only the ceiling ends the run.
    let looping = || {
        let mut s = Setup::new(Arc::new(|req, _| {
            let n = turn_of(req);
            vec![call(&format!("c{n}"), "look", json!({ "q": n }))]
        }));
        s.limits.max_steps = 2;
        s.limits.background_steps = 4;
        s
    };
    let w = world(looping()).await;
    let job = Origin::Scheduler { job: JobId(1) };
    reply(&w, turn_from(&w, job, "check the news", Vec::new())).await;
    // The ceiling is the background one: four steps ran, not the foreground two.
    assert_eq!(ran(&w).len(), 4);
    // A turn from the owner's window still stops at the foreground ceiling.
    let w2 = world(looping()).await;
    reply(
        &w2,
        turn_from(&w2, Origin::Desktop, "check the news", Vec::new()),
    )
    .await;
    assert_eq!(ran(&w2).len(), 2);
    w.host.shutdown().await;
    w2.host.shutdown().await;
}

#[tokio::test]
async fn photo_reaches_the_model_as_an_image() {
    let w = world(Setup::new(turns(vec![text("A cat.")]))).await;
    let photo = w.root.join("cat.png");
    std::fs::write(&photo, [0x89, b'P', b'N', b'G', 13, 10, 26, 10]).unwrap();
    let file = InFile {
        name: "cat.png".into(),
        mime: "image/png".into(),
        path: photo,
    };
    reply(&w, turn_from(&w, telegram(), "what is this?", vec![file])).await;
    let parts = last_user_parts(&w);
    assert_eq!(
        parts,
        vec![
            Part::Text {
                text: "what is this?".into()
            },
            Part::Image {
                url: "data:image/png;base64,iVBORw0KGgo=".into()
            },
        ]
    );
    // The stored turn holds the image, so a resumed run sees it after the file is gone.
    let stored = rows(&w);
    assert_eq!(stored[0].body.content, Content::Parts(parts));
    w.host.shutdown().await;
}

#[tokio::test]
async fn text_file_inlined_and_binary_named() {
    let w = world(Setup::new(turns(vec![text("Read.")]))).await;
    let notes = w.root.join("notes.txt");
    std::fs::write(&notes, "buy milk").unwrap();
    let blob = w.root.join("dump.bin");
    std::fs::write(&blob, [0u8, 159, 146, 150]).unwrap();
    let files = vec![
        InFile {
            name: "notes.txt".into(),
            mime: "text/plain".into(),
            path: notes,
        },
        InFile {
            name: "dump.bin".into(),
            mime: "application/octet-stream".into(),
            path: blob,
        },
    ];
    reply(&w, turn_from(&w, telegram(), "", files)).await;
    let parts = last_user_parts(&w);
    assert_eq!(
        parts,
        vec![
            Part::Text {
                text: "notes.txt:\nbuy milk".into()
            },
            Part::Text {
                text: "(The owner attached dump.bin, application/octet-stream, which Alexia cannot read yet.)"
                    .into()
            },
        ]
    );
    w.host.shutdown().await;
}

#[tokio::test]
async fn resumed_run_counts_from_steps_done() {
    let mut s = Setup::new(Arc::new(|req, _| {
        let n = turn_of(req);
        vec![call(&format!("c{n}"), "look", json!({ "q": n }))]
    }));
    s.limits.max_steps = 100;
    let w = world(s).await;
    w.store
        .live_begin(&alexia_store::LiveRunRow {
            run: "r-1-1".into(),
            session: w.session,
            origin: serde_json::to_string(&Origin::Desktop).unwrap(),
            started_at: 1,
            touched_at: 1,
            steps: 2,
            background: false,
            parent: None,
        })
        .unwrap();
    let mut t = task(&w, "carry on");
    t.run = Some(RunId("r-1-1".into()));
    t.steps_done = Some(2);
    t.max_steps = Some(4);
    let (r, _) = go(&w, t).await;
    assert_eq!(r.end, RunEnd::Ceiling);
    assert_eq!(r.steps.len(), 2);
    assert_eq!(ran(&w).len(), 2);
    let mut numbers: Vec<u32> = w
        .store
        .audit_search("", 10)
        .unwrap()
        .iter()
        .map(|a| a.step)
        .collect();
    numbers.sort();
    assert_eq!(numbers, [3, 4]);
    assert!(w.store.live_runs().unwrap().is_empty());
    every_call_answered(&w);
    w.host.shutdown().await;
}

#[tokio::test]
async fn resume_without_a_run_id_is_an_error() {
    let w = world(Setup::new(turns(vec![text("x")]))).await;
    let mut t = task(&w, "carry on");
    t.steps_done = Some(1);
    let (tx, _rx) = mpsc::channel(8);
    let r = w.agent.run(t, tx, CancellationToken::new()).await;
    assert!(r.is_err());
    assert!(w.asked.lock().unwrap().is_empty());
    w.host.shutdown().await;
}
