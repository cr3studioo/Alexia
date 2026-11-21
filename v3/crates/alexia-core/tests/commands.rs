// SPDX-License-Identifier: AGPL-3.0-only
//! P2-25: slash commands. A temp plugin folder holds lazy manifests that declare commands; a
//! fake `Tooling` records the calls; no model runs. `/undo` is not called here: its behaviour
//! belongs to P2-28, and `/compare`'s two-answer behaviour to P2-36 (only the keep rule is
//! tested, against two fake providers).

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use alexia_core::agent::{Agent, AgentParts};
use alexia_core::bus::Event;
use alexia_core::catalog::Catalog;
use alexia_core::chat::Caps;
use alexia_core::checker::Checker;
use alexia_core::commands::{list, run};
use alexia_core::free::{Auth, FreeRow};
use alexia_core::router::Router;
use alexia_core::{
    Ask, Bus, ChatChunk, ChatDone, ChatRequest, Limits, ModelInfo, Origin, Provider, ProviderError,
    Question, Steer, ToolCtx, ToolOutcome, ToolSpec, Tooling, Turn,
};
use alexia_mcp::{HostConfig, McpHost, NoUpcalls, Timings};
use alexia_store::{now_ms, Content, Layout, SessionId, Store, Usage};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

type Ran = Arc<Mutex<Vec<(String, Map<String, Value>)>>>;

struct FakeTools {
    ran: Ran,
}

