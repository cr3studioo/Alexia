// SPDX-License-Identifier: AGPL-3.0-only

//! Who may talk to this computer, who is connected, and how.
//!
//! The allowlist is core's: it is handed over the control API and held here in memory only.
//! It starts **empty**, so a process that has been told nothing accepts nobody. One lock covers
//! the list and the live connections together, which is what makes revocation exact: an
//! endpoint is taken off the list and its connections are closed in the same step, and a
//! connection that finishes its handshake a moment later finds the list already changed.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, MutexGuard};

use iroh::endpoint::Connection;
use iroh::EndpointId;
use serde::Serialize;
use tokio::sync::broadcast;

use crate::constants::{CLOSE_REVOKED, EVENTS_MAX};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Offline,
    Relayed,
    Direct,
}

/// What `/v1/peers` lists and what a `peer` event carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub endpoint_id: String,
    pub status: Status,
}

#[derive(Debug, Clone)]
pub struct Peers(Arc<Inner>);

#[derive(Debug)]
struct Inner {
    state: Mutex<State>,
    events: broadcast::Sender<Peer>,
}

#[derive(Debug, Default)]
struct State {
    allowed: BTreeSet<EndpointId>,
    live: HashMap<EndpointId, Vec<Connection>>,
    /// What was last said about each peer. Absent is Offline.
    said: HashMap<EndpointId, Status>,
    /// One dial at a time to each peer, so ten jobs starting together share a connection.
    dialing: HashMap<EndpointId, Arc<tokio::sync::Mutex<()>>>,
}

impl Default for Peers {
    fn default() -> Self {
        // Bounded: a subscriber that stops reading loses the oldest events and is told it did.
        let (events, _) = broadcast::channel(EVENTS_MAX);
        Self(Arc::new(Inner { state: Mutex::default(), events }))
    }
}

impl Peers {
    fn state(&self) -> MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn allowed(&self, peer: &EndpointId) -> bool {
        self.state().allowed.contains(peer)
    }

    /// Make the allowlist exactly this. Everybody no longer on it is closed, now. Returns them.
    pub fn replace(&self, allowed: BTreeSet<EndpointId>) -> Vec<EndpointId> {
        let mut state = self.state();
        let gone: Vec<EndpointId> = state.allowed.difference(&allowed).copied().collect();
        state.allowed = allowed;
        for peer in &gone {
            self.close(&mut state, peer);
        }
        gone
    }

    /// Take one endpoint off the allowlist and close its connections. False if it was not on it.
    pub fn revoke(&self, peer: &EndpointId) -> bool {
        let mut state = self.state();
        let was = state.allowed.remove(peer);
        self.close(&mut state, peer);
        was
    }

    fn close(&self, state: &mut State, peer: &EndpointId) {
        for connection in state.live.remove(peer).unwrap_or_default() {
            // Closing resets every stream on it: the jobs it carried end here and on the other
            // side, without waiting for anybody to notice.
            connection.close(CLOSE_REVOKED.into(), b"revoked");
        }
        state.dialing.remove(peer);
        self.say(state, peer);
    }

    /// Count a connection as live — if its endpoint is allowed. The caller closes it if not.
    pub fn attach(&self, connection: &Connection) -> bool {
        let peer = connection.remote_id();
        let mut state = self.state();
        if !state.allowed.contains(&peer) {
            return false;
        }
        state.live.entry(peer).or_default().push(connection.clone());
        self.say(&mut state, &peer);
        true
    }

    pub fn detach(&self, connection: &Connection) {
        let peer = connection.remote_id();
        let mut state = self.state();
        if let Some(live) = state.live.get_mut(&peer) {
            live.retain(|other| other.stable_id() != connection.stable_id());
            if live.is_empty() {
                state.live.remove(&peer);
            }
        }
        self.say(&mut state, &peer);
    }

    /// A path opened, closed or was chosen: look again at how this peer is reached.
    pub fn refresh(&self, peer: &EndpointId) {
        self.say(&mut self.state(), peer);
    }

    /// A connection to this peer that is still open, if there is one.
    pub fn live(&self, peer: &EndpointId) -> Option<Connection> {
        let state = self.state();
        state.live.get(peer)?.iter().find(|connection| connection.close_reason().is_none()).cloned()
    }

    pub fn dialing(&self, peer: &EndpointId) -> Arc<tokio::sync::Mutex<()>> {
        self.state().dialing.entry(*peer).or_default().clone()
    }

    pub fn close_all(&self, code: u32, reason: &[u8]) {
        let mut state = self.state();
        for (_, live) in state.live.drain() {
            for connection in live {
                connection.close(code.into(), reason);
            }
        }
    }

    /// Everybody on the allowlist, with how each is reached.
    pub fn list(&self) -> Vec<Peer> {
        list(&self.state())
    }

    /// The list and the changes after it, taken together so that nothing falls between them.
    pub fn subscribe(&self) -> (Vec<Peer>, broadcast::Receiver<Peer>) {
        let state = self.state();
        (list(&state), self.0.events.subscribe())
    }

    /// Work out how `peer` is reached now, and say so if that is news.
    fn say(&self, state: &mut State, peer: &EndpointId) {
        let now = state
            .live
            .get(peer)
            .and_then(|live| live.iter().filter_map(reached).max())
            .unwrap_or(Status::Offline);
        let before = match now {
            Status::Offline => state.said.remove(peer),
            _ => state.said.insert(*peer, now),
        };
        if before.unwrap_or(Status::Offline) != now {
            tracing::info!(peer = %peer.fmt_short(), status = ?now, "peer");
            // Nobody listening is not an error.
            let _ = self.0.events.send(Peer { endpoint_id: peer.to_string(), status: now });
        }
    }
}

fn list(state: &State) -> Vec<Peer> {
    let said = |peer| state.said.get(peer).copied().unwrap_or(Status::Offline);
    state.allowed.iter().map(|peer| Peer { endpoint_id: peer.to_string(), status: said(peer) }).collect()
}

/// How one connection reaches its peer: by the path QUIC has chosen to send on.
fn reached(connection: &Connection) -> Option<Status> {
    if connection.close_reason().is_some() {
        return None;
    }
    let (mut chosen, mut direct) = (None, false);
    for path in connection.paths().iter() {
        if path.is_selected() {
            chosen = Some(path.is_relay());
        }
        direct |= !path.is_relay();
    }
    Some(match chosen {
        Some(true) => Status::Relayed,
        Some(false) => Status::Direct,
        None if direct => Status::Direct,
        None => Status::Relayed,
    })
}
