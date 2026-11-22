// SPDX-License-Identifier: AGPL-3.0-only
//! P2-34: the local vision, embedding and checker jobs against a fake `llama-server`.
//!
//! The fake is a small std-only Rust program compiled once with `rustc` (as in `local.rs`). In the
//! folder of the `--model` file it writes `args.txt` (one line per start) and `chats.txt` (one
//! line per chat request, saying whether it carried a picture); it answers `/health`, a streamed
//! `/v1/chat/completions` and `/v1/embeddings` (vector `[index, count]` per input, sent in
//! reverse order with their `index` so the caller has to sort). Nothing leaves loopback.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};

use alexia_core::agent::{Agent, AgentParts};
use alexia_core::catalog::Catalog;
use alexia_core::chat::Caps;
use alexia_core::checker::Checker;
use alexia_core::gpu::Machine;
use alexia_core::hf::{GgufMeta, Installed};
use alexia_core::local::{see_before_cloud, LocalJobs, Runtime};
use alexia_core::router::Router;
use alexia_core::{
    Ask, Bus, Job, Limits, Origin, Question, ToolCtx, ToolOutcome, ToolSpec, Tooling,
};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, PluginId, Timings, Upcalls};
use alexia_store::{Content, Layout, MessageBody, Part, Role, Store};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

