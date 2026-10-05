// SPDX-License-Identifier: AGPL-3.0-only
import { crc32, deflateSync, inflateSync } from 'node:zlib'

/**
 * PNG in and out, with nothing but `node:zlib`.
 *
 * Every picture the editor works on is a PNG by the time it is a version: sources are
 * normalized to it when they become editable, and ComfyUI saves to it. So crop, resize and
 * erase-to-transparency need exactly one lossless format, and a codec for it is a hundred lines
 * rather than a native dependency in a plugin that is otherwise plain JavaScript.
 *
 * Decoding returns straight (not premultiplied) 8-bit RGBA, which is what every transform here
 * works in. Interlaced and 16-bit files decode too; 16-bit is reduced to 8 by its high byte.
 * Encoding writes only the chunks a picture needs — no text, time or EXIF chunk survives, which
 * is also how metadata leaves a deliverable file.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The largest picture the editor decodes, in pixels: about 40 megapixels, 160 MB as RGBA. */
export const MOST_PIXELS = 40_000_000

export function isPng(bytes) {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(SIGNATURE)
}

/** The chunks, checked, without decoding pixels. */
export function chunks(bytes) {
  if (!isPng(bytes)) throw new Error('This is not a PNG.')
  const out = []
  let at = 8
  while (at < bytes.length) {
    if (at + 12 > bytes.length) throw new Error('The PNG ends in the middle of a chunk.')
    const length = bytes.readUInt32BE(at)
    const type = bytes.toString('latin1', at + 4, at + 8)
    if (at + 12 + length > bytes.length) throw new Error('The PNG ends in the middle of a chunk.')
    const data = bytes.subarray(at + 8, at + 8 + length)
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== bytes.readUInt32BE(at + 8 + length)) {
      throw new Error(`The PNG's ${type} chunk is damaged.`)
    }
    out.push({ type, data })
    at += 12 + length
    if (type === 'IEND') break
  }
  if (out[0]?.type !== 'IHDR' || out.at(-1)?.type !== 'IEND') throw new Error('The PNG is incomplete.')
  return out
}

/** Width, height and format, from the header alone. Animated PNGs are refused here. */
export function header(bytes) {
  const all = chunks(bytes)
  const h = all[0].data
  if (h.length !== 13) throw new Error('The PNG header is damaged.')
  const info = {
    width: h.readUInt32BE(0),
    height: h.readUInt32BE(4),
    depth: h[8],
    color: h[9],
    interlace: h[12],
  }
  if (info.width === 0 || info.height === 0) throw new Error('The PNG has no pixels.')
  if (info.width * info.height > MOST_PIXELS) throw new Error(`The picture is ${info.width}×${info.height}, more than the editor opens.`)
  if (h[10] !== 0 || h[11] !== 0 || info.interlace > 1) throw new Error('The PNG uses a method nothing reads.')
  if (!VALID[info.color]?.includes(info.depth)) throw new Error('The PNG has an impossible colour format.')
  if (all.some((c) => c.type === 'acTL')) throw new Error('Animated pictures cannot be edited.')
  return { ...info, chunks: all }
}

const VALID = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** `{ width, height, data }` with `data` as RGBA, four bytes a pixel, row after row. */
export function decode(bytes) {
  const { width, height, depth, color, interlace, chunks: all } = header(bytes)
  const palette = all.find((c) => c.type === 'PLTE')?.data
  const trns = all.find((c) => c.type === 'tRNS')?.data
  if (color === 3 && !palette) throw new Error('The PNG has no palette.')
  const raw = inflateSync(Buffer.concat(all.filter((c) => c.type === 'IDAT').map((c) => c.data)), { maxOutputLength: MOST_PIXELS * 8 + height * 8 })
  const bpp = Math.max(1, (CHANNELS[color] * depth) >> 3)
  const out = Buffer.alloc(width * height * 4)
  let at = 0
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]]
  for (const [x0, y0, dx, dy] of passes) {
    const w = Math.ceil((width - x0) / dx)
    const h = Math.ceil((height - y0) / dy)
    if (w <= 0 || h <= 0) continue
    const stride = Math.ceil((w * CHANNELS[color] * depth) / 8)
    let previous = Buffer.alloc(stride)
    for (let y = 0; y < h; y++) {
      if (at + 1 + stride > raw.length) throw new Error('The PNG ends early.')
      const line = unfilter(raw[at], raw.subarray(at + 1, at + 1 + stride), previous, bpp)
      at += 1 + stride
      for (let x = 0; x < w; x++) {
        const o = ((y0 + y * dy) * width + (x0 + x * dx)) * 4
        pixel(line, x, color, depth, palette, trns, out, o)
      }
      previous = line
    }
  }
  return { width, height, data: out }
}

