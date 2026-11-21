// SPDX-License-Identifier: AGPL-3.0-only
//! P1-06: Router::hedged (D212, SP-07, MO-03, MO-04).
//!
//! Races the best free candidates for the first byte and keeps the fastest. The ranking is a
//! port of the part of v2's Automatic that matters for chat: `packages/core/src/router.ts`
//! `sunk` / `STRIKE_HALF_LIFE` and `ranking`, and `pool.ts` `remaining` / `spent` (headroom).
//! Only the free catalog is read, so a paid model (D212) or a local one (D213) is never chosen.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use alexia_store::{now_ms, Content, Ms, Part, SessionId, Store, Try, TryRow, Usage};
use tokio::sync::mpsc;
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::catalog::{size_of, Candidate, Catalog};
use crate::redact::redact_request_known;
use crate::{
    ms_since, Budget, ChatChunk, ChatDone, ChatRequest, Job, Provider, ProviderError, RunId,
};

/// v2's `STRIKE_HALF_LIFE`: a failure counts one when it happens and halves every hour.
pub const STRIKE_HALF_LIFE_MS: f64 = 60.0 * 60.0 * 1000.0;
/// v2's `BUSY_HALF_LIFE` (`health.ts`): a busy reply is a host full for a moment, so it halves
/// in two minutes, not an hour.
pub const BUSY_HALF_LIFE_MS: f64 = 2.0 * 60.0 * 1000.0;
/// The store forgets a strike after a day (v2), so the ranking reads no further back.
const LOOKBACK_MS: Ms = 24 * 60 * 60 * 1000;
const MAX_RUNNING: usize = 4;
const MAX_STARTED: usize = 6;
/// How many successful tries the first-byte median is taken over.
const MEDIAN_OF: usize = 10;
/// MO-12: how long a model that charged is left alone.
const ASIDE_MS: Ms = 30 * 24 * 60 * 60 * 1000;
const NO_FREE: &str = "No free model can answer right now.";
/// v2 `trim.ts` `PER_TOKEN`: characters per token.
const PER_TOKEN: usize = 3;
/// A model whose window is unknown is trusted with requests under this many tokens only.
const UNKNOWN_WINDOW_OK: u32 = 8_192;

/// What a request asks of a model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Needs {
    pub tools: bool,
    pub vision: bool,
    pub tokens: u32,
}

impl Needs {
    pub fn of(req: &ChatRequest) -> Needs {
        let mut chars = req.system.as_deref().map_or(0, |s| s.chars().count());
        let mut vision = false;
        for (_, body) in &req.messages {
            match &body.content {
                Content::Text(t) => chars += t.chars().count(),
                Content::Parts(parts) => {
                    for part in parts {
                        match part {
                            Part::Text { text } => chars += text.chars().count(),
                            Part::Image { .. } => vision = true, // not counted: a data URL is not text
                        }
                    }
                }
            }
            if let Some(calls) = &body.calls {
                chars += serde_json::to_string(calls).map_or(0, |s| s.len());
            }
        }
        if !req.tools.is_empty() {
            chars += serde_json::to_string(&req.tools).map_or(0, |s| s.len());
        }
        Needs {
            tools: !req.tools.is_empty(),
            vision,
            tokens: u32::try_from(chars.div_ceil(PER_TOKEN)).unwrap_or(u32::MAX),
        }
    }

    fn tools_ok(&self, c: &Candidate) -> bool {
        !self.tools || c.tools
    }
    fn vision_ok(&self, c: &Candidate) -> bool {
        !self.vision || c.vision
    }
    fn room_ok(&self, c: &Candidate) -> bool {
        if c.context == 0 {
            self.tokens < UNKNOWN_WINDOW_OK
        } else {
            self.tokens <= c.context
        }
    }
    fn fits(&self, c: &Candidate) -> bool {
        self.tools_ok(c) && self.vision_ok(c) && self.room_ok(c)
    }

