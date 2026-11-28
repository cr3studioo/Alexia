// SPDX-License-Identifier: AGPL-3.0-only
//! (P4-10) The login service texts. Real install is never run here.

use std::path::Path;

// The binary's own module, compiled into this test (a bin crate has no library to import).
#[allow(dead_code)]
#[path = "../src/service.rs"]
mod service;

fn count(s: &str, needle: &str) -> usize {
    s.matches(needle).count()
}

#[test]
fn plist_is_valid_xml_with_run() {
    let exe = Path::new("/Applications/Tom & Jerry/alexia-limb");
    let log = Path::new("/Users/x/Library/Application Support/Alexia/limb/limb.log");
    let p = service::plist_text(exe, log);
    assert!(p.starts_with("<?xml"));
    assert_eq!(count(&p, "<dict>"), count(&p, "</dict>"));
    assert_eq!(count(&p, "<array>"), count(&p, "</array>"));
    assert_eq!(count(&p, "<plist"), 1);
    assert_eq!(count(&p, "</plist>"), 1);
    assert_eq!(count(&p, "<key>"), count(&p, "</key>"));
    assert_eq!(count(&p, "<string>"), count(&p, "</string>"));
    for want in [
        "<string>dev.alexia.limb</string>",
        "<string>/Applications/Tom &amp; Jerry/alexia-limb</string>",
        "<string>run</string>",
        "<key>RunAtLoad</key>\n  <true/>",
        "<key>SuccessfulExit</key>\n    <false/>",
        "<key>StandardOutPath</key>",
        "<key>StandardErrorPath</key>",
    ] {
        assert!(p.contains(want), "missing {want} in {p}");
    }
    assert_eq!(count(&p, "limb.log</string>"), 2);
    assert!(!p.contains("Tom & Jerry"), "unescaped ampersand");
}

#[test]
fn schtasks_xml_has_logon_trigger_and_restart() {
    let x = service::schtasks_xml(
        Path::new(r"C:\Alexia\alexia-limb.exe"),
        Path::new(r"C:\Alexia\limb.log"),
        r"PC\vac",
    );
    assert_eq!(count(&x, "<LogonTrigger>"), 1, "{x}");
    assert!(!x.contains("BootTrigger"));
    for want in [
        "<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>",
        "<Hidden>true</Hidden>",
        "<LogonType>InteractiveToken</LogonType>",
        "<UserId>PC\\vac</UserId>",
        "<Command>cmd.exe</Command>",
    ] {
        assert!(x.contains(want), "missing {want} in {x}");
    }
    assert!(x.contains("run &gt;&gt; "), "{x}");
    assert!(x.contains(r"limb.log&quot; 2&gt;&amp;1"), "{x}");
}

#[test]
fn paths_are_quoted() {
    let exe = Path::new(r"C:\Program Files\Alexia limb\alexia-limb.exe");
    let log = Path::new(r"C:\Users\A B\limb.log");
    let x = service::schtasks_xml(exe, log, "vac");
    assert!(
        x.contains(r"&quot;C:\Program Files\Alexia limb\alexia-limb.exe&quot; run"),
        "{x}"
    );
    assert!(x.contains(r"&quot;C:\Users\A B\limb.log&quot;"), "{x}");
    // A plist keeps the path whole as one array entry, so spaces need no quoting there.
    let p = service::plist_text(exe, log);
    assert!(p.contains(r"<string>C:\Program Files\Alexia limb\alexia-limb.exe</string>"));
    // And the OS-picked text carries the same path.
    let u = service::unit_text(exe, log);
    assert!(u.contains("Program Files") && u.contains("limb.log"));
}

#[test]
fn log_path_is_limb_log() {
    assert_eq!(
        service::log_path().file_name().and_then(|n| n.to_str()),
        Some("limb.log")
    );
}

#[cfg(not(any(windows, target_os = "macos")))]
#[test]
fn install_on_unsupported_os_says_so() {
    let want = "Starting at login is not set up on this system.";
    assert_eq!(service::install().unwrap_err(), want);
    assert_eq!(service::uninstall().unwrap_err(), want);
}
