// SPDX-License-Identifier: AGPL-3.0-only
//! State, setup and the settings screen (INVENTORY A1–A7).
//!
//! A port of v2 serve.ts 1915–2060 (`/api/state`, `/api/adult`), 2215–2360 (`/api/setup`),
//! 2446–2503 (`/api/permissions`, `/api/ceilings`) and 2565–2590 (`/api/panels`,
//! `/api/search`), with `panels.ts` `tabs`, `palette.ts` `search` and `surface.ts` `searchable`.
//! Every value is read from the kv keys v2 wrote (`_core` namespace), so an imported v2 store
//! answers as v2 did; where v3 already owns a key (`_core.scope`, `_core.boundaries`), v3's
//! reader (`alexia_core::permissions::scope`) is the one used.
//!
//! v3 never pays (D-P2D-6): `spent`, `cap` and the day's allowance are zero, `cross` is false,
//! and a positive `daily` or `monthly` is refused. A provider key goes to the OS keychain as
//! `_core`/`provider_<id>` and is never echoed, logged or written to kv: only whether one is
//! stored (`keyStored`) leaves this module. Channels and the personality chip are found by
//! capability, never by plugin id.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::util::{adult_on, kv, lock, CORE};
use alexia_core::free::{self, Auth, FreeRow};
use alexia_core::permissions;
use alexia_core::PermissionMode;
use alexia_mcp::{CallCtx, PluginState};
use alexia_store::{now_ms, secrets, Message, Role};
use axum::extract::{Query, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Extension, Router};
use serde_json::{json, Map, Value};

use crate::gate::Sent;
use crate::json;
use crate::{compute, editor, local_models, Api};

/// The kv namespace v2's core wrote these under.
/// v2 `NAME_LONGEST`: the longest name she may be given, in characters.
pub(crate) const NAME_LONGEST: usize = 40;
/// v2 `THEMES`.
const THEMES: &[&str] = &["system", "light", "dark"];
/// v2 `MODES` (router.ts): where the work runs.
const MODES: &[&str] = &["local", "combined", "cloud"];
/// v2 `MODE_LABELS` (permissions.ts), in v2's order.
const MODE_LABELS: &[(&str, &str)] = &[
    ("every-time", "Ask me every time"),
    ("risky", "Ask before anything risky"),
    ("watch", "Watch and warn me"),
    ("full-trust", "Full trust"),
];
/// v2 `DEFAULT_CEILINGS` (preview.ts).
const DEFAULT_STEPS: u64 = 24;
const DEFAULT_ASK_ABOVE: f64 = 0.02;
/// v2 `ADULT` (commands.ts).
const ADULT: &str = "adult";
/// v2 `CORE_CAPABILITIES`.
const CHANNEL: &str = "channel.chat";
const IN_USE: &str = "persona.in_use";
const NOT_HER: &str = "persona.not_her";
/// v2 pool.ts `FLOOR`: the keyless floor's switch, on unless somebody said otherwise.
const FLOOR: &str = "keyless.on";
/// v2 pool.ts `SPEED`.
const SPEED: &str = "speed";
/// D-P2D-6's sentence.
pub(crate) const NEVER_PAYS: &str = "Alexia v3 only uses free models.";
/// How long the chip and `notHer` are kept before they are asked again. v2 kept them until a
/// plugin's tools changed; asking wakes the persona plugin, so not on every state poll.
const WHO_KEPT: Duration = Duration::from_secs(30);
/// v2 palette.ts `MOST`.
const MOST: usize = 8;

/// What this screen keeps between requests: the last answer to "who is speaking".
#[derive(Default)]
pub(crate) struct StateState {
    who: Mutex<Option<(Instant, Map<String, Value>)>>,
}

pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new()
        .route("/api/state", get(state))
        .route("/api/setup", post(setup_post))
        .route("/api/permissions", post(permissions_post))
        .route("/api/ceilings", post(ceilings_post))
        .route("/api/adult", post(adult_post))
        .route("/api/panels", get(panels))
        .route("/api/search", get(search_get))
}

// ---- kv readers (v2's, key for key) ----

fn kv_str(api: &Api, key: &str) -> Option<String> {
    kv(api, key).and_then(|v| v.as_str().map(str::to_owned))
}

/// v2 `calledBy`: the name chosen in Settings, or *Alexia* until somebody chooses one.
fn called_by(api: &Api) -> String {
    kv_str(api, "display_name")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Alexia".into())
}

/// v2 `setup()` (serve.ts 820–848).
fn setup(api: &Api) -> Map<String, Value> {
    let mode = kv_str(api, "mode");
    let mut m = Map::new();
    m.insert("done".into(), kv(api, "mode").is_some().into());
    m.insert("name".into(), called_by(api).into());
    m.insert(
        "mode".into(),
        mode.unwrap_or_else(|| "combined".into()).into(),
    );
    m.insert(
        "theme".into(),
        kv_str(api, "theme")
            .unwrap_or_else(|| "system".into())
            .into(),
    );
    m.insert(
        "glass".into(),
        kv(api, "glass")
            .filter(Value::is_number)
            .unwrap_or_else(|| json!(60)),
    );
    m.insert(
        "glassLook".into(),
        kv_str(api, "glass_look")
            .unwrap_or_else(|| "auto".into())
            .into(),
    );
    m.insert(
        "updates".into(),
        kv(api, "updates_auto")
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
            .into(),
    );
    m
}

/// v2 `layout()`: the board as last arranged, or `null` for never.
fn layout(api: &Api) -> Value {
    kv(api, "layout").unwrap_or(Value::Null)
}

/// v2 `chosen(store)`: the pins as stored, without `placement`.
fn chosen(api: &Api) -> Map<String, Value> {
    let mut pins = kv(api, "pins")
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    pins.remove("placement");
    pins
}

/// v2 `adultConfirmed`: the moment the person said they are 18 or older.
fn adult_confirmed(api: &Api) -> bool {
    kv(api, ADULT).is_some_and(|v| v.get("confirmedAt").is_some_and(Value::is_number))
}

/// v2 `keylessOn`.
fn keyless_on(api: &Api) -> bool {
    kv(api, FLOOR).and_then(|v| v.as_bool()).unwrap_or(true)
}

/// v2 `ceilings(store)` without `monthly` (v2 `limitsNow`; v3 has no budget, D-P2D-6).
fn ceilings(api: &Api) -> Map<String, Value> {
    let saved = kv(api, "ceilings")
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let mut now = Map::new();
    now.insert("steps".into(), json!(DEFAULT_STEPS));
    now.insert("askAbove".into(), json!(DEFAULT_ASK_ABOVE));
    for (k, v) in saved {
        now.insert(k, v);
    }
    now.remove("monthly");
    now
}

