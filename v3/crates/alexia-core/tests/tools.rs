// SPDX-License-Identifier: AGPL-3.0-only
//! `McpTooling` against the `mcp-fixture` binary in temp plugin folders (P2-18).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

mod scratch;
use scratch::Scratch;

use alexia_core::tools::{namespaced, outcome_of, tool_words, McpTooling};
use alexia_core::{Builtin, Origin, RunId, ToolCtx, ToolOutcome, ToolSpec, Tooling};
use alexia_mcp::types::CallToolResult;
use alexia_mcp::{EventSink, HostConfig, McpHost, NoUpcalls, PluginId, Timings};
use alexia_store::{Layout, SessionId, Store};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

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

struct Env {
    host: McpHost,
    /// Last, so it drops after the host: the folder goes once its plugins have.
    root: Scratch,
}

impl Env {
    async fn done(self) {
        self.host.shutdown().await;
    }
}

/// A host with one plugin per `(id, fixture mode)`.
async fn env(tag: &str, plugins: &[(&str, &str)]) -> Env {
    let root = Scratch::new(&format!("tools-{tag}"));
    let ext = root.join("ext");
    let src = fixture_exe();
    let exe = src.file_name().unwrap().to_str().unwrap();
    for (id, mode) in plugins {
        let dir = ext.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::copy(&src, dir.join(exe)).unwrap();
        let m = json!({
            "manifest_version": 1, "id": id, "name": format!("Plugin {id}"),
            "summary": "A plugin that exists for tests.", "version": "0.1.0",
            "license": "AGPL-3.0-only", "entry": { "run": exe, "args": [mode] },
            "alexia_protocol": 2, "mcp_protocol": "2025-11-25"
        });
        std::fs::write(dir.join("plugin.json"), m.to_string()).unwrap();
    }
    boot(root, ext, plugins.iter().map(|(id, _)| *id).collect()).await
}

async fn boot(root: Scratch, ext: PathBuf, ids: Vec<&str>) -> Env {
    let cfg = HostConfig {
        layout: Layout::new(root.join("data")),
        plugin_dirs: vec![ext],
        node: PathBuf::from("node"),
        timings: Timings {
            exit_grace_ms: 8_000,
            ..Timings::default()
        },
    };
    let sink: EventSink = Arc::new(|_| {});
    let host = McpHost::new(
        cfg,
        Arc::new(Store::open_in_memory().unwrap()),
        Arc::new(NoUpcalls),
        sink,
    );
    let ids: Vec<PluginId> = ids.into_iter().map(|id| PluginId(id.into())).collect();
    host.start(&ids).await.unwrap();
    Env { host, root }
}

/// A plugin that is a node script, for what the fixture cannot show: it appends every
/// `notifications/cancelled` it receives to `cancelled.log` beside it, and its `set` answers
/// with an un-namespaced `alexia/undo`; `set_other` and `set_note` name another plugin's tool
/// and the `Note` builtin as their undo.
const NODE_PLUGIN: &str = r#"
const fs = require('fs'), path = require('path');
const log = path.join(__dirname, 'cancelled.log');
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const text = (t, meta) => ({ content: [{ type: 'text', text: t }], ...(meta ? { _meta: meta } : {}) });
const obj = { type: 'object' };
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'notifications/cancelled') { fs.appendFileSync(log, JSON.stringify(m.params) + '\n'); return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, serverInfo: { name: 'n', version: '0' }, capabilities: { tools: {} } } });
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: ['slow', 'set', 'unset', 'set_hid', 'hid', 'set_other', 'set_note'].map((name) => ({ name, inputSchema: obj, ...(name === 'hid' ? { _meta: { 'alexia/compute': {} } } : {}) })) } });
  else if (m.method === 'tools/call') {
    const n = m.params.name;
    if (n === 'set') send({ id: m.id, result: text('set k', { 'alexia/undo': { tool: 'unset', arguments: { key: 'k' }, summary: 'set k' } }) });
    else if (n === 'set_other') send({ id: m.id, result: text('set o', { 'alexia/undo': { tool: 'other__unset', arguments: {}, summary: 'set o' } }) });
    else if (n === 'set_note') send({ id: m.id, result: text('set n', { 'alexia/undo': { tool: 'note_down', arguments: {}, summary: 'set n' } }) });
    else if (n === 'set_hid') send({ id: m.id, result: text('set h', { 'alexia/undo': { tool: 'hid', arguments: {}, summary: 'set h' } }) });
    else if (n === 'unset') send({ id: m.id, result: text('unset k') });
    // `slow` never answers: only a cancel ends it.
  } else send({ id: m.id, result: {} });
});
"#;

