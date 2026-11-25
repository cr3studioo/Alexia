// SPDX-License-Identifier: AGPL-3.0-only
//! P3-08: the decider's rules, one test each, and the deadline radar (INTERFACES §2.5).
use alexia_scheduler::decide::{effective, REPEAT_MS, REPEAT_TIMES};
use alexia_scheduler::quiet::QUIET_PROPOSED;
use alexia_scheduler::{decide, radar, DecideCtx, Decision, Proactive, Urgency};
use alexia_store::{Ms, MuteRow, NoticeRow};

const MIN: Ms = 60_000;
const HOUR: Ms = 60 * MIN;
const DAY: Ms = 24 * HOUR;

const NOW: Ms = 1_800_000_000_000;

fn row(state: &str, urgency: &str) -> NoticeRow {
    NoticeRow {
        id: 1,
        key: "k".into(),
        source: "notice.items".into(),
        text: "Pay the Electricity bill".into(),
        why: "w".into(),
        urgency: urgency.into(),
        due_at: None,
        not_before: None,
        state: state.into(),
        created_at: NOW - HOUR,
        updated_at: NOW - HOUR,
        said_at: None,
        said_via: None,
        times_said: 0,
        seen_at: None,
        feedback: None,
    }
}

fn mute(source: &str, topic: Option<&str>, until: Option<Ms>) -> MuteRow {
    MuteRow {
        id: 1,
        source: source.into(),
        topic: topic.map(Into::into),
        until,
        created_at: NOW - DAY,
    }
}

fn ctx<'a>(cfg: &'a Proactive, mutes: &'a [MuteRow], now: Ms) -> DecideCtx<'a> {
    DecideCtx {
        now,
        now_local: (12, 0),
        cfg,
        mutes,
        last_active: None,
    }
}

#[test]
fn radar_thresholds() {
    assert_eq!(radar(NOW + 8 * DAY, NOW), None);
    assert_eq!(radar(NOW + 7 * DAY + 1, NOW), None);
    assert_eq!(radar(NOW + 7 * DAY, NOW), Some(Urgency::Low));
    assert_eq!(radar(NOW + 3 * DAY + 1, NOW), Some(Urgency::Low));
    assert_eq!(radar(NOW + 3 * DAY, NOW), Some(Urgency::Normal));
    assert_eq!(radar(NOW + DAY + 1, NOW), Some(Urgency::Normal));
    assert_eq!(radar(NOW + DAY, NOW), Some(Urgency::High));
    assert_eq!(radar(NOW + 2 * HOUR + 1, NOW), Some(Urgency::High));
    assert_eq!(radar(NOW + 2 * HOUR, NOW), Some(Urgency::Urgent));
    assert_eq!(radar(NOW - DAY, NOW), Some(Urgency::Urgent));
}

#[test]
fn rule1_mute_of_source_drops() {
    let cfg = Proactive::default();
    let n = row("new", "urgent");
    let m = [mute("notice.items", None, None)];
    assert_eq!(decide(&n, &ctx(&cfg, &m, NOW)), Decision::Drop);
    // Another source's mute does not.
    let other = [mute("mail.items", None, None)];
    assert_eq!(decide(&n, &ctx(&cfg, &other, NOW)), Decision::SayNow);
    // An ended one does not.
    let ended = [mute("notice.items", None, Some(NOW - 1))];
    assert_eq!(decide(&n, &ctx(&cfg, &ended, NOW)), Decision::SayNow);
}

#[test]
fn rule1_mute_topic_is_a_case_insensitive_substring() {
    let cfg = Proactive::default();
    let n = row("new", "normal");
    let hit = [mute("notice.items", Some("electricity"), None)];
    assert_eq!(decide(&n, &ctx(&cfg, &hit, NOW)), Decision::Drop);
    let miss = [mute("notice.items", Some("water"), None)];
    assert_eq!(decide(&n, &ctx(&cfg, &miss, NOW)), Decision::SayNow);
}

#[test]
fn rule2_not_before_holds() {
    let cfg = Proactive::default();
    let mut n = row("new", "urgent");
    n.not_before = Some(NOW + HOUR);
    assert_eq!(
        decide(&n, &ctx(&cfg, &[], NOW)),
        Decision::Hold { until: NOW + HOUR }
    );
    // Once it passes, the rest of the rules apply.
    assert_eq!(decide(&n, &ctx(&cfg, &[], NOW + HOUR)), Decision::SayNow);
}

#[test]
fn rule3_radar_raises_the_row() {
    let cfg = Proactive::default();
    let mut n = row("new", "low");
    assert_eq!(decide(&n, &ctx(&cfg, &[], NOW)), Decision::Brief);
    n.due_at = Some(NOW + 2 * DAY);
    assert_eq!(effective(&n, NOW), Urgency::Normal);
    assert_eq!(decide(&n, &ctx(&cfg, &[], NOW)), Decision::SayNow);
    // The radar never lowers a row.
    let mut far = row("new", "high");
    far.due_at = Some(NOW + 30 * DAY);
    assert_eq!(effective(&far, NOW), Urgency::High);
}

