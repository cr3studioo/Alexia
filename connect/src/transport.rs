// SPDX-License-Identifier: AGPL-3.0-only

//! The iroh endpoint: one identity, connections to and from paired computers, and nothing that
//! decides what those connections are for.
//!
//! Connections are end-to-end encrypted to the endpoint id whether they run directly or through
//! a relay; a relay sees who is talking to whom and how much, never what. iroh tries a direct
//! path first and keeps the relay as the way through when there is none.

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddrV4, SocketAddrV6};
use std::sync::Arc;

use futures_util::StreamExt;
use iroh::address_lookup::{MemoryLookup, PkarrPublisher, PkarrResolver};
use iroh::endpoint::{presets, AfterHandshakeOutcome, BindOpts, Connection, EndpointHooks, QuicTransportConfig};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, SecretKey};
use tokio::time::timeout;
use url::Url;

use crate::constants::{
    ALPN, CLOSE_NOT_PAIRED, CONNECTION_WINDOW, DEFAULT_LOOKUP_URL, DEFAULT_RELAY_URLS, DIAL_TIMEOUT, ENV_LOOKUP_URL,
    ENV_RELAY_URLS, IDLE_TIMEOUT, SEND_WINDOW, STREAMS_MAX, STREAM_WINDOW,
};
use crate::error::{ApiError, PEER_NOT_ALLOWED, PEER_UNREACHABLE};
use crate::pairing::{self, Pairings};
use crate::peers::Peers;
use crate::{forward, Node};

/// The services a connection may lean on. Both are optional, and neither is ever trusted with
/// anything but ciphertext and public ids.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Network {
    pub relay_urls: Vec<RelayUrl>,
    pub lookup_url: Option<Url>,
}

impl Network {
    pub fn new<S: AsRef<str>>(relay_urls: &[S], lookup_url: Option<&str>) -> Result<Self, String> {
        let web = |text: &str| match Url::parse(text) {
            Ok(url) if ["https", "http"].contains(&url.scheme()) && url.host().is_some() => Ok(url),
            _ => Err(format!("not an http(s) URL: {text}")),
        };
        let relay_urls = relay_urls.iter().map(|url| web(url.as_ref()).map(RelayUrl::from)).collect::<Result<_, _>>()?;
        Ok(Self { relay_urls, lookup_url: lookup_url.map(web).transpose()? })
    }

    /// The defaults in `constants`, unless the environment says otherwise. A variable that is
    /// set but empty means *none*, which is not the same as not set.
    pub fn from_env() -> Result<Self, String> {
        let relays = std::env::var(ENV_RELAY_URLS).ok();
        let lookup = std::env::var(ENV_LOOKUP_URL).ok();
        let relays: Vec<&str> = match &relays {
            Some(list) => list.split(',').map(str::trim).filter(|url| !url.is_empty()).collect(),
            None => DEFAULT_RELAY_URLS.to_vec(),
        };
        let lookup = match &lookup {
            Some(url) => Some(url.trim()).filter(|url| !url.is_empty()),
            None => DEFAULT_LOOKUP_URL,
        };
        Self::new(&relays, lookup)
    }
}

/// Refuses, at the handshake, every connection that is not compute traffic with an endpoint on
/// the allowlist — incoming *and* outgoing. Nothing has been read from the peer at this point
/// but the proof that it holds the key for its id. The one other way through is the identity
/// proof, `pairing::ALPN`, and only for the endpoint a pairing in progress has just been told:
/// that connection carries the proof and nothing else, and is never counted as a paired one.
#[derive(Debug)]
struct Gate(Peers, Pairings);

impl EndpointHooks for Gate {
    async fn after_handshake(&self, connection: &Connection) -> AfterHandshakeOutcome {
        let peer = connection.remote_id();
        if connection.alpn() == ALPN && self.0.allowed(&peer) {
            return AfterHandshakeOutcome::Accept;
        }
        if connection.alpn() == pairing::ALPN && self.1.expects(&peer) {
            return AfterHandshakeOutcome::Accept;
        }
        tracing::warn!(peer = %connection.remote_id().fmt_short(), "refused an endpoint that is not paired");
        AfterHandshakeOutcome::Reject { error_code: CLOSE_NOT_PAIRED.into(), reason: b"not paired".to_vec() }
    }
}

/// The UDP port this computer listens on, the same at every launch.
///
/// A hint says *where to try*, and an address is `ip:port`: with a port chosen fresh each launch,
/// every saved hint went stale the moment either app restarted, however steady the network. This
/// one is derived from the endpoint's own identity, in the dynamic range, so it needs no
/// storage and no coordination. It is a preference, not a promise: [`bind`] takes another port
/// if something else already holds this one.
pub fn stable_port(key: &SecretKey) -> u16 {
    let id = key.public();
    let bytes = id.as_bytes();
    49152 + u16::from_be_bytes([bytes[0], bytes[1]]) % 16384
}

pub async fn bind(
    key: &SecretKey,
    network: &Network,
    hints: &MemoryLookup,
    peers: &Peers,
    pairings: &Pairings,
) -> Result<Endpoint, String> {
    // The stable port first, and a port of the system's choosing only if that one is taken.
    let mut taken = String::new();
    for port in [Some(stable_port(key)), None] {
        match bind_on(key, network, hints, peers, pairings, port).await {
            Ok(endpoint) => return Ok(endpoint),
            Err(error) if port.is_some() => {
                tracing::warn!(port, %error, "the usual port is in use; taking another");
                taken = error;
            }
            Err(error) => return Err(if taken.is_empty() { error } else { format!("{error} (and {taken})") }),
        }
    }
    unreachable!("the loop returns on its last turn")
}

