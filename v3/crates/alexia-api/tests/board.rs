// SPDX-License-Identifier: AGPL-3.0-only
//! P2D-07: the board's tables and buttons, in-process. `Api::serve` on `127.0.0.1:0` with a
//! scratch store, a router over one scripted free provider, and `mcp-fixture` plugins whose
//! manifests declare a table and buttons. Requests are written by hand over TCP.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_api::{Api, ApiParts};
use alexia_core::agent::{Agent, AgentParts};
use alexia_core::catalog::Catalog;
use alexia_core::checker::Checker;
use alexia_core::free::{Auth, FreeRow};
use alexia_core::local::{LocalJobs, Runtime};
use alexia_core::prompt::Skills;
use alexia_core::router::Router;
use alexia_core::tools::McpTooling;
use alexia_core::trace::Trace;
use alexia_core::{
    Brain, BrainError, Bus, ChatChunk, ChatDone, ChatRequest, DraftFrame, DraftSink, Lane, Limits,
    ModelInfo, Origin, Provider, ProviderError, Reply, RunEnd, RunId, Step, StepFrame,
    StepOutcomeFrame, ToolOutcome, Turn,
};
use alexia_gateway::{Asker, ChannelSet, WindowQuestions};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, PluginId, Timings};
use alexia_scheduler::Scheduler;
use alexia_store::{Layout, MessageBody, Role, SessionId, Store};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Generous: a loaded Windows machine is slow, and plugins are processes.
const WAIT: Duration = Duration::from_secs(90);

fn body(text: &str) -> MessageBody {
    serde_json::from_value(json!({ "content": text })).unwrap()
}

// ---- the scripted provider ----

/// One free model, "big-70b" on provider "p", answering whatever `said` holds.
struct FakeModel {
    said: Arc<Mutex<String>>,
    asked: Arc<Mutex<Vec<ChatRequest>>>,
}

#[async_trait::async_trait]
impl Provider for FakeModel {
    fn id(&self) -> &str {
        "p"
    }
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(vec![
            ModelInfo {
                id: "big-70b".into(),
                context: 32_768,
                free: true,
                tools: true,
                vision: false,
            },
            ModelInfo {
                id: "small-8b".into(),
                context: 8_192,
                free: true,
                tools: false,
                vision: false,
            },
        ])
    }
    async fn chat(
        &self,
        req: &ChatRequest,
        model: &str,
        out: mpsc::Sender<ChatChunk>,
        _cancel: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        self.asked.lock().unwrap().push(req.clone());
        let text = self.said.lock().unwrap().clone();
        let _ = out.send(ChatChunk::Text(text)).await;
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

// ---- the scripted brain: a task of three tool steps, traced and audited as the agent does ----

struct Tasker {
    store: Arc<Store>,
    bus: Bus,
}

#[async_trait::async_trait]
impl Brain for Tasker {
    async fn reply(
        &self,
        turn: Turn,
        draft: DraftSink,
        _cancel: CancellationToken,
    ) -> Result<Reply, BrainError> {
        static N: AtomicUsize = AtomicUsize::new(0);
        let said = turn.content.text();
        self.store
            .append(turn.session, Role::User, None, &body(&said))
            .unwrap();
        let run = RunId(format!("task-{}", N.fetch_add(1, Ordering::Relaxed)));
        let trace = Trace::begin(
            self.store.clone(),
            self.bus.clone(),
            run,
            turn.session,
            turn.origin.clone(),
            false,
            None,
        )
        .unwrap();
        for (n, name) in [(1, "files__list"), (2, "files__read"), (3, "files__move")] {
            let step = Step {
                n,
                name: name.into(),
                args: Map::new(),
                outcome: Some(ToolOutcome {
                    text: format!("{name} worked"),
                    ok: true,
                    files: vec![],
                    final_text: None,
                    undo: None,
                    card: None,
                }),
            };
            trace
                .audited(&step, Some("files"), "run", "ran", None)
                .unwrap();
            let _ = draft
                .send(DraftFrame::Step(StepFrame {
                    n,
                    name: name.into(),
                    args: None,
                    progress: None,
                    outcome: Some(StepOutcomeFrame {
                        text: format!("{name} worked"),
                        ok: true,
                        files: vec![],
                    }),
                }))
                .await;
        }
        trace.end(&RunEnd::Answered).unwrap();
        let _ = draft.send(DraftFrame::Delta("Moved.".into())).await;
        self.store
            .append(
                turn.session,
                Role::Assistant,
                Some("big-70b"),
                &body("Moved."),
            )
            .unwrap();
        Ok(Reply {
            text: "Moved.".into(),
            files: vec![],
            lane: Lane::Task,
            model: Some("big-70b".into()),
            spans: vec![],
        })
    }
}

// ---- the fixture plugins ----

fn fixture_exe() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let path = exe
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .join(format!("mcp-fixture{}", std::env::consts::EXE_SUFFIX));
    if !path.is_file() {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let ok = std::process::Command::new(cargo)
            .args(["build", "-p", "alexia-mcp", "--bin", "mcp-fixture"])
            .status()
            .unwrap()
            .success();
        assert!(ok && path.is_file(), "could not build mcp-fixture");
    }
    path
}

