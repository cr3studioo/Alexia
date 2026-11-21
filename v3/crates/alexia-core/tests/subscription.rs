// SPDX-License-Identifier: AGPL-3.0-only
//! P2-35: the subscription provider against fake CLIs. Nothing here signs in to, or calls, a real
//! vendor CLI.
//!
//! One std-only Rust program plays both CLIs (`exec` in argv means Codex), compiled once with
//! `rustc`. Each test copies it into its own folder and writes `mode.txt` beside it: `text`,
//! `rate`, `notsigned` or `hang`. It records its argv in `args.txt` and its stdin in `stdin.txt`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use alexia_core::subscription::{Cli, SubscriptionCli};
use alexia_core::{ChatChunk, ChatRequest, Provider, ProviderError};
use alexia_store::{MessageBody, Role};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const FAKE: &str = r##"
use std::io::{Read, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = std::env::current_exe().unwrap().parent().unwrap().to_owned();
    let mode = std::fs::read_to_string(dir.join("mode.txt")).unwrap_or_default();
    let mode = mode.trim();
    let codex = args.iter().any(|a| a == "exec");
    if args.first().map(|a| a == "--version").unwrap_or(false) {
        println!("fake 1.0");
        return;
    }
    if args.len() == 2 && (args[0] == "auth" || args[0] == "login") {
        if mode == "notsigned" {
            eprintln!("not logged in");
            std::process::exit(1);
        }
        println!("signed in");
        return;
    }
    let mut log = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("args.txt")).unwrap();
    writeln!(log, "{}", args.join(" ")).unwrap();
    writeln!(log, "cwd={}", std::env::current_dir().unwrap().display()).unwrap();
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    std::fs::write(dir.join("stdin.txt"), &input).unwrap();
    let out = std::io::stdout();
    let mut out = out.lock();
    match mode {
        "rate" => {
            if codex {
                writeln!(out, r#"{{"type":"error","message":"You have hit your usage limit. Try again later."}}"#).unwrap();
            } else {
                writeln!(out, r#"{{"type":"result","is_error":true,"result":"Claude AI usage limit reached","usage":{{}}}}"#).unwrap();
            }
            std::process::exit(1);
        }
        "hang" => {
            std::fs::write(dir.join("started.txt"), "1").unwrap();
            let mut beat = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("beat.txt")).unwrap();
            loop {
                let _ = write!(beat, ".");
                let _ = beat.flush();
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
        _ => {
            if codex {
                writeln!(out, r#"{{"type":"thread.started","thread_id":"t"}}"#).unwrap();
                writeln!(out, r#"{{"type":"item.completed","item":{{"id":"1","type":"agent_message","text":"hello from codex"}}}}"#).unwrap();
                writeln!(out, r#"{{"type":"turn.completed","usage":{{"input_tokens":7,"output_tokens":3}}}}"#).unwrap();
            } else {
                writeln!(out, r#"{{"type":"system","subtype":"init"}}"#).unwrap();
                writeln!(out, r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"hello "}}]}}}}"#).unwrap();
                writeln!(out, r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"from claude"}}]}}}}"#).unwrap();
                writeln!(out, r#"{{"type":"result","is_error":false,"result":"hello from claude","usage":{{"input_tokens":7,"output_tokens":3}}}}"#).unwrap();
            }
        }
    }
}
"##;

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn scratch(name: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir =
        std::env::temp_dir().join(format!("alexia-sub-test-{}-{name}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

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
        exe
    })
}

/// A private copy of the fake in `mode`; returns its folder and the provider.
fn cli(which: Cli, mode: &str) -> (PathBuf, SubscriptionCli) {
    let dir = scratch(mode);
    let exe = dir.join(fake_exe().file_name().unwrap());
    std::fs::copy(fake_exe(), &exe).unwrap();
    std::fs::write(dir.join("mode.txt"), mode).unwrap();
    (dir, SubscriptionCli::at(which, exe))
}

fn request(text: &str) -> ChatRequest {
    ChatRequest {
        messages: vec![(
            Role::User,
            serde_json::from_value::<MessageBody>(serde_json::json!({"content": text})).unwrap(),
        )],
        system: None,
        tools: vec![],
        max_tokens: None,
    }
}

async fn ask(
    c: &SubscriptionCli,
    text: &str,
) -> (Result<alexia_core::ChatDone, ProviderError>, String) {
    let (tx, mut rx) = mpsc::channel(64);
    let r = c
        .chat(&request(text), "default", tx, CancellationToken::new())
        .await;
    let mut got = String::new();
    while let Ok(ChatChunk::Text(t)) = rx.try_recv() {
        got.push_str(&t);
    }
    (r, got)
}

