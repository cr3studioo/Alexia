// SPDX-License-Identifier: AGPL-3.0-only
//! P2-22: `alexia/compute/run` on this machine, and capability calls that fall through to the
//! host, against the `mcp-fixture` binary.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use alexia_mcp::jsonrpc::RpcError;
use alexia_mcp::types::{CallToolResult, ClientCapabilities, CreateMessageParams, Root};
use alexia_mcp::{
    EventSink, HostConfig, HostFacts, McpHost, NoUpcalls, PluginId, ProgressSink, Timings, Upcalls,
};
use alexia_store::{secrets, Layout, Store};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

const FIXTURE: &str = env!("CARGO_BIN_EXE_mcp-fixture");
const NOT_AVAILABLE: i32 = -32050;
const NOT_PERMITTED: i32 = -32051;
const INVALID_PARAMS: i32 = -32602;

fn root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("alexia-compute-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn plugin(dir: &Path, id: &str, mode: &str, extra: Value) {
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
        "entry": { "run": exe, "args": [mode] },
        "alexia_protocol": 13,
        "mcp_protocol": "2025-11-25"
    });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(path.join("plugin.json"), m.to_string()).unwrap();
}

fn id(s: &str) -> PluginId {
    PluginId(s.into())
}

fn requires(cap: &str) -> Value {
    json!({"requires": [{"cap": cap, "why": "To test."}]})
}

/// Core answering `demo.core` itself, and claiming `demo.greet` as well.
struct Core;

#[async_trait::async_trait]
impl Upcalls for Core {
    fn offers(&self, p: &PluginId) -> ClientCapabilities {
        NoUpcalls.offers(p)
    }
    fn host_facts(&self) -> HostFacts {
        NoUpcalls.host_facts()
    }
    async fn sample(
        &self,
        p: &PluginId,
        params: CreateMessageParams,
        progress: Option<ProgressSink>,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        NoUpcalls.sample(p, params, progress, cancel).await
    }
    async fn elicit(&self, p: &PluginId, params: Value) -> Result<Value, RpcError> {
        NoUpcalls.elicit(p, params).await
    }
    async fn roots(&self, _: &PluginId) -> Vec<Root> {
        vec![]
    }
    fn host_caps(&self) -> Vec<String> {
        vec!["demo.core".into(), "demo.greet".into()]
    }
    async fn host_call(
        &self,
        _: &PluginId,
        cap: &str,
        _: Map<String, Value>,
        _: CancellationToken,
    ) -> Option<Result<CallToolResult, RpcError>> {
        let said = format!("core answered {cap}");
        let result = json!({"content": [{"type": "text", "text": said}]});
        Some(Ok(serde_json::from_value(result).unwrap()))
    }
}

struct Fx {
    host: McpHost,
    store: Arc<Store>,
    layout: Layout,
}

async fn start(root: &Path, enabled: &[&str], up: Arc<dyn Upcalls>) -> Fx {
    std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
    let store = Arc::new(Store::open_in_memory().unwrap());
    let sink: EventSink = Arc::new(|_| {});
    let cfg = HostConfig {
        layout: Layout::new(root.join("data")),
        plugin_dirs: vec![root.join("ext")],
        node: PathBuf::from("node"),
        timings: Timings::default(),
    };
    let host = McpHost::new(cfg, store.clone(), up, sink);
    let enabled: Vec<PluginId> = enabled.iter().map(|s| id(s)).collect();
    host.start(&enabled).await.unwrap();
    Fx {
        host,
        store,
        layout: Layout::new(root.join("data")),
    }
}

async fn serve(fx: &Fx, plugin: &str, method: &str, params: Value) -> Result<Value, RpcError> {
    fx.host.serve_for_test(&id(plugin), method, params).await
}

/// A worker declaring `demo.compute`, a caller allowed to ask for it, and a stranger.
async fn compute_fx(tag: &str) -> Fx {
    let root = root(tag);
    let ext = root.join("ext");
    plugin(
        &ext,
        "worker",
        "compute",
        json!({
            "provides": ["demo.compute"],
            "compute": {"operations": [{"cap": "demo.compute", "summary": "Writes a file."}]}
        }),
    );
    plugin(&ext, "asker", "greet", requires("demo.compute"));
    plugin(&ext, "stranger", "greet", json!({}));
    start(&root, &["worker", "asker", "stranger"], Arc::new(NoUpcalls)).await
}

