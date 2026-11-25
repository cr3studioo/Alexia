// SPDX-License-Identifier: AGPL-3.0-only
//! The notices queue: collect `notice.items` from the sources, upsert, raise by the deadline radar (P3-08).
//!
//! Every `collect_every_ms` (and once at start) the sources are asked what might be worth
//! saying; each answer is filed as a notice, deduplicated by (source, key). Then every live
//! notice goes through [`decide`] and is said, held, dropped or left for the brief. The owner's
//! answers (`Event::Feedback`) and signs of life (`Event::Active`) come in over the bus. There
//! is no daily cap (PR-05): quiet hours, pauses, snoozes and mutes are the only brakes.
//!
//! Notice text is the owner's data: log lines carry ids and counts only.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use alexia_core::{Event, JobId, Origin, Verdict};
use alexia_store::{Ms, NewNotice, NoticeRow};
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;
use tokio_util::sync::CancellationToken;

use crate::decide::{decide, effective, urgency_of, DecideCtx, Decision, REPEAT_MS, REPEAT_TIMES};
use crate::{radar, urgency_str, Proactive, Scheduler, Urgency};

/// How many days ahead the sources are asked about.
pub const HORIZON_DAYS: u32 = 14;
/// A notice whose source answered without it this many rounds in a row is done.
pub const VANISH_ROUNDS: u32 = 3;
/// More `SayNow`s than this in one pass go out as one message.
pub const BURST: usize = 3;
/// The source of a capability's items whose Done is passed back (`notice.done`, P3-25).
pub const ITEMS_CAP: &str = "notice.items";
/// The least time between two passes, so a store that keeps failing cannot spin the loop.
const MIN_WAIT: Duration = Duration::from_secs(1);

const NS: &str = "_core";
const LAST_ACTIVE: &str = "last_active";

/// A held job reply's key: `job:<id>:<filed at>:<hold end>:<chat>`. It carries the chat the
/// job answers in, so the release goes back there, and the end of the pause or quiet hours
/// that held it, so that hold is told apart from the owner's Later. It is the one write that
/// holds the reply (`Scheduler::say_or_hold`).
pub(crate) fn job_key(job: JobId, at: Ms, until: Ms, to: &Origin) -> String {
    match serde_json::to_string(to) {
        Ok(to) => format!("job:{}:{at}:{until}:{to}", job.0),
        Err(_) => format!("job:{}:{at}:{until}", job.0),
    }
}

/// A job reply's key, split: (job, filed at, hold end, chat).
fn job_parts(n: &NoticeRow) -> Option<(&str, &str, &str, Option<&str>)> {
    if n.source != "job" {
        return None;
    }
    let mut parts = n.key.strip_prefix("job:")?.splitn(4, ':');
    Some((parts.next()?, parts.next()?, parts.next()?, parts.next()))
}

/// The chat a held job reply goes back to (see [`job_key`]).
pub(crate) fn job_to(n: &NoticeRow) -> Option<Origin> {
    serde_json::from_str(job_parts(n)?.3?).ok()
}

/// The job a held job reply belongs to (see [`job_key`]), so its release still names it.
pub(crate) fn job_of(n: &NoticeRow) -> Option<JobId> {
    let id = n.key.strip_prefix("job:").filter(|_| n.source == "job")?;
    id.split(':').next()?.parse().ok().map(JobId)
}

/// The pause or quiet-hours end a job reply was filed with (see [`job_key`]): a hold of the
/// decider's, not the owner's.
pub(crate) fn job_hold(n: &NoticeRow) -> Option<Ms> {
    job_parts(n)?.2.parse().ok()
}

/// The row as the decider sees it: a `not_before` that is only a pause or quiet-hours hold
/// (a held job reply's) is left out, so those rules are worked out again, with the current
/// settings and urgency, on every pass.
fn decider_view(n: &NoticeRow) -> std::borrow::Cow<'_, NoticeRow> {
    match n.not_before {
        Some(t) if job_hold(n) == Some(t) => std::borrow::Cow::Owned(NoticeRow {
            not_before: None,
            ..n.clone()
        }),
        _ => std::borrow::Cow::Borrowed(n),
    }
}

