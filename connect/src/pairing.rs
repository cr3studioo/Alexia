// SPDX-License-Identifier: AGPL-3.0-only

//! Pairing: how two computers that have never met come to know each other's endpoint id.
//!
//! Two steps, and trust comes only from the second.
//!
//! 1. **The wormhole.** One computer shows a code — a mailbox number and four words — and the
//!    other types it. Magic Wormhole's exchange (SPAKE2 over a mailbox server, the
//!    `magic-wormhole` crate) turns that code into a key only those two hold, and under it each
//!    says who it is: an endpoint id, a name, where it can be found. A code is good for one
//!    attempt and five minutes, and is dead after either.
//! 2. **The proof.** Saying an id is not holding it. The joiner dials the id it was told over
//!    iroh, under [`ALPN`], and iroh's handshake settles who holds which key. A MAC under the
//!    wormhole's key then ties that connection to this pairing and to exactly what was said in
//!    it. Only after both have checked the other's does either report a peer.
//!
//! What this module keeps to:
//!
//! - **The key stays where it is.** The proof is made by the endpoint with the endpoint key;
//!   nothing here is handed a byte of it, and no operation returns one.
//! - **Trust is core's to write down.** A pairing ends by telling core an endpoint id and its
//!   hints. Core persists the record and puts the id on the allowlist (`PUT /v1/allowlist`);
//!   this process keeps no pairing record and adds nobody to anything.
//! - **The gate opens for one endpoint.** `transport::Gate` lets [`ALPN`] through only for the
//!   endpoint a pairing in progress has just been told, and only until that pairing settles.
//! - **Nothing of a code, a key or a pairing message is logged** — not by this crate, and the
//!   wormhole crate's own lines are not printed at all (`main::logging`).

use std::borrow::Cow;
use std::collections::HashMap;
use std::future::Future;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hmac::{Hmac, KeyInit, Mac};
use iroh::endpoint::Connection;
use iroh::{EndpointAddr, EndpointId, RelayUrl, TransportAddr};
use magic_wormhole::rendezvous::RendezvousError;
use magic_wormhole::{AppConfig, AppID, Code, KeyPurpose, MailboxConnection, Wormhole, WormholeError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, oneshot, watch};
use tokio::task::AbortHandle;
use tokio::time::{sleep, timeout};
use url::Url;
use zeroize::Zeroizing;

use crate::constants::{
    CLOSE_NORMAL, CLOSE_NOT_PAIRED, DEFAULT_MAILBOX_URL, ENV_MAILBOX_URL, EVENTS_MAX, HINT_ADDRESSES_MAX, PAIRINGS_KEPT,
    PAIRINGS_MAX, PAIRING_APP_ID, PAIRING_CODE_TTL, PAIRING_JOIN_TIMEOUT, PAIRING_LINGER, PAIRING_MAILBOX_TIMEOUT,
    PAIRING_MESSAGE_MAX, PAIRING_NAME_MAX, PAIRING_NONCE, PAIRING_PAYLOAD_MAX, PAIRING_PROOF_TIMEOUT, PAIRING_REDIAL,
    PAIRING_TAG, PAIRING_VERSION, PAIRING_WORDS,
};
use crate::error::{
    ApiError, ALREADY_PAIRED, BAD_REQUEST, MAILBOX_NOT_CONFIGURED, PAIRING_CANCELLED, PAIRING_CODE_UNKNOWN,
    PAIRING_EXPIRED, PAIRING_LIMIT, PAIRING_MAILBOX_FAILED, PAIRING_PEER_INVALID, PAIRING_PROOF_FAILED, PAIRING_TIMEOUT,
    PAIRING_WRONG_CODE,
};
use crate::Node;

/// What the identity proof is spoken under. Offered by the endpoint, and refused by the gate
/// for everybody but the endpoint a pairing in progress names.
pub const ALPN: &[u8] = b"alexia/pairing/1";

/// What the proof's key is derived from the wormhole's for.
const PROOF_PURPOSE: &str = "alexia/pairing/1/proof";

/// How long each part of a pairing may take. The defaults are the ones in `README.md`; a test
/// that wants to see a code expire does not wait five minutes for it.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub code_ttl: Duration,
    pub join_timeout: Duration,
    pub mailbox_timeout: Duration,
    pub proof_timeout: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            code_ttl: PAIRING_CODE_TTL,
            join_timeout: PAIRING_JOIN_TIMEOUT,
            mailbox_timeout: PAIRING_MAILBOX_TIMEOUT,
            proof_timeout: PAIRING_PROOF_TIMEOUT,
        }
    }
}

/// What a launch is told about pairing.
#[derive(Debug, Clone, Default)]
pub struct Settings {
    /// The mailbox server. `None` and a pairing cannot start.
    pub mailbox_url: Option<Url>,
    pub timing: Timing,
    /// Also say this computer's loopback addresses among its hints. For two endpoints on one
    /// machine with no network to speak of, which is what a test is.
    pub loopback_hints: bool,
}

impl Settings {
    /// A mailbox server's address: `ws` or `wss`, with a host.
    pub fn mailbox(text: &str) -> Result<Url, String> {
        match Url::parse(text) {
            Ok(url) if ["wss", "ws"].contains(&url.scheme()) && url.host().is_some() => Ok(url),
            // Not the text: a URL may carry a credential, and this message is logged.
            _ => Err("the mailbox URL is not a ws(s) URL".to_owned()),
        }
    }

    /// The default in `constants`, unless the environment says otherwise. Set but empty is none.
    pub fn from_env() -> Result<Self, String> {
        let named = std::env::var(ENV_MAILBOX_URL).ok();
        let url = match &named {
            Some(url) => Some(url.trim()).filter(|url| !url.is_empty()),
            None => DEFAULT_MAILBOX_URL,
        };
        Ok(Self { mailbox_url: url.map(Self::mailbox).transpose()?, ..Self::default() })
    }
}

// ---------------------------------------------------------------------------------------------
// What core asks for, and what it is told
// ---------------------------------------------------------------------------------------------

/// `POST /v1/pairing/host`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Hosting {
    name: String,
    #[serde(default)]
    payload: Value,
    #[serde(default)]
    exclusive: Option<bool>,
    /// Without a mailbox: the joiner finds this endpoint by other means (core's announcement on
    /// the local network or a VPN) and the code is exchanged directly over iroh.
    #[serde(default)]
    direct: bool,
}

/// Where a direct pairing's host is, as the joiner learned it. Unauthenticated until the code
/// has been proven over a connection to exactly this id.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Target {
    endpoint_id: String,
    #[serde(default)]
    addresses: Vec<String>,
}

