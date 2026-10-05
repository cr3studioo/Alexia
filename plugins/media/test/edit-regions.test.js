// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from 'vitest'
import {
  composite, coverage, describeMask, maskPng, overlap, passes, preserved, rasterize, readMask, rebase, RegionError, tap,
} from '../edit/regions.js'

/**
 * Point notes. The promise worth testing is the one in the plan's acceptance matrix: *outside the
 * effective mask stays unchanged* — so these tests compare pixels, exactly, rather than trusting
 * that a mask was passed along.
 */

const size = { width: 200, height: 100 }
const at = (x, y) => y * size.width + x
const source = { versionId: 'v1', dimensions: size }
const picture = (fill) => {
  const data = Buffer.alloc(size.width * size.height * 4)
  for (let i = 0; i < data.length; i += 4) fill(i / 4).forEach((v, k) => (data[i + k] = v))
  return { ...size, data }
}

const note = (over) => ({
  id: 'n1', sourceVersionId: 'v1', point: { x: 0.25, y: 0.5 }, instruction: 'make this blue',
  enabled: true, reviewed: true, stale: false, mask: null, ...over,
})
const maskFor = (id, shapes, feather = 0) => {
  const mask = rasterize(size, shapes, feather)
  const png = maskPng(mask, size)
  return { mask, png, descriptor: describeMask({ id, artifactId: `a_${id}`, source, mask, png, featherPixels: feather }) }
}

describe('selections', () => {
  test('a tap is an adjustable circle, never a single pixel', () => {
    const m = rasterize(size, tap({ x: 0.5, y: 0.5 }))
    expect(coverage(m)).toBeGreaterThan(0.005)
    expect(m[at(100, 50)]).toBe(255)
    expect(m[0]).toBe(0)
  })

  test('rectangles add, brushes subtract, in order', () => {
    const m = rasterize(size, [
      { mode: 'add', shape: 'rect', x: 0, y: 0, width: 0.5, height: 1 },
      { mode: 'subtract', shape: 'brush', points: [{ x: 0.25, y: 0 }, { x: 0.25, y: 1 }], radius: 0.05 },
    ])
    expect(m[at(10, 25)]).toBe(255)
    expect(m[at(50, 25)]).toBe(0)
    expect(m[at(150, 25)]).toBe(0)
  })

  test('feathering softens the edge on both sides and is the same every time', () => {
    const shapes = [{ mode: 'add', shape: 'rect', x: 0, y: 0, width: 0.5, height: 1 }]
    const soft = rasterize(size, shapes, 3)
    expect(soft[at(98, 50)]).toBeGreaterThan(0)
    expect(soft[at(98, 50)]).toBeLessThan(255)
    expect(soft[at(101, 50)]).toBeGreaterThan(0)
    expect(rasterize(size, shapes, 3)).toEqual(soft)
  })

  test('coordinates are source-relative, so the same note fits any display size', () => {
    const big = rasterize({ width: 400, height: 200 }, tap({ x: 0.25, y: 0.5 }))
    expect(big[100 * 400 + 100]).toBe(255)
    expect(rasterize(size, tap({ x: 0.25, y: 0.5 }))[at(50, 50)]).toBe(255)
  })
})

describe('mask artifacts', () => {
  test('a stored mask reads back only if it is the one described, on this version', () => {
    const { png, descriptor, mask } = maskFor('m1', tap({ x: 0.5, y: 0.5 }))
    expect(readMask(png, descriptor, source)).toEqual(mask)
    expect(() => readMask(png, { ...descriptor, sha256: '0'.repeat(64) }, source)).toThrow(/not the one/)
    expect(() => readMask(png, descriptor, { ...source, versionId: 'v2' })).toThrow(expect.objectContaining({ code: 'region_stale' }))
    expect(() => readMask(png, descriptor, { ...source, dimensions: { width: 80, height: 40 } })).toThrow(expect.objectContaining({ code: 'region_stale' }))
  })

  test('an empty selection is refused', () => {
    expect(() => maskFor('m1', [{ mode: 'add', shape: 'ellipse', cx: 0.5, cy: 0.5, rx: 0, ry: 0 }])).toThrow(/empty/)
  })
})

