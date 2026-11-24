// SPDX-License-Identifier: AGPL-3.0-only
//! P2D-12: the hub does on this PC, through the window API only, what v2 did on it: sees the
//! windows, opens an app (Character Map), types into it and reads it back, takes a screenshot, shows a plan's
//! progress, reads a document in a chosen folder, asks before a risky step and obeys the
//! answer, and shows a produced file in Explorer.
//!
//! Run from the owner's desktop session (not over SSH, not as SYSTEM):
//! `cargo test -p alexia-hub --features pc-actions --test pc_actions -- --nocapture`.
//! Needs Node and `pnpm install` plus a built `packages/sdk` in this checkout: the plugins are
//! the repo's own, copied into a scratch folder with their `node_modules` junctioned.
//!
//! Nothing real is touched: the hub's data folder is scratch, secrets are in memory, the model
//! is a fake that scripts the tool calls. The plugins are found by the capabilities their
//! manifests provide and the tools by `_meta["alexia/provides"]`, so no plugin is named here.
//! The computer plugin's other tools (`windows`, `open_app`, ...) carry no capability and are
//! named by tool name inside whichever plugin provides `computer.control`.
//!
//! It opens Character Map, clicks and types in it, and moves the mouse once: do not use the
//! mouse or keyboard while it runs. It only ever closes the Character Map it started.
#![cfg(windows)]

mod common;

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alexia_mcp::{discover, HostConfig, McpHost, NoUpcalls, PluginId, Timings};
use alexia_store::{Layout, Store};
use common::{answer, call, command, listen, lock, read_req, scratch, window, Hub, Window};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

const CONTROL: &str = "computer.control";
const SCREENSHOT: &str = "computer.screenshot";
const EXTRACT: &str = "document.extract";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The app turn 1 opens: Character Map, a classic Windows app with no session restore, so the
/// test can only ever type into the window it opened. (Windows 11 Notepad reopens the owner's
/// previous tabs, unsaved ones included, and the first keystroke would land in one of them.)
const APP: &str = "charmap";
const APP_IMAGE: &str = "charmap.exe";
/// Its typing box: the name `elements` lists it by, and its UI Automation id, which `read`
/// matches on (its label carries the same name and comes first in the tree).
const BOX_NAME: &str = "Characters to copy";
const BOX_ID: &str = "104";
/// What the scripted model says when it refuses to touch a window that is not in front.
const STOPPED: &str = "Stopped before touching anything:";
/// What turn 1 types into the box and reads back.
const TYPED: &str = "alexia p2d";
/// What the `.docx` fixture says, and turn 2 must find.
const DOC_PHRASE: &str = "Quokka ledger for P2D twelve";

/// The words the turns start with: the provider tells the turns apart by them, and each holds
/// a word that sends it to the task lane ("open", "file", "run").
const TURN_DRIVE: &str = "Open Character Map, type in it, read it back and take a screenshot.";
const TURN_READ: &str = "Read the file in my folder.";
const TURN_RISKY: &str = "Run one pointer move.";

// ---- the plugins, by capability ----

fn repo_plugins() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../plugins")
        .canonicalize()
        .expect("the repo's plugins folder")
}

/// (folder, manifest) of every repo plugin whose manifest provides one of `caps`.
fn providers_of(caps: &[&str]) -> Vec<(PathBuf, Value)> {
    let mut found = Vec::new();
    for e in std::fs::read_dir(repo_plugins()).unwrap().flatten() {
        let Ok(text) = std::fs::read_to_string(e.path().join("plugin.json")) else {
            continue;
        };
        let Ok(m) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let provides = m["provides"].as_array().cloned().unwrap_or_default();
        if provides
            .iter()
            .any(|p| caps.contains(&p.as_str().unwrap_or("")))
        {
            found.push((e.path(), m));
        }
    }
    found
}

fn provides(m: &Value, cap: &str) -> bool {
    m["provides"]
        .as_array()
        .is_some_and(|a| a.iter().any(|p| p == cap))
}

/// `link` → `target` as a directory junction (what P2-40 does for `node_modules`).
fn junction(link: &Path, target: &Path) {
    let ok = std::process::Command::new("cmd")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(link)
        .arg(target)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .unwrap()
        .status
        .success();
    assert!(
        ok,
        "could not junction {} to {}",
        link.display(),
        target.display()
    );
}

fn copy_without_node_modules(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().map(Result::unwrap) {
        if e.file_name() == "node_modules" {
            continue;
        }
        let dest = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_without_node_modules(&e.path(), &dest);
        } else {
            std::fs::copy(e.path(), dest).unwrap();
        }
    }
}

