// SPDX-License-Identifier: AGPL-3.0-only
//! The trace of a run, the runs table and the audit log (TR-08, AC-12). Stub: P2-19 fills it.
#![allow(unused_variables)] // stub: the filling task removes this

use std::sync::Arc;

use alexia_store::{Ms, SessionId, Store};

use crate::{Bus, Origin, Phase, Result, RunEnd, RunId, Step};

pub struct Trace {
    _todo: (),
}

impl Trace {
    pub fn begin(
        store: Arc<Store>,
        bus: Bus,
        run: RunId,
        session: SessionId,
        origin: Origin,
        background: bool,
        parent: Option<RunId>,
    ) -> Result<Trace> {
        todo!("P2-19")
    }

    pub fn phase(&self, p: Phase) {
        todo!("P2-19")
    }

    pub fn model(&self, asked: &str, answered: &str, first_byte_ms: Option<u32>) {
        todo!("P2-19")
    }

    pub fn note(&self, line: &str) {
        todo!("P2-19")
    }

    /// `live_touch`, `RunStep`.
    pub fn step(&self, step: &Step) {
        todo!("P2-19")
    }

    /// One audit row. `gate`: "run" | "ask" | "blocked" | "checker".
    pub fn audited(
        &self,
        step: &Step,
        plugin: Option<&str>,
        gate: &str,
        decision: &str,
        why: Option<&str>,
    ) -> Result<i64> {
        todo!("P2-19")
    }

    /// `save_run`, `live_end`, `RunEnded`.
    pub fn end(self, end: &RunEnd) -> Result<()> {
        todo!("P2-19")
    }
}

pub struct ActivityRow {
    pub at: Ms,
    pub run: String,
    pub tool: String,
    pub decision: String,
    pub ok: Option<bool>,
    pub summary: String,
}

pub fn activity(store: &Store, query: Option<&str>, limit: u32) -> Result<Vec<ActivityRow>> {
    todo!("P2-19")
}

/// v2 `asText`: the run as a person reads it, step by step with each decision and why.
pub fn replay(store: &Store, run: &str) -> Result<Option<String>> {
    todo!("P2-19")
}
