// SPDX-License-Identifier: AGPL-3.0-only
//! Routines and repeated tasks noticed, offered as automations or skills (P3-11).
//!
//! Once a week, an hour before the weekly review (and once at start the first time, after a
//! week of messages), the scheduler looks back and notices what nobody told it:
//! - when the owner usually starts the day, when the morning brief comes at another time
//!   (ME-17);
//! - a question asked over and over at the same time of week: an automation (PR-23);
//! - a multi-step task done the same way several times: a skill (PR-24);
//! - notices from one source the owner keeps waving off: a mute (PR-13).
//!
//! Each finding is a `Low` notice from source [`SOURCE`], phrased as an offer, so it lands in
//! the weekly review. Nothing changes until the owner says yes in the chat; the agent then
//! uses the tools it already has (`schedule.add`, the learned-skills offer, `/mute`).
//!
//! Private conversations are left out of every pass. The examples quoted are the owner's own
//! words: they go into the notice and nowhere else (log lines carry counts only).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use alexia_core::{Event, Origin};
use alexia_store::{Ms, MuteRow, NewNotice, NoticeRow, Role, SessionId, Store};
use chrono::{Datelike, Local, NaiveDate, NaiveDateTime, TimeZone, Timelike, Weekday};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast::error::RecvError;
use tokio_util::sync::CancellationToken;

use crate::{wall_to_ms, Proactive, Scheduler};

/// The notices' source.
pub const SOURCE: &str = "pattern";

const NS: &str = "_core";
/// kv `_core`/`activity`: `{"YYYY-MM-DD": [first, last]}`, minutes after local midnight.
pub const ACTIVITY: &str = "activity";
/// kv `_core`/`patterns.last`: when the last pass ran (Ms).
pub const LAST: &str = "patterns.last";
const PRIVATE_SESSIONS: &str = "private_sessions";

const MIN: Ms = 60_000;
const HOUR: Ms = 60 * MIN;
const DAY: Ms = 24 * HOUR;

/// How many local dates of activity are kept.
pub const ACTIVITY_DAYS: usize = 90;
/// A routine needs this many days of each kind.
pub const ROUTINE_DAYS: usize = 5;
/// The brief is offered at the routine start when its times are this far off (minutes).
pub const ROUTINE_OFF_MIN: u16 = 45;
/// Messages older than this are not read.
pub const MESSAGES_MS: Ms = 35 * DAY;
/// An automation: this many messages in this many different weeks...
pub const AUTOMATION_TIMES: usize = 3;
/// ...within this many minutes of each other's time of day...
pub const AUTOMATION_WINDOW_MIN: u16 = 90;
/// ...sharing this much of their words.
pub const AUTOMATION_SHARED: f64 = 0.6;
/// A skill: this many finished runs in [`SKILL_MS`]...
pub const SKILL_TIMES: usize = 3;
pub const SKILL_MS: Ms = 30 * DAY;
/// ...of at least this many steps...
pub const SKILL_STEPS: u32 = 5;
/// ...whose first messages share this much of their words.
pub const SKILL_SHARED: f64 = 0.7;
/// A mute is offered for this many waved-off notices from one source in [`DISMISSED_MS`].
pub const DISMISSED_TIMES: u32 = 3;
pub const DISMISSED_MS: Ms = 14 * DAY;
/// A dropped offer is not made again for this long.
pub const REOFFER_MS: Ms = 60 * DAY;
/// Quoted examples are cut to this many characters.
pub const EXAMPLE_CHARS: usize = 80;
/// A run's first message was written at most this long before the run began.
const RUN_MESSAGE_MS: Ms = 2 * MIN;
/// How many runs are read (the store keeps 200).
const RUNS_READ: u32 = 500;
/// How many notice rows are read.
const NOTICES_READ: u32 = 5_000;

/// Words that say nothing about what was asked.
const STOP: &[&str] = &[
    "a", "about", "alexia", "all", "am", "an", "and", "any", "are", "as", "at", "be", "can",
    "could", "do", "does", "for", "from", "get", "give", "have", "hey", "hi", "how", "i", "if",
    "in", "is", "it", "let", "me", "my", "of", "on", "or", "please", "pls", "s", "so", "tell",
    "that", "the", "there", "this", "to", "up", "us", "was", "we", "what", "whats", "when",
    "where", "which", "who", "will", "with", "would", "you", "your",
];

