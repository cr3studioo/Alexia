// SPDX-License-Identifier: AGPL-3.0-only
//! The plugins screen: panes, settings, trust, install, servers (INVENTORY P1–P7).
//!
//! A port of v2 `plugins.ts` (`panes`, `setSetting`, `upload`, `problems`), `settings.ts`
//! (`pane`, `render`, `refuse`, `write`) and serve.ts 2534–2641, 2789–2980, 3199–3229, over
//! `McpHost` and the store. Nothing here spawns a plugin: a pane is drawn from the manifest,
//! the store and the keychain. No plugin is named: a widget is found by its declared type.
//!
//! A `password` value never leaves Credential Manager: a pane says only whether one is set.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::util::{js_string, megabytes, persist_enabled, safe_name, CORE};
use alexia_core::prompt::Skills;
use alexia_mcp::manifest::Setting;
use alexia_mcp::{Manifest, McpHost, PluginId, PluginState, PluginStatus};
use alexia_store::secrets;
use axum::extract::{Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Router};
use base64::Engine;
use serde_json::{json, Map, Value};

use crate::gate::Sent;
use crate::json;
use crate::Api;

/// kv `_core` keys this screen reads: the hub's enabled list, the list the gate reads for
/// trust (P2-62), and what v2's probe said each added server offers.
const UNREVIEWED: &str = "unreviewed";
const OFFERS: &str = "mcp_offers";

/// v2's `upload` ceiling: the most one attachment may be.
const MOST_PER_FILE: usize = 25 * 1024 * 1024;

/// v2 `DEFAULT_PAGE_AT`: where a page built from a panel sits on the board.
const DEFAULT_PAGE_AT: [u32; 2] = [12, 10];

/// Read-only widgets: the plugin drives them, the owner cannot type into them (v2 `DRIVEN`).
const DRIVEN: &[&str] = &["status", "progress", "action", "research"];

/// Registers this area's INVENTORY rows (path + method).
pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new()
        .route("/api/plugins", get(list))
        .route("/api/plugin", post(lifecycle))
        .route("/api/install", post(install))
        .route("/api/server", post(server))
        .route("/api/settings", post(settings))
        .route("/api/upload", post(upload))
        .route("/api/plugin-file", get(plugin_file))
}

fn host(api: &Api) -> &McpHost {
    &api.parts.host
}

fn text<'a>(sent: &'a Map<String, Value>, key: &str) -> &'a str {
    sent.get(key).and_then(Value::as_str).unwrap_or("")
}

// ---- GET /api/plugins ----

/// serve.ts 2534–2547.
async fn list(State(api): State<Arc<Api>>) -> Response {
    let (skills, skill_problems) = skills(&api);
    json::ok(json!({
        "panes": panes(&api),
        "problems": host(&api)
            .problems()
            .into_iter()
            .map(|(dir, reason)| json!({ "dir": dir.to_string_lossy(), "reason": reason }))
            .collect::<Vec<_>>(),
        "skills": skills,
        "unreviewed": unreviewed(&api),
        "offers": offers(&api),
        "skillProblems": skill_problems,
    }))
}

/// The skill folders the hub loads (its data's skills folder and the enabled plugins'
/// declared ones), re-read so a broken one shows here. A skill is v2's `{name, description,
/// dir}`, with `pluginId` when it came with a plugin.
fn skills(api: &Api) -> (Vec<Value>, Vec<Value>) {
    let mut dirs = vec![api.parts.layout.skills()];
    let mut owners: Vec<(PathBuf, String)> = vec![];
    for p in host(api).manifests() {
        for f in &p.manifest.skills {
            let dir = p.path.join(f);
            owners.push((dir.clone(), p.manifest.id.clone()));
            dirs.push(dir);
        }
    }
    let (loaded, problems) = Skills::load(&dirs);
    let skills = loaded
        .list()
        .map(|(name, description, dir)| {
            let mut skill = json!({
                "name": name,
                "description": description,
                "dir": dir.to_string_lossy(),
            });
            if let Some((_, id)) = owners
                .iter()
                .find(|(o, _)| dir.parent() == Some(o.as_path()))
            {
                skill["pluginId"] = json!(id);
            }
            skill
        })
        .collect();
    let problems = problems
        .into_iter()
        .map(|p| json!({ "dir": p.dir.to_string_lossy(), "reason": p.why }))
        .collect();
    (skills, problems)
}

