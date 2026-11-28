// SPDX-License-Identifier: AGPL-3.0-only
//! Pairing a device with the hub: the offer, the code and the hello each side sends (HB-18).
//!
//! connect's direct pairing (`connect/README.md`, *Pairing without a mailbox*): the hub opens a
//! four-word code for five minutes, one attempt; the limb dials the hub's endpoint id at the
//! addresses in the URI, and both run SPAKE2 over iroh. connect reports a proven peer; only this
//! module trusts it, by writing a `devices` row and syncing the allowlist (D-P4-2).
//!
//! The code is a secret: it is in the URI and the offer, and never in a log line or the store.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use alexia_store::DeviceRow;
use reqwest::Method;
use serde_json::{json, Value};

use crate::node::Node;
use crate::{DeviceId, EndpointId, Error, Hello, MeshEvent, PairOffer, Result, Role, PAIR_SCHEME};

/// connect's limit on a pairing's addresses and on a name.
const ADDRESSES_MAX: usize = 16;
const NAME_MAX: usize = 128;
/// The words in a direct code, and the longest one connect accepts.
const CODE_WORDS: usize = 4;
const WORD_MAX: usize = 32;
/// A request that is not a wait: connect answers these at once.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Beyond the pairing's own deadline, how long a `?wait=true` may be held.
const WAIT_SLACK: Duration = Duration::from_secs(60);

pub const EXPIRED: &str =
    "The pairing code ran out. Start a new one with `alexia-hub devices pair`.";
pub const WRONG_CODE: &str =
    "That code did not match. It can't be used again; start a new pairing.";
pub const NOBODY_WAITING: &str = "Nothing is waiting for that code. Check the PC shows it and the two computers are on the same network (or Tailscale).";
pub const PROOF_FAILED: &str = "The other computer could not prove who it is. Nothing was paired.";
pub const NOT_A_LIMB: &str = "That is not an Alexia limb.";
pub const NOT_A_HUB: &str = "That is not an Alexia hub.";
pub const CANCELLED: &str = "The pairing was cancelled. Nothing was paired.";
pub const BAD_URI: &str = "That is not an Alexia pairing code.";

/// What a pairing URI says: where the hub is, its code and what it is called.
#[derive(Clone, Debug, PartialEq)]
pub struct PairUri {
    pub endpoint: EndpointId,
    pub code: String,
    pub addresses: Vec<SocketAddr>,
    pub name: String,
}

/// `alexia-pair:1?e=<64 hex>&c=<four-words>&a=<addr>,<addr>&n=<percent-encoded name>`.
pub fn pair_uri(p: &PairUri) -> String {
    let addresses: Vec<String> = p.addresses.iter().map(SocketAddr::to_string).collect();
    format!(
        "{PAIR_SCHEME}?e={}&c={}&a={}&n={}",
        p.endpoint.0,
        p.code,
        addresses.join(","),
        percent_encode(&p.name)
    )
}

/// The URI's parts, or None for anything not exactly the shape [`pair_uri`] writes: each of
/// `e`, `c`, `a`, `n` once and nothing else, a 64-hex endpoint, a code of four lowercase words,
/// at most 16 addresses, a name of 1–128 bytes without control characters.
pub fn parse_pair_uri(s: &str) -> Option<PairUri> {
    let query = s.trim().strip_prefix(PAIR_SCHEME)?.strip_prefix('?')?;
    let (mut e, mut c, mut a, mut n) = (None, None, None, None);
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=')?;
        let slot = match k {
            "e" => &mut e,
            "c" => &mut c,
            "a" => &mut a,
            "n" => &mut n,
            _ => return None,
        };
        if slot.replace(v).is_some() {
            return None;
        }
    }
    let endpoint = EndpointId::parse(e?)?;
    let code = c?;
    if !code_shaped(code) {
        return None;
    }
    let a = a?;
    let addresses: Vec<SocketAddr> = if a.is_empty() {
        vec![]
    } else {
        a.split(',')
            .map(|s| s.parse().ok())
            .collect::<Option<_>>()?
    };
    let name = percent_decode(n?)?;
    if addresses.len() > ADDRESSES_MAX || !name_ok(&name) {
        return None;
    }
    Some(PairUri {
        endpoint,
        code: code.to_string(),
        addresses,
        name,
    })
}

