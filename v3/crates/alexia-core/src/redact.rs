// SPDX-License-Identifier: AGPL-3.0-only
//! Redaction before anything goes to a cloud model (TR-04, TR-03).
//!
//! A port of v2 `packages/core/src/redact.ts`, row for row. The policy is v2's and the owner's:
//! credentials and env values always go, anything saying *where he is* always goes, everything
//! else about him is allowed on purpose. Do not broaden it. Financial shapes (IBAN, card runs)
//! are deliberately absent, as in v2: its `redactText` carries secrets and locations only.
//!
//! The ceiling is stated, not hidden: these are regexes, they are narrow, and they will miss a
//! credential shape nobody has seen yet. The upgrade path is another row.
//!
//! `regex` has no look-around, so two v2 rows are restated without it (marked below); each
//! matches the same text.

use std::collections::HashSet;
use std::sync::LazyLock;

use alexia_store::{Content, MessageBody, Part};
use regex::{Captures, Regex};
use serde_json::Value;

use crate::ChatRequest;

pub const PLACEHOLDER: &str = "[redacted]";

/// What a row keeps of its match.
#[derive(Clone, Copy)]
enum Keep {
    /// The whole match goes.
    Nothing,
    /// Group 1 is a JSON key and its opening quote; the value goes, the closing quote stays.
    Key,
    /// Group 1 is trailing context that only qualifies the match (v2 used a look-ahead).
    After,
}

struct Rule {
    kind: &'static str,
    re: Regex,
    keep: Keep,
}

fn rule(kind: &'static str, pattern: &str, keep: Keep) -> Rule {
    Rule {
        kind,
        re: Regex::new(pattern).expect("redaction pattern"),
        keep,
    }
}

/// The words that make a name a secret's name: the "env assignment" row, and `SECRET_KEY` for
/// the same reading of a parsed JSON key, are both built from this one list.
const SECRET_WORDS: &str = "api[_-]?key|secret|token|password|passwd|bearer|credential";

/// v2 `SECRETS`: credential shapes.
static SECRETS: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    vec![
        // sk-, and every vendor that prefixes it: sk-ant-, sk-or-v1-.
        rule("api key", r"\bsk-[A-Za-z0-9_-]{16,}\b", Keep::Nothing),
        rule(
            "github token",
            r"\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b",
            Keep::Nothing,
        ),
        rule("aws key", r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b", Keep::Nothing),
        // Real Google keys are AIza plus 35; near-miss shapes are caught too.
        rule("google key", r"\bAIza[A-Za-z0-9_-]{30,}", Keep::Nothing),
        rule(
            "slack token",
            r"\bxox[abposr]-[A-Za-z0-9-]{10,}\b",
            Keep::Nothing,
        ),
        rule(
            "telegram token",
            r"\b[0-9]{8,12}:[A-Za-z0-9_-]{30,}\b",
            Keep::Nothing,
        ),
        rule(
            "private key",
            r"-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----",
            Keep::Nothing,
        ),
        rule(
            "jwt",
            r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
            Keep::Nothing,
        ),
        // A secret-named variable being assigned a non-trivial value. No leading `\b`: `_` is a
        // word character, so there is no boundary inside OPENROUTER_API_KEY. The keyword may
        // sit in the middle (AWS_SECRET_ACCESS_KEY=...). Over-matching is the safe direction.
        rule(
            "env assignment",
            &format!(
                r#"(?i)[A-Za-z0-9_.-]*(?:{SECRET_WORDS})[A-Za-z0-9_.-]*\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{{12,}}"#
            ),
            Keep::Nothing,
        ),
        // A URL carrying credentials: scheme://user:password@host. (TR-04; not a v2 row.)
        rule(
            "url credentials",
            r"\b[A-Za-z][A-Za-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@\S+",
            Keep::Nothing,
        ),
    ]
});

