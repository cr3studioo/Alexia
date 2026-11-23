// SPDX-License-Identifier: AGPL-3.0-only
//! Board tables and actions (INVENTORY B1–B3).
//!
//! A port of v2 `surface.ts` (`sources`, `actions`), its consent ladder (`consent.ts`) and
//! serve.ts 3024–3168, on v3's store, router, catalog, trace and skills folders. Core's own
//! tables read what the hub already holds; a plugin's table, detail or button is a call to
//! the tool its manifest names, through the same permission ruling an agent call gets and
//! into the audit log. Where v3 has no data (prices, paid tiers), v2's keys carry the free
//! values (D-P2D-6).

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use alexia_core::catalog::{routes as is_router, Candidate};
use alexia_core::permissions::{self, CallAsk};
use alexia_core::prompt::Skills;
use alexia_core::tools::{namespaced, tool_words};
use alexia_core::trace::{ending, replay, summary, KEPT};
use alexia_core::{Job, Origin, Ruling, RunId, ToolCtx, Tooling};
use alexia_mcp::{PluginId, PluginState};
use alexia_store::{now_ms, AuditRow, Ms, Role, SessionId};
use axum::extract::State;
use axum::response::Response;
use axum::routing::post;
use axum::{Extension, Router};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use crate::gate::Sent;
use crate::learned::Episode;
use crate::{json, Api};

/// What this screen keeps between requests: the episode waiting for "Learn this".
#[derive(Default)]
pub(crate) struct BoardState {
    lesson: Mutex<Option<Episode>>,
}

impl BoardState {
    pub(crate) fn hold_lesson(&self, e: Episode) {
        *self.lesson.lock().unwrap_or_else(|e| e.into_inner()) = Some(e);
    }

    /// Taken, so a second yes does not distil it twice.
    pub(crate) fn take_lesson(&self) -> Option<Episode> {
        self.lesson.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

/// Registers this area's INVENTORY rows (path + method).
pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new()
        .route("/api/rows", post(rows))
        .route("/api/detail", post(detail))
        .route("/api/action", post(action))
}

const CORE: &str = "_core";
/// v2's marks: `●` ready, `▲` look at this, `■` off.
const OK: &str = "● ready";
const WAITING: &str = "▲ waiting for your yes";
const NOT_KEPT: &str = "That run is no longer kept. Alexia keeps the last 200, for up to 30 days.";
/// D-P2D-6.
const FREE_ONLY: &str = "Alexia v3 only uses free models.";
/// The jobs a model chosen on the Models screen answers (v2's one pin was every request).
const TEXT_JOBS: [Job; 4] = [Job::Chat, Job::Plan, Job::Step, Job::Code];
/// v2 `MOST_AT_ONCE`, `FASTEST_STAR_WAIT` (pool.ts), for the speed switch's sentence.
const MOST_AT_ONCE: usize = 3;
const FASTEST_WAIT_S: usize = 2;
/// The `tries` look-back the Models table counts answers over (v2: 30 days).
const MONTH_MS: Ms = 30 * 24 * 3600 * 1000;

fn s<'a>(sent: &'a Map<String, Value>, key: &str) -> &'a str {
    sent.get(key).and_then(Value::as_str).unwrap_or("")
}

fn said(ok: bool, said: impl Into<String>) -> Value {
    json!({ "ok": ok, "said": said.into() })
}

/// `2026-08-29 14:03`, local time. Never a raw timestamp.
fn when(at: Ms) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_millis_opt(at)
        .single()
        .map_or_else(String::new, |d| d.format("%Y-%m-%d %H:%M").to_string())
}

/// v2 `spelled`.
fn spelled(n: usize) -> String {
    ["no", "one", "two", "three", "four", "five", "six"]
        .get(n)
        .map_or_else(|| n.to_string(), |w| (*w).to_owned())
}

// ---- the routes ----

async fn rows(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    let (plugin, key) = (s(&sent, "plugin"), s(&sent, "key"));
    if plugin.is_empty() {
        return json::ok(match core_rows(&api, key).await {
            Some(Ok((rows, note))) => {
                let mut v = json!({ "ok": true, "rows": rows });
                if let Some(n) = note {
                    v["note"] = json!(n);
                }
                v
            }
            Some(Err(e)) => said(false, e),
            None => said(false, format!("There is no list called \"{key}\".")),
        });
    }
    json::ok(plugin_table(&api, plugin, key, None, approved(&sent)).await)
}

async fn detail(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    let (plugin, key, row) = (s(&sent, "plugin"), s(&sent, "key"), s(&sent, "row"));
    if plugin.is_empty() {
        return json::ok(match core_detail(&api, key, row).await {
            Some(Ok(mut v)) => {
                v["ok"] = json!(true);
                v
            }
            Some(Err(e)) => said(false, e),
            None => said(false, format!("There is no list called \"{key}\".")),
        });
    }
    json::ok(plugin_table(&api, plugin, key, Some(row), approved(&sent)).await)
}

async fn action(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    let (plugin, key, row) = (s(&sent, "plugin"), s(&sent, "key"), s(&sent, "row"));
    if plugin.is_empty() {
        return json::ok(match core_action(&api, key, row).await {
            Some(v) => v,
            None => said(false, format!("There is no button called \"{key}\".")),
        });
    }
    json::ok(plugin_action(&api, plugin, key, row, approved(&sent)).await)
}

fn approved(sent: &Map<String, Value>) -> bool {
    sent.get("approved") == Some(&Value::Bool(true))
}

type Rows = (Vec<Value>, Option<String>);

/// v2 `sources[key].rows()`; None for a key that is not one of core's lists.
async fn core_rows(api: &Api, key: &str) -> Option<Result<Rows, String>> {
    let rows = match key {
        "chats" => chats(api),
        "models" => Ok(models(api)),
        "routing" => Ok(routing(api)),
        "activity" => activity(api),
        "last_run" => last_run(api).await,
        "skills" => Ok(skill_rows(api, false)),
        "learned" => Ok(skill_rows(api, true)),
        "tools" => Ok(tools(api).await),
        "library" => Ok(library(api)),
        _ => return None,
    };
    let note = (key == "models").then(|| news(api)).flatten();
    Some(rows.map(|r| (r, note)))
}

/// v2 `sources[key].detail(id)`, as `{text}` or `{text, more}`.
async fn core_detail(api: &Api, key: &str, id: &str) -> Option<Result<Value, String>> {
    let text = |t: String| Ok(json!({ "text": t }));
    Some(match key {
        "chats" => chat_detail(api, id).and_then(text),
        "models" => text(model_detail(api, id)),
        "activity" => run_detail(api, id),
        "skills" | "learned" => text(skill_text(api, id)),
        "tools" => text(
            api.parts
                .tooling
                .list()
                .await
                .into_iter()
                .find(|t| t.name == id)
                .map_or_else(
                    || "That tool is not offered any more.".into(),
                    |t| t.description,
                ),
        ),
        "library" => text(plugin_detail(api, id)),
        "routing" | "last_run" => text("There is nothing more to say about that.".into()),
        _ => return None,
    })
}

// ---- chats (M8-2) ----

struct Chat {
    id: SessionId,
    title: String,
    turns: usize,
    updated_at: Ms,
}

