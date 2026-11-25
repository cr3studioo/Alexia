// SPDX-License-Identifier: AGPL-3.0-only
//! P3-05: `McpHost::call_capability_all` against several `mcp-fixture` copies providing one
//! capability under scratch plugin ids.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use alexia_mcp::{CallCtx, EventSink, HostConfig, McpHost, NoUpcalls, PluginId, Timings};
use alexia_store::{Layout, Store};
use serde_json::{json, Map, Value};

const FIXTURE: &str = env!("CARGO_BIN_EXE_mcp-fixture");
const CAP: &str = "test.fanout";

/// A test's temp folder, removed when the test ends.
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
    let root = std::env::temp_dir().join(format!("alexia-fanout-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    Root(root)
}

/// `<root>/ext/<id>/plugin.json`: the fixture in `provide` mode with `extra` arguments.
fn plugin(root: &Path, id: &str, extra: &[&str]) {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let exe = Path::new(FIXTURE).file_name().unwrap().to_str().unwrap();
    if !bin.join(exe).exists() {
        std::fs::copy(FIXTURE, bin.join(exe)).unwrap();
    }
    let path = root.join("ext").join(id);
    std::fs::create_dir_all(&path).unwrap();
    let mut args = vec!["provide", "--cap", CAP];
    args.extend_from_slice(extra);
    let m = json!({
        "manifest_version": 1,
        "id": id,
        "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": format!("../../bin/{exe}"), "args": args },
        "alexia_protocol": 2,
        "mcp_protocol": "2025-11-25",
        "provides": [CAP]
    });
    std::fs::write(path.join("plugin.json"), m.to_string()).unwrap();
}

fn id(s: &str) -> PluginId {
    PluginId(s.into())
}

async fn host(root: &Path, on: &[&str]) -> McpHost {
    let sink: EventSink = Arc::new(|_| {});
    let cfg = HostConfig {
        layout: Layout::new(root.join("data")),
        plugin_dirs: vec![root.join("ext")],
        node: PathBuf::from("node"),
        // Cold starts of several fresh fixture copies on a loaded Windows machine are slow.
        timings: Timings {
            start_ms: 60_000,
            ..Timings::default()
        },
    };
    let store = Arc::new(Store::open_in_memory().unwrap());
    let host = McpHost::new(cfg, store, Arc::new(NoUpcalls), sink);
    let ids: Vec<PluginId> = on.iter().map(|s| id(s)).collect();
    host.start(&ids).await.unwrap();
    host
}

fn texts(results: &[alexia_mcp::types::CallToolResult]) -> Vec<String> {
    results
        .iter()
        .map(|r| {
            let v = serde_json::to_value(r).unwrap();
            v["content"][0]["text"].as_str().unwrap_or("").to_string()
        })
        .collect()
}

async fn all(host: &McpHost, per_call: Duration) -> Vec<String> {
    let args: Map<String, Value> = Map::new();
    texts(
        &host
            .call_capability_all(CAP, args, CallCtx::default(), per_call)
            .await,
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn all_providers_answer_in_order() {
    let root = root("order");
    // The first in order answers last: the output follows the order, not the finish.
    plugin(&root, "fan-a", &["--answer", "a", "--delay-ms", "400"]);
    plugin(&root, "fan-b", &["--answer", "b"]);
    plugin(&root, "fan-c", &["--answer", "c", "--delay-ms", "100"]);
    let host = host(&root, &["fan-a", "fan-b", "fan-c"]).await;
    assert_eq!(all(&host, Duration::from_secs(60)).await, ["a", "b", "c"]);
    host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn failing_and_slow_are_left_out() {
    let root = root("fail");
    plugin(&root, "fan-a", &["--answer", "a"]);
    plugin(&root, "fan-b", &["--fail"]);
    plugin(&root, "fan-c", &["--answer", "c", "--delay-ms", "30000"]);
    let host = host(&root, &["fan-a", "fan-b", "fan-c"]).await;
    // Start every process first (listing tools spawns them), so `per_call` measures the
    // answer, not a cold start.
    assert_eq!(host.tools().await.len(), 3);
    let per_call = Duration::from_secs(3);
    let began = Instant::now();
    assert_eq!(all(&host, per_call).await, ["a"]);
    assert!(
        began.elapsed() < per_call + Duration::from_secs(1),
        "took {:?}",
        began.elapsed()
    );
    host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn no_provider_is_empty() {
    let root = root("none");
    std::fs::create_dir_all(root.join("ext")).unwrap();
    let host = host(&root, &[]).await;
    assert!(all(&host, Duration::from_secs(5)).await.is_empty());
    host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn held_provider_is_skipped() {
    let root = root("held");
    plugin(&root, "fan-a", &["--answer", "a"]);
    plugin(&root, "fan-b", &["--answer", "b"]);
    plugin(&root, "fan-c", &["--answer", "c"]);
    let host = host(&root, &["fan-a", "fan-b", "fan-c"]).await;
    host.hold(&[id("fan-b")]).await;
    assert_eq!(all(&host, Duration::from_secs(60)).await, ["a", "c"]);
    host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn disabled_provider_is_skipped() {
    let root = root("off");
    plugin(&root, "fan-a", &["--answer", "a"]);
    plugin(&root, "fan-b", &["--answer", "b"]);
    plugin(&root, "fan-c", &["--answer", "c"]);
    let host = host(&root, &["fan-a", "fan-c"]).await;
    assert_eq!(all(&host, Duration::from_secs(60)).await, ["a", "c"]);
    host.shutdown().await;
}
