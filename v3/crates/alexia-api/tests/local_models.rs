// SPDX-License-Identifier: AGPL-3.0-only
//! P2D-09: the Local models screen and the Local stats page (INVENTORY M1–M17), in-process.
//! `Api::serve` on `127.0.0.1:0` with an in-memory store and secrets in memory; requests are
//! written by hand over TCP, as the window sends them. Hugging Face is a loopback server
//! (`ALEXIA_HF_BASE`) and `llama-server` a fake that never becomes healthy
//! (`ALEXIA_LLAMA_SERVER`): nothing leaves the computer.

use std::io::{Read, Write};
use std::net::TcpListener as StdListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Once, OnceLock};
use std::time::{Duration, Instant};

use alexia_api::{Api, ApiParts};
use alexia_core::agent::{Agent, AgentParts};
use alexia_core::catalog::Catalog;
use alexia_core::checker::Checker;
use alexia_core::gpu::{self, Machine};
use alexia_core::hf;
use alexia_core::local::{LocalJobs, Runtime};
use alexia_core::prompt::Skills;
use alexia_core::router::Router;
use alexia_core::tools::McpTooling;
use alexia_core::{Brain, Bus, Limits};
use alexia_gateway::{Asker, ChannelSet};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, Timings};
use alexia_scheduler::Scheduler;
use alexia_store::{secrets, Layout, Store};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

/// Generous: a loaded Windows machine is slow, and installs spawn work in the background.
const WAIT: Duration = Duration::from_secs(90);
const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;

// ---- GGUF headers ----

fn s(out: &mut Vec<u8>, v: &str) {
    out.extend((v.len() as u64).to_le_bytes());
    out.extend(v.as_bytes());
}

/// A GGUF of architecture `arch` (32 layers, 2048 context, 8 KV heads of 128) and `pad` bytes.
fn gguf(arch: &str, pad: usize) -> Vec<u8> {
    let u32s = [
        ("block_count", 32u32),
        ("context_length", 2048),
        ("embedding_length", 4096),
        ("attention.head_count", 32),
        ("attention.head_count_kv", 8),
    ];
    let mut o = b"GGUF".to_vec();
    o.extend(3u32.to_le_bytes());
    o.extend(0u64.to_le_bytes());
    o.extend((u32s.len() as u64 + 1).to_le_bytes());
    s(&mut o, "general.architecture");
    o.extend(8u32.to_le_bytes());
    s(&mut o, arch);
    for (k, v) in u32s {
        s(&mut o, &format!("{arch}.{k}"));
        o.extend(4u32.to_le_bytes());
        o.extend(v.to_le_bytes());
    }
    o.extend((0..pad).map(|i| (i % 251) as u8));
    o
}

fn hex(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

/// An embedding model: once installed it is pinned to embeddings and never measured, so an
/// install finishes without a model server answering.
fn embedding() -> &'static [u8] {
    static B: OnceLock<Vec<u8>> = OnceLock::new();
    B.get_or_init(|| gguf("nomic-bert", 300_000))
}

/// A bigger text model whose whole-file download stalls half way, for the cancel.
fn stalling() -> &'static [u8] {
    static B: OnceLock<Vec<u8>> = OnceLock::new();
    B.get_or_init(|| gguf("llama", 2_000_000))
}

// ---- a stand-in for Hugging Face, on its own threads (it outlives each test's runtime) ----

fn reply(sock: &mut std::net::TcpStream, status: &str, kind: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = sock.write_all(head.as_bytes());
    let _ = sock.write_all(body);
    let _ = sock.flush();
}

