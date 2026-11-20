// SPDX-License-Identifier: AGPL-3.0-only
//! Redaction (P2-14), ported from v2 `packages/core/test/redact.test.ts`. Fake secrets are
//! built at run time so no scanner flags the repo.

use alexia_core::redact::*;
use alexia_core::ChatRequest;
use alexia_store::{Content, MessageBody, Part, Role, ToolCall};
use serde_json::json;

fn or_key() -> String {
    format!("{}{}", "sk-or-v1-", "9f2a8c7b6d5e4f3a2b1c0d9e")
}

fn body(content: Content) -> MessageBody {
    MessageBody {
        content,
        calls: None,
        call_id: None,
        provider: None,
        notes: None,
        bad: None,
        stopped: None,
        typed: None,
        extra: Default::default(),
    }
}

fn kinds(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn credential_goes_and_sentence_stays() {
    let said = redact_text(&format!(
        "put OPENROUTER_API_KEY={} in .env and restart",
        or_key()
    ));
    assert_eq!(
        said.0,
        "put OPENROUTER_API_KEY=[redacted] in .env and restart"
    );
    assert_eq!(said.1, kinds(&["api key"]));

    let bare = redact_text("DEPLOY_PASSWORD=correcthorsebattery");
    assert_eq!(bare.0, "[redacted]");
    assert_eq!(bare.1, kinds(&["env assignment"]));

    assert_eq!(
        redact_text("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY").0,
        "[redacted]"
    );
    assert_eq!(
        redact_text("set GITHUB_TOKEN_FOR_CI = abcdefghijklmnop").0,
        "set [redacted]"
    );

    let shapes = [
        format!("{}{}", "sk-ant-", "api03-Zm9vYmFyYmF6cXV4Y29ycmdl"),
        format!("{}{}", "ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"),
        format!("{}{}", "AKIA", "IOSFODNN7EXAMPLE"),
        format!("{}{}", "xoxb-", "123456789012-abcdefghijkl"),
        format!(
            "{}{}",
            "eyJhbGciOiJIUzI1NiJ9.", "eyJzdWIiOiIxMjM0NTYifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g"
        ),
        format!("{}{}", "-----BEGIN RSA ", "PRIVATE KEY-----"),
        format!("{}{}", "AIza", "SyA1234567890abcdefghijklmnopqrstuv"),
        format!("{}{}", "123456789:", "AAEhBP0abcdefghijklmnopqrstuvwxyz12"),
        format!("{}{}", "https://user:", "hunter2@example.com/path"),
    ];
    for s in shapes {
        assert_eq!(
            redact_text(&format!("here it is: {s}")).0,
            "here it is: [redacted]",
            "{s}"
        );
        assert_eq!(
            redact_secrets(&format!("here it is: {s}")).0,
            "here it is: [redacted]",
            "{s}"
        );
    }
}

#[test]
fn where_he_is_goes_and_the_city_does_not() {
    assert_eq!(
        redact_text("meet me at 12 Baker Street at six").0,
        "meet me at [redacted] at six"
    );
    assert_eq!(
        redact_text("the shift is at Hauptstraße 12 from 17:00").0,
        "the shift is at [redacted] from 17:00"
    );
    assert_eq!(
        redact_text("it is on ulice Dlouhá 5 upstairs").0,
        "it is on [redacted] upstairs"
    );
    assert_eq!(
        redact_text("pin is 50.0755, 14.4378 exactly").0,
        "pin is [redacted] exactly"
    );
    assert_eq!(
        redact_text("Praha 110 00 is the office").0,
        "[redacted] is the office"
    );
    assert_eq!(
        redact_text("110 00 Praha is the office").0,
        "[redacted] Praha is the office"
    );
    assert_eq!(
        redact_text(r#"{"summary":"shift","location":"Café Slavia"}"#).0,
        r#"{"summary":"shift","location":"[redacted]"}"#
    );
    // Secrets-only leaves locations alone.
    assert_eq!(
        redact_secrets("meet me at 12 Baker Street").0,
        "meet me at 12 Baker Street"
    );
}

#[test]
fn two_postcodes_in_one_context_both_go() {
    assert_eq!(
        redact_text("110 00 a 120 00 Praha").0,
        "[redacted] a [redacted] Praha"
    );
}

#[test]
fn location_key_in_json_values_and_tool_arguments_is_redacted() {
    let v =
        serde_json::json!({"summary": "shift", "location": "Cafe Slavia", "n": {"Address": "x"}});
    let out = alexia_core::redact::redact_json(&v);
    assert_eq!(out["location"], "[redacted]");
    assert_eq!(out["n"]["Address"], "[redacted]");
    assert_eq!(out["summary"], "shift");
}

#[test]
fn no_false_positive_on_plain_sentence() {
    for kept in [
        "I live in Prague and study at CTU FEL",
        "he is relocating to Prague in September",
        "he never finishes anything he starts on a Friday",
        "the plugin registry is at 3 in the morning again",
    ] {
        let (out, k) = redact_text(kept);
        assert_eq!(out, kept);
        assert!(k.is_empty());
    }
}

#[test]
fn known_secret_redacted() {
    let secret = "hunter2-not-shaped-like-anything".to_string();
    let (out, k) = redact_known(
        &format!("the password is {secret}, ok"),
        std::slice::from_ref(&secret),
    );
    assert_eq!(out, "the password is [redacted], ok");
    assert_eq!(k, kinds(&["known secret"]));
    assert!(!k.iter().any(|x| x.contains(&secret)));
    // An empty value must not blank the whole text.
    assert_eq!(redact_known("hello", &[String::new()]).0, "hello");
}

#[test]
fn request_redacts_system_and_calls() {
    let req = ChatRequest {
        messages: vec![
            (Role::User, body(Content::Text("book it".into()))),
            (
                Role::Assistant,
                MessageBody {
                    calls: Some(vec![ToolCall {
                        id: "1".into(),
                        name: "maps.route".into(),
                        arguments: format!(r#"{{"to":"12 Baker Street","key":"{}"}}"#, or_key()),
                    }]),
                    ..body(Content::Text(String::new()))
                },
            ),
            (
                Role::Assistant,
                MessageBody {
                    calls: Some(vec![ToolCall {
                        id: "2".into(),
                        name: "x".into(),
                        arguments: "not json 12 Baker Street".into(),
                    }]),
                    ..body(Content::Text(String::new()))
                },
            ),
        ],
        system: Some(format!("OPENROUTER_API_KEY={}", or_key())),
        tools: vec![],
        max_tokens: Some(10),
    };
    let (out, k) = redact_request(&req);
    assert_eq!(out.system.as_deref(), Some("OPENROUTER_API_KEY=[redacted]"));
    assert_eq!(out.max_tokens, Some(10));
    let args: serde_json::Value =
        serde_json::from_str(&out.messages[1].1.calls.as_ref().unwrap()[0].arguments).unwrap();
    assert_eq!(args, json!({"to":"[redacted]","key":"[redacted]"}));
    assert_eq!(
        out.messages[2].1.calls.as_ref().unwrap()[0].arguments,
        "not json [redacted]"
    );
    // Deduped, first seen first.
    assert_eq!(k, kinds(&["api key", "street"]));
    assert_eq!(summarise(&k), "api key×1, street×1");
}

#[test]
fn location_key_inside_tool_arguments_is_redacted() {
    let req = ChatRequest {
        messages: vec![(
            Role::Assistant,
            MessageBody {
                calls: Some(vec![ToolCall {
                    id: "1".into(),
                    name: "calendar.add".into(),
                    arguments: r#"{"title":"shift","location":"Cafe Slavia"}"#.into(),
                }]),
                ..body(Content::Text(String::new()))
            },
        )],
        system: None,
        tools: vec![],
        max_tokens: None,
    };
    let (out, k) = redact_request(&req);
    let args: serde_json::Value =
        serde_json::from_str(&out.messages[0].1.calls.as_ref().unwrap()[0].arguments).unwrap();
    assert_eq!(args, json!({"title":"shift","location":"[redacted]"}));
    assert_eq!(k, kinds(&["location field"]));
}

#[test]
fn images_untouched() {
    let url = "data:image/png;base64,AAAA".to_string();
    let req = ChatRequest {
        messages: vec![(
            Role::User,
            body(Content::Parts(vec![
                Part::Text {
                    text: format!("key {}", or_key()),
                },
                Part::Image { url: url.clone() },
            ])),
        )],
        system: None,
        tools: vec![],
        max_tokens: None,
    };
    let (out, _) = redact_request(&req);
    assert_eq!(
        out.messages[0].1.content,
        Content::Parts(vec![
            Part::Text {
                text: "key [redacted]".into()
            },
            Part::Image { url },
        ])
    );
}

#[test]
fn json_leaves_and_summary() {
    let v = json!({"a": [format!("k {}", or_key()), 3, null], "b": {"c": "fine"}});
    assert_eq!(
        redact_json(&v),
        json!({"a": ["k [redacted]", 3, null], "b": {"c": "fine"}})
    );
    assert_eq!(
        summarise(&kinds(&["street", "api key", "street"])),
        "api key×1, street×2"
    );
    assert_eq!(summarise(&[]), "");
}
