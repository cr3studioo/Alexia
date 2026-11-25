// SPDX-License-Identifier: AGPL-3.0-only
//! The conversations whose pictures stay on this computer (v2 `markPrivate`), kept in kv
//! `_core`/`private_sessions`. Every route reads and writes the list here, and every change is
//! one `Store::kv_update`, so two chats marked at the same moment are both kept (P3-00, P2D
//! review L3). A private conversation never reaches the board's learned skills.

use alexia_store::{SessionId, Store};
use serde_json::{json, Value};

const CORE: &str = "_core";
/// kv `_core` key holding the private sessions' ids (v2).
pub(crate) const PRIVATE: &str = "private_sessions";

fn ids(v: Option<Value>) -> Vec<i64> {
    v.and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// The private sessions' ids. An unreadable value reads as empty.
pub(crate) fn sessions(store: &Store) -> Vec<i64> {
    ids(store.kv_get(CORE, PRIVATE).ok().flatten())
}

pub(crate) fn is_private(store: &Store, session: SessionId) -> bool {
    sessions(store).contains(&session.0)
}

/// Marks `session` private. Idempotent; marking is permanent (v2), only `forget` removes an id.
pub(crate) fn mark(store: &Store, session: SessionId) -> crate::Result<()> {
    store.kv_update(CORE, PRIVATE, |now| {
        let mut list = ids(now);
        if !list.contains(&session.0) {
            list.push(session.0);
        }
        Some(json!(list))
    })?;
    Ok(())
}

/// The conversation was deleted: its id leaves the list.
pub(crate) fn forget(store: &Store, session: SessionId) -> crate::Result<()> {
    store.kv_update(CORE, PRIVATE, |now| {
        let list: Vec<i64> = ids(now).into_iter().filter(|s| *s != session.0).collect();
        Some(json!(list))
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn marking_two_sessions_at_once_keeps_both() {
        for _ in 0..20 {
            let store = Arc::new(Store::open_in_memory().unwrap());
            let a = {
                let s = store.clone();
                std::thread::spawn(move || mark(&s, SessionId(1)).unwrap())
            };
            let b = {
                let s = store.clone();
                std::thread::spawn(move || mark(&s, SessionId(2)).unwrap())
            };
            a.join().unwrap();
            b.join().unwrap();
            let mut got = sessions(&store);
            got.sort_unstable();
            assert_eq!(got, vec![1, 2]);
        }
    }

    #[test]
    fn board_and_chat_agree() {
        // The chat route marks, the board and learned skills read: one module, one list.
        let store = Store::open_in_memory().unwrap();
        assert!(!is_private(&store, SessionId(7)));
        mark(&store, SessionId(7)).unwrap();
        mark(&store, SessionId(7)).unwrap();
        assert!(is_private(&store, SessionId(7)));
        assert_eq!(sessions(&store), vec![7]);
        forget(&store, SessionId(7)).unwrap();
        assert!(!is_private(&store, SessionId(7)));
    }

    #[test]
    fn unreadable_reads_as_empty() {
        let store = Store::open_in_memory().unwrap();
        store.kv_set(CORE, PRIVATE, &json!("nonsense")).unwrap();
        assert!(sessions(&store).is_empty());
        mark(&store, SessionId(3)).unwrap();
        assert_eq!(sessions(&store), vec![3]);
    }
}
