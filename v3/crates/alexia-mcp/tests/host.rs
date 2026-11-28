// SPDX-License-Identifier: AGPL-3.0-only
//! `McpHost` against the `mcp-fixture` binary in temp plugin folders.

mod scratch;
use scratch::Scratch;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alexia_mcp::{
    CallCtx, CallError, EventSink, HostConfig, McpHost, NoUpcalls, PluginEvent, PluginId,
    PluginState, Timings,
};
use alexia_store::{Layout, Store};
use serde_json::{json, Map, Value};

const FIXTURE: &str = env!("CARGO_BIN_EXE_mcp-fixture");
/// Large on purpose: a clean stop must not wait for it.
const GRACE_MS: u64 = 8_000;

fn root(tag: &str) -> Scratch {
    Scratch::new(tag)
}

/// `<dir>/<id>/plugin.json` running the fixture (copied in: `entry.run` is folder-relative).
fn plugin(dir: &Path, id: &str, args: &[&str], extra: Value) {
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
        "entry": { "run": exe, "args": args },
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

fn host(root: &Path, dirs: Vec<PathBuf>) -> Fx {
    let store = Arc::new(Store::open_in_memory().unwrap());
    let events = Arc::new(Mutex::new(vec![]));
    let sink: EventSink = {
        let events = events.clone();
        Arc::new(move |e| events.lock().unwrap().push(e))
    };
    let cfg = HostConfig {
        layout: Layout::new(root.join("data")),
        plugin_dirs: dirs,
        node: PathBuf::from("node"),
        timings: Timings {
            exit_grace_ms: GRACE_MS,
            ..Timings::default()
        },
        dial: None,
    };
    let host = McpHost::new(cfg, store.clone(), Arc::new(NoUpcalls), sink);
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

fn text(r: &alexia_mcp::types::CallToolResult) -> String {
    r.content[0]["text"].as_str().unwrap().to_string()
}

/// Whether a process with this pid still exists.
fn alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .unwrap()
            .success()
    }
}

async fn gone(pid: u32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    !alive(pid)
}

fn refused_sentence(fx: &Fx, plugin: &str) -> Option<String> {
    fx.events.lock().unwrap().iter().find_map(|e| match e {
        PluginEvent::Refused {
            plugin: p,
            sentence,
        } if p.0 == plugin => Some(sentence.clone()),
        _ => None,
    })
}

#[tokio::test]
async fn starts_with_no_plugins() {
    let r = root("none");
    let empty = r.join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    let fx = host(&r, vec![empty, r.join("missing")]);
    fx.host.start(&[]).await.unwrap();
    assert!(fx.host.plugins().is_empty());
    assert!(fx.host.tools().await.is_empty());
}

#[tokio::test]
async fn lists_tools_lazily() {
    let r = root("lazy");
    plugin(&r.join("ext"), "greet", &["greet"], json!({}));
    let fx = host(&r, vec![r.join("ext")]);
    fx.host.start(&[id("greet")]).await.unwrap();
    assert_eq!(fx.host.pid(&id("greet")), None);

    let tools = fx.host.tools().await;
    let pid = fx.host.pid(&id("greet")).expect("spawned by tools()");
    let names: Vec<&str> = tools.iter().map(|t| t.tool.name.as_str()).collect();
    assert_eq!(names, ["greet", "secret_tool"]);
    assert_eq!(tools[0].provides, ["demo.greet"]);
    assert!(!tools[0].hidden);
    assert!(tools[1].hidden);
    assert!(tools.iter().all(|t| t.plugin == id("greet")));

    assert_eq!(fx.host.tools().await.len(), 2);
    assert_eq!(fx.host.pid(&id("greet")), Some(pid));
    assert_eq!(fx.host.plugins()[0].state, PluginState::Running);
    fx.host.shutdown().await;
}

#[tokio::test]
async fn resident_spawns_at_start() {
    let r = root("resident");
    plugin(
        &r.join("ext"),
        "greet",
        &["greet"],
        json!({"lifetime": "resident"}),
    );
    let fx = host(&r, vec![r.join("ext")]);
    fx.host.start(&[id("greet")]).await.unwrap();
    let pid = fx.host.pid(&id("greet")).expect("resident runs at start");
    assert!(fx
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, PluginEvent::Started { pid: p, .. } if *p == pid)));
    fx.host.shutdown().await;
}

