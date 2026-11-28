// SPDX-License-Identifier: AGPL-3.0-only
//! (P4-04) Two ephemeral nodes in one process, each with a scratch store, finding each other
//! over loopback hints.

use std::fmt::Debug;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use alexia_mesh::node::{Node, NodeConfig};
use alexia_mesh::{DeviceId, MeshEvent, Reach, Role, KEYCHAIN_HUB, KEYCHAIN_LIMB};
use alexia_store::{DeviceRow, Store};
use serde_json::{json, Value};
use tokio::sync::broadcast;

/// Generous: a loaded Windows machine dialling over loopback.
const WAIT: Duration = Duration::from_secs(45);

async fn start(role: Role) -> (Arc<Node>, Arc<Store>) {
    let store = Arc::new(Store::open_in_memory().expect("store"));
    let cfg = NodeConfig {
        keychain: match role {
            Role::Hub => KEYCHAIN_HUB,
            Role::Limb => KEYCHAIN_LIMB,
        }
        .to_string(),
        name: format!("test {role:?}"),
        role,
        ephemeral: true,
        extra_addresses: vec![],
    };
    let node = Node::start(cfg, store.clone()).await.expect("node starts");
    (node, store)
}

fn row(id: &str, endpoint: &str, role: &str, hints: Value) -> DeviceRow {
    DeviceRow {
        id: id.into(),
        name: id.into(),
        endpoint: endpoint.into(),
        role: role.into(),
        platform: "test".into(),
        hello: json!({}),
        hints,
        paired_at: alexia_store::now_ms(),
        last_seen: None,
        revoked_at: None,
    }
}

/// A fresh, never-running endpoint id.
fn stranger() -> String {
    iroh::SecretKey::generate().public().to_string()
}

/// connect's own API, as a client would call it.
async fn get(node: &Node, path: &str) -> Value {
    let (base, secret) = node.loopback();
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("{base}{path}"))
        .bearer_auth(secret)
        .send()
        .await
        .expect("connect answers")
        .json()
        .await
        .expect("json")
}

async fn listed(node: &Node) -> Vec<String> {
    get(node, "/v1/peers").await["peers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["endpointId"].as_str().unwrap().to_string())
        .collect()
}

/// Where `node` answers on this machine: its IPv4 socket's port on 127.0.0.1.
async fn loopback_hints(node: &Node) -> Value {
    let status = node.status().await.expect("status");
    let addresses: Vec<String> = status["boundAddresses"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|a| a.as_str()?.strip_prefix("0.0.0.0:"))
        .map(|port| format!("127.0.0.1:{port}"))
        .collect();
    assert!(!addresses.is_empty(), "an IPv4 socket: {status}");
    json!({ "directAddresses": addresses })
}

async fn wait_for(rx: &mut broadcast::Receiver<MeshEvent>, want: impl Fn(&MeshEvent) -> bool) {
    tokio::time::timeout(WAIT, async {
        loop {
            match rx.recv().await {
                Ok(e) if want(&e) => return,
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(e) => panic!("events ended: {e}"),
            }
        }
    })
    .await
    .expect("the event arrives in time")
}

fn online(device: &str) -> impl Fn(&MeshEvent) -> bool + '_ {
    move |e| matches!(e, MeshEvent::Online { device: d, reach } if d.0 == device && *reach != Reach::Offline)
}

fn offline(device: &str) -> impl Fn(&MeshEvent) -> bool + '_ {
    move |e| matches!(e, MeshEvent::Offline { device: d } if d.0 == device)
}

/// A hub "h" and a limb "l", each with the other's row and loopback hints, both online.
async fn paired() -> ((Arc<Node>, Arc<Store>), (Arc<Node>, Arc<Store>)) {
    let (hub, hub_store) = start(Role::Hub).await;
    let (limb, limb_store) = start(Role::Limb).await;
    hub_store
        .device_put(&row(
            "l",
            &limb.endpoint().0,
            "limb",
            loopback_hints(&limb).await,
        ))
        .unwrap();
    limb_store
        .device_put(&row(
            "h",
            &hub.endpoint().0,
            "hub",
            loopback_hints(&hub).await,
        ))
        .unwrap();
    hub.sync_allowlist().await.unwrap();
    limb.sync_allowlist().await.unwrap();

    let (mut hub_rx, mut limb_rx) = (hub.events(), limb.events());
    let reach = hub.connect(&DeviceId("l".into())).await.expect("connects");
    assert_ne!(reach, Reach::Offline);
    wait_for(&mut hub_rx, online("l")).await;
    wait_for(&mut limb_rx, online("h")).await;
    ((hub, hub_store), (limb, limb_store))
}

