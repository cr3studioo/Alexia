// SPDX-License-Identifier: AGPL-3.0-only

//! The endpoint's private key: made here, kept in the OS keychain, and used by this process
//! alone.
//!
//! The same reasoning as the shell's vault (D153). The keychain trusts a *program*, and core is
//! a program that runs any script, so a key core could read is a key every plugin could read.
//! This process runs no scripts and offers **no operation that returns the key** — not on the
//! control API, not in a log line, not in an error. What it offers is the public half.

use iroh::SecretKey;
use zeroize::Zeroizing;

use crate::constants::{ENV_KEYCHAIN, KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE};

/// The keychain service. A dev build (`pnpm app:dev`) is compiled with `ALEXIA_KEYCHAIN` set, as
/// the shell is, so trying a change never touches the real Alexia's identity; `.connect` keeps
/// it out of the vault's reach there too. The environment variable names the service whole.
pub fn service() -> String {
    match (std::env::var(ENV_KEYCHAIN), option_env!("ALEXIA_KEYCHAIN")) {
        (Ok(service), _) if !service.is_empty() => service,
        (_, Some(dev)) => format!("{dev}.connect"),
        _ => KEYCHAIN_SERVICE.to_owned(),
    }
}

/// The key under `service`, made and stored if there is none.
///
/// One that is there but unreadable is an **error**, never a reason to make another: a new key
/// is a new identity, and every computer paired with the old one would silently stop trusting
/// this one.
pub fn load_or_create(service: &str) -> Result<SecretKey, String> {
    let entry = keyring::Entry::new(service, KEYCHAIN_ACCOUNT).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(stored) => {
            let stored = Zeroizing::new(stored);
            let bytes = unhex(&stored).ok_or("the stored endpoint key is not a key")?;
            Ok(SecretKey::from_bytes(&bytes))
        }
        Err(keyring::Error::NoEntry) => {
            let key = SecretKey::generate();
            let stored = Zeroizing::new(hex(&*Zeroizing::new(key.to_bytes())));
            entry.set_password(&stored).map_err(|error| error.to_string())?;
            Ok(key)
        }
        Err(error) => Err(error.to_string()),
    }
}

fn hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Option<Zeroizing<[u8; 32]>> {
    let mut bytes = Zeroizing::new([0u8; 32]);
    if text.len() != 64 || !text.is_ascii() {
        return None;
    }
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_survives_the_keychain_encoding() {
        let key = SecretKey::generate();
        let back = unhex(&hex(&key.to_bytes())).expect("hex");
        assert_eq!(SecretKey::from_bytes(&back).public(), key.public());
    }

    #[test]
    fn what_is_not_a_key_is_refused() {
        assert!(unhex("").is_none());
        assert!(unhex(&"g".repeat(64)).is_none());
        assert!(unhex(&"a".repeat(63)).is_none());
        assert!(unhex(&"é".repeat(32)).is_none());
    }
}
