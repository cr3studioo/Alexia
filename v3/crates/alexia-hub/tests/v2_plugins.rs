// SPDX-License-Identifier: AGPL-3.0-only
//! Every v2 plugin, unchanged, through the Rust host (SP-11, EX-01).
//! Run with `--features v2-conformance` and `ALEXIA_V2_PLUGINS=<v2 checkout>/plugins`.
use alexia_core::agent::{Agent, AgentParts, Task};
use alexia_core::catalog::Catalog;
use alexia_core::chat::Caps;
use alexia_core::checker::Checker;
use alexia_core::free::{Auth, FreeRow};
use alexia_core::router::Router;
use alexia_core::tools::McpTooling;
use alexia_core::{
    Ask, Bus, ChatChunk, ChatDone, ChatRequest, Limits, ModelInfo, Origin, Provider, ProviderError,
    Question, RunEnd, Steer,
};
use alexia_mcp::types::CreateMessageParams;
use alexia_mcp::{
    discover, CallCtx, CallError, HostConfig, HostedTool, McpHost, NoUpcalls, PluginId,
    PluginState, Timings, Upcalls,
};
use alexia_store::{Layout, MessageBody, Role, Store, ToolCall};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn v2_plugins() -> PathBuf {
    match std::env::var_os("ALEXIA_V2_PLUGINS") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => panic!("Set ALEXIA_V2_PLUGINS to a built v2 checkout's plugins folder."),
    }
}

fn node() -> PathBuf {
    std::env::var_os("ALEXIA_NODE").map_or_else(|| PathBuf::from("node"), PathBuf::from)
}

/// A temp dir removed on drop, also when the test fails.
struct Tmp(PathBuf);

impl Drop for Tmp {
    fn drop(&mut self) {
        remove_tree(&self.0);
    }
}

/// Delete `p` without ever following a link (junction or symlink): a link is removed itself.
fn remove_tree(p: &Path) {
    let Ok(meta) = std::fs::symlink_metadata(p) else {
        return;
    };
    if meta.file_type().is_symlink() {
        let _ = std::fs::remove_dir(p).or_else(|_| std::fs::remove_file(p));
    } else if meta.is_dir() {
        for e in std::fs::read_dir(p).into_iter().flatten().flatten() {
            remove_tree(&e.path());
        }
        let _ = std::fs::remove_dir(p);
    } else {
        let _ = std::fs::remove_file(p);
    }
}

fn temp(name: &str) -> Tmp {
    let p = std::env::temp_dir().join(format!("alexia-v2-{}-{name}", std::process::id()));
    remove_tree(&p);
    std::fs::create_dir_all(&p).unwrap();
    Tmp(p)
}

/// A host over `dirs` with every discovered plugin enabled, started.
async fn host(dirs: Vec<PathBuf>, name: &str) -> (Tmp, McpHost, Vec<PluginId>) {
    std::env::set_var("ALEXIA_SECRETS_IN_MEMORY", "1");
    let ids: Vec<PluginId> = dirs
        .iter()
        .flat_map(|d| discover(d))
        .map(|r| {
            PluginId(
                r.unwrap_or_else(|(p, e)| panic!("{}: {e:?}", p.display()))
                    .manifest
                    .id,
            )
        })
        .collect();
    let root = temp(name);
    let cfg = HostConfig {
        layout: Layout::new(root.0.clone()),
        plugin_dirs: dirs,
        node: node(),
        timings: Timings {
            start_ms: 60_000,
            call_ms: 60_000,
            capability_ms: 60_000,
            // A deleted folder is noticed on the next ping; 5 s calls need it faster than 15 s.
            heartbeat_ms: 2_000,
            ..Timings::default()
        },
    };
    let store = Arc::new(Store::open_in_memory().unwrap());
    let host = McpHost::new(cfg, store, Arc::new(NoUpcalls), Arc::new(|_| {}));
    host.start(&ids).await.unwrap();
    (root, host, ids)
}

fn provider(tools: &[HostedTool], pick: impl Fn(&HostedTool) -> bool) -> Option<&PluginId> {
    tools.iter().find(|t| pick(t)).map(|t| &t.plugin)
}

