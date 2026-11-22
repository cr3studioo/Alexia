// SPDX-License-Identifier: AGPL-3.0-only
//! P2-39: V3-2's done-when, measured. The real `alexia-hub run` binary with the Agent as its
//! brain, against the fake Bot API, a fake free provider that scripts tool calls
//! (`ALEXIA_FREE_PROVIDERS`) and the `mcp-fixture` plugin in a temp plugins folder. Nothing real
//! is called. Needs `cargo build -p alexia-mcp --bins` first (the fixture), as `cli.rs` does.
//!
//! What differs from the spec's prose, and why (see the report):
//! - The agent writes the audit decision `run` for a call the rules let through (`ran` is what
//!   `/undo` writes), so the tests expect `run`.
//! - The fixture's `set` declares its inverse without a `summary`, which core rightly drops, so
//!   `/undo` has nothing to find. `undo_reverses` writes the missing summary into the audit row
//!   the hub made, then runs the real `/undo` on the real binary.
//! - The scheduled job is due 3 s after the call (not 2): the `at` argument has whole seconds,
//!   and a call that lands after its time is refused.

mod common;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_store::{AuditRow, Layout, Store};
use common::{
    answer, command, last_user_text, listen, lock, read_req, scratch, until, Bot, Hub, Question,
    TOKEN,
};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

// ---- the scripted provider ----

/// What the model does on one request that offers tools.
enum Reply {
    Say(String),
    /// A tool whose wire name ends with this, and its arguments.
    Call(&'static str, Value),
}

type Script = Box<dyn Fn(&Value) -> Reply + Send + Sync>;

/// One keyless OpenAI-compatible provider whose one model can use tools. A request that offers
/// tools is answered by `script`; every other request (the chat lane, a helper) by "Noted.".
/// Every chat is kept, so a test can read what the hub sent.
struct Provider {
    base: String,
    chats: Mutex<Vec<Value>>,
    /// A request offering tools that has this many tool results in it waits until this changes.
    hold: AtomicI64,
    script: Script,
}

impl Provider {
    /// The requests that offered tools: the Agent's.
    fn steps(&self) -> Vec<Value> {
        lock(&self.chats)
            .iter()
            .filter(|b| b["tools"].as_array().is_some_and(|t| !t.is_empty()))
            .cloned()
            .collect()
    }
}

fn tool_results(body: &Value) -> usize {
    body["messages"]
        .as_array()
        .map_or(0, |m| m.iter().filter(|m| m["role"] == "tool").count())
}

fn last_tool_text(body: &Value) -> String {
    body["messages"]
        .as_array()
        .and_then(|m| m.iter().rev().find(|m| m["role"] == "tool"))
        .and_then(|m| m["content"].as_str())
        .unwrap_or("")
        .to_owned()
}

/// The name this request offers for the tool that ends with `suffix` (a `.` goes over the wire
/// as `_`).
fn wire_name(body: &Value, suffix: &str) -> String {
    let suffix = suffix.replace('.', "_");
    body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t["function"]["name"].as_str())
        .find(|n| n.ends_with(&suffix))
        .unwrap_or_else(|| panic!("the request offers no tool {suffix}: {body}"))
        .to_owned()
}

