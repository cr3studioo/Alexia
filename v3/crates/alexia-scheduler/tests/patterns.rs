// SPDX-License-Identifier: AGPL-3.0-only
//! P3-11: the routine, automations, skills and mutes the weekly pass notices and offers.
//! A fixed time zone (UTC+1), the store in memory, rows built by hand.
use std::sync::Arc;
use std::time::Duration;

use alexia_core::{Brain, BrainError, Bus, DraftSink, Event, Lane, Reply, Turn};
use alexia_scheduler::patterns::{
    self, automations, dismissed, find, offer, routine, routine_finding, skills, Finding, Routine,
    RunShape, SOURCE,
};
use alexia_scheduler::{NoSources, Proactive, Scheduler};
use alexia_store::{MessageBody, Ms, NewNotice, Role, SessionId, Store};
use chrono::{FixedOffset, TimeZone};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

const DAY: Ms = 24 * 3_600_000;

fn plus1() -> FixedOffset {
    FixedOffset::east_opt(3600).unwrap()
}

/// 2026-`mo`-`d` at `h:m` in UTC+1. 2026-05-04 is a Monday.
fn on(mo: u32, d: u32, h: u32, m: u32) -> Ms {
    plus1()
        .with_ymd_and_hms(2026, mo, d, h, m, 0)
        .unwrap()
        .timestamp_millis()
}

/// Sunday 2026-05-31 at 17:00, the hour before the default weekly review.
fn now() -> Ms {
    on(5, 31, 17, 0)
}

fn store() -> Store {
    Store::open_in_memory().unwrap()
}

/// A user message in `session` said at `at` (the store stamps the real clock; it is moved).
fn say(store: &Store, session: SessionId, at: Ms, text: &str) {
    let body: MessageBody = serde_json::from_value(json!({ "content": text })).unwrap();
    let id = store.append(session, Role::User, None, &body).unwrap();
    store
        .transaction(|tx| {
            tx.execute("UPDATE messages SET at = ?1 WHERE id = ?2", [at, id.0])?;
            Ok(())
        })
        .unwrap();
}

fn activity(days: &[(&str, u16, u16)]) -> Value {
    let mut m = serde_json::Map::new();
    for (d, first, last) in days {
        m.insert((*d).to_string(), json!([first, last]));
    }
    Value::Object(m)
}

fn hm(h: u16, m: u16) -> u16 {
    h * 60 + m
}

// ---- the routine ----

#[test]
fn routine_is_median_of_five_days() {
    // Mon 4 .. Fri 8 May, and one weekend day.
    let a = activity(&[
        ("2026-05-04", hm(7, 30), hm(22, 0)),
        ("2026-05-05", hm(7, 40), hm(23, 10)),
        ("2026-05-06", hm(7, 45), hm(22, 30)),
        ("2026-05-07", hm(7, 35), hm(21, 50)),
        ("2026-05-08", hm(8, 50), hm(22, 40)),
        ("2026-05-09", hm(10, 0), hm(23, 59)),
    ]);
    let r = routine(&a);
    assert_eq!(
        r,
        Routine {
            weekday_start: Some(hm(7, 40)),
            weekday_end: Some(hm(22, 30)),
            weekend_start: None,
            weekend_end: None,
        }
    );
    // The brief comes at 05:00 at the earliest, 09:00 at the latest: both far from 07:40.
    let f = routine_finding(&r, &Proactive::default()).expect("a routine finding");
    assert_eq!(
        f,
        Finding::Routine {
            start: hm(7, 40),
            end: hm(22, 30)
        }
    );
    assert_eq!(
        f.text(),
        "You usually start around 07:40 on weekdays. Want the morning brief then?"
    );
    // A fallback already near the routine start offers nothing.
    let near = Proactive {
        brief_fallback: (8, 0),
        ..Proactive::default()
    };
    assert_eq!(routine_finding(&r, &near), None);
    // Even days: between the two middle ones.
    let even = activity(&[
        ("2026-05-04", hm(7, 0), hm(22, 0)),
        ("2026-05-05", hm(7, 10), hm(22, 0)),
        ("2026-05-06", hm(7, 20), hm(22, 0)),
        ("2026-05-07", hm(7, 30), hm(22, 0)),
        ("2026-05-08", hm(7, 40), hm(22, 0)),
        ("2026-05-11", hm(7, 50), hm(22, 0)),
    ]);
    assert_eq!(routine(&even).weekday_start, Some(hm(7, 25)));
}

