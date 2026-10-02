# T10 report: controller, jobs and transfer

Branch `cr3studioo/local-model-picker`, everything left uncommitted. No existing file was edited.

## Files created

- `packages/core/src/compute/controller.ts`
- `packages/core/src/compute/jobs.ts`
- `packages/core/src/compute/transfer.ts`
- `packages/core/test/compute-controller.test.ts` (14 tests)
- `packages/core/test/compute-jobs.test.ts` (12 tests)
- `packages/core/test/compute-transfer.test.ts` (9 tests)

## Commands run, final results

| Command | Result |
|---|---|
| `pnpm vitest run --project unit packages/core/test/compute-controller.test.ts packages/core/test/compute-jobs.test.ts packages/core/test/compute-transfer.test.ts` | pass, 35/35, five consecutive runs |
| `pnpm vitest run --project unit packages/core/test/compute-` | pass, 11 files, 174 tests |
| `pnpm exec tsc -b` | exit 0 |
| `pnpm exec eslint <the six files>` | exit 0 |
| `pnpm lint` (eslint . && depcruise packages) | exit 0, no dependency violations |
| `pnpm invariants` | pass, 13 files, 36 tests |

Not run: the full `pnpm test` unit suite.

## Acceptance, and the test that shows each

- Reconnect re-sends Hello with resume and never a submit: controller test "a reconnect re-sends Hello with resume, and never a submit"; jobs test "a reconnect asks about the job by id and attaches from the last event".
- Offline host stays in `views()` with offline: controller test "an offline host stays listed with its last inventory and its reason".
- Incompatible protocol version reported as `incompatible-version`: controller test of that name (host refusal, and a welcome with a version this build does not speak).
- Fetched artifact hash-verified, written, acknowledged: transfer test of that name (300 KiB, larger than one stream window).
- Bad hash refused and not acknowledged: transfer test of that name (no file left, no control request sent).
- Job reported interrupted resolves `run()` with that state, not resubmitted: jobs test of that name.
- Controller restart resumes from `compute_jobs`: jobs tests "a controller restart resumes from compute_jobs" and "after a restart, a job the host finished or lost meanwhile leaves compute_jobs".

## Additions beyond the spec's signatures (all additive)

- `ControllerOptions` gains optional `now`, `timer` (same shape as `SchedulerOptions.timer`) and `hints`.
- `Controller.queue(hostId)`: the host's last queue snapshot. `RemoteJobs.queue` delegates to it.
- `RemoteJobs` constructor takes an optional `now`.
- `controller.ts` also exports `Frames` (pull-based frame reader, then raw bytes), `send`, `streamError`, `failureOf`, `HANDSHAKE_MS`, `RETRY_BACKOFF_MS`, `RETRY_MS`. T11's bridge can reuse `Frames` and `send`.
- `Controller.onEvent` also delivers each welcome as `inventory`, `queue` and one `job` event per `Welcome.jobs` entry. This is how `RemoteJobs` learns where resumed jobs stand.

## Deviations and decisions to confirm

1. **Upload reads the file twice.** The spec says "hashes while streaming", but `ArtifactPut` carries `sha256` in the first frame, before any byte. So the file is stream-hashed once, then streamed and hashed again; a file that changed in between is refused locally. No whole-file buffer either time.
2. **`run()`'s signal cancels the job; `attach()`'s only stops listening.** Aborting `run` sends `{ type: 'cancel' }` on the job stream (or `job.cancel` when no stream is open) and still resolves with the host's final snapshot if the stream delivers it; otherwise it rejects `cancelled` and the record stays until the host reports the job finished. Aborting `attach` rejects `cancelled` and leaves the job alone. The spec does not say which; T11 should know.
3. **A failed `artifact.ack` does not fail `fetchArtifact`.** The file is already verified and in place; the host's copy goes at its 24 h expiry.
4. **Handshake deadline of 20 s** (`HANDSHAKE_MS`), on the injected timer, so a host that accepts the stream and never answers reads as offline rather than hanging `ensure()`.
5. **Automatic reconnection runs only while `resume(hostId)` is non-empty**, i.e. while a job's outcome is wanted. That is my reading of "while something is waiting on that host". A selected-but-idle host is reopened by the next `ensure()`/`call()`, not by a timer. An attempt made on demand does not advance the backoff.
6. **`unpaired` and `incompatible-version` stop automatic retries but not an explicit `ensure()`**, because `Hosts.add` returns the existing record when the same endpoint pairs again. The controller never removes a host record on any failure.
7. **A stream that dies during the handshake is reported `offline`** (connect fact 1). In `memoryConnect()` a remote-allowlist rejection surfaces as `unpaired`, so that particular path is covered only by the "host drops the stream before answering" test.
8. **A host answering `job.status` with `not-found` for a job we submitted** resolves as a synthesised `interrupted` snapshot with `kind: 'operation'`, `weight: 'heavy'` (the record does not store kind or weight).
9. A malformed frame or handshake is reported as `incompatible-version`.
10. `fetchArtifact` never overwrites: a second file of the same name gets `-<first 8 of id>` before its extension. Host-supplied names lose separators, control characters and `:`; a name of only dots becomes the artifact id.

## Gaps in files I do not own

- **Connect hints have nowhere to live.** `PairedHost` has no hints field and `Hosts.touch` cannot write one. The controller calls `hints.load(hostId)` before connecting (→ `setPeerHints`) and `hints.save(hostId, …)` after a welcome (← `readConnectHints`); T13 needs to back that with a kv key or `types.ts`/`hosts.ts` need a field. Without the option, nothing is persisted.
- **The allowlist is not the controller's.** A `connect.open` rejected `unpaired` by the local allowlist means `connect.allow(hosts.allowlist())` was not kept current; that wiring belongs to T13.
- **`hostProtocol.ts` (T9) did not exist while I worked**, so the host end in my tests is scripted from the spec. Three behaviours I rely on that the spec does not pin down: what the host does with an `attach` for a job it no longer knows (I handle a closed stream, then ask `job.status`), that `seq` is strictly increasing per job (any starting value works), and that an `artifact` `get` stream ends after the last byte. Worth one integration test once T9 lands.

## Not verified

- Nothing was run against the real sidecar or a real `HostProtocol`; all tests use `memoryConnect()` and a scripted host.
- `RemoteJobs` has no `close()`: its controller subscription ends when the controller closes.
