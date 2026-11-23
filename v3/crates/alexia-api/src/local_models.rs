// SPDX-License-Identifier: AGPL-3.0-only
//! Local models and local stats (INVENTORY M1–M17).
//!
//! A port of v2 serve.ts 2131–2213 (`/api/local-models/*`) and 2362–2394 (`/api/local-stats`)
//! over `localModels.ts`, `localCatalog.ts`, `fit.ts` and `localSettings.ts`, onto v3's
//! `hf` (Hugging Face, GGUF), `local` (the llama.cpp runtime and the GPU jobs) and `gpu` (what
//! fits). What fits is judged against the graphics card (its memory less `_core.gpu.headroom_mb`),
//! not the system memory v2 used on a Mac.
//!
//! D213: chat stays on free cloud models. "Use" pins a local model to the jobs v3 allows one for
//! (vision, the checker, embeddings) and says so; `mode: "local"` is refused. A use starts the
//! model in the background, and while that is under way (v2's mode transition) every non-GET
//! here except cancel, token and use answers v2's refusal. There is no MLX on this computer and
//! Ollama is not managed by v3: those are answered with v2's "not here" shapes.

// Refusals are axum `Response`s returned straight to the caller, as in the rest of the routes.
#![allow(clippy::result_large_err)]

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use alexia_core::gpu;
use alexia_core::hf::{self, Format, HfError};
use alexia_core::local::{self, system, ModelError, ModelNotes, Runtime};
use alexia_core::Job;
use alexia_store::{now_ms, secrets, Layout};
use axum::extract::{Path as UrlPath, Query, State};
use axum::response::Response;
use axum::routing::{delete, get, post};
use axum::{Extension, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::gate::Sent;
use crate::json;
use crate::Api;

const CORE: &str = "_core";
const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;
/// v2 `fit.ts` `DEFAULT_CONTEXT`: what a catalog card is judged at.
const DEFAULT_CONTEXT: u32 = 8192;
/// v2 `LARGE_CONTEXT`.
const LARGE_CONTEXT: u32 = 16_384;
/// v2 catalog.ts `PLANNER`: the smallest model (billions) trusted to plan with tools.
const PLANNER: f64 = 7.0;
/// v2 system.ts: three minutes of readings at the page's three seconds.
const HISTORY: usize = 60;
/// D213, in the words the spec gives.
const CLOUD_CHAT: &str = "Chat uses free cloud models on this computer; local models do speech, vision, embeddings and images.";
/// v2 `STILL_ANSWERING`.
const STILL_ANSWERING: &str = "Alexia is still answering — wait for her or press Stop.";
const SWITCHING: &str =
    "Wait for the mode switch to finish before starting another model operation.";
const NOT_IDLE: &str = "Wait for the current local-model operation, or cancel its job first.";

// ---- the vetted catalog (v2 localCatalog.ts `LOCAL_CATALOG`, GGUF only) ----

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    name: String,
    publisher: String,
    repo: String,
    revision: String,
    params: f64,
    context_max: u32,
    tools: bool,
    #[allow(dead_code)] // v2 cards say `vision: false`; the projector is what says vision here
    vision: bool,
    licence: Licence,
    gated: bool,
    abliterated: bool,
    blurb: String,
    kv_bytes_per_token: u64,
    projector: Option<CatalogFile>,
    quants: Vec<CatalogQuant>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Licence {
    name: String,
    url: String,
    restrictive: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct CatalogQuant {
    quant: String,
    bytes: u64,
    #[allow(dead_code)] // the download takes its files from the pinned listing, checked there
    files: Vec<CatalogFile>,
}

#[derive(Debug, Clone, Deserialize)]
struct CatalogFile {
    #[allow(dead_code)]
    name: String,
    bytes: u64,
    #[allow(dead_code)]
    sha256: String,
}

/// Copied from v2's `LOCAL_CATALOG` (pinned revisions, sizes and SHA-256 from the HF API).
const CATALOG_JSON: &str = r#"[
{"id":"qwen3-0.6b","name":"Qwen3 0.6B","publisher":"Qwen","repo":"bartowski/Qwen_Qwen3-0.6B-GGUF","revision":"60b85c0e3d8fe0f6474f406922a26d12aca4550d","params":0.751632384,"contextMax":32768,"tools":true,"vision":false,"licence":{"name":"apache-2.0","url":"https://huggingface.co/Qwen/Qwen3-0.6B/blob/c1899de289a04d12100db370d81485cdf75e47ca/README.md","restrictive":false},"gated":false,"abliterated":false,"blurb":"General text model with documented tool calling. Memory estimates include its conversation cache.","kvBytesPerToken":114688,"quants":[{"quant":"Q4_K_M","bytes":484220320,"files":[{"name":"Qwen_Qwen3-0.6B-Q4_K_M.gguf","bytes":484220320,"sha256":"9acfc1e001311f34b4252001b626f2e466d592a42065f66571bff3790d4e1b14"}]},{"quant":"Q5_K_M","bytes":551378336,"files":[{"name":"Qwen_Qwen3-0.6B-Q5_K_M.gguf","bytes":551378336,"sha256":"2df7894c99ee7716f0ed3c7d454c2386a7ae976c4b0ad0e716d55399c1360648"}]},{"quant":"Q6_K","bytes":622733728,"files":[{"name":"Qwen_Qwen3-0.6B-Q6_K.gguf","bytes":622733728,"sha256":"21e95febea68b223089e2382378e8c3155e587f5a6618ae3595e3d00c6885575"}]},{"quant":"Q8_0","bytes":804753824,"files":[{"name":"Qwen_Qwen3-0.6B-Q8_0.gguf","bytes":804753824,"sha256":"c159d1518f16bc42533d9a09f034eb598b670341adc2b08b9a9751614aea71eb"}]}]},
{"id":"qwen3-1.7b","name":"Qwen3 1.7B","publisher":"Qwen","repo":"bartowski/Qwen_Qwen3-1.7B-GGUF","revision":"dcb19155b962dbb6389f4691a982043a8e651022","params":2.031739904,"contextMax":32768,"tools":true,"vision":false,"licence":{"name":"apache-2.0","url":"https://huggingface.co/Qwen/Qwen3-1.7B/blob/70d244cc86ccca08cf5af4e1e306ecf908b1ad5e/README.md","restrictive":false},"gated":false,"abliterated":false,"blurb":"General text model with documented tool calling. Memory estimates include its conversation cache.","kvBytesPerToken":114688,"quants":[{"quant":"Q4_K_M","bytes":1282439584,"files":[{"name":"Qwen_Qwen3-1.7B-Q4_K_M.gguf","bytes":1282439584,"sha256":"72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb"}]},{"quant":"Q5_K_M","bytes":1471805856,"files":[{"name":"Qwen_Qwen3-1.7B-Q5_K_M.gguf","bytes":1471805856,"sha256":"4287aca1b231f27dbd20012c4bf9693c89b6c849dc02b7027096da54564d4037"}]},{"quant":"Q6_K","bytes":1673007520,"files":[{"name":"Qwen_Qwen3-1.7B-Q6_K.gguf","bytes":1673007520,"sha256":"95aec3c8e76caf949b5a7a3b02adbb7e307eb0aa55880f6a6f9fb5f46abe6d4f"}]},{"quant":"Q8_0","bytes":2165039520,"files":[{"name":"Qwen_Qwen3-1.7B-Q8_0.gguf","bytes":2165039520,"sha256":"74bb7c53538ab2cc81b93f0c64da14a503159de68cff3c6770428d3850479db3"}]}]},
{"id":"qwen3-4b-instruct-2507","name":"Qwen3 4B-Instruct-2507","publisher":"Qwen","repo":"bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF","revision":"ae44f08e1392f39c0e474af10c3ff8355c8b6688","params":4.022468096,"contextMax":262144,"tools":true,"vision":false,"licence":{"name":"apache-2.0","url":"https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/blob/cdbee75f17c01a7cc42f958dc650907174af0554/README.md","restrictive":false},"gated":false,"abliterated":false,"blurb":"General text model with documented tool calling. Memory estimates include its conversation cache.","kvBytesPerToken":147456,"quants":[{"quant":"Q4_K_M","bytes":2497280736,"files":[{"name":"Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf","bytes":2497280736,"sha256":"2fde00ce69dd4899c70d020845e2638353015bba0fdf161b3eb965f2bca4464e"}]},{"quant":"Q5_K_M","bytes":2889513696,"files":[{"name":"Qwen_Qwen3-4B-Instruct-2507-Q5_K_M.gguf","bytes":2889513696,"sha256":"66713ce35a58a82fe87642d4ec13425bf9b9a46800fff5c49a665ef5701439dc"}]},{"quant":"Q6_K","bytes":3306261216,"files":[{"name":"Qwen_Qwen3-4B-Instruct-2507-Q6_K.gguf","bytes":3306261216,"sha256":"324bcc583feabe9485df2521099bf913e2613048e7aa2bdcdbfe74f1acc7531e"}]},{"quant":"Q8_0","bytes":4280405216,"files":[{"name":"Qwen_Qwen3-4B-Instruct-2507-Q8_0.gguf","bytes":4280405216,"sha256":"260b5b5b6ad73e44df81a43ea1f5c11c37007b6bac18eb3cd2016e8667c19662"}]}]},
{"id":"qwen3-8b","name":"Qwen3 8B","publisher":"Qwen","repo":"bartowski/Qwen_Qwen3-8B-GGUF","revision":"0b69f75b7472688e6808490aa2b85efdb81b5ce7","params":8.19073536,"contextMax":32768,"tools":true,"vision":false,"licence":{"name":"apache-2.0","url":"https://huggingface.co/bartowski/Qwen_Qwen3-8B-GGUF/blob/0b69f75b7472688e6808490aa2b85efdb81b5ce7/README.md","restrictive":false},"gated":false,"abliterated":false,"blurb":"General text model with documented tool calling. Memory estimates include its conversation cache.","kvBytesPerToken":147456,"quants":[{"quant":"Q4_K_M","bytes":5027784224,"files":[{"name":"Qwen_Qwen3-8B-Q4_K_M.gguf","bytes":5027784224,"sha256":"54fffa050078e984116639c83dfb64b5aa6d4cd474e018b076777c632bbccccd"}]},{"quant":"Q5_K_M","bytes":5851112992,"files":[{"name":"Qwen_Qwen3-8B-Q5_K_M.gguf","bytes":5851112992,"sha256":"fa45032e10b515a10374426bee3a41d5340aa78b67f0bed503469479a9772d9b"}]},{"quant":"Q6_K","bytes":6725899808,"files":[{"name":"Qwen_Qwen3-8B-Q6_K.gguf","bytes":6725899808,"sha256":"69a45d3c366bab1736b201fdb21eb9d58160999a0f330a79d2c096f50de8985d"}]},{"quant":"Q8_0","bytes":8709518880,"files":[{"name":"Qwen_Qwen3-8B-Q8_0.gguf","bytes":8709518880,"sha256":"edbd7ae01df991a2d4061e61451ad3d6829d8ca19f7cc846f7177499ac280c33"}]}]},
{"id":"qwen3-14b","name":"Qwen3 14B","publisher":"Qwen","repo":"bartowski/Qwen_Qwen3-14B-GGUF","revision":"bd080f768a6401c2d5a7fa53a2e50cd8218a9ce2","params":14.7683072,"contextMax":32768,"tools":true,"vision":false,"licence":{"name":"apache-2.0","url":"https://huggingface.co/Qwen/Qwen3-14B/blob/40c069824f4251a91eefaf281ebe4c544efd3e18/README.md","restrictive":false},"gated":false,"abliterated":false,"blurb":"General text model with documented tool calling. Memory estimates include its conversation cache.","kvBytesPerToken":163840,"quants":[{"quant":"Q4_K_M","bytes":9001753632,"files":[{"name":"Qwen_Qwen3-14B-Q4_K_M.gguf","bytes":9001753632,"sha256":"915913e22399475dbe6c968ac014d9f1fbe08975e489279aede9d5c7b2c98eb6"}]},{"quant":"Q5_K_M","bytes":10514570272,"files":[{"name":"Qwen_Qwen3-14B-Q5_K_M.gguf","bytes":10514570272,"sha256":"bf19bf5c77c530762012f71215b62aa8f0bae08111ee0d537b8496479e17cfa3"}]},{"quant":"Q6_K","bytes":12121937952,"files":[{"name":"Qwen_Qwen3-14B-Q6_K.gguf","bytes":12121937952,"sha256":"de571a7d7c72b99de6d67e7f2b780d774c74f998e088c77133069568cad54294"}]},{"quant":"Q8_0","bytes":15698534432,"files":[{"name":"Qwen_Qwen3-14B-Q8_0.gguf","bytes":15698534432,"sha256":"62e390154916e1dc6b00f63d997bda39e8f9679c209dcabb69bdff5043fac2e0"}]}]},
{"id":"qwen3-32b","name":"Qwen3 32B","publisher":"Qwen","repo":"bartowski/Qwen_Qwen3-32B-GGUF","revision":"533fbb1ae5f2ce96c9171acc169e1f68f9352eca","params":32.762123264,"contextMax":32768,"tools":true,"vision":false,"licence":{"name":"apache-2.0","url":"https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/533fbb1ae5f2ce96c9171acc169e1f68f9352eca/README.md","restrictive":false},"gated":false,"abliterated":false,"blurb":"General text model with documented tool calling. Memory estimates include its conversation cache.","kvBytesPerToken":262144,"quants":[{"quant":"IQ3_M","bytes":14930083136,"files":[{"name":"Qwen_Qwen3-32B-IQ3_M.gguf","bytes":14930083136,"sha256":"3d551f95bd02fcfb96fc53c9bdb8d709531f53cfb9170e13c951d72b306617c3"}]},{"quant":"Q3_K_M","bytes":15971777856,"files":[{"name":"Qwen_Qwen3-32B-Q3_K_M.gguf","bytes":15971777856,"sha256":"26f662712fa72a0649c5578a7e29afb34e7b73650181338e8c3a507cbd7bec50"}]},{"quant":"Q4_K_M","bytes":19762149696,"files":[{"name":"Qwen_Qwen3-32B-Q4_K_M.gguf","bytes":19762149696,"sha256":"e41ec56ddd376963a116da97506fadfccb50fb402bb6f3cb4be0bc179a582bd6"}]},{"quant":"Q5_K_M","bytes":23214831936,"files":[{"name":"Qwen_Qwen3-32B-Q5_K_M.gguf","bytes":23214831936,"sha256":"7fdd925c783007dc039e335a1ae0d792fff081e023b48d7fc86e781aa6344949"}]},{"quant":"Q6_K","bytes":26883306816,"files":[{"name":"Qwen_Qwen3-32B-Q6_K.gguf","bytes":26883306816,"sha256":"a2769b0ded67d384cbfd42e740c61feec4207566b86f36f3d915da2248f291b6"}]},{"quant":"Q8_0","bytes":34817719616,"files":[{"name":"Qwen_Qwen3-32B-Q8_0.gguf","bytes":34817719616,"sha256":"bcb4c2d84e1d413fd3239ddaff64d5cca0928fe84af2349dee5f0ee3cc8ed84a"}]}]},
{"id":"qwen3-coder-30b-a3b-instruct","name":"Qwen3 Coder-30B-A3B-Instruct","publisher":"Qwen","repo":"unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF","revision":"b17cb02dd882d5b6ab62fc777ad2995f19668350","params":30.532122624,"contextMax":262144,"tools":true,"vision":false,"licence":{"name":"apache-2.0","url":"https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/blob/b17cb02dd882d5b6ab62fc777ad2995f19668350/README.md","restrictive":false},"gated":false,"abliterated":false,"blurb":"Coding-focused text model with documented tool calling. All expert weights count toward memory.","kvBytesPerToken":98304,"quants":[{"quant":"Q3_K_M","bytes":14711850144,"files":[{"name":"Qwen3-Coder-30B-A3B-Instruct-Q3_K_M.gguf","bytes":14711850144,"sha256":"30c83da425db2324444b6a6cecaf4c410038a2ec73a78de2436879dc0316a371"}]},{"quant":"Q4_K_M","bytes":18556689568,"files":[{"name":"Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf","bytes":18556689568,"sha256":"fadc3e5f8d42bf7e894a785b05082e47daee4df26680389817e2093056f088ad"}]},{"quant":"Q5_K_M","bytes":21725584544,"files":[{"name":"Qwen3-Coder-30B-A3B-Instruct-Q5_K_M.gguf","bytes":21725584544,"sha256":"4b78837bbec5ee248e4a5642bf608b6793721af41b92589e40c8da0bce58b907"}]},{"quant":"Q6_K","bytes":25092535456,"files":[{"name":"Qwen3-Coder-30B-A3B-Instruct-Q6_K.gguf","bytes":25092535456,"sha256":"100b5121d09553fb1af3b873b21fb3ec3da5c306fc5cb09bd338c48e21b10875"}]},{"quant":"Q8_0","bytes":32483935392,"files":[{"name":"Qwen3-Coder-30B-A3B-Instruct-Q8_0.gguf","bytes":32483935392,"sha256":"4ff1cff607804037bf6d2168249c570baa4e1621292b159c0e06591e0d7c3066"}]}]},
{"id":"qwen3-8b-abliterated","name":"Qwen3 8B-abliterated","publisher":"mlabonne / Qwen","repo":"bartowski/mlabonne_Qwen3-8B-abliterated-GGUF","revision":"0e66e6f836c802246b69941780ec8ef32670dc09","params":8.19073536,"contextMax":40960,"tools":false,"vision":false,"licence":{"name":"apache-2.0","url":"https://huggingface.co/bartowski/mlabonne_Qwen3-8B-abliterated-GGUF/blob/0e66e6f836c802246b69941780ec8ef32670dc09/README.md","restrictive":false},"gated":false,"abliterated":true,"blurb":"Separately modified abliterated text model. Tool use has not been verified.","kvBytesPerToken":147456,"quants":[{"quant":"Q4_K_M","bytes":5027784288,"files":[{"name":"mlabonne_Qwen3-8B-abliterated-Q4_K_M.gguf","bytes":5027784288,"sha256":"361557e69ad101ee22b1baf427283b7ddcf81bc7532b8cee8ac2c6b4d1b81ead"}]},{"quant":"Q5_K_M","bytes":5851113056,"files":[{"name":"mlabonne_Qwen3-8B-abliterated-Q5_K_M.gguf","bytes":5851113056,"sha256":"0dec7daafa1fa3df665ccb79577d4b71d0f8bea0e7bc74c07f5b0a40cdfbb8fa"}]},{"quant":"Q6_K","bytes":6725899872,"files":[{"name":"mlabonne_Qwen3-8B-abliterated-Q6_K.gguf","bytes":6725899872,"sha256":"1e1b047d8cf005dc57985727ce2cbd5d59c4e23cbda0cb8fca4448250add25c7"}]},{"quant":"Q8_0","bytes":8709518944,"files":[{"name":"mlabonne_Qwen3-8B-abliterated-Q8_0.gguf","bytes":8709518944,"sha256":"94cb715802d16be9c082b3c6ae0350014e36dbcbfe78ad2d5122f42f2e2b5599"}]}]},
{"id":"qwen3-14b-abliterated","name":"Qwen3 14B-abliterated","publisher":"mlabonne / Qwen","repo":"bartowski/mlabonne_Qwen3-14B-abliterated-GGUF","revision":"e42ad8d737563dc9c98f4cadf69b076394cec802","params":14.7683072,"contextMax":40960,"tools":false,"vision":false,"licence":{"name":"apache-2.0","url":"https://huggingface.co/bartowski/mlabonne_Qwen3-14B-abliterated-GGUF/blob/e42ad8d737563dc9c98f4cadf69b076394cec802/README.md","restrictive":false},"gated":false,"abliterated":true,"blurb":"Separately modified abliterated text model. Tool use has not been verified.","kvBytesPerToken":163840,"quants":[{"quant":"Q4_K_M","bytes":9001753696,"files":[{"name":"mlabonne_Qwen3-14B-abliterated-Q4_K_M.gguf","bytes":9001753696,"sha256":"3fe972a7c6e847ec791453b89a7333d369fbde329cbd4cc9a4f0598854db5d54"}]},{"quant":"Q5_K_M","bytes":10514570336,"files":[{"name":"mlabonne_Qwen3-14B-abliterated-Q5_K_M.gguf","bytes":10514570336,"sha256":"6ba161c229e6e6442864bea87b311ce36b62c0c664f0c8eac75cc43ee0fb619b"}]},{"quant":"Q6_K","bytes":12121938016,"files":[{"name":"mlabonne_Qwen3-14B-abliterated-Q6_K.gguf","bytes":12121938016,"sha256":"db037b17caecc0f5be69fb8e0fd759810acce911fe64d61a0116d46029509a16"}]},{"quant":"Q8_0","bytes":15698534496,"files":[{"name":"mlabonne_Qwen3-14B-abliterated-Q8_0.gguf","bytes":15698534496,"sha256":"98244eaddf92baf49c9c820d0b1108d8c7906e5abd1575c7f8942873c578f9d8"}]}]},
{"id":"qwen2.5-vl-7b-instruct","name":"Qwen2.5-VL 7B-Instruct","publisher":"Qwen","repo":"bartowski/Qwen_Qwen2.5-VL-7B-Instruct-GGUF","revision":"956c2bbb32ce10ac80761c127daa18f77063fab1","params":7.615616512,"contextMax":128000,"tools":false,"vision":true,"licence":{"name":"apache-2.0","url":"https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct/blob/cc594898137f460bfe9f0759e9844b3ce807cfb5/README.md","restrictive":false},"gated":false,"abliterated":false,"blurb":"Sees pictures as well as reading text: what the image editor plans and checks with. Memory estimates include its conversation cache, not the 1.4 GB projector.","kvBytesPerToken":57344,"projector":{"name":"mmproj-Qwen_Qwen2.5-VL-7B-Instruct-f16.gguf","bytes":1354162912,"sha256":"c24a7f5fcfc68286f0a217023b6738e73bea4f11787a43e8238d4bb1b8604cde"},"quants":[{"quant":"Q4_K_M","bytes":4683072320,"files":[{"name":"Qwen_Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf","bytes":4683072320,"sha256":"3f4513330aa7f109922bd701d773575484ae2b4a4090d6511260a2a4f8e3d069"}]},{"quant":"Q5_K_M","bytes":5444830016,"files":[{"name":"Qwen_Qwen2.5-VL-7B-Instruct-Q5_K_M.gguf","bytes":5444830016,"sha256":"325935d89110f25765b1627de643fcb7dbb4a9a52ce3da1820fce170cb0ed4fb"}]},{"quant":"Q6_K","bytes":6254197568,"files":[{"name":"Qwen_Qwen2.5-VL-7B-Instruct-Q6_K.gguf","bytes":6254197568,"sha256":"9cbdf6e5b899f5a5a65d904ea7891284768caeacfb1e5e2a6deb7406ecb71dac"}]}]}
]"#;

fn catalog() -> &'static [Entry] {
    static C: OnceLock<Vec<Entry>> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(CATALOG_JSON).expect("the built-in catalog parses"))
}

