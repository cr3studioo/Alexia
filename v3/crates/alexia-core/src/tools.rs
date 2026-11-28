// SPDX-License-Identifier: AGPL-3.0-only
//! Tooling over the MCP host, plus core's builtins. Ports v2 `packages/core/src/tooling.ts`
//! (`PluginTooling`, `outcomeOf`) and `trace.ts` `toolWords`.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use alexia_mcp::types::{CallToolResult, ProgressParams, ToolAnnotations};
use alexia_mcp::{CallCtx, CallError, HostedTool, McpHost, PluginId, PluginState};
use alexia_store::SessionId;
use serde_json::{Map, Value};

use crate::{Builtin, Produced, ToolCtx, ToolOutcome, ToolProgress, ToolSpec, Tooling, UndoCall};

/// v2 `NAME_LIMIT`: a provider rejects a function name longer than this.
const NAME_LIMIT: usize = 64;
const SEPARATOR: &str = "__";
/// v2 `FINAL_MAX`: the longest reply a tool may give the person itself.
const FINAL_MAX: usize = 4000;
/// v2 `STAGES_MAX`: past this many steps a pipeline is a texture, not a diagram.
const STAGES_MAX: usize = 64;
/// v2 `LABEL_MAX`: a label long enough to be a paragraph is not a label.
const LABEL_MAX: usize = 80;
/// Research runs kept at once (v2 `ResearchRuns`): the one quiet longest goes first.
const RESEARCH_KEPT: usize = 50;
/// The `_meta` keys a plugin puts on a progress notification (v2 `packages/protocol`).
const PREVIEW_META: &str = "alexia/preview";
const STAGES_META: &str = "alexia/stages";
const PLAN_META: &str = "alexia/plan";
const CONTROLS_META: &str = "alexia/controls";
const RESEARCH_META: &str = "alexia/research";
/// (P4-13) The argument a tool on several devices takes, and the device that is the hub.
const DEVICE: &str = "device";
const HUB: &str = "hub";
/// Prompt text: the model reads it on every tool offered on more than one computer.
const DEVICE_WORDS: &str = "Which computer. Leave out for the one the owner is using.";

/// (P4-13) The hub's word on which device answers a call that names none: the same closure
/// `McpHost::set_prefer` takes, handed `(capability, providers)` and answering them in order.
pub type Prefer = Arc<dyn Fn(&str, &[PluginId]) -> Vec<PluginId> + Send + Sync>;

pub struct McpTooling {
    host: McpHost,
    builtins: Mutex<Vec<Arc<dyn Builtin>>>,
    /// What the last `list()` saw, so a call need not ask every plugin again.
    listed: Mutex<Vec<HostedTool>>,
    /// The latest `alexia/research` snapshot per (plugin, session).
    research: Mutex<Research>,
    prefer: Mutex<Option<Prefer>>,
}

impl McpTooling {
    pub fn new(host: McpHost, builtins: Vec<Arc<dyn Builtin>>) -> McpTooling {
        McpTooling {
            host,
            builtins: Mutex::new(builtins),
            listed: Mutex::new(vec![]),
            research: Mutex::default(),
            prefer: Mutex::new(None),
        }
    }

    /// (P4-13) Which device a merged tool runs on when the model names none. Unset: the hub's
    /// own copy, else the first device online.
    pub fn set_prefer(&self, prefer: Prefer) {
        *self.prefer.lock().unwrap_or_else(|e| e.into_inner()) = Some(prefer);
    }

    /// (P4-13) The tool id a call to `name` with `args` really runs: for a tool offered on
    /// several devices, `<device>__<plugin>.<tool>` or the hub's `<plugin>__<tool>`, so the
    /// permission rules (and the silent list) judge the real target. Any other name is itself.
    pub async fn target(&self, name: &str, args: &Map<String, Value>) -> String {
        if self.is_builtin(name) {
            return name.to_owned();
        }
        self.route(name, &mut args.clone())
            .await
            .unwrap_or_else(|_| name.to_owned())
    }

    fn is_builtin(&self, name: &str) -> bool {
        self.builtins()
            .iter()
            .any(|b| b.specs().iter().any(|s| s.name == name))
    }

    /// The plugin tools as the model sees them: from the last `list()`, or fresh if `name` is
    /// not among them.
    async fn offered_with(&self, name: &str) -> Vec<Offered> {
        let cached = self
            .listed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let all = offered(&cached);
        if all.iter().any(|o| o.name == name) {
            return all;
        }
        offered(&self.host.tools().await)
    }

