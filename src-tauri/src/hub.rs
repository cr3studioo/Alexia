// SPDX-License-Identifier: AGPL-3.0-only
//! The Rust hub as the shell sees it (P2D-13): where it says it is, whether it answers, where its
//! binary is, and how one this shell started is stopped. Nothing here decides anything about
//! what the hub does; it only finds it, or starts the same binary again.

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use tauri_plugin_shell::process::CommandChild;

/// What the starting page says when neither a bundled hub nor `ALEXIA_HUB_EXE` exists.
pub const NOT_FOUND: &str = "Alexia's hub was not found, so she cannot start. Reinstalling Alexia puts it back.";

/// Who the hub running behind the windows belongs to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Held {
    /// This shell spawned it and holds the child.
    Started,
    /// Somebody else started it (Task Scheduler, a console); the windows only point at it.
    Attached,
    /// None yet, or the last one could not be started.
    Nothing,
}

/// Quit and *Try again* stop a hub only if this shell started it. An attached hub serves
/// Telegram and whoever else is using it; it is not ours to end.
pub fn ours(held: Held) -> bool {
    held == Held::Started
}

/// `window.json` in the hub's data folder: `ALEXIA_V3_DATA` when absolute, else
/// `<local data>/AlexiaHub` — the same rule as `alexia_store::data_dir`.
pub fn window_json(local_data: Option<PathBuf>) -> Option<PathBuf> {
    let data = std::env::var_os("ALEXIA_V3_DATA").map(PathBuf::from).filter(|dir| dir.is_absolute());
    Some(data.or_else(|| local_data.map(|base| base.join("AlexiaHub")))?.join("window.json"))
}

/// `{"port":u16,"pid":u32}`: the port, if the text is that and process `pid` is `alive`.
pub fn parse_window_json(text: &str, alive: impl Fn(u32) -> bool) -> Option<u16> {
    #[derive(serde::Deserialize)]
    struct Window {
        port: u16,
        pid: u32,
    }
    let window: Window = serde_json::from_str(text).ok()?;
    (window.port != 0 && alive(window.pid)).then_some(window.port)
}

/// The port in the file at `path`, under the same conditions; None when there is no file.
pub fn port_in(path: &Path, alive: impl Fn(u32) -> bool) -> Option<u16> {
    parse_window_json(&std::fs::read_to_string(path).ok()?, alive)
}

/// A hub already running on this PC: its `window.json` names a live process and its port answers.
pub fn find(local_data: Option<PathBuf>) -> Option<u16> {
    port_in(&window_json(local_data)?, alive).filter(|port| answers(*port))
}

/// Something is listening on `127.0.0.1:<port>`, asked for at most a second.
pub fn answers(port: u16) -> bool {
    TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(1)).is_ok()
}

/// The hub binary: the bundled one, else `ALEXIA_HUB_EXE` for an unbundled dev run, else None.
pub fn exe(resources: &Path) -> Option<PathBuf> {
    let bundled = resources.join("hub").join(format!("alexia-hub{}", std::env::consts::EXE_SUFFIX));
    let named = || std::env::var_os("ALEXIA_HUB_EXE").map(PathBuf::from).filter(|path| path.is_file());
    Some(bundled).filter(|path| path.is_file()).or_else(named)
}

/// Stop a hub this shell started. Its stdin closing is its stop (`ALEXIA_HUB_STOP_ON_EOF`), so it
/// stops its plugins and records a clean stop; one still there after eight seconds is killed.
pub fn stop(hub: CommandChild) {
    let (pid, until) = (hub.pid(), Instant::now() + Duration::from_secs(8));
    drop(hub);
    while alive(pid) && Instant::now() < until {
        thread::sleep(Duration::from_millis(250));
    }
    if alive(pid) {
        let _ = quiet(if cfg!(windows) { "taskkill" } else { "kill" }, &kill_args(pid)).status();
    }
}

fn kill_args(pid: u32) -> Vec<String> {
    let pid = pid.to_string();
    if cfg!(windows) { vec!["/F".into(), "/T".into(), "/PID".into(), pid] } else { vec!["-9".into(), pid] }
}

/// A helper process with no console window and nothing on our stdout.
fn quiet(program: &str, args: &[String]) -> Command {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
    command
}

/// Process `pid` exists.
pub fn alive(pid: u32) -> bool {
    if cfg!(windows) {
        let args = ["/FI".into(), format!("PID eq {pid}"), "/FO".into(), "CSV".into(), "/NH".into()];
        quiet("tasklist", &args).output().is_ok_and(|out| String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\"")))
    } else {
        quiet("kill", &["-0".into(), pid.to_string()]).status().is_ok_and(|status| status.success())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_good_window_json_with_a_live_pid_gives_its_port() {
        assert_eq!(parse_window_json(r#"{"port":51234,"pid":4321}"#, |pid| pid == 4321), Some(51234));
    }

    #[test]
    fn a_missing_window_json_or_field_gives_nothing() {
        let nowhere = std::env::temp_dir().join("alexia-p2d13-no-such-dir").join("window.json");
        assert_eq!(port_in(&nowhere, |_| true), None);
        assert_eq!(parse_window_json(r#"{"pid":4321}"#, |_| true), None);
        assert_eq!(parse_window_json(r#"{"port":51234}"#, |_| true), None);
        assert_eq!(parse_window_json("", |_| true), None);
    }

    #[test]
    fn a_malformed_window_json_gives_nothing() {
        for text in [r#"{"port":51234,"pid":"#, "port=51234", r#"{"port":70000,"pid":1}"#, r#"{"port":0,"pid":1}"#, r#"{"port":-1,"pid":1}"#] {
            assert_eq!(parse_window_json(text, |_| true), None, "{text}");
        }
    }

    #[test]
    fn a_stale_pid_gives_nothing() {
        assert_eq!(parse_window_json(r#"{"port":51234,"pid":4321}"#, |_| false), None);
    }

    #[test]
    fn the_file_on_disk_is_read_the_same_way() {
        let dir = std::env::temp_dir().join(format!("alexia-p2d13-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("window.json");
        std::fs::write(&path, format!(r#"{{"port":40404,"pid":{}}}"#, std::process::id())).unwrap();
        assert_eq!(port_in(&path, alive), Some(40404), "this test's own pid is alive");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_pid_that_is_not_running_is_not_alive() {
        assert!(alive(std::process::id()));
        assert!(!alive(u32::MAX - 1));
    }

    #[test]
    fn only_a_hub_this_shell_started_is_stopped() {
        assert!(ours(Held::Started));
        assert!(!ours(Held::Attached));
        assert!(!ours(Held::Nothing));
    }
}