fn curated(id: &str) -> Option<&'static Entry> {
    catalog().iter().find(|e| e.id == id)
}

/// v2 `QUANT_NOTES`.
fn quant_note(quant: &str) -> Option<&'static str> {
    Some(match quant {
        "IQ3_M" | "Q3_K_M" => {
            "Three-bit weights: less storage, more quantization. Use Q4 or above when there is room."
        }
        "Q4_K_M" => "Four-bit mixed weights. The default download balances storage and precision.",
        "Q5_K_M" => "Five-bit mixed weights. More storage and precision than Q4.",
        "Q6_K" => "Six-bit weights. More storage and precision than Q5.",
        "Q8_0" => "Eight-bit weights. The largest download offered here; not full precision.",
        _ => return None,
    })
}

// ---- what fits (v2 fit.ts, on the graphics card) ----

/// This computer, as the screen judges it.
struct Here {
    card: gpu::Machine,
    headroom: u32,
    free_disk: Option<u64>,
    ram_bytes: u64,
    chip: String,
}

impl Here {
    async fn now(api: &Api) -> Here {
        let m = api.parts.jobs.machine_now().await;
        let (total, _) = system::memory();
        Here {
            ram_bytes: if m.ram_mb > 0 {
                u64::from(m.ram_mb) * MIB
            } else {
                total
            },
            card: local::whole_card(&m),
            headroom: gpu::headroom_mb(&api.parts.store),
            free_disk: free_disk(&api.parts.jobs.models_dir()),
            chip: system::cpu_model().await,
        }
    }