const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]

function unfilter(type, line, previous, bpp) {
  const out = Buffer.from(line)
  for (let i = 0; i < out.length; i++) {
    const a = i >= bpp ? out[i - bpp] : 0
    const b = previous[i]
    const c = i >= bpp ? previous[i - bpp] : 0
    switch (type) {
      case 0: break
      case 1: out[i] = (out[i] + a) & 255; break
      case 2: out[i] = (out[i] + b) & 255; break
      case 3: out[i] = (out[i] + ((a + b) >> 1)) & 255; break
      case 4: out[i] = (out[i] + paeth(a, b, c)) & 255; break
      default: throw new Error('The PNG has an unknown row filter.')
    }
  }
  return out
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

function sample(line, index, depth) {
  if (depth === 8) return line[index]
  if (depth === 16) return line[index * 2]
  const per = 8 / depth
  const byte = line[Math.floor(index / per)]
  const shift = 8 - depth * ((index % per) + 1)
  return (byte >> shift) & ((1 << depth) - 1)
}

function pixel(line, x, color, depth, palette, trns, out, o) {
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1
  const exact = (index) => (depth === 16 ? line.readUInt16BE(index * 2) : sample(line, index, depth))
  switch (color) {
    case 0: {
      const v = Math.round(sample(line, x, depth) * scale)
      out[o] = out[o + 1] = out[o + 2] = v
      out[o + 3] = trns && trns.length >= 2 && exact(x) === trns.readUInt16BE(0) ? 0 : 255
      break
    }
    case 2: {
      out[o] = sample(line, x * 3, depth)
      out[o + 1] = sample(line, x * 3 + 1, depth)
      out[o + 2] = sample(line, x * 3 + 2, depth)
      const keyed = trns && trns.length >= 6 && exact(x * 3) === trns.readUInt16BE(0) &&
        exact(x * 3 + 1) === trns.readUInt16BE(2) && exact(x * 3 + 2) === trns.readUInt16BE(4)
      out[o + 3] = keyed ? 0 : 255
      break
    }
    case 3: {
      const i = sample(line, x, depth)
      if (i * 3 + 2 >= palette.length) throw new Error('The PNG refers past its palette.')
      out[o] = palette[i * 3]
      out[o + 1] = palette[i * 3 + 1]
      out[o + 2] = palette[i * 3 + 2]
      out[o + 3] = trns && i < trns.length ? trns[i] : 255
      break
    }
    case 4:
      out[o] = out[o + 1] = out[o + 2] = sample(line, x * 2, depth)
      out[o + 3] = sample(line, x * 2 + 1, depth)
      break
    case 6:
      for (let k = 0; k < 4; k++) out[o + k] = sample(line, x * 4 + k, depth)
      break
  }
}

/**
 * RGBA to PNG. Fully opaque pictures are written as RGB, so a crop of a photo does not grow an
 * alpha channel nobody asked for — and a transparent one keeps every alpha value exactly.
 */
export function encode({ width, height, data }) {
  if (data.length !== width * height * 4) throw new Error('The pixels do not match the size.')
  let opaque = true
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) {
      opaque = false
      break
    }
  }
  const channels = opaque ? 3 : 4
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4
      const to = row + 1 + x * channels
      raw[to] = data[from]
      raw[to + 1] = data[from + 1]
      raw[to + 2] = data[from + 2]
      if (!opaque) raw[to + 3] = data[from + 3]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = opaque ? 2 : 6
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
