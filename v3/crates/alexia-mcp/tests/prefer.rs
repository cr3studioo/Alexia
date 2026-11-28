// SPDX-License-Identifier: AGPL-3.0-only
//! P4-12: the order single capability calls try providers in. Two local `mcp-fixture` copies
//! (`a`, `b`) and one `"run": "mesh"` copy (`far`) reached through a test `Dial`, all providing
//! one capability and each answering with its own id.

mod scratch;
use scratch::Scratch;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alexia_mcp::types::CallToolResult;
use alexia_mcp::{
    CallCtx, CallError, Dial, DialError, HostConfig, McpHost, NoUpcalls, PluginId, Timings,
};
use alexia_store::{Layout, Store};
use serde_json::{json, Map, Value};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const FIXTURE: &str = env!("CARGO_BIN_EXE_mcp-fixture");
const CAP: &str = "test.prefer";
const LOCAL: [&str; 2] = ["a", "b"];
const FAR: &str = "far";

/// Spawns the fixture with the manifest's `entry.args`, or answers `Offline`.
#[derive(Default)]
struct TestDial {
    offline: AtomicBool,
    dials: AtomicUsize,
    children: Mutex<Vec<Child>>,
}

impl TestDial {
    fn dials(&self) -> usize {
        self.dials.load(Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl Dial for TestDial {
    async fn dial(
        &self,
        _id: &PluginId,
        args: &[String],
    ) -> Result<(ChildStdin, ChildStdout), DialError> {
        self.dials.fetch_add(1, Ordering::SeqCst);
        if self.offline.load(Ordering::SeqCst) {
            return Err(DialError::Offline);
        }
        let mut child = Command::new(FIXTURE)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| DialError::Refused(e.to_string()))?;
        let pipes = (child.stdin.take().unwrap(), child.stdout.take().unwrap());
        self.children.lock().unwrap().push(child);
        Ok(pipes)
    }
}

/// `<root>/ext/<id>/plugin.json`: the fixture providing `CAP` and answering `id`; run through
/// the `Dial` when `mesh`.
fn plugin(root: &Path, id: &str, mesh: bool) {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let exe = Path::new(FIXTURE).file_name().unwrap().to_str().unwrap();
    if !bin.join(exe).exists() {
        std::fs::copy(FIXTURE, bin.join(exe)).unwrap();
    }
    let path = root.join("ext").join(id);
    std::fs::create_dir_all(&path).unwrap();
    let run = if mesh {
        "mesh".to_owned()
    } else {
        format!("../../bin/{exe}")
    };
    let m = json!({
        "manifest_version": 1,
        "id": id,
        "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": run, "args": ["provide", "--cap", CAP, "--answer", id] },
        "alexia_protocol": 2,
        "mcp_protocol": "2025-11-25",
        "provides": [CAP]
    });
    std::fs::write(path.join("plugin.json"), m.to_string()).unwrap();
}

/// A plugin that only asks for `CAP` (never started: its requests come from `serve_for_test`).
fn asker(root: &Path) {
    let path = root.join("ext").join("asker");
    std::fs::create_dir_all(&path).unwrap();
    let m = json!({
        "manifest_version": 1,
        "id": "asker",
        "name": "Asker",
        "summary": "A plugin that exists for tests.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": "unused" },
        "alexia_protocol": 2,
        "mcp_protocol": "2025-11-25",
        "requires": [{ "cap": CAP, "why": "To test." }]
    });
    std::fs::write(path.join("plugin.json"), m.to_string()).unwrap();
}

fn id(s: &str) -> PluginId {
    PluginId(s.into())
}

/// A started host with `a`, `b` and `far` enabled.
async fn host(root: &Path, dial: Arc<TestDial>) -> McpHost {
    for l in LOCAL {
        plugin(root, l, false);
    }
    plugin(root, FAR, true);
    asker(root);
    let cfg = HostConfig {
        layout: Layout::new(root.join("data")),
        plugin_dirs: vec![root.join("ext")],
        node: PathBuf::from("node"),
        // Cold starts of several fixture copies on a loaded Windows machine are slow.
        timings: Timings {
            start_ms: 60_000,
            ..Timings::default()
        },
        dial: Some(dial as Arc<dyn Dial>),
    };
    let store = Arc::new(Store::open_in_memory().unwrap());
    let h = McpHost::new(cfg, store, Arc::new(NoUpcalls), Arc::new(|_| {}));
    h.start(&[id("a"), id("b"), id(FAR)]).await.unwrap();
    h
}

/// Tries providers in reverse resolution order.
fn reverse(h: &McpHost) {
    h.set_prefer(Arc::new(|cap: &str, ids: &[PluginId]| {
        assert_eq!(cap, CAP);
        ids.iter().rev().cloned().collect()
    }));
}

fn text(r: &CallToolResult) -> String {
    r.content[0]["text"].as_str().unwrap().to_owned()
}

async fn call(h: &McpHost) -> String {
    text(
        &h.call_capability(CAP, Map::new(), CallCtx::default())
            .await
            .unwrap(),
    )
}

