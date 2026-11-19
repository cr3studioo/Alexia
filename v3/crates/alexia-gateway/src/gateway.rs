// SPDX-License-Identifier: AGPL-3.0-only
//! The gateway loop: ack, merge, steer, drafts, spans. Filled by P1-11.
#![allow(dead_code)] // stub: P1-11 reads every field

use std::sync::{Arc, RwLock};

use alexia_core::{Brain, Bus};
use alexia_store::Store;
use tokio_util::sync::CancellationToken;

use crate::ask::{Asker, Channels};
use crate::{Channel, GatewayConfig, Media, Result};

pub struct Gateway {
    cfg: GatewayConfig,
    store: Arc<Store>,
    bus: Bus,
    brain: Arc<dyn Brain>,
    media: Arc<dyn Media>,
    channels: Channels,
}

impl Gateway {
    pub fn new(
        cfg: GatewayConfig,
        store: Arc<Store>,
        bus: Bus,
        brain: Arc<dyn Brain>,
        media: Arc<dyn Media>,
    ) -> Gateway {
        Gateway {
            cfg,
            store,
            bus,
            brain,
            media,
            channels: Arc::new(RwLock::new(Vec::new())),
        }
    }

    pub fn add(&mut self, channel: Arc<dyn Channel>) {
        self.channels
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .push(channel);
    }

    /// Stub: waits for `cancel`, then returns.
    pub async fn run(self, cancel: CancellationToken) -> Result<()> {
        cancel.cancelled().await;
        Ok(())
    }

    pub fn asker(&self) -> Arc<dyn alexia_core::Ask> {
        Arc::new(Asker::new(self.channels.clone(), self.store.clone()))
    }
}
