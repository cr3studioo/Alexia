// SPDX-License-Identifier: AGPL-3.0-only
//! P1-05: the free chat catalog, against fake providers and a temp dir. No network.

use std::path::PathBuf;
use std::sync::Arc;

use alexia_core::catalog::{chats, routes, same, size_of, Candidate, Catalog};
use alexia_core::free::{Auth, FreeRow};
use alexia_core::openai::OpenAiCompat;
use alexia_core::{ChatChunk, ChatDone, ChatRequest, ModelInfo, Provider, ProviderError};
use tokio_util::sync::CancellationToken;

enum Says {
    List(Vec<ModelInfo>),
    Down,
    NeedsKey,
    Refused,
}

struct Fake {
    id: String,
    says: Says,
}

#[async_trait::async_trait]
impl Provider for Fake {
    fn id(&self) -> &str {
        &self.id
    }
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        match &self.says {
            Says::List(list) => Ok(list.clone()),
            Says::Down => Err(ProviderError::Unreachable),
            Says::NeedsKey => Err(ProviderError::NeedsKey),
            Says::Refused => Err(ProviderError::Refused("the key was refused".into())),
        }
    }
    async fn chat(
        &self,
        _: &ChatRequest,
        _: &str,
        _: tokio::sync::mpsc::Sender<ChatChunk>,
        _: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        Err(ProviderError::Other("not in these tests".into()))
    }
}

fn fake(id: &str, says: Says) -> Arc<dyn Provider> {
    Arc::new(Fake {
        id: id.into(),
        says,
    })
}

fn model(id: &str, free: bool) -> ModelInfo {
    ModelInfo {
        id: id.into(),
        context: 32_768,
        free,
        tools: false,
        vision: false,
    }
}

fn row(id: &str, auth: Auth) -> FreeRow {
    FreeRow {
        id: id.into(),
        base_url: "http://127.0.0.1:1/v1".into(),
        models_path: Some("/models".into()),
        headers: Vec::new(),
        auth,
        all_free: true,
        rpm: Some(30),
        rpd: None,
        router: false,
    }
}

/// A fresh, empty directory per test; the cache file inside it does not exist yet.
fn cache(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "alexia-catalog-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir.join("cache").join("v3-free-models.json")
}

fn no_temp_left(cache: &std::path::Path) -> bool {
    std::fs::read_dir(cache.parent().unwrap())
        .unwrap()
        .all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp"))
}

fn ids(candidates: &[Candidate]) -> Vec<(&str, &str)> {
    candidates
        .iter()
        .map(|c| (c.provider.as_str(), c.model.as_str()))
        .collect()
}

#[test]
fn chats_keeps_text_drops_others() {
    // Ids from v2's `catalog.test.ts` (all chat models there, routers included) and
    // `ollama.test.ts` (`bge-m3:latest`, the embedding model v2 refuses to route to).
    let kept = [
        "qwen/qwen3-8b:free",
        "anthropic/claude-opus-5",
        "meta/llama-3-8b",
        "llama-3.3-70b",
        "sail/gpt-oss-120b",
        "nvidia/nemotron-3-super-120b-a12b:free",
        "GLM-4.7-Flash",
        "kilo-auto/free",
        "openrouter/free",
        "Lorbus/Qwen3.6-27B-int4-AutoRound",
        "morph/morph-v3-fast",
        "~anthropic/claude-sonnet-latest",
        "koboldcpp/Gemma-4-E4B-it-Ultra-Uncensored-Heretic",
        "Qwen2.5-VL-72B-Instruct",
        "mistralai/mixtral-8x22b-v0.1",
    ];
    for id in kept {
        assert!(chats(id), "{id} is a chat model");
    }
    // v2 drops these through `max_completion_tokens: 0` or a missing `completion` capability;
    // the ids are the shapes the free providers list them under.
    let dropped = [
        "bge-m3:latest",
        "BAAI/bge-m3",
        "mistral-embed",
        "text-embedding-004",
        "nvidia/nv-embedqa-e5-v5",
        "rerank-v3.5",
        "whisper-large-v3",
        "distil-whisper-large-v3-en",
        "playai-tts",
        "gpt-image-1",
        "imagen-3.0-generate-002",
        "black-forest-labs/flux.1-schnell",
        "stabilityai/stable-diffusion-xl-base-1.0",
        "meta-llama/llama-guard-4-12b",
        "nvidia/llama-3.1-nemoguard-8b-content-safety",
        "mistral-moderation-latest",
        "mistral-ocr-latest",
        "ocr/some-reader",
        // Groq's text-to-speech voices.
        "canopylabs/orpheus-v1-english",
        "canopylabs/orpheus-arabic-saudi",
        // Google's video generators.
        "veo-2.0-generate-001",
        "veo-3.0-generate-preview",
        // Guard classifiers named guardian.
        "ibm/granite-guardian-3.2-5b",
        "granite-guardian-3.0-8b",
        "vendor/someguardian-small",
    ];
    for id in dropped {
        assert!(!chats(id), "{id} is not a chat model");
    }
}

