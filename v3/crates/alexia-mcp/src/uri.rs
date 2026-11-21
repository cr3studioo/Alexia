// SPDX-License-Identifier: AGPL-3.0-only
//! The one `file:` URI decoder and network-path test, shared by the permission gate (core),
//! core's `resource_link` reader and compute/run, so the gate judges the path the opener opens.

use std::path::PathBuf;

/// A `file:` URI as a path on this machine. The scheme is matched in any case and RFC 8089's
/// one-slash `file:/x` counts. `None` for any other scheme and for a host that is not empty or
/// `localhost`. Percent-decoded, a broken escape kept as written; `/C:/x` is `C:/x` (`C:\x` on
/// Windows). A UNC result (`file:////srv/x`) or a drive-relative `/x` comes back as decoded:
/// refusing those is the opening code's job (see [`is_network_path`]).
pub fn file_uri_path(uri: &str) -> Option<PathBuf> {
    let rest = uri
        .get(..5)
        .filter(|scheme| scheme.eq_ignore_ascii_case("file:"))
        .map(|_| &uri[5..])
        .filter(|rest| rest.starts_with('/'))?;
    let (host, path) = match rest.strip_prefix("//") {
        Some(r) => r.split_at(r.find('/').unwrap_or(r.len())),
        None => ("", rest),
    };
    if !host.is_empty() && !host.eq_ignore_ascii_case("localhost") {
        return None;
    }
    let path = percent_decoded(path);
    let b = path.as_bytes();
    if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        let drive = &path[1..];
        return Some(PathBuf::from(if cfg!(windows) {
            drive.replace('/', "\\")
        } else {
            drive.to_string()
        }));
    }
    Some(PathBuf::from(path))
}

/// A network share: two leading separators in any mix of `/` and `\` (this covers `\\?\UNC\`
/// and `\\.\UNC\`), or the NT object prefix `\??\` with either separator. `\??\UNC\host\share`
/// reaches SMB too, and `\??\C:\x` is a raw NT path, so every `\??\` is refused. Opening or
/// stat'ing a share makes Windows talk SMB to that host, so it must be refused before any
/// filesystem call.
pub fn is_network_path(path: &str) -> bool {
    let sep = |c: u8| c == b'/' || c == b'\\';
    let b = path.as_bytes();
    (b.len() > 1 && sep(b[0]) && sep(b[1]))
        || (b.len() > 3 && sep(b[0]) && b[1] == b'?' && b[2] == b'?' && sep(b[3]))
}

/// `%2E` → `.`; a broken escape is kept as written.
fn percent_decoded(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = b
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok())
            .filter(|_| b[i] == b'%')
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match hex {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
