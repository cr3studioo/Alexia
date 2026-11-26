// SPDX-License-Identifier: AGPL-3.0-only
//! P3-32: a simulated week, proven. The hub's real wiring (store, bus, `Agent`, gateway,
//! asker, tooling, scheduler) lives through seven days, and V3-3's done-when is asserted as far
//! as code can: a morning brief every day at the right moment, a deadline flagged while it was
//! still low or normal, a promise raised and closed when the owner says it is done, all
//! unprompted, nothing in quiet hours except what is urgent, and no tool run on her own that the
//! silent rule did not allow.
//!
//! What is fake: the model (a script behind the OpenAI-compatible provider on 127.0.0.1, built
//! on `common`'s HTTP kit as `agent_e2e.rs` does), the chat channel, the sources
//! (`notice.items`, `brief.section`, `notice.done`) and three builtin tools. No plugin is started.
//!
//! Time: the scheduler reads a shared `Ms` the test moves in 5-minute steps, and tokio's paused
//! time moves with it so every timer fires. A model turn and a channel message need real I/O,
//! so time runs for real while one is in progress (paused time would fire their timeouts while
//! the socket is still being read). The week is in 2100: the gateway stamps its own events with
//! the machine's clock, which must read as long before anything the week says.

mod common;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::agent::{Agent, AgentParts};
use alexia_core::catalog::Catalog;
use alexia_core::checker::Checker;
use alexia_core::free::{Auth, FreeRow};
use alexia_core::helpers::Helpers;
use alexia_core::openai::OpenAiCompat;
use alexia_core::router::Router;
use alexia_core::tools::McpTooling;
use alexia_core::undo::UndoTool;
use alexia_core::{
    Budget, Builtin, Bus, Event, Limits, Origin, OutFile, Provider, ToolCtx, ToolOutcome, ToolSpec,
    Urgency,
};
use alexia_gateway::{
    Asker, Channel, ChannelSet, ChatRef, Gateway, GatewayConfig, InFile, InKind, Inbound, Media,
    MsgRef, Outbound,
};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, Timings};
use alexia_scheduler::quiet::QUIET_PROPOSED;
use alexia_scheduler::{NoticeItem, Proactive, Scheduler, Sources, Trigger};
use alexia_store::{Content, Layout, Ms, NoticeRow, Store};
use chrono::{DateTime, Datelike, FixedOffset, TimeZone, Timelike, Weekday};
use common::{answer, last_user_text, listen, lock, read_req, scratch, send_sse, until, SSE};
use serde_json::{json, Map, Value};
use tokio::net::TcpStream;
use tokio::sync::broadcast::{error::TryRecvError, Receiver};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const MIN: Ms = 60_000;
const STEP: Ms = 5 * MIN;

/// The fake chat channel stands in for the owner's messenger.
const CHANNEL: &str = "telegram";
/// The owner's chat on it.
const CHAT: &str = "4242";
const ITEMS: &str = "notice.items";

const C1: &str = "fake:c1";
const C2: &str = "fake:c2";
const DEADLINE_KEY: &str = "fake:event1";
const DEADLINE: &str = "Hand in the seminar paper";
const PROMISE: &str = "Send the form to Jana";
const PROMISE_SAID: &str = "I'll send the form to Jana by Thursday";
const URGENT_NIGHT: &str = "Water is leaking in the flat";
const NORMAL_NIGHT: &str = "The library book can be renewed";

/// The builtin tools the test adds.
const COMMIT: &str = "commit";
const WRITE: &str = "fixture.write";
const SEND: &str = "fixture.send";

/// The prompts of the jobs she runs on her own.
const WRITE_JOB: &str = "Tidy up my notes.";
const SEND_JOB: &str = "Post the weekly note.";

// ---- time: UTC+1, Monday 2100-03-01 .. Sunday 2100-03-07 ----

fn plus1() -> FixedOffset {
    FixedOffset::east_opt(3600).unwrap()
}

/// Day `day` of the week (1 = Monday; 8 = the Monday after) at `h:m`.
fn on(day: u32, h: u32, m: u32) -> Ms {
    plus1()
        .with_ymd_and_hms(2100, 3, day, h, m, 0)
        .unwrap()
        .timestamp_millis()
}

fn local(ms: Ms) -> DateTime<FixedOffset> {
    plus1().timestamp_millis_opt(ms).unwrap()
}

/// "day 4 07:30".
fn stamp(ms: Ms) -> String {
    let t = local(ms);
    format!("day {} {:02}:{:02}", t.day(), t.hour(), t.minute())
}

/// Inside the quiet hours, 23:00–07:00.
fn at_night(ms: Ms) -> bool {
    let hour = local(ms).hour();
    !(7..23).contains(&hour)
}

