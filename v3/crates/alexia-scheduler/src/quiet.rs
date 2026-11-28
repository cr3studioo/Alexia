// SPDX-License-Identifier: AGPL-3.0-only
//! Knows when not to interrupt (PR-07, P3-07): quiet hours that hold anything below their
//! urgency until they end, the owner's "not now" pause, and the proactivity settings in one
//! kv value (`_core`/`proactive`). Held means kept and said later, never dropped (D214).

use alexia_store::{Ms, Store};
use chrono::{Local, TimeZone, Timelike};
use serde::{Deserialize, Serialize};

use crate::{next_after_in, Result, Trigger, Urgency};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quiet {
    /// Local (hour, minute) quiet hours start.
    pub from: (u8, u8),
    /// Local (hour, minute) they end.
    pub to: (u8, u8),
    /// The lowest urgency said anyway.
    pub lets_through: Urgency,
}

/// Inside [from, to) (wrapping midnight when from > to) and `urgency < lets_through`.
/// from == to means no quiet hours.
pub fn held(now_local: (u8, u8), quiet: &Quiet, urgency: Urgency) -> bool {
    if quiet.from == quiet.to || urgency >= quiet.lets_through {
        return false;
    }
    if quiet.from < quiet.to {
        quiet.from <= now_local && now_local < quiet.to
    } else {
        now_local >= quiet.from || now_local < quiet.to
    }
}

/// kv `_core`/`proactive`, JSON; missing keys take these defaults (PHASE.md P3).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Proactive {
    /// None until the owner sets them (from == to): the proposed 23:00–07:00 letting Urgent
    /// through is PHASE.md *Owner needs* 3, not a default. `QUIET_PROPOSED` holds it.
    pub quiet: Quiet,
    /// The morning brief waits for the owner's first sign of life after this (05:00).
    pub brief_earliest: (u8, u8),
    /// ...and goes out at this time if there was none (09:00).
    pub brief_fallback: (u8, u8),
    /// Evening wrap-up (21:00).
    pub evening: Option<(u8, u8)>,
    /// Weekly review (weekday 1 = Monday, hour, minute): Sunday 18:00.
    pub weekly: Option<(u8, u8, u8)>,
    /// "Not now": nothing but Urgent until then.
    pub paused_until: Option<Ms>,
    /// How often sources are asked (15 minutes).
    pub collect_every_ms: u64,
    /// (P3-41) `quiet` or `paused_until` could not be read (a DB error, a value that is not an
    /// object, or that field malformed). Everything below Urgent is held while it is set.
    /// Never stored.
    #[serde(skip)]
    pub unreadable: bool,
}

impl Default for Proactive {
    fn default() -> Proactive {
        Proactive {
            quiet: Quiet {
                from: (0, 0),
                to: (0, 0),
                lets_through: Urgency::Urgent,
            },
            brief_earliest: (5, 0),
            brief_fallback: (9, 0),
            evening: Some((21, 0)),
            weekly: Some((7, 18, 0)),
            paused_until: None,
            collect_every_ms: 900_000,
            unreadable: false,
        }
    }
}

/// The quiet hours proposed to the owner (PHASE.md P3, *Owner needs* 3).
pub const QUIET_PROPOSED: Quiet = Quiet {
    from: (23, 0),
    to: (7, 0),
    lets_through: Urgency::Urgent,
};

const NS: &str = "_core";

/// How soon a pass that could not read the owner's brakes is tried again.
pub const UNREADABLE_RETRY_MS: Ms = 60_000;

/// The kind of a store error, for a log line that must not carry the owner's data.
pub(crate) fn error_kind(e: &alexia_store::Error) -> &'static str {
    use alexia_store::Error as E;
    match e {
        E::Sqlite(_) => "sqlite",
        E::Io(_) => "io",
        E::Json(_) => "json",
        E::Keychain(_) => "keychain",
        E::Refused(_) => "refused",
        E::OutOfNamespace(_) => "out of namespace",
        E::Invalid(_) => "invalid",
    }
}

/// Reads `name` of `m` into `slot`. Missing: `slot` is left as it is. Malformed: left as it
/// is, logged by name only, and false is returned.
fn field<T: serde::de::DeserializeOwned>(
    m: &serde_json::Map<String, serde_json::Value>,
    name: &str,
    slot: &mut T,
) -> bool {
    let Some(v) = m.get(name) else { return true };
    match serde_json::from_value(v.clone()) {
        Ok(t) => {
            *slot = t;
            true
        }
        Err(_) => {
            tracing::warn!(
                field = name,
                "_core.proactive has a malformed field; its default applies"
            );
            false
        }
    }
}

