// SPDX-License-Identifier: AGPL-3.0-only
//! TR-09: SQLCipher at rest. Every test holds `LOCK`: the key lives in one process-wide
//! in-memory keychain, and a stored key changes how every new store opens.
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use alexia_store::import::import_v2;
use alexia_store::*;
use rusqlite::Connection;

static LOCK: Mutex<()> = Mutex::new(());
const MARKER: &str = "zebra-marker-7f3a-plaintext-canary";
const MISSING: &str = "The database is encrypted and its key is missing or wrong.";

/// The lock, the in-memory keychain, no stored key, and a fresh empty folder.
fn setup(name: &str) -> (MutexGuard<'static, ()>, PathBuf) {
    let guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
    std::env::remove_var(secrets::env_name("_core", "store_key"));
    secrets::delete("_core", "store_key").unwrap();
    let dir = std::env::temp_dir().join(format!("alexia-encrypt-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    (guard, dir)
}

/// A plain store with a session, a marker message, a kv entry and a plugin table row.
fn plain_store(path: &Path) {
    let store = Store::open(path).unwrap();
    let s = store.create_session(Some(MARKER)).unwrap();
    let body: MessageBody =
        serde_json::from_value(serde_json::json!({ "content": MARKER })).unwrap();
    store.append(s, Role::User, None, &body).unwrap();
    store
        .kv_set("hello", "k", &serde_json::json!(MARKER))
        .unwrap();
    store
        .transaction(|tx| {
            Ok(tx.execute_batch(&format!(
                "CREATE TABLE p_hello_notes (t TEXT); INSERT INTO p_hello_notes VALUES ('{MARKER}');"
            ))?)
        })
        .unwrap();
}

fn contains(hay: &[u8], needle: &str) -> bool {
    hay.windows(needle.len()).any(|w| w == needle.as_bytes())
}

fn refusal<T>(r: Result<T>) -> String {
    match r {
        Err(Error::Refused(s)) => s,
        Err(e) => panic!("expected a refusal, got {e:?}"),
        Ok(_) => panic!("expected a refusal, got Ok"),
    }
}

#[test]
fn encrypt_then_open_reads_everything() {
    let (_g, dir) = setup("reads");
    let db = dir.join("alexia.db");
    plain_store(&db);
    assert!(!Store::is_encrypted(&db).unwrap());
    encrypt::encrypt(&db).unwrap();
    assert!(Store::is_encrypted(&db).unwrap());
    assert!(secrets::get("_core", "store_key").unwrap().is_some());
    assert!(!dir.join("alexia.db.enc").exists());
    assert!(!dir.join("alexia.db.plain").exists());

    let store = Store::open(&db).unwrap();
    let sessions = store.sessions().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].title.as_deref(), Some(MARKER));
    let history = store.history(sessions[0].id, None).unwrap();
    assert_eq!(history[0].body.content.text(), MARKER);
    assert_eq!(
        store.kv_get("hello", "k").unwrap(),
        Some(serde_json::json!(MARKER))
    );
    let note: String = store
        .transaction(|tx| Ok(tx.query_row("SELECT t FROM p_hello_notes", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(note, MARKER);
    // Still writable, and the write survives a reopen.
    store.create_session(Some("after")).unwrap();
    drop(store);
    assert_eq!(Store::open(&db).unwrap().sessions().unwrap().len(), 2);
}

#[test]
fn plain_bytes_absent_after() {
    let (_g, dir) = setup("bytes");
    let db = dir.join("alexia.db");
    plain_store(&db);
    assert!(contains(&fs::read(&db).unwrap(), MARKER), "fixture check");
    encrypt::encrypt(&db).unwrap();
    for entry in fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        assert!(
            !contains(&fs::read(&path).unwrap(), MARKER),
            "{} holds plain text",
            path.display()
        );
    }
    // Writing through the encrypted store keeps the marker out too (-wal included).
    let store = Store::open(&db).unwrap();
    store.create_session(Some(MARKER)).unwrap();
    for entry in fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        assert!(
            !contains(&fs::read(&path).unwrap(), MARKER),
            "{}",
            path.display()
        );
    }
}

#[test]
fn wrong_key_sentence() {
    let (_g, dir) = setup("wrong");
    let db = dir.join("alexia.db");
    plain_store(&db);
    encrypt::encrypt(&db).unwrap();

    secrets::set("_core", "store_key", &"ab".repeat(32)).unwrap();
    assert_eq!(refusal(Store::open(&db)), MISSING);
    secrets::set("_core", "store_key", "not hex").unwrap();
    assert_eq!(refusal(Store::open(&db)), MISSING);
    secrets::delete("_core", "store_key").unwrap();
    assert_eq!(refusal(Store::open(&db)), MISSING);
}

#[test]
fn refuses_twice() {
    let (_g, dir) = setup("twice");
    let db = dir.join("alexia.db");
    plain_store(&db);
    encrypt::encrypt(&db).unwrap();
    let key = secrets::get("_core", "store_key").unwrap();
    refusal(encrypt::encrypt(&db));
    assert_eq!(secrets::get("_core", "store_key").unwrap(), key, "key kept");

    // A key already stored refuses a plain file too, and the file is left plain.
    let other = dir.join("other.db");
    secrets::delete("_core", "store_key").unwrap();
    plain_store(&other);
    secrets::set("_core", "store_key", &"cd".repeat(32)).unwrap();
    refusal(encrypt::encrypt(&other));
    assert!(!Store::is_encrypted(&other).unwrap());
}

#[test]
fn refuses_while_open() {
    let (_g, dir) = setup("open");
    let db = dir.join("alexia.db");
    plain_store(&db);
    let hub = Store::open(&db).unwrap();
    refusal(encrypt::encrypt(&db));
    assert_eq!(
        secrets::get("_core", "store_key").unwrap(),
        None,
        "key removed"
    );
    assert!(!Store::is_encrypted(&db).unwrap());
    assert!(!dir.join("alexia.db.enc").exists());
    assert!(!dir.join("alexia.db.keyed").exists(), "marker removed");
    assert_eq!(hub.sessions().unwrap().len(), 1);
}

#[test]
fn v2_plain_file_still_imports_into_encrypted_store() {
    let (_g, dir) = setup("v2");
    let v2_root = dir.join("v2");
    fs::create_dir_all(&v2_root).unwrap();
    {
        let v2 = Connection::open(v2_root.join("alexia.db")).unwrap();
        let sql = include_str!("fixtures/v2_migrations.sql");
        let end = sql.find("PRAGMA user_version = 11;").unwrap() + 25;
        v2.execute_batch(&sql[..end]).unwrap();
        v2.execute_batch(
            "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (1, 'from v2', 1, 2);",
        )
        .unwrap();
    }
    let v3_root = dir.join("v3");
    let db = v3_root.join("alexia.db");
    drop(Store::open(&db).unwrap());
    encrypt::encrypt(&db).unwrap();

    let store = Store::open(&db).unwrap();
    import_v2(&store, &v2_root, &Layout::new(v3_root.clone())).unwrap();
    let sessions = store.sessions().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].title.as_deref(), Some("from v2"));
    assert!(Store::is_encrypted(&db).unwrap());
    assert!(!Store::is_encrypted(&v2_root.join("alexia.db")).unwrap());
}

