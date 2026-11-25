// SPDX-License-Identifier: AGPL-3.0-only
//! v2's answer helpers (serve.ts `answer`), used by every area module.

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

fn status(code: u16) -> StatusCode {
    StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

/// 200, `application/json`.
pub(crate) fn ok(v: Value) -> Response {
    with(200, v)
}

/// `status`, `application/json`.
pub(crate) fn with(code: u16, v: Value) -> Response {
    (
        status(code),
        [(header::CONTENT_TYPE, "application/json")],
        v.to_string(),
    )
        .into_response()
}

/// `{"ok":false,"said":said}`.
pub(crate) fn said(code: u16, said: &str) -> Response {
    with(code, json!({ "ok": false, "said": said }))
}

/// No body at all (v2's 404).
pub(crate) fn empty(code: u16) -> Response {
    status(code).into_response()
}

/// `text/plain`, for the gate's refusal and the missing window files.
pub(crate) fn text(code: u16, body: &'static str) -> Response {
    (status(code), [(header::CONTENT_TYPE, "text/plain")], body).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn shapes() {
        let r = said(409, "no");
        assert_eq!(r.status(), 409);
        assert_eq!(r.headers()[header::CONTENT_TYPE], "application/json");
        let r = empty(404);
        assert_eq!(r.status(), 404);
        assert!(r.headers().get(header::CONTENT_TYPE).is_none());
        assert_eq!(ok(json!({})).status(), 200);
    }
}
