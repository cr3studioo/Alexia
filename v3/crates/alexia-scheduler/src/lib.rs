// SPDX-License-Identifier: AGPL-3.0-only
//! Scheduled jobs (AC-09): "every Monday at 9, check my school portal" is a row that fires a
//! turn through the brain (`Origin::Scheduler`) and says the answer with `Event::Say`.
//! (P3) Watches poll a capability and fire on change (`watch`); quiet hours and the owner's
//! pause hold a reply until they end (`quiet`). The rest of the proactivity engine lives in
//! the modules below, one task each.

use std::collections::HashMap;
use std::sync::{Arc, RwLock, Weak};
use std::time::Duration;

use alexia_core::{
    Brain, BrainError, Builtin, Bus, Event, JobId, Origin, ToolCtx, ToolOutcome, ToolSpec, Turn,
    UndoCall,
};
use alexia_store::{now_ms, Content, Error as StoreError, JobRow, Ms, NewNotice, SessionId, Store};
use chrono::{Days, FixedOffset, Local, NaiveDate, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::Notify;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

pub use alexia_core::{Error, Result, Urgency};

pub mod brief;
pub mod decide;
pub mod follow;
pub mod notices;
pub mod patterns;
pub mod quiet;
pub mod watch;

pub use decide::{decide, radar, DecideCtx, Decision};
pub use notices::Intake;
pub use quiet::{held, Proactive, Quiet};

/// (P3-07) One thing a source offers as maybe worth saying (`notice.items`, INTERFACES §3.6).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeItem {
    pub key: String,
    pub text: String,
    pub why: String,
    #[serde(default)]
    pub urgency: Option<Urgency>,
    #[serde(default)]
    pub due_at: Option<Ms>,
    #[serde(default)]
    pub not_before: Option<Ms>,
}

/// (P3-07) Where notices and brief sections come from. The hub's implementation fans out over
/// the plugin host by capability (P3-31); tests use fakes. Never names a plugin.
#[async_trait::async_trait]
pub trait Sources: Send + Sync {
    /// Every `notice.items` provider's items, each tagged with the capability it came from.
    async fn items(&self, now: Ms, horizon_days: u32) -> Vec<(String, NoticeItem)>;
    /// Every `brief.section` provider's text for `kind` ("morning"|"evening"|"weekly"),
    /// empty ones dropped.
    async fn sections(&self, kind: &str, now: Ms) -> Vec<String>;
    /// One capability call's text (for `Watch`); None on error.
    async fn poll(&self, cap: &str, args: Map<String, Value>) -> Option<String>;
    /// Fan `notice.done {key}` out to every provider (the owner said Done).
    async fn done(&self, key: &str);
}

/// All empty: tests, and a hub whose plugin folder is empty.
pub struct NoSources;

#[async_trait::async_trait]
impl Sources for NoSources {
    async fn items(&self, _: Ms, _: u32) -> Vec<(String, NoticeItem)> {
        Vec::new()
    }
    async fn sections(&self, _: &str, _: Ms) -> Vec<String> {
        Vec::new()
    }
    async fn poll(&self, _: &str, _: Map<String, Value>) -> Option<String> {
        None
    }
    async fn done(&self, _: &str) {}
}

