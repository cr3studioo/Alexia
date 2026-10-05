// SPDX-License-Identifier: AGPL-3.0-only
import type { Draft, EditorApi, Version } from './image-editor-api.js'
import { labelled } from './image-editor-selection.js'
import { aspectRect, cropRect, resizePlan, toStage, type View } from './image-editor-viewport.js'
import { el } from './widgets.js'

/**
 * **Crop, resize, erase to transparency, and export** (A09's half of the editor screen).
 *
 * None of these needs a model, so they work with nothing installed. The frame drawn on the
 * picture and the sizes written under it come from the same rounding rule the backend uses, so
 * what is shown is what is made. Applying one makes a new version; the original is untouched.
 */

export interface TransformHost {
  api: EditorApi
  draft(): Draft
  commit(label: string, next: Draft): Promise<Draft>
  /** Run the draft's transform now, as a new version. */
  apply(): Promise<void>
  redraw(): void
  say(text: string): void
}

const ASPECTS: [string, number | null][] = [['Original', null], ['1:1', 1], ['4:5', 4 / 5], ['3:2', 3 / 2], ['16:9', 16 / 9]]

export interface Transforms {
  /** A drag on the picture while cropping: the new frame, in source coordinates. */
  drag(points: { x: number; y: number }[]): void
  draw(context: CanvasRenderingContext2D, view: View): void
  render(): void
}