/// v2 `today(store)`: nothing is ever spent and nothing may be (D-P2D-6).
fn today() -> Value {
    json!({ "spent": 0, "allowance": 0 })
}

/// v2's kebab names for the permission modes.
fn mode_name(m: PermissionMode) -> &'static str {
    match m {
        PermissionMode::AskEveryTime => "every-time",
        PermissionMode::AskRisky => "risky",
        PermissionMode::WatchAndWarn => "watch",
        PermissionMode::FullTrust => "full-trust",
    }
}

fn mode_labels() -> Value {
    Value::Object(
        MODE_LABELS
            .iter()
            .map(|(k, v)| ((*k).to_owned(), Value::from(*v)))
            .collect(),
    )
}

/// `{mode, roots, everywhere, boundaries}`, as v3's reader sees `_core.scope`.
fn permissions_now(api: &Api) -> Map<String, Value> {
    let scope = permissions::scope(&api.parts.store, &api.parts.layout.root);
    let mut m = Map::new();
    m.insert("mode".into(), mode_name(scope.mode).into());
    m.insert(
        "roots".into(),
        scope
            .roots
            .iter()
            .map(|r| Value::from(r.to_string_lossy().into_owned()))
            .collect(),
    );
    m.insert("everywhere".into(), scope.everywhere.into());
    m.insert("boundaries".into(), json!(scope.boundaries));
    m
}

// ---- the providers (v2 provider.ts `PROVIDERS`, for the rows the ladder keeps) ----

/// What v2's provider row says for the key wall that v3's `FreeRow` does not carry.
struct Shown {
    name: &'static str,
    terms: Option<&'static str>,
    verified: Option<&'static str>,
    trains: &'static str,
    friction: Option<&'static str>,
    card: bool,
    calls_per_month: Option<u32>,
}

#[rustfmt::skip]
const SHOWN: &[(&str, Shown)] = &[
    ("openrouter", Shown { name: "OpenRouter", terms: Some("https://openrouter.ai/terms"), verified: Some("2026-08-27"), trains: "unknown", friction: None, card: false, calls_per_month: None }),
    ("groq", Shown { name: "Groq", terms: Some("https://groq.com/terms-of-use/"), verified: Some("2026-09-17"), trains: "unknown", friction: None, card: false, calls_per_month: None }),
    ("cerebras", Shown { name: "Cerebras", terms: Some("https://www.cerebras.ai/terms-of-service"), verified: Some("2026-09-17"), trains: "unknown", friction: Some("Wants a verified payment method, and its $5 of free credit runs out after 30 days"), card: true, calls_per_month: None }),
    ("google", Shown { name: "Google AI Studio", terms: Some("https://ai.google.dev/gemini-api/terms"), verified: Some("2026-08-27"), trains: "unknown", friction: None, card: false, calls_per_month: None }),
    ("mistral", Shown { name: "Mistral", terms: Some("https://mistral.ai/terms"), verified: Some("2026-08-27"), trains: "unknown", friction: None, card: false, calls_per_month: None }),
    ("nvidia", Shown { name: "NVIDIA NIM", terms: Some("https://build.nvidia.com/terms"), verified: Some("2026-08-27"), trains: "unknown", friction: None, card: false, calls_per_month: None }),
    ("github", Shown { name: "GitHub Models", terms: Some("https://docs.github.com/site-policy/github-terms/github-terms-of-service"), verified: Some("2026-08-27"), trains: "unknown", friction: None, card: false, calls_per_month: None }),
    ("ovhcloud", Shown { name: "OVHcloud AI Endpoints", terms: None, verified: Some("2026-09-17"), trains: "unknown", friction: None, card: false, calls_per_month: None }),
    ("aihorde", Shown { name: "AI Horde", terms: None, verified: Some("2026-08-30"), trains: "unknown", friction: None, card: false, calls_per_month: None }),
    ("uncloseai", Shown { name: "UncloseAI", terms: None, verified: Some("2026-08-30"), trains: "unknown", friction: None, card: false, calls_per_month: None }),
    ("kilo-gateway", Shown { name: "Kilo Gateway", terms: None, verified: Some("2026-08-30"), trains: "yes", friction: None, card: false, calls_per_month: None }),
    ("llm7", Shown { name: "LLM7", terms: None, verified: Some("2026-09-17"), trains: "unknown", friction: None, card: false, calls_per_month: None }),
    ("nara", Shown { name: "NaraRouter", terms: None, verified: Some("2026-08-30"), trains: "unknown", friction: Some("Free key needs Telegram verification, not a card"), card: false, calls_per_month: None }),
    ("cloudflare-ai", Shown { name: "Cloudflare Workers AI", terms: None, verified: Some("2026-08-30"), trains: "unknown", friction: None, card: false, calls_per_month: None }),
    ("ollama-cloud", Shown { name: "Ollama Cloud", terms: None, verified: Some("2026-08-30"), trains: "unknown", friction: None, card: false, calls_per_month: None }),
    ("zai", Shown { name: "Z.ai (global console)", terms: None, verified: Some("2026-08-30"), trains: "unknown", friction: None, card: false, calls_per_month: None }),
    ("cohere", Shown { name: "Cohere", terms: None, verified: Some("2026-08-30"), trains: "unknown", friction: None, card: false, calls_per_month: Some(1_000) }),
    ("aion", Shown { name: "Aion Labs", terms: None, verified: Some("2026-08-30"), trains: "unknown", friction: None, card: false, calls_per_month: None }),
    ("agnes", Shown { name: "Agnes AI", terms: None, verified: Some("2026-08-30"), trains: "unknown", friction: None, card: false, calls_per_month: None }),
    ("requesty", Shown { name: "Requesty", terms: None, verified: Some("2026-08-30"), trains: "unknown", friction: None, card: false, calls_per_month: None }),
    ("sealion", Shown { name: "SEA-LION", terms: None, verified: Some("2026-08-30"), trains: "unknown", friction: None, card: false, calls_per_month: None }),
    ("navy", Shown { name: "Navy", terms: None, verified: Some("2026-08-30"), trains: "unknown", friction: None, card: false, calls_per_month: None }),
];

fn shown(id: &str) -> Option<&'static Shown> {
    SHOWN.iter().find(|(i, _)| *i == id).map(|(_, s)| s)
}

fn name_of(row: &FreeRow) -> String {
    shown(&row.id).map_or_else(|| row.id.clone(), |s| s.name.to_owned())
}

/// v2 `keyOf`.
fn key_name(id: &str) -> String {
    format!("provider_{id}")
}

/// v2 `anonymous`: answers without a key.
fn anonymous(row: &FreeRow) -> bool {
    row.auth != Auth::Required
}

/// Whether a key is stored for this provider. A keychain that refuses, or a provider id the
/// keychain cannot name, is *no key* (v2: a column on a table, never an exception).
fn key_stored(row: &FreeRow) -> bool {
    matches!(secrets::get(CORE, &key_name(&row.id)), Ok(Some(_)))
}

