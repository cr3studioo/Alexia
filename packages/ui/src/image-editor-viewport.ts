// SPDX-License-Identifier: AGPL-3.0-only

/**
 * **Where a point on the screen is on the picture, and back.**
 *
 * Everything the editor stores — a note's marker, a selection's shape, a crop frame — is in
 * normalized source coordinates (0 to 1 across the upright picture), never in screen pixels. So
 * zoom, pan, a resized window and a reopened editor all land on the same spot. These are pure
 * functions over a small view record, which is what makes that promise testable.
 */

export interface Size { width: number; height: number }
export interface View {
  /** Screen pixels per source pixel. */
  zoom: number
  /** Where the source's top-left corner sits in the stage, in screen pixels. */
  pan: { x: number; y: number }
  stage: Size
  source: Size
}

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 16

/** The whole picture, centred, as large as the stage allows. */
export function fit(source: Size, stage: Size, margin = 16): View {
  const zoom = clamp(Math.min((stage.width - margin * 2) / source.width, (stage.height - margin * 2) / source.height), MIN_ZOOM, MAX_ZOOM)
  return { zoom, pan: { x: (stage.width - source.width * zoom) / 2, y: (stage.height - source.height * zoom) / 2 }, stage, source }
}

/** A stage point to normalized source coordinates; null when it is off the picture. */
export function toSource(view: View, point: { x: number; y: number }): { x: number; y: number } | null {
  const x = (point.x - view.pan.x) / (view.source.width * view.zoom)
  const y = (point.y - view.pan.y) / (view.source.height * view.zoom)
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y }
}

/** Normalized source coordinates to a stage point. */
export function toStage(view: View, point: { x: number; y: number }): { x: number; y: number } {
  return { x: view.pan.x + point.x * view.source.width * view.zoom, y: view.pan.y + point.y * view.source.height * view.zoom }
}

/** Zoom by `factor`, keeping the source point under `at` where it is. */
export function zoomAt(view: View, factor: number, at: { x: number; y: number }): View {
  const zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM)
  const k = zoom / view.zoom
  return { ...view, zoom, pan: { x: at.x - (at.x - view.pan.x) * k, y: at.y - (at.y - view.pan.y) * k } }
}

export const panBy = (view: View, dx: number, dy: number): View => ({ ...view, pan: { x: view.pan.x + dx, y: view.pan.y + dy } })

/** The same source rectangle after the stage changed size: the centre stays the centre. */
export function resized(view: View, stage: Size): View {
  const centre = { x: (view.stage.width / 2 - view.pan.x) / view.zoom, y: (view.stage.height / 2 - view.pan.y) / view.zoom }
  return { ...view, stage, pan: { x: stage.width / 2 - centre.x * view.zoom, y: stage.height / 2 - centre.y * view.zoom } }
}

/**
 * The pixel rectangle a normalized crop keeps — **the same rule the editor's backend applies
 * to make the crop**, and a test compares the two, so the frame shown is the picture made.
 */
export function cropRect(source: Size, rect: { x: number; y: number; width: number; height: number }): { left: number; top: number; width: number; height: number } {
  const left = clamp(Math.round(rect.x * source.width), 0, source.width - 1)
  const top = clamp(Math.round(rect.y * source.height), 0, source.height - 1)
  const right = clamp(Math.round((rect.x + rect.width) * source.width), left + 1, source.width)
  const bottom = clamp(Math.round((rect.y + rect.height) * source.height), top + 1, source.height)
  return { left, top, width: right - left, height: bottom - top }
}

/** The largest centred rectangle of an aspect ratio inside the picture, normalized. */
export function aspectRect(source: Size, ratio: number | null): { x: number; y: number; width: number; height: number } {
  if (ratio === null) return { x: 0, y: 0, width: 1, height: 1 }
  const native = source.width / source.height
  const width = ratio >= native ? 1 : ratio / native
  const height = ratio >= native ? native / ratio : 1
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height }
}

/** Fit or fill placement, the backend's `resizePlan` rule: no stretching either way. */
export function resizePlan(source: Size, target: Size, mode: 'fit' | 'fill'): { drawn: Size; padded: boolean; cropped: boolean; upscaled: boolean } {
  const scale = mode === 'fit' ? Math.min(target.width / source.width, target.height / source.height) : Math.max(target.width / source.width, target.height / source.height)
  const drawn = { width: Math.max(1, Math.round(source.width * scale)), height: Math.max(1, Math.round(source.height * scale)) }
  return {
    drawn,
    padded: mode === 'fit' && (drawn.width < target.width || drawn.height < target.height),
    cropped: mode === 'fill' && (drawn.width > target.width || drawn.height > target.height),
    upscaled: scale > 1,
  }
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
