// SPDX-License-Identifier: AGPL-3.0-only
//! The event bus, the agent loop, router and providers, permissions and rails.

use serde::{Deserialize, Serialize};

pub mod bus;
pub use bus::{Bus, Event};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Store(#[from] alexia_store::Error),
    #[error(transparent)]
    Mcp(#[from] alexia_mcp::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RunId(pub String);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct JobId(pub i64);

/// Where a turn came from and where its answer goes.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Origin {
    /// `channel` is the channel's own name ("telegram", "whatsapp"); `chat` its chat id as text.
    Channel {
        channel: String,
        chat: String,
    },
    Desktop,
    Scheduler {
        job: JobId,
    },
}

/// Chat = the fast path: one model call, no tools, no loop.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lane {
    Command,
    Chat,
    Task,
}

/// One timed stretch of answering, for the latency dashboard (SP-09).
#[derive(Clone, Debug, Serialize)]
pub struct Span {
    pub name: &'static str,
    pub start: alexia_store::Ms,
    pub ms: u32,
}

/// PR-06; re-exported by alexia-scheduler.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Urgency {
    Low,
    Normal,
    High,
    Urgent,
}
