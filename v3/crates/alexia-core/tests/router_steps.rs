// SPDX-License-Identifier: AGPL-3.0-only
//! P2-17: Router::step, pins, the $0 cap, redaction before cloud, local only for local jobs,
//! and Catalog::news. Fake providers answer at once; nothing here waits on a clock.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use alexia_core::catalog::Catalog;
use alexia_core::free::{Auth, FreeRow};
use alexia_core::router::{Router, StepAsk};
use alexia_core::{
    Budget, ChatChunk, ChatDone, ChatRequest, Job, ModelInfo, Provider, ProviderError, RunId,
};
use alexia_store::{Content, MessageBody, Role, Store};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const BUDGET: Budget = Budget {
    first_byte_ms: 20_000,
};

/// A provider that answers at once and remembers every request it got: (model, request text).
struct Fake {
    id: String,
    models: Mutex<Vec<ModelInfo>>,
    cost: f64,
    asked: Arc<Mutex<Vec<(String, String)>>>,
}

#[async_trait::async_trait]
impl Provider for Fake {
    fn id(&self) -> &str {
        &self.id
    }
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(self.models.lock().unwrap().clone())
    }
    async fn chat(
        &self,
        req: &ChatRequest,
        model: &str,
        out: mpsc::Sender<ChatChunk>,
        _: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        let text: String = req
            .messages
            .iter()
            .filter_map(|(_, b)| match &b.content {
                Content::Text(t) => Some(t.clone()),
                _ => None,
            })
            .collect();
        self.asked.lock().unwrap().push((model.into(), text));
        let _ = out.send(ChatChunk::Text("ok".into())).await;
        Ok(ChatDone {
            model: model.into(),
            provider: self.id.clone(),
            tokens_in: 3,
            tokens_out: 2,
            cost: self.cost,
            first_byte_ms: None,
        })
    }
}

fn info(id: &str, free: bool, tools: bool) -> ModelInfo {
    ModelInfo {
        id: id.into(),
        context: 32_768,
        free,
        tools,
        vision: false,
    }
}

fn fake(
    id: &str,
    models: Vec<ModelInfo>,
    cost: f64,
    asked: &Arc<Mutex<Vec<(String, String)>>>,
) -> Arc<Fake> {
    Arc::new(Fake {
        id: id.into(),
        models: Mutex::new(models),
        cost,
        asked: asked.clone(),
    })
}

fn row(id: &str) -> FreeRow {
    FreeRow {
        id: id.into(),
        base_url: format!("http://{id}.invalid/v1"),
        models_path: Some("/models".into()),
        headers: Vec::new(),
        auth: Auth::Optional,
        all_free: true,
        rpm: None,
        rpd: None,
        router: false,
    }
}

struct World {
    router: Router,
    catalog: Arc<Catalog>,
    store: Arc<Store>,
    asked: Arc<Mutex<Vec<(String, String)>>>,
    cache: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.cache);
    }
}

impl World {
    fn asked_models(&self) -> Vec<String> {
        self.asked
            .lock()
            .unwrap()
            .iter()
            .map(|(m, _)| m.clone())
            .collect()
    }
}

