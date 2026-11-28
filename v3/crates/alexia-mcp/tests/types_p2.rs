// SPDX-License-Identifier: AGPL-3.0-only
//! P2-02 shapes: host caps default, `HostedTool.reviewed`.

mod scratch;
use scratch::Scratch;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use alexia_mcp::{EventSink, HostConfig, McpHost, NoUpcalls, PluginId, Timings, Upcalls};
use alexia_store::{Layout, Store};
use serde_json::{json, Value};

const FIXTURE: &str = env!("CARGO_BIN_EXE_mcp-fixture");

fn plugin(dir: &Path, id: &str) {
    let path = dir.join(id);
    std::fs::create_dir_all(&path).unwrap();
    let exe = Path::new(FIXTURE).file_name().unwrap().to_str().unwrap();
    std::fs::copy(FIXTURE, path.join(exe)).unwrap();
    let m = json!({
        "manifest_version": 1, "id": id, "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.", "version": "0.1.0",
        "license": "AGPL-3.0-only", "entry": { "run": exe, "args": ["greet"] },
        "alexia_protocol": 2, "mcp_protocol": "2025-11-25"
    });
    std::fs::write(path.join("plugin.json"), m.to_string()).unwrap();
}

#[test]
fn no_upcalls_has_no_host_caps() {
    assert!(NoUpcalls.host_caps().is_empty());
}

#[tokio::test]
async fn unreviewed_list_marks_tools() {
    let root = Scratch::new("p2-02");
    let plugins = root.join("plugins");
    for id in ["alpha", "beta"] {
        plugin(&plugins, id);
    }
    let store = Arc::new(Store::open_in_memory().unwrap());
    store
        .kv_set("_core", "unreviewed", &Value::from(vec!["beta"]))
        .unwrap();
    let cfg = HostConfig {
        layout: Layout::new(root.join("data")),
        plugin_dirs: vec![plugins],
        node: PathBuf::from("node"),
        timings: Timings::default(),
        dial: None,
    };
    let sink: EventSink = Arc::new(|_| {});
    let host = McpHost::new(cfg, store, Arc::new(NoUpcalls), sink);
    let ids = [PluginId("alpha".into()), PluginId("beta".into())];
    host.start(&ids).await.unwrap();
    let tools = host.tools().await;
    for want in ["alpha", "beta"] {
        let mine: Vec<_> = tools.iter().filter(|t| t.plugin.0 == want).collect();
        assert!(!mine.is_empty(), "{want} listed no tools");
        assert!(
            mine.iter().all(|t| t.reviewed == (want != "beta")),
            "{want}"
        );
    }
    host.shutdown().await;
}
