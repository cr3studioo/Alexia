// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { decode, encode } from './transforms/png.js'

/**
 * Point notes: where a local edit is allowed to change the picture, and proof that it did not
 * change anything else.
 *
 * **A tap is not a boundary.** A point becomes a visible, adjustable selection here, and only
 * the mask this file rasterizes — the one the editor shows, feathering included — is what an
 * edit may change. The model never draws or moves one.
 *
 * **Outside the mask is enforced, not requested.** A masked render can drift anywhere in the
 * frame, so every pass is composited back onto its source through the effective mask, and the
 * result is checked: every pixel the mask leaves at zero must equal the source exactly. A
 * prompt that says *keep everything else* is a hint; this is the guarantee.
 */

export const MOST_NOTES = 8
/** A tap with nothing drawn yet starts as a circle this fraction of the shorter side. */
export const TAP_RADIUS = 0.06
/** Two masks sharing more than this fraction of the smaller one are the same area twice. */
export const OVERLAP = 0.01

/**
 * Shapes, in normalized source coordinates, to an 8-bit mask the source's size.
 *
 * `shapes` apply in order: `add` paints, `subtract` erases. Ellipse `{cx, cy, rx, ry}`, rect
 * `{x, y, width, height}`, brush `{points, radius}`; radii are fractions of the shorter side.
 * `feather` is in source pixels and softens the edge outward and inward evenly.
 */
export function rasterize({ width, height }, shapes, feather = 0) {
  const hard = new Uint8Array(width * height)
  const side = Math.min(width, height)
  for (const s of shapes) {
    const value = s.mode === 'subtract' ? 0 : 255
    const paint = (inside, box) => {
      const x0 = Math.max(0, Math.floor(box.x0)), x1 = Math.min(width - 1, Math.ceil(box.x1))
      const y0 = Math.max(0, Math.floor(box.y0)), y1 = Math.min(height - 1, Math.ceil(box.y1))
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) if (inside(x + 0.5, y + 0.5)) hard[y * width + x] = value
      }
    }
    switch (s.shape) {
      case 'ellipse': {
        const cx = s.cx * width, cy = s.cy * height, rx = s.rx * side, ry = s.ry * side
        if (rx <= 0 || ry <= 0) break
        paint((x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1, { x0: cx - rx, x1: cx + rx, y0: cy - ry, y1: cy + ry })
        break
      }
      case 'rect': {
        const x0 = s.x * width, y0 = s.y * height, x1 = (s.x + s.width) * width, y1 = (s.y + s.height) * height
        paint((x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1, { x0, x1, y0, y1 })
        break
      }
      case 'brush': {
        const r = s.radius * side
        const pts = s.points.map((p) => ({ x: p.x * width, y: p.y * height }))
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)]
          paint((x, y) => segment(x, y, a, b) <= r, {
            x0: Math.min(a.x, b.x) - r, x1: Math.max(a.x, b.x) + r, y0: Math.min(a.y, b.y) - r, y1: Math.max(a.y, b.y) + r,
          })
        }
        break
      }
      default:
        throw new RegionError('region_invalid', `A selection cannot be a ${s.shape}.`)
    }
  }
  return feather > 0 ? blur(hard, width, height, Math.round(feather)) : hard
}

/** The selection a tap starts with: a circle the person can then resize, brush or replace. */
export const tap = (point) => [{ mode: 'add', shape: 'ellipse', cx: point.x, cy: point.y, rx: TAP_RADIUS, ry: TAP_RADIUS }]

function segment(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y
  const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy))
}

/** Two box passes: a soft edge whose falloff is the same everywhere and on every machine. */
function blur(mask, width, height, radius) {
  const pass = (from, horizontal) => {
    const out = new Uint8Array(from.length)
    const outer = horizontal ? height : width
    const inner = horizontal ? width : height
    for (let o = 0; o < outer; o++) {
      let sum = 0
      const at = (i) => (horizontal ? o * width + i : i * width + o)
      for (let i = -radius; i <= radius; i++) sum += from[at(Math.min(inner - 1, Math.max(0, i)))]
      for (let i = 0; i < inner; i++) {
        out[at(i)] = Math.round(sum / (2 * radius + 1))
        sum += from[at(Math.min(inner - 1, i + radius + 1))] - from[at(Math.max(0, i - radius))]
      }
    }
    return out
  }
  return pass(pass(mask, true), false)
}

/** An 8-bit mask as the grey PNG artifact that is stored, staged and shown. */
export function maskPng(mask, { width, height }) {
  const data = Buffer.alloc(width * height * 4)
  for (let i = 0; i < mask.length; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = mask[i]
    data[i * 4 + 3] = 255
  }
  return encode({ width, height, data })
}

