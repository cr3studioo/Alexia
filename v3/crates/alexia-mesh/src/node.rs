// SPDX-License-Identifier: AGPL-3.0-only
//! This device's mesh node: the connect sidecar it runs and the endpoint identity it holds.
//!
//! connect runs inside this process (`alexia_connect::start`), not as a child. The allowlist is
//! exactly the store's non-revoked devices; connect's peer events become [`MeshEvent`]s.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use alexia_connect::{pairing, Network, Options, Running};
use serde_json::Value;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::control::Control;
use crate::{DeviceId, EndpointId, Error, MeshEvent, Reach, Result, Role};

/// How many events a slow subscriber may fall behind before it misses some.
const EVENTS_HELD: usize = 64;

pub struct NodeConfig {
    /// KEYCHAIN_HUB or KEYCHAIN_LIMB.
    pub keychain: String,
    /// Shown on the other device.
    pub name: String,
    pub role: Role,
    /// Tests: a fresh key in memory, no keychain (connect's debug-only switch is not used).
    pub ephemeral: bool,
    /// Extra addresses this device is reachable at (Tailscale), D-P4-2.
    pub extra_addresses: Vec<std::net::IpAddr>,
}

pub struct Node {
    running: Mutex<Option<Running>>,
    endpoint: EndpointId,
    port: u16,
    secret: String,
    name: String,
    role: Role,
    control: Control,
    store: Arc<alexia_store::Store>,
    events: broadcast::Sender<MeshEvent>,
    follower: Mutex<Option<JoinHandle<()>>>,
}

impl Node {
    pub async fn start(cfg: NodeConfig, store: Arc<alexia_store::Store>) -> Result<Arc<Node>> {
        let key = if cfg.ephemeral {
            iroh::SecretKey::generate()
        } else {
            let service = cfg.keychain.clone();
            tokio::task::spawn_blocking(move || alexia_connect::identity::load_or_create(&service))
                .await
                .map_err(|_| Error::Connect("reading the keychain stopped.".into()))?
                .map_err(|e| Error::Connect(format!("the keychain refused the key ({e}).")))?
        };
        // 32 random bytes from the OS's CSPRNG, as hex: a fresh key's bytes are exactly that.
        let secret: String = iroh::SecretKey::generate()
            .to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let network = Network::new::<&str>(&[], None).map_err(Error::Connect)?;
        let running = alexia_connect::start(Options {
            secret: secret.clone(),
            key,
            network,
            pairing: pairing::Settings::default(), // no mailbox
        })
        .await
        .map_err(|e| Error::Connect(format!("connect did not start ({}).", e.message)))?;
        let port = running.port();
        let endpoint = EndpointId::parse(&running.endpoint_id())
            .ok_or_else(|| Error::Connect("connect named a malformed endpoint id.".into()))?;
        let control = Control::new(format!("http://127.0.0.1:{port}"), secret.clone())?;
        let (events, _) = broadcast::channel(EVENTS_HELD);
        let node = Arc::new(Node {
            running: Mutex::new(Some(running)),
            endpoint,
            port,
            secret,
            name: cfg.name,
            role: cfg.role,
            control,
            store,
            events,
            follower: Mutex::new(None),
        });
        let setup = async {
            node.control
                .put_self_addresses(&cfg.extra_addresses)
                .await?;
            node.sync_allowlist().await
        };
        if let Err(e) = setup.await {
            node.clone().close().await;
            return Err(e);
        }
        let follower = tokio::spawn(follow(
            node.control.clone(),
            node.store.clone(),
            node.events.clone(),
        ));
        *lock(&node.follower) = Some(follower);
        Ok(node)
    }

    pub fn endpoint(&self) -> EndpointId {
        self.endpoint.clone()
    }

    pub fn role(&self) -> Role {
        self.role
    }

    /// What this device is called on the other one.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// `http://127.0.0.1:{port}` and the per-launch secret, for link.rs and ops.rs.
    pub fn loopback(&self) -> (String, String) {
        (
            format!("http://127.0.0.1:{}", self.port),
            self.secret.clone(),
        )
    }

