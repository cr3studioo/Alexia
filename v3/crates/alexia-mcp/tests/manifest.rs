// SPDX-License-Identifier: AGPL-3.0-only
//! plugin.json: parsing, v2's cross-field rules, compatibility, discovery. Manifests are inline;
//! nothing here reads `plugins/`.

use std::path::PathBuf;

use alexia_mcp::manifest::Lifetime;
use alexia_mcp::{discover, Manifest};
use serde_json::{json, Value};

fn base() -> Value {
    json!({
        "$schema": "../../docs/spec/plugin.schema.json",
        "manifest_version": 1,
        "id": "sample",
        "name": "Sample",
        "summary": "A plugin that exists for tests.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": "node", "args": ["index.js"] },
        "alexia_protocol": 2,
        "mcp_protocol": "2025-11-25"
    })
}

fn with(patch: Value) -> Value {
    let mut m = base();
    for (k, v) in patch.as_object().unwrap() {
        m[k] = v.clone();
    }
    m
}

fn parse(v: &Value) -> Result<Manifest, String> {
    Manifest::parse(&v.to_string()).map_err(|e| e.sentence)
}

fn refused(v: Value, needle: &str) {
    let e = parse(&v).expect_err(&format!("should refuse: {v}"));
    assert!(e.contains(needle), "{e:?} should mention {needle:?}");
}

#[test]
fn parses_a_full_manifest() {
    let m = parse(&with(json!({
        "alexia_protocol": 15,
        "min_app": "3.0.0",
        "max_app": "3.9.0",
        "requires": [{ "cap": "net.download", "why": "to fetch the model once" }],
        "provides": ["image.generate", "demo.greet"],
        "settings": [
            { "type": "text", "key": "greeting", "label": "Greeting", "default": "Hello" },
            { "type": "password", "key": "api_key", "label": "API key" },
            { "type": "choice", "key": "tone", "label": "Tone", "options": ["plain", "warm"], "default": "plain" }
        ],
        "storage": { "namespace": "sample", "tables": ["greetings", "two_words"], "dir": true },
        "commands": [{ "name": "say-hi", "summary": "Say hi." }],
        "skills": ["skills/greeting-well"],
        "assets": ["assets/icon.png"],
        "min_tier": "T1",
        "lifetime": "resident",
        "panel": { "label": "Sample", "widgets": [{ "type": "status", "key": "ready", "label": "State" }] },
        "page": { "title": "Sample", "sizes": { "M": { "at": [12, 10], "show": ["ready"] } } },
        "compute": {
            "operations": [{ "cap": "image.generate", "summary": "Draw a picture.", "weight": "heavy" }],
            "hooks": ["setup", "release"]
        }
    })))
    .unwrap();
    assert_eq!(
        m.schema.as_deref(),
        Some("../../docs/spec/plugin.schema.json")
    );
    assert_eq!(m.id, "sample");
    assert_eq!(m.entry.run, "node");
    assert_eq!(m.entry.args, ["index.js"]);
    assert_eq!(m.alexia_protocol, 15);
    assert_eq!(m.min_app.as_deref(), Some("3.0.0"));
    assert_eq!(m.max_app.as_deref(), Some("3.9.0"));
    assert_eq!(m.requires[0].cap, "net.download");
    assert_eq!(m.requires[0].why, "to fetch the model once");
    assert_eq!(m.provides, ["image.generate", "demo.greet"]);
    assert_eq!(m.settings.len(), 3);
    assert_eq!(m.settings[0].default, Some(json!("Hello")));
    assert_eq!(m.settings[0].widget["label"], json!("Greeting"));
    let st = m.storage.as_ref().unwrap();
    assert_eq!(
        (st.namespace.as_str(), st.tables.len(), st.dir),
        ("sample", 2, true)
    );
    assert_eq!(m.commands[0].name, "say-hi");
    assert_eq!(m.skills, ["skills/greeting-well"]);
    assert_eq!(m.assets, ["assets/icon.png"]);
    assert_eq!(m.min_tier.as_deref(), Some("T1"));
    assert_eq!(m.lifetime(), Lifetime::Resident);
    assert_eq!(m.panel.as_ref().unwrap()["label"], json!("Sample"));
    assert_eq!(m.page.as_ref().unwrap()["title"], json!("Sample"));
    let c = m.compute.as_ref().unwrap();
    assert_eq!(c.operations[0].cap, "image.generate");
    assert_eq!(c.operations[0].weight.as_deref(), Some("heavy"));
    assert_eq!(c.hooks, ["setup", "release"]);
    assert_eq!(m.compatible(), Ok(()));
}

