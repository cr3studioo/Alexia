// SPDX-License-Identifier: AGPL-3.0-only
//! P2D-03: what core tells the window. Structured progress from a plugin's `_meta`, research
//! snapshots per session, step frames in order, notes, commands from `Origin::Window`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

mod scratch;
use scratch::Scratch;

use alexia_core::agent::{Agent, AgentParts, Task};
use alexia_core::catalog::Catalog;
use alexia_core::chat::Caps;
use alexia_core::checker::Checker;
use alexia_core::free::{Auth, FreeRow};
use alexia_core::router::Router;
use alexia_core::tools::McpTooling;
use alexia_core::{
    Ask, Brain, Bus, ChatChunk, ChatDone, ChatRequest, DraftFrame, Lane, Limits, ModelInfo, Origin,
    Provider, ProviderError, Question, Reply, RunId, Steer, StepFrame, ToolCtx, ToolOutcome,
    ToolProgress, ToolSpec, Tooling, Turn,
};
use alexia_mcp::{EventSink, HostConfig, McpHost, NoUpcalls, PluginId, Timings};
use alexia_store::{Content, Layout, MessageBody, Role, SessionId, Store, ToolCall};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

// ---- a node plugin that reports progress with `_meta` ----

/// `work` reports progress and answers "worked". `{"mode":"meta"}` sends three reports: every
/// key filled in, then a `file:` preview and a plan without stages, then malformed stages.
/// `{"mode":"research","topic":t}` sends one research snapshot for the call's conversation
/// (`"wrong":true`: for another conversation).
const PLUGIN: &str = r#"
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const research = (conversationId, topic) => ({
  runId: 'run-' + topic, conversationId, sequence: 1, topic, startedAt: 1, elapsedMs: 2,
  stage: 'reading', completion: 'running', extra: 'dropped',
  counters: { read: 0, inProgress: 0, failed: 0 },
  sources: [
    { id: 's1', url: 'https://example.com/a', title: 'A', state: 'complete' },
    { id: 's2', url: 'https://example.com/b', title: 'B', state: 'fetching' },
  ],
});
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, serverInfo: { name: 'n', version: '0' }, capabilities: { tools: {} } } });
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'work', inputSchema: { type: 'object' } }] } });
  else if (m.method === 'tools/call') {
    const meta = m.params._meta || {};
    const token = meta.progressToken;
    const conv = (meta['alexia/call-context'] || {}).conversationId;
    const a = m.params.arguments || {};
    const progress = (p, _meta) => token !== undefined && send({ method: 'notifications/progress', params: { progressToken: token, progress: p, total: 3, message: 'step ' + p, _meta } });
    if (a.mode === 'meta') {
      progress(1, {
        'alexia/stages': [{ label: 'open', state: 'done' }, { label: 'press', state: 'running', progress: 1, total: 2 }],
        'alexia/plan': true,
        'alexia/controls': [{ key: 'pause', label: ' Pause ' }, { key: 'Bad Key', label: 'x' }],
        'alexia/preview': 'data:image/png;base64,AAAA',
        'alexia/research': research(conv, a.topic),
      });
      progress(2, { 'alexia/preview': 'file:///C:/secret.png', 'alexia/plan': true });
      progress(3, { 'alexia/stages': [{ label: 'x', state: 'bogus' }], 'alexia/plan': true });
    } else if (a.mode === 'research') {
      progress(1, { 'alexia/research': research(a.wrong ? 'someone-else' : conv, a.topic) });
    }
    send({ id: m.id, result: { content: [{ type: 'text', text: 'worked' }] } });
  } else send({ id: m.id, result: {} });
});
"#;

struct Env {
    host: McpHost,
    /// Last, so it drops after the host: the folder goes once its plugin has.
    _root: Scratch,
}

