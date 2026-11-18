// SPDX-License-Identifier: AGPL-3.0-only
//! JSON-RPC over a plugin's stdio, both directions: out-of-order answers, progress,
//! cancellation, and the plugin's own requests (INTERFACES.md §3.1).

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::jsonrpc::{Id, Message, Notification, Outcome, Request, Response, RpcError, V2};
use crate::process::{read_lines, StderrLog};
use crate::types::{ProgressParams, ProgressToken};
use crate::{CallError, ProgressSink};

#[async_trait::async_trait]
pub trait Incoming: Send + Sync {
    /// A request from the plugin (alexia/*, roots/list, sampling/…, ping is answered by Conn).
    async fn request(&self, method: String, params: Option<Value>) -> Result<Value, RpcError>;
    /// A notification from the plugin other than progress and cancelled.
    async fn notification(&self, method: String, params: Option<Value>);
}

pub struct Conn {
    shared: Arc<Shared>,
    /// Stops the writer, which closes stdin: dropping the `Conn` is the polite stop.
    shutdown: CancellationToken,
}

struct Shared {
    out: mpsc::UnboundedSender<String>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Outcome>>>,
    progress: Mutex<HashMap<i64, ProgressSink>>,
    /// The plugin's own requests in flight, so its `notifications/cancelled` can stop them.
    incoming: Mutex<HashMap<Id, CancellationToken>>,
    closed: CancellationToken,
    born: Instant,
    heard_ms: AtomicU64,
}

/// A poisoned lock still holds a usable map.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Shared {
    fn send(&self, msg: &impl serde::Serialize) -> std::io::Result<()> {
        let line = serde_json::to_string(msg)?;
        self.out
            .send(line)
            .map_err(|_| std::io::ErrorKind::BrokenPipe.into())
    }

    fn notify(&self, method: &str, params: Option<Value>) -> std::io::Result<()> {
        self.send(&Notification {
            jsonrpc: V2,
            method: method.into(),
            params,
        })
    }

    fn answer(&self, id: Id, outcome: Outcome) {
        let _ = self.send(&Response {
            jsonrpc: V2,
            id,
            outcome,
        });
    }
}

impl Conn {
    /// `log` receives stdout lines that are not JSON (as `[not json] …`).
    pub fn start(
        stdin: ChildStdin,
        stdout: ChildStdout,
        log: StderrLog,
        incoming: Arc<dyn Incoming>,
    ) -> Conn {
        let (out, rx) = mpsc::unbounded_channel();
        let shared = Arc::new(Shared {
            out,
            next_id: AtomicI64::new(1),
            pending: Mutex::default(),
            progress: Mutex::default(),
            incoming: Mutex::default(),
            closed: CancellationToken::new(),
            born: Instant::now(),
            heard_ms: AtomicU64::new(0),
        });
        let shutdown = CancellationToken::new();
        tokio::spawn(write_loop(stdin, rx, shutdown.clone()));
        let s = Arc::clone(&shared);
        tokio::spawn(async move {
            read_lines(stdout, |line| on_line(&s, &log, &incoming, line)).await;
            s.closed.cancel();
            // Dropping the senders resolves every waiting caller to `Gone`.
            lock(&s.pending).clear();
            lock(&s.progress).clear();
            for (_, t) in lock(&s.incoming).drain() {
                t.cancel();
            }
        });
        Conn { shared, shutdown }
    }

