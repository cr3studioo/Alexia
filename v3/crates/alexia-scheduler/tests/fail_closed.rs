// SPDX-License-Identifier: AGPL-3.0-only
//! P3-41: the owner's brakes fail closed. A mutes read that errors skips the dispatch pass,
//! and a `_core.proactive` whose `quiet` or `paused_until` cannot be read holds everything
//! below Urgent. Paused tokio time, no sources, the store in memory.
use std::sync::Arc;
use std::time::Duration;

use alexia_core::{Brain, BrainError, Bus, DraftSink, Event, Lane, Origin, Reply, Turn, Urgency};
use alexia_scheduler::{NoSources, Proactive, Scheduler, Trigger};
use alexia_store::{Ms, NewNotice, NoticeRow, Store};
use chrono::{FixedOffset, TimeZone};
use serde_json::json;
use tokio::sync::broadcast::Receiver;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const MIN: Ms = 60_000;
const HOUR: Ms = 60 * MIN;
const DAY: Ms = 24 * HOUR;

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

struct EchoBrain;

#[async_trait::async_trait]
impl Brain for EchoBrain {
    async fn reply(
        &self,
        turn: Turn,
        _: DraftSink,
        _: CancellationToken,
    ) -> Result<Reply, BrainError> {
        Ok(Reply {
            text: format!("answer to: {}", turn.content.text()),
            files: vec![],
            lane: Lane::Task,
            model: None,
            spans: vec![],
        })
    }
}

/// A running scheduler whose clock starts at `wall` and moves with tokio's paused time.
struct Run {
    store: Arc<Store>,
    rx: Receiver<Arc<Event>>,
    cancel: CancellationToken,
    task: JoinHandle<alexia_scheduler::Result<()>>,
    /// The text of every `Say` published.
    said: Vec<String>,
    sched: Arc<Scheduler>,
}

impl Run {
    /// Starts on `store` as it is: each test writes `_core.proactive` itself.
    fn start(store: Arc<Store>, wall: Ms) -> Run {
        let bus = Bus::new(4096);
        let rx = bus.subscribe();
        let start = tokio::time::Instant::now();
        let sched = Scheduler::with_parts(
            store.clone(),
            bus,
            Arc::new(EchoBrain),
            Box::new(move || wall + start.elapsed().as_millis() as Ms),
            Box::new(Store::jobs),
            Arc::new(NoSources),
        );
        sched.set_zone(Some(plus1()));
        let cancel = CancellationToken::new();
        let task = tokio::spawn(sched.clone().run(cancel.clone()));
        Run {
            store,
            rx,
            cancel,
            task,
            said: Vec::new(),
            sched,
        }
    }

    /// Lets `ms` of paused time pass; collects the `Say`s published meanwhile.
    async fn pass(&mut self, ms: Ms) {
        tokio::time::sleep(Duration::from_millis(ms as u64)).await;
        while let Ok(e) = self.rx.try_recv() {
            if let Event::Say { text, .. } = &*e {
                self.said.push(text.clone());
            }
        }
    }

    fn rows(&self, source: &str) -> Vec<NoticeRow> {
        let mut rows: Vec<_> = self
            .store
            .notices_since(0, 1_000)
            .unwrap()
            .into_iter()
            .filter(|n| n.source == source)
            .collect();
        rows.sort_by_key(|n| n.id);
        rows
    }

    fn state(&self, source: &str, key: &str) -> String {
        let rows: Vec<_> = self
            .rows(source)
            .into_iter()
            .filter(|n| n.key == key)
            .collect();
        assert_eq!(rows.len(), 1, "{source}/{key}: {rows:?}");
        rows[0].state.clone()
    }

    async fn stop(self) -> Vec<String> {
        self.cancel.cancel();
        self.task.await.unwrap().unwrap();
        self.said
    }
}

fn memory() -> Arc<Store> {
    Arc::new(Store::open_in_memory().unwrap())
}

fn file(store: &Store, source: &str, key: &str, urgency: &str, now: Ms) {
    let text = format!("text of {key}");
    store
        .notice_upsert(
            &NewNotice {
                key,
                source,
                text: &text,
                why: "why",
                urgency,
                due_at: None,
                not_before: None,
            },
            now,
        )
        .unwrap();
}

/// Renames a table, so every read of it errors until it is renamed back.
fn rename(store: &Store, from: &str, to: &str) {
    store
        .transaction(|tx| {
            tx.execute_batch(&format!("ALTER TABLE {from} RENAME TO {to}"))?;
            Ok(())
        })
        .unwrap();
}

