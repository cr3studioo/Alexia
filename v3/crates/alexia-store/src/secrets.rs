// SPDX-License-Identifier: AGPL-3.0-only
//! SP-18: plugin and core secrets in the OS keychain (Credential Manager, macOS Keychain).
//!
//! Service `alexia`, account `<owner>.<key>`: v2's names (`docs/spec/storage.md`, secrets row),
//! so an entry v2's core wrote through `cross-keychain` is the same entry here. A secret is never
//! logged and never put in an `Error`.

use crate::{is_ident, is_plugin_id, Error, Result};

/// When set (any value), secrets live in a process-local map instead of the OS keychain.
/// Tests and CI only; the hub never sets it.
pub const MEMORY_BACKEND_ENV: &str = "ALEXIA_SECRETS_IN_MEMORY";

const SERVICE: &str = "alexia";

/// Service "alexia", account "<owner>.<key>", where owner is a plugin id or "_core".
/// Never logged, never cached by callers. `env_name(owner, key)`, when set and non-empty, wins
/// over the keychain (INTERFACES.md §0.3: environment variables for CI).
pub fn get(owner: &str, key: &str) -> Result<Option<String>> {
    account(owner, key)?;
    if let Some(secret) = std::env::var(env_name(owner, key))
        .ok()
        .filter(|s| !s.is_empty())
    {
        return Ok(Some(secret));
    }
    stored(owner, key)
}

/// The backend only (keychain or memory map), never the environment override.
fn stored(owner: &str, key: &str) -> Result<Option<String>> {
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
    // Every key is tried; the keychain cannot be atomic. The first error is returned.
    let mut first = Ok(());
    for key in keys {
        let r = delete(owner, key);
        if first.is_ok() {
            first = r;
        }
    }
    first
}

/// `ALEXIA_SECRET_<OWNER>_<KEY>`: uppercased, every character outside A-Z and 0-9 becomes `_`,
/// so `_core`/`telegram_bot_token` → `ALEXIA_SECRET__CORE_TELEGRAM_BOT_TOKEN`.
pub fn env_name(owner: &str, key: &str) -> String {
    let clean = |s: &str| -> String {
        s.chars()
            .map(|c| c.to_ascii_uppercase())
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect()
    };
    format!("ALEXIA_SECRET_{}_{}", clean(owner), clean(key))
}

/// True while the in-memory backend is on (tests only).
pub fn in_memory() -> bool {
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

/// `_core` or a plugin id.
fn is_owner(s: &str) -> bool {
    s == "_core" || is_plugin_id(s)
}

/// v2's vault, decoded. Its Debug prints names only, never a value.
// ponytail: values are plain Strings, not zeroized; zeroize is not a dependency and this runs once.
pub struct V2Vault {
    /// v2 account -> value; `None` when the value is not a non-empty string.
    secrets: std::collections::BTreeMap<String, Option<String>>,
}

impl std::fmt::Debug for V2Vault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("V2Vault")
            .field("names", &self.names())
            .finish()
    }
}

const V2_SHAPE: &str = "The v2 secrets entry is not in the shape v2 writes.";

impl V2Vault {
    /// The blob as Credential Manager holds it: UTF-16LE JSON
    /// `{"secrets": {"<owner>.<key>": "<value>", ..}, "looked": [..], "moved"?: "all"}`.
    /// A trailing NUL is allowed. Every error is one fixed sentence: serde_json's and UTF-16's
    /// messages can quote the value.
    pub fn parse(blob: &[u8]) -> Result<V2Vault> {
        let bad = || Error::Refused(V2_SHAPE.into());
        if !blob.len().is_multiple_of(2) {
            return Err(bad());
        }
        let mut units: Vec<u16> = blob
            .chunks_exact(2)
            .map(|p| u16::from_le_bytes([p[0], p[1]]))
            .collect();
        if units.last() == Some(&0) {
            units.pop();
        }
        let text = String::from_utf16(&units).map_err(|_| bad())?;
        let json: serde_json::Value = serde_json::from_str(&text).map_err(|_| bad())?;
        let map = json
            .get("secrets")
            .and_then(|s| s.as_object())
            .ok_or_else(bad)?;
        let secrets = map
            .iter()
            .map(|(k, v)| {
                let v = v.as_str().filter(|s| !s.is_empty()).map(str::to_owned);
                (k.clone(), v)
            })
            .collect();
        Ok(V2Vault { secrets })
    }

    pub fn names(&self) -> Vec<&str> {
        self.secrets.keys().map(String::as_str).collect()
    }
}

