// SPDX-License-Identifier: AGPL-3.0-only
//! The hub watchdog: heartbeat, offline-gap sentence, in-hub restart with backoff, and the
//! Windows Task Scheduler task that brings the hub back after a reboot or a crash.
// P1-17 wires these into main.rs; until then the binary does not call them.
#![allow(dead_code)]

use alexia_store::{Ms, Store};
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio_util::sync::CancellationToken;

pub const TASK_NAME: &str = "Alexia hub";
/// kv `_core/hub_alive` (Ms, every minute) and `_core/hub_clean_stop` (Ms, on clean shutdown).
pub const HEARTBEAT_MS: u64 = 60_000;

const NS: &str = "_core";
const ALIVE: &str = "hub_alive";
const CLEAN: &str = "hub_clean_stop";
const GAP_MS: Ms = 3 * 60_000;
const DAY_MS: i64 = 86_400_000;

fn get(store: &Store, key: &str) -> Option<Ms> {
    store
        .kv_get(NS, key)
        .ok()
        .flatten()
        .and_then(|v| v.as_i64())
}

fn put(store: &Store, key: &str, now: Ms) {
    if let Err(e) = store.kv_set(NS, key, &serde_json::json!(now)) {
        tracing::warn!("I could not write {key} to the store: {e}");
    }
}

/// Local UTC offset in minutes. Windows asks PowerShell once (only at boot); elsewhere UTC.
// ponytail: no tz crate in the workspace; the offset is today's, so a gap across a DST change
// is shown an hour off. Add a tz crate when the hub needs more than this one sentence.
fn local_offset_minutes() -> i64 {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "[int][TimeZoneInfo]::Local.GetUtcOffset([DateTime]::UtcNow).TotalMinutes",
            ])
            .output();
        if let Some(m) = out
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.trim().parse().ok())
        {
            return m;
        }
    }
    0
}

/// Civil date and time of a local instant (Howard Hinnant's days-to-date algorithm).
fn civil(ms: Ms, offset_min: i64) -> (i64, i64, i64, i64, i64) {
    let local = ms + offset_min * 60_000;
    let days = local.div_euclid(DAY_MS);
    let rem = local.rem_euclid(DAY_MS) / 60_000;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d, rem / 60, rem % 60)
}

fn gap_sentence(alive: Ms, now: Ms, offset_min: i64) -> String {
    let day = |ms: Ms| (ms + offset_min * 60_000).div_euclid(DAY_MS);
    let at = |ms: Ms| {
        let (y, mo, d, h, mi) = civil(ms, offset_min);
        if day(ms) == day(now) {
            format!("{h:02}:{mi:02}")
        } else {
            format!("{y}-{mo:02}-{d:02} {h:02}:{mi:02}")
        }
    };
    format!("I was offline from {} to {}.", at(alive), at(now))
}

/// At boot: if the last heartbeat is older than 3 minutes and later than the last clean stop,
/// the sentence to say ("I was offline from 14:02 to 14:31."), local time, day added when it
/// isn't today. `None` otherwise.
pub fn offline_gap(store: &Store, now: Ms) -> Option<String> {
    offline_gap_at(store, now, local_offset_minutes())
}

fn offline_gap_at(store: &Store, now: Ms, offset_min: i64) -> Option<String> {
    let alive = get(store, ALIVE)?;
    if now - alive <= GAP_MS || get(store, CLEAN).is_some_and(|c| c >= alive) {
        return None;
    }
    Some(gap_sentence(alive, now, offset_min))
}

fn now_ms() -> Ms {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as Ms)
}

/// Writes `hub_alive` now and every HEARTBEAT_MS until cancelled.
pub async fn heartbeat(store: Arc<Store>, cancel: CancellationToken) {
    let mut tick = tokio::time::interval(Duration::from_millis(HEARTBEAT_MS));
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tick.tick() => put(&store, ALIVE, now_ms()),
        }
    }
}