    /// The real tool id behind `name`, with `device` taken out of `args`. A name that is not a
    /// merged tool comes back unchanged; a device that does not have the tool is a failure.
    async fn route(
        &self,
        name: &str,
        args: &mut Map<String, Value>,
    ) -> Result<String, ToolOutcome> {
        let all = self.offered_with(name).await;
        let Some(o) = all.into_iter().find(|o| o.name == name && o.merged()) else {
            return Ok(name.to_owned());
        };
        let on = o
            .members
            .iter()
            .map(device_of)
            .collect::<Vec<_>>()
            .join(", ");
        let t = match args.remove(DEVICE) {
            Some(Value::String(d)) => o
                .members
                .iter()
                .find(|t| device_of(t) == d)
                .ok_or_else(|| failed(format!("{name} is not on {d}. It is on: {on}.")))?,
            Some(_) => return Err(failed(format!("device must be one of: {on}."))),
            None => self.preferred(&o),
        };
        Ok(namespaced(&t.plugin, &t.tool.name))
    }

    /// No device named: the first of the hub's preference for the tool's capability among the
    /// devices online, else the hub's own copy, else the first online.
    fn preferred<'a>(&self, o: &'a Offered) -> &'a HostedTool {
        let online = self.online();
        let up: Vec<&HostedTool> = o
            .members
            .iter()
            .filter(|t| t.device.is_none() || online.contains(&t.plugin))
            .collect();
        let prefer = self
            .prefer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let cap = o.members.iter().find_map(|t| t.provides.first());
        if let (Some(prefer), Some(cap)) = (prefer, cap) {
            let ids: Vec<PluginId> = up.iter().map(|t| t.plugin.clone()).collect();
            if let Some(t) = prefer(cap, &ids)
                .iter()
                .find_map(|id| up.iter().find(|t| &t.plugin == id))
            {
                return t;
            }
        }
        up.first().copied().unwrap_or(&o.members[0])
    }

    /// Plugins and servers that are not `Stopped`.
    fn online(&self) -> HashSet<PluginId> {
        self.host
            .plugins()
            .into_iter()
            .filter(|p| p.state != PluginState::Stopped)
            .map(|p| p.id)
            .collect()
    }

    /// The latest `alexia/research` snapshot a plugin sent for this session (v2
    /// `tooling.research.get`).
    pub fn research(&self, plugin: &PluginId, session: SessionId) -> Option<Value> {
        self.researching().get(&(plugin.clone(), session))
    }

    fn researching(&self) -> std::sync::MutexGuard<'_, Research> {
        self.research.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn add_builtin(&self, b: Arc<dyn Builtin>) {
        self.builtins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(b);
    }

    fn builtins(&self) -> Vec<Arc<dyn Builtin>> {
        self.builtins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

fn failed(text: impl Into<String>) -> ToolOutcome {
    ToolOutcome {
        text: text.into(),
        ok: false,
        files: vec![],
        final_text: None,
        undo: None,
        card: None,
    }
}

/// An MCP progress notification as a `ToolProgress` (v2 `tooling.ts` `onprogress`), without
/// `research`, which the call attaches from its own snapshot store.
pub fn progress_of(p: &ProgressParams) -> ToolProgress {
    let meta = p.meta.as_ref();
    let get = |k: &str| meta.and_then(|m| m.get(k));
    // The one field a plugin fills that ends up in an `img`: a `data:` picture or nothing,
    // so it never names a path or a host.
    let preview = get(PREVIEW_META)
        .and_then(Value::as_str)
        .filter(|s| s.starts_with("data:image/"))
        .map(str::to_string);
    let stages = get(STAGES_META).and_then(stages_of);
    let plan = stages.is_some() && get(PLAN_META) == Some(&Value::Bool(true));
    ToolProgress {
        progress: p.progress,
        total: p.total,
        message: p.message.clone(),
        preview,
        stages,
        plan,
        controls: get(CONTROLS_META).and_then(controls_of),
        research: None,
    }
}

/// v2 `stagesOf`: the stages a plugin sent, or nothing. Anything malformed drops the whole
/// strip: a pipeline with a step missing is a wrong picture.
fn stages_of(said: &Value) -> Option<Value> {
    let all = said.as_array().filter(|a| !a.is_empty())?;
    let mut out = Vec::new();
    for one in all.iter().take(STAGES_MAX) {
        let one = one.as_object()?;
        let state = one.get("state").and_then(Value::as_str)?;
        if !matches!(state, "waiting" | "running" | "done" | "failed") {
            return None;
        }
        let mut stage = Map::new();
        stage.insert("state".into(), Value::String(state.into()));
        for key in ["label", "detail"] {
            if let Some(s) = one.get(key).and_then(Value::as_str) {
                stage.insert(key.into(), Value::String(clip_utf16(s, LABEL_MAX)));
            }
        }
        for key in ["progress", "total"] {
            // serde_json has no NaN or infinity, so every number is finite.
            if let Some(n) = one.get(key).filter(|v| v.is_number()) {
                stage.insert(key.into(), n.clone());
            }
        }
        out.push(Value::Object(stage));
    }
    Some(Value::Array(out))
}

/// v2 `controlsOf`: at most three buttons, each a widget-like key and a short label.
fn controls_of(value: &Value) -> Option<Value> {
    let key_ok = |k: &str| {
        let mut cs = k.chars();
        cs.next().is_some_and(|c| c.is_ascii_lowercase())
            && k.len() <= 64
            && cs.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    };
    let kept: Vec<Value> = value
        .as_array()?
        .iter()
        .filter_map(|one| {
            let key = one.get("key")?.as_str().filter(|k| key_ok(k))?;
            let label = one.get("label")?.as_str()?.trim();
            if label.is_empty() {
                return None;
            }
            let mut c = Map::new();
            c.insert("key".into(), Value::String(key.into()));
            c.insert("label".into(), Value::String(clip_utf16(label, 24)));
            Some(Value::Object(c))
        })
        .take(3)
        .collect();
    (!kept.is_empty()).then_some(Value::Array(kept))
}

/// JS `slice(0, max)`: at most `max` UTF-16 units, never splitting a character.
fn clip_utf16(s: &str, max: usize) -> String {
    let mut n = 0;
    s.chars()
        .take_while(|c| {
            n += c.len_utf16();
            n <= max
        })
        .collect()
}

/// How a call that reported research ended.
#[derive(Clone, Copy)]
enum Ending {
    Complete,
    Failed,
    Cancelled,
}

type ResearchKey = (PluginId, SessionId);

/// One kept research run: whose call sent it, and the snapshot.
struct ResearchRun {
    key: ResearchKey,
    owner: u64,
    snapshot: Map<String, Value>,
}

/// v2 `ResearchRuns`: the latest run per (plugin, session), owned by the call that sent it.
/// Several calls to one plugin can be open at once; the newest call that has reported holds
/// the snapshot, so an older call cannot take it back.
#[derive(Default)]
struct Research {
    begun: u64,
    /// The calls open per key, each by the order it began in.
    open: HashMap<ResearchKey, HashSet<u64>>,
    /// Least recently updated first.
    runs: Vec<ResearchRun>,
}

impl Research {
    fn begin(&mut self, key: &ResearchKey) -> u64 {
        self.begun += 1;
        self.open.entry(key.clone()).or_default().insert(self.begun);
        self.begun
    }

    fn get(&self, key: &ResearchKey) -> Option<Value> {
        self.runs
            .iter()
            .find(|r| &r.key == key)
            .map(|r| Value::Object(r.snapshot.clone()))
    }

    fn accept(&mut self, key: &ResearchKey, owner: u64, raw: Option<&Value>) -> Option<Value> {
        let open = self.open.get(key)?;
        if !open.contains(&owner) {
            return None;
        }
        let mut next = research_update(raw?, &key.1 .0.to_string())?;
        let at = self.runs.iter().position(|r| &r.key == key);
        if let Some(i) = at {
            let before = &self.runs[i];
            if before.owner != owner && open.contains(&before.owner) && before.owner > owner {
                return None;
            }
            if before.owner == owner
                && (next.get("runId") != before.snapshot.get("runId")
                    || seq(&next) <= seq(&before.snapshot)
                    || before.snapshot.get("completion").and_then(Value::as_str) != Some("running"))
            {
                return None;
            }
        }
        recount(&mut next, false);
        // Re-inserted at the end, so the cap drops the run that went quiet longest.
        if let Some(i) = at {
            self.runs.remove(i);
        }
        self.runs.push(ResearchRun {
            key: key.clone(),
            owner,
            snapshot: next.clone(),
        });
        if self.runs.len() > RESEARCH_KEPT {
            self.runs.remove(0);
        }
        Some(Value::Object(next))
    }

    /// The call is over. A run still marked running is settled by how the call ended: a tool
    /// that returned its answer completed the research.
    fn close(&mut self, key: &ResearchKey, owner: u64, ending: Ending) {
        if let Some(open) = self.open.get_mut(key) {
            open.remove(&owner);
            if open.is_empty() {
                self.open.remove(key);
            }
        }
        let Some(run) = self
            .runs
            .iter_mut()
            .find(|r| &r.key == key && r.owner == owner)
        else {
            return;
        };
        let run = &mut run.snapshot;
        if run.get("completion").and_then(Value::as_str) != Some("running") {
            return;
        }
        if let Some(Value::Array(sources)) = run.get_mut("sources") {
            for s in sources.iter_mut().filter_map(Value::as_object_mut) {
                if s.get("state").and_then(Value::as_str) == Some("fetching") {
                    s.insert("state".into(), "unavailable".into());
                    s.insert(
                        "error".into(),
                        "Research stopped before extraction completed.".into(),
                    );
                }
            }
        }
        let (completion, gap) = match ending {
            Ending::Complete => ("complete", None),
            Ending::Failed => ("failed", Some("Worker stopped before completing research.")),
            Ending::Cancelled => ("cancelled", Some("Research cancelled.")),
        };
        run.insert("sequence".into(), (seq(run) + 1).into());
        run.insert("stage".into(), "finished".into());
        run.insert("completion".into(), completion.into());
        if let Some(Value::Array(gaps)) = run.get_mut("gaps") {
            gaps.extend(gap.map(Value::from));
            let extra = gaps.len().saturating_sub(20);
            gaps.drain(..extra);
        }
        recount(run, true);
    }
}

fn seq(s: &Map<String, Value>) -> u64 {
    s.get("sequence").and_then(Value::as_u64).unwrap_or(0)
}

/// v2 sets `counters` from the sources itself; a settled run has nothing in progress.
fn recount(s: &mut Map<String, Value>, settled: bool) {
    let count = |state: &str| {
        s.get("sources")
            .and_then(Value::as_array)
            .map_or(0, |a| a.iter().filter(|x| x["state"] == state).count())
    };
    let counters = serde_json::json!({
        "read": count("complete"),
        "inProgress": if settled { 0 } else { count("fetching") },
        "failed": count("unavailable"),
    });
    s.insert("counters".into(), counters);
}

/// A string of `min..=max` UTF-16 units (zod `.min` / `.max`).
fn text_ok(v: &Value, min: usize, max: usize) -> bool {
    v.as_str()
        .is_some_and(|s| (min..=max).contains(&s.encode_utf16().count()))
}

fn id_ok(v: &Value) -> bool {
    text_ok(v, 1, 128)
}

fn one_of(v: &Value, allowed: &[&str]) -> bool {
    v.as_str().is_some_and(|s| allowed.contains(&s))
}

fn non_negative(v: &Value) -> bool {
    v.as_f64().is_some_and(|n| n >= 0.0)
}

/// An `http(s)` URL with a host and no user name or password (v2 `webUrl`).
fn web_url_ok(v: &Value) -> bool {
    let Some(s) = v.as_str().filter(|_| text_ok(v, 1, 4096)) else {
        return false;
    };
    let lower = s.to_ascii_lowercase();
    let Some(rest) = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
    else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    !authority.is_empty() && !authority.contains('@') && !s.contains(char::is_whitespace)
}

/// Copies `key` if `ok` accepts it. A key that is there and fails, or a required one that is
/// missing, fails the whole snapshot.
fn pick(
    from: &Map<String, Value>,
    into: &mut Map<String, Value>,
    key: &str,
    required: bool,
    ok: impl Fn(&Value) -> bool,
) -> Option<()> {
    match from.get(key) {
        Some(v) if ok(v) => {
            into.insert(key.into(), v.clone());
            Some(())
        }
        Some(_) => None,
        None if required => None,
        None => Some(()),
    }
}

fn in_unit(b: &Value, k: &str) -> bool {
    b.get(k)
        .and_then(Value::as_f64)
        .is_some_and(|n| (0.0..=1.0).contains(&n))
}

fn passage_of(v: &Value) -> Option<Value> {
    let p = v.as_object()?;
    let mut out = Map::new();
    pick(p, &mut out, "id", true, id_ok)?;
    pick(p, &mut out, "text", true, |v| text_ok(v, 1, 2500))?;
    pick(p, &mut out, "box", false, |b| {
        ["x", "y", "width", "height"].iter().all(|k| in_unit(b, k))
    })?;
    if let Some(b) = out.get_mut("box").and_then(Value::as_object_mut) {
        b.retain(|k, _| matches!(k.as_str(), "x" | "y" | "width" | "height"));
    }
    Some(Value::Object(out))
}

fn source_of(v: &Value) -> Option<Value> {
    let s = v.as_object()?;
    let mut out = Map::new();
    pick(s, &mut out, "id", true, id_ok)?;
    pick(s, &mut out, "url", true, web_url_ok)?;
    pick(s, &mut out, "title", true, |v| text_ok(v, 0, 1000))?;
    pick(s, &mut out, "state", true, |v| {
        one_of(v, &["fetching", "complete", "unavailable"])
    })?;
    pick(s, &mut out, "retrievedAt", false, |v| text_ok(v, 0, 64))?;
    pick(s, &mut out, "error", false, |v| text_ok(v, 0, 1000))?;
    pick(s, &mut out, "text", false, |v| text_ok(v, 0, 6000))?;
    pick(s, &mut out, "preview", false, |v| text_ok(v, 0, 4096))?;
    let passages = match s.get("passages") {
        None => vec![],
        Some(p) => {
            let all = p.as_array().filter(|a| a.len() <= 6)?;
            all.iter().map(passage_of).collect::<Option<Vec<_>>>()?
        }
    };
    out.insert("passages".into(), Value::Array(passages));
    Some(Value::Object(out))
}

/// v2 `ResearchUpdate.safeParse`, for this conversation only: a complete bounded snapshot with
/// unknown keys dropped, or nothing. Source ids must be distinct.
fn research_update(raw: &Value, conversation: &str) -> Option<Map<String, Value>> {
    let r = raw.as_object()?;
    let mut out = Map::new();
    pick(r, &mut out, "runId", true, id_ok)?;
    pick(r, &mut out, "conversationId", true, |v| {
        id_ok(v) && v.as_str() == Some(conversation)
    })?;
    pick(r, &mut out, "sequence", true, |v| v.as_u64().is_some())?;
    pick(r, &mut out, "topic", true, |v| text_ok(v, 1, 2000))?;
    pick(r, &mut out, "startedAt", true, non_negative)?;
    pick(r, &mut out, "elapsedMs", true, non_negative)?;
    pick(r, &mut out, "stage", true, |v| {
        one_of(v, &["searching", "reading", "writing", "finished"])
    })?;
    pick(r, &mut out, "currentSourceId", false, id_ok)?;
    pick(r, &mut out, "counters", true, |c| {
        ["read", "inProgress", "failed"]
            .iter()
            .all(|k| c.get(k).and_then(Value::as_u64).is_some())
    })?;
    pick(r, &mut out, "completion", true, |v| {
        one_of(v, &["running", "complete", "failed", "cancelled"])
    })?;
    pick(r, &mut out, "report", false, |v| {
        v.get("path").is_some_and(|p| text_ok(p, 0, 4096))
            && v.get("name").is_some_and(|n| text_ok(n, 0, 255))
    })?;
    if let Some(report) = out.get_mut("report").and_then(Value::as_object_mut) {
        report.retain(|k, _| k == "path" || k == "name");
    }
    let sources = r.get("sources")?.as_array().filter(|a| a.len() <= 12)?;
    let sources = sources.iter().map(source_of).collect::<Option<Vec<_>>>()?;
    let ids: HashSet<&str> = sources.iter().filter_map(|s| s["id"].as_str()).collect();
    if ids.len() != sources.len() {
        return None;
    }
    out.insert("sources".into(), Value::Array(sources));
    let gaps = match r.get("gaps") {
        None => vec![],
        Some(g) => {
            let all = g.as_array().filter(|a| a.len() <= 20)?;
            if !all.iter().all(|x| text_ok(x, 0, 1000)) {
                return None;
            }
            all.clone()
        }
    };
    out.insert("gaps".into(), Value::Array(gaps));
    Some(out)
}

#[async_trait::async_trait]
impl Tooling for McpTooling {
    async fn list(&self) -> Vec<ToolSpec> {
        let mut specs: Vec<ToolSpec> = self.builtins().iter().flat_map(|b| b.specs()).collect();
        let tools = self.host.tools().await;
        *self.listed.lock().unwrap_or_else(|e| e.into_inner()) = tools.clone();
        let online = self.online();
        for o in offered(&tools) {
            let name = o.name.clone();
            if name.len() > NAME_LIMIT {
                tracing::warn!(
                    "{}: \"{}\" is unreachable, {} characters and a model-facing tool name may be {NAME_LIMIT}",
                    o.members[0].plugin.0,
                    o.members[0].tool.name,
                    name.len()
                );
                continue;
            }
            if o.merged() {
                specs.extend(merged_spec(o, &online));
                continue;
            }
            let t = o
                .members
                .into_iter()
                .next()
                .expect("an offered tool has one");
            specs.push(ToolSpec {
                words: tool_words(&name, t.tool.description.as_deref()),
                description: t.tool.description.unwrap_or_default(),
                params: t.tool.input_schema,
                annotations: t.tool.annotations,
                reviewed: t.reviewed,
                plugin: Some(t.plugin),
                name,
            });
        }
        specs
    }

    async fn call(&self, name: &str, args: Map<String, Value>, ctx: ToolCtx) -> ToolOutcome {
        for b in self.builtins() {
            if let Some(outcome) = b.call(name, &args, &ctx).await {
                return outcome;
            }
        }
        let no_tool = || failed(format!("There is no tool called {name}."));
        let gone = || failed("That tool is gone (its plugin was removed). Plan without it.");
        // `list()` never offers a name past the limit, so `call()` does not take one.
        if name.len() > NAME_LIMIT {
            return no_tool();
        }
        // A tool on several devices: `device` picks the copy and is not the tool's to see.
        let mut args = args;
        let real = match self.route(name, &mut args).await {
            Ok(real) => real,
            Err(failure) => return failure,
        };
        let Some((plugin, tool)) = real.split_once(SEPARATOR) else {
            return no_tool();
        };
        let plugin = PluginId(plugin.to_string());
        let installed = |host: &McpHost| host.plugins().iter().any(|p| p.id == plugin);
        if !installed(&self.host) {
            return no_tool();
        }
        // Hidden tools (compute, editor) are not the model's to call; and listing is what
        // notices a deleted folder, so a plugin missing afterwards vanished just now.
        let is_it = |t: &HostedTool| t.plugin == plugin && t.tool.name == tool && !t.hidden;
        let cached = self
            .listed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|t| is_it(t))
            .cloned();
        let found = match cached {
            Some(t) => Some(t),
            None => self.host.tools().await.into_iter().find(is_it),
        };
        let Some(found) = found else {
            return if installed(&self.host) {
                no_tool()
            } else {
                gone()
            };
        };
        // v2 resolves declared attachment inputs through a per-conversation picture store;
        // v3 core has none yet, so v2's "no pictures here" answer is the honest one.
        if found
            .tool
            .meta
            .as_ref()
            .is_some_and(|m| m.contains_key("alexia/attachmentInputs"))
        {
            return failed(format!(
                "{name} works on pictures in a conversation, and this call has none."
            ));
        }

        let key: ResearchKey = (plugin.clone(), ctx.session);
        let owner = self.researching().begin(&key);
        let (tx, mut rx) = tokio::sync::mpsc::channel::<ProgressParams>(64);
        let out = ctx.progress.clone();
        let forward = async {
            while let Some(p) = rx.recv().await {
                let mut progress = progress_of(&p);
                let said = p.meta.as_ref().and_then(|m| m.get(RESEARCH_META));
                progress.research = self.researching().accept(&key, owner, said);
                if let Some(out) = &out {
                    // Lossy on purpose: a slow reader drops a frame rather than stall the call.
                    let _ = out.try_send(progress);
                }
            }
        };
        let call_ctx = CallCtx {
            conversation: Some(ctx.session.0.to_string()),
            progress: ctx.progress.is_some().then_some(tx),
            cancel: ctx.cancel.clone(),
            meta: Map::new(),
        };
        // The host drops its sender with the call, so the forwarder drains and ends.
        let (result, ()) =
            tokio::join!(self.host.call_tool(&plugin, tool, args, call_ctx), forward);
        let ending = match &result {
            _ if ctx.cancel.is_cancelled() => Ending::Cancelled,
            Ok(r) if r.is_error != Some(true) => Ending::Complete,
            Err(CallError::Cancelled) => Ending::Cancelled,
            _ => Ending::Failed,
        };
        self.researching().close(&key, owner, ending);
        match result {
            Ok(r) => {
                let mut out = outcome_of(&r);
                // The plugin names its own tools; the model, and so `call`, knows them by
                // `<plugin>__<tool>`.
                // An undo is always the returning plugin's own tool: a target that names another
                // plugin's tool or a core builtin would let one plugin plant a call to it.
                if let Some(u) = out.undo.as_mut() {
                    let builtin = self
                        .builtins()
                        .iter()
                        .any(|b| b.specs().iter().any(|s| s.name == u.tool));
                    if builtin || u.tool.contains(SEPARATOR) {
                        tracing::warn!(plugin = %plugin.0, target = %u.tool, "undo naming a tool not its own dropped");
                        out.undo = None;
                    } else {
                        u.tool = namespaced(&plugin, &u.tool);
                    }
                }
                // No undo the model could not call: a hidden or over-long target is dropped. One
                // offered on several devices is named as offered, pinned to the device that ran.
                if let Some(u) = out.undo.as_mut() {
                    let all = offered(&self.host.tools().await);
                    let hit = all.iter().find_map(|o| {
                        o.members
                            .iter()
                            .find(|t| namespaced(&t.plugin, &t.tool.name) == u.tool)
                            .map(|t| (o, t))
                    });
                    match hit {
                        Some((o, t)) if o.name.len() <= NAME_LIMIT => {
                            if o.merged() {
                                u.tool = o.name.clone();
                                u.arguments.insert(DEVICE.into(), device_of(t).into());
                            }
                        }
                        _ => out.undo = None,
                    }
                }
                out
            }
            Err(CallError::Gone) => gone(),
            Err(CallError::Off { sentence }) => failed(sentence),
            Err(CallError::Timeout) => failed(format!(
                "{name} did not answer in time. Try something else."
            )),
            Err(CallError::Rpc(e)) => failed(format!("{name} failed: {}", e.message)),
            Err(CallError::Cancelled) => failed("Stopped."),
        }
    }
}

