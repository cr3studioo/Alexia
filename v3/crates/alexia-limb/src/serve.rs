// SPDX-License-Identifier: AGPL-3.0-only
//! The limb's MCP server face (D-P4-4): every enabled plugin's tools, as `<plugin>.<tool>`,
//! plus the limb's own `device.presence`, served to the hub over one link.
//!
//! Requests are handled concurrently; each `tools/call` can be cancelled by the hub with
//! `notifications/cancelled`. Line contents are conversations and are never logged.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use alexia_mcp::jsonrpc::{
    code, Id, Message, Notification, Outcome, Request, Response, RpcError, V2,
};
use alexia_mcp::types::{
    CallToolParams, CallToolResult, CancelledParams, ProgressParams, ProgressToken, Tool,
    ToolAnnotations,
};
use alexia_mcp::{CallCtx, CallError, EventSink, McpHost, PluginEvent, PluginId, MCP_REVISIONS};
use alexia_mesh::link::Link;
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

/// The limb's own tool, and the capability it provides.
pub const PRESENCE_TOOL: &str = "device.presence";
/// Progress frames held per call before the plugin's side waits.
const PROGRESS_HELD: usize = 16;

/// What the limb says about the device it runs on, and where tool-list changes arrive.
pub struct Facts {
    pub device_name: String,
    pub platform: &'static str,
    /// Fed by [`sink`]: one `()` per change to the tools a link would list.
    pub changes: broadcast::Sender<()>,
}

/// The host's event sink: each event that changes what `tools/list` answers becomes one `()`
/// on `changes`, which every link being served turns into `notifications/tools/list_changed`.
pub fn sink(changes: broadcast::Sender<()>) -> EventSink {
    Arc::new(move |event| {
        tracing::info!("{event:?}");
        if matches!(
            event,
            PluginEvent::ToolsChanged { .. }
                | PluginEvent::Removed { .. }
                | PluginEvent::Unhealthy { .. }
                | PluginEvent::Refused { .. }
                | PluginEvent::Stopped {
                    reason: alexia_mcp::StopReason::Disabled,
                    ..
                }
        ) {
            let _ = changes.send(());
        }
    })
}

type Calls = Arc<Mutex<HashMap<Id, CancellationToken>>>;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn line(m: &impl Serialize) -> String {
    serde_json::to_string(m).expect("a JSON-RPC message serializes")
}

/// Serve one link as an MCP server (revision 2025-11-25) until it closes.
pub async fn serve(link: Link, host: McpHost, facts: Facts) {
    let Link { mut rx, tx, closed } = link;
    let facts = Arc::new(facts);
    let calls: Calls = Arc::default();
    // Every call in flight ends with the link.
    let stop = CancellationToken::new();
    let _stop = stop.clone().drop_guard();
    // `facts` holds a sender, so this never reports Closed while the loop runs.
    let mut changes = facts.changes.subscribe();
    loop {
        tokio::select! {
            () = closed.cancelled() => break,
            changed = changes.recv() => {
                if let Err(broadcast::error::RecvError::Closed) = changed {
                    break;
                }
                let n = Notification {
                    jsonrpc: V2,
                    method: "notifications/tools/list_changed".into(),
                    params: None,
                };
                if tx.send(line(&n)).await.is_err() {
                    break;
                }
            }
            got = rx.recv() => {
                let Some(text) = got else { break };
                match serde_json::from_str::<Message>(&text) {
                    Ok(Message::Request(req)) => {
                        let cancel = stop.child_token();
                        lock(&calls).insert(req.id.clone(), cancel.clone());
                        let (host, facts, tx, calls) =
                            (host.clone(), facts.clone(), tx.clone(), calls.clone());
                        tokio::spawn(async move {
                            let id = req.id.clone();
                            let outcome = answer(&host, &facts, req, cancel, &tx).await;
                            lock(&calls).remove(&id);
                            if let Some(outcome) = outcome {
                                let r = Response { jsonrpc: V2, id, outcome };
                                let _ = tx.send(line(&r)).await;
                            }
                        });
                    }
                    Ok(Message::Notification(n)) if n.method == "notifications/cancelled" => {
                        let params = n.params.and_then(|p| {
                            serde_json::from_value::<CancelledParams>(p).ok()
                        });
                        if let Some(p) = params {
                            if let Some(c) = lock(&calls).get(&p.request_id) {
                                c.cancel();
                            }
                        }
                    }
                    // `notifications/initialized` and anything newer; answers to nothing we asked.
                    Ok(_) => {}
                    Err(_) => tracing::warn!("the hub sent a line that is not JSON-RPC; dropped"),
                }
            }
        }
    }
}

/// One request's outcome; None when it was cancelled (a cancelled request gets no answer).
async fn answer(
    host: &McpHost,
    facts: &Facts,
    req: Request,
    cancel: CancellationToken,
    tx: &mpsc::Sender<String>,
) -> Option<Outcome> {
    Some(match req.method.as_str() {
        "initialize" => Outcome::Result(json!({
            "protocolVersion": MCP_REVISIONS[0],
            "serverInfo": {
                "name": "alexia-limb",
                "title": facts.device_name,
                "version": env!("CARGO_PKG_VERSION"),
            },
            "capabilities": { "tools": { "listChanged": true } },
        })),
        "ping" => Outcome::Result(json!({})),
        "tools/list" => Outcome::Result(json!({ "tools": list(host).await })),
        "tools/call" => {
            let params = req
                .params
                .and_then(|p| serde_json::from_value::<CallToolParams>(p).ok());
            let Some(params) = params else {
                return Some(Outcome::Error(RpcError::new(
                    code::INVALID_PARAMS,
                    "A tool call needs a tool name.",
                )));
            };
            match call(host, facts, params, cancel, tx).await? {
                Ok(result) => Outcome::Result(serde_json::to_value(result).expect("serializes")),
                Err(e) => Outcome::Error(e),
            }
        }
        _ => Outcome::Error(RpcError::method_not_found()),
    })
}