// ---- the fake sources ----

/// `notice.items` from a list of commitments, one calendar deadline and two things that come up
/// in the night; `brief.section` names the day; `notice.done` keeps the keys it gets.
struct Fake {
    commitments: Mutex<Vec<NoticeItem>>,
    done: Mutex<Vec<String>>,
}

fn item(key: &str, text: &str, urgency: Option<Urgency>, due_at: Option<Ms>) -> NoticeItem {
    NoticeItem {
        key: key.into(),
        text: text.into(),
        why: "The test's source says so.".into(),
        urgency,
        due_at,
        not_before: None,
    }
}

impl Fake {
    fn new() -> Arc<Fake> {
        Arc::new(Fake {
            commitments: Mutex::new(vec![item(C1, "Return Petr's charger", None, None)]),
            done: Mutex::default(),
        })
    }
}

#[async_trait::async_trait]
impl Sources for Fake {
    async fn items(&self, now: Ms, _: u32) -> Vec<(String, NoticeItem)> {
        let mut items = lock(&self.commitments).clone();
        let due = on(4, 17, 0);
        // A calendar stops offering an event once it is over.
        if now <= due {
            items.push(item(DEADLINE_KEY, DEADLINE, None, Some(due)));
        }
        if now >= on(5, 2, 0) {
            items.push(item("fake:u1", URGENT_NIGHT, Some(Urgency::Urgent), None));
            items.push(item("fake:n1", NORMAL_NIGHT, Some(Urgency::Normal), None));
        }
        items.into_iter().map(|i| (ITEMS.to_string(), i)).collect()
    }

    async fn sections(&self, _: &str, now: Ms) -> Vec<String> {
        vec![format!("Today: {}", local(now).format("%A"))]
    }

    async fn poll(&self, _: &str, _: Map<String, Value>) -> Option<String> {
        None
    }

    async fn done(&self, key: &str) {
        lock(&self.done).push(key.to_string());
        // The plugin closes its side too.
        lock(&self.commitments).retain(|c| c.key != key);
    }
}

// ---- the builtin tools ----

/// `commit` records a promise in the fake source; `fixture.write` changes something on this
/// machine; `fixture.send` reaches outside it.
struct Tools {
    fake: Arc<Fake>,
    /// Every call that ran, by tool name.
    ran: Mutex<Vec<String>>,
}

fn spec(name: &str, words: &str, open_world: bool) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        description: format!("The {name} tool."),
        params: json!({"type": "object", "properties": {"promise": {"type": "string"}}}),
        annotations: serde_json::from_value(json!({
            "readOnlyHint": false,
            "destructiveHint": false,
            "openWorldHint": open_world,
        }))
        .ok(),
        reviewed: true,
        plugin: None,
        words: words.into(),
    }
}

#[async_trait::async_trait]
impl Builtin for Tools {
    fn specs(&self) -> Vec<ToolSpec> {
        vec![
            spec(COMMIT, "record a promise", false),
            spec(WRITE, "tidy the notes", false),
            spec(SEND, "post a note", true),
        ]
    }

    async fn call(
        &self,
        name: &str,
        args: &Map<String, Value>,
        _: &ToolCtx,
    ) -> Option<ToolOutcome> {
        if ![COMMIT, WRITE, SEND].contains(&name) {
            return None;
        }
        lock(&self.ran).push(name.to_string());
        if name == COMMIT {
            let what = args.get("promise").and_then(Value::as_str)?;
            // "by Thursday": day 4, at the end of the working day.
            lock(&self.fake.commitments).push(item(C2, what, None, Some(on(4, 17, 0))));
        }
        Some(ToolOutcome {
            text: format!("{name} done"),
            ok: true,
            files: Vec::new(),
            final_text: None,
            undo: None,
            card: None,
        })
    }
}

// ---- the scripted provider ----

/// What the model does with the last thing it was told: first one tool call, then, with the
/// tool's result in hand, an answer.
fn script(body: &Value) -> (Option<(&'static str, Value)>, &'static str) {
    let told = last_user_text(body);
    let answered = body["messages"].as_array().is_some_and(|m| {
        m.iter()
            .rev()
            .take_while(|m| m["role"] != "user")
            .any(|m| m["role"] == "tool")
    });
    let (call, reply) = if told.contains(PROMISE_SAID) {
        let args = json!({"promise": PROMISE});
        ((COMMIT, args), "I will hold you to that.")
    } else if told.contains(WRITE_JOB) {
        ((WRITE, json!({})), "The notes round is over.")
    } else if told.contains(SEND_JOB) {
        ((SEND, json!({})), "The posting round is over.")
    } else {
        return (None, "Noted.");
    };
    ((!answered).then_some(call), reply)
}

/// The name the request offers for the tool `name` (a `.` goes over the wire as `_`).
fn wire_name(body: &Value, name: &str) -> String {
    let wire = name.replace('.', "_");
    body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t["function"]["name"].as_str())
        .find(|n| *n == wire)
        .unwrap_or_else(|| panic!("the request offers no tool {name}: {body}"))
        .to_owned()
}