/// `ms` as the owner's local wall time in `tz`.
fn local<Tz: TimeZone>(tz: &Tz, ms: Ms) -> Option<NaiveDateTime> {
    tz.timestamp_millis_opt(ms)
        .earliest()
        .map(|t| t.naive_local())
}

fn minute_of(t: &NaiveDateTime) -> u16 {
    u16::try_from(t.hour() * 60 + t.minute()).unwrap_or(0)
}

/// kv `_core`/`activity`: per local date, the first and last `Active` time (minutes after
/// midnight), the newest 90 days.
pub(crate) fn record_active(store: &Store, at: Ms, tz: &impl TimeZone) {
    let Some(t) = local(tz, at) else {
        return;
    };
    let date = t.date().to_string();
    let minute = minute_of(&t);
    let done = store.kv_update(NS, ACTIVITY, |had| {
        let mut days = match had {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        };
        let span = days
            .get(&date)
            .and_then(Value::as_array)
            .and_then(|a| Some((a.first()?.as_u64()?, a.get(1)?.as_u64()?)));
        let (first, last) = match span {
            Some((f, l)) => (f.min(u64::from(minute)), l.max(u64::from(minute))),
            None => (u64::from(minute), u64::from(minute)),
        };
        days.insert(date.clone(), json!([first, last]));
        if days.len() > ACTIVITY_DAYS {
            // ISO dates sort by time: the oldest go.
            let mut keys: Vec<String> = days.keys().cloned().collect();
            keys.sort();
            for k in &keys[..keys.len() - ACTIVITY_DAYS] {
                days.remove(k);
            }
        }
        Some(Value::Object(days))
    });
    if let Err(e) = done {
        tracing::warn!("the owner's activity could not be kept: {e}");
    }
}

/// When the owner usually starts and ends the day, in minutes after midnight: the median of
/// at least [`ROUTINE_DAYS`] days, None with fewer.
#[derive(Debug, PartialEq)]
pub struct Routine {
    pub weekday_start: Option<u16>,
    pub weekday_end: Option<u16>,
    pub weekend_start: Option<u16>,
    pub weekend_end: Option<u16>,
}

fn median(mut v: Vec<u16>) -> Option<u16> {
    if v.len() < ROUTINE_DAYS {
        return None;
    }
    v.sort_unstable();
    let mid = v.len() / 2;
    Some(if v.len() % 2 == 1 {
        v[mid]
    } else {
        // Between the two middle ones.
        u16::try_from((u32::from(v[mid - 1]) + u32::from(v[mid])) / 2).unwrap_or(v[mid])
    })
}

/// The routine in `activity` (kv `_core`/`activity`).
pub fn routine(activity: &Value) -> Routine {
    let (mut wd_s, mut wd_e, mut we_s, mut we_e) = (vec![], vec![], vec![], vec![]);
    if let Some(days) = activity.as_object() {
        for (date, span) in days {
            let Ok(d) = date.parse::<NaiveDate>() else {
                continue;
            };
            let Some((first, last)) = span.as_array().and_then(|a| {
                let f = u16::try_from(a.first()?.as_u64()?).ok()?;
                let l = u16::try_from(a.get(1)?.as_u64()?).ok()?;
                Some((f, l))
            }) else {
                continue;
            };
            if matches!(d.weekday(), Weekday::Sat | Weekday::Sun) {
                we_s.push(first);
                we_e.push(last);
            } else {
                wd_s.push(first);
                wd_e.push(last);
            }
        }
    }
    Routine {
        weekday_start: median(wd_s),
        weekday_end: median(wd_e),
        weekend_start: median(we_s),
        weekend_end: median(we_e),
    }
}

/// Something noticed, offered to the owner.
#[derive(Debug, PartialEq)]
pub enum Finding {
    /// ME-17: the brief's earliest/fallback differ from the routine start by ≥ 45 min.
    Routine { start: u16, end: u16 },
    /// PR-23: ≥ 3 user messages in ≥ 3 different weeks, same weekday, within ±90 min, whose
    /// normalised text (lowercase, words only, stop words out) shares ≥ 60% of words.
    /// `weekday` is 1 = Monday .. 7 = Sunday (as `Trigger::Weekly`).
    Automation {
        example: String,
        weekday: u8,
        minute: u16,
    },
    /// PR-24: ≥ 3 finished runs in 30 days with ≥ 5 steps whose first user message normalises
    /// to the same words (≥ 70% shared) and whose tool sequences are equal.
    Skill { example: String, runs: u32 },
    /// PR-13: ≥ 3 notices from one source dismissed (`not_useful` or dropped) in 14 days.
    Dismissed { source: String, count: u32 },
}