fn input(name: &str, path: &Path) -> Value {
    json!({"name": name, "path": path.to_string_lossy(), "mime": "text/plain"})
}

#[tokio::test]
async fn compute_runs_declared_operation() {
    let fx = compute_fx("runs").await;
    let own = fx.layout.own_dir("asker");
    std::fs::create_dir_all(&own).unwrap();
    let file_in = own.join("in.txt");
    std::fs::write(&file_in, "x").unwrap();
    let params = json!({
        "cap": "demo.compute",
        "arguments": {"text": "hello"},
        "inputs": [input("in", &file_in)]
    });
    let out = serve(&fx, "asker", "alexia/compute/run", params)
        .await
        .unwrap();
    // The worker saw the op in `_meta["alexia/compute"]` and the one input.
    assert_eq!(out["text"], "ran \"demo.compute\" with 1 inputs");
    let files = out["files"].as_array().unwrap();
    assert_eq!(files.len(), 1);
    let file = Path::new(files[0].as_str().unwrap());
    assert!(
        file.starts_with(&own),
        "{file:?} is not in the caller's own dir"
    );
    assert_eq!(std::fs::read_to_string(file).unwrap(), "hello");
    fx.host.shutdown().await;
}

#[tokio::test]
async fn compute_undeclared_refused() {
    let fx = compute_fx("undeclared").await;
    // Neither declares the op nor requires it.
    let e = serve(
        &fx,
        "stranger",
        "alexia/compute/run",
        json!({"cap": "demo.compute"}),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, NOT_PERMITTED);
    // Allowed to ask, but nothing installed declares it.
    let e = serve(
        &fx,
        "worker",
        "alexia/compute/run",
        json!({"cap": "demo.other"}),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, NOT_PERMITTED);
    let root = root("undeclared-none");
    plugin(
        &root.join("ext"),
        "lonely",
        "greet",
        requires("demo.compute"),
    );
    let lone = start(&root, &["lonely"], Arc::new(NoUpcalls)).await;
    let e = serve(
        &lone,
        "lonely",
        "alexia/compute/run",
        json!({"cap": "demo.compute"}),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, NOT_AVAILABLE);
    fx.host.shutdown().await;
}

#[tokio::test]
async fn input_outside_refused() {
    let fx = compute_fx("outside").await;
    let own = fx.layout.own_dir("asker");
    std::fs::create_dir_all(&own).unwrap();
    let elsewhere = root("outside-file").join("secret.txt");
    std::fs::write(&elsewhere, "no").unwrap();
    let run = |path: PathBuf| {
        let params = json!({"cap": "demo.compute", "inputs": [input("s", &path)]});
        let fx = &fx;
        async move { serve(fx, "asker", "alexia/compute/run", params).await }
    };
    assert_eq!(
        run(elsewhere.clone()).await.unwrap_err().code,
        INVALID_PARAMS
    );
    // Another plugin's folder is outside too.
    let theirs = fx.layout.own_dir("worker");
    std::fs::create_dir_all(&theirs).unwrap();
    std::fs::write(theirs.join("x.txt"), "no").unwrap();
    assert_eq!(
        run(theirs.join("x.txt")).await.unwrap_err().code,
        INVALID_PARAMS
    );
    // `..` out of the caller's own folder lands in the other plugin's.
    let sneaky = own.join("..").join("worker").join("x.txt");
    assert_eq!(run(sneaky).await.unwrap_err().code, INVALID_PARAMS);
    // A file that does not exist cannot be proven inside.
    assert_eq!(
        run(own.join("missing.txt")).await.unwrap_err().code,
        INVALID_PARAMS
    );
    fx.host.shutdown().await;
}

