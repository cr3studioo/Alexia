// SPDX-License-Identifier: AGPL-3.0-only

//! How warm the machine is, for the Local stats page — the one reading core cannot take.
//!
//! **Why this is Rust at all.** Core reads everything else on that page from programs every
//! machine already has (`os`, `vm_stat`, `ioreg`, `/sys/class/thermal`). Temperature has no
//! such program on a Mac or on Windows: the sensors sit behind IOKit's HID event system and
//! WMI, which a Node daemon reaches only through a native addon — and a native addon in core is
//! exactly the unsigned, per-platform build this shell exists so core never needs. The `sysinfo`
//! crate already speaks both, and the shell is already the signed program on the machine.
//!
//! **It decides nothing.** Three numbers or `null` each, picked by a sensor's label: the page
//! decides what to draw, and says nothing where there is nothing. A reading outside 10–150 °C is
//! a sensor that reports nonsense (some read 0, some a sentinel far past boiling), not a
//! temperature, and is dropped. Asked only while the page is on screen, and each call reads the
//! sensors once and keeps nothing.

use sysinfo::Components;

#[derive(serde::Serialize)]
pub struct Temps {
    cpu: Option<f32>,
    gpu: Option<f32>,
    battery: Option<f32>,
}

/// The hottest sensor whose label contains any of `words`, lowercased. Apple Silicon names its
/// die sensors `PMU tdie…` and its battery `gas gauge battery`, and has no GPU sensor `sysinfo`
/// reads; an Intel Mac says CPU, GPU and Battery in so many words; Linux says `coretemp`,
/// `k10temp Tctl` or `amdgpu`. Windows has one ACPI zone, `Computer`, which is the board near
/// the processor — and WMI usually hands it only to an administrator, so it is often nothing.
fn hottest(components: &Components, words: &[&str]) -> Option<f32> {
    components
        .iter()
        .filter(|one| words.iter().any(|word| one.label().to_lowercase().contains(word)))
        .filter_map(|one| one.temperature())
        .filter(|celsius| (10.0..=150.0).contains(celsius))
        .reduce(f32::max)
}

#[tauri::command]
pub fn system_temps() -> Temps {
    let components = Components::new_with_refreshed_list();
    Temps {
        cpu: hottest(&components, &["cpu", "tdie", "core", "package", "tctl", "computer"]),
        gpu: hottest(&components, &["gpu"]),
        battery: hottest(&components, &["battery"]),
    }
}
