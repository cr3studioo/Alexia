# T17 report: worker adapters (media and voice as compute workers)

All changes are uncommitted and confined to `plugins/media/**` and `plugins/voice/**`.

## What was built

### Media (`plugins/media`, 0.5.0 → 0.6.0, `alexia_protocol` 13)
- **Manifest**: `provides` gains `image.render`; `compute.operations = [image.render, heavy]`, `compute.hooks = [setup, install, prepare, release]`.
- **Split**: `generate` and `run_workflow` are now planners. They keep the person's side (prompt, size/seed and "again", settings, reading and filling the saved workflow, storage rows, the result text) and hand a plan to `compute.run('image.render', …)`. The operation (`render.js`) does everything only the rendering computer can answer: which checkpoint is installed, free VRAM, node classes, queue, wait, download.
  - `picture` plan: words and numbers; the starter graph is built on the rendering computer around a model it actually has.
  - `workflow` plan: a prepared API graph; re-checked against the rendering computer's node classes before it is queued.
- **Dedicated ComfyUI** (`worker.js`): a job that arrives from another computer runs in a second ComfyUI started from the detected install on its own port (first free from 8288; never 8188, never the port in the `server` setting, even if free). Its pid/port record (`worker` in plugin storage) is the only thing that makes a process stoppable. Output and temp folders are passed on the command line and live in the plugin's own directory; nothing is written into the install.
- **Hooks**: `setup` lists `comfyui` (instructions, no installer) when no install is found, or one model with its byte size when no checkpoint is present; it starts nothing. `install` downloads that one model and nothing else. `prepare` starts the dedicated ComfyUI. `release` stops it (pid alive AND answering on the recorded port), and also lets go of a ComfyUI Alexia started for local pictures.
- **Cancellation** (`comfy.cancel`): removes the job from the queue by id and interrupts only when that id is the one running, so a job in front of it that belongs to the person is not ended. This replaces the bare `/interrupt` the plugin used before, on the local path too.

### Voice (`plugins/voice`, 0.4.0 → 0.5.0, `alexia_protocol` 13)
- **Manifest**: `provides` gains `voice.recognize` (light), `voice.synthesize` (light), `voice.imitate` (heavy); hooks `setup`, `install`, `release`.
- **Split**: `transcribe` sends the file as an input and runs Whisper as `voice.recognize`. `speak` and `preview_voice` run Piper as `voice.synthesize` and Qwen3-TTS as `voice.imitate`, then play the returned recording locally. A voice the person added (custom Piper files, a Qwen clip) travels with the job as inputs. fish.audio (a cloud API call), expression markup (sampling), playback and the voice list stay on the interaction computer.
- **Hooks**: `setup` lists `hearing:<size>` and `speaking:<voice>` with byte sizes (program + model, whichever half is absent), instructions where there is no prebuilt program, and `qwen` as instructions only. `install` runs the existing `whisper.install` / `piper.install`. `release` aborts any inference still running; no model outlives the program that loaded it.
- A job from another computer never downloads: it fails with a sentence and records what it wanted (`wanted` in plugin storage) so that computer's setup list can offer it.

### Shared mechanism (`compute.js` in each plugin, duplicated because plugins cannot import each other)
- Each run carries a `trace`. An operation that finds it in its own process is being run by the tool that planned it (`here: true`) and behaves exactly as before: uses the ComfyUI at the `server` setting, downloads on first use, shows preview frames and the stage strip. Otherwise it is a worker.

## Files
Created: `plugins/media/compute.js`, `render.js`, `worker.js`, `test/compute.test.js`; `plugins/voice/compute.js`, `worker.js`, `test/compute.test.js`.
Modified: `plugins/media/index.js`, `comfy.js`, `launch.js`, `plugin.json`; `plugins/voice/index.js`, `whisper.js`, `piper.js`, `qwen.js`, `plugin.json`.

