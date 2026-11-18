// SPDX-License-Identifier: AGPL-3.0-only
//! The data types every crate shares: ids, messages, the plugin storage grammar, ledger rows.

use serde::{Deserialize, Serialize};

use crate::{Error, Result};

pub type Ms = i64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub i64);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MessageId(pub i64);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// One part of a turn. The v2 shape, so v2 rows parse unchanged.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Part {
    Text {
        text: String,
    },
    /// A full `data:` URL.
    Image {
        url: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Content {
    Text(String),
    Parts(Vec<Part>),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// JSON text, as the provider sent it
    pub arguments: String,
}

/// `messages.body`: everything about a turn except `role` and `model`, which are columns.
/// Field names are v2's, including its camelCase `callId`. Unknown keys are kept in `extra`
/// and written back, so a v2 field nobody ported yet is never lost.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageBody {
    pub content: Content,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calls: Option<Vec<ToolCall>>,
    #[serde(default, rename = "callId", skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bad: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typed: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    pub id: MessageId,
    pub session: SessionId,
    pub role: Role,
    pub model: Option<String>,
    pub body: MessageBody,
    pub at: Ms,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub id: SessionId,
    pub title: Option<String>,
    pub created_at: Ms,
    pub updated_at: Ms,
}

// ---- the plugin storage grammar (storage.md). mcp's wire params reuse these types. ----

/// A bound parameter. Nothing a plugin sends is ever concatenated into SQL.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Scalar {
    Null,
    Bool(bool),
    Num(serde_json::Number),
    Str(String),
}

/// Exactly one field set; `validate()` rejects zero or two. Unknown keys are a parse error.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Operator {
    pub eq: Option<Scalar>,
    pub ne: Option<Scalar>,
    pub lt: Option<Scalar>,
    pub lte: Option<Scalar>,
    pub gt: Option<Scalar>,
    pub gte: Option<Scalar>,
    #[serde(rename = "in")]
    pub in_: Option<Vec<Scalar>>,
    pub like: Option<String>,
    /// Only `true` is valid.
    pub is_null: Option<bool>,
}

impl Operator {
    /// Exactly one field set; `is_null` only `Some(true)`; `in_` non-empty. Else `Error::Invalid`.
    pub fn validate(&self) -> Result<()> {
        let set = [
            self.eq.is_some(),
            self.ne.is_some(),
            self.lt.is_some(),
            self.lte.is_some(),
            self.gt.is_some(),
            self.gte.is_some(),
            self.in_.is_some(),
            self.like.is_some(),
            self.is_null.is_some(),
        ]
        .into_iter()
        .filter(|&b| b)
        .count();
        if set != 1 {
            return Err(Error::Invalid(format!(
                "A condition needs exactly one operator, this one has {set}."
            )));
        }
        if self.is_null == Some(false) {
            return Err(Error::Invalid(
                "isNull only accepts true; use ne or a different filter.".into(),
            ));
        }
        if self.in_.as_ref().is_some_and(Vec::is_empty) {
            return Err(Error::Invalid("in needs at least one value.".into()));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Cond {
    Op(Operator),
    Eq(Scalar),
}

/// Column → condition. Several keys are AND. Column names match `^[a-z][a-z0-9_]*$`.
pub type Where = std::collections::BTreeMap<String, Cond>;
/// A row in: objects and arrays are stored as JSON text, booleans as 0/1.
pub type Row = serde_json::Map<String, serde_json::Value>;

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dir {
    Asc,
    Desc,
}

#[derive(Clone, Debug, Default)]
pub struct Select {
    pub filter: Option<Where>,
    pub order: Vec<(String, Dir)>,
    pub limit: Option<u64>,
    pub offset: Option<u64>,
}

pub enum DeleteScope<'a> {
    Where(&'a Where),
    All,
}

/// Usage and the model record (v2 migrations 4–9), written by the router.
#[derive(Clone, Debug)]
pub struct Usage {
    pub at: Ms,
    pub session: Option<SessionId>,
    pub plugin: Option<String>,
    pub model: String,
    pub asked: Option<String>,
    pub provider: String,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub cost: f64,
    pub run_id: Option<String>,
    pub writing_ms: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct Try {
    pub at: Ms,
    pub provider: String,
    pub model: String,
    pub outcome: String,
    pub status: i64,
    pub source: String,
    pub waited_ms: Option<i64>,
}

/// SP-09: one timed stage of one turn. `origin` is JSON text, so the store never depends on
/// `alexia-core`'s `Origin`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpanRow {
    pub turn: String,
    pub at: Ms,
    pub origin: String,
    pub lane: String,
    pub name: String,
    pub start: Ms,
    pub ms: i64,
}

/// A `tries` row as the router reads it back.
#[derive(Clone, Debug, PartialEq)]
pub struct TryRow {
    pub at: Ms,
    pub provider: String,
    pub model: String,
    pub outcome: String,
    pub status: i64,
    pub waited_ms: Option<i64>,
}

/// `^[a-z][a-z0-9_]*$`, the column and table name rule from storage.md.
pub fn is_ident(s: &str) -> bool {
    let mut b = s.bytes();
    b.next().is_some_and(|c| c.is_ascii_lowercase())
        && b.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}
