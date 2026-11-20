// SPDX-License-Identifier: AGPL-3.0-only
//! Every channel adapter. Only files under this folder may name a service.

use std::sync::Arc;

use alexia_store::{secrets, Layout, Store};

use crate::{Channel, Result};

#[doc(hidden)]
pub mod telegram;

const TELEGRAM_TOKEN: &str = "telegram_bot_token";
/// The test hook for a fake Bot API.
const TELEGRAM_API_ENV: &str = "ALEXIA_TELEGRAM_API";
const TELEGRAM_API: &str = "https://api.telegram.org";

/// The `_core` secret keys channels read, for `alexia-hub secret set`.
pub fn secret_keys() -> &'static [&'static str] {
    &[TELEGRAM_TOKEN]
}

/// (v2 account, v3 `_core` key) for every channel secret v2 kept under a plugin's name.
pub fn v2_secret_names() -> &'static [(&'static str, &'static str)] {
    &[("telegram.bot_token", TELEGRAM_TOKEN)] // invariant: v2 import
}

/// The bot token, or `None` when it is missing or unreadable. Never logged.
fn telegram_token() -> Option<String> {
    match secrets::get("_core", TELEGRAM_TOKEN) {
        Ok(token) => token.filter(|t| !t.trim().is_empty()),
        Err(e) => {
            tracing::warn!("telegram: the bot token couldn't be read: {e}");
            None
        }
    }
}

/// Every channel whose secret is present.
pub fn configured(store: Arc<Store>, layout: &Layout) -> Vec<Arc<dyn Channel>> {
    let Some(token) = telegram_token() else {
        return Vec::new();
    };
    let base = std::env::var(TELEGRAM_API_ENV)
        .ok()
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| TELEGRAM_API.to_owned());
    let api = telegram::api::Api::new(&base, token);
    vec![Arc::new(telegram::Telegram::new(
        api,
        store,
        layout.cache(),
    ))]
}

/// For `alexia-hub pair`: (channel name, code) for every configured channel with no owner yet.
pub fn pairing_codes(store: &Store) -> Result<Vec<(&'static str, String)>> {
    if telegram_token().is_none() || !telegram::owners(store)?.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![(stringify!(telegram), telegram::pairing_code(store)?)])
}