fn hhmm(minute: u16) -> String {
    format!("{:02}:{:02}", minute / 60, minute % 60)
}

fn day_name(weekday: u8) -> &'static str {
    match weekday {
        1 => "Monday",
        2 => "Tuesday",
        3 => "Wednesday",
        4 => "Thursday",
        5 => "Friday",
        6 => "Saturday",
        _ => "Sunday",
    }
}

/// A stable short hash of `text`: the first 12 hex digits of its SHA-256.
fn short_hash(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .take(6)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `text` on one line, cut to [`EXAMPLE_CHARS`] characters.
fn quote(text: &str) -> String {
    let one: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= EXAMPLE_CHARS {
        return one;
    }
    let cut: String = one.chars().take(EXAMPLE_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

impl Finding {
    pub fn kind(&self) -> &'static str {
        match self {
            Finding::Routine { .. } => "routine",
            Finding::Automation { .. } => "automation",
            Finding::Skill { .. } => "skill",
            Finding::Dismissed { .. } => "dismissed",
        }
    }

    /// `pattern:<kind>:<stable hash of the example or source>`. An example is hashed by its
    /// normalised words, so the same question asked in other words keeps its key.
    pub fn key(&self) -> String {
        let basis = match self {
            Finding::Routine { .. } => "weekday".to_string(),
            Finding::Automation {
                example, weekday, ..
            } => format!("{weekday}:{}", words_key(example)),
            Finding::Skill { example, .. } => words_key(example),
            Finding::Dismissed { source, .. } => source.clone(),
        };
        format!("{SOURCE}:{}:{}", self.kind(), short_hash(&basis))
    }

    /// The offer the owner reads.
    pub fn text(&self) -> String {
        match self {
            Finding::Routine { start, .. } => format!(
                "You usually start around {} on weekdays. Want the morning brief then?",
                hhmm(*start)
            ),
            Finding::Automation {
                example,
                weekday,
                minute,
            } => format!(
                "You ask “{}” most {}s around {}. Want me to do it on my own each week?",
                quote(example),
                day_name(*weekday),
                hhmm(*minute)
            ),
            Finding::Skill { example, runs } => format!(
                "You've had me “{}” {runs} times the same way. Want me to learn it as a skill?",
                quote(example)
            ),
            Finding::Dismissed { source, count } => {
                format!("You've waved off {count} notes from {source} lately. Shall I stop those?")
            }
        }
    }

    /// One sentence on why it is offered.
    pub fn why(&self) -> String {
        match self {
            Finding::Routine { start, end } => format!(
                "Most weekdays your first word comes around {} and your last around {}.",
                hhmm(*start),
                hhmm(*end)
            ),
            Finding::Automation { weekday, .. } => {
                format!(
                    "You asked this on several {}s in a row.",
                    day_name(*weekday)
                )
            }
            Finding::Skill { runs, .. } => {
                format!("I did it with the same steps {runs} times this month.")
            }
            Finding::Dismissed { count, .. } => {
                format!("{count} of its notes were waved off in the last two weeks.")
            }
        }
    }
}

// ---- the detectors: pure functions over plain inputs ----

/// Lowercase, words only, stop words out.
pub fn normalise(text: &str) -> BTreeSet<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty() && !STOP.contains(w))
        .map(str::to_string)
        .collect()
}

fn words_key(text: &str) -> String {
    normalise(text).into_iter().collect::<Vec<_>>().join(" ")
}

/// How much of their words two texts share: the shared words over the larger set's size
/// (so each shares at least that much of its own). 0 when either has none.
pub fn shared(a: &BTreeSet<String>, b: &BTreeSet<String>) -> f64 {
    let most = a.len().max(b.len());
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let both = a.intersection(b).count();
    // Word counts are small: the casts lose nothing.
    #[allow(clippy::cast_precision_loss)]
    let r = both as f64 / most as f64;
    r
}

