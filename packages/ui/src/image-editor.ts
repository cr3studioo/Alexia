// SPDX-License-Identifier: AGPL-3.0-only
import {
  editorApi, EditorError, reasonText,
  type Batch, type Candidate, type Draft, type EditorApi, type EditorEvent, type Picture, type Profile, type Version,
} from './image-editor-api.js'
import { labelled, mountSelection, type Selection } from './image-editor-selection.js'
import { exportVersions, mountTransforms, type Transforms } from './image-editor-transforms.js'
import { fit, panBy, resized, toSource, zoomAt, type View } from './image-editor-viewport.js'
import { modal } from './modal.js'
import { el } from './widgets.js'

/**
 * **The image editor** (A07): the picture first, the tools beside it, the versions under it.
 *
 * It holds no history of its own. Drafts, versions and batches live in the media plugin and are
 * read back on every open, so a reload, a second window or a restart shows the same state; what
 * this keeps is the screen — the zoom, the tool, an undo list of drafts this session saved.
 * Every generation goes through the same backend a chat request does, with the same checks.
 *
 * Disabled actions say why beside them, and an unavailable model stays in the list with its
 * reason: nothing is chosen, switched or adjusted for the person behind their back.
 */

type Tool = 'whole' | 'point' | 'remove' | 'crop'
const TOOLS: [Tool, string][] = [['whole', 'Whole image'], ['point', 'Point edits'], ['remove', 'Remove'], ['crop', 'Crop / Resize']]

export interface EditorOptions {
  token: string
  conversationId: string
  /** Start on this picture; absent shows the conversation's pictures to choose from. */
  attachmentId?: string
  /** Everything behind the editor, made inert while it is open. */
  behind: () => HTMLElement[]
  onClose?: () => void
  fetcher?: typeof fetch
}

export async function openImageEditor(options: EditorOptions): Promise<void> {
  const api = editorApi(options.token, options.conversationId, options.fetcher)
  const sheet = el('div', 'image-editor')
  sheet.setAttribute('aria-labelledby', 'image-editor-heading')
  document.body.append(sheet)
  const dialog = modal(sheet, options.behind)
  const close = (): void => {
    dialog.close()
    sheet.remove()
    options.onClose?.()
  }
  sheet.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close()
  })
  const heading = el('h2', 'image-editor-heading', 'Edit a picture')
  heading.id = 'image-editor-heading'
  sheet.append(heading)
  dialog.open(heading)

  const start = options.attachmentId ?? (await choose(api, sheet, close))
  if (start === undefined) return
  try {
    sheet.replaceChildren(heading, el('p', 'image-editor-hint', 'Opening the picture…'))
    const draft = await openDraft(api, start)
    sheet.replaceChildren()
    workspace(sheet, api, draft, close, heading)
  } catch (error) {
    sheet.replaceChildren(heading, el('p', 'image-editor-error', error instanceof Error ? error.message : String(error)))
    const back = el('button', 'quiet-button', 'Close')
    back.type = 'button'
    back.addEventListener('click', close)
    sheet.append(back)
  }
}

/** The conversation's pictures, and a way to add one. Answers the chosen attachment. */
async function choose(api: EditorApi, sheet: HTMLElement, close: () => void): Promise<string | undefined> {
  const { pictures } = await api.call<{ pictures: Picture[] }>('pictures')
  return new Promise((resolve) => {
    const grid = el('div', 'image-editor-choose')
    const done = (id: string | undefined): void => {
      grid.remove()
      if (id === undefined) close()
      resolve(id)
    }
    const remembered = read(`alexia-editor-draft-${api.conversationId}`)
    if (remembered) {
      const resume = el('button', 'primary-button', 'Continue the last edit')
      resume.type = 'button'
      resume.addEventListener('click', () => done(`draft:${remembered}`))
      grid.append(resume)
    }
    for (const picture of pictures) {
      const b = el('button', 'image-editor-thumb')
      b.type = 'button'
      b.setAttribute('aria-label', `Edit ${picture.label}, ${picture.displayName}`)
      const img = el('img')
      img.alt = ''
      void api.picture(picture.id).then((blob) => (img.src = URL.createObjectURL(blob))).catch(() => undefined)
      b.append(img, el('span', undefined, `${picture.label.replace('_', ' ')} · ${picture.displayName}`))
      b.addEventListener('click', () => done(picture.id))
      grid.append(b)
    }
    const add = el('label', 'quiet-button image-editor-add', 'Add a picture…')
    const input = el('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp'
    input.hidden = true
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      void upright(file).then((png) => api.upload(file.name.replace(/\.[^.]+$/, '') + '.png', png)).then((p) => done(p.id))
        .catch((error: unknown) => grid.append(el('p', 'image-editor-error', error instanceof Error ? error.message : String(error))))
    })
    add.append(input)
    const cancel = el('button', 'quiet-button', 'Close')
    cancel.type = 'button'
    cancel.addEventListener('click', () => done(undefined))
    grid.append(add, cancel)
    if (pictures.length === 0) grid.prepend(el('p', 'image-editor-hint', 'No pictures in this conversation yet. Add one to start.'))
    sheet.append(grid)
  })
}