export function mountTransforms(panel: HTMLElement, host: TransformHost): Transforms {
  panel.classList.add('image-editor-transforms')
  let kind: 'crop' | 'resize' | 'erase_alpha' = 'crop'
  let ratio: number | null = null
  let rect = { x: 0, y: 0, width: 1, height: 1 }
  let size = { width: 0, height: 0 }
  let lock = true
  let fit: 'fit' | 'fill' = 'fit'
  let background = '#00000000'

  const source = (): { width: number; height: number } => host.draft().source.dimensions

  const transform = (): Draft['transform'] => {
    if (kind === 'crop') return { kind: 'crop', rect }
    if (kind === 'resize') return { kind: 'resize', dimensions: size, fit, background }
    const note = host.draft().regions.find((r) => r.enabled && r.mask && !r.stale)
    return note?.mask ? { kind: 'erase_alpha', maskId: note.mask.id } : null
  }

  async function apply(): Promise<void> {
    const draft = host.draft()
    const next = transform()
    if (!next) {
      host.say('Select the area to erase first: use Point edits to place a note and brush over it.')
      return
    }
    await host.commit(kind === 'crop' ? 'Set a crop' : kind === 'resize' ? 'Set a size' : 'Set an area to erase', { ...draft, operation: kind, transform: next })
    await host.apply()
  }

  function render(): void {
    const dims = source()
    if (size.width === 0) size = { ...dims }
    panel.replaceChildren()
    const tabs = el('div', 'image-editor-tools')
    for (const [value, label] of [['crop', 'Crop'], ['resize', 'Resize'], ['erase_alpha', 'Erase to transparency']] as const) {
      const b = el('button', 'quiet-button', label)
      b.type = 'button'
      b.setAttribute('aria-pressed', String(kind === value))
      b.addEventListener('click', () => {
        kind = value
        render()
        host.redraw()
      })
      tabs.append(b)
    }
    panel.append(tabs)

    if (kind === 'crop') {
      const pick = el('select')
      for (const [label, value] of ASPECTS) {
        const option = el('option', undefined, label)
        option.value = String(value ?? '')
        option.selected = value === ratio
        pick.append(option)
      }
      pick.addEventListener('change', () => {
        ratio = pick.value === '' ? null : Number(pick.value)
        rect = aspectRect(dims, ratio)
        render()
        host.redraw()
      })
      const kept = cropRect(dims, rect)
      panel.append(
        labelled('Shape', pick),
        el('p', 'image-editor-hint', `Drag on the picture to frame it. Keeps ${String(kept.width)} × ${String(kept.height)} pixels.`),
      )
    } else if (kind === 'resize') {
      const w = number(size.width, (v) => {
        size = { width: v, height: lock ? Math.max(1, Math.round((v * dims.height) / dims.width)) : size.height }
        render()
      })
      const h = number(size.height, (v) => {
        size = { width: lock ? Math.max(1, Math.round((v * dims.width) / dims.height)) : size.width, height: v }
        render()
      })
      const locked = el('label', 'image-editor-check')
      const box = el('input')
      box.type = 'checkbox'
      box.checked = lock
      box.addEventListener('change', () => (lock = box.checked))
      locked.append(box, document.createTextNode(' Keep the shape'))
      const mode = el('select')
      for (const [value, label] of [['fit', 'Fit inside, adding space'], ['fill', 'Fill, trimming the edges']] as const) {
        const option = el('option', undefined, label)
        option.value = value
        option.selected = fit === value
        mode.append(option)
      }
      mode.addEventListener('change', () => {
        fit = mode.value as 'fit' | 'fill'
        render()
      })
      const fill = el('select')
      for (const [value, label] of [['#00000000', 'Transparent'], ['#ffffffff', 'White'], ['#000000ff', 'Black']] as const) {
        const option = el('option', undefined, label)
        option.value = value
        option.selected = background === value
        fill.append(option)
      }
      fill.addEventListener('change', () => (background = fill.value))
      const plan = resizePlan(dims, size, fit)
      const notes = [
        plan.padded ? 'Space is added around it.' : '',
        plan.cropped ? 'Some of the edges are trimmed.' : '',
        plan.upscaled ? 'Making it bigger does not add detail that was not there.' : '',
      ].filter(Boolean).join(' ')
      panel.append(labelled('Width', w), labelled('Height', h), locked, labelled('How', mode), ...(fit === 'fit' ? [labelled('Added space', fill)] : []), el('p', 'image-editor-hint', notes || 'Nothing is stretched.'))
    } else {
      const note = host.draft().regions.find((r) => r.enabled && r.mask && !r.stale)
      panel.append(el('p', 'image-editor-hint', note ?
        'The area of your first active note becomes transparent, with its soft edge. Save as PNG to keep the transparency.' :
        'Use Point edits to place a note and brush over what should become transparent, then come back here.'))
    }
    const go = el('button', 'primary-button', kind === 'crop' ? 'Crop' : kind === 'resize' ? 'Resize' : 'Erase')
    go.type = 'button'
    go.addEventListener('click', () => void apply())
    panel.append(go, el('p', 'image-editor-hint', 'This makes a new version. The original stays as it is.'))
  }

  return {
    drag(points) {
      if (kind !== 'crop' || points.length < 2) return
      const dims = source()
      const a = points[0]!
      const b = points[points.length - 1]!
      let width = Math.abs(b.x - a.x)
      let height = Math.abs(b.y - a.y)
      if (ratio !== null) {
        // Held to the chosen shape, in pixels rather than in fractions.
        const px = width * dims.width
        height = Math.min(1, px / ratio / dims.height)
        width = (height * dims.height * ratio) / dims.width
      }
      const x = Math.max(0, Math.min(b.x < a.x ? a.x - width : a.x, 1 - width))
      const y = Math.max(0, Math.min(b.y < a.y ? a.y - height : a.y, 1 - height))
      if (width > 0.005 && height > 0.005) rect = { x, y, width, height }
      render()
      host.redraw()
    },
    draw(context, view) {
      if (kind !== 'crop') return
      const tl = toStage(view, { x: rect.x, y: rect.y })
      const br = toStage(view, { x: rect.x + rect.width, y: rect.y + rect.height })
      const all = { a: toStage(view, { x: 0, y: 0 }), b: toStage(view, { x: 1, y: 1 }) }
      context.fillStyle = 'rgba(0,0,0,0.45)'
      context.beginPath()
      context.rect(all.a.x, all.a.y, all.b.x - all.a.x, all.b.y - all.a.y)
      context.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y)
      context.fill('evenodd')
      context.strokeStyle = '#fff'
      context.lineWidth = 1.5
      context.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y)
    },
    render,
  }
}

function number(value: number, change: (value: number) => void): HTMLInputElement {
  const input = el('input')
  input.type = 'number'
  input.min = '1'
  input.max = '16384'
  input.value = String(value)
  input.addEventListener('change', () => change(Math.max(1, Math.min(16384, Math.round(Number(input.value) || 1)))))
  return input
}

/**
 * **Saving chosen versions to the person's disk.** PNG keeps every pixel and any transparency.
 * JPEG and WebP are encoded here, in the window, from the lossless pixels the backend prepared —
 * and a transparent picture going to JPEG needs a background colour chosen first.
 */
export async function exportVersions(api: EditorApi, versions: Version[], format: 'png' | 'jpeg' | 'webp', background: string | null): Promise<void> {
  const done = await api.command({ type: 'export', versionIds: versions.map((v) => v.source.versionId), format, background })
  for (const one of done.exports) {
    let blob = await api.file(one.url)
    if (format !== 'png') {
      const bitmap = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
      bitmap.close()
      blob = await canvas.convertToBlob({ type: format === 'jpeg' ? 'image/jpeg' : 'image/webp', quality: 0.92 })
    }
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = one.name
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
  }
}
