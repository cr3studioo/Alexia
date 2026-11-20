// SPDX-License-Identifier: AGPL-3.0-only
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::{
    Brain, BrainError, Bus, DraftSink, Event, JobId, Lane, Origin, Reply, RunId, ToolCtx, Turn,
    Urgency,
};
use alexia_scheduler::{next_after, next_after_in, Scheduler, Trigger};
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

fn setup(brain: Arc<FakeBrain>) -> (Arc<Store>, Bus, Arc<Scheduler>) {
    let store = Arc::new(Store::open_in_memory().unwrap());
    let bus = Bus::new(64);
    let sched = Scheduler::new(store.clone(), bus.clone(), brain);
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
    let second = Scheduler::new(store.clone(), bus.clone(), brain.clone());
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
    assert_eq!(names, ["schedule.add", "schedule.list", "schedule.cancel"]);
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
    assert_eq!(specs[0].params["required"], json!(["kind", "prompt"]));
}
