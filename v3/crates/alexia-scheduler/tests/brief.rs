// SPDX-License-Identifier: AGPL-3.0-only
//! P3-09: the morning brief, evening wrap-up, weekly review and "while you were away".
//! Paused tokio time, a fixed time zone (UTC+1), fake `Sources`, the store in memory.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::{Brain, BrainError, Bus, DraftSink, Event, Lane, Origin, Reply, Turn, Urgency};
use alexia_scheduler::quiet::Quiet;
use alexia_scheduler::{NoticeItem, Proactive, Scheduler, Sources};
use alexia_store::{AuditRow, Ms, NewNotice, NoticeRow, Store};
use chrono::{FixedOffset, TimeZone};
use serde_json::{json, Map, Value};
use tokio::sync::broadcast::Receiver;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const ITEMS: &str = "notice.items";

fn plus1() -> FixedOffset {
    FixedOffset::east_opt(3600).unwrap()
}

/// 2026-05-`d` at `h:m` in UTC+1. The 4th is a Monday, the 10th a Sunday.
fn on(d: u32, h: u32, m: u32) -> Ms {
    plus1()
        .with_ymd_and_hms(2026, 5, d, h, m, 0)
        .unwrap()
        .timestamp_millis()
}

/// Monday 2026-05-04 at `h:m`.
fn at(h: u32, m: u32) -> Ms {
    on(4, h, m)
}

/// Offers `notice.items` from a time on, and a section per brief kind.
#[derive(Default)]
struct Fake {
    items: Mutex<Vec<(Ms, NoticeItem)>>,
    sections: bool,
}

impl Fake {
    fn with_sections() -> Fake {
        Fake {
            sections: true,
            ..Fake::default()
        }
    }
}

#[async_trait::async_trait]
impl Sources for Fake {
    async fn items(&self, now: Ms, _: u32) -> Vec<(String, NoticeItem)> {
        self.items
            .lock()
            .unwrap()
            .iter()
            .filter(|(from, _)| *from <= now)
            .map(|(_, i)| (ITEMS.to_string(), i.clone()))
            .collect()
    }
    async fn sections(&self, kind: &str, _: Ms) -> Vec<String> {
        if self.sections {
            vec![format!("The {kind} section.")]
        } else {
            Vec::new()
        }
    }
    async fn poll(&self, _: &str, _: Map<String, Value>) -> Option<String> {
        None
    }
    async fn done(&self, _: &str) {}
}

struct NoBrain;

