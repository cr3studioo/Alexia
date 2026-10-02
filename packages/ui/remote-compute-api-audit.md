# U2: screen and compute route audit

Audited against `docs/spec/remote-compute.md` section 6, the T13 screen-change list,
T16's original screen report, and `packages/core/src/compute/api.ts` on 2026-10-02.
All source changes are in `packages/ui`; the owner's other UI changes were preserved.

## Changes and mismatches found

1. A waiting role switch only polled. It now offers **Stop waiting** via
   `POST /api/compute/role/cancel`, then reads the role again, and **Cancel them and switch**
   via `POST /api/compute/role { role, cancel: true, confirm: true }`.
   Stopping invalidates older reads and stops the waiting poll.
2. Host setup inferred completion from `inventory.setup`, and looked for light jobs in
   the heavy queue. It now follows `GET /api/compute/job?host=...&job=...`, draws numeric
   progress and the progress message, and shows both the failure sentence and its detail.
   A requirement disappearing before the job ends does not stop following it; a job
   succeeding before inventory changes is shown as finished.
3. The queue only remembered jobs cancelled through this screen. It now also reads
   `GET /api/compute/jobs?host=...`, showing finished, failed and interrupted jobs in
   the returned newest-first order, without offering cancellation for terminal jobs.
4. The compute page lacked its own setup list. It now reads `GET /api/compute/inventory`
   without a host and installs with `{ requirement }`, following `job` without a host.
5. The compute page offered `use`, which the compute API refuses. Its picker now offers
   installation and import without selection or a mode override, and hides Use controls.
6. A remote download was labelled “Install & use” and could send a mode, even though
   the remote API drops that mode. It now says **Install**, sends no mode, and offers
   **Use this model** after completion as a separate, explicit host-qualified `use`.
7. Remote use offered Combined when Cloud was selected. It now offers only Local;
   selection from Combined explicitly sends `mode: 'local'`, and selection from Local
   may omit the mode. No remote use sends Combined or a body `host` field.
8. A completed remote job could vanish when the refreshed overview omitted it. The
   remote picker retains known terminal downloads so the later selection stays available.
   This retention change is restricted to remote views.
9. The remote picker exposed maintenance, which `api.ts` refuses for paired hosts.
   Maintenance, import, import-preview, token entry and the Ollama escape are offered
   only for this computer. Context configuration, benchmarking and removal remain remote.
10. Role refusal handling expected `said`/`why`, but the actual role routes can return
    `{ ok: false, note }`. The compute request reader now also reads `note`.
11. Browser compute shapes duplicated shared types and omitted inventory machine/models.
    Compute types now use erased type imports; the UI TypeScript project references core.
    `ComputeState.pairing` is explicitly `Omit<PairingStatus, 'code'>`.
12. Fetch fixtures retained a shown host after explicit unpair and treated every model
    refusal as 409. They now return `selected: 'this'` after explicit unpair, unknown-host
    `404 unpaired`, offline/busy 503 and worker-failure 502. The UI already adopts the
    hosts answer, and reads the body code independently of the status. A host removed
    another way while still selected continues to get the “no longer paired” row.
13. The state fixture previously had no pairing privacy boundary. It now returns pairing
    without its code on `/api/state`; `pair/start` and `GET /api/compute/pair` supply it.
    The code display is cleared when pairing settles.

## Every fetch audited

