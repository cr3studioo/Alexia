# T13 report: API routes and the one seam into serve.ts

Branch `cr3studioo/local-model-picker`, everything uncommitted.

## Files

Created

- `packages/core/src/compute/api.ts` — `ComputeApi` (every §6 route, both roles), pairing's last
  step, unpair, `RoleSwitching`, `scrub`, `hintStore`, `savedServices`, `localPicker`, `hostModels`.
- `packages/core/src/compute/interaction.ts` — `interactionCompute`.
- `packages/core/test/compute-api.test.ts` (16 tests) — two Alexias joined by `memoryConnect()`, over HTTP.
- `packages/core/test/compute-interaction.test.ts` (8 tests).

Modified

- `packages/core/src/serve.ts` — 29 lines added, 2 changed, nothing reformatted (below).
- `packages/core/src/guard.ts` — 19 `ROUTES` entries, one block.
- `packages/core/test/guard.test.ts` — the route scanner reads `compute/api.ts` as well as `serve.ts`.
- `docs/spec/remote-compute.md` — §6 rewritten to what was built.

`serve.test.ts` was not edited. No compute module built by another task was edited, and no export was added to one.

## The serve.ts seam

1. import of `interactionCompute` and `InteractionOptions`.
2. `ServeOptions.compute?: Pick<InteractionOptions, 'connect' | 'binary' | 'shell' | 'restart' | 'name'>`.
3. `STATIC['/compute.html']` (`/compute-setup.js` was already served by the module pattern).
4. `PluginsOptions.compute: (...asked) => compute.run(...asked)`.
5. `world()`: `local` gains `compute.models()`, `runners` gains `compute.provider`, `target: compute.remote.status()`.
6. `operating()` gains `|| compute.active() > 0`; `const compute = await interactionCompute({...})` just above `ModeTransitions`.
7. `ModeTransitions` gets `remote: compute.remote` (which carries `hostName`, T12's item).
8. The agent loop's `providers` gains `compute.provider`.
9. `/api/state` gains `compute: compute.api.state()`.
10. `if (await compute.api.handle(request, response, url, sent)) return` before the local-models block.
11. `close()` gains `await compute.close()` before `localRunners.stop()`.

The contract's point 6 has a second half ("inside the `/api/local-models` block … `compute.api.models`").
That is done inside `ComputeApi.handle` instead, so the owner's local-models block is untouched.

## Commands, final results

| Command | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` (eslint . && depcruise packages) | pass, no dependency violations |
| `pnpm invariants` | pass, 13 files, 36 tests |
| `pnpm vitest run --project unit packages/core/test/compute-api.test.ts` | pass, 16/16, five runs |
| `pnpm vitest run --project unit packages/core/test/compute-interaction.test.ts` | pass, 8/8 |
| `pnpm vitest run --project unit packages/core/test/guard.test.ts packages/core/test/serve.test.ts` | pass |
| `pnpm vitest run --project unit` (whole repo) | best run: 2439 pass, 1 skipped, 1 fail (the known `command.test.ts:90`) |

The whole-repo run was made seven times while other workers were running theirs (load average
up to 20). Four ended with only the baseline failure. Three also failed
`local-models-api.test.ts:68`, and one of those failed `compute-workers.test.ts` ("a plugin that
vanishes mid-job") as well. Neither file is mine.

- `local-models-api.test.ts:68`: I reproduced it with a temporary copy of the test that printed
  the refusal (deleted afterwards). The 409 is `This context and draft exceed the available memory
  budget.` — the test starts `serve()` with no machine stub, so `LocalModels.configure` judges fit
  against this Mac's real free memory, which drops while many test files run. It passes alone (ten
  runs). T17 saw the same failure. It is not caused by this task.
- `compute-workers.test.ts`: failed once in seven full runs and passes alone and in every smaller
  run. I did not diagnose it.

`pnpm invariants` failed once on the way, on my own comment: invariant 8 (no over-claiming
strings) rejected the words "nothing is sent anywhere" in `interaction.ts`. Reworded; it passes.

`pnpm check` as one command was not run. Nothing was run against the real sidecar, a real
`service.ts` (not written yet) or two machines.

## The notes' items

**T16-screen**, the seven gaps:

1. One job's state: `GET /api/compute/job?host=&job=` asks the host by id (setup-install progress
   and failure, finished and interrupted jobs). `GET /api/compute/jobs?host=` lists the last 50
   jobs this run heard about, finished and interrupted included. T16's premise was partly wrong:
   a light setup job *does* show as `queue.running` when no heavy job runs (`Scheduler.queue()`).
2. Stop or escalate a waiting switch: `POST /api/compute/role/cancel` stops it;
   `POST /api/compute/role` again with `cancel: true` for the same role cancels the work instead.
   Done with `RoleSwitching`, a subclass of `RoleSwitcher`, without touching `role.ts`.
3. The compute role's setup list: `GET /api/compute/inventory` and `POST /api/compute/setup/install`
   answer on a compute host about itself (`ComputeApiDeps.inventory`, `.setup`).
4. `/api/local-models` on a compute host: served by `ComputeApi.handle` when `ComputeApiDeps.models`
   is given (`localPicker(localModels)`), every route but `use` (409). `token` through `ComputeApiDeps.token`.
5. `host` on `DELETE /api/local-models/<id>`: the query, as the screen sends it. Core reads the
   query or the body on any method.
6. `jobs/cancel` with `host: 'this'` on a compute host: cancels in its own queue. On the
   interaction computer `'this'` is a 400.
7. `GET /api/compute/status`: built as specified, in both roles.

`compute.html` and `/compute-setup.js` are served by `serve.ts`.

**T10**: hints are persisted in kv `compute_hints` (`hintStore`), passed to the `Controller`, saved
on pairing and after each welcome, forgotten on unpair. `connect.allow(hosts.allowlist())` is
called, awaited and serialized on every pair and unpair, and once when the transport starts.

**T12**: `compute.remote.hostName(hostId)` — the mode line reads `Local · Test · Studio` in the test.

**T8**: every failure message and progress line the routes return, the target status handed to
the mode transition, and errors thrown by `select` and `run` pass through `scrub`. `hostModels`
scrubs picker jobs on the host before they cross. **Not closed:** `setup.ts` puts a worker's
install failure into the job snapshot unscrubbed (`error.failure()`), so that text still crosses
the link; it is scrubbed here before the screen. The fix is one call in `setup.ts` (T8's file).

**The coordinator's follow-up (T17's fallback)**: the adapters run a job in their own process
only on `-32050` with the words *compute is not available*, or `-32601`. When the selected host
is a paired computer, everything `InteractionCompute.run` throws goes through
`chosenHostRefusal`: always a `ComputeError` with the host's named code (never a protocol
error), and with that phrase removed from its sentence. With this computer as the target the
call runs here through `Plugins.computeCall`, as before. Since `serve.ts` now always passes a
compute seam, core itself no longer produces that pair at all. Test:
`compute-interaction.test.ts`, "a paired computer that cannot serve is never told to a plugin as
'no compute here'" (offline end to end, plus busy, setup-required, unpaired and the exact
code-and-words pair through `chosenHostRefusal`).

**T3**: a proven peer is recorded (`Hosts.add`), allowlisted and its hints kept before the pairing
reads `paired`. A missing or failing sidecar is `available: false` and `pair/start` → `409 setup-required`;
`serve()` starts either way.

## Deviations from the contract, for the coordinator to accept or reject

1. **The sidecar is not started at launch unless a computer is already paired.** The first
   `pair/start` starts it. Startup waits at most 3 s for it and adopts it when it arrives.
   `available` means "a sidecar is installed and has not failed to start".
2. **`interactionCompute` options gained** `cancel`, `activate`, `roots`, `restart`, `name`, `binary`.
   `shell` is typed `{ relaunch(): void }` because `compute/shell.ts` (T14) does not exist.
3. **`InteractionCompute` gained `run`** (the exact `PluginsOptions.compute` shape) and
   `remote.hostName`. `operations` is still there.
4. **`ComputeApiDeps` gained** `ready`, `start`, `available`, `active`, `hints`, `activate`,
   `inventory`, `setup`, `models`, `token`, `closeWindow`, `platform`. All optional.
5. **`ComputeApi.handle` also answers `/api/local-models…`** for a paired host (and all of it on a
   compute host). `ComputeApi` gained `close()`.
6. **A plugin's `alexia/compute/run` inputs are checked here, when the job goes to a paired
   computer**: each path must be inside the plugin's own directory, `<dataDir>/uploads` (what the
   person attached) or a folder in scope (`roots`), after `realpath`. Nothing checked them before.
   On this computer no file is moved and nothing is checked, so local behaviour is unchanged.
   This is T17's point 7: transcribing a file outside those places on a paired host is refused.
   **Worth the owner's eye.**
7. **`serve()` always reports role `interaction`**, since the compute role never calls it. Until
   T14's `entry.ts` exists, a restart after a switch to Compute still starts `serve()`.
8. **Two kv keys not in §5's table**: `compute_shown_host`, `compute_hints`.
9. **Without a shell, `restart` is `process.exit(0)`** as §1.2 says. `serve.ts` passes no shell yet.
10. A remote install's `mode` is dropped; a remote `use` with `mode: 'combined'` is a 409.
11. A run on this computer forwards the operation's progress to the caller's `onProgress`
    (`Operations.local` has no progress argument, so it is carried by the request's signal).

## What the screen (packages/ui) must change

- `compute.ts` `mountRole`: while `switching.phase === 'waiting'`, offer *Stop waiting*
  (`POST /api/compute/role/cancel`) and *Cancel them and switch* (`POST /api/compute/role`
  `{ role, cancel: true, confirm: true }`). After a stop, `GET /api/compute/role` has no `switching`.
- `compute.ts` `mountHost`: follow an install with `GET /api/compute/job?host=&job=` instead of
  waiting for the requirement to leave `inventory.setup`; show its progress and its failure.
- `compute.ts` `mountQueue`: read `GET /api/compute/jobs?host=` for jobs that have left the queue
  (finished, failed, interrupted) rather than only the ones it cancelled itself.
- `compute-setup.ts`: draw the setup list from `GET /api/compute/inventory` (no host) with
  `POST /api/compute/setup/install { requirement }`; hide *Use* on its picker (409 there).
- `local-models.ts`: after a remote install finishes, choosing the model is a separate
  `use { id: '@<host>/<model>' }`; `mode` on a remote install is ignored. A remote `use` with
  `mode: 'combined'` is refused: send `local` or no mode.
- `compute.ts` `mountHostPicker`: after unpairing the shown host, `selected` comes back as `'this'`,
  so the "no longer paired" row only appears if the record vanished some other way.
- Error statuses: an unknown host is `404` with `code: 'unpaired'`; `offline` and `busy` are `503`.
- `ComputeState.pairing` in `/api/state` never has `code`; the code is only in the `pair/start`
  answer and `GET /api/compute/pair`.

## For T14 (service.ts)

- Run `refuse(url.pathname, method, sent)` from `guard.ts` before `api.handle`; the confirm on
  `role` and `unpair` is asked there. The test's host rig shows the whole listener in ten lines.
- Pass `models: hostModels(localModels)` to `HostProtocol` and `models: localPicker(localModels)`,
  `inventory`, `setup`, `token`, `closeWindow`, `protocol`, `scheduler` to `ComputeApi`.
- Use `RoleSwitching` rather than `RoleSwitcher` so the switch can be stopped.
- Call `connect.allow(hosts.allowlist())` at start. `ComputeApi` keeps it current afterwards.

## Left undone or uncertain

- Unpairing from the interaction computer cannot make the host forget its controller: the
  protocol has no message for it. The host keeps listing it, and refuses any other, until
  somebody unpairs at the host. Its jobs are cancelled by this side first.
- A host's setup list cannot be re-checked on request from either side (no control method; a
  page read uses `inventory.current()`). It refreshes after an install, a model change or a restart.
- `hostProtocol.ts`'s own `scrub` turns `https://…` into `httpa file on that computer` (its
  drive-letter pattern matches `s:/`). `api.ts`'s copy is fixed; T9's is not mine to change.
- After a crash mid-job, `compute_jobs` rows make the controller retry an offline host every 5 s
  (T10's rule: "while something is waiting"). Unpair clears them; nothing else does.
- `GET /api/compute/hosts` attempts a session to every paired host on each poll (3 s in the
  screen) while it is open.
