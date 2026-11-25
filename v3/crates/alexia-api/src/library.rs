// SPDX-License-Identifier: AGPL-3.0-only
//! The library: plugins and skills from the shelf (INVENTORY L1–L3, SP-01).
//!
//! A port of v2 `library.ts` and serve.ts 2650–2787. A registry entry is a name, a URL and a
//! checksum: the bytes are hashed while they stream in and nothing is unpacked until they
//! match what the registry said. A plugin then lands through `McpHost::install_folder`
//! (P2D-06), installed and not enabled unless the owner pressed install-and-enable; a skill
//! lands in `layout.skills()`, pre-authorised (v2 `preauthorise`).
//!
//! Two sources, as v2: `github:owner/repo` reads that repository's releases (one request, a
//! fenced ```alexia block per release), anything else is a base URL for the static layout
//! (`/v0/plugins.json`, `/v0/skills.json`, `/v0/revoked.json`, `/v0/plugins/<id>.json`).
//! kv `_core`/`registry` picks it, as v2; `ALEXIA_LIBRARY_REGISTRY` overrides both, and exists
//! so the contract run can point the hub at a local fake (v2 has no such variable).

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::util::{lock, persist_enabled, CORE};
use alexia_mcp::{
    Manifest, McpHost, PluginId, ALEXIA_PROTOCOL_MAX, ALEXIA_PROTOCOL_MIN, MCP_REVISIONS,
};
use axum::extract::{Query, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Extension, Router};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::gate::Sent;
use crate::{board, json, Api};

/// v2 `DEFAULT_REGISTRY` (D118): the app's own repository's releases are the shelf.
pub(crate) const DEFAULT_REGISTRY: &str = "github:cr3studioo/Alexia";

/// Overrides the registry. Test seam: the contract run points it at a local fake.
pub(crate) const REGISTRY_ENV: &str = "ALEXIA_LIBRARY_REGISTRY";

/// kv `_core` keys v2 reads: the registry, the publisher key, the last shelf that arrived.
const REGISTRY_KEY: &str = "registry";
const PUBLISHER_KEY: &str = "registry_key";
const SHELF_KEY: &str = "shelf";
/// v2 consent.ts: a yes said in advance to one skill name, spent by the board (P2D-07).
const PREAUTH: &str = "skill_preauth";
/// The hub's enabled list, as plugins.rs writes it.
/// The board's provenance map (board.rs), undone here only when a skill install fails.
const PROVENANCE: &str = "skill_provenance";
/// The registry's URL layout (`/v0/<this>/<id>.json`, one entry each), a segment of the
/// registry's address. It is not the plugins folder on disk.
const REGISTRY_ENTRIES: &str = "plugins";

/// v2 `FRESH_MS`: how long a read of GitHub's releases is reused (60 requests an hour).
const FRESH: Duration = Duration::from_secs(15 * 60);
/// A JSON read of the registry gives up after this.
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// A download that sends nothing for this long has stalled.
const STALL: Duration = Duration::from_secs(120);

/// What this screen keeps between requests (P2D-08): each download's progress, by id, and
/// the last read of a GitHub shelf.
#[derive(Default)]
pub(crate) struct LibraryState {
    progress: Mutex<HashMap<String, (u64, u64)>>,
    cache: Mutex<Option<Held>>,
    client: OnceLock<reqwest::Client>,
}

/// One read of a repository's releases, and which repository it was of.
struct Held {
    source: String,
    at: Instant,
    shelf: Shelf,
}

/// What one read amounts to: two shelves, kept apart (v2 `Shelf`). Entries stay JSON so every
/// field the publisher wrote reaches the screen, as v2's spread did.
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
struct Shelf {
    plugins: Vec<Value>,
    skills: Vec<Value>,
}

impl LibraryState {
    fn client(&self) -> &reqwest::Client {
        self.client.get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(20))
                .user_agent("Alexia")
                .build()
                .unwrap_or_default()
        })
    }

    fn set_progress(&self, id: &str, done: u64, total: u64) {
        lock(&self.progress).insert(id.to_owned(), (done, total));
    }
}

/// Clears an id's progress when the install is over, however it ended.
struct Progress<'a>(&'a LibraryState, String);

impl Drop for Progress<'_> {
    fn drop(&mut self) {
        lock(&self.0.progress).remove(&self.1);
    }
}

/// Registers this area's INVENTORY rows (path + method).
pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new()
        .route("/api/library", get(list))
        .route("/api/library/progress", get(progress))
        .route("/api/library/install", post(install))
}

// ---- where the list comes from ----

enum Source {
    /// `github:owner/repo`, as `owner/repo`.
    GitHub(String),
    /// A base URL for the static `/v0/` layout.
    Static(String),
}

/// The registry this Alexia talks to: the variable, else kv `_core`/`registry`, else v2's.
fn registry(api: &Api) -> String {
    if let Ok(v) = std::env::var(REGISTRY_ENV) {
        if !v.trim().is_empty() {
            return v.trim().to_owned();
        }
    }
    match api.parts.store.kv_get(CORE, REGISTRY_KEY) {
        Ok(Some(Value::String(s))) if !s.is_empty() => s,
        _ => DEFAULT_REGISTRY.to_owned(),
    }
}

/// v2 `GITHUB`: `^github:([\w.-]+)\/([\w.-]+)$`.
fn source_of(url: &str) -> Source {
    let word = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    };
    if let Some(rest) = url.strip_prefix("github:") {
        if let Some((owner, repo)) = rest.split_once('/') {
            if word(owner) && word(repo) {
                return Source::GitHub(format!("{owner}/{repo}"));
            }
        }
    }
    Source::Static(url.to_owned())
}

/// The publisher's key, if the owner set one (v2 `publisherKey`).
fn publisher_key(api: &Api) -> Option<String> {
    match api.parts.store.kv_get(CORE, PUBLISHER_KEY) {
        Ok(Some(Value::String(s))) if !s.is_empty() => Some(s),
        _ => None,
    }
}

/// `path` against the static registry's origin, as v2's `new URL(path, base)`.
fn static_url(base: &str, path: &str) -> Result<reqwest::Url, String> {
    reqwest::Url::parse(base)
        .and_then(|b| b.join(path))
        .map_err(|e| format!("“{base}” is not a registry address: {e}"))
}

