// SPDX-License-Identifier: AGPL-3.0-only
//! The hub's side of the proactivity engine (P3-31): where notices, brief sections and watched
//! answers come from (every plugin that offers the capability, never one by name), and whether
//! the owner is at this PC.
//!
//! What plugins answer is the owner's data: log lines carry plugin ids, kinds and counts only.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use alexia_core::chat::Caps;
use alexia_core::{Bus, Event};
use alexia_mcp::types::CallToolResult;
use alexia_mcp::{CallCtx, CallError, McpHost, PluginId, PluginState};
use alexia_scheduler::{ItemsRound, NoticeItem, Sources};
use alexia_store::Ms;
use chrono::{Local, Offset, TimeZone};
use serde_json::{json, Map, Value};
use tokio::task::JoinSet;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

const ITEMS: &str = "notice.items";
const SECTION: &str = "brief.section";
const DONE: &str = "notice.done";

/// How long one provider has to answer.
const PER_CALL: Duration = Duration::from_secs(20);

/// The scheduler's [`Sources`] over the plugin host.
pub struct HostSources {
    host: McpHost,
    per_call: Duration,
    /// The tool that answers `notice.items` in each plugin, once listed: a round then calls
    /// only the providers, and does not wake every plugin to list its tools.
    tools: Mutex<HashMap<PluginId, String>>,
}

impl HostSources {
    pub fn new(host: McpHost) -> HostSources {
        HostSources {
            host,
            per_call: PER_CALL,
            tools: Mutex::default(),
        }
    }

    fn known(&self) -> MutexGuard<'_, HashMap<PluginId, String>> {
        self.tools.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Lists the tools of any provider whose `notice.items` tool is not known yet. A provider
    /// that does not list one by `deadline` stays unknown, and so fails this round.
    async fn resolve(&self, providers: &[PluginId], deadline: Instant) {
        if providers.iter().all(|p| self.known().contains_key(p)) {
            return;
        }
        // Its own task: a cold start cut off here is not abandoned half way.
        let host = self.host.clone();
        let listing = tokio::spawn(async move { host.tools().await });
        let Ok(Ok(listed)) = tokio::time::timeout_at(deadline, listing).await else {
            tracing::warn!("{ITEMS}: the plugins' tools were not listed in time");
            return;
        };
        let mut known = self.known();
        for p in providers {
            let tool = listed
                .iter()
                .find(|t| t.plugin == *p && t.provides.iter().any(|c| c == ITEMS));
            if let Some(t) = tool {
                known.insert(p.clone(), t.tool.name.clone());
            }
        }
    }
}

/// `{now, tz_offset_min}`: the offset is the machine's own at `now`, minutes east of UTC.
fn time_args(now: Ms) -> Map<String, Value> {
    let offset = Local
        .timestamp_millis_opt(now)
        .earliest()
        .map_or(0, |t| t.offset().fix().local_minus_utc() / 60);
    Map::from_iter([
        ("now".into(), json!(now)),
        ("tz_offset_min".into(), json!(offset)),
    ])
}

/// Why a provider gave nothing: a kind, never the plugin's own text.
struct Miss {
    kind: &'static str,
    /// The plugin itself said no, so the remembered tool may be gone (a new version).
    stale: bool,
}

/// One provider's tool, within `deadline`.
async fn ask_one(
    host: McpHost,
    plugin: PluginId,
    tool: String,
    args: Map<String, Value>,
    deadline: Instant,
) -> Result<CallToolResult, Miss> {
    let miss = |kind, stale| Err(Miss { kind, stale });
    let cancel = CancellationToken::new();
    let ctx = CallCtx {
        cancel: cancel.clone(),
        ..CallCtx::default()
    };
    // Its own task, so a plugin still starting at the deadline carries on starting.
    let call = tokio::spawn(async move { host.call_tool(&plugin, &tool, args, ctx).await });
    match tokio::time::timeout_at(deadline, call).await {
        Err(_) => {
            cancel.cancel();
            miss("no answer in time", false)
        }
        Ok(Err(_)) => miss("the call panicked", false),
        Ok(Ok(Err(CallError::Rpc(_)))) => miss("an error", true),
        Ok(Ok(Err(_))) => miss("the call failed", false),
        Ok(Ok(Ok(r))) if r.is_error == Some(true) => miss("answered with an error", true),
        Ok(Ok(Ok(r))) => Ok(r),
    }
}