async fn provider_conn(mut sock: TcpStream, calls: Arc<AtomicI64>) {
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
        let (call, reply) = if tools {
            script(&body)
        } else {
            (None, "Noted.")
        };
        let frame = |delta: Value, finish: Value| {
            let f = json!({"model": "fake-tools-70b", "choices": [{"delta": delta, "finish_reason": finish}]});
            format!("data: {f}\n\n")
        };
        let frames = match call {
            None => format!(
                "{}{}",
                frame(json!({"content": reply}), Value::Null),
                frame(json!({}), json!("stop"))
            ),
            Some((name, args)) => {
                let id = calls.fetch_add(1, Ordering::SeqCst);
                let call = json!([{
                    "index": 0,
                    "id": format!("call-{id}"),
                    "type": "function",
                    "function": {"name": wire_name(&body, name), "arguments": args.to_string()},
                }]);
                format!(
                    "{}{}",
                    frame(json!({"tool_calls": call}), Value::Null),
                    frame(json!({}), json!("tool_calls"))
                )
            }
        };
        let _ = send_sse(&mut sock, &format!("{SSE}{frames}data: [DONE]\n\n")).await;
        return;
    }
}

/// The provider on 127.0.0.1; its base URL.
async fn provider() -> String {
    let (listener, base) = listen().await;
    let calls = Arc::new(AtomicI64::new(1));
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            let _ = sock.set_nodelay(true);
            tokio::spawn(provider_conn(sock, calls.clone()));
        }
    });
    format!("{base}/v1")
}

// ---- the fake channel ----

/// Something the owner was sent, and when (the week's clock).
#[derive(Clone, Debug)]
struct Sent {
    at: Ms,
    id: String,
    text: String,
    buttons: Vec<(String, String)>,
}

struct Chan {
    clock: Arc<AtomicI64>,
    inbox: Mutex<VecDeque<Inbound>>,
    wake: Notify,
    sent: Mutex<Vec<Sent>>,
    /// The yes/no questions put to the owner.
    asked: Mutex<Vec<String>>,
    /// What the owner answers: yes only while they are in the conversation themselves.
    yes: AtomicBool,
    /// (message, emoji) reactions.
    reactions: Mutex<Vec<(String, String)>>,
    next: AtomicI64,
}

impl Chan {
    fn new(clock: Arc<AtomicI64>) -> Arc<Chan> {
        Arc::new(Chan {
            clock,
            inbox: Mutex::default(),
            wake: Notify::new(),
            sent: Mutex::default(),
            asked: Mutex::default(),
            yes: AtomicBool::new(false),
            reactions: Mutex::default(),
            next: AtomicI64::new(1),
        })
    }

    /// The owner writes `text`, as a reply to `reply_to` when given; the message's id.
    fn owner_says(&self, text: &str, reply_to: Option<&str>) -> String {
        let id = format!("o{}", self.next.fetch_add(1, Ordering::SeqCst));
        lock(&self.inbox).push_back(Inbound {
            chat: ChatRef { chat: CHAT.into() },
            msg: MsgRef { id: id.clone() },
            kind: InKind::Message,
            from_owner: true,
            content: Content::Text(text.into()),
            files: Vec::new(),
            at: self.clock.load(Ordering::SeqCst),
            button: None,
            reply_to: reply_to.map(|id| MsgRef { id: id.into() }),
        });
        self.wake.notify_one();
        id
    }

    fn record(&self, text: &str, buttons: &[(String, String)]) -> MsgRef {
        let id = format!("a{}", self.next.fetch_add(1, Ordering::SeqCst));
        lock(&self.sent).push(Sent {
            at: self.clock.load(Ordering::SeqCst),
            id: id.clone(),
            text: text.into(),
            buttons: buttons.to_vec(),
        });
        MsgRef { id }
    }

    fn sent(&self) -> Vec<Sent> {
        lock(&self.sent).clone()
    }

    fn got(&self, needle: &str) -> bool {
        lock(&self.sent).iter().any(|s| s.text.contains(needle))
    }

    fn asked(&self) -> Vec<String> {
        lock(&self.asked).clone()
    }
}

