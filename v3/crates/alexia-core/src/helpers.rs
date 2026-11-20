// SPDX-License-Identifier: AGPL-3.0-only
//! Parallel helpers (AC-07). Stub: P2-27 fills it.
#![allow(unused_variables)] // stub: the filling task removes this

use std::sync::Arc;

use serde_json::{Map, Value};

use crate::agent::Agent;
use crate::{Builtin, ToolCtx, ToolOutcome, ToolSpec};

pub struct Helpers {
    _todo: (),
}

impl Helpers {
    pub fn new(agent: &Arc<Agent>) -> Arc<Helpers> {
        todo!("P2-27")
    }
}

/// `helpers.run {tasks: [{goal: string}] (1..=4)}` → one section per helper:
/// "Helper 1 (<goal>): <answer or why it stopped>".
#[async_trait::async_trait]
impl Builtin for Helpers {
    fn specs(&self) -> Vec<ToolSpec> {
        todo!("P2-27")
    }

    async fn call(
        &self,
        name: &str,
        args: &Map<String, Value>,
        ctx: &ToolCtx,
    ) -> Option<ToolOutcome> {
        todo!("P2-27")
    }
}