fn answer(mut sock: std::net::TcpStream) {
    let mut head = Vec::new();
    let mut b = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match sock.read(&mut b) {
            Ok(0) | Err(_) => return,
            Ok(n) => head.extend(&b[..n]),
        }
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    let path = head.split_whitespace().nth(1).unwrap_or("").to_owned();
    let path = path.split('?').next().unwrap_or("").to_owned();
    let json = |sock: &mut std::net::TcpStream, v: Value| {
        reply(sock, "200 OK", "application/json", v.to_string().as_bytes());
    };
    for (repo, file, body, stall) in [
        ("o/emb", "emb-Q4_K_M.gguf", embedding(), false),
        ("o/slow", "slow-Q4_K_M.gguf", stalling(), true),
    ] {
        if path == format!("/api/models/{repo}")
            || path == format!("/api/models/{repo}/revision/{COMMIT}")
        {
            return json(
                &mut sock,
                json!({ "id": repo, "sha": COMMIT, "cardData": { "license": "apache-2.0" } }),
            );
        }
        if path == format!("/api/models/{repo}/tree/{COMMIT}") {
            return json(
                &mut sock,
                json!([
                    { "type": "file", "path": "README.md", "size": 10 },
                    { "type": "file", "path": file, "size": body.len(),
                      "lfs": { "size": body.len(), "oid": hex(body) } },
                ]),
            );
        }
        if path == format!("/{repo}/resolve/{COMMIT}/{file}") {
            if !stall {
                return reply(&mut sock, "200 OK", "application/octet-stream", body);
            }
            // Half the bytes, then nothing more: the install sits in its download.
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = sock.write_all(head.as_bytes());
            let _ = sock.write_all(&body[..body.len() / 2]);
            let _ = sock.flush();
            std::thread::sleep(Duration::from_secs(120));
            return;
        }
    }
    reply(&mut sock, "404 Not Found", "text/plain", b"");
}

fn fake_hub() -> String {
    let listener = StdListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for sock in listener.incoming().flatten() {
            std::thread::spawn(move || answer(sock));
        }
    });
    base
}

// ---- a llama-server that starts and never answers /health ----

const FAKE_SERVER: &str = r#"
fn main() {
    std::thread::sleep(std::time::Duration::from_secs(120));
}
"#;

fn fake_server() -> PathBuf {
    // In cargo's own temp folder; one exe per process, ones over a day old are removed.
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("local-models-fake");
    std::fs::create_dir_all(&dir).unwrap();
    let day = Duration::from_secs(24 * 3600);
    for old in std::fs::read_dir(&dir).unwrap().flatten() {
        let stale = old
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|t| t.elapsed().is_ok_and(|age| age > day));
        if stale {
            let _ = std::fs::remove_file(old.path());
        }
    }
    let pid = std::process::id();
    let src = dir.join(format!("fake-{pid}.rs"));
    std::fs::write(&src, FAKE_SERVER).unwrap();
    let exe = dir.join(format!("fake-{pid}{}", std::env::consts::EXE_SUFFIX));
    let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".into());
    let out = std::process::Command::new(rustc)
        .args(["--edition", "2021", "-o"])
        .arg(&exe)
        .arg(&src)
        .output()
        .expect("rustc runs");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    exe
}

/// Secrets in memory, the fake Hugging Face and the fake llama-server, once per test binary.
fn once() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
        std::env::set_var("ALEXIA_HF_BASE", fake_hub());
        std::env::set_var("ALEXIA_LLAMA_SERVER", fake_server());
        for proxy in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
        ] {
            std::env::remove_var(proxy);
        }
    });
}

// ---- the world ----

struct World {
    api: Arc<Api>,
    store: Arc<Store>,
    port: u16,
    root: PathBuf,
    cancel: CancellationToken,
}

