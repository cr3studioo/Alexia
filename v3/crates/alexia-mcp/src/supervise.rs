// SPDX-License-Identifier: AGPL-3.0-only
//! Supervision (INTERFACES.md §7, invariants 3 and 4): the crash tally with its backoff, the
//! per-plugin watcher that pings, idles lazy plugins out and notices a deleted folder.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, Weak};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use crate::conn::Conn;
use crate::host::WeakHost;
use crate::{CallError, PluginId, StopReason, Timings};

pub(crate) enum Verdict {
    Retry { after_ms: u64 },
    Unhealthy,
}

/// Crashes (and failed starts) inside the window, and when the next spawn may happen.
pub(crate) struct CrashLog {
    at: VecDeque<Instant>,
    next: Option<Instant>,
    window: Duration,
    limit: usize,
    backoff_ms: u64,
    max_backoff_ms: u64,
}

impl CrashLog {
    pub(crate) fn new(t: &Timings) -> CrashLog {
        CrashLog {
            at: VecDeque::new(),
            next: None,
            window: Duration::from_millis(t.crash_window_ms),
            limit: t.crash_limit as usize,
            backoff_ms: t.backoff_ms,
            max_backoff_ms: t.max_backoff_ms,
        }
    }

    pub(crate) fn record(&mut self, now: Instant) -> Verdict {
        while self
            .at
            .front()
            .is_some_and(|a| now.duration_since(*a) >= self.window)
        {
            self.at.pop_front();
        }
        self.at.push_back(now);
        let n = self.at.len();
        if n >= self.limit {
            return Verdict::Unhealthy;
        }
        let doubling = 1u64 << (n - 1).min(32);
        let after_ms = self
            .backoff_ms
            .saturating_mul(doubling)
            .min(self.max_backoff_ms);
        self.next = Some(now + Duration::from_millis(after_ms));
        Verdict::Retry { after_ms }
    }

    /// How long a spawn must still wait.
    pub(crate) fn wait(&self, now: Instant) -> Duration {
        self.next
            .map(|n| n.saturating_duration_since(now))
            .unwrap_or_default()
    }

    pub(crate) fn clear(&mut self) {
        self.at.clear();
        self.next = None;
    }
}

/// The folder was deleted (or at least its manifest was).
pub(crate) fn vanished(dir: &Path) -> bool {
    !dir.join("plugin.json").exists()
}

/// Calls in flight and when the last one ended, for the idle check. `Conn::quiet_ms` cannot
/// serve: the heartbeat's own ping answers keep it near zero.
pub(crate) struct Busy {
    calls: AtomicUsize,
    last: Mutex<Instant>,
}

impl Busy {
    pub(crate) fn new() -> Busy {
        Busy {
            calls: AtomicUsize::new(0),
            last: Mutex::new(Instant::now()),
        }
    }

    pub(crate) fn enter(&self) -> BusyGuard<'_> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        BusyGuard(self)
    }

    fn idle_for(&self) -> Option<Duration> {
        if self.calls.load(Ordering::SeqCst) > 0 {
            return None;
        }
        Some(self.last.lock().unwrap_or_else(|e| e.into_inner()).elapsed())
    }
}

pub(crate) struct BusyGuard<'a>(&'a Busy);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        *self.0.last.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        self.0.calls.fetch_sub(1, Ordering::SeqCst);
    }
}

/// What one plugin's watcher needs. Weak references only: a stop must be able to drop the
/// last `Conn` (closing stdin) and the host must be droppable.
pub(crate) struct Watch {
    pub host: WeakHost,
    pub id: PluginId,
    pub gen: u64,
    pub conn: Weak<Conn>,
    pub closed: CancellationToken,
    pub busy: Weak<Busy>,
    pub dir: PathBuf,
    pub lazy: bool,
    pub heartbeat: Duration,
    pub idle: Duration,
    /// Cancelled by `stop`/`shutdown`/idle/vanish: the end of this process, not a crash.
    pub stop: CancellationToken,
}

/// One per running process, ended with it.
pub(crate) async fn watch(w: Watch) {
    let never = CancellationToken::new();
    loop {
        tokio::select! {
            biased;
            () = w.stop.cancelled() => return,
            () = w.closed.cancelled() => {
                if let Some(host) = w.host.upgrade() {
                    host.crashed(&w.id, w.gen, false).await;
                }
                return;
            }
            () = tokio::time::sleep(w.heartbeat) => {}
        }
        let Some(host) = w.host.upgrade() else { return };
        if vanished(&w.dir) {
            host.vanish(&w.id).await;
            return;
        }
        let idle = w.busy.upgrade().and_then(|b| b.idle_for());
        if w.lazy && idle.is_some_and(|d| d >= w.idle) {
            // ponytail: a call landing between this check and the stop is killed after the
            // grace period (Gone); a per-call lock would close the window if it ever matters.
            host.stop_with(&w.id, StopReason::Idle).await;
            return;
        }
        let Some(conn) = w.conn.upgrade() else { return };
        let ping = tokio::select! {
            biased;
            () = w.stop.cancelled() => return,
            r = conn.request("ping", None, None, &never, w.heartbeat) => r,
        };
        drop(conn);
        if let Err(CallError::Timeout) = ping {
            host.crashed(&w.id, w.gen, true).await;
            return;
        }
        // Gone: `closed` fires on the next turn. An Rpc error is still an answer.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log() -> CrashLog {
        CrashLog::new(&Timings {
            backoff_ms: 100,
            max_backoff_ms: 250,
            crash_window_ms: 1_000,
            crash_limit: 4,
            ..Timings::default()
        })
    }

    #[test]
    fn backoff_doubles_caps_and_trips() {
        let t = Instant::now();
        let mut l = log();
        assert!(matches!(l.record(t), Verdict::Retry { after_ms: 100 }));
        assert_eq!(l.wait(t), Duration::from_millis(100));
        assert!(matches!(l.record(t), Verdict::Retry { after_ms: 200 }));
        assert!(matches!(l.record(t), Verdict::Retry { after_ms: 250 }));
        assert!(matches!(l.record(t), Verdict::Unhealthy));
    }

    #[test]
    fn old_crashes_leave_the_window() {
        let t = Instant::now();
        let mut l = log();
        l.record(t);
        l.record(t);
        l.record(t);
        let later = t + Duration::from_millis(1_000);
        assert!(matches!(l.record(later), Verdict::Retry { after_ms: 100 }));
        assert_eq!(l.wait(later + Duration::from_millis(500)), Duration::ZERO);
        l.clear();
        assert_eq!(l.wait(later), Duration::ZERO);
    }
}
