// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { link, lstat, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The file courier's logic, apart from the wire: it hands a file out in pieces of at most 1 MiB
 * and takes one in, checking SHA-256 at the end.
 *
 * Everything it touches is passed in (`roots`, `downloads`, `ledger`), so a test can point it at a
 * temporary folder. Reading is limited to the folders the owner allowed. Writing lands in
 * Downloads or in an allowed folder and never overwrites: an existing name becomes
 * `name (2).ext`, `name (3).ext`, ...
 *
 * Until the last piece, each transfer has a part file of its own, `<name>.<random>.alexia-part`,
 * made with the exclusive flag, so it is never a file that was already there. The ledger records it
 * with its file identity, and every later write checks that the path still holds that very file:
 * not a link, not a second name for another file, not a replacement.
 */

export const MOST_CHUNK = 1048576
export const STALE_PART_MS = 60 * 60 * 1000
export const PART_SUFFIX = '.alexia-part'
export const DAMAGED = 'The file arrived damaged; nothing was kept.'

const NOT_HERE = 'No earlier piece of this file arrived here; start again from the first piece.'
const SWAPPED =
  'The unfinished file on this computer was replaced by something else, so I left it alone. Start again from the first piece.'
const OUTSIDE_FOLDER = 'That folder is outside the folders opened on this computer.'

/** A refusal that carries a sentence the owner can read. */
export class Refused extends Error {}
const refuse = (text) => new Refused(text)

/** Root URIs (`file://...`) or plain paths, as plain absolute paths. Anything else is dropped. */
export function rootPaths(roots) {
  const out = []
  for (const root of Array.isArray(roots) ? roots : []) {
    const raw = typeof root === 'string' ? root : root?.uri
    if (typeof raw !== 'string' || raw === '') continue
    try {
      out.push(raw.startsWith('file:') ? fileURLToPath(raw) : raw)
    } catch {
      // A URI that is not a path on this machine is not a place a file can be inside.
    }
  }
  return out.filter((one) => isAbsolute(one))
}

const fold = (path) => (process.platform === 'win32' ? path.toLowerCase() : path)

/** Is `path` the folder `root` or somewhere inside it? Both already resolved. */
function inside(path, root) {
  const rel = relative(fold(root), fold(path))
  // Only a whole `..` step leaves the folder; a child may well be called `..cache`.
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Strict base64: the whole string, canonical padding. Returns a Buffer or null. */
function fromBase64(text) {
  if (typeof text !== 'string' || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null
  return Buffer.from(text, 'base64')
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0

/** Names Windows keeps for devices, with or without an extension: `CON`, `nul.txt`, `COM1.tar.gz`. */
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[0-9¹²³]) *(\..*)?$/i

/** A plain file name: no folder parts, nothing the system treats specially. */
function cleanName(name) {
  if (typeof name !== 'string') throw refuse('A file needs a name.')
  const trimmed = name.trim()
  // eslint-disable-next-line no-control-regex
  const bad = /[\\/:*?"<>|\u0000-\u001f]/
  if (trimmed === '' || trimmed.length > 200 || bad.test(trimmed) || /^\.+$/.test(trimmed) || /[. ]$/.test(trimmed)) {
    throw refuse('That is not a name a file can have here. Use a plain file name, without folders.')
  }
  if (RESERVED.test(trimmed)) {
    throw refuse(`Windows keeps the name "${trimmed}" for itself, so a file cannot be called that. Use another name.`)
  }
  return trimmed
}

/** The part file name of one transfer. The name is cut short so the whole still fits a disk's limit. */
function partName(name, id) {
  let stem = ''
  for (const char of name) {
    if (Buffer.byteLength(stem + char) > 150) break
    stem += char
  }
  return `${stem}.${id}${PART_SUFFIX}`
}

async function sha256Of(path) {
  const hash = createHash('sha256')
  for await (const piece of createReadStream(path)) hash.update(piece)
  return hash.digest('hex')
}

/** The same, through a handle already checked, so no path is followed a second time. */
async function sha256OfHandle(handle) {
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(MOST_CHUNK)
  let at = 0
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, at)
    if (bytesRead === 0) return hash.digest('hex')
    hash.update(buffer.subarray(0, bytesRead))
    at += bytesRead
  }
}

async function writeAll(handle, bytes, position) {
  let done = 0
  while (done < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, done, bytes.length - done, position + done)
    done += bytesWritten
  }
}

