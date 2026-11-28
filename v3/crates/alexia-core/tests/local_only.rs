// SPDX-License-Identifier: AGPL-3.0-only
//! P4-30 (TR-10, D-P4-11): local-only mode. The router asks only providers registered as local,
//! one at a time, and says so when there is none; the rules block outward-facing tools.
//! Fake providers, no network.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::catalog::Catalog;
use alexia_core::free::{Auth, FreeRow};
use alexia_core::permissions::{
    is_local_only, local_only, proactive, rule, scope, CallAsk, LOCAL_ONLY_BLOCKED,
};
use alexia_core::router::{Router, StepAsk, NO_LOCAL_MODEL};
use alexia_core::{
    Budget, ChatChunk, ChatDone, ChatRequest, Job, ModelInfo, PermissionMode, Provider,
    ProviderError, Ruling, Scope,
};
use alexia_mcp::types::ToolAnnotations;
use alexia_store::{Content, MessageBody, Role, Store};
use serde_json::json;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Short, so a hedge would start well before the slow model answers.
const QUICK: Budget = Budget { first_byte_ms: 100 };
const SLOW: Duration = Duration::from_millis(1_500);

/// Answers after `delay` (or fails at once when `fail`), and logs every model it was asked.
struct Fake {
    id: String,
    models: Vec<ModelInfo>,
    delay: Duration,
    fail: bool,
    asked: Arc<Mutex<Vec<String>>>,
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
        self.asked.lock().unwrap().push(model.into());
        if self.fail {
            return Err(ProviderError::Busy {
                retry_after_ms: None,
            });
        }
        tokio::select! {
            _ = cancel.cancelled() => return Err(ProviderError::Cancelled),
            _ = tokio::time::sleep(self.delay) => {}
        }
        let _ = out.send(ChatChunk::Text("ok".into())).await;
        Ok(ChatDone {
            model: model.into(),
            provider: self.id.clone(),
            tokens_in: 1,
            tokens_out: 1,
            cost: 0.0,
            first_byte_ms: None,
        })
    }
}

fn info(id: &str) -> ModelInfo {
    ModelInfo {
        id: id.into(),
        context: 32_768,
        free: true,
        tools: true,
        vision: true,
    }
}

struct World {
    router: Router,
    store: Arc<Store>,
    asked: Arc<Mutex<Vec<String>>>,
    cache: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.cache);
    }
}

impl World {
    fn fake(&self, id: &str, model: &str, delay: Duration, fail: bool) -> Arc<Fake> {
        Arc::new(Fake {
            id: id.into(),
            models: vec![info(model)],
            delay,
            fail,
            asked: self.asked.clone(),
        })
    }
    fn add_local(&self, id: &str, model: &str, delay: Duration, fail: bool) {
        self.router
            .set_provider(self.fake(id, model, delay, fail), true);
    }
    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }
    fn local_only(&self, on: bool) {
        self.store
            .kv_set("_core", "local_only", &json!(on))
            .unwrap();
    }
    async fn hedged(&self, budget: Budget) -> Result<ChatDone, ProviderError> {
        let (tx, _rx) = mpsc::channel(64);
        self.router
            .hedged(&request(), budget, tx, CancellationToken::new())
            .await
    }
    async fn step(&self, job: Job, budget: Budget) -> Result<ChatDone, ProviderError> {
        let (tx, _rx) = mpsc::channel(64);
        let ask = StepAsk {
            job,
            avoid: Vec::new(),
            plugin: None,
            run: None,
            session: None,
        };
        self.router
            .step(&request(), &ask, budget, tx, CancellationToken::new())
            .await
    }
}

