// SPDX-License-Identifier: AGPL-3.0-only

//! The loopback API: how core tells this process who is paired and what may be forwarded, and
//! how it reaches a paired computer. Documented, request by request, in `README.md`.
//!
//! The port is reachable by every process on the machine, so **every** request carries the
//! per-launch secret, and one that does not is refused before its path is looked at.

use std::collections::BTreeSet;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;

use bytes::Bytes;
use futures_util::stream;
use http_body_util::{BodyExt, LengthLimitError, Limited};
use hyper::body::Incoming;
use hyper::header::{HeaderMap, HeaderValue, AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use iroh::address_lookup::{EndpointData, EndpointInfo};
use iroh::{EndpointId, RelayUrl, TransportAddr};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::broadcast::error::RecvError;
use tokio::task::JoinSet;
use tokio::time::timeout;
use url::Url;

use crate::constants::{
    ALLOWLIST_MAX, CONTROL_BODY_MAX, CONTROL_CONNECTIONS_MAX, EVENTS_KEEPALIVE, HEADER_TIMEOUT, HINT_ADDRESSES_MAX,
    PATH_MAX, PROTOCOL,
};
use crate::error::{ApiError, BAD_REQUEST, NOT_FOUND, PAYLOAD_TOO_LARGE, PEER_NOT_ALLOWED, UNAUTHORIZED};
use crate::host::{Host, Registration};
use crate::pairing::{self, Settings, State};
use crate::http::{self, Body};
use crate::transport::{self, Network};
use crate::{bridge, Node};

type Answer = Result<Response<Body>, ApiError>;

pub async fn serve(node: Arc<Node>, listener: TcpListener) {
    // Owned here, so that stopping this task stops every connection it accepted.
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept(), if connections.len() < CONTROL_CONNECTIONS_MAX => {
                let Ok((stream, _)) = accepted else { continue };
                let node = node.clone();
                connections.spawn(async move {
                    let service = service_fn(move |request| answer(node.clone(), request));
                    // A client that connects and dribbles its headers holds one of a bounded
                    // number of connections, for ten seconds.
                    let _ = http1::Builder::new()
                        .timer(TokioTimer::new())
                        .header_read_timeout(HEADER_TIMEOUT)
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
            Some(_) = connections.join_next() => {}
        }
    }
}

async fn answer(node: Arc<Node>, request: Request<Incoming>) -> Result<Response<Body>, Infallible> {
    Ok(route(&node, request).await.unwrap_or_else(|error| http::refuse(&error)))
}

async fn route(node: &Arc<Node>, request: Request<Incoming>) -> Answer {
    authorize(&node.secret, request.headers())?;
    let target = request.uri().path_and_query().map(|target| target.as_str().to_owned()).unwrap_or_default();
    let path = request.uri().path().to_owned();
    let segments: Vec<&str> = path.split('/').skip(1).collect();
    match (request.method(), segments.as_slice()) {
        (_, ["bridge", peer, ..]) => {
            // What follows the id goes to the other computer exactly as it was written.
            let rest = &target["/bridge/".len() + peer.len()..];
            if rest.len() > PATH_MAX {
                return Err(ApiError::new(BAD_REQUEST, "the path is too long"));
            }
            let rest = if rest.is_empty() || rest.starts_with('?') { format!("/{rest}") } else { rest.to_owned() };
            bridge::handle(node, endpoint_id(peer)?, rest, request).await
        }
        (&Method::GET, ["v1", "status"]) => Ok(status(node)),
        (&Method::GET, ["v1", "peers"]) => Ok(http::json(StatusCode::OK, &json!({ "peers": node.peers.list() }))),
        (&Method::GET, ["v1", "events"]) => Ok(events(node)),
        (&Method::PUT, ["v1", "allowlist"]) => allow(node, body(request).await?),
        (&Method::DELETE, ["v1", "allowlist", peer]) => {
            let peer = endpoint_id(peer)?;
            let revoked = node.peers.revoke(&peer);
            node.hints.remove_endpoint_info(peer);
            Ok(http::json(StatusCode::OK, &json!({ "revoked": revoked })))
        }
        (&Method::PUT, ["v1", "host"]) => {
            let host = Host::new(body::<Registration>(request).await?)?;
            tracing::info!(operations = host.operations.len(), "host service registered");
            node.set_host(Some(host));
            Ok(status(node))
        }
        (&Method::DELETE, ["v1", "host"]) => {
            node.set_host(None);
            Ok(status(node))
        }
        (&Method::PUT, ["v1", "peers", peer, "hints"]) => hint(node, endpoint_id(peer)?, body(request).await?),
        (&Method::POST, ["v1", "peers", peer, "connect"]) => {
            let peer = endpoint_id(peer)?;
            transport::connection(node, peer).await?;
            let listed = node.peers.list().into_iter().find(|listed| listed.endpoint_id == peer.to_string());
            Ok(http::json(StatusCode::OK, &listed))
        }
        (&Method::PUT, ["v1", "network"]) => {
            let Services { relay_urls, lookup_url } = body(request).await?;
            let network = Network::new(&relay_urls, lookup_url.as_deref()).map_err(|message| ApiError::new(BAD_REQUEST, message))?;
            node.rebind(network).await?;
            Ok(status(node))
        }
        (&Method::GET, ["v1", "pairing"]) => Ok(mailbox(node, json!({ "pairings": node.pairing.list() }))),
        (&Method::PUT, ["v1", "pairing", "mailbox"]) => {
            // `url` has to be there, and be a URL or `null`: leaving it out is not a way to
            // turn pairing off by accident.
            let url = match body::<Mailbox>(request).await?.url {
                serde_json::Value::Null => None,
                serde_json::Value::String(url) => Some(Settings::mailbox(&url).map_err(|message| ApiError::new(BAD_REQUEST, message))?),
                _ => return Err(ApiError::new(BAD_REQUEST, "not a mailbox URL")),
            };
            node.pairing.set_mailbox(url);
            Ok(mailbox(node, json!({})))
        }
        (&Method::POST, ["v1", "pairing", "host"]) => {
            Ok(http::json(StatusCode::OK, &pairing::host(node, body(request).await?).await?))
        }
        (&Method::POST, ["v1", "pairing", "join"]) => Ok(http::json(StatusCode::OK, &pairing::join(node, body(request).await?)?)),
        (&Method::GET, ["v1", "pairing", id]) => {
            let unknown = || ApiError::new(NOT_FOUND, "no such pairing");
            let (meta, mut state) = node.pairing.watch(id).ok_or_else(unknown)?;
            if request.uri().query().is_some_and(|query| query.split('&').any(|pair| pair == "wait=true")) {
                // Bounded by the pairing itself: a host's settles by its expiry, a join's sooner.
                let _ = state.wait_for(|state| !matches!(state, State::Waiting)).await;
            }
            let said = pairing::view(&meta, &state.borrow());
            Ok(http::json(StatusCode::OK, &said))
        }
        (&Method::DELETE, ["v1", "pairing", id]) => {
            let cancelled = node.pairing.cancel(id).ok_or_else(|| ApiError::new(NOT_FOUND, "no such pairing"))?;
            Ok(http::json(StatusCode::OK, &json!({ "cancelled": cancelled })))
        }
        (&Method::POST, ["v1", "shutdown"]) => {
            node.stop.notify_one();
            Ok(http::json(StatusCode::OK, &json!({ "ok": true })))
        }
        _ => Err(ApiError::new(NOT_FOUND, "not something this API has")),
    }
}

/// `Authorization: Bearer <secret>`, compared in a time that does not depend on where two
/// secrets first differ.
fn authorize(secret: &str, headers: &HeaderMap) -> Result<(), ApiError> {
    let sent = headers.get(AUTHORIZATION).and_then(|value| value.as_bytes().strip_prefix(b"Bearer "));
    match sent {
        Some(sent) if same(sent, secret.as_bytes()) => Ok(()),
        _ => Err(ApiError::new(UNAUTHORIZED, "refused")),
    }
}

fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |differ, (x, y)| differ | (x ^ y)) == 0
}

