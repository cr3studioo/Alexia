// SPDX-License-Identifier: AGPL-3.0-only
//! The morning, evening, weekly and "while you were away" briefs, composed by code (P3-09).
//!
//! PHASE.md D-P3-4: no model writes a brief, so it always arrives. [`compose`] is a pure
//! function of the parts; [`Scheduler::brief_now`] gathers them and says the result; [`run`]
//! is the clock that decides when each one is due (`_core`/`brief.last` keeps what was said).
//!
//! The brief's text is the owner's data: log lines carry kinds and counts only.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use alexia_core::{Event, Urgency};
use alexia_store::{AuditRow, Ms, NoticeRow};
use chrono::{Datelike, FixedOffset, Local, NaiveDate, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast::error::RecvError;
use tokio_util::sync::CancellationToken;

use crate::decide::{decide, mutes, DecideCtx, Decision};
use crate::notices::decider_view;
use crate::{held, invalid, json_err, wall_to_ms, Proactive, Result, Scheduler};

const MIN: Ms = 60_000;
const HOUR: Ms = 60 * MIN;
const DAY: Ms = 24 * HOUR;

/// At most this many characters: one Telegram message.
pub const MAX_CHARS: usize = 3500;
/// "While you were away" needs at least this long without a sign of the owner, and comes at
/// most this often.
pub const AWAY_MS: Ms = 4 * HOUR;

const NS: &str = "_core";
/// What was said last, by kind (local dates): `{"morning": "YYYY-MM-DD", "evening": ..,
/// "weekly": "YYYY-Www", "away": Ms, "at": Ms}`. `at` is the last brief of any kind.
pub const LAST: &str = "brief.last";
/// A brief asked for from outside (`alexia-hub brief --now`): `{"kind": .., "at": Ms}`.
pub const ASK: &str = "brief.ask";
const LAST_ACTIVE: &str = "last_active";

/// The evening's journal question, answered in the chat like any message.
const JOURNAL: &str = "Anything I should remember from today?";

/// Everything a brief is made of, gathered by [`Scheduler::brief_now`].
pub(crate) struct BriefParts {
    /// `brief.section` texts, each as given.
    pub sections: Vec<String>,
    /// Kept for the brief (and, for "away", said-not-seen and held).
    pub notices: Vec<NoticeRow>,
    /// Deadlines coming up, soonest first.
    pub radar: Vec<NoticeRow>,
    /// What she did on her own since `since` (PR-26).
    pub silent: Vec<AuditRow>,
    pub since: Ms,
    /// The zone dates and times are shown in: None is the machine's own.
    pub zone: Option<FixedOffset>,
}

/// `ms` as the owner's local wall time in `zone` (None: the machine's).
pub(crate) fn local_at(zone: Option<FixedOffset>, ms: Ms) -> Option<NaiveDateTime> {
    match zone {
        Some(tz) => tz
            .timestamp_millis_opt(ms)
            .single()
            .map(|t| t.naive_local()),
        None => Local
            .timestamp_millis_opt(ms)
            .earliest()
            .map(|t| t.naive_local()),
    }
}

/// A local wall time in `zone` as epoch ms (a time in a DST gap moves an hour on).
fn ms_at(zone: Option<FixedOffset>, naive: NaiveDateTime) -> Option<Ms> {
    match zone {
        Some(tz) => wall_to_ms(&tz, naive),
        None => wall_to_ms(&Local, naive),
    }
}

/// "2026-W19".
fn iso_week(d: NaiveDate) -> String {
    let w = d.iso_week();
    format!("{}-W{:02}", w.year(), w.week())
}

fn opening(kind: &str) -> &'static str {
    match kind {
        "evening" => "Evening wrap-up.",
        "weekly" => "Your week.",
        "away" => "While you were away:",
        _ => "Good morning.",
    }
}