impl World {
    fn data(&self) -> PathBuf {
        self.root.join("data")
    }
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
    let dir = std::env::temp_dir().join(format!(
        "alexia-local-models-{name}-{}-{n}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The 8 GB card these tests judge against (an RTX 4060 laptop, as on the owner's computer).
fn eight_gb() -> Machine {
    Machine {
        vram_mb: 8192,
        free_mb: 8192,
        ram_mb: 16384,
        gpu: Some("NVIDIA GeForce RTX 4060".into()),
    }
}

async fn world(name: &str) -> World {
    once();
    let root = scratch(name);
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
    let brain: Arc<dyn Brain> = agent.clone();
    let scheduler = Scheduler::new(store.clone(), bus.clone(), brain.clone());
    let (skills, _) = Skills::load(&[]);
    let runtime = Runtime::new(Layout::new(data.clone()), reqwest::Client::new());
    let jobs = LocalJobs::new(runtime.clone(), store.clone(), router.clone());
    jobs.set_machine(eight_gb());
    let api = Api::new(ApiParts {
        layout: Layout::new(data),
        store: store.clone(),
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
        store,
        port,
        root,
        cancel,
    }
}

// ---- HTTP by hand ----

struct Answer {
    status: u16,
    body: String,
}

impl Answer {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", self.body))
    }
}

async fn send(w: &World, method: &str, path: &str, body: Option<Value>) -> Answer {
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nx-alexia-token: {}\r\n",
        w.port,
        w.api.token()
    );
    let body = body.map(|b| b.to_string()).unwrap_or_default();
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
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, rest) = text.split_once("\r\n\r\n").expect("a full head");
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let body = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        let mut out = String::new();
        let mut left = rest;
        while let Some((size, after)) = left.split_once("\r\n") {
            let n = usize::from_str_radix(size.trim(), 16).unwrap();
            if n == 0 {
                break;
            }
            out.push_str(&after[..n]);
            left = &after[n + 2..];
        }
        out
    } else {
        rest.to_owned()
    };
    Answer { status, body }
}

async fn get(w: &World, path: &str) -> Value {
    let a = send(w, "GET", path, None).await;
    assert_eq!(a.status, 200, "{path}: {}", a.body);
    a.json()
}

async fn post(w: &World, path: &str, body: Value) -> Answer {
    send(w, "POST", path, Some(body)).await
}

fn keys(v: &Value) -> Vec<&str> {
    let mut k: Vec<&str> = v
        .as_object()
        .unwrap_or_else(|| panic!("not an object: {v}"))
        .keys()
        .map(String::as_str)
        .collect();
    k.sort_unstable();
    k
}

