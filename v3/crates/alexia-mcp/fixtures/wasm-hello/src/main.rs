// SPDX-License-Identifier: AGPL-3.0-only
//! A tiny MCP server for the P2-24 sandbox tests. Reads one JSON-RPC message per stdin line.
//! Tools: `hello`, `hang`, `trap`, `read_file {path}`, `alloc {mb}`.

use serde_json::{json, Value};
use std::io::{BufRead, Write};

fn text(s: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": s }] })
}

fn call(name: &str, a: &Value) -> Value {
    match name {
        "hello" => text(&format!("Hello, {}.", a["who"].as_str().unwrap_or("world"))),
        "hang" => loop {
            std::hint::black_box(0);
        },
        "trap" => panic!("trap on purpose"),
        "read_file" => match std::fs::read_to_string(a["path"].as_str().unwrap_or_default()) {
            Ok(s) => text(&s),
            Err(e) => json!({ "isError": true, "content": [{ "type": "text", "text": format!("{:?}", e.kind()) }] }),
        },
        "alloc" => {
            let n = (a["mb"].as_u64().unwrap_or(1) as usize) << 20;
            let v = vec![1u8; n];
            text(&format!("{}", std::hint::black_box(v).len()))
        }
        _ => json!({ "isError": true, "content": [{ "type": "text", "text": "no such tool" }] }),
    }
}

fn tool(name: &str, desc: &str) -> Value {
    json!({ "name": name, "description": desc, "inputSchema": { "type": "object" } })
}

fn main() {
    let mut out = std::io::stdout();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(m) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = m.get("id").cloned() else { continue };
        let p = &m["params"];
        let result = match m["method"].as_str().unwrap_or_default() {
            "initialize" => json!({
                "protocolVersion": "2025-11-25",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "wasm-hello", "version": "0.1.0" }
            }),
            "ping" => json!({}),
            "tools/list" => json!({ "tools": [
                tool("hello", "Greets."),
                tool("hang", "Never returns."),
                tool("trap", "Aborts the instance."),
                tool("read_file", "Reads a file by path."),
                tool("alloc", "Allocates mb megabytes."),
            ] }),
            "tools/call" => call(p["name"].as_str().unwrap_or_default(), &p["arguments"]),
            _ => {
                let e = json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "no such method" } });
                writeln!(out, "{e}").and_then(|()| out.flush()).ok();
                continue;
            }
        };
        let r = json!({ "jsonrpc": "2.0", "id": id, "result": result });
        if writeln!(out, "{r}").and_then(|()| out.flush()).is_err() {
            break;
        }
    }
}
