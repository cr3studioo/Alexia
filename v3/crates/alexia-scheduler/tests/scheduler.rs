// SPDX-License-Identifier: AGPL-3.0-only
use std::fmt;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::{
    Brain, BrainError, Builtin, Bus, DraftSink, Event, JobId, Lane, Origin, Reply, RunId, ToolCtx,
    Turn, Urgency,
};
use alexia_scheduler::{next_after, next_after_in, Clock, NoSources, Scheduler, Trigger};
use alexia_store::{now_ms, Ms, Store};
use chrono::{FixedOffset, LocalResult, NaiveDate, NaiveDateTime, Offset, TimeZone, Timelike, Utc};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

const MIN: Ms = 60_000;
const HOUR: Ms = 60 * MIN;
const DAY: Ms = 24 * HOUR;

fn utc_ms(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> Ms {
    Utc.with_ymd_and_hms(y, mo, d, h, mi, 0)
        .unwrap()
        .timestamp_millis()
}

// ---- a time zone with one spring-forward: 2025-03-30, 02:00 local -> 03:00 (UTC+1 -> UTC+2) ----

#[derive(Clone, Copy, Debug)]
struct Cet(i32);
impl fmt::Display for Cet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "+{}", self.0)
    }
}
impl Offset for Cet {
    fn fix(&self) -> FixedOffset {
        FixedOffset::east_opt(self.0 * 3600).unwrap()
    }
}
#[derive(Clone, Copy, Debug)]
struct Springy;
impl Springy {
    fn jump_utc() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2025, 3, 30)
            .unwrap()
            .and_hms_opt(1, 0, 0)
            .unwrap()
    }
}
impl TimeZone for Springy {
    type Offset = Cet;
    fn from_offset(_: &Cet) -> Springy {
        Springy
    }
    fn offset_from_local_date(&self, d: &NaiveDate) -> LocalResult<Cet> {
        self.offset_from_local_datetime(&d.and_hms_opt(12, 0, 0).unwrap())
    }
    fn offset_from_local_datetime(&self, l: &NaiveDateTime) -> LocalResult<Cet> {
        // The local jump: [02:00, 03:00) on the 30th does not exist.
        let start = Self::jump_utc() + chrono::Duration::hours(1);
        if *l < start {
            LocalResult::Single(Cet(1))
        } else if *l < start + chrono::Duration::hours(1) {
            LocalResult::None
        } else {
            LocalResult::Single(Cet(2))
        }
    }
    fn offset_from_utc_date(&self, d: &NaiveDate) -> Cet {
        self.offset_from_utc_datetime(&d.and_hms_opt(12, 0, 0).unwrap())
    }
    fn offset_from_utc_datetime(&self, u: &NaiveDateTime) -> Cet {
        Cet(if *u < Self::jump_utc() { 1 } else { 2 })
    }
}

#[test]
fn next_after_daily_weekly_every_at() {
    let tz = FixedOffset::east_opt(3600).unwrap(); // local = UTC+1
                                                   // 2025-03-03 is a Monday. 08:00 UTC = 09:00 local.
    let mon_0800 = utc_ms(2025, 3, 3, 8, 0);

    let daily = Trigger::Daily {
        hour: 9,
        minute: 30,
    };
    assert_eq!(
        next_after_in(&daily, mon_0800, &tz),
        Some(mon_0800 + 30 * MIN)
    );
    // Exactly at the time: strictly after, so tomorrow.
    assert_eq!(
        next_after_in(&daily, mon_0800 + 30 * MIN, &tz),
        Some(mon_0800 + 30 * MIN + DAY)
    );

    let weekly = Trigger::Weekly {
        weekday: 1,
        hour: 9,
        minute: 0,
    };
    // At Monday 09:00 local itself: next Monday.
    assert_eq!(
        next_after_in(&weekly, mon_0800, &tz),
        Some(mon_0800 + 7 * DAY)
    );
    assert_eq!(next_after_in(&weekly, mon_0800 - 1, &tz), Some(mon_0800));
    // Wednesday asks for the next Monday.
    assert_eq!(
        next_after_in(&weekly, mon_0800 + 2 * DAY + 5 * HOUR, &tz),
        Some(mon_0800 + 7 * DAY)
    );
    let sunday = Trigger::Weekly {
        weekday: 7,
        hour: 0,
        minute: 0,
    };
    assert_eq!(
        next_after_in(&sunday, mon_0800, &tz),
        Some(utc_ms(2025, 3, 8, 23, 0)) // Sunday 00:00 local = Saturday 23:00 UTC
    );

    let every = Trigger::Every {
        period_ms: 10 * MIN as u64,
        from: 1_000,
    };
    assert_eq!(next_after_in(&every, 500, &tz), Some(1_000)); // not started yet
    assert_eq!(next_after_in(&every, 1_000, &tz), Some(1_000 + 10 * MIN));
    assert_eq!(
        next_after_in(&every, 1_000 + 25 * MIN, &tz),
        Some(1_000 + 30 * MIN)
    );

    let at = Trigger::At { at: 5_000 };
    assert_eq!(next_after_in(&at, 4_999, &tz), Some(5_000));
    assert_eq!(next_after_in(&at, 5_000, &tz), None);

    // Nonsense never fires.
    for bad in [
        Trigger::Daily {
            hour: 24,
            minute: 0,
        },
        Trigger::Daily {
            hour: 0,
            minute: 60,
        },
        Trigger::Weekly {
            weekday: 0,
            hour: 9,
            minute: 0,
        },
        Trigger::Weekly {
            weekday: 8,
            hour: 9,
            minute: 0,
        },
        Trigger::Every {
            period_ms: 0,
            from: 0,
        },
    ] {
        assert_eq!(next_after_in(&bad, 0, &tz), None, "{bad:?}");
    }

    // The real local zone: noon every day is 12:00 local, within a day and a bit.
    let now = now_ms();
    let noon = next_after(
        &Trigger::Daily {
            hour: 12,
            minute: 0,
        },
        now,
    )
    .unwrap();
    assert!(noon > now && noon <= now + DAY + 2 * HOUR);
    let local = chrono::Local.timestamp_millis_opt(noon).unwrap();
    assert_eq!((local.hour(), chrono::Timelike::minute(&local)), (12, 0));
}

