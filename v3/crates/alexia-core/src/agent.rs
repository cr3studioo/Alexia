// SPDX-License-Identifier: AGPL-3.0-only
//! The agent loop (SP-01). Stub: P2-20 fills it.
#![allow(unused_variables)] // stub: the filling task removes this

use std::sync::{Arc, OnceLock};

use alexia_mcp::{McpHost, PluginId};
use alexia_store::{Layout, MessageBody, Role, SessionId, Store};
use tokio_util::sync::CancellationToken;

use crate::checker::Checker;
use crate::router::Router;
use crate::{
    chat, local, Ask, Brain, BrainError, Bus, DraftSink, Limits, Origin, Reply, RunId, RunResult,
    Steer, Tooling, Turn,
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
    /// (review 4 #2) manifests() for commands, conversation_ended, plugins()
    pub host: McpHost,
}

/// One run to do.
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
    pub steer: Steer,
    /// (review 4 #1) Some(n): resuming `run` with n steps done (P2-26). None: new run.
    pub steps_done: Option<u32>,
}

pub struct Agent {
    parts: AgentParts,
    local_jobs: OnceLock<Arc<local::LocalJobs>>,
}

impl Agent {
    pub fn new(parts: AgentParts) -> Arc<Agent> {
        Arc::new(Agent {
            parts,
            local_jobs: OnceLock::new(),
        })
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
        &self.parts.store
    }

    pub fn host(&self) -> &McpHost {
        &self.parts.host
    }

    /// Set once by the hub (P2-38); None until then. A second set is ignored.
    pub fn set_local_jobs(&self, jobs: Arc<local::LocalJobs>) {
        if self.local_jobs.set(jobs).is_err() {
            tracing::warn!("local jobs were already set; the second set is ignored");
        }
    }

    pub fn local_jobs(&self) -> Option<&local::LocalJobs> {
        self.local_jobs.get().map(|j| &**j)
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