/// `<plugin id>__<tool>`, v2's namespacing; a builtin keeps its own name.
pub fn namespaced(plugin: &PluginId, tool: &str) -> String {
    format!("{}{SEPARATOR}{tool}", plugin.0)
}

/// (P4-13) One plugin tool as the model sees it. `members` are its copies, the hub's first:
/// more than one is one tool with a `device` argument, named `<plugin>__<tool>`.
struct Offered {
    name: String,
    members: Vec<HostedTool>,
}

impl Offered {
    fn merged(&self) -> bool {
        self.members.len() > 1
    }
}

/// `"hub"` for a local tool, else the device id of the server it came from.
fn device_of(t: &HostedTool) -> &str {
    t.device.as_deref().unwrap_or(HUB)
}

/// The visible tools, those that are one `(plugin, tool)` together: a local tool's key is
/// `(plugin, name)`, a remote one's its name split at the first `.`. Alone, a tool keeps its
/// namespaced name, so a tool only one device has says which in its name.
fn offered(tools: &[HostedTool]) -> Vec<Offered> {
    let mut out: Vec<Offered> = vec![];
    let mut keyed: HashMap<(String, String), usize> = HashMap::new();
    for t in tools.iter().filter(|t| !t.hidden) {
        let key = match &t.device {
            None => Some((t.plugin.0.clone(), t.tool.name.clone())),
            Some(_) => t
                .tool
                .name
                .split_once('.')
                .map(|(p, n)| (p.to_owned(), n.to_owned())),
        };
        if let Some(&i) = key.as_ref().and_then(|k| keyed.get(k)) {
            let o = &mut out[i];
            o.members.push(t.clone());
            o.members.sort_by_key(|t| t.device.is_some());
            if let Some((p, n)) = key {
                o.name = format!("{p}{SEPARATOR}{n}");
            }
            continue;
        }
        if let Some(k) = key {
            keyed.insert(k, out.len());
        }
        out.push(Offered {
            name: namespaced(&t.plugin, &t.tool.name),
            members: vec![t.clone()],
        });
    }
    out
}

