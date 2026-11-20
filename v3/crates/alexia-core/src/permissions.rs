// SPDX-License-Identifier: AGPL-3.0-only
//! Permission modes, scope, never-touch paths and spoken boundaries (TR-01). Stub: P2-12 fills it.
#![allow(unused_variables)] // stub: the filling task removes this

use std::path::{Path, PathBuf};

use alexia_mcp::types::ToolAnnotations;
use alexia_store::{Ms, Store};
use serde_json::{Map, Value};

use crate::{Boundary, Result, Ruling, Scope};

/// One call, as the rules see it.
pub struct CallAsk<'a> {
    pub tool: &'a str,
    pub words: &'a str,
    pub annotations: Option<&'a ToolAnnotations>,
    pub paths: Vec<PathBuf>,
    pub reviewed: bool,
}

/// Shown when the owner lets Alexia work everywhere. P2-12 writes the sentence.
pub const EVERYWHERE_WARNING: &str = "";

pub fn rule(ask: &CallAsk, scope: &Scope) -> Ruling {
    todo!("P2-12")
}

pub fn never_touch_list(data_dir: &Path) -> Vec<PathBuf> {
    todo!("P2-12")
}

pub fn never_touch(path: &Path, data_dir: &Path) -> bool {
    todo!("P2-12")
}

pub fn within(parent: &Path, path: &Path) -> bool {
    todo!("P2-12")
}

/// Absolute paths an argument object names (v2 `pathsIn`).
pub fn paths_in(args: &Map<String, Value>) -> Vec<PathBuf> {
    todo!("P2-12")
}

/// "don't delete anything" → a Boundary; None if the sentence is not one.
pub fn heard(said: &str, at: Ms) -> Option<Boundary> {
    todo!("P2-12")
}

pub fn lifts(said: &str) -> bool {
    todo!("P2-12")
}

pub fn boundary_ack(b: &Boundary) -> String {
    todo!("P2-12")
}

/// From the store: `_core.mode` (v2's kebab names), `_core.scope` {roots, everywhere},
/// `_core.boundaries`. Missing → AskRisky, no roots.
pub fn scope(store: &Store, data_dir: &Path) -> Scope {
    todo!("P2-12")
}

pub fn save_boundaries(store: &Store, b: &[Boundary]) -> Result<()> {
    todo!("P2-12")
}

pub fn roots_of(scope: &Scope) -> Vec<alexia_mcp::types::Root> {
    todo!("P2-12")
}