/**
 * A picture as the editor works on it: upright and lossless. A JPEG or WebP is turned upright by
 * the browser (it reads EXIF orientation), drawn, and kept as a new PNG in the conversation;
 * the original stays as it was.
 */
async function openDraft(api: EditorApi, start: string): Promise<Draft> {
  if (start.startsWith('draft:')) return (await api.call<{ draft: Draft }>('loadDraft', { draftId: start.slice(6) })).draft
  const { pictures } = await api.call<{ pictures: Picture[] }>('pictures')
  let id = start
  const picture = pictures.find((p) => p.id === start)
  if (picture && picture.mime !== 'image/png') {
    const png = await upright(await api.picture(start))
    id = (await api.upload(`${picture.displayName.replace(/\.[^.]+$/, '')}.png`, png, start)).id
  }
  const { draft } = await api.call<{ draft: Draft }>('open', { attachmentId: id })
  write(`alexia-editor-draft-${api.conversationId}`, draft.id)
  return draft
}

async function upright(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  bitmap.close()
  return canvas.convertToBlob({ type: 'image/png' })
}

function workspace(sheet: HTMLElement, api: EditorApi, first: Draft, close: () => void, heading: HTMLElement): void {
  let draft = first
  let tool: Tool = draft.operation === 'remove_fill' ? 'remove' : draft.operation === 'inpaint' ? 'point' : ['crop', 'resize', 'erase_alpha'].includes(draft.operation) ? 'crop' : 'whole'
  let profiles: Profile[] = []
  let versions: Version[] = []
  let pictures: Picture[] = []
  let batch: Batch | undefined
  let sequence = -1
  let question: string | undefined
  let compareWith: string | undefined
  let message = ''
  const undo: { label: string; draft: Draft }[] = []
  const redo: { label: string; draft: Draft }[] = []
  const bitmaps = new Map<string, Promise<ImageBitmap>>()
  const thumbs = new Map<string, Promise<string>>()

  // ---- layout ----------------------------------------------------------------------------
  const bar = el('header', 'image-editor-bar')
  const title = el('span', 'image-editor-version')
  const undoButton = button('Undo', () => void step(undo, redo))
  const redoButton = button('Redo', () => void step(redo, undo))
  const compareButton = button('Compare', () => {
    compareWith = compareWith === undefined ? (versions.find((v) => v.source.versionId !== draft.source.versionId)?.source.versionId) : undefined
    if (compareWith === undefined && versions.length < 2) say('There is nothing to compare with yet.')
    paint()
  })
  const exportButton = button('Export', () => exportDialog())
  const forgetButton = button('Forget pictures', () => void forget())
  const closeButton = button('Close', close)
  heading.textContent = 'Edit a picture'
  bar.append(heading, title, undoButton, redoButton, compareButton, exportButton, forgetButton, closeButton)

  const rail = el('nav', 'image-editor-rail')
  rail.setAttribute('aria-label', 'Editing tools')
  const stage = el('div', 'image-editor-stage')
  const canvas = el('canvas')
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', 'The picture being edited')
  canvas.tabIndex = 0
  stage.append(canvas)
  const side = el('aside', 'image-editor-side')
  const toolPanel = el('section', 'image-editor-panel')
  const genPanel = el('section', 'image-editor-generate')
  side.append(toolPanel, genPanel)
  const strip = el('div', 'image-editor-strip')
  strip.setAttribute('aria-label', 'Versions')
  const line = el('p', 'image-editor-line')
  line.setAttribute('role', 'status')
  sheet.append(bar, rail, stage, side, strip, line)

  const say = (text: string): void => {
    message = text
    line.textContent = text
  }

  // ---- drafts ------------------------------------------------------------------------------
  /** One user operation, saved with the revision it started from, and one undo entry. */
  async function commit(label: string, next: Draft): Promise<Draft> {
    let saved = next
    try {
      if (next.revision <= draft.revision) {
        saved = (await api.command({ type: 'save', draft: { ...next, revision: draft.revision }, expectedRevision: draft.revision })).draft ?? next
      }
    } catch (error) {
      say(error instanceof Error ? error.message : String(error))
      throw error
    }
    undo.push({ label, draft })
    redo.length = 0
    draft = saved
    refresh()
    return saved
  }
  async function step(from: typeof undo, to: typeof undo): Promise<void> {
    const back = from.pop()
    if (!back) return
    try {
      const saved = (await api.command({ type: 'save', draft: { ...back.draft, revision: draft.revision }, expectedRevision: draft.revision })).draft
      to.push({ label: back.label, draft })
      if (saved) draft = saved
      say(`${from === undo ? 'Undid' : 'Redid'}: ${back.label}`)
      refresh()
      paint()
    } catch (error) {
      say(error instanceof Error ? error.message : String(error))
    }
  }

  // ---- the stage ---------------------------------------------------------------------------
  let view: View = fit(draft.source.dimensions, { width: 800, height: 600 })
  const bitmap = (versionId: string): Promise<ImageBitmap> => {
    const v = versions.find((x) => x.source.versionId === versionId)?.source ?? (versionId === draft.source.versionId ? draft.source : undefined)
    if (!v) return Promise.reject(new Error('That version is gone.'))
    if (!bitmaps.has(versionId)) bitmaps.set(versionId, api.picture(v.attachmentId).then((b) => createImageBitmap(b)))
    return bitmaps.get(versionId)!
  }
  const sizeStage = (): void => {
    const box = stage.getBoundingClientRect()
    const scale = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(box.width * scale))
    canvas.height = Math.max(1, Math.round(box.height * scale))
    canvas.style.width = `${String(box.width)}px`
    canvas.style.height = `${String(box.height)}px`
    view = resized({ ...view, source: draft.source.dimensions }, { width: box.width, height: box.height })
  }
  async function paint(): Promise<void> {
    const context = canvas.getContext('2d')
    if (!context) return
    const scale = window.devicePixelRatio || 1
    context.setTransform(scale, 0, 0, scale, 0, 0)
    context.clearRect(0, 0, view.stage.width, view.stage.height)
    const at = { x: view.pan.x, y: view.pan.y, w: draft.source.dimensions.width * view.zoom, h: draft.source.dimensions.height * view.zoom }
    checker(context, at)
    try {
      const shown = await bitmap(draft.source.versionId)
      context.drawImage(shown, at.x, at.y, at.w, at.h)
      if (compareWith !== undefined) {
        // The other version at the same zoom and place, on the right half: a matched comparison.
        const other = await bitmap(compareWith)
        context.save()
        context.beginPath()
        context.rect(view.stage.width / 2, 0, view.stage.width / 2, view.stage.height)
        context.clip()
        context.clearRect(view.stage.width / 2, 0, view.stage.width / 2, view.stage.height)
        checker(context, at)
        context.drawImage(other, at.x, at.y, at.w, at.h)
        context.restore()
        context.fillStyle = '#fff'
        context.fillRect(view.stage.width / 2 - 1, 0, 2, view.stage.height)
      }
    } catch {
      say('This version could not be shown.')
    }
    if (tool === 'point' || tool === 'remove') selection.draw(context, view)
    if (tool === 'crop') transforms.draw(context, view)
  }

  // Pointer: a tap places a note, a drag paints or frames, two fingers or the space bar pan and zoom.
  const pointers = new Map<number, { x: number; y: number }>()
  let path: { x: number; y: number }[] = []
  let moved = 0
  let panning = false
  let spaceHeld = false
  const local = (event: PointerEvent | WheelEvent): { x: number; y: number } => {
    const box = canvas.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }
  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId)
    pointers.set(event.pointerId, local(event))
    moved = 0
    panning = pointers.size > 1 || spaceHeld || event.button === 1 || tool === 'whole'
    path = []
    const p = toSource(view, local(event))
    if (p && !panning) path.push(p)
  })
  canvas.addEventListener('pointermove', (event) => {
    const before = pointers.get(event.pointerId)
    if (!before) return
    const now = local(event)
    moved += Math.hypot(now.x - before.x, now.y - before.y)
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      const other = a === before ? b! : a!
      const factor = Math.hypot(now.x - other.x, now.y - other.y) / Math.max(1, Math.hypot(before.x - other.x, before.y - other.y))
      view = zoomAt(view, factor, { x: (now.x + other.x) / 2, y: (now.y + other.y) / 2 })
      path = []
    } else if (panning) {
      view = panBy(view, now.x - before.x, now.y - before.y)
    } else {
      const p = toSource(view, now)
      if (p) path.push(p)
    }
    pointers.set(event.pointerId, now)
    void paint()
  })
  canvas.addEventListener('pointerup', (event) => {
    const was = pointers.size
    pointers.delete(event.pointerId)
    if (was > 1 || panning) return
    if (moved < 4) {
      const p = toSource(view, local(event))
      if (p && (tool === 'point' || tool === 'remove')) selection.tap(p)
    } else if (tool === 'point' || tool === 'remove') {
      selection.stroke(path)
    } else if (tool === 'crop') {
      transforms.drag(path)
    }
    path = []
  })
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault()
    view = zoomAt(view, event.deltaY < 0 ? 1.1 : 1 / 1.1, local(event))
    void paint()
  }, { passive: false })
  canvas.addEventListener('keydown', (event) => {
    const centre = { x: view.stage.width / 2, y: view.stage.height / 2 }
    const moves: Record<string, () => View> = {
      '+': () => zoomAt(view, 1.2, centre), '=': () => zoomAt(view, 1.2, centre), '-': () => zoomAt(view, 1 / 1.2, centre),
      '0': () => fit(draft.source.dimensions, view.stage),
      ArrowLeft: () => panBy(view, 40, 0), ArrowRight: () => panBy(view, -40, 0), ArrowUp: () => panBy(view, 0, 40), ArrowDown: () => panBy(view, 0, -40),
    }
    if (event.key === ' ') spaceHeld = true
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    view = move()
    void paint()
  })
  canvas.addEventListener('keyup', (event) => {
    if (event.key === ' ') spaceHeld = false
  })
  new ResizeObserver(() => {
    sizeStage()
    void paint()
  }).observe(stage)

  // ---- tools -------------------------------------------------------------------------------
  const selectionPanel = el('div')
  const transformPanel = el('div')
  const selection: Selection = mountSelection(selectionPanel, {
    api, draft: () => draft, commit, redraw: () => void paint(), say,
  }, () => (tool === 'remove' ? 'remove_fill' : 'inpaint'))
  const transforms: Transforms = mountTransforms(transformPanel, {
    api, draft: () => draft, commit, redraw: () => void paint(), say,
    apply: async () => {
      try {
        say('Making a new version…')
        const done = await api.command({ type: 'generate', draftId: draft.id, revision: draft.revision, invocationId: id() })
        if (done.draft) {
          draft = done.draft
          bitmaps.delete(draft.source.versionId)
          view = fit(draft.source.dimensions, view.stage)
        }
        await loadVersions()
        say('Done. The new version is selected; the original is in the strip below.')
        refresh()
        void paint()
      } catch (error) {
        say(error instanceof Error ? error.message : String(error))
      }
    },
  })

  function renderRail(): void {
    rail.replaceChildren()
    for (const [value, label] of TOOLS) {
      const b = button(label, () => {
        tool = value
        compareWith = undefined
        const operation = value === 'point' ? 'inpaint' : value === 'remove' ? 'remove_fill' : value === 'whole' ? 'image_edit' : draft.operation
        if (value !== 'crop' && draft.operation !== operation) void commit(`Use ${label}`, { ...draft, operation, transform: null })
        refresh()
        void paint()
      })
      b.setAttribute('aria-pressed', String(tool === value))
      rail.append(b)
    }
  }

  function renderTool(): void {
    toolPanel.replaceChildren()
    if (tool === 'whole') {
      const words = el('textarea', 'image-editor-prompt')
      words.rows = 4
      words.maxLength = 8000
      words.value = draft.instruction
      words.placeholder = 'Describe the change — "warmer evening lighting", "make it winter"'
      words.setAttribute('aria-label', 'What to change in the whole picture')
      words.addEventListener('change', () => void commit('Change the description', { ...draft, instruction: words.value }))
      toolPanel.append(labelled('Change', words))
      // References: up to two other pictures of this conversation to take things from.
      const others = pictures.filter((p) => p.id !== draft.source.attachmentId)
      if (others.length > 0) {
        const box = el('fieldset', 'image-editor-refs')
        box.append(el('legend', undefined, 'Take things from (up to 2)'))
        for (const p of others) {
          const label = el('label', 'image-editor-check')
          const input = el('input')
          input.type = 'checkbox'
          input.checked = draft.referenceIds.includes(p.id)
          input.disabled = !input.checked && draft.referenceIds.length >= 2
          input.addEventListener('change', () => {
            const ids = input.checked ? [...draft.referenceIds, p.id] : draft.referenceIds.filter((x) => x !== p.id)
            void commit('Change the reference pictures', { ...draft, referenceIds: ids }).then(renderTool)
          })
          label.append(input, document.createTextNode(` ${p.label.replace('_', ' ')} · ${p.displayName}`))
          box.append(label)
        }
        toolPanel.append(box, el('p', 'image-editor-hint', 'Say in the description what to take from each — "the jacket from image 2". Keeping everything else exactly as it was is not guaranteed for a whole-picture change.'))
      }
    } else if (tool === 'point' || tool === 'remove') {
      if (draft.instruction.trim() !== '') {
        toolPanel.append(el('p', 'image-editor-hint', 'There is also a whole-picture change in this draft. Make that first, check the result, then place notes on it.'))
      }
      selection.render()
      toolPanel.append(selectionPanel)
    } else {
      transforms.render()
      toolPanel.append(transformPanel)
    }
  }

  // ---- generating ----------------------------------------------------------------------------
  const chosen = (): Profile | undefined => profiles.find((p) => p.selection.id === draft.profile?.id && p.selection.version === draft.profile?.version)
  function blocked(): string | undefined {
    const profile = chosen()
    if (!draft.profile) return 'Choose a model first.'
    if (!profile) return 'The chosen model is not available any more. Choose another — your draft is kept.'
    if (profile.availability !== 'available') return profile.reason ?? 'This model cannot be used right now.'
    if (!profile.operations.includes(draft.operation)) return `${profile.name} does not support ${tool === 'remove' ? 'removing' : tool === 'point' ? 'selected-area edits' : 'this edit'}.`
    if (1 + draft.referenceIds.length > profile.maxInputs) return `${profile.name} takes at most ${String(profile.maxInputs)} pictures.`
    if (tool === 'whole' && draft.instruction.trim() === '') return 'Describe the change first.'
    if (tool === 'point' || tool === 'remove') {
      const active = draft.regions.filter((r) => r.enabled)
      if (active.length === 0) return 'Place a note on the picture first.'
      if (active.some((r) => r.stale)) return 'Some notes were placed on another version. Place them again.'
      if (active.some((r) => !r.mask)) return 'Every note needs an area.'
      if (active.some((r) => !r.reviewed)) return 'Tick “The area looks right” on every note.'
      if (tool === 'point' && active.some((r) => r.instruction.trim() === '')) return 'Every note needs words.'
    }
    if (!profile.dimensions.some((d) => d.width === draft.settings.dimensions.width && d.height === draft.settings.dimensions.height)) return 'Choose a size this model makes.'
    return undefined
  }

  function renderGenerate(): void {
    genPanel.replaceChildren()
    if (tool === 'crop') return
    if (question !== undefined) {
      const box = el('div', 'image-editor-question')
      const answer = el('input')
      answer.setAttribute('aria-label', 'Your answer')
      const send = button('Answer', () => void clarify(answer.value))
      box.append(el('p', undefined, question), answer, send)
      genPanel.append(box)
    }
    const pick = el('select')
    pick.append(Object.assign(el('option', undefined, profiles.length === 0 ? 'No editing models yet' : 'Choose a model…'), { value: '' }))
    for (const p of profiles) {
      const named = `${p.name}${p.uncensored ? ' (uncensored)' : ''}`
      const option = el('option', undefined, p.availability === 'available' ? named : `${named} — ${p.reason ?? 'not available'}`)
      option.value = `${p.selection.id}@${p.selection.version}`
      option.selected = p.selection.id === draft.profile?.id && p.selection.version === draft.profile?.version
      pick.append(option)
    }
    pick.addEventListener('change', () => {
      const [pid, version] = pick.value.split('@')
      const profile = pid ? { id: pid, version: version! } : null
      const found = profiles.find((p) => p.selection.id === pid && p.selection.version === version)
      const sized = found && !found.dimensions.some((d) => d.width === draft.settings.dimensions.width && d.height === draft.settings.dimensions.height)
      void api.call('select_profile', { profile })
      void commit('Choose a model', { ...draft, profile }).then(() => {
        if (sized) say(`${found.name} makes ${found.dimensions.map((d) => `${String(d.width)}×${String(d.height)}`).join(', ')}. Choose a size below.`)
      })
    })
    genPanel.append(labelled('Model', pick))
    const profile = chosen()
    if (profile) {
      const about = el('p', 'image-editor-hint',
        `Version ${profile.selection.version} · ${profile.operations.map((o) => o.replace('_', ' ')).join(', ')} · up to ${String(profile.maxInputs)} pictures` +
        `${profile.measuredMemory ? ` · needs about ${(profile.measuredMemory.gpuBytes / 1e9).toFixed(1)} GB of graphics memory` : ''}` +
        ` · renders on ${profile.destination.kind === 'paired' ? profile.destination.displayName : 'the computer chosen for pictures'}`)
      genPanel.append(about)
      const sizes = el('select')
      for (const d of profile.dimensions) {
        const option = el('option', undefined, `${String(d.width)} × ${String(d.height)}`)
        option.value = `${String(d.width)}x${String(d.height)}`
        option.selected = d.width === draft.settings.dimensions.width && d.height === draft.settings.dimensions.height
        sizes.append(option)
      }
      sizes.addEventListener('change', () => {
        const [w, h] = sizes.value.split('x').map(Number)
        void commit('Change the size', { ...draft, settings: { ...draft.settings, dimensions: { width: w!, height: h! } } })
      })
      genPanel.append(labelled('Size', sizes))
      if (profile.controls.presets.length > 0) {
        const preset = el('select')
        for (const p of ['', ...profile.controls.presets]) {
          const option = el('option', undefined, p === '' ? 'Standard' : p)
          option.value = p
          option.selected = (draft.settings.preset ?? '') === p
          preset.append(option)
        }
        preset.addEventListener('change', () => void commit('Change the quality', { ...draft, settings: { ...draft.settings, preset: preset.value || null } }))
        genPanel.append(labelled('Quality', preset))
      }
      const advanced = el('details', 'image-editor-advanced')
      advanced.append(el('summary', undefined, 'Advanced'))
      const seed = el('input')
      seed.type = 'number'
      seed.min = String(profile.controls.seed.min)
      seed.max = String(profile.controls.seed.max)
      seed.value = draft.settings.seed === null ? '' : String(draft.settings.seed)
      seed.placeholder = 'New each time'
      seed.addEventListener('change', () => {
        const v = seed.value === '' ? null : Math.trunc(Number(seed.value))
        if (v !== null && (v < profile.controls.seed.min || v > profile.controls.seed.max)) {
          say('That seed is outside this model’s range.')
          return
        }
        void commit('Change the seed', { ...draft, settings: { ...draft.settings, seed: v } })
      })
      advanced.append(labelled('Seed', seed))
      if (profile.controls.steps) {
        const steps = el('input')
        steps.type = 'number'
        steps.min = String(profile.controls.steps.min)
        steps.max = String(profile.controls.steps.max)
        steps.value = String(draft.settings.steps ?? profile.controls.steps.default)
        steps.addEventListener('change', () => void commit('Change the steps', { ...draft, settings: { ...draft.settings, steps: Math.trunc(Number(steps.value)) } }))
        advanced.append(labelled('Steps', steps))
      }
      genPanel.append(advanced)
    }
    const count = el('div', 'image-editor-segmented')
    count.setAttribute('role', 'radiogroup')
    count.setAttribute('aria-label', 'Versions')
    for (const n of [1, 2, 4] as const) {
      const b = button(String(n), () => void commit('Change how many versions', { ...draft, variantCount: n }))
      b.setAttribute('role', 'radio')
      b.setAttribute('aria-checked', String(draft.variantCount === n))
      count.append(b)
    }
    genPanel.append(labelled('Versions', count))

    const why = blocked()
    const notes = draft.regions.filter((r) => r.enabled).length
    const passes = tool === 'whole' ? draft.variantCount : draft.variantCount * Math.max(1, notes)
    genPanel.append(el('p', 'image-editor-summary',
      `From ${versionName(draft.source.versionId)} (${String(draft.source.dimensions.width)}×${String(draft.source.dimensions.height)})` +
      ` · ${tool === 'whole' ? 'whole picture' : `${String(notes)} ${notes === 1 ? 'note' : 'notes'}`}` +
      ` · ${chosen()?.name ?? 'no model'} · ${String(draft.settings.dimensions.width)}×${String(draft.settings.dimensions.height)}` +
      ` · ${String(draft.variantCount)} ${draft.variantCount === 1 ? 'version' : 'versions'}${passes !== draft.variantCount ? ` (${String(passes)} passes)` : ''}`))
    const go = el('button', 'primary-button', draft.variantCount === 1 ? 'Generate' : `Generate ${String(draft.variantCount)} versions`)
    go.type = 'button'
    go.disabled = why !== undefined || batch?.state === 'active'
    go.addEventListener('click', () => void generate())
    genPanel.append(go)
    if (why !== undefined) genPanel.append(el('p', 'image-editor-why', why))
    if (batch?.state === 'active') {
      genPanel.append(button('Cancel the rest', () => void api.command({ type: 'cancel_remaining', batchId: batch!.id }).then((r) => {
        if (r.batch) batch = r.batch
        refresh()
      })))
    }
    if (batch && batch.state !== 'active') {
      genPanel.append(button('Make more', () => void api.command({ type: 'make_more', batchId: batch!.id, variantCount: draft.variantCount, invocationId: id() })
        .then((r) => start(r)).catch((e: unknown) => say(e instanceof Error ? e.message : String(e)))))
    }
  }

  async function generate(): Promise<void> {
    try {
      say('Getting ready…')
      start(await api.command({ type: 'generate', draftId: draft.id, revision: draft.revision, invocationId: id() }))
    } catch (error) {
      say(error instanceof EditorError ? `${error.message}` : String(error))
    }
  }
  async function clarify(answer: string): Promise<void> {
    if (answer.trim() === '') return
    try {
      question = undefined
      start(await api.command({ type: 'clarify', draftId: draft.id, revision: draft.revision, answer, invocationId: id() }))
    } catch (error) {
      say(error instanceof Error ? error.message : String(error))
    }
  }
  function start(result: { draft: Draft | null; batch: Batch | null }): void {
    if (result.batch) {
      batch = result.batch
      say(batch.variantCount === 1 ? 'Generating…' : `Generating ${String(batch.variantCount)} versions, one after another.`)
      void follow()
    } else {
      void api.call<{ pending: { question: string } | null }>('pending', { draftId: draft.id }).then((p) => {
        question = p.pending?.question
        if (question) say('One question first.')
        refresh()
      })
    }
    refresh()
  }
  /** Following a batch by its events, and by reading it whole after any gap. */
  async function follow(): Promise<void> {
    while (batch?.state === 'active') {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      try {
        const { events } = await api.call<{ events: EditorEvent[] }>('events', { after: sequence })
        const gap = events.length > 0 && events[0]!.sequence !== sequence + 1 && sequence !== -1
        for (const e of events) sequence = Math.max(sequence, e.sequence)
        if (gap || events.some((e) => e.type === 'candidate')) batch = (await api.call<{ batch: Batch }>('batch', { batchId: batch.id })).batch
        const at = batch.candidates.find((c) => c.state === 'rendering' || c.state === 'checking_output')
        if (at) say(batch.variantCount === 1 ? 'Generating…' : `Version ${String(at.slot)} of ${String(batch.variantCount)}`)
        if (batch.candidates.some((c) => c.state === 'completed')) await loadVersions()
        refresh()
      } catch (error) {
        say(error instanceof Error ? error.message : String(error))
        return
      }
    }
    if (batch) {
      const done = batch.candidates.filter((c) => c.state === 'completed').length
      say(done === batch.variantCount ? 'Done.' : `${String(done)} of ${String(batch.variantCount)} made. ${reasonText(batch.candidates.find((c) => c.state !== 'completed')?.reason)}`)
    }
    await loadVersions()
    refresh()
  }

  // ---- versions ------------------------------------------------------------------------------
  const versionName = (versionId: string): string => {
    const at = versions.findIndex((v) => v.source.versionId === versionId)
    const v = versions[at]
    if (!v) return 'this picture'
    return v.source.origin === 'original' ? 'the original' : `version ${String(at)}`
  }
  async function loadVersions(): Promise<void> {
    versions = (await api.call<{ versions: Version[] }>('versions')).versions
  }
  function thumb(v: Version): Promise<string> {
    if (!thumbs.has(v.source.versionId)) thumbs.set(v.source.versionId, api.picture(v.source.attachmentId).then((b) => URL.createObjectURL(b)))
    return thumbs.get(v.source.versionId)!
  }
  function renderStrip(): void {
    strip.replaceChildren()
    for (const v of versions) {
      const card = el('div', 'image-editor-card')
      if (v.source.versionId === draft.source.versionId) card.classList.add('selected')
      const show = el('button', 'image-editor-thumb')
      show.type = 'button'
      show.setAttribute('aria-label', `Show ${versionName(v.source.versionId)}`)
      const img = el('img')
      img.alt = ''
      void thumb(v).then((url) => (img.src = url))
      show.append(img, el('span', undefined, versionName(v.source.versionId)))
      show.addEventListener('click', () => {
        compareWith = v.source.versionId === draft.source.versionId ? undefined : v.source.versionId
        void paint()
      })
      const star = button(v.favorite ? '★' : '☆', () => void api.command({ type: 'favorite', versionId: v.source.versionId, favorite: !v.favorite }).then(loadVersions).then(refresh))
      star.setAttribute('aria-label', v.favorite ? 'Unmark favourite' : 'Mark favourite')
      const edit = button('Edit this version', () => void api.command({ type: 'edit_version', draftId: draft.id, revision: draft.revision, versionId: v.source.versionId }).then((r) => {
        if (r.draft) {
          undo.push({ label: 'Edit another version', draft })
          draft = r.draft
          view = fit(draft.source.dimensions, view.stage)
          compareWith = undefined
          refresh()
          void paint()
        }
      }).catch((e: unknown) => say(e instanceof Error ? e.message : String(e))))
      edit.disabled = v.source.versionId === draft.source.versionId
      card.append(show, star, edit)
      if (v.source.origin !== 'original') {
        const remove = button('Remove', () => {
          if (!window.confirm(`Remove ${versionName(v.source.versionId)} from the history? The original and the other versions stay.`)) return
          void api.call('command', { command: { type: 'remove_version', versionId: v.source.versionId }, action: 'remove_version', confirm: true }).then(loadVersions).then(refresh)
        })
        card.append(remove)
      }
      strip.append(card)
    }
    // The batch being made: one placeholder per slot until its version is published.
    for (const c of batch?.candidates ?? []) {
      if (c.state === 'completed') continue
      const card = el('div', `image-editor-card candidate ${c.state}`)
      card.append(el('span', undefined, `Version ${String(c.slot)} of ${String(batch!.variantCount)}`))
      card.append(el('span', 'image-editor-hint', candidateWords(c)))
      if (c.state === 'failed') {
        card.append(button('Retry', () => void api.command({ type: 'retry_failed', candidateId: c.id, invocationId: id() }).then((r) => start(r)).catch((e: unknown) => say(e instanceof Error ? e.message : String(e)))))
      }
      strip.append(card)
    }
  }

  // ---- export & forget ---------------------------------------------------------------------
  function exportDialog(): void {
    const box = el('div', 'image-editor-export')
    box.setAttribute('role', 'group')
    box.setAttribute('aria-label', 'Export')
    const format = el('select')
    for (const [value, label] of [['png', 'PNG — exact, keeps transparency'], ['jpeg', 'JPEG — smaller'], ['webp', 'WebP']] as const) {
      const option = el('option', undefined, label)
      option.value = value
      format.append(option)
    }
    const colour = el('input')
    colour.type = 'color'
    colour.value = '#ffffff'
    const useColour = el('label', 'image-editor-check')
    const flag = el('input')
    flag.type = 'checkbox'
    useColour.append(flag, document.createTextNode(' Fill transparent areas with this colour'))
    const which = versions.filter((v) => v.favorite)
    const go = button(which.length > 0 ? `Save ${String(which.length)} favourite${which.length === 1 ? '' : 's'}` : 'Save the version shown', () => {
      const chosenVersions = which.length > 0 ? which : versions.filter((v) => v.source.versionId === (compareWith ?? draft.source.versionId))
      void exportVersions(api, chosenVersions, format.value as 'png' | 'jpeg' | 'webp', flag.checked ? colour.value : null)
        .then(() => {
          say('Saved.')
          box.remove()
        })
        .catch((e: unknown) => say(e instanceof Error ? e.message : String(e)))
    })
    const cancel = button('Cancel', () => box.remove())
    box.append(labelled('Format', format), colour, useColour, go, cancel)
    side.prepend(box)
    format.focus()
  }
  async function forget(): Promise<void> {
    if (!window.confirm('Forget every picture in this conversation — the originals, every version and every copy in its messages? This cannot be undone.')) return
    try {
      const receipt = await api.forget()
      write(`alexia-editor-draft-${api.conversationId}`, '')
      close()
      if (receipt.local !== 'complete' || receipt.remote.some((r) => r.state !== 'complete')) {
        window.alert('The pictures are gone from here. Some copies are still being removed and will be the next time that is possible.')
      }
    } catch (error) {
      say(error instanceof Error ? error.message : String(error))
    }
  }

  function refresh(): void {
    title.textContent = `${versionName(draft.source.versionId)} · ${String(draft.source.dimensions.width)}×${String(draft.source.dimensions.height)}`
    undoButton.disabled = undo.length === 0
    redoButton.disabled = redo.length === 0
    renderRail()
    renderTool()
    renderGenerate()
    renderStrip()
    if (message) line.textContent = message
  }

  void Promise.all([
    api.call<{ profiles: Profile[] }>('profiles').then((r) => (profiles = r.profiles)),
    loadVersions(),
    api.call<{ pictures: Picture[] }>('pictures').then((r) => (pictures = r.pictures)),
    api.call<{ pending: { question: string } | null }>('pending', { draftId: draft.id }).then((r) => (question = r.pending?.question)),
  ]).catch((error: unknown) => say(error instanceof Error ? error.message : String(error))).finally(() => {
    sizeStage()
    view = fit(draft.source.dimensions, view.stage)
    refresh()
    void paint()
  })
}

