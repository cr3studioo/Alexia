// SPDX-License-Identifier: AGPL-3.0-only
//! Follow-through: reminders, check-ins, overnight errands, timers (P3-10).
//!
//! One builtin, `follow_up`, turns "remind me at 6", "check on me after the exam", "look into
//! flights overnight" and "set a 20-minute timer" into a one-shot job (`Trigger::At`) that
//! answers in the chat it was asked in. The job's prompt carries the kind and the owner's words
//! as `follow:<kind>:<json>`, so `Scheduler::fire` knows what to do when it comes due:
//!
//! - `remind` files a notice (source `follow`) that the notice loop says by P3-08's rules, so
//!   quiet hours and the pause still apply. No model turn.
//! - `timer` files one too, raised to Urgent when it would otherwise be held: the owner just
//!   asked for it.
//! - `check_in` runs a brain turn that asks how it went (PR-21); its reply is said as any job's.
//! - `errand` runs a background turn at night; its reply is filed as a Low notice (source
//!   `errand`), which waits for the morning brief (PR-12).
//!
//! `what` is the owner's data: log lines carry job ids only.

use alexia_core::{Origin, ToolOutcome, UndoCall, Urgency};
use alexia_store::{Ms, NewNotice};
use chrono::{Local, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::{next_after_in, outcome, urgency_str, wall_to_ms, Job, Scheduler, Trigger};

/// The tool's name.
pub const TOOL: &str = "follow_up";
/// What starts a follow-up job's prompt.
const MARK: &str = "follow:";
/// The notice source of reminders and timers.
pub const SOURCE: &str = "follow";
/// The notice source of an errand's answer.
pub const ERRAND_SOURCE: &str = "errand";
/// The local hour an errand runs at when no time is given.
pub const ERRAND_HOUR: u8 = 2;

const MIN: Ms = 60_000;

/// What a follow-up becomes when it comes due.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Remind,
    CheckIn,
    Errand,
    Timer,
}

impl Kind {
    fn parse(s: &str) -> Option<Kind> {
        Some(match s {
            "remind" => Kind::Remind,
            "check_in" => Kind::CheckIn,
            "errand" => Kind::Errand,
            "timer" => Kind::Timer,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Remind => "remind",
            Kind::CheckIn => "check_in",
            Kind::Errand => "errand",
            Kind::Timer => "timer",
        }
    }

    /// The kind in words, for `schedule.list`.
    fn words(self) -> &'static str {
        match self {
            Kind::Remind => "reminder",
            Kind::CheckIn => "check-in",
            Kind::Errand => "overnight errand",
            Kind::Timer => "timer",
        }
    }
}

/// What a follow-up job's prompt holds after the kind.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Body {
    what: String,
}

/// A follow-up read back from a job's prompt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Follow {
    pub kind: Kind,
    /// In the owner's words.
    pub what: String,
}

impl Follow {
    /// The job prompt that carries it: `follow:<kind>:<json>`.
    pub fn prompt(&self) -> String {
        let body = serde_json::to_string(&Body {
            what: self.what.clone(),
        })
        .unwrap_or_else(|_| "{}".into());
        format!("{MARK}{}:{body}", self.kind.as_str())
    }

    /// The follow-up a job's prompt carries, if it is one.
    pub fn of(prompt: &str) -> Option<Follow> {
        let (kind, body) = prompt.strip_prefix(MARK)?.split_once(':')?;
        let kind = Kind::parse(kind)?;
        let body: Body = serde_json::from_str(body).ok()?;
        Some(Follow {
            kind,
            what: body.what,
        })
    }

    /// The brain turn's prompt, for the kinds that run one.
    pub fn turn_prompt(&self) -> Option<String> {
        let what = self.what.trim().trim_end_matches(['.', '!', '?']);
        match self.kind {
            Kind::CheckIn => Some(format!(
                "Check in with the owner about: {what}. Ask one short question."
            )),
            Kind::Errand => Some(format!(
                "{what}. Work on this now; your answer goes into the morning brief."
            )),
            Kind::Remind | Kind::Timer => None,
        }
    }
}

/// Whether a job prompt claims to be a follow-up (`schedule.add` may not make one).
pub(crate) fn is_marked(prompt: &str) -> bool {
    prompt.trim_start().starts_with(MARK)
}

/// A follow-up job in words, for `schedule.list`: "reminder: <what>".
pub(crate) fn list_words(prompt: &str) -> Option<String> {
    let f = Follow::of(prompt)?;
    Some(format!("{}: {}", f.kind.words(), f.what))
}

/// `ms` as the owner's local wall time, in the zone the scheduler reads.
fn local(s: &Scheduler, ms: Ms) -> Option<NaiveDateTime> {
    match *s.zone.read().unwrap_or_else(|e| e.into_inner()) {
        Some(tz) => tz
            .timestamp_millis_opt(ms)
            .single()
            .map(|t| t.naive_local()),
        None => Local
            .timestamp_millis_opt(ms)
            .single()
            .map(|t| t.naive_local()),
    }
}