#[tokio::test]
async fn host_call_used_when_no_plugin() {
    let dir = root("hostcall");
    plugin(&dir.join("ext"), "asker", "greet", requires("demo.core"));
    let fx = start(&dir, &["asker"], Arc::new(Core)).await;
    let out = serve(
        &fx,
        "asker",
        "alexia/capability/call",
        json!({"cap": "demo.core"}),
    )
    .await
    .unwrap();
    assert_eq!(out["content"][0]["text"], "core answered demo.core");
    // And with nobody at all, still -32050.
    let dir2 = root("nobody");
    plugin(
        &dir2.join("ext"),
        "asker",
        "greet",
        requires("demo.nothing"),
    );
    let bare = start(&dir2, &["asker"], Arc::new(NoUpcalls)).await;
    let e = serve(
        &bare,
        "asker",
        "alexia/capability/call",
        json!({"cap": "demo.nothing"}),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, NOT_AVAILABLE);
    fx.host.shutdown().await;
}

#[tokio::test]
async fn plugin_wins_over_host() {
    let root = root("pluginwins");
    let ext = root.join("ext");
    plugin(
        &ext,
        "greeter",
        "greet",
        json!({"provides": ["demo.greet"]}),
    );
    plugin(&ext, "asker", "greet", requires("demo.greet"));
    let fx = start(&root, &["greeter", "asker"], Arc::new(Core)).await;
    let params = json!({"cap": "demo.greet", "arguments": {"who": "Sam"}});
    let out = serve(&fx, "asker", "alexia/capability/call", params)
        .await
        .unwrap();
    assert_eq!(out["content"][0]["text"], "Hello, Sam.");
    fx.host.shutdown().await;
}

#[tokio::test]
async fn answers_counts_host_caps() {
    let root = root("answers");
    plugin(&root.join("ext"), "asker", "greet", json!({}));
    let fx = start(&root, &["asker"], Arc::new(Core)).await;
    assert!(fx.host.answers("demo.core").answers);
    assert!(!fx.host.answers("demo.nothing").answers);
    let out = serve(&fx, "asker", "alexia/answers", json!({"cap": "demo.core"}))
        .await
        .unwrap();
    assert_eq!(out["answers"], true);
}

#[tokio::test]
async fn unreadable_reviewed_list_fails_closed() {
    let root = root("reviewed");
    let ext = root.join("ext");
    plugin(&ext, "a", "greet", json!({}));
    plugin(&ext, "b", "greet", json!({}));
    let fx = start(&root, &["a", "b"], Arc::new(NoUpcalls)).await;
    // Nothing recorded: everyone is reviewed.
    let tools = fx.host.tools().await;
    assert!(!tools.is_empty() && tools.iter().all(|t| t.reviewed));
    // Malformed: everyone is unreviewed, not reviewed.
    let bad = json!({"not": "a list"});
    fx.store.kv_set("_core", "unreviewed", &bad).unwrap();
    let tools = fx.host.tools().await;
    assert!(!tools.is_empty() && tools.iter().all(|t| !t.reviewed));
    // Well-formed again: only the listed plugin is unreviewed.
    fx.store
        .kv_set("_core", "unreviewed", &json!(["a"]))
        .unwrap();
    let tools = fx.host.tools().await;
    assert!(tools.iter().all(|t| t.reviewed == (t.plugin.0 != "a")));
    fx.host.shutdown().await;
}

/// A Node worker (the fixture binary can't report the paths it was given or return custom
/// links). It records `arguments.inputs` to `seen.json` in its own folder, then answers by
/// `arguments.mode`: `twins` links two same-named files, `half` links one real and one missing.
const WORKER_JS: &str = r#"
const fs = require('fs'), path = require('path');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const link = (p) => ({ type: 'resource_link', uri: 'file:///' + p.split(path.sep).join('/'), name: path.basename(p) });
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result });
  if (req.method === 'initialize') {
    return reply({ protocolVersion: '2025-11-25', serverInfo: { name: 'w', version: '0' }, capabilities: { tools: {} } });
  }
  if (req.method === 'tools/list') {
    return reply({ tools: [{ name: 'render', inputSchema: { type: 'object' }, _meta: { 'alexia/compute': { op: 'demo.compute' } } }] });
  }
  if (req.method === 'tools/call') {
    const args = req.params.arguments || {};
    fs.writeFileSync('seen.json', JSON.stringify(args.inputs || []));
    const put = (dir, name, text) => {
      fs.mkdirSync(dir, { recursive: true });
      const p = path.resolve(dir, name);
      fs.writeFileSync(p, text);
      return p;
    };
    const content = [];
    if (args.mode === 'twins') {
      content.push(link(put('a', 'out.png', 'first')), link(put('b', 'out.png', 'second')));
    } else if (args.mode === 'half') {
      content.push(link(put('a', 'ok.png', 'ok')), link(path.resolve('gone.png')));
    }
    return reply({ content });
  }
  send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'no' } });
});
"#;

