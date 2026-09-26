// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { coverBox, groundUrl, mountLens } from '../src/lens.js'

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

test('lens: no WebGL is no lens, and nothing left behind', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const lens = mountLens(host, () => host.getBoundingClientRect(), { blur: 4, mix: 0.2, pressed: () => false })
  expect(lens).toBeUndefined()
  expect(host.querySelector('canvas')).toBeNull()
})
