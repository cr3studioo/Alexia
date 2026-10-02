// SPDX-License-Identifier: AGPL-3.0-only

//! The interaction side: a loopback HTTP request, carried to a paired computer and back.
//!
//! `ANY /bridge/{endpointId}/{path…}` is `{path…}` on that computer's compute service, so the
//! provider client core already has can be pointed at `http://127.0.0.1:{port}/bridge/{id}/v1`
//! with the per-launch secret as its API key, and its SSE parser reads the answer as it would
//! read any other. Each request is a stream of its own.

use std::sync::Arc;

use http_body_util::BodyExt;
use hyper::body::{Body as _, Incoming};
use hyper::{Request, Response, StatusCode};
use iroh::endpoint::{Connection, ConnectionError};
use iroh::EndpointId;
use tokio::task::JoinSet;

use crate::constants::{CLOSE_NOT_PAIRED, CLOSE_REVOKED, REQUEST_HEADERS, RESPONSE_HEADERS};
use crate::error::{self, ApiError, PEER_NOT_ALLOWED, PEER_REJECTED, PEER_UNREACHABLE, STREAM_FAILED};
use crate::wire::{self, Answer, Ask, Outbound};
use crate::{http, transport, Node};

pub async fn handle(node: &Arc<Node>, peer: EndpointId, path: String, request: Request<Incoming>) -> Result<Response<http::Body>, ApiError> {
    // A paired endpoint and nobody else: the bridge is not a way to dial an arbitrary id.
    if !node.peers.allowed(&peer) {
        return Err(ApiError::new(PEER_NOT_ALLOWED, "not a paired computer"));
    }
    let connection = transport::connection(node, peer).await?;
    // Waits here when the peer already has as many streams as it allows: the next job starts
    // when one ends, rather than queueing bytes for it.
    let (send, mut recv) = connection.open_bi().await.map_err(|_| lost(&connection))?;
    let mut out = Outbound::new(send);

    let (parts, body) = request.into_parts();
    let headers = parts.headers.iter().map(|(name, value)| (name.as_str(), value.as_bytes()));
    let ask = Ask {
        method: parts.method.as_str().to_owned(),
        path,
        headers: wire::carried(headers, REQUEST_HEADERS),
        body: !body.is_end_stream(),
    };
    out.write(wire::head(&ask)).await.map_err(|_| lost(&connection))?;

    // The upload runs beside the answer, and is aborted with it: if the caller hangs up, both
    // halves are dropped, the stream is reset, and the job is cancelled on the other computer.
    let mut upload = JoinSet::new();
    upload.spawn(send_body(out, body));

    match wire::read_head(&mut recv).await {
        None => Err(lost(&connection)),
        Some(Answer::Refused { error }) => {
            Err(ApiError::new(error::from_wire(&error.code), "the other computer refused the request"))
        }
        Some(Answer::Response { status, headers }) => {
            let mut response = Response::builder().status(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY));
            let headers = headers.iter().map(|(name, value)| (name.as_str(), value.as_bytes()));
            for (name, value) in wire::carried(headers, RESPONSE_HEADERS) {
                response = response.header(name, value);
            }
            response
                .body(http::pulled(http::rest(recv, upload)))
                .map_err(|_| ApiError::new(STREAM_FAILED, "the other computer sent a response that is not one"))
        }
    }
}

async fn send_body(mut out: Outbound, mut body: Incoming) {
    while let Some(frame) = body.frame().await {
        // An error is the caller gone. Returning drops `out`, which resets the stream.
        let Ok(frame) = frame else { return };
        if let Ok(data) = frame.into_data() {
            if out.write(data).await.is_err() {
                return;
            }
        }
    }
    out.finish();
}

/// Why a stream that should have worked did not, from what became of its connection.
fn lost(connection: &Connection) -> ApiError {
    match connection.close_reason() {
        Some(ConnectionError::ApplicationClosed(close))
            if [CLOSE_NOT_PAIRED, CLOSE_REVOKED].map(u64::from).contains(&close.error_code.into_inner()) =>
        {
            ApiError::new(PEER_REJECTED, "the other computer does not accept this one")
        }
        Some(_) => ApiError::new(PEER_UNREACHABLE, "the connection to the other computer was lost"),
        None => ApiError::new(STREAM_FAILED, "the other computer ended the request"),
    }
}
