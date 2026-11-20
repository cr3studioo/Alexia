// SPDX-License-Identifier: AGPL-3.0-only
//! `entry.run == "wasm"`: an MCP server compiled to wasm32-wasip1, run in-process (SP-10).

/// P2-24: an MCP server compiled to wasm32-wasip1, run in-process.
pub struct WasmPlugin {
    _private: (),
}

impl WasmPlugin {
    /// Load the module at `wasm` (the manifest's `args[0]`, made absolute against the plugin folder).
    pub fn load(wasm: &std::path::Path) -> crate::Result<WasmPlugin> {
        let _ = wasm;
        todo!("P2-24")
    }
}
