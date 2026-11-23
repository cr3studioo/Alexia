// SPDX-License-Identifier: AGPL-3.0-only
//! P2D-10: the compute screen on a hub with no paired computers (INVENTORY R1–R23),
//! in-process. `Api::serve` on `127.0.0.1:0` with a scratch store and secrets in memory;
//! requests are written by hand over TCP, as the window sends them (token, Host, JSON body).
//!
//! The local job is a real llama.cpp engine install through `Runtime`, whose HTTP client goes
//! through a proxy on loopback that accepts and never answers: the download waits forever, so
//! the job stays running until it is cancelled, and nothing reaches the network.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Once};
use std::time::{Duration, Instant};

use alexia_api::{Api, ApiParts};
use alexia_core::agent::{Agent, AgentParts};
use alexia_core::catalog::Catalog;
use alexia_core::checker::Checker;
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
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

/// Generous: a loaded Windows machine is slow.
const WAIT: Duration = Duration::from_secs(60);
const MESH: &str = "Pairing another computer comes with the mesh in a later version.";
const CHOOSE: &str = "Choose a paired computer.";
const UNPAIRED: &str = "That computer is not paired.";
const ON_COMPUTE: &str = "That is done on the computer that does the computing.";
/// The engine can be installed by the hub only here (`Runtime::ensure`).
const INSTALLS: bool = cfg!(all(windows, target_arch = "x86_64"));

/// Secrets in memory, and no hand-placed engine, once per test binary.
fn once() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
        std::env::remove_var("ALEXIA_LLAMA_SERVER");
    });
}

