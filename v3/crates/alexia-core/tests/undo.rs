// SPDX-License-Identifier: AGPL-3.0-only
//! P2-28: undo, over a fake Tooling and a fake Ask.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use alexia_core::agent::{Agent, AgentParts};
use alexia_core::catalog::Catalog;
use alexia_core::chat::Caps;
use alexia_core::checker::Checker;
use alexia_core::router::Router;
use alexia_core::undo::{undo_last, UndoTool};
use alexia_core::{
    Ask, Builtin, Bus, Limits, Origin, Question, RunId, ToolCtx, ToolOutcome, ToolSpec, Tooling,
};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, Timings};
use alexia_store::{now_ms, AuditRow, Layout, SessionId, Store};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

struct Fake {
    calls: Mutex<Vec<(String, Map<String, Value>)>>,
    works: AtomicBool,
    gone: AtomicBool,
}

/// "restore" is read-only (runs without asking); "erase" is destructive (asks).
#[async_trait::async_trait]
impl Tooling for Fake {
    async fn list(&self) -> Vec<ToolSpec> {
        if self.gone.load(Ordering::SeqCst) {
            return Vec::new();
        }
        vec![spec("restore", true), spec("erase", false)]
    }
    async fn call(&self, name: &str, args: Map<String, Value>, _: ToolCtx) -> ToolOutcome {
        self.calls.lock().unwrap().push((name.into(), args));
        let ok = self.works.load(Ordering::SeqCst);
        ToolOutcome {
            text: if ok {
                "restored".into()
            } else {
                "disk full".into()
            },
            ok,
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

struct FakeAsk {
    yes: AtomicBool,
    asked: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl Ask for FakeAsk {
    async fn confirm(&self, _: &Origin, q: &Question, _: CancellationToken) -> bool {
        self.asked.lock().unwrap().push(q.text.clone());
        self.yes.load(Ordering::SeqCst)
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
    tools: Arc<Fake>,
    ask: Arc<FakeAsk>,
    session: SessionId,
    root: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

async fn world() -> World {
    static N: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "alexia-undo-test-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(root.join("ext")).unwrap();
    std::fs::create_dir_all(root.join("data")).unwrap();
    let catalog = Arc::new(Catalog::new(vec![], vec![], root.join("catalog.json")));
    let store = Arc::new(Store::open_in_memory().unwrap());
    let session = store.create_session(None).unwrap();
    let router = Arc::new(Router::new(vec![], catalog, store.clone()));
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
    let tools = Arc::new(Fake {
        calls: Mutex::default(),
        works: AtomicBool::new(true),
        gone: AtomicBool::new(false),
    });
    let ask = Arc::new(FakeAsk {
        yes: AtomicBool::new(true),
        asked: Mutex::default(),
    });
    let agent = Agent::new(AgentParts {
        router,
        tools: tools.clone(),
        store: store.clone(),
        bus: Bus::new(64),
        ask: ask.clone(),
        checker: Arc::new(Checker::new(None)),
        caps: Arc::new(NoCaps),
        layout: Layout::new(root.join("data")),
        limits: Limits::default(),
        host,
    });
    World {
        agent,
        store,
        tools,
        ask,
        session,
        root,
    }
}

/// An audit row that declared an inverse; returns its id.
fn did(w: &World, session: SessionId, at: i64, tool: &str, summary: &str) -> i64 {
    let undo = json!({ "tool": tool, "arguments": { "what": summary }, "summary": summary });
    w.store
        .audit(&AuditRow {
            id: 0,
            at,
            run: "r-old".into(),
            session: Some(session),
            origin: serde_json::to_string(&Origin::Desktop).unwrap(),
            step: 1,
            tool: "made".into(),
            plugin: None,
            args: "{}".into(),
            gate: "run".into(),
            decision: "ran".into(),
            why: None,
            ok: Some(true),
            result: Some("done".into()),
            undo: Some(undo.to_string()),
            undone_at: None,
        })
        .unwrap()
}

async fn undo(w: &World, session: SessionId) -> String {
    undo_last(
        &w.agent,
        session,
        &Origin::Desktop,
        CancellationToken::new(),
    )
    .await
}

fn undoable(w: &World, session: SessionId) -> Option<i64> {
    w.store.last_undoable(session).unwrap().map(|r| r.id)
}

const NOTHING: &str = "There is nothing I can undo in this conversation.";

#[tokio::test]
async fn undo_reverses_newest() {
    let w = world().await;
    let t = now_ms();
    let older = did(&w, w.session, t - 2000, "restore", "the old file");
    let newer = did(&w, w.session, t - 1000, "restore", "the new file.");
    assert_eq!(undo(&w, w.session).await, "Undone: the new file.");
    {
        let calls = w.tools.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "restore");
        assert_eq!(calls[0].1["what"], "the new file.");
    }
    assert_eq!(undoable(&w, w.session), Some(older));
    // Its own audit row says what it was and why.
    let why = format!("undo of #{newer}");
    let own: Vec<_> = w
        .store
        .audit_search("restore", 10)
        .unwrap()
        .into_iter()
        .filter(|r| r.why.as_deref() == Some(why.as_str()))
        .collect();
    assert_eq!(own.len(), 1);
    assert_eq!(own[0].gate, "run");
    assert_eq!(own[0].decision, "ran");
    assert_eq!(own[0].ok, Some(true));
    assert!(own[0].undo.is_none());
}

#[tokio::test]
async fn undone_not_undone_twice() {
    let w = world().await;
    did(&w, w.session, now_ms() - 1000, "restore", "the file");
    assert_eq!(undo(&w, w.session).await, "Undone: the file.");
    assert_eq!(undo(&w, w.session).await, NOTHING);
    assert_eq!(w.tools.calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn nothing_to_undo() {
    let w = world().await;
    assert_eq!(undo(&w, w.session).await, NOTHING);
    assert!(w.tools.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn inverse_gated_and_can_be_denied() {
    let w = world().await;
    let id = did(&w, w.session, now_ms() - 1000, "erase", "the draft");
    w.ask.yes.store(false, Ordering::SeqCst);
    let said = undo(&w, w.session).await;
    assert!(said.contains("did not approve"), "{said}");
    assert_eq!(w.ask.asked.lock().unwrap().len(), 1);
    assert!(w.tools.calls.lock().unwrap().is_empty());
    assert_eq!(undoable(&w, w.session), Some(id));

    w.ask.yes.store(true, Ordering::SeqCst);
    assert_eq!(undo(&w, w.session).await, "Undone: the draft.");
    assert_eq!(w.ask.asked.lock().unwrap().len(), 2);
    assert_eq!(w.tools.calls.lock().unwrap().len(), 1);
    assert_eq!(undoable(&w, w.session), None);
}

#[tokio::test]
async fn failed_inverse_stays_undoable() {
    let w = world().await;
    let id = did(&w, w.session, now_ms() - 1000, "restore", "the file");
    w.tools.works.store(false, Ordering::SeqCst);
    let said = undo(&w, w.session).await;
    assert!(
        said.contains("could not undo") && said.contains("disk full"),
        "{said}"
    );
    assert_eq!(undoable(&w, w.session), Some(id));

    // A tool that has vanished is also a refusal that leaves the row alone.
    w.tools.gone.store(true, Ordering::SeqCst);
    assert!(undo(&w, w.session).await.contains("not available any more"));
    assert_eq!(undoable(&w, w.session), Some(id));

    w.tools.gone.store(false, Ordering::SeqCst);
    w.tools.works.store(true, Ordering::SeqCst);
    assert_eq!(undo(&w, w.session).await, "Undone: the file.");
}

#[tokio::test]
async fn other_session_untouched() {
    let w = world().await;
    let other = w.store.create_session(None).unwrap();
    let theirs = did(&w, other, now_ms() - 500, "restore", "their file");
    assert_eq!(undo(&w, w.session).await, NOTHING);
    assert_eq!(undoable(&w, other), Some(theirs));
    assert!(w.tools.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn undo_last_tool_runs_the_same_path() {
    let w = world().await;
    let tool = UndoTool::new(&w.agent);
    let specs = tool.specs();
    assert_eq!(specs.len(), 1);
    assert_eq!(specs[0].name, "undo.last");
    let ctx = ToolCtx {
        session: w.session,
        run: RunId("r-1".into()),
        origin: Origin::Desktop,
        background: false,
        cancel: CancellationToken::new(),
        progress: None,
    };
    assert!(tool.call("other", &Map::new(), &ctx).await.is_none());
    let empty = tool.call("undo.last", &Map::new(), &ctx).await.unwrap();
    assert!(!empty.ok);
    did(&w, w.session, now_ms() - 1000, "restore", "the file");
    let out = tool.call("undo.last", &Map::new(), &ctx).await.unwrap();
    assert!(out.ok);
    assert_eq!(out.text, "Undone: the file.");
}
