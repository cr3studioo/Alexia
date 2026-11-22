// SPDX-License-Identifier: AGPL-3.0-only
//! State, setup and the settings screen (INVENTORY A1–A7).
//!
//! Stubbed by P2D-01: every route answers 501 until P2D-04 fills this module.

use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;

use crate::json::not_yet;
use crate::Api;

/// What this screen keeps between requests (P2D-04).
#[derive(Default)]
pub(crate) struct StateState {}

/// Registers this area's INVENTORY rows (path + method), each answering the stub for now.
pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new()
        .route("/api/state", get(not_yet))
        .route("/api/setup", post(not_yet))
        .route("/api/permissions", post(not_yet))
        .route("/api/ceilings", post(not_yet))
        .route("/api/adult", post(not_yet))
        .route("/api/panels", get(not_yet))
        .route("/api/search", get(not_yet))
}
