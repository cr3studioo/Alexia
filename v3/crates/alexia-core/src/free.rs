// SPDX-License-Identifier: AGPL-3.0-only
//! P1-04: v2's free provider ladder (`packages/core/src/provider.ts` `PROVIDERS`), restricted to
//! rows that answer for free (D212). Local runners are not here (D213: the GPU is not for chat).
//! `trainsOnYourData` is `unknown` for every row in v2, so no row here claims either way.

use std::time::Duration;

use serde::Deserialize;

use crate::openai::OpenAiCompat;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Auth {
    Required,
    Optional,
    None,
}

#[derive(Clone, Debug)]
pub struct FreeRow {
    /// v2's provider id, e.g. "groq".
    pub id: String,
    /// May contain "{account}" (v2's cloudflare-ai shape).
    pub base_url: String,
    pub models_path: Option<String>,
    pub headers: Vec<(String, String)>,
    pub auth: Auth,
    /// The whole provider is a free tier (Groq, Cerebras…). False = only `:free` / zero-priced
    /// models are free (OpenRouter and other aggregators).
    pub all_free: bool,
    pub rpm: Option<u32>,
    pub rpd: Option<u32>,
    /// A "random free model" endpoint, ranked last (v2 D159).
    pub router: bool,
}

/// (id, base_url, models_path, auth, all_free, rpm, rpd), in v2's order.
type Line = (
    &'static str,
    &'static str,
    Option<&'static str>,
    Auth,
    bool,
    Option<u32>,
    Option<u32>,
);

#[rustfmt::skip]
const LADDER: &[Line] = &[
    // `published`, free via `:free` models.
    ("openrouter", "https://openrouter.ai/api/v1", Some("/models"), Auth::Required, false, Some(20), Some(50)),
    ("groq", "https://api.groq.com/openai/v1", Some("/models"), Auth::Required, true, Some(30), Some(1_000)),
    ("cerebras", "https://api.cerebras.ai/v1", Some("/models"), Auth::Required, true, Some(5), None),
    ("google", "https://generativelanguage.googleapis.com/v1beta/openai", Some("/models"), Auth::Required, true, Some(15), Some(1_500)),
    ("mistral", "https://api.mistral.ai/v1", Some("/models"), Auth::Required, true, Some(60), None),
    ("nvidia", "https://integrate.api.nvidia.com/v1", Some("/models"), Auth::Required, true, Some(40), None),
    // v2 records no model list for GitHub Models.
    ("github", "https://models.inference.ai.azure.com", None, Auth::Required, true, Some(10), Some(50)),
    // The keyless floor. OVHcloud's list is wrong about price and kind, so v2 writes its
    // models down by hand rather than reading it.
    ("ovhcloud", "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", None, Auth::Optional, true, Some(2), None),
    ("aihorde", "https://oai.aihorde.net/v1", Some("/models"), Auth::Optional, true, None, None),
    ("uncloseai", "https://hermes.ai.unturf.com/v1", Some("/models"), Auth::Optional, true, None, None),
    // `published`; free models are priced at zero.
    ("kilo-gateway", "https://api.kilo.ai/api/gateway/v1", Some("/../models"), Auth::Optional, false, Some(3), None),
    ("llm7", "https://api.llm7.io/v1", Some("/models"), Auth::Optional, true, Some(20), None),
    // No list on purpose: most of it is credit-gated and would arrive looking free.
    ("nara", "https://router.bynara.id/v1", None, Auth::Required, true, None, None),
    ("cloudflare-ai", "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1", None, Auth::Required, true, None, Some(150)),
    // Ollama's hosted tier, not the local runner. Its list is `{models: [...]}` at `/api/tags`.
    ("ollama-cloud", "https://ollama.com/v1", Some("/../api/tags"), Auth::Required, true, None, None),
    // `published`; GLM-4.7-Flash is free forever (v2 `freeModels`).
    ("zai", "https://api.z.ai/api/paas/v4", Some("/models"), Auth::Required, false, None, None),
    ("cohere", "https://api.cohere.com/compatibility/v1", Some("/models"), Auth::Required, true, None, None),
    ("aion", "https://api.aionlabs.ai/v1", Some("/models"), Auth::Required, false, None, None),
    ("agnes", "https://apihub.agnes-ai.com/v1", Some("/models"), Auth::Required, true, None, None),
    ("requesty", "https://router.requesty.ai/v1", Some("/models"), Auth::Required, false, None, None),
    ("sealion", "https://api.sea-lion.ai/v1", Some("/models"), Auth::Required, true, None, None),
    ("navy", "https://api.navy/v1", Some("/models"), Auth::Required, false, None, None),
];

