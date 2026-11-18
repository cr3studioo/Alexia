// SPDX-License-Identifier: AGPL-3.0-only
//! `McpHost`: load manifests, refuse what cannot run, spawn plugins with the §3.2 handshake,
//! list their tools and call them. Supervision (heartbeat, idle, backoff, vanish) is P0-12;
//! the `alexia/*` layer and capability calls are P0-13.

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, RwLock, Weak};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use crate::conn::{Conn, Incoming};
use crate::jsonrpc::{code, RpcError};
use crate::manifest::Lifetime;
use crate::process::{self, Proc, StderrLog};
use crate::types::{self, CallToolParams, CallToolResult, Implementation, InitializeParams};
use crate::{
    Answers, CallCtx, CallError, Error, EventSink, HostConfig, HostedTool, PluginDir, PluginEvent,
    PluginId, PluginState, PluginStatus, StopReason, Upcalls, APP_VERSION,
};

/// Cheap to clone: everything lives behind one `Arc`.
#[derive(Clone)]
pub struct McpHost {
    inner: Arc<Inner>,
}

struct Inner {
    cfg: HostConfig,
    store: Arc<alexia_store::Store>,
    up: RwLock<Arc<dyn Upcalls>>,
    events: EventSink,
    /// Never held across an `.await`.
    plugins: Mutex<BTreeMap<PluginId, Slot>>,
}

struct Slot {
    dir: PluginDir,
    enabled: bool,
    state: PluginState,
    sentence: Option<String>,
    running: Option<Running>,
    tools: Option<Vec<HostedTool>>,
    /// The last process's stderr, kept after it stops so `log` still has something to show.
    log: Option<StderrLog>,
    /// Held while spawning or stopping, so two callers never spawn twice.
    spawn: Arc<tokio::sync::Mutex<()>>,
}

struct Running {
    proc: Proc,
    conn: Arc<Conn>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

const UNKNOWN: &str = "No plugin with that id is installed.";

impl McpHost {
    pub fn new(
        cfg: HostConfig,
        store: Arc<alexia_store::Store>,
        up: Arc<dyn Upcalls>,
        events: EventSink,
    ) -> McpHost {
        McpHost {
            inner: Arc::new(Inner {
                cfg,
                store,
                up: RwLock::new(up),
                events,
                plugins: Mutex::default(),
            }),
        }
    }

    /// Takes effect for the next spawn's `initialize`.
    pub fn set_upcalls(&self, up: Arc<dyn Upcalls>) {
        *self.inner.up.write().unwrap_or_else(|e| e.into_inner()) = up;
    }

    fn upcalls(&self) -> Arc<dyn Upcalls> {
        Arc::clone(&self.inner.up.read().unwrap_or_else(|e| e.into_inner()))
    }

    fn emit(&self, event: PluginEvent) {
        (self.inner.events)(event);
    }

    /// Scan `plugin_dirs` in order (the first folder holding an id wins), refuse what this
    /// build cannot run, create declared tables, spawn enabled resident plugins.
    pub async fn start(&self, enabled: &[PluginId]) -> Result<(), Error> {
        let enabled: HashSet<&PluginId> = enabled.iter().collect();
        let mut found: BTreeMap<PluginId, PluginDir> = BTreeMap::new();
        for root in &self.inner.cfg.plugin_dirs {
            for entry in crate::manifest::discover(root) {
                match entry {
                    Ok(dir) => {
                        let id = PluginId(dir.manifest.id.clone());
                        if found.contains_key(&id) {
                            tracing::info!(folder = %dir.path.display(), "a plugin with this id was already found in an earlier folder; ignored");
                        } else {
                            found.insert(id, dir);
                        }
                    }
                    // No id is known, so there is nothing to put in a `Refused` event.
                    Err((path, e)) => {
                        tracing::warn!(folder = %path.display(), "{}", e.sentence);
                    }
                }
            }
        }

        let mut resident = vec![];
        for (id, dir) in found {
            let on = enabled.contains(&id);
            let mut slot = Slot {
                enabled: on,
                state: PluginState::Stopped,
                sentence: None,
                running: None,
                tools: None,
                log: None,
                spawn: Arc::default(),
                dir,
            };
            match slot.dir.manifest.compatible() {
                Err(sentence) => refuse(&mut slot, sentence),
                Ok(()) if on => {
                    if let Err(sentence) = self.create_tables(&slot.dir) {
                        refuse(&mut slot, sentence);
                    } else if slot.dir.manifest.lifetime() == Lifetime::Resident {
                        resident.push(id.clone());
                    }
                }
                Ok(()) => {}
            }
            let event = match &slot.sentence {
                Some(sentence) if slot.state == PluginState::Refused => PluginEvent::Refused {
                    plugin: id.clone(),
                    sentence: sentence.clone(),
                },
                _ => PluginEvent::Loaded { plugin: id.clone() },
            };
            lock(&self.inner.plugins).insert(id, slot);
            self.emit(event);
        }

        let mut set = tokio::task::JoinSet::new();
        for id in resident {
            let host = self.clone();
            // A failure is recorded in the plugin's state; `start` itself succeeds.
            set.spawn(async move { host.ensure_running(&id).await.err() });
        }
        set.join_all().await;
        Ok(())
    }

