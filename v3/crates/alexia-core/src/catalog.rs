// SPDX-License-Identifier: AGPL-3.0-only
//! P1-05: the free chat catalog (MO-04, D212).
//!
//! Every usable provider's model list, filtered to free text-chat models, refreshed at start and
//! every six hours (v2 D161), and cached to disk so the hub can route the moment it boots and
//! while a list endpoint is down. v2: `packages/core/src/catalog.ts`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alexia_store::Ms;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::free::{Auth, FreeRow};
use crate::{ModelInfo, Provider, ProviderError};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Candidate {
    pub provider: String,
    pub model: String,
    pub context: u32,
    /// A size in billions read from the id, v2 `sizeOf`.
    pub size_b: Option<f32>,
    pub router: bool,
}

#[derive(Serialize, Deserialize)]
struct CacheFile {
    fetched_at: Ms,
    candidates: Vec<Candidate>,
}

pub struct Catalog {
    providers: Vec<Arc<dyn Provider>>,
    rows: Vec<FreeRow>,
    cache: PathBuf,
    /// What the lists said (or the cache), in provider order. The seed is added on read.
    fetched: RwLock<Vec<Candidate>>,
    /// Each provider's last `models()` answer: true = it answered, false = it has no key or its
    /// key was refused. Absent = not asked yet, or down. Decides whether its seed is offered.
    answered: RwLock<HashMap<String, bool>>,
}

impl Catalog {
    pub const REFRESH_MS: u64 = 6 * 60 * 60 * 1000;

    /// Loads `cache` if it exists (a missing or unreadable file is an empty catalog, not an error).
    pub fn new(providers: Vec<Arc<dyn Provider>>, rows: Vec<FreeRow>, cache: PathBuf) -> Catalog {
        let fetched = std::fs::read(&cache)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<CacheFile>(&bytes).ok())
            .map(|file| file.candidates)
            .unwrap_or_default();
        Catalog {
            providers,
            rows,
            cache,
            fetched: RwLock::new(fetched),
            answered: RwLock::default(),
        }
    }

    /// Fetch every usable provider's list now; a provider that fails keeps its cached entries.
    /// Writes the cache atomically (temp file + rename).
    pub async fn refresh(&self) {
        let mut set = tokio::task::JoinSet::new();
        for (at, provider) in self.providers.iter().enumerate() {
            let Some(row) = self.row(provider.id()) else {
                continue;
            };
            let provider = provider.clone();
            set.spawn(async move { (at, row, provider.models().await) });
        }
        let mut answers: Vec<Option<Answer>> = vec![None; self.providers.len()];
        while let Some(done) = set.join_next().await {
            let Ok((at, row, result)) = done else {
                continue; // A provider that panicked keeps what it had, like one that failed.
            };
            answers[at] = Some(match result {
                // An empty list is a shape change, not a world with no models in it (v2 `refresh`).
                Ok(models) if !models.is_empty() => Answer::List(listed(&row, &models)),
                // No key, or the stored key refused (401/403): the row is not usable, so nothing
                // of it is a candidate any more.
                Err(ProviderError::NeedsKey | ProviderError::Refused(_)) => Answer::Unusable,
                Ok(_) => Answer::Answered,
                Err(_) => Answer::Kept,
            });
        }

        let next = {
            let old = self.fetched.read().unwrap_or_else(|e| e.into_inner());
            let mut next = Vec::with_capacity(old.len());
            for (provider, answer) in self.providers.iter().zip(&answers) {
                match answer {
                    Some(Answer::List(list)) => next.extend(list.iter().cloned()),
                    Some(Answer::Unusable) => {}
                    Some(Answer::Answered | Answer::Kept) | None => {
                        next.extend(old.iter().filter(|c| c.provider == provider.id()).cloned())
                    }
                }
            }
            next
        };
        {
            let mut answered = self.answered.write().unwrap_or_else(|e| e.into_inner());
            for (provider, answer) in self.providers.iter().zip(&answers) {
                let state = match answer {
                    Some(Answer::Unusable) => false,
                    Some(Answer::List(_) | Answer::Answered) => true,
                    // Down says nothing about the key: the last answer stands.
                    Some(Answer::Kept) | None => continue,
                };
                answered.insert(provider.id().into(), state);
            }
        }
        if let Err(e) = self.write(&next) {
            tracing::warn!("the model catalog cache could not be written: {e}");
        }
        *self.fetched.write().unwrap_or_else(|e| e.into_inner()) = next;
    }

    /// `refresh` now, then every REFRESH_MS until cancelled.
    pub async fn run(&self, cancel: CancellationToken) {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = self.refresh() => {}
            }
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = tokio::time::sleep(Duration::from_millis(Self::REFRESH_MS)) => {}
            }
        }
    }

    /// What the router may choose from: per provider, v2's written-down seed first, then the
    /// lists (or the cache) without the seeded ids (v2 `Catalog.models`: the seed wins on a
    /// clash, per provider here so a seeded id does not hide another provider's row). A seed
    /// is offered unless the provider's last answer was NeedsKey/Refused, and for a key-only
    /// row only once its `models()` has answered (it was built with a key).
    pub fn candidates(&self) -> Vec<Candidate> {
        let fetched = self.fetched.read().unwrap_or_else(|e| e.into_inner());
        let answered = self.answered.read().unwrap_or_else(|e| e.into_inner());
        let mut out = Vec::new();
        for provider in &self.providers {
            let id = provider.id();
            let Some(row) = self.row(id) else { continue };
            let state = answered.get(id).copied();
            if state != Some(false) && (row.auth != Auth::Required || state == Some(true)) {
                out.extend(seeded(&row));
            }
            out.extend(
                fetched
                    .iter()
                    .filter(|c| {
                        c.provider == id
                            && !SEEDED.iter().any(|s| (s.0, s.1) == (id, c.model.as_str()))
                    })
                    .cloned(),
            );
        }
        out
    }

    /// The ladder row for a provider id (the router reads `rpm`/`rpd` from it).
    pub fn row(&self, provider: &str) -> Option<FreeRow> {
        self.rows.iter().find(|r| r.id == provider).cloned()
    }

    fn write(&self, candidates: &[Candidate]) -> std::io::Result<()> {
        if let Some(dir) = self.cache.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let file = CacheFile {
            fetched_at: now(),
            candidates: candidates.to_vec(),
        };
        // Unique per write, so two refreshes at once never write the same temp file.
        static WRITES: AtomicU64 = AtomicU64::new(0);
        let mut tmp = self.cache.clone().into_os_string();
        tmp.push(format!(
            ".{}-{}.tmp",
            std::process::id(),
            WRITES.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&tmp, serde_json::to_vec(&file)?)?;
        std::fs::rename(&tmp, &self.cache)
    }
}