/// A host with one node plugin running [`NODE_PLUGIN`].
async fn node_env(tag: &str, id: &str) -> Env {
    node_envs(tag, &[id]).await
}

/// A host with one node plugin per id, each running [`NODE_PLUGIN`].
async fn node_envs(tag: &str, ids: &[&str]) -> Env {
    let root = Scratch::new(&format!("tools-{tag}"));
    let ext = root.join("ext");
    for id in ids {
        let dir = ext.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plugin.js"), NODE_PLUGIN).unwrap();
        let m = json!({
            "manifest_version": 1, "id": id, "name": format!("Plugin {id}"),
            "summary": "A plugin that exists for tests.", "version": "0.1.0",
            "license": "AGPL-3.0-only", "entry": { "run": "node", "args": ["plugin.js"] },
            "alexia_protocol": 2, "mcp_protocol": "2025-11-25"
        });
        std::fs::write(dir.join("plugin.json"), m.to_string()).unwrap();
    }
    boot(root, ext, ids.to_vec()).await
}

fn ctx() -> ToolCtx {
    ToolCtx {
        session: SessionId(7),
        run: RunId("r1".into()),
        origin: Origin::Desktop,
        background: false,
        cancel: CancellationToken::new(),
        progress: None,
    }
}

fn args(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

fn result(content: Value, meta: Option<Value>, is_error: bool) -> CallToolResult {
    let mut v = json!({ "content": content });
    if let Some(m) = meta {
        v["_meta"] = m;
    }
    if is_error {
        v["isError"] = json!(true);
    }
    serde_json::from_value(v).unwrap()
}

struct Note;

#[async_trait::async_trait]
impl Builtin for Note {
    fn specs(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "note_down".into(),
            description: "Writes a note.".into(),
            params: json!({"type": "object"}),
            annotations: None,
            reviewed: true,
            plugin: None,
            words: "write a note".into(),
        }]
    }
    async fn call(&self, name: &str, _: &Map<String, Value>, _: &ToolCtx) -> Option<ToolOutcome> {
        (name == "note_down").then(|| {
            outcome_of(&result(
                json!([{"type":"text","text":"noted"}]),
                None,
                false,
            ))
        })
    }
}

#[tokio::test]
async fn scratch_removed_after_host_dropped() {
    let e = env("dropped", &[("hello", "greet")]).await;
    let root = e.root.to_path_buf();
    assert!(root.join("ext").join("hello").join("plugin.json").is_file());
    e.done().await;
    assert!(!root.exists(), "{} left behind", root.display());
}

#[tokio::test]
async fn lists_visible_and_builtins() {
    let e = env("list", &[("hello", "greet")]).await;
    let tooling = McpTooling::new(e.host.clone(), vec![]);
    tooling.add_builtin(Arc::new(Note));
    let specs = tooling.list().await;
    let names: Vec<&str> = specs.iter().map(|s| s.name.as_str()).collect();
    // `secret_tool` carries `alexia/compute`: never shown to a model.
    assert_eq!(names, ["note_down", "hello__greet"]);
    let greet = &specs[1];
    assert_eq!(greet.plugin, Some(PluginId("hello".into())));
    assert!(greet.reviewed);
    assert_eq!(greet.words, "greet");
    assert_eq!(greet.params["properties"]["who"]["type"], "string");
    assert_eq!(specs[0].plugin, None);
    assert_eq!(
        namespaced(&PluginId("hello".into()), "greet"),
        "hello__greet"
    );
    e.done().await;
}

#[tokio::test]
async fn call_round_trip() {
    let e = env("call", &[("hello", "greet")]).await;
    let tooling = McpTooling::new(e.host.clone(), vec![Arc::new(Note)]);
    let out = tooling
        .call("hello__greet", args(json!({"who": "Ann"})), ctx())
        .await;
    assert!(out.ok);
    assert_eq!(out.text, "Hello, Ann.");
    assert!(out.files.is_empty() && out.final_text.is_none() && out.undo.is_none());

    // A builtin answers to its own name.
    assert_eq!(
        tooling.call("note_down", Map::new(), ctx()).await.text,
        "noted"
    );
    // Unknown, unknown plugin, and a hidden tool are all "no such tool".
    for name in ["hello__nope", "ghost__greet", "greet", "hello__secret_tool"] {
        let out = tooling.call(name, Map::new(), ctx()).await;
        assert!(!out.ok, "{name}");
        assert_eq!(out.text, format!("There is no tool called {name}."));
    }
    e.done().await;
}

