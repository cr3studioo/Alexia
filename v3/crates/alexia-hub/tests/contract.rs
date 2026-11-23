// SPDX-License-Identifier: AGPL-3.0-only
//! P2D-02: the contract. Every INVENTORY row has a recorded case in `tests/contract/*.json`
//! (a request and v2's answer, as a shape); this replays the cases marked `"hub": "answers"`
//! against the real `alexia-hub run` and compares shapes. Cases marked `"pending"` are
//! counted and listed, not run: each area task flips its own rows. Replay only: it needs no
//! Node and no network (`tools/record-v2.mjs` does the recording, by hand).
//!
//! Run with `-- --nocapture` to see the pending counts.

mod common;

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_store::{Layout, Role, Store};
use common::{
    answer, call, command, exchange, last_user_text, listen, lock, read_req, scratch, window, Hub,
    Window,
};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream as TokioStream;

/// The case files, in the order the replay (and v2's recording) runs them.
const AREAS: [&str; 9] = [
    "gate",
    "state",
    "chat",
    "plugins",
    "board",
    "library",
    "local_models",
    "compute",
    "editor",
];

fn contract_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("contract")
}

fn load(area: &str) -> Value {
    let file = contract_dir().join(format!("{area}.json"));
    let text = std::fs::read_to_string(&file).unwrap_or_else(|e| panic!("{}: {e}", file.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", file.display()))
}

// ---- shapes ----

/// v2's JSON with every leaf replaced by its type name, objects by their key set, arrays by
/// the shape of their first element (`[]` if empty). The same function `record-v2.mjs` has.
fn shape_of(v: &Value) -> Value {
    match v {
        Value::Null => json!("null"),
        Value::Bool(_) => json!("bool"),
        Value::Number(_) => json!("number"),
        Value::String(_) => json!("string"),
        Value::Array(a) => a
            .first()
            .map_or_else(|| json!([]), |x| json!([shape_of(x)])),
        Value::Object(m) => {
            Value::Object(m.iter().map(|(k, x)| (k.clone(), shape_of(x))).collect())
        }
    }
}

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// One difference: where, what the shape says, what the hub sent.
#[derive(Debug, PartialEq)]
struct Mismatch {
    path: String,
    expected: String,
    got: String,
}

/// The pointers a comparison leaves out (`ignore`) or lets be absent (`optional`).
struct Rules<'a> {
    ignore: &'a [String],
    optional: &'a [String],
}

/// `pointer` against a pattern: same segments, `*` matches any one segment.
fn pointer_matches(pattern: &str, pointer: &str) -> bool {
    let (p, q): (Vec<&str>, Vec<&str>) =
        (pattern.split('/').collect(), pointer.split('/').collect());
    p.len() == q.len() && p.iter().zip(&q).all(|(a, b)| *a == "*" || a == b)
}

impl Rules<'_> {
    fn ignored(&self, pointer: &str) -> bool {
        self.ignore.iter().any(|p| pointer_matches(p, pointer))
    }
    fn optional(&self, pointer: &str) -> bool {
        self.optional.iter().any(|p| pointer_matches(p, pointer))
    }
}

/// Compares `actual` with the shape `expected`: same key set at every object, same leaf type,
/// arrays elementwise up to the shorter (a shape holds one element, so the first). A key under
/// an `optional` pointer may be absent on either side; `ignore`d pointers are left out.
fn compare(expected: &Value, actual: &Value, rules: &Rules) -> Vec<Mismatch> {
    let mut out = Vec::new();
    walk(expected, actual, "", rules, &mut out);
    out
}

