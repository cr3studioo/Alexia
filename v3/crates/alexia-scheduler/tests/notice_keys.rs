// SPDX-License-Identifier: AGPL-3.0-only
//! P3-43: plugin items are filed under `<provider>/<key>`, so one plugin cannot rewrite, take
//! over or hear another plugin's notices. Paused tokio time, a fake `Sources` with several
//! providers that records `done`, the store in memory.
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::{Brain, BrainError, Bus, DraftSink, Event, Lane, Reply, Turn, Urgency, Verdict};
use alexia_scheduler::{ItemsRound, NoticeItem, Proactive, Scheduler, Sources};
use alexia_store::{Ms, NewNotice, NoticeRow, Store};
use chrono::{FixedOffset, TimeZone};
use serde_json::{Map, Value};
use tokio::sync::broadcast::Receiver;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const MIN: Ms = 60_000;
const ITEMS: &str = "notice.items";
const KEY: &str = "commitments:12";

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

/// Several providers of `notice.items`, as the hub reports them. Records every `done` key.
#[derive(Default)]
struct Plugins {
    items: Mutex<Vec<(String, NoticeItem)>>,
    down: Mutex<HashSet<String>>,
    done: Mutex<Vec<String>>,
}

impl Plugins {
    fn offer(&self, plugin: &str, key: &str, text: &str, urgency: Urgency) {
        let item = NoticeItem {
            key: key.into(),
            text: text.into(),
            why: format!("why {text}"),
            urgency: Some(urgency),
            due_at: None,
            not_before: None,
        };
        self.items.lock().unwrap().push((plugin.into(), item));
    }
    fn set_down(&self, plugin: &str) {
        self.down.lock().unwrap().insert(plugin.into());
    }
    fn done(&self) -> Vec<String> {
        self.done.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl Sources for Plugins {
    async fn items(&self, now: Ms, horizon_days: u32) -> Vec<(String, NoticeItem)> {
        self.round(now, horizon_days)
            .await
            .items
            .into_iter()
            .map(|(_, cap, item)| (cap, item))
            .collect()
    }
    async fn round(&self, _: Ms, _: u32) -> ItemsRound {
        let down = self.down.lock().unwrap().clone();
        let mut round = ItemsRound::default();
        for plugin in ["alpha", "beta"] {
            let slot = (plugin.to_string(), ITEMS.to_string());
            if down.contains(plugin) {
                round.failed.push(slot);
            } else {
                round.answered.push(slot);
            }
        }
        for (plugin, item) in self.items.lock().unwrap().iter() {
            if !down.contains(plugin) {
                round
                    .items
                    .push((plugin.clone(), ITEMS.to_string(), item.clone()));
            }
        }
        round
    }
    async fn sections(&self, _: &str, _: Ms) -> Vec<String> {
        Vec::new()
    }
    async fn poll(&self, _: &str, _: Map<String, Value>) -> Option<String> {
        None
    }
    async fn done(&self, key: &str) {
        self.done.lock().unwrap().push(key.into());
    }
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
    bus: Bus,
    rx: Receiver<Arc<Event>>,
    cancel: CancellationToken,
    task: JoinHandle<alexia_scheduler::Result<()>>,
    /// The text of every `Say` published.
    said: Vec<String>,
}

impl Run {
    /// A new `Scheduler` on `store` (on a store that already ran one: a restart).
    fn start(store: Arc<Store>, wall: Ms, sources: Arc<Plugins>) -> Run {
        Proactive::default().save(&store).unwrap();
        let bus = Bus::new(4096);
        let rx = bus.subscribe();
        let start = tokio::time::Instant::now();
        let sched = Scheduler::with_parts(
            store.clone(),
            bus.clone(),
            Arc::new(EchoBrain),
            Box::new(move || wall + start.elapsed().as_millis() as Ms),
            Box::new(Store::jobs),
            sources,
        );
        sched.set_zone(Some(plus1()));
        let cancel = CancellationToken::new();
        let task = tokio::spawn(sched.clone().run(cancel.clone()));
        Run {
            store,
            bus,
            rx,
            cancel,
            task,
            said: Vec::new(),
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

    /// The owner answers notice (`source`, `key`), and the loop takes it in.
    async fn answer(&mut self, source: &str, key: &str, verdict: Verdict) {
        let notice = self.row(source, key).id;
        self.bus.publish(Event::Feedback {
            at: 0,
            notice,
            verdict,
        });
        self.pass(MIN).await;
    }

    /// Every row ever filed for (source, key).
    fn rows(&self, source: &str, key: &str) -> Vec<NoticeRow> {
        self.store
            .notices_since(0, 10_000)
            .unwrap()
            .into_iter()
            .filter(|n| n.source == source && n.key == key)
            .collect()
    }

    /// The one row filed for (source, key).
    fn row(&self, source: &str, key: &str) -> NoticeRow {
        let mut rows = self.rows(source, key);
        assert_eq!(rows.len(), 1, "{source}/{key}: {rows:?}");
        rows.remove(0)
    }

    /// Every `notice.items` key filed, sorted.
    fn item_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self
            .store
            .notices_since(0, 10_000)
            .unwrap()
            .into_iter()
            .filter(|n| n.source == ITEMS)
            .map(|n| n.key)
            .collect();
        keys.sort();
        keys
    }

    /// The sources of the mutes in force.
    fn muted(&self) -> Vec<String> {
        self.store
            .mutes(at(12, 0))
            .unwrap()
            .into_iter()
            .map(|m| m.source)
            .collect()
    }

    /// Stops the scheduler: what was said, and the store for a restart.
    async fn stop(self) -> (Vec<String>, Arc<Store>) {
        self.cancel.cancel();
        self.task.await.unwrap().unwrap();
        (self.said, self.store)
    }
}

fn memory() -> Arc<Store> {
    Arc::new(Store::open_in_memory().unwrap())
}

/// A row filed straight into the store, as one from before P3-43 (or a job's) is.
fn file(store: &Store, source: &str, key: &str, text: &str, now: Ms) -> i64 {
    store
        .notice_upsert(
            &NewNotice {
                key,
                source,
                text,
                why: "why",
                urgency: "normal",
                due_at: None,
                not_before: None,
            },
            now,
        )
        .unwrap()
        .0
}

#[tokio::test(start_paused = true)]
async fn same_key_two_providers_two_rows() {
    let src = Arc::new(Plugins::default());
    src.offer("alpha", "tasks:1", "alpha's task", Urgency::Normal);
    src.offer("beta", "tasks:1", "beta's task", Urgency::Normal);
    let mut run = Run::start(memory(), at(12, 0), src.clone());
    run.pass(MIN).await;
    assert_eq!(run.item_keys(), ["alpha/tasks:1", "beta/tasks:1"]);
    assert_eq!(run.row(ITEMS, "alpha/tasks:1").text, "alpha's task");
    assert_eq!(run.row(ITEMS, "beta/tasks:1").text, "beta's task");
    let (said, _) = run.stop().await;
    assert_eq!(said, ["alpha's task", "beta's task"]);
}

#[tokio::test(start_paused = true)]
async fn impostor_cannot_rewrite() {
    let src = Arc::new(Plugins::default());
    src.offer("alpha", KEY, "text A", Urgency::Low);
    let mut run = Run::start(memory(), at(12, 0), src.clone());
    run.pass(MIN).await;
    src.offer("beta", KEY, "text B", Urgency::Urgent);
    run.pass(20 * MIN).await;
    let alpha = run.row(ITEMS, "alpha/commitments:12");
    assert_eq!(
        (alpha.text.as_str(), alpha.urgency.as_str()),
        ("text A", "low")
    );
    let beta = run.row(ITEMS, "beta/commitments:12");
    assert_eq!(
        (beta.text.as_str(), beta.urgency.as_str()),
        ("text B", "urgent")
    );
    assert_eq!(run.item_keys().len(), 2, "{:?}", run.item_keys());
    run.stop().await;
}

#[tokio::test(start_paused = true)]
async fn done_goes_to_its_provider_only() {
    let src = Arc::new(Plugins::default());
    src.offer("alpha", KEY, "text A", Urgency::Normal);
    src.offer("beta", KEY, "text B", Urgency::Normal);
    let mut run = Run::start(memory(), at(12, 0), src.clone());
    run.pass(MIN).await;
    run.answer(ITEMS, "alpha/commitments:12", Verdict::Done)
        .await;
    assert_eq!(run.row(ITEMS, "alpha/commitments:12").state, "done");
    assert_eq!(src.done(), ["alpha/commitments:12"]);
    assert_eq!(run.row(ITEMS, "beta/commitments:12").state, "said");
    run.stop().await;
}

#[tokio::test(start_paused = true)]
async fn mute_after_restart_knows_provider() {
    let src = Arc::new(Plugins::default());
    // Kept for the brief: still live after the restart.
    src.offer("alpha", KEY, "text A", Urgency::Low);
    let mut run = Run::start(memory(), at(12, 0), src.clone());
    run.pass(MIN).await;
    let (_, store) = run.stop().await;
    // After the restart alpha does not answer, so no round says who offered the row.
    src.set_down("alpha");
    let mut run = Run::start(store, at(12, 2), src.clone());
    run.pass(MIN).await;
    run.answer(ITEMS, "alpha/commitments:12", Verdict::Mute)
        .await;
    assert_eq!(run.muted(), ["notice.items/alpha"]);
    assert_eq!(run.row(ITEMS, "alpha/commitments:12").state, "dropped");
    run.stop().await;
}

#[tokio::test(start_paused = true)]
async fn old_plain_row_kept() {
    let store = memory();
    let id = file(&store, ITEMS, KEY, "old text", at(11, 0));
    store.notice_set(id, "said", None, at(11, 0)).unwrap();
    let src = Arc::new(Plugins::default());
    src.offer("alpha", KEY, "new text", Urgency::Normal);
    let mut run = Run::start(store, at(12, 0), src.clone());
    run.pass(MIN).await;
    run.pass(20 * MIN).await;
    assert_eq!(run.item_keys(), [KEY], "no second row");
    let row = run.row(ITEMS, KEY);
    assert_eq!(row.id, id);
    assert_eq!(row.text, "new text");
    assert_eq!(row.state, "said");
    // Its provider is known from the round: Done reaches alpha with the filed key.
    run.answer(ITEMS, KEY, Verdict::Done).await;
    assert_eq!(src.done(), ["alpha/commitments:12"]);
    let (said, _) = run.stop().await;
    assert!(said.is_empty(), "nothing said again: {said:?}");
}

#[tokio::test(start_paused = true)]
async fn old_plain_row_unknown_done_tells_nobody() {
    let store = memory();
    file(&store, ITEMS, KEY, "old text", at(11, 0));
    let src = Arc::new(Plugins::default());
    src.set_down("alpha");
    src.set_down("beta");
    let mut run = Run::start(store, at(12, 0), src.clone());
    run.pass(MIN).await;
    run.answer(ITEMS, KEY, Verdict::Done).await;
    assert_eq!(run.row(ITEMS, KEY).state, "done");
    assert!(src.done().is_empty(), "{:?}", src.done());
    run.stop().await;
}

#[tokio::test(start_paused = true)]
async fn job_notices_unchanged() {
    let store = memory();
    file(&store, "job", "j1", "the job's answer", at(11, 30));
    let src = Arc::new(Plugins::default());
    src.offer("alpha", "j1", "alpha's j1", Urgency::Low);
    let mut run = Run::start(store, at(12, 0), src.clone());
    run.pass(MIN).await;
    assert_eq!(run.row("job", "j1").state, "said");
    assert_eq!(run.said, ["the job's answer"]);
    run.answer("job", "j1", Verdict::Done).await;
    assert_eq!(run.row("job", "j1").state, "done");
    assert!(src.done().is_empty(), "a job's Done is no plugin's");
    assert_eq!(run.item_keys(), ["alpha/j1"]);
    run.stop().await;
}