/// `POST /v1/pairing/join`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Joining {
    code: String,
    name: String,
    #[serde(default)]
    payload: Value,
    #[serde(default)]
    exclusive: Option<bool>,
    /// A host found without a mailbox: dial it here and exchange the code directly.
    #[serde(default)]
    direct: Option<Target>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Role {
    Host,
    Join,
}

/// Where one pairing has got to. It leaves `Waiting` once, and never moves again.
#[derive(Debug, Clone)]
pub(crate) enum State {
    Waiting,
    /// The peer, as core is told it.
    Paired(Value),
    Failed(Failure),
}

/// Why a pairing ended with nobody. Both halves are fixed text: nothing a peer or a mailbox
/// sent, and nothing of a code, is ever put in one.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Failure(&'static str, &'static str);

const EXPIRED: Failure = Failure(PAIRING_EXPIRED, "the code expired before anybody proved who they were");
const CANCELLED: Failure = Failure(PAIRING_CANCELLED, "the pairing was cancelled");
const CODE_UNKNOWN: Failure = Failure(PAIRING_CODE_UNKNOWN, "the mailbox has no open pairing under that number");
const WRONG_CODE: Failure = Failure(PAIRING_WRONG_CODE, "the two computers did not hold the same code");
const PROOF_FAILED: Failure = Failure(PAIRING_PROOF_FAILED, "the other computer did not prove it holds the identity it named");
const PEER_INVALID: Failure = Failure(PAIRING_PEER_INVALID, "the other side did not speak this protocol");
const MAILBOX_FAILED: Failure = Failure(PAIRING_MAILBOX_FAILED, "the mailbox server could not be used");
const TIMED_OUT: Failure = Failure(PAIRING_TIMEOUT, "the pairing did not finish in time");
const TAKEN: Failure = Failure(ALREADY_PAIRED, "a computer was paired while this pairing was in progress");

/// What does not change about a pairing, and is safe to say: there is no code in here.
#[derive(Debug, Clone)]
pub(crate) struct Meta {
    id: String,
    role: Role,
    /// Milliseconds since the Unix epoch.
    expires_at: u64,
}

/// The pairing object of `README.md`.
pub(crate) fn view(meta: &Meta, state: &State) -> Value {
    let mut said = json!({ "pairingId": meta.id, "role": meta.role, "expiresAt": meta.expires_at });
    match state {
        State::Waiting => said["state"] = json!("waiting"),
        State::Paired(peer) => {
            said["state"] = json!("paired");
            said["peer"] = peer.clone();
        }
        State::Failed(Failure(code, message)) => {
            said["state"] = json!("failed");
            said["error"] = json!({ "code": code, "message": message });
        }
    }
    said
}

// ---------------------------------------------------------------------------------------------
// The pairings of one launch
// ---------------------------------------------------------------------------------------------

#[derive(Clone)]
pub(crate) struct Pairings(Arc<Inner>);

struct Inner {
    timing: Timing,
    loopback_hints: bool,
    mailbox: Mutex<Option<Url>>,
    table: Mutex<Table>,
    events: broadcast::Sender<Value>,
}

#[derive(Default)]
struct Table {
    /// Oldest first.
    entries: Vec<Entry>,
    /// The endpoints a pairing in progress has been told, which is who the gate lets speak
    /// [`ALPN`]. A host waits here for the joiner's connection; a joiner only dials.
    expected: HashMap<EndpointId, Option<oneshot::Sender<Connection>>>,
    /// The one direct pairing that is waiting for a joiner, if any. The first connection under
    /// [`DIRECT_ALPN`] takes it; there is no second try.
    direct: Option<oneshot::Sender<Connection>>,
}

struct Entry {
    meta: Meta,
    state: watch::Sender<State>,
    task: Option<AbortHandle>,
}

impl Entry {
    fn waiting(&self) -> bool {
        matches!(*self.state.borrow(), State::Waiting)
    }
}

// Not derived: nothing in here is for a log.
impl std::fmt::Debug for Pairings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Pairings")
    }
}

impl Pairings {
    pub fn new(settings: Settings) -> Self {
        let (events, _) = broadcast::channel(EVENTS_MAX);
        let Settings { mailbox_url, timing, loopback_hints } = settings;
        Self(Arc::new(Inner { timing, loopback_hints, mailbox: Mutex::new(mailbox_url), table: Mutex::default(), events }))
    }

    fn table(&self) -> MutexGuard<'_, Table> {
        self.0.table.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn mailbox(&self) -> Option<Url> {
        self.0.mailbox.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    /// For the pairings that start after this. One in progress keeps the server it began on.
    pub fn set_mailbox(&self, url: Option<Url>) {
        *self.0.mailbox.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = url;
    }

    /// Every pairing still remembered, as core is shown them.
    pub fn list(&self) -> Vec<Value> {
        self.table().entries.iter().map(|entry| view(&entry.meta, &entry.state.borrow())).collect()
    }

    /// One pairing, and a way to wait for it to settle.
    pub fn watch(&self, id: &str) -> Option<(Meta, watch::Receiver<State>)> {
        let table = self.table();
        let entry = table.entries.iter().find(|entry| entry.meta.id == id)?;
        Some((entry.meta.clone(), entry.state.subscribe()))
    }

    /// Each pairing as it settles. Never one that is still waiting.
    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.0.events.subscribe()
    }

    /// Whether a pairing in progress has been told this endpoint. This is the gate's question.
    pub fn expects(&self, peer: &EndpointId) -> bool {
        self.table().expected.contains_key(peer)
    }

    /// A connection the gate let through under [`ALPN`]: to the host that is waiting for it, or
    /// closed. One connection per pairing, so a second from the same endpoint is turned away.
    pub fn incoming(&self, connection: Connection) {
        let waiting = self.table().expected.get_mut(&connection.remote_id()).and_then(Option::take);
        match waiting {
            Some(waiting) => drop(waiting.send(connection)),
            None => connection.close(CLOSE_NOT_PAIRED.into(), b"not pairing"),
        }
    }

    /// Whether a direct pairing is waiting: the gate's question for [`DIRECT_ALPN`].
    pub fn direct_open(&self) -> bool {
        self.table().direct.as_ref().is_some_and(|waiting| !waiting.is_closed())
    }

    /// A connection under [`DIRECT_ALPN`]: to the direct pairing waiting for it, or closed.
    pub fn incoming_direct(&self, connection: Connection) {
        match self.table().direct.take() {
            Some(waiting) => drop(waiting.send(connection)),
            None => connection.close(CLOSE_NOT_PAIRED.into(), b"not pairing"),
        }
    }

    /// Cancel one. `None` if there is no such pairing, `false` if it had already settled.
    pub fn cancel(&self, id: &str) -> Option<bool> {
        // In two steps: the table is not held while the pairing is settled under it.
        let known = self.table().entries.iter().any(|entry| entry.meta.id == id);
        known.then(|| self.settle(id, State::Failed(CANCELLED)))
    }

