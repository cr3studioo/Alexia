// SPDX-License-Identifier: AGPL-3.0-only
//! Running the limb as a service that starts when the owner logs in: a launchd user agent on
//! macOS, a Task Scheduler task on Windows. The same shape as the hub's watchdog task.
// The binary uses only the current OS's half; the other half is built (and tested) everywhere.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

pub const TASK_NAME: &str = "Alexia limb";
pub const LABEL: &str = "dev.alexia.limb";
const MAX_LOG: u64 = 10 * 1024 * 1024;
const UNSUPPORTED: &str = "Starting at login is not set up on this system.";

/// Where the limb's log goes: `<limb data>/limb.log`.
pub fn log_path() -> PathBuf {
    alexia_store::data_dir().join("limb").join("limb.log")
}

/// If the log is over 10 MB, move it to `limb.log.1` (replacing an older one). For the start of `run`.
pub fn rotate_log() {
    let log = log_path();
    if std::fs::metadata(&log).is_ok_and(|m| m.len() > MAX_LOG) {
        let _ = std::fs::rename(&log, log.with_extension("log.1"));
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The launchd plist: start at load, restart unless it exited cleanly, stdout and stderr to `log`.
pub fn plist_text(exe: &Path, log: &Path) -> String {
    let (exe, log) = (
        xml_escape(&exe.display().to_string()),
        xml_escape(&log.display().to_string()),
    );
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#
    )
}

/// The Task Scheduler XML: one logon trigger for `user`, interactive token, hidden, restart on
/// failure 3 times. Task Scheduler cannot redirect output, so `cmd` does it; the exe and log
/// paths are each in their own quotes (the outer pair is stripped by `cmd /s`).
pub fn schtasks_xml(exe: &Path, log: &Path, user: &str) -> String {
    let dir = exe
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let args = format!(
        "/d /s /c \"\"{}\" run >> \"{}\" 2>&1\"",
        exe.display(),
        log.display()
    );
    let (args, dir, user) = (xml_escape(&args), xml_escape(&dir), xml_escape(user));
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Starts the Alexia limb when you sign in and restarts it if it stops.</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>cmd.exe</Command><Arguments>{args}</Arguments><WorkingDirectory>{dir}</WorkingDirectory></Exec>
  </Actions>
</Task>
"#
    )
}

/// `DOMAIN\user`, else `COMPUTER\user`, else just `user`.
fn user_id() -> String {
    let var = |k| std::env::var(k).unwrap_or_default();
    let (domain, computer, user) = (var("USERDOMAIN"), var("COMPUTERNAME"), var("USERNAME"));
    match [domain, computer].into_iter().find(|d| !d.is_empty()) {
        Some(d) if !user.is_empty() => format!("{d}\\{user}"),
        _ => user,
    }
}

/// The text written for this OS: a launchd plist on macOS, a schtasks XML otherwise.
pub fn unit_text(exe: &Path, log: &Path) -> String {
    if cfg!(target_os = "macos") {
        plist_text(exe, log)
    } else {
        schtasks_xml(exe, log, &user_id())
    }
}

fn run_cmd(program: &str, args: &[&str]) -> Result<(), String> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd
        .output()
        .map_err(|e| format!("I could not run {program}: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{program} {} failed with exit code {}. {}",
            args.first().copied().unwrap_or(""),
            out.status
                .code()
                .map_or("none".to_string(), |c| c.to_string()),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

#[cfg(target_os = "macos")]
fn plist_file() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("I could not find your home folder.")?;
    Ok(PathBuf::from(home)
        .join("Library/LaunchAgents")
        .join(format!("{LABEL}.plist")))
}

#[cfg(target_os = "macos")]
fn gui_domain() -> Result<String, String> {
    let out = std::process::Command::new("id")
        .arg("-u")
        .output()
        .map_err(|e| format!("I could not find your user id: {e}"))?;
    Ok(format!(
        "gui/{}",
        String::from_utf8_lossy(&out.stdout).trim()
    ))
}

#[cfg(target_os = "macos")]
fn install_os() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("I could not find my own path: {e}"))?;
    let (log, file) = (log_path(), plist_file()?);
    for dir in [log.parent(), file.parent()].into_iter().flatten() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("I could not create {}: {e}", dir.display()))?;
    }
    std::fs::write(&file, unit_text(&exe, &log))
        .map_err(|e| format!("I could not write {}: {e}", file.display()))?;
    let (domain, file) = (gui_domain()?, file.display().to_string());
    let _ = run_cmd("launchctl", &["bootout", &domain, &file]); // an older copy, if any
    run_cmd("launchctl", &["bootstrap", &domain, &file])
}

#[cfg(target_os = "macos")]
fn uninstall_os() -> Result<(), String> {
    let file = plist_file()?;
    let _ = run_cmd(
        "launchctl",
        &["bootout", &gui_domain()?, &file.display().to_string()],
    );
    match std::fs::remove_file(&file) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(format!("I could not remove {}: {e}", file.display()))
        }
        _ => Ok(()),
    }
}

#[cfg(windows)]
fn install_os() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("I could not find my own path: {e}"))?;
    let log = log_path();
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("I could not create {}: {e}", dir.display()))?;
    }
    let mut bytes = vec![0xFF, 0xFE];
    bytes.extend(
        unit_text(&exe, &log)
            .encode_utf16()
            .flat_map(u16::to_le_bytes),
    );
    let file = std::env::temp_dir().join("alexia-limb-task.xml");
    std::fs::write(&file, bytes).map_err(|e| format!("I could not write the task file: {e}"))?;
    let created = run_cmd(
        "schtasks",
        &[
            "/Create",
            "/TN",
            TASK_NAME,
            "/XML",
            &file.display().to_string(),
            "/F",
        ],
    );
    let _ = std::fs::remove_file(&file);
    created?;
    run_cmd("schtasks", &["/Run", "/TN", TASK_NAME])
}

#[cfg(windows)]
fn uninstall_os() -> Result<(), String> {
    run_cmd("schtasks", &["/Delete", "/TN", TASK_NAME, "/F"])
}

#[cfg(not(any(windows, target_os = "macos")))]
fn install_os() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn uninstall_os() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

/// Start the limb when the owner logs in, from now on. Prints the sentence on success.
// The spec's interface returns the sentence as `Ok(String)`; cli.rs (P4-09, not mine to edit)
// matches `Ok(())`, so the sentence is printed here instead.
pub fn install() -> Result<(), String> {
    install_os()?;
    println!("Alexia's limb will start when you log in.");
    Ok(())
}

/// Stop starting the limb at login. Prints the sentence on success.
pub fn uninstall() -> Result<(), String> {
    uninstall_os()?;
    println!("Alexia's limb will no longer start when you log in.");
    Ok(())
}