#[tokio::test]
async fn vanished_is_an_outcome() {
    let e = env("vanish", &[("vanisher", "vanish")]).await;
    let tooling = McpTooling::new(e.host.clone(), vec![]);
    assert_eq!(tooling.list().await.len(), 1);
    let out = tooling
        .call("vanisher__slow", args(json!({"ms": 0})), ctx())
        .await;
    assert!(out.ok, "{}", out.text);

    // The folder goes (only the manifest: the running exe may be locked on Windows).
    std::fs::remove_file(e.root.join("ext").join("vanisher").join("plugin.json")).unwrap();
    let out = tooling
        .call("vanisher__slow", args(json!({"ms": 0})), ctx())
        .await;
    assert!(!out.ok);
    assert_eq!(
        out.text,
        "That tool is gone (its plugin was removed). Plan without it."
    );
    assert!(tooling.list().await.is_empty());
    e.done().await;
}

#[tokio::test]
async fn progress_forwarded() {
    let e = env("progress", &[("hello", "greet")]).await;
    let tooling = McpTooling::new(e.host.clone(), vec![]);
    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
    let mut c = ctx();
    c.progress = Some(tx);
    let out = tooling
        .call("hello__greet", args(json!({"who": "progress"})), c)
        .await;
    assert!(out.ok);
    let mut lines = vec![];
    while let Ok(Some(l)) = tokio::time::timeout(Duration::from_secs(30), rx.recv()).await {
        lines.push(l.line());
    }
    assert_eq!(lines, ["1 of 2", "2 of 2"]);
    e.done().await;
}

#[test]
fn final_and_card_read() {
    let r = result(
        json!([{"type":"text","text":"Result."},{"type":"image","data":"x"}]),
        Some(json!({
            "alexia/final": "  The answer is 4.  ",
            "alexia/card": {"title": "T", "fields": {"a": "b", "n": 3, "bad": [1]}, "url": "https://x.test/p"}
        })),
        false,
    );
    let o = outcome_of(&r);
    assert!(o.ok);
    assert_eq!(o.text, "Result.\n[image]");
    assert_eq!(o.final_text.as_deref(), Some("The answer is 4."));
    assert_eq!(
        o.card.unwrap(),
        json!({"title": "T", "fields": {"a": "b", "n": "3"}, "url": "https://x.test/p"})
    );

    // A card's link is a web page or nothing; a card with no fields is no card.
    let o = outcome_of(&result(
        json!([]),
        Some(
            json!({"alexia/card": {"title": "T", "fields": {"a": "b"}, "url": "file:///etc/passwd"}}),
        ),
        false,
    ));
    assert_eq!(o.text, "Done.");
    assert_eq!(o.card.unwrap(), json!({"title": "T", "fields": {"a": "b"}}));
    let o = outcome_of(&result(
        json!([]),
        Some(json!({"alexia/card": {"title": "T", "fields": {}}})),
        false,
    ));
    assert!(o.card.is_none());

    // A failure is the model's to explain: no final reply, and an empty one is said aloud.
    let o = outcome_of(&result(
        json!([]),
        Some(json!({"alexia/final": "hi"})),
        true,
    ));
    assert!(!o.ok && o.final_text.is_none());
    assert_eq!(o.text, "The tool failed and said nothing.");
    let long = "x".repeat(5000);
    let o = outcome_of(&result(
        json!([]),
        Some(json!({"alexia/final": long})),
        false,
    ));
    assert_eq!(o.final_text.unwrap().len(), 4000);
}

#[tokio::test]
async fn undo_meta_read() {
    let o = outcome_of(&result(
        json!([{"type":"text","text":"set k"}]),
        Some(
            json!({"alexia/undo": {"tool": "unset", "arguments": {"key": "k"}, "summary": "set k"}}),
        ),
        false,
    ));
    let u = o.undo.unwrap();
    assert_eq!((u.tool.as_str(), u.summary.as_str()), ("unset", "set k"));
    assert_eq!(u.arguments["key"], "k");
    // Not on a failure.
    let o = outcome_of(&result(
        json!([]),
        Some(json!({"alexia/undo": {"tool": "unset", "arguments": {}, "summary": "s"}})),
        true,
    ));
    assert!(o.undo.is_none());

    // And through the real wire: the fixture's `set` answers with `alexia/undo` meta, which
    // it gives without a summary, so no undo is read from a malformed one.
    let e = env("undo", &[("undoer", "undoable")]).await;
    let tooling = McpTooling::new(e.host.clone(), vec![]);
    let out = tooling
        .call("undoer__set", args(json!({"key": "k", "value": 1})), ctx())
        .await;
    assert!(out.ok);
    assert_eq!(out.text, "set k");
    assert!(out.undo.is_none());
    e.done().await;
}