    /// Ids count from 1 per Conn. With `progress`, sets `params._meta.progressToken` to the id
    /// and forwards matching `notifications/progress` there. On `cancel`: sends
    /// `notifications/cancelled {requestId}` and returns `CallError::Cancelled`. On timeout:
    /// sends the same and returns `CallError::Timeout`. Stdout EOF → `CallError::Gone`.
    pub async fn request(
        &self,
        method: &str,
        params: Option<Value>,
        progress: Option<ProgressSink>,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<Value, CallError> {
        let s = &self.shared;
        if s.closed.is_cancelled() {
            return Err(CallError::Gone);
        }
        let id = s.next_id.fetch_add(1, Ordering::Relaxed);
        let mut params = params;
        if let Some(sink) = progress {
            let p = params.get_or_insert_with(|| json!({}));
            if !p.is_object() {
                *p = json!({});
            }
            let meta = p
                .as_object_mut()
                .expect("object")
                .entry("_meta")
                .or_insert_with(|| json!({}));
            if !meta.is_object() {
                *meta = json!({});
            }
            meta["progressToken"] = json!(id);
            lock(&s.progress).insert(id, sink);
        }
        let (tx, rx) = oneshot::channel();
        lock(&s.pending).insert(id, tx);
        // Removes this call's entries however the wait below ends.
        let _cleanup = Cleanup(s, id);

        let sent = s.send(&Request {
            jsonrpc: V2,
            id: Id::Num(id),
            method: method.into(),
            params,
        });
        if sent.is_err() {
            return Err(CallError::Gone);
        }
        let cancelled = |err: CallError| {
            let _ = s.notify("notifications/cancelled", Some(json!({"requestId": id})));
            Err(err)
        };
        tokio::select! {
            biased;
            r = rx => match r {
                Ok(Outcome::Result(v)) => Ok(v),
                Ok(Outcome::Error(e)) => Err(CallError::Rpc(e)),
                Err(_) => Err(CallError::Gone),
            },
            () = cancel.cancelled() => cancelled(CallError::Cancelled),
            () = tokio::time::sleep(timeout) => cancelled(CallError::Timeout),
        }
    }

    pub async fn notify(&self, method: &str, params: Option<Value>) -> std::io::Result<()> {
        self.shared.notify(method, params)
    }

    /// Cancelled when stdout reaches EOF or the reader fails.
    pub fn closed(&self) -> CancellationToken {
        self.shared.closed.clone()
    }

    /// Millis since the plugin last sent anything (for idle and heartbeat, P0-12).
    pub fn quiet_ms(&self) -> u64 {
        let now = self.shared.born.elapsed().as_millis() as u64;
        now.saturating_sub(self.shared.heard_ms.load(Ordering::Relaxed))
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

struct Cleanup<'a>(&'a Shared, i64);

impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        lock(&self.0.pending).remove(&self.1);
        lock(&self.0.progress).remove(&self.1);
    }
}

/// The one writer: each message is one `\n`-terminated line.
async fn write_loop(
    mut stdin: ChildStdin,
    mut rx: mpsc::UnboundedReceiver<String>,
    shutdown: CancellationToken,
) {
    loop {
        let line = tokio::select! {
            biased;
            () = shutdown.cancelled() => break,
            line = rx.recv() => match line {
                Some(line) => line,
                None => break,
            },
        };
        let mut bytes = line.into_bytes();
        bytes.push(b'\n');
        if stdin.write_all(&bytes).await.is_err() || stdin.flush().await.is_err() {
            break;
        }
    }
    // Dropping `stdin` closes it; `rx` goes too, so later sends report BrokenPipe.
}

fn on_line(s: &Arc<Shared>, log: &StderrLog, incoming: &Arc<dyn Incoming>, line: &str) {
    s.heard_ms
        .store(s.born.elapsed().as_millis() as u64, Ordering::Relaxed);
    if line.trim().is_empty() {
        return;
    }
    let msg = match serde_json::from_str::<Message>(line) {
        Ok(msg) => msg,
        Err(_) => {
            log.push_cut(&format!("[not json] {line}"), "[not json] ".len() + 200);
            return;
        }
    };
    match msg {
        Message::Response(r) => {
            if let Id::Num(n) = r.id {
                // Taken out before sending so the lock is never held past this line.
                let tx = lock(&s.pending).remove(&n);
                if let Some(tx) = tx {
                    let _ = tx.send(r.outcome);
                }
            }
        }
        Message::Request(r) if r.method == "ping" => s.answer(r.id, Outcome::Result(json!({}))),
        Message::Request(r) => {
            let token = CancellationToken::new();
            lock(&s.incoming).insert(r.id.clone(), token.clone());
            let (s, incoming) = (Arc::clone(s), Arc::clone(incoming));
            tokio::spawn(async move {
                tokio::select! {
                    out = incoming.request(r.method, r.params) => {
                        let outcome = match out {
                            Ok(v) => Outcome::Result(v),
                            Err(e) => Outcome::Error(e),
                        };
                        s.answer(r.id.clone(), outcome);
                    }
                    () = token.cancelled() => {}
                }
                lock(&s.incoming).remove(&r.id);
            });
        }
        Message::Notification(n) if n.method == "notifications/progress" => {
            let Some(p) = n
                .params
                .and_then(|p| serde_json::from_value::<ProgressParams>(p).ok())
            else {
                return;
            };
            let ProgressToken::Num(id) = p.progress_token else {
                return;
            };
            let sink = lock(&s.progress).get(&id).cloned();
            if let Some(sink) = sink {
                // Progress is lossy: a full sink drops a frame rather than stall the reader.
                let _ = sink.try_send(p);
            }
        }
        Message::Notification(n) if n.method == "notifications/cancelled" => {
            let id = n
                .params
                .and_then(|p| serde_json::from_value::<Id>(p["requestId"].clone()).ok());
            if let Some(token) = id.and_then(|id| lock(&s.incoming).remove(&id)) {
                token.cancel();
            }
        }
        Message::Notification(n) => {
            // On its own task: a handler may well call back into this Conn (tools/list).
            let incoming = Arc::clone(incoming);
            tokio::spawn(async move { incoming.notification(n.method, n.params).await });
        }
    }
}