/// `/api/state`'s `providers[]` (serve.ts 1985–2035).
fn providers(api: &Api) -> Vec<Value> {
    let floor = keyless_on(api);
    free::ladder()
        .iter()
        .map(|row| {
            let keyed = key_stored(row);
            let s = shown(&row.id);
            let mut p = Map::new();
            p.insert("id".into(), row.id.clone().into());
            p.insert("name".into(), name_of(row).into());
            if let Some(t) = s.and_then(|s| s.terms) {
                p.insert("terms".into(), t.into());
            }
            p.insert(
                "trainsOnYourData".into(),
                s.map_or("unknown", |s| s.trains).into(),
            );
            p.insert(
                "free".into(),
                (row.rpd.is_some() || row.rpm.is_some()).into(),
            );
            if let Some(n) = row.rpm {
                p.insert("rpm".into(), n.into());
            }
            if let Some(n) = row.rpd {
                p.insert("rpd".into(), n.into());
            }
            if let Some(n) = s.and_then(|s| s.calls_per_month) {
                p.insert("callsPerMonth".into(), n.into());
            }
            if let Some(v) = s.and_then(|s| s.verified) {
                p.insert("verified".into(), v.into());
            }
            if let Some(f) = s.and_then(|s| s.friction) {
                p.insert("friction".into(), f.into());
            }
            if s.is_some_and(|s| s.card) {
                p.insert("card".into(), true.into());
            }
            p.insert("keyless".into(), anonymous(row).into());
            p.insert("account".into(), row.base_url.contains("{account}").into());
            p.insert(
                "connected".into(),
                (keyed || (anonymous(row) && floor)).into(),
            );
            p.insert("keyStored".into(), keyed.into());
            Value::Object(p)
        })
        .collect()
}

// ---- by capability ----

/// v2 `plugins.reachable(cap)`: enabled, healthy plugins providing `cap` whose every declared
/// password is stored. Counted, never named.
fn reachable(api: &Api, cap: &str) -> usize {
    let unhealthy: Vec<String> = api
        .parts
        .host
        .plugins()
        .into_iter()
        .filter(|p| p.state == PluginState::Unhealthy)
        .map(|p| p.id.0)
        .collect();
    api.parts
        .host
        .manifests()
        .into_iter()
        .map(|d| d.manifest)
        .filter(|m| m.provides.iter().any(|p| p == cap) && !unhealthy.contains(&m.id))
        .filter(|m| {
            m.settings
                .iter()
                .filter(|s| s.kind == "password")
                .all(|s| matches!(secrets::get(&m.id, &s.key), Ok(Some(_))))
        })
        .count()
}

/// v2 `chip()`: the name of the personality in use, from `persona.in_use`, at most 40
/// characters. Nothing provides it, or whatever does fails: no chip.
async fn chip(api: &Api) -> Option<String> {
    if !api.parts.host.answers(IN_USE).answers {
        return None;
    }
    let answered = api
        .parts
        .host
        .call_capability(IN_USE, Map::new(), CallCtx::default())
        .await
        .ok()?;
    if answered.is_error == Some(true) {
        return None;
    }
    let said: String = answered
        .content
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<String>()
        .trim()
        .to_owned();
    (!said.is_empty()).then(|| said.chars().take(40).collect())
}

/// v2 `who()`: the chip and whether *That wasn't her* has a bound tool behind it (the
/// binding, not the manifest's promise). Kept for [`WHO_KEPT`].
async fn who(api: &Api) -> Map<String, Value> {
    let kept = lock(&api.state.who)
        .as_ref()
        .filter(|(at, _)| at.elapsed() < WHO_KEPT)
        .map(|(_, m)| m.clone());
    if let Some(m) = kept {
        return m;
    }
    let character = chip(api).await;
    let not_her = api.parts.host.answers(NOT_HER).answers
        && api
            .parts
            .host
            .tools()
            .await
            .iter()
            .any(|t| t.provides.iter().any(|p| p == NOT_HER));
    let mut m = Map::new();
    if let Some(c) = character {
        m.insert("character".into(), c.into());
    }
    m.insert("notHer".into(), not_her.into());
    *lock(&api.state.who) = Some((Instant::now(), m.clone()));
    m
}

/// v2 `store.history(session)`: `{role, model?, ...body}`.
fn message(m: &Message) -> Value {
    let mut out = match serde_json::to_value(&m.body) {
        Ok(Value::Object(o)) => o,
        _ => Map::new(),
    };
    let role = match m.role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    };
    let mut v = Map::new();
    v.insert("role".into(), role.into());
    if let Some(model) = &m.model {
        v.insert("model".into(), model.clone().into());
    }
    v.append(&mut out);
    Value::Object(v)
}

// ---- GET /api/state ----

async fn state(State(api): State<Arc<Api>>) -> Response {
    let session = api.session();
    let messages: Vec<Value> = match api.parts.store.history(session, None) {
        Ok(h) => h.iter().map(message).collect(),
        Err(e) => return json::said(500, &e.to_string()),
    };
    let manifests: Vec<_> = api
        .parts
        .host
        .manifests()
        .into_iter()
        .map(|d| d.manifest)
        .collect();
    let commands: Vec<Value> = alexia_core::commands::list(&manifests)
        .iter()
        .map(|c| {
            let mut m = Map::new();
            m.insert("name".into(), c.name.clone().into());
            m.insert("summary".into(), c.summary.clone().into());
            if let Some(a) = &c.alias {
                m.insert("alias".into(), a.clone().into());
            }
            if let Some(p) = &c.plugin {
                m.insert("plugin".into(), p.0.clone().into());
            }
            if c.shadowed {
                m.insert("shadowed".into(), true.into());
            }
            Value::Object(m)
        })
        .collect();

    let mut body = Map::new();
    body.insert("setup".into(), Value::Object(setup(&api)));
    let transition = local_models::transition(&api);
    if !transition.is_null() {
        body.insert("modeTransition".into(), transition);
    }
    body.insert("compute".into(), compute::state(&api));
    body.insert("editor".into(), editor::state(&api));
    body.insert(
        "adult".into(),
        json!({ "confirmed": adult_confirmed(&api), "on": adult_on(&api) }),
    );
    body.insert("layout".into(), layout(&api));
    body.insert("channels".into(), reachable(&api, CHANNEL).into());
    body.insert("app".into(), api.parts.app_version.clone().into());
    body.insert("commands".into(), commands.into());
    body.insert("pins".into(), Value::Object(chosen(&api)));
    body.insert("messages".into(), messages.into());
    body.insert("spent".into(), 0.into());
    body.insert("cap".into(), 0.into());
    body.insert("today".into(), today());
    body.append(&mut who(&api).await);
    body.insert("cross".into(), false.into());
    body.insert("ceilings".into(), Value::Object(ceilings(&api)));
    let mut perms = permissions_now(&api);
    perms.insert("modes".into(), mode_labels());
    body.insert("permissions".into(), Value::Object(perms));
    body.insert("providers".into(), providers(&api).into());
    json::ok(Value::Object(body))
}

