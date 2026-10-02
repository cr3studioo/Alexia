// SPDX-License-Identifier: AGPL-3.0-only

//! The sidecar. Takes a secret, says one line on stdout, and runs until its stdin closes.
//!
//! **The secret.** From `ALEXIA_CONNECT_SECRET`, or else the first line of stdin — never from
//! the command line, which every process on the machine can read. It is taken out of the
//! environment before anything else starts, and it is not logged.
//!
//! **The line.** `{"ready":true,"protocol":1,"port":…,"endpointId":"…"}` once the loopback port
//! is listening, or `{"ready":false,"error":{…}}` and a non-zero exit. Nothing else is ever
//! written to stdout; logs go to stderr.
//!
//! **The end.** Stdin closing is the parent going away, and this process goes with it, so a
//! crashed Alexia does not leave an endpoint answering for it.

use std::io::{BufRead, Read, Write};
use std::process::ExitCode;

use alexia_connect::constants::{ENV_EPHEMERAL, ENV_LOG, ENV_LOOPBACK_HINTS, ENV_SECRET, PROTOCOL, SECRET_MIN};
use alexia_connect::{identity, pairing, Network, Options, StartError};
use serde_json::json;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

fn main() -> ExitCode {
    let secret = secret();
    logging();
    match run(secret) {
        Ok(()) => ExitCode::SUCCESS,
        Err(StartError { code, message }) => {
            say(&json!({ "ready": false, "error": { "code": code, "message": message } }));
            ExitCode::FAILURE
        }
    }
}

/// Before any thread exists, so that taking the variable out of the environment is sound and
/// nothing started later can inherit it.
fn secret() -> Option<String> {
    let secret = match std::env::var(ENV_SECRET) {
        Ok(secret) => secret,
        Err(_) => {
            let mut line = String::new();
            std::io::stdin().lock().read_line(&mut line).ok()?;
            line.trim_end_matches(['\r', '\n']).to_owned()
        }
    };
    std::env::remove_var(ENV_SECRET);
    Some(secret).filter(|secret| secret.len() >= SECRET_MIN && secret.bytes().all(|byte| byte.is_ascii_graphic()))
}

/// To stderr, and only what `alexia_connect::logged` lets through.
fn logging() {
    let level = match std::env::var(ENV_LOG).as_deref() {
        Ok("off") => LevelFilter::OFF,
        Ok("error") => LevelFilter::ERROR,
        Ok("warn") => LevelFilter::WARN,
        Ok("debug") => LevelFilter::DEBUG,
        _ => LevelFilter::INFO,
    };
    let lines = tracing_subscriber::fmt::layer().with_writer(std::io::stderr);
    tracing_subscriber::registry().with(lines).with(alexia_connect::logged(level)).init();
}

fn run(secret: Option<String>) -> Result<(), StartError> {
    let failed = |code: &'static str| move |message: String| StartError { code, message };
    let secret = secret.ok_or_else(|| failed("secret_missing")(format!("no secret of {SECRET_MIN} or more visible characters")))?;
    let network = Network::from_env().map_err(failed("config_invalid"))?;
    let mut pairing = pairing::Settings::from_env().map_err(failed("config_invalid"))?;
    pairing.loopback_hints = cfg!(debug_assertions) && std::env::var(ENV_LOOPBACK_HINTS).as_deref() == Ok("1");
    let key = match cfg!(debug_assertions) && std::env::var(ENV_EPHEMERAL).as_deref() == Ok("1") {
        true => iroh::SecretKey::generate(),
        false => identity::load_or_create(&identity::service()).map_err(failed("keychain_failed"))?,
    };

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|error| failed("bind_failed")(error.to_string()))?;
    runtime.block_on(async {
        let running = alexia_connect::start(Options { secret, key, network, pairing }).await?;
        say(&json!({ "ready": true, "protocol": PROTOCOL, "port": running.port(), "endpointId": running.endpoint_id() }));

        // A thread, not a task: a blocked read of stdin would hold the runtime open at exit.
        let (gone, parent_gone) = tokio::sync::oneshot::channel::<()>();
        std::thread::spawn(move || {
            let _ = std::io::stdin().lock().bytes().last();
            let _ = gone.send(());
        });
        tokio::select! {
            _ = parent_gone => {}
            () = running.stopped() => {}
        }
        running.close().await;
        Ok(())
    })
}

fn say(line: &serde_json::Value) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{line}");
    let _ = stdout.flush();
}