/// A fixture plugin `id` in `mode`, with `extra` merged into its manifest.
fn install(ext: &Path, id: &str, mode: &str, extra: Value) {
    let dir = ext.join(id);
    std::fs::create_dir_all(&dir).unwrap();
    let src = fixture_exe();
    let exe = src.file_name().unwrap().to_str().unwrap();
    std::fs::copy(&src, dir.join(exe)).unwrap();
    let mut m = json!({
        "manifest_version": 1, "id": id, "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.", "version": "0.1.0",
        "license": "AGPL-3.0-only", "entry": { "run": exe, "args": [mode] },
        "alexia_protocol": 15, "mcp_protocol": "2025-11-25"
    });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(dir.join("plugin.json"), m.to_string()).unwrap();
}

// ---- the world ----

struct World {
    api: Arc<Api>,
    port: u16,
    root: PathBuf,
    data: PathBuf,
    store: Arc<Store>,
    host: McpHost,
    said: Arc<Mutex<String>>,
    asked: Arc<Mutex<Vec<ChatRequest>>>,
    cancel: CancellationToken,
}

impl Drop for World {
    fn drop(&mut self) {
        self.cancel.cancel();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl World {
    async fn done(self) {
        self.host.shutdown().await;
    }
}

fn scratch(name: &str) -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("alexia-board-{name}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// `plugins`: (id, fixture mode, manifest extras), each installed and enabled.
async fn world(name: &str, plugins: &[(&str, &str, Value)]) -> World {
    let root = scratch(name);
    let data = root.join("data");
    let ext = root.join("ext");
    std::fs::create_dir_all(&ext).unwrap();
    for (id, mode, extra) in plugins {
        install(&ext, id, mode, extra.clone());
    }
    let store = Arc::new(Store::open_in_memory().unwrap());
    let bus = Bus::new(256);
    let host = McpHost::new(
        HostConfig {
            layout: Layout::new(data.clone()),
            plugin_dirs: vec![ext],
            node: PathBuf::from("node"),
            timings: Timings {
                exit_grace_ms: 8_000,
                ..Timings::default()
            },
            dial: None,
        },
        store.clone(),
        Arc::new(NoUpcalls),
        Arc::new(|_| {}),
    );
    let ids: Vec<PluginId> = plugins
        .iter()
        .map(|(id, _, _)| PluginId((*id).into()))
        .collect();
    host.start(&ids).await.unwrap();

    let said = Arc::new(Mutex::new(String::from("NOTHING TO LEARN")));
    let asked = Arc::new(Mutex::new(Vec::new()));
    let p: Arc<dyn Provider> = Arc::new(FakeModel {
        said: said.clone(),
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
    let router = Arc::new(Router::new(vec![p], catalog.clone(), store.clone()));
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
    let brain: Arc<dyn Brain> = Arc::new(Tasker {
        store: store.clone(),
        bus: bus.clone(),
    });
    let scheduler = Scheduler::new(store.clone(), bus.clone(), brain.clone());
    let (skills, _) = Skills::load(&[]);
    let runtime = Runtime::new(Layout::new(data.clone()), reqwest::Client::new());
    let jobs = LocalJobs::new(runtime.clone(), store.clone(), router.clone());
    let api = Api::new(ApiParts {
        layout: Layout::new(data.clone()),
        store: store.clone(),
        bus,
        host: host.clone(),
        tooling,
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
        port,
        root,
        data,
        store,
        host,
        said,
        asked,
        cancel,
    }
}

// ---- HTTP by hand ----

/// Sends one request and reads the whole answer (the board's answers are small JSON).
async fn raw(w: &World, path: &str, sent: &Value) -> String {
    let body = sent.to_string();
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nx-alexia-token: {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
        w.port,
        w.api.token(),
        body.len()
    );
    let mut s = TcpStream::connect(("127.0.0.1", w.port)).await.unwrap();
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    tokio::time::timeout(WAIT, s.read_to_end(&mut out))
        .await
        .expect("the server answered in time")
        .unwrap();
    String::from_utf8(out).unwrap()
}

/// The answer's JSON body; asserts a 200.
async fn post(w: &World, path: &str, sent: Value) -> Value {
    let text = raw(w, path, &sent).await;
    let (head, body) = text.split_once("\r\n\r\n").expect("a full answer");
    assert!(
        head.starts_with("HTTP/1.1 200"),
        "{path} {sent}: {head}\n{body}"
    );
    serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
}

async fn rows(w: &World, key: &str) -> Value {
    post(w, "/api/rows", json!({ "plugin": "", "key": key })).await
}

async fn press(w: &World, key: &str, row: &str) -> Value {
    post(
        w,
        "/api/action",
        json!({ "plugin": "", "key": key, "row": row, "confirm": true }),
    )
    .await
}

fn chat_with(store: &Store, title: &str, lines: &[(Role, &str)]) -> SessionId {
    let id = store.create_session(Some(title)).unwrap();
    for (role, text) in lines {
        store.append(id, *role, None, &body(text)).unwrap();
    }
    id
}

// ---- the tests ----

#[tokio::test]
async fn chats_rows_and_forget_open_refused() {
    let w = world("chats", &[]).await;
    let open = w.api.session();
    let other = chat_with(
        &w.store,
        "Printer",
        &[
            (Role::User, "Why is the printer offline?"),
            (Role::Assistant, "It is asleep."),
        ],
    );
    let other_id = other.0.to_string();
    let r = rows(&w, "chats").await;
    assert_eq!(r["ok"], true, "{r}");
    let list = r["rows"].as_array().unwrap();
    assert_eq!(list.len(), 2, "{r}");
    let row = list
        .iter()
        .find(|x| x["id"].as_str() == Some(other_id.as_str()))
        .unwrap();
    assert_eq!(row["title"], "Printer");
    assert_eq!(row["turns"], "2");
    assert!(row["at"].is_i64() && row["when"].as_str().is_some_and(|s| !s.is_empty()));
    assert_eq!(row["state"], "");
    let open_id = open.0.to_string();
    let mine = list
        .iter()
        .find(|x| x["id"].as_str() == Some(open_id.as_str()))
        .unwrap();
    assert_eq!(mine["state"], "● open");

    let d = post(
        &w,
        "/api/detail",
        json!({ "plugin": "", "key": "chats", "row": other.0.to_string() }),
    )
    .await;
    assert_eq!(d["ok"], true);
    assert_eq!(
        d["text"],
        "You: Why is the printer offline?\n\nAlexia: It is asleep."
    );

    // The open one cannot be forgotten, and is still there.
    let no = press(&w, "forget_chat", &open.0.to_string()).await;
    assert_eq!(no["ok"], false);
    assert_eq!(
        no["said"],
        "That is the conversation you are in. Open another one first, or press New chat."
    );
    assert!(w.store.sessions().unwrap().iter().any(|s| s.id == open));

    // Another goes, messages and all.
    let yes = press(&w, "forget_chat", &other.0.to_string()).await;
    assert_eq!(yes["ok"], true, "{yes}");
    assert_eq!(yes["said"], "“Printer” is gone, and everything said in it.");
    assert!(!w.store.sessions().unwrap().iter().any(|s| s.id == other));
    assert!(w.store.history(other, None).unwrap().is_empty());
    let gone = press(&w, "forget_chat", &other.0.to_string()).await;
    assert_eq!(gone["said"], "There is no conversation with that id.");
    w.done().await;
}

#[tokio::test]
async fn open_chat_switches_session() {
    let w = world("open", &[]).await;
    let first = w.api.session();
    let other = chat_with(&w.store, "Recipes", &[(Role::User, "Soup?")]);
    let r = press(&w, "open_chat", &other.0.to_string()).await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(
        r["said"],
        "Open: “Recipes”. Press Back and it is on screen."
    );
    assert_eq!(w.api.session(), other);
    assert_eq!(
        w.store.kv_get("_core", "window_session").unwrap(),
        Some(json!(other.0))
    );
    assert_ne!(first, other);
    let r = press(&w, "open_chat", "9999").await;
    assert_eq!(r["ok"], false);
    assert_eq!(w.api.session(), other);

    // New chat reuses the empty one rather than stacking another.
    let r = press(&w, "new_chat", "").await;
    assert_eq!(r["ok"], true);
    assert_eq!(
        r["said"],
        "Started a new chat. Anything you say now goes into it."
    );
    assert_eq!(w.api.session(), first, "the empty chat was reused");
    let r = press(&w, "new_chat", "").await;
    assert_eq!(
        r["said"],
        "You are already in a new chat — nothing has been said in this one."
    );
    assert_eq!(w.store.sessions().unwrap().len(), 2);
    w.done().await;
}

#[tokio::test]
async fn models_rows_shape() {
    let w = world("models", &[]).await;
    let r = rows(&w, "models").await;
    assert_eq!(r["ok"], true, "{r}");
    let list = r["rows"].as_array().unwrap();
    assert_eq!(list.len(), 2, "{r}");
    for row in list {
        for key in [
            "id", "group", "rank", "name", "provider", "via", "note", "size", "can", "week",
            "answered", "price", "tier", "state",
        ] {
            assert!(row[key].is_string(), "{key} in {row}");
        }
        assert!(row["tags"].is_array());
        assert_eq!(row["price"], "free");
        assert_eq!(row["group"], "Automatic, free");
    }
    // The router's own order: tools and size first, the first one recommended.
    assert_eq!(list[0]["id"], "p\nbig-70b");
    assert_eq!(list[0]["rank"], "★ 1");
    assert_eq!(list[0]["state"], "★ recommended");
    assert_eq!(list[0]["can"], "tools · reads 33k");
    assert_eq!(list[0]["size"], "70B, from its name");
    assert!(list[0]["note"]
        .as_str()
        .unwrap()
        .starts_with("First choice:"));

    let d = post(
        &w,
        "/api/detail",
        json!({ "plugin": "", "key": "models", "row": "p\nbig-70b" }),
    )
    .await;
    assert!(
        d["text"].as_str().unwrap().starts_with("big-70b on p\n"),
        "{d}"
    );

    let routing = rows(&w, "routing").await;
    let ladder = routing["rows"].as_array().unwrap();
    assert_eq!(ladder.len(), 2);
    assert!(ladder
        .iter()
        .all(|x| x["rank"] == "" && x["side"] == "free"));
    w.done().await;
}

#[tokio::test]
async fn use_model_pins_router() {
    let w = world("pin", &[]).await;
    let r = press(&w, "use_model", "p\nsmall-8b").await;
    assert_eq!(r["ok"], true, "{r}");
    assert!(r["said"]
        .as_str()
        .unwrap()
        .starts_with("Every request now goes to small-8b."));
    let pins = w.api.parts.router.pins();
    assert_eq!(pins.get("chat"), Some(&vec!["p/small-8b".to_owned()]));
    assert_eq!(pins.get("step"), Some(&vec!["p/small-8b".to_owned()]));
    let models = rows(&w, "models").await;
    let first = &models["rows"][0];
    assert_eq!(first["group"], "Your choice");
    assert_eq!(first["id"], "p\nsmall-8b");
    assert_eq!(first["rank"], "◆ 1");

    let none = press(&w, "use_model", "p\nno-such-model").await;
    assert_eq!(none["ok"], false);
    assert_eq!(none["said"], "That model is not in the catalog any more.");

    // A running order is the router's list for the job.
    let r = press(&w, "set_order", "p/big-70b, gone/x, p/small-8b").await;
    assert_eq!(r["ok"], true);
    assert_eq!(
        w.api.parts.router.pins().get("chat"),
        Some(&vec!["p/big-70b".to_owned(), "p/small-8b".to_owned()])
    );
    let ladder = rows(&w, "routing").await;
    assert_eq!(ladder["rows"][0]["id"], "p/big-70b");
    assert_eq!(ladder["rows"][0]["rank"], "1");

    let r = press(&w, "automatic", "").await;
    assert_eq!(
        r["said"],
        "Back to automatic. Each request goes to the cheapest model that fits it, and no model is pinned."
    );
    assert!(!w.api.parts.router.pins().contains_key("chat"));
    let r = press(&w, "automatic", "").await;
    assert_eq!(
        r["said"],
        "Already automatic — each request goes to the cheapest model that fits it."
    );

    // Paid controls say so (D-P2D-6); the switches write v2's kv.
    let r = press(&w, "set_spend", "paid").await;
    assert_eq!(
        r,
        json!({ "ok": false, "said": "Alexia v3 only uses free models." })
    );
    press(&w, "set_speed", "on").await;
    assert_eq!(
        w.store.kv_get("_core", "speed").unwrap(),
        Some(json!("fastest"))
    );
    press(&w, "set_keyless", "off").await;
    assert_eq!(
        w.store.kv_get("_core", "keyless.on").unwrap(),
        Some(json!(false))
    );
    w.done().await;
}

/// Three audited steps of one run in `session`, ended.
fn traced_run(w: &World, session: SessionId) -> String {
    let run = RunId(format!("run-{}", session.0));
    let trace = Trace::begin(
        w.store.clone(),
        w.api.parts.bus.clone(),
        run.clone(),
        session,
        Origin::Window,
        false,
        None,
    )
    .unwrap();
    for (n, name, ok) in [
        (1, "files__list", true),
        (2, "files__move", false),
        (3, "files__move", true),
    ] {
        let step = Step {
            n,
            name: name.into(),
            args: Map::from_iter([("to".to_owned(), json!("Archive"))]),
            outcome: Some(ToolOutcome {
                text: if ok { "moved".into() } else { "busy".into() },
                ok,
                files: vec![],
                final_text: None,
                undo: None,
                card: None,
            }),
        };
        trace
            .audited(&step, Some("files"), "run", "ran", None)
            .unwrap();
    }
    trace.end(&RunEnd::Answered).unwrap();
    run.0
}

#[tokio::test]
async fn activity_rows_from_audit() {
    let w = world("activity", &[]).await;
    let session = w.api.session();
    w.store
        .append(session, Role::User, None, &body("Tidy my downloads"))
        .unwrap();
    let run = traced_run(&w, session);
    let r = rows(&w, "activity").await;
    assert_eq!(r["ok"], true, "{r}");
    let row = &r["rows"][0];
    assert_eq!(row["id"], run.as_str());
    assert_eq!(row["task"], "Tidy my downloads");
    assert_eq!(row["steps"], 3);
    assert_eq!(row["cost"], "free");
    assert_eq!(row["ended"], "Finished");

    let d = post(
        &w,
        "/api/detail",
        json!({ "plugin": "", "key": "activity", "row": run }),
    )
    .await;
    let text = d["text"].as_str().unwrap();
    assert!(
        text.contains("Used 2 tools: files__list and files__move (2 times)."),
        "{text}"
    );
    assert!(text.contains("1 step failed."), "{text}");
    let more = d["more"].as_str().unwrap();
    assert!(more.contains("run -> ran"), "{more}");

    let last = rows(&w, "last_run").await;
    let one = &last["rows"][0];
    assert_eq!(one["over"], true);
    assert_eq!(one["steps"].as_array().unwrap().len(), 3);
    assert_eq!(one["steps"][1]["ok"], false);

    let gone = post(
        &w,
        "/api/detail",
        json!({ "plugin": "", "key": "activity", "row": "nope" }),
    )
    .await;
    assert_eq!(
        gone["text"],
        "That run is no longer kept. Alexia keeps the last 200, for up to 30 days."
    );

    // The run's chat is found from its audit rows.
    let other = chat_with(&w.store, "Other", &[(Role::User, "hi")]);
    w.api.set_session(other).unwrap();
    let r = press(&w, "open_run_chat", &run).await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(w.api.session(), session);
    w.done().await;
}

#[tokio::test]
async fn export_run_text() {
    let w = world("export", &[]).await;
    let run = traced_run(&w, w.api.session());
    let r = press(&w, "export_run", &run).await;
    assert_eq!(r["ok"], true, "{r}");
    let said = r["said"].as_str().unwrap();
    let path = PathBuf::from(said.strip_prefix("Written to ").unwrap());
    assert!(path.starts_with(w.data.join("exports")), "{said}");
    let text = std::fs::read_to_string(&path).unwrap();
    let expected = alexia_core::trace::replay(&w.store, &run).unwrap().unwrap();
    assert_eq!(text, expected);
    assert!(text.starts_with(&format!("# Run {run}\n")));
    let r = press(&w, "export_run", "nope").await;
    assert_eq!(r["ok"], false);
    w.done().await;
}

#[tokio::test]
async fn plugin_rows_call_tool() {
    let w = world(
        "plugin-rows",
        &[(
            "lister",
            "storage",
            json!({
                "storage": { "namespace": "lister", "tables": ["notes"] },
                "panel": { "label": "Notes", "widgets": [
                    { "type": "table", "key": "notes", "label": "Notes", "rows": "list", "detail": "recall",
                      "columns": [{ "key": "text", "label": "Text" }] }
                ]}
            }),
        )],
    )
    .await;
    let row: alexia_store::Row =
        serde_json::from_value(json!({ "id": "n1", "text": "one" })).unwrap();
    w.store.insert("lister", "notes", &row).unwrap();

    // `list` declared nothing, so it is asked about first, as an agent's call would be.
    let asked = post(
        &w,
        "/api/rows",
        json!({ "plugin": "lister", "key": "notes" }),
    )
    .await;
    assert_eq!(asked["ok"], false, "{asked}");
    assert_eq!(asked["confirm"], true, "{asked}");
    assert!(
        asked["said"].as_str().unwrap().ends_with("Allow it?"),
        "{asked}"
    );

    let r = post(
        &w,
        "/api/rows",
        json!({ "plugin": "lister", "key": "notes", "approved": true }),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(
        r["rows"],
        json!([{ "rowid": 1, "id": "n1", "text": "one" }])
    );

    let d = post(
        &w,
        "/api/detail",
        json!({ "plugin": "lister", "key": "notes", "row": "n1", "approved": true }),
    )
    .await;
    assert_eq!(d["ok"], true, "{d}");
    assert!(d["text"].is_string());

    let none = post(
        &w,
        "/api/rows",
        json!({ "plugin": "lister", "key": "nothing" }),
    )
    .await;
    assert_eq!(
        none,
        json!({ "ok": false, "said": "There is no list called \"nothing\"." })
    );
    w.done().await;
}

#[tokio::test]
async fn plugin_action_destructive_asks_then_runs_with_approved() {
    let w = world(
        "plugin-action",
        &[(
            "undoable",
            "undoable",
            json!({
                "panel": { "label": "Things", "widgets": [
                    { "type": "action", "key": "set_it", "label": "Set", "tool": "set" },
                    { "type": "table", "key": "things", "label": "Things", "rows": "set",
                      "rowActions": [{ "key": "unset_it", "label": "Unset", "tool": "unset" }] }
                ]}
            }),
        )],
    )
    .await;
    let send = |key: &str, row: &str, approved: bool| json!({ "plugin": "undoable", "key": key, "row": row, "approved": approved });
    // The tool declared nothing, which the gate treats as able to change things.
    let asked = post(&w, "/api/action", send("unset_it", "colour", false)).await;
    assert_eq!(asked["ok"], false, "{asked}");
    assert_eq!(asked["confirm"], true);
    assert!(
        asked["said"].as_str().unwrap().contains("Allow it?"),
        "{asked}"
    );
    assert!(
        w.store
            .audit_search("undoable__unset", 10)
            .unwrap()
            .is_empty(),
        "nothing ran"
    );

    let ran = post(&w, "/api/action", send("unset_it", "colour", true)).await;
    assert_eq!(ran["ok"], true, "{ran}");
    assert_eq!(ran["said"], "unset");
    let audit = w.store.audit_search("undoable__unset", 10).unwrap();
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0].gate, "ask");
    assert_eq!(audit[0].decision, "approved");
    assert_eq!(audit[0].plugin.as_deref(), Some("undoable"));
    assert_eq!(audit[0].args, r#"{"id":"colour"}"#);
    assert_eq!(audit[0].ok, Some(true));
    assert_eq!(
        audit[0].origin,
        serde_json::to_string(&Origin::Window).unwrap()
    );

    // Full trust runs it without asking.
    w.store
        .kv_set("_core", "scope", &json!({ "mode": "full-trust" }))
        .unwrap();
    let direct = post(&w, "/api/action", send("set_it", "", false)).await;
    assert_eq!(direct["ok"], true, "{direct}");
    assert_eq!(
        w.store.audit_search("undoable__set", 10).unwrap()[0].gate,
        "run"
    );

    let wrong = post(&w, "/api/action", send("unset_it", "", true)).await;
    assert_eq!(
        wrong["said"],
        "\"unset_it\" acts on a row, and none was named."
    );
    let none = post(&w, "/api/action", send("nope", "", true)).await;
    assert_eq!(none["said"], "There is no button called \"nope\".");
    w.done().await;
}

const SKILL: &str = "---\nname: tidy-downloads\ndescription: Use when a downloads folder needs sorting into archive folders.\n---\n\n1. List the folder.\n2. Move each file.";

/// Drives one task through the window, which ends in a `learn` frame; returns that frame.
async fn learn_offer(w: &World) -> Value {
    let text = raw(
        w,
        "/api/chat",
        &json!({ "text": "Tidy my downloads into Archive" }),
    )
    .await;
    let frames: Vec<Value> = text
        .lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .filter_map(|d| serde_json::from_str(d).ok())
        .collect();
    frames
        .into_iter()
        .find_map(|f| f.get("learn").cloned())
        .unwrap_or_else(|| panic!("no learn frame in {text}"))
}

#[tokio::test]
async fn learn_accept_saves_skill() {
    let w = world("learn", &[]).await;
    *w.said.lock().unwrap() = SKILL.into();
    let offer = learn_offer(&w).await;
    assert_eq!(offer["about"], "Tidy my downloads into Archive");
    assert_eq!(
        offer["outline"],
        "3 steps, using files__list, files__read, files__move"
    );

    let r = post(
        &w,
        "/api/learn",
        json!({ "action": "save", "name": "", "text": "" }),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["name"], "tidy-downloads");
    assert_eq!(
        r["said"],
        "Learned: tidy-downloads. Use when a downloads folder needs sorting into archive folders."
    );
    // The free model was asked with the episode.
    let asked = w.asked.lock().unwrap().clone();
    let last = asked.last().expect("the router asked the model");
    let shown = last.messages[0].1.content.text();
    assert!(
        shown.contains("The user asked: Tidy my downloads into Archive"),
        "{shown}"
    );
    assert!(
        shown.contains("3. files__move({}) -> files__move worked"),
        "{shown}"
    );

    let file = w
        .data
        .join("skills")
        .join("tidy-downloads")
        .join("SKILL.md");
    let saved = std::fs::read_to_string(&file).unwrap();
    assert!(
        saved.starts_with("---\nmetadata:\n  learned: true\n"),
        "{saved}"
    );
    assert!(saved.contains("learned_from: \"Tidy my downloads into Archive\""));
    // A model wrote it, so it waits for a yes, on both lists.
    let learned = rows(&w, "learned").await;
    assert_eq!(learned["rows"][0]["name"], "tidy-downloads");
    assert_eq!(learned["rows"][0]["from"], "Tidy my downloads into Archive");
    assert_eq!(learned["rows"][0]["state"], "▲ waiting for your yes");
    let skills = rows(&w, "skills").await;
    assert_eq!(
        skills["rows"][0]["where"],
        "written by Alexia, from “Tidy my downloads into Archive”"
    );
    let r = press(&w, "allow_here", "tidy-downloads").await;
    assert_eq!(r["said"], "tidy-downloads is live. Alexia can use it now.");
    assert_eq!(rows(&w, "learned").await["rows"][0]["state"], "● ready");
    let d = post(
        &w,
        "/api/detail",
        json!({ "plugin": "", "key": "learned", "row": "tidy-downloads" }),
    )
    .await;
    assert_eq!(d["text"], "1. List the folder.\n2. Move each file.");

    // The lesson was taken: a second yes has nothing to learn.
    let again = post(&w, "/api/learn", json!({ "action": "save" })).await;
    assert_eq!(
        again,
        json!({ "ok": false, "said": "There is nothing waiting to be learned." })
    );

    // Edit reads, then writes.
    let e = post(
        &w,
        "/api/learn",
        json!({ "action": "edit", "name": "tidy-downloads" }),
    )
    .await;
    assert!(e["text"].as_str().unwrap().contains("1. List the folder."));
    let e = post(&w, "/api/learn", json!({ "action": "edit", "name": "tidy-downloads", "text": format!("{SKILL}\n3. Check.") })).await;
    assert_eq!(e["said"], "Saved.");
    assert!(std::fs::read_to_string(&file)
        .unwrap()
        .ends_with("3. Check.\n"));
    w.done().await;
}

#[tokio::test]
async fn learned_forget() {
    let w = world("forget", &[]).await;
    // The model declining is a real answer: nothing is saved.
    learn_offer(&w).await;
    let r = post(&w, "/api/learn", json!({ "action": "save" })).await;
    assert_eq!(
        r,
        json!({ "ok": false, "said": "There was nothing in that worth keeping for next time." })
    );

    *w.said.lock().unwrap() = SKILL.into();
    learn_offer(&w).await;
    let r = post(&w, "/api/learn", json!({ "action": "save" })).await;
    assert_eq!(r["ok"], true, "{r}");
    let dir = w.data.join("skills").join("tidy-downloads");
    assert!(dir.is_dir());

    let r = post(
        &w,
        "/api/learn",
        json!({ "action": "forget", "name": "tidy-downloads", "confirm": true }),
    )
    .await;
    assert_eq!(
        r,
        json!({ "ok": true, "said": "Forgotten. tidy-downloads is gone." })
    );
    assert!(!dir.exists());
    assert_eq!(rows(&w, "learned").await["rows"], json!([]));
    assert!(w
        .store
        .kv_get("_core", "skill_provenance")
        .unwrap()
        .is_none_or(|v| v.get("tidy-downloads").is_none()));
    let r = post(
        &w,
        "/api/learn",
        json!({ "action": "forget", "name": "tidy-downloads", "confirm": true }),
    )
    .await;
    assert_eq!(
        r,
        json!({ "ok": false, "said": "There is no skill by that name." })
    );
    let r = post(
        &w,
        "/api/learn",
        json!({ "action": "forget", "name": "../outside", "confirm": true }),
    )
    .await;
    assert_eq!(r["ok"], false);
    w.done().await;
}

#[tokio::test]
async fn private_chat_gets_no_offer_and_tools_list() {
    let w = world("private", &[]).await;
    w.store
        .kv_set("_core", "private_sessions", &json!([w.api.session().0]))
        .unwrap();
    let text = raw(&w, "/api/chat", &json!({ "text": "Tidy my downloads" })).await;
    assert!(!text.contains("\"learn\""), "{text}");
    let r = rows(&w, "tools").await;
    assert_eq!(r["ok"], true);
    let r = rows(&w, "library").await;
    assert_eq!(r, json!({ "ok": true, "rows": [] }));
    let r = rows(&w, "nothing").await;
    assert_eq!(
        r,
        json!({ "ok": false, "said": "There is no list called \"nothing\"." })
    );
    w.done().await;
}