    /// The sentence for a list the filter emptied: the first need no candidate meets alone.
    fn unmet(&self, list: &[Candidate]) -> &'static str {
        if !list.iter().any(|c| self.tools_ok(c)) {
            "No free model that can use tools can answer right now."
        } else if !list.iter().any(|c| self.vision_ok(c)) {
            "No free model that can see pictures can answer right now."
        } else if !list.iter().any(|c| self.room_ok(c)) {
            "No free model with a window this large can answer right now."
        } else {
            "No free model that can do all of this can answer right now."
        }
    }
}

pub struct Router {
    providers: RwLock<HashMap<String, Arc<dyn Provider>>>,
    /// Ids added by `set_provider` (local runtime, subscriptions); their models are read when asked.
    runtime: RwLock<HashSet<String>>,
    /// Ids of the providers that run on this machine (D213).
    local: RwLock<HashSet<String>>,
    /// Sentences for the agent to show, per run, taken by `take_notes`.
    notes: Mutex<HashMap<Option<RunId>, Vec<String>>>,
    /// The keychain keys and when they were read, for `KEYS_FRESH`.
    keys: Mutex<Option<(Instant, Arc<Vec<String>>)>>,
    catalog: Arc<Catalog>,
    store: Arc<Store>,
}

/// One step's ask (MO-14). `avoid` is `"provider\nmodel"` per entry.
#[derive(Clone, Debug)]
pub struct StepAsk {
    pub job: Job,
    pub avoid: Vec<String>,
    pub plugin: Option<String>,
    pub run: Option<RunId>,
    pub session: Option<SessionId>,
}

/// Who a race's usage row is for.
#[derive(Default)]
pub(crate) struct Attribution {
    pub(crate) plugin: Option<String>,
    pub(crate) run: Option<RunId>,
    pub(crate) session: Option<SessionId>,
}

/// How a job orders the free list (v2 `shapeOf`, free half).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Shape {
    /// Today's order.
    Chat,
    /// Larger first: planning and code.
    Large,
    /// Fastest median first: steps.
    Fast,
}

impl Shape {
    fn of(job: Job) -> Shape {
        match job {
            Job::Plan | Job::Code => Shape::Large,
            Job::Step => Shape::Fast,
            _ => Shape::Chat,
        }
    }
}

/// How long `race` trusts the keys it read. A key the owner adds meanwhile is still caught by
/// the generic patterns of `redact_request` until the next read.
const KEYS_FRESH: Duration = Duration::from_secs(60);

fn read_keys(catalog: &Catalog) -> Vec<String> {
    catalog
        .rows()
        .iter()
        .filter_map(crate::free::key_for)
        .collect()
}

fn key(c: &Candidate) -> String {
    format!("{}\n{}", c.provider, c.model)
}

type Attempt = JoinHandle<Result<ChatDone, ProviderError>>;

/// What an attempt's watcher heard first.
enum Heard {
    First {
        chunk: ChatChunk,
        first_ms: u32,
        rx: mpsc::Receiver<ChatChunk>,
        attempt: Attempt,
    },
    /// It ended without sending a chunk.
    Ended {
        result: Result<ChatDone, ProviderError>,
        ms: u32,
    },
}

struct Slot {
    candidate: Candidate,
    token: CancellationToken,
    live: bool,
}

/// One `hedged` call's attempts. Owned by the call; attempts talk back over channels only.
struct Race<'a> {
    router: &'a Router,
    req: Arc<ChatRequest>,
    /// What a non-local provider gets: `req` redacted.
    cloud: Arc<ChatRequest>,
    queue: Vec<Candidate>,
    slots: Vec<Slot>,
    watching: JoinSet<(usize, Heard)>,
    cancel: &'a CancellationToken,
}

impl Router {
    pub fn new(
        providers: Vec<Arc<dyn Provider>>,
        catalog: Arc<Catalog>,
        store: Arc<Store>,
    ) -> Router {
        let providers = providers
            .into_iter()
            .map(|p| (p.id().to_owned(), p))
            .collect();
        Router {
            providers: RwLock::new(providers),
            runtime: RwLock::default(),
            local: RwLock::default(),
            notes: Mutex::default(),
            keys: Mutex::default(),
            catalog,
            store,
        }
    }