async fn get_json(api: &Api, url: reqwest::Url) -> Result<Value, String> {
    let r = api
        .library
        .client()
        .get(url)
        .timeout(READ_TIMEOUT)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("the registry answered {}", r.status().as_u16()));
    }
    r.json().await.map_err(|e| e.to_string())
}

// ---- entries ----

/// v2 `ID`: a registry id is a folder name, `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`.
fn is_id(s: &str) -> bool {
    let mut parts = s.split('-');
    let head = parts.next().unwrap_or_default();
    let alnum = |p: &str| {
        !p.is_empty()
            && p.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    };
    head.starts_with(|c: char| c.is_ascii_lowercase()) && alnum(head) && parts.all(alnum)
}

/// A skill's folder name, core's loader rule: `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
fn is_skill_name(s: &str) -> bool {
    s.len() <= 64
        && s.split('-').all(|p| {
            !p.is_empty()
                && p.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

/// v2 `HEX64`.
fn is_hex64(s: &str) -> bool {
    s.len() == 64
        && s.chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

fn field<'a>(entry: &'a Value, key: &str) -> &'a str {
    entry.get(key).and_then(Value::as_str).unwrap_or("")
}

fn opt_field<'a>(entry: &'a Value, key: &str) -> Option<&'a str> {
    entry.get(key).and_then(Value::as_str)
}

fn coming_soon(entry: &Value) -> bool {
    entry.get("coming_soon") == Some(&Value::Bool(true))
}

/// v2 `soon`: a placeholder row, an id, a name and a sentence and nothing to download.
fn soon(entry: &Value) -> bool {
    coming_soon(entry)
        && entry.get("name").is_some_and(Value::is_string)
        && entry.get("summary").is_some_and(Value::is_string)
}

/// v2 `plugins()`'s filter: a placeholder keeps nothing downloadable, a real row cannot
/// half-claim to be one and must carry a checksum. None is a row not listed at all.
fn plugin_row(entry: &Value) -> Option<Value> {
    let Value::Object(map) = entry else {
        return None;
    };
    if !is_id(field(entry, "id")) {
        return None;
    }
    let mut row: Map<String, Value> = map.clone();
    if soon(entry) {
        row.remove("url");
        row.remove("sha256");
        row.remove("signature");
        row.insert("coming_soon".into(), json!(true));
        return Some(Value::Object(row));
    }
    row.remove("coming_soon");
    is_hex64(field(entry, "sha256")).then_some(Value::Object(row))
}

/// v2 `newer`: is `candidate` strictly later than `installed`? Pre-release tags are ignored.
fn newer(candidate: &str, installed: &str) -> bool {
    let parts = |v: &str| -> [u64; 3] {
        let mut out = [0; 3];
        let core = v.split('-').next().unwrap_or_default();
        for (slot, n) in out.iter_mut().zip(core.split('.')) {
            *slot = n.parse().unwrap_or(0);
        }
        out
    };
    parts(candidate) > parts(installed)
}

/// v2 `withinApp`.
fn within_app(entry: &Value, app: &str) -> bool {
    if opt_field(entry, "min_app").is_some_and(|min| newer(min, app)) {
        return false;
    }
    if opt_field(entry, "max_app").is_some_and(|max| newer(app, max)) {
        return false;
    }
    true
}

/// v2 `offerable`: `ok`, `newer-app` (exists, needs an Alexia not installed yet) or `stale`.
fn offerable(entry: &Value, app: &str) -> &'static str {
    if opt_field(entry, "min_app").is_some_and(|min| newer(min, app)) {
        return "newer-app";
    }
    if !within_app(entry, app) {
        return "stale";
    }
    // A row with no protocol compares false both ways in v2 (a placeholder has none).
    if let Some(p) = entry.get("alexia_protocol").and_then(Value::as_f64) {
        if p > f64::from(ALEXIA_PROTOCOL_MAX) {
            return "newer-app";
        }
        if p < f64::from(ALEXIA_PROTOCOL_MIN) {
            return "stale";
        }
    }
    "ok"
}

/// v2 `versionVerdict`, asked once more at the moment of install. Err is v2's sentence.
fn verdict(entry: &Value, app: &str) -> Result<(), String> {
    let name = field(entry, "name");
    if let Some(min) = opt_field(entry, "min_app").filter(|min| newer(min, app)) {
        return Err(format!(
            "{name} needs Alexia {min} or later, and this is {app}.\nUpdate Alexia, or install an earlier version of {name}."
        ));
    }
    if let Some(max) = opt_field(entry, "max_app").filter(|max| newer(app, max)) {
        return Err(format!(
            "{name} says it runs on Alexia {max} and earlier, and this is {app}.\nCheck whether {name} has an update."
        ));
    }
    let p = entry
        .get("alexia_protocol")
        .and_then(Value::as_f64)
        .unwrap_or(f64::NAN);
    if p > f64::from(ALEXIA_PROTOCOL_MAX) {
        return Err(format!(
            "{name} needs a newer Alexia.\nUpdate Alexia, or install an earlier version of {name}."
        ));
    }
    if p < f64::from(ALEXIA_PROTOCOL_MIN) || p.is_nan() {
        return Err(format!(
            "{name} was written for an older version of Alexia and can't load.\nCheck whether {name} has an update."
        ));
    }
    let mcp = field(entry, "mcp_protocol");
    if !MCP_REVISIONS.contains(&mcp) {
        return Err(format!(
            "{name} speaks a version of MCP that Alexia doesn't.\nAlexia speaks {}; {name} speaks {mcp}.",
            MCP_REVISIONS.join(" and ")
        ));
    }
    Ok(())
}

// ---- reading the shelf ----

/// v2 `BLOCK`: the text of the first ```alexia block in a release body.
fn block_of(body: &str) -> Option<&str> {
    const OPEN: &str = "```alexia";
    let mut from = 0;
    while let Some(at) = body[from..].find(OPEN) {
        let rest = &body[from + at + OPEN.len()..];
        if let Some(space) = rest.chars().next().filter(|c| c.is_whitespace()) {
            // A space may be more than one byte (U+00A0, U+2028): step over the whole char.
            let inner = &rest[space.len_utf8()..];
            return inner.find("```").map(|end| &inner[..end]);
        }
        from += at + OPEN.len();
    }
    None
}

