// SPDX-License-Identifier: AGPL-3.0-only

//! What goes down a stream between two computers.
//!
//! One QUIC stream is one request and its answer — one job, or one artifact — and nothing else
//! shares it. Each direction is a **head** and then a **body**:
//!
//! ```text
//! head length, u32 big-endian | head, JSON | body bytes … until the stream is finished
//! ```
//!
//! The body has no framing of its own: the stream's end is the body's end, and a stream that is
//! *reset* instead of finished is a body that was cancelled. That is the whole of cancellation.

use bytes::Bytes;
use iroh::endpoint::{RecvStream, SendStream, WriteError};
use serde::{Deserialize, Serialize};

use crate::constants::{HEADER_PEER, HEADER_PREFIX, HEAD_MAX, RESET_CANCELLED};

/// What is being asked for. `path` carries its query.
#[derive(Debug, Serialize, Deserialize)]
pub struct Ask {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    /// False when there is nothing to send, so the host service is not handed an empty
    /// chunked body on a GET.
    pub body: bool,
}

/// What came back: the host service's answer, or this process's refusal.
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Answer {
    Response { status: u16, headers: Vec<(String, String)> },
    Refused { error: Refusal },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Refusal {
    pub code: String,
    pub message: String,
}

pub fn head<T: Serialize>(head: &T) -> Bytes {
    let json = serde_json::to_vec(head).unwrap_or_default();
    let mut framed = Vec::with_capacity(4 + json.len());
    framed.extend_from_slice(&(json.len() as u32).to_be_bytes());
    framed.extend_from_slice(&json);
    framed.into()
}

/// The head off a stream. `None` for one that is too long, cut short or not a head.
pub async fn read_head<T: for<'de> Deserialize<'de>>(stream: &mut RecvStream) -> Option<T> {
    let mut length = [0u8; 4];
    stream.read_exact(&mut length).await.ok()?;
    let length = u32::from_be_bytes(length) as usize;
    if length > HEAD_MAX {
        return None;
    }
    let mut json = vec![0u8; length];
    stream.read_exact(&mut json).await.ok()?;
    serde_json::from_slice(&json).ok()
}

/// The headers that cross, out of the ones that were sent. See `constants::REQUEST_HEADERS`.
pub fn carried<'a>(
    headers: impl Iterator<Item = (&'a str, &'a [u8])>,
    named: &[&str],
) -> Vec<(String, String)> {
    headers
        .filter(|(name, _)| *name != HEADER_PEER && (named.contains(name) || name.starts_with(HEADER_PREFIX)))
        .filter_map(|(name, value)| Some((name.to_owned(), std::str::from_utf8(value).ok()?.to_owned())))
        .collect()
}

/// The sending half of a stream, which is **reset** if it is dropped before it is finished.
///
/// A bare `SendStream` finishes itself when dropped, so a job abandoned half-way would look, to
/// the other computer, like one that ended cleanly. Everything that can abandon a job — the
/// caller hanging up, the host service failing, the peer being revoked — does it by dropping
/// this, and the other side sees a reset.
pub struct Outbound(Option<SendStream>);

impl Outbound {
    pub fn new(stream: SendStream) -> Self {
        Self(Some(stream))
    }

    /// Returns when the bytes are accepted by QUIC's flow control — which is where a slow
    /// reader on the other computer becomes a wait on this one.
    pub async fn write(&mut self, bytes: Bytes) -> Result<(), WriteError> {
        match &mut self.0 {
            Some(stream) => stream.write_chunk(bytes).await,
            None => Err(WriteError::ClosedStream),
        }
    }

    pub fn finish(mut self) {
        if let Some(mut stream) = self.0.take() {
            let _ = stream.finish();
        }
    }

    /// Resolves when the other side stops reading, or the connection goes.
    pub fn stopped(&self) -> impl std::future::Future<Output = ()> + Send + 'static {
        let stopped = self.0.as_ref().map(SendStream::stopped);
        async move {
            match stopped {
                Some(stopped) => drop(stopped.await),
                None => std::future::pending().await,
            }
        }
    }
}

impl Drop for Outbound {
    fn drop(&mut self) {
        if let Some(mut stream) = self.0.take() {
            let _ = stream.reset(RESET_CANCELLED.into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::REQUEST_HEADERS;

    #[test]
    fn only_named_headers_cross() {
        let sent: Vec<(&str, &[u8])> = vec![
            ("authorization", b"Bearer the-secret"),
            ("content-type", b"application/json"),
            ("cookie", b"a=b"),
            ("x-alexia-job", b"7"),
            ("x-alexia-peer", b"somebody-else"),
        ];
        let crossed = carried(sent.into_iter(), REQUEST_HEADERS);
        assert_eq!(
            crossed,
            vec![
                ("content-type".to_owned(), "application/json".to_owned()),
                ("x-alexia-job".to_owned(), "7".to_owned()),
            ]
        );
    }

    #[test]
    fn a_refusal_and_a_response_are_told_apart() {
        let refused: Answer = serde_json::from_str(r#"{"error":{"code":"bad_request","message":"no"}}"#).unwrap();
        assert!(matches!(refused, Answer::Refused { .. }));
        let response: Answer = serde_json::from_str(r#"{"status":200,"headers":[["content-type","text/plain"]]}"#).unwrap();
        assert!(matches!(response, Answer::Response { status: 200, .. }));
    }
}
