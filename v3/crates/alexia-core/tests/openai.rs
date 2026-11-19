// SPDX-License-Identifier: AGPL-3.0-only
//! P1-04: the OpenAI-compatible provider against a fake server speaking raw HTTP/1.1.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use alexia_core::free::{self, Auth, FreeRow};
use alexia_core::openai::OpenAiCompat;
use alexia_core::{ChatChunk, ChatRequest, Provider, ProviderError};
use alexia_store::{Content, MessageBody, Part, Role};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

const SSE: &str = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n";

/// Serves one request: records its body, writes `head`, then each `(wait ms, bytes)` step,
/// then closes. Returns the base URL and the recorded body.
async fn fake(head: &str, steps: Vec<(u64, String)>) -> (String, oneshot::Receiver<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let head = head.to_owned();
    let (tx, rx) = oneshot::channel();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = Vec::new();
        let mut byte = [0u8; 1024];
        let header_end = loop {
            let n = sock.read(&mut byte).await.unwrap();
            buf.extend_from_slice(&byte[..n]);
            if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break at + 4;
            }
        };
        let headers = String::from_utf8_lossy(&buf[..header_end]).to_lowercase();
        let length: usize = headers
            .lines()
            .find_map(|l| l.strip_prefix("content-length:"))
            .map_or(0, |v| v.trim().parse().unwrap());
        while buf.len() < header_end + length {
            let n = sock.read(&mut byte).await.unwrap();
            buf.extend_from_slice(&byte[..n]);
        }
        let body = serde_json::from_slice(&buf[header_end..]).unwrap_or(Value::Null);
        let _ = tx.send(body);
        if sock.write_all(head.as_bytes()).await.is_err() {
            return;
        }
        for (wait, bytes) in steps {
            tokio::time::sleep(Duration::from_millis(wait)).await;
            if sock.write_all(bytes.as_bytes()).await.is_err() {
                return;
            }
            let _ = sock.flush().await;
        }
    });
    (base, rx)
}

fn row(base: &str) -> FreeRow {
    FreeRow {
        id: "fake".into(),
        base_url: base.into(),
        models_path: Some("/models".into()),
        headers: vec![],
        auth: Auth::Required,
        all_free: true,
        rpm: None,
        rpd: None,
        router: false,
    }
}

fn provider(base: &str) -> OpenAiCompat {
    OpenAiCompat::new(row(base), Some("k".into()), reqwest::Client::new())
}

fn text(t: &str) -> MessageBody {
    serde_json::from_value(json!({"content": t})).unwrap()
}

fn hello() -> ChatRequest {
    ChatRequest {
        messages: vec![(Role::User, text("hi"))],
        system: None,
        tools: vec![],
        max_tokens: None,
    }
}

fn delta(field: &str, s: &str) -> String {
    format!(
        "data: {}\n\n",
        json!({"model": "m", "choices": [{"delta": {field: s}, "finish_reason": null}]})
    )
}

/// Runs a chat to the end and returns what came out.
async fn run(
    p: &OpenAiCompat,
    req: &ChatRequest,
) -> (Vec<ChatChunk>, Result<alexia_core::ChatDone, ProviderError>) {
    let (tx, mut rx) = mpsc::channel(64);
    let done = p.chat(req, "m", tx, CancellationToken::new()).await;
    let mut chunks = vec![];
    while let Ok(c) = rx.try_recv() {
        chunks.push(c);
    }
    (chunks, done)
}

#[tokio::test]
async fn streams_text_chunks_in_order() {
    let finish = format!(
        "data: {}\n\n",
        json!({"choices": [{"delta": {}, "finish_reason": "stop"}]})
    );
    let usage = format!(
        "data: {}\n\n",
        json!({"choices": [], "usage": {"prompt_tokens": 7, "completion_tokens": 3}})
    );
    let (base, _) = fake(
        SSE,
        vec![
            (0, delta("content", "one ")),
            // A line split across two TCP writes still parses.
            (20, delta("content", "two ")[..10].to_owned()),
            (20, delta("content", "two ")[10..].to_owned()),
            (20, delta("content", "three")),
            (0, finish),
            (0, usage),
            (0, "data: [DONE]\n\n".into()),
        ],
    )
    .await;
    let (chunks, done) = run(&provider(&base), &hello()).await;
    assert_eq!(
        chunks,
        vec![
            ChatChunk::Text("one ".into()),
            ChatChunk::Text("two ".into()),
            ChatChunk::Text("three".into())
        ]
    );
    let done = done.unwrap();
    assert_eq!(done.provider, "fake");
    assert!(done.first_byte_ms.is_some());
    assert_eq!((done.tokens_in, done.tokens_out), (7, 3));
}

