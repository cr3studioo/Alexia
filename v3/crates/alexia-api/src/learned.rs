// SPDX-License-Identifier: AGPL-3.0-only
//! Learned skills: the "Learn this" offer and edits (INVENTORY B4).
//!
//! Stubbed by P2D-01: every route answers 501 until P2D-07 fills this module.

use std::sync::Arc;

use alexia_store::SessionId;
use axum::routing::post;
use axum::Router;
use serde_json::Value;

use crate::json::not_yet;
use crate::Api;

/// Registers this area's INVENTORY rows (path + method), each answering the stub for now.
pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new().route("/api/learn", post(not_yet))
}

/// The `learn` frame's body after a task, or None when there is nothing to offer (P2D-07).
/// Stub: nothing is offered yet.
#[allow(dead_code)] // called by chat (P2D-05)
pub(crate) fn offer(
    _api: &Api,
    _session: SessionId,
    _task: &str,
    _steps: usize,
    _answer: &str,
) -> Option<Value> {
    None
}
