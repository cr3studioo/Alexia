// SPDX-License-Identifier: AGPL-3.0-only
//! Slash commands, built-in and from plugins' manifests. Stub: P2-25 fills it.
#![allow(unused_variables)] // stub: the filling task removes this

use alexia_mcp::{Manifest, PluginId};
use tokio_util::sync::CancellationToken;

use crate::agent::Agent;
use crate::{BrainError, Reply, Turn};

pub struct CommandInfo {
    pub name: String,
    pub summary: String,
    pub alias: Option<String>,
    pub plugin: Option<PluginId>,
    pub shadowed: bool,
}

/// v2 `commands()`.
pub fn list(manifests: &[Manifest]) -> Vec<CommandInfo> {
    todo!("P2-25")
}

/// Called by `Agent::reply` for Lane::Command. Appends the turn and the answer to the session.
pub async fn run(
    agent: &Agent,
    turn: &Turn,
    cancel: CancellationToken,
) -> Result<Reply, BrainError> {
    todo!("P2-25")
}