/// A local wall time as epoch ms, in the zone the scheduler reads (DST-safe, as `next_after`).
fn wall(s: &Scheduler, naive: NaiveDateTime) -> Option<Ms> {
    match *s.zone.read().unwrap_or_else(|e| e.into_inner()) {
        Some(tz) => wall_to_ms(&tz, naive),
        None => wall_to_ms(&Local, naive),
    }
}

/// The next local `ERRAND_HOUR`:00 after `now`.
fn tonight(s: &Scheduler, now: Ms) -> Option<Ms> {
    let t = Trigger::Daily {
        hour: ERRAND_HOUR,
        minute: 0,
    };
    match *s.zone.read().unwrap_or_else(|e| e.into_inner()) {
        Some(tz) => next_after_in(&t, now, &tz),
        None => next_after_in(&t, now, &Local),
    }
}

/// "on Fri 27 Nov at 18:00".
fn on_text(s: &Scheduler, ms: Ms) -> String {
    match local(s, ms) {
        Some(t) => t.format("on %a %d %b at %H:%M").to_string(),
        None => "later".into(),
    }
}

fn minutes_text(m: u64) -> String {
    if m == 1 {
        "in 1 minute".into()
    } else {
        format!("in {m} minutes")
    }
}

/// `at` as the owner's local "YYYY-MM-DD HH:MM" (a T may replace the space, seconds optional).
fn at_arg(s: &Scheduler, text: &str) -> Option<Ms> {
    let text = text.trim();
    [
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%dT%H:%M:%S",
    ]
    .iter()
    .find_map(|f| NaiveDateTime::parse_from_str(text, f).ok())
    .and_then(|n| wall(s, n))
}

/// A checked `follow_up` call: what to add, and how to say it back.
#[derive(Debug)]
struct Plan {
    follow: Follow,
    at: Ms,
    urgency: Urgency,
    /// "on Fri 27 Nov at 18:00" or "in 20 minutes".
    when: String,
}

/// Reads the arguments. Err is a sentence for the model.
fn plan(s: &Scheduler, args: &Map<String, Value>, now: Ms) -> Result<Plan, String> {
    let kind = args
        .get("kind")
        .and_then(Value::as_str)
        .and_then(Kind::parse)
        .ok_or("`kind` must be remind, check_in, errand or timer.")?;
    let what = args
        .get("what")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .ok_or(
            "`what` is required: in the owner's words, a sentence that still makes sense later.",
        )?
        .to_string();
    let at = match args.get("at") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_str()
                .and_then(|t| at_arg(s, t))
                .ok_or("`at` must be a local date and time like 2026-03-02 18:00.")?,
        ),
    };
    let minutes = match args.get("in_minutes") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_u64()
                .filter(|m| *m > 0)
                .ok_or("`in_minutes` must be a whole number above 0.")?,
        ),
    };
    let urgency = match args.get("urgency") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            serde_json::from_value::<Urgency>(v.clone())
                .map_err(|_| "`urgency` must be low, normal, high or urgent.")?,
        ),
    };
    if at.is_some() && minutes.is_some() {
        return Err("Give `at` or `in_minutes`, not both.".into());
    }
    let after = |m: u64| -> Result<Ms, String> {
        i64::try_from(m)
            .ok()
            .and_then(|m| m.checked_mul(MIN))
            .and_then(|d| now.checked_add(d))
            .ok_or_else(|| "`in_minutes` is too far away.".to_string())
    };
    let (at, when) = match (at, minutes) {
        (Some(at), _) => (at, on_text(s, at)),
        (None, Some(m)) => (after(m)?, minutes_text(m)),
        (None, None) => match kind {
            Kind::Errand => {
                let at = tonight(s, now).ok_or("I could not work out tonight's time.")?;
                (at, on_text(s, at))
            }
            Kind::Timer => return Err("A timer needs `in_minutes`.".into()),
            Kind::Remind | Kind::CheckIn => return Err(
                "Say when: `at` as a local date and time like 2026-03-02 18:00, or `in_minutes`."
                    .into(),
            ),
        },
    };
    if at <= now {
        return Err(format!(
            "That time has already passed ({}). Give a time still to come.",
            on_text(s, at).trim_start_matches("on ")
        ));
    }
    let urgency = urgency.unwrap_or(match kind {
        Kind::Timer => Urgency::High,
        _ => Urgency::Normal,
    });
    Ok(Plan {
        follow: Follow { kind, what },
        at,
        urgency,
        when,
    })
}