/// A scratch copy of `src` under `plugins`, its `node_modules` a junction to the repo's.
fn copy_plugin(src: &Path, plugins: &Path) {
    let nm = src.join("node_modules");
    assert!(
        nm.is_dir(),
        "{} has no node_modules: run `pnpm install` and build packages/sdk (`npx tsc -b` in packages/sdk) in this checkout first",
        src.display()
    );
    let copy = plugins.join(src.file_name().unwrap());
    copy_without_node_modules(src, &copy);
    junction(&copy.join("node_modules"), &nm);
}

/// Deletes `p` without ever following a link: a junction is removed itself, never emptied.
fn remove_tree(p: &Path) {
    let Ok(meta) = std::fs::symlink_metadata(p) else {
        return;
    };
    if meta.file_type().is_symlink() || is_junction(p) {
        let _ = std::fs::remove_dir(p).or_else(|_| std::fs::remove_file(p));
    } else if meta.is_dir() {
        for e in std::fs::read_dir(p).into_iter().flatten().flatten() {
            remove_tree(&e.path());
        }
        let _ = std::fs::remove_dir(p);
    } else {
        let _ = std::fs::remove_file(p);
    }
}

fn is_junction(p: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const REPARSE_POINT: u32 = 0x400;
    std::fs::symlink_metadata(p).is_ok_and(|m| m.file_attributes() & REPARSE_POINT != 0)
}

/// The tool names the turns use, all found at run time.
#[derive(Clone, Debug)]
struct Tools {
    /// The plugin that provides `computer.control`, and its toggle that turns input on.
    computer: String,
    input_toggle: String,
    control: String,
    screenshot: String,
    extract: String,
    /// The plugins the test trusts.
    plugins: Vec<String>,
}

impl Tools {
    /// The model-facing name of one of the computer plugin's own tools.
    fn computer(&self, tool: &str) -> String {
        format!("{}__{tool}", self.computer)
    }
}