const exists = (path) =>
  stat(path).then(
    () => true,
    (error) => {
      if (error?.code === 'ENOENT') return false
      throw error
    },
  )

/** What is at `path` itself (a link is not followed), or null when nothing is there. */
const look = (path) =>
  lstat(path, { bigint: true }).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })

/** Is this the very file the transfer made? A link, a folder or another file is not. */
const isOurs = (info, record) => info.isFile() && String(info.ino) === record.ino

/** Run the jobs given under one key one after another; different keys do not wait for each other. */
function queues() {
  const tails = new Map()
  return (key, job) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(job)
    const tail = run.then(
      () => {},
      () => {},
    )
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return run
  }
}

/** The queue that the pieces of one name in one folder wait in. */
const fileKey = (dir, name) => `file ${fold(join(dir, name))}`

/**
 * @typedef {{ id: string, dir: string, name: string, part: string, ino: string }} Transfer
 *
 * @param {object} deps
 * @param {() => Promise<unknown[]>} deps.roots   the owner's roots (`roots/list`), asked each time
 * @param {() => string} deps.downloads           the device's Downloads folder
 * @param {{ get(): Promise<Transfer[]>, set(transfers: Transfer[]): Promise<void> }} deps.ledger
 *        the unfinished transfers, so cleaning never touches a file this courier did not make
 * @param {() => number} [deps.now]
 */
