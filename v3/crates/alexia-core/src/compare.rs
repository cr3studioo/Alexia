// SPDX-License-Identifier: AGPL-3.0-only
//! Compare two models on one question (MO-10). Stub: P2-36 fills it.
#![allow(unused_variables)] // stub: the filling task removes this

use tokio_util::sync::CancellationToken;

use crate::router::Router;
use crate::{ChatRequest, ProviderError};

pub struct Compared {
    /// (model, text)
    pub a: (String, String),
    pub b: (String, String),
}

/// Two different providers, run fully in parallel (not a hedge: both finish).
pub async fn compare(
    router: &Router,
    req: &ChatRequest,
    cancel: CancellationToken,
) -> Result<Compared, ProviderError> {
    todo!("P2-36")
}

/// The reply text with both answers and the question "Keep A or B?"
pub fn present(c: &Compared) -> String {
    todo!("P2-36")
}
