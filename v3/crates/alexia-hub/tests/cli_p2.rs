// SPDX-License-Identifier: AGPL-3.0-only
//! P2: `alexia-hub run` with the Agent as its brain (P2-38), run as the owner runs it, against a
//! fake Bot API and a fake free provider, and the P2 CLI verbs (P2-48). Nothing real is called.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

const TOKEN: &str = "p2-dummy-token";
/// The owner: a private chat's id is its user's id.
const OWNER: i64 = 4242;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Polls `cond` every 50 ms for up to `secs`.
async fn until(secs: u64, mut cond: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    cond()
}

// ---- raw HTTP/1.1 ----

struct Req {
    path: String,
    body: Vec<u8>,
}

/// The next request on a kept-alive connection, or `None` when the peer is gone.
async fn read_req(sock: &mut TcpStream, buf: &mut Vec<u8>) -> Option<Req> {
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).into_owned();
            let len: usize = head
                .lines()
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length").then(|| v.trim())
                })
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            let total = end + 4 + len;
            if buf.len() >= total {
                let body = buf[end + 4..total].to_vec();
                buf.drain(..total);
                let path = head.split_whitespace().nth(1).unwrap_or("").to_owned();
                return Some(Req { path, body });
            }
        }
        let mut tmp = [0u8; 8192];
        let n = sock.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
}

async fn answer(sock: &mut TcpStream, body: &str) -> bool {
    let all = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    );
    sock.write_all(all.as_bytes()).await.is_ok() && sock.flush().await.is_ok()
}

async fn listen() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    (listener, format!("http://{addr}"))
}

// ---- the fake Bot API ----

#[derive(Default)]
struct BotState {
    queue: Vec<(i64, Value)>,
    next_id: i64,
    sent: Vec<String>,
}

struct Bot {
    st: Mutex<BotState>,
    wake: Notify,
}

impl Bot {
    async fn start() -> (Arc<Bot>, String) {
        let bot = Arc::new(Bot {
            st: Mutex::default(),
            wake: Notify::new(),
        });
        let (listener, base) = listen().await;
        let b = bot.clone();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                tokio::spawn(b.clone().conn(sock));
            }
        });
        (bot, base)
    }

    /// The owner says `text`.
    fn say(&self, text: &str) {
        let mut st = lock(&self.st);
        st.next_id += 1;
        let id = st.next_id;
        let update = json!({"update_id": id, "message": {
            "message_id": id, "date": 0,
            "chat": {"id": OWNER, "type": "private"},
            "from": {"id": OWNER, "is_bot": false, "username": "owner"},
            "text": text,
        }});
        st.queue.push((id, update));
        drop(st);
        self.wake.notify_one();
    }

    fn sent(&self) -> Vec<String> {
        lock(&self.st).sent.clone()
    }

    async fn conn(self: Arc<Self>, mut sock: TcpStream) {
        let mut buf = Vec::new();
        while let Some(req) = read_req(&mut sock, &mut buf).await {
            let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
            let ok = match req.path.rsplit('/').next().unwrap_or("") {
                "getUpdates" => self.get_updates(&mut sock, &body).await,
                "sendMessage" => {
                    let id = {
                        let mut st = lock(&self.st);
                        st.sent.push(body["text"].as_str().unwrap_or("").to_owned());
                        100_000 + st.sent.len()
                    };
                    let r = json!({"ok": true, "result": {"message_id": id}});
                    answer(&mut sock, &r.to_string()).await
                }
                _ => answer(&mut sock, r#"{"ok":true,"result":true}"#).await,
            };
            if !ok {
                return;
            }
        }
    }

    /// Long poll: answers at once when something is waiting, else when something arrives.
    async fn get_updates(&self, sock: &mut TcpStream, body: &Value) -> bool {
        let offset = body["offset"].as_i64().unwrap_or(0);
        let wait = Duration::from_secs(body["timeout"].as_u64().unwrap_or(0).min(50));
        let until = tokio::time::Instant::now() + wait;
        let updates = loop {
            let ready: Vec<Value> = {
                let mut st = lock(&self.st);
                st.queue.retain(|(id, _)| *id >= offset);
                st.queue.iter().map(|(_, u)| u.clone()).collect()
            };
            if !ready.is_empty() {
                break ready;
            }
            if tokio::time::timeout_at(until, self.wake.notified())
                .await
                .is_err()
            {
                break Vec::new();
            }
        };
        answer(sock, &json!({"ok": true, "result": updates}).to_string()).await
    }
}

