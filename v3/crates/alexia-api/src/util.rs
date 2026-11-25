// SPDX-License-Identifier: AGPL-3.0-only
//! Helpers the area modules share. Each lives here once; a module that needs one calls
//! `util::` rather than keeping its own copy.

use std::sync::{Mutex, MutexGuard};

use serde_json::{json, Value};

use crate::Api;

/// The store namespace the hub's own settings live in.
pub(crate) const CORE: &str = "_core";

/// A poisoned mutex is recovered with `into_inner`.
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// kv in the `_core` namespace; a read error is logged and answers None.
pub(crate) fn kv(api: &Api, key: &str) -> Option<Value> {
    match api.parts.store.kv_get(CORE, key) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("_core.{key} could not be read: {e}");
            None
        }
    }
}

/// v2 `safeName`: a name that cannot escape the folder it is written to.
pub(crate) fn safe_name(name: &str) -> String {
    const FORBIDDEN: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let unified = name.replace('\\', "/");
    let last = unified.rsplit('/').next().unwrap_or("");
    let bare: String = last
        .chars()
        .filter(|c| (*c as u32) > 31 && !FORBIDDEN.contains(c))
        .collect();
    let bare = bare.trim_start_matches('.').trim();
    let chars: Vec<char> = bare.chars().collect();
    let kept: String = chars[chars.len().saturating_sub(120)..].iter().collect();
    if kept.is_empty() {
        "attachment".into()
    } else {
        kept
    }
}

/// A size in whole megabytes, never below 1 MB.
pub(crate) fn megabytes(bytes: usize) -> String {
    let mb = (bytes as f64 / (1024.0 * 1024.0)).round().max(1.0);
    format!("{mb} MB")
}

/// v2 `offered.ts` `TYPES`.
pub(crate) fn mime_of(name: &str) -> &'static str {
    match extension(name).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "xml" => "application/xml",
        "html" => "text/html",
        "zip" => "application/zip",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

/// v2 `extname(name).slice(1).toLowerCase()`: the text after the last dot of the last
/// segment, empty for none or for a name that only starts with a dot.
pub(crate) fn extension(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match last.rfind('.') {
        Some(i) if i > 0 => last[i + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// JavaScript's `String(value)` for the values a command's `type` can hold. This is the
/// gate's copy (the `guard.ts` port): a refusal must read a value as v2 does.
pub(crate) fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        // `String(["a", "b"])` is "a,b"; null and undefined items are empty.
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| match v {
                Value::Null => String::new(),
                v => js_string(Some(v)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// The hub's enabled list, kv `_core`/`enabled`: every enabled id.
pub(crate) fn persist_enabled(api: &Api) -> Result<(), alexia_store::Error> {
    let mut on: Vec<String> = api
        .parts
        .host
        .plugins()
        .into_iter()
        .filter(|p| p.enabled)
        .map(|p| p.id.0)
        .collect();
    on.sort();
    api.parts.store.kv_set(CORE, "enabled", &json!(on))
}

/// v2 `adultMode`: the person confirmed 18+ in Settings and `/nsfw` is on.
pub(crate) fn adult_on(api: &Api) -> bool {
    let confirmed =
        kv(api, "adult").is_some_and(|v| v.get("confirmedAt").is_some_and(Value::is_number));
    let on = kv(api, "pins").is_some_and(|v| v.get("uncensored") == Some(&Value::Bool(true)));
    confirmed && on
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_string_matches_gate() {
        assert_eq!(js_string(None), "undefined");
        assert_eq!(js_string(Some(&Value::Null)), "null");
        let one_point_zero: Value = serde_json::from_str("1.0").unwrap();
        assert_eq!(js_string(Some(&one_point_zero)), "1.0");
        assert_eq!(js_string(Some(&json!(1))), "1");
        assert_eq!(js_string(Some(&json!(true))), "true");
        assert_eq!(js_string(Some(&json!(["a", null, 1]))), "a,,1");
        assert_eq!(js_string(Some(&json!({}))), "[object Object]");
    }

    #[test]
    fn safe_name_strips_paths() {
        assert_eq!(safe_name(r"..\..\evil.txt"), "evil.txt");
        assert_eq!(safe_name("a/b/c.png"), "c.png");
        assert_eq!(safe_name(".hidden"), "hidden");
        assert_eq!(safe_name(""), "attachment");
        assert_eq!(safe_name("///"), "attachment");
        assert_eq!(safe_name(&"x".repeat(300)).chars().count(), 120);
    }

    #[test]
    fn megabytes_is_at_least_one() {
        assert_eq!(megabytes(0), "1 MB");
        assert_eq!(megabytes(10), "1 MB");
        assert_eq!(megabytes(5 * 1024 * 1024), "5 MB");
    }

    #[test]
    fn mime_of_known_and_unknown() {
        assert_eq!(mime_of("A.PNG"), "image/png");
        assert_eq!(mime_of("dir/pic.svg"), "image/svg+xml");
        assert_eq!(mime_of("x.unknown"), "application/octet-stream");
        assert_eq!(mime_of(".png"), "application/octet-stream");
        assert_eq!(mime_of("noext"), "application/octet-stream");
    }

    #[test]
    fn lock_recovers_a_poisoned_mutex() {
        let m = std::sync::Arc::new(Mutex::new(7));
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(m.is_poisoned());
        assert_eq!(*lock(&m), 7);
    }
}