/// One part of the brief: an optional heading, lines that may be cut from the end, and how
/// many were cut.
struct Block {
    head: Option<String>,
    lines: Vec<String>,
    /// The notice each line lists (radar and notices only; empty for the other parts).
    ids: Vec<i64>,
    cut: usize,
}

impl Block {
    fn render(&self) -> String {
        let mut out: Vec<String> = self.head.iter().cloned().collect();
        out.extend(self.lines.iter().cloned());
        if self.cut > 0 {
            out.push(format!("…and {} more", self.cut));
        }
        out.join("\n")
    }

    fn is_empty(&self) -> bool {
        self.lines.is_empty() && self.cut == 0
    }
}

fn render(open: &str, blocks: &[Block], close: Option<&str>) -> String {
    let mut parts = vec![open.to_string()];
    parts.extend(blocks.iter().filter(|b| !b.is_empty()).map(Block::render));
    parts.extend(close.map(str::to_string));
    parts.join("\n\n")
}

/// A composed brief: its text, and the notices it lists (radar and notices). A notice cut to
/// "…and N more" is not in `listed`: it was not shown, so it is not marked said.
pub(crate) struct Composed {
    pub text: String,
    pub listed: Vec<i64>,
}

/// Plain text, at most [`MAX_CHARS`] characters (one Telegram message; longer parts are cut
/// with "…and N more" lines, never mid-line).
pub(crate) fn compose(kind: &str, parts: &BriefParts, now_local: NaiveDateTime) -> Composed {
    let local = |ms: Ms| local_at(parts.zone, ms);
    let mut blocks: Vec<Block> = parts
        .sections
        .iter()
        .map(|s| Block {
            head: None,
            lines: s
                .lines()
                .map(str::trim_end)
                .filter(|l| !l.trim().is_empty())
                .map(str::to_string)
                .collect(),
            ids: Vec::new(),
            cut: 0,
        })
        .collect();
    blocks.push(Block {
        head: Some("Coming up:".into()),
        lines: parts
            .radar
            .iter()
            .map(|n| match n.due_at.and_then(local) {
                Some(d) => format!("• {} ({})", one_line(&n.text), d.format("%a %-d %b")),
                None => format!("• {}", one_line(&n.text)),
            })
            .collect(),
        ids: parts.radar.iter().map(|n| n.id).collect(),
        cut: 0,
    });
    blocks.push(Block {
        head: None,
        lines: parts
            .notices
            .iter()
            .map(|n| format!("• {}", one_line(&n.text)))
            .collect(),
        ids: parts.notices.iter().map(|n| n.id).collect(),
        cut: 0,
    });
    let since = match local(parts.since) {
        Some(t) if t.date() == now_local.date() => t.format("%H:%M").to_string(),
        Some(t) => t.format("%a %-d %b %H:%M").to_string(),
        None => "the last brief".into(),
    };
    blocks.push(Block {
        head: Some(format!("Done on my own since {since}:")),
        lines: parts
            .silent
            .iter()
            .map(|a| {
                let words = a
                    .why
                    .as_deref()
                    .map(str::trim)
                    .filter(|w| !w.is_empty())
                    .unwrap_or(&a.tool);
                format!("• {}", one_line(words))
            })
            .collect(),
        ids: Vec::new(),
        cut: 0,
    });
    let close = (kind == "evening").then_some(JOURNAL);
    let open = opening(kind);
    let done = |text: String, blocks: &[Block]| Composed {
        text,
        listed: blocks.iter().flat_map(|b| b.ids.iter().copied()).collect(),
    };
    loop {
        let text = render(open, &blocks, close);
        if text.chars().count() <= MAX_CHARS {
            return done(text, &blocks);
        }
        // Cut one line from the end of the longest part that still has lines.
        let longest = blocks
            .iter_mut()
            .filter(|b| !b.lines.is_empty())
            .max_by_key(|b| b.lines.iter().map(|l| l.chars().count() + 1).sum::<usize>());
        match longest {
            Some(b) => {
                b.lines.pop();
                b.ids.truncate(b.lines.len());
                b.cut += 1;
            }
            // Only headings and "…and N more" lines are left; they always fit in practice,
            // and are never cut mid-line.
            None => return done(text, &blocks),
        }
    }
}