/// `id` for a URL path: everything but letters and digits percent-encoded.
fn encoded(id: &str) -> String {
    id.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// Polls the job until `done` says so; returns every view seen, the last one last.
async fn watch(w: &World, job: &str, mut done: impl FnMut(&Value) -> bool) -> Vec<Value> {
    let start = Instant::now();
    let mut seen = Vec::new();
    loop {
        let v = get(w, &format!("/api/local-models/progress?job={job}")).await;
        let stop = done(&v);
        seen.push(v);
        if stop {
            return seen;
        }
        assert!(
            start.elapsed() < WAIT,
            "the job did not get there in time: {:?}",
            seen.last()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// A GGUF on disk, imported and recorded as the import route would: the model a test removes
/// or uses.
fn installed_embedding(w: &World) -> hf::Installed {
    let src = w.root.join("emb-Q4_K_M.gguf");
    std::fs::write(&src, embedding()).unwrap();
    let i = hf::import_file(&src, &Layout::new(w.data()), true).unwrap();
    hf::record(&w.store, &i).unwrap();
    i
}

// ---- the tests ----

const CARD_KEYS: [&str; 16] = [
    "abliterated",
    "blurb",
    "bytes",
    "entry",
    "format",
    "installed",
    "licence",
    "name",
    "needBytes",
    "params",
    "publisher",
    "quant",
    "quants",
    "tools",
    "verdict",
    "vision",
];

fn assert_card(c: &Value, budget: u64) {
    let mut want: Vec<&str> = CARD_KEYS.to_vec();
    want.sort_unstable();
    assert_eq!(keys(c), want, "{c}");
    assert_eq!(c["format"], "gguf");
    assert!(
        ["fits", "tight", "too-big"].contains(&c["verdict"].as_str().unwrap()),
        "{c}"
    );
    let need = c["needBytes"].as_u64().unwrap();
    assert!(need >= c["bytes"].as_u64().unwrap(), "{c}");
    if c["verdict"] == "too-big" {
        assert!(need > budget, "{c}");
    }
    assert_eq!(keys(&c["licence"]), ["name", "restrictive", "url"]);
    let quants = c["quants"].as_array().unwrap();
    assert!(!quants.is_empty(), "{c}");
    for q in quants {
        // `note` only when there is something to say about the quant.
        let k: Vec<&str> = keys(q).into_iter().filter(|k| *k != "note").collect();
        assert_eq!(k, ["bytes", "needBytes", "quant", "verdict"], "{q}");
    }
}

/// M1 on an 8 GB card: the machine line, what fits it, and the GPU's budget, not the RAM's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn overview_shape_on_8gb_fixture() {
    let w = world("overview").await;
    let o = get(&w, "/api/local-models").await;
    assert_eq!(
        keys(&o),
        [
            "all",
            "installed",
            "jobs",
            "machine",
            "mode",
            "picks",
            "runtime",
            "runtimes",
            "uncensored"
        ]
    );
    let m = &o["machine"];
    assert_eq!(
        keys(m),
        [
            "appleSilicon",
            "budgetBytes",
            "chip",
            "freeDiskBytes",
            "ramBytes",
            "summary"
        ]
    );
    let headroom = u64::from(gpu::headroom_mb(&w.store));
    let budget = (8192 - headroom) * MIB;
    assert_eq!(m["budgetBytes"].as_u64().unwrap(), budget);
    assert_eq!(m["ramBytes"].as_u64().unwrap(), 16 * GIB);
    assert_eq!(m["appleSilicon"], false);
    let summary = m["summary"].as_str().unwrap();
    assert!(
        summary.contains("NVIDIA GeForce RTX 4060 8 GiB") && summary.contains("16 GiB RAM"),
        "{summary}"
    );

    // Windows: llama.cpp is the runner; MLX is never here.
    assert_eq!(o["runtime"], o["runtimes"]["llama"]);
    assert_eq!(keys(&o["runtime"]), ["installed", "supported", "version"]);
    assert_eq!(
        o["runtimes"]["mlx"],
        json!({ "installed": false, "version": "", "supported": false })
    );

    // What fits: the best and the fastest pick both fit 8 GB; the list has the rest.
    let all = o["all"].as_array().unwrap();
    assert!(!all.is_empty());
    for c in all.iter().chain(o["uncensored"].as_array().unwrap()) {
        assert_card(c, budget);
    }
    assert!(all.iter().all(|c| c["abliterated"] == false));
    assert!(o["uncensored"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["abliterated"] == true));
    for pick in ["best", "fast"] {
        let c = &o["picks"][pick];
        assert_card(c, budget);
        assert_eq!(c["verdict"], "fits", "{pick}: {c}");
        assert!(c["needBytes"].as_u64().unwrap() <= budget, "{pick}: {c}");
        assert_eq!(c["abliterated"], false);
    }
    assert!(
        o["picks"]["fast"]["needBytes"].as_u64() <= o["picks"]["best"]["needBytes"].as_u64(),
        "{}",
        o["picks"]
    );
    // Something on the vetted list is too big for this card (a 70B), and is said so.
    assert!(
        all.iter()
            .flat_map(|c| c["quants"].as_array().unwrap())
            .any(|q| q["verdict"] == "too-big"),
        "nothing judged too big for 8 GB"
    );
    assert_eq!(o["installed"], json!([]));
    assert_eq!(o["jobs"], json!([]));
    assert_eq!(o["mode"], "combined");
}

/// M9 + M8: an install from the (fake) Hub runs its steps, reports bytes, and ends `done` with
/// the model recorded and pinned to embeddings.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn install_progress_then_done() {
    let w = world("install").await;
    let a = post(
        &w,
        "/api/local-models/install",
        json!({ "repo": "o/emb", "quant": "Q4_K_M", "confirm": true }),
    )
    .await;
    assert_eq!(a.status, 202, "{}", a.body);
    let job = a.json();
    assert_eq!(job["name"], "emb (Q4_K_M)");
    assert_eq!(job["step"], "queued");
    let id = job["id"].as_str().unwrap().to_owned();

    let seen = watch(&w, &id, |v| {
        ["done", "failed", "cancelled"].contains(&v["step"].as_str().unwrap())
    })
    .await;
    let last = seen.last().unwrap();
    assert_eq!(last["step"], "done", "{seen:?}");
    let total = embedding().len() as u64;
    assert_eq!(last["total"], 0, "the finish resets the counter: {last}");
    // The download was reported in bytes of the file, never past its size.
    let counted: Vec<u64> = seen
        .iter()
        .filter(|v| v["step"] == "download" || v["step"] == "verify")
        .filter(|v| v["total"].as_u64() == Some(total))
        .map(|v| v["done"].as_u64().unwrap())
        .collect();
    assert!(counted.windows(2).all(|p| p[0] <= p[1]), "{counted:?}");
    assert!(counted.iter().all(|d| *d <= total), "{counted:?}");
    let message = last["message"].as_str().unwrap();
    assert!(
        message.contains("is ready") && message.contains("Chat stays on free cloud models"),
        "{message}"
    );
    let model = last["modelId"].as_str().unwrap().to_owned();

    // On disk, recorded, and shown as installed and pinned.
    let i = hf::installed(&w.store)
        .into_iter()
        .find(|i| i.id == model)
        .expect("recorded");
    assert_eq!(std::fs::read(&i.path).unwrap(), embedding());
    let o = get(&w, "/api/local-models").await;
    let rows = o["installed"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["id"], model.as_str());
    assert_eq!(rows[0]["pinned"], true);
    assert_eq!(rows[0]["quant"], "Q4_K_M");
    assert_eq!(rows[0]["owned"], true);
    assert_eq!(rows[0]["licence"], "apache-2.0");
    assert_eq!(o["jobs"].as_array().unwrap().len(), 1);
}

/// M10: a cancel mid-download stops the job, keeps what came down as `.part` for the next try,
/// records nothing, and frees the screen for the next job.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_mid_install() {
    let w = world("cancel").await;
    let a = post(
        &w,
        "/api/local-models/install",
        json!({ "repo": "o/slow", "quant": "Q4_K_M", "confirm": true }),
    )
    .await;
    assert_eq!(a.status, 202, "{}", a.body);
    let id = a.json()["id"].as_str().unwrap().to_owned();
    watch(&w, &id, |v| {
        v["step"] == "download" && v["done"].as_u64().unwrap_or(0) > 0
    })
    .await;

    // A second install waits for this one.
    let again = post(
        &w,
        "/api/local-models/install",
        json!({ "repo": "o/emb", "quant": "Q4_K_M", "confirm": true }),
    )
    .await;
    assert_eq!(again.status, 409, "{}", again.body);
    assert!(again.json()["said"]
        .as_str()
        .unwrap()
        .contains("is still being installed"));

    let c = post(
        &w,
        "/api/local-models/cancel",
        json!({ "job": id, "confirm": true }),
    )
    .await;
    assert_eq!(c.status, 200, "{}", c.body);
    assert_eq!(c.json(), json!({ "ok": true }));
    let seen = watch(&w, &id, |v| v["step"] != "download").await;
    let last = seen.last().unwrap();
    assert_eq!(last["step"], "cancelled", "{seen:?}");
    assert!(last["message"]
        .as_str()
        .unwrap()
        .contains("installing again carries on"));

    // What came down is kept, partial; nothing was recorded.
    let models = w.data();
    let part: Vec<u64> = walk(&models)
        .into_iter()
        .filter(|p| p.to_string_lossy().ends_with(".part"))
        .map(|p| std::fs::metadata(p).unwrap().len())
        .collect();
    let full = stalling().len() as u64;
    assert!(
        part.iter().any(|n| *n > 0 && *n < full),
        "no partial download kept: {part:?}"
    );
    assert!(hf::installed(&w.store).is_empty());

    // Cancelling it again finds nothing running; the screen takes the next job.
    let c = post(
        &w,
        "/api/local-models/cancel",
        json!({ "job": id, "confirm": true }),
    )
    .await;
    assert_eq!(c.json(), json!({ "ok": false }));
    let next = post(
        &w,
        "/api/local-models/install",
        json!({ "repo": "o/emb", "quant": "Q4_K_M", "confirm": true }),
    )
    .await;
    assert_eq!(next.status, 202, "{}", next.body);
    let next = next.json()["id"].as_str().unwrap().to_owned();
    let seen = watch(&w, &next, |v| {
        ["done", "failed", "cancelled"].contains(&v["step"].as_str().unwrap())
    })
    .await;
    assert_eq!(seen.last().unwrap()["step"], "done", "{seen:?}");
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out
}

/// serve.ts 2146: while a use is starting its model, every non-GET but cancel, token and use
/// answers v2's refusal; GETs answer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn transition_blocks_non_get() {
    let w = world("transition").await;
    let model = installed_embedding(&w);

    // D213 first: chat never goes local, and asking for it pins nothing.
    let local = post(
        &w,
        "/api/local-models/use",
        json!({ "id": model.id, "mode": "local" }),
    )
    .await;
    assert_eq!(local.status, 409, "{}", local.body);
    assert_eq!(
        local.json()["said"],
        "Chat uses free cloud models on this computer; local models do speech, vision, embeddings and images."
    );
    assert!(w.api.parts.jobs.pinned_ids().is_empty());

    // A use starts the model (the fake never becomes healthy, so it stays starting).
    let used = post(&w, "/api/local-models/use", json!({ "id": model.id })).await;
    assert_eq!(used.status, 200, "{}", used.body);
    let used = used.json();
    assert_eq!(used["ok"], true);
    assert!(
        used["said"]
            .as_str()
            .unwrap()
            .contains("Chat uses free cloud models"),
        "{used}"
    );
    assert!(used["data"]["transitionId"].is_string());
    assert!(w.api.parts.jobs.pinned_ids().contains(&model.id));

    let refused = "Wait for the mode switch to finish before starting another model operation.";
    for (method, path, body) in [
        (
            "POST",
            "/api/local-models/install",
            json!({ "repo": "o/emb", "quant": "Q4_K_M", "confirm": true }),
        ),
        (
            "POST",
            "/api/local-models/import",
            json!({ "path": "C:\\nowhere.gguf", "confirm": true }),
        ),
        (
            "POST",
            "/api/local-models/benchmark",
            json!({ "id": model.id, "confirm": true }),
        ),
        (
            "POST",
            "/api/local-models/context",
            json!({ "id": model.id, "context": 4096 }),
        ),
        (
            "POST",
            "/api/local-models/remove",
            json!({ "id": model.id, "confirm": true }),
        ),
        (
            "DELETE",
            &format!("/api/local-models/{}", encoded(&model.id)),
            json!({ "confirm": true }),
        ),
    ] {
        let a = send(&w, method, path, Some(body)).await;
        assert_eq!(a.status, 409, "{method} {path}: {}", a.body);
        assert_eq!(a.json()["said"], refused, "{method} {path}");
    }
    // Still installed: nothing above went through.
    assert_eq!(hf::installed(&w.store).len(), 1);

    // GETs answer, and cancel, token and use are let through.
    get(&w, "/api/local-models").await;
    get(&w, "/api/local-models/maintenance").await;
    get(&w, "/api/local-stats").await;
    let c = post(
        &w,
        "/api/local-models/cancel",
        json!({ "job": "none", "confirm": true }),
    )
    .await;
    assert_eq!(c.status, 200, "{}", c.body);
    let t = post(&w, "/api/local-models/token", json!({ "token": "" })).await;
    assert_eq!(t.status, 200, "{}", t.body);
    let again = post(&w, "/api/local-models/use", json!({ "id": model.id })).await;
    assert_eq!(again.status, 200, "{}", again.body);
}