impl Proactive {
    pub const KEY: &'static str = "proactive";

    /// Field by field. A missing field takes its default. A malformed field takes its default
    /// and is logged by name only (never its value). A malformed `quiet` or `paused_until`,
    /// a non-object value, or a read error sets `unreadable`. Never fails.
    pub fn load(store: &Store) -> Proactive {
        let mut p = Proactive::default();
        match store.kv_get(NS, Self::KEY) {
            Ok(None) => {}
            Ok(Some(serde_json::Value::Object(m))) => {
                let quiet = field(&m, "quiet", &mut p.quiet);
                let pause = field(&m, "paused_until", &mut p.paused_until);
                field(&m, "brief_earliest", &mut p.brief_earliest);
                field(&m, "brief_fallback", &mut p.brief_fallback);
                field(&m, "evening", &mut p.evening);
                field(&m, "weekly", &mut p.weekly);
                field(&m, "collect_every_ms", &mut p.collect_every_ms);
                p.unreadable = !(quiet && pause);
            }
            Ok(Some(_)) => {
                tracing::warn!("_core.proactive is not an object; everything below Urgent is held");
                p.unreadable = true;
            }
            Err(e) => {
                tracing::warn!(
                    kind = error_kind(&e),
                    "_core.proactive could not be read; everything below Urgent is held"
                );
                p.unreadable = true;
            }
        }
        p
    }

    /// Err(Invalid) when `self.unreadable`: a config from a failed read is never written back.
    pub fn save(&self, store: &Store) -> Result<()> {
        if self.unreadable {
            return Err(alexia_store::Error::Invalid(
                "_core.proactive could not be read, so it is not written back".into(),
            )
            .into());
        }
        let v =
            serde_json::to_value(self).map_err(|e| alexia_store::Error::Invalid(e.to_string()))?;
        store.kv_set(NS, Self::KEY, &v)?;
        Ok(())
    }

    /// When quiet hours end after `now` (local time, DST-safe).
    pub fn quiet_ends_after(&self, now: Ms) -> Ms {
        self.quiet_ends_after_in(now, &Local)
    }

    /// `quiet_ends_after` in any time zone (tests use a fixed one).
    pub fn quiet_ends_after_in<Tz: TimeZone>(&self, now: Ms, tz: &Tz) -> Ms {
        let (hour, minute) = self.quiet.to;
        next_after_in(&Trigger::Daily { hour, minute }, now, tz).unwrap_or(now + 3_600_000)
    }
}

/// The local (hour, minute) of `now` in `tz`.
pub fn local_hm<Tz: TimeZone>(now: Ms, tz: &Tz) -> (u8, u8) {
    match tz.timestamp_millis_opt(now).single() {
        // Both are below 60, so the casts cannot truncate.
        Some(t) => (t.hour() as u8, t.minute() as u8),
        None => (12, 0),
    }
}

/// Whether a `Say` of `urgency` at `now` must wait, and until when: the owner's pause first,
/// then quiet hours. None: say it now.
pub fn gate(cfg: &Proactive, urgency: Urgency, now: Ms) -> Option<Ms> {
    gate_in(cfg, urgency, now, &Local)
}

