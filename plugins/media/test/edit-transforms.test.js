// SPDX-License-Identifier: AGPL-3.0-only
import { deflateSync, crc32 } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import { apply, cropRect, geometry, prepareExport, resizePlan, TransformError } from '../edit/transforms.js'
import { chunks, decode, encode, header } from '../edit/transforms/png.js'

/**
 * The tools that need no model. Every assertion here is about pixels or geometry, because
 * those are the promises: the preview is the result, the source is untouched, transparency
 * survives, and nothing silently turns black.
 */

const image = (width, height, at) => {
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) Buffer.from(at(x, y)).copy(data, (y * width + x) * 4)
  }
  return { width, height, data }
}
const px = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)]
const gradient = image(8, 6, (x, y) => [x * 30, y * 40, 100, 255])

const rawChunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('png', () => {
  test('round-trips RGBA exactly, and writes opaque pictures without an alpha channel', () => {
    const clear = image(5, 3, (x, y) => [x * 50, y * 80, 7, x * 60])
    expect(decode(encode(clear))).toEqual(clear)
    expect(header(encode(gradient)).color).toBe(2)
    expect(decode(encode(gradient))).toEqual(gradient)
  })

  test('reads palette, grey and filtered files written by other encoders', () => {
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(2, 0)
    ihdr.writeUInt32BE(2, 4)
    ihdr[8] = 8
    ihdr[9] = 3
    const plte = Buffer.from([255, 0, 0, 0, 0, 255])
    const trns = Buffer.from([128])
    // Two rows: filter 0 then filter 2 (up), indices [0,1] then [1,0] → deltas [1,255].
    const raw = Buffer.from([0, 0, 1, 2, 1, 255])
    const png = Buffer.concat([SIG, rawChunk('IHDR', ihdr), rawChunk('PLTE', plte), rawChunk('tRNS', trns), rawChunk('IDAT', deflateSync(raw)), rawChunk('IEND', Buffer.alloc(0))])
    const out = decode(png)
    expect(px(out, 0, 0)).toEqual([255, 0, 0, 128])
    expect(px(out, 1, 0)).toEqual([0, 0, 255, 255])
    expect(px(out, 0, 1)).toEqual([0, 0, 255, 255])
  })

  test('metadata chunks never survive a re-encode', () => {
    const png = encode(gradient)
    const withText = Buffer.concat([png.subarray(0, png.length - 12), rawChunk('tEXt', Buffer.from('prompt\0secret')), png.subarray(png.length - 12)])
    expect(chunks(withText).map((c) => c.type)).toContain('tEXt')
    expect(chunks(encode(decode(withText))).map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
  })

  test('damaged, animated and oversized files are refused before decoding pixels', () => {
    const png = encode(gradient)
    const broken = Buffer.from(png)
    broken[20] ^= 1
    expect(() => decode(broken)).toThrow(/damaged/)
    const animated = Buffer.concat([png.subarray(0, 33), rawChunk('acTL', Buffer.alloc(8)), png.subarray(33)])
    expect(() => header(animated)).toThrow(/Animated/)
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(100_000, 0)
    ihdr.writeUInt32BE(100_000, 4)
    ihdr[8] = 8
    ihdr[9] = 2
    expect(() => header(Buffer.concat([SIG, rawChunk('IHDR', ihdr), rawChunk('IEND', Buffer.alloc(0))]))).toThrow(/more than the editor opens/)
  })
})

describe('crop', () => {
  test('the preview rectangle is the rectangle kept', () => {
    const rect = { x: 0.25, y: 0.5, width: 0.5, height: 0.5 }
    const { geometry: g, png } = apply(encode(gradient), { kind: 'crop', rect })
    expect(g.rect).toEqual(geometry(gradient, { kind: 'crop', rect }).rect)
    const out = decode(png)
    expect([out.width, out.height]).toEqual([4, 3])
    expect(px(out, 0, 0)).toEqual(px(gradient, 2, 3))
    expect(px(out, 3, 2)).toEqual(px(gradient, 5, 5))
  })

  test('a sliver still keeps one pixel', () => {
    expect(cropRect({ width: 10, height: 10 }, { x: 0.99, y: 0, width: 0.001, height: 1 })).toEqual({ left: 9, top: 0, width: 1, height: 10 })
  })

  test('the source bytes are never changed', () => {
    const png = encode(gradient)
    const before = Buffer.from(png)
    apply(png, { kind: 'crop', rect: { x: 0, y: 0, width: 0.5, height: 0.5 } })
    expect(png.equals(before)).toBe(true)
  })
})

describe('resize', () => {
  test('fit pads, fill crops, neither distorts', () => {
    const fit = resizePlan({ width: 400, height: 200 }, { width: 200, height: 200 }, 'fit')
    expect(fit).toMatchObject({ drawn: { width: 200, height: 100 }, offset: { x: 0, y: 50 }, padded: true, cropped: false })
    const fill = resizePlan({ width: 400, height: 200 }, { width: 200, height: 200 }, 'fill')
    expect(fill).toMatchObject({ drawn: { width: 400, height: 200 }, offset: { x: -100, y: 0 }, cropped: true })
    expect(resizePlan({ width: 10, height: 10 }, { width: 40, height: 40 }, 'fit').upscaled).toBe(true)
  })

  test('fit fills the padding with the chosen background, including transparent', () => {
    const red = image(4, 2, () => [255, 0, 0, 255])
    const out = decode(apply(encode(red), { kind: 'resize', dimensions: { width: 4, height: 4 }, fit: 'fit', background: '#00000000' }).png)
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 0])
    expect(px(out, 0, 1)).toEqual([255, 0, 0, 255])
    expect(px(out, 0, 3)).toEqual([0, 0, 0, 0])
  })

  test('shrinking averages the area each pixel covers', () => {
    const checker = image(4, 4, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]))
    const out = decode(apply(encode(checker), { kind: 'resize', dimensions: { width: 2, height: 2 }, fit: 'fill', background: '#ffffffff' }).png)
    for (const p of [px(out, 0, 0), px(out, 1, 1)]) expect(p).toEqual([128, 128, 128, 255])
  })

  test('transparent pixels do not darken the visible ones beside them', () => {
    const edge = image(2, 1, (x) => (x === 0 ? [255, 255, 255, 255] : [0, 0, 0, 0]))
    const out = decode(apply(encode(edge), { kind: 'resize', dimensions: { width: 1, height: 1 }, fit: 'fit', background: '#00000000' }).png)
    expect(px(out, 0, 0)).toEqual([255, 255, 255, 128])
  })

  test('impossible sizes stop before anything is allocated', () => {
    expect(() => apply(encode(gradient), { kind: 'resize', dimensions: { width: 20_000, height: 10 }, fit: 'fit', background: '#00000000' })).toThrow(TransformError)
    expect(() => geometry(gradient, { kind: 'resize', dimensions: { width: 0, height: 10 }, fit: 'fit' })).toThrow(/whole number/)
  })
})