#[test]
fn resource_link_is_produced() {
    let dir = Scratch::new("tools-files");
    let file = dir.join("my report.PNG");
    std::fs::write(&file, b"12345").unwrap();
    let slashed = file
        .to_string_lossy()
        .replace('\\', "/")
        .replace(' ', "%20");
    let uri = if slashed.starts_with('/') {
        format!("file://{slashed}")
    } else {
        format!("file:///{slashed}")
    };
    let o = outcome_of(&result(
        json!([
            {"type":"text","text":"made it"},
            {"type":"resource_link","uri": uri, "name": ""},
            {"type":"resource_link","uri": "file:///definitely/not/here.txt", "name": "gone.txt"},
            {"type":"resource_link","uri": "https://x.test/a.pdf", "name": "a.pdf"},
        ]),
        None,
        false,
    ));
    assert_eq!(
        o.text,
        "made it\n[file: my report.PNG]\n[file: gone.txt — not written]\n[file: a.pdf — not written]"
    );
    assert_eq!(o.files.len(), 1);
    let f = &o.files[0];
    assert_eq!(
        (f.name.as_str(), f.bytes, f.mime.as_str()),
        ("my report.PNG", 5, "image/png")
    );
    assert_eq!(f.path, file);
}

#[tokio::test]
async fn cancel_reaches_the_plugin() {
    let e = node_env("cancel", "canceller").await;
    let tooling = McpTooling::new(e.host.clone(), vec![]);
    let c = ctx();
    let cancel = c.cancel.clone();
    let started = std::time::Instant::now();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        cancel.cancel();
    });
    // The plugin never answers `slow`; cancelling must end the call.
    let out = tooling.call("canceller__slow", Map::new(), c).await;
    canceller.await.unwrap();
    assert!(!out.ok);
    assert_eq!(out.text, "Stopped.");
    assert!(started.elapsed() < Duration::from_secs(30));
    // The plugin itself was told: it logged `notifications/cancelled` for that request.
    // The script writes beside itself, in the plugin folder.
    let log = e.root.join("ext").join("canceller").join("cancelled.log");
    let mut seen = String::new();
    for _ in 0..300 {
        seen = std::fs::read_to_string(&log).unwrap_or_default();
        if !seen.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(seen.contains("requestId"), "plugin got no cancel: {seen:?}");
    // And the plugin is still good for the next call.
    let out = tooling.call("canceller__unset", Map::new(), ctx()).await;
    assert!(out.ok, "{}", out.text);
    e.done().await;
}

#[tokio::test]
async fn undo_tool_is_namespaced_for_the_next_call() {
    let e = node_env("undo-ns", "undoer").await;
    let tooling = McpTooling::new(e.host.clone(), vec![]);
    let out = tooling.call("undoer__set", Map::new(), ctx()).await;
    assert!(out.ok, "{}", out.text);
    let undo = out.undo.expect("undo read");
    assert_eq!(undo.tool, "undoer__unset");
    // The undo is a call the tooling can make as given.
    let back = tooling.call(&undo.tool, undo.arguments, ctx()).await;
    assert!(back.ok && back.text == "unset k", "{}", back.text);
    e.done().await;
}

#[tokio::test]
async fn undo_to_hidden_tool_is_dropped() {
    let e = node_env("undo-hid", "undoer").await;
    let tooling = McpTooling::new(e.host.clone(), vec![]);
    let out = tooling.call("undoer__set_hid", Map::new(), ctx()).await;
    assert!(out.ok, "{}", out.text);
    assert!(out.undo.is_none(), "undo to a hidden tool must not survive");
    e.done().await;
}

#[tokio::test]
async fn call_refuses_a_name_list_hides() {
    let long = "p".repeat(60);
    let e = env("hides", &[(long.as_str(), "greet")]).await;
    let tooling = McpTooling::new(e.host.clone(), vec![]);
    // `list()` hides it for its length; `call()` must too.
    assert!(tooling.list().await.is_empty());
    let over = format!("{long}__greet");
    assert!(over.len() > 64);
    for name in [over.as_str(), &format!("{long}__secret_tool")] {
        let out = tooling.call(name, Map::new(), ctx()).await;
        assert!(!out.ok, "{name}");
        assert_eq!(out.text, format!("There is no tool called {name}."));
    }
    e.done().await;
    // A hidden tool, on a plugin whose names fit.
    let e = env("hides2", &[("hello", "greet")]).await;
    let tooling = McpTooling::new(e.host.clone(), vec![]);
    let out = tooling.call("hello__secret_tool", Map::new(), ctx()).await;
    assert_eq!(out.text, "There is no tool called hello__secret_tool.");
    e.done().await;
}