/// kv `_core`/`unreviewed`, the list `McpHost::tools` reads; anything unreadable is empty.
fn unreviewed(api: &Api) -> Vec<String> {
    api.parts
        .store
        .kv_get(CORE, UNREVIEWED)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// What each added server said it offers (v2 `offered`): an object, else `{}`.
fn offers(api: &Api) -> Value {
    match api.parts.store.kv_get(CORE, OFFERS) {
        Ok(Some(v @ Value::Object(_))) => v,
        _ => json!({}),
    }
}

/// Every loaded plugin's page, by id (v2 `panes`).
fn panes(api: &Api) -> Vec<Value> {
    let mut all = host(api).plugins();
    all.sort_by(|a, b| a.id.cmp(&b.id));
    all.iter()
        .filter_map(|status| {
            let dir = host(api).plugin_dir(&status.id)?;
            Some(pane(api, status, &dir.manifest))
        })
        .collect()
}

/// v2 `secretStoreName`: where a `password` actually goes, in core's words.
fn secret_store_name() -> &'static str {
    if cfg!(windows) {
        "Stored in Windows Credential Manager."
    } else if cfg!(target_os = "macos") {
        "Stored in the macOS keychain."
    } else {
        "Stored in the system secret service."
    }
}

/// A declared setting as the manifest wrote it.
fn setting_json(s: &Setting) -> Value {
    let mut m = s.widget.clone();
    m.insert("key".into(), json!(s.key));
    m.insert("type".into(), json!(s.kind));
    if let Some(d) = &s.default {
        m.insert("default".into(), d.clone());
    }
    Value::Object(m)
}

