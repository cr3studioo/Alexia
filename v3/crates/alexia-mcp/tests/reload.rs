// SPDX-License-Identifier: AGPL-3.0-only
//! Hot reload (EX-12, P2-23): a changed manifest is re-read without a hub restart, in-flight
//! calls finish first, a bad manifest keeps the old version, and a reload is not a crash.

mod scratch;
use scratch::Scratch;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alexia_mcp::{
    CallCtx, EventSink, HostConfig, McpHost, NoUpcalls, PluginEvent, PluginId, PluginState,
    StopReason, Timings,
};
use alexia_store::{Layout, Store};
use serde_json::{json, Map, Value};

const FIXTURE: &str = env!("CARGO_BIN_EXE_mcp-fixture");

fn root(tag: &str) -> Scratch {
    Scratch::new(tag)
}

/// Writes `<root>/ext/<id>/plugin.json` running the fixture in `mode`, at `version`.
fn plugin(root: &Path, id: &str, mode: &str, version: &str, extra: Value) {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let exe = Path::new(FIXTURE).file_name().unwrap().to_str().unwrap();
    if !bin.join(exe).exists() {
        std::fs::copy(FIXTURE, bin.join(exe)).unwrap();
    }
    let path = root.join("ext").join(id);
    std::fs::create_dir_all(&path).unwrap();
    let mut m = json!({
        "manifest_version": 1,
        "id": id,
        "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.",
        "version": version,
        "license": "AGPL-3.0-only",
        "entry": { "run": format!("../../bin/{exe}"), "args": [mode] },
        "alexia_protocol": 2,
        "mcp_protocol": "2025-11-25"
    });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(path.join("plugin.json"), m.to_string()).unwrap();
}

type Log = Arc<Mutex<Vec<PluginEvent>>>;

struct Fx {
    host: McpHost,
    events: Log,
}

impl Fx {
    fn new(root: &Path, heartbeat_ms: u64) -> Fx {
        let events: Log = Arc::default();
        let sink: EventSink = {
            let events = events.clone();
            Arc::new(move |e| events.lock().unwrap().push(e))
        };
        let cfg = HostConfig {
            layout: Layout::new(root.join("data")),
            plugin_dirs: vec![root.join("ext")],
            node: PathBuf::from("node"),
            timings: Timings {
                heartbeat_ms,
                idle_ms: 600_000,
                backoff_ms: 50,
                exit_grace_ms: 2_000,
                ..Timings::default()
            },
        };
        let store = Arc::new(Store::open_in_memory().unwrap());
        Fx {
            host: McpHost::new(cfg, store, Arc::new(NoUpcalls), sink),
            events,
        }
    }

    fn count(&self, f: impl Fn(&PluginEvent) -> bool) -> usize {
        self.events.lock().unwrap().iter().filter(|e| f(e)).count()
    }

