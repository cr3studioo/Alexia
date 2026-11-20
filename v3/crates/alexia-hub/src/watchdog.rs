// SPDX-License-Identifier: AGPL-3.0-only
//! The hub watchdog: heartbeat, offline-gap sentence, in-hub restart with backoff, and the
//! Windows Task Scheduler task that brings the hub back after a reboot or a crash.
// P1-17 wires these into main.rs; until then the binary does not call them.

use alexia_store::{civil_utc, now_ms, Ms, Store};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
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
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-Command",
            "[int][TimeZoneInfo]::Local.GetUtcOffset([DateTime]::UtcNow).TotalMinutes",
        ])
        .creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash under Task Scheduler
        let out = cmd.output();
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
    let (y, m, d, h, mi, _) = civil_utc(ms + offset_min * 60_000);
    (y, m, d, h, mi)
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
    offline_gap_at(store, now, local_offset_minutes)
}

/// `offset_min` is only called once a gap has been found, so a normal boot spawns nothing.
fn offline_gap_at(store: &Store, now: Ms, offset_min: impl FnOnce() -> i64) -> Option<String> {
    let alive = get(store, ALIVE)?;
    if now - alive <= GAP_MS || get(store, CLEAN).is_some_and(|c| c >= alive) {
        return None;
    }
    Some(gap_sentence(alive, now, offset_min()))
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

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The Task Scheduler XML for `exe` (boot trigger + logon trigger, each repeating every minute so a killed hub is started again; restart on failure every
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
    <BootTrigger><Repetition><Interval>PT1M</Interval></Repetition><Enabled>true</Enabled></BootTrigger>
    <LogonTrigger><Repetition><Interval>PT1M</Interval></Repetition><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger>
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

/// The sentence for a failed schtasks step (`/Create`, `/Run`, ...).
fn schtasks_error(step: &str, code: Option<i32>, stderr: &str) -> String {
    let code = code.map_or("none".to_string(), |c| c.to_string());
    let text = stderr.trim();
    if text.to_lowercase().contains("access is denied") {
        "Run this from an Administrator terminal: Task Scheduler needs it to start the hub at boot."
            .into()
    } else if step == "/Run" {
        format!("The task was registered but did not start (schtasks exit code {code}). {text}")
    } else {
        format!("schtasks {step} failed with exit code {code}. {text}")
    }
}

/// Account name for the task: `DOMAIN\user`, else `COMPUTER\user`, else just `user`.
fn user_id(domain: &str, computer: &str, user: &str) -> String {
    match [domain, computer].into_iter().find(|d| !d.is_empty()) {
        Some(d) if !user.is_empty() => format!("{d}\\{user}"),
        _ => user.to_string(),
    }
}

#[cfg(windows)]
fn schtasks(args: &[&str]) -> Result<(), String> {
    // Inherit stdin/stdout: `/RP` makes schtasks ask for the password in the owner's terminal,
    // and this code never sees it. Only stderr is read, to tell access denied from other errors.
    let out = std::process::Command::new("schtasks")
        .args(args)
        .stderr(std::process::Stdio::piped())
        .spawn()
        .and_then(|c| c.wait_with_output())
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => "I could not find schtasks.exe. Task Scheduler is part of Windows; check that the Windows System32 folder is on the PATH.".to_string(),
            _ => format!("I could not run schtasks: {e}"),
        })?;
    if out.status.success() {
        Ok(())
    } else {
        let step = args.first().copied().unwrap_or("");
        let stderr = String::from_utf8_lossy(&out.stderr);
        Err(schtasks_error(step, out.status.code(), &stderr))
    }
}

#[cfg(windows)]
pub fn install() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("I could not find my own path: {e}"))?;
    let var = |k| std::env::var(k).unwrap_or_default();
    let user = user_id(&var("USERDOMAIN"), &var("COMPUTERNAME"), &var("USERNAME"));
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

    // 2023-11-14 22:13:20 UTC.
    const NOW: Ms = 1_700_000_000_000;

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    #[test]
    fn no_gap_on_first_boot() {
        assert_eq!(offline_gap_at(&store(), NOW, || 0), None);
    }

    #[test]
    fn no_gap_after_clean_stop() {
        let s = store();
        put(&s, ALIVE, NOW - 40 * 60_000);
        clean_stop(&s, NOW - 39 * 60_000);
        assert_eq!(offline_gap_at(&s, NOW, || 0), None);
    }

    #[test]
    fn gap_after_crash_is_a_sentence() {
        let s = store();
        put(&s, ALIVE, NOW - 40 * 60_000);
        assert_eq!(
            offline_gap_at(&s, NOW, || 0).unwrap(),
            "I was offline from 21:33 to 22:13."
        );
        // Two hours ahead of UTC pushes the heartbeat to the day before "now", so its date is shown.
        assert_eq!(
            offline_gap_at(&s, NOW, || 120).unwrap(),
            "I was offline from 2023-11-14 23:33 to 00:13."
        );
        // A heartbeat only 2 minutes old is not a gap.
        put(&s, ALIVE, NOW - 2 * 60_000);
        assert_eq!(offline_gap_at(&s, NOW, || 0), None);
    }

    #[test]
    fn no_heartbeat_does_not_ask_for_the_offset() {
        let asked = AtomicUsize::new(0);
        let got = offline_gap_at(&store(), NOW, || {
            asked.fetch_add(1, Ordering::SeqCst);
            0
        });
        assert_eq!(got, None);
        assert_eq!(asked.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn task_xml_has_repetition() {
        let xml = task_xml(Path::new("hub.exe"), "PC\\vac");
        assert!(xml.contains("<Repetition><Interval>PT1M</Interval></Repetition>"));
    }

    #[test]
    fn user_id_without_domain() {
        assert_eq!(user_id("PC", "BOX", "vac"), "PC\\vac");
        assert_eq!(user_id("", "BOX", "vac"), "BOX\\vac");
        assert_eq!(user_id("", "", "vac"), "vac");
    }

    #[test]
    fn schtasks_errors_say_what_failed() {
        let denied = schtasks_error("/Create", Some(1), "ERROR: Access is denied.");
        assert!(denied.contains("Administrator"));
        let run = schtasks_error("/Run", Some(1), "boom");
        assert!(run.contains("registered but did not start"));
        assert!(schtasks_error("/Create", Some(5), "bad xml").contains("exit code 5"));
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
