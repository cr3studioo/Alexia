// SPDX-License-Identifier: AGPL-3.0-only
//! P2-21: what plugins ask of core, driven straight at `Upcalls for Agent` (P2-40 proves the
//! real wire). A scripted provider plays the model; a fake `Tooling` and `Ask` stand in for
//! the rest.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use alexia_core::agent::{Agent, AgentParts};
use alexia_core::catalog::Catalog;
use alexia_core::chat::Caps;
use alexia_core::checker::Checker;
use alexia_core::free::{Auth, FreeRow};
use alexia_core::router::Router;
use alexia_core::{
    Ask, Bus, ChatChunk, ChatDone, ChatRequest, Limits, ModelInfo, Origin, Provider, ProviderError,
    Question, ToolCtx, ToolOutcome, ToolSpec, Tooling,
};
use alexia_mcp::alexia::{AttachmentsCall, PrivacyMode};
use alexia_mcp::jsonrpc::code;
use alexia_mcp::types::{CreateMessageParams, ProgressParams};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, PluginId, Timings, Upcalls};
use alexia_store::{Layout, Role, Store, ToolCall};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

type Script = Arc<dyn Fn(&ChatRequest, &str) -> Vec<ChatChunk> + Send + Sync>;
/// (model, request) of every model call.
type Asked = Arc<Mutex<Vec<(String, ChatRequest)>>>;

struct FakeModel {
    id: String,
    models: Vec<&'static str>,
    script: Script,
    asked: Asked,
}

#[async_trait::async_trait]
impl Provider for FakeModel {
    fn id(&self) -> &str {
        &self.id
    }
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(self
            .models
            .iter()
            .map(|m| ModelInfo {
                id: (*m).into(),
                context: 32_768,
                free: true,
                tools: true,
                vision: false,
            })
            .collect())
    }
    async fn chat(
        &self,
        req: &ChatRequest,
        model: &str,
        out: mpsc::Sender<ChatChunk>,
        _: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        self.asked.lock().unwrap().push((model.into(), req.clone()));
        let mut words = 0;
        for chunk in (self.script)(req, model) {
            words += 1;
            let _ = out.send(chunk).await;
        }
        Ok(ChatDone {
            model: model.into(),
            provider: self.id.clone(),
            tokens_in: 1,
            tokens_out: words,
            cost: 0.0,
            first_byte_ms: None,
        })
    }
}

struct FakeTools {
    ran: Arc<Mutex<Vec<String>>>,
}

