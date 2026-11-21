// SPDX-License-Identifier: AGPL-3.0-only
//! P2-62 (review 5 #6, #7) against the `mcp-fixture` binary: a plugin new to this host starts
//! unreviewed, the owner's word changes that, and a plugin held for a game stays stopped.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use alexia_mcp::{
    CallCtx, CallError, EventSink, HostConfig, HostedTool, McpHost, NoUpcalls, PluginEvent,
    PluginId, Timings,
};
use alexia_store::{Layout, Store};
use serde_json::{json, Map, Value};

const FIXTURE: &str = env!("CARGO_BIN_EXE_mcp-fixture");

/// A test's temp folder, removed when the test ends: each holds a copy of the fixture, and
/// runs in a loop would otherwise fill the disk.
struct Root(PathBuf);

impl std::ops::Deref for Root {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn root(tag: &str) -> Root {
    let root = std::env::temp_dir().join(format!("alexia-hold-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    Root(root)
}

/// `<root>/ext/<id>/plugin.json`, a lazy `greet` fixture providing `demo.greet`.
fn plugin(root: &Path, id: &str) {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let exe = Path::new(FIXTURE).file_name().unwrap().to_str().unwrap();
    if !bin.join(exe).exists() {
        std::fs::copy(FIXTURE, bin.join(exe)).unwrap();
    }
    let path = root.join("ext").join(id);
    std::fs::create_dir_all(&path).unwrap();
    let m = json!({
        "manifest_version": 1,
        "id": id,
        "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": format!("../../bin/{exe}"), "args": ["greet"] },
        "alexia_protocol": 2,
        "mcp_protocol": "2025-11-25",
        "provides": ["demo.greet"]
    });
    std::fs::write(path.join("plugin.json"), m.to_string()).unwrap();
}

struct Fx {
    host: McpHost,
    events: Arc<Mutex<Vec<PluginEvent>>>,
}

impl Fx {
    /// A host over `<root>/ext` and `store`, started with `on` switched on.
    async fn start(root: &Path, store: &Arc<Store>, on: &[&str]) -> Fx {
        let events: Arc<Mutex<Vec<PluginEvent>>> = Arc::default();
        let sink: EventSink = {
            let events = events.clone();
            Arc::new(move |e| events.lock().unwrap().push(e))
        };
        let cfg = HostConfig {
            layout: Layout::new(root.join("data")),
            plugin_dirs: vec![root.join("ext")],
            node: PathBuf::from("node"),
            // A cold start of two fresh fixture copies on a loaded Windows machine can take
            // longer than the 10 s default to answer `initialize`.
            timings: Timings {
                start_ms: 60_000,
                ..Timings::default()
            },
        };
        let host = McpHost::new(cfg, store.clone(), Arc::new(NoUpcalls), sink);
        let ids: Vec<PluginId> = on.iter().map(|s| id(s)).collect();
        host.start(&ids).await.unwrap();
        Fx { host, events }
    }

    fn started(&self) -> usize {
        let events = self.events.lock().unwrap();
        events
            .iter()
            .filter(|e| matches!(e, PluginEvent::Started { .. }))
            .count()
    }