| Source | Request and response checked |
| --- | --- |
| `compute.ts` role | GET role `{ role, switching?, active }`; POST role `{ role, confirm, cancel? }` and POST role/cancel → `{ ok, note }` |
| `compute.ts` pairing | POST pair/start `{ code }` or `{}` → `{ ok, pairing }`; GET pair → `{ pairing? }`; POST pair/cancel → `{ ok }` |
| `compute.ts` hosts | GET hosts → `{ hosts, selected, available }`; POST select `{ host }`; POST unpair `{ host, confirm: true }` → `{ ok }` |
| `compute.ts` host/setup | GET inventory with host for interaction or no host for compute → `{ inventory?, connection, failure? }`; POST setup/install with `{ host, requirement }` or `{ requirement }` → `{ ok, job }`; GET job with job and optional host → `{ job }` |
| `compute.ts` queue | GET queue with optional host → `{ queue }`; GET jobs with optional host → `{ jobs }`; POST jobs/cancel `{ host, job }`, with `host: 'this'` for compute → `{ ok, job }` |
| `compute-setup.ts` | GET own queue → `{ queue }`; POST pause `{ paused }`; POST window/close → `{ ok }`; its mounted setup/model requests follow the rows above/below |
| `local-models.ts` overview | GET `/api/local-models` with optional host → overview with machine, runtime, installed models and jobs |
| `local-models.ts` download | POST install → raw picker Job, not `{ job }`; GET progress `?job=...` → raw Job; POST cancel `{ job }` → `{ ok }`; all name the remote host when applicable |
| `local-models.ts` selection | POST use `{ id, mode? }`; remote id is `@<host>/<model>`, no body host, Local or absent mode; response `{ ok, said, data? }` |
| `local-models.ts` search | GET search `?q=...&format=...` → Hit[]; GET repo `?repo=...&format=...` → Repo; remote host appended to the query |
| `local-models.ts` configuration | GET context with id/context/kvCache/draftModelId query → ContextPreview; POST context with numeric context and nullable draftModelId → `{ ok, said }`; remote host in query/body respectively |
| `local-models.ts` benchmark/removal | POST benchmark `{ id }` → raw Job; DELETE encoded model id with remote host in query → `{ ok, said }` |
| `local-models.ts` own-only operations | GET maintenance; GET import-preview `?path=...`; POST import `{ path, storage, mode? }`; POST token `{ token }`. These exist on compute itself and the interaction computer, and are hidden for a remote host |
| `local-models.ts` first-run escape | POST rows `{ key: 'models' }` → `{ rows }`; POST action `{ key: 'use_model', row }` → existing action result. These existing shell routes are outside the compute family and hidden remotely |
| `mode-transition.ts` | No fetch is made here. Its injected read consumes `/api/state`'s existing modeTransition, including target and targetStatus; their fields match the shared types |

The unused status/services routes need no new screen fetch. Inventory already includes the
connection and failure, and target status comes through state.

## Validation

- `pnpm vitest run --project unit packages/ui`: pass, 26 files / 338 tests (324 existing + 14 new).
- `pnpm vitest run --project invariants packages/core/test/invariants/06-no-node-apis-in-ui.test.ts packages/core/test/invariants/08-no-overclaiming-strings.test.ts`: pass, 2 files / 5 tests.
- `pnpm exec tsc -b packages/ui/tsconfig.test.json`: pass.
- `pnpm exec eslint packages/ui`: pass.
- `pnpm exec depcruise packages`: pass, no dependency violations.
- `pnpm typecheck`: pass.
- The earlier focused run `pnpm vitest run --project unit packages/ui/test/compute.test.ts packages/ui/test/localModels.test.ts packages/ui/test/modeTransition.test.ts` passed 54 tests before the added cases.
- An initial combined typecheck/ESLint run failed on two unused test imports while their test cases were being added; the completed tests use both imports, and the final check is clean.

Modified: `src/compute.ts`, `src/compute-setup.ts`, `src/local-models.ts`,
`test/compute.test.ts`, `tsconfig.json`. Created: this report.

## Outside UI ownership / uncertainty

- At the audit checkpoint, core's unknown-host **unpair** refusal was `404` with
  `code: 'not-found'`, whereas section 6's general unknown-host rule says `unpaired`.
- Core's generic `STATUS.unpaired` was 409. Its HTTP paired-host validator explicitly
  returns `404 unpaired`, so the normal inventory/model/queue routes satisfy the rule;
  the generic error mapping remains a discrepancy for other unpaired errors.
- No live app or real core was exercised; new behavior is covered by stubbed fetch,
  as requested. No full `pnpm check` was run; the known pre-existing core command test
  at `packages/core/test/command.test.ts:90` was not changed.
