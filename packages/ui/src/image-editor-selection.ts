// SPDX-License-Identifier: AGPL-3.0-only
import type { Draft, EditorApi, RegionNote } from './image-editor-api.js'
import { toStage, type View } from './image-editor-viewport.js'
import { el } from './widgets.js'

/**
 * **Point notes and the areas they change** (A08's half of the editor screen).
 *
 * A tap places a numbered note with a visible circle around it — a starting guess, never an
 * exact boundary. The person refines it with a brush or a rectangle, adding or taking away, and
 * the backend draws the one effective mask that will be used: it comes back as a picture and is
 * shown tinted over the image, feathering included. Generating needs every active note to have
 * words, an area, and a tick on *The area looks right*.
 *
 * Every note is also a row in a numbered list with its own fields, so nothing here needs a
 * pointer: a rectangle can be typed in as percentages, and the list is in the order the notes
 * will be applied.
 */

export type Shape =
  | { mode: 'add' | 'subtract'; shape: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { mode: 'add' | 'subtract'; shape: 'rect'; x: number; y: number; width: number; height: number }
  | { mode: 'add' | 'subtract'; shape: 'brush'; points: { x: number; y: number }[]; radius: number }

export interface SelectionHost {
  api: EditorApi
  draft(): Draft
  /** Saves the draft as one undoable step and answers what was saved. */
  commit(label: string, next: Draft): Promise<Draft>
  redraw(): void
  say(text: string): void
}

export interface Selection {
  /** A tap on the picture, in source coordinates. */
  tap(point: { x: number; y: number }): void
  /** A finished brush stroke or rectangle drag, in source coordinates. */
  stroke(points: { x: number; y: number }[]): void
  /** The brush or rectangle currently chosen, for the stage to draw while dragging. */
  readonly tool: { shape: 'brush' | 'rect'; mode: 'add' | 'subtract'; size: number; feather: number }
  draw(context: CanvasRenderingContext2D, view: View): void
  render(): void
}

const TAP = 0.06
const MOST = 8
const ACCENT = [64, 132, 255] as const

export function mountSelection(panel: HTMLElement, host: SelectionHost, operation: () => 'inpaint' | 'remove_fill'): Selection {
  panel.classList.add('image-editor-selection')
  const shapes = new Map<string, Shape[]>()
  const tints = new Map<string, { sha: string; bitmap: ImageBitmap | HTMLCanvasElement }>()
  let active: string | undefined
  const tool: Selection['tool'] = { shape: 'brush', mode: 'add', size: 0.03, feather: 4 }

  const notes = (): RegionNote[] => host.draft().regions
  const newId = (): string => `note_${Math.random().toString(36).slice(2, 10)}`

  async function remask(noteId: string): Promise<void> {
    const draft = host.draft()
    const drawn = shapes.get(noteId) ?? []
    if (drawn.length === 0) return
    try {
      const done = await host.api.command({ type: 'mask', draftId: draft.id, revision: draft.revision, regionId: noteId, shapes: drawn, featherPixels: tool.feather })
      if (done.draft) await host.commit('Change the selected area', done.draft)
      const url = done.exports[0]?.url
      const note = done.draft?.regions.find((r) => r.id === noteId)
      if (url && note?.mask) {
        const blob = await host.api.file(url)
        tints.set(noteId, { sha: note.mask.sha256, bitmap: await tint(blob) })
      }
      host.redraw()
    } catch (error) {
      host.say(error instanceof Error ? error.message : String(error))
    }
  }

  async function addAt(point: { x: number; y: number }): Promise<void> {
    const draft = host.draft()
    if (draft.regions.filter((r) => r.enabled).length >= MOST) {
      host.say(`At most ${String(MOST)} notes can be applied at once.`)
      return
    }
    const id = newId()
    const note: RegionNote = { id, sourceVersionId: draft.source.versionId, point, instruction: '', enabled: true, reviewed: false, stale: false, mask: null }
    shapes.set(id, [{ mode: 'add', shape: 'ellipse', cx: point.x, cy: point.y, rx: TAP, ry: TAP }])
    active = id
    await host.commit('Add a note', { ...draft, operation: operation(), regions: [...draft.regions, note] })
    await remask(id)
    render()
    panel.querySelector<HTMLTextAreaElement>(`[data-note="${id}"] textarea`)?.focus()
  }

  const update = async (id: string, change: Partial<RegionNote>, label: string): Promise<void> => {
    const draft = host.draft()
    await host.commit(label, { ...draft, regions: draft.regions.map((r) => (r.id === id ? { ...r, ...change } : r)) })
    render()
    host.redraw()
  }

  function render(): void {
    panel.replaceChildren()
    const head = el('div', 'image-editor-tools')
    const choose = (label: string, pressed: boolean, press: () => void): HTMLButtonElement => {
      const b = el('button', 'quiet-button', label)
      b.type = 'button'
      b.setAttribute('aria-pressed', String(pressed))
      b.addEventListener('click', () => {
        press()
        render()
      })
      return b
    }
    head.append(
      choose('Brush', tool.shape === 'brush', () => (tool.shape = 'brush')),
      choose('Rectangle', tool.shape === 'rect', () => (tool.shape = 'rect')),
      choose('Add', tool.mode === 'add', () => (tool.mode = 'add')),
      choose('Take away', tool.mode === 'subtract', () => (tool.mode = 'subtract')),
    )
    const size = labelled('Brush size', range(1, 15, Math.round(tool.size * 100), (v) => (tool.size = v / 100)))
    const feather = labelled('Soft edge', range(0, 32, tool.feather, (v) => {
      tool.feather = v
      if (active) void remask(active)
    }))
    const add = el('button', 'quiet-button', 'Add a note in the middle')
    add.type = 'button'
    add.addEventListener('click', () => void addAt({ x: 0.5, y: 0.5 }))
    const hint = el('p', 'image-editor-hint', operation() === 'remove_fill' ?
      'Tap what should go, then brush over all of it. The area is filled in to match its surroundings.' :
      'Tap the picture to place a note, then brush to fit the area. A tap is a starting circle, not an exact outline.')
    panel.append(hint, head, size, feather, add)

    const list = el('ol', 'image-editor-notes')
    list.setAttribute('aria-label', 'Notes, in the order they are applied')
    for (const [i, note] of notes().entries()) list.append(row(note, i + 1))
    panel.append(list)
    const active_ = notes().filter((n) => n.enabled)
    if (active_.length > 0) {
      panel.append(el('p', 'image-editor-hint', `Each version applies ${String(active_.length)} ${active_.length === 1 ? 'note' : 'notes'} one after another — ${String(active_.length)} ${active_.length === 1 ? 'pass' : 'passes'} per version.`))
    }
  }

  function row(note: RegionNote, n: number): HTMLLIElement {
    const item = el('li', 'image-editor-note')
    item.dataset.note = note.id
    if (note.id === active) item.classList.add('active')
    const title = el('button', 'image-editor-note-title', `Note ${String(n)}${note.stale ? ' — placed on another version' : ''}`)
    title.type = 'button'
    title.addEventListener('click', () => {
      active = note.id
      render()
      host.redraw()
    })
    const words = el('textarea')
    words.rows = 2
    words.maxLength = 600
    words.value = note.instruction
    words.placeholder = operation() === 'remove_fill' ? 'Optional: what should fill it' : 'What should change here — "make this blue"'
    words.setAttribute('aria-label', `What note ${String(n)} should change`)
    words.addEventListener('change', () => void update(note.id, { instruction: words.value }, 'Change a note'))

    const on = checkbox(`Use note ${String(n)}`, note.enabled, (v) => void update(note.id, { enabled: v }, v ? 'Turn a note on' : 'Turn a note off'))
    const looked = checkbox('The area looks right', note.reviewed, (v) => void update(note.id, { reviewed: v }, 'Check an area'))
    looked.querySelector('input')!.disabled = note.mask === null || note.stale

    // The keyboard path: a rectangle typed in, as percentages of the picture.
    const rect = el('details', 'image-editor-rect')
    rect.append(el('summary', undefined, 'Type an area instead'))
    const fields = ['Left', 'Top', 'Width', 'Height'].map((label, i) => {
      const input = el('input')
      input.type = 'number'
      input.min = '0'
      input.max = '100'
      input.value = String([25, 25, 50, 50][i])
      input.setAttribute('aria-label', `${label}, percent`)
      return input
    })
    const use = el('button', 'quiet-button', 'Use this area')
    use.type = 'button'
    use.addEventListener('click', () => {
      const [x, y, w, h] = fields.map((f) => Math.min(100, Math.max(0, Number(f.value) || 0)) / 100)
      shapes.set(note.id, [{ mode: 'add', shape: 'rect', x: x!, y: y!, width: Math.min(w!, 1 - x!), height: Math.min(h!, 1 - y!) }])
      active = note.id
      void remask(note.id)
    })
    rect.append(...fields, use)

    const remove = el('button', 'quiet-button', 'Delete')
    remove.type = 'button'
    remove.addEventListener('click', () => {
      const draft = host.draft()
      shapes.delete(note.id)
      tints.delete(note.id)
      void host.commit('Delete a note', { ...draft, regions: draft.regions.filter((r) => r.id !== note.id) }).then(() => {
        render()
        host.redraw()
      })
    })
    item.append(title, words, on, looked, rect, remove)
    if (note.stale) item.append(el('p', 'image-editor-hint', 'Place this note again on this version — its words are kept.'))
    return item
  }

  return {
    tool,
    tap: (point) => void addAt(point),
    stroke(points) {
      if (!active || points.length === 0) {
        host.say('Tap the picture to place a note first.')
        return
      }
      const list = shapes.get(active) ?? []
      if (tool.shape === 'rect') {
        const xs = points.map((p) => p.x)
        const ys = points.map((p) => p.y)
        const x = Math.min(...xs)
        const y = Math.min(...ys)
        list.push({ mode: tool.mode, shape: 'rect', x, y, width: Math.max(0.001, Math.max(...xs) - x), height: Math.max(0.001, Math.max(...ys) - y) })
      } else {
        list.push({ mode: tool.mode, shape: 'brush', points: points.slice(0, 2000), radius: tool.size })
      }
      shapes.set(active, list)
      void remask(active)
    },
    draw(context, view) {
      for (const [i, note] of notes().entries()) {
        const tinted = tints.get(note.id)
        if (tinted && note.mask && tinted.sha === note.mask.sha256 && note.enabled) {
          const at = toStage(view, { x: 0, y: 0 })
          context.globalAlpha = note.id === active ? 0.55 : 0.3
          context.drawImage(tinted.bitmap, at.x, at.y, view.source.width * view.zoom, view.source.height * view.zoom)
          context.globalAlpha = 1
        }
        const p = toStage(view, note.point)
        context.beginPath()
        context.arc(p.x, p.y, 13, 0, Math.PI * 2)
        context.fillStyle = note.enabled ? `rgb(${ACCENT.join(',')})` : 'rgba(120,120,120,0.9)'
        context.fill()
        context.lineWidth = 2
        context.strokeStyle = '#fff'
        context.stroke()
        context.fillStyle = '#fff'
        context.font = '600 13px system-ui, sans-serif'
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.fillText(String(i + 1), p.x, p.y + 0.5)
      }
    },
    render,
  }
}

/** A grey mask as a translucent accent layer: white shows, black does not. */
async function tint(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d')!
  context.drawImage(bitmap, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  for (let i = 0; i < pixels.data.length; i += 4) {
    const v = pixels.data[i]!
    pixels.data[i] = ACCENT[0]
    pixels.data[i + 1] = ACCENT[1]
    pixels.data[i + 2] = ACCENT[2]
    pixels.data[i + 3] = v
  }
  context.putImageData(pixels, 0, 0)
  bitmap.close()
  return canvas
}

function checkbox(label: string, checked: boolean, change: (value: boolean) => void): HTMLLabelElement {
  const box = el('label', 'image-editor-check')
  const input = el('input')
  input.type = 'checkbox'
  input.checked = checked
  input.addEventListener('change', () => change(input.checked))
  box.append(input, document.createTextNode(` ${label}`))
  return box
}

function range(min: number, max: number, value: number, change: (value: number) => void): HTMLInputElement {
  const input = el('input')
  input.type = 'range'
  input.min = String(min)
  input.max = String(max)
  input.value = String(value)
  input.addEventListener('change', () => change(Number(input.value)))
  return input
}

export function labelled(label: string, control: HTMLElement): HTMLLabelElement {
  const box = el('label', 'image-editor-field')
  box.append(el('span', undefined, label), control)
  return box
}
