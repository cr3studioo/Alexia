// SPDX-License-Identifier: AGPL-3.0-only
//! (P4-08, TR-05) The mesh refuses what it must: adversarial tests against the real mesh code.
//!
//! Three kinds of node: a hub H, a limb L paired with it, and a stranger S that never paired.
//! Every refusal is asserted together with the target's callback (`accept_links`' `on_link`,
//! `serve_ops`' `on_op`) never having been called, and with the layer that refused: connect
//! marks its own answers with `x-alexia-connect-error`; the host service's answers have none.
//!
//! Every node here is started through [`start`], which also installs a process-wide tracing
//! subscriber at `debug` that keeps every line (events and span fields, from every crate,
//! connect and iroh included) for [`no_secret_in_logs`].

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Once};
use std::time::{Duration, Instant};

use alexia_mesh::link::Link;
use alexia_mesh::node::{Node, NodeConfig};
use alexia_mesh::ops::HubOp;
use alexia_mesh::pair::{pair_uri, parse_pair_uri, CANCELLED};
use alexia_mesh::{
    DeviceId, Error, Hello, MeshEvent, Role, KEYCHAIN_HUB, KEYCHAIN_LIMB, LINK_PATH, OP_FACE,
    OP_KILL,
};
use alexia_store::{DeviceRow, Store};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

/// Generous: a loaded Windows machine dialling over loopback, and a join's own 60 s.
const WAIT: Duration = Duration::from_secs(120);
/// TR-05: a revoked limb is cut within this.
const CUT: Duration = Duration::from_secs(1);
const HEADER_CONNECT_ERROR: &str = "x-alexia-connect-error";
const HEADER_PEER: &str = "x-alexia-peer";

// ---- log capture ----

/// Every line any crate logged at `debug` or above since the first node started.
static LINES: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// Every node's endpoint id (public, may be logged) and per-launch secret (may not).
static ENDPOINTS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static SECRETS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// A subscriber that writes nothing anywhere and keeps each event and span as one line.
struct Capture(AtomicU64);

/// One line being built from a callsite's fields, as `name=value` pairs.
struct Line(String);

impl tracing::field::Visit for Line {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        // Raw, not Debug-escaped: a secret inside a string is found as it is.
        self.0.push_str(&format!(" {}={}", field.name(), value));
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.0.push_str(&format!(" {}={:?}", field.name(), value));
    }
}

impl Line {
    fn new(meta: &tracing::Metadata<'_>) -> Line {
        Line(format!(
            "{} {} {}:",
            meta.level(),
            meta.target(),
            meta.name()
        ))
    }

    fn keep(self) {
        lock(&LINES).push(self.0);
    }
}

impl tracing::Subscriber for Capture {
    fn enabled(&self, meta: &tracing::Metadata<'_>) -> bool {
        // More verbose levels are greater: this is DEBUG, INFO, WARN and ERROR.
        *meta.level() <= tracing::Level::DEBUG
    }

    fn max_level_hint(&self) -> Option<tracing::level_filters::LevelFilter> {
        Some(tracing::level_filters::LevelFilter::DEBUG)
    }

    fn new_span(&self, span: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        let mut line = Line::new(span.metadata());
        span.record(&mut line);
        line.keep();
        tracing::span::Id::from_u64(self.0.fetch_add(1, Ordering::Relaxed))
    }

    fn record(&self, _: &tracing::span::Id, values: &tracing::span::Record<'_>) {
        let mut line = Line("span record:".into());
        values.record(&mut line);
        line.keep();
    }

    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}

    fn event(&self, event: &tracing::Event<'_>) {
        let mut line = Line::new(event.metadata());
        event.record(&mut line);
        line.keep();
    }

    fn enter(&self, _: &tracing::span::Id) {}

    fn exit(&self, _: &tracing::span::Id) {}
}

fn capture_logs() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        tracing::subscriber::set_global_default(Capture(AtomicU64::new(1)))
            .expect("the only tracing subscriber in this test binary");
    });
}

/// Every run of 64 or more hex digits in `line`: the shape of a key, a secret or an endpoint id.
fn long_hex_runs(line: &str) -> Vec<&str> {
    line.split(|c: char| !c.is_ascii_hexdigit())
        .filter(|run| run.len() >= 64)
        .collect()
}

