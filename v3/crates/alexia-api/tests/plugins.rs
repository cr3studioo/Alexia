// SPDX-License-Identifier: AGPL-3.0-only
//! P2D-06: the Plugins screen, in-process. `Api::serve` on `127.0.0.1:0` over a real `McpHost`
//! with one plugin folder (the mcp-fixture, its manifest written here at test time), secrets in
//! memory, and requests written by hand over TCP.
//!
//! Needs the fixture binary: `cargo build -p alexia-mcp --bins` (a workspace test run builds it).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use alexia_api::{Api, ApiParts};
use alexia_core::agent::{Agent, AgentParts};
use alexia_core::catalog::Catalog;
use alexia_core::checker::Checker;
use alexia_core::local::{LocalJobs, Runtime};
use alexia_core::prompt::Skills;
use alexia_core::router::Router;
use alexia_core::tools::McpTooling;
use alexia_core::{Brain, BrainError, Bus, DraftSink, Lane, Limits, Reply, Turn};
use alexia_gateway::{Asker, ChannelSet, WindowQuestions};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, PluginId, Timings};
use alexia_scheduler::Scheduler;
use alexia_store::{secrets, Layout, Store};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

/// Generous: a loaded Windows machine is slow, and some of this spawns a process.
const WAIT: Duration = Duration::from_secs(60);

/// Never asked: nothing on this screen talks to a model.
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

fn fixture_exe() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let path = exe
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .join(format!("mcp-fixture{}", std::env::consts::EXE_SUFFIX));
    assert!(
        path.is_file(),
        "run `cargo build -p alexia-mcp --bins` first"
    );
    path
}

struct World {
    api: Arc<Api>,
    host: McpHost,
    store: Arc<Store>,
    id: PluginId,
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
        std::env::temp_dir().join(format!("alexia-plugins-{name}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// `<ext>/<id>/`: the fixture in `greet` mode with one widget of the kinds this screen edits.
fn plugin(ext: &Path, id: &str) {
    let dir = ext.join(id);
    std::fs::create_dir_all(&dir).unwrap();
    let src = fixture_exe();
    let exe = src.file_name().unwrap().to_str().unwrap();
    std::fs::copy(&src, dir.join(exe)).unwrap();
    let m = json!({
        "manifest_version": 1,
        "id": id,
        "name": "Widgets",
        "summary": "A plugin that exists for tests.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": exe, "args": ["greet"] },
        "alexia_protocol": 15,
        "mcp_protocol": "2025-11-25",
        "requires": [{ "cap": "fs.own_dir", "why": "To keep its pictures." }],
        "settings": [
            { "type": "text", "key": "nickname", "label": "Nickname", "default": "Ada" },
            { "type": "password", "key": "secret", "label": "Secret" },
            { "type": "number", "key": "count", "label": "Count", "default": 3, "min": 0, "max": 9 },
            { "type": "toggle", "key": "allow_input", "label": "Allow input", "default": false },
            { "type": "status", "key": "state", "label": "State" },
            { "type": "file", "key": "voice", "label": "Voice" },
            { "type": "action", "key": "greet_now", "label": "Greet", "tool": "greet" }
        ],
        "panel": {
            "label": "Widgets",
            "widgets": [
                { "type": "image", "key": "picture", "label": "Picture", "rows": "greet" }
            ]
        }
    });
    std::fs::write(dir.join("plugin.json"), m.to_string()).unwrap();
}

async fn world(name: &str) -> World {
    std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
    let root = scratch(name);
    let data = root.join("data");
    let ext = root.join("ext");
    std::fs::create_dir_all(&ext).unwrap();
    // One id per test: the in-memory secrets are one map for the whole process.
    let id = PluginId(format!("widgets-{name}"));
    plugin(&ext, &id.0);
    let store = Arc::new(Store::open_in_memory().unwrap());
    // The plugin's status widget, as the plugin would have written it.
    store.set_setting(&id.0, "state", &json!("Ready.")).unwrap();
    let bus = Bus::new(256);
    let host = McpHost::new(
        HostConfig {
            layout: Layout::new(data.clone()),
            plugin_dirs: vec![ext],
            node: PathBuf::from("node"),
            timings: Timings::default(),
        },
        store.clone(),
        Arc::new(NoUpcalls),
        Arc::new(|_| {}),
    );
    host.start(&[]).await.unwrap();
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
        host,
        store,
        id,
        port,
        root,
        cancel,
    }
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

/// `%`-encodes a query value.
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

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
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect();
    let mut rest = raw[split + 4..].to_vec();
    let chunked = headers
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("transfer-encoding") && v.contains("chunked"));
    if chunked {
        let mut out = Vec::new();
        while let Some(end) = rest.windows(2).position(|x| x == b"\r\n") {
            let size = usize::from_str_radix(std::str::from_utf8(&rest[..end]).unwrap().trim(), 16)
                .unwrap();
            if size == 0 {
                break;
            }
            out.extend_from_slice(&rest[end + 2..end + 2 + size]);
            rest.drain(..end + 4 + size);
        }
        rest = out;
    }
    Answer {
        status,
        headers,
        body: rest,
    }
}