fn walk(expected: &Value, actual: &Value, at: &str, rules: &Rules, out: &mut Vec<Mismatch>) {
    if rules.ignored(at) {
        return;
    }
    let mismatch = |out: &mut Vec<Mismatch>, expected: &str| {
        out.push(Mismatch {
            path: if at.is_empty() { "/".into() } else { at.into() },
            expected: expected.into(),
            got: type_name(actual).into(),
        });
    };
    match expected {
        Value::String(t) => {
            if t != type_name(actual) {
                mismatch(out, t);
            }
        }
        Value::Object(want) => {
            let Some(have) = actual.as_object() else {
                return mismatch(out, "object");
            };
            for (k, e) in want {
                let child = format!("{at}/{k}");
                match have.get(k) {
                    Some(a) => walk(e, a, &child, rules, out),
                    None if rules.optional(&child) || rules.ignored(&child) => {}
                    None => out.push(Mismatch {
                        path: child,
                        expected: "a key".into(),
                        got: "missing".into(),
                    }),
                }
            }
            for k in have.keys().filter(|k| !want.contains_key(*k)) {
                let child = format!("{at}/{k}");
                if !rules.optional(&child) && !rules.ignored(&child) {
                    out.push(Mismatch {
                        path: child,
                        expected: "no such key".into(),
                        got: "a key".into(),
                    });
                }
            }
        }
        Value::Array(want) => {
            let Some(have) = actual.as_array() else {
                return mismatch(out, "array");
            };
            for (i, (e, a)) in want.iter().zip(have).enumerate() {
                walk(e, a, &format!("{at}/{i}"), rules, out);
            }
        }
        other => mismatch(out, &other.to_string()),
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// The SSE frames expected against the frames that came, in order. A frame marked `optional`
/// may be absent; one marked `repeat` stands for one or more in a row; `optional_keys` and
/// `ignore` are pointers inside that frame.
fn compare_stream(expected: &[Value], actual: &[Value]) -> Vec<Mismatch> {
    let mut out = Vec::new();
    let mut i = 0;
    let frame_ok = |want: &Value, got: &Value| {
        let (ignore, optional) = (strings(&want["ignore"]), strings(&want["optional_keys"]));
        let rules = Rules {
            ignore: &ignore,
            optional: &optional,
        };
        compare(&want["shape"], got, &rules).is_empty()
    };
    for (n, want) in expected.iter().enumerate() {
        let wants_more = want["repeat"] == json!(true);
        let skippable = want["optional"] == json!(true);
        match actual.get(i) {
            Some(got) if frame_ok(want, got) => {
                i += 1;
                while wants_more && actual.get(i).is_some_and(|g| frame_ok(want, g)) {
                    i += 1;
                }
            }
            _ if skippable => {}
            Some(got) => {
                let (ignore, optional) =
                    (strings(&want["ignore"]), strings(&want["optional_keys"]));
                let rules = Rules {
                    ignore: &ignore,
                    optional: &optional,
                };
                for m in compare(&want["shape"], got, &rules) {
                    out.push(Mismatch {
                        path: format!("stream[{n}] (frame {i}){}", m.path),
                        ..m
                    });
                }
                i += 1;
            }
            None => out.push(Mismatch {
                path: format!("stream[{n}]"),
                expected: want["shape"].to_string(),
                got: "the stream ended".into(),
            }),
        }
    }
    for (k, extra) in actual.iter().enumerate().skip(i) {
        out.push(Mismatch {
            path: format!("stream (frame {k})"),
            expected: "no more frames".into(),
            got: extra.to_string(),
        });
    }
    out
}

// ---- the window, and SSE read as it comes ----

fn target_of(req: &Value) -> String {
    let encode = |s: &str| {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect::<String>()
    };
    let query: Vec<String> = req["query"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| format!("{}={}", encode(k), encode(v.as_str().unwrap_or(""))))
        .collect();
    let path = req["path"].as_str().unwrap_or("/");
    if query.is_empty() {
        path.to_owned()
    } else {
        format!("{path}?{}", query.join("&"))
    }
}

/// A body is JSON text, or (when the case gives a string) sent as it is: that is how a case
/// says "a body that is not JSON".
fn body_of(req: &Value) -> Option<Vec<u8>> {
    match &req["body"] {
        Value::Null => None,
        Value::String(s) => Some(s.clone().into_bytes()),
        other => Some(other.to_string().into_bytes()),
    }
}

fn send(w: &Window, req: &Value) -> (u16, String, Vec<u8>) {
    let host = req["host"].as_str().unwrap_or("127.0.0.1");
    let token = (req["token"] == json!(true)).then_some(w.token.as_str());
    exchange(
        w.port,
        req["method"].as_str().unwrap_or("GET"),
        &target_of(req),
        &format!("{host}:{}", w.port),
        token,
        body_of(req).as_deref(),
    )
}

/// An open `text/event-stream` answer, read frame by frame.
struct Sse {
    sock: TcpStream,
    buf: Vec<u8>,
    status: u16,
    kind: String,
}

impl Sse {
    fn open(w: &Window, req: &Value) -> Sse {
        let mut sock = TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], w.port)),
            Duration::from_secs(10),
        )
        .expect("the window's port accepts a connection");
        sock.set_read_timeout(Some(Duration::from_secs(60)))
            .unwrap();
        let body = body_of(req);
        let mut head = format!(
            "{} {} HTTP/1.0\r\nHost: 127.0.0.1:{}\r\n",
            req["method"].as_str().unwrap_or("POST"),
            target_of(req),
            w.port
        );
        if req["token"] == json!(true) {
            head.push_str(&format!("x-alexia-token: {}\r\n", w.token));
        }
        if let Some(b) = &body {
            head.push_str(&format!(
                "content-type: application/json\r\ncontent-length: {}\r\n",
                b.len()
            ));
        }
        head.push_str("\r\n");
        sock.write_all(head.as_bytes()).unwrap();
        if let Some(b) = &body {
            sock.write_all(b).unwrap();
        }
        let mut s = Sse {
            sock,
            buf: Vec::new(),
            status: 0,
            kind: String::new(),
        };
        let end = loop {
            if let Some(p) = s.buf.windows(4).position(|x| x == b"\r\n\r\n") {
                break p;
            }
            assert!(
                s.fill() > 0,
                "the stream ended before its head: {:?}",
                String::from_utf8_lossy(&s.buf)
            );
        };
        let head = String::from_utf8_lossy(&s.buf[..end]).into_owned();
        s.buf.drain(..end + 4);
        s.status = head
            .split_whitespace()
            .nth(1)
            .and_then(|x| x.parse().ok())
            .unwrap_or(0);
        s.kind = head
            .lines()
            .find_map(|l| {
                let (k, v) = l.split_once(':')?;
                k.eq_ignore_ascii_case("content-type")
                    .then(|| v.split(';').next().unwrap_or("").trim().to_owned())
            })
            .unwrap_or_default();
        s
    }

    fn fill(&mut self) -> usize {
        let mut tmp = [0u8; 4096];
        match self.sock.read(&mut tmp) {
            Ok(n) => {
                self.buf.extend_from_slice(&tmp[..n]);
                n
            }
            Err(_) => 0,
        }
    }

    /// The next `data: <json>` frame, or None when the stream is over (or went quiet for 60 s).
    fn next(&mut self) -> Option<Value> {
        loop {
            if let Some(p) = self.buf.windows(2).position(|x| x == b"\n\n") {
                let block = String::from_utf8_lossy(&self.buf[..p]).into_owned();
                self.buf.drain(..p + 2);
                let Some(line) = block.lines().find_map(|l| l.strip_prefix("data: ")) else {
                    continue;
                };
                return serde_json::from_str(line).ok();
            }
            if self.fill() == 0 {
                return None;
            }
        }
    }
}

