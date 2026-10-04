// SPDX-License-Identifier: AGPL-3.0-only
import {
  editorApi, EditorError, reasonText,
  type Batch, type Candidate, type Draft, type EditorApi, type EditorEvent, type Picture, type Profile, type Version, type Work,
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

/** What a reference can give, in the words on its chips. The common ones show first. */
const ROLE_CHIPS: [string, string][] = [['identity', 'Character'], ['pose', 'Pose'], ['clothing', 'Clothing'], ['face', 'Face'], ['hairstyle', 'Hair'], ['background', 'Background']]
const MORE_ROLES: [string, string][] = [['expression', 'Expression'], ['accessories', 'Accessories'], ['lighting', 'Lighting'], ['art_style', 'Style']]

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
  // Apple's glass on the rail's switches is drawn by the shell over the page, so it would float
  // on the editor; the rail reads this and hides it while the editor is open (switchers.ts).
  document.body.dataset.overlay = 'image-editor'
  const dialog = modal(sheet, options.behind)
  const close = (): void => {
    dialog.close()
    sheet.remove()
    delete document.body.dataset.overlay
    options.onClose?.()
  }
  const openMenus = (): HTMLDetailsElement[] => [...sheet.querySelectorAll<HTMLDetailsElement>('details.image-editor-menu[open]')]
  sheet.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    // An open menu closes first; the editor only on the next Escape.
    const menus = openMenus()
    if (menus.length > 0) {
      for (const m of menus) m.open = false
      menus[0]!.querySelector('summary')?.focus()
      return
    }
    close()
  })
  sheet.addEventListener('pointerdown', (event) => {
    for (const m of openMenus()) if (!m.contains(event.target as Node)) m.open = false
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
    grid.append(el('p', 'image-editor-hint', 'Start with your photo. Add pose, clothes or other references in the next step.'))
    const recent = el('div', 'image-editor-recent')
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
      recent.append(b)
    }
    const add = el('label', 'image-editor-main-upload', '＋ Upload your photo')
    const input = el('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp'
    input.hidden = true
    add.tabIndex = 0
    add.setAttribute('role', 'button')
    add.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click() }
    })
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
    grid.append(add)
    if (pictures.length > 0) grid.append(el('h3', undefined, 'Or choose a picture from this chat'), recent)
    grid.append(cancel)
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
  /** The models on this computer that can plan an edit, and the one chosen; undefined until read. */
  let planners: { id: string; name: string; provider: string; host?: string }[] | undefined
  let planner: string | null = null
  let versions: Version[] = []
  let pictures: Picture[] = []
  let batch: Batch | undefined
  let sequence = -1
  let question: string | undefined
  let compareWith: string | undefined
  let message = ''
  let loading = true
  /** ComfyUI's picture so far, while a version renders. Never kept. */
  let live: { url: string; image: ImageBitmap; done: number; total: number } | undefined
  /** The prompt as typed but not yet saved, so a re-render while typing keeps it. */
  let typing: string | undefined
  /** Whether the "Add a reference" picker is open, kept across re-renders. */
  let adding = false
  /** References whose less common roles are showing. */
  const moreRoles = new Set<string>()
  const undo: { label: string; draft: Draft }[] = []
  const redo: { label: string; draft: Draft }[] = []
  const bitmaps = new Map<string, Promise<ImageBitmap>>()
  const thumbs = new Map<string, Promise<string>>()
  const thumbnail = (attachmentId: string): Promise<string> => {
    if (!thumbs.has(attachmentId)) thumbs.set(attachmentId, api.picture(attachmentId).then((blob) => URL.createObjectURL(blob)))
    return thumbs.get(attachmentId)!
  }

  // ---- layout ----------------------------------------------------------------------------
  // The bar keeps what acts on the whole draft — history, comparing, saving out — and puts
  // the rare and the destructive behind a menu, so the picture is what the eye lands on.
  const bar = el('header', 'image-editor-bar')
  const titles = el('div', 'image-editor-titles')
  const title = el('span', 'image-editor-version')
  heading.textContent = 'Edit a picture'
  titles.append(heading, title)
  const undoButton = iconButton('↶', 'Undo', () => void step(undo, redo))
  const redoButton = iconButton('↷', 'Redo', () => void step(redo, undo))
  const history = el('div', 'image-editor-group')
  history.append(undoButton, redoButton)
  const compareButton = button('Compare', () => {
    compareWith = compareWith === undefined ? (versions.find((v) => v.source.versionId !== draft.source.versionId)?.source.versionId) : undefined
    if (compareWith === undefined && versions.length < 2) say('There is nothing to compare with yet. Make a version first.')
    compareButton.setAttribute('aria-pressed', String(compareWith !== undefined))
    void paint()
  })
  compareButton.setAttribute('aria-pressed', 'false')
  const exportMenu = menu('Export', 'Export')
  exportMenu.root.addEventListener('toggle', () => {
    if (exportMenu.root.open) renderExport(exportMenu.panel)
  })
  const more = menu('⋯', 'More')
  more.panel.append(menuItem('Forget this chat’s pictures…', () => void forget(), 'danger'))
  const closeButton = iconButton('✕', 'Close', close)
  const actions = el('div', 'image-editor-actions')
  actions.append(history, compareButton, exportMenu.root, more.root, closeButton)
  bar.append(titles, actions)

  const rail = el('nav', 'image-editor-rail')
  rail.setAttribute('aria-label', 'Editing tools')
  const stage = el('div', 'image-editor-stage')
  const canvas = el('canvas')
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', 'The picture being edited')
  canvas.tabIndex = 0
  // While a version renders: ComfyUI's picture so far, and how far it has got.
  const liveBadge = el('div', 'image-editor-live')
  liveBadge.setAttribute('role', 'status')
  liveBadge.hidden = true
  stage.append(canvas, liveBadge)
  const side = el('aside', 'image-editor-side')
  const toolPanel = el('section', 'image-editor-panel')
  const genPanel = el('section', 'image-editor-generate')
  const footer = el('div', 'image-editor-footer')
  // What the picture computer is busy with — a model downloading, a render — read from its
  // queue, so it shows even after the editor was closed and opened again.
  const work = el('div', 'image-editor-work')
  work.setAttribute('role', 'status')
  work.hidden = true
  const workWords = el('p', 'image-editor-work-words')
  const workBar = el('progress')
  workBar.setAttribute('aria-label', 'Progress on the picture computer')
  const workMore = el('p', 'image-editor-hint')
  work.append(workWords, workBar, workMore)
  side.append(rail, toolPanel, genPanel, footer)
  const strip = el('div', 'image-editor-strip')
  strip.setAttribute('role', 'group')
  strip.setAttribute('aria-label', 'Versions')
  const line = el('p', 'image-editor-line')
  line.setAttribute('role', 'status')
  sheet.append(bar, stage, side, strip, line)

  const say = (text: string): void => {
    message = text
    line.textContent = text
  }

  // ---- drafts ------------------------------------------------------------------------------
  /** One user operation, saved with the revision it started from, and one undo entry. */
  let savedDraft = first
  let saveTail: Promise<void> = Promise.resolve()
  let preparing = false
  let savesPending = 0
  let saveError: unknown
  async function commit(label: string, next: Draft): Promise<Draft> {
    const before = draft
    draft = next
    savesPending += 1
    saveError = undefined
    const work = saveTail.then(async () => {
      let saved = next
      if (next.revision <= before.revision) {
        saved = (await api.command({ type: 'save', draft: { ...next, revision: savedDraft.revision }, expectedRevision: savedDraft.revision })).draft ?? next
      }
      savedDraft = saved
      undo.push({ label, draft: before })
      redo.length = 0
      if (draft === next) draft = saved
      else draft = { ...draft, revision: saved.revision }
      return saved
    })
    saveTail = work.then(() => undefined, (error: unknown) => { saveError = error })
    try {
      return await work
    } catch (error) {
      draft = savedDraft
      say(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      savesPending -= 1
      if (savesPending === 0) refresh()
    }
  }
  async function step(from: typeof undo, to: typeof undo): Promise<void> {
    await saveTail
    const back = from.pop()
    if (!back) return
    try {
      const saved = (await api.command({ type: 'save', draft: { ...back.draft, revision: draft.revision }, expectedRevision: draft.revision })).draft
      to.push({ label: back.label, draft })
      if (saved) { draft = saved; savedDraft = saved }
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
    if (live) {
      // The new picture as it forms, as large as the stage allows. It is the size of the
      // version being made, not of this one, so it is fitted on its own.
      const fitted = Math.min(view.stage.width / live.image.width, view.stage.height / live.image.height)
      const w = live.image.width * fitted
      const h = live.image.height * fitted
      context.imageSmoothingQuality = 'high'
      context.drawImage(live.image, (view.stage.width - w) / 2, (view.stage.height - h) / 2, w, h)
      return
    }
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
          savedDraft = done.draft
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
      b.dataset.focus = `tool-${value}`
      rail.append(b)
    }
  }

  // ---- pictures in: your photo and up to two references ----------------------------------
  const rolesOf = (attachmentId: string): string[] => draft.referenceRoles?.find((r) => r.attachmentId === attachmentId)?.roles ?? []

  /** Your photo, then each reference with what to take from it as chips, then a way to add one. */
  function pictureInputs(): HTMLElement {
    const box = section('Pictures')
    box.querySelector('h3')!.append(el('span', 'image-editor-count', `${String(1 + draft.referenceIds.length)} of 3`))
    const slots = el('div', 'image-editor-inputs')
    slots.setAttribute('role', 'list')
    slots.setAttribute('aria-label', 'Input pictures, maximum three')
    slots.append(inputSlot(draft.source.attachmentId, 'Your photo').card)
    for (const [index, attachmentId] of draft.referenceIds.entries()) {
      const name = `Reference ${String(index + 1)}`
      const { card, body } = inputSlot(attachmentId, name)
      body.append(roleChips(attachmentId, name))
      const remove = iconButton('✕', `Remove ${name.toLowerCase()}`, () => {
        moreRoles.delete(attachmentId)
        void commit('Remove reference', { ...draft, referenceIds: draft.referenceIds.filter((id) => id !== attachmentId), referenceRoles: (draft.referenceRoles ?? []).filter((r) => r.attachmentId !== attachmentId) }).catch(() => undefined)
      })
      remove.classList.add('image-editor-slot-remove')
      card.append(remove)
      slots.append(card)
    }
    box.append(slots)
    if (draft.referenceIds.length < 2) box.append(addReference())
    return box
  }

  function inputSlot(attachmentId: string, name: string): { card: HTMLElement; body: HTMLElement } {
    const card = el('article', 'image-editor-input-slot')
    card.setAttribute('role', 'listitem')
    const img = el('img', 'image-editor-input-thumb')
    img.alt = name
    void thumbnail(attachmentId).then((url) => { img.src = url }).catch(() => undefined)
    const body = el('div', 'image-editor-input-body')
    body.append(el('strong', undefined, name))
    if (attachmentId === draft.source.attachmentId) body.append(el('span', 'image-editor-hint', 'The picture that changes'))
    card.append(img, body)
    return { card, body }
  }

  /** What to take from a reference: the common roles as chips, the rest one press away. */
  function roleChips(attachmentId: string, name: string): HTMLElement {
    const selected = rolesOf(attachmentId)
    const group = el('div', 'image-editor-roles')
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', `What to take from ${name.toLowerCase()}`)
    const all = moreRoles.has(attachmentId) || MORE_ROLES.some(([role]) => selected.includes(role))
    for (const [role, label] of all ? [...ROLE_CHIPS, ...MORE_ROLES] : ROLE_CHIPS) {
      const chip = el('button', 'image-editor-chip', label)
      chip.type = 'button'
      chip.setAttribute('aria-pressed', String(selected.includes(role)))
      chip.dataset.focus = `role-${attachmentId}-${role}`
      chip.addEventListener('click', () => {
        chip.setAttribute('aria-pressed', String(chip.getAttribute('aria-pressed') !== 'true'))
        void toggleRole(attachmentId, role, label).catch(() => undefined)
      })
      group.append(chip)
    }
    if (!all) {
      const extra = el('button', 'image-editor-chip image-editor-chip-more', 'More…')
      extra.type = 'button'
      extra.setAttribute('aria-label', `More things to take from ${name.toLowerCase()}`)
      extra.addEventListener('click', () => {
        moreRoles.add(attachmentId)
        renderTool()
        toolPanel.querySelector<HTMLElement>(`[data-focus="role-${attachmentId}-${MORE_ROLES[0]![0]}"]`)?.focus()
      })
      group.append(extra)
    }
    const wrap = el('div', 'image-editor-roles-wrap')
    wrap.append(group)
    if (selected.length === 0) wrap.append(el('p', 'image-editor-hint', 'Nothing chosen: your words decide what is taken from it.'))
    return wrap
  }

  /** One picture per role: choosing a role here takes it off the other reference. */
  function toggleRole(attachmentId: string, role: string, label: string): Promise<Draft> {
    const on = !rolesOf(attachmentId).includes(role)
    const referenceRoles = draft.referenceIds.map((id) => {
      const roles = rolesOf(id).filter((r) => r !== role)
      return { attachmentId: id, roles: on && id === attachmentId ? [...roles, role] : roles }
    }).filter((r) => r.roles.length > 0)
    return commit(`${on ? 'Take' : 'Stop taking'} ${label.toLowerCase()} from a reference`, { ...draft, referenceRoles })
  }

  /** Opens in place: upload one, or pick one of the pictures already in this chat. */
  function addReference(): HTMLElement {
    const add = el('details', 'image-editor-add')
    add.open = adding
    add.addEventListener('toggle', () => { adding = add.open })
    const summary = el('summary', 'image-editor-add-summary')
    summary.append(el('span', 'image-editor-add-plus', '+'), el('span', undefined, 'Add a reference'), el('span', 'image-editor-hint', 'pose, clothing, a character…'))
    summary.dataset.focus = 'add-reference'
    const body = el('div', 'image-editor-add-body')
    const use = async (p: Picture): Promise<void> => {
      if (draft.referenceIds.length >= 2 || draft.referenceIds.includes(p.id) || p.id === draft.source.attachmentId) return
      adding = false
      say('Reference added. Choose what to take from it.')
      await commit('Add reference picture', { ...draft, referenceIds: [...draft.referenceIds, p.id] })
    }
    const upload = el('label', 'image-editor-slot-upload')
    upload.append(el('span', undefined, 'Upload a picture…'))
    const file = el('input')
    file.type = 'file'
    file.accept = 'image/png,image/jpeg,image/webp'
    file.hidden = true
    upload.tabIndex = 0
    upload.setAttribute('role', 'button')
    upload.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); file.click() }
    })
    file.addEventListener('change', () => {
      const chosenFile = file.files?.[0]
      if (!chosenFile) return
      file.disabled = true
      say('Adding the reference…')
      void upright(chosenFile).then((png) => api.upload(chosenFile.name.replace(/\.[^.]+$/, '') + '.png', png)).then(async (p) => {
        pictures.push(p)
        await use(p)
      }).catch((error: unknown) => { file.disabled = false; say(error instanceof Error ? error.message : String(error)) })
    })
    upload.append(file)
    body.append(upload)
    const existing = pictures.filter((p) => p.id !== draft.source.attachmentId && !draft.referenceIds.includes(p.id))
    if (existing.length > 0) {
      body.append(el('p', 'image-editor-hint', 'Or use one from this chat'))
      const grid = el('div', 'image-editor-add-pick')
      for (const p of existing) {
        const pick = el('button', 'image-editor-pick')
        pick.type = 'button'
        pick.title = p.displayName
        pick.setAttribute('aria-label', `Use ${p.displayName} as a reference`)
        const img = el('img')
        img.alt = ''
        void thumbnail(p.id).then((url) => { img.src = url }).catch(() => undefined)
        pick.append(img)
        pick.addEventListener('click', () => {
          void (p.mime === 'image/png' ? Promise.resolve(p) : api.picture(p.id).then(upright).then((png) => api.upload(p.displayName + '.png', png, p.id)))
            .then(use).catch((error: unknown) => say(error instanceof Error ? error.message : String(error)))
        })
        grid.append(pick)
      }
      body.append(grid)
    }
    add.append(summary, body)
    return add
  }

  function renderTool(): void {
    toolPanel.replaceChildren()
    if (tool === 'whole') {
      toolPanel.append(pictureInputs())
      const words = el('textarea', 'image-editor-prompt')
      words.rows = 4
      words.maxLength = 8000
      words.value = typing ?? draft.instruction
      words.placeholder = draft.referenceIds.length > 0
        ? 'For example: put me in the reference outfit, in the pose from reference 2, on a sunlit street.'
        : 'For example: make it a sunny day, and change the jacket to red leather.'
      words.setAttribute('aria-label', 'What to change in the whole picture')
      words.dataset.focus = 'prompt'
      words.addEventListener('input', () => { typing = words.value })
      words.addEventListener('change', () => {
        typing = undefined
        void commit('Change the description', { ...draft, instruction: words.value })
      })
      toolPanel.append(section('Describe the result', words))
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
    if (planners !== undefined && planners.length === 0) return 'Planning needs a model that can see pictures, on this Mac or the picture computer. Install Qwen2.5-VL in Settings › Local models, then open the editor again.'
    if (planners !== undefined && planner === null) return 'Choose a planning model.'
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
    footer.replaceChildren(work)
    if (tool === 'crop') return
    if (question !== undefined) {
      const box = el('div', 'image-editor-question')
      const answer = el('input')
      answer.setAttribute('aria-label', 'Your answer')
      const send = button('Answer', () => void clarify(answer.value))
      box.append(el('p', undefined, question), answer, send)
      genPanel.append(box)
    }
    const model = section('Model')
    const pick = el('select')
    pick.dataset.focus = 'model'
    pick.append(Object.assign(el('option', undefined, loading ? 'Loading models…' : profiles.length === 0 ? 'No editing models yet' : 'Choose a model…'), { value: '' }))
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
        if (sized) say(`${found.name} makes ${found.dimensions.map((d) => `${String(d.width)}×${String(d.height)}`).join(', ')}. Choose a size.`)
      })
    })
    pick.setAttribute('aria-label', 'Model')
    model.append(pick)
    genPanel.append(model)
    const profile = chosen()
    if (profile) {
      model.append(el('p', 'image-editor-hint',
        `Up to ${String(profile.maxInputs)} pictures` +
        `${profile.measuredMemory ? ` · about ${(profile.measuredMemory.gpuBytes / 1e9).toFixed(1)} GB of graphics memory` : ''}` +
        ` · runs on ${profile.destination.kind === 'paired' ? profile.destination.displayName : 'the computer chosen for pictures'}`))
      if (profile.availability === 'needs_installation' || profile.availability === 'incompatible') {
        const install = button('Install this model on the picture computer', () => {
          install.disabled = true
          install.textContent = 'Installing… keep Alexia open'
          say('Downloading the editing model to the picture computer. It is tens of gigabytes, so this can take a long time; if it stops, pressing Install again carries on where it left off.')
          void api.call<{ profiles: Profile[] }>('install_profile', { profile: profile.selection }).then((result) => {
            profiles = result.profiles
            say('Editing model installed.')
            refresh()
          }).catch((error: unknown) => { install.disabled = false; say(error instanceof Error ? error.message : String(error)) })
        })
        model.append(install)
      }
      const output = section('Output')
      const row = el('div', 'image-editor-row')
      const sizes = el('select')
      sizes.dataset.focus = 'size'
      if (!profile.dimensions.some((d) => d.width === draft.settings.dimensions.width && d.height === draft.settings.dimensions.height)) {
        sizes.append(Object.assign(el('option', undefined, 'Choose…'), { value: '', selected: true, disabled: true }))
      }
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
      row.append(labelled('Size', sizes))
      if (profile.controls.presets.length > 0) {
        const preset = el('select')
        preset.dataset.focus = 'preset'
        for (const p of ['', ...profile.controls.presets]) {
          const option = el('option', undefined, p === '' ? 'Standard' : p)
          option.value = p
          option.selected = (draft.settings.preset ?? '') === p
          preset.append(option)
        }
        preset.addEventListener('change', () => void commit('Change the quality', { ...draft, settings: { ...draft.settings, preset: preset.value || null } }))
        row.append(labelled('Quality', preset))
      }
      output.append(row)
      output.append(versionCount())
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
      const tuning = el('div', 'image-editor-row')
      tuning.append(labelled('Seed', seed))
      if (profile.controls.steps) {
        const steps = el('input')
        steps.type = 'number'
        steps.min = String(profile.controls.steps.min)
        steps.max = String(profile.controls.steps.max)
        steps.value = String(draft.settings.steps ?? profile.controls.steps.default)
        steps.addEventListener('change', () => void commit('Change the steps', { ...draft, settings: { ...draft.settings, steps: Math.trunc(Number(steps.value)) } }))
        tuning.append(labelled('Steps', steps))
      }
      advanced.append(tuning)
      output.append(advanced)
      genPanel.append(output)
    }
    model.append(plannerPicker())

    // The footer stays at the bottom of the panel: what will happen, why not yet, and the button.
    const why = blocked()
    const notes = draft.regions.filter((r) => r.enabled).length
    const passes = tool === 'whole' ? draft.variantCount : draft.variantCount * Math.max(1, notes)
    if (why !== undefined) footer.append(el('p', 'image-editor-why', why))
    else {
      footer.append(el('p', 'image-editor-summary',
        `${tool === 'whole' ? `${String(1 + draft.referenceIds.length)} ${draft.referenceIds.length === 0 ? 'picture' : 'pictures'} in` : `${String(notes)} ${notes === 1 ? 'note' : 'notes'}`}` +
        ` · ${String(draft.settings.dimensions.width)}×${String(draft.settings.dimensions.height)}` +
        `${passes !== draft.variantCount ? ` · ${String(passes)} passes` : ''}`))
    }
    const go = el('button', 'primary-button', draft.variantCount === 1 ? 'Generate' : `Generate ${String(draft.variantCount)} versions`)
    go.type = 'button'
    go.disabled = preparing || why !== undefined || batch?.state === 'active'
    go.addEventListener('click', () => void generate())
    footer.append(go)
    if (batch?.state === 'active') {
      footer.append(button('Cancel the rest', () => void api.command({ type: 'cancel_remaining', batchId: batch!.id }).then((r) => {
        if (r.batch) batch = r.batch
        refresh()
      })))
    }
    if (batch && batch.state !== 'active') {
      footer.append(button('Make more like these', () => void api.command({ type: 'make_more', batchId: batch!.id, variantCount: draft.variantCount, invocationId: id() })
        .then((r) => start(r)).catch((e: unknown) => say(e instanceof Error ? e.message : String(e)))))
    }
  }

  /**
   * Which model on this computer reads the request and the pictures first, to plan the edit and
   * to check it. Separate from the chat's model, which may be on another computer: private
   * pictures are planned only here. Chosen by the person, never swapped for them.
   */
  function plannerPicker(): HTMLElement {
    const choose = el('select')
    choose.dataset.focus = 'planner'
    const list = planners ?? []
    choose.append(Object.assign(el('option', undefined, planners === undefined ? 'Loading…' : list.length === 0 ? 'None here or on the picture computer that can see pictures' : 'Choose a planning model…'), { value: '' }))
    for (const one of list) {
      const option = el('option', undefined, `${one.name}${one.host !== undefined ? ` (on ${one.host})` : one.provider === 'ollama' ? ' (Ollama, this Mac)' : ' (this Mac)'}`)
      option.value = one.id
      option.selected = one.id === planner
      choose.append(option)
    }
    choose.disabled = list.length === 0
    choose.addEventListener('change', () => {
      const wanted = choose.value === '' ? null : choose.value
      void api.call<{ selected: string | null }>('select_planner', { model: wanted }).then((r) => {
        planner = r.selected
        refresh()
      }).catch((error: unknown) => say(error instanceof Error ? error.message : String(error)))
    })
    const field = labelled('Planning model', choose)
    const box = el('div', 'image-editor-field')
    box.append(field, el('p', 'image-editor-hint', 'Reads your words and pictures to plan the edit and check it — on this Mac, or on the computer that makes the pictures. Never online.'))
    return box
  }

  function versionCount(): HTMLElement {
    const count = el('div', 'image-editor-segmented')
    count.setAttribute('role', 'radiogroup')
    count.setAttribute('aria-label', 'How many versions')
    for (const n of [1, 2, 4] as const) {
      const b = button(String(n), () => void commit('Change how many versions', { ...draft, variantCount: n }))
      b.setAttribute('role', 'radio')
      b.setAttribute('aria-checked', String(draft.variantCount === n))
      b.dataset.focus = `count-${String(n)}`
      count.append(b)
    }
    const field = el('div', 'image-editor-field')
    field.append(el('span', undefined, 'Versions'), count)
    return field
  }

  async function generate(): Promise<void> {
    if (preparing || batch?.state === 'active') return
    preparing = true
    renderGenerate()
    try {
      await saveTail
      if (saveError) throw saveError
      say('Getting ready…')
      start(await api.command({ type: 'generate', draftId: draft.id, revision: draft.revision, invocationId: id() }))
    } catch (error) {
      say(error instanceof EditorError ? `${error.message}` : String(error))
    } finally {
      preparing = false
      renderGenerate()
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
  /** The newest preview, if it is new: decoded once, then drawn until the next replaces it. */
  async function watchPreview(): Promise<void> {
    const { preview } = await api.call<{ preview: { candidateId: string | null; preview: string; done: number; total: number } | null }>('preview')
    if (!preview) {
      if (live) showLive(undefined)
      return
    }
    if (preview.preview === live?.url) return
    const img = new Image()
    img.src = preview.preview
    await img.decode()
    showLive({ url: preview.preview, image: await createImageBitmap(img), done: preview.done, total: preview.total })
  }
  function showLive(next: typeof live): void {
    live?.image.close()
    live = next
    liveBadge.hidden = !next
    if (next) liveBadge.textContent = next.total > 0 && next.total <= 10_000 ? `Live preview · step ${String(next.done)} of ${String(next.total)}` : 'Live preview'
    void paint()
  }

  async function follow(): Promise<void> {
    while (batch?.state === 'active') {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      // A preview that cannot be read is not worth stopping the follow for.
      await watchPreview().catch(() => undefined)
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
    showLive(undefined)
    if (batch) {
      const done = batch.candidates.filter((c) => c.state === 'completed').length
      const missed = batch.candidates.find((c) => c.state !== 'completed')
      say(done === batch.variantCount ? 'Done.' : `${String(done)} of ${String(batch.variantCount)} made. ${[reasonText(missed?.reason), missed?.detail].filter(Boolean).join(' — ')}`)
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
    // Only the original and nothing being made: there is nothing to choose between yet.
    strip.hidden = versions.length < 2 && !batch
    if (strip.hidden) return
    strip.append(el('span', 'image-editor-strip-label', 'Versions'))
    for (const v of versions) {
      const name = versionName(v.source.versionId)
      const current = v.source.versionId === draft.source.versionId
      const card = el('div', 'image-editor-card')
      card.classList.toggle('selected', current)
      card.classList.toggle('compared', v.source.versionId === compareWith)
      const show = el('button', 'image-editor-thumb')
      show.type = 'button'
      show.setAttribute('aria-label', current ? `${name}, being edited` : `Compare with ${name}`)
      const img = el('img')
      img.alt = ''
      void thumb(v).then((url) => (img.src = url))
      show.append(img, el('span', undefined, current ? `${name} · editing` : name))
      show.addEventListener('click', () => {
        compareWith = current || compareWith === v.source.versionId ? undefined : v.source.versionId
        compareButton.setAttribute('aria-pressed', String(compareWith !== undefined))
        renderStrip()
        void paint()
      })
      const tools = el('div', 'image-editor-card-actions')
      const star = iconButton(v.favorite ? '★' : '☆', v.favorite ? `Unmark ${name} as favourite` : `Mark ${name} as favourite`, () => void api.command({ type: 'favorite', versionId: v.source.versionId, favorite: !v.favorite }).then(loadVersions).then(refresh))
      star.classList.toggle('on', v.favorite)
      tools.append(star)
      if (!current) {
        tools.append(iconButton('✎', `Edit ${name}`, () => void api.command({ type: 'edit_version', draftId: draft.id, revision: draft.revision, versionId: v.source.versionId }).then((r) => {
          if (r.draft) {
            undo.push({ label: 'Edit another version', draft })
            draft = r.draft
            savedDraft = r.draft
            view = fit(draft.source.dimensions, view.stage)
            compareWith = undefined
            refresh()
            void paint()
          }
        }).catch((e: unknown) => say(e instanceof Error ? e.message : String(e)))))
      }
      if (v.source.origin !== 'original') {
        tools.append(iconButton('🗑', `Remove ${name}`, () => {
          if (!window.confirm(`Remove ${name} from the history? The original and the other versions stay.`)) return
          void api.call('command', { command: { type: 'remove_version', versionId: v.source.versionId }, action: 'remove_version', confirm: true }).then(loadVersions).then(refresh)
        }))
      }
      card.append(show, tools)
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
  /** The Export menu's contents, built as it opens so it counts the favourites as they are now. */
  function renderExport(panel: HTMLElement): void {
    panel.replaceChildren()
    const format = el('select')
    for (const [value, label] of [['png', 'PNG — exact, keeps transparency'], ['jpeg', 'JPEG — smaller'], ['webp', 'WebP']] as const) {
      const option = el('option', undefined, label)
      option.value = value
      format.append(option)
    }
    const fill = el('div', 'image-editor-row image-editor-fill')
    const colour = el('input')
    colour.type = 'color'
    colour.value = '#ffffff'
    colour.setAttribute('aria-label', 'Fill colour')
    const useColour = el('label', 'image-editor-check')
    const flag = el('input')
    flag.type = 'checkbox'
    useColour.append(flag, document.createTextNode(' Fill transparent areas'))
    fill.append(useColour, colour)
    const which = versions.filter((v) => v.favorite)
    const go = el('button', 'primary-button', which.length > 0 ? `Save ${String(which.length)} favourite${which.length === 1 ? '' : 's'}` : 'Save the version shown')
    go.type = 'button'
    go.addEventListener('click', () => {
      const chosenVersions = which.length > 0 ? which : versions.filter((v) => v.source.versionId === (compareWith ?? draft.source.versionId))
      void exportVersions(api, chosenVersions, format.value as 'png' | 'jpeg' | 'webp', flag.checked ? colour.value : null)
        .then(() => {
          say('Saved.')
          exportMenu.root.open = false
        })
        .catch((e: unknown) => say(e instanceof Error ? e.message : String(e)))
    })
    panel.append(labelled('Format', format), fill, go)
    if (which.length === 0) panel.append(el('p', 'image-editor-hint', 'Star versions in the strip to save several at once.'))
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
    // Re-rendering replaces the controls; whoever had one focused gets its replacement back.
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.focus
    title.textContent = `${versionName(draft.source.versionId)} · ${String(draft.source.dimensions.width)}×${String(draft.source.dimensions.height)}`
    undoButton.disabled = undo.length === 0
    redoButton.disabled = redo.length === 0
    compareButton.setAttribute('aria-pressed', String(compareWith !== undefined))
    renderRail()
    renderTool()
    renderGenerate()
    renderStrip()
    if (message) line.textContent = message
    if (focused) side.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus()
  }

  // ---- the picture computer's work ---------------------------------------------------------
  let last: Work | undefined
  async function watchWork(): Promise<void> {
    while (sheet.isConnected) {
      const now = await api.work()
      if (!sheet.isConnected) return
      showWork(now)
      // A job that said what it was doing just ended — a download, most likely — so the models
      // may have changed. The models check says nothing, so asking again does not loop.
      if (last?.message !== undefined && !now) void api.call<{ profiles: Profile[] }>('profiles').then((r) => { profiles = r.profiles; refresh() }).catch(() => undefined)
      last = now
      await new Promise((resolve) => setTimeout(resolve, now ? 1500 : 5000))
    }
  }
  function showWork(now: Work | undefined): void {
    work.hidden = now === undefined
    if (!now) return
    const [file, words] = splitMessage(now.message)
    const what = JOB_NAMES[now.label] ?? (now.label || 'a job')
    const since = now.startedAt !== undefined ? ` · for ${duration(Date.now() - now.startedAt)}` : ''
    workWords.replaceChildren(el('strong', undefined, words ?? `The picture computer is busy with ${what}`))
    workWords.append(el('span', 'image-editor-work-file', file ? `${file}${since}` : words ? `${what}${since}` : `It has not said how far along it is${since}.`))
    if (now.total !== undefined && now.total > 0) {
      workBar.max = now.total
      workBar.value = Math.min(now.done, now.total)
    } else workBar.removeAttribute('value')
    const pace = rate.see(now)
    const percent = now.total ? `${String(Math.floor((now.done / now.total) * 100))}%` : ''
    const parts = [percent, pace, now.waiting > 0 ? `${String(now.waiting)} more waiting after this` : ''].filter((one) => one !== '')
    workMore.textContent = parts.length > 0 ? parts.join(' · ') : 'Other picture work waits until this is done'
  }
  const rate = pacer()

  // Draw at once from the draft alone, and fill in models, versions and pictures as they arrive:
  // a slow picture computer should not leave the editor empty.
  sizeStage()
  view = fit(draft.source.dimensions, view.stage)
  refresh()
  void paint()
  void watchWork()
  void Promise.all([
    api.call<{ profiles: Profile[] }>('profiles').then((r) => (profiles = r.profiles)).finally(() => { loading = false; refresh() }),
    loadVersions().then(refresh),
    api.call<{ pictures: Picture[] }>('pictures').then((r) => { pictures = r.pictures; refresh() }),
    api.call<{ planners: { id: string; name: string; provider: string; host?: string }[]; selected: string | null }>('planners').then((r) => {
      planners = Array.isArray(r.planners) ? r.planners : []
      // A choice whose model has gone is not a choice: it is asked for again.
      planner = typeof r.selected === 'string' && planners.some((one) => one.id === r.selected) ? r.selected : null
      refresh()
    }),
    api.call<{ pending: { question: string } | null }>('pending', { draftId: draft.id }).then((r) => { question = r.pending?.question; refresh() }),
  ]).catch((error: unknown) => say(error instanceof Error ? error.message : String(error))).finally(() => {
    sizeStage()
    refresh()
    void paint()
  })
}

function candidateWords(c: Candidate): string {
  switch (c.state) {
    case 'queued': return 'Waiting its turn'
    case 'rendering': return 'Being made'
    case 'checking_output': return 'Being checked'
    case 'failed': return [reasonText(c.reason) || 'It could not be made.', c.detail].filter(Boolean).join(' — ')
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

/**
 * **How fast, and how long is left**, from the progress a job reports: bytes for a download,
 * steps for a render. Measured over the last half minute so one slow chunk does not swing it;
 * a new job, or a count that goes back (the next file), starts the measuring again.
 */
export function pacer(now: () => number = Date.now): { see(work: Work): string } {
  let id = ''
  let samples: { at: number; done: number }[] = []
  return {
    see(work) {
      const last = samples.at(-1)
      if (work.id !== id || (last !== undefined && work.done < last.done)) {
        id = work.id
        samples = []
      }
      const at = now()
      samples.push({ at, done: work.done })
      // The window, plus the newest reading just outside it: there is always a start to measure from.
      const outside = samples.findLastIndex((one) => at - one.at > 30_000)
      if (outside > 0) samples = samples.slice(outside)
      const first = samples[0]!
      const seconds = (at - first.at) / 1000
      const moved = work.done - first.done
      const steps = work.total !== undefined && work.total > 0 && work.total <= 10_000
      const where = steps ? `step ${String(work.done)} of ${String(work.total)} · ` : ''
      if (!work.total) return ''
      if (seconds < 2) return `${where}measuring the speed…`
      if (moved <= 0) return seconds >= 25 ? `${where}nothing has moved for ${String(Math.round(seconds))} s` : `${where}measuring the speed…`
      const perSecond = moved / seconds
      const left = (work.total - work.done) / perSecond
      const remaining = left < 60 ? `about ${String(Math.max(1, Math.round(left)))} s left` : `about ${duration(left * 1000)} left`
      // Small totals are steps; large ones are bytes.
      if (steps) return `${where}${(seconds / moved).toFixed(1)} s per step · ${remaining}`
      return `${perSecond >= 1e6 ? `${(perSecond / 1e6).toFixed(1)} MB/s` : `${Math.round(perSecond / 1e3).toString()} kB/s`} · ${remaining}`
    },
  }
}

/** Plain names for the jobs a picture computer runs, by capability. */
const JOB_NAMES: Record<string, string> = { 'image.edit': 'picture editing', 'image.generate': 'making a picture' }

/** 75 000 → "1 min"; 4 000 000 → "1 h 6 min". */
export function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 1) return 'under a minute'
  return minutes < 60 ? `${String(minutes)} min` : `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`
}

/** "file.safetensors: Downloading the model — 3 GB of 20 GB" → the file, and the words. */
export function splitMessage(message: string | undefined): [string | undefined, string | undefined] {
  if (!message) return [undefined, undefined]
  const at = message.indexOf(': ')
  if (at > 0 && /\.[a-z0-9]{2,12}$/i.test(message.slice(0, at))) return [message.slice(0, at), message.slice(at + 2)]
  return [undefined, message]
}

/** A small square button whose meaning is in its name, not its glyph. */
function iconButton(glyph: string, name: string, press: () => void): HTMLButtonElement {
  const b = button(glyph, press)
  b.classList.add('image-editor-icon')
  b.setAttribute('aria-label', name)
  b.title = name
  return b
}

/** A dropdown: a summary that opens a floating panel. Escape or a press outside closes it. */
function menu(label: string, name: string): { root: HTMLDetailsElement; panel: HTMLElement } {
  const root = el('details', 'image-editor-menu')
  const summary = el('summary', 'quiet-button', label)
  summary.setAttribute('aria-label', name)
  summary.title = name
  const panel = el('div', 'image-editor-menu-panel')
  root.append(summary, panel)
  return { root, panel }
}

function menuItem(label: string, press: () => void, tone?: 'danger'): HTMLButtonElement {
  const b = el('button', `image-editor-menu-item${tone ? ` ${tone}` : ''}`, label)
  b.type = 'button'
  b.addEventListener('click', () => {
    const owner = b.closest('details')
    if (owner) owner.open = false
    press()
  })
  return b
}

/** A titled group in the side panel. */
function section(heading: string, ...children: HTMLElement[]): HTMLElement {
  const box = el('section', 'image-editor-section')
  box.append(el('h3', undefined, heading), ...children)
  return box
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