#[test]
fn dst_spring_forward() {
    let tz = Springy;
    let daily = Trigger::Daily {
        hour: 2,
        minute: 30,
    };
    // Saturday the 29th, noon UTC: 02:30 local on the 29th has passed; the 30th has no 02:30,
    // so it fires at 03:30 local = 01:30 UTC.
    let fire = next_after_in(&daily, utc_ms(2025, 3, 29, 12, 0), &tz).unwrap();
    assert_eq!(fire, utc_ms(2025, 3, 30, 1, 30));
    // After that, the 31st at 02:30 local (+2) = 00:30 UTC.
    assert_eq!(
        next_after_in(&daily, fire, &tz),
        Some(utc_ms(2025, 3, 31, 0, 30))
    );

    // A time that exists on the day is untouched: 09:00 on the 30th is 07:00 UTC.
    let nine = Trigger::Daily { hour: 9, minute: 0 };
    assert_eq!(
        next_after_in(&nine, utc_ms(2025, 3, 29, 12, 0), &tz),
        Some(utc_ms(2025, 3, 30, 7, 0))
    );
    // The day before is still +1: 09:00 on the 29th is 08:00 UTC.
    assert_eq!(
        next_after_in(&nine, utc_ms(2025, 3, 28, 12, 0), &tz),
        Some(utc_ms(2025, 3, 29, 8, 0))
    );
}

// ---- fakes ----

#[derive(Default)]
struct FakeBrain {
    turns: Mutex<Vec<Turn>>,
    fail: bool,
    /// Ends every turn `Cancelled` on its own, as a run stopped by itself does.
    stop: bool,
}
impl FakeBrain {
    fn count(&self) -> usize {
        self.turns.lock().unwrap().len()
    }
}
#[async_trait::async_trait]
impl Brain for FakeBrain {
    async fn reply(
        &self,
        turn: Turn,
        _: DraftSink,
        _: CancellationToken,
    ) -> Result<Reply, BrainError> {
        let text = format!("answer to: {}", turn.content.text());
        self.turns.lock().unwrap().push(turn);
        if self.fail {
            return Err(BrainError::Unavailable("no model is up".into()));
        }
        if self.stop {
            return Err(BrainError::Cancelled);
        }
        Ok(Reply {
            text,
            files: vec![],
            lane: Lane::Task,
            model: None,
            spans: vec![],
        })
    }
}

fn telegram() -> Origin {
    Origin::Channel {
        channel: "telegram".into(),
        chat: "42".into(),
    }
}

/// Wall time at the call plus tokio's (paused-able) elapsed time, so virtual sleeps move it.
fn paused_clock() -> Clock {
    let (wall, at) = (now_ms(), tokio::time::Instant::now());
    Box::new(move || wall + at.elapsed().as_millis() as Ms)
}

