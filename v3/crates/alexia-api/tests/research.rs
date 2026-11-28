// SPDX-License-Identifier: AGPL-3.0-only
//! P2D-11: the research viewer, in-process. `Api::serve` on `127.0.0.1:0` over a real
//! `McpHost` with two node plugins written here at test time: one whose panel has a
//! `research` widget and one with none. Each has a `work` tool that sends an
//! `alexia/research` progress snapshot; the call goes through `McpTooling`, as a turn's would.

use std::path::{Path, PathBuf};
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
    Brain, BrainError, Bus, DraftSink, Lane, Limits, Origin, Reply, RunId, ToolCtx, ToolProgress,
    Tooling, Turn,
};
use alexia_gateway::{Asker, ChannelSet, WindowQuestions};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, PluginId, Timings};
use alexia_scheduler::Scheduler;
use alexia_store::{Layout, SessionId, Store};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Generous: a loaded Windows machine is slow, and the plugins are processes.
const WAIT: Duration = Duration::from_secs(90);

/// `work {topic}` writes `shot.png` and `report.md` into its own folder (its working
/// directory) and `escape.png` next to it, then sends one research snapshot for the call's
/// conversation: source `s1` previews `shot.png`, `s2` previews `escape.png` by way of `..`,
/// `s3` previews the report (not a picture); the report is `report.md`.
const RESEARCHER: &str = r#"
const fs = require('fs');
const path = require('path');
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, serverInfo: { name: 'r', version: '0' }, capabilities: { tools: {} } } });
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'work', inputSchema: { type: 'object' } }] } });
  else if (m.method === 'tools/call') {
    const meta = m.params._meta || {};
    const conv = (meta['alexia/call-context'] || {}).conversationId;
    const a = m.params.arguments || {};
    const own = process.cwd();
    const shot = path.join(own, 'shot.png');
    const report = path.join(own, 'report.md');
    fs.writeFileSync(shot, 'shot-' + a.topic);
    fs.writeFileSync(report, '# ' + a.topic);
    fs.writeFileSync(path.join(own, '..', 'escape.png'), 'outside');
    const snapshot = {
      runId: 'run-' + a.topic, conversationId: conv, sequence: 1, topic: a.topic, startedAt: 1, elapsedMs: 2,
      stage: 'finished', completion: 'complete', counters: { read: 0, inProgress: 0, failed: 0 },
      report: { path: report, name: 'report.md' },
      sources: [
        { id: 's1', url: 'https://example.com/a', title: 'A', state: 'complete', preview: shot },
        { id: 's2', url: 'https://example.com/b', title: 'B', state: 'complete', preview: path.join(own, '..', 'escape.png') },
        { id: 's3', url: 'https://example.com/c', title: 'C', state: 'complete', preview: report },
      ],
    };
    const token = meta.progressToken;
    if (token !== undefined) send({ method: 'notifications/progress', params: { progressToken: token, progress: 1, _meta: { 'alexia/research': snapshot } } });
    send({ id: m.id, result: { content: [{ type: 'text', text: 'researched' }] } });
  } else send({ id: m.id, result: {} });
});
"#;

/// Never asked: nothing here talks to a model.
struct Silent;

#[async_trait::async_trait]
impl Brain for Silent {
    async fn reply(
        &self,
        _turn: Turn,
        _draft: DraftSink,
        _cancel: CancellationToken,
    ) -> Result<Reply, BrainError> {
        Ok(Reply {
            text: String::new(),
            files: vec![],
            lane: Lane::Task,
            model: None,
            spans: vec![],
        })
    }
}

struct World {
    api: Arc<Api>,
    tooling: Arc<McpTooling>,
    store: Arc<Store>,
    /// Shows a `research` widget.
    shown: PluginId,
    /// Shows none.
    hidden: PluginId,
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
    let dir =
        std::env::temp_dir().join(format!("alexia-research-{name}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn researcher(ext: &Path, id: &str, widget: bool) {
    let dir = ext.join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("plugin.js"), RESEARCHER).unwrap();
    let mut m = json!({
        "manifest_version": 1,
        "id": id,
        "name": "Researcher",
        "summary": "A plugin that exists for tests.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": "node", "args": ["plugin.js"] },
        "alexia_protocol": 15,
        "mcp_protocol": "2025-11-25",
        "requires": [{ "cap": "fs.own_dir", "why": "To keep what it read." }]
    });
    if widget {
        m["panel"] = json!({
            "label": "Research",
            "widgets": [{ "type": "research", "key": "run", "label": "Research" }]
        });
    }
    std::fs::write(dir.join("plugin.json"), m.to_string()).unwrap();
}