// ---- POST /api/setup ----

/// A refusal on its way out: the status and the sentence (`{ok:false, said}`).
type Fail = (u16, String);

fn fail(f: Fail) -> Response {
    json::said(f.0, &f.1)
}

fn set(api: &Api, key: &str, v: &Value) -> Result<(), Fail> {
    api.parts
        .store
        .kv_set(CORE, key, v)
        .map_err(|e| (500, e.to_string()))
}

/// v2 `readLayout` (layout.ts): checked for shape and refused whole, with the reason.
pub(crate) fn read_layout(sent: &Value) -> Result<Value, String> {
    let no = |why: String| Err(format!("That layout cannot be kept: {why}."));
    let finite = |v: Option<&Value>| v.and_then(Value::as_f64).filter(|n| n.is_finite());
    let whole =
        |v: Option<&Value>, least: f64| finite(v).filter(|n| n.fract() == 0.0 && *n >= least);
    let Some(l) = sent.as_object() else {
        return no("it is not an object".into());
    };
    if l.get("v").and_then(Value::as_f64) != Some(1.0) {
        return no("it is not version 1".into());
    }
    if finite(l.get("cols")).filter(|n| *n > 0.0).is_none() {
        return no("cols must be a number above 0".into());
    }
    let rows = match l.get("rows") {
        None => None,
        Some(r) => match finite(Some(r)).filter(|n| *n > 0.0) {
            Some(_) => Some(r.clone()),
            None => return no("rows must be a number above 0".into()),
        },
    };
    let guides = match l.get("guides").and_then(Value::as_array) {
        Some(g) if g.len() == 2 && g.iter().all(|x| finite(Some(x)).is_some()) => g.clone(),
        _ => return no("guides must be two numbers".into()),
    };
    let Some(pages) = l.get("pages").and_then(Value::as_array) else {
        return no("pages must be a list".into());
    };
    const MAX_PAGES: usize = 64;
    if pages.len() > MAX_PAGES {
        return no(format!("there are more than {MAX_PAGES} pages"));
    }
    let mut kept = Vec::with_capacity(pages.len());
    let mut seen: Vec<&str> = Vec::new();
    for (i, one) in pages.iter().enumerate() {
        let at = format!("page {}", i + 1);
        let Some(p) = one.as_object() else {
            return no(format!("{at} is not an object"));
        };
        let id = match p.get("id").and_then(Value::as_str) {
            Some(id) if !id.is_empty() && id.encode_utf16().count() <= 64 => id,
            _ => return no(format!("{at} has no id")),
        };
        if seen.contains(&id) {
            return no(format!("{at} ({id}) is on the board twice"));
        }
        seen.push(id);
        if whole(p.get("w"), 1.0).is_none() || whole(p.get("h"), 1.0).is_none() {
            return no(format!(
                "{at} ({id}) needs a whole width and height of at least 1"
            ));
        }
        let mut page = Map::new();
        page.insert("id".into(), id.into());
        page.insert("w".into(), p["w"].clone());
        page.insert("h".into(), p["h"].clone());
        if let Some(a) = p.get("anchor") {
            let ok = a.as_object().is_some_and(|a| {
                whole(a.get("x"), 0.0).is_some() && whole(a.get("y"), 0.0).is_some()
            });
            if !ok {
                return no(format!(
                    "{at} ({id}) has an anchor that is not two whole numbers from 0"
                ));
            }
            page.insert("anchor".into(), json!({ "x": a["x"], "y": a["y"] }));
        }
        kept.push(Value::Object(page));
    }
    let mut out = Map::new();
    out.insert("v".into(), 1.into());
    out.insert("cols".into(), l["cols"].clone());
    if let Some(r) = rows {
        out.insert("rows".into(), r);
    }
    out.insert("guides".into(), Value::Array(guides));
    out.insert("pages".into(), Value::Array(kept));
    Ok(Value::Object(out))
}

/// The catalog's lists, asked again behind the answer: a key just saved is what makes most
/// providers' models knowable. Never waited for.
fn refresh_lists(api: &Api) {
    let catalog = api.parts.catalog.clone();
    tokio::spawn(async move { catalog.refresh().await });
}

/// v2 `connectedNow`, without the wait: the key goes to the keychain, the lists are asked for
/// behind the answer, and a provider that refuses the key leaves the catalog on that refresh.
fn connect(api: &Api, row: &FreeRow, key: &str) -> Result<String, Fail> {
    if let Err(e) = secrets::set(CORE, &key_name(&row.id), key) {
        // The error never carries the secret (alexia-store SP-18).
        tracing::warn!("a provider key could not be stored: {e}");
        return Err((
            500,
            format!(
                "The {} key could not be stored in this computer's keychain.",
                name_of(row)
            ),
        ));
    }
    refresh_lists(api);
    let name = name_of(row);
    Ok(format!(
        "{name} connected. Its model list is still arriving — open the Models tab again in a moment."
    ))
}

/// v2 `disconnect`: the key and what its provider said about the account go.
fn disconnect(api: &Api, row: &FreeRow) -> Result<String, Fail> {
    if let Err(e) = secrets::delete(CORE, &key_name(&row.id)) {
        tracing::warn!("a provider key could not be removed: {e}");
        return Err((
            500,
            format!(
                "The {} key could not be removed from this computer's keychain.",
                name_of(row)
            ),
        ));
    }
    let _ = api
        .parts
        .store
        .kv_delete(CORE, &format!("account.{}", row.id));
    let name = name_of(row);
    if anonymous(row) && keyless_on(api) {
        return Ok(format!(
            "The {name} key is removed. {name} still answers without one, on its shared free tier."
        ));
    }
    let listed = api
        .parts
        .catalog
        .candidates()
        .iter()
        .filter(|c| c.provider == row.id)
        .count();
    let gone = match listed {
        0 => String::new(),
        1 => ", and its one model is no longer listed".into(),
        n => format!(", and its {n} models are no longer listed"),
    };
    refresh_lists(api);
    Ok(format!("The {name} key is removed{gone}."))
}