async fn post(w: &World, path: &str, body: Value) -> Value {
    let a = send(w, "POST", path, Some(&body)).await;
    assert_eq!(
        a.status,
        200,
        "{path}: {}",
        String::from_utf8_lossy(&a.body)
    );
    a.json()
}

/// The pane for the world's plugin.
async fn pane(w: &World) -> Value {
    let a = send(w, "GET", "/api/plugins", None).await;
    assert_eq!(a.status, 200);
    let all = a.json();
    all["panes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == json!(w.id.0))
        .cloned()
        .expect("the plugin has a pane")
}

fn widget<'a>(pane: &'a Value, key: &str) -> &'a Value {
    pane["settings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["key"] == json!(key))
        .unwrap_or_else(|| panic!("no widget {key}: {pane}"))
}

// ---- the tests ----

#[tokio::test]
async fn panes_hide_password_values() {
    let w = world("hide").await;
    let secret = format!("{}-{}", "tea-for", "two");
    let said = post(
        &w,
        "/api/settings",
        json!({ "plugin": w.id.0, "key": "secret", "value": secret }),
    )
    .await;
    assert_eq!(said["ok"], json!(true), "{said}");

    let a = send(&w, "GET", "/api/plugins", None).await;
    assert!(
        !String::from_utf8_lossy(&a.body).contains(&secret),
        "the secret reached the screen"
    );
    let p = pane(&w).await;
    assert_eq!(p["name"], json!("Widgets"));
    assert_eq!(p["enabled"], json!(false));
    assert_eq!(p["running"], json!(false));
    assert_eq!(
        p["requires"],
        json!([{ "cap": "fs.own_dir", "why": "To keep its pictures." }])
    );
    let pw = widget(&p, "secret");
    assert_eq!(pw["set"], json!(true));
    assert!(pw["stored"].as_str().unwrap().starts_with("Stored in "));
    assert!(pw.get("value").is_none());
    // Values: the default, and the status widget's text as the plugin left it.
    assert_eq!(widget(&p, "count")["value"], json!(3));
    assert_eq!(widget(&p, "state")["value"], json!("Ready."));
    // Nothing is running, so an action's tool is not known missing.
    assert_eq!(widget(&p, "greet_now")["available"], json!(true));
    assert_eq!(p["panel"]["label"], json!("Widgets"));
    assert_eq!(p["panel"]["widgets"][0]["key"], json!("picture"));
    assert_eq!(p["page"]["sizes"]["M"]["show"], json!(["picture"]));

    // Cleared: no longer set, and gone from the keychain.
    post(
        &w,
        "/api/settings",
        json!({ "plugin": w.id.0, "key": "secret", "value": "" }),
    )
    .await;
    assert_eq!(widget(&pane(&w).await, "secret")["set"], json!(false));
    assert_eq!(secrets::get(&w.id.0, "secret").unwrap(), None);
}