async fn world(name: &str) -> World {
    let root = scratch(name);
    let data = root.join("data");
    let ext = root.join("ext");
    std::fs::create_dir_all(&ext).unwrap();
    let shown = PluginId(format!("shown-{name}"));
    let hidden = PluginId(format!("hidden-{name}"));
    researcher(&ext, &shown.0, true);
    researcher(&ext, &hidden.0, false);
    let store = Arc::new(Store::open_in_memory().unwrap());
    let bus = Bus::new(256);
    let host = McpHost::new(
        HostConfig {
            layout: Layout::new(data.clone()),
            plugin_dirs: vec![ext],
            node: PathBuf::from("node"),
            timings: Timings::default(),
            dial: None,
        },
        store.clone(),
        Arc::new(NoUpcalls),
        Arc::new(|_| {}),
    );
    host.start(&[shown.clone(), hidden.clone()]).await.unwrap();
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
    let brain: Arc<dyn Brain> = Arc::new(Silent);
    let scheduler = Scheduler::new(store.clone(), bus.clone(), brain.clone());
    let (skills, _) = Skills::load(&[]);
    let runtime = Runtime::new(Layout::new(data.clone()), reqwest::Client::new());
    let jobs = LocalJobs::new(runtime.clone(), store.clone(), router.clone());
    let api = Api::new(ApiParts {
        layout: Layout::new(data),
        store: store.clone(),
        bus,
        host,
        tooling: tooling.clone(),
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
        tooling,
        store,
        shown,
        hidden,
        port,
        root,
        cancel,
    }
}

/// Runs `<plugin>__work {topic}` in `session`, as a turn would, with progress on.
async fn research(w: &World, plugin: &PluginId, session: SessionId, topic: &str) {
    let (tx, mut rx) = mpsc::channel::<ToolProgress>(16);
    let ctx = ToolCtx {
        session,
        run: RunId("r1".into()),
        origin: Origin::Window,
        background: false,
        cancel: CancellationToken::new(),
        progress: Some(tx),
    };
    let args = json!({ "topic": topic }).as_object().unwrap().clone();
    assert!(w.tooling.list().await.len() >= 2);
    let out = tokio::time::timeout(
        WAIT,
        w.tooling.call(&format!("{}__work", plugin.0), args, ctx),
    )
    .await
    .expect("the call finished");
    assert!(out.ok, "{}", out.text);
    let mut research = None;
    while let Ok(Some(p)) = tokio::time::timeout(Duration::from_secs(30), rx.recv()).await {
        research = research.or(p.research);
    }
    assert!(research.is_some(), "the snapshot reached the call");
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

/// `Content-Length`-framed, which is what these routes answer with.
async fn send(w: &World, method: &str, path: &str, body: Option<&Value>) -> Answer {
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
    let mut s = TcpStream::connect(("127.0.0.1", w.port)).await.unwrap();
    s.write_all(req.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    tokio::time::timeout(WAIT, s.read_to_end(&mut raw))
        .await
        .expect("the server answered in time")
        .unwrap();
    let split = raw
        .windows(4)
        .position(|x| x == b"\r\n\r\n")
        .expect("a full head");
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect();
    Answer {
        status,
        headers,
        body: raw[split + 4..].to_vec(),
    }
}

async fn snapshot(w: &World, plugin: &PluginId) -> Value {
    let a = send(
        w,
        "POST",
        "/api/research",
        Some(&json!({ "plugin": plugin.0 })),
    )
    .await;
    assert_eq!(a.status, 200, "{}", String::from_utf8_lossy(&a.body));
    assert_eq!(a.header("cache-control"), Some("no-store"));
    a.json()["snapshot"].clone()
}

async fn file(w: &World, plugin: &PluginId, run: &str, source: &str, kind: &str) -> Answer {
    send(
        w,
        "GET",
        &format!(
            "/api/research-file?plugin={}&run={run}&source={source}&kind={kind}",
            plugin.0
        ),
        None,
    )
    .await
}

/// 404 with no type and none of a file's bytes in it.
fn empty_404(a: &Answer) {
    assert_eq!(a.status, 404);
    assert_eq!(a.header("content-type"), None);
    assert_eq!(a.body, b"Not found.");
}

// ---- tests ----

#[tokio::test]
async fn snapshot_from_progress() {
    let w = world("snap").await;
    let open = w.api.session();
    assert!(snapshot(&w, &w.shown).await.is_null(), "nothing yet");

    research(&w, &w.shown, open, "rust").await;
    let s = snapshot(&w, &w.shown).await;
    assert_eq!(s["runId"], "run-rust", "{s}");
    assert_eq!(s["topic"], "rust");
    assert_eq!(s["conversationId"], open.0.to_string());
    assert_eq!(s["sources"].as_array().unwrap().len(), 3);

    // A plugin that shows no research widget has no snapshot here, whatever it sent.
    research(&w, &w.hidden, open, "quiet").await;
    assert!(snapshot(&w, &w.hidden).await.is_null());
    // Nor does a plugin that is not there.
    let a = send(
        &w,
        "POST",
        "/api/research",
        Some(&json!({ "plugin": "nobody" })),
    )
    .await;
    assert_eq!(a.json(), json!({ "snapshot": null }));

    // For the open chat only: another chat's research is not this one's.
    let other = w.store.create_session(Some("other")).unwrap();
    research(&w, &w.shown, other, "elsewhere").await;
    assert_eq!(snapshot(&w, &w.shown).await["topic"], "rust");
    w.api.set_session(other).unwrap();
    assert_eq!(snapshot(&w, &w.shown).await["topic"], "elsewhere");
    let fresh = w.store.create_session(Some("fresh")).unwrap();
    w.api.set_session(fresh).unwrap();
    assert!(snapshot(&w, &w.shown).await.is_null());
}

#[tokio::test]
async fn file_escape_404() {
    let w = world("escape").await;
    research(&w, &w.shown, w.api.session(), "files").await;

    // Inside the plugin's own folder: served.
    let a = file(&w, &w.shown, "run-files", "s1", "preview").await;
    assert_eq!(a.status, 200);
    assert_eq!(a.header("content-type"), Some("image/png"));
    assert_eq!(a.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(a.body, b"shot-files");
    let a = file(&w, &w.shown, "run-files", "", "report").await;
    assert_eq!(a.status, 200);
    assert_eq!(
        a.header("content-type"),
        Some("text/markdown; charset=utf-8")
    );
    assert_eq!(
        a.header("content-disposition"),
        Some("attachment; filename=\"report.md\"")
    );
    assert_eq!(a.body, b"# files");

    // Out by `..`: refused, though the file is there.
    let escaped = w.root.join("data").join("plugins").join("escape.png");
    assert!(escaped.is_file());
    empty_404(&file(&w, &w.shown, "run-files", "s2", "preview").await);
    // Inside, but not a picture.
    empty_404(&file(&w, &w.shown, "run-files", "s3", "preview").await);
    // No such source, and a plugin that is not there.
    empty_404(&file(&w, &w.shown, "run-files", "s9", "preview").await);
    empty_404(&file(&w, &PluginId("nobody".into()), "run-files", "s1", "preview").await);
}

#[tokio::test]
async fn wrong_run_404() {
    let w = world("run").await;
    research(&w, &w.shown, w.api.session(), "first").await;
    assert_eq!(
        file(&w, &w.shown, "run-first", "s1", "preview")
            .await
            .status,
        200
    );

    // A newer run replaces it: the old run id no longer reaches a file.
    research(&w, &w.shown, w.api.session(), "second").await;
    empty_404(&file(&w, &w.shown, "run-first", "s1", "preview").await);
    empty_404(&file(&w, &w.shown, "run-first", "", "report").await);
    assert_eq!(
        file(&w, &w.shown, "run-second", "s1", "preview")
            .await
            .status,
        200
    );
    empty_404(&file(&w, &w.shown, "", "s1", "preview").await);

    // Another chat's run is not the open chat's.
    let other = w.store.create_session(Some("other")).unwrap();
    w.api.set_session(other).unwrap();
    empty_404(&file(&w, &w.shown, "run-second", "s1", "preview").await);
}
