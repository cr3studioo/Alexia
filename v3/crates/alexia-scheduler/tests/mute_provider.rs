// SPDX-License-Identifier: AGPL-3.0-only
//! P3-38: "stop" on a plugin's notice mutes that plugin, not every plugin offering
//! `notice.items`. Paused tokio time, a fake `Sources` with several providers, the store in
//! memory.
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::{
    Brain, BrainError, Bus, DraftSink, Event, Lane, Origin, Reply, Turn, Urgency, Verdict,
};
use alexia_scheduler::decide::mutes;
use alexia_scheduler::quiet::QUIET_PROPOSED;
use alexia_scheduler::{ItemsRound, NoticeItem, Proactive, Scheduler, Sources, Trigger};
use alexia_store::{Ms, MuteRow, NoticeRow, Store};
use chrono::{FixedOffset, TimeZone};
use serde_json::{Map, Value};
use tokio::sync::broadcast::Receiver;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const MIN: Ms = 60_000;
const HOUR: Ms = 60 * MIN;
const ITEMS: &str = "notice.items";

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

/// Several providers of `notice.items`, as the hub reports them: each offers its own items,
/// and any of them may be down (asked, no answer).
#[derive(Default)]
struct Plugins {
    items: Mutex<Vec<(String, NoticeItem)>>,
    down: Mutex<HashSet<String>>,
}

