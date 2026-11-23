// SPDX-License-Identifier: AGPL-3.0-only
//! P2D-11: the image editor, in-process. `Api::serve` on `127.0.0.1:0` over a real `McpHost`
//! whose one plugin (a node script written here at test time) provides `image.edit`, with the
//! `Agent` as its upcalls so the plugin can share files. Requests are written by hand over TCP.
//!
//! The routes never name the plugin: the editor is found by capability.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use alexia_api::{Api, ApiParts};
use alexia_core::agent::{Agent, AgentParts};
use alexia_core::catalog::Catalog;
use alexia_core::checker::Checker;
use alexia_core::local::{LocalJobs, Runtime};
use alexia_core::prompt::Skills;
use alexia_core::router::Router;
use alexia_core::tools::McpTooling;
use alexia_core::{Brain, BrainError, Bus, DraftSink, Lane, Limits, Reply, Turn};
use alexia_gateway::{Asker, ChannelSet, WindowQuestions};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, PluginId, Timings};
use alexia_scheduler::Scheduler;
use alexia_store::{Layout, Store};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

/// Generous: a loaded Windows machine is slow, and the plugin is a process.
const WAIT: Duration = Duration::from_secs(90);

/// The editor plugin. Its one tool is hidden (`alexia/editor`) and provides `image.edit`.
/// Every call answers with what it was told (`seen`). `call: "preview"` first writes a picture
/// into its own folder (its working directory) and shares it; `call: "batch"` answers with an
/// error result; `call: "cleanup"` answers a cleanup receipt.
const EDITOR: &str = r#"
const fs = require('fs');
const path = require('path');
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const waiting = new Map();
let next = 0;
const ask = (method, params) => new Promise((resolve) => {
  const id = 'up' + (next++);
  waiting.set(id, resolve);
  send({ id, method, params });
});
const text = (v, isError) => ({ content: [{ type: 'text', text: JSON.stringify(v) }], ...(isError && { isError: true }) });
require('readline').createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined && waiting.has(m.id)) { const r = waiting.get(m.id); waiting.delete(m.id); r(m); return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, serverInfo: { name: 'e', version: '0' }, capabilities: { tools: {} } } });
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'edit', inputSchema: { type: 'object' }, _meta: { 'alexia/provides': ['image.edit'], 'alexia/editor': {} } }] } });
  else if (m.method === 'tools/call') {
    const meta = m.params._meta || {};
    const a = m.params.arguments || {};
    const seen = {
      call: a.call, conversationId: a.conversationId, picture: a.picture,
      context: (meta['alexia/call-context'] || {}).conversationId,
      private: (meta['alexia/privateContext'] || {}).protocol,
    };
    if (a.call === 'preview') {
      const file = path.join(process.cwd(), 'preview-' + Date.now() + '-' + Math.random() + '.png');
      fs.writeFileSync(file, Buffer.from(a.bytes, 'base64'));
      const r = await ask('alexia/attachments/share', { conversationId: a.conversationId, path: file, mime: 'image/png' });
      send({ id: m.id, result: text({ seen, url: r.result && r.result.url, error: r.error && r.error.message }) });
    } else if (a.call === 'batch') {
      send({ id: m.id, result: text({ code: 'busy_now', message: 'The editor is busy.' }, true) });
    } else if (a.call === 'cleanup') {
      send({ id: m.id, result: text({ local: 'complete', remote: [] }) });
    } else {
      send({ id: m.id, result: text({ seen }) });
    }
  } else send({ id: m.id, result: {} });
});
"#;

/// Never asked: nothing on this screen talks to a model.
struct Silent;

#[async_trait::async_trait]
impl Brain for Silent {
    async fn reply(
        &self,
        _turn: Turn,
        _draft: DraftSink,
        _cancel: CancellationToken,
    ) -> Result<Reply, BrainError> {
        Ok(Reply {
            text: String::new(),
            files: vec![],
            lane: Lane::Task,
            model: None,
            spans: vec![],
        })
    }
}

struct World {
    api: Arc<Api>,
    host: McpHost,
    store: Arc<Store>,
    editor: PluginId,
    port: u16,
    root: PathBuf,
    cancel: CancellationToken,
}

