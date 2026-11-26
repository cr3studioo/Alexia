// SPDX-License-Identifier: AGPL-3.0-only
//! P3-10: `follow_up` turns reminders, check-ins, overnight errands and timers into one-shot
//! jobs that come back to the chat they were asked in.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::{
    Brain, BrainError, Bus, DraftSink, Event, JobId, Lane, Origin, Reply, RunId, ToolCtx,
    ToolOutcome, Turn, Urgency,
};
use alexia_scheduler::quiet::QUIET_PROPOSED;
use alexia_scheduler::{NoticeItem, Proactive, Scheduler, Sources};
use alexia_store::{Ms, NoticeRow, Store};
use chrono::{FixedOffset, TimeZone};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

const MIN: Ms = 60_000;

/// Answers each turn with the next scripted reply, and keeps the turns.
struct Scripted {
    replies: Mutex<Vec<String>>,
    turns: Mutex<Vec<Turn>>,
}

impl Scripted {
    fn new(replies: &[&str]) -> Arc<Scripted> {
        Arc::new(Scripted {
            replies: Mutex::new(replies.iter().rev().map(|r| r.to_string()).collect()),
            turns: Mutex::new(Vec::new()),
        })
    }

    fn prompts(&self) -> Vec<String> {
        self.turns
            .lock()
            .unwrap()
            .iter()
            .map(|t| t.content.text())
            .collect()
    }
}

#[async_trait::async_trait]
impl Brain for Scripted {
    async fn reply(
        &self,
        turn: Turn,
        _: DraftSink,
        _: CancellationToken,
    ) -> Result<Reply, BrainError> {
        self.turns.lock().unwrap().push(turn);
        let text = self
            .replies
            .lock()
            .unwrap()
            .pop()
            .unwrap_or_else(|| "unscripted".into());
        Ok(Reply {
            text,
            files: vec![],
            lane: Lane::Task,
            model: None,
            spans: vec![],
        })
    }
}

