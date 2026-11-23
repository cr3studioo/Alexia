// SPDX-License-Identifier: AGPL-3.0-only
//! P2D-04: state, setup and settings (INVENTORY A1–A7), in-process. `Api::serve` on
//! `127.0.0.1:0` with a scratch store and secrets in memory; requests are written by hand over
//! TCP, as the window sends them (token, Host, JSON body).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::time::Duration;

use alexia_api::{Api, ApiParts};
use alexia_core::agent::{Agent, AgentParts};
use alexia_core::catalog::Catalog;
use alexia_core::checker::Checker;
use alexia_core::local::{LocalJobs, Runtime};
use alexia_core::permissions::{self, CallAsk};
use alexia_core::prompt::Skills;
use alexia_core::router::Router;
use alexia_core::tools::McpTooling;
use alexia_core::{Brain, Bus, Limits, Ruling};
use alexia_gateway::{Asker, ChannelSet};
use alexia_mcp::types::ToolAnnotations;
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, PluginId, Timings};
use alexia_scheduler::Scheduler;
use alexia_store::{secrets, Layout, MessageBody, Role, Store};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

/// Generous: a loaded Windows machine is slow.
const WAIT: Duration = Duration::from_secs(60);

// ---- the log, caught ----

/// Every tracing event's fields, as text, from every thread: the test reads it back to prove
/// a key never reached the log.
static LOG: Mutex<String> = Mutex::new(String::new());

struct Catch;

struct Fields<'a>(&'a mut String);

impl tracing::field::Visit for Fields<'_> {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.0.push_str(&format!("{}={:?} ", field.name(), value));
    }
}

impl tracing::Subscriber for Catch {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, span: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        let mut log = LOG.lock().unwrap_or_else(|e| e.into_inner());
        span.record(&mut Fields(&mut log));
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, values: &tracing::span::Record<'_>) {
        let mut log = LOG.lock().unwrap_or_else(|e| e.into_inner());
        values.record(&mut Fields(&mut log));
    }
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        let mut log = LOG.lock().unwrap_or_else(|e| e.into_inner());
        event.record(&mut Fields(&mut log));
        log.push('\n');
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

/// Secrets in memory and the log caught, once per test binary.
fn once() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
        let _ = tracing::subscriber::set_global_default(Catch);
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