#[test]
fn size_of_matches_v2() {
    // v2 `catalog.test.ts`, "a size is read from the id where the runner reports none".
    let sizes: [(&str, Option<f32>); 13] = [
        ("liquid/lfm-2.5-2.6b:free", Some(2.6)),
        ("nvidia/nemotron-3-super-120b-a12b:free", Some(120.0)),
        ("ibm/granite-3.0-3b-a800m-instruct", Some(3.0)),
        ("qwen3.5:397b", Some(397.0)),
        ("mistralai/mixtral-8x22b-v0.1", Some(176.0)),
        (
            "koboldcpp/Gemma-4-E4B-it-Ultra-Uncensored-Heretic",
            Some(4.0),
        ),
        ("koboldcpp/MN-Violet-Lotus-12B.Q8_0", Some(12.0)),
        ("nvidia/llama3-chatqa-1.5-70b", Some(70.0)),
        ("writer/palmyra-fin-70b-32k", Some(70.0)),
        ("poolside/laguna-s-2.1:free", None),
        ("gpt-5.5", None),
        // The spec's own examples.
        ("llama-3.3-70b", Some(70.0)),
        ("8x7b", Some(56.0)),
    ];
    for (id, billions) in sizes {
        assert_eq!(size_of(id), billions, "{id}");
    }
    // Rejected by v2's anchors: no separator before, a letter after, a bare `x`.
    for id in ["llama70b", "model-70bx", "model-x7b", "model-70", "a-.5b"] {
        assert_eq!(size_of(id), None, "{id}");
    }
}

#[test]
fn routes_and_same_match_v2() {
    // v2 `catalog.test.ts`, "a router is known by an auto or router in its id or its name".
    for id in [
        "kilo-auto/free",
        "kilo-auto/small",
        "kilo-auto/balanced",
        "openrouter/free",
        "openrouter/auto",
        "openrouter/pareto-code",
        "some/Router",
    ] {
        assert!(routes(id), "{id} is a router");
    }
    for id in [
        "nvidia/nemotron-3-super-120b-a12b:free",
        "Lorbus/Qwen3.6-27B-int4-AutoRound",
        "morph/morph-v3-fast",
        "~anthropic/claude-sonnet-latest",
        "openrouter/some-model",
        "vendor/auto.v2",
    ] {
        assert!(!routes(id), "{id} is one model");
    }
    // v2 `borrow`'s examples: one model's name across providers.
    for id in [
        "nvidia/nemotron-3-super-120b-a12b:free",
        "nvidia/nemotron-3-super-120b-a12b",
        "NVIDIA/Nemotron-3-Super-120B-A12B",
    ] {
        assert_eq!(same(id), "nemotron-3-super-120b-a12b", "{id}");
    }
    assert_eq!(same("vendor/shared:free"), same("other-prefix/shared"));
    assert_eq!(same("a/b/c:free:free"), "c:free");
}

