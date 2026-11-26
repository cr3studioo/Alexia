// SPDX-License-Identifier: AGPL-3.0-only
//! P3-39: a watch may only poll a capability its `Sources` calls watchable, checked when it is
//! made and again before every poll, and `unlocked` never reaches the polled capability.
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::{
    Brain, BrainError, Bus, DraftSink, Lane, Origin, Reply, RunId, ToolCtx, Turn, Urgency,
};
use alexia_scheduler::{NoticeItem, Scheduler, Sources, Trigger};
use alexia_store::{now_ms, Ms, Store};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

const MIN: u64 = 60_000;

#[derive(Default)]
struct EchoBrain {
    turns: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl Brain for EchoBrain {
    async fn reply(
        &self,
        turn: Turn,
        _: DraftSink,
        _: CancellationToken,
    ) -> Result<Reply, BrainError> {
        self.turns.lock().unwrap().push(turn.content.text());
        Ok(Reply {
            text: "noted".into(),
            files: vec![],
            lane: Lane::Task,
            model: None,
            spans: vec![],
        })
    }
}

/// Polls are recorded; every answer differs from the one before, so each poll after the first
/// is a change.
#[derive(Default)]
struct Polls {
    polled: Mutex<Vec<(String, Map<String, Value>)>>,
    n: AtomicUsize,
}

impl Polls {
    fn record(&self, cap: &str, args: Map<String, Value>) -> Option<String> {
        self.polled.lock().unwrap().push((cap.into(), args));
        Some(format!("answer {}", self.n.fetch_add(1, Ordering::SeqCst)))
    }

    fn all(&self) -> Vec<(String, Map<String, Value>)> {
        self.polled.lock().unwrap().clone()
    }
}

/// `watchable` answers from a set the test changes.
#[derive(Default)]
struct Gate {
    allowed: Mutex<HashSet<String>>,
    polls: Polls,
}

impl Gate {
    fn new(allowed: &[&str]) -> Arc<Gate> {
        let g = Gate::default();
        g.allowed
            .lock()
            .unwrap()
            .extend(allowed.iter().map(|c| c.to_string()));
        Arc::new(g)
    }

    fn set(&self, cap: &str, on: bool) {
        let mut a = self.allowed.lock().unwrap();
        if on {
            a.insert(cap.into());
        } else {
            a.remove(cap);
        }
    }
}

#[async_trait::async_trait]
impl Sources for Gate {
    async fn items(&self, _: Ms, _: u32) -> Vec<(String, NoticeItem)> {
        Vec::new()
    }
    async fn sections(&self, _: &str, _: Ms) -> Vec<String> {
        Vec::new()
    }
    async fn poll(&self, cap: &str, args: Map<String, Value>) -> Option<String> {
        self.polls.record(cap, args)
    }
    async fn done(&self, _: &str) {}
    async fn watchable(&self, cap: &str) -> Result<(), String> {
        if self.allowed.lock().unwrap().contains(cap) {
            Ok(())
        } else {
            Err(format!(
                "{cap} can't be watched: a watch may only read something, and that changes things."
            ))
        }
    }
}

/// Like `NoSources`: it does not say what may be watched, so it keeps the default.
#[derive(Default)]
struct Unknowing {
    polls: Polls,
}

#[async_trait::async_trait]
impl Sources for Unknowing {
    async fn items(&self, _: Ms, _: u32) -> Vec<(String, NoticeItem)> {
        Vec::new()
    }
    async fn sections(&self, _: &str, _: Ms) -> Vec<String> {
        Vec::new()
    }
    async fn poll(&self, cap: &str, args: Map<String, Value>) -> Option<String> {
        self.polls.record(cap, args)
    }
    async fn done(&self, _: &str) {}
}

fn telegram() -> Origin {
    Origin::Channel {
        channel: "telegram".into(),
        chat: "42".into(),
    }
}

fn ctx() -> ToolCtx {
    ToolCtx {
        session: alexia_store::SessionId(1),
        run: RunId("r1".into()),
        origin: telegram(),
        background: false,
        cancel: CancellationToken::new(),
        progress: None,
    }
}

struct Rig {
    sched: Arc<Scheduler>,
    store: Arc<Store>,
    brain: Arc<EchoBrain>,
    cancel: CancellationToken,
    task: Option<tokio::task::JoinHandle<alexia_scheduler::Result<()>>>,
}

impl Rig {
    /// A scheduler over `sources` on paused time, not yet running.
    fn new(sources: Arc<dyn Sources>) -> Rig {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let brain = Arc::new(EchoBrain::default());
        let (wall, start) = (now_ms(), tokio::time::Instant::now());
        let sched = Scheduler::with_parts(
            store.clone(),
            Bus::new(64),
            brain.clone(),
            Box::new(move || wall + start.elapsed().as_millis() as Ms),
            Box::new(Store::jobs),
            sources,
        );
        Rig {
            sched,
            store,
            brain,
            cancel: CancellationToken::new(),
            task: None,
        }
    }

    async fn add(&self, call: Value) -> alexia_core::ToolOutcome {
        self.sched
            .tools()
            .call("schedule.add", call.as_object().unwrap(), &ctx())
            .await
            .unwrap()
    }

    fn start(&mut self) {
        let sched = self.sched.clone();
        self.task = Some(tokio::spawn(sched.run(self.cancel.clone())));
    }

    async fn stop(mut self) {
        self.cancel.cancel();
        if let Some(t) = self.task.take() {
            t.await.unwrap().unwrap();
        }
    }