/// ME-17: the routine, when the brief comes at other times. The brief goes at the first sign
/// of the owner after `brief_earliest`, or at `brief_fallback`: when neither is within
/// [`ROUTINE_OFF_MIN`] of the routine start, the routine start is offered.
pub fn routine_finding(r: &Routine, cfg: &Proactive) -> Option<Finding> {
    let (start, end) = (r.weekday_start?, r.weekday_end?);
    let at = |(h, m): (u8, u8)| u16::from(h) * 60 + u16::from(m);
    let off = |t: u16| start.abs_diff(t) >= ROUTINE_OFF_MIN;
    (off(at(cfg.brief_earliest)) && off(at(cfg.brief_fallback)))
        .then_some(Finding::Routine { start, end })
}

/// The member whose words come up most (the newest of those): the one quoted.
fn example_of<'a>(members: &[(&'a str, &BTreeSet<String>, Ms)]) -> &'a str {
    let mut count: HashMap<&BTreeSet<String>, usize> = HashMap::new();
    for (_, w, _) in members {
        *count.entry(*w).or_insert(0) += 1;
    }
    members
        .iter()
        .max_by_key(|(_, w, at)| (count[*w], *at))
        .map_or("", |(t, _, _)| t)
}

/// PR-23 over the owner's messages, `(at, text)`, in `tz`. A message is grouped with others
/// on the same local weekday within ±90 min of its time that share ≥ 60% of its words; a group
/// spanning ≥ 3 different weeks is an automation.
pub fn automations<Tz: TimeZone>(messages: &[(Ms, String)], tz: &Tz) -> Vec<Finding> {
    struct M<'a> {
        at: Ms,
        text: &'a str,
        words: BTreeSet<String>,
        weekday: u8,
        minute: u16,
        week: (i32, u32),
    }
    let mut ms: Vec<M> = messages
        .iter()
        .filter_map(|(at, text)| {
            let t = local(tz, *at)?;
            let words = normalise(text);
            if words.is_empty() || text.trim_start().starts_with('/') {
                return None;
            }
            let iso = t.date().iso_week();
            Some(M {
                at: *at,
                text,
                words,
                weekday: u8::try_from(t.weekday().number_from_monday()).unwrap_or(7),
                minute: minute_of(&t),
                week: (iso.year(), iso.week()),
            })
        })
        .collect();
    // Newest first: each group is seeded by its newest message.
    ms.sort_by_key(|m| std::cmp::Reverse(m.at));
    let mut used = vec![false; ms.len()];
    let mut out = Vec::new();
    for i in 0..ms.len() {
        if used[i] {
            continue;
        }
        let seed = &ms[i];
        let group: Vec<usize> = (i..ms.len())
            .filter(|&j| {
                let m = &ms[j];
                !used[j]
                    && m.weekday == seed.weekday
                    && m.minute.abs_diff(seed.minute) <= AUTOMATION_WINDOW_MIN
                    && shared(&m.words, &seed.words) >= AUTOMATION_SHARED
            })
            .collect();
        let weeks: HashSet<(i32, u32)> = group.iter().map(|&j| ms[j].week).collect();
        if group.len() < AUTOMATION_TIMES || weeks.len() < AUTOMATION_TIMES {
            continue;
        }
        for &j in &group {
            used[j] = true;
        }
        let members: Vec<_> = group
            .iter()
            .map(|&j| (ms[j].text, &ms[j].words, ms[j].at))
            .collect();
        let mut minutes: Vec<u16> = group.iter().map(|&j| ms[j].minute).collect();
        minutes.sort_unstable();
        out.push(Finding::Automation {
            example: example_of(&members).to_string(),
            weekday: seed.weekday,
            minute: minutes[minutes.len() / 2],
        });
    }
    out
}

/// A finished run as the skill detector sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct RunShape {
    /// The user message that started it.
    pub first: String,
    /// Its tools, in the order called.
    pub tools: Vec<String>,
    pub steps: u32,
    pub at: Ms,
}

