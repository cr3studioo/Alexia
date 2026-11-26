// SPDX-License-Identifier: AGPL-3.0-only
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, parse, resolve, sep } from 'node:path'

/**
 * Which files in the temp folder are old enough to go. This only looks; the platform deletes the
 * ones nothing has open.
 *
 * Folders are left in place, and a link or junction is never followed or deleted, so nothing
 * outside the temp folder can be reached from inside it.
 */

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000
/** More than a temp folder should hold; past it the walk stops and says so. */
export const MOST_FILES = 100_000
/** Files looked at side by side. */
const AT_ONCE = 64

const fold = (path) => (process.platform === 'linux' ? path : path.toLowerCase())
const within = (path, folder) => fold(path) === fold(folder) || fold(path).startsWith(fold(folder.endsWith(sep) ? folder : folder + sep))

/**
 * The temp folder, resolved through links — or a refusal, when what is configured as "temp" is a
 * drive, holds the home folder, belongs to Windows, or is not named like a temp folder at all.
 * Cleaning the wrong folder cannot be undone, so doubt means no.
 */
export async function safeTemp(folder, { home, system }) {
  const real = await realpath(resolve(folder))
  const homeReal = await realpath(home).catch(() => resolve(home))
  const named = real.split(sep).some((part) => /^(te?mp|t)$/i.test(part))
  if (real === parse(real).root || within(homeReal, real) || (system && within(real, system)) || !named) {
    throw new Error('The temp folder this computer is set to does not look like your own temp folder, so I left it alone.')
  }
  return real
}

/**
 * Files under `root` that have been neither written nor created in the last week: `[{path, size}]`.
 * Both dates, because a file unpacked or copied today can carry a years-old "modified".
 */
export async function oldFiles(root, { now = Date.now(), age = WEEK_MS, most = MOST_FILES, signal } = {}) {
  const files = []
  const folders = [root]
  let seen = 0
  while (folders.length > 0 && seen < most) {
    signal?.throwIfAborted()
    const folder = folders.pop()
    // A folder that cannot be read, or went away, has nothing to offer.
    const names = await readdir(folder).catch(() => [])
    for (let from = 0; from < names.length && seen < most; from += AT_ONCE) {
      const paths = names.slice(from, from + AT_ONCE).map((name) => join(folder, name))
      const stats = await Promise.all(paths.map((path) => lstat(path).catch(() => undefined)))
      for (const [index, found] of stats.entries()) {
        if (seen >= most) break
        // A junction is a symbolic link to lstat, so it is passed over here too.
        if (!found || found.isSymbolicLink()) continue
        if (found.isDirectory()) folders.push(paths[index])
        else if (found.isFile()) {
          seen += 1
          if (now - Math.max(found.mtimeMs, found.birthtimeMs) > age) files.push({ path: paths[index], size: found.size })
        }
      }
    }
  }
  return { files, more: seen >= most }
}