async fn bind_on(
    key: &SecretKey,
    network: &Network,
    hints: &MemoryLookup,
    peers: &Peers,
    pairings: &Pairings,
    port: Option<u16>,
) -> Result<Endpoint, String> {
    let limits = QuicTransportConfig::builder()
        .max_concurrent_bidi_streams(STREAMS_MAX.into())
        .max_concurrent_uni_streams(0u32.into())
        .stream_receive_window(STREAM_WINDOW.into())
        .receive_window(CONNECTION_WINDOW.into())
        .send_window(SEND_WINDOW)
        .max_idle_timeout(Some(IDLE_TIMEOUT.try_into().map_err(|_| "idle timeout out of range")?))
        .build();
    // `Minimal` brings a crypto provider and nothing else: no relay and no address lookup that
    // was not asked for, so choosing a self-hosted service never leaves a public one beside it.
    let mut builder = Endpoint::builder(presets::Minimal)
        .secret_key(key.clone())
        .alpns(vec![ALPN.to_vec(), pairing::ALPN.to_vec()])
        .transport_config(limits)
        .hooks(Gate(peers.clone(), pairings.clone()))
        .relay_mode(match network.relay_urls.is_empty() {
            true => RelayMode::Disabled,
            false => RelayMode::custom(network.relay_urls.iter().cloned()),
        })
        // Where core's hints for each paired endpoint are kept. A hint says where to try; the
        // handshake says who answered.
        .address_lookup(hints.clone());
    if let Some(port) = port {
        // Both families, as the default does; IPv6 may fail (no stack, or the port is taken there)
        // without costing the endpoint its IPv4 socket.
        builder = builder
            .clear_ip_transports()
            .bind_addr(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port))
            .map_err(|error| error.to_string())?
            .bind_addr_with_opts(SocketAddrV6::new(Ipv6Addr::UNSPECIFIED, port, 0, 0), BindOpts::default().set_is_required(false))
            .map_err(|error| error.to_string())?;
    }
    if let Some(url) = &network.lookup_url {
        // The publisher sends the relay URL only — never this computer's LAN addresses.
        builder = builder.address_lookup(PkarrPublisher::builder(url.clone())).address_lookup(PkarrResolver::builder(url.clone()));
    }
    builder.bind().await.map_err(|error| error.to_string())
}

/// Take connections for as long as this endpoint is open.
pub fn listen(node: Arc<Node>, endpoint: Endpoint) {
    tokio::spawn(async move {
        while let Some(incoming) = endpoint.accept().await {
            let node = node.clone();
            tokio::spawn(async move {
                // An error here is the gate's refusal, or a handshake that never finished.
                let Ok(connection) = incoming.await else { return };
                // By what it came to say, before anything else: a pairing connection is from
                // an endpoint that is not trusted yet, and must not be attached as one that is.
                if connection.alpn() == pairing::ALPN {
                    return node.pairing.incoming(connection);
                }
                if node.peers.attach(&connection) {
                    carry(node, connection).await;
                } else {
                    connection.close(CLOSE_NOT_PAIRED.into(), b"not paired");
                }
            });
        }
    });
}

/// A connection to a paired endpoint: the one already open, or a new one.
pub async fn connection(node: &Arc<Node>, peer: EndpointId) -> Result<Connection, ApiError> {
    if let Some(connection) = node.peers.live(&peer) {
        return Ok(connection);
    }
    let dialing = node.peers.dialing(&peer);
    let _one = dialing.lock().await;
    if let Some(connection) = node.peers.live(&peer) {
        return Ok(connection);
    }
    if !node.peers.allowed(&peer) {
        return Err(ApiError::new(PEER_NOT_ALLOWED, "not a paired computer"));
    }
    let unreachable = || ApiError::new(PEER_UNREACHABLE, "the other computer could not be reached");
    // By id alone: the addresses come from core's hints and, if configured, the lookup service.
    let endpoint = node.endpoint();
    let dial = endpoint.connect(EndpointAddr::new(peer), ALPN);
    let connection = timeout(DIAL_TIMEOUT, dial).await.map_err(|_| unreachable())?.map_err(|error| {
        tracing::debug!(peer = %peer.fmt_short(), %error, "dial failed");
        unreachable()
    })?;
    if !node.peers.attach(&connection) {
        connection.close(CLOSE_NOT_PAIRED.into(), b"not paired");
        return Err(ApiError::new(PEER_NOT_ALLOWED, "not a paired computer"));
    }
    tokio::spawn(carry(node.clone(), connection.clone()));
    Ok(connection)
}

/// Live with one attached connection until it closes: forward the streams the peer opens on
/// it, and keep its status current. Either side may open streams, whoever dialled.
async fn carry(node: Arc<Node>, connection: Connection) {
    let peer = connection.remote_id();
    let mut paths = connection.path_events();
    let mut watching = true;
    loop {
        tokio::select! {
            _ = connection.closed() => break,
            event = paths.next(), if watching => match event {
                Some(_) => node.peers.refresh(&peer),
                None => watching = false,
            },
            stream = connection.accept_bi() => match stream {
                // At most `STREAMS_MAX` of these at once: QUIC does not let the peer open more.
                Ok((send, recv)) => drop(tokio::spawn(forward::serve(node.clone(), peer, send, recv))),
                Err(_) => break,
            },
        }
    }
    node.peers.detach(&connection);
}