#[test]
fn unknown_top_level_key_is_an_error() {
    let e = parse(&with(json!({ "tols": [] }))).unwrap_err();
    assert_eq!(
        e,
        "The plugin “sample” has a manifest with an unknown field “tols”."
    );
    // Nested strict objects refuse unknown keys too.
    refused(
        with(json!({ "entry": { "run": "node", "argz": [] } })),
        "argz",
    );
}

#[test]
fn widget_fields_are_kept() {
    let m = parse(&with(json!({ "settings": [{
        "type": "choice", "key": "tone", "label": "Tone",
        "options": ["plain", { "value": "warm", "label": "Warm" }],
        "hint": "How it sounds.", "default": "plain"
    }]})))
    .unwrap();
    let s = &m.settings[0];
    assert_eq!((s.key.as_str(), s.kind.as_str()), ("tone", "choice"));
    assert_eq!(s.default, Some(json!("plain")));
    assert_eq!(
        s.widget["options"],
        json!(["plain", { "value": "warm", "label": "Warm" }])
    );
    assert_eq!(s.widget["hint"], json!("How it sounds."));
    assert!(!s.widget.contains_key("key") && !s.widget.contains_key("type"));
}

#[test]
fn cross_field_rules() {
    refused(
        with(json!({ "storage": { "namespace": "other" } })),
        "storage.namespace",
    );
    refused(with(json!({ "id": "Two_Words" })), "“id”");
    refused(with(json!({ "id": "two--words" })), "“id”");
    refused(
        with(
            json!({ "id": "two-words", "storage": { "namespace": "two-words", "tables": ["Bad-Table"] } }),
        ),
        "Bad-Table",
    );
    refused(with(json!({ "provides": ["Not A Cap"] })), "Not A Cap");
    refused(
        with(json!({ "requires": [{ "cap": "nodots", "why": "x" }] })),
        "nodots",
    );
    refused(
        with(json!({ "requires": [{ "cap": "net.everything", "why": "x" }] })),
        "not a permission Alexia grants",
    );
    refused(
        with(json!({ "settings": [
            { "type": "text", "key": "greeting", "label": "A" },
            { "type": "toggle", "key": "greeting", "label": "B" }
        ]})),
        "declared twice",
    );
    refused(
        with(json!({ "alexia_protocol": 3,
            "settings": [{ "type": "text", "key": "greeting", "label": "A" }],
            "panel": { "label": "P", "widgets": [{ "type": "status", "key": "greeting", "label": "B" }] } })),
        "declared twice",
    );
    refused(with(json!({ "manifest_version": 2 })), "manifest_version");
    refused(
        with(
            json!({ "alexia_protocol": 13, "provides": ["image.generate"],
            "compute": { "operations": [{ "cap": "image.render", "summary": "Render." }] } }),
        ),
        "compute operation “image.render” must also be in provides",
    );
    refused(with(json!({ "min_tier": "T4" })), "min_tier");
    refused(
        with(json!({ "provides": ["demo.greet", "demo.greet"] })),
        "twice",
    );
    refused(
        with(
            json!({ "commands": [{ "name": "go", "summary": "Go." }, { "name": "go", "summary": "Again." }] }),
        ),
        "twice",
    );
    refused(
        with(
            json!({ "requires": [{ "cap": "audio.input", "why": "a" }, { "cap": "audio.input", "why": "b" }] }),
        ),
        "twice",
    );
    refused(with(json!({ "version": "v0.1" })), "version");
    refused(
        with(json!({ "entry": { "run": "C:\\node.exe" } })),
        "entry.run",
    );
    refused(
        with(json!({ "skills": ["../../etc/passwd"] })),
        "skill path",
    );
    refused(
        with(json!({ "settings": [{ "type": "slider", "key": "x", "label": "X" }] })),
        "slider",
    );
    refused(
        with(json!({ "page": { "title": "P", "sizes": {} } })),
        "page arrived in alexia_protocol 12",
    );
    refused(
        with(json!({ "assets": ["a.png"] })),
        "assets arrived in alexia_protocol 15",
    );
    refused(with(json!({ "lifetime": "forever" })), "forever");

    // v2 has no "password has no default" rule: its password variant has no `default` field and
    // zod strips the key. The port does the same instead of refusing.
    let m = parse(&with(json!({ "settings": [
        { "type": "password", "key": "api_key", "label": "Key", "default": "placeholder" }
    ]})))
    .unwrap();
    assert_eq!(m.settings[0].default, None);
}

