// SPDX-License-Identifier: AGPL-3.0-only
//! What plugins ask of core: sampling (with `alexia/tools`), elicitation, roots, attachments.
//! Stub: P2-21 fills it; P2-34 adds the host-answered capabilities.
#![allow(unused_variables)] // stub: the filling task removes this

use alexia_mcp::alexia::AttachmentsCall;
use alexia_mcp::jsonrpc::RpcError;
use alexia_mcp::types::{ClientCapabilities, CreateMessageParams, Root};
use alexia_mcp::{HostFacts, PluginId, ProgressSink, Upcalls};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::agent::Agent;

#[async_trait::async_trait]
impl Upcalls for Agent {
    /// sampling (+tools), elicitation, roots.
    fn offers(&self, plugin: &PluginId) -> ClientCapabilities {
        todo!("P2-21")
    }

    /// `_core.display_name`, `_core.mode` → privacy, locale.
    fn host_facts(&self) -> HostFacts {
        todo!("P2-21")
    }

    async fn sample(
        &self,
        plugin: &PluginId,
        params: CreateMessageParams,
        progress: Option<ProgressSink>,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        todo!("P2-21")
    }

    async fn elicit(&self, plugin: &PluginId, params: Value) -> Result<Value, RpcError> {
        todo!("P2-21")
    }

    async fn roots(&self, plugin: &PluginId) -> Vec<Root> {
        todo!("P2-21")
    }

    async fn attachments(
        &self,
        plugin: &PluginId,
        call: AttachmentsCall,
    ) -> Result<Value, RpcError> {
        todo!("P2-21")
    }
}