/// PR-24 over finished runs: ≥ 3 in the 30 days before `now`, each of ≥ 5 steps, with equal
/// tool sequences and first messages sharing ≥ 70% of their words.
pub fn skills(runs: &[RunShape], now: Ms) -> Vec<Finding> {
    let mut rs: Vec<(&RunShape, BTreeSet<String>)> = runs
        .iter()
        .filter(|r| r.steps >= SKILL_STEPS && r.at <= now && now.saturating_sub(r.at) <= SKILL_MS)
        .map(|r| (r, normalise(&r.first)))
        .filter(|(_, w)| !w.is_empty())
        .collect();
    rs.sort_by_key(|(r, _)| std::cmp::Reverse(r.at));
    let mut used = vec![false; rs.len()];
    let mut out = Vec::new();
    for i in 0..rs.len() {
        if used[i] {
            continue;
        }
        let (seed, seed_words) = &rs[i];
        let group: Vec<usize> = (i..rs.len())
            .filter(|&j| {
                !used[j]
                    && rs[j].0.tools == seed.tools
                    && shared(&rs[j].1, seed_words) >= SKILL_SHARED
            })
            .collect();
        if group.len() < SKILL_TIMES {
            continue;
        }
        for &j in &group {
            used[j] = true;
        }
        let members: Vec<_> = group
            .iter()
            .map(|&j| (rs[j].0.first.as_str(), &rs[j].1, rs[j].0.at))
            .collect();
        out.push(Finding::Skill {
            example: example_of(&members).to_string(),
            runs: u32::try_from(group.len()).unwrap_or(u32::MAX),
        });
    }
    out
}

/// PR-13 over notice rows: ≥ 3 from one source dismissed (`not_useful` or dropped) in the 14
/// days before `now`. A source already muted, and this module's own offers, are left out.
pub fn dismissed(rows: &[NoticeRow], mutes: &[MuteRow], now: Ms) -> Vec<Finding> {
    let muted: HashSet<&str> = mutes
        .iter()
        .filter(|m| m.topic.is_none() && m.until.is_none_or(|u| u > now))
        .map(|m| m.source.as_str())
        .collect();
    let mut count: HashMap<&str, u32> = HashMap::new();
    let mut seen: HashSet<i64> = HashSet::new();
    for r in rows {
        let waved = r.feedback.as_deref() == Some("not_useful") || r.state == "dropped";
        if waved
            && seen.insert(r.id)
            && r.source != SOURCE
            && !muted.contains(r.source.as_str())
            && r.updated_at <= now
            && now.saturating_sub(r.updated_at) <= DISMISSED_MS
        {
            *count.entry(r.source.as_str()).or_insert(0) += 1;
        }
    }
    let mut out: Vec<Finding> = count
        .into_iter()
        .filter(|(_, n)| *n >= DISMISSED_TIMES)
        .map(|(source, count)| Finding::Dismissed {
            source: source.to_string(),
            count,
        })
        .collect();
    out.sort_by(|a, b| a.key().cmp(&b.key()));
    out
}

// ---- reading the store ----

/// kv `_core`/`private_sessions` (an unreadable list reads as empty, like core's reader).
fn private_sessions(store: &Store) -> HashSet<i64> {
    store
        .kv_get(NS, PRIVATE_SESSIONS)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value::<Vec<i64>>(v).ok())
        .map(|ids| ids.into_iter().collect())
        .unwrap_or_default()
}

/// A user message from the last 35 days.
struct Said {
    at: Ms,
    session: SessionId,
    private: bool,
    text: String,
}