#[async_trait::async_trait]
impl Channel for Chan {
    fn name(&self) -> &'static str {
        CHANNEL
    }
    fn budget(&self) -> Budget {
        Budget::CHAT
    }
    async fn next(&self, cancel: CancellationToken) -> alexia_gateway::Result<Vec<Inbound>> {
        loop {
            let waiting: Vec<Inbound> = lock(&self.inbox).drain(..).collect();
            if !waiting.is_empty() {
                return Ok(waiting);
            }
            tokio::select! {
                () = cancel.cancelled() => return Err(alexia_gateway::Error::Cancelled),
                () = self.wake.notified() => {}
            }
        }
    }
    async fn react(&self, _: &ChatRef, msg: &MsgRef, emoji: &str) -> alexia_gateway::Result<()> {
        lock(&self.reactions).push((msg.id.clone(), emoji.into()));
        Ok(())
    }
    async fn typing(&self, _: &ChatRef) -> alexia_gateway::Result<()> {
        Ok(())
    }
    async fn send(&self, _: &ChatRef, out: &Outbound) -> alexia_gateway::Result<MsgRef> {
        Ok(self.record(&out.text, &[]))
    }
    async fn notify(
        &self,
        _: &ChatRef,
        text: &str,
        buttons: &[(String, String)],
    ) -> alexia_gateway::Result<MsgRef> {
        Ok(self.record(text, buttons))
    }
    async fn draft(&self, _: &ChatRef, _: Option<&str>) -> alexia_gateway::Result<()> {
        Ok(())
    }
    async fn edit(&self, _: &ChatRef, _: &MsgRef, _: &str) -> alexia_gateway::Result<()> {
        Ok(())
    }
    async fn ask(
        &self,
        _: &ChatRef,
        text: &str,
        _: CancellationToken,
    ) -> alexia_gateway::Result<Option<bool>> {
        lock(&self.asked).push(text.into());
        Ok(Some(self.yes.load(Ordering::SeqCst)))
    }
}

/// No voice in or out.
struct NoMedia;

#[async_trait::async_trait]
impl Media for NoMedia {
    async fn transcribe(
        &self,
        _: &InFile,
        _: CancellationToken,
    ) -> alexia_gateway::Result<Option<String>> {
        Ok(None)
    }
    async fn speak(
        &self,
        _: &str,
        _: CancellationToken,
    ) -> alexia_gateway::Result<Option<OutFile>> {
        Ok(None)
    }
}

// ---- the week ----

/// One `Event::Say`.
#[derive(Clone, Debug)]
struct Said {
    at: Ms,
    text: String,
    urgency: Urgency,
    notice: Option<i64>,
    /// The calendar deadline's stored urgency when this was said.
    deadline_urgency: Option<String>,
}

struct Week {
    root: PathBuf,
    clock: Arc<AtomicI64>,
    store: Arc<Store>,
    bus: Bus,
    rx: Receiver<Arc<Event>>,
    fake: Arc<Fake>,
    tools: Arc<Tools>,
    chan: Arc<Chan>,
    scheduler: Arc<Scheduler>,
    host: McpHost,
    cancel: CancellationToken,
    running: Vec<tokio::task::JoinHandle<()>>,
    said: Vec<Said>,
    /// When each owner message reached the brain (`Event::Received`), on the week's clock.
    received: Vec<Ms>,
}

impl Week {
    /// The parts, wired as `alexia-hub run` wires them, started at day 1 00:00.
    async fn start() -> Week {
        let root = scratch("week");
        let (data, plugins) = (root.join("data"), root.join("plugins"));
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&plugins).unwrap();
        let clock = Arc::new(AtomicI64::new(on(1, 0, 0)));
        let store = Arc::new(Store::open_in_memory().unwrap());
        Proactive {
            quiet: QUIET_PROPOSED,
            brief_earliest: (5, 0),
            brief_fallback: (9, 0),
            ..Proactive::default()
        }
        .save(&store)
        .unwrap();
        store.channel_session(CHANNEL, CHAT).unwrap();
        store.set_primary_chat(CHANNEL, CHAT).unwrap();

        let row = FreeRow {
            id: "fakep".into(),
            base_url: provider().await,
            models_path: Some("/models".into()),
            headers: Vec::new(),
            auth: Auth::None,
            all_free: true,
            rpm: None,
            rpd: None,
            router: false,
        };
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let model: Arc<dyn Provider> = Arc::new(OpenAiCompat::with_timeouts(
            row.clone(),
            None,
            client,
            Duration::from_secs(60),
            Duration::from_secs(60),
        ));
        let catalog = Arc::new(Catalog::new(
            vec![model.clone()],
            vec![row],
            root.join("catalog.json"),
        ));
        catalog.refresh().await;
        assert!(
            !catalog.candidates().is_empty(),
            "the scripted model is not in the catalog"
        );
        let router = Arc::new(Router::new(vec![model], catalog, store.clone()));

