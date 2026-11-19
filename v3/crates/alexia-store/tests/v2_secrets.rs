// SPDX-License-Identifier: AGPL-3.0-only
//! `secret import-v2`: v2's Credential Manager vault into v3's store. No test reaches the real
//! Credential Manager: every vault is built from bytes here. Fake values are joined at runtime.

use alexia_store::secrets::{self, import_v2, v3_name, V2Report, V2Vault};

fn memory() {
    std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
}

/// The blob as v2's shell stores it: UTF-16LE, optionally with a trailing NUL.
fn utf16le(json: &str, nul: bool) -> Vec<u8> {
    let mut units: Vec<u16> = json.encode_utf16().collect();
    if nul {
        units.push(0);
    }
    units.iter().flat_map(|u| u.to_le_bytes()).collect()
}

fn fake(tail: &str) -> String {
    format!("{}{}", "fake-", tail)
}

fn vault(secrets: serde_json::Value) -> (Vec<u8>, V2Vault) {
    let json = serde_json::json!({ "secrets": secrets, "looked": [], "moved": "all" });
    let blob = utf16le(&json.to_string(), false);
    let v = V2Vault::parse(&blob).expect("parse");
    (blob, v)
}

fn lines(r: &V2Report) -> Vec<String> {
    let tag = |t: &str, l: &[String]| l.iter().map(|n| format!("{t}\t{n}")).collect::<Vec<_>>();
    [
        tag("copied", &r.copied),
        tag("kept", &r.kept),
        tag("not in v2", &r.not_in_v2),
        tag("unusable", &r.unusable),
        tag("failed", &r.failed),
    ]
    .concat()
}

#[test]
fn parse_utf16le_with_and_without_trailing_nul() {
    let json = format!(
        r#"{{"secrets": {{"_core.provider_alpha": "{}", "eta.token": "{}"}}, "looked": []}}"#,
        fake("a1"),
        fake("e1")
    );
    let a = V2Vault::parse(&utf16le(&json, false)).unwrap();
    let b = V2Vault::parse(&utf16le(&json, true)).unwrap();
    assert_eq!(a.names(), vec!["_core.provider_alpha", "eta.token"]);
    assert_eq!(a.names(), b.names());
}

