// SPDX-License-Identifier: AGPL-3.0-only
//! `entry.run == "wasm"`: an MCP server compiled to wasm32-wasip1, run in-process (SP-10).
//!
//! What the guest is given, and nothing else:
//! - stdin and stdout: two OS pipes whose host ends are tokio `ChildStdin`/`ChildStdout`, so
//!   `Conn` drives it exactly like a child process. stderr goes nowhere.
//! - args `[id]`, an empty environment, WASI's own clocks and randomness.
//! - one preopened directory, `/data` = the plugin's own dir, only when `own_dir` is `Some`.
//! - no sockets and no name lookups: the WASI context is built without network (the
//!   `WasiCtxBuilder` default), and no `inherit_*` is called.
//! - a linear memory cap (`Limits::memory_mb`) and a fuel budget (`Limits::fuel_per_call`).
//!
//! Wasmtime's epoch interruption is how a hung guest is stopped: `kill` bumps the engine
//! epoch and the guest traps at its next loop header or call. A guest blocked inside a WASI
//! read is not running wasm and only notices once its stdin closes (the host drops its `Conn`
//! on every stop path).

use std::io;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, ReadBuf};
use tokio::process::{ChildStdin, ChildStdout};
use wasmtime::UpdateDeadline;
use wasmtime::{Config, Engine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::p2::pipe::{AsyncReadStream, AsyncWriteStream};
use wasmtime_wasi::p2::{AsyncStdinStream, AsyncStdoutStream, WasiCtxBuilder};
use wasmtime_wasi::preview1::{add_to_linker_sync, WasiP1Ctx};
use wasmtime_wasi::{DirPerms, FilePerms};

use crate::Error;

#[cfg(unix)]
type Owned = std::os::fd::OwnedFd;
#[cfg(windows)]
type Owned = std::os::windows::io::OwnedHandle;

/// How often the engine epoch advances while the guest runs: the granularity of `kill` and of
/// the fuel refill.
const TICK: Duration = Duration::from_millis(25);

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Cap on the guest's linear memory (128 by default).
    pub memory_mb: u32,
    /// Instructions (wasmtime fuel) a call may burn. Refilled to this at the first epoch tick
    /// after the guest was handed new stdin bytes, so it bounds one request, to within a tick.
    pub fuel_per_call: u64,
    /// How long `spawn` waits for the module to compile and instantiate.
    pub start_ms: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            memory_mb: 128,
            fuel_per_call: 50_000_000_000,
            start_ms: 10_000,
        }
    }
}

/// The guest's stdin: marks that fresh input arrived, for the fuel refill.
struct Stdin {
    inner: ChildStdout,
    fresh: Arc<AtomicBool>,
}

impl AsyncRead for Stdin {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let r = Pin::new(&mut self.inner).poll_read(cx, buf);
        if matches!(r, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            self.fresh.store(true, Ordering::Release);
        }
        r
    }
}

struct Data {
    wasi: WasiP1Ctx,
    limits: StoreLimits,
}

pub struct WasmPlugin {
    engine: Engine,
    killed: Arc<AtomicBool>,
    /// The host's ends. `Conn` takes them.
    pub stdin: Option<ChildStdin>,
    pub stdout: Option<ChildStdout>,
    /// The exit code once the guest is done (`None` for a trap or kill).
    done: Option<tokio::sync::oneshot::Receiver<Option<i32>>>,
}

impl WasmPlugin {
    /// Compile and instantiate `module` and run its `_start` on its own thread. Must be called
    /// inside a tokio runtime. `own_dir` is preopened as `/data`; pass it only when the plugin
    /// declared `fs.own_dir`. Waits (async; the compile is on that thread) for at most
    /// `limits.start_ms` while the module compiles.
    pub async fn spawn(
        module: &Path,
        own_dir: Option<&Path>,
        limits: Limits,
    ) -> Result<WasmPlugin, Error> {
        spawn_as(module, own_dir, limits, "plugin").await
    }

    /// `spawn` with the guest's `argv[0]`: the plugin id.
    pub async fn spawn_as(
        module: &Path,
        own_dir: Option<&Path>,
        limits: Limits,
        id: &str,
    ) -> Result<WasmPlugin, Error> {
        spawn_as(module, own_dir, limits, id).await
    }

    /// Stop the guest: it traps at its next epoch check.
    pub fn kill(&self) {
        self.killed.store(true, Ordering::Release);
        self.engine.increment_epoch();
    }

    /// Hands the host's pipe ends to `Conn`.
    pub fn take_stdio(&mut self) -> Option<(ChildStdin, ChildStdout)> {
        Some((self.stdin.take()?, self.stdout.take()?))
    }

    /// Waits up to `grace` for the guest to end by itself (its stdin should already be closed),
    /// then kills it. Returns its exit code if it gave one.
    pub async fn stop(mut self, grace: Duration) -> Option<i32> {
        drop(self.stdin.take());
        let mut done = self.done.take()?;
        if let Ok(r) = tokio::time::timeout(grace, &mut done).await {
            return r.ok().flatten();
        }
        self.kill();
        // A guest stuck outside wasm cannot be interrupted; its thread is left to finish.
        tokio::time::timeout(Duration::from_secs(5), done)
            .await
            .ok()
            .and_then(|r| r.ok())
            .flatten()
    }
}

impl Drop for WasmPlugin {
    fn drop(&mut self) {
        self.kill();
    }
}

fn io_err(e: impl std::fmt::Display) -> Error {
    Error::Io(io::Error::other(e.to_string()))
}