#[async_trait::async_trait]
impl Tooling for FakeTools {
    async fn list(&self) -> Vec<ToolSpec> {
        let spec = |name: &str, read_only: bool| ToolSpec {
            name: name.into(),
            description: format!("The {name} tool."),
            params: json!({ "type": "object" }),
            annotations: Some(
                serde_json::from_value(json!({
                    "readOnlyHint": read_only, "destructiveHint": !read_only,
                }))
                .unwrap(),
            ),
            reviewed: true,
            plugin: None,
            words: format!("use {name}"),
        };
        vec![spec("look", true), spec("wipe", false)]
    }
    async fn call(&self, name: &str, _: Map<String, Value>, _: ToolCtx) -> ToolOutcome {
        self.ran.lock().unwrap().push(name.into());
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

struct FakeAsk {
    yes: bool,
    asked: Arc<Mutex<Vec<(Origin, String)>>>,
}

#[async_trait::async_trait]
impl Ask for FakeAsk {
    async fn confirm(&self, origin: &Origin, q: &Question, _: CancellationToken) -> bool {
        self.asked
            .lock()
            .unwrap()
            .push((origin.clone(), q.text.clone()));
        self.yes
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
    store: Arc<Store>,
    asked: Asked,
    ran: Arc<Mutex<Vec<String>>>,
    questions: Arc<Mutex<Vec<(Origin, String)>>>,
    layout: Layout,
    root: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn text(t: &str) -> Vec<ChatChunk> {
    vec![ChatChunk::Text(t.into())]
}

fn temp() -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "alexia-upcalls-test-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ))
}

async fn world(provider: &str, models: Vec<&'static str>, yes: bool, script: Script) -> World {
    let root = temp();
    std::fs::create_dir_all(root.join("ext")).unwrap();
    std::fs::create_dir_all(root.join("data")).unwrap();
    let asked: Asked = Arc::default();
    let p: Arc<dyn Provider> = Arc::new(FakeModel {
        id: provider.into(),
        models,
        script,
        asked: asked.clone(),
    });
    let row = FreeRow {
        id: provider.into(),
        base_url: format!("http://{provider}.invalid/v1"),
        models_path: Some("/models".into()),
        headers: Vec::new(),
        auth: Auth::Optional,
        all_free: true,
        rpm: None,
        rpd: None,
        router: false,
    };
    let catalog = Arc::new(Catalog::new(
        vec![p.clone()],
        vec![row],
        root.join("catalog.json"),
    ));
    catalog.refresh().await;
    let store = Arc::new(Store::open_in_memory().unwrap());
    let router = Arc::new(Router::new(vec![p], catalog, store.clone()));
    let layout = Layout::new(root.join("data"));
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
    let ran = Arc::new(Mutex::new(Vec::new()));
    let questions = Arc::new(Mutex::new(Vec::new()));
    let agent = Agent::new(AgentParts {
        router,
        tools: Arc::new(FakeTools { ran: ran.clone() }),
        store: store.clone(),
        bus: Bus::new(64),
        ask: Arc::new(FakeAsk {
            yes,
            asked: questions.clone(),
        }),
        checker: Arc::new(Checker::new(None)),
        caps: Arc::new(NoCaps),
        layout: layout_of(&root),
        limits: Limits::default(),
        host,
    });
    World {
        agent,
        store,
        asked,
        ran,
        questions,
        layout,
        root,
    }
}

fn layout_of(root: &std::path::Path) -> Layout {
    Layout::new(root.join("data"))
}

fn plugin() -> PluginId {
    PluginId("notes".into())
}

fn params(v: Value) -> CreateMessageParams {
    serde_json::from_value(v).unwrap()
}

fn say(t: &str) -> Value {
    json!({ "role": "user", "content": { "type": "text", "text": t } })
}

fn reply_text(v: &Value) -> &str {
    v["content"]["text"].as_str().unwrap()
}

async fn sample(w: &World, p: Value) -> Result<Value, alexia_mcp::jsonrpc::RpcError> {
    w.agent
        .sample(&plugin(), params(p), None, CancellationToken::new())
        .await
}

fn models_asked(w: &World) -> Vec<String> {
    w.asked
        .lock()
        .unwrap()
        .iter()
        .map(|(m, _)| m.clone())
        .collect()
}

#[tokio::test]
async fn plain_sample_answers() {
    let w = world("p", vec!["big-70b"], true, Arc::new(|_, _| text("Four."))).await;
    let got = sample(
        &w,
        json!({ "messages": [say("2+2?")], "systemPrompt": "Be brief.", "maxTokens": 50 }),
    )
    .await
    .unwrap();
    assert_eq!(got["role"], "assistant");
    assert_eq!(reply_text(&got), "Four.");
    assert_eq!(got["model"], "big-70b");
    assert_eq!(got["stopReason"], "endTurn");
    let asked = w.asked.lock().unwrap();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].1.system.as_deref(), Some("Be brief."));
    assert_eq!(asked[0].1.max_tokens, Some(50));
    assert!(
        asked[0].1.tools.is_empty(),
        "plain sampling carries no tools"
    );
}

#[tokio::test]
async fn tools_sample_runs_the_loop() {
    let script: Script = Arc::new(|req, _| {
        if req.messages.last().is_some_and(|(r, _)| *r == Role::Tool) {
            return text("All done.");
        }
        vec![ChatChunk::ToolCall(ToolCall {
            id: "c1".into(),
            name: "wipe".into(),
            arguments: "{}".into(),
        })]
    });
    let w = world("p", vec!["big-70b"], true, script).await;
    let got = sample(
        &w,
        json!({ "messages": [say("clean up")], "_meta": { "alexia/tools": true } }),
    )
    .await
    .unwrap();
    assert_eq!(reply_text(&got), "All done.");
    assert_eq!(w.ran.lock().unwrap().as_slice(), ["wipe"]);
    // The risky call was asked about, once, and (no chat known) the question had nowhere but the desktop.
    {
        let qs = w.questions.lock().unwrap();
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].0, Origin::Desktop);
    }
    // The plugin's conversation holds the turn that started it and the answer.
    let n = w
        .store
        .kv_get("_core", "chat:notes")
        .unwrap()
        .unwrap()
        .as_i64()
        .unwrap();
    let kept = w.store.history(alexia_store::SessionId(n), None).unwrap();
    assert_eq!(kept.first().unwrap().body.content.text(), "clean up");
    assert_eq!(kept.last().unwrap().body.content.text(), "All done.");
    // The same conversation is used next time.
    sample(
        &w,
        json!({ "messages": [say("again")], "_meta": { "alexia/tools": true } }),
    )
    .await
    .unwrap();
    assert_eq!(
        w.store
            .kv_get("_core", "chat:notes")
            .unwrap()
            .unwrap()
            .as_i64()
            .unwrap(),
        n
    );
}