#[test]
fn parse_rejects_odd_length_bad_json_and_missing_secrets() {
    let value = fake("p4rse-91");
    let mut odd = utf16le(r#"{"secrets": {}}"#, false);
    odd.push(b'x');
    let bad_json = utf16le(&format!(r#"{{"secrets": {{"theta.k": "{value}" "#), false);
    let trailing_junk = utf16le(
        &format!(r#"{{"secrets": {{"theta.k": ["{value}"]}}, "x": }}"#),
        false,
    );
    let secrets_is_text = utf16le(&format!(r#"{{"secrets": "{value}"}}"#), false);
    for blob in [
        odd,
        bad_json,
        trailing_junk,
        utf16le("{}", false),
        utf16le(r#"{"secrets": "x"}"#, false),
        secrets_is_text,
    ] {
        let err = V2Vault::parse(&blob).expect_err("a bad blob was accepted");
        let text = err.to_string();
        assert!(!text.contains(&value), "a value leaked into the error");
        assert!(
            !text.contains("p4rse"),
            "part of a value leaked into the error"
        );
        assert!(!text.contains("theta"), "a name leaked into the error");
    }
}

#[test]
fn maps_v2_names_to_v3() {
    let renames = [("iota.bot_token", "iota_bot_token")];
    let pair = |o: &str, k: &str| Some((o.to_owned(), k.to_owned()));
    assert_eq!(
        v3_name("_core.provider_groq", &renames),
        pair("_core", "provider_groq")
    );
    assert_eq!(
        v3_name("iota.bot_token", &renames),
        pair("_core", "iota_bot_token")
    );
    assert_eq!(v3_name("zeta.api_key", &renames), pair("zeta", "api_key"));
    assert_eq!(v3_name("zeta.api_key", &[]), pair("zeta", "api_key"));
    for bad in ["nodot", "Bad.Key", "zeta.", ".key", "zeta.Key"] {
        assert_eq!(v3_name(bad, &renames), None, "{bad} was accepted");
    }
}

#[test]
fn copies_skips_and_overwrites() {
    memory();
    let (old, new, other) = (fake("old-1"), fake("new-1"), fake("oth-1"));
    secrets::set("kappa", "api_key", &old).unwrap();
    let (_, v) = vault(serde_json::json!({
        "kappa.api_key": new,
        "kappa.other": other,
        "kappa.empty": "",
        "kappa.number": 7,
        "Nope": fake("x"),
    }));
    let expected = vec![
        ("kappa".to_owned(), "api_key".to_owned()),
        ("kappa".to_owned(), "missing".to_owned()),
    ];

    let r = import_v2(&v, &[], &expected, false);
    assert_eq!(r.copied, vec!["kappa.other"]);
    assert_eq!(r.kept, vec!["kappa.api_key"]);
    assert_eq!(r.not_in_v2, vec!["kappa.missing"]);
    assert_eq!(r.unusable, vec!["Nope", "kappa.empty", "kappa.number"]);
    assert!(r.failed.is_empty());
    assert!(secrets::get("kappa", "api_key").unwrap().as_deref() == Some(old.as_str()));
    assert!(secrets::get("kappa", "other").unwrap().as_deref() == Some(other.as_str()));

    let r = import_v2(&v, &[], &expected, true);
    assert_eq!(r.copied, vec!["kappa.api_key", "kappa.other"]);
    assert!(r.kept.is_empty());
    assert!(secrets::get("kappa", "api_key").unwrap().as_deref() == Some(new.as_str()));
}

#[test]
fn copy_leaves_the_source_alone() {
    memory();
    let (blob, v) = vault(serde_json::json!({ "lambda.key": fake("src-1") }));
    let before_blob = blob.clone();
    let before: Vec<String> = v.names().iter().map(|s| (*s).to_owned()).collect();
    let r = import_v2(&v, &[], &[], false);
    assert_eq!(r.copied, vec!["lambda.key"]);
    assert_eq!(v.names(), before);
    assert_eq!(blob, before_blob);
    assert_eq!(V2Vault::parse(&blob).unwrap().names(), before);
    // A second run finds it and keeps it.
    assert_eq!(import_v2(&v, &[], &[], false).kept, vec!["lambda.key"]);
}

#[test]
fn no_value_in_report_or_debug() {
    memory();
    let values = [fake("dbg-1"), fake("dbg-2")];
    let (_, v) = vault(serde_json::json!({
        "mu.key_a": values[0],
        "mu.Bad": values[1],
    }));
    let r = import_v2(&v, &[], &[("mu".into(), "key_b".into())], false);
    let mut texts = lines(&r);
    texts.push(format!("{r:?}"));
    texts.push(format!("{v:?}"));
    for t in &texts {
        for value in &values {
            assert!(!t.contains(value.as_str()), "a value leaked");
        }
    }
    assert!(format!("{v:?}").contains("mu.key_a"));
}

#[test]
fn env_override_is_not_a_stored_secret() {
    memory();
    std::env::set_var(
        secrets::env_name("_core", "provider_cerebras"),
        fake("env-1"),
    );
    let stored = fake("v2-1");
    let (_, v) = vault(serde_json::json!({ "_core.provider_cerebras": stored }));
    let r = import_v2(&v, &[], &[], false);
    assert_eq!(r.copied, vec!["_core.provider_cerebras"]);
    assert!(r.kept.is_empty());
    std::env::remove_var(secrets::env_name("_core", "provider_cerebras"));
    assert!(
        secrets::get("_core", "provider_cerebras")
            .unwrap()
            .as_deref()
            == Some(stored.as_str())
    );
}