    async fn call(&self, plugin: &str, tool: &str, a: Value) -> Result<String, String> {
        let args: Map<String, Value> = a.as_object().unwrap().clone();
        let r = self
            .host
            .call_tool(&id(plugin), tool, args, CallCtx::default())
            .await
            .map_err(|e| format!("{e:?}"))?;
        Ok(r.content[0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string())
    }

    async fn tool_names(&self, plugin: &str) -> Vec<String> {
        self.host
            .tools()
            .await
            .into_iter()
            .filter(|t| t.plugin.0 == plugin)
            .map(|t| t.tool.name)
            .collect()
    }

    fn status(&self, plugin: &str) -> alexia_mcp::PluginStatus {
        self.host
            .plugins()
            .into_iter()
            .find(|p| p.id.0 == plugin)
            .unwrap()
    }
}

fn id(s: &str) -> PluginId {
    PluginId(s.into())
}

fn tools_changed(e: &PluginEvent) -> bool {
    matches!(e, PluginEvent::ToolsChanged { .. })
}

fn started(e: &PluginEvent) -> bool {
    matches!(e, PluginEvent::Started { .. })
}

async fn eventually(secs: u64, mut f: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if f() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    f()
}

#[tokio::test]
async fn manifest_change_reloads() {
    let r = root("change");
    plugin(&r, "p", "greet", "0.1.0", json!({}));
    let fx = Fx::new(&r, 60_000);
    fx.host.start(&[id("p")]).await.unwrap();
    assert!(fx.tool_names("p").await.contains(&"greet".to_string()));
    let old_pid = fx.host.pid(&id("p")).unwrap();

    plugin(&r, "p", "undoable", "0.2.0", json!({}));
    fx.host.reload(&id("p")).await.unwrap();

    assert_eq!(fx.status("p").version, "0.2.0");
    assert_eq!(fx.status("p").state, PluginState::Stopped);
    // Lazy: the next call spawns the new version, with the new tool list.
    let names = fx.tool_names("p").await;
    assert!(names.contains(&"set".to_string()), "{names:?}");
    assert!(!names.contains(&"greet".to_string()), "{names:?}");
    assert_ne!(fx.host.pid(&id("p")).unwrap(), old_pid);
    fx.host.shutdown().await;
}

#[tokio::test]
async fn in_flight_call_finishes() {
    let r = root("inflight");
    plugin(&r, "p", "vanish", "0.1.0", json!({})); // has `slow`
    let fx = Fx::new(&r, 60_000);
    fx.host.start(&[id("p")]).await.unwrap();
    let call = {
        let host = fx.host.clone();
        tokio::spawn(async move {
            let args = json!({"ms": 1500}).as_object().unwrap().clone();
            host.call_tool(&id("p"), "slow", args, CallCtx::default())
                .await
        })
    };
    // Wait until the call is really on the process.
    assert!(eventually(30, || fx.host.pid(&id("p")).is_some()).await);
    tokio::time::sleep(Duration::from_millis(300)).await;
    plugin(&r, "p", "greet", "0.2.0", json!({}));
    let reload = {
        let host = fx.host.clone();
        tokio::spawn(async move { host.reload(&id("p")).await })
    };
    assert!(eventually(30, || fx.status("p").state == PluginState::Reloading).await);
    // A call made now waits for the swap and gets the new version.
    let new = fx.call("p", "greet", json!({"who": "x"})).await;
    let done = call.await.unwrap().unwrap();
    assert_eq!(
        done.content[0]["text"], "done",
        "the old call ran to the end"
    );
    reload.await.unwrap().unwrap();
    assert!(new.is_ok(), "{new:?}");
    assert_eq!(fx.status("p").version, "0.2.0");
    fx.host.shutdown().await;
}

#[tokio::test]
async fn bad_manifest_keeps_old() {
    let r = root("bad");
    plugin(&r, "p", "greet", "0.1.0", json!({}));
    let fx = Fx::new(&r, 60_000);
    fx.host.start(&[id("p")]).await.unwrap();
    assert!(fx.tool_names("p").await.contains(&"greet".to_string()));
    let pid = fx.host.pid(&id("p")).unwrap();

    std::fs::write(r.join("ext/p/plugin.json"), "{ this is not json").unwrap();
    let err = fx.host.reload(&id("p")).await.unwrap_err();
    let st = fx.status("p");
    assert_eq!(st.state, PluginState::Running);
    assert_eq!(st.version, "0.1.0");
    assert_eq!(st.sentence.as_deref(), Some(err.to_string().as_str()));
    assert!(!err.to_string().is_empty());
    assert_eq!(fx.host.pid(&id("p")), Some(pid), "the old process was kept");
    assert_eq!(
        fx.count(|e| matches!(e, PluginEvent::Refused { .. })),
        0,
        "no Refused event"
    );
    assert!(fx.call("p", "greet", json!({"who": "x"})).await.is_ok());

    // Fixing it reloads.
    plugin(&r, "p", "greet", "0.3.0", json!({}));
    fx.host.reload(&id("p")).await.unwrap();
    assert_eq!(fx.status("p").version, "0.3.0");
    assert_eq!(fx.status("p").sentence, None);
    fx.host.shutdown().await;
}

#[tokio::test]
async fn resident_respawns() {
    let r = root("resident");
    plugin(&r, "p", "greet", "0.1.0", json!({"lifetime": "resident"}));
    let fx = Fx::new(&r, 60_000);
    fx.host.start(&[id("p")]).await.unwrap();
    let old_pid = fx.host.pid(&id("p")).unwrap();
    assert_eq!(fx.count(started), 1);

    plugin(
        &r,
        "p",
        "undoable",
        "0.2.0",
        json!({"lifetime": "resident"}),
    );
    fx.host.reload(&id("p")).await.unwrap();

    // No call made: it comes back on its own.
    assert!(eventually(30, || fx.count(started) == 2).await);
    assert!(eventually(30, || fx.host.pid(&id("p")).is_some()).await);
    assert_ne!(fx.host.pid(&id("p")).unwrap(), old_pid);
    assert!(fx.tool_names("p").await.contains(&"set".to_string()));
    fx.host.shutdown().await;
}

#[tokio::test]
async fn tools_changed_emitted() {
    let r = root("tools");
    plugin(&r, "p", "greet", "0.1.0", json!({}));
    // A short heartbeat: the watcher's own scan must find the change, nobody calls reload.
    let fx = Fx::new(&r, 200);
    fx.host.start(&[id("p")]).await.unwrap();
    fx.tool_names("p").await;
    let before = fx.count(tools_changed);

    plugin(&r, "p", "undoable", "0.2.0", json!({}));
    assert!(eventually(60, || fx.count(tools_changed) > before).await);
    assert!(eventually(60, || fx.status("p").version == "0.2.0").await);
    assert!(fx.tool_names("p").await.contains(&"set".to_string()));
    fx.host.shutdown().await;
}

#[tokio::test]
async fn reload_is_not_a_crash() {
    let r = root("nocrash");
    plugin(&r, "p", "greet", "0.1.0", json!({}));
    let fx = Fx::new(&r, 60_000);
    fx.host.start(&[id("p")]).await.unwrap();
    fx.tool_names("p").await;

    for v in ["0.2.0", "0.3.0", "0.4.0"] {
        plugin(&r, "p", "greet", v, json!({}));
        fx.host.reload(&id("p")).await.unwrap();
        fx.tool_names("p").await;
    }
    assert_eq!(fx.count(|e| matches!(e, PluginEvent::Crashed { .. })), 0);
    assert_eq!(fx.count(|e| matches!(e, PluginEvent::Unhealthy { .. })), 0);
    assert_eq!(
        fx.count(|e| matches!(
            e,
            PluginEvent::Stopped {
                reason: StopReason::Disabled,
                ..
            }
        )),
        3
    );
    assert_eq!(fx.status("p").state, PluginState::Running);
    fx.host.shutdown().await;
}