#[test]
fn routine_needs_five_days() {
    let a = activity(&[
        ("2026-05-04", hm(7, 30), hm(22, 0)),
        ("2026-05-05", hm(7, 40), hm(23, 10)),
        ("2026-05-06", hm(7, 45), hm(22, 30)),
        ("2026-05-07", hm(7, 35), hm(21, 50)),
        // Weekend days do not make up the weekdays.
        ("2026-05-09", hm(10, 0), hm(23, 0)),
        ("2026-05-10", hm(10, 0), hm(23, 0)),
        // Unreadable entries are skipped.
        ("not a date", hm(7, 0), hm(8, 0)),
    ]);
    let r = routine(&a);
    assert_eq!(r.weekday_start, None);
    assert_eq!(r.weekday_end, None);
    assert_eq!(routine_finding(&r, &Proactive::default()), None);
    // In the store too: no routine offered.
    let s = store();
    s.kv_set("_core", "activity", &a).unwrap();
    assert!(find(&s, now(), &plus1()).is_empty());
}

// ---- automations ----

/// Mondays 4, 11 and 18 May, around 08:00, the same question in other words.
fn weather_mondays() -> Vec<(Ms, String)> {
    vec![
        (on(5, 4, 8, 0), "What's the weather in Prague today?".into()),
        (
            on(5, 11, 8, 40),
            "what is the weather in prague today".into(),
        ),
        (on(5, 18, 7, 45), "Weather in Prague today, please".into()),
    ]
}

#[test]
fn automation_found_across_three_weeks() {
    let mut msgs = weather_mondays();
    // Noise: other words, another weekday, a time far off.
    msgs.push((on(5, 12, 8, 0), "weather in Prague today".into()));
    msgs.push((on(5, 25, 13, 0), "weather in Prague today".into()));
    msgs.push((on(5, 25, 8, 10), "book a table for two at Lokal".into()));
    let found = automations(&msgs, &plus1());
    assert_eq!(found.len(), 1, "{found:?}");
    let Finding::Automation {
        example,
        weekday,
        minute,
    } = &found[0]
    else {
        panic!("not an automation: {found:?}");
    };
    assert_eq!(*weekday, 1);
    assert_eq!(*minute, hm(8, 0));
    assert!(
        example.to_lowercase().contains("weather in prague"),
        "{example}"
    );
    let text = found[0].text();
    assert!(text.starts_with("You ask “"), "{text}");
    assert!(
        text.ends_with("” most Mondays around 08:00. Want me to do it on my own each week?"),
        "{text}"
    );
    assert!(found[0].key().starts_with("pattern:automation:"));

    // Through the store: the same messages in a chat are found by `find`.
    let s = store();
    let chat = s.create_session(None).unwrap();
    for (at, text) in weather_mondays() {
        say(&s, chat, at, &text);
    }
    let found = find(&s, now(), &plus1());
    assert!(
        found
            .iter()
            .any(|f| matches!(f, Finding::Automation { weekday: 1, .. })),
        "{found:?}"
    );
    // Messages older than 35 days are not read.
    let late = on(5, 18, 7, 45) + 40 * DAY;
    assert!(!find(&s, late, &plus1())
        .iter()
        .any(|f| matches!(f, Finding::Automation { .. })));
}

