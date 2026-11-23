// SPDX-License-Identifier: AGPL-3.0-only
//! The image editor (INVENTORY E1–E5). A port of v2 `serve.ts` 2062–2128 (the routes),
//! 3502–3570 (`editorCall`, `forgetPictures`) and `plugins.ts` `editorCall` / `editorInstalled`.
//!
//! The editor is whatever enabled plugin provides `image.edit`, found by capability through
//! `McpHost` and never by id. The conversation is core's to name: every route checks it exists
//! and replaces whatever the body said about it. The pictures are core's (`Agent::album`).

use std::collections::HashMap;
use std::sync::Arc;

use alexia_mcp::types::CallToolResult;
use alexia_mcp::{CallCtx, CallError};
use alexia_store::SessionId;
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

/// The capability the editor screen reaches its plugin by.
const IMAGE_EDIT: &str = "image.edit";
const CORE: &str = "_core";
/// kv `_core` key holding the sessions whose pictures stay on this computer (v2).
const PRIVATE: &str = "private_sessions";
/// v2 `PLANNER_KEY`: which model plans an edit.
const PLANNER_KEY: &str = "editor_planner";
/// v2 `PRIVATE_CONTEXT_CAPABILITY` and `ADULT_META`: request `_meta` core sets.
const PRIVATE_CONTEXT: &str = "alexia/privateContext";
const ADULT_META: &str = "alexia/adult";
/// v2 `ALEXIA_PROTOCOL_MAX`.
const PROTOCOL_MAX: u32 = 15;
/// v2 attach.ts `MOST_PER_FILE`.
const MOST_PER_FILE: usize = 25 * 1024 * 1024;
/// The calls the editor screen may make (v2's list).
const CALLS: &[&str] = &[
    "open",
    "loadDraft",
    "profiles",
    "versions",
    "batch",
    "command",
    "pending",
    "events",
    "pictures",
    "select_profile",
    "install_profile",
    "preview",
    "planners",
    "select_planner",
];
const NO_EDITOR: &str = "No image editor is installed and switched on.";

/// What this screen keeps between requests: nothing. The shared files live with the pictures,
/// in core (`Agent::album`), because the plugin shares them over an upcall.
#[derive(Default)]
pub(crate) struct EditorState {}

pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new()
        .route("/api/editor", post(call))
        .route("/api/editor/file", get(file))
        .route("/api/editor/picture", get(picture))
        .route("/api/editor/forget", post(forget))
        .route("/api/editor/upload", post(upload))
}

/// `/api/state`'s `editor` (serve.ts 1926): whether the editor can be opened, and the
/// conversation it would open in. Read from manifests, starting nothing.
pub(crate) fn state(api: &Api) -> Value {
    let session = api.session();
    json!({
        "installed": installed(api),
        "conversationId": session.0.to_string(),
        "private": crate::board::is_private(api, session),
    })
}

/// v2 `editorInstalled`: some enabled plugin promises `image.edit`.
fn installed(api: &Api) -> bool {
    api.parts.host.answers(IMAGE_EDIT).answers
}

/// A refusal the editor screen reads: `{ok:false, code, said}` with 409 (v2's catch).
struct Refused {
    code: String,
    said: String,
}

fn refused(code: &str, said: impl Into<String>) -> Refused {
    Refused {
        code: code.into(),
        said: said.into(),
    }
}

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        no_store(json::with(
            409,
            json!({ "ok": false, "code": self.code, "said": self.said }),
        ))
    }
}

fn no_store(mut r: Response) -> Response {
    r.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    r
}

fn answer(v: Value) -> Response {
    no_store(json::ok(v))
}

