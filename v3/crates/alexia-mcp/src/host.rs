// SPDX-License-Identifier: AGPL-3.0-only
//! `McpHost`: load manifests, refuse what cannot run, spawn plugins with the §3.2 handshake,
//! list their tools and call them, supervised (heartbeat, idle, backoff, vanish: `supervise`).
//! Requests a plugin sends under `alexia/*` are answered by `serve`; capability calls are
//! resolved here, by capability name only.

use std::collections::btree_map::Entry;
use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, RwLock, Weak};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use crate::alexia::AlexiaCall;
use crate::conn::{Conn, Incoming};
use crate::jsonrpc::{code, RpcError};
use crate::manifest::{Lifetime, Manifest};
use crate::process::{self, Proc, StderrLog};
use crate::supervise::{self, Busy, CrashLog, Verdict, Watch};
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
    /// Cancelled by `shutdown`: nothing spawns after it.
    closing: CancellationToken,
}

struct Slot {
    dir: PluginDir,
    enabled: bool,
    state: PluginState,
    sentence: Option<String>,
    running: Option<Running>,
    tools: Option<Vec<HostedTool>>,
    /// Bumped whenever `tools` is dropped, so a `tools/list` that was already under way when
    /// the list changed (or the process went) does not put its stale answer back.
    tools_epoch: u64,
    crashes: CrashLog,
    /// Counts processes, so a late exit report from an old one is ignored.
    gen: u64,
    /// The last process's stderr, kept after it stops so `log` still has something to show.
    log: Option<StderrLog>,
    /// Held while spawning or stopping, so two callers never spawn twice.
    spawn: Arc<tokio::sync::Mutex<()>>,
}

struct Running {
    proc: Proc,
    conn: Arc<Conn>,
    gen: u64,
    /// Ends this process's watcher: a stop the host asked for, not a crash.
    stop: CancellationToken,
    busy: Arc<Busy>,
}

impl Slot {
    fn drop_tools(&mut self) {
        self.tools = None;
        self.tools_epoch += 1;
    }
}

/// What a watcher holds, so the host can still be dropped.
pub(crate) struct WeakHost(Weak<Inner>);