#[test]
fn compatible_protocol_window() {
    for (p, ok) in [(1, false), (16, false), (2, true), (15, true)] {
        let m = parse(&with(json!({ "alexia_protocol": p }))).unwrap();
        assert_eq!(m.compatible().is_ok(), ok, "alexia_protocol {p}");
    }
    let m = parse(&with(json!({ "alexia_protocol": 16 }))).unwrap();
    assert_eq!(
        m.compatible().unwrap_err(),
        "Sample needs a newer Alexia.\nUpdate Alexia, or install an earlier version of Sample."
    );
    let m = parse(&with(json!({ "alexia_protocol": 1 }))).unwrap();
    assert_eq!(
        m.compatible().unwrap_err(),
        "Sample was written for an older version of Alexia and can't load.\nCheck whether Sample has an update."
    );
}

#[test]
fn compatible_mcp_revision() {
    let m = parse(&with(json!({ "mcp_protocol": "2025-11-25" }))).unwrap();
    assert_eq!(m.compatible(), Ok(()));
    let m = parse(&with(json!({ "mcp_protocol": "2026-07-28" }))).unwrap();
    assert_eq!(
        m.compatible().unwrap_err(),
        "Sample speaks a version of MCP that Alexia doesn't.\nAlexia speaks 2025-11-25; Sample speaks 2026-07-28."
    );
    refused(with(json!({ "mcp_protocol": "latest" })), "mcp_protocol");
}

#[test]
fn compatible_app_range() {
    let m = parse(&with(json!({ "min_app": "4.0.0" }))).unwrap();
    assert_eq!(
        m.compatible().unwrap_err(),
        "Sample needs Alexia 4.0.0 or later, and this is 3.0.0.\nUpdate Alexia, or install an earlier version of Sample."
    );
    let m = parse(&with(json!({ "max_app": "2.9.0" }))).unwrap();
    assert_eq!(
        m.compatible().unwrap_err(),
        "Sample says it runs on Alexia 2.9.0 and earlier, and this is 3.0.0.\nCheck whether Sample has an update."
    );
    let m = parse(&with(json!({ "min_app": "3.0.0" }))).unwrap();
    assert_eq!(m.compatible(), Ok(()));
    let m = parse(&with(json!({ "max_app": "3.0.0" }))).unwrap();
    assert_eq!(m.compatible(), Ok(()));
}

#[test]
fn lifetime_defaults_to_lazy() {
    assert_eq!(parse(&base()).unwrap().lifetime(), Lifetime::Lazy);
    let m = parse(&with(json!({ "lifetime": "lazy" }))).unwrap();
    assert_eq!(m.lifetime(), Lifetime::Lazy);
}