/// Every enabled plugin's visible tools as `<plugin>.<tool>`, then the limb's own.
async fn list(host: &McpHost) -> Vec<Tool> {
    let mut tools: Vec<Tool> = host
        .tools()
        .await
        .into_iter()
        .filter(|t| !t.hidden)
        .map(|t| Tool {
            name: format!("{}.{}", t.plugin.0, t.tool.name),
            ..t.tool
        })
        .collect();
    tools.push(presence_tool());
    tools
}

fn presence_tool() -> Tool {
    let mut meta = Map::new();
    meta.insert("alexia/provides".into(), json!([PRESENCE_TOOL]));
    Tool {
        name: PRESENCE_TOOL.into(),
        title: Some("Presence".into()),
        description: Some(
            "How long since someone last used this device's keyboard or mouse, and whether it is locked."
                .into(),
        ),
        input_schema: json!({ "type": "object", "properties": {} }),
        output_schema: None,
        annotations: Some(ToolAnnotations {
            read_only_hint: Some(true),
            ..Default::default()
        }),
        meta: Some(meta),
    }
}

fn text_result(
    text: String,
    structured: Option<Map<String, Value>>,
    is_error: bool,
) -> CallToolResult {
    CallToolResult {
        content: vec![json!({ "type": "text", "text": text })],
        structured_content: structured,
        is_error: is_error.then_some(true),
        meta: None,
    }
}

async fn presence(facts: &Facts) -> CallToolResult {
    match alexia_mesh::presence::idle_now().await {
        Some(idle) => {
            let secs = idle.idle_ms / 1000;
            let state = if idle.locked { "locked" } else { "unlocked" };
            let mut s = Map::new();
            s.insert("device".into(), json!(facts.device_name));
            s.insert("platform".into(), json!(facts.platform));
            s.insert("idleMs".into(), json!(idle.idle_ms));
            s.insert("locked".into(), json!(idle.locked));
            text_result(
                format!(
                    "{} was last used {secs} s ago and is {state}.",
                    facts.device_name
                ),
                Some(s),
                false,
            )
        }
        None => text_result(
            format!(
                "{} can't tell how long it has been idle.",
                facts.device_name
            ),
            None,
            true,
        ),
    }
}

/// A `tools/call`: the limb's own tool, or `<plugin>.<tool>` routed to the host. The outer
/// None is a cancelled call.
async fn call(
    host: &McpHost,
    facts: &Facts,
    params: CallToolParams,
    cancel: CancellationToken,
    tx: &mpsc::Sender<String>,
) -> Option<Result<CallToolResult, RpcError>> {
    if params.name == PRESENCE_TOOL {
        return tokio::select! {
            () = cancel.cancelled() => None,
            r = presence(facts) => Some(Ok(r)),
        };
    }
    let Some((plugin, tool)) = params.name.split_once('.') else {
        return Some(Err(no_such_tool(&params.name)));
    };
    let mut meta = params.meta.unwrap_or_default();
    // The hub's token; the host puts its own on the request to the plugin.
    let token: Option<ProgressToken> = meta
        .remove("progressToken")
        .and_then(|t| serde_json::from_value(t).ok());
    let (progress, forward) = match token {
        Some(token) => {
            let (sink, frames) = mpsc::channel(PROGRESS_HELD);
            (
                Some(sink),
                Some(tokio::spawn(forward_progress(frames, token, tx.clone()))),
            )
        }
        None => (None, None),
    };
    let ctx = CallCtx {
        conversation: None,
        progress,
        cancel,
        meta,
    };
    let args = params.arguments.unwrap_or_default();
    let result = host
        .call_tool(&PluginId(plugin.into()), tool, args, ctx)
        .await;
    if let Some(forward) = forward {
        // Frames sent before the answer go out before it. The sink is gone with the call.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), forward).await;
    }
    match result {
        Ok(r) => Some(Ok(r)),
        Err(CallError::Cancelled) => None,
        Err(CallError::Rpc(e)) => Some(Err(e)),
        Err(CallError::Off { sentence }) => Some(Err(internal(if sentence.is_empty() {
            "That plugin is not running on this device.".into()
        } else {
            sentence
        }))),
        Err(CallError::Timeout) => Some(Err(internal(
            "The plugin on this device did not answer in time.".into(),
        ))),
        Err(CallError::Gone) => Some(Err(internal(
            "The plugin on this device stopped while answering.".into(),
        ))),
    }
}

fn internal(sentence: String) -> RpcError {
    RpcError::new(code::INTERNAL_ERROR, sentence)
}

fn no_such_tool(name: &str) -> RpcError {
    RpcError::new(
        code::INVALID_PARAMS,
        format!("This device has no tool called {name}."),
    )
}

/// The plugin's progress frames, to the hub under the hub's own token.
async fn forward_progress(
    mut frames: mpsc::Receiver<ProgressParams>,
    token: ProgressToken,
    tx: mpsc::Sender<String>,
) {
    while let Some(mut frame) = frames.recv().await {
        frame.progress_token = token.clone();
        let n = Notification {
            jsonrpc: V2,
            method: "notifications/progress".into(),
            params: Some(serde_json::to_value(frame).expect("serializes")),
        };
        if tx.send(line(&n)).await.is_err() {
            return;
        }
    }
}
