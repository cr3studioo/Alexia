// SPDX-License-Identifier: AGPL-3.0-only
//! (P4-05) Pairing: the URI, the QR, and two ephemeral nodes pairing over loopback.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use alexia_mesh::node::{Node, NodeConfig};
use alexia_mesh::pair::{
    pair_uri, parse_pair_uri, PairUri, NOBODY_WAITING, NOT_A_LIMB, WRONG_CODE,
};
use alexia_mesh::qr::{qr_svg, qr_text};
use alexia_mesh::{DeviceId, EndpointId, Hello, MeshEvent, Role, KEYCHAIN_HUB, KEYCHAIN_LIMB};
use alexia_store::Store;
use serde_json::Value;
use tokio::sync::broadcast;

/// Generous: a loaded Windows machine dialling over loopback, and a join's own 60 s.
const WAIT: Duration = Duration::from_secs(120);

async fn start(role: Role, name: &str) -> (Arc<Node>, Arc<Store>) {
    let store = Arc::new(Store::open_in_memory().expect("store"));
    let cfg = NodeConfig {
        keychain: match role {
            Role::Hub => KEYCHAIN_HUB,
            Role::Limb => KEYCHAIN_LIMB,
        }
        .to_string(),
        name: name.into(),
        role,
        ephemeral: true,
        extra_addresses: vec![],
    };
    let node = Node::start(cfg, store.clone()).await.expect("node starts");
    (node, store)
}

fn hello(role: Role) -> Hello {
    Hello {
        role,
        platform: "test".into(),
        app_version: "0.0.0".into(),
        wake: vec![],
    }
}

fn endpoint() -> EndpointId {
    EndpointId::parse(&iroh::SecretKey::generate().public().to_string()).unwrap()
}

fn sample() -> PairUri {
    PairUri {
        endpoint: endpoint(),
        code: "crossover-clockwork-guitarist-tonic".into(),
        addresses: vec![
            "192.168.1.20:57835".parse().unwrap(),
            "[fe80::1]:4000".parse().unwrap(),
        ],
        name: "Václav's PC & co=1%".into(),
    }
}

async fn status(node: &Node) -> Value {
    let (base, secret) = node.loopback();
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("{base}/v1/status"))
        .bearer_auth(secret)
        .send()
        .await
        .expect("connect answers")
        .json()
        .await
        .expect("json")
}

