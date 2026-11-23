// SPDX-License-Identifier: AGPL-3.0-only
//! `McpHost`: load manifests, refuse what cannot run, spawn plugins with the §3.2 handshake,
//! list their tools and call them, supervised (heartbeat, idle, backoff, vanish: `supervise`).
//! Requests a plugin sends under `alexia/*` are answered by `serve`; capability calls are
//! resolved here, by capability name only.

use std::collections::btree_map::Entry;
use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, RwLock, Weak};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tokio::process::{ChildStdin, ChildStdout};
use tokio_util::sync::CancellationToken;

use crate::alexia::AlexiaCall;
use crate::conn::{Conn, Incoming};
use crate::jsonrpc::{code, RpcError};
use crate::manifest::{Lifetime, Manifest};
use crate::process::{self, Proc, StderrLog};
use crate::supervise::{self, Busy, BusyGuard, CrashLog, Stamp, Verdict, Watch};
use crate::types::{self, CallToolParams, CallToolResult, Implementation, InitializeParams};
use crate::wasm::{Limits, WasmPlugin};
use crate::{
    Answers, CallCtx, CallError, Error, EventSink, HostConfig, HostedTool, PluginDir, PluginEvent,
    PluginId, PluginState, PluginStatus, ProgressSink, StopReason, Upcalls, APP_VERSION,
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
    /// (P2-62) Stopped while a game runs: nothing in here spawns until `release`. Read with
    /// `plugins` locked (taken after it), where `ensure_running` decides to spawn.
    held: Mutex<HashSet<PluginId>>,
    /// Serializes the read-modify-writes of `_core.unreviewed`, `_core.known_plugins` and
    /// `_core.servers`.
    lists: Mutex<()>,
    /// Folders that are not plugins, and why (v2 `problems`), as the last `start` found them.
    problems: Mutex<Vec<(PathBuf, String)>>,
}

