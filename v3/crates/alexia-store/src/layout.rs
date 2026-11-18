// SPDX-License-Identifier: AGPL-3.0-only
//! Where v3 keeps its data on disk. Paths only; nothing is created here.

use std::path::PathBuf;

/// Where v3 keeps its data. `%LOCALAPPDATA%\AlexiaHub` on Windows,
/// `~/Library/Application Support/AlexiaHub` on macOS (the limb's fallback brain),
/// `$XDG_DATA_HOME/AlexiaHub` elsewhere. `ALEXIA_V3_DATA`, if set to an absolute path, wins
/// (tests and the dev build use it). Deliberately not v2's `Alexia` folder: v3 never writes there.
pub fn data_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("ALEXIA_V3_DATA").map(PathBuf::from) {
        if p.is_absolute() {
            return p;
        }
    }
    platform_base().join("AlexiaHub")
}

/// An absolute path from an env var, or None if unset, empty or relative.
fn abs_env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

#[cfg(windows)]
fn platform_base() -> PathBuf {
    abs_env("LOCALAPPDATA").unwrap_or_else(|| home().join("AppData").join("Local"))
}

#[cfg(target_os = "macos")]
fn platform_base() -> PathBuf {
    home().join("Library").join("Application Support")
}

#[cfg(not(any(windows, target_os = "macos")))]
fn platform_base() -> PathBuf {
    abs_env("XDG_DATA_HOME").unwrap_or_else(|| home().join(".local").join("share"))
}

fn home() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    // ponytail: no home at all is a broken machine; fall back to the cwd rather than panic.
    abs_env(var).unwrap_or_default()
}

/// The layout under `data_dir()`. The same relative layout v2 uses, so the importer copies
/// folders one-to-one.
pub struct Layout {
    pub root: PathBuf,
}

impl Layout {
    pub fn new(root: PathBuf) -> Self {
        Layout { root }
    }
    /// `alexia.db`
    pub fn db(&self) -> PathBuf {
        self.root.join("alexia.db")
    }
    /// `plugins/<id>`: a plugin's cwd and ownDir.
    pub fn own_dir(&self, plugin: &str) -> PathBuf {
        self.root.join("plugins").join(plugin)
    }
    /// `extensions/`: installed plugin folders.
    pub fn extensions(&self) -> PathBuf {
        self.root.join("extensions")
    }
    /// `skills/`
    pub fn skills(&self) -> PathBuf {
        self.root.join("skills")
    }
    /// `uploads/` (one folder per session below it).
    pub fn uploads(&self) -> PathBuf {
        self.root.join("uploads")
    }
    /// `cache/`
    pub fn cache(&self) -> PathBuf {
        self.root.join("cache")
    }
}
