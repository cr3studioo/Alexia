// SPDX-License-Identifier: AGPL-3.0-only
use std::path::PathBuf;

use alexia_store::*;
use serde_json::{json, Value};

fn round_trip(v: Value) {
    let body: MessageBody = serde_json::from_value(v.clone()).expect("parses");
    assert_eq!(serde_json::to_value(&body).unwrap(), v);
}

#[test]
fn message_body_round_trips_v2_json() {
    round_trip(json!({"content": "hello"}));
    round_trip(json!({"content": [
        {"type": "text", "text": "look"},
        {"type": "image", "url": "data:image/png;base64,AAAA"}
    ]}));
    round_trip(json!({"content": "", "calls": [
        {"id": "c1", "name": "search", "arguments": "{\"q\":\"x\"}"}
    ]}));
    round_trip(json!({
        "content": "done", "callId": "c1", "provider": "openrouter",
        "notes": ["rate-limited, answered by another"], "bad": true,
        "stopped": true, "typed": "hi"
    }));
    let v = json!({"content": "x", "row": "kilo-auto/free", "future": {"x": 1}});
    let body: MessageBody = serde_json::from_value(v.clone()).unwrap();
    assert_eq!(body.extra["future"], json!({"x": 1}));
    assert_eq!(body.extra["row"], json!("kilo-auto/free"));
    assert_eq!(serde_json::to_value(&body).unwrap(), v);

    let body: MessageBody =
        serde_json::from_value(json!({"content": "x", "callId": "c9"})).unwrap();
    assert_eq!(body.call_id.as_deref(), Some("c9"));
    assert!(body.extra.is_empty());
}

#[test]
fn role_serializes_lowercase() {
    assert_eq!(
        serde_json::to_value(Role::Assistant).unwrap(),
        json!("assistant")
    );
    assert_eq!(
        serde_json::from_value::<Role>(json!("assistant")).unwrap(),
        Role::Assistant
    );
    assert!(serde_json::from_value::<Role>(json!("Assistant")).is_err());
}

#[test]
fn operator_validate() {
    let invalid = |op: Operator| matches!(op.validate(), Err(Error::Invalid(_)));
    let one = || Some(Scalar::Num(1.into()));

    assert!(invalid(Operator::default()));
    assert!(invalid(Operator {
        eq: one(),
        gt: one(),
        ..Default::default()
    }));
    assert!(invalid(Operator {
        is_null: Some(false),
        ..Default::default()
    }));
    assert!(invalid(Operator {
        in_: Some(vec![]),
        ..Default::default()
    }));

    let singles = [
        Operator {
            eq: one(),
            ..Default::default()
        },
        Operator {
            ne: one(),
            ..Default::default()
        },
        Operator {
            lt: one(),
            ..Default::default()
        },
        Operator {
            lte: one(),
            ..Default::default()
        },
        Operator {
            gt: one(),
            ..Default::default()
        },
        Operator {
            gte: one(),
            ..Default::default()
        },
        Operator {
            in_: Some(vec![Scalar::Null]),
            ..Default::default()
        },
        Operator {
            like: Some("a%".into()),
            ..Default::default()
        },
        Operator {
            is_null: Some(true),
            ..Default::default()
        },
    ];
    for op in singles {
        op.validate()
            .unwrap_or_else(|e| panic!("{op:?} should be valid: {e}"));
    }
}

#[test]
fn operator_rejects_unknown_keys() {
    assert!(serde_json::from_value::<Operator>(json!({"eq": 1, "bogus": 2})).is_err());
    // The wire names: `in` and camelCase `isNull`.
    let op: Operator = serde_json::from_value(json!({"isNull": true})).unwrap();
    assert_eq!(op.is_null, Some(true));
    let op: Operator = serde_json::from_value(json!({"in": [1, "a"]})).unwrap();
    assert_eq!(
        op.in_,
        Some(vec![Scalar::Num(1.into()), Scalar::Str("a".into())])
    );
}

#[test]
fn cond_parses_bare_scalar_and_operator() {
    let cond = |v: Value| serde_json::from_value::<Cond>(v).unwrap();
    assert_eq!(cond(json!(5)), Cond::Eq(Scalar::Num(5.into())));
    assert_eq!(cond(json!("x")), Cond::Eq(Scalar::Str("x".into())));
    assert_eq!(cond(json!(null)), Cond::Eq(Scalar::Null));
    assert_eq!(cond(json!(true)), Cond::Eq(Scalar::Bool(true)));
    assert_eq!(
        cond(json!({"gt": 3})),
        Cond::Op(Operator {
            gt: Some(Scalar::Num(3.into())),
            ..Default::default()
        })
    );
    assert_eq!(
        serde_json::from_value::<Scalar>(json!(null)).unwrap(),
        Scalar::Null
    );
}

#[test]
fn is_ident_rule() {
    for ok in ["a", "a_1", "abc_def9"] {
        assert!(is_ident(ok), "{ok}");
    }
    for bad in ["A", "1a", "a-b", "a b", "", "_a", "aB", "é"] {
        assert!(!is_ident(bad), "{bad}");
    }
}

#[test]
fn layout_paths() {
    let root = PathBuf::from("root_dir");
    let l = Layout::new(root.clone());
    assert_eq!(l.root, root);
    assert_eq!(l.db(), root.join("alexia.db"));
    assert_eq!(
        l.own_dir("my-plugin"),
        root.join("plugins").join("my-plugin")
    );
    assert_eq!(l.extensions(), root.join("extensions"));
    assert_eq!(l.skills(), root.join("skills"));
    assert_eq!(l.uploads(), root.join("uploads"));
    assert_eq!(l.cache(), root.join("cache"));
}

#[test]
fn data_dir_honours_env() {
    let saved = std::env::var_os("ALEXIA_V3_DATA");

    let abs = std::env::temp_dir().join("alexia-v3-data-test");
    assert!(abs.is_absolute());
    std::env::set_var("ALEXIA_V3_DATA", &abs);
    assert_eq!(data_dir(), abs);

    std::env::set_var("ALEXIA_V3_DATA", "relative/dir");
    let fallback = data_dir();
    assert_ne!(fallback, PathBuf::from("relative/dir"));
    assert!(fallback.ends_with("AlexiaHub"));

    std::env::remove_var("ALEXIA_V3_DATA");
    assert_eq!(data_dir(), fallback);

    match saved {
        Some(v) => std::env::set_var("ALEXIA_V3_DATA", v),
        None => std::env::remove_var("ALEXIA_V3_DATA"),
    }
}
