// SPDX-License-Identifier: AGPL-3.0-only
//! (P4-09) The limb's MCP face over a real link: an ephemeral hub node dials an ephemeral limb
//! node whose `accept_links` hands each link to `serve`, with the `mcp-fixture` binary as the
//! limb's one plugin under a scratch id. The hub side is driven by hand with JSON-RPC lines.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use alexia_mcp::{HostConfig, McpHost, NoUpcalls, PluginId, Timings};
use alexia_mesh::link::Link;
use alexia_mesh::node::{Node, NodeConfig};
use alexia_mesh::{DeviceId, MeshEvent, Reach, Role, KEYCHAIN_HUB, KEYCHAIN_LIMB};
use alexia_store::{DeviceRow, Layout, Store};
use serde_json::{json, Value};
use tokio::sync::broadcast;

// The binary's own modules, compiled into this test (a bin crate has no library to import).
#[allow(dead_code)]
#[path = "../src/cli.rs"]
mod cli;
#[allow(dead_code)]
#[path = "../src/serve.rs"]
mod serve;
#[allow(dead_code)]
#[path = "../src/service.rs"]
mod service;

/// Generous: a loaded Windows machine dialling over loopback and starting fresh processes.
const WAIT: Duration = Duration::from_secs(60);
/// The scratch id the fixture is installed under.
const ID: &str = "limb-fixture";

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
    let root = std::env::temp_dir().join(format!("alexia-limb-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    Root(root)
}

fn fixture_exe() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let path = exe
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .join(format!("mcp-fixture{}", std::env::consts::EXE_SUFFIX));
    if !path.is_file() {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let ok = std::process::Command::new(cargo)
            .args(["build", "-p", "alexia-mcp", "--bin", "mcp-fixture"])
            .status()
            .unwrap()
            .success();
        assert!(ok && path.is_file(), "could not build mcp-fixture");
    }
    path
}

/// The fixture in `mode`, installed in the limb's `extensions` folder as `ID`.
fn install_fixture(layout: &Layout, mode: &str) {
    let src = fixture_exe();
    let exe = src.file_name().unwrap().to_str().unwrap().to_string();
    let dir = layout.extensions().join(ID);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::copy(&src, dir.join(&exe)).unwrap();
    let m = json!({
        "manifest_version": 1, "id": ID, "name": "Limb fixture",
        "summary": "A plugin that exists for tests.", "version": "0.1.0",
        "license": "AGPL-3.0-only", "entry": { "run": exe, "args": [mode] },
        "alexia_protocol": 2, "mcp_protocol": "2025-11-25"
    });
    std::fs::write(dir.join("plugin.json"), m.to_string()).unwrap();
}

async fn start_node(role: Role, store: Arc<Store>) -> Arc<Node> {
    let cfg = NodeConfig {
        keychain: match role {
            Role::Hub => KEYCHAIN_HUB,
            Role::Limb => KEYCHAIN_LIMB,
        }
        .to_string(),
        name: format!("test {role:?}"),
        role,
        ephemeral: true,
        extra_addresses: vec![],
    };
    Node::start(cfg, store).await.expect("node starts")
}

fn row(id: &str, endpoint: &str, role: &str, hints: Value) -> DeviceRow {
    DeviceRow {
        id: id.into(),
        name: id.into(),
        endpoint: endpoint.into(),
        role: role.into(),
        platform: "test".into(),
        hello: json!({}),
        hints,
        paired_at: alexia_store::now_ms(),
        last_seen: None,
        revoked_at: None,
    }
}

/// Where `node` answers on this machine: its IPv4 socket's port on 127.0.0.1.
async fn loopback_hints(node: &Node) -> Value {
    let status = node.status().await.expect("status");
    let addresses: Vec<String> = status["boundAddresses"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|a| a.as_str()?.strip_prefix("0.0.0.0:"))
        .map(|port| format!("127.0.0.1:{port}"))
        .collect();
    assert!(!addresses.is_empty(), "an IPv4 socket: {status}");
    json!({ "directAddresses": addresses })
}

async fn wait_online(rx: &mut broadcast::Receiver<MeshEvent>, device: &str) {
    tokio::time::timeout(WAIT, async {
        loop {
            match rx.recv().await {
                Ok(MeshEvent::Online { device: d, reach }) if d.0 == device => {
                    assert_ne!(reach, Reach::Offline);
                    return;
                }
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(e) => panic!("events ended: {e}"),
            }
        }
    })
    .await
    .expect("the device comes online in time")
}

/// The hub's end of a link to a limb serving the fixture in `mode`, and the limb's host.
struct Env {
    link: Link,
    host: McpHost,
    layout: Layout,
    nodes: Vec<Arc<Node>>,
    /// Last, so the folder goes once the plugins have.
    _root: Root,
}

impl Env {
    async fn send(&self, v: Value) {
        self.link
            .tx
            .send(v.to_string())
            .await
            .expect("the link is open");
    }

    /// The next line the limb sent, as JSON.
    async fn next(&mut self) -> Value {
        let line = tokio::time::timeout(WAIT, self.link.rx.recv())
            .await
            .expect("a line in time")
            .expect("the link is open");
        serde_json::from_str(&line).expect("the limb sends JSON")
    }