#[tokio::test]
async fn refresh_writes_and_new_reads_cache() {
    let path = cache("roundtrip");
    let rows = vec![
        row("groq", Auth::Required),
        row("openrouter", Auth::Required),
    ];
    let catalog = Catalog::new(
        vec![
            fake(
                "groq",
                Says::List(vec![
                    model("llama-3.3-70b", true),
                    model("whisper-large-v3", true),
                ]),
            ),
            fake(
                "openrouter",
                Says::List(vec![model("openrouter/free", true)]),
            ),
        ],
        rows.clone(),
        path.clone(),
    );
    assert!(catalog.candidates().is_empty());
    catalog.refresh().await;
    let first = catalog.candidates();
    assert_eq!(
        ids(&first),
        vec![("groq", "llama-3.3-70b"), ("openrouter", "openrouter/free")]
    );
    assert_eq!(first[0].size_b, Some(70.0));
    assert!(!first[0].router);
    assert!(first[1].router);
    assert_eq!(catalog.row("groq").and_then(|r| r.rpm), Some(30));
    drop(catalog);

    let text = std::fs::read_to_string(&path).unwrap();
    let file: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert!(file["fetched_at"].as_i64().unwrap() > 0);
    assert_eq!(file["candidates"].as_array().unwrap().len(), 2);
    assert!(no_temp_left(&path));

    let restarted = Catalog::new(
        vec![fake("groq", Says::Down), fake("openrouter", Says::Down)],
        rows,
        path,
    );
    assert_eq!(restarted.candidates(), first);
    restarted.refresh().await;
    assert_eq!(restarted.candidates(), first);
}

#[tokio::test]
async fn failing_provider_keeps_its_entries() {
    let path = cache("failing");
    let rows = vec![row("groq", Auth::Required), row("cerebras", Auth::Required)];
    Catalog::new(
        vec![
            fake("groq", Says::List(vec![model("llama-3.3-70b", true)])),
            fake("cerebras", Says::List(vec![model("qwen-3-32b", true)])),
        ],
        rows.clone(),
        path.clone(),
    )
    .refresh()
    .await;

    // Groq is down and Cerebras answers with a new list: Groq keeps its row, Cerebras's is replaced.
    let catalog = Catalog::new(
        vec![
            fake("groq", Says::Down),
            fake("cerebras", Says::List(vec![model("gpt-oss-120b", true)])),
        ],
        rows.clone(),
        path.clone(),
    );
    catalog.refresh().await;
    assert_eq!(
        ids(&catalog.candidates()),
        vec![("groq", "llama-3.3-70b"), ("cerebras", "gpt-oss-120b")]
    );

    // An empty list is a shape change, not "no models": it keeps the cache too.
    let catalog = Catalog::new(
        vec![
            fake("groq", Says::List(Vec::new())),
            fake("cerebras", Says::Down),
        ],
        rows,
        path,
    );
    catalog.refresh().await;
    assert_eq!(
        ids(&catalog.candidates()),
        vec![("groq", "llama-3.3-70b"), ("cerebras", "gpt-oss-120b")]
    );
}

#[tokio::test]
async fn only_free_and_usable() {
    let path = cache("usable");
    let mut openrouter = row("openrouter", Auth::Required);
    openrouter.all_free = false;
    // A real provider with no key: `models` says NeedsKey without touching the network.
    let keyless = Arc::new(OpenAiCompat::new(
        row("mistral", Auth::Required),
        None,
        reqwest::Client::new(),
    ));
    assert!(!keyless.usable());
    let catalog = Catalog::new(
        vec![
            fake(
                "openrouter",
                Says::List(vec![
                    model("qwen/qwen3-8b:free", true),
                    model("anthropic/claude-opus-5", false),
                ]),
            ),
            keyless,
            // A provider with no ladder row is not a candidate either.
            fake("stranger", Says::List(vec![model("free-model", true)])),
        ],
        vec![openrouter, row("mistral", Auth::Required)],
        path.clone(),
    );
    catalog.refresh().await;
    assert_eq!(
        ids(&catalog.candidates()),
        vec![("openrouter", "qwen/qwen3-8b:free")]
    );

    // A key taken away drops a provider's cached entries, rather than keeping them.
    let rows = vec![row("groq", Auth::Required)];
    let path = cache("usable-revoked");
    Catalog::new(
        vec![fake("groq", Says::List(vec![model("llama-3.3-70b", true)]))],
        rows.clone(),
        path.clone(),
    )
    .refresh()
    .await;
    let catalog = Catalog::new(
        vec![fake("groq", Says::NeedsKey)],
        rows.clone(),
        path.clone(),
    );
    assert_eq!(catalog.candidates().len(), 1);
    catalog.refresh().await;
    assert!(catalog.candidates().is_empty());
}