#[test]
fn unencrypted_store_still_opens_without_key() {
    let (_g, dir) = setup("plain");
    let db = dir.join("alexia.db");
    plain_store(&db);
    let store = Store::open(&db).unwrap();
    assert_eq!(store.sessions().unwrap().len(), 1);
    drop(store);
    assert!(!Store::is_encrypted(&db).unwrap());
    assert!(contains(&fs::read(&db).unwrap(), "SQLite format 3"));
    assert!(!Store::is_encrypted(&dir.join("missing.db")).unwrap());
}

const EXISTS: &str = "A database key already exists, so the database was not encrypted again.";

fn keyed(db: &Path) -> PathBuf {
    PathBuf::from(format!("{}.keyed", db.display()))
}

fn leftover(db: &Path) -> PathBuf {
    PathBuf::from(format!("{}.plain", db.display()))
}

#[test]
fn interrupted_encrypt_finishes() {
    let (_g, dir) = setup("resume");
    let db = dir.join("alexia.db");
    plain_store(&db);
    // A crash after the key was stored and before the swap: key and marker, plain file.
    let key = "ef".repeat(32);
    secrets::set("_core", "store_key", &key).unwrap();
    fs::write(keyed(&db), "meant to be encrypted\n").unwrap();
    // It still opens, plain, as it is.
    assert_eq!(Store::open(&db).unwrap().sessions().unwrap().len(), 1);
    assert!(!Store::is_encrypted(&db).unwrap());

    encrypt::encrypt(&db).unwrap();
    assert!(Store::is_encrypted(&db).unwrap());
    assert_eq!(secrets::get("_core", "store_key").unwrap(), Some(key));
    assert!(!contains(&fs::read(&db).unwrap(), MARKER));
    let store = Store::open(&db).unwrap();
    assert_eq!(store.sessions().unwrap()[0].title.as_deref(), Some(MARKER));
}

#[test]
fn interrupted_encrypt_with_bad_key_refuses() {
    let (_g, dir) = setup("resume-bad");
    let db = dir.join("alexia.db");
    plain_store(&db);
    secrets::set("_core", "store_key", "not hex").unwrap();
    fs::write(keyed(&db), "meant to be encrypted\n").unwrap();
    assert_eq!(refusal(encrypt::encrypt(&db)), EXISTS);
    assert!(!Store::is_encrypted(&db).unwrap());
    assert_eq!(
        secrets::get("_core", "store_key").unwrap().as_deref(),
        Some("not hex")
    );
}