#[tokio::test]
async fn starts_and_reports_endpoint() {
    let (node, _) = start(Role::Hub).await;
    let id = node.endpoint().0;
    assert_eq!(id.len(), 64);
    assert!(id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
    assert_eq!(node.role(), Role::Hub);

    let (base, secret) = node.loopback();
    let port: u16 = base
        .strip_prefix("http://127.0.0.1:")
        .expect("loopback only")
        .parse()
        .unwrap();
    assert!(secret.len() >= 32);
    assert_eq!(node.status().await.unwrap()["endpointId"], id);
    // Not on the IPv6 loopback either: 127.0.0.1 and nothing else.
    assert!(tokio::net::TcpStream::connect(("::1", port)).await.is_err());
    node.close().await;
}

#[tokio::test]
async fn allowlist_is_the_store() {
    let (node, store) = start(Role::Hub).await;
    assert!(listed(&node).await.is_empty());

    let (a, b) = (stranger(), stranger());
    store.device_put(&row("a", &a, "limb", json!({}))).unwrap();
    store
        .device_put(&row(
            "b",
            &b,
            "limb",
            json!({ "directAddresses": ["127.0.0.1:9"] }),
        ))
        .unwrap();
    node.sync_allowlist().await.unwrap();
    let mut both = vec![a.clone(), b.clone()];
    both.sort();
    assert_eq!(listed(&node).await, both);

    // Revoked in the store alone: the next sync drops it.
    assert!(store.device_revoke("a", alexia_store::now_ms()).unwrap());
    node.sync_allowlist().await.unwrap();
    assert_eq!(listed(&node).await, vec![b.clone()]);

    // Revoked through the node: gone from both at once.
    assert!(node.revoke(&DeviceId("b".into())).await.unwrap());
    assert!(listed(&node).await.is_empty());
    assert!(store.devices().unwrap().is_empty());
    assert!(!node.revoke(&DeviceId("b".into())).await.unwrap());
    node.close().await;
}

#[tokio::test]
async fn paired_peers_connect_and_go_online() {
    let ((hub, hub_store), (limb, limb_store)) = paired().await;
    // Going online is a sighting.
    assert!(hub_store.device("l").unwrap().unwrap().last_seen.is_some());
    assert!(limb_store.device("h").unwrap().unwrap().last_seen.is_some());
    hub.close().await;
    limb.close().await;
}

#[tokio::test]
async fn revoke_sends_offline() {
    let ((hub, _), (limb, _)) = paired().await;
    let (mut hub_rx, mut limb_rx) = (hub.events(), limb.events());
    assert!(hub.revoke(&DeviceId("l".into())).await.unwrap());
    wait_for(&mut hub_rx, offline("l")).await;
    // The limb's connection was closed under it.
    wait_for(&mut limb_rx, offline("h")).await;
    assert!(listed(&hub).await.is_empty());
    hub.close().await;
    limb.close().await;
}

// ---- a tracing subscriber that keeps every line, for the secret check ----

static LOG: OnceLock<Arc<Mutex<String>>> = OnceLock::new();

struct Capture(Arc<Mutex<String>>);
struct Line<'a>(&'a mut String);

impl tracing::field::Visit for Line<'_> {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn Debug) {
        self.0.push_str(&format!(" {}={value:?}", field.name()));
    }
}

impl tracing::Subscriber for Capture {
    /// Debug and up: iroh's trace lines are too many for a loaded machine.
    fn enabled(&self, meta: &tracing::Metadata<'_>) -> bool {
        *meta.level() <= tracing::Level::DEBUG
    }
    fn new_span(&self, span: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        let mut log = self.0.lock().unwrap();
        log.push_str(span.metadata().name());
        span.record(&mut Line(&mut log));
        log.push('\n');
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, values: &tracing::span::Record<'_>) {
        let mut log = self.0.lock().unwrap();
        values.record(&mut Line(&mut log));
        log.push('\n');
    }
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        let mut log = self.0.lock().unwrap();
        log.push_str(event.metadata().target());
        event.record(&mut Line(&mut log));
        log.push('\n');
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

#[tokio::test]
async fn nothing_logs_the_secret() {
    let log = LOG.get_or_init(|| {
        let log = Arc::new(Mutex::new(String::new()));
        tracing::subscriber::set_global_default(Capture(log.clone())).expect("one subscriber");
        log
    });
    // Everything a node does: start, sync, connect, go online, revoke, close.
    let ((hub, _), (limb, _)) = paired().await;
    let mut rx = hub.events();
    hub.revoke(&DeviceId("l".into())).await.unwrap();
    wait_for(&mut rx, offline("l")).await;
    let secrets = [hub.loopback().1, limb.loopback().1];
    hub.close().await;
    limb.close().await;

    let log = log.lock().unwrap();
    assert!(log.contains("ready"), "the capture saw connect's lines");
    for s in &secrets {
        assert!(!log.contains(s.as_str()), "a secret was logged");
    }
}
