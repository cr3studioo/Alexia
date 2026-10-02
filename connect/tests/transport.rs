// SPDX-License-Identifier: AGPL-3.0-only

//! Two — sometimes three — sidecars in one process, talking over real iroh endpoints on this
//! machine, with a stub standing in for the compute service.
//!
//! What this cannot show is in `README.md` under "Not exercised by tests": there is no relay
//! here, no NAT, and no second machine. Every connection below is direct, over loopback.

use std::cell::Cell;
use std::convert::Infallible;
use std::future::Future;
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_connect::{start, Network, Options, Running};
use bytes::Bytes;
use futures_util::stream;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Empty, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{HeaderMap, AUTHORIZATION};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use iroh::SecretKey;
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;
use tokio::time::{sleep, timeout};

const MIB: u64 = 1024 * 1024;
const BIG: u64 = 96 * MIB;
const PIECE: usize = 64 * 1024;
const HOST_SECRET: &str = "the-host-service-secret";

// ---------------------------------------------------------------------------------------------
// The stub compute service
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
struct Seen {
    /// Requests that reached the service at all, registered or not.
    hits: AtomicUsize,
    /// Bytes of `/v1/big` the service has been asked to produce.
    produced: AtomicU64,
    /// Requests whose caller went away before they were done.
    abandoned: AtomicUsize,
    headers: Mutex<Option<HeaderMap>>,
}

/// Counts an abandonment when dropped, unless it was told the work finished.
struct Watch(Arc<Seen>, Cell<bool>);

impl Drop for Watch {
    fn drop(&mut self) {
        if !self.1.get() {
            self.0.abandoned.fetch_add(1, Ordering::SeqCst);
        }
    }
}

type StubBody = UnsyncBoxBody<Bytes, Infallible>;

async fn stub() -> (u16, Arc<Seen>) {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Seen::default());
    let shared = seen.clone();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let seen = shared.clone();
            tokio::spawn(async move {
                let service = service_fn(move |request| serve_stub(seen.clone(), request));
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
            });
        }
    });
    (port, seen)
}

async fn serve_stub(seen: Arc<Seen>, request: Request<Incoming>) -> Result<Response<StubBody>, Infallible> {
    seen.hits.fetch_add(1, Ordering::SeqCst);
    *seen.headers.lock().unwrap() = Some(request.headers().clone());
    let path = request.uri().path().to_owned();
    let body: StubBody = match path.as_str() {
        // Whatever comes in goes back out, as it arrives.
        "/v1/echo" => request.into_body().map_err(|_| unreachable!("the test never breaks an upload")).boxed_unsync(),
        // A large body, made only as fast as it is taken.
        "/v1/big" => {
            let pieces = stream::unfold((0u64, Watch(seen.clone(), Cell::new(false))), move |(sent, watch)| {
                let seen = seen.clone();
                async move {
                    if sent >= BIG {
                        watch.1.set(true);
                        return None;
                    }
                    seen.produced.fetch_add(PIECE as u64, Ordering::SeqCst);
                    Some((Ok(Frame::data(Bytes::from(vec![7u8; PIECE]))), (sent + PIECE as u64, watch)))
                }
            });
            StreamBody::new(pieces).boxed_unsync()
        }
        // One line, then nothing, for as long as anybody is listening.
        path if path.starts_with("/v1/slow/") => {
            let pieces = stream::unfold((true, Watch(seen, Cell::new(false))), |(first, watch)| async move {
                if !first {
                    std::future::pending::<()>().await;
                }
                Some((Ok(Frame::data(Bytes::from_static(b"first\n"))), (false, watch)))
            });
            StreamBody::new(pieces).boxed_unsync()
        }
        // Never answers at all.
        "/v1/hang" => {
            let _watch = Watch(seen, Cell::new(false));
            std::future::pending().await
        }
        _ => Full::new(Bytes::from_static(b"private")).boxed_unsync(),
    };
    Ok(Response::new(body))
}

// ---------------------------------------------------------------------------------------------
// A client for the loopback port, as core would be
// ---------------------------------------------------------------------------------------------

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Incoming,
    /// The connection. Dropping the reply closes it, which is how a caller cancels.
    _connection: JoinSet<()>,
}

impl Reply {
    async fn piece(&mut self) -> Option<Result<Bytes, hyper::Error>> {
        loop {
            match self.body.frame().await? {
                Ok(frame) => match frame.into_data() {
                    Ok(data) => return Some(Ok(data)),
                    Err(_) => continue,
                },
                Err(error) => return Some(Err(error)),
            }
        }
    }

