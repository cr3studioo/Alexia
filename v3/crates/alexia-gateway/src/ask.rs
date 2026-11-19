// SPDX-License-Identifier: AGPL-3.0-only
//! Approvals: asks the owner yes/no in the chat a run came from. Filled by P1-12.
#![allow(dead_code)] // stub: P1-12 reads both fields

use std::sync::Arc;

use alexia_core::{Origin, Question};
use alexia_store::Store;
use tokio_util::sync::CancellationToken;

use crate::Channel;

pub(crate) type Channels = Arc<std::sync::RwLock<Vec<Arc<dyn Channel>>>>;

pub(crate) struct Asker {
    channels: Channels,
    store: Arc<Store>,
}

impl Asker {
    pub(crate) fn new(channels: Channels, store: Arc<Store>) -> Asker {
        Asker { channels, store }
    }
}

#[async_trait::async_trait]
impl alexia_core::Ask for Asker {
    /// Stub: always no.
    async fn confirm(
        &self,
        _origin: &Origin,
        _question: &Question,
        _cancel: CancellationToken,
    ) -> bool {
        false
    }
}