export function createCourier(deps) {
  const now = deps.now ?? Date.now
  const inTurn = queues()

  async function rootsNow() {
    const listed = await Promise.resolve(deps.roots()).catch(() => [])
    const real = []
    for (const root of rootPaths(listed)) real.push(await realpath(root).catch(() => resolve(root)))
    return real
  }

  /** The real path of a file inside the owner's roots, or a refusal. */
  async function readable(path) {
    if (typeof path !== 'string' || path.trim() === '' || !isAbsolute(path)) {
      throw refuse('I need the full path of the file.')
    }
    const roots = await rootsNow()
    if (roots.length === 0) throw refuse('No folder has been opened on this computer, so I cannot read files from it.')
    let real
    try {
      real = await realpath(resolve(path))
    } catch {
      throw refuse('That file is not there, or it is outside the folders opened on this computer.')
    }
    if (!roots.some((root) => inside(real, root))) {
      throw refuse('That file is outside the folders opened on this computer.')
    }
    const info = await stat(real)
    if (!info.isFile()) throw refuse('That is not a file.')
    return { real, size: info.size }
  }

  /** The real folder a file may be written to: Downloads, or inside the owner's roots. */
  async function writableFolder(folder) {
    if (folder === undefined || folder === null || folder === '') {
      const dir = deps.downloads()
      await mkdir(dir, { recursive: true })
      return realpath(dir)
    }
    if (typeof folder !== 'string' || !isAbsolute(folder)) throw refuse('I need the full path of the folder.')
    const roots = await rootsNow()
    if (roots.length === 0) throw refuse('No folder has been opened on this computer, so I cannot write files into it.')
    // The nearest folder that exists decides, so a link in the way cannot lead out of the roots.
    let probe = resolve(folder)
    while (!(await exists(probe))) {
      const up = dirname(probe)
      if (up === probe) break
      probe = up
    }
    const realProbe = await realpath(probe).catch(() => probe)
    if (!roots.some((root) => inside(realProbe, root))) throw refuse(OUTSIDE_FOLDER)
    await mkdir(resolve(folder), { recursive: true })
    const real = await realpath(resolve(folder))
    if (!roots.some((root) => inside(real, root))) throw refuse(OUTSIDE_FOLDER)
    return real
  }

  const unfinished = async () => (await deps.ledger.get()) ?? []
  /** Change the ledger, one change at a time, so transfers side by side keep each other's entries. */
  const change = (edit) => inTurn('ledger', async () => deps.ledger.set(edit(await unfinished())))
  const remember = (record) => change((list) => [...list, record])
  const forget = (record) => change((list) => list.filter((one) => one.id !== record.id)).catch(() => {})

  /** Make the empty part file of a new transfer and record it. */
  async function begin(dir, name) {
    const id = randomBytes(12).toString('hex')
    const part = join(dir, partName(name, id))
    // 'wx' fails when anything is at the path already, a link included, so this file is ours.
    const handle = await open(part, 'wx')
    let info
    try {
      info = await handle.stat({ bigint: true })
    } finally {
      await handle.close()
    }
    const record = { id, dir, name, part, ino: String(info.ino) }
    try {
      await remember(record)
    } catch (error) {
      await unlink(part).catch(() => {})
      throw error
    }
    return record
  }

  /** The transfer a later piece belongs to: the one it names, or the only one it can follow on from. */
  async function earlier(dir, name, transfer, offset) {
    const same = (await unfinished()).filter((one) => fold(one.dir) === fold(dir) && one.name === name)
    if (transfer !== undefined) {
      const named = same.find((one) => one.id === transfer)
      if (!named) throw refuse(NOT_HERE)
      return named
    }
    if (same.length === 0) throw refuse(NOT_HERE)
    if (same.length === 1) return same[0]
    const fitting = []
    for (const one of same) {
      const info = await look(one.part)
      if (info && info.size === BigInt(offset)) fitting.push(one)
    }
    if (fitting.length === 1) return fitting[0]
    throw refuse(
      'I cannot tell which of the files of this name arriving here this piece belongs to. ' +
        'Send the transfer id that came back with the first piece.',
    )
  }

  /** Refuse unless the part path still holds the transfer's own file, and nothing standing in for it. */
  async function checkPart(record, info) {
    // A second name (hard link) would carry the writing to wherever else that file is.
    if (info && isOurs(info, record) && info.nlink === 1n) return
    await forget(record)
    throw refuse(info ? SWAPPED : NOT_HERE)
  }

  /** Open the part file for writing, checked both before and after opening. */
  async function openPart(record) {
    await checkPart(record, await look(record.part))
    const handle = await open(record.part, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await handle.stat({ bigint: true })
      await checkPart(record, info)
      return { handle, size: Number(info.size) }
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  /** Take in one piece. Runs in turn with every other piece for the same name in the same folder. */
  async function take({ dir, folder, name, transfer, offset, bytes, last, sha256 }) {
    const first = transfer === undefined && offset === 0
    const record = first ? await begin(dir, name) : await earlier(dir, name, transfer, offset)
    const { handle, size } = await openPart(record)
    let damaged = false
    try {
      if (size !== offset) {
        throw refuse(
          `This piece does not follow on from what arrived (${String(size)} bytes, not ${String(offset)}). Start again from the first piece.`,
        )
      }
      await writeAll(handle, bytes, offset)
      if (last && sha256 !== undefined) damaged = (await sha256OfHandle(handle)) !== sha256.toLowerCase()
    } finally {
      await handle.close()
    }
    if (!last) return { path: record.part, transfer: record.id, done: false }

    if (damaged) {
      await unlink(record.part).catch(() => {})
      await forget(record)
      throw refuse(DAMAGED)
    }
    // Asked again just before the file gets its name: still the same folder, still allowed.
    if ((await writableFolder(folder)) !== dir) throw refuse(OUTSIDE_FOLDER)
    await checkPart(record, await look(record.part))
    const placed = await place(record.part, dir, name)
    // A part name that could not be removed stays in the ledger and is cleaned at a later start.
    if (placed.partGone) await forget(record)
    return { path: placed.path, done: true }
  }

  return {
    async stat({ path }) {
      const { real, size } = await readable(path)
      return { size, sha256: await sha256Of(real), name: basename(real) }
    },

    async readChunk({ path, offset, length }) {
      if (!isCount(offset)) throw refuse('The offset must be a whole number, 0 or more.')
      if (!Number.isSafeInteger(length) || length < 1) throw refuse('The length must be a whole number, 1 or more.')
      if (length > MOST_CHUNK) throw refuse('A piece can be at most 1 MiB (1048576 bytes). Ask for a smaller one.')
      const { real, size } = await readable(path)
      const handle = await open(real, 'r')
      try {
        const buffer = Buffer.alloc(Math.min(length, Math.max(0, size - offset)))
        const { bytesRead } = buffer.length > 0 ? await handle.read(buffer, 0, buffer.length, offset) : { bytesRead: 0 }
        return { data: buffer.subarray(0, bytesRead).toString('base64'), eof: offset + bytesRead >= size }
      } finally {
        await handle.close()
      }
    },

    /**
     * A piece at offset 0 without `transfer` starts a new transfer, whose id comes back. Later
     * pieces send it; one that does not is taken only when a single transfer can be meant.
     */
    async writeChunk({ name, folder, offset, data, last, sha256, transfer }) {
      const clean = cleanName(name)
      if (!isCount(offset)) throw refuse('The offset must be a whole number, 0 or more.')
      if (typeof last !== 'boolean') throw refuse('Say whether this is the last piece.')
      if (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha256))) {
        throw refuse('The checksum must be 64 hexadecimal characters.')
      }
      if (transfer !== undefined && typeof transfer !== 'string') throw refuse('The transfer id must be text.')
      const bytes = fromBase64(data)
      if (!bytes) throw refuse('The piece is not valid base64.')
      if (bytes.length > MOST_CHUNK) throw refuse('A piece can be at most 1 MiB (1048576 bytes). Send smaller pieces.')

      const dir = await writableFolder(folder)
      return inTurn(fileKey(dir, clean), () => take({ dir, folder, name: clean, transfer, offset, bytes, last, sha256 }))
    },

    /** Delete the part files this courier left more than an hour ago. Returns how many went. */
    async cleanStale() {
      let gone = 0
      for (const record of await unfinished()) {
        await inTurn(fileKey(record.dir, record.name), async () => {
          const info = await look(record.part)
          // Nothing there, or something that is not our file: drop the entry and touch nothing.
          if (!info || !isOurs(info, record)) return forget(record)
          if (now() - Number(info.mtimeMs) <= STALE_PART_MS) return
          await unlink(record.part)
          gone += 1
          await forget(record)
          // A part that cannot be looked at or removed stays listed for the next start.
        }).catch(() => {})
      }
      return gone
    },
  }
}

/**
 * Give the finished part a name nobody has: `name`, `name (2)`, `name (3)`... Never overwrites.
 * Resolves to `{ path, partGone }`.
 */
async function place(part, dir, name) {
  const { name: stem, ext } = parse(name)
  for (let n = 1; n < 10000; n += 1) {
    const target = join(dir, n === 1 ? name : `${stem} (${String(n)})${ext}`)
    try {
      // A hard link refuses to replace anything, so two arrivals cannot both take one name.
      await link(part, target)
    } catch (error) {
      if (error?.code === 'EEXIST') continue
      if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EACCES'].includes(error?.code)) throw error
      // A drive that cannot make links.
      if (await renameOnto(part, target)) return { path: target, partGone: true }
      continue
    }
    const partGone = await unlink(part).then(
      () => true,
      () => false,
    )
    return { path: target, partGone }
  }
  throw refuse('There are too many files with that name here.')
}

/**
 * Take `target` by creating it empty (which fails when anything is there), then move the part over
 * that placeholder. False when the name was already taken.
 */
async function renameOnto(part, target) {
  try {
    await (await open(target, 'wx')).close()
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
  try {
    await rename(part, target)
  } catch (error) {
    await unlink(target).catch(() => {})
    throw error
  }
  return true
}