    async fn bytes(self) -> Vec<u8> {
        self.body.collect().await.expect("a whole body").to_bytes().to_vec()
    }

    async fn json(self) -> Value {
        serde_json::from_slice(&self.bytes().await).expect("json")
    }

    fn error(&self) -> Option<&str> {
        self.headers.get("x-alexia-connect-error").and_then(|value| value.to_str().ok())
    }
}

async fn call(port: u16, secret: Option<&str>, method: &str, path: &str, body: Option<Vec<u8>>) -> Reply {
    let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.unwrap();
    let mut held = JoinSet::new();
    held.spawn(async move {
        let _ = connection.await;
    });
    let mut request = Request::builder().method(method).uri(path).header("host", format!("127.0.0.1:{port}"));
    if let Some(secret) = secret {
        request = request.header(AUTHORIZATION, format!("Bearer {secret}"));
    }
    let request = match body {
        Some(body) => request.header("content-type", "application/json").body(Full::new(Bytes::from(body)).boxed()),
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

async fn side(name: &str) -> Side {
    let secret = format!("{name}-secret-0123456789abcdef0123456789abcdef");
    let options = Options { secret: secret.clone(), key: SecretKey::generate(), network: Network::default(), pairing: Default::default() };
    let running = start(options).await.expect("start");
    Side { port: running.port(), id: running.endpoint_id(), running, secret }
}

impl Side {
    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> Reply {
        call(self.port, Some(&self.secret), method, path, body.map(|body| body.to_string().into_bytes())).await
    }

    /// A control request that is expected to work.
    async fn ok(&self, method: &str, path: &str, body: Option<Value>) -> Value {
        let reply = self.call(method, path, body).await;
        assert_eq!(reply.status, StatusCode::OK, "{method} {path}");
        reply.json().await
    }

    async fn allow(&self, others: &[&Side]) {
        let ids: Vec<&str> = others.iter().map(|other| other.id.as_str()).collect();
        self.ok("PUT", "/v1/allowlist", Some(json!({ "endpointIds": ids }))).await;
    }

    /// Tell this side where `other` is, as pairing or LAN discovery would.
    async fn hint(&self, other: &Side) {
        let status = other.ok("GET", "/v1/status", None).await;
        let bound = status["boundAddresses"].as_array().unwrap().iter().filter_map(Value::as_str);
        let addresses: Vec<String> =
            bound.filter_map(|address| address.strip_prefix("0.0.0.0:")).map(|port| format!("127.0.0.1:{port}")).collect();
        assert!(!addresses.is_empty(), "an IPv4 socket");
        self.ok("PUT", &format!("/v1/peers/{}/hints", other.id), Some(json!({ "directAddresses": addresses }))).await;
    }

    async fn serve(&self, stub_port: u16) {
        let operations = json!([
            { "name": "echo", "method": "POST", "path": "/v1/echo" },
            { "name": "big", "method": "GET", "path": "/v1/big" },
            { "name": "slow", "method": "GET", "path": "/v1/slow/:id" },
            { "name": "hang", "method": "GET", "path": "/v1/hang" },
        ]);
        self.ok("PUT", "/v1/host", Some(json!({ "port": stub_port, "secret": HOST_SECRET, "operations": operations }))).await;
    }

    async fn status_of(&self, other: &Side) -> String {
        let peers = self.ok("GET", "/v1/peers", None).await;
        let listed = peers["peers"].as_array().unwrap().iter().find(|peer| peer["endpointId"] == other.id.as_str());
        listed.map_or("unlisted".to_owned(), |peer| peer["status"].as_str().unwrap().to_owned())
    }
}

/// An interaction computer and a compute host, paired, with the stub behind the host.
async fn paired() -> (Side, Side, Arc<Seen>) {
    let (interaction, host) = (side("interaction").await, side("host").await);
    let (stub_port, seen) = stub().await;
    host.serve(stub_port).await;
    host.allow(&[&interaction]).await;
    interaction.allow(&[&host]).await;
    interaction.hint(&host).await;
    (interaction, host, seen)
}

async fn eventually<F: Future<Output = bool>>(what: &str, mut check: impl FnMut() -> F) {
    for _ in 0..200 {
        if check().await {
            return;
        }
        sleep(Duration::from_millis(50)).await;
    }
    panic!("never happened: {what}");
}

/// The next server-sent event that is not a keepalive.
async fn event(reply: &mut Reply, buffer: &mut String) -> (String, Value) {
    loop {
        if let Some(end) = buffer.find("\n\n") {
            let text: String = buffer.drain(..end + 2).collect();
            let field = |name: &str| text.lines().find_map(|line| line.strip_prefix(name));
            if let (Some(event), Some(data)) = (field("event: "), field("data: ")) {
                return (event.to_owned(), serde_json::from_str(data).unwrap());
            }
            continue;
        }
        let piece = timeout(Duration::from_secs(10), reply.piece()).await.expect("an event in time");
        buffer.push_str(std::str::from_utf8(&piece.expect("an open stream").expect("no error")).unwrap());
    }
}

// ---------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_allowlisted_peer_is_forwarded_and_streamed_back() {
    let (interaction, host, seen) = paired().await;
    let bridge = format!("/bridge/{}", host.id);

    // A job that stays open, so that the next one has to be a stream of its own to finish.
    let mut slow = interaction.call("GET", &format!("{bridge}/v1/slow/job-1"), None).await;
    assert_eq!(slow.status, StatusCode::OK);
    assert_eq!(slow.piece().await.unwrap().unwrap(), "first\n");

    let sent: Vec<u8> = (0..4 * MIB as usize).map(|index| (index % 251) as u8).collect();
    let reply = call(interaction.port, Some(&interaction.secret), "POST", &format!("{bridge}/v1/echo?stream=true"), Some(sent.clone())).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert!(reply.error().is_none());
    assert!(reply.bytes().await == sent, "the body came back as it went");

    // What the compute service was shown: who asked, its own secret, and not the caller's.
    let headers = seen.headers.lock().unwrap().clone().unwrap();
    assert_eq!(headers.get("x-alexia-peer").unwrap(), interaction.id.as_str());
    assert_eq!(headers.get(AUTHORIZATION).unwrap(), &format!("Bearer {HOST_SECRET}"));
    assert_eq!(headers.get("content-type").unwrap(), "application/json");
    assert_eq!(seen.hits.load(Ordering::SeqCst), 2);

    // No relay is configured, so the only way the two can be talking is directly.
    assert_eq!(interaction.status_of(&host).await, "direct");
    assert_eq!(host.status_of(&interaction).await, "direct");

    // The status says who this is and never what it holds.
    let status = host.ok("GET", "/v1/status", None).await.to_string();
    assert!(status.contains(&host.id));
    assert!(!status.contains(HOST_SECRET) && !status.contains(&host.secret));

    // The caller hangs up on the open job, and the compute service loses its caller too.
    drop(slow);
    eventually("the abandoned job reached the service", || async { seen.abandoned.load(Ordering::SeqCst) == 1 }).await;

    interaction.running.close().await;
    host.running.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_reader_that_stops_stops_the_compute_service() {
    let (interaction, host, seen) = paired().await;
    let mut reply = interaction.call("GET", &format!("/bridge/{}/v1/big", host.id), None).await;
    assert_eq!(reply.status, StatusCode::OK);
    let mut read = reply.piece().await.unwrap().unwrap().len() as u64;

    // Read nothing more. The service keeps producing until every buffer between it and this
    // test is full — two loopback sockets and the QUIC windows — and then it has to wait.
    let produced = || seen.produced.load(Ordering::SeqCst);
    let mut settled = produced();
    eventually("production stalled", || {
        let before = std::mem::replace(&mut settled, produced());
        async move {
            sleep(Duration::from_millis(500)).await;
            before == produced()
        }
    })
    .await;
    let stalled = produced();
    println!("production stalled at {stalled} of {BIG} bytes, with {read} read");
    assert!(stalled < BIG / 2, "{stalled} bytes were produced for a reader that took {read}");
    sleep(Duration::from_secs(1)).await;
    assert_eq!(produced(), stalled, "nothing more is produced while nothing is read");

    // Start reading again and it starts producing again.
    while read < stalled + 8 * MIB {
        read += reply.piece().await.unwrap().unwrap().len() as u64;
    }
    assert!(produced() > stalled);

    // Hang up in the middle: the stream is reset and the service's connection is dropped.
    drop(reply);
    eventually("the cancelled job reached the service", || async { seen.abandoned.load(Ordering::SeqCst) == 1 }).await;
    assert!(produced() < BIG);

    interaction.running.close().await;
    host.running.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_job_cancelled_before_its_first_byte_is_cancelled_on_the_host() {
    let (interaction, host, seen) = paired().await;
    let path = format!("/bridge/{}/v1/hang", host.id);
    let asking = interaction.call("GET", &path, None);
    assert!(timeout(Duration::from_millis(500), asking).await.is_err(), "the service never answers");
    assert_eq!(seen.hits.load(Ordering::SeqCst), 1);
    eventually("the cancelled job reached the service", || async { seen.abandoned.load(Ordering::SeqCst) == 1 }).await;

    interaction.running.close().await;
    host.running.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_peer_that_is_not_allowlisted_is_rejected() {
    let (interaction, host, seen) = paired().await;
    let stranger = side("stranger").await;
    // The stranger knows exactly where the host is, and believes it is paired with it.
    stranger.allow(&[&host]).await;
    stranger.hint(&host).await;

    let reply = stranger.call("POST", &format!("/bridge/{}/v1/echo", host.id), Some(json!({}))).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.error(), Some("peer_rejected"));
    assert_eq!(reply.json().await["error"]["code"], "peer_rejected");
    assert_eq!(seen.hits.load(Ordering::SeqCst), 0, "nothing reached the compute service");
    assert_eq!(host.status_of(&stranger).await, "unlisted");

    // A hint is not an invitation: the host will not keep one for an endpoint it has not paired.
    let hinted = host.call("PUT", &format!("/v1/peers/{}/hints", stranger.id), Some(json!({ "directAddresses": ["127.0.0.1:9"] }))).await;
    assert_eq!(hinted.error(), Some("peer_not_allowed"));

    // And the bridge does not dial an endpoint this side has not paired with.
    let reply = interaction.call("POST", &format!("/bridge/{}/v1/echo", stranger.id), Some(json!({}))).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.error(), Some("peer_not_allowed"));

    // The paired computer is unaffected by any of it.
    let reply = interaction.call("POST", &format!("/bridge/{}/v1/echo", host.id), Some(json!({ "a": 1 }))).await;
    assert_eq!(reply.json().await, json!({ "a": 1 }));
    assert_eq!(seen.hits.load(Ordering::SeqCst), 1);

    for side in [interaction, host, stranger] {
        side.running.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_operation_that_is_not_registered_is_rejected() {
    let (interaction, host, seen) = paired().await;
    let bridge = format!("/bridge/{}", host.id);
    for (method, path) in [
        ("GET", "/private/file"),
        ("GET", "/v1/echo"),
        ("POST", "/v1/echo/more"),
        ("GET", "/v1/slow/a/b"),
        ("GET", "/v1/slow/.."),
        ("GET", ""),
    ] {
        let reply = interaction.call(method, &format!("{bridge}{path}"), None).await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{method} {path}");
        assert_eq!(reply.error(), Some("operation_not_registered"), "{method} {path}");
    }
    assert_eq!(seen.hits.load(Ordering::SeqCst), 0, "nothing reached the compute service");

    // With no host service registered there is nothing to forward to at all.
    host.ok("DELETE", "/v1/host", None).await;
    let reply = interaction.call("POST", &format!("{bridge}/v1/echo"), Some(json!({}))).await;
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(reply.error(), Some("host_unavailable"));
    assert_eq!(seen.hits.load(Ordering::SeqCst), 0);

    interaction.running.close().await;
    host.running.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_call_without_the_secret_is_rejected() {
    let (interaction, host, seen) = paired().await;
    let bridge = format!("/bridge/{}/v1/echo", host.id);
    let revoke = format!("/v1/allowlist/{}", host.id);
    let calls = [
        ("GET", "/v1/status"),
        ("GET", "/v1/peers"),
        ("GET", "/v1/events"),
        ("PUT", "/v1/allowlist"),
        ("DELETE", revoke.as_str()),
        ("PUT", "/v1/host"),
        ("POST", "/v1/shutdown"),
        ("POST", bridge.as_str()),
        ("GET", "/nothing"),
    ];
    for secret in [None, Some("not-the-secret"), Some(host.secret.as_str()), Some("")] {
        for (method, path) in calls {
            let reply = call(interaction.port, secret, method, path, Some(b"{\"endpointIds\":[]}".to_vec())).await;
            assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{method} {path}");
            assert_eq!(reply.error(), Some("unauthorized"));
        }
    }
    // With the secret, what is wrong with a request is said, and nothing is changed by it.
    let big = interaction.call("PUT", "/v1/allowlist", Some(json!({ "endpointIds": ["0".repeat(70_000)] }))).await;
    assert_eq!((big.status, big.error()), (StatusCode::PAYLOAD_TOO_LARGE, Some("payload_too_large")));
    let odd = interaction.call("PUT", "/v1/allowlist", Some(json!({ "endpointIds": ["not-an-id"] }))).await;
    assert_eq!((odd.status, odd.error()), (StatusCode::BAD_REQUEST, Some("bad_request")));
    let remote = interaction.call("PUT", "/v1/host", Some(json!({ "port": 80, "host": "10.0.0.1", "operations": [] }))).await;
    assert_eq!(remote.error(), Some("bad_request"), "a host service is a loopback port and nothing else");
    assert_eq!(interaction.call("GET", "/nothing", None).await.error(), Some("not_found"));

    // None of those did anything: the allowlist stands, and nothing was forwarded.
    assert_eq!(interaction.ok("GET", "/v1/status", None).await["allowlist"], json!([host.id]));
    assert_eq!(seen.hits.load(Ordering::SeqCst), 0);

    interaction.running.close().await;
    host.running.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn revocation_closes_a_live_connection() {
    let (interaction, host, seen) = paired().await;
    let bridge = format!("/bridge/{}", host.id);

    let (mut events, mut buffer) = (interaction.call("GET", "/v1/events", None).await, String::new());
    let (name, snapshot) = event(&mut events, &mut buffer).await;
    assert_eq!((name.as_str(), &snapshot), ("snapshot", &json!({ "peers": [{ "endpointId": host.id, "status": "offline" }] })));

    // A job in flight.
    let mut job = interaction.call("GET", &format!("{bridge}/v1/slow/job-1"), None).await;
    assert_eq!(job.piece().await.unwrap().unwrap(), "first\n");
    assert_eq!(event(&mut events, &mut buffer).await, ("peer".to_owned(), json!({ "endpointId": host.id, "status": "direct" })));

    // The host's owner unpairs the interaction computer.
    let revoked = host.ok("DELETE", &format!("/v1/allowlist/{}", interaction.id), None).await;
    assert_eq!(revoked, json!({ "revoked": true }));

    // The job ends, broken rather than finished, without anybody waiting for a timeout…
    let ended = timeout(Duration::from_secs(5), job.piece()).await.expect("the job ended at once");
    assert!(matches!(ended, Some(Err(_))), "a revoked job is an error, not an ending");
    // …the compute service loses its caller…
    eventually("the revoked job reached the service", || async { seen.abandoned.load(Ordering::SeqCst) == 1 }).await;
    // …and both sides say so.
    assert_eq!(event(&mut events, &mut buffer).await, ("peer".to_owned(), json!({ "endpointId": host.id, "status": "offline" })));
    assert_eq!(interaction.status_of(&host).await, "offline");
    assert_eq!(host.status_of(&interaction).await, "unlisted");

    // It cannot come back by asking again.
    let reply = interaction.call("POST", &format!("{bridge}/v1/echo"), Some(json!({}))).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.error(), Some("peer_rejected"));
    assert_eq!(seen.hits.load(Ordering::SeqCst), 1);

    interaction.running.close().await;
    host.running.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn changing_the_network_keeps_the_identity() {
    let (interaction, host, seen) = paired().await;
    let bridge = format!("/bridge/{}/v1/echo", host.id);
    assert_eq!(interaction.call("POST", &bridge, Some(json!({ "n": 1 }))).await.json().await, json!({ "n": 1 }));
    let before = host.ok("GET", "/v1/status", None).await;

    // Not a URL: refused, and nothing changes.
    let reply = host.call("PUT", "/v1/network", Some(json!({ "relayUrls": ["relay.example.org"], "lookupUrl": null }))).await;
    assert_eq!(reply.error(), Some("bad_request"));
    assert_eq!(host.ok("GET", "/v1/status", None).await["boundAddresses"], before["boundAddresses"]);

    let after = host.ok("PUT", "/v1/network", Some(json!({ "relayUrls": [], "lookupUrl": null }))).await;
    assert_eq!(after["endpointId"], before["endpointId"], "the same computer");
    assert_ne!(after["boundAddresses"], before["boundAddresses"], "a new endpoint");
    assert_eq!(after["allowlist"], json!([interaction.id]), "still paired");
    assert_eq!(after["host"], before["host"], "still serving");

    // The old connection went with the old endpoint; the next request dials the new one.
    eventually("the old connection closed", || async { interaction.status_of(&host).await == "offline" }).await;
    interaction.hint(&host).await;
    assert_eq!(interaction.call("POST", &bridge, Some(json!({ "n": 2 }))).await.json().await, json!({ "n": 2 }));
    assert_eq!(seen.hits.load(Ordering::SeqCst), 2);

    interaction.running.close().await;
    host.running.close().await;
}