/// How often `run` looks again even when nothing was added or cancelled.
const RECHECK: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Trigger {
    At {
        at: Ms,
    },
    Every {
        period_ms: u64,
        from: Ms,
    },
    Daily {
        hour: u8,
        minute: u8,
    },
    Weekly {
        /// 1 = Monday .. 7 = Sunday.
        weekday: u8,
        hour: u8,
        minute: u8,
    },
    /// (P3-07) Call `cap` with `args` every `every_ms` (at least a minute); fire when the text
    /// answer changed. The first poll only records.
    Watch {
        cap: String,
        #[serde(default)]
        args: Map<String, Value>,
        every_ms: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Job {
    pub id: JobId,
    pub trigger: Trigger,
    pub prompt: String,
    pub urgency: Urgency,
    pub origin: Origin,
    pub created_at: Ms,
    pub next_at: Option<Ms>,
}

/// Next fire time after `now` in local time, DST-safe.
pub fn next_after(trigger: &Trigger, now: Ms) -> Option<Ms> {
    next_after_in(trigger, now, &Local)
}

/// `next_after` in any time zone (tests use one with a known DST jump). A wall-clock time that
/// does not exist that day (spring forward) fires one hour later; one that happens twice (fall
/// back) fires the first time.
pub fn next_after_in<Tz: TimeZone>(trigger: &Trigger, now: Ms, tz: &Tz) -> Option<Ms> {
    match *trigger {
        Trigger::Watch { every_ms, .. } => {
            let every = i64::try_from(every_ms.max(watch::FLOOR_MS)).ok()?;
            now.checked_add(every)
        }
        Trigger::At { at } => (at > now).then_some(at),
        Trigger::Every { period_ms, from } => {
            let p = i64::try_from(period_ms).ok().filter(|p| *p > 0)?;
            if now < from {
                return Some(from);
            }
            let k = (now.saturating_sub(from) / p).checked_add(1)?;
            from.checked_add(k.checked_mul(p)?)
        }
        Trigger::Daily { hour, minute } => first_wall_time(tz, now, hour, minute, |_| true),
        Trigger::Weekly {
            weekday,
            hour,
            minute,
        } => first_wall_time(tz, now, hour, minute, |d| {
            chrono::Datelike::weekday(d).number_from_monday() == u32::from(weekday)
        }),
    }
}

/// The first `hour:minute` local time after `now` on a day `ok` accepts (looks 9 days ahead).
fn first_wall_time<Tz: TimeZone>(
    tz: &Tz,
    now: Ms,
    hour: u8,
    minute: u8,
    ok: impl Fn(&NaiveDate) -> bool,
) -> Option<Ms> {
    if hour > 23 || minute > 59 {
        return None;
    }
    let today = tz.timestamp_millis_opt(now).single()?.date_naive();
    (0..=8).find_map(|i| {
        let day = today.checked_add_days(Days::new(i))?;
        if !ok(&day) {
            return None;
        }
        let at = wall_to_ms(tz, day.and_hms_opt(u32::from(hour), u32::from(minute), 0)?)?;
        (at > now).then_some(at)
    })
}

fn wall_to_ms<Tz: TimeZone>(tz: &Tz, naive: NaiveDateTime) -> Option<Ms> {
    let resolved = tz.from_local_datetime(&naive).earliest().or_else(|| {
        // In the spring-forward gap: the same wall time an hour later.
        tz.from_local_datetime(&(naive + chrono::Duration::hours(1)))
            .earliest()
    })?;
    Some(resolved.timestamp_millis())
}

pub struct Scheduler {
    store: Arc<Store>,
    bus: Bus,
    brain: Arc<dyn Brain>,
    wake: Notify,
    clock: Clock,
    read_jobs: ReadJobs,
    /// (P3-07) Where notices, brief sections and watched answers come from.
    sources: Arc<dyn Sources>,
    /// The time zone quiet hours are read in: None is the machine's own. Tests fix one.
    zone: RwLock<Option<FixedOffset>>,
    /// (P3-08) Asks the notice loop for a dispatch now (a job reply was held).
    nudge: Notify,
}

/// Wall clock in epoch ms. Production uses `now_ms` (so it follows system sleep and clock
/// changes); tests inject their own.
pub type Clock = Box<dyn Fn() -> Ms + Send + Sync>;
/// How job rows are read; tests inject a source that fails.
pub type ReadJobs =
    Box<dyn Fn(&Store) -> std::result::Result<Vec<JobRow>, StoreError> + Send + Sync>;

impl Scheduler {
    /// `brain` is the Agent (INTERFACES §2.6 step 6). The Agent reaches back to the scheduler
    /// only through [`Scheduler::tools`], which holds a `Weak`, so the two never form a cycle.
    pub fn new(store: Arc<Store>, bus: Bus, brain: Arc<dyn Brain>) -> Arc<Scheduler> {
        Self::with_sources(store, bus, brain, Arc::new(NoSources))
    }

    /// (P3-07) `new` with the sources the proactivity engine reads.
    pub fn with_sources(
        store: Arc<Store>,
        bus: Bus,
        brain: Arc<dyn Brain>,
        sources: Arc<dyn Sources>,
    ) -> Arc<Scheduler> {
        Self::with_parts(
            store,
            bus,
            brain,
            Box::new(now_ms),
            Box::new(Store::jobs),
            sources,
        )
    }

    /// `new` with an injected clock, job reader and sources (for tests).
    pub fn with_parts(
        store: Arc<Store>,
        bus: Bus,
        brain: Arc<dyn Brain>,
        clock: Clock,
        read_jobs: ReadJobs,
        sources: Arc<dyn Sources>,
    ) -> Arc<Scheduler> {
        Arc::new(Scheduler {
            store,
            bus,
            brain,
            wake: Notify::new(),
            clock,
            read_jobs,
            sources,
            zone: RwLock::new(None),
            nudge: Notify::new(),
        })
    }

    /// Reads quiet hours in `zone` instead of the machine's own (tests).
    pub fn set_zone(&self, zone: Option<FixedOffset>) {
        *self.zone.write().unwrap_or_else(|e| e.into_inner()) = zone;
    }

    /// Whether a `Say` of `urgency` must wait now, and until when (`quiet::gate`).
    fn hold_until(&self, urgency: Urgency, now: Ms) -> Option<Ms> {
        let cfg = Proactive::load(&self.store);
        match *self.zone.read().unwrap_or_else(|e| e.into_inner()) {
            Some(tz) => quiet::gate_in(&cfg, urgency, now, &tz),
            None => quiet::gate(&cfg, urgency, now),
        }
    }

    /// The owner's local (hour, minute) at `now`, in the zone quiet hours are read in.
    fn local_now(&self, now: Ms) -> (u8, u8) {
        match *self.zone.read().unwrap_or_else(|e| e.into_inner()) {
            Some(tz) => quiet::local_hm(now, &tz),
            None => quiet::local_hm(now, &Local),
        }
    }

    fn now(&self) -> Ms {
        (self.clock)()
    }

    pub fn add(
        &self,
        trigger: Trigger,
        prompt: &str,
        urgency: Urgency,
        origin: Origin,
    ) -> Result<JobId> {
        if matches!(origin, Origin::Scheduler { .. }) {
            return Err(invalid("A job needs a chat to answer in."));
        }
        if prompt.trim().is_empty() {
            return Err(invalid("A job needs something to do."));
        }
        if prompt.trim_start().starts_with('/') {
            return Err(invalid(
                "A job's prompt is an instruction, not a command: write what Alexia should do.",
            ));
        }
        let now = self.now();
        let next = next_after(&trigger, now).ok_or_else(|| {
            invalid("That schedule never fires: the time is past or the hour, minute or weekday is out of range.")
        })?;
        let id = self.store.job_add(
            &serde_json::to_string(&trigger).map_err(json_err)?,
            prompt,
            urgency_str(urgency),
            &serde_json::to_string(&origin).map_err(json_err)?,
            Some(next),
            now,
        )?;
        self.wake.notify_one();
        Ok(JobId(id))
    }

    /// false when there is no such job or it was already cancelled.
    pub fn cancel(&self, id: JobId) -> Result<bool> {
        let done = self.store.job_cancel(id.0, self.now())?;
        watch::forget(&self.store, id.0);
        self.wake.notify_one();
        Ok(done)
    }

    pub fn jobs(&self) -> Result<Vec<Job>> {
        Ok((self.read_jobs)(&self.store)?
            .into_iter()
            .filter_map(|row| {
                let id = row.id;
                let job = job_of(row);
                if job.is_none() {
                    tracing::warn!(job = id, "scheduled job row is unreadable; skipped");
                }
                job
            })
            .collect())
    }

    /// Sleeps until the next due job (re-checks every minute and on add/cancel), fires it, sets
    /// next_at. A job whose time passed while the hub was off fires once, at start.
    /// (P3-08) The notice loop (`notices`) runs beside it under the same token.
    pub async fn run(self: Arc<Self>, cancel: CancellationToken) -> Result<()> {
        let notices = tokio::spawn(notices::run(Arc::clone(&self), cancel.clone()));
        let mut firing = JoinSet::new();
        // Which job each in-flight turn belongs to, so a job never has two turns at once.
        let mut busy: HashMap<tokio::task::Id, JobId> = HashMap::new();
        let result = loop {
            // `select!` may reap a turn that shutdown just stopped before it sees `cancel`; a
            // stopped one-shot is due again then, and must wait for the next start.
            if cancel.is_cancelled() {
                break Ok(());
            }
            let now = self.now();
            let jobs = match self.jobs() {
                Ok(j) => j,
                Err(e) => {
                    // One failed read must not stop scheduling: look again next time.
                    tracing::warn!("could not read the scheduled jobs; retrying: {e}");
                    Vec::new()
                }
            };
            let mut wait = RECHECK;
            for job in jobs {
                let Some(mut next) = job.next_at else {
                    continue;
                };
                if next <= now {
                    // Wake for its next due time too, even while this turn still runs.
                    match self.start(job, now, &cancel, &mut firing, &mut busy) {
                        Some(n) => next = n,
                        None => continue,
                    }
                }
                let ms = u64::try_from(next - now).unwrap_or(u64::MAX);
                wait = wait.min(Duration::from_millis(ms));
            }
            tokio::select! {
                () = cancel.cancelled() => break Ok(()),
                () = self.wake.notified() => {}
                () = tokio::time::sleep(wait) => {}
                // Reap finished turns as they go so the set stays small.
                Some(done) = firing.join_next_with_id(), if !firing.is_empty() => {
                    busy.remove(&done.map_or_else(|e| e.id(), |(id, ())| id));
                }
            }
        };
        // `cancel` stops in-flight turns (they hold child tokens); wait for them to record it.
        cancel.cancel();
        while firing.join_next().await.is_some() {}
        if let Err(e) = notices.await {
            tracing::warn!("the notice loop ended badly: {e}");
        }
        result
    }

    /// Moves `next_at` on first (so the job cannot fire twice), then runs the turn, unless the
    /// job's previous turn is still running: then this due time is skipped. Returns the new
    /// next time, if any.
    fn start(
        self: &Arc<Self>,
        job: Job,
        now: Ms,
        cancel: &CancellationToken,
        firing: &mut JoinSet<()>,
        busy: &mut HashMap<tokio::task::Id, JobId>,
    ) -> Option<Ms> {
        let next = next_after(&job.trigger, now);
        // A one-shot (next None) stays listed until its turn ends, so the turn can still look
        // its job up (`answer_origin`); `fire` cancels it then, or, when shutdown cut the turn
        // short, puts its time back so the next start fires it once. The loop skips next_at None.
        if let Err(e) = self.store.job_set_next(job.id.0, next) {
            tracing::warn!(job = job.id.0, "could not move the job's next time: {e}");
            return None;
        }
        if busy.values().any(|j| *j == job.id) {
            tracing::info!(
                job = job.id.0,
                "scheduled job is still running; this due time is skipped"
            );
            return next;
        }
        let me = Arc::clone(self);
        let token = cancel.child_token();
        let id = job.id;
        let task = firing.spawn(async move { me.fire(job, token).await });
        busy.insert(task.id(), id);
        next
    }

    async fn fire(&self, job: Job, cancel: CancellationToken) {
        let at = self.now();
        // A watch runs a turn only when the answer changed (P3-07).
        let prompt = match &job.trigger {
            Trigger::Watch { cap, args, .. } => {
                match watch::changed(&self.store, &*self.sources, job.id.0, cap, args.clone()).await
                {
                    Some(text) => watch::prompt(&job.prompt, &text),
                    None => return,
                }
            }
            _ => job.prompt.clone(),
        };
        self.bus.publish(Event::Fired { at, job: job.id });
        let outcome = match self.session_of(&job.origin) {
            Ok(session) => {
                let turn = Turn {
                    session,
                    origin: Origin::Scheduler { job: job.id },
                    content: Content::Text(prompt),
                    files: vec![],
                    received_at: at,
                    steer: alexia_core::Steer::none(),
                };
                // Nobody watches a scheduled turn being drafted.
                let (tx, mut rx) = tokio::sync::mpsc::channel(16);
                tokio::spawn(async move { while rx.recv().await.is_some() {} });
                self.brain.reply(turn, tx, cancel.clone()).await
            }
            Err(e) => Err(BrainError::Other(e)),
        };
        // Kept only when shutdown (this token) cut the turn short; a run stopped by itself also
        // ends `Cancelled` while the token is live, and that one-shot is finished.
        let stopped = matches!(outcome, Err(BrainError::Cancelled)) && cancel.is_cancelled();
        let (text, note) = match outcome {
            Ok(reply) => (reply.text, "ok".to_string()),
            Err(BrainError::Cancelled) => (String::new(), "stopped".to_string()),
            Err(e) => (
                format!("A scheduled job did not run: {e}"),
                format!("failed: {e}"),
            ),
        };
        // The brain's reply does not carry its run id, so none is recorded here.
        if let Err(e) = self.store.job_ran(job.id.0, self.now(), None, &note) {
            tracing::warn!(job = job.id.0, "could not record the run: {e}");
        }
        if let Trigger::At { at } = job.trigger {
            if stopped {
                // Shutdown cut the turn short: due again (overdue) at the next start, unless the
                // owner cancelled it meanwhile (cancelled rows are not listed).
                let restored = self.store.jobs().and_then(|rows| {
                    if rows.iter().any(|r| r.id == job.id.0) {
                        self.store.job_set_next(job.id.0, Some(at))
                    } else {
                        Ok(())
                    }
                });
                if let Err(e) = restored {
                    tracing::warn!(job = job.id.0, "could not keep the stopped one-shot: {e}");
                }
            } else if let Err(e) = self.store.job_cancel(job.id.0, self.now()) {
                // A one-shot is finished: drop it from the list.
                tracing::warn!(job = job.id.0, "could not finish the one-shot: {e}");
            }
        }
        if !text.trim().is_empty() {
            self.say_or_hold(&job, text);
        }
    }

    /// Says a job's reply, or, inside quiet hours or the owner's pause, keeps it as a held
    /// notice said when they end (PR-07: held, never dropped). (P3-08) Holding is one write:
    /// the row is filed with `not_before` set, which the decider holds on its own, so a reply
    /// is never both said now and kept. Its key carries the job's chat, so the release goes
    /// back there (`notices::job_to`).
    fn say_or_hold(&self, job: &Job, text: String) {
        let now = self.now();
        let Some(until) = self.hold_until(job.urgency, now) else {
            self.bus.publish(Event::Say {
                at: now,
                text,
                urgency: job.urgency,
                job: Some(job.id),
                notice: None,
                to: Some(job.origin.clone()),
            });
            return;
        };
        let key = notices::job_key(job.id, now, &job.origin);
        let notice = NewNotice {
            key: &key,
            source: "job",
            text: &text,
            why: "A scheduled job you set up.",
            urgency: urgency_str(job.urgency),
            due_at: None,
            not_before: Some(until),
        };
        match self.store.notice_upsert(&notice, now) {
            // The notice loop marks it held and says it when the hold ends.
            Ok(_) => self.nudge.notify_one(),
            Err(e) => {
                // Holding failed: say it now rather than lose it.
                tracing::warn!(
                    job = job.id.0,
                    "a held reply could not be kept ({e}); said now"
                );
                self.bus.publish(Event::Say {
                    at: now,
                    text,
                    urgency: job.urgency,
                    job: Some(job.id),
                    notice: None,
                    to: Some(job.origin.clone()),
                });
            }
        }
    }

    /// The conversation a job's answer belongs to: its chat's session.
    fn session_of(&self, origin: &Origin) -> Result<SessionId> {
        Ok(match origin {
            Origin::Channel { channel, chat } => self.store.channel_session(channel, chat)?,
            // The job row records only `Desktop`, not which chat, so use the one shared desktop session.
            Origin::Desktop => self.store.channel_session("desktop", "main")?,
            Origin::Window => self.store.channel_session("window", "main")?,
            Origin::Scheduler { .. } => return Err(invalid("A job needs a chat to answer in.")),
        })
    }

    /// The builtin tools, for the agent's Tooling.
    pub fn tools(self: &Arc<Self>) -> Arc<dyn Builtin> {
        Arc::new(ScheduleTools(Arc::downgrade(self)))
    }
}

fn invalid(s: &str) -> Error {
    StoreError::Invalid(s.into()).into()
}

fn json_err(e: serde_json::Error) -> Error {
    StoreError::Invalid(e.to_string()).into()
}

fn urgency_str(u: Urgency) -> &'static str {
    match u {
        Urgency::Low => "low",
        Urgency::Normal => "normal",
        Urgency::High => "high",
        Urgency::Urgent => "urgent",
    }
}

fn job_of(row: JobRow) -> Option<Job> {
    Some(Job {
        id: JobId(row.id),
        trigger: serde_json::from_str(&row.trigger).ok()?,
        prompt: row.prompt,
        urgency: serde_json::from_value(Value::String(row.urgency)).ok()?,
        origin: serde_json::from_str(&row.origin).ok()?,
        created_at: row.created_at,
        next_at: row.next_at,
    })
}

// ---- the tools ----

/// Holds the scheduler weakly: the brain (the Agent) owns these tools through its Tooling, and
/// the scheduler owns the brain, so a strong ref here would be a cycle that never drops.
struct ScheduleTools(Weak<Scheduler>);

fn outcome(text: impl Into<String>, ok: bool, undo: Option<UndoCall>) -> ToolOutcome {
    ToolOutcome {
        text: text.into(),
        ok,
        files: vec![],
        final_text: None,
        undo,
        card: None,
    }
}

fn local_text(ms: Ms) -> String {
    match Local.timestamp_millis_opt(ms).single() {
        Some(t) => t.format("%a %d %b %Y %H:%M").to_string(),
        None => ms.to_string(),
    }
}

const DAYS: [&str; 7] = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];

