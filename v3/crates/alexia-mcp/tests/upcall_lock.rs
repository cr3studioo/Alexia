// SPDX-License-Identifier: AGPL-3.0-only
//! P3-40 (ME-13): a plugin's `alexia/capability/call` never unlocks locked memory. Whatever it
//! sends, a `memory.*` capability gets `unlocked: false`, from a plugin provider and from core.

mod scratch;
use scratch::Scratch;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use alexia_mcp::jsonrpc::RpcError;
use alexia_mcp::types::{CallToolResult, ClientCapabilities, CreateMessageParams, Empty, Root};
use alexia_mcp::{
    During, EventSink, HostConfig, HostFacts, McpHost, NoUpcalls, PluginId, ProgressSink, Timings,
    Upcalls,
};
use alexia_store::{secrets, Layout, Store};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

const FIXTURE: &str = env!("CARGO_BIN_EXE_mcp-fixture");

/// A tiny MCP server: one tool per capability named on its command line. It appends the
/// arguments of every call to `calls.jsonl` in its folder, then answers "ok".
const SERVER: &str = r#"
const fs = require('fs')
const path = require('path')
const rl = require('readline').createInterface({ input: process.stdin })
const caps = process.argv.slice(2)
const log = path.join(__dirname, 'calls.jsonl')
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  let result = {}
  if (m.method === 'initialize') {
    result = { protocolVersion: '2025-11-25', serverInfo: { name: 'fake', version: '0' }, capabilities: { tools: {} } }
  } else if (m.method === 'tools/list') {
    result = { tools: caps.map((cap, n) => ({ name: 't' + n, inputSchema: { type: 'object' }, _meta: { 'alexia/provides': [cap] } })) }
  } else if (m.method === 'tools/call') {
    fs.appendFileSync(log, JSON.stringify(m.params.arguments) + '\n')
    result = { content: [{ type: 'text', text: 'ok' }] }
  }
  send({ jsonrpc: '2.0', id: m.id, result })
})
rl.on('close', () => process.exit(0))
"#;

fn manifest(id: &str, entry: Value, extra: Value) -> Value {
    let mut m = json!({
        "manifest_version": 1,
        "id": id,
        "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": entry,
        "alexia_protocol": 2,
        "mcp_protocol": "2025-11-25"
    });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    m
}

/// The plugin that asks: the fixture in `storage` mode, with `requires` listing `caps`.
fn asker(dir: &Path, caps: &[&str]) {
    let path = dir.join("asker");
    std::fs::create_dir_all(&path).unwrap();
    let exe = Path::new(FIXTURE).file_name().unwrap().to_str().unwrap();
    std::fs::copy(FIXTURE, path.join(exe)).unwrap();
    let requires: Vec<Value> = caps
        .iter()
        .map(|c| json!({"cap": c, "why": "For the test."}))
        .collect();
    let m = manifest(
        "asker",
        json!({"run": exe, "args": ["storage"]}),
        json!({"storage": {"namespace": "asker", "tables": ["notes"]}, "requires": requires}),
    );
    std::fs::write(path.join("plugin.json"), m.to_string()).unwrap();
}

/// The Node server above as plugin `id`, providing `caps`.
fn provider(dir: &Path, id: &str, caps: &[&str]) {
    let path = dir.join(id);
    std::fs::create_dir_all(&path).unwrap();
    let mut args = vec!["server.cjs"];
    args.extend_from_slice(caps);
    let m = manifest(
        id,
        json!({"run": "node", "args": args}),
        json!({"provides": caps}),
    );
    std::fs::write(path.join("server.cjs"), SERVER).unwrap();
    std::fs::write(path.join("plugin.json"), m.to_string()).unwrap();
}