        let bus = Bus::new(8192);
        let rx = bus.subscribe();
        let host = McpHost::new(
            HostConfig {
                layout: Layout::new(data.clone()),
                plugin_dirs: vec![plugins],
                node: PathBuf::from("node"),
                timings: Timings::default(),
            },
            store.clone(),
            Arc::new(NoUpcalls),
            Arc::new(|_| {}),
        );
        host.start(&[]).await.unwrap();
        let chan = Chan::new(clock.clone());
        let channels = ChannelSet::new();
        channels.add(chan.clone());
        let asker = Asker::new(channels.clone(), store.clone(), bus.clone());
        let tooling = Arc::new(McpTooling::new(host.clone(), vec![]));
        let agent = Agent::new(AgentParts {
            router,
            tools: tooling.clone(),
            store: store.clone(),
            bus: bus.clone(),
            ask: asker,
            checker: Arc::new(Checker::new(None)),
            caps: Arc::new(host.clone()),
            layout: Layout::new(data),
            limits: Limits::default(),
            host: host.clone(),
        });
        let fake = Fake::new();
        let tools = Arc::new(Tools {
            fake: fake.clone(),
            ran: Mutex::default(),
        });
        tooling.add_builtin(Helpers::new(&agent));
        tooling.add_builtin(UndoTool::new(&agent));
        let now = clock.clone();
        let scheduler = Scheduler::with_parts(
            store.clone(),
            bus.clone(),
            agent.clone(),
            Box::new(move || now.load(Ordering::SeqCst)),
            Box::new(Store::jobs),
            fake.clone(),
        );
        scheduler.set_zone(Some(plus1()));
        tooling.add_builtin(scheduler.tools());
        tooling.add_builtin(tools.clone());
        let gateway = Gateway::with_channels(
            GatewayConfig::default(),
            store.clone(),
            bus.clone(),
            agent,
            Arc::new(NoMedia),
            channels,
        );

