// SPDX-License-Identifier: AGPL-3.0-only
//! The crate's one error type.

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    /// The keychain failed. The String is a full sentence, never a secret.
    #[error("{0}")]
    Keychain(String),
    /// A sentence the owner reads: newer schema, not a v3 file, import already done, …
    #[error("{0}")]
    Refused(String),
    /// storage.md: an identifier or statement outside the plugin's namespace (-32052 on the wire).
    #[error("{0}")]
    OutOfNamespace(String),
    /// A malformed filter, identifier or value (-32602 on the wire).
    #[error("{0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, Error>;
