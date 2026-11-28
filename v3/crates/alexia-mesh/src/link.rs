// SPDX-License-Identifier: AGPL-3.0-only
//! The limb link: MCP as duplex ndjson over one HTTP POST on the mesh (LINK_PATH).
//!
//! The hub sends one `POST {bridge}/{endpoint}{LINK_PATH}` whose request body is its half of the
//! conversation and whose response body is the limb's. Each JSON-RPC message is one line. Each
//! side writes a bare `"\n"` after [`KEEPALIVE_MS`] of silence, so neither QUIC nor anything on
//! the way idles the link out; empty lines are dropped before [`Link::rx`].
//!
//! This file also holds the node's one *host service*: the loopback HTTP server connect forwards
//! paired devices' requests to. The link and the hub operations (ops.rs) share it, because
//! connect keeps one registration. Line contents are conversations and are never logged.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::Ipv4Addr;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::{Body, Frame, Incoming};
use hyper::header::{AUTHORIZATION, CONTENT_TYPE, HOST};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::node::Node;
use crate::ops::{self, HubOp};
use crate::{DeviceId, Error, Result, KEEPALIVE_MS, LINK_PATH, OP_FACE, OP_KILL, OP_PRESENCE};

/// How long the hub waits for the limb's answer to a dial: connect's own dial timeout.
const DIAL_TIMEOUT: Duration = Duration::from_secs(15);
/// The longest line either side reads. A longer one closes the link.
const LINE_MAX: usize = 16 * 1024 * 1024;
/// Lines queued in each direction before the sender waits.
const LINES_HELD: usize = 64;
/// connect's header naming who sent a forwarded request, and the one marking its own answers.
const HEADER_PEER: &str = "x-alexia-peer";
const HEADER_CONNECT_ERROR: &str = "x-alexia-connect-error";

/// One duplex JSON-RPC line stream. Lines in and out, keepalives hidden.
pub struct Link {
    /// Each line the other side sent, without its `\n`. Ends when the link closes.
    pub rx: mpsc::Receiver<String>,
    /// A line to send, without a `\n`. Dropping it closes the link.
    pub tx: mpsc::Sender<String>,
    /// Fires when the link closes, from either side; cancel it to close the link.
    pub closed: CancellationToken,
}

impl Node {
    /// Hub → limb: POST {bridge}/{endpoint}{LINK_PATH}, streaming body both ways. Err(Unreachable)
    /// within 15 s if the peer cannot be reached; Err(Refused) on connect's refusal codes.
    pub async fn dial(&self, device: &DeviceId) -> Result<Link> {
        let row = self
            .store()
            .device(&device.0)?
            .filter(|d| d.revoked_at.is_none())
            .ok_or(Error::NotPaired)?;
        let (base, secret) = self.loopback();
        let port: u16 = base
            .rsplit(':')
            .next()
            .and_then(|p| p.parse().ok())
            .ok_or_else(|| Error::Connect("connect's loopback address has no port.".into()))?;
        let closed = CancellationToken::new();
        // Until the link is handed out, failing anywhere drops the connection with it.
        let guard = closed.clone().drop_guard();
        let (body_tx, body) = out_body();
        let request = Request::post(format!("/bridge/{}{LINK_PATH}", row.endpoint))
            .header(HOST, format!("127.0.0.1:{port}"))
            .header(AUTHORIZATION, format!("Bearer {secret}"))
            .header(CONTENT_TYPE, "application/x-ndjson")
            .body(body)
            .map_err(|_| Error::Connect("the link request could not be made.".into()))?;
        let answer = tokio::time::timeout(DIAL_TIMEOUT, async {
            let tcp = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await?;
            let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(tcp))
                .await
                .map_err(|e| Error::Connect(format!("connect did not answer ({e}).")))?;
            let held = closed.clone();
            tokio::spawn(async move {
                tokio::select! {
                    _ = connection => {}
                    () = held.cancelled() => {}
                }
                held.cancel();
            });
            sender
                .send_request(request)
                .await
                .map_err(|e| Error::Connect(format!("connect did not answer ({e}).")))
        })
        .await
        .map_err(|_| Error::Unreachable)??;
        if answer.status() != StatusCode::OK {
            let code = answer
                .headers()
                .get(HEADER_CONNECT_ERROR)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            return Err(refusal(answer.status(), code.as_deref()));
        }
        guard.disarm();
        Ok(join(answer.into_body(), body_tx, closed))
    }

    /// Limb: serve the host service on 127.0.0.1 (random port), register it with connect
    /// (`PUT /v1/host`, operation `link` POST LINK_PATH, with a host secret), and hand each
    /// accepted link to `on_link`. A request whose `x-alexia-peer` is not a paired *hub* gets 403.
    pub async fn accept_links(
        self: &Arc<Self>,
        on_link: impl Fn(DeviceId, Link) + Send + Sync + 'static,
    ) -> Result<()> {
        let host = host_service(self)?;
        *lock(&host.on_link) = Some(Arc::new(on_link));
        register(self, &host).await
    }
}