#[async_trait::async_trait]
impl Brain for NoBrain {
    async fn reply(
        &self,
        _: Turn,
        _: DraftSink,
        _: CancellationToken,
    ) -> Result<Reply, BrainError> {
        Ok(Reply {
            text: String::new(),
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
}

fn scheduler(store: Arc<Store>, bus: Bus, wall: Ms, sources: Arc<Fake>) -> Arc<Scheduler> {
    let start = tokio::time::Instant::now();
    let sched = Scheduler::with_parts(
        store,
        bus,
        Arc::new(NoBrain),
        Box::new(move || wall + start.elapsed().as_millis() as Ms),
        Box::new(Store::jobs),
        sources,
    );
    sched.set_zone(Some(plus1()));
    sched
}

/// A running scheduler whose clock starts at `wall` and moves with paused time.
struct Run {
    store: Arc<Store>,
    bus: Bus,
    rx: Receiver<Arc<Event>>,
    cancel: CancellationToken,
    task: JoinHandle<alexia_scheduler::Result<()>>,
    said: Vec<Said>,
    wall: Ms,
    start: tokio::time::Instant,
}

impl Run {
    fn start(wall: Ms, cfg: Proactive, sources: Arc<Fake>) -> Run {
        Run::start_on(
            Arc::new(Store::open_in_memory().unwrap()),
            wall,
            cfg,
            sources,
        )
    }

    fn start_on(store: Arc<Store>, wall: Ms, cfg: Proactive, sources: Arc<Fake>) -> Run {
        cfg.save(&store).unwrap();
        let bus = Bus::new(4096);
        let rx = bus.subscribe();
        let sched = scheduler(store.clone(), bus.clone(), wall, sources);
        let cancel = CancellationToken::new();
        let task = tokio::spawn(sched.run(cancel.clone()));
        Run {
            store,
            bus,
            rx,
            cancel,
            task,
            said: Vec::new(),
            wall,
            start: tokio::time::Instant::now(),
        }
    }

    fn now(&self) -> Ms {
        self.wall + self.start.elapsed().as_millis() as Ms
    }

    /// Lets paused time run until the wall clock reads `until`; collects the `Say`s.
    async fn until(&mut self, until: Ms) {
        let ms = until - self.now();
        assert!(ms >= 0, "the clock is already past that");
        tokio::time::sleep(Duration::from_millis(ms as u64)).await;
        // Let what woke at `until` run.
        tokio::time::sleep(Duration::from_millis(10)).await;
        while let Ok(e) = self.rx.try_recv() {
            if let Event::Say { at, text, .. } = &*e {
                self.said.push(Said {
                    at: *at,
                    text: text.clone(),
                });
            }
        }
    }

    /// The owner shows up now.
    fn active(&self) {
        self.bus.publish(Event::Active {
            at: self.now(),
            via: "phone".into(),
        });
    }

    async fn stop(self) -> (Arc<Store>, Vec<Said>) {
        self.cancel.cancel();
        self.task.await.unwrap().unwrap();
        (self.store, self.said)
    }
}

/// Quiet hours `from`..`to`, letting only Urgent through.
fn quiet(from: (u8, u8), to: (u8, u8)) -> Proactive {
    Proactive {
        quiet: Quiet {
            from,
            to,
            lets_through: Urgency::Urgent,
        },
        ..Proactive::default()
    }
}

fn store_with_morning_said(day: &str) -> Arc<Store> {
    let store = Arc::new(Store::open_in_memory().unwrap());
    store
        .kv_set(
            "_core",
            "brief.last",
            &json!({"morning": day, "at": at(7, 0)}),
        )
        .unwrap();
    store
}

fn file(store: &Store, key: &str, text: &str, urgency: &str, due_at: Option<Ms>, now: Ms) -> i64 {
    store
        .notice_upsert(
            &NewNotice {
                key,
                source: ITEMS,
                text,
                why: "test",
                urgency,
                due_at,
                not_before: None,
            },
            now,
        )
        .unwrap()
        .0
}

fn row(store: &Store, id: i64) -> NoticeRow {
    store.notice(id).unwrap().unwrap()
}

#[tokio::test(start_paused = true)]
async fn morning_at_first_activity() {
    let mut cfg = quiet((22, 0), (6, 0));
    cfg.brief_earliest = (5, 0);
    let mut run = Run::start(at(4, 0), cfg, Arc::new(Fake::with_sections()));
    run.until(at(6, 40)).await;
    assert!(run.said.is_empty(), "nothing before the owner shows up");
    run.active();
    run.until(at(6, 41)).await;
    assert_eq!(run.said.len(), 1);
    // At the Active itself (the test's clock reads a few ms past 06:40 when it is sent).
    assert!(
        (at(6, 40)..at(6, 41)).contains(&run.said[0].at),
        "{:?}",
        run.said
    );
    assert_eq!(run.said[0].text, "Good morning.\n\nThe morning section.");
    run.until(at(6, 50)).await;
    run.active();
    // Past the fallback too: still one brief that day.
    run.until(at(12, 0)).await;
    let (_, said) = run.stop().await;
    assert_eq!(said.len(), 1, "{said:?}");
}

#[tokio::test(start_paused = true)]
async fn morning_waits_for_quiet_end() {
    let mut run = Run::start(
        at(4, 0),
        quiet((23, 0), (7, 0)),
        Arc::new(Fake::with_sections()),
    );
    run.until(at(5, 30)).await;
    run.active();
    run.until(at(6, 59)).await;
    assert!(run.said.is_empty(), "quiet hours: {:?}", run.said);
    run.until(at(8, 0)).await;
    let (_, said) = run.stop().await;
    assert_eq!(said.len(), 1, "{said:?}");
    assert_eq!(said[0].at, at(7, 0));
    assert!(said[0].text.starts_with("Good morning."));
}

#[tokio::test(start_paused = true)]
async fn morning_fallback() {
    let mut run = Run::start(
        at(6, 0),
        Proactive::default(),
        Arc::new(Fake::with_sections()),
    );
    run.until(at(8, 59)).await;
    assert!(run.said.is_empty());
    run.until(at(11, 0)).await;
    let (_, said) = run.stop().await;
    assert_eq!(
        said,
        [Said {
            at: at(9, 0),
            text: "Good morning.\n\nThe morning section.".into(),
        }]
    );
}

#[tokio::test(start_paused = true)]
async fn brief_ask_key_is_honoured_and_cleared() {
    let store = store_with_morning_said("2026-05-04");
    let mut run = Run::start_on(
        store,
        at(12, 0),
        Proactive::default(),
        Arc::new(Fake::with_sections()),
    );
    run.until(at(12, 1)).await;
    // `alexia-hub brief --now` (P3-31) asks for one.
    run.store
        .kv_set(
            "_core",
            "brief.ask",
            &json!({"kind": "weekly", "at": run.now()}),
        )
        .unwrap();
    run.until(at(12, 3)).await;
    assert_eq!(run.said.len(), 1, "{:?}", run.said);
    assert_eq!(run.said[0].at, at(12, 2), "at the next minute");
    assert_eq!(run.said[0].text, "Your week.\n\nThe weekly section.");
    assert_eq!(run.store.kv_get("_core", "brief.ask").unwrap(), None);
    // An ask older than the last brief is cleared without a brief.
    run.store
        .kv_set(
            "_core",
            "brief.ask",
            &json!({"kind": "morning", "at": at(12, 0)}),
        )
        .unwrap();
    run.until(at(12, 10)).await;
    assert_eq!(run.store.kv_get("_core", "brief.ask").unwrap(), None);
    let (_, said) = run.stop().await;
    assert_eq!(said.len(), 1, "{said:?}");
}

#[tokio::test(start_paused = true)]
async fn one_morning_per_day_across_restart() {
    let src = Arc::new(Fake::with_sections());
    let mut run = Run::start(at(6, 0), Proactive::default(), src.clone());
    run.until(at(6, 30)).await;
    run.active();
    run.until(at(6, 31)).await;
    let (store, said) = run.stop().await;
    assert_eq!(said.len(), 1);

    // The hub restarts before the fallback; the owner shows up again.
    let mut run = Run::start_on(store, at(6, 35), Proactive::default(), src);
    run.until(at(6, 40)).await;
    run.active();
    run.until(at(12, 0)).await;
    let (_, said) = run.stop().await;
    assert!(said.is_empty(), "a second morning brief: {said:?}");
}

#[tokio::test(start_paused = true)]
async fn evening_and_weekly_times() {
    // Sunday; the morning brief was given.
    let store = store_with_morning_said("2026-05-10");
    let mut run = Run::start_on(
        store,
        on(10, 17, 0),
        Proactive::default(),
        Arc::new(Fake::with_sections()),
    );
    run.until(on(10, 23, 0)).await;
    let (_, said) = run.stop().await;
    assert_eq!(
        said,
        [
            Said {
                at: on(10, 18, 0),
                text: "Your week.\n\nThe weekly section.".into(),
            },
            Said {
                at: on(10, 21, 0),
                text: "Evening wrap-up.\n\nThe evening section.\n\n\
                       Anything I should remember from today?"
                    .into(),
            },
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn evening_skipped_in_quiet_hours() {
    let store = store_with_morning_said("2026-05-04");
    let mut run = Run::start_on(
        store,
        at(20, 0),
        quiet((20, 30), (7, 0)),
        Arc::new(Fake::with_sections()),
    );
    run.until(at(23, 59)).await;
    let (_, said) = run.stop().await;
    assert!(said.is_empty(), "{said:?}");
}

#[tokio::test(start_paused = true)]
async fn weekly_once_per_iso_week() {
    let src = Arc::new(Fake::with_sections());
    let store = store_with_morning_said("2026-05-10");
    let no_evening = Proactive {
        evening: None,
        ..Proactive::default()
    };
    let mut run = Run::start_on(store, on(10, 17, 0), no_evening.clone(), src.clone());
    run.until(on(10, 18, 30)).await;
    let (store, said) = run.stop().await;
    assert_eq!(said.len(), 1);
    assert!(said[0].text.starts_with("Your week."));

    // Restarted, and the owner moves the review to 19:00 the same Sunday: not again this week.
    let later = Proactive {
        weekly: Some((7, 19, 0)),
        ..no_evening
    };
    let mut run = Run::start_on(store, on(10, 18, 35), later, src);
    run.until(on(10, 20, 0)).await;
    let (_, said) = run.stop().await;
    assert!(said.is_empty(), "{said:?}");
}

#[tokio::test(start_paused = true)]
async fn weekly_comes_again_the_next_week() {
    let store = store_with_morning_said("2026-05-10");
    store
        .kv_set(
            "_core",
            "brief.last",
            &json!({"morning": "2026-05-10", "weekly": "2026-W18", "at": on(10, 7, 0)}),
        )
        .unwrap();
    let cfg = Proactive {
        evening: None,
        ..Proactive::default()
    };
    // 2026-05-10 is in ISO week 19; W18 was last week's.
    let mut run = Run::start_on(store, on(10, 17, 0), cfg, Arc::new(Fake::with_sections()));
    run.until(on(10, 18, 30)).await;
    let (_, said) = run.stop().await;
    assert_eq!(said.len(), 1, "{said:?}");
    assert_eq!(said[0].at, on(10, 18, 0));
}

fn plumber() -> NoticeItem {
    NoticeItem {
        key: "p".into(),
        text: "Pay the plumber".into(),
        why: "an invoice".into(),
        urgency: Some(Urgency::Normal),
        due_at: None,
        not_before: None,
    }
}

#[tokio::test(start_paused = true)]
async fn away_after_four_hours_with_news() {
    let src = Arc::new(Fake::default());
    src.items.lock().unwrap().push((at(12, 5), plumber()));
    let store = store_with_morning_said("2026-05-04");
    let mut run = Run::start_on(store, at(12, 0), Proactive::default(), src);
    run.until(at(12, 1)).await;
    run.active();
    // Said at the next round (12:15), and not seen.
    run.until(at(16, 30)).await;
    assert_eq!(run.said.len(), 1, "{:?}", run.said);
    assert_eq!(run.said[0].text, "Pay the plumber");
    run.active();
    run.until(at(16, 31)).await;
    assert_eq!(run.said.len(), 2, "{:?}", run.said);
    assert!(
        (at(16, 30)..at(16, 31)).contains(&run.said[1].at),
        "at the Active: {:?}",
        run.said
    );
    assert_eq!(
        run.said[1].text,
        "While you were away:\n\n• Pay the plumber"
    );
    // Back again soon after: nothing more.
    run.until(at(16, 40)).await;
    run.active();
    run.until(at(17, 0)).await;
    let (_, said) = run.stop().await;
    assert_eq!(said.len(), 2, "{said:?}");
}

#[tokio::test(start_paused = true)]
async fn away_not_without_news() {
    let store = store_with_morning_said("2026-05-04");
    let mut run = Run::start_on(
        store,
        at(12, 0),
        Proactive::default(),
        Arc::new(Fake::default()),
    );
    run.until(at(12, 1)).await;
    run.active();
    run.until(at(16, 30)).await;
    run.active();
    run.until(at(17, 0)).await;
    let (_, said) = run.stop().await;
    assert!(said.is_empty(), "{said:?}");
}

#[tokio::test(start_paused = true)]
async fn away_not_after_a_short_absence() {
    let src = Arc::new(Fake::default());
    src.items.lock().unwrap().push((at(12, 5), plumber()));
    let store = store_with_morning_said("2026-05-04");
    let mut run = Run::start_on(store, at(12, 0), Proactive::default(), src);
    run.until(at(12, 1)).await;
    run.active();
    run.until(at(15, 0)).await;
    run.active();
    run.until(at(15, 30)).await;
    let (_, said) = run.stop().await;
    assert_eq!(said.len(), 1, "only the notice itself: {said:?}");
}

/// A scheduler that is not running, for `brief_now` on fixed parts.
fn idle(wall: Ms, sources: Arc<Fake>) -> (Arc<Scheduler>, Arc<Store>, Receiver<Arc<Event>>) {
    let store = store_with_morning_said("2026-05-04");
    let bus = Bus::new(64);
    let rx = bus.subscribe();
    (scheduler(store.clone(), bus, wall, sources), store, rx)
}

fn said_texts(rx: &mut Receiver<Arc<Event>>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(e) = rx.try_recv() {
        if let Event::Say {
            text,
            urgency,
            notice,
            to,
            job,
            ..
        } = &*e
        {
            assert_eq!(*urgency, Urgency::Normal);
            assert_eq!(*notice, None);
            assert_eq!(*to, None);
            assert_eq!(*job, None);
            out.push(text.clone());
        }
    }
    out
}

#[tokio::test(start_paused = true)]
async fn compose_orders_and_cuts() {
    let (sched, store, mut rx) = idle(at(12, 0), Arc::new(Fake::with_sections()));
    for i in 0..300 {
        file(
            &store,
            &format!("n{i}"),
            &format!("Low notice number {i:03} about something"),
            "low",
            None,
            at(11, 0),
        );
    }
    file(
        &store,
        "tax",
        "Tax return",
        "normal",
        Some(on(7, 12, 0)),
        at(11, 0),
    );
    sched.brief_now("morning").await.unwrap();
    let texts = said_texts(&mut rx);
    assert_eq!(texts.len(), 1);
    let text = &texts[0];
    assert!(text.chars().count() <= 3500, "{}", text.chars().count());
    assert!(
        text.starts_with("Good morning.\n\nThe morning section.\n\nComing up:\n• Tax return (Thu 7 May)\n\n• Low notice number 000"),
        "{text}"
    );
    let more = text
        .lines()
        .find(|l| l.starts_with("…and "))
        .expect("a …and N more line");
    let n: usize = more
        .trim_start_matches("…and ")
        .trim_end_matches(" more")
        .parse()
        .unwrap();
    let listed: Vec<&str> = text
        .lines()
        .filter(|l| l.starts_with("• Low notice"))
        .collect();
    assert!(n > 0);
    assert_eq!(listed.len() + n, 300);
    assert!(
        listed.iter().all(|l| l.ends_with("about something")),
        "cut mid-line"
    );
    // The cut line is the last one.
    assert_eq!(text.lines().last(), Some(more));
}

#[tokio::test(start_paused = true)]
async fn silent_actions_listed() {
    let (sched, store, mut rx) = idle(at(12, 0), Arc::new(Fake::default()));
    let audit = |at: Ms, origin: &Origin, tool: &str, why: Option<&str>| AuditRow {
        id: 0,
        at,
        run: "r1".into(),
        session: None,
        origin: serde_json::to_string(origin).unwrap(),
        step: 0,
        tool: tool.into(),
        plugin: None,
        args: "{}".into(),
        gate: "run".into(),
        decision: "run".into(),
        why: why.map(str::to_string),
        ok: Some(true),
        result: None,
        undo: None,
        undone_at: None,
    };
    let job = Origin::Scheduler {
        job: alexia_core::JobId(3),
    };
    store
        .audit(&audit(
            at(6, 0),
            &job,
            "page.text",
            Some("Before the last brief"),
        ))
        .unwrap();
    store
        .audit(&audit(
            at(8, 0),
            &job,
            "page.text",
            Some("Checked the school portal"),
        ))
        .unwrap();
    store
        .audit(&audit(at(9, 0), &job, "mail.archive", None))
        .unwrap();
    store
        .audit(&audit(
            at(10, 0),
            &Origin::Desktop,
            "files.move",
            Some("Asked by the owner"),
        ))
        .unwrap();
    sched.brief_now("evening").await.unwrap();
    assert_eq!(
        said_texts(&mut rx),
        ["Evening wrap-up.\n\n\
          Done on my own since 07:00:\n• Checked the school portal\n• mail.archive\n\n\
          Anything I should remember from today?"]
    );
    // The next brief starts from this one.
    sched.brief_now("weekly").await.unwrap();
    assert_eq!(said_texts(&mut rx), ["Your week.\n\nNothing new."]);
}

#[tokio::test(start_paused = true)]
async fn listed_notices_marked_said() {
    let (sched, store, mut rx) = idle(at(12, 0), Arc::new(Fake::default()));
    let low = file(&store, "low", "Water the plants", "low", None, at(11, 0));
    let due = file(
        &store,
        "due",
        "Library books",
        "low",
        Some(on(6, 18, 0)),
        at(11, 0),
    );
    let far = file(
        &store,
        "far",
        "Renew the passport",
        "low",
        Some(on(30, 9, 0)),
        at(11, 0),
    );
    let muted = file(&store, "m", "Muted thing", "low", None, at(11, 0));
    store
        .mute_add(ITEMS, Some("muted"), None, at(11, 0))
        .unwrap();
    sched.brief_now("morning").await.unwrap();
    let texts = said_texts(&mut rx);
    // The passport is due in more than 7 days: kept for the brief, not on the radar.
    assert_eq!(
        texts,
        [
            "Good morning.\n\nComing up:\n• Library books (Wed 6 May)\n\n\
          • Water the plants\n• Renew the passport"
        ]
    );
    for id in [low, due, far] {
        let r = row(&store, id);
        assert_eq!(r.state, "said");
        assert_eq!(r.said_via.as_deref(), Some("brief"));
        assert_eq!(r.said_at, Some(at(12, 0)));
        assert_eq!(r.times_said, 1);
    }
    assert_eq!(row(&store, muted).state, "new", "muted: not listed");
    // Said: not listed again as kept for the brief.
    sched.brief_now("morning").await.unwrap();
    assert_eq!(
        said_texts(&mut rx),
        ["Good morning.\n\nComing up:\n• Library books (Wed 6 May)"]
    );
}

#[tokio::test(start_paused = true)]
async fn evening_radar_is_tomorrow() {
    let (sched, store, mut rx) = idle(at(12, 0), Arc::new(Fake::default()));
    file(&store, "a", "Dentist", "low", Some(on(5, 10, 0)), at(11, 0));
    let later = file(
        &store,
        "b",
        "Car service",
        "low",
        Some(on(6, 10, 0)),
        at(11, 0),
    );
    store.notice_said(later, "primary", at(11, 0)).unwrap();
    sched.brief_now("evening").await.unwrap();
    assert_eq!(
        said_texts(&mut rx),
        ["Evening wrap-up.\n\nComing up:\n• Dentist (Tue 5 May)\n\n\
          Anything I should remember from today?"]
    );
}

#[tokio::test(start_paused = true)]
async fn unknown_kind_is_an_error() {
    let (sched, _, mut rx) = idle(at(12, 0), Arc::new(Fake::default()));
    assert!(sched.brief_now("monthly").await.is_err());
    assert!(said_texts(&mut rx).is_empty());
}
