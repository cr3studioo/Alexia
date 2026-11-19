// SPDX-License-Identifier: AGPL-3.0-only
//! Every v2 plugin, unchanged, through the Rust host (SP-11, EX-01).
//! Run with `--features v2-conformance` and `ALEXIA_V2_PLUGINS=<v2 checkout>/plugins`.
use alexia_mcp::{
    discover, CallCtx, CallError, HostConfig, HostedTool, McpHost, NoUpcalls, PluginId,
    PluginState, Timings,
};
use alexia_store::{Layout, Store};
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn v2_plugins() -> PathBuf {
    match std::env::var_os("ALEXIA_V2_PLUGINS") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => panic!("Set ALEXIA_V2_PLUGINS to a built v2 checkout's plugins folder."),
    }
}

fn node() -> PathBuf {
    std::env::var_os("ALEXIA_NODE").map_or_else(|| PathBuf::from("node"), PathBuf::from)
}

fn temp(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("alexia-v2-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

/// A host over `dirs` with every discovered plugin enabled, started.
async fn host(dirs: Vec<PathBuf>, name: &str) -> (McpHost, Vec<PluginId>, PathBuf) {
    std::env::set_var("ALEXIA_SECRETS_IN_MEMORY", "1");
    let ids: Vec<PluginId> = dirs
        .iter()
        .flat_map(|d| discover(d))
        .map(|r| {
            PluginId(
                r.unwrap_or_else(|(p, e)| panic!("{}: {e:?}", p.display()))
                    .manifest
                    .id,
            )
        })
        .collect();
    let root = temp(name);
    let cfg = HostConfig {
        layout: Layout::new(root.clone()),
        plugin_dirs: dirs,
        node: node(),
        timings: Timings {
            start_ms: 60_000,
            call_ms: 60_000,
            capability_ms: 60_000,
            // A deleted folder is noticed on the next ping; 5 s calls need it faster than 15 s.
            heartbeat_ms: 2_000,
            ..Timings::default()
        },
    };
    let store = Arc::new(Store::open_in_memory().unwrap());
    let host = McpHost::new(cfg, store, Arc::new(NoUpcalls), Arc::new(|_| {}));
    host.start(&ids).await.unwrap();
    (host, ids, root)
}

fn provider(tools: &[HostedTool], pick: impl Fn(&HostedTool) -> bool) -> Option<&PluginId> {
    tools.iter().find(|t| pick(t)).map(|t| &t.plugin)
}

fn args(v: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    v.as_object().unwrap().clone()
}

#[tokio::test]
async fn every_v2_plugin_lists_its_tools() {
    let dir = v2_plugins();
    let found = discover(&dir);
    assert!(!found.is_empty(), "no plugin found in {}", dir.display());
    let (host, ids, _) = host(vec![dir], "list").await;
    let tools = host.tools().await;
    let mut bad = vec![];
    println!("{:<16} {:>5}  state", "id", "tools");
    for st in host.plugins() {
        let n = tools.iter().filter(|t| t.plugin == st.id).count();
        println!("{:<16} {:>5}  {:?}", st.id.0, n, st.state);
        let broken = matches!(st.state, PluginState::Refused | PluginState::Unhealthy);
        if n == 0 || broken {
            let why = st.sentence.clone().unwrap_or_default();
            bad.push(format!(
                "{}: {why} (stderr: {:?})",
                st.id.0,
                host.log(&st.id)
            ));
        }
    }
    assert_eq!(host.plugins().len(), ids.len());
    host.shutdown().await;
    assert!(
        bad.is_empty(),
        "plugins that did not list tools:\n{}",
        bad.join("\n")
    );
}

#[tokio::test]
async fn capability_round_trip() {
    let (host, _, _) = host(vec![v2_plugins()], "cap").await;
    let tools = host.tools().await;
    assert!(
        provider(&tools, |t| t.provides.iter().any(|p| p == "demo.greet")).is_some(),
        "no plugin's tool lists demo.greet"
    );
    let r = host
        .call_capability(
            "demo.greet",
            args(serde_json::json!({"who": "Sam"})),
            CallCtx::default(),
        )
        .await
        .unwrap();
    let text = serde_json::to_string(&r.content).unwrap();
    assert!(text.contains("Sam"), "{text}");
    host.shutdown().await;
}

#[tokio::test]
async fn a_crashing_plugin_is_contained() {
    let (host, ids, _) = host(vec![v2_plugins()], "crash").await;
    let tools = host.tools().await;
    let listed: Vec<PluginId> = ids
        .iter()
        .filter(|i| tools.iter().any(|t| t.plugin == **i))
        .cloned()
        .collect();
    let crasher = provider(&tools, |t| {
        t.tool.name == "exit"
            && t.tool
                .description
                .as_deref()
                .is_some_and(|d| d.contains("Exits"))
    })
    .expect("no plugin has an `exit` tool that exits")
    .clone();
    let r = host
        .call_tool(&crasher, "exit", Default::default(), CallCtx::default())
        .await;
    assert!(matches!(r, Err(CallError::Gone)), "{r:?}");
    let after = host.tools().await;
    for id in listed.iter().filter(|i| **i != crasher) {
        assert!(after.iter().any(|t| t.plugin == *id), "{} vanished", id.0);
    }
    host.shutdown().await;
}

/// `link` → `target`: a directory junction on Windows, a symlink elsewhere.
fn link_dir(link: &Path, target: &Path) {
    #[cfg(windows)]
    let ok = std::process::Command::new("cmd")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(link)
        .arg(target)
        .output()
        .unwrap()
        .status
        .success();
    #[cfg(not(windows))]
    let ok = std::os::unix::fs::symlink(target, link).is_ok();
    assert!(
        ok,
        "could not link {} to {}",
        link.display(),
        target.display()
    );
}

fn copy_without_node_modules(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().map(Result::unwrap) {
        if e.file_name() == "node_modules" {
            continue;
        }
        let dest = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_without_node_modules(&e.path(), &dest);
        } else {
            std::fs::copy(e.path(), dest).unwrap();
        }
    }
}

#[tokio::test]
async fn a_vanishing_plugin_is_removed() {
    // Find the plugin with a `slow` tool using a throwaway host over the original folder.
    let orig = v2_plugins();
    let (probe, _, _) = host(vec![orig.clone()], "vprobe").await;
    let id = provider(&probe.tools().await, |t| t.tool.name == "slow")
        .expect("no plugin has a `slow` tool")
        .clone();
    probe.shutdown().await;
    let src = discover(&orig)
        .into_iter()
        .map(Result::unwrap)
        .find(|d| d.manifest.id == id.0)
        .unwrap()
        .path;

    let plugins = temp("vplugins");
    let copy = plugins.join(src.file_name().unwrap());
    copy_without_node_modules(&src, &copy);
    if src.join("node_modules").exists() {
        link_dir(&copy.join("node_modules"), &src.join("node_modules"));
    }

    let (host, _, _) = host(vec![plugins.clone()], "vanish").await;
    assert!(
        host.tools().await.iter().any(|t| t.plugin == id),
        "copy did not start"
    );
    let call = {
        let (host, id) = (host.clone(), id.clone());
        tokio::spawn(async move {
            host.call_tool(
                &id,
                "slow",
                args(serde_json::json!({"ms": 5000})),
                CallCtx::default(),
            )
            .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    std::fs::remove_dir_all(&copy).unwrap();
    let r = call.await.unwrap();
    assert!(matches!(r, Err(CallError::Gone)), "{r:?}");
    assert!(
        !host.tools().await.iter().any(|t| t.plugin == id),
        "still listed"
    );
    assert!(src.join("node_modules").exists() || !copy.exists());
    host.shutdown().await;
}