function candidateWords(c: Candidate): string {
  switch (c.state) {
    case 'queued': return 'Waiting its turn'
    case 'rendering': return 'Being made'
    case 'checking_output': return 'Being checked'
    case 'failed': return reasonText(c.reason) || 'It could not be made.'
    case 'blocked': return reasonText(c.reason) || 'Not shown.'
    case 'cancelled': return 'Cancelled'
    default: return c.state.replaceAll('_', ' ')
  }
}

/** Transparency shown as the usual checkerboard, only where the picture is. */
function checker(context: CanvasRenderingContext2D, at: { x: number; y: number; w: number; h: number }): void {
  const size = 10
  context.save()
  context.beginPath()
  context.rect(at.x, at.y, at.w, at.h)
  context.clip()
  context.fillStyle = '#e9e9e9'
  context.fillRect(at.x, at.y, at.w, at.h)
  context.fillStyle = '#cfcfcf'
  for (let y = Math.floor(at.y / size) * size; y < at.y + at.h; y += size) {
    for (let x = Math.floor(at.x / size) * size + ((y / size) % 2 === 0 ? 0 : size); x < at.x + at.w; x += size * 2) context.fillRect(x, y, size, size)
  }
  context.restore()
}

function button(label: string, press: () => void): HTMLButtonElement {
  const b = el('button', 'quiet-button', label)
  b.type = 'button'
  b.addEventListener('click', press)
  return b
}

const id = (): string => `inv_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`

/** A per-viewer convenience: which draft to offer to continue. Absent storage is fine. */
function read(key: string): string | undefined {
  try {
    return localStorage.getItem(key) || undefined
  } catch {
    return undefined
  }
}
function write(key: string, value: string): void {
  try {
    if (value === '') localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // A private window: there is just no offer to continue next time.
  }
}
