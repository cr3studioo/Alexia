// SPDX-License-Identifier: AGPL-3.0-only

//! `alexia-connect` — the native transport between two paired computers.
//!
//! Four things, and no more: **encrypted connectivity**, the **endpoint identity**, **pairing
//! cryptography** (`pairing.rs`) and **stream forwarding**. Everything that is a
//! decision — which computers are paired, what a paired computer may ask for, what runs and when
//! — is core's, and reaches this process over the loopback API in `control.rs`. Scheduling,
//! permissions, setup and worker policy are not here and should not arrive.
//!
//! `README.md` is the contract with core. If this file and that one disagree, that one is the
//! bug report.

pub mod constants;
pub mod identity;
pub mod pairing;

mod bridge;
mod control;
mod error;
mod forward;
mod host;
mod http;
mod peers;
mod transport;
mod wire;

use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex, RwLock};

use iroh::address_lookup::MemoryLookup;
use iroh::{Endpoint, SecretKey};
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::constants::CLOSE_SHUTDOWN;
use crate::error::{ApiError, NETWORK_FAILED};
use crate::host::Host;
use crate::pairing::Pairings;
use crate::peers::Peers;
pub use crate::transport::{stable_port, Network};

/// What is logged: this crate's own lines and no others. iroh's are left out whole rather than
/// trusted, line by line, never to say more than a log should — and so are the wormhole
/// crate's, which at `debug` print the messages of a pairing.
pub fn logged(level: tracing_subscriber::filter::LevelFilter) -> tracing_subscriber::filter::Targets {
    tracing_subscriber::filter::Targets::new().with_target(env!("CARGO_CRATE_NAME"), level)
}

/// What a launch is given. No `Debug`: two of them are secrets.
pub struct Options {
    /// The per-launch secret every loopback request must carry.
    pub secret: String,
    /// The endpoint's private key. It goes into the endpoint and is not readable back out.
    pub key: SecretKey,
    pub network: Network,
    /// The mailbox server pairing meets at, and how long a code is good for.
    pub pairing: pairing::Settings,
}

/// Why `start` did not. `code` is what the ready line reports.
#[derive(Debug)]
pub struct StartError {
    pub code: &'static str,
    pub message: String,
}

pub(crate) struct Node {
    secret: String,
    key: SecretKey,
    hints: MemoryLookup,
    peers: Peers,
    pairing: Pairings,
    endpoint: RwLock<Endpoint>,
    network: Mutex<Network>,
    host: RwLock<Option<Arc<Host>>>,
    /// One change of network at a time.
    changing: tokio::sync::Mutex<()>,
    stop: Notify,
    /// Addresses core says this computer can also be reached at — a VPN's, say — that the
    /// endpoint does not report on its own. Said in pairing hints with the endpoint's own port.
    extra: Mutex<Vec<std::net::IpAddr>>,
}

impl Node {
    fn endpoint(&self) -> Endpoint {
        self.endpoint.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    fn network(&self) -> Network {
        self.network.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    fn extra(&self) -> Vec<std::net::IpAddr> {
        self.extra.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    fn set_extra(&self, addresses: Vec<std::net::IpAddr>) {
        *self.extra.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = addresses;
    }

    fn host(&self) -> Option<Arc<Host>> {
        self.host.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    fn set_host(&self, host: Option<Arc<Host>>) {
        *self.host.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = host;
    }

    /// Move to other relay and lookup services: a new endpoint with the same identity, and the
    /// old one closed. Every connection drops and is dialled again on the next request, so this
    /// is for a quiet moment. If the new endpoint cannot be made, the old one is left alone.
    async fn rebind(self: &Arc<Self>, network: Network) -> Result<(), ApiError> {
        let _one = self.changing.lock().await;
        let endpoint = transport::bind(&self.key, &network, &self.hints, &self.peers, &self.pairing)
            .await
            .map_err(|message| ApiError::new(NETWORK_FAILED, message))?;
        let old = std::mem::replace(&mut *self.endpoint.write().unwrap_or_else(|poisoned| poisoned.into_inner()), endpoint.clone());
        *self.network.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = network;
        transport::listen(self.clone(), endpoint);
        tokio::spawn(async move { old.close().await });
        Ok(())
    }
}

/// A started sidecar: an endpoint, and a loopback port that controls it.
pub struct Running {
    node: Arc<Node>,
    port: u16,
    control: JoinHandle<()>,
}

/// Bind the endpoint and the loopback port. Nothing is accepted from anybody until core has
/// supplied an allowlist, and nothing is forwarded until it has registered a host service.
pub async fn start(options: Options) -> Result<Running, StartError> {
    let Options { secret, key, network, pairing } = options;
    let failed = |message: String| StartError { code: "bind_failed", message };
    let (hints, peers, pairing) = (MemoryLookup::new(), Peers::default(), Pairings::new(pairing));
    let endpoint = transport::bind(&key, &network, &hints, &peers, &pairing).await.map_err(failed)?;
    // Loopback only, and a port the system picks: there is no address to guess.
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.map_err(|error| failed(error.to_string()))?;
    let port = listener.local_addr().map_err(|error| failed(error.to_string()))?.port();
    let node = Arc::new(Node {
        secret,
        key,
        hints,
        peers,
        pairing,
        endpoint: RwLock::new(endpoint.clone()),
        network: Mutex::new(network),
        host: RwLock::new(None),
        changing: tokio::sync::Mutex::new(()),
        stop: Notify::new(),
        extra: Mutex::new(Vec::new()),
    });
    transport::listen(node.clone(), endpoint);
    let control = tokio::spawn(control::serve(node.clone(), listener));
    tracing::info!(port, endpoint = %node.endpoint().id().fmt_short(), "ready");
    Ok(Running { node, port, control })
}

impl Running {
    pub fn port(&self) -> u16 {
        self.port
    }

    /// The public half of the identity. The private half has no accessor.
    pub fn endpoint_id(&self) -> String {
        self.node.endpoint().id().to_string()
    }

    /// Resolves when core asks for a shutdown over the control API.
    pub async fn stopped(&self) {
        self.node.stop.notified().await;
    }

    /// Stop answering, close every connection, and let the endpoint say goodbye.
    pub async fn close(self) {
        self.control.abort();
        self.node.pairing.close_all();
        self.node.peers.close_all(CLOSE_SHUTDOWN, b"shutdown");
        self.node.endpoint().close().await;
    }
}
