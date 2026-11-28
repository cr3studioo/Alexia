// SPDX-License-Identifier: AGPL-3.0-only
//! Which paired devices are online, and how they are reached.

use crate::{DeviceId, Ms};
use std::process::Stdio;

/// The window inside which a device counts as "where the owner is" (5 min).
pub const WINDOW_MS: u64 = 300_000;

/// How long since the owner touched this device, and whether it is locked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Idle {
    pub idle_ms: u64,
    pub locked: bool,
}

/// Where the owner is (D-P4-7).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Here {
    Device(DeviceId),
    Channel { channel: String, chat: String },
}

/// One device's last report, taken at `at`.
pub struct Seen {
    pub device: DeviceId,
    pub idle_ms: u64,
    pub locked: bool,
    pub at: Ms,
}

/// The last message the owner sent on a channel.
pub struct Said {
    pub channel: String,
    pub chat: String,
    pub at: Ms,
}

/// The device with the smallest idle within `window_ms`, ties to the earliest in `devices`
/// (the caller passes the hub first); else the channel the owner last wrote on; else None.
/// A report's idle grows by its age (`now - at`); a locked device counts as idle `u64::MAX`.
pub fn here(devices: &[Seen], last_said: Option<&Said>, now: Ms, window_ms: u64) -> Option<Here> {
    let best = devices
        .iter()
        .map(|d| {
            let idle = if d.locked {
                u64::MAX
            } else {
                d.idle_ms
                    .saturating_add(now.saturating_sub(d.at).max(0) as u64)
            };
            (idle, d)
        })
        .filter(|(idle, _)| *idle <= window_ms)
        .min_by_key(|(idle, _)| *idle); // min_by_key keeps the first of equals
    match (best, last_said) {
        (Some((_, d)), _) => Some(Here::Device(d.device.clone())),
        (None, Some(s)) => Some(Here::Channel {
            channel: s.channel.clone(),
            chat: s.chat.clone(),
        }),
        (None, None) => None,
    }
}

/// Run a command and return its stdout; None if it fails, times out or cannot start.
pub(crate) async fn run(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let out = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output())
        .await
        .ok()?
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Locked = the lock screen's process (LogonUI) is running.
#[cfg(windows)]
const PS: &str = r#"Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class I{[StructLayout(LayoutKind.Sequential)]public struct L{public uint s;public uint t;}[DllImport("user32.dll")]static extern bool GetLastInputInfo(ref L p);public static long Ms(){L l=new L();l.s=8;if(!GetLastInputInfo(ref l))return -1;return (long)(uint)Environment.TickCount-(long)l.t;}}'; $m=[I]::Ms(); $k=[int]($null -ne (Get-Process LogonUI -ErrorAction SilentlyContinue)); "$m $k""#;

/// This device's idle time and lock state. None if it cannot be read (or on other platforms).
pub async fn idle_now() -> Option<Idle> {
    #[cfg(windows)]
    {
        let out = run(
            "powershell.exe",
            &["-NoProfile", "-NonInteractive", "-Command", PS],
        )
        .await?;
        let mut it = out.split_whitespace();
        let ms: i64 = it.next()?.parse().ok()?;
        if ms < 0 {
            return None; // GetLastInputInfo failed
        }
        let locked = it.next()? == "1";
        Some(Idle {
            idle_ms: ms as u64,
            locked,
        })
    }
    #[cfg(target_os = "macos")]
    {
        let hid = run("ioreg", &["-c", "IOHIDSystem"]).await?;
        let ns: u64 = hid
            .lines()
            .find(|l| l.contains("HIDIdleTime"))?
            .rsplit('=')
            .next()?
            .trim()
            .parse()
            .ok()?;
        let root = run("ioreg", &["-n", "Root", "-d1"])
            .await
            .unwrap_or_default();
        let locked = root
            .lines()
            .any(|l| l.contains("CGSSessionScreenIsLocked") && l.trim_end().ends_with("Yes"));
        Some(Idle {
            idle_ms: ns / 1_000_000,
            locked,
        })
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        None
    }
}