struct Slot {
    dir: PluginDir,
    /// What the folder looked like when `dir.manifest` was read; a difference is a reload.
    stamp: Stamp,
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
    proc: Guest,
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
/// kv `_core` keys: v2's list of plugins whose own word is not believed, and every plugin id
/// this host has seen (P2-62).
const UNREVIEWED: &str = "unreviewed";
const KNOWN: &str = "known_plugins";

fn paused(name: &str) -> String {
    format!("{name} is paused while a game runs.")
}

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
                held: Mutex::default(),
                lists: Mutex::default(),
                problems: Mutex::default(),
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
        self.serve_ctx_for_test(id, method, params, CallCtx::default())
            .await
    }

    /// Test hook: as `serve_for_test`, with the plugin's cancel token and progress sink.
    #[doc(hidden)]
    pub async fn serve_ctx_for_test(
        &self,
        id: &PluginId,
        method: &str,
        params: Value,
        ctx: CallCtx,
    ) -> Result<Value, RpcError> {
        match AlexiaCall::parse(method, Some(params))? {
            Some(call) => crate::serve::serve(self, id, call, ctx).await,
            None => Err(not_alexia(method)),
        }
    }

    fn emit(&self, event: PluginEvent) {
        (self.inner.events)(event);
    }

    /// Every plugin folder in `dirs`, in order; the first folder holding an id wins.
    pub fn scan(dirs: &[std::path::PathBuf]) -> BTreeMap<PluginId, PluginDir> {
        scan_all(dirs).0
    }

    /// Scan `plugin_dirs` with [`McpHost::scan`], refuse what this
    /// build cannot run, create declared tables, spawn enabled resident plugins.
    pub async fn start(&self, enabled: &[PluginId]) -> Result<(), Error> {
        // Core's containers, made once: a plugin's folders live inside them and the
        // containers outlive every plugin, so a purge can leave nothing behind.
        let layout = &self.inner.cfg.layout;
        std::fs::create_dir_all(layout.root.join("plugins"))?;
        std::fs::create_dir_all(layout.cache())?;
        let enabled: HashSet<&PluginId> = enabled.iter().collect();
        let (mut found, mut problems) = scan_all(&self.inner.cfg.plugin_dirs);
        // Added MCP servers (`add_server`): hosted like plugins, behind the folders.
        for server in self.servers() {
            let id = PluginId(server.id.clone());
            if found.contains_key(&id) {
                tracing::info!(plugin = %id.0, "a plugin folder has this server's id; the server is ignored");
                continue;
            }
            match self.server_folder(&server) {
                Ok(dir) => {
                    found.insert(id, dir);
                }
                Err(sentence) => problems.push((self.servers_dir().join(&server.id), sentence)),
            }
        }
        *lock(&self.inner.problems) = problems;
        self.learn(found.keys());

        let mut resident = vec![];
        for (id, dir) in found {
            let (slot, wake) = self.admit(dir, enabled.contains(&id));
            if wake {
                resident.push(id.clone());
            }
            self.insert_slot(id, slot);
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

    /// Every loaded plugin that is enabled and not refused, by id: its folder and manifest.
    /// Reads what `start`/`reload` loaded; spawns nothing.
    pub fn manifests(&self) -> Vec<PluginDir> {
        lock(&self.inner.plugins)
            .values()
            .filter(|s| s.enabled && s.state != PluginState::Refused)
            .map(|s| s.dir.clone())
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
        // v2's list (`servers.ts`): small, so read fresh each time rather than cached with the tools.
        // Fail closed: a list that cannot be read or understood leaves every plugin unreviewed.
        let unreviewed: Option<Vec<String>> = match self.inner.store.kv_get("_core", UNREVIEWED) {
            Ok(None) => Some(vec![]),
            Ok(Some(v)) => match serde_json::from_value(v) {
                Ok(list) => Some(list),
                Err(e) => {
                    tracing::warn!(
                        "the unreviewed list is malformed; every plugin is unreviewed: {e}"
                    );
                    None
                }
            },
            Err(e) => {
                tracing::warn!(
                    "the unreviewed list could not be read; every plugin is unreviewed: {e}"
                );
                None
            }
        };
        // An unreadable or malformed known list is the same: who is new can't be told.
        let known_ok = match self.inner.store.kv_get("_core", KNOWN) {
            Ok(None) => true,
            Ok(Some(v)) => serde_json::from_value::<Vec<String>>(v).is_ok(),
            Err(_) => false,
        };
        let unreviewed = unreviewed.filter(|_| known_ok);
        let mut tools: Vec<HostedTool> = all.into_iter().flat_map(|(_, t)| t).collect();
        for t in &mut tools {
            t.reviewed = unreviewed
                .as_ref()
                .is_some_and(|u| !u.contains(&t.plugin.0));
        }
        tools
    }

    /// EX-12, P2-23: re-read the plugin's folder; let in-flight calls finish; the next call
    /// spawns the new version (a resident plugin is respawned at once). Emits `ToolsChanged`.
    /// A manifest that does not load leaves the old version running and is `Err(Refused)`
    /// with the same sentence in the plugin's status; no `Refused` event.
    pub async fn reload(&self, id: &PluginId) -> Result<(), Error> {
        let spawn = lock(&self.inner.plugins)
            .get(id)
            .map(|s| s.spawn.clone())
            .ok_or_else(|| Error::UnknownPlugin(id.clone()))?;
        // The spawn lock: a spawn under way finishes first, and after the claim below every
        // later `ensure_running` sees `Reloading` and waits.
        let (dir, stamp, busy) = {
            let _g = spawn.lock().await;
            let mut plugins = lock(&self.inner.plugins);
            let slot = plugins
                .get_mut(id)
                .ok_or_else(|| Error::UnknownPlugin(id.clone()))?;
            if slot.state == PluginState::Reloading {
                return Ok(()); // someone else is on it
            }
            let path = slot.dir.path.clone();
            // Stamped before reading, so an edit in between is seen by the next scan.
            let stamp = Stamp::of(&path, &slot.dir.manifest.entry);
            match self.read_new(id, &path, slot.enabled) {
                Err(sentence) => {
                    slot.stamp = stamp;
                    slot.sentence = Some(sentence.clone());
                    return Err(Error::Refused(sentence));
                }
                Ok(dir) => {
                    slot.state = PluginState::Reloading;
                    let busy = slot.running.as_ref().map(|r| Arc::clone(&r.busy));
                    (dir, stamp, busy)
                }
            }
        };
        // In-flight calls run to completion (each is bounded by `call_ms`).
        let deadline = Instant::now() + Duration::from_millis(self.inner.cfg.timings.call_ms);
        while busy
            .as_ref()
            .is_some_and(|b| b.idle_for().is_none() && Instant::now() < deadline)
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        self.stop_with(id, StopReason::Disabled).await;
        let respawn = {
            let mut plugins = lock(&self.inner.plugins);
            let Some(slot) = plugins.get_mut(id) else {
                return Ok(()); // removed meanwhile
            };
            let respawn = slot.enabled && dir.manifest.lifetime() == Lifetime::Resident;
            slot.dir = dir;
            slot.stamp = stamp;
            slot.state = PluginState::Stopped;
            slot.sentence = None;
            // A new version gets a fresh tally; this was not a crash.
            slot.crashes.clear();
            slot.drop_tools();
            respawn
        };
        self.emit(PluginEvent::Loaded { plugin: id.clone() });
        self.emit(PluginEvent::ToolsChanged { plugin: id.clone() });
        if respawn {
            self.after_crash(id, AfterCrash::Respawn);
        }
        Ok(())
    }

    /// The folder's manifest as it is now, with start's checks and the tables made. Err is the
    /// sentence; nothing has been stopped.
    fn read_new(
        &self,
        id: &PluginId,
        path: &std::path::Path,
        enabled: bool,
    ) -> Result<PluginDir, String> {
        let json = std::fs::read_to_string(path.join("plugin.json")).map_err(|_| {
            "This plugin's plugin.json can't be read any more; the old version is still running."
                .to_string()
        })?;
        let manifest = Manifest::parse(&json).map_err(|e| e.sentence)?;
        if manifest.id != id.0 {
            return Err(format!(
                "The new manifest calls the plugin “{}”; the folder and the id must match.",
                manifest.id
            ));
        }
        manifest.compatible()?;
        let dir = PluginDir {
            path: path.to_path_buf(),
            manifest,
        };
        if enabled {
            self.create_tables(&dir)?;
        }
        Ok(dir)
    }

    /// True when the plugin's folder differs from what was loaded (and no reload is under way).
    fn changed(&self, id: &PluginId) -> bool {
        let Some((path, entry, stamp)) = lock(&self.inner.plugins).get(id).and_then(|s| {
            (s.state != PluginState::Reloading).then(|| {
                (
                    s.dir.path.clone(),
                    s.dir.manifest.entry.clone(),
                    s.stamp.clone(),
                )
            })
        }) else {
            return false;
        };
        Stamp::of(&path, &entry) != stamp
    }

    /// The watcher's scan: a plain fn so the watcher's future does not contain `reload`'s.
    pub(crate) fn reload_if_changed(&self, id: &PluginId) {
        if self.changed(id) {
            let (host, id) = (self.clone(), id.clone());
            tokio::spawn(async move {
                if let Err(e) = host.reload(&id).await {
                    tracing::warn!(plugin = %id.0, "reload: {e}");
                }
            });
        }
    }

    async fn plugin_tools(&self, id: &PluginId) -> Option<Vec<HostedTool>> {
        if self.vanished(id) {
            self.vanish(id).await;
            return None;
        }
        if self.changed(id) {
            let _ = self.reload(id).await;
        }
        if let Some(tools) = lock(&self.inner.plugins).get(id)?.tools.clone() {
            return Some(tools);
        }
        let (conn, _busy) = self.ensure_running(id).await.ok()?;
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
        if self.changed(plugin) {
            let _ = self.reload(plugin).await;
        }
        let (conn, _busy) = self.ensure_running(plugin).await.map_err(off)?;

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
        self.call_capability_as(None, cap, args, ctx).await
    }

    /// `asker` is the plugin that sent the request, if one did; core's own callers have none
    /// and `host_call` then sees an empty id.
    pub(crate) async fn call_capability_as(
        &self,
        asker: Option<&PluginId>,
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
        let mut held = None;
        for id in candidates {
            // Held for a game: another provider, or core, may still answer.
            if lock(&self.inner.held).contains(&id) {
                held = held.or_else(|| self.manifest(&id).map(|m| paused(&m.name)));
                continue;
            }
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
        // No plugin: core may answer it itself.
        let up = self.upcalls();
        let nobody = PluginId(String::new());
        match up
            .host_call(asker.unwrap_or(&nobody), cap, args, ctx.cancel)
            .await
        {
            Some(Ok(r)) => Ok(r),
            Some(Err(e)) => Err(CallError::Rpc(e)),
            None => Err(held.map_or_else(none, |sentence| CallError::Off { sentence })),
        }
    }

    /// v2 `Plugins.computeCall` (local branch): the enabled plugin whose manifest declares the
    /// operation `cap` runs its hidden tool bound to it (`_meta["alexia/compute"].op`).
    /// Returns the provider with its result, so the caller can tell where its files are.
    pub(crate) async fn compute_call(
        &self,
        cap: &str,
        args: Map<String, Value>,
        mut ctx: CallCtx,
    ) -> Result<(PluginId, CallToolResult), CallError> {
        let none = || CallError::Off {
            sentence: format!("Nothing installed and switched on can do {cap}."),
        };
        let candidates: Vec<PluginId> = lock(&self.inner.plugins)
            .iter()
            .filter(|(_, s)| {
                s.enabled
                    && !matches!(s.state, PluginState::Refused | PluginState::Unhealthy)
                    && s.dir
                        .manifest
                        .compute
                        .as_ref()
                        .is_some_and(|c| c.operations.iter().any(|o| o.cap == cap))
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in candidates {
            let Some(tools) = self.plugin_tools(&id).await else {
                continue;
            };
            let Some(tool) = tools.into_iter().find(|t| {
                t.tool
                    .meta
                    .as_ref()
                    .and_then(|m| m.get("alexia/compute"))
                    .and_then(|b| b.get("op"))
                    .and_then(Value::as_str)
                    == Some(cap)
            }) else {
                continue;
            };
            ctx.meta
                .insert("alexia/compute".into(), json!({ "op": cap }));
            let within = Duration::from_millis(self.inner.cfg.timings.capability_ms);
            return self
                .call_tool_within(&id, &tool.tool.name, args, ctx, within)
                .await
                .map(|r| (id, r))
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
        let by_plugin = lock(&self.inner.plugins).values().any(|s| {
            s.enabled
                && s.state != PluginState::Refused
                && s.dir.manifest.provides.iter().any(|p| p == cap)
        });
        // The plugins lock is released above: core's `host_caps` may call back into the host.
        let found = by_plugin || self.upcalls().host_caps().iter().any(|c| c == cap);
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

    /// (P2-62, D213) Stop these plugins and keep them stopped until `release`: a call to one is
    /// `Off` ("<name> is paused while a game runs.") and supervision does not respawn it.
    pub async fn hold(&self, ids: &[PluginId]) {
        // Recorded first: from here on `ensure_running` refuses, so after each stop below
        // (which waits out a spawn under way) nothing brings the process back.
        lock(&self.inner.held).extend(ids.iter().cloned());
        for id in ids {
            self.stop(id).await;
        }
    }

    /// The game is over: the next call spawns as usual.
    pub fn release(&self) {
        lock(&self.inner.held).clear();
    }

    /// (P2-62) The owner's word on a plugin: `false` adds it to `_core.unreviewed`, `true`
    /// takes it out. A list that cannot be read or understood is an error, not overwritten.
    pub fn set_reviewed(&self, id: &PluginId, reviewed: bool) -> Result<(), Error> {
        let _g = lock(&self.inner.lists);
        let store = &self.inner.store;
        let mut list: Vec<String> = match store.kv_get("_core", UNREVIEWED)? {
            None => vec![],
            Some(v) => serde_json::from_value(v).map_err(alexia_store::Error::from)?,
        };
        list.retain(|p| p != &id.0);
        if !reviewed {
            list.push(id.0.clone());
        }
        store.kv_set("_core", UNREVIEWED, &json!(list))?;
        Ok(())
    }

    /// (P2-62, review 5 #6) Fail closed for plugins this host has not seen before: each id
    /// missing from `_core.known_plugins` goes into `_core.unreviewed`, then into the known
    /// list. The first scan ever (no known list) trusts what is installed, as v2's bundled set
    /// was. A list that can't be read or understood is left alone; `tools()` then treats
    /// everyone as unreviewed.
    fn learn<'a>(&self, ids: impl Iterator<Item = &'a PluginId>) {
        let ids: Vec<String> = ids.map(|i| i.0.clone()).collect();
        let _g = lock(&self.inner.lists);
        let store = &self.inner.store;
        let read = |key: &str| -> Result<Option<Vec<String>>, String> {
            match store.kv_get("_core", key) {
                Ok(None) => Ok(None),
                Ok(Some(v)) => serde_json::from_value(v)
                    .map(Some)
                    .map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            }
        };
        let warn = |e: String| {
            tracing::warn!("the plugin lists could not be read; new plugins stay unreviewed: {e}");
        };
        let known = match read(KNOWN) {
            Ok(Some(known)) => known,
            Ok(None) => {
                if let Err(e) = store.kv_set("_core", KNOWN, &json!(ids)) {
                    tracing::warn!("the known plugin list could not be written: {e}");
                }
                return;
            }
            Err(e) => return warn(e),
        };
        let new: Vec<String> = ids.into_iter().filter(|i| !known.contains(i)).collect();
        if new.is_empty() {
            return;
        }
        let mut unreviewed = match read(UNREVIEWED) {
            Ok(list) => list.unwrap_or_default(),
            Err(e) => return warn(e),
        };
        for i in &new {
            if !unreviewed.contains(i) {
                unreviewed.push(i.clone());
            }
        }
        // No kv transaction here: unreviewed first, so a failure in between leaves the new
        // plugin unreviewed and still unknown (the next scan adds it again, once).
        if let Err(e) = store.kv_set("_core", UNREVIEWED, &json!(unreviewed)) {
            tracing::warn!("the unreviewed list could not be written: {e}");
            return;
        }
        let known: Vec<String> = known.into_iter().chain(new).collect();
        if let Err(e) = store.kv_set("_core", KNOWN, &json!(known)) {
            tracing::warn!("the known plugin list could not be written: {e}");
        }
    }

    pub fn pid(&self, id: &PluginId) -> Option<u32> {
        lock(&self.inner.plugins)
            .get(id)?
            .running
            .as_ref()
            .map(|r| r.proc.pid())
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

    /// False when there was nothing to stop, or an idle stop found the plugin busy again.
    pub(crate) async fn stop_with(&self, id: &PluginId, reason: StopReason) -> bool {
        let Some(spawn) = lock(&self.inner.plugins).get(id).map(|s| s.spawn.clone()) else {
            return false;
        };
        let _g = spawn.lock().await;
        let running = {
            let mut plugins = lock(&self.inner.plugins);
            let Some(slot) = plugins.get_mut(id) else {
                return false;
            };
            // Calls enter Busy under this same lock (`ensure_running`), so this check and the
            // stop below cannot be split by one.
            if matches!(reason, StopReason::Idle) {
                let idle = Duration::from_millis(self.inner.cfg.timings.idle_ms);
                let still_idle = slot
                    .running
                    .as_ref()
                    .is_some_and(|r| r.busy.idle_for().is_some_and(|d| d >= idle));
                if !still_idle {
                    return false;
                }
            }
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
            return false;
        };
        stop.cancel();
        // Conn owns stdin: dropping it is what lets the plugin see EOF and leave on its own.
        // ponytail: a call still in flight holds its own `Arc<Conn>`, so stdin stays open and
        // the process is killed after the grace period instead.
        drop(conn);
        stop_guest(
            proc,
            Duration::from_millis(self.inner.cfg.timings.exit_grace_ms),
        )
        .await;
        self.emit(PluginEvent::Stopped {
            plugin: id.clone(),
            reason,
        });
        true
    }

    /// The running plugin's connection, spawning and handshaking first if needed, not before
    /// the crash backoff allows. The guard is entered under the spawn lock, so an idle stop
    /// never lands between this and the call. Err is the sentence saying why it is not running.
    async fn ensure_running(&self, id: &PluginId) -> Result<(Arc<Conn>, BusyGuard), String> {
        let spawn = lock(&self.inner.plugins)
            .get(id)
            .map(|s| s.spawn.clone())
            .ok_or_else(|| UNKNOWN.to_string())?;
        let began = Instant::now();
        loop {
            let guard = spawn.lock().await;
            // `reload` sets `Reloading` only under this spawn lock, so it cannot change below.
            let updating = lock(&self.inner.plugins)
                .get(id)
                .filter(|s| s.state == PluginState::Reloading)
                .map(|s| s.dir.manifest.name.clone());
            if let Some(name) = updating {
                // New calls wait for the swap, but not longer than a call may take.
                if began.elapsed() >= Duration::from_millis(self.inner.cfg.timings.call_ms) {
                    return Err(format!("{name} is being updated."));
                }
                drop(guard);
                // ponytail: polls; a Notify if reloads ever get long or frequent.
                tokio::time::sleep(Duration::from_millis(10)).await;
                continue;
            }
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
                // Under the plugins lock and the spawn lock: `hold` records, then stops under
                // the spawn lock, so a call that got past this one is stopped by it.
                if lock(&self.inner.held).contains(id) {
                    return Err(paused(&slot.dir.manifest.name));
                }
                match &slot.running {
                    Some(r) if !r.conn.closed().is_cancelled() => {
                        return Ok((Arc::clone(&r.conn), r.busy.enter()))
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
    ) -> Result<(Arc<Conn>, BusyGuard), String> {
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
        let (proc, stdin, stdout, log) = match start_guest(&dir, cfg, secrets).await {
            Ok(g) => g,
            Err((e, log)) => return Err(self.failed(id, fail(&e), log)),
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
                stop_guest(proc, grace).await;
                return Err(self.failed(id, sentence, Some(log)));
            }
        };
        if spoken != dir.manifest.mcp_protocol {
            drop(conn);
            stop_guest(proc, grace).await;
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

        let pid = proc.pid();
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
        Ok((conn, busy.enter()))
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
        let exit_code = stop_guest(proc, grace).await;
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
            stop_guest(proc, Duration::ZERO).await;
        }
    }
}

/// kv `_core` key: the MCP servers added by hand (v2 `servers.ts`), as `[ServerEntry]`.
const SERVERS: &str = "servers";

/// An MCP server that is not a plugin folder (v2 `servers.ts` `addServer`). The host writes
/// the smallest honest manifest for it under `<data>/servers/<id>/` and hosts it like a plugin.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ServerEntry {
    pub id: String,
    pub name: String,
    pub run: String,
    pub args: Vec<String>,
}

/// v2's summary for a synthesised manifest: it travels with the plugin to every screen.
const SERVER_SUMMARY: &str = "MCP server. Not an Alexia plugin. Not reviewed by us.";

impl McpHost {
    /// (EX-12) Copies a plugin folder into the extensions dir, validates its manifest, scans it
    /// in disabled. Err with v2's sentence when the manifest is refused or the id exists.
    /// Validated where it stands and copied second (v2 `install`), so a folder that is not a
    /// plugin never lands in the directory the host scans. A folder holding a symlink or a
    /// junction is refused: a copy that follows one would take in whatever it points at.
    pub async fn install_folder(&self, from: &Path) -> Result<PluginId, Error> {
        let refused = |s: String| Err(Error::Refused(s));
        let typed = from.to_string_lossy();
        if typed.trim().is_empty() {
            return refused("Type or paste the path of a plugin folder first.".into());
        }
        let from = PathBuf::from(home(typed.trim()));
        let shown = from.display();
        match std::fs::metadata(&from) {
            Err(_) => return refused(format!("There is no folder at {shown}.")),
            Ok(m) if !m.is_dir() => {
                return refused(format!(
                    "{shown} is a file. Point at the folder that holds plugin.json."
                ))
            }
            Ok(_) => {}
        }
        let name = from
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| shown.to_string());
        let Ok(json) = std::fs::read_to_string(from.join("plugin.json")) else {
            return refused(format!("{name} has no readable plugin.json"));
        };
        let manifest = Manifest::parse(&json).map_err(|e| Error::Refused(e.sentence))?;
        if manifest.id != name {
            return refused(format!("{name}'s plugin.json calls it \"{}\"", manifest.id));
        }
        let id = PluginId(manifest.id.clone());
        let already = || {
            format!(
                "{} is already installed. Delete it first to replace it.",
                id.0
            )
        };
        if self.taken(&id)? {
            return refused(already());
        }
        if let Some(link) = link_inside(&from)? {
            return refused(format!(
                "{name} holds a link ({}), and Alexia installs only real files and folders.",
                link.display()
            ));
        }
        let Some(ext) = self.inner.cfg.plugin_dirs.first() else {
            return refused("There is no folder to install plugins into.".into());
        };
        std::fs::create_dir_all(ext)?;
        let dest = ext.join(&id.0);
        if dest.exists() {
            return refused(already());
        }
        if let Err(e) = copy_tree(&from, &dest) {
            let _ = std::fs::remove_dir_all(&dest);
            return Err(e.into());
        }
        let dir = PluginDir {
            path: dest,
            manifest,
        };
        self.learn(std::iter::once(&id));
        let (slot, _) = self.admit(dir, false);
        self.insert_slot(id.clone(), slot);
        Ok(id)
    }

    /// An MCP server that is not a plugin folder (v2 `servers.ts` `addServer`): kv
    /// `_core`/`servers` [{id,name,run,args}], hosted like a plugin with no manifest extras,
    /// unreviewed until trusted. Installed, not enabled. Not probed: whether it starts is
    /// seen when it is enabled, in its state, as for any plugin.
    pub async fn add_server(
        &self,
        id: &str,
        name: &str,
        run: &str,
        args: &[String],
    ) -> Result<PluginId, Error> {
        let refused = |s: String| Err(Error::Refused(s));
        let id = id.trim();
        if id.is_empty() {
            return refused("Give it a name first — lowercase letters, digits and hyphens.".into());
        }
        if !server_id(id) {
            return refused(format!(
                "“{id}” is not a usable name — lowercase letters, digits and hyphens."
            ));
        }
        let pid = PluginId(id.to_owned());
        let taken = || format!("Something called “{id}” is already installed.");
        if self.taken(&pid)? {
            return refused(taken());
        }
        if run.trim().is_empty() {
            return refused("There is no command to run.".into());
        }
        let entry = ServerEntry {
            id: id.to_owned(),
            name: Some(name.trim())
                .filter(|n| !n.is_empty())
                .unwrap_or(id)
                .to_owned(),
            run: home(run.trim()),
            args: args.iter().map(|a| home(a)).collect(),
        };
        let dir = self.server_folder(&entry).map_err(Error::Refused)?;
        {
            let _g = lock(&self.inner.lists);
            let mut list = self.read_servers()?;
            if list.iter().any(|s| s.id == entry.id) {
                return refused(taken());
            }
            list.push(entry);
            self.write_servers(&list)?;
        }
        // Nobody has reviewed it: every tool is asked about until the owner says otherwise.
        self.set_reviewed(&pid, false)?;
        self.know(&pid)?;
        let (slot, _) = self.admit(dir, false);
        self.insert_slot(pid.clone(), slot);
        Ok(pid)
    }

    /// The servers `add_server` added, as kv `_core`/`servers` holds them. A list that cannot be
    /// read is empty here (and logged).
    pub fn servers(&self) -> Vec<ServerEntry> {
        self.read_servers().unwrap_or_else(|e| {
            tracing::warn!("the server list could not be read: {e}");
            vec![]
        })
    }

    /// (v2 `purge`) Everything the plugin owns, gone, and then the plugin itself: its slot,
    /// the folder it was installed from (or its server entry). `purge` leaves the folder.
    pub async fn remove(&self, id: &PluginId) -> Result<(), Error> {
        let dir = lock(&self.inner.plugins)
            .get(id)
            .map(|s| s.dir.path.clone())
            .ok_or_else(|| Error::UnknownPlugin(id.clone()))?;
        self.purge(id).await?;
        let spawn = lock(&self.inner.plugins).get(id).map(|s| s.spawn.clone());
        if let Some(spawn) = spawn {
            let _g = spawn.lock().await;
            let gone = lock(&self.inner.plugins).remove(id);
            if let Some(Running {
                proc, conn, stop, ..
            }) = gone.and_then(|s| s.running)
            {
                stop.cancel();
                drop(conn);
                stop_guest(proc, Duration::ZERO).await;
            }
        }
        self.emit(PluginEvent::Removed { plugin: id.clone() });
        {
            let _g = lock(&self.inner.lists);
            let mut list = self.read_servers()?;
            let before = list.len();
            list.retain(|s| s.id != id.0);
            if list.len() != before {
                self.write_servers(&list)?;
            }
        }
        match std::fs::remove_dir_all(&dir) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }

    /// (D204) The Restart on a plugin the supervisor switched off: a fresh crash tally and no
    /// reason; an enabled resident plugin is started now, the others at their next call.
    pub async fn restart(&self, id: &PluginId) -> Result<(), Error> {
        let on = {
            let mut plugins = lock(&self.inner.plugins);
            let slot = plugins
                .get_mut(id)
                .ok_or_else(|| Error::UnknownPlugin(id.clone()))?;
            slot.crashes.clear();
            if slot.state == PluginState::Unhealthy {
                slot.state = PluginState::Stopped;
                slot.sentence = None;
            }
            slot.enabled
        };
        if on {
            self.set_enabled(id, true).await?;
        }
        Ok(())
    }

    /// Any loaded plugin's folder and manifest, enabled or not, refused or not.
    pub fn plugin_dir(&self, id: &PluginId) -> Option<PluginDir> {
        lock(&self.inner.plugins).get(id).map(|s| s.dir.clone())
    }

    /// The tool names a running plugin last listed; None while it is stopped or has not been
    /// asked. Never spawns.
    pub fn tool_names(&self, id: &PluginId) -> Option<Vec<String>> {
        let plugins = lock(&self.inner.plugins);
        let slot = plugins.get(id)?;
        slot.running.as_ref()?;
        slot.tools
            .as_ref()
            .map(|t| t.iter().map(|t| t.tool.name.clone()).collect())
    }

    /// Folders that are not plugins, and why, as the last `start` found them (v2 `problems`).
    pub fn problems(&self) -> Vec<(PathBuf, String)> {
        lock(&self.inner.problems).clone()
    }

    fn servers_dir(&self) -> PathBuf {
        self.inner.cfg.layout.root.join("servers")
    }

    /// kv `_core`/`servers`; a malformed list is an error, never overwritten.
    fn read_servers(&self) -> Result<Vec<ServerEntry>, Error> {
        Ok(match self.inner.store.kv_get("_core", SERVERS)? {
            None => vec![],
            Some(v) => serde_json::from_value(v).map_err(alexia_store::Error::from)?,
        })
    }

    /// With `lists` held.
    fn write_servers(&self, list: &[ServerEntry]) -> Result<(), Error> {
        let v = serde_json::to_value(list).map_err(alexia_store::Error::from)?;
        self.inner.store.kv_set("_core", SERVERS, &v)?;
        Ok(())
    }

    /// Whether `id` is a loaded plugin, an added server, or a folder in a plugin dir.
    fn taken(&self, id: &PluginId) -> Result<bool, Error> {
        Ok(lock(&self.inner.plugins).contains_key(id)
            || self.read_servers()?.iter().any(|s| s.id == id.0)
            || self
                .inner
                .cfg
                .plugin_dirs
                .iter()
                .any(|d| d.join(&id.0).exists()))
    }

    /// `id` into `_core.known_plugins`, so a later scan does not take it for new.
    fn know(&self, id: &PluginId) -> Result<(), Error> {
        let _g = lock(&self.inner.lists);
        let store = &self.inner.store;
        let mut known: Vec<String> = match store.kv_get("_core", KNOWN)? {
            None => vec![],
            Some(v) => serde_json::from_value(v).map_err(alexia_store::Error::from)?,
        };
        if !known.contains(&id.0) {
            known.push(id.0.clone());
            store.kv_set("_core", KNOWN, &json!(known))?;
        }
        Ok(())
    }

    /// The server's synthesised manifest (v2 `synthesise`), written to its folder when it
    /// differs from what is there. Err is the sentence.
    fn server_folder(&self, s: &ServerEntry) -> Result<PluginDir, String> {
        let path = self.servers_dir().join(&s.id);
        // A manifest names its program on PATH or relative to its folder: a full path typed for
        // a server is written relative to the folder the host keeps its manifest in.
        let run = if Path::new(&s.run).is_absolute() {
            relative_to(&path, Path::new(&s.run)).ok_or_else(|| {
                format!(
                    "{} can't be run from where Alexia keeps its servers; put it on the same drive, or on PATH.",
                    s.run
                )
            })?
        } else {
            s.run.clone()
        };
        let mut entry = json!({ "run": run });
        if !s.args.is_empty() {
            entry["args"] = json!(s.args);
        }
        let name = if s.name.trim().is_empty() {
            &s.id
        } else {
            &s.name
        };
        let text = json!({
            "manifest_version": 1,
            "id": s.id,
            "name": name,
            "summary": SERVER_SUMMARY,
            "version": "0.0.0",
            "license": "unknown",
            "entry": entry,
            "alexia_protocol": crate::ALEXIA_PROTOCOL_MIN,
            "mcp_protocol": crate::MCP_REVISIONS[0],
        })
        .to_string();
        let manifest = Manifest::parse(&text).map_err(|e| e.sentence)?;
        let file = path.join("plugin.json");
        if std::fs::read_to_string(&file).ok().as_deref() != Some(text.as_str()) {
            std::fs::create_dir_all(&path)
                .and_then(|()| std::fs::write(&file, &text))
                .map_err(|e| format!("{} could not be written down: {e}", s.id))?;
        }
        Ok(PluginDir { path, manifest })
    }

    /// A slot for a folder just found: refused when this build cannot run it; for an enabled
    /// plugin its tables are made. True when it is resident and should be started now.
    fn admit(&self, dir: PluginDir, on: bool) -> (Slot, bool) {
        let mut slot = Slot {
            stamp: Stamp::of(&dir.path, &dir.manifest.entry),
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
        let mut wake = false;
        match slot.dir.manifest.compatible() {
            Err(sentence) => refuse(&mut slot, sentence),
            Ok(()) if on => {
                if let Err(sentence) = self.create_tables(&slot.dir) {
                    refuse(&mut slot, sentence);
                } else {
                    wake = slot.dir.manifest.lifetime() == Lifetime::Resident;
                }
            }
            Ok(()) => {}
        }
        (slot, wake)
    }

    /// Puts the slot in and says so: `Refused` with its sentence, else `Loaded`.
    fn insert_slot(&self, id: PluginId, slot: Slot) {
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
}

/// `McpHost::scan`, keeping the folders that are not plugins and why.
fn scan_all(dirs: &[PathBuf]) -> (BTreeMap<PluginId, PluginDir>, Vec<(PathBuf, String)>) {
    let mut found: BTreeMap<PluginId, PluginDir> = BTreeMap::new();
    let mut problems = vec![];
    for root in dirs {
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
                    problems.push((path, e.sentence));
                }
            }
        }
    }
    (found, problems)
}

/// `target` as a path relative to `base` (both absolute), or None when they share no root
/// (another drive).
fn relative_to(base: &Path, target: &Path) -> Option<String> {
    let (b, t): (Vec<Component>, Vec<Component>) =
        (base.components().collect(), target.components().collect());
    if b.first() != t.first() {
        return None;
    }
    let same = b.iter().zip(&t).take_while(|(x, y)| x == y).count();
    let mut rel = PathBuf::new();
    for _ in same..b.len() {
        rel.push("..");
    }
    for c in &t[same..] {
        rel.push(c.as_os_str());
    }
    Some(rel.to_string_lossy().into_owned())
}

/// v2's server id: lowercase words of letters and digits joined by single hyphens.
fn server_id(id: &str) -> bool {
    alexia_store::is_plugin_id(id) && !id.ends_with('-') && !id.contains("--")
}

/// A leading tilde as a shell reads it (v2 `home`): the home folder, alone or followed by a
/// path. Anything else is left exactly as typed.
fn home(typed: &str) -> String {
    let rest = match typed.strip_prefix('~') {
        Some("") => "",
        Some(r) if r.starts_with(['/', '\\']) => &r[1..],
        _ => return typed.to_owned(),
    };
    let found = if cfg!(windows) {
        std::env::var_os("USERPROFILE")
    } else {
        None
    }
    .filter(|h| !h.is_empty())
    .or_else(|| std::env::var_os("HOME").filter(|h| !h.is_empty()));
    let Some(base) = found.map(PathBuf::from) else {
        return typed.to_owned();
    };
    let full = if rest.is_empty() {
        base
    } else {
        base.join(rest)
    };
    full.to_string_lossy().into_owned()
}

/// True for a symlink, and on Windows for any reparse point (a junction is one).
fn is_link(m: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    m.file_type().is_symlink()
}

/// The first link anywhere under `dir` (the folder itself included), relative to it.
fn link_inside(dir: &Path) -> std::io::Result<Option<PathBuf>> {
    if is_link(&std::fs::symlink_metadata(dir)?) {
        return Ok(Some(PathBuf::from(".")));
    }
    let mut todo = vec![dir.to_path_buf()];
    while let Some(at) = todo.pop() {
        for e in std::fs::read_dir(&at)? {
            let p = e?.path();
            let m = std::fs::symlink_metadata(&p)?;
            if is_link(&m) {
                return Ok(Some(
                    p.strip_prefix(dir).map_or(p.clone(), Path::to_path_buf),
                ));
            }
            if m.is_dir() {
                todo.push(p);
            }
        }
    }
    Ok(None)
}

/// `from` into `to` (which must not exist) with `std::fs`, `plugin.json` last: a copy cut short
/// has no manifest, so no scan takes it for a plugin. Links are refused, not followed.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fn walk(from: &Path, to: &Path, top: bool) -> std::io::Result<()> {
        std::fs::create_dir(to)?;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            let (src, dst) = (e.path(), to.join(e.file_name()));
            let m = std::fs::symlink_metadata(&src)?;
            if is_link(&m) {
                return Err(std::io::Error::other(format!(
                    "{} is a link",
                    src.display()
                )));
            }
            if m.is_dir() {
                walk(&src, &dst, false)?;
            } else if !(top && e.file_name() == "plugin.json") {
                std::fs::copy(&src, &dst)?;
            }
        }
        Ok(())
    }
    walk(from, to, true)?;
    std::fs::copy(from.join("plugin.json"), to.join("plugin.json"))?;
    Ok(())
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
        // Only `tools()`, having read `_core.unreviewed`, may say otherwise.
        reviewed: false,
    }
}

/// What one plugin's `Conn` asks of the host. Weak: the host owns the `Conn`.
struct Handler {
    host: Weak<Inner>,
    id: PluginId,
}

#[async_trait::async_trait]
impl Incoming for Handler {
    async fn request(
        &self,
        method: String,
        params: Option<Value>,
        cancel: CancellationToken,
        progress: Option<ProgressSink>,
    ) -> Result<Value, RpcError> {
        let Some(inner) = self.host.upgrade() else {
            return Err(RpcError::new(
                code::INTERNAL_ERROR,
                "Alexia is shutting down.",
            ));
        };
        if method.starts_with("alexia/") {
            let host = McpHost { inner };
            return match AlexiaCall::parse(&method, params)? {
                Some(call) => {
                    let ctx = CallCtx {
                        cancel,
                        progress,
                        ..CallCtx::default()
                    };
                    crate::serve::serve(&host, &self.id, call, ctx).await
                }
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
                up.sample(&self.id, p, progress, cancel).await
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

/// What a plugin runs in: a child process, or a wasm instance inside the hub (SP-10).
pub(crate) enum Guest {
    Process(Proc),
    Wasm(WasmPlugin),
}

impl Guest {
    /// A wasm guest has no process: 0.
    fn pid(&self) -> u32 {
        match self {
            Guest::Process(p) => p.pid,
            Guest::Wasm(_) => 0,
        }
    }
}

/// `process::stop` for either kind: wait `grace` for it to leave, then kill it.
async fn stop_guest(guest: Guest, grace: Duration) -> Option<i32> {
    match guest {
        Guest::Process(p) => process::stop(p, grace).await,
        Guest::Wasm(w) => w.stop(grace).await,
    }
}

type Started = (Guest, ChildStdin, ChildStdout, StderrLog);

/// Starts the plugin's process or wasm instance and takes its stdio. An error comes with
/// the log to keep, if there is one.
async fn start_guest(
    dir: &PluginDir,
    cfg: &crate::HostConfig,
    secrets: Vec<String>,
) -> Result<Started, (String, Option<StderrLog>)> {
    let entry = &dir.manifest.entry;
    if entry.run == "wasm" {
        let id = &dir.manifest.id;
        // `args[0]` is the module, a file inside the plugin folder.
        let rel = Path::new(entry.args.first().map(String::as_str).unwrap_or_default());
        if entry.args.len() != 1 || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
            return Err((
                "the manifest must name one .wasm file in its folder".into(),
                None,
            ));
        }
        let own = dir
            .manifest
            .requires
            .iter()
            .any(|r| r.cap == "fs.own_dir")
            .then(|| cfg.layout.own_dir(id));
        if let Some(own) = &own {
            std::fs::create_dir_all(own).map_err(|e| (e.to_string(), None))?;
        }
        let limits = Limits {
            start_ms: cfg.timings.start_ms,
            ..Limits::default()
        };
        let mut wasm = WasmPlugin::spawn_as(&dir.path.join(rel), own.as_deref(), limits, id)
            .await
            .map_err(|e| (e.to_string(), None))?;
        let (stdin, stdout) = wasm.take_stdio().expect("fresh instance has its pipes");
        return Ok((Guest::Wasm(wasm), stdin, stdout, StderrLog::new(secrets)));
    }
    let mut proc =
        process::spawn(dir, &cfg.layout, &cfg.node, secrets).map_err(|e| (e.to_string(), None))?;
    let log = proc.stderr.clone();
    match (proc.child.stdin.take(), proc.child.stdout.take()) {
        (Some(stdin), Some(stdout)) => Ok((Guest::Process(proc), stdin, stdout, log)),
        _ => {
            // Dropping `proc` kills it.
            Err(("no stdio".into(), Some(log)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosted_tool_unreviewed_until_list_read() {
        let tool: types::Tool =
            serde_json::from_value(json!({"name": "t", "inputSchema": {"type": "object"}}))
                .unwrap();
        let t = hosted(&PluginId("a".into()), tool);
        assert!(!t.reviewed, "a tool is unreviewed until the list was read");
    }
}