#[test]
fn automation_not_from_one_week() {
    // Three times on one Monday.
    let one = vec![
        (on(5, 4, 8, 0), "weather in Prague today".to_string()),
        (on(5, 4, 8, 30), "weather in Prague today".to_string()),
        (on(5, 4, 9, 0), "weather in Prague today".to_string()),
    ];
    assert!(automations(&one, &plus1()).is_empty());
    // Four times in two weeks.
    let two = vec![
        (on(5, 4, 8, 0), "weather in Prague today".to_string()),
        (on(5, 4, 8, 30), "weather in Prague today".to_string()),
        (on(5, 11, 8, 0), "weather in Prague today".to_string()),
        (on(5, 11, 8, 30), "weather in Prague today".to_string()),
    ];
    assert!(automations(&two, &plus1()).is_empty());
    // Three weeks, but one of them more than 90 minutes off.
    let off = vec![
        (on(5, 4, 8, 0), "weather in Prague today".to_string()),
        (on(5, 11, 8, 0), "weather in Prague today".to_string()),
        (on(5, 18, 10, 0), "weather in Prague today".to_string()),
    ];
    assert!(automations(&off, &plus1()).is_empty());
    // Three weeks, but too few words shared.
    let unlike = vec![
        (on(5, 4, 8, 0), "weather in Prague today".to_string()),
        (on(5, 11, 8, 0), "weather in Brno tomorrow".to_string()),
        (on(5, 18, 8, 0), "weather in Prague today".to_string()),
    ];
    assert!(automations(&unlike, &plus1()).is_empty());
}

#[test]
fn automation_ignores_private_sessions() {
    let s = store();
    let secret = s.create_session(None).unwrap();
    for (at, text) in weather_mondays() {
        say(&s, secret, at, &text);
    }
    s.kv_set("_core", "private_sessions", &json!([secret.0]))
        .unwrap();
    let found = find(&s, now(), &plus1());
    assert!(
        !found
            .iter()
            .any(|f| matches!(f, Finding::Automation { .. })),
        "a private chat was read: {found:?}"
    );
    // Two in the open chat and one in the private one are not three.
    let open = s.create_session(None).unwrap();
    say(&s, open, on(5, 4, 8, 0), "weather in Prague today");
    say(&s, open, on(5, 11, 8, 0), "weather in Prague today");
    assert!(!find(&s, now(), &plus1())
        .iter()
        .any(|f| matches!(f, Finding::Automation { .. })));
    // A third open one is.
    say(&s, open, on(5, 18, 8, 0), "weather in Prague today");
    let found = find(&s, now(), &plus1());
    let Some(Finding::Automation { example, .. }) = found
        .iter()
        .find(|f| matches!(f, Finding::Automation { .. }))
    else {
        panic!("no automation: {found:?}");
    };
    // The example is the open chat's own words, never the private chat's.
    assert_eq!(example, "weather in Prague today");
}

// ---- skills ----

fn shape(first: &str, tools: &[&str], at: Ms) -> RunShape {
    RunShape {
        first: first.into(),
        tools: tools.iter().map(|t| (*t).to_string()).collect(),
        steps: u32::try_from(tools.len()).unwrap(),
        at,
    }
}

const FIVE: [&str; 5] = [
    "mail.search",
    "mail.read",
    "files.write",
    "calendar.add",
    "mail.send",
];

