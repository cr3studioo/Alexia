// SPDX-License-Identifier: AGPL-3.0-only
//! The window's server in-process: `Api::serve` on `127.0.0.1:0` with a scratch store, an
//! empty plugins folder, `NoUpcalls` and a fake brain. Requests are written by hand over TCP
//! so the paths reach the server exactly as typed (`/../x.js`, `//app.css`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use alexia_api::{Api, ApiParts};
use alexia_core::agent::{Agent, AgentParts};
use alexia_core::catalog::Catalog;
use alexia_core::checker::Checker;
use alexia_core::local::{LocalJobs, Runtime};
use alexia_core::prompt::Skills;
use alexia_core::router::Router;
use alexia_core::tools::McpTooling;
use alexia_core::{Brain, BrainError, Bus, DraftSink, Limits, Reply, Turn};
use alexia_gateway::{Asker, ChannelSet};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, Timings};
use alexia_scheduler::Scheduler;
use alexia_store::{Layout, Store};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

/// Answers nothing: no route in this file reaches a brain.
struct NoBrain;

#[async_trait::async_trait]
impl Brain for NoBrain {
    async fn reply(
        &self,
        _turn: Turn,
        _draft: DraftSink,
        _cancel: CancellationToken,
    ) -> Result<Reply, BrainError> {
        Err(BrainError::Unavailable("No brain in this test.".into()))
    }
}

struct World {
    port: u16,
    ui: PathBuf,
    root: PathBuf,
    cancel: CancellationToken,
}