// ---- the world a setup set asks for ----

/// A UI folder with the files `uiFiles()` in `record-v2.mjs` writes: the token is in `index.html`.
fn write_ui(root: &Path) -> PathBuf {
    let ui = root.join("ui");
    let files = [
        ("index.html", "<!doctype html><script type=\"module\" src=\"/main.js\" data-token=\"__TOKEN__\"></script>\n"),
        ("app.css", "body { margin: 0 }\n"),
        ("dist/src/main.js", "export {}\n"),
        ("alexia-mark.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"><path d=\"M0 0h1v1z\"/></svg>\n"),
    ];
    for (name, text) in files {
        let file = ui.join(name);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }
    ui
}

fn fixture_exe() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let path = exe
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .join(format!("mcp-fixture{}", std::env::consts::EXE_SUFFIX));
    assert!(
        path.is_file(),
        "run `cargo build -p alexia-mcp --bins` first"
    );
    path
}

/// The manifest of the `plugins` fixture: settings and panel widgets of every v2 widget type.
fn widgets_manifest(exe: &str) -> Value {
    json!({
        "manifest_version": 1,
        "id": "widgets",
        "name": "Widgets",
        "summary": "Declares one widget of every type, for the contract.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": exe, "args": ["greet"] },
        "alexia_protocol": 15,
        "mcp_protocol": "2025-11-25",
        "settings": [
            { "type": "research", "key": "research_view", "label": "Research" },
            { "type": "text", "key": "nickname", "label": "Nickname", "default": "Ada" },
            { "type": "password", "key": "secret", "label": "Secret" },
            { "type": "number", "key": "count", "label": "Count", "default": 3, "min": 0, "max": 9 },
            { "type": "toggle", "key": "allow_input", "label": "Allow input", "default": false },
            { "type": "choice", "key": "colour", "label": "Colour", "options": ["red", "blue"], "default": "red" },
            { "type": "multi-choice", "key": "tags", "label": "Tags", "options": ["a", "b"], "default": ["a"] },
            { "type": "path", "key": "folder", "label": "Folder", "kind": "dir" },
            { "type": "file", "key": "upload", "label": "Upload", "accept": ".txt" },
            { "type": "status", "key": "state", "label": "State" },
            { "type": "progress", "key": "progress", "label": "Progress" },
            { "type": "action", "key": "greet_now", "label": "Greet", "tool": "greet" }
        ],
        "panel": {
            "label": "Widgets",
            "widgets": [
                { "type": "table", "key": "people", "label": "People", "rows": "greet",
                  "columns": [{ "key": "name", "label": "Name" }] },
                { "type": "graph", "key": "links", "label": "Links", "rows": "greet" },
                { "type": "tree", "key": "folders", "label": "Folders", "rows": "greet" },
                { "type": "cards", "key": "notes", "label": "Notes", "rows": "greet" },
                { "type": "image", "key": "picture", "label": "Picture", "rows": "greet" }
            ]
        }
    })
}

/// `<plugins>/<id>/` with a copy of the fixture running in `mode` and `manifest`.
fn install_fixture(plugins: &Path, id: &str, mode: &str, manifest: impl FnOnce(&str) -> Value) {
    let dir = plugins.join(id);
    std::fs::create_dir_all(&dir).unwrap();
    let src = fixture_exe();
    let exe = src.file_name().unwrap().to_str().unwrap();
    std::fs::copy(&src, dir.join(exe)).unwrap();
    let mut m = manifest(exe);
    if m["entry"]["args"] == json!(["greet"]) {
        m["entry"]["args"] = json!([mode]);
    }
    std::fs::write(dir.join("plugin.json"), m.to_string()).unwrap();
}