/// A notice's text on one line, so cutting by lines stays exact.
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// kv `_core`/`brief.last`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Last {
    pub morning: Option<String>,
    pub evening: Option<String>,
    pub weekly: Option<String>,
    pub away: Option<Ms>,
    pub at: Option<Ms>,
}

impl Last {
    fn load(s: &Scheduler) -> Last {
        match s.store.kv_get(NS, LAST) {
            Ok(Some(v)) => serde_json::from_value(v).unwrap_or_else(|_| {
                tracing::warn!("_core.brief.last could not be read; starting afresh");
                Last::default()
            }),
            Ok(None) => Last::default(),
            Err(e) => {
                tracing::warn!("_core.brief.last could not be read: {e}");
                Last::default()
            }
        }
    }
}

const KINDS: [&str; 4] = ["morning", "evening", "weekly", "away"];

impl Scheduler {
    /// Compose and say a brief of `kind` now ("morning" | "evening" | "weekly" | "away").
    pub async fn brief_now(&self, kind: &str) -> Result<()> {
        self.brief(kind, true, None).await.map(drop)
    }

    /// Gathers, composes and says a brief. A brief with nothing in it is not said when `empty_ok`
    /// is false (the clock's), but still counted as given. `away_since` is the owner's sign of
    /// life before this one ("away" from the clock). true when one was said.
    async fn brief(&self, kind: &str, empty_ok: bool, away_since: Option<Ms>) -> Result<bool> {
        if !KINDS.contains(&kind) {
            return Err(invalid(
                "A brief is morning, evening, weekly or away (while you were away).",
            ));
        }
        let now = self.now();
        let zone = *self.zone.read().unwrap_or_else(|e| e.into_inner());
        let now_local = local_at(zone, now).ok_or_else(|| invalid("The local time is unknown."))?;
        let mut last = Last::load(self);
        let parts = self
            .parts(kind, now, now_local, zone, &last, away_since)
            .await?;
        let empty = parts.sections.is_empty()
            && parts.notices.is_empty()
            && parts.radar.is_empty()
            && parts.silent.is_empty();
        let said = !empty || empty_ok || kind == "evening";
        if said {
            let Composed { mut text, listed } = compose(kind, &parts, now_local);
            if empty && kind != "evening" {
                text.push_str("\n\nNothing new.");
            }
            // Marked first, like the notice loop: one that cannot be marked is still listed
            // (the brief must go out) and may be listed again. Only the ones listed: those cut
            // to "…and N more" stay as they were and come in the next brief.
            let mut marked = HashSet::new();
            for id in listed {
                if marked.insert(id) {
                    if let Err(e) = self.store.notice_said(id, "brief", now) {
                        tracing::warn!(notice = id, "a briefed notice could not be marked: {e}");
                    }
                }
            }
            self.bus.publish(Event::Say {
                at: now,
                text,
                urgency: Urgency::Normal,
                job: None,
                notice: None,
                to: None,
            });
            tracing::info!(
                kind,
                sections = parts.sections.len(),
                notices = parts.notices.len(),
                radar = parts.radar.len(),
                silent = parts.silent.len(),
                "brief said"
            );
        }
        let today = now_local.date();
        match kind {
            "morning" => last.morning = Some(today.to_string()),
            "evening" => last.evening = Some(today.to_string()),
            "weekly" => last.weekly = Some(iso_week(today)),
            _ => last.away = Some(now),
        }
        if said {
            last.at = Some(now);
        }
        self.store
            .kv_set(NS, LAST, &serde_json::to_value(&last).map_err(json_err)?)?;
        Ok(said)
    }

