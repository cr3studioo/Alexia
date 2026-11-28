// SPDX-License-Identifier: AGPL-3.0-only
//! P2D-08: the Library screen, in-process. `Api::serve` on `127.0.0.1:0` over a real `McpHost`,
//! secrets in memory, and the registry a local fake (a static `/v0/` layout served over TCP by
//! this file, pointed at through kv `_core`/`registry`). No network beyond loopback.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
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
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

/// Generous: a loaded Windows machine is slow.
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

// ---- the fake registry ----

#[derive(Clone)]
struct Served {
    status: u16,
    body: Vec<u8>,
    /// Sent in twenty pieces, a pause between each, so a download is seen under way.
    slow: bool,
}

#[derive(Clone)]
struct Registry {
    base: String,
    files: Arc<Mutex<HashMap<String, Served>>>,
}

impl Registry {
    async fn start() -> Registry {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let files: Arc<Mutex<HashMap<String, Served>>> = Arc::default();
        let held = files.clone();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                tokio::spawn(serve_one(sock, held.clone()));
            }
        });
        let r = Registry { base, files };
        r.json("/v0/plugins.json", json!({ "plugins": [] }));
        r.json("/v0/skills.json", json!({ "skills": [] }));
        r.json("/v0/revoked.json", json!({ "plugins": [], "skills": [] }));
        r
    }

    fn put(&self, path: &str, status: u16, body: Vec<u8>, slow: bool) {
        self.files
            .lock()
            .unwrap()
            .insert(path.to_owned(), Served { status, body, slow });
    }

    fn json(&self, path: &str, v: Value) {
        self.put(path, 200, v.to_string().into_bytes(), false);
    }

    /// An archive at `/files/<name>`; its URL.
    fn file(&self, name: &str, bytes: Vec<u8>, slow: bool) -> String {
        let path = format!("/files/{name}");
        self.put(&path, 200, bytes, slow);
        format!("{}{path}", self.base)
    }

    /// `plugins.json` and each row's own `/v0/plugins/<id>.json`.
    fn offer(&self, rows: &[Value]) {
        self.json("/v0/plugins.json", json!({ "plugins": rows }));
        for r in rows {
            self.json(
                &format!("/v0/plugins/{}.json", r["id"].as_str().unwrap()),
                r.clone(),
            );
        }
    }
}

async fn serve_one(mut sock: TcpStream, files: Arc<Mutex<HashMap<String, Served>>>) {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        match sock.read(&mut tmp).await {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
        }
    }
    let head = String::from_utf8_lossy(&buf).into_owned();
    let path = head
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .split('?')
        .next()
        .unwrap_or("/")
        .to_owned();
    let found = files.lock().unwrap().get(&path).cloned();
    let Some(s) = found else {
        let _ = sock
            .write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
            .await;
        return;
    };
    let head = format!(
        "HTTP/1.1 {} X\r\ncontent-type: application/octet-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        s.status,
        s.body.len()
    );
    if sock.write_all(head.as_bytes()).await.is_err() {
        return;
    }
    if s.slow {
        let piece = s.body.len().div_ceil(20).max(1);
        for chunk in s.body.chunks(piece) {
            if sock.write_all(chunk).await.is_err() || sock.flush().await.is_err() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    } else {
        let _ = sock.write_all(&s.body).await;
    }
    let _ = sock.flush().await;
}

// ---- fixtures ----

fn manifest(id: &str, version: &str) -> Value {
    json!({
        "manifest_version": 1,
        "id": id,
        "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.",
        "version": version,
        "license": "AGPL-3.0-only",
        "entry": { "run": "node", "args": ["index.js"] },
        "alexia_protocol": 15,
        "mcp_protocol": "2025-11-25",
        "requires": [{ "cap": "fs.own_dir", "why": "To keep its notes." }]
    })
}

fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, bytes) in files {
        w.start_file(*name, opts).unwrap();
        w.write_all(bytes).unwrap();
    }
    w.finish().unwrap().into_inner()
}