impl WeakHost {
    pub(crate) fn upgrade(&self) -> Option<McpHost> {
        self.0.upgrade().map(|inner| McpHost { inner })
    }
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
                closing: CancellationToken::new(),
            }),
        }
    }

    /// Takes effect for the next spawn's `initialize`.
    pub fn set_upcalls(&self, up: Arc<dyn Upcalls>) {
        *self.inner.up.write().unwrap_or_else(|e| e.into_inner()) = up;
    }

    pub(crate) fn upcalls(&self) -> Arc<dyn Upcalls> {
        Arc::clone(&self.inner.up.read().unwrap_or_else(|e| e.into_inner()))
    }

    pub(crate) fn store(&self) -> &alexia_store::Store {
        &self.inner.store
    }

    pub(crate) fn layout(&self) -> &alexia_store::Layout {
        &self.inner.cfg.layout
    }

    pub(crate) fn manifest(&self, id: &PluginId) -> Option<Manifest> {
        lock(&self.inner.plugins)
            .get(id)
            .map(|s| s.dir.manifest.clone())
    }

    /// Test hook: one `alexia/*` request as if plugin `id` had sent it.
    #[doc(hidden)]
    pub async fn serve_for_test(
        &self,
        id: &PluginId,
        method: &str,
        params: Value,
    ) -> Result<Value, RpcError> {
        match AlexiaCall::parse(method, Some(params))? {
            Some(call) => crate::serve::serve(self, id, call).await,
            None => Err(not_alexia(method)),
        }
    }

    fn emit(&self, event: PluginEvent) {
        (self.inner.events)(event);
    }

    /// Scan `plugin_dirs` in order (the first folder holding an id wins), refuse what this
    /// build cannot run, create declared tables, spawn enabled resident plugins.
    pub async fn start(&self, enabled: &[PluginId]) -> Result<(), Error> {
        // Core's containers, made once: a plugin's folders live inside them and the
        // containers outlive every plugin, so a purge can leave nothing behind.
        let layout = &self.inner.cfg.layout;
        std::fs::create_dir_all(layout.root.join("plugins"))?;
        std::fs::create_dir_all(layout.cache())?;
        let enabled: HashSet<&PluginId> = enabled.iter().collect();
        let mut found: BTreeMap<PluginId, PluginDir> = BTreeMap::new();
        for root in &self.inner.cfg.plugin_dirs {
            for entry in crate::manifest::discover(root) {
                match entry {
                    Ok(dir) => match found.entry(PluginId(dir.manifest.id.clone())) {
                        Entry::Occupied(_) => {
                            tracing::info!(folder = %dir.path.display(), "a plugin with this id was already found in an earlier folder; ignored")
                        }
                        Entry::Vacant(v) => {
                            v.insert(dir);
                        }
                    },
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
                tools_epoch: 0,
                crashes: CrashLog::new(&self.inner.cfg.timings),
                gen: 0,
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
            if on {
                // Restart after the supervisor switched it off: a fresh tally.
                slot.crashes.clear();
                if slot.state == PluginState::Unhealthy {
                    slot.state = PluginState::Stopped;
                    slot.sentence = None;
                }
            }
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
            .filter(|(_, s)| {
                s.enabled && !matches!(s.state, PluginState::Refused | PluginState::Unhealthy)
            })
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
        if self.vanished(id) {
            self.vanish(id).await;
            return None;
        }
        if let Some(tools) = lock(&self.inner.plugins).get(id)?.tools.clone() {
            return Some(tools);
        }
        let (conn, busy) = self.ensure_running(id).await.ok()?;
        let _busy = busy.enter();
        let epoch = lock(&self.inner.plugins).get(id)?.tools_epoch;
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
            // A later list_changed (or a new process) wins over this answer.
            if slot.tools_epoch == epoch {
                slot.tools = Some(tools.clone());
            }
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
        let within = Duration::from_millis(self.inner.cfg.timings.call_ms);
        self.call_tool_within(plugin, name, args, ctx, within).await
    }

    async fn call_tool_within(
        &self,
        plugin: &PluginId,
        name: &str,
        args: Map<String, Value>,
        ctx: CallCtx,
        timeout: Duration,
    ) -> Result<CallToolResult, CallError> {
        let off = |sentence: String| CallError::Off { sentence };
        {
            let plugins = lock(&self.inner.plugins);
            let slot = plugins.get(plugin).ok_or_else(|| off(UNKNOWN.into()))?;
            if matches!(slot.state, PluginState::Refused | PluginState::Unhealthy) {
                return Err(off(slot.sentence.clone().unwrap_or_default()));
            }
            if !slot.enabled {
                return Err(off(format!("{} is switched off.", slot.dir.manifest.name)));
            }
        }
        if self.vanished(plugin) {
            self.vanish(plugin).await;
            return Err(CallError::Gone);
        }
        let (conn, busy) = self.ensure_running(plugin).await.map_err(off)?;
        let _busy = busy.enter();

        let mut meta = Map::new();
        if let Some(c) = &ctx.conversation {
            meta.insert("alexia/call-context".into(), json!({ "conversationId": c }));
        }
        meta.extend(ctx.meta);
        let params = CallToolParams {
            name: name.into(),
            arguments: Some(args),
            meta: (!meta.is_empty()).then_some(meta),
        };
        let params = serde_json::to_value(params).expect("serializable");
        let v = conn
            .request(
                "tools/call",
                Some(params),
                ctx.progress,
                &ctx.cancel,
                timeout,
            )
            .await?;
        serde_json::from_value(v).map_err(|_| {
            CallError::Rpc(RpcError::new(
                code::INTERNAL_ERROR,
                "The plugin's answer was not a tool result.",
            ))
        })
    }

    /// By capability name only (INTERFACES.md §2.2): the enabled plugin whose tool lists `cap`
    /// in `_meta["alexia/provides"]`, the one installed first if several do, else by id.
    /// The result is the provider's, unchanged, and never says which plugin answered.
    pub async fn call_capability(
        &self,
        cap: &str,
        args: Map<String, Value>,
        ctx: CallCtx,
    ) -> Result<CallToolResult, CallError> {
        let none = || CallError::Off {
            sentence: format!("Nothing installed and switched on can do {cap}."),
        };
        let candidates: Vec<PluginId> = lock(&self.inner.plugins)
            .iter()
            .filter(|(_, s)| {
                s.enabled
                    && !matches!(s.state, PluginState::Refused | PluginState::Unhealthy)
                    && s.dir.manifest.provides.iter().any(|p| p == cap)
            })
            .map(|(id, _)| id.clone())
            .collect();
        // BTreeMap: already in plugin id order, which breaks ties.
        for id in candidates {
            // The manifest is the promise; the binding is on a running tool (v2 `#binding`).
            let Some(tools) = self.plugin_tools(&id).await else {
                continue;
            };
            let Some(tool) = tools
                .into_iter()
                .find(|t| t.provides.iter().any(|p| p == cap))
            else {
                continue;
            };
            let within = Duration::from_millis(self.inner.cfg.timings.capability_ms);
            return self
                .call_tool_within(&id, &tool.tool.name, args, ctx, within)
                .await
                // Its own sentence would name it.
                .map_err(|e| match e {
                    CallError::Off { .. } => none(),
                    e => e,
                });
        }
        Err(none())
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

    /// `alexia/settings/changed` with only the changed keys, to `id` if it is running.
    pub async fn settings_changed(&self, id: &PluginId, changed: Map<String, Value>) {
        let conn = lock(&self.inner.plugins).get(id).and_then(live_conn);
        if let Some(conn) = conn {
            let params = json!({ "changed": changed });
            if let Err(e) = conn.notify("alexia/settings/changed", Some(params)).await {
                tracing::debug!(plugin = %id.0, "settings/changed not delivered: {e}");
            }
        }
    }

    /// `alexia/conversation/ended` (deliberately empty) to every running plugin; starts none.
    pub async fn conversation_ended(&self) {
        let conns: Vec<(PluginId, Arc<Conn>)> = lock(&self.inner.plugins)
            .iter()
            .filter_map(|(id, s)| live_conn(s).map(|c| (id.clone(), c)))
            .collect();
        for (id, conn) in conns {
            let sent = conn
                .notify("alexia/conversation/ended", Some(json!({})))
                .await;
            if let Err(e) = sent {
                tracing::debug!(plugin = %id.0, "conversation/ended not delivered: {e}");
            }
        }
    }

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

    /// Stop, then remove everything the plugin left: its tables, kv and settings, the
    /// secrets of its `password` settings, its own folder and its cache (invariant check 5).
    pub async fn purge(&self, id: &PluginId) -> Result<(), Error> {
        let m = self
            .manifest(id)
            .ok_or_else(|| Error::UnknownPlugin(id.clone()))?;
        // Off first, as v2: stopped, and a late call cannot respawn it into a half-purged dir.
        self.set_enabled(id, false).await?;
        let ns = m.storage.as_ref().map(|s| s.namespace.as_str());
        self.inner.store.purge(&m.id, ns)?;
        // Every step runs whatever the others do; the first error seen is returned.
        let mut first: Result<(), Error> = Ok(());
        if let Err(e) = alexia_store::secrets::delete_all(&m.id, &m.password_keys()) {
            tracing::warn!(plugin = %m.id, "purge could not clear its secrets: {e}");
            first = Err(e.into());
        }
        let layout = &self.inner.cfg.layout;
        for dir in [layout.own_dir(&m.id), layout.cache().join(&m.id)] {
            match std::fs::remove_dir_all(&dir) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    tracing::warn!(plugin = %m.id, "purge could not remove {}: {e}", dir.display());
                    if first.is_ok() {
                        first = Err(e.into());
                    }
                }
                _ => {}
            }
        }
        first
    }

    pub async fn shutdown(&self) {
        self.inner.closing.cancel();
        let ids: Vec<PluginId> = lock(&self.inner.plugins).keys().cloned().collect();
        let mut set = tokio::task::JoinSet::new();
        for id in ids {
            let host = self.clone();
            set.spawn(async move { host.stop_with(&id, StopReason::Shutdown).await });
        }
        set.join_all().await;
    }

    pub(crate) async fn stop_with(&self, id: &PluginId, reason: StopReason) {
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
            slot.drop_tools();
            slot.running.take()
        };
        let Some(Running {
            proc, conn, stop, ..
        }) = running
        else {
            return;
        };
        stop.cancel();
        // Conn owns stdin: dropping it is what lets the plugin see EOF and leave on its own.
        // ponytail: a call still in flight holds its own `Arc<Conn>`, so stdin stays open and
        // the process is killed after the grace period instead.
        drop(conn);
        process::stop(
            proc,
            Duration::from_millis(self.inner.cfg.timings.exit_grace_ms),
        )
        .await;
        self.emit(PluginEvent::Stopped {
            plugin: id.clone(),
            reason,
        });
    }

    /// The running plugin's connection, spawning and handshaking first if needed, not before
    /// the crash backoff allows. Err is the sentence saying why it is not running.
    async fn ensure_running(&self, id: &PluginId) -> Result<(Arc<Conn>, Arc<Busy>), String> {
        let spawn = lock(&self.inner.plugins)
            .get(id)
            .map(|s| s.spawn.clone())
            .ok_or_else(|| UNKNOWN.to_string())?;
        loop {
            let guard = spawn.lock().await;
            let (dir, dead, wait) = {
                let mut plugins = lock(&self.inner.plugins);
                let slot = plugins.get_mut(id).ok_or_else(|| UNKNOWN.to_string())?;
                if matches!(slot.state, PluginState::Refused | PluginState::Unhealthy) {
                    return Err(slot.sentence.clone().unwrap_or_default());
                }
                if !slot.enabled {
                    return Err(format!("{} is switched off.", slot.dir.manifest.name));
                }
                if self.inner.closing.is_cancelled() {
                    return Err(format!("{} is stopping.", slot.dir.manifest.name));
                }
                match &slot.running {
                    Some(r) if !r.conn.closed().is_cancelled() => {
                        return Ok((Arc::clone(&r.conn), Arc::clone(&r.busy)))
                    }
                    // Exited before its watcher noticed: the same crash, counted here.
                    Some(_) => {
                        let run = slot.running.take().map(|r| (r, self.record_crash(slot)));
                        (slot.dir.clone(), run, Duration::ZERO)
                    }
                    None => (slot.dir.clone(), None, slot.crashes.wait(Instant::now())),
                }
            };
            if let Some((run, after)) = dead {
                self.reap(id, run, false).await;
                self.after_crash(id, after);
                continue; // it may be unhealthy now, or have to wait
            }
            if !wait.is_zero() {
                drop(guard);
                tokio::select! {
                    () = tokio::time::sleep(wait) => {}
                    () = self.inner.closing.cancelled() => {}
                }
                continue;
            }
            return self.spawn_now(id, dir).await;
        }
    }

    /// Spawn and handshake; the caller holds the slot's spawn lock.
    async fn spawn_now(
        &self,
        id: &PluginId,
        dir: PluginDir,
    ) -> Result<(Arc<Conn>, Arc<Busy>), String> {
        let name = dir.manifest.name.clone();
        let fail = |e: &dyn std::fmt::Display| format!("{name} didn't start: {e}");
        let secrets = dir
            .manifest
            .password_keys()
            .iter()
            .filter_map(|k| {
                alexia_store::secrets::get(&dir.manifest.id, k)
                    .ok()
                    .flatten()
            })
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
        let busy = Arc::new(Busy::new());
        let stop = CancellationToken::new();
        let gen = {
            let mut plugins = lock(&self.inner.plugins);
            let Some(slot) = plugins.get_mut(id) else {
                // Removed while starting: dropping `proc` kills it.
                return Err(UNKNOWN.into());
            };
            slot.gen += 1;
            slot.state = PluginState::Running;
            slot.sentence = None;
            slot.log = Some(log);
            slot.drop_tools();
            slot.running = Some(Running {
                proc,
                conn: Arc::clone(&conn),
                gen: slot.gen,
                stop: stop.clone(),
                busy: Arc::clone(&busy),
            });
            slot.gen
        };
        let t = &cfg.timings;
        tokio::spawn(supervise::watch(Watch {
            host: WeakHost(Arc::downgrade(&self.inner)),
            id: id.clone(),
            gen,
            conn: Arc::downgrade(&conn),
            closed: conn.closed(),
            busy: Arc::downgrade(&busy),
            dir: dir.path.clone(),
            lazy: dir.manifest.lifetime() == Lifetime::Lazy,
            heartbeat: Duration::from_millis(t.heartbeat_ms),
            idle: Duration::from_millis(t.idle_ms),
            stop,
        }));
        self.emit(PluginEvent::Started {
            plugin: id.clone(),
            pid,
        });
        Ok((conn, busy))
    }

    /// Records why a start failed (a crash for the tally) and hands the sentence back.
    fn failed(&self, id: &PluginId, sentence: String, log: Option<StderrLog>) -> String {
        let (after, sentence) = {
            let mut plugins = lock(&self.inner.plugins);
            let Some(slot) = plugins.get_mut(id) else {
                return sentence;
            };
            slot.state = PluginState::Stopped;
            slot.sentence = Some(sentence.clone());
            if log.is_some() {
                slot.log = log;
            }
            let after = self.record_crash(slot);
            (after, slot.sentence.clone().unwrap_or(sentence))
        };
        self.after_crash(id, after);
        sentence
    }

    /// The watcher saw process `gen` exit on its own, or stop answering pings (`heartbeat`).
    pub(crate) async fn crashed(&self, id: &PluginId, gen: u64, heartbeat: bool) {
        let taken = {
            let mut plugins = lock(&self.inner.plugins);
            match plugins.get_mut(id) {
                Some(slot) if slot.running.as_ref().is_some_and(|r| r.gen == gen) => {
                    slot.running.take().map(|r| (r, self.record_crash(slot)))
                }
                _ => None,
            }
        };
        if let Some((run, after)) = taken {
            self.reap(id, run, heartbeat).await;
            self.after_crash(id, after);
        }
    }

    /// Kill what is left of a process that ended without being asked to, and say so.
    /// In-flight calls get `Gone` when its stdout closes.
    async fn reap(&self, id: &PluginId, run: Running, heartbeat: bool) {
        let Running {
            proc, conn, stop, ..
        } = run;
        stop.cancel();
        drop(conn);
        let grace = if heartbeat {
            self.emit(PluginEvent::Stopped {
                plugin: id.clone(),
                reason: StopReason::Heartbeat,
            });
            Duration::ZERO
        } else {
            // Its stdout closed: it is on its way out, give it the time to report a code.
            Duration::from_millis(self.inner.cfg.timings.exit_grace_ms)
        };
        let exit_code = process::stop(proc, grace).await;
        self.emit(PluginEvent::Crashed {
            plugin: id.clone(),
            exit_code,
        });
    }

    /// One more crash, counted in the same lock that took the process out, so a caller
    /// arriving meanwhile already sees the backoff.
    fn record_crash(&self, slot: &mut Slot) -> AfterCrash {
        slot.drop_tools();
        match slot.crashes.record(Instant::now()) {
            Verdict::Unhealthy => {
                let t = &self.inner.cfg.timings;
                let sentence = unhealthy_sentence(&slot.dir.manifest.name, t.crash_limit);
                slot.state = PluginState::Unhealthy;
                slot.sentence = Some(sentence.clone());
                AfterCrash::Unhealthy(sentence)
            }
            Verdict::Retry { after_ms } => {
                tracing::info!(plugin = %slot.dir.manifest.id, after_ms, "plugin stopped; it will be started again");
                slot.state = PluginState::Stopped;
                let resident = slot.enabled && slot.dir.manifest.lifetime() == Lifetime::Resident;
                if resident {
                    AfterCrash::Respawn
                } else {
                    AfterCrash::Wait
                }
            }
        }
    }

    /// Switched off at `crash_limit`; otherwise a resident plugin is respawned once the
    /// backoff allows (a lazy one waits for its next use).
    fn after_crash(&self, id: &PluginId, after: AfterCrash) {
        match after {
            AfterCrash::Unhealthy(sentence) => self.emit(PluginEvent::Unhealthy {
                plugin: id.clone(),
                sentence,
            }),
            AfterCrash::Respawn if !self.inner.closing.is_cancelled() => {
                // A plain fn between `ensure_running` and the task that calls it again:
                // spawning from inside its own async call tree would make its type recursive.
                let host = self.clone();
                let id = id.clone();
                tokio::spawn(async move {
                    let _ = host.ensure_running(&id).await;
                });
            }
            _ => {}
        }
    }

    fn vanished(&self, id: &PluginId) -> bool {
        lock(&self.inner.plugins)
            .get(id)
            .is_some_and(|s| supervise::vanished(&s.dir.path))
    }

    /// The folder is gone: kill the process, forget the plugin and its tools.
    pub(crate) async fn vanish(&self, id: &PluginId) {
        let Some(spawn) = lock(&self.inner.plugins).get(id).map(|s| s.spawn.clone()) else {
            return;
        };
        let _g = spawn.lock().await;
        let Some(slot) = lock(&self.inner.plugins).remove(id) else {
            return;
        };
        // Its tools are already gone from `tools()`; the process follows.
        self.emit(PluginEvent::Removed { plugin: id.clone() });
        if let Some(Running {
            proc, conn, stop, ..
        }) = slot.running
        {
            stop.cancel();
            drop(conn);
            process::stop(proc, Duration::ZERO).await;
        }
    }
}

