// SPDX-License-Identifier: AGPL-3.0-only
//! (P4-06) The link and the hub operations, between two ephemeral nodes in one process whose
//! pairing rows are written straight into their scratch stores.

use std::sync::Arc;
use std::time::Duration;

use alexia_mesh::link::{into_stdio, Link};
use alexia_mesh::node::{Node, NodeConfig};
use alexia_mesh::ops::HubOp;
use alexia_mesh::{
    DeviceId, Error, MeshEvent, Reach, Role, KEYCHAIN_HUB, KEYCHAIN_LIMB, LINK_PATH, OP_PRESENCE,
};
use alexia_store::{DeviceRow, Store};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc};

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

fn http() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
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

async fn wait_online(rx: &mut broadcast::Receiver<MeshEvent>, device: &str) {
    tokio::time::timeout(WAIT, async {
        loop {
            match rx.recv().await {
                Ok(MeshEvent::Online { device: d, reach }) if d.0 == device => {
                    assert_ne!(reach, Reach::Offline);
                    return;
                }
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(e) => panic!("events ended: {e}"),
            }
        }
    })
    .await
    .expect("the device comes online in time")
}

/// A hub (which knows the limb as "l") and a limb (which knows the hub as "h", with role
/// `hub_role` in its row), both online.
async fn paired_as(hub_role: &str) -> (Arc<Node>, Arc<Node>) {
    let (hub, hub_store) = start(Role::Hub).await;
    let (limb, limb_store) = start(Role::Limb).await;
    let limb_hints = loopback_hints(&limb).await;
    let hub_hints = loopback_hints(&hub).await;
    hub_store
        .device_put(&row("l", &limb.endpoint().0, "limb", limb_hints))
        .unwrap();
    limb_store
        .device_put(&row("h", &hub.endpoint().0, hub_role, hub_hints))
        .unwrap();
    hub.sync_allowlist().await.unwrap();
    limb.sync_allowlist().await.unwrap();
    let (mut hub_rx, mut limb_rx) = (hub.events(), limb.events());
    hub.connect(&DeviceId("l".into())).await.expect("connects");
    wait_online(&mut hub_rx, "l").await;
    wait_online(&mut limb_rx, "h").await;
    (hub, limb)
}

async fn paired() -> (Arc<Node>, Arc<Node>) {
    paired_as("hub").await
}

/// The limb accepting links; each accepted one arrives on the returned channel.
async fn accepting(limb: &Arc<Node>) -> mpsc::UnboundedReceiver<(DeviceId, Link)> {
    let (tx, rx) = mpsc::unbounded_channel();
    limb.accept_links(move |device, link| {
        let _ = tx.send((device, link));
    })
    .await
    .expect("the limb serves links");
    rx
}

/// hub's link to "l" and the limb's end of it.
async fn linked(hub: &Node, limb: &Arc<Node>) -> (Link, Link) {
    let mut accepted = accepting(limb).await;
    let hub_end = tokio::time::timeout(WAIT, hub.dial(&DeviceId("l".into())))
        .await
        .expect("dial answers in time")
        .expect("dial succeeds");
    let (from, limb_end) = tokio::time::timeout(WAIT, accepted.recv())
        .await
        .expect("the limb gets the link in time")
        .expect("a link");
    assert_eq!(from.0, "h", "the limb names its hub by its own row");
    (hub_end, limb_end)
}

async fn recv(link: &mut Link) -> String {
    tokio::time::timeout(WAIT, link.rx.recv())
        .await
        .expect("a line in time")
        .expect("the link is open")
}

async fn closes(link: &Link) {
    tokio::time::timeout(WAIT, link.closed.cancelled())
        .await
        .expect("the link closes in time");
}