#[tokio::test]
async fn failed_rename_leaves_no_temp_file() {
    let path = cache("rename");
    // A directory where the cache file belongs: the rename onto it fails everywhere.
    std::fs::create_dir_all(&path).unwrap();
    let catalog = Catalog::new(
        vec![fake("groq", Says::List(vec![model("llama-3.3-70b", true)]))],
        vec![row("groq", Auth::Required)],
        path.clone(),
    );
    catalog.refresh().await;
    assert_eq!(ids(&catalog.candidates()), vec![("groq", "llama-3.3-70b")]);
    assert!(no_temp_left(&path));
}

#[tokio::test]
async fn refused_key_drops_cached_entries() {
    // A 401/403 with a stored key (Refused) drops the cache the same way NeedsKey does.
    let rows = vec![row("groq", Auth::Required)];
    let path = cache("refused");
    Catalog::new(
        vec![fake("groq", Says::List(vec![model("llama-3.3-70b", true)]))],
        rows.clone(),
        path.clone(),
    )
    .refresh()
    .await;
    let catalog = Catalog::new(
        vec![fake("groq", Says::Refused)],
        rows.clone(),
        path.clone(),
    );
    assert_eq!(catalog.candidates().len(), 1);
    catalog.refresh().await;
    assert!(catalog.candidates().is_empty());
    // And the cache says so: a restart does not bring them back.
    let restarted = Catalog::new(vec![fake("groq", Says::Down)], rows, path);
    assert!(restarted.candidates().is_empty());
}

#[tokio::test]
async fn concurrent_refreshes_do_not_collide() {
    let path = cache("concurrent");
    let catalog = Catalog::new(
        vec![fake("groq", Says::List(vec![model("llama-3.3-70b", true)]))],
        vec![row("groq", Auth::Required)],
        path.clone(),
    );
    for _ in 0..10 {
        tokio::join!(catalog.refresh(), catalog.refresh(), catalog.refresh());
    }
    assert_eq!(ids(&catalog.candidates()), vec![("groq", "llama-3.3-70b")]);
    assert!(no_temp_left(&path));
}

#[tokio::test]
async fn seed_when_nothing_answers() {
    let path = cache("seed");
    let catalog = Catalog::new(
        vec![
            fake("groq", Says::Down),
            fake("ovhcloud", Says::Down),
            fake("aihorde", Says::Down),
        ],
        vec![
            row("groq", Auth::Required),
            row("ovhcloud", Auth::Optional),
            row("aihorde", Auth::Optional),
        ],
        path,
    );
    catalog.refresh().await;
    let seeded = catalog.candidates();
    let ovh: Vec<_> = seeded.iter().filter(|c| c.provider == "ovhcloud").collect();
    assert_eq!(ovh.len(), 6);
    assert_eq!(ovh[0].model, "gpt-oss-120b");
    assert_eq!(ovh[0].context, 131_072);
    assert_eq!(ovh[0].size_b, Some(120.0));
    assert_eq!(seeded.iter().filter(|c| c.provider == "aihorde").count(), 3);
    assert!(seeded.iter().all(|c| c.provider != "groq"));

    // v2 `Catalog.models`: the seed stays beside a live list, first, and wins on a clash.
    let catalog = Catalog::new(
        vec![fake(
            "aihorde",
            Says::List(vec![
                model("koboldcpp/live-13b", true),
                model("koboldcpp/gemma-4-31B-it-heretic", true),
            ]),
        )],
        vec![row("aihorde", Auth::Optional)],
        cache("seed-beside-list"),
    );
    catalog.refresh().await;
    assert_eq!(
        ids(&catalog.candidates()),
        vec![
            ("aihorde", "aphrodite/TheDrummer/Cydonia-24B-v4.3"),
            ("aihorde", "aphrodite/TheDrummer/Skyfall-31B-v4.2"),
            ("aihorde", "koboldcpp/gemma-4-31B-it-heretic"),
            ("aihorde", "koboldcpp/live-13b"),
        ]
    );
}