#[tokio::test]
async fn setting_validated() {
    let w = world("valid").await;
    let set = |key: &str, value: Value| json!({ "plugin": w.id.0, "key": key, "value": value });

    let out = post(&w, "/api/settings", set("count", json!(10))).await;
    assert_eq!(
        out,
        json!({ "ok": false, "why": "\"Count\" must be at most 9." })
    );
    let out = post(&w, "/api/settings", set("count", json!("five"))).await;
    assert_eq!(out["why"], json!("\"Count\" takes a number."));
    let out = post(&w, "/api/settings", set("allow_input", json!("yes"))).await;
    assert_eq!(out["why"], json!("\"Allow input\" is on or off."));
    let out = post(&w, "/api/settings", set("state", json!("Hacked."))).await;
    assert_eq!(
        out["why"],
        json!("\"State\" is driven by the plugin, not by you.")
    );
    let out = post(&w, "/api/settings", set("voice", json!("C:/x.onnx"))).await;
    assert_eq!(
        out["why"],
        json!("\"Voice\" is a file you choose, not a path you type.")
    );
    let out = post(&w, "/api/settings", set("nope", json!(1))).await;
    assert_eq!(
        out["why"],
        json!(format!("{} has no setting called \"nope\"", w.id.0))
    );
    assert!(
        w.store.settings(&w.id.0).unwrap().get("count").is_none(),
        "a refused value is not kept"
    );

    // In range: kept, and the pane shows it.
    let out = post(&w, "/api/settings", set("count", json!(5))).await;
    assert_eq!(out["ok"], json!(true));
    assert_eq!(w.store.settings(&w.id.0).unwrap()["count"], json!(5));
    let out = post(&w, "/api/settings", set("allow_input", json!(true))).await;
    assert_eq!(out["ok"], json!(true));
    let p = pane(&w).await;
    assert_eq!(widget(&p, "count")["value"], json!(5));
    assert_eq!(widget(&p, "allow_input")["value"], json!(true));

    // A plugin that is not installed (P5).
    let out = post(
        &w,
        "/api/settings",
        json!({ "plugin": "demo", "key": "k", "value": "v" }),
    )
    .await;
    assert_eq!(
        out,
        json!({ "ok": false, "why": "demo has no setting called \"k\"" })
    );
}