    /// v2 `modelBudget`: the card's memory less the headroom.
    fn budget(&self) -> u64 {
        u64::from(self.card.vram_mb.saturating_sub(self.headroom)) * MIB
    }

    /// v2 `summary`.
    fn summary(&self) -> String {
        let card = match &self.card.gpu {
            Some(name) if self.card.vram_mb > 0 => {
                format!(" · {name} {:.0} GiB", f64::from(self.card.vram_mb) / 1024.0)
            }
            _ => String::new(),
        };
        format!(
            "{}{card} · {:.0} GiB RAM · {:.1} GiB model budget",
            self.chip,
            self.ram_bytes as f64 / GIB as f64,
            self.budget() as f64 / GIB as f64
        )
    }
}

/// The free bytes on the volume `dir` is (or would be) on.
fn free_disk(dir: &Path) -> Option<u64> {
    dir.ancestors()
        .find(|a| a.exists())
        .and_then(system::free_disk)
}

/// v2 `Fit`, the parts the page reads.
struct Judged {
    verdict: &'static str,
    need: u64,
    note: Option<String>,
}

/// v2 `fit(m, e, quant, context)`: weights + KV + overhead against the card. A model whose KV
/// layout is unknown gets v2's cautious allowance and is at most `tight`; too little disk is
/// `disk`.
fn judge(here: &Here, bytes: u64, kv_known: Option<u64>, params: f64, context: u32) -> Judged {
    let kv = kv_known.filter(|k| *k > 0).unwrap_or(if params > 0.0 {
        (64.0 * 1024.0_f64).max((params * 64.0 * 1024.0).ceil()) as u64
    } else {
        MIB
    });
    let known = kv_known.is_some_and(|k| k > 0);
    let f = gpu::fit(&here.card, bytes, 1, kv, context, here.headroom);
    let mut verdict = match f.verdict {
        gpu::Verdict::Fits if !known => "tight",
        v => local::verdict_name(v),
    };
    let mut note = (!known).then(|| {
        "KV layout is unknown; memory is a cautious allowance. Check the runner before use."
            .to_owned()
    });
    match here.free_disk {
        None => {
            verdict = "disk";
            note = Some("Available disk space could not be read.".into());
        }
        Some(free) if free < bytes + GIB => verdict = "disk",
        Some(_) => {}
    }
    Judged {
        verdict,
        need: local::need_bytes(bytes, kv, context),
        note,
    }
}

fn judge_entry(here: &Here, e: &Entry, q: &CatalogQuant) -> Judged {
    let bytes = q.bytes + e.projector.as_ref().map_or(0, |p| p.bytes);
    judge(
        here,
        bytes,
        Some(e.kv_bytes_per_token),
        e.params,
        DEFAULT_CONTEXT.min(e.context_max.max(1)),
    )
}

/// v2 `quantCard`.
fn quant_card(quant: &str, bytes: u64, j: &Judged) -> Value {
    let mut card =
        json!({ "quant": quant, "bytes": bytes, "needBytes": j.need, "verdict": j.verdict });
    let notes: Vec<&str> = [quant_note(quant), j.note.as_deref()]
        .into_iter()
        .flatten()
        .collect();
    if !notes.is_empty() {
        card["note"] = notes.join(" ").into();
    }
    card
}

/// v2 `bestQuant`: Q4_K_M first, then the preference list, then the smallest; the first that
/// fits, else the first that is tight, else the first.
fn best_quant<'a>(here: &Here, e: &'a Entry) -> Option<(&'a CatalogQuant, Judged)> {
    const PREFERENCE: [&str; 6] = ["Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0", "Q3_K_M", "IQ3_M"];
    let order = |q: &str| {
        PREFERENCE
            .iter()
            .position(|p| *p == q)
            .unwrap_or(PREFERENCE.len())
    };
    let mut quants: Vec<&CatalogQuant> = e.quants.iter().collect();
    quants.sort_by(|a, b| {
        order(&a.quant)
            .cmp(&order(&b.quant))
            .then(a.bytes.cmp(&b.bytes))
    });
    let judged: Vec<(&CatalogQuant, Judged)> = quants
        .into_iter()
        .map(|q| (q, judge_entry(here, e, q)))
        .collect();
    let at = judged
        .iter()
        .position(|(_, j)| j.verdict == "fits")
        .or_else(|| judged.iter().position(|(_, j)| j.verdict == "tight"))
        .unwrap_or(0);
    judged.into_iter().nth(at)
}