    /// The process is going: nothing is left waiting.
    pub fn close_all(&self) {
        let waiting: Vec<String> =
            self.table().entries.iter().filter(|entry| entry.waiting()).map(|entry| entry.meta.id.clone()).collect();
        for id in waiting {
            self.settle(&id, State::Failed(CANCELLED));
        }
    }

    /// Move a pairing out of `Waiting`. The first to do so wins and everybody is told once; a
    /// later outcome — a proof that finished as the cancel arrived — is dropped, not reported.
    fn settle(&self, id: &str, state: State) -> bool {
        let mut table = self.table();
        let Some(entry) = table.entries.iter_mut().find(|entry| entry.meta.id == id) else { return false };
        let mut said = None;
        let won = entry.state.send_if_modified(|current| {
            if !matches!(current, State::Waiting) {
                return false;
            }
            *current = state;
            said = Some(view(&entry.meta, current));
            true
        });
        if !won {
            return false;
        }
        // Whatever it was doing — at the mailbox, on the wire — stops here. Dropping the task
        // drops its wormhole and its connection, and with them everything the code could open.
        if let Some(task) = entry.task.take() {
            task.abort();
        }
        match &*entry.state.borrow() {
            State::Failed(Failure(code, _)) => tracing::info!(pairing = %id, role = ?entry.meta.role, code, "pairing failed"),
            _ => tracing::info!(pairing = %id, role = ?entry.meta.role, "pairing proved a peer"),
        }
        let _ = self.0.events.send(said.unwrap_or_default());
        // The oldest settled ones are forgotten; the ones in progress never are.
        let mut settled = table.entries.iter().filter(|entry| !entry.waiting()).count();
        table.entries.retain(|entry| {
            let forget = settled > PAIRINGS_KEPT && !entry.waiting();
            settled -= usize::from(forget);
            !forget
        });
        true
    }

    fn room(&self) -> Result<(), ApiError> {
        match self.table().entries.iter().filter(|entry| entry.waiting()).count() < PAIRINGS_MAX {
            true => Ok(()),
            false => Err(ApiError::new(PAIRING_LIMIT, "too many pairings are in progress")),
        }
    }

    /// Write a pairing down and start it, in one step: there is never an entry without its
    /// task, nor a task whose outcome has nowhere to go.
    fn begin<F>(&self, role: Role, lifetime: Duration, exclusive: Option<Arc<Node>>, work: F) -> Result<Meta, ApiError>
    where
        F: Future<Output = Result<Value, Failure>> + Send + 'static,
    {
        let meta = Meta { id: hex(&random::<8>().map_err(|_| unusable())?), role, expires_at: after(lifetime) };
        let mut table = self.table();
        if table.entries.iter().filter(|entry| entry.waiting()).count() >= PAIRINGS_MAX {
            return Err(ApiError::new(PAIRING_LIMIT, "too many pairings are in progress"));
        }
        let (pairings, id) = (self.clone(), meta.id.clone());
        let task = tokio::spawn(async move {
            let state = match work.await {
                // The rule was checked when this began. It is checked again now that there is
                // somebody to report, because core may have paired another in between.
                Ok(_) if exclusive.is_some_and(|node| !node.peers.list().is_empty()) => State::Failed(TAKEN),
                Ok(peer) => State::Paired(peer),
                Err(failure) => State::Failed(failure),
            };
            pairings.settle(&id, state);
        });
        tracing::info!(pairing = %meta.id, ?role, "pairing started");
        let (state, _) = watch::channel(State::Waiting);
        table.entries.push(Entry { meta: meta.clone(), state, task: Some(task.abort_handle()) });
        Ok(meta)
    }

    /// Name the endpoint a pairing has been told, for as long as the returned guard lives.
    fn expect(&self, peer: EndpointId, waiting: Option<oneshot::Sender<Connection>>) -> Result<Expected, Failure> {
        let mut table = self.table();
        // Two pairings at once that name one endpoint: the second is somebody replaying the
        // first's identity, or a mistake. Either way it is not the one being waited for.
        if table.expected.contains_key(&peer) {
            return Err(PEER_INVALID);
        }
        table.expected.insert(peer, waiting);
        Ok(Expected(self.clone(), peer))
    }
}

/// The gate's exception, for exactly as long as the proof takes.
struct Expected(Pairings, EndpointId);

impl Drop for Expected {
    fn drop(&mut self) {
        self.0.table().expected.remove(&self.1);
    }
}

// ---------------------------------------------------------------------------------------------
// Starting one
// ---------------------------------------------------------------------------------------------

/// Open a pairing and return its code. The mailbox has been reached, and has allocated a
/// number, before this returns — so a code that is shown is one that can be joined.
pub(crate) async fn host(node: &Arc<Node>, ask: Hosting) -> Result<Value, ApiError> {
    let Hosting { name, payload, exclusive, direct } = ask;
    if direct {
        return host_direct(node, name, payload, exclusive);
    }
    let pairings = &node.pairing;
    let exclusive = allowed(node, exclusive.unwrap_or(true))?;
    let hello = hello(node, &name, payload)?;
    let config = config(pairings.mailbox(), hello.clone())?;
    pairings.room()?;

    let timing = pairings.0.timing;
    let unreachable = || ApiError::new(PAIRING_MAILBOX_FAILED, MAILBOX_FAILED.1);
    let mailbox = timeout(timing.mailbox_timeout, MailboxConnection::create(config, PAIRING_WORDS))
        .await
        .map_err(|_| unreachable())?
        .map_err(|_| unreachable())?;
    // The one place the code is ever written: the answer to this request.
    let code = mailbox.code().to_string();

    let work = {
        let node = node.clone();
        async move {
            let meeting = async {
                let wormhole = Wormhole::connect(mailbox).await.map_err(failure)?;
                let (peer, key) = met(&node, wormhole).await?;
                let transcript = transcript(&hello, &peer.hello);
                let (arrived, arrival) = oneshot::channel();
                let _expected = node.pairing.expect(peer.id, Some(arrived))?;
                let proof = async {
                    let connection = arrival.await.map_err(|_| PROOF_FAILED)?;
                    prove_as_host(&node, &connection, &key, &transcript).await
                };
                timeout(timing.proof_timeout, proof).await.map_err(|_| PROOF_FAILED)??;
                Ok(peer.said())
            };
            // Five minutes from the code being made to a peer being proven, and not a second
            // more for a joiner who arrived at the end of them.
            timeout(timing.code_ttl, meeting).await.map_err(|_| EXPIRED)?
        }
    };
    let meta = pairings.begin(Role::Host, timing.code_ttl, exclusive, work)?;
    Ok(json!({ "pairingId": meta.id, "code": code, "expiresAt": meta.expires_at }))
}

