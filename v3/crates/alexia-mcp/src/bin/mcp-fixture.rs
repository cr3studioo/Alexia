// SPDX-License-Identifier: AGPL-3.0-only
//! `mcp-fixture <mode> [--die-on-start] [--protocol <version>]`: a tiny MCP server that host
//! tests spawn instead of real plugins. stdout is the wire; logs go to stderr.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alexia_mcp::jsonrpc::{Id, Message, Notification, Outcome, Request, Response, RpcError, V2};
use serde_json::{json, Value};

struct Ctx {
    mode: String,
    protocol: String,
    pending: Mutex<HashMap<i64, Sender<Outcome>>>,
    next_id: AtomicI64,
    cancelled: Mutex<HashSet<Id>>,
}

fn send(v: &impl serde::Serialize) {
    let mut line = serde_json::to_string(v).expect("serialize");
    line.push('\n');
    // Hold the stdout lock for the whole write so lines from different threads never interleave.
    let mut out = std::io::stdout().lock();
    out.write_all(line.as_bytes()).expect("write stdout");
    out.flush().expect("flush stdout");
}

fn notify(method: &str, params: Value) {
    send(&Notification {
        jsonrpc: V2,
        method: method.into(),
        params: Some(params),
    });
}

/// Sends a request to the host and blocks for its answer.
fn call_host(ctx: &Ctx, method: &str, params: Value) -> Outcome {
    let id = ctx.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = channel();
    ctx.pending.lock().unwrap().insert(id, tx);
    send(&Request {
        jsonrpc: V2,
        id: Id::Num(id),
        method: method.into(),
        params: Some(params),
    });
    rx.recv()
        .expect("host closed stdin while a request was pending")
}

fn tools(mode: &str) -> Value {
    let schema = |props: Value| json!({"type": "object", "properties": props});
    match mode {
        "greet" => json!([
            {"name": "greet", "inputSchema": schema(json!({"who": {"type": "string"}})),
             "_meta": {"alexia/provides": ["demo.greet"]}},
            {"name": "secret_tool", "inputSchema": schema(json!({})),
             "_meta": {"alexia/compute": {"op": "demo.compute"}}},
        ]),
        "compute" => json!([
            {"name": "render", "inputSchema": schema(json!({"text": {"type": "string"}})),
             "_meta": {"alexia/compute": {"op": "demo.compute"}}},
        ]),
        "undoable" => json!([
            {"name": "set", "inputSchema": schema(json!({"key": {"type": "string"}, "value": {}}))},
            {"name": "unset", "inputSchema": schema(json!({"key": {"type": "string"}}))},
        ]),
        "exit" => json!([{"name": "exit", "inputSchema": schema(json!({}))}]),
        "hang" => json!([{"name": "hang", "inputSchema": schema(json!({}))}]),
        "junk" => json!([{"name": "junk", "inputSchema": schema(json!({}))}]),
        "vanish" => {
            json!([{"name": "slow", "inputSchema": schema(json!({"ms": {"type": "integer"}}))}])
        }
        "storage" => json!([
            {"name": "store", "inputSchema": schema(json!({"key": {"type": "string"}, "value": {}}))},
            {"name": "recall", "inputSchema": schema(json!({"key": {"type": "string"}}))},
            {"name": "remember", "inputSchema": schema(json!({"text": {"type": "string"}}))},
            {"name": "list", "inputSchema": schema(json!({}))},
        ]),
        _ => json!([]),
    }
}

fn text_result(text: String, is_error: bool) -> Value {
    let mut v = json!({"content": [{"type": "text", "text": text}]});
    if is_error {
        v["isError"] = json!(true);
    }
    v
}

/// Forwards a call to the host and renders its answer as a tool result.
fn via_host(ctx: &Ctx, method: &str, params: Value) -> Value {
    match call_host(ctx, method, params) {
        Outcome::Result(v) => text_result(v.to_string(), false),
        Outcome::Error(e) => text_result(e.message, true),
    }
}