/// `panel.widgets`, as the manifest wrote them.
fn panel_widgets(m: &Manifest) -> Vec<Value> {
    m.panel
        .as_ref()
        .and_then(|p| p.get("widgets"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// v2 `declaredWidgets`: `settings` and `panel.widgets` are one namespace (D86).
fn declared_widgets(m: &Manifest) -> Vec<Value> {
    m.settings
        .iter()
        .map(setting_json)
        .chain(panel_widgets(m))
        .collect()
}

fn kind(w: &Value) -> &str {
    w.get("type").and_then(Value::as_str).unwrap_or("")
}

fn key_of(w: &Value) -> &str {
    w.get("key").and_then(Value::as_str).unwrap_or("")
}

fn label(w: &Value) -> &str {
    w.get("label")
        .and_then(Value::as_str)
        .unwrap_or_else(|| key_of(w))
}

fn has_secret(plugin: &str, key: &str) -> bool {
    matches!(secrets::get(plugin, key), Ok(Some(_)))
}

/// One plugin's page: its chrome, its form filled in, and its panel under it (v2 `pane`).
fn pane(api: &Api, status: &PluginStatus, m: &Manifest) -> Value {
    let stored = api.parts.store.settings(&m.id).unwrap_or_default();
    let tools = host(api).tool_names(&status.id);
    let all = declared_widgets(m);
    let draw = Drawing {
        m,
        all: &all,
        stored: &stored,
        tools: tools.as_deref(),
    };
    let settings: Vec<Value> = m.settings.iter().map(setting_json).collect();
    let mut out = json!({
        "id": m.id,
        "name": m.name,
        "summary": m.summary,
        "version": m.version,
        "license": m.license,
        "enabled": status.enabled,
        "running": status.state == PluginState::Running,
        "requires": m.requires.iter().map(|r| json!({ "cap": r.cap, "why": r.why })).collect::<Vec<_>>(),
        "settings": draw.render(&settings),
        "page": page_of(m),
    });
    match status.state {
        PluginState::Unhealthy => {
            out["state"] = json!("unhealthy");
            out["reason"] = json!(status
                .sentence
                .clone()
                .unwrap_or_else(|| format!("{} was switched off.", m.name)));
        }
        // A plugin this build cannot run: the page says why, as its status does.
        PluginState::Refused => {
            if let Some(s) = &status.sentence {
                out["reason"] = json!(s);
            }
        }
        _ => {}
    }
    if let Some(panel) = &m.panel {
        out["panel"] = json!({
            "label": panel.get("label").cloned().unwrap_or(json!("")),
            "widgets": draw.render(&panel_widgets(m)),
        });
    }
    out
}

/// What a page needs to draw a declared widget (v2 `PaneOptions`); none of it spawns.
struct Drawing<'a> {
    m: &'a Manifest,
    all: &'a [Value],
    stored: &'a Map<String, Value>,
    tools: Option<&'a [String]>,
}

impl Drawing<'_> {
    fn find(&self, key: &str) -> Option<&Value> {
        self.all.iter().find(|w| key_of(w) == key)
    }

    /// The owner's value, else the manifest's default. A stored `null` is no value (JS `??`).
    fn value_of(&self, key: &str) -> Option<Value> {
        self.stored
            .get(key)
            .filter(|v| !v.is_null())
            .cloned()
            .or_else(|| {
                self.find(key)
                    .and_then(|w| w.get("default"))
                    .filter(|v| !v.is_null())
                    .cloned()
            })
    }

    /// Whether the widget behind `key` holds anything; a `password` is asked of the keychain.
    fn filled(&self, key: &str) -> bool {
        if self.find(key).is_some_and(|w| kind(w) == "password") {
            return has_secret(&self.m.id, key);
        }
        match self.value_of(key) {
            None => false,
            Some(Value::Array(a)) => !a.is_empty(),
            Some(Value::String(s)) => !s.is_empty(),
            Some(Value::Bool(b)) => b,
            Some(_) => true,
        }
    }

    /// Which keys another widget's existence, or an option's availability, depends on.
    fn gating(&self) -> HashSet<String> {
        let mut gating = HashSet::new();
        for w in self.all {
            if let Some(k) = w.pointer("/when/key").and_then(Value::as_str) {
                gating.insert(k.to_owned());
            }
            if kind(w) != "choice" {
                continue;
            }
            for one in w
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(n) = one.get("needs").and_then(Value::as_str) {
                    gating.insert(n.to_owned());
                }
            }
        }
        gating
    }

    /// v2 `render`: a declared list, filled in with what core knows right now.
    fn render(&self, list: &[Value]) -> Vec<Value> {
        let gating = self.gating();
        let mut out = Vec::new();
        for declared in list {
            let Some(mut w) = declared.as_object().cloned() else {
                continue;
            };
            let key = key_of(declared).to_owned();
            // Gone rather than greyed: a widget that does not apply to what is chosen.
            if let Some(when) = declared.get("when") {
                let on = when.get("key").and_then(Value::as_str).unwrap_or("");
                let now = self
                    .value_of(on)
                    .map(|v| js_string(Some(&v)))
                    .unwrap_or_default();
                let wanted: Vec<String> = match when.get("is") {
                    Some(Value::Array(a)) => a.iter().map(|v| js_string(Some(v))).collect(),
                    Some(v) => vec![js_string(Some(v))],
                    None => vec![],
                };
                if !wanted.contains(&now) {
                    continue;
                }
            }
            if gating.contains(&key) {
                w.insert("gates".into(), json!(true));
            }
            match kind(declared) {
                "choice" => {
                    let options = declared
                        .get("options")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let resolved: Vec<Value> =
                        options.into_iter().map(|one| self.option(one)).collect();
                    w.insert("options".into(), json!(resolved));
                    if let Some(v) = self.value_of(&key) {
                        w.insert("value".into(), v);
                    }
                }
                "password" => {
                    // The secret is never put on the screen: whether there is one, and where.
                    w.insert("set".into(), json!(has_secret(&self.m.id, &key)));
                    w.insert("stored".into(), json!(secret_store_name()));
                }
                "action" => {
                    let tool = declared.get("tool").and_then(Value::as_str).unwrap_or("");
                    let missing = self.tools.is_some_and(|t| !t.iter().any(|n| n == tool));
                    w.insert("available".into(), json!(!missing));
                    if missing {
                        w.insert(
                            "reason".into(),
                            json!(format!(
                                "{} has no tool called \"{tool}\" right now.",
                                self.m.name
                            )),
                        );
                    }
                }
                // In-flight progress is not kept by the hub: absent means idle.
                "progress" => {}
                _ => {
                    if let Some(v) = self.value_of(&key) {
                        w.insert("value".into(), v);
                    }
                }
            }
            out.push(Value::Object(w));
        }
        out
    }

    /// A `choice` option with `needs` answered against what is stored.
    fn option(&self, one: Value) -> Value {
        let Some(mut o) = one.as_object().cloned() else {
            return one;
        };
        let Some(needs) = o.get("needs").and_then(Value::as_str).map(str::to_owned) else {
            return Value::Object(o);
        };
        let reason = o.remove("reason");
        let there = self.filled(&needs);
        let available = there && o.get("available") != Some(&json!(false));
        o.insert("available".into(), json!(available));
        if !there {
            let why = reason.unwrap_or_else(|| {
                let named = self.find(&needs).map_or(needs.as_str(), label);
                json!(format!("Needs “{named}”."))
            });
            o.insert("reason".into(), why);
        }
        Value::Object(o)
    }
}

