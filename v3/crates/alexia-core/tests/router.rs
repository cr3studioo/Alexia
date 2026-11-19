// SPDX-License-Identifier: AGPL-3.0-only
//! P1-06: Router::hedged against scripted fake providers. No network.
//!
//! Real time, not `tokio::time::pause()`: alexia-core's tokio has no `test-util` feature. Every
//! race is set up so the order cannot flip on a slow machine (the loser waits tens of seconds),
//! and lower bounds are exact while upper bounds are generous.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use alexia_core::catalog::Catalog;
use alexia_core::free::{Auth, FreeRow};
use alexia_core::router::Router;
use alexia_core::{Budget, ChatChunk, ChatDone, ChatRequest, ModelInfo, Provider, ProviderError};
use alexia_store::{Ms, Store, Try};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// The loser's delay: far beyond anything a test waits for.
const NEVER: Duration = Duration::from_secs(60);
const GENEROUS: Duration = Duration::from_secs(20);

#[derive(Clone)]
enum Then {
    Say(&'static str),
    Fail(fn() -> ProviderError),
    Silent,
}

#[derive(Clone)]
struct Script {
    after: Duration,
    then: Then,
}

fn says(ms: u64, text: &'static str) -> Script {
    Script {
        after: Duration::from_millis(ms),
        then: Then::Say(text),
    }
}

fn silent() -> Script {
    Script {
        after: Duration::ZERO,
        then: Then::Silent,
    }
}

fn busy() -> Script {
    Script {
        after: Duration::ZERO,
        then: Then::Fail(|| ProviderError::Busy {
            retry_after_ms: None,
        }),
    }
}

/// What every fake saw, shared by the test.
#[derive(Default)]
struct Log {
    /// (model, when it was asked).
    started: Mutex<Vec<(String, Instant)>>,
    /// Models whose cancel token fired.
    cancelled: Mutex<Vec<String>>,
}

impl Log {
    fn started(&self) -> Vec<String> {
        let started = self.started.lock().unwrap();
        started.iter().map(|(m, _)| m.clone()).collect()
    }
    fn started_at(&self, model: &str) -> Option<Instant> {
        let started = self.started.lock().unwrap();
        started.iter().find(|(m, _)| m == model).map(|(_, at)| *at)
    }
    fn was_cancelled(&self, model: &str) -> bool {
        self.cancelled.lock().unwrap().iter().any(|m| m == model)
    }
}

struct Fake {
    id: String,
    models: Vec<ModelInfo>,
    scripts: HashMap<String, Script>,
    log: Arc<Log>,
}

#[async_trait::async_trait]
impl Provider for Fake {
    fn id(&self) -> &str {
        &self.id
    }
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(self.models.clone())
    }
    async fn chat(
        &self,
        _: &ChatRequest,
        model: &str,
        out: mpsc::Sender<ChatChunk>,
        cancel: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        self.log
            .started
            .lock()
            .unwrap()
            .push((model.into(), Instant::now()));
        let script = self.scripts[model].clone();
        let work = async {
            tokio::time::sleep(script.after).await;
            match script.then {
                Then::Say(text) => {
                    for word in text.split_inclusive(' ') {
                        let _ = out.send(ChatChunk::Text(word.into())).await;
                    }
                    Ok(ChatDone {
                        model: model.into(),
                        provider: self.id.clone(),
                        tokens_in: 3,
                        tokens_out: 2,
                        cost: 0.0,
                        first_byte_ms: None,
                    })
                }
                Then::Fail(error) => Err(error()),
                Then::Silent => std::future::pending().await,
            }
        };
        tokio::select! {
            _ = cancel.cancelled() => {
                self.log.cancelled.lock().unwrap().push(model.into());
                Err(ProviderError::Cancelled)
            }
            r = work => r,
        }
    }
}

struct World {
    router: Router,
    store: Arc<Store>,
    log: Arc<Log>,
    cache: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.cache);
    }
}

fn row(id: &str, rpd: Option<u32>) -> FreeRow {
    FreeRow {
        id: id.into(),
        base_url: format!("http://{id}.invalid/v1"),
        models_path: Some("/models".into()),
        headers: Vec::new(),
        auth: Auth::Optional,
        all_free: true,
        rpm: None,
        rpd,
        router: false,
    }
}