describe('which notes run', () => {
  const a = maskFor('ma', [{ mode: 'add', shape: 'rect', x: 0, y: 0, width: 0.3, height: 1 }])
  const b = maskFor('mb', [{ mode: 'add', shape: 'rect', x: 0.6, y: 0, width: 0.3, height: 1 }])
  const masks = new Map([['ma', a.mask], ['mb', b.mask]])
  const draft = (regions, operation = 'inpaint') => ({ source, operation, regions })

  test('active notes run one pass each, in the order the list shows', () => {
    expect(passes(draft([note({ id: 'n2', mask: b.descriptor }), note({ id: 'n1', mask: a.descriptor }), note({ id: 'n3', enabled: false })]), masks))
      .toEqual([{ regionId: 'n2', maskId: 'mb' }, { regionId: 'n1', maskId: 'ma' }])
  })

  test('stale, unreviewed, empty and maskless notes stop before anything renders', () => {
    const code = (r) => {
      try {
        passes(draft([r]), masks)
      } catch (error) {
        return error.code
      }
    }
    expect(code(note({ mask: a.descriptor, stale: true }))).toBe('region_stale')
    expect(code(note({ mask: a.descriptor, sourceVersionId: 'v0' }))).toBe('region_stale')
    expect(code(note({ mask: a.descriptor, reviewed: false }))).toBe('region_invalid')
    expect(code(note({ mask: null }))).toBe('region_invalid')
    expect(code(note({ mask: a.descriptor, instruction: ' ' }))).toBe('region_invalid')
    expect(passes(draft([note({ mask: a.descriptor, instruction: '' })], 'remove_fill'), masks)).toHaveLength(1)
  })

  test('two notes on the same area must be resolved first', () => {
    const c = maskFor('mc', [{ mode: 'add', shape: 'rect', x: 0.2, y: 0, width: 0.3, height: 1 }])
    expect(overlap(a.mask, c.mask)).toBeGreaterThan(0.01)
    expect(() => passes(draft([note({ id: 'n1', mask: a.descriptor }), note({ id: 'n2', mask: c.descriptor })]), new Map([...masks, ['mc', c.mask]])))
      .toThrow(expect.objectContaining({ code: 'region_conflict', regionId: 'n2' }))
  })

  test('a new source keeps the words and marks every placement stale', () => {
    const moved = rebase([note({ mask: a.descriptor })], 'v2')
    expect(moved[0]).toMatchObject({ instruction: 'make this blue', stale: true, reviewed: false })
  })
})

describe('compositing', () => {
  const original = picture((i) => [i % 256, (i * 7) % 256, 50, 255])
  // A render that changed everything, including outside the selection.
  const drifted = picture(() => [0, 0, 255, 255])

  test('outside the effective mask the result is the source, pixel for pixel', () => {
    const { mask } = maskFor('m', tap({ x: 0.5, y: 0.5 }), 2)
    const out = composite(original, drifted, mask)
    expect(preserved(original, out, mask)).toBe(true)
    expect(preserved(original, drifted, mask)).toBe(false)
    const centre = at(100, 50) * 4
    expect([...out.data.subarray(centre, centre + 4)]).toEqual([0, 0, 255, 255])
  })

  test('feathered edges blend in proportion to the mask', () => {
    const mask = new Uint8Array(200 * 100)
    mask[0] = 128
    const out = composite(picture(() => [0, 0, 0, 255]), picture(() => [255, 255, 255, 255]), mask)
    expect(out.data[0]).toBe(128)
  })

  test('a render at another size is refused rather than stretched', () => {
    expect(() => composite(original, { width: 20, height: 10, data: Buffer.alloc(800) }, new Uint8Array(800))).toThrow(RegionError)
  })
})
