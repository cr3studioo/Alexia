// SPDX-License-Identifier: AGPL-3.0-only
use std::process::Command;

#[test]
fn hub_binary_runs() {
    let status = Command::new(env!("CARGO_BIN_EXE_alexia-hub"))
        .status()
        .expect("spawn alexia-hub");
    assert!(status.success());
}