describe('erase to transparency', () => {
  const mask = image(8, 6, (x) => (x < 4 ? [255, 255, 255, 255] : x === 4 ? [128, 128, 128, 255] : [0, 0, 0, 255]))

  test('white removes, grey removes partly, black keeps', () => {
    const out = decode(apply(encode(gradient), { kind: 'erase_alpha', maskId: 'm1' }, { mask: encode(mask) }).png)
    expect(px(out, 0, 0)[3]).toBe(0)
    expect(px(out, 4, 0)[3]).toBe(127)
    expect(px(out, 7, 5)).toEqual(px(gradient, 7, 5))
  })

  test('a mask from another size of the picture is refused', () => {
    expect(() => apply(encode(gradient), { kind: 'erase_alpha', maskId: 'm1' }, { mask: encode(image(4, 3, () => [255, 255, 255, 255])) })).toThrow(/different size/)
    expect(() => apply(encode(gradient), { kind: 'erase_alpha', maskId: 'm1' })).toThrow(/selected area/)
  })

  test('PNG export keeps the transparency', () => {
    const erased = apply(encode(gradient), { kind: 'erase_alpha', maskId: 'm1' }, { mask: encode(mask) }).png
    const saved = prepareExport(erased, { format: 'png', background: null })
    expect(px(decode(saved.png), 0, 0)[3]).toBe(0)
    expect(saved.transparent).toBe(true)
  })

  test('JPEG export of a transparent picture needs an explicit background, never black', () => {
    const erased = apply(encode(gradient), { kind: 'erase_alpha', maskId: 'm1' }, { mask: encode(mask) }).png
    expect(() => prepareExport(erased, { format: 'jpeg', background: null })).toThrow(expect.objectContaining({ code: 'export_incompatible' }))
    const flat = prepareExport(erased, { format: 'jpeg', background: '#ffffff' })
    expect(flat.flattened).toBe(true)
    expect(px(decode(flat.png), 0, 0)).toEqual([255, 255, 255, 255])
  })

  test('an opaque picture exports to JPEG without asking', () => {
    expect(prepareExport(encode(gradient), { format: 'jpeg', background: null }).flattened).toBe(false)
  })
})
