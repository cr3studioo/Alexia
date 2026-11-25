// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Finding what to read — and what *not* to, which is most of it.
 *
 * Pure over an injected file system (`readdir`, `stat`, `readFile`), so it is tested with a fake
 * one and never needs a disk. It only ever lists and reads: nothing here has a way to write.
 */

const TEXT = new Set(['.txt', '.text', '.org', '.rst'])
const MARKDOWN = new Set(['.md', '.markdown'])
const EXTRACT = new Set(['.pdf', '.docx', '.odt', '.rtf', '.epub', '.pptx'])

/** A file this big is not a note. It is left alone, and counted. */
export const MOST_BYTES = 25 * 1024 * 1024
/** More files than this in the chosen folders is a mistake (a home folder): the walk stops. */
export const MOST_FILES = 20000

/** `'markdown'`, `'text'`, `'extract'` (needs `document.extract`) or `undefined` (not ours). */
export function kindOf(name) {
  const ext = extname(String(name)).toLowerCase()
  if (MARKDOWN.has(ext)) return 'markdown'
  if (TEXT.has(ext)) return 'text'
  if (EXTRACT.has(ext)) return 'extract'
  return undefined
}

const fold = (path) => (process.platform === 'win32' ? path.toLowerCase() : path)

/** Is `path` the folder `root` or somewhere inside it? Compared after resolving `..` away. */
export function inside(path, roots) {
  if (typeof path !== 'string' || path.trim() === '' || !isAbsolute(path)) return false
  const target = fold(resolve(path))
  return roots.some((root) => {
    if (typeof root !== 'string' || !isAbsolute(root)) return false
    const rel = relative(fold(resolve(root)), target)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

/**
 * Which of the chosen folders may be read. `real` follows links, so a folder that is a link
 * leading out of the owner's roots is refused, as is one that is not absolute.
 */
export async function sortFolders(folders, roots, real = async (p) => p) {
  const allowed = []
  const refused = []
  for (const folder of folders) {
    let ok = inside(folder, roots)
    if (ok) {
      try {
        const there = await real(folder)
        ok = inside(there, await Promise.all(roots.map((root) => real(root).catch(() => root))))
      } catch {
        ok = true // does not exist yet: nothing to follow, and the walk will find it empty
      }
    }
    ;(ok ? allowed : refused).push(folder)
  }
  return { allowed, refused }
}

/**
 * Every readable file under `folder`. Dot-folders (`.obsidian`, `.git`, `.trash`) and dot-files are
 * skipped, and so are links: a link is a way out of the folder that was chosen.
 *
 * `unreadable` lists the folders that could not be listed, so the caller does not mistake "could
 * not look" for "is gone".
 */
export async function walk(fs, folder, found = { files: [], unreadable: [], tooBig: 0, truncated: false }) {
  const pending = [folder]
  while (pending.length > 0) {
    const dir = pending.pop()
    let entries
    try {
      entries = await fs.readdir(dir)
    } catch {
      found.unreadable.push(dir)
      continue
    }
    for (const entry of entries) {
      // Dot-files, and Office's `~$name.docx` lock files, are not documents.
      if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue
      const path = join(dir, entry.name)
      if (entry.type === 'dir') {
        pending.push(path)
        continue
      }
      const kind = entry.type === 'file' ? kindOf(entry.name) : undefined
      if (kind === undefined) continue
      let info
      try {
        info = await fs.stat(path)
      } catch {
        continue
      }
      if (info.size > MOST_BYTES) {
        found.tooBig += 1
        continue
      }
      if (found.files.length >= MOST_FILES) {
        found.truncated = true
        return found
      }
      found.files.push({ path, kind, size: info.size, mtime: Math.floor(info.mtimeMs) })
    }
  }
  return found
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/**
 * What to do about one file, given the row kept for it last time.
 *
 * - Same size and modified time: **unchanged**, and the file is not opened at all.
 * - Otherwise it is read and hashed. Same hash as before (a `touch`, a sync that rewrote the
 *   date): **touched**, only the date is updated. A different hash, or no row: **changed**.
 */
export async function classify(file, row, readBytes) {
  if (row && Number(row.size) === file.size && Number(row.mtime) === file.mtime) return { state: 'unchanged' }
  let bytes
  try {
    bytes = await readBytes(file.path)
  } catch {
    return { state: 'unreadable' }
  }
  const sha = sha256(bytes)
  if (row && row.sha256 === sha) return { state: 'touched', sha }
  return { state: 'changed', sha, bytes, isNew: !row }
}

/** The rows whose file is no longer there: not found, and not inside a folder that could not be listed. */
export function gone(known, present, unreadable) {
  const here = new Set(present)
  const lost = unreadable.map((dir) => fold(resolve(dir)))
  return known.filter((row) => {
    if (here.has(row.path)) return false
    const at = fold(resolve(String(row.path)))
    return !lost.some((dir) => {
      const rel = relative(dir, at)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    })
  })
}
