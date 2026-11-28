// SPDX-License-Identifier: AGPL-3.0-only
//! The shared mesh types: device ids, endpoint ids, the pairing hello, serde forms.

use alexia_mesh::{DeviceId, EndpointId, Hello, Reach, Role};

fn id(s: &str) -> DeviceId {
    DeviceId(s.to_string())
}

#[test]
fn device_id_from_name() {
    let none: &[DeviceId] = &[];
    // Spaces and apostrophes (straight and curly).
    assert_eq!(
        DeviceId::from_name("Vaclav's MacBook", none),
        id("vaclavs-macbook")
    );
    assert_eq!(
        DeviceId::from_name("Vaclav\u{2019}s  MacBook", none),
        id("vaclavs-macbook")
    );
    // Accents fold to ASCII, punctuation runs collapse, ends are trimmed.
    assert_eq!(
        DeviceId::from_name("Václav’s Počítač", none),
        id("vaclavs-pocitac")
    );
    assert_eq!(
        DeviceId::from_name("  Žluťoučký -- kůň! ", none),
        id("zlutoucky-kun")
    );
    assert_eq!(DeviceId::from_name("Straße", none), id("strasse"));
    // A plugin id starts with a letter; nothing usable still gives an id.
    assert_eq!(DeviceId::from_name("2nd Mac", none), id("device-2nd-mac"));
    assert_eq!(DeviceId::from_name("日本", none), id("device"));
    // Length cap: 32, never ending in '-'.
    let long = DeviceId::from_name("The Very Long Name Of A Gaming Desktop PC", none);
    assert_eq!(long, id("the-very-long-name-of-a-gaming-d"));
    assert!(DeviceId::valid(&long.0));
    let long = DeviceId::from_name("abcdefghij abcdefghij abcdefghi zz", none);
    assert_eq!(long, id("abcdefghij-abcdefghij-abcdefghi"));
    assert!(DeviceId::valid(&long.0));
    let exact = DeviceId::from_name(&"a".repeat(40), none);
    assert_eq!(exact.0.len(), 32);
    // Clash suffix, and the next free one.
    let taken = [id("vaclavs-macbook")];
    assert_eq!(
        DeviceId::from_name("Vaclav's MacBook", &taken),
        id("vaclavs-macbook-2")
    );
    let taken = [id("vaclavs-macbook"), id("vaclavs-macbook-2")];
    assert_eq!(
        DeviceId::from_name("Vaclav's MacBook", &taken),
        id("vaclavs-macbook-3")
    );
    // A clash at the cap shortens the base to fit the suffix.
    let taken = [exact.clone()];
    let next = DeviceId::from_name(&"a".repeat(40), &taken);
    assert_eq!(next.0, format!("{}-2", "a".repeat(30)));
    assert!(DeviceId::valid(&next.0));
}

#[test]
fn device_id_valid() {
    for ok in ["a", "vaclavs-macbook", "pc-2", &"a".repeat(32)] {
        assert!(DeviceId::valid(ok), "{ok}");
    }
    for bad in ["", &"a".repeat(33), "Mac", "2nd", "-a", "a_b", "a b", "á"] {
        assert!(!DeviceId::valid(bad), "{bad}");
    }
}

#[test]
fn endpoint_id_parse() {
    let hex = "0123456789abcdef".repeat(4);
    assert_eq!(EndpointId::parse(&hex), Some(EndpointId(hex.clone())));
    assert_eq!(EndpointId::parse(&hex[..63]), None);
    assert_eq!(EndpointId::parse(&format!("{hex}0")), None);
    assert_eq!(EndpointId::parse(&hex.to_uppercase()), None);
    assert_eq!(EndpointId::parse(&format!("{}g", &hex[..63])), None);
    assert_eq!(EndpointId::parse(""), None);
}

#[test]
fn hello_round_trips_and_fits_1024() {
    let hub = Hello {
        role: Role::Hub,
        platform: "windows-x86_64".into(),
        app_version: "3.0.0".into(),
        wake: vec!["aa:bb:cc:dd:ee:ff".into(), "11:22:33:44:55:66".into()],
    };
    let json = serde_json::to_string(&hub).unwrap();
    assert!(json.contains("\"appVersion\":\"3.0.0\""), "{json}");
    assert!(json.contains("\"role\":\"hub\""), "{json}");
    assert_eq!(serde_json::from_str::<Hello>(&json).unwrap(), hub);
    assert!(json.len() <= 1024, "{} bytes", json.len());

    // A hub with many interfaces still fits.
    let many = Hello {
        wake: vec!["aa:bb:cc:dd:ee:ff".into(); 16],
        ..hub
    };
    assert!(serde_json::to_vec(&many).unwrap().len() <= 1024);

    // `wake` defaults when a limb leaves it out.
    let limb: Hello =
        serde_json::from_str(r#"{"role":"limb","platform":"macos-aarch64","appVersion":"3.0.0"}"#)
            .unwrap();
    assert_eq!(limb.role, Role::Limb);
    assert!(limb.wake.is_empty());
}

#[test]
fn role_and_reach_serde_lowercase() {
    assert_eq!(serde_json::to_string(&Role::Hub).unwrap(), "\"hub\"");
    assert_eq!(serde_json::to_string(&Role::Limb).unwrap(), "\"limb\"");
    for (r, s) in [
        (Reach::Direct, "direct"),
        (Reach::Relayed, "relayed"),
        (Reach::Offline, "offline"),
    ] {
        let j = format!("\"{s}\"");
        assert_eq!(serde_json::to_string(&r).unwrap(), j);
        assert_eq!(serde_json::from_str::<Reach>(&j).unwrap(), r);
    }
    assert!(serde_json::from_str::<Role>("\"Hub\"").is_err());
    // The id newtypes are plain strings on the wire.
    assert_eq!(
        serde_json::to_string(&DeviceId("pc".into())).unwrap(),
        "\"pc\""
    );
}