/// v2 `pageOf`: the declared page normalized, else one built from the panel, else null.
fn page_of(m: &Manifest) -> Value {
    if let Some(page) = m.page.as_ref().filter(|p| p.is_object()) {
        let mut sizes = Map::new();
        for tier in ["S", "M", "L"] {
            if let Some(one) = page.pointer(&format!("/sizes/{tier}")) {
                sizes.insert(
                    tier.into(),
                    json!({
                        "at": one.get("at").cloned().unwrap_or(json!([])),
                        "show": one.get("show").cloned().unwrap_or(json!([])),
                    }),
                );
            }
        }
        let mut out = json!({
            "title": page.get("title").cloned().unwrap_or(json!(m.name)),
            "sizes": sizes,
            "fixed": page.get("fixed") == Some(&json!(true)),
        });
        if let Some(scale) = page.get("scale").filter(|s| s.is_object()) {
            let mut s = json!({ "min": scale.get("min").cloned().unwrap_or(json!([])) });
            if let Some(max) = scale.get("max") {
                s["max"] = max.clone();
            }
            out["scale"] = s;
        }
        return out;
    }
    if let Some(panel) = &m.panel {
        let title = panel
            .get("label")
            .and_then(Value::as_str)
            .filter(|l| !l.is_empty())
            .unwrap_or(&m.name);
        let widgets = panel_widgets(m);
        let show: Vec<&str> = widgets.iter().map(key_of).collect();
        return json!({
            "title": title,
            "sizes": { "M": { "at": DEFAULT_PAGE_AT, "show": show } },
            "fixed": false,
        });
    }
    Value::Null
}

// ---- POST /api/plugin ----

/// serve.ts 2599–2627: `enable`, `disable`, `delete` (purge and the folder), `restart`.
async fn lifecycle(
    State(api): State<Arc<Api>>,
    Extension(Sent(sent)): Extension<Sent>,
) -> Response {
    let id = text(&sent, "id");
    if host(&api).plugin_dir(&PluginId(id.into())).is_none() {
        return json::ok(
            json!({ "ok": false, "said": format!("There is no plugin called “{id}”.") }),
        );
    }
    let pid = PluginId(id.into());
    let action = text(&sent, "action");
    let done = match action {
        "enable" => host(&api).set_enabled(&pid, true).await,
        "disable" => host(&api).set_enabled(&pid, false).await,
        "delete" => host(&api).remove(&pid).await,
        "restart" => host(&api).restart(&pid).await,
        other => {
            return json::ok(json!({
                "ok": false,
                "said": format!("“{other}” is not something to do to a plugin."),
            }))
        }
    };
    let saved = persist_enabled(&api);
    if let Err(e) = done {
        return json::ok(json!({ "ok": false, "said": e.to_string() }));
    }
    if let Err(e) = saved {
        return json::ok(json!({ "ok": false, "said": e.to_string() }));
    }
    let (skills, _) = skills(&api);
    json::ok(json!({ "ok": true, "panes": panes(&api), "skills": skills }))
}

// ---- POST /api/install ----

/// serve.ts 2629–2641: installed, not enabled.
async fn install(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    let typed = text(&sent, "path").trim();
    // A trailing slash is the same folder (v2).
    let typed = match typed.trim_end_matches(['/', '\\']) {
        "" => typed,
        t => t,
    };
    match host(&api).install_folder(Path::new(typed)).await {
        Err(e) => json::ok(json!({ "ok": false, "said": e.to_string() })),
        Ok(id) => {
            // Written now, so a hub with no list yet does not take the new one for enabled.
            if let Err(e) = persist_enabled(&api) {
                tracing::warn!("the enabled list could not be written: {e}");
            }
            json::ok(json!({
                "ok": true,
                "id": id.0,
                "said": format!("{} is installed. Read what it asked for, then enable it.", id.0),
                "panes": panes(&api),
            }))
        }
    }
}