/// M16: the token goes to the keychain and is never in an answer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn token_not_echoed() {
    let w = world("token").await;
    let secret = format!("{}{}", "hf_", "TestTokenNotARealOne0123456789");
    let a = post(&w, "/api/local-models/token", json!({ "token": secret })).await;
    assert_eq!(a.status, 200, "{}", a.body);
    assert_eq!(
        a.json(),
        json!({ "ok": true, "said": "Hugging Face token saved in your keychain." })
    );
    assert!(!a.body.contains(&secret));
    assert!(!a.body.contains("TestToken"));
    assert_eq!(
        secrets::get("_core", "hf_token").unwrap().as_deref(),
        Some(secret.as_str())
    );
    for path in [
        "/api/local-models",
        "/api/local-models/maintenance",
        "/api/local-stats",
        "/api/state",
    ] {
        let a = send(&w, "GET", path, None).await;
        assert!(!a.body.contains("TestToken"), "{path} echoed the token");
    }

    // Too long is refused and keeps the old one; empty removes it.
    let long = post(
        &w,
        "/api/local-models/token",
        json!({ "token": "x".repeat(301) }),
    )
    .await;
    assert_eq!(long.status, 400, "{}", long.body);
    assert_eq!(
        secrets::get("_core", "hf_token").unwrap().as_deref(),
        Some(secret.as_str())
    );
    let gone = post(&w, "/api/local-models/token", json!({ "token": "  " })).await;
    assert_eq!(gone.status, 200, "{}", gone.body);
    assert_eq!(gone.json()["said"], "Hugging Face token removed.");
    assert_eq!(secrets::get("_core", "hf_token").unwrap(), None);
}