#[tokio::test]
async fn local_refused_without_model() {
    let w = world("p", vec!["big-70b"], true, Arc::new(|_, _| text("hi"))).await;
    let err = sample(
        &w,
        json!({ "messages": [say("plan this")], "_meta": { "alexia/local": true } }),
    )
    .await
    .unwrap_err();
    assert!(
        err.message.contains("running on this computer"),
        "{}",
        err.message
    );
    assert!(
        models_asked(&w).is_empty(),
        "a private request never reaches a hosted model"
    );
}

#[tokio::test]
async fn format_needs_local() {
    let w = world("p", vec!["big-70b"], true, Arc::new(|_, _| text("{}"))).await;
    let format = json!({ "name": "plan", "schema": { "type": "object" }, "strict": true });
    let err = sample(
        &w,
        json!({ "messages": [say("x")], "_meta": { "alexia/format": format } }),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, code::INVALID_PARAMS);
    assert!(
        err.message.contains("kept on this computer"),
        "{}",
        err.message
    );
    // An unsupported format is refused before anything runs, even when kept local.
    let err = sample(
        &w,
        json!({ "messages": [say("x")], "_meta": {
            "alexia/local": true, "alexia/format": { "name": "no spaces", "schema": {}, "strict": true } } }),
    )
    .await
    .unwrap_err();
    assert!(
        err.message.contains("not one Alexia supports"),
        "{}",
        err.message
    );
    // Private and tools do not mix.
    let err = sample(
        &w,
        json!({ "messages": [say("x")], "_meta": { "alexia/local": true, "alexia/tools": true } }),
    )
    .await
    .unwrap_err();
    assert!(err.message.contains("cannot use tools"), "{}", err.message);
    assert!(models_asked(&w).is_empty());
}

#[tokio::test]
async fn command_in_sample_runs_command() {
    let w = world("p", vec!["big-70b"], true, Arc::new(|_, _| text("model"))).await;
    // Some conversation already has something said in it.
    sample(
        &w,
        json!({ "messages": [say("hello")], "_meta": { "alexia/tools": true } }),
    )
    .await
    .unwrap();
    let before = w.store.kv_get("_core", "chat:notes").unwrap().unwrap();
    let asked = models_asked(&w).len();
    let got = sample(&w, json!({ "messages": [say("/new")] }))
        .await
        .unwrap();
    assert_eq!(reply_text(&got), "Started a new chat.");
    let after = w.store.kv_get("_core", "chat:notes").unwrap().unwrap();
    assert_ne!(before, after, "the plugin's conversation is a new one");
    // A command is not a question for a model; and an empty chat is not stacked on.
    let again = sample(&w, json!({ "messages": [say("/new")] }))
        .await
        .unwrap();
    assert!(reply_text(&again).contains("already a new chat"));
    assert_eq!(models_asked(&w).len(), asked);
    // Wrapped in a prompt (several lines), a leading slash is text, not a command.
    sample(
        &w,
        json!({ "messages": [say("/new\nthen tell me a joke")] }),
    )
    .await
    .unwrap();
    assert_eq!(models_asked(&w).len(), asked + 1);
}