/// v2 `store.conversations()`: every session, newest first, titled by its first user message.
fn conversations(api: &Api) -> Result<Vec<Chat>, String> {
    let store = &api.parts.store;
    let sessions = store.sessions().map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(sessions.len());
    for one in sessions {
        let said: Vec<_> = store
            .history(one.id, None)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|m| matches!(m.role, Role::User | Role::Assistant))
            .collect();
        let first = said
            .iter()
            .find(|m| m.role == Role::User)
            .map(|m| m.body.content.text())
            .unwrap_or_default();
        let title = one.title.filter(|t| !t.trim().is_empty()).unwrap_or(first);
        out.push(Chat {
            id: one.id,
            title: title.chars().take(200).collect(),
            turns: said.len(),
            updated_at: one.updated_at,
        });
    }
    Ok(out)
}

fn chats(api: &Api) -> Result<Vec<Value>, String> {
    let open = api.session();
    Ok(conversations(api)?
        .into_iter()
        .map(|c| {
            json!({
                "id": c.id.0.to_string(),
                "title": c.title,
                "turns": c.turns.to_string(),
                "when": when(c.updated_at),
                "at": c.updated_at,
                "state": if c.id == open { "● open" } else { "" },
            })
        })
        .collect())
}

fn chat_detail(api: &Api, id: &str) -> Result<String, String> {
    let Ok(n) = id.parse::<i64>() else {
        return Ok("Nothing has been said in this one yet.".into());
    };
    let said: Vec<_> = api
        .parts
        .store
        .history(SessionId(n), None)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|m| matches!(m.role, Role::User | Role::Assistant))
        .collect();
    if said.is_empty() {
        return Ok("Nothing has been said in this one yet.".into());
    }
    let shown = &said[said.len().saturating_sub(12)..];
    let mut lines: Vec<String> = shown
        .iter()
        .map(|m| {
            let who = if m.role == Role::User {
                "You"
            } else {
                "Alexia"
            };
            format!("{who}: {}", m.body.content.text())
        })
        .collect();
    if said.len() > shown.len() {
        lines.insert(0, format!("… {} earlier turns", said.len() - shown.len()));
    }
    Ok(lines.join("\n\n"))
}

fn find_chat(api: &Api, id: &str) -> Result<Option<Chat>, String> {
    Ok(conversations(api)?
        .into_iter()
        .find(|c| c.id.0.to_string() == id))
}

fn new_chat(api: &Api) -> Value {
    let all = match conversations(api) {
        Ok(a) => a,
        Err(e) => return said(false, e),
    };
    let open = api.session();
    let empty = all.iter().find(|c| c.turns == 0).map(|c| c.id);
    if empty == Some(open) {
        return said(
            true,
            "You are already in a new chat — nothing has been said in this one.",
        );
    }
    let id = match empty {
        Some(id) => id,
        None => match api.parts.store.create_session(None) {
            Ok(id) => id,
            Err(e) => return said(false, e.to_string()),
        },
    };
    if let Err(e) = api.set_session(id) {
        return said(false, e.to_string());
    }
    // Whatever anybody held for the last conversation, they can let go of now. Nothing
    // waits for it and no plugin is named.
    let host = api.parts.host.clone();
    tokio::spawn(async move { host.conversation_ended().await });
    said(
        true,
        "Started a new chat. Anything you say now goes into it.",
    )
}

fn open_chat(api: &Api, id: &str) -> Value {
    match find_chat(api, id) {
        Err(e) => said(false, e),
        Ok(None) => said(false, "There is no conversation with that id."),
        Ok(Some(c)) => match api.set_session(c.id) {
            Ok(()) => said(
                true,
                format!("Open: “{}”. Press Back and it is on screen.", c.title),
            ),
            Err(e) => said(false, e.to_string()),
        },
    }
}

/// You cannot delete the conversation you are in: its messages go by cascade, and every later
/// append would point at a session that is not there.
fn forget_chat(api: &Api, id: &str) -> Value {
    let chat = match find_chat(api, id) {
        Err(e) => return said(false, e),
        Ok(None) => return said(false, "There is no conversation with that id."),
        Ok(Some(c)) => c,
    };
    if chat.id == api.session() {
        return said(
            false,
            "That is the conversation you are in. Open another one first, or press New chat.",
        );
    }
    let store = &api.parts.store;
    if let Err(e) = store.delete_session(chat.id) {
        return said(false, e.to_string());
    }
    let kept: Vec<i64> = private_sessions(api)
        .into_iter()
        .filter(|s| *s != chat.id.0)
        .collect();
    let _ = store.kv_set(CORE, PRIVATE, &json!(kept));
    said(
        true,
        format!("“{}” is gone, and everything said in it.", chat.title),
    )
}

/// kv `_core`/`private_sessions`, as chat writes it.
const PRIVATE: &str = "private_sessions";