/// A merged tool's spec: the hub's schema (else the first device's) plus `device`, listing the
/// hub and every device online; the most cautious annotations. None when no copy can run.
fn merged_spec(o: Offered, online: &HashSet<PluginId>) -> Option<ToolSpec> {
    let devices: Vec<Value> = o
        .members
        .iter()
        .filter(|t| t.device.is_none() || online.contains(&t.plugin))
        .map(|t| Value::from(device_of(t)))
        .collect();
    if devices.is_empty() {
        return None;
    }
    let first = &o.members[0];
    let mut params = first.tool.input_schema.clone();
    if let Some(schema) = params.as_object_mut() {
        let props = schema
            .entry("properties")
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(props) = props.as_object_mut() {
            props.insert(
                DEVICE.into(),
                serde_json::json!({ "type": "string", "enum": devices, "description": DEVICE_WORDS }),
            );
        }
    }
    let description = first.tool.description.clone().unwrap_or_default();
    Some(ToolSpec {
        words: tool_words(&o.name, Some(&description)),
        description,
        params,
        annotations: cautious(o.members.iter().map(|t| t.tool.annotations.as_ref())),
        reviewed: o.members.iter().all(|t| t.reviewed),
        plugin: Some(first.plugin.clone()),
        name: o.name,
    })
}