/// `structuredContent.items` as notices, and how many were unreadable. None when the answer
/// holds no list at all: that is a failure, not "nothing to say".
fn parse_items(result: &CallToolResult) -> Option<(Vec<NoticeItem>, usize)> {
    let list = result
        .structured_content
        .as_ref()?
        .get("items")?
        .as_array()?;
    let items: Vec<NoticeItem> = list
        .iter()
        .filter_map(|v| serde_json::from_value::<NoticeItem>(v.clone()).ok())
        .filter(|i| !i.key.trim().is_empty() && !i.text.trim().is_empty())
        .collect();
    let skipped = list.len() - items.len();
    Some((items, skipped))
}

/// One round from each provider's answer (None: it failed).
fn round_of(answers: Vec<(String, Option<CallToolResult>)>) -> ItemsRound {
    let mut round = ItemsRound::default();
    for (provider, answer) in answers {
        let slot = (provider.clone(), ITEMS.to_owned());
        match answer.as_ref().and_then(parse_items) {
            Some((items, skipped)) => {
                if skipped > 0 {
                    tracing::warn!(plugin = %provider, skipped, "{ITEMS}: unreadable items skipped");
                }
                round.answered.push(slot);
                round.items.extend(
                    items
                        .into_iter()
                        .map(|i| (provider.clone(), ITEMS.to_owned(), i)),
                );
            }
            None => {
                if answer.is_some() {
                    tracing::warn!(plugin = %provider, "{ITEMS}: the answer holds no list");
                }
                round.failed.push(slot);
            }
        }
    }
    round
}

/// The annotation half of core's `read_only` (`permissions.rs`), written out here: it is
/// private there. `readOnlyHint: true` and not `destructiveHint: true`; no annotations is no.
fn reads_only(tool: &alexia_mcp::types::Tool) -> bool {
    tool.annotations
        .as_ref()
        .is_some_and(|a| a.read_only_hint == Some(true) && a.destructive_hint != Some(true))
}

/// A section's `structuredContent.text`, when it says something.
fn section_text(result: &CallToolResult) -> Option<String> {
    let text = result.structured_content.as_ref()?.get("text")?.as_str()?;
    (!text.trim().is_empty()).then(|| text.to_owned())
}

#[async_trait::async_trait]
impl Sources for HostSources {
    async fn items(&self, now: Ms, horizon_days: u32) -> Vec<(String, NoticeItem)> {
        self.round(now, horizon_days)
            .await
            .items
            .into_iter()
            .map(|(_, cap, item)| (cap, item))
            .collect()
    }

    /// Asks each provider by itself: `call_capability_all` does not say who answered, and the
    /// notice loop must know a provider that failed from one that had nothing.
    async fn round(&self, now: Ms, horizon_days: u32) -> ItemsRound {
        let deadline = Instant::now() + self.per_call;
        // Every enabled provider, broken ones too: they count as failed, so a round without
        // them closes nothing of theirs.
        let providers: Vec<(PluginId, bool)> = self
            .host
            .plugins()
            .into_iter()
            .filter(|p| p.enabled && p.provides.iter().any(|c| c == ITEMS))
            .map(|p| {
                let usable = !matches!(p.state, PluginState::Refused | PluginState::Unhealthy);
                (p.id, usable)
            })
            .collect();
        let usable: Vec<PluginId> = providers
            .iter()
            .filter(|(_, usable)| *usable)
            .map(|(id, _)| id.clone())
            .collect();
        self.resolve(&usable, deadline).await;
        let mut args = time_args(now);
        args.insert("horizon_days".into(), json!(horizon_days));
        let mut calls = JoinSet::new();
        for id in &usable {
            let Some(tool) = self.known().get(id).cloned() else {
                continue;
            };
            let (host, id, args) = (self.host.clone(), id.clone(), args.clone());
            calls.spawn(async move {
                let answer = ask_one(host, id.clone(), tool, args, deadline).await;
                (id, answer)
            });
        }
        let mut got: HashMap<PluginId, CallToolResult> = HashMap::new();
        while let Some(done) = calls.join_next().await {
            match done {
                Ok((id, Ok(r))) => {
                    got.insert(id, r);
                }
                Ok((id, Err(Miss { kind, stale }))) => {
                    tracing::warn!(plugin = %id.0, "{ITEMS}: {kind}");
                    if stale {
                        // List it again next time.
                        self.known().remove(&id);
                    }
                }
                Err(e) => tracing::warn!("{ITEMS}: a provider's call panicked: {e}"),
            }
        }
        round_of(
            providers
                .into_iter()
                .map(|(id, _)| {
                    let answer = got.remove(&id);
                    (id.0, answer)
                })
                .collect(),
        )
    }