    /// The ranked list `hedged` would use now, for the dashboard and tests (at `Budget::CHAT`).
    pub fn ranked(&self, now: Ms) -> Vec<Candidate> {
        self.rank(now, Budget::CHAT)
    }

    /// `ranked`, without the models that cannot do what `needs` asks.
    pub fn ranked_for(&self, now: Ms, needs: &Needs) -> Vec<Candidate> {
        let mut list = self.ranked(now);
        list.retain(|c| needs.fits(c));
        list
    }

    fn rank(&self, now: Ms, budget: Budget) -> Vec<Candidate> {
        self.rank_by(now, budget, Shape::Chat)
    }

    fn rank_by(&self, now: Ms, budget: Budget, shape: Shape) -> Vec<Candidate> {
        let aside = self.aside(now);
        let tries = self
            .store
            .tries_since(now - LOOKBACK_MS)
            .unwrap_or_else(|e| {
                tracing::warn!("the router could not read its tries: {e}");
                Vec::new()
            });
        let mut scored: Vec<(Score, Candidate)> = self
            .catalog
            .candidates()
            .into_iter()
            .filter(|c| {
                self.provider(&c.provider).is_some()
                    && self.has_room(&c.provider, now)
                    && !aside.contains(&key(c))
            })
            .map(|c| (Score::of(&c, &tries, now, budget), c))
            .collect();
        scored.sort_by(|(a, ca), (b, cb)| {
            let size = |x: &Candidate, y: &Candidate| match (x.size_b, y.size_b) {
                (Some(x), Some(y)) => y.total_cmp(&x),
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (None, None) => Ordering::Equal,
            };
            let first = a.sunk.cmp(&b.sunk);
            let first = match shape {
                Shape::Large => first.then_with(|| size(ca, cb)),
                // Untried (tier 1) after every tried model, then the fastest median.
                Shape::Fast => first
                    .then((a.tier == 1).cmp(&(b.tier == 1)))
                    .then(a.median.cmp(&b.median)),
                Shape::Chat => first,
            };
            first
                .then(a.tier.cmp(&b.tier))
                .then(a.median.cmp(&b.median))
                // Routers last (v2 D159), then larger first, then id order.
                .then(ca.router.cmp(&cb.router))
                .then_with(|| size(ca, cb))
                .then_with(|| (&ca.provider, &ca.model).cmp(&(&cb.provider, &cb.model)))
        });
        scored.into_iter().map(|(_, c)| c).collect()
    }

    /// Minute and day headroom against the ladder row's `rpm` / `rpd` (v2 `remaining`).
    fn has_room(&self, provider: &str, now: Ms) -> bool {
        let Some(row) = self.catalog.row(provider) else {
            return false;
        };
        let under = |span: &str, limit: Option<u32>| {
            limit.is_none_or(|limit| {
                self.store.request_count(provider, span, now).unwrap_or(0) < u64::from(limit)
            })
        };
        under("minute", row.rpm) && under("day", row.rpd)
    }

    /// D212 + SP-07. Starts the best two candidates at once; whichever sends a first chunk wins
    /// and the other is cancelled. Each time `budget.first_byte_ms` passes with no first chunk
    /// from anyone, one more candidate starts (at most 4 running). A candidate that fails is
    /// replaced by the next. Chunks from the winner only are forwarded to `out`.
    pub async fn hedged(
        &self,
        req: &ChatRequest,
        budget: Budget,
        out: mpsc::Sender<ChatChunk>,
        cancel: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        let now = now_ms();
        let needs = Needs::of(req);
        let mut queue = self.rank(now, budget);
        if queue.is_empty() {
            return Err(ProviderError::Other(NO_FREE.into()));
        }
        if !queue.iter().all(|c| needs.fits(c)) {
            let all = std::mem::take(&mut queue);
            queue = all.iter().filter(|c| needs.fits(c)).cloned().collect();
            if queue.is_empty() {
                return Err(ProviderError::Other(needs.unmet(&all).into()));
            }
        }
        self.race(req, queue, budget, out, cancel, Attribution::default())
            .await
            .0
    }