/// As connect checks a direct code, but strictly lowercase (a URI is written, not typed).
fn code_shaped(code: &str) -> bool {
    let words: Vec<&str> = code.split('-').collect();
    words.len() == CODE_WORDS
        && words
            .iter()
            .all(|w| (1..=WORD_MAX).contains(&w.len()) && w.bytes().all(|b| b.is_ascii_lowercase()))
}

fn name_ok(name: &str) -> bool {
    (1..=NAME_MAX).contains(&name.len()) && !name.chars().any(char::is_control)
}

fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Strict: only unreserved characters and `%XX`, and the bytes must be UTF-8.
fn percent_decode(s: &str) -> Option<String> {
    let mut out = Vec::new();
    let mut bytes = s.bytes();
    while let Some(b) = bytes.next() {
        match b {
            b'%' => {
                let hex = [bytes.next()?, bytes.next()?];
                out.push(u8::from_str_radix(std::str::from_utf8(&hex).ok()?, 16).ok()?);
            }
            b if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') => out.push(b),
            _ => return None,
        }
    }
    String::from_utf8(out).ok()
}

/// The pairings this process cancelled, by connect's pairing id: a `paired` that raced the
/// cancel is not honoured.
fn cancelled() -> std::sync::MutexGuard<'static, HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// connect's API at this node's loopback address.
async fn call(
    node: &Node,
    method: Method,
    path: &str,
    body: Option<Value>,
    wait: Duration,
) -> Result<Value> {
    let (base, secret) = node.loopback();
    let http = reqwest::Client::builder()
        // Loopback only: a proxy from the environment must never see the secret.
        .no_proxy()
        .build()
        .map_err(|e| Error::Connect(format!("the HTTP client could not be made ({e}).")))?;
    let mut req = http
        .request(method, format!("{base}{path}"))
        .bearer_auth(secret)
        .timeout(wait);
    if let Some(body) = body {
        req = req.json(&body);
    }
    let res = req
        .send()
        .await
        .map_err(|e| Error::Connect(format!("connect did not answer ({}).", e.without_url())))?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(body);
    }
    let code = body["error"]["code"].as_str().unwrap_or("unknown");
    Err(match code {
        "pairing_limit" => Error::Bad(
            "Another pairing is already waiting. Finish it or let it run out first.".into(),
        ),
        "already_paired" => Error::Bad("This computer is already paired with another.".into()),
        _ => Error::Connect(format!("connect answered {status} with code {code}.")),
    })
}

/// How long a `?wait=true` for a pairing that settles by `expires_at` may be held.
fn wait_for(expires_at: i64) -> Duration {
    let left = (expires_at - alexia_store::now_ms()).max(0) as u64;
    Duration::from_millis(left) + WAIT_SLACK
}

/// A failed pairing's code, as the sentence the owner reads.
fn failure(code: &str) -> Error {
    Error::Bad(match code {
        "pairing_expired" => EXPIRED.into(),
        "pairing_wrong_code" => WRONG_CODE.into(),
        "pairing_code_unknown" | "pairing_timeout" => NOBODY_WAITING.into(),
        "pairing_proof_failed" => PROOF_FAILED.into(),
        "pairing_cancelled" => CANCELLED.into(),
        other => format!("The pairing failed ({other}). Nothing was paired."),
    })
}