#[test]
fn skill_needs_same_tools_and_five_steps() {
    let ask = "file the invoices from my mail and tell the accountant";
    let found = skills(
        &[
            shape(ask, &FIVE, now() - DAY),
            shape(
                "file the invoices from mail, tell the accountant",
                &FIVE,
                now() - 8 * DAY,
            ),
            shape(ask, &FIVE, now() - 15 * DAY),
        ],
        now(),
    );
    assert_eq!(found.len(), 1, "{found:?}");
    let Finding::Skill { example, runs } = &found[0] else {
        panic!("not a skill: {found:?}");
    };
    assert_eq!(*runs, 3);
    assert_eq!(example, ask);
    assert_eq!(
        found[0].text(),
        format!("You've had me “{ask}” 3 times the same way. Want me to learn it as a skill?")
    );

    // Other tools in one of them: no skill.
    let mut other = FIVE;
    other[3] = "tasks.add";
    let mixed = [
        shape(ask, &FIVE, now() - DAY),
        shape(ask, &other, now() - 8 * DAY),
        shape(ask, &FIVE, now() - 15 * DAY),
    ];
    assert!(skills(&mixed, now()).is_empty());
    // Four steps: no skill.
    let four = &FIVE[..4];
    let short = [
        shape(ask, four, now() - DAY),
        shape(ask, four, now() - 8 * DAY),
        shape(ask, four, now() - 15 * DAY),
    ];
    assert!(skills(&short, now()).is_empty());
    // One of them older than 30 days: no skill.
    let old = [
        shape(ask, &FIVE, now() - DAY),
        shape(ask, &FIVE, now() - 8 * DAY),
        shape(ask, &FIVE, now() - 31 * DAY),
    ];
    assert!(skills(&old, now()).is_empty());

    // Through the store: the runs' tool names and the messages that started them.
    let s = store();
    let chat = s.create_session(None).unwrap();
    for (i, back) in [1, 8, 15].into_iter().enumerate() {
        let at = now() - back * DAY;
        say(&s, chat, at - 1_000, ask);
        let steps: Vec<Value> = FIVE
            .iter()
            .enumerate()
            .map(|(n, name)| json!({ "n": n + 1, "name": name, "ok": true }))
            .collect();
        let body = json!({ "id": format!("r{i}"), "at": at, "steps": steps, "ended": "answered" });
        s.save_run(&format!("r{i}"), at, &body).unwrap();
    }
    let found = find(&s, now(), &plus1());
    assert!(
        found
            .iter()
            .any(|f| matches!(f, Finding::Skill { runs: 3, .. })),
        "{found:?}"
    );
    // A run that did not finish does not count.
    let body = json!({ "id": "r0", "at": now() - DAY, "steps": [], "ended": "stopped" });
    s.save_run("r0", now() - DAY, &body).unwrap();
    assert!(!find(&s, now(), &plus1())
        .iter()
        .any(|f| matches!(f, Finding::Skill { .. })));
}

// ---- mutes ----

fn notice(s: &Store, source: &str, key: &str, at: Ms) -> i64 {
    let n = NewNotice {
        key,
        source,
        text: "something",
        why: "because",
        urgency: "low",
        due_at: None,
        not_before: None,
    };
    s.notice_upsert(&n, at).unwrap().0
}

#[test]
fn dismissed_three_times_offers_mute() {
    let s = store();
    // news: two dropped, one waved off as not useful, all in the last two weeks.
    for (i, back) in [1, 5, 9].into_iter().enumerate() {
        let at = now() - back * DAY;
        let id = notice(&s, "news.items", &format!("n{i}"), at);
        if i == 2 {
            s.notice_seen(id, Some("not_useful"), at).unwrap();
        } else {
            s.notice_set(id, "dropped", None, at).unwrap();
        }
    }
    // mail: two in two weeks and one older.
    for (i, back) in [1, 3, 20].into_iter().enumerate() {
        let at = now() - back * DAY;
        let id = notice(&s, "mail.items", &format!("m{i}"), at);
        s.notice_set(id, "dropped", None, at).unwrap();
    }
    let found = find(&s, now(), &plus1());
    assert_eq!(
        found,
        vec![Finding::Dismissed {
            source: "news.items".into(),
            count: 3
        }]
    );
    assert_eq!(
        found[0].text(),
        "You've waved off 3 notes from news.items lately. Shall I stop those?"
    );
    // Once muted, it is not offered.
    s.mute_add("news.items", None, None, now() - 1_000).unwrap();
    let rows = s.notices_since(now() - 14 * DAY, 100).unwrap();
    let mutes = s.mutes(now()).unwrap();
    assert!(dismissed(&rows, &mutes, now()).is_empty());
}

// ---- filing ----

fn findings() -> Vec<Finding> {
    vec![
        Finding::Routine {
            start: hm(7, 40),
            end: hm(22, 30),
        },
        Finding::Automation {
            example: "weather in Prague today".into(),
            weekday: 1,
            minute: hm(8, 0),
        },
        Finding::Dismissed {
            source: "news.items".into(),
            count: 3,
        },
    ]
}

