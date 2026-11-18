// SPDX-License-Identifier: AGPL-3.0-only
//! The crate's one error type.

use crate::PluginId;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Store(#[from] alexia_store::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("No plugin with that id is installed.")]
    UnknownPlugin(PluginId),
    /// A sentence the owner reads (incompatible, switched off, unhealthy).
    #[error("{0}")]
    Refused(String),
}

pub type Result<T> = std::result::Result<T, Error>;