struct World {
    api: Arc<Api>,
    store: Arc<Store>,
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
        std::env::temp_dir().join(format!("alexia-compute-{name}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A proxy on loopback that takes every connection and never says a word.
async fn silent_proxy(cancel: CancellationToken) -> u16 {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut held = Vec::new();
        loop {
            tokio::select! {
                got = listener.accept() => match got {
                    Ok((s, _)) => held.push(s),
                    Err(_) => break,
                },
                () = cancel.cancelled() => break,
            }
        }
    });
    port
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
    let cancel = CancellationToken::new();
    let proxy = silent_proxy(cancel.clone()).await;
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{proxy}")).unwrap())
        .build()
        .unwrap();
    let runtime = Runtime::new(Layout::new(data.clone()), client);
    let jobs = LocalJobs::new(runtime.clone(), store.clone(), router.clone());
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

async fn get(w: &World, path: &str) -> Answer {
    send(w, "GET", path, None).await
}

async fn post(w: &World, path: &str, body: Value) -> Answer {
    send(w, "POST", path, Some(body)).await
}

fn keys(v: &Value) -> Vec<&str> {
    let mut k: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    k.sort_unstable();
    k
}

/// Asserts v2's refusal: the status, `{ok:false, said, code}`.
fn refused(a: &Answer, status: u16, code: &str, said: &str) {
    assert_eq!(a.status, status, "{}", a.body);
    let v = a.json();
    assert_eq!(keys(&v), ["code", "ok", "said"], "{v}");
    assert_eq!(v["ok"], false);
    assert_eq!(v["code"], code);
    assert_eq!(v["said"], said);
}

/// Polls this PC's job until `done` says so, for up to a minute.
async fn job_until(w: &World, id: &str, done: impl Fn(&Value) -> bool) -> Value {
    let start = Instant::now();
    loop {
        let a = get(w, &format!("/api/compute/job?host=this&job={id}")).await;
        assert_eq!(a.status, 200, "{}", a.body);
        let job = a.json()["job"].clone();
        if done(&job) {
            return job;
        }
        assert!(start.elapsed() < WAIT, "the job never got there: {job}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

// ---- the tests ----

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn role_is_interaction() {
    let w = world("role").await;
    let a = get(&w, "/api/compute/role").await;
    assert_eq!(a.status, 200);
    assert_eq!(a.json(), json!({ "role": "interaction", "active": 0 }));
    // Asking for the role it has is a no-op.
    let a = post(
        &w,
        "/api/compute/role",
        json!({ "role": "interaction", "confirm": true }),
    )
    .await;
    assert_eq!(a.status, 200, "{}", a.body);
    assert_eq!(a.json()["ok"], true);
    // No switch is ever waiting (v2 `RoleSwitching.stop()`).
    let a = post(&w, "/api/compute/role/cancel", json!({})).await;
    assert_eq!(a.status, 409);
    assert_eq!(
        a.json(),
        json!({ "ok": false, "note": "No role switch is waiting." })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn role_compute_refused_409() {
    let w = world("role-compute").await;
    // The guard asks first, as v2 (R2).
    let a = post(&w, "/api/compute/role", json!({ "role": "compute" })).await;
    assert_eq!(a.status, 409);
    assert_eq!(a.json()["confirm"], true);
    // Confirmed: there is no mesh to compute for.
    let a = post(
        &w,
        "/api/compute/role",
        json!({ "role": "compute", "confirm": true }),
    )
    .await;
    refused(&a, 409, "refused", MESH);
    let a = post(
        &w,
        "/api/compute/role",
        json!({ "role": "server", "confirm": true }),
    )
    .await;
    refused(&a, 400, "refused", "Choose Interaction or Compute.");
    assert_eq!(
        get(&w, "/api/compute/role").await.json()["role"],
        "interaction"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hosts_empty() {
    let w = world("hosts").await;
    let a = get(&w, "/api/compute/hosts").await;
    assert_eq!(a.status, 200);
    assert_eq!(
        a.json(),
        json!({ "hosts": [], "selected": "this", "available": false })
    );
    assert_eq!(
        get(&w, "/api/compute/discover").await.json(),
        json!({ "found": [] })
    );
    // Choosing this computer is kept; any other is not paired.
    let a = post(&w, "/api/compute/select", json!({ "host": "this" })).await;
    assert_eq!(a.status, 200);
    assert_eq!(a.json(), json!({ "ok": true }));
    assert_eq!(
        w.store.kv_get("_core", "compute_shown_host").unwrap(),
        Some(json!("this"))
    );
    let a = post(&w, "/api/compute/select", json!({ "host": "elsewhere" })).await;
    refused(&a, 404, "unpaired", UNPAIRED);
    let a = post(&w, "/api/compute/select", json!({})).await;
    refused(&a, 400, "refused", CHOOSE);
    // Unpairing what is not paired (R11).
    let a = post(
        &w,
        "/api/compute/unpair",
        json!({ "host": "nobody", "confirm": true }),
    )
    .await;
    refused(&a, 404, "unpaired", UNPAIRED);
    // Another computer's anything is not paired; none named is v2's 400.
    for path in [
        "/api/compute/inventory?host=x",
        "/api/compute/status?host=x",
        "/api/compute/queue?host=x",
        "/api/compute/jobs?host=x",
    ] {
        refused(&get(&w, path).await, 404, "unpaired", UNPAIRED);
    }
    for path in [
        "/api/compute/status",
        "/api/compute/queue",
        "/api/compute/jobs",
        "/api/compute/job?job=none",
    ] {
        refused(&get(&w, path).await, 400, "refused", CHOOSE);
    }
    let a = post(
        &w,
        "/api/compute/setup/install",
        json!({ "requirement": "x" }),
    )
    .await;
    refused(&a, 400, "refused", CHOOSE);
    let a = post(&w, "/api/compute/setup/install", json!({})).await;
    refused(&a, 400, "refused", "Supply a valid requirement.");
    let a = post(&w, "/api/compute/jobs/cancel", json!({ "job": "none" })).await;
    refused(&a, 400, "refused", CHOOSE);
    let a = post(&w, "/api/compute/window/close", json!({})).await;
    refused(&a, 409, "refused", ON_COMPUTE);
    // This computer, named, is reached directly.
    let a = get(&w, "/api/compute/status?host=this").await;
    assert_eq!(
        a.json(),
        json!({ "connection": "direct", "label": "Direct" })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inventory_this_pc_shape() {
    let w = world("inventory").await;
    refused(
        &get(&w, "/api/compute/inventory").await,
        400,
        "refused",
        CHOOSE,
    );
    let a = get(&w, "/api/compute/inventory?host=this").await;
    assert_eq!(a.status, 200, "{}", a.body);
    let v = a.json();
    assert_eq!(keys(&v), ["connection", "inventory"]);
    let inv = &v["inventory"];
    assert_eq!(
        keys(inv),
        [
            "appVersion",
            "capabilities",
            "machine",
            "models",
            "name",
            "revision",
            "setup"
        ]
    );
    assert_eq!(inv["appVersion"], "3.0.0");
    assert!(inv["name"].as_str().is_some_and(|n| !n.is_empty()));
    assert_eq!(inv["models"], json!([]));
    let m = &inv["machine"];
    for key in [
        "platform",
        "arch",
        "chip",
        "appleSilicon",
        "ramBytes",
        "freeDiskBytes",
        "budgetBytes",
    ] {
        assert!(m.get(key).is_some(), "machine has {key}: {m}");
    }
    assert!(m["ramBytes"].is_u64() && m["budgetBytes"].is_u64());
    assert_eq!(inv["capabilities"][0]["cap"], "text");
    assert_eq!(inv["capabilities"][0]["ready"], false);
    // No engine in a fresh data folder: it is what this computer is missing.
    let setup = inv["setup"].as_array().unwrap();
    assert_eq!(setup.len(), 1, "{setup:?}");
    assert_eq!(setup[0]["id"], "llama-cpp");
    assert_eq!(setup[0]["kind"], "runtime");
    assert_eq!(
        setup[0]["action"],
        if INSTALLS { "install" } else { "instructions" }
    );
    // Reading again changes nothing, the revision included.
    let again = get(&w, "/api/compute/inventory?host=this").await.json();
    assert_eq!(again["inventory"]["revision"], inv["revision"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queue_and_cancel_local_job() {
    let w = world("queue").await;
    let a = get(&w, "/api/compute/queue?host=this").await;
    assert_eq!(a.status, 200);
    assert_eq!(
        a.json(),
        json!({ "queue": { "waiting": [], "paused": false } })
    );
    let a = post(
        &w,
        "/api/compute/setup/install",
        json!({ "host": "this", "requirement": "nothing-like-it" }),
    )
    .await;
    refused(&a, 404, "not-found", "That setup requirement is not known.");

    let a = post(
        &w,
        "/api/compute/setup/install",
        json!({ "host": "this", "requirement": "llama-cpp" }),
    )
    .await;
    if !INSTALLS {
        assert_eq!(a.status, 409, "{}", a.body);
        return;
    }
    assert_eq!(a.status, 200, "{}", a.body);
    let job = a.json()["job"].clone();
    let id = job["id"].as_str().unwrap().to_owned();
    assert_eq!(job["kind"], "setup");
    assert_eq!(job["state"], "running");
    // The download waits on the silent proxy: the job is the queue's running one.
    let q = get(&w, "/api/compute/queue?host=this").await.json();
    assert_eq!(q["queue"]["running"]["id"], id.as_str());
    let a = post(
        &w,
        "/api/compute/setup/install",
        json!({ "host": "this", "requirement": "llama-cpp" }),
    )
    .await;
    refused(
        &a,
        409,
        "refused",
        "That requirement is already being installed.",
    );

    refused(
        &get(&w, "/api/compute/job?host=this&job=none").await,
        404,
        "not-found",
        "That compute job is not known.",
    );
    let a = post(
        &w,
        "/api/compute/jobs/cancel",
        json!({ "host": "this", "job": "none" }),
    )
    .await;
    refused(&a, 404, "not-found", "That compute job is not known.");
    let a = post(
        &w,
        "/api/compute/jobs/cancel",
        json!({ "host": "this", "job": id }),
    )
    .await;
    assert_eq!(a.status, 200, "{}", a.body);
    let said = a.json();
    assert_eq!(said["ok"], true);
    assert!(
        matches!(
            said["job"]["state"].as_str(),
            Some("cancelling" | "cancelled")
        ),
        "{said}"
    );
    let done = job_until(&w, &id, |j| j["state"] == "cancelled").await;
    assert!(done["finishedAt"].is_u64());
    let q = get(&w, "/api/compute/queue?host=this").await.json();
    assert_eq!(q["queue"], json!({ "waiting": [], "paused": false }));
    let jobs = get(&w, "/api/compute/jobs?host=this").await.json();
    assert_eq!(jobs["jobs"][0]["id"], id.as_str());
    assert_eq!(jobs["jobs"][0]["state"], "cancelled");
    // The engine is still missing, so it can be asked for again.
    let a = post(
        &w,
        "/api/compute/setup/install",
        json!({ "host": "this", "requirement": "llama-cpp" }),
    )
    .await;
    assert_eq!(a.status, 200, "{}", a.body);
    let again = a.json()["job"]["id"].as_str().unwrap().to_owned();
    assert_ne!(again, id);
    post(
        &w,
        "/api/compute/jobs/cancel",
        json!({ "host": "this", "job": again }),
    )
    .await;
    job_until(&w, &again, |j| j["state"] == "cancelled").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pause_roundtrip() {
    let w = world("pause").await;
    // v2 `only('compute')`: refused unless this PC is named (R20).
    let a = post(&w, "/api/compute/pause", json!({ "paused": true })).await;
    refused(&a, 409, "refused", ON_COMPUTE);
    let a = post(
        &w,
        "/api/compute/pause",
        json!({ "host": "this", "paused": "yes" }),
    )
    .await;
    refused(&a, 400, "refused", "Say whether this computer is paused.");
    let a = post(
        &w,
        "/api/compute/pause",
        json!({ "host": "this", "paused": true }),
    )
    .await;
    assert_eq!(a.status, 200, "{}", a.body);
    assert_eq!(a.json(), json!({ "ok": true }));
    let q = get(&w, "/api/compute/queue?host=this").await.json();
    assert_eq!(q["queue"]["paused"], true);
    // Paused, the local jobs give up at once.
    let started = w
        .api
        .parts
        .jobs
        .embed(&["x".into()], CancellationToken::new());
    assert!(tokio::time::timeout(WAIT, started).await.unwrap().is_none());

    if INSTALLS {
        // A job asked for while paused waits in the queue, and starts on resume.
        let a = post(
            &w,
            "/api/compute/setup/install",
            json!({ "host": "this", "requirement": "llama-cpp" }),
        )
        .await;
        assert_eq!(a.status, 200, "{}", a.body);
        let job = a.json()["job"].clone();
        assert_eq!(job["state"], "queued");
        let id = job["id"].as_str().unwrap().to_owned();
        let q = get(&w, "/api/compute/queue?host=this").await.json();
        assert_eq!(q["queue"]["waiting"][0]["id"], id.as_str());
        assert!(q["queue"].get("running").is_none());
        let a = post(
            &w,
            "/api/compute/pause",
            json!({ "host": "this", "paused": false }),
        )
        .await;
        assert_eq!(a.status, 200);
        job_until(&w, &id, |j| j["state"] == "running").await;
        let q = get(&w, "/api/compute/queue?host=this").await.json();
        assert_eq!(q["queue"]["paused"], false);
        assert_eq!(q["queue"]["running"]["id"], id.as_str());
        post(
            &w,
            "/api/compute/jobs/cancel",
            json!({ "host": "this", "job": id }),
        )
        .await;
        job_until(&w, &id, |j| j["state"] == "cancelled").await;
    } else {
        post(
            &w,
            "/api/compute/pause",
            json!({ "host": "this", "paused": false }),
        )
        .await;
        let q = get(&w, "/api/compute/queue?host=this").await.json();
        assert_eq!(q["queue"]["paused"], false);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn services_roundtrip_and_validation() {
    let w = world("services").await;
    let a = get(&w, "/api/compute/services").await;
    assert_eq!(a.json(), json!({ "defaults": true }));
    let a = post(
        &w,
        "/api/compute/services",
        json!({ "relay": " https://relay.example.com ", "mailbox": "https://mail.example.com,https://b.example.com" }),
    )
    .await;
    assert_eq!(a.status, 200, "{}", a.body);
    let want = json!({
        "relay": "https://relay.example.com",
        "mailbox": "https://mail.example.com,https://b.example.com",
        "defaults": false,
    });
    assert_eq!(a.json(), want);
    assert_eq!(get(&w, "/api/compute/services").await.json(), want);
    // A bad address is refused with v2's sentence, and what was kept stays.
    let a = post(
        &w,
        "/api/compute/services",
        json!({ "relay": "relay.example.com" }),
    )
    .await;
    refused(&a, 400, "refused", "Supply a valid relay address.");
    let a = post(&w, "/api/compute/services", json!({ "mailbox": 7 })).await;
    refused(&a, 400, "refused", "Supply a valid mailbox address.");
    assert_eq!(get(&w, "/api/compute/services").await.json(), want);
    // Clearing both is the built-in defaults again.
    let a = post(
        &w,
        "/api/compute/services",
        json!({ "relay": "", "mailbox": null }),
    )
    .await;
    assert_eq!(a.json(), json!({ "defaults": true }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pair_start_refused() {
    let w = world("pair").await;
    let a = post(&w, "/api/compute/pair/start", json!({})).await;
    refused(
        &a,
        400,
        "refused",
        "Type the code the other computer is showing.",
    );
    let a = post(&w, "/api/compute/pair/start", json!({ "code": "   " })).await;
    assert_eq!(a.status, 400);
    let a = post(
        &w,
        "/api/compute/pair/start",
        json!({ "code": "apple-river-stone-lamp" }),
    )
    .await;
    refused(&a, 409, "refused", MESH);
    // Nothing was opened.
    assert_eq!(get(&w, "/api/compute/pair").await.json(), json!({}));
    let a = post(&w, "/api/compute/pair/cancel", json!({})).await;
    assert_eq!(a.json(), json!({ "ok": true }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tailscale_state_and_actions() {
    let w = world("tailscale").await;
    let a = get(&w, "/api/compute/tailscale").await;
    assert_eq!(a.status, 200, "{}", a.body);
    let t = a.json()["tailscale"].clone();
    assert!(t["phase"].is_string() && t["said"].is_string(), "{t}");
    let a = post(&w, "/api/compute/tailscale", json!({ "action": "nothing" })).await;
    refused(&a, 400, "refused", "Choose install, start or login.");
    // `start` is kept, not run.
    let a = post(&w, "/api/compute/tailscale", json!({ "action": "start" })).await;
    assert_eq!(a.status, 200, "{}", a.body);
    assert!(a.json()["tailscale"]["phase"].is_string());
    let kept = w
        .store
        .kv_get("_core", "compute_tailscale")
        .unwrap()
        .unwrap();
    assert_eq!(kept["action"], "start");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_path_404_sentence() {
    let w = world("unknown").await;
    let sentence =
        json!({ "ok": false, "said": "That compute endpoint or method is not available." });
    for path in [
        "/api/compute/nothing",
        "/api/compute/pair/nothing/else",
        // A route asked with a method it does not take.
        "/api/compute/pause",
        "/api/compute/window/close",
    ] {
        let a = get(&w, path).await;
        assert_eq!(a.status, 404, "{path}");
        assert_eq!(a.json(), sentence, "{path}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn state_compute_shape() {
    let w = world("state").await;
    let a = get(&w, "/api/state").await;
    assert_eq!(a.status, 200, "{}", a.body);
    assert_eq!(
        a.json()["compute"],
        json!({ "role": "interaction", "available": false, "hosts": [] })
    );
}