fn setup(brain: Arc<FakeBrain>) -> (Arc<Store>, Bus, Arc<Scheduler>) {
    let store = Arc::new(Store::open_in_memory().unwrap());
    let bus = Bus::new(64);
    let sched = Scheduler::with_parts(
        store.clone(),
        bus.clone(),
        brain,
        paused_clock(),
        Box::new(Store::jobs),
        Arc::new(NoSources),
    );
    (store, bus, sched)
}

/// The next `Say`, with a virtual-time bound (paused time jumps ahead while everything idles).
async fn next_say(
    rx: &mut tokio::sync::broadcast::Receiver<Arc<Event>>,
    within: Duration,
) -> Option<(String, Urgency, Option<JobId>)> {
    tokio::time::timeout(within, async {
        loop {
            if let Event::Say {
                text, urgency, job, ..
            } = &*rx.recv().await.unwrap()
            {
                return (text.clone(), *urgency, *job);
            }
        }
    })
    .await
    .ok()
}

#[tokio::test(start_paused = true)]
async fn fires_through_brain_and_says() {
    let brain = Arc::new(FakeBrain::default());
    let (store, bus, sched) = setup(brain.clone());
    let mut rx = bus.subscribe();
    let id = sched
        .add(
            Trigger::At {
                at: now_ms() + HOUR,
            },
            "check the portal",
            Urgency::High,
            telegram(),
        )
        .unwrap();
    let cancel = CancellationToken::new();
    let run = tokio::spawn(sched.clone().run(cancel.clone()));

    let (text, urgency, job) = next_say(&mut rx, Duration::from_secs(2 * 3600))
        .await
        .expect("a Say");
    assert_eq!(text, "answer to: check the portal");
    assert_eq!(urgency, Urgency::High);
    assert_eq!(job, Some(id));

    {
        let turns = brain.turns.lock().unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].origin, Origin::Scheduler { job: id });
        assert_eq!(turns[0].content.text(), "check the portal");
        // The session is the chat's own.
        assert_eq!(
            turns[0].session,
            store.channel_session("telegram", "42").unwrap()
        );
    }
    // A one-shot is done and gone from the list.
    assert!(sched.jobs().unwrap().is_empty());

    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(30), run)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_failed_turn_is_said_not_swallowed() {
    let brain = Arc::new(FakeBrain {
        fail: true,
        ..Default::default()
    });
    let (_, bus, sched) = setup(brain);
    let mut rx = bus.subscribe();
    sched
        .add(
            Trigger::At { at: now_ms() + MIN },
            "x",
            Urgency::Normal,
            telegram(),
        )
        .unwrap();
    let cancel = CancellationToken::new();
    let run = tokio::spawn(sched.clone().run(cancel.clone()));
    let (text, _, _) = next_say(&mut rx, Duration::from_secs(3600))
        .await
        .expect("a Say");
    assert!(text.contains("no model is up"), "{text}");
    cancel.cancel();
    run.await.unwrap().unwrap();
}

#[tokio::test(start_paused = true)]
async fn missed_while_off_fires_once() {
    let brain = Arc::new(FakeBrain::default());
    let (store, bus, sched) = setup(brain.clone());
    let mut rx = bus.subscribe();
    // Hourly from 2.5 hours ago; its last due time (1.5 h ago) passed while the hub was off,
    // and so did two before it. The next regular time is 30 minutes away.
    let now = now_ms();
    let trigger = Trigger::Every {
        period_ms: HOUR as u64,
        from: now - 150 * MIN,
    };
    store
        .job_add(
            &serde_json::to_string(&trigger).unwrap(),
            "tick",
            "normal",
            &serde_json::to_string(&telegram()).unwrap(),
            Some(now - 90 * MIN),
            now - 150 * MIN,
        )
        .unwrap();
    let cancel = CancellationToken::new();
    let run = tokio::spawn(sched.clone().run(cancel.clone()));

    next_say(&mut rx, Duration::from_secs(600))
        .await
        .expect("one catch-up Say");
    assert_eq!(brain.count(), 1);
    // Ten more minutes pass: not due again (next is ~30 min out), still one turn.
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(brain.count(), 1);
    let next = sched.jobs().unwrap()[0].next_at.unwrap();
    assert!(next > now + 20 * MIN);
    // And it is a regular slot: from + k * period.
    assert_eq!((next - (now - 150 * MIN)) % HOUR, 0);

    cancel.cancel();
    run.await.unwrap().unwrap();
}