/// serve.ts 2215–2360. Each field is its own answer and stays written when a later one is
/// refused, as in v2.
async fn setup_post(
    State(api): State<Arc<Api>>,
    Extension(Sent(sent)): Extension<Sent>,
) -> Response {
    let name = sent.get("name").and_then(Value::as_str);
    if let Some(n) = name {
        if n.trim().chars().count() > NAME_LONGEST {
            return json::said(
                400,
                &format!("That name is too long. Keep it to {NAME_LONGEST} letters or fewer."),
            );
        }
    }
    let written = (|| -> Result<(), Fail> {
        if let Some(n) = name.map(str::trim).filter(|n| !n.is_empty()) {
            set(&api, "display_name", &json!(n))?;
        }
        if let Some(m) = sent.get("mode").and_then(Value::as_str) {
            if MODES.contains(&m) {
                set(&api, "mode", &json!(m))?;
            }
        }
        if let Some(t) = sent.get("theme").and_then(Value::as_str) {
            if THEMES.contains(&t) {
                set(&api, "theme", &json!(t))?;
            }
        }
        if let Some(g) = sent.get("glass").and_then(Value::as_f64) {
            if g.is_finite() {
                set(&api, "glass", &json!(g.round().clamp(0.0, 100.0) as i64))?;
            }
        }
        if let Some(l) = sent.get("glassLook").and_then(Value::as_str) {
            if ["auto", "apple", "alexia"].contains(&l) {
                set(&api, "glass_look", &json!(l))?;
            }
        }
        if let Some(u) = sent.get("updates").and_then(Value::as_bool) {
            set(&api, "updates_auto", &json!(u))?;
        }
        match sent.get("layout") {
            None => {}
            Some(Value::Null) => {
                api.parts
                    .store
                    .kv_delete(CORE, "layout")
                    .map_err(|e| (500, e.to_string()))?;
            }
            Some(l) => match read_layout(l) {
                Ok(kept) => set(&api, "layout", &kept)?,
                Err(why) => return Err((400, why)),
            },
        }
        Ok(())
    })();
    if let Err(f) = written {
        return fail(f);
    }

    let mut said: Option<String> = None;
    if let Some(p) = sent.get("provider").and_then(Value::as_object) {
        let id = p.get("id").and_then(Value::as_str).unwrap_or_default();
        let row = free::ladder().into_iter().find(|r| r.id == id);
        let key = p
            .get("key")
            .and_then(Value::as_str)
            .filter(|k| !k.is_empty());
        if let Some(key) = key {
            if key.chars().any(char::is_whitespace) {
                return json::said(
                    400,
                    "That does not look like a key — it has spaces in it. Copy the key itself and paste it again.",
                );
            }
            if let Some(row) = row {
                match connect(&api, &row, key) {
                    Ok(s) => said = Some(s),
                    Err(f) => return fail(f),
                }
            }
        } else if p.get("remove") == Some(&Value::Bool(true)) {
            if let Some(row) = row {
                match disconnect(&api, &row) {
                    Ok(s) => said = Some(s),
                    Err(f) => return fail(f),
                }
            }
        }
    }

    let mut body = setup(&api);
    let transition = local_models::transition(&api);
    if !transition.is_null() {
        body.insert("modeTransition".into(), transition);
    }
    body.insert("layout".into(), layout(&api));
    if let Some(s) = said {
        body.insert("said".into(), s.into());
    }
    json::ok(Value::Object(body))
}

// ---- POST /api/permissions ----

/// serve.ts 2446–2465: `_core.scope` in the shape `permissions::scope` reads; `lift` clears
/// the spoken boundaries.
async fn permissions_post(
    State(api): State<Arc<Api>>,
    Extension(Sent(sent)): Extension<Sent>,
) -> Response {
    let now = permissions_now(&api);
    let mode = sent
        .get("mode")
        .and_then(Value::as_str)
        .filter(|m| MODE_LABELS.iter().any(|(k, _)| k == m))
        .map_or_else(|| now["mode"].clone(), Value::from);
    let roots = match sent.get("roots").and_then(Value::as_array) {
        Some(r) => Value::Array(
            r.iter()
                .filter_map(Value::as_str)
                .map(Value::from)
                .collect(),
        ),
        None => now["roots"].clone(),
    };
    let everywhere = sent
        .get("everywhere")
        .and_then(Value::as_bool)
        .map_or_else(|| now["everywhere"].clone(), Value::from);
    if let Err(r) = set(
        &api,
        "scope",
        &json!({ "mode": mode, "roots": roots, "everywhere": everywhere }),
    ) {
        return fail(r);
    }
    if sent.get("lift") == Some(&Value::Bool(true)) {
        if let Err(r) = set(&api, "boundaries", &json!([])) {
            return fail(r);
        }
    }
    json::ok(Value::Object(permissions_now(&api)))
}

// ---- POST /api/ceilings ----

/// serve.ts 2467–2503: `steps` and `askAbove`; money is refused (D-P2D-6).
async fn ceilings_post(
    State(api): State<Arc<Api>>,
    Extension(Sent(sent)): Extension<Sent>,
) -> Response {
    let positive = |k: &str| sent.get(k).and_then(Value::as_f64).is_some_and(|n| n > 0.0);
    if positive("daily") || positive("monthly") {
        return json::said(400, NEVER_PAYS);
    }
    // v2 `setCeilings`: the defaults, what was saved (a v2 `monthly` stays where it was), then
    // what was sent.
    let mut next = ceilings(&api);
    if let Some(m) = kv(&api, "ceilings").and_then(|v| v.get("monthly").cloned()) {
        next.insert("monthly".into(), m);
    }
    if let Some(s) = sent.get("steps").and_then(Value::as_f64) {
        if s > 0.0 && s.is_finite() {
            next.insert("steps".into(), json!(s.floor() as u64));
        }
    }
    if let Some(a) = sent.get("askAbove").and_then(Value::as_f64) {
        if a >= 0.0 && a.is_finite() {
            next.insert("askAbove".into(), sent["askAbove"].clone());
        }
    }
    if let Err(r) = set(&api, "ceilings", &Value::Object(next)) {
        return fail(r);
    }
    let mut body = ceilings(&api);
    if let Value::Object(mut t) = today() {
        body.append(&mut t);
    }
    json::ok(Value::Object(body))
}

// ---- POST /api/adult ----

/// serve.ts 2045–2060.
async fn adult_post(
    State(api): State<Arc<Api>>,
    Extension(Sent(sent)): Extension<Sent>,
) -> Response {
    if sent.get("enabled") == Some(&Value::Bool(true)) {
        if sent.get("adult") != Some(&Value::Bool(true)) {
            return json::ok(json!({
                "ok": false,
                "said": "Confirm that you are 18 or older to turn adult content on.",
            }));
        }
        if let Err(r) = set(&api, ADULT, &json!({ "confirmedAt": now_ms() })) {
            return fail(r);
        }
        return json::ok(json!({
            "ok": true,
            "said": "Adult content is available. Type /nsfw in a chat to turn adult mode on, and /sfw to turn it off.",
        }));
    }
    if let Err(e) = api.parts.store.kv_delete(CORE, ADULT) {
        return json::said(500, &e.to_string());
    }
    // v2 `setPin(store, {uncensored: false})`.
    let mut pins = chosen(&api);
    pins.insert("uncensored".into(), false.into());
    if let Err(r) = set(&api, "pins", &Value::Object(pins)) {
        return fail(r);
    }
    json::ok(json!({ "ok": true, "said": "Adult content is off." }))
}

