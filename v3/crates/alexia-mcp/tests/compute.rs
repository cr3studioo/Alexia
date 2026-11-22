// SPDX-License-Identifier: AGPL-3.0-only
//! P2-22: `alexia/compute/run` on this machine, and capability calls that fall through to the
//! host, against the `mcp-fixture` binary.

mod scratch;
use scratch::Scratch;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use alexia_mcp::jsonrpc::RpcError;
use alexia_mcp::types::{
    CallToolResult, ClientCapabilities, CreateMessageParams, ProgressToken, Root,
};
use alexia_mcp::{
    CallCtx, EventSink, HostConfig, HostFacts, McpHost, NoUpcalls, PluginId, ProgressSink, Timings,
    Upcalls,
};
use alexia_store::{secrets, Layout, Store};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

const FIXTURE: &str = env!("CARGO_BIN_EXE_mcp-fixture");
const NOT_AVAILABLE: i32 = -32050;
const NOT_PERMITTED: i32 = -32051;
const INVALID_PARAMS: i32 = -32602;

fn root(tag: &str) -> Scratch {
    Scratch::new(tag)
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
    /// Last field: dropped after the host has killed its plugins.
    _root: Scratch,
}

async fn start(root: Scratch, enabled: &[&str], up: Arc<dyn Upcalls>) -> Fx {
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
        _root: root,
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
            "provides": ["demo.compute", "demo.slow"],
            "compute": {"operations": [
                {"cap": "demo.compute", "summary": "Writes a file."},
                {"cap": "demo.slow", "summary": "Takes its time."}
            ]}
        }),
    );
    plugin(&ext, "asker", "greet", requires("demo.compute"));
    plugin(&ext, "stranger", "greet", json!({}));
    start(root, &["worker", "asker", "stranger"], Arc::new(NoUpcalls)).await
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
    let lone = start(root, &["lonely"], Arc::new(NoUpcalls)).await;
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
    let outside = root("outside-file");
    let elsewhere = outside.join("secret.txt");
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
    let fx = start(dir, &["asker"], Arc::new(Core)).await;
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
    let bare = start(dir2, &["asker"], Arc::new(NoUpcalls)).await;
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
    let fx = start(root, &["greeter", "asker"], Arc::new(Core)).await;
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
    let fx = start(root, &["asker"], Arc::new(Core)).await;
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
    let fx = start(root, &["a", "b"], Arc::new(NoUpcalls)).await;
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
/// `arguments.mode`: `twins` links two same-named files, `half` links one real and one missing,
/// `host` links its own file under another host's URI, `unc` links a network share.
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
    } else if (args.mode === 'host') {
      // A real file of its own, behind a URI whose host is not this machine: on Windows
      // `file://C:/...` (host `C:`), elsewhere `file://evil/...`.
      const p = put('a', 'out.png', 'x').split(path.sep).join('/');
      content.push({ type: 'resource_link', uri: 'file://' + (process.platform === 'win32' ? p : 'evil' + p), name: 'out.png' });
    } else if (args.mode === 'unc') {
      // TEST-NET-1: nothing answers, so an SMB attempt would hang for its whole timeout.
      content.push({ type: 'resource_link', uri: 'file:////192.0.2.1/share/out.png', name: 'out.png' });
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
    start(root, &["worker", "asker"], Arc::new(NoUpcalls)).await
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

#[tokio::test]
async fn cancelled_compute_stops_provider() {
    let fx = compute_fx("cancel").await;
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        trigger.cancel();
    });
    let ctx = CallCtx {
        cancel,
        ..CallCtx::default()
    };
    let started = Instant::now();
    // Far longer than the test waits; `capability_ms` is longer still.
    let params = json!({"cap": "demo.slow", "arguments": {"ms": 120_000}});
    let r = fx
        .host
        .serve_ctx_for_test(&id("worker"), "alexia/compute/run", params, ctx)
        .await;
    assert!(r.is_err(), "{r:?}");
    assert!(
        started.elapsed() < Duration::from_secs(30),
        "{:?}",
        started.elapsed()
    );
    // The provider itself saw `notifications/cancelled` and stopped.
    let proof = fx.layout.own_dir("worker").join("cancelled.txt");
    let deadline = Instant::now() + Duration::from_secs(30);
    while !proof.exists() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(proof.exists(), "the provider never saw the cancel");
    fx.host.shutdown().await;
}