/// v2 `card`.
fn card(here: &Here, e: &Entry, q: &CatalogQuant, j: &Judged, have: &HashSet<String>) -> Value {
    json!({
        "entry": e.id, "format": "gguf", "name": e.name, "blurb": e.blurb,
        "publisher": e.publisher, "params": e.params, "quant": q.quant, "bytes": q.bytes,
        "needBytes": j.need, "verdict": j.verdict, "tools": e.tools, "vision": false,
        "licence": e.licence, "abliterated": e.abliterated,
        "installed": have.contains(&format!("{}:{}", e.id, q.quant)),
        "quants": e.quants.iter().map(|x| quant_card(&x.quant, x.bytes, &judge_entry(here, e, x))).collect::<Vec<_>>(),
    })
}

/// v2 `recommend` and `overview`'s `picks`, `all` and `uncensored`.
fn recommend(here: &Here, have: &HashSet<String>) -> (Map<String, Value>, Vec<Value>, Vec<Value>) {
    let mut chosen: Vec<(&Entry, &CatalogQuant, Judged)> = catalog()
        .iter()
        .filter_map(|e| best_quant(here, e).map(|(q, j)| (e, q, j)))
        .collect();
    chosen.sort_by(|a, b| {
        b.0.params
            .total_cmp(&a.0.params)
            .then_with(|| a.0.id.cmp(&b.0.id))
    });
    let to_card = |(e, q, j): &(&Entry, &CatalogQuant, Judged)| card(here, e, q, j, have);
    let all: Vec<Value> = chosen
        .iter()
        .filter(|c| !c.0.abliterated)
        .map(to_card)
        .collect();
    let uncensored: Vec<Value> = chosen
        .iter()
        .filter(|c| c.0.abliterated)
        .map(to_card)
        .collect();
    let eligible: Vec<&(&Entry, &CatalogQuant, Judged)> = chosen
        .iter()
        .filter(|(e, _, j)| {
            !e.abliterated
                && j.verdict == "fits"
                && !e.gated
                && !e.licence.restrictive
                && e.licence.name != "unknown"
        })
        .collect();
    let mut picks = Map::new();
    if let Some(best) = eligible.first() {
        picks.insert("best".into(), to_card(best));
    }
    if let Some(fast) = eligible
        .iter()
        .min_by(|a, b| a.2.need.cmp(&b.2.need).then_with(|| a.0.id.cmp(&b.0.id)))
    {
        picks.insert("fast".into(), to_card(fast));
    }
    if let Some(tools) = eligible.iter().find(|c| c.0.tools && c.0.params >= PLANNER) {
        picks.insert("tools".into(), to_card(tools));
    }
    (picks, all, uncensored)
}

/// v2 `contextFor`: the biggest of the usual sizes that fits (else is tight).
fn context_for(here: &Here, bytes: u64, params: f64, most: u32) -> u32 {
    let roomy = Here {
        free_disk: Some(u64::MAX / 2),
        card: here.card.clone(),
        headroom: here.headroom,
        ram_bytes: here.ram_bytes,
        chip: String::new(),
    };
    let mut sizes: Vec<u32> = Vec::new();
    for s in [LARGE_CONTEXT, DEFAULT_CONTEXT, 4096, 2048, 512, 256] {
        let s = s.min(most);
        if !sizes.contains(&s) {
            sizes.push(s);
        }
    }
    let at = |v: &str| {
        sizes
            .iter()
            .copied()
            .find(|s| judge(&roomy, bytes, None, params, *s).verdict == v)
    };
    at("fits").or_else(|| at("tight")).unwrap_or(most.min(256))
}

// ---- the jobs (v2 `Job`) ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobView {
    id: String,
    target: String,
    name: String,
    step: &'static str,
    done: u64,
    total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes_per_second: Option<f64>,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_id: Option<String>,
    started_at: i64,
}

fn finished(step: &str) -> bool {
    matches!(step, "done" | "failed" | "cancelled")
}

struct Work {
    view: Mutex<JobView>,
    cancel: CancellationToken,
}

impl Work {
    fn set(&self, f: impl FnOnce(&mut JobView)) {
        f(&mut self.view.lock().unwrap_or_else(|e| e.into_inner()));
    }
    fn view(&self) -> JobView {
        self.view.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    fn step(&self, step: &'static str, message: &str) {
        self.set(|v| {
            v.step = step;
            v.message = message.to_owned();
        });
    }
    fn fail(&self, message: &str, error: &str) {
        self.set(|v| {
            v.step = "failed";
            v.message = message.to_owned();
            v.error = Some(error.to_owned());
        });
    }
}

/// v2 `ModeTransition`, for a use: the model is being started for its jobs.
struct Transition {
    id: String,
    target_mode: String,
    selected: (String, String),
    phase: Mutex<(&'static str, String)>,
}

impl Transition {
    fn pending(&self) -> bool {
        !matches!(
            self.phase.lock().unwrap_or_else(|e| e.into_inner()).0,
            "ready" | "failed"
        )
    }
    fn set(&self, phase: &'static str, message: String) {
        *self.phase.lock().unwrap_or_else(|e| e.into_inner()) = (phase, message);
    }
    fn status(&self) -> Value {
        let (phase, message) = self.phase.lock().unwrap_or_else(|e| e.into_inner()).clone();
        json!({
            "id": self.id, "targetMode": self.target_mode,
            "selectedModel": { "id": self.selected.0, "name": self.selected.1 },
            "phase": phase, "message": message,
        })
    }
}

/// The Local stats page's readings, kept between polls (v2 system.ts `History`).
#[derive(Default)]
struct History {
    cpu: Vec<f64>,
    gpu: Vec<f64>,
    memory: Vec<f64>,
}

fn keep(v: &mut Vec<f64>, x: f64) {
    v.push(x);
    if v.len() > HISTORY {
        v.remove(0);
    }
}

/// What this screen keeps between requests.
#[derive(Default)]
pub(crate) struct LocalState {
    works: Mutex<Vec<Arc<Work>>>,
    /// A remove or a context change is under way (v2 `mutating`).
    mutating: AtomicBool,
    transition: Mutex<Option<Arc<Transition>>>,
    history: Mutex<History>,
    client: OnceLock<reqwest::Client>,
}

impl LocalState {
    fn client(&self) -> reqwest::Client {
        self.client.get_or_init(reqwest::Client::new).clone()
    }

    fn running(&self) -> Option<JobView> {
        self.works
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|w| w.view())
            .find(|v| !finished(v.step))
    }

    fn busy(&self) -> bool {
        self.mutating.load(Ordering::SeqCst) || self.running().is_some()
    }

    fn pending(&self) -> bool {
        self.transition
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|t| t.pending())
    }

    fn job(&self, id: &str) -> Option<JobView> {
        self.works
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|w| w.view())
            .find(|v| v.id == id)
    }

    fn cancel(&self, id: &str) -> bool {
        let works = self.works.lock().unwrap_or_else(|e| e.into_inner());
        match works
            .iter()
            .find(|w| w.view().id == id && !finished(w.view().step))
        {
            Some(w) => {
                w.cancel.cancel();
                true
            }
            None => false,
        }
    }

    fn views(&self) -> Vec<JobView> {
        self.works
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|w| w.view())
            .collect()
    }

    /// v2 `launch`: one job at a time; finished ones are dropped when the next starts.
    fn launch(&self, target: String, name: String) -> Result<Arc<Work>, Response> {
        if self.busy() {
            return Err(refuse(409, NOT_IDLE));
        }
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let view = JobView {
            id: format!("{:x}-{:x}", now_ms(), NEXT.fetch_add(1, Ordering::Relaxed)),
            target,
            name,
            step: "queued",
            done: 0,
            total: 0,
            bytes_per_second: None,
            message: "Getting ready".into(),
            error: None,
            model_id: None,
            started_at: now_ms(),
        };
        let work = Arc::new(Work {
            view: Mutex::new(view),
            cancel: CancellationToken::new(),
        });
        let mut works = self.works.lock().unwrap_or_else(|e| e.into_inner());
        works.retain(|w| !finished(w.view().step));
        works.push(work.clone());
        Ok(work)
    }
}

/// Holds `mutating` for as long as it lives.
struct Mutating<'a>(&'a AtomicBool);

impl Drop for Mutating<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// v2 `mutation`: refused while a job runs or another change is under way.
fn mutation(api: &Api) -> Result<Mutating<'_>, Response> {
    if api.local.running().is_some()
        || api
            .local
            .mutating
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
    {
        return Err(refuse(409, NOT_IDLE));
    }
    Ok(Mutating(&api.local.mutating))
}

// ---- answers ----

/// v2's catch: `{ok:false, said, error}`.
fn refuse(code: u16, said: &str) -> Response {
    json::with(code, json!({ "ok": false, "said": said, "error": said }))
}

fn model_error(e: &ModelError) -> Response {
    let code = match e {
        ModelError::NotInstalled => 404,
        ModelError::Invalid(_) => 400,
        ModelError::TooBig | ModelError::Paused => 409,
        _ => 502,
    };
    refuse(code, &e.to_string())
}

fn hf_error(e: &HfError) -> Response {
    refuse(
        if matches!(e, HfError::Invalid(_)) {
            400
        } else {
            502
        },
        &e.to_string(),
    )
}

/// v2 `string(name)`: a string of at most 300 characters.
fn string(sent: &Map<String, Value>, name: &str) -> Result<String, Response> {
    match sent.get(name).and_then(Value::as_str) {
        Some(s) if s.chars().count() <= 300 => Ok(s.to_owned()),
        _ => Err(refuse(400, &format!("Supply a valid {name}."))),
    }
}

