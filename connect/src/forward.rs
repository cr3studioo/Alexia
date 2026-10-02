// SPDX-License-Identifier: AGPL-3.0-only

//! The compute side: one stream from a paired computer, forwarded to the host service.
//!
//! The order is the point. The endpoint is checked against the allowlist, then the request
//! against the registered operations, and only then is a connection to the host service opened.
//! A request that fails either check has touched nothing on this computer.

use std::net::Ipv4Addr;
use std::sync::Arc;

use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::header::{AUTHORIZATION, CONTENT_LENGTH, HOST};
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use iroh::endpoint::{RecvStream, SendStream};
use iroh::EndpointId;
use tokio::net::TcpStream;
use tokio::task::JoinSet;
use tokio::time::timeout;

use crate::constants::{HEADER_PEER, HEAD_TIMEOUT, HOST_CONNECT_TIMEOUT, REQUEST_HEADERS, RESPONSE_HEADERS};
use crate::error::{BAD_REQUEST, HOST_UNAVAILABLE, OPERATION_NOT_REGISTERED, PEER_NOT_ALLOWED};
use crate::host::Host;
use crate::wire::{self, Answer, Ask, Outbound, Refusal};
use crate::{http, Node};

/// The job is over when this returns, however it returns. Finished cleanly, the stream is
/// finished; anything else and it is reset, and the connection to the host service is dropped,
/// which is how the host service learns its caller has gone.
pub async fn serve(node: Arc<Node>, peer: EndpointId, send: SendStream, recv: RecvStream) {
    let mut out = Outbound::new(send);
    // The other side stops reading — its caller hung up — or the connection is closed under
    // us by a revocation. Either way there is nobody to answer, even if the host service has
    // not said a word yet.
    let stopped = out.stopped();
    let finished = {
        let answering = answer(&node, peer, &mut out, recv);
        tokio::pin!(stopped, answering);
        tokio::select! {
            () = &mut stopped => false,
            finished = &mut answering => finished.is_some(),
        }
    };
    if finished {
        out.finish();
    }
}

async fn answer(node: &Node, peer: EndpointId, out: &mut Outbound, mut recv: RecvStream) -> Option<()> {
    let ask: Ask = timeout(HEAD_TIMEOUT, wire::read_head(&mut recv)).await.ok()??;

    // The handshake already refused an endpoint that is not paired. This is for the one that
    // was, a moment ago.
    if !node.peers.allowed(&peer) {
        return refuse(out, PEER_NOT_ALLOWED, "this computer is not paired with that one").await;
    }
    let Some(host) = node.host() else {
        return refuse(out, HOST_UNAVAILABLE, "no compute service is running here").await;
    };
    let Some(operation) = host.operation(&ask.method, &ask.path) else {
        tracing::warn!(peer = %peer.fmt_short(), "refused an operation that is not registered");
        return refuse(out, OPERATION_NOT_REGISTERED, "not an operation this computer offers").await;
    };
    let name = operation.name.clone();

    let Ok(request) = request(&host, peer, &ask, recv) else {
        return refuse(out, BAD_REQUEST, "not a request the compute service can be sent").await;
    };
    let Some((response, _connection)) = send(&host, request).await else {
        tracing::warn!(operation = %name, "the compute service did not answer");
        return refuse(out, HOST_UNAVAILABLE, "the compute service did not answer").await;
    };

    let (parts, mut body) = response.into_parts();
    let headers = parts.headers.iter().map(|(name, value)| (name.as_str(), value.as_bytes()));
    let head = Answer::Response { status: parts.status.as_u16(), headers: wire::carried(headers, RESPONSE_HEADERS) };
    out.write(wire::head(&head)).await.ok()?;
    // One piece at a time: the next is not taken from the host service until QUIC has room for
    // this one, so a reader that slows down on the other computer slows the service down here.
    while let Some(frame) = body.frame().await {
        if let Ok(data) = frame.ok()?.into_data() {
            out.write(data).await.ok()?;
        }
    }
    tracing::debug!(operation = %name, status = parts.status.as_u16(), "forwarded");
    Some(())
}

async fn refuse(out: &mut Outbound, code: &str, message: &str) -> Option<()> {
    let refusal = Answer::Refused { error: Refusal { code: code.to_owned(), message: message.to_owned() } };
    out.write(wire::head(&refusal)).await.ok()
}

fn request(host: &Host, peer: EndpointId, ask: &Ask, recv: RecvStream) -> Result<Request<http::Body>, hyper::http::Error> {
    let mut request = Request::builder()
        .method(ask.method.as_str())
        .uri(ask.path.as_str())
        .header(HOST, format!("{}:{}", Ipv4Addr::LOCALHOST, host.port));
    // Filtered here as well as where it was sent: what the other computer's process chose to
    // put on the wire is not a reason to pass it on.
    let asked = ask.headers.iter().map(|(name, value)| (name.as_str(), value.as_bytes()));
    for (name, value) in wire::carried(asked, REQUEST_HEADERS) {
        if ask.body || name != CONTENT_LENGTH.as_str() {
            request = request.header(name, value);
        }
    }
    request = request.header(HEADER_PEER, peer.to_string());
    if let Some(secret) = &host.secret {
        request = request.header(AUTHORIZATION, format!("Bearer {secret}"));
    }
    request.body(if ask.body { http::pulled(http::rest(recv, ())) } else { http::empty() })
}

/// A connection of its own for every job, so that dropping the job is closing the connection.
/// The `JoinSet` is that connection: it is aborted when dropped.
async fn send(host: &Host, request: Request<http::Body>) -> Option<(Response<Incoming>, JoinSet<()>)> {
    let address = (Ipv4Addr::LOCALHOST, host.port);
    let tcp = timeout(HOST_CONNECT_TIMEOUT, TcpStream::connect(address)).await.ok()?.ok()?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(tcp)).await.ok()?;
    let mut held = JoinSet::new();
    held.spawn(async move {
        let _ = connection.await;
    });
    let response = sender.send_request(request).await.ok()?;
    Some((response, held))
}