/// Join a pairing by its code. Answers at once; everything that can go wrong from here is the
/// pairing's outcome.
pub(crate) fn join(node: &Arc<Node>, ask: Joining) -> Result<Value, ApiError> {
    let Joining { code, name, payload, exclusive, direct } = ask;
    if let Some(target) = direct {
        return join_direct(node, code, name, payload, exclusive, target);
    }
    let pairings = &node.pairing;
    let code = code_of(&code)?;
    let exclusive = allowed(node, exclusive.unwrap_or(false))?;
    let hello = hello(node, &name, payload)?;
    let config = config(pairings.mailbox(), hello.clone())?;

    let timing = pairings.0.timing;
    let work = {
        let node = node.clone();
        async move {
            let meeting = async {
                // `false`: a number nobody is waiting under is refused, not opened afresh.
                let mailbox = timeout(timing.mailbox_timeout, MailboxConnection::connect(config, code, false))
                    .await
                    .map_err(|_| MAILBOX_FAILED)?
                    .map_err(failure)?;
                let wormhole = Wormhole::connect(mailbox).await.map_err(failure)?;
                let (peer, key) = met(&node, wormhole).await?;
                let transcript = transcript(&peer.hello, &hello);
                let _expected = node.pairing.expect(peer.id, None)?;
                let proof = prove_as_joiner(&node, &peer, &key, &transcript);
                timeout(timing.proof_timeout, proof).await.map_err(|_| PROOF_FAILED)??;
                Ok(peer.said())
            };
            timeout(timing.join_timeout, meeting).await.map_err(|_| TIMED_OUT)?
        }
    };
    let meta = pairings.begin(Role::Join, timing.join_timeout, exclusive, work)?;
    Ok(json!({ "pairingId": meta.id, "expiresAt": meta.expires_at }))
}

/// The one-controller rule, as far as this process can see it: with `exclusive`, nobody may be
/// on the allowlist. Core owns the rule; this only refuses to be the way around it. Returns the
/// node to look at again when the pairing has somebody to report.
fn allowed(node: &Arc<Node>, exclusive: bool) -> Result<Option<Arc<Node>>, ApiError> {
    match exclusive {
        true if !node.peers.list().is_empty() => Err(ApiError::new(ALREADY_PAIRED, "a computer is already paired; unpair it first")),
        true => Ok(Some(node.clone())),
        false => Ok(None),
    }
}

fn config(mailbox: Option<Url>, hello: String) -> Result<AppConfig<Wire>, ApiError> {
    let url = mailbox.ok_or_else(|| ApiError::new(MAILBOX_NOT_CONFIGURED, "no mailbox server is configured"))?;
    Ok(AppConfig {
        id: AppID::new(PAIRING_APP_ID),
        rendezvous_url: Cow::Owned(url.to_string()),
        app_version: Wire { alexia: PAIRING_VERSION, hello },
    })
}

/// A code as somebody typed it: a number and four words. Anything that is not even that shape
/// is refused here, before the mailbox is troubled and the host's one attempt is spent.
fn code_of(typed: &str) -> Result<Code, ApiError> {
    let bad = || ApiError::new(BAD_REQUEST, "not a pairing code");
    let typed = typed.trim().to_ascii_lowercase();
    let mut parts = typed.split('-');
    let number = parts.next().unwrap_or_default();
    let words: Vec<&str> = parts.collect();
    let numbered = !number.is_empty() && number.len() <= 9 && number.bytes().all(|byte| byte.is_ascii_digit());
    let worded = words.len() == PAIRING_WORDS
        && words.iter().all(|word| !word.is_empty() && word.len() <= 32 && word.bytes().all(|byte| byte.is_ascii_lowercase()));
    match numbered && worded {
        true => typed.parse().map_err(|_| bad()),
        false => Err(bad()),
    }
}

// ---------------------------------------------------------------------------------------------
// What is said inside the wormhole
// ---------------------------------------------------------------------------------------------