pub fn clean_stop(store: &Store, now: Ms) {
    put(store, CLEAN, now);
}

/// Run `f` until cancelled; when it returns or errors, log and run it again after 1 s doubling
/// to 60 s (reset after 10 minutes up). For the gateway, catalog refresh and bridge loops.
pub async fn supervise<F, Fut>(name: &'static str, cancel: CancellationToken, f: F)
where
    F: FnMut(CancellationToken) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    supervise_with(name, cancel, f, Duration::from_secs(1)).await
}

/// `unit` is the 1 s of the spec; tests shrink it (tokio's `test-util` clock is not enabled).
async fn supervise_with<F, Fut>(
    name: &'static str,
    cancel: CancellationToken,
    mut f: F,
    unit: Duration,
) where
    F: FnMut(CancellationToken) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let mut delay = unit;
    while !cancel.is_cancelled() {
        let started = Instant::now();
        let result = tokio::select! {
            _ = cancel.cancelled() => return,
            r = f(cancel.child_token()) => r,
        };
        if cancel.is_cancelled() {
            return;
        }
        if started.elapsed() >= unit * 600 {
            delay = unit;
        }
        match result {
            Err(e) => tracing::warn!("{name} stopped: {e}. Starting it again in {delay:?}."),
            Ok(()) => tracing::warn!("{name} ended. Starting it again in {delay:?}."),
        }
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(delay) => {}
        }
        delay = (delay * 2).min(unit * 60);
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The Task Scheduler XML for `exe` (boot trigger + logon trigger, restart on failure every
/// minute up to 999 times, no execution time limit, run whether the user is logged on or not,
/// highest privileges off, `run` as the argument, working dir = exe's folder).
pub fn task_xml(exe: &Path, user: &str) -> String {
    let dir = exe
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let (exe, dir, user) = (
        xml_escape(&exe.display().to_string()),
        xml_escape(&dir),
        xml_escape(user),
    );
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Starts the Alexia hub at boot and restarts it if it stops.</Description></RegistrationInfo>
  <Triggers>
    <BootTrigger><Enabled>true</Enabled></BootTrigger>
    <LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>{user}</UserId><LogonType>Password</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>{exe}</Command><Arguments>run</Arguments><WorkingDirectory>{dir}</WorkingDirectory></Exec>
  </Actions>
</Task>
"#
    )
}

#[cfg(not(windows))]
pub fn install() -> Result<(), String> {
    Err("Only on Windows for now.".into())
}

#[cfg(not(windows))]
pub fn uninstall() -> Result<(), String> {
    Err("Only on Windows for now.".into())
}

#[cfg(windows)]
fn schtasks(args: &[&str]) -> Result<(), String> {
    // Inherit stdio: `/RP` makes schtasks ask for the password in the owner's terminal, and this
    // code never sees it.
    let status = std::process::Command::new("schtasks")
        .args(args)
        .status()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => "I could not find schtasks.exe. Task Scheduler is part of Windows; check that the Windows System32 folder is on the PATH.".to_string(),
            _ => format!("I could not run schtasks: {e}"),
        })?;
    if status.success() {
        Ok(())
    } else {
        Err("Run this from an Administrator terminal: Task Scheduler needs it to start the hub at boot.".into())
    }
}

#[cfg(windows)]
pub fn install() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("I could not find my own path: {e}"))?;
    let var = |k| std::env::var(k).unwrap_or_default();
    let user = format!("{}\\{}", var("USERDOMAIN"), var("USERNAME"));
    let xml = task_xml(&exe, &user);
    let mut bytes = vec![0xFF, 0xFE];
    bytes.extend(xml.encode_utf16().flat_map(u16::to_le_bytes));
    let file = std::env::temp_dir().join("alexia-hub-task.xml");
    std::fs::write(&file, bytes).map_err(|e| format!("I could not write the task file: {e}"))?;
    let path = file.display().to_string();
    let created = schtasks(&[
        "/Create", "/TN", TASK_NAME, "/XML", &path, "/RU", &user, "/RP",
    ]);
    let _ = std::fs::remove_file(&file);
    created?;
    schtasks(&["/Run", "/TN", TASK_NAME])
}