#[tokio::test]
async fn lines_both_ways() {
    let (hub, limb) = paired().await;
    let (mut h, mut l) = linked(&hub, &limb).await;
    let line =
        |side: &str, i: usize| json!({ "jsonrpc": "2.0", "id": i, "method": side }).to_string();
    let (htx, ltx) = (h.tx.clone(), l.tx.clone());
    // Both directions at once: the request body and the response body are open together.
    let sending = tokio::spawn(async move {
        for i in 0..100 {
            htx.send(line("hub", i)).await.unwrap();
            ltx.send(line("limb", i)).await.unwrap();
        }
    });
    for i in 0..100 {
        assert_eq!(recv(&mut l).await, line("hub", i));
        assert_eq!(recv(&mut h).await, line("limb", i));
    }
    sending.await.unwrap();
    assert!(!h.closed.is_cancelled() && !l.closed.is_cancelled());
}

async fn idle_and_still_open(idle: Duration) {
    let (hub, limb) = paired().await;
    let (mut h, mut l) = linked(&hub, &limb).await;
    tokio::time::sleep(idle).await;
    assert!(!h.closed.is_cancelled(), "the hub's end is open");
    assert!(!l.closed.is_cancelled(), "the limb's end is open");
    // Keepalives never reach `rx`; the next line in each direction is the first real one.
    h.tx.send("{\"after\":\"idle\"}".into()).await.unwrap();
    assert_eq!(recv(&mut l).await, "{\"after\":\"idle\"}");
    l.tx.send("{\"back\":1}".into()).await.unwrap();
    assert_eq!(recv(&mut h).await, "{\"back\":1}");
    let (base, secret) = hub.loopback();
    let peers: Value = http()
        .get(format!("{base}/v1/peers"))
        .bearer_auth(secret)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let status = peers["peers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["endpointId"] == limb.endpoint().0.as_str())
        .map(|p| p["status"].clone());
    assert_eq!(status, Some(json!("direct")), "{peers}");
}

/// Four times connect's 15 s idle timeout, in real time.
#[tokio::test]
async fn link_survives_60_s_idle() {
    idle_and_still_open(Duration::from_secs(60)).await;
}

#[tokio::test]
async fn hub_drop_closes_limb_side() {
    let (hub, limb) = paired().await;
    let (h, mut l) = linked(&hub, &limb).await;
    drop(h);
    closes(&l).await;
    let end = tokio::time::timeout(WAIT, l.rx.recv())
        .await
        .expect("rx ends");
    assert_eq!(end, None);
}

#[tokio::test]
async fn limb_drop_closes_hub_side() {
    let (hub, limb) = paired().await;
    let (mut h, l) = linked(&hub, &limb).await;
    drop(l);
    closes(&h).await;
    let end = tokio::time::timeout(WAIT, h.rx.recv())
        .await
        .expect("rx ends");
    assert_eq!(end, None);
}

#[tokio::test]
async fn unpaired_peer_gets_refused() {
    let (_hub, limb) = paired().await;
    let _accepted = accepting(&limb).await;
    // A third node that has a row for the limb; the limb has none for it.
    let (stranger, stranger_store) = start(Role::Hub).await;
    stranger_store
        .device_put(&row(
            "l",
            &limb.endpoint().0,
            "limb",
            loopback_hints(&limb).await,
        ))
        .unwrap();
    stranger.sync_allowlist().await.unwrap();
    let dialled = tokio::time::timeout(WAIT, stranger.dial(&DeviceId("l".into())))
        .await
        .expect("dial answers in time");
    assert!(
        matches!(dialled, Err(Error::Refused(_))),
        "{:?}",
        dialled.err()
    );
}

#[tokio::test]
async fn limb_refuses_a_limb() {
    // The limb's row for the dialling node says it is a limb, not its hub.
    let (hub, limb) = paired_as("limb").await;
    let mut accepted = accepting(&limb).await;
    let dialled = tokio::time::timeout(WAIT, hub.dial(&DeviceId("l".into())))
        .await
        .expect("dial answers in time");
    assert!(
        matches!(dialled, Err(Error::Refused(_))),
        "{:?}",
        dialled.err()
    );
    // The limb's host service itself said 403: no connect error header.
    let (base, secret) = hub.loopback();
    let res = http()
        .post(format!("{base}/bridge/{}{LINK_PATH}", limb.endpoint().0))
        .bearer_auth(secret)
        .body("")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    assert!(res.headers().get("x-alexia-connect-error").is_none());
    assert!(accepted.try_recv().is_err(), "no link was handed out");
}

#[tokio::test]
async fn into_stdio_round_trip() {
    let (hub, limb) = paired().await;
    let (h, mut l) = linked(&hub, &limb).await;
    let (mut stdin, stdout) = into_stdio(h).unwrap();
    let mut stdout = BufReader::new(stdout).lines();
    stdin.write_all(b"{\"id\":1}\n").await.unwrap();
    stdin.flush().await.unwrap();
    assert_eq!(recv(&mut l).await, "{\"id\":1}");
    l.tx.send("{\"id\":1,\"result\":{}}".into()).await.unwrap();
    let back = tokio::time::timeout(WAIT, stdout.next_line())
        .await
        .expect("a line in time")
        .unwrap();
    assert_eq!(back.as_deref(), Some("{\"id\":1,\"result\":{}}"));
    // Closing the caller's stdin closes the link, and the caller's stdout ends.
    drop(stdin);
    closes(&l).await;
    let end = tokio::time::timeout(WAIT, stdout.next_line())
        .await
        .expect("stdout ends in time")
        .unwrap();
    assert_eq!(end, None);
}

#[tokio::test]
async fn ops_reach_the_hub() {
    let (hub, limb) = paired().await;
    let (tx, mut ops) = mpsc::unbounded_channel();
    hub.serve_ops(move |op| {
        let _ = tx.send(op);
    })
    .await
    .expect("the hub serves its operations");
    let h = DeviceId("h".into());
    // What the limb puts in `from` is not believed: the hub knows it as "l".
    let anyone = DeviceId("someone-else".into());
    let from = DeviceId("l".into());
    let sent = [
        HubOp::Kill {
            from: anyone.clone(),
        },
        HubOp::Presence {
            from: anyone.clone(),
            idle_ms: 1234,
            locked: true,
        },
        HubOp::Face {
            from: anyone.clone(),
            text: "hello".into(),
            reply_to: Some("m-1".into()),
            data: Some("{\"k\":1}".into()),
        },
    ];
    let want = [
        HubOp::Kill { from: from.clone() },
        HubOp::Presence {
            from: from.clone(),
            idle_ms: 1234,
            locked: true,
        },
        HubOp::Face {
            from: from.clone(),
            text: "hello".into(),
            reply_to: Some("m-1".into()),
            data: Some("{\"k\":1}".into()),
        },
    ];
    for (op, want) in sent.iter().zip(want) {
        tokio::time::timeout(WAIT, limb.send_op(&h, op))
            .await
            .expect("sent in time")
            .expect("the hub takes it");
        let got = tokio::time::timeout(WAIT, ops.recv()).await.unwrap();
        assert_eq!(got, Some(want));
    }

    // A malformed body: 400 from the hub's host service, and no callback.
    let (base, secret) = limb.loopback();
    let res = http()
        .post(format!("{base}/bridge/{}{OP_PRESENCE}", hub.endpoint().0))
        .bearer_auth(secret)
        .header("content-type", "application/json")
        .body(r#"{"idleMs":"soon"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
    assert!(res.headers().get("x-alexia-connect-error").is_none());
    // The next operation the hub sees is the next good one: the bad one never arrived.
    let kill = HubOp::Kill { from: from.clone() };
    limb.send_op(&h, &kill).await.expect("the hub takes it");
    let got = tokio::time::timeout(WAIT, ops.recv()).await.unwrap();
    assert_eq!(got, Some(kill));
}