#[tokio::test(start_paused = true)]
async fn cancel_stops() {
    let brain = Arc::new(FakeBrain::default());
    let (_, bus, sched) = setup(brain.clone());
    let mut rx = bus.subscribe();
    let id = sched
        .add(
            Trigger::At {
                at: now_ms() + HOUR,
            },
            "never",
            Urgency::Normal,
            telegram(),
        )
        .unwrap();
    let cancel = CancellationToken::new();
    let run = tokio::spawn(sched.clone().run(cancel.clone()));
    tokio::time::sleep(Duration::from_secs(60)).await; // running, waiting
    assert!(sched.cancel(id).unwrap());
    assert!(!sched.cancel(id).unwrap(), "second cancel finds nothing");
    assert!(sched.jobs().unwrap().is_empty());

    tokio::time::sleep(Duration::from_secs(2 * 3600)).await;
    assert_eq!(brain.count(), 0);
    while let Ok(ev) = rx.try_recv() {
        assert!(
            !matches!(&*ev, Event::Say { .. } | Event::Fired { .. }),
            "{ev:?}"
        );
    }
    cancel.cancel();
    run.await.unwrap().unwrap();
}

#[tokio::test(start_paused = true)]
async fn survives_restart() {
    let brain = Arc::new(FakeBrain::default());
    let (store, bus, first) = setup(brain.clone());
    let weekly = Trigger::Weekly {
        weekday: 1,
        hour: 9,
        minute: 0,
    };
    let once = first
        .add(
            Trigger::At {
                at: now_ms() + 10 * MIN,
            },
            "later",
            Urgency::Low,
            telegram(),
        )
        .unwrap();
    let w = first
        .add(weekly.clone(), "monday", Urgency::Normal, Origin::Desktop)
        .unwrap();
    let before = first.jobs().unwrap();
    drop(first);

    // A new Scheduler on the same store: the jobs are rows.
    let second = Scheduler::with_parts(
        store.clone(),
        bus.clone(),
        brain.clone(),
        paused_clock(),
        Box::new(Store::jobs),
        Arc::new(NoSources),
    );
    assert_eq!(second.jobs().unwrap(), before);
    assert_eq!(before[1].id, w);
    assert_eq!(before[1].trigger, weekly);
    assert_eq!(before[1].origin, Origin::Desktop);
    assert!(before[1].next_at.is_some());

    let mut rx = bus.subscribe();
    let cancel = CancellationToken::new();
    let run = tokio::spawn(second.clone().run(cancel.clone()));
    let (text, urgency, job) = next_say(&mut rx, Duration::from_secs(3600))
        .await
        .expect("a Say");
    assert_eq!(
        (text.as_str(), urgency, job),
        ("answer to: later", Urgency::Low, Some(once))
    );
    cancel.cancel();
    run.await.unwrap().unwrap();
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

fn args(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

#[tokio::test]
async fn add_tool_returns_undo() {
    let (_, _, sched) = setup(Arc::new(FakeBrain::default()));
    let tools = sched.tools();
    let c = ctx(telegram());

    let out = tools
        .call(
            "schedule.add",
            &args(json!({"kind": "weekly", "weekday": 1, "hour": 9, "prompt": "check my school portal"})),
            &c,
        )
        .await
        .unwrap();
    assert!(out.ok, "{}", out.text);
    let jobs = sched.jobs().unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(
        jobs[0].trigger,
        Trigger::Weekly {
            weekday: 1,
            hour: 9,
            minute: 0
        }
    );
    assert_eq!(jobs[0].prompt, "check my school portal");
    assert_eq!(jobs[0].origin, telegram());

    let undo = out.undo.expect("an undo");
    assert_eq!(undo.tool, "schedule.cancel");
    assert_eq!(undo.arguments["id"], json!(jobs[0].id.0));
    // Running the undo removes the job.
    let undone = tools.call(&undo.tool, &undo.arguments, &c).await.unwrap();
    assert!(undone.ok, "{}", undone.text);
    assert!(sched.jobs().unwrap().is_empty());

    // list sees jobs; bad input is an outcome, not a job.
    tools
        .call(
            "schedule.add",
            &args(json!({"kind": "every", "every_minutes": 5, "prompt": "ping"})),
            &c,
        )
        .await
        .unwrap();
    let list = tools.call("schedule.list", &Map::new(), &c).await.unwrap();
    assert!(
        list.ok && list.text.contains("ping") && list.text.contains("every 5 min"),
        "{}",
        list.text
    );
    for bad in [
        json!({"kind": "daily", "hour": 25, "prompt": "x"}),
        json!({"kind": "weekly", "hour": 9, "prompt": "x"}),
        json!({"kind": "sometimes", "prompt": "x"}),
        json!({"kind": "daily", "hour": 9}),
        json!({"kind": "daily", "hour": 9, "prompt": "x", "urgency": "shouty"}),
        json!({"kind": "at", "at": "2001-01-01T09:00", "prompt": "x"}),
    ] {
        let o = tools
            .call("schedule.add", &args(bad.clone()), &c)
            .await
            .unwrap();
        assert!(!o.ok && o.undo.is_none(), "{bad}: {}", o.text);
    }
    assert_eq!(sched.jobs().unwrap().len(), 1);
    // Not a tool of mine.
    assert!(tools.call("other.thing", &Map::new(), &c).await.is_none());
}

#[tokio::test]
async fn a_scheduled_run_schedules_into_its_jobs_own_chat() {
    let (_, _, sched) = setup(Arc::new(FakeBrain::default()));
    let parent = sched
        .add(
            Trigger::Daily { hour: 8, minute: 0 },
            "p",
            Urgency::Normal,
            telegram(),
        )
        .unwrap();
    let out = sched
        .tools()
        .call(
            "schedule.add",
            &args(json!({"kind": "every", "every_minutes": 30, "prompt": "again"})),
            &ctx(Origin::Scheduler { job: parent }),
        )
        .await
        .unwrap();
    assert!(out.ok, "{}", out.text);
    assert_eq!(sched.jobs().unwrap()[1].origin, telegram());
    // A job with no chat to answer in is refused outright.
    assert!(sched
        .add(
            Trigger::Daily { hour: 8, minute: 0 },
            "p",
            Urgency::Normal,
            Origin::Scheduler { job: parent }
        )
        .is_err());
}

#[test]
fn tools_have_annotations() {
    let (_, _, sched) = setup(Arc::new(FakeBrain::default()));
    let specs = sched.tools().specs();
    let names: Vec<_> = specs.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "schedule.add",
            "schedule.list",
            "schedule.cancel",
            "brief_now"
        ]
    );
    for s in &specs {
        assert!(s.description.len() > 20, "{}", s.name);
        assert_eq!(s.params["type"], "object");
        assert!(s.reviewed && s.plugin.is_none() && !s.words.is_empty());
        let a = s
            .annotations
            .as_ref()
            .unwrap_or_else(|| panic!("{} has annotations", s.name));
        assert_eq!(a.destructive_hint, Some(false), "{}", s.name);
    }
    let ro = |n: &str| {
        specs
            .iter()
            .find(|s| s.name == n)
            .unwrap()
            .annotations
            .as_ref()
            .unwrap()
            .read_only_hint
    };
    assert_eq!(ro("schedule.add"), Some(false));
    assert_eq!(ro("schedule.list"), Some(true));
    assert_eq!(ro("schedule.cancel"), Some(false));
    assert_eq!(ro("brief_now"), Some(true));
    assert_eq!(specs[0].params["required"], json!(["kind", "prompt"]));
}