/** The mask back out of its artifact, checked against what its descriptor claims. */
export function readMask(png, descriptor, source) {
  if (sha256(png) !== descriptor.sha256) throw new RegionError('region_invalid', 'The selection file is not the one that was saved.')
  if (descriptor.sourceVersionId !== source.versionId) throw new RegionError('region_stale', 'The selection was made on another version of this picture.')
  const image = decode(png)
  if (image.width !== source.dimensions.width || image.height !== source.dimensions.height ||
      descriptor.dimensions.width !== image.width || descriptor.dimensions.height !== image.height) {
    throw new RegionError('region_stale', 'The selection was made on a different size of this picture.')
  }
  const mask = new Uint8Array(image.width * image.height)
  for (let i = 0; i < mask.length; i++) {
    const [r, g, b] = [image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]]
    if (r !== g || g !== b || image.data[i * 4 + 3] !== 255) throw new RegionError('region_invalid', 'A selection is grey, with no transparency.')
    mask[i] = r
  }
  const covered = coverage(mask)
  if (covered === 0) throw new RegionError('region_invalid', 'The selection is empty.')
  if (Math.abs(covered - descriptor.coverage) > 1e-6) throw new RegionError('region_invalid', 'The selection does not match its description.')
  return mask
}

/** The fraction of pixels a mask lets change at all. */
export function coverage(mask) {
  let n = 0
  for (const v of mask) if (v > 0) n++
  return n / mask.length
}

/** A descriptor for a freshly rasterized mask; ids come from the caller. */
export function describeMask({ id, artifactId, source, mask, png, featherPixels }) {
  const covered = coverage(mask)
  if (covered === 0) throw new RegionError('region_invalid', 'The selection is empty.')
  return { id, artifactId, sourceVersionId: source.versionId, dimensions: { ...source.dimensions }, sha256: sha256(png), coverage: covered, featherPixels }
}

/**
 * Which notes run, in which order — or the reason none can.
 *
 * Only enabled notes count. Each needs words, a reviewed mask on the current source and no
 * shared area with another active note. The order is the list the person sees.
 */
export function passes(draft, masks) {
  const active = draft.regions.filter((r) => r.enabled)
  if (active.length === 0) throw new RegionError('region_invalid', 'Add a note to an area first.')
  if (active.length > MOST_NOTES) throw new RegionError('region_invalid', `At most ${MOST_NOTES} notes can be applied at once.`)
  for (const [i, r] of active.entries()) {
    const n = i + 1
    if (r.stale || r.sourceVersionId !== draft.source.versionId) throw new RegionError('region_stale', `Note ${n} was placed on another version. Place it again on this one.`, r.id)
    if (!r.mask) throw new RegionError('region_invalid', `Note ${n} has no selected area yet.`, r.id)
    if (!r.reviewed) throw new RegionError('region_invalid', `Check the area for note ${n} before generating.`, r.id)
    if (r.instruction.trim() === '' && draft.operation !== 'remove_fill') throw new RegionError('region_invalid', `Note ${n} says nothing to change.`, r.id)
    if (!masks.has(r.mask.id)) throw new RegionError('region_invalid', `The area for note ${n} is missing.`, r.id)
  }
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      if (overlap(masks.get(active[i].mask.id), masks.get(active[j].mask.id)) > OVERLAP) {
        throw new RegionError('region_conflict', `Notes ${i + 1} and ${j + 1} cover the same area. Make their areas separate, or combine them into one note.`, active[j].id)
      }
    }
  }
  return active.map((r) => ({ regionId: r.id, maskId: r.mask.id }))
}

/** Shared area as a fraction of the smaller mask. */
export function overlap(a, b) {
  let both = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] > 0) na++
    if (b[i] > 0) nb++
    if (a[i] > 0 && b[i] > 0) both++
  }
  return Math.min(na, nb) === 0 ? 0 : both / Math.min(na, nb)
}

/**
 * The edited picture laid back onto its source through the mask: `source × (1 − m) + edit × m`.
 * Where `m` is 0 the source pixel is copied exactly, so the result outside the selection *is*
 * the source, not an approximation of it.
 */
export function composite(source, edited, mask) {
  if (edited.width !== source.width || edited.height !== source.height) {
    throw new RegionError('render_failed', `The edit came back ${edited.width}×${edited.height}, not ${source.width}×${source.height}.`)
  }
  const out = Buffer.from(source.data)
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i]
    if (m === 0) continue
    const o = i * 4
    for (let k = 0; k < 4; k++) out[o + k] = Math.round((source.data[o + k] * (255 - m) + edited.data[o + k] * m) / 255)
  }
  return { width: source.width, height: source.height, data: out }
}

/** Every pixel the mask leaves at zero, unchanged. Checked on the lossless working picture. */
export function preserved(source, result, mask) {
  if (result.width !== source.width || result.height !== source.height) return false
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0) continue
    const o = i * 4
    if (source.data[o] !== result.data[o] || source.data[o + 1] !== result.data[o + 1] ||
        source.data[o + 2] !== result.data[o + 2] || source.data[o + 3] !== result.data[o + 3]) return false
  }
  return true
}

/**
 * A changed source keeps every note's words and marks its geometry stale; nothing is silently
 * re-placed on a picture whose composition may have moved.
 */
export function rebase(regions, sourceVersionId) {
  return regions.map((r) => (r.sourceVersionId === sourceVersionId ? r : { ...r, stale: true, reviewed: false }))
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export class RegionError extends Error {
  constructor(code, message, regionId = null) {
    super(message)
    this.code = code
    this.regionId = regionId
  }
}
