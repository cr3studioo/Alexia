// SPDX-License-Identifier: AGPL-3.0-only
//! The plugin wire as JSON: framing, MCP shapes, the alexia/* layer.

use alexia_mcp::alexia::AlexiaCall;
use alexia_mcp::jsonrpc::{code, Id, Message, Outcome, V2};
use alexia_mcp::types::{CallToolResult, InitializeParams, InitializeResult, Tool};
use alexia_mcp::{Dir, NoUpcalls, PluginId, Upcalls};
use serde_json::{json, Value};

#[test]
fn v2_marker_round_trip() {
    assert_eq!(serde_json::to_value(V2).unwrap(), json!("2.0"));
    assert_eq!(serde_json::from_value::<V2>(json!("2.0")).unwrap(), V2);
    assert!(serde_json::from_value::<V2>(json!("1.0")).is_err());
    assert!(serde_json::from_value::<V2>(json!(2.0)).is_err());
}

fn parse(line: &str) -> Message {
    serde_json::from_str(line).unwrap()
}

#[test]
fn message_classifies_lines() {
    match parse(r#"{"jsonrpc":"2.0","id":7,"method":"ping"}"#) {
        Message::Request(r) => {
            assert_eq!(r.id, Id::Num(7));
            assert_eq!(r.method, "ping");
            assert!(r.params.is_none());
        }
        m => panic!("expected a request, got {m:?}"),
    }
    match parse(r#"{"jsonrpc":"2.0","id":"abc","method":"roots/list","params":{}}"#) {
        Message::Request(r) => assert_eq!(r.id, Id::Str("abc".into())),
        m => panic!("expected a request, got {m:?}"),
    }
    match parse(r#"{"jsonrpc":"2.0","id":3,"result":{"ok":true}}"#) {
        Message::Response(r) => {
            assert_eq!(r.id, Id::Num(3));
            assert!(matches!(r.outcome, Outcome::Result(ref v) if v == &json!({"ok": true})));
        }
        m => panic!("expected a response, got {m:?}"),
    }
    match parse(r#"{"jsonrpc":"2.0","id":"x-1","error":{"code":-32601,"message":"nope"}}"#) {
        Message::Response(r) => {
            assert_eq!(r.id, Id::Str("x-1".into()));
            match r.outcome {
                Outcome::Error(e) => {
                    assert_eq!(e.code, code::METHOD_NOT_FOUND);
                    assert_eq!(e.message, "nope");
                    assert!(e.data.is_none());
                }
                o => panic!("expected an error outcome, got {o:?}"),
            }
        }
        m => panic!("expected a response, got {m:?}"),
    }
    match parse(r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#) {
        Message::Notification(n) => assert_eq!(n.method, "notifications/tools/list_changed"),
        m => panic!("expected a notification, got {m:?}"),
    }
    // A wrong version marker is not a message at all.
    assert!(serde_json::from_str::<Message>(r#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#).is_err());

    // And back out: Outcome flattens to "result"/"error" keys, ids keep their type.
    let ok = json!({"jsonrpc":"2.0","id":"s","result":{}});
    let err = json!({"jsonrpc":"2.0","id":9,"error":{"code":-32602,"message":"bad","data":{"k":1}}});
    for v in [ok, err] {
        let m: Message = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(serde_json::to_value(&m).unwrap(), v);
    }
}

#[test]
fn initialize_shapes_match_spec() {
    let request = json!({"protocolVersion":"2025-11-25",
        "clientInfo":{"name":"Alexia","version":"3.0.0"},
        "capabilities":{"roots":{}}});
    let params: InitializeParams = serde_json::from_value(request.clone()).unwrap();
    assert_eq!(params.protocol_version, "2025-11-25");
    assert_eq!(params.client_info.name, "Alexia");
    assert!(params.capabilities.roots.is_some());
    assert!(params.capabilities.sampling.is_none());
    assert_eq!(serde_json::to_value(&params).unwrap(), request);

    let result: InitializeResult = serde_json::from_value(json!({"protocolVersion":"2025-11-25",
        "serverInfo":{"name":"demo","version":"1.2.3"},"capabilities":{"tools":{"listChanged":true}},
        "instructions":"Say hello."}))
    .unwrap();
    assert_eq!(result.protocol_version, "2025-11-25");
    assert_eq!(result.server_info.version, "1.2.3");
    assert_eq!(result.capabilities, json!({"tools":{"listChanged":true}}));
    assert_eq!(result.instructions.as_deref(), Some("Say hello."));
}

#[test]
fn tool_keeps_meta_and_annotations() {
    let wire = json!({
        "name": "greet",
        "title": "Greet",
        "description": "Says hello.",
        "inputSchema": {"type":"object","properties":{"who":{"type":"string"}}},
        "outputSchema": {"type":"object","properties":{"text":{"type":"string"}}},
        "annotations": {"readOnlyHint": true, "openWorldHint": false},
        "_meta": {"alexia/provides": ["demo.greet"], "x/other": {"kept": 1}}
    });
    let tool: Tool = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(tool.annotations.as_ref().unwrap().read_only_hint, Some(true));
    assert_eq!(
        tool.meta.as_ref().unwrap()["alexia/provides"],
        json!(["demo.greet"])
    );
    assert_eq!(serde_json::to_value(&tool).unwrap(), wire);
}

#[test]
fn call_tool_result_passes_content_through() {
    let wire = json!({
        "content": [
            {"type":"text","text":"hi"},
            {"type":"hologram","shape":{"sides":7},"future":true}
        ],
        "structuredContent": {"n": 1},
        "isError": false,
        "_meta": {"alexia/final": true}
    });
    let r: CallToolResult = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(r.content.len(), 2);
    assert_eq!(r.content[1]["type"], "hologram");
    assert_eq!(serde_json::to_value(&r).unwrap(), wire);
}

#[test]
fn alexia_call_parse() {
    let samples: [(&str, Value); 20] = [
        ("alexia/settings/get", json!({})),
        ("alexia/settings/set", json!({"key":"status","value":"ok"})),
        ("alexia/storage/insert", json!({"table":"notes","row":{"text":"a"}})),
        ("alexia/storage/select", json!({"table":"notes","where":{"id":{"gt":1}},"limit":5})),
        ("alexia/storage/update", json!({"table":"notes","set":{"text":"b"},"where":{"id":1}})),
        ("alexia/storage/delete", json!({"table":"notes","all":true})),
        ("alexia/storage/count", json!({"table":"notes"})),
        ("alexia/storage/kv/get", json!({"key":"k"})),
        ("alexia/storage/kv/set", json!({"key":"k","value":[1,2]})),
        ("alexia/storage/kv/delete", json!({"key":"k"})),
        ("alexia/storage/raw", json!({"sql":"SELECT 1","params":[1,"a",null]})),
        ("alexia/capability/call", json!({"cap":"demo.greet","arguments":{"who":"Sam"}})),
        ("alexia/answers", json!({"cap":"voice.speak"})),
        ("alexia/host/info", json!({})),
        ("alexia/compute/run", json!({"cap":"image.edit","inputs":[{"name":"a","path":"p","mime":"image/png"}]})),
        ("alexia/attachments/lease", json!({"conversationId":"c","attachmentIds":["a"]})),
        ("alexia/attachments/release", json!({"leaseId":"l"})),
        ("alexia/attachments/live", json!({"leaseId":"l"})),
        ("alexia/attachments/register", json!({"conversationId":"c","path":"p","origin":"normalized"})),
        ("alexia/attachments/share", json!({"conversationId":"c","path":"p","mime":"image/png"})),
    ];
    for (method, params) in samples {
        let call = AlexiaCall::parse(method, Some(params))
            .unwrap_or_else(|e| panic!("{method}: {e}"))
            .unwrap_or_else(|| panic!("{method} was not recognised"));
        let ok = match (&call, method) {
            (AlexiaCall::SettingsGet(_), "alexia/settings/get") => true,
            (AlexiaCall::SettingsSet(kv), "alexia/settings/set") => kv.key == "status",
            (AlexiaCall::Insert(p), "alexia/storage/insert") => p.row["text"] == "a",
            (AlexiaCall::Select(p), "alexia/storage/select") => {
                p.limit == Some(5) && p.filter.as_ref().is_some_and(|w| w.contains_key("id"))
            }
            (AlexiaCall::Update(p), "alexia/storage/update") => p.filter.contains_key("id"),
            (AlexiaCall::Delete(p), "alexia/storage/delete") => p.all == Some(true),
            (AlexiaCall::Count(p), "alexia/storage/count") => p.table == "notes",
            (AlexiaCall::KvGet(k), "alexia/storage/kv/get") => k.key == "k",
            (AlexiaCall::KvSet(kv), "alexia/storage/kv/set") => kv.value == json!([1, 2]),
            (AlexiaCall::KvDelete(k), "alexia/storage/kv/delete") => k.key == "k",
            (AlexiaCall::Raw(p), "alexia/storage/raw") => p.params.len() == 3,
            (AlexiaCall::CapabilityCall(p), "alexia/capability/call") => p.cap == "demo.greet",
            (AlexiaCall::Answers(c), "alexia/answers") => c.cap == "voice.speak",
            (AlexiaCall::HostInfo(_), "alexia/host/info") => true,
            (AlexiaCall::ComputeRun(p), "alexia/compute/run") => p.inputs.len() == 1,
            (AlexiaCall::AttachmentsLease(v), "alexia/attachments/lease") => v["conversationId"] == "c",
            (AlexiaCall::AttachmentsRelease(v), "alexia/attachments/release") => v["leaseId"] == "l",
            (AlexiaCall::AttachmentsLive(v), "alexia/attachments/live") => v["leaseId"] == "l",
            (AlexiaCall::AttachmentsRegister(v), "alexia/attachments/register") => v["path"] == "p",
            (AlexiaCall::AttachmentsShare(v), "alexia/attachments/share") => v["mime"] == "image/png",
            _ => false,
        };
        assert!(ok, "{method} parsed as {call:?}");
    }

    assert!(matches!(
        AlexiaCall::parse("alexia/settings/get", None),
        Ok(Some(AlexiaCall::SettingsGet(_)))
    ));
    assert!(matches!(
        AlexiaCall::parse("alexia/host/info", None),
        Ok(Some(AlexiaCall::HostInfo(_)))
    ));
    assert!(AlexiaCall::parse("tools/list", Some(json!({})))
        .unwrap()
        .is_none());
    assert!(AlexiaCall::parse("alexia/not/a/method", Some(json!({})))
        .unwrap()
        .is_none());

    let err = AlexiaCall::parse("alexia/storage/insert", Some(json!({"row":{}}))).unwrap_err();
    assert_eq!(err.code, -32602);
    assert!(err.message.contains("alexia/storage/insert"), "{}", err.message);

    // The SDK puts `_meta` in every params object; it is ignored, not a parse error.
    let call = AlexiaCall::parse(
        "alexia/storage/kv/get",
        Some(json!({"key":"k","_meta":{"progressToken":1}})),
    )
    .unwrap();
    assert!(matches!(call, Some(AlexiaCall::KvGet(ref k)) if k.key == "k"));
    assert!(matches!(
        AlexiaCall::parse("alexia/settings/get", Some(json!({"_meta":{}}))),
        Ok(Some(AlexiaCall::SettingsGet(_)))
    ));
}

#[test]
fn select_params_order() {
    let call = AlexiaCall::parse(
        "alexia/storage/select",
        Some(json!({"table":"t","order":[["at","desc"]]})),
    )
    .unwrap();
    let Some(AlexiaCall::Select(p)) = call else {
        panic!("expected a select, got {call:?}");
    };
    assert_eq!(p.order.len(), 1);
    assert_eq!(p.order[0].0, "at");
    assert!(matches!(p.order[0].1, Dir::Desc));
    // Missing order is an empty one.
    let Ok(Some(AlexiaCall::Select(p))) =
        AlexiaCall::parse("alexia/storage/select", Some(json!({"table":"t"})))
    else {
        panic!("select without order did not parse");
    };
    assert!(p.order.is_empty());
}

#[test]
fn no_upcalls_offers_roots_only() {
    let offers = NoUpcalls.offers(&PluginId("demo".into()));
    assert_eq!(serde_json::to_value(offers).unwrap(), json!({"roots":{}}));
}
