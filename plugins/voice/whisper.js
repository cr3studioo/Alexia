// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * Getting Whisper onto this machine, and running it once it is here.
 *
 * Everything in this file happens **inside the plugin process**, which is the whole point:
 * the binary is spawned here, the microphone is opened here, and what crosses the wire to
 * core is a sentence. Core has no idea any of this is happening, and would not be able to
 * find out.
 */

/**
 * A whisper.cpp release, pinned.
 *
 * Pinned rather than *latest* on purpose: an unpinned URL changes what runs on somebody's
 * machine, silently, on a schedule nobody here controls. Moving it is an edit to this line
 * and a release of this plugin, which is the same bar as any other code change.
 */
const RELEASE = 'b4938'

/**
 * Where a prebuilt CLI comes from, per platform.
 *
 * ponytail: Windows x64 only, because it is the only one that has been run. The project
 * publishes `whisper-bin-ubuntu-x64.tar.gz` and an xcframework with no CLI in it — the
 * Linux asset is two lines away, but *supports Linux* is not a thing to write down before
 * anybody has watched it work. Everywhere else the answer is the `whisper_path` setting,
 * which is exactly the case that widget exists for.
 */
const BUILDS = {
  'win32-x64': {
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}/whisper-bin-x64.zip`,
    archive: 'whisper-bin-x64.zip',
    cli: 'whisper-cli.exe',
    stream: 'whisper-stream.exe',
  },
}

/** The models, and what a person is agreeing to download when they pick one. */
export const MODELS = {
  tiny: { file: 'ggml-tiny.bin', mb: 75 },
  base: { file: 'ggml-base.bin', mb: 148 },
  small: { file: 'ggml-small.bin', mb: 488 },
}

const MODEL_HOST = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export const build = () => BUILDS[`${process.platform}-${process.arch}`]

/** Everything this plugin puts on disk, all of it under the one directory purge removes. */
export const where = (ownDir, size) => ({
  bin: join(ownDir, 'whisper'),
  model: join(ownDir, 'models', (MODELS[size] ?? MODELS.base).file),
})

const there = async (path) => {
  try {
    return (await stat(path)).size > 0
  } catch {
    return false
  }
}

/**
 * The two programs, wherever they ended up.
 *
 * The archive's internal layout is the release's business and it has changed before, so it
 * is searched rather than assumed — one shallow walk over a folder holding thirty files.
 * `whisper_path` short-circuits all of it: somebody who already has a build that suits
 * their machine should not be made to download a worse one.
 */
export async function programs(ownDir, size, override) {
  if (override) return { cli: override, stream: undefined, model: where(ownDir, size).model }
  const spec = build()
  if (!spec) return undefined
  const { bin } = where(ownDir, size)
  const found = await find(bin, [spec.cli, spec.stream])
  return found[spec.cli] ?
      { cli: found[spec.cli], stream: found[spec.stream], model: where(ownDir, size).model }
    : undefined
}

/** Whether everything needed to answer is actually on disk right now. */
export async function ready(ownDir, size, override) {
  const found = await programs(ownDir, size, override)
  return found !== undefined && (await there(found.cli)) && (await there(found.model))
}

/**
 * Fetch what is missing, saying how far along it is the whole way.
 *
 * A download with no feedback is indistinguishable from a hang, and this one is between 75
 * and 488 megabytes — so `onProgress` is not decoration, it is the difference between
 * waiting and force-quitting.
 */
export async function install(ownDir, size, override, onProgress) {
  const { bin, model } = where(ownDir, size)
  const spec = build()

  if (!override && spec && !(await programs(ownDir, size, undefined))) {
    await mkdir(bin, { recursive: true })
    const archive = join(bin, spec.archive)
    await fetchTo(spec.url, archive, (done, total) =>
      onProgress?.(done, total, `Downloading Whisper — ${mb(done)} of ${mb(total)} MB`),
    )
    onProgress?.(1, 1, 'Unpacking Whisper')
    await extract(archive, bin)
    // The archive has done its job and is a third of the folder's size.
    await rm(archive, { force: true })
  }

  if (!(await there(model))) {
    await mkdir(join(ownDir, 'models'), { recursive: true })
    const file = (MODELS[size] ?? MODELS.base).file
    await fetchTo(`${MODEL_HOST}/${file}`, model, (done, total) =>
      onProgress?.(done, total, `Downloading the ${size} model — ${mb(done)} of ${mb(total)} MB`),
    )
  }

  return programs(ownDir, size, override)
}

/**
 * One file, streamed to disk, with the length checked at the end.
 *
 * A truncated model is the failure that actually happens on a domestic connection, and it
 * does not announce itself — whisper.cpp loads half a file and says something about tensors
 * instead of something about the network. Checking the length turns that into one sentence.
 *
 * ponytail: length only, no checksum. Checksums and signatures are M3-7, and that is where
 * the published digests and the verification path belong; this catches the dropped
 * connection, not a hostile mirror.
 */
async function fetchTo(url, to, onProgress) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`${url} answered ${response.status} ${response.statusText}`)
  }
  const total = Number(response.headers.get('content-length') ?? 0)
  let done = 0
  const partial = `${to}.part`

  await pipeline(
    async function* () {
      for await (const chunk of Readable.fromWeb(response.body)) {
        done += chunk.byteLength
        onProgress?.(done, total)
        yield chunk
      }
    },
    createWriteStream(partial),
  )
  if (total > 0 && done !== total) {
    await rm(partial, { force: true })
    throw new Error(`${url} stopped after ${mb(done)} of ${mb(total)} MB`)
  }
  // Renamed only once it is whole, so a download killed halfway is not mistaken for a file.
  await rename(partial, to)
}

/**
 * The archiver, and on Windows the *right* one.
 *
 * Windows 10 and later ship bsdtar as `System32	ar.exe`, and it reads zip — so there is no
 * zip parser here and no dependency for one, which matters more than the line count because a
 * zip parser is a parser and this one would be reading a file off the internet.
 *
 * What is on `PATH` may not be that tar. Git for Windows puts GNU tar there, which cannot
 * read zip **and** reads a drive-lettered path as `host:path` — so it fails trying to resolve
 * a hostname one letter long, which is a confusing way to learn any of this. Asking the OS
 * for its own copy is one line and removes both problems.
 */
const archiver = () => {
  const root = process.env.SystemRoot
  return process.platform === 'win32' && root ? join(root, 'System32', 'tar.exe') : 'tar'
}

function extract(archive, to) {
  return new Promise((resolve, reject) => {
    const tar = spawn(archiver(), ['-xf', archive, '-C', to], { stdio: ['ignore', 'ignore', 'pipe'] })
    let said = ''
    tar.stderr?.on('data', (chunk) => (said += String(chunk)))
    tar.on('error', reject)
    tar.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`could not unpack ${archive}: ${said.trim() || `tar exited ${code}`}`)),
    )
  })
}

/** Look for these names in a folder and one level under it. The releases nest by one. */
async function find(dir, names) {
  const found = {}
  const look = async (at, depth) => {
    let entries
    try {
      entries = await readdir(at, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory() && depth > 0) await look(join(at, entry.name), depth - 1)
      else if (names.includes(entry.name)) found[entry.name] ??= join(at, entry.name)
    }
  }
  await look(dir, 2)
  return found
}

/**
 * Whisper on a file, and nothing but the words back.
 *
 * `-np -nt` is what makes that true: everything whisper.cpp normally prints about backends
 * and tensors goes to stderr, and stdout is left holding the transcript alone.
 */
export function transcribe({ cli, model, file, threads, signal }) {
  return run(cli, ['-m', model, '-f', file, '-np', '-nt', '-l', 'auto', '-t', String(threads)], signal)
}

/**
 * The microphone, for as long as it takes somebody to say something.
 *
 * `--step 0` puts whisper-stream in voice-activity mode: it waits, and transcribes when the
 * speaking stops, rather than chopping the clock into windows. What comes back here is text.
 * **The samples stay in this process and are dropped when it ends** — nothing writes them to
 * disk, nothing puts them on the wire, and core has no method that could ask for them.
 */
export function listen({ stream, model, seconds, threads, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      stream,
      ['-m', model, '--step', '0', '--length', '8000', '-vth', '0.6', '-l', 'auto', '-t', String(threads)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let said = ''
    // Somebody spoke and has now stopped. That is the answer — waiting for a second pass
    // would only add the room to it, and the program itself never stops on its own.
    const read = passes((words) => stop(() => resolve(words)))

    const stop = (settle) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      child.kill()
      settle()
    }
    const abort = () => stop(() => reject(new Error('stopped')))
    // Nobody said anything in the time they were given, which is an answer too.
    const timer = setTimeout(() => stop(() => resolve('')), Math.max(1, seconds) * 1000)
    signal?.addEventListener('abort', abort, { once: true })

    child.stderr.on('data', (chunk) => (said += String(chunk)))
    child.stdout.on('data', (chunk) => read(String(chunk)))

    child.on('error', (error) => stop(() => reject(error)))
    child.on('close', (code) => {
      if (code === 0 || code === null) stop(() => resolve(''))
      else stop(() => reject(new Error(lastLine(said) || `whisper-stream exited ${code}`)))
    })
  })
}

/**
 * whisper-stream's output, read as passes.
 *
 * Feed it whatever arrives on stdout and it calls back once per pass that contained speech.
 * It is separate from the spawn above because it is the part with a decision in it — *when
 * to stop listening* — and because a microphone and somebody willing to speak into it are a
 * poor thing for a test to need.
 *
 * The program brackets each pass with headings of its own. What is between them is what it
 * heard; everything else is it talking about itself. A pass that heard nothing is skipped
 * rather than reported, or the first noise in the room would end the wait.
 */
export function passes(onSpeech) {
  let buffer = ''
  let inside = false
  let heard = ''
  return (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('### Transcription') && line.includes('START')) {
        inside = true
        heard = ''
      } else if (line.startsWith('### Transcription') && line.includes('END')) {
        inside = false
        const words = spoken(heard)
        if (words) onSpeech(words)
      } else if (inside) heard += `${line}\n`
    }
  }
}

/** Spawn, collect stdout, and turn a non-zero exit into the sentence stderr ended on. */
function run(program, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], signal })
    let out = ''
    let said = ''
    child.stdout.on('data', (chunk) => (out += String(chunk)))
    child.stderr.on('data', (chunk) => (said += String(chunk)))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(lastLine(said) || `${program} exited ${code}`)),
    )
  })
}

/**
 * What Whisper printed, as words rather than as a transcript file.
 *
 * Two things have to come off, and both of them are the difference between an answer and a
 * mess. `whisper-stream` has **no `--no-timestamps`**, so every line arrives wearing a
 * `[00:00:00.000 --> 00:00:04.000]` prefix that its file-reading sibling can be told to
 * omit. And a pass over a quiet room is not empty — it is `[BLANK_AUDIO]`, or `[ Inaudible ]`,
 * or `(silence)`, which handed on unedited would be a model told that somebody said the
 * words *blank audio*.
 */
export const spoken = (text) =>
  text
    .split('\n')
    .map((line) => line.trim().replace(TIMESTAMP, '').trim())
    .filter((line) => line && !NON_SPEECH.test(line))
    .join('\n')
    .trim()

const TIMESTAMP = /^\[\d\d:\d\d:\d\d\.\d{3}\s*-->\s*\d\d:\d\d:\d\d\.\d{3}\]\s*/
/** A whole line that is only a bracketed note. Whisper's way of saying it heard nothing. */
const NON_SPEECH = /^[([][^\])]*[)\]]$/

/** What a program that failed said last, which is almost always the useful part. */
const lastLine = (text) => text.trim().split('\n').at(-1)?.trim() ?? ''

const mb = (bytes) => Math.round(bytes / 1e5) / 10