## Commands and results
- `pnpm vitest run --project unit plugins/voice plugins/media` — PASS, 17 files / 133 tests (16 new media tests, 13 new voice tests).
- `pnpm vitest run --project unit packages/conformance` — PASS, 2 files / 11 tests.
- `pnpm vitest run --project invariants` — PASS, 13 files / 36 tests. **`pnpm check:no-plugins` was not run**: it renames `plugins/` aside for the length of a full `pnpm check`, which would break other workers in this tree.
- `pnpm vitest run --project unit` (whole project) — 2438 passed, 2 failed, neither in files I own: `packages/core/test/command.test.ts:90` (the known baseline) and `packages/core/test/local-models-api.test.ts:68` (409 instead of 200), which passes when run alone (6/6).
- `pnpm exec eslint plugins/media plugins/voice` — PASS.
- Conformance checker run directly against the real `plugins/media` and `plugins/voice` (`exercise: false`): both `ok`; media has no warnings; voice has the `provides` warning for `voice.transcribe/speak/render` not bound because nothing is downloaded on this machine (same as before).
- A scratch plugin under the real core `Plugins` class, using `plugins/media/compute.js`: no compute seam → runs here; a local seam calling `computeCall` → runs here with the rich progress frame intact; a seam that refuses (`-32050 That computer is not ready…`, or a plain "offline" error) → the error is surfaced and nothing runs here.

The personal-ComfyUI test (`plugins/media/test/compute.test.js`, "a ComfyUI the person is running is never queued into, interrupted or stopped") stands a fake ComfyUI on port 8188 (or beside it, named via `avoid`, if 8188 is taken), runs a full job, a cancelled job and a release through the worker, and asserts the personal instance received zero requests, is still answering, and that `stop` was called only with the worker's own pid.

## Deviations, gaps and things to decide
1. **Local behaviour is "unchanged" by keeping the old ComfyUI rule on this computer.** With nothing paired, pictures still use whatever answers at the `server` setting (the person's own ComfyUI if open, or a remote address they configured), otherwise one Alexia starts there. The dedicated process is used only for jobs sent by another computer. The two requirements pull in opposite directions; this is my reading. If "dedicated" must hold locally too, it is one line in `connect()` in `plugins/media/index.js`, at the cost of a second ComfyUI on the card when the person has theirs open.
2. **Fallback when core has no compute seam.** `Host.options.compute` is not wired anywhere in this tree yet, so `alexia/compute/run` answers `-32050 compute is not available for <cap>`. The plugins run the operation in-process in exactly that case (and on `-32601`), matched on that message text from `packages/core/src/host.ts`. Any other error is surfaced. **If the interaction seam maps a paired host being offline or not set up to that same message, the plugins would run locally instead of failing** — it must use different words or a different code.
3. **SDK gap: `compute.run`'s `onProgress` carries only number/total/message.** Preview frames and the stage strip do not cross to the planner for remote jobs. Locally they survive only through the in-process trace. A `work` argument on `onProgress` (and `JobProgress`) would fix it.
4. **SDK gap: a plugin cannot ask whether its operation would be answered on the chosen computer.** `answers()` only speaks for this computer, so `image.generate`'s runtime binding (`alexia/provides`) still follows the local ComfyUI. The `generate` tool itself works with a paired host and no local ComfyUI; another plugin calling the `image.generate` capability would be told it is unavailable.
5. **`listen` (microphone) is unchanged and wholly local.** `whisper-stream` is capture and inference in one process and the plugin has no separate recorder, so there is no audio file to send. Only file transcription is routed.
6. **`run_workflow` still needs a ComfyUI on the interaction computer** to read the saved workflow from; only the rendering is routed. The workflow tools (`workflows`, `add_workflow`, `install_workflow`, `library`, …) and the `setup` button are unchanged.
7. **Input paths.** `transcribe` passes the person's file as an `inputs` entry. The contract says each path "must be one the plugin may already read"; if the interaction seam enforces roots strictly, a file outside them would be refused where today it is read directly.
8. **Sizes.** Model and voice sizes come from the existing tables. The program sizes are estimates I introduced as constants (`whisper.PROGRAM_MB = 8`, `piper.PROGRAM_MB = 22`, summing to the 30 MB the status line already used). With the card unread (ComfyUI not running), the media setup list offers SDXL (6.9 GB); with a card read it follows `tier.js`; with no card it offers SD 1.5.
9. **Weights.** `voice.recognize` and `voice.synthesize` are `light` so a spoken exchange does not evict the loaded chat model on every sentence; `voice.imitate` (Qwen3-TTS) is `heavy`. Worth a second opinion.
10. **Result metadata rides in `text` as one JSON line** (`{here, checkpoint, warning, text}`) because an operation answers only `text` and `files`.
11. New capability names (`image.render`, `voice.recognize`, `voice.synthesize`, `voice.imitate`) are not in `docs/spec/capabilities.md`; I did not edit docs.
12. `comfy.interrupt` is still exported but no longer called.
13. Not verified: real rendering, real downloads, real Whisper/Piper/Qwen runs, a real paired host, Windows. The dedicated ComfyUI's `--output-directory` / `--temp-directory` flags are long-standing but were not exercised against a real ComfyUI.