#[async_trait::async_trait]
impl Tooling for FakeTools {
    async fn list(&self) -> Vec<ToolSpec> {
        Vec::new()
    }
    async fn call(&self, name: &str, args: Map<String, Value>, _: ToolCtx) -> ToolOutcome {
        self.ran.lock().unwrap().push((name.into(), args));
        ToolOutcome {
            text: format!("{name} ran"),
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
    asked: Arc<Mutex<Vec<String>>>,
}

#[async_trait::async_trait]
impl Ask for FakeAsk {
    async fn confirm(&self, _: &Origin, q: &Question, _: CancellationToken) -> bool {
        self.asked.lock().unwrap().push(q.text.clone());
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

/// Answers its model's fixed text, or fails when the text is None.
struct Fake {
    id: &'static str,
    answer: Option<&'static str>,
}

#[async_trait::async_trait]
impl Provider for Fake {
    fn id(&self) -> &str {
        self.id
    }
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(vec![ModelInfo {
            id: format!("{}-model", self.id),
            context: 32_768,
            free: true,
            tools: false,
            vision: false,
        }])
    }
    async fn chat(
        &self,
        _: &ChatRequest,
        model: &str,
        out: mpsc::Sender<ChatChunk>,
        _: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        let Some(a) = self.answer else {
            return Err(ProviderError::Unreachable);
        };
        let _ = out.send(ChatChunk::Text(a.into())).await;
        Ok(ChatDone {
            model: model.into(),
            provider: self.id.into(),
            tokens_in: 1,
            tokens_out: 1,
            cost: 0.0,
            first_byte_ms: None,
        })
    }
}

struct World {
    agent: Arc<Agent>,
    store: Arc<Store>,
    ran: Ran,
    asked: Arc<Mutex<Vec<String>>>,
    host: McpHost,
    root: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn temp() -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "alexia-commands-test-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ))
}

/// `plugins`: (id, [(command, summary)]). Lazy manifests: nothing is started.
async fn world(plugins: &[(&str, &[(&str, &str)])], fakes: Vec<Fake>, yes: bool) -> World {
    let root = temp();
    let ext = root.join("ext");
    std::fs::create_dir_all(&ext).unwrap();
    for (id, commands) in plugins {
        let dir = ext.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plugin.js"), "").unwrap();
        let commands: Vec<Value> = commands
            .iter()
            .map(|(n, s)| json!({ "name": n, "summary": s }))
            .collect();
        let m = json!({
            "manifest_version": 1, "id": id, "name": format!("Plugin {id}"),
            "summary": "A plugin that exists for tests.", "version": "0.1.0",
            "license": "AGPL-3.0-only", "entry": { "run": "node", "args": ["plugin.js"] },
            "alexia_protocol": 2, "mcp_protocol": "2025-11-25", "commands": commands
        });
        std::fs::write(dir.join("plugin.json"), m.to_string()).unwrap();
    }
    let rows = fakes
        .iter()
        .map(|f| FreeRow {
            id: f.id.into(),
            base_url: format!("http://{}.invalid/v1", f.id),
            models_path: Some("/models".into()),
            headers: Vec::new(),
            auth: Auth::Optional,
            all_free: true,
            rpm: None,
            rpd: None,
            router: false,
        })
        .collect();
    let providers: Vec<Arc<dyn Provider>> = fakes
        .into_iter()
        .map(|f| Arc::new(f) as Arc<dyn Provider>)
        .collect();
    let catalog = Arc::new(Catalog::new(
        providers.clone(),
        rows,
        root.join("catalog.json"),
    ));
    catalog.refresh().await;
    let store = Arc::new(Store::open_in_memory().unwrap());
    let router = Arc::new(Router::new(providers, catalog, store.clone()));
    let host = McpHost::new(
        HostConfig {
            layout: Layout::new(root.join("data")),
            plugin_dirs: vec![ext],
            node: PathBuf::from("node"),
            timings: Timings::default(),
        },
        store.clone(),
        Arc::new(NoUpcalls),
        Arc::new(|_| {}),
    );
    let ids: Vec<alexia_mcp::PluginId> = plugins
        .iter()
        .map(|(id, _)| alexia_mcp::PluginId((*id).into()))
        .collect();
    host.start(&ids).await.unwrap();
    let ran = Ran::default();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let agent = Agent::new(AgentParts {
        router,
        tools: Arc::new(FakeTools { ran: ran.clone() }),
        store: store.clone(),
        bus: Bus::new(64),
        ask: Arc::new(FakeAsk {
            yes,
            asked: asked.clone(),
        }),
        checker: Arc::new(Checker::new(None)),
        caps: Arc::new(NoCaps),
        layout: Layout::new(root.join("data")),
        limits: Limits::default(),
        host: host.clone(),
    });
    World {
        agent,
        store,
        ran,
        asked,
        host,
        root,
    }
}

fn turn(session: SessionId, origin: Origin, text: &str) -> Turn {
    Turn {
        session,
        origin,
        content: Content::Text(text.into()),
        files: Vec::new(),
        received_at: now_ms(),
        steer: Steer::none(),
    }
}

async fn say(w: &World, origin: Origin, session: SessionId, text: &str) -> String {
    run(
        &w.agent,
        &turn(session, origin, text),
        CancellationToken::new(),
    )
    .await
    .unwrap()
    .text
}

async fn desk(w: &World, text: &str) -> String {
    let s = w.store.create_session(None).unwrap();
    say(w, Origin::Desktop, s, text).await
}

fn telegram(chat: &str) -> Origin {
    Origin::Channel {
        channel: "telegram".into(),
        chat: chat.into(),
    }
}

#[tokio::test]
async fn help_lists_builtins_and_plugins() {
    let w = world(&[("alpha", &[("greet", "Say hello.")])], vec![], true).await;
    let help = desk(&w, "/help").await;
    for built in [
        "/new",
        "/help",
        "/status",
        "/providers",
        "/approvals",
        "/approve",
        "/deny",
        "/undo",
        "/activity",
        "/compare",
        "/models",
    ] {
        assert!(help.contains(built), "{built} missing from:\n{help}");
    }
    assert!(help.contains("/greet — Say hello."), "{help}");
    w.host.shutdown().await;
}

#[tokio::test]
async fn collision_shadowed_alias_works() {
    let w = world(
        &[
            (
                "alpha",
                &[("status", "Alpha status."), ("ping", "Alpha ping.")],
            ),
            ("beta", &[("ping", "Beta ping.")]),
        ],
        vec![],
        true,
    )
    .await;
    // list(): a built-in name and an earlier plugin's name are both taken.
    let manifests: Vec<_> = w
        .agent
        .host()
        .manifests()
        .into_iter()
        .map(|d| d.manifest)
        .collect();
    let all = list(&manifests);
    let status = all.iter().find(|c| c.name == "alpha.status").unwrap();
    assert!(status.shadowed);
    assert_eq!(status.alias.as_deref(), Some("alpha.status"));
    let ping = all.iter().find(|c| c.name == "ping").unwrap();
    assert!(!ping.shadowed);
    assert_eq!(ping.plugin.as_ref().unwrap().0, "alpha");
    let beta = all.iter().find(|c| c.name == "beta.ping").unwrap();
    assert!(beta.shadowed);

    // The bare word goes to the winner, the namespaced form to whoever asks for it.
    assert!(desk(&w, "/status").await.contains("this month"));
    assert!(w.ran.lock().unwrap().is_empty(), "/status must stay core's");
    desk(&w, "/alpha.status").await;
    desk(&w, "/ping").await;
    desk(&w, "/beta.ping").await;
    desk(&w, "/alpha.ping").await;
    let names: Vec<String> = w.ran.lock().unwrap().iter().map(|r| r.0.clone()).collect();
    assert_eq!(
        names,
        ["alpha__status", "alpha__ping", "beta__ping", "alpha__ping"]
    );
    w.host.shutdown().await;
}

#[tokio::test]
async fn new_starts_a_session() {
    let w = world(&[], vec![], true).await;
    let before = w.store.channel_session("telegram", "42").unwrap();
    let said = say(&w, telegram("42"), before, "/new").await;
    assert!(said.contains("new conversation"), "{said}");
    let after = w.store.channel_session("telegram", "42").unwrap();
    assert_ne!(before, after);
    // Another chat is not moved.
    let other = w.store.channel_session("telegram", "43").unwrap();
    assert_ne!(other, after);
    w.host.shutdown().await;
}

#[tokio::test]
async fn status_says_zero_spend() {
    let w = world(&[], vec![], true).await;
    let said = desk(&w, "/status").await;
    assert!(said.contains("$0.00 this month"), "{said}");
    assert!(said.contains("nothing running"), "{said}");
    // A provider that charged shows up.
    w.store
        .record_usage(&Usage {
            at: now_ms(),
            session: None,
            plugin: None,
            model: "m".into(),
            asked: None,
            provider: "p".into(),
            tokens_in: 1,
            tokens_out: 1,
            cost: 0.5,
            run_id: None,
            writing_ms: None,
        })
        .unwrap();
    assert!(desk(&w, "/status").await.contains("$0.50 this month"));
    w.host.shutdown().await;
}

fn open_approval(w: &World) -> i64 {
    w.store
        .approval_open("r1", "telegram:9", "Delete notes.txt?", None, now_ms())
        .unwrap()
}

#[tokio::test]
async fn approve_answers_and_publishes() {
    let w = world(&[], vec![], true).await;
    let id = open_approval(&w);
    let s = w.store.create_session(None).unwrap();
    let listed = say(&w, telegram("9"), s, "/approvals").await;
    assert!(listed.contains(&format!("#{id}")) && listed.contains("Delete notes.txt?"));
    let mut bus = w.agent.parts().bus.subscribe();
    let said = say(&w, telegram("9"), s, &format!("/approve {id}")).await;
    assert!(said.contains("Approved"), "{said}");
    let row = w.store.approval(id).unwrap().unwrap();
    assert_eq!(row.answer, Some(true));
    assert_eq!(row.via.as_deref(), Some("telegram:9"));
    match &*bus.try_recv().expect("an Answered event") {
        Event::Answered {
            approval, answer, ..
        } => assert_eq!((*approval, *answer), (id, true)),
        other => panic!("unexpected event {other:?}"),
    }
    // /deny on another one answers no.
    let id2 = open_approval(&w);
    assert!(say(&w, telegram("9"), s, &format!("/deny {id2}"))
        .await
        .contains("Denied"));
    assert_eq!(w.store.approval(id2).unwrap().unwrap().answer, Some(false));
    w.host.shutdown().await;
}

#[tokio::test]
async fn approve_twice_says_already() {
    let w = world(&[], vec![], true).await;
    let id = open_approval(&w);
    let s = w.store.create_session(None).unwrap();
    say(&w, Origin::Desktop, s, &format!("/approve {id}")).await;
    let mut bus = w.agent.parts().bus.subscribe();
    let said = say(&w, Origin::Desktop, s, &format!("/deny {id}")).await;
    assert!(said.contains("already answered"), "{said}");
    // The first answer stands, and nothing more was published.
    assert_eq!(w.store.approval(id).unwrap().unwrap().answer, Some(true));
    assert!(bus.try_recv().is_err());
    let none = say(&w, Origin::Desktop, s, "/approve 999").await;
    assert!(none.contains("no waiting question #999"), "{none}");
    w.host.shutdown().await;
}

#[tokio::test]
async fn unknown_command_says_so() {
    let w = world(&[], vec![], true).await;
    let said = desk(&w, "/frobnicate now").await;
    assert!(said.contains("There is no /frobnicate"), "{said}");
    assert!(said.contains("/help"));
    w.host.shutdown().await;
}

#[tokio::test]
async fn not_in_v3_yet_sentence() {
    let w = world(&[], vec![], true).await;
    for word in ["local", "combined", "cloud", "nsfw", "sfw", "cheap", "best"] {
        assert_eq!(
            desk(&w, &format!("/{word}")).await,
            "That setting is not in v3 yet.",
            "/{word}"
        );
    }
    w.host.shutdown().await;
}

#[tokio::test]
async fn plugin_command_calls_its_tool() {
    let w = world(&[("alpha", &[("greet", "Say hello.")])], vec![], true).await;
    let s = w.store.create_session(None).unwrap();
    let said = say(&w, Origin::Desktop, s, "/greet to the world").await;
    assert_eq!(said, "alpha__greet ran");
    say(&w, Origin::Desktop, s, "/greet").await;
    {
        let ran = w.ran.lock().unwrap();
        assert_eq!(ran[0].0, "alpha__greet");
        assert_eq!(ran[0].1["rest"], "to the world");
        assert!(ran[1].1.is_empty(), "no words, no `rest`");
    }
    // The turn and the answer are in the session.
    let history = w.store.history(s, None).unwrap();
    assert_eq!(history.len(), 4);
    assert_eq!(history[1].body.content.text(), "alpha__greet ran");
    w.host.shutdown().await;
}

#[tokio::test]
async fn compare_keeps_the_side_that_answered() {
    let fakes = vec![
        Fake {
            id: "good",
            answer: Some("the good answer"),
        },
        Fake {
            id: "bad",
            answer: None,
        },
    ];
    // "Yes" would keep A, but one side failed: only the side that answered can be kept.
    let w = world(&[], fakes, true).await;
    let said = desk(&w, "/compare why is the sky blue").await;
    assert!(said.contains("the good answer"), "{said}");
    assert!(said.starts_with("Kept"), "{said}");
    let asked = w.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 1);
    assert!(
        asked[0].contains("did not answer, so there is nothing to keep"),
        "{}",
        asked[0]
    );
    assert!(!asked[0].contains("Keep A or B?"));
    w.host.shutdown().await;
    // "No" keeps nothing rather than the failed side.
    let fakes = vec![
        Fake {
            id: "good",
            answer: Some("the good answer"),
        },
        Fake {
            id: "bad",
            answer: None,
        },
    ];
    let w = world(&[], fakes, false).await;
    assert_eq!(desk(&w, "/compare again").await, "Kept neither answer.");
    w.host.shutdown().await;
}