// ---- GET /api/panels (panels.ts) ----

/// v2 `CORE_TABS`, word for word.
fn core_tabs() -> Value {
    let activity = json!({
        "type": "table",
        "key": "activity",
        "label": "Runs",
        "hint": "What Alexia did for each thing you asked, newest first. She keeps the last 200 for up to 30 days. Export saves one as a file you can send.",
        "rows": "activity",
        "columns": [
            { "key": "task", "label": "What was asked" },
            { "key": "steps", "label": "Tools used", "align": "right", "hideNarrow": true },
            { "key": "cost", "label": "Cost", "align": "right" },
            { "key": "ended", "label": "How it ended" },
            { "key": "when", "label": "When", "align": "right", "hideNarrow": true },
        ],
        "rowActions": [
            { "key": "open_run_chat", "label": "Open chat", "tool": "open_run_chat" },
            { "key": "export_run", "label": "Export", "tool": "export_run" },
        ],
        "detail": "run",
        "filter": true,
    });
    let chats = json!([
        {
            "type": "action",
            "key": "new_chat",
            "label": "New chat",
            "tool": "new_chat",
            "hint": "Starts an empty conversation and opens it.",
        },
        {
            "type": "table",
            "key": "chats",
            "label": "Conversations",
            "hint": "Each chat is named by the first thing you said in it. Open takes you back into one; Forget deletes it for good.",
            "rows": "chats",
            "columns": [
                { "key": "title", "label": "Chat" },
                { "key": "turns", "label": "Turns", "align": "right", "hideNarrow": true },
                { "key": "when", "label": "Last said", "align": "right", "hideNarrow": true },
                { "key": "state", "label": "State" },
            ],
            "rowActions": [
                { "key": "open_chat", "label": "Open", "tool": "open_chat" },
                { "key": "forget_chat", "label": "Forget", "tool": "forget_chat", "confirm": "Forget “{title}” and everything in it?" },
            ],
            "detail": "chats",
            "filter": true,
        },
    ]);
    let skills = json!({
        "type": "table",
        "key": "skills",
        "label": "Your skills",
        "hint": "A skill is written instructions Alexia can read. One that says “waiting for your yes” is not used until you press Allow. Forget deletes it.",
        "rows": "skills",
        "columns": [
            { "key": "name", "label": "Name" },
            { "key": "where", "label": "Where from" },
            { "key": "state", "label": "State", "hideNarrow": true },
        ],
        "rowActions": [
            { "key": "allow_skill", "label": "Allow", "tool": "allow_skill", "confirm": "Let Alexia use {name}?", "when": { "field": "state", "is": "▲ waiting for your yes" } },
            { "key": "forget_skill", "label": "Forget", "tool": "forget_skill", "confirm": "Forget {name}?" },
        ],
        "detail": "skill",
        "filter": true,
    });
    let tools = json!({
        "type": "table",
        "key": "tools",
        "label": "Tools",
        "hint": "Every tool your plugins give Alexia. To change one, open that plugin.",
        "rows": "tools",
        "columns": [
            { "key": "name", "label": "Tool" },
            { "key": "kind", "label": "Kind", "hideNarrow": true },
        ],
        "detail": "tool",
        "filter": true,
        "groupBy": "plugin",
    });
    let ladder = json!({
        "type": "ladder",
        "key": "routing",
        "label": "What may answer, and in what order",
        "hint": "The slider decides whether Alexia may spend money. Put models in the lists to choose which answer, in order; leave them empty and she picks the best one the slider allows.",
        "rows": "routing",
        "stops": [
            { "value": "free", "label": "Free only", "hint": "Nothing is ever billed. When every free model is busy or too small, Alexia says so rather than reaching for one that costs money." },
            { "value": "mixed", "label": "Free, then paid", "hint": "The free models answer until they are busy or cannot do the job. Then the cheapest paid one does, and she tells you before you are charged." },
            { "value": "paid", "label": "Paid only", "hint": "Every answer is paid for, through an AI service you connected. Good when the free models are what makes answers slow." },
        ],
        "chose": "set_spend",
        "ordered": "set_order",
        "crossing": "set_cross",
        "floor": "set_keyless",
        "speed": "set_speed",
    });
    const GROUPS: [&str; 5] = [
        "Your choice",
        "Your list",
        "Automatic, free",
        "Set aside by Alexia",
        "Paid",
    ];
    let models = json!({
        "type": "table",
        "key": "models",
        "label": "Models",
        "hint": "Every model you can reach, in the order Alexia would ask them. Use this sends every request to one model until you press Automatic.",
        "rows": "models",
        "columns": [
            { "key": "rank", "label": "#", "align": "right" },
            { "key": "name", "label": "Model, and why it is here" },
            { "key": "via", "label": "Where", "hideNarrow": true },
            { "key": "size", "label": "Size", "align": "right", "hideNarrow": true },
            { "key": "can", "label": "What it can do", "hideNarrow": true },
            { "key": "week", "label": "Used worldwide, last week", "align": "right", "hideNarrow": true },
            { "key": "answered", "label": "Answered here", "align": "right" },
            { "key": "price", "label": "Price per 750k words sent", "align": "right", "hideNarrow": true },
            { "key": "tags", "label": "Tags" },
        ],
        "rowActions": [
            { "key": "use_model", "label": "Use this", "tool": "use_model" },
            { "key": "automatic", "label": "Automatic", "tool": "automatic" },
        ],
        "detail": "model",
        "filter": true,
        "groupBy": "group",
        "groupOrder": GROUPS,
        "groupNotes": {
            "Your choice": "Every request goes to this one until you press Automatic. It never falls back: if it cannot answer, Alexia stops and says why.",
            "Your list": "Your own running order. While anything is listed here, only these models answer, each one tried when the one above it fails.",
            "Automatic, free": "What Automatic walks for an ordinary free request, best first. The sentence under a row says why it sits below the one above.",
            "Set aside by Alexia": "Models Alexia stopped asking on her own: after repeated refusals or empty answers, or when one was retired or now needs a key. One good reply brings a model back.",
            "Paid": "The order Automatic would pay in, once the free models are done and the slider allows it: tools first, then cheapest.",
        },
        "chips": [
            { "key": "attention", "label": "Needs attention", "tags": ["errors", "bad answers", "busy"] },
            { "key": "new", "label": "New", "tags": ["untested"] },
            { "key": "aside", "label": "Set aside", "group": "Set aside by Alexia" },
        ],
    });
    json!([
        { "id": "runs", "label": "Runs", "widgets": [activity] },
        { "id": "chats", "label": "Chats", "widgets": chats },
        { "id": "models", "label": "Models & money", "widgets": [ladder, models], "screen": "settings" },
        { "id": "skills", "label": "Skills", "widgets": [skills], "screen": "settings" },
        { "id": "tools", "label": "Every tool", "widgets": [tools], "screen": "settings" },
    ])
}