/// `None` means "do not answer" (a cancelled slow call).
fn call_tool(ctx: &Ctx, id: &Id, params: &Value) -> Option<Value> {
    let name = params["name"].as_str().unwrap_or("");
    let args = &params["arguments"];
    let s = |k: &str| args[k].as_str().unwrap_or("").to_string();
    let cancelled = || ctx.cancelled.lock().unwrap().contains(id);
    Some(match name {
        "greet" => {
            let who = s("who");
            if who == "progress" {
                let token = params["_meta"]["progressToken"].clone();
                for n in 1..=2 {
                    notify(
                        "notifications/progress",
                        json!({"progressToken": token, "progress": n, "total": 2}),
                    );
                }
            }
            if who == "ask" {
                return Some(via_host(ctx, "alexia/settings/get", json!({})));
            }
            text_result(format!("Hello, {who}."), false)
        }
        "render" => {
            // The tool runs in the plugin's own folder: the file it writes is its own.
            let path = std::env::current_dir().unwrap().join("out.txt");
            std::fs::write(&path, s("text")).expect("write out.txt");
            let op = params["_meta"]["alexia/compute"]["op"].clone();
            let inputs = args["inputs"].as_array().map_or(0, Vec::len);
            let p = path
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            let uri = if p.starts_with('/') {
                format!("file://{p}")
            } else {
                format!("file:///{p}")
            };
            json!({"content": [
                {"type": "text", "text": format!("ran {op} with {inputs} inputs")},
                {"type": "resource_link", "uri": uri, "name": "out.txt", "mimeType": "text/plain"},
            ]})
        }
        "set" => {
            let key = s("key");
            let mut r = text_result(format!("set {key}"), false);
            r["_meta"] = json!({"alexia/undo": {"tool": "unset", "arguments": {"key": key}}});
            r
        }
        "unset" => text_result(format!("unset {}", s("key")), false),
        "exit" => std::process::exit(3),
        "slow" => {
            let ms = args["ms"].as_u64().unwrap_or(0);
            let deadline = Instant::now() + Duration::from_millis(ms);
            while Instant::now() < deadline {
                if cancelled() {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            if cancelled() {
                return None;
            }
            text_result("done".into(), false)
        }
        "store" => via_host(
            ctx,
            "alexia/storage/kv/set",
            json!({"key": s("key"), "value": args["value"]}),
        ),
        "recall" => via_host(ctx, "alexia/storage/kv/get", json!({"key": s("key")})),
        "remember" => via_host(
            ctx,
            "alexia/storage/insert",
            json!({"table": "notes", "row": {"text": s("text")}}),
        ),
        "list" => via_host(ctx, "alexia/storage/select", json!({"table": "notes"})),
        _ => text_result(format!("unknown tool {name}"), true),
    })
}

fn handle(ctx: &Ctx, req: Request) {
    let params = req.params.clone().unwrap_or(Value::Null);
    let outcome = match req.method.as_str() {
        "initialize" => Outcome::Result(json!({
            "protocolVersion": ctx.protocol,
            "serverInfo": {"name": "mcp-fixture", "version": "0.0.0"},
            "capabilities": {"tools": {"listChanged": true}},
        })),
        "ping" => Outcome::Result(json!({})),
        "tools/list" => Outcome::Result(json!({"tools": tools(&ctx.mode)})),
        "tools/call" => match call_tool(ctx, &req.id, &params) {
            Some(v) => Outcome::Result(v),
            None => return,
        },
        _ => Outcome::Error(RpcError::method_not_found()),
    };
    let is_init = req.method == "initialize";
    send(&Response {
        jsonrpc: V2,
        id: req.id,
        outcome,
    });
    if is_init && ctx.mode == "junk" {
        let mut out = std::io::stdout().lock();
        for i in 0..1000 {
            writeln!(out, "this is not json {i}").unwrap();
        }
        out.flush().unwrap();
    }
}

fn is_hang_call(req: &Request) -> bool {
    req.method == "tools/call" && req.params.as_ref().is_some_and(|p| p["name"] == "hang")
}

fn main() {
    let mut args = std::env::args().skip(1);
    let (mut mode, mut protocol, mut die) = (String::new(), "2025-11-25".to_string(), false);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--die-on-start" => die = true,
            "--protocol" => protocol = args.next().expect("--protocol needs a value"),
            _ => mode = a,
        }
    }
    if die {
        std::process::exit(1);
    }
    let ctx = Arc::new(Ctx {
        mode,
        protocol,
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicI64::new(1000),
        cancelled: Mutex::new(HashSet::new()),
    });

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<Message>(line) {
            Ok(Message::Request(req)) => {
                eprintln!("got {line}");
                if ctx.mode == "hang" && is_hang_call(&req) {
                    // Stop reading and never answer, not even pings.
                    loop {
                        std::thread::park();
                    }
                }
                let ctx = Arc::clone(&ctx);
                std::thread::spawn(move || handle(&ctx, req));
            }
            Ok(Message::Response(Response {
                id: Id::Num(n),
                outcome,
                ..
            })) => {
                if let Some(tx) = ctx.pending.lock().unwrap().remove(&n) {
                    let _ = tx.send(outcome);
                }
            }
            Ok(Message::Notification(n)) if n.method == "notifications/cancelled" => {
                let id = n
                    .params
                    .and_then(|p| serde_json::from_value(p["requestId"].clone()).ok());
                if let Some(id) = id {
                    ctx.cancelled.lock().unwrap().insert(id);
                }
            }
            Ok(Message::Notification(_)) => eprintln!("note {line}"),
            _ => {}
        }
    }
}
