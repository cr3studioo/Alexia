// SPDX-License-Identifier: AGPL-3.0-only

//! The error codes, which are the API: core switches on `code`, shows nobody `message`.

use hyper::StatusCode;

/// One refusal. `code` is from the table in `README.md` and nowhere else.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn status(&self) -> StatusCode {
        status(self.code)
    }
}

pub const UNAUTHORIZED: &str = "unauthorized";
pub const NOT_FOUND: &str = "not_found";
pub const BAD_REQUEST: &str = "bad_request";
pub const PAYLOAD_TOO_LARGE: &str = "payload_too_large";
pub const PEER_NOT_ALLOWED: &str = "peer_not_allowed";
pub const PEER_UNREACHABLE: &str = "peer_unreachable";
pub const PEER_REJECTED: &str = "peer_rejected";
pub const OPERATION_NOT_REGISTERED: &str = "operation_not_registered";
pub const HOST_UNAVAILABLE: &str = "host_unavailable";
pub const STREAM_FAILED: &str = "stream_failed";
pub const NETWORK_FAILED: &str = "network_failed";
pub const MAILBOX_NOT_CONFIGURED: &str = "mailbox_not_configured";
pub const ALREADY_PAIRED: &str = "already_paired";
pub const PAIRING_LIMIT: &str = "pairing_limit";
pub const PAIRING_MAILBOX_FAILED: &str = "pairing_mailbox_failed";
/// Why a pairing ended without a peer. These are said in a pairing's `error`, not as a status.
pub const PAIRING_EXPIRED: &str = "pairing_expired";
pub const PAIRING_CANCELLED: &str = "pairing_cancelled";
pub const PAIRING_CODE_UNKNOWN: &str = "pairing_code_unknown";
pub const PAIRING_WRONG_CODE: &str = "pairing_wrong_code";
pub const PAIRING_PROOF_FAILED: &str = "pairing_proof_failed";
pub const PAIRING_PEER_INVALID: &str = "pairing_peer_invalid";
pub const PAIRING_TIMEOUT: &str = "pairing_timeout";

/// The codes the other computer may send in a head. Anything else it sends is `stream_failed`:
/// a peer does not get to choose what this process tells core.
pub fn from_wire(code: &str) -> &'static str {
    [BAD_REQUEST, PEER_NOT_ALLOWED, OPERATION_NOT_REGISTERED, HOST_UNAVAILABLE]
        .into_iter()
        .find(|known| *known == code)
        .map_or(STREAM_FAILED, |known| if known == PEER_NOT_ALLOWED { PEER_REJECTED } else { known })
}

fn status(code: &str) -> StatusCode {
    match code {
        UNAUTHORIZED => StatusCode::UNAUTHORIZED,
        NOT_FOUND => StatusCode::NOT_FOUND,
        BAD_REQUEST => StatusCode::BAD_REQUEST,
        PAYLOAD_TOO_LARGE => StatusCode::PAYLOAD_TOO_LARGE,
        PEER_NOT_ALLOWED | PEER_REJECTED | OPERATION_NOT_REGISTERED => StatusCode::FORBIDDEN,
        HOST_UNAVAILABLE | MAILBOX_NOT_CONFIGURED => StatusCode::SERVICE_UNAVAILABLE,
        ALREADY_PAIRED => StatusCode::CONFLICT,
        PAIRING_LIMIT => StatusCode::TOO_MANY_REQUESTS,
        _ => StatusCode::BAD_GATEWAY,
    }
}
