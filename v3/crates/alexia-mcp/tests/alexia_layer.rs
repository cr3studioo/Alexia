// SPDX-License-Identifier: AGPL-3.0-only
//! The `alexia/*` layer (P0-13) against the `mcp-fixture` binary: settings, storage, kv,
//! capability calls, `answers`, host info and the two notifications.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alexia_mcp::jsonrpc::RpcError;
use alexia_mcp::types::CallToolResult;
use alexia_mcp::{
    CallCtx, EventSink, HostConfig, McpHost, NoUpcalls, PluginEvent, PluginId, Timings,
};
use alexia_store::{secrets, Layout, Store};
use serde_json::{json, Map, Value};

const FIXTURE: &str = env!("CARGO_BIN_EXE_mcp-fixture");

fn root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("alexia-layer-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// `<dir>/<id>/plugin.json` running the fixture in `mode`, with `extra` manifest fields.
fn plugin(dir: &Path, id: &str, mode: &str, extra: Value) {
    let path = dir.join(id);
    std::fs::create_dir_all(&path).unwrap();
    let exe = Path::new(FIXTURE).file_name().unwrap().to_str().unwrap();
    std::fs::copy(FIXTURE, path.join(exe)).unwrap();
    let mut m = json!({
        "manifest_version": 1,
        "id": id,
        "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": exe, "args": [mode] },
        "alexia_protocol": 2,
        "mcp_protocol": "2025-11-25"
    });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(path.join("plugin.json"), m.to_string()).unwrap();
}

struct Fx {
    host: McpHost,
    store: Arc<Store>,
    events: Arc<Mutex<Vec<PluginEvent>>>,
}

async fn start(root: &Path, enabled: &[&str]) -> Fx {
    std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
    let store = Arc::new(Store::open_in_memory().unwrap());
    let events = Arc::new(Mutex::new(vec![]));
    let sink: EventSink = {
        let events = events.clone();
        Arc::new(move |e| events.lock().unwrap().push(e))
    };
    let cfg = HostConfig {
        layout: Layout::new(root.join("data")),
        plugin_dirs: vec![root.join("ext")],
        node: PathBuf::from("node"),
        timings: Timings::default(),
    };
    let host = McpHost::new(cfg, store.clone(), Arc::new(NoUpcalls), sink);
    let enabled: Vec<PluginId> = enabled.iter().map(|s| id(s)).collect();
    host.start(&enabled).await.unwrap();
    Fx {
        host,
        store,
        events,
    }
}

fn id(s: &str) -> PluginId {
    PluginId(s.into())
}