/// Every session's user messages newer than `since` (private ones flagged).
fn user_messages(store: &Store, since: Ms) -> Vec<Said> {
    let private = private_sessions(store);
    let sessions = match store.sessions() {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("the conversations could not be read: {e}");
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for s in sessions {
        if s.updated_at < since {
            continue;
        }
        let history = match store.history(s.id, None) {
            Ok(h) => h,
            Err(e) => {
                tracing::warn!(session = s.id.0, "a conversation could not be read: {e}");
                continue;
            }
        };
        // Oldest first: read back from the newest and stop at the first that is too old.
        for m in history.iter().rev() {
            if m.at < since {
                break;
            }
            if m.role != Role::User {
                continue;
            }
            let text = m.body.content.text();
            if text.trim().is_empty() {
                continue;
            }
            out.push(Said {
                at: m.at,
                session: s.id,
                private: private.contains(&s.id.0),
                text,
            });
        }
    }
    out
}

/// Finished runs of the last 30 days, each with the user message that started it. A run with
/// no such message (a scheduled one) or one from a private chat is left out.
fn run_shapes(store: &Store, said: &[Said], now: Ms) -> Vec<RunShape> {
    let runs = match store.runs(RUNS_READ) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("the runs could not be read: {e}");
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for (id, at, body) in runs {
        if now.saturating_sub(at) > SKILL_MS || body["ended"].as_str() != Some("answered") {
            continue;
        }
        let steps = body["steps"].as_array().map_or(&[][..], Vec::as_slice);
        let n = u32::try_from(steps.len()).unwrap_or(u32::MAX);
        if n < SKILL_STEPS {
            continue;
        }
        let tools: Vec<String> = steps
            .iter()
            .filter_map(|s| s["name"].as_str().map(str::to_string))
            .collect();
        // The audit rows name the run's chat (their args are redacted; only the chat is used).
        let audit = store.audit_for_run(&id).unwrap_or_default();
        if audit.iter().any(|a| {
            matches!(
                serde_json::from_str::<Origin>(&a.origin),
                Ok(Origin::Scheduler { .. })
            )
        }) {
            continue;
        }
        let session = audit.iter().find_map(|a| a.session);
        let first = said
            .iter()
            .filter(|m| {
                m.at <= at
                    && at.saturating_sub(m.at) <= RUN_MESSAGE_MS
                    && session.is_none_or(|s| s == m.session)
            })
            .max_by_key(|m| m.at);
        match first {
            Some(m) if !m.private => out.push(RunShape {
                first: m.text.clone(),
                tools,
                steps: n,
                at,
            }),
            _ => {}
        }
    }
    out
}

/// Everything noticed at `now`, in the owner's zone `tz`.
pub fn find(store: &Store, now: Ms, tz: &impl TimeZone) -> Vec<Finding> {
    let mut out = Vec::new();
    match store.kv_get(NS, ACTIVITY) {
        Ok(Some(a)) => {
            out.extend(routine_finding(&routine(&a), &Proactive::load(store)));
        }
        Ok(None) => {}
        Err(e) => tracing::warn!("the owner's activity could not be read: {e}"),
    }
    let said = user_messages(store, now.saturating_sub(MESSAGES_MS));
    let open: Vec<(Ms, String)> = said
        .iter()
        .filter(|m| !m.private && m.at <= now)
        .map(|m| (m.at, m.text.clone()))
        .collect();
    out.extend(automations(&open, tz));
    out.extend(skills(&run_shapes(store, &said, now), now));
    let rows = store
        .notices_since(now.saturating_sub(DISMISSED_MS), NOTICES_READ)
        .unwrap_or_else(|e| {
            tracing::warn!("the notices could not be read: {e}");
            Vec::new()
        });
    let mutes = store.mutes(now).unwrap_or_else(|e| {
        tracing::warn!("the mutes could not be read: {e}");
        Vec::new()
    });
    out.extend(dismissed(&rows, &mutes, now));
    out
}

/// Files each finding as a `Low` notice. One whose key is live is not filed again, nor one
/// dropped (or done) in the last 60 days. Returns how many were filed.
pub fn offer(store: &Store, findings: &[Finding], now: Ms) -> usize {
    let live: HashSet<String> = match store.notices_live() {
        Ok(l) => l
            .into_iter()
            .filter(|n| n.source == SOURCE)
            .map(|n| n.key)
            .collect(),
        Err(e) => {
            // Not knowing what is live, file nothing: an offer twice is worse than a week late.
            tracing::warn!("the live notices could not be read: {e}");
            return 0;
        }
    };
    let finished: HashSet<String> =
        match store.notices_since(now.saturating_sub(REOFFER_MS), NOTICES_READ) {
            Ok(rows) => rows
                .into_iter()
                .filter(|n| n.source == SOURCE && matches!(n.state.as_str(), "dropped" | "done"))
                .map(|n| n.key)
                .collect(),
            Err(e) => {
                tracing::warn!("the finished notices could not be read: {e}");
                return 0;
            }
        };
    let mut filed = 0;
    for f in findings {
        let key = f.key();
        if live.contains(&key) || finished.contains(&key) {
            continue;
        }
        let (text, why) = (f.text(), f.why());
        let notice = NewNotice {
            key: &key,
            source: SOURCE,
            text: &text,
            why: &why,
            urgency: "low",
            due_at: None,
            not_before: None,
        };
        match store.notice_upsert(&notice, now) {
            Ok((_, created)) => filed += usize::from(created),
            Err(e) => tracing::warn!(kind = f.kind(), "an offer could not be filed: {e}"),
        }
    }
    filed
}

/// One pass: find, offer, and record that it ran. Returns how many offers were filed.
pub fn pass(store: &Store, now: Ms, tz: &impl TimeZone) -> usize {
    let found = find(store, now, tz);
    let filed = offer(store, &found, now);
    if let Err(e) = store.kv_set(NS, LAST, &json!(now)) {
        tracing::warn!("the pattern pass could not be recorded: {e}");
    }
    tracing::info!(found = found.len(), filed, "patterns looked for");
    filed
}

/// Whether the store holds a message at least 7 days old.
fn week_of_messages(store: &Store, now: Ms) -> bool {
    let before = now.saturating_sub(7 * DAY);
    let Ok(sessions) = store.sessions() else {
        return false;
    };
    sessions.iter().filter(|s| s.created_at <= before).any(|s| {
        store
            .history(s.id, None)
            .ok()
            .and_then(|h| h.first().map(|m| m.at))
            .is_some_and(|at| at <= before)
    })
}

/// This week's pass time, an hour before the weekly review (`cfg.weekly`), in `tz`.
fn this_weeks<Tz: TimeZone>(cfg: &Proactive, now: Ms, tz: &Tz) -> Option<Ms> {
    let (wd, h, m) = cfg.weekly?;
    if !(1..=7).contains(&wd) {
        return None;
    }
    let today = local(tz, now)?.date();
    let monday = today - chrono::Days::new(u64::from(today.weekday().num_days_from_monday()));
    let day = monday + chrono::Days::new(u64::from(wd) - 1);
    let review = wall_to_ms(tz, day.and_hms_opt(u32::from(h), u32::from(m), 0)?)?;
    Some(review - HOUR)
}

/// Whether the weekly pass is due at `now`: this week's time has come, the review has not
/// begun, and no pass ran since.
fn due<Tz: TimeZone>(store: &Store, now: Ms, tz: &Tz, last: Option<Ms>) -> bool {
    let Some(at) = this_weeks(&Proactive::load(store), now, tz) else {
        return false;
    };
    at <= now && now < at + HOUR && last.is_none_or(|l| l < at)
}

fn last_pass(store: &Store) -> Option<Ms> {
    store
        .kv_get(NS, LAST)
        .ok()
        .flatten()
        .and_then(|v| v.as_i64())
}

impl Scheduler {
    fn pattern_pass(&self, now: Ms) {
        match *self.zone.read().unwrap_or_else(|e| e.into_inner()) {
            Some(tz) => pass(&self.store, now, &tz),
            None => pass(&self.store, now, &Local),
        };
    }

    fn pattern_due(&self, now: Ms) -> bool {
        let last = last_pass(&self.store);
        match *self.zone.read().unwrap_or_else(|e| e.into_inner()) {
            Some(tz) => due(&self.store, now, &tz, last),
            None => due(&self.store, now, &Local, last),
        }
    }

    fn record(&self, at: Ms) {
        match *self.zone.read().unwrap_or_else(|e| e.into_inner()) {
            Some(tz) => record_active(&self.store, at, &tz),
            None => record_active(&self.store, at, &Local),
        }
    }
}

/// The pattern loop, under `Scheduler::run`'s token: records every `Active`, wakes every
/// whole minute to see whether the weekly pass is due, and runs it once at start when it never
/// ran and there is a week of messages.
pub(crate) async fn run(s: Arc<Scheduler>, cancel: CancellationToken) {
    let mut rx = s.bus.subscribe();
    let mut listening = true;
    if last_pass(&s.store).is_none() && week_of_messages(&s.store, s.now()) {
        s.pattern_pass(s.now());
    }
    loop {
        if cancel.is_cancelled() {
            return;
        }
        let now = s.now();
        if s.pattern_due(now) {
            s.pattern_pass(now);
        }
        let wait = MIN - now.rem_euclid(MIN);
        let sleep = tokio::time::sleep(Duration::from_millis(u64::try_from(wait).unwrap_or(1)));
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                () = cancel.cancelled() => return,
                () = &mut sleep => break,
                got = rx.recv(), if listening => match got {
                    Ok(e) => {
                        if let Event::Active { at, .. } = &*e {
                            s.record(*at);
                        }
                    }
                    Err(RecvError::Lagged(n)) => {
                        // Lost signs of life only blur the routine a little.
                        tracing::warn!(lost = n, "the pattern loop fell behind the bus");
                    }
                    Err(RecvError::Closed) => listening = false,
                },
            }
        }
    }
}
