// SPDX-License-Identifier: AGPL-3.0-only
import { decode, encode, header, MOST_PIXELS } from './transforms/png.js'

/**
 * Crop, resize and erase-to-transparency: the editor tools that need no model.
 *
 * **Every rule that decides a pixel is here, and the preview uses the same rule.** `geometry()`
 * is what the editor draws before anything is applied — the exact rectangle kept, the exact
 * scale and padding — and `apply()` uses that same answer to make the pixels. A preview that
 * rounded differently from the result would be a promise the result breaks.
 *
 * Nothing here calls a model, a network or ComfyUI, so these tools work with nothing installed.
 * Each one makes a new picture; the source is never written to.
 */

export const MOST_SIDE = 16_384

/** Pixel rectangle a normalized crop keeps: edges rounded to the nearest pixel, never empty. */
export function cropRect({ width, height }, rect) {
  const left = clamp(Math.round(rect.x * width), 0, width - 1)
  const top = clamp(Math.round(rect.y * height), 0, height - 1)
  const right = clamp(Math.round((rect.x + rect.width) * width), left + 1, width)
  const bottom = clamp(Math.round((rect.y + rect.height) * height), top + 1, height)
  return { left, top, width: right - left, height: bottom - top }
}

/**
 * Where a resized picture lands in its new frame.
 *
 * `fit` scales the whole picture to fit inside and pads the rest with `background`; `fill`
 * scales to cover and crops the overflow evenly. Stretching to a different aspect is never a
 * default: neither mode distorts.
 */
export function resizePlan(source, target, fit) {
  const scale = fit === 'fit'
    ? Math.min(target.width / source.width, target.height / source.height)
    : Math.max(target.width / source.width, target.height / source.height)
  const drawn = { width: Math.max(1, Math.round(source.width * scale)), height: Math.max(1, Math.round(source.height * scale)) }
  return {
    scale,
    drawn,
    // Where the scaled picture's top-left lands; negative means that much is cropped away.
    offset: { x: Math.floor((target.width - drawn.width) / 2), y: Math.floor((target.height - drawn.height) / 2) },
    padded: fit === 'fit' && (drawn.width < target.width || drawn.height < target.height),
    cropped: fit === 'fill' && (drawn.width > target.width || drawn.height > target.height),
    upscaled: scale > 1,
  }
}

/** What the editor shows before applying: output size and, for resize, the placement. */
export function geometry(source, transform) {
  check(source)
  switch (transform.kind) {
    case 'crop': {
      const r = cropRect(source, transform.rect)
      return { kind: 'crop', output: { width: r.width, height: r.height }, rect: r }
    }
    case 'resize':
      check(transform.dimensions)
      return { kind: 'resize', output: { ...transform.dimensions }, ...resizePlan(source, transform.dimensions, transform.fit) }
    case 'erase_alpha':
      return { kind: 'erase_alpha', output: { width: source.width, height: source.height } }
    default:
      throw new TransformError('unsupported', `There is no ${transform.kind} tool.`)
  }
}

/**
 * Apply one transform to PNG bytes, returning new PNG bytes and what was done.
 *
 * `mask` is the effective mask PNG for `erase_alpha` — the one the editor displayed, at the
 * source's size, already feathered. White removes, black keeps, grey removes partly.
 */
export function apply(png, transform, { mask } = {}) {
  const image = decode(png)
  const plan = geometry(image, transform)
  let out
  switch (transform.kind) {
    case 'crop': out = crop(image, plan.rect); break
    case 'resize': out = resize(image, transform.dimensions, plan, parseColor(transform.background)); break
    case 'erase_alpha': {
      if (!mask) throw new TransformError('mask_required', 'Erasing to transparency needs the selected area.')
      out = eraseAlpha(image, decode(mask))
      break
    }
  }
  return { png: encode(out), width: out.width, height: out.height, geometry: plan }
}

export function crop(image, r) {
  const data = Buffer.alloc(r.width * r.height * 4)
  for (let y = 0; y < r.height; y++) {
    const from = ((r.top + y) * image.width + r.left) * 4
    image.data.copy(data, y * r.width * 4, from, from + r.width * 4)
  }
  return { width: r.width, height: r.height, data }
}

/**
 * Resampled in premultiplied alpha, so a transparent edge does not drag its invisible colour
 * into the visible one. Each output pixel averages the exact source area it covers (box
 * filter), which is a true average when shrinking and a smooth blend when enlarging — and is
 * the same arithmetic on every machine.
 */
export function resize(image, target, plan, background) {
  const scaled = scale(image, plan.drawn)
  const out = Buffer.alloc(target.width * target.height * 4)
  for (let i = 0; i < out.length; i += 4) background.copy(out, i)
  for (let y = 0; y < target.height; y++) {
    const sy = y - plan.offset.y
    if (sy < 0 || sy >= scaled.height) continue
    for (let x = 0; x < target.width; x++) {
      const sx = x - plan.offset.x
      if (sx < 0 || sx >= scaled.width) continue
      const from = (sy * scaled.width + sx) * 4
      over(scaled.data, from, out, (y * target.width + x) * 4)
    }
  }
  return { width: target.width, height: target.height, data: out }
}