fn private_sessions(api: &Api) -> Vec<i64> {
    api.parts
        .store
        .kv_get(CORE, PRIVATE)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub(crate) fn is_private(api: &Api, session: SessionId) -> bool {
    private_sessions(api).contains(&session.0)
}

// ---- models and routing (the Models tab) ----

/// v2 `MODEL_GROUPS`.
const CHOSEN: &str = "Your choice";
const LISTED: &str = "Your list";
const AUTOMATIC: &str = "Automatic, free";
const SET_ASIDE: &str = "Set aside by Alexia";

/// One model on one provider, as a row's id (D161).
fn row_id(provider: &str, model: &str) -> String {
    format!("{provider}\n{model}")
}

/// `provider\nmodel`, `provider/model` or a bare model id → (provider, model).
fn split_row(row: &str) -> (Option<&str>, &str) {
    if let Some((p, m)) = row.split_once('\n') {
        return (Some(p), m);
    }
    match row.split_once('/') {
        Some((p, m)) if !p.is_empty() && !m.is_empty() => (Some(p), m),
        _ => (None, row),
    }
}

/// The router's pin for a candidate.
fn pin_of(c: &Candidate) -> String {
    format!("{}/{}", c.provider, c.model)
}

fn find_candidate(api: &Api, row: &str) -> Option<Candidate> {
    let (provider, model) = split_row(row);
    let all = api.parts.catalog.candidates();
    let exact = all
        .iter()
        .find(|c| c.model == model && provider.is_none_or(|p| p == c.provider))
        .cloned();
    // A row id written as `provider/model` for a model whose own id has a slash.
    exact.or_else(|| all.into_iter().find(|c| pin_of(c) == row || c.model == row))
}

/// The chat job's pins (v2's model pin and running order are both this list in v3).
fn chat_pins(api: &Api) -> Vec<String> {
    api.parts.router.pins().remove("chat").unwrap_or_default()
}

/// `31B, from its name` · `not said` (v3 reads sizes from ids only).
fn sized(c: &Candidate) -> String {
    match c.size_b {
        None => "not said".into(),
        Some(b) if b >= 10.0 => format!("{}B, from its name", b.round()),
        Some(b) => format!("{}B, from its name", (b * 10.0).round() / 10.0),
    }
}

/// `128k`, or a dash for not said.
fn window(tokens: u32) -> String {
    if tokens > 0 {
        format!("{}k", (f64::from(tokens) / 1000.0).round())
    } else {
        "—".into()
    }
}

fn model_row(
    c: &Candidate,
    group: &str,
    place: usize,
    note: String,
    state: String,
    answered: &HashMap<String, u64>,
) -> Value {
    let id = row_id(&c.provider, &c.model);
    let mark = match group {
        CHOSEN => "◆ ",
        AUTOMATIC if place == 1 => "★ ",
        _ => "",
    };
    let can: Vec<String> = [
        Some(if c.tools { "tools" } else { "talk only" }.to_owned()),
        c.vision.then(|| "pictures".to_owned()),
        (c.context > 0).then(|| format!("reads {}", window(c.context))),
    ]
    .into_iter()
    .flatten()
    .collect();
    json!({
        "id": id,
        "group": group,
        "rank": format!("{mark}{place}"),
        "name": c.model,
        "provider": c.provider,
        "via": format!("{} · no key needed or your key", c.provider),
        "note": note,
        "size": sized(c),
        "can": can.join(" · "),
        "week": "—",
        "answered": answered.get(&id).copied().unwrap_or(0).to_string(),
        "price": "free",
        "tier": "T1",
        "tags": [],
        "state": state,
    })
}

/// A pinned model the catalog does not hold (a local model, a subscription, or one gone).
fn missing_row(pin: &str, group: &str, place: usize, note: String) -> Value {
    let (provider, model) = split_row(pin);
    json!({
        "id": pin, "group": group, "rank": format!("{}{place}", if group == CHOSEN { "◆ " } else { "" }),
        "name": model, "provider": provider.unwrap_or(""), "via": provider.unwrap_or("this PC"),
        "note": note, "size": "not said", "can": "", "week": "—", "answered": "0",
        "price": "free", "tier": "T1", "tags": [],
        "state": "◆ everything goes here",
    })
}

fn ready_state(c: &Candidate) -> String {
    if c.router || is_router(&c.model) {
        format!("{OK} · a different free model each time")
    } else if c.tools {
        format!("{OK} · tools")
    } else {
        format!("{OK} · text only")
    }
}

/// The table is the ranking (D161): the person's choice or list, then the order Automatic
/// walks, then what is set aside. Every row is free (D-P2D-6).
fn models(api: &Api) -> Vec<Value> {
    let now = now_ms();
    let mut answered: HashMap<String, u64> = HashMap::new();
    for t in api
        .parts
        .store
        .tries_since(now - MONTH_MS)
        .unwrap_or_default()
    {
        if t.outcome == "answered" {
            *answered.entry(row_id(&t.provider, &t.model)).or_default() += 1;
        }
    }
    let all = api.parts.catalog.candidates();
    let by_pin = |pin: &str| all.iter().find(|c| pin_of(c) == pin).cloned();
    let pins = chat_pins(api);
    let mut out = Vec::new();
    if pins.len() == 1 {
        let note = "Your choice: every request goes to it, and if it cannot answer, Alexia stops and says why.".to_owned();
        match by_pin(&pins[0]) {
            Some(c) => out.push(model_row(
                &c,
                CHOSEN,
                1,
                note,
                "◆ everything goes here".into(),
                &answered,
            )),
            None => out.push(missing_row(&pins[0], CHOSEN, 1, note)),
        }
    } else {
        for (at, pin) in pins.iter().enumerate() {
            let note = format!("Number {} in your list.", at + 1);
            match by_pin(pin) {
                Some(c) => {
                    let state = ready_state(&c);
                    out.push(model_row(&c, LISTED, at + 1, note, state, &answered));
                }
                None => out.push(missing_row(
                    pin,
                    LISTED,
                    at + 1,
                    format!("Number {} in your list, not available right now.", at + 1),
                )),
            }
        }
    }
    let ranked = api.parts.router.ranked(now);
    for (at, c) in ranked.iter().enumerate() {
        let note = if at == 0 {
            format!(
                "First choice: the free model Alexia would ask first — {}, {}{}.",
                c.provider,
                if c.tools {
                    "can use tools"
                } else {
                    "talks only"
                },
                c.size_b.map_or_else(String::new, |_| format!(
                    ", {}",
                    sized(c).replace(", from its name", "")
                ))
            )
        } else {
            format!("Asked when {} cannot answer.", ranked[at - 1].model)
        };
        let state = if at == 0 {
            "★ recommended".to_owned()
        } else {
            ready_state(c)
        };
        out.push(model_row(c, AUTOMATIC, at + 1, note, state, &answered));
    }
    let shown: Vec<String> = ranked.iter().map(pin_of).collect();
    let mut aside: Vec<&Candidate> = all.iter().filter(|c| !shown.contains(&pin_of(c))).collect();
    aside.sort_by(|a, b| a.model.cmp(&b.model));
    for (at, c) in aside.into_iter().enumerate() {
        out.push(model_row(
            c,
            SET_ASIDE,
            at + 1,
            "Set aside: busy, out of free requests or failing lately. One good reply brings it back.".into(),
            "■ set aside · resting".into(),
            &answered,
        ));
    }
    out
}

/// What the last refresh added, as one line (v2 `news`), or nothing.
fn news(api: &Api) -> Option<String> {
    let new = api.parts.catalog.news();
    match new.len() {
        0 => None,
        1 => Some(format!(
            "New since the last check: {} on {}.",
            new[0].model, new[0].provider
        )),
        n => Some(format!("{n} new free models since the last check.")),
    }
}

fn model_detail(api: &Api, id: &str) -> String {
    let Some(c) = find_candidate(api, id) else {
        return "That model is not in the catalog any more.".into();
    };
    let key = row_id(&c.provider, &c.model);
    let tries: Vec<_> = api
        .parts
        .store
        .tries_since(now_ms() - MONTH_MS)
        .unwrap_or_default()
        .into_iter()
        .filter(|t| row_id(&t.provider, &t.model) == key)
        .collect();
    let mut seen: Vec<(String, Vec<Ms>)> = Vec::new();
    for t in &tries {
        match seen.iter_mut().find(|(o, _)| *o == t.outcome) {
            Some((_, ats)) => ats.push(t.at),
            None => seen.push((t.outcome.clone(), vec![t.at])),
        }
    }
    let evidence: Vec<String> = if seen.is_empty() {
        vec!["Nothing yet: it has not been asked on this machine in the last 30 days.".into()]
    } else {
        seen.iter()
            .map(|(outcome, ats)| {
                let did = did(outcome);
                let (first, last) = (
                    ats.iter().min().copied().unwrap_or(0),
                    ats.iter().max().copied().unwrap_or(0),
                );
                if ats.len() == 1 {
                    format!("{did} once, {}.", when(first))
                } else {
                    format!(
                        "{did} {} times, from {} to {}.",
                        ats.len(),
                        when(first),
                        when(last)
                    )
                }
            })
            .collect()
    };
    let mut lines = vec![
        format!("{} on {}", c.model, c.provider),
        c.model.clone(),
        String::new(),
        "What Alexia has seen here in the last 30 days:".into(),
    ];
    lines.extend(evidence);
    lines.extend([
        String::new(),
        "T1 · free in, free out, per million tokens".into(),
        format!(
            "Context: {} · takes {}",
            window(c.context),
            if c.vision { "text, image" } else { "text" }
        ),
        format!(
            "Tools: {}",
            if c.tools {
                "yes"
            } else {
                "not according to its provider"
            }
        ),
    ]);
    if c.router || is_router(&c.model) {
        lines.push(format!(
            "A router: a different free model each time, chosen by {}. Automatic asks it after every single model.",
            c.provider
        ));
    }
    lines.push(format!(
        "{} does not publish how much its models are used.",
        c.provider
    ));
    lines.push("Trains on what you send it: unknown".into());
    lines.push("Uncensored: unknown".into());
    lines.join("\n")
}

/// v2 `DID`: each outcome in a sentence about one model.
fn did(outcome: &str) -> String {
    match outcome {
        "answered" => "Answered",
        "busy" => "Said it was too busy",
        "slow" => "Did not answer in time",
        "failed" => "Failed",
        "unreachable" => "Could not be reached",
        "empty" => "Answered with nothing",
        "cut" => "Ran out of room before finishing",
        "retired" => "Said it is no longer offered",
        "needs-key" => "Wanted a key",
        "key-refused" => "Had its key refused",
        "too-long" => "Found the conversation too long",
        "bad-answer" => "Was marked a bad answer",
        other => return format!("Ended “{other}”"),
    }
    .to_owned()
}

/// The ladder: every model that can be asked, the person's list first.
fn routing(api: &Api) -> Vec<Value> {
    let pins = chat_pins(api);
    let mut rows: Vec<(usize, String, Value)> = api
        .parts
        .catalog
        .candidates()
        .into_iter()
        .map(|c| {
            let pin = pin_of(&c);
            let rank = pins.iter().position(|p| *p == pin);
            let v = json!({
                "id": pin,
                "name": c.model,
                "provider": c.provider,
                "price": "free",
                "side": "free",
                "rank": rank.map_or_else(String::new, |r| (r + 1).to_string()),
                "tools": if c.tools { "tools" } else { "text only" },
                "off": "",
            });
            (rank.unwrap_or(usize::MAX), c.model, v)
        })
        .collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    rows.into_iter().map(|(_, _, v)| v).collect()
}

fn set_text_pins(api: &Api, pins: &[String]) -> Result<(), String> {
    for job in TEXT_JOBS {
        api.parts
            .router
            .set_pins(job, pins.to_vec())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// "Use this one, and stop choosing for me" — the router's pin, as `alexia-hub models use`.
fn use_model(api: &Api, row: &str) -> Value {
    let pin = if row.starts_with("local:") || row.starts_with("subscription:") {
        row.to_owned()
    } else {
        match find_candidate(api, row) {
            Some(c) => pin_of(&c),
            None => return said(false, "That model is not in the catalog any more."),
        }
    };
    let name = split_row(&pin).1.to_owned();
    if let Err(e) = set_text_pins(api, std::slice::from_ref(&pin)) {
        return said(false, e);
    }
    said(
        true,
        format!("Every request now goes to {name}. If it cannot answer, Alexia stops and says why rather than asking another model. Press Automatic on any row to hand the choice back."),
    )
}

fn automatic(api: &Api) -> Value {
    let pins = api.parts.router.pins();
    let had = TEXT_JOBS.iter().any(|j| pins.contains_key(job_key(*j)));
    if let Err(e) = set_text_pins(api, &[]) {
        return said(false, e);
    }
    said(
        true,
        if had {
            "Back to automatic. Each request goes to the cheapest model that fits it, and no model is pinned."
        } else {
            "Already automatic — each request goes to the cheapest model that fits it."
        },
    )
}

fn job_key(j: Job) -> &'static str {
    match j {
        Job::Chat => "chat",
        Job::Plan => "plan",
        Job::Step => "step",
        Job::Code => "code",
        Job::Vision => "vision",
        Job::Check => "check",
        Job::Local => "local",
    }
}

/// The running order, as one comma-separated list; unknown ids are dropped, empty clears it.
fn set_order(api: &Api, list: &str) -> Value {
    let mut order: Vec<String> = Vec::new();
    for one in list.split(',').map(str::trim).filter(|o| !o.is_empty()) {
        if let Some(c) = find_candidate(api, one) {
            let pin = pin_of(&c);
            if !order.contains(&pin) {
                order.push(pin);
            }
        }
    }
    if let Err(e) = set_text_pins(api, &order) {
        return said(false, e);
    }
    let n = order.len();
    said(
        true,
        if n == 0 {
            "Order cleared, which is Automatic: every model the slider allows can answer, and when one fails the next one does.".to_owned()
        } else {
            format!(
                "{n} in your own order, and only {}. If {}, Alexia stops and says why, and offers Automatic for that answer.",
                if n == 1 { "that one answers" } else { "these answer" },
                if n == 1 { "it fails" } else { "the last one fails too" }
            )
        },
    )
}

/// The keyless floor's switch (v2 kv `keyless.on`).
fn set_keyless(api: &Api, value: &str) -> Value {
    let on = value != "off";
    if let Err(e) = api.parts.store.kv_set(CORE, "keyless.on", &json!(on)) {
        return said(false, e.to_string());
    }
    said(
        true,
        if on {
            "On. Providers that answer without a key may be asked again."
        } else {
            "Off. Only providers you added a key for are asked. Nothing was deleted, and the switch puts them back."
        },
    )
}

/// The speed switch (v2 kv `speed`): `on` is `fastest`, anything else `balanced`.
fn set_speed(api: &Api, value: &str) -> Value {
    let fastest = value == "on";
    let v = if fastest { "fastest" } else { "balanced" };
    if let Err(e) = api.parts.store.kv_set(CORE, "speed", &json!(v)) {
        return said(false, e.to_string());
    }
    said(
        true,
        if fastest {
            format!(
                "On. Up to {} free models on different providers are asked together, and after {} second{} whichever answers first is shown. It uses your free requests about {} times as fast.",
                spelled(MOST_AT_ONCE),
                spelled(FASTEST_WAIT_S),
                if FASTEST_WAIT_S == 1 { "" } else { "s" },
                spelled(MOST_AT_ONCE)
            )
        } else {
            "Off. One model at a time, with a second asked beside it when the first is slow, or has been busy or slow lately.".to_owned()
        },
    )
}

// ---- activity and runs (M6-5, TR-08) ----

/// What the person asked for, for a run: the trace's own `task` (v2 runs), else the last thing
/// said in its conversation before it started, else the tools it used.
fn task_of(api: &Api, id: &str, at: Ms, body: &Value) -> String {
    if let Some(t) = body["task"].as_str() {
        return t.to_owned();
    }
    let audit = api.parts.store.audit_for_run(id).unwrap_or_default();
    if let Some(session) = audit.iter().find_map(|a| a.session) {
        let asked = api
            .parts
            .store
            .history(session, Some(200))
            .unwrap_or_default()
            .into_iter()
            .rev()
            .find(|m| m.role == Role::User && m.at <= at + 1000)
            .map(|m| m.body.content.text());
        if let Some(t) = asked.filter(|t| !t.trim().is_empty()) {
            return t;
        }
    }
    let mut tools: Vec<&str> = Vec::new();
    for a in &audit {
        if !tools.contains(&a.tool.as_str()) {
            tools.push(&a.tool);
        }
    }
    if tools.is_empty() {
        "A task".into()
    } else {
        format!("A task using {}", tools.join(", "))
    }
}

fn cut_task(t: &str) -> String {
    if t.chars().count() > 90 {
        format!("{}…", t.chars().take(90).collect::<String>())
    } else {
        t.to_owned()
    }
}

fn activity(api: &Api) -> Result<Vec<Value>, String> {
    let runs = api.parts.store.runs(KEPT).map_err(|e| e.to_string())?;
    Ok(runs
        .into_iter()
        .map(|(id, at, body)| {
            let steps = body["steps"].as_array().map_or(0, Vec::len);
            json!({
                "id": id,
                "task": cut_task(&task_of(api, &id, at, &body)),
                "steps": steps,
                // v3 never pays (D-P2D-6): free once it has ended.
                "cost": if body["ended"].is_null() { "—" } else { "free" },
                "ended": ending(&body),
                "when": when(at),
                "at": at,
            })
        })
        .collect())
}

fn run_detail(api: &Api, id: &str) -> Result<Value, String> {
    let store = &api.parts.store;
    let Some(body) = store.run_body(id).map_err(|e| e.to_string())? else {
        return Ok(json!({ "text": NOT_KEPT }));
    };
    let more = replay(store, id)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    Ok(json!({ "text": summary(&body), "more": more }))
}

async fn last_run(api: &Api) -> Result<Vec<Value>, String> {
    let Some((id, at, body)) = api
        .parts
        .store
        .runs(1)
        .map_err(|e| e.to_string())?
        .into_iter()
        .next()
    else {
        return Ok(vec![]);
    };
    let words: HashMap<String, String> = api
        .parts
        .tooling
        .list()
        .await
        .into_iter()
        .map(|t| (t.name, t.words))
        .collect();
    let steps: Vec<Value> = body["steps"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|st| {
            let name = st["name"].as_str().unwrap_or("");
            let mut v = json!({
                "n": st["n"],
                "name": name,
                "words": words.get(name).cloned().unwrap_or_else(|| tool_words(name, None)),
                "args": st["args"],
            });
            if let Some(ok) = st["ok"].as_bool() {
                v["ok"] = json!(ok);
            }
            if let Some(t) = st["text"].as_str() {
                v["text"] = json!(t);
            }
            v
        })
        .collect();
    let mut row = json!({
        "id": id,
        "task": task_of(api, &id, at, &body),
        "at": at,
        "over": !body["ended"].is_null(),
        "ended": ending(&body),
        "steps": steps,
    });
    if let Some(w) = body["why"].as_str() {
        row["why"] = json!(w);
    }
    Ok(vec![row])
}

/// One run, written where a person can attach it to something; the path is the answer.
fn export_run(api: &Api, id: &str) -> Value {
    let store = &api.parts.store;
    let (Ok(Some(body)), Ok(Some(text))) = (store.run_body(id), replay(store, id)) else {
        return said(false, NOT_KEPT);
    };
    let at = body["at"].as_i64().unwrap_or_else(now_ms);
    let stamp = chrono::DateTime::from_timestamp_millis(at).map_or_else(
        || at.to_string(),
        |d| d.format("%Y-%m-%dT%H-%M-%S-%3fZ").to_string(),
    );
    let dir = api.parts.layout.root.join("exports");
    let path = dir.join(format!("run-{stamp}.md"));
    match std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&path, &text)) {
        Ok(()) => said(true, format!("Written to {}", path.display())),
        Err(e) => said(false, format!("Could not write it: {e}")),
    }
}