async fn allowlist(node: &Node) -> Vec<String> {
    status(node).await["allowlist"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

/// The offer's URI with the hub's loopback address in front: two nodes on one machine.
async fn with_loopback(hub: &Node, uri: &str) -> String {
    let mut p = parse_pair_uri(uri).expect("the offer's URI parses");
    let port = status(hub).await["boundAddresses"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|a| a.as_str()?.parse::<SocketAddr>().ok())
        .find(SocketAddr::is_ipv4)
        .expect("bound on IPv4")
        .port();
    p.addresses
        .insert(0, SocketAddr::from(([127, 0, 0, 1], port)));
    p.addresses.truncate(16);
    pair_uri(&p)
}

async fn paired(rx: &mut broadcast::Receiver<MeshEvent>) -> DeviceId {
    tokio::time::timeout(WAIT, async {
        loop {
            if let MeshEvent::Paired { device } = rx.recv().await.expect("events") {
                return device;
            }
        }
    })
    .await
    .expect("a Paired event")
}

fn message<T: std::fmt::Debug>(r: alexia_mesh::Result<T>) -> String {
    r.expect_err("pairing must fail").to_string()
}

#[test]
fn uri_round_trips() {
    let p = sample();
    let s = pair_uri(&p);
    assert!(s.starts_with("alexia-pair:1?e="), "{s}");
    assert!(
        !s.contains(' ') && !s.contains('\''),
        "the name is percent-encoded: {s}"
    );
    assert_eq!(parse_pair_uri(&s), Some(p.clone()));
    let none = PairUri {
        addresses: vec![],
        ..p
    };
    assert_eq!(parse_pair_uri(&pair_uri(&none)), Some(none));
}

#[test]
fn uri_rejects_bad_shapes() {
    let good = pair_uri(&sample());
    assert!(parse_pair_uri(&good).is_some());
    let e = sample().endpoint.0;
    let rest = "&c=crossover-clockwork-guitarist-tonic&a=10.0.0.1:1&n=PC";
    let many: Vec<String> = (1..=17).map(|i| format!("10.0.0.{i}:1")).collect();
    let cases = [
        // scheme and version
        good.replacen("alexia-pair:1", "alexia-pair:2", 1),
        // the endpoint is 64 lowercase hex
        format!("alexia-pair:1?e={}{rest}", &e[..63]),
        // the code is four lowercase words
        format!("alexia-pair:1?e={e}&c=7-crossover-clockwork-guitarist&a=&n=PC"),
        // at most 16 addresses
        format!(
            "alexia-pair:1?e={e}&c=crossover-clockwork-guitarist-tonic&a={}&n=PC",
            many.join(",")
        ),
        // the name is at most 128 bytes
        format!(
            "alexia-pair:1?e={e}&c=crossover-clockwork-guitarist-tonic&a=&n={}",
            "x".repeat(129)
        ),
        // each field once, nothing unknown
        format!("{good}&c=crossover-clockwork-guitarist-tonic"),
    ];
    for bad in &cases {
        assert_eq!(parse_pair_uri(bad), None, "accepted {bad}");
    }
}

#[test]
fn qr_text_decodes() {
    let data = pair_uri(&sample());
    let text = qr_text(&data);
    let code = qrcode::QrCode::new(data.as_bytes()).unwrap();
    let w = code.width();
    let side = w + 4; // a quiet zone of 2 on each side
    let lines: Vec<Vec<char>> = text.lines().map(|l| l.chars().collect()).collect();
    assert_eq!(lines.len(), side.div_ceil(2));
    assert!(lines.iter().all(|l| l.len() == side));
    // Back to modules: a drawn half is light, a blank one dark.
    let dark = |x: usize, y: usize| {
        let c = lines[y / 2][x];
        let light = if y % 2 == 0 {
            matches!(c, '█' | '▀')
        } else {
            matches!(c, '█' | '▄')
        };
        !light
    };
    for y in 0..side {
        for x in 0..side {
            let inside = (2..w + 2).contains(&x) && (2..w + 2).contains(&y);
            let want = inside && code[(x - 2, y - 2)] == qrcode::Color::Dark;
            assert_eq!(dark(x, y), want, "module ({x},{y})");
        }
    }
}

#[test]
fn qr_svg_is_svg() {
    let svg = qr_svg(&pair_uri(&sample()));
    assert!(svg.contains("<svg"), "{svg}");
    assert!(svg.trim_end().ends_with("</svg>"));
    assert!(svg.contains("#000000") && svg.contains("#ffffff"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hub_and_limb_pair() {
    let (hub, hub_store) = start(Role::Hub, "Studio PC").await;
    let (limb, limb_store) = start(Role::Limb, "Václav's MacBook").await;
    let mut hub_events = hub.events();
    let mut limb_events = limb.events();

    let offer = hub.pair_offer(&hello(Role::Hub)).await.expect("offer");
    assert!(!offer.qr_text.is_empty() && offer.qr_svg.contains("<svg"));
    assert!(offer.uri.contains(&offer.code));
    let uri = with_loopback(&hub, &offer.uri).await;

    let waiting = {
        let hub = hub.clone();
        tokio::spawn(async move { hub.pair_wait(&offer).await })
    };
    let hub_row = tokio::time::timeout(WAIT, limb.pair_join(&uri, &hello(Role::Limb)))
        .await
        .expect("join settles")
        .expect("limb pairs");
    let limb_row = tokio::time::timeout(WAIT, waiting)
        .await
        .expect("wait settles")
        .unwrap()
        .expect("hub pairs");

    assert_eq!(hub_row.endpoint, hub.endpoint().0);
    assert_eq!(hub_row.role, "hub");
    assert_eq!(hub_row.name, "Studio PC");
    assert_eq!(limb_row.endpoint, limb.endpoint().0);
    assert_eq!(limb_row.role, "limb");
    assert_eq!(limb_row.id, "vaclavs-macbook");
    assert_eq!(
        hub_store.device(&limb_row.id).unwrap(),
        Some(limb_row.clone())
    );
    assert_eq!(
        limb_store.device(&hub_row.id).unwrap(),
        Some(hub_row.clone())
    );
    assert!(allowlist(&hub).await.contains(&limb_row.endpoint));
    assert!(allowlist(&limb).await.contains(&hub_row.endpoint));
    assert_eq!(paired(&mut hub_events).await.0, limb_row.id);
    assert_eq!(paired(&mut limb_events).await.0, hub_row.id);

    hub.close().await;
    limb.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wrong_code_fails_once() {
    let (hub, hub_store) = start(Role::Hub, "Studio PC").await;
    let (limb, limb_store) = start(Role::Limb, "Laptop").await;
    let offer = hub.pair_offer(&hello(Role::Hub)).await.expect("offer");
    let right = with_loopback(&hub, &offer.uri).await;
    let mut p = parse_pair_uri(&right).unwrap();
    let mut words: Vec<String> = p.code.split('-').map(str::to_string).collect();
    words[0] = if words[0] == "aardvark" {
        "absurd"
    } else {
        "aardvark"
    }
    .into();
    p.code = words.join("-");
    let wrong = pair_uri(&p);

    let waiting = {
        let hub = hub.clone();
        tokio::spawn(async move { hub.pair_wait(&offer).await })
    };
    let first = tokio::time::timeout(WAIT, limb.pair_join(&wrong, &hello(Role::Limb)))
        .await
        .expect("join settles");
    assert_eq!(message(first), WRONG_CODE);
    let hub_said = tokio::time::timeout(WAIT, waiting)
        .await
        .expect("wait settles")
        .unwrap();
    assert_eq!(message(hub_said), WRONG_CODE);

    // The code had its one try.
    let second = tokio::time::timeout(WAIT, limb.pair_join(&right, &hello(Role::Limb)))
        .await
        .expect("join settles");
    assert_eq!(message(second), NOBODY_WAITING);
    assert!(hub_store.devices().unwrap().is_empty());
    assert!(limb_store.devices().unwrap().is_empty());
    assert!(allowlist(&hub).await.is_empty());
    assert!(allowlist(&limb).await.is_empty());

    hub.close().await;
    limb.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn limb_cannot_pair_as_hub() {
    let (hub, hub_store) = start(Role::Hub, "Studio PC").await;
    let (impostor, _) = start(Role::Limb, "Other Hub").await;
    let offer = hub.pair_offer(&hello(Role::Hub)).await.expect("offer");
    let uri = with_loopback(&hub, &offer.uri).await;
    let waiting = {
        let hub = hub.clone();
        tokio::spawn(async move { hub.pair_wait(&offer).await })
    };
    // The joiner's own side sees a hub and may keep it; that is not the hub's trust.
    let _ = tokio::time::timeout(WAIT, impostor.pair_join(&uri, &hello(Role::Hub)))
        .await
        .expect("join settles");
    let hub_said = tokio::time::timeout(WAIT, waiting)
        .await
        .expect("wait settles")
        .unwrap();
    assert_eq!(message(hub_said), NOT_A_LIMB);
    assert!(hub_store
        .device_by_endpoint(&impostor.endpoint().0)
        .unwrap()
        .is_none());
    assert!(!allowlist(&hub).await.contains(&impostor.endpoint().0));

    hub.close().await;
    impostor.close().await;
}