/// Two OS pipes: (host stdin, guest stdout) and (guest stdin, host stdout).
fn pipes() -> io::Result<(ChildStdin, ChildStdout, ChildStdin, ChildStdout)> {
    let (ar, aw) = std::io::pipe()?;
    let (br, bw) = std::io::pipe()?;
    let writer = |w: std::io::PipeWriter| ChildStdin::from_std(Owned::from(w).into());
    let reader = |r: std::io::PipeReader| ChildStdout::from_std(Owned::from(r).into());
    Ok((writer(aw)?, reader(br)?, writer(bw)?, reader(ar)?))
}

thread_local! {
    static START_DELAY: std::cell::Cell<Duration> = const { std::cell::Cell::new(Duration::ZERO) };
}

/// Tests only: every spawn from this thread sleeps `delay` on its compile thread first, to
/// stand in for a slow compile.
#[doc(hidden)]
pub fn set_start_delay(delay: Duration) {
    START_DELAY.set(delay);
}

async fn spawn_as(
    module: &Path,
    own_dir: Option<&Path>,
    limits: Limits,
    id: &str,
) -> Result<WasmPlugin, Error> {
    let mut cfg = Config::new();
    cfg.epoch_interruption(true).consume_fuel(true);
    let engine = Engine::new(&cfg).map_err(io_err)?;

    let (host_in, host_out, guest_out, guest_in) = pipes()?;
    let fresh = Arc::new(AtomicBool::new(false));
    let mut wasi = WasiCtxBuilder::new();
    wasi.args(&[id])
        .stdin(AsyncStdinStream::new(AsyncReadStream::new(Stdin {
            inner: guest_in,
            fresh: Arc::clone(&fresh),
        })))
        .stdout(AsyncStdoutStream::new(AsyncWriteStream::new(
            64 * 1024,
            guest_out,
        )));
    if let Some(dir) = own_dir {
        wasi.preopened_dir(dir, "/data", DirPerms::all(), FilePerms::all())
            .map_err(io_err)?;
    }
    let data = Data {
        wasi: wasi.build_p1(),
        limits: StoreLimitsBuilder::new()
            .memory_size((limits.memory_mb as usize) << 20)
            .instances(1)
            .trap_on_grow_failure(true)
            .build(),
    };

    let killed = Arc::new(AtomicBool::new(false));
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let delay = START_DELAY.get();
    let thread = {
        let (engine, killed, module) = (engine.clone(), Arc::clone(&killed), module.to_path_buf());
        move || {
            let started = |r: Result<(), String>| {
                let _ = ready_tx.send(r);
            };
            std::thread::sleep(delay);
            let mut store = Store::new(&engine, data);
            store.limiter(|d| &mut d.limits);
            let boot = (|| -> wasmtime::Result<(Linker<Data>, Module)> {
                let mut linker = Linker::new(&engine);
                add_to_linker_sync(&mut linker, |d: &mut Data| &mut d.wasi)?;
                Ok((linker, Module::from_file(&engine, &module)?))
            })();
            let (linker, module) = match boot {
                Ok(b) => b,
                Err(e) => return started(Err(format!("{e:#}"))),
            };
            store.set_fuel(limits.fuel_per_call).ok();
            let kill = Arc::clone(&killed);
            store.set_epoch_deadline(1);
            store.epoch_deadline_callback(move |mut cx| {
                if kill.load(Ordering::Acquire) {
                    return Err(wasmtime::Error::msg("the plugin was stopped"));
                }
                if fresh.swap(false, Ordering::AcqRel) {
                    cx.set_fuel(limits.fuel_per_call)?;
                }
                Ok(UpdateDeadline::Continue(1))
            });
            let instance = match linker.instantiate(&mut store, &module) {
                Ok(i) => i,
                Err(e) => return started(Err(format!("{e:#}"))),
            };
            let start = match instance.get_typed_func::<(), ()>(&mut store, "_start") {
                Ok(f) => f,
                Err(e) => return started(Err(format!("{e:#}"))),
            };
            started(Ok(()));
            // The ticker runs while the guest does; dropping `stop` ends it.
            let (stop, stopped) = mpsc::channel::<()>();
            let ticker = {
                let engine = engine.clone();
                std::thread::spawn(move || {
                    while stopped.recv_timeout(TICK) == Err(mpsc::RecvTimeoutError::Timeout) {
                        engine.increment_epoch();
                    }
                })
            };
            let code = match start.call(&mut store, ()) {
                Ok(()) => Some(0),
                Err(e) => e.downcast_ref::<wasmtime_wasi::I32Exit>().map(|x| x.0),
            };
            drop(stop);
            let _ = ticker.join();
            // Closes the guest's stdout, which is what tells the host it is gone.
            drop(store);
            let _ = done_tx.send(code);
        }
    };
    std::thread::Builder::new()
        .name(format!("wasm-{id}"))
        .spawn(thread)?;
    // Async: the compile runs on its own thread, so no runtime worker waits on it.
    match tokio::time::timeout(Duration::from_millis(limits.start_ms), ready_rx).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(e))) => return Err(io_err(e)),
        // The thread ended without a word: it panicked.
        Ok(Err(_)) => return Err(io_err("the module failed to start")),
        Err(_) => {
            engine.increment_epoch();
            killed.store(true, Ordering::Release);
            return Err(io_err("the module took too long to start"));
        }
    }
    Ok(WasmPlugin {
        engine,
        killed,
        stdin: Some(host_in),
        stdout: Some(host_out),
        done: Some(done_rx),
    })
}
