// SPDX-License-Identifier: AGPL-3.0-only
//! P3-07: quiet hours and the owner's pause hold a job's reply as a notice; Urgent gets through.
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::{Brain, BrainError, Bus, DraftSink, Event, Lane, Origin, Reply, Turn, Urgency};
use alexia_scheduler::quiet::{local_hm, QUIET_PROPOSED};
use alexia_scheduler::{NoSources, Proactive, Scheduler, Trigger};
use alexia_store::{Ms, Store};
use chrono::{FixedOffset, LocalResult, NaiveDate, NaiveDateTime, Offset, TimeZone, Utc};
use tokio_util::sync::CancellationToken;

const MIN: Ms = 60_000;

#[derive(Default)]
struct EchoBrain {
    turns: Mutex<Vec<Turn>>,
}

#[async_trait::async_trait]
impl Brain for EchoBrain {
    async fn reply(
        &self,
        turn: Turn,
        _: DraftSink,
        _: CancellationToken,
    ) -> Result<Reply, BrainError> {
        let text = format!("answer to: {}", turn.content.text());
        self.turns.lock().unwrap().push(turn);
        Ok(Reply {
            text,
            files: vec![],
            lane: Lane::Task,
            model: None,
            spans: vec![],
        })
    }
}

fn plus1() -> FixedOffset {
    FixedOffset::east_opt(3600).unwrap()
}

/// 2026-05-04 at `h:m` in UTC+1.
fn at(h: u32, m: u32) -> Ms {
    plus1()
        .with_ymd_and_hms(2026, 5, 4, h, m, 0)
        .unwrap()
        .timestamp_millis()
}

fn telegram() -> Origin {
    Origin::Channel {
        channel: "telegram".into(),
        chat: "42".into(),
    }
}

/// A scheduler whose clock starts at `wall` and moves with tokio's paused time, quiet hours as
/// proposed (23:00–07:00, Urgent through), read in UTC+1.
fn setup(wall: Ms, cfg: Proactive) -> (Arc<Store>, Bus, Arc<Scheduler>) {
    let store = Arc::new(Store::open_in_memory().unwrap());
    cfg.save(&store).unwrap();
    let bus = Bus::new(64);
    let start = tokio::time::Instant::now();
    let sched = Scheduler::with_parts(
        store.clone(),
        bus.clone(),
        Arc::new(EchoBrain::default()),
        Box::new(move || wall + start.elapsed().as_millis() as Ms),
        Box::new(Store::jobs),
        Arc::new(NoSources),
    );
    sched.set_zone(Some(plus1()));
    (store, bus, sched)
}

fn quiet() -> Proactive {
    Proactive {
        quiet: QUIET_PROPOSED,
        ..Proactive::default()
    }
}

/// Runs the scheduler for `for_ms` of paused time; the `Say`s it published.
async fn run_for(bus: &Bus, sched: &Arc<Scheduler>, for_ms: u64) -> Vec<(String, Urgency)> {
    let mut rx = bus.subscribe();
    let cancel = CancellationToken::new();
    let run = tokio::spawn(sched.clone().run(cancel.clone()));
    tokio::time::sleep(Duration::from_millis(for_ms)).await;
    cancel.cancel();
    run.await.unwrap().unwrap();
    let mut said = Vec::new();
    while let Ok(e) = rx.try_recv() {
        if let Event::Say { text, urgency, .. } = &*e {
            said.push((text.clone(), *urgency));
        }
    }
    said
}

#[tokio::test(start_paused = true)]
async fn quiet_hours_hold_a_normal_reply_until_seven() {
    let (store, bus, sched) = setup(at(1, 55), quiet());
    sched
        .add(
            Trigger::At { at: at(2, 0) },
            "check the portal",
            Urgency::Normal,
            telegram(),
        )
        .unwrap();
    let said = run_for(&bus, &sched, 10 * MIN as u64).await;
    assert!(said.is_empty(), "said in quiet hours: {said:?}");
    let live = store.notices_live().unwrap();
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].state, "held");
    assert_eq!(live[0].source, "job");
    assert_eq!(live[0].text, "answer to: check the portal");
    assert_eq!(live[0].not_before, Some(at(7, 0)));
}

#[tokio::test(start_paused = true)]
async fn urgent_is_said_at_two() {
    let (store, bus, sched) = setup(at(1, 55), quiet());
    sched
        .add(
            Trigger::At { at: at(2, 0) },
            "the server is down",
            Urgency::Urgent,
            telegram(),
        )
        .unwrap();
    let said = run_for(&bus, &sched, 10 * MIN as u64).await;
    assert_eq!(
        said,
        [("answer to: the server is down".into(), Urgency::Urgent)]
    );
    assert!(store.notices_live().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn pause_holds_a_normal_one() {
    let cfg = Proactive {
        paused_until: Some(at(15, 0)),
        ..Proactive::default()
    };
    let (store, bus, sched) = setup(at(11, 55), cfg);
    sched
        .add(
            Trigger::At { at: at(12, 0) },
            "check the portal",
            Urgency::Normal,
            telegram(),
        )
        .unwrap();
    let said = run_for(&bus, &sched, 10 * MIN as u64).await;
    assert!(said.is_empty());
    assert_eq!(store.notices_live().unwrap()[0].not_before, Some(at(15, 0)));
}

#[tokio::test(start_paused = true)]
async fn no_quiet_hours_until_the_owner_sets_them() {
    let (store, bus, sched) = setup(at(1, 55), Proactive::default());
    sched
        .add(
            Trigger::At { at: at(2, 0) },
            "check the portal",
            Urgency::Low,
            telegram(),
        )
        .unwrap();
    let said = run_for(&bus, &sched, 10 * MIN as u64).await;
    assert_eq!(said.len(), 1);
    assert!(store.notices_live().unwrap().is_empty());
}

// ---- quiet hours end across a spring-forward night ----

/// One spring-forward: 2025-03-30, 02:00 local -> 03:00 (UTC+1 -> UTC+2), as tests/scheduler.rs.
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
fn jump_utc() -> NaiveDateTime {
    NaiveDate::from_ymd_opt(2025, 3, 30)
        .unwrap()
        .and_hms_opt(1, 0, 0)
        .unwrap()
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
        let start = jump_utc() + chrono::Duration::hours(1);
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
        Cet(if *u < jump_utc() { 1 } else { 2 })
    }
}

#[test]
fn quiet_ends_after_crosses_dst() {
    // 23:30 local on the 29th (+1) is 22:30 UTC; 07:00 local on the 30th (+2) is 05:00 UTC.
    let p = quiet();
    let night = Utc
        .with_ymd_and_hms(2025, 3, 29, 22, 30, 0)
        .unwrap()
        .timestamp_millis();
    let end = p.quiet_ends_after_in(night, &Springy);
    assert_eq!(
        end,
        Utc.with_ymd_and_hms(2025, 3, 30, 5, 0, 0)
            .unwrap()
            .timestamp_millis()
    );
    assert_eq!(local_hm(end, &Springy), (7, 0));
}