#[test]
fn resume_that_fails_keeps_the_key() {
    let (_g, dir) = setup("resume-open");
    let db = dir.join("alexia.db");
    plain_store(&db);
    let key = "ef".repeat(32);
    secrets::set("_core", "store_key", &key).unwrap();
    fs::write(keyed(&db), "meant to be encrypted\n").unwrap();
    let hub = Store::open(&db).unwrap();
    refusal(encrypt::encrypt(&db));
    drop(hub);
    assert_eq!(secrets::get("_core", "store_key").unwrap(), Some(key));
    assert!(keyed(&db).exists(), "the marker stays with the owner's key");
    encrypt::encrypt(&db).unwrap();
    assert!(Store::is_encrypted(&db).unwrap());
}

#[test]
fn stored_key_without_marker_still_refuses() {
    let (_g, dir) = setup("nomarker");
    let db = dir.join("alexia.db");
    plain_store(&db);
    let key = "cd".repeat(32);
    secrets::set("_core", "store_key", &key).unwrap();
    assert!(!keyed(&db).exists());
    assert_eq!(refusal(encrypt::encrypt(&db)), EXISTS);
    assert!(!Store::is_encrypted(&db).unwrap());
    assert_eq!(secrets::get("_core", "store_key").unwrap(), Some(key));
    assert!(!keyed(&db).exists());
}

#[test]
fn plain_leftover_shredded_on_open() {
    let (_g, dir) = setup("leftover-open");
    let db = dir.join("alexia.db");
    plain_store(&db);
    // Keep the plain bytes, as a crash between swap and shred would.
    let plain_bytes = fs::read(&db).unwrap();
    encrypt::encrypt(&db).unwrap();
    fs::write(leftover(&db), &plain_bytes).unwrap();
    let wal = PathBuf::from(format!("{}-wal", leftover(&db).display()));
    fs::write(&wal, MARKER).unwrap();

    let store = Store::open(&db).unwrap();
    assert_eq!(store.sessions().unwrap().len(), 1);
    assert!(!leftover(&db).exists());
    assert!(!wal.exists());
    for entry in fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        assert!(
            !contains(&fs::read(&path).unwrap(), MARKER),
            "{} holds plain text",
            path.display()
        );
    }
}

#[test]
fn plain_leftover_kept_while_key_is_missing() {
    let (_g, dir) = setup("leftover-nokey");
    let db = dir.join("alexia.db");
    plain_store(&db);
    let plain_bytes = fs::read(&db).unwrap();
    encrypt::encrypt(&db).unwrap();
    fs::write(leftover(&db), &plain_bytes).unwrap();
    secrets::delete("_core", "store_key").unwrap();
    assert_eq!(refusal(Store::open(&db)), MISSING);
    assert!(
        leftover(&db).exists(),
        "the only readable copy is not shredded"
    );
}

#[test]
fn plain_leftover_shredded_when_encrypt_refuses() {
    let (_g, dir) = setup("leftover-encrypt");
    let db = dir.join("alexia.db");
    plain_store(&db);
    let plain_bytes = fs::read(&db).unwrap();
    encrypt::encrypt(&db).unwrap();
    fs::write(leftover(&db), &plain_bytes).unwrap();
    assert_eq!(
        refusal(encrypt::encrypt(&db)),
        "The database is already encrypted."
    );
    assert!(!leftover(&db).exists());
}

/// Puts the memory backend back and clears the key override, even when the test panics.
struct EnvBack;
impl Drop for EnvBack {
    fn drop(&mut self) {
        std::env::remove_var(secrets::env_name("_core", "store_key"));
        std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
    }
}

#[test]
fn new_store_reads_no_keychain() {
    let (_g, dir) = setup("fresh");
    let _back = EnvBack;
    // The real keychain backend, with the key in the environment override: `secrets::get` returns
    // it without reaching Credential Manager, and a new store that read it would be encrypted.
    std::env::remove_var(secrets::MEMORY_BACKEND_ENV);
    std::env::set_var(secrets::env_name("_core", "store_key"), "ab".repeat(32));

    let db = dir.join("alexia.db");
    let store = Store::open(&db).unwrap();
    store.create_session(Some("new")).unwrap();
    drop(store);
    assert!(
        !Store::is_encrypted(&db).unwrap(),
        "no marker: plain, no key read"
    );
    assert!(!keyed(&db).exists());
    assert_eq!(Store::open(&db).unwrap().sessions().unwrap().len(), 1);

    // With the marker, a new file is keyed: the rule above is the marker, not chance.
    let other = dir.join("other.db");
    fs::write(keyed(&other), "meant to be encrypted\n").unwrap();
    drop(Store::open(&other).unwrap());
    assert!(Store::is_encrypted(&other).unwrap());
}
