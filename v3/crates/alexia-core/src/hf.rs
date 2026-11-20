// SPDX-License-Identifier: AGPL-3.0-only
//! Hugging Face import and GGUF split files (MO-13). Stub: P2-33 fills it.
#![allow(unused_variables)] // stub: the filling task removes this

use std::path::{Path, PathBuf};

use alexia_store::{Layout, Store};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub struct GgufMeta {
    pub arch: String,
    pub layers: u32,
    pub context: u32,
    pub kv_bytes_per_token: u64,
    pub bytes: u64,
    pub parts: Vec<PathBuf>,
    pub vision_projector: bool,
}

/// Follows split parts.
pub fn read_gguf(path: &Path) -> Result<GgufMeta, HfError> {
    todo!("P2-33")
}

pub struct Quant {
    pub name: String,
    pub files: Vec<String>,
    pub bytes: u64,
}

pub async fn quants(
    repo: &str,
    revision: Option<&str>,
    client: &reqwest::Client,
) -> Result<Vec<Quant>, HfError> {
    todo!("P2-33")
}

/// Download into `layout.cache()/models/<repo>/<quant>/`, resumable, SHA-256 from HF's LFS info.
pub async fn import_repo(
    repo: &str,
    quant: &str,
    layout: &Layout,
    client: &reqwest::Client,
    progress: Option<mpsc::Sender<u8>>,
    cancel: CancellationToken,
) -> Result<Installed, HfError> {
    todo!("P2-33")
}

pub fn import_file(path: &Path, layout: &Layout, copy: bool) -> Result<Installed, HfError> {
    todo!("P2-33")
}

pub struct Installed {
    pub id: String,
    pub path: PathBuf,
    pub meta: GgufMeta,
    pub mmproj: Option<PathBuf>,
}

/// kv `_core`/`local_models`.
pub fn installed(store: &Store) -> Vec<Installed> {
    todo!("P2-33")
}

/// Each variant is a sentence the owner can read. P2-33 names them.
#[derive(Debug, thiserror::Error)]
pub enum HfError {}
