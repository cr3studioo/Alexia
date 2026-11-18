// SPDX-License-Identifier: AGPL-3.0-only
use alexia_store::{secrets, Error};

/// Every test calls this first. Never unset: the tests share one process.
fn memory() {
    std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
}

#[test]
fn set_get_delete_round_trip() {
    memory();
    secrets::set("hello", "api_key", "not-a-secret").unwrap();
    assert_eq!(
        secrets::get("hello", "api_key").unwrap().as_deref(),
        Some("not-a-secret")
    );
    secrets::delete("hello", "api_key").unwrap();
    assert_eq!(secrets::get("hello", "api_key").unwrap(), None);
    secrets::delete("hello", "api_key").unwrap();
}

#[test]
fn owners_are_separate() {
    memory();
    secrets::set("a", "key", "not-a-secret").unwrap();
    assert_eq!(secrets::get("b", "key").unwrap(), None);
    secrets::set("b", "key", "not-a-secret-b").unwrap();
    assert_eq!(
        secrets::get("a", "key").unwrap().as_deref(),
        Some("not-a-secret")
    );
    secrets::delete("b", "key").unwrap();
    assert_eq!(
        secrets::get("a", "key").unwrap().as_deref(),
        Some("not-a-secret")
    );
}

#[test]
fn delete_all_removes_listed_keys_only() {
    memory();
    for key in ["one", "two", "three"] {
        secrets::set("purge-me", key, "not-a-secret").unwrap();
    }
    secrets::set("_core", "one", "not-a-secret").unwrap();
    let listed = [
        "one".to_string(),
        "two".to_string(),
        "never_set".to_string(),
    ];
    secrets::delete_all("purge-me", &listed).unwrap();
    assert_eq!(secrets::get("purge-me", "one").unwrap(), None);
    assert_eq!(secrets::get("purge-me", "two").unwrap(), None);
    assert_eq!(
        secrets::get("purge-me", "three").unwrap().as_deref(),
        Some("not-a-secret")
    );
    assert_eq!(
        secrets::get("_core", "one").unwrap().as_deref(),
        Some("not-a-secret")
    );
}

#[test]
fn bad_owner_or_key_is_invalid() {
    memory();
    for (owner, key) in [
        ("A", "key"),
        ("../x", "key"),
        ("ok", "a.b"),
        ("", "key"),
        ("ok", ""),
    ] {
        assert!(
            matches!(secrets::get(owner, key), Err(Error::Invalid(_))),
            "{owner:?} {key:?}"
        );
        assert!(matches!(
            secrets::set(owner, key, "not-a-secret"),
            Err(Error::Invalid(_))
        ));
        assert!(matches!(
            secrets::delete(owner, key),
            Err(Error::Invalid(_))
        ));
    }
    assert!(matches!(
        secrets::delete_all("ok", &["fine".into(), "a.b".into()]),
        Err(Error::Invalid(_))
    ));
}

#[test]
fn errors_never_contain_the_secret() {
    memory();
    let secret = "not-a-secret";
    let as_key = secrets::set("hello", secret, secret).unwrap_err();
    let as_owner = secrets::get(&secret.to_uppercase(), "key").unwrap_err();
    for e in [as_key, as_owner] {
        assert!(matches!(e, Error::Invalid(_)));
        let shown = e.to_string().to_lowercase();
        assert!(!shown.contains(secret), "{shown}");
    }
}