impl Node {
    /// Hub: POST /v1/pairing/host {"name","payload":Hello,"exclusive":false,"direct":true}.
    pub async fn pair_offer(&self, hello: &Hello) -> Result<PairOffer> {
        let status = call(self, Method::GET, "/v1/status", None, REQUEST_TIMEOUT).await?;
        let mut addresses: Vec<SocketAddr> = status["directAddresses"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|a| a.as_str()?.parse().ok())
            .collect();
        addresses.truncate(ADDRESSES_MAX);
        let body =
            json!({ "name": self.name(), "payload": hello, "exclusive": false, "direct": true });
        let res = call(
            self,
            Method::POST,
            "/v1/pairing/host",
            Some(body),
            REQUEST_TIMEOUT,
        )
        .await?;
        let (Some(code), Some(expires_at)) = (res["code"].as_str(), res["expiresAt"].as_i64())
        else {
            return Err(Error::Connect(
                "connect answered a pairing with no code.".into(),
            ));
        };
        let uri = pair_uri(&PairUri {
            endpoint: self.endpoint(),
            code: code.to_string(),
            addresses,
            name: self.name().to_string(),
        });
        Ok(PairOffer {
            qr_text: crate::qr::qr_text(&uri),
            qr_svg: crate::qr::qr_svg(&uri),
            code: code.to_string(),
            expires_at,
            uri,
        })
    }

    /// Hub: waits for the offer to settle (GET /v1/pairing/{id}?wait=true); on `paired` writes
    /// the device (role from its Hello must be `limb`), syncs the allowlist and hints.
    pub async fn pair_wait(&self, offer: &PairOffer) -> Result<DeviceRow> {
        let id = self.offer_id(offer).await?;
        self.settle(&id, offer.expires_at, Role::Limb).await
    }

    /// Hub: cancel an offer. A `paired` that raced the cancel is not honoured, here or by a
    /// [`Node::pair_wait`] still running on it.
    pub async fn pair_cancel(&self, offer: &PairOffer) -> Result<()> {
        let id = self.offer_id(offer).await?;
        cancelled().insert(id.clone());
        let path = format!("/v1/pairing/{id}");
        let res = call(self, Method::DELETE, &path, None, REQUEST_TIMEOUT).await?;
        if res["cancelled"].as_bool() == Some(true) {
            return Ok(());
        }
        // It had settled. If it settled `paired` and pair_wait already wrote the row, undo it.
        let said = call(self, Method::GET, &path, None, REQUEST_TIMEOUT).await?;
        if let Some(endpoint) = said["peer"]["endpointId"].as_str() {
            if let Some(row) = self.store().device_by_endpoint(endpoint)? {
                if row.revoked_at.is_none() && row.paired_at >= offer.expires_at - FIVE_MINUTES_MS {
                    // A failed DELETE is made good by the sync below (the row is revoked).
                    let _ = self.revoke(&DeviceId(row.id)).await;
                }
            }
            self.sync_allowlist().await?;
        }
        Ok(())
    }

    /// Limb: parses the URI and joins with {"code","name","payload","direct":{"endpointId","addresses"}}.
    /// On `paired` writes the hub's row (role must be `hub`) and syncs. Err with a sentence on each failure code.
    pub async fn pair_join(&self, uri: &str, hello: &Hello) -> Result<DeviceRow> {
        let p = parse_pair_uri(uri).ok_or_else(|| Error::Bad(BAD_URI.into()))?;
        let addresses: Vec<String> = p.addresses.iter().map(SocketAddr::to_string).collect();
        let body = json!({
            "code": p.code,
            "name": self.name(),
            "payload": hello,
            "direct": { "endpointId": p.endpoint.0, "addresses": addresses },
        });
        let res = call(
            self,
            Method::POST,
            "/v1/pairing/join",
            Some(body),
            REQUEST_TIMEOUT,
        )
        .await?;
        let (Some(id), Some(expires_at)) = (res["pairingId"].as_str(), res["expiresAt"].as_i64())
        else {
            return Err(Error::Connect(
                "connect answered a join with no pairing id.".into(),
            ));
        };
        let row = self.settle(id, expires_at, Role::Hub).await?;
        if row.endpoint != p.endpoint.0 {
            // connect dials exactly that id, so this is connect misbehaving; trust nothing.
            let _ = self.revoke(&DeviceId(row.id)).await;
            self.sync_allowlist().await?;
            return Err(Error::Bad(PROOF_FAILED.into()));
        }
        Ok(row)
    }