    /// Re-reads `devices` and replaces connect's allowlist and hints with it.
    pub async fn sync_allowlist(&self) -> Result<()> {
        let devices = self.store.devices()?;
        let endpoints: Vec<String> = devices.iter().map(|d| d.endpoint.clone()).collect();
        self.control.put_allowlist(&endpoints).await?;
        for d in &devices {
            // Only the two fields connect knows: it refuses an unknown one.
            let mut hints = serde_json::Map::new();
            for k in ["relayUrl", "directAddresses"] {
                if let Some(v) = d.hints.get(k) {
                    hints.insert(k.into(), v.clone());
                }
            }
            if !hints.is_empty() {
                self.control
                    .put_hints(&d.endpoint, Value::Object(hints))
                    .await?;
            }
        }
        Ok(())
    }

    /// Revoke `device` in the store and in connect. false if it was not paired (or already revoked).
    pub async fn revoke(&self, device: &DeviceId) -> Result<bool> {
        let Some(row) = self.store.device(&device.0)? else {
            return Ok(false);
        };
        let revoked = self.store.device_revoke(&row.id, alexia_store::now_ms())?;
        self.control.revoke(&row.endpoint).await?;
        if revoked {
            let _ = self.events.send(MeshEvent::Revoked {
                device: device.clone(),
            });
        }
        Ok(revoked)
    }

    /// Connect to a paired device now rather than at the first request.
    pub async fn connect(&self, device: &DeviceId) -> Result<Reach> {
        let row = self
            .store
            .device(&device.0)?
            .filter(|d| d.revoked_at.is_none())
            .ok_or(Error::NotPaired)?;
        let status = self.control.connect(&row.endpoint).await?;
        reach(&status).ok_or_else(|| Error::Connect(format!("connect answered status {status}.")))
    }

    pub async fn status(&self) -> Result<Value> {
        self.control.status().await
    }

    pub fn events(&self) -> broadcast::Receiver<MeshEvent> {
        self.events.subscribe()
    }

    /// The store this node keeps its devices in, for pair.rs.
    pub(crate) fn store(&self) -> &Arc<alexia_store::Store> {
        &self.store
    }

    /// Send `event` to every subscriber, for pair.rs.
    pub(crate) fn emit(&self, event: MeshEvent) {
        let _ = self.events.send(event);
    }

    /// Stop following events and close connect. A second call does nothing.
    pub async fn close(self: Arc<Self>) {
        if let Some(f) = lock(&self.follower).take() {
            f.abort();
        }
        let running = lock(&self.running).take();
        if let Some(running) = running {
            running.close().await;
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn reach(status: &str) -> Option<Reach> {
    match status {
        "direct" => Some(Reach::Direct),
        "relayed" => Some(Reach::Relayed),
        "offline" => Some(Reach::Offline),
        _ => None,
    }
}

/// connect's events, as `MeshEvent`s: one per change of a known device's reach.
async fn follow(
    control: Control,
    store: Arc<alexia_store::Store>,
    tx: broadcast::Sender<MeshEvent>,
) {
    // endpoint → last reach; anything absent is offline.
    let mut known: HashMap<String, Reach> = HashMap::new();
    let change = |endpoint: &str, now: Reach, known: &mut HashMap<String, Reach>| {
        let was = known
            .insert(endpoint.to_string(), now)
            .unwrap_or(Reach::Offline);
        if was == now {
            return;
        }
        // Revoked rows still name the device, so a revoke's `offline` reaches subscribers.
        let Ok(Some(row)) = store.device_by_endpoint(endpoint) else {
            return;
        };
        let _ = store.device_seen(&row.id, alexia_store::now_ms());
        let device = DeviceId(row.id);
        let _ = tx.send(match now {
            Reach::Offline => MeshEvent::Offline { device },
            reach => MeshEvent::Online { device, reach },
        });
    };
    control
        .follow(|name, data| match name {
            "snapshot" => {
                let mut next: HashMap<String, Reach> = HashMap::new();
                for p in data["peers"].as_array().into_iter().flatten() {
                    if let (Some(id), Some(r)) = (p["endpointId"].as_str(), peer_reach(p)) {
                        next.insert(id.to_string(), r);
                    }
                }
                let gone: Vec<String> = known
                    .keys()
                    .filter(|k| !next.contains_key(*k))
                    .cloned()
                    .collect();
                for id in gone {
                    change(&id, Reach::Offline, &mut known);
                }
                for (id, r) in next {
                    change(&id, r, &mut known);
                }
            }
            "peer" => {
                if let (Some(id), Some(r)) = (data["endpointId"].as_str(), peer_reach(&data)) {
                    change(id, r, &mut known);
                }
            }
            _ => {} // pairing and anything newer: not this module's
        })
        .await
}

fn peer_reach(p: &Value) -> Option<Reach> {
    reach(p["status"].as_str()?)
}