    /// Lines until one matches `want`; the ones before it are returned too.
    async fn until(&mut self, want: impl Fn(&Value) -> bool) -> (Value, Vec<Value>) {
        let mut before = vec![];
        loop {
            let v = self.next().await;
            if want(&v) {
                return (v, before);
            }
            before.push(v);
        }
    }

    async fn request(&mut self, id: i64, method: &str, params: Value) -> Value {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await;
        self.until(|v| v["id"] == id).await.0
    }

    async fn call(&mut self, id: i64, name: &str, args: Value) -> Value {
        let r = self
            .request(id, "tools/call", json!({ "name": name, "arguments": args }))
            .await;
        r["result"].clone()
    }

    async fn tool_names(&mut self, id: i64) -> Vec<String> {
        let r = self.request(id, "tools/list", json!({})).await;
        r["result"]["tools"]
            .as_array()
            .expect("a tool list")
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect()
    }

    async fn done(self) {
        self.link.closed.cancel();
        self.host.shutdown().await;
        for node in self.nodes {
            node.close().await;
        }
    }
}

async fn env(tag: &str, mode: &str) -> Env {
    let root = root(tag);
    let layout = Layout::new(root.join("limb"));
    install_fixture(&layout, mode);

    let hub_store = Arc::new(Store::open_in_memory().unwrap());
    let limb_store = Arc::new(Store::open_in_memory().unwrap());
    let hub = start_node(Role::Hub, hub_store.clone()).await;
    let limb = start_node(Role::Limb, limb_store.clone()).await;
    let (limb_hints, hub_hints) = (loopback_hints(&limb).await, loopback_hints(&hub).await);
    hub_store
        .device_put(&row("l", &limb.endpoint().0, "limb", limb_hints))
        .unwrap();
    limb_store
        .device_put(&row("h", &hub.endpoint().0, "hub", hub_hints))
        .unwrap();
    hub.sync_allowlist().await.unwrap();
    limb.sync_allowlist().await.unwrap();
    let (mut hub_rx, mut limb_rx) = (hub.events(), limb.events());
    hub.connect(&DeviceId("l".into())).await.expect("connects");
    wait_online(&mut hub_rx, "l").await;
    wait_online(&mut limb_rx, "h").await;

    // The limb's pieces as `run` puts them together, with a slow machine's start time.
    let (changes, _) = broadcast::channel(16);
    let cfg = HostConfig {
        layout: Layout::new(layout.root.clone()),
        plugin_dirs: cli::plugin_dirs(&layout),
        node: PathBuf::from("node"),
        timings: Timings {
            start_ms: 60_000,
            exit_grace_ms: 8_000,
            ..Timings::default()
        },
        dial: None,
    };
    let host = McpHost::new(
        cfg,
        limb_store.clone(),
        Arc::new(NoUpcalls),
        serve::sink(changes.clone()),
    );
    cli::set_enabled(&limb_store, &[PluginId(ID.into())]).unwrap();
    host.start(&cli::enabled(&limb_store).unwrap())
        .await
        .unwrap();
    {
        let host = host.clone();
        limb.accept_links(move |_hub, link| {
            let facts = serve::Facts {
                device_name: "Test limb".into(),
                platform: cli::PLATFORM,
                changes: changes.clone(),
            };
            tokio::spawn(serve::serve(link, host.clone(), facts));
        })
        .await
        .expect("the limb serves links");
    }
    let link = tokio::time::timeout(WAIT, hub.dial(&DeviceId("l".into())))
        .await
        .expect("dial answers in time")
        .expect("dial succeeds");
    Env {
        link,
        host,
        layout,
        nodes: vec![hub, limb],
        _root: root,
    }
}

fn text(result: &Value) -> &str {
    result["content"][0]["text"].as_str().unwrap_or("")
}