/// (owner, key) for a v2 account: `renames` first (v2 account -> v3 `_core` key), else split at
/// the first dot. None when v3 cannot hold it.
pub fn v3_name(v2_account: &str, renames: &[(&str, &str)]) -> Option<(String, String)> {
    let (owner, key) = match renames.iter().find(|(from, _)| *from == v2_account) {
        Some((_, to)) => ("_core", *to),
        None => v2_account.split_once('.')?,
    };
    account(owner, key).ok()?;
    Some((owner.to_owned(), key.to_owned()))
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct V2Report {
    /// "<owner>.<key>" written.
    pub copied: Vec<String>,
    /// v3 already had one; untouched (no `overwrite`).
    pub kept: Vec<String>,
    /// An expected v3 name v2 had nothing for.
    pub not_in_v2: Vec<String>,
    /// v2 names v3 can't hold, or whose value isn't non-empty text.
    pub unusable: Vec<String>,
    /// The read or the write failed (name only); v3's value, if any, is untouched by a failed read.
    pub failed: Vec<String>,
}

/// Writes through `set`; never reads or writes v2. `expected` are the v3 names the hub uses.
pub fn import_v2(
    vault: &V2Vault,
    renames: &[(&str, &str)],
    expected: &[(String, String)],
    overwrite: bool,
) -> V2Report {
    import_with(vault, renames, expected, overwrite, stored, set)
}

fn import_with(
    vault: &V2Vault,
    renames: &[(&str, &str)],
    expected: &[(String, String)],
    overwrite: bool,
    read: impl Fn(&str, &str) -> Result<Option<String>>,
    write: impl Fn(&str, &str, &str) -> Result<()>,
) -> V2Report {
    let mut r = V2Report::default();
    let mut supplied = std::collections::HashSet::new();
    for (v2, value) in &vault.secrets {
        let (Some((owner, key)), Some(value)) = (v3_name(v2, renames), value) else {
            r.unusable.push(v2.clone());
            continue;
        };
        let name = format!("{owner}.{key}");
        supplied.insert((owner.clone(), key.clone()));
        // A read that errors says nothing about what v3 holds, so it is never written over.
        match read(&owner, &key) {
            Err(_) => r.failed.push(name),
            Ok(Some(_)) if !overwrite => r.kept.push(name),
            Ok(_) if write(&owner, &key, value).is_ok() => r.copied.push(name),
            Ok(_) => r.failed.push(name),
        }
    }
    r.not_in_v2 = expected
        .iter()
        .filter(|n| !supplied.contains(*n))
        .map(|(o, k)| format!("{o}.{k}"))
        .collect();
    for list in [
        &mut r.copied,
        &mut r.kept,
        &mut r.not_in_v2,
        &mut r.unusable,
        &mut r.failed,
    ] {
        list.sort();
        list.dedup();
    }
    r
}

/// The one Credential Manager read of v2's entry: `Ok(None)` when it is absent.
#[cfg(windows)]
pub fn read_v2_vault() -> Result<Option<Vec<u8>>> {
    match keyring::Entry::new("dev.alexia.app", "_core.vault").and_then(|e| e.get_secret()) {
        Ok(blob) => Ok(Some(blob)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(Error::Keychain(
            "The v2 keychain entry could not be read.".into(),
        )),
    }
}

#[cfg(not(windows))]
pub fn read_v2_vault() -> Result<Option<Vec<u8>>> {
    Err(Error::Refused(
        "Importing v2 secrets works only on Windows.".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A v2 vault with one `plug.token` entry.
    fn vault() -> V2Vault {
        let json = r#"{"secrets":{"plug.token":"v2-value"}}"#;
        let blob: Vec<u8> = json.encode_utf16().flat_map(u16::to_le_bytes).collect();
        V2Vault::parse(&blob).unwrap()
    }

    #[test]
    fn import_read_error_is_failed_not_overwritten() {
        for overwrite in [false, true] {
            let writes = RefCell::new(Vec::new());
            let r = import_with(
                &vault(),
                &[],
                &[],
                overwrite,
                |_, _| {
                    Err(Error::Keychain(
                        "The system keychain could not be read.".into(),
                    ))
                },
                |o, k, v| {
                    writes.borrow_mut().push(format!("{o}.{k}={v}"));
                    Ok(())
                },
            );
            assert_eq!(r.failed, ["plug.token"], "overwrite={overwrite}");
            assert!(r.copied.is_empty() && r.kept.is_empty());
            assert!(writes.borrow().is_empty(), "overwrite={overwrite}");
        }
    }
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
