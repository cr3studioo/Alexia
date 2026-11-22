// SPDX-License-Identifier: AGPL-3.0-only
//! The image editor (INVENTORY E1–E5).
//!
//! Stubbed by P2D-01: every route answers 501 until P2D-11 fills this module.

use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};

use crate::json::not_yet;
use crate::Api;

/// What this screen keeps between requests (P2D-11).
#[derive(Default)]
pub(crate) struct EditorState {}

/// Registers this area's INVENTORY rows (path + method), each answering the stub for now.
pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new()
        .route("/api/editor", post(not_yet))
        .route("/api/editor/file", get(not_yet))
        .route("/api/editor/picture", get(not_yet))
        .route("/api/editor/forget", post(not_yet))
        .route("/api/editor/upload", post(not_yet))
}

/// `/api/state`'s `editor` (serve.ts 1925): whether the editor can be opened, and the
/// conversation it would open in. Stub: not installed (P2D-11 finds it by capability).
#[allow(dead_code)] // read by state (P2D-04)
pub(crate) fn state(api: &Api) -> Value {
    json!({ "installed": false, "conversationId": api.session().0.to_string(), "private": false })
}