/// A plugin archive the way `npm pack` lays one out: everything under `package/`.
fn plugin_zip(id: &str, version: &str) -> Vec<u8> {
    let m = manifest(id, version).to_string();
    zip_of(&[
        ("package/plugin.json", m.as_bytes()),
        ("package/index.js", b"// nothing runs in these tests\n"),
        ("package/VERSION.txt", version.as_bytes()),
    ])
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// A registry row for `id` at `version`, downloadable from `url` with digest `sha256`.
fn row(id: &str, version: &str, url: &str, sha256: &str) -> Value {
    json!({
        "id": id,
        "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.",
        "version": version,
        "license": "AGPL-3.0-only",
        "url": url,
        "sha256": sha256,
        "alexia_protocol": 15,
        "mcp_protocol": "2025-11-25",
        "requires": [{ "cap": "fs.own_dir", "why": "To keep its notes." }],
        "provides": [],
        "updated_at": 0
    })
}

// ---- the world ----

struct World {
    api: Arc<Api>,
    host: McpHost,
    store: Arc<Store>,
    reg: Registry,
    port: u16,
    root: PathBuf,
    ext: PathBuf,
    layout: Layout,
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
        std::env::temp_dir().join(format!("alexia-library-{name}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A hub with `installed` plugin folders (id, version) already in its extensions folder, and
/// the registry pointed at a fresh fake.
async fn world(name: &str, installed: &[(&str, &str)]) -> World {
    std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
    let root = scratch(name);
    let data = root.join("data");
    let ext = root.join("ext");
    std::fs::create_dir_all(&ext).unwrap();
    for (id, version) in installed {
        let dir = ext.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plugin.json"), manifest(id, version).to_string()).unwrap();
    }
    let store = Arc::new(Store::open_in_memory().unwrap());
    let reg = Registry::start().await;
    store
        .kv_set("_core", "registry", &json!(format!("{}/", reg.base)))
        .unwrap();
    let bus = Bus::new(256);
    let host = McpHost::new(
        HostConfig {
            layout: Layout::new(data.clone()),
            plugin_dirs: vec![ext.clone()],
            node: PathBuf::from("node"),
            timings: Timings::default(),
            dial: None,
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
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    tokio::spawn(api.clone().serve(listener, cancel.clone()));
    World {
        api,
        host,
        store,
        reg,
        port,
        root,
        ext,
        layout: Layout::new(data),
        cancel,
    }
}

// ---- HTTP by hand ----

async fn send(port: u16, token: &str, method: &str, path: &str, body: Option<&Value>) -> Value {
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nx-alexia-token: {token}\r\n"
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
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
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
    assert!(head.starts_with("HTTP/1.1 200"), "{path}: {head}");
    let mut rest = raw[split + 4..].to_vec();
    if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
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
    serde_json::from_slice(&rest)
        .unwrap_or_else(|_| panic!("not JSON: {}", String::from_utf8_lossy(&rest)))
}

impl World {
    async fn get(&self, path: &str) -> Value {
        send(self.port, self.api.token(), "GET", path, None).await
    }

    async fn install(&self, body: Value) -> Value {
        send(
            self.port,
            self.api.token(),
            "POST",
            "/api/library/install",
            Some(&body),
        )
        .await
    }

    fn status(&self, id: &str) -> Option<alexia_mcp::PluginStatus> {
        self.host
            .plugins()
            .into_iter()
            .find(|p| p.id == PluginId(id.into()))
    }

    fn kv(&self, key: &str) -> Value {
        self.store
            .kv_get("_core", key)
            .unwrap()
            .unwrap_or(Value::Null)
    }
}

fn ids(list: &Value) -> Vec<&str> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect()
}

// ---- the tests ----

#[tokio::test]
async fn lists_plugins_and_updates() {
    let w = world("lists", &[("beta", "1.0.0"), ("delta", "1.0.0")]).await;
    let url = w.reg.file("any.zip", plugin_zip("alpha", "1.0.0"), false);
    let digest = sha(&plugin_zip("alpha", "1.0.0"));
    let mut gamma = row("gamma", "1.0.0", &url, &digest);
    gamma["min_app"] = json!("99.0.0");
    let mut stale = row("stale", "1.0.0", &url, &digest);
    stale["alexia_protocol"] = json!(1);
    let mut delta = row("delta", "2.0.0", &url, &digest);
    delta["alexia_protocol"] = json!(99);
    w.reg.offer(&[
        row("alpha", "1.0.0", &url, &digest),
        row("beta", "2.0.0", &url, &digest),
        gamma,
        stale,
        delta,
        row("badsha", "1.0.0", &url, "not-a-digest"),
        json!({ "id": "voice", "name": "Voice", "summary": "Talk to Alexia.", "coming_soon": true }),
    ]);
    w.reg.json(
        "/v0/skills.json",
        json!({ "skills": [{ "id": "tidy", "name": "tidy", "description": "Keeps things tidy.", "url": url, "sha256": digest }] }),
    );

    let got = w.get("/api/library").await;
    assert_eq!(got["ok"], true, "{got}");
    assert_eq!(got["registry"], format!("{}/", w.reg.base));
    assert_eq!(got["app"], "3.0.0");
    assert_eq!(got["verifying"], false);
    assert_eq!(ids(&got["plugins"]), ["alpha", "beta", "voice"]);
    let plugins = got["plugins"].as_array().unwrap();
    assert_eq!(plugins[0]["installed"], false);
    assert_eq!(plugins[0]["offer"], "ok");
    assert_eq!(plugins[0]["requires"][0]["why"], "To keep its notes.");
    assert_eq!(plugins[1]["installed"], true);
    assert_eq!(plugins[2]["coming_soon"], true);
    assert!(plugins[2].get("url").is_none());
    assert_eq!(
        got["updates"],
        json!([{ "id": "beta", "from": "1.0.0", "to": "2.0.0" }])
    );
    assert_eq!(got["needsNewerApp"], json!({ "plugins": 1, "updates": 1 }));
    assert_eq!(ids(&got["skills"]), ["tidy"]);
    assert_eq!(got["skills"][0]["installed"], false);
    assert_eq!(got["revoked"], json!([]));
}

#[tokio::test]
async fn unreachable_registry_says_so() {
    let w = world("unreachable", &[]).await;
    // A port nothing listens on: bound, then let go.
    let dead = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/", dead.local_addr().unwrap());
    drop(dead);
    w.store.kv_set("_core", "registry", &json!(base)).unwrap();
    let got = w.get("/api/library").await;
    assert_eq!(got["ok"], false);
    assert_eq!(got["registry"], base);
    assert!(
        got["why"]
            .as_str()
            .unwrap()
            .starts_with("Could not reach the plugin shelf: "),
        "{got}"
    );
}

#[tokio::test]
async fn install_checks_sha256() {
    let w = world("sha", &[]).await;
    let bytes = plugin_zip("alpha", "1.0.0");
    let url = w.reg.file("alpha.zip", bytes.clone(), false);
    w.reg
        .offer(&[row("alpha", "1.0.0", &url, &sha(b"some other bytes"))]);
    let got = w
        .install(json!({ "id": "alpha", "kind": "plugin", "confirm": true }))
        .await;
    assert_eq!(got["ok"], false, "{got}");
    let said = got["said"].as_str().unwrap();
    assert!(said.contains("not what the registry described"), "{said}");
    assert!(said.ends_with("Nothing was installed."), "{said}");
    assert!(!w.ext.join("alpha").exists());
    assert!(w.status("alpha").is_none());

    // The right digest installs it: in the extensions folder, loaded, not enabled.
    w.reg.offer(&[row("alpha", "1.0.0", &url, &sha(&bytes))]);
    let got = w
        .install(json!({ "id": "alpha", "kind": "plugin", "confirm": true }))
        .await;
    assert_eq!(got["ok"], true, "{got}");
    assert_eq!(
        got["said"],
        "alpha is installed. Read what it asked for, then enable it."
    );
    assert!(w.ext.join("alpha").join("plugin.json").is_file());
    assert!(w.ext.join("alpha").join("index.js").is_file());
    let s = w.status("alpha").expect("the host loaded it");
    assert!(!s.enabled);
    assert_eq!(w.kv("enabled"), json!([]));

    // Twice is refused in v2's words.
    let got = w
        .install(json!({ "id": "alpha", "kind": "plugin", "confirm": true }))
        .await;
    assert_eq!(got["ok"], false);
    assert_eq!(
        got["said"],
        "Plugin alpha is already installed. Delete it first to replace it."
    );

    // Something the registry does not have (L3).
    let got = w
        .install(json!({ "id": "nope", "kind": "plugin", "confirm": true }))
        .await;
    assert_eq!(
        got,
        json!({ "ok": false, "said": "The registry has no plugin called “nope”." })
    );
}

#[tokio::test]
async fn install_and_enable_only_when_asked() {
    let w = world("enable", &[]).await;
    let bytes = plugin_zip("bravo", "1.0.0");
    let url = w.reg.file("bravo.zip", bytes.clone(), false);
    w.reg.offer(&[row("bravo", "1.0.0", &url, &sha(&bytes))]);
    let got = w
        .install(json!({ "id": "bravo", "kind": "plugin", "enable": true, "confirm": true }))
        .await;
    assert_eq!(got["ok"], true, "{got}");
    assert!(w.status("bravo").unwrap().enabled);
    assert_eq!(w.kv("enabled"), json!(["bravo"]));
}

#[tokio::test]
async fn update_replaces_the_folder_and_keeps_it_off() {
    let w = world("update", &[("beta", "1.0.0")]).await;
    std::fs::write(w.ext.join("beta").join("OLD.txt"), "gone after the update").unwrap();
    let bytes = plugin_zip("beta", "2.0.0");
    let url = w.reg.file("beta.zip", bytes.clone(), false);
    w.reg.offer(&[row("beta", "2.0.0", &url, &sha(&bytes))]);
    let got = w
        .install(json!({ "id": "beta", "kind": "plugin", "update": true, "confirm": true }))
        .await;
    assert_eq!(got["ok"], true, "{got}");
    let s = w.status("beta").unwrap();
    assert_eq!(s.version, "2.0.0");
    assert!(
        !s.enabled,
        "an update is not consent to run something that was off"
    );
    assert!(!w.ext.join("beta").join("OLD.txt").exists());
    assert_eq!(
        std::fs::read_to_string(w.ext.join("beta").join("VERSION.txt")).unwrap(),
        "2.0.0"
    );
    let listed = w.get("/api/library").await;
    assert_eq!(listed["updates"], json!([]));
}

#[tokio::test]
async fn progress_reported() {
    let w = world("progress", &[]).await;
    // About a megabyte that does not compress, sent in twenty pieces three seconds long.
    let mut noise = vec![0u8; 1 << 20];
    let mut x: u32 = 0x9E37_79B9;
    for b in noise.iter_mut() {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        *b = x as u8;
    }
    let m = manifest("charlie", "1.0.0").to_string();
    let bytes = zip_of(&[
        ("charlie/plugin.json", m.as_bytes()),
        ("charlie/noise.bin", &noise),
    ]);
    let url = w.reg.file("charlie.zip", bytes.clone(), true);
    w.reg.offer(&[row("charlie", "1.0.0", &url, &sha(&bytes))]);

    assert_eq!(
        w.get("/api/library/progress?id=charlie").await,
        json!({ "done": 0 })
    );
    let (port, token) = (w.port, w.api.token().to_owned());
    let installing = tokio::spawn(async move {
        let body = json!({ "id": "charlie", "kind": "plugin", "confirm": true });
        send(port, &token, "POST", "/api/library/install", Some(&body)).await
    });
    let started = Instant::now();
    let mut seen: Option<Value> = None;
    while !installing.is_finished() && started.elapsed() < WAIT {
        let p = w.get("/api/library/progress?id=charlie").await;
        if p["done"].as_u64().unwrap_or(0) > 0 {
            seen = Some(p);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let got = tokio::time::timeout(WAIT, installing)
        .await
        .expect("the install finished in time")
        .unwrap();
    assert_eq!(got["ok"], true, "{got}");
    let seen = seen.expect("progress was seen while the download was under way");
    assert!(seen["done"].as_u64().unwrap() <= bytes.len() as u64);
    assert_eq!(seen["total"], bytes.len() as u64);
    // Over: back to nothing under way.
    assert_eq!(
        w.get("/api/library/progress?id=charlie").await,
        json!({ "done": 0 })
    );
}

#[tokio::test]
async fn revoked_not_offered() {
    let w = world("revoked", &[("old", "1.0.0")]).await;
    let bytes = plugin_zip("pulled", "1.0.0");
    let url = w.reg.file("pulled.zip", bytes.clone(), false);
    let digest = sha(&bytes);
    w.reg.offer(&[
        row("pulled", "1.0.0", &url, &digest),
        row("old", "1.0.0", &url, &digest),
    ]);
    w.reg.put(
        "/v0/plugins/pulled.json",
        410,
        json!({ "reason": "It sent data home." })
            .to_string()
            .into_bytes(),
        false,
    );
    let pulled =
        |id: &str| json!({ "id": id, "revoked_at": 1, "revoked_reason": "It sent data home." });
    w.reg.json(
        "/v0/revoked.json",
        json!({ "plugins": [pulled("pulled"), pulled("old")], "skills": [pulled("grim")] }),
    );
    w.reg.json(
        "/v0/skills.json",
        json!({ "skills": [{ "id": "grim", "name": "grim", "description": "d", "url": url, "sha256": digest }] }),
    );

    let got = w.get("/api/library").await;
    assert_eq!(got["ok"], true, "{got}");
    // Withdrawn is not offered, installed here or not; only what is here is named.
    assert_eq!(got["plugins"], json!([]));
    assert_eq!(ids(&got["revoked"]), ["old"]);
    assert_eq!(got["skills"], json!([]));

    let got = w
        .install(json!({ "id": "pulled", "kind": "plugin", "confirm": true }))
        .await;
    assert_eq!(
        got,
        json!({ "ok": false, "said": "pulled has been withdrawn from the registry: It sent data home." })
    );
    assert!(!w.ext.join("pulled").exists());
    let got = w.install(json!({ "id": "grim", "kind": "skill" })).await;
    assert_eq!(got["ok"], false);
    assert!(!w.layout.skills().join("grim").exists());
}

#[tokio::test]
async fn zip_slip_refused() {
    let w = world("slip", &[]).await;
    let marker = format!("alexia-escaped-{}.txt", std::process::id());
    let m = manifest("evil", "1.0.0").to_string();
    let outside = format!("../../{marker}");
    let bytes = zip_of(&[
        ("evil/plugin.json", m.as_bytes()),
        (outside.as_str(), b"written outside the folder"),
    ]);
    let url = w.reg.file("evil.zip", bytes.clone(), false);
    w.reg.offer(&[row("evil", "1.0.0", &url, &sha(&bytes))]);
    let got = w
        .install(json!({ "id": "evil", "kind": "plugin", "confirm": true }))
        .await;
    assert_eq!(got["ok"], false, "{got}");
    let said = got["said"].as_str().unwrap();
    assert!(said.contains("would land outside its own folder"), "{said}");
    assert!(!w.ext.join("evil").exists());
    assert!(w.status("evil").is_none());
    assert!(!std::env::temp_dir().join(&marker).exists());
}

/// The archive format GitHub releases carry, unpacked by the system's own tar.
#[tokio::test]
async fn tgz_unpacked_by_the_system_tar() {
    let w = world("tgz", &[]).await;
    let src = w.root.join("src");
    let dir = src.join("delta");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("plugin.json"),
        manifest("delta", "1.0.0").to_string(),
    )
    .unwrap();
    let archive = w.root.join("delta.tgz");
    let tar = match std::env::var("SystemRoot") {
        Ok(root) if cfg!(windows) => Path::new(&root).join("System32").join("tar.exe"),
        _ => PathBuf::from("tar"),
    };
    let made = std::process::Command::new(tar)
        .arg("-czf")
        .arg(&archive)
        .arg("-C")
        .arg(&src)
        .arg("delta")
        .status()
        .unwrap();
    assert!(made.success());
    let bytes = std::fs::read(&archive).unwrap();
    let url = w.reg.file("delta.tgz", bytes.clone(), false);
    w.reg.offer(&[row("delta", "1.0.0", &url, &sha(&bytes))]);
    let got = w
        .install(json!({ "id": "delta", "kind": "plugin", "confirm": true }))
        .await;
    assert_eq!(got["ok"], true, "{got}");
    assert!(w.ext.join("delta").join("plugin.json").is_file());
}

#[tokio::test]
async fn skill_install_preauthorised() {
    let w = world("skill", &[]).await;
    let skill = b"---\nname: tidy\ndescription: Keeps things tidy.\n---\nPut things back.\n";
    let bytes = zip_of(&[("tidy/SKILL.md", skill)]);
    let url = w.reg.file("tidy.zip", bytes.clone(), false);
    let wrong = w.reg.file("messy.zip", bytes.clone(), false);
    w.reg.json(
        "/v0/skills.json",
        json!({ "skills": [
            { "id": "tidy", "name": "tidy", "description": "Keeps things tidy.", "url": url, "sha256": sha(&bytes) },
            { "id": "messy", "name": "messy", "description": "d", "url": wrong, "sha256": sha(b"other") },
        ] }),
    );
    let got = w.install(json!({ "id": "tidy", "kind": "skill" })).await;
    assert_eq!(
        got,
        json!({ "ok": true, "said": "tidy is installed and Alexia can read it now." })
    );
    assert!(w.layout.skills().join("tidy").join("SKILL.md").is_file());
    assert_eq!(w.kv("skill_preauth"), json!(["tidy"]));
    assert_eq!(w.kv("skill_provenance")["tidy"], "installed");
    let listed = w.get("/api/library").await;
    let tidy = listed["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "tidy")
        .unwrap();
    assert_eq!(tidy["installed"], true);

    // A wrong digest writes nothing and pre-authorises nothing.
    let got = w.install(json!({ "id": "messy", "kind": "skill" })).await;
    assert_eq!(
        got,
        json!({ "ok": false, "said": "What downloaded is not what the registry described. Nothing was installed." })
    );
    assert!(!w.layout.skills().join("messy").exists());
    assert_eq!(w.kv("skill_preauth"), json!(["tidy"]));
}

#[tokio::test]
async fn skill_not_written_takes_back_its_preauth() {
    let w = world("skill-unwritable", &[]).await;
    let skill = b"---\nname: neat\ndescription: Neat.\n---\nBe neat.\n";
    let bytes = zip_of(&[("neat/SKILL.md", skill)]);
    let url = w.reg.file("neat.zip", bytes.clone(), false);
    w.reg.json(
        "/v0/skills.json",
        json!({ "skills": [
            { "id": "neat", "name": "neat", "description": "Neat.", "url": url, "sha256": sha(&bytes) },
        ] }),
    );
    // Something else (a file) sits where the skills folder belongs, so the copy cannot happen.
    let skills = w.layout.skills();
    let _ = std::fs::remove_dir_all(&skills);
    std::fs::create_dir_all(skills.parent().unwrap()).unwrap();
    std::fs::write(&skills, b"in the way").unwrap();
    w.store
        .kv_set("_core", "skill_preauth", &json!(["other"]))
        .unwrap();

    let got = w.install(json!({ "id": "neat", "kind": "skill" })).await;
    assert_eq!(got["ok"], false, "{got}");
    assert!(
        got["said"]
            .as_str()
            .unwrap()
            .contains("neat could not be written"),
        "{got}"
    );
    // The yes this press wrote is taken back; the one somebody else said stays.
    assert_eq!(w.kv("skill_preauth"), json!(["other"]));
    assert!(w.kv("skill_provenance").get("neat").is_none());
    assert!(skills.is_file());
}