/// The conversation a run happened in, opened the way the Chats list opens one.
fn open_run_chat(api: &Api, id: &str) -> Value {
    let store = &api.parts.store;
    let chat = store
        .run_body(id)
        .ok()
        .flatten()
        .and_then(|b| b["chat"].as_i64())
        .or_else(|| {
            store
                .audit_for_run(id)
                .ok()?
                .iter()
                .find_map(|a| a.session.map(|s| s.0))
        });
    let Some(chat) = chat else {
        return said(false, "Alexia did not note which chat this run was in.");
    };
    match find_chat(api, &chat.to_string()) {
        Ok(Some(_)) => open_chat(api, &chat.to_string()),
        _ => said(false, "That chat has been forgotten since."),
    }
}

// ---- skills and their consent ladder (M6-9, v2 consent.ts) ----

const PROVENANCE: &str = "skill_provenance";
const ALLOWED: &str = "skill_allowed";
const PREAUTH: &str = "skill_preauth";

/// A skill folder the hub loads, as the board reads it.
pub(crate) struct SkillInfo {
    pub name: String,
    pub dir: PathBuf,
    pub learned: bool,
    pub learned_at: Option<String>,
    pub learned_from: Option<String>,
    /// The plugin it came with, for one in a plugin's declared `skills` folder.
    pub plugin: Option<String>,
}