/// The most cautious of several tools' annotations: destructive or open world if any is, read
/// only or idempotent only if all are. A hint every copy leaves out stays out.
fn cautious<'a>(all: impl Iterator<Item = Option<&'a ToolAnnotations>>) -> Option<ToolAnnotations> {
    let all: Vec<Option<&ToolAnnotations>> = all.collect();
    if all.iter().all(Option::is_none) {
        return None;
    }
    // A hint left out is MCP's default: not read only, destructive, not idempotent, open world.
    let hint = |f: fn(&ToolAnnotations) -> Option<bool>, default: bool, worst: bool| {
        let said: Vec<Option<bool>> = all.iter().map(|a| a.and_then(f)).collect();
        if said.windows(2).all(|w| w[0] == w[1]) {
            return said[0];
        }
        let any_worst = said.iter().any(|h| h.unwrap_or(default) == worst);
        Some(if any_worst { worst } else { !worst })
    };
    Some(ToolAnnotations {
        title: all.iter().find_map(|a| a.and_then(|a| a.title.clone())),
        read_only_hint: hint(|a| a.read_only_hint, false, false),
        destructive_hint: hint(|a| a.destructive_hint, true, true),
        idempotent_hint: hint(|a| a.idempotent_hint, false, false),
        open_world_hint: hint(|a| a.open_world_hint, true, true),
    })
}