    /// Err is the sentence to refuse the plugin with.
    fn create_tables(&self, dir: &PluginDir) -> Result<(), String> {
        match &dir.manifest.storage {
            Some(s) if !s.tables.is_empty() => self
                .inner
                .store
                .create_tables(&s.namespace, &s.tables)
                .map_err(|e| format!("{} can't keep its data: {e}", dir.manifest.name)),
            _ => Ok(()),
        }
    }

    /// One per loaded plugin (refused ones too, so their sentence can be shown), by id.
    pub fn plugins(&self) -> Vec<PluginStatus> {
        lock(&self.inner.plugins)
            .iter()
            .map(|(id, s)| PluginStatus {
                id: id.clone(),
                name: s.dir.manifest.name.clone(),
                version: s.dir.manifest.version.clone(),
                enabled: s.enabled,
                state: s.state.clone(),
                sentence: s.sentence.clone(),
                provides: s.dir.manifest.provides.clone(),
            })
            .collect()
    }

    /// Persisting `enabled` is the hub's job, not the host's.
    pub async fn set_enabled(&self, id: &PluginId, on: bool) -> Result<(), Error> {
        let (dir, refused) = {
            let mut plugins = lock(&self.inner.plugins);
            let slot = plugins
                .get_mut(id)
                .ok_or_else(|| Error::UnknownPlugin(id.clone()))?;
            slot.enabled = on;
            (slot.dir.clone(), slot.state == PluginState::Refused)
        };
        if !on {
            self.stop_with(id, StopReason::Disabled).await;
            return Ok(());
        }
        if refused {
            return Ok(());
        }
        if let Err(sentence) = self.create_tables(&dir) {
            if let Some(slot) = lock(&self.inner.plugins).get_mut(id) {
                refuse(slot, sentence.clone());
            }
            self.emit(PluginEvent::Refused {
                plugin: id.clone(),
                sentence,
            });
            return Ok(());
        }
        if dir.manifest.lifetime() == Lifetime::Resident {
            // A failed start is in the plugin's state.
            let _ = self.ensure_running(id).await;
        }
        Ok(())
    }

    /// Every enabled, not-refused plugin's tools, spawning lazily; a plugin that fails to
    /// start is left out. Plugins are asked concurrently.
    pub async fn tools(&self) -> Vec<HostedTool> {
        let ids: Vec<PluginId> = lock(&self.inner.plugins)
            .iter()
            .filter(|(_, s)| s.enabled && s.state != PluginState::Refused)
            .map(|(id, _)| id.clone())
            .collect();
        let mut set = tokio::task::JoinSet::new();
        for id in ids {
            let host = self.clone();
            set.spawn(async move { (id.clone(), host.plugin_tools(&id).await) });
        }
        let mut all: Vec<(PluginId, Vec<HostedTool>)> = set
            .join_all()
            .await
            .into_iter()
            .filter_map(|(id, tools)| tools.map(|t| (id, t)))
            .collect();
        all.sort_by(|a, b| a.0.cmp(&b.0));
        all.into_iter().flat_map(|(_, t)| t).collect()
    }