    /// The race itself, shared by `hedged` and `step`: `queue` in order. TR-04: every non-local
    /// candidate gets one redacted copy of `req` (built once per call), a local one gets `req`.
    /// Also returns the kinds removed, for `step`'s note.
    async fn race(
        &self,
        req: &ChatRequest,
        queue: Vec<Candidate>,
        budget: Budget,
        out: mpsc::Sender<ChatChunk>,
        cancel: CancellationToken,
        attr: Attribution,
    ) -> (Result<ChatDone, ProviderError>, Vec<String>) {
        let req = Arc::new(req.clone());
        let (cloud, kinds) = if queue.iter().any(|c| !self.is_local(&c.provider)) {
            let (cloud, kinds) = redact_request_known(&req, &self.keys().await);
            if !kinds.is_empty() {
                tracing::debug!(?kinds, "redacted before sending to cloud");
            }
            (Arc::new(cloud), kinds)
        } else {
            (req.clone(), Vec::new())
        };
        let result = self
            .run_race(req, cloud, queue, budget, out, cancel, attr)
            .await;
        (result, kinds)
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_race(
        &self,
        req: Arc<ChatRequest>,
        cloud: Arc<ChatRequest>,
        queue: Vec<Candidate>,
        budget: Budget,
        out: mpsc::Sender<ChatChunk>,
        cancel: CancellationToken,
        attr: Attribution,
    ) -> Result<ChatDone, ProviderError> {
        let now = now_ms();
        let mut race = Race {
            router: self,
            req,
            cloud,
            queue,
            slots: Vec::new(),
            watching: JoinSet::new(),
            cancel: &cancel,
        };
        race.start_next();
        race.start_next();

        let every = Duration::from_millis(u64::from(budget.first_byte_ms.max(1)));
        let mut hedge = Instant::now() + every;
        let mut last_err = None;
        let (winner, heard) = loop {
            if race.watching.is_empty() {
                return Err(last_err.unwrap_or_else(|| ProviderError::Other(NO_FREE.into())));
            }
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    race.stop_all();
                    return Err(ProviderError::Cancelled);
                }
                Some(joined) = race.watching.join_next() => {
                    // A watcher only selects and is never aborted while the race runs.
                    let Ok((at, heard)) = joined else { continue };
                    match heard {
                        Heard::Ended { result: Err(e), ms } => {
                            race.slots[at].live = false;
                            self.record_try(&race.slots[at].candidate, outcome(&e), Some(ms));
                            last_err = Some(e);
                            race.start_next();
                        }
                        heard => break (at, heard),
                    }
                }
                _ = tokio::time::sleep_until(hedge) => {
                    hedge += every;
                    race.start_next();
                }
            }
        };

        // A winner: every other attempt was sent, loses the race and is stopped.
        race.slots[winner].live = false;
        for slot in race.slots.iter_mut().filter(|s| s.live) {
            slot.token.cancel();
            slot.live = false;
            self.record_try(&slot.candidate, "lost-race", None);
        }
        let Race {
            mut slots,
            watching,
            ..
        } = race;
        drop(watching); // The losers' watchers; their attempts stop on their tokens.
        let Slot {
            candidate, token, ..
        } = slots.swap_remove(winner);

