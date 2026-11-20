// SPDX-License-Identifier: AGPL-3.0-only
//! The agent loop (SP-01). Stub: P2-20 fills it.
#![allow(unused_variables)] // stub: the filling task removes this

use std::sync::Arc;

use alexia_mcp::PluginId;
use alexia_store::{Layout, MessageBody, Role, SessionId, Store};
use tokio_util::sync::CancellationToken;

use crate::checker::Checker;
use crate::router::Router;
use crate::{
    chat, local, Ask, Brain, BrainError, Bus, DraftSink, Limits, Origin, Reply, RunId, RunResult,
    Tooling, Turn,
};

pub struct AgentParts {
    pub router: Arc<Router>,
    pub tools: Arc<dyn Tooling>,
    pub store: Arc<Store>,
    pub bus: Bus,
    pub ask: Arc<dyn Ask>,
    pub checker: Arc<Checker>,
    pub caps: Arc<dyn chat::Caps>,
    pub layout: Layout,
    pub limits: Limits,
}

/// One run to do. `steer: Steer` joins these fields with P2-20, once P2-07 has made `Steer`.
pub struct Task {
    pub session: SessionId,
    pub origin: Origin,
    /// The conversation to continue, ending with the new user turn (already stored).
    pub messages: Vec<(Role, MessageBody)>,
    pub standing: Vec<String>,
    pub background: bool,
    pub plugin: Option<PluginId>,
    pub run: Option<RunId>,
    pub parent: Option<RunId>,
    pub max_steps: Option<u32>,
}

pub struct Agent {
    _todo: (),
}

impl Agent {
    pub fn new(parts: AgentParts) -> Arc<Agent> {
        todo!("P2-20")
    }

    /// The loop. Appends every message it adds to `task.session`.
    pub async fn run(
        &self,
        task: Task,
        draft: DraftSink,
        cancel: CancellationToken,
    ) -> Result<RunResult, BrainError> {
        todo!("P2-20")
    }

    pub fn store(&self) -> &Arc<Store> {
        todo!("P2-20")
    }

    /// Set once by the hub (P2-38); None until then.
    pub fn set_local_jobs(&self, jobs: Arc<local::LocalJobs>) {
        todo!("P2-20")
    }

    pub fn local_jobs(&self) -> Option<&local::LocalJobs> {
        todo!("P2-20")
    }
}

/// Lane::Command → `commands::run`; else append the user turn, build a Task, `run`, map to Reply.
#[async_trait::async_trait]
impl Brain for Agent {
    async fn reply(
        &self,
        turn: Turn,
        draft: DraftSink,
        cancel: CancellationToken,
    ) -> Result<Reply, BrainError> {
        todo!("P2-20")
    }
}