#[cfg(windows)]
pub fn uninstall() -> Result<(), String> {
    schtasks(&["/Delete", "/TN", TASK_NAME, "/F"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    // 2023-11-14 22:13:20 UTC.
    const NOW: Ms = 1_700_000_000_000;

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    #[test]
    fn no_gap_on_first_boot() {
        assert_eq!(offline_gap_at(&store(), NOW, 0), None);
    }

    #[test]
    fn no_gap_after_clean_stop() {
        let s = store();
        put(&s, ALIVE, NOW - 40 * 60_000);
        clean_stop(&s, NOW - 39 * 60_000);
        assert_eq!(offline_gap_at(&s, NOW, 0), None);
    }

    #[test]
    fn gap_after_crash_is_a_sentence() {
        let s = store();
        put(&s, ALIVE, NOW - 40 * 60_000);
        assert_eq!(
            offline_gap_at(&s, NOW, 0).unwrap(),
            "I was offline from 21:33 to 22:13."
        );
        // Two hours ahead of UTC pushes the heartbeat to the day before "now", so its date is shown.
        assert_eq!(
            offline_gap_at(&s, NOW, 120).unwrap(),
            "I was offline from 2023-11-14 23:33 to 00:13."
        );
        // A heartbeat only 2 minutes old is not a gap.
        put(&s, ALIVE, NOW - 2 * 60_000);
        assert_eq!(offline_gap_at(&s, NOW, 0), None);
    }

    #[tokio::test]
    async fn supervise_restarts_with_backoff() {
        let unit = Duration::from_millis(40);
        let calls = Arc::new(Mutex::new(Vec::<Instant>::new()));
        let cancel = CancellationToken::new();
        let c2 = calls.clone();
        let task = tokio::spawn(supervise_with(
            "test",
            cancel.clone(),
            move |token: CancellationToken| {
                let mut v = c2.lock().unwrap();
                v.push(Instant::now());
                let n = v.len();
                async move {
                    if n <= 3 {
                        Err("boom".to_string())
                    } else {
                        token.cancelled().await;
                        Ok(())
                    }
                }
            },
            unit,
        ));
        tokio::time::timeout(Duration::from_secs(30), async {
            while calls.lock().unwrap().len() < 4 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(30), task)
            .await
            .unwrap()
            .unwrap();
        let t = calls.lock().unwrap().clone();
        assert_eq!(t.len(), 4);
        for (i, want) in [1u32, 2, 4].into_iter().enumerate() {
            assert!(t[i + 1] - t[i] >= unit * want, "gap {i} was too short");
        }
    }

    #[tokio::test]
    async fn supervise_stops_on_cancel() {
        let cancel = CancellationToken::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let c2 = calls.clone();
        let task = tokio::spawn(supervise("test", cancel.clone(), move |token| {
            c2.fetch_add(1, Ordering::SeqCst);
            async move {
                token.cancelled().await;
                Ok(())
            }
        }));
        tokio::time::sleep(Duration::from_millis(100)).await;
        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(30), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn task_xml_has_triggers_and_restart() {
        let xml = task_xml(Path::new(r"C:\Tom & Jerry\<hub>\alexia-hub.exe"), r"PC\vac");
        for want in [
            "<BootTrigger>",
            "<LogonTrigger>",
            "<RestartOnFailure>",
            "<Arguments>run</Arguments>",
            r"C:\Tom &amp; Jerry\&lt;hub&gt;\alexia-hub.exe",
            r"<WorkingDirectory>C:\Tom &amp; Jerry\&lt;hub&gt;</WorkingDirectory>",
            "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
        ] {
            assert!(xml.contains(want), "missing {want}");
        }
    }
}
