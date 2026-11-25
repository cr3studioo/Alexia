// SPDX-License-Identifier: AGPL-3.0-only
//! The window's HTTP server (INTERFACES §2.8, D-P2D-1, D-P2D-2).
//!
//! `packages/ui` is served from one loopback port with the token injected, every `/api/*`
//! call passes v2's gate (token, Host, JSON body, the guard), and each screen's routes live in
//! their own module so the area tasks never share a file. No route names a plugin: screens
//! that serve one find it by capability or widget type.

use std::hash::{BuildHasher, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::agent::Agent;
use alexia_core::catalog::Catalog;
use alexia_core::local::{LocalJobs, Runtime};
use alexia_core::prompt::Skills;
use alexia_core::tools::McpTooling;
use alexia_core::Bus;
use alexia_gateway::{Asker, ChannelSet};
use alexia_mcp::McpHost;
use alexia_scheduler::Scheduler;
use alexia_store::{Layout, SessionId, Store};
use axum::extract::DefaultBodyLimit;
use base64::Engine;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

mod gate;
mod json;
mod statics;
mod util;

mod board;
mod chat;
mod compute;
mod editor;
mod learned;
mod library;
mod local_models;
mod offers;
mod plugins;
mod private;
mod research;
mod state;

/// The kv entry (`_core` namespace) holding the window's open chat.
const SESSION_KEY: &str = "window_session";

/// Everything the routes read or drive, as the hub built it (§2.6 steps 1–11).
pub struct ApiParts {
    pub layout: Layout,
    pub store: Arc<Store>,
    pub bus: Bus,
    pub host: McpHost,
    pub tooling: Arc<McpTooling>,
    pub agent: Arc<Agent>,
    /// The `Lanes` the hub builds.
    pub brain: Arc<dyn alexia_core::Brain>,
    pub router: Arc<alexia_core::router::Router>,
    pub catalog: Arc<Catalog>,
    pub scheduler: Arc<Scheduler>,
    pub asker: Arc<Asker>,
    pub channels: ChannelSet,
    pub skills: Arc<Skills>,
    pub runtime: Arc<Runtime>,
    pub jobs: Arc<LocalJobs>,
    /// `ALEXIA_UI_DIR`: the folder holding `index.html`, else None.
    pub ui_dir: Option<PathBuf>,
    /// The hub's own version (`env!("CARGO_PKG_VERSION")` of alexia-hub).
    pub app_version: String,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Store(#[from] alexia_store::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// The window's server: its parts, the per-run token, the open chat and the area states.
pub struct Api {
    pub parts: ApiParts,
    /// 32 random bytes, base64url. Never logged, never written to a file.
    token: String,
    /// The open chat; kv `_core`/`window_session`.
    session: Mutex<SessionId>,
    /// A window answer is on its way (v2 `replying`). Shared with `BusyGuard`, which may
    /// outlive the request that took it (the chat stream).
    busy: Arc<AtomicBool>,
    pub(crate) state: state::StateState,
    pub(crate) chat: chat::ChatState,
    pub(crate) offers: offers::Offers,
    pub(crate) board: board::BoardState,
    pub(crate) library: library::LibraryState,
    pub(crate) local: local_models::LocalState,
    pub(crate) compute: compute::ComputeState,
}

/// Clears `busy` when dropped.
pub struct BusyGuard(Arc<AtomicBool>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl std::fmt::Debug for Api {
    /// Never prints the token.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Api")
            .field("session", &self.session())
            .field("busy", &self.busy())
            .finish_non_exhaustive()
    }
}

impl Api {
    /// Reads the window's session from kv, or takes the newest chat (a new one when there is
    /// none) and writes it.
    pub fn new(parts: ApiParts) -> Result<Arc<Api>> {
        let session = window_session(&parts.store)?;
        Ok(Arc::new(Api {
            parts,
            token: mint_token(),
            session: Mutex::new(session),
            busy: Arc::new(AtomicBool::new(false)),
            state: Default::default(),
            chat: Default::default(),
            offers: Default::default(),
            board: Default::default(),
            library: Default::default(),
            local: Default::default(),
            compute: Default::default(),
        }))
    }

    /// The per-run token the page carries in `x-alexia-token`.
    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn session(&self) -> SessionId {
        *self.session.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Makes `id` the open chat and remembers it in kv.
    pub fn set_session(&self, id: SessionId) -> Result<()> {
        self.parts
            .store
            .kv_set(util::CORE, SESSION_KEY, &serde_json::json!(id.0))?;
        *self.session.lock().unwrap_or_else(|e| e.into_inner()) = id;
        Ok(())
    }

    pub fn busy(&self) -> bool {
        self.busy.load(Ordering::Acquire)
    }

    /// Marks a window answer as on its way; None when one already is.
    pub fn try_busy(&self) -> Option<BusyGuard> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| BusyGuard(self.busy.clone()))
    }

    /// Answers the window on `listener` until `cancel`. Open streams get two seconds to
    /// finish after that, then the server stops regardless.
    pub async fn serve(
        self: Arc<Self>,
        listener: tokio::net::TcpListener,
        cancel: CancellationToken,
    ) -> Result<()> {
        let app = app(self);
        let stop = cancel.clone();
        let server = axum::serve(listener, app)
            .with_graceful_shutdown(async move { stop.cancelled().await });
        tokio::select! {
            r = server => r?,
            _ = async {
                cancel.cancelled().await;
                tokio::time::sleep(Duration::from_secs(2)).await;
            } => {}
        }
        Ok(())
    }
}

/// Every area's routes behind the gate; no match is v2's empty 404.
fn app(api: Arc<Api>) -> axum::Router {
    axum::Router::new()
        .merge(state::routes())
        .merge(chat::routes())
        .merge(offers::routes())
        .merge(plugins::routes())
        .merge(board::routes())
        .merge(learned::routes())
        .merge(library::routes())
        .merge(local_models::routes())
        .merge(compute::routes())
        .merge(editor::routes())
        .merge(research::routes())
        .fallback(|| async { json::empty(404) })
        .method_not_allowed_fallback(|| async { json::empty(404) })
        .layer(axum::middleware::from_fn_with_state(
            api.clone(),
            gate::gate,
        ))
        .layer(DefaultBodyLimit::max(gate::BODY_LIMIT))
        .with_state(api)
}

/// kv `_core`/`window_session` when it names a chat that still exists; else the newest chat,
/// or a new one, written back.
fn window_session(store: &Store) -> Result<SessionId> {
    let sessions = store.sessions()?;
    let kept = store
        .kv_get(util::CORE, SESSION_KEY)?
        .and_then(|v| v.as_i64())
        .map(SessionId)
        .filter(|id| sessions.iter().any(|s| s.id == *id));
    if let Some(id) = kept {
        return Ok(id);
    }
    let id = match sessions.first() {
        Some(s) => s.id,
        None => store.create_session(None)?,
    };
    store.kv_set(util::CORE, SESSION_KEY, &serde_json::json!(id.0))?;
    Ok(id)
}

/// 32 bytes, base64url without padding. std has no CSPRNG and none is in this crate's
/// dependencies, so: SHA-256 over eight OS-seeded `RandomState` hashes (SipHash with random
/// keys from the OS), the clock and the process id. It guards a loopback port, as v2's did.
fn mint_token() -> String {
    let mut h = Sha256::new();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    for i in 0..8u64 {
        let mut s = std::collections::hash_map::RandomState::new().build_hasher();
        s.write_u64(i);
        s.write_u128(now);
        s.write_u32(std::process::id());
        h.update(s.finish().to_le_bytes());
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_differ_and_are_43_chars() {
        let (a, b) = (mint_token(), mint_token());
        assert_ne!(a, b);
        assert_eq!(a.len(), 43);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn window_session_kept_newest_or_new() {
        let store = Store::open_in_memory().unwrap();
        let first = window_session(&store).unwrap();
        assert_eq!(store.sessions().unwrap().len(), 1);
        assert_eq!(window_session(&store).unwrap(), first);
        let other = store.create_session(None).unwrap();
        store
            .kv_set(util::CORE, SESSION_KEY, &serde_json::json!(other.0))
            .unwrap();
        assert_eq!(window_session(&store).unwrap(), other);
        // A kv entry naming a chat that is gone falls back to the newest.
        store
            .kv_set(util::CORE, SESSION_KEY, &serde_json::json!(9999))
            .unwrap();
        let newest = store.sessions().unwrap()[0].id;
        assert_eq!(window_session(&store).unwrap(), newest);
    }
}
