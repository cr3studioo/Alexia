// SPDX-License-Identifier: AGPL-3.0-only
//! P2-26: resume after a restart. A "restart" here is a `live_runs` row plus the conversation
//! the dead process left behind; `resume_all` is the new process starting up.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::agent::{Agent, AgentParts};
use alexia_core::catalog::Catalog;
use alexia_core::chat::Caps;
use alexia_core::checker::Checker;
use alexia_core::free::{Auth, FreeRow};
use alexia_core::resume::{answer_dangling, resume_all};
use alexia_core::router::Router;
use alexia_core::{
    Ask, Bus, ChatChunk, ChatDone, ChatRequest, Event, Limits, ModelInfo, Origin, Provider,
    ProviderError, Question, ToolCtx, ToolOutcome, ToolSpec, Tooling,
};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, Timings};
use alexia_store::{Layout, LiveRunRow, MessageBody, Role, SessionId, Store, ToolCall};
use serde_json::{json, Map, Value};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

type Script = Arc<dyn Fn(&ChatRequest) -> Vec<ChatChunk> + Send + Sync>;

struct FakeModel {
    script: Script,
    asked: Arc<Mutex<u32>>,
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
        *self.asked.lock().unwrap() += 1;
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
    ran: Arc<Mutex<Vec<String>>>,
    /// How long every call takes, in ms.
    ms: u64,
}

