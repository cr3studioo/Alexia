// SPDX-License-Identifier: AGPL-3.0-only
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'

/**
 * Pictures somebody gave to start from: an attachment, or a file they pointed at.
 *
 * **Read where they are, uploaded where the render is.** The planning computer checks the file
 * is a picture it can open and hands its path to `compute.run` as an input; core carries the
 * bytes to whichever computer renders and puts them on that computer's disk, and the path the
 * operation sees there is that copy. The operation then uploads it to *its own* ComfyUI. No
 * computer is ever assumed to have a file another one has, and no ComfyUI is assumed to be
 * able to read anybody's folders.
 */

/** What ComfyUI's `LoadImage` opens, by extension. Pillow reads more; these are the ones people send. */
export const PICTURES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' }

/** A picture larger than this is not one anybody meant to start a render from. */
export const MOST = 50 * 1024 * 1024

/**
 * Is this a picture that can go with a job? Answers the input core carries, or throws the
 * sentence that says why not.
 */
export function picture(path) {
  const at = String(path ?? '').trim()
  if (at === '') throw new Error('A picture to start from needs the path of the file.')
  const mime = PICTURES[extname(at).toLowerCase()]
  if (!mime) throw new Error(`${basename(at)} is not a picture this can start from — it takes ${Object.keys(PICTURES).join(', ')}.`)
  let found
  try {
    found = statSync(at)
  } catch (error) {
    throw new Error(error?.code === 'ENOENT' ? `There is no file at ${at}.` : `${basename(at)} could not be opened: ${String(error?.message ?? error)}`, {
      cause: error,
    })
  }
  if (!found.isFile()) throw new Error(`${basename(at)} is a folder, not a picture.`)
  if (found.size > MOST) throw new Error(`${basename(at)} is ${Math.round(found.size / 1e6)} MB, which is far more than a picture to start from needs.`)
  return { name: basename(at), path: at, mime }
}

/**
 * What a picture is, from its first bytes.
 *
 * On the computer that renders, the file is wherever core staged the input and is named by
 * core's artifact id, with no extension left to go by — so the format is read off the bytes,
 * which is also what Pillow does when ComfyUI opens it.
 */
export function sniff(bytes) {
  const head = (n) => bytes.subarray(0, n)
  const text = (from, to) => bytes.subarray(from, to).toString('latin1')
  if (bytes.length >= 8 && head(8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg'
  if (bytes.length >= 12 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return '.webp'
  if (bytes.length >= 4 && text(0, 4) === 'GIF8') return '.gif'
  if (bytes.length >= 2 && text(0, 2) === 'BM') return '.bmp'
  return undefined
}

/**
 * The bytes to upload, under a name that is the content's hash. It says nothing about the
 * person's folders to a computer they lent, and the same picture twice is the same upload.
 *
 * **Bytes that are not a picture are refused, whatever the path says.** On a worker the path
 * arrives in a plan from another computer, and the operation is not told which folder core
 * staged that job's inputs in — so this is what keeps a plan from having the host read any file
 * it names and hand it to a ComfyUI.
 */
export function bytesOf(path) {
  const bytes = readFileSync(path)
  const ext = sniff(bytes)
  if (!ext) throw new Error(`${basename(String(path))} is not a picture.`)
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 20)
  return { bytes, name: `alexia-${hash}${ext}`, type: PICTURES[ext] }
}
