// SPDX-License-Identifier: AGPL-3.0-only
//! The hub operations a limb calls on the mesh: kill, presence and face.
//!
//! Each is one small `POST` through connect's bridge to the hub's host service (link.rs holds
//! it). Who sent it is connect's `x-alexia-peer`, never anything in the body.

use std::sync::Arc;
use std::time::Duration;

use http_body_util::{BodyExt, Limited};
use hyper::body::Incoming;
use hyper::{Response, StatusCode};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::link::{self, answer, Out};
use crate::node::Node;
use crate::{DeviceId, Error, Result, OP_FACE, OP_KILL, OP_PRESENCE};

/// The longest an operation's body may be.
const BODY_MAX: usize = 64 * 1024;
/// The longest `face.text`, in chars.
const FACE_TEXT_MAX: usize = 4096;
/// How long a limb waits for its hub to take an operation.
const SEND_TIMEOUT: Duration = Duration::from_secs(5);

/// Something a limb tells its hub. `from` is the limb, as the hub knows it; when sending, it is
/// ignored (the hub learns it from connect).
#[derive(Clone, Debug, PartialEq)]
pub enum HubOp {
    Kill {
        from: DeviceId,
    },
    Presence {
        from: DeviceId,
        idle_ms: u64,
        locked: bool,
    },
    Face {
        from: DeviceId,
        text: String,
        reply_to: Option<String>,
        data: Option<String>,
    },
}

#[derive(Deserialize)]
struct Kill {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Presence {
    idle_ms: u64,
    locked: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Face {
    text: String,
    #[serde(default)]
    reply_to: Option<String>,
    #[serde(default)]
    data: Option<String>,
}

impl HubOp {
    /// The operation's path and its JSON body.
    fn wire(&self) -> (&'static str, Value) {
        match self {
            HubOp::Kill { .. } => (OP_KILL, json!({})),
            HubOp::Presence {
                idle_ms, locked, ..
            } => (OP_PRESENCE, json!({ "idleMs": idle_ms, "locked": locked })),
            HubOp::Face {
                text,
                reply_to,
                data,
                ..
            } => {
                let mut body = json!({ "text": text });
                if let Some(r) = reply_to {
                    body["replyTo"] = json!(r);
                }
                if let Some(d) = data {
                    body["data"] = json!(d);
                }
                (OP_FACE, body)
            }
        }
    }

    /// The operation at `path` with body `body`, from `from`; None if the body is not one.
    fn parse(from: DeviceId, path: &str, body: &[u8]) -> Option<HubOp> {
        Some(match path {
            OP_KILL => {
                serde_json::from_slice::<Kill>(body).ok()?;
                HubOp::Kill { from }
            }
            OP_PRESENCE => {
                let p: Presence = serde_json::from_slice(body).ok()?;
                HubOp::Presence {
                    from,
                    idle_ms: p.idle_ms,
                    locked: p.locked,
                }
            }
            OP_FACE => {
                let f: Face = serde_json::from_slice(body).ok()?;
                if f.text.chars().count() > FACE_TEXT_MAX {
                    return None;
                }
                HubOp::Face {
                    from,
                    text: f.text,
                    reply_to: f.reply_to,
                    data: f.data,
                }
            }
            _ => return None,
        })
    }
}

impl Node {
    /// Hub: register the three hub operations with connect and deliver each request to `on_op`.
    pub async fn serve_ops(
        self: &Arc<Self>,
        on_op: impl Fn(HubOp) + Send + Sync + 'static,
    ) -> Result<()> {
        link::install_ops(self, Arc::new(on_op)).await
    }

    /// Limb: send one operation to its hub. Err(Unreachable) if the hub cannot be reached in 5 s.
    pub async fn send_op(&self, hub: &DeviceId, op: &HubOp) -> Result<()> {
        let row = self
            .store()
            .device(&hub.0)?
            .filter(|d| d.revoked_at.is_none())
            .ok_or(Error::NotPaired)?;
        let (path, body) = op.wire();
        let (base, secret) = self.loopback();
        let res = reqwest::Client::builder()
            .no_proxy()
            .build()
            .map_err(|e| Error::Connect(format!("the HTTP client could not be made ({e}).")))?
            .post(format!("{base}/bridge/{}{path}", row.endpoint))
            .bearer_auth(secret)
            .json(&body)
            .timeout(SEND_TIMEOUT)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() || e.is_connect() {
                    Error::Unreachable
                } else {
                    Error::Connect(format!("connect did not answer ({}).", e.without_url()))
                }
            })?;
        if res.status().is_success() {
            return Ok(());
        }
        let code = res
            .headers()
            .get("x-alexia-connect-error")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        Err(link::refusal(res.status(), code.as_deref()))
    }
}

/// The host service's side of one operation from `from` at `path`.
pub(crate) async fn serve(
    from: DeviceId,
    path: &str,
    body: Incoming,
    on_op: &(dyn Fn(HubOp) + Send + Sync),
) -> Response<Out> {
    let body = match Limited::new(body, BODY_MAX).collect().await {
        Ok(b) => b.to_bytes(),
        Err(e) if e.is::<http_body_util::LengthLimitError>() => {
            return answer(StatusCode::PAYLOAD_TOO_LARGE, r#"{"error":"too large"}"#);
        }
        Err(_) => return answer(StatusCode::BAD_REQUEST, r#"{"error":"broken body"}"#),
    };
    match HubOp::parse(from, path, &body) {
        Some(op) => {
            on_op(op);
            answer(StatusCode::OK, "{}")
        }
        None => answer(StatusCode::BAD_REQUEST, r#"{"error":"bad body"}"#),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ops_round_trip_their_wire_form() {
        let from = DeviceId("l".into());
        for op in [
            HubOp::Kill { from: from.clone() },
            HubOp::Presence {
                from: from.clone(),
                idle_ms: 42,
                locked: true,
            },
            HubOp::Face {
                from: from.clone(),
                text: "hi".into(),
                reply_to: Some("m1".into()),
                data: None,
            },
        ] {
            let (path, body) = op.wire();
            let parsed = HubOp::parse(from.clone(), path, body.to_string().as_bytes());
            assert_eq!(parsed, Some(op));
        }
        let long = json!({ "text": "x".repeat(FACE_TEXT_MAX + 1) }).to_string();
        assert_eq!(HubOp::parse(from.clone(), OP_FACE, long.as_bytes()), None);
        assert_eq!(HubOp::parse(from, OP_PRESENCE, br#"{"idleMs":"x"}"#), None);
    }
}