fn set_proactive(store: &Store, v: serde_json::Value) {
    store.kv_set("_core", Proactive::KEY, &v).unwrap();
}

#[tokio::test(start_paused = true)]
async fn mutes_read_error_says_nothing() {
    let store = memory();
    store.mute_add("job", None, None, at(11, 0)).unwrap();
    file(&store, "job", "j1", "normal", at(11, 30));
    rename(&store, "mutes", "mutes_off");
    let mut run = Run::start(store, at(12, 0));
    run.pass(5 * MIN).await;
    assert!(run.said.is_empty(), "{:?}", run.said);
    assert_eq!(
        run.state("job", "j1"),
        "new",
        "neither said, held nor dropped"
    );
    // Readable again: the next pass (a minute later at most) drops it as muted.
    rename(&run.store, "mutes_off", "mutes");
    run.pass(2 * MIN).await;
    assert_eq!(run.state("job", "j1"), "dropped");
    let said = run.stop().await;
    assert!(said.is_empty(), "{said:?}");
}

#[tokio::test(start_paused = true)]
async fn kv_read_error_holds_notices() {
    let store = memory();
    file(&store, "job", "normal", "normal", at(11, 30));
    file(&store, "job", "urgent", "urgent", at(11, 30));
    rename(&store, "kv", "kv_off");
    assert!(Proactive::load(&store).unreadable);
    let mut run = Run::start(store, at(12, 0));
    run.pass(5 * MIN).await;
    assert_eq!(run.said, ["text of urgent"]);
    assert_eq!(run.state("job", "normal"), "held");
    // Readable again (no value: the defaults, no pause, no quiet hours): it is said.
    rename(&run.store, "kv_off", "kv");
    run.pass(2 * MIN).await;
    let said = run.stop().await;
    assert_eq!(said, ["text of urgent", "text of normal"]);
}

#[tokio::test(start_paused = true)]
async fn bad_quiet_field_keeps_the_pause() {
    let store = memory();
    let tomorrow = at(12, 0) + DAY;
    set_proactive(
        &store,
        json!({ "paused_until": tomorrow, "quiet": "never" }),
    );
    file(&store, "job", "j1", "normal", at(11, 30));
    let mut run = Run::start(store, at(12, 0));
    run.pass(5 * MIN).await;
    assert!(run.said.is_empty(), "{:?}", run.said);
    assert_eq!(run.state("job", "j1"), "held");
    // A good `quiet` now: readable, and the pause still holds it.
    let quiet = serde_json::to_value(Proactive::default().quiet).unwrap();
    set_proactive(
        &run.store,
        json!({ "paused_until": tomorrow, "quiet": quiet }),
    );
    assert!(!Proactive::load(&run.store).unreadable);
    run.pass(HOUR).await;
    assert!(run.said.is_empty(), "{:?}", run.said);
    assert_eq!(run.state("job", "j1"), "held");
    // Until the pause ends.
    run.pass(DAY).await;
    let said = run.stop().await;
    assert_eq!(said, ["text of j1"]);
}

#[tokio::test(start_paused = true)]
async fn bad_brief_field_changes_nothing_else() {
    let store = memory();
    let tomorrow = at(12, 0) + DAY;
    set_proactive(&store, json!({ "paused_until": tomorrow, "evening": "x" }));
    let p = Proactive::load(&store);
    assert!(!p.unreadable);
    assert_eq!(p.paused_until, Some(tomorrow));
    assert_eq!(p.evening, Proactive::default().evening);
    file(&store, "job", "j1", "normal", at(11, 30));
    let mut run = Run::start(store, at(12, 0));
    run.pass(HOUR).await;
    assert!(run.said.is_empty(), "{:?}", run.said);
    assert_eq!(run.state("job", "j1"), "held");
    run.pass(DAY).await;
    let said = run.stop().await;
    assert_eq!(said, ["text of j1"]);
}

#[tokio::test(start_paused = true)]
async fn job_reply_held_when_unreadable() {
    let store = memory();
    set_proactive(&store, json!({ "quiet": "never" }));
    let mut run = Run::start(store, at(12, 0));
    run.sched
        .add(
            Trigger::At { at: at(12, 1) },
            "the job",
            Urgency::Normal,
            Origin::Window,
        )
        .unwrap();
    run.pass(10 * MIN).await;
    let jobs = run.rows("job");
    assert_eq!(jobs.len(), 1, "the reply is filed: {jobs:?}");
    assert_eq!(jobs[0].state, "held");
    let said = run.stop().await;
    assert!(said.is_empty(), "{said:?}");
}
