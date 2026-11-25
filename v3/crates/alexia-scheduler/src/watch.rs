// SPDX-License-Identifier: AGPL-3.0-only
//! Watches (PR-16, P3-07): a job whose trigger is `Watch` asks a capability on its own schedule
//! and fires only when the answer changed. The first answer is only recorded. The hash of the
//! last answer is kept in kv `_core`/`watch.<job id>`; the watched text itself is the owner's
//! data and is never logged.

use alexia_store::Store;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::Sources;

/// The least time between two polls of one watch.
pub const FLOOR_MS: u64 = 60_000;
/// How much of the new text a fired job is given.
const SHOWN: usize = 4000;

fn key(job: i64) -> String {
    format!("watch.{job}")
}

fn hash(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Polls `cap` for job `job`. `Some(text)` when the answer changed since the last poll (the
/// new hash is stored); `None` on the first poll (recorded), on no change, and on an error
/// (nothing changes).
pub(crate) async fn changed(
    store: &Store,
    sources: &dyn Sources,
    job: i64,
    cap: &str,
    args: Map<String, Value>,
) -> Option<String> {
    let text = sources.poll(cap, args).await?;
    let now = hash(&text);
    let before = match store.kv_get("_core", &key(job)) {
        Ok(v) => v.and_then(|v| v.as_str().map(str::to_owned)),
        Err(e) => {
            tracing::warn!(job, "a watch's last answer could not be read: {e}");
            return None;
        }
    };
    if before.as_deref() == Some(now.as_str()) {
        return None;
    }
    if let Err(e) = store.kv_set("_core", &key(job), &json!(now)) {
        tracing::warn!(job, "a watch's answer could not be recorded: {e}");
        return None;
    }
    before.map(|_| text)
}

/// The prompt a fired watch runs: the job's own words, then what changed.
pub(crate) fn prompt(job_prompt: &str, text: &str) -> String {
    let shown: String = text.chars().take(SHOWN).collect();
    format!("{job_prompt}\n\nWhat changed:\n{shown}")
}

/// Forgets a cancelled watch's last answer.
pub(crate) fn forget(store: &Store, job: i64) {
    let _ = store.kv_delete("_core", &key(job));
}
