// SPDX-License-Identifier: AGPL-3.0-only
//! The safety checker (TR-02). Stub: P2-13 fills it.
#![allow(unused_variables)] // stub: the filling task removes this

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::{Provider, Ruling, Scope, Step};

/// The narrow yes/no questions the checker model answers (v2 `QUESTIONS`). P2-13 ports them.
pub const QUESTIONS: &[&str] = &[];

pub struct GiveUp {
    pub in_a_row: u32,
    pub in_a_session: u32,
}

pub const GIVE_UP: GiveUp = GiveUp {
    in_a_row: 3,
    in_a_session: 20,
};

#[derive(Default)]
pub struct Tally {
    pub in_a_row: u32,
    pub in_a_session: u32,
}

pub struct Review {
    pub answers: Vec<Option<bool>>,
    pub flagged: bool,
    pub why: Option<String>,
}

/// `model`: the local checker model (P2-34) as a Provider and its id. None: no checker can run.
pub struct Checker {
    _todo: (),
}

impl Checker {
    pub fn new(model: Option<(Arc<dyn Provider>, String)>) -> Checker {
        todo!("P2-13")
    }

    pub fn set_model(&self, model: Option<(Arc<dyn Provider>, String)>) {
        todo!("P2-13")
    }

    /// None when no model can run now; the caller then asks the owner instead.
    pub async fn review(
        &self,
        step: &Step,
        task: &str,
        scope: &Scope,
        cancel: CancellationToken,
    ) -> Option<Review> {
        todo!("P2-13")
    }
}

pub fn read_answers(said: &str) -> Review {
    todo!("P2-13")
}

pub fn as_ruling(review: &Review, step: &Step, tally: &Tally) -> Ruling {
    todo!("P2-13")
}

pub fn counted(tally: Tally, review: &Review) -> Tally {
    todo!("P2-13")
}

pub fn given_up(tally: &Tally) -> bool {
    todo!("P2-13")
}