function scale(image, size) {
  if (size.width === image.width && size.height === image.height) return image
  const fx = image.width / size.width
  const fy = image.height / size.height
  const data = Buffer.alloc(size.width * size.height * 4)
  // Upscaling with a box narrower than one source pixel would be nearest-neighbour; a box of at
  // least one pixel centred on the sample point gives the bilinear-like blend instead.
  const bx = Math.max(fx, 1)
  const by = Math.max(fy, 1)
  for (let y = 0; y < size.height; y++) {
    const cy = (y + 0.5) * fy
    const y0 = cy - by / 2
    const y1 = cy + by / 2
    for (let x = 0; x < size.width; x++) {
      const cx = (x + 0.5) * fx
      const x0 = cx - bx / 2
      const x1 = cx + bx / 2
      let r = 0, g = 0, b = 0, a = 0, total = 0
      for (let sy = Math.max(0, Math.floor(y0)); sy < Math.min(image.height, Math.ceil(y1)); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy)
        for (let sx = Math.max(0, Math.floor(x0)); sx < Math.min(image.width, Math.ceil(x1)); sx++) {
          const w = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx))
          const i = (sy * image.width + sx) * 4
          const alpha = image.data[i + 3] * w
          r += image.data[i] * alpha
          g += image.data[i + 1] * alpha
          b += image.data[i + 2] * alpha
          a += alpha
          total += w
        }
      }
      const o = (y * size.width + x) * 4
      if (a > 0) {
        data[o] = Math.round(r / a)
        data[o + 1] = Math.round(g / a)
        data[o + 2] = Math.round(b / a)
      }
      data[o + 3] = total > 0 ? Math.round(a / total) : 0
    }
  }
  return { width: size.width, height: size.height, data }
}

/** Source-over, straight alpha, onto whatever is already at `to`. */
function over(src, from, dst, to) {
  const sa = src[from + 3] / 255
  if (sa === 1) {
    src.copy(dst, to, from, from + 4)
    return
  }
  const da = dst[to + 3] / 255
  const a = sa + da * (1 - sa)
  for (let k = 0; k < 3; k++) {
    dst[to + k] = a === 0 ? 0 : Math.round((src[from + k] * sa + dst[to + k] * da * (1 - sa)) / a)
  }
  dst[to + 3] = Math.round(a * 255)
}

export function eraseAlpha(image, mask) {
  if (mask.width !== image.width || mask.height !== image.height) {
    throw new TransformError('mask_mismatch', 'The selection was made on a different size of this picture.')
  }
  const data = Buffer.from(image.data)
  for (let i = 0; i < data.length; i += 4) {
    const remove = mask.data[i] // grey: R = G = B
    if (remove !== 0) data[i + 3] = Math.round((data[i + 3] * (255 - remove)) / 255)
  }
  return { width: image.width, height: image.height, data }
}

/**
 * The bytes a person saves.
 *
 * PNG is re-encoded from pixels, which drops every metadata chunk, including any workflow or
 * prompt ComfyUI wrote into it. JPEG has no transparency, so a transparent picture needs an
 * explicit background: without one this refuses with `export_incompatible` rather than turning
 * the transparent part black. This returns a flattened PNG for JPEG and WebP; the editor encodes
 * the final format from those lossless pixels.
 */
export function prepareExport(png, { format, background }) {
  const image = decode(png)
  const transparent = hasAlpha(image)
  if (format === 'png') return { png: encode(image), flattened: false, transparent }
  if (format === 'webp' && background === null) return { png: encode(image), flattened: false, transparent }
  if (transparent && background === null) {
    throw new TransformError('export_incompatible', 'JPEG cannot keep transparency. Choose a background colour, or save as PNG.')
  }
  if (!transparent) return { png: encode(image), flattened: false, transparent }
  const color = parseColor(`${background}ff`)
  const out = Buffer.alloc(image.data.length)
  for (let i = 0; i < out.length; i += 4) {
    color.copy(out, i)
    over(image.data, i, out, i)
  }
  return { png: encode({ ...image, data: out }), flattened: true, transparent }
}

export function hasAlpha(image) {
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] !== 255) return true
  return false
}

/** Size check before anything is decoded or allocated. */
export function check(size) {
  const { width, height } = size
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new TransformError('invalid_dimensions', 'A picture needs a whole number of pixels on each side.')
  }
  if (width > MOST_SIDE || height > MOST_SIDE || width * height > MOST_PIXELS) {
    throw new TransformError('invalid_dimensions', `${width}×${height} is larger than the editor can hold.`)
  }
}

/** The size and format a PNG claims, without decoding its pixels. */
export const describe = (png) => {
  const { width, height } = header(png)
  return { width, height }
}

function parseColor(hex) {
  if (!/^#[0-9a-fA-F]{8}$/.test(hex)) throw new TransformError('invalid_background', 'A background is a colour like #ffffffff.')
  return Buffer.from(hex.slice(1), 'hex')
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

export class TransformError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * **A picture as a model is shown it**: no longer than `most` pixels on its long side.
 *
 * The planner and the policy check look at the selection through sampling, and a phone photo
 * as a PNG is tens of megabytes of base64 — past the 10 MB a single message to core may be,
 * which closed the plugin's connection rather than failing the one request. Vision models
 * read around a thousand pixels anyway. The full picture still goes to the renderer.
 *
 * Takes and answers base64 PNG; anything already small enough comes back as it was.
 */
export function forModel(base64, most = 1024) {
  const png = Buffer.from(base64, 'base64')
  const { width, height } = header(png)
  if (Math.max(width, height) <= most) return base64
  const image = decode(png)
  const plan = resizePlan(image, { width: most, height: most }, 'fit')
  return encode(resize(image, plan.drawn, { ...plan, offset: { x: 0, y: 0 } }, Buffer.from([0, 0, 0, 0]))).toString('base64')
}
