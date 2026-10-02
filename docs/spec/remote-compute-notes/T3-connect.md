T3 final report; files created: packages/core/src/compute/connect.ts and packages/core/test/compute-connect.test.ts; no existing or connect/ files were edited, and all changes remain uncommitted.

Final commands and results:
- pnpm typecheck: PASS, exit 0.
- pnpm lint: PASS on final run, exit 0; 311 modules / 1463 dependencies. A previous run briefly saw unused state parameters in the concurrently edited packages/ui/test/compute.test.ts:506 and :591; they disappeared before the final run.
- pnpm vitest run --project unit packages/core/test/compute-connect.test.ts: PASS, 35/35 tests; 14 exercise the real debug sidecar using ALEXIA_CONNECT_EPHEMERAL_KEY=1.
- ALEXIA_CONNECT_TEST_BIN=/does-not-exist/alexia-connect pnpm vitest run --project unit packages/core/test/compute-connect.test.ts: PASS, 21 passed / 14 skipped, with a visible stderr skip explanation. This run preceded the final peer-hints accessor addition; absence handling did not change.
- pnpm exec eslint packages/core/src/compute/connect.ts packages/core/test/compute-connect.test.ts: PASS.
- pnpm exec depcruise packages: PASS.
- pnpm vitest run --project invariants packages/core/test/invariants/01-core-names-no-plugin.test.ts: PASS, 3 tests.
- pnpm check: FAIL only at the known packages/core/test/command.test.ts:90 baseline (expected local, received combined); 206 test files and 2205 tests passed, 1 skipped, 1 failed. Lint/typecheck passed; invariants were not reached after the baseline unit failure. This full run preceded the final metadata-projection regression test and peer-hints accessor addition.

Every README/contract reconciliation:
1. Binding ConnectOptions, PairedPeer, Connect, binaryPath(), connect(): Promise<Connect>, and memoryConnect() signatures are preserved. Additive ConnectHints, setPeerHints(client,id,hints), and readConnectHints(client,id?) cover address hints; passing a peer id retrieves proven-peer cached hints for core persistence.
2. The README exposes HTTP operation forwarding, not raw stream endpoints. Register exactly POST /v1/streams/control, /infer, /job, /artifact on an internal authenticated loopback receiver and use matching /bridge/{id}/v1/streams/{kind} requests; the upload and response become a Duplex. The real sidecar proves simultaneous streaming and a write after the first response byte arrives.
3. Runtime isStreamKind checks enforce four kinds in both clients; native method/path registration independently rejects arbitrary operations before contacting core.
4. The receiver exists on both roles to preserve generic accept(). One replaceable handler receives authenticated peer identity; absent handlers refuse delivery. It checks bearer token, exact loopback Host, allowlist, and the sidecar-authenticated x-alexia-peer.
5. Mint 32 random bytes as 64 hex characters for each launch, pass them only in stdin's first newline-terminated line, and spawn with no arguments. Delete inherited ALEXIA_CONNECT_SECRET so environment precedence cannot override the new token. Keep stdin open.
6. Parse stdout ready/protocol/port/endpointId. Missing/failed binary is catchable setup-required; non-1 protocol is incompatible-version. Imports and binary discovery never start a process.
7. The native initial list is empty, so install options.allow through PUT /v1/allowlist after readiness and before host registration/return. Revocation destroys local streams before allow() resolves.
8. Role is TypeScript-only; configured ConnectOptions.role supplies pairing exclusive=true for compute, false for interaction, on both host/join.
9. There is no native dataDir argument. Hash resolve(dataDir) into the ALEXIA_CONNECT_KEYCHAIN service namespace to isolate installations while the private key remains native-owned.
10. services.relay maps to ALEXIA_CONNECT_RELAY_URLS, services.mailbox to ALEXIA_CONNECT_MAILBOX_URL; absent overrides retain README/environment defaults, currently no provisioned services. Address lookup stays the distinct ALEXIA_CONNECT_LOOKUP_URL setting.
11. state/onState follow authenticated /v1/events snapshot and peer SSE changes, without polling.
12. Client Duplex high-water marks are 64 KiB, while native loopback sockets and QUIC retain README bounded windows. Thus buffering is bounded across multiple hops rather than literally one shared high-water mark. A paused reader stalls 64 MiB in both directions and resumption preserves all bytes.
13. Clean end differs from reset. The native HTTP bridge has no post-header reset-versus-connection-loss reason: either becomes interrupted, with separate offline state events for connection context; explicit local close is offline, abort cancelled.
14. Remote allowlist rejection during handshake can appear as peer_unreachable/offline (coordinator accepted); local violations and peer_not_allowed/peer_rejected are unpaired.
15. close() uses the README's stdin-EOF shutdown, waits for exit, kills a still-running child after two seconds, and closes receiver/events/streams; it is idempotent.
16. Pairing uses the final README /v1/pairing/host, /join, /{id}?wait=true, and DELETE /{id} APIs. name is separate; role/platform/appVersion are the <=1024-byte opaque payload. Project only these expected fields so arbitrary metadata cannot override the proven endpoint or authenticated name.
17. Waiting honors the native ticket deadline (five-minute host code, 60-second join attempt). HTTP wait abortion does not cancel native pairing, so AbortSignal explicitly sends DELETE, including a race during ticket creation; a paired result racing abort is refused locally and never auto-allowlisted.
18. pairing_expired maps to expired; pairing_cancelled to cancelled; wrong code/proof/unknown code/timeout/other pairing failures to refused. An absent mailbox before a ticket exists maps to setup-required.
19. Successful pairing does not authorize compute. Cache proven peer hints, expose them through readConnectHints(client,peerId) for persistence, and install them only when core later allowlists the peer; setPeerHints restores persisted hints after relaunch without conferring trust.
20. Drain native stderr without forwarding it; log() gets only a fixed readiness message, never codes, payloads, header values, or secrets.
21. memoryConnect matches empty allowlists, validated IDs, four kinds, bounded pipes, reset/end, cancellation, revocation, state subscriptions, and pairing lifecycle. Its pairing is an in-process test double, not a cryptographic implementation.

Remaining limits: successful Magic Wormhole pairing/iroh possession proof are the native worker's validation responsibility; this TypeScript suite covers pairing lifecycle through memory and an executable Node wire fixture, plus real native absent-mailbox/already-aborted cases. Relay, NAT, keychain persistence, two-machine performance, and arbitrary independent half-close ordering were not validated. Controller/service integration and persisting/restoring peer hints belong to later tasks; no T3 implementation work remains.
