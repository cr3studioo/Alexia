// SPDX-License-Identifier: AGPL-3.0-only
//! P4-03: migration 5, paired devices, fallback sync, guests.
mod scratch;

use alexia_store::*;
use rusqlite::Connection;
use scratch::Scratch;
use serde_json::json;

fn user_version(s: &Store) -> i64 {
    s.transaction(|tx| Ok(tx.query_row("PRAGMA user_version", [], |r| r.get(0))?))
        .unwrap()
}

fn has_table(s: &Store, name: &str) -> bool {
    s.transaction(|tx| {
        Ok(tx.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
            [name],
            |r| r.get::<_, i64>(0),
        )?)
    })
    .unwrap()
        == 1
}

fn device(id: &str, name: &str, endpoint: &str) -> DeviceRow {
    DeviceRow {
        id: id.into(),
        name: name.into(),
        endpoint: endpoint.into(),
        role: "limb".into(),
        platform: "macos".into(),
        hello: json!({"v": 1, "name": name}),
        hints: json!({}),
        paired_at: 100,
        last_seen: None,
        revoked_at: None,
    }
}

/// A stand-in sha256: 64 lowercase hex. The store never sees the code it came from.
fn hash(c: char) -> String {
    c.to_string().repeat(64)
}

#[test]
fn migration_5_applies_on_a_v4_database() {
    let s = Store::open_in_memory().unwrap();
    assert_eq!(user_version(&s), 5);

    // A real version-4 file: today's schema with migration 5 taken back off.
    let dir = Scratch::new("devices-upgrade");
    let db = dir.join("alexia.db");
    let session = {
        let s = Store::open(&db).unwrap();
        s.create_session(Some("kept")).unwrap()
    };
    Connection::open(&db)
        .unwrap()
        .execute_batch(
            "DROP TABLE devices; DROP TABLE fallback_sync; DROP TABLE guests; \
             PRAGMA user_version = 4;",
        )
        .unwrap();
    {
        let c = Connection::open(&db).unwrap();
        let n: i64 = c
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'devices'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0);
    }
    let s = Store::open(&db).unwrap();
    assert_eq!(user_version(&s), 5);
    for t in ["devices", "fallback_sync", "guests", "notices"] {
        assert!(has_table(&s, t), "{t}");
    }
    assert!(s.sessions().unwrap().iter().any(|x| x.id == session));
    s.device_put(&device("d1", "Mac", "tcp://mac:7400"))
        .unwrap();
    assert_eq!(s.devices().unwrap().len(), 1);
}

#[test]
fn device_role_is_checked() {
    let s = Store::open_in_memory().unwrap();
    let mut d = device("d1", "Mac", "tcp://mac:7400");
    d.role = "boss".into();
    assert!(s.device_put(&d).is_err());
    assert!(s.devices().unwrap().is_empty());
}

#[test]
fn device_put_repair_unrevokes() {
    let s = Store::open_in_memory().unwrap();
    s.device_put(&device("d1", "Mac", "tcp://mac:7400"))
        .unwrap();
    assert!(s.device_revoke("d1", 200).unwrap());
    assert!(!s.device_revoke("d1", 300).unwrap(), "revoked once");
    assert_eq!(s.device("d1").unwrap().unwrap().revoked_at, Some(200));

    // Re-pair at the same endpoint with a new id: the old row is replaced, live again.
    let mut again = device("d2", "Mac Studio", "tcp://mac:7400");
    again.revoked_at = Some(999); // ignored: a put is a live pairing
    again.hints = json!({"lan": "10.0.0.2"});
    s.device_put(&again).unwrap();
    assert!(s.device("d1").unwrap().is_none());
    let got = s.device("d2").unwrap().unwrap();
    assert_eq!(got.revoked_at, None);
    assert_eq!(got.name, "Mac Studio");
    assert_eq!(got.hints, json!({"lan": "10.0.0.2"}));
    assert_eq!(got.hello, json!({"v": 1, "name": "Mac Studio"}));
    assert_eq!(s.devices().unwrap(), vec![got]);

    // Same id, moved endpoint: still one row.
    s.device_put(&device("d2", "Mac Studio", "tcp://mac:7401"))
        .unwrap();
    assert_eq!(s.devices().unwrap().len(), 1);
    assert!(s.device_by_endpoint("tcp://mac:7400").unwrap().is_none());
}