    async fn plugin_tools(&self, id: &PluginId) -> Option<Vec<HostedTool>> {
        if let Some(tools) = lock(&self.inner.plugins).get(id)?.tools.clone() {
            return Some(tools);
        }
        let conn = self.ensure_running(id).await.ok()?;
        let timeout = Duration::from_millis(self.inner.cfg.timings.start_ms);
        let never = CancellationToken::new();
        let (mut tools, mut cursor) = (vec![], None::<String>);
        loop {
            let params = cursor.as_ref().map(|c| json!({ "cursor": c }));
            let page = conn
                .request("tools/list", params, None, &never, timeout)
                .await;
            let page: types::ListToolsResult = match page.map(serde_json::from_value) {
                Ok(Ok(page)) => page,
                Ok(Err(e)) => {
                    tracing::warn!(plugin = %id.0, "tools/list answer unreadable: {e}");
                    return None;
                }
                Err(e) => {
                    tracing::warn!(plugin = %id.0, "tools/list failed: {e}");
                    return None;
                }
            };
            tools.extend(page.tools.into_iter().map(|t| hosted(id, t)));
            match page.next_cursor {
                // A cursor that repeats would loop forever.
                Some(next) if Some(&next) != cursor.as_ref() => cursor = Some(next),
                _ => break,
            }
        }
        if let Some(slot) = lock(&self.inner.plugins).get_mut(id) {
            slot.tools = Some(tools.clone());
        }
        Some(tools)
    }

    pub async fn call_tool(
        &self,
        plugin: &PluginId,
        name: &str,
        args: Map<String, Value>,
        ctx: CallCtx,
    ) -> Result<CallToolResult, CallError> {
        let off = |sentence: String| CallError::Off { sentence };
        {
            let plugins = lock(&self.inner.plugins);
            let slot = plugins.get(plugin).ok_or_else(|| off(UNKNOWN.into()))?;
            if slot.state == PluginState::Refused {
                return Err(off(slot.sentence.clone().unwrap_or_default()));
            }
            if !slot.enabled {
                return Err(off(format!("{} is switched off.", slot.dir.manifest.name)));
            }
        }
        let conn = self.ensure_running(plugin).await.map_err(off)?;

        let mut meta = Map::new();
        if let Some(c) = &ctx.conversation {
            meta.insert(
                "alexia/call-context".into(),
                json!({ "conversationId": c }),
            );
        }
        meta.extend(ctx.meta);
        let params = CallToolParams {
            name: name.into(),
            arguments: Some(args),
            meta: (!meta.is_empty()).then_some(meta),
        };
        let params = serde_json::to_value(params).expect("serializable");
        let timeout = Duration::from_millis(self.inner.cfg.timings.call_ms);
        let v = conn
            .request("tools/call", Some(params), ctx.progress, &ctx.cancel, timeout)
            .await?;
        serde_json::from_value(v).map_err(|_| {
            CallError::Rpc(RpcError::new(
                code::INTERNAL_ERROR,
                "The plugin's answer was not a tool result.",
            ))
        })
    }

    /// P0-13 resolves capabilities; until then nothing answers.
    pub async fn call_capability(
        &self,
        _cap: &str,
        _args: Map<String, Value>,
        _ctx: CallCtx,
    ) -> Result<CallToolResult, CallError> {
        Err(CallError::Off {
            sentence: "Nothing installed and switched on can do that yet.".into(),
        })
    }

    /// From manifests' `provides[]` only, starting nothing. In P0 every plugin is this hub's
    /// own, so `here` is `answers`.
    pub fn answers(&self, cap: &str) -> Answers {
        let found = lock(&self.inner.plugins).values().any(|s| {
            s.enabled
                && s.state != PluginState::Refused
                && s.dir.manifest.provides.iter().any(|p| p == cap)
        });
        Answers {
            answers: found,
            here: found,
        }
    }

    /// P0-13 sends `alexia/settings/changed`.
    pub async fn settings_changed(&self, _id: &PluginId, _changed: Map<String, Value>) {}

    /// P0-13 sends `alexia/conversation/ended`.
    pub async fn conversation_ended(&self) {}

    /// Stop now (D213). Not a crash: the next call respawns.
    pub async fn stop(&self, id: &PluginId) {
        self.stop_with(id, StopReason::Shutdown).await;
    }

    pub fn pid(&self, id: &PluginId) -> Option<u32> {
        lock(&self.inner.plugins)
            .get(id)?
            .running
            .as_ref()
            .map(|r| r.proc.pid)
    }

    /// The last 500 stderr lines, redacted. Empty if the plugin never ran.
    pub fn log(&self, id: &PluginId) -> Vec<String> {
        lock(&self.inner.plugins)
            .get(id)
            .and_then(|s| s.log.as_ref())
            .map(StderrLog::lines)
            .unwrap_or_default()
    }