// ---- POST /api/server ----

/// serve.ts 2789–2835: `trust` is the owner's word (P2-62), and only this route gives it.
async fn server(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    let id = text(&sent, "id");
    if text(&sent, "action") == "trust" {
        if let Err(e) = host(&api).set_reviewed(&PluginId(id.trim().into()), true) {
            return json::ok(json!({ "ok": false, "said": e.to_string() }));
        }
        return json::ok(json!({
            "ok": true,
            "unreviewed": unreviewed(&api),
            "panes": panes(&api),
        }));
    }
    let args: Vec<String> = sent
        .get("args")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let added = host(&api)
        .add_server(id, text(&sent, "name"), text(&sent, "run"), &args)
        .await;
    match added {
        Err(e) => json::ok(json!({ "ok": false, "said": e.to_string() })),
        Ok(id) => {
            if let Err(e) = persist_enabled(&api) {
                tracing::warn!("the enabled list could not be written: {e}");
            }
            json::ok(json!({
                "ok": true,
                "said": format!(
                    "{} is added. Nobody has reviewed it, so every one of its tools will be asked about until you say otherwise.",
                    id.0
                ),
                "panes": panes(&api),
                "unreviewed": unreviewed(&api),
            }))
        }
    }
}

// ---- POST /api/settings ----

/// serve.ts 2908–2934.
async fn settings(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    let value = sent.get("value").cloned().unwrap_or(Value::Null);
    match set_setting(&api, text(&sent, "plugin"), text(&sent, "key"), value).await {
        Err(why) => json::ok(json!({ "ok": false, "why": why })),
        Ok(()) => json::ok(json!({ "ok": true, "panes": panes(&api) })),
    }
}

/// The plugin's declared widget called `key`, or v2's sentence.
fn declared(api: &Api, plugin: &str, key: &str) -> Result<Value, String> {
    let missing = || format!("{plugin} has no setting called \"{key}\"");
    let dir = host(api)
        .plugin_dir(&PluginId(plugin.into()))
        .ok_or_else(missing)?;
    declared_widgets(&dir.manifest)
        .into_iter()
        .find(|w| key_of(w) == key)
        .ok_or_else(missing)
}

/// v2 `setSetting`: checked against the declaration, kept (a `password` in Credential
/// Manager as `<plugin>.<key>` and nowhere else), then told to the plugin if it is running.
async fn set_setting(api: &Api, plugin: &str, key: &str, value: Value) -> Result<(), String> {
    let declared = declared(api, plugin, key)?;
    if let Some(wrong) = refuse(&declared, &value) {
        return Err(wrong);
    }
    let said = if kind(&declared) == "password" {
        let secret = value.as_str().unwrap_or("");
        let kept = if secret.is_empty() {
            secrets::delete(plugin, key)
        } else {
            secrets::set(plugin, key, secret)
        };
        kept.map_err(|e| e.to_string())?;
        // A cleared password is `null`: "there is no longer one" is a change too.
        if secret.is_empty() {
            Value::Null
        } else {
            value
        }
    } else {
        api.parts
            .store
            .set_setting(plugin, key, &value)
            .map_err(|e| e.to_string())?;
        value
    };
    let mut changed = Map::new();
    changed.insert(key.into(), said);
    host(api)
        .settings_changed(&PluginId(plugin.into()), changed)
        .await;
    Ok(())
}