#[test]
fn every_with_far_negative_from_does_not_overflow() {
    let tz = FixedOffset::east_opt(0).unwrap();
    for p in [1u64, 1_000] {
        let t = Trigger::Every {
            period_ms: p,
            from: i64::MIN,
        };
        // Used to panic (debug) or wrap on `now - from`.
        let _ = next_after_in(&t, 0, &tz);
    }
    let t = Trigger::Every {
        period_ms: 1,
        from: i64::MIN,
    };
    assert_eq!(next_after_in(&t, i64::MAX, &tz), None);
}

#[tokio::test(start_paused = true)]
async fn a_jumped_wall_clock_is_seen() {
    let brain = Arc::new(FakeBrain::default());
    let store = Arc::new(Store::open_in_memory().unwrap());
    let bus = Bus::new(64);
    let start = now_ms();
    let wall = Arc::new(AtomicI64::new(start));
    let w = wall.clone();
    let sched = Scheduler::with_parts(
        store,
        bus.clone(),
        brain.clone(),
        Box::new(move || w.load(Ordering::SeqCst)),
        Box::new(Store::jobs),
        Arc::new(NoSources),
    );
    let mut rx = bus.subscribe();
    sched
        .add(
            Trigger::At {
                at: start + 5 * HOUR,
            },
            "late",
            Urgency::Normal,
            telegram(),
        )
        .unwrap();
    let cancel = CancellationToken::new();
    let run = tokio::spawn(sched.clone().run(cancel.clone()));
    // Wall time frozen: five idle virtual minutes fire nothing.
    tokio::time::sleep(Duration::from_secs(300)).await;
    assert_eq!(brain.count(), 0);
    // The machine slept: the wall clock jumps past the due time; the next recheck sees it.
    wall.store(start + 6 * HOUR, Ordering::SeqCst);
    next_say(&mut rx, Duration::from_secs(600))
        .await
        .expect("fires after the jump");
    cancel.cancel();
    run.await.unwrap().unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_failed_job_read_is_retried() {
    let brain = Arc::new(FakeBrain::default());
    let store = Arc::new(Store::open_in_memory().unwrap());
    let bus = Bus::new(64);
    let reads = Arc::new(AtomicUsize::new(0));
    let r = reads.clone();
    let sched = Scheduler::with_parts(
        store,
        bus.clone(),
        brain.clone(),
        paused_clock(),
        Box::new(move |s: &Store| {
            if r.fetch_add(1, Ordering::SeqCst) == 0 {
                Err(alexia_store::Error::Invalid("disk hiccup".into()))
            } else {
                s.jobs()
            }
        }),
        Arc::new(NoSources),
    );
    // add() does not read; the run loop's very first read is the one that fails.
    sched
        .add(
            Trigger::At { at: now_ms() + MIN },
            "x",
            Urgency::Normal,
            telegram(),
        )
        .unwrap();
    let mut rx = bus.subscribe();
    let cancel = CancellationToken::new();
    let run = tokio::spawn(sched.clone().run(cancel.clone()));
    next_say(&mut rx, Duration::from_secs(600))
        .await
        .expect("fires after the failed read");
    assert!(reads.load(Ordering::SeqCst) >= 2);
    cancel.cancel();
    // run() ends Ok, not with the read error.
    run.await.unwrap().unwrap();
}

/// A brain whose turn calls schedule.add through the scheduler's tools, as a scheduled run does.
struct AddingBrain {
    sched: Mutex<Option<Arc<Scheduler>>>,
    outcome: Mutex<Option<(bool, String)>>,
}
#[async_trait::async_trait]
impl Brain for AddingBrain {
    async fn reply(
        &self,
        turn: Turn,
        _: DraftSink,
        _: CancellationToken,
    ) -> Result<Reply, BrainError> {
        let sched = self.sched.lock().unwrap().clone().unwrap();
        let out = sched
            .tools()
            .call(
                "schedule.add",
                &args(json!({"kind": "every", "every_minutes": 30, "prompt": "again"})),
                &ctx(turn.origin),
            )
            .await
            .unwrap();
        *self.outcome.lock().unwrap() = Some((out.ok, out.text));
        Ok(Reply {
            text: "done".into(),
            files: vec![],
            lane: Lane::Task,
            model: None,
            spans: vec![],
        })
    }
}

#[tokio::test(start_paused = true)]
async fn a_one_shot_can_schedule_from_its_own_turn() {
    let brain = Arc::new(AddingBrain {
        sched: Mutex::new(None),
        outcome: Mutex::new(None),
    });
    let store = Arc::new(Store::open_in_memory().unwrap());
    let bus = Bus::new(64);
    let sched = Scheduler::with_parts(
        store,
        bus.clone(),
        brain.clone(),
        paused_clock(),
        Box::new(Store::jobs),
        Arc::new(NoSources),
    );
    *brain.sched.lock().unwrap() = Some(sched.clone());
    sched
        .add(
            Trigger::At { at: now_ms() + MIN },
            "once",
            Urgency::Normal,
            telegram(),
        )
        .unwrap();
    let mut rx = bus.subscribe();
    let cancel = CancellationToken::new();
    let run = tokio::spawn(sched.clone().run(cancel.clone()));
    next_say(&mut rx, Duration::from_secs(600))
        .await
        .expect("a Say");
    let (ok, text) = brain.outcome.lock().unwrap().clone().unwrap();
    assert!(ok, "{text}");
    // The one-shot is gone; the job it made remains, in the same chat.
    let jobs = sched.jobs().unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].prompt, "again");
    assert_eq!(jobs[0].origin, telegram());
    cancel.cancel();
    run.await.unwrap().unwrap();
}