/// v2 `LOCATIONS`: anything saying where he is. City level stays.
static LOCATIONS: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    vec![
        rule(
            "gps",
            r"[-+]?[0-9]{1,3}\.[0-9]{3,}\s*[,;]\s*[-+]?[0-9]{1,3}\.[0-9]{3,}",
            Keep::Nothing,
        ),
        // A postcode before a city that makes it one. v2 used a look-ahead; here the city
        // context is group 1 and is put back.
        rule(
            "postcode",
            r"(?i)\b[0-9]{3}\s?[0-9]{2}\b([^\n]{0,40}\b(?:praha|prague|brno|ostrava|plzen|plzeň|berlin|dresden)\b)",
            Keep::After,
        ),
        rule(
            "postcode",
            r"(?i)\b(?:praha|prague|brno|ostrava|berlin|dresden)\b[^\n]{0,20}\b[0-9]{3}\s?[0-9]{2}\b",
            Keep::Nothing,
        ),
        // Czech and Slovak street forms.
        rule(
            "street",
            r"(?i)\b(?:ulice|ul\.|nám(?:\.|ěstí)?|nam\.?|třída|trida|nábř\.?)\s+[A-ZÁ-Ž][\wÀ-ſ.\- ]{1,30}\s+[0-9]+[a-z]?\b",
            Keep::Nothing,
        ),
        // German: "Hauptstraße 12", "Bahnhofstr. 4".
        rule(
            "street",
            r"(?i)\b[A-ZÄÖÜ][\wÀ-ſ-]{2,30}(?:straße|strasse|str\.)\s*[0-9]+[a-z]?\b",
            Keep::Nothing,
        ),
        // Anglo: "12 Baker Street", "5 Mill Rd.". v2 ended with `\.?(?!\w)`; `\b\.?` is the
        // look-around-free reading (nothing word-like may follow the street word).
        rule(
            "street",
            r"(?i)\b[0-9]{1,4}[a-z]?\s+[A-Z][\w-]{1,25}\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|square|sq)\b\.?",
            Keep::Nothing,
        ),
        rule(
            "map link",
            r"https?://(?:www\.)?(?:maps\.google\.\w+|goo\.gl/maps|maps\.app\.goo\.gl)/\S+",
            Keep::Nothing,
        ),
        rule("what3words", r"///[a-z]+\.[a-z]+\.[a-z]+\b", Keep::Nothing),
        // Fields that are a location by definition, in the JSON a tool result arrives as: the
        // value goes whole, the key stays.
        rule(
            "location field",
            r#"(?i)("(?:location|address|street|venue|place|where|geo|coordinates|coords|lat|lng|lon|latitude|longitude|postcode|postal_code|zip|zipcode|formatted_address)"\s*:\s*")[^"\\]{1,200}""#,
            Keep::Key,
        ),
    ]
});

fn apply<'a>(
    rules: impl IntoIterator<Item = &'a Rule>,
    text: &str,
    extra: &[String],
) -> (String, Vec<String>) {
    let mut kinds = Vec::new();
    // Known secret values first, longest first, so one that contains another goes whole.
    let mut out = text.to_string();
    let mut known: Vec<&String> = extra.iter().filter(|s| !s.is_empty()).collect();
    known.sort_by_key(|s| std::cmp::Reverse(s.len()));
    for secret in known {
        if out.contains(secret.as_str()) {
            out = out.replace(secret.as_str(), PLACEHOLDER);
            kinds.push("known secret".to_string());
        }
    }
    for r in rules {
        // Keep::After writes its context back unredacted, so a second postcode inside it
        // needs another pass: repeat until the text stops changing (each pass removes one).
        loop {
            let next =
                r.re.replace_all(&out, |c: &Captures| {
                    kinds.push(r.kind.to_string());
                    match (r.keep, c.get(1)) {
                        (Keep::Key, Some(k)) => format!("{}{PLACEHOLDER}\"", k.as_str()),
                        (Keep::After, Some(k)) => format!("{PLACEHOLDER}{}", k.as_str()),
                        _ => PLACEHOLDER.to_string(),
                    }
                })
                .into_owned();
            let again = matches!(r.keep, Keep::After) && next != out;
            out = next;
            if !again {
                break;
            }
        }
    }
    (out, kinds)
}

/// Secret-shaped strings only (keys, tokens, private keys, URLs with credentials).
pub fn redact_secrets(text: &str) -> (String, Vec<String>) {
    apply(SECRETS.iter(), text, &[])
}

/// Secrets plus v2's `redactText` location rules. What `redactText` is in v2: credentials and
/// where he is; financial shapes are deliberately not here (see the module note).
pub fn redact_text(text: &str) -> (String, Vec<String>) {
    redact_known(text, &[])
}

/// `redact_text`, plus every value in `extra` (keys currently in the keychain). The values are
/// matched, never logged and never reported: `kinds` says only "known secret".
pub fn redact_known(text: &str, extra: &[String]) -> (String, Vec<String>) {
    apply(SECRETS.iter().chain(LOCATIONS.iter()), text, extra)
}

static LOCATION_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:location|address|street|venue|place|where|geo|coordinates|coords|lat|lng|lon|latitude|longitude|postcode|postal_code|zip|zipcode|formatted_address)$")
        .expect("location key pattern")
});

/// The parsed-JSON reading of the "env assignment" row, as `LOCATION_KEY` is of "location
/// field": a key naming a secret anywhere in it. v2 matched `"password":"…"` in raw text.
static SECRET_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("(?i)(?:{SECRET_WORDS})")).expect("secret key pattern"));

/// A number pair that the "gps" rule would match as `a,b` text, as v2 saw it in the raw JSON.
fn is_coord_pair(a: &Value, b: &Value) -> bool {
    static GPS: LazyLock<&'static Rule> = LazyLock::new(|| {
        LOCATIONS
            .iter()
            .find(|r| r.kind == "gps")
            .expect("gps rule")
    });
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => GPS.re.is_match(&format!("{a},{b}")),
        _ => false,
    }
}