// ---- nodes ----

async fn start(role: Role, name: &str) -> (Arc<Node>, Arc<Store>) {
    capture_logs();
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
    lock(&ENDPOINTS).push(node.endpoint().0);
    lock(&SECRETS).push(node.loopback().1);
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

async fn status(node: &Node) -> Value {
    node.status().await.expect("status")
}

async fn allowlist(node: &Node) -> Vec<String> {
    status(node).await["allowlist"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

/// The IPv4 port `node` is bound on.
async fn udp_port(node: &Node) -> u16 {
    let status = status(node).await;
    status["boundAddresses"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|a| a.as_str()?.strip_prefix("0.0.0.0:")?.parse().ok())
        .next()
        .unwrap_or_else(|| panic!("an IPv4 socket: {status}"))
}

/// Where `node` answers on this machine.
async fn loopback_hints(node: &Node) -> Value {
    json!({ "directAddresses": [format!("127.0.0.1:{}", udp_port(node).await)] })
}

/// `node`'s row for `peer`, as `id` with `role`, at `peer`'s loopback address; connect is synced.
async fn knows(node: &Node, store: &Store, peer: &Node, id: &str, role: &str) {
    store
        .device_put(&row(
            id,
            &peer.endpoint().0,
            role,
            loopback_hints(peer).await,
        ))
        .unwrap();
    node.sync_allowlist().await.unwrap();
}

/// H and L paired (by rows, as pairing writes them) and connected; S started and knowing nobody.
struct Mesh {
    h: Arc<Node>,
    hs: Arc<Store>,
    l: Arc<Node>,
    ls: Arc<Store>,
    s: Arc<Node>,
    ss: Arc<Store>,
}

async fn mesh() -> Mesh {
    let (h, hs) = start(Role::Hub, "hub").await;
    let (l, ls) = start(Role::Limb, "limb").await;
    let (s, ss) = start(Role::Hub, "stranger").await;
    knows(&h, &hs, &l, "l", "limb").await;
    knows(&l, &ls, &h, "h", "hub").await;
    tokio::time::timeout(WAIT, h.connect(&DeviceId("l".into())))
        .await
        .expect("connects in time")
        .expect("H reaches L");
    Mesh {
        h,
        hs,
        l,
        ls,
        s,
        ss,
    }
}

/// `node` accepting links; each one handed to `on_link` arrives here.
async fn accepting(node: &Arc<Node>) -> mpsc::UnboundedReceiver<(DeviceId, Link)> {
    let (tx, rx) = mpsc::unbounded_channel();
    node.accept_links(move |device, link| {
        let _ = tx.send((device, link));
    })
    .await
    .expect("serves links");
    rx
}

/// `node` serving the hub operations; each one handed to `on_op` arrives here.
async fn serving_ops(node: &Arc<Node>) -> mpsc::UnboundedReceiver<HubOp> {
    let (tx, rx) = mpsc::unbounded_channel();
    node.serve_ops(move |op| {
        let _ = tx.send(op);
    })
    .await
    .expect("serves operations");
    rx
}

fn never_called<T: std::fmt::Debug>(rx: &mut mpsc::UnboundedReceiver<T>, what: &str) {
    if let Ok(got) = rx.try_recv() {
        panic!("{what} was called: {got:?}");
    }
}

/// A request through `from`'s bridge to `to` at `path`, with `from`'s own secret.
async fn bridge(
    from: &Node,
    to: &Node,
    path: &str,
    body: &str,
    peer_header: Option<&str>,
) -> reqwest::Response {
    let (base, secret) = from.loopback();
    let mut req = http()
        .post(format!("{base}/bridge/{}{path}", to.endpoint().0))
        .bearer_auth(secret)
        .header("content-type", "application/json")
        .body(body.to_string())
        .timeout(WAIT);
    if let Some(p) = peer_header {
        req = req.header(HEADER_PEER, p);
    }
    req.send().await.expect("connect answers")
}

fn connect_error(res: &reqwest::Response) -> Option<String> {
    res.headers()
        .get(HEADER_CONNECT_ERROR)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

/// The offer's URI with the hub's loopback address in front: two nodes on one machine.
async fn with_loopback(hub: &Node, uri: &str) -> String {
    let mut p = parse_pair_uri(uri).expect("the offer's URI parses");
    let port = udp_port(hub).await;
    p.addresses
        .insert(0, std::net::SocketAddr::from(([127, 0, 0, 1], port)));
    p.addresses.truncate(16);
    pair_uri(&p)
}

fn paired_events(rx: &mut broadcast::Receiver<MeshEvent>) -> usize {
    let mut n = 0;
    loop {
        match rx.try_recv() {
            Ok(MeshEvent::Paired { .. }) => n += 1,
            Ok(_) | Err(broadcast::error::TryRecvError::Lagged(_)) => {}
            Err(_) => return n,
        }
    }
}

// ---- strangers: connect's allowlist refuses them ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stranger_cannot_dial_limb() {
    let m = mesh().await;
    let mut links = accepting(&m.l).await;
    // S knows everything public about L: its endpoint id, its address, that it is a limb.
    knows(&m.s, &m.ss, &m.l, "l", "limb").await;

    let dialled = tokio::time::timeout(WAIT, m.s.dial(&DeviceId("l".into())))
        .await
        .expect("dial answers in time");
    assert!(
        matches!(dialled, Err(Error::Refused(_))),
        "{:?}",
        dialled.err()
    );
    // connect refused it, and said the *other* computer (L) does not allow S: the handshake.
    let res = bridge(&m.s, &m.l, LINK_PATH, "", None).await;
    assert_eq!(res.status(), 403);
    assert_eq!(connect_error(&res).as_deref(), Some("peer_rejected"));
    // The same with a forged peer header naming L's own hub.
    let res = bridge(&m.s, &m.l, LINK_PATH, "", Some(m.h.endpoint().0.as_str())).await;
    assert_eq!(connect_error(&res).as_deref(), Some("peer_rejected"));

    never_called(&mut links, "L's on_link");
    assert!(!allowlist(&m.l).await.contains(&m.s.endpoint().0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stranger_cannot_send_ops_to_hub() {
    let m = mesh().await;
    let mut ops = serving_ops(&m.h).await;
    knows(&m.s, &m.ss, &m.h, "h", "hub").await;

    let sent = tokio::time::timeout(
        WAIT,
        m.s.send_op(
            &DeviceId("h".into()),
            &HubOp::Kill {
                from: DeviceId("l".into()),
            },
        ),
    )
    .await
    .expect("send_op answers in time");
    assert!(matches!(sent, Err(Error::Refused(_))), "{:?}", sent.err());
    // Pretending to be L, in the header and in the body, changes nothing: refused at H's handshake.
    let res = bridge(
        &m.s,
        &m.h,
        OP_FACE,
        r#"{"text":"hi","from":"l"}"#,
        Some(m.l.endpoint().0.as_str()),
    )
    .await;
    assert_eq!(res.status(), 403);
    assert_eq!(connect_error(&res).as_deref(), Some("peer_rejected"));

    never_called(&mut ops, "H's on_op");
    assert!(!allowlist(&m.h).await.contains(&m.s.endpoint().0));
}

// ---- revocation ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn revoked_limb_is_cut_within_1s() {
    let m = mesh().await;
    let mut links = accepting(&m.l).await;
    let mut ops = serving_ops(&m.h).await;
    let l = DeviceId("l".into());
    let hub_end = tokio::time::timeout(WAIT, m.h.dial(&l))
        .await
        .expect("dial answers in time")
        .expect("H dials L");
    let (_, limb_end) = tokio::time::timeout(WAIT, links.recv())
        .await
        .expect("L gets the link in time")
        .expect("a link");
    assert!(!hub_end.closed.is_cancelled() && !limb_end.closed.is_cancelled());

    let began = Instant::now();
    assert!(m.h.revoke(&l).await.expect("revoke"), "L was paired");
    tokio::time::timeout(WAIT, hub_end.closed.cancelled())
        .await
        .expect("the hub's end closes");
    let hub_cut = began.elapsed();
    tokio::time::timeout(WAIT, limb_end.closed.cancelled())
        .await
        .expect("the limb's end closes");
    let limb_cut = began.elapsed();
    assert!(hub_cut <= CUT, "the hub's end closed after {hub_cut:?}");
    assert!(limb_cut <= CUT, "the limb's end closed after {limb_cut:?}");

    // A new dial fails: refused by the mesh (the row is revoked)…
    let again = m.h.dial(&l).await;
    assert!(matches!(again, Err(Error::NotPaired)), "{:?}", again.err());
    // …and by H's connect, which no longer lets L out.
    let res = bridge(&m.h, &m.l, LINK_PATH, "", None).await;
    assert_eq!(res.status(), 403);
    assert_eq!(connect_error(&res).as_deref(), Some("peer_not_allowed"));
    assert!(!allowlist(&m.h).await.contains(&m.l.endpoint().0));
    // L still trusts H, but H refuses L at the handshake.
    let sent = tokio::time::timeout(
        WAIT,
        m.l.send_op(&DeviceId("h".into()), &HubOp::Kill { from: l.clone() }),
    )
    .await
    .expect("send_op answers in time");
    assert!(matches!(sent, Err(Error::Refused(_))), "{:?}", sent.err());

    never_called(&mut links, "L's on_link after the revoke");
    never_called(&mut ops, "H's on_op");
    assert!(m.hs.devices().unwrap().is_empty(), "no allowed device on H");
}

// ---- secrets ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wrong_loopback_secret_is_401() {
    let m = mesh().await;
    let mut links = accepting(&m.l).await;
    let (base, secret) = m.h.loopback();
    let mut flipped = secret.clone();
    let last = if flipped.pop() == Some('0') { '1' } else { '0' };
    flipped.push(last);
    let wrong = [
        None,
        Some(flipped),
        Some(secret[..secret.len() - 1].to_string()),
        Some(format!("{secret}0")),
        Some(secret.to_uppercase()),
        Some(m.l.loopback().1), // another node's secret
    ];
    for bearer in &wrong {
        let attempts = [
            http().get(format!("{base}/v1/status")),
            // Try to let the stranger in.
            http()
                .put(format!("{base}/v1/allowlist"))
                .json(&json!({ "endpointIds": [m.s.endpoint().0] })),
            http()
                .post(format!("{base}/bridge/{}{LINK_PATH}", m.l.endpoint().0))
                .body(""),
            http().post(format!("{base}/v1/shutdown")),
        ];
        for req in attempts {
            let req = match bearer {
                Some(b) => req.bearer_auth(b),
                None => req,
            };
            let res = req.timeout(WAIT).send().await.expect("connect answers");
            assert_eq!(res.status(), 401, "bearer {bearer:?}");
            assert_eq!(connect_error(&res).as_deref(), Some("unauthorized"));
        }
    }
    // The secret in the URL instead of the header is no secret at all.
    let res = http()
        .get(format!("{base}/v1/status?secret={secret}"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);

    // Nothing changed: H is up, still allows exactly L, and L was never asked for a link.
    assert_eq!(allowlist(&m.h).await, vec![m.l.endpoint().0]);
    never_called(&mut links, "L's on_link");
}

/// The host service's port, from connect's status (its secret is never in it).
async fn host_port(node: &Node) -> u16 {
    let status = status(node).await;
    assert!(
        !status["host"].to_string().contains("secret"),
        "status shows no host secret: {status}"
    );
    status["host"]["port"]
        .as_u64()
        .unwrap_or_else(|| panic!("a host service: {status}")) as u16
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wrong_host_secret_is_refused() {
    let m = mesh().await;
    let mut links = accepting(&m.l).await;
    let mut ops = serving_ops(&m.h).await;
    // Each local process can reach both host services; it does not have their secrets.
    let targets = [
        (host_port(&m.l).await, LINK_PATH, m.h.endpoint().0, "{}"),
        (host_port(&m.h).await, OP_KILL, m.l.endpoint().0, "{}"),
    ];
    for (port, path, peer, body) in &targets {
        let bearers = [
            None,
            Some("Bearer wrong".to_string()),
            // connect's own per-launch secrets are not the host secret.
            Some(format!("Bearer {}", m.l.loopback().1)),
            Some(format!("Bearer {}", m.h.loopback().1)),
            Some("Bearer ".to_string()),
        ];
        for bearer in &bearers {
            let mut req = http()
                .post(format!("http://127.0.0.1:{port}{path}"))
                // A peer header naming the one device the service would accept.
                .header(HEADER_PEER, peer.as_str())
                .header("content-type", "application/json")
                .body(body.to_string())
                .timeout(WAIT);
            if let Some(b) = bearer {
                req = req.header("authorization", b.as_str());
            }
            let res = req.send().await.expect("the host service answers");
            assert_eq!(res.status(), 401, "{path} with {bearer:?}");
            assert_eq!(connect_error(&res), None, "the host service itself refused");
        }
    }
    never_called(&mut links, "L's on_link");
    never_called(&mut ops, "H's on_op");
}

// ---- roles and who is speaking ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn forged_peer_header_is_ignored() {
    let m = mesh().await;
    // A second limb, L2, paired with H. L and L2 also know each other (as limbs), so connect
    // lets L's request reach L2's host service and the host service's checks are what is tested.
    let (l2, l2s) = start(Role::Limb, "limb two").await;
    knows(&m.h, &m.hs, &l2, "l2", "limb").await;
    knows(&l2, &l2s, &m.h, "h", "hub").await;
    knows(&l2, &l2s, &m.l, "l", "limb").await;
    knows(&m.l, &m.ls, &l2, "l2", "limb").await;
    let mut ops = serving_ops(&m.h).await;
    let mut l2_links = accepting(&l2).await;

    // L claims to be L2, in connect's header and in the body: H hears L.
    let res = bridge(
        &m.l,
        &m.h,
        OP_FACE,
        r#"{"text":"hi","from":"l2"}"#,
        Some(l2.endpoint().0.as_str()),
    )
    .await;
    assert_eq!(res.status(), 200);
    let got = tokio::time::timeout(WAIT, ops.recv()).await.unwrap();
    assert_eq!(
        got,
        Some(HubOp::Face {
            from: DeviceId("l".into()),
            text: "hi".into(),
            reply_to: None,
            data: None,
        })
    );
    let res = bridge(&m.l, &m.h, OP_KILL, "{}", Some(l2.endpoint().0.as_str())).await;
    assert_eq!(res.status(), 200);
    let got = tokio::time::timeout(WAIT, ops.recv()).await.unwrap();
    assert_eq!(
        got,
        Some(HubOp::Kill {
            from: DeviceId("l".into())
        })
    );

    // L claims to be H to get a link from L2: L2's host service sees L, a limb, and refuses.
    let res = bridge(&m.l, &l2, LINK_PATH, "", Some(m.h.endpoint().0.as_str())).await;
    assert_eq!(res.status(), 403);
    assert_eq!(connect_error(&res), None, "L2's role check refused it");
    never_called(&mut l2_links, "L2's on_link");
    never_called(&mut ops, "H's on_op beyond the two from L");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn limb_role_cannot_serve_ops_to_a_limb() {
    let m = mesh().await;
    // L2: a limb paired with H, serving links as every limb does.
    let (l2, l2s) = start(Role::Limb, "limb two").await;
    knows(&m.h, &m.hs, &l2, "l2", "limb").await;
    knows(&l2, &l2s, &m.h, "h", "hub").await;
    let mut l2_links = accepting(&l2).await;
    let l2_id = DeviceId("l2".into());
    let kill = HubOp::Kill {
        from: DeviceId("l".into()),
    };

    // L names L2 as a device of its own and sends it a hub operation: L2 has never heard of L,
    // so L2's connect refuses it at the handshake.
    knows(&m.l, &m.ls, &l2, "l2", "limb").await;
    let sent = tokio::time::timeout(WAIT, m.l.send_op(&l2_id, &kill))
        .await
        .expect("send_op answers in time");
    assert!(matches!(sent, Err(Error::Refused(_))), "{:?}", sent.err());
    let res = bridge(&m.l, &l2, OP_KILL, "{}", None).await;
    assert_eq!(connect_error(&res).as_deref(), Some("peer_rejected"));

    // Even if L2 knew L, a limb offers no hub operation: L2's connect refuses it before its
    // host service is contacted.
    knows(&l2, &l2s, &m.l, "l", "limb").await;
    let sent = tokio::time::timeout(WAIT, m.l.send_op(&l2_id, &kill))
        .await
        .expect("send_op answers in time");
    assert!(matches!(sent, Err(Error::Refused(_))), "{:?}", sent.err());
    let res = bridge(&m.l, &l2, OP_KILL, "{}", None).await;
    assert_eq!(res.status(), 403);
    assert_eq!(
        connect_error(&res).as_deref(),
        Some("operation_not_registered")
    );

    // And the link, which L2 does offer, is refused by L2's role check: L is not its hub.
    let res = bridge(&m.l, &l2, LINK_PATH, "", None).await;
    assert_eq!(res.status(), 403);
    assert_eq!(connect_error(&res), None, "L2's host service refused it");
    never_called(&mut l2_links, "L2's on_link");
}

// ---- pairing ----

/// H offers, L joins, both settle: the code, the URI L used, and the rows L and H wrote.
async fn pair(h: &Arc<Node>, l: &Node) -> (String, String, DeviceRow, DeviceRow) {
    let offer = h.pair_offer(&hello(Role::Hub)).await.expect("offer");
    let uri = with_loopback(h, &offer.uri).await;
    let waiting = {
        let h = h.clone();
        let offer = offer.clone();
        tokio::spawn(async move { h.pair_wait(&offer).await })
    };
    let hub_row = tokio::time::timeout(WAIT, l.pair_join(&uri, &hello(Role::Limb)))
        .await
        .expect("join settles")
        .expect("L pairs");
    let limb_row = tokio::time::timeout(WAIT, waiting)
        .await
        .expect("wait settles")
        .unwrap()
        .expect("H pairs");
    (offer.code, uri, hub_row, limb_row)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pair_code_single_use() {
    let (h, hs) = start(Role::Hub, "Studio PC").await;
    let (l, _) = start(Role::Limb, "Laptop").await;
    let (s, ss) = start(Role::Limb, "Stranger").await;
    let mut events = h.events();
    let (_, uri, _, limb_row) = pair(&h, &l).await;

    // The same URI again, by a stranger and by L itself: both fail, and H learns nobody new.
    for joiner in [&s, &l] {
        let again = tokio::time::timeout(WAIT, joiner.pair_join(&uri, &hello(Role::Limb)))
            .await
            .expect("join settles");
        assert!(again.is_err(), "a used code paired again: {again:?}");
    }
    // (`last_seen` moves as L comes online, so the rows are compared by endpoint.)
    let endpoints: Vec<String> = hs
        .devices()
        .unwrap()
        .into_iter()
        .map(|d| d.endpoint)
        .collect();
    assert_eq!(endpoints, vec![limb_row.endpoint.clone()]);
    assert_eq!(allowlist(&h).await, vec![limb_row.endpoint]);
    assert!(ss.devices().unwrap().is_empty());
    assert!(!allowlist(&s).await.contains(&h.endpoint().0));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(paired_events(&mut events), 1, "H announced one pairing");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelled_pairing_leaves_no_allowed_device() {
    let (h, hs) = start(Role::Hub, "Studio PC").await;
    let (l, _) = start(Role::Limb, "Laptop").await;
    let offer = h.pair_offer(&hello(Role::Hub)).await.expect("offer");
    let uri = with_loopback(&h, &offer.uri).await;
    let waiting = {
        let (h, offer) = (h.clone(), offer.clone());
        tokio::spawn(async move { h.pair_wait(&offer).await })
    };
    // L's side settles first; the cancel then races H's pair_wait writing its row, which is
    // the window a cancel used to miss.
    let _ = tokio::time::timeout(WAIT, l.pair_join(&uri, &hello(Role::Limb)))
        .await
        .expect("join settles");
    tokio::time::timeout(WAIT, h.pair_cancel(&offer))
        .await
        .expect("cancel answers in time")
        .expect("cancel");
    let said = tokio::time::timeout(WAIT, waiting)
        .await
        .expect("wait settles")
        .unwrap();
    if let Err(e) = &said {
        assert!(
            e.to_string().contains(CANCELLED),
            "a cancelled pairing fails as cancelled: {e}"
        );
    }
    // Either way, nothing is left trusted.
    assert!(hs.devices().unwrap().is_empty(), "no allowed device on H");
    assert!(!allowlist(&h).await.contains(&l.endpoint().0));
    if let Some(row) = hs.device_by_endpoint(&l.endpoint().0).unwrap() {
        assert!(row.revoked_at.is_some(), "a written row is revoked");
    }
}

// ---- logs ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_secret_in_logs() {
    let (h, hs) = start(Role::Hub, "Studio PC").await;
    let (l, ls) = start(Role::Limb, "Laptop").await;
    let (code, _, hub_row, limb_row) = pair(&h, &l).await;
    // Reach each other over loopback, whatever addresses the pairing hints named.
    hs.device_put(&DeviceRow {
        hints: loopback_hints(&l).await,
        ..limb_row.clone()
    })
    .unwrap();
    ls.device_put(&DeviceRow {
        hints: loopback_hints(&h).await,
        ..hub_row.clone()
    })
    .unwrap();
    h.sync_allowlist().await.unwrap();
    l.sync_allowlist().await.unwrap();

    // A link with a line each way, and an operation, each carrying a canary.
    let canary = |what: &str| format!("canary{what}{:016x}", alexia_store::now_ms());
    let (down, up, face) = (canary("down"), canary("up"), canary("face"));
    let mut links = accepting(&l).await;
    let mut ops = serving_ops(&h).await;
    let mut hub_end = tokio::time::timeout(WAIT, h.dial(&DeviceId(limb_row.id.clone())))
        .await
        .expect("dial answers in time")
        .expect("H dials L");
    let (_, mut limb_end) = tokio::time::timeout(WAIT, links.recv())
        .await
        .unwrap()
        .expect("a link");
    hub_end
        .tx
        .send(json!({ "jsonrpc": "2.0", "method": &down }).to_string())
        .await
        .unwrap();
    let got = tokio::time::timeout(WAIT, limb_end.rx.recv())
        .await
        .unwrap();
    assert!(got.is_some_and(|g| g.contains(&down)));
    limb_end
        .tx
        .send(json!({ "jsonrpc": "2.0", "result": &up }).to_string())
        .await
        .unwrap();
    let got = tokio::time::timeout(WAIT, hub_end.rx.recv()).await.unwrap();
    assert!(got.is_some_and(|g| g.contains(&up)));
    let op = HubOp::Face {
        from: DeviceId("x".into()),
        text: face.clone(),
        reply_to: None,
        data: None,
    };
    tokio::time::timeout(WAIT, l.send_op(&DeviceId(hub_row.id.clone()), &op))
        .await
        .expect("sent in time")
        .expect("H takes it");
    let got = tokio::time::timeout(WAIT, ops.recv()).await.unwrap();
    assert!(matches!(got, Some(HubOp::Face { .. })), "{got:?}");
    drop(hub_end);
    tokio::time::timeout(WAIT, limb_end.closed.cancelled())
        .await
        .expect("the link closes");
    tokio::time::sleep(Duration::from_millis(500)).await;

    let lines = lock(&LINES).clone();
    // The capture works: connect's own pairing line is in it.
    assert!(
        lines.iter().any(|x| x.contains("pairing started")),
        "the capture saw connect's pairing lines ({} lines)",
        lines.len()
    );
    let words: Vec<&str> = code.split('-').collect();
    let mut forbidden = vec![
        code.clone(),
        format!("{}-{}", words[0], words[1]),
        format!("{} {}", words[0], words[1]),
        down,
        up,
        face,
    ];
    forbidden.extend(lock(&SECRETS).iter().cloned());
    let endpoints = lock(&ENDPOINTS).clone();
    for line in &lines {
        for f in &forbidden {
            assert!(!line.contains(f.as_str()), "a secret was logged: {line}");
        }
        // The host services' secrets are not readable here; they are 64 random hex, like every
        // key. The only 64-hex values a line may hold are endpoint ids, which are public.
        for run in long_hex_runs(line) {
            assert!(
                endpoints.iter().any(|e| e == run),
                "a key-shaped value that is no endpoint id was logged: {line}"
            );
        }
    }
}