fn headers_for(id: &str) -> Vec<(String, String)> {
    let pairs: &[(&str, &str)] = match id {
        "openrouter" => &[
            ("HTTP-Referer", "https://github.com/cr3studioo/Alexia"),
            ("X-Title", "Alexia"),
        ],
        "navy" => &[("User-Agent", "Alexia (+https://github.com/cr3studioo/Alexia)")],
        _ => &[],
    };
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// v2's `anonymousKey`: a published literal sent when no key is stored. Not secrets.
fn anonymous_key(id: &str) -> Option<&'static str> {
    match id {
        "aihorde" => Some("0000000000"),
        "uncloseai" => Some("alexia"),
        _ => None,
    }
}

/// v2's per-row `timeoutMs` (first byte); every other row gets the default 30 s.
fn first_byte_for(id: &str) -> Duration {
    Duration::from_secs(match id {
        "aihorde" | "ollama-cloud" => 120,
        "cloudflare-ai" | "agnes" => 60,
        _ => 30,
    })
}

/// v2's ladder, rows with a free tier only. Order is v2's.
pub fn ladder() -> Vec<FreeRow> {
    LADDER
        .iter()
        .map(|&(id, base, models, auth, all_free, rpm, rpd)| FreeRow {
            id: id.into(),
            base_url: base.into(),
            models_path: models.map(Into::into),
            headers: headers_for(id),
            auth,
            all_free,
            rpm,
            rpd,
            router: false,
        })
        .collect()
}

/// The key for a row: `secrets::get("_core", "provider_<id>")` (v2's `keyOf`), else the row's
/// published anonymous key, if it has one.
pub fn key_for(row: &FreeRow) -> Option<String> {
    let stored = alexia_store::secrets::get("_core", &format!("provider_{}", row.id))
        .ok()
        .flatten()
        .filter(|k| !k.is_empty());
    stored.or_else(|| anonymous_key(&row.id).map(Into::into))
}

/// Test hook: if `ALEXIA_FREE_PROVIDERS` names a JSON file, rows come from it instead
/// (`[{id, base_url, models_path?, auth, all_free, rpm?, rpd?, router?}]`, `auth` as
/// `"required"|"optional"|"none"`). Used by P1-18.
pub fn configured() -> Vec<OpenAiCompat> {
    let client = reqwest::Client::builder()
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_keepalive(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_default();
    rows()
        .into_iter()
        .map(|row| {
            let key = key_for(&row);
            let first = first_byte_for(&row.id);
            OpenAiCompat::with_timeouts(row, key, client.clone(), first, Duration::from_secs(20))
        })
        .collect()
}

#[derive(Deserialize)]
struct FileRow {
    id: String,
    base_url: String,
    models_path: Option<String>,
    auth: Auth,
    all_free: bool,
    rpm: Option<u32>,
    rpd: Option<u32>,
    #[serde(default)]
    router: bool,
}

fn rows() -> Vec<FreeRow> {
    let Some(path) = std::env::var_os("ALEXIA_FREE_PROVIDERS") else {
        return ladder();
    };
    let parsed = std::fs::read_to_string(&path)
        .map_err(|e| e.to_string())
        .and_then(|text| serde_json::from_str::<Vec<FileRow>>(&text).map_err(|e| e.to_string()));
    match parsed {
        Ok(rows) => rows
            .into_iter()
            .map(|r| FreeRow {
                headers: headers_for(&r.id),
                id: r.id,
                base_url: r.base_url,
                models_path: r.models_path,
                auth: r.auth,
                all_free: r.all_free,
                rpm: r.rpm,
                rpd: r.rpd,
                router: r.router,
            })
            .collect(),
        // A test hook that cannot be read is a broken test, not a reason to call real providers.
        Err(e) => {
            tracing::warn!("ALEXIA_FREE_PROVIDERS could not be read: {e}");
            Vec::new()
        }
    }
}