/// v2 `refuse`: the sentence to show beside the control, or None when the value may be kept.
fn refuse(declared: &Value, value: &Value) -> Option<String> {
    let label = label(declared);
    let kind = kind(declared);
    if DRIVEN.contains(&kind) || declared.get("rows").is_some() {
        return Some(match kind {
            "action" => format!("\"{label}\" is a button, not a value."),
            "table" | "tree" => format!("\"{label}\" is a list, not a value."),
            _ => format!("\"{label}\" is driven by the plugin, not by you."),
        });
    }
    let number = |k: &str| declared.get(k).and_then(Value::as_f64);
    match kind {
        "file" => Some(format!(
            "\"{label}\" is a file you choose, not a path you type."
        )),
        "text" | "password" => (!value.is_string()).then(|| format!("\"{label}\" takes text.")),
        "number" => {
            let Some(n) = value.as_f64().filter(|n| n.is_finite()) else {
                return Some(format!("\"{label}\" takes a number."));
            };
            if number("min").is_some_and(|m| n < m) {
                return Some(format!(
                    "\"{label}\" must be at least {}.",
                    js_string(declared.get("min"))
                ));
            }
            if number("max").is_some_and(|m| n > m) {
                return Some(format!(
                    "\"{label}\" must be at most {}.",
                    js_string(declared.get("max"))
                ));
            }
            None
        }
        "toggle" => (!value.is_boolean()).then(|| format!("\"{label}\" is on or off.")),
        "choice" => {
            let values: Vec<String> = declared
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|o| match o {
                    Value::String(s) => Some(s.clone()),
                    o => o.get("value").and_then(Value::as_str).map(str::to_owned),
                })
                .collect();
            let fits = value
                .as_str()
                .is_some_and(|v| values.iter().any(|o| o == v));
            (!fits).then(|| {
                format!(
                    "\"{}\" is not one of {}.",
                    js_string(Some(value)),
                    values.join(", ")
                )
            })
        }
        "multi-choice" => {
            let Some(list) = value.as_array() else {
                return Some(format!("\"{label}\" takes a list."));
            };
            let options: Vec<&str> = declared
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            let stray = list
                .iter()
                .find(|one| !one.as_str().is_some_and(|s| options.contains(&s)))?;
            Some(format!(
                "\"{}\" is not one of {}.",
                js_string(Some(stray)),
                options.join(", ")
            ))
        }
        "path" => {
            let Some(p) = value.as_str() else {
                return Some(format!("\"{label}\" takes a path."));
            };
            if p.is_empty() {
                return None;
            }
            let path = Path::new(p);
            if !path.is_absolute() {
                return Some(format!("{p} is not a full path."));
            }
            let Ok(meta) = std::fs::metadata(path) else {
                return Some(format!("There is nothing at {p}."));
            };
            match declared.get("kind").and_then(Value::as_str) {
                Some("dir") if !meta.is_dir() => {
                    Some(format!("{p} is a file, and this wants a folder."))
                }
                Some("file") if meta.is_dir() => {
                    Some(format!("{p} is a folder, and this wants a file."))
                }
                _ => None,
            }
        }
        _ => None,
    }
}

// ---- POST /api/upload ----

/// serve.ts 2936–2980.
async fn upload(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    let name = sent
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("file")
        .to_owned();
    let answer = keep_upload(
        &api,
        text(&sent, "plugin"),
        text(&sent, "key"),
        &name,
        text(&sent, "data"),
    )
    .await;
    match answer {
        Err(why) => json::ok(json!({ "ok": false, "why": why })),
        Ok(path) => json::ok(json!({
            "ok": true,
            "path": path.to_string_lossy(),
            "panes": panes(&api),
        })),
    }
}

/// v2 `upload`: the bytes behind a `file` widget, inside the plugin's own folder
/// (`uploads/<key>/<name>`, one file per widget), and the path they became is its value.
async fn keep_upload(
    api: &Api,
    plugin: &str,
    key: &str,
    name: &str,
    data: &str,
) -> Result<PathBuf, String> {
    let declared = declared(api, plugin, key)?;
    if kind(&declared) != "file" {
        return Err(format!("\"{}\" does not take a file.", label(&declared)));
    }
    let called = safe_name(name);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| format!("{called} did not arrive in one piece."))?;
    if bytes.is_empty() {
        return Err(format!("{called} is empty."));
    }
    if bytes.len() > MOST_PER_FILE {
        return Err(format!(
            "{called} is {}, and {} is the most one file may be.",
            megabytes(bytes.len()),
            megabytes(MOST_PER_FILE)
        ));
    }
    // Emptied first, so one widget holds one file and keeps its own name.
    let dir = api.parts.layout.own_dir(plugin).join("uploads").join(key);
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join(&called);
    std::fs::create_dir_all(&dir)
        .and_then(|()| std::fs::write(&path, &bytes))
        .map_err(|_| format!("{called} did not arrive in one piece."))?;
    let value = json!(path.to_string_lossy());
    api.parts
        .store
        .set_setting(plugin, key, &value)
        .map_err(|e| e.to_string())?;
    let mut changed = Map::new();
    changed.insert(key.into(), value);
    host(api)
        .settings_changed(&PluginId(plugin.into()), changed)
        .await;
    Ok(path)
}

