// SPDX-License-Identifier: AGPL-3.0-only
//! P1-06: Router::hedged (D212, SP-07, MO-03, MO-04).
//!
//! Races the best free candidates for the first byte and keeps the fastest. The ranking is a
//! port of the part of v2's Automatic that matters for chat: `packages/core/src/router.ts`
//! `sunk` / `STRIKE_HALF_LIFE` and `ranking`, and `pool.ts` `remaining` / `spent` (headroom).
//! Only the free catalog is read, so a paid model (D212) or a local one (D213) is never chosen.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use alexia_store::{now_ms, Ms, Store, Try, TryRow, Usage};
use tokio::sync::mpsc;
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::catalog::{Candidate, Catalog};
use crate::{Budget, ChatChunk, ChatDone, ChatRequest, Provider, ProviderError};

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
const NO_FREE: &str = "No free model can answer right now.";

pub struct Router {
    providers: HashMap<String, Arc<dyn Provider>>,
    catalog: Arc<Catalog>,
    store: Arc<Store>,
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
            providers,
            catalog,
            store,
        }
    }

    /// The ranked list `hedged` would use now, for the dashboard and tests (at `Budget::CHAT`).
    pub fn ranked(&self, now: Ms) -> Vec<Candidate> {
        self.rank(now, Budget::CHAT)
    }

    fn rank(&self, now: Ms, budget: Budget) -> Vec<Candidate> {
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
            .filter(|c| self.providers.contains_key(&c.provider) && self.has_room(&c.provider, now))
            .map(|c| (Score::of(&c, &tries, now, budget), c))
            .collect();
        scored.sort_by(|(a, ca), (b, cb)| {
            a.sunk
                .cmp(&b.sunk)
                .then(a.tier.cmp(&b.tier))
                .then(a.median.cmp(&b.median))
                // Routers last (v2 D159), then larger first, then id order.
                .then(ca.router.cmp(&cb.router))
                .then(match (ca.size_b, cb.size_b) {
                    (Some(x), Some(y)) => y.total_cmp(&x),
                    (Some(_), None) => Ordering::Less,
                    (None, Some(_)) => Ordering::Greater,
                    (None, None) => Ordering::Equal,
                })
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
        let queue = self.rank(now_ms(), budget);
        if queue.is_empty() {
            return Err(ProviderError::Other(NO_FREE.into()));
        }
        let mut race = Race {
            router: self,
            req: Arc::new(req.clone()),
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
                (result, first_ms, elapsed_ms(started))
            }
        };

        match result {
            Ok(mut done) => {
                self.record_try(&candidate, "ok", Some(first_ms));
                if let Err(e) = self.store.record_usage(&Usage {
                    at: now_ms(),
                    session: None,
                    plugin: None,
                    model: done.model.clone(),
                    asked: None,
                    provider: done.provider.clone(),
                    tokens_in: done.tokens_in,
                    tokens_out: done.tokens_out,
                    cost: done.cost,
                    run_id: None,
                    writing_ms: Some(i64::from(total_ms.saturating_sub(first_ms))),
                }) {
                    tracing::warn!("the router could not record usage: {e}");
                }
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

    fn record_try(&self, c: &Candidate, outcome: &str, waited_ms: Option<u32>) {
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
        let Some(provider) = router.providers.get(&candidate.provider).cloned() else {
            return;
        };
        if let Err(e) = router.store.record_request(&candidate.provider, now_ms()) {
            tracing::warn!("the router could not count a request: {e}");
        }

        let token = self.cancel.child_token();
        let (tx, mut rx) = mpsc::channel(64);
        let (req, model, child) = (self.req.clone(), candidate.model.clone(), token.clone());
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
            let ms = elapsed_ms(started);
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
fn outcome(e: &ProviderError) -> &'static str {
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

fn elapsed_ms(since: Instant) -> u32 {
    u32::try_from(since.elapsed().as_millis()).unwrap_or(u32::MAX)
}