    fn turns(&self) -> usize {
        self.brain.turns.lock().unwrap().len()
    }
}

fn watch_call(cap: &str, args: Value) -> Value {
    json!({
        "kind": "watch",
        "cap": cap,
        "args": args,
        "every_minutes": 1,
        "prompt": "Tell me what changed."
    })
}

/// `minutes` of paused time.
async fn pass(minutes: u64) {
    tokio::time::sleep(Duration::from_millis(minutes * MIN)).await;
}

#[tokio::test(start_paused = true)]
async fn unwatchable_cap_refused_at_creation() {
    let gate = Gate::new(&["page.text"]);
    let rig = Rig::new(gate.clone());
    let out = rig
        .add(watch_call("shell.run", json!({"command": "echo hi"})))
        .await;
    assert!(!out.ok, "{}", out.text);
    assert_eq!(
        out.text,
        "shell.run can't be watched: a watch may only read something, and that changes things."
    );
    assert!(rig.sched.jobs().unwrap().is_empty());
    assert!(rig.store.jobs().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn watchable_cap_accepted() {
    let gate = Gate::new(&["page.text"]);
    let rig = Rig::new(gate.clone());
    let out = rig.add(watch_call("page.text", json!({"url": "u"}))).await;
    assert!(out.ok, "{}", out.text);
    let jobs = rig.sched.jobs().unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(
        jobs[0].trigger,
        Trigger::Watch {
            cap: "page.text".into(),
            args: json!({"url": "u"}).as_object().unwrap().clone(),
            every_ms: MIN,
        }
    );
}

#[tokio::test(start_paused = true)]
async fn unlocked_stripped_at_creation() {
    let gate = Gate::new(&["page.text"]);
    let mut rig = Rig::new(gate.clone());
    let out = rig
        .add(watch_call(
            "page.text",
            json!({"url": "u", "unlocked": true}),
        ))
        .await;
    assert!(out.ok, "{}", out.text);
    let jobs = rig.sched.jobs().unwrap();
    let Trigger::Watch { args, .. } = &jobs[0].trigger else {
        panic!("not a watch: {:?}", jobs[0].trigger);
    };
    assert_eq!(Value::Object(args.clone()), json!({"url": "u"}));
    rig.start();
    pass(1).await;
    tokio::time::sleep(Duration::from_millis(MIN / 2)).await;
    let polled = gate.polls.all();
    assert!(!polled.is_empty(), "the watch was never polled");
    assert_eq!(polled[0].0, "page.text");
    assert_eq!(Value::Object(polled[0].1.clone()), json!({"url": "u"}));
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn old_row_with_unlocked_is_stripped() {
    let gate = Gate::new(&["memory.recall"]);
    let mut rig = Rig::new(gate.clone());
    // A row as it was stored before P3-39: `unlocked` in the watch's args, due now.
    let trigger = Trigger::Watch {
        cap: "memory.recall".into(),
        args: json!({"query": "bank", "unlocked": true})
            .as_object()
            .unwrap()
            .clone(),
        every_ms: MIN,
    };
    let now = now_ms();
    rig.store
        .job_add(
            &serde_json::to_string(&trigger).unwrap(),
            "Tell me what changed.",
            "normal",
            &serde_json::to_string(&telegram()).unwrap(),
            Some(now),
            now,
        )
        .unwrap();
    rig.start();
    pass(3).await;
    tokio::time::sleep(Duration::from_millis(MIN / 2)).await;
    let polled = gate.polls.all();
    assert!(polled.len() >= 2, "polled {} times", polled.len());
    for (cap, args) in &polled {
        assert_eq!(cap, "memory.recall");
        assert!(!args.contains_key("unlocked"), "{args:?}");
        assert_eq!(args["query"], "bank");
    }
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn gate_rechecked_every_poll() {
    let gate = Gate::new(&["page.text"]);
    let mut rig = Rig::new(gate.clone());
    assert!(
        rig.add(watch_call("page.text", json!({"url": "u"})))
            .await
            .ok
    );
    rig.start();
    // Polls at 1 and 2 minutes: the first records, the second is a change.
    pass(2).await;
    tokio::time::sleep(Duration::from_millis(MIN / 2)).await;
    let before = gate.polls.all().len();
    assert_eq!(before, 2);
    assert_eq!(rig.turns(), 1);

    // The owner marks the plugin unreviewed: due times pass with no poll and no turn.
    gate.set("page.text", false);
    pass(3).await;
    assert_eq!(gate.polls.all().len(), before, "polled while not watchable");
    assert_eq!(rig.turns(), 1, "a turn ran while not watchable");
    // The job is still there.
    assert_eq!(rig.sched.jobs().unwrap().len(), 1);

    // Reviewed again: it polls again.
    gate.set("page.text", true);
    pass(2).await;
    assert!(
        gate.polls.all().len() > before,
        "not polled again once watchable"
    );
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn default_sources_never_poll() {
    let sources = Arc::new(Unknowing::default());
    let mut rig = Rig::new(sources.clone());
    let out = rig.add(watch_call("page.text", json!({"url": "u"}))).await;
    assert!(!out.ok, "{}", out.text);
    assert_eq!(out.text, "page.text can't be watched here.");
    assert!(rig.sched.jobs().unwrap().is_empty());

    // A row that exists anyway (stored before P3-39) is never polled.
    rig.sched
        .add(
            Trigger::Watch {
                cap: "page.text".into(),
                args: json!({"url": "u"}).as_object().unwrap().clone(),
                every_ms: MIN,
            },
            "Tell me what changed.",
            Urgency::Normal,
            telegram(),
        )
        .unwrap();
    rig.start();
    pass(3).await;
    assert!(sources.polls.all().is_empty());
    assert_eq!(rig.turns(), 0);
    rig.stop().await;
}
