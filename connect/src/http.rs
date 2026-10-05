// SPDX-License-Identifier: AGPL-3.0-only

//! The few shapes of HTTP body this crate uses, on both loopback sides.

use bytes::Bytes;
use futures_util::stream::{self, Stream};
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Empty, Full, StreamBody};
use hyper::body::Frame;
use hyper::header::{HeaderValue, CONTENT_TYPE};
use hyper::{Response, StatusCode};
use iroh::endpoint::RecvStream;
use serde::Serialize;
use serde_json::json;

use crate::constants::{CHUNK_MAX, HEADER_ERROR};
use crate::error::ApiError;

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
pub type Body = UnsyncBoxBody<Bytes, BoxError>;

pub fn empty() -> Body {
    Empty::new().map_err(|never| match never {}).boxed_unsync()
}

pub fn full(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into()).map_err(|never| match never {}).boxed_unsync()
}

/// A body that is pulled, a piece at a time, by whoever is writing it out. Nothing is read from
/// the source until the last piece has gone, which is all backpressure is.
pub fn pulled(pieces: impl Stream<Item = Result<Bytes, BoxError>> + Send + 'static) -> Body {
    use futures_util::StreamExt;
    StreamBody::new(pieces.map(|piece| piece.map(Frame::data))).boxed_unsync()
}

/// The rest of a QUIC stream, as pieces. `held` lives exactly as long as the body does — the
/// task still uploading the other half, or the connection to the host service.
pub fn rest<T: Send + 'static>(stream: RecvStream, held: T) -> impl Stream<Item = Result<Bytes, BoxError>> + Send {
    stream::unfold(Some((stream, held)), |state| async move {
        let (mut stream, held) = state?;
        match stream.read_chunk(CHUNK_MAX).await {
            Ok(Some(bytes)) => Some((Ok(bytes), Some((stream, held)))),
            Ok(None) => None,
            // A reset, or the connection gone. The body ends in an error, not in an end, so
            // whoever is reading it over HTTP sees a broken response and not a short one.
            Err(error) => Some((Err(error.into()), None)),
        }
    })
}

pub fn json(status: StatusCode, value: &impl Serialize) -> Response<Body> {
    let mut response = Response::new(full(serde_json::to_vec(value).unwrap_or_default()));
    *response.status_mut() = status;
    response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

pub fn refuse(error: &ApiError) -> Response<Body> {
    let mut response = json(error.status(), &json!({ "error": { "code": error.code, "message": error.message } }));
    response.headers_mut().insert(HEADER_ERROR, HeaderValue::from_static(error.code));
    response
}