/// A `resource_link` URI to a path on this machine, through the shared decoder. A network
/// share is refused (stat'ing one makes Windows talk SMB to that server), and on Windows only a
/// drive-letter path is local: `/x` or `\x` would be drive-relative.
fn file_uri_path(uri: &str) -> Option<PathBuf> {
    let path = alexia_mcp::file_uri_path(uri)?;
    let s = path.to_string_lossy();
    if alexia_mcp::is_network_path(&s) {
        return None;
    }
    let b = s.as_bytes();
    let drive = b.len() > 1 && b[0].is_ascii_alphabetic() && b[1] == b':';
    if cfg!(windows) && !drive {
        return None;
    }
    Some(path)
}

/// v2 `mimeOf`: from the name alone.
fn mime_of(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map_or("", |(_, e)| e).to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "xml" => "application/xml",
        "html" => "text/html",
        "zip" => "application/zip",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

/// v2 `produced`: a `resource_link` as a file on this machine, only if it is a `file:` URI
/// naming a file that is there.
fn produced(block: &Value) -> Option<Produced> {
    let path = file_uri_path(block["uri"].as_str()?)?;
    let meta = std::fs::metadata(&path).ok().filter(|m| m.is_file())?;
    let name = block["name"]
        .as_str()
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .or_else(|| path.file_name().map(|n| n.to_string_lossy().into_owned()))?;
    let mime = block["mimeType"]
        .as_str()
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| mime_of(&name))
        .to_string();
    Some(Produced {
        name,
        path,
        bytes: meta.len(),
        mime,
    })
}

fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// v2 `cardOf`: text fields only, a handful, and a link only to a web page.
fn card_of(v: &Value) -> Option<Value> {
    let title = v.get("title")?.as_str()?;
    let fields: Map<String, Value> = v
        .get("fields")?
        .as_object()?
        .iter()
        .filter_map(|(k, val)| {
            let text = match val {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => return None,
            };
            Some((clip(k, 40), Value::String(clip(&text, 400))))
        })
        .take(8)
        .collect();
    if fields.is_empty() {
        return None;
    }
    let mut card = Map::new();
    card.insert("title".into(), Value::String(clip(title, 200)));
    card.insert("fields".into(), Value::Object(fields));
    if let Some(url) = v.get("url").and_then(Value::as_str) {
        let lower = url.to_ascii_lowercase();
        let rest = lower
            .strip_prefix("https://")
            .or_else(|| lower.strip_prefix("http://"));
        if rest.is_some_and(|r| !r.is_empty()) && !url.contains(char::is_whitespace) {
            card.insert("url".into(), Value::String(clip(url, 2000)));
        }
    }
    Some(Value::Object(card))
}

/// An MCP result as the model reads it (v2 `outcomeOf`): text blocks joined, a `resource_link`
/// named and kept as a produced file, other blocks named; `alexia/final`, `alexia/card` and
/// `alexia/undo` read from `_meta`.
pub fn outcome_of(result: &CallToolResult) -> ToolOutcome {
    let mut files = vec![];
    let parts: Vec<String> = result
        .content
        .iter()
        .map(|block| match block["type"].as_str().unwrap_or("") {
            "text" => block["text"].as_str().unwrap_or("").to_string(),
            "resource_link" => match produced(block) {
                Some(one) => {
                    let line = format!("[file: {}]", one.name);
                    files.push(one);
                    line
                }
                None => {
                    let name = block["name"]
                        .as_str()
                        .or_else(|| block["uri"].as_str())
                        .unwrap_or("unnamed");
                    format!("[file: {name} — not written]")
                }
            },
            other => format!("[{other}]"),
        })
        .collect();
    let text = parts.join("\n").trim().to_string();
    let ok = result.is_error != Some(true);
    let meta = result.meta.as_ref();
    // A failure is always the model's to explain, so these ride only on a call that worked.
    let final_text = meta
        .filter(|_| ok)
        .and_then(|m| m.get("alexia/final")?.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| clip(s, FINAL_MAX));
    let undo = meta
        .filter(|_| ok)
        .and_then(|m| serde_json::from_value::<UndoCall>(m.get("alexia/undo")?.clone()).ok());
    let card = meta.and_then(|m| card_of(m.get("alexia/card")?));
    ToolOutcome {
        text: if text.is_empty() {
            if ok {
                "Done.".into()
            } else {
                "The tool failed and said nothing.".into()
            }
        } else {
            text
        },
        ok,
        files,
        final_text,
        undo,
        card,
    }
}