impl Drop for World {
    fn drop(&mut self) {
        self.cancel.cancel();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// A folder of its own per world: the tests run in parallel in one process, and some of them
/// delete files from their UI folder.
fn scratch(name: &str) -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("alexia-api-{name}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// v2's own window files: `packages/ui` in this checkout.
fn v2_ui() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/ui")
}

/// A UI folder: v2's real `index.html` and `alexia.png`, plus compiled modules and decoys.
fn ui_folder(root: &Path) -> PathBuf {
    let ui = root.join("ui");
    let src = ui.join("dist").join("src");
    std::fs::create_dir_all(&src).unwrap();
    for f in ["index.html", "alexia.png"] {
        std::fs::copy(v2_ui().join(f), ui.join(f)).unwrap();
    }
    std::fs::write(src.join("main.js"), "// MAIN-MODULE __TOKEN__").unwrap();
    std::fs::write(src.join("settings.js"), "// SETTINGS-MODULE").unwrap();
    std::fs::write(src.join("x.js"), "// X-MODULE").unwrap();
    std::fs::write(src.join("a.b.js"), "// AB-MODULE").unwrap();
    std::fs::write(ui.join("app.css"), "/* APP-CSS */").unwrap();
    ui
}

async fn world() -> World {
    world_with(true).await
}

async fn world_with(with_ui: bool) -> World {
    let root = scratch("gate");
    let ui = ui_folder(&root);
    let data = root.join("data");
    let ext = root.join("ext");
    std::fs::create_dir_all(&ext).unwrap();
    let store = Arc::new(Store::open_in_memory().unwrap());
    let bus = Bus::new(64);
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
    let asker = Asker::new(channels.clone(), store.clone(), bus.clone());
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
    let brain: Arc<dyn Brain> = Arc::new(NoBrain);
    let scheduler = Scheduler::new(store.clone(), bus.clone(), brain.clone());
    let (skills, _) = Skills::load(&[]);
    let runtime = Runtime::new(Layout::new(data.clone()), reqwest::Client::new());
    let jobs = LocalJobs::new(runtime.clone(), store.clone(), router.clone());
    let api = Api::new(ApiParts {
        layout: Layout::new(data),
        store,
        bus,
        host,
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
        ui_dir: with_ui.then(|| ui.clone()),
        app_version: "3.0.0".into(),
    })
    .unwrap();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    tokio::spawn(api.serve(listener, cancel.clone()));
    World {
        port,
        ui,
        root,
        cancel,
    }
}

struct Answer {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Answer {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", self.text()))
    }
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// One HTTP/1.1 request written by hand. `host` None sends `127.0.0.1:<port>`.
async fn send(
    port: u16,
    method: &str,
    path: &str,
    token: Option<&str>,
    host: Option<&str>,
    body: Option<&str>,
) -> Answer {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let host = host.map_or_else(|| format!("127.0.0.1:{port}"), str::to_owned);
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    if let Some(t) = token {
        req.push_str(&format!("x-alexia-token: {t}\r\n"));
    }
    let body = body.unwrap_or("");
    if method != "GET" && method != "HEAD" {
        req.push_str(&format!(
            "content-type: application/json\r\ncontent-length: {}\r\n",
            body.len()
        ));
    }
    req.push_str("\r\n");
    req.push_str(body);
    s.write_all(req.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    tokio::time::timeout(std::time::Duration::from_secs(30), s.read_to_end(&mut raw))
        .await
        .expect("the server answered within 30 s")
        .unwrap();
    parse(&raw)
}

fn parse(raw: &[u8]) -> Answer {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("a full head");
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut lines = head.split("\r\n");
    let status: u16 = lines
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
    let mut body = raw[split + 4..].to_vec();
    let chunked = headers
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("transfer-encoding") && v.contains("chunked"));
    if chunked {
        body = dechunk(&body);
    }
    Answer {
        status,
        headers,
        body,
    }
}

fn dechunk(mut b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let end = b.windows(2).position(|w| w == b"\r\n").unwrap();
        let size =
            usize::from_str_radix(std::str::from_utf8(&b[..end]).unwrap().trim(), 16).unwrap();
        if size == 0 {
            return out;
        }
        out.extend_from_slice(&b[end + 2..end + 2 + size]);
        b = &b[end + 4 + size..];
    }
}

/// The token, read from the page the way the window reads it.
async fn token(w: &World) -> String {
    let page = send(w.port, "GET", "/", None, None, None).await.text();
    let at = page
        .find("data-token=\"")
        .expect("the page carries a token")
        + "data-token=\"".len();
    let len = page[at..].find('"').unwrap();
    page[at..at + len].to_owned()
}

#[tokio::test]
async fn static_index_has_token() {
    let w = world().await;
    let page = send(w.port, "GET", "/", None, None, None).await;
    assert_eq!(page.status, 200);
    assert_eq!(
        page.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    let text = page.text();
    assert!(!text.contains("__TOKEN__"), "the placeholder was replaced");
    let t = token(&w).await;
    assert_eq!(t.len(), 43, "32 bytes, base64url");
    assert!(text.contains(&t));
    // The token the page carries is the one the API takes.
    let unknown = send(w.port, "GET", "/api/nope", Some(&t), None, None).await;
    assert_eq!(unknown.status, 404);
    // Bytes pass through untouched.
    let png = send(w.port, "GET", "/alexia.png", None, None, None).await;
    assert_eq!(png.status, 200);
    assert_eq!(png.header("content-type"), Some("image/png"));
    assert_eq!(png.body, std::fs::read(w.ui.join("alexia.png")).unwrap());
    // A module's text gets the token too.
    let main = send(w.port, "GET", "/main.js", None, None, None).await;
    assert_eq!(main.text(), format!("// MAIN-MODULE {t}"));
}

#[tokio::test]
async fn module_pattern_only() {
    let w = world().await;
    for (path, mark) in [
        ("/main.js", "MAIN-MODULE"),
        ("/settings.js", "SETTINGS-MODULE"),
    ] {
        let a = send(w.port, "GET", path, None, None, None).await;
        assert_eq!(a.status, 200, "{path}");
        assert_eq!(
            a.header("content-type"),
            Some("text/javascript; charset=utf-8")
        );
        assert!(a.text().contains(mark), "{path}");
    }
    let t = token(&w).await;
    for (path, mark) in [
        ("/../x.js", "X-MODULE"),
        ("/a.b.js", "AB-MODULE"),
        ("//app.css", "APP-CSS"),
    ] {
        // Without the token, a path that is not a file is the gate's refusal.
        let a = send(w.port, "GET", path, None, None, None).await;
        assert_ne!(a.status, 200, "{path} was served");
        assert!(!a.text().contains(mark), "{path} leaked the file");
        // With it, it is an unknown path, still not the file.
        let a = send(w.port, "GET", path, Some(&t), None, None).await;
        assert_ne!(a.status, 200, "{path} was served");
        assert!(!a.text().contains(mark), "{path} leaked the file");
    }
    // A module that does not exist falls through to the API rules.
    let a = send(w.port, "GET", "/nothing.js", None, None, None).await;
    assert_eq!(a.status, 403);
}

#[tokio::test]
async fn no_token_403() {
    let w = world().await;
    for (method, body) in [("GET", None), ("POST", Some("{}"))] {
        let a = send(w.port, method, "/api/state", None, None, body).await;
        assert_eq!(a.status, 403);
        assert_eq!(a.header("content-type"), Some("text/plain"));
        assert_eq!(a.text(), "not for you");
        let a = send(w.port, method, "/api/state", Some("wrong"), None, body).await;
        assert_eq!((a.status, a.text().as_str()), (403, "not for you"));
    }
}

#[tokio::test]
async fn wrong_host_403() {
    let w = world().await;
    let t = token(&w).await;
    for host in ["localhost", "evil.example", "[::1]"] {
        let host = format!("{host}:{}", w.port);
        let a = send(w.port, "GET", "/api/state", Some(&t), Some(&host), None).await;
        assert_eq!(a.status, 403, "{host}");
        assert_eq!(a.text(), "not for you");
    }
}

#[tokio::test]
async fn bad_json_400() {
    let w = world().await;
    let t = token(&w).await;
    let a = send(w.port, "POST", "/api/setup", Some(&t), None, Some("{nope")).await;
    assert_eq!(a.status, 400);
    assert_eq!(a.header("content-type"), Some("application/json"));
    assert_eq!(
        a.json(),
        json!({ "ok": false, "said": "That request body is not JSON." })
    );
    // An empty body is `{}`, and a non-object is `{}`: both reach the route. Whatever the
    // route then answers is its own business; the gate only must not refuse them.
    for body in ["", "[1,2]", "\"text\""] {
        let a = send(w.port, "POST", "/api/setup", Some(&t), None, Some(body)).await;
        assert!(
            a.status != 400 && a.status != 403,
            "body {body:?} was refused: {}",
            a.status
        );
    }
}

#[tokio::test]
async fn guard_confirm() {
    let w = world().await;
    let t = token(&w).await;
    let a = send(
        w.port,
        "POST",
        "/api/compute/unpair",
        Some(&t),
        None,
        Some("{}"),
    )
    .await;
    assert_eq!(a.status, 409);
    assert_eq!(
        a.json(),
        json!({
            "ok": false,
            "said": "This forgets the paired computer. Its running jobs are cancelled, its connection is closed at once, and its models are no longer offered here. Pairing again needs a fresh code. Nothing has happened yet.",
            "confirm": true,
        })
    );
    // With the confirm it reaches the route.
    let a = send(
        w.port,
        "POST",
        "/api/compute/unpair",
        Some(&t),
        None,
        Some(r#"{"confirm":true}"#),
    )
    .await;
    assert_eq!(a.status, 501);
    // A read refuses a write, without `confirm`.
    let a = send(w.port, "POST", "/api/state", Some(&t), None, Some("{}")).await;
    assert_eq!(a.status, 405);
    assert!(a.json().get("confirm").is_none());
}

#[tokio::test]
async fn unknown_404_empty() {
    let w = world().await;
    let t = token(&w).await;
    for (method, path) in [
        ("GET", "/api/nope"),
        ("GET", "/nope"),
        ("GET", "/api/chat"),
        ("GET", "/api/local-models/some-id"),
    ] {
        let a = send(w.port, method, path, Some(&t), None, None).await;
        assert_eq!(a.status, 404, "{method} {path}");
        assert!(a.body.is_empty(), "{method} {path}: {}", a.text());
    }
    // A write to a path in no guard row is the guard's own 404.
    let a = send(w.port, "POST", "/api/nope", Some(&t), None, Some("{}")).await;
    assert_eq!(a.status, 404);
    assert_eq!(
        a.json(),
        json!({ "ok": false, "said": "There is nothing at /api/nope." })
    );
}

/// INVENTORY A–E, P, B, L, M, R: the 75 API rows.
const INVENTORY: &[(&str, &str)] = &[
    // A1–A7
    ("GET", "/api/state"),
    ("POST", "/api/setup"),
    ("POST", "/api/permissions"),
    ("POST", "/api/ceilings"),
    ("POST", "/api/adult"),
    ("GET", "/api/panels"),
    ("GET", "/api/search?q=x"),
    // C1–C7
    ("POST", "/api/chat"),
    ("POST", "/api/stop"),
    ("POST", "/api/approve"),
    ("POST", "/api/command"),
    ("POST", "/api/not-her"),
    ("GET", "/api/file?id=1"),
    ("POST", "/api/file"),
    // P1–P7
    ("GET", "/api/plugins"),
    ("POST", "/api/plugin"),
    ("POST", "/api/install"),
    ("POST", "/api/server"),
    ("POST", "/api/settings"),
    ("POST", "/api/upload"),
    ("GET", "/api/plugin-file?plugin=a&path=b"),
    // B1–B4
    ("POST", "/api/rows"),
    ("POST", "/api/detail"),
    ("POST", "/api/action"),
    ("POST", "/api/learn"),
    // L1–L3
    ("GET", "/api/library"),
    ("GET", "/api/library/progress?id=a"),
    ("POST", "/api/library/install"),
    // M1–M17
    ("GET", "/api/local-models"),
    ("GET", "/api/local-models/search?q=a&format=gguf"),
    ("GET", "/api/local-models/repo?repo=a&format=gguf"),
    ("GET", "/api/local-models/context"),
    ("POST", "/api/local-models/context"),
    ("GET", "/api/local-models/maintenance"),
    ("GET", "/api/local-models/import-preview?path=a"),
    ("GET", "/api/local-models/progress"),
    ("POST", "/api/local-models/install"),
    ("POST", "/api/local-models/cancel"),
    ("POST", "/api/local-models/import"),
    ("POST", "/api/local-models/benchmark"),
    ("POST", "/api/local-models/use"),
    ("POST", "/api/local-models/remove"),
    ("DELETE", "/api/local-models/some-model"),
    ("POST", "/api/local-models/token"),
    ("GET", "/api/local-stats"),
    // R1–R23
    ("GET", "/api/compute/role"),
    ("POST", "/api/compute/role"),
    ("POST", "/api/compute/role/cancel"),
    ("GET", "/api/compute/hosts"),
    ("GET", "/api/compute/tailscale"),
    ("POST", "/api/compute/tailscale"),
    ("GET", "/api/compute/discover"),
    ("POST", "/api/compute/pair/start"),
    ("GET", "/api/compute/pair"),
    ("POST", "/api/compute/pair/cancel"),
    ("POST", "/api/compute/unpair"),
    ("GET", "/api/compute/inventory"),
    ("GET", "/api/compute/status"),
    ("POST", "/api/compute/select"),
    ("POST", "/api/compute/setup/install"),
    ("GET", "/api/compute/queue"),
    ("GET", "/api/compute/job?id=a"),
    ("GET", "/api/compute/jobs"),
    ("POST", "/api/compute/jobs/cancel"),
    ("POST", "/api/compute/pause"),
    ("GET", "/api/compute/services"),
    ("POST", "/api/compute/services"),
    ("POST", "/api/compute/window/close"),
    // E1–E7
    ("POST", "/api/editor"),
    ("GET", "/api/editor/file?token=a"),
    ("GET", "/api/editor/picture?id=a"),
    ("POST", "/api/editor/forget"),
    ("POST", "/api/editor/upload"),
    ("POST", "/api/research"),
    ("GET", "/api/research-file?plugin=a&run=b&source=c&kind=d"),
];

#[tokio::test]
async fn every_inventory_route_registered() {
    assert_eq!(INVENTORY.len(), 75);
    let w = world().await;
    let t = token(&w).await;
    // `confirm` passes the guard's confirm rows; `open` is an act no route treats as a read.
    let body = r#"{"confirm":true,"action":"open"}"#;
    // Registered, whatever the area answers: not the empty 404 and not the gate's refusal.
    // Each area's own answers are its task's tests (and P2D-14 checks full coverage).
    for (method, path) in INVENTORY {
        let a = send(w.port, method, path, Some(&t), None, Some(body)).await;
        assert!(
            !(a.status == 404 && a.body.is_empty()),
            "{method} {path} is not registered"
        );
        assert_ne!(a.status, 403, "{method} {path}: {}", a.text());
    }
}

#[tokio::test]
async fn no_ui_dir_503() {
    let w = world_with(false).await;
    let a = send(w.port, "GET", "/", None, None, None).await;
    assert_eq!(a.status, 503);
    assert_eq!(a.header("content-type"), Some("text/plain"));
    assert_eq!(
        a.text(),
        "The window's files were not found. Set ALEXIA_UI_DIR."
    );
    // Every other path goes to the gate.
    let a = send(w.port, "GET", "/app.css", None, None, None).await;
    assert_eq!(a.status, 403);
}

#[tokio::test]
async fn missing_index_falls_through() {
    let w = world().await;
    std::fs::remove_file(w.ui.join("index.html")).unwrap();
    // As v2: a missing file is not an asset, so `/` meets the gate.
    let a = send(w.port, "GET", "/", None, None, None).await;
    assert_eq!(a.status, 403);
}