impl Drop for World {
    fn drop(&mut self) {
        self.cancel.cancel();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn scratch(name: &str) -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("alexia-editor-{name}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// `<ext>/<id>/`: the editor plugin.
fn editor_plugin(ext: &Path, id: &str) {
    let dir = ext.join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("plugin.js"), EDITOR).unwrap();
    let m = json!({
        "manifest_version": 1,
        "id": id,
        "name": "Editor",
        "summary": "A plugin that exists for tests.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": "node", "args": ["plugin.js"] },
        "alexia_protocol": 15,
        "mcp_protocol": "2025-11-25",
        "provides": ["image.edit"],
        "requires": [
            { "cap": "attachments.scoped", "why": "To edit the pictures of a conversation." },
            { "cap": "fs.own_dir", "why": "To keep its drafts." }
        ]
    });
    std::fs::write(dir.join("plugin.json"), m.to_string()).unwrap();
}

/// A world with the editor plugin installed, switched on when `on`.
async fn world(name: &str, on: bool) -> World {
    let root = scratch(name);
    let data = root.join("data");
    let ext = root.join("ext");
    std::fs::create_dir_all(&ext).unwrap();
    let editor = PluginId(format!("ed-{name}"));
    editor_plugin(&ext, &editor.0);
    let store = Arc::new(Store::open_in_memory().unwrap());
    let bus = Bus::new(256);
    let host = McpHost::new(
        HostConfig {
            layout: Layout::new(data.clone()),
            plugin_dirs: vec![ext],
            node: PathBuf::from("node"),
            timings: Timings::default(),
        },
        store.clone(),
        Arc::new(NoUpcalls),
        Arc::new(|_| {}),
    );
    let enabled = if on { vec![editor.clone()] } else { vec![] };
    host.start(&enabled).await.unwrap();
    let catalog = Arc::new(Catalog::new(vec![], vec![], root.join("catalog.json")));
    let router = Arc::new(Router::new(vec![], catalog.clone(), store.clone()));
    let channels = ChannelSet::new();
    let asker = Asker::with_window(
        channels.clone(),
        store.clone(),
        bus.clone(),
        WindowQuestions::default(),
    );
    let tooling = Arc::new(McpTooling::new(host.clone(), vec![]));
    let agent = Agent::new(AgentParts {
        router: router.clone(),
        tools: tooling.clone(),
        store: store.clone(),
        bus: bus.clone(),
        ask: asker.clone(),
        checker: Arc::new(Checker::new(None)),
        caps: Arc::new(host.clone()),
        layout: Layout::new(data.clone()),
        limits: Limits::default(),
        host: host.clone(),
    });
    // As the hub does: the plugin's requests (here, `alexia/attachments/share`) reach core.
    host.set_upcalls(agent.clone());
    let brain: Arc<dyn Brain> = Arc::new(Silent);
    let scheduler = Scheduler::new(store.clone(), bus.clone(), brain.clone());
    let (skills, _) = Skills::load(&[]);
    let runtime = Runtime::new(Layout::new(data.clone()), reqwest::Client::new());
    let jobs = LocalJobs::new(runtime.clone(), store.clone(), router.clone());
    let api = Api::new(ApiParts {
        layout: Layout::new(data),
        store: store.clone(),
        bus,
        host: host.clone(),
        tooling,
        agent,
        brain,
        router,
        catalog,
        scheduler,
        asker,
        channels,
        skills: Arc::new(skills),
        runtime,
        jobs,
        ui_dir: None,
        app_version: "3.0.0".into(),
    })
    .unwrap();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    tokio::spawn(api.clone().serve(listener, cancel.clone()));
    World {
        api,
        host,
        store,
        editor,
        port,
        root,
        cancel,
    }
}

// ---- HTTP by hand ----

struct Answer {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Answer {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|_| panic!("not JSON: {}", String::from_utf8_lossy(&self.body)))
    }
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

async fn send(w: &World, method: &str, path: &str, body: Option<&Value>) -> Answer {
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nx-alexia-token: {}\r\n",
        w.port,
        w.api.token()
    );
    let body = body.map(Value::to_string).unwrap_or_default();
    if method != "GET" {
        req.push_str(&format!(
            "content-type: application/json\r\ncontent-length: {}\r\n",
            body.len()
        ));
    }
    req.push_str("\r\n");
    req.push_str(&body);
    let mut s = TcpStream::connect(("127.0.0.1", w.port)).await.unwrap();
    s.write_all(req.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    tokio::time::timeout(WAIT, s.read_to_end(&mut raw))
        .await
        .expect("the server answered in time")
        .unwrap();
    let split = raw
        .windows(4)
        .position(|x| x == b"\r\n\r\n")
        .expect("a full head");
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect();
    let mut rest = raw[split + 4..].to_vec();
    let chunked = headers
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("transfer-encoding") && v.contains("chunked"));
    if chunked {
        let mut out = Vec::new();
        while let Some(end) = rest.windows(2).position(|x| x == b"\r\n") {
            let size = usize::from_str_radix(std::str::from_utf8(&rest[..end]).unwrap().trim(), 16)
                .unwrap();
            if size == 0 {
                break;
            }
            out.extend_from_slice(&rest[end + 2..end + 2 + size]);
            rest.drain(..end + 4 + size);
        }
        rest = out;
    }
    Answer {
        status,
        headers,
        body: rest,
    }
}

