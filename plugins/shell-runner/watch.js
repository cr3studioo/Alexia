// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/**
 * Watches: a process, a file, or a command `shell.run` started with `watch: true`. A finished one
 * becomes an item of this plugin's `notice.items`, "<says or the job> finished (exit N)", urgency
 * `normal`, and stays there for a day.
 *
 * Nothing here runs a command. Polling is driven by {@link createWatches}' `poll()`, which the
 * plugin calls on a timer and a test calls with its own clock.
 */

/** A file that has not grown for this long is finished. */
export const QUIET_MS = 60_000
/** How long a finished watch stays a notice. */
export const KEEP_MS = 24 * 60 * 60 * 1000
/** How often the plugin polls. */
export const POLL_MS = 5_000
/** At most this many watches at once. */
export const MOST_WATCHES = 50
/** A line longer than this is matched on its first part only. */
const MOST_LINE = 4096
/** At most this much new file is read per poll; the rest is read on the next ones. */
export const MOST_READ = 1024 * 1024

const KEY_PREFIX = 'shell-runner:'

/** Is `pid` still running? `process.kill(pid, 0)` checks without sending anything. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, it is just not ours.
    return error?.code === 'EPERM'
  }
}

/** Read the bytes of `path` from `from` up to `to`. */
async function readFrom(path, from, to) {
  const handle = await open(path, 'r')
  try {
    const length = Math.max(0, to - from)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, from)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * @param {object} [deps]
 * @param {() => number} [deps.now]                       the clock, in epoch milliseconds
 * @param {(pid: number) => boolean} [deps.isAlive]       whether a process is running
 * @param {(path: string) => Promise<{size:number}>} [deps.statFile]
 * @param {(path: string, from: number, to: number) => Promise<Buffer>} [deps.readFile]  bytes from..to
 * @param {() => string} [deps.newId]
 */
export function createWatches(deps = {}) {
  const now = deps.now ?? Date.now
  const isAlive = deps.isAlive ?? pidAlive
  const statFile = deps.statFile ?? stat
  const readFile = deps.readFile ?? readFrom
  const newId = deps.newId ?? (() => `w_${randomBytes(6).toString('hex')}`)

  /** id -> a running watch */
  const running = new Map()
  /** finished watches, as notices */
  let finished = []

  function room() {
    if (running.size >= MOST_WATCHES) throw new Error(`At most ${MOST_WATCHES} jobs can be watched at once.`)
  }

  function finish(id, name, exit) {
    const watch = running.get(id)
    if (!watch) return
    running.delete(id)
    watch.stop?.()
    const said = watch.says ?? name
    const text = exit === undefined || exit === null ? `${said} finished` : `${said} finished (exit ${exit})`
    finished.push({ key: `${KEY_PREFIX}${id}`, text, why: 'A job you asked me to watch has finished.', urgency: 'normal', at: now() })
  }

  /** Watch a process that is already running. */
  function pid(value, { says } = {}) {
    if (!Number.isInteger(value) || value <= 0) throw new Error('pid must be a positive whole number.')
    if (!isAlive(value)) throw new Error(`No process ${value} is running.`)
    room()
    const id = newId()
    running.set(id, { kind: 'pid', pid: value, says })
    return id
  }

  /**
   * Watch a file: finished when it has not grown for {@link QUIET_MS}, or when a line matches
   * `doneWhen` (a regular expression, matched on lines written after the watch began).
   */
  async function file(path, { says, doneWhen } = {}) {
    let pattern
    if (doneWhen !== undefined && doneWhen !== null && doneWhen !== '') {
      try {
        pattern = new RegExp(String(doneWhen))
      } catch {
        throw new Error('done_when is not a valid regular expression.')
      }
    }
    let size
    try {
      size = (await statFile(path)).size
    } catch {
      throw new Error('That file is not there.')
    }
    room()
    const id = newId()
    // size: the file's size when last looked at; read: how far it has been read for done_when.
    running.set(id, { kind: 'file', path, says, pattern, size, read: size, grewAt: now(), rest: '', decoder: new StringDecoder('utf8') })
    return id
  }

  /**
   * Watch a command already started by `shell.run` (`{ done }` from `startProcess`). Its output
   * is not kept beyond what `startProcess` holds, and never shown.
   */
  function command(child, { says, label } = {}) {
    room()
    const id = newId()
    running.set(id, { kind: 'command', says, child, stop: undefined })
    void child.done.then((result) => {
      const exit = result.exit ?? (result.error ? 'could not start' : 'killed')
      finish(id, label || 'The command', exit)
    })
    return id
  }

  /** Stop watching. A command being watched is stopped too, with everything it started. */
  async function unwatch(id) {
    const watch = running.get(id)
    if (watch) {
      running.delete(id)
      if (watch.kind === 'command') await watch.child.kill?.()
      return true
    }
    const before = finished.length
    finished = finished.filter((n) => n.key !== `${KEY_PREFIX}${id}`)
    return finished.length < before
  }

  /** Look at every pid and file watch once. */
  async function poll() {
    const t = now()
    for (const [id, watch] of [...running]) {
      if (watch.kind === 'pid') {
        if (!isAlive(watch.pid)) finish(id, `Process ${watch.pid}`, undefined)
        continue
      }
      if (watch.kind !== 'file') continue
      let size
      try {
        size = (await statFile(watch.path)).size
      } catch {
        finish(id, basename(watch.path), undefined)
        continue
      }
      if (size < watch.size || size < watch.read) {
        // Truncated or replaced: start again from its new end.
        watch.size = size
        watch.read = size
        watch.grewAt = t
        watch.rest = ''
        watch.decoder = new StringDecoder('utf8')
        continue
      }
      const grew = size > watch.size
      if (grew) {
        watch.size = size
        watch.grewAt = t
      }
      if (watch.pattern && watch.read < size) {
        // At most MOST_READ now; the position moves only past what was read, so a line further on
        // is reached on a later poll.
        let bytes
        try {
          bytes = await readFile(watch.path, watch.read, Math.min(size, watch.read + MOST_READ))
        } catch {
          bytes = Buffer.alloc(0)
        }
        watch.read += bytes.length
        const lines = (watch.rest + watch.decoder.write(bytes)).split(/\r?\n/)
        watch.rest = lines.pop().slice(-MOST_LINE)
        if ([...lines, watch.rest].some((line) => watch.pattern.test(line.slice(0, MOST_LINE)))) {
          finish(id, basename(watch.path), undefined)
          continue
        }
      }
      if (!grew && t - watch.grewAt >= QUIET_MS) finish(id, basename(watch.path), undefined)
    }
  }

  /** The finished watches of the last day, in the `notice.items` shape. */
  function noticeItems() {
    const t = now()
    finished = finished.filter((n) => t - n.at < KEEP_MS)
    return finished.map(({ key, text, why, urgency }) => ({ key, text, why, urgency }))
  }

  /** What is being watched, without paths or commands' output. */
  function list() {
    return [...running].map(([id, w]) => ({ watch: id, kind: w.kind, ...(w.pid && { pid: w.pid }), ...(w.says && { says: w.says }) }))
  }

  return { pid, file, command, unwatch, poll, noticeItems, list, get size() {
    return running.size
  } }
}