/// A free cloud provider "cloud" listing "cloud-70b", and a subscription CLI (cloud too).
async fn world() -> World {
    static N: AtomicU64 = AtomicU64::new(0);
    let cache = std::env::temp_dir().join(format!(
        "alexia-local-only-test-{}-{}.json",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let asked = Arc::new(Mutex::new(Vec::new()));
    let cloud: Arc<dyn Provider> = Arc::new(Fake {
        id: "cloud".into(),
        models: vec![info("cloud-70b")],
        delay: Duration::ZERO,
        fail: false,
        asked: asked.clone(),
    });
    let row = FreeRow {
        id: "cloud".into(),
        base_url: "http://cloud.invalid/v1".into(),
        models_path: Some("/models".into()),
        headers: Vec::new(),
        auth: Auth::Optional,
        all_free: true,
        rpm: None,
        rpd: None,
        router: false,
    };
    let catalog = Arc::new(Catalog::new(vec![cloud.clone()], vec![row], cache.clone()));
    catalog.refresh().await;
    let store = Arc::new(Store::open_in_memory().unwrap());
    let w = World {
        router: Router::new(vec![cloud], catalog, store.clone()),
        store,
        asked,
        cache,
    };
    let claude = w.fake("subscription:claude", "claude-cli", Duration::ZERO, false);
    w.router.set_provider(claude, false);
    w
}

fn request() -> ChatRequest {
    let body: MessageBody =
        serde_json::from_value(json!({ "content": Content::Text("hello".into()) })).unwrap();
    ChatRequest {
        messages: vec![(Role::User, body)],
        system: None,
        tools: Vec::new(),
        max_tokens: None,
    }
}

fn err_text(r: Result<ChatDone, ProviderError>) -> String {
    match r {
        Err(ProviderError::Other(text)) => text,
        other => panic!("expected an error sentence, got {other:?}"),
    }
}

#[tokio::test]
async fn cloud_providers_skipped() {
    let w = world().await;
    w.add_local("ollama", "llama-8b", Duration::ZERO, false);
    w.local_only(true);
    // The owner pinned the subscription CLI and the cloud model for steps: both skipped.
    w.router
        .set_pins(
            Job::Step,
            vec!["subscription:claude".into(), "cloud/cloud-70b".into()],
        )
        .unwrap();

    let done = w.hedged(Budget::CHAT).await.unwrap();
    assert_eq!(
        (done.provider.as_str(), done.model.as_str()),
        ("ollama", "llama-8b")
    );
    for job in [
        Job::Chat,
        Job::Step,
        Job::Plan,
        Job::Code,
        Job::Vision,
        Job::Check,
    ] {
        let done = w.step(job, Budget::CHAT).await.unwrap();
        assert_eq!(done.provider, "ollama", "{job:?}");
    }
    assert!(
        w.asked().iter().all(|m| m == "llama-8b"),
        "a cloud model was asked: {:?}",
        w.asked()
    );
    let notes = w.router.take_notes(None);
    assert_eq!(notes.len(), 2, "{notes:?}");
    assert!(notes.iter().all(|n| n.contains("local-only")), "{notes:?}");
    assert!(w.router.ranked(alexia_store::now_ms()).is_empty());
}

#[tokio::test]
async fn no_local_model_sentence() {
    let w = world().await;
    w.local_only(true);
    assert_eq!(err_text(w.hedged(Budget::CHAT).await), NO_LOCAL_MODEL);
    for job in [Job::Chat, Job::Step, Job::Vision, Job::Check, Job::Local] {
        assert_eq!(
            err_text(w.step(job, Budget::CHAT).await),
            NO_LOCAL_MODEL,
            "{job:?}"
        );
    }
    assert!(w.asked().is_empty(), "{:?}", w.asked());
    // The wording never promises that nothing at all leaves the computer.
    assert!(!NO_LOCAL_MODEL.contains("nothing leaves"));
}

#[tokio::test]
async fn hedging_off() {
    let w = world().await;
    // "local-a" ranks first and is slow; with hedging, "local-b" would start after 100 ms
    // and win. Local-only waits for the first one instead.
    w.add_local("local-a", "slow-70b", SLOW, false);
    w.add_local("local-b", "fast-8b", Duration::ZERO, false);
    w.local_only(true);
    let done = w.hedged(QUICK).await.unwrap();
    assert_eq!(done.model, "slow-70b");
    let done = w.step(Job::Step, QUICK).await.unwrap();
    assert_eq!(done.model, "slow-70b");
    assert_eq!(w.asked(), ["slow-70b", "slow-70b"]);

    // A local model that fails still hands over to the next one.
    w.add_local("local-a", "broken-70b", Duration::ZERO, true);
    let done = w.hedged(QUICK).await.unwrap();
    assert_eq!(done.model, "fast-8b");
}

#[tokio::test]
async fn flag_off_unchanged() {
    let w = world().await;
    w.add_local("ollama", "llama-8b", Duration::ZERO, false);
    assert!(!is_local_only(&w.store));
    let done = w.hedged(Budget::CHAT).await.unwrap();
    assert_eq!(done.provider, "cloud");
    w.local_only(false);
    let done = w.step(Job::Step, Budget::CHAT).await.unwrap();
    assert_eq!(done.provider, "cloud");
    assert_eq!(w.asked(), ["cloud-70b", "cloud-70b"]);
    assert_eq!(w.router.ranked(alexia_store::now_ms()).len(), 1);
}

// ---- the permission rule ----

fn ann(v: serde_json::Value) -> ToolAnnotations {
    serde_json::from_value(v).unwrap()
}

fn scope_of(local_only: bool) -> Scope {
    Scope {
        mode: PermissionMode::FullTrust,
        roots: Vec::new(),
        everywhere: true,
        boundaries: Vec::new(),
        data_dir: PathBuf::from("/data"),
        silent: Vec::new(),
        local_only,
        guest_tools: Vec::new(),
    }
}

fn asking<'a>(tool: &'a str, words: &'a str, a: &'a ToolAnnotations) -> CallAsk<'a> {
    CallAsk {
        tool,
        words,
        annotations: Some(a),
        paths: Vec::new(),
        reviewed: true,
    }
}