#[tokio::test]
async fn streams_text() {
    for (which, id, want) in [
        (
            Cli::ClaudeCode,
            "subscription:claude-code",
            "hello from claude",
        ),
        (Cli::Codex, "subscription:codex", "hello from codex"),
    ] {
        let (_dir, c) = cli(which, "text");
        assert_eq!(c.id(), id);
        let models = c.models().await.unwrap();
        assert_eq!(models.len(), 1);
        assert!(models[0].free && !models[0].tools);
        let (r, got) = ask(&c, "hi").await;
        let done = r.unwrap();
        assert_eq!(got, want);
        assert_eq!(done.cost, 0.0);
        assert_eq!((done.tokens_in, done.tokens_out), (7, 3));
        assert_eq!(done.provider, id);
        assert!(done.first_byte_ms.is_some());
        c.check().await.unwrap();
    }
}

#[tokio::test]
async fn prompt_on_stdin_not_argv() {
    let secret = "private-prompt-marker-7731";
    for which in [Cli::ClaudeCode, Cli::Codex] {
        let (dir, c) = cli(which, "text");
        ask(&c, secret).await.0.unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("stdin.txt")).unwrap(),
            secret
        );
        let args = std::fs::read_to_string(dir.join("args.txt")).unwrap();
        assert!(!args.contains(secret), "{args}");
        // Runs in an empty temp folder, not in the fake's own folder, with tools off.
        let cwd = args.lines().find_map(|l| l.strip_prefix("cwd=")).unwrap();
        assert!(
            cwd.contains("alexia-sub-") && !cwd.contains("alexia-sub-test-"),
            "{cwd}"
        );
        assert!(
            !Path::new(cwd).exists(),
            "work folder is removed afterwards"
        );
        let first = args.lines().next().unwrap();
        match which {
            Cli::ClaudeCode => {
                assert!(
                    first.contains("-p") && first.contains("stream-json"),
                    "{first}"
                );
                assert!(first.contains("--permission-mode plan"), "{first}");
            }
            Cli::Codex => {
                assert!(first.starts_with("exec --json"), "{first}");
                assert!(first.contains("--sandbox read-only"), "{first}");
            }
        }
    }
}

#[tokio::test]
async fn not_signed_in_sentence() {
    for (which, name) in [(Cli::ClaudeCode, "Claude Code"), (Cli::Codex, "Codex")] {
        let (_dir, c) = cli(which, "notsigned");
        let e = c.check().await.unwrap_err();
        assert!(e.contains("not signed in"), "{e}");
        assert!(e.contains(name), "{e}");
    }
}

#[tokio::test]
async fn rate_limit_is_busy() {
    for which in [Cli::ClaudeCode, Cli::Codex] {
        let (_dir, c) = cli(which, "rate");
        let (r, _) = ask(&c, "hi").await;
        assert!(matches!(r, Err(ProviderError::Busy { .. })), "{r:?}");
    }
}

#[tokio::test]
async fn cancel_kills_child() {
    let (dir, c) = cli(Cli::ClaudeCode, "hang");
    let cancel = CancellationToken::new();
    let (tx, _rx) = mpsc::channel(8);
    let stop = cancel.clone();
    let waiter = {
        let dir = dir.clone();
        tokio::spawn(async move {
            let t = Instant::now();
            while !dir.join("started.txt").exists() {
                assert!(t.elapsed() < Duration::from_secs(60), "fake never started");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            stop.cancel();
        })
    };
    let r = tokio::time::timeout(
        Duration::from_secs(60),
        c.chat(&request("hi"), "default", tx, cancel),
    )
    .await
    .expect("chat returns after cancel");
    assert!(matches!(r, Err(ProviderError::Cancelled)), "{r:?}");
    waiter.await.unwrap();
    // The fake appends to beat.txt every 100 ms; a dead child stops writing.
    tokio::time::sleep(Duration::from_secs(1)).await;
    let size = std::fs::metadata(dir.join("beat.txt")).unwrap().len();
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(
        std::fs::metadata(dir.join("beat.txt")).unwrap().len(),
        size,
        "child still running"
    );
}

#[test]
fn not_installed_is_none() {
    // Only this test touches these two variables.
    std::env::set_var("ALEXIA_CODEX_CLI", scratch("none").join("no-such-codex"));
    assert!(SubscriptionCli::find(Cli::Codex).is_none());
    let (dir, _) = cli(Cli::ClaudeCode, "text");
    std::env::set_var(
        "ALEXIA_CLAUDE_CLI",
        dir.join(fake_exe().file_name().unwrap()),
    );
    assert_eq!(
        SubscriptionCli::find(Cli::ClaudeCode).unwrap().id(),
        "subscription:claude-code"
    );
}