/// What the loop keeps in memory between passes.
#[derive(Default)]
pub(crate) struct Notices {
    /// Rounds in a row a live notice's source answered without it, by (source, key). A restart
    /// resets them, which only delays closing.
    missed: HashMap<(String, String), u32>,
    /// The owner's last sign of life (also kv `_core`/`last_active`).
    last_active: Option<Ms>,
    /// (source, key) of finished (dropped or done) notices that a source may still offer: not
    /// filed again while it does. Forgotten once its source answers without it.
    closed: HashSet<(String, String)>,
}

/// How far back the finished notices are read at start.
const CLOSED_LOOKBACK_MS: Ms = 30 * 24 * 3_600_000;

/// Counts from one intake pass (tests and log lines).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Intake {
    pub filed: usize,
    pub raised: usize,
    pub closed: usize,
}

impl Notices {
    pub(crate) fn load(s: &Scheduler) -> Notices {
        let mut n = Notices::default();
        n.reload(s);
        let since = s.now().saturating_sub(CLOSED_LOOKBACK_MS);
        match s.store.notices_since(since, 5_000) {
            Ok(rows) => n.closed.extend(
                rows.into_iter()
                    .filter(|r| matches!(r.state.as_str(), "dropped" | "done"))
                    .map(|r| (r.source, r.key)),
            ),
            Err(e) => tracing::warn!("the finished notices could not be read: {e}"),
        }
        n
    }

    /// Re-reads what the store keeps (after a lagged bus).
    fn reload(&mut self, s: &Scheduler) {
        match s.store.kv_get(NS, LAST_ACTIVE) {
            Ok(v) => {
                if let Some(at) = v.and_then(|v| v.as_i64()) {
                    self.last_active = Some(self.last_active.map_or(at, |had| had.max(at)));
                }
            }
            Err(e) => tracing::warn!("the owner's last sign of life could not be read: {e}"),
        }
    }

    /// One round: file what the sources offer, re-apply the radar, close what went away.
    pub(crate) async fn intake(&mut self, s: &Scheduler) -> Intake {
        let now = s.now();
        let items = s.sources.items(now, HORIZON_DAYS).await;
        let mut out = Intake::default();
        let live = match s.store.notices_live() {
            Ok(l) => Some(l),
            Err(e) => {
                tracing::warn!("the live notices could not be read: {e}");
                None
            }
        };
        let find = |source: &str, key: &str| {
            live.as_ref()
                .and_then(|l| l.iter().find(|n| n.source == source && n.key == key))
        };
        let mut answered: HashSet<&str> = HashSet::new();
        let mut seen: HashSet<(&str, &str)> = HashSet::new();
        for (cap, item) in &items {
            answered.insert(cap.as_str());
            seen.insert((cap.as_str(), item.key.as_str()));
            let before = find(cap, &item.key);
            if before.is_none() && self.closed.contains(&(cap.clone(), item.key.clone())) {
                // The owner already dropped or finished it.
                continue;
            }
            let mut u = item.urgency.unwrap_or(Urgency::Low);
            if let Some(r) = item.due_at.and_then(|d| radar(d, now)) {
                u = u.max(r);
            }
            let notice = NewNotice {
                key: &item.key,
                source: cap,
                text: &item.text,
                why: &item.why,
                urgency: urgency_str(u),
                due_at: item.due_at,
                not_before: item.not_before,
            };
            match s.store.notice_upsert(&notice, now) {
                Ok((_, created)) => {
                    out.filed += usize::from(created);
                    if let Some(before) = before {
                        out.raised += usize::from(rise(s, before, u, now));
                    }
                }
                Err(e) => tracing::warn!(source = %cap, "a notice could not be filed: {e}"),
            }
        }
        self.closed.retain(|(src, key)| {
            !answered.contains(src.as_str()) || seen.contains(&(src.as_str(), key.as_str()))
        });
        let Some(live) = live.as_ref() else {
            return out;
        };
        for n in live {
            let here = seen.contains(&(n.source.as_str(), n.key.as_str()));
            // Deadlines rise with the clock even when no source answers.
            if !here {
                out.raised += usize::from(self.reradar(s, n, now));
            }
            let slot = (n.source.clone(), n.key.clone());
            if here {
                self.missed.remove(&slot);
                continue;
            }
            // A source that returned nothing this round did not answer: nothing closes.
            if !matches!(n.state.as_str(), "new" | "held") || !answered.contains(n.source.as_str())
            {
                continue;
            }
            let missed = self.missed.entry(slot.clone()).or_insert(0);
            *missed += 1;
            if *missed >= VANISH_ROUNDS {
                self.missed.remove(&slot);
                match s.store.notice_set(n.id, "done", n.not_before, now) {
                    Ok(_) => out.closed += 1,
                    Err(e) => {
                        tracing::warn!(notice = n.id, "a gone notice could not be closed: {e}")
                    }
                }
            }
        }
        // Forget the counts of notices that are no longer live.
        let alive: HashSet<(&str, &str)> = live
            .iter()
            .map(|n| (n.source.as_str(), n.key.as_str()))
            .collect();
        self.missed
            .retain(|(src, key), _| alive.contains(&(src.as_str(), key.as_str())));
        if out != Intake::default() {
            tracing::info!(
                filed = out.filed,
                raised = out.raised,
                closed = out.closed,
                "notices collected"
            );
        }
        out
    }