#[tokio::test]
async fn reasoning_is_its_own_chunk() {
    let (base, _) = fake(
        SSE,
        vec![
            (0, delta("reasoning", "think")),
            (0, delta("reasoning_content", "more")),
            (0, delta("content", "answer")),
            (0, "data: [DONE]\n\n".into()),
        ],
    )
    .await;
    let (chunks, done) = run(&provider(&base), &hello()).await;
    done.unwrap();
    assert_eq!(
        chunks,
        vec![
            ChatChunk::Reasoning("think".into()),
            ChatChunk::Reasoning("more".into()),
            ChatChunk::Text("answer".into())
        ]
    );
}

#[tokio::test]
async fn system_goes_first_and_images_map() {
    let (base, body) = fake(SSE, vec![(0, "data: [DONE]\n\n".into())]).await;
    let mut parts = text("");
    parts.content = Content::Parts(vec![
        Part::Text {
            text: "look".into(),
        },
        Part::Image {
            url: "data:image/png;base64,AA==".into(),
        },
    ]);
    let req = ChatRequest {
        messages: vec![(Role::User, parts), (Role::Assistant, text("ok"))],
        system: Some("be brief".into()),
        tools: vec![],
        max_tokens: Some(50),
    };
    run(&provider(&base), &req).await.1.unwrap();
    let body = body.await.unwrap();
    assert_eq!(body["model"], "m");
    assert_eq!(body["stream"], true);
    assert_eq!(body["max_tokens"], 50);
    assert_eq!(
        body["messages"],
        json!([
            {"role": "system", "content": "be brief"},
            {"role": "user", "content": [
                {"type": "text", "text": "look"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}}
            ]},
            {"role": "assistant", "content": "ok"}
        ])
    );
}

#[tokio::test]
async fn status_429_is_busy_with_retry_after() {
    let (base, _) = fake(
        "HTTP/1.1 429 Too Many Requests\r\nretry-after: 3\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        vec![],
    )
    .await;
    let (_, done) = run(&provider(&base), &hello()).await;
    assert!(
        matches!(
            done,
            Err(ProviderError::Busy {
                retry_after_ms: Some(3000)
            })
        ),
        "{done:?}"
    );
}

#[tokio::test]
async fn status_401_is_needs_key() {
    let head = "HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
    // No key sent: it wants one.
    let (base, _) = fake(head, vec![]).await;
    let mut r = row(&base);
    r.auth = Auth::Optional;
    let keyless = OpenAiCompat::new(r, None, reqwest::Client::new());
    let (_, done) = run(&keyless, &hello()).await;
    assert!(matches!(done, Err(ProviderError::NeedsKey)), "{done:?}");
    // A key sent and refused.
    let (base, _) = fake(head, vec![]).await;
    let (_, done) = run(&provider(&base), &hello()).await;
    assert!(
        matches!(&done, Err(ProviderError::Refused(m)) if m == "the key was refused"),
        "{done:?}"
    );
}

#[tokio::test]
async fn huge_retry_after_saturates() {
    let (base, _) = fake(
        "HTTP/1.1 429 Too Many Requests
retry-after: 18446744073709551615
content-length: 0
connection: close

",
        vec![],
    )
    .await;
    let (_, done) = run(&provider(&base), &hello()).await;
    assert!(
        matches!(
            done,
            Err(ProviderError::Busy {
                retry_after_ms: Some(u64::MAX)
            })
        ),
        "{done:?}"
    );
}

