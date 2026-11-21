// SPDX-License-Identifier: AGPL-3.0-only
//! P2-61: the one `file:` URI decoder and network-path test.

use std::path::PathBuf;

use alexia_mcp::{file_uri_path, is_network_path};

/// `/C:/x` as the decoder gives it on this OS.
fn drive(s: &str) -> PathBuf {
    PathBuf::from(if cfg!(windows) {
        s.replace('/', "\\")
    } else {
        s.to_string()
    })
}

#[test]
fn upper_case_scheme() {
    assert_eq!(file_uri_path("FILE:///home/x"), Some("/home/x".into()));
    assert_eq!(file_uri_path("File:///C:/x"), Some(drive("C:/x")));
    assert_eq!(file_uri_path("http:///home/x"), None);
}

#[test]
fn one_slash_form() {
    assert_eq!(file_uri_path("file:/C:/a/b"), Some(drive("C:/a/b")));
    assert_eq!(file_uri_path("file:/home/x"), Some("/home/x".into()));
    // No slash at all is not a file URI path.
    assert_eq!(file_uri_path("file:x"), None);
}

#[test]
fn localhost_host() {
    assert_eq!(
        file_uri_path("file://localhost/home/x"),
        Some("/home/x".into())
    );
    assert_eq!(file_uri_path("file://LOCALHOST/C:/x"), Some(drive("C:/x")));
}

#[test]
fn other_host_is_none() {
    assert_eq!(file_uri_path("file://srv/share/x"), None);
    assert_eq!(file_uri_path("FILE://srv/share/x"), None);
    // A drive letter where the host goes is a host, not a drive.
    assert_eq!(file_uri_path("file://C:/x"), None);
}

#[test]
fn drive_path_decoded() {
    assert_eq!(file_uri_path("file:///C:/a%20b/c"), Some(drive("C:/a b/c")));
    assert_eq!(file_uri_path("file:///%2Essh/k"), Some("/.ssh/k".into()));
    // UNC and drive-relative come back as decoded: refusing them is the opener's job.
    assert_eq!(
        file_uri_path("file:////srv/share/x"),
        Some("//srv/share/x".into())
    );
    assert_eq!(file_uri_path("file:///x"), Some("/x".into()));
}

#[test]
fn percent_broken_escape_kept() {
    assert_eq!(file_uri_path("file:///a%zzb%2"), Some("/a%zzb%2".into()));
    assert_eq!(file_uri_path("file:///a%"), Some("/a%".into()));
}

#[test]
fn unc_detected_all_separators() {
    for p in [r"\\srv\x", "//srv/x", r"\/srv/x", r"/\srv\x"] {
        assert!(is_network_path(p), "{p}");
    }
    for p in [r"C:\x", "/x", r"\x", "x", "", "/"] {
        assert!(!is_network_path(p), "{p}");
    }
}

#[test]
fn unc_long_prefix_detected() {
    assert!(is_network_path(r"\\?\UNC\srv\x"));
    assert!(is_network_path(r"\\?\unc\srv\x"));
    assert!(is_network_path(r"\??\UNC\srv\x"));
    assert!(is_network_path(r"\??\unc\srv\x"));
    assert!(is_network_path(r"\??\C:\Windows"));
    assert!(is_network_path("/??/UNC/srv/x"));
    assert!(is_network_path(r"\??/UNC/srv/x"));
    assert!(is_network_path(r"/??\UNC\srv\x"));
    assert!(!is_network_path(r"C:\??\x"));
    assert!(!is_network_path(r"\?x"));
}