impl Plugins {
    fn offer(&self, plugin: &str, key: &str, urgency: Urgency) {
        let item = NoticeItem {
            key: key.into(),
            text: format!("text of {key}"),
            why: format!("why {key}"),
            urgency: Some(urgency),
            due_at: None,
            not_before: None,
        };
        self.items.lock().unwrap().push((plugin.into(), item));
    }
    fn withdraw(&self, key: &str) {
        self.items.lock().unwrap().retain(|(_, i)| i.key != key);
    }
    fn set_down(&self, plugin: &str, down: bool) {
        let mut set = self.down.lock().unwrap();
        if down {
            set.insert(plugin.into());
        } else {
            set.remove(plugin);
        }
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
    async fn done(&self, _: &str) {}
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
    sched: Arc<Scheduler>,
}

impl Run {
    /// A new `Scheduler` on `store` (on a store that already ran one: a restart).
    fn start(store: Arc<Store>, wall: Ms, cfg: Proactive, sources: Arc<Plugins>) -> Run {
        cfg.save(&store).unwrap();
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

    /// The owner says "stop" on notice (`ITEMS`, `key`), and the loop takes it in.
    async fn stop_notice(&mut self, source: &str, key: &str) {
        let notice = self.row(source, key).id;
        self.bus.publish(Event::Feedback {
            at: 0,
            notice,
            verdict: Verdict::Mute,
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

    fn state(&self, key: &str) -> String {
        self.row(ITEMS, key).state
    }

    /// The sources of the mutes in force, oldest first.
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

#[tokio::test(start_paused = true)]
async fn mute_on_one_plugin_keeps_the_other() {
    let src = Arc::new(Plugins::default());
    src.offer("alpha", "a1", Urgency::Normal);
    src.offer("beta", "b1", Urgency::Normal);
    // Kept for the brief: still live when the owner says stop.
    src.offer("alpha", "a-low", Urgency::Low);
    src.offer("beta", "b-low", Urgency::Low);
    let mut run = Run::start(memory(), at(12, 0), Proactive::default(), src.clone());
    run.pass(MIN).await;
    assert_eq!(run.said, ["text of a1", "text of b1"]);
    // Straight after the round that filed it.
    run.stop_notice(ITEMS, "a1").await;
    assert_eq!(run.muted(), ["notice.items/alpha"]);
    assert_eq!(run.state("a1"), "dropped");
    assert_eq!(run.state("a-low"), "dropped", "the same plugin's live one");
    assert_eq!(run.state("b1"), "said");
    assert_eq!(run.state("b-low"), "new");
    // The next round: one new item from each.
    src.offer("alpha", "a2", Urgency::High);
    src.offer("beta", "b2", Urgency::Normal);
    run.pass(20 * MIN).await;
    assert_eq!(run.state("a2"), "dropped");
    assert_eq!(run.state("b2"), "said");
    assert_eq!(run.rows(ITEMS, "a1").len(), 1, "a1 is not filed again");
    let (said, _) = run.stop().await;
    assert_eq!(said, ["text of a1", "text of b1", "text of b2"]);
}

#[tokio::test(start_paused = true)]
async fn mute_survives_restart() {
    let src = Arc::new(Plugins::default());
    src.offer("alpha", "a1", Urgency::Normal);
    src.offer("beta", "b1", Urgency::Normal);
    let mut run = Run::start(memory(), at(12, 0), Proactive::default(), src.clone());
    run.pass(MIN).await;
    run.stop_notice(ITEMS, "a1").await;
    let (_, store) = run.stop().await;

    // A new scheduler on the same store knows the plugins only from its own rounds.
    src.offer("alpha", "a2", Urgency::Urgent);
    src.offer("beta", "b2", Urgency::Normal);
    let mut run = Run::start(store, at(12, 5), Proactive::default(), src);
    run.pass(20 * MIN).await;
    assert_eq!(run.muted(), ["notice.items/alpha"]);
    assert_eq!(run.state("a2"), "dropped");
    assert_eq!(run.state("b2"), "said");
    assert_eq!(run.rows(ITEMS, "a1").len(), 1, "a1 is not filed again");
    let (said, _) = run.stop().await;
    assert_eq!(said, ["text of b2"]);
}

#[tokio::test(start_paused = true)]
async fn old_plain_mute_still_mutes_all() {
    // A row written before P3-38: the capability alone.
    let store = memory();
    store.mute_add(ITEMS, None, None, at(11, 0)).unwrap();
    let src = Arc::new(Plugins::default());
    src.offer("alpha", "a1", Urgency::Normal);
    src.offer("beta", "b1", Urgency::Urgent);
    let mut run = Run::start(store, at(12, 0), Proactive::default(), src);
    run.pass(20 * MIN).await;
    assert_eq!(run.state("a1"), "dropped");
    assert_eq!(run.state("b1"), "dropped");
    let (said, _) = run.stop().await;
    assert!(said.is_empty(), "{said:?}");
}

#[tokio::test(start_paused = true)]
async fn non_plugin_source_unchanged() {
    // Two job replies, both held by quiet hours; "stop" on the first mutes `job` itself.
    let cfg = Proactive {
        quiet: QUIET_PROPOSED,
        ..Proactive::default()
    };
    let src = Arc::new(Plugins::default());
    src.offer("alpha", "a1", Urgency::Normal);
    let mut run = Run::start(memory(), at(1, 55), cfg, src);
    for (when, ask) in [(at(2, 0), "first job"), (at(2, 30), "second job")] {
        run.sched
            .add(
                Trigger::At { at: when },
                ask,
                Urgency::Normal,
                Origin::Window,
            )
            .unwrap();
    }
    run.pass(10 * MIN).await;
    let jobs = |run: &Run| -> Vec<NoticeRow> {
        let mut rows: Vec<_> = run
            .store
            .notices_since(0, 100)
            .unwrap()
            .into_iter()
            .filter(|n| n.source == "job")
            .collect();
        rows.sort_by_key(|n| n.id);
        rows
    };
    let first = jobs(&run);
    assert_eq!(first.len(), 1, "{first:?}");
    run.stop_notice("job", &first[0].key).await;
    assert_eq!(run.muted(), ["job"]);
    // Past the end of quiet hours: no job reply is said, the plugin's notice is.
    run.pass(6 * HOUR).await;
    let states: Vec<String> = jobs(&run).into_iter().map(|n| n.state).collect();
    assert_eq!(states, ["dropped", "dropped"]);
    let (said, _) = run.stop().await;
    assert_eq!(said, ["text of a1"]);
}

#[tokio::test(start_paused = true)]
async fn stop_on_an_old_notice_still_names_its_plugin() {
    // Offered once, gone, closed as done: the owner's "stop" on the old notice comes later.
    // (Low: kept for the brief. Only a notice not yet said closes when it vanishes.)
    let src = Arc::new(Plugins::default());
    src.offer("alpha", "a1", Urgency::Low);
    let mut run = Run::start(memory(), at(12, 0), Proactive::default(), src.clone());
    run.pass(MIN).await;
    src.withdraw("a1");
    run.pass(2 * HOUR).await;
    assert_eq!(run.state("a1"), "done");
    run.stop_notice(ITEMS, "a1").await;
    assert_eq!(run.muted(), ["notice.items/alpha"]);
    run.stop().await;
}

#[tokio::test(start_paused = true)]
async fn stop_before_the_plugin_answers_mutes_it_when_it_does() {
    let src = Arc::new(Plugins::default());
    src.offer("alpha", "a1", Urgency::Normal);
    let mut run = Run::start(memory(), at(12, 0), Proactive::default(), src.clone());
    run.pass(MIN).await;
    let (_, store) = run.stop().await;

    // After a restart alpha does not answer, so nobody knows who offered a1.
    src.set_down("alpha", true);
    src.offer("beta", "b1", Urgency::Normal);
    let mut run = Run::start(store, at(12, 5), Proactive::default(), src.clone());
    run.pass(MIN).await;
    run.stop_notice(ITEMS, "a1").await;
    assert_eq!(run.state("a1"), "dropped");
    assert!(
        run.muted().is_empty(),
        "no plugin is muted on a guess, least of all all of them: {:?}",
        run.muted()
    );
    // Back again: now it is known, and muted.
    src.set_down("alpha", false);
    src.offer("alpha", "a2", Urgency::High);
    src.offer("beta", "b2", Urgency::Normal);
    run.pass(40 * MIN).await;
    assert_eq!(run.muted(), ["notice.items/alpha"], "stored once");
    assert_eq!(run.rows(ITEMS, "a1").len(), 1, "a1 is not filed again");
    assert_eq!(run.state("a2"), "dropped");
    assert_eq!(run.state("b2"), "said");
    let (said, _) = run.stop().await;
    assert_eq!(said, ["text of b1", "text of b2"]);
}

#[tokio::test(start_paused = true)]
async fn brief_leaves_out_only_the_muted_plugin() {
    let src = Arc::new(Plugins::default());
    src.offer("alpha", "a1", Urgency::Normal);
    let mut run = Run::start(memory(), at(12, 0), Proactive::default(), src.clone());
    run.pass(MIN).await;
    run.stop_notice(ITEMS, "a1").await;
    src.offer("alpha", "a-low", Urgency::Low);
    src.offer("beta", "b-low", Urgency::Low);
    run.pass(20 * MIN).await;
    run.sched.brief_now("morning").await.unwrap();
    run.pass(MIN).await;
    let (said, _) = run.stop().await;
    let brief = said.last().unwrap();
    assert!(brief.starts_with("Good morning."), "{said:?}");
    assert!(brief.contains("text of b-low"), "{brief}");
    assert!(!brief.contains("text of a-low"), "{brief}");
}

#[test]
fn a_plugin_mute_covers_only_that_plugins_notices() {
    let row = |source: &str| NoticeRow {
        id: 1,
        key: "k".into(),
        source: source.into(),
        text: "Pay the electricity bill".into(),
        why: String::new(),
        urgency: "normal".into(),
        due_at: None,
        not_before: None,
        state: "new".into(),
        created_at: 0,
        updated_at: 0,
        said_at: None,
        said_via: None,
        times_said: 0,
        seen_at: None,
        feedback: None,
    };
    let mute = |source: &str, topic: Option<&str>, until: Option<Ms>| MuteRow {
        id: 1,
        source: source.into(),
        topic: topic.map(str::to_string),
        until,
        created_at: 0,
    };
    let now = at(12, 0);
    let alpha = mute("notice.items/alpha", None, None);
    assert!(mutes(&alpha, &row(ITEMS), Some("alpha"), now));
    assert!(!mutes(&alpha, &row(ITEMS), Some("beta"), now));
    assert!(!mutes(&alpha, &row(ITEMS), Some("alph"), now));
    assert!(
        !mutes(&alpha, &row(ITEMS), None, now),
        "an unknown provider is not covered"
    );
    // Only plugin notices have a per-provider mute.
    assert!(!mutes(&alpha, &row("mail.items"), Some("alpha"), now));
    // Topic and end hold for it as for any mute.
    let topic = mute("notice.items/alpha", Some("ELECTRICITY"), None);
    assert!(mutes(&topic, &row(ITEMS), Some("alpha"), now));
    let miss = mute("notice.items/alpha", Some("water"), None);
    assert!(!mutes(&miss, &row(ITEMS), Some("alpha"), now));
    let ended = mute("notice.items/alpha", None, Some(now));
    assert!(!mutes(&ended, &row(ITEMS), Some("alpha"), now));
    // The plain row keeps its meaning, provider known or not.
    let plain = mute(ITEMS, None, None);
    assert!(mutes(&plain, &row(ITEMS), Some("alpha"), now));
    assert!(mutes(&plain, &row(ITEMS), None, now));
}
