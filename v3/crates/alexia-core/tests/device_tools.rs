// SPDX-License-Identifier: AGPL-3.0-only
//! P4-13: a tool the hub's own plugin and limbs (or several limbs) offer is one tool with a
//! `device` argument. A local node plugin `files`, and `"run": "mesh"` servers (`laptop`,
//! `desk`) reached through a test `Dial`, each serving tools as a limb does (`files.read`).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

mod scratch;
use scratch::Scratch;

use alexia_core::permissions::{proactive, CallAsk};
use alexia_core::tools::McpTooling;
use alexia_core::{Origin, PermissionMode, Ruling, RunId, Scope, ToolCtx, ToolSpec, Tooling};
use alexia_mcp::{Dial, DialError, HostConfig, McpHost, NoUpcalls, PluginId, Timings};
use alexia_store::{Layout, SessionId, Store};
use serde_json::{json, Map, Value};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio_util::sync::CancellationToken;

/// One MCP server for every copy: `argv[2]` is a JSON file `{ id, tools: [Tool] }`. A call
/// answers `{ id, name, args }` as text, so a test sees which copy ran and what it was given.
const SERVER: &str = r#"
const cfg = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, serverInfo: { name: cfg.id, version: '0' }, capabilities: { tools: {} } } });
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: cfg.tools } });
  else if (m.method === 'tools/call') {
    const said = { id: cfg.id, name: m.params.name, args: m.params.arguments || {} };
    send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(said) }] } });
  } else send({ id: m.id, result: {} });
});
"#;

/// Spawns node with the manifest's `entry.args`; an id in `offline` answers `Offline`.
#[derive(Default)]
struct TestDial {
    offline: HashSet<String>,
    children: Mutex<Vec<Child>>,
}

#[async_trait::async_trait]
impl Dial for TestDial {
    async fn dial(
        &self,
        id: &PluginId,
        args: &[String],
    ) -> Result<(ChildStdin, ChildStdout), DialError> {
        if self.offline.contains(&id.0) {
            return Err(DialError::Offline);
        }
        let mut child = Command::new("node")
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

fn tool(name: &str, extra: Value) -> Value {
    let mut t = json!({
        "name": name,
        "description": format!("Does {name}."),
        "inputSchema": { "type": "object", "properties": { "path": { "type": "string" } } }
    });
    t.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    t
}

/// `<root>/ext/<id>/plugin.json` serving `tools`: local through node, or `"mesh"` through
/// the `Dial`.
fn plugin(root: &Path, id: &str, mesh: bool, tools: Vec<Value>) {
    let dir = root.join("ext").join(id);
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("server.js");
    std::fs::write(&script, SERVER).unwrap();
    let cfg = dir.join("tools.json");
    std::fs::write(&cfg, json!({ "id": id, "tools": tools }).to_string()).unwrap();
    let args = [script.to_str().unwrap(), cfg.to_str().unwrap()];
    let m = json!({
        "manifest_version": 1, "id": id, "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.", "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": if mesh { "mesh" } else { "node" }, "args": args },
        "alexia_protocol": 2, "mcp_protocol": "2025-11-25"
    });
    std::fs::write(dir.join("plugin.json"), m.to_string()).unwrap();
}

struct Env {
    host: McpHost,
    tooling: McpTooling,
    /// Last, so it drops after the host: the folder goes once its plugins have.
    _root: Scratch,
}

impl Env {
    async fn done(self) {
        self.host.shutdown().await;
    }
}

/// `(id, mesh, tools)` per plugin, all started; mesh ids in `offline` cannot be reached.
async fn env(tag: &str, plugins: Vec<(&str, bool, Vec<Value>)>, offline: &[&str]) -> Env {
    let root = Scratch::new(&format!("device-tools-{tag}"));
    let ids: Vec<PluginId> = plugins
        .iter()
        .map(|(id, ..)| PluginId(id.to_string()))
        .collect();
    for (id, mesh, tools) in plugins {
        plugin(&root, id, mesh, tools);
    }
    let dial = TestDial {
        offline: offline.iter().map(|s| s.to_string()).collect(),
        ..TestDial::default()
    };
    let cfg = HostConfig {
        layout: Layout::new(root.join("data")),
        plugin_dirs: vec![root.join("ext")],
        node: PathBuf::from("node"),
        // Cold node starts on a loaded Windows machine are slow.
        timings: Timings {
            start_ms: 60_000,
            call_ms: 60_000,
            exit_grace_ms: 8_000,
            ..Timings::default()
        },
        dial: Some(Arc::new(dial) as Arc<dyn Dial>),
    };
    let store = Arc::new(Store::open_in_memory().unwrap());
    let host = McpHost::new(cfg, store, Arc::new(NoUpcalls), Arc::new(|_| {}));
    host.start(&ids).await.unwrap();
    let tooling = McpTooling::new(host.clone(), vec![]);
    Env {
        host,
        tooling,
        _root: root,
    }
}

fn ctx() -> ToolCtx {
    ToolCtx {
        session: SessionId(7),
        run: RunId("r1".into()),
        origin: Origin::Desktop,
        background: false,
        progress: None,
        cancel: CancellationToken::new(),
    }
}

fn spec<'a>(specs: &'a [ToolSpec], name: &str) -> &'a ToolSpec {
    specs
        .iter()
        .find(|s| s.name == name)
        .unwrap_or_else(|| panic!("{name} not listed in {:?}", names(specs)))
}