// ---- the fake free provider ----

/// One keyless OpenAI-compatible provider whose one model can use tools. Every chat answers
/// "You said: <the last user text>" and is kept, so a test can read what the hub sent.
struct Provider {
    base: String,
    chats: Mutex<Vec<Value>>,
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
            tokio::spawn(provider_conn(state.clone(), sock));
        }
    });
    p
}

async fn provider_conn(p: Arc<Provider>, mut sock: TcpStream) {
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
        let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
        let said = last_user_text(&body);
        lock(&p.chats).push(body);
        let frame = |delta: Value, finish: Value| {
            let f = json!({"model": "fake-tools-70b", "choices": [{"delta": delta, "finish_reason": finish}]});
            format!("data: {f}\n\n")
        };
        let all = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n{}{}data: [DONE]\n\n",
            frame(json!({"content": format!("You said: {said}")}), Value::Null),
            frame(json!({}), json!("stop")),
        );
        let _ = sock.write_all(all.as_bytes()).await;
        let _ = sock.flush().await;
        return;
    }
}

fn last_user_text(body: &Value) -> String {
    let content = body["messages"]
        .as_array()
        .and_then(|m| m.iter().rev().find(|m| m["role"] == "user"))
        .map(|m| m["content"].clone())
        .unwrap_or(Value::Null);
    match content {
        Value::String(s) => s,
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

// ---- the hub ----

/// A fresh data and plugin folder per test.
struct Env {
    root: PathBuf,
    data: PathBuf,
    plugins: PathBuf,
}

fn env(name: &str) -> Env {
    let root = std::env::temp_dir().join(format!("alexia-hub-p2-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let (data, plugins) = (root.join("data"), root.join("plugins"));
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&plugins).unwrap();
    Env {
        root,
        data,
        plugins,
    }
}

/// `alexia-hub run` with nothing real reachable: no channel, no provider, no subscription CLI
/// (both point at a file that does not exist) unless a test sets one.
fn command(e: &Env) -> Command {
    let none = e.root.join("not-installed");
    let mut c = Command::new(env!("CARGO_BIN_EXE_alexia-hub"));
    c.env("ALEXIA_V3_DATA", &e.data)
        .env("ALEXIA_PLUGINS_DIR", &e.plugins)
        .env("ALEXIA_SECRETS_IN_MEMORY", "1")
        .env("ALEXIA_HUB_STOP_ON_EOF", "1")
        .env("ALEXIA_CLAUDE_CLI", &none)
        .env("ALEXIA_CODEX_CLI", &none)
        .env("NO_PROXY", "127.0.0.1,localhost")
        .env("no_proxy", "127.0.0.1,localhost")
        .env_remove("ALEXIA_TELEGRAM_API")
        .env_remove("ALEXIA_FREE_PROVIDERS");
    c
}

/// A bot at `bot` and the one provider `p`, with the bot token in the environment.
fn wire(c: &mut Command, e: &Env, bot: &str, p: &Provider) {
    let path = e.root.join("providers.json");
    let row = json!([{"id": "fakep", "base_url": p.base, "models_path": "/models", "auth": "none", "all_free": true}]);
    std::fs::write(&path, row.to_string()).unwrap();
    c.env("ALEXIA_TELEGRAM_API", bot)
        .env("ALEXIA_FREE_PROVIDERS", path)
        .env(
            alexia_store::secrets::env_name("_core", "telegram_bot_token"),
            TOKEN,
        );
}

struct Hub {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Arc<Mutex<Vec<String>>>,
    stderr: Arc<Mutex<Vec<String>>>,
}

fn lines_of<R: std::io::Read + Send + 'static>(r: R) -> Arc<Mutex<Vec<String>>> {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(r).lines().map_while(Result::ok) {
            lock(&sink).push(line);
        }
    });
    lines
}