fn info(id: &str, free: bool) -> ModelInfo {
    ModelInfo {
        id: id.into(),
        context: 32_768,
        free,
        tools: false,
        vision: false,
    }
}

/// `providers`: (provider id, [(model id, script)]). Model ids carry a size, so untried models
/// rank by it (larger first) and each test reads its order off the names.
async fn world(providers: &[(&str, Vec<(&str, Script)>)], rows: Vec<FreeRow>, free: bool) -> World {
    static N: AtomicU64 = AtomicU64::new(0);
    let cache = std::env::temp_dir().join(format!(
        "alexia-router-test-{}-{}.json",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let log = Arc::new(Log::default());
    let fakes: Vec<Arc<dyn Provider>> = providers
        .iter()
        .map(|(id, models)| {
            Arc::new(Fake {
                id: (*id).into(),
                models: models.iter().map(|(m, _)| info(m, free)).collect(),
                scripts: models
                    .iter()
                    .map(|(m, s)| ((*m).to_owned(), s.clone()))
                    .collect(),
                log: log.clone(),
            }) as Arc<dyn Provider>
        })
        .collect();
    let catalog = Arc::new(Catalog::new(fakes.clone(), rows, cache.clone()));
    catalog.refresh().await;
    let store = Arc::new(Store::open_in_memory().unwrap());
    World {
        router: Router::new(fakes, catalog, store.clone()),
        store,
        log,
        cache,
    }
}

fn rows(ids: &[&str]) -> Vec<FreeRow> {
    ids.iter().map(|id| row(id, None)).collect()
}

fn request() -> ChatRequest {
    ChatRequest {
        messages: Vec::new(),
        system: None,
        tools: Vec::new(),
        max_tokens: None,
    }
}

fn budget(ms: u32) -> Budget {
    Budget { first_byte_ms: ms }
}

fn now() -> Ms {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as Ms
}

async fn ask(w: &World, b: Budget) -> (Result<ChatDone, ProviderError>, String) {
    let (tx, mut rx) = mpsc::channel(64);
    let result = w
        .router
        .hedged(&request(), b, tx, CancellationToken::new())
        .await;
    let mut text = String::new();
    while let Ok(ChatChunk::Text(t)) = rx.try_recv() {
        text.push_str(&t);
    }
    (result, text)
}

/// A loser stops on its own task; give it time to notice its token.
async fn eventually(what: impl Fn() -> bool) -> bool {
    let until = Instant::now() + GENEROUS;
    while Instant::now() < until {
        if what() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    what()
}

fn outcomes(w: &World) -> Vec<(String, String)> {
    let mut all: Vec<(String, String)> = w
        .store
        .tries_since(0)
        .unwrap()
        .into_iter()
        .map(|t| (t.model, t.outcome))
        .collect();
    all.sort();
    all
}

fn try_row(provider: &str, model: &str, outcome: &str, at: Ms, waited: i64) -> Try {
    Try {
        at,
        provider: provider.into(),
        model: model.into(),
        outcome: outcome.into(),
        status: 0,
        source: "chat".into(),
        waited_ms: Some(waited),
    }
}

fn models(w: &World) -> Vec<String> {
    w.router
        .ranked(now())
        .into_iter()
        .map(|c| c.model)
        .collect()
}

#[tokio::test]
async fn faster_of_two_wins_and_loser_is_cancelled() {
    // The slower one would answer at 800 ms in the spec; it is pushed far out so a loaded
    // machine cannot let it win, which says the same thing.
    let w = world(
        &[
            ("x", vec![("a-70b", says(NEVER.as_millis() as u64, "slow"))]),
            ("y", vec![("b-30b", says(200, "fast answer"))]),
        ],
        rows(&["x", "y"]),
        true,
    )
    .await;
    let (result, text) = ask(&w, budget(30_000)).await;
    let done = result.unwrap();
    assert_eq!(text, "fast answer");
    assert_eq!(
        (done.provider.as_str(), done.model.as_str()),
        ("y", "b-30b")
    );
    assert!(done.first_byte_ms.unwrap() >= 200);
    assert!(eventually(|| w.log.was_cancelled("a-70b")).await);
    assert!(!w.log.was_cancelled("b-30b"));
    assert_eq!(
        outcomes(&w),
        vec![
            ("a-70b".into(), "lost-race".into()),
            ("b-30b".into(), "ok".into())
        ]
    );
    // Both were sent, so both count against their provider's limits.
    assert_eq!(w.store.request_count("x", "day", now()).unwrap(), 1);
    assert_eq!(w.store.request_count("y", "day", now()).unwrap(), 1);
}

#[tokio::test]
async fn budget_starts_a_third() {
    let w = world(
        &[
            ("x", vec![("a-70b", silent())]),
            ("y", vec![("b-30b", silent())]),
            ("z", vec![("c-8b", says(0, "third"))]),
        ],
        rows(&["x", "y", "z"]),
        true,
    )
    .await;
    let began = Instant::now();
    let (result, text) = ask(&w, budget(500)).await;
    assert_eq!(result.unwrap().model, "c-8b");
    assert_eq!(text, "third");
    let third = w.log.started_at("c-8b").unwrap() - began;
    assert!(third >= Duration::from_millis(500), "started at {third:?}");
    assert!(third < GENEROUS, "started at {third:?}");
    assert_eq!(w.log.started(), vec!["a-70b", "b-30b", "c-8b"]);
    assert!(eventually(|| w.log.was_cancelled("a-70b") && w.log.was_cancelled("b-30b")).await);
}

#[tokio::test]
async fn failure_starts_the_next() {
    let w = world(
        &[
            ("x", vec![("a-70b", busy())]),
            ("y", vec![("b-30b", silent())]),
            ("z", vec![("c-8b", says(0, "next"))]),
        ],
        rows(&["x", "y", "z"]),
        true,
    )
    .await;
    let began = Instant::now();
    // A budget no test waits out: C can only have started because A failed.
    let (result, text) = ask(&w, budget(60_000)).await;
    assert_eq!(result.unwrap().model, "c-8b");
    assert_eq!(text, "next");
    assert!(began.elapsed() < GENEROUS);
    assert_eq!(
        outcomes(&w),
        vec![
            ("a-70b".into(), "busy".into()),
            ("b-30b".into(), "lost-race".into()),
            ("c-8b".into(), "ok".into())
        ]
    );
}

#[tokio::test]
async fn never_two_from_one_provider() {
    let w = world(
        &[
            ("x", vec![("a-70b", silent()), ("b-30b", silent())]),
            ("y", vec![("c-8b", says(100, "other account"))]),
        ],
        rows(&["x", "y"]),
        true,
    )
    .await;
    assert_eq!(models(&w), vec!["a-70b", "b-30b", "c-8b"]);
    let (result, _) = ask(&w, budget(60_000)).await;
    assert_eq!(result.unwrap().provider, "y");
    assert_eq!(w.log.started(), vec!["a-70b", "c-8b"]);
}

#[tokio::test]
async fn same_provider_waits_until_the_first_is_done() {
    // Only one provider: its second model starts once the first has failed, never beside it.
    let w = world(
        &[("x", vec![("a-70b", busy()), ("b-30b", says(0, "second"))])],
        rows(&["x"]),
        true,
    )
    .await;
    let (result, text) = ask(&w, budget(60_000)).await;
    assert_eq!(result.unwrap().model, "b-30b");
    assert_eq!(text, "second");
    assert_eq!(w.log.started(), vec!["a-70b", "b-30b"]);
}

#[tokio::test]
async fn recent_failure_sinks() {
    let w = world(
        &[
            ("x", vec![("a-70b", silent())]),
            ("y", vec![("b-30b", silent())]),
        ],
        rows(&["x", "y"]),
        true,
    )
    .await;
    assert_eq!(models(&w), vec!["a-70b", "b-30b"]);
    let five_minutes_ago = now() - 5 * 60 * 1000;
    w.store
        .record_try(&try_row("x", "a-70b", "unreachable", five_minutes_ago, 100))
        .unwrap();
    assert_eq!(models(&w), vec!["b-30b", "a-70b"]);
}

#[tokio::test]
async fn busy_wears_off_in_minutes() {
    let w = world(
        &[
            ("x", vec![("a-70b", silent())]),
            ("y", vec![("b-30b", silent())]),
        ],
        rows(&["x", "y"]),
        true,
    )
    .await;
    // v2 BUSY_HALF_LIFE: a 429 halves in two minutes, so 5 minutes on it carries 0.18 → 0.
    let at = now() - 5 * 60 * 1000;
    w.store
        .record_try(&try_row("x", "a-70b", "busy", at, 100))
        .unwrap();
    assert_eq!(models(&w), vec!["a-70b", "b-30b"]);
    w.store
        .record_try(&try_row("x", "a-70b", "busy", now(), 100))
        .unwrap();
    assert_eq!(models(&w), vec!["b-30b", "a-70b"]);
}

#[tokio::test]
async fn old_failure_has_worn_off() {
    let w = world(
        &[
            ("x", vec![("a-70b", silent())]),
            ("y", vec![("b-30b", silent())]),
        ],
        rows(&["x", "y"]),
        true,
    )
    .await;
    // One failure 3 hours back carries 1/8, which rounds to nothing (v2 `sunk`).
    let long_ago = now() - 3 * 60 * 60 * 1000;
    w.store
        .record_try(&try_row("x", "a-70b", "unreachable", long_ago, 100))
        .unwrap();
    assert_eq!(models(&w), vec!["a-70b", "b-30b"]);
}

#[tokio::test]
async fn fast_median_ranks_first() {
    let w = world(
        &[
            ("w", vec![("slow-120b", silent())]),
            ("x", vec![("fine-70b", silent())]),
            ("y", vec![("quick-8b", silent())]),
            ("z", vec![("new-30b", silent())]),
        ],
        rows(&["w", "x", "y", "z"]),
        true,
    )
    .await;
    let at = now() - 60_000;
    for (provider, model, waited) in [
        ("w", "slow-120b", [5_000, 6_000, 4_000]),
        ("x", "fine-70b", [1_500, 1_400, 1_600]),
        // One slow outlier does not move a median.
        ("y", "quick-8b", [300, 9_000, 250]),
    ] {
        for ms in waited {
            w.store
                .record_try(&try_row(provider, model, "ok", at, ms))
                .unwrap();
        }
    }
    // Fast by median first, untried next, slower than the chat budget (2.5 s) last.
    assert_eq!(
        models(&w),
        vec!["quick-8b", "fine-70b", "new-30b", "slow-120b"]
    );
}

#[tokio::test]
async fn exhausted_day_is_skipped() {
    let w = world(
        &[
            ("x", vec![("a-70b", says(0, "over the limit"))]),
            ("y", vec![("b-30b", says(0, "within it"))]),
        ],
        vec![row("x", Some(2)), row("y", None)],
        true,
    )
    .await;
    assert_eq!(models(&w), vec!["a-70b", "b-30b"]);
    w.store.record_request("x", now()).unwrap();
    w.store.record_request("x", now()).unwrap();
    assert_eq!(models(&w), vec!["b-30b"]);
    let (result, text) = ask(&w, budget(60_000)).await;
    assert_eq!(result.unwrap().provider, "y");
    assert_eq!(text, "within it");
    assert_eq!(w.log.started(), vec!["b-30b"]);
}

#[tokio::test]
async fn all_fail_returns_busy() {
    let w = world(
        &[
            ("x", vec![("a-70b", busy())]),
            ("y", vec![("b-30b", busy())]),
            ("z", vec![("c-8b", busy())]),
        ],
        rows(&["x", "y", "z"]),
        true,
    )
    .await;
    let (result, text) = ask(&w, budget(60_000)).await;
    assert!(
        matches!(result, Err(ProviderError::Busy { .. })),
        "{result:?}"
    );
    assert_eq!(text, "");
    assert_eq!(w.log.started(), vec!["a-70b", "b-30b", "c-8b"]);
    assert_eq!(
        outcomes(&w),
        vec![
            ("a-70b".into(), "busy".into()),
            ("b-30b".into(), "busy".into()),
            ("c-8b".into(), "busy".into())
        ]
    );
}

#[tokio::test]
async fn at_most_six_started() {
    let names = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
    let models = [
        "m-80b", "m-70b", "m-60b", "m-50b", "m-40b", "m-30b", "m-20b", "m-10b",
    ];
    let providers: Vec<(&str, Vec<(&str, Script)>)> = names
        .iter()
        .zip(models)
        .map(|(p, m)| (*p, vec![(m, busy())]))
        .collect();
    let w = world(&providers, rows(&names), true).await;
    let (result, _) = ask(&w, budget(60_000)).await;
    assert!(matches!(result, Err(ProviderError::Busy { .. })));
    assert_eq!(w.log.started(), models[..6].to_vec());
}

#[tokio::test]
async fn at_most_four_running() {
    let names = ["p1", "p2", "p3", "p4", "p5"];
    let models = ["m-50b", "m-40b", "m-30b", "m-20b", "m-10b"];
    let providers: Vec<(&str, Vec<(&str, Script)>)> = names
        .iter()
        .zip(models)
        .map(|(p, m)| (*p, vec![(m, silent())]))
        .collect();
    let w = world(&providers, rows(&names), true).await;
    let cancel = CancellationToken::new();
    let (tx, _rx) = mpsc::channel(64);
    let stop = cancel.clone();
    tokio::spawn(async move {
        // Budget 50 ms: by 1.5 s the timer has fired many times, yet only four may run.
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        stop.cancel();
    });
    let result = w.router.hedged(&request(), budget(50), tx, cancel).await;
    assert!(matches!(result, Err(ProviderError::Cancelled)));
    assert_eq!(w.log.started(), models[..4].to_vec());
}

#[tokio::test]
async fn cancel_stops_everything() {
    let w = world(
        &[
            ("x", vec![("a-70b", silent())]),
            ("y", vec![("b-30b", silent())]),
        ],
        rows(&["x", "y"]),
        true,
    )
    .await;
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        stop.cancel();
    });
    let (tx, _rx) = mpsc::channel(64);
    let began = Instant::now();
    let result = w
        .router
        .hedged(&request(), budget(60_000), tx, cancel)
        .await;
    assert!(
        matches!(result, Err(ProviderError::Cancelled)),
        "{result:?}"
    );
    assert!(began.elapsed() < GENEROUS);
    assert!(eventually(|| w.log.was_cancelled("a-70b") && w.log.was_cancelled("b-30b")).await);
}

#[tokio::test]
async fn cancel_while_writing_stops_the_winner() {
    let w = world(
        &[("x", vec![("a-70b", says(0, "one two three"))])],
        rows(&["x"]),
        true,
    )
    .await;
    // A one-slot channel nobody reads: the router is stuck forwarding when the cancel comes.
    let (tx, _rx) = mpsc::channel(1);
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        stop.cancel();
    });
    let result = w
        .router
        .hedged(&request(), budget(60_000), tx, cancel)
        .await;
    assert!(
        matches!(result, Err(ProviderError::Cancelled)),
        "{result:?}"
    );
}