/// v2 `tabs({store})`: the core tabs with the ladder's live values. v3 never pays, so the
/// slider stands on *free*, nothing crosses and the day's allowance is 0 (D-P2D-6).
fn tabs(api: &Api) -> Value {
    let mut tabs = core_tabs();
    let fastest = kv_str(api, SPEED).as_deref() == Some("fastest");
    let floor = keyless_on(api);
    for tab in tabs.as_array_mut().into_iter().flatten() {
        for w in tab["widgets"].as_array_mut().into_iter().flatten() {
            if w["type"] == "ladder" {
                w["value"] = "free".into();
                w["cross"] = false.into();
                w["daily"] = 0.into();
                w["keyless"] = floor.into();
                w["fastest"] = fastest.into();
            }
        }
    }
    tabs
}

async fn panels(State(api): State<Arc<Api>>) -> Response {
    json::ok(json!({ "tabs": tabs(&api) }))
}

// ---- GET /api/search (palette.ts + surface.ts `searchable`) ----

/// One thing the palette can find (v2 `Searchable`).
pub(crate) struct Searchable {
    pub tab: String,
    pub kind: String,
    pub label: String,
    pub detail: Option<String>,
    pub filter: Option<String>,
    pub id: Option<String>,
    /// Other words for it, never shown.
    pub words: Vec<&'static str>,
}

impl Searchable {
    fn new(tab: &str, kind: &str, label: &str) -> Searchable {
        Searchable {
            tab: tab.into(),
            kind: kind.into(),
            label: label.into(),
            detail: None,
            filter: None,
            id: None,
            words: Vec::new(),
        }
    }
}

/// v2 `SETTINGS`: places on the Settings screen people look for by name.
#[rustfmt::skip]
const SETTINGS: &[(&str, &str, &str, &[&str])] = &[
    ("general", "Theme", "Settings › General", &["dark", "light", "appearance", "colour", "color", "mode"]),
    ("general", "Her name", "Settings › General", &["name", "rename", "call", "alexia"]),
    ("general", "Panel glass", "Settings › General", &["transparency", "blur", "see through"]),
    ("general", "Glass look", "Settings › General", &["liquid glass", "apple glass", "switches"]),
    ("general", "Start at login", "Settings › General", &["sign in", "startup", "autostart", "launch", "boot"]),
    ("general", "Keyboard shortcut", "Settings › General", &["hotkey", "shortcut", "keys"]),
    ("models", "Keys and providers", "Settings › Models & money", &["api key", "provider", "connect", "openrouter", "token"]),
    ("models", "Where she runs", "Settings › Models & money", &["local", "cloud", "combined", "mode"]),
    ("models", "Money and spending", "Settings › Models & money", &["spend", "cost", "price", "paid", "free", "daily allowance", "budget"]),
    ("safety", "Monthly budget", "Settings › Safety", &["money", "spend", "cap", "limit", "month"]),
    ("safety", "What she may do", "Settings › Safety", &["permission", "permissions", "safety", "allow", "access"]),
    ("safety", "Most steps in one task", "Settings › Safety", &["limit", "ceiling", "loop"]),
    ("safety", "Ask before a costly task", "Settings › Safety", &["ask first", "confirm", "cost", "money"]),
    ("plugins", "Plugins", "Settings › Plugins", &["extensions", "install", "add"]),
    ("about", "About Alexia", "Settings › About", &["version", "licence", "license", "source"]),
    ("about", "Updates", "Settings › About", &["update", "upgrade", "new version", "release"]),
];

/// v2 `searchable`: the core tabs, the Settings places, every plugin (on the plugins page) and
/// each setting a plugin's pane declares with a label, and every chat with a title.
fn searchable(api: &Api) -> Vec<Searchable> {
    let mut found: Vec<Searchable> = Vec::new();
    for tab in tabs(api).as_array().into_iter().flatten() {
        found.push(Searchable::new(
            tab["id"].as_str().unwrap_or_default(),
            "panel",
            tab["label"].as_str().unwrap_or_default(),
        ));
    }
    for (tab, label, detail, words) in SETTINGS {
        let mut s = Searchable::new(tab, "setting", label);
        s.detail = Some((*detail).into());
        s.words = words.to_vec();
        found.push(s);
    }
    let states: HashMap<String, PluginState> = api
        .parts
        .host
        .plugins()
        .into_iter()
        .map(|p| (p.id.0, p.state))
        .collect();
    for dir in api.parts.host.manifests() {
        let m = dir.manifest;
        let mut p = Searchable::new("plugins", "plugin", &m.name);
        p.filter = Some(m.name.clone());
        let state = states.get(&m.id).map(|s| format!("{s:?}").to_lowercase());
        let detail = [Some(m.summary.clone()), state]
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" · ");
        p.detail = (!detail.is_empty()).then_some(detail);
        found.push(p);
        // A plugin's pane is its settings: each one found by the label its author wrote.
        for setting in &m.settings {
            let Some(label) = setting.widget.get("label").and_then(Value::as_str) else {
                continue;
            };
            if setting.kind == "password" && label.trim().is_empty() {
                continue;
            }
            let mut s = Searchable::new("plugins", "setting", label);
            s.detail = Some(format!("Settings › Plugins › {}", m.name));
            s.filter = Some(m.name.clone());
            found.push(s);
        }
    }
    if let Ok(sessions) = api.parts.store.sessions() {
        for chat in sessions {
            let Some(title) = chat.title.filter(|t| !t.trim().is_empty()) else {
                continue;
            };
            let mut s =
                Searchable::new("chat", "chat", &title.chars().take(80).collect::<String>());
            s.id = Some(chat.id.0.to_string());
            found.push(s);
        }
    }
    found
}

