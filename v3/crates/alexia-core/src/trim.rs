// SPDX-License-Identifier: AGPL-3.0-only
//! Trimming the step trace to fit a model's context. Stub: P2-15 fills it.
#![allow(unused_variables)] // stub: the filling task removes this

use alexia_store::{MessageBody, Role};

/// Characters per token, v2 `trim.ts`.
pub const PER_TOKEN: usize = 3;

pub struct TrimOptions {
    /// In characters.
    pub budget: Option<usize>,
    /// Messages always kept at the end (v2's default).
    pub keep: usize,
}

impl Default for TrimOptions {
    /// v2's.
    fn default() -> TrimOptions {
        todo!("P2-15")
    }
}

pub fn budget_for(context: u32) -> usize {
    todo!("P2-15")
}

pub fn trim(messages: &[(Role, MessageBody)], opts: &TrimOptions) -> Vec<(Role, MessageBody)> {
    todo!("P2-15")
}

pub fn size(messages: &[(Role, MessageBody)]) -> usize {
    todo!("P2-15")
}