#[test]
fn status_401_with_only_the_anonymous_key_is_needs_key() {
    // uncloseai, as `configured()` builds it: its published anonymous key is sent, none of
    // the person's is stored, so a 401 means it wants their key, not that a key was refused.
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("ALEXIA_SECRETS_IN_MEMORY", "1");
    let rt = tokio::runtime::Runtime::new().unwrap();
    let head = "HTTP/1.1 401 Unauthorized
content-length: 0
connection: close

";
    let (base, _) = rt.block_on(fake(head, vec![]));
    let path = std::env::temp_dir().join(format!("alexia-anon-{}.json", std::process::id()));
    let rows = json!([{"id": "uncloseai", "base_url": base, "auth": "none", "all_free": true}]);
    std::fs::write(&path, rows.to_string()).unwrap();
    std::env::set_var("ALEXIA_FREE_PROVIDERS", &path);
    let got = free::configured();
    std::env::remove_var("ALEXIA_FREE_PROVIDERS");
    let _ = std::fs::remove_file(&path);
    assert_eq!(free::key_for(got[0].row()), None);
    let (_, done) = rt.block_on(run(&got[0], &hello()));
    assert!(matches!(done, Err(ProviderError::NeedsKey)), "{done:?}");
}

#[tokio::test]
async fn finish_reason_error_is_failure() {
    let failed = format!(
        "data: {}

",
        json!({"choices": [{"delta": {}, "finish_reason": "error"}]})
    );
    let (base, _) = fake(
        SSE,
        vec![
            (0, delta("content", "half")),
            (0, failed),
            (
                0,
                "data: [DONE]

"
                .into(),
            ),
        ],
    )
    .await;
    let (_, done) = run(&provider(&base), &hello()).await;
    assert!(
        matches!(&done, Err(ProviderError::Other(m)) if m.contains("said the answer failed")),
        "{done:?}"
    );
}

#[tokio::test]
async fn status_400_carries_the_providers_message() {
    let said = json!({"error": {"message": "model not found"}}).to_string();
    let head = format!(
        "HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{said}",
        said.len()
    );
    let (base, _) = fake(&head, vec![]).await;
    let (_, done) = run(&provider(&base), &hello()).await;
    assert!(
        matches!(&done, Err(ProviderError::Refused(m)) if m == "model not found"),
        "{done:?}"
    );
}

#[tokio::test]
async fn stream_without_done_is_failure() {
    let (base, _) = fake(SSE, vec![(0, delta("content", "half a sen"))]).await;
    let (chunks, done) = run(&provider(&base), &hello()).await;
    assert_eq!(chunks, vec![ChatChunk::Text("half a sen".into())]);
    assert!(matches!(done, Err(ProviderError::Other(_))), "{done:?}");
}

#[tokio::test]
async fn first_byte_timeout() {
    let (base, _) = fake(SSE, vec![(60_000, delta("content", "late"))]).await;
    let p = OpenAiCompat::with_timeouts(
        row(&base),
        Some("k".into()),
        reqwest::Client::new(),
        Duration::from_millis(200),
        Duration::from_millis(200),
    );
    let started = Instant::now();
    let (_, done) = run(&p, &hello()).await;
    assert!(
        matches!(
            done,
            Err(ProviderError::Busy {
                retry_after_ms: None
            })
        ),
        "{done:?}"
    );
    assert!(started.elapsed() < Duration::from_secs(20));
}

#[tokio::test]
async fn cancel_stops_reading() {
    let (base, _) = fake(
        SSE,
        vec![
            (0, delta("content", "first")),
            (60_000, "data: [DONE]\n\n".into()),
        ],
    )
    .await;
    let p = provider(&base);
    let (tx, mut rx) = mpsc::channel(8);
    let cancel = CancellationToken::new();
    let req = hello();
    let chat = p.chat(&req, "m", tx, cancel.clone());
    let watch = async {
        assert_eq!(rx.recv().await, Some(ChatChunk::Text("first".into())));
        let at = Instant::now();
        cancel.cancel();
        at
    };
    let (done, at) = tokio::join!(chat, watch);
    assert!(matches!(done, Err(ProviderError::Cancelled)), "{done:?}");
    assert!(
        at.elapsed() < Duration::from_millis(100),
        "{:?}",
        at.elapsed()
    );
}

