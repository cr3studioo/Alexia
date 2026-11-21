// SPDX-License-Identifier: AGPL-3.0-only
//! P2-36: /compare against fake providers. No network.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use alexia_core::catalog::Catalog;
use alexia_core::compare::{compare, present, Compared};
use alexia_core::free::{Auth, FreeRow};
use alexia_core::router::Router;
use alexia_core::{ChatChunk, ChatDone, ChatRequest, ModelInfo, Provider, ProviderError};
use alexia_store::{Content, Role, Store};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

type Seen = Arc<Mutex<Vec<(String, String)>>>;

/// model -> Some(answer), or None for a failure.
struct Fake {
    id: String,
    answers: HashMap<String, Option<&'static str>>,
    seen: Seen,
}

#[async_trait::async_trait]
impl Provider for Fake {
    fn id(&self) -> &str {
        &self.id
    }
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(self
            .answers
            .keys()
            .map(|m| ModelInfo {
                id: m.clone(),
                context: 32_768,
                free: true,
                tools: false,
                vision: false,
            })
            .collect())
    }
    async fn chat(
        &self,
        req: &ChatRequest,
        model: &str,
        out: mpsc::Sender<ChatChunk>,
        _cancel: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        let text: Vec<String> = req
            .messages
            .iter()
            .filter_map(|(_, b)| match &b.content {
                Content::Text(t) => Some(t.clone()),
                _ => None,
            })
            .collect();
        self.seen
            .lock()
            .unwrap()
            .push((model.into(), text.join("\n")));
        match self.answers[model] {
            Some(a) => {
                for word in a.split_inclusive(' ') {
                    let _ = out.send(ChatChunk::Text(word.into())).await;
                }
                // A "slow" model keeps writing after its first chunk.
                if model.contains("slow") {
                    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                }
                Ok(ChatDone {
                    model: model.into(),
                    provider: self.id.clone(),
                    tokens_in: 3,
                    tokens_out: 5,
                    // A "paid" model charges.
                    cost: if model.contains("paid") { 0.01 } else { 0.0 },
                    first_byte_ms: None,
                })
            }
            None => Err(ProviderError::Unreachable),
        }
    }
}

struct World {
    router: Router,
    store: Arc<Store>,
    seen: Seen,
    cache: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.cache);
    }
}

type Models = Vec<(&'static str, Option<&'static str>)>;