    async fn sections(&self, kind: &str, now: Ms) -> Vec<String> {
        let mut args = time_args(now);
        args.insert("kind".into(), json!(kind));
        self.host
            .call_capability_all(SECTION, args, CallCtx::default(), self.per_call)
            .await
            .iter()
            .filter_map(section_text)
            .collect()
    }

    async fn poll(&self, cap: &str, args: Map<String, Value>) -> Option<String> {
        let cancel = CancellationToken::new();
        let (host, cap, token) = (self.host.clone(), cap.to_owned(), cancel.clone());
        let call = tokio::spawn(async move { Caps::call(&host, &cap, args, token).await });
        match tokio::time::timeout(self.per_call, call).await {
            Ok(answer) => answer.ok().flatten(),
            Err(_) => {
                cancel.cancel();
                None
            }
        }
    }

    async fn done(&self, key: &str) {
        let args = Map::from_iter([("key".into(), json!(key))]);
        self.host
            .call_capability_all(DONE, args, CallCtx::default(), self.per_call)
            .await;
    }

    /// (P3-39) Every enabled provider of `cap` (broken ones too) must list a tool for it, and
    /// every such tool must be reviewed, `readOnlyHint: true` and not `destructiveHint: true`
    /// (the test core's `read_only` makes). Checking all of them means the one
    /// `call_capability` picks always passes. Core's own answers carry no annotations, so they
    /// are never watchable. Fails closed: no provider, or tools not listed in time, is Err.
    async fn watchable(&self, cap: &str) -> Result<(), String> {
        let providers: Vec<PluginId> = self
            .host
            .plugins()
            .into_iter()
            .filter(|p| p.enabled && p.provides.iter().any(|c| c == cap))
            .map(|p| p.id)
            .collect();
        if providers.is_empty() {
            return Err(format!("Nothing installed can be watched for {cap}."));
        }
        // Its own task, like `resolve`: a cold start cut off here is not abandoned half way.
        let host = self.host.clone();
        let listing = tokio::spawn(async move { host.tools().await });
        let Ok(Ok(listed)) = tokio::time::timeout(self.per_call, listing).await else {
            tracing::warn!(
                cap,
                "a watch's capability could not be checked: no tool list"
            );
            return Err(format!(
                "{cap} can't be watched right now: its plugins did not answer."
            ));
        };
        for p in &providers {
            let tools: Vec<_> = listed
                .iter()
                .filter(|t| t.plugin == *p && t.provides.iter().any(|c| c == cap))
                .collect();
            if tools.is_empty() {
                return Err(format!(
                    "{cap} can't be watched right now: a plugin that offers it is not running."
                ));
            }
            if tools.iter().any(|t| !t.reviewed) {
                return Err(format!(
                    "{cap} can't be watched: a plugin that offers it has not been reviewed."
                ));
            }
            if !tools.iter().all(|t| reads_only(&t.tool)) {
                return Err(format!(
                    "{cap} can't be watched: a watch may only read something, and that changes things."
                ));
            }
        }
        Ok(())
    }
}

// ---- is the owner at this PC? ----

/// This long without input is the night: the next input means the owner is up.
const IDLE_MS: u32 = 3 * 60 * 60 * 1000;
/// How often the last input is looked at.
const LOOK_EVERY: Duration = Duration::from_secs(60);

/// Watches the time of the last input, as Windows ticks (ms since boot, wrapping).
#[derive(Default)]
struct Wake {
    seen: Option<u32>,
}

impl Wake {
    /// true when `last_input` is new and came at least [`IDLE_MS`] after the one seen before.
    fn sample(&mut self, last_input: u32) -> bool {
        let woke = self.seen.is_some_and(|before| {
            let gap = last_input.wrapping_sub(before);
            // More than half the tick range is a time that went backwards, not a long night.
            (IDLE_MS..=u32::MAX / 2).contains(&gap)
        });
        self.seen = Some(last_input);
        woke
    }
}

