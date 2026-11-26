// SPDX-License-Identifier: AGPL-3.0-only
//! P3-31: the proactivity verbs run as the owner runs them, against a scratch data folder, and
//! one `alexia-hub run` that shows the engine wired to a plugin and to the owner's chat.
//! Nothing real is called.

mod common;

use std::path::PathBuf;
use std::process::{Output, Stdio};

use alexia_store::{now_ms, Layout, NewNotice, Store};
use serde_json::{json, Value};

use common::{command, scratch, until, Bot, Hub, TOKEN};

/// A scratch root per test, removed when the test ends.
struct Env(PathBuf);

impl Env {
    fn new(name: &str) -> Env {
        let env = Env(scratch(&format!("p3-{name}")));
        std::fs::create_dir_all(env.0.join("data")).unwrap();
        env
    }

    fn layout(&self) -> Layout {
        Layout::new(self.0.join("data"))
    }

    fn store(&self) -> Store {
        Store::open(&self.layout().db()).unwrap()
    }

    fn kv(&self, key: &str) -> Option<Value> {
        self.store().kv_get("_core", key).unwrap()
    }

    /// `alexia-hub <args>` against this data folder; waits for it.
    fn cli(&self, args: &[&str]) -> Output {
        command(&self.0)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .unwrap()
    }

    /// The same, expecting success: its stdout.
    fn ok(&self, args: &[&str]) -> String {
        let o = self.cli(args);
        assert!(o.status.success(), "{args:?}: {}", err(&o));
        out(&o)
    }

    /// Expecting a refusal (exit 1): its sentence.
    fn refused(&self, args: &[&str]) -> String {
        let o = self.cli(args);
        assert_eq!(o.status.code(), Some(1), "{args:?}: {}{}", out(&o), err(&o));
        err(&o)
    }

    /// A plugin folder running `SERVER` with `tools`.
    fn plugin(&self, id: &str, provides: &[&str], tools: Value) -> PathBuf {
        let dir = self.0.join("plugins").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = json!({
            "manifest_version": 1,
            "id": id,
            "name": format!("Plugin {id}"),
            "summary": "A plugin that exists for tests.",
            "version": "0.1.0",
            "license": "AGPL-3.0-only",
            "entry": { "run": "node", "args": ["server.cjs"] },
            "alexia_protocol": 2,
            "mcp_protocol": "2025-11-25",
            "provides": provides,
        });
        std::fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
        std::fs::write(dir.join("server.cjs"), SERVER).unwrap();
        std::fs::write(dir.join("tools.json"), tools.to_string()).unwrap();
        dir
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A tiny MCP server: lists the tools in `tools.json`, answers each call with the tool's
/// `answer`, and appends what it was called with to `calls.log` in its folder.
const SERVER: &str = r#"
const fs = require('fs')
const path = require('path')
const here = path.dirname(process.argv[1])
const tools = JSON.parse(fs.readFileSync(path.join(here, 'tools.json'), 'utf8'))
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const rl = require('readline').createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  let result = {}
  if (m.method === 'initialize') {
    result = { protocolVersion: '2025-11-25', serverInfo: { name: 'fake', version: '0' }, capabilities: { tools: {} } }
  } else if (m.method === 'tools/list') {
    result = { tools: tools.map(({ answer, ...t }) => ({ inputSchema: { type: 'object' }, ...t })) }
  } else if (m.method === 'tools/call') {
    fs.appendFileSync(path.join(here, 'calls.log'), JSON.stringify([m.params.name, m.params.arguments]) + '\n')
    result = tools.find((t) => t.name === m.params.name).answer || { content: [] }
  }
  send({ jsonrpc: '2.0', id: m.id, result })
})
rl.on('close', () => process.exit(0))
"#;