async fn plugin_env(tag: &str) -> Env {
    let root = Scratch::new(&format!("window-{tag}"));
    let ext = root.join("ext");
    let dir = ext.join("reporter");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("plugin.js"), PLUGIN).unwrap();
    let m = json!({
        "manifest_version": 1, "id": "reporter", "name": "Reporter",
        "summary": "A plugin that exists for tests.", "version": "0.1.0",
        "license": "AGPL-3.0-only", "entry": { "run": "node", "args": ["plugin.js"] },
        "alexia_protocol": 2, "mcp_protocol": "2025-11-25"
    });
    std::fs::write(dir.join("plugin.json"), m.to_string()).unwrap();
    let cfg = HostConfig {
        layout: Layout::new(root.join("data")),
        plugin_dirs: vec![ext],
        node: PathBuf::from("node"),
        timings: Timings {
            exit_grace_ms: 8_000,
            ..Timings::default()
        },
    };
    let sink: EventSink = Arc::new(|_| {});
    let host = McpHost::new(
        cfg,
        Arc::new(Store::open_in_memory().unwrap()),
        Arc::new(NoUpcalls),
        sink,
    );
    host.start(&[PluginId("reporter".into())]).await.unwrap();
    Env { host, _root: root }
}

fn ctx(session: i64, progress: mpsc::Sender<ToolProgress>) -> ToolCtx {
    ToolCtx {
        session: SessionId(session),
        run: RunId("r1".into()),
        origin: Origin::Window,
        background: false,
        cancel: CancellationToken::new(),
        progress: Some(progress),
    }
}

/// Calls `reporter__work` with `args` in `session`; the outcome and every progress report.
async fn work(tooling: &McpTooling, session: i64, args: Value) -> (ToolOutcome, Vec<ToolProgress>) {
    let (tx, mut rx) = mpsc::channel(16);
    let args = args.as_object().unwrap().clone();
    let out = tokio::time::timeout(
        Duration::from_secs(60),
        tooling.call("reporter__work", args, ctx(session, tx)),
    )
    .await
    .expect("the call finished");
    let mut seen = Vec::new();
    while let Ok(Some(p)) = tokio::time::timeout(Duration::from_secs(30), rx.recv()).await {
        seen.push(p);
    }
    (out, seen)
}

#[tokio::test]
async fn progress_meta_kept() {
    let e = plugin_env("meta").await;
    let tooling = McpTooling::new(e.host.clone(), vec![]);
    assert!(tooling
        .list()
        .await
        .iter()
        .any(|t| t.name == "reporter__work"));
    let (out, seen) = work(&tooling, 7, json!({ "mode": "meta", "topic": "rust" })).await;
    assert!(out.ok, "{}", out.text);
    assert_eq!(seen.len(), 3, "{seen:?}");

    // Every field, each checked.
    let full = &seen[0];
    assert_eq!(full.progress, 1.0);
    assert_eq!(full.total, Some(3.0));
    assert_eq!(full.message.as_deref(), Some("step 1"));
    assert_eq!(full.line(), "step 1");
    assert_eq!(full.preview.as_deref(), Some("data:image/png;base64,AAAA"));
    assert_eq!(
        full.stages,
        Some(json!([
            { "label": "open", "state": "done" },
            { "label": "press", "state": "running", "progress": 1, "total": 2 },
        ]))
    );
    assert!(full.plan);
    // A key that is not widget-like is dropped; a label is trimmed.
    assert_eq!(
        full.controls,
        Some(json!([{ "key": "pause", "label": "Pause" }]))
    );
    let research = full.research.as_ref().expect("the research snapshot");
    assert_eq!(research["topic"], "rust");
    assert_eq!(research["conversationId"], "7");
    assert_eq!(
        research["counters"],
        json!({ "read": 1, "inProgress": 1, "failed": 0 })
    );
    assert!(research.get("extra").is_none(), "unknown keys are dropped");

    // A `file:` preview is dropped; `plan` without stages is dropped.
    let second = &seen[1];
    assert_eq!(second.preview, None);
    assert_eq!(second.stages, None);
    assert!(!second.plan);
    assert_eq!(second.research, None);

    // Malformed stages drop the whole strip, and the plan with them.
    let third = &seen[2];
    assert_eq!(third.stages, None);
    assert!(!third.plan);

    // On the wire the window reads: camelCase, empty fields left out.
    let wire = serde_json::to_value(second).unwrap();
    assert_eq!(
        wire,
        json!({ "progress": 2.0, "total": 3.0, "message": "step 2" })
    );
    e.host.shutdown().await;
}