#[tokio::test]
async fn compute_progress_reaches_caller() {
    let fx = compute_fx("progress").await;
    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
    let ctx = CallCtx {
        progress: Some(tx),
        ..CallCtx::default()
    };
    let params = json!({"cap": "demo.slow", "arguments": {"ms": 0}});
    let out = fx
        .host
        .serve_ctx_for_test(&id("worker"), "alexia/compute/run", params, ctx)
        .await
        .unwrap();
    assert_eq!(out["text"], "crunched");
    let mut seen = vec![];
    while let Ok(frame) = rx.try_recv() {
        seen.push(frame);
    }
    assert_eq!(seen.len(), 2, "{seen:?}");
    assert_eq!(seen[1].progress, 2.0);
    assert_eq!(seen[1].total, Some(2.0));
    assert!(matches!(seen[0].progress_token, ProgressToken::Num(_)));
    fx.host.shutdown().await;
}

#[tokio::test]
async fn input_unc_path_refused_before_fs() {
    let fx = compute_fx("unc-input").await;
    std::fs::create_dir_all(fx.layout.own_dir("asker")).unwrap();
    // 192.0.2.1 is TEST-NET-1: an SMB attempt there would hang for its whole timeout.
    for path in [
        r"\\127.0.0.1\x\y",
        "//127.0.0.1/x/y",
        r"\\192.0.2.1\x\y",
        r"\/192.0.2.1/x/y",
        r"\??\UNC\192.0.2.1\x\y",
        r"\??\unc\192.0.2.1\x\y",
        "/??/UNC/192.0.2.1/x/y",
        r"\??\C:\Windows",
    ] {
        let params = json!({"cap": "demo.compute", "inputs": [input("s", Path::new(path))]});
        let started = Instant::now();
        let e = serve(&fx, "asker", "alexia/compute/run", params)
            .await
            .unwrap_err();
        assert_eq!(e.code, INVALID_PARAMS, "{path}");
        assert!(
            e.message.contains("not in this plugin's own folder"),
            "{path}: {}",
            e.message
        );
        // A pure check, no process spawned: far under any SMB timeout.
        if cfg!(windows) {
            assert!(started.elapsed() < Duration::from_secs(10), "{path}");
        }
    }
    fx.host.shutdown().await;
}

#[tokio::test]
async fn resource_link_other_host_refused() {
    let fx = node_worker_fx("link-host").await;
    let e = serve(
        &fx,
        "asker",
        "alexia/compute/run",
        compute_params("host", vec![]),
    )
    .await
    .unwrap_err();
    assert!(e.message.contains("does not own"), "{}", e.message);
    assert!(compute_dirs(&fx.layout.own_dir("asker")).is_empty());
    fx.host.shutdown().await;
}

#[tokio::test]
async fn resource_link_unc_refused() {
    let fx = node_worker_fx("link-unc").await;
    let started = Instant::now();
    let e = serve(
        &fx,
        "asker",
        "alexia/compute/run",
        compute_params("unc", vec![]),
    )
    .await
    .unwrap_err();
    assert!(e.message.contains("does not own"), "{}", e.message);
    // One call to a running worker; an SMB attempt to TEST-NET would take far longer.
    if cfg!(windows) {
        assert!(started.elapsed() < Duration::from_secs(15));
    }
    fx.host.shutdown().await;
}

/// P2-82: a link inside a root whose target is a network path is refused before anything
/// follows it. 192.0.2.1 is TEST-NET-1 (never routed), so following the link costs Windows its
/// SMB connect timeout (about 20 s); the refusal must come well before that.
#[cfg(windows)]
#[tokio::test]
async fn link_to_network_path_refused() {
    let fx = compute_fx("netlink").await;
    let own = fx.layout.own_dir("asker");
    std::fs::create_dir_all(&own).unwrap();
    let link = own.join("share");
    if let Err(e) = std::os::windows::fs::symlink_dir(r"\192.0.2.1\nonexistent", &link) {
        eprintln!("SKIPPED link_to_network_path_refused: this process may not create symlinks ({e})");
        fx.host.shutdown().await;
        return;
    }
    let t = Instant::now();
    for path in [link.clone(), link.join("in.txt")] {
        let params = json!({"cap": "demo.compute", "inputs": [input("s", &path)]});
        let e = serve(&fx, "asker", "alexia/compute/run", params)
            .await
            .unwrap_err();
        assert_eq!(e.code, INVALID_PARAMS, "{path:?}");
    }
    let took = t.elapsed();
    assert!(
        took < Duration::from_secs(10),
        "took {took:?}: the link was followed to the network"
    );
    fx.host.shutdown().await;
}