/// connect's answer to a bridge request that was not a `200`, as our error. `code` is the
/// `x-alexia-connect-error` header: present when connect itself answered, absent when the other
/// device's host service did.
pub(crate) fn refusal(status: StatusCode, code: Option<&str>) -> Error {
    match code {
        None => Error::Refused(format!("it answered {}.", status.as_u16())),
        Some("peer_unreachable" | "stream_failed") => Error::Unreachable,
        Some("peer_not_allowed") => Error::NotPaired,
        Some("peer_rejected") => Error::Refused("it does not accept this device.".into()),
        Some("operation_not_registered") => {
            Error::Refused("it does not offer that operation.".into())
        }
        Some("host_unavailable") => Error::Refused("it is not serving the mesh right now.".into()),
        Some(code) => Error::Connect(format!("connect answered {status} with code {code}.")),
    }
}

/// The same two ends as OS pipes, typed as tokio's `ChildStdin`/`ChildStdout` (as `alexia-mcp`'s
/// wasm guest does), for `McpHost`'s `Dial` (P4-11). Pumps run until either side closes.
pub fn into_stdio(link: Link) -> std::io::Result<(ChildStdin, ChildStdout)> {
    #[cfg(unix)]
    type Owned = std::os::fd::OwnedFd;
    #[cfg(windows)]
    type Owned = std::os::windows::io::OwnedHandle;
    let writer = |w: std::io::PipeWriter| ChildStdin::from_std(Owned::from(w).into());
    let reader = |r: std::io::PipeReader| ChildStdout::from_std(Owned::from(r).into());
    // Pipe a carries what the caller writes to the link; pipe b what the link reads to the caller.
    let (ar, aw) = std::io::pipe()?;
    let (br, bw) = std::io::pipe()?;
    let (stdin, from_caller) = (writer(aw)?, reader(ar)?);
    let (stdout, mut to_caller) = (reader(br)?, writer(bw)?);
    let Link { mut rx, tx, closed } = link;
    let done = closed.clone();
    tokio::spawn(async move {
        let _close = done.clone().drop_guard();
        let mut lines = BufReader::new(from_caller).lines();
        loop {
            let line = tokio::select! {
                () = done.cancelled() => return,
                line = lines.next_line() => line,
            };
            let Ok(Some(line)) = line else { return };
            if tx.send(line).await.is_err() {
                return;
            }
        }
    });
    tokio::spawn(async move {
        let _close = closed.clone().drop_guard();
        loop {
            let line = tokio::select! {
                () = closed.cancelled() => return,
                line = rx.recv() => line,
            };
            let Some(mut line) = line else { return };
            line.push('\n');
            if to_caller.write_all(line.as_bytes()).await.is_err() {
                return;
            }
        }
    });
    Ok((stdin, stdout))
}

/// The body this side writes: pieces from a channel, ending when its sender is dropped.
pub(crate) struct OutBody(mpsc::Receiver<Bytes>);

impl Body for OutBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<std::result::Result<Frame<Bytes>, Infallible>>> {
        self.0
            .poll_recv(cx)
            .map(|piece| piece.map(|b| Ok(Frame::data(b))))
    }
}

fn out_body() -> (mpsc::Sender<Bytes>, OutBody) {
    // One piece in flight: a slow reader on the other side slows the writer here.
    let (tx, rx) = mpsc::channel(1);
    (tx, OutBody(rx))
}

/// A link from the body the other side writes and the sender of the body this side writes.
/// Two tasks: they and everything they hold end when `closed` fires, and either ending fires it.
fn join(incoming: Incoming, body: mpsc::Sender<Bytes>, closed: CancellationToken) -> Link {
    let (in_tx, rx) = mpsc::channel(LINES_HELD);
    let (tx, out_rx) = mpsc::channel(LINES_HELD);
    tokio::spawn(write(out_rx, body, closed.clone()));
    tokio::spawn(read(incoming, in_tx, closed.clone()));
    Link { rx, tx, closed }
}