    /// P0-13 removes the plugin's data.
    pub async fn purge(&self, _id: &PluginId) -> Result<(), Error> {
        Err(Error::Refused(
            "Removing a plugin's data isn't available yet.".into(),
        ))
    }

    pub async fn shutdown(&self) {
        let ids: Vec<PluginId> = lock(&self.inner.plugins).keys().cloned().collect();
        let mut set = tokio::task::JoinSet::new();
        for id in ids {
            let host = self.clone();
            set.spawn(async move { host.stop_with(&id, StopReason::Shutdown).await });
        }
        set.join_all().await;
    }

    async fn stop_with(&self, id: &PluginId, reason: StopReason) {
        let Some(spawn) = lock(&self.inner.plugins).get(id).map(|s| s.spawn.clone()) else {
            return;
        };
        let _g = spawn.lock().await;
        let running = {
            let mut plugins = lock(&self.inner.plugins);
            let Some(slot) = plugins.get_mut(id) else {
                return;
            };
            if slot.state == PluginState::Running {
                slot.state = PluginState::Stopped;
            }
            slot.running.take()
        };
        let Some(Running { proc, conn }) = running else {
            return;
        };
        // Conn owns stdin: dropping it is what lets the plugin see EOF and leave on its own.
        // ponytail: a call still in flight holds its own `Arc<Conn>`, so stdin stays open and
        // the process is killed after the grace period instead.
        drop(conn);
        process::stop(proc, Duration::from_millis(self.inner.cfg.timings.exit_grace_ms)).await;
        self.emit(PluginEvent::Stopped {
            plugin: id.clone(),
            reason,
        });
    }

    /// The running plugin's connection, spawning and handshaking first if needed.
    /// Err is the sentence saying why it is not running.
    async fn ensure_running(&self, id: &PluginId) -> Result<Arc<Conn>, String> {
        let spawn = lock(&self.inner.plugins)
            .get(id)
            .map(|s| s.spawn.clone())
            .ok_or_else(|| UNKNOWN.to_string())?;
        let _g = spawn.lock().await;

        let (dir, dead) = {
            let mut plugins = lock(&self.inner.plugins);
            let slot = plugins.get_mut(id).ok_or_else(|| UNKNOWN.to_string())?;
            if slot.state == PluginState::Refused {
                return Err(slot.sentence.clone().unwrap_or_default());
            }
            if !slot.enabled {
                return Err(format!("{} is switched off.", slot.dir.manifest.name));
            }
            match &slot.running {
                Some(r) if !r.conn.closed().is_cancelled() => return Ok(Arc::clone(&r.conn)),
                // Exited on its own: reap it and start a fresh one (P0-12 adds backoff).
                Some(_) => (slot.dir.clone(), slot.running.take()),
                None => (slot.dir.clone(), None),
            }
        };
        if let Some(Running { proc, conn }) = dead {
            drop(conn);
            process::stop(proc, Duration::ZERO).await;
        }

        let name = dir.manifest.name.clone();
        let fail = |e: &dyn std::fmt::Display| format!("{name} didn't start: {e}");
        let secrets = dir
            .manifest
            .password_keys()
            .iter()
            .filter_map(|k| alexia_store::secrets::get(&dir.manifest.id, k).ok().flatten())
            .collect();
        let cfg = &self.inner.cfg;
        let spawned = process::spawn(&dir, &cfg.layout, &cfg.node, secrets);
        let mut proc = match spawned {
            Ok(proc) => proc,
            Err(e) => return Err(self.failed(id, fail(&e), None)),
        };
        let log = proc.stderr.clone();
        let (Some(stdin), Some(stdout)) = (proc.child.stdin.take(), proc.child.stdout.take())
        else {
            process::stop(proc, Duration::ZERO).await;
            return Err(self.failed(id, fail(&"no stdio"), Some(log)));
        };
        let handler = Arc::new(Handler {
            host: Arc::downgrade(&self.inner),
            id: id.clone(),
        });
        let conn = Arc::new(Conn::start(stdin, stdout, log.clone(), handler));

        let init = InitializeParams {
            protocol_version: dir.manifest.mcp_protocol.clone(),
            client_info: Implementation {
                name: "Alexia".into(),
                version: APP_VERSION.into(),
            },
            capabilities: self.upcalls().offers(id),
        };
        let answer = conn
            .request(
                "initialize",
                Some(serde_json::to_value(init).expect("serializable")),
                None,
                &CancellationToken::new(),
                Duration::from_millis(cfg.timings.start_ms),
            )
            .await;
        let grace = Duration::from_millis(cfg.timings.exit_grace_ms);
        let answer = answer.map_err(|e| fail(&e)).and_then(|v| {
            serde_json::from_value::<types::InitializeResult>(v).map_err(|e| fail(&e))
        });
        let spoken = match answer {
            Ok(r) => r.protocol_version,
            Err(sentence) => {
                drop(conn);
                process::stop(proc, grace).await;
                return Err(self.failed(id, sentence, Some(log)));
            }
        };
        if spoken != dir.manifest.mcp_protocol {
            drop(conn);
            process::stop(proc, grace).await;
            let sentence = mcp_refusal(&name, &spoken);
            if let Some(slot) = lock(&self.inner.plugins).get_mut(id) {
                refuse(slot, sentence.clone());
                slot.log = Some(log);
            }
            self.emit(PluginEvent::Refused {
                plugin: id.clone(),
                sentence: sentence.clone(),
            });
            return Err(sentence);
        }
        let _ = conn.notify("notifications/initialized", None).await;

        let pid = proc.pid;
        if let Some(slot) = lock(&self.inner.plugins).get_mut(id) {
            slot.state = PluginState::Running;
            slot.sentence = None;
            slot.log = Some(log);
            slot.running = Some(Running {
                proc,
                conn: Arc::clone(&conn),
            });
        }
        self.emit(PluginEvent::Started {
            plugin: id.clone(),
            pid,
        });
        Ok(conn)
    }

