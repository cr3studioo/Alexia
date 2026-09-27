// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { coverBox, groundUrl, mountLens, soften } from '../src/lens.js'

/**
 * The lens: where it thinks the painting is, and what it does on a machine with no WebGL. The
 * drawing itself needs a graphics card and is looked at in the app (the report says how).
 */

test('lens: the painting is found from --ground, quoted or not', () => {
  expect(groundUrl("url('/theme-light.webp')")).toBe('/theme-light.webp')
  expect(groundUrl(' url("http://127.0.0.1:4000/theme-dark.webp")')).toBe('http://127.0.0.1:4000/theme-dark.webp')
  expect(groundUrl('url(/theme-dark.webp)')).toBe('/theme-dark.webp')
  expect(groundUrl('none')).toBeUndefined()
})

test('lens: cover fills the window both ways and centres the rest, like the body', () => {
  // A wide window over a 16:9 painting: the width decides, and the height spills evenly.
  const wide = coverBox({ width: 2000, height: 800 }, { width: 1600, height: 900 })
  expect(wide.width).toBe(2000)
  expect(wide.height).toBeCloseTo(1125)
  expect(wide.left).toBe(0)
  expect(wide.top).toBeCloseTo(-162.5)
  // A tall one: the height decides.
  const tall = coverBox({ width: 600, height: 900 }, { width: 1600, height: 900 })
  expect(tall.height).toBe(900)
  expect(tall.left).toBeCloseTo((600 - 1600) / 2)
})

test('lens: the frost is worked out once, softening each pixel into its neighbours', () => {
  // One bright pixel in the middle of five by five: it spreads to the three by three round it,
  // a ninth each, and the light in the picture stays the light there was.
  const size = 5
  const pixels = new Uint8ClampedArray(size * size * 4)
  pixels[(2 * size + 2) * 4] = 225
  soften(pixels, size, size)
  const red = (x: number, y: number): number => pixels[(y * size + x) * 4]!
  expect(red(2, 2)).toBe(25)
  expect(red(1, 1)).toBe(25)
  expect(red(3, 2)).toBe(25)
  expect(red(0, 0)).toBe(0)
  let total = 0
  for (let i = 0; i < pixels.length; i += 4) total += pixels[i]!
  expect(total).toBe(225)
  // A flat colour stays that colour, to its edges.
  const flat = new Uint8ClampedArray(3 * 2 * 4).fill(90)
  soften(flat, 3, 2)
  expect([...flat].every((one) => one === 90)).toBe(true)
})

test('lens: the shader reads the frosted painting three times a pixel, not sixty-three', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'lens.ts'), 'utf8')
  const start = source.indexOf('const FRAG')
  const shader = source.slice(start, source.indexOf('}`', start))
  expect(shader.match(/texture2D\(/g)).toHaveLength(1)
  expect(shader.match(/frost\(/g)).toHaveLength(4)
  expect(shader).not.toMatch(/for \(/)
})

test('lens: no WebGL is no lens, and nothing left behind', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const lens = mountLens(host, () => ({ left: 0, top: 0, width: 10, height: 10 }), { mix: 0.2, pressed: () => false })
  expect(lens).toBeUndefined()
  expect(host.querySelector('canvas')).toBeNull()
})