fn names(specs: &[ToolSpec]) -> Vec<&str> {
    specs.iter().map(|s| s.name.as_str()).collect()
}

fn devices(s: &ToolSpec) -> Vec<&str> {
    s.params["properties"]["device"]["enum"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect()
}

/// What the copy that ran said: `{ id, name, args }`.
async fn call(e: &Env, name: &str, args: Value) -> Value {
    let args: Map<String, Value> = serde_json::from_value(args).unwrap();
    let out = e.tooling.call(name, args, ctx()).await;
    assert!(out.ok, "{name}: {}", out.text);
    serde_json::from_str(&out.text).unwrap()
}

/// The hub's `files` plugin and a laptop limb both serving `files.read`.
fn hub_and_laptop() -> Vec<(&'static str, bool, Vec<Value>)> {
    vec![
        ("files", false, vec![tool("read", json!({}))]),
        ("laptop", true, vec![tool("files.read", json!({}))]),
    ]
}

#[tokio::test]
async fn same_tool_on_two_devices_is_one() {
    let e = env("one", hub_and_laptop(), &[]).await;
    let specs = e.tooling.list().await;
    assert_eq!(
        names(&specs),
        vec!["files__read"],
        "one tool, not one per device"
    );
    let s = spec(&specs, "files__read");
    assert_eq!(devices(s), vec!["hub", "laptop"]);
    let device = &s.params["properties"]["device"];
    assert_eq!(device["type"], "string");
    assert_eq!(
        device["description"],
        "Which computer. Leave out for the one the owner is using."
    );
    assert_eq!(
        s.params["properties"]["path"]["type"], "string",
        "the tool's own arguments are kept"
    );
    assert_eq!(s.description, "Does read.", "the hub's description");
    assert_eq!(s.plugin, Some(PluginId("files".into())));
    e.done().await;
}

#[tokio::test]
async fn device_enum_lists_online_only() {
    let mut plugins = hub_and_laptop();
    plugins.push(("desk", true, vec![tool("files.read", json!({}))]));
    plugins.push(("attic", true, vec![tool("files.read", json!({}))]));
    let e = env("online", plugins, &["attic"]).await;
    let specs = e.tooling.list().await;
    let s = spec(&specs, "files__read");
    assert_eq!(
        devices(s),
        vec!["hub", "desk", "laptop"],
        "attic is offline"
    );
    assert!(
        !names(&specs).iter().any(|n| n.contains("files.read")),
        "no copy is listed on its own: {:?}",
        names(&specs)
    );
    e.done().await;

    // Two limbs and no hub copy: still one tool, without `hub`.
    let e = env(
        "online-limbs",
        vec![
            ("laptop", true, vec![tool("files.read", json!({}))]),
            ("desk", true, vec![tool("files.read", json!({}))]),
        ],
        &[],
    )
    .await;
    let specs = e.tooling.list().await;
    assert_eq!(names(&specs), vec!["files__read"]);
    assert_eq!(devices(spec(&specs, "files__read")), vec!["desk", "laptop"]);
    assert_eq!(
        call(&e, "files__read", json!({ "device": "laptop" })).await["id"],
        "laptop"
    );
    e.done().await;
}

#[tokio::test]
async fn device_arg_routes_and_is_stripped() {
    let e = env("routes", hub_and_laptop(), &[]).await;
    e.tooling.list().await;
    let said = call(
        &e,
        "files__read",
        json!({ "device": "laptop", "path": "a.txt" }),
    )
    .await;
    assert_eq!(said["id"], "laptop");
    assert_eq!(said["name"], "files.read", "the limb's own tool name");
    assert_eq!(
        said["args"],
        json!({ "path": "a.txt" }),
        "device is not passed on"
    );

    let said = call(
        &e,
        "files__read",
        json!({ "device": "hub", "path": "b.txt" }),
    )
    .await;
    assert_eq!(said["id"], "files");
    assert_eq!(said["name"], "read");
    assert_eq!(said["args"], json!({ "path": "b.txt" }));

    let out = e
        .tooling
        .call(
            "files__read",
            serde_json::from_value(json!({ "device": "moon" })).unwrap(),
            ctx(),
        )
        .await;
    assert!(!out.ok);
    assert_eq!(
        out.text,
        "files__read is not on moon. It is on: hub, laptop."
    );
    e.done().await;
}

#[tokio::test]
async fn no_device_uses_preference() {
    let provides = json!({ "_meta": { "alexia/provides": ["files.read"] } });
    let e = env(
        "prefer",
        vec![
            ("files", false, vec![tool("read", provides.clone())]),
            ("laptop", true, vec![tool("files.read", provides)]),
        ],
        &[],
    )
    .await;
    e.tooling.list().await;
    assert_eq!(
        call(&e, "files__read", json!({})).await["id"],
        "files",
        "no preference: the hub's own copy"
    );

    let seen = Arc::new(Mutex::new(Vec::<(String, Vec<PluginId>)>::new()));
    let s = seen.clone();
    e.tooling
        .set_prefer(Arc::new(move |cap: &str, ids: &[PluginId]| {
            s.lock().unwrap().push((cap.to_owned(), ids.to_vec()));
            vec![PluginId("nobody".into()), PluginId("laptop".into())]
        }));
    let said = call(&e, "files__read", json!({ "path": "c" })).await;
    assert_eq!(said["id"], "laptop", "the owner is on the laptop");
    assert_eq!(said["args"], json!({ "path": "c" }));
    assert_eq!(
        seen.lock().unwrap()[0],
        (
            "files.read".to_owned(),
            vec![PluginId("files".into()), PluginId("laptop".into())]
        ),
        "asked with the capability and the copies, the hub's first"
    );
    // A named device wins over the preference.
    assert_eq!(
        call(&e, "files__read", json!({ "device": "hub" })).await["id"],
        "files"
    );
    e.done().await;
}

#[tokio::test]
async fn single_remote_tool_keeps_device_name() {
    let mut plugins = hub_and_laptop();
    plugins[1].2.push(tool("notes.list", json!({})));
    let e = env("single", plugins, &[]).await;
    let specs = e.tooling.list().await;
    let s = spec(&specs, "laptop__notes.list");
    assert!(
        s.params["properties"].get("device").is_none(),
        "one device: nothing to choose"
    );
    assert!(!names(&specs).contains(&"notes__list"));
    let said = call(&e, "laptop__notes.list", json!({ "path": "d" })).await;
    assert_eq!(said["id"], "laptop");
    assert_eq!(said["name"], "notes.list");
    assert_eq!(said["args"], json!({ "path": "d" }));
    e.done().await;
}

#[tokio::test]
async fn merged_annotations_are_cautious() {
    let safe = json!({ "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false });
    let e = env(
        "cautious",
        vec![
            (
                "files",
                false,
                vec![
                    tool("read", json!({ "annotations": safe })),
                    tool("write", json!({ "annotations": { "destructiveHint": false, "openWorldHint": false } })),
                ],
            ),
            (
                "laptop",
                true,
                vec![
                    tool("files.read", json!({ "annotations": { "readOnlyHint": true, "destructiveHint": false, "openWorldHint": true } })),
                    tool("files.write", json!({})),
                ],
            ),
        ],
        &[],
    )
    .await;
    let specs = e.tooling.list().await;
    let read = spec(&specs, "files__read").annotations.clone().unwrap();
    assert_eq!(read.read_only_hint, Some(true), "read only on both");
    assert_eq!(read.destructive_hint, Some(false));
    assert_eq!(
        read.open_world_hint,
        Some(true),
        "open world on one is open world"
    );
    let write = spec(&specs, "files__write").annotations.clone().unwrap();
    assert_eq!(
        write.destructive_hint,
        Some(true),
        "a copy that says nothing is destructive (MCP's default)"
    );
    assert_eq!(write.open_world_hint, Some(true));
    assert_eq!(write.read_only_hint, None, "neither says: still unsaid");
    e.done().await;
}

#[tokio::test]
async fn permission_sees_real_target() {
    let local = json!({ "annotations": { "destructiveHint": false, "openWorldHint": false } });
    let e = env(
        "permission",
        vec![
            ("files", false, vec![tool("write", local.clone())]),
            ("laptop", true, vec![tool("files.write", local)]),
        ],
        &[],
    )
    .await;
    let specs = e.tooling.list().await;
    let s = spec(&specs, "files__write");
    let args = |v: Value| serde_json::from_value::<Map<String, Value>>(v).unwrap();

    let to_laptop = e
        .tooling
        .target("files__write", &args(json!({ "device": "laptop" })))
        .await;
    assert_eq!(to_laptop, "laptop__files.write");
    let to_hub = e
        .tooling
        .target("files__write", &args(json!({ "device": "hub" })))
        .await;
    assert_eq!(to_hub, "files__write");
    e.tooling.set_prefer(Arc::new(|_: &str, _: &[PluginId]| {
        vec![PluginId("laptop".into())]
    }));
    assert_eq!(
        e.tooling.target("files__write", &args(json!({}))).await,
        "laptop__files.write",
        "no device: the one the preference picks"
    );
    assert_eq!(
        e.tooling.target("laptop__other", &args(json!({}))).await,
        "laptop__other",
        "a name that is not merged is itself"
    );

    // The owner let her write on the laptop unasked, not on the hub.
    let scope = Scope {
        mode: PermissionMode::AskRisky,
        roots: vec![],
        everywhere: false,
        boundaries: vec![],
        data_dir: PathBuf::from("data"),
        silent: vec!["laptop__files.write".into()],
        local_only: false,
        guest_tools: vec![],
    };
    let ruling = |tool: &str| {
        let ask = CallAsk {
            tool,
            words: &s.words,
            annotations: s.annotations.as_ref(),
            paths: vec![],
            reviewed: s.reviewed,
        };
        proactive(&ask, &scope, Ruling::Run)
    };
    assert_eq!(ruling(&to_laptop), Ruling::Run);
    assert!(matches!(ruling(&to_hub), Ruling::Ask(_)));
    // And the call goes where the ruling looked.
    let said = call(&e, "files__write", json!({})).await;
    assert_eq!(said["id"], "laptop");
    tokio::time::timeout(Duration::from_secs(60), e.done())
        .await
        .unwrap();
}