/// v2 `conversation`: the id as text, when a chat with that id exists.
fn conversation(api: &Api, raw: Option<&Value>) -> Result<String, Refused> {
    let id = match raw {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    let none = || refused("context_required", "There is no conversation with that id.");
    let sessions = api.parts.store.sessions().map_err(|e| {
        tracing::warn!("editor: conversations could not be read: {e}");
        none()
    })?;
    if sessions.iter().any(|s| s.id.0.to_string() == id) {
        Ok(id)
    } else {
        Err(none())
    }
}

fn session_of(id: &str) -> SessionId {
    SessionId(id.parse().unwrap_or_default())
}

/// v2 `markPrivate`: this conversation's pictures stay on this computer from now on.
fn mark_private(api: &Api, id: &str) {
    let store = &api.parts.store;
    let mut now: Vec<i64> = store
        .kv_get(CORE, PRIVATE)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let session = session_of(id).0;
    if !now.contains(&session) {
        now.push(session);
        if let Err(e) = store.kv_set(CORE, PRIVATE, &json!(now)) {
            tracing::warn!("editor: a conversation could not be marked private: {e}");
        }
    }
}

/// v2 `adultMode`: the person confirmed 18+ in Settings and `/nsfw` is on.
fn adult_on(api: &Api) -> bool {
    let kv = |k: &str| api.parts.store.kv_get(CORE, k).ok().flatten();
    let confirmed = kv("adult").is_some_and(|v| v.get("confirmedAt").is_some_and(Value::is_number));
    let on = kv("pins").is_some_and(|v| v.get("uncensored") == Some(&Value::Bool(true)));
    confirmed && on
}

/// v2 `editorCall`: one call to the plugin providing `image.edit`, for the person at the
/// screen. The conversation is core's to name, never taken from the plugin.
async fn editor_call(
    api: &Api,
    conversation: &str,
    args: Map<String, Value>,
) -> Result<Map<String, Value>, Refused> {
    let mut meta = Map::new();
    meta.insert(
        PRIVATE_CONTEXT.into(),
        json!({
            "protocol": PROTOCOL_MAX,
            "capabilities": {
                "version": "1",
                "attachmentContext": true,
                "interactionOnlySampling": true,
                "structuredSampling": true,
                "revocablePublication": true,
                "imageJobVersions": ["1.1", "1.2"],
            },
        }),
    );
    if adult_on(api) {
        meta.insert(ADULT_META.into(), Value::Bool(true));
    }
    let ctx = CallCtx {
        conversation: Some(conversation.to_owned()),
        meta,
        ..CallCtx::default()
    };
    let result = api
        .parts
        .host
        .call_capability(IMAGE_EDIT, args, ctx)
        .await
        .map_err(|e| match e {
            CallError::Off { .. } => refused("render_failed", NO_EDITOR),
            e => refused("render_failed", e.to_string()),
        })?;
    said_by(&result)
}

/// The editor answers with JSON in its first text block; an error result is a refusal with
/// the code and message it gave.
fn said_by(result: &CallToolResult) -> Result<Map<String, Value>, Refused> {
    let text = result
        .content
        .iter()
        .find(|c| c.get("type").and_then(Value::as_str) == Some("text"))
        .and_then(|c| c.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("{}");
    let said = match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(m)) => m,
        _ => {
            let mut m = Map::new();
            m.insert("code".into(), json!("render_failed"));
            m.insert("message".into(), json!(text));
            m
        }
    };
    if result.is_error == Some(true) {
        let code = said
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("render_failed");
        let message = said
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("The editor could not do that.");
        return Err(refused(code, message));
    }
    Ok(said)
}

/// `POST /api/editor {conversationId, call, ...}`.
async fn call(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    match calling(&api, sent).await {
        Ok(v) => answer(v),
        Err(r) => r.into_response(),
    }
}

async fn calling(api: &Api, mut sent: Map<String, Value>) -> Result<Value, Refused> {
    let id = conversation(api, sent.get("conversationId"))?;
    let call = match sent.get("call") {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    };
    if !CALLS.contains(&call.as_str()) {
        return Err(refused(
            "schema_unsupported",
            "That is not something the editor does.",
        ));
    }
    match call.as_str() {
        "pictures" => {
            let pictures = api
                .parts
                .agent
                .album()
                .list(&id)
                .map_err(|e| refused("attachment_unavailable", e))?;
            return Ok(json!({ "ok": true, "pictures": pictures }));
        }
        // Which model plans an edit: core's to know. v3 has no local vision planner to offer
        // yet, so the list is empty and only "none chosen" can be chosen.
        "planners" => {
            let selected = api
                .parts
                .store
                .kv_get(CORE, PLANNER_KEY)
                .ok()
                .flatten()
                .unwrap_or(Value::Null);
            return Ok(json!({ "ok": true, "planners": [], "selected": selected }));
        }
        "select_planner" => {
            if sent.get("model") != Some(&Value::Null) {
                return Err(refused(
                    "planner_unavailable",
                    "That model is not one on this computer that can see pictures.",
                ));
            }
            if let Err(e) = api.parts.store.kv_set(CORE, PLANNER_KEY, &Value::Null) {
                return Err(refused("render_failed", e.to_string()));
            }
            return Ok(json!({ "ok": true, "selected": null }));
        }
        // Opening the editor on a picture makes the conversation private from here on.
        "open" | "command" => mark_private(api, &id),
        _ => {}
    }
    // The conversation and the call are core's to set; whatever the body said is replaced.
    sent.insert("call".into(), json!(call));
    sent.insert("conversationId".into(), json!(id));
    let said = editor_call(api, &id, sent).await?;
    let mut out = Map::new();
    out.insert("ok".into(), Value::Bool(true));
    out.extend(said);
    Ok(Value::Object(out))
}

/// `GET /api/editor/file?token=`: a file the editor shared with its screen.
async fn file(State(api): State<Arc<Api>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let token = q.get("token").map(String::as_str).unwrap_or_default();
    let gone = || no_store(json::said(404, "That file is not available any more."));
    let Some(one) = api.parts.agent.album().shared(token) else {
        return gone();
    };
    match std::fs::read(&one.path) {
        Ok(bytes) => bytes_of(&one.mime, bytes),
        Err(_) => gone(),
    }
}

