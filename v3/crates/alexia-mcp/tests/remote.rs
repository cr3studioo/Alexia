// SPDX-License-Identifier: AGPL-3.0-only
//! P4-11: a `"run": "mesh"` server hosted through a `Dial`. The test `Dial` spawns
//! `mcp-fixture` and hands back its pipes, or answers `Offline` / `Refused` on demand.

mod scratch;
use scratch::Scratch;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_mcp::types::CallToolResult;
use alexia_mcp::{
    CallCtx, CallError, Dial, DialError, HostConfig, McpHost, NoUpcalls, PluginId, PluginState,
    Timings,
};
use alexia_store::{Layout, Store};
use serde_json::{json, Map};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const FIXTURE: &str = env!("CARGO_BIN_EXE_mcp-fixture");
const ONLINE: u8 = 0;
const OFFLINE: u8 = 1;
const REFUSED: u8 = 2;

/// The fixture as a remote: its args are the manifest's `entry.args`.
#[derive(Default)]
struct TestDial {
    mode: AtomicU8,
    dials: AtomicUsize,
    children: Mutex<Vec<Child>>,
}

impl TestDial {
    fn set(&self, mode: u8) {
        self.mode.store(mode, Ordering::SeqCst);
    }
    fn dials(&self) -> usize {
        self.dials.load(Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl Dial for TestDial {
    async fn dial(
        &self,
        id: &PluginId,
        args: &[String],
    ) -> Result<(ChildStdin, ChildStdout), DialError> {
        self.dials.fetch_add(1, Ordering::SeqCst);
        match self.mode.load(Ordering::SeqCst) {
            OFFLINE => return Err(DialError::Offline),
            REFUSED => return Err(DialError::Refused(format!("{} said no", id.0))),
            _ => {}
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

fn host(root: &Path, dial: Option<Arc<TestDial>>, store: Arc<Store>) -> McpHost {
    let cfg = HostConfig {
        layout: Layout::new(root.join("data")),
        plugin_dirs: vec![root.join("ext")],
        node: PathBuf::from("node"),
        timings: Timings::default(),
        dial: dial.map(|d| d as Arc<dyn Dial>),
    };
    McpHost::new(cfg, store, Arc::new(NoUpcalls), Arc::new(|_| {}))
}

/// A started host with the enabled mesh server `far` (the fixture's `greet` mode).
async fn far(root: &Path, dial: Option<Arc<TestDial>>) -> (McpHost, PluginId) {
    let h = host(root, dial, Arc::new(Store::open_in_memory().unwrap()));
    h.start(&[]).await.unwrap();
    let id = h
        .add_server("far", "Far away", "mesh", &["greet".to_owned()])
        .await
        .unwrap();
    h.set_enabled(&id, true).await.unwrap();
    (h, id)
}

fn state(h: &McpHost, id: &PluginId) -> (PluginState, Option<String>) {
    let p = h.plugins().into_iter().find(|p| &p.id == id).unwrap();
    (p.state, p.sentence)
}

async fn greet(h: &McpHost, id: &PluginId) -> Result<CallToolResult, CallError> {
    let mut args = Map::new();
    args.insert("who".into(), json!("mesh"));
    h.call_tool(id, "greet", args, CallCtx::default()).await
}

fn text(r: &CallToolResult) -> String {
    r.content[0]["text"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn mesh_server_lists_and_calls() {
    let root = Scratch::new("remote-calls");
    let dial = Arc::new(TestDial::default());
    let (h, id) = far(&root, Some(dial.clone())).await;

    let tools = h.tools().await;
    assert!(
        tools
            .iter()
            .any(|t| t.plugin == id && t.tool.name == "greet"),
        "{:?}",
        tools.iter().map(|t| &t.tool.name).collect::<Vec<_>>()
    );
    assert_eq!(text(&greet(&h, &id).await.unwrap()), "Hello, mesh.");
    assert_eq!(state(&h, &id).0, PluginState::Running);
    assert_eq!(h.pid(&id), Some(0), "a remote has no local process");
    assert_eq!(dial.dials(), 1, "one link, kept");

    // `stop` closes the pipes: the far end sees its stdin close and leaves.
    h.stop(&id).await;
    assert_eq!(state(&h, &id).0, PluginState::Stopped);
    let mut child = dial.children.lock().unwrap().pop().unwrap();
    let exited = tokio::time::timeout(Duration::from_secs(30), child.wait()).await;
    assert!(exited.is_ok(), "the remote end saw its pipes close");

    // The next call dials again.
    assert_eq!(text(&greet(&h, &id).await.unwrap()), "Hello, mesh.");
    assert_eq!(dial.dials(), 2);
    h.shutdown().await;
}

#[tokio::test]
async fn offline_is_stopped_not_unhealthy() {
    let root = Scratch::new("remote-offline");
    let dial = Arc::new(TestDial::default());
    dial.set(OFFLINE);
    let (h, id) = far(&root, Some(dial.clone())).await;

    for n in 1..=10 {
        match greet(&h, &id).await {
            Err(CallError::Off { sentence }) => {
                assert_eq!(sentence, "Far away is on a device that is offline.")
            }
            other => panic!("call {n}: expected Off, got {other:?}"),
        }
        let (s, sentence) = state(&h, &id);
        assert_eq!(s, PluginState::Stopped, "after offline dial {n}");
        assert!(sentence.is_some_and(|s| s.contains("offline")));
    }
    // Every call dialled: no backoff held any of them back, and the crash limit (3) never hit.
    assert_eq!(dial.dials(), 10);
    assert!(h.tools().await.is_empty(), "offline: no tools offered");
    assert_eq!(state(&h, &id).0, PluginState::Stopped);
    h.shutdown().await;
}

#[tokio::test]
async fn refused_counts_as_crash() {
    let root = Scratch::new("remote-refused");
    let dial = Arc::new(TestDial::default());
    dial.set(REFUSED);
    let (h, id) = far(&root, Some(dial.clone())).await;
    let limit = Timings::default().crash_limit as usize;

    for n in 1..=limit {
        match greet(&h, &id).await {
            // The last one comes back as the switched-off sentence.
            Err(CallError::Off { sentence }) if n < limit => {
                assert!(sentence.contains("far said no"), "call {n}: {sentence}")
            }
            Err(CallError::Off { .. }) => {}
            other => panic!("call {n}: expected Off, got {other:?}"),
        }
    }
    let (s, sentence) = state(&h, &id);
    assert_eq!(s, PluginState::Unhealthy);
    assert!(
        sentence
            .as_deref()
            .unwrap_or_default()
            .contains("switched it off"),
        "{sentence:?}"
    );
    assert_eq!(dial.dials(), limit);
    // Switched off: no more dials.
    assert!(greet(&h, &id).await.is_err());
    assert_eq!(dial.dials(), limit);
    h.shutdown().await;
}

#[tokio::test]
async fn restart_after_online() {
    let root = Scratch::new("remote-restart");
    let dial = Arc::new(TestDial::default());
    dial.set(OFFLINE);
    let (h, id) = far(&root, Some(dial.clone())).await;
    assert!(greet(&h, &id).await.is_err());
    assert_eq!(state(&h, &id).0, PluginState::Stopped);

    // The hub hears the device is back and restarts it: it is dialled now, not at next use.
    dial.set(ONLINE);
    let before = dial.dials();
    h.restart(&id).await.unwrap();
    assert_eq!(dial.dials(), before + 1);
    let (s, sentence) = state(&h, &id);
    assert_eq!(s, PluginState::Running);
    assert_eq!(sentence, None, "the offline sentence is gone");
    assert_eq!(text(&greet(&h, &id).await.unwrap()), "Hello, mesh.");
    assert_eq!(dial.dials(), before + 1, "the call used the restarted link");
    h.shutdown().await;
}

#[tokio::test]
async fn no_dial_configured_is_refused_with_sentence() {
    let root = Scratch::new("remote-nodial");
    let store = Arc::new(Store::open_in_memory().unwrap());
    let h = host(&root, None, store.clone());
    h.start(&[]).await.unwrap();
    // Accepted: `mesh` is not looked for on PATH.
    let id = h
        .add_server("far", "Far away", "mesh", &["greet".to_owned()])
        .await
        .unwrap();
    h.set_enabled(&id, true).await.unwrap();
    let sentence = "This device's link is not available here.";
    assert_eq!(
        state(&h, &id),
        (PluginState::Refused, Some(sentence.to_owned()))
    );
    match greet(&h, &id).await {
        Err(CallError::Off { sentence: s }) => assert_eq!(s, sentence),
        other => panic!("expected Off, got {other:?}"),
    }
    assert!(h.tools().await.is_empty());

    // Still refused when the host starts again with the server already on its list.
    h.shutdown().await;
    let again = host(&root, None, store);
    again.start(&[]).await.unwrap();
    assert_eq!(state(&again, &id).0, PluginState::Refused);
    again.shutdown().await;
}

#[tokio::test]
async fn tools_carry_device() {
    let root = Scratch::new("remote-device");
    let dial = Arc::new(TestDial::default());
    let (h, far_id) = far(&root, Some(dial)).await;
    // A local server next to it: the same fixture, run as a process.
    let near = h
        .add_server("near", "Near", FIXTURE, &["greet".to_owned()])
        .await
        .unwrap();
    h.set_enabled(&near, true).await.unwrap();

    let tools = h.tools().await;
    let of = |id: &PluginId| -> Vec<Option<String>> {
        tools
            .iter()
            .filter(|t| &t.plugin == id)
            .map(|t| t.device.clone())
            .collect()
    };
    let far_tools = of(&far_id);
    assert!(!far_tools.is_empty());
    assert!(far_tools.iter().all(|d| d.as_deref() == Some("far")));
    let near_tools = of(&near);
    assert!(!near_tools.is_empty());
    assert!(near_tools.iter().all(Option::is_none));
    h.shutdown().await;
}
