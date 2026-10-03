// SPDX-License-Identifier: AGPL-3.0-only

//! Plan §13's acceptance tests that are the sidecar's alone and are not already in
//! `pairing.rs` or `transport.rs`. Sidecars in one process, real iroh endpoints on this machine,
//! no relay and no second machine; `docs/spec/remote-compute-acceptance.md` says what that leaves
//! for real hardware.

use std::convert::Infallible;
use std::net::Ipv4Addr;

use alexia_connect::{stable_port, start, Network, Options, Running};
use bytes::Bytes;
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::Incoming;
use hyper::header::{HeaderMap, AUTHORIZATION};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use iroh::SecretKey;
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;

const HOST_SECRET: &str = "the-host-service-secret";

/// A compute service that sends back whatever it is sent.
async fn echo() -> u16 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let service = service_fn(|request: Request<Incoming>| async move {
                    let body = request.into_body().collect().await.map(|whole| whole.to_bytes()).unwrap_or_default();
                    Ok::<_, Infallible>(Response::new(Full::new(body)))
                });
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
            });
        }
    });
    port
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Incoming,
    _connection: JoinSet<()>,
}

impl Reply {
    async fn json(self) -> Value {
        serde_json::from_slice(&self.body.collect().await.expect("a whole body").to_bytes()).expect("json")
    }

    fn error(&self) -> Option<&str> {
        self.headers.get("x-alexia-connect-error").and_then(|value| value.to_str().ok())
    }
}

async fn call(port: u16, secret: &str, method: &str, path: &str, body: Option<Value>) -> Reply {
    let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.unwrap();
    let mut held = JoinSet::new();
    held.spawn(async move {
        let _ = connection.await;
    });
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", format!("127.0.0.1:{port}"))
        .header(AUTHORIZATION, format!("Bearer {secret}"));
    let request = match body {
        Some(body) => request.header("content-type", "application/json").body(Full::new(Bytes::from(body.to_string())).boxed()),
        None => request.body(Empty::new().boxed()),
    };
    let (parts, body) = sender.send_request(request.unwrap()).await.expect("an answer").into_parts();
    Reply { status: parts.status, headers: parts.headers, body, _connection: held }
}

struct Side {
    running: Running,
    port: u16,
    id: String,
    secret: String,
}

/// One launch of a sidecar, holding the key it is given — what the keychain hands back on the next start.
async fn launch(name: &str, key: &SecretKey) -> Side {
    let secret = format!("{name}-secret-0123456789abcdef0123456789abcdef");
    let key = SecretKey::from_bytes(&key.to_bytes());
    let options = Options { secret: secret.clone(), key, network: Network::default(), pairing: Default::default() };
    let running = start(options).await.expect("start");
    Side { port: running.port(), id: running.endpoint_id(), running, secret }
}

impl Side {
    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> Reply {
        call(self.port, &self.secret, method, path, body).await
    }

    async fn ok(&self, method: &str, path: &str, body: Option<Value>) -> Value {
        let reply = self.call(method, path, body).await;
        assert_eq!(reply.status, StatusCode::OK, "{method} {path}");
        reply.json().await
    }

    /// Where this side's endpoint can be dialled on this machine.
    async fn loopback(&self) -> Vec<String> {
        let status = self.ok("GET", "/v1/status", None).await;
        let bound = status["boundAddresses"].as_array().unwrap().iter().filter_map(Value::as_str);
        bound.filter_map(|address| address.strip_prefix("0.0.0.0:")).map(|port| format!("127.0.0.1:{port}")).collect()
    }
}

// ---------------------------------------------------------------------------------------------