#[test]
fn open_world_tool_blocked() {
    let open = ann(json!({"readOnlyHint": false, "destructiveHint": false, "openWorldHint": true}));
    let ask = asking("mail__send", "sends an email", &open);
    let on = scope_of(true);
    let want = Ruling::Blocked(LOCAL_ONLY_BLOCKED.replace("{doing}", "send an email"));
    let ruled = rule(&ask, &on);
    assert_eq!(ruled, Ruling::Run, "full trust runs it before local-only");
    assert_eq!(local_only(&ask, &on, ruled), want);
    // After `proactive` too, and an Ask becomes a block.
    let asked = proactive(&ask, &on, Ruling::Run);
    assert!(matches!(asked, Ruling::Ask(_)));
    assert_eq!(local_only(&ask, &on, asked), want);
    assert_eq!(
        want,
        Ruling::Blocked(
            "Local-only mode is on, so Alexia won't send an email: it would reach outside your computers."
                .into()
        )
    );
    // Even a read-only lookup on the internet reaches out.
    let fetch = ann(json!({"readOnlyHint": true, "openWorldHint": true}));
    let ask = asking("web__fetch", "", &fetch);
    assert!(matches!(
        local_only(&ask, &on, Ruling::Run),
        Ruling::Blocked(_)
    ));
}

#[test]
fn read_only_tool_runs() {
    let on = scope_of(true);
    let read = ann(json!({"readOnlyHint": true, "openWorldHint": false}));
    let ask = asking("notes__list", "", &read);
    assert_eq!(local_only(&ask, &on, Ruling::Run), Ruling::Run);
    let quiet = ann(json!({"readOnlyHint": true}));
    let ask = asking("notes__list", "", &quiet);
    let q = Ruling::Ask("outside".into());
    // P3-42: no `openWorldHint` means true (MCP's default), so it reaches outside.
    assert!(matches!(local_only(&ask, &on, q), Ruling::Blocked(_)));
    // Flag off: an outward-facing tool is untouched.
    let open = ann(json!({"openWorldHint": true}));
    let ask = asking("mail__send", "", &open);
    assert_eq!(local_only(&ask, &scope_of(false), Ruling::Run), Ruling::Run);
}

#[test]
fn blocked_stays_blocked() {
    let open = ann(json!({"openWorldHint": true}));
    let ask = asking("mail__send", "", &open);
    let blocked = Ruling::Blocked("You said “don't do anything”.".into());
    assert_eq!(local_only(&ask, &scope_of(true), blocked.clone()), blocked);
}

#[test]
fn scope_reads_flag() {
    let store = Store::open_in_memory().unwrap();
    let dir = PathBuf::from("/data");
    assert!(!scope(&store, &dir).local_only, "absent is off");
    assert!(!is_local_only(&store));
    store.kv_set("_core", "local_only", &json!(true)).unwrap();
    assert!(scope(&store, &dir).local_only);
    assert!(is_local_only(&store));
    store.kv_set("_core", "local_only", &json!("yes")).unwrap();
    assert!(!scope(&store, &dir).local_only, "only a real true counts");
    store.kv_set("_core", "local_only", &json!(false)).unwrap();
    assert!(!scope(&store, &dir).local_only);
    assert!(!is_local_only(&store));
}