/// Lines from the caller onto the body, with a `"\n"` after each keepalive period of silence.
async fn write(
    mut lines: mpsc::Receiver<String>,
    body: mpsc::Sender<Bytes>,
    closed: CancellationToken,
) {
    let _close = closed.clone().drop_guard();
    let keepalive = Duration::from_millis(KEEPALIVE_MS);
    loop {
        let piece = tokio::select! {
            () = closed.cancelled() => return,
            line = tokio::time::timeout(keepalive, lines.recv()) => match line {
                Ok(Some(mut line)) => {
                    line.push('\n');
                    Bytes::from(line)
                }
                Ok(None) => return, // the caller dropped `tx`
                Err(_) => Bytes::from_static(b"\n"),
            },
        };
        tokio::select! {
            () = closed.cancelled() => return,
            sent = body.send(piece) => if sent.is_err() { return },
        }
    }
}

/// The other side's body, split into lines for the caller. Empty lines (keepalives) are dropped.
async fn read(mut body: Incoming, lines: mpsc::Sender<String>, closed: CancellationToken) {
    let _close = closed.clone().drop_guard();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let frame = tokio::select! {
            () = closed.cancelled() => return,
            frame = body.frame() => frame,
        };
        // The end, or an error: the other side has gone either way.
        let Some(Ok(frame)) = frame else { return };
        let Ok(data) = frame.into_data() else {
            continue;
        };
        let mut from = buf.len();
        buf.extend_from_slice(&data);
        let mut start = 0;
        while let Some(i) = buf[from..].iter().position(|&b| b == b'\n') {
            let end = from + i;
            let line = &buf[start..end];
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            from = end + 1;
            if line.len() > LINE_MAX {
                tracing::warn!("the link read a line over 16 MiB; closing it");
                return;
            }
            if !line.is_empty() {
                let Ok(line) = String::from_utf8(line.to_vec()) else {
                    tracing::warn!("the link read a line that is not UTF-8; closing it");
                    return;
                };
                tokio::select! {
                    () = closed.cancelled() => return,
                    sent = lines.send(line) => if sent.is_err() { return },
                }
            }
            start = from;
        }
        buf.drain(..start);
        if buf.len() > LINE_MAX {
            tracing::warn!("the link read a line over 16 MiB; closing it");
            return;
        }
    }
}

// ---- the host service ----

pub(crate) type Out = BoxBody<Bytes, Infallible>;
type OnLink = Arc<dyn Fn(DeviceId, Link) + Send + Sync>;
type OnOp = Arc<dyn Fn(HubOp) + Send + Sync>;

/// A node's one host service: where connect forwards what paired devices ask for.
struct Host {
    port: u16,
    secret: String,
    on_link: Mutex<Option<OnLink>>,
    on_op: Mutex<Option<OnOp>>,
}

/// Every running node's host service, by endpoint id.
// ponytail: an entry and its listener outlive their node (a socket per node per process);
// clear it in `Node::close` if nodes are ever started and stopped many times.
static HOSTS: LazyLock<Mutex<HashMap<String, Arc<Host>>>> = LazyLock::new(Default::default);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// This node's host service, started on first use.
fn host_service(node: &Arc<Node>) -> Result<Arc<Host>> {
    let mut hosts = lock(&HOSTS);
    if let Some(host) = hosts.get(&node.endpoint().0) {
        return Ok(host.clone());
    }
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let listener = TcpListener::from_std(listener)?;
    // 32 random bytes from the OS's CSPRNG, as hex, as node.rs makes connect's secret.
    let secret = iroh::SecretKey::generate()
        .to_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let host = Arc::new(Host {
        port: listener.local_addr()?.port(),
        secret,
        on_link: Mutex::new(None),
        on_op: Mutex::new(None),
    });
    tokio::spawn(accept(listener, Arc::downgrade(node), host.clone()));
    hosts.insert(node.endpoint().0, host.clone());
    Ok(host)
}

/// `PUT /v1/host` with every operation this node serves so far.
async fn register(node: &Node, host: &Host) -> Result<()> {
    let mut operations = Vec::new();
    if lock(&host.on_link).is_some() {
        operations.push(json!({ "name": "link", "method": "POST", "path": LINK_PATH }));
    }
    if lock(&host.on_op).is_some() {
        for (name, path) in [
            ("kill", OP_KILL),
            ("presence", OP_PRESENCE),
            ("face", OP_FACE),
        ] {
            operations.push(json!({ "name": name, "method": "POST", "path": path }));
        }
    }
    let body = json!({ "port": host.port, "secret": host.secret, "operations": operations });
    let (base, secret) = node.loopback();
    let res = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| Error::Connect(format!("the HTTP client could not be made ({e}).")))?
        .put(format!("{base}/v1/host"))
        .bearer_auth(secret)
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Connect(format!("connect did not answer ({}).", e.without_url())))?;
    if !res.status().is_success() {
        return Err(Error::Connect(format!(
            "connect refused the host service with {}.",
            res.status()
        )));
    }
    Ok(())
}