/// v2 `toolWords`: the first clause of the description, lower-cased to sit in a sentence,
/// else the name with its seams taken out.
pub fn tool_words(name: &str, description: Option<&str>) -> String {
    let desc = description.unwrap_or("").trim();
    // First sentence: up to whitespace after `.`, `!` or `?`, or a newline.
    let mut end = desc.len();
    let mut prev_stop = false;
    for (i, c) in desc.char_indices() {
        if c == '\n' || (prev_stop && c.is_whitespace()) {
            end = i;
            break;
        }
        prev_stop = matches!(c, '.' | '!' | '?');
    }
    let first = &desc[..end];
    let clause = first
        .split([',', ';', ':', '('])
        .next()
        .unwrap_or("")
        .split(" — ")
        .next()
        .unwrap_or("")
        .trim_end_matches(['.', '!', '?'])
        .trim();
    if !clause.is_empty() && clause.chars().count() <= 70 {
        let mut cs = clause.chars();
        let (a, b) = (cs.next(), cs.next());
        // Lower-case the first letter unless it starts an acronym.
        return match (a, b) {
            (Some(a), Some(b)) if a.is_ascii_uppercase() && b.is_ascii_lowercase() => {
                format!("{}{}", a.to_ascii_lowercase(), &clause[1..])
            }
            _ => clause.to_string(),
        };
    }
    let base = name.split_once(SEPARATOR).map_or(name, |(_, t)| t);
    // Runs of `_` and `.` become one space.
    let mut out = String::new();
    for c in base.chars() {
        if matches!(c, '_' | '.') {
            if !out.ends_with(' ') {
                out.push(' ');
            }
        } else {
            out.push(c);
        }
    }
    out.trim().to_string()
}