#[tokio::test]
async fn no_list_rows_with_a_key_use_their_seed() {
    // nara, cloudflare-ai and github publish no list: the real `models()` is Ok(empty) when
    // built with a key and NeedsKey without one, without touching the network.
    let mut rows = vec![
        row("nara", Auth::Required),
        row("cloudflare-ai", Auth::Required),
        row("github", Auth::Required),
    ];
    for r in &mut rows {
        r.models_path = None;
    }
    let catalog = Catalog::new(
        vec![
            real(&rows[0], Some("k")),
            real(&rows[1], Some("k")),
            real(&rows[2], Some("k")),
        ],
        rows.clone(),
        cache("no-list"),
    );
    // Not asked yet: a key-only row's seed waits for its first answer.
    assert!(catalog.candidates().is_empty());
    catalog.refresh().await;
    let got = catalog.candidates();
    assert_eq!(
        ids(&got),
        vec![
            ("nara", "mistral-large"),
            ("nara", "mistral-medium-3-5"),
            ("nara", "tencent-hy3"),
            ("cloudflare-ai", "@cf/zai-org/glm-4.7-flash"),
        ]
    );
    assert_eq!(got[2].context, 1_000_000);

    // Without a key there is nothing to offer.
    let catalog = Catalog::new(
        vec![real(&rows[0], None), real(&rows[1], None)],
        rows,
        cache("no-list-keyless"),
    );
    catalog.refresh().await;
    assert!(catalog.candidates().is_empty());
}

fn real(row: &FreeRow, key: Option<&str>) -> Arc<dyn Provider> {
    Arc::new(OpenAiCompat::new(
        row.clone(),
        key.map(str::to_owned),
        reqwest::Client::new(),
    ))
}

#[tokio::test]
async fn list_endpoint_404_keeps_cached_entries() {
    // A moved list endpoint is not a key problem: the cache stays, and a restart still has it.
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut groq = row("groq", Auth::Required);
    groq.base_url = format!("http://{}/v1", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 4096];
        let _ = sock.read(&mut buf).await;
        let _ = sock
            .write_all(
                b"HTTP/1.1 404 Not Found
content-length: 9
connection: close

not found",
            )
            .await;
    });
    let rows = vec![groq.clone()];
    let path = cache("list-404");
    Catalog::new(
        vec![fake("groq", Says::List(vec![model("llama-3.3-70b", true)]))],
        rows.clone(),
        path.clone(),
    )
    .refresh()
    .await;
    let catalog = Catalog::new(vec![real(&groq, Some("k"))], rows.clone(), path.clone());
    catalog.refresh().await;
    assert_eq!(ids(&catalog.candidates()), vec![("groq", "llama-3.3-70b")]);
    let restarted = Catalog::new(vec![fake("groq", Says::Down)], rows, path);
    assert_eq!(
        ids(&restarted.candidates()),
        vec![("groq", "llama-3.3-70b")]
    );
}

#[tokio::test]
async fn run_refreshes_then_stops_on_cancel() {
    let catalog = Arc::new(Catalog::new(
        vec![fake("groq", Says::List(vec![model("llama-3.3-70b", true)]))],
        vec![row("groq", Auth::Required)],
        cache("run"),
    ));
    let cancel = CancellationToken::new();
    let task = tokio::spawn({
        let catalog = catalog.clone();
        let cancel = cancel.clone();
        async move { catalog.run(cancel).await }
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while catalog.candidates().is_empty() {
        assert!(std::time::Instant::now() < deadline, "run never refreshed");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    cancel.cancel();
    tokio::time::timeout(std::time::Duration::from_secs(30), task)
        .await
        .expect("run stops when cancelled")
        .unwrap();
    assert_eq!(Catalog::REFRESH_MS, 6 * 60 * 60 * 1000);
}
