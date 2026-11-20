// SPDX-License-Identifier: AGPL-3.0-only
//! `McpTooling` against the `mcp-fixture` binary in temp plugin folders (P2-18).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

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
    root: PathBuf,
    host: McpHost,
}

impl Env {
    async fn done(self) {
        self.host.shutdown().await;
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// A host with one plugin per `(id, fixture mode)`.
async fn env(tag: &str, plugins: &[(&str, &str)]) -> Env {
    let root = std::env::temp_dir().join(format!("alexia-tools-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
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
    let ids: Vec<PluginId> = plugins
        .iter()
        .map(|(id, _)| PluginId((*id).into()))
        .collect();
    host.start(&ids).await.unwrap();
    Env { root, host }
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
        lines.push(l);
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
    let dir = std::env::temp_dir().join(format!("alexia-tools-files-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
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
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn cancel_reaches_the_plugin() {
    let e = env("cancel", &[("vanisher", "vanish")]).await;
    let tooling = McpTooling::new(e.host.clone(), vec![]);
    let c = ctx();
    let cancel = c.cancel.clone();
    let started = std::time::Instant::now();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        cancel.cancel();
    });
    // The plugin would sleep a minute; cancelling must end the call long before.
    let out = tooling
        .call("vanisher__slow", args(json!({"ms": 60_000})), c)
        .await;
    canceller.await.unwrap();
    assert!(!out.ok);
    assert_eq!(out.text, "Stopped.");
    assert!(started.elapsed() < Duration::from_secs(30));
    // The plugin is still good for the next call.
    let out = tooling
        .call("vanisher__slow", args(json!({"ms": 0})), ctx())
        .await;
    assert!(out.ok, "{}", out.text);
    e.done().await;
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
