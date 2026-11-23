// SPDX-License-Identifier: AGPL-3.0-only
//! The library: plugins and skills from the shelf (INVENTORY L1–L3).
//!
//! Stubbed by P2D-01: every route answers 501 until P2D-08 fills this module.

use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;

use crate::json::not_yet;
use crate::Api;

/// What this screen keeps between requests (P2D-08).
#[derive(Default)]
pub(crate) struct LibraryState {}

/// Registers this area's INVENTORY rows (path + method), each answering the stub for now.
pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new()
        .route("/api/library", get(not_yet))
        .route("/api/library/progress", get(not_yet))
        .route("/api/library/install", post(not_yet))
}