    /// Raises a live row the sources did not mention by its deadline. true when it rose.
    fn reradar(&self, s: &Scheduler, n: &NoticeRow, now: Ms) -> bool {
        let Some(r) = n.due_at.and_then(|d| radar(d, now)) else {
            return false;
        };
        let had = urgency_of(&n.urgency);
        if r <= had {
            return false;
        }
        let notice = NewNotice {
            key: &n.key,
            source: &n.source,
            text: &n.text,
            why: &n.why,
            urgency: urgency_str(r),
            due_at: n.due_at,
            not_before: n.not_before,
        };
        if let Err(e) = s.store.notice_upsert(&notice, now) {
            tracing::warn!(notice = n.id, "a deadline could not be raised: {e}");
            return false;
        }
        rise(s, n, r, now);
        true
    }

    /// Decides every live notice and acts on it. Returns when the next one falls due (a hold
    /// ending, an urgent repeat), if any.
    pub(crate) fn dispatch(&mut self, s: &Scheduler) -> Option<Ms> {
        let now = s.now();
        let cfg = Proactive::load(&s.store);
        let mutes = s.store.mutes(now).unwrap_or_else(|e| {
            tracing::warn!("the mutes could not be read: {e}");
            Vec::new()
        });
        let live = match s.store.notices_live() {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!("the live notices could not be read: {e}");
                return None;
            }
        };
        let ctx = DecideCtx {
            now,
            now_local: s.local_now(now),
            cfg: &cfg,
            mutes: &mutes,
            last_active: self.last_active,
        };
        let mut next: Option<Ms> = None;
        let mut soon = |t: Ms| next = Some(next.map_or(t, |n: Ms| n.min(t)));
        let mut say: Vec<(&NoticeRow, Urgency)> = Vec::new();
        for n in &live {
            match decide(&decider_view(n), &ctx) {
                Decision::SayNow => say.push((n, effective(n, now))),
                Decision::Hold { until } => {
                    soon(until);
                    // Only the row's own `not_before` (the owner's Later, the source's) is
                    // stored. A pause or quiet-hours hold is worked out again on every pass,
                    // so a notice that turns Urgent, an early unpause or a shorter quiet
                    // window lets it out at once.
                    if n.state != "held" {
                        if let Err(e) = s.store.notice_set(n.id, "held", n.not_before, now) {
                            tracing::warn!(notice = n.id, "a notice could not be held: {e}");
                        }
                    }
                }
                Decision::Drop => {
                    self.closed.insert((n.source.clone(), n.key.clone()));
                    if let Err(e) = s.store.notice_set(n.id, "dropped", None, now) {
                        tracing::warn!(notice = n.id, "a muted notice could not be dropped: {e}");
                    }
                }
                Decision::Wait => {
                    // An urgent one said and not yet seen is due again later.
                    let again = n.state == "said"
                        && effective(n, now) == Urgency::Urgent
                        && n.seen_at.is_none()
                        && n.times_said < REPEAT_TIMES;
                    if let Some(at) = n.said_at.filter(|_| again) {
                        soon(at.saturating_add(REPEAT_MS));
                    }
                }
                Decision::Brief => {}
            }
        }
        self.say(s, say, now);
        next
    }

    /// Sends what is to be said now: one `Say` per notice, or one for all of them when more
    /// than [`BURST`] go to the owner at once. A held job reply goes back to its own chat.
    /// Each is marked said first; one that cannot be marked is not said (the next pass tries
    /// again), so nothing is said twice.
    fn say(&self, s: &Scheduler, say: Vec<(&NoticeRow, Urgency)>, now: Ms) {
        if say.is_empty() {
            return;
        }
        let mark = |n: &NoticeRow| match s.store.notice_said(n.id, "primary", now) {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!(
                    notice = n.id,
                    "a notice could not be marked said; not said: {e}"
                );
                false
            }
        };
        let one = |n: &NoticeRow, urgency: Urgency, to: Option<Origin>| {
            s.bus.publish(Event::Say {
                at: now,
                text: n.text.clone(),
                urgency,
                job: job_of(n),
                notice: Some(n.id),
                to,
            });
        };
        let mut pooled = Vec::new();
        for (n, u) in say {
            match job_to(n) {
                Some(to) => {
                    if mark(n) {
                        one(n, u, Some(to));
                    }
                }
                None => pooled.push((n, u)),
            }
        }
        if pooled.len() <= BURST {
            for (n, u) in pooled {
                if mark(n) {
                    one(n, u, None);
                }
            }
            return;
        }
        let marked: Vec<_> = pooled.into_iter().filter(|(n, _)| mark(n)).collect();
        let Some((first, _)) = marked.first() else {
            return;
        };
        let urgency = marked.iter().map(|(_, u)| *u).max().unwrap_or(Urgency::Low);
        let text = marked
            .iter()
            .map(|(n, _)| n.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        tracing::info!(
            first = first.id,
            count = marked.len(),
            "notices said as one"
        );
        s.bus.publish(Event::Say {
            at: now,
            text,
            urgency,
            job: None,
            notice: Some(first.id),
            to: None,
        });
    }

    /// The owner answered notice `id`.
    pub(crate) async fn feedback(&mut self, s: &Scheduler, id: i64, verdict: &Verdict) {
        let now = s.now();
        let row = || match s.store.notice(id) {
            Ok(Some(r)) => Ok(r),
            Ok(None) => Err(alexia_store::Error::Invalid(format!("no notice {id}"))),
            Err(e) => Err(e),
        };
        let done = match verdict {
            Verdict::Seen => s.store.notice_seen(id, None, now).map(drop),
            Verdict::Useful => s.store.notice_seen(id, Some("useful"), now).map(drop),
            Verdict::NotUseful => row().and_then(|r| {
                self.closed.insert((r.source, r.key));
                s.store.notice_seen(id, Some("not_useful"), now)?;
                s.store.notice_set(id, "dropped", None, now).map(drop)
            }),
            Verdict::Later { until } => s.store.notice_set(id, "held", Some(*until), now).map(drop),
            Verdict::Mute => row().and_then(|r| {
                s.store.mute_add(&r.source, None, None, now)?;
                self.closed.insert((r.source, r.key));
                s.store.notice_set(id, "dropped", None, now).map(drop)
            }),
            Verdict::Done => match row() {
                Ok(r) => match s.store.notice_set(id, "done", r.not_before, now) {
                    Ok(_) => {
                        self.closed.insert((r.source.clone(), r.key.clone()));
                        if r.source == ITEMS_CAP {
                            // The plugin closes its side too (a commitment kept, P3-25).
                            s.sources.done(&r.key).await;
                        }
                        Ok(())
                    }
                    Err(e) => Err(e),
                },
                Err(e) => Err(e),
            },
        };
        if let Err(e) = done {
            tracing::warn!(notice = id, "the owner's answer could not be recorded: {e}");
        }
    }

    /// A sign of the owner.
    pub(crate) fn active(&mut self, s: &Scheduler, at: Ms) {
        if self.last_active.is_some_and(|had| had >= at) {
            return;
        }
        self.last_active = Some(at);
        if let Err(e) = s.store.kv_set(NS, LAST_ACTIVE, &json!(at)) {
            tracing::warn!("the owner's last sign of life could not be kept: {e}");
        }
    }

    /// Handles one bus event. true when it calls for a dispatch.
    async fn on_event(&mut self, s: &Scheduler, e: &Event) -> bool {
        match e {
            Event::Feedback {
                notice, verdict, ..
            } => {
                self.feedback(s, *notice, verdict).await;
                true
            }
            Event::Active { at, .. } => {
                self.active(s, *at);
                true
            }
            // The owner may have paused, unpaused or changed quiet hours.
            Event::SettingsChanged { owner, .. } => owner == NS,
            _ => false,
        }
    }
}