#[async_trait::async_trait]
impl Tooling for FakeTools {
    async fn list(&self) -> Vec<ToolSpec> {
        vec![spec("look", true), spec("wipe", false)]
    }
    async fn call(&self, name: &str, _: Map<String, Value>, _: ToolCtx) -> ToolOutcome {
        self.ran.lock().unwrap().push(name.into());
        tokio::time::sleep(Duration::from_millis(self.ms)).await;
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

struct FakeAsk(Arc<Mutex<Vec<String>>>);

#[async_trait::async_trait]
impl Ask for FakeAsk {
    async fn confirm(&self, _: &Origin, q: &Question, _: CancellationToken) -> bool {
        self.0.lock().unwrap().push(q.text.clone());
        true
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
    bus: Bus,
    session: SessionId,
    model_calls: Arc<Mutex<u32>>,
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

async fn world(script: Script, limits: Limits, tool_ms: u64) -> World {
    static N: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "alexia-resume-test-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(root.join("ext")).unwrap();
    std::fs::create_dir_all(root.join("data")).unwrap();
    let model_calls = Arc::new(Mutex::new(0));
    let p: Arc<dyn Provider> = Arc::new(FakeModel {
        script,
        asked: model_calls.clone(),
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
    let questions = Arc::new(Mutex::new(Vec::new()));
    let bus = Bus::new(64);
    let agent = Agent::new(AgentParts {
        router,
        tools: Arc::new(FakeTools {
            ran: ran.clone(),
            ms: tool_ms,
        }),
        store: store.clone(),
        bus: bus.clone(),
        ask: Arc::new(FakeAsk(questions.clone())),
        checker: Arc::new(Checker::new(None)),
        caps: Arc::new(NoCaps),
        layout: Layout::new(root.join("data")),
        limits,
        host: host.clone(),
    });
    World {
        agent,
        store,
        bus,
        session,
        model_calls,
        ran,
        questions,
        host,
        root,
    }
}

fn body(content: &str) -> MessageBody {
    serde_json::from_value(json!({ "content": content })).unwrap()
}

fn call(id: &str, name: &str) -> ToolCall {
    ToolCall {
        id: id.into(),
        name: name.into(),
        arguments: "{}".into(),
    }
}

fn tool_calls(calls: &[(&str, &str)]) -> MessageBody {
    let mut b = body("");
    b.calls = Some(calls.iter().map(|(i, n)| call(i, n)).collect());
    b
}

fn tool_result(id: &str, text: &str) -> MessageBody {
    let mut b = body(text);
    b.call_id = Some(id.into());
    b
}

fn tool_rows(w: &World) -> Vec<(String, String)> {
    w.store
        .history(w.session, None)
        .unwrap()
        .into_iter()
        .filter(|m| m.role == Role::Tool)
        .map(|m| (m.body.call_id.unwrap_or_default(), m.body.content.text()))
        .collect()
}

/// The run the dead process left: a user turn, `done` finished look steps, and its live row.
fn seed(w: &World, run: &str, words: &str, done: u32, background: bool, age_ms: i64) {
    w.store
        .append(w.session, Role::User, None, &body(words))
        .unwrap();
    for i in 0..done {
        let id = format!("old{i}");
        w.store
            .append(
                w.session,
                Role::Assistant,
                None,
                &tool_calls(&[(&id, "look")]),
            )
            .unwrap();
        w.store
            .append(w.session, Role::Tool, None, &tool_result(&id, "look done"))
            .unwrap();
    }
    live_row(w, run, done, background, age_ms);
}

fn live_row(w: &World, run: &str, steps: u32, background: bool, age_ms: i64) {
    let at = alexia_store::now_ms() - age_ms;
    w.store
        .live_begin(&LiveRunRow {
            run: run.into(),
            session: w.session,
            origin: serde_json::to_string(&Origin::Desktop).unwrap(),
            started_at: at,
            touched_at: at,
            steps,
            background,
            parent: None,
        })
        .unwrap();
}

/// Resumes and waits for the resumed runs to finish.
async fn resume(w: &World) -> usize {
    let tracker = TaskTracker::new();
    let n = resume_all(w.agent.clone(), &tracker, CancellationToken::new()).await;
    tracker.close();
    tokio::time::timeout(Duration::from_secs(60), tracker.wait())
        .await
        .expect("the resumed runs finished");
    n
}

fn tool_turns(req: &ChatRequest) -> usize {
    req.messages
        .iter()
        .filter(|(r, _)| *r == Role::Tool)
        .count()
}

/// Every `Say` text published so far.
fn said(rx: &mut broadcast::Receiver<Arc<Event>>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(e) = rx.try_recv() {
        if let Event::Say { text, .. } = &*e {
            out.push(text.clone());
        }
    }
    out
}

fn ran(w: &World) -> usize {
    w.ran.lock().unwrap().len()
}

/// Looks until four results are in, then answers.
fn four_steps() -> Script {
    Arc::new(|req| {
        if tool_turns(req) < 4 {
            vec![ChatChunk::ToolCall(call(
                &format!("n{}", tool_turns(req)),
                "look",
            ))]
        } else {
            vec![ChatChunk::Text("All four done.".into())]
        }
    })
}

#[tokio::test]
async fn resumes_from_last_step() {
    let w = world(four_steps(), Limits::default(), 0).await;
    let mut rx = w.bus.subscribe();
    seed(&w, "r1", "look four times", 2, false, 1000);
    assert_eq!(resume(&w).await, 1);
    // 2 of 4 were done before the kill; exactly 2 more ran.
    assert_eq!(ran(&w), 2);
    assert_eq!(tool_rows(&w).len(), 4);
    assert!(w.store.live_runs().unwrap().is_empty());
    let said = said(&mut rx);
    assert_eq!(said[0], "Picking up where I stopped: look four times.");
    assert_eq!(said.last().unwrap(), "All four done.");
    // The trace counted on from step 2, not from 0.
    let saved = w.store.run_body("r1").unwrap().expect("the run was saved");
    assert!(saved
        .to_string()
        .contains("Resumed after a restart at step 2"));
    w.host.shutdown().await;
}

#[tokio::test]
async fn dangling_answered() {
    let w = world(four_steps(), Limits::default(), 0).await;
    let s = w.session;
    w.store.append(s, Role::User, None, &body("go")).unwrap();
    w.store
        .append(
            s,
            Role::Assistant,
            None,
            &tool_calls(&[("a", "look"), ("b", "wipe"), ("c", "look")]),
        )
        .unwrap();
    w.store
        .append(s, Role::Tool, None, &tool_result("a", "look done"))
        .unwrap();
    live_row(&w, "d1", 0, false, 1000);
    let row = w.store.live_runs().unwrap().remove(0);
    let n = answer_dangling(
        &w.store,
        &row,
        "not run: Alexia restarted before it finished",
    )
    .unwrap();
    assert_eq!(n, 2);
    let tools = tool_rows(&w);
    assert_eq!(tools.len(), 3);
    assert_eq!(tools[1].0, "b");
    assert_eq!(tools[1].1, "not run: Alexia restarted before it finished");
    assert_eq!(tools[2].0, "c");
    let audit = w.store.audit_search("", 10).unwrap();
    assert_eq!(audit.len(), 2);
    assert!(audit.iter().all(|a| a.decision == "unanswered"));
    // Nothing ran, and a second pass has nothing left to answer.
    assert_eq!(ran(&w), 0);
    assert_eq!(answer_dangling(&w.store, &row, "again").unwrap(), 0);
    assert_eq!(tool_rows(&w).len(), 3);
    w.host.shutdown().await;
}

#[tokio::test]
async fn waiting_approval_reasked() {
    // After the restart note the model asks for the same destructive step again.
    let script: Script = Arc::new(|req| {
        let last = req
            .messages
            .iter()
            .rev()
            .find(|(r, _)| *r == Role::Tool)
            .map(|(_, b)| b.content.text())
            .unwrap_or_default();
        if last.starts_with("not run:") {
            vec![ChatChunk::ToolCall(call("again", "wipe"))]
        } else {
            vec![ChatChunk::Text("Wiped.".into())]
        }
    });
    let w = world(script, Limits::default(), 0).await;
    let s = w.session;
    w.store
        .append(s, Role::User, None, &body("clean up"))
        .unwrap();
    w.store
        .append(s, Role::Assistant, None, &tool_calls(&[("w1", "wipe")]))
        .unwrap();
    live_row(&w, "r2", 0, false, 1000);
    // The question that was open when the hub stopped.
    let old = w
        .store
        .approval_open("r2", "{}", "Run wipe?", None, alexia_store::now_ms())
        .unwrap();
    assert_eq!(resume(&w).await, 1);
    // Asked again, now, and only then did the step run.
    assert_eq!(w.questions.lock().unwrap().len(), 1);
    assert_eq!(*w.ran.lock().unwrap(), vec!["wipe".to_string()]);
    let tools = tool_rows(&w);
    assert_eq!(tools[0].0, "w1");
    assert!(tools[0].1.starts_with("not run:"));
    assert_eq!(tools[1].0, "again");
    assert!(tools[1].1.contains("wipe done"), "{}", tools[1].1);
    // The dead question is closed, not left in the inbox forever.
    assert!(w
        .store
        .approval(old)
        .unwrap()
        .unwrap()
        .answered_at
        .is_some());
    w.host.shutdown().await;
}

#[tokio::test]
async fn old_run_ended_not_resumed() {
    let w = world(four_steps(), Limits::default(), 0).await;
    let mut rx = w.bus.subscribe();
    let week = 8 * 24 * 3600 * 1000;
    seed(&w, "old", "look four times", 2, false, week);
    assert_eq!(resume(&w).await, 0);
    assert_eq!(*w.model_calls.lock().unwrap(), 0);
    assert_eq!(ran(&w), 0);
    assert!(w.store.live_runs().unwrap().is_empty());
    assert!(said(&mut rx).is_empty());
    let saved = w.store.run_body("old").unwrap().expect("the run was saved");
    assert!(saved.to_string().contains("7 days"), "{saved}");
    w.host.shutdown().await;
}

#[tokio::test]
async fn deleted_session_ended() {
    let w = world(four_steps(), Limits::default(), 0).await;
    seed(&w, "gone", "look four times", 2, false, 1000);
    w.store.delete_session(w.session).unwrap();
    assert_eq!(resume(&w).await, 0);
    assert_eq!(*w.model_calls.lock().unwrap(), 0);
    assert_eq!(ran(&w), 0);
    assert!(w.store.live_runs().unwrap().is_empty());
    w.host.shutdown().await;
}

#[tokio::test]
async fn background_gets_big_ceiling() {
    // Always wants one more look. Foreground ceiling 3, background ceiling 6; 2 steps done.
    let forever: Script = Arc::new(|req| {
        vec![ChatChunk::ToolCall(call(
            &format!("n{}", tool_turns(req)),
            "look",
        ))]
    });
    let limits = Limits {
        max_steps: 3,
        background_steps: 6,
        helper_steps: 2,
    };
    let fg = world(forever.clone(), limits, 0).await;
    seed(&fg, "fg", "keep looking", 2, false, 1000);
    assert_eq!(resume(&fg).await, 1);
    assert_eq!(ran(&fg), 1, "foreground stops at 3 steps in all");
    fg.host.shutdown().await;

    let bg = world(forever, limits, 0).await;
    seed(&bg, "bg", "keep looking", 2, true, 1000);
    assert_eq!(resume(&bg).await, 1);
    assert_eq!(ran(&bg), 4, "background stops at 6 steps in all");
    assert!(bg.store.live_runs().unwrap().is_empty());
    bg.host.shutdown().await;
}

#[tokio::test]
async fn resume_does_not_reinsert_live_row() {
    // Each step takes a while, so the run is still going when we look.
    let w = world(four_steps(), Limits::default(), 1500).await;
    seed(&w, "r3", "look four times", 2, false, 1000);
    let tracker = TaskTracker::new();
    let n = resume_all(w.agent.clone(), &tracker, CancellationToken::new()).await;
    assert_eq!(n, 1);
    // The row that survived the restart is the only one while the run goes on.
    assert_eq!(w.store.live_runs().unwrap().len(), 1);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let rows = w.store.live_runs().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].run, "r3");
    tracker.close();
    tokio::time::timeout(Duration::from_secs(60), tracker.wait())
        .await
        .expect("the resumed run finished");
    assert!(w.store.live_runs().unwrap().is_empty());
    assert_eq!(ran(&w), 2);
    w.host.shutdown().await;
}

fn live_row_at(w: &World, run: &str, started_ago: i64, touched_ago: i64) {
    let now = alexia_store::now_ms();
    w.store
        .live_begin(&LiveRunRow {
            run: run.into(),
            session: w.session,
            origin: serde_json::to_string(&Origin::Desktop).unwrap(),
            started_at: now - started_ago,
            touched_at: now - touched_ago,
            steps: 2,
            background: true,
            parent: None,
        })
        .unwrap();
}

const HOUR: i64 = 3600 * 1000;
const DAY: i64 = 24 * HOUR;

#[tokio::test]
async fn old_run_that_moved_lately_resumes() {
    let w = world(four_steps(), Limits::default(), 0).await;
    w.store
        .append(w.session, Role::User, None, &body("look"))
        .unwrap();
    live_row_at(&w, "long", 10 * DAY, HOUR);
    assert_eq!(resume(&w).await, 1);
    assert!(w.store.live_runs().unwrap().is_empty());
    assert!(*w.model_calls.lock().unwrap() > 0);
    w.host.shutdown().await;
}

#[tokio::test]
async fn stale_run_is_ended() {
    let w = world(four_steps(), Limits::default(), 0).await;
    w.store
        .append(w.session, Role::User, None, &body("look"))
        .unwrap();
    live_row_at(&w, "stale", 10 * DAY, 8 * DAY);
    assert_eq!(resume(&w).await, 0);
    assert_eq!(*w.model_calls.lock().unwrap(), 0);
    assert!(w.store.live_runs().unwrap().is_empty());
    let saved = w
        .store
        .run_body("stale")
        .unwrap()
        .expect("the run was saved");
    assert!(
        saved
            .to_string()
            .contains("had not moved for more than 7 days"),
        "{saved}"
    );
    w.host.shutdown().await;
}

#[tokio::test]
async fn ended_run_closes_its_questions() {
    let w = world(four_steps(), Limits::default(), 0).await;
    // A run that is ended at boot (its origin cannot be read; a gone session deletes the row).
    w.store
        .live_begin(&LiveRunRow {
            run: "gone".into(),
            session: w.session,
            origin: "garbage".into(),
            started_at: alexia_store::now_ms(),
            touched_at: alexia_store::now_ms(),
            steps: 0,
            background: false,
            parent: None,
        })
        .unwrap();
    let q = w
        .store
        .approval_open("gone", "{}", "Run wipe?", None, alexia_store::now_ms())
        .unwrap();
    assert_eq!(resume(&w).await, 0);
    let a = w.store.approval(q).unwrap().unwrap();
    assert!(a.answered_at.is_some());
    assert_eq!(a.answer, Some(false));
    assert_eq!(a.via.as_deref(), Some("restart"));
    w.host.shutdown().await;
}

#[tokio::test]
async fn audit_names_its_own_run() {
    let w = world(four_steps(), Limits::default(), 0).await;
    let s = w.session;
    w.store.append(s, Role::User, None, &body("go")).unwrap();
    w.store
        .append(s, Role::Assistant, None, &tool_calls(&[("a", "wipe")]))
        .unwrap();
    live_row_at(&w, "first", 2 * HOUR, HOUR);
    live_row_at(&w, "second", HOUR, HOUR);
    let rows = w.store.live_runs().unwrap();
    let second = rows.iter().find(|r| r.run == "second").unwrap();
    assert_eq!(answer_dangling(&w.store, second, "no").unwrap(), 1);
    let audit = w.store.audit_search("", 10).unwrap();
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0].run, "second");
    w.host.shutdown().await;
}