#[tokio::test]
async fn winner_usage_is_recorded() {
    let w = world(&[("x", vec![("a-70b", says(0, "hi"))])], rows(&["x"]), true).await;
    let (result, _) = ask(&w, budget(60_000)).await;
    let done = result.unwrap();
    assert_eq!((done.tokens_in, done.tokens_out), (3, 2));
    let ok = w.store.tries_since(0).unwrap();
    assert_eq!(ok.len(), 1);
    assert_eq!(ok[0].outcome, "ok");
    assert_eq!(ok[0].waited_ms, done.first_byte_ms.map(i64::from));
}

#[tokio::test]
async fn no_paid_ever() {
    let w = world(
        &[
            ("x", vec![("a-70b", says(0, "costs money"))]),
            ("y", vec![("b-30b", says(0, "so does this"))]),
        ],
        rows(&["x", "y"]),
        false,
    )
    .await;
    assert!(models(&w).is_empty());
    let (result, text) = ask(&w, budget(60_000)).await;
    match result {
        Err(ProviderError::Other(said)) => assert_eq!(said, "No free model can answer right now."),
        other => panic!("{other:?}"),
    }
    assert_eq!(text, "");
    assert!(w.log.started().is_empty());
    assert!(w.store.tries_since(0).unwrap().is_empty());
}