#[tokio::test]
async fn password_setting_goes_to_keychain() {
    let w = world("keychain").await;
    let secret = format!("{}{}", "correct-horse-", "battery");
    let out = post(
        &w,
        "/api/settings",
        json!({ "plugin": w.id.0, "key": "secret", "value": secret }),
    )
    .await;
    assert_eq!(out["ok"], json!(true));
    // Credential Manager, as `<plugin>.<key>` (here the in-memory backend).
    assert_eq!(
        secrets::get(&w.id.0, "secret").unwrap(),
        Some(secret.clone())
    );
    // Never in the store: not in settings, not in kv.
    assert!(w.store.settings(&w.id.0).unwrap().get("secret").is_none());
    let rows = w
        .store
        .transaction(|tx| {
            let mut stmt = tx.prepare("SELECT ns || key || value FROM kv")?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .unwrap();
    assert!(rows.iter().all(|r| !r.contains(&secret)), "{rows:?}");
}

/// The fixture's stderr, until a line holds `needle`.
async fn logged(w: &World, needle: &str) -> String {
    let began = Instant::now();
    loop {
        if let Some(line) = w.host.log(&w.id).into_iter().find(|l| l.contains(needle)) {
            return line;
        }
        assert!(
            began.elapsed() < WAIT,
            "the plugin never logged {needle}: {:?}",
            w.host.log(&w.id)
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn settings_changed_reaches_plugin() {
    let w = world("changed").await;
    let out = post(
        &w,
        "/api/plugin",
        json!({ "id": w.id.0, "action": "enable" }),
    )
    .await;
    assert_eq!(out["ok"], json!(true), "{out}");
    // Running: its tools were listed.
    assert!(w.host.tools().await.iter().any(|t| t.plugin == w.id));
    let out = post(
        &w,
        "/api/settings",
        json!({ "plugin": w.id.0, "key": "nickname", "value": "Grace" }),
    )
    .await;
    assert_eq!(out["ok"], json!(true));
    let line = logged(&w, "alexia/settings/changed").await;
    assert!(line.contains(r#""changed":{"nickname":"Grace"}"#), "{line}");

    // An upload is a setting too: the bytes in the plugin's own folder, the path its value.
    let out = post(
        &w,
        "/api/upload",
        json!({ "plugin": w.id.0, "key": "voice", "name": "..\\..\\ada.onnx", "data": "aGk=" }),
    )
    .await;
    assert_eq!(out["ok"], json!(true), "{out}");
    let path = PathBuf::from(out["path"].as_str().unwrap());
    let own = w.api.parts.layout.own_dir(&w.id.0);
    assert_eq!(path, own.join("uploads").join("voice").join("ada.onnx"));
    assert_eq!(std::fs::read(&path).unwrap(), b"hi");
    assert_eq!(
        w.store.settings(&w.id.0).unwrap()["voice"],
        json!(path.to_string_lossy())
    );
    logged(&w, r#""changed":{"voice":"#).await;
    // A widget that is not a file does not take one.
    let out = post(
        &w,
        "/api/upload",
        json!({ "plugin": w.id.0, "key": "nickname", "name": "a.txt", "data": "aGk=" }),
    )
    .await;
    assert_eq!(out["why"], json!("\"Nickname\" does not take a file."));
    w.host.shutdown().await;
}

#[tokio::test]
async fn trust_makes_tools_reviewed() {
    let w = world("trust").await;
    let fixture = fixture_exe();
    let out = post(
        &w,
        "/api/server",
        json!({ "id": "added-server", "name": "Added", "run": fixture.to_string_lossy(), "args": ["greet"] }),
    )
    .await;
    assert_eq!(out["ok"], json!(true), "{out}");
    assert!(out["unreviewed"]
        .as_array()
        .unwrap()
        .contains(&json!("added-server")));
    let server = PluginId("added-server".into());
    let out = post(
        &w,
        "/api/plugin",
        json!({ "id": "added-server", "action": "enable" }),
    )
    .await;
    assert_eq!(out["ok"], json!(true));
    let tools = w.host.tools().await;
    let mine: Vec<_> = tools.iter().filter(|t| t.plugin == server).collect();
    assert!(!mine.is_empty() && mine.iter().all(|t| !t.reviewed));

    // Trust is a confirmed act: refused without `confirm`.
    let a = send(
        &w,
        "POST",
        "/api/server",
        Some(&json!({ "id": "added-server", "action": "trust" })),
    )
    .await;
    assert_eq!(a.status, 409);
    assert!(w
        .host
        .tools()
        .await
        .iter()
        .all(|t| t.plugin != server || !t.reviewed));

    let out = post(
        &w,
        "/api/server",
        json!({ "id": "added-server", "action": "trust", "confirm": true }),
    )
    .await;
    assert_eq!(out["ok"], json!(true));
    assert!(!out["unreviewed"]
        .as_array()
        .unwrap()
        .contains(&json!("added-server")));
    let tools = w.host.tools().await;
    assert!(tools
        .iter()
        .filter(|t| t.plugin == server)
        .all(|t| t.reviewed));
    assert!(tools.iter().any(|t| t.plugin == server));
    w.host.shutdown().await;
}

fn enabled_list(w: &World) -> Vec<String> {
    serde_json::from_value(w.store.kv_get("_core", "enabled").unwrap().unwrap()).unwrap()
}

#[tokio::test]
async fn disable_persists_enabled_list() {
    let w = world("enabled").await;
    let out = post(
        &w,
        "/api/plugin",
        json!({ "id": w.id.0, "action": "enable" }),
    )
    .await;
    assert_eq!(out["ok"], json!(true));
    assert_eq!(enabled_list(&w), vec![w.id.0.clone()]);
    assert_eq!(pane(&w).await["enabled"], json!(true));

    let out = post(
        &w,
        "/api/plugin",
        json!({ "id": w.id.0, "action": "disable" }),
    )
    .await;
    assert_eq!(out["ok"], json!(true));
    assert!(enabled_list(&w).is_empty());
    assert_eq!(pane(&w).await["enabled"], json!(false));

    // v2's sentences for what is not there and what is not an action (which the gate treats as
    // a delete would be: confirmed first).
    let out = post(
        &w,
        "/api/plugin",
        json!({ "id": "demo", "action": "enable" }),
    )
    .await;
    assert_eq!(
        out,
        json!({ "ok": false, "said": "There is no plugin called “demo”." })
    );
    let out = post(
        &w,
        "/api/plugin",
        json!({ "id": w.id.0, "action": "explode", "confirm": true }),
    )
    .await;
    assert_eq!(
        out["said"],
        json!("“explode” is not something to do to a plugin.")
    );

    // Delete (confirmed) purges it and takes its folder.
    let folder = w.host.plugin_dir(&w.id).unwrap().path;
    let out = post(
        &w,
        "/api/plugin",
        json!({ "id": w.id.0, "action": "delete", "confirm": true }),
    )
    .await;
    assert_eq!(out["ok"], json!(true), "{out}");
    assert!(!folder.exists());
    assert!(out["panes"].as_array().unwrap().is_empty());
    assert!(w.store.settings(&w.id.0).unwrap().is_empty());
}

#[tokio::test]
async fn install_from_a_folder() {
    let w = world("install").await;
    let src = w.root.join("elsewhere");
    plugin(&src, "brought-in");
    let out = post(
        &w,
        "/api/install",
        json!({ "path": format!("{}\\", src.join("brought-in").display()), "confirm": true }),
    )
    .await;
    assert_eq!(out["ok"], json!(true), "{out}");
    assert_eq!(
        out["said"],
        json!("brought-in is installed. Read what it asked for, then enable it.")
    );
    let installed = out["panes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == json!("brought-in"))
        .cloned()
        .unwrap();
    assert_eq!(installed["enabled"], json!(false));
    // The list is written, so a hub that had none does not take the new one for enabled.
    assert!(!enabled_list(&w).contains(&"brought-in".to_owned()));

    let out = post(
        &w,
        "/api/install",
        json!({ "path": w.root.join("no-such").to_string_lossy() }),
    )
    .await;
    assert_eq!(out["ok"], json!(false));
    assert!(out["said"]
        .as_str()
        .unwrap()
        .starts_with("There is no folder at "));
}

/// A directory link at `link` to `target`: a junction on Windows, a symlink elsewhere.
fn link_dir(target: &Path, link: &Path) {
    #[cfg(windows)]
    {
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|o| o.status.success());
        assert!(ok, "a junction could not be made for the test");
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[tokio::test]
async fn plugin_file_escape_refused() {
    let w = world("file").await;
    let own = w.api.parts.layout.own_dir(&w.id.0);
    std::fs::create_dir_all(own.join("pics")).unwrap();
    std::fs::write(own.join("pics").join("a.png"), b"\x89PNG").unwrap();
    let outside = w.root.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), b"not the plugin's").unwrap();
    // Another plugin's own folder, next door.
    let next = w.api.parts.layout.own_dir("next-door");
    std::fs::create_dir_all(&next).unwrap();
    std::fs::write(next.join("b.png"), b"\x89PNG").unwrap();
    link_dir(&outside, &own.join("link"));

    let get = |path: String| {
        let w = &w;
        async move {
            let q = format!(
                "/api/plugin-file?plugin={}&path={}",
                encode(&w.id.0),
                encode(&path)
            );
            send(w, "GET", &q, None).await
        }
    };
    // Inside: relative and absolute.
    let a = get("pics/a.png".into()).await;
    assert_eq!(a.status, 200);
    assert_eq!(a.header("content-type"), Some("image/png"));
    assert_eq!(a.body, b"\x89PNG");
    let a = get(own
        .join("pics")
        .join("a.png")
        .to_string_lossy()
        .into_owned())
    .await;
    assert_eq!(a.status, 200);

    let refused = "A plugin may only show files from its own folder.";
    // `..` out to the neighbour.
    let a = get("../next-door/b.png".into()).await;
    assert_eq!((a.status, a.json()["said"].clone()), (403, json!(refused)));
    // An absolute path outside.
    let a = get(outside.join("secret.txt").to_string_lossy().into_owned()).await;
    assert_eq!(a.status, 403);
    // A link inside that points outside.
    let a = get("link/secret.txt".into()).await;
    assert_eq!(a.status, 403, "{}", String::from_utf8_lossy(&a.body));
    assert!(!String::from_utf8_lossy(&a.body).contains("not the plugin's"));
    // Not there; not a plugin (P7).
    let a = get("pics/none.png".into()).await;
    assert_eq!(
        (a.status, a.json()["said"].clone()),
        (404, json!("That file is not there."))
    );
    let a = send(&w, "GET", "/api/plugin-file?plugin=demo&path=a.png", None).await;
    assert_eq!(
        (a.status, a.json()),
        (
            404,
            json!({ "ok": false, "said": "There is no plugin by that name." })
        )
    );
}