#[derive(Clone)]
enum Answer {
    List(Vec<Candidate>),
    /// Answered with an empty list: usable, but its cached entries are kept.
    Answered,
    Unusable,
    Kept,
}

/// A model is a candidate when it is free and holds a text chat (P1-05 step 2).
fn listed(row: &FreeRow, models: &[ModelInfo]) -> Vec<Candidate> {
    models
        .iter()
        .filter(|m| m.free && chats(&m.id))
        .map(|m| Candidate {
            provider: row.id.clone(),
            model: m.id.clone(),
            context: m.context,
            size_b: size_of(&m.id),
            router: row.router || routes(&m.id),
        })
        .collect()
}

fn now() -> Ms {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as Ms)
}

/// v2's `[\s/:_-]`, the separator its id regexes anchor on.
fn sep(c: char) -> bool {
    c.is_whitespace() || matches!(c, '/' | ':' | '_' | '-')
}

/// Words that name something other than a text chat: embeddings, rerankers, speech in or out,
/// image and video generators, TTS voices, and guard / moderation classifiers. OCR is matched
/// as a whole id segment below.
const NOT_CHAT: &[&str] = &[
    "bge",
    "tts",
    "stt",
    "audio",
    "speech",
    "transcribe",
    "whisper",
    "image",
    "imagen",
    "flux",
    "sdxl",
    "diffusion",
    "dall",
    "veo",
    "orpheus",
    "moderation",
    "safety",
];

/// v2's text-chat filter (`parse`: a row with `max_completion_tokens === 0` "cannot complete
/// anything"; `ollama.ts`: a model without the `completion` capability is not a chat model).
/// v3's `ModelInfo` carries neither field, so the same models are known here by the words in
/// their id, split on anything that is not a letter or digit.
pub fn chats(model_id: &str) -> bool {
    let id = model_id.to_lowercase();
    let dashed = format!(
        "-{}-",
        id.replace(|c: char| !c.is_ascii_alphanumeric(), "-")
    );
    !dashed.contains("-ocr-")
        && !id.contains("guardian")
        && !id.split(|c: char| !c.is_ascii_alphanumeric()).any(|word| {
            NOT_CHAT.contains(&word)
                || word.starts_with("embed")
                || word.starts_with("rerank")
                || word.ends_with("guard")
        })
}

