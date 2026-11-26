// SPDX-License-Identifier: AGPL-3.0-only
import { crop, decode } from './png.js'

/**
 * Where on the picture a label is written, when the only reader gives back words and no
 * positions: cut the picture into overlapping pieces, read each, keep the one that still has
 * the label, and repeat until the piece is about the size of a control.
 *
 * It gives up rather than guess: a label that cannot be narrowed to a small rectangle gets none,
 * and so does one that runs out of reads or time. A label written twice is found once, at the
 * first piece that holds it.
 */

/** Narrow until the piece is no larger than this. */
const TARGET = { w: 360, h: 100 }
/** A piece larger than this when the search stops points at nothing in particular. */
const MOST = { w: 640, h: 200 }
const MAX_READS = 30
const BUDGET_MS = 40_000
/** Each piece is this much of the side being cut; the two ends and the middle overlap. */
const SHARE = 0.6

const norm = (s) => String(s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()

/** True when `text` holds `label` as whole words, whatever its case and line breaks. */
export function mentions(text, label) {
  const wanted = norm(label)
  if (wanted === '') return false
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const start = /^[\p{L}\p{N}]/u.test(wanted) ? '(?<![\\p{L}\\p{N}])' : ''
  const end = /[\p{L}\p{N}]$/u.test(wanted) ? '(?![\\p{L}\\p{N}])' : ''
  return new RegExp(`${start}${escaped}${end}`, 'u').test(norm(text))
}

/** The two ends and the middle of `rect`, cut along `side` (`w` or `h`). */
function pieces(rect, side) {
  const at = side === 'w' ? 'x' : 'y'
  const length = Math.ceil(rect[side] * SHARE)
  const spare = rect[side] - length
  return [0, spare, Math.floor(spare / 2)].map((offset) => ({ ...rect, [at]: rect[at] + offset, [side]: length }))
}

/**
 * @param {Buffer} png  the screenshot
 * @param {string} label  the words on the control
 * @param {(png: Buffer) => Promise<string>} read  OCR of one piece; '' when it read nothing
 * @returns {Promise<{x:number,y:number,w:number,h:number} | undefined>} in the picture's pixels
 */
export async function locate(png, label, read, { signal, now = Date.now } = {}) {
  const image = decode(png)
  let rect = { x: 0, y: 0, w: image.width, h: image.height }
  const until = now() + BUDGET_MS
  let reads = 0
  const spent = () => reads >= MAX_READS || now() > until || signal?.aborted === true

  /** The first piece cut along `side` that still holds the label. */
  async function narrower(side) {
    for (const piece of pieces(rect, side)) {
      if (spent()) return undefined
      reads += 1
      if (mentions(await read(crop(image, piece)), label)) return piece
    }
    return undefined
  }

  while (!spent() && (rect.w > TARGET.w || rect.h > TARGET.h)) {
    // Cut the side furthest from its target first, then the other if the label straddles that cut.
    const sides = rect.w / TARGET.w >= rect.h / TARGET.h ? ['w', 'h'] : ['h', 'w']
    let next
    for (const side of sides) {
      if (rect[side] <= TARGET[side]) continue
      next = await narrower(side)
      if (next) break
    }
    if (!next) break
    rect = next
  }
  return rect.w <= MOST.w && rect.h <= MOST.h ? rect : undefined
}