#[tokio::test]
async fn research_snapshot_per_session() {
    let e = plugin_env("research").await;
    let tooling = McpTooling::new(e.host.clone(), vec![]);
    tooling.list().await;
    let plugin = PluginId("reporter".into());

    let (_, one) = work(&tooling, 1, json!({ "mode": "research", "topic": "one" })).await;
    let (_, two) = work(&tooling, 2, json!({ "mode": "research", "topic": "two" })).await;
    assert_eq!(one[0].research.as_ref().unwrap()["topic"], "one");
    assert_eq!(two[0].research.as_ref().unwrap()["topic"], "two");

    // Each session keeps its own, settled by how its call ended.
    let first = tooling.research(&plugin, SessionId(1)).expect("session 1");
    let second = tooling.research(&plugin, SessionId(2)).expect("session 2");
    assert_eq!(first["topic"], "one");
    assert_eq!(second["topic"], "two");
    for s in [&first, &second] {
        assert_eq!(s["completion"], "complete");
        assert_eq!(s["stage"], "finished");
        assert_eq!(s["sequence"], 2);
        assert_eq!(s["sources"][1]["state"], "unavailable");
        assert_eq!(
            s["counters"],
            json!({ "read": 1, "inProgress": 0, "failed": 1 })
        );
    }

    // A snapshot for another conversation is not this session's, and is not kept.
    let (_, wrong) = work(
        &tooling,
        3,
        json!({ "mode": "research", "topic": "three", "wrong": true }),
    )
    .await;
    assert_eq!(wrong[0].research, None);
    assert_eq!(tooling.research(&plugin, SessionId(3)), None);
    // Nor is it another plugin's.
    assert_eq!(
        tooling.research(&PluginId("other".into()), SessionId(1)),
        None
    );
    e.host.shutdown().await;
}

// ---- the agent: a scripted model, a tool that reports progress ----

type Script = Arc<dyn Fn(&ChatRequest) -> Vec<ChatChunk> + Send + Sync>;

struct FakeModel {
    script: Script,
    asked: Arc<Mutex<usize>>,
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

/// `look` reports half way, then answers.
struct ReportingTools;

#[async_trait::async_trait]
impl Tooling for ReportingTools {
    async fn list(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "look".into(),
            description: "Look around.".into(),
            params: json!({ "type": "object" }),
            annotations: Some(
                serde_json::from_value(json!({ "readOnlyHint": true, "destructiveHint": false }))
                    .unwrap(),
            ),
            reviewed: true,
            plugin: None,
            words: "look around".into(),
        }]
    }
    async fn call(&self, _: &str, _: Map<String, Value>, ctx: ToolCtx) -> ToolOutcome {
        let report = ToolProgress {
            progress: 1.0,
            total: Some(2.0),
            message: Some("half way".into()),
            ..ToolProgress::default()
        };
        if let Some(p) = &ctx.progress {
            p.try_send(report).expect("room for one report");
        }
        ToolOutcome {
            text: "looked".into(),
            ok: true,
            files: Vec::new(),
            final_text: None,
            undo: None,
            card: None,
        }
    }
}

struct No;