#[test]
fn password_keys_lists_password_settings() {
    let m = parse(&with(json!({ "settings": [
        { "type": "password", "key": "api_key", "label": "Key" },
        { "type": "text", "key": "greeting", "label": "Greeting" },
        { "type": "password", "key": "bot_token", "label": "Token" }
    ]})))
    .unwrap();
    assert_eq!(m.password_keys(), ["api_key", "bot_token"]);
    assert!(parse(&base()).unwrap().password_keys().is_empty());
}

/// A fresh empty directory under the system temp dir, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> Scratch {
        let dir =
            std::env::temp_dir().join(format!("alexia-manifest-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn discover_reports_failures_without_stopping() {
    let s = Scratch::new("discover");
    let good = s.0.join("two-words");
    std::fs::create_dir(&good).unwrap();
    let manifest = with(json!({ "id": "two-words", "name": "Two Words" }));
    std::fs::write(good.join("plugin.json"), manifest.to_string()).unwrap();

    let bad = s.0.join("broken");
    std::fs::create_dir(&bad).unwrap();
    let manifest = with(json!({ "id": "broken", "tols": [] }));
    std::fs::write(bad.join("plugin.json"), manifest.to_string()).unwrap();

    std::fs::create_dir(s.0.join("not-a-plugin")).unwrap();
    std::fs::write(s.0.join("stray.json"), "{}").unwrap();

    let found = discover(&s.0);
    assert_eq!(found.len(), 2, "{found:?}");
    let (path, e) = found[0].as_ref().unwrap_err();
    assert_eq!(path, &bad);
    assert_eq!(
        e.sentence,
        "The plugin in “broken” has a manifest with an unknown field “tols”."
    );
    let ok = found[1].as_ref().unwrap();
    assert_eq!(ok.path, good);
    assert_eq!(ok.manifest.id, "two-words");
}

#[test]
fn discover_refuses_an_id_that_is_not_its_folder() {
    let s = Scratch::new("mismatch");
    let dir = s.0.join("sample");
    std::fs::create_dir(&dir).unwrap();
    let manifest = with(json!({ "id": "other", "storage": { "namespace": "other" } }));
    std::fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
    let found = discover(&s.0);
    let (_, e) = found[0].as_ref().unwrap_err();
    assert!(e.sentence.contains("calls it “other”"), "{e}");
}

#[test]
fn discover_missing_dir_is_empty() {
    let s = Scratch::new("missing");
    assert!(discover(&s.0.join("nowhere")).is_empty());
}

#[test]
fn empty_assets_needs_protocol_15() {
    refused(
        with(json!({ "alexia_protocol": 14, "assets": [] })),
        "alexia_protocol 15",
    );
    assert!(parse(&with(json!({ "alexia_protocol": 15, "assets": [] }))).is_ok());
}

#[test]
fn null_optional_field_is_refused() {
    refused(
        with(json!({ "alexia_protocol": 1, "lifetime": null })),
        "“lifetime” must not be null",
    );
    refused(with(json!({ "panel": null })), "“panel” must not be null");
    refused(
        with(json!({ "min_app": null })),
        "“min_app” must not be null",
    );
    refused(
        with(json!({ "entry": { "run": "node", "args": null } })),
        "“entry.args” must not be null",
    );
    let compute = |weight: Value| {
        with(json!({
            "alexia_protocol": 13,
            "provides": ["image.generate"],
            "compute": { "operations": [
                { "cap": "image.generate", "summary": "Make an image.", "weight": weight }
            ]}
        }))
    };
    refused(
        compute(Value::Null),
        "“compute.operations[0].weight” must not be null",
    );
    assert!(parse(&compute(json!("light"))).is_ok());

    // Settings are not walked: zod strips a password's `default`, null or not.
    let m = parse(&with(json!({ "settings": [
        { "type": "password", "key": "api_key", "label": "Key", "default": null }
    ]})))
    .unwrap();
    assert_eq!(m.settings[0].default, None);
}