/// Starts the scratch plugins in a throwaway host (its own in-memory store, the input toggle
/// on there only) and reads the tools that provide each capability off its tool list.
async fn probe(plugins: &Path, root: &Path, toggle_of: &[(String, String)]) -> Tools {
    std::env::set_var("ALEXIA_SECRETS_IN_MEMORY", "1");
    let ids: Vec<PluginId> = discover(plugins)
        .into_iter()
        .map(|r| {
            PluginId(
                r.unwrap_or_else(|(p, e)| panic!("{}: {e:?}", p.display()))
                    .manifest
                    .id,
            )
        })
        .collect();
    let store = Arc::new(Store::open_in_memory().unwrap());
    for (plugin, key) in toggle_of {
        store.set_setting(plugin, key, &json!(true)).unwrap();
    }
    let cfg = HostConfig {
        layout: Layout::new(root.join("probe")),
        plugin_dirs: vec![plugins.to_path_buf()],
        node: PathBuf::from("node"),
        timings: Timings {
            start_ms: 60_000,
            call_ms: 60_000,
            capability_ms: 60_000,
            ..Timings::default()
        },
    };
    let host = McpHost::new(cfg, store, Arc::new(NoUpcalls), Arc::new(|_| {}));
    host.start(&ids).await.unwrap();
    // A plugin binds its capabilities just after it starts: ask until all three are there.
    let end = Instant::now() + Duration::from_secs(60);
    let tools = loop {
        let tools = host.tools().await;
        let has = |cap: &str| tools.iter().any(|t| t.provides.iter().any(|p| p == cap));
        if has(CONTROL) && has(SCREENSHOT) && has(EXTRACT) {
            break tools;
        }
        if Instant::now() > end {
            let seen: Vec<String> = tools
                .iter()
                .map(|t| format!("{}__{} {:?}", t.plugin.0, t.tool.name, t.provides))
                .collect();
            let problems = host.problems();
            host.shutdown().await;
            panic!("the plugins never provided all three capabilities: {seen:#?}\n{problems:?}");
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    host.shutdown().await;
    let by = |cap: &str| {
        tools
            .iter()
            .find(|t| t.provides.iter().any(|p| p == cap))
            .map(|t| (t.plugin.0.clone(), t.tool.name.clone()))
            .unwrap()
    };
    let (computer, control) = by(CONTROL);
    let (shot_plugin, shot) = by(SCREENSHOT);
    let (doc_plugin, extract) = by(EXTRACT);
    let names: Vec<&str> = tools
        .iter()
        .filter(|t| t.plugin.0 == computer)
        .map(|t| t.tool.name.as_str())
        .collect();
    for want in [
        "windows", "open_app", "focus", "elements", "click", "read", "run_task",
    ] {
        assert!(
            names.contains(&want),
            "the plugin that provides {CONTROL} has no {want} tool: {names:?}"
        );
    }
    let input_toggle = toggle_of
        .iter()
        .find(|(p, _)| *p == computer)
        .map(|(_, k)| k.clone())
        .expect("the computer plugin's input toggle");
    let mut plugins: Vec<String> = ids.into_iter().map(|i| i.0).collect();
    plugins.sort();
    Tools {
        control: format!("{computer}__{control}"),
        screenshot: format!("{shot_plugin}__{shot}"),
        extract: format!("{doc_plugin}__{extract}"),
        computer,
        input_toggle,
        plugins,
    }
}

/// The toggle in a manifest that is off until the owner turns it on: the one its input tools
/// check. Exactly one such toggle is expected in a plugin that provides `computer.control`.
fn input_toggle(m: &Value) -> String {
    let offs: Vec<String> = m["settings"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| s["type"] == "toggle" && s["default"] == json!(false))
        .filter_map(|s| s["key"].as_str().map(str::to_owned))
        .collect();
    assert_eq!(
        offs.len(),
        1,
        "expected one off-by-default toggle in {}: {offs:?}",
        m["id"]
    );
    offs[0].clone()
}

// ---- the scripted model ----

/// What the model does on one request that offers tools.
enum Reply {
    Say(String),
    Call(String, Value),
}

/// The model: the turn's user text and what it has done so far → what it does next.
type Script = Box<dyn Fn(&str, &[(String, String)]) -> Reply + Send + Sync>;

struct Provider {
    base: String,
    chats: Mutex<Vec<Value>>,
    log: Mutex<TurnLog>,
    script: Script,
}

/// The text of the last user message in a chat request.
fn last_user(body: &Value) -> String {
    let msgs = body["messages"].as_array().cloned().unwrap_or_default();
    match msgs
        .iter()
        .rev()
        .find(|m| m["role"] == "user")
        .map(|m| m["content"].clone())
    {
        Some(Value::String(s)) => s,
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join(
                "
",
            ),
        _ => String::new(),
    }
}

/// The result the request carries for the call `id`, if it carries it.
fn result_of(body: &Value, id: &str) -> Option<String> {
    body["messages"]
        .as_array()?
        .iter()
        .find(|m| m["role"] == "tool" && m["tool_call_id"] == id)
        .map(|m| match &m["content"] {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
}

/// What the scripted model has done in the current turn. Kept here, not read back off the
/// request: the hub sends only the last few results verbatim and summarises older ones.
#[derive(Default)]
struct TurnLog {
    user: String,
    /// (tool wire name, result text), in order.
    done: Vec<(String, String)>,
    /// The call made last, waiting for its result: (call id, tool wire name).
    pending: Option<(String, String)>,
}

/// OpenAI's name rule, as core applies it (`openai.rs` `wire_name`).
fn wire(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

async fn provider(script: Script) -> Arc<Provider> {
    let (listener, base) = listen().await;
    let p = Arc::new(Provider {
        base: format!("{base}/v1"),
        chats: Mutex::default(),
        log: Mutex::default(),
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
        let offered: Vec<String> = body["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| t["function"]["name"].as_str().map(str::to_owned))
            .collect();
        lock(&p.chats).push(body.clone());
        let reply = if offered.is_empty() {
            Reply::Say("Noted.".into())
        } else {
            let mut log = lock(&p.log);
            let user = last_user(&body);
            if user != log.user {
                *log = TurnLog {
                    user: user.clone(),
                    ..TurnLog::default()
                };
            }
            if let Some((id, name)) = log.pending.take() {
                let text = result_of(&body, &id).unwrap_or_default();
                log.done.push((name, text));
            }
            (p.script)(&user, &log.done)
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
            Reply::Call(name, args) => {
                let name = wire(&name);
                let text = if offered.contains(&name) {
                    None
                } else {
                    Some(format!("The tool {name} was not offered: {offered:?}"))
                };
                match text {
                    Some(t) => format!(
                        "{}{}",
                        frame(json!({"content": t}), Value::Null),
                        frame(json!({}), json!("stop"))
                    ),
                    None => {
                        let id = format!("call-{}", lock(&p.chats).len());
                        lock(&p.log).pending = Some((id.clone(), name.clone()));
                        let call = json!([{
                            "index": 0,
                            "id": id,
                            "type": "function",
                            "function": {"name": name, "arguments": args.to_string()},
                        }]);
                        format!(
                            "{}{}",
                            frame(json!({"tool_calls": call}), Value::Null),
                            frame(json!({}), json!("tool_calls"))
                        )
                    }
                }
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

/// The first number after `process id ` in `text`.
fn pid_in(text: &str) -> Option<u32> {
    let (_, rest) = text.split_once("process id ")?;
    rest.split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()
}

/// The app's window pid from the `windows` tool's lines (`<pid>  <process>  <title>`).
fn app_in(text: &str) -> Option<u32> {
    text.lines().find_map(|l| {
        let mut parts = l.split_whitespace();
        let pid = parts.next()?.parse().ok()?;
        parts
            .next()
            .filter(|p| p.eq_ignore_ascii_case(APP))
            .map(|_| pid)
    })
}

/// The middle of the app's typing box, from the `elements` tool's lines
/// (`<name>  [<type>]  <x>,<y>`).
fn box_in(text: &str) -> Option<(i64, i64)> {
    text.lines().find_map(|l| {
        let low = l.to_lowercase();
        if !low.starts_with(&BOX_NAME.to_lowercase()) || !low.contains("edit]") {
            return None;
        }
        let at = l.split("]").nth(1)?.split_whitespace().next()?;
        let (x, y) = at.split_once(',')?;
        Some((x.parse().ok()?, y.parse().ok()?))
    })
}

/// The pid of the window in front, asked of Windows through PowerShell.
fn foreground_pid() -> Option<u32> {
    let script = "Add-Type -Namespace P2D -Name W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);'; $p = 0; [void][P2D.W]::GetWindowThreadProcessId([P2D.W]::GetForegroundWindow(), [ref]$p); $p";
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// The image name of process `pid`, for a failure message.
fn image_of(pid: u32) -> String {
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    out.ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .split(',')
                .next()
                .map(|s| s.trim().trim_matches('"').to_owned())
        })
        .filter(|s| !s.is_empty() && !s.starts_with("INFO"))
        .unwrap_or_else(|| "gone".into())
}

/// The whole script: which turn this is, by its words, and what comes next in it.
///
/// Nothing is clicked or typed unless the app this turn opened is the window in front: a
/// keystroke must never land in a window the test did not open. A skipped input is written
/// to `skipped`.
fn script(t: Tools, doc: PathBuf, skipped: Arc<Mutex<Option<String>>>) -> Script {
    Box::new(move |user, done| {
        let called = |name: &str| done.iter().filter(|(n, _)| *n == wire(name)).count();
        if user.contains(TURN_DRIVE) {
            let (windows, open, focus, elements, click) = (
                t.computer("windows"),
                t.computer("open_app"),
                t.computer("focus"),
                t.computer("elements"),
                t.computer("click"),
            );
            if called(&windows) == 0 {
                return Reply::Call(windows, json!({}));
            }
            if called(&open) == 0 {
                return Reply::Call(open, json!({"name": APP}));
            }
            let pid = done
                .iter()
                .filter(|(n, _)| *n == wire(&open))
                .find_map(|(_, text)| pid_in(text))
                .or_else(|| {
                    done.iter()
                        .skip_while(|(n, _)| *n != wire(&open))
                        .filter(|(n, _)| *n == wire(&windows))
                        .find_map(|(_, text)| app_in(text))
                });
            let Some(pid) = pid else {
                // Opened with no window yet: look again, a few times.
                if called(&windows) < 6 {
                    return Reply::Call(windows, json!({}));
                }
                return Reply::Say(format!("{APP} never showed a window."));
            };
            if called(&focus) == 0 {
                return Reply::Call(focus, json!({"pid": pid}));
            }
            if called(&elements) == 0 {
                return Reply::Call(elements, json!({"pid": pid}));
            }
            // Input only while the app is in front and before it is read back. When it is
            // not in front, the input is skipped (and said, for the test to report) and the
            // turn goes on with what needs no input.
            let read = t.computer("read");
            let in_front = || {
                let front = foreground_pid();
                if front != Some(pid) {
                    let said = format!(
                        "{APP} (pid {pid}) was not in front after focus; the window in front was {}",
                        front.map_or("unknown".into(), |f| format!("pid {f} ({})", image_of(f)))
                    );
                    println!("{STOPPED} {said}");
                    lock(&skipped).get_or_insert(said);
                    return false;
                }
                true
            };
            if called(&read) == 0 && lock(&skipped).is_none() {
                if called(&click) == 0 {
                    let at = done
                        .iter()
                        .filter(|(n, _)| *n == wire(&elements))
                        .find_map(|(_, text)| box_in(text));
                    let Some((x, y)) = at else {
                        return Reply::Say(format!("{APP} has no {BOX_NAME} box."));
                    };
                    if in_front() {
                        return Reply::Call(click, json!({"x": x, "y": y}));
                    }
                } else if called(&t.control) == 0 && in_front() {
                    return Reply::Call(
                        t.control.clone(),
                        json!({"action": "type", "text": TYPED}),
                    );
                }
            }
            if called(&read) == 0 {
                return Reply::Call(read, json!({"pid": pid, "match": BOX_ID}));
            }
            if called(&t.screenshot) == 0 {
                return Reply::Call(t.screenshot.clone(), json!({}));
            }
            // A plan run (`run_task`): its checklist is the pill's progress. Two looks, no
            // keystroke and no click.
            let task = t.computer("run_task");
            if called(&task) == 0 {
                return Reply::Call(
                    task,
                    json!({
                        "goal": "Look at Character Map twice",
                        "pid": pid,
                        "steps": [
                            {"do": "wait", "say": "Look"},
                            {"do": "wait", "say": "Look again"}
                        ]
                    }),
                );
            }
            return Reply::Say("Turn one is done.".into());
        }
        if user.contains(TURN_READ) {
            if called(&t.extract) == 0 {
                return Reply::Call(
                    t.extract.clone(),
                    json!({"file": doc.display().to_string()}),
                );
            }
            return Reply::Say("Turn two is done.".into());
        }
        if user.contains(TURN_RISKY) {
            if called(&t.control) == 0 {
                return Reply::Call(
                    t.control.clone(),
                    json!({"action": "move", "x": 240, "y": 240}),
                );
            }
            return Reply::Say("Turn three is done.".into());
        }
        Reply::Say("Noted.".into())
    })
}

// ---- the window's chat stream ----

/// One `POST /api/chat`: its frames as they come. Every `ask` frame is answered through
/// `POST /api/approve` with what `decide` says.
fn chat_turn(w: &Window, text: &str, mut decide: impl FnMut(&str) -> bool) -> Vec<Value> {
    use std::io::{Read, Write};
    let body = json!({ "text": text }).to_string();
    let end = Instant::now() + Duration::from_secs(60);
    let (mut sock, mut buf) = loop {
        let mut sock = std::net::TcpStream::connect(("127.0.0.1", w.port)).unwrap();
        // A plan with PowerShell steps can be slow on a loaded machine.
        sock.set_read_timeout(Some(Duration::from_secs(240)))
            .unwrap();
        let head = format!(
            "POST /api/chat HTTP/1.0\r\nHost: 127.0.0.1:{}\r\nx-alexia-token: {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
            w.port,
            w.token,
            body.len()
        );
        sock.write_all(head.as_bytes()).unwrap();
        let mut buf = Vec::new();
        let at = loop {
            if let Some(p) = buf.windows(4).position(|x| x == b"\r\n\r\n") {
                break p;
            }
            let mut tmp = [0u8; 4096];
            let n = sock.read(&mut tmp).unwrap_or(0);
            assert!(n > 0, "no answer to /api/chat");
            buf.extend_from_slice(&tmp[..n]);
        };
        let head = String::from_utf8_lossy(&buf[..at]).into_owned();
        // The turn before may still be letting go: 423 is "still answering".
        if head.contains(" 423 ") && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(250));
            continue;
        }
        assert!(head.contains(" 200 "), "/api/chat answered {head}");
        buf.drain(..at + 4);
        break (sock, buf);
    };
    let mut frames = Vec::new();
    loop {
        if let Some(p) = buf.windows(2).position(|x| x == b"\n\n") {
            let block = String::from_utf8_lossy(&buf[..p]).into_owned();
            buf.drain(..p + 2);
            let Some(line) = block.lines().find_map(|l| l.strip_prefix("data: ")) else {
                continue;
            };
            let Ok(frame) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            println!("  frame: {}", short(&frame));
            if let Some(q) = frame["ask"].as_str() {
                let allowed = decide(q);
                let (status, _, said) = call(
                    w,
                    "POST",
                    "/api/approve",
                    Some(&json!({ "allowed": allowed })),
                );
                let said: Value = serde_json::from_slice(&said).unwrap_or(Value::Null);
                assert_eq!(status, 200);
                assert_eq!(said["ok"], true, "the approve was not taken: {said}");
                println!("  approve {{allowed: {allowed}}} → {said}");
            }
            frames.push(frame);
            continue;
        }
        let mut tmp = [0u8; 8192];
        match sock.read(&mut tmp) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
        }
    }
    assert!(
        frames.iter().any(|f| f.get("done").is_some()),
        "the turn never finished: {frames:#?}"
    );
    frames
}

/// A frame for the log, with a long text cut.
fn short(v: &Value) -> String {
    let s = v.to_string();
    if s.chars().count() > 300 {
        format!("{}…", s.chars().take(300).collect::<String>())
    } else {
        s
    }
}

/// The finished `step` frames of the tool called `name`.
fn outcomes<'a>(frames: &'a [Value], name: &str) -> Vec<&'a Value> {
    frames
        .iter()
        .map(|f| &f["step"])
        .filter(|s| s["name"] == name && s.get("ok").is_some())
        .collect()
}

fn one_outcome<'a>(frames: &'a [Value], name: &str) -> &'a Value {
    let all = outcomes(frames, name);
    assert_eq!(all.len(), 1, "{name}: {all:#?}\nall frames: {frames:#?}");
    all[0]
}

// ---- Windows processes ----

/// (pid, window title) of each running `image`, through `tasklist` (no window flashes).
/// Every process with its window title (`tasklist /V`), as `(pid, title)`.
fn all_processes() -> Vec<(u32, String)> {
    let out = std::process::Command::new("tasklist")
        .args(["/FO", "CSV", "/V", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let cols: Vec<&str> = l.trim().trim_matches('"').split("\",\"").collect();
            if cols.len() < 9 {
                return None;
            }
            Some((cols[1].parse().ok()?, cols[cols.len() - 1].to_owned()))
        })
        .collect()
}

fn processes(image: &str) -> Vec<(u32, String)> {
    let out = std::process::Command::new("tasklist")
        .args([
            "/FI",
            &format!("IMAGENAME eq {image}"),
            "/FO",
            "CSV",
            "/V",
            "/NH",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let cols: Vec<&str> = l.trim().trim_matches('"').split("\",\"").collect();
            if cols.len() < 9 || !cols[0].eq_ignore_ascii_case(image) {
                return None;
            }
            Some((cols[1].parse().ok()?, cols[cols.len() - 1].to_owned()))
        })
        .collect()
}

fn taskkill(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

/// Closes the Character Map this test started (by its pid: one that was not running before
/// the test) and removes the scratch, also when the test fails. Nothing else is closed.
struct Cleanup {
    root: PathBuf,
    apps_before: Vec<u32>,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        for (pid, _) in processes(APP_IMAGE) {
            if !self.apps_before.contains(&pid) {
                taskkill(pid);
            }
        }
        // The hub has let go of its files by now; a plugin process may take a moment.
        for _ in 0..20 {
            remove_tree(&self.root);
            if !self.root.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}

// ---- a .docx, stored (no compression) ----

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for b in bytes {
        crc ^= u32::from(*b);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

/// A zip with `files` stored as they are.
fn zip(files: &[(&str, String)]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, text) in files {
        let (name, data) = (name.as_bytes(), text.as_bytes());
        let (crc, size) = (crc32(data), data.len() as u32);
        let offset = out.len() as u32;
        let common = |v: &mut Vec<u8>| {
            v.extend_from_slice(&20u16.to_le_bytes()); // version needed
            v.extend_from_slice(&0u16.to_le_bytes()); // flags
            v.extend_from_slice(&0u16.to_le_bytes()); // stored
            v.extend_from_slice(&0u32.to_le_bytes()); // time, date
            v.extend_from_slice(&crc.to_le_bytes());
            v.extend_from_slice(&size.to_le_bytes());
            v.extend_from_slice(&size.to_le_bytes());
            v.extend_from_slice(&(name.len() as u16).to_le_bytes());
            v.extend_from_slice(&0u16.to_le_bytes()); // extra
        };
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        common(&mut out);
        out.extend_from_slice(name);
        out.extend_from_slice(data);
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        common(&mut central);
        central.extend_from_slice(&[0; 6]); // comment length, disk, internal attrs
        central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name);
    }
    let at = out.len() as u32;
    let n = files.len() as u16;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&n.to_le_bytes());
    out.extend_from_slice(&n.to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&at.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn docx(text: &str) -> Vec<u8> {
    let types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;
    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;
    let doc = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>"#
    );
    zip(&[
        ("[Content_Types].xml", types.to_owned()),
        ("_rels/.rels", rels.to_owned()),
        ("word/document.xml", doc),
    ])
}

/// The window's answer to a POST, read as JSON; a non-200 fails the test.
fn post(w: &Window, path: &str, body: Value) -> Value {
    let (status, _, got) = call(w, "POST", path, Some(&body));
    let got: Value = serde_json::from_slice(&got).unwrap_or(Value::Null);
    assert_eq!(status, 200, "{path} {body} answered {status}: {got}");
    got
}

fn write_ui(root: &Path) -> PathBuf {
    let ui = root.join("ui");
    std::fs::create_dir_all(&ui).unwrap();
    std::fs::write(
        ui.join("index.html"),
        "<!doctype html><script type=\"module\" src=\"/main.js\" data-token=\"__TOKEN__\"></script>\n",
    )
    .unwrap();
    ui
}

// ---- the test ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pc_actions_through_the_window() {
    let before = processes(APP_IMAGE);
    assert!(
        before.is_empty(),
        "Character Map is already open ({before:?}). Close it first: this test types into the Character Map it opens and closes it, and must not touch yours."
    );
    let root = scratch("pc-actions");
    let _cleanup = Cleanup {
        root: root.clone(),
        apps_before: before.iter().map(|(p, _)| *p).collect(),
    };
    let (data, plugins) = (root.join("data"), root.join("plugins"));

    // The plugins, by what their manifests provide.
    let found = providers_of(&[CONTROL, SCREENSHOT, EXTRACT]);
    for cap in [CONTROL, SCREENSHOT, EXTRACT] {
        assert!(
            found.iter().any(|(_, m)| provides(m, cap)),
            "no plugin in {} provides {cap}",
            repo_plugins().display()
        );
    }
    std::fs::create_dir_all(&plugins).unwrap();
    for (dir, m) in &found {
        println!("plugin {} from {}", m["id"], dir.display());
        copy_plugin(dir, &plugins);
    }
    let toggles: Vec<(String, String)> = found
        .iter()
        .filter(|(_, m)| provides(m, CONTROL))
        .map(|(_, m)| (m["id"].as_str().unwrap().to_owned(), input_toggle(m)))
        .collect();
    let tools = probe(&plugins, &root, &toggles).await;
    println!("tools: {tools:?}");

    // The chosen folder, with the document in it.
    let docs = root.join("docs");
    std::fs::create_dir_all(&docs).unwrap();
    let doc = docs.join("ledger.docx");
    std::fs::write(&doc, docx(DOC_PHRASE)).unwrap();

    // The hub: scratch data, in-memory secrets, the scripted model, the window's UI.
    let skipped = Arc::new(Mutex::new(None));
    let p = provider(script(tools.clone(), doc.clone(), skipped.clone())).await;
    let providers = root.join("providers.json");
    let row = json!([{"id": "fakep", "base_url": p.base, "models_path": "/models", "auth": "none", "all_free": true}]);
    std::fs::write(&providers, row.to_string()).unwrap();
    let mut c = command(&root);
    c.env("ALEXIA_FREE_PROVIDERS", &providers)
        .env("ALEXIA_UI_DIR", write_ui(&root))
        .env_remove("ALEXIA_WINDOW_PORT");
    let mut hub = Hub::run(c);
    hub.up().await;
    let w = window(&data);

    // Before the turn, through the window only: input on, the plugins trusted, the folder chosen.
    let set = post(
        &w,
        "/api/settings",
        json!({"plugin": tools.computer, "key": tools.input_toggle, "value": true}),
    );
    assert_eq!(set["ok"], true, "{set}");
    for id in &tools.plugins {
        let trusted = post(
            &w,
            "/api/server",
            json!({"action": "trust", "id": id, "confirm": true}),
        );
        assert_eq!(trusted["ok"], true, "{trusted}");
        assert!(
            !trusted["unreviewed"]
                .as_array()
                .is_some_and(|u| u.iter().any(|x| x == id.as_str())),
            "{trusted}"
        );
    }
    let docs_root = docs.display().to_string();
    let perms = post(&w, "/api/permissions", json!({"roots": [docs_root]}));
    assert!(
        perms["roots"].as_array().is_some_and(|r| r.len() == 1),
        "{perms}"
    );

    // Turn 1: windows → Character Map → click its box → type → read back → screenshot → a
    // plan. The gate asks before each action that touches the screen; the window says yes.
    println!("turn 1: {TURN_DRIVE}");
    let mut asked = 0;
    let frames = tokio::task::block_in_place(|| {
        chat_turn(&w, TURN_DRIVE, |_| {
            asked += 1;
            true
        })
    });
    // A PC action that fails is written down and the test goes on, so one run shows every
    // gap; the test fails at the end with all of them.
    let mut problems: Vec<String> = Vec::new();
    let mut check = |ok: bool, said: String| {
        if !ok {
            println!("PROBLEM: {said}");
            problems.push(said);
        }
    };
    let listed = one_outcome(&frames, &tools.computer("windows"));
    check(listed["ok"] == true, format!("windows: {listed}"));
    let opened = one_outcome(&frames, &tools.computer("open_app"));
    check(opened["ok"] == true, format!("open_app: {opened}"));
    let apps: Vec<(u32, String)> = processes(APP_IMAGE)
        .into_iter()
        .filter(|(_, title)| !title.is_empty() && title != "N/A")
        .collect();
    check(
        !apps.is_empty(),
        format!("no {APP_IMAGE} with a window title is running"),
    );
    println!("{APP}: {apps:?}");
    if let Some(why) = lock(&skipped).clone() {
        check(false, format!("nothing was clicked or typed: {why}"));
    } else {
        let clicked = one_outcome(&frames, &tools.computer("click"));
        check(clicked["ok"] == true, format!("click: {clicked}"));
        let typed = one_outcome(&frames, &tools.control);
        check(typed["ok"] == true, format!("type: {typed}"));
    }
    let read = one_outcome(&frames, &tools.computer("read"));
    let read_text = read["text"].as_str().unwrap_or("");
    println!("read back: {read_text:?}");
    check(
        read["ok"] == true && read_text.contains(TYPED),
        format!("{APP} read back {read}, not {TYPED:?}"),
    );

    let shot = one_outcome(&frames, &tools.screenshot);
    assert_eq!(shot["ok"], true, "{shot}");
    let file = shot["files"]
        .as_array()
        .and_then(|f| f.first())
        .unwrap_or_else(|| panic!("the screenshot step offers no file: {shot}"));
    let png = PathBuf::from(file["path"].as_str().unwrap());
    let bytes = std::fs::read(&png).unwrap();
    assert!(bytes.len() > 8, "{} is empty", png.display());
    assert_eq!(
        &bytes[..8],
        b"\x89PNG\r\n\x1a\n",
        "{} is no PNG",
        png.display()
    );
    println!("screenshot: {} ({} bytes)", png.display(), bytes.len());

    let staged = frames
        .iter()
        .filter(|f| {
            f["step"]["progress"]["stages"]
                .as_array()
                .is_some_and(|s| !s.is_empty())
        })
        .count();
    let task = one_outcome(&frames, &tools.computer("run_task"));
    if task["ok"] == true {
        check(
            staged > 0,
            "the plan ran but no step.progress frame had stages".into(),
        );
        println!("plan progress: {staged} frames with stages");
    } else {
        println!(
            "plan progress NOT CHECKED: the plan did not run ({}), so no stages are expected",
            task["text"]
        );
    }
    check(
        asked >= 2,
        format!("the gate asked only {asked} times in turn 1"),
    );

    // Turn 2: the document in the chosen folder.
    println!("turn 2: {TURN_READ}");
    let frames = tokio::task::block_in_place(|| chat_turn(&w, TURN_READ, |_| true));
    let extracted = one_outcome(&frames, &tools.extract);
    println!("extracted: {}", short(extracted));
    check(
        extracted["ok"] == true
            && extracted["text"]
                .as_str()
                .is_some_and(|t| t.contains(DOC_PHRASE)),
        format!("document.extract: {extracted}"),
    );
    check(
        !frames.iter().any(|f| f.get("ask").is_some()),
        "reading in the chosen folder asked".into(),
    );

    // Turn 3: a risky call is asked about; yes runs it, no does not.
    for allow in [true, false] {
        println!(
            "turn 3 ({}): {TURN_RISKY}",
            if allow { "yes" } else { "no" }
        );
        let mut questions = Vec::new();
        let frames = tokio::task::block_in_place(|| {
            // Each run its own words, so the scripted model starts a fresh turn.
            let said = format!("{TURN_RISKY} ({})", if allow { "first" } else { "second" });
            chat_turn(&w, &said, |q| {
                questions.push(q.to_owned());
                allow
            })
        });
        check(
            questions.len() == 1,
            format!("turn 3 ({allow}) asked {questions:?}"),
        );
        let moved = one_outcome(&frames, &tools.control);
        let ran =
            moved["ok"] == true && moved["text"].as_str().is_some_and(|t| t.contains("Did it"));
        println!("risky call, allowed {allow}: {}", short(moved));
        check(
            ran == allow,
            format!(
                "allowed {allow}, but the call {}: {moved}",
                if ran { "ran" } else { "did not run" }
            ),
        );
    }

    // The produced file: Show in folder answers ok and Explorer starts.
    let id = file["id"].as_str().unwrap();
    let explorers: Vec<u32> = processes("explorer.exe").iter().map(|(p, _)| *p).collect();
    let shown = post(&w, "/api/file", json!({"id": id, "action": "reveal"}));
    assert_eq!(shown, json!({"ok": true}));
    let end = Instant::now() + Duration::from_secs(5);
    let mut new_explorer = None;
    while Instant::now() < end && new_explorer.is_none() {
        new_explorer = processes("explorer.exe")
            .into_iter()
            .find(|(p, _)| !explorers.contains(p));
        std::thread::sleep(Duration::from_millis(50));
    }
    println!("explorer: {new_explorer:?}");
    check(
        new_explorer.is_some(),
        "no new explorer.exe within 5 s of Show in folder".into(),
    );

    // Open on the same file (P2D phase review B2): answers ok and the default image viewer
    // shows it, found as a window whose title names the file. Photos starts each window in a
    // process it launched ahead of time, so the process may predate this step; the window is
    // still ours, because its title is this run's own timestamped file name. That process is
    // closed, by pid, and only when its title still names the file.
    let stem = png
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_owned();
    let opened = post(
        &w,
        "/api/file",
        json!({"id": id, "action": "open", "confirm": true}),
    );
    check(
        opened == json!({"ok": true}),
        format!("Open answered {opened}"),
    );
    let end = Instant::now() + Duration::from_secs(15);
    let mut viewer = None;
    while Instant::now() < end && viewer.is_none() {
        viewer = all_processes()
            .into_iter()
            .find(|(_, title)| !stem.is_empty() && title.contains(&stem));
        std::thread::sleep(Duration::from_millis(200));
    }
    println!("viewer: {viewer:?}");
    check(
        viewer.is_some(),
        format!("no new window titled with {stem} within 15 s of Open"),
    );
    if let Some((pid, _)) = viewer {
        taskkill(pid);
    }

    let stopped = hub.stop().await;
    check(
        stopped == Some(0),
        format!(
            "the hub stopped with {stopped:?}
{}",
            hub.log()
        ),
    );
    assert!(
        problems.is_empty(),
        "{} PC action(s) failed:
- {}",
        problems.len(),
        problems.join(
            "
- "
        )
    );
}
