// SPDX-License-Identifier: AGPL-3.0-only
//! One SQLite file: sessions, messages, settings, kv, ledger, plugin namespaces; secrets; the v2 importer.

mod db;
mod devices;
pub mod encrypt;
mod error;
pub mod import;
mod layout;
mod migrations;
mod namespace;
pub mod secrets;
mod types;

/// `^[a-z][a-z0-9-]*$`, the one plugin id rule.
pub fn is_plugin_id(s: &str) -> bool {
    let mut b = s.bytes();
    b.next().is_some_and(|c| c.is_ascii_lowercase())
        && b.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

pub use db::Store;
pub use error::*;
pub use layout::*;
pub use types::*;

#[cfg(test)]
mod tests {
    use super::is_plugin_id;

    #[test]
    fn plugin_id_rule() {
        for ok in ["a", "ab-1"] {
            assert!(is_plugin_id(ok), "{ok}");
        }
        for bad in ["", "1a", "A", "a_b", "a.b", "-a"] {
            assert!(!is_plugin_id(bad), "{bad}");
        }
    }
}