fn args(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

/// The fixture renders a host answer as the tool result's text, JSON for a success.
async fn tool(fx: &Fx, plugin: &str, name: &str, a: Value) -> CallToolResult {
    fx.host
        .call_tool(&id(plugin), name, args(a), CallCtx::default())
        .await
        .unwrap()
}

fn text(r: &CallToolResult) -> String {
    r.content[0]["text"].as_str().unwrap().to_string()
}

fn answer(r: &CallToolResult) -> Value {
    assert_ne!(r.is_error, Some(true), "the host refused: {}", text(r));
    serde_json::from_str(&text(r)).unwrap()
}

async fn serve(fx: &Fx, plugin: &str, method: &str, params: Value) -> Result<Value, RpcError> {
    fx.host.serve_for_test(&id(plugin), method, params).await
}

fn started(fx: &Fx) -> usize {
    let events = fx.events.lock().unwrap();
    events
        .iter()
        .filter(|e| matches!(e, PluginEvent::Started { .. }))
        .count()
}

fn storage(plugin: &str) -> Value {
    json!({ "namespace": plugin, "tables": ["notes"] })
}

#[tokio::test]
async fn settings_get_merges_defaults_values_and_secrets() {
    let r = root("settings-get");
    plugin(
        &r.join("ext"),
        "settings-get",
        "greet",
        json!({"settings": [
            {"key": "greeting", "type": "text", "label": "Greeting", "default": "Hello"},
            {"key": "tone", "type": "choice", "label": "Tone", "options": ["warm", "dry"], "default": "warm"},
            {"key": "token", "type": "password", "label": "Token"},
            {"key": "unset", "type": "text", "label": "No default"},
        ]}),
    );
    let fx = start(&r, &["settings-get"]).await;
    fx.store
        .set_setting("settings-get", "tone", &json!("dry"))
        .unwrap();
    // Never stored in the database: only the keychain has it.
    secrets::set("settings-get", "token", &format!("{}-{}", "not", "secret")).unwrap();

    let got = answer(&tool(&fx, "settings-get", "greet", json!({"who": "ask"})).await);
    assert_eq!(
        got,
        json!({"settings": {"greeting": "Hello", "tone": "dry", "token": "not-secret"}})
    );
    assert!(!fx
        .store
        .settings("settings-get")
        .unwrap()
        .contains_key("token"));
    fx.host.shutdown().await;
}

#[tokio::test]
async fn settings_set_only_status() {
    let r = root("settings-set");
    plugin(
        &r.join("ext"),
        "settings-set",
        "greet",
        json!({"settings": [
            {"key": "state", "type": "status", "label": "State"},
            {"key": "name", "type": "text", "label": "Name"},
        ]}),
    );
    let fx = start(&r, &["settings-set"]).await;
    let set = |key: &str| json!({"key": key, "value": "ready"});

    assert_eq!(
        serve(&fx, "settings-set", "alexia/settings/set", set("state"))
            .await
            .unwrap(),
        json!({})
    );
    assert_eq!(
        fx.store.settings("settings-set").unwrap().get("state"),
        Some(&json!("ready"))
    );
    let e = serve(&fx, "settings-set", "alexia/settings/set", set("name"))
        .await
        .unwrap_err();
    assert_eq!(e.code, -32602);
    let e = serve(&fx, "settings-set", "alexia/settings/set", set("nope"))
        .await
        .unwrap_err();
    assert_eq!(e.code, -32053);
    assert!(!fx
        .store
        .settings("settings-set")
        .unwrap()
        .contains_key("name"));
}

#[tokio::test]
async fn storage_round_trip() {
    let r = root("storage");
    plugin(
        &r.join("ext"),
        "keeper",
        "storage",
        json!({"storage": storage("keeper")}),
    );
    let fx = start(&r, &["keeper"]).await;

    assert_eq!(
        answer(&tool(&fx, "keeper", "remember", json!({"text": "one"})).await),
        json!({"rowid": 1})
    );
    answer(&tool(&fx, "keeper", "remember", json!({"text": "two"})).await);
    let rows = answer(&tool(&fx, "keeper", "list", json!({})).await);
    assert_eq!(
        rows,
        json!({"rows": [{"rowid": 1, "text": "one"}, {"rowid": 2, "text": "two"}]})
    );

    let value = json!({"n": 3, "tags": ["a", "b"]});
    answer(&tool(&fx, "keeper", "store", json!({"key": "k", "value": value})).await);
    assert_eq!(
        answer(&tool(&fx, "keeper", "recall", json!({"key": "k"})).await),
        json!({"value": value})
    );
    // Unset is an absent value, not null.
    assert_eq!(
        answer(&tool(&fx, "keeper", "recall", json!({"key": "missing"})).await),
        json!({})
    );

    // delete: exactly one of a non-empty where or all.
    let e = serve(
        &fx,
        "keeper",
        "alexia/storage/delete",
        json!({"table": "notes"}),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, -32602);
    let both = json!({"table": "notes", "where": {"text": "one"}, "all": true});
    let e = serve(&fx, "keeper", "alexia/storage/delete", both)
        .await
        .unwrap_err();
    assert_eq!(e.code, -32602);
    let one = json!({"table": "notes", "where": {"text": "one"}});
    assert_eq!(
        serve(&fx, "keeper", "alexia/storage/delete", one)
            .await
            .unwrap(),
        json!({"deleted": 1})
    );
    assert_eq!(
        serve(
            &fx,
            "keeper",
            "alexia/storage/count",
            json!({"table": "notes"})
        )
        .await
        .unwrap(),
        json!({"count": 1})
    );
    fx.host.shutdown().await;
}

#[tokio::test]
async fn storage_without_declaration_is_out_of_namespace() {
    let r = root("no-storage");
    plugin(&r.join("ext"), "loose", "storage", json!({}));
    let fx = start(&r, &["loose"]).await;

    let row = json!({"table": "notes", "row": {"text": "x"}});
    let e = serve(&fx, "loose", "alexia/storage/insert", row)
        .await
        .unwrap_err();
    assert_eq!(e.code, -32052);
    // The same over the wire: the fixture turns the error into an error result.
    let out = tool(&fx, "loose", "remember", json!({"text": "x"})).await;
    assert_eq!(out.is_error, Some(true));
    let e = serve(
        &fx,
        "loose",
        "alexia/storage/raw",
        json!({"sql": "SELECT 1"}),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, -32052);
    fx.host.shutdown().await;
}

#[tokio::test]
async fn kv_value_cap() {
    let r = root("kv-cap");
    plugin(&r.join("ext"), "kv-cap", "storage", json!({}));
    let fx = start(&r, &["kv-cap"]).await;

    let big = json!({"key": "big", "value": "x".repeat(70_000)});
    let e = serve(&fx, "kv-cap", "alexia/storage/kv/set", big)
        .await
        .unwrap_err();
    assert_eq!(e.code, -32602);
    assert_eq!(fx.store.kv_get("kv-cap", "big").unwrap(), None);
    let small = json!({"key": "small", "value": "x".repeat(1_000)});
    serve(&fx, "kv-cap", "alexia/storage/kv/set", small)
        .await
        .unwrap();
    assert!(fx.store.kv_get("kv-cap", "small").unwrap().is_some());
}

/// A asks for `demo.greet`; B provides it.
fn asker_and_provider(r: &Path, asks: bool) {
    let requires = if asks {
        json!([{"cap": "demo.greet", "why": "To say hello."}])
    } else {
        json!([])
    };
    plugin(
        &r.join("ext"),
        "asker",
        "storage",
        json!({"storage": storage("asker"), "requires": requires}),
    );
    plugin(
        &r.join("ext"),
        "greeter",
        "greet",
        json!({"provides": ["demo.greet"]}),
    );
}

#[tokio::test]
async fn capability_call_resolves_without_naming() {
    let r = root("cap-call");
    asker_and_provider(&r, true);
    let fx = start(&r, &["asker", "greeter"]).await;

    let call = json!({"cap": "demo.greet", "arguments": {"who": "Sam"}});
    let out = serve(&fx, "asker", "alexia/capability/call", call)
        .await
        .unwrap();
    let r: CallToolResult = serde_json::from_value(out.clone()).unwrap();
    assert_eq!(text(&r), "Hello, Sam.");
    // Nothing in the answer says who gave it.
    let wire = out.to_string();
    assert!(!wire.contains("greeter"), "{wire}");
    assert!(out.get("plugin").is_none() && out.get("_meta").is_none());
    assert!(fx.host.pid(&id("greeter")).is_some());
    fx.host.shutdown().await;
}

#[tokio::test]
async fn capability_call_needs_requires() {
    let r = root("cap-requires");
    asker_and_provider(&r, false);
    let fx = start(&r, &["asker", "greeter"]).await;

    let call = json!({"cap": "demo.greet", "arguments": {"who": "Sam"}});
    let e = serve(&fx, "asker", "alexia/capability/call", call)
        .await
        .unwrap_err();
    assert_eq!(e.code, -32051);
    // Refused before anything was asked.
    assert_eq!(fx.host.pid(&id("greeter")), None);
}

#[tokio::test]
async fn capability_call_without_provider() {
    let r = root("cap-none");
    asker_and_provider(&r, true);
    // B installed but switched off.
    let fx = start(&r, &["asker"]).await;

    let call = json!({"cap": "demo.greet"});
    let e = serve(&fx, "asker", "alexia/capability/call", call)
        .await
        .unwrap_err();
    assert_eq!(e.code, -32050);
    assert_eq!(
        e.message,
        "Nothing installed and switched on can do demo.greet."
    );
    assert_eq!(fx.host.pid(&id("greeter")), None);
}

#[tokio::test]
async fn answers_reads_manifests_only() {
    let r = root("answers");
    asker_and_provider(&r, false);
    // B is lazy (the default) and has never run.
    let fx = start(&r, &["asker", "greeter"]).await;

    let a = fx.host.answers("demo.greet");
    assert!(a.answers && a.here);
    assert!(!fx.host.answers("demo.other").answers);
    // No `requires` needed just to ask.
    let wire = serve(&fx, "asker", "alexia/answers", json!({"cap": "demo.greet"}))
        .await
        .unwrap();
    assert_eq!(wire, json!({"answers": true, "here": true}));
    assert_eq!(fx.host.pid(&id("greeter")), None);
    assert_eq!(started(&fx), 0, "no process was started");
}

#[tokio::test]
async fn host_info_shape() {
    let r = root("host-info");
    plugin(
        &r.join("ext"),
        "with-dir",
        "greet",
        json!({"requires": [{"cap": "fs.own_dir", "why": "To keep files."}]}),
    );
    plugin(&r.join("ext"), "without-dir", "greet", json!({}));
    let fx = start(&r, &["with-dir", "without-dir"]).await;

    let info = serve(&fx, "with-dir", "alexia/host/info", json!({}))
        .await
        .unwrap();
    let expected = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    assert_eq!(info["platform"], expected);
    if cfg!(windows) {
        assert_eq!(info["platform"], "win32");
    }
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    assert_eq!(info["arch"], arch);
    assert_eq!(info["alexiaVersion"], alexia_mcp::APP_VERSION);
    assert_eq!(info["alexiaProtocol"], alexia_mcp::ALEXIA_PROTOCOL_MAX);
    assert_eq!(info["locale"], "en-GB");
    assert_eq!(info["privacyMode"], "cloud");
    let own = PathBuf::from(info["paths"]["ownDir"].as_str().expect("ownDir"));
    assert_eq!(own, r.join("data").join("plugins").join("with-dir"));
    assert!(own.is_dir());
    let cache = PathBuf::from(info["paths"]["cacheDir"].as_str().unwrap());
    assert_eq!(cache, r.join("data").join("cache").join("with-dir"));
    assert!(cache.is_dir());

    let info = serve(&fx, "without-dir", "alexia/host/info", json!({}))
        .await
        .unwrap();
    assert!(info["paths"].get("ownDir").is_none(), "{info}");
    assert!(info["paths"]["cacheDir"].is_string());
}

/// Waits (generously: a loaded machine is slow) for a `note` line naming `method`.
async fn noted(fx: &Fx, plugin: &str, method: &str) -> Option<Value> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let found = fx
            .host
            .log(&id(plugin))
            .iter()
            .filter_map(|l| l.strip_prefix("note "))
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .find(|v| v["method"] == method);
        if found.is_some() || Instant::now() > deadline {
            return found;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn conversation_ended_reaches_running_plugins_only() {
    let r = root("ended");
    plugin(&r.join("ext"), "awake", "greet", json!({}));
    plugin(&r.join("ext"), "asleep", "greet", json!({}));
    let fx = start(&r, &["awake", "asleep"]).await;
    tool(&fx, "awake", "greet", json!({"who": "x"})).await;
    assert!(fx.host.pid(&id("awake")).is_some());

    fx.host.conversation_ended().await;
    let note = noted(&fx, "awake", "alexia/conversation/ended")
        .await
        .expect("the running plugin got the notification");
    // Deliberately nothing about the conversation.
    assert_eq!(note["params"], json!({}));
    assert!(note.get("id").is_none());
    assert_eq!(fx.host.pid(&id("asleep")), None, "not spawned for it");
    assert!(fx.host.log(&id("asleep")).is_empty());
    assert_eq!(started(&fx), 1);

    // settings/changed: only to a running plugin, only the changed keys.
    let changed = args(json!({"tone": "dry"}));
    fx.host
        .settings_changed(&id("awake"), changed.clone())
        .await;
    fx.host.settings_changed(&id("asleep"), changed).await;
    let note = noted(&fx, "awake", "alexia/settings/changed")
        .await
        .expect("the running plugin got settings/changed");
    assert_eq!(note["params"], json!({"changed": {"tone": "dry"}}));
    assert_eq!(fx.host.pid(&id("asleep")), None);
    assert_eq!(started(&fx), 1);
    fx.host.shutdown().await;
}
