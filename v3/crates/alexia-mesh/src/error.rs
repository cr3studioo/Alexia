// SPDX-License-Identifier: AGPL-3.0-only
//! The crate's one error type. Every message is a sentence the owner can read.

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// connect failed or answered something unexpected. The String says what, as a sentence.
    #[error("The mesh connection failed: {0}")]
    Connect(String),
    /// The other device said no. The String is its reason, as a sentence.
    #[error("The other device refused: {0}")]
    Refused(String),
    #[error("The device can't be reached right now.")]
    Unreachable,
    #[error("This device isn't paired.")]
    NotPaired,
    #[error(transparent)]
    Store(#[from] alexia_store::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// Malformed input: an id, a URI, a message. The String is a full sentence.
    #[error("{0}")]
    Bad(String),
}

pub type Result<T> = std::result::Result<T, Error>;