fn plain_manifest(id: &str, exe: &str, mode: &str) -> Value {
    json!({
        "manifest_version": 1, "id": id, "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.", "version": "0.1.0",
        "license": "AGPL-3.0-only", "entry": { "run": exe, "args": [mode] },
        "alexia_protocol": 2, "mcp_protocol": "2025-11-25"
    })
}

/// `chat`: one session with two messages, written before the hub opens its store.
fn seed_chat(data: &Path) {
    let store = Store::open(&Layout::new(data.to_path_buf()).db()).unwrap();
    let id = store.create_session(Some("Hello")).unwrap();
    for (role, text) in [
        (Role::User, "Hello there."),
        (Role::Assistant, "Hello. How can I help?"),
    ] {
        let body = serde_json::from_value(json!({ "content": text })).unwrap();
        store.append(id, role, None, &body).unwrap();
    }
}

// ---- the scripted provider (`scripted`) ----

/// One keyless OpenAI-compatible provider whose one model can use tools. On a request that
/// offers tools: a tool result already there → "Done."; the text says "ask" → `set` (a call that
/// asks first); "work" → `greet` `{"who":"progress"}` (which reports progress); anything else → "Hello.". Any other
/// request (the chat lane, a helper) → "Noted.".
struct Provider {
    base: String,
    chats: Mutex<Vec<Value>>,
}

fn scripted_reply(body: &Value) -> Result<String, (String, Value)> {
    // This turn's tool results: those after the last user message.
    let results = body["messages"].as_array().map_or(0, |m| {
        m.iter()
            .rev()
            .take_while(|m| m["role"] != "user")
            .filter(|m| m["role"] == "tool")
            .count()
    });
    let text = last_user_text(body);
    if body["tools"].as_array().is_none_or(Vec::is_empty) {
        return Ok("Noted.".into());
    }
    if results > 0 {
        return Ok("Done.".into());
    }
    if text.contains("ask") {
        Err(("set".into(), json!({"key": "colour", "value": "blue"})))
    } else if text.contains("work") {
        Err(("greet".into(), json!({"who": "progress"})))
    } else {
        Ok("Hello.".into())
    }
}

async fn provider() -> Arc<Provider> {
    let (listener, base) = listen().await;
    let p = Arc::new(Provider {
        base: format!("{base}/v1"),
        chats: Mutex::default(),
    });
    let state = p.clone();
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            let _ = sock.set_nodelay(true);
            tokio::spawn(provider_conn(state.clone(), sock));
        }
    });
    p
}

async fn provider_conn(p: Arc<Provider>, mut sock: TokioStream) {
    let mut buf = Vec::new();
    while let Some(req) = read_req(&mut sock, &mut buf).await {
        if req.path.ends_with("/models") {
            let list =
                json!({"data": [{"id": "fake-tools-70b", "supported_parameters": ["tools"]}]});
            if !answer(&mut sock, &list.to_string()).await {
                return;
            }
            continue;
        }
        let body = req.json();
        lock(&p.chats).push(body.clone());
        let frame = |delta: Value, finish: Value| {
            let f = json!({"model": "fake-tools-70b", "choices": [{"delta": delta, "finish_reason": finish}]});
            format!("data: {f}\n\n")
        };
        let frames = match scripted_reply(&body) {
            Ok(text) => format!(
                "{}{}",
                frame(json!({"content": text}), Value::Null),
                frame(json!({}), json!("stop"))
            ),
            Err((suffix, args)) => {
                let suffix = suffix.replace('.', "_");
                let name = body["tools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|t| t["function"]["name"].as_str())
                    .find(|n| n.ends_with(&suffix))
                    .unwrap_or_else(|| panic!("the request offers no tool {suffix}: {body}"))
                    .to_owned();
                let call = json!([{
                    "index": 0, "id": format!("call-{}", lock(&p.chats).len()), "type": "function",
                    "function": {"name": name, "arguments": args.to_string()},
                }]);
                format!(
                    "{}{}",
                    frame(json!({"tool_calls": call}), Value::Null),
                    frame(json!({}), json!("tool_calls"))
                )
            }
        };
        let all = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n{frames}data: [DONE]\n\n"
        );
        let _ = sock.write_all(all.as_bytes()).await;
        let _ = sock.flush().await;
        return;
    }
}

/// P2D-08: a static-layout registry (`/v0/*.json`) with one coming-soon row and nothing to
/// download, so the library rows are replayed offline. Any other path is a 404.
async fn shelf() -> String {
    let (listener, base) = listen().await;
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = Vec::new();
                while let Some(req) = read_req(&mut sock, &mut buf).await {
                    let body = match req.path.as_str() {
                        "/v0/plugins.json" => json!({"plugins": [{"id": "voice", "name": "Voice",
                            "summary": "Talk to Alexia.", "coming_soon": true}]}),
                        "/v0/skills.json" => json!({"skills": []}),
                        "/v0/revoked.json" => json!({"plugins": [], "skills": []}),
                        _ => {
                            let none = "HTTP/1.1 404 Not Found
content-length: 0

";
                            let _ = sock.write_all(none.as_bytes()).await;
                            continue;
                        }
                    };
                    if !answer(&mut sock, &body.to_string()).await {
                        return;
                    }
                }
            });
        }
    });
    format!("{base}/")
}

