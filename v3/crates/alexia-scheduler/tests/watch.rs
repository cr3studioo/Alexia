// SPDX-License-Identifier: AGPL-3.0-only
//! P3-07: a watch polls a capability and fires its job only when the answer changes.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::{
    Brain, BrainError, Bus, DraftSink, Lane, Origin, Reply, RunId, ToolCtx, Turn, Urgency,
};
use alexia_scheduler::{next_after, NoticeItem, Scheduler, Sources, Trigger};
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

/// Answers each poll with the next scripted text (the last one repeats); None is an error.
struct Script {
    answers: Mutex<Vec<Option<String>>>,
    polled: Mutex<Vec<(String, Map<String, Value>)>>,
}

impl Script {
    fn new(answers: &[Option<&str>]) -> Arc<Script> {
        Arc::new(Script {
            answers: Mutex::new(answers.iter().rev().map(|a| a.map(str::to_owned)).collect()),
            polled: Mutex::default(),
        })
    }
}

#[async_trait::async_trait]
impl Sources for Script {
    async fn items(&self, _: Ms, _: u32) -> Vec<(String, NoticeItem)> {
        Vec::new()
    }
    async fn sections(&self, _: &str, _: Ms) -> Vec<String> {
        Vec::new()
    }
    async fn poll(&self, cap: &str, args: Map<String, Value>) -> Option<String> {
        self.polled.lock().unwrap().push((cap.into(), args));
        let mut a = self.answers.lock().unwrap();
        if a.len() > 1 {
            a.pop().unwrap()
        } else {
            a.last().cloned().flatten()
        }
    }
    async fn done(&self, _: &str) {}
}

fn telegram() -> Origin {
    Origin::Channel {
        channel: "telegram".into(),
        chat: "42".into(),
    }
}

fn watch() -> Trigger {
    Trigger::Watch {
        cap: "page.text".into(),
        args: json!({ "url": "https://example.invalid/timetable" })
            .as_object()
            .unwrap()
            .clone(),
        every_ms: MIN,
    }
}

/// Runs a scheduler with one watch for `polls` minutes of paused time; the brain's turns.
async fn run(answers: &[Option<&str>], minutes: u64) -> (Arc<Script>, Vec<String>, Arc<Store>) {
    let store = Arc::new(Store::open_in_memory().unwrap());
    let brain = Arc::new(EchoBrain::default());
    let script = Script::new(answers);
    let (wall, start) = (now_ms(), tokio::time::Instant::now());
    let sched = Scheduler::with_parts(
        store.clone(),
        Bus::new(64),
        brain.clone(),
        Box::new(move || wall + start.elapsed().as_millis() as Ms),
        Box::new(Store::jobs),
        script.clone(),
    );
    sched
        .add(
            watch(),
            "Tell me what changed on the timetable.",
            Urgency::Normal,
            telegram(),
        )
        .unwrap();
    let cancel = CancellationToken::new();
    let task = tokio::spawn(sched.clone().run(cancel.clone()));
    // Half a minute past the last poll, so it has run.
    tokio::time::sleep(Duration::from_millis(minutes * MIN + MIN / 2)).await;
    cancel.cancel();
    task.await.unwrap().unwrap();
    let turns = brain.turns.lock().unwrap().clone();
    (script, turns, store)
}

#[tokio::test(start_paused = true)]
async fn first_poll_only_records() {
    let (script, turns, store) = run(&[Some("Mon 9:00 maths")], 1).await;
    assert_eq!(script.polled.lock().unwrap().len(), 1);
    assert!(turns.is_empty());
    assert!(store.kv_get("_core", "watch.1").unwrap().is_some());
}

#[tokio::test(start_paused = true)]
async fn change_fires_with_what_changed() {
    let (script, turns, _) = run(&[Some("Mon 9:00 maths"), Some("Mon 10:00 maths")], 2).await;
    let polled = script.polled.lock().unwrap().clone();
    assert_eq!(polled[0].0, "page.text");
    assert_eq!(polled[0].1["url"], "https://example.invalid/timetable");
    assert_eq!(turns.len(), 1);
    assert_eq!(
        turns[0],
        "Tell me what changed on the timetable.\n\nWhat changed:\nMon 10:00 maths"
    );
}

#[tokio::test(start_paused = true)]
async fn same_text_does_not_fire() {
    let (script, turns, _) = run(&[Some("same")], 3).await;
    assert!(script.polled.lock().unwrap().len() >= 3);
    assert!(turns.is_empty());
}

#[tokio::test(start_paused = true)]
async fn poll_error_changes_nothing() {
    let (_, turns, _) = run(&[Some("a"), None, Some("a")], 3).await;
    assert!(turns.is_empty(), "an error is not a change: {turns:?}");
}

#[test]
fn every_ms_floor_is_one_minute() {
    let t = Trigger::Watch {
        cap: "page.text".into(),
        args: Map::new(),
        every_ms: 5_000,
    };
    assert_eq!(next_after(&t, 1_000), Some(1_000 + MIN as Ms));
    let hourly = Trigger::Watch {
        cap: "page.text".into(),
        args: Map::new(),
        every_ms: 60 * MIN,
    };
    assert_eq!(next_after(&hourly, 0), Some((60 * MIN) as Ms));
}

#[tokio::test]
async fn schedule_add_accepts_a_watch() {
    let store = Arc::new(Store::open_in_memory().unwrap());
    let sched = Scheduler::new(store, Bus::new(8), Arc::new(EchoBrain::default()));
    let tools = sched.tools();
    let c = ToolCtx {
        session: alexia_store::SessionId(1),
        run: RunId("r1".into()),
        origin: telegram(),
        background: false,
        cancel: CancellationToken::new(),
        progress: None,
    };
    let call = json!({
        "kind": "watch",
        "cap": "page.text",
        "args": {"url": "https://example.invalid/timetable"},
        "every_ms": 1_800_000,
        "prompt": "Tell me what changed on the timetable."
    });
    let out = tools
        .call("schedule.add", call.as_object().unwrap(), &c)
        .await
        .unwrap();
    assert!(out.ok, "{}", out.text);
    // Too short a period is raised to a minute; a missing cap is an outcome, not a job.
    let fast = json!({"kind": "watch", "cap": "page.text", "every_ms": 10, "prompt": "p"});
    assert!(
        tools
            .call("schedule.add", fast.as_object().unwrap(), &c)
            .await
            .unwrap()
            .ok
    );
    let bad = json!({"kind": "watch", "prompt": "p"});
    assert!(
        !tools
            .call("schedule.add", bad.as_object().unwrap(), &c)
            .await
            .unwrap()
            .ok
    );

    let jobs = sched.jobs().unwrap();
    assert_eq!(jobs.len(), 2);
    assert_eq!(jobs[0].trigger, watch_every(30 * MIN));
    assert_eq!(
        jobs[1].trigger,
        Trigger::Watch {
            cap: "page.text".into(),
            args: Map::new(),
            every_ms: MIN,
        }
    );
}

fn watch_every(every_ms: u64) -> Trigger {
    match watch() {
        Trigger::Watch { cap, args, .. } => Trigger::Watch {
            cap,
            args,
            every_ms,
        },
        t => t,
    }
}
