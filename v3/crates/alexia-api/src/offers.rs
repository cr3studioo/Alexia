// SPDX-License-Identifier: AGPL-3.0-only
//! Files a tool made, offered by id: download, Open, Show in folder (INVENTORY C6–C7).
//!
//! Stubbed by P2D-01: every route answers 501 until P2D-05 fills this module.

use std::sync::Arc;

use alexia_core::Produced;
use axum::routing::get;
use axum::Router;
use serde_json::Value;

use crate::json::not_yet;
use crate::Api;

/// Registers this area's INVENTORY rows (path + method), each answering the stub for now.
pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new().route("/api/file", get(not_yet).post(not_yet))
}

/// The files offered to the window this run, by id (v2 `offered`). P2D-05 fills it.
#[derive(Default)]
pub(crate) struct Offers {}

impl Offers {
    /// Keeps `files` under fresh ids and answers them as the `step` outcome's `files` (P2D-05).
    /// Stub: nothing is offered yet.
    #[allow(dead_code)] // called by chat (P2D-05)
    pub(crate) fn keep(&self, _files: &[Produced]) -> Vec<Value> {
        Vec::new()
    }
}
