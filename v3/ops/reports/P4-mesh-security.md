# P4 mesh security (TR-05)

What "end-to-end encrypted mesh" means in Alexia, what `v3/crates/alexia-mesh/tests/security.rs`
proves about it, and what it does not cover.

## What the encryption is

connect (`connect/`, iroh pinned to 1.3.0) runs inside the hub and limb processes. Two devices
talk only over QUIC with TLS 1.3, ALPN `alexia/compute/1`. The certificates are raw public keys:
a device's endpoint id *is* its Ed25519 public key, so the handshake authenticates the id each
side dialled or expected. There are no certificate authorities. A connection is refused at the
handshake unless the remote id is on the allowlist, in both directions, and the allowlist is
checked again on every stream. The allowlist is exactly the store's non-revoked `devices` rows.
Only `alexia-mesh` writes those rows, and only after a pairing (D-P4-2).

Pairing (direct, no mailbox): a four-word code, valid for 5 minutes and one attempt. SPAKE2 runs
over an iroh connection whose two ids are already authenticated. The key is bound to both ids
and to both hellos by HMAC. A wrong code closes the gate.

## What crosses between two computers

From connect's README, *What crosses between two computers*: every request is one bidirectional
QUIC stream. Each stream carries a length-prefixed JSON head (method, path, carried headers),
then the body, then FIN. That covers link lines (MCP JSON-RPC), the hub operations
(`kill`/`presence`/`face`) and the pairing proof. None of it is plaintext on the wire. The
loopback `Authorization` (the per-launch secret) never crosses. `x-alexia-peer` is set by the
receiving connect from the authenticated connection; a value the other side sends is dropped.

## Who holds which key, where

| Secret | Where | Lifetime |
| --- | --- | --- |
| Endpoint private key | OS keychain, service `dev.alexia.hub.mesh` (hub) / `dev.alexia.limb.mesh` (limb), account `endpoint-key`. Used in place by the endpoint; no API returns it. | until the device is re-set-up |
| Per-launch loopback secret | process memory (node.rs); bearer on every loopback request | one launch |
| Host-service secret | process memory (link.rs); connect sends it to the host service | one launch |
| Pairing code | the hub's screen/QR and the limb's input; never in the store or a log | 5 min, one try |

Tests use `ephemeral: true` (a fresh in-memory key) and never touch the keychain.

## What each party sees

- **A stranger on the LAN** can see UDP/QUIC packets and the endpoint id (a public key). Its
  QUIC handshake is refused by connect's allowlist, so it reaches nothing (`peer_rejected`).
- **A local process without the secret** gets `401 unauthorized` from connect's loopback port,
  and `401` from the host services.
- **Relays**: none are configured (D-P4-2: LAN and Tailscale direct addresses only). If one were
  added, it would see only encrypted QUIC between two public keys.

## The tests, and which layer refuses

Done-when results: **not run yet.** In fast mode the tests are written, not run, and the build
runs once later. Each row gives the layer whose refusal the test asserts. Every test also asserts
that the target's `on_link`/`on_op` was never called.

| Test | Refused by | Result |
| --- | --- | --- |
| `stranger_cannot_dial_limb` | connect allowlist on L (handshake, `peer_rejected`) | not run |
| `stranger_cannot_send_ops_to_hub` | connect allowlist on H (`peer_rejected`), also with a forged header and body | not run |
| `revoked_limb_is_cut_within_1s` | revoke closes both link ends ≤ 1 s; then the mesh (`NotPaired`), H's connect (`peer_not_allowed`) and H's handshake for L's ops | not run |
| `wrong_loopback_secret_is_401` | connect loopback auth (missing/flipped/short/long/uppercase/other node's secret; status, allowlist, bridge, shutdown; secret in URL) | not run |
| `wrong_host_secret_is_refused` | host service bearer check (401, no connect header), even with a valid-looking `x-alexia-peer` | not run |
| `forged_peer_header_is_ignored` | connect drops the forged `x-alexia-peer` (H hears `l`); L2's role check refuses L posing as H | not run |
| `pair_code_single_use` | connect's one-use direct gate; H's store and allowlist unchanged, one `Paired` event | not run |
| `cancelled_pairing_leaves_no_allowed_device` | `pair.rs`: a cancel racing `pair_wait` leaves no allowed row (fix in this task) | not run |
| `no_secret_in_logs` | all `tracing` output at debug from every crate: no code, no per-launch or host secret, no line or face text | not run |
| `limb_role_cannot_serve_ops_to_a_limb` | L2's handshake (`peer_rejected`); if L2 knew L, connect's registry (`operation_not_registered`); the link: L2's role check | not run |

## Not covered

- **A compromised device.** A paired device that is taken over can do whatever its role allows
  until it is revoked.
- **The owner's keychain or OS account.** Anyone who can read the keychain entry can become
  that device.
- `serve_ops` does not check the node's own role. A limb that called it would take operations
  from any peer its store calls `limb`. Pairing never writes such a row on a limb, so this is
  not reachable today.
- Logs written through the `log` crate rather than `tracing` are not captured by the test.
- The host secret cannot be read from outside `link.rs`. The log test therefore flags every run
  of 64 or more hex digits that is not an endpoint id.
