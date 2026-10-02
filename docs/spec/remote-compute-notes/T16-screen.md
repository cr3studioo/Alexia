# T16 report: the screen (packages/ui)

Branch `cr3studioo/local-model-picker`, all changes uncommitted, only `packages/ui/**` touched.

## What was built

- **`src/compute.ts` (new)** — browser copies of the shared types, the seven state sentences
  (`stateSentence`), and five mounts:
  - `mountRole`: Interaction / Compute. Reads `GET /api/compute/role` before asking; with active
    jobs it offers "Wait for them, then switch" (no `cancel`) or "Cancel them and switch"
    (`cancel: true`), says existing chats are kept, then follows `switching` once a second
    through waiting / stopping / restarting.
  - `mountPairing`: compute side shows the code and a countdown; interaction side types it.
    Cancel, expired, failed and cancelled each ask for a fresh code; the field is emptied before
    the code is sent. Explains the mailbox service requirement.
  - `mountHostPicker`: This computer, each paired computer with Direct / Relayed / Offline and
    its reason, Pair another computer, two-press Unpair. In the compute role it is the one
    controller, and pairing is disabled until it is unpaired.
  - `mountQueue`: running job, FIFO waiting list, Cancel per job.
  - `mountHost`: connection state, state sentence, capabilities the host reports, setup list with
    the size on each Install button, and the queue.
- **`src/local-models.ts`** — takes a `host`; every request names it (`?host=` on GET/DELETE,
  body field on POST), so machine, fit verdicts, downloads and progress are the host's. `use`
  sends `@<host>/<model>` and is not forwarded. Import-from-file, the token field and the Ollama
  escape are hidden for a paired host. A refusal code is drawn as that state's sentence in
  place of the models.
- **`src/mode-transition.ts`** — `target` / `targetStatus`; the line reads
  `host · model · Direct — phase`; a settled failure opens the picker.
- **`src/settings.ts`** — role block on General; host picker and host detail above the local
  models view on Models. The models view waits for core's answer about which host is chosen.
- **`src/rail.ts`** — a remote model shows `name · host · Direct`.
- **`src/main.ts`** — reads `state.compute`, passes it to the rail, the mode line and Settings.
- **`compute.html` + `src/compute-setup.ts` (new)** — the compute role's page: pairing, paired
  controller, own queue, Pause, own model picker, role switch, Close window.
- **`app.css`** — styles for the above.
- **Tests** — `test/compute.test.ts` (new, 25 tests), plus one test each added to
  `test/modeTransition.test.ts` and `test/rail.test.ts`.

## Commands run

| Command | Result |
|---|---|
| `pnpm vitest run --project unit packages/ui` | pass, 26 files, 324 tests |
| `pnpm vitest run --project invariants packages/core/test/invariants/06-no-node-apis-in-ui.test.ts packages/core/test/invariants/08-no-overclaiming-strings.test.ts` | pass, 5 tests |
| `npx tsc -b packages/ui/tsconfig.test.json` | clean |
| `npx eslint packages/ui` | clean |
| `pnpm typecheck` (repo-wide) | clean |
| `npx eslint .` and `npx depcruise packages` (repo-wide) | clean |

Not run: `pnpm check` as a whole, and nothing in a real app or against a real core. The §6
routes do not exist in core yet, so every route is exercised only against stubbed `fetch`.

## Gaps in §6 the screen ran into (no route was invented)

1. **No way to read one job's state.** `setup/install` returns a `JobSnapshot`, but a light setup
   job may never appear in `GET /api/compute/queue`. The screen shows "Installing…" until the
   requirement leaves `inventory.setup`; it cannot show progress or a failure for that install
   unless the job shows up in the queue. Same for `interrupted`: it is rendered wherever an
   answer carries it (a host's `failure`, a job returned by cancel), but no route lists finished
   or interrupted jobs.
2. **No way to stop or escalate a role switch that is waiting.** `RoleSwitcher.request` refuses
   a second request while one is under way, so once "wait" is chosen the screen can only watch.
3. **The compute role has no route for its own setup list.** `GET /api/compute/inventory` and
   `POST /api/compute/setup/install` are interaction-only, so `compute.html` does not draw the
   "setup list with sizes" §2 lists for it.
4. **The compute page's own model picker** calls `/api/local-models`, which §1.6 does not say the
   compute service serves. If it does not, that block shows an error line.
5. **Where `host` goes on `DELETE /api/local-models/<id>`** is not stated (§6 says query on GET,
   body otherwise; DELETE has no body). The screen sends it in the query.
6. **`jobs/cancel` on the compute host's own queue**: the body is `{ host, job }`; the screen
   sends `host: 'this'` there.
7. `GET /api/compute/status` is not called: `inventory` already carries connection and failure,
   and the target's phase arrives on `modeTransition.targetStatus`.

## Needed from other owners

- `serve.ts` / `service.ts` must serve `compute.html` and `/compute-setup.js`, and
  `scripts/package.mjs` must copy `compute.html` (its file list names each html file).
- Until T13 lands, `/api/compute/hosts` and `/api/compute/role` do not exist: Settings then shows
  "Paired computers could not be read: …" above the local models, and an error line in the role
  block. The local models view itself still works for this computer.

## Uncertain

- First run still offers only this computer; the host picker lives in Settings → Models.
- The pairing field checks the code's shape (`number-word-word-word-word`, per
  `connect/README.md`) before sending. If the sidecar's format changes, that check must too.
- An installed row's "Chosen" mark for a paired host comes from the host's own overview, which
  may not know this computer's pin.
