// SPDX-License-Identifier: AGPL-3.0-only
//! Board tables and actions (INVENTORY B1–B3).
//!
//! Stubbed by P2D-01: every route answers 501 until P2D-07 fills this module.

use std::sync::Arc;

use axum::routing::post;
use axum::Router;

use crate::json::not_yet;
use crate::Api;

/// What this screen keeps between requests (P2D-07).
#[derive(Default)]
pub(crate) struct BoardState {}

/// Registers this area's INVENTORY rows (path + method), each answering the stub for now.
pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new()
        .route("/api/rows", post(not_yet))
        .route("/api/detail", post(not_yet))
        .route("/api/action", post(not_yet))
}