#[tokio::test]
async fn stream_progress_frames() {
    let w = world(
        "p",
        vec!["big-70b"],
        true,
        Arc::new(|_, _| {
            vec![
                ChatChunk::Text("The first ".into()),
                ChatChunk::Text("few words, ".into()),
                ChatChunk::Text("and the rest.".into()),
            ]
        }),
    )
    .await;
    let (tx, mut rx) = mpsc::channel::<ProgressParams>(256);
    let got = w
        .agent
        .sample(
            &plugin(),
            params(json!({ "messages": [say("go")] })),
            Some(tx),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    // Every frame for the request is already in the pipe when the result arrives.
    let mut frames = Vec::new();
    while let Ok(f) = rx.try_recv() {
        frames.push(f);
    }
    assert!(!frames.is_empty());
    let progress: Vec<f64> = frames.iter().map(|f| f.progress).collect();
    assert_eq!(
        progress,
        (1..=frames.len()).map(|n| n as f64).collect::<Vec<_>>()
    );
    let stream = |f: &ProgressParams| f.meta.as_ref().unwrap()["alexia/stream"].clone();
    let heard: String = frames
        .iter()
        .filter_map(|f| stream(f)["delta"].as_str().map(str::to_owned))
        .collect();
    assert_eq!(heard, reply_text(&got), "the deltas joined are the answer");
    assert_eq!(heard, "The first few words, and the rest.");
    assert!(
        frames.iter().any(|f| stream(f)["phase"] == "writing"),
        "the stage the wait is in is told too"
    );
    assert!(frames.iter().all(|f| f.total.is_none()));
    // No token, no frames: the same call without a sink still answers.
    assert!(sample(&w, json!({ "messages": [say("go")] })).await.is_ok());
}

#[tokio::test]
async fn elicit_yes_no_asks_owner() {
    let w = world("p", vec!["big-70b"], true, Arc::new(|_, _| text("x"))).await;
    let form = json!({
        "mode": "form", "message": "Delete the old drafts?",
        "requestedSchema": { "type": "object", "properties": { "ok": { "type": "boolean" } } }
    });
    let got = w.agent.elicit(&plugin(), form.clone()).await.unwrap();
    assert_eq!(
        got,
        json!({ "action": "accept", "content": { "ok": true } })
    );
    {
        let qs = w.questions.lock().unwrap();
        assert_eq!(qs.len(), 1);
        assert!(qs[0].1.contains("Delete the old drafts?"), "{}", qs[0].1);
        assert_eq!(qs[0].0, Origin::Desktop);
    }
    // With a known primary chat the question goes there.
    w.store.channel_session("telegram", "42").unwrap();
    w.agent.elicit(&plugin(), form).await.unwrap();
    assert_eq!(
        w.questions.lock().unwrap()[1].0,
        Origin::Channel {
            channel: "telegram".into(),
            chat: "42".into()
        }
    );
    // Any other form is refused, and nobody is asked.
    for other in [
        json!({ "message": "Name?", "requestedSchema": { "type": "object",
            "properties": { "name": { "type": "string" } } } }),
        json!({ "message": "Two?", "requestedSchema": { "type": "object",
            "properties": { "a": { "type": "boolean" }, "b": { "type": "boolean" } } } }),
        json!({ "mode": "url", "message": "Go", "url": "https://example.test" }),
    ] {
        let err = w.agent.elicit(&plugin(), other).await.unwrap_err();
        assert_eq!(err.code, code::MISSING_REQUIRED_CLIENT_CAPABILITY);
    }
    assert_eq!(w.questions.lock().unwrap().len(), 2);
    // A no is an answer, not an error.
    let no = world("p", vec!["big-70b"], false, Arc::new(|_, _| text("x"))).await;
    let got = no
        .agent
        .elicit(
            &plugin(),
            json!({ "message": "Sure?", "requestedSchema": { "type": "object",
                "properties": { "sure": { "type": "boolean" } } } }),
        )
        .await
        .unwrap();
    assert_eq!(got["content"]["sure"], false);
}

#[tokio::test]
async fn roots_follow_scope() {
    let w = world("p", vec!["big-70b"], true, Arc::new(|_, _| text("x"))).await;
    assert!(
        w.agent.roots(&plugin()).await.is_empty(),
        "no folder chosen, none told"
    );
    let folder = temp();
    std::fs::create_dir_all(&folder).unwrap();
    let data = w.layout.root.clone();
    w.store
        .kv_set(
            "_core",
            "scope",
            &json!({ "roots": [folder.to_string_lossy(), data.to_string_lossy()] }),
        )
        .unwrap();
    let roots = w.agent.roots(&plugin()).await;
    // Alexia's own data folder is never handed out.
    assert_eq!(roots.len(), 1, "{roots:?}");
    assert!(roots[0].uri.starts_with("file:///"), "{}", roots[0].uri);
    let name = folder.file_name().unwrap().to_string_lossy().into_owned();
    assert_eq!(roots[0].name.as_deref(), Some(name.as_str()));
    w.store
        .kv_set("_core", "scope", &json!({ "roots": [] }))
        .unwrap();
    assert!(w.agent.roots(&plugin()).await.is_empty());
    let _ = std::fs::remove_dir_all(&folder);
}

#[tokio::test]
async fn offers_and_facts_follow_the_store() {
    let w = world("p", vec!["big-70b"], true, Arc::new(|_, _| text("x"))).await;
    let offered = w.agent.offers(&plugin());
    assert!(offered.roots.is_some() && offered.sampling.is_some() && offered.elicitation.is_some());
    let facts = w.agent.host_facts();
    assert_eq!(facts.display_name, "Alexia");
    assert!(matches!(facts.privacy_mode, PrivacyMode::Combined));
    w.store
        .kv_set("_core", "display_name", &json!("Vera"))
        .unwrap();
    w.store.kv_set("_core", "mode", &json!("local")).unwrap();
    let facts = w.agent.host_facts();
    assert_eq!(facts.display_name, "Vera");
    assert!(matches!(facts.privacy_mode, PrivacyMode::Local));
    // Local mode with nothing local to answer withdraws sampling, and a hosted model is not used.
    assert!(w.agent.offers(&plugin()).sampling.is_none());
    let err = sample(&w, json!({ "messages": [say("hi")] }))
        .await
        .unwrap_err();
    assert!(err.message.contains("Local mode"), "{}", err.message);
    assert!(models_asked(&w).is_empty());
}

#[tokio::test]
async fn sample_usage_attributed_to_plugin() {
    let w = world("p", vec!["big-70b"], true, Arc::new(|_, _| text("ok"))).await;
    sample(&w, json!({ "messages": [say("hi")] }))
        .await
        .unwrap();
    let rows: Vec<Option<String>> = w
        .store
        .transaction(|tx| {
            let mut st = tx.prepare("SELECT plugin FROM usage")?;
            let rows = st
                .query_map([], |r| r.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .unwrap();
    assert_eq!(rows, vec![Some("notes".to_string())]);
}

#[tokio::test]
async fn background_sampling_keeps_the_chats_half() {
    // "groq" is a ladder row with 1000 requests a day.
    let w = world("groq", vec!["big-70b"], true, Arc::new(|_, _| text("ok"))).await;
    sample(&w, json!({ "messages": [say("hi")] }))
        .await
        .unwrap();
    for _ in 0..500 {
        w.store
            .record_request("groq", alexia_store::now_ms())
            .unwrap();
    }
    let before = models_asked(&w).len();
    let err = sample(&w, json!({ "messages": [say("hi")] }))
        .await
        .unwrap_err();
    assert!(
        err.message.contains("kept for your chat"),
        "{}",
        err.message
    );
    assert!(err.message.contains("groq"), "{}", err.message);
    assert_eq!(
        models_asked(&w).len(),
        before,
        "the chat's half was not touched"
    );
}

#[tokio::test]
async fn lengths_send_each_model_its_size() {
    let w = world(
        "p",
        vec!["big-70b", "tiny-3b"],
        true,
        Arc::new(|req, _| text(req.system.as_deref().unwrap_or_default())),
    )
    .await;
    let lengths = |hear: Option<&str>| {
        let mut l = json!({ "high": "the long one", "medium": "the middle one", "small": "short" });
        if let Some(h) = hear {
            l["hear"] = json!(h);
        }
        json!({ "messages": [say("hello")], "systemPrompt": "ignored",
                "_meta": { "alexia/lengths": l } })
    };
    let small = sample(&w, lengths(Some("small"))).await.unwrap();
    assert_eq!(reply_text(&small), "short");
    assert_eq!(small["model"], "tiny-3b");
    let told = &small["_meta"]["alexia/lengths"];
    assert_eq!(told["sent"], "small");
    assert_eq!(told["asked"], "small");
    assert_eq!(told["matched"], true);
    assert_eq!(told["paid"], false);
    let medium = sample(&w, lengths(Some("medium"))).await.unwrap();
    assert_eq!(reply_text(&medium), "the middle one");
    assert_eq!(medium["model"], "big-70b");
    // Nobody is paid here, so the full length is out of reach: the nearest is heard, and said.
    let high = sample(&w, lengths(Some("high"))).await.unwrap();
    assert_eq!(high["_meta"]["alexia/lengths"]["matched"], false);
    // As the chat would: whichever model answers is sent the length that model is given.
    let chat = sample(&w, lengths(None)).await.unwrap();
    let want = if chat["model"] == "tiny-3b" {
        "short"
    } else {
        "the middle one"
    };
    assert_eq!(reply_text(&chat), want);
    assert!(chat["_meta"]["alexia/lengths"]["chat"]["model"].is_string());
}

// ---- attachments -----------------------------------------------------------------------

fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = (data.len() as u32).to_be_bytes().to_vec();
    let mut body = kind.to_vec();
    body.extend_from_slice(data);
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32(&body).to_be_bytes());
    out
}

/// A PNG with a `tEXt` chunk that must not survive.
fn png(width: u32, height: u32) -> Vec<u8> {
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut ihdr = width.to_be_bytes().to_vec();
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    out.extend(chunk(b"IHDR", &ihdr));
    out.extend(chunk(b"tEXt", b"Comment\0where I was"));
    out.extend(chunk(b"IDAT", &[0x78, 0x01, 0x00]));
    out.extend(chunk(b"IEND", &[]));
    out
}

async fn pics(
    w: &World,
    op: &'static str,
    params: Value,
) -> Result<Value, alexia_mcp::jsonrpc::RpcError> {
    w.agent
        .attachments(&PluginId("pics".into()), AttachmentsCall { op, params })
        .await
}

#[tokio::test]
async fn attachment_lease_round_trip() {
    let w = world("p", vec!["big-70b"], true, Arc::new(|_, _| text("x"))).await;
    let session = w.store.create_session(Some("edit")).unwrap();
    let conversation = session.0.to_string();
    let own = w.layout.own_dir("pics");
    std::fs::create_dir_all(&own).unwrap();
    let file = own.join("edit.png");
    std::fs::write(&file, png(4, 3)).unwrap();
    let path = file.to_string_lossy().into_owned();

    let made = pics(
        &w,
        "register",
        json!({ "conversationId": conversation, "path": path, "origin": "approved_result", "name": "C:\\pics\\edit.png" }),
    )
    .await
    .unwrap();
    assert_eq!(made["label"], "image_1");
    assert_eq!(made["displayName"], "edit.png");
    assert_eq!(made["mime"], "image/png");
    assert_eq!(made["dimensions"], json!({ "width": 4, "height": 3 }));
    let id = made["id"].as_str().unwrap().to_owned();
    // The next picture takes the next label, never a reused one.
    let second = pics(
        &w,
        "register",
        json!({ "conversationId": conversation, "path": path, "origin": "normalized" }),
    )
    .await
    .unwrap();
    assert_eq!(second["label"], "image_2");

    let lease = pics(
        &w,
        "lease",
        json!({ "conversationId": conversation, "attachmentIds": [id] }),
    )
    .await
    .unwrap();
    assert_eq!(lease["version"], "1");
    let leased = &lease["attachments"][0];
    let kept = std::fs::read(leased["path"].as_str().unwrap()).unwrap();
    assert!(kept.starts_with(&[0x89, b'P', b'N', b'G']));
    assert!(
        !kept.windows(4).any(|w| w == b"tEXt"),
        "metadata leaves before anything is kept"
    );
    assert_eq!(leased["sha256"], made["sha256"]);
    let lease_id = lease["leaseId"].as_str().unwrap().to_owned();

    assert_eq!(
        pics(&w, "live", json!({ "leaseId": lease_id }))
            .await
            .unwrap(),
        json!({ "live": true })
    );
    pics(&w, "release", json!({ "leaseId": lease_id }))
        .await
        .unwrap();
    assert_eq!(
        pics(&w, "live", json!({ "leaseId": lease_id }))
            .await
            .unwrap(),
        json!({ "live": false })
    );
    assert_eq!(
        pics(&w, "live", json!({ "leaseId": "lease_nobody" }))
            .await
            .unwrap(),
        json!({ "live": false })
    );

    // A lease ends when a picture in it goes.
    let again = pics(
        &w,
        "lease",
        json!({ "conversationId": conversation, "attachmentIds": [made["id"]] }),
    )
    .await
    .unwrap();
    w.store
        .transaction(|tx| {
            tx.execute(
                "UPDATE attachments SET state = 'revoked' WHERE id = ?",
                (made["id"].as_str().unwrap(),),
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        pics(&w, "live", json!({ "leaseId": again["leaseId"] }))
            .await
            .unwrap(),
        json!({ "live": false })
    );
    let err = pics(
        &w,
        "lease",
        json!({ "conversationId": conversation, "attachmentIds": [made["id"]] }),
    )
    .await
    .unwrap_err();
    assert!(err.message.contains("has been deleted"), "{}", err.message);

    // A conversation reaches only its own pictures.
    let other = w.store.create_session(Some("other")).unwrap().0.to_string();
    let err = pics(
        &w,
        "lease",
        json!({ "conversationId": other, "attachmentIds": [second["id"]] }),
    )
    .await
    .unwrap_err();
    assert!(
        err.message.contains("not in this conversation"),
        "{}",
        err.message
    );
}

#[tokio::test]
async fn attachment_register_refuses_what_is_not_the_plugins_own_picture() {
    let w = world("p", vec!["big-70b"], true, Arc::new(|_, _| text("x"))).await;
    let session = w.store.create_session(Some("edit")).unwrap().0.to_string();
    let own = w.layout.own_dir("pics");
    std::fs::create_dir_all(&own).unwrap();
    let outside = temp();
    std::fs::create_dir_all(&outside).unwrap();
    let stray = outside.join("stray.png");
    std::fs::write(&stray, png(2, 2)).unwrap();
    let register = |path: String, conversation: String| {
        pics(
            &w,
            "register",
            json!({ "conversationId": conversation, "path": path, "origin": "normalized" }),
        )
    };
    // Outside the plugin's own folder.
    let err = register(stray.to_string_lossy().into_owned(), session.clone())
        .await
        .unwrap_err();
    assert!(err.message.contains("own folder"), "{}", err.message);
    // Not a picture, whatever it is called.
    let fake = own.join("fake.png");
    std::fs::write(&fake, b"not a picture at all").unwrap();
    let err = register(fake.to_string_lossy().into_owned(), session.clone())
        .await
        .unwrap_err();
    assert!(
        err.message.contains("not a PNG, JPEG or WebP"),
        "{}",
        err.message
    );
    // A damaged one.
    let mut damaged = png(2, 2);
    let last = damaged.len() - 6;
    damaged[last] ^= 0xff;
    std::fs::write(&fake, &damaged).unwrap();
    assert!(
        register(fake.to_string_lossy().into_owned(), session.clone())
            .await
            .is_err()
    );
    // A conversation that does not exist leaves no file behind.
    std::fs::write(&fake, png(2, 2)).unwrap();
    let err = register(fake.to_string_lossy().into_owned(), "99999".into())
        .await
        .unwrap_err();
    assert!(err.message.contains("does not exist"), "{}", err.message);
    assert!(
        !w.layout.uploads().join("99999").exists()
            || std::fs::read_dir(w.layout.uploads().join("99999"))
                .unwrap()
                .next()
                .is_none()
    );
    // A conversation id is a number, nothing else.
    assert!(register(fake.to_string_lossy().into_owned(), "../x".into())
        .await
        .is_err());
    // There is no link to hand out until the hub serves one.
    let err = pics(
        &w,
        "share",
        json!({ "conversationId": session, "path": "x", "mime": "image/png" }),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, code::CAPABILITY_NOT_AVAILABLE);
    let _ = std::fs::remove_dir_all(&outside);
}
