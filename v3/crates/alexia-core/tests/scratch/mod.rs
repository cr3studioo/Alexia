// SPDX-License-Identifier: AGPL-3.0-only
//! A fresh empty folder under `temp_dir()/alexia-test/`, removed on drop.
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

pub struct Scratch(PathBuf);

impl Scratch {
    pub fn new(tag: &str) -> Scratch {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join("alexia-test")
            .join(format!("core-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
}

impl Deref for Scratch {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // On Windows an SQLite handle can close a moment late: retry, then give up silently.
        let tries = if cfg!(windows) { 6 } else { 1 };
        for i in 0..tries {
            if i > 0 {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            if std::fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
                return;
            }
        }
    }
}