/// The folders the hub loads skills from (main.rs: `layout.skills()` and each enabled
/// plugin's declared folders), with the plugin each belongs to.
fn skill_dirs(api: &Api) -> Vec<(PathBuf, Option<String>)> {
    let mut dirs = vec![(api.parts.layout.skills(), None)];
    for p in api.parts.host.manifests() {
        for f in &p.manifest.skills {
            dirs.push((p.path.join(f), Some(p.manifest.id.clone())));
        }
    }
    dirs
}

/// `metadata:` entries of a SKILL.md frontmatter (the block `prompt.rs` skips).
fn metadata(raw: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut lines = raw.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return out;
    }
    let mut inside = false;
    for line in lines {
        if line.trim_end() == "---" {
            break;
        }
        if !line.starts_with([' ', '\t']) {
            inside = line.trim_end() == "metadata:";
            continue;
        }
        if inside {
            if let Some((k, v)) = line.trim().split_once(':') {
                let v = v.trim();
                let v = serde_json::from_str::<String>(v)
                    .unwrap_or_else(|_| v.trim_matches(['"', '\'']).to_owned());
                out.insert(k.trim().to_owned(), v);
            }
        }
    }
    out
}

/// Every skill that loads, by the same rules core's loader applies (a folder it refuses is a
/// problem, not a skill).
pub(crate) fn skills_of(api: &Api) -> Vec<SkillInfo> {
    let dirs = skill_dirs(api);
    let (_, problems) = Skills::load(&dirs.iter().map(|(d, _)| d.clone()).collect::<Vec<_>>());
    let mut out = Vec::new();
    for (dir, plugin) in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut folders: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.is_dir() && !problems.iter().any(|x| x.dir == *p))
            .collect();
        folders.sort();
        for folder in folders {
            let name = folder
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let meta = std::fs::read_to_string(folder.join("SKILL.md"))
                .map(|raw| metadata(&raw))
                .unwrap_or_default();
            out.push(SkillInfo {
                name,
                learned: meta.get("learned").is_some_and(|v| v == "true"),
                learned_at: meta.get("learned_at").cloned(),
                learned_from: meta.get("learned_from").cloned(),
                dir: folder,
                plugin: plugin.clone(),
            });
        }
    }
    out
}

