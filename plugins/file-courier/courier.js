// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The file courier's logic, apart from the wire: it hands a file out in pieces of at most 1 MiB
 * and takes one in, checking SHA-256 at the end.
 *
 * Everything it touches is passed in (`roots`, `downloads`, `ledger`), so a test can point it at a
 * temporary folder. Reading is limited to the folders the owner allowed. Writing lands in
 * Downloads or in an allowed folder, goes to `<name>.part` until the last piece, and never
 * overwrites: an existing name becomes `name (2).ext`, `name (3).ext`, ...
 */

export const MOST_CHUNK = 1048576
export const STALE_PART_MS = 60 * 60 * 1000
export const DAMAGED = 'The file arrived damaged; nothing was kept.'

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
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Strict base64: the whole string, canonical padding. Returns a Buffer or null. */
function fromBase64(text) {
  if (typeof text !== 'string' || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null
  return Buffer.from(text, 'base64')
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0

/** A plain file name: no folder parts, nothing the system treats specially. */
function cleanName(name) {
  if (typeof name !== 'string') throw refuse('A file needs a name.')
  const trimmed = name.trim()
  // eslint-disable-next-line no-control-regex
  const bad = /[\\/:*?"<>|\u0000-\u001f]/
  if (trimmed === '' || trimmed.length > 200 || bad.test(trimmed) || /^\.+$/.test(trimmed) || /[. ]$/.test(trimmed)) {
    throw refuse('That is not a name a file can have here. Use a plain file name, without folders.')
  }
  return trimmed
}

async function sha256Of(path) {
  const hash = createHash('sha256')
  for await (const piece of createReadStream(path)) hash.update(piece)
  return hash.digest('hex')
}

const exists = (path) =>
  stat(path).then(
    () => true,
    (error) => {
      if (error?.code === 'ENOENT') return false
      throw error
    },
  )

/**
 * @param {object} deps
 * @param {() => Promise<unknown[]>} deps.roots   the owner's roots (`roots/list`), asked each time
 * @param {() => string} deps.downloads           the device's Downloads folder
 * @param {{ get(): Promise<string[]>, set(paths: string[]): Promise<void> }} deps.ledger
 *        the `.part` files this courier made, so cleaning never touches anyone else's
 * @param {() => number} [deps.now]
 */
export function createCourier(deps) {
  const now = deps.now ?? Date.now

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
    if (!roots.some((root) => inside(realProbe, root))) {
      throw refuse('That folder is outside the folders opened on this computer.')
    }
    await mkdir(resolve(folder), { recursive: true })
    const real = await realpath(resolve(folder))
    if (!roots.some((root) => inside(real, root))) {
      throw refuse('That folder is outside the folders opened on this computer.')
    }
    return real
  }

  async function forget(part) {
    const list = await deps.ledger.get().catch(() => [])
    if (list.includes(part)) await deps.ledger.set(list.filter((one) => one !== part)).catch(() => {})
  }
  async function remember(part) {
    const list = await deps.ledger.get().catch(() => [])
    if (!list.includes(part)) await deps.ledger.set([...list, part]).catch(() => {})
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

    async writeChunk({ name, folder, offset, data, last, sha256 }) {
      const clean = cleanName(name)
      if (!isCount(offset)) throw refuse('The offset must be a whole number, 0 or more.')
      if (typeof last !== 'boolean') throw refuse('Say whether this is the last piece.')
      if (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha256))) {
        throw refuse('The checksum must be 64 hexadecimal characters.')
      }
      const bytes = fromBase64(data)
      if (!bytes) throw refuse('The piece is not valid base64.')
      if (bytes.length > MOST_CHUNK) throw refuse('A piece can be at most 1 MiB (1048576 bytes). Send smaller pieces.')

      const dir = await writableFolder(folder)
      const part = join(dir, `${clean}.part`)

      if (offset === 0) {
        await remember(part)
        const handle = await open(part, 'w')
        try {
          await handle.write(bytes, 0, bytes.length, 0)
        } finally {
          await handle.close()
        }
      } else {
        const have = await stat(part).then((info) => info.size, () => -1)
        if (have !== offset) {
          throw refuse(
            have < 0
              ? 'No earlier piece of this file arrived here; start again from the first piece.'
              : `This piece does not follow on from what arrived (${String(have)} bytes, not ${String(offset)}). Start again from the first piece.`,
          )
        }
        const handle = await open(part, 'r+')
        try {
          await handle.write(bytes, 0, bytes.length, offset)
        } finally {
          await handle.close()
        }
      }

      if (!last) return { path: part, done: false }

      if (sha256 !== undefined && (await sha256Of(part)) !== sha256.toLowerCase()) {
        await unlink(part).catch(() => {})
        await forget(part)
        throw refuse(DAMAGED)
      }
      const final = await place(part, dir, clean)
      await forget(part)
      return { path: final, done: true }
    },

    /** Delete the `.part` files this courier left more than an hour ago. Returns how many went. */
    async cleanStale() {
      const list = await deps.ledger.get().catch(() => [])
      const keep = []
      let gone = 0
      for (const part of list) {
        const info = await stat(part).catch(() => null)
        if (!info) continue
        if (now() - info.mtimeMs > STALE_PART_MS) {
          const removed = await unlink(part).then(
            () => true,
            () => false,
          )
          if (removed) gone += 1
          else keep.push(part)
        } else keep.push(part)
      }
      await deps.ledger.set(keep).catch(() => {})
      return gone
    },
  }
}

/** Move the finished part to a name nobody has, `name`, `name (2)`, `name (3)`... Never overwrites. */
async function place(part, dir, name) {
  const { name: stem, ext } = parse(name)
  for (let n = 1; n < 10000; n += 1) {
    const target = join(dir, n === 1 ? name : `${stem} (${String(n)})${ext}`)
    try {
      // A hard link refuses to replace anything, so two arrivals cannot both take one name.
      await link(part, target)
      await unlink(part)
      return target
    } catch (error) {
      if (error?.code === 'EEXIST') continue
      if (error?.code === 'EPERM' || error?.code === 'ENOTSUP' || error?.code === 'EXDEV' || error?.code === 'EACCES') {
        // A drive that cannot make links: check, then rename.
        if (await exists(target)) continue
        await rename(part, target)
        return target
      }
      throw error
    }
  }
  throw refuse('There are too many files with that name here.')
}
