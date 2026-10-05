# T11 report: bridge and operations

T11 implementation is complete and uncommitted. Created only packages/core/src/compute/bridge.ts, packages/core/src/compute/operations.ts, packages/core/test/compute-bridge.test.ts, packages/core/test/compute-operations.test.ts, and packages/core/test/fixtures/compute-host.ts.

Bridge: authenticated 127.0.0.1 ephemeral listener; separate selection and answer preparations; unique URL token and bearer key per lease; strict POST/content-length/body limit; concurrent raw request upload and InferHead reading; status/content-type and response bytes forwarded through pipeline without parsing; abort resets infer; a broken answer destroys its HTTP response with exactly one infer stream and no retry; release closes the last lease port immediately and sends host release; deselect preserves active answers; select reports connecting/queued/loading/ready/failure; idle release re-prepares on the next request.

Operations: reads selectedHost once; local calls preserve arguments and signal and read SDK structuredContent; remote capability missing/unready rejects setup-required without fallback; approved input paths are recursively replaced with {$artifact:id} after upload; RemoteJobs owns cancellation; progress/text/artifacts are collected; outputs are deduplicated, checked against the submitted job, fetched/hash-verified/acknowledged into toDir; unsuccessful snapshots keep their failure.

Final commands/results:
- pnpm vitest run --project unit packages/core/test/compute-bridge.test.ts packages/core/test/compute-operations.test.ts: PASS, 36 tests.
- pnpm vitest run --project unit packages/core/test/compute-bridge.test.ts packages/core/test/compute-operations.test.ts packages/core/test/compute-controller.test.ts packages/core/test/compute-jobs.test.ts packages/core/test/compute-transfer.test.ts packages/core/test/local-provider.test.ts packages/core/test/provider.test.ts: PASS, 102 tests across 7 files.
- pnpm exec tsc -b: PASS on corrected files; pnpm typecheck: PASS, exit 0.
- pnpm exec eslint packages/core/src/compute/bridge.ts packages/core/src/compute/operations.ts packages/core/test/compute-bridge.test.ts packages/core/test/compute-operations.test.ts packages/core/test/fixtures/compute-host.ts: PASS, exit 0.
- pnpm exec depcruise packages: PASS, 330 modules / 1634 dependencies.
- pnpm invariants: PASS, 36 tests across 13 files.
Initial helper accessor typings/unused declarations and a pending-selection cleanup regression failed during development, were corrected, and all final checks above passed. No full pnpm check was run; the known command.test.ts:90 baseline was not changed.

Remaining seams/limits: provider.ts still needs T12 to send prepare().model in the HTTP request; you explicitly confirmed this remains T12 ownership. Tests therefore compare existing chat() with an explicit native model request through Bridge against the same direct stub, separately assert remoteProvider parses a qualified catalog identity and returns the native model, and independently check arbitrary image/parameter/SSE bytes. HostProtocol is still absent: the exported ScriptedComputeHost helper and memoryConnect transport stand in for it; real sidecar/host/hardware integration remains unverified. Input-path replacement is an interpretation of the otherwise unspecified interaction-side mapping, matching Artifacts.resolve and preserving the caller's original args; no shared types or existing files were edited.
{"taskId":"task_1a1ee0dd8c45","dispatchId":"ctx_c9ec63c1ef15"}
