// SPDX-License-Identifier: AGPL-3.0-only
fn main() {
    // The shell's own commands, named so Tauri writes an `allow-…` permission for each. The page is
    // served by core over loopback, which Tauri treats as a remote origin, and a remote origin may
    // call only what a capability grants by name — so a command registered in `main.rs` and not
    // named here was refused with *not allowed by ACL*, which is how an update installed and then
    // could not restart itself. `capabilities/default.json` grants each one.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["tray_state", "hide_overlay", "relaunch", "system_temps", "sheet_snapshot"])),
    )
    .expect("tauri-build");
}
