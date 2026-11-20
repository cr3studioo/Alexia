// SPDX-License-Identifier: AGPL-3.0-only
//! The GPU: what fits (MO-02), the load cap (MO-08), stepping aside for games (MO-09).
//! Stub: P2-32 fills it.
#![allow(unused_variables)] // stub: the filling task removes this

use std::path::PathBuf;
use std::sync::Arc;

use alexia_store::Store;
use tokio_util::sync::CancellationToken;

pub struct Machine {
    pub vram_mb: u32,
    pub free_mb: u32,
    pub ram_mb: u32,
    pub gpu: Option<String>,
}

pub enum Verdict {
    Fits,
    Tight,
    TooBig,
}

pub struct Fit {
    pub verdict: Verdict,
    pub gpu_layers: u32,
    pub vram_mb: u32,
}

/// v2 `fit.ts`: weights + KV cache for `context`, minus headroom.
pub fn fit(
    m: &Machine,
    model_bytes: u64,
    layers: u32,
    kv_bytes_per_token: u64,
    context: u32,
    headroom_mb: u32,
) -> Fit {
    todo!("P2-32")
}

/// `nvidia-smi --query-gpu=…` and `--query-compute-apps=…`, plus `-q -x` for graphics processes.
pub async fn machine() -> Option<Machine> {
    todo!("P2-32")
}

pub struct GpuProc {
    pub pid: u32,
    pub exe: PathBuf,
    pub graphics: bool,
    pub mb: u32,
}

pub async fn processes() -> Vec<GpuProc> {
    todo!("P2-32")
}

/// Steam's and Epic's default libraries (from the registry/known folders) plus `_core.gpu.games`.
pub fn game_dirs(store: &Store) -> Vec<PathBuf> {
    todo!("P2-32")
}

pub fn is_game(p: &GpuProc, dirs: &[PathBuf], ours: &[u32]) -> bool {
    todo!("P2-32")
}

pub struct Watch {
    _todo: (),
}

impl Watch {
    /// Polls every 5 s; on a game starting calls `step_aside` once; `game_over` once when it ends.
    pub fn new(store: Arc<Store>, ours: Arc<dyn Fn() -> Vec<u32> + Send + Sync>) -> Watch {
        todo!("P2-32")
    }

    pub async fn run(
        self,
        cancel: CancellationToken,
        step_aside: impl Fn() + Send,
        game_over: impl Fn() + Send,
    ) {
        todo!("P2-32")
    }
}

/// `_core.gpu.headroom_mb`, default 1536.
pub fn headroom_mb(store: &Store) -> u32 {
    todo!("P2-32")
}