/// The hub for one setup set: fixtures applied to a scratch folder, then started.
async fn start(name: &str, setup: &[String]) -> (Hub, Window, PathBuf, Option<Arc<Provider>>) {
    let root = scratch(name);
    let (data, plugins) = (root.join("data"), root.join("plugins"));
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&plugins).unwrap();
    let has = |s: &str| setup.iter().any(|x| x == s);
    if has("chat") {
        seed_chat(&data);
    }
    if has("plugins") {
        install_fixture(&plugins, "widgets", "greet", widgets_manifest);
    }
    let mut c = command(&root);
    c.env("ALEXIA_UI_DIR", write_ui(&root))
        .env("ALEXIA_LIBRARY_REGISTRY", shelf().await)
        .env_remove("ALEXIA_WINDOW_PORT");
    let mut prov = None;
    if has("scripted") {
        install_fixture(&plugins, "fixture", "compute", |exe| {
            plain_manifest("fixture", exe, "compute")
        });
        install_fixture(&plugins, "undoable", "undoable", |exe| {
            plain_manifest("undoable", exe, "undoable")
        });
        // `compute` tools are never offered to the model; `greet` reports progress and is.
        install_fixture(&plugins, "greeter", "greet", |exe| {
            plain_manifest("greeter", exe, "greet")
        });
        let p = provider().await;
        let file = root.join("providers.json");
        let row = json!([{"id": "fakep", "base_url": p.base, "models_path": "/models", "auth": "none", "all_free": true}]);
        std::fs::write(&file, row.to_string()).unwrap();
        c.env("ALEXIA_FREE_PROVIDERS", file);
        prov = Some(p);
    }
    let hub = Hub::run(c);
    hub.up().await;
    let w = window(&data);
    (hub, w, root, prov)
}

// ---- the replay ----

fn describe(case: &Value, area: &str) -> String {
    format!(
        "{area}.json {} “{}”",
        case["row"].as_str().unwrap_or("?"),
        case["name"].as_str().unwrap_or("?")
    )
}

/// One case against the window; what differs, as lines.
fn replay(w: &Window, case: &Value) -> Vec<Mismatch> {
    let want = &case["response"];
    let behind = (!case["behind"].is_null()).then(|| {
        let mut first = Sse::open(w, &case["behind"]);
        while let Some(frame) = first.next() {
            if frame.get("ask").is_some() {
                break;
            }
        }
        first
    });
    let mut out = Vec::new();
    let (status, kind, got_body, frames) = if case["stream"].is_array() {
        let mut s = Sse::open(w, &case["request"]);
        let mut frames = Vec::new();
        let mut during = case["during"].as_array().cloned().unwrap_or_default();
        while let Some(frame) = s.next() {
            if frame.get("ask").is_some() {
                for req in during.drain(..) {
                    send(w, &req);
                }
            }
            frames.push(frame);
        }
        (s.status, s.kind.clone(), Vec::new(), Some(frames))
    } else {
        let (status, kind, body) = send(w, &case["request"]);
        (status, kind, body, None)
    };
    if let Some(mut first) = behind {
        call(w, "POST", "/api/approve", Some(&json!({"allowed": false})));
        while first.next().is_some() {}
    }

    let mut push = |path: &str, expected: Value, got: Value| {
        out.push(Mismatch {
            path: path.into(),
            expected: expected.to_string(),
            got: got.to_string(),
        });
    };
    if u64::from(status) != want["status"].as_u64().unwrap_or(0) {
        push("status", want["status"].clone(), json!(status));
    }
    if kind != want["type"].as_str().unwrap_or("") {
        push("content-type", want["type"].clone(), json!(kind));
    }
    if let Some(frames) = frames {
        let expected = case["stream"].as_array().unwrap();
        out.extend(compare_stream(expected, &frames));
    } else if let Some(text) = want["text"].as_str() {
        let text_got = String::from_utf8_lossy(&got_body).into_owned();
        if text != text_got {
            push("body", json!(text), json!(text_got));
        }
    } else if kind == "application/json" && want.get("shape").is_some_and(|s| !s.is_null()) {
        match serde_json::from_slice::<Value>(&got_body) {
            Ok(v) => {
                let (ignore, optional) = (strings(&want["ignore"]), strings(&want["optional"]));
                out.extend(compare(
                    &want["shape"],
                    &v,
                    &Rules {
                        ignore: &ignore,
                        optional: &optional,
                    },
                ));
            }
            Err(e) => push(
                "body",
                json!("JSON"),
                json!(format!(
                    "not JSON ({e}): {}",
                    String::from_utf8_lossy(&got_body)
                )),
            ),
        }
    }
    out
}