pub(crate) async fn install_ops(node: &Arc<Node>, on_op: OnOp) -> Result<()> {
    let host = host_service(node)?;
    *lock(&host.on_op) = Some(on_op);
    register(node, &host).await
}

async fn accept(listener: TcpListener, node: Weak<Node>, host: Arc<Host>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        let (node, host) = (node.clone(), host.clone());
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |request| {
                let (node, host) = (node.clone(), host.clone());
                async move { Ok::<_, Infallible>(serve(&node, &host, request).await) }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
    }
}

pub(crate) fn answer(status: StatusCode, body: &'static str) -> Response<Out> {
    let mut response = Response::new(Full::new(Bytes::from_static(body.as_bytes())).boxed());
    *response.status_mut() = status;
    response.headers_mut().insert(
        CONTENT_TYPE,
        "application/json".parse().expect("a header value"),
    );
    response
}

/// Equal, in time that does not depend on where they differ.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |d, (x, y)| d | (x ^ y)) == 0
}

/// One forwarded request. Only connect knows the host secret; only a paired, non-revoked
/// device's endpoint in `x-alexia-peer` gets further.
async fn serve(node: &Weak<Node>, host: &Host, request: Request<Incoming>) -> Response<Out> {
    let bearer = format!("Bearer {}", host.secret);
    let authorized = request
        .headers()
        .get(AUTHORIZATION)
        .is_some_and(|v| same(v.as_bytes(), bearer.as_bytes()));
    if !authorized {
        return answer(StatusCode::UNAUTHORIZED, r#"{"error":"unauthorized"}"#);
    }
    let Some(node) = node.upgrade() else {
        return answer(StatusCode::SERVICE_UNAVAILABLE, r#"{"error":"stopped"}"#);
    };
    let peer = request
        .headers()
        .get(HEADER_PEER)
        .and_then(|v| v.to_str().ok())
        .and_then(|e| node.store().device_by_endpoint(e).ok().flatten())
        .filter(|d| d.revoked_at.is_none());
    let Some(peer) = peer else {
        return answer(StatusCode::FORBIDDEN, r#"{"error":"not paired"}"#);
    };
    if request.method() != Method::POST {
        return answer(StatusCode::NOT_FOUND, r#"{"error":"not found"}"#);
    }
    let path = request.uri().path().to_string();
    let device = DeviceId(peer.id);
    if path == LINK_PATH {
        let Some(on_link) = lock(&host.on_link).clone() else {
            return answer(StatusCode::NOT_FOUND, r#"{"error":"not found"}"#);
        };
        // A limb takes its link from its hub, and from nothing else.
        if peer.role != "hub" {
            return answer(StatusCode::FORBIDDEN, r#"{"error":"not a hub"}"#);
        }
        let (body_tx, body) = out_body();
        let link = join(request.into_body(), body_tx, CancellationToken::new());
        on_link(device, link);
        let mut response = Response::new(body.boxed());
        response.headers_mut().insert(
            CONTENT_TYPE,
            "application/x-ndjson".parse().expect("a header value"),
        );
        return response;
    }
    if [OP_KILL, OP_PRESENCE, OP_FACE].contains(&path.as_str()) {
        let Some(on_op) = lock(&host.on_op).clone() else {
            return answer(StatusCode::NOT_FOUND, r#"{"error":"not found"}"#);
        };
        // The hub's operations are for its limbs.
        if peer.role != "limb" {
            return answer(StatusCode::FORBIDDEN, r#"{"error":"not a limb"}"#);
        }
        return ops::serve(device, &path, request.into_body(), &*on_op).await;
    }
    answer(StatusCode::NOT_FOUND, r#"{"error":"not found"}"#)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusals_map() {
        assert!(matches!(
            refusal(StatusCode::BAD_GATEWAY, Some("peer_unreachable")),
            Error::Unreachable
        ));
        assert!(matches!(
            refusal(StatusCode::FORBIDDEN, Some("peer_rejected")),
            Error::Refused(_)
        ));
        assert!(matches!(
            refusal(StatusCode::FORBIDDEN, None),
            Error::Refused(_)
        ));
        assert!(same(b"abc", b"abc") && !same(b"abc", b"abd") && !same(b"ab", b"abc"));
    }
}