/// v2's wording (supervisor.ts `#crashed`).
fn unhealthy_sentence(name: &str, limit: u32) -> String {
    format!(
        "{name} stopped {limit} times in a minute, so Alexia has switched it off.
Everything else is still running."
    )
}

enum AfterCrash {
    Unhealthy(String),
    Respawn,
    Wait,
}

/// The connection of a plugin that is running right now, if any.
fn live_conn(slot: &Slot) -> Option<Arc<Conn>> {
    slot.running
        .as_ref()
        .filter(|r| !r.conn.closed().is_cancelled())
        .map(|r| Arc::clone(&r.conn))
}

fn not_alexia(method: &str) -> RpcError {
    RpcError::new(
        code::METHOD_NOT_FOUND,
        format!("{method} is not an Alexia method."),
    )
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
            return Err(RpcError::new(
                code::INTERNAL_ERROR,
                "Alexia is shutting down.",
            ));
        };
        if method.starts_with("alexia/") {
            let host = McpHost { inner };
            return match AlexiaCall::parse(&method, params)? {
                Some(call) => crate::serve::serve(&host, &self.id, call).await,
                None => Err(not_alexia(&method)),
            };
        }
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
            slot.drop_tools();
        }
        (inner.events)(PluginEvent::ToolsChanged {
            plugin: self.id.clone(),
        });
    }
}
