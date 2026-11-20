// SPDX-License-Identifier: AGPL-3.0-only
//! The managed llama.cpp runtime (MO-01, SP-17) and the local jobs D213 allows on the GPU
//! (MO-06, MO-07, the checker). Stub: P2-31 fills the runtime, P2-34 the jobs.
#![allow(unused_variables)] // stub: the filling task removes this

use std::path::PathBuf;
use std::sync::Arc;

use alexia_store::{Layout, MessageBody, Role, Store};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::router::Router;
use crate::{Job, Provider};

pub struct LocalModel {
    pub id: String,
    pub path: PathBuf,
    pub mmproj: Option<PathBuf>,
    pub draft: Option<PathBuf>,
    pub context: u32,
    pub embedding: bool,
}

pub struct Runtime {
    _todo: (),
}

impl Runtime {
    pub fn new(layout: Layout, client: reqwest::Client) -> Arc<Runtime> {
        todo!("P2-31")
    }

    /// Download + verify (SHA-256) + unzip into `layout.cache()/llama/b11146`, once. Progress 0..=100.
    pub async fn ensure(
        &self,
        progress: Option<mpsc::Sender<u8>>,
        cancel: CancellationToken,
    ) -> Result<PathBuf, LocalError> {
        todo!("P2-31")
    }

    /// Start (or reuse) a server for `model`; `gpu_layers` from `gpu::fit` (P2-32). Returns a Provider
    /// whose id is `local:<model.id>`.
    pub async fn serve(
        &self,
        model: &LocalModel,
        gpu_layers: u32,
    ) -> Result<Arc<dyn Provider>, LocalError> {
        todo!("P2-31")
    }

    pub async fn stop(&self, model_id: &str) {
        todo!("P2-31")
    }

    /// D213 / MO-09: stop everything now.
    pub async fn stop_all(&self) {
        todo!("P2-31")
    }

    pub fn pids(&self) -> Vec<u32> {
        todo!("P2-31")
    }

    /// Idle stopper: every minute, stop servers unused for 10 minutes.
    pub async fn run(&self, cancel: CancellationToken) {
        todo!("P2-31")
    }
}

/// Each variant is a sentence the owner can read. P2-31 names them.
#[derive(Debug, thiserror::Error)]
pub enum LocalError {}

pub struct LocalJobs {
    _todo: (),
}

impl LocalJobs {
    pub fn new(runtime: Arc<Runtime>, store: Arc<Store>, router: Arc<Router>) -> Arc<LocalJobs> {
        todo!("P2-34")
    }

    /// Starts the model for the job if needed and registers it with the router (`set_provider`, local).
    pub async fn provider(&self, job: Job) -> Option<Arc<dyn Provider>> {
        todo!("P2-34")
    }

    pub async fn describe(
        &self,
        image_data_url: &str,
        cancel: CancellationToken,
    ) -> Option<String> {
        todo!("P2-34")
    }

    pub async fn embed(
        &self,
        texts: &[String],
        cancel: CancellationToken,
    ) -> Option<Vec<Vec<f32>>> {
        todo!("P2-34")
    }

    /// For `Checker::set_model`.
    pub async fn checker_model(&self) -> Option<(Arc<dyn Provider>, String)> {
        todo!("P2-34")
    }

    /// While true (a game is running) every method returns None at once.
    pub fn set_paused(&self, on: bool) {
        todo!("P2-34")
    }
}

/// Images described locally before a request goes to the cloud (MO-06). `None` (no local jobs
/// wired) returns the messages unchanged. P2-34 fills the `Some` case; until then the messages
/// are returned unchanged either way, so the agent can call this from the start.
pub async fn see_before_cloud(
    jobs: Option<&LocalJobs>,
    messages: Vec<(Role, MessageBody)>,
) -> Vec<(Role, MessageBody)> {
    let _ = jobs;
    messages
}