#[test]
fn findings_become_low_notices_once() {
    let s = store();
    assert_eq!(offer(&s, &findings(), now()), 3);
    let live = s.notices_live().unwrap();
    assert_eq!(live.len(), 3);
    for (n, f) in live.iter().zip(findings()) {
        assert_eq!(n.source, SOURCE);
        assert_eq!(n.urgency, "low");
        assert_eq!(n.key, f.key());
        assert!(
            n.key.starts_with(&format!("pattern:{}:", f.kind())),
            "{}",
            n.key
        );
        assert_eq!(n.text, f.text());
        assert!(!n.why.is_empty());
        assert_eq!(n.state, "new");
    }
    // Again a week on: nothing new, even said and live.
    s.notice_said(live[0].id, "primary", now()).unwrap();
    assert_eq!(offer(&s, &findings(), now() + 7 * DAY), 0);
    assert_eq!(s.notices_live().unwrap().len(), 3);
    // The same question in other words keeps its key.
    let reworded = Finding::Automation {
        example: "Weather in Prague, today?".into(),
        weekday: 1,
        minute: hm(8, 10),
    };
    assert_eq!(reworded.key(), findings()[1].key());
    // Another weekday is another offer.
    let tuesday = Finding::Automation {
        example: "weather in Prague today".into(),
        weekday: 2,
        minute: hm(8, 0),
    };
    assert_ne!(tuesday.key(), findings()[1].key());
    // A long example is cut to 80 characters in the offer.
    let long = Finding::Skill {
        example: "word ".repeat(40),
        runs: 3,
    };
    let quoted = long.text();
    let inner = quoted.split('“').nth(1).unwrap().split('”').next().unwrap();
    assert!(inner.chars().count() <= 80, "{inner}");
    assert!(inner.ends_with('…'));

    // `pass` files them and records that it ran.
    let s = store();
    s.kv_set(
        "_core",
        "activity",
        &activity(&[
            ("2026-05-25", hm(7, 40), hm(22, 0)),
            ("2026-05-26", hm(7, 40), hm(22, 0)),
            ("2026-05-27", hm(7, 40), hm(22, 0)),
            ("2026-05-28", hm(7, 40), hm(22, 0)),
            ("2026-05-29", hm(7, 40), hm(22, 0)),
        ]),
    )
    .unwrap();
    assert_eq!(patterns::pass(&s, now(), &plus1()), 1);
    assert_eq!(patterns::pass(&s, now() + DAY, &plus1()), 0);
    assert_eq!(
        s.kv_get("_core", patterns::LAST).unwrap(),
        Some(json!(now() + DAY))
    );
}

#[test]
fn dropped_offer_not_repeated_for_sixty_days() {
    let s = store();
    let routine = [Finding::Routine {
        start: hm(7, 40),
        end: hm(22, 30),
    }];
    assert_eq!(offer(&s, &routine, now()), 1);
    let id = s.notices_live().unwrap()[0].id;
    // The owner waves it off.
    s.notice_seen(id, Some("not_useful"), now()).unwrap();
    s.notice_set(id, "dropped", None, now()).unwrap();
    assert_eq!(offer(&s, &routine, now() + 7 * DAY), 0);
    assert_eq!(offer(&s, &routine, now() + 59 * DAY), 0);
    assert!(s.notices_live().unwrap().is_empty());
    // After sixty days it may come again.
    assert_eq!(offer(&s, &routine, now() + 61 * DAY), 1);
    assert_eq!(s.notices_live().unwrap().len(), 1);
}

// ---- the loop ----

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

#[tokio::test]
async fn active_events_become_activity() {
    let store = Arc::new(store());
    let bus = Bus::new(64);
    let sched = Scheduler::with_parts(
        store.clone(),
        bus.clone(),
        Arc::new(NoBrain),
        Box::new(now),
        Box::new(Store::jobs),
        Arc::new(NoSources),
    );
    sched.set_zone(Some(plus1()));
    let cancel = CancellationToken::new();
    let run = tokio::spawn(Arc::clone(&sched).run(cancel.clone()));
    let want = json!({ "2026-05-29": [hm(7, 40), hm(21, 15)] });
    // Generous bound: a loaded machine may be slow to start the loop.
    let got = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            for at in [on(5, 29, 9, 0), on(5, 29, 7, 40), on(5, 29, 21, 15)] {
                bus.publish(Event::Active {
                    at,
                    via: "window".into(),
                });
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            if let Some(v) = store.kv_get("_core", "activity").unwrap() {
                if v == want {
                    return v;
                }
            }
        }
    })
    .await
    .expect("the activity was recorded");
    assert_eq!(got, want);
    cancel.cancel();
    run.await.unwrap().unwrap();
}