/// `providers`: (id, [(model, answer)]). Model ids carry a size so larger ranks first.
async fn world(providers: Vec<(&'static str, Models)>) -> World {
    static N: AtomicU64 = AtomicU64::new(0);
    let cache = std::env::temp_dir().join(format!(
        "alexia-compare-test-{}-{}.json",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let seen: Seen = Arc::default();
    let fakes: Vec<Arc<dyn Provider>> = providers
        .iter()
        .map(|(id, ms)| {
            Arc::new(Fake {
                id: (*id).into(),
                answers: ms.iter().map(|(m, a)| ((*m).to_owned(), *a)).collect(),
                seen: seen.clone(),
            }) as Arc<dyn Provider>
        })
        .collect();
    let rows = providers
        .iter()
        .map(|(id, _)| FreeRow {
            id: (*id).into(),
            base_url: format!("http://{id}.invalid/v1"),
            models_path: Some("/models".into()),
            headers: Vec::new(),
            auth: Auth::Optional,
            all_free: true,
            rpm: None,
            rpd: None,
            router: false,
        })
        .collect();
    let catalog = Arc::new(Catalog::new(fakes.clone(), rows, cache.clone()));
    catalog.refresh().await;
    let store = Arc::new(Store::open_in_memory().unwrap());
    World {
        router: Router::new(fakes, catalog, store.clone()),
        store,
        seen,
        cache,
    }
}

fn request(text: &str) -> ChatRequest {
    ChatRequest {
        messages: vec![(
            Role::User,
            serde_json::from_value(serde_json::json!({ "content": Content::Text(text.into()) }))
                .unwrap(),
        )],
        system: None,
        tools: Vec::new(),
        max_tokens: None,
    }
}

async fn two() -> World {
    world(vec![
        (
            "p1",
            vec![("big-70b", Some("answer one")), ("tiny-1b", Some("unused"))],
        ),
        ("p2", vec![("mid-30b", Some("answer two"))]),
    ])
    .await
}

#[tokio::test]
async fn both_answers_returned() {
    let w = two().await;
    let c = compare(&w.router, &request("why?"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(c.a, ("big-70b".to_string(), "answer one".to_string()));
    assert_eq!(c.b, ("mid-30b".to_string(), "answer two".to_string()));
    let mut tries: Vec<_> = w
        .store
        .tries_since(0)
        .unwrap()
        .into_iter()
        .map(|t| (t.model, t.outcome))
        .collect();
    tries.sort();
    assert_eq!(
        tries,
        vec![
            ("big-70b".into(), "ok".into()),
            ("mid-30b".into(), "ok".into())
        ]
    );
}

#[tokio::test]
async fn different_providers() {
    // p1's second model ranks above p2's only model, but shares the first's provider.
    let w = world(vec![
        ("p1", vec![("big-70b", Some("a")), ("large-60b", Some("x"))]),
        ("p2", vec![("small-8b", Some("b"))]),
    ])
    .await;
    let c = compare(&w.router, &request("q"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(c.a.0, "big-70b");
    assert_eq!(c.b.0, "small-8b");
    assert!(!w.seen.lock().unwrap().iter().any(|(m, _)| m == "large-60b"));

    // One provider alone cannot be compared.
    let one = world(vec![(
        "p1",
        vec![("big-70b", Some("a")), ("large-60b", Some("x"))],
    )])
    .await;
    assert!(
        compare(&one.router, &request("q"), CancellationToken::new())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn one_fails_other_shown() {
    let w = world(vec![
        ("p1", vec![("big-70b", None)]),
        ("p2", vec![("mid-30b", Some("still here"))]),
    ])
    .await;
    let c = compare(&w.router, &request("q"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(c.a.0, "big-70b");
    assert!(c.a.1.contains("no answer"));
    assert!(c.a_failed && !c.b_failed);
    assert!(present(&c).contains("(no answer:"));
    assert_eq!(c.b, ("mid-30b".to_string(), "still here".to_string()));
    assert!(w
        .store
        .tries_since(0)
        .unwrap()
        .iter()
        .any(|t| t.model == "big-70b" && t.outcome == "unreachable"));

    // Both failing is an error.
    let both = world(vec![
        ("p1", vec![("big-70b", None)]),
        ("p2", vec![("mid-30b", None)]),
    ])
    .await;
    assert!(
        compare(&both.router, &request("q"), CancellationToken::new())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn requests_counted() {
    let w = two().await;
    compare(&w.router, &request("q"), CancellationToken::new())
        .await
        .unwrap();
    let now = alexia_store::now_ms();
    for p in ["p1", "p2"] {
        assert_eq!(w.store.request_count(p, "day", now).unwrap(), 1, "{p}");
    }
}

#[tokio::test]
async fn request_redacted() {
    let w = two().await;
    let key = format!("{}{}", "AKIA", "IOSFODNN7EXAMPLE");
    compare(
        &w.router,
        &request(&format!("my key is {key}")),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let seen = w.seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert!(seen
        .iter()
        .all(|(_, t)| !t.contains(&key) && t.contains("my key is")));
}

#[test]
fn present_labels_models() {
    let c = Compared {
        a: ("big-70b".into(), "first".into()),
        b: ("mid-30b".into(), "second".into()),
        a_failed: false,
        b_failed: false,
    };
    let s = present(&c);
    let a = s.find("**A** (big-70b)").unwrap();
    let b = s.find("**B** (mid-30b)").unwrap();
    let (first, second) = (s.find("first").unwrap(), s.find("second").unwrap());
    assert!(a < first && first < b && b < second);
    assert!(s.ends_with("Keep A or B?"));
}

#[tokio::test]
async fn charged_side_set_aside() {
    let w = world(vec![
        ("p1", vec![("paid-70b", Some("costly"))]),
        ("p2", vec![("mid-30b", Some("free"))]),
    ])
    .await;
    let c = compare(&w.router, &request("q"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(c.a.1, "costly");
    let tries = w.store.tries_since(0).unwrap();
    let of = |m: &str| tries.iter().find(|t| t.model == m).unwrap().outcome.clone();
    assert_eq!(of("paid-70b"), "charged");
    assert_eq!(of("mid-30b"), "ok");
    let aside = w.store.kv_get("_core", "aside").unwrap().unwrap();
    assert!(
        aside
            .get(
                "p1
paid-70b"
            )
            .is_some(),
        "{aside}"
    );
    assert!(
        aside
            .get(
                "p2
mid-30b"
            )
            .is_none(),
        "{aside}"
    );
}

#[tokio::test]
async fn waited_is_first_chunk() {
    let w = world(vec![
        ("p1", vec![("slow-70b", Some("takes a while"))]),
        ("p2", vec![("mid-30b", Some("quick"))]),
    ])
    .await;
    compare(&w.router, &request("q"), CancellationToken::new())
        .await
        .unwrap();
    let tries = w.store.tries_since(0).unwrap();
    let slow = tries.iter().find(|t| t.model == "slow-70b").unwrap();
    assert!(slow.waited_ms.unwrap() < 300, "{:?}", slow.waited_ms);
    let writing: i64 = w
        .store
        .transaction(|tx| {
            Ok(tx.query_row(
                "SELECT writing FROM usage WHERE model = 'slow-70b'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert!(writing >= 300, "{writing}");
}

#[tokio::test]
async fn usage_recorded_for_both() {
    let w = two().await;
    compare(&w.router, &request("q"), CancellationToken::new())
        .await
        .unwrap();
    let mut rows: Vec<(String, String, i64, i64)> = w
        .store
        .transaction(|tx| {
            let mut st = tx.prepare("SELECT provider, model, tokens_in, tokens_out FROM usage")?;
            let rows = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .unwrap();
    rows.sort();
    assert_eq!(
        rows,
        vec![
            ("p1".into(), "big-70b".into(), 3, 5),
            ("p2".into(), "mid-30b".into(), 3, 5)
        ]
    );
}
