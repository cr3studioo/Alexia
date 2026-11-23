// SPDX-License-Identifier: AGPL-3.0-only
//! The compute screen, on a hub with no paired computers (INVENTORY R1–R23).
//!
//! Stubbed by P2D-01: every route answers 501 until P2D-10 fills this module.

use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};

use crate::json::not_yet;
use crate::Api;

/// What this screen keeps between requests (P2D-10).
#[derive(Default)]
pub(crate) struct ComputeState {}

/// Registers this area's INVENTORY rows (path + method), each answering the stub for now.
pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new()
        .route("/api/compute/role", get(not_yet).post(not_yet))
        .route("/api/compute/role/cancel", post(not_yet))
        .route("/api/compute/hosts", get(not_yet))
        .route("/api/compute/tailscale", get(not_yet).post(not_yet))
        .route("/api/compute/discover", get(not_yet))
        .route("/api/compute/pair/start", post(not_yet))
        .route("/api/compute/pair", get(not_yet))
        .route("/api/compute/pair/cancel", post(not_yet))
        .route("/api/compute/unpair", post(not_yet))
        .route("/api/compute/inventory", get(not_yet))
        .route("/api/compute/status", get(not_yet))
        .route("/api/compute/select", post(not_yet))
        .route("/api/compute/setup/install", post(not_yet))
        .route("/api/compute/queue", get(not_yet))
        .route("/api/compute/job", get(not_yet))
        .route("/api/compute/jobs", get(not_yet))
        .route("/api/compute/jobs/cancel", post(not_yet))
        .route("/api/compute/pause", post(not_yet))
        .route("/api/compute/services", get(not_yet).post(not_yet))
        .route("/api/compute/window/close", post(not_yet))
}

/// `/api/state`'s `compute` (v2 `compute.api.state()`): this computer is the one you talk to,
/// with nothing paired (D-P2D-7). P2D-10 owns it.
#[allow(dead_code)] // read by state (P2D-04)
pub(crate) fn state(_api: &Api) -> Value {
    json!({ "role": "interaction", "available": false, "hosts": [] })
}
