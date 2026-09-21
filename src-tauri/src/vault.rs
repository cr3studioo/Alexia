// SPDX-License-Identifier: AGPL-3.0-only

//! Custody of secrets (D153) — the one thing in this crate that is not a Tauri plugin, and
//! the one thing core cannot do for itself.
//!
//! **Why it is not behind the port like everything else.** The macOS keychain decides who
//! may read an entry by asking which *program* is calling, and it cannot see past a program
//! to the script it runs. Core is Node, so an entry core creates is readable by anything
//! Node will run: measured on 2026-09-15, a two-line script handed to `alexia-core` from a
//! terminal read a real OpenRouter key with no prompt. Every plugin is started with that
//! same binary, so every plugin could too. This process runs no scripts, so an entry it
//! creates answers to it alone.
//!
//! **The shape.** A loopback port and a token. The token goes to core down its stdin, which
//! no other process can read; every request carries it, and one without it is refused. Get,
//! set and delete, by name — **no listing**, so not even core can ask what else is in there.
//!
//! What is **not** here: deciding anything. Which entry, when, and what it is for are core's.
//! This reads or writes the one it is named and says what happened.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

/// The app's own identifier, and deliberately **not** `alexia`, which is what core used when
/// it held the keychain itself. An entry under that name may still be one Node created, and
/// reading it from here would always put a keychain prompt in front of somebody, where core —
/// whose program it trusts — can usually move it without one. `custody()` in `secrets.ts`.
const SERVICE: &str = "dev.alexia.app";

#[derive(Deserialize)]
struct Ask {
    token: String,
    op: String,
    account: String,
    secret: Option<String>,
}

/// Open the vault and return the one line core reads off its stdin to find it.
pub fn open() -> std::io::Result<String> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| std::io::Error::other(error.to_string()))?;
    let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let line = format!("{}\n", json!({ "port": port, "token": token }));

    // Each connection is read on a thread of its own, so one that connects and dribbles holds
    // only itself: the port is reachable by every process on the machine, and a single thread
    // reading them in turn could be held shut by any of them, a byte every few seconds. Each
    // thread lives five seconds at most (`serve`), so there is no pile of them to cap.
    let token = Arc::new(token);
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let token = Arc::clone(&token);
            thread::spawn(move || serve(stream, &token));
        }
    });
    Ok(line)
}

/// The keychain, one call at a time. A call takes milliseconds, and the one that does not is a
/// prompt waiting on a person, which nothing else should be answered around either.
static KEYCHAIN: Mutex<()> = Mutex::new(());

fn serve(mut stream: TcpStream, token: &str) {
    // Five seconds for the **whole** request, not for each read: a client that sends a byte
    // every four would otherwise never time out.
    let until = Instant::now() + Duration::from_secs(5);
    let (mut line, mut chunk) = (Vec::new(), [0u8; 4096]);
    while !line.contains(&b'\n') {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() || line.len() > 64 * 1024 || stream.set_read_timeout(Some(left)).is_err() {
            return;
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(read) => line.extend_from_slice(&chunk[..read]),
        }
    }
    let said = answer(&String::from_utf8_lossy(&line), token);
    let _ = stream.write_all(format!("{said}\n").as_bytes());
}

fn answer(line: &str, token: &str) -> Value {
    let Ok(ask) = serde_json::from_str::<Ask>(line) else {
        return json!({ "error": "not a request" });
    };
    if !same(ask.token.as_bytes(), token.as_bytes()) {
        return json!({ "error": "refused" });
    }
    let _one = KEYCHAIN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = match keyring::Entry::new(SERVICE, &ask.account) {
        Ok(entry) => entry,
        Err(error) => return json!({ "error": error.to_string() }),
    };
    let done = match (ask.op.as_str(), ask.secret) {
        ("get", _) => entry.get_password().map(Some),
        ("set", Some(secret)) => entry.set_password(&secret).map(|()| None),
        ("delete", _) => entry.delete_credential().map(|()| None),
        _ => return json!({ "error": "not an operation" }),
    };
    match done {
        Ok(secret) => json!({ "ok": true, "secret": secret }),
        // Nothing there is an answer, not a failure: most declared passwords were never filled
        // in, and purge deletes every one of them.
        Err(keyring::Error::NoEntry) => json!({ "ok": true, "secret": null }),
        Err(error) => json!({ "error": error.to_string() }),
    }
}

/// Equal, in a time that does not depend on where two tokens first differ.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |differ, (x, y)| differ | (x ^ y)) == 0
}
