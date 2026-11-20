// SPDX-License-Identifier: AGPL-3.0-only
//! `McpHost::manifests` (P2-45): the enabled, non-refused plugins' folder and manifest,
//! read from what `start`/`reload` loaded. Nothing is spawned.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use alexia_mcp::{HostConfig, McpHost, NoUpcalls, PluginId, Timings};
use alexia_store::{Layout, Store};
use serde_json::{json, Value};

fn root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("alexia-manifests-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// Writes `<root>/ext/<id>/plugin.json`: a non-resident plugin, so nothing ever spawns.
fn plugin(root: &Path, id: &str, version: &str, extra: Value) {
    let path = root.join("ext").join(id);
    std::fs::create_dir_all(&path).unwrap();
    let mut m = json!({
        "manifest_version": 1,
        "id": id,
        "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.",
        "version": version,
        "license": "AGPL-3.0-only",
        "entry": { "run": "../../bin/never-run", "args": [] },
        "alexia_protocol": 2,
        "mcp_protocol": "2025-11-25"
    });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(path.join("plugin.json"), m.to_string()).unwrap();
}

fn host(root: &Path) -> McpHost {
    let cfg = HostConfig {
        layout: Layout::new(root.join("data")),
        plugin_dirs: vec![root.join("ext")],
        node: PathBuf::from("node"),
        timings: Timings::default(),
    };
    let store = Arc::new(Store::open_in_memory().unwrap());
    McpHost::new(cfg, store, Arc::new(NoUpcalls), Arc::new(|_| {}))
}

fn id(s: &str) -> PluginId {
    PluginId(s.into())
}

fn ids(host: &McpHost) -> Vec<String> {
    host.manifests()
        .into_iter()
        .map(|d| d.manifest.id)
        .collect()
}

#[tokio::test]
async fn manifests_lists_enabled_only() {
    let r = root("enabled");
    let cmds =
        json!({"commands": [{"name": "hello", "summary": "Says hello."}], "skills": ["skills"]});
    plugin(&r, "b", "0.1.0", cmds);
    plugin(&r, "a", "0.1.0", json!({}));
    plugin(&r, "off", "0.1.0", json!({}));
    let h = host(&r);
    h.start(&[id("a"), id("b")]).await.unwrap();

    assert_eq!(ids(&h), ["a", "b"], "enabled only, in id order");
    let b = &h.manifests()[1];
    assert_eq!(b.path, r.join("ext").join("b"));
    assert_eq!(b.manifest.commands[0].name, "hello");
    assert_eq!(b.manifest.skills, ["skills"]);
}

#[tokio::test]
async fn refused_plugin_not_listed() {
    let r = root("refused");
    plugin(&r, "ok", "0.1.0", json!({}));
    // Needs a newer Alexia than this build: refused at start.
    plugin(&r, "future", "0.1.0", json!({"min_app": "999.0.0"}));
    let h = host(&r);
    h.start(&[id("ok"), id("future")]).await.unwrap();

    assert_eq!(ids(&h), ["ok"]);
    assert!(
        h.plugins().iter().any(|p| p.id.0 == "future"),
        "still loaded, just refused"
    );
}

#[tokio::test]
async fn disabled_drops_out() {
    let r = root("disabled");
    plugin(&r, "a", "0.1.0", json!({}));
    plugin(&r, "b", "0.1.0", json!({}));
    let h = host(&r);
    h.start(&[id("a"), id("b")]).await.unwrap();
    assert_eq!(ids(&h), ["a", "b"]);

    h.set_enabled(&id("a"), false).await.unwrap();
    assert_eq!(ids(&h), ["b"]);
    h.set_enabled(&id("a"), true).await.unwrap();
    assert_eq!(ids(&h), ["a", "b"]);
}

#[tokio::test]
async fn reload_shows_new_manifest() {
    let r = root("reload");
    plugin(&r, "p", "0.1.0", json!({}));
    let h = host(&r);
    h.start(&[id("p")]).await.unwrap();
    assert_eq!(h.manifests()[0].manifest.version, "0.1.0");
    assert!(h.manifests()[0].manifest.commands.is_empty());

    plugin(
        &r,
        "p",
        "0.2.0",
        json!({"commands": [{"name": "later", "summary": "Added by the new version."}]}),
    );
    h.reload(&id("p")).await.unwrap();

    let m = &h.manifests()[0].manifest;
    assert_eq!(m.version, "0.2.0");
    assert_eq!(m.commands[0].name, "later");
}

#[tokio::test]
async fn manifests_spawns_nothing() {
    let r = root("nospawn");
    plugin(&r, "p", "0.1.0", json!({}));
    let h = host(&r);
    h.start(&[id("p")]).await.unwrap();
    for _ in 0..3 {
        assert_eq!(ids(&h), ["p"]);
    }
    assert_eq!(h.pid(&id("p")), None);
}