    /// Records why a start failed and hands the sentence back.
    fn failed(&self, id: &PluginId, sentence: String, log: Option<StderrLog>) -> String {
        if let Some(slot) = lock(&self.inner.plugins).get_mut(id) {
            slot.state = PluginState::Stopped;
            slot.sentence = Some(sentence.clone());
            if log.is_some() {
                slot.log = log;
            }
        }
        sentence
    }
}

fn refuse(slot: &mut Slot, sentence: String) {
    slot.state = PluginState::Refused;
    slot.sentence = Some(sentence);
}

/// v2's `mcpRefusal`, the same words as the manifest check.
fn mcp_refusal(name: &str, speaks: &str) -> String {
    format!(
        "{name} speaks a version of MCP that Alexia doesn't.\nAlexia speaks {}; {name} speaks {speaks}.",
        crate::MCP_REVISIONS.join(" and ")
    )
}

fn hosted(id: &PluginId, tool: types::Tool) -> HostedTool {
    let meta = tool.meta.as_ref();
    let provides = meta
        .and_then(|m| m.get("alexia/provides"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    let hidden =
        meta.is_some_and(|m| m.contains_key("alexia/compute") || m.contains_key("alexia/editor"));
    HostedTool {
        plugin: id.clone(),
        tool,
        provides,
        hidden,
    }
}

/// What one plugin's `Conn` asks of the host. Weak: the host owns the `Conn`.
struct Handler {
    host: Weak<Inner>,
    id: PluginId,
}

#[async_trait::async_trait]
impl Incoming for Handler {
    async fn request(&self, method: String, params: Option<Value>) -> Result<Value, RpcError> {
        let Some(inner) = self.host.upgrade() else {
            return Err(RpcError::new(code::INTERNAL_ERROR, "Alexia is shutting down."));
        };
        let up = Arc::clone(&inner.up.read().unwrap_or_else(|e| e.into_inner()));
        drop(inner);
        match method.as_str() {
            "roots/list" => Ok(json!({ "roots": up.roots(&self.id).await })),
            "sampling/createMessage" => {
                let p = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::new(code::INVALID_PARAMS, e.to_string()))?;
                up.sample(&self.id, p, None, CancellationToken::new()).await
            }
            "elicitation/create" => up.elicit(&self.id, params.unwrap_or(Value::Null)).await,
            m if m.starts_with("alexia/") => Err(RpcError::new(
                code::METHOD_NOT_FOUND,
                format!("{m} is not available yet."),
            )),
            _ => Err(RpcError::method_not_found()),
        }
    }

    async fn notification(&self, method: String, _params: Option<Value>) {
        if method != "notifications/tools/list_changed" {
            return;
        }
        let Some(inner) = self.host.upgrade() else {
            return;
        };
        if let Some(slot) = lock(&inner.plugins).get_mut(&self.id) {
            slot.tools = None;
        }
        (inner.events)(PluginEvent::ToolsChanged {
            plugin: self.id.clone(),
        });
    }
}
