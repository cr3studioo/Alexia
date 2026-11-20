// SPDX-License-Identifier: AGPL-3.0-only
//! Redaction before anything goes to a cloud model (TR-04). Stub: P2-14 fills it.
#![allow(unused_variables)] // stub: the filling task removes this

use serde_json::Value;

use crate::ChatRequest;

pub const PLACEHOLDER: &str = "[redacted]";

/// Secret-shaped strings only (keys, tokens, private keys, URLs with credentials).
pub fn redact_secrets(text: &str) -> (String, Vec<String>) {
    todo!("P2-14")
}

/// Secrets plus v2's personal patterns (card numbers, IBANs, one-time codes …), as v2 `redactText`.
pub fn redact_text(text: &str) -> (String, Vec<String>) {
    todo!("P2-14")
}

/// Every text part of every message and the system prompt; images untouched. `kinds` deduped.
pub fn redact_request(req: &ChatRequest) -> (ChatRequest, Vec<String>) {
    todo!("P2-14")
}

/// Every string leaf through `redact_text`.
pub fn redact_json(v: &Value) -> Value {
    todo!("P2-14")
}

pub fn summarise(kinds: &[String]) -> String {
    todo!("P2-14")
}