    async fn parts(
        &self,
        kind: &str,
        now: Ms,
        now_local: NaiveDateTime,
        zone: Option<FixedOffset>,
        last: &Last,
        away_since: Option<Ms>,
    ) -> Result<BriefParts> {
        let cfg = Proactive::load(&self.store);
        let mute_rows = self.store.mutes(now)?;
        let live = self.store.notices_live()?;
        let last_active = self
            .store
            .kv_get(NS, LAST_ACTIVE)
            .ok()
            .flatten()
            .and_then(|v| v.as_i64());
        let ctx = DecideCtx {
            now,
            now_local: self.local_now(now),
            cfg: &cfg,
            mutes: &mute_rows,
            last_active,
        };
        // The owner's Later (or a source's not-before) still to come: not listed anywhere.
        let waiting = |n: &NoticeRow| decider_view(n).not_before.is_some_and(|t| t > now);
        // Who offered a plugin notice is the notice loop's to know: it drops the ones a
        // per-provider mute covers (P3-38), so they are not live here.
        let muted = |n: &NoticeRow| mute_rows.iter().any(|m| mutes(m, n, None, now));
        // Deadlines first: a notice with one coming up is listed there, with its date.
        let tomorrow = now_local.date().succ_opt();
        let mut radar: Vec<NoticeRow> = match kind {
            "morning" | "weekly" | "evening" => live
                .iter()
                .filter(|n| !muted(n) && !waiting(n))
                .filter(|n| {
                    n.due_at.is_some_and(|d| {
                        if kind == "evening" {
                            local_at(zone, d).map(|t| t.date()) == tomorrow
                        } else {
                            d >= now && d <= now + 7 * DAY
                        }
                    })
                })
                .cloned()
                .collect(),
            _ => Vec::new(),
        };
        let mut notices: Vec<NoticeRow> = live
            .iter()
            .filter(|n| !radar.iter().any(|r| r.id == n.id))
            .filter(|n| decide(&decider_view(n), &ctx) == Decision::Brief)
            .cloned()
            .collect();
        if kind == "away" {
            // Asked for by hand: what was said since the last brief.
            let since = away_since.or(last.at).unwrap_or(now - DAY);
            notices.extend(
                live.iter()
                    .filter(|n| !muted(n) && !waiting(n))
                    .filter(|n| away_news(n, since))
                    .filter(|n| !notices.iter().any(|m| m.id == n.id))
                    .cloned()
                    .collect::<Vec<_>>(),
            );
        }
        radar.sort_by_key(|n| (n.due_at, n.id));
        let sections = if kind == "away" {
            Vec::new()
        } else {
            self.sources.sections(kind, now).await
        };
        let since = last.at.unwrap_or(now - DAY);
        let silent = self.store.audit_scheduled_since(since)?;
        Ok(BriefParts {
            sections,
            notices,
            radar,
            silent,
            since,
            zone,
        })
    }
}

/// News for "while you were away" since `since` (the last `Active`): said and not seen since
/// then, or held since then. The store keeps no time a hold began (`updated_at` moves with
/// every offer of the same notice), so a held notice counts when it came in since `since`:
/// one held from before the owner's last sign of life is not news of this absence.
fn away_news(n: &NoticeRow, since: Ms) -> bool {
    match n.state.as_str() {
        "said" => n.seen_at.is_none() && n.said_at.is_some_and(|t| t >= since),
        "held" => n.created_at >= since,
        _ => false,
    }
}

/// What the clock remembers between ticks.
struct Clock {
    /// When the clock started: a time crossed before it is not caught up (a hub off at 21:00
    /// has no wrap-up to give at 23:00). The morning still comes with the first sign of life.
    started: Ms,
    /// The owner's last sign of life.
    last_active: Option<Ms>,
}