/// v2 `readReleases`: releases in, shelf out. A release with no block is not a plugin
/// release; the bytes are named by the release's attached archive, never by the block.
fn read_releases(releases: &[Value]) -> Shelf {
    let mut plugins: Vec<Value> = Vec::new();
    let mut skills: Vec<(String, Value)> = Vec::new();
    let place = |list: &mut Vec<Value>, row: Value| {
        let id = field(&row, "id").to_owned();
        match list.iter().position(|r| field(r, "id") == id) {
            Some(i) => list[i] = row,
            None => list.push(row),
        }
    };
    for release in releases {
        if release.get("draft") == Some(&Value::Bool(true)) {
            continue;
        }
        let Some(said) = block_of(field(release, "body")) else {
            continue;
        };
        let Ok(Value::Object(block)) = serde_json::from_str::<Value>(said) else {
            continue;
        };
        let id = block.get("id").and_then(Value::as_str).map(str::to_owned);
        let version = block
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let block = Value::Object(block);
        if coming_soon(&block) {
            if let Some(id) = &id {
                if !plugins.iter().any(|r| field(r, "id") == id) {
                    plugins.push(block);
                }
                continue;
            }
        }
        let assets = release
            .get("assets")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let archive = [".tgz", ".tar.gz", ".zip"].iter().find_map(|ext| {
            assets
                .iter()
                .find(|a| field(a, "name").ends_with(ext))
                .map(|a| field(a, "browser_download_url").to_owned())
        });
        let (Some(url), Some(id), Some(version)) = (archive, id, version) else {
            continue;
        };
        let updated = chrono::DateTime::parse_from_rfc3339(field(release, "published_at"))
            .map_or(0, |t| t.timestamp());
        let mut row = block;
        row["url"] = json!(url);
        row["updated_at"] = json!(updated);
        if field(&row, "kind") == "skill" {
            let newest = skills
                .iter()
                .find(|(_, r)| field(r, "id") == id)
                .is_none_or(|(held, _)| newer(&version, held));
            if newest {
                skills.retain(|(_, r)| field(r, "id") != id);
                skills.push((version, row));
            }
            continue;
        }
        let replace = plugins
            .iter()
            .find(|r| field(r, "id") == id)
            .is_none_or(|held| coming_soon(held) || newer(&version, field(held, "version")));
        if replace {
            place(&mut plugins, row);
        }
    }
    Shelf {
        plugins,
        skills: skills.into_iter().map(|(_, r)| r).collect(),
    }
}

/// Every release of the repository, read as a shelf; reused for `max_age`, and the last one
/// that arrived (kv `_core`/`shelf`) when a read fails: stale beats empty (v2 `#shelf`).
async fn github_shelf(api: &Api, repo: &str, max_age: Duration) -> Result<Shelf, String> {
    if let Some(held) = lock(&api.library.cache).as_ref() {
        if held.source == repo && held.at.elapsed() < max_age {
            return Ok(held.shelf.clone());
        }
    }
    let read = async {
        let r = api
            .library
            .client()
            .get(format!(
                "https://api.github.com/repos/{repo}/releases?per_page=100"
            ))
            // No token, ever: this reads public releases.
            .header("accept", "application/vnd.github+json")
            .timeout(READ_TIMEOUT)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = r.status().as_u16();
        if status == 403 || status == 429 {
            return Err(format!("GitHub is rate-limiting this address ({status}). That quota is shared by everything on this network rather than being Alexia's own, and it resets within the hour."));
        }
        if !r.status().is_success() {
            return Err(format!("GitHub answered {status} for {repo}"));
        }
        let releases: Value = r.json().await.map_err(|e| e.to_string())?;
        Ok(read_releases(
            releases.as_array().map(Vec::as_slice).unwrap_or_default(),
        ))
    };
    match read.await {
        Ok(shelf) => {
            *lock(&api.library.cache) = Some(Held {
                source: repo.to_owned(),
                at: Instant::now(),
                shelf: shelf.clone(),
            });
            let at = chrono::Utc::now().timestamp_millis();
            let kept = json!({ "source": repo, "at": at, "shelf": shelf });
            if let Err(e) = api.parts.store.kv_set(CORE, SHELF_KEY, &kept) {
                tracing::warn!("the shelf could not be kept: {e}");
            }
            Ok(shelf)
        }
        Err(why) => {
            let kept = api.parts.store.kv_get(CORE, SHELF_KEY).ok().flatten();
            match kept {
                Some(k) if field(&k, "source") == repo => {
                    serde_json::from_value(k["shelf"].clone()).map_err(|_| why)
                }
                _ => Err(why),
            }
        }
    }
}

/// v2 `plugins()`: what the shelf lists, placeholders included, bad rows left out.
async fn plugins(api: &Api) -> Result<Vec<Value>, String> {
    let found = match source_of(&registry(api)) {
        Source::GitHub(repo) => github_shelf(api, &repo, FRESH).await?.plugins,
        Source::Static(base) => {
            let v = get_json(api, static_url(&base, "/v0/plugins.json")?).await?;
            v["plugins"].as_array().cloned().unwrap_or_default()
        }
    };
    Ok(found.iter().filter_map(plugin_row).collect())
}

/// v2 `skills()`.
async fn skills(api: &Api) -> Result<Vec<Value>, String> {
    let found = match source_of(&registry(api)) {
        Source::GitHub(repo) => github_shelf(api, &repo, FRESH).await?.skills,
        Source::Static(base) => {
            let v = get_json(api, static_url(&base, "/v0/skills.json")?).await?;
            v["skills"].as_array().cloned().unwrap_or_default()
        }
    };
    Ok(found
        .into_iter()
        .filter(|e| is_id(field(e, "id")) && is_hex64(field(e, "sha256")))
        .collect())
}

/// v2 `revoked()`: what has been pulled, never cached. A GitHub source cannot say, and says
/// so by answering nothing.
#[derive(Default)]
struct Pulled {
    plugins: Vec<Value>,
    skills: Vec<Value>,
}

impl Pulled {
    fn reason(list: &[Value], id: &str) -> Option<String> {
        list.iter()
            .find(|r| field(r, "id") == id)
            .map(|r| match field(r, "revoked_reason") {
                "" => "withdrawn".to_owned(),
                why => why.to_owned(),
            })
    }
}

