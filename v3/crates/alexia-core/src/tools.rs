// SPDX-License-Identifier: AGPL-3.0-only
//! Tooling over the MCP host, plus core's builtins. Stub: P2-18 fills it.
#![allow(unused_variables)] // stub: the filling task removes this

use std::sync::Arc;

use alexia_mcp::types::CallToolResult;
use alexia_mcp::{McpHost, PluginId};
use serde_json::{Map, Value};

use crate::{Builtin, ToolCtx, ToolOutcome, ToolSpec, Tooling};

pub struct McpTooling {
    _todo: (),
}

impl McpTooling {
    pub fn new(host: McpHost, builtins: Vec<Arc<dyn Builtin>>) -> McpTooling {
        todo!("P2-18")
    }

    pub fn add_builtin(&self, b: Arc<dyn Builtin>) {
        todo!("P2-18")
    }
}

#[async_trait::async_trait]
impl Tooling for McpTooling {
    async fn list(&self) -> Vec<ToolSpec> {
        todo!("P2-18")
    }

    async fn call(&self, name: &str, args: Map<String, Value>, ctx: ToolCtx) -> ToolOutcome {
        todo!("P2-18")
    }
}

/// `<plugin id>__<tool>`, v2's namespacing; a builtin keeps its own name.
pub fn namespaced(plugin: &PluginId, tool: &str) -> String {
    todo!("P2-18")
}

pub fn outcome_of(result: &CallToolResult) -> ToolOutcome {
    todo!("P2-18")
}

/// v2 `toolWords`.
pub fn tool_words(name: &str, description: Option<&str>) -> String {
    todo!("P2-18")
}
