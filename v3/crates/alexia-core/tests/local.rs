// SPDX-License-Identifier: AGPL-3.0-only
//! P2-31: the managed llama.cpp runtime against a fake `llama-server`.
//!
//! The fake is a small std-only Rust program the test compiles with `rustc` once and points
//! `ALEXIA_LLAMA_SERVER` at. It records its arguments in `args.txt` beside the model file, answers
//! `/health`, `/v1/models` and a streamed `/v1/chat/completions` (with the `--api-key` required),
//! and exits when a `crash` file appears. Real time throughout: alexia-core's tokio has no
//! `test-util`, so the idle test uses a short idle limit (the hidden `with_timing`), not a paused clock.
//! Nothing is downloaded from GitHub: the download tests talk to a local HTTP server.

use std::io::Write;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use alexia_core::local::{LocalError, LocalModel, Runtime};
use alexia_core::{ChatChunk, ChatRequest};
use alexia_store::{Layout, MessageBody, Role};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const FAKE: &str = r##"
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let val = |flag: &str| args.iter().position(|a| a == flag).map(|i| args[i + 1].clone()).unwrap();
    let (port, key) = (val("--port"), val("--api-key"));
    let dir = PathBuf::from(val("--model")).parent().unwrap().to_owned();
    let mut log = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("args.txt")).unwrap();
    writeln!(log, "{}", args.join(" ")).unwrap();
    drop(log);
    let crash = dir.join("crash");
    std::thread::spawn(move || loop {
        if crash.exists() {
            let _ = std::fs::remove_file(&crash);
            std::process::exit(1);
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    });
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).unwrap();
    for conn in listener.incoming() {
        let Ok(mut s) = conn else { continue };
        let key = key.clone();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let mut b = [0u8; 1024];
            let end = loop {
                let n = s.read(&mut b).unwrap_or(0);
                if n == 0 { return; }
                buf.extend_from_slice(&b[..n]);
                if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") { break at + 4; }
            };
            let head = String::from_utf8_lossy(&buf[..end]).to_string();
            let lower = head.to_lowercase();
            let len: usize = lower.lines().find_map(|l| l.strip_prefix("content-length:")).map_or(0, |v| v.trim().parse().unwrap());
            while buf.len() < end + len {
                let n = s.read(&mut b).unwrap_or(0);
                if n == 0 { break; }
                buf.extend_from_slice(&b[..n]);
            }
            let line = head.lines().next().unwrap_or("").to_owned();
            let json = |code: &str, ctype: &str, body: &str| format!("HTTP/1.1 {code}\r\ncontent-type: {ctype}\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}", body.len());
            let reply = if line.starts_with("GET /health") {
                json("200 OK", "application/json", r#"{"status":"ok"}"#)
            } else if !lower.contains(&format!("authorization: bearer {}", key.to_lowercase())) {
                json("401 Unauthorized", "application/json", r#"{"error":{"message":"no key"}}"#)
            } else if line.starts_with("GET /v1/models") {
                json("200 OK", "application/json", r#"{"data":[{"id":"fake"}]}"#)
            } else {
                let body = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n";
                json("200 OK", "text/event-stream", body)
            };
            let _ = s.write_all(reply.as_bytes());
        });
    }
}
"##;

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn scratch(name: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("alexia-local-{}-{name}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Compiles the fake once and points `ALEXIA_LLAMA_SERVER` at it.
fn fake_exe() -> &'static Path {
    static EXE: OnceLock<PathBuf> = OnceLock::new();
    EXE.get_or_init(|| {
        let dir = scratch("fake");
        let src = dir.join("fake.rs");
        std::fs::write(&src, FAKE).unwrap();
        let exe = dir.join(if cfg!(windows) { "fake.exe" } else { "fake" });
        let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".into());
        let out = std::process::Command::new(rustc)
            .args(["--edition", "2021", "-O", "-o"])
            .arg(&exe)
            .arg(&src)
            .output()
            .expect("rustc runs");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        std::env::set_var("ALEXIA_LLAMA_SERVER", &exe);
        exe
    })
}

fn runtime(timing: Option<(Duration, Duration, Duration)>) -> Arc<Runtime> {
    fake_exe();
    let layout = Layout::new(scratch("data"));
    let client = reqwest::Client::new();
    match timing {
        None => Runtime::new(layout, client),
        Some((idle, tick, backoff)) => Runtime::with_timing(layout, client, idle, tick, backoff),
    }
}

/// A model whose file lives in its own folder; the fake writes `args.txt` there.
fn model(id: &str) -> LocalModel {
    let dir = scratch(id);
    LocalModel {
        id: id.into(),
        path: dir.join("model.gguf"),
        mmproj: None,
        draft: None,
        context: 4096,
        embedding: false,
    }
}

fn starts(m: &LocalModel) -> Vec<String> {
    std::fs::read_to_string(m.path.parent().unwrap().join("args.txt"))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn hello() -> ChatRequest {
    ChatRequest {
        messages: vec![(
            Role::User,
            serde_json::from_value::<MessageBody>(serde_json::json!({"content": "hello"})).unwrap(),
        )],
        system: None,
        tools: Vec::new(),
        max_tokens: None,
    }
}

async fn says_hi(p: &Arc<dyn alexia_core::Provider>) -> bool {
    let (tx, mut rx) = mpsc::channel(16);
    let done = p.chat(&hello(), "fake", tx, CancellationToken::new()).await;
    let mut text = String::new();
    while let Ok(chunk) = rx.try_recv() {
        if let ChatChunk::Text(t) = chunk {
            text.push_str(&t);
        }
    }
    done.is_ok() && text == "hi"
}

fn listening(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_secs(2),
    )
    .is_ok()
}

async fn until(what: &str, mut ok: impl FnMut() -> bool) {
    let start = Instant::now();
    while !ok() {
        assert!(
            start.elapsed() < Duration::from_secs(60),
            "timed out: {what}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn serve_returns_working_provider() {
    let rt = runtime(None);
    let m = model("m1");
    let p = rt.serve(&m, 33).await.unwrap();
    assert_eq!(p.id(), "local:m1");
    assert!(says_hi(&p).await);
    assert!(!p.models().await.unwrap().is_empty());
    // Served again: the same server, not a second start.
    rt.serve(&m, 33).await.unwrap();
    assert_eq!(rt.pids().len(), 1);
    let line = starts(&m).join("\n");
    assert_eq!(starts(&m).len(), 1);
    assert!(line.contains("--host 127.0.0.1"), "{line}");
    assert!(line.contains("--api-key "), "{line}");
    assert!(line.contains("--n-gpu-layers 33"), "{line}");
    assert!(!line.contains("--model-draft"), "{line}");
    rt.stop_all().await;
}

#[tokio::test]
async fn draft_flag_passed() {
    let rt = runtime(None);
    let mut m = model("with-draft");
    let draft = m.path.parent().unwrap().join("draft.gguf");
    m.draft = Some(draft.clone());
    rt.serve(&m, 17).await.unwrap();
    let line = starts(&m).join("\n");
    assert!(
        line.contains(&format!("--model-draft {}", draft.display())),
        "{line}"
    );
    assert!(line.contains("-ngld 17"), "{line}");
    rt.stop_all().await;
}

#[tokio::test]
async fn stop_all_kills() {
    let rt = runtime(None);
    let (a, b) = (model("ka"), model("kb"));
    rt.serve(&a, 0).await.unwrap();
    rt.serve(&b, 0).await.unwrap();
    assert_eq!(rt.pids().len(), 2);
    let ports = [rt.port("ka").unwrap(), rt.port("kb").unwrap()];
    assert!(ports.iter().all(|p| listening(*p)));
    rt.stop_all().await;
    assert!(rt.pids().is_empty());
    until("both servers dead", || !ports.iter().any(|p| listening(*p))).await;
}

#[tokio::test]
async fn idle_stops_after_10_min() {
    // Same rule as the real 10 minutes / 1 minute, shrunk: 3 s idle, checked every 200 ms.
    let rt = runtime(Some((
        Duration::from_secs(3),
        Duration::from_millis(200),
        Duration::from_millis(200),
    )));
    let cancel = CancellationToken::new();
    let runner = {
        let (rt, cancel) = (rt.clone(), cancel.clone());
        tokio::spawn(async move { rt.run(cancel).await })
    };
    let m = model("idle");
    let p = rt.serve(&m, 0).await.unwrap();
    let port = rt.port("idle").unwrap();
    // Use keeps it alive well past the idle limit.
    let busy = Instant::now();
    while busy.elapsed() < Duration::from_secs(5) {
        assert!(says_hi(&p).await);
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert_eq!(rt.pids().len(), 1, "stopped while in use");
    // Then unused: stopped after the limit, not before.
    let quiet = Instant::now();
    until("idle stop", || rt.pids().is_empty()).await;
    assert!(
        quiet.elapsed() >= Duration::from_secs(2),
        "{:?}",
        quiet.elapsed()
    );
    until("port closed", || !listening(port)).await;
    cancel.cancel();
    runner.await.unwrap();
}

#[tokio::test]
async fn crash_restarts_with_backoff() {
    let backoff = Duration::from_millis(600);
    let rt = runtime(Some((
        Duration::from_secs(600),
        Duration::from_secs(60),
        backoff,
    )));
    let m = model("crashy");
    let p = rt.serve(&m, 0).await.unwrap();
    let crash = m.path.parent().unwrap().join("crash");

    let mut last = rt.pids()[0];
    for (round, least) in [(1u32, backoff), (2, backoff * 2)] {
        let t0 = Instant::now();
        std::fs::write(&crash, "x").unwrap();
        until("a new process", || {
            rt.pids().first().is_some_and(|pid| *pid != last)
        })
        .await;
        let took = t0.elapsed();
        // The delay doubles: 1x the base after the first crash, 2x after the second.
        assert!(
            took >= least.mul_f32(0.8),
            "round {round}: restarted after {took:?}"
        );
        last = rt.pids()[0];
    }
    // Same port and key: the provider handed out earlier still works.
    let port = rt.port("crashy").unwrap();
    until("health after restart", || listening(port)).await;
    let mut ok = false;
    for _ in 0..100 {
        if says_hi(&p).await {
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(ok, "provider did not recover");
    let all = starts(&m);
    assert_eq!(all.len(), 3);
    let port_arg = |l: &String| {
        l.split(' ')
            .skip_while(|a| *a != "--port")
            .nth(1)
            .unwrap()
            .to_owned()
    };
    assert!(all.iter().all(|l| port_arg(l) == port_arg(&all[0])));
    rt.stop_all().await;
}

/// Serves `body` to every request on a loopback port; returns its URL.
async fn serve_bytes(body: Vec<u8>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/asset.zip", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = listener.accept().await else {
                return;
            };
            let body = body.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let _ = s.read(&mut buf).await;
                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(head.as_bytes()).await;
                let _ = s.write_all(&body).await;
            });
        }
    });
    url
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, data) in entries {
        w.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

fn entries(dir: &Path) -> usize {
    std::fs::read_dir(dir).unwrap().count()
}

#[tokio::test]
async fn bad_digest_refused() {
    let rt = runtime(None);
    // A real zip, but not the bytes the digest names.
    let served = zip_of(&[("llama-server.exe", b"not what you asked for")]);
    let url = serve_bytes(served).await;
    let dest = scratch("digest");
    let err = rt
        .install_archive(
            &url,
            &"0".repeat(64),
            &dest,
            (0, 100),
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(matches!(err, LocalError::BadDigest), "{err:?}");
    assert_eq!(entries(&dest), 0, "nothing unzipped, temp file removed");
}

#[tokio::test]
async fn zip_slip_refused() {
    let rt = runtime(None);
    let evil = zip_of(&[("llama-server.exe", b"fine"), ("../evil.txt", b"escaped")]);
    let url = serve_bytes(evil.clone()).await;
    let outer = scratch("slip");
    let dest = outer.join("inside");
    std::fs::create_dir_all(&dest).unwrap();
    // The digest is right, so only the path can stop it.
    let err = rt
        .install_archive(
            &url,
            &hex(&evil),
            &dest,
            (0, 100),
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(matches!(err, LocalError::UnsafeArchive(_)), "{err:?}");
    assert!(!outer.join("evil.txt").exists());

    // Control: the same path with a good archive installs, so the refusal above was the path.
    let good = zip_of(&[("bin/llama-server.exe", b"fine")]);
    let url = serve_bytes(good.clone()).await;
    let dest = scratch("good");
    rt.install_archive(
        &url,
        &hex(&good),
        &dest,
        (0, 100),
        None,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(dest.join("bin").join("llama-server.exe").is_file());
}