/// A brain whose turn takes `delay` (or, with None, waits until it is cancelled), counting how
/// many turns it was asked for and the most it ever had in flight at once.
#[derive(Default)]
struct SlowBrain {
    delay: Option<Duration>,
    asked: AtomicUsize,
    in_flight: AtomicUsize,
    most: AtomicUsize,
}
#[async_trait::async_trait]
impl Brain for SlowBrain {
    async fn reply(
        &self,
        _: Turn,
        _: DraftSink,
        cancel: CancellationToken,
    ) -> Result<Reply, BrainError> {
        self.asked.fetch_add(1, Ordering::SeqCst);
        let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.most.fetch_max(now, Ordering::SeqCst);
        let work = async {
            match self.delay {
                Some(d) => tokio::time::sleep(d).await,
                None => std::future::pending().await,
            }
        };
        let done = tokio::select! {
            () = cancel.cancelled() => false,
            () = work => true,
        };
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        if !done {
            return Err(BrainError::Cancelled);
        }
        Ok(Reply {
            text: "slow answer".into(),
            files: vec![],
            lane: Lane::Task,
            model: None,
            spans: vec![],
        })
    }
}

/// One time base per test, so a restarted Scheduler's clock carries on from the first one's
/// (`paused_clock` restarts from the real wall time).
type Base = (Ms, tokio::time::Instant);
fn base() -> Base {
    (now_ms(), tokio::time::Instant::now())
}

