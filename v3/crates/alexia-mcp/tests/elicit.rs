// SPDX-License-Identifier: AGPL-3.0-only
//! P3-35: what the host offers a plugin for elicitation, which tool call an
//! `elicitation/create` belongs to, and the end of that call ending the question. Driven
//! against `mcp-fixture ask` under scratch ids, with a recording `Upcalls`.

mod scratch;
use scratch::Scratch;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alexia_mcp::jsonrpc::RpcError;
use alexia_mcp::types::{
    CallToolResult, ClientCapabilities, CreateMessageParams, ElicitationCaps, Empty, Root,
};
use alexia_mcp::{
    CallCtx, CallError, During, EventSink, HostConfig, HostFacts, McpHost, NoUpcalls, PluginId,
    ProgressSink, Timings, Upcalls,
};
use alexia_store::{secrets, Layout, Store};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

const FIXTURE: &str = env!("CARGO_BIN_EXE_mcp-fixture");
const ID: &str = "scratch-asker";

/// Generous: anything here spawns a process on a possibly loaded machine.
const PATIENCE: Duration = Duration::from_secs(30);

fn plugin(dir: &Path, id: &str) {
    let path = dir.join(id);
    std::fs::create_dir_all(&path).unwrap();
    let exe = Path::new(FIXTURE).file_name().unwrap().to_str().unwrap();
    std::fs::copy(FIXTURE, path.join(exe)).unwrap();
    let m = json!({
        "manifest_version": 1,
        "id": id,
        "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": exe, "args": ["ask"] },
        "alexia_protocol": 13,
        "mcp_protocol": "2025-11-25"
    });
    std::fs::write(path.join("plugin.json"), m.to_string()).unwrap();
}

#[derive(Clone, Copy)]
enum Answer {
    /// Says yes at once.
    Yes,
    /// Waits for the call it came during to end, then says cancel.
    UntilEnded,
}

/// What one `elicit` saw.
struct Seen {
    /// None: no call was in flight. Some(conversation) otherwise.
    during: Option<Option<String>>,
    /// The call's `ended`, or the request's own cancel when there was no call.
    ended: CancellationToken,
}

struct Rec {
    offer: bool,
    answer: Answer,
    seen: Mutex<Vec<Seen>>,
}

impl Rec {
    fn new(offer: bool, answer: Answer) -> Arc<Rec> {
        Arc::new(Rec {
            offer,
            answer,
            seen: Mutex::default(),
        })
    }

    fn count(&self) -> usize {
        self.seen.lock().unwrap().len()
    }

