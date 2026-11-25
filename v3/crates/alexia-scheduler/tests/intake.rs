// SPDX-License-Identifier: AGPL-3.0-only
//! P3-08: the notice loop. Sources are asked every `collect_every_ms`, their items filed once,
//! decided by rule, said, held, closed or dropped; the owner's answers come in over the bus.
//! Paused tokio time, a fake `Sources`, the store in memory.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::{
    Brain, BrainError, Bus, DraftSink, Event, Lane, Origin, Reply, Turn, Urgency, Verdict,
};
use alexia_scheduler::quiet::QUIET_PROPOSED;
use alexia_scheduler::{NoticeItem, Proactive, Scheduler, Sources, Trigger};
use alexia_store::{Ms, NoticeRow, Store};
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

fn item(key: &str, text: &str, urgency: Option<Urgency>) -> NoticeItem {
    NoticeItem {
        key: key.into(),
        text: text.into(),
        why: format!("why {key}"),
        urgency,
        due_at: None,
        not_before: None,
    }
}

/// Offers, each round, the items whose time has come (`from <= now`). `rounds` counts calls.
#[derive(Default)]
struct Fake {
    items: Mutex<Vec<(Ms, String, NoticeItem)>>,
    rounds: AtomicUsize,
    done: Mutex<Vec<String>>,
}

impl Fake {
    fn offer(&self, from: Ms, cap: &str, it: NoticeItem) {
        self.items.lock().unwrap().push((from, cap.into(), it));
    }
    fn withdraw(&self, key: &str) {
        self.items.lock().unwrap().retain(|(_, _, i)| i.key != key);
    }
    fn clear(&self, cap: &str) {
        self.items.lock().unwrap().retain(|(_, c, _)| c != cap);
    }
}