async fn node_worker_fx(tag: &str) -> Fx {
    let root = root(tag);
    let ext = root.join("ext");
    plugin(
        &ext,
        "worker",
        "compute",
        json!({
            "provides": ["demo.compute"],
            "compute": {"operations": [{"cap": "demo.compute", "summary": "Writes files."}]},
            "entry": {"run": "node", "args": ["worker.js"]}
        }),
    );
    std::fs::write(ext.join("worker").join("worker.js"), WORKER_JS).unwrap();
    plugin(&ext, "asker", "greet", requires("demo.compute"));
    start(&root, &["worker", "asker"], Arc::new(NoUpcalls)).await
}

fn compute_params(mode: &str, inputs: Vec<Value>) -> Value {
    json!({"cap": "demo.compute", "arguments": {"mode": mode}, "inputs": inputs})
}

fn compute_dirs(own: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(own.join("compute"))
        .map(|d| d.map(|e| e.unwrap().path()).collect())
        .unwrap_or_default()
}

#[tokio::test]
async fn compute_uses_the_checked_path() {
    let fx = node_worker_fx("checked").await;
    let own = fx.layout.own_dir("asker");
    let real_dir = own.join("real");
    std::fs::create_dir_all(&real_dir).unwrap();
    std::fs::write(real_dir.join("in.txt"), "x").unwrap();
    // A junction (no privileges needed) inside the caller's own folder.
    let junction = own.join("via");
    let made = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&junction)
        .arg(&real_dir)
        .output()
        .unwrap();
    assert!(made.status.success(), "mklink /J failed: {made:?}");
    let given = junction.join("in.txt");
    let direct = real_dir.join("in.txt");
    let params = compute_params("none", vec![input("a", &given), input("b", &direct)]);
    serve(&fx, "asker", "alexia/compute/run", params)
        .await
        .unwrap();
    let seen = std::fs::read_to_string(fx.layout.own_dir("worker").join("seen.json")).unwrap();
    let seen: Vec<Value> = serde_json::from_str(&seen).unwrap();
    let canonical = std::fs::canonicalize(&direct).unwrap();
    assert_eq!(seen.len(), 2);
    for s in &seen {
        assert_eq!(Path::new(s["path"].as_str().unwrap()), canonical);
    }
    assert!(!seen[0]["path"].as_str().unwrap().contains("via"));
    fx.host.shutdown().await;
}

#[tokio::test]
async fn same_name_outputs_both_kept() {
    let fx = node_worker_fx("twins").await;
    let out = serve(
        &fx,
        "asker",
        "alexia/compute/run",
        compute_params("twins", vec![]),
    )
    .await
    .unwrap();
    let files: Vec<PathBuf> = out["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| PathBuf::from(f.as_str().unwrap()))
        .collect();
    let names: Vec<_> = files
        .iter()
        .map(|f| f.file_name().unwrap().to_str().unwrap())
        .collect();
    assert_eq!(names, ["out.png", "out-2.png"]);
    assert_eq!(std::fs::read_to_string(&files[0]).unwrap(), "first");
    assert_eq!(std::fs::read_to_string(&files[1]).unwrap(), "second");
    fx.host.shutdown().await;
}

#[tokio::test]
async fn failed_copy_leaves_no_folder() {
    let fx = node_worker_fx("half").await;
    let own = fx.layout.own_dir("asker");
    // The first link copies fine (so the folder exists); the second names a missing file.
    let e = serve(
        &fx,
        "asker",
        "alexia/compute/run",
        compute_params("half", vec![]),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, -32603);
    let left = compute_dirs(&own);
    assert!(left.is_empty(), "left behind: {left:?}");
    fx.host.shutdown().await;
}
