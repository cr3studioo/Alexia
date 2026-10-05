// SPDX-License-Identifier: AGPL-3.0-only
import { crc32 } from 'node:zlib'

/**
 * **Is this a picture, how big is it really, and what in it is not the picture?**
 *
 * Answered from the bytes alone, without decoding pixels, so a forty-megapixel bomb is refused
 * before anything allocates for it. Three formats — PNG, JPEG, WebP — because those are what
 * the editor and ComfyUI's loaders read. The name and the shell's claimed type are never trusted
 * over the bytes.
 *
 * **Metadata leaves here.** Text, EXIF, XMP and time chunks are removed from what is kept; only
 * what changes how the pixels look (colour profile, gamma, transparency) stays. A JPEG whose
 * EXIF rotates it is refused rather than silently stripped into the wrong orientation: the editor
 * uploads pictures already turned upright, and a picture that arrives sideways is a picture the
 * person would see one way and the model another.
 */

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp'

export interface Inspected {
  mime: ImageMime
  width: number
  height: number
  /** The kept bytes: the same picture with its metadata removed. */
  bytes: Buffer
}

/** Forty megapixels: past it, decoding is a memory problem before it is a picture. */
export const MOST_PIXELS = 40_000_000

export class ImageRefused extends Error {}

export function inspect(bytes: Buffer): Inspected {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) return png(bytes)
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpeg(bytes)
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return webp(bytes)
  throw new ImageRefused('This is not a PNG, JPEG or WebP picture.')
}

function bounded(width: number, height: number): void {
  if (width < 1 || height < 1) throw new ImageRefused('The picture has no pixels.')
  if (width * height > MOST_PIXELS) throw new ImageRefused(`The picture is ${width}×${height}, larger than Alexia opens.`)
}

/** The PNG chunks that change how the picture looks. Everything else is metadata. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs'])

function png(bytes: Buffer): Inspected {
  const kept: Buffer[] = [bytes.subarray(0, 8)]
  let at = 8
  let width = 0
  let height = 0
  let ended = false
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at)
    const type = bytes.toString('latin1', at + 4, at + 8)
    const end = at + 12 + length
    if (end > bytes.length) throw new ImageRefused('The PNG is cut short.')
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== bytes.readUInt32BE(at + 8 + length)) throw new ImageRefused('The PNG is damaged.')
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(at + 8)
      height = bytes.readUInt32BE(at + 12)
    }
    if (type === 'acTL') throw new ImageRefused('Animated pictures cannot be edited.')
    if (PNG_KEEP.has(type)) kept.push(bytes.subarray(at, end))
    at = end
    if (type === 'IEND') {
      ended = true
      break
    }
  }
  if (!ended || width === 0) throw new ImageRefused('The PNG is incomplete.')
  bounded(width, height)
  return { mime: 'image/png', width, height, bytes: Buffer.concat(kept) }
}

function jpeg(bytes: Buffer): Inspected {
  const kept: Buffer[] = [bytes.subarray(0, 2)]
  let at = 2
  let width = 0
  let height = 0
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) throw new ImageRefused('The JPEG is damaged.')
    const marker = bytes[at + 1] as number
    if (marker === 0xd9) break
    if (marker === 0xda) {
      // Start of scan: the rest is compressed pixels through to the end marker.
      kept.push(bytes.subarray(at))
      break
    }
    const length = bytes.readUInt16BE(at + 2)
    const end = at + 2 + length
    if (end > bytes.length || length < 2) throw new ImageRefused('The JPEG is cut short.')
    // Start of frame, any of the baseline/progressive/lossless kinds: the real size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      height = bytes.readUInt16BE(at + 5)
      width = bytes.readUInt16BE(at + 7)
    }
    if (marker === 0xe1 && bytes.toString('latin1', at + 4, at + 8) === 'Exif') {
      const turned = orientation(bytes.subarray(at + 10, end))
      if (turned !== undefined && turned !== 1) throw new ImageRefused('This JPEG is stored sideways. Attach it again from the editor, which turns it upright first.')
    }
    // APP0 (JFIF), APP2 (ICC profile) and APP14 (Adobe colour transform) change how it looks;
    // every other APP segment and every comment is metadata.
    const metadata = (marker >= 0xe0 && marker <= 0xef && marker !== 0xe0 && marker !== 0xe2 && marker !== 0xee) || marker === 0xfe
    if (!metadata) kept.push(bytes.subarray(at, end))
    at = end
  }
  if (width === 0) throw new ImageRefused('The JPEG has no picture in it.')
  bounded(width, height)
  return { mime: 'image/jpeg', width, height, bytes: Buffer.concat(kept) }
}

/** The EXIF orientation tag, if the TIFF block says one. */
function orientation(tiff: Buffer): number | undefined {
  if (tiff.length < 8) return undefined
  const little = tiff.toString('latin1', 0, 2) === 'II'
  const u16 = (o: number): number => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o))
  const u32 = (o: number): number => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o))
  const ifd = u32(4)
  if (ifd + 2 > tiff.length) return undefined
  const entries = u16(ifd)
  for (let i = 0; i < entries; i++) {
    const e = ifd + 2 + i * 12
    if (e + 12 > tiff.length) return undefined
    if (u16(e) === 0x0112) return u16(e + 8)
  }
  return undefined
}

function webp(bytes: Buffer): Inspected {
  const kept: Buffer[] = []
  let at = 12
  let width = 0
  let height = 0
  let vp8x: Buffer | undefined
  while (at + 8 <= bytes.length) {
    const type = bytes.toString('latin1', at, at + 4)
    const length = bytes.readUInt32LE(at + 4)
    const end = at + 8 + length + (length % 2)
    if (at + 8 + length > bytes.length) throw new ImageRefused('The WebP is cut short.')
    const data = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'ANIM' || type === 'ANMF') throw new ImageRefused('Animated pictures cannot be edited.')
    if (type === 'VP8X') {
      if (((data[0] as number) & 0x02) !== 0) throw new ImageRefused('Animated pictures cannot be edited.')
      width = 1 + data.readUIntLE(4, 3)
      height = 1 + data.readUIntLE(7, 3)
      vp8x = Buffer.from(bytes.subarray(at, end))
      // Clear the EXIF and XMP flags: those chunks are not kept.
      vp8x[8] = (vp8x[8] as number) & ~0x0c
      kept.push(vp8x)
    } else if (type === 'VP8 ') {
      if (!vp8x) {
        width = data.readUInt16LE(6) & 0x3fff
        height = data.readUInt16LE(8) & 0x3fff
      }
      kept.push(bytes.subarray(at, end))
    } else if (type === 'VP8L') {
      if (!vp8x) {
        const bits = data.readUInt32LE(1)
        width = (bits & 0x3fff) + 1
        height = ((bits >> 14) & 0x3fff) + 1
      }
      kept.push(bytes.subarray(at, end))
    } else if (type === 'ALPH' || type === 'ICCP') {
      kept.push(bytes.subarray(at, end))
    }
    at = end
  }
  if (width === 0) throw new ImageRefused('The WebP has no picture in it.')
  bounded(width, height)
  const body = Buffer.concat(kept)
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(body.length + 4, 4)
  header.write('WEBP', 8, 'latin1')
  return { mime: 'image/webp', width, height, bytes: Buffer.concat([header, body]) }
}