#[tokio::test]
async fn tools_are_refused_on_this_path() {
    let mut req = hello();
    req.tools =
        vec![
            serde_json::from_value(json!({"name": "t", "inputSchema": {"type": "object"}}))
                .unwrap(),
        ];
    let (_, done) = run(&provider("http://127.0.0.1:9"), &req).await;
    assert!(
        matches!(&done, Err(ProviderError::Other(m)) if m == "tools are not sent on this path"),
        "{done:?}"
    );
}

#[tokio::test]
async fn models_mark_free_rows() {
    let list = json!({"data": [
        {"id": "a:free"},
        {"id": "b", "pricing": {"prompt": "0", "completion": "0"}, "context_length": 32000},
        {"id": "c", "pricing": {"prompt": "0.1", "completion": "0"}},
    ]})
    .to_string();
    let head = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{list}",
        list.len()
    );
    let (base, _) = fake(&head, vec![]).await;
    let mut r = row(&base);
    r.all_free = false;
    let models = OpenAiCompat::new(r, Some("k".into()), reqwest::Client::new())
        .models()
        .await
        .unwrap();
    let got: Vec<_> = models
        .iter()
        .map(|m| (m.id.as_str(), m.free, m.context))
        .collect();
    assert_eq!(
        got,
        vec![
            ("a:free", true, 8192),
            ("b", true, 32000),
            ("c", false, 8192)
        ]
    );
}

#[test]
fn ladder_has_no_paid_or_local_rows() {
    let ladder = free::ladder();
    assert!(ladder.len() >= 7);
    let aggregators = [
        "openrouter",
        "kilo-gateway",
        "zai",
        "aion",
        "requesty",
        "navy",
    ];
    for row in &ladder {
        assert!(
            !["ollama", "llama", "mlx"].contains(&row.id.as_str()),
            "{}",
            row.id
        );
        assert!(
            row.all_free || aggregators.contains(&row.id.as_str()),
            "{}",
            row.id
        );
        assert!(row.base_url.starts_with("https://"), "{}", row.id);
    }
    for id in [
        "openrouter",
        "groq",
        "cerebras",
        "google",
        "mistral",
        "nvidia",
        "github",
    ] {
        assert!(ladder.iter().any(|r| r.id == id), "{id} missing");
    }
    let openrouter = &ladder[0];
    assert_eq!(openrouter.id, "openrouter");
    assert!(openrouter.headers.iter().any(|(k, _)| k == "HTTP-Referer"));
    assert_eq!((openrouter.rpm, openrouter.rpd), (Some(20), Some(50)));
}

static ENV: Mutex<()> = Mutex::new(());

#[test]
fn env_override_replaces_ladder() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let path = std::env::temp_dir().join(format!("alexia-free-{}.json", std::process::id()));
    let rows = json!([{"id": "local-fake", "base_url": "http://127.0.0.1:1/v1", "auth": "none", "all_free": true, "rpm": 5}]);
    std::fs::write(&path, rows.to_string()).unwrap();
    std::env::set_var("ALEXIA_FREE_PROVIDERS", &path);
    let got = free::configured();
    std::env::remove_var("ALEXIA_FREE_PROVIDERS");
    let _ = std::fs::remove_file(&path);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].id(), "local-fake");
    assert_eq!(got[0].row().auth, Auth::None);
    assert_eq!(got[0].row().rpm, Some(5));
    assert!(got[0].usable());
}

#[test]
fn keys_use_v2_names() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("ALEXIA_SECRETS_IN_MEMORY", "1");
    let groq = || {
        free::configured()
            .into_iter()
            .find(|p| p.id() == "groq")
            .unwrap()
    };
    assert!(!groq().usable());
    let key = "test-key".to_owned();
    alexia_store::secrets::set("_core", "provider_groq", &key).unwrap();
    assert!(groq().usable());
    assert_eq!(free::key_for(groq().row()), Some(key));
}