fn read_kv<T: serde::de::DeserializeOwned + Default>(api: &Api, key: &str) -> T {
    api.parts
        .store
        .kv_get(CORE, key)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn provenance(api: &Api) -> BTreeMap<String, String> {
    read_kv(api, PROVENANCE)
}

/// v2 `record`: written once; a later writer never overwrites an earlier one.
pub(crate) fn record_provenance(api: &Api, name: &str, what: &str) {
    let mut held = provenance(api);
    if held.contains_key(name) {
        return;
    }
    held.insert(name.to_owned(), what.to_owned());
    let _ = api.parts.store.kv_set(CORE, PROVENANCE, &json!(held));
}

fn allowed(api: &Api) -> Vec<String> {
    read_kv(api, ALLOWED)
}

fn allow(api: &Api, name: &str) {
    let mut held = allowed(api);
    if !held.iter().any(|n| n == name) {
        held.push(name.to_owned());
        let _ = api.parts.store.kv_set(CORE, ALLOWED, &json!(held));
    }
}

/// v2 `forgetConsent`: a folder that turns up under this name later starts clean.
pub(crate) fn forget_consent(api: &Api, name: &str) {
    let mut held = provenance(api);
    if held.remove(name).is_some() {
        let _ = api.parts.store.kv_set(CORE, PROVENANCE, &json!(held));
    }
    let kept: Vec<String> = allowed(api).into_iter().filter(|n| n != name).collect();
    let _ = api.parts.store.kv_set(CORE, ALLOWED, &json!(kept));
}

/// v2 `met`: spend a preauth if there is one, and write down where it came from if nobody has.
fn met(api: &Api, skill: &SkillInfo) {
    if skill.plugin.is_some() {
        return record_provenance(api, &skill.name, "bundled");
    }
    let mut pre: Vec<String> = read_kv(api, PREAUTH);
    if let Some(at) = pre.iter().position(|n| *n == skill.name) {
        pre.remove(at);
        let _ = api.parts.store.kv_set(CORE, PREAUTH, &json!(pre));
        record_provenance(api, &skill.name, "installed");
        allow(api, &skill.name);
        return;
    }
    record_provenance(api, &skill.name, "unknown");
}

/// v2 `live`: a bundled skill, or one somebody said yes to.
fn live(api: &Api, skill: &SkillInfo) -> bool {
    skill.plugin.is_some() || allowed(api).contains(&skill.name)
}

fn skill_rows(api: &Api, learned_only: bool) -> Vec<Value> {
    let skills = skills_of(api);
    for one in &skills {
        met(api, one);
    }
    let held = provenance(api);
    let state = |s: &SkillInfo| if live(api, s) { OK } else { WAITING };
    let learned = skills.iter().filter(|s| s.learned && s.plugin.is_none());
    if learned_only {
        return learned
            .map(|s| {
                json!({
                    "id": s.name, "name": s.name,
                    "from": s.learned_from.as_deref().unwrap_or("not recorded"),
                    "when": s.learned_at.as_deref().unwrap_or("—"),
                    "state": state(s),
                })
            })
            .collect();
    }
    let dirs: Vec<PathBuf> = skill_dirs(api).into_iter().map(|(d, _)| d).collect();
    let (_, problems) = Skills::load(&dirs);
    let mut out: Vec<Value> = problems
        .iter()
        .map(|p| {
            json!({
                "id": p.dir.display().to_string(),
                "name": p.dir.file_name().map_or_else(|| p.dir.display().to_string(), |n| n.to_string_lossy().into_owned()),
                "where": "a folder",
                "state": format!("▲ {}", p.why),
            })
        })
        .collect();
    out.extend(
        skills
            .iter()
            .filter(|s| !(s.learned && s.plugin.is_none()))
            .map(|s| {
                let place = match (&s.plugin, held.get(&s.name).map(String::as_str)) {
                    (Some(p), _) => format!("with {p}"),
                    (None, Some("installed")) => "from the marketplace".into(),
                    (None, Some("unknown") | None) => "unknown".into(),
                    (None, Some(_)) => "installed here".into(),
                };
                json!({ "id": s.name, "name": s.name, "where": place, "state": state(s) })
            }),
    );
    out.extend(learned.map(|s| {
        json!({
            "id": s.name, "name": s.name,
            "where": s.learned_from.as_ref().map_or_else(|| "written by Alexia".to_owned(), |f| format!("written by Alexia, from “{f}”")),
            "state": state(s),
        })
    }));
    out
}

/// A skill's own text, frontmatter stripped — readable while it waits for a yes.
fn skill_text(api: &Api, name: &str) -> String {
    let Some(skill) = skills_of(api).into_iter().find(|s| s.name == name) else {
        return format!("There is no skill called {name}.");
    };
    let raw = std::fs::read_to_string(skill.dir.join("SKILL.md")).unwrap_or_default();
    let mut lines = raw.split_inclusive('\n');
    if lines.next().map(str::trim_end) == Some("---") {
        let mut used = raw.split_inclusive('\n').next().map_or(0, str::len);
        for line in lines {
            used += line.len();
            if line.trim_end() == "---" {
                return raw[used..].trim().to_owned();
            }
        }
    }
    raw.trim().to_owned()
}

fn allow_skill(api: &Api, name: &str) -> Value {
    let Some(skill) = skills_of(api).into_iter().find(|s| s.name == name) else {
        return said(false, format!("There is no skill called {name}."));
    };
    met(api, &skill);
    if live(api, &skill) {
        return said(true, format!("{name} was already allowed."));
    }
    allow(api, name);
    said(true, format!("{name} is live. Alexia can use it now."))
}

fn forget_skill(api: &Api, name: &str) -> Value {
    let found = skills_of(api).into_iter().find(|s| s.name == name);
    if let Some(p) = found.as_ref().and_then(|s| s.plugin.as_ref()) {
        return said(
            false,
            format!(
                "{name} came with {p}. It goes when that does — delete the plugin, or disable it."
            ),
        );
    }
    if !crate::learned::forget(&api.parts.layout.skills(), name) {
        return said(false, format!("There is no skill called {name}."));
    }
    forget_consent(api, name);
    said(true, format!("Forgotten. {name} is gone."))
}

// ---- tools and the plugin library ----

async fn tools(api: &Api) -> Vec<Value> {
    api.parts
        .tooling
        .list()
        .await
        .into_iter()
        .map(|t| {
            let (owner, bare) = t.name.split_once("__").unwrap_or(("", ""));
            let a = t.annotations.as_ref();
            json!({
                "id": t.name,
                "name": if bare.is_empty() { t.name.as_str() } else { bare },
                "words": t.words,
                "plugin": if bare.is_empty() { "Alexia" } else { owner },
                "kind": if a.and_then(|a| a.destructive_hint) == Some(true) {
                    "changes things"
                } else if a.and_then(|a| a.read_only_hint) == Some(true) {
                    "reads only"
                } else {
                    "not declared"
                },
                "reaches": a.and_then(|a| a.open_world_hint) == Some(true),
            })
        })
        .collect()
}

/// v2's `library` source: every installed plugin and its state. A plugin the host refused
/// comes first, marked, with its sentence.
fn library(api: &Api) -> Vec<Value> {
    let mut all = api.parts.host.plugins();
    all.sort_by_key(|p| p.state != PluginState::Refused);
    all.into_iter()
        .map(|p| {
            let state = match (&p.state, p.enabled) {
                (PluginState::Refused, _) => format!(
                    "▲ {}",
                    p.sentence.as_deref().unwrap_or("it could not be loaded")
                ),
                (_, false) => "■ not enabled".into(),
                (PluginState::Running, true) => OK.into(),
                _ => "● enabled".into(),
            };
            json!({ "id": p.id.0, "name": p.name, "version": p.version, "state": state })
        })
        .collect()
}

fn plugin_detail(api: &Api, id: &str) -> String {
    if let Some(d) = api
        .parts
        .host
        .manifests()
        .into_iter()
        .find(|d| d.manifest.id == id)
    {
        let m = &d.manifest;
        let mut lines = vec![
            m.summary.clone(),
            String::new(),
            format!("{} · {}", m.version, m.license),
        ];
        if !m.requires.is_empty() {
            lines.extend([String::new(), "It asked for:".into()]);
            lines.extend(
                m.requires
                    .iter()
                    .map(|r| format!("- {} — {}", r.cap, r.why)),
            );
        }
        return lines.join("\n");
    }
    match api.parts.host.plugins().into_iter().find(|p| p.id.0 == id) {
        Some(p) => format!("{} {} is not enabled.", p.name, p.version),
        None => "That plugin is not installed any more.".into(),
    }
}

// ---- core's own buttons (v2 surface.ts `actions`) ----

async fn core_action(api: &Api, key: &str, row: &str) -> Option<Value> {
    Some(match key {
        "new_chat" => new_chat(api),
        "open_chat" => open_chat(api, row),
        "forget_chat" => forget_chat(api, row),
        "use_model" => use_model(api, row),
        "automatic" => automatic(api),
        "set_order" => set_order(api, row),
        "set_keyless" => set_keyless(api, row),
        "set_speed" => set_speed(api, row),
        "set_spend" | "set_cross" => said(false, FREE_ONLY),
        "export_run" => export_run(api, row),
        "open_run_chat" => open_run_chat(api, row),
        "allow_skill" | "allow_here" => allow_skill(api, row),
        "forget_skill" | "forget_here" => forget_skill(api, row),
        _ => return None,
    })
}

// ---- a plugin's tables and buttons (serve.ts 3043–3168) ----

/// Every widget a plugin declared: its settings, then its panel's (v2 `declaredWidgets`).
fn widgets(api: &Api, plugin: &str) -> Option<Vec<Map<String, Value>>> {
    let dir = api
        .parts
        .host
        .manifests()
        .into_iter()
        .find(|d| d.manifest.id == plugin)?;
    let m = dir.manifest;
    let mut out: Vec<Map<String, Value>> = m
        .settings
        .iter()
        .map(|st| {
            let mut w = st.widget.clone();
            w.insert("key".into(), json!(st.key));
            w.insert("type".into(), json!(st.kind));
            w
        })
        .collect();
    if let Some(list) = m
        .panel
        .as_ref()
        .and_then(|p| p.get("widgets"))
        .and_then(Value::as_array)
    {
        out.extend(list.iter().filter_map(|w| w.as_object().cloned()));
    }
    Some(out)
}

fn str_of<'a>(w: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    w.get(k).and_then(Value::as_str)
}