fn sched_on(store: &Arc<Store>, brain: &Arc<SlowBrain>, (wall, at): Base) -> Arc<Scheduler> {
    Scheduler::with_parts(
        store.clone(),
        Bus::new(64),
        brain.clone(),
        Box::new(move || wall + at.elapsed().as_millis() as Ms),
        Box::new(Store::jobs),
        Arc::new(NoSources),
    )
}

/// Lets virtual time run until `brain` has been asked `n` times (bounded).
async fn until_asked(brain: &SlowBrain, n: usize) {
    tokio::time::timeout(Duration::from_secs(3600), async {
        while brain.asked.load(Ordering::SeqCst) < n {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the brain was asked {n} times"));
}

#[tokio::test(start_paused = true)]
async fn one_shot_cut_short_at_shutdown_fires_after_restart() {
    let brain = Arc::new(SlowBrain::default());
    let store = Arc::new(Store::open_in_memory().unwrap());
    let t0 = base();
    let first = sched_on(&store, &brain, t0);
    let id = first
        .add(
            Trigger::At { at: t0.0 + MIN },
            "once",
            Urgency::Normal,
            telegram(),
        )
        .unwrap();
    let cancel = CancellationToken::new();
    let run = tokio::spawn(first.clone().run(cancel.clone()));
    until_asked(&brain, 1).await;
    // The hub shuts down mid-turn; shutdown itself does not start the job again.
    cancel.cancel();
    run.await.unwrap().unwrap();
    assert_eq!(brain.asked.load(Ordering::SeqCst), 1);
    let left = first.jobs().unwrap();
    drop(first);
    assert_eq!(left.len(), 1, "the one-shot is still listed");
    assert_eq!(left[0].id, id);
    assert!(left[0].next_at.is_some(), "and due again");

    // Next start: it fires once, as a time missed while off does.
    let second = sched_on(&store, &brain, t0);
    let cancel = CancellationToken::new();
    let run = tokio::spawn(second.clone().run(cancel.clone()));
    until_asked(&brain, 2).await;
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(brain.asked.load(Ordering::SeqCst), 2);
    cancel.cancel();
    run.await.unwrap().unwrap();
}

#[tokio::test(start_paused = true)]
async fn one_shot_cancelled_by_owner_while_running_stays_cancelled() {
    let brain = Arc::new(SlowBrain::default());
    let store = Arc::new(Store::open_in_memory().unwrap());
    let t0 = base();
    let first = sched_on(&store, &brain, t0);
    let id = first
        .add(
            Trigger::At { at: t0.0 + MIN },
            "once",
            Urgency::Normal,
            telegram(),
        )
        .unwrap();
    let cancel = CancellationToken::new();
    let run = tokio::spawn(first.clone().run(cancel.clone()));
    until_asked(&brain, 1).await;
    // schedule.cancel while the turn runs, then shutdown cuts the turn short.
    assert!(first.cancel(id).unwrap());
    cancel.cancel();
    run.await.unwrap().unwrap();
    assert!(first.jobs().unwrap().is_empty(), "the owner's cancel wins");
    assert!(!first.cancel(id).unwrap(), "still cancelled");

    let second = sched_on(&store, &brain, t0);
    let cancel = CancellationToken::new();
    let run = tokio::spawn(second.clone().run(cancel.clone()));
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(brain.asked.load(Ordering::SeqCst), 1, "never asked again");
    cancel.cancel();
    run.await.unwrap().unwrap();
}

#[tokio::test(start_paused = true)]
async fn every_does_not_overlap_itself() {
    let brain = Arc::new(SlowBrain {
        delay: Some(Duration::from_millis(300)),
        ..Default::default()
    });
    let store = Arc::new(Store::open_in_memory().unwrap());
    let t0 = base();
    let sched = sched_on(&store, &brain, t0);
    sched
        .add(
            Trigger::Every {
                period_ms: 50,
                from: t0.0 + 50,
            },
            "tick",
            Urgency::Normal,
            telegram(),
        )
        .unwrap();
    let cancel = CancellationToken::new();
    let run = tokio::spawn(sched.clone().run(cancel.clone()));
    // Three slow turns take ~900 ms of virtual time: ~18 due times pass meanwhile.
    until_asked(&brain, 3).await;
    assert_eq!(
        brain.most.load(Ordering::SeqCst),
        1,
        "never two turns at once"
    );
    cancel.cancel();
    run.await.unwrap().unwrap();
}

// ---- the tools hold the scheduler weakly (no Agent -> tools -> Scheduler -> Agent cycle) ----

#[test]
fn schedule_tools_do_not_keep_scheduler_alive() {
    let (_, _, sched) = setup(Arc::new(FakeBrain::default()));
    let tools = sched.tools();
    let weak = Arc::downgrade(&sched);
    drop(sched);
    assert!(
        weak.upgrade().is_none(),
        "the tools kept the scheduler alive"
    );
    // specs need no scheduler.
    let names: Vec<_> = tools.specs().into_iter().map(|s| s.name).collect();
    assert_eq!(
        names,
        [
            "schedule.add",
            "schedule.list",
            "schedule.cancel",
            "brief_now"
        ]
    );
}

#[tokio::test]
async fn schedule_tools_after_drop_say_not_running() {
    let (_, _, sched) = setup(Arc::new(FakeBrain::default()));
    let tools = sched.tools();
    drop(sched);
    let c = ctx(telegram());
    for (name, a) in [
        (
            "schedule.add",
            json!({"kind": "every", "every_minutes": 5, "prompt": "ping"}),
        ),
        ("schedule.list", json!({})),
        ("schedule.cancel", json!({"id": 1})),
    ] {
        let out = tools.call(name, &args(a), &c).await.unwrap();
        assert!(!out.ok && out.undo.is_none(), "{name}: {}", out.text);
        assert_eq!(out.text, "Scheduled jobs are not running.", "{name}");
    }
    assert!(tools.call("other.thing", &Map::new(), &c).await.is_none());
}

/// A brain that, like the Agent, owns the scheduler's tools.
#[derive(Default)]
struct HoldingBrain {
    tools: Mutex<Option<Arc<dyn Builtin>>>,
}
#[async_trait::async_trait]
impl Brain for HoldingBrain {
    async fn reply(
        &self,
        _: Turn,
        _: DraftSink,
        _: CancellationToken,
    ) -> Result<Reply, BrainError> {
        Err(BrainError::Unavailable("not used".into()))
    }
}

#[test]
fn brain_holding_tools_is_no_cycle() {
    let brain = Arc::new(HoldingBrain::default());
    let store = Arc::new(Store::open_in_memory().unwrap());
    let sched = Scheduler::new(store, Bus::new(8), brain.clone());
    *brain.tools.lock().unwrap() = Some(sched.tools());
    let weak = Arc::downgrade(&sched);
    let weak_brain = Arc::downgrade(&brain);
    drop(sched);
    drop(brain);
    assert!(weak.upgrade().is_none(), "scheduler leaked through a cycle");
    assert!(
        weak_brain.upgrade().is_none(),
        "brain leaked through a cycle"
    );
}

#[test]
fn slash_prompt_refused() {
    let (_, _, sched) = setup(Arc::new(FakeBrain::default()));
    for prompt in ["/approve 1", "  /undo"] {
        let r = sched.add(
            Trigger::At {
                at: now_ms() + HOUR,
            },
            prompt,
            Urgency::Normal,
            telegram(),
        );
        let e = r.expect_err(prompt).to_string();
        assert!(e.contains("not a command"), "{prompt}: {e}");
    }
    assert!(sched.jobs().unwrap().is_empty(), "no job row");
}

#[tokio::test(start_paused = true)]
async fn stopped_run_finishes_one_shot() {
    let brain = Arc::new(FakeBrain {
        stop: true,
        ..Default::default()
    });
    let (_, _, sched) = setup(brain.clone());
    sched
        .add(
            Trigger::At { at: now_ms() + MIN },
            "once",
            Urgency::Normal,
            telegram(),
        )
        .unwrap();
    let cancel = CancellationToken::new();
    let run = tokio::spawn(sched.clone().run(cancel.clone()));
    tokio::time::timeout(Duration::from_secs(3600), async {
        // A kept one-shot is overdue and fires again at once, so stop at the second turn too.
        while brain.count() < 2 && !(brain.count() == 1 && sched.jobs().unwrap().is_empty()) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the one-shot fired");
    assert_eq!(brain.count(), 1, "a stopped one-shot must not fire again");
    assert!(sched.jobs().unwrap().is_empty(), "and it is finished");
    // It does not fire again.
    tokio::time::sleep(Duration::from_secs(3600)).await;
    assert_eq!(brain.count(), 1);
    cancel.cancel();
    run.await.unwrap().unwrap();
}