/// v2 `format()`.
fn format_of(v: Option<&str>) -> Result<Format, Response> {
    match v {
        None | Some("gguf") => Ok(Format::Gguf),
        Some("mlx") => Ok(Format::Mlx),
        Some(_) => Err(refuse(400, "Choose GGUF or MLX.")),
    }
}

/// serve.ts 2146: while a use is starting its model, other changes wait.
fn switching(api: &Api) -> Option<Response> {
    api.local.pending().then(|| refuse(409, SWITCHING))
}

/// serve.ts `task || replying`: the window is answering.
fn answering(api: &Api) -> Option<Response> {
    api.busy().then(|| refuse(409, STILL_ANSWERING))
}

/// `mode` as v2 took it: absent, `local` (refused here: D213) or `combined`.
fn mode_of(sent: &Map<String, Value>) -> Result<Option<&'static str>, Response> {
    match sent.get("mode") {
        None | Some(Value::Null) => Ok(None),
        Some(v) if v == "combined" => Ok(Some("combined")),
        Some(v) if v == "local" => Err(json::said(409, CLOUD_CHAT)),
        Some(_) => Err(refuse(400, "Choose Local or Combined.")),
    }
}

fn kv(api: &Api, key: &str) -> Option<Value> {
    api.parts.store.kv_get(CORE, key).ok().flatten()
}

fn mode(api: &Api) -> String {
    kv(api, "mode")
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "combined".into())
}

/// A model's name: what was noted when it came in, else its repo (or file) and quant.
fn name_of(i: &hf::Installed, n: Option<&ModelNotes>) -> String {
    if let Some(name) = n.and_then(|n| n.name.clone()) {
        return name;
    }
    match i.id.rsplit_once(':') {
        Some((repo, quant)) if repo.contains('/') && !repo.starts_with("local/") => {
            let short = repo.rsplit('/').next().unwrap_or(repo);
            format!("{} {quant}", trim_gguf(short))
        }
        _ => stem(&i.path),
    }
}

fn trim_gguf(s: &str) -> &str {
    let lower = s.to_ascii_lowercase();
    if lower.ends_with("-gguf") {
        &s[..s.len() - 5]
    } else if lower.ends_with("gguf") {
        &s[..s.len() - 4]
    } else {
        s
    }
}

/// A GGUF file's name without its split suffix or extension.
fn stem(p: &Path) -> String {
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let base = name
        .strip_suffix(".gguf")
        .or_else(|| name.strip_suffix(".GGUF"))
        .unwrap_or(&name);
    match base.rsplit_once("-of-") {
        Some((head, _)) => head.rsplit_once('-').map_or(head, |(h, _)| h).to_owned(),
        None => base.to_owned(),
    }
}

