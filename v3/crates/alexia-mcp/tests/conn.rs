// SPDX-License-Identifier: AGPL-3.0-only
//! `process::spawn` + `Conn` against the `mcp-fixture` binary and a few shell one-liners.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alexia_mcp::jsonrpc::RpcError;
use alexia_mcp::testing::{spawn, stop, Conn, Incoming, Proc};
use alexia_mcp::types::{ProgressParams, ProgressToken};
use alexia_mcp::{CallError, Manifest, PluginDir, ProgressSink};
use alexia_store::Layout;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

const FIXTURE: &str = env!("CARGO_BIN_EXE_mcp-fixture");
const LONG: Duration = Duration::from_secs(10);

/// A plugin folder holding a manifest with this entry, and a data root, under a fresh temp dir.
fn plugin(tag: &str, run: &str, args: &[&str]) -> (PluginDir, Layout) {
    let root = std::env::temp_dir().join(format!("alexia-conn-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let path = root.join("extensions").join("sample");
    std::fs::create_dir_all(&path).unwrap();
    let manifest = json!({
        "manifest_version": 1,
        "id": "sample",
        "name": "Sample",
        "summary": "A plugin that exists for tests.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": run, "args": args },
        "alexia_protocol": 2,
        "mcp_protocol": "2025-11-25"
    });
    std::fs::write(path.join("plugin.json"), manifest.to_string()).unwrap();
    let manifest = Manifest::parse(&manifest.to_string()).unwrap();
    (PluginDir { path, manifest }, Layout::new(root.join("data")))
}

/// Answers `alexia/settings/get`; remembers every method it was asked. `test/wait` never
/// answers and records when its cancel token fires; `test/progress` sends two frames.
#[derive(Default)]
struct Recorder {
    asked: Mutex<Vec<String>>,
    cancel_seen: Arc<AtomicBool>,
}

#[async_trait::async_trait]
impl Incoming for Recorder {
    async fn request(
        &self,
        method: String,
        _params: Option<Value>,
        cancel: CancellationToken,
        progress: Option<ProgressSink>,
    ) -> Result<Value, RpcError> {
        self.asked.lock().unwrap().push(method.clone());
        match method.as_str() {
            "alexia/settings/get" => Ok(json!({"settings": {"a": 1}})),
            "test/wait" => {
                // On its own task: Conn drops this future once the token fires.
                let seen = Arc::clone(&self.cancel_seen);
                tokio::spawn(async move {
                    cancel.cancelled().await;
                    seen.store(true, Ordering::SeqCst);
                });
                std::future::pending().await
            }
            "test/progress" => {
                let sink = progress.expect("a progressToken gives a sink");
                for n in 1..=2 {
                    let frame = ProgressParams {
                        // Conn puts the plugin's own token on every frame.
                        progress_token: ProgressToken::Num(0),
                        progress: f64::from(n),
                        total: Some(2.0),
                        message: None,
                        meta: None,
                    };
                    sink.send(frame).await.unwrap();
                }
                Ok(json!({}))
            }
            _ => Err(RpcError::method_not_found()),
        }
    }

    async fn notification(&self, _method: String, _params: Option<Value>) {}
}

struct Fx {
    conn: Conn,
    proc: Proc,
    incoming: Arc<Recorder>,
}

/// The fixture in `mode`, spawned, connected and initialised.
async fn fixture(tag: &str, mode: &str) -> Fx {
    // `entry.run` must be relative to the folder, so the fixture is copied in.
    let exe = Path::new(FIXTURE).file_name().unwrap().to_str().unwrap();
    let (dir, layout) = plugin(tag, exe, &[mode]);
    std::fs::copy(FIXTURE, dir.path.join(exe)).unwrap();
    let mut proc = spawn(&dir, &layout, Path::new("node"), vec![]).unwrap();
    let incoming = Arc::new(Recorder::default());
    let conn = Conn::start(
        proc.child.stdin.take().unwrap(),
        proc.child.stdout.take().unwrap(),
        proc.stderr.clone(),
        incoming.clone(),
    );
    let init = call(
        &conn,
        "initialize",
        json!({
            "protocolVersion": "2025-11-25",
            "clientInfo": {"name": "Alexia", "version": "3.0.0"},
            "capabilities": {"roots": {}}
        }),
    )
    .await
    .unwrap();
    assert_eq!(init["protocolVersion"], "2025-11-25");
    conn.notify("notifications/initialized", None)
        .await
        .unwrap();
    Fx {
        conn,
        proc,
        incoming,
    }
}

impl Fx {
    async fn done(self) {
        drop(self.conn);
        stop(self.proc, Duration::from_secs(2)).await;
    }
}

async fn call(conn: &Conn, method: &str, params: Value) -> Result<Value, CallError> {
    conn.request(method, Some(params), None, &CancellationToken::new(), LONG)
        .await
}

fn tool(name: &str, args: Value) -> Value {
    json!({"name": name, "arguments": args})
}

fn text(result: &Value) -> String {
    result["content"][0]["text"].as_str().unwrap().to_string()
}

/// Polls `f` until it holds or `LONG` passes.
async fn eventually(mut f: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + LONG;
    while Instant::now() < deadline {
        if f() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    f()
}

#[tokio::test]
async fn spawns_and_lists_tools() {
    let fx = fixture("list", "greet").await;
    let tools = call(&fx.conn, "tools/list", json!({})).await.unwrap();
    let names: Vec<&str> = tools["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"greet"), "{names:?}");
    assert!(fx.proc.pid > 0);
    fx.done().await;
}

#[tokio::test]
async fn out_of_order_answers() {
    let fx = fixture("order", "vanish").await;
    let start = Instant::now();
    let timed = |ms: u64| {
        let conn = &fx.conn;
        async move {
            let r = call(conn, "tools/call", tool("slow", json!({"ms": ms}))).await;
            (r, start.elapsed())
        }
    };
    let ((slow, slow_at), (fast, fast_at)) = tokio::join!(timed(300), timed(50));
    assert_eq!(text(&slow.unwrap()), "done");
    assert_eq!(text(&fast.unwrap()), "done");
    assert!(
        fast_at < Duration::from_millis(250),
        "fast took {fast_at:?}"
    );
    assert!(
        slow_at >= Duration::from_millis(300),
        "slow took {slow_at:?}"
    );
    fx.done().await;
}

#[tokio::test]
async fn progress_is_forwarded() {
    let fx = fixture("progress", "greet").await;
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let result = fx
        .conn
        .request(
            "tools/call",
            Some(tool("greet", json!({"who": "progress"}))),
            Some(tx),
            &CancellationToken::new(),
            LONG,
        )
        .await
        .unwrap();
    assert_eq!(text(&result), "Hello, progress.");
    let first = rx.try_recv().expect("first frame before the result");
    let second = rx.try_recv().expect("second frame before the result");
    assert_eq!((first.progress, second.progress), (1.0, 2.0));
    assert_eq!(second.total, Some(2.0));
    fx.done().await;
}

#[tokio::test]
async fn plugin_requests_reach_incoming() {
    let fx = fixture("ask", "greet").await;
    let result = call(&fx.conn, "tools/call", tool("greet", json!({"who": "ask"})))
        .await
        .unwrap();
    assert!(
        text(&result).contains(r#"{"settings":{"a":1}}"#),
        "{result}"
    );
    assert_eq!(
        *fx.incoming.asked.lock().unwrap(),
        vec!["alexia/settings/get".to_string()]
    );
    fx.done().await;
}

#[tokio::test]
async fn plugin_cancel_reaches_incoming() {
    let fx = fixture("plugin-cancel", "greet").await;
    let result = call(
        &fx.conn,
        "tools/call",
        tool("greet", json!({"who": "ask-cancel"})),
    )
    .await
    .unwrap();
    assert_eq!(text(&result), "Hello, ask-cancel.");
    let seen = Arc::clone(&fx.incoming.cancel_seen);
    assert!(eventually(|| seen.load(Ordering::SeqCst)).await);
    // The plugin is still there: it was the request that stopped, not the connection.
    assert!(!fx.conn.closed().is_cancelled());
    fx.done().await;
}

#[tokio::test]
async fn plugin_progress_token_gets_frames() {
    let fx = fixture("plugin-progress", "greet").await;
    call(
        &fx.conn,
        "tools/call",
        tool("greet", json!({"who": "ask-progress"})),
    )
    .await
    .unwrap();
    // The fixture logs each notification it receives to stderr as `note <line>`.
    let log = fx.proc.stderr.clone();
    let frames = || {
        log.lines()
            .iter()
            .filter(|l| {
                l.contains("notifications/progress") && l.contains(r#""progressToken":"tok-1""#)
            })
            .count()
    };
    assert!(eventually(|| frames() == 2).await, "{:#?}", log.lines());
    fx.done().await;
}

#[tokio::test]
async fn cancel_sends_cancelled() {
    let fx = fixture("cancel", "vanish").await;
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        trigger.cancel();
    });
    let started = Instant::now();
    let r = fx
        .conn
        .request(
            "tools/call",
            Some(tool("slow", json!({"ms": 5000}))),
            None,
            &cancel,
            LONG,
        )
        .await;
    assert!(matches!(r, Err(CallError::Cancelled)), "{r:?}");
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(call(&fx.conn, "ping", json!({})).await.unwrap(), json!({}));
    fx.done().await;
}

#[tokio::test]
async fn timeout_is_timeout() {
    let fx = fixture("timeout", "vanish").await;
    let r = fx
        .conn
        .request(
            "tools/call",
            Some(tool("slow", json!({"ms": 2000}))),
            None,
            &CancellationToken::new(),
            Duration::from_millis(100),
        )
        .await;
    assert!(matches!(r, Err(CallError::Timeout)), "{r:?}");
    fx.done().await;
}

#[tokio::test]
async fn exit_mid_call_is_gone() {
    let fx = fixture("exit", "exit").await;
    let closed = fx.conn.closed();
    let r = call(&fx.conn, "tools/call", tool("exit", json!({}))).await;
    assert!(matches!(r, Err(CallError::Gone)), "{r:?}");
    tokio::time::timeout(LONG, closed.cancelled())
        .await
        .expect("closed() fires");
    let again = call(&fx.conn, "ping", json!({})).await;
    assert!(matches!(again, Err(CallError::Gone)), "{again:?}");
    assert_eq!(stop(fx.proc, Duration::from_secs(2)).await, Some(3));
}

#[tokio::test]
async fn junk_is_skipped_and_logged() {
    let fx = fixture("junk", "junk").await;
    let tools = call(&fx.conn, "tools/list", json!({})).await.unwrap();
    assert_eq!(tools["tools"][0]["name"], "junk");
    let log = fx.proc.stderr.clone();
    // Not necessarily last: the fixture's own `got ...` stderr lines come through a separate
    // pipe and can land after the junk line.
    let junk = "[not json] this is not json 999";
    let seen = eventually(|| log.lines().iter().any(|l| l == junk)).await;
    let lines = log.lines();
    assert!(seen, "{junk:?} not among {} lines: {lines:#?}", lines.len());
    assert!(lines.len() <= 500, "{} lines", lines.len());
    fx.done().await;
}

#[tokio::test]
async fn env_is_scrubbed_and_cwd_is_own_dir() {
    std::env::set_var("ALEXIA_TEST_LEAK", "x");
    let (dir, layout) = if cfg!(windows) {
        plugin("env", "cmd", &["/C", "set & cd"])
    } else {
        plugin("env", "sh", &["-c", "env; pwd"])
    };
    let mut proc = spawn(&dir, &layout, Path::new("node"), vec![]).unwrap();
    let mut out = String::new();
    tokio::io::AsyncReadExt::read_to_string(&mut proc.child.stdout.take().unwrap(), &mut out)
        .await
        .unwrap();
    let lines: Vec<&str> = out.lines().map(str::trim).collect();
    assert!(
        !lines.iter().any(|l| l.starts_with("ALEXIA_TEST_LEAK")),
        "{out}"
    );
    let plugin_dir = format!("ALEXIA_PLUGIN_DIR={}", dir.path.display());
    assert!(lines.contains(&plugin_dir.as_str()), "{out}");
    let cwd = PathBuf::from(*lines.last().unwrap());
    let own = layout.own_dir("sample");
    if cfg!(windows) {
        assert!(
            cwd.to_string_lossy()
                .eq_ignore_ascii_case(&own.to_string_lossy()),
            "{cwd:?} vs {own:?}"
        );
    } else {
        assert_eq!(cwd.canonicalize().unwrap(), own.canonicalize().unwrap());
    }
    stop(proc, Duration::from_secs(2)).await;
}

#[tokio::test]
async fn redacts_secrets_in_stderr() {
    let secret = "hunter2-correct-horse";
    let (dir, layout) = if cfg!(windows) {
        plugin(
            "redact",
            "cmd",
            &["/C", &format!("echo the key is {secret} 1>&2")],
        )
    } else {
        plugin(
            "redact",
            "sh",
            &["-c", &format!("echo the key is {secret} 1>&2")],
        )
    };
    let mut proc = spawn(&dir, &layout, Path::new("node"), vec![secret.into()]).unwrap();
    proc.child.wait().await.unwrap();
    let log = proc.stderr.clone();
    assert!(eventually(|| !log.lines().is_empty()).await);
    let lines = log.lines();
    assert!(
        lines.iter().any(|l| l.contains("the key is •••")),
        "{lines:?}"
    );
    assert!(!lines.iter().any(|l| l.contains("hunter2")), "{lines:?}");
    stop(proc, Duration::from_secs(2)).await;
}

#[cfg(windows)]
fn pings() -> Vec<u32> {
    let out = std::process::Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq PING.EXE", "/FO", "CSV", "/NH"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.split(',').nth(1))
        .filter_map(|pid| pid.trim_matches('"').parse().ok())
        .collect()
}

#[cfg(windows)]
#[tokio::test]
async fn job_kills_children() {
    let before = pings();
    let (dir, layout) = plugin("job", "cmd", &["/C", "start /B ping -n 30 127.0.0.1"]);
    let proc = spawn(&dir, &layout, Path::new("node"), vec![]).unwrap();
    let mut child = None;
    assert!(
        eventually(|| {
            child = pings().into_iter().find(|p| !before.contains(p));
            child.is_some()
        })
        .await,
        "ping never started"
    );
    let child = child.unwrap();
    stop(proc, Duration::from_millis(500)).await;
    assert!(
        eventually(|| !pings().contains(&child)).await,
        "ping {child} outlived its plugin"
    );
}

#[tokio::test]
async fn not_json_is_redacted_before_it_is_cut() {
    // The token starts at char 191 of the line, so a cut at 200 before redaction would keep
    // `ghp_abcde`, too short to match, and leak it.
    let line = format!("{} ghp{}", "x".repeat(190), "_abcdefghijklmnopqrstuvwxyz12");
    let (dir, layout) = if cfg!(windows) {
        plugin("notjson", "cmd", &["/C", &format!("echo {line}")])
    } else {
        plugin("notjson", "sh", &["-c", &format!("echo {line}")])
    };
    let mut proc = spawn(&dir, &layout, Path::new("node"), vec![]).unwrap();
    let conn = Conn::start(
        proc.child.stdin.take().unwrap(),
        proc.child.stdout.take().unwrap(),
        proc.stderr.clone(),
        Arc::new(Recorder::default()),
    );
    let log = proc.stderr.clone();
    assert!(eventually(|| !log.lines().is_empty()).await);
    let lines = log.lines();
    assert!(!lines.iter().any(|l| l.contains("ghp_")), "{lines:?}");
    assert!(lines.iter().any(|l| l.ends_with("x •••")), "{lines:?}");
    drop(conn);
    stop(proc, Duration::from_secs(2)).await;
}

#[cfg(unix)]
type Owned = std::os::fd::OwnedFd;
#[cfg(windows)]
type Owned = std::os::windows::io::OwnedHandle;

/// A request and its cancel in one write: the reader handles both lines before the request's
/// task is first polled, so the token has already fired when the handler would start.
#[tokio::test]
async fn cancel_before_first_poll_reaches_incoming() {
    use std::io::Write;
    use tokio::process::{ChildStdin, ChildStdout};
    for round in 0..200 {
        // (our writer → Conn's stdout) and (Conn's stdin → a reader we keep open).
        let (out_r, mut out_w) = std::io::pipe().unwrap();
        let (_in_r, in_w) = std::io::pipe().unwrap();
        let stdout = ChildStdout::from_std(Owned::from(out_r).into()).unwrap();
        let stdin = ChildStdin::from_std(Owned::from(in_w).into()).unwrap();
        let incoming = Arc::new(Recorder::default());
        let conn = Conn::start(stdin, stdout, Default::default(), incoming.clone());
        let both = concat!(
            r#"{"jsonrpc":"2.0","id":7,"method":"test/wait"}"#,
            "\n",
            r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}"#,
            "\n"
        );
        out_w.write_all(both.as_bytes()).unwrap();
        let seen = Arc::clone(&incoming.cancel_seen);
        assert!(
            eventually(|| seen.load(Ordering::SeqCst)).await,
            "round {round}: the handler never saw its cancel"
        );
        assert_eq!(
            *incoming.asked.lock().unwrap(),
            vec!["test/wait".to_string()]
        );
        drop(out_w);
        drop(conn);
    }
}
