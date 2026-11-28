// SPDX-License-Identifier: AGPL-3.0-only
//! A client for connect's loopback control API: status, peers, pairing and streams.
//!
//! `connect/README.md` is the contract. Every request carries the per-launch secret as a bearer
//! token; the secret is in a header only, never in a URL, an error or a log line.

use std::time::Duration;

use reqwest::Method;
use serde_json::{json, Value};

use crate::{Error, Result};

/// The longest a control request may take: `connect` dials for up to 15 s before answering.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// The event stream's reconnect backoff: from the first to the last, doubling.
const BACKOFF_FIRST: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(10);

/// connect's loopback API at `base` (`http://127.0.0.1:{port}`).
#[derive(Clone)]
pub(crate) struct Control {
    base: String,
    secret: String,
    http: reqwest::Client,
}

impl Control {
    pub(crate) fn new(base: String, secret: String) -> Result<Control> {
        let http = reqwest::Client::builder()
            // Loopback only: a proxy from the environment must never see the secret.
            .no_proxy()
            .build()
            .map_err(|e| Error::Connect(format!("the HTTP client could not be made ({e}).")))?;
        Ok(Control { base, secret, http })
    }

    /// One request; the JSON body of a `200`, or connect's error as ours.
    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        let mut req = self
            .http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&self.secret)
            .timeout(REQUEST_TIMEOUT);
        if let Some(body) = body {
            req = req.json(&body);
        }
        let res = req.send().await.map_err(|e| {
            Error::Connect(format!("connect did not answer ({}).", e.without_url()))
        })?;
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(body);
        }
        let code = body["error"]["code"].as_str().unwrap_or("unknown");
        Err(match code {
            "peer_not_allowed" => Error::NotPaired,
            "peer_unreachable" => Error::Unreachable,
            _ => Error::Connect(format!("connect answered {status} with code {code}.")),
        })
    }

    pub(crate) async fn status(&self) -> Result<Value> {
        self.call(Method::GET, "/v1/status", None).await
    }

    /// Make connect's allowlist exactly `endpoints`.
    pub(crate) async fn put_allowlist(&self, endpoints: &[String]) -> Result<()> {
        let body = json!({ "endpointIds": endpoints });
        self.call(Method::PUT, "/v1/allowlist", Some(body)).await?;
        Ok(())
    }

    /// Whether `endpoint` was on the allowlist.
    pub(crate) async fn revoke(&self, endpoint: &str) -> Result<bool> {
        let path = format!("/v1/allowlist/{endpoint}");
        let body = self.call(Method::DELETE, &path, None).await?;
        Ok(body["revoked"].as_bool().unwrap_or(false))
    }

    /// Replace the hints for `endpoint`: `{ "relayUrl"?, "directAddresses"? }`.
    pub(crate) async fn put_hints(&self, endpoint: &str, hints: Value) -> Result<()> {
        let path = format!("/v1/peers/{endpoint}/hints");
        self.call(Method::PUT, &path, Some(hints)).await?;
        Ok(())
    }

    /// Connect now; the peer's status string (`direct`, `relayed`, `offline`).
    pub(crate) async fn connect(&self, endpoint: &str) -> Result<String> {
        let path = format!("/v1/peers/{endpoint}/connect");
        let body = self.call(Method::POST, &path, None).await?;
        body["status"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| Error::Connect("connect answered a connect with no status.".into()))
    }

    pub(crate) async fn put_self_addresses(&self, addresses: &[std::net::IpAddr]) -> Result<()> {
        let addresses: Vec<String> = addresses.iter().map(|a| a.to_string()).collect();
        let body = json!({ "addresses": addresses });
        self.call(Method::PUT, "/v1/self/addresses", Some(body))
            .await?;
        Ok(())
    }

    /// Follow `GET /v1/events` forever, calling `on(name, data)` for each event. A dropped or
    /// refused stream is opened again after a backoff; the `snapshot` that starts every stream
    /// is the caller's cue to replace what it knew.
    pub(crate) async fn follow(&self, mut on: impl FnMut(&str, Value)) -> ! {
        let mut backoff = BACKOFF_FIRST;
        loop {
            if self.stream(&mut on, &mut backoff).await.is_err() {
                tracing::debug!("connect's event stream ended; reopening");
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(BACKOFF_MAX);
        }
    }

    /// One event stream, until it ends. `backoff` is reset once it is open.
    async fn stream(
        &self,
        on: &mut impl FnMut(&str, Value),
        backoff: &mut Duration,
    ) -> std::result::Result<(), ()> {
        let mut res = self
            .http
            .get(format!("{}/v1/events", self.base))
            .bearer_auth(&self.secret)
            .send()
            .await
            .map_err(drop)?;
        if !res.status().is_success() {
            return Err(());
        }
        *backoff = BACKOFF_FIRST;
        let mut buf = String::new();
        while let Some(chunk) = res.chunk().await.map_err(drop)? {
            buf.push_str(&String::from_utf8_lossy(&chunk).replace('\r', ""));
            while let Some(end) = buf.find("\n\n") {
                let block: String = buf.drain(..end + 2).collect();
                if let Some((name, data)) = parse_event(&block) {
                    on(&name, data);
                }
            }
        }
        Ok(())
    }
}

/// One SSE block's event name and JSON data; None for a comment or a block without JSON data.
fn parse_event(block: &str) -> Option<(String, Value)> {
    let mut name = "message".to_string();
    let mut data = String::new();
    for line in block.lines() {
        if let Some(v) = line.strip_prefix("event:") {
            name = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(v.strip_prefix(' ').unwrap_or(v));
        }
    }
    Some((name, serde_json::from_str(&data).ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_blocks_parse() {
        let (n, d) = parse_event("event: peer\ndata: {\"status\":\"direct\"}\n\n").unwrap();
        assert_eq!(n, "peer");
        assert_eq!(d["status"], "direct");
        assert!(parse_event(": keepalive\n\n").is_none());
    }
}