        let (result, first_ms, total_ms) = match heard {
            Heard::Ended { result, ms } => (result, ms, ms),
            Heard::First {
                chunk,
                first_ms,
                mut rx,
                attempt,
            } => {
                let started = Instant::now() - Duration::from_millis(u64::from(first_ms));
                let mut next = Some(chunk);
                while let Some(chunk) = next {
                    let sent = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => false,
                        r = out.send(chunk) => r.is_ok(),
                    };
                    if !sent {
                        token.cancel();
                        return Err(ProviderError::Cancelled);
                    }
                    next = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => {
                            token.cancel();
                            return Err(ProviderError::Cancelled);
                        }
                        c = rx.recv() => c,
                    };
                }
                let result = attempt.await.unwrap_or_else(|e| Err(stopped(e)));
                (result, first_ms, ms_since(started.into_std()))
            }
        };

        match result {
            Ok(mut done) => {
                self.record_answer(&candidate, &done, first_ms, total_ms, now, &attr);
                done.first_byte_ms = Some(first_ms);
                Ok(done)
            }
            // It broke after text was shown, so nothing can take over the answer.
            Err(e) => {
                self.record_try(&candidate, outcome(&e), Some(total_ms));
                Err(e)
            }
        }
    }

    /// MO-11, MO-12, MO-14, D213. One task step: the owner's pins for `ask.job` first, then the
    /// free list in the job's order, raced like `hedged`. Only models known to be free, a
    /// subscription CLI or a local model are asked, local ones only for Vision, Check and Local.
    /// Requests to non-local providers go out redacted; what was removed and which pins were
    /// skipped is left for `take_notes`.
    pub async fn step(
        &self,
        req: &ChatRequest,
        ask: &StepAsk,
        budget: Budget,
        out: mpsc::Sender<ChatChunk>,
        cancel: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        let now = now_ms();
        let needs = Needs::of(req);
        let local_job = matches!(ask.job, Job::Vision | Job::Check | Job::Local);
        let aside = self.aside(now);
        let skip = |c: &Candidate| ask.avoid.contains(&key(c)) || aside.contains(&key(c));
        let pins = self.pins().remove(job_name(ask.job)).unwrap_or_default();

        // Models of runtime providers: the local ones for a local job, and any a pin names.
        let mut runtime = Vec::new();
        for id in self.runtime_ids() {
            let named = pins.iter().any(|p| pin_provider(p).is_none_or(|n| n == id));
            if !(named || local_job && self.is_local(&id)) {
                continue;
            }
            let Some(provider) = self.provider(&id) else {
                continue;
            };
            for m in provider.models().await.unwrap_or_default() {
                if m.free {
                    runtime.push(Candidate {
                        size_b: size_of(&m.id),
                        provider: id.clone(),
                        model: m.id,
                        context: m.context,
                        tools: m.tools,
                        vision: m.vision,
                        router: false,
                    });
                }
            }
        }

        let catalog = self.catalog.candidates();
        let mut queue: Vec<Candidate> = Vec::new();
        let put = |queue: &mut Vec<Candidate>, c: Candidate| {
            if !queue.iter().any(|q| key(q) == key(&c)) {
                queue.push(c);
            }
        };
        for pin in &pins {
            let found = if let Some(cli) = pin.strip_prefix("subscription:") {
                runtime
                    .iter()
                    .find(|c| c.provider == format!("subscription:{cli}"))
            } else if let Some(id) = pin.strip_prefix("local:") {
                runtime
                    .iter()
                    .find(|c| c.model == id && self.is_local(&c.provider))
            } else {
                pin.split_once('/')
                    .and_then(|(p, m)| catalog.iter().find(|c| c.provider == p && c.model == m))
            };
            let why = match found {
                None => "it is not free, has no key or is not available",
                Some(c) if self.is_local(&c.provider) && !local_job => {
                    "local models are only used for pictures, checks and local jobs"
                }
                Some(c) if skip(c) => "it was just tried or charged",
                Some(c) if !needs.fits(c) => "it cannot do what this step needs",
                Some(c)
                    if self.catalog.row(&c.provider).is_some()
                        && !self.has_room(&c.provider, now) =>
                {
                    "it is out of requests for now"
                }
                Some(c) => {
                    put(&mut queue, c.clone());
                    continue;
                }
            };
            self.note(&ask.run, format!("Skipped the pinned model {pin}: {why}."));
        }
        if local_job {
            for c in runtime.iter().filter(|c| self.is_local(&c.provider)) {
                if needs.fits(c) && !skip(c) {
                    put(&mut queue, c.clone());
                }
            }
        }
        if ask.job != Job::Local {
            for c in self.rank_by(now, budget, Shape::of(ask.job)) {
                if !self.is_local(&c.provider) && needs.fits(&c) && !skip(&c) {
                    put(&mut queue, c);
                }
            }
        }
        if queue.is_empty() {
            return Err(ProviderError::Other(NO_FREE.into()));
        }

        let attr = Attribution {
            plugin: ask.plugin.clone(),
            run: ask.run.clone(),
            session: ask.session,
        };
        let (result, kinds) = self.race(req, queue, budget, out, cancel, attr).await;
        if !kinds.is_empty() {
            self.note(&ask.run, format!("Removed {} before sending.", kinds.join(", ")));
        }
        result
    }

    /// Providers added at run time (local runtime, subscriptions). Replaces one with the same id.
    pub fn set_provider(&self, p: Arc<dyn Provider>, local: bool) {
        let id = p.id().to_owned();
        write(&self.providers).insert(id.clone(), p);
        write(&self.runtime).insert(id.clone());
        let mut set = write(&self.local);
        if local {
            set.insert(id);
        } else {
            set.remove(&id);
        }
    }

    pub fn remove_provider(&self, id: &str) {
        write(&self.providers).remove(id);
        write(&self.runtime).remove(id);
        write(&self.local).remove(id);
    }

    /// The owner's pins: job name → `"<provider>/<model>"`, `"subscription:<cli>"` or `"local:<id>"`.
    pub fn pins(&self) -> BTreeMap<String, Vec<String>> {
        match self.store.kv_get("_core", "models") {
            Ok(Some(v)) => serde_json::from_value(v).unwrap_or_else(|_| {
                tracing::warn!("the router could not read the pinned models, so they are ignored");
                BTreeMap::new()
            }),
            Ok(None) => BTreeMap::new(),
            Err(e) => {
                tracing::warn!("the router could not read its pins: {e}");
                BTreeMap::new()
            }
        }
    }

    pub fn set_pins(&self, job: Job, models: Vec<String>) -> crate::Result<()> {
        let mut all = self.pins();
        if models.is_empty() {
            all.remove(job_name(job));
        } else {
            all.insert(job_name(job).into(), models);
        }
        self.store
            .kv_set("_core", "models", &serde_json::json!(all))?;
        Ok(())
    }

    /// The notes `step` left for `run` (a pin skipped, secrets removed), once.
    pub fn take_notes(&self, run: Option<&RunId>) -> Vec<String> {
        self.notes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&run.cloned())
            .unwrap_or_default()
    }

    fn note(&self, run: &Option<RunId>, text: String) {
        self.notes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(run.clone())
            .or_default()
            .push(text);
    }

    pub(crate) fn provider(&self, id: &str) -> Option<Arc<dyn Provider>> {
        read(&self.providers).get(id).cloned()
    }

    pub(crate) fn is_local(&self, id: &str) -> bool {
        read(&self.local).contains(id)
    }

    fn runtime_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = read(&self.runtime).iter().cloned().collect();
        ids.sort();
        ids
    }

    /// Keys in the keychain, so they are never sent in a message (P2-14). Read now, on this
    /// thread; `compare` uses it.
    pub(crate) fn known_secrets(&self) -> Vec<String> {
        read_keys(&self.catalog)
    }

    /// `known_secrets` for `race`: at most one keychain read per `KEYS_FRESH`, off the async
    /// workers. Two racing misses may both read.
    async fn keys(&self) -> Arc<Vec<String>> {
        let lock = || self.keys.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, keys)) = lock().as_ref() {
            if at.elapsed() < KEYS_FRESH {
                return keys.clone();
            }
        }
        let catalog = self.catalog.clone();
        let keys = Arc::new(
            tokio::task::spawn_blocking(move || read_keys(&catalog))
                .await
                .unwrap_or_default(),
        );
        *lock() = Some((Instant::now(), keys.clone()));
        keys
    }

    /// `"provider\nmodel"` of every model set aside and not yet forgiven.
    fn aside(&self, now: Ms) -> HashSet<String> {
        let map: HashMap<String, Ms> = match self.store.kv_get("_core", "aside") {
            Ok(Some(v)) => serde_json::from_value(v).unwrap_or_default(),
            _ => HashMap::new(),
        };
        map.into_iter()
            .filter(|(_, until)| *until > now)
            .map(|(k, _)| k)
            .collect()
    }

    fn set_aside(&self, c: &Candidate, now: Ms) {
        let mut map: HashMap<String, Ms> = match self.store.kv_get("_core", "aside") {
            Ok(Some(v)) => serde_json::from_value(v).unwrap_or_default(),
            _ => HashMap::new(),
        };
        map.retain(|_, until| *until > now);
        map.insert(key(c), now + ASIDE_MS);
        if let Err(e) = self.store.kv_set("_core", "aside", &serde_json::json!(map)) {
            tracing::warn!("the router could not set a model aside: {e}");
        }
    }

    /// Count one request toward the provider's rpm/rpd.
    pub(crate) fn record_request(&self, provider: &str) {
        if let Err(e) = self.store.record_request(provider, now_ms()) {
            tracing::warn!("the router could not count a request: {e}");
        }
    }

    /// A finished answer: the try (MO-12: a charged one is set aside) and its usage row.
    pub(crate) fn record_answer(
        &self,
        c: &Candidate,
        done: &ChatDone,
        first_ms: u32,
        total_ms: u32,
        now: Ms,
        attr: &Attribution,
    ) {
        if done.cost > 0.0 {
            // MO-12: it charged. The agent turns the row into a warning line.
            self.record_try(c, "charged", Some(first_ms));
            self.set_aside(c, now);
        } else {
            self.record_try(c, "ok", Some(first_ms));
        }
        if let Err(e) = self.store.record_usage(&Usage {
            at: now_ms(),
            session: attr.session,
            plugin: attr.plugin.clone(),
            model: done.model.clone(),
            asked: None,
            provider: done.provider.clone(),
            tokens_in: done.tokens_in,
            tokens_out: done.tokens_out,
            cost: done.cost,
            run_id: attr.run.as_ref().map(|r| r.0.clone()),
            writing_ms: Some(i64::from(total_ms.saturating_sub(first_ms))),
        }) {
            tracing::warn!("the router could not record usage: {e}");
        }
    }

    pub(crate) fn record_try(&self, c: &Candidate, outcome: &str, waited_ms: Option<u32>) {
        let t = Try {
            at: now_ms(),
            provider: c.provider.clone(),
            model: c.model.clone(),
            outcome: outcome.into(),
            status: 0,
            source: "chat".into(),
            waited_ms: waited_ms.map(i64::from),
        };
        if let Err(e) = self.store.record_try(&t) {
            tracing::warn!("the router could not record a try: {e}");
        }
    }
}

