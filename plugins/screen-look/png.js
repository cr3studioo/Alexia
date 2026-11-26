// SPDX-License-Identifier: AGPL-3.0-only
import { crc32, deflateSync, inflateSync } from 'node:zlib'

/**
 * Just enough PNG to cut a rectangle out of a screenshot: read it, crop it, write it back.
 *
 * It reads what screenshot tools write: 8 or 16 bits a channel, not interlaced, in any of PNG's
 * five colour types. Anything else is refused with an error rather than guessed at. Pure: no
 * files, no child process.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** Samples per pixel by colour type: grey, RGB, palette, grey with alpha, RGBA. */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
/** The chunks that change what the pixels look like, so a crop carries them over. */
const KEPT = new Set(['PLTE', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP'])
/** More pixels than any set of monitors, and less than would exhaust memory. */
const MOST_PIXELS = 100_000_000

/** `{ width, height, depth, colour, bpp, pixels, kept }` — `pixels` unfiltered, row after row. */
export function decode(png) {
  if (!Buffer.isBuffer(png) || png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('that is not a PNG picture')
  }
  let at = 8
  let header
  const data = []
  const kept = []
  while (at + 12 <= png.length) {
    const length = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    if (at + 12 + length > png.length) throw new Error('the picture is cut short')
    const body = png.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') header = body
    else if (type === 'IDAT') data.push(body)
    else if (KEPT.has(type)) kept.push({ type, body })
    else if (type === 'IEND') break
    at += 12 + length
  }
  if (!header || header.length < 13 || data.length === 0) throw new Error('the picture is cut short')
  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  const depth = header[8]
  const colour = header[9]
  const channels = CHANNELS[colour]
  if (!channels || (depth !== 8 && depth !== 16) || header[10] !== 0 || header[11] !== 0 || header[12] !== 0) {
    throw new Error('that kind of PNG cannot be cut')
  }
  if (width === 0 || height === 0 || width * height > MOST_PIXELS) throw new Error('that picture has an impossible size')
  const bpp = channels * (depth / 8)
  const stride = width * bpp
  const raw = inflateSync(Buffer.concat(data), { maxOutputLength: (stride + 1) * height })
  if (raw.length !== (stride + 1) * height) throw new Error('the picture is cut short')
  return { width, height, depth, colour, bpp, pixels: unfilter(raw, stride, height, bpp), kept }
}

/** PNG's five row filters, undone. */
function unfilter(raw, stride, height, bpp) {
  const out = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const from = y * (stride + 1) + 1
    const to = y * stride
    if (filter > 4) throw new Error('the picture is damaged')
    if (filter === 0) {
      raw.copy(out, to, from, from + stride)
      continue
    }
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? out[to + x - bpp] : 0
      const up = y > 0 ? out[to + x - stride] : 0
      let add
      if (filter === 1) add = left
      else if (filter === 2) add = up
      else if (filter === 3) add = (left + up) >> 1
      else add = paeth(left, up, x >= bpp && y > 0 ? out[to + x - stride - bpp] : 0)
      // A Buffer keeps the low byte, which is the sum modulo 256 the format asks for.
      out[to + x] = raw[from + x] + add
    }
  }
  return out
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * The part of `{x, y, w, h}` that lies on a `width` × `height` picture, in whole pixels, or
 * `undefined` when none of it does.
 */
export function clamp(rect, width, height) {
  const left = Math.max(0, Math.floor(rect.x))
  const top = Math.max(0, Math.floor(rect.y))
  const right = Math.min(width, Math.ceil(rect.x + rect.w))
  const bottom = Math.min(height, Math.ceil(rect.y + rect.h))
  if (!(right > left && bottom > top)) return undefined
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/** A new PNG of one rectangle of a decoded picture. `rect` must already be inside it. */
export function crop(image, { x, y, w, h }) {
  const inside = x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= image.width && y + h <= image.height
  if (![x, y, w, h].every(Number.isInteger) || !inside) throw new Error('that rectangle is not on the picture')
  const stride = image.width * image.bpp
  const row = w * image.bpp
  // One filter byte (0, none) before every row; Buffer.alloc has already written it.
  const raw = Buffer.alloc((row + 1) * h)
  for (let line = 0; line < h; line += 1) {
    const from = (y + line) * stride + x * image.bpp
    image.pixels.copy(raw, line * (row + 1) + 1, from, from + row)
  }
  return encode({ width: w, height: h, depth: image.depth, colour: image.colour, kept: image.kept }, raw)
}

/** A PNG file from a header and filtered rows. */
export function encode({ width, height, depth, colour, kept = [] }, raw) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = depth
  header[9] = colour
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    ...kept.map((one) => chunk(one.type, one.body)),
    chunk('IDAT', deflateSync(raw, { level: 3 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length)
  out.writeUInt32BE(body.length, 0)
  out.write(type, 4, 'latin1')
  body.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
  return out
}
