// SPDX-License-Identifier: AGPL-3.0-only
//! Drives the `mcp-fixture` binary over real pipes.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::Duration;

use serde_json::{json, Value};

struct Fx {
    child: Child,
    stdin: ChildStdin,
    out: Receiver<String>,
    err: Receiver<String>,
}

fn lines(r: impl std::io::Read + Send + 'static) -> Receiver<String> {
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        for l in BufReader::new(r).lines().map_while(Result::ok) {
            if tx.send(l).is_err() {
                break;
            }
        }
    });
    rx
}

impl Fx {
    fn spawn(args: &[&str]) -> Fx {
        let mut child = Command::new(env!("CARGO_BIN_EXE_mcp-fixture"))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let out = lines(child.stdout.take().unwrap());
        let err = lines(child.stderr.take().unwrap());
        Fx {
            child,
            stdin,
            out,
            err,
        }
    }

    fn send(&mut self, v: Value) {
        writeln!(self.stdin, "{v}").unwrap();
        self.stdin.flush().unwrap();
    }

    /// Next stdout line that parses as JSON; panics after 5 s instead of hanging the run.
    fn recv(&self) -> Value {
        loop {
            let l = self
                .out
                .recv_timeout(Duration::from_secs(5))
                .expect("timed out waiting for the fixture");
            if let Ok(v) = serde_json::from_str(&l) {
                return v;
            }
        }
    }

    fn call(&mut self, id: i64, method: &str, params: Value) -> Value {
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        self.recv()
    }

    fn init(&mut self) -> Value {
        let r = self.call(
            1,
            "initialize",
            json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"0"}}),
        );
        self.send(json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
        r
    }

    fn exit_code(&mut self) -> Option<i32> {
        for _ in 0..100 {
            if let Some(s) = self.child.try_wait().unwrap() {
                return s.code();
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        None
    }
}

impl Drop for Fx {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[test]
fn greet_handshake_and_tools() {
    let mut fx = Fx::spawn(&["greet"]);
    let r = fx.init();
    assert_eq!(r["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(r["result"]["serverInfo"]["name"], "mcp-fixture");
    assert_eq!(r["result"]["capabilities"]["tools"]["listChanged"], true);
    let r = fx.call(2, "tools/list", json!({}));
    let t = &r["result"]["tools"];
    assert_eq!(t[0]["name"], "greet");
    assert_eq!(t[0]["_meta"]["alexia/provides"], json!(["demo.greet"]));
    assert_eq!(t[1]["name"], "secret_tool");
    assert_eq!(t[1]["_meta"]["alexia/compute"]["op"], "demo.compute");
    let r = fx.call(
        3,
        "tools/call",
        json!({"name":"greet","arguments":{"who":"Sam"}}),
    );
    assert_eq!(r["result"]["content"][0]["text"], "Hello, Sam.");
}

#[test]
fn ping_is_answered() {
    let mut fx = Fx::spawn(&["greet"]);
    let r = fx.call(7, "ping", json!({}));
    assert_eq!(r["id"], 7);
    assert_eq!(r["result"], json!({}));
}

#[test]
fn protocol_flag_changes_the_answer() {
    let mut fx = Fx::spawn(&["greet", "--protocol", "2026-07-28"]);
    assert_eq!(fx.init()["result"]["protocolVersion"], "2026-07-28");
}

#[test]
fn requests_are_logged_to_stderr() {
    let mut fx = Fx::spawn(&["greet"]);
    fx.call(
        2,
        "tools/call",
        json!({"name":"greet","arguments":{"who":"x"},"_meta":{"k":"v"}}),
    );
    loop {
        let l = fx
            .err
            .recv_timeout(Duration::from_secs(5))
            .expect("no `got` line on stderr");
        if let Some(j) = l.strip_prefix("got ") {
            let v: Value = serde_json::from_str(j).unwrap();
            assert_eq!(v["params"]["_meta"]["k"], "v");
            break;
        }
    }
}

#[test]
fn unknown_method_is_method_not_found() {
    let mut fx = Fx::spawn(&["greet"]);
    let r = fx.call(2, "nope/nothing", json!({}));
    assert_eq!(r["error"]["code"], -32601);
}

#[test]
fn exit_mode_exits_with_3_mid_call() {
    let mut fx = Fx::spawn(&["exit"]);
    fx.send(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"exit"}}));
    assert_eq!(fx.exit_code(), Some(3));
}

#[test]
fn die_on_start_exits_1() {
    let mut fx = Fx::spawn(&["greet", "--die-on-start"]);
    assert_eq!(fx.exit_code(), Some(1));
}

#[test]
fn junk_mode_still_answers_after_the_junk() {
    let mut fx = Fx::spawn(&["junk"]);
    fx.init();
    fx.send(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}));
    let r = fx.recv();
    assert_eq!(r["id"], 2);
    assert_eq!(r["result"]["tools"][0]["name"], "junk");
}

#[test]
fn storage_mode_sends_requests_to_the_host() {
    let mut fx = Fx::spawn(&["storage"]);
    fx.init();
    fx.send(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"store","arguments":{"key":"a","value":"b"}}}));
    let req = fx.recv();
    assert_eq!(req["method"], "alexia/storage/kv/set");
    assert_eq!(req["params"], json!({"key":"a","value":"b"}));
    assert!(req["id"].as_i64().unwrap() >= 1000);
    fx.send(json!({"jsonrpc":"2.0","id":req["id"],"result":{}}));
    let r = fx.recv();
    assert_eq!(r["id"], 2);
    assert_eq!(r["result"]["content"][0]["text"], "{}");

    fx.send(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list","arguments":{}}}));
    let req = fx.recv();
    assert_eq!(req["method"], "alexia/storage/select");
    fx.send(
        json!({"jsonrpc":"2.0","id":req["id"],"error":{"code":-32052,"message":"outside namespace"}}),
    );
    let r = fx.recv();
    assert_eq!(r["result"]["isError"], true);
    assert_eq!(r["result"]["content"][0]["text"], "outside namespace");
}

#[test]
fn vanish_mode_honours_cancel() {
    let mut fx = Fx::spawn(&["vanish"]);
    fx.init();
    fx.send(json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"slow","arguments":{"ms":5000}}}));
    fx.send(json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":5}}));
    let r = fx.call(6, "ping", json!({}));
    assert_eq!(r["id"], 6);
    assert!(fx.out.recv_timeout(Duration::from_millis(500)).is_err());
}