#[test]
fn devices_hides_revoked() {
    let s = Store::open_in_memory().unwrap();
    s.device_put(&device("b", "Phone", "tcp://phone:1"))
        .unwrap();
    s.device_put(&device("a", "Windows PC", "tcp://pc:1"))
        .unwrap();
    s.device_put(&device("c", "Mac", "tcp://mac:1")).unwrap();
    let names =
        |s: &Store| -> Vec<String> { s.devices().unwrap().into_iter().map(|d| d.name).collect() };
    assert_eq!(names(&s), ["Mac", "Phone", "Windows PC"]);
    assert!(s.device_revoke("b", 5).unwrap());
    assert_eq!(names(&s), ["Mac", "Windows PC"]);
    // Still there for whoever asks by id.
    assert_eq!(s.device("b").unwrap().unwrap().revoked_at, Some(5));
    assert!(!s.device_revoke("nope", 5).unwrap());
}

#[test]
fn device_by_endpoint() {
    let s = Store::open_in_memory().unwrap();
    s.device_put(&device("d1", "Mac", "tcp://mac:7400"))
        .unwrap();
    assert_eq!(
        s.device_by_endpoint("tcp://mac:7400").unwrap().unwrap().id,
        "d1"
    );
    assert!(s.device_by_endpoint("tcp://other:1").unwrap().is_none());

    s.device_seen("d1", 4242).unwrap();
    s.device_hints("d1", &json!({"wan": "x"})).unwrap();
    let d = s.device_by_endpoint("tcp://mac:7400").unwrap().unwrap();
    assert_eq!(d.last_seen, Some(4242));
    assert_eq!(d.hints, json!({"wan": "x"}));
    // Unknown ids change nothing and are not errors.
    s.device_seen("nope", 1).unwrap();
    s.device_hints("nope", &json!({})).unwrap();
}