/// M15: `DELETE /api/local-models/<id>` with the `/` in `local/…` percent-encoded.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_by_path_id() {
    let w = world("delete").await;
    let model = installed_embedding(&w);
    assert!(model.id.contains('/'), "{}", model.id);
    assert!(model.path.is_file());
    let path = format!("/api/local-models/{}", encoded(&model.id));

    let a = send(&w, "DELETE", &path, Some(json!({ "confirm": true }))).await;
    assert_eq!(a.status, 200, "{}", a.body);
    let said = a.json()["said"].as_str().unwrap().to_owned();
    assert!(said.contains("is removed"), "{said}");
    assert!(hf::installed(&w.store).is_empty());
    assert!(!model.path.exists(), "the owned copy is deleted");

    let again = send(&w, "DELETE", &path, Some(json!({ "confirm": true }))).await;
    assert_eq!(again.status, 404, "{}", again.body);
    assert_eq!(
        again.json(),
        json!({ "ok": false, "said": "That model is not installed." })
    );
}

/// M17: the Local stats page — runners as Windows has them, the machine now, and a history
/// that grows a reading per poll.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_stats_shape() {
    let w = world("stats").await;
    installed_embedding(&w);
    let s = get(&w, "/api/local-stats").await;
    assert_eq!(
        keys(&s),
        [
            "installed",
            "loaded",
            "runners",
            "running",
            "speed",
            "system"
        ]
    );
    assert_eq!(s["running"], false);
    assert_eq!(s["loaded"], json!([]));
    assert_eq!(
        s["runners"],
        json!({ "ollama": false, "llama": false, "mlx": false })
    );
    assert_eq!(s["speed"], Value::Null);
    let installed = s["installed"].as_array().unwrap();
    assert_eq!(installed.len(), 1);
    assert_eq!(keys(&installed[0]), ["name", "size"]);
    assert_eq!(installed[0]["size"], embedding().len() as u64);

    let sys = &s["system"];
    assert_eq!(
        keys(sys),
        [
            "cpu",
            "gpu",
            "history",
            "load",
            "memory",
            "temperature",
            "uptime"
        ]
    );
    assert_eq!(keys(&sys["cpu"]), ["cores", "model", "percent"]);
    assert!(sys["cpu"]["cores"].as_u64().unwrap() >= 1);
    let pct = sys["cpu"]["percent"].as_f64().unwrap();
    assert!((0.0..=100.0).contains(&pct), "{pct}");
    assert_eq!(keys(&sys["memory"]), ["pressure", "total", "used"]);
    assert!(sys["memory"]["used"].as_u64() <= sys["memory"]["total"].as_u64());
    assert_eq!(sys["memory"]["pressure"], Value::Null);
    assert!(sys["gpu"]["percent"].is_number());
    assert_eq!(
        (sys["load"].clone(), sys["temperature"].clone()),
        (Value::Null, Value::Null)
    );
    assert!(sys["uptime"].is_u64());
    for k in ["cpu", "gpu", "memory"] {
        assert_eq!(sys["history"][k].as_array().unwrap().len(), 1, "{k}");
    }
    let s2 = get(&w, "/api/local-stats").await;
    for k in ["cpu", "gpu", "memory"] {
        assert_eq!(
            s2["system"]["history"][k].as_array().unwrap().len(),
            2,
            "{k}"
        );
    }
}