impl Clock {
    /// The brief due now, if any (asked ones first).
    fn due(&self, s: &Scheduler, now: Ms) -> Option<String> {
        let zone = *s.zone.read().unwrap_or_else(|e| e.into_inner());
        let local = local_at(zone, now)?;
        let today = local.date();
        let cfg = Proactive::load(&s.store);
        let last = Last::load(s);
        // Never in quiet hours, nor while the owner said "not now".
        let quiet = held(s.local_now(now), &cfg.quiet, Urgency::Normal);
        let paused = cfg.paused_until.is_some_and(|p| p > now);
        if quiet || paused {
            return None;
        }
        let crossed =
            |naive: NaiveDateTime| ms_at(zone, naive).is_some_and(|t| t > self.started && t <= now);
        let at_hm = |d: NaiveDate, (h, m): (u8, u8)| d.and_hms_opt(u32::from(h), u32::from(m), 0);
        // Morning: the first sign of the owner at or after `brief_earliest`, or `brief_fallback`.
        if last.morning.as_deref() != Some(&today.to_string()) {
            let earliest = at_hm(today, cfg.brief_earliest);
            let woke = self
                .last_active
                .and_then(|a| local_at(zone, a))
                .is_some_and(|a| a.date() == today && earliest.is_some_and(|e| a >= e));
            if woke || at_hm(today, cfg.brief_fallback).is_some_and(crossed) {
                return Some("morning".into());
            }
        }
        if let Some(hm) = cfg.evening {
            if last.evening.as_deref() != Some(&today.to_string())
                && at_hm(today, hm).is_some_and(crossed)
            {
                return Some("evening".into());
            }
        }
        if let Some((wd, h, m)) = cfg.weekly {
            let monday =
                today - chrono::Days::new(u64::from(today.weekday().num_days_from_monday()));
            let day = (1..=7)
                .contains(&wd)
                .then(|| monday + chrono::Days::new(u64::from(wd) - 1));
            if last.weekly.as_deref() != Some(&iso_week(today))
                && day.and_then(|d| at_hm(d, (h, m))).is_some_and(crossed)
            {
                return Some("weekly".into());
            }
        }
        None
    }

    /// A brief asked for from outside, newer than the last one: its kind, and the key is gone.
    fn asked(s: &Scheduler) -> Option<String> {
        let v = match s.store.kv_get(NS, ASK) {
            Ok(Some(v)) => v,
            Ok(None) => return None,
            Err(e) => {
                tracing::warn!("_core.brief.ask could not be read: {e}");
                return None;
            }
        };
        let kind = v
            .get("kind")
            .and_then(Value::as_str)
            .filter(|k| KINDS.contains(k))
            .unwrap_or("morning")
            .to_string();
        let at = v.get("at").and_then(Value::as_i64).unwrap_or(0);
        let newer = Last::load(s).at.is_none_or(|l| at > l);
        if let Err(e) = s.store.kv_delete(NS, ASK) {
            tracing::warn!("_core.brief.ask could not be cleared: {e}");
            // Not cleared: not said either, or it would be said every minute.
            return None;
        }
        newer.then_some(kind)
    }

    /// The owner came back at `at`: "while you were away" if they were gone 4 h and there is
    /// news, unless the morning brief is the one to give.
    async fn away(&self, s: &Scheduler, at: Ms) {
        let Some(prev) = self.last_active else {
            return;
        };
        if at.saturating_sub(prev) < AWAY_MS {
            return;
        }
        let zone = *s.zone.read().unwrap_or_else(|e| e.into_inner());
        let Some(local) = local_at(zone, at) else {
            return;
        };
        let cfg = Proactive::load(&s.store);
        let last = Last::load(s);
        if last.away.is_some_and(|a| at.saturating_sub(a) < AWAY_MS) {
            return;
        }
        // The morning window: from `brief_earliest` until the morning brief is given.
        let earliest = local.date().and_hms_opt(
            u32::from(cfg.brief_earliest.0),
            u32::from(cfg.brief_earliest.1),
            0,
        );
        if last.morning.as_deref() != Some(&local.date().to_string())
            && earliest.is_some_and(|e| local >= e)
        {
            return;
        }
        if held(s.local_now(at), &cfg.quiet, Urgency::Normal)
            || cfg.paused_until.is_some_and(|p| p > at)
        {
            return;
        }
        let news = match s.store.notices_live() {
            Ok(live) => live.iter().any(|n| away_news(n, prev)),
            Err(e) => {
                tracing::warn!("the live notices could not be read: {e}");
                false
            }
        };
        if news {
            if let Err(e) = s.brief("away", false, Some(prev)).await {
                tracing::warn!("the away brief could not be given: {e}");
            }
        }
    }
}