#[async_trait::async_trait]
impl Sources for Fake {
    async fn items(&self, now: Ms, _: u32) -> Vec<(String, NoticeItem)> {
        self.rounds.fetch_add(1, Ordering::SeqCst);
        self.items
            .lock()
            .unwrap()
            .iter()
            .filter(|(from, _, _)| *from <= now)
            .map(|(_, c, i)| (c.clone(), i.clone()))
            .collect()
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

#[derive(Default)]
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

#[derive(Clone, Debug, PartialEq)]
struct Said {
    at: Ms,
    text: String,
    urgency: Urgency,
    notice: Option<i64>,
    to: Option<Origin>,
}

/// A running scheduler whose clock starts at `wall` and moves with tokio's paused time.
struct Run {
    store: Arc<Store>,
    bus: Bus,
    rx: Receiver<Arc<Event>>,
    cancel: CancellationToken,
    task: JoinHandle<alexia_scheduler::Result<()>>,
    said: Vec<Said>,
    sched: Arc<Scheduler>,
}

impl Run {
    fn start(wall: Ms, cfg: Proactive, sources: Arc<Fake>) -> Run {
        let store = Arc::new(Store::open_in_memory().unwrap());
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
            if let Event::Say {
                at,
                text,
                urgency,
                notice,
                to,
                ..
            } = &*e
            {
                self.said.push(Said {
                    at: *at,
                    text: text.clone(),
                    urgency: *urgency,
                    notice: *notice,
                    to: to.clone(),
                });
            }
        }
    }

    fn answer(&self, notice: i64, verdict: Verdict) {
        self.bus.publish(Event::Feedback {
            at: 0,
            notice,
            verdict,
        });
    }

    fn row(&self, source: &str, key: &str) -> NoticeRow {
        self.rows(source, key)
            .pop()
            .unwrap_or_else(|| panic!("no notice {source}/{key}"))
    }

    /// Every row ever filed for (source, key), oldest first.
    fn rows(&self, source: &str, key: &str) -> Vec<NoticeRow> {
        let mut rows: Vec<_> = self
            .store
            .notices_since(0, 10_000)
            .unwrap()
            .into_iter()
            .filter(|n| n.source == source && n.key == key)
            .collect();
        rows.sort_by_key(|n| n.id);
        rows
    }

    async fn stop(self) -> Vec<Said> {
        self.cancel.cancel();
        self.task.await.unwrap().unwrap();
        self.said
    }
}

fn quiet() -> Proactive {
    Proactive {
        quiet: QUIET_PROPOSED,
        ..Proactive::default()
    }
}

#[tokio::test(start_paused = true)]
async fn items_become_notices_once() {
    let src = Arc::new(Fake::default());
    src.offer(
        0,
        ITEMS,
        item("a", "Call the dentist", Some(Urgency::Normal)),
    );
    let mut run = Run::start(at(12, 0), Proactive::default(), src.clone());
    run.pass(61 * MIN).await;
    assert!(src.rounds.load(Ordering::SeqCst) >= 5, "asked every 15 min");
    let rows = run.rows(ITEMS, "a");
    assert_eq!(rows.len(), 1, "filed once");
    assert_eq!(rows[0].state, "said");
    assert_eq!(rows[0].times_said, 1);
    let said = run.stop().await;
    assert_eq!(
        said,
        [Said {
            at: at(12, 0),
            text: "Call the dentist".into(),
            urgency: Urgency::Normal,
            notice: Some(rows[0].id),
            to: None,
        }]
    );
}

#[tokio::test(start_paused = true)]
async fn vanished_three_rounds_is_done() {
    let src = Arc::new(Fake::default());
    src.offer(0, ITEMS, item("a", "Reply to Tom", None));
    src.offer(0, ITEMS, item("b", "Water the plants", None));
    let mut run = Run::start(at(12, 0), Proactive::default(), src.clone());
    run.pass(MIN).await;
    assert_eq!(run.row(ITEMS, "a").state, "new", "low: kept for the brief");
    // The mail was answered: the source still answers, without "a".
    src.withdraw("a");
    // Rounds at 15, 30 (two misses): still live.
    run.pass(39 * MIN).await;
    assert_eq!(run.row(ITEMS, "a").state, "new");
    // Round at 45: the third miss.
    run.pass(10 * MIN).await;
    assert_eq!(run.row(ITEMS, "a").state, "done");
    assert_eq!(run.row(ITEMS, "b").state, "new");
    assert!(run.stop().await.is_empty(), "low items are not said");
}

#[tokio::test(start_paused = true)]
async fn failed_round_closes_nothing() {
    let src = Arc::new(Fake::default());
    src.offer(0, ITEMS, item("a", "Reply to Tom", None));
    src.offer(0, "mail.items", item("m", "A letter from the bank", None));
    let mut run = Run::start(at(12, 0), Proactive::default(), src.clone());
    run.pass(MIN).await;
    // Every notice.items provider fails from now on; mail.items still answers.
    src.clear(ITEMS);
    run.pass(3 * HOUR).await;
    assert_eq!(
        run.row(ITEMS, "a").state,
        "new",
        "a failed source closes nothing"
    );
    assert_eq!(run.row("mail.items", "m").state, "new");
    run.stop().await;
}

#[tokio::test(start_paused = true)]
async fn burst_is_one_say() {
    let src = Arc::new(Fake::default());
    for (i, text) in ["One", "Two", "Three", "Four", "Five"].iter().enumerate() {
        let u = if i == 2 {
            Urgency::High
        } else {
            Urgency::Normal
        };
        src.offer(0, ITEMS, item(&format!("k{i}"), text, Some(u)));
    }
    let mut run = Run::start(at(2, 0), quiet(), src.clone());
    run.pass(4 * HOUR + 59 * MIN).await;
    assert!(run.said.is_empty(), "said in quiet hours: {:?}", run.said);
    let first = run.row(ITEMS, "k0");
    assert_eq!(first.state, "held");
    assert_eq!(first.not_before, Some(at(7, 0)));
    run.pass(2 * HOUR).await;
    for i in 0..5 {
        assert_eq!(run.row(ITEMS, &format!("k{i}")).state, "said");
    }
    let said = run.stop().await;
    assert_eq!(
        said,
        [Said {
            at: at(7, 0),
            text: "One\nTwo\nThree\nFour\nFive".into(),
            urgency: Urgency::High,
            notice: Some(first.id),
            to: None,
        }]
    );
}

#[tokio::test(start_paused = true)]
async fn three_at_once_are_said_one_by_one() {
    let src = Arc::new(Fake::default());
    for i in 0..3 {
        src.offer(
            0,
            ITEMS,
            item(&format!("k{i}"), &format!("n{i}"), Some(Urgency::Normal)),
        );
    }
    let mut run = Run::start(at(12, 0), Proactive::default(), src);
    run.pass(MIN).await;
    let said = run.stop().await;
    let texts: Vec<_> = said.iter().map(|s| s.text.as_str()).collect();
    assert_eq!(texts, ["n0", "n1", "n2"]);
}

#[tokio::test(start_paused = true)]
async fn feedback_later_holds() {
    let src = Arc::new(Fake::default());
    src.offer(
        0,
        ITEMS,
        item("a", "Book the car service", Some(Urgency::Normal)),
    );
    let mut run = Run::start(at(12, 0), Proactive::default(), src);
    run.pass(MIN).await;
    assert_eq!(run.said.len(), 1);
    let id = run.row(ITEMS, "a").id;
    run.answer(id, Verdict::Later { until: at(14, 0) });
    run.pass(MIN).await;
    let row = run.row(ITEMS, "a");
    assert_eq!(
        (row.state.as_str(), row.not_before),
        ("held", Some(at(14, 0)))
    );
    run.pass(at(13, 59) - at(12, 2)).await;
    assert_eq!(run.said.len(), 1, "held until 14:00");
    run.pass(2 * MIN).await;
    let said = run.stop().await;
    assert_eq!(said.len(), 2);
    assert_eq!(said[1].at, at(14, 0));
    assert_eq!(said[1].notice, Some(id));
}

#[tokio::test(start_paused = true)]
async fn feedback_mute_drops_source() {
    let src = Arc::new(Fake::default());
    src.offer(
        0,
        "mail.items",
        item("m1", "Newsletter", Some(Urgency::Normal)),
    );
    let mut run = Run::start(at(12, 0), Proactive::default(), src.clone());
    run.pass(MIN).await;
    assert_eq!(run.said.len(), 1);
    let id = run.row("mail.items", "m1").id;
    run.answer(id, Verdict::Mute);
    run.pass(MIN).await;
    assert_eq!(run.row("mail.items", "m1").state, "dropped");
    let mutes = run.store.mutes(at(12, 2)).unwrap();
    assert_eq!(mutes.len(), 1);
    assert_eq!(
        (mutes[0].source.as_str(), mutes[0].topic.as_deref()),
        ("mail.items", None)
    );
    // More from that source is dropped; another source is still said.
    src.offer(
        0,
        "mail.items",
        item("m2", "Another newsletter", Some(Urgency::High)),
    );
    src.offer(0, ITEMS, item("t", "Pay rent", Some(Urgency::Normal)));
    run.pass(20 * MIN).await;
    assert_eq!(run.row("mail.items", "m2").state, "dropped");
    assert_eq!(
        run.rows("mail.items", "m1").len(),
        1,
        "m1 is not filed again"
    );
    let said = run.stop().await;
    let texts: Vec<_> = said.iter().map(|s| s.text.as_str()).collect();
    assert_eq!(texts, ["Newsletter", "Pay rent"]);
}

#[tokio::test(start_paused = true)]
async fn not_useful_is_not_said_again() {
    let src = Arc::new(Fake::default());
    src.offer(
        0,
        ITEMS,
        item("a", "Your parcel moved", Some(Urgency::Normal)),
    );
    let mut run = Run::start(at(12, 0), Proactive::default(), src);
    run.pass(MIN).await;
    let id = run.row(ITEMS, "a").id;
    run.answer(id, Verdict::NotUseful);
    run.pass(2 * HOUR).await;
    let rows = run.rows(ITEMS, "a");
    assert_eq!(rows.len(), 1, "not filed again while the source offers it");
    assert_eq!(rows[0].state, "dropped");
    assert_eq!(rows[0].feedback.as_deref(), Some("not_useful"));
    assert_eq!(run.stop().await.len(), 1);
}

#[tokio::test(start_paused = true)]
async fn feedback_done_closes_the_plugin_side() {
    let src = Arc::new(Fake::default());
    src.offer(
        0,
        ITEMS,
        item("c1", "Send Ana the photos", Some(Urgency::Normal)),
    );
    let mut run = Run::start(at(12, 0), Proactive::default(), src.clone());
    run.pass(MIN).await;
    let id = run.row(ITEMS, "c1").id;
    run.answer(id, Verdict::Done);
    run.pass(MIN).await;
    assert_eq!(run.row(ITEMS, "c1").state, "done");
    assert_eq!(*src.done.lock().unwrap(), ["c1"]);
    run.stop().await;
}

#[tokio::test(start_paused = true)]
async fn urgent_repeats_until_seen() {
    // Unseen: said three times, 30 minutes apart, then no more.
    let src = Arc::new(Fake::default());
    src.offer(
        0,
        ITEMS,
        item("u", "The boiler is leaking", Some(Urgency::Urgent)),
    );
    let mut run = Run::start(at(12, 0), Proactive::default(), src);
    run.pass(3 * HOUR).await;
    let said = run.stop().await;
    let times: Vec<_> = said.iter().map(|s| s.at).collect();
    assert_eq!(times, [at(12, 0), at(12, 30), at(13, 0)]);
    assert!(said.iter().all(|s| s.urgency == Urgency::Urgent));

    // Seen after the first: never again.
    let src = Arc::new(Fake::default());
    src.offer(
        0,
        ITEMS,
        item("u", "The boiler is leaking", Some(Urgency::Urgent)),
    );
    let mut run = Run::start(at(12, 0), Proactive::default(), src);
    run.pass(10 * MIN).await;
    let id = run.row(ITEMS, "u").id;
    run.answer(id, Verdict::Seen);
    run.pass(3 * HOUR).await;
    assert!(run.row(ITEMS, "u").seen_at.is_some());
    assert_eq!(run.stop().await.len(), 1);
}

#[tokio::test(start_paused = true)]
async fn quiet_hours_hold_then_say_at_seven() {
    let src = Arc::new(Fake::default());
    src.offer(
        0,
        ITEMS,
        item("a", "Renew the passport", Some(Urgency::Normal)),
    );
    let mut run = Run::start(at(2, 0), quiet(), src);
    run.pass(4 * HOUR + 59 * MIN).await;
    assert!(run.said.is_empty());
    let row = run.row(ITEMS, "a");
    assert_eq!(
        (row.state.as_str(), row.not_before),
        ("held", Some(at(7, 0)))
    );
    run.pass(30 * MIN).await;
    let said = run.stop().await;
    assert_eq!(said.len(), 1);
    assert_eq!(said[0].at, at(7, 0));
    assert_eq!(said[0].text, "Renew the passport");
}

#[tokio::test(start_paused = true)]
async fn no_cap() {
    // 30 Normal notices over a day, one every 45 minutes: every one is said.
    let src = Arc::new(Fake::default());
    let wall = at(0, 30);
    for i in 0..30 {
        src.offer(
            wall + i * 45 * MIN,
            ITEMS,
            item(
                &format!("n{i}"),
                &format!("thing {i}"),
                Some(Urgency::Normal),
            ),
        );
    }
    let mut run = Run::start(wall, Proactive::default(), src);
    run.pass(24 * HOUR).await;
    let said = run.stop().await;
    assert_eq!(said.len(), 30, "no daily cap");
    let mut texts: Vec<_> = said.iter().map(|s| s.text.clone()).collect();
    texts.dedup();
    assert_eq!(texts.len(), 30, "each said once");
}

#[tokio::test(start_paused = true)]
async fn deadline_rises_and_is_said_again() {
    // Due in 4 days, Low: kept for the brief; said at 3 days (Normal), again at 24 h (High)
    // and at 2 h (Urgent), with no source answering after the first round.
    let src = Arc::new(Fake::default());
    let wall = at(12, 0);
    let due = wall + 4 * 24 * HOUR;
    src.offer(
        0,
        ITEMS,
        NoticeItem {
            due_at: Some(due),
            ..item("tax", "File the tax return", None)
        },
    );
    let mut run = Run::start(wall, Proactive::default(), src.clone());
    run.pass(MIN).await;
    assert_eq!(run.row(ITEMS, "tax").urgency, "low");
    src.clear(ITEMS);
    run.pass(4 * 24 * HOUR - HOUR).await;
    let said = run.stop().await;
    let got: Vec<_> = said.iter().map(|s| s.urgency).collect();
    assert_eq!(got, [Urgency::Normal, Urgency::High, Urgency::Urgent]);
    // Each within one collect round (15 min) of its threshold.
    let marks = [due - 3 * 24 * HOUR, due - 24 * HOUR, due - 2 * HOUR];
    for (s, mark) in said.iter().zip(marks) {
        assert!(s.at >= mark && s.at <= mark + 15 * MIN, "{s:?} vs {mark}");
    }
}

#[tokio::test(start_paused = true)]
async fn held_job_reply_goes_back_to_its_chat_once() {
    // CEO #20: a held job reply is one write, said once at the end of quiet hours, to the chat
    // that asked.
    let telegram = Origin::Channel {
        channel: "telegram".into(),
        chat: "42".into(),
    };
    let mut run = Run::start(at(1, 55), quiet(), Arc::new(Fake::default()));
    run.sched
        .add(
            Trigger::At { at: at(2, 0) },
            "check the portal",
            Urgency::Normal,
            telegram.clone(),
        )
        .unwrap();
    run.pass(10 * MIN).await;
    assert!(run.said.is_empty());
    let live = run.store.notices_live().unwrap();
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].state, "held");
    assert_eq!(live[0].not_before, Some(at(7, 0)));
    run.pass(at(12, 0) - at(2, 5)).await;
    let said = run.stop().await;
    assert_eq!(
        said,
        [Said {
            at: at(7, 0),
            text: "answer to: check the portal".into(),
            urgency: Urgency::Normal,
            notice: Some(live[0].id),
            to: Some(telegram),
        }]
    );
}
