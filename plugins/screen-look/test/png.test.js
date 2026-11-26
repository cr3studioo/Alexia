// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from './harness.js'
import { clamp, crop, decode, encode } from '../png.js'

/** Rows filtered the way an encoder would, with filter `kind(y)` on row y. */
function filtered(pixels, stride, height, bpp, kind) {
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const filter = kind(y)
    raw[y * (stride + 1)] = filter
    for (let x = 0; x < stride; x += 1) {
      const at = y * stride + x
      const a = x >= bpp ? pixels[at - bpp] : 0
      const b = y > 0 ? pixels[at - stride] : 0
      const c = x >= bpp && y > 0 ? pixels[at - stride - bpp] : 0
      const p = a + b - c
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      const predicted = [0, a, b, (a + b) >> 1, paeth][filter]
      raw[y * (stride + 1) + 1 + x] = (pixels[at] - predicted) & 255
    }
  }
  return raw
}

/** Bytes that vary enough for every filter to matter. */
const noise = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 73 + (i >> 3) * 191 + 11) & 255))

test('every filter and colour type is read back, and a crop holds exactly its pixels', () => {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
  for (const [colour, count] of Object.entries(channels)) {
    for (const depth of colour === '3' ? [8] : [8, 16]) {
      const [width, height, bpp] = [13, 11, count * (depth / 8)]
      const stride = width * bpp
      const pixels = noise(stride * height)
      const kept = colour === '3' ? [{ type: 'PLTE', body: noise(768) }] : []
      const raw = filtered(pixels, stride, height, bpp, (y) => y % 5)
      const read = decode(encode({ width, height, depth, colour: Number(colour), kept }, raw))
      assert.deepEqual(read.pixels, pixels, `colour ${colour} depth ${String(depth)}`)

      const piece = decode(crop(read, { x: 3, y: 2, w: 7, h: 5 }))
      assert.deepEqual([piece.width, piece.height, piece.colour, piece.depth], [7, 5, Number(colour), depth])
      const rows = Array.from({ length: 5 }, (_, y) => pixels.subarray((y + 2) * stride + 3 * bpp, (y + 2) * stride + 10 * bpp))
      assert.deepEqual(piece.pixels, Buffer.concat(rows))
      assert.deepEqual(piece.kept, read.kept)
    }
  }
})

test('what is not a picture it can cut is refused', () => {
  const grey = (width, height, depth, raw) => encode({ width, height, depth, colour: 0 }, raw)
  assert.throws(() => decode(Buffer.from('not a picture at all')), /not a PNG/)
  const whole = grey(4, 4, 8, Buffer.alloc(5 * 4))
  assert.throws(() => decode(whole.subarray(0, 40)), /cut short/)
  assert.throws(() => decode(grey(4, 4, 4, Buffer.alloc(12))), /cannot be cut/)
  assert.throws(() => decode(grey(4, 4, 8, Buffer.alloc(13))), /cut short/)
  assert.throws(() => decode(grey(1, 1, 8, Buffer.from([9, 0]))), /damaged/)
  assert.throws(() => crop(decode(whole), { x: 2, y: 0, w: 3, h: 1 }), /not on the picture/)
  assert.throws(() => crop(decode(whole), { x: 0.5, y: 0, w: 1, h: 1 }), /not on the picture/)
})

test('a rectangle is cut to the picture', () => {
  assert.deepEqual(clamp({ x: 2.4, y: -3, w: 5.2, h: 10 }, 100, 100), { x: 2, y: 0, w: 6, h: 7 })
  assert.deepEqual(clamp({ x: 90, y: 90, w: 50, h: 50 }, 100, 100), { x: 90, y: 90, w: 10, h: 10 })
  assert.equal(clamp({ x: 100, y: 0, w: 5, h: 5 }, 100, 100), undefined)
  assert.equal(clamp({ x: -10, y: 0, w: 5, h: 5 }, 100, 100), undefined)
})

// The encoder that writes the real screenshots on Windows: a bitmap drawn in memory (never the
// screen), saved the way computer's script saves one.
test('on Windows a PNG saved by System.Drawing is read and cut', { timeout: 90_000, skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'screen-look-png-'))
  const file = join(dir, 'screen-real.png')
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    '$bitmap = New-Object System.Drawing.Bitmap 320, 200',
    '$canvas = [System.Drawing.Graphics]::FromImage($bitmap)',
    '$canvas.Clear([System.Drawing.Color]::FromArgb(255, 10, 20, 30))',
    '$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 200, 100, 50))',
    '$canvas.FillRectangle($brush, 100, 50, 40, 30)',
    '$bitmap.Save($env:SHOT_FILE, [System.Drawing.Imaging.ImageFormat]::Png)',
    '$canvas.Dispose()',
    '$bitmap.Dispose()',
  ].join('\n')
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, SHOT_FILE: file },
      timeout: 60_000,
    })
    const image = decode(readFileSync(file))
    assert.deepEqual([image.width, image.height, image.depth], [320, 200, 8])
    const piece = decode(crop(image, { x: 99, y: 49, w: 3, h: 3 }))
    const at = (x, y) => [...piece.pixels.subarray((y * 3 + x) * piece.bpp, (y * 3 + x) * piece.bpp + 3)]
    assert.deepEqual(at(0, 0), [10, 20, 30])
    assert.deepEqual(at(1, 1), [200, 100, 50])
    assert.deepEqual(at(2, 2), [200, 100, 50])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