#[test]
fn fallback_mark_is_idempotent() {
    // Documented contract: a second mark of the same (device, remote_id) is a no-op and the
    // first local id stays.
    let s = Store::open_in_memory().unwrap();
    assert_eq!(s.fallback_synced("mac", 7).unwrap(), None);
    s.fallback_mark("mac", 7, 70, 1).unwrap();
    assert_eq!(s.fallback_synced("mac", 7).unwrap(), Some(70));
    s.fallback_mark("mac", 7, 71, 2).unwrap();
    assert_eq!(s.fallback_synced("mac", 7).unwrap(), Some(70));
    // Same remote id from another device is its own row.
    assert_eq!(s.fallback_synced("pc", 7).unwrap(), None);
    s.fallback_mark("pc", 7, 80, 3).unwrap();
    assert_eq!(s.fallback_synced("pc", 7).unwrap(), Some(80));
    let rows: i64 = s
        .transaction(|tx| Ok(tx.query_row("SELECT count(*) FROM fallback_sync", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(rows, 2);
}

#[test]
fn guest_code_claims_once() {
    let s = Store::open_in_memory().unwrap();
    let id = s.guest_add("Eva", "telegram", &hash('a'), 10).unwrap();
    assert_eq!(s.guest_of("telegram", "chat-1").unwrap(), None);
    // Wrong channel or wrong code: nothing.
    assert_eq!(
        s.guest_claim("whatsapp", &hash('a'), "chat-1").unwrap(),
        None
    );
    assert_eq!(
        s.guest_claim("telegram", &hash('b'), "chat-1").unwrap(),
        None
    );

    let g = s
        .guest_claim("telegram", &hash('a'), "chat-1")
        .unwrap()
        .unwrap();
    assert_eq!(g.id, id);
    assert_eq!(g.chat.as_deref(), Some("chat-1"));
    assert_eq!(s.guest_of("telegram", "chat-1").unwrap(), Some(g));
    // The code is spent, from any chat.
    assert_eq!(
        s.guest_claim("telegram", &hash('a'), "chat-1").unwrap(),
        None
    );
    assert_eq!(
        s.guest_claim("telegram", &hash('a'), "chat-2").unwrap(),
        None
    );

    // A second guest cannot take a chat a live guest holds; their code survives the refusal.
    s.guest_add("Jan", "telegram", &hash('c'), 11).unwrap();
    assert!(matches!(
        s.guest_claim("telegram", &hash('c'), "chat-1"),
        Err(Error::Refused(_))
    ));
    assert!(s
        .guest_claim("telegram", &hash('c'), "chat-3")
        .unwrap()
        .is_some());
    assert_eq!(s.guests().unwrap().len(), 2);
}

#[test]
fn guest_of_ignores_removed() {
    let s = Store::open_in_memory().unwrap();
    let id = s.guest_add("Eva", "telegram", &hash('a'), 10).unwrap();
    s.guest_claim("telegram", &hash('a'), "chat-1")
        .unwrap()
        .unwrap();
    assert!(s.guest_remove(id, 20).unwrap());
    assert!(!s.guest_remove(id, 30).unwrap(), "removed once");
    assert_eq!(s.guest_of("telegram", "chat-1").unwrap(), None);
    assert!(s.guests().unwrap().is_empty());

    // A removed guest's unused code dies with them.
    let gone = s.guest_add("Jan", "telegram", &hash('b'), 11).unwrap();
    assert!(s.guest_remove(gone, 21).unwrap());
    assert_eq!(
        s.guest_claim("telegram", &hash('b'), "chat-2").unwrap(),
        None
    );

    // Asked back in, Eva can take her old chat again.
    let back = s.guest_add("Eva", "telegram", &hash('c'), 40).unwrap();
    let g = s
        .guest_claim("telegram", &hash('c'), "chat-1")
        .unwrap()
        .unwrap();
    assert_eq!(g.id, back);
    assert_eq!(s.guest_of("telegram", "chat-1").unwrap(), Some(g));
}

#[test]
fn guest_code_is_not_stored_in_clear() {
    let s = Store::open_in_memory().unwrap();
    let code = "PLUM-4471";
    // A raw code where a hash belongs is refused, so it can never reach the table.
    assert!(matches!(
        s.guest_add("Eva", "telegram", code, 10),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        s.guest_add("Eva", "telegram", &"A".repeat(64), 10),
        Err(Error::Invalid(_))
    ));
    s.guest_add("Eva", "telegram", &hash('e'), 10).unwrap();

    let dump = |s: &Store| -> String {
        s.transaction(|tx| {
            let mut st = tx.prepare(
                "SELECT id, name, channel, coalesce(chat, ''), coalesce(code_hash, ''), \
                 added_at, coalesce(removed_at, '') FROM guests",
            )?;
            let rows = st.query_map([], |r| {
                Ok((0..7)
                    .map(|i| {
                        r.get::<_, rusqlite::types::Value>(i)
                            .map(|v| format!("{v:?}"))
                    })
                    .collect::<rusqlite::Result<Vec<_>>>()?
                    .join("|"))
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?.join("\n"))
        })
        .unwrap()
    };
    let before = dump(&s);
    assert!(before.contains("Eva"), "{before}");
    assert!(!before.contains(code), "{before}");
    assert!(before.contains(&hash('e')), "the hash is kept until used");

    s.guest_claim("telegram", &hash('e'), "chat-1")
        .unwrap()
        .unwrap();
    let after = dump(&s);
    assert!(
        !after.contains(code) && !after.contains(&hash('e')),
        "{after}"
    );
    let hash_col: Option<String> = s
        .transaction(|tx| Ok(tx.query_row("SELECT code_hash FROM guests", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(hash_col, None);
}