/// A said notice whose urgency rose to High or Urgent goes back to `new`, so the rise is said.
fn rise(s: &Scheduler, before: &NoticeRow, u: Urgency, now: Ms) -> bool {
    let rose = before.state == "said" && u >= Urgency::High && u > urgency_of(&before.urgency);
    if rose {
        if let Err(e) = s.store.notice_set(before.id, "new", before.not_before, now) {
            tracing::warn!(
                notice = before.id,
                "a risen notice could not be reopened: {e}"
            );
            return false;
        }
    }
    rose
}

/// The notice loop, under `Scheduler::run`'s cancel token: intake every `collect_every_ms`
/// and once at start, dispatch after each intake, on every `Feedback`/`Active`, when a hold
/// ends and when nudged (a job reply was held).
pub(crate) async fn run(s: Arc<Scheduler>, cancel: CancellationToken) {
    let mut rx = s.bus.subscribe();
    let mut listening = true;
    let mut state = Notices::load(&s);
    let mut next_collect = s.now();
    loop {
        if cancel.is_cancelled() {
            return;
        }
        if s.now() >= next_collect {
            state.intake(&s).await;
            let every = Proactive::load(&s.store).collect_every_ms.max(60_000);
            next_collect = s
                .now()
                .saturating_add(i64::try_from(every).unwrap_or(i64::MAX));
        }
        let due = state.dispatch(&s);
        let wake = due.map_or(next_collect, |d| d.min(next_collect));
        let wait = Duration::from_millis(u64::try_from(wake - s.now()).unwrap_or(0)).max(MIN_WAIT);
        let sleep = tokio::time::sleep(wait);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                () = cancel.cancelled() => return,
                () = &mut sleep => break,
                () = s.nudge.notified() => break,
                got = rx.recv(), if listening => match got {
                    Ok(e) => {
                        if state.on_event(&s, &e).await {
                            break;
                        }
                    }
                    Err(RecvError::Lagged(n)) => {
                        // Lost events: the store has what matters.
                        tracing::warn!(lost = n, "the notice loop fell behind the bus; re-reading");
                        state.reload(&s);
                        break;
                    }
                    Err(RecvError::Closed) => listening = false,
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_key_keeps_the_chat() {
        let to = Origin::Channel {
            channel: "telegram".into(),
            chat: "42:x".into(),
        };
        let key = job_key(JobId(7), 1_000, 5_000, &to);
        let row = NoticeRow {
            id: 1,
            key,
            source: "job".into(),
            text: String::new(),
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
        assert_eq!(job_to(&row), Some(to));
        assert_eq!(job_of(&row), Some(JobId(7)));
        assert_eq!(job_hold(&row), Some(5_000));
        // The hold it was filed with is the decider's: worked out again, not kept.
        let filed = NoticeRow {
            not_before: Some(5_000),
            ..row.clone()
        };
        assert_eq!(decider_view(&filed).not_before, None);
        // The owner's Later is kept.
        let later = NoticeRow {
            not_before: Some(9_000),
            ..row.clone()
        };
        assert_eq!(decider_view(&later).not_before, Some(9_000));
        // Another source's key is never read as a chat.
        let other = NoticeRow {
            source: "notice.items".into(),
            ..row.clone()
        };
        assert_eq!(job_to(&other), None);
        assert_eq!(job_of(&other), None);
        assert_eq!(job_hold(&other), None);
        let sourced = NoticeRow {
            not_before: Some(5_000),
            ..other.clone()
        };
        assert_eq!(decider_view(&sourced).not_before, Some(5_000));
        // An old key without a chat has none.
        let old = NoticeRow {
            key: "job:7:1000".into(),
            ..row
        };
        assert_eq!(job_to(&old), None);
        assert_eq!(job_of(&old), Some(JobId(7)));
        assert_eq!(job_hold(&old), None);
    }
}