/// v2 `declaredAction`: an `action` widget, or a row action on any widget that has them.
fn declared_action(widgets: &[Map<String, Value>], key: &str) -> Option<(String, bool)> {
    for w in widgets {
        if str_of(w, "type") == Some("action") && str_of(w, "key") == Some(key) {
            return str_of(w, "tool").map(|t| (t.to_owned(), false));
        }
        let found = w
            .get("rowActions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|a| a.get("key").and_then(Value::as_str) == Some(key));
        if let Some(a) = found {
            return a
                .get("tool")
                .and_then(Value::as_str)
                .map(|t| (t.to_owned(), true));
        }
    }
    None
}

/// The permission ruling for a plugin's tool, as the agent asks it (`permissions::rule` with
/// the tool's annotations and `reviewed`).
async fn ruling_for(api: &Api, name: &str, args: &Map<String, Value>) -> Result<Ruling, String> {
    let Some(spec) = api
        .parts
        .tooling
        .list()
        .await
        .into_iter()
        .find(|t| t.name == name)
    else {
        return Err(format!("There is no tool called {name}."));
    };
    let scope = permissions::scope(&api.parts.store, &api.parts.layout.root);
    Ok(permissions::rule(
        &CallAsk {
            tool: name,
            words: &spec.words,
            annotations: spec.annotations.as_ref(),
            paths: permissions::paths_in(args),
            reviewed: spec.reviewed,
        },
        &scope,
    ))
}

/// The answer before a call: `None` to go ahead, else what to send back.
fn held_back(ruling: &Ruling, approved: bool) -> Option<Value> {
    match ruling {
        Ruling::Run => None,
        Ruling::Ask(_) if approved => None,
        Ruling::Ask(q) => Some(json!({ "ok": false, "confirm": true, "said": q })),
        Ruling::Blocked(why) => Some(said(false, why.clone())),
    }
}

fn window_run() -> RunId {
    static N: AtomicU64 = AtomicU64::new(0);
    RunId(format!(
        "window-{}-{}",
        now_ms(),
        N.fetch_add(1, Ordering::Relaxed)
    ))
}

async fn call(
    api: &Api,
    run: &RunId,
    name: &str,
    args: Map<String, Value>,
) -> alexia_core::ToolOutcome {
    api.parts
        .tooling
        .call(
            name,
            args,
            ToolCtx {
                session: api.session(),
                run: run.clone(),
                origin: Origin::Window,
                background: false,
                cancel: CancellationToken::new(),
                progress: None,
            },
        )
        .await
}

/// One audit row for a press: the owner's own tool call, logged like any other (TR-08).
#[allow(clippy::too_many_arguments)]
fn audit(
    api: &Api,
    run: &RunId,
    plugin: &str,
    name: &str,
    args: &Map<String, Value>,
    gate: &str,
    decision: &str,
    why: Option<&str>,
    out: Option<&alexia_core::ToolOutcome>,
) {
    use alexia_core::redact::{redact_json, redact_text};
    let clean = |t: &str| redact_text(t).0.chars().take(2000).collect::<String>();
    let row = AuditRow {
        id: 0,
        at: now_ms(),
        run: run.0.clone(),
        session: Some(api.session()),
        origin: serde_json::to_string(&Origin::Window).unwrap_or_default(),
        step: 1,
        tool: name.to_owned(),
        plugin: Some(plugin.to_owned()),
        args: redact_json(&Value::Object(args.clone())).to_string(),
        gate: gate.to_owned(),
        decision: decision.to_owned(),
        why: why.map(clean),
        ok: out.map(|o| o.ok),
        result: out.map(|o| clean(&o.text)),
        undo: None,
        undone_at: None,
    };
    if let Err(e) = api.parts.store.audit(&row) {
        tracing::warn!("a window button's audit row could not be written: {e}");
    }
}

/// `/api/rows` (row None) or `/api/detail` (row Some) for a plugin's table.
async fn plugin_table(
    api: &Api,
    plugin: &str,
    key: &str,
    row: Option<&str>,
    approved: bool,
) -> Value {
    let none = || said(false, format!("There is no list called \"{key}\"."));
    let Some(ws) = widgets(api, plugin) else {
        return none();
    };
    let Some(w) = ws
        .iter()
        .find(|w| str_of(w, "key") == Some(key) && str_of(w, "rows").is_some())
    else {
        return none();
    };
    let tool = if row.is_some() {
        str_of(w, "detail")
    } else {
        str_of(w, "rows")
    };
    let Some(tool) = tool else {
        return none();
    };
    let name = namespaced(&PluginId(plugin.to_owned()), tool);
    let mut args = Map::new();
    if let Some(r) = row {
        args.insert("id".into(), json!(r));
    }
    let ruling = match ruling_for(api, &name, &args).await {
        Ok(r) => r,
        Err(e) => return said(false, e),
    };
    if let Some(v) = held_back(&ruling, approved) {
        return v;
    }
    let out = call(api, &window_run(), &name, args).await;
    if !out.ok {
        return said(false, out.text);
    }
    if row.is_some() {
        return json!({ "ok": true, "text": out.text });
    }
    // A `tree` answers with `nodes` (alexia_protocol 11); the window reads it as `rows`.
    let field = if str_of(w, "type") == Some("tree") {
        "nodes"
    } else {
        "rows"
    };
    match rows_in(&out.text, field) {
        Ok(rows) => json!({ "ok": true, "rows": rows }),
        Err(why) => said(false, format!("\"{tool}\" {why}")),
    }
}

/// The rows a `rows` tool answered with. v3's tooling hands back a call's text, and MCP has a
/// tool that returns `structuredContent` also return it serialized as text, so the JSON is read
/// from there: `{"rows": [...]}` (or `nodes`), or the list itself.
fn rows_in(text: &str, field: &str) -> Result<Vec<Value>, String> {
    let thing = if field == "nodes" { "node" } else { "row" };
    let parsed: Value = serde_json::from_str(text.trim()).map_err(|_| {
        format!("answered without structuredContent.{field}, so there is nothing to show.")
    })?;
    let list = match parsed {
        Value::Array(a) => a,
        Value::Object(mut m) => match m.remove(field) {
            Some(Value::Array(a)) => a,
            _ => {
                return Err(format!(
                    "answered without structuredContent.{field}, so there is nothing to show."
                ))
            }
        },
        _ => {
            return Err(format!(
                "answered without structuredContent.{field}, so there is nothing to show."
            ))
        }
    };
    let mut out = Vec::with_capacity(list.len());
    for (at, mut r) in list.into_iter().enumerate() {
        let id = match r.get("id") {
            Some(Value::String(_)) => None,
            Some(Value::Number(n)) => Some(n.to_string()),
            _ => {
                return Err(format!(
                    "answered with a {thing} that has no id ({thing} {}).",
                    at + 1
                ))
            }
        };
        if let Some(id) = id {
            r["id"] = json!(id);
        }
        out.push(r);
    }
    Ok(out)
}

/// `/api/action` for a plugin's button or row action: the gate, the call, the audit row.
async fn plugin_action(api: &Api, plugin: &str, key: &str, row: &str, approved: bool) -> Value {
    let no_button = || said(false, format!("There is no button called \"{key}\"."));
    let Some(ws) = widgets(api, plugin) else {
        return no_button();
    };
    let Some((tool, takes_row)) = declared_action(&ws, key) else {
        return no_button();
    };
    let row = (!row.is_empty()).then_some(row);
    if takes_row != row.is_some() {
        return said(
            false,
            if takes_row {
                format!("\"{key}\" acts on a row, and none was named.")
            } else {
                format!("\"{key}\" is not a row action.")
            },
        );
    }
    let name = namespaced(&PluginId(plugin.to_owned()), &tool);
    let mut args = Map::new();
    if let Some(r) = row {
        args.insert("id".into(), json!(r));
    }
    let ruling = match ruling_for(api, &name, &args).await {
        Ok(r) => r,
        Err(e) => return said(false, e),
    };
    let run = window_run();
    if let Some(v) = held_back(&ruling, approved) {
        if let Ruling::Blocked(why) = &ruling {
            audit(
                api,
                &run,
                plugin,
                &name,
                &args,
                "blocked",
                "blocked",
                Some(why),
                None,
            );
        }
        return v;
    }
    let out = call(api, &run, &name, args.clone()).await;
    let (gate, decision, why) = match &ruling {
        Ruling::Ask(q) => ("ask", "approved", Some(q.as_str())),
        _ => ("run", "ran", None),
    };
    audit(
        api,
        &run,
        plugin,
        &name,
        &args,
        gate,
        decision,
        why,
        Some(&out),
    );
    let text = if out.text.trim().is_empty() {
        if out.ok {
            "Done."
        } else {
            "That did not work."
        }
        .to_owned()
    } else {
        out.text.clone()
    };
    said(out.ok, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_in_reads_text_json() {
        let r = rows_in(r#"{"rows":[{"id":"a"},{"id":3}]}"#, "rows").unwrap();
        assert_eq!(r, vec![json!({"id": "a"}), json!({"id": "3"})]);
        assert_eq!(rows_in(r#"[{"id":"x"}]"#, "rows").unwrap().len(), 1);
        assert!(rows_in("Hello.", "rows")
            .unwrap_err()
            .contains("structuredContent.rows"));
        assert!(rows_in(r#"{"rows":[{"name":"x"}]}"#, "rows")
            .unwrap_err()
            .contains("(row 1)"));
        assert!(rows_in(r#"{"nodes":[{"id":"n"}]}"#, "nodes").is_ok());
    }

    #[test]
    fn metadata_reads_the_nested_block() {
        let m = metadata("---\nmetadata:\n  learned: true\n  learned_from: \"tidy \\\"it\\\"\"\nname: a\n---\nbody");
        assert_eq!(m.get("learned").map(String::as_str), Some("true"));
        assert_eq!(
            m.get("learned_from").map(String::as_str),
            Some("tidy \"it\"")
        );
        assert!(!m.contains_key("name"));
    }

    #[test]
    fn split_row_forms() {
        assert_eq!(split_row("p\nm/x"), (Some("p"), "m/x"));
        assert_eq!(split_row("p/m"), (Some("p"), "m"));
        assert_eq!(split_row("m"), (None, "m"));
    }

    #[test]
    fn declared_action_finds_buttons_and_row_actions() {
        let ws: Vec<Map<String, Value>> = vec![
            json!({"type": "action", "key": "go", "tool": "run"}).as_object().unwrap().clone(),
            json!({"type": "table", "key": "t", "rows": "list", "rowActions": [{"key": "drop", "tool": "del"}]})
                .as_object()
                .unwrap()
                .clone(),
        ];
        assert_eq!(declared_action(&ws, "go"), Some(("run".into(), false)));
        assert_eq!(declared_action(&ws, "drop"), Some(("del".into(), true)));
        assert_eq!(declared_action(&ws, "nope"), None);
    }
}