    async fn greet(&self, plugin: &str) -> Result<(), CallError> {
        let args: Map<String, Value> = json!({"who": "Sam"}).as_object().unwrap().clone();
        self.host
            .call_tool(&id(plugin), "greet", args, CallCtx::default())
            .await
            .map(|_| ())
    }
}

fn id(s: &str) -> PluginId {
    PluginId(s.into())
}

fn store() -> Arc<Store> {
    Arc::new(Store::open_in_memory().unwrap())
}

/// Each plugin's tools with whether they are reviewed; every plugin must list some.
fn reviewed(host: &McpHost, tools: &[HostedTool], plugins: &[&str]) -> Vec<bool> {
    plugins
        .iter()
        .map(|p| {
            let mine: Vec<_> = tools.iter().filter(|t| t.plugin.0 == *p).collect();
            assert!(
                !mine.is_empty(),
                "{p} listed no tools: {:?}",
                host.plugins()
            );
            assert!(mine.iter().all(|t| t.reviewed == mine[0].reviewed), "{p}");
            mine[0].reviewed
        })
        .collect()
}

fn paused(r: Result<(), CallError>, name: &str) {
    match r {
        Err(CallError::Off { sentence }) => {
            assert_eq!(sentence, format!("{name} is paused while a game runs."));
        }
        other => panic!("expected Off, got {other:?}"),
    }
}

#[tokio::test]
async fn first_scan_trusts_installed() {
    let r = root("first");
    plugin(&r, "a");
    plugin(&r, "b");
    let store = store();
    let fx = Fx::start(&r, &store, &["a", "b"]).await;
    let tools = fx.host.tools().await;
    assert_eq!(reviewed(&fx.host, &tools, &["a", "b"]), [true, true]);
    assert_eq!(
        store.kv_get("_core", "known_plugins").unwrap(),
        Some(json!(["a", "b"]))
    );
    assert_eq!(store.kv_get("_core", "unreviewed").unwrap(), None);
    fx.host.shutdown().await;
}

#[tokio::test]
async fn new_plugin_after_first_scan_unreviewed() {
    let r = root("new");
    plugin(&r, "a");
    let store = store();
    let fx = Fx::start(&r, &store, &["a"]).await;
    fx.host.shutdown().await;
    // A folder dropped in later (a third-party server, say) is new to this host.
    plugin(&r, "b");
    let fx = Fx::start(&r, &store, &["a", "b"]).await;
    let tools = fx.host.tools().await;
    assert_eq!(reviewed(&fx.host, &tools, &["a", "b"]), [true, false]);
    assert_eq!(
        store.kv_get("_core", "unreviewed").unwrap(),
        Some(json!(["b"]))
    );
    assert_eq!(
        store.kv_get("_core", "known_plugins").unwrap(),
        Some(json!(["a", "b"]))
    );
    fx.host.shutdown().await;
    // Known now, it is not added twice; it stays unreviewed until the owner says otherwise.
    let fx = Fx::start(&r, &store, &["a", "b"]).await;
    assert_eq!(
        store.kv_get("_core", "unreviewed").unwrap(),
        Some(json!(["b"]))
    );
    let tools = fx.host.tools().await;
    assert_eq!(reviewed(&fx.host, &tools, &["a", "b"]), [true, false]);
    fx.host.shutdown().await;
}

#[tokio::test]
async fn set_reviewed_clears_it() {
    let r = root("set");
    plugin(&r, "a");
    let store = store();
    store.kv_set("_core", "known_plugins", &json!([])).unwrap();
    let fx = Fx::start(&r, &store, &["a"]).await;
    assert_eq!(reviewed(&fx.host, &fx.host.tools().await, &["a"]), [false]);
    fx.host.set_reviewed(&id("a"), true).unwrap();
    assert_eq!(reviewed(&fx.host, &fx.host.tools().await, &["a"]), [true]);
    assert_eq!(
        store.kv_get("_core", "unreviewed").unwrap(),
        Some(json!([]))
    );
    fx.host.set_reviewed(&id("a"), false).unwrap();
    fx.host.set_reviewed(&id("a"), false).unwrap();
    assert_eq!(reviewed(&fx.host, &fx.host.tools().await, &["a"]), [false]);
    assert_eq!(
        store.kv_get("_core", "unreviewed").unwrap(),
        Some(json!(["a"]))
    );
    // A list it cannot understand is an error, and is left as it was.
    store
        .kv_set("_core", "unreviewed", &json!({"not": "a list"}))
        .unwrap();
    assert!(fx.host.set_reviewed(&id("a"), true).is_err());
    assert_eq!(
        store.kv_get("_core", "unreviewed").unwrap(),
        Some(json!({"not": "a list"}))
    );
    fx.host.shutdown().await;
}

#[tokio::test]
async fn malformed_known_list_everyone_unreviewed() {
    let r = root("malformed");
    plugin(&r, "a");
    plugin(&r, "b");
    let store = store();
    let bad = json!({"not": "a list"});
    store.kv_set("_core", "known_plugins", &bad).unwrap();
    let fx = Fx::start(&r, &store, &["a", "b"]).await;
    let tools = fx.host.tools().await;
    assert_eq!(reviewed(&fx.host, &tools, &["a", "b"]), [false, false]);
    // Nothing was written over it.
    assert_eq!(store.kv_get("_core", "known_plugins").unwrap(), Some(bad));
    assert_eq!(store.kv_get("_core", "unreviewed").unwrap(), None);
    fx.host.shutdown().await;
}

#[tokio::test]
async fn held_plugin_not_respawned() {
    let r = root("held");
    plugin(&r, "a");
    let fx = Fx::start(&r, &store(), &["a"]).await;
    fx.greet("a").await.unwrap();
    assert!(fx.host.pid(&id("a")).is_some());
    fx.host.hold(&[id("a")]).await;
    assert!(fx.host.pid(&id("a")).is_none(), "hold stops it");
    let before = fx.started();
    paused(fx.greet("a").await, "Plugin a");
    // By capability too, before any spawn; and its tools are not listed meanwhile.
    let args: Map<String, Value> = json!({"who": "Sam"}).as_object().unwrap().clone();
    let cap = fx
        .host
        .call_capability("demo.greet", args, CallCtx::default())
        .await
        .map(|_| ());
    paused(cap, "Plugin a");
    assert!(fx.host.tools().await.is_empty());
    assert_eq!(fx.started(), before, "no process started while held");
    assert!(fx.host.pid(&id("a")).is_none());
    fx.host.shutdown().await;
}

#[tokio::test]
async fn release_lets_it_spawn() {
    let r = root("release");
    plugin(&r, "a");
    let fx = Fx::start(&r, &store(), &["a"]).await;
    fx.host.hold(&[id("a")]).await;
    paused(fx.greet("a").await, "Plugin a");
    fx.host.release();
    fx.greet("a").await.unwrap();
    assert!(fx.host.pid(&id("a")).is_some());
    assert_eq!(fx.started(), 1);
    fx.host.shutdown().await;
}

#[tokio::test]
async fn call_racing_hold_does_not_spawn() {
    let r = root("race");
    plugin(&r, "a");
    let fx = Arc::new(Fx::start(&r, &store(), &["a"]).await);
    for round in 0..100 {
        fx.host.release();
        // Half the rounds start from a running process, half from a stopped one.
        if round % 2 == 0 {
            fx.greet("a").await.unwrap();
        }
        let call = tokio::spawn({
            let fx = fx.clone();
            async move { fx.greet("a").await }
        });
        fx.host.hold(&[id("a")]).await;
        // Either it ran before the stop (and may have lost its process to it), or it was
        // refused; it never leaves a process behind.
        let _ = call.await.unwrap();
        assert!(fx.host.pid(&id("a")).is_none(), "round {round}: respawned");
        paused(fx.greet("a").await, "Plugin a");
        assert!(fx.host.pid(&id("a")).is_none(), "round {round}");
    }
    fx.host.shutdown().await;
}