/// Every case of every file, as (area, case).
fn all_cases() -> Vec<(String, Value)> {
    AREAS
        .iter()
        .flat_map(|a| {
            let file = load(a);
            assert_eq!(file["area"], json!(a), "{a}.json names another area");
            file["cases"]
                .as_array()
                .unwrap_or_else(|| panic!("{a}.json has no cases"))
                .iter()
                .map(|c| ((*a).to_owned(), c.clone()))
                .collect::<Vec<_>>()
        })
        .collect()
}

fn setup_of(case: &Value) -> Vec<String> {
    let mut s: Vec<String> = strings(&case["setup"])
        .into_iter()
        .filter(|x| x != "fresh")
        .collect();
    s.sort();
    s.dedup();
    s
}

#[test]
fn contract() {
    let cases = all_cases();

    // What is still to do, per area: rows with no case that answers.
    let mut pending: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    let mut answering: BTreeMap<String, usize> = BTreeMap::new();
    for (area, c) in &cases {
        let row = c["row"].as_str().unwrap().to_owned();
        match c["hub"].as_str() {
            Some("answers") => *answering.entry(row).or_default() += 1,
            Some("pending") => {
                *pending
                    .entry(area.clone())
                    .or_default()
                    .entry(row)
                    .or_default() += 1
            }
            other => panic!(
                "{}: \"hub\" must be pending or answers, not {other:?}",
                describe(c, area)
            ),
        }
    }
    let rows_pending: Vec<(&String, Vec<&String>)> = pending
        .iter()
        .map(|(a, rows)| {
            (
                a,
                rows.keys()
                    .filter(|r| !answering.contains_key(*r))
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    let total: usize = rows_pending.iter().map(|(_, r)| r.len()).sum();
    println!("pending: {total}");
    for (area, rows) in &rows_pending {
        if !rows.is_empty() {
            let list: Vec<&str> = rows.iter().map(|r| r.as_str()).collect();
            println!("  {area}: {} ({})", rows.len(), list.join(" "));
        }
    }

    // The cases that answer, grouped by the world they need.
    let mut groups: BTreeMap<Vec<String>, Vec<(String, Value)>> = BTreeMap::new();
    for (area, c) in cases {
        if c["hub"] == json!("answers") {
            groups.entry(setup_of(&c)).or_default().push((area, c));
        }
    }
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let mut failures: Vec<String> = Vec::new();
    let mut ran = 0;
    for (n, (setup, group)) in groups.iter().enumerate() {
        rt.block_on(async {
            let (mut hub, w, root, _provider) = start(&format!("contract-{n}"), setup).await;
            for (area, case) in group {
                ran += 1;
                for m in replay(&w, case) {
                    failures.push(format!(
                        "{}: {}: expected {}, got {}",
                        describe(case, area),
                        m.path,
                        m.expected,
                        m.got
                    ));
                }
            }
            if !failures.is_empty() {
                failures.push(hub.log());
            }
            let code = hub.stop().await;
            if code != Some(0) {
                failures.push(format!("the hub for setup {setup:?} stopped with {code:?}"));
            }
            let _ = std::fs::remove_dir_all(&root);
        });
    }
    println!("replayed: {ran} case(s) against the hub");
    assert!(
        failures.is_empty(),
        "{} difference(s):\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// INVENTORY.md's row ids: the first cell of a table row that is a letter and a number.
fn inventory_rows() -> Vec<String> {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../specs/P2D/INVENTORY.md");
    let text = std::fs::read_to_string(&file).unwrap_or_else(|e| panic!("{}: {e}", file.display()));
    text.lines()
        .filter_map(|l| l.strip_prefix('|'))
        .filter_map(|l| l.split('|').next())
        .map(str::trim)
        .filter(|id| {
            let mut c = id.chars();
            c.next().is_some_and(|l| "SACPBLMRET".contains(l))
                && id.len() > 1
                && id[1..].chars().all(|d| d.is_ascii_digit())
        })
        .filter(|id| !["T1", "T2", "T3", "T5"].contains(id))
        .map(str::to_owned)
        .collect()
}

#[test]
fn every_row_has_a_case() {
    let rows = inventory_rows();
    assert!(
        rows.len() >= 76,
        "INVENTORY.md gave only {} rows: {rows:?}",
        rows.len()
    );
    let have: std::collections::BTreeSet<String> = all_cases()
        .iter()
        .map(|(_, c)| c["row"].as_str().unwrap_or("").to_owned())
        .collect();
    let missing: Vec<&String> = rows.iter().filter(|r| !have.contains(*r)).collect();
    assert!(missing.is_empty(), "rows with no case: {missing:?}");
    // And no case names a row that is not in the inventory.
    let unknown: Vec<&String> = have.iter().filter(|r| !rows.contains(*r)).collect();
    assert!(
        unknown.is_empty(),
        "cases for rows INVENTORY.md does not have: {unknown:?}"
    );
}

#[test]
fn case_files_are_well_formed() {
    for (area, c) in all_cases() {
        let who = describe(&c, &area);
        assert!(
            matches!(c["source"].as_str(), Some("v2" | "hand")),
            "{who}: source"
        );
        if c["source"] == json!("hand") {
            assert!(
                c["from"].as_str().is_some_and(|f| !f.is_empty()),
                "{who}: a hand case names its lines in \"from\""
            );
        }
        assert!(
            c["request"]["method"].is_string() && c["request"]["path"].is_string(),
            "{who}: request"
        );
        assert!(c["response"]["status"].is_u64(), "{who}: response.status");
        assert!(
            c["setup"].as_array().is_some_and(|s| !s.is_empty()),
            "{who}: setup"
        );
        for s in strings(&c["setup"]) {
            assert!(
                ["fresh", "chat", "plugins", "scripted"].contains(&s.as_str()),
                "{who}: unknown setup {s}"
            );
        }
        if c["response"]["type"] == json!("text/event-stream") {
            assert!(
                c["stream"].is_array(),
                "{who}: an SSE answer lists its frames"
            );
        }
    }
}

#[test]
fn shape_matcher_unit() {
    let none: Vec<String> = Vec::new();
    let plain = Rules {
        ignore: &none,
        optional: &none,
    };

    // shape_of: leaves by type, objects by keys, arrays by their first element.
    let v = json!({"a": 1, "b": "x", "c": [true, false], "d": [], "e": null, "f": {"g": 2.5}});
    assert_eq!(
        shape_of(&v),
        json!({"a": "number", "b": "string", "c": ["bool"], "d": [], "e": "null", "f": {"g": "number"}})
    );

    // The same shape: no difference, whatever the values.
    assert!(compare(
        &shape_of(&v),
        &json!({"a": 9, "b": "", "c": [false], "d": [1], "e": null, "f": {"g": 0}}),
        &plain
    )
    .is_empty());

    // A type mismatch is reported with its pointer.
    let got = compare(
        &json!({"a": {"b": ["string"]}}),
        &json!({"a": {"b": [7]}}),
        &plain,
    );
    assert_eq!(
        got,
        vec![Mismatch {
            path: "/a/b/0".into(),
            expected: "string".into(),
            got: "number".into()
        }]
    );

    // Key sets must be equal, in both directions.
    let got = compare(&json!({"a": "number"}), &json!({"b": 1}), &plain);
    assert_eq!(got.len(), 2, "{got:?}");
    assert!(got.iter().any(|m| m.path == "/a" && m.got == "missing"));
    assert!(got
        .iter()
        .any(|m| m.path == "/b" && m.expected == "no such key"));

    // An optional key may be absent, and present too.
    let optional = vec!["/k".to_owned()];
    let rules = Rules {
        ignore: &none,
        optional: &optional,
    };
    assert!(compare(
        &json!({"a": "number", "k": "string"}),
        &json!({"a": 1}),
        &rules
    )
    .is_empty());
    assert!(compare(
        &json!({"a": "number", "k": "string"}),
        &json!({"a": 1, "k": "x"}),
        &rules
    )
    .is_empty());
    assert_eq!(
        compare(
            &json!({"a": "number", "k": "string"}),
            &json!({"a": 1, "k": 2}),
            &rules
        )
        .len(),
        1
    );
    // A key the shape does not have, under an optional pointer, is tolerated.
    assert!(compare(&json!({"a": "number"}), &json!({"a": 1, "k": 2}), &rules).is_empty());

    // `ignore` with `*`: any index, any key.
    let ignore = vec!["/messages/*/at".to_owned(), "/by/*".to_owned()];
    let rules = Rules {
        ignore: &ignore,
        optional: &none,
    };
    let want = json!({"messages": [{"text": "string", "at": "number"}], "by": {"x": "string"}});
    let got = json!({"messages": [{"text": "hi", "at": "yesterday"}, {"text": "yo", "at": null}], "by": {"x": 5, "y": 6}});
    assert!(
        compare(&want, &got, &rules).is_empty(),
        "{:?}",
        compare(&want, &got, &rules)
    );
    // ... but only what it names.
    let got = json!({"messages": [{"text": 1, "at": 1}], "by": {}});
    assert_eq!(
        compare(&want, &got, &rules),
        vec![Mismatch {
            path: "/messages/0/text".into(),
            expected: "string".into(),
            got: "number".into()
        }]
    );

    // Arrays of unequal length: up to the shorter, so empty on either side is fine.
    assert!(compare(&json!({"r": []}), &json!({"r": [1, "two", null]}), &plain).is_empty());
    assert!(compare(&json!({"r": ["number"]}), &json!({"r": []}), &plain).is_empty());
    assert!(compare(&json!({"r": ["number"]}), &json!({"r": [1, 2, 3]}), &plain).is_empty());
    assert_eq!(
        compare(&json!({"r": ["number"]}), &json!({"r": ["x", "y"]}), &plain).len(),
        1
    );
    // An array where an object belongs, and the other way.
    assert_eq!(
        compare(&json!({"r": {}}), &json!({"r": []}), &plain)[0].expected,
        "object"
    );
    assert_eq!(
        compare(&json!({"r": []}), &json!({"r": {}}), &plain)[0].expected,
        "array"
    );

    assert!(pointer_matches("/a/*/c", "/a/0/c"));
    assert!(!pointer_matches("/a/*", "/a/0/c"));
    assert!(!pointer_matches("/a/b", "/a/c"));
}

#[test]
fn stream_matcher_unit() {
    let delta = json!({"shape": {"delta": "string"}, "repeat": true});
    let phase = json!({"shape": {"phase": {"kind": "string"}}, "optional": true});
    let done = json!({"shape": {"done": {"steps": "number"}}});
    let want = vec![phase, delta, done];
    let d = |t: &str| json!({"delta": t});
    let end = json!({"done": {"steps": 0}});

    // Optional frame absent; deltas collapse to one or many.
    assert!(compare_stream(&want, &[d("a"), end.clone()]).is_empty());
    assert!(compare_stream(
        &want,
        &[
            json!({"phase": {"kind": "x"}}),
            d("a"),
            d("b"),
            d("c"),
            end.clone()
        ]
    )
    .is_empty());
    // A missing frame, an extra frame, a wrong one.
    assert_eq!(compare_stream(&want, &[d("a")])[0].got, "the stream ended");
    assert_eq!(
        compare_stream(&want, &[d("a"), end.clone(), d("late")])[0].expected,
        "no more frames"
    );
    assert!(!compare_stream(&want, &[d("a"), json!({"done": {"steps": "many"}})]).is_empty());
}

#[test]
fn sse_reader_unit() {
    // The client reads frames as they come, split anywhere, and ends at the close.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        let mut req = [0u8; 1024];
        let _ = s.read(&mut req).unwrap();
        s.write_all(
            b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream; charset=x\r\n\r\ndata: {\"a\":",
        )
        .unwrap();
        s.flush().unwrap();
        std::thread::sleep(Duration::from_millis(100));
        s.write_all(b"1}\n\ndata: {\"ask\":\"q\"}\n\n").unwrap();
    });
    let w = Window {
        port,
        token: "t".into(),
    };
    let req = json!({"method": "POST", "path": "/api/chat", "query": {}, "body": {"text": "hi"}, "token": true});
    let mut s = Sse::open(&w, &req);
    assert_eq!((s.status, s.kind.as_str()), (200, "text/event-stream"));
    assert_eq!(s.next(), Some(json!({"a": 1})));
    assert_eq!(s.next(), Some(json!({"ask": "q"})));
    assert_eq!(s.next(), None);
    server.join().unwrap();
    assert_eq!(
        target_of(&json!({"path": "/x", "query": {"p": "C:\\a b"}})),
        "/x?p=C%3A%5Ca%20b"
    );
}

#[test]
fn fixtures_apply() {
    // The chat fixture: one session, two messages.
    let root = scratch("contract-fixtures");
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    seed_chat(&data);
    let store = Store::open(&Layout::new(data).db()).unwrap();
    let sessions = store.sessions().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(store.history(sessions[0].id, None).unwrap().len(), 2);

    // The plugin fixture's manifest is one the hub's own parser accepts, with a widget of every type.
    let m = widgets_manifest("mcp-fixture");
    let parsed = alexia_mcp::Manifest::parse(&m.to_string()).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(parsed.id, "widgets");
    let mut types: Vec<&str> = m["settings"]
        .as_array()
        .unwrap()
        .iter()
        .chain(m["panel"]["widgets"].as_array().unwrap())
        .filter_map(|w| w["type"].as_str())
        .collect();
    types.sort_unstable();
    assert_eq!(
        types,
        [
            "action",
            "cards",
            "choice",
            "file",
            "graph",
            "image",
            "multi-choice",
            "number",
            "password",
            "path",
            "progress",
            "research",
            "status",
            "table",
            "text",
            "toggle",
            "tree"
        ]
    );
    assert!(alexia_mcp::Manifest::parse(
        &plain_manifest("fixture", "mcp-fixture", "compute").to_string()
    )
    .is_ok());

    // The scripted model: a tool call first for "ask" and "work", then text.
    let body = |text: &str, results: usize| {
        let mut messages = vec![json!({"role": "user", "content": text})];
        messages.extend((0..results).map(|_| json!({"role": "tool", "content": "ok"})));
        json!({"messages": messages, "tools": [{"function": {"name": "p_set"}}]})
    };
    assert_eq!(scripted_reply(&body("Please ask", 0)).unwrap_err().0, "set");
    assert_eq!(
        scripted_reply(&body("Do some work", 0)).unwrap_err().0,
        "greet"
    );
    assert_eq!(scripted_reply(&body("Say hi", 0)).unwrap(), "Hello.");
    assert_eq!(scripted_reply(&body("Please ask", 1)).unwrap(), "Done.");
    assert_eq!(
        scripted_reply(&json!({"messages": [{"role": "user", "content": "x"}]})).unwrap(),
        "Noted."
    );

    let _ = std::fs::remove_dir_all(&root);
}