fn bytes_of(mime: &str, bytes: Vec<u8>) -> Response {
    let kind = header::HeaderValue::from_str(mime)
        .unwrap_or(header::HeaderValue::from_static("application/octet-stream"));
    (
        [
            (header::CONTENT_TYPE, kind),
            (
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("no-store"),
            ),
        ],
        bytes,
    )
        .into_response()
}

/// `GET /api/editor/picture?conversation=&id=`: one of the conversation's own pictures.
async fn picture(
    State(api): State<Arc<Api>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let raw = q.get("conversation").map(|s| json!(s));
    let id = match conversation(&api, raw.as_ref()) {
        Ok(id) => id,
        Err(r) => return r.into_response(),
    };
    let wanted = q.get("id").map(String::as_str).unwrap_or_default();
    match api.parts.agent.album().bytes(&id, wanted) {
        Ok((mime, bytes)) => bytes_of(&mime, bytes),
        Err(e) => refused("attachment_unavailable", e).into_response(),
    }
}

/// `POST /api/editor/upload {conversationId, name, data, normalizedFrom?}`: a picture the
/// editor turned upright in the window, checked like any upload.
async fn upload(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    let id = match conversation(&api, sent.get("conversationId")) {
        Ok(id) => id,
        Err(r) => return r.into_response(),
    };
    let data = sent.get("data").and_then(Value::as_str).unwrap_or_default();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .unwrap_or_default();
    if bytes.is_empty() || bytes.len() > MOST_PER_FILE {
        return refused("input_limit", "That picture is empty or too large.").into_response();
    }
    // It makes the conversation private like any picture does.
    mark_private(&api, &id);
    let name = sent
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("picture.png");
    let origin = if sent.contains_key("normalizedFrom") {
        "normalized"
    } else {
        "upload"
    };
    match api.parts.agent.album().ingest(&id, name, &bytes, origin) {
        Ok(picture) => answer(json!({ "ok": true, "picture": picture })),
        Err(e) => refused("input_limit", e).into_response(),
    }
}

/// `POST /api/editor/forget {conversationId}`: v2 `forgetPictures`. Core's pictures and the
/// shared files go first, then the editor is asked to revoke and clean up its own.
async fn forget(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    let id = match conversation(&api, sent.get("conversationId")) {
        Ok(id) => id,
        Err(r) => return r.into_response(),
    };
    let revocation = format!("rev_{}", revocation_hex());
    let mut local = "complete";
    let mut remote = Value::Array(vec![]);
    let mine = api.parts.agent.album().forget(&id);
    if installed(&api) {
        let ask = |call: &str| {
            let mut args = Map::new();
            args.insert("call".into(), json!(call));
            args.insert("conversationId".into(), json!(id));
            args.insert("revocationId".into(), json!(revocation));
            args
        };
        let done = match editor_call(&api, &id, ask("revoke")).await {
            Ok(_) => editor_call(&api, &id, ask("cleanup")).await,
            Err(e) => Err(e),
        };
        match done {
            Ok(done) => {
                remote = done.get("remote").cloned().unwrap_or(json!([]));
                if done.get("local").and_then(Value::as_str) != Some("complete") {
                    local = "pending";
                }
            }
            Err(e) => {
                tracing::warn!(
                    "the editor could not finish forgetting conversation {id}: {}",
                    e.said
                );
                local = "pending";
            }
        }
    }
    if let Err(e) = mine {
        tracing::warn!("pictures of conversation {id} could not all be forgotten: {e}");
        local = "failed";
    }
    answer(json!({
        "ok": true,
        "receipt": { "revocationId": revocation, "local": local, "remote": remote },
    }))
}

/// 32 hex characters, for a revocation id (v2 `randomUUID` without dashes). Not a secret.
fn revocation_hex() -> String {
    use sha2::{Digest, Sha256};
    use std::hash::{BuildHasher, Hasher};
    let mut s = std::collections::hash_map::RandomState::new().build_hasher();
    s.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
    );
    Sha256::digest(s.finish().to_le_bytes())
        .iter()
        .take(16)
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(text: &str, error: bool) -> CallToolResult {
        serde_json::from_value(json!({
            "content": [{ "type": "text", "text": text }],
            "isError": error,
        }))
        .unwrap()
    }

    #[test]
    fn editor_answers_read() {
        let ok = said_by(&result(r#"{"draft":1}"#, false)).ok().unwrap();
        assert_eq!(ok["draft"], 1);
        let e = said_by(&result(r#"{"code":"x_y","message":"No."}"#, true))
            .err()
            .unwrap();
        assert_eq!((e.code.as_str(), e.said.as_str()), ("x_y", "No."));
        let e = said_by(&result("plain words", true)).err().unwrap();
        assert_eq!(
            (e.code.as_str(), e.said.as_str()),
            ("render_failed", "plain words")
        );
    }

    #[test]
    fn revocation_ids_differ() {
        let (a, b) = (revocation_hex(), revocation_hex());
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }
}