fn describe(t: &Trigger) -> String {
    match *t {
        Trigger::At { at } => format!("once, {}", local_text(at)),
        Trigger::Every { period_ms, .. } => {
            let min = period_ms / 60_000;
            if min > 0 && period_ms % 60_000 == 0 {
                format!("every {min} min")
            } else {
                format!("every {period_ms} ms")
            }
        }
        Trigger::Daily { hour, minute } => format!("every day at {hour:02}:{minute:02}"),
        Trigger::Weekly {
            weekday,
            hour,
            minute,
        } => format!(
            "every {} at {hour:02}:{minute:02}",
            DAYS.get(usize::from(weekday).wrapping_sub(1))
                .copied()
                .unwrap_or("?")
        ),
        Trigger::Watch {
            ref cap, every_ms, ..
        } => format!(
            "when {cap} changes, checked every {} min",
            every_ms.max(watch::FLOOR_MS) / 60_000
        ),
    }
}

fn weekday_arg(v: &Value) -> Option<u8> {
    match v {
        Value::Number(n) => n.as_u64().and_then(|n| u8::try_from(n).ok()),
        Value::String(s) => {
            let s = s.trim().to_lowercase();
            if let Ok(n) = s.parse() {
                return Some(n);
            }
            let head = s.get(..3)?;
            (1u8..)
                .zip(DAYS)
                .find_map(|(n, d)| d.to_lowercase().starts_with(head).then_some(n))
        }
        _ => None,
    }
}