/// Plan §13, *pairing survives application restarts*, as far as the sidecar holds it: the same
/// key is the same endpoint after a restart, a fresh launch trusts nobody, and the public ids
/// core stored are all it takes to be paired again — no new code, no new proof.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restart_with_the_same_key_is_the_same_computer_and_core_restores_the_pairing() {
    let (laptop_key, studio_key) = (SecretKey::generate(), SecretKey::generate());
    let service = echo().await;
    let mut seen = Vec::new();

    for run in 0..2 {
        let (laptop, studio) = (launch("laptop", &laptop_key).await, launch("studio", &studio_key).await);
        assert_eq!(laptop.id, laptop_key.public().to_string());
        assert_eq!(studio.id, studio_key.public().to_string());
        seen.push((laptop.id.clone(), studio.id.clone()));

        // A launch trusts nobody until core says so: the allowlist is core's, and it has not spoken yet.
        assert_eq!(laptop.ok("GET", "/v1/status", None).await["allowlist"], json!([]));
        let connect = format!("/v1/peers/{}/connect", studio.id);
        let refused = laptop.call("POST", &connect, None).await;
        assert_eq!((refused.status, refused.error()), (StatusCode::FORBIDDEN, Some("peer_not_allowed")));

        // Core restores what it stored — the other's public id and where it was last seen — and nothing else.
        let operations = json!([{ "name": "echo", "method": "POST", "path": "/v1/echo" }]);
        studio.ok("PUT", "/v1/host", Some(json!({ "port": service, "secret": HOST_SECRET, "operations": operations }))).await;
        studio.ok("PUT", "/v1/allowlist", Some(json!({ "endpointIds": [laptop.id] }))).await;
        laptop.ok("PUT", "/v1/allowlist", Some(json!({ "endpointIds": [studio.id] }))).await;
        laptop.ok("PUT", &format!("/v1/peers/{}/hints", studio.id), Some(json!({ "directAddresses": studio.loopback().await }))).await;
        assert_eq!(laptop.ok("POST", &connect, None).await["status"], "direct");
        let reply = laptop.call("POST", &format!("/bridge/{}/v1/echo", studio.id), Some(json!({ "run": run }))).await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.json().await, json!({ "run": run }));

        laptop.running.close().await;
        studio.running.close().await;
    }
    assert_eq!(seen[0], seen[1], "the same two computers both times");
}

/// A saved hint is `ip:port`, so the port has to be the same after a restart or every hint a
/// computer holds for another is stale the moment either app is relaunched.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_computer_listens_on_the_same_port_after_a_restart() {
    let key = SecretKey::generate();
    let mut ports = Vec::new();
    for _ in 0..2 {
        let side = launch("laptop", &key).await;
        ports.push(side.loopback().await);
        side.running.close().await;
    }
    assert_eq!(ports[0], vec![format!("127.0.0.1:{}", stable_port(&key))], "the port its identity gives it");
    assert_eq!(ports[0], ports[1], "the same one again");
}

/// The usual port is a preference: something else holding it is not a reason not to start.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_port_that_is_taken_is_not_a_reason_not_to_start() {
    let key = SecretKey::generate();
    let usual = stable_port(&key);
    let squatter = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, usual)).expect("the port is free for the test to take");
    let side = launch("laptop", &key).await;
    let ports = side.loopback().await;
    assert_eq!(ports.len(), 1, "it listens somewhere");
    assert_ne!(ports[0], format!("127.0.0.1:{usual}"), "and not where somebody else already is");
    side.running.close().await;
    drop(squatter);
}

/// Plan §13, *revocation closes connections*, from the other side to `transport.rs`'s: the
/// interaction computer unpairs, and the host can no longer reach it either.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unpairing_on_the_interaction_computer_closes_the_connection_both_ways() {
    let (laptop, studio) = (launch("laptop", &SecretKey::generate()).await, launch("studio", &SecretKey::generate()).await);
    studio.ok("PUT", "/v1/allowlist", Some(json!({ "endpointIds": [laptop.id] }))).await;
    laptop.ok("PUT", "/v1/allowlist", Some(json!({ "endpointIds": [studio.id] }))).await;
    laptop.ok("PUT", &format!("/v1/peers/{}/hints", studio.id), Some(json!({ "directAddresses": studio.loopback().await }))).await;
    studio.ok("PUT", &format!("/v1/peers/{}/hints", laptop.id), Some(json!({ "directAddresses": laptop.loopback().await }))).await;
    assert_eq!(laptop.ok("POST", &format!("/v1/peers/{}/connect", studio.id), None).await["status"], "direct");

    assert_eq!(laptop.ok("DELETE", &format!("/v1/allowlist/{}", studio.id), None).await, json!({ "revoked": true }));
    let listed = laptop.ok("GET", "/v1/peers", None).await;
    assert!(listed["peers"].as_array().unwrap().iter().all(|peer| peer["endpointId"] != studio.id.as_str()), "{listed}");
    // The laptop will not dial it, and the host, which still lists the laptop, is turned away at the laptop's gate.
    let out = laptop.call("POST", &format!("/v1/peers/{}/connect", studio.id), None).await;
    assert_eq!((out.status, out.error()), (StatusCode::FORBIDDEN, Some("peer_not_allowed")));
    // (A dial may itself succeed and be closed a moment later, as the README says, so the request is what is asked.)
    let back = studio.call("POST", &format!("/bridge/{}/v1/echo", laptop.id), Some(json!({}))).await;
    assert_eq!(back.status, StatusCode::FORBIDDEN, "the host reached a computer that unpaired it");
    assert_eq!(back.error(), Some("peer_rejected"));

    laptop.running.close().await;
    studio.running.close().await;
}