impl Race<'_> {
    /// Starts the best queued candidate whose provider is not already running (one account's
    /// rate limit is not hit twice for no gain), within the running and started caps.
    fn start_next(&mut self) {
        if self.watching.len() >= MAX_RUNNING || self.slots.len() >= MAX_STARTED {
            return;
        }
        let busy = |p: &str| {
            self.slots
                .iter()
                .any(|s| s.live && s.candidate.provider == p)
        };
        let Some(at) = self.queue.iter().position(|c| !busy(&c.provider)) else {
            return;
        };
        let candidate = self.queue.remove(at);
        let router = self.router;
        let Some(provider) = router.provider(&candidate.provider) else {
            return;
        };
        router.record_request(&candidate.provider);

        let token = self.cancel.child_token();
        let (tx, mut rx) = mpsc::channel(64);
        let req = if router.is_local(&candidate.provider) {
            self.req.clone()
        } else {
            self.cloud.clone()
        };
        let (model, child) = (candidate.model.clone(), token.clone());
        let started = Instant::now();
        let mut attempt: Attempt =
            tokio::spawn(async move { provider.chat(&req, &model, tx, child).await });
        let index = self.slots.len();
        self.watching.spawn(async move {
            let got = tokio::select! {
                biased;
                Some(chunk) = rx.recv() => Ok(chunk),
                r = &mut attempt => Err(r),
            };
            let ms = ms_since(started.into_std());
            let heard = match got {
                Ok(chunk) => Heard::First {
                    chunk,
                    first_ms: ms,
                    rx,
                    attempt,
                },
                Err(joined) => Heard::Ended {
                    result: joined.unwrap_or_else(|e| Err(stopped(e))),
                    ms,
                },
            };
            (index, heard)
        });
        self.slots.push(Slot {
            candidate,
            token,
            live: true,
        });
    }

    fn stop_all(&mut self) {
        for slot in &mut self.slots {
            slot.token.cancel();
            slot.live = false;
        }
    }
}