const FAKE: &str = r##"
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let val = |flag: &str| args.iter().position(|a| a == flag).map(|i| args[i + 1].clone()).unwrap();
    let (port, key) = (val("--port"), val("--api-key"));
    let dir = PathBuf::from(val("--model")).parent().unwrap().to_owned();
    let mut log = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("args.txt")).unwrap();
    writeln!(log, "{}", args.join(" ")).unwrap();
    drop(log);
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).unwrap();
    for conn in listener.incoming() {
        let Ok(mut s) = conn else { continue };
        let key = key.clone();
        let dir = dir.clone();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let mut b = [0u8; 4096];
            let end = loop {
                let n = s.read(&mut b).unwrap_or(0);
                if n == 0 { return; }
                buf.extend_from_slice(&b[..n]);
                if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") { break at + 4; }
            };
            let head = String::from_utf8_lossy(&buf[..end]).to_string();
            let lower = head.to_lowercase();
            let len: usize = lower.lines().find_map(|l| l.strip_prefix("content-length:")).map_or(0, |v| v.trim().parse().unwrap());
            while buf.len() < end + len {
                let n = s.read(&mut b).unwrap_or(0);
                if n == 0 { break; }
                buf.extend_from_slice(&b[..n]);
            }
            let body = String::from_utf8_lossy(&buf[end..]).to_string();
            let line = head.lines().next().unwrap_or("").to_owned();
            let json = |code: &str, ctype: &str, body: &str| format!("HTTP/1.1 {code}\r\ncontent-type: {ctype}\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}", body.len());
            let reply = if line.starts_with("GET /health") {
                json("200 OK", "application/json", r#"{"status":"ok"}"#)
            } else if !lower.contains(&format!("authorization: bearer {}", key.to_lowercase())) {
                json("401 Unauthorized", "application/json", r#"{"error":{"message":"no key"}}"#)
            } else if line.starts_with("GET /v1/models") {
                json("200 OK", "application/json", r#"{"data":[{"id":"fake"}]}"#)
            } else if line.starts_with("POST /v1/embeddings") {
                let at = body.find("\"input\":[").unwrap() + 9;
                let list = &body[at..at + body[at..].find(']').unwrap()];
                let n = if list.trim().is_empty() { 0 } else { list.split("\",\"").count() };
                let rows: Vec<String> = (0..n).rev().map(|i| format!("{{\"index\":{i},\"embedding\":[{i}.0,{n}.0]}}")).collect();
                json("200 OK", "application/json", &format!("{{\"data\":[{}]}}", rows.join(",")))
            } else {
                let mut log = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("chats.txt")).unwrap();
                writeln!(log, "{}", if body.contains("image_url") { "picture" } else { "text" }).unwrap();
                let text = "data: {\"choices\":[{\"delta\":{\"content\":\"A red square. Text in the picture: STOP\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n";
                json("200 OK", "text/event-stream", text)
            };
            let _ = s.write_all(reply.as_bytes());
        });
    }
}
"##;

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn scratch(name: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("alexia-jobs-{}-{name}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn fake_exe() {
    static EXE: OnceLock<PathBuf> = OnceLock::new();
    EXE.get_or_init(|| {
        let dir = scratch("fake");
        let src = dir.join("fake.rs");
        std::fs::write(&src, FAKE).unwrap();
        let exe = dir.join(if cfg!(windows) { "fake.exe" } else { "fake" });
        let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".into());
        let out = std::process::Command::new(rustc)
            .args(["--edition", "2021", "-O", "-o"])
            .arg(&exe)
            .arg(&src)
            .output()
            .expect("rustc runs");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        std::env::set_var("ALEXIA_LLAMA_SERVER", &exe);
        exe
    });
}

struct FakeTools;

#[async_trait::async_trait]
impl Tooling for FakeTools {
    async fn list(&self) -> Vec<ToolSpec> {
        Vec::new()
    }
    async fn call(&self, name: &str, _: Map<String, Value>, _: ToolCtx) -> ToolOutcome {
        ToolOutcome {
            text: format!("{name} done"),
            ok: true,
            files: Vec::new(),
            final_text: None,
            undo: None,
            card: None,
        }
    }
}

struct FakeAsk;

#[async_trait::async_trait]
impl Ask for FakeAsk {
    async fn confirm(&self, _: &Origin, _: &Question, _: CancellationToken) -> bool {
        true
    }
}

struct NoCaps;

#[async_trait::async_trait]
impl Caps for NoCaps {
    fn answers(&self, _: &str) -> bool {
        false
    }
    async fn call(&self, _: &str, _: Map<String, Value>, _: CancellationToken) -> Option<String> {
        None
    }
}

struct World {
    agent: Arc<Agent>,
    jobs: Arc<LocalJobs>,
    store: Arc<Store>,
    router: Arc<Router>,
    runtime: Arc<Runtime>,
    root: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// A 24 GB GPU, an in-memory store, and the real runtime on the fake `llama-server`.
async fn world() -> World {
    fake_exe();
    let root = scratch("world");
    std::fs::create_dir_all(root.join("ext")).unwrap();
    let store = Arc::new(Store::open_in_memory().unwrap());
    let catalog = Arc::new(Catalog::new(
        Vec::new(),
        Vec::new(),
        root.join("catalog.json"),
    ));
    let router = Arc::new(Router::new(Vec::new(), catalog, store.clone()));
    let layout = Layout::new(root.join("data"));
    let runtime = Runtime::new(Layout::new(root.join("data")), reqwest::Client::new());
    let jobs = LocalJobs::new(runtime.clone(), store.clone(), router.clone());
    jobs.set_machine(Machine {
        vram_mb: 24_000,
        free_mb: 24_000,
        ram_mb: 32_000,
        gpu: Some("Fake GPU".into()),
    });
    let host = McpHost::new(
        HostConfig {
            layout: Layout::new(root.join("data")),
            plugin_dirs: vec![root.join("ext")],
            node: PathBuf::from("node"),
            timings: Timings::default(),
        },
        store.clone(),
        Arc::new(NoUpcalls),
        Arc::new(|_| {}),
    );
    host.start(&[]).await.unwrap();
    let agent = Agent::new(AgentParts {
        router: router.clone(),
        tools: Arc::new(FakeTools),
        store: store.clone(),
        bus: Bus::new(64),
        ask: Arc::new(FakeAsk),
        checker: Arc::new(Checker::new(None)),
        caps: Arc::new(NoCaps),
        layout,
        limits: Limits::default(),
        host,
    });
    World {
        agent,
        jobs,
        store,
        router,
        runtime,
        root,
    }
}

const GB: u64 = 1_000_000_000;

/// One installed model in its own folder (the fake writes its logs there).
fn model(id: &str, arch: &str, bytes: u64, kv: u64, picture: bool) -> Installed {
    let dir = scratch(id);
    let path = dir.join("model.gguf");
    std::fs::write(&path, b"x").unwrap();
    let mmproj = picture.then(|| {
        let p = dir.join("mmproj.gguf");
        std::fs::write(&p, b"x").unwrap();
        p
    });
    Installed {
        id: id.into(),
        path: path.clone(),
        meta: GgufMeta {
            arch: arch.into(),
            layers: 32,
            context: 8192,
            kv_bytes_per_token: kv,
            bytes,
            parts: vec![path],
            vision_projector: false,
        },
        mmproj,
    }
}

fn install(w: &World, models: &[Installed]) {
    w.store
        .kv_set(
            "_core",
            "local_models",
            &serde_json::to_value(models).unwrap(),
        )
        .unwrap();
}

fn folder(m: &Installed) -> &Path {
    m.path.parent().unwrap()
}

fn lines(m: &Installed, file: &str) -> Vec<String> {
    std::fs::read_to_string(folder(m).join(file))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn body(content: Content) -> MessageBody {
    serde_json::from_value(json!({ "content": content })).unwrap()
}

fn picture_turn(url: &str) -> (Role, MessageBody) {
    (
        Role::User,
        body(Content::Parts(vec![
            Part::Text {
                text: "What is this?".into(),
            },
            Part::Image { url: url.into() },
        ])),
    )
}

const PNG: &str = "data:image/png;base64,AAAA";

fn all_text(messages: &[(Role, MessageBody)]) -> String {
    messages
        .iter()
        .map(|(_, b)| b.content.text())
        .collect::<Vec<_>>()
        .join("\n")
}

fn has_image(messages: &[(Role, MessageBody)]) -> bool {
    messages.iter().any(|(_, b)| match &b.content {
        Content::Parts(p) => p.iter().any(|p| matches!(p, Part::Image { .. })),
        Content::Text(_) => false,
    })
}

#[tokio::test]
async fn images_replaced_before_cloud() {
    let w = world().await;
    let eyes = model("eyes", "llama", 4 * GB, 50_000, true);
    install(&w, std::slice::from_ref(&eyes));
    let plain = (Role::Assistant, body(Content::Text("hello".into())));
    let got = see_before_cloud(Some(&w.jobs), vec![plain.clone(), picture_turn(PNG)]).await;
    assert!(!has_image(&got), "{got:?}");
    assert_eq!(got[0], plain);
    let text = all_text(&got[1..]);
    assert!(text.contains("What is this?"), "{text}");
    assert!(text.contains("A red square."), "{text}");
    assert!(text.contains("Text in the picture: STOP"), "{text}");
    // The model was asked with the picture, and started with its projector.
    assert_eq!(lines(&eyes, "chats.txt"), ["picture"]);
    assert!(lines(&eyes, "args.txt")[0].contains("--mmproj"));
    // No wiring: unchanged.
    let same = see_before_cloud(None, vec![picture_turn(PNG)]).await;
    assert!(has_image(&same));
    w.runtime.stop_all().await;
}

#[tokio::test]
async fn no_vision_model_means_no_picture_leaves() {
    let w = world().await;
    let got = see_before_cloud(Some(&w.jobs), vec![picture_turn(PNG)]).await;
    assert!(!has_image(&got));
    assert!(all_text(&got).contains("cannot look at pictures"));
    assert!(w.runtime.pids().is_empty());
}

#[tokio::test]
async fn cloud_setting_keeps_images() {
    let w = world().await;
    install(&w, &[model("eyes", "llama", 4 * GB, 50_000, true)]);
    w.store.kv_set("_core", "vision", &json!("cloud")).unwrap();
    let before = vec![picture_turn(PNG)];
    let got = see_before_cloud(Some(&w.jobs), before.clone()).await;
    assert_eq!(got, before);
    assert!(w.runtime.pids().is_empty(), "nothing was started");
}

#[tokio::test]
async fn describe_cached_per_image() {
    let w = world().await;
    let eyes = model("eyes", "llama", 4 * GB, 50_000, true);
    install(&w, std::slice::from_ref(&eyes));
    let one = w
        .jobs
        .describe(PNG, CancellationToken::new())
        .await
        .unwrap();
    let again = w
        .jobs
        .describe(PNG, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(one, again);
    assert_eq!(lines(&eyes, "chats.txt").len(), 1, "described once");
    let other = "data:image/png;base64,BBBB";
    w.jobs
        .describe(other, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(lines(&eyes, "chats.txt").len(), 2);
    assert_eq!(lines(&eyes, "args.txt").len(), 1, "one server start");
    w.runtime.stop_all().await;
}

#[tokio::test]
async fn embed_shapes() {
    let w = world().await;
    let bert = model("minilm", "bert", GB / 2, 10_000, false);
    install(&w, std::slice::from_ref(&bert));
    let texts: Vec<String> = ["one", "two", "three"].map(String::from).to_vec();
    let got = w
        .jobs
        .embed(&texts, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(got.len(), 3);
    for (i, v) in got.iter().enumerate() {
        assert_eq!(v, &vec![i as f32, 3.0], "vector {i} is in input order");
    }
    assert!(lines(&bert, "args.txt")[0].contains("--embedding"));
    let none = w.jobs.embed(&[], CancellationToken::new()).await.unwrap();
    assert!(none.is_empty());
    w.runtime.stop_all().await;
}

#[tokio::test]
async fn checker_picks_smallest_fit() {
    let w = world().await;
    // Too much KV cache to fit at 8k context, though small on disk.
    let heavy = model("heavy-kv", "qwen", GB, 10_000_000, false);
    let small = model("small", "qwen", 2 * GB, 50_000, false);
    // Small on disk, big KV at 8k, but fine at the draft's 2k: becomes the draft.
    let draft = model("draftling", "qwen", GB / 2, 2_500_000, false);
    let mid = model("mid", "qwen", 6 * GB, 50_000, false);
    let huge = model("huge", "qwen", 80 * GB, 50_000, false);
    let bert = model("minilm", "bert", GB / 4, 10_000, false);
    install(
        &w,
        &[
            huge.clone(),
            mid.clone(),
            heavy,
            small.clone(),
            draft.clone(),
            bert,
        ],
    );
    let (provider, id) = w.jobs.checker_model().await.unwrap();
    assert_eq!(id, "small");
    assert_eq!(provider.id(), "local:small");
    let args = &lines(&small, "args.txt")[0];
    assert!(
        !args.contains("--embedding") && !args.contains("--mmproj"),
        "{args}"
    );
    assert!(
        args.contains(&format!("--model-draft {}", draft.path.to_string_lossy())),
        "{args}"
    );
    // The owner's pin wins.
    w.router
        .set_pins(Job::Check, vec!["local:mid".into()])
        .unwrap();
    let (_, id) = w.jobs.checker_model().await.unwrap();
    assert_eq!(id, "mid");
    // Nothing fits on a small GPU: no checker.
    w.router.set_pins(Job::Check, Vec::new()).unwrap();
    w.jobs.set_machine(Machine {
        vram_mb: 2_000,
        free_mb: 2_000,
        ram_mb: 32_000,
        gpu: None,
    });
    assert!(w.jobs.checker_model().await.is_none());
    w.runtime.stop_all().await;
}

#[tokio::test]
async fn chat_jobs_get_no_local_provider() {
    let w = world().await;
    install(&w, &[model("small", "qwen", 2 * GB, 50_000, false)]);
    for job in [Job::Chat, Job::Plan, Job::Step, Job::Code] {
        assert!(w.jobs.provider(job).await.is_none(), "{job:?}");
    }
    assert!(w.runtime.pids().is_empty());
    assert!(w.jobs.provider(Job::Check).await.is_some());
    w.runtime.stop_all().await;
}

#[tokio::test]
async fn paused_returns_none() {
    let w = world().await;
    install(
        &w,
        &[
            model("eyes", "llama", 4 * GB, 50_000, true),
            model("minilm", "bert", GB / 2, 10_000, false),
        ],
    );
    w.jobs.set_paused(true);
    assert!(w
        .jobs
        .describe(PNG, CancellationToken::new())
        .await
        .is_none());
    let one = ["x".to_owned()];
    assert!(w.jobs.embed(&one, CancellationToken::new()).await.is_none());
    assert!(w.jobs.checker_model().await.is_none());
    assert!(w.jobs.provider(Job::Vision).await.is_none());
    assert!(w.runtime.pids().is_empty(), "no model was started");
    let got = see_before_cloud(Some(&w.jobs), vec![picture_turn(PNG)]).await;
    assert!(!has_image(&got), "a picture still does not leave the PC");
    w.jobs.set_paused(false);
    assert!(w
        .jobs
        .describe(PNG, CancellationToken::new())
        .await
        .is_some());
    w.runtime.stop_all().await;
}

#[tokio::test]
async fn host_caps_only_when_installed() {
    let w = world().await;
    assert!(w.agent.host_caps().is_empty(), "no jobs wired");
    w.agent.set_local_jobs(w.jobs.clone());
    assert!(w.agent.host_caps().is_empty(), "nothing installed");
    let eyes = model("eyes", "llama", 4 * GB, 50_000, true);
    install(&w, std::slice::from_ref(&eyes));
    assert_eq!(w.agent.host_caps(), ["vision.describe"]);
    install(&w, &[eyes, model("minilm", "bert", GB / 2, 10_000, false)]);
    assert_eq!(w.agent.host_caps(), ["vision.describe", "text.embed"]);
}

#[tokio::test]
async fn host_call_embed_round_trip() {
    let w = world().await;
    w.agent.set_local_jobs(w.jobs.clone());
    install(
        &w,
        &[
            model("minilm", "bert", GB / 2, 10_000, false),
            model("eyes", "llama", 4 * GB, 50_000, true),
        ],
    );
    let plugin = PluginId("notes".into());
    let call = |cap: &str, args: Value| {
        let w = &w;
        let plugin = &plugin;
        let cap = cap.to_owned();
        async move {
            w.agent
                .host_call(
                    plugin,
                    &cap,
                    args.as_object().unwrap().clone(),
                    CancellationToken::new(),
                )
                .await
        }
    };
    let got = call("text.embed", json!({ "texts": ["a", "b"] }))
        .await
        .expect("served here")
        .expect("no error");
    assert_eq!(
        Value::Object(got.structured_content.unwrap()),
        json!({ "vectors": [[0.0, 2.0], [1.0, 2.0]] })
    );
    let seen = call("vision.describe", json!({ "image": PNG }))
        .await
        .unwrap()
        .unwrap();
    let description = seen.structured_content.unwrap()["description"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(description.contains("A red square."), "{description}");
    // Bad arguments are the caller's fault; an unknown capability is not ours.
    assert!(call("text.embed", json!({ "texts": [1] }))
        .await
        .unwrap()
        .is_err());
    assert!(call("vision.describe", json!({})).await.unwrap().is_err());
    assert!(call("text.translate", json!({})).await.is_none());
    w.runtime.stop_all().await;
}