/// An endpoint id as this API writes it: 64 lowercase hex digits, and no other spelling.
fn endpoint_id(text: &str) -> Result<EndpointId, ApiError> {
    let hex = text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    text.parse().ok().filter(|_| hex).ok_or_else(|| ApiError::new(BAD_REQUEST, "not an endpoint id"))
}

async fn body<T: DeserializeOwned>(request: Request<Incoming>) -> Result<T, ApiError> {
    let bytes = Limited::new(request.into_body(), CONTROL_BODY_MAX)
        .collect()
        .await
        .map_err(|error| match error.is::<LengthLimitError>() {
            true => ApiError::new(PAYLOAD_TOO_LARGE, "the request body is too large"),
            false => ApiError::new(BAD_REQUEST, "the request body did not arrive"),
        })?
        .to_bytes();
    // Not serde's own message: it quotes what it was given, and a body here may hold a secret.
    serde_json::from_slice(&bytes).map_err(|_| ApiError::new(BAD_REQUEST, "not the JSON this request takes"))
}

fn status(node: &Node) -> Response<Body> {
    let endpoint = node.endpoint();
    let address = endpoint.addr();
    let network = node.network();
    let host = node.host();
    http::json(
        StatusCode::OK,
        &json!({
            "protocol": PROTOCOL,
            "version": env!("CARGO_PKG_VERSION"),
            "endpointId": endpoint.id().to_string(),
            "relayUrl": address.relay_urls().next().map(|url| url.to_string()),
            "directAddresses": address.ip_addrs().map(|address| address.to_string()).collect::<Vec<_>>(),
            "boundAddresses": endpoint.bound_sockets().iter().map(SocketAddr::to_string).collect::<Vec<_>>(),
            "network": {
                "relayUrls": network.relay_urls.iter().map(|url| url.to_string()).collect::<Vec<_>>(),
                "lookupUrl": network.lookup_url.as_ref().map(Url::to_string),
            },
            // The port and the operations. The host service's secret is not said back.
            "host": host.map(|host| json!({ "port": host.port, "operations": host.operations })),
            "allowlist": node.peers.list().into_iter().map(|peer| peer.endpoint_id).collect::<Vec<_>>(),
        }),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Mailbox {
    url: serde_json::Value,
}

/// The mailbox server in use, said beside whatever else the answer holds.
fn mailbox(node: &Node, mut said: serde_json::Value) -> Response<Body> {
    said["mailboxUrl"] = json!(node.pairing.mailbox().as_ref().map(Url::to_string));
    http::json(StatusCode::OK, &said)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Allowlist {
    endpoint_ids: Vec<String>,
}

fn allow(node: &Node, allowlist: Allowlist) -> Answer {
    if allowlist.endpoint_ids.len() > ALLOWLIST_MAX {
        return Err(ApiError::new(BAD_REQUEST, "too many endpoints"));
    }
    let allowed: BTreeSet<EndpointId> = allowlist.endpoint_ids.iter().map(|id| endpoint_id(id)).collect::<Result<_, _>>()?;
    let revoked = node.peers.replace(allowed);
    for peer in &revoked {
        node.hints.remove_endpoint_info(*peer);
    }
    let said = |peers: Vec<EndpointId>| peers.iter().map(EndpointId::to_string).collect::<Vec<_>>();
    let allowed = node.peers.list().into_iter().map(|peer| peer.endpoint_id).collect::<Vec<_>>();
    Ok(http::json(StatusCode::OK, &json!({ "endpointIds": allowed, "revoked": said(revoked) })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Hints {
    #[serde(default)]
    relay_url: Option<String>,
    #[serde(default)]
    direct_addresses: Vec<String>,
}

/// Where to look for a paired endpoint: what pairing exchanged, what was last seen, what LAN
/// discovery turned up. **A hint is never authorization** — it is only kept for an endpoint
/// already on the allowlist, and whatever answers at a hinted address still has to prove it
/// holds that endpoint's key.
fn hint(node: &Node, peer: EndpointId, hints: Hints) -> Answer {
    if !node.peers.allowed(&peer) {
        return Err(ApiError::new(PEER_NOT_ALLOWED, "not a paired computer"));
    }
    if hints.direct_addresses.len() > HINT_ADDRESSES_MAX {
        return Err(ApiError::new(BAD_REQUEST, "too many addresses"));
    }
    let bad = |what: &str| ApiError::new(BAD_REQUEST, format!("not {what}"));
    let mut addresses = Vec::new();
    if let Some(url) = &hints.relay_url {
        let url: Url = url.parse().map_err(|_| bad("a relay URL"))?;
        addresses.push(TransportAddr::Relay(RelayUrl::from(url)));
    }
    for address in &hints.direct_addresses {
        addresses.push(TransportAddr::Ip(address.parse::<SocketAddr>().map_err(|_| bad("an ip:port address"))?));
    }
    node.hints.set_endpoint_info(EndpointInfo::from_parts(peer, EndpointData::new(addresses)));
    Ok(http::json(StatusCode::OK, &json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Services {
    relay_urls: Vec<String>,
    lookup_url: Option<String>,
}

/// Server-sent events: a `snapshot` of every paired computer, then a `peer` each time one
/// changes. A subscriber that fell too far behind gets a fresh `snapshot` instead of the
/// changes it missed, so what it holds is never silently stale. Beside those, a `pairing` each
/// time one settles; those are not in a snapshot, and one that was missed is asked for by id.
fn events(node: &Node) -> Response<Body> {
    let peers = node.peers.clone();
    let (snapshot, changes) = peers.subscribe();
    let settled = node.pairing.subscribe();
    let pieces = stream::unfold((Some(snapshot), changes, settled), move |(snapshot, mut changes, mut settled)| {
        let peers = peers.clone();
        async move {
            if let Some(snapshot) = snapshot {
                return Some((Ok(event("snapshot", &json!({ "peers": snapshot }))), (None, changes, settled)));
            }
            let next = async {
                loop {
                    tokio::select! {
                        change = changes.recv() => break change.map(|peer| event("peer", &json!(peer))),
                        pairing = settled.recv() => match pairing {
                            Ok(pairing) => break Ok(event("pairing", &pairing)),
                            Err(RecvError::Lagged(_)) => {}
                            Err(RecvError::Closed) => break Err(RecvError::Closed),
                        },
                    }
                }
            };
            let piece = match timeout(EVENTS_KEEPALIVE, next).await {
                Err(_) => Bytes::from_static(b": keepalive\n\n"),
                Ok(Ok(piece)) => piece,
                Ok(Err(RecvError::Lagged(_))) => {
                    let (snapshot, fresh) = peers.subscribe();
                    changes = fresh;
                    event("snapshot", &json!({ "peers": snapshot }))
                }
                Ok(Err(RecvError::Closed)) => return None,
            };
            Some((Ok(piece), (None, changes, settled)))
        }
    });
    let mut response = Response::new(http::pulled(pieces));
    response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    response.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn event(name: &str, data: &serde_json::Value) -> Bytes {
    format!("event: {name}\ndata: {data}\n\n").into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_secret_opens_the_door() {
        let with = |value: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(AUTHORIZATION, HeaderValue::from_str(value).unwrap());
            headers
        };
        assert!(authorize("s3cret", &with("Bearer s3cret")).is_ok());
        assert!(authorize("s3cret", &with("Bearer s3cre")).is_err());
        assert!(authorize("s3cret", &with("Bearer s3cret ")).is_err());
        assert!(authorize("s3cret", &with("bearer s3cret")).is_err());
        assert!(authorize("s3cret", &with("s3cret")).is_err());
        assert!(authorize("s3cret", &HeaderMap::new()).is_err());
    }

    #[test]
    fn an_endpoint_id_has_one_spelling() {
        let id = iroh::SecretKey::generate().public().to_string();
        assert_eq!(endpoint_id(&id).ok().map(|id| id.to_string()), Some(id.clone()));
        assert!(endpoint_id(&id.to_uppercase()).is_err());
        assert!(endpoint_id(&id[..63]).is_err());
        assert!(endpoint_id("").is_err());
    }
}