fn out(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn err(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

fn notice(s: &Store, key: &str, text: &str, urgency: &str, at: i64) -> i64 {
    let n = NewNotice {
        key,
        source: "notice.items",
        text,
        why: "Because.",
        urgency,
        due_at: None,
        not_before: None,
    };
    s.notice_upsert(&n, at).unwrap().0
}

#[test]
fn notices_lists_newest_first() {
    let e = Env::new("notices");
    assert_eq!(e.ok(&["notices"]).trim(), "No notices recorded.");

    const DAY: i64 = 24 * 60 * 60 * 1000;
    let now = now_ms();
    let (old, middle, new) = {
        let s = e.store();
        (
            notice(&s, "a:1", "ten days old", "low", now - 10 * DAY),
            notice(&s, "a:2", "yesterday,\nin two lines", "high", now - DAY),
            notice(&s, "a:3", "just now", "normal", now),
        )
    };
    let lines: Vec<String> = e.ok(&["notices"]).lines().map(str::to_owned).collect();
    assert_eq!(lines.len(), 3, "{lines:?}");
    // id, when, state, urgency, source, text.
    let first: Vec<&str> = lines[0].split('\t').collect();
    assert_eq!(first.len(), 6, "{lines:?}");
    assert_eq!(first[0], new.to_string());
    assert_eq!(first[2..], ["new", "normal", "notice.items", "just now"]);
    assert!(lines[1].starts_with(&format!("{middle}\t")), "{lines:?}");
    assert!(
        lines[1].ends_with("yesterday, in two lines"),
        "one line each: {lines:?}"
    );
    assert!(lines[2].starts_with(&format!("{old}\t")), "{lines:?}");

    let last = e.ok(&["notices", "--last", "1"]);
    assert_eq!(last.lines().count(), 1, "{last}");
    assert!(last.contains("just now"), "{last}");

    let week = e.ok(&["notices", "--week"]);
    assert_eq!(week.lines().count(), 2, "{week}");
    assert!(!week.contains("ten days old"), "{week}");

    e.refused(&["notices", "--last", "0"]);
    e.refused(&["notices", "--month"]);
}

#[test]
fn quiet_set_and_show() {
    let e = Env::new("quiet");
    assert_eq!(e.ok(&["quiet"]).trim(), "No quiet hours are set.");
    assert_eq!(
        e.ok(&["quiet", "23:00", "07:00"]).trim(),
        "Quiet hours: 23:00 to 07:00. Only urgent things get through."
    );
    assert_eq!(
        e.kv("proactive").unwrap()["quiet"],
        json!({"from": [23, 0], "to": [7, 0], "lets_through": "urgent"})
    );
    // What the verb writes is what the scheduler reads.
    let read = alexia_scheduler::Proactive::load(&e.store());
    assert_eq!(read.quiet, alexia_scheduler::quiet::QUIET_PROPOSED);

    e.ok(&["quiet", "22:30", "06:15", "high"]);
    assert_eq!(
        e.ok(&["quiet"]).trim(),
        "Quiet hours: 22:30 to 06:15. Only high and urgent things get through."
    );
    assert!(e.refused(&["quiet", "24:00", "07:00"]).contains("HH:MM"));
    assert!(e
        .refused(&["quiet", "23:00", "07:00", "loud"])
        .contains("urgency"));
    assert_eq!(
        alexia_scheduler::Proactive::load(&e.store()).quiet.from,
        (22, 30)
    );
}

#[test]
fn quiet_pause_sets_paused_until() {
    let e = Env::new("pause");
    e.ok(&["quiet", "23:00", "07:00"]);
    let before = now_ms();
    let said = e.ok(&["quiet", "pause", "90"]);
    assert!(said.contains("Paused until "), "{said}");
    let read = alexia_scheduler::Proactive::load(&e.store());
    let until = read.paused_until.unwrap();
    let pause = 90 * 60 * 1000;
    assert!(
        (before + pause..=now_ms() + pause).contains(&until),
        "{until}"
    );
    assert_eq!(read.quiet, alexia_scheduler::quiet::QUIET_PROPOSED);

    assert_eq!(e.ok(&["quiet", "resume"]).trim(), "The pause is over.");
    assert_eq!(
        alexia_scheduler::Proactive::load(&e.store()).paused_until,
        None
    );
    assert_eq!(e.ok(&["quiet", "resume"]).trim(), "There was no pause.");
    e.refused(&["quiet", "pause", "soon"]);
    e.refused(&["quiet", "pause", "0"]);
}

#[test]
fn mute_list_and_remove() {
    let e = Env::new("mute");
    assert_eq!(e.ok(&["mute", "list"]).trim(), "Nothing is muted.");
    let id = e.store().mute_add("watch", None, None, now_ms()).unwrap();
    assert_eq!(e.ok(&["mute", "list"]).trim(), format!("#{id} watch"));
    assert_eq!(
        e.ok(&["mute", "remove", &id.to_string()]).trim(),
        "Removed."
    );
    assert!(e.store().mutes(now_ms()).unwrap().is_empty());
    e.refused(&["mute", "remove", &id.to_string()]);
    e.refused(&["mute", "remove", "watch"]);
}

/// One tool that stays on this computer, and one that reaches outside it.
fn two_tools() -> Value {
    json!([
        {"name": "jot", "annotations": {"readOnlyHint": false, "openWorldHint": false}},
        {"name": "post", "annotations": {"readOnlyHint": false, "openWorldHint": true}},
    ])
}

#[test]
fn silent_allow_and_list() {
    let e = Env::new("silent");
    e.plugin("demo", &[], two_tools());
    assert!(e.ok(&["silent", "list"]).starts_with("The list is empty"));
    assert_eq!(e.kv("silent"), None, "no list is ever written by itself");

    let said = e.ok(&["silent", "allow", "demo__jot"]);
    assert!(said.starts_with("Added demo__jot"), "{said}");
    assert_eq!(e.kv("silent"), Some(json!(["demo__jot"])));
    assert_eq!(e.ok(&["silent", "list"]).trim(), "demo__jot");
    // The permission rules read the same list.
    let scope = alexia_core::permissions::scope(&e.store(), &e.layout().root);
    assert_eq!(scope.silent, ["demo__jot"]);

    assert!(e
        .refused(&["silent", "allow", "demo__nothing"])
        .contains("No plugin has a tool called demo__nothing"));
    e.ok(&["silent", "remove", "demo__jot"]);
    assert_eq!(e.kv("silent"), Some(json!([])));
    assert!(e
        .refused(&["silent", "remove", "demo__jot"])
        .contains("is not on the list"));
}

#[test]
fn silent_refuses_open_world() {
    let e = Env::new("open-world");
    e.plugin("demo", &[], two_tools());
    let why = e.refused(&["silent", "allow", "demo__post"]);
    assert!(
        why.contains("That one reaches outside your computer, so she always asks."),
        "{why}"
    );
    assert_eq!(e.kv("silent"), None);
}

#[cfg(windows)]
#[test]
fn brief_now_without_hub_refuses() {
    let e = Env::new("brief-off");
    for args in [&["brief", "--now"][..], &["brief", "--now", "weekly"][..]] {
        let why = e.refused(args);
        assert!(why.contains("The hub is not running."), "{why}");
    }
    assert_eq!(e.kv("brief.ask"), None);
    assert!(e
        .refused(&["brief", "--now", "yearly"])
        .contains("morning, evening or weekly"));
}

#[cfg(windows)]
#[test]
fn brief_now_with_hub_asks() {
    use std::os::windows::fs::OpenOptionsExt;
    let e = Env::new("brief-on");
    // What a running hub holds.
    let _lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(e.0.join("data").join("hub.lock"))
        .unwrap();
    let before = now_ms();
    e.ok(&["brief", "--now", "evening"]);
    let asked = e.kv("brief.ask").unwrap();
    assert_eq!(asked["kind"], json!("evening"));
    assert!(asked["at"].as_i64().unwrap() >= before, "{asked}");
}

/// The real hub: the notice loop reads a plugin through the host, the owner's chat runs the
/// commands, and a "+ " message lands in the plugin that keeps tasks, without a model.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn run_collects_notices_and_takes_notes() {
    let e = Env::new("run");
    let item = json!({"key": "demo:1", "text": "The form is due", "why": "You said so."});
    let dir = e.plugin(
        "demo",
        &["notice.items", "tasks.add"],
        json!([
            {"name": "offer", "_meta": {"alexia/provides": ["notice.items"]},
             "answer": {"content": [], "structuredContent": {"items": [item]}}},
            {"name": "keep", "_meta": {"alexia/provides": ["tasks.add"]},
             "answer": {"content": [{"type": "text", "text": "kept"}]}},
        ]),
    );
    let (bot, base) = Bot::start().await;
    let mut c = command(&e.0);
    c.env("ALEXIA_TELEGRAM_API", &base).env(
        alexia_store::secrets::env_name("_core", "telegram_bot_token"),
        TOKEN,
    );
    let mut hub = Hub::run(c);
    hub.up().await;

    // The first intake runs at start.
    assert!(
        until(120, || e.ok(&["notices"]).contains("The form is due")).await,
        "the plugin's item never became a notice\n{}",
        hub.log()
    );

    hub.pair(&bot).await;
    let answered = |needle: &'static str| {
        let bot = bot.clone();
        until(120, move || bot.sent().iter().any(|m| m.contains(needle)))
    };
    bot.say("+ buy milk");
    assert!(answered("Noted.").await, "{:?}\n{}", bot.sent(), hub.log());
    let calls = std::fs::read_to_string(dir.join("calls.log")).unwrap();
    assert!(calls.contains(r#"["keep",{"text":"buy milk"}]"#), "{calls}");

    bot.say("/quiet 23:00 07:00");
    assert!(
        answered("Quiet hours: 23:00 to 07:00.").await,
        "{:?}\n{}",
        bot.sent(),
        hub.log()
    );
    bot.say("/notices");
    assert!(
        answered("· The form is due").await,
        "{:?}\n{}",
        bot.sent(),
        hub.log()
    );
    // `/brief` reaches the scheduler's tool: the brief and the command's own answer.
    bot.say("/brief weekly");
    assert!(
        answered("Your week.").await && answered("Sent.").await,
        "{:?}\n{}",
        bot.sent(),
        hub.log()
    );
    assert_eq!(hub.stop().await, Some(0), "{}", hub.log());
}