async fn provider(script: Script) -> Arc<Provider> {
    let (listener, base) = listen().await;
    let p = Arc::new(Provider {
        base: format!("{base}/v1"),
        chats: Mutex::default(),
        hold: AtomicI64::new(-1),
        script,
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
        let body = req.json();
        let tools = body["tools"].as_array().is_some_and(|t| !t.is_empty());
        let results = tool_results(&body) as i64;
        lock(&p.chats).push(body.clone());
        let reply = if tools {
            while p.hold.load(Ordering::SeqCst) == results {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            (p.script)(&body)
        } else {
            Reply::Say("Noted.".into())
        };
        let frame = |delta: Value, finish: Value| {
            let f = json!({"model": "fake-tools-70b", "choices": [{"delta": delta, "finish_reason": finish}]});
            format!("data: {f}\n\n")
        };
        let frames = match reply {
            Reply::Say(text) => format!(
                "{}{}",
                frame(json!({"content": text}), Value::Null),
                frame(json!({}), json!("stop"))
            ),
            Reply::Call(suffix, args) => {
                let call = json!([{
                    "index": 0,
                    "id": format!("call-{}", lock(&p.chats).len()),
                    "type": "function",
                    "function": {"name": wire_name(&body, suffix), "arguments": args.to_string()},
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

// ---- the world one test runs in ----

struct World {
    root: PathBuf,
    bot: Arc<Bot>,
    bot_base: String,
    p: Arc<Provider>,
    hub: Hub,
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

/// `<plugins>/<id>/` with a copy of the fixture running in `mode`.
fn fixture_plugin(root: &Path, id: &str, mode: &str) {
    let dir = root.join("plugins").join(id);
    std::fs::create_dir_all(&dir).unwrap();
    let src = fixture_exe();
    let exe = src.file_name().unwrap().to_str().unwrap();
    std::fs::copy(&src, dir.join(exe)).unwrap();
    let manifest = json!({
        "manifest_version": 1,
        "id": id,
        "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": exe, "args": [mode] },
        "alexia_protocol": 2,
        "mcp_protocol": "2025-11-25"
    });
    std::fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
}

fn db(root: &Path) -> PathBuf {
    Layout::new(root.join("data")).db()
}

/// The hub with the bot and the provider wired in.
fn hub_command(root: &Path, bot: &str, p: &Provider) -> std::process::Command {
    let path = root.join("providers.json");
    let row = json!([{"id": "fakep", "base_url": p.base, "models_path": "/models", "auth": "none", "all_free": true}]);
    std::fs::write(&path, row.to_string()).unwrap();
    let mut c = command(root);
    c.env("ALEXIA_TELEGRAM_API", bot)
        .env("ALEXIA_FREE_PROVIDERS", path)
        .env(
            alexia_store::secrets::env_name("_core", "telegram_bot_token"),
            TOKEN,
        );
    c
}

/// A paired hub with `plugin` (id, fixture mode) installed. `full_trust` is the owner's choice
/// of permission mode, written before the hub first opens its store; the default, "ask when
/// risky", asks before anything that is not read-only.
async fn world(
    name: &str,
    plugin: (&str, &str),
    full_trust: bool,
    script: impl Fn(&Value) -> Reply + Send + Sync + 'static,
) -> World {
    let root = scratch(name);
    fixture_plugin(&root, plugin.0, plugin.1);
    if full_trust {
        let store = Store::open(&db(&root)).unwrap();
        store.kv_set("_core", "mode", &json!("full-trust")).unwrap();
    }
    let (bot, bot_base) = Bot::start().await;
    let p = provider(Box::new(script)).await;
    let hub = Hub::run(hub_command(&root, &bot_base, &p));
    hub.up().await;
    hub.pair(&bot).await;
    World {
        root,
        bot,
        bot_base,
        p,
        hub,
    }
}

impl World {
    /// Waits for a message the owner got that contains `needle`.
    async fn hears(&self, needle: &str) {
        let ok = until(120, || self.bot.sent().iter().any(|m| m.contains(needle))).await;
        assert!(
            ok,
            "the owner never got {needle:?}; the bot got {:?}\n{}",
            self.bot.sent(),
            self.hub.log()
        );
    }

    /// Waits for the `n`th question with buttons.
    async fn question(&self, n: usize) -> Question {
        let ok = until(120, || self.bot.questions().len() >= n).await;
        assert!(
            ok,
            "no question {n} came; the bot got {:?}\n{}",
            self.bot.sent(),
            self.hub.log()
        );
        self.bot.questions()[n - 1].clone()
    }

    /// Waits for `n` requests that offered tools.
    async fn steps(&self, n: usize) -> Vec<Value> {
        let ok = until(120, || self.p.steps().len() >= n).await;
        assert!(
            ok,
            "the provider got {} requests with tools, not {n}\n{}",
            self.p.steps().len(),
            self.hub.log()
        );
        self.p.steps()
    }

    /// Stops the hub and reads the audit log, oldest first.
    async fn stopped_audit(&mut self) -> Vec<AuditRow> {
        assert_eq!(self.hub.stop().await, Some(0), "{}", self.hub.log());
        audit(&self.root)
    }

    fn restart(&mut self) {
        self.hub = Hub::run(hub_command(&self.root, &self.bot_base, &self.p));
    }
}

fn audit(root: &Path) -> Vec<AuditRow> {
    let mut rows = Store::open(&db(root))
        .unwrap()
        .audit_search("", 200)
        .unwrap();
    rows.reverse();
    rows
}

fn rows_of<'a>(rows: &'a [AuditRow], tool: &str) -> Vec<&'a AuditRow> {
    rows.iter().filter(|r| r.tool == tool).collect()
}

fn done(w: &World) {
    let _ = std::fs::remove_dir_all(&w.root);
}

// ---- the tests ----

/// One greeting, then an answer.
fn greet_then_answer(body: &Value) -> Reply {
    match tool_results(body) {
        0 => Reply::Call("greet", json!({"who": "Alexia"})),
        _ => Reply::Say(format!("The greeting was: {}", last_tool_text(body))),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task_calls_a_plugin_tool() {
    let mut w = world("task", ("hello", "greet"), true, greet_then_answer).await;
    w.bot.say("search for a greeting");
    w.hears("The greeting was:").await;
    // The model saw the plugin's own words, fenced as data.
    let steps = w.p.steps();
    assert_eq!(steps.len(), 2, "{steps:?}");
    assert!(
        last_tool_text(&steps[1]).contains("Hello, Alexia."),
        "{steps:?}"
    );
    let rows = w.stopped_audit().await;
    let greets = rows_of(&rows, "hello__greet");
    assert_eq!(greets.len(), 1, "{rows:?}");
    let row = greets[0];
    assert_eq!(row.decision, "run", "{row:?}");
    assert_eq!(row.gate, "run");
    assert_eq!(row.ok, Some(true));
    assert_eq!(row.plugin.as_deref(), Some("hello"));
    assert!(row.args.contains("Alexia"), "{row:?}");
    done(&w);
}

/// `notes__set` once, then an answer that says whether it was set.
fn set_then_report(body: &Value) -> Reply {
    match tool_results(body) {
        0 => Reply::Call("set", json!({"key": "colour", "value": "blue"})),
        _ if last_tool_text(body).contains("did not approve") => {
            Reply::Say("You said no, so I did not set the colour.".into())
        }
        _ => Reply::Say("The colour is set.".into()),
    }
}

/// The question the risky call raised: two buttons, naming what it wants to do.
fn assert_asks_about_set(q: &Question) {
    let labels: Vec<&str> = q.buttons.iter().map(|(l, _)| l.as_str()).collect();
    assert_eq!(labels, ["Approve", "Deny"], "{q:?}");
    assert!(q.text.contains("Allow it?"), "{q:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn risky_call_asks_and_runs_on_approve() {
    let mut w = world("approve", ("notes", "undoable"), false, set_then_report).await;
    w.bot.say("remember that my colour is blue");
    let q = w.question(1).await;
    assert_asks_about_set(&q);
    // Nothing ran while the owner had not answered.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(w.p.steps().len(), 1, "the run went on without an answer");
    w.bot.press(&q, "Approve");
    w.hears("The colour is set.").await;
    let rows = w.stopped_audit().await;
    let sets = rows_of(&rows, "notes__set");
    assert_eq!(sets.len(), 1, "{rows:?}");
    assert_eq!(
        (sets[0].gate.as_str(), sets[0].decision.as_str(), sets[0].ok),
        ("ask", "approved", Some(true)),
        "{:?}",
        sets[0]
    );
    assert!(sets[0]
        .result
        .as_deref()
        .unwrap_or("")
        .contains("set colour"));
    done(&w);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn risky_call_asks_and_does_not_run_on_deny() {
    let mut w = world("deny", ("notes", "undoable"), false, set_then_report).await;
    w.bot.say("remember that my colour is blue");
    let q = w.question(1).await;
    assert_asks_about_set(&q);
    w.bot.press(&q, "Deny");
    w.hears("did not set the colour").await;
    // The model was told it did not run; the tool itself was never called.
    let steps = w.p.steps();
    assert!(
        last_tool_text(steps.last().unwrap()).contains("did not approve it, so it did not run"),
        "{steps:?}"
    );
    let rows = w.stopped_audit().await;
    let sets = rows_of(&rows, "notes__set");
    assert_eq!(sets.len(), 1, "{rows:?}");
    assert_eq!(
        (sets[0].gate.as_str(), sets[0].decision.as_str()),
        ("ask", "denied"),
        "{:?}",
        sets[0]
    );
    assert!(
        !sets[0]
            .result
            .as_deref()
            .unwrap_or("")
            .contains("set colour"),
        "{:?}",
        sets[0]
    );
    assert!(sets[0].undo.is_none());
    done(&w);
}

const STEER: &str = "and tell me it was for Bob";

/// A greeting, then an answer; a request whose newest user turn is the steer gets its own.
fn steered_script(body: &Value) -> Reply {
    if last_user_text(body) == STEER {
        return Reply::Say("Changed course: it was for Bob.".into());
    }
    match tool_results(body) {
        0 => Reply::Call("greet", json!({"who": "Alexia"})),
        _ => Reply::Say("The original task is finished.".into()),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn steer_mid_task() {
    let mut w = world("steer", ("hello", "greet"), true, steered_script).await;
    // The first request is held, so the owner's second message arrives while step 1 is thinking.
    w.p.hold.store(0, Ordering::SeqCst);
    w.bot.say("search for a greeting");
    w.steps(1).await;
    w.bot.say(STEER);
    // Time for the gateway to hand the message to the run (it reacts at once, then steers).
    tokio::time::sleep(Duration::from_millis(1500)).await;
    w.p.hold.store(-1, Ordering::SeqCst);
    w.hears("Changed course: it was for Bob.").await;
    let steps = w.p.steps();
    assert_eq!(steps.len(), 2, "one run, two steps: {steps:?}");
    assert_eq!(last_user_text(&steps[0]), "search for a greeting");
    assert_eq!(last_user_text(&steps[1]), STEER, "step 2 did not see it");
    // Step 2 saw step 1's result as well: the run was carried on, not started over.
    assert_eq!(tool_results(&steps[1]), 1);
    assert!(
        w.bot
            .sent()
            .iter()
            .all(|m| !m.contains("The original task is finished.")),
        "the answer to the old plan was sent: {:?}",
        w.bot.sent()
    );
    let rows = w.stopped_audit().await;
    assert_eq!(rows_of(&rows, "hello__greet").len(), 1, "{rows:?}");
    done(&w);
}

/// Three greetings, one step each, then an answer.
fn three_steps(body: &Value) -> Reply {
    match tool_results(body) {
        0 => Reply::Call("greet", json!({"who": "one"})),
        1 => Reply::Call("greet", json!({"who": "two"})),
        2 => Reply::Call("greet", json!({"who": "three"})),
        _ => Reply::Say("All three greetings are done.".into()),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_after_kill() {
    let mut w = world("resume", ("hello", "greet"), true, three_steps).await;
    // Step 2's request is held: the hub is killed with step 1 done and the run still live.
    w.p.hold.store(1, Ordering::SeqCst);
    w.bot.say("search for three greetings");
    w.steps(2).await;
    w.hub.kill();
    assert!(
        w.bot
            .sent()
            .iter()
            .all(|m| !m.contains("All three greetings")),
        "{:?}",
        w.bot.sent()
    );
    w.p.hold.store(-1, Ordering::SeqCst);
    w.restart();
    w.hub.up().await;
    w.hears("Picking up where I stopped").await;
    w.hears("All three greetings are done.").await;
    let rows = w.stopped_audit().await;
    let greets = rows_of(&rows, "hello__greet");
    let who: Vec<&str> = ["one", "two", "three"]
        .into_iter()
        .filter(|w| greets.iter().any(|r| r.args.contains(w)))
        .collect();
    assert_eq!(who, ["one", "two", "three"], "{rows:?}");
    assert_eq!(greets.len(), 3, "a step was run twice: {rows:?}");
    // One run before the kill and after it.
    assert!(greets.iter().all(|r| r.run == greets[0].run), "{rows:?}");
    done(&w);
}

/// `schedule.add` for a moment `secs` from now, then an answer; the job's own prompt gets its own.
fn schedule_script(body: &Value) -> Reply {
    if last_user_text(body).contains("tick from the schedule") {
        return Reply::Say("Tick from the schedule.".into());
    }
    match tool_results(body) {
        0 => {
            let at = chrono::Local::now() + chrono::Duration::seconds(3);
            Reply::Call(
                "schedule.add",
                json!({
                    "kind": "at",
                    "at": at.format("%Y-%m-%dT%H:%M:%S").to_string(),
                    "prompt": "Say a tick from the schedule.",
                }),
            )
        }
        _ => Reply::Say("It is scheduled.".into()),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scheduled_job_fires() {
    let mut w = world("schedule", ("hello", "greet"), true, schedule_script).await;
    w.bot.say("schedule a tick in a few seconds");
    w.hears("It is scheduled.").await;
    // The job fires by itself: nobody said anything since.
    w.hears("Tick from the schedule.").await;
    let rows = w.stopped_audit().await;
    let adds = rows_of(&rows, "schedule.add");
    assert_eq!(adds.len(), 1, "{rows:?}");
    assert_eq!(adds[0].ok, Some(true), "{:?}", adds[0]);
    assert!(adds[0].undo.is_some(), "schedule.add declares its undo");
    done(&w);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_reverses() {
    let mut w = world("undo", ("notes", "undoable"), false, set_then_report).await;
    w.bot.say("remember that my colour is blue");
    let q = w.question(1).await;
    w.bot.press(&q, "Approve");
    w.hears("The colour is set.").await;

    // The fixture's `set` names its inverse without a summary and core drops that, so the
    // audit row has no undo. Say what it would have said, in the form the hub stores it
    // (the inverse's tool is namespaced by core), with the hub stopped so the file is ours.
    let rows = w.stopped_audit().await;
    let set = rows_of(&rows, "notes__set")[0].clone();
    assert!(
        set.undo.is_none(),
        "the fixture now declares a summary: {set:?}"
    );
    let undo = json!({"tool": "notes__unset", "arguments": {"key": "colour"}, "summary": "the colour I set"});
    let conn = rusqlite::Connection::open(db(&w.root)).unwrap();
    let n = conn
        .execute(
            "UPDATE audit SET undo = ? WHERE id = ?",
            rusqlite::params![undo.to_string(), set.id],
        )
        .unwrap();
    assert_eq!(n, 1);
    drop(conn);

    w.restart();
    w.hub.up().await;
    w.bot.say("/undo");
    // The inverse goes through the same gate: `unset` is not read-only, so it asks too.
    let q = w.question(2).await;
    assert!(q.text.contains("Allow it?"), "{q:?}");
    assert!(q.text.contains("unset") || q.text.contains("undo"), "{q:?}");
    w.bot.press(&q, "Approve");
    w.hears("Undone: the colour I set.").await;
    let rows = w.stopped_audit().await;
    let unsets = rows_of(&rows, "notes__unset");
    assert_eq!(unsets.len(), 1, "{rows:?}");
    // The undo's own row: it ran through the ask, after approval, and worked.
    assert_eq!(
        (
            unsets[0].gate.as_str(),
            unsets[0].decision.as_str(),
            unsets[0].ok
        ),
        ("ask", "approved", Some(true)),
        "{:?}",
        unsets[0]
    );
    assert!(unsets[0]
        .result
        .as_deref()
        .unwrap_or("")
        .contains("unset colour"));
    // And it is marked undone, so a second /undo has nothing to do.
    let marked = Store::open(&db(&w.root))
        .unwrap()
        .last_undoable(set.session.unwrap())
        .unwrap();
    assert!(marked.is_none(), "{marked:?}");
    done(&w);
}
