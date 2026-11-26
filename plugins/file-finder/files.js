// SPDX-License-Identifier: AGPL-3.0-only
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** What search and tidy share: refusals, the owner's roots, and the kinds of file there are. */

/** A refusal that carries a sentence the owner can read. */
export class Refused extends Error {}
export const refuse = (text) => new Refused(text)

export const EXTENSIONS = {
  // No `key`: it is as often a private key as a Keynote file.
  document: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp', 'pages', 'numbers', 'epub'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'svg', 'avif'],
  video: ['mp4', 'm4v', 'mov', 'mkv', 'avi', 'wmv', 'webm', 'mpg', 'mpeg'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma', 'aiff'],
  archive: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst'],
}

export const INSTALLERS = ['exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'dmg', 'pkg', 'mpkg']

/** The extension of a file name, lower case, without the dot. */
export function extensionOf(name) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

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

/** Windows compares paths without case. */
export const fold = (path) => (process.platform === 'win32' ? path.toLowerCase() : path)

/** Is `path` the folder `root` or somewhere inside it? Both already resolved. */
export function inside(path, root) {
  const rel = relative(fold(root), fold(path))
  // Only a whole `..` step leaves the folder; a child may well be called `..cache`.
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** The owner's roots as real paths, asked now: the owner may change them at any time. */
export async function realRoots(ask) {
  const listed = await Promise.resolve()
    .then(ask)
    .catch(() => [])
  const real = []
  for (const root of rootPaths(listed)) real.push(await realpath(root).catch(() => resolve(root)))
  return real
}