/// The tick of the last keyboard or mouse input in this session; None when Windows won't say.
#[cfg(windows)]
#[allow(unsafe_code)]
fn last_input_tick() -> Option<u32> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: `info` is a LASTINPUTINFO with its size set, alive and writable across the call.
    let ok = unsafe { GetLastInputInfo(&mut info) };
    (ok != 0).then_some(info.dwTime)
}

#[cfg(not(windows))]
fn last_input_tick() -> Option<u32> {
    None
}

/// Windows: every 60 s, `GetLastInputInfo`; when input appears after ≥ 3 h idle, publish
/// `Event::Active { via: "pc" }`. Elsewhere: does nothing.
pub fn spawn_activity_watch(bus: Bus, cancel: CancellationToken) {
    if cfg!(not(windows)) {
        return;
    }
    tokio::spawn(watch(bus, cancel, LOOK_EVERY, last_input_tick));
}

async fn watch(bus: Bus, cancel: CancellationToken, every: Duration, read: fn() -> Option<u32>) {
    let mut wake = Wake::default();
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            () = cancel.cancelled() => return,
            _ = tick.tick() => {}
        }
        if read().is_some_and(|t| wake.sample(t)) {
            bus.publish(Event::Active {
                at: alexia_store::now_ms(),
                via: "pc".into(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alexia_mcp::{EventSink, HostConfig, NoUpcalls, Timings};
    use alexia_store::{Layout, Store};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    fn answer(structured: Value) -> CallToolResult {
        serde_json::from_value(json!({"content": [], "structuredContent": structured})).unwrap()
    }

    #[test]
    fn items_parsed_from_structured_content() {
        let r = answer(json!({"items": [
            {"key": "a:1", "text": "Send the form", "why": "You promised.", "urgency": "high"},
            {"key": "a:2", "text": "Water the plants", "why": "It is dry."},
        ]}));
        let (items, skipped) = parse_items(&r).unwrap();
        assert_eq!(skipped, 0);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].key, "a:1");
        assert_eq!(items[0].text, "Send the form");
        assert_eq!(items[0].why, "You promised.");
        assert_eq!(items[0].urgency, Some(alexia_core::Urgency::High));
        assert_eq!(items[1].urgency, None);
        // No list at all is not an empty answer.
        assert!(parse_items(&answer(json!({"other": 1}))).is_none());
        let text_only: CallToolResult =
            serde_json::from_value(json!({"content": [{"type": "text", "text": "hi"}]})).unwrap();
        assert!(parse_items(&text_only).is_none());
        assert_eq!(
            parse_items(&answer(json!({"items": []}))),
            Some((Vec::new(), 0))
        );
    }

    #[test]
    fn bad_item_skipped() {
        let r = answer(json!({"items": [
            {"key": "a:1", "why": "no text"},
            "not an object",
            {"key": "a:2", "text": "ok", "why": "w", "urgency": "shouting"},
            {"key": " ", "text": "blank key", "why": "w"},
            {"key": "a:3", "text": "kept", "why": "w"},
        ]}));
        let (items, skipped) = parse_items(&r).unwrap();
        assert_eq!(skipped, 4);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].key, "a:3");
    }

    #[test]
    fn camel_case_due_at() {
        let r = answer(json!({"items": [
            {"key": "a:1", "text": "t", "why": "w", "dueAt": 5000, "notBefore": 4000},
        ]}));
        let (items, _) = parse_items(&r).unwrap();
        assert_eq!(items[0].due_at, Some(5000));
        assert_eq!(items[0].not_before, Some(4000));
    }

    #[test]
    fn round_splits_answered_and_failed() {
        let round = round_of(vec![
            (
                "alpha".into(),
                Some(answer(
                    json!({"items": [{"key": "a:1", "text": "t", "why": "w"}]}),
                )),
            ),
            ("beta".into(), None),
            ("gamma".into(), Some(answer(json!({"items": []})))),
            ("delta".into(), Some(answer(json!({"nothing": true})))),
        ]);
        let slot = |p: &str| (p.to_owned(), ITEMS.to_owned());
        assert_eq!(round.answered, [slot("alpha"), slot("gamma")]);
        assert_eq!(round.failed, [slot("beta"), slot("delta")]);
        assert_eq!(round.items.len(), 1);
        assert_eq!(round.items[0].0, "alpha");
    }

    #[test]
    fn wake_only_after_three_idle_hours() {
        let mut wake = Wake::default();
        assert!(!wake.sample(1_000), "the first look has nothing to compare");
        assert!(!wake.sample(1_000), "no new input");
        assert!(!wake.sample(1_000 + IDLE_MS - 1));
        let later = 1_000 + IDLE_MS - 1 + IDLE_MS;
        assert!(wake.sample(later));
        assert!(!wake.sample(later), "said once");
        assert!(!wake.sample(later + 60_000));
        // A time that went backwards is not a night.
        assert!(!wake.sample(later));
        // The tick counter wraps after 49 days.
        let mut wake = Wake::default();
        wake.sample(u32::MAX - 10);
        assert!(wake.sample(IDLE_MS));
    }

    #[tokio::test]
    async fn watch_publishes_pc_activity() {
        static LOOKS: AtomicU32 = AtomicU32::new(0);
        fn read() -> Option<u32> {
            // First an old input, then one four hours later, then nothing new.
            Some(match LOOKS.fetch_add(1, Ordering::SeqCst) {
                0 => 0,
                _ => 4 * 60 * 60 * 1000,
            })
        }
        let bus = Bus::new(16);
        let mut rx = bus.subscribe();
        let cancel = CancellationToken::new();
        let task = tokio::spawn(watch(bus, cancel.clone(), Duration::from_millis(5), read));
        let e = tokio::time::timeout(Duration::from_secs(30), rx.recv())
            .await
            .expect("no activity said")
            .unwrap();
        assert!(matches!(&*e, Event::Active { via, .. } if via == "pc"));
        while LOOKS.load(Ordering::SeqCst) < 5 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        cancel.cancel();
        task.await.unwrap();
        assert!(rx.try_recv().is_err(), "said more than once");
    }

    // ---- against real plugin processes ----

    /// A tiny MCP server: its one argument is a JSON file naming its tools and their answers.
    const SERVER: &str = r#"