#[tokio::test]
async fn call_tool_round_trip() {
    let r = root("call");
    plugin(&r.join("ext"), "greet", &["greet"], json!({}));
    let fx = host(&r, vec![r.join("ext")]);
    fx.host.start(&[id("greet")]).await.unwrap();

    let out = fx
        .host
        .call_tool(
            &id("greet"),
            "greet",
            args(json!({"who": "Sam"})),
            CallCtx::default(),
        )
        .await
        .unwrap();
    assert_eq!(text(&out), "Hello, Sam.");

    let ctx = CallCtx {
        conversation: Some("7".into()),
        ..CallCtx::default()
    };
    let out = fx
        .host
        .call_tool(&id("greet"), "greet", args(json!({"who": "Kim"})), ctx)
        .await
        .unwrap();
    assert_eq!(text(&out), "Hello, Kim.");
    let got: Value = fx
        .host
        .log(&id("greet"))
        .iter()
        .filter_map(|l| l.strip_prefix("got "))
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .find(|v| v["params"]["arguments"]["who"] == "Kim")
        .expect("the fixture logged the call");
    assert_eq!(
        got["params"]["_meta"]["alexia/call-context"],
        json!({"conversationId": "7"})
    );
    fx.host.shutdown().await;
}

#[tokio::test]
async fn incompatible_is_refused_without_a_process() {
    let r = root("incompatible");
    plugin(
        &r.join("ext"),
        "future",
        &["greet"],
        json!({"alexia_protocol": 99}),
    );
    let fx = host(&r, vec![r.join("ext")]);
    fx.host.start(&[id("future")]).await.unwrap();
    let st = &fx.host.plugins()[0];
    assert_eq!(st.state, PluginState::Refused);
    assert!(st.sentence.as_deref().is_some_and(|s| !s.is_empty()));
    assert!(refused_sentence(&fx, "future").is_some_and(|s| s.contains("newer Alexia")));
    assert!(fx.host.tools().await.is_empty());
    assert_eq!(fx.host.pid(&id("future")), None);
    let err = fx
        .host
        .call_tool(&id("future"), "greet", Map::new(), CallCtx::default())
        .await
        .unwrap_err();
    assert!(matches!(err, CallError::Off { .. }));
    assert_eq!(fx.host.pid(&id("future")), None);
}

#[tokio::test]
async fn wrong_protocol_answer_is_refused() {
    let r = root("wrongproto");
    plugin(
        &r.join("ext"),
        "liar",
        &["greet", "--protocol", "2026-07-28"],
        json!({}),
    );
    let fx = host(&r, vec![r.join("ext")]);
    fx.host.start(&[id("liar")]).await.unwrap();
    assert!(fx.host.tools().await.is_empty());
    let st = &fx.host.plugins()[0];
    assert_eq!(st.state, PluginState::Refused);
    let sentence = refused_sentence(&fx, "liar").expect("a Refused event");
    assert!(sentence.contains("2026-07-28"), "{sentence}");
    assert_eq!(st.sentence.as_deref(), Some(sentence.as_str()));
    assert_eq!(fx.host.pid(&id("liar")), None);
    let started = fx.events.lock().unwrap().iter().find_map(|e| match e {
        PluginEvent::Started { pid, .. } => Some(*pid),
        _ => None,
    });
    assert_eq!(
        started, None,
        "a refused plugin is never announced as started"
    );
}

#[tokio::test]
async fn disabled_plugin_is_off() {
    let r = root("disabled");
    plugin(&r.join("ext"), "greet", &["greet"], json!({}));
    let fx = host(&r, vec![r.join("ext")]);
    fx.host.start(&[]).await.unwrap();
    let err = fx
        .host
        .call_tool(&id("greet"), "greet", Map::new(), CallCtx::default())
        .await
        .unwrap_err();
    assert!(matches!(err, CallError::Off { ref sentence } if sentence.contains("switched off")));
    assert!(fx.host.tools().await.is_empty());
    assert_eq!(fx.host.pid(&id("greet")), None);

    let err = fx
        .host
        .call_tool(&id("nobody"), "greet", Map::new(), CallCtx::default())
        .await
        .unwrap_err();
    assert!(matches!(err, CallError::Off { .. }));
}

#[tokio::test]
async fn first_folder_wins() {
    let r = root("first");
    plugin(&r.join("a"), "greet", &["greet"], json!({"name": "First"}));
    plugin(&r.join("b"), "greet", &["greet"], json!({"name": "Second"}));
    let fx = host(&r, vec![r.join("a"), r.join("b")]);
    fx.host.start(&[]).await.unwrap();
    let plugins = fx.host.plugins();
    assert_eq!(plugins.len(), 1);
    assert_eq!(plugins[0].name, "First");
}

