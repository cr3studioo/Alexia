// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rename, stat, unlink } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * Fetching a model, which is the longest thing this plugin ever does.
 *
 * **Seven gigabytes is not a request, it is an errand**, and the two failures that matter are
 * both about what happens when it is interrupted. A download that restarts from zero because a
 * laptop slept is one somebody gives up on; a half-written file that looks finished is one that
 * fails later, inside ComfyUI, as a corrupt checkpoint nobody connects to the interruption.
 *
 * So: it streams to a `.part` beside the target and only renames when the bytes are all there,
 * and it resumes with a `Range` header when a `.part` is already on disk. The rename is the
 * commit — **a file at the real path is always a whole file.**
 */

/** How far along, in a shape a progress bar and a sentence can both use. */
const gb = (n) => `${(n / 1e9).toFixed(1)} GB`

/**
 * What is already on disk for this download, if anything.
 *
 * A finished file short-circuits the whole thing: asking for a model that is already there is
 * the ordinary case on a second run, and re-fetching it would be seven gigabytes of nothing.
 */
export async function have(to) {
  const size = async (path) => {
    try {
      return (await stat(path)).size
    } catch {
      return 0
    }
  }
  return { done: await size(to), part: await size(`${to}.part`) }
}

/**
 * Fetch it, resuming if there is something to resume.
 *
 * `expect` is the size the catalogue claims. It is checked rather than trusted — a server that
 * answers a range request with the whole file, or a proxy that truncates, both produce a file of
 * the wrong length, and **the rename is refused rather than a corrupt checkpoint being handed to
 * ComfyUI**. When the catalogue does not know the size, the server's own `content-length` is used
 * and the check still happens.
 */
export async function fetchModel(url, to, { expect, sha256, signal, onProgress, stallMs = STALL_MS, attempts = ATTEMPTS } = {}) {
  const there = await have(to)
  if (there.done > 0) {
    // **A file with the right name is not the right file.** Where the catalogue knows the hash,
    // the file on disk is checked before it is called finished; a different one is set aside —
    // never deleted, never used — and the real one is fetched.
    if (!sha256 || (await hashOf(to, signal)) === sha256) return { path: to, bytes: there.done, already: true }
    await rename(to, `${to}.mismatch`)
  }

  // **A connection that goes quiet is dropped and picked up again**, from the `.part`, a few
  // times. Without this a stalled socket — one that neither sends nor closes — waits forever
  // and the download looks alive when nothing is arriving. A refusal (a 4xx, a wrong file)
  // is not a stall and is not retried.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetchOnce(url, to, { expect, sha256, signal, onProgress, stallMs })
    } catch (error) {
      if (signal?.aborted || !error?.resumable || attempt >= attempts) {
        if (error?.resumable) throw new Error(`${error.message} Ask again and it will carry on from there.`, { cause: error })
        throw error
      }
      onProgress?.((await have(to)).part, Number(expect) || 0, `The connection went quiet — picking the download up again (try ${attempt + 1} of ${attempts})`)
    }
  }
}

/** How long a download may go without a byte before it is called stalled. */
export const STALL_MS = 60_000
const ATTEMPTS = 5
const resumable = (message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { resumable: true })

async function fetchOnce(url, to, { expect, sha256, signal, onProgress, stallMs }) {
  const from = (await have(to)).part
  // Our own abort, for a stall, joined with the caller's.
  const quiet = new AbortController()
  const both = signal ? AbortSignal.any([signal, quiet.signal]) : quiet.signal
  let timer
  const wait = () => {
    clearTimeout(timer)
    timer = setTimeout(() => quiet.abort(), stallMs)
    timer.unref?.()
  }
  wait()
  let response
  try {
    response = await fetch(url, {
      signal: both,
      headers: from > 0 ? { range: `bytes=${from}-` } : {},
    })
  } catch (error) {
    clearTimeout(timer)
    if (signal?.aborted) throw error
    throw resumable(quiet.signal.aborted ? 'the download stalled before it started.' : `could not reach the download: ${error?.message ?? error}.`, error)
  }
  if (!response.ok) {
    clearTimeout(timer)
    const said = `could not download the model: ${response.status} ${response.statusText}`
    // The server's own trouble passes; a refusal does not.
    throw response.status >= 500 ? resumable(`${said}.`) : new Error(said)
  }
  // A server that ignores `Range` answers 200 with the whole file, and appending to a partial
  // one would produce a file that is too long and quietly wrong. Start again instead.
  const resuming = from > 0 && response.status === 206
  const said = Number(response.headers.get('content-length'))
  const total = Number(expect) || (Number.isFinite(said) ? said + (resuming ? from : 0) : 0)

  let got = resuming ? from : 0
  let told = 0
  const counting = new TransformStream({
    transform(chunk, controller) {
      // Pass it on first. A transform that counts and forgets to enqueue writes an empty file
      // and reports every byte as having arrived, which is the worst possible pair.
      controller.enqueue(chunk)
      wait()
      got += chunk.length
      // Once a second at most. A progress event per 16 KB chunk of seven gigabytes is half a
      // million messages nobody reads and a bar that cannot keep up.
      const now = Date.now()
      if (now - told > 1000) {
        told = now
        onProgress?.(got, total, total > 0 ? `Downloading the model — ${gb(got)} of ${gb(total)}` : `Downloading the model — ${gb(got)}`)
      }
    },
  })

  try {
    await pipeline(
      Readable.fromWeb(response.body.pipeThrough(counting)),
      createWriteStream(`${to}.part`, { flags: resuming ? 'a' : 'w' }),
      { signal: both },
    )
  } catch (error) {
    if (signal?.aborted) throw error
    throw resumable(quiet.signal.aborted ? `the download stalled at ${gb(got)} of ${gb(total)}.` : `the connection dropped at ${gb(got)} of ${gb(total)}.`, error)
  } finally {
    clearTimeout(timer)
  }

  if (total > 0 && got !== total) {
    // Deliberately not renamed. The `.part` stays so the next attempt can resume it.
    throw resumable(`the download ended early — ${gb(got)} of ${gb(total)}.`)
  }
  // The whole file, resumed part included: a range that joined two different versions of a
  // model is the right length and the wrong bytes, and is not a checkpoint to resume from.
  if (sha256 && (await hashOf(`${to}.part`, signal)) !== sha256) {
    await unlink(`${to}.part`).catch(() => {})
    throw new Error('the downloaded model is not the expected file — its checksum does not match. Nothing was installed.')
  }
  await rename(`${to}.part`, to)
  return { path: to, bytes: got, already: false }
}

/** SHA-256 of a file on disk, streamed. */
export async function hashOf(path, signal) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  return hash.digest('hex')
}

/** Give up on a half-finished download. Only ever called because somebody asked. */
export async function forget(to) {
  await unlink(`${to}.part`).catch(() => {})
}
