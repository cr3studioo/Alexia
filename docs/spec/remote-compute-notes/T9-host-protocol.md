# T9 report: host protocol

Branch `cr3studioo/local-model-picker`, everything left uncommitted. No existing file was edited.

## Files created

- `packages/core/src/compute/hostProtocol.ts`
- `packages/core/test/compute-host-protocol.test.ts` (18 tests)
- `packages/core/test/compute-roundtrip.test.ts` (7 tests: real Controller, RemoteJobs and transfer against the real HostProtocol, scheduler, artifact store and a spawned fixture plugin worker, over `memoryConnect()`)

## Commands run, final results

| Command | Result |
|---|---|
| `pnpm vitest run --project unit packages/core/test/compute-host-protocol.test.ts packages/core/test/compute-roundtrip.test.ts` | pass, 25/25, five consecutive runs |
| `pnpm vitest run --project unit packages/core/test/compute-` | pass, 19 files, 278 tests |
| `pnpm vitest run --project unit` | 220 files pass, 1 fails: only the known baseline `command.test.ts` (2387 passed, 1 skipped, 1 failed) |
| `pnpm exec tsc -b` | exit 0 |
| `pnpm exec eslint <my three files>` and `pnpm exec eslint .` | exit 0, no output |
| `pnpm exec depcruise packages` | no dependency violations |
| `pnpm vitest run --project invariants packages/core/test/invariants/01-core-names-no-plugin.test.ts` | pass, 3 tests |

Not run: the full `pnpm invariants` suite, `pnpm check` as one command.

## Acceptance, and the test that shows each

- Version mismatch refused as `incompatible-version`: host test of that name.
- Infer returns the runner's SSE byte for byte (chunks cut mid-character): host test, and round-trip test 1 through `Controller.stream`.
- Closing the infer stream aborts the runner request: host test of that name (job ends `cancelled`).
- A job survives its stream closing: host test (also covers rising `seq`, idempotent re-submit, artifact get with offset, ack).
- One 15 s timer, interrupted exactly once: host test; round-trip test 5 (`cancelAll` once, `submit` once, `run()` resolves `interrupted`).
- Reconnect within grace resumes with existing ids: host test; round-trip test 4.
- Revoke cancels jobs and closes streams: host test (checked synchronously, before any await); round-trip test 7.
- Round trip: text inference, plugin operation with staged input and adopted output fetched and acknowledged, queued cancel, active cancel.
- Only registered operations; no path sent; inputs in job-scoped directories; hardware probed at admission: host tests.

## Mismatches between the two ends

None needed a change in `controller.ts`, `jobs.ts` or `transfer.ts`. The three behaviours T10 relies on are provided and tested from both sides: an attach for an unknown job ends the stream cleanly and `job.status` answers `not-found`; `seq` is strictly increasing per job; an artifact `get` stream ends after the last byte.

Points where I had to choose, all resolved on the host side:

1. **Leases.** The spec says "one lease per controller: a new prepare releases the old", but `bridge.ts` takes a second lease on the same model for every request. The lifecycle paragraph says a lease is released "by a prepare for another model", so: leases naming the same model share it, and a `prepare` for a different model releases them all. A throwaway probe ran the real `Bridge` (select, prepare, HTTP request, idle stop, request again) against this host and it worked; that probe is not in the tree because `bridge.ts` is another worker's file and mid-edit.
2. **Operation text.** `operations.ts` reads text only from `output` events, never from the final snapshot, so the host sends `result.text` as an `output` text event before `done` (chunked at 64K chars). Output artifacts go in the final snapshot only.
3. **A refused submit** (capability not installed, not ready, or an input that is not this job's) is one `done` event with state `failed` and is never queued, so `job.status` for it says `not-found`. `RemoteJobs` settles on the `done`; if that stream broke at exactly that moment it would report a synthesised `interrupted` instead of the real reason.
4. **Infer stream close after a complete answer.** `stream.pipeline` closes the stream once the answer is written, which looked like the controller giving up. A close with the whole answer written is not treated as cancellation.
5. **Revoke and `bye`.** `bye unpaired` is written and the stream is destroyed in the same tick. Over `memoryConnect()` the frame still arrives (tested); with the real sidecar this is unverified.

## Additions beyond the spec's signatures (all additive)

- `HostProtocolOptions` gains optional `store` (for `compute_paused`; without it a pause is not persisted), `setup`, `fetch`, `maxBodyBytes`, `graceMs`, `now`, `timer`, `log`.
- Exports `PAUSED_KEY`.
- `start()` calls `workers.bind(scheduler)`; registering twice is harmless, so a service that binds too changes nothing.
- A `Setup` is built internally when none is passed.
- If the controller's record disappears from `Hosts` while a session is open, that is treated as `revoke()`.

## Decisions worth confirming

- **Chat is a heavy scheduler job.** An answer waits in the FIFO queue behind a running operation; the host answers `busy` only while paused. Whether a chat should be refused `busy` instead of queued is unspecified.
- **A model load is a scheduler job** with id `prepare-<uuid>`, kind `chat`: it shows in the queue and as `job` events.
- **Released leases are remembered** (up to 64) so an infer naming one reloads the same model in place; an explicit `release` forgets it.
- **The infer body is buffered** in memory up to 64 MiB before the POST to the runner.
- **Hardware probes at prepare and admission are not awaited**, so they add no latency to the first token.
- **A job's inputs are deleted when it finishes**, and `artifacts.sweep()` runs after each operation job.
- **Failure messages are scrubbed of absolute paths** by a regex (T8 flagged that workers' messages are not). `result.text` from a worker is not scrubbed.
- **Job event log:** 500 events per job, consecutive progress coalesced to the latest, previews never stored.
- **Slow readers:** a control or job stream with more than 8 MiB unread is closed.

## Not done or not verified

- The 15 s process stop of a cancelled plugin worker (§10) is not here: it would need a timer and policy, and §10 assigns it to Scheduler/Workers. A cancelled plugin job finishes as soon as MCP cancellation returns.
- No first-frame deadline: a stream that opens and says nothing stays open until the transport closes it (rule 5 allows no further timers).
- Nothing was run against the real sidecar; all tests use `memoryConnect()`, an injected `fetch` for the runner, and injected timers.
- `Bridge` + `chat()` end to end against this host is not in a committed test (see mismatch 1).
- A welcome whose inventory exceeded 1 MiB would not be sent; not handled beyond that.
