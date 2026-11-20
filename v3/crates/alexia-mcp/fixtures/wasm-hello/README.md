# wasm-hello

A tiny MCP server for the P2-24 tests. Not a workspace member. Tools: `hello`, `hang`,
`trap`, `read_file {path}`, `alloc {mb}`.

Rebuild after any change, then copy the result and update the hash below:

```sh
cargo build --release --target wasm32-wasip1 --manifest-path v3/crates/alexia-mcp/fixtures/wasm-hello/Cargo.toml
cp v3/crates/alexia-mcp/fixtures/wasm-hello/target/wasm32-wasip1/release/wasm-hello.wasm v3/crates/alexia-mcp/tests/fixtures/wasm-hello.wasm
sha256sum v3/crates/alexia-mcp/tests/fixtures/wasm-hello.wasm
```

Then delete `fixtures/wasm-hello/target/` (`ci/invariants.mjs` scans it for SPDX headers).

`tests/wasm.rs` checks the committed `.wasm` against this hash, so a stale binary fails.

SHA-256 of `tests/fixtures/wasm-hello.wasm`: `9b68e6d8c3390389aa173637500261281d8e2386d0be489c517da2e0084e84b8`
