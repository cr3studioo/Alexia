// SPDX-License-Identifier: AGPL-3.0-only
//! The per-device process: exposes the device to the hub as an MCP server over the mesh.

use std::process::ExitCode;

mod cli;
mod serve;
mod service;

#[tokio::main]
async fn main() -> ExitCode {
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .try_init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    cli::main(&args).await
}