#[async_trait::async_trait]
impl Ask for No {
    async fn confirm(&self, _: &Origin, _: &Question, _: CancellationToken) -> bool {
        false
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
    asked: Arc<Mutex<usize>>,
    host: McpHost,
    _root: Scratch,
}

async fn world(tag: &str, script: Script) -> World {
    let root = Scratch::new(&format!("window-agent-{tag}"));
    std::fs::create_dir_all(root.join("ext")).unwrap();
    std::fs::create_dir_all(root.join("data")).unwrap();
    let asked = Arc::new(Mutex::new(0));
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
    let agent = Agent::new(AgentParts {
        router,
        tools: Arc::new(ReportingTools),
        store: store.clone(),
        bus: Bus::new(64),
        ask: Arc::new(No),
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
        asked,
        host,
        _root: root,
    }
}

fn answered(req: &ChatRequest) -> bool {
    req.messages.iter().any(|(r, _)| *r == Role::Tool)
}

/// One call to `look`, then "All done." once its result is in.
fn look_then_answer() -> Script {
    Arc::new(|req| {
        if answered(req) {
            vec![ChatChunk::Text("All done.".into())]
        } else {
            vec![ChatChunk::ToolCall(ToolCall {
                id: "c1".into(),
                name: "look".into(),
                arguments: json!({ "where": "here" }).to_string(),
            })]
        }
    })
}

fn task(w: &World, said: &str) -> Task {
    let body: MessageBody = serde_json::from_value(json!({ "content": said })).unwrap();
    w.store.append(w.session, Role::User, None, &body).unwrap();
    Task {
        session: w.session,
        origin: Origin::Window,
        messages: w
            .store
            .history(w.session, None)
            .unwrap()
            .into_iter()
            .map(|m| (m.role, m.body))
            .collect(),
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

/// Runs the task to its end; every frame it sent.
async fn frames_of(w: &World, t: Task, cancel: CancellationToken) -> Vec<DraftFrame> {
    let (tx, mut rx) = mpsc::channel(256);
    let all = tokio::spawn(async move {
        let mut all = Vec::new();
        while let Some(f) = rx.recv().await {
            all.push(f);
        }
        all
    });
    tokio::time::timeout(Duration::from_secs(60), w.agent.run(t, tx, cancel))
        .await
        .expect("the run finished")
        .expect("the run did not fail");
    all.await.unwrap()
}

#[tokio::test]
async fn step_frames_in_order() {
    let w = world("steps", look_then_answer()).await;
    let frames = frames_of(&w, task(&w, "look around"), CancellationToken::new()).await;
    // The window's frames and the text, in the order they came.
    let shown: Vec<&DraftFrame> = frames
        .iter()
        .filter(|f| matches!(f, DraftFrame::Step(_) | DraftFrame::Delta(_)))
        .collect();
    assert_eq!(shown.len(), 4, "{frames:?}");
    let step = |i: usize| -> &StepFrame {
        match shown[i] {
            DraftFrame::Step(s) => s,
            other => panic!("frame {i} is {other:?}"),
        }
    };
    // Started: its arguments, nothing else.
    let start = step(0);
    assert_eq!((start.n, start.name.as_str()), (1, "look"));
    assert_eq!(start.args, Some(json!({ "where": "here" })));
    assert!(start.progress.is_none() && start.outcome.is_none());
    // Running: the report as the tool sent it.
    let moving = step(1);
    assert_eq!(moving.n, 1);
    let p = moving.progress.as_ref().expect("progress");
    assert_eq!(p.line(), "half way");
    assert_eq!(p.total, Some(2.0));
    assert!(moving.args.is_none() && moving.outcome.is_none());
    // Done: the outcome.
    let done = step(2);
    let o = done.outcome.as_ref().expect("outcome");
    assert_eq!((o.text.as_str(), o.ok), ("looked", true));
    assert!(o.files.is_empty());
    assert!(done.args.is_none() && done.progress.is_none());
    // Then the answer.
    assert!(matches!(shown[3], DraftFrame::Delta(t) if t == "All done."));
    // The outcome frame is what the window reads.
    let wire = serde_json::to_value(done).unwrap();
    assert_eq!(
        wire,
        json!({ "n": 1, "name": "look", "outcome": { "text": "looked", "ok": true, "files": [] } })
    );
    w.host.shutdown().await;
}

#[tokio::test]
async fn notes_are_frames() {
    let w = world(
        "notes",
        Arc::new(|_| vec![ChatChunk::Text("Noted.".into())]),
    )
    .await;
    // A boundary heard is acknowledged in the window, as well as stored on the reply.
    let frames = frames_of(
        &w,
        task(&w, "tidy the folder but don't delete anything"),
        CancellationToken::new(),
    )
    .await;
    let notes: Vec<&str> = frames
        .iter()
        .filter_map(|f| match f {
            DraftFrame::Note(n) => Some(n.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(notes.len(), 1, "{frames:?}");
    assert!(notes[0].starts_with("Understood"), "{notes:?}");

    // Stopped before the model was asked.
    let before = *w.asked.lock().unwrap();
    let stop = CancellationToken::new();
    stop.cancel();
    let frames = frames_of(&w, task(&w, "anything"), stop).await;
    assert!(
        frames
            .iter()
            .any(|f| matches!(f, DraftFrame::Note(n) if n == "Stopped before starting.")),
        "{frames:?}"
    );
    assert_eq!(*w.asked.lock().unwrap(), before, "a model was asked");
    w.host.shutdown().await;
}

fn turn(w: &World, origin: Origin, said: &str) -> Turn {
    Turn {
        session: w.session,
        origin,
        content: Content::Text(said.into()),
        files: Vec::new(),
        received_at: 0,
        steer: Steer::none(),
    }
}

async fn reply(w: &World, t: Turn) -> Reply {
    let (tx, _rx) = mpsc::channel(256);
    tokio::time::timeout(
        Duration::from_secs(60),
        w.agent.reply(t, tx, CancellationToken::new()),
    )
    .await
    .expect("the reply finished")
    .expect("a reply")
}

#[tokio::test]
async fn window_runs_commands() {
    let w = world(
        "commands",
        Arc::new(|_| vec![ChatChunk::Text("From the model.".into())]),
    )
    .await;
    // From the window, `/help` is a command: no model is asked.
    let help = reply(&w, turn(&w, Origin::Window, "/help")).await;
    assert_eq!(help.lane, Lane::Command);
    assert!(help.text.contains("/approve"), "{}", help.text);
    assert_eq!(*w.asked.lock().unwrap(), 0);

    // So is an owner-only one: the window is the owner.
    let id = w
        .store
        .approval_open("r1", "{\"kind\":\"window\"}", "Delete notes.txt?", None, 1)
        .unwrap();
    let approved = reply(&w, turn(&w, Origin::Window, &format!("/approve {id}"))).await;
    assert_eq!(approved.lane, Lane::Command);
    let row = w.store.approval(id).unwrap().unwrap();
    assert_eq!(row.answer, Some(true), "{}", approved.text);
    assert_eq!(row.via.as_deref(), Some("window"));

    // From Desktop, as today: `/…` is text for the model, and an owner-only command is refused.
    let desk = reply(&w, turn(&w, Origin::Desktop, "/help")).await;
    assert_eq!(desk.lane, Lane::Task);
    assert_eq!(desk.text, "From the model.");
    let other = w
        .store
        .approval_open("r2", "{\"kind\":\"desktop\"}", "Delete b.txt?", None, 1)
        .unwrap();
    let refused = alexia_core::commands::run(
        &w.agent,
        &turn(&w, Origin::Desktop, &format!("/approve {other}")),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(refused.text, "Commands are only taken from your own chat.");
    assert_eq!(w.store.approval(other).unwrap().unwrap().answer, None);
    w.host.shutdown().await;
}

#[test]
fn origin_window_serde() {
    let wire = serde_json::to_value(Origin::Window).unwrap();
    assert_eq!(wire, json!({ "kind": "window" }));
    let back: Origin = serde_json::from_value(json!({ "kind": "window" })).unwrap();
    assert_eq!(back, Origin::Window);
    // The others are as they were.
    assert_eq!(
        serde_json::to_value(Origin::Desktop).unwrap(),
        json!({ "kind": "desktop" })
    );
}