fn args(v: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    v.as_object().unwrap().clone()
}

#[tokio::test]
async fn every_v2_plugin_lists_its_tools() {
    let dir = v2_plugins();
    let found = discover(&dir);
    assert!(!found.is_empty(), "no plugin found in {}", dir.display());
    // A manifest cannot declare tools; `provides` and `commands` are what a tool must serve.
    let declares: Vec<String> = found
        .iter()
        .map(|r| {
            r.as_ref()
                .unwrap_or_else(|(p, e)| panic!("{}: {e:?}", p.display()))
        })
        .filter(|d| !d.manifest.provides.is_empty() || !d.manifest.commands.is_empty())
        .map(|d| d.manifest.id.clone())
        .collect();
    let (_tmp, host, ids) = host(vec![dir], "list").await;
    let tools = host.tools().await;
    let mut bad = vec![];
    println!("{:<16} {:>5}  state", "id", "tools");
    for st in host.plugins() {
        let n = tools.iter().filter(|t| t.plugin == st.id).count();
        println!("{:<16} {:>5}  {:?}", st.id.0, n, st.state);
        let broken = matches!(st.state, PluginState::Refused | PluginState::Unhealthy);
        if n == 0 {
            println!("  (no tools, and its manifest declares none to serve)");
        }
        if (n == 0 && declares.contains(&st.id.0)) || broken {
            let why = st.sentence.clone().unwrap_or_default();
            bad.push(format!(
                "{}: {why} (stderr: {:?})",
                st.id.0,
                host.log(&st.id)
            ));
        }
    }
    assert_eq!(host.plugins().len(), ids.len());
    host.shutdown().await;
    assert!(
        bad.is_empty(),
        "plugins that did not list tools:\n{}",
        bad.join("\n")
    );
}

#[tokio::test]
async fn capability_round_trip() {
    let (_tmp, host, _) = host(vec![v2_plugins()], "cap").await;
    let tools = host.tools().await;
    assert!(
        provider(&tools, |t| t.provides.iter().any(|p| p == "demo.greet")).is_some(),
        "no plugin's tool lists demo.greet"
    );
    let r = host
        .call_capability(
            "demo.greet",
            args(serde_json::json!({"who": "Sam"})),
            CallCtx::default(),
        )
        .await
        .unwrap();
    let text = serde_json::to_string(&r.content).unwrap();
    assert!(text.contains("Sam"), "{text}");
    host.shutdown().await;
}

#[tokio::test]
async fn a_crashing_plugin_is_contained() {
    let (_tmp, host, ids) = host(vec![v2_plugins()], "crash").await;
    let tools = host.tools().await;
    let listed: Vec<PluginId> = ids
        .iter()
        .filter(|i| tools.iter().any(|t| t.plugin == **i))
        .cloned()
        .collect();
    let crasher = provider(&tools, |t| {
        t.tool.name == "exit"
            && t.tool
                .description
                .as_deref()
                .is_some_and(|d| d.contains("Exits"))
    })
    .expect("no plugin has an `exit` tool that exits")
    .clone();
    let r = host
        .call_tool(&crasher, "exit", Default::default(), CallCtx::default())
        .await;
    assert!(matches!(r, Err(CallError::Gone)), "{r:?}");
    let after = host.tools().await;
    for id in listed.iter().filter(|i| **i != crasher) {
        assert!(after.iter().any(|t| t.plugin == *id), "{} vanished", id.0);
    }
    host.shutdown().await;
}

/// `link` → `target`: a directory junction on Windows, a symlink elsewhere.
fn link_dir(link: &Path, target: &Path) {
    #[cfg(windows)]
    let ok = std::process::Command::new("cmd")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(link)
        .arg(target)
        .output()
        .unwrap()
        .status
        .success();
    #[cfg(not(windows))]
    let ok = std::os::unix::fs::symlink(target, link).is_ok();
    assert!(
        ok,
        "could not link {} to {}",
        link.display(),
        target.display()
    );
}

fn copy_without_node_modules(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().map(Result::unwrap) {
        if e.file_name() == "node_modules" {
            continue;
        }
        let dest = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_without_node_modules(&e.path(), &dest);
        } else {
            std::fs::copy(e.path(), dest).unwrap();
        }
    }
}

