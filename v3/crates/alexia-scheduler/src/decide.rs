// SPDX-License-Identifier: AGPL-3.0-only
//! Whether a notice is said now, kept for the brief, held, or dropped: rules, no model (P3-08).
//! PHASE.md D-P3-4: nothing here judges content. A source that needs judgement says so with
//! the urgency it gives an item.

use alexia_store::{Ms, MuteRow, NoticeRow};
use serde_json::Value;

use crate::{held, Proactive, Urgency};

const MIN: Ms = 60_000;
const HOUR: Ms = 60 * MIN;
const DAY: Ms = 24 * HOUR;

/// Urgent notices are said again this long after the last time, until seen.
pub const REPEAT_MS: Ms = 30 * MIN;
/// ...at most this many times in all.
pub const REPEAT_TIMES: u32 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Tell the owner now.
    SayNow,
    /// Keep it for the next brief (P3-09 reads these).
    Brief,
    /// Not before `until`.
    Hold { until: Ms },
    /// Already said; nothing to do for now.
    Wait,
    /// The owner does not want it.
    Drop,
}

pub struct DecideCtx<'a> {
    pub now: Ms,
    /// The owner's local (hour, minute) at `now`.
    pub now_local: (u8, u8),
    pub cfg: &'a Proactive,
    pub mutes: &'a [MuteRow],
    pub last_active: Option<Ms>,
}

/// D-P3-5: > 7 days → None; ≤ 7 d → Low; ≤ 3 d → Normal; ≤ 24 h → High; ≤ 2 h or past → Urgent.
pub fn radar(due_at: Ms, now: Ms) -> Option<Urgency> {
    let left = due_at.saturating_sub(now);
    if left <= 2 * HOUR {
        Some(Urgency::Urgent)
    } else if left <= DAY {
        Some(Urgency::High)
    } else if left <= 3 * DAY {
        Some(Urgency::Normal)
    } else if left <= 7 * DAY {
        Some(Urgency::Low)
    } else {
        None
    }
}

/// A stored urgency ("low".."urgent"); anything else reads as Low.
pub fn urgency_of(s: &str) -> Urgency {
    serde_json::from_value(Value::String(s.to_string())).unwrap_or(Urgency::Low)
}

/// The row's own urgency raised by the deadline radar.
pub fn effective(n: &NoticeRow, now: Ms) -> Urgency {
    let own = urgency_of(&n.urgency);
    n.due_at
        .and_then(|d| radar(d, now))
        .map_or(own, |r| own.max(r))
}

/// Whether `mute` covers `n`: same source, and no topic or a topic found in the text
/// (case-insensitive). An ended mute covers nothing.
pub fn mutes(mute: &MuteRow, n: &NoticeRow, now: Ms) -> bool {
    mute.source == n.source
        && mute.until.is_none_or(|u| u > now)
        && mute
            .topic
            .as_deref()
            .is_none_or(|t| n.text.to_lowercase().contains(&t.to_lowercase()))
}

/// When quiet hours end, read from the local wall time (whole minutes; a DST jump that night
/// can move it by an hour, and a hold that ends early is simply held again).
fn quiet_end(ctx: &DecideCtx) -> Ms {
    let minutes = |(h, m): (u8, u8)| i64::from(h) * 60 + i64::from(m);
    let ahead = (minutes(ctx.cfg.quiet.to) - minutes(ctx.now_local)).rem_euclid(24 * 60);
    let ahead = if ahead == 0 { 24 * 60 } else { ahead };
    ctx.now - ctx.now.rem_euclid(MIN) + ahead * MIN
}

/// The rules, in INTERFACES §2.5's order.
pub fn decide(n: &NoticeRow, ctx: &DecideCtx) -> Decision {
    let now = ctx.now;
    // 1. Muted.
    if ctx.mutes.iter().any(|m| mutes(m, n, now)) {
        return Decision::Drop;
    }
    // 2. Not yet.
    if let Some(until) = n.not_before.filter(|t| *t > now) {
        return Decision::Hold { until };
    }
    // 3. How urgent it is now.
    let u = effective(n, now);
    match n.state.as_str() {
        // 4. Said: urgent things repeat until seen.
        "said" => {
            let again = u == Urgency::Urgent
                && n.seen_at.is_none()
                && n.times_said < REPEAT_TIMES
                && n.said_at.is_none_or(|s| now.saturating_sub(s) >= REPEAT_MS);
            if again {
                Decision::SayNow
            } else {
                Decision::Wait
            }
        }
        "new" | "held" => {
            // 5. The owner's pause.
            if let Some(until) = ctx.cfg.paused_until.filter(|p| *p > now) {
                if u < Urgency::Urgent {
                    return Decision::Hold { until };
                }
            }
            // 6. Quiet hours.
            if held(ctx.now_local, &ctx.cfg.quiet, u) {
                return Decision::Hold {
                    until: quiet_end(ctx),
                };
            }
            // 7. Say it, or keep it for the brief.
            if u >= Urgency::Normal {
                Decision::SayNow
            } else {
                Decision::Brief
            }
        }
        // done | dropped: not live, nothing to do.
        _ => Decision::Wait,
    }
}