/// What rides in the wormhole's encrypted `version` message. `hello` is JSON kept as the text
/// it was sent as, so that both sides hash the same bytes into the proof.
#[derive(Serialize, Deserialize)]
struct Wire {
    alexia: u32,
    hello: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Hello {
    endpoint_id: String,
    name: String,
    #[serde(default)]
    payload: Value,
    hints: Hints,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Hints {
    #[serde(default)]
    relay_url: Option<String>,
    #[serde(default)]
    direct_addresses: Vec<String>,
}

/// What the other side said it is. Not trusted for anything until the proof has run.
struct Named {
    id: EndpointId,
    /// Its `hello`, exactly as it arrived.
    hello: String,
    name: String,
    payload: Value,
    relay: Option<RelayUrl>,
    addresses: Vec<SocketAddr>,
}

impl Named {
    /// The peer, as core is told it. `hints` is what `PUT /v1/peers/{id}/hints` takes.
    fn said(&self) -> Value {
        json!({
            "endpointId": self.id.to_string(),
            "name": self.name,
            "payload": self.payload,
            "hints": {
                "relayUrl": self.relay.as_ref().map(RelayUrl::to_string),
                "directAddresses": self.addresses.iter().map(SocketAddr::to_string).collect::<Vec<_>>(),
            },
        })
    }
}

fn named(name: &str) -> bool {
    !name.is_empty() && name.len() <= PAIRING_NAME_MAX && !name.chars().any(char::is_control)
}

/// This computer's side of the exchange: who it is, what core wants said, where it is.
fn hello(node: &Node, name: &str, payload: Value) -> Result<String, ApiError> {
    let bad = |what: &str| ApiError::new(BAD_REQUEST, what.to_owned());
    if !named(name) {
        return Err(bad("not a display name"));
    }
    if serde_json::to_vec(&payload).map_or(true, |bytes| bytes.len() > PAIRING_PAYLOAD_MAX) {
        return Err(bad("the payload is too large"));
    }
    let endpoint = node.endpoint();
    let address = endpoint.addr();
    let mut addresses = own_addresses(node);
    if node.pairing.0.loopback_hints {
        addresses.extend(endpoint.bound_sockets().iter().map(|bound| match bound {
            SocketAddr::V4(bound) => SocketAddr::from((Ipv4Addr::LOCALHOST, bound.port())),
            SocketAddr::V6(bound) => SocketAddr::from((Ipv6Addr::LOCALHOST, bound.port())),
        }));
    }
    addresses.truncate(HINT_ADDRESSES_MAX);
    let hello = Hello {
        endpoint_id: endpoint.id().to_string(),
        name: name.to_owned(),
        payload,
        hints: Hints {
            relay_url: address.relay_urls().next().map(RelayUrl::to_string),
            direct_addresses: addresses.iter().map(SocketAddr::to_string).collect(),
        },
    };
    let hello = serde_json::to_string(&hello).map_err(|_| bad("not a payload that can be sent"))?;
    match hello.len() <= PAIRING_MESSAGE_MAX {
        true => Ok(hello),
        false => Err(bad("the pairing message is too large")),
    }
}

/// Where this computer can be dialled: what the endpoint reports, and the addresses core added
/// that it does not — a VPN's — on the endpoint's own port, for each address family it is bound in.
pub(crate) fn own_addresses(node: &Node) -> Vec<SocketAddr> {
    let endpoint = node.endpoint();
    let mut addresses: Vec<SocketAddr> = endpoint.addr().ip_addrs().copied().collect();
    for ip in node.extra() {
        for bound in endpoint.bound_sockets() {
            let said = SocketAddr::new(ip, bound.port());
            if bound.is_ipv4() == ip.is_ipv4() && !addresses.contains(&said) {
                addresses.push(said);
            }
        }
    }
    addresses.truncate(HINT_ADDRESSES_MAX);
    addresses
}

/// Read what the other side said, with every limit this side holds it to. A message that is
/// too large, too long-named or not this version is not a peer.
fn read(said: &Value, own: EndpointId) -> Result<Named, Failure> {
    let wire: Wire = Wire::deserialize(said).map_err(|_| PEER_INVALID)?;
    if wire.alexia != PAIRING_VERSION || wire.hello.len() > PAIRING_MESSAGE_MAX {
        return Err(PEER_INVALID);
    }
    let hello: Hello = serde_json::from_str(&wire.hello).map_err(|_| PEER_INVALID)?;
    let id = &hello.endpoint_id;
    let spelled = id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    let id: EndpointId = id.parse().ok().filter(|_| spelled).ok_or(PEER_INVALID)?;
    let payload = serde_json::to_vec(&hello.payload).map_err(|_| PEER_INVALID)?;
    // A peer that names this computer's own id is not somebody else.
    if id == own || !named(&hello.name) || payload.len() > PAIRING_PAYLOAD_MAX {
        return Err(PEER_INVALID);
    }
    if hello.hints.direct_addresses.len() > HINT_ADDRESSES_MAX {
        return Err(PEER_INVALID);
    }
    let relay = match &hello.hints.relay_url {
        Some(url) => match Url::parse(url) {
            Ok(url) if ["https", "http"].contains(&url.scheme()) && url.host().is_some() => Some(RelayUrl::from(url)),
            _ => return Err(PEER_INVALID),
        },
        None => None,
    };
    let addresses = hello.hints.direct_addresses.iter().map(|address| address.parse()).collect::<Result<_, _>>();
    let addresses = addresses.map_err(|_| PEER_INVALID)?;
    Ok(Named { id, hello: wire.hello, name: hello.name, payload: hello.payload, relay, addresses })
}

/// The proof's key: the wormhole's, for this one purpose. Never formatted, never kept.
#[derive(Debug)]
struct ProofKey;
impl KeyPurpose for ProofKey {}

type Secret = Zeroizing<[u8; 32]>;

/// The wormhole is open: both sides hold the same key and have read each other's `version`.
/// Take what the other side said and the proof's key out of it, and close it — the mailbox's
/// part is over, and the code with it.
async fn met(node: &Node, wormhole: Wormhole) -> Result<(Named, Secret), Failure> {
    let peer = read(wormhole.peer_version(), node.endpoint().id());
    let derived = wormhole.key().derive_subkey_from_purpose::<ProofKey>(PROOF_PURPOSE);
    let bytes: &[u8] = derived.as_ref();
    let mut key: Secret = Zeroizing::new([0; 32]);
    key.copy_from_slice(bytes);
    // Goodbye is a courtesy to the server. A server that does not answer it changes nothing.
    let _ = timeout(node.pairing.0.timing.mailbox_timeout, wormhole.close()).await;
    Ok((peer?, key))
}

/// Why the wormhole did not open, in the terms core is given. The error itself is not kept: it
/// can name the mailbox number.
fn failure(error: WormholeError) -> Failure {
    match error {
        WormholeError::PakeFailed => WRONG_CODE,
        WormholeError::UnclaimedNameplate(_) => CODE_UNKNOWN,
        // Two computers already hold that number: the code has had its one attempt.
        WormholeError::ServerError(RendezvousError::Server(reason)) if &*reason == "crowded" => CODE_UNKNOWN,
        WormholeError::ServerError(_) => MAILBOX_FAILED,
        _ => PEER_INVALID,
    }
}

// ---------------------------------------------------------------------------------------------
// Pairing without a mailbox
// ---------------------------------------------------------------------------------------------

/// What a direct pairing is spoken under. The host's gate lets it through from anybody, but only
/// while one direct pairing waits, and only once.
pub const DIRECT_ALPN: &[u8] = b"alexia/pairing-direct/1";

/// What the direct exchange's key is derived for.
const DIRECT_PURPOSE: &[u8] = b"alexia/pairing-direct/1/proof";

/// Open a direct pairing: no mailbox, a fresh four-word code, and a gate opened for the first
/// joiner. The joiner learns where this endpoint is from core, not from here.
fn host_direct(node: &Arc<Node>, name: String, payload: Value, exclusive: Option<bool>) -> Result<Value, ApiError> {
    let pairings = &node.pairing;
    let exclusive = allowed(node, exclusive.unwrap_or(true))?;
    let hello = hello(node, &name, payload)?;
    pairings.room()?;
    let code: String = magic_wormhole::Wordlist::default_wordlist(PAIRING_WORDS).choose_words().into();
    let (arrived, arrival) = oneshot::channel();
    {
        let mut table = pairings.table();
        if table.direct.as_ref().is_some_and(|waiting| !waiting.is_closed()) {
            return Err(ApiError::new(PAIRING_LIMIT, "a direct pairing is already waiting"));
        }
        table.direct = Some(arrived);
    }
    let timing = pairings.0.timing;
    let work = {
        let node = node.clone();
        let secret = Zeroizing::new(code.clone());
        async move {
            let meeting = async {
                let connection = arrival.await.map_err(|_| EXPIRED)?;
                let peer = exchange(&node, &connection, Side::Host, &secret, &hello).await;
                if peer.is_err() {
                    connection.close(CLOSE_NOT_PAIRED.into(), b"not proven");
                }
                peer
            };
            let outcome = timeout(timing.code_ttl, meeting).await.map_err(|_| EXPIRED)?;
            // One try: whatever happened, the gate is shut behind it.
            node.pairing.table().direct = None;
            outcome
        }
    };
    let meta = match pairings.begin(Role::Host, timing.code_ttl, exclusive, work) {
        Ok(meta) => meta,
        Err(error) => {
            pairings.table().direct = None;
            return Err(error);
        }
    };
    Ok(json!({ "pairingId": meta.id, "code": code, "expiresAt": meta.expires_at, "endpointId": node.endpoint().id().to_string() }))
}

/// Join a direct pairing at the endpoint core found. Answers at once, like [`join`].
fn join_direct(
    node: &Arc<Node>,
    code: String,
    name: String,
    payload: Value,
    exclusive: Option<bool>,
    target: Target,
) -> Result<Value, ApiError> {
    let bad = |what: &str| ApiError::new(BAD_REQUEST, what.to_owned());
    let pairings = &node.pairing;
    let code = direct_code(&code)?;
    let exclusive = allowed(node, exclusive.unwrap_or(false))?;
    let hello = hello(node, &name, payload)?;
    let spelled = target.endpoint_id.len() == 64 && target.endpoint_id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    let id: EndpointId = target.endpoint_id.parse().ok().filter(|_| spelled).ok_or_else(|| bad("not an endpoint id"))?;
    if id == node.endpoint().id() {
        return Err(bad("that is this computer"));
    }
    if target.addresses.len() > HINT_ADDRESSES_MAX {
        return Err(bad("too many addresses"));
    }
    let addresses: Vec<SocketAddr> =
        target.addresses.iter().map(|text| text.parse()).collect::<Result<_, _>>().map_err(|_| bad("not an address"))?;
    let address = EndpointAddr::from_parts(id, addresses.into_iter().map(TransportAddr::Ip));
    let timing = pairings.0.timing;
    let work = {
        let node = node.clone();
        async move {
            let meeting = async {
                // This side's gate lets the dial out to this one host, for as long as it takes.
                let _expected = node.pairing.expect(id, None)?;
                // The host may still be getting ready; a dial that is turned away is tried again.
                let connection = loop {
                    if let Ok(connection) = node.endpoint().connect(address.clone(), DIRECT_ALPN).await {
                        break connection;
                    }
                    sleep(PAIRING_REDIAL).await;
                };
                if connection.remote_id() != id {
                    return Err(PROOF_FAILED);
                }
                let peer = exchange(&node, &connection, Side::Join, &code, &hello).await;
                if peer.is_err() {
                    connection.close(CLOSE_NOT_PAIRED.into(), b"not proven");
                }
                peer
            };
            timeout(timing.join_timeout, meeting).await.map_err(|_| TIMED_OUT)?
        }
    };
    let meta = pairings.begin(Role::Join, timing.join_timeout, exclusive, work)?;
    Ok(json!({ "pairingId": meta.id, "expiresAt": meta.expires_at }))
}

/// A direct code as somebody typed it: four lowercase words, nothing else.
fn direct_code(typed: &str) -> Result<Zeroizing<String>, ApiError> {
    let typed = typed.trim().to_ascii_lowercase();
    let words: Vec<&str> = typed.split('-').collect();
    let worded = words.len() == PAIRING_WORDS
        && words.iter().all(|word| !word.is_empty() && word.len() <= 32 && word.bytes().all(|byte| byte.is_ascii_lowercase()));
    match worded {
        true => Ok(Zeroizing::new(typed)),
        false => Err(ApiError::new(BAD_REQUEST, "not a pairing code")),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Host,
    Join,
}

/// One length-prefixed message on a pairing stream.
async fn send_framed(send: &mut iroh::endpoint::SendStream, bytes: &[u8]) -> Result<(), Failure> {
    let length = u32::try_from(bytes.len()).map_err(|_| PEER_INVALID)?;
    send.write_all(&length.to_be_bytes()).await.map_err(|_| PEER_INVALID)?;
    send.write_all(bytes).await.map_err(|_| PEER_INVALID)
}

async fn read_framed(recv: &mut iroh::endpoint::RecvStream, most: usize) -> Result<Vec<u8>, Failure> {
    let mut length = [0; 4];
    recv.read_exact(&mut length).await.map_err(|_| PEER_INVALID)?;
    let length = usize::try_from(u32::from_be_bytes(length)).map_err(|_| PEER_INVALID)?;
    if length > most {
        return Err(PEER_INVALID);
    }
    let mut bytes = vec![0; length];
    recv.read_exact(&mut bytes).await.map_err(|_| PEER_INVALID)?;
    Ok(bytes)
}

/// The whole direct exchange, on one stream of a connection whose two endpoint ids iroh has
/// already authenticated. SPAKE2 under the code, bound to both ids; each side's hello and a
/// fresh nonce; then the same MACs the mailbox pairing proves with. A wrong code shows up as a
/// MAC that does not check — and that ends the pairing, so the code had one try.
async fn exchange(node: &Node, connection: &Connection, side: Side, code: &Zeroizing<String>, hello: &str) -> Result<Value, Failure> {
    use spake2::{Ed25519Group, Identity, Password, Spake2};
    let (own, peer) = (node.endpoint().id(), connection.remote_id());
    let (joiner, host) = match side {
        Side::Join => (own, peer),
        Side::Host => (peer, own),
    };
    let (id_a, id_b) = (Identity::new(joiner.as_bytes()), Identity::new(host.as_bytes()));
    let password = Password::new(code.as_bytes());
    let (state, outbound) = match side {
        Side::Join => Spake2::<Ed25519Group>::start_a(&password, &id_a, &id_b),
        Side::Host => Spake2::<Ed25519Group>::start_b(&password, &id_a, &id_b),
    };
    let nonce = random::<PAIRING_NONCE>()?;
    // A joiner whose host hangs up before saying anything found nobody waiting under that code:
    // the gate had already shut, after somebody else's one try.
    let nobody = |failure: Failure| if side == Side::Join { CODE_UNKNOWN } else { failure };
    let (mut send, mut recv) = match side {
        Side::Join => connection.open_bi().await.map_err(|_| CODE_UNKNOWN)?,
        Side::Host => connection.accept_bi().await.map_err(|_| PEER_INVALID)?,
    };
    send_framed(&mut send, &outbound).await.map_err(nobody)?;
    send_framed(&mut send, &nonce).await.map_err(nobody)?;
    send_framed(&mut send, hello.as_bytes()).await.map_err(nobody)?;
    let inbound = read_framed(&mut recv, 128).await.map_err(nobody)?;
    let theirs: [u8; PAIRING_NONCE] = read_framed(&mut recv, PAIRING_NONCE).await?.try_into().map_err(|_| PEER_INVALID)?;
    let said = String::from_utf8(read_framed(&mut recv, PAIRING_MESSAGE_MAX).await?).map_err(|_| PEER_INVALID)?;
    let shared = Zeroizing::new(state.finish(&inbound).map_err(|_| WRONG_CODE)?);

    // What the peer said must name the id iroh authenticated, or it is not a peer.
    let named = read(&json!({ "alexia": PAIRING_VERSION, "hello": said }), own)?;
    if named.id != peer {
        return Err(PROOF_FAILED);
    }
    let mut derive = <Hmac<Sha256> as KeyInit>::new_from_slice(shared.as_slice()).map_err(|_| PROOF_FAILED)?;
    derive.update(DIRECT_PURPOSE);
    let mut key: Secret = Zeroizing::new([0; 32]);
    key.copy_from_slice(&derive.finalize().into_bytes());
    let (host_hello, joiner_hello, nonces) = match side {
        Side::Join => (said.as_str(), hello, [&nonce, &theirs]),
        Side::Host => (hello, said.as_str(), [&theirs, &nonce]),
    };
    let transcript = transcript(host_hello, joiner_hello);
    let proof = Proof { key: &key, transcript: &transcript, nonces };
    let (mine, other) = match side {
        Side::Join => (JOIN, HOST),
        Side::Host => (HOST, JOIN),
    };
    // Each side hangs up on a tag that does not check, so whichever is slower finds the line cut
    // here: after the exchange, that is the other side refusing the code, not a broken peer.
    let refused = |_: Failure| WRONG_CODE;
    send_framed(&mut send, &proof.tag(mine, &own, &peer)?).await.map_err(refused)?;
    let tag = read_framed(&mut recv, PAIRING_TAG).await.map_err(refused)?;
    // A tag that does not check is, here, a code that was not the same on both sides.
    proof.check(other, &peer, &own, &tag).map_err(|_| WRONG_CODE)?;
    let _ = send.finish();
    let _ = timeout(PAIRING_LINGER, recv.read_to_end(0)).await;
    connection.close(CLOSE_NORMAL.into(), b"paired");
    Ok(named.said())
}

// ---------------------------------------------------------------------------------------------
// The proof, over iroh
// ---------------------------------------------------------------------------------------------

/// Everything both sides said, in the order host then joiner, each prefixed by its length.
fn transcript(host: &str, joiner: &str) -> [u8; 32] {
    let mut hash = Sha256::new();
    for hello in [host, joiner] {
        hash.update(u32::try_from(hello.len()).unwrap_or(u32::MAX).to_be_bytes());
        hash.update(hello.as_bytes());
    }
    hash.finalize().into()
}

struct Proof<'a> {
    key: &'a Secret,
    transcript: &'a [u8; 32],
    /// The joiner's nonce, then the host's.
    nonces: [&'a [u8; PAIRING_NONCE]; 2],
}

impl Proof<'_> {
    /// `signer` says: under this pairing's key, on this connection, I am `signer` and you are
    /// `other`. Both ids are the ones iroh authenticated, never the ones a message named.
    fn mac(&self, label: &[u8; 4], signer: &EndpointId, other: &EndpointId) -> Result<Hmac<Sha256>, Failure> {
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(self.key.as_slice()).map_err(|_| PROOF_FAILED)?;
        for part in [&label[..], self.transcript, signer.as_bytes(), other.as_bytes(), self.nonces[0], self.nonces[1]] {
            mac.update(part);
        }
        Ok(mac)
    }

    fn tag(&self, label: &[u8; 4], signer: &EndpointId, other: &EndpointId) -> Result<[u8; PAIRING_TAG], Failure> {
        Ok(self.mac(label, signer, other)?.finalize().into_bytes().into())
    }

    /// In constant time.
    fn check(&self, label: &[u8; 4], signer: &EndpointId, other: &EndpointId, tag: &[u8]) -> Result<(), Failure> {
        self.mac(label, signer, other)?.verify_slice(tag).map_err(|_| PROOF_FAILED)
    }
}

const HOST: &[u8; 4] = b"host";
const JOIN: &[u8; 4] = b"join";
const PROVEN: u8 = 1;

/// The host's half. The connection is from the endpoint the joiner named — the gate and
/// `Pairings::incoming` saw to that — and iroh has already made it prove it holds that key.
async fn prove_as_host(node: &Node, connection: &Connection, key: &Secret, transcript: &[u8; 32]) -> Result<(), Failure> {
    let (own, peer) = (node.endpoint().id(), connection.remote_id());
    let lost = |_| PROOF_FAILED;
    let (mut send, mut recv) = connection.accept_bi().await.map_err(lost)?;
    let mut theirs = [0; PAIRING_NONCE];
    recv.read_exact(&mut theirs).await.map_err(|_| PROOF_FAILED)?;
    let ours = random::<PAIRING_NONCE>()?;
    let proof = Proof { key, transcript, nonces: [&theirs, &ours] };

    send.write_all(&ours).await.map_err(|_| PROOF_FAILED)?;
    send.write_all(&proof.tag(HOST, &own, &peer)?).await.map_err(|_| PROOF_FAILED)?;
    let mut tag = [0; PAIRING_TAG];
    recv.read_exact(&mut tag).await.map_err(|_| PROOF_FAILED)?;
    if let Err(failed) = proof.check(JOIN, &peer, &own, &tag) {
        connection.close(CLOSE_NOT_PAIRED.into(), b"not proven");
        return Err(failed);
    }
    send.write_all(&[PROVEN]).await.map_err(|_| PROOF_FAILED)?;
    send.finish().map_err(|_| PROOF_FAILED)?;
    // The joiner hangs up when it has read that byte. Closing first could take the byte with it.
    let _ = timeout(PAIRING_LINGER, connection.closed()).await;
    connection.close(CLOSE_NORMAL.into(), b"paired");
    Ok(())
}

/// The joiner's half: dial the id the host named, where it said it would be. Whatever answers
/// has to hold that id's key to finish the handshake at all.
async fn prove_as_joiner(node: &Node, host: &Named, key: &Secret, transcript: &[u8; 32]) -> Result<(), Failure> {
    let endpoint = node.endpoint();
    let own = endpoint.id();
    let hinted = host.relay.iter().cloned().map(TransportAddr::Relay).chain(host.addresses.iter().copied().map(TransportAddr::Ip));
    let address = EndpointAddr::from_parts(host.id, hinted);
    loop {
        let ours = random::<PAIRING_NONCE>()?;
        // The host opens its gate when it has read this side's name, which may be a moment
        // after this side read the host's. A dial that is turned away is tried again until
        // the proof's time is up; an answer that is wrong is not.
        let opened = async {
            let connection = endpoint.connect(address.clone(), ALPN).await.ok()?;
            let (mut send, mut recv) = connection.open_bi().await.ok()?;
            send.write_all(&ours).await.ok()?;
            let mut answer = [0; PAIRING_NONCE + PAIRING_TAG];
            recv.read_exact(&mut answer).await.ok()?;
            Some((connection, send, recv, answer))
        };
        let Some((connection, mut send, mut recv, answer)) = opened.await else {
            sleep(PAIRING_REDIAL).await;
            continue;
        };
        let peer = connection.remote_id();
        let (theirs, tag) = answer.split_at(PAIRING_NONCE);
        let theirs: &[u8; PAIRING_NONCE] = theirs.try_into().map_err(|_| PROOF_FAILED)?;
        let proof = Proof { key, transcript, nonces: [&ours, theirs] };
        if peer != host.id || proof.check(HOST, &peer, &own, tag).is_err() {
            connection.close(CLOSE_NOT_PAIRED.into(), b"not proven");
            return Err(PROOF_FAILED);
        }
        send.write_all(&proof.tag(JOIN, &own, &peer)?).await.map_err(|_| PROOF_FAILED)?;
        let mut proven = [0; 1];
        recv.read_exact(&mut proven).await.map_err(|_| PROOF_FAILED)?;
        connection.close(CLOSE_NORMAL.into(), b"paired");
        return match proven[0] == PROVEN {
            true => Ok(()),
            false => Err(PROOF_FAILED),
        };
    }
}

// ---------------------------------------------------------------------------------------------

fn random<const N: usize>() -> Result<[u8; N], Failure> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).map_err(|_| PROOF_FAILED)?;
    Ok(bytes)
}

