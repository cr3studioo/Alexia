// SPDX-License-Identifier: AGPL-3.0-only
//! Local models and local stats (INVENTORY M1–M17).
//!
//! Stubbed by P2D-01: every route answers 501 until P2D-09 fills this module.

use std::sync::Arc;

use axum::routing::{delete, get, post};
use axum::Router;
use serde_json::Value;

use crate::json::not_yet;
use crate::Api;

/// What this screen keeps between requests (P2D-09).
#[derive(Default)]
pub(crate) struct LocalState {}

/// Registers this area's INVENTORY rows (path + method), each answering the stub for now.
pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new()
        .route("/api/local-models", get(not_yet))
        .route("/api/local-models/search", get(not_yet))
        .route("/api/local-models/repo", get(not_yet))
        .route("/api/local-models/context", get(not_yet).post(not_yet))
        .route("/api/local-models/maintenance", get(not_yet))
        .route("/api/local-models/import-preview", get(not_yet))
        .route("/api/local-models/progress", get(not_yet))
        .route("/api/local-models/install", post(not_yet))
        .route("/api/local-models/cancel", post(not_yet))
        .route("/api/local-models/import", post(not_yet))
        .route("/api/local-models/benchmark", post(not_yet))
        .route("/api/local-models/use", post(not_yet))
        .route("/api/local-models/remove", post(not_yet))
        .route("/api/local-models/{id}", delete(not_yet))
        .route("/api/local-models/token", post(not_yet))
        .route("/api/local-stats", get(not_yet))
}

/// `/api/state`'s `modeTransition` (v2 `modeTransitions.status()`): null while no switch is
/// under way (P2D-09).
#[allow(dead_code)] // read by state (P2D-04)
pub(crate) fn transition(_api: &Api) -> Value {
    Value::Null
}

/// A local-model job that must finish before the window may chat (P2D-09). Stub: none.
#[allow(dead_code)] // read by chat (P2D-05)
pub(crate) fn busy(_api: &Api) -> bool {
    false
}