#[tokio::test]
async fn declared_tables_are_created() {
    let r = root("tables");
    plugin(
        &r.join("ext"),
        "notes",
        &["storage"],
        json!({"storage": {"namespace": "notes", "tables": ["notes"]}}),
    );
    let fx = host(&r, vec![r.join("ext")]);
    fx.host.start(&[id("notes")]).await.unwrap();
    assert_eq!(fx.store.count("notes", "notes", None).unwrap(), 0);
}

#[tokio::test]
async fn shutdown_stops_everything() {
    let r = root("shutdown");
    let ext = r.join("ext");
    plugin(&ext, "one", &["greet"], json!({"lifetime": "resident"}));
    plugin(&ext, "two", &["greet"], json!({}));
    let fx = host(&r, vec![ext]);
    fx.host.start(&[id("one"), id("two")]).await.unwrap();
    fx.host.tools().await;
    let pids: Vec<u32> = ["one", "two"]
        .iter()
        .map(|p| fx.host.pid(&id(p)).expect("running"))
        .collect();

    let t = Instant::now();
    fx.host.shutdown().await;
    assert!(t.elapsed() < Duration::from_millis(GRACE_MS / 2));
    for p in ["one", "two"] {
        assert_eq!(fx.host.pid(&id(p)), None);
    }
    for pid in pids {
        assert!(gone(pid).await, "pid {pid} still running");
    }
}

/// `Conn` owns stdin, so the host must drop it before `process::stop`; otherwise every stop
/// waits the whole grace period and then kills.
#[tokio::test]
async fn clean_stop_is_quick_and_next_call_respawns() {
    let r = root("stop");
    plugin(&r.join("ext"), "greet", &["greet"], json!({}));
    let fx = host(&r, vec![r.join("ext")]);
    fx.host.start(&[id("greet")]).await.unwrap();
    fx.host.tools().await;
    let pid = fx.host.pid(&id("greet")).unwrap();

    let t = Instant::now();
    fx.host.stop(&id("greet")).await;
    let took = t.elapsed();
    assert!(
        took < Duration::from_millis(GRACE_MS / 4),
        "stop took {took:?} with a {GRACE_MS} ms grace"
    );
    assert_eq!(fx.host.pid(&id("greet")), None);
    assert!(gone(pid).await);
    assert!(fx
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, PluginEvent::Stopped { .. })));

    let out = fx
        .host
        .call_tool(
            &id("greet"),
            "greet",
            args(json!({"who": "again"})),
            CallCtx::default(),
        )
        .await
        .unwrap();
    assert_eq!(text(&out), "Hello, again.");
    assert!(fx.host.pid(&id("greet")).is_some_and(|p| p != pid));
    fx.host.shutdown().await;
}

#[tokio::test]
async fn set_enabled_switches_on_and_off() {
    let r = root("toggle");
    plugin(
        &r.join("ext"),
        "greet",
        &["greet"],
        json!({"lifetime": "resident"}),
    );
    let fx = host(&r, vec![r.join("ext")]);
    fx.host.start(&[]).await.unwrap();
    assert_eq!(fx.host.pid(&id("greet")), None);

    fx.host.set_enabled(&id("greet"), true).await.unwrap();
    assert!(fx.host.pid(&id("greet")).is_some());

    fx.host.set_enabled(&id("greet"), false).await.unwrap();
    assert_eq!(fx.host.pid(&id("greet")), None);
    assert!(fx.events.lock().unwrap().iter().any(|e| matches!(
        e,
        PluginEvent::Stopped {
            reason: alexia_mcp::StopReason::Disabled,
            ..
        }
    )));
    assert!(fx.host.set_enabled(&id("nobody"), true).await.is_err());
}

#[tokio::test]
async fn scratch_removed_after_host_dropped() {
    let r = root("dropped");
    let path = r.to_path_buf();
    plugin(&r.join("ext"), "greet", &["greet"], json!({}));
    let fx = host(&r, vec![r.join("ext")]);
    fx.host.start(&[id("greet")]).await.unwrap();
    fx.host.tools().await;
    assert!(
        fx.host.pid(&id("greet")).is_some(),
        "the fixture runs from the folder"
    );
    fx.host.shutdown().await;
    drop(fx);
    drop(r);
    assert!(!path.exists(), "{} was left behind", path.display());
}