async fn post(w: &World, path: &str, body: Value) -> Answer {
    send(w, "POST", path, Some(&body)).await
}

async fn get(w: &World, path: &str) -> Answer {
    send(w, "GET", path, None).await
}

/// 409 with this `code`.
fn refused(a: &Answer, code: &str) {
    assert_eq!(a.status, 409, "{}", String::from_utf8_lossy(&a.body));
    let v = a.json();
    assert_eq!(v["ok"], false);
    assert_eq!(v["code"], code, "{v}");
    assert!(v["said"].as_str().is_some_and(|s| !s.is_empty()), "{v}");
}

// ---- pictures ----

fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = (data.len() as u32).to_be_bytes().to_vec();
    let mut body = kind.to_vec();
    body.extend_from_slice(data);
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32(&body).to_be_bytes());
    out
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut ihdr = width.to_be_bytes().to_vec();
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    out.extend(chunk(b"IHDR", &ihdr));
    out.extend(chunk(b"IDAT", &[0x78, 0x01, 0x00]));
    out.extend(chunk(b"IEND", &[]));
    out
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn private_sessions(w: &World) -> Vec<i64> {
    w.store
        .kv_get("_core", "private_sessions")
        .unwrap()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

// ---- tests ----

#[tokio::test]
async fn editor_call_reaches_capability() {
    let w = world("reach", true).await;
    let chat = w.store.create_session(Some("pictures")).unwrap();
    let id = chat.0.to_string();

    let a = post(
        &w,
        "/api/editor",
        json!({ "conversationId": id, "call": "open", "picture": "att_1" }),
    )
    .await;
    assert_eq!(a.status, 200, "{}", String::from_utf8_lossy(&a.body));
    assert_eq!(a.header("cache-control"), Some("no-store"));
    let v = a.json();
    assert_eq!(v["ok"], true);
    let seen = &v["seen"];
    assert_eq!(seen["call"], "open");
    assert_eq!(seen["picture"], "att_1");
    // The conversation reaches the plugin as an argument and as the call's context.
    assert_eq!(seen["conversationId"], id);
    assert_eq!(seen["context"], id);
    assert_eq!(seen["private"], 15, "the private-context promise is sent");
    // Opening a picture makes the conversation private.
    assert!(private_sessions(&w).contains(&chat.0));

    // A conversation id given as a number is the same conversation.
    let v = post(
        &w,
        "/api/editor",
        json!({ "conversationId": chat.0, "call": "versions" }),
    )
    .await
    .json();
    assert_eq!(v["seen"]["conversationId"], id);

    // The editor's own refusal keeps its code and words.
    let a = post(
        &w,
        "/api/editor",
        json!({ "conversationId": id, "call": "batch" }),
    )
    .await;
    refused(&a, "busy_now");
    assert_eq!(a.json()["said"], "The editor is busy.");

    // Only what the editor does.
    let a = post(
        &w,
        "/api/editor",
        json!({ "conversationId": id, "call": "revoke" }),
    )
    .await;
    refused(&a, "schema_unsupported");

    // Core answers the planner calls itself: no planner on this computer.
    let v = post(
        &w,
        "/api/editor",
        json!({ "conversationId": id, "call": "planners" }),
    )
    .await
    .json();
    assert_eq!(v, json!({ "ok": true, "planners": [], "selected": null }));
    let a = post(
        &w,
        "/api/editor",
        json!({ "conversationId": id, "call": "select_planner", "model": "some-model" }),
    )
    .await;
    refused(&a, "planner_unavailable");

    // With the plugin switched off nothing provides image.edit, and the sentence names none.
    w.host.set_enabled(&w.editor, false).await.unwrap();
    let a = post(
        &w,
        "/api/editor",
        json!({ "conversationId": id, "call": "open" }),
    )
    .await;
    refused(&a, "render_failed");
    let said = a.json()["said"].as_str().unwrap().to_owned();
    assert!(!said.contains(&w.editor.0), "{said}");
}

#[tokio::test]
async fn unknown_conversation_refused() {
    let w = world("unknown", true).await;
    let png = b64(&png(2, 2));
    for (path, body) in [
        (
            "/api/editor",
            json!({ "conversationId": "99999", "call": "open" }),
        ),
        ("/api/editor", json!({ "call": "open" })),
        (
            "/api/editor",
            json!({ "conversationId": "../1", "call": "open" }),
        ),
        (
            "/api/editor/upload",
            json!({ "conversationId": "99999", "name": "a.png", "data": png }),
        ),
        (
            "/api/editor/forget",
            json!({ "conversationId": "99999", "confirm": true }),
        ),
    ] {
        let a = post(&w, path, body).await;
        refused(&a, "context_required");
    }
    let a = get(&w, "/api/editor/picture?conversation=99999&id=att_1").await;
    refused(&a, "context_required");
    assert!(private_sessions(&w).is_empty(), "nothing was marked");
}

#[tokio::test]
async fn shared_file_token_once() {
    let w = world("share", true).await;
    let chat = w
        .store
        .create_session(Some("pictures"))
        .unwrap()
        .0
        .to_string();
    let bytes = png(3, 3);

    let share = |n: u8| {
        let mut b = bytes.clone();
        b.push(n);
        post(
            &w,
            "/api/editor",
            json!({ "conversationId": chat, "call": "preview", "bytes": b64(&b) }),
        )
    };
    let v = share(1).await.json();
    assert_eq!(v["ok"], true, "{v}");
    let url = v["url"]
        .as_str()
        .unwrap_or_else(|| panic!("{v}"))
        .to_owned();
    assert!(url.starts_with("/api/editor/file?token="), "{url}");
    // No path in the link.
    assert!(!url.contains(&w.editor.0) && !url.contains(".png"), "{url}");

    let a = get(&w, &url).await;
    assert_eq!(a.status, 200);
    assert_eq!(a.header("content-type"), Some("image/png"));
    assert_eq!(a.header("cache-control"), Some("no-store"));
    let mut first = bytes.clone();
    first.push(1);
    assert_eq!(a.body, first);

    // Each share is its own token; the first still names the first file.
    let second = share(2).await.json()["url"].as_str().unwrap().to_owned();
    assert_ne!(second, url);
    assert_eq!(get(&w, &url).await.body, first);

    // A token never shared.
    let a = get(&w, "/api/editor/file?token=shr_nobody").await;
    assert_eq!(a.status, 404);
    assert_eq!(a.json()["ok"], false);

    // Forgetting the conversation's pictures forgets its shared files.
    let a = post(
        &w,
        "/api/editor/forget",
        json!({ "conversationId": chat, "confirm": true }),
    )
    .await;
    assert_eq!(a.status, 200, "{}", String::from_utf8_lossy(&a.body));
    let receipt = &a.json()["receipt"];
    assert_eq!(receipt["local"], "complete", "{receipt}");
    assert!(receipt["revocationId"]
        .as_str()
        .unwrap()
        .starts_with("rev_"));
    assert_eq!(get(&w, &url).await.status, 404);
    assert_eq!(get(&w, &second).await.status, 404);
}

#[tokio::test]
async fn picture_of_other_conversation_refused() {
    let w = world("picture", true).await;
    let mine = w.store.create_session(Some("mine")).unwrap();
    let theirs = w
        .store
        .create_session(Some("theirs"))
        .unwrap()
        .0
        .to_string();
    let id = mine.0.to_string();

    let a = post(
        &w,
        "/api/editor/upload",
        json!({ "conversationId": id, "name": "a.png", "data": b64(&png(4, 2)) }),
    )
    .await;
    assert_eq!(a.status, 200, "{}", String::from_utf8_lossy(&a.body));
    let picture = a.json()["picture"].clone();
    assert_eq!(picture["label"], "image_1");
    let pic = picture["id"].as_str().unwrap().to_owned();
    // A picture makes the conversation private.
    assert!(private_sessions(&w).contains(&mine.0));

    // Listed for its conversation, and served to it.
    let v = post(
        &w,
        "/api/editor",
        json!({ "conversationId": id, "call": "pictures" }),
    )
    .await
    .json();
    assert_eq!(v["pictures"][0]["id"], pic.as_str());
    let a = get(
        &w,
        &format!("/api/editor/picture?conversation={id}&id={pic}"),
    )
    .await;
    assert_eq!(a.status, 200);
    assert_eq!(a.header("content-type"), Some("image/png"));
    assert!(a.body.starts_with(&[0x89, b'P', b'N', b'G']));

    // Never to another.
    let a = get(
        &w,
        &format!("/api/editor/picture?conversation={theirs}&id={pic}"),
    )
    .await;
    refused(&a, "attachment_unavailable");
    let v = post(
        &w,
        "/api/editor",
        json!({ "conversationId": theirs, "call": "pictures" }),
    )
    .await
    .json();
    assert_eq!(v["pictures"], json!([]));

    // Not a picture, and nothing at all.
    let a = post(
        &w,
        "/api/editor/upload",
        json!({ "conversationId": id, "name": "a.png", "data": b64(b"not a picture") }),
    )
    .await;
    refused(&a, "input_limit");
    let a = post(
        &w,
        "/api/editor/upload",
        json!({ "conversationId": id, "data": "" }),
    )
    .await;
    refused(&a, "input_limit");

    // Forgotten: gone from the list and from the route.
    let a = post(
        &w,
        "/api/editor/forget",
        json!({ "conversationId": id, "confirm": true }),
    )
    .await;
    assert_eq!(a.status, 200);
    let a = get(
        &w,
        &format!("/api/editor/picture?conversation={id}&id={pic}"),
    )
    .await;
    refused(&a, "attachment_unavailable");
}

#[tokio::test]
async fn state_installed_flag() {
    let w = world("state", false).await;
    let editor = |a: Answer| {
        assert_eq!(a.status, 200);
        a.json()["editor"].clone()
    };
    let session = w.api.session().0.to_string();
    let e = editor(get(&w, "/api/state").await);
    assert_eq!(e["installed"], false);
    assert_eq!(e["conversationId"], session);
    assert_eq!(e["private"], false);

    // Switched on, the manifest's promise is enough: nothing is started to answer.
    w.host.set_enabled(&w.editor, true).await.unwrap();
    let e = editor(get(&w, "/api/state").await);
    assert_eq!(e["installed"], true);

    // A picture in the open chat makes it private.
    post(
        &w,
        "/api/editor/upload",
        json!({ "conversationId": session, "name": "a.png", "data": b64(&png(2, 2)) }),
    )
    .await;
    assert_eq!(editor(get(&w, "/api/state").await)["private"], true);

    w.host.set_enabled(&w.editor, false).await.unwrap();
    assert_eq!(editor(get(&w, "/api/state").await)["installed"], false);
}
