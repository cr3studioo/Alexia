// SPDX-License-Identifier: AGPL-3.0-only
//! Runs survive a restart; jobs that run for days (SP-13, AC-08). Stub: P2-26 fills it.
#![allow(unused_variables)] // stub: the filling task removes this

use std::sync::Arc;

use alexia_store::{SessionId, Store};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::agent::Agent;
use crate::Result;

/// For every `live_runs` row: fix dangling calls, say "Picking up where I stopped: <task>." to the
/// run's origin (`Event::Say`), and spawn `agent.run` with the same RunId and `steps` so far.
/// Rows older than 7 days, or whose session is gone, are ended with a note instead. Returns how many resumed.
pub async fn resume_all(
    agent: Arc<Agent>,
    tracker: &TaskTracker,
    cancel: CancellationToken,
) -> usize {
    todo!("P2-26")
}

/// The dangling-call fix on its own (v2 P1-24 / P1-31 rule).
pub fn answer_dangling(store: &Store, session: SessionId, why: &str) -> Result<u32> {
    todo!("P2-26")
}
