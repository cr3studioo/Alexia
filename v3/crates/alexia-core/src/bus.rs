// SPDX-License-Identifier: AGPL-3.0-only
//! The event bus (INTERFACES.md §4). It says **what happened**; it is never the only record of
//! anything. A subscriber that lags and loses events recovers by reading the store.

use std::sync::Arc;

use alexia_store::{Ms, SessionId};
use tokio::sync::broadcast;

use crate::{JobId, Lane, Origin, RunId, Span, Urgency};

#[derive(Clone)]
pub struct Bus {
    tx: broadcast::Sender<Arc<Event>>,
}

impl Bus {
    /// The hub uses 1024.
    pub fn new(capacity: usize) -> Bus {
        Bus {
            tx: broadcast::channel(capacity).0,
        }
    }

    /// Never blocks, never fails; with no subscribers the event is dropped.
    pub fn publish(&self, event: Event) {
        let _ = self.tx.send(Arc::new(event));
    }

    /// A lagging receiver gets `RecvError::Lagged(n)` and continues; handle it, never unwrap.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Event>> {
        self.tx.subscribe()
    }
}

#[derive(Debug)]
pub enum Event {
    // ---- gateway ----
    /// A turn was accepted (after merging) and handed to the brain.
    Received {
        at: Ms,
        origin: Origin,
        session: SessionId,
    },
    /// The instant reaction landed. `ms` is receipt → reaction.
    Acked {
        at: Ms,
        origin: Origin,
        ms: u32,
    },
    /// A reply was delivered. `spans` feed the latency dashboard.
    Delivered {
        at: Ms,
        origin: Origin,
        session: SessionId,
        lane: Lane,
        spans: Vec<Span>,
    },
    /// Something to tell the owner unprompted. The gateway delivers it to the primary chat.
    Say {
        at: Ms,
        text: String,
        urgency: Urgency,
        job: Option<JobId>,
    },

    // ---- core ----
    RunStarted {
        at: Ms,
        run: RunId,
        session: SessionId,
        origin: Origin,
    },
    RunStep {
        at: Ms,
        run: RunId,
        step: u32,
        summary: String,
    },
    RunEnded {
        at: Ms,
        run: RunId,
        outcome: RunOutcome,
    },
    ConversationEnded {
        at: Ms,
        session: SessionId,
    },
    SettingsChanged {
        at: Ms,
        /// A plugin id or "_core".
        owner: String,
        keys: Vec<String>,
    },
    Plugin(alexia_mcp::PluginEvent),

    // ---- scheduler ----
    Fired {
        at: Ms,
        job: JobId,
    },

    // ---- limbs (V3-4) ----
    PeerOnline {
        at: Ms,
        peer: String,
    },
    PeerOffline {
        at: Ms,
        peer: String,
    },

    // ---- hub ----
    ShuttingDown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunOutcome {
    Done,
    Stopped,
    Limit,
    Failed,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast::error::RecvError;

    fn fired(n: i64) -> Event {
        Event::Fired {
            at: n,
            job: JobId(n),
        }
    }

    fn job(e: &Event) -> i64 {
        match e {
            Event::Fired { job, .. } => job.0,
            other => panic!("unexpected event {other:?}"),
        }
    }

    #[test]
    fn publish_without_subscribers_is_fine() {
        let bus = Bus::new(4);
        for n in 0..10 {
            bus.publish(fired(n));
        }
        // A subscriber that arrives later sees only what comes after it.
        let mut rx = bus.subscribe();
        bus.publish(fired(42));
        assert_eq!(job(&rx.try_recv().unwrap()), 42);
    }

    #[tokio::test]
    async fn subscriber_receives_in_order() {
        let bus = Bus::new(16);
        let mut a = bus.subscribe();
        let mut b = bus.subscribe();
        for n in 1..=5 {
            bus.publish(fired(n));
        }
        bus.publish(Event::ShuttingDown);
        for rx in [&mut a, &mut b] {
            for n in 1..=5 {
                assert_eq!(job(&rx.recv().await.unwrap()), n);
            }
            assert!(matches!(*rx.recv().await.unwrap(), Event::ShuttingDown));
        }
    }

    #[tokio::test]
    async fn lagging_subscriber_gets_lagged_then_continues() {
        let bus = Bus::new(2);
        let mut rx = bus.subscribe();
        for n in 1..=5 {
            bus.publish(fired(n));
        }
        assert!(matches!(rx.recv().await, Err(RecvError::Lagged(3))));
        assert_eq!(job(&rx.recv().await.unwrap()), 4);
        assert_eq!(job(&rx.recv().await.unwrap()), 5);
        // And it keeps working after the lag.
        bus.publish(fired(6));
        assert_eq!(job(&rx.recv().await.unwrap()), 6);
    }
}
