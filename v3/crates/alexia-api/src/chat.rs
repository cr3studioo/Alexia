// SPDX-License-Identifier: AGPL-3.0-only
//! Chat in the window: the stream, stop, approve, commands (INVENTORY C1–C5).
//!
//! Stubbed by P2D-01: every route answers 501 until P2D-05 fills this module.

use std::sync::Arc;

use axum::routing::post;
use axum::Router;

use crate::json::not_yet;
use crate::Api;

/// What this screen keeps between requests (P2D-05).
#[derive(Default)]
pub(crate) struct ChatState {}

/// Registers this area's INVENTORY rows (path + method), each answering the stub for now.
pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new()
        .route("/api/chat", post(not_yet))
        .route("/api/stop", post(not_yet))
        .route("/api/approve", post(not_yet))
        .route("/api/command", post(not_yet))
        .route("/api/not-her", post(not_yet))
}