#[tokio::test]
async fn a_vanishing_plugin_is_removed() {
    // Find the plugin with a `slow` tool using a throwaway host over the original folder.
    let orig = v2_plugins();
    let (_probe_tmp, probe, _) = host(vec![orig.clone()], "vprobe").await;
    let id = provider(&probe.tools().await, |t| t.tool.name == "slow")
        .expect("no plugin has a `slow` tool")
        .clone();
    probe.shutdown().await;
    let src = discover(&orig)
        .into_iter()
        .map(Result::unwrap)
        .find(|d| d.manifest.id == id.0)
        .unwrap()
        .path;

    let plugins = temp("vplugins");
    let copy = plugins.0.join(src.file_name().unwrap());
    copy_without_node_modules(&src, &copy);
    let nm = src.join("node_modules");
    let had_node_modules = nm.exists();
    let entries = |d: &Path| -> usize { std::fs::read_dir(d).map_or(0, |r| r.count()) };
    let count_before = entries(&nm);
    let sdk = nm.join("@alexia").join("sdk");
    let had_sdk = sdk.exists();
    if had_node_modules {
        link_dir(&copy.join("node_modules"), &src.join("node_modules"));
    }

    let (_tmp, host, _) = host(vec![plugins.0.clone()], "vanish").await;
    assert!(
        host.tools().await.iter().any(|t| t.plugin == id),
        "copy did not start"
    );
    let call = {
        let (host, id) = (host.clone(), id.clone());
        tokio::spawn(async move {
            host.call_tool(
                &id,
                "slow",
                args(serde_json::json!({"ms": 5000})),
                CallCtx::default(),
            )
            .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    std::fs::remove_dir_all(&copy).unwrap();
    let r = call.await.unwrap();
    assert!(matches!(r, Err(CallError::Gone)), "{r:?}");
    assert!(
        !host.tools().await.iter().any(|t| t.plugin == id),
        "still listed"
    );
    assert!(!copy.exists(), "copy still there");
    // remove_dir_all must not have followed the junction into the real checkout.
    assert_eq!(nm.exists(), had_node_modules);
    assert_eq!(entries(&nm), count_before, "node_modules was emptied");
    assert_eq!(sdk.exists(), had_sdk, "@alexia/sdk was removed");
    host.shutdown().await;
}

// ---- the Rust agent behind the host (P2-40) ----

type Script = Arc<dyn Fn(&ChatRequest, usize) -> Vec<ChatChunk> + Send + Sync>;

struct FakeModel {
    script: Script,
    seen: Arc<Mutex<Vec<ChatRequest>>>,
}

#[async_trait::async_trait]
impl Provider for FakeModel {
    fn id(&self) -> &str {
        "fake"
    }
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(vec![ModelInfo {
            id: "big-70b".into(),
            context: 32_768,
            free: true,
            tools: true,
            vision: false,
        }])
    }
    async fn chat(
        &self,
        req: &ChatRequest,
        model: &str,
        out: mpsc::Sender<ChatChunk>,
        _: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        self.seen.lock().unwrap().push(req.clone());
        // Which model turn this is: how many assistant turns the request already holds.
        let turn = req
            .messages
            .iter()
            .filter(|(r, _)| *r == Role::Assistant)
            .count();
        for c in (self.script)(req, turn) {
            let _ = out.send(c).await;
        }
        Ok(ChatDone {
            model: model.into(),
            provider: "fake".into(),
            tokens_in: 1,
            tokens_out: 1,
            cost: 0.0,
            first_byte_ms: None,
        })
    }
}

struct YesAsk;

#[async_trait::async_trait]
impl Ask for YesAsk {
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

struct Rig {
    _tmp: Tmp,
    host: McpHost,
    agent: Arc<Agent>,
    store: Arc<Store>,
    seen: Arc<Mutex<Vec<ChatRequest>>>,
}

/// The agent wired as `alexia-hub` wires it (tooling over the host, the agent as the host's
/// upcalls), a scripted model behind it, and every plugin in `dirs` started.
async fn rig(dirs: Vec<PathBuf>, name: &str, script: Script) -> Rig {
    std::env::set_var("ALEXIA_SECRETS_IN_MEMORY", "1");
    let ids: Vec<PluginId> = dirs
        .iter()
        .flat_map(|d| discover(d))
        .map(|r| {
            PluginId(
                r.unwrap_or_else(|(p, e)| panic!("{}: {e:?}", p.display()))
                    .manifest
                    .id,
            )
        })
        .collect();
    let root = temp(name);
    let seen: Arc<Mutex<Vec<ChatRequest>>> = Arc::default();
    let p: Arc<dyn Provider> = Arc::new(FakeModel {
        script,
        seen: seen.clone(),
    });
    let row = FreeRow {
        id: "fake".into(),
        base_url: "http://fake.invalid/v1".into(),
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
        root.0.join("catalog.json"),
    ));
    catalog.refresh().await;
    let store = Arc::new(Store::open_in_memory().unwrap());
    let router = Arc::new(Router::new(vec![p], catalog, store.clone()));
    let layout = Layout::new(root.0.join("data"));
    let host = McpHost::new(
        HostConfig {
            layout: Layout::new(root.0.join("data")),
            plugin_dirs: dirs,
            node: node(),
            timings: Timings {
                start_ms: 60_000,
                call_ms: 60_000,
                capability_ms: 60_000,
                heartbeat_ms: 2_000,
                ..Timings::default()
            },
        },
        store.clone(),
        Arc::new(NoUpcalls),
        Arc::new(|_| {}),
    );
    let agent = Agent::new(AgentParts {
        router,
        tools: Arc::new(McpTooling::new(host.clone(), vec![])),
        store: store.clone(),
        bus: Bus::new(64),
        ask: Arc::new(YesAsk),
        checker: Arc::new(Checker::new(None)),
        caps: Arc::new(NoCaps),
        layout,
        limits: Limits::default(),
        host: host.clone(),
    });
    host.set_upcalls(agent.clone());
    host.start(&ids).await.unwrap();
    Rig {
        _tmp: root,
        host,
        agent,
        store,
        seen,
    }
}

/// A folder holding copies of the plugins whose manifest ids are `wanted`, found by discovery
/// (node_modules is joined in, not copied). Returns the folder and each copy's path.
fn stage(wanted: &[&str], name: &str) -> (Tmp, Vec<PathBuf>) {
    let orig = v2_plugins();
    let plugins = temp(name);
    let mut copies = vec![];
    for id in wanted {
        let src = discover(&orig)
            .into_iter()
            .map(Result::unwrap)
            .find(|d| d.manifest.id == *id)
            .unwrap_or_else(|| panic!("the checkout has no plugin {id}"))
            .path;
        let copy = plugins.0.join(src.file_name().unwrap());
        copy_without_node_modules(&src, &copy);
        if src.join("node_modules").exists() {
            link_dir(&copy.join("node_modules"), &src.join("node_modules"));
        }
        copies.push(copy);
    }
    (plugins, copies)
}

fn call_of(name: &str, args: Value) -> ChatChunk {
    ChatChunk::ToolCall(ToolCall {
        id: "c1".into(),
        name: name.into(),
        arguments: args.to_string(),
    })
}

fn sampling(meta: Option<Value>) -> CreateMessageParams {
    let mut p = json!({
        "messages": [{"role": "user", "content": {"type": "text", "text": "Greet Sam."}}],
        "maxTokens": 100,
    });
    if let Some(m) = meta {
        p["_meta"] = m;
    }
    serde_json::from_value(p).unwrap()
}

/// `hello` has no tool that calls `sampling/createMessage` (its source has three tools: greet,
/// greeted, warm_up), so this makes the call as a plugin's `ctx.sample` would: `Upcalls::sample`
/// on the agent the host is wired to, with the id of `hello`.
#[tokio::test]
async fn hello_sampling_answers_with_and_without_tools() {
    let (plugins, _) = stage(&["hello"], "hello-plugins");
    let script: Script = Arc::new(|req, _| {
        if req.tools.is_empty() {
            return vec![ChatChunk::Text("Plain answer.".into())];
        }
        if req.messages.last().is_some_and(|(r, _)| *r == Role::Tool) {
            let said = req.messages.last().unwrap().1.content.text();
            return vec![ChatChunk::Text(format!("Tool said: {said}"))];
        }
        let greet = req
            .tools
            .iter()
            .find(|t| t.name.starts_with("hello__") && t.name.ends_with("__greet"))
            .expect("hello's greet tool was not offered to the model")
            .name
            .clone();
        vec![call_of(&greet, json!({"who": "Sam"}))]
    });
    let r = rig(vec![plugins.0.clone()], "hello-rig", script).await;
    let hello = PluginId("hello".into());
    assert!(
        r.host.tools().await.iter().any(|t| t.plugin == hello),
        "hello did not start"
    );
    assert!(
        r.agent.offers(&hello).sampling.is_some(),
        "the agent does not offer sampling to hello"
    );

    let plain = r
        .agent
        .sample(&hello, sampling(None), None, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(plain["content"]["text"], "Plain answer.");
    assert!(r.seen.lock().unwrap()[0].tools.is_empty());

    let with_tools = r
        .agent
        .sample(
            &hello,
            sampling(Some(json!({"alexia/tools": true}))),
            None,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let text = with_tools["content"]["text"].as_str().unwrap();
    assert!(
        text.starts_with("Tool said:") && text.contains("Sam"),
        "{with_tools}"
    );
    // hello's own tool ran through the host: the greeting is counted in its storage.
    let counted = r
        .host
        .call_tool(&hello, "greeted", Default::default(), CallCtx::default())
        .await
        .unwrap();
    assert!(
        serde_json::to_string(&counted.content)
            .unwrap()
            .contains('1'),
        "{counted:?}"
    );
    r.host.shutdown().await;
}

/// Invariant 4 under the agent: the folder goes between a step's plan and its call, the next
/// step's request has no tool of that plugin, and the run still answers.
#[tokio::test]
async fn agent_replans_around_a_vanished_plugin() {
    let (plugins, copies) = stage(&["vanisher", "hello"], "agent-vanish");
    let gone = copies[0].clone();
    let script: Script = Arc::new(move |req, turn| {
        if turn > 0 {
            return vec![ChatChunk::Text("Carried on without it.".into())];
        }
        let slow = req
            .tools
            .iter()
            .find(|t| t.name.starts_with("vanisher__") && t.name.ends_with("__slow"))
            .expect("vanisher's slow tool was not offered")
            .name
            .clone();
        remove_tree(&gone);
        vec![call_of(&slow, json!({"ms": 20_000}))]
    });
    let r = rig(vec![plugins.0.clone()], "agent-vanish-rig", script).await;
    let session = r.store.create_session(None).unwrap();
    let body: MessageBody = serde_json::from_value(json!({"content": "Be slow."})).unwrap();
    r.store.append(session, Role::User, None, &body).unwrap();
    let messages = r
        .store
        .history(session, None)
        .unwrap()
        .into_iter()
        .map(|m| (m.role, m.body))
        .collect();
    let task = Task {
        session,
        origin: Origin::Desktop,
        messages,
        standing: Vec::new(),
        background: false,
        plugin: None,
        run: None,
        parent: None,
        max_steps: None,
        steer: Steer::none(),
        steps_done: None,
    };
    let (tx, mut rx) = mpsc::channel(256);
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(90),
        r.agent.run(task, tx, CancellationToken::new()),
    )
    .await
    .expect("the run did not finish")
    .expect("the run failed");
    assert!(matches!(result.end, RunEnd::Answered), "{:?}", result.end);
    assert_eq!(result.text, "Carried on without it.");

    let seen = r.seen.lock().unwrap().clone();
    let vanisher_tools = |req: &ChatRequest| {
        req.tools
            .iter()
            .filter(|t| t.name.starts_with("vanisher__"))
            .count()
    };
    assert!(vanisher_tools(&seen[0]) > 0);
    let last = seen.last().unwrap();
    assert_eq!(
        vanisher_tools(last),
        0,
        "the next request still lists vanisher"
    );
    assert!(
        last.tools.iter().any(|t| t.name.starts_with("hello__")),
        "the other plugin's tools went with it"
    );
    r.host.shutdown().await;
}