    /// connect's id for the hosted pairing `offer` names. Only one direct pairing waits at a
    /// time, so its deadline names it.
    async fn offer_id(&self, offer: &PairOffer) -> Result<String> {
        let list = call(self, Method::GET, "/v1/pairing", None, REQUEST_TIMEOUT).await?;
        list["pairings"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["role"] == "host" && p["expiresAt"].as_i64() == Some(offer.expires_at))
            .and_then(|p| p["pairingId"].as_str())
            .map(str::to_string)
            .ok_or_else(|| Error::Bad(EXPIRED.into()))
    }

    /// Wait for pairing `id` to settle; on `paired` with a peer whose Hello says `want`, write
    /// its row, sync connect and announce it.
    async fn settle(&self, id: &str, expires_at: i64, want: Role) -> Result<DeviceRow> {
        let path = format!("/v1/pairing/{id}?wait=true");
        let said = call(self, Method::GET, &path, None, wait_for(expires_at)).await?;
        match said["state"].as_str() {
            Some("paired") => {}
            Some("failed") => return Err(failure(said["error"]["code"].as_str().unwrap_or(""))),
            _ => {
                return Err(Error::Connect(
                    "connect answered a pairing that had not settled.".into(),
                ))
            }
        }
        let peer = &said["peer"];
        let endpoint = peer["endpointId"]
            .as_str()
            .and_then(EndpointId::parse)
            .ok_or_else(|| Error::Connect("connect named a malformed peer.".into()))?;
        if cancelled().contains(id) {
            return Err(Error::Bad(CANCELLED.into()));
        }
        let hello = serde_json::from_value::<Hello>(peer["payload"].clone())
            .ok()
            .filter(|h| h.role == want);
        let Some(hello) = hello else {
            // Never on the allowlist; make sure of it, and of any older row for that endpoint.
            if let Some(row) = self.store().device_by_endpoint(&endpoint.0)? {
                let _ = self.revoke(&DeviceId(row.id)).await;
            }
            self.sync_allowlist().await?;
            return Err(Error::Bad(
                match want {
                    Role::Limb => NOT_A_LIMB,
                    Role::Hub => NOT_A_HUB,
                }
                .into(),
            ));
        };
        let name = peer["name"]
            .as_str()
            .filter(|n| name_ok(n))
            .unwrap_or("device")
            .to_string();
        let store = self.store();
        // A re-pairing keeps the device's id; a new one gets a fresh id from its name.
        let id = match store.device_by_endpoint(&endpoint.0)? {
            Some(old) => DeviceId(old.id),
            None => {
                let taken: Vec<DeviceId> = store
                    .devices()?
                    .into_iter()
                    .map(|d| DeviceId(d.id))
                    .collect();
                DeviceId::from_name(&name, &taken)
            }
        };
        let row = DeviceRow {
            id: id.0.clone(),
            name,
            endpoint: endpoint.0,
            role: match want {
                Role::Limb => "limb",
                Role::Hub => "hub",
            }
            .into(),
            platform: hello.platform.clone(),
            hello: peer["payload"].clone(),
            hints: peer["hints"].clone(),
            paired_at: alexia_store::now_ms(),
            last_seen: None,
            revoked_at: None,
        };
        store.device_put(&row)?;
        self.sync_allowlist().await?;
        self.emit(MeshEvent::Paired { device: id });
        Ok(row)
    }
}

/// A code's life: its pairing's rows are the ones written in the five minutes before expiry.
const FIVE_MINUTES_MS: i64 = 5 * 60 * 1000;