/// `gate` in any time zone.
pub fn gate_in<Tz: TimeZone>(cfg: &Proactive, urgency: Urgency, now: Ms, tz: &Tz) -> Option<Ms> {
    // The brakes themselves could not be read: hold until they can (P3-41).
    if cfg.unreadable && urgency < Urgency::Urgent {
        return Some(now + UNREADABLE_RETRY_MS);
    }
    if let Some(until) = cfg.paused_until.filter(|u| *u > now) {
        if urgency < Urgency::Urgent {
            // A pause that ends inside quiet hours still waits for them to end.
            return Some(gate_in(cfg, urgency, until, tz).unwrap_or(until));
        }
    }
    held(local_hm(now, tz), &cfg.quiet, urgency).then(|| cfg.quiet_ends_after_in(now, tz))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn q() -> Quiet {
        QUIET_PROPOSED
    }

    #[test]
    fn held_wraps_midnight() {
        assert!(held((23, 0), &q(), Urgency::Normal));
        assert!(held((2, 0), &q(), Urgency::High));
        assert!(held((6, 59), &q(), Urgency::Low));
        assert!(!held((7, 0), &q(), Urgency::Normal));
        assert!(!held((22, 59), &q(), Urgency::Normal));
        let day = Quiet {
            from: (13, 0),
            to: (14, 0),
            lets_through: Urgency::High,
        };
        assert!(held((13, 30), &day, Urgency::Normal));
        assert!(!held((14, 0), &day, Urgency::Normal));
    }

    #[test]
    fn urgent_gets_through() {
        assert!(!held((2, 0), &q(), Urgency::Urgent));
    }

    #[test]
    fn equal_bounds_mean_none() {
        let none = Quiet {
            from: (8, 0),
            to: (8, 0),
            lets_through: Urgency::Urgent,
        };
        assert!(!held((8, 0), &none, Urgency::Low));
        assert!(!held((3, 0), &none, Urgency::Low));
    }

    #[test]
    fn load_defaults_when_missing() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(Proactive::load(&s), Proactive::default());
        // A partial value keeps what it says and defaults the rest.
        s.kv_set(
            NS,
            Proactive::KEY,
            &serde_json::json!({ "brief_fallback": [8, 30] }),
        )
        .unwrap();
        let p = Proactive::load(&s);
        assert_eq!(p.brief_fallback, (8, 30));
        assert_eq!(p.quiet, Proactive::default().quiet);
        let mut changed = p.clone();
        changed.paused_until = Some(5);
        changed.save(&s).unwrap();
        assert_eq!(Proactive::load(&s), changed);
    }

    fn loaded(v: serde_json::Value) -> (Store, Proactive) {
        let s = Store::open_in_memory().unwrap();
        s.kv_set(NS, Proactive::KEY, &v).unwrap();
        let p = Proactive::load(&s);
        (s, p)
    }

    #[test]
    fn load_keeps_readable_fields() {
        let (_s, p) = loaded(serde_json::json!({ "brief_fallback": [8, 30], "evening": "x" }));
        assert_eq!(p.brief_fallback, (8, 30));
        assert_eq!(p.evening, Proactive::default().evening);
        assert!(!p.unreadable);
    }

    #[test]
    fn bad_pause_is_unreadable() {
        let (_s, p) =
            loaded(serde_json::json!({ "paused_until": "soon", "brief_fallback": [8, 30] }));
        assert!(p.unreadable);
        assert_eq!(p.brief_fallback, (8, 30));
        // null is no pause, and readable.
        let (_s, p) = loaded(serde_json::json!({ "paused_until": null }));
        assert!(!p.unreadable);
        assert_eq!(p.paused_until, None);
    }

    #[test]
    fn bad_quiet_is_unreadable_and_keeps_pause() {
        let t: Ms = 1_800_000_000_000;
        let (_s, p) = loaded(serde_json::json!({ "quiet": "never", "paused_until": t }));
        assert!(p.unreadable);
        assert_eq!(p.paused_until, Some(t));
    }

    #[test]
    fn not_an_object_is_unreadable() {
        for v in [serde_json::json!("x"), serde_json::json!([1])] {
            let (_s, p) = loaded(v);
            assert!(p.unreadable);
        }
    }

    #[test]
    fn unreadable_never_saved() {
        let stored = serde_json::json!({ "quiet": "never", "paused_until": 7 });
        let (s, p) = loaded(stored.clone());
        assert!(p.unreadable);
        assert!(p.save(&s).is_err());
        assert_eq!(s.kv_get(NS, Proactive::KEY).unwrap(), Some(stored));
    }

    #[test]
    fn gate_holds_below_urgent_when_unreadable() {
        let tz = FixedOffset::east_opt(3600).unwrap();
        let now: Ms = 1_800_000_000_000;
        let p = Proactive {
            unreadable: true,
            ..Proactive::default()
        };
        assert_eq!(
            gate_in(&p, Urgency::Normal, now, &tz),
            Some(now + UNREADABLE_RETRY_MS)
        );
        assert_eq!(gate_in(&p, Urgency::Urgent, now, &tz), None);
    }

    #[test]
    fn pause_holds_all_but_urgent() {
        let tz = FixedOffset::east_opt(3600).unwrap();
        let noon = tz
            .with_ymd_and_hms(2026, 5, 4, 12, 0, 0)
            .unwrap()
            .timestamp_millis();
        let p = Proactive {
            paused_until: Some(noon + 3_600_000),
            ..Proactive::default()
        };
        assert_eq!(
            gate_in(&p, Urgency::Normal, noon, &tz),
            Some(noon + 3_600_000)
        );
        assert_eq!(gate_in(&p, Urgency::Urgent, noon, &tz), None);
        assert_eq!(
            gate_in(&Proactive::default(), Urgency::Normal, noon, &tz),
            None
        );
    }
}
