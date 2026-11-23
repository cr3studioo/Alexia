// SPDX-License-Identifier: AGPL-3.0-only
//! The plugins screen: panes, settings, trust, install, servers (INVENTORY P1–P7).
//!
//! Stubbed by P2D-01: every route answers 501 until P2D-06 fills this module.

use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;

use crate::json::not_yet;
use crate::Api;

/// What this screen keeps between requests (P2D-06).
#[derive(Default)]
pub(crate) struct PluginsState {}

/// Registers this area's INVENTORY rows (path + method), each answering the stub for now.
pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new()
        .route("/api/plugins", get(not_yet))
        .route("/api/plugin", post(not_yet))
        .route("/api/install", post(not_yet))
        .route("/api/server", post(not_yet))
        .route("/api/settings", post(not_yet))
        .route("/api/upload", post(not_yet))
        .route("/api/plugin-file", get(not_yet))
}