#[test]
fn unc_file_uris_are_not_written() {
    let started = std::time::Instant::now();
    let link = |uri: &str| json!({"type":"resource_link","uri": uri, "name": "x"});
    let o = outcome_of(&result(
        json!([
            link("file:////srv/share/x"),
            link("file:///%5C%5Csrv/share/x"),
            link(r"file:///\srv\share\x"),
            link("file:///%5C%3F%5CUNC%5Csrv%5Cshare%5Cx"),
        ]),
        None,
        false,
    ));
    assert!(o.files.is_empty());
    assert!(o.text.lines().all(|l| l == "[file: x — not written]"));
    assert_eq!(o.text.lines().count(), 4);
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn file_links_with_a_host_are_not_written() {
    let dir = Scratch::new("tools-host");
    let file = dir.join("a.txt");
    std::fs::write(&file, b"x").unwrap();
    let slashed = file.to_string_lossy().replace('\\', "/");
    let abs = if slashed.starts_with('/') {
        slashed
    } else {
        format!("/{slashed}")
    };
    let link = |uri: String| json!({"type":"resource_link","uri": uri, "name": "a.txt"});
    let o = outcome_of(&result(
        json!([
            link(format!("file://localhost{abs}")),
            link(format!("file://{abs}")),
            // `Cargo.toml` is in the test's working directory: a host must not turn it
            // into a relative path.
            link("file://Cargo.toml".into()),
            link("file://srv/share/x".into()),
            link("file://etc/passwd".into()),
        ]),
        None,
        false,
    ));
    let lines: Vec<&str> = o.text.lines().collect();
    assert_eq!(
        lines,
        [
            "[file: a.txt]",
            "[file: a.txt]",
            "[file: a.txt — not written]",
            "[file: a.txt — not written]",
            "[file: a.txt — not written]"
        ]
    );
    assert_eq!(o.files.len(), 2);
}

#[test]
fn tool_words_is_the_first_clause() {
    assert_eq!(
        tool_words("a__b", Some("Lists the open windows, newest first.")),
        "lists the open windows"
    );
    assert_eq!(
        tool_words("a__b", Some("PDF to text. More.")),
        "PDF to text"
    );
    assert_eq!(tool_words("a__open_the.thing", None), "open the thing");
    let long = format!("{} words.", "long ".repeat(20));
    assert_eq!(tool_words("a__do_it", Some(&long)), "do it");
}

#[tokio::test]
async fn undo_naming_other_plugin_dropped() {
    let e = node_envs("undo-other", &["undoer", "other"]).await;
    let tooling = McpTooling::new(e.host.clone(), vec![]);
    // `other__unset` is a real, callable tool, but not the returning plugin's own.
    assert!(tooling.call("other__unset", Map::new(), ctx()).await.ok);
    let out = tooling.call("undoer__set_other", Map::new(), ctx()).await;
    assert!(out.ok, "{}", out.text);
    assert!(
        out.undo.is_none(),
        "undo into another plugin: {:?}",
        out.undo
    );
    e.done().await;
}

#[tokio::test]
async fn undo_naming_builtin_dropped() {
    let e = node_env("undo-builtin", "undoer").await;
    let tooling = McpTooling::new(e.host.clone(), vec![Arc::new(Note)]);
    let out = tooling.call("undoer__set_note", Map::new(), ctx()).await;
    assert!(out.ok, "{}", out.text);
    assert!(out.undo.is_none(), "undo into a builtin: {:?}", out.undo);
    e.done().await;
}

#[tokio::test]
async fn undo_bare_name_namespaced_to_caller() {
    // Both plugins have `unset`: the bare name is the caller's, never the other one's.
    let e = node_envs("undo-bare", &["other", "undoer"]).await;
    let tooling = McpTooling::new(e.host.clone(), vec![Arc::new(Note)]);
    for caller in ["undoer", "other"] {
        let out = tooling
            .call(&format!("{caller}__set"), Map::new(), ctx())
            .await;
        assert!(out.ok, "{}", out.text);
        assert_eq!(
            out.undo.expect("undo read").tool,
            format!("{caller}__unset")
        );
    }
    e.done().await;
}