        // From here the week's clock and tokio's move only when the test moves them.
        tokio::time::pause();
        let cancel = CancellationToken::new();
        let (g, s) = (cancel.clone(), cancel.clone());
        let sched = scheduler.clone();
        let running = vec![
            tokio::spawn(async move { gateway.run(g).await.expect("the gateway ran") }),
            tokio::spawn(async move { sched.run(s).await.expect("the scheduler ran") }),
        ];
        let mut week = Week {
            root,
            clock,
            store,
            bus,
            rx,
            fake,
            tools,
            chan,
            scheduler,
            host,
            cancel,
            running,
            said: Vec::new(),
            received: Vec::new(),
        };
        week.settle().await;
        week
    }

    fn now(&self) -> Ms {
        self.clock.load(Ordering::SeqCst)
    }

    /// The notice filed under `key`, whatever its state.
    fn notice(&self, key: &str) -> Option<NoticeRow> {
        self.store
            .notices_since(0, 1_000)
            .unwrap()
            .into_iter()
            .find(|n| n.key == key)
    }

    /// Paused time only moves on when every task is waiting, so this returns once all that was
    /// set off has been done.
    async fn settle(&mut self) {
        tokio::time::sleep(Duration::from_millis(1)).await;
        self.collect();
    }

    fn collect(&mut self) {
        loop {
            let event = match self.rx.try_recv() {
                Ok(e) => e,
                Err(TryRecvError::Empty | TryRecvError::Closed) => return,
                Err(TryRecvError::Lagged(n)) => panic!("the test lost {n} bus events"),
            };
            match &*event {
                Event::Say {
                    at,
                    text,
                    urgency,
                    notice,
                    ..
                } => {
                    let said = Said {
                        at: *at,
                        text: text.clone(),
                        urgency: *urgency,
                        notice: *notice,
                        deadline_urgency: self.notice(DEADLINE_KEY).map(|n| n.urgency),
                    };
                    self.said.push(said);
                }
                // The gateway stamps this with the machine's clock; the week's is what counts.
                Event::Received { .. } => self.received.push(self.now()),
                _ => {}
            }
        }
    }

    /// Moves the week to `to`, with the owner's sign of life if one falls there.
    async fn step(&mut self, to: Ms) {
        self.clock.store(to, Ordering::SeqCst);
        let t = local(to);
        let weekday = !matches!(t.weekday(), Weekday::Sat | Weekday::Sun);
        let wakes = (weekday && (t.hour(), t.minute()) == (7, 30)) || to == on(7, 10, 15);
        if wakes {
            self.bus.publish(Event::Active {
                at: to,
                via: CHANNEL.into(),
            });
        }
        tokio::time::sleep(Duration::from_millis(STEP as u64)).await;
        self.settle().await;
    }

    /// The owner writes in the chat, and the test waits (in real time) for `done`.
    async fn owner(
        &mut self,
        text: &str,
        reply_to: Option<&str>,
        done: impl Fn(&Week, &str) -> bool,
    ) {
        tokio::time::resume();
        let id = self.chan.owner_says(text, reply_to);
        let ok = until(60, || done(self, &id)).await;
        tokio::time::pause();
        assert!(ok, "the owner's message \"{text}\" was not handled");
        self.settle().await;
    }

    /// Alexia runs `prompt` on her own: a job due a second from now, through the real
    /// scheduler and agent. Returns once its `answer` reached the chat.
    async fn own_turn(&mut self, prompt: &str, answer: &str) {
        let before = self.chan.sent().len();
        tokio::time::resume();
        let at = self.now() + 1_000;
        self.scheduler
            .add(
                Trigger::At { at },
                prompt,
                Urgency::Normal,
                Origin::Channel {
                    channel: CHANNEL.into(),
                    chat: CHAT.into(),
                },
            )
            .unwrap();
        // Nothing is awaited between the two, so the scheduler finds the job due.
        self.clock.store(at, Ordering::SeqCst);
        let chan = self.chan.clone();
        let ok = until(60, || {
            chan.sent().iter().skip(before).any(|s| s.text == answer)
        })
        .await;
        tokio::time::pause();
        assert!(ok, "her own turn \"{prompt}\" did not finish");
        self.settle().await;
    }

    /// The latest audit decision for `tool` in a turn of her own: (gate, decision).
    fn ruling(&self, tool: &str) -> (String, String) {
        self.store
            .audit_search("", 100)
            .unwrap()
            .into_iter()
            .filter(|a| a.tool == tool && a.origin.contains("scheduler"))
            .max_by_key(|a| a.id)
            .map(|a| (a.gate, a.decision))
            .unwrap_or_else(|| panic!("no audit row for {tool}"))
    }

    fn ran(&self, tool: &str) -> usize {
        lock(&self.tools.ran).iter().filter(|t| *t == tool).count()
    }

    fn silent(&self, tools: &[&str]) {
        self.store.kv_set("_core", "silent", &json!(tools)).unwrap();
    }

    /// The permission mode the owner chose; none chosen is "ask when risky".
    fn mode(&self, mode: &str) {
        self.store
            .kv_set("_core", "scope", &json!({"mode": mode}))
            .unwrap();
    }

    /// Day 3 at noon: what she does without asking.
    async fn acts_silently_only_on_the_list(&mut self) {
        // Not on the list: she asks, the owner says no, and it does not run.
        let asked = self.chan.asked().len();
        self.own_turn(WRITE_JOB, "The notes round is over.").await;
        let questions = self.chan.asked();
        assert!(
            questions.len() == asked + 1 && questions[asked].contains("on her own"),
            "act silently only on the list: a tool not on the list must be asked about: {questions:?}"
        );
        assert!(
            self.ran(WRITE) == 0,
            "act silently only on the list: she ran a tool that was not on the list"
        );
        assert_eq!(
            self.ruling(WRITE),
            ("proactive".to_string(), "denied".to_string()),
            "act silently only on the list: the unlisted tool's audit row"
        );

        // The owner lists it: the same turn runs without asking.
        self.silent(&[WRITE]);
        let asked = self.chan.asked().len();
        self.own_turn(WRITE_JOB, "The notes round is over.").await;
        assert!(
            self.chan.asked().len() == asked,
            "act silently only on the list: she asked about a listed tool: {:?}",
            self.chan.asked()
        );
        assert!(
            self.ran(WRITE) == 1,
            "act silently only on the list: the listed tool did not run"
        );
        assert_eq!(
            self.ruling(WRITE),
            ("proactive".to_string(), "run".to_string()),
            "act silently only on the list: the listed tool's audit row"
        );

        // Something that leaves the machine is asked about even when listed, and even in full
        // trust, where the owner's own turns ask about nothing.
        self.mode("full-trust");
        self.silent(&[WRITE, SEND]);
        let asked = self.chan.asked().len();
        self.own_turn(SEND_JOB, "The posting round is over.").await;
        assert!(
            self.chan.asked().len() == asked + 1,
            "act silently only on the list: an outward-facing tool must always ask: {:?}",
            self.chan.asked()
        );
        assert!(
            self.ran(SEND) == 0,
            "act silently only on the list: an outward-facing tool ran without the owner's yes"
        );
        assert_eq!(
            self.ruling(SEND),
            ("proactive".to_string(), "denied".to_string()),
            "act silently only on the list: the outward-facing tool's audit row"
        );

        // Full trust does not widen the list: off it again, she asks.
        self.silent(&[]);
        let asked = self.chan.asked().len();
        self.own_turn(WRITE_JOB, "The notes round is over.").await;
        assert!(
            self.chan.asked().len() == asked + 1 && self.ran(WRITE) == 1,
            "act silently only on the list: full trust must not run an unlisted tool: {:?}",
            self.chan.asked()
        );
    }

    /// Day 2 at 14:00: the owner makes a promise in the chat.
    async fn makes_a_promise(&mut self) {
        let turns = self.received.len();
        // Recording it changes something, so she asks, and the owner, who is right there, agrees.
        self.chan.yes.store(true, Ordering::SeqCst);
        self.owner(PROMISE_SAID, None, |w, _| {
            w.chan.got("I will hold you to that.")
        })
        .await;
        self.chan.yes.store(false, Ordering::SeqCst);
        assert!(
            self.received.len() == turns + 1,
            "a promise followed through: the owner's message never reached her"
        );
        assert!(
            self.ran(COMMIT) == 1 && lock(&self.fake.commitments).iter().any(|c| c.key == C2),
            "a promise followed through: the promise was not recorded"
        );
    }

    /// Day 4, just after the morning brief: "done", as a reply to her note about the promise.
    async fn says_done(&mut self) {
        let note = self
            .chan
            .sent()
            .into_iter()
            .rev()
            .find(|s| !s.buttons.is_empty() && s.text.contains(PROMISE));
        let Some(note) = note else {
            panic!("a promise followed through: she never sent a note about the promise");
        };
        self.owner("done", Some(&note.id), |w, id| {
            lock(&w.fake.done).iter().any(|k| k == C2)
                && lock(&w.chan.reactions).iter().any(|(m, _)| m == id)
        })
        .await;
    }

    async fn stop(mut self) {
        tokio::time::resume();
        self.cancel.cancel();
        for task in self.running.drain(..) {
            tokio::time::timeout(Duration::from_secs(60), task)
                .await
                .expect("the hub's parts stop")
                .expect("none of them panicked");
        }
        self.host.shutdown().await;
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn seven_days() {
    assert_eq!(local(on(1, 0, 0)).weekday(), Weekday::Mon);
    let mut week = Week::start().await;
    let mut done_at = None;
    let mut t = on(1, 0, 0);
    while t < on(8, 0, 0) {
        t += STEP;
        week.step(t).await;
        if t == on(2, 14, 0) {
            week.makes_a_promise().await;
        } else if t == on(3, 12, 0) {
            week.acts_silently_only_on_the_list().await;
        } else if t == on(4, 7, 35) {
            week.says_done().await;
            done_at = Some(week.now());
        }
    }
    let said = week.said.clone();
    let sent = week.chan.sent();
    let log = || {
        said.iter()
            .map(|s| format!("{} {:?} {:?}", stamp(s.at), s.urgency, s.text))
            .collect::<Vec<_>>()
            .join("\n")
    };

    // ---- a morning brief every day, at the right moment ----
    let briefs: Vec<&Said> = said
        .iter()
        .filter(|s| s.text.starts_with("Good morning."))
        .collect();
    assert!(
        briefs.len() == 7,
        "a morning brief every day: exactly 7 in 7 days, got {}\n{}",
        briefs.len(),
        log()
    );
    let when: Vec<String> = briefs.iter().map(|b| stamp(b.at)).collect();
    for (day, brief) in (1..=5).zip(&briefs) {
        assert!(
            brief.at == on(day, 7, 30),
            "a morning brief every day: on weekdays at the owner's first sign of life, 07:30: {when:?}"
        );
    }
    assert!(
        briefs[5].at == on(6, 9, 0),
        "a morning brief every day: Saturday, with no sign of the owner, at 09:00: {when:?}"
    );
    // Sunday's first sign of life is 10:15, after the 09:00 fallback: the brief does not wait
    // for it (PHASE.md D-P3-7), and the 10:15 one brings no second brief.
    assert!(
        briefs[6].at == on(7, 9, 0),
        "a morning brief every day: Sunday at the 09:00 fallback, once: {when:?}"
    );
    assert!(
        briefs.iter().all(|b| !at_night(b.at)),
        "a morning brief every day: none between 23:00 and 07:00: {when:?}"
    );
    for brief in &briefs {
        let today = format!("Today: {}", local(brief.at).format("%A"));
        assert!(
            brief.text.contains(&today),
            "a morning brief every day: it must hold the day's section {today:?}: {:?}",
            brief.text
        );
    }

    // ---- a deadline flagged before it was urgent ----
    let due = on(4, 17, 0);
    let flagged = said.iter().find(|s| s.text.contains(DEADLINE));
    assert!(
        flagged.is_some_and(|s| s.at < on(3, 0, 0)
            && s.at < due - 24 * 60 * MIN
            && matches!(s.deadline_urgency.as_deref(), Some("low" | "normal"))),
        "deadline flagged before it was urgent: day 4's deadline must be said on day 1 or 2 while \
         low or normal, before the radar makes it high: {flagged:?}\n{}",
        log()
    );

    // ---- a promise followed through ----
    assert!(
        said.iter().any(|s| s.notice.is_some()
            && s.text.contains(PROMISE)
            && s.at > on(2, 14, 0)
            && s.at < on(4, 7, 30)),
        "a promise followed through: she never raised it before it fell due\n{}",
        log()
    );
    assert!(
        briefs[3].text.contains(PROMISE),
        "a promise followed through: Thursday's brief must list it: {:?}",
        briefs[3].text
    );
    let closed = lock(&week.fake.done).clone();
    assert!(
        closed == [C2],
        "a promise followed through: the owner's \"done\" must reach its source, once: {closed:?}"
    );
    let row = week.notice(C2).expect("the promise has a notice");
    assert!(
        row.state == "done",
        "a promise followed through: its notice must be done, not {:?}",
        row.state
    );
    let done_at = done_at.expect("the owner said done");
    assert!(
        !said
            .iter()
            .any(|s| s.at > done_at && s.text.contains(PROMISE)),
        "a promise followed through: she brought it up again after it was done\n{}",
        log()
    );

    // ---- unprompted ----
    assert!(
        week.received.len() == 1,
        "unprompted: the owner wrote to her once all week (\"done\" answers a note): {:?}",
        week.received
    );
    // No `Say` is a reply (replies go straight to the chat), so none is excepted.
    let prompted: Vec<&Said> = said
        .iter()
        .filter(|s| {
            week.received
                .iter()
                .any(|r| (0..=MIN).contains(&(s.at - r)))
        })
        .collect();
    assert!(
        prompted.is_empty(),
        "unprompted: something was said within 60 s of the owner's message: {prompted:?}"
    );
    for s in &said {
        assert!(
            sent.iter()
                .any(|m| m.at >= s.at - 1_000 && m.at <= s.at + STEP && m.text.contains(&s.text)),
            "unprompted: what she said never reached the owner's chat: {s:?}"
        );
    }

    // ---- quiet hours ----
    let loud: Vec<&Said> = said
        .iter()
        .filter(|s| at_night(s.at) && s.urgency != Urgency::Urgent)
        .collect();
    assert!(
        loud.is_empty(),
        "nothing in quiet hours except what is urgent: {loud:?}"
    );
    let woke: Vec<&Sent> = sent
        .iter()
        .filter(|m| at_night(m.at) && !m.text.starts_with("‼️"))
        .collect();
    assert!(
        woke.is_empty(),
        "nothing in quiet hours except what is urgent: the chat got {woke:?}"
    );
    let first = |text: &str| said.iter().find(|s| s.text.contains(text)).map(|s| s.at);
    assert!(
        first(URGENT_NIGHT) == Some(on(5, 2, 0)),
        "an urgent notice filed at 02:00 is said at 02:00, not {:?}",
        first(URGENT_NIGHT).map(stamp)
    );
    assert!(
        week.notice("fake:n1")
            .is_some_and(|n| n.created_at == on(5, 2, 0)),
        "a normal notice filed at 02:00: it was not filed then: {:?}",
        week.notice("fake:n1")
    );
    assert!(
        first(NORMAL_NIGHT) == Some(on(5, 7, 0)),
        "a normal notice filed at 02:00 is said at 07:00, not {:?}",
        first(NORMAL_NIGHT).map(stamp)
    );

    // ---- act silently only on the list ----
    let silent: Vec<String> = week
        .store
        .audit_search("", 100)
        .unwrap()
        .into_iter()
        .filter(|a| a.origin.contains("scheduler") && a.decision != "denied")
        .map(|a| format!("{} {} {}", a.tool, a.gate, a.decision))
        .collect();
    assert!(
        silent == [format!("{WRITE} proactive run")],
        "act silently only on the list: the one tool run on her own all week is the listed one: {silent:?}"
    );
    assert!(
        week.ran(WRITE) == 1 && week.ran(SEND) == 0,
        "act silently only on the list: tool runs over the week: {:?}",
        lock(&week.tools.ran)
    );

    week.stop().await;
}