fn job_words(jobs: &[Job]) -> String {
    let words: Vec<&str> = jobs
        .iter()
        .map(|j| match j {
            Job::Vision => "reading pictures",
            Job::Check => "checking answers",
            Job::Local => "embeddings",
            _ => "chat",
        })
        .collect();
    match words.as_slice() {
        [] => "nothing".into(),
        [one] => (*one).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

// ---- the routes ----

pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new()
        .route("/api/local-models", get(overview))
        .route("/api/local-models/search", get(search))
        .route("/api/local-models/repo", get(repo))
        .route(
            "/api/local-models/context",
            get(context_get).post(context_post),
        )
        .route("/api/local-models/maintenance", get(maintenance))
        .route("/api/local-models/import-preview", get(import_preview))
        .route("/api/local-models/progress", get(progress))
        .route("/api/local-models/install", post(install))
        .route("/api/local-models/cancel", post(cancel))
        .route("/api/local-models/import", post(import))
        .route("/api/local-models/benchmark", post(benchmark))
        .route("/api/local-models/use", post(use_model))
        .route("/api/local-models/remove", post(remove_post))
        .route("/api/local-models/{id}", delete(remove_delete))
        .route("/api/local-models/token", post(token))
        .route("/api/local-stats", get(stats))
}

type Q = Query<std::collections::HashMap<String, String>>;

fn runtime_row(api: &Api) -> Value {
    json!({
        "installed": api.parts.runtime.ready(),
        "version": if api.parts.runtime.ready() { Runtime::version() } else { "" },
        "supported": Runtime::supported(),
    })
}

/// M1, v2 `overview`.
async fn overview(State(api): State<Arc<Api>>) -> Response {
    let here = Here::now(&api).await;
    let jobs = &api.parts.jobs;
    let notes = local::notes(&api.parts.store);
    let installed = hf::installed(&api.parts.store);
    let have: HashSet<String> = installed
        .iter()
        .filter_map(|i| {
            let n = notes.get(&i.id)?;
            Some(format!("{}:{}", n.entry.as_ref()?, n.quant.as_ref()?))
        })
        .collect();
    let (picks, all, uncensored) = recommend(&here, &have);
    let pinned = jobs.pinned_ids();
    let root = jobs.models_dir();
    let rows: Vec<Value> = installed
        .iter()
        .filter(|i| !i.meta.vision_projector)
        .map(|i| {
            let n = notes.get(&i.id);
            let file = i.path.file_name().map(|f| f.to_string_lossy().into_owned());
            let mut row = json!({
                "id": i.id, "format": "gguf", "owned": i.path.starts_with(&root),
                "imported": n.is_some_and(|n| n.imported),
                "contextMax": local::context_max(i), "kvCache": "f16", "ready": true,
                "name": name_of(i, n),
                "quant": n.and_then(|n| n.quant.clone())
                    .or_else(|| file.as_deref().and_then(hf::quant_of))
                    .unwrap_or_default(),
                "bytes": i.meta.bytes, "vetted": n.is_some_and(|n| n.vetted),
                "abliterated": n.is_some_and(|n| n.abliterated),
                "tools": n.is_some_and(|n| n.tools), "vision": i.mmproj.is_some(),
                "context": jobs.context_of(i), "pinned": pinned.contains(&i.id),
            });
            if let Some(t) = n.and_then(|n| n.last_used_at) {
                row["lastUsedAt"] = t.into();
            }
            if let Some(t) = n.and_then(|n| n.tokens_per_second) {
                row["tokensPerSecond"] = t.into();
            }
            if let Some(l) = n.and_then(|n| n.licence.clone()) {
                row["licence"] = l.into();
            }
            row
        })
        .collect();
    let llama = runtime_row(&api);
    json::ok(json!({
        "machine": {
            "summary": here.summary(), "ramBytes": here.ram_bytes,
            "freeDiskBytes": here.free_disk.unwrap_or(0), "budgetBytes": here.budget(),
            "appleSilicon": false, "chip": here.chip,
        },
        "runtime": llama,
        "runtimes": {
            "llama": llama,
            "mlx": { "installed": false, "version": "", "supported": false },
        },
        "picks": picks,
        "all": all,
        "uncensored": uncensored,
        "installed": rows,
        "jobs": api.local.views(),
        "mode": mode(&api),
    }))
}

/// M2, v2 `search`: one page of Hugging Face GGUF repos.
async fn search(State(api): State<Arc<Api>>, Query(q): Q) -> Response {
    let format = match format_of(q.get("format").map(String::as_str)) {
        Ok(f) => f,
        Err(r) => return r,
    };
    let text = q.get("q").map_or("", String::as_str);
    match hf::search(&api.local.client(), text, format).await {
        Ok(hits) => json::ok(json!(hits)),
        Err(e) => hf_error(&e),
    }
}

/// M3, v2 `hf`: how one repo's quants fit this computer. Unvetted, and the page says so.
async fn repo(State(api): State<Arc<Api>>, Query(q): Q) -> Response {
    let format = match format_of(q.get("format").map(String::as_str)) {
        Ok(f) => f,
        Err(r) => return r,
    };
    let name = q.get("repo").map_or("", String::as_str);
    let found = match hf::repo(&api.local.client(), name, format).await {
        Ok(f) => f,
        Err(e) => return hf_error(&e),
    };
    let here = Here::now(&api).await;
    let params = found.params.unwrap_or(0.0);
    let quants: Vec<Value> = found
        .quants
        .iter()
        .map(|q| {
            let context = context_for(&here, q.bytes, params, DEFAULT_CONTEXT);
            quant_card(
                &q.quant,
                q.bytes,
                &judge(&here, q.bytes, None, params, context),
            )
        })
        .collect();
    let mut out = json!({
        "repo": found.repo, "revision": found.revision, "gated": found.gated, "quants": quants,
    });
    if let Some(l) = found.licence {
        out["licence"] = l.into();
    }
    if let Some(p) = found.params {
        out["params"] = p.into();
    }
    json::ok(out)
}

/// M4, v2 `context`: what a context size would cost.
async fn context_get(State(api): State<Arc<Api>>, Query(q): Q) -> Response {
    let id = q.get("id").map_or("", String::as_str);
    if let Err(e) = api.parts.jobs.installed_one(id) {
        return model_error(&e);
    }
    if let Some(r) = cache_choice(q.get("kvCache").map(String::as_str)) {
        return r;
    }
    if q.get("draftModelId").is_some_and(|d| !d.is_empty()) {
        return refuse(400, NO_DRAFT);
    }
    let context = match q.get("context") {
        None => None,
        Some(raw) => match raw.trim().parse::<u32>() {
            Ok(c) => Some(c),
            Err(_) => return refuse(400, "Choose a valid context size."),
        },
    };
    match api.parts.jobs.context(id, context).await {
        Ok(c) => json::ok(json!(c)),
        Err(e) => model_error(&e),
    }
}

const NO_DRAFT: &str = "Alexia chooses the checker's draft model herself on this computer.";

/// v2 accepts f16, q8_0 and q4_0; v3's engine keeps the cache at f16.
fn cache_choice(v: Option<&str>) -> Option<Response> {
    match v {
        None | Some("f16") => None,
        Some("q8_0" | "q4_0") => Some(refuse(
            400,
            "The local engine keeps the cache at f16 on this computer.",
        )),
        Some(_) => Some(refuse(400, "Choose a supported KV cache precision.")),
    }
}

/// M5, v2 `configure`.
async fn context_post(
    State(api): State<Arc<Api>>,
    Extension(Sent(sent)): Extension<Sent>,
) -> Response {
    if let Some(r) = switching(&api).or_else(|| answering(&api)) {
        return r;
    }
    let Some(context) = sent
        .get("context")
        .and_then(Value::as_u64)
        .and_then(|c| u32::try_from(c).ok())
    else {
        return refuse(400, "Choose a valid context size.");
    };
    match sent.get("kvCache").and_then(Value::as_str) {
        Some(c) if ["f16", "q8_0", "q4_0"].contains(&c) => {
            if let Some(r) = cache_choice(Some(c)) {
                return r;
            }
        }
        _ => return refuse(400, "Choose a supported KV cache precision."),
    }
    if sent.get("draftModelId").is_some_and(|d| !d.is_null()) {
        return refuse(400, NO_DRAFT);
    }
    let id = match string(&sent, "id") {
        Ok(i) => i,
        Err(r) => return r,
    };
    let _held = match mutation(&api) {
        Ok(m) => m,
        Err(r) => return r,
    };
    let name = match api.parts.jobs.installed_one(&id) {
        Ok(i) => name_of(&i, local::notes(&api.parts.store).get(&id)),
        Err(e) => return model_error(&e),
    };
    match api.parts.jobs.set_context(&id, context).await {
        Ok(_) => json::ok(json!({
            "ok": true,
            "said": format!("{name} will use {} tokens of context at its next start.", grouped(context.into())),
        })),
        Err(ModelError::TooBig) => refuse(
            409,
            "This context and draft exceed the available memory budget.",
        ),
        Err(e) => model_error(&e),
    }
}

/// `4096` → `4,096` (v2 `toLocaleString`).
fn grouped(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// M6, v2 `maintenance`: newer pinned revisions of vetted models, and what could go.
async fn maintenance(State(api): State<Arc<Api>>) -> Response {
    let here = Here::now(&api).await;
    let notes = local::notes(&api.parts.store);
    let updates: Vec<Value> = hf::installed(&api.parts.store)
        .iter()
        .filter_map(|i| {
            let n = notes.get(&i.id)?;
            let e = curated(n.entry.as_deref()?)?;
            if n.revision.as_deref() == Some(e.revision.as_str()) {
                return None;
            }
            let q = e.quants.iter().find(|q| Some(&q.quant) == n.quant.as_ref())?;
            let fits = ["fits", "tight"].contains(&judge_entry(&here, e, q).verdict);
            fits.then(|| json!({
                "installedId": i.id, "entry": e.id, "name": e.name,
                "reason": "The curated catalog has a different pinned revision in this quantization. Review its release notes; installing checks it before changing your choice.",
            }))
        })
        .collect();
    let cleanup = api.parts.jobs.maintenance();
    let reclaimable: u64 = cleanup.iter().map(|s| s.bytes).sum();
    json::ok(json!({ "updates": updates, "cleanup": cleanup, "reclaimableBytes": reclaimable }))
}

/// M7, v2 `importPreview`: what a GGUF on this computer is.
async fn import_preview(Query(q): Q) -> Response {
    let raw = q.get("path").map_or("", String::as_str);
    let path = PathBuf::from(raw);
    if raw.len() > 4096 || !path.is_absolute() {
        return refuse(
            400,
            "Choose an absolute path to a GGUF file on this computer.",
        );
    }
    let read = tokio::task::spawn_blocking(move || hf::read_gguf(&path).map(|m| (path, m))).await;
    match read {
        Ok(Ok((path, meta))) => json::ok(json!({
            "name": stem(&path),
            "quant": path.file_name().and_then(|f| hf::quant_of(&f.to_string_lossy())).unwrap_or_default(),
            "bytes": meta.bytes,
            "contextMax": meta.context,
        })),
        Ok(Err(e)) => refuse(400, &e.to_string()),
        Err(e) => refuse(400, &e.to_string()),
    }
}

/// M8, v2 `job`.
async fn progress(State(api): State<Arc<Api>>, Query(q): Q) -> Response {
    match api.local.job(q.get("job").map_or("", String::as_str)) {
        Some(j) => json::ok(json!(j)),
        None => json::said(404, "That installation job is no longer available."),
    }
}

/// M10, v2 `cancel`: what downloaded stays as `.part`.
async fn cancel(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    match string(&sent, "job") {
        Ok(job) => json::ok(json!({ "ok": api.local.cancel(&job) })),
        Err(r) => r,
    }
}

/// What an install fetches: a vetted entry (pinned commit) or a repo found through search.
struct Plan {
    repo: String,
    revision: Option<String>,
    quant: String,
    name: String,
    notes: ModelNotes,
}

/// M9, v2 `install`.
async fn install(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    if let Some(r) = switching(&api).or_else(|| answering(&api)) {
        return r;
    }
    let quant = match string(&sent, "quant") {
        Ok(q) => q,
        Err(r) => return r,
    };
    let format = match format_of(sent.get("format").and_then(Value::as_str)) {
        Ok(f) => f,
        Err(r) => return r,
    };
    let revision = match sent.get("revision") {
        None => None,
        Some(Value::String(r)) if r.len() == 40 && r.bytes().all(|b| b.is_ascii_hexdigit()) => {
            Some(r.to_ascii_lowercase())
        }
        Some(_) => return refuse(400, "Choose a full commit revision."),
    };
    if let Err(r) = mode_of(&sent) {
        return r;
    }
    if quant.len() < 2
        || quant.len() > 20
        || !quant
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return refuse(400, "Choose a valid quantization.");
    }
    let entry = sent.get("entry").and_then(Value::as_str);
    let repo = sent.get("repo").and_then(Value::as_str);
    if entry.is_none() && repo.is_none() {
        return refuse(400, "Choose a catalog entry or Hugging Face repository.");
    }
    if format == Format::Mlx {
        return refuse(400, hf::NO_MLX);
    }
    if let Some(running) = api.local.running() {
        return refuse(
            409,
            &format!(
                "{} is still being installed. Wait for it, or cancel it first.",
                running.name
            ),
        );
    }
    let plan = if let Some(id) = entry {
        let Some(e) = curated(id) else {
            return refuse(400, "That model is not on the list any more.");
        };
        if !e.quants.iter().any(|q| q.quant == quant) {
            return refuse(400, "Choose a quantization offered by this model.");
        }
        Plan {
            repo: e.repo.clone(),
            revision: Some(e.revision.clone()),
            name: format!("{} ({quant})", e.name),
            notes: ModelNotes {
                name: Some(format!("{} {quant}", e.name)),
                entry: Some(e.id.clone()),
                repo: Some(e.repo.clone()),
                revision: Some(e.revision.clone()),
                quant: Some(quant.clone()),
                licence: Some(e.licence.name.clone()),
                vetted: true,
                abliterated: e.abliterated,
                tools: e.tools,
                ..ModelNotes::default()
            },
            quant,
        }
    } else {
        let repo = repo.unwrap_or_default().to_owned();
        let ok = repo.split_once('/').is_some_and(|(a, b)| {
            [a, b].iter().all(|s| {
                s.bytes().next().is_some_and(|c| c.is_ascii_alphanumeric())
                    && s.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            })
        });
        if !ok || repo.len() > 300 {
            return refuse(400, "Use a Hugging Face publisher/model repository.");
        }
        let short = trim_gguf(repo.rsplit('/').next().unwrap_or(&repo)).to_owned();
        Plan {
            name: format!("{short} ({quant})"),
            notes: ModelNotes {
                name: Some(format!("{short} {quant}")),
                repo: Some(repo.clone()),
                quant: Some(quant.clone()),
                abliterated: {
                    let l = repo.to_ascii_lowercase();
                    l.contains("abliterat") || l.contains("uncensor")
                },
                ..ModelNotes::default()
            },
            repo,
            revision,
            quant,
        }
    };
    let work = match api.local.launch(
        format!("{}:{}", entry.unwrap_or(&plan.repo), plan.quant),
        plan.name.clone(),
    ) {
        Ok(w) => w,
        Err(r) => return r,
    };
    let view = work.view();
    tokio::spawn(run_install(api.clone(), work, plan));
    json::with(202, json!(view))
}

/// Bytes a second over the readings so far.
fn rate(start: Instant, from: u64, done: u64) -> Option<f64> {
    let secs = start.elapsed().as_secs_f64();
    (secs >= 0.5 && done > from).then(|| ((done - from) as f64 / secs).round())
}

async fn run_install(api: Arc<Api>, work: Arc<Work>, plan: Plan) {
    let cancel = work.cancel.clone();
    let client = api.local.client();
    // The pinned listing first: the quant must be there and every file must carry a SHA-256.
    let found = tokio::select! {
        r = hf::repo_pinned(&client, &plan.repo, plan.revision.as_deref(), Format::Gguf) => r,
        () = cancel.cancelled() => return cancelled(&work),
    };
    let found = match found {
        Ok(f) => f,
        Err(e) => return work.fail("It did not finish", &e.to_string()),
    };
    let Some(q) = found.quants.iter().find(|q| q.quant == plan.quant) else {
        return work.fail(
            "It did not finish",
            &format!("{} has no {} file.", plan.repo, plan.quant),
        );
    };
    if q.files.iter().any(|f| f.sha256.len() != 64) {
        return work.fail(
            "It did not finish",
            "This model has no verifiable SHA-256 checksum.",
        );
    }
    if free_disk(&api.parts.jobs.models_dir()).is_some_and(|free| free < q.bytes + GIB) {
        return work.fail(
            "It did not finish",
            "There is not enough free disk space for this model.",
        );
    }

    work.step("runtime", "Getting the model runner");
    if let Err(e) = runtime(&api, &work).await {
        return match e {
            local::LocalError::Cancelled => cancelled(&work),
            e => work.fail("It did not finish", &e.to_string()),
        };
    }

    work.set(|v| {
        v.step = "download";
        v.message = format!("Downloading {}", plan.name);
        (v.done, v.total, v.bytes_per_second) = (0, q.bytes, None);
    });
    let (tx, mut rx) = mpsc::channel::<(u64, u64)>(64);
    let reader = {
        let work = work.clone();
        tokio::spawn(async move {
            let (start, mut from) = (Instant::now(), None);
            while let Some((done, total)) = rx.recv().await {
                let first = *from.get_or_insert(done);
                work.set(|v| {
                    (v.done, v.total) = (done, total);
                    v.bytes_per_second = rate(start, first, done).or(v.bytes_per_second);
                    if total > 0 && done >= total {
                        v.step = "verify";
                        v.message = "Checking the file".into();
                    }
                });
            }
        })
    };
    let layout = Layout::new(api.parts.layout.root.clone());
    let got = hf::import_cancellable(
        &plan.repo,
        Some(found.revision.as_str()),
        &plan.quant,
        &layout,
        &client,
        cancel.clone(),
        tx,
    )
    .await;
    let _ = reader.await;
    let installed = match got {
        Ok(i) => i,
        Err(HfError::Cancelled) => return cancelled(&work),
        Err(e) => return work.fail("It did not finish", &e.to_string()),
    };
    work.step("verify", "Checking the file");
    let notes = ModelNotes {
        revision: Some(found.revision.clone()),
        licence: plan.notes.licence.clone().or(found.licence.clone()),
        ..plan.notes
    };
    finish(&api, &work, installed, notes, &plan.name).await;
}

/// `Runtime::ensure`, its percent as the job's progress.
async fn runtime(api: &Api, work: &Arc<Work>) -> Result<(), local::LocalError> {
    let (tx, mut rx) = mpsc::channel::<u8>(16);
    let reader = {
        let work = work.clone();
        tokio::spawn(async move {
            while let Some(p) = rx.recv().await {
                work.set(|v| (v.done, v.total) = (u64::from(p), 100));
            }
        })
    };
    let r = api
        .parts
        .runtime
        .ensure(Some(tx), work.cancel.clone())
        .await;
    let _ = reader.await;
    r.map(|_| ())
}

fn cancelled(work: &Work) {
    work.step(
        "cancelled",
        "Cancelled. What was downloaded is kept, so installing again carries on from there.",
    );
}

/// Record the model, try it (a text model answers one short question), pin it to its jobs.
/// A model that fails its try is not kept on the list; one it replaced comes back.
async fn finish(api: &Api, work: &Work, installed: hf::Installed, notes: ModelNotes, name: &str) {
    let store = &api.parts.store;
    let jobs = &api.parts.jobs;
    let previous = hf::installed(store)
        .into_iter()
        .find(|i| i.id == installed.id);
    let before = local::notes(store).remove(&installed.id);
    let id = installed.id.clone();
    let recorded = hf::record(store, &installed)
        .map_err(|e| e.to_string())
        .and_then(|()| {
            local::set_notes(store, &id, |old| {
                let old = old.unwrap_or_default();
                Some(ModelNotes {
                    context: old.context,
                    tokens_per_second: old.tokens_per_second,
                    installed_at: Some(now_ms()),
                    last_used_at: Some(now_ms()),
                    ..notes
                })
            })
            .map_err(|e| e.to_string())
        });
    if let Err(e) = recorded {
        return work.fail("It did not finish", &e);
    }
    work.set(|v| {
        v.model_id = Some(id.clone());
        v.step = "start";
        v.message = format!("Starting {name}");
        (v.done, v.total) = (0, 0);
    });
    if !local::jobs_for(&installed).contains(&Job::Local) {
        work.step("test", "Trying it out");
        if let Err(e) = jobs.benchmark(&id, work.cancel.clone()).await {
            jobs.runtime().stop(&id).await;
            match &previous {
                Some(p) => {
                    let _ = hf::record(store, p);
                }
                None => {
                    let _ = hf::forget(store, &id);
                }
            }
            let _ = local::set_notes(store, &id, |_| before);
            return if matches!(e, ModelError::Cancelled) {
                cancelled(work)
            } else {
                work.fail("It did not finish", &e.to_string())
            };
        }
    }
    let pinned = match jobs.pin(&installed) {
        Ok(j) => j,
        Err(e) => return work.fail("It did not finish", &e.to_string()),
    };
    work.step(
        "done",
        &format!(
            "{name} is ready and chosen for {}. Chat stays on free cloud models.",
            job_words(&pinned)
        ),
    );
}

/// M11, v2 `import`: a GGUF from disk, copied under the models folder or used where it lies.
async fn import(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    if let Some(r) = switching(&api).or_else(|| answering(&api)) {
        return r;
    }
    let Some(raw) = sent
        .get("path")
        .and_then(Value::as_str)
        .filter(|p| p.len() <= 4096)
    else {
        return refuse(400, "Choose a valid local model path.");
    };
    let copy = match sent.get("storage") {
        None | Some(Value::Null) => true,
        Some(v) if v == "copy" => true,
        Some(v) if v == "reference" => false,
        Some(_) => return refuse(400, "Choose Copy or Reference for the imported files."),
    };
    if let Err(r) = mode_of(&sent) {
        return r;
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return refuse(
            400,
            "Choose an absolute path to a GGUF file on this computer.",
        );
    }
    if !path.exists() {
        return refuse(400, "That local model file is missing.");
    }
    let work = match api
        .local
        .launch(format!("import:{raw}"), "Importing a local model".into())
    {
        Ok(w) => w,
        Err(r) => return r,
    };
    let view = work.view();
    tokio::spawn(run_import(api.clone(), work, path, copy));
    json::with(202, json!(view))
}

async fn run_import(api: Arc<Api>, work: Arc<Work>, path: PathBuf, copy: bool) {
    work.step("verify", "Reading and checking the local model");
    let known: HashSet<String> = hf::installed(&api.parts.store)
        .into_iter()
        .map(|i| i.id)
        .collect();
    let layout = Layout::new(api.parts.layout.root.clone());
    let source = path.clone();
    let got = tokio::task::spawn_blocking(move || hf::import_file(&source, &layout, copy)).await;
    let installed = match got {
        Ok(Ok(i)) => i,
        Ok(Err(e)) => return work.fail("Import did not finish.", &e.to_string()),
        Err(e) => return work.fail("Import did not finish.", &e.to_string()),
    };
    if work.cancel.is_cancelled() {
        // A copy nobody else had is taken away again; the original is never touched.
        if copy && !known.contains(&installed.id) {
            if let Some(dir) = installed.path.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
        return work.step("cancelled", "Import cancelled. Original files are kept.");
    }
    let name = stem(&path);
    let notes = ModelNotes {
        name: Some(name.clone()),
        quant: path
            .file_name()
            .and_then(|f| hf::quant_of(&f.to_string_lossy())),
        imported: true,
        ..ModelNotes::default()
    };
    finish(&api, &work, installed, notes, &name).await;
    let v = work.view();
    if v.step == "failed" {
        work.set(|v| v.message = "Import did not finish.".into());
    } else if v.step == "cancelled" {
        work.set(|v| v.message = "Import cancelled. Original files are kept.".into());
    }
}

/// M12, v2 `benchmark`: a short local answer, timed. Never the cloud.
async fn benchmark(
    State(api): State<Arc<Api>>,
    Extension(Sent(sent)): Extension<Sent>,
) -> Response {
    if let Some(r) = switching(&api).or_else(|| answering(&api)) {
        return r;
    }
    let id = match string(&sent, "id") {
        Ok(i) => i,
        Err(r) => return r,
    };
    let one = match api.parts.jobs.installed_one(&id) {
        Ok(i) => i,
        Err(e) => return model_error(&e),
    };
    let name = name_of(&one, local::notes(&api.parts.store).get(&id));
    let work = match api
        .local
        .launch(format!("benchmark:{id}"), format!("Measuring {name}"))
    {
        Ok(w) => w,
        Err(r) => return r,
    };
    let view = work.view();
    let task_api = api.clone();
    tokio::spawn(async move {
        work.set(|v| {
            v.step = "start";
            v.model_id = Some(id.clone());
            v.message = "Starting the model for a short local measurement".into();
        });
        let jobs = &task_api.parts.jobs;
        work.step("test", "Measuring a short answer on this computer");
        match jobs.benchmark(&id, work.cancel.clone()).await {
            Ok(b) => work.step(
                "done",
                &match b.tokens_per_second {
                    Some(t) => format!("{t} tokens per second on this computer."),
                    None => "The model answered; there were too few timed tokens for a useful speed figure.".into(),
                },
            ),
            Err(ModelError::Cancelled) => work.step("cancelled", "Measurement cancelled."),
            Err(e) => work.fail("Measurement did not finish.", &e.to_string()),
        }
    });
    json::with(202, json!(view))
}

/// M13, v2 `use`: pin the model to the jobs it may do and start it. Never chat (D213).
async fn use_model(
    State(api): State<Arc<Api>>,
    Extension(Sent(sent)): Extension<Sent>,
) -> Response {
    if let Some(r) = answering(&api) {
        return r;
    }
    let mode = match mode_of(&sent) {
        Ok(m) => m,
        Err(r) => return r,
    };
    let id = match string(&sent, "id") {
        Ok(i) => i,
        Err(r) => return r,
    };
    if api.local.busy() {
        return refuse(409, NOT_IDLE);
    }
    let Ok(one) = api.parts.jobs.installed_one(&id) else {
        return json::said(409, "That model is not installed any more.");
    };
    let jobs = match api.parts.jobs.pin(&one) {
        Ok(j) => j,
        Err(e) => return model_error(&e),
    };
    if let Some(m) = mode {
        if let Err(e) = api.parts.store.kv_set(CORE, "mode", &json!(m)) {
            return refuse(500, &e.to_string());
        }
    }
    let name = name_of(&one, local::notes(&api.parts.store).get(&id));
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let t = Arc::new(Transition {
        id: format!("{:x}-{:x}", now_ms(), NEXT.fetch_add(1, Ordering::Relaxed)),
        target_mode: mode.map_or_else(|| self::mode(&api), str::to_owned),
        selected: (id.clone(), name.clone()),
        phase: Mutex::new(("loading", format!("Starting {name} on this computer…"))),
    });
    *api.local
        .transition
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(t.clone());
    let task_api = api.clone();
    let task_t = t.clone();
    tokio::spawn(async move {
        match task_api.parts.jobs.warm(&one).await {
            Ok(()) => task_t.set("ready", format!("{} is ready.", task_t.selected.1)),
            Err(e) => task_t.set("failed", e.to_string()),
        }
    });
    json::ok(json!({
        "ok": true,
        "said": format!(
            "{name} now does {} on this computer. {CLOUD_CHAT}",
            job_words(&jobs)
        ),
        "data": { "transitionId": t.id },
    }))
}

/// M14, v2 `remove`.
async fn remove_post(
    State(api): State<Arc<Api>>,
    Extension(Sent(sent)): Extension<Sent>,
) -> Response {
    match string(&sent, "id") {
        Ok(id) => remove(&api, &id).await,
        Err(r) => r,
    }
}

/// M15: the same, by path (`DELETE /api/local-models/<id, percent-encoded>`).
async fn remove_delete(State(api): State<Arc<Api>>, UrlPath(id): UrlPath<String>) -> Response {
    remove(&api, &id).await
}

async fn remove(api: &Api, id: &str) -> Response {
    if let Some(r) = switching(api).or_else(|| answering(api)) {
        return r;
    }
    let _held = match mutation(api) {
        Ok(m) => m,
        Err(r) => return r,
    };
    match api.parts.jobs.remove(id).await {
        Ok(r) if r.owned => json::ok(json!({
            "ok": true,
            "said": format!("{} is removed, and {:.1} GB is free again.", r.name, r.freed as f64 / GIB as f64),
        })),
        Ok(r) => json::ok(json!({
            "ok": true,
            "said": format!("{} is removed from Alexia. Its original files are kept.", r.name),
        })),
        Err(ModelError::NotInstalled) => json::said(404, "That model is not installed."),
        Err(e) => model_error(&e),
    }
}

/// M16: the Hugging Face token into the keychain (`_core`/`hf_token`); never echoed.
async fn token(Extension(Sent(sent)): Extension<Sent>) -> Response {
    let secret = match string(&sent, "token") {
        Ok(t) => t.trim().to_owned(),
        Err(r) => return r,
    };
    let stored = if secret.is_empty() {
        secrets::delete(CORE, "hf_token")
    } else {
        secrets::set(CORE, "hf_token", &secret)
    };
    match stored {
        Ok(()) => json::ok(json!({
            "ok": true,
            "said": if secret.is_empty() { "Hugging Face token removed." } else { "Hugging Face token saved in your keychain." },
        })),
        Err(_) => refuse(502, "The keychain could not keep the Hugging Face token."),
    }
}

/// M17, serve.ts 2362–2394: runners, models, speed and the machine, read now.
async fn stats(State(api): State<Arc<Api>>) -> Response {
    let notes = local::notes(&api.parts.store);
    let installed = hf::installed(&api.parts.store);
    let running = api.parts.runtime.running();
    let loaded: Vec<Value> = installed
        .iter()
        .filter(|i| running.contains(&i.id))
        .map(|i| json!({ "name": name_of(i, notes.get(&i.id)), "size": i.meta.bytes, "vram": 0, "until": null }))
        .collect();
    let speed = installed
        .iter()
        .filter_map(|i| {
            let n = notes.get(&i.id)?;
            Some((
                n.last_used_at.unwrap_or(0),
                n.tokens_per_second?,
                name_of(i, Some(n)),
            ))
        })
        .max_by_key(|s| s.0)
        .map_or(
            Value::Null,
            |(_, t, model)| json!({ "model": model, "tokensPerSecond": t }),
        );
    let (total, used) = system::memory();
    let cpu = system::cpu_percent();
    let gpu_pct = system::gpu_percent().await;
    let memory_pct = if total > 0 {
        (used as f64 / total as f64 * 1000.0).round() / 10.0
    } else {
        0.0
    };
    let history = {
        let mut h = api.local.history.lock().unwrap_or_else(|e| e.into_inner());
        keep(&mut h.cpu, cpu);
        keep(&mut h.gpu, gpu_pct);
        keep(&mut h.memory, memory_pct);
        json!({ "cpu": h.cpu, "gpu": h.gpu, "memory": h.memory })
    };
    json::ok(json!({
        "running": !loaded.is_empty(),
        "installed": installed
            .iter()
            .filter(|i| !i.meta.vision_projector)
            .map(|i| json!({ "name": name_of(i, notes.get(&i.id)), "size": i.meta.bytes }))
            .collect::<Vec<_>>(),
        "loaded": loaded,
        "runners": { "ollama": false, "llama": !loaded.is_empty(), "mlx": false },
        "speed": speed,
        "system": {
            "cpu": { "percent": cpu, "cores": system::cores(), "model": system::cpu_model().await },
            "gpu": { "percent": gpu_pct },
            "memory": { "used": used, "total": total, "pressure": null },
            "load": null,
            "temperature": null,
            "uptime": system::uptime(),
            "history": history,
        },
    }))
}

/// `/api/state`'s `modeTransition` (v2 `modeTransitions.status()`): the last use's start of its
/// model, or null when there has been none.
pub(crate) fn transition(api: &Api) -> Value {
    api.local
        .transition
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map_or(Value::Null, |t| t.status())
}

/// A local-model job (an install, import or measurement) or a model being started for a use:
/// the window waits for it before it chats, as v2's `localModels.busy() || pending()`.
#[allow(dead_code)] // read by chat (P2D-05)
pub(crate) fn busy(api: &Api) -> bool {
    api.local.busy() || api.local.pending()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_parses_and_is_pinned() {
        let c = catalog();
        assert_eq!(c.len(), 10);
        for e in c {
            assert_eq!(e.revision.len(), 40, "{}", e.id);
            assert!(e.kv_bytes_per_token > 0, "{}", e.id);
            for q in &e.quants {
                assert_eq!(q.bytes, q.files.iter().map(|f| f.bytes).sum::<u64>());
                assert!(q
                    .files
                    .iter()
                    .all(|f| f.sha256.len() == 64 && !f.name.is_empty()));
            }
        }
        assert!(curated("qwen2.5-vl-7b-instruct").is_some_and(|e| e.projector.is_some()));
    }

    #[test]
    fn words_and_numbers() {
        assert_eq!(grouped(4096), "4,096");
        assert_eq!(grouped(131_072), "131,072");
        assert_eq!(grouped(512), "512");
        assert_eq!(
            job_words(&[Job::Vision, Job::Check]),
            "reading pictures and checking answers"
        );
        assert_eq!(job_words(&[Job::Local]), "embeddings");
        assert_eq!(trim_gguf("Qwen_Qwen3-0.6B-GGUF"), "Qwen_Qwen3-0.6B");
        assert_eq!(
            stem(Path::new("/m/Model-Q4_K_M-00001-of-00002.gguf")),
            "Model-Q4_K_M"
        );
        assert_eq!(stem(Path::new("/m/tiny.gguf")), "tiny");
    }

    fn here(vram_mb: u32, disk: Option<u64>) -> Here {
        Here {
            card: gpu::Machine {
                vram_mb,
                free_mb: vram_mb,
                ram_mb: 32_768,
                gpu: Some("NVIDIA GeForce RTX 4060 Laptop GPU".into()),
            },
            headroom: 1536,
            free_disk: disk,
            ram_bytes: 32 * GIB,
            chip: "Test CPU".into(),
        }
    }

    #[test]
    fn an_8gb_card_gets_the_small_models() {
        let h = here(8192, Some(500 * GIB));
        assert_eq!(h.budget(), 6656 * MIB);
        assert_eq!(
            h.summary(),
            "Test CPU · NVIDIA GeForce RTX 4060 Laptop GPU 8 GiB · 32 GiB RAM · 6.5 GiB model budget"
        );
        let (picks, all, uncensored) = recommend(&h, &HashSet::new());
        let verdict = |id: &str| {
            all.iter()
                .chain(&uncensored)
                .find(|c| c["entry"] == id)
                .map(|c| c["verdict"].as_str().unwrap().to_owned())
        };
        assert_eq!(verdict("qwen3-0.6b").as_deref(), Some("fits"));
        assert_eq!(verdict("qwen3-32b").as_deref(), Some("too-big"));
        assert_eq!(picks["fast"]["entry"], "qwen3-0.6b");
        assert_ne!(picks["best"]["entry"], "qwen3-32b");
        assert_eq!(picks["best"]["verdict"], "fits");
        // Biggest first; the abliterated ones are kept apart.
        assert_eq!(all[0]["entry"], "qwen3-32b");
        assert!(uncensored.iter().all(|c| c["abliterated"] == true));
        // No room on the disk: nothing is offered.
        let (picks, all, _) = recommend(&here(8192, Some(GIB)), &HashSet::new());
        assert!(picks.is_empty());
        assert!(all.iter().all(|c| c["verdict"] == "disk"));
    }
}