    /// Waits until `n` elicitations have come in.
    async fn wait_for(&self, n: usize) {
        let t = Instant::now();
        while self.count() < n {
            assert!(t.elapsed() < PATIENCE, "no elicitation came");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn during(&self, i: usize) -> Option<Option<String>> {
        self.seen.lock().unwrap()[i].during.clone()
    }

    fn ended(&self, i: usize) -> CancellationToken {
        self.seen.lock().unwrap()[i].ended.clone()
    }
}

#[async_trait::async_trait]
impl Upcalls for Rec {
    fn offers(&self, _: &PluginId) -> ClientCapabilities {
        ClientCapabilities {
            roots: Some(Empty {}),
            elicitation: self.offer.then(|| ElicitationCaps {
                form: Some(Empty {}),
                url: None,
            }),
            ..Default::default()
        }
    }
    fn host_facts(&self) -> HostFacts {
        NoUpcalls.host_facts()
    }
    async fn sample(
        &self,
        p: &PluginId,
        params: CreateMessageParams,
        progress: Option<ProgressSink>,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        NoUpcalls.sample(p, params, progress, cancel).await
    }
    async fn elicit(
        &self,
        _: &PluginId,
        params: Value,
        during: Option<During>,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        assert_eq!(
            params["requestedSchema"]["properties"]["send"]["type"],
            "boolean"
        );
        let ended = during
            .as_ref()
            .map_or_else(|| cancel.clone(), |d| d.ended.clone());
        self.seen.lock().unwrap().push(Seen {
            during: during.as_ref().map(|d| d.conversation.clone()),
            ended: ended.clone(),
        });
        match self.answer {
            Answer::Yes => Ok(json!({ "action": "accept", "content": { "send": true } })),
            Answer::UntilEnded => {
                if during.is_some() {
                    tokio::select! {
                        () = ended.cancelled() => {}
                        () = cancel.cancelled() => {}
                        () = tokio::time::sleep(PATIENCE * 2) => {}
                    }
                }
                Ok(json!({ "action": "cancel" }))
            }
        }
    }
    async fn roots(&self, _: &PluginId) -> Vec<Root> {
        vec![]
    }
}

struct Fx {
    host: McpHost,
    /// Last field: dropped after the host has killed its plugins.
    _root: Scratch,
}

async fn start(tag: &str, up: Arc<Rec>, call_ms: u64) -> Fx {
    std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
    let root = Scratch::new(tag);
    plugin(&root.join("ext"), ID);
    let store = Arc::new(Store::open_in_memory().unwrap());
    let sink: EventSink = Arc::new(|_| {});
    let cfg = HostConfig {
        layout: Layout::new(root.join("data")),
        plugin_dirs: vec![root.join("ext")],
        node: PathBuf::from("node"),
        timings: Timings {
            call_ms,
            ..Timings::default()
        },
    };
    let host = McpHost::new(cfg, store, up, sink);
    host.start(&[id()]).await.unwrap();
    Fx { host, _root: root }
}

fn id() -> PluginId {
    PluginId(ID.into())
}

fn args(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

fn text(r: &CallToolResult) -> String {
    let v = serde_json::to_value(r).unwrap();
    v["content"][0]["text"].as_str().unwrap().to_owned()
}

fn in_chat(conversation: &str) -> CallCtx {
    CallCtx {
        conversation: Some(conversation.into()),
        ..CallCtx::default()
    }
}

async fn caps(fx: &Fx) -> Value {
    let r = fx
        .host
        .call_tool(&id(), "caps", Map::new(), CallCtx::default())
        .await
        .unwrap();
    serde_json::from_str(&text(&r)).unwrap()
}

/// Waits until `t` is cancelled, at most `within`.
async fn cancelled_within(t: &CancellationToken, within: Duration) -> bool {
    tokio::time::timeout(within, t.cancelled()).await.is_ok()
}

#[tokio::test]
async fn form_offered_as_form() {
    let fx = start("elicit-offered", Rec::new(true, Answer::Yes), 120_000).await;
    let c = caps(&fx).await;
    assert_eq!(c["elicitation"], json!({ "form": {} }), "{c}");
    assert!(c["elicitation"].get("url").is_none());

    let fx = start("elicit-not-offered", Rec::new(false, Answer::Yes), 120_000).await;
    let c = caps(&fx).await;
    assert!(c.get("elicitation").is_none(), "{c}");
    assert_eq!(c["roots"], json!({}));
}

#[tokio::test]
async fn during_names_the_call() {
    let rec = Rec::new(true, Answer::Yes);
    let fx = start("elicit-during", rec.clone(), 120_000).await;
    let r = fx
        .host
        .call_tool(
            &id(),
            "ask",
            args(json!({ "message": "Send it?" })),
            in_chat("7"),
        )
        .await
        .unwrap();
    let answer: Value = serde_json::from_str(&text(&r)).unwrap();
    assert_eq!(
        answer,
        json!({ "action": "accept", "content": { "send": true } })
    );
    assert_eq!(rec.during(0), Some(Some("7".into())));
    assert!(
        rec.ended(0).is_cancelled(),
        "the call is over, so its `ended` has fired"
    );

    // A call without a conversation still names the call.
    fx.host
        .call_tool(
            &id(),
            "ask",
            args(json!({ "message": "And this?" })),
            CallCtx::default(),
        )
        .await
        .unwrap();
    assert_eq!(rec.during(1), Some(None));

    // Asked outside any call: no `During`.
    let r = fx
        .host
        .call_tool(
            &id(),
            "ask_late",
            args(json!({ "message": "Later?", "after_ms": 200 })),
            in_chat("8"),
        )
        .await
        .unwrap();
    assert_eq!(text(&r), "asked later");
    rec.wait_for(3).await;
    assert_eq!(rec.during(2), None);
}

#[tokio::test]
async fn call_end_ends_the_question() {
    let rec = Rec::new(true, Answer::UntilEnded);
    // Every call gets 300 ms. Start the plugin first, so the timed call is only the ask.
    let fx = start("elicit-call-end", rec.clone(), 300).await;
    let mut started = false;
    for _ in 0..20 {
        if fx
            .host
            .call_tool(&id(), "caps", Map::new(), CallCtx::default())
            .await
            .is_ok()
        {
            started = true;
            break;
        }
    }
    assert!(started, "the fixture never answered caps within 300 ms");

    let got = fx
        .host
        .call_tool(
            &id(),
            "ask",
            args(json!({ "message": "Send it?" })),
            in_chat("7"),
        )
        .await;
    assert!(matches!(got, Err(CallError::Timeout)), "{got:?}");
    let timed_out = Instant::now();
    // The question came while the call was alive, and ended with it.
    rec.wait_for(1).await;
    assert_eq!(rec.during(0), Some(Some("7".into())));
    assert!(
        cancelled_within(&rec.ended(0), Duration::from_secs(1)).await,
        "`ended` did not fire within 1 s of the timeout"
    );
    assert!(timed_out.elapsed() < Duration::from_secs(1) + PATIENCE);
}

#[tokio::test]
async fn cancel_ends_the_question() {
    let rec = Rec::new(true, Answer::UntilEnded);
    let fx = start("elicit-cancel", rec.clone(), 120_000).await;
    let cancel = CancellationToken::new();
    let ctx = CallCtx {
        conversation: Some("7".into()),
        cancel: cancel.clone(),
        ..CallCtx::default()
    };
    let host = fx.host.clone();
    let call = tokio::spawn(async move {
        host.call_tool(&id(), "ask", args(json!({ "message": "Send it?" })), ctx)
            .await
    });
    rec.wait_for(1).await;
    let ended = rec.ended(0);
    assert!(!ended.is_cancelled(), "the call is still going");
    cancel.cancel();
    assert!(
        cancelled_within(&ended, Duration::from_secs(1)).await,
        "`ended` did not fire within 1 s of the cancel"
    );
    let got = tokio::time::timeout(PATIENCE, call).await.unwrap().unwrap();
    assert!(matches!(got, Err(CallError::Cancelled)), "{got:?}");
}

#[tokio::test]
async fn newest_call_wins() {
    let rec = Rec::new(true, Answer::UntilEnded);
    let fx = start("elicit-newest", rec.clone(), 120_000).await;
    let spawn_ask = |conversation: &str| {
        let host = fx.host.clone();
        let cancel = CancellationToken::new();
        let ctx = CallCtx {
            conversation: Some(conversation.into()),
            cancel: cancel.clone(),
            ..CallCtx::default()
        };
        let call = tokio::spawn(async move {
            host.call_tool(&id(), "ask", args(json!({ "message": "Send it?" })), ctx)
                .await
        });
        (call, cancel)
    };
    let (first, stop_first) = spawn_ask("1");
    rec.wait_for(1).await;
    assert_eq!(rec.during(0), Some(Some("1".into())));
    let (second, stop_second) = spawn_ask("2");
    rec.wait_for(2).await;
    // Both calls are in flight; the newer one is the one the question belongs to.
    assert!(!rec.ended(0).is_cancelled());
    assert_eq!(rec.during(1), Some(Some("2".into())));

    // Ending the second ends only its question.
    stop_second.cancel();
    assert!(cancelled_within(&rec.ended(1), PATIENCE).await);
    assert!(
        !rec.ended(0).is_cancelled(),
        "the first call is still going"
    );
    let got = tokio::time::timeout(PATIENCE, second)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(got, Err(CallError::Cancelled)), "{got:?}");
    stop_first.cancel();
    assert!(cancelled_within(&rec.ended(0), PATIENCE).await);
    let got = tokio::time::timeout(PATIENCE, first)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(got, Err(CallError::Cancelled)), "{got:?}");
}