async fn revoked(api: &Api) -> Result<Pulled, String> {
    match source_of(&registry(api)) {
        Source::GitHub(_) => Ok(Pulled::default()),
        Source::Static(base) => {
            let v = get_json(api, static_url(&base, "/v0/revoked.json")?).await?;
            let list = |k: &str| v[k].as_array().cloned().unwrap_or_default();
            Ok(Pulled {
                plugins: list("plugins"),
                skills: list("skills"),
            })
        }
    }
}

enum Found {
    Entry(Value),
    Revoked(String),
}

/// v2 `entry()`: one entry, read afresh at the moment of install. A 410 on a static registry
/// is a withdrawal, with the registry's reason.
async fn entry(api: &Api, id: &str) -> Result<Option<Found>, String> {
    if !is_id(id) {
        return Ok(None);
    }
    match source_of(&registry(api)) {
        Source::GitHub(repo) => Ok(github_shelf(api, &repo, Duration::ZERO)
            .await?
            .plugins
            .iter()
            .filter_map(plugin_row)
            .find(|r| field(r, "id") == id)
            .map(Found::Entry)),
        Source::Static(base) => {
            let url = static_url(&base, &format!("/v0/{REGISTRY_ENTRIES}/{id}.json"))?;
            let r = api
                .library
                .client()
                .get(url)
                .timeout(READ_TIMEOUT)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if r.status().as_u16() == 410 {
                let body: Value = r.json().await.unwrap_or(Value::Null);
                let why = match field(&body, "reason") {
                    "" => "withdrawn".to_owned(),
                    why => why.to_owned(),
                };
                return Ok(Some(Found::Revoked(why)));
            }
            if !r.status().is_success() {
                return Ok(None);
            }
            let row: Value = r.json().await.map_err(|e| e.to_string())?;
            // The same rules as the listing: a row with no valid checksum is not offered.
            Ok(plugin_row(&row)
                .filter(|r| field(r, "id") == id)
                .map(Found::Entry))
        }
    }
}

// ---- GET /api/library ----

/// serve.ts 2650–2725. A network call, so a failure says what went wrong rather than
/// answering an empty list.
async fn list(State(api): State<Arc<Api>>) -> Response {
    let url = registry(&api);
    let app = api.parts.app_version.clone();
    let here = api.parts.host.plugins();
    let installed: HashSet<String> = here.iter().map(|p| p.id.0.clone()).collect();
    let available = match plugins(&api).await {
        Ok(found) => found,
        Err(why) => {
            return json::ok(json!({
                "ok": false,
                "registry": url,
                "app": app,
                "why": format!("Could not reach the plugin shelf: {why}"),
            }))
        }
    };
    let offered = skills(&api).await.unwrap_or_default();
    let pulled = revoked(&api).await.unwrap_or_default();
    // Withdrawn is never offered, whatever an out-of-date list still says.
    let gone = |list: &[Value], id: &str| list.iter().any(|r| field(r, "id") == id);
    let available: Vec<Value> = available
        .into_iter()
        .filter(|e| !gone(&pulled.plugins, field(e, "id")))
        .collect();

    // v2 `updates()`: what is here that the shelf has a newer version of, with its verdict.
    let updates: Vec<(String, String, String, &str)> = here
        .iter()
        .filter_map(|p| {
            let e = available
                .iter()
                .find(|e| field(e, "id") == p.id.0 && !coming_soon(e))?;
            let to = field(e, "version");
            if !newer(to, &p.version) {
                return None;
            }
            let offer = offerable(e, &app);
            (offer != "stale").then(|| (p.id.0.clone(), p.version.clone(), to.to_owned(), offer))
        })
        .collect();

    let shelf: Vec<(Value, &str)> = available
        .into_iter()
        .map(|e| {
            let offer = offerable(&e, &app);
            (e, offer)
        })
        .collect();
    let rows: Vec<Value> = shelf
        .iter()
        .filter(|(e, offer)| *offer == "ok" || coming_soon(e))
        .map(|(e, offer)| {
            let mut row = e.clone();
            row["offer"] = json!(offer);
            row["installed"] = json!(installed.contains(field(e, "id")));
            row
        })
        .collect();
    let needs_plugins = shelf
        .iter()
        .filter(|(e, offer)| {
            *offer == "newer-app" && !coming_soon(e) && !installed.contains(field(e, "id"))
        })
        .count();
    let skill_names: HashSet<String> = board::skills_of(&api).into_iter().map(|s| s.name).collect();
    let skill_rows: Vec<Value> = offered
        .into_iter()
        .filter(|e| !gone(&pulled.skills, field(e, "id")))
        .map(|mut e| {
            e["installed"] = json!(skill_names.contains(field(&e, "name")));
            e
        })
        .collect();
    json::ok(json!({
        "ok": true,
        "registry": url,
        "app": app,
        // No signature can be checked by this build (no ed25519 here), so never `true`: an
        // unverified signature is exactly as good as none and must not look better.
        "verifying": false,
        "plugins": rows,
        "updates": updates
            .iter()
            .filter(|u| u.3 == "ok")
            .map(|(id, from, to, _)| json!({ "id": id, "from": from, "to": to }))
            .collect::<Vec<_>>(),
        "needsNewerApp": {
            "plugins": needs_plugins,
            "updates": updates.iter().filter(|u| u.3 == "newer-app").count(),
        },
        "skills": skill_rows,
        // Only the ones this machine has.
        "revoked": pulled
            .plugins
            .iter()
            .filter(|r| installed.contains(field(r, "id")))
            .collect::<Vec<_>>(),
    }))
}

// ---- GET /api/library/progress ----

/// How far one download has got; nothing under way is `{done: 0}`.
async fn progress(
    State(api): State<Arc<Api>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let id = q.get("id").map(String::as_str).unwrap_or("");
    match lock(&api.library.progress).get(id) {
        Some((done, total)) => json::ok(json!({ "done": done, "total": total })),
        None => json::ok(json!({ "done": 0 })),
    }
}

// ---- POST /api/library/install ----

fn flag(sent: &Map<String, Value>, key: &str) -> bool {
    sent.get(key) == Some(&Value::Bool(true))
}

