// SPDX-License-Identifier: AGPL-3.0-only
//! P2-27: parallel helpers. A fake model answers by the goal it is given, a fake `Tooling`
//! routes `helpers.run` to the real builtin. Real time (no `test-util`); concurrency is shown
//! by a barrier the helpers' tool calls must all reach together.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use alexia_core::agent::{Agent, AgentParts};
use alexia_core::catalog::Catalog;
use alexia_core::chat::Caps;
use alexia_core::checker::Checker;
use alexia_core::free::{Auth, FreeRow};
use alexia_core::helpers::Helpers;
use alexia_core::router::Router;
use alexia_core::{
    Ask, Builtin, Bus, ChatChunk, ChatDone, ChatRequest, Limits, ModelInfo, Origin, Provider,
    ProviderError, Question, RunId, ToolCtx, ToolOutcome, ToolSpec, Tooling,
};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, Timings};
use alexia_store::{Layout, Role, Store, ToolCall};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

type Script = Arc<dyn Fn(&ChatRequest) -> Result<Vec<ChatChunk>, ProviderError> + Send + Sync>;

struct FakeModel {
    script: Script,
    asked: Arc<Mutex<Vec<ChatRequest>>>,
    /// After the first chunk, wait here until stopped.
    hang: bool,
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
        cancel: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        self.asked.lock().unwrap().push(req.clone());
        for chunk in (self.script)(req)? {
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

struct FakeTools {
    helpers: OnceLock<Arc<Helpers>>,
    store: OnceLock<Arc<Store>>,
    /// `(run, parent)` of every live run, seen once the three `look` calls met.
    live: Mutex<Vec<(String, Option<String>)>>,
    /// `look` waits for this many callers to be there at once.
    barrier: Option<Arc<tokio::sync::Barrier>>,
}

#[async_trait::async_trait]
impl Tooling for FakeTools {
    async fn list(&self) -> Vec<ToolSpec> {
        vec![
            spec("look", true),
            spec("wipe", false),
            spec("helpers.run", true),
        ]
    }
    async fn call(&self, name: &str, args: Map<String, Value>, ctx: ToolCtx) -> ToolOutcome {
        if name == "helpers.run" {
            let h = self.helpers.get().unwrap();
            return h.call(name, &args, &ctx).await.unwrap();
        }
        if name == "look" {
            if let Some(b) = &self.barrier {
                let met = tokio::time::timeout(Duration::from_secs(30), b.wait())
                    .await
                    .is_ok();
                if let Some(store) = self.store.get() {
                    let rows = store.live_runs().unwrap();
                    let mut seen = self.live.lock().unwrap();
                    seen.extend(rows.into_iter().map(|r| (r.run, r.parent)));
                }
                return ok(if met { "met" } else { "alone" });
            }
        }
        ok(&format!("{name} done"))
    }
}

struct FakeAsk {
    origins: Arc<Mutex<Vec<Origin>>>,
}

#[async_trait::async_trait]
impl Ask for FakeAsk {
    async fn confirm(&self, origin: &Origin, _: &Question, _: CancellationToken) -> bool {
        self.origins.lock().unwrap().push(origin.clone());
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
    /// Helpers holds the agent weakly: the world keeps it alive.
    _agent: Arc<Agent>,
    tools: Arc<FakeTools>,
    store: Arc<Store>,
    helpers: Arc<Helpers>,
    asked: Arc<Mutex<Vec<ChatRequest>>>,
    origins: Arc<Mutex<Vec<Origin>>>,
    host: McpHost,
    root: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

async fn world(script: Script, hang: bool, barrier: Option<usize>) -> World {
    static N: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "alexia-helpers-test-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(root.join("ext")).unwrap();
    std::fs::create_dir_all(root.join("data")).unwrap();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let p: Arc<dyn Provider> = Arc::new(FakeModel {
        script,
        asked: asked.clone(),
        hang,
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
    let tools = Arc::new(FakeTools {
        helpers: OnceLock::new(),
        store: OnceLock::new(),
        live: Mutex::default(),
        barrier: barrier.map(|n| Arc::new(tokio::sync::Barrier::new(n))),
    });
    let origins = Arc::new(Mutex::new(Vec::new()));
    let agent = Agent::new(AgentParts {
        router,
        tools: tools.clone(),
        store: store.clone(),
        bus: Bus::new(64),
        ask: Arc::new(FakeAsk {
            origins: origins.clone(),
        }),
        checker: Arc::new(Checker::new(None)),
        caps: Arc::new(NoCaps),
        layout: Layout::new(root.join("data")),
        limits: Limits::default(),
        host: host.clone(),
    });
    let helpers = Helpers::new(&agent);
    let _ = tools.helpers.set(helpers.clone());
    let _ = tools.store.set(store.clone());
    World {
        _agent: agent,
        tools,
        store,
        helpers,
        asked,
        origins,
        host,
        root,
    }
}

fn ctx(origin: Origin, cancel: CancellationToken) -> ToolCtx {
    ToolCtx {
        session: alexia_store::SessionId(1),
        run: RunId("parent".into()),
        origin,
        background: false,
        cancel,
        progress: None,
    }
}

fn tasks(goals: &[&str]) -> Map<String, Value> {
    let t: Vec<Value> = goals.iter().map(|g| json!({ "goal": g })).collect();
    json!({ "tasks": t }).as_object().cloned().unwrap()
}

async fn run(w: &World, goals: &[&str], c: ToolCtx) -> ToolOutcome {
    tokio::time::timeout(
        Duration::from_secs(60),
        w.helpers.call("helpers.run", &tasks(goals), &c),
    )
    .await
    .expect("helpers finished")
    .expect("helpers.run is the helpers' tool")
}

fn desktop() -> ToolCtx {
    ctx(Origin::Desktop, CancellationToken::new())
}

fn say(t: &str) -> Result<Vec<ChatChunk>, ProviderError> {
    Ok(vec![ChatChunk::Text(t.into())])
}

fn call(name: &str) -> ChatChunk {
    ChatChunk::ToolCall(ToolCall {
        id: format!("c-{name}"),
        name: name.into(),
        arguments: "{}".into(),
    })
}

/// Everything the request says, as one string.
fn heard(req: &ChatRequest) -> String {
    req.messages
        .iter()
        .map(|(_, b)| b.content.text())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The last tool result. The loop wraps tool text in an untrusted block (marker line, the
/// text, closing line, warning): the second line is the result itself.
fn tool_said(req: &ChatRequest) -> Option<String> {
    req.messages
        .iter()
        .rev()
        .find(|(r, _)| *r == Role::Tool)
        .map(|(_, b)| {
            let t = b.content.text();
            t.lines().nth(1).unwrap_or(&t).to_owned()
        })
}

#[tokio::test]
async fn three_helpers_run_concurrently() {
    // Each helper's `look` waits for all three: run one after another, they would never meet.
    let w = world(
        Arc::new(|req| match tool_said(req) {
            Some(t) => say(&format!("saw {t}")),
            None => Ok(vec![call("look")]),
        }),
        false,
        Some(3),
    )
    .await;
    let r = run(&w, &["alpha", "beta", "gamma"], desktop()).await;
    assert!(r.ok, "{}", r.text);
    assert_eq!(
        r.text,
        "Helper 1 (alpha): saw met\n\nHelper 2 (beta): saw met\n\nHelper 3 (gamma): saw met"
    );
    // Each has its own session and its own run row with the parent.
    let titled: Vec<String> = w
        .store
        .sessions()
        .unwrap()
        .into_iter()
        .filter_map(|s| s.title)
        .collect();
    for g in ["alpha", "beta", "gamma"] {
        assert!(
            titled.iter().any(|t| t.ends_with(&format!("Helper: {g}"))),
            "{titled:?}"
        );
    }
    let runs = w.store.runs(10).unwrap();
    assert_eq!(runs.len(), 3);
    // While they ran, each had a live row naming the parent (the row goes when a run ends).
    let live = w.tools.live.lock().unwrap().clone();
    let mut ids: Vec<&String> = live
        .iter()
        .filter(|(id, parent)| id.starts_with("parent.h") && parent.as_deref() == Some("parent"))
        .map(|(id, _)| id)
        .collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 3, "{live:?}");
    w.host.shutdown().await;
}

#[tokio::test]
async fn helper_cannot_spawn_helpers() {
    let w = world(
        Arc::new(|req| match tool_said(req) {
            Some(t) => say(&format!("tool said: {t}")),
            None => Ok(vec![call("helpers.run")]),
        }),
        false,
        None,
    )
    .await;
    let r = run(&w, &["nest"], desktop()).await;
    assert!(r.ok, "{}", r.text);
    assert_eq!(
        r.text,
        "Helper 1 (nest): tool said: Helpers cannot start helpers."
    );
    // One run only: nothing was nested.
    assert_eq!(w.store.runs(10).unwrap().len(), 1);
    w.host.shutdown().await;
}

#[tokio::test]
async fn parent_cancel_stops_helpers() {
    let w = world(Arc::new(|_| say("working")), true, None).await;
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let asked = w.asked.clone();
    tokio::spawn(async move {
        // Cancel once all three helpers are mid-answer.
        for _ in 0..600 {
            if asked.lock().unwrap().len() >= 3 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        stop.cancel();
    });
    let r = run(&w, &["a", "b", "c"], ctx(Origin::Desktop, cancel)).await;
    assert!(r.ok, "{}", r.text);
    for (i, g) in ["a", "b", "c"].iter().enumerate() {
        let want = format!("Helper {} ({g}): stopped before it finished.", i + 1);
        assert!(r.text.contains(&want), "{}", r.text);
    }
    w.host.shutdown().await;
}

#[tokio::test]
async fn one_failure_others_answer() {
    let w = world(
        Arc::new(|req| {
            if heard(req).contains("bad") {
                Err(ProviderError::Refused("no".into()))
            } else {
                say("fine")
            }
        }),
        false,
        None,
    )
    .await;
    let r = run(&w, &["good one", "bad one", "good two"], desktop()).await;
    assert!(r.ok, "{}", r.text);
    let parts: Vec<&str> = r.text.split("\n\n").collect();
    assert_eq!(parts.len(), 3, "{}", r.text);
    assert_eq!(parts[0], "Helper 1 (good one): fine");
    assert!(
        parts[1].starts_with("Helper 2 (bad one): could not finish"),
        "{}",
        parts[1]
    );
    assert_eq!(parts[2], "Helper 3 (good two): fine");
    w.host.shutdown().await;
}

#[tokio::test]
async fn approvals_go_to_parent_origin() {
    let w = world(
        Arc::new(|req| match tool_said(req) {
            Some(t) => say(&t),
            None => Ok(vec![call("wipe")]),
        }),
        false,
        None,
    )
    .await;
    let origin = Origin::Channel {
        channel: "telegram".into(),
        chat: "42".into(),
    };
    let r = run(
        &w,
        &["clean"],
        ctx(origin.clone(), CancellationToken::new()),
    )
    .await;
    assert!(r.ok, "{}", r.text);
    assert_eq!(r.text, "Helper 1 (clean): wipe done");
    assert_eq!(*w.origins.lock().unwrap(), vec![origin]);
    w.host.shutdown().await;
}

#[tokio::test]
async fn more_than_four_refused() {
    let w = world(Arc::new(|_| say("hi")), false, None).await;
    let r = run(&w, &["1", "2", "3", "4", "5"], desktop()).await;
    assert!(!r.ok);
    assert!(r.text.contains("1 to 4"), "{}", r.text);
    let none = run(&w, &[], desktop()).await;
    assert!(!none.ok);
    // Nothing was started.
    assert!(w.asked.lock().unwrap().is_empty());
    assert!(w.store.runs(10).unwrap().is_empty());
    // Exactly four is fine.
    let four = run(&w, &["1", "2", "3", "4"], desktop()).await;
    assert!(four.ok, "{}", four.text);
    w.host.shutdown().await;
}

#[tokio::test]
async fn other_tools_are_not_mine() {
    let w = world(Arc::new(|_| say("hi")), false, None).await;
    let c = desktop();
    assert!(w.helpers.call("look", &Map::new(), &c).await.is_none());
    assert_eq!(w.helpers.specs()[0].name, "helpers.run");
    w.host.shutdown().await;
}

fn live_row(
    run: &str,
    session: alexia_store::SessionId,
    parent: Option<&str>,
) -> alexia_store::LiveRunRow {
    alexia_store::LiveRunRow {
        run: run.into(),
        session,
        origin: serde_json::to_string(&Origin::Desktop).unwrap(),
        started_at: 1,
        touched_at: 1,
        steps: 0,
        background: false,
        parent: parent.map(String::from),
    }
}

#[tokio::test]
async fn depth_is_read_from_the_store_after_a_restart() {
    // A helper resumed after a restart is in no memory set: only its live row says it is one.
    let w = world(Arc::new(|_| say("hi")), false, None).await;
    let s = w.store.create_session(Some("old helper")).unwrap();
    w.store
        .live_begin(&live_row("old.h-1-0", s, Some("old")))
        .unwrap();
    let c = ctx(Origin::Desktop, CancellationToken::new());
    let c = ToolCtx {
        run: RunId("old.h-1-0".into()),
        ..c
    };
    let r = run(&w, &["nest"], c).await;
    assert!(!r.ok);
    assert_eq!(r.text, "Helpers cannot start helpers.");
    assert!(w.asked.lock().unwrap().is_empty());
    // A top-level run with a live row (no parent) may start helpers.
    w.store.live_begin(&live_row("top", s, None)).unwrap();
    let c = ToolCtx {
        run: RunId("top".into()),
        ..desktop()
    };
    let r = run(&w, &["fine"], c).await;
    assert!(r.ok, "{}", r.text);
    w.host.shutdown().await;
}

#[tokio::test]
async fn ids_do_not_collide_with_rows_from_before_a_restart() {
    // Rows left by an earlier process under the old `<parent>.h<n>` ids.
    let w = world(Arc::new(|_| say("fine")), false, None).await;
    let s = w.store.create_session(Some("left over")).unwrap();
    for n in 0..4 {
        w.store
            .live_begin(&live_row(&format!("parent.h{n}"), s, Some("parent")))
            .unwrap();
    }
    let r = run(&w, &["a", "b", "c"], desktop()).await;
    assert!(r.ok, "{}", r.text);
    assert_eq!(
        r.text,
        "Helper 1 (a): fine\n\nHelper 2 (b): fine\n\nHelper 3 (c): fine"
    );
    w.host.shutdown().await;
}

#[tokio::test]
async fn two_calls_in_one_step_do_not_clear_each_other() {
    // Call A's helper waits at `look` for the test. Call B, same parent run, finishes first.
    // A's helper must still count as a helper afterwards.
    let w = world(
        Arc::new(|req| {
            if !heard(req).contains("slow") {
                return say("fine");
            }
            match tool_said(req).as_deref() {
                None => Ok(vec![call("look")]),
                Some("met") => Ok(vec![call("helpers.run")]),
                Some(t) => say(&format!("then: {t}")),
            }
        }),
        false,
        Some(2),
    )
    .await;
    let h = w.helpers.clone();
    let a = tokio::spawn(async move {
        h.call("helpers.run", &tasks(&["slow"]), &desktop())
            .await
            .unwrap()
    });
    // Wait until A's helper is at `look` (its run is live), then run B to the end.
    for _ in 0..600 {
        if !w.store.live_runs().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let b = run(&w, &["quick"], desktop()).await;
    assert_eq!(b.text, "Helper 1 (quick): fine");
    let gate = w.tools.barrier.clone().unwrap();
    tokio::time::timeout(Duration::from_secs(30), gate.wait())
        .await
        .expect("A's helper reached look");
    let a = tokio::time::timeout(Duration::from_secs(60), a)
        .await
        .expect("A finished")
        .unwrap();
    assert_eq!(
        a.text,
        "Helper 1 (slow): then: Helpers cannot start helpers."
    );
    w.host.shutdown().await;
}