fn int_arg(args: &Map<String, Value>, key: &str) -> Option<u64> {
    args.get(key).and_then(Value::as_u64)
}

/// `at` as the owner's local "YYYY-MM-DDTHH:MM" (seconds optional, a space may replace the T).
fn at_arg(s: &str) -> Option<Ms> {
    let s = s.trim();
    [
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d %H:%M:%S",
    ]
    .iter()
    .find_map(|f| NaiveDateTime::parse_from_str(s, f).ok())
    .and_then(|n| wall_to_ms(&Local, n))
}

fn trigger_of(args: &Map<String, Value>, now: Ms) -> std::result::Result<Trigger, String> {
    let kind = args.get("kind").and_then(Value::as_str).unwrap_or("");
    let hour = |default: Option<u8>| {
        int_arg(args, "hour")
            .and_then(|h| u8::try_from(h).ok())
            .or(default)
            .filter(|h| *h <= 23)
            .ok_or("`hour` must be 0-23.")
    };
    let minute = match args.get("minute") {
        None => 0,
        Some(v) => v
            .as_u64()
            .and_then(|m| u8::try_from(m).ok())
            .filter(|m| *m <= 59)
            .ok_or("`minute` must be 0-59.")?,
    };
    Ok(match kind {
        "at" => Trigger::At {
            at: args
                .get("at")
                .and_then(Value::as_str)
                .and_then(at_arg)
                .ok_or("`at` must be a local date and time like 2026-03-02T09:00.")?,
        },
        "every" => {
            let min = int_arg(args, "every_minutes")
                .filter(|m| *m > 0)
                .ok_or("`every_minutes` must be a whole number above 0.")?;
            Trigger::Every {
                period_ms: min.saturating_mul(60_000),
                from: now,
            }
        }
        "daily" => Trigger::Daily {
            hour: hour(None)?,
            minute,
        },
        "weekly" => Trigger::Weekly {
            weekday: args
                .get("weekday")
                .and_then(weekday_arg)
                .filter(|d| (1..=7).contains(d))
                .ok_or("`weekday` must be 1 (Monday) to 7 (Sunday), or a day name.")?,
            hour: hour(None)?,
            minute,
        },
        "watch" => Trigger::Watch {
            cap: args
                .get("cap")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .ok_or("`cap` is required: the capability to watch, like page.text.")?
                .to_string(),
            args: args
                .get("args")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
            // `every_ms` (INTERFACES §2.5) or `every_minutes` (like kind=every); an hour if
            // neither. Below a minute is raised to one (`watch::FLOOR_MS`).
            every_ms: match int_arg(args, "every_ms").filter(|m| *m > 0) {
                Some(ms) => ms,
                None => int_arg(args, "every_minutes")
                    .filter(|m| *m > 0)
                    .unwrap_or(60)
                    .saturating_mul(60_000),
            }
            .max(watch::FLOOR_MS),
        },
        _ => return Err("`kind` must be at, every, daily, weekly or watch.".into()),
    })
}