// ---- GET /api/plugin-file ----

/// serve.ts 3199–3229: a file inside the plugin's **own** folder, both sides resolved to their
/// real paths first, so neither `..` nor a link that points outside gets through.
async fn plugin_file(
    State(api): State<Arc<Api>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let id = q.get("plugin").map_or("", String::as_str);
    let wanted = q.get("path").map_or("", String::as_str);
    if id.is_empty() || host(&api).plugin_dir(&PluginId(id.into())).is_none() {
        return json::said(404, "There is no plugin by that name.");
    }
    let own = api.parts.layout.own_dir(id);
    // A relative path is read from the plugin's own folder; v2 sent the stored absolute one.
    let asked = if Path::new(wanted).is_absolute() {
        PathBuf::from(wanted)
    } else {
        own.join(wanted)
    };
    let (Ok(root), Ok(real)) = (std::fs::canonicalize(&own), std::fs::canonicalize(&asked)) else {
        return json::said(404, "That file is not there.");
    };
    if !real.starts_with(&root) {
        return json::said(403, "A plugin may only show files from its own folder.");
    }
    match tokio::fs::read(&real).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, mime_of(&real)),
                (header::CACHE_CONTROL, "private, max-age=60"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => json::said(410, "That file is no longer where it was."),
    }
}

/// v2 `mimeOf`, for the pictures a panel shows.
fn mime_of(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
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
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuse_speaks_v2() {
        let num = json!({"type": "number", "key": "n", "label": "Count", "min": 0, "max": 9});
        assert_eq!(refuse(&num, &json!(4)), None);
        assert_eq!(
            refuse(&num, &json!(10)).unwrap(),
            "\"Count\" must be at most 9."
        );
        assert_eq!(
            refuse(&num, &json!(-1)).unwrap(),
            "\"Count\" must be at least 0."
        );
        assert_eq!(
            refuse(&num, &json!("3")).unwrap(),
            "\"Count\" takes a number."
        );
        let choice = json!({"type": "choice", "key": "c", "label": "C",
            "options": ["red", {"value": "blue", "label": "Blue"}]});
        assert_eq!(refuse(&choice, &json!("blue")), None);
        assert_eq!(
            refuse(&choice, &json!("green")).unwrap(),
            "\"green\" is not one of red, blue."
        );
        let multi =
            json!({"type": "multi-choice", "key": "m", "label": "M", "options": ["a", "b"]});
        assert_eq!(refuse(&multi, &json!(["a"])), None);
        assert_eq!(
            refuse(&multi, &json!(["a", "z"])).unwrap(),
            "\"z\" is not one of a, b."
        );
        let toggle = json!({"type": "toggle", "key": "t", "label": "T"});
        assert_eq!(refuse(&toggle, &json!(1)).unwrap(), "\"T\" is on or off.");
        let table = json!({"type": "table", "key": "x", "label": "People", "rows": "list"});
        assert_eq!(
            refuse(&table, &json!(1)).unwrap(),
            "\"People\" is a list, not a value."
        );
        let status = json!({"type": "status", "key": "s", "label": "State"});
        assert_eq!(
            refuse(&status, &json!("x")).unwrap(),
            "\"State\" is driven by the plugin, not by you."
        );
        let file = json!({"type": "file", "key": "f", "label": "Voice"});
        assert_eq!(
            refuse(&file, &json!("C:/x")).unwrap(),
            "\"Voice\" is a file you choose, not a path you type."
        );
        let path = json!({"type": "path", "key": "p", "label": "P", "kind": "dir"});
        assert_eq!(refuse(&path, &json!("")), None);
        assert_eq!(
            refuse(&path, &json!("relative/x")).unwrap(),
            "relative/x is not a full path."
        );
    }

    #[test]
    fn js_strings() {
        assert_eq!(js_string(Some(&json!(3))), "3");
        assert_eq!(js_string(Some(&json!(1.5))), "1.5");
        assert_eq!(js_string(Some(&json!(true))), "true");
        assert_eq!(js_string(Some(&json!(["a", 1]))), "a,1");
    }

    #[test]
    fn safe_names() {
        assert_eq!(safe_name(r"..\..\evil.txt"), "evil.txt");
        assert_eq!(safe_name(""), "attachment");
    }
}