#[tokio::test(flavor = "multi_thread")]
async fn initialize_and_list() {
    let mut e = env("list", "greet").await;
    let init = e
        .request(
            1,
            "initialize",
            json!({ "protocolVersion": "2025-11-25", "capabilities": {},
                    "clientInfo": { "name": "hub", "version": "0" } }),
        )
        .await;
    assert_eq!(init["result"]["serverInfo"]["name"], "alexia-limb");
    assert_eq!(init["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(init["result"]["capabilities"]["tools"]["listChanged"], true);
    e.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
        .await;

    let list = e.request(2, "tools/list", json!({})).await;
    let tools = list["result"]["tools"].as_array().expect("a tool list");
    let find = |name: &str| tools.iter().find(|t| t["name"] == name);
    let greet = find(format!("{ID}.greet").as_str()).expect("the plugin's tool, namespaced");
    assert_eq!(greet["_meta"]["alexia/provides"], json!(["demo.greet"]));
    assert!(greet["inputSchema"]["properties"]["who"].is_object());
    assert!(
        find(format!("{ID}.secret_tool").as_str()).is_none(),
        "a hidden tool stays hidden: {tools:?}"
    );
    let presence = find("device.presence").expect("the limb's own tool");
    assert_eq!(presence["annotations"]["readOnlyHint"], true);
    assert_eq!(
        presence["_meta"]["alexia/provides"],
        json!(["device.presence"])
    );

    let pong = e.request(3, "ping", json!({})).await;
    assert_eq!(pong["result"], json!({}));
    let nope = e.request(4, "resources/list", json!({})).await;
    assert_eq!(nope["error"]["code"], -32601);
    e.done().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn call_routes_to_plugin() {
    let mut e = env("call", "greet").await;
    let r = e
        .call(1, &format!("{ID}.greet"), json!({ "who": "Ana" }))
        .await;
    assert_eq!(text(&r), "Hello, Ana.");
    assert!(r["isError"].is_null() || r["isError"] == false);

    // Progress comes back under the hub's own token, before the answer.
    e.send(
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
        "name": format!("{ID}.greet"), "arguments": { "who": "progress" },
        "_meta": { "progressToken": "hub-7" } } }),
    )
    .await;
    let (answer, before) = e.until(|v| v["id"] == 2).await;
    assert_eq!(text(&answer["result"]), "Hello, progress.");
    let frames: Vec<&Value> = before
        .iter()
        .filter(|v| v["method"] == "notifications/progress")
        .collect();
    assert_eq!(frames.len(), 2, "both frames: {before:?}");
    assert!(frames
        .iter()
        .all(|f| f["params"]["progressToken"] == "hub-7"));

    let unknown = e.request(3, "tools/call", json!({ "name": "nodot" })).await;
    assert_eq!(unknown["error"]["code"], -32602);
    e.done().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn error_result_passes_through() {
    let mut e = env("error", "greet").await;
    let r = e.call(1, &format!("{ID}.nope"), json!({})).await;
    assert_eq!(r["isError"], true, "{r}");
    assert_eq!(text(&r), "unknown tool nope");
    e.done().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_reaches_plugin() {
    let mut e = env("cancel", "compute").await;
    // `crunch` reports progress first, then works until its time is up or it is cancelled.
    e.send(
        json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {
        "name": format!("{ID}.crunch"), "arguments": { "ms": 120_000 },
        "_meta": { "progressToken": 1 } } }),
    )
    .await;
    e.until(|v| v["method"] == "notifications/progress").await;
    e.send(
        json!({ "jsonrpc": "2.0", "method": "notifications/cancelled",
                   "params": { "requestId": 5, "reason": "test" } }),
    )
    .await;
    // The plugin writes this in its own folder when the cancel reaches it.
    let proof = e.layout.own_dir(ID).join("cancelled.txt");
    let reached = tokio::time::timeout(WAIT, async {
        while !proof.is_file() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
    assert!(reached.is_ok(), "the cancel reached the plugin");
    // A cancelled request gets no answer; the link still serves the next one.
    let pong = e.request(6, "ping", json!({})).await;
    assert_eq!(pong["result"], json!({}));
    e.done().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn list_changed_after_disable() {
    let mut e = env("changed", "greet").await;
    let names = e.tool_names(1).await;
    assert!(names.contains(&format!("{ID}.greet")), "{names:?}");
    e.host
        .set_enabled(&PluginId(ID.into()), false)
        .await
        .unwrap();
    e.until(|v| v["method"] == "notifications/tools/list_changed")
        .await;
    let names = e.tool_names(2).await;
    assert!(
        !names.iter().any(|n| n.starts_with(&format!("{ID}."))),
        "{names:?}"
    );
    assert!(names.contains(&"device.presence".to_string()));
    e.done().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn device_presence_tool_answers() {
    let mut e = env("presence", "greet").await;
    let r = e.call(1, "device.presence", json!({})).await;
    assert_eq!(r["content"][0]["type"], "text");
    assert!(!text(&r).is_empty());
    if r["isError"] != true {
        assert!(r["structuredContent"]["idleMs"].is_u64(), "{r}");
        assert!(r["structuredContent"]["locked"].is_boolean(), "{r}");
        assert_eq!(r["structuredContent"]["platform"], cli::PLATFORM);
    }
    e.done().await;
}

#[test]
fn cli_pair_parses_uri_errors() {
    let data = root("pair-cli");
    for bad in ["not a code", "alexia-pair:1?e=zz&c=a-b-c-d&a=&n=x"] {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_alexia-limb"))
            .args(["pair", bad])
            .env("ALEXIA_V3_DATA", &*data)
            .output()
            .expect("the limb runs");
        assert_eq!(out.status.code(), Some(1), "{bad}");
        let said = String::from_utf8_lossy(&out.stderr);
        assert!(
            said.contains(alexia_mesh::pair::BAD_URI),
            "a sentence for {bad}: {said}"
        );
        assert!(
            !data.join("limb").exists(),
            "a bad code opens nothing: {bad}"
        );
    }
}

#[test]
fn limb_data_is_not_hub_data() {
    let layout = cli::layout();
    assert!(layout.root.ends_with("limb"), "{}", layout.root.display());
    assert_ne!(layout.root, alexia_store::data_dir());
    assert_eq!(cli::plugin_dirs(&layout)[0], layout.extensions());
}
