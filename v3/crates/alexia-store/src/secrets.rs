// SPDX-License-Identifier: AGPL-3.0-only
//! SP-18: plugin and core secrets in the OS keychain (Credential Manager, macOS Keychain).
//!
//! Service `alexia`, account `<owner>.<key>`: v2's names (`docs/spec/storage.md`, secrets row),
//! so an entry v2's core wrote through `cross-keychain` is the same entry here. A secret is never
//! logged and never put in an `Error`.

use crate::{is_ident, Error, Result};

/// When set (any value), secrets live in a process-local map instead of the OS keychain.
/// Tests and CI only; the hub never sets it.
pub const MEMORY_BACKEND_ENV: &str = "ALEXIA_SECRETS_IN_MEMORY";

const SERVICE: &str = "alexia";

/// Service "alexia", account "<owner>.<key>", where owner is a plugin id or "_core".
/// Never logged, never cached by callers.
pub fn get(owner: &str, key: &str) -> Result<Option<String>> {
    let account = account(owner, key)?;
    if in_memory() {
        Ok(mem::get(&account))
    } else {
        os::get(&account)
    }
}

pub fn set(owner: &str, key: &str, secret: &str) -> Result<()> {
    let account = account(owner, key)?;
    if in_memory() {
        mem::set(account, secret);
        Ok(())
    } else {
        os::set(&account, secret)
    }
}

/// A missing entry is Ok: purge deletes every declared `password`, most never filled in.
pub fn delete(owner: &str, key: &str) -> Result<()> {
    let account = account(owner, key)?;
    if in_memory() {
        mem::delete(&account);
        Ok(())
    } else {
        os::delete(&account)
    }
}

pub fn delete_all(owner: &str, keys: &[String]) -> Result<()> {
    keys.iter().try_for_each(|key| delete(owner, key))
}

fn in_memory() -> bool {
    std::env::var_os(MEMORY_BACKEND_ENV).is_some()
}

/// The messages never echo `owner` or `key`: a caller that mixed up its arguments could have
/// put the secret in either.
fn account(owner: &str, key: &str) -> Result<String> {
    if !is_owner(owner) {
        return Err(Error::Invalid(
            "A secret's owner must be a plugin id or _core.".into(),
        ));
    }
    if !is_ident(key) {
        return Err(Error::Invalid(
            "A secret's key must be lowercase letters, digits and underscores.".into(),
        ));
    }
    Ok(format!("{owner}.{key}"))
}

/// `^(_core|[a-z][a-z0-9-]*)$`
fn is_owner(s: &str) -> bool {
    let mut b = s.bytes();
    s == "_core"
        || (b.next().is_some_and(|c| c.is_ascii_lowercase())
            && b.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'))
}

mod mem {
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex, MutexGuard};

    static MAP: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

    fn map() -> MutexGuard<'static, HashMap<String, String>> {
        MAP.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn get(account: &str) -> Option<String> {
        map().get(account).cloned()
    }

    pub fn set(account: String, secret: &str) {
        map().insert(account, secret.to_owned());
    }

    pub fn delete(account: &str) {
        map().remove(account);
    }
}

mod os {
    use super::SERVICE;
    use crate::{Error, Result};
    use keyring::Entry;

    pub fn get(account: &str) -> Result<Option<String>> {
        match Entry::new(SERVICE, account).and_then(|e| e.get_password()) {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(fail("read", e, None)),
        }
    }

    pub fn set(account: &str, secret: &str) -> Result<()> {
        Entry::new(SERVICE, account)
            .and_then(|e| e.set_password(secret))
            .map_err(|e| fail("written", e, Some(secret)))
    }

    pub fn delete(account: &str) -> Result<()> {
        match Entry::new(SERVICE, account).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(fail("cleared", e, None)),
        }
    }

    /// The underlying text reaches `debug!` only when it cannot carry the secret. A read or a
    /// clear has no secret in hand, and keyring's errors for those name only the failure.
    fn fail(verb: &str, e: keyring::Error, secret: Option<&str>) -> Error {
        let text = e.to_string();
        if secret.is_none_or(|s| !s.is_empty() && !text.contains(s)) {
            tracing::debug!(error = %text, "keychain could not be {verb}");
        }
        Error::Keychain(format!("The system keychain could not be {verb}."))
    }

    #[cfg(all(test, windows))]
    mod tests {
        /// The real Credential Manager, whatever `MEMORY_BACKEND_ENV` says: it calls the
        /// keychain backend directly.
        #[test]
        fn windows_credential_manager_round_trip() {
            let account = "_v3test.probe";
            super::delete(account).unwrap();
            assert_eq!(super::get(account).unwrap(), None);
            super::set(account, "not-a-secret").unwrap();
            assert_eq!(
                super::get(account).unwrap().as_deref(),
                Some("not-a-secret")
            );
            super::delete(account).unwrap();
            assert_eq!(super::get(account).unwrap(), None);
            super::delete(account).unwrap();
        }
    }
}
