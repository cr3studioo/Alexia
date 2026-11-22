// SPDX-License-Identifier: AGPL-3.0-only
//! The research viewer (INVENTORY E6–E7).
//!
//! Stubbed by P2D-01: every route answers 501 until P2D-11 fills this module.

use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;

use crate::json::not_yet;
use crate::Api;

/// What this screen keeps between requests (P2D-11).
#[derive(Default)]
pub(crate) struct ResearchState {}

/// Registers this area's INVENTORY rows (path + method), each answering the stub for now.
pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new()
        .route("/api/research", post(not_yet))
        .route("/api/research-file", get(not_yet))
}