/// `annotations` is built from JSON so this crate need not depend on alexia-mcp (INTERFACES
/// §1.1); the field's own type does the parsing.
fn spec(
    name: &str,
    description: &str,
    params: Value,
    title: &str,
    read_only: bool,
    idempotent: bool,
    words: &str,
) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        description: description.into(),
        params,
        annotations: serde_json::from_value(json!({
            "title": title,
            "readOnlyHint": read_only,
            "destructiveHint": false,
            "idempotentHint": idempotent,
            "openWorldHint": false,
        }))
        .ok(),
        reviewed: true,
        plugin: None,
        words: words.into(),
    }
}

impl ScheduleTools {
    /// Where a job made from this run answers: the run's chat, or for a run that is itself a
    /// scheduled job, that job's chat.
    fn answer_origin(s: &Scheduler, ctx: &ToolCtx) -> Option<Origin> {
        match &ctx.origin {
            Origin::Scheduler { job } => s
                .jobs()
                .ok()?
                .into_iter()
                .find(|j| j.id == *job)
                .map(|j| j.origin),
            other => Some(other.clone()),
        }
    }

    fn add(s: &Scheduler, args: &Map<String, Value>, ctx: &ToolCtx) -> ToolOutcome {
        let trigger = match trigger_of(args, s.now()) {
            Ok(t) => t,
            Err(e) => return outcome(e, false, None),
        };
        let Some(prompt) = args.get("prompt").and_then(Value::as_str) else {
            return outcome(
                "`prompt` is required: what Alexia should do each time.",
                false,
                None,
            );
        };
        let urgency = match args.get("urgency") {
            None => Urgency::Normal,
            Some(v) => match serde_json::from_value(v.clone()) {
                Ok(u) => u,
                Err(_) => {
                    return outcome(
                        "`urgency` must be low, normal, high or urgent.",
                        false,
                        None,
                    )
                }
            },
        };
        let Some(origin) = Self::answer_origin(s, ctx) else {
            return outcome("I can't tell which chat this job belongs to.", false, None);
        };
        match s.add(trigger.clone(), prompt, urgency, origin) {
            Ok(id) => {
                let next = s
                    .jobs()
                    .ok()
                    .and_then(|j| j.into_iter().find(|j| j.id == id))
                    .and_then(|j| j.next_at)
                    .map_or_else(String::new, |n| format!(" Next run: {}.", local_text(n)));
                outcome(
                    format!("Scheduled job {} ({}).{next}", id.0, describe(&trigger)),
                    true,
                    Some(UndoCall {
                        tool: "schedule.cancel".into(),
                        arguments: Map::from_iter([("id".to_string(), json!(id.0))]),
                        summary: format!("Cancel scheduled job {}", id.0),
                    }),
                )
            }
            Err(e) => outcome(e.to_string(), false, None),
        }
    }