#[tokio::test]
async fn default_order_unchanged() {
    let root = Scratch::new("prefer-default");
    let dial = Arc::new(TestDial::default());
    let h = host(&root, dial.clone()).await;
    assert_eq!(call(&h).await, "a", "the lowest id, as before P4-12");
    assert_eq!(dial.dials(), 0, "nothing further down the order is reached");
    h.shutdown().await;
}

#[tokio::test]
async fn prefer_reorders() {
    let root = Scratch::new("prefer-reorders");
    let dial = Arc::new(TestDial::default());
    let h = host(&root, dial.clone()).await;
    let seen = Arc::new(Mutex::new(Vec::<Vec<PluginId>>::new()));
    let s = seen.clone();
    h.set_prefer(Arc::new(move |_: &str, ids: &[PluginId]| {
        s.lock().unwrap().push(ids.to_vec());
        ids.iter().rev().cloned().collect()
    }));
    assert_eq!(call(&h).await, FAR);
    assert_eq!(dial.dials(), 1);
    assert_eq!(
        seen.lock().unwrap()[0],
        vec![id("a"), id("b"), id(FAR)],
        "the policy is handed resolution order"
    );

    // One it leaves out is still tried after the ones it names; one it makes up is not.
    h.set_prefer(Arc::new(|_: &str, _: &[PluginId]| {
        vec![id("nobody"), id("b")]
    }));
    assert_eq!(call(&h).await, "b");
    h.stop(&id("b")).await;
    h.set_enabled(&id("b"), false).await.unwrap();
    assert_eq!(
        call(&h).await,
        "a",
        "the first left out, in resolution order"
    );
    h.shutdown().await;
}

#[tokio::test]
async fn device_argument_routes() {
    let root = Scratch::new("prefer-device");
    let dial = Arc::new(TestDial::default());
    let h = host(&root, dial.clone()).await;
    let ask = |device: &str| {
        let params = json!({ "cap": CAP, "arguments": { "device": device } });
        let h = h.clone();
        async move {
            let v: Value = h
                .serve_for_test(&id("asker"), "alexia/capability/call", params)
                .await
                .unwrap();
            v["content"][0]["text"].as_str().unwrap().to_owned()
        }
    };
    assert_eq!(ask(FAR).await, FAR, "a device beats resolution order");
    assert_eq!(ask("hub").await, "a", "the hub is the local plugins");

    // A device with no provider is an error, not another device's answer.
    let params = json!({ "cap": CAP, "arguments": { "device": "elsewhere" } });
    let e = h
        .serve_for_test(&id("asker"), "alexia/capability/call", params)
        .await
        .unwrap_err();
    assert!(e.message.contains("elsewhere"), "{}", e.message);
    h.shutdown().await;
}

#[tokio::test]
async fn offline_provider_skipped_quickly() {
    let root = Scratch::new("prefer-offline");
    let dial = Arc::new(TestDial::default());
    dial.offline.store(true, Ordering::SeqCst);
    let h = host(&root, dial.clone()).await;
    reverse(&h);
    // The first call finds `far` offline and starts `b` cold.
    assert_eq!(call(&h).await, "b");
    assert_eq!(dial.dials(), 1);

    let began = Instant::now();
    assert_eq!(call(&h).await, "b", "the online one answers");
    assert!(
        began.elapsed() < Duration::from_secs(1),
        "took {:?}",
        began.elapsed()
    );
    assert_eq!(dial.dials(), 1, "not dialled again within 30 s");

    match h
        .call_capability_on(CAP, FAR, Map::new(), CallCtx::default())
        .await
    {
        Err(CallError::Off { sentence }) => assert!(sentence.contains(FAR), "{sentence}"),
        other => panic!("{other:?}"),
    }
    assert_eq!(dial.dials(), 1, "naming the device does not dial it either");

    // `restart` still dials: once it is back, capability calls reach it again.
    dial.offline.store(false, Ordering::SeqCst);
    h.restart(&id(FAR)).await.unwrap();
    assert_eq!(dial.dials(), 2);
    assert_eq!(call(&h).await, FAR);
    h.shutdown().await;
}

#[tokio::test]
async fn call_capability_on_hub_means_local() {
    let root = Scratch::new("prefer-hub");
    let dial = Arc::new(TestDial::default());
    let h = host(&root, dial.clone()).await;
    reverse(&h);
    let r = h
        .call_capability_on(CAP, "hub", Map::new(), CallCtx::default())
        .await
        .unwrap();
    assert_eq!(
        text(&r),
        "b",
        "the preferred local one, never the mesh server"
    );
    assert_eq!(dial.dials(), 0);
    let r = h
        .call_capability_on(CAP, FAR, Map::new(), CallCtx::default())
        .await
        .unwrap();
    assert_eq!(text(&r), FAR);

    let a = h.answers(CAP);
    assert!(a.answers && a.here);
    h.shutdown().await;
}

#[tokio::test]
async fn fanout_ignores_prefer() {
    let root = Scratch::new("prefer-fanout");
    let dial = Arc::new(TestDial::default());
    let h = host(&root, dial.clone()).await;
    reverse(&h);
    let got = h
        .call_capability_all(CAP, Map::new(), CallCtx::default(), Duration::from_secs(60))
        .await;
    let got: Vec<String> = got.iter().map(text).collect();
    assert_eq!(got, ["a", "b", FAR], "resolution order, not the preference");
    h.shutdown().await;
}
