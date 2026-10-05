// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, type Hash } from 'node:crypto'
import { constants, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readlinkSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

/**
 * Fetching a model file, which is the longest thing Alexia ever does.
 *
 * **Five gigabytes is not a request, it is an errand**, and the failures that matter are all
 * about what happens when it is interrupted. A download that restarts from zero because a
 * laptop slept is one somebody gives up on; a half-written file that looks finished is one
 * that fails later, inside llama.cpp, as a corrupt model nobody connects to the interruption.
 *
 * So it streams to a `.part` beside the target, resumes with a `Range` header when a `.part`
 * is already on disk, and only renames when the bytes are all there and — when the catalogue
 * knows the hash — are the right bytes. The rename is the commit: **a file at the real path
 * is always a whole file.**
 */

/** Why a download stopped, so the screen can say something better than "failed". */
export type DownloadFailure = 'http' | 'length' | 'hash' | 'disk' | 'aborted' | 'timeout'

export class DownloadError extends Error {
  readonly kind: DownloadFailure
  constructor(kind: DownloadFailure, message: string) {
    super(message)
    this.name = 'DownloadError'
    this.kind = kind
  }
}

/** How far along, in a shape a progress bar and a sentence can both use. */
export interface DownloadProgress {
  done: number
  /** `0` when neither the catalogue nor the server said how big it is. */
  total: number
  /** Smoothed, so the "about four minutes left" does not jump about with every packet. */
  bytesPerSecond?: number
}

export interface DownloadOptions {
  /** The size the catalogue claims. Checked rather than trusted — see `download`. */
  bytes?: number
  /** Lower-case hex. When given, the rename waits for it to match. */
  sha256?: string
  signal?: AbortSignal
  /**
   * Sent with the request — an `Authorization` for a gated Hugging Face repo. The first hop
   * is the Hub, which answers with a redirect to a signed CDN address; `fetch` follows it and,
   * per the Fetch standard, drops `Authorization` when the redirect crosses to another origin,
   * so the token never reaches the CDN. The signed address does not need it.
   */
  headers?: Record<string, string>
  /**
   * How much room must be left over *after* the download. Filling a disk to the last byte is
   * how a Mac stops being able to save anything else, including the rest of this.
   */
  minFreeBytes?: number
  /** Maximum time without I/O progress, including waiting for response headers. Default: 30s. */
  timeoutMs?: number
  onProgress?: (p: DownloadProgress) => void
  /** For tests. */
  fetch?: typeof fetch
}

const gb = (n: number): string => `${(n / 1e9).toFixed(1)} GB`
const part = (to: string): string => `${to}.part`

function safePath(path: string): void {
  let current = resolve(path)
  let leaf = true
  for (;;) {
    try {
      const entry = lstatSync(current)
      // macOS exposes its system temp directories through these fixed root aliases. They
      // are not managed model directories. Only accept the exact canonical system target;
      // all other symlinks, including links beneath these aliases, are rejected.
      const systemTarget = !leaf && process.platform === 'darwin' && (current === '/var' || current === '/tmp') ? `/private${current}` : undefined
      const systemAlias = entry.isSymbolicLink() && systemTarget !== undefined && resolve(dirname(current), readlinkSync(current)) === systemTarget && realpathSync(systemTarget) === systemTarget
      if ((!systemAlias && entry.isSymbolicLink()) || (leaf && !entry.isFile()) || (!leaf && !systemAlias && !entry.isDirectory())) {
        throw new DownloadError('disk', 'The download path must use regular files and directories, without symbolic links.')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
    leaf = false
  }
}

function safeDestination(to: string): void { safePath(to); safePath(part(to)) }
const noFollow = constants.O_NOFOLLOW ?? 0

const size = (path: string): number => {
  safePath(path)
  try {
    return lstatSync(path).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

/**
 * What is already on disk for this download, if anything: the finished file, and how much of
 * a half-finished one. Either may be `0`.
 */
export function partial(to: string): { done: number; part: number } {
  return { done: size(to), part: size(part(to)) }
}

/** Give up on a half-finished download. Only ever called because somebody asked. */
export function discard(to: string): void {
  safeDestination(to)
  rmSync(part(to), { force: true })
}

/** Stream a file through sha256 — never read in whole, it may be fifty gigabytes. */
export async function sha256Of(path: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw aborted()
  safePath(path)
  const hash = createHash('sha256')
  await pipeline(createReadStream(path, { fd: openSync(path, constants.O_RDONLY | noFollow), autoClose: true }), hash, { signal })
  return hash.digest('hex')
}

/** Hash the resumed prefix using the same cancellation signal as the request and writer. */
async function hashExisting(hash: Hash, path: string, bytes: number, signal: AbortSignal, touch: () => void): Promise<void> {
  if (signal.aborted) throw signal.reason
  safePath(path)
  if (bytes === 0) return
  for await (const chunk of createReadStream(path, { end: bytes - 1, signal, fd: openSync(path, constants.O_RDONLY | noFollow), autoClose: true })) {
    if (signal.aborted) throw signal.reason
    hash.update(chunk as Buffer)
    touch()
  }
}

/**
 * Is there room? Asked before a byte is fetched, because running out at 90% is the worst
 * version of this: an hour gone and a disk that is now full.
 *
 * A filesystem that will not say how much is free (some network mounts) is let through —
 * not knowing is not a reason to refuse.
 */
async function room(to: string, need: number, minFree: number): Promise<void> {
  const stats = await statfs(dirname(to)).catch(() => undefined)
  if (stats === undefined) return
  const free = Number(stats.bavail) * Number(stats.bsize)
  if (need + minFree > free) {
    throw new DownloadError(
      'disk',
      minFree > 0
        ? `There is not enough free space: this needs ${gb(need)} and keeps ${gb(minFree)} spare, and the disk has ${gb(free)} free.`
        : `There is not enough free space: this needs ${gb(need)} and the disk has ${gb(free)} free.`,
    )
  }
}

/**
 * Four times a second at most. A progress event per 64 KB chunk of five gigabytes is eighty
 * thousand messages nobody reads and a bar that cannot keep up.
 */
const TICK_MS = 250

function reporter(total: () => number, onProgress?: (p: DownloadProgress) => void) {
  let told = 0
  let toldBytes = 0
  let rate: number | undefined
  return {
    start(done: number) {
      told = Date.now()
      toldBytes = done
    },
    tick(done: number, force = false) {
      if (onProgress === undefined) return
      const now = Date.now()
      const dt = now - told
      if (!force && dt < TICK_MS) return
      if (dt > 0) {
        const instant = ((done - toldBytes) * 1000) / dt
        // An exponential average: quick enough to notice the Wi-Fi dropping, slow enough
        // that one late packet does not halve the estimate.
        rate = rate === undefined ? instant : rate * 0.7 + instant * 0.3
      }
      told = now
      toldBytes = done
      onProgress({ done, total: total(), ...(rate === undefined ? {} : { bytesPerSecond: rate }) })
    },
  }
}

const isAbort = (error: unknown, signal?: AbortSignal): boolean =>
  signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')

const aborted = (): DownloadError =>
  new DownloadError('aborted', 'The download was stopped. What arrived is kept, and it will carry on from there next time.')

const unsigned = (value: string): number | undefined => {
  if (!/^\d+$/.test(value)) return undefined
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : undefined
}

function validate(options: DownloadOptions): void {
  for (const [name, value] of [['bytes', options.bytes], ['minFreeBytes', options.minFreeBytes]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new DownloadError('length', `Invalid ${name}.`)
  }
  if (options.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(options.sha256)) throw new DownloadError('hash', 'Invalid SHA-256 checksum.')
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647)) {
    throw new DownloadError('timeout', 'Invalid download timeout.')
  }
}

// A race is necessary as well as an AbortSignal: injected fetches and stalled streams may
// ignore abort. Keep cleanup bounded too; a stream's cancel callback can itself never settle.
function watchdog(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = (error: DownloadError) => {
    if (controller.signal.aborted) return
    controller.abort(error)
  }
  const abort = () => stop(aborted())
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  return {
    signal: controller.signal,
    touch() {
      clearTimeout(timer)
      if (!controller.signal.aborted) timer = setTimeout(() => stop(new DownloadError('timeout', 'The download stopped responding. Try again to resume it.')), timeoutMs)
    },
    async wait<T>(work: Promise<T>): Promise<T> {
      if (controller.signal.aborted) {
        void work.catch(() => {})
        throw controller.signal.reason
      }
      // Remove each listener after its I/O finishes. Racing every chunk against one pending
      // promise would retain a promise reaction per chunk for an entire multi-GB download.
      return new Promise<T>((resolve, reject) => {
        const fail = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', fail, { once: true })
        work.then((value) => {
          controller.signal.removeEventListener('abort', fail)
          resolve(value)
        }, (error) => {
          controller.signal.removeEventListener('abort', fail)
          reject(error)
        })
      })
    },
    pause() { clearTimeout(timer) },
    close() { clearTimeout(timer); signal?.removeEventListener('abort', abort) },
  }
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {})
}

async function verify(path: string, want: string | undefined, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw aborted()
  if (want !== undefined && await sha256Of(path, signal) !== want.toLowerCase()) {
    safePath(path)
    rmSync(path, { force: true })
    throw new DownloadError('hash', 'The file checksum does not match, so the damaged file was removed. Try again.')
  }
  if (signal?.aborted) throw aborted()
}

/** Resume only validated byte ranges; verify even previously installed files before reuse. */
export async function download(url: string, to: string, options: DownloadOptions = {}): Promise<void> {
  validate(options)
  const { bytes, sha256, signal, minFreeBytes = 0, onProgress, timeoutMs = 30_000 } = options
  const get = options.fetch ?? fetch
  if (signal?.aborted) throw aborted()
  const watch = watchdog(signal, timeoutMs)
  let response: Response | undefined
  let oversized = false
  try {
    safeDestination(to)
    if (existsSync(to)) {
      const done = size(to)
      if (bytes === undefined || done === bytes) {
        await verify(to, sha256, watch.signal)
        onProgress?.({ done, total: bytes ?? done })
        return
      }
      rmSync(to, { force: true })
    }
    mkdirSync(dirname(to), { recursive: true })
    safeDestination(to)
    let from = size(part(to))
    if (bytes !== undefined && from > bytes) { discard(to); from = 0 }
    if (bytes !== undefined && from === bytes && existsSync(part(to))) {
      await verify(part(to), sha256, watch.signal)
      safeDestination(to)
      renameSync(part(to), to)
      onProgress?.({ done: from, total: bytes })
      return
    }
    watch.touch()
    await watch.wait(room(to, Math.max(0, (bytes ?? 0) - from), minFreeBytes))

    let total: number | undefined = bytes
    let got = from
    const progress = reporter(() => total ?? 0, onProgress)
    let restarted = false
    let hash = sha256 === undefined ? undefined : createHash('sha256')
    let hashed = 0
    // Some servers cap an open-ended range. Accept a valid segment and ask for the rest.
    for (;;) {
      const headers = new Headers(options.headers)
      headers.set('accept-encoding', 'identity')
      headers.delete('range')
      if (from > 0) headers.set('range', `bytes=${from}-`)
      watch.touch()
      const pending = get(url, { signal: watch.signal, headers })
      void pending.then((late) => { if (watch.signal.aborted) cancelBody(late) }, () => {})
      response = await watch.wait(pending)
      if (response.status === 416 && from > 0) {
        const match = /^bytes \*\/(\d+)$/i.exec(response.headers.get('content-range') ?? '')
        const length = match ? unsigned(match[1]!) : undefined
        cancelBody(response)
        if (length === from && (total === undefined || total === from)) { total = from; got = from; break }
        if (restarted) throw new DownloadError('http', 'The server repeatedly refused the download range.')
        discard(to)
        from = 0
        got = 0
        hash = sha256 === undefined ? undefined : createHash('sha256')
        hashed = 0
        restarted = true
        continue
      }
      if ((response.status !== 200 && response.status !== 206) || response.body === null) {
        throw new DownloadError('http', `The download failed: the server answered ${response.status} ${response.statusText}.`.trim())
      }
      const encoding = response.headers.get('content-encoding')
      if (encoding !== null && encoding.toLowerCase() !== 'identity') throw new DownloadError('http', 'The server compressed a byte-range download.')
      const rawLength = response.headers.get('content-length')
      const length = rawLength === null ? undefined : unsigned(rawLength)
      if (rawLength !== null && length === undefined) throw new DownloadError('length', 'The server sent an invalid content length.')
      let end: number | undefined
      if (response.status === 206) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') ?? '')
        const start = match ? unsigned(match[1]!) : undefined
        end = match ? unsigned(match[2]!) : undefined
        const whole = match ? unsigned(match[3]!) : undefined
        if (start !== from || end === undefined || whole === undefined || end < from || end >= whole ||
            (total !== undefined && whole !== total) || (length !== undefined && length !== end - from + 1)) {
          throw new DownloadError('length', 'The server sent an invalid or mismatched content range; the partial file was kept.')
        }
        total = whole
      } else {
        if (response.headers.has('content-range')) throw new DownloadError('length', 'The server sent a range without a partial response.')
        // An ignored Range is a full replacement, never an append. Recheck room for all of it.
        from = 0
        hash = sha256 === undefined ? undefined : createHash('sha256')
        hashed = 0
        if (length !== undefined && total !== undefined && length !== total) throw new DownloadError('length', 'The server file size does not match the expected size.')
        total ??= length
      }
      await watch.wait(room(to, (total ?? 0) - from, minFreeBytes))
      if (hash !== undefined && hashed < from) {
        await hashExisting(hash, part(to), from, watch.signal, () => watch.touch())
        hashed = from
      }
      got = from
      progress.start(got)
      progress.tick(got, true)
      if (watch.signal.aborted) throw watch.signal.reason
      safeDestination(to)
      const flags = constants.O_WRONLY | constants.O_CREAT | noFollow | (from > 0 ? constants.O_APPEND : constants.O_TRUNC)
      const writer = createWriteStream(part(to), { fd: openSync(part(to), flags), autoClose: true })
      const reader = response.body.getReader()
      let sinceDiskCheck = 0
      const expectedEnd = end === undefined ? total : end + 1
      const stream = async function* () {
        try {
          for (;;) {
            watch.touch()
            const next = await watch.wait(reader.read())
            if (next.done) break
            if (expectedEnd !== undefined && got + next.value.length > expectedEnd) {
              oversized = true
              throw new DownloadError('length', 'The download was larger than promised, so the partial file was removed.')
            }
            sinceDiskCheck += next.value.length
            if (total === undefined || sinceDiskCheck >= 16 * 1024 * 1024) {
              await watch.wait(room(to, total === undefined ? next.value.length : total - got, minFreeBytes))
              sinceDiskCheck = 0
            }
            got += next.value.length
            hash?.update(next.value)
            hashed = got
            if (got !== total) progress.tick(got)
            yield next.value
          }
        } finally {
          void reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      }
      await pipeline(stream(), writer, { signal: watch.signal })
      if (expectedEnd !== undefined && got !== expectedEnd) throw new DownloadError('length', 'The download ended early. Try again to resume it.')
      if (end !== undefined && total !== undefined && got < total) { from = got; continue }
      break
    }
    watch.pause()
    if (hash !== undefined && hashed === got) {
      if (hash.digest('hex') !== sha256!.toLowerCase()) {
        discard(to)
        throw new DownloadError('hash', 'The download checksum does not match, so the damaged partial file was removed. Try again.')
      }
    } else {
      await verify(part(to), sha256, watch.signal)
    }
    if (watch.signal.aborted) throw watch.signal.reason
    safeDestination(to)
    renameSync(part(to), to)
    progress.tick(got, true)
  } catch (error) {
    if (oversized) discard(to)
    if (signal?.aborted) throw aborted()
    if (watch.signal.aborted) throw watch.signal.reason
    if (error instanceof DownloadError) throw error
    if (isAbort(error)) throw aborted()
    if (['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EIO', 'EROFS', 'ELOOP', 'ENOTDIR', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw new DownloadError('disk', `Could not save the download: ${String(error)}`)
    }
    throw new DownloadError('http', `The download was interrupted: ${String(error)}`)
  } finally {
    if (response?.body && !response.body.locked) cancelBody(response)
    watch.close()
  }
}

/** One file of a model that comes in several — a split GGUF, or a model and its projector. */
export interface DownloadPart {
  url: string
  to: string
  bytes?: number
  sha256?: string
}

/**
 * Several files as one download, one after another, with **one bar**: a model split into
 * three files is one thing to the person waiting for it, and a bar that fills three times
 * reads as three models.
 *
 * The room check is made for the lot up front, when every size is known — a disk that fits
 * the first two parts and not the third is the same hour lost.
 */
export async function downloadAll(parts: DownloadPart[], options: Omit<DownloadOptions, 'bytes' | 'sha256'> = {}): Promise<void> {
  const { onProgress, minFreeBytes = 0 } = options
  validate(options)
  if (options.signal?.aborted) throw aborted()
  for (const p of parts) {
    validate({ ...options, bytes: p.bytes, sha256: p.sha256 })
    safeDestination(p.to)
  }
  const sizes = parts.map((p) => p.bytes)
  const known = sizes.every((b) => b !== undefined)

  if (known && parts.length > 0) {
    const watch = watchdog(options.signal, options.timeoutMs ?? 30_000)
    try {
      // Parts on different filesystems need separate budgets. A nested directory may be a
      // mount even when all filenames live under the same managed model directory.
      const disks = new Map<number, { to: string; need: number }>()
      for (const p of parts) {
        const there = partial(p.to)
        const need = existsSync(p.to) && there.done === p.bytes ? 0 : p.bytes! - (there.part > p.bytes! ? 0 : there.part)
        mkdirSync(dirname(p.to), { recursive: true })
        safeDestination(p.to)
        const device = lstatSync(dirname(p.to)).dev
        const budget = disks.get(device) ?? { to: p.to, need: 0 }
        budget.need += need
        if (!Number.isSafeInteger(budget.need)) throw new DownloadError('length', 'The combined download size is too large.')
        disks.set(device, budget)
      }
      for (const budget of disks.values()) {
        watch.touch()
        await watch.wait(room(budget.to, budget.need, minFreeBytes))
      }
    } finally { watch.close() }
  }

  let before = 0
  for (const [i, p] of parts.entries()) {
    const sumOf = (current: number): number =>
      sizes.reduce<number>((sum, b, j) => sum + (j === i ? current || (b ?? 0) : (b ?? 0)), 0)
    await download(p.url, p.to, {
      ...options,
      ...(p.bytes === undefined ? {} : { bytes: p.bytes }),
      ...(p.sha256 === undefined ? {} : { sha256: p.sha256 }),
      // Keep the reserve on every part too: space may have changed since the aggregate check.
      minFreeBytes,
      onProgress: onProgress && ((q) => {
        if (sizes[i] === undefined && q.total > 0) sizes[i] = q.total
        onProgress({ ...q, done: before + q.done, total: sumOf(q.total) })
      }),
    })
    const finished = size(p.to)
    if (sizes[i] === undefined) sizes[i] = finished
    before += finished
  }
  onProgress?.({ done: before, total: sizes.reduce<number>((s, b) => s + (b ?? 0), 0) })
}