#[test]
fn rule4_said_urgent_repeats_until_seen() {
    let cfg = Proactive::default();
    let mut n = row("said", "urgent");
    n.said_at = Some(NOW - 29 * MIN);
    n.times_said = 1;
    assert_eq!(decide(&n, &ctx(&cfg, &[], NOW)), Decision::Wait);
    n.said_at = Some(NOW - REPEAT_MS);
    assert_eq!(decide(&n, &ctx(&cfg, &[], NOW)), Decision::SayNow);
    n.times_said = REPEAT_TIMES;
    assert_eq!(decide(&n, &ctx(&cfg, &[], NOW)), Decision::Wait);
    n.times_said = 1;
    n.seen_at = Some(NOW - MIN);
    assert_eq!(decide(&n, &ctx(&cfg, &[], NOW)), Decision::Wait);
    // Said and not urgent: waits.
    let mut normal = row("said", "normal");
    normal.said_at = Some(NOW - DAY);
    normal.times_said = 1;
    assert_eq!(decide(&normal, &ctx(&cfg, &[], NOW)), Decision::Wait);
}

#[test]
fn rule5_pause_holds_all_but_urgent() {
    let cfg = Proactive {
        paused_until: Some(NOW + HOUR),
        ..Proactive::default()
    };
    assert_eq!(
        decide(&row("new", "high"), &ctx(&cfg, &[], NOW)),
        Decision::Hold { until: NOW + HOUR }
    );
    assert_eq!(
        decide(&row("held", "urgent"), &ctx(&cfg, &[], NOW)),
        Decision::SayNow
    );
    // An ended pause holds nothing.
    assert_eq!(
        decide(&row("new", "high"), &ctx(&cfg, &[], NOW + HOUR)),
        Decision::SayNow
    );
}

#[test]
fn rule6_quiet_hours_hold_until_they_end() {
    let cfg = Proactive {
        quiet: QUIET_PROPOSED,
        ..Proactive::default()
    };
    // NOW is a whole minute; 02:00 local is five hours before 07:00.
    let now = NOW - NOW.rem_euclid(MIN) + 25_000;
    let mut c = ctx(&cfg, &[], now);
    c.now_local = (2, 0);
    assert_eq!(
        decide(&row("new", "high"), &c),
        Decision::Hold {
            until: now - 25_000 + 5 * HOUR
        }
    );
    assert_eq!(decide(&row("new", "urgent"), &c), Decision::SayNow);
    // 23:30: across midnight, 7 h 30 min.
    c.now_local = (23, 30);
    assert_eq!(
        decide(&row("held", "normal"), &c),
        Decision::Hold {
            until: now - 25_000 + 7 * HOUR + 30 * MIN
        }
    );
    c.now_local = (7, 0);
    assert_eq!(decide(&row("held", "normal"), &c), Decision::SayNow);
}

#[test]
fn rule7_normal_says_low_briefs() {
    let cfg = Proactive::default();
    let c = ctx(&cfg, &[], NOW);
    assert_eq!(decide(&row("new", "low"), &c), Decision::Brief);
    assert_eq!(decide(&row("new", "normal"), &c), Decision::SayNow);
    assert_eq!(decide(&row("held", "high"), &c), Decision::SayNow);
    assert_eq!(decide(&row("new", "nonsense"), &c), Decision::Brief);
    assert_eq!(decide(&row("done", "urgent"), &c), Decision::Wait);
}

#[test]
fn deadline_four_days_out_goes_to_brief_then_rises() {
    let cfg = Proactive::default();
    let mut n = row("new", "low");
    n.due_at = Some(NOW + 4 * DAY);
    assert_eq!(decide(&n, &ctx(&cfg, &[], NOW)), Decision::Brief);
    // Walk the clock an hour at a time until it is first said.
    let mut t = NOW;
    let first = loop {
        if decide(&n, &ctx(&cfg, &[], t)) == Decision::SayNow {
            break t;
        }
        assert!(
            effective(&n, t) < Urgency::High,
            "High before first said, {} h out",
            (NOW + 4 * DAY - t) / HOUR
        );
        t += HOUR;
        assert!(t < NOW + 4 * DAY, "never said");
    };
    assert_eq!(first, NOW + DAY, "said when 3 days were left");
    assert_eq!(effective(&n, first), Urgency::Normal);
    // At 2.5 days out it is Normal and said.
    let mid = NOW + 4 * DAY - (5 * DAY) / 2;
    assert_eq!(effective(&n, mid), Urgency::Normal);
    assert_eq!(decide(&n, &ctx(&cfg, &[], mid)), Decision::SayNow);
}