const fs = require('fs')
const rl = require('readline').createInterface({ input: process.stdin })
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  let result = {}
  if (m.method === 'initialize') {
    result = { protocolVersion: '2025-11-25', serverInfo: { name: 'fake', version: '0' }, capabilities: { tools: {} } }
  } else if (m.method === 'tools/list') {
    result = { tools: spec.tools.map((t) => ({ name: t.name, inputSchema: { type: 'object' }, annotations: t.annotations, _meta: { 'alexia/provides': [t.cap] } })) }
  } else if (m.method === 'tools/call') {
    const t = spec.tools.find((x) => x.name === m.params.name)
    fs.appendFileSync(process.argv[2] + '.calls', JSON.stringify([m.params.name, m.params.arguments]) + '\n')
    result = t.answer
  }
  send({ jsonrpc: '2.0', id: m.id, result })
})
rl.on('close', () => process.exit(0))
"#;

    struct Rig {
        root: PathBuf,
        host: McpHost,
    }

    impl Rig {
        /// The arguments `id`'s tools were called with, in order.
        fn calls(&self, id: &str) -> Vec<(String, Value)> {
            let path = self.root.join("ext").join(id).join("spec.json.calls");
            std::fs::read_to_string(path)
                .unwrap_or_default()
                .lines()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect()
        }

        async fn stop(self) {
            self.host.shutdown().await;
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// One fake plugin: (id, [(tool, capability, answer)]).
    type Fake<'a> = (&'a str, &'a [(&'a str, &'a str, Value)]);

    /// A started host over `plugins`.
    async fn rig(tag: &str, plugins: &[Fake<'_>]) -> Rig {
        rig_annotated(tag, plugins, &[]).await
    }

    /// `rig`, where a tool named in `annotations` as (plugin id, tool, annotations) lists them.
    async fn rig_annotated(
        tag: &str,
        plugins: &[Fake<'_>],
        annotations: &[(&str, &str, Value)],
    ) -> Rig {
        let root =
            std::env::temp_dir().join(format!("alexia-hub-sources-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (id, tools) in plugins {
            let dir = root.join("ext").join(id);
            std::fs::create_dir_all(&dir).unwrap();
            let provides: Vec<&str> = tools.iter().map(|t| t.1).collect();
            let manifest = json!({
                "manifest_version": 1,
                "id": id,
                "name": format!("Plugin {id}"),
                "summary": "A plugin that exists for tests.",
                "version": "0.1.0",
                "license": "AGPL-3.0-only",
                "entry": { "run": "node", "args": ["server.cjs", "spec.json"] },
                "alexia_protocol": 2,
                "mcp_protocol": "2025-11-25",
                "provides": provides,
            });
            let spec: Vec<Value> = tools
                .iter()
                .map(|(name, cap, answer)| {
                    let mut t = json!({"name": name, "cap": cap, "answer": answer});
                    if let Some((_, _, a)) =
                        annotations.iter().find(|(p, n, _)| p == id && n == name)
                    {
                        t["annotations"] = a.clone();
                    }
                    t
                })
                .collect();
            std::fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
            std::fs::write(dir.join("server.cjs"), SERVER).unwrap();
            std::fs::write(dir.join("spec.json"), json!({"tools": spec}).to_string()).unwrap();
        }
        let sink: EventSink = Arc::new(|_| {});
        let cfg = HostConfig {
            layout: Layout::new(root.join("data")),
            plugin_dirs: vec![root.join("ext")],
            node: crate::node(),
            // Cold Node starts on a loaded Windows machine are slow.
            timings: Timings {
                start_ms: 60_000,
                ..Timings::default()
            },
            dial: None,
        };
        let store = Arc::new(Store::open_in_memory().unwrap());
        let host = McpHost::new(cfg, store, Arc::new(NoUpcalls), sink);
        let ids: Vec<PluginId> = plugins.iter().map(|p| PluginId(p.0.into())).collect();
        host.start(&ids).await.unwrap();
        Rig { root, host }
    }

    fn patient(host: McpHost) -> HostSources {
        HostSources {
            per_call: Duration::from_secs(60),
            ..HostSources::new(host)
        }
    }

    fn items(keys: &[&str]) -> Value {
        let items: Vec<Value> = keys
            .iter()
            .map(|k| json!({"key": k, "text": format!("text of {k}"), "why": "w"}))
            .collect();
        json!({"content": [], "structuredContent": {"items": items}})
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn round_tells_a_failed_provider_from_one_that_answers() {
        let failed = json!({"content": [{"type": "text", "text": "broken"}], "isError": true});
        let rig = rig(
            "round",
            &[
                ("alpha", &[("offer", ITEMS, failed)]),
                ("beta", &[("offer", ITEMS, items(&["b:1"]))]),
                ("gamma", &[("offer", ITEMS, items(&[]))]),
            ],
        )
        .await;
        let sources = patient(rig.host.clone());
        let slot = |p: &str| (p.to_owned(), ITEMS.to_owned());
        // Twice: the second round uses the remembered tool names and lists the failed one again.
        for _ in 0..2 {
            let round = sources.round(1_000, 14).await;
            assert_eq!(round.failed, [slot("alpha")]);
            assert_eq!(round.answered, [slot("beta"), slot("gamma")]);
            let got: Vec<(&str, &str, &str)> = round
                .items
                .iter()
                .map(|(p, c, i)| (p.as_str(), c.as_str(), i.key.as_str()))
                .collect();
            assert_eq!(got, [("beta", ITEMS, "b:1")]);
        }
        let flat = sources.items(1_000, 14).await;
        assert_eq!(flat.len(), 1);
        assert_eq!(flat[0].0, ITEMS);
        let (tool, args) = rig.calls("beta").remove(0);
        assert_eq!(tool, "offer");
        assert_eq!(args["now"], json!(1_000));
        assert_eq!(args["horizon_days"], json!(14));
        assert_eq!(args["tz_offset_min"], time_args(1_000)["tz_offset_min"]);
        rig.stop().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sections_poll_and_done_go_through_the_host() {
        let section =
            |text: &str| json!({"content": [], "structuredContent": {"title": "T", "text": text}});
        let page =
            json!({"content": [{"type": "text", "text": "one"}, {"type": "text", "text": "two"}]});
        let closed = json!({"content": [], "structuredContent": {"closed": false}});
        let broken = json!({"content": [{"type": "text", "text": "no"}], "isError": true});
        let rig = rig(
            "sections",
            &[
                (
                    "alpha",
                    &[
                        ("brief", SECTION, section("Today: one thing.")),
                        ("close", DONE, closed.clone()),
                        ("look", "test.page", page),
                    ],
                ),
                (
                    "beta",
                    &[
                        ("brief", SECTION, section("  ")),
                        ("close", DONE, closed),
                        ("fail", "test.broken", broken),
                    ],
                ),
            ],
        )
        .await;
        let sources = patient(rig.host.clone());
        assert_eq!(
            sources.sections("weekly", 1_000).await,
            ["Today: one thing."]
        );
        let (_, args) = rig.calls("alpha").remove(0);
        assert_eq!(args["kind"], json!("weekly"));
        assert_eq!(args["now"], json!(1_000));
        assert!(args["tz_offset_min"].is_i64(), "{args}");

        assert_eq!(
            sources.poll("test.page", Map::new()).await.as_deref(),
            Some("one\ntwo")
        );
        assert_eq!(sources.poll("test.broken", Map::new()).await, None);
        assert_eq!(sources.poll("test.nobody", Map::new()).await, None);

        sources.done("a:1").await;
        for id in ["alpha", "beta"] {
            assert!(
                rig.calls(id)
                    .contains(&("close".to_owned(), json!({"key": "a:1"}))),
                "{id} was not told"
            );
        }
        rig.stop().await;
    }

    // ---- P3-39: what a watch may poll ----

    fn page() -> Value {
        json!({"content": [{"type": "text", "text": "the page"}]})
    }

    fn read_only() -> Value {
        json!({"readOnlyHint": true, "destructiveHint": false, "openWorldHint": true})
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn watchable_reviewed_read_only() {
        let rig = rig_annotated(
            "watch-ok",
            &[("alpha", &[("look", "test.page", page())])],
            &[("alpha", "look", read_only())],
        )
        .await;
        let sources = patient(rig.host.clone());
        assert_eq!(sources.watchable("test.page").await, Ok(()));
        rig.stop().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn not_read_only_refused() {
        let rig = rig_annotated(
            "watch-writes",
            &[
                ("alpha", &[("look", "test.none", page())]),
                ("beta", &[("look", "test.false", page())]),
                ("gamma", &[("look", "test.both", page())]),
                ("delta", &[("look", "test.empty", page())]),
            ],
            &[
                ("beta", "look", json!({"readOnlyHint": false})),
                (
                    "gamma",
                    "look",
                    json!({"readOnlyHint": true, "destructiveHint": true}),
                ),
                ("delta", "look", json!({"destructiveHint": false})),
            ],
        )
        .await;
        let sources = patient(rig.host.clone());
        for cap in ["test.none", "test.false", "test.both", "test.empty"] {
            let e = sources.watchable(cap).await.unwrap_err();
            assert!(e.starts_with(cap), "{cap}: {e}");
        }
        rig.stop().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unreviewed_refused() {
        let rig = rig_annotated(
            "watch-unreviewed",
            &[("alpha", &[("look", "test.page", page())])],
            &[("alpha", "look", read_only())],
        )
        .await;
        let sources = patient(rig.host.clone());
        assert_eq!(sources.watchable("test.page").await, Ok(()));
        rig.host
            .set_reviewed(&PluginId("alpha".into()), false)
            .unwrap();
        assert!(sources.watchable("test.page").await.is_err());
        rig.host
            .set_reviewed(&PluginId("alpha".into()), true)
            .unwrap();
        assert_eq!(sources.watchable("test.page").await, Ok(()));
        rig.stop().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn every_provider_checked() {
        let rig = rig_annotated(
            "watch-every",
            &[
                ("alpha", &[("look", "test.page", page())]),
                ("beta", &[("look", "test.page", page())]),
            ],
            &[
                ("alpha", "look", read_only()),
                ("beta", "look", json!({"readOnlyHint": false})),
            ],
        )
        .await;
        let sources = patient(rig.host.clone());
        assert!(sources.watchable("test.page").await.is_err());
        rig.stop().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn no_provider_refused() {
        let rig = rig_annotated(
            "watch-nobody",
            &[("alpha", &[("look", "test.other", page())])],
            &[("alpha", "look", read_only())],
        )
        .await;
        let sources = patient(rig.host.clone());
        assert_eq!(
            sources.watchable("test.page").await,
            Err("Nothing installed can be watched for test.page.".to_owned())
        );
        rig.stop().await;
    }
}