impl Hub {
    fn run(mut c: Command) -> Hub {
        let mut child = c
            .arg("run")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        Hub {
            stdin: child.stdin.take(),
            stdout: lines_of(child.stdout.take().unwrap()),
            stderr: lines_of(child.stderr.take().unwrap()),
            child,
        }
    }

    fn said(&self, needle: &str) -> bool {
        lock(&self.stdout).iter().any(|l| l.contains(needle))
    }

    fn logged(&self, needle: &str) -> bool {
        lock(&self.stderr).iter().any(|l| l.contains(needle))
    }

    fn log(&self) -> String {
        let tail = |l: &Mutex<Vec<String>>| {
            let l = lock(l);
            l[l.len().saturating_sub(40)..].join("\n")
        };
        format!(
            "--- hub stdout ---\n{}\n--- hub stderr ---\n{}",
            tail(&self.stdout),
            tail(&self.stderr)
        )
    }

    async fn up(&self) {
        assert!(
            until(120, || self.said("Alexia hub is running")).await,
            "the hub did not come up\n{}",
            self.log()
        );
    }

    /// EOF on stdin is the stop signal. Its exit code, or `None` when it did not stop in 60 s.
    async fn stop(&mut self) -> Option<i32> {
        drop(self.stdin.take());
        let end = Instant::now() + Duration::from_secs(60);
        while Instant::now() < end {
            if let Ok(Some(status)) = self.child.try_wait() {
                tokio::time::sleep(Duration::from_millis(200)).await;
                return status.code();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        None
    }

    /// Prints the pairing code's owner sends it, and waits for "Paired".
    async fn pair(&self, bot: &Bot) {
        assert!(
            until(120, || self.said("to pair it")).await,
            "no pairing code\n{}",
            self.log()
        );
        let code = lock(&self.stdout)
            .iter()
            .find(|l| l.contains("to pair it"))
            .and_then(|l| l.split_whitespace().nth(1).map(str::to_owned))
            .unwrap();
        bot.say(&code);
        assert!(
            until(60, || bot.sent().iter().any(|m| m.starts_with("Paired"))).await,
            "the hub did not pair\n{}",
            self.log()
        );
    }
}

impl Drop for Hub {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// `<plugins>/<id>/plugin.json` with `extra` merged in.
fn plugin(e: &Env, id: &str, run: &str, args: &[&str], extra: Value) -> PathBuf {
    let dir = e.plugins.join(id);
    std::fs::create_dir_all(&dir).unwrap();
    let mut manifest = json!({
        "manifest_version": 1,
        "id": id,
        "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": run, "args": args },
        "alexia_protocol": 2,
        "mcp_protocol": "2025-11-25"
    });
    for (k, v) in extra.as_object().unwrap() {
        manifest[k] = v.clone();
    }
    std::fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
    dir
}

/// Pairs, says `text` (a task), and waits for the reply. The provider's chats so far.
async fn task(hub: &Hub, bot: &Bot, p: &Provider, text: &str) -> Vec<Value> {
    hub.pair(bot).await;
    bot.say(text);
    assert!(
        until(120, || bot
            .sent()
            .iter()
            .any(|m| m.contains("You said:") && m.contains(text)))
        .await,
        "no answer to the task; the bot got {:?}\n{}",
        bot.sent(),
        hub.log()
    );
    lock(&p.chats).clone()
}

// ---- the tests ----

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn run_without_v2_answers_a_task() {
    let e = env("task");
    let ((bot, base), p) = (Bot::start().await, provider().await);
    let mut c = command(&e);
    wire(&mut c, &e, &base, &p);
    let mut hub = Hub::run(c);
    hub.up().await;
    let text = "search for my notes about the garden";
    let chats = task(&hub, &bot, &p, text).await;
    // The task lane is the Agent: its requests offer tools (the fast chat lane never does).
    assert!(
        chats.iter().any(|b| last_user_text(b).contains(text)
            && b["tools"].as_array().is_some_and(|t| !t.is_empty())),
        "no request for the task offered tools: {chats:?}"
    );
    assert_eq!(hub.stop().await, Some(0), "{}", hub.log());
    assert!(hub.said("Stopped."), "{}", hub.log());
    let everything = format!("{}{}", hub.log(), lock(&hub.stdout).join("\n"));
    assert!(!everything.contains("v2 core"), "{everything}");
    let _ = std::fs::remove_dir_all(&e.root);
}

/// A resident plugin that writes the first line it is sent (`initialize`) to `init.txt` in its
/// own folder and exits. Its `initialize` carries the agent's offers only if `host.start` came
/// after `host.set_upcalls(agent)`; `NoUpcalls` offers no sampling.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn run_offers_sampling_to_resident_plugin() {
    let e = env("resident");
    let id = "recorder";
    #[cfg(windows)]
    let (run, args) = ("cmd", ["/v:on", "/c", "set /p L= & echo !L!> init.txt"]);
    #[cfg(not(windows))]
    let (run, args) = ("sh", ["-c", "head -n 1 > init.txt"]);
    plugin(&e, id, run, &args, json!({"lifetime": "resident"}));
    let init = alexia_store::Layout::new(e.data.clone())
        .own_dir(id)
        .join("init.txt");
    let mut hub = Hub::run(command(&e));
    hub.up().await;
    let line = || std::fs::read_to_string(&init).unwrap_or_default();
    assert!(
        until(60, || line().contains("initialize")).await,
        "the resident plugin never got its initialize ({}): {:?}\n{}",
        init.display(),
        line(),
        hub.log()
    );
    let msg: Value = serde_json::from_str(line().trim())
        .unwrap_or_else(|err| panic!("initialize is not JSON ({err}): {}", line()));
    let caps = &msg["params"]["capabilities"];
    assert!(caps["sampling"].is_object(), "no sampling offered: {msg}");
    assert!(caps["roots"].is_object(), "no roots offered: {msg}");
    assert_eq!(hub.stop().await, Some(0), "{}", hub.log());
    let _ = std::fs::remove_dir_all(&e.root);
}

/// A fake `claude` CLI: `--version` passes; `auth status` passes only when `signed_in`.
fn fake_claude(e: &Env, signed_in: bool) -> PathBuf {
    let status = if signed_in { 0 } else { 1 };
    #[cfg(windows)]
    let path = {
        let path = e.root.join("claude.cmd");
        let script = format!("@echo off\r\nif \"%1\"==\"auth\" exit /b {status}\r\necho 2.0.0 (Claude Code)\r\nexit /b 0\r\n");
        std::fs::write(&path, script).unwrap();
        path
    };
    #[cfg(not(windows))]
    let path = {
        use std::os::unix::fs::PermissionsExt;
        let path = e.root.join("claude");
        let script =
            format!("#!/bin/sh\n[ \"$1\" = auth ] && exit {status}\necho '2.0.0 (Claude Code)'\n");
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    };
    path
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn run_registers_signed_in_subscription() {
    for signed_in in [true, false] {
        let e = env(&format!("subscription-{signed_in}"));
        let mut c = command(&e);
        c.env("ALEXIA_CLAUDE_CLI", fake_claude(&e, signed_in));
        let mut hub = Hub::run(c);
        hub.up().await;
        if signed_in {
            assert!(
                hub.logged("subscription:claude-code registered"),
                "{}",
                hub.log()
            );
        } else {
            assert!(hub.logged("ClaudeCode skipped"), "{}", hub.log());
            assert!(hub.logged("not signed in"), "{}", hub.log());
            assert!(!hub.logged("registered"), "{}", hub.log());
        }
        // Codex is not installed (its path does not exist): skipped, never an error.
        assert!(hub.logged("Codex is not installed"), "{}", hub.log());
        assert_eq!(hub.stop().await, Some(0), "{}", hub.log());
        let _ = std::fs::remove_dir_all(&e.root);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn run_loads_plugin_skills() {
    let e = env("skills");
    let dir = plugin(
        &e,
        "gardener",
        "gardener-not-run",
        &[],
        json!({"skills": ["skills"]}),
    );
    let skill = dir.join("skills").join("water-the-plants");
    std::fs::create_dir_all(&skill).unwrap();
    let description = "How to water the plants on the balcony without drowning them.";
    std::fs::write(
        skill.join("SKILL.md"),
        format!("---\nname: water-the-plants\ndescription: {description}\n---\n\nUse the can.\n"),
    )
    .unwrap();
    let ((bot, base), p) = (Bot::start().await, provider().await);
    let mut c = command(&e);
    wire(&mut c, &e, &base, &p);
    let mut hub = Hub::run(c);
    hub.up().await;
    let chats = task(&hub, &bot, &p, "search for how to water the garden").await;
    // The `skill` builtin lists the plugin's skill by name and description.
    let listed = chats.iter().any(|b| {
        b["tools"].as_array().is_some_and(|tools| {
            tools.iter().any(|t| {
                let f = &t["function"];
                f["name"] == "skill"
                    && f["description"].as_str().is_some_and(|d| {
                        d.contains("- water-the-plants: ") && d.contains(description)
                    })
            })
        })
    });
    assert!(
        listed,
        "the skill builtin did not list the plugin's skill: {chats:?}"
    );
    assert_eq!(hub.stop().await, Some(0), "{}", hub.log());
    let _ = std::fs::remove_dir_all(&e.root);
}

// ---- the P2 CLI verbs (P2-48) ----

/// `alexia-hub <args>` against `e`'s data, `input` on stdin; waits for it.
fn cli(e: &Env, args: &[&str], input: &str) -> std::process::Output {
    use std::io::Write;
    let mut child = command(e)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let _ = stdin.write_all(input.as_bytes());
    drop(stdin);
    child.wait_with_output().unwrap()
}

fn out(o: &std::process::Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn err(o: &std::process::Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

fn store(e: &Env) -> alexia_store::Store {
    alexia_store::Store::open(&alexia_store::Layout::new(e.data.clone()).db()).unwrap()
}

fn audit_row(run: &str, step: u32, at: i64, tool: &str, args: Value) -> alexia_store::AuditRow {
    alexia_store::AuditRow {
        id: 0,
        at,
        run: run.into(),
        session: None,
        origin: json!({"kind": "owner"}).to_string(),
        step,
        tool: tool.into(),
        plugin: None,
        args: args.to_string(),
        gate: "run".into(),
        decision: "ran".into(),
        why: None,
        ok: Some(true),
        result: None,
        undo: None,
        undone_at: None,
    }
}

#[test]
fn activity_lists_calls() {
    let e = env("activity");
    {
        let s = store(&e);
        s.audit(&audit_row(
            "run-a",
            1,
            1_000,
            "notes.search",
            json!({"q": "garden"}),
        ))
        .unwrap();
        s.audit(&audit_row(
            "run-a",
            2,
            2_000,
            "files.write",
            json!({"path": "plan.txt"}),
        ))
        .unwrap();
    }
    let o = cli(&e, &["activity"], "");
    assert!(o.status.success(), "{}", err(&o));
    let lines: Vec<String> = out(&o).lines().map(str::to_owned).collect();
    assert_eq!(lines.len(), 2, "{lines:?}");
    // Newest first, one line per call.
    assert!(
        lines[0].contains("files.write") && lines[0].contains("run-a"),
        "{lines:?}"
    );
    assert!(
        lines[1].contains("notes.search") && lines[1].contains("ran"),
        "{lines:?}"
    );

    let o = cli(&e, &["activity", "--last", "1"], "");
    assert_eq!(out(&o).lines().count(), 1, "{}", out(&o));
    assert!(out(&o).contains("files.write"), "{}", out(&o));

    let o = cli(&e, &["activity", "garden"], "");
    assert!(o.status.success(), "{}", err(&o));
    assert_eq!(out(&o).lines().count(), 1, "{}", out(&o));
    assert!(out(&o).contains("notes.search"), "{}", out(&o));

    let o = cli(&e, &["activity", "--last", "zero"], "");
    assert_eq!(o.status.code(), Some(1), "{}", err(&o));
    let _ = std::fs::remove_dir_all(&e.root);
}

#[test]
fn runs_show_replays() {
    let e = env("runs");
    {
        let s = store(&e);
        let body = json!({
            "at": 1_000, "until": 4_000, "ended": "answered", "answered": "fakep/fake-tools-70b",
            "steps": [{"n": 1, "name": "notes.search", "args": {"q": "garden"}, "ok": true}],
        });
        s.save_run("run-garden", 1_000, &body).unwrap();
        s.audit(&audit_row(
            "run-garden",
            1,
            2_000,
            "notes.search",
            json!({"q": "garden"}),
        ))
        .unwrap();
    }
    let o = cli(&e, &["runs", "--last", "5"], "");
    assert!(o.status.success(), "{}", err(&o));
    assert!(
        out(&o).contains("run-garden") && out(&o).contains("Finished"),
        "{}",
        out(&o)
    );

    let o = cli(&e, &["runs", "show", "run-garden"], "");
    assert!(o.status.success(), "{}", err(&o));
    let text = out(&o);
    assert!(text.contains("# Run run-garden"), "{text}");
    assert!(text.contains("## 1. notes.search"), "{text}");
    assert!(text.contains("run -> ran"), "{text}");

    let o = cli(&e, &["runs", "show", "no-such-run"], "");
    assert_eq!(o.status.code(), Some(1), "{}", err(&o));
    assert!(err(&o).contains("No run has that id"), "{}", err(&o));
    let _ = std::fs::remove_dir_all(&e.root);
}

#[test]
fn approvals_empty() {
    let e = env("approvals");
    let o = cli(&e, &["approvals"], "");
    assert!(o.status.success(), "{}", err(&o));
    assert_eq!(out(&o).trim(), "No questions are waiting.");

    let id = store(&e)
        .approval_open("run-ask", "{}", "May I delete plan.txt?", None, 5_000)
        .unwrap();
    let o = cli(&e, &["approvals"], "");
    assert!(o.status.success(), "{}", err(&o));
    assert!(
        out(&o).starts_with(&format!("{id}\t")) && out(&o).contains("May I delete plan.txt?"),
        "{}",
        out(&o)
    );
    let _ = std::fs::remove_dir_all(&e.root);
}

#[test]
fn models_use_sets_pin() {
    let e = env("models");
    let o = cli(
        &e,
        &["models", "use", "plan", "subscription:claude-code"],
        "",
    );
    assert!(o.status.success(), "{}", err(&o));
    assert_eq!(
        store(&e).kv_get("_core", "models").unwrap(),
        Some(json!({"plan": ["subscription:claude-code"]}))
    );
    let o = cli(&e, &["models"], "");
    assert!(o.status.success(), "{}", err(&o));
    assert!(
        out(&o).contains("pin\tplan\tsubscription:claude-code"),
        "{}",
        out(&o)
    );

    // A local pin must name an installed model; an unknown job and a shapeless pin are refused.
    for args in [
        ["models", "use", "chat", "local:not-installed"],
        ["models", "use", "nojob", "auto"],
        ["models", "use", "chat", "nonsense"],
    ] {
        let o = cli(&e, &args, "");
        assert_eq!(o.status.code(), Some(1), "{args:?}: {}", err(&o));
    }

    let o = cli(&e, &["models", "use", "plan", "auto"], "");
    assert!(o.status.success(), "{}", err(&o));
    assert_eq!(
        store(&e).kv_get("_core", "models").unwrap(),
        Some(json!({}))
    );
    let _ = std::fs::remove_dir_all(&e.root);
}

#[test]
fn scope_add_lists() {
    let e = env("scope");
    let folder = e.root.join("garden-notes");
    std::fs::create_dir_all(&folder).unwrap();
    let f = folder.to_str().unwrap();
    let o = cli(&e, &["scope", "add", f], "");
    assert!(o.status.success(), "{}", err(&o));
    let o = cli(&e, &["scope", "list"], "");
    assert!(o.status.success(), "{}", err(&o));
    assert_eq!(out(&o).trim(), f);
    // What `scope` lists is what the permission rules read.
    let scope = alexia_core::permissions::scope(&store(&e), &e.data);
    assert_eq!(scope.roots, vec![folder.clone()]);

    // A missing folder and Alexia's own data folder are refused.
    let missing = e.root.join("not-there");
    for f in [missing.to_str().unwrap(), e.data.to_str().unwrap()] {
        let o = cli(&e, &["scope", "add", f], "");
        assert_eq!(o.status.code(), Some(1), "{f}: {}", err(&o));
    }

    let o = cli(&e, &["scope", "remove", f], "");
    assert!(o.status.success(), "{}", err(&o));
    assert_eq!(out(&o).trim(), "");
    let o = cli(&e, &["scope", "remove", f], "");
    assert_eq!(o.status.code(), Some(1), "{}", err(&o));

    // Game folders go the same way, into what the GPU watch reads.
    let o = cli(&e, &["models", "games", "add", f], "");
    assert!(o.status.success(), "{}", err(&o));
    assert_eq!(
        alexia_core::gpu::game_dirs(&store(&e)).last(),
        Some(&folder)
    );
    let o = cli(&e, &["models", "games", "list"], "");
    assert_eq!(out(&o).trim(), f);
    let _ = std::fs::remove_dir_all(&e.root);
}

#[test]
fn secret_set_plugin_key_declared_only() {
    let e = env("plugin-secret");
    plugin(
        &e,
        "gardener",
        "gardener-not-run",
        &[],
        json!({"settings": [
            {"key": "api_password", "type": "password"},
            {"key": "city", "type": "text"},
        ]}),
    );
    let value = "plugin-value-that-must-stay-quiet-5521";
    // The declared key passes the check and reaches the in-memory refusal (tests never write the
    // keychain); the value is never printed.
    let o = cli(
        &e,
        &["secret", "set", "gardener.api_password"],
        &format!("{value}\n"),
    );
    assert_eq!(o.status.code(), Some(1), "{}", err(&o));
    assert!(
        err(&o).contains("Secrets are in memory for tests"),
        "{}",
        err(&o)
    );
    assert!(!out(&o).contains(value) && !err(&o).contains(value));
    // A setting that is not a `password`, an undeclared key and a pasted token are not known,
    // and what was typed is never echoed.
    for key in ["gardener.city", "gardener.token", "pasted.token-4417"] {
        let o = cli(&e, &["secret", "set", key], &format!("{value}\n"));
        assert_eq!(o.status.code(), Some(1), "{key}: {}", err(&o));
        assert!(err(&o).contains("not a known key"), "{key}: {}", err(&o));
        assert!(err(&o).contains("gardener.api_password"), "{}", err(&o));
        for text in [value, key] {
            assert!(!out(&o).contains(text) && !err(&o).contains(text), "{text}");
        }
    }
    let o = cli(&e, &["secret", "clear", "gardener.api_password"], "");
    assert!(
        err(&o).contains("Secrets are in memory for tests"),
        "{}",
        err(&o)
    );
    let _ = std::fs::remove_dir_all(&e.root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn encrypt_refuses_while_running() {
    let e = env("encrypt");
    let db = alexia_store::Layout::new(e.data.clone()).db();
    let mut hub = Hub::run(command(&e));
    hub.up().await;
    let o = cli(&e, &["encrypt"], "");
    assert_eq!(o.status.code(), Some(1), "{}", err(&o));
    assert!(err(&o).contains("The database is in use"), "{}", err(&o));
    assert!(!alexia_store::Store::is_encrypted(&db).unwrap());
    assert_eq!(hub.stop().await, Some(0), "{}", hub.log());

    // Stopped, it encrypts (the in-memory key is gone afterwards; this folder is thrown away).
    let o = cli(&e, &["encrypt"], "");
    assert!(o.status.success(), "{}", err(&o));
    assert!(alexia_store::Store::is_encrypted(&db).unwrap());
    let _ = std::fs::remove_dir_all(&e.root);
}