impl Drop for World {
    fn drop(&mut self) {
        self.cancel.cancel();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn scratch(name: &str) -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("alexia-state-{name}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A plugin folder with `extra` merged into its manifest. Never spawned by these tests.
fn plugin(ext: &Path, id: &str, extra: Value) {
    let dir = ext.join(id);
    std::fs::create_dir_all(&dir).unwrap();
    let mut m = json!({
        "manifest_version": 1, "id": id, "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.", "version": "0.1.0",
        "license": "AGPL-3.0-only", "entry": { "run": "node", "args": ["plugin.js"] },
        "alexia_protocol": 2, "mcp_protocol": "2025-11-25"
    });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(dir.join("plugin.json"), m.to_string()).unwrap();
}

async fn world(name: &str) -> World {
    world_with(name, Store::open_in_memory().unwrap(), |_| {}, &[]).await
}

/// `store` as the hub would open it, `plugins` writing plugin folders before the host loads
/// them, and `enabled` the ids switched on.
async fn world_with(
    name: &str,
    store: Store,
    plugins: impl FnOnce(&Path),
    enabled: &[&str],
) -> World {
    once();
    let root = scratch(name);
    let data = root.join("data");
    let ext = root.join("ext");
    std::fs::create_dir_all(&ext).unwrap();
    plugins(&ext);
    let store = Arc::new(store);
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
    let ids: Vec<PluginId> = enabled.iter().map(|i| PluginId((*i).into())).collect();
    host.start(&ids).await.unwrap();
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
    let mut k: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    k.sort_unstable();
    k
}

// ---- the tests ----

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn state_on_fresh_store() {
    let w = world("fresh").await;
    let s = get(&w, "/api/state").await;
    assert_eq!(
        keys(&s),
        [
            "adult",
            "app",
            "cap",
            "ceilings",
            "channels",
            "commands",
            "compute",
            "cross",
            "editor",
            "layout",
            "messages",
            "notHer",
            "permissions",
            "pins",
            "providers",
            "setup",
            "spent",
            "today"
        ]
    );
    assert_eq!(
        s["setup"],
        json!({ "done": false, "name": "Alexia", "mode": "combined", "theme": "system",
                "glass": 60, "glassLook": "auto", "updates": true })
    );
    assert_eq!(s["adult"], json!({ "confirmed": false, "on": false }));
    assert_eq!(s["layout"], Value::Null);
    assert_eq!(s["channels"], 0);
    assert_eq!(s["app"], "3.0.0");
    assert_eq!(s["pins"], json!({}));
    assert_eq!(s["messages"], json!([]));
    assert_eq!((s["spent"].clone(), s["cap"].clone()), (json!(0), json!(0)));
    assert_eq!(s["today"], json!({ "spent": 0, "allowance": 0 }));
    assert_eq!(
        (s["cross"].clone(), s["notHer"].clone()),
        (json!(false), json!(false))
    );
    assert_eq!(s["ceilings"], json!({ "steps": 24, "askAbove": 0.02 }));
    assert_eq!(
        s["permissions"],
        json!({ "mode": "risky", "roots": [], "everywhere": false, "boundaries": [],
                "modes": { "every-time": "Ask me every time", "risky": "Ask before anything risky",
                           "watch": "Watch and warn me", "full-trust": "Full trust" } })
    );
    assert_eq!(s["editor"]["conversationId"], w.api.session().0.to_string());
    assert_eq!(s["compute"]["role"], "interaction");
    let commands = s["commands"].as_array().unwrap();
    assert_eq!(
        commands[0],
        json!({ "name": "new", "summary": "Start a new conversation. Nothing said before it comes with it." })
    );
    assert!(commands.iter().any(|c| c["name"] == "help"));

    let providers = s["providers"].as_array().unwrap();
    assert_eq!(providers.len(), alexia_core::free::ladder().len());
    let groq = providers.iter().find(|p| p["id"] == "groq").unwrap();
    assert_eq!(groq["name"], "Groq");
    assert_eq!(groq["connected"], false);
    assert_eq!(groq["keyStored"], false);
    assert_eq!(groq["keyless"], false);
    assert_eq!(groq["free"], true);
    assert_eq!(
        (groq["rpm"].clone(), groq["rpd"].clone()),
        (json!(30), json!(1000))
    );
    // The keyless floor is on until somebody turns it off: reachable, with no key stored.
    let horde = providers.iter().find(|p| p["id"] == "aihorde").unwrap();
    assert_eq!(
        (horde["connected"].clone(), horde["keyStored"].clone()),
        (json!(true), json!(false))
    );
    let cf = providers
        .iter()
        .find(|p| p["id"] == "cloudflare-ai")
        .unwrap();
    assert_eq!(cf["account"], true);
    let cerebras = providers.iter().find(|p| p["id"] == "cerebras").unwrap();
    assert_eq!(cerebras["card"], true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn state_after_import() {
    // v2's kv values, as the importer keeps them (INTERFACES §6).
    let store = Store::open_in_memory().unwrap();
    let layout = json!({ "v": 1, "cols": 12, "guides": [3, 9],
                         "pages": [{ "id": "chat", "w": 6, "h": 4, "anchor": { "x": 0, "y": 0 } }] });
    for (k, v) in [
        ("display_name", json!("Ada")),
        ("mode", json!("local")),
        ("theme", json!("dark")),
        ("glass", json!(75)),
        ("glass_look", json!("apple")),
        ("updates_auto", json!(false)),
        ("layout", layout.clone()),
        (
            "pins",
            json!({ "uncensored": true, "prefer": "best", "placement": { "text": "local" } }),
        ),
        ("adult", json!({ "confirmedAt": 1_700_000_000_000_i64 })),
        (
            "ceilings",
            json!({ "steps": 9, "askAbove": 0.5, "monthly": 20 }),
        ),
        (
            "scope",
            json!({ "mode": "watch", "roots": ["C:\\work"], "everywhere": true }),
        ),
        (
            "boundaries",
            json!([{ "said": "don't delete anything", "blocks": "destructive", "at": 5 }]),
        ),
        ("keyless.on", json!(false)),
    ] {
        store.kv_set("_core", k, &v).unwrap();
    }
    let session = store.create_session(None).unwrap();
    let body =
        |t: &str| -> MessageBody { serde_json::from_value(json!({ "content": t })).unwrap() };
    store
        .append(session, Role::User, None, &body("hello"))
        .unwrap();
    store
        .append(session, Role::Assistant, Some("groq/llama"), &body("hi"))
        .unwrap();
    let w = world_with("import", store, |_| {}, &[]).await;
    assert_eq!(w.api.session(), session);

    let s = get(&w, "/api/state").await;
    assert_eq!(
        s["setup"],
        json!({ "done": true, "name": "Ada", "mode": "local", "theme": "dark", "glass": 75,
                "glassLook": "apple", "updates": false })
    );
    assert_eq!(s["layout"], layout);
    assert_eq!(s["pins"], json!({ "uncensored": true, "prefer": "best" }));
    assert_eq!(s["adult"], json!({ "confirmed": true, "on": true }));
    // No budget in v3: the monthly cap is not shown back (D-P2D-6).
    assert_eq!(s["ceilings"], json!({ "steps": 9, "askAbove": 0.5 }));
    assert_eq!(s["cap"], 0);
    assert_eq!(s["permissions"]["mode"], "watch");
    assert_eq!(s["permissions"]["roots"], json!(["C:\\work"]));
    assert_eq!(s["permissions"]["everywhere"], true);
    assert_eq!(
        s["permissions"]["boundaries"],
        json!([{ "said": "don't delete anything", "blocks": "destructive", "at": 5 }])
    );
    assert_eq!(
        s["messages"],
        json!([{ "role": "user", "content": "hello" },
               { "role": "assistant", "model": "groq/llama", "content": "hi" }])
    );
    // The floor switched off: a keyless provider is not reachable without a key.
    let horde = s["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "aihorde")
        .unwrap();
    assert_eq!(horde["connected"], false);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn setup_name_too_long_400() {
    let w = world("name").await;
    let a = post(
        &w,
        "/api/setup",
        json!({ "name": "x".repeat(41), "theme": "dark" }),
    )
    .await;
    assert_eq!(a.status, 400);
    assert_eq!(
        a.json(),
        json!({ "ok": false, "said": "That name is too long. Keep it to 40 letters or fewer." })
    );
    // Refused before anything is written.
    assert_eq!(w.store.kv_get("_core", "theme").unwrap(), None);
    assert_eq!(w.store.kv_get("_core", "display_name").unwrap(), None);

    // Forty letters (and spaces trimmed) is fine; an unknown theme and an out-of-range glass
    // are checked rather than kept as sent.
    let a = post(
        &w,
        "/api/setup",
        json!({ "name": format!("  {}  ", "é".repeat(40)), "theme": "purple", "glass": 140.4,
                "glassLook": "nope", "updates": false, "mode": "combined" }),
    )
    .await;
    assert_eq!(a.status, 200, "{}", a.body);
    let v = a.json();
    assert_eq!(v["name"], "é".repeat(40));
    assert_eq!(v["theme"], "system");
    assert_eq!(v["glass"], 100);
    assert_eq!(v["glassLook"], "auto");
    assert_eq!(v["updates"], false);
    assert_eq!(v["done"], true);
    assert_eq!(v["layout"], Value::Null);

    // A layout with a bad page is refused whole; null forgets it.
    let bad = post(&w, "/api/setup", json!({ "layout": { "v": 1, "cols": 4, "guides": [1, 2], "pages": [{ "id": "a", "w": 0, "h": 1 }] } })).await;
    assert_eq!(bad.status, 400);
    assert_eq!(
        bad.json()["said"],
        "That layout cannot be kept: page 1 (a) needs a whole width and height of at least 1."
    );
    let good =
        json!({ "v": 1, "cols": 4, "guides": [1, 2], "pages": [{ "id": "a", "w": 2, "h": 1 }] });
    let a = post(&w, "/api/setup", json!({ "layout": good })).await;
    assert_eq!(a.json()["layout"], good);
    let a = post(&w, "/api/setup", json!({ "layout": null })).await;
    assert_eq!(a.json()["layout"], Value::Null);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_key_stored_not_echoed() {
    let w = world("key").await;
    // Not groq: `state_on_fresh_store` reads groq while this runs, and the memory backend is
    // shared. Built at runtime so no credential-shaped literal sits in the source.
    let key = format!("{}{}", "test-key-", "a1b2c3d4e5f6");
    let a = post(
        &w,
        "/api/setup",
        json!({ "provider": { "id": "mistral", "key": key } }),
    )
    .await;
    assert_eq!(a.status, 200, "{}", a.body);
    assert!(!a.body.contains(&key), "the answer echoed the key");
    assert_eq!(
        a.json()["said"],
        "Mistral connected. Its model list is still arriving — open the Models tab again in a moment."
    );
    assert_eq!(
        secrets::get("_core", "provider_mistral")
            .unwrap()
            .as_deref(),
        Some(key.as_str())
    );

    let s = send(&w, "GET", "/api/state", None).await;
    assert!(!s.body.contains(&key), "the state read carried the key");
    let mistral = s.json()["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "mistral")
        .cloned()
        .unwrap();
    assert_eq!(
        (mistral["keyStored"].clone(), mistral["connected"].clone()),
        (json!(true), json!(true))
    );
    // Never in kv either: every key this module writes, read back.
    for k in [
        "display_name",
        "mode",
        "theme",
        "pins",
        "scope",
        "ceilings",
        "layout",
        "account.mistral",
    ] {
        let v = w.store.kv_get("_core", k).unwrap();
        assert!(!v.map(|v| v.to_string()).unwrap_or_default().contains(&key));
    }

    // A key with a space in it is a sentence pasted by mistake: refused, the old key kept.
    let pasted = format!("{key} please");
    let a = post(
        &w,
        "/api/setup",
        json!({ "provider": { "id": "mistral", "key": pasted } }),
    )
    .await;
    assert_eq!(a.status, 400);
    assert!(!a.body.contains(&key));
    assert_eq!(
        secrets::get("_core", "provider_mistral")
            .unwrap()
            .as_deref(),
        Some(key.as_str())
    );

    // Removed: no key, not connected, and the answer says so.
    let a = post(
        &w,
        "/api/setup",
        json!({ "provider": { "id": "mistral", "remove": true } }),
    )
    .await;
    assert_eq!(a.status, 200);
    assert_eq!(a.json()["said"], "The Mistral key is removed.");
    assert_eq!(secrets::get("_core", "provider_mistral").unwrap(), None);
    let a = post(
        &w,
        "/api/setup",
        json!({ "provider": { "id": "aihorde", "remove": true } }),
    )
    .await;
    assert_eq!(
        a.json()["said"],
        "The AI Horde key is removed. AI Horde still answers without one, on its shared free tier."
    );

    let log = LOG.lock().unwrap_or_else(|e| e.into_inner()).clone();
    assert!(!log.contains(&key), "the log carried the key");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permissions_roundtrip_feeds_rule() {
    let w = world("perm").await;
    let work = w.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let file = work.join("notes.txt");
    let data = w.root.join("data");
    let read = ToolAnnotations {
        title: None,
        read_only_hint: Some(true),
        destructive_hint: Some(false),
        idempotent_hint: None,
        open_world_hint: None,
    };
    let ask = || CallAsk {
        tool: "files__read",
        words: "read a file",
        annotations: Some(&read),
        paths: vec![file.clone()],
        reviewed: true,
    };
    // G4: no folder chosen, so a path-bearing call is asked about.
    let before = permissions::rule(&ask(), &permissions::scope(&w.store, &data));
    assert!(
        matches!(&before, Ruling::Ask(q) if q.contains("outside the folders you chose")),
        "{before:?}"
    );

    let root = work.to_string_lossy().into_owned();
    let a = post(
        &w,
        "/api/permissions",
        json!({ "mode": "risky", "roots": [root] }),
    )
    .await;
    assert_eq!(a.status, 200, "{}", a.body);
    assert_eq!(
        a.json(),
        json!({ "mode": "risky", "roots": [root], "everywhere": false, "boundaries": [] })
    );
    let after = permissions::rule(&ask(), &permissions::scope(&w.store, &data));
    assert_eq!(after, Ruling::Run);

    // A mode that is not one of the four keeps the one standing; the roots stay.
    let a = post(&w, "/api/permissions", json!({ "mode": "anything" })).await;
    assert_eq!(a.json()["mode"], "risky");
    assert_eq!(a.json()["roots"], json!([root]));
    let a = post(
        &w,
        "/api/permissions",
        json!({ "mode": "full-trust", "everywhere": true }),
    )
    .await;
    assert_eq!(
        (a.json()["mode"].clone(), a.json()["everywhere"].clone()),
        (json!("full-trust"), json!(true))
    );

    // Lift needs the confirm, then clears the spoken boundaries.
    permissions::save_boundaries(
        &w.store,
        &[permissions::heard("don't delete anything", 1).unwrap()],
    )
    .unwrap();
    let refused = post(&w, "/api/permissions", json!({ "lift": true })).await;
    assert_eq!(refused.status, 409);
    let a = post(
        &w,
        "/api/permissions",
        json!({ "lift": true, "confirm": true }),
    )
    .await;
    assert_eq!(a.status, 200);
    assert_eq!(a.json()["boundaries"], json!([]));
    assert!(permissions::scope(&w.store, &data).boundaries.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daily_above_zero_refused() {
    let w = world("ceil").await;
    let a = post(
        &w,
        "/api/ceilings",
        json!({ "steps": 12.7, "askAbove": 1, "daily": 0 }),
    )
    .await;
    assert_eq!(a.status, 200, "{}", a.body);
    assert_eq!(
        a.json(),
        json!({ "steps": 12, "askAbove": 1, "spent": 0, "allowance": 0 })
    );
    for money in [json!({ "daily": 5 }), json!({ "monthly": 10, "steps": 3 })] {
        let a = post(&w, "/api/ceilings", money).await;
        assert_eq!(a.status, 400);
        assert_eq!(
            a.json(),
            json!({ "ok": false, "said": "Alexia v3 only uses free models." })
        );
    }
    // Nothing changed by a refused request; nonsense values are ignored.
    let a = post(&w, "/api/ceilings", json!({ "steps": 0, "askAbove": -1 })).await;
    assert_eq!(a.json()["steps"], 12);
    assert_eq!(a.json()["askAbove"], 1);
    let s = get(&w, "/api/state").await;
    assert_eq!(s["ceilings"], json!({ "steps": 12, "askAbove": 1 }));
    assert_eq!(s["today"]["allowance"], 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn adult_off_clears_pin() {
    let w = world("adult").await;
    // On needs the gate's confirm and the 18+ answer.
    let a = post(&w, "/api/adult", json!({ "enabled": true })).await;
    assert_eq!(a.status, 409);
    let a = post(
        &w,
        "/api/adult",
        json!({ "enabled": true, "confirm": true }),
    )
    .await;
    assert_eq!(a.json()["ok"], false);
    assert_eq!(w.store.kv_get("_core", "adult").unwrap(), None);
    let a = post(
        &w,
        "/api/adult",
        json!({ "enabled": true, "adult": true, "confirm": true }),
    )
    .await;
    assert_eq!(a.json()["ok"], true);
    assert!(w.store.kv_get("_core", "adult").unwrap().unwrap()["confirmedAt"].is_number());
    // /nsfw on, as the command would leave it.
    w.store
        .kv_set(
            "_core",
            "pins",
            &json!({ "uncensored": true, "prefer": "best" }),
        )
        .unwrap();
    assert_eq!(
        get(&w, "/api/state").await["adult"],
        json!({ "confirmed": true, "on": true })
    );

    let a = post(&w, "/api/adult", json!({ "enabled": false })).await;
    assert_eq!(a.status, 200);
    assert_eq!(
        a.json(),
        json!({ "ok": true, "said": "Adult content is off." })
    );
    assert_eq!(w.store.kv_get("_core", "adult").unwrap(), None);
    assert_eq!(
        w.store.kv_get("_core", "pins").unwrap().unwrap(),
        json!({ "uncensored": false, "prefer": "best" })
    );
    assert_eq!(
        get(&w, "/api/state").await["adult"],
        json!({ "confirmed": false, "on": false })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_finds_a_plugin_setting() {
    let w = world_with(
        "search",
        Store::open_in_memory().unwrap(),
        |ext| {
            plugin(
                ext,
                "weather",
                json!({ "settings": [
                    { "key": "city", "type": "text", "label": "Home city" },
                    { "key": "units", "type": "choice", "label": "Temperature units", "options": ["c", "f"] },
                ] }),
            );
        },
        &["weather"],
    )
    .await;
    let hits = get(&w, "/api/search?q=temperature").await["hits"].clone();
    let first = &hits[0];
    assert_eq!(first["label"], "Temperature units");
    assert_eq!(first["kind"], "setting");
    assert_eq!(first["tab"], "plugins");
    assert_eq!(first["filter"], "Plugin weather");
    assert!(first["score"].as_i64().unwrap() > 0);

    // The plugin itself, and core's own tabs and Settings places, are found too.
    let hits = get(&w, "/api/search?q=plugin%20weather").await["hits"].clone();
    assert!(hits
        .as_array()
        .unwrap()
        .iter()
        .any(|h| h["kind"] == "plugin" && h["label"] == "Plugin weather"));
    let hits = get(&w, "/api/search?q=chat").await["hits"].clone();
    assert_eq!(
        hits[0],
        json!({ "tab": "chats", "kind": "panel", "label": "Chats", "score": 79 })
    );
    let hits = get(&w, "/api/search?q=dark").await["hits"].clone();
    assert_eq!(hits[0]["label"], "Theme");
    assert_eq!(get(&w, "/api/search?q=").await["hits"], json!([]));
    assert_eq!(get(&w, "/api/search").await["hits"], json!([]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn panels_are_v2s_core_tabs() {
    let w = world("panels").await;
    let tabs = get(&w, "/api/panels").await["tabs"].clone();
    let ids: Vec<&str> = tabs
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["runs", "chats", "models", "skills", "tools"]);
    assert_eq!(tabs[0]["widgets"][0]["key"], "activity");
    assert!(tabs[0].get("screen").is_none());
    assert_eq!(tabs[2]["screen"], "settings");
    let ladder = &tabs[2]["widgets"][0];
    assert_eq!(ladder["type"], "ladder");
    // v3 never pays: the slider stands on free, and nothing crosses.
    assert_eq!(
        (
            ladder["value"].clone(),
            ladder["cross"].clone(),
            ladder["daily"].clone(),
            ladder["keyless"].clone()
        ),
        (json!("free"), json!(false), json!(0), json!(true))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn channels_counted_by_capability() {
    let w = world_with(
        "channels",
        Store::open_in_memory().unwrap(),
        |ext| {
            plugin(
                ext,
                "chan-a",
                json!({ "provides": ["channel.chat"],
                        "settings": [{ "key": "token", "type": "password", "label": "Token" }] }),
            );
            plugin(ext, "chan-b", json!({ "provides": ["channel.chat"] }));
            plugin(ext, "chan-off", json!({ "provides": ["channel.chat"] }));
        },
        &["chan-a", "chan-b"],
    )
    .await;
    // chan-b needs no key; chan-a's is not stored; chan-off is switched off.
    assert_eq!(get(&w, "/api/state").await["channels"], 1);
    secrets::set("chan-a", "token", &format!("{}{}", "tok", "en-value")).unwrap();
    assert_eq!(get(&w, "/api/state").await["channels"], 2);
}
