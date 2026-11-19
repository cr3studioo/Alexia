// SPDX-License-Identifier: AGPL-3.0-only
//! Every channel adapter. Only files under this folder may name a service. Filled by P1-10.

use std::sync::Arc;

use alexia_store::{Layout, Store};

use crate::Channel;

#[doc(hidden)]
pub mod telegram;

/// The `_core` secret keys channels read, for `alexia-hub secret set`. Stub: empty.
pub fn secret_keys() -> &'static [&'static str] {
    &[]
}

/// Every channel whose secret is present. Stub: empty.
pub fn configured(_store: Arc<Store>, _layout: &Layout) -> Vec<Arc<dyn Channel>> {
    Vec::new()
}