/// The words of a name: anything not a letter or digit is a seam.
fn words_of(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Two neighbouring letters swapped and nothing else.
fn swapped(a: &[char], b: &[char]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let Some(at) = (0..a.len()).find(|&i| a[i] != b[i]) else {
        return false;
    };
    at < a.len() - 1 && a[at] == b[at + 1] && a[at + 1] == b[at] && a[at + 2..] == b[at + 2..]
}

/// At most one letter wrong, missing, extra — or two neighbours swapped.
fn one_edit(a: &[char], b: &[char]) -> bool {
    if a == b {
        return true;
    }
    if a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    if a.len() == b.len() {
        let wrong = (0..a.len()).filter(|&i| a[i] != b[i]).count();
        return wrong == 1 || swapped(a, b);
    }
    let (short, long) = if a.len() < b.len() { (a, b) } else { (b, a) };
    match (0..short.len()).find(|&i| short[i] != long[i]) {
        None => true,
        Some(at) => short[at..] == long[at + 1..],
    }
}

/// Whether `typed` is `word`'s beginning with one slip in it.
fn nearly_starts(typed: &str, word: &str) -> bool {
    let t: Vec<char> = typed.chars().collect();
    let w: Vec<char> = word.chars().collect();
    if t.len() < 3 {
        return false;
    }
    for size in [t.len(), t.len() - 1, t.len() + 1] {
        if size < 2 || size > w.len() {
            continue;
        }
        let start = &w[..size];
        if if t.len() == 3 {
            swapped(&t, start)
        } else {
            one_edit(&t, start)
        } {
            return true;
        }
    }
    false
}

/// v2 `score`: how well one string answers another; 0 is no match.
pub(crate) fn score(needle: &str, hay: &str) -> i64 {
    let n = needle.trim().to_lowercase();
    let h = hay.trim().to_lowercase();
    if n.is_empty() || h.is_empty() {
        return 0;
    }
    if h == n {
        return 100;
    }
    // v2 counts UTF-16 units for the length difference.
    let len = |s: &str| s.encode_utf16().count() as i64;
    if h.starts_with(&n) {
        return 80 - (len(&h) - len(&n)).min(19);
    }
    let words = words_of(&h);
    let typed = words_of(&n);
    if typed.is_empty() {
        return 0;
    }
    let joined = typed.join(" ");
    if let Some(at) = (0..words.len()).find(|&i| words[i..].join(" ").starts_with(&joined)) {
        return 60 - (at as i64 * 3).min(19);
    }
    if typed
        .iter()
        .all(|one| words.iter().any(|w| w.starts_with(one.as_str())))
    {
        return 40;
    }
    if typed.iter().all(|one| {
        words
            .iter()
            .any(|w| w.starts_with(one.as_str()) || nearly_starts(one, w))
    }) {
        return 25;
    }
    0
}

/// v2 `search`: rank, merge, cut to [`MOST`].
pub(crate) fn search(query: &str, over: &[Searchable]) -> Vec<Value> {
    let asked = query.trim();
    if asked.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<(i64, &Searchable)> = over
        .iter()
        .map(|one| {
            let mut all = vec![one.label.as_str()];
            all.extend(one.words.iter().copied());
            let s = score(asked, &one.label)
                .max(one.detail.as_deref().map_or(0, |d| score(asked, d) - 25))
                .max(if one.words.is_empty() {
                    0
                } else {
                    score(asked, &all.join(" ")).min(55)
                });
            (s, one)
        })
        .filter(|(s, _)| *s > 0)
        .collect();
    hits.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.label.to_lowercase().cmp(&b.1.label.to_lowercase()))
    });
    hits.into_iter()
        .take(MOST)
        .map(|(s, one)| {
            let mut m = Map::new();
            m.insert("tab".into(), one.tab.clone().into());
            m.insert("kind".into(), one.kind.clone().into());
            m.insert("label".into(), one.label.clone().into());
            if let Some(d) = &one.detail {
                m.insert("detail".into(), d.clone().into());
            }
            if let Some(f) = &one.filter {
                m.insert("filter".into(), f.clone().into());
            }
            if let Some(i) = &one.id {
                m.insert("id".into(), i.clone().into());
            }
            m.insert("score".into(), s.into());
            Value::Object(m)
        })
        .collect()
}

async fn search_get(
    State(api): State<Arc<Api>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let asked = q.get("q").map(String::as_str).unwrap_or_default();
    json::ok(json!({ "hits": search(asked, &searchable(&api)) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn score_ladder_is_v2s() {
        assert_eq!(score("chat", "chat"), 100);
        assert_eq!(score("cha", "chats"), 78);
        assert_eq!(score("layout", "Edit layout"), 57);
        assert_eq!(score("money spend", "spending money"), 40);
        assert_eq!(score("thme", "Theme"), 25);
        assert_eq!(score("edit", "credit"), 0);
        assert_eq!(score("", "anything"), 0);
    }

    #[test]
    fn slips_are_v2s() {
        assert!(nearly_starts("hte", "theme"));
        assert!(!nearly_starts("thx", "theme"));
        assert!(nearly_starts("thme", "theme"));
        assert!(!nearly_starts("th", "theme"));
    }

    #[test]
    fn search_cuts_and_orders() {
        let over: Vec<Searchable> = (0..12)
            .map(|i| Searchable::new("t", "k", &format!("chat {i}")))
            .collect();
        let hits = search("chat", &over);
        assert_eq!(hits.len(), MOST);
        assert!(search("   ", &over).is_empty());
        assert_eq!(hits[0]["label"], "chat 0");
    }

    #[test]
    fn layouts_are_checked_whole() {
        let good = json!({ "v": 1, "cols": 12, "guides": [3, 9], "pages": [
            { "id": "chat", "w": 6, "h": 4, "anchor": { "x": 0, "y": 0 } },
            { "id": "plugin:x", "w": 2.0, "h": 1, "extra": true },
        ], "junk": 1 });
        let kept = read_layout(&good).unwrap();
        assert_eq!(
            kept["pages"][1],
            json!({ "id": "plugin:x", "w": 2.0, "h": 1 })
        );
        assert!(kept.get("junk").is_none());
        for (bad, why) in [
            (json!([]), "it is not an object"),
            (json!({ "v": 2 }), "it is not version 1"),
            (
                json!({ "v": 1, "cols": 0 }),
                "cols must be a number above 0",
            ),
            (
                json!({ "v": 1, "cols": 4, "guides": [1] }),
                "guides must be two numbers",
            ),
            (
                json!({ "v": 1, "cols": 4, "guides": [1, 2], "pages": [{ "id": "a", "w": 1, "h": 1 }, { "id": "a", "w": 1, "h": 1 }] }),
                "page 2 (a) is on the board twice",
            ),
            (
                json!({ "v": 1, "cols": 4, "guides": [1, 2], "pages": [{ "id": "a", "w": 1.5, "h": 1 }] }),
                "page 1 (a) needs a whole width and height of at least 1",
            ),
        ] {
            assert_eq!(
                read_layout(&bad).unwrap_err(),
                format!("That layout cannot be kept: {why}.")
            );
        }
    }

    #[test]
    fn every_ladder_row_is_shown() {
        for row in free::ladder() {
            assert!(shown(&row.id).is_some(), "{} has no name", row.id);
        }
    }
}