fn walk(v: &Value, known: &[String], kinds: &mut Vec<String>) -> Value {
    match v {
        Value::String(s) => {
            let (t, k) = redact_known(s, known);
            kinds.extend(k);
            Value::String(t)
        }
        Value::Array(a) => {
            let mut out = Vec::with_capacity(a.len());
            let mut i = 0;
            while i < a.len() {
                // Numbers carry no text for the gps rule to see; an adjacent pair is checked
                // as the `a,b` it was in v2's raw arguments.
                if i + 1 < a.len() && is_coord_pair(&a[i], &a[i + 1]) {
                    kinds.push("gps".to_string());
                    out.push(Value::String(PLACEHOLDER.to_string()));
                    out.push(Value::String(PLACEHOLDER.to_string()));
                    i += 2;
                } else {
                    out.push(walk(&a[i], known, kinds));
                    i += 1;
                }
            }
            Value::Array(out)
        }
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| match x {
                    // The "location field" rule matches `"key":"value"` text, which a parsed
                    // leaf no longer has; so the key decides here (same key list as the rule).
                    // Any non-null value goes whole: numbers, arrays and objects too.
                    Value::Null => (k.clone(), Value::Null),
                    _ if LOCATION_KEY.is_match(k) => {
                        kinds.push("location field".to_string());
                        (k.clone(), Value::String(PLACEHOLDER.to_string()))
                    }
                    // Same length floor as the row: shorter strings, numbers and booleans are
                    // walked as usual, and so are arrays and objects under such a key.
                    Value::String(s) if s.chars().count() >= 12 && SECRET_KEY.is_match(k) => {
                        kinds.push("secret field".to_string());
                        (k.clone(), Value::String(PLACEHOLDER.to_string()))
                    }
                    _ => (k.clone(), walk(x, known, kinds)),
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Every string leaf through `redact_text`; location-keyed values, a secret-named key's string
/// value of 12 or more characters, and coordinate pairs whole.
pub fn redact_json(v: &Value) -> Value {
    walk(v, &[], &mut Vec::new())
}

/// Tool-call arguments are JSON text. Valid JSON: redact it by walking, and re-serialise
/// only if something went (so untouched arguments stay byte for byte). Not JSON: redact as text.
fn redact_arguments(args: &str, known: &[String], kinds: &mut Vec<String>) -> String {
    match serde_json::from_str::<Value>(args) {
        Ok(v) => {
            let mut found = Vec::new();
            let out = walk(&v, known, &mut found);
            if found.is_empty() {
                return args.to_string();
            }
            kinds.extend(found);
            out.to_string()
        }
        Err(_) => {
            let (t, k) = redact_known(args, known);
            kinds.extend(k);
            t
        }
    }
}

fn redact_body(body: &MessageBody, known: &[String], kinds: &mut Vec<String>) -> MessageBody {
    let mut out = body.clone();
    let mut text = |s: &str| {
        let (t, k) = redact_known(s, known);
        kinds.extend(k);
        t
    };
    out.content = match &body.content {
        Content::Text(t) => Content::Text(text(t)),
        Content::Parts(parts) => Content::Parts(
            parts
                .iter()
                .map(|p| match p {
                    Part::Text { text: t } => Part::Text { text: text(t) },
                    // A picture is never read, only passed on (the ceiling v2 states).
                    Part::Image { url } => Part::Image { url: url.clone() },
                })
                .collect(),
        ),
    };
    if let Some(calls) = &mut out.calls {
        for call in calls {
            call.arguments = redact_arguments(&call.arguments, known, kinds);
        }
    }
    out
}

/// Every text part of every message and the system prompt; images untouched. `kinds` deduped.
pub fn redact_request(req: &ChatRequest) -> (ChatRequest, Vec<String>) {
    redact_request_known(req, &[])
}

/// `redact_request`, plus every value in `known` (keychain secrets) wherever it looks.
pub fn redact_request_known(req: &ChatRequest, known: &[String]) -> (ChatRequest, Vec<String>) {
    let mut kinds = Vec::new();
    let mut out = req.clone();
    out.messages = req
        .messages
        .iter()
        .map(|(role, body)| (*role, redact_body(body, known, &mut kinds)))
        .collect();
    if let Some(system) = &req.system {
        let (t, k) = redact_known(system, known);
        kinds.extend(k);
        out.system = Some(t);
    }
    let mut seen = HashSet::new();
    kinds.retain(|k| seen.insert(k.clone()));
    (out, kinds)
}

/// `api key×1, street×2`: what went, never the values. Sorted by kind.
pub fn summarise(kinds: &[String]) -> String {
    let mut counts: std::collections::BTreeMap<&str, usize> = Default::default();
    for k in kinds {
        *counts.entry(k.as_str()).or_default() += 1;
    }
    counts
        .into_iter()
        .map(|(k, n)| format!("{k}×{n}"))
        .collect::<Vec<_>>()
        .join(", ")
}