/// Routers v2 knows only by their display name ("Free Models Router", "Pareto Code Router",
/// `catalog.test.ts`), which `ModelInfo` does not carry.
const NAMED_ROUTERS: &[&str] = &["openrouter/free", "openrouter/pareto-code"];

/// v2's `routes`, id half: `/(?:^|[\s/:_-])(?:auto|router)(?:$|[\s/:_-])/i`. A segment between
/// separators that is exactly `auto` or `router`.
pub fn routes(model_id: &str) -> bool {
    model_id
        .split(sep)
        .any(|s| s.eq_ignore_ascii_case("auto") || s.eq_ignore_ascii_case("router"))
        || NAMED_ROUTERS
            .iter()
            .any(|r| r.eq_ignore_ascii_case(model_id))
}

/// v2's `sizeOf`: `/(?:^|[\s/:_-])(?:(\d+)x)?e?(\d+(?:\.\d+)?)b(?=$|[\s/:_.-])/i`, first match.
/// "llama-3.3-70b" → Some(70.0); "8x7b" → Some(56.0); none → None.
pub fn size_of(model_id: &str) -> Option<f32> {
    let chars: Vec<char> = model_id.chars().collect();
    (0..chars.len())
        .filter(|&i| i == 0 || sep(chars[i - 1]))
        .find_map(|i| size_at(&chars, i))
}

/// The regex body at `i`. Greedy reading is exact here: every backtrack the regex could take
/// leaves a digit, `x` or `.` where it needs `b`, so it fails the same way.
fn size_at(s: &[char], mut i: usize) -> Option<f32> {
    let digits = |i: usize| s[i..].iter().take_while(|c| c.is_ascii_digit()).count();
    let mut experts = 1.0;
    let n = digits(i);
    if n > 0 && s.get(i + n).is_some_and(|c| c.eq_ignore_ascii_case(&'x')) {
        experts = s[i..i + n].iter().collect::<String>().parse::<f32>().ok()?;
        i += n + 1;
    }
    if s.get(i).is_some_and(|c| c.eq_ignore_ascii_case(&'e')) {
        i += 1;
    }
    let start = i;
    let n = digits(i);
    if n == 0 {
        return None;
    }
    i += n;
    if s.get(i) == Some(&'.') && digits(i + 1) > 0 {
        i += 1 + digits(i + 1);
    }
    let number: f32 = s[start..i].iter().collect::<String>().parse().ok()?;
    if !s.get(i).is_some_and(|c| c.eq_ignore_ascii_case(&'b')) {
        return None;
    }
    match s.get(i + 1) {
        None => Some(experts * number),
        Some(&c) if sep(c) || c == '.' => Some(experts * number),
        Some(_) => None,
    }
}

/// v2's `same`: one model's name across providers, `/^.*\//` prefix, `:free` suffix and case
/// taken off. "nvidia/nemotron-3-super-120b-a12b:free" → "nemotron-3-super-120b-a12b".
pub fn same(model_id: &str) -> String {
    let id = model_id.to_lowercase();
    let id = id.strip_suffix(":free").unwrap_or(&id);
    id.rsplit('/').next().unwrap_or(id).to_owned()
}

/// v2's `SEEDED` (provider, id, context), every row of it.
const SEEDED: &[(&str, &str, u32)] = &[
    ("ovhcloud", "gpt-oss-120b", 131_072),
    ("ovhcloud", "Meta-Llama-3_3-70B-Instruct", 131_072),
    ("ovhcloud", "gpt-oss-20b", 131_072),
    ("ovhcloud", "Qwen3.6-27B", 131_072),
    ("ovhcloud", "Mistral-Small-3.2-24B-Instruct-2506", 131_072),
    ("ovhcloud", "Qwen2.5-VL-72B-Instruct", 32_768),
    ("aihorde", "aphrodite/TheDrummer/Cydonia-24B-v4.3", 32_768),
    ("aihorde", "aphrodite/TheDrummer/Skyfall-31B-v4.2", 32_768),
    ("aihorde", "koboldcpp/gemma-4-31B-it-heretic", 32_768),
    ("nara", "mistral-large", 0),
    ("nara", "mistral-medium-3-5", 0),
    ("nara", "tencent-hy3", 1_000_000),
    ("cloudflare-ai", "@cf/zai-org/glm-4.7-flash", 0),
];

fn seeded(row: &FreeRow) -> impl Iterator<Item = Candidate> + '_ {
    SEEDED
        .iter()
        .filter(move |(provider, ..)| *provider == row.id)
        .map(move |&(provider, model, context)| Candidate {
            provider: provider.into(),
            model: model.into(),
            context,
            size_b: size_of(model),
            router: row.router || routes(model),
        })
}
