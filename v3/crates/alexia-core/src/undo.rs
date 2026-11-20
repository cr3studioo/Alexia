// SPDX-License-Identifier: AGPL-3.0-only
//! Undo (AC-11). Stub: P2-28 fills it.
#![allow(unused_variables)] // stub: the filling task removes this

use std::sync::Arc;

use alexia_store::SessionId;
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::agent::Agent;
use crate::{Builtin, Origin, ToolCtx, ToolOutcome, ToolSpec};

/// "Undone: <summary>." | "There is nothing I can undo in this conversation." | the gate's refusal.
pub async fn undo_last(
    agent: &Agent,
    session: SessionId,
    origin: &Origin,
    cancel: CancellationToken,
) -> String {
    todo!("P2-28")
}

pub struct UndoTool {
    _todo: (),
}

impl UndoTool {
    pub fn new(agent: &Arc<Agent>) -> Arc<UndoTool> {
        todo!("P2-28")
    }
}

/// `undo.last {}`.
#[async_trait::async_trait]
impl Builtin for UndoTool {
    fn specs(&self) -> Vec<ToolSpec> {
        todo!("P2-28")
    }

    async fn call(
        &self,
        name: &str,
        args: &Map<String, Value>,
        ctx: &ToolCtx,
    ) -> Option<ToolOutcome> {
        todo!("P2-28")
    }
}