fn unusable() -> ApiError {
    ApiError::new(PAIRING_MAILBOX_FAILED, "no randomness to start a pairing with")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Milliseconds since the Unix epoch, `lifetime` from now.
fn after(lifetime: Duration) -> u64 {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    u64::try_from((now + lifetime).as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> EndpointId {
        iroh::SecretKey::generate().public()
    }

    fn said(id: &EndpointId, change: impl FnOnce(&mut Value)) -> Value {
        let mut hello = json!({
            "endpointId": id.to_string(),
            "name": "Studio PC",
            "payload": { "role": "compute" },
            "hints": { "relayUrl": null, "directAddresses": ["192.168.1.20:57835"] },
        });
        change(&mut hello);
        json!({ "alexia": PAIRING_VERSION, "hello": hello.to_string() })
    }

    #[test]
    fn a_code_is_a_number_and_four_words() {
        assert!(code_of("7-crossover-clockwork-guitarist-tonic").is_ok());
        assert!(code_of("  7-Crossover-Clockwork-Guitarist-Tonic\n").is_ok());
        for bad in ["", "7", "7-crossover-clockwork-guitarist", "7-a-b-c-d-e", "x-a-b-c-d", "7-a-b-c-d1", "7--b-c-d", "-a-b-c-d"] {
            assert!(code_of(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_mailbox_is_a_websocket_url() {
        assert!(Settings::mailbox("wss://mailbox.example.org/v1").is_ok());
        assert!(Settings::mailbox("ws://127.0.0.1:4000/v1").is_ok());
        assert!(Settings::mailbox("https://mailbox.example.org/v1").is_err());
        assert!(Settings::mailbox("mailbox.example.org").is_err());
    }

    #[test]
    fn what_a_peer_says_is_held_to_the_limits() {
        let (own, peer) = (id(), id());
        let read_as = |change: &dyn Fn(&mut Value)| read(&said(&peer, change), own).map(|named| named.id);
        assert_eq!(read_as(&|_| {}).ok(), Some(peer));

        // Its own id back, a name that is not one, more than it may send.
        assert!(read(&said(&own, |_| {}), own).is_err());
        assert!(read_as(&|hello| hello["endpointId"] = json!(peer.to_string().to_uppercase())).is_err());
        assert!(read_as(&|hello| hello["name"] = json!("")).is_err());
        assert!(read_as(&|hello| hello["name"] = json!("x".repeat(PAIRING_NAME_MAX + 1))).is_err());
        assert!(read_as(&|hello| hello["name"] = json!("two\nlines")).is_err());
        assert!(read_as(&|hello| hello["payload"] = json!("x".repeat(PAIRING_PAYLOAD_MAX))).is_err());
        assert!(read_as(&|hello| hello["hints"]["directAddresses"] = json!(vec!["10.0.0.1:1"; HINT_ADDRESSES_MAX + 1])).is_err());
        assert!(read_as(&|hello| hello["hints"]["directAddresses"] = json!(["not an address"])).is_err());
        assert!(read_as(&|hello| hello["hints"]["relayUrl"] = json!("ftp://relay.example.org")).is_err());

        // Another version, another application, or simply too much of it.
        assert!(read(&json!({ "alexia": PAIRING_VERSION + 1, "hello": "{}" }), own).is_err());
        assert!(read(&json!({ "abilities": ["transfer-v1"] }), own).is_err());
        let long = json!({ "alexia": PAIRING_VERSION, "hello": " ".repeat(PAIRING_MESSAGE_MAX + 1) });
        assert!(read(&long, own).is_err());
    }

    #[test]
    fn a_tag_is_for_one_pairing_one_direction_and_one_pair_of_ids() {
        let (key, other_key): (Secret, Secret) = (Zeroizing::new([1; 32]), Zeroizing::new([2; 32]));
        let (host, joiner, stranger) = (id(), id(), id());
        let (transcript, other_transcript) = (transcript("host", "joiner"), transcript("hos", "tjoiner"));
        let nonces = [&[3; PAIRING_NONCE], &[4; PAIRING_NONCE]];
        let proof = Proof { key: &key, transcript: &transcript, nonces };
        let tag = proof.tag(HOST, &host, &joiner).unwrap();

        assert!(proof.check(HOST, &host, &joiner, &tag).is_ok());
        assert!(proof.check(JOIN, &host, &joiner, &tag).is_err());
        assert!(proof.check(HOST, &joiner, &host, &tag).is_err());
        assert!(proof.check(HOST, &stranger, &joiner, &tag).is_err());
        assert!(proof.check(HOST, &host, &joiner, &tag[..PAIRING_TAG - 1]).is_err());
        assert!(Proof { key: &other_key, transcript: &transcript, nonces }.check(HOST, &host, &joiner, &tag).is_err());
        assert!(Proof { key: &key, transcript: &other_transcript, nonces }.check(HOST, &host, &joiner, &tag).is_err());
        let replayed = [&[3; PAIRING_NONCE], &[5; PAIRING_NONCE]];
        assert!(Proof { key: &key, transcript: &transcript, nonces: replayed }.check(HOST, &host, &joiner, &tag).is_err());
    }
}