/// serve.ts 2734–2787.
async fn install(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    let id = sent
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if sent.get("kind").and_then(Value::as_str) == Some("skill") {
        return match install_skill(&api, &id).await {
            Ok(name) => json::ok(json!({
                "ok": true,
                "said": format!("{name} is installed and Alexia can read it now."),
            })),
            Err(why) => json::ok(json!({ "ok": false, "said": why })),
        };
    }
    let done = {
        let _clear = Progress(&api.library, id.clone());
        install_plugin(&api, &id, flag(&sent, "update"), flag(&sent, "enable")).await
    };
    match done {
        Ok(signature) => {
            let signed = match signature {
                Signature::Unverified => {
                    " — it is signed, but no publisher key is configured to check against"
                }
                Signature::None => "",
            };
            json::ok(json!({
                "ok": true,
                "said": format!("{id} is installed{signed}. Read what it asked for, then enable it."),
            }))
        }
        Err(why) => json::ok(json!({ "ok": false, "said": why })),
    }
}

enum Signature {
    /// The entry carries none.
    None,
    /// It carries one and nobody here can check it.
    Unverified,
}

/// v2 `#checkSignature`, without a verifier: this build has no ed25519, so a signed entry
/// with a publisher key configured is refused rather than passed as if it had been checked.
fn signature(api: &Api, entry: &Value) -> Result<Signature, String> {
    if field(entry, "signature").is_empty() {
        return Ok(Signature::None);
    }
    if publisher_key(api).is_none() {
        return Ok(Signature::Unverified);
    }
    Err(format!(
        "{} is signed and you configured a publisher key, but this build of Alexia cannot check signatures. Nothing was installed.",
        field(entry, "name")
    ))
}