/// Providers "p" (cost `cost`) listing `models`; the catalog is refreshed once.
async fn world(models: Vec<ModelInfo>, cost: f64) -> World {
    static N: AtomicU64 = AtomicU64::new(0);
    let cache = std::env::temp_dir().join(format!(
        "alexia-steps-test-{}-{}.json",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let asked = Arc::new(Mutex::new(Vec::new()));
    let p: Arc<dyn Provider> = fake("p", models, cost, &asked);
    let catalog = Arc::new(Catalog::new(vec![p.clone()], vec![row("p")], cache.clone()));
    catalog.refresh().await;
    let store = Arc::new(Store::open_in_memory().unwrap());
    World {
        router: Router::new(vec![p], catalog.clone(), store.clone()),
        catalog,
        store,
        asked,
        cache,
    }
}

fn request(text: &str) -> ChatRequest {
    let body: MessageBody =
        serde_json::from_value(serde_json::json!({ "content": Content::Text(text.into()) }))
            .unwrap();
    ChatRequest {
        messages: vec![(Role::User, body)],
        system: None,
        tools: Vec::new(),
        max_tokens: None,
    }
}

fn a_tool() -> alexia_mcp::types::Tool {
    serde_json::from_value(serde_json::json!({
        "name": "look", "inputSchema": {"type": "object"}
    }))
    .unwrap()
}

fn ask_for(job: Job) -> StepAsk {
    StepAsk {
        job,
        avoid: Vec::new(),
        plugin: None,
        run: None,
        session: None,
    }
}

async fn step(w: &World, req: &ChatRequest, ask: &StepAsk) -> Result<ChatDone, ProviderError> {
    let (tx, _rx) = mpsc::channel(64);
    w.router
        .step(req, ask, BUDGET, tx, CancellationToken::new())
        .await
}

fn in_ten_models() -> Vec<ModelInfo> {
    vec![info("big-70b", true, true), info("small-8b", true, true)]
}

#[tokio::test]
async fn step_uses_tools_capable_only() {
    let w = world(
        vec![info("plain-70b", true, false), info("handy-8b", true, true)],
        0.0,
    )
    .await;
    let mut req = request("hello");
    req.tools = vec![a_tool()];
    let done = step(&w, &req, &ask_for(Job::Step)).await.unwrap();
    assert_eq!(done.model, "handy-8b");
    assert_eq!(w.asked_models(), ["handy-8b"]);
}

#[tokio::test]
async fn pin_first() {
    let w = world(in_ten_models(), 0.0).await;
    // Plan would take the larger model; the pin says the smaller one.
    w.router
        .set_pins(Job::Plan, vec!["p/small-8b".into()])
        .unwrap();
    assert_eq!(w.router.pins()["plan"], ["p/small-8b"]);
    let done = step(&w, &request("plan it"), &ask_for(Job::Plan))
        .await
        .unwrap();
    assert_eq!(done.model, "small-8b");
    assert!(w.router.take_notes().is_empty());
}

#[tokio::test]
async fn unusable_pin_skipped_with_note() {
    let w = world(in_ten_models(), 0.0).await;
    w.router
        .set_pins(Job::Plan, vec!["p/not-listed-405b".into()])
        .unwrap();
    let done = step(&w, &request("plan it"), &ask_for(Job::Plan))
        .await
        .unwrap();
    // Replaced by the free list, never by anything else.
    assert_eq!(done.model, "big-70b");
    let notes = w.router.take_notes();
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(notes[0].contains("p/not-listed-405b"), "{notes:?}");
    assert!(
        w.router.take_notes().is_empty(),
        "notes are handed out once"
    );
}

#[tokio::test]
async fn paid_never_asked() {
    // The catalog lists a paid model and the owner pins it; a runtime provider is paid too.
    let w = world(
        vec![info("paid-405b", false, true), info("free-8b", true, true)],
        0.0,
    )
    .await;
    let pricey = fake("pricey", vec![info("gold-70b", false, true)], 1.0, &w.asked);
    w.router.set_provider(pricey, false);
    w.router
        .set_pins(
            Job::Code,
            vec!["p/paid-405b".into(), "subscription:pricey".into()],
        )
        .unwrap();
    let done = step(&w, &request("code it"), &ask_for(Job::Code))
        .await
        .unwrap();
    assert_eq!(done.model, "free-8b");
    assert_eq!(w.asked_models(), ["free-8b"]);
    assert_eq!(w.router.take_notes().len(), 2);
}

#[tokio::test]
async fn charged_sets_aside() {
    let w = world(in_ten_models(), 0.25).await;
    let first = step(&w, &request("one"), &ask_for(Job::Plan))
        .await
        .unwrap();
    assert_eq!(first.model, "big-70b");
    let tries = w.store.tries_since(0).unwrap();
    assert!(
        tries
            .iter()
            .any(|t| t.model == "big-70b" && t.outcome == "charged"),
        "{tries:?}"
    );
    assert!(!tries.iter().any(|t| t.outcome == "ok"));
    // Set aside: the next step takes the other model, the ranking leaves it out too.
    let second = step(&w, &request("two"), &ask_for(Job::Plan))
        .await
        .unwrap();
    assert_eq!(second.model, "small-8b");
    let ranked: Vec<String> = w
        .router
        .ranked(alexia_store::now_ms())
        .into_iter()
        .map(|c| c.model)
        .collect();
    assert!(!ranked.contains(&"big-70b".to_string()), "{ranked:?}");
    // And a step asked to avoid the rest has nobody left.
    let mut ask = ask_for(Job::Plan);
    ask.avoid = vec!["p\nsmall-8b".into()];
    assert!(step(&w, &request("three"), &ask).await.is_err());
    assert_eq!(w.asked_models(), ["big-70b", "small-8b"]);
}

#[tokio::test]
async fn cloud_request_redacted() {
    let w = world(in_ten_models(), 0.0).await;
    let key = format!("{}{}", "sk-or-v1-", "9f2a8c7b6d5e4f3a2b1c0d9e");
    step(
        &w,
        &request(&format!("my key is {key} ok")),
        &ask_for(Job::Step),
    )
    .await
    .unwrap();
    let seen = w.asked.lock().unwrap()[0].1.clone();
    assert!(!seen.contains(&key), "the key left the machine: {seen}");
    assert!(seen.contains("my key is"));
    let notes = w.router.take_notes();
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(notes[0].starts_with("Removed "), "{notes:?}");
    assert!(!notes[0].contains(&key));
}

#[tokio::test]
async fn step_redacts_once_and_keeps_note() {
    let w = world(in_ten_models(), 0.0).await;
    let key = format!("{}{}", "sk-or-v1-", "9f2a8c7b6d5e4f3a2b1c0d9e");
    step(&w, &request(&format!("use {key} now")), &ask_for(Job::Step))
        .await
        .unwrap();
    let seen = w.asked.lock().unwrap()[0].1.clone();
    assert_eq!(seen, "use [redacted] now");
    // The race reported what it removed, so the note names the kind once.
    assert_eq!(w.router.take_notes(), ["Removed api key before sending."]);
}

fn local_provider(w: &World, models: Vec<ModelInfo>) -> Arc<Fake> {
    let l = fake("local:gemma", models, 0.0, &w.asked);
    w.router.set_provider(l.clone(), true);
    l
}

#[tokio::test]
async fn local_never_for_plan_or_step() {
    let w = world(vec![info("cloud-8b", true, true)], 0.0).await;
    local_provider(&w, vec![info("gemma", true, true)]);
    w.router
        .set_pins(Job::Plan, vec!["local:gemma".into()])
        .unwrap();
    for job in [Job::Chat, Job::Plan, Job::Step, Job::Code] {
        let done = step(&w, &request("hi"), &ask_for(job)).await.unwrap();
        assert_eq!(done.model, "cloud-8b", "{job:?}");
    }
    assert!(!w.asked_models().contains(&"gemma".to_string()));
    // The plan pin was skipped with a note; the others had no pin to skip.
    assert_eq!(w.router.take_notes().len(), 1);
}

#[tokio::test]
async fn local_ok_for_check() {
    // No cloud model, so the only runner is the local one and the winner is certain.
    let w = world(Vec::new(), 0.0).await;
    local_provider(&w, vec![info("gemma", true, true)]);
    let secret = format!("{}{}", "sk-or-v1-", "9f2a8c7b6d5e4f3a2b1c0d9e");
    for job in [Job::Check, Job::Vision, Job::Local] {
        let done = step(&w, &request(&format!("see {secret}")), &ask_for(job))
            .await
            .unwrap();
        assert_eq!(done.model, "gemma", "{job:?}");
    }
    // Local requests go as they are: nothing left the machine, so nothing is removed.
    assert!(w
        .asked
        .lock()
        .unwrap()
        .iter()
        .all(|(_, t)| t.contains(&secret)));
    assert!(w.router.take_notes().is_empty());
    // A Local job never falls back to the cloud.
    w.router.remove_provider("local:gemma");
    assert!(step(&w, &request("x"), &ask_for(Job::Local)).await.is_err());
}

#[tokio::test]
async fn plan_prefers_larger() {
    let w = world(
        vec![
            info("a-8b", true, true),
            info("b-70b", true, true),
            info("c-32b", true, true),
        ],
        0.0,
    )
    .await;
    for job in [Job::Plan, Job::Code] {
        let done = step(&w, &request("go"), &ask_for(job)).await.unwrap();
        assert_eq!(done.model, "b-70b", "{job:?}");
    }
    // A step that has seen "a-8b" answer quickly prefers it over the untried.
    let w = world(
        vec![info("a-8b", true, true), info("b-70b", true, true)],
        0.0,
    )
    .await;
    w.store
        .record_try(&alexia_store::Try {
            at: alexia_store::now_ms(),
            provider: "p".into(),
            model: "a-8b".into(),
            outcome: "ok".into(),
            status: 0,
            source: "chat".into(),
            waited_ms: Some(50),
        })
        .unwrap();
    let done = step(&w, &request("go"), &ask_for(Job::Step)).await.unwrap();
    assert_eq!(done.model, "a-8b");
}

#[tokio::test]
async fn news_once() {
    let w = world(vec![info("old-8b", true, true)], 0.0).await;
    assert!(
        w.catalog.news().is_empty(),
        "the first list is the baseline"
    );
    // Nothing changed: nothing new.
    w.catalog.refresh().await;
    assert!(w.catalog.news().is_empty());
    // A model shows up (the provider is the fake in `world`, so rebuild it from the same cache).
    let asked = w.asked.clone();
    let p: Arc<dyn Provider> = fake(
        "p",
        vec![
            info("old-8b", true, true),
            info("new-70b", true, true),
            info("paid-9b", false, true),
        ],
        0.0,
        &asked,
    );
    let again = Catalog::new(vec![p], vec![row("p")], w.cache.clone());
    again.refresh().await;
    let news = again.news();
    assert_eq!(news.len(), 1, "{news:?}");
    assert_eq!(news[0].model, "new-70b");
    assert!(again.news().is_empty(), "reported once");
    again.refresh().await;
    assert!(again.news().is_empty(), "and not again on the next refresh");
}

#[tokio::test]
async fn usage_attributed_to_plugin() {
    let w = world(in_ten_models(), 0.0).await;
    let session = w.store.create_session(Some("t")).unwrap();
    let mut ask = ask_for(Job::Step);
    ask.plugin = Some("notes".into());
    ask.run = Some(RunId("run-7".into()));
    ask.session = Some(session);
    step(&w, &request("hi"), &ask).await.unwrap();
    let rows: Vec<(Option<String>, Option<String>, Option<i64>)> = w
        .store
        .transaction(|tx| {
            let mut st = tx.prepare("SELECT plugin, run_id, session_id FROM usage")?;
            let rows = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .unwrap();
    assert_eq!(
        rows,
        vec![(Some("notes".into()), Some("run-7".into()), Some(session.0))]
    );
}