    fn list(s: &Scheduler) -> ToolOutcome {
        match s.jobs() {
            Err(e) => outcome(e.to_string(), false, None),
            Ok(jobs) if jobs.is_empty() => outcome("No scheduled jobs.", true, None),
            Ok(jobs) => outcome(
                jobs.iter()
                    .map(|j| {
                        let next = j
                            .next_at
                            .map_or(String::new(), |n| format!(", next {}", local_text(n)));
                        format!(
                            "{}: {}{next} [{}] {}",
                            j.id.0,
                            describe(&j.trigger),
                            urgency_str(j.urgency),
                            j.prompt
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
                true,
                None,
            ),
        }
    }

    fn cancel(s: &Scheduler, args: &Map<String, Value>) -> ToolOutcome {
        let Some(id) = args.get("id").and_then(Value::as_i64) else {
            return outcome(
                "`id` is required: the job number from schedule.list.",
                false,
                None,
            );
        };
        match s.cancel(JobId(id)) {
            Ok(true) => outcome(format!("Cancelled scheduled job {id}."), true, None),
            Ok(false) => outcome(
                format!("There is no active scheduled job {id}."),
                false,
                None,
            ),
            Err(e) => outcome(e.to_string(), false, None),
        }
    }
}

#[async_trait::async_trait]
impl Builtin for ScheduleTools {
    fn specs(&self) -> Vec<ToolSpec> {
        vec![
            spec(
                "schedule.add",
                "Schedule something to be done later or repeatedly, e.g. \"every Monday at 9, check \
                 my school portal\". When it fires, Alexia gets `prompt` as if the owner had sent it, \
                 and the answer is sent to this chat. `kind` is one of: at (once, give `at` as local \
                 date and time like 2026-03-02T09:00), every (give `every_minutes`), daily (give \
                 `hour`, optional `minute`), weekly (give `weekday` 1=Monday..7=Sunday, `hour`, \
                 optional `minute`), watch (give `cap`, the capability to check, its `args`, and \
                 `every_minutes`, default 60: fires only when the answer changes, e.g. cap \
                 page.text with args {\"url\": ...} to tell the owner when a page changes). Times \
                 are the owner's local time, 24-hour. `prompt` must say \
                 fully what to do, since it runs without this conversation in view. The result \
                 can be undone with schedule.cancel.",
                json!({
                    "type": "object",
                    "properties": {
                        "kind": {"type": "string", "enum": ["at", "every", "daily", "weekly", "watch"]},
                        "cap": {"type": "string", "description": "The capability to check (kind=watch), e.g. page.text."},
                        "args": {"type": "object", "description": "Its arguments (kind=watch), e.g. {\"url\": \"https://...\"}."},
                        "at": {"type": "string", "description": "Local date and time, e.g. 2026-03-02T09:00 (kind=at)."},
                        "every_minutes": {"type": "integer", "minimum": 1, "description": "Repeat period in minutes (kind=every; kind=watch, default 60)."},
                        "every_ms": {"type": "integer", "minimum": 60000, "description": "How often to check, in milliseconds (kind=watch; at least 60000). Instead of every_minutes."},
                        "hour": {"type": "integer", "minimum": 0, "maximum": 23, "description": "Local hour (kind=daily or weekly)."},
                        "minute": {"type": "integer", "minimum": 0, "maximum": 59, "description": "Local minute, default 0."},
                        "weekday": {"type": "integer", "minimum": 1, "maximum": 7, "description": "1=Monday .. 7=Sunday (kind=weekly)."},
                        "prompt": {"type": "string", "description": "What to do each time, written as a full instruction."},
                        "urgency": {"type": "string", "enum": ["low", "normal", "high", "urgent"], "description": "How loudly to tell the owner the result. Default normal."}
                    },
                    "required": ["kind", "prompt"]
                }),
                "Schedule a job", false, false,
                "schedule a job",
            ),
            spec(
                "schedule.list",
                "List the scheduled jobs with their ids, schedules and next run times.",
                json!({"type": "object", "properties": {}}),
                "List scheduled jobs", true, true,
                "look at the scheduled jobs",
            ),
            spec(
                "schedule.cancel",
                "Cancel a scheduled job by its id (from schedule.list).",
                json!({
                    "type": "object",
                    "properties": {"id": {"type": "integer", "description": "The job id."}},
                    "required": ["id"]
                }),
                "Cancel a scheduled job", false, true,
                "cancel a scheduled job",
            ),
        ]
    }

    async fn call(
        &self,
        name: &str,
        args: &Map<String, Value>,
        ctx: &ToolCtx,
    ) -> Option<ToolOutcome> {
        if !matches!(name, "schedule.add" | "schedule.list" | "schedule.cancel") {
            return None;
        }
        let Some(s) = self.0.upgrade() else {
            return Some(outcome("Scheduled jobs are not running.", false, None));
        };
        Some(match name {
            "schedule.add" => Self::add(&s, args, ctx),
            "schedule.list" => Self::list(&s),
            _ => Self::cancel(&s, args),
        })
    }
}