/// Sources with nothing to offer, counting how often they were asked: follow-ups never go
/// through a plugin.
#[derive(Default)]
struct FakeSources {
    asked_done: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl Sources for FakeSources {
    async fn items(&self, _: Ms, _: u32) -> Vec<(String, NoticeItem)> {
        Vec::new()
    }
    async fn sections(&self, _: &str, _: Ms) -> Vec<String> {
        Vec::new()
    }
    async fn poll(&self, _: &str, _: Map<String, Value>) -> Option<String> {
        None
    }
    async fn done(&self, key: &str) {
        self.asked_done.lock().unwrap().push(key.to_string());
    }
}

fn plus1() -> FixedOffset {
    FixedOffset::east_opt(3600).unwrap()
}

/// 2026-05-04 (a Monday) + `day` days at `h:m` in UTC+1.
fn at_day(day: u32, h: u32, m: u32) -> Ms {
    plus1()
        .with_ymd_and_hms(2026, 5, 4 + day, h, m, 0)
        .unwrap()
        .timestamp_millis()
}

fn at(h: u32, m: u32) -> Ms {
    at_day(0, h, m)
}

fn telegram() -> Origin {
    Origin::Channel {
        channel: "telegram".into(),
        chat: "42".into(),
    }
}

struct Rig {
    store: Arc<Store>,
    bus: Bus,
    sched: Arc<Scheduler>,
    brain: Arc<Scripted>,
}

/// A scheduler whose clock starts at `wall` and moves with tokio's paused time, read in UTC+1.
fn setup(wall: Ms, cfg: Proactive, replies: &[&str]) -> Rig {
    let store = Arc::new(Store::open_in_memory().unwrap());
    cfg.save(&store).unwrap();
    let bus = Bus::new(256);
    let brain = Scripted::new(replies);
    let start = tokio::time::Instant::now();
    let sched = Scheduler::with_parts(
        store.clone(),
        bus.clone(),
        brain.clone(),
        Box::new(move || wall + start.elapsed().as_millis() as Ms),
        Box::new(Store::jobs),
        Arc::new(FakeSources::default()),
    );
    sched.set_zone(Some(plus1()));
    Rig {
        store,
        bus,
        sched,
        brain,
    }
}

fn quiet() -> Proactive {
    Proactive {
        quiet: QUIET_PROPOSED,
        ..Proactive::default()
    }
}

/// No quiet hours and no briefs on the clock, so only follow-ups speak.
fn plain() -> Proactive {
    Proactive {
        evening: None,
        weekly: None,
        ..Proactive::default()
    }
}

fn ctx(origin: Origin) -> ToolCtx {
    ToolCtx {
        session: alexia_store::SessionId(1),
        run: RunId("r1".into()),
        origin,
        background: false,
        cancel: CancellationToken::new(),
        progress: None,
    }
}

async fn call(rig: &Rig, name: &str, args: Value) -> ToolOutcome {
    let Value::Object(args) = args else {
        panic!("args must be an object")
    };
    rig.sched
        .tools()
        .call(name, &args, &ctx(telegram()))
        .await
        .expect("a scheduler tool")
}

/// The job id a successful `follow_up` made, read from its undo.
fn job_id(out: &ToolOutcome) -> i64 {
    let undo = out.undo.as_ref().expect("an undo");
    assert_eq!(undo.tool, "schedule.cancel");
    undo.arguments["id"].as_i64().expect("an id")
}

/// One `Say` as the tests look at it.
#[derive(Debug, Clone, PartialEq)]
struct Said {
    text: String,
    urgency: Urgency,
    job: Option<JobId>,
    to: Option<Origin>,
}

/// Runs the scheduler for `for_ms` of paused time; the `Say`s it published.
async fn run_for(rig: &Rig, for_ms: Ms) -> Vec<Said> {
    let mut rx = rig.bus.subscribe();
    let cancel = CancellationToken::new();
    let run = tokio::spawn(rig.sched.clone().run(cancel.clone()));
    tokio::time::sleep(Duration::from_millis(for_ms as u64)).await;
    cancel.cancel();
    run.await.unwrap().unwrap();
    let mut said = Vec::new();
    while let Ok(e) = rx.try_recv() {
        if let Event::Say {
            text,
            urgency,
            job,
            to,
            ..
        } = &*e
        {
            said.push(Said {
                text: text.clone(),
                urgency: *urgency,
                job: *job,
                to: to.clone(),
            });
        }
    }
    said
}

fn notices(store: &Store, source: &str) -> Vec<NoticeRow> {
    store
        .notices_since(0, 100)
        .unwrap()
        .into_iter()
        .filter(|n| n.source == source)
        .collect()
}

#[tokio::test(start_paused = true)]
async fn remind_files_a_notice_at_time() {
    let rig = setup(at(17, 50), plain(), &[]);
    let out = call(
        &rig,
        "follow_up",
        json!({"kind": "remind", "what": "Call mum about Sunday.", "at": "2026-05-04 18:00"}),
    )
    .await;
    assert!(out.ok, "{}", out.text);
    assert!(
        out.text
            .starts_with("I'll come back to it on Mon 04 May at 18:00."),
        "{}",
        out.text
    );
    let id = job_id(&out);
    assert!(
        out.text.contains(&format!("Follow-up {id}")),
        "{}",
        out.text
    );
    let job = &rig.sched.jobs().unwrap()[0];
    assert_eq!(job.origin, telegram());
    assert_eq!(job.next_at, Some(at(18, 0)));
    assert_eq!(job.urgency, Urgency::Normal);

    // Before the time: nothing filed, nothing said.
    let said = run_for(&rig, 9 * MIN).await;
    assert!(said.is_empty(), "{said:?}");
    assert!(notices(&rig.store, "follow").is_empty());

    // At the time: a notice, said by the notice loop, with no model turn.
    let said = run_for(&rig, 5 * MIN).await;
    let filed = notices(&rig.store, "follow");
    assert_eq!(filed.len(), 1, "{filed:?}");
    let n = &filed[0];
    assert_eq!(n.key, format!("follow:{id}"));
    assert_eq!(n.text, "Call mum about Sunday.");
    assert_eq!(n.why, "You asked me to remind you.");
    assert_eq!(n.urgency, "normal");
    assert_eq!(n.state, "said");
    assert_eq!(
        said.iter()
            .map(|s| (s.text.as_str(), s.urgency))
            .collect::<Vec<_>>(),
        [("Call mum about Sunday.", Urgency::Normal)]
    );
    assert!(rig.brain.prompts().is_empty(), "{:?}", rig.brain.prompts());
    // A one-shot: gone from the list once it rang.
    assert!(rig.sched.jobs().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn remind_held_by_quiet_hours() {
    let rig = setup(at(1, 50), quiet(), &[]);
    let out = call(
        &rig,
        "follow_up",
        json!({"kind": "remind", "what": "Take the bins out.", "at": "2026-05-04 02:00"}),
    )
    .await;
    assert!(out.ok, "{}", out.text);
    let said = run_for(&rig, 20 * MIN).await;
    assert!(said.is_empty(), "said in quiet hours: {said:?}");
    let filed = notices(&rig.store, "follow");
    assert_eq!(filed.len(), 1, "{filed:?}");
    assert_eq!(filed[0].state, "held");
    assert_eq!(filed[0].text, "Take the bins out.");
    assert_eq!(filed[0].urgency, "normal");
}

#[tokio::test(start_paused = true)]
async fn timer_rings_even_in_quiet_hours() {
    let rig = setup(at(1, 50), quiet(), &[]);
    let out = call(
        &rig,
        "follow_up",
        json!({"kind": "timer", "what": "The tea is ready", "in_minutes": 20}),
    )
    .await;
    assert!(out.ok, "{}", out.text);
    assert!(
        out.text.starts_with("I'll ring in 20 minutes."),
        "{}",
        out.text
    );
    assert_eq!(rig.sched.jobs().unwrap()[0].urgency, Urgency::High);
    assert_eq!(rig.sched.jobs().unwrap()[0].next_at, Some(at(2, 10)));

    let said = run_for(&rig, 15 * MIN).await;
    assert!(said.is_empty(), "rang early: {said:?}");
    let said = run_for(&rig, 10 * MIN).await;
    assert_eq!(
        said.iter()
            .map(|s| (s.text.as_str(), s.urgency))
            .collect::<Vec<_>>(),
        [("⏰ The tea is ready", Urgency::Urgent)]
    );
    let filed = notices(&rig.store, "follow");
    assert_eq!(filed.len(), 1);
    assert_eq!(filed[0].urgency, "urgent");
    assert_eq!(filed[0].not_before, None);

    // Outside quiet hours a timer stays High.
    let rig = setup(at(12, 0), quiet(), &[]);
    let out = call(
        &rig,
        "follow_up",
        json!({"kind": "timer", "what": "Pasta", "in_minutes": 1}),
    )
    .await;
    assert!(
        out.text.starts_with("I'll ring in 1 minute."),
        "{}",
        out.text
    );
    let said = run_for(&rig, 5 * MIN).await;
    assert_eq!(
        said.iter()
            .map(|s| (s.text.as_str(), s.urgency))
            .collect::<Vec<_>>(),
        [("⏰ Pasta", Urgency::High)]
    );
}

#[tokio::test(start_paused = true)]
async fn check_in_runs_a_turn_and_says_in_origin_chat() {
    let rig = setup(at(10, 0), plain(), &["How did the exam go?"]);
    let out = call(
        &rig,
        "follow_up",
        json!({"kind": "check_in", "what": "the maths exam", "at": "2026-05-04 15:30"}),
    )
    .await;
    assert!(out.ok, "{}", out.text);
    assert!(
        out.text
            .starts_with("I'll check in on Mon 04 May at 15:30."),
        "{}",
        out.text
    );
    let id = job_id(&out);

    let said = run_for(&rig, 6 * 60 * MIN).await;
    assert_eq!(
        rig.brain.prompts(),
        ["Check in with the owner about: the maths exam. Ask one short question."]
    );
    // The turn runs as the scheduler's, in the chat's session.
    let turns = rig.brain.turns.lock().unwrap();
    assert_eq!(turns[0].origin, Origin::Scheduler { job: JobId(id) });
    assert_eq!(
        turns[0].session,
        rig.store.channel_session("telegram", "42").unwrap()
    );
    drop(turns);
    assert_eq!(
        said,
        [Said {
            text: "How did the exam go?".into(),
            urgency: Urgency::Normal,
            job: Some(JobId(id)),
            to: Some(telegram()),
        }]
    );
    assert!(rig.sched.jobs().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn errand_result_waits_for_brief() {
    let reply = "Three flights to Lisbon under 120 euros on Friday.";
    let rig = setup(at(22, 0), plain(), &[reply]);
    let out = call(
        &rig,
        "follow_up",
        json!({"kind": "errand", "what": "Look into flights to Lisbon for Friday."}),
    )
    .await;
    assert!(out.ok, "{}", out.text);
    assert!(
        out.text
            .starts_with("I'll look into it overnight, on Tue 05 May at 02:00."),
        "{}",
        out.text
    );
    let job = &rig.sched.jobs().unwrap()[0];
    assert_eq!(job.next_at, Some(at_day(1, 2, 0)));
    assert_eq!(job.origin, telegram());

    // Through the night, past 02:00.
    let said = run_for(&rig, 4 * 60 * MIN + 30 * MIN).await;
    assert_eq!(
        rig.brain.prompts(),
        ["Look into flights to Lisbon for Friday. Work on this now; your answer goes into the morning brief."]
    );
    assert!(
        !said.iter().any(|s| s.text.contains("Lisbon")),
        "an errand's answer was said: {said:?}"
    );
    let filed = notices(&rig.store, "errand");
    assert_eq!(filed.len(), 1, "{filed:?}");
    assert_eq!(filed[0].text, reply);
    assert_eq!(filed[0].urgency, "low");
    assert_eq!(filed[0].state, "new", "kept for the brief");
    assert!(rig.sched.jobs().unwrap().is_empty());

    // The morning brief carries it.
    let mut rx = rig.bus.subscribe();
    rig.sched.brief_now("morning").await.unwrap();
    let mut briefed = false;
    while let Ok(e) = rx.try_recv() {
        if let Event::Say { text, .. } = &*e {
            briefed |= text.contains(reply);
        }
    }
    assert!(briefed, "the morning brief left the errand out");
}

#[tokio::test(start_paused = true)]
async fn past_time_refused() {
    let rig = setup(at(12, 0), plain(), &[]);
    for args in [
        json!({"kind": "remind", "what": "Lunch", "at": "2026-05-04 11:00"}),
        json!({"kind": "check_in", "what": "Lunch", "at": "2026-05-04 12:00"}),
        json!({"kind": "errand", "what": "Lunch", "at": "2026-05-03 02:00"}),
    ] {
        let out = call(&rig, "follow_up", args).await;
        assert!(!out.ok);
        assert!(out.text.contains("already passed"), "{}", out.text);
        assert!(out.undo.is_none());
    }
    // Other bad arguments get a sentence too.
    for (args, needle) in [
        (
            json!({"kind": "timer", "what": "x", "in_minutes": 0}),
            "in_minutes",
        ),
        (json!({"kind": "timer", "what": "x"}), "in_minutes"),
        (json!({"kind": "remind", "what": "x"}), "Say when"),
        (
            json!({"kind": "remind", "what": "  ", "at": "2026-05-04 13:00"}),
            "what",
        ),
        (json!({"kind": "nap", "what": "x"}), "kind"),
        (
            json!({"kind": "remind", "what": "x", "at": "tomorrow"}),
            "at",
        ),
        (
            json!({"kind": "remind", "what": "x", "at": "2026-05-04 13:00", "urgency": "loud"}),
            "urgency",
        ),
    ] {
        let out = call(&rig, "follow_up", args).await;
        assert!(!out.ok);
        assert!(out.text.contains(needle), "{needle}: {}", out.text);
    }
    assert!(rig.sched.jobs().unwrap().is_empty());
    // A job may not pose as a follow-up.
    let out = call(
        &rig,
        "schedule.add",
        json!({"kind": "at", "at": "2026-05-04T13:00", "prompt": "follow:remind:{\"what\":\"x\"}"}),
    )
    .await;
    assert!(!out.ok, "{}", out.text);
    assert!(rig.sched.jobs().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn undo_cancels() {
    let rig = setup(at(12, 0), plain(), &[]);
    let out = call(
        &rig,
        "follow_up",
        json!({"kind": "remind", "what": "Water the plants.", "at": "2026-05-04 12:30", "urgency": "high"}),
    )
    .await;
    assert!(out.ok, "{}", out.text);
    let id = job_id(&out);
    // Listed in words, not in its stored form.
    let list = call(&rig, "schedule.list", json!({})).await;
    assert!(
        list.text.contains("[high] reminder: Water the plants."),
        "{}",
        list.text
    );
    assert!(!list.text.contains("follow:"), "{}", list.text);

    let undo = out.undo.unwrap();
    let back = call(&rig, &undo.tool, Value::Object(undo.arguments)).await;
    assert!(back.ok, "{}", back.text);
    assert!(rig.sched.jobs().unwrap().is_empty());
    let said = run_for(&rig, 60 * MIN).await;
    assert!(said.is_empty(), "{said:?}");
    assert!(notices(&rig.store, "follow").is_empty());
    let again = call(&rig, "schedule.cancel", json!({"id": id})).await;
    assert!(!again.ok);
}

#[test]
fn follow_up_is_a_listed_tool() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let rig = setup(at(12, 0), plain(), &[]);
        let specs = rig.sched.tools().specs();
        let spec = specs
            .iter()
            .find(|s| s.name == "follow_up")
            .expect("follow_up listed");
        let a = serde_json::to_value(spec.annotations.as_ref().unwrap()).unwrap();
        assert_eq!(a["readOnlyHint"], json!(false));
        assert_eq!(a["destructiveHint"], json!(false));
        assert_eq!(a["openWorldHint"], json!(false));
        assert_eq!(
            spec.params["properties"]["kind"]["enum"],
            json!(["remind", "check_in", "errand", "timer"])
        );
    });
}