/// Where a candidate stands on what the store remembers of it.
struct Score {
    /// v2 `sunk`: failures carried, each halving every hour, rounded.
    sunk: i64,
    /// 0 = tried and fast (median first byte within budget), 1 = untried, 2 = tried and slow.
    tier: u8,
    median: i64,
}

impl Score {
    fn of(c: &Candidate, tries: &[TryRow], now: Ms, budget: Budget) -> Score {
        let own = tries
            .iter()
            .filter(|t| t.provider == c.provider && t.model == c.model);
        let carried: f64 = own
            .clone()
            .filter(|t| !matches!(t.outcome.as_str(), "ok" | "lost-race"))
            .map(|t| {
                let half = if t.outcome == "busy" {
                    BUSY_HALF_LIFE_MS
                } else {
                    STRIKE_HALF_LIFE_MS
                };
                0.5f64.powf((now - t.at).max(0) as f64 / half)
            })
            .sum();
        let waited: Vec<i64> = own
            .filter(|t| t.outcome == "ok")
            .filter_map(|t| t.waited_ms)
            .collect();
        let mut last: Vec<i64> = waited[waited.len().saturating_sub(MEDIAN_OF)..].to_vec();
        last.sort_unstable();
        let (tier, median) = match last.get(last.len() / 2) {
            None => (1, 0),
            Some(&m) if m <= i64::from(budget.first_byte_ms) => (0, m),
            Some(&m) => (2, m),
        };
        Score {
            sunk: carried.round() as i64,
            tier,
            median,
        }
    }
}

/// v2's outcome strings for a failed try.
pub(crate) fn outcome(e: &ProviderError) -> &'static str {
    match e {
        ProviderError::Busy { .. } => "busy",
        ProviderError::NeedsKey | ProviderError::Refused(_) => "refused",
        ProviderError::Unreachable | ProviderError::Cancelled | ProviderError::Other(_) => {
            "unreachable"
        }
    }
}

fn stopped(e: tokio::task::JoinError) -> ProviderError {
    ProviderError::Other(format!("the request stopped: {e}"))
}

fn read<T>(l: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    l.read().unwrap_or_else(|e| e.into_inner())
}

fn write<T>(l: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    l.write().unwrap_or_else(|e| e.into_inner())
}

/// The key a job's pins are stored under.
fn job_name(job: Job) -> &'static str {
    match job {
        Job::Chat => "chat",
        Job::Plan => "plan",
        Job::Step => "step",
        Job::Code => "code",
        Job::Vision => "vision",
        Job::Check => "check",
        Job::Local => "local",
    }
}

/// The runtime provider a pin names (`subscription:<cli>`), if it names one by id.
fn pin_provider(pin: &str) -> Option<&str> {
    pin.starts_with("subscription:").then_some(pin)
}