/// The brief clock, under `Scheduler::run`'s token: wakes every whole minute and on every
/// `Active`, and gives the brief that is due.
pub(crate) async fn run(s: Arc<Scheduler>, cancel: CancellationToken) {
    let mut rx = s.bus.subscribe();
    let mut listening = true;
    let mut clock = Clock {
        started: s.now(),
        last_active: s
            .store
            .kv_get(NS, LAST_ACTIVE)
            .ok()
            .flatten()
            .and_then(|v| v.as_i64()),
    };
    loop {
        if cancel.is_cancelled() {
            return;
        }
        let now = s.now();
        if let Some(kind) = Clock::asked(&s) {
            if let Err(e) = s.brief(&kind, true, None).await {
                tracing::warn!(kind, "an asked-for brief could not be given: {e}");
            }
        }
        // One at a time: each is recorded before the next is looked at.
        while let Some(kind) = clock.due(&s, now) {
            if let Err(e) = s.brief(&kind, false, None).await {
                tracing::warn!(kind, "a brief could not be given: {e}");
                break;
            }
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
                            let at = *at;
                            clock.away(&s, at).await;
                            if clock.last_active.is_none_or(|had| at > had) {
                                clock.last_active = Some(at);
                            }
                            break;
                        }
                    }
                    Err(RecvError::Lagged(_)) => {}
                    Err(RecvError::Closed) => listening = false,
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tz() -> Option<FixedOffset> {
        FixedOffset::east_opt(3600)
    }

    fn at(d: u32, h: u32, m: u32) -> Ms {
        tz().unwrap()
            .with_ymd_and_hms(2026, 5, d, h, m, 0)
            .unwrap()
            .timestamp_millis()
    }

    fn row(id: i64, text: &str, due_at: Option<Ms>) -> NoticeRow {
        NoticeRow {
            id,
            key: format!("k{id}"),
            source: "notice.items".into(),
            text: text.into(),
            why: String::new(),
            urgency: "low".into(),
            due_at,
            not_before: None,
            state: "new".into(),
            created_at: 0,
            updated_at: 0,
            said_at: None,
            said_via: None,
            times_said: 0,
            seen_at: None,
            feedback: None,
        }
    }

    fn audit(tool: &str, why: Option<&str>) -> AuditRow {
        AuditRow {
            id: 0,
            at: 0,
            run: "r".into(),
            session: None,
            origin: "{\"kind\":\"scheduler\",\"job\":1}".into(),
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
        }
    }

    fn parts() -> BriefParts {
        BriefParts {
            sections: vec!["Today: 3 meetings.\nFirst at 9:00.".into()],
            notices: vec![row(1, "Reply to Tom", None)],
            radar: vec![row(2, "Tax return", Some(at(8, 12, 0)))],
            silent: vec![
                audit("mail.archive", Some("Archived 4 newsletters")),
                audit("files.tidy", None),
            ],
            since: at(4, 7, 0),
            zone: tz(),
        }
    }

    fn now_local() -> NaiveDateTime {
        local_at(tz(), at(4, 21, 0)).unwrap()
    }

    #[test]
    fn compose_puts_the_parts_in_order() {
        let text = compose("morning", &parts(), now_local()).text;
        assert_eq!(
            text,
            "Good morning.\n\n\
             Today: 3 meetings.\nFirst at 9:00.\n\n\
             Coming up:\n• Tax return (Fri 8 May)\n\n\
             • Reply to Tom\n\n\
             Done on my own since 07:00:\n• Archived 4 newsletters\n• files.tidy"
        );
    }

    #[test]
    fn evening_asks_the_journal_question_and_empty_parts_are_left_out() {
        let p = BriefParts {
            sections: vec![],
            notices: vec![],
            radar: vec![],
            silent: vec![],
            since: at(3, 21, 0),
            zone: tz(),
        };
        assert_eq!(
            compose("evening", &p, now_local()).text,
            "Evening wrap-up.\n\nAnything I should remember from today?"
        );
        assert_eq!(compose("weekly", &p, now_local()).text, "Your week.");
        assert_eq!(
            compose("away", &p, now_local()).text,
            "While you were away:"
        );
    }

    #[test]
    fn since_another_day_names_the_day() {
        let p = BriefParts {
            since: at(3, 21, 0),
            ..parts()
        };
        assert!(compose("morning", &p, now_local())
            .text
            .contains("Done on my own since Sun 3 May 21:00:"));
    }

    #[test]
    fn long_parts_are_cut_by_whole_lines() {
        let many: Vec<NoticeRow> = (0..400)
            .map(|i| row(i, &format!("Notice number {i} with some words"), None))
            .collect();
        let p = BriefParts {
            notices: many,
            ..parts()
        };
        let composed = compose("evening", &p, now_local());
        let text = composed.text;
        assert!(
            text.chars().count() <= MAX_CHARS,
            "{}",
            text.chars().count()
        );
        assert!(text.starts_with("Evening wrap-up.\n\nToday: 3 meetings."));
        assert!(text.ends_with(JOURNAL));
        // The short parts are kept whole; the long one ends with how much was left out.
        assert!(text.contains("• Tax return (Fri 8 May)"));
        assert!(text.contains("• Archived 4 newsletters"));
        let more = text
            .lines()
            .find(|l| l.starts_with("…and "))
            .expect("a …and N more line");
        let n: usize = more
            .trim_start_matches("…and ")
            .trim_end_matches(" more")
            .parse()
            .unwrap();
        let listed = text
            .lines()
            .filter(|l| l.starts_with("• Notice number"))
            .count();
        assert_eq!(listed + n, 400);
        // Only the listed notices (and the radar's one) are in `listed`, the first ones kept.
        let mut want: Vec<i64> = vec![2];
        want.extend((0..400).take(listed));
        assert_eq!(composed.listed, want);
        // Every listed notice line is whole.
        assert!(text
            .lines()
            .filter(|l| l.starts_with("• Notice number"))
            .all(|l| l.ends_with("with some words")));
    }

    #[test]
    fn away_news_is_since_the_last_active() {
        let since = at(4, 12, 0);
        let held = |created_at| NoticeRow {
            state: "held".into(),
            created_at,
            updated_at: at(4, 16, 0),
            ..row(1, "x", None)
        };
        assert!(!away_news(&held(at(4, 11, 0)), since), "held from before");
        assert!(away_news(&held(at(4, 13, 0)), since));
        let said = |said_at, seen_at| NoticeRow {
            state: "said".into(),
            said_at: Some(said_at),
            seen_at,
            ..row(1, "x", None)
        };
        assert!(away_news(&said(at(4, 13, 0), None), since));
        assert!(!away_news(&said(at(4, 11, 0), None), since));
        assert!(!away_news(&said(at(4, 13, 0), Some(at(4, 14, 0))), since));
        assert!(
            !away_news(&row(1, "x", None), since),
            "new: the brief's, not news"
        );
    }

    #[test]
    fn multi_line_notice_text_is_one_line() {
        let p = BriefParts {
            notices: vec![row(1, "Two\nlines", None)],
            ..parts()
        };
        assert!(compose("morning", &p, now_local())
            .text
            .contains("• Two lines\n"));
    }
}