/// The arguments plugin `id` was called with, in order.
fn recorded(root: &Path, id: &str) -> Vec<Value> {
    std::fs::read_to_string(root.join("ext").join(id).join("calls.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

async fn start(root: &Path, enabled: &[&str], upcalls: Arc<dyn Upcalls>) -> McpHost {
    std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
    let store = Arc::new(Store::open_in_memory().unwrap());
    let sink: EventSink = Arc::new(|_| {});
    let cfg = HostConfig {
        layout: Layout::new(root.join("data")),
        plugin_dirs: vec![root.join("ext")],
        node: PathBuf::from("node"),
        // Cold Node starts on a loaded Windows machine are slow.
        timings: Timings {
            start_ms: 60_000,
            ..Timings::default()
        },
    };
    let host = McpHost::new(cfg, store, upcalls, sink);
    let enabled: Vec<PluginId> = enabled.iter().map(|s| PluginId((*s).into())).collect();
    host.start(&enabled).await.unwrap();
    host
}

/// `alexia/capability/call` as the asker would send it.
async fn upcall(host: &McpHost, cap: &str, arguments: Value) -> Result<Value, RpcError> {
    host.serve_for_test(
        &PluginId("asker".into()),
        "alexia/capability/call",
        json!({"cap": cap, "arguments": arguments}),
    )
    .await
}

fn answered_ok(out: Result<Value, RpcError>) {
    let r: CallToolResult = serde_json::from_value(out.unwrap()).unwrap();
    assert_ne!(r.is_error, Some(true), "{:?}", r.content);
    assert_eq!(r.content[0]["text"], "ok");
}

/// The asker (requiring both) and a `mem` plugin providing `memory.recall` and `memory.profile`.
async fn asker_and_memory(root: &Path) -> McpHost {
    let caps = ["memory.recall", "memory.profile"];
    asker(&root.join("ext"), &caps);
    provider(&root.join("ext"), "mem", &caps);
    start(root, &["asker", "mem"], Arc::new(NoUpcalls)).await
}

#[tokio::test]
async fn upcall_unlocked_true_is_forced_false() {
    let r = Scratch::new("lock-true");
    let host = asker_and_memory(&r).await;

    let sent = json!({"query": "x", "unlocked": true});
    answered_ok(upcall(&host, "memory.recall", sent).await);
    assert_eq!(
        recorded(&r, "mem"),
        [json!({"query": "x", "unlocked": false})]
    );
    host.shutdown().await;
}

#[tokio::test]
async fn upcall_without_unlocked_gets_false() {
    let r = Scratch::new("lock-absent");
    let host = asker_and_memory(&r).await;

    answered_ok(upcall(&host, "memory.profile", json!({})).await);
    // No `arguments` member at all is the same.
    answered_ok(
        host.serve_for_test(
            &PluginId("asker".into()),
            "alexia/capability/call",
            json!({"cap": "memory.profile"}),
        )
        .await,
    );
    assert_eq!(
        recorded(&r, "mem"),
        [json!({"unlocked": false}), json!({"unlocked": false})]
    );
    host.shutdown().await;
}

#[tokio::test]
async fn upcall_unlocked_string_or_number_is_false() {
    let r = Scratch::new("lock-odd");
    let host = asker_and_memory(&r).await;

    answered_ok(upcall(&host, "memory.recall", json!({"unlocked": "true"})).await);
    answered_ok(upcall(&host, "memory.recall", json!({"unlocked": 1})).await);
    assert_eq!(
        recorded(&r, "mem"),
        [json!({"unlocked": false}), json!({"unlocked": false})]
    );
    host.shutdown().await;
}

/// Core, answering a capability itself: it records what `host_call` was handed.
#[derive(Default)]
struct Core {
    saw: Mutex<Vec<(String, Value)>>,
}

#[async_trait::async_trait]
impl Upcalls for Core {
    fn offers(&self, _plugin: &PluginId) -> ClientCapabilities {
        ClientCapabilities {
            roots: Some(Empty {}),
            ..Default::default()
        }
    }

    fn host_facts(&self) -> HostFacts {
        NoUpcalls.host_facts()
    }

    async fn sample(
        &self,
        plugin: &PluginId,
        params: CreateMessageParams,
        progress: Option<ProgressSink>,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        NoUpcalls.sample(plugin, params, progress, cancel).await
    }

    async fn elicit(
        &self,
        plugin: &PluginId,
        params: Value,
        during: Option<During>,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        NoUpcalls.elicit(plugin, params, during, cancel).await
    }

    async fn roots(&self, _plugin: &PluginId) -> Vec<Root> {
        vec![]
    }

    async fn host_call(
        &self,
        _plugin: &PluginId,
        cap: &str,
        args: Map<String, Value>,
        _cancel: CancellationToken,
    ) -> Option<Result<CallToolResult, RpcError>> {
        self.saw
            .lock()
            .unwrap()
            .push((cap.into(), Value::Object(args)));
        let ok = json!({"content": [{"type": "text", "text": "ok"}]});
        Some(Ok(serde_json::from_value(ok).unwrap()))
    }
}

#[tokio::test]
async fn core_answered_memory_cap_is_locked_too() {
    let r = Scratch::new("lock-core");
    asker(&r.join("ext"), &["memory.recall"]);
    let core = Arc::new(Core::default());
    let host = start(&r, &["asker"], core.clone()).await;

    let sent = json!({"query": "x", "unlocked": true});
    answered_ok(upcall(&host, "memory.recall", sent).await);
    assert_eq!(
        *core.saw.lock().unwrap(),
        [(
            "memory.recall".to_string(),
            json!({"query": "x", "unlocked": false})
        )]
    );
    host.shutdown().await;
}

/// The rule is by capability: even the memory provider's other capabilities are left alone.
#[tokio::test]
async fn other_caps_untouched() {
    let r = Scratch::new("lock-other");
    asker(&r.join("ext"), &["demo.echo"]);
    provider(&r.join("ext"), "echoer", &["memory.recall", "demo.echo"]);
    let host = start(&r, &["asker", "echoer"], Arc::new(NoUpcalls)).await;

    let sent = json!({"unlocked": true, "a": 1});
    answered_ok(upcall(&host, "demo.echo", sent.clone()).await);
    answered_ok(upcall(&host, "demo.echo", json!({})).await);
    assert_eq!(recorded(&r, "echoer"), [sent, json!({})]);
    host.shutdown().await;
}

#[tokio::test]
async fn requires_still_checked_first() {
    let r = Scratch::new("lock-requires");
    asker(&r.join("ext"), &["memory.profile"]);
    provider(&r.join("ext"), "mem", &["memory.recall", "memory.profile"]);
    let host = start(&r, &["asker", "mem"], Arc::new(NoUpcalls)).await;

    let e = upcall(&host, "memory.recall", json!({"unlocked": true}))
        .await
        .unwrap_err();
    assert_eq!(e.code, -32051);
    // Refused before anything was asked.
    assert_eq!(host.pid(&PluginId("mem".into())), None);
    assert!(recorded(&r, "mem").is_empty());
    host.shutdown().await;
}