/// v2 `install()`: fetch, check, unpack, and stop. Nothing is written into the folder the host
/// scans until the bytes hash to what the registry said. Installed, not enabled, unless
/// `enable`; an update stops the plugin, replaces its folder (not its data) and turns it back
/// on only if it was on.
async fn install_plugin(
    api: &Api,
    id: &str,
    update: bool,
    enable: bool,
) -> Result<Signature, String> {
    let found = match entry(api, id).await {
        Err(e) => return Err(format!("The registry could not be reached: {e}")),
        Ok(None) => return Err(format!("The registry has no plugin called “{id}”.")),
        Ok(Some(Found::Revoked(why))) => {
            return Err(format!("{id} has been withdrawn from the registry: {why}"))
        }
        Ok(Some(Found::Entry(e))) => e,
    };
    // The revocation list too, so a stale per-plugin row cannot outlive a withdrawal.
    if let Some(why) = revoked(api)
        .await
        .ok()
        .and_then(|p| Pulled::reason(&p.plugins, id))
    {
        return Err(format!("{id} has been withdrawn from the registry: {why}"));
    }
    let name = field(&found, "name").to_owned();
    if coming_soon(&found) {
        return Err(format!("{name} is not out yet. It is on the shelf so you know it is coming — there is nothing to install."));
    }
    verdict(&found, &api.parts.app_version)?;
    let signed = signature(api, &found)?;

    let host = &api.parts.host;
    let pid = PluginId(id.to_owned());
    let was = host.plugins().into_iter().find(|p| p.id == pid);
    if was.is_some() && !update {
        return Err(format!(
            "{name} is already installed. Delete it first to replace it."
        ));
    }

    let staging = Staging::new("install")?;
    let archive = staging.0.join("download");
    api.library.set_progress(id, 0, 0);
    let digest = download(api, field(&found, "url"), &archive, Some(id)).await?;
    let want = field(&found, "sha256");
    if digest != want {
        return Err(format!(
            "What downloaded is not what the registry described. Expected {}…, got {}…. Nothing was installed.",
            &want[..12],
            &digest[..12]
        ));
    }
    let out = staging.0.join("out");
    extract(&archive, &out).await?;
    let root = holding(&out, "plugin.json")
        .ok_or_else(|| format!("{name}’s download has no plugin.json in it."))?;
    let raw = std::fs::read_to_string(root.join("plugin.json"))
        .map_err(|e| format!("{name}’s plugin.json could not be read: {e}"))?;
    let said_id = serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|m| m.get("id").cloned())
        .unwrap_or(Value::Null);
    if said_id.as_str() != Some(id) {
        let said = said_id
            .as_str()
            .map_or_else(|| said_id.to_string(), str::to_owned);
        return Err(format!(
            "The registry calls it “{id}” and its plugin.json calls it “{said}”."
        ));
    }
    refuse_links(&root)?;

    match was {
        Some(was) => replace(host, &pid, &root, &raw, was.enabled || enable).await?,
        None => {
            // `install_folder` takes a folder named for the plugin.
            let named = staging.0.join("pkg").join(id);
            std::fs::create_dir_all(staging.0.join("pkg")).map_err(|e| e.to_string())?;
            std::fs::rename(&root, &named).map_err(|e| e.to_string())?;
            host.install_folder(&named)
                .await
                .map_err(|e| e.to_string())?;
            if enable {
                host.set_enabled(&pid, true)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    if let Err(e) = persist_enabled(api) {
        tracing::warn!("the enabled list could not be written: {e}");
    }
    Ok(signed)
}

/// The update (v2 `replace`): the install folder and nothing else is replaced — not the
/// plugin's data, settings or own folder. The manifest is read before the old folder goes.
async fn replace(
    host: &McpHost,
    id: &PluginId,
    from: &Path,
    manifest: &str,
    on: bool,
) -> Result<(), String> {
    Manifest::parse(manifest).map_err(|e| e.sentence)?;
    let dir = host
        .plugin_dir(id)
        .map(|d| d.path)
        .ok_or_else(|| format!("There is no plugin called “{}”.", id.0))?;
    // Stopped first: Windows will not delete the files a running plugin holds open.
    host.set_enabled(id, false)
        .await
        .map_err(|e| e.to_string())?;
    swap_folder(&dir, |to| copy_tree(from, to)).await?;
    host.reload(id).await.map_err(|e| e.to_string())?;
    if on {
        host.set_enabled(id, true)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// `dir`'s contents replaced by what `fill` writes into it, never leaving nothing behind:
/// the old folder is renamed aside first, and comes back if `fill` fails. It is deleted only
/// once the new one is complete.
async fn swap_folder(
    dir: &Path,
    fill: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<(), String> {
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let aside = dir.with_file_name(format!(".{name}.old-{}", unique()));
    rename_tree(dir, &aside).await?;
    match fill(dir) {
        Ok(()) => {
            if let Err(e) = remove_tree(&aside).await {
                tracing::warn!("the old copy was left behind: {e}");
            }
            Ok(())
        }
        Err(e) => {
            let _ = remove_tree(dir).await;
            rename_tree(&aside, dir).await.map_err(|back| {
                format!("The update could not be written ({e}), and the old version could not be put back: {back}")
            })?;
            Err(format!(
                "The update could not be written: {e}. The old version is back."
            ))
        }
    }
}

/// v2 `installSkill`: a skill is text the model reads, from its own list. It lands in
/// `layout.skills()/<name>`, and the yes the Install press was is written just before the
/// folder arrives, so the board (P2D-07) spends it on that folder and on nothing else.
async fn install_skill(api: &Api, id: &str) -> Result<String, String> {
    let offered = skills(api)
        .await
        .map_err(|e| format!("The registry could not be reached: {e}"))?;
    let found = offered
        .into_iter()
        .find(|s| field(s, "id") == id)
        .ok_or_else(|| format!("The registry has no skill called “{id}”."))?;
    if let Some(why) = revoked(api)
        .await
        .ok()
        .and_then(|p| Pulled::reason(&p.skills, id))
    {
        return Err(format!("{id} has been withdrawn from the registry: {why}"));
    }
    let name = field(&found, "name").to_owned();
    if !is_skill_name(&name) {
        return Err(format!(
            "The registry calls this skill “{name}”, which is not a folder name Alexia will write."
        ));
    }
    let skills_dir = api.parts.layout.skills();
    let to = skills_dir.join(&name);
    if to.exists() {
        return Err(format!("A skill called “{name}” is already installed."));
    }
    let staging = Staging::new("skill")?;
    let archive = staging.0.join("download");
    let digest = {
        let _clear = Progress(&api.library, id.to_owned());
        download(api, field(&found, "url"), &archive, Some(id)).await?
    };
    if digest != field(&found, "sha256") {
        return Err(
            "What downloaded is not what the registry described. Nothing was installed.".into(),
        );
    }
    let out = staging.0.join("out");
    extract(&archive, &out).await?;
    let root = holding(&out, "SKILL.md")
        .ok_or_else(|| format!("{name}’s download has no SKILL.md in it."))?;
    refuse_links(&root)?;
    // Written before the folder arrives (a board read in between would otherwise call it
    // unknown), and taken back if the folder never does.
    let had_preauth = preauthorised(api).contains(&name);
    let had_provenance = provenance_of(api).contains_key(&name);
    let written = preauthorise(api, &name).and_then(|()| {
        board::record_provenance(api, &name, "installed");
        std::fs::create_dir_all(&skills_dir)
            .and_then(|()| copy_tree(&root, &to))
            .map_err(|e| format!("{name} could not be written: {e}"))
    });
    if let Err(e) = written {
        let _ = remove_tree(&to).await;
        if !had_preauth {
            unpreauthorise(api, &name);
        }
        if !had_provenance {
            let mut held = provenance_of(api);
            if held.remove(&name).is_some() {
                let _ = api.parts.store.kv_set(CORE, PROVENANCE, &json!(held));
            }
        }
        return Err(e);
    }
    Ok(name)
}

fn preauthorised(api: &Api) -> Vec<String> {
    api.parts
        .store
        .kv_get(CORE, PREAUTH)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn provenance_of(api: &Api) -> Map<String, Value> {
    api.parts
        .store
        .kv_get(CORE, PROVENANCE)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// A preauth this install wrote, taken back because the skill never arrived.
fn unpreauthorise(api: &Api, name: &str) {
    let held: Vec<String> = preauthorised(api)
        .into_iter()
        .filter(|n| n != name)
        .collect();
    let _ = api.parts.store.kv_set(CORE, PREAUTH, &json!(held));
}

/// v2 consent.ts `preauthorise`: yes, to this exact name, said in advance. Spent once.
fn preauthorise(api: &Api, name: &str) -> Result<(), String> {
    let store = &api.parts.store;
    let mut held = preauthorised(api);
    if !held.iter().any(|n| n == name) {
        held.push(name.to_owned());
        store
            .kv_set(CORE, PREAUTH, &json!(held))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---- the download ----

/// A scratch folder, removed when dropped.
struct Staging(PathBuf);

impl Staging {
    fn new(what: &str) -> Result<Staging, String> {
        let dir = std::env::temp_dir().join(format!("alexia-{what}-{}", unique()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(Staging(dir))
    }
}

/// A name no other call in this process has used: pid, a counter and the clock.
fn unique() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    format!("{}-{nanos}-{n}", std::process::id())
}

impl Drop for Staging {
    /// One try in place; if Windows still holds a file, the retries run on a thread of their
    /// own, so a runtime worker never waits on them.
    fn drop(&mut self) {
        if remove_once(&self.0).is_ok() {
            return;
        }
        let dir = self.0.clone();
        let _ = std::thread::Builder::new()
            .name("alexia-staging-cleanup".into())
            .spawn(move || {
                for _ in 0..RETRIES {
                    std::thread::sleep(RETRY_DELAY);
                    if remove_once(&dir).is_ok() {
                        return;
                    }
                }
                tracing::warn!("{} could not be removed", dir.display());
            });
    }
}

/// v2 `maxRetries: 10, retryDelay: 200`: Windows holds a file a moment after the process
/// that had it open exits.
const RETRIES: u32 = 10;
const RETRY_DELAY: Duration = Duration::from_millis(200);

/// One attempt; a folder already gone counts as removed.
fn remove_once(dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// A folder gone, retried as v2; the waits yield to the runtime.
async fn remove_tree(dir: &Path) -> Result<(), String> {
    let mut last = None;
    for _ in 0..RETRIES {
        match remove_once(dir) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
        tokio::time::sleep(RETRY_DELAY).await;
    }
    Err(format!(
        "{} could not be removed: {}",
        dir.display(),
        last.map_or_else(String::new, |e| e.to_string())
    ))
}

/// A folder renamed, retried as `remove_tree` is (a file still held refuses the rename).
async fn rename_tree(from: &Path, to: &Path) -> Result<(), String> {
    let mut last = None;
    for _ in 0..RETRIES {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
        tokio::time::sleep(RETRY_DELAY).await;
    }
    Err(format!(
        "{} could not be moved: {}",
        from.display(),
        last.map_or_else(String::new, |e| e.to_string())
    ))
}

/// One file, streamed to disk and hashed on the way past (v2 `download`). Progress is kept
/// under `id` while it runs. Answers the lowercase hex sha256 of what arrived.
async fn download(api: &Api, url: &str, to: &Path, id: Option<&str>) -> Result<String, String> {
    let mut r = api
        .library
        .client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("{url} could not be fetched: {e}"))?;
    if !r.status().is_success() {
        return Err(format!(
            "{url} answered {} {}",
            r.status().as_u16(),
            r.status().canonical_reason().unwrap_or("")
        ));
    }
    let total = r.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(to).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut done = 0u64;
    loop {
        let chunk = tokio::time::timeout(STALL, r.chunk())
            .await
            .map_err(|_| format!("{url} stopped sending"))?
            .map_err(|e| format!("{url} could not be fetched: {e}"))?;
        let Some(bytes) = chunk else { break };
        hash.update(&bytes);
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        done += bytes.len() as u64;
        if let Some(id) = id {
            api.library.set_progress(id, done, total);
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(format!("{:x}", hash.finalize()))
}

// ---- unpacking ----

/// An archive entry's name, refused when it could land outside the folder it is unpacked
/// into: an absolute path, a drive or a `..` part.
fn escapes(name: &str) -> bool {
    name.starts_with(['/', '\\'])
        || name.contains(':')
        || name.split(['/', '\\']).any(|part| part == "..")
}

fn escape_refusal(name: &str) -> String {
    format!("The download holds “{name}”, which would land outside its own folder. Nothing was installed.")
}

/// Unpacks `archive` into `to`: a zip with the `zip` crate, anything else (`.tgz`) with the
/// operating system's own tar. Every entry is checked before anything is written.
async fn extract(archive: &Path, to: &Path) -> Result<(), String> {
    let (archive, to) = (archive.to_owned(), to.to_owned());
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&to).map_err(|e| e.to_string())?;
        let mut magic = [0u8; 4];
        let n = std::fs::File::open(&archive)
            .and_then(|mut f| f.read(&mut magic))
            .map_err(|e| e.to_string())?;
        if n == 4 && (magic == *b"PK\x03\x04" || magic == *b"PK\x05\x06") {
            unzip(&archive, &to)
        } else {
            untar(&archive, &to)
        }
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("could not unpack the download: {e}"))
}

fn unzip(archive: &Path, to: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let f = zip.by_index_raw(i).map_err(|e| e.to_string())?;
        if escapes(f.name()) || f.enclosed_name().is_none() {
            return Err(escape_refusal(f.name()));
        }
        if f.is_symlink() {
            return Err(format!(
                "The download holds a link ({}), and Alexia installs only real files and folders.",
                f.name()
            ));
        }
    }
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        let rel = f.enclosed_name().ok_or_else(|| escape_refusal(f.name()))?;
        let out = to.join(rel);
        if f.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut w = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut w).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// v2 `archiver()`: on Windows the system's own bsdtar, never PATH's (Git's GNU tar cannot
/// read zip and takes `C:` for a host).
fn tar_exe() -> PathBuf {
    if cfg!(windows) {
        if let Ok(root) = std::env::var("SystemRoot") {
            return Path::new(&root).join("System32").join("tar.exe");
        }
    }
    PathBuf::from("tar")
}

fn tar(args: &[&std::ffi::OsStr]) -> Result<String, String> {
    let mut c = std::process::Command::new(tar_exe());
    c.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    let out = c.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let said = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        return Err(if said.is_empty() {
            format!("tar exited {}", out.status)
        } else {
            said
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn untar(archive: &Path, to: &Path) -> Result<(), String> {
    let listed = tar(&["-tf".as_ref(), archive.as_os_str()])?;
    if let Some(bad) = listed.lines().find(|l| escapes(l)) {
        return Err(escape_refusal(bad));
    }
    tar(&[
        "-xf".as_ref(),
        archive.as_os_str(),
        "-C".as_ref(),
        to.as_os_str(),
    ])
    .map(|_| ())
}

/// v2 `holding`: the folder holding `file`, at the root or one level down.
fn holding(dir: &Path, file: &str) -> Option<PathBuf> {
    if dir.join(file).is_file() {
        return Some(dir.to_owned());
    }
    let mut subs: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect();
    subs.sort();
    subs.into_iter().find(|d| d.join(file).is_file())
}

/// A tree that came off the internet holds only files and folders: a link is refused.
fn refuse_links(dir: &Path) -> Result<(), String> {
    for e in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let t = std::fs::symlink_metadata(e.path())
            .map_err(|e| e.to_string())?
            .file_type();
        if t.is_symlink() {
            return Err(format!(
                "The download holds a link ({}), and Alexia installs only real files and folders.",
                e.file_name().to_string_lossy()
            ));
        }
        if t.is_dir() {
            refuse_links(&e.path())?;
        }
    }
    Ok(())
}

/// v2 `cpTree`: files and folders, and nothing else.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let t = std::fs::symlink_metadata(e.path())?.file_type();
        let target = to.join(e.file_name());
        if t.is_dir() {
            copy_tree(&e.path(), &target)?;
        } else if t.is_file() {
            std::fs::copy(e.path(), target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_digests() {
        assert!(is_id("sample") && is_id("a1-b2"));
        assert!(!is_id("1a") && !is_id("a--b") && !is_id("a-") && !is_id("../x") && !is_id(""));
        assert!(is_skill_name("tidy-up") && !is_skill_name("../tidy") && !is_skill_name("A"));
        assert!(is_hex64(&"a".repeat(64)) && !is_hex64(&"A".repeat(64)) && !is_hex64("ab"));
    }

    #[test]
    fn escaping_names() {
        for bad in [
            "../x",
            "a/../../x",
            "/etc/passwd",
            "\\x",
            "C:\\x",
            "a\\..\\x",
            "..",
        ] {
            assert!(escapes(bad), "{bad}");
        }
        for good in ["plugin.json", "pkg/plugin.json", "a..b/c", "./x"] {
            assert!(!escapes(good), "{good}");
        }
    }

    #[test]
    fn versions_and_offers() {
        assert!(
            newer("1.10.0", "1.9.9") && !newer("1.0.0", "1.0.0") && !newer("1.0.0-beta", "1.0.0")
        );
        let row = |v: Value| v;
        assert_eq!(
            offerable(&row(json!({"alexia_protocol": 15})), "3.0.0"),
            "ok"
        );
        assert_eq!(
            offerable(&row(json!({"alexia_protocol": 99})), "3.0.0"),
            "newer-app"
        );
        assert_eq!(
            offerable(&row(json!({"alexia_protocol": 1})), "3.0.0"),
            "stale"
        );
        assert_eq!(
            offerable(
                &row(json!({"alexia_protocol": 15, "min_app": "9.0.0"})),
                "3.0.0"
            ),
            "newer-app"
        );
        assert_eq!(
            offerable(
                &row(json!({"alexia_protocol": 15, "max_app": "2.0.0"})),
                "3.0.0"
            ),
            "stale"
        );
        assert_eq!(offerable(&row(json!({"coming_soon": true})), "3.0.0"), "ok");
        let good = json!({"name": "A", "alexia_protocol": 15, "mcp_protocol": MCP_REVISIONS[0]});
        assert!(verdict(&good, "3.0.0").is_ok());
        let old_mcp = json!({"name": "A", "alexia_protocol": 15, "mcp_protocol": "2020-01-01"});
        assert!(verdict(&old_mcp, "3.0.0")
            .unwrap_err()
            .contains("speaks a version of MCP"));
        assert!(verdict(&json!({"name": "A"}), "3.0.0").is_err());
    }

    #[test]
    fn rows_are_filtered_as_v2() {
        let sha = "b".repeat(64);
        let real = json!({"id": "sample", "sha256": sha, "coming_soon": true, "url": "u"});
        // Not a placeholder (no name/summary): a real row, and it loses the flag.
        assert_eq!(plugin_row(&real).unwrap().get("coming_soon"), None);
        let soon = json!({"id": "sample", "name": "V", "summary": "S", "coming_soon": true, "url": "u", "sha256": sha});
        let row = plugin_row(&soon).unwrap();
        assert!(row.get("url").is_none() && row.get("sha256").is_none());
        assert!(plugin_row(&json!({"id": "sample", "sha256": "nope"})).is_none());
        assert!(plugin_row(&json!({"id": "Bad", "sha256": sha})).is_none());
    }

    #[test]
    fn releases_read_as_a_shelf() {
        let block = |v: Value| format!("Notes.\n\n```alexia\n{v}\n```\n");
        let asset =
            |n: &str| json!([{"name": n, "browser_download_url": format!("https://x/{n}")}]);
        let releases = vec![
            json!({"tag_name": "sample-v1.0.0", "body": block(json!({"id": "sample", "version": "1.0.0"})), "assets": asset("sample-1.0.0.tgz"), "published_at": "2026-01-01T00:00:00Z"}),
            json!({"tag_name": "sample-v1.2.0", "body": block(json!({"id": "sample", "version": "1.2.0"})), "assets": asset("sample-1.2.0.tgz")}),
            json!({"tag_name": "draft", "draft": true, "body": block(json!({"id": "draft", "version": "1.0.0"})), "assets": asset("d.tgz")}),
            json!({"tag_name": "v3.0.0", "body": "The app itself.", "assets": asset("Alexia.msi")}),
            json!({"tag_name": "soon", "body": block(json!({"id": "later", "name": "L", "summary": "S", "coming_soon": true}))}),
            json!({"tag_name": "tidy-v1", "body": block(json!({"id": "tidy", "kind": "skill", "version": "1.0.0", "name": "tidy"})), "assets": asset("tidy.tgz")}),
        ];
        let shelf = read_releases(&releases);
        let ids: Vec<&str> = shelf.plugins.iter().map(|p| field(p, "id")).collect();
        assert_eq!(ids, ["sample", "later"]);
        assert_eq!(field(&shelf.plugins[0], "version"), "1.2.0");
        assert_eq!(
            field(&shelf.plugins[0], "url"),
            "https://x/sample-1.2.0.tgz"
        );
        assert_eq!(shelf.skills.len(), 1);
        assert_eq!(block_of("```alexiax {}```"), None);
    }

    #[test]
    fn a_multibyte_space_after_the_fence() {
        assert_eq!(block_of("```alexia\u{a0}{\"id\":1}```"), Some("{\"id\":1}"));
        assert_eq!(block_of("```alexia\u{2028}{}```"), Some("{}"));
        assert_eq!(block_of("```alexia\n{}```"), Some("{}"));
    }

    fn scratch(what: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alexia-libtest-{what}-{}", unique()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn a_failed_update_puts_the_old_folder_back() {
        let root = scratch("swap-fail");
        let dir = root.join("sample");
        std::fs::create_dir_all(dir.join("lib")).unwrap();
        std::fs::write(dir.join("plugin.json"), "old").unwrap();
        std::fs::write(dir.join("lib").join("a.js"), "old code").unwrap();
        let err = swap_folder(&dir, |to| {
            // Half written, then the disk gives out.
            std::fs::create_dir_all(to)?;
            std::fs::write(to.join("plugin.json"), "new")?;
            Err(std::io::Error::other("disk full"))
        })
        .await
        .unwrap_err();
        assert!(
            err.contains("disk full") && err.contains("old version is back"),
            "{err}"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("plugin.json")).unwrap(),
            "old"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("lib").join("a.js")).unwrap(),
            "old code"
        );
        // Nothing set aside is left over.
        let left: Vec<_> = std::fs::read_dir(&root).unwrap().flatten().collect();
        assert_eq!(left.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_good_update_replaces_the_folder() {
        let root = scratch("swap-ok");
        let dir = root.join("sample");
        let from = root.join("new");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("stale.js"), "x").unwrap();
        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("plugin.json"), "new").unwrap();
        swap_folder(&dir, |to| copy_tree(&from, to)).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("plugin.json")).unwrap(),
            "new"
        );
        assert!(!dir.join("stale.js").exists());
        let left: Vec<_> = std::fs::read_dir(&root).unwrap().flatten().collect();
        assert_eq!(left.len(), 2, "only sample and new remain");
        let _ = std::fs::remove_dir_all(&root);
    }
}