/// The `follow_up` call: adds the job in `origin`'s chat and says when it comes back.
pub(crate) fn call(s: &Scheduler, args: &Map<String, Value>, origin: Origin) -> ToolOutcome {
    let plan = match plan(s, args, s.now()) {
        Ok(p) => p,
        Err(e) => return outcome(e, false, None),
    };
    let prompt = plan.follow.prompt();
    match s.add(Trigger::At { at: plan.at }, &prompt, plan.urgency, origin) {
        Ok(id) => {
            let said = match plan.follow.kind {
                Kind::Remind => format!("I'll come back to it {}.", plan.when),
                Kind::CheckIn => format!("I'll check in {}.", plan.when),
                Kind::Errand => format!("I'll look into it overnight, {}.", plan.when),
                Kind::Timer => format!("I'll ring {}.", plan.when),
            };
            outcome(
                format!("{said} (Follow-up {}.)", id.0),
                true,
                Some(UndoCall {
                    tool: "schedule.cancel".into(),
                    arguments: Map::from_iter([("id".to_string(), json!(id.0))]),
                    summary: format!("Cancel follow-up {}", id.0),
                }),
            )
        }
        Err(e) => outcome(e.to_string(), false, None),
    }
}

/// The tool's schema.
pub(crate) fn params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "kind": {"type": "string", "enum": ["remind", "check_in", "errand", "timer"], "description": "remind: tell the owner `what` at `at`. check_in: ask how `what` went, after it ended. errand: work on `what` overnight; the answer goes into the morning brief. timer: ring after `in_minutes`."},
            "what": {"type": "string", "description": "In the owner's words, a sentence that still makes sense later."},
            "at": {"type": "string", "description": "Local date and time, e.g. 2026-03-02 18:00 (remind, check_in; errand defaults to 02:00 tonight)."},
            "in_minutes": {"type": "integer", "minimum": 1, "description": "Minutes from now (timer; or remind/check_in \"in 20 minutes\")."},
            "urgency": {"type": "string", "enum": ["low", "normal", "high", "urgent"], "description": "Default: timer high, others normal."}
        },
        "required": ["kind", "what"]
    })
}

/// (`Scheduler::fire`) A due reminder or timer: files its notice and asks the notice loop to
/// dispatch it. true when filed.
pub(crate) fn ring(s: &Scheduler, job: &Job, f: &Follow) -> bool {
    let now = s.now();
    let (text, why, urgency) = match f.kind {
        Kind::Timer => {
            // A timer is something the owner just asked for: it rings through quiet hours
            // and the pause, which let only Urgent past.
            let u = if job.urgency < Urgency::Urgent && s.hold_until(job.urgency, now).is_some() {
                Urgency::Urgent
            } else {
                job.urgency
            };
            (format!("⏰ {}", f.what), "You asked me to set a timer.", u)
        }
        _ => (f.what.clone(), "You asked me to remind you.", job.urgency),
    };
    let key = format!("{SOURCE}:{}", job.id.0);
    let notice = NewNotice {
        key: &key,
        source: SOURCE,
        text: &text,
        why,
        urgency: urgency_str(urgency),
        due_at: None,
        not_before: None,
    };
    match s.store.notice_upsert(&notice, now) {
        Ok(_) => {
            s.nudge.notify_one();
            true
        }
        Err(e) => {
            tracing::warn!(job = job.id.0, "a follow-up could not be filed: {e}");
            false
        }
    }
}

/// (`Scheduler::fire`) An errand's answer: a Low notice that waits for the morning brief,
/// never said now.
pub(crate) fn errand_done(s: &Scheduler, job: &Job, text: &str) {
    let now = s.now();
    let key = format!("{ERRAND_SOURCE}:{}", job.id.0);
    let notice = NewNotice {
        key: &key,
        source: ERRAND_SOURCE,
        text,
        why: "An errand you gave me for the night.",
        urgency: urgency_str(Urgency::Low),
        due_at: None,
        not_before: None,
    };
    match s.store.notice_upsert(&notice, now) {
        Ok(_) => s.nudge.notify_one(),
        Err(e) => tracing::warn!(job = job.id.0, "an errand's answer could not be kept: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_round_trips_and_lists_in_words() {
        for kind in [Kind::Remind, Kind::CheckIn, Kind::Errand, Kind::Timer] {
            let f = Follow {
                kind,
                what: "call: mum \"today\"".into(),
            };
            assert_eq!(Follow::of(&f.prompt()), Some(f.clone()));
            assert!(is_marked(&f.prompt()));
        }
        assert_eq!(Follow::of("check the portal"), None);
        assert_eq!(Follow::of("follow:dance:{\"what\":\"x\"}"), None);
        assert_eq!(Follow::of("follow:remind:not json"), None);
        let f = Follow {
            kind: Kind::Errand,
            what: "look into flights".into(),
        };
        assert_eq!(
            list_words(&f.prompt()).as_deref(),
            Some("overnight errand: look into flights")
        );
        assert_eq!(list_words("plain prompt"), None);
    }

    #[test]
    fn turn_prompts() {
        let f = |kind| Follow {
            kind,
            what: "the exam.".into(),
        };
        assert_eq!(
            f(Kind::CheckIn).turn_prompt().as_deref(),
            Some("Check in with the owner about: the exam. Ask one short question.")
        );
        assert_eq!(
            f(Kind::Errand).turn_prompt().as_deref(),
            Some("the exam. Work on this now; your answer goes into the morning brief.")
        );
        assert_eq!(f(Kind::Remind).turn_prompt(), None);
        assert_eq!(f(Kind::Timer).turn_prompt(), None);
    }
}
