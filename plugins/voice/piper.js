// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { extract, fetchTo, find, mb, run, there } from './fetching.js'

/**
 * Speaking, with Piper (M2-4).
 *
 * The mirror of `whisper.js`: a pinned build, a voice fetched once, and a child process that
 * turns text into a WAV file. Piper is the default rather than Kokoro because it is small
 * enough to be part of a first run — 22 MB of program and 63 MB of voice against Kokoro's
 * ONNX runtime and phonemizer, which is a dependency shape this plugin has managed to avoid
 * entirely (see the plan's M2-4 note for what taking the upgrade would cost).
 */

/** Pinned, for the same reason Whisper's is: an unpinned URL changes what runs, silently. */
const RELEASE = '2023.11.14-2'

/**
 * ponytail: Windows x64 only, matching `whisper.js`. Piper publishes Linux and macOS
 * tarballs of the same shape, and they are three lines away — but *supports macOS* is not a
 * thing to write down before anybody has watched it work. Elsewhere the answer is the
 * `piper_path` setting, which is what that widget is for.
 */
const BUILDS = {
  'win32-x64': {
    url: `https://github.com/rhasspy/piper/releases/download/${RELEASE}/piper_windows_amd64.zip`,
    archive: 'piper_windows_amd64.zip',
    exe: 'piper.exe',
  },
}

/**
 * The voices, and what a person is agreeing to download when they pick one.
 *
 * Three, from one publisher, in one language — enough that the choice is real and few enough
 * that every one of them has been run. A voice picker over the whole of `piper-voices` is a
 * screen of its own and belongs with the marketplace, not here.
 */
export const VOICES = {
  amy: { at: 'en/en_US/amy/medium', file: 'en_US-amy-medium', mb: 63 },
  lessac: { at: 'en/en_US/lessac/medium', file: 'en_US-lessac-medium', mb: 63 },
  ryan: { at: 'en/en_US/ryan/high', file: 'en_US-ryan-high', mb: 114 },
}

const VOICE_HOST = 'https://huggingface.co/rhasspy/piper-voices/resolve/main'

export const build = () => BUILDS[`${process.platform}-${process.arch}`]

/** Everything Piper puts on disk, all of it under the one directory purge removes. */
export const where = (ownDir, voice) => {
  const chosen = VOICES[voice] ?? VOICES.lessac
  return {
    bin: join(ownDir, 'piper'),
    model: join(ownDir, 'voices', `${chosen.file}.onnx`),
    // Piper will not load a voice without its config, and the config is the half that
    // carries the sample rate — so a missing one is silence rather than an error.
    config: join(ownDir, 'voices', `${chosen.file}.onnx.json`),
    wav: join(ownDir, 'spoken.wav'),
  }
}

export async function programs(ownDir, voice, override) {
  const spec = build()
  const { model, config, wav } = where(ownDir, voice)
  if (override) return { exe: override, model, config, wav }
  if (!spec) return undefined
  const found = await find(where(ownDir, voice).bin, [spec.exe])
  return found[spec.exe] ? { exe: found[spec.exe], model, config, wav } : undefined
}

/** Whether everything needed to say something out loud is actually on disk right now. */
export async function ready(ownDir, voice, override) {
  const found = await programs(ownDir, voice, override)
  return (
    found !== undefined && (await there(found.exe)) && (await there(found.model)) && (await there(found.config))
  )
}

export async function install(ownDir, voice, override, onProgress) {
  const { bin, model, config } = where(ownDir, voice)
  const spec = build()
  const chosen = VOICES[voice] ?? VOICES.lessac

  if (!override && spec && !(await programs(ownDir, voice, undefined))) {
    await mkdir(bin, { recursive: true })
    const archive = join(bin, spec.archive)
    await fetchTo(spec.url, archive, (done, total) =>
      onProgress?.(done, total, `Downloading Piper — ${mb(done)} of ${mb(total)} MB`),
    )
    onProgress?.(1, 1, 'Unpacking Piper')
    await extract(archive, bin)
    await rm(archive, { force: true })
  }

  if (!(await there(model)) || !(await there(config))) {
    await mkdir(join(ownDir, 'voices'), { recursive: true })
    await fetchTo(`${VOICE_HOST}/${chosen.at}/${chosen.file}.onnx`, model, (done, total) =>
      onProgress?.(done, total, `Downloading the ${voice} voice — ${mb(done)} of ${mb(total)} MB`),
    )
    await fetchTo(`${VOICE_HOST}/${chosen.at}/${chosen.file}.onnx.json`, config)
  }

  return programs(ownDir, voice, override)
}

/** Text in, a WAV file out. Piper reads what to say on stdin, which is why `run` takes input. */
export async function say({ exe, model, config, wav, text, signal }) {
  await run(exe, ['-m', model, '-c', config, '-f', wav, '-q'], { input: text, signal })
  return wav
}

/**
 * Out of the speakers, using what each platform already has.
 *
 * No audio library, and none wanted: a WAV file and the operating system's own player is the
 * whole of it. If the player is not there the spawn fails with a sentence naming it, which
 * is a better outcome than a dependency that has to be built on somebody's machine.
 */
export function play(wav, signal) {
  if (process.platform === 'darwin') return run('afplay', [wav], { signal })
  if (process.platform !== 'win32') return run('aplay', ['-q', wav], { signal })
  return run(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', `(New-Object System.Media.SoundPlayer $env:ALEXIA_WAV).PlaySync()`],
    // Through the environment rather than pasted into the command text. The path is core's
    // own and holds nothing a model chose, but a shell command built by concatenation is a
    // habit worth not having next to a tool a model calls.
    { signal, env: { ALEXIA_WAV: wav } },
  )
}
