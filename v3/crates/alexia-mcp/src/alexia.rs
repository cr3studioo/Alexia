// SPDX-License-Identifier: AGPL-3.0-only
//! The `alexia/*` layer: requests a plugin sends to core (INTERFACES.md §3.4, wire-protocol.md §5).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::jsonrpc::{code, RpcError};
use crate::types::Empty;
use crate::{Dir, Row, Scalar, Where};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrivacyMode {
    Local,
    Combined,
    Cloud,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    /// Node's names: "win32" | "darwin" | "linux".
    pub platform: String,
    /// Node's names: "x64" | "arm64".
    pub arch: String,
    /// `APP_VERSION`.
    pub alexia_version: String,
    /// `ALEXIA_PROTOCOL_MAX`.
    pub alexia_protocol: u32,
    /// Data, never compared to a name.
    pub display_name: String,
    pub privacy_mode: PrivacyMode,
    pub paths: HostPaths,
    /// BCP 47, e.g. "en-GB".
    pub locale: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPaths {
    /// Only with `fs.own_dir`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub own_dir: Option<String>,
    pub cache_dir: String,
}

/// One request from a plugin, parsed by method name. `params: None` parses as `{}`.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum AlexiaCall {
    #[serde(rename = "alexia/settings/get")]
    SettingsGet(Empty),
    #[serde(rename = "alexia/settings/set")]
    SettingsSet(KeyValue),
    #[serde(rename = "alexia/storage/insert")]
    Insert(InsertParams),
    #[serde(rename = "alexia/storage/select")]
    Select(SelectParams),
    #[serde(rename = "alexia/storage/update")]
    Update(UpdateParams),
    #[serde(rename = "alexia/storage/delete")]
    Delete(DeleteParams),
    #[serde(rename = "alexia/storage/count")]
    Count(CountParams),
    #[serde(rename = "alexia/storage/kv/get")]
    KvGet(Key),
    #[serde(rename = "alexia/storage/kv/set")]
    KvSet(KeyValue),
    #[serde(rename = "alexia/storage/kv/delete")]
    KvDelete(Key),
    #[serde(rename = "alexia/storage/raw")]
    Raw(RawParams),
    #[serde(rename = "alexia/capability/call")]
    CapabilityCall(CapabilityCallParams),
    #[serde(rename = "alexia/answers")]
    Answers(Cap),
    #[serde(rename = "alexia/host/info")]
    HostInfo(Empty),
    #[serde(rename = "alexia/compute/run")]
    ComputeRun(ComputeRunParams),
    #[serde(rename = "alexia/attachments/lease")]
    AttachmentsLease(Value),
    #[serde(rename = "alexia/attachments/release")]
    AttachmentsRelease(Value),
    #[serde(rename = "alexia/attachments/live")]
    AttachmentsLive(Value),
    #[serde(rename = "alexia/attachments/register")]
    AttachmentsRegister(Value),
    #[serde(rename = "alexia/attachments/share")]
    AttachmentsShare(Value),
}

/// Every method name `AlexiaCall` knows, in its order.
const METHODS: [&str; 20] = [
    "alexia/settings/get",
    "alexia/settings/set",
    "alexia/storage/insert",
    "alexia/storage/select",
    "alexia/storage/update",
    "alexia/storage/delete",
    "alexia/storage/count",
    "alexia/storage/kv/get",
    "alexia/storage/kv/set",
    "alexia/storage/kv/delete",
    "alexia/storage/raw",
    "alexia/capability/call",
    "alexia/answers",
    "alexia/host/info",
    "alexia/compute/run",
    "alexia/attachments/lease",
    "alexia/attachments/release",
    "alexia/attachments/live",
    "alexia/attachments/register",
    "alexia/attachments/share",
];

impl AlexiaCall {
    /// Ok(None): not an alexia/* method. Err: an alexia/* method with bad params (-32602).
    pub fn parse(method: &str, params: Option<Value>) -> Result<Option<AlexiaCall>, RpcError> {
        if !METHODS.contains(&method) {
            return Ok(None);
        }
        let params = match params {
            None | Some(Value::Null) => Value::Object(Map::new()),
            Some(p) => p,
        };
        let envelope = serde_json::json!({ "method": method, "params": params });
        serde_json::from_value(envelope).map(Some).map_err(|e| {
            RpcError::new(
                code::INVALID_PARAMS,
                format!("The params sent with {method} are not valid: {e}."),
            )
        })
    }
}

/// What `Upcalls::attachments` receives: the method's last segment and its raw params.
/// Shapes are v2's `packages/protocol/src/private-context.ts`, ported when V3-2 implements them.
pub struct AttachmentsCall {
    pub op: &'static str,
    pub params: Value,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Key {
    pub key: String,
}
#[derive(Clone, Debug, Deserialize)]
pub struct KeyValue {
    pub key: String,
    pub value: Value,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Cap {
    pub cap: String,
}
#[derive(Clone, Debug, Deserialize)]
pub struct InsertParams {
    pub table: String,
    pub row: Row,
}
#[derive(Clone, Debug, Deserialize)]
pub struct SelectParams {
    pub table: String,
    #[serde(rename = "where")]
    pub filter: Option<Where>,
    #[serde(default)]
    pub order: Vec<(String, Dir)>,
    pub limit: Option<u64>,
    pub offset: Option<u64>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct UpdateParams {
    pub table: String,
    pub set: Row,
    #[serde(rename = "where")]
    pub filter: Where,
}
#[derive(Clone, Debug, Deserialize)]
pub struct DeleteParams {
    pub table: String,
    #[serde(rename = "where")]
    pub filter: Option<Where>,
    pub all: Option<bool>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct CountParams {
    pub table: String,
    #[serde(rename = "where")]
    pub filter: Option<Where>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct RawParams {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Scalar>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct CapabilityCallParams {
    pub cap: String,
    pub arguments: Option<Map<String, Value>>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct ComputeInput {
    pub name: String,
    pub path: String,
    pub mime: String,
}
#[derive(Clone, Debug, Deserialize)]
pub struct ComputeRunParams {
    pub cap: String,
    pub arguments: Option<Map<String, Value>>,
    #[serde(default)]
    pub inputs: Vec<ComputeInput>,
}
