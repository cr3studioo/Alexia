// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The board (D199): pages of glass laid on the painting, each on its dots.
 *
 * It replaced three fixed columns whose grips were drawn and did nothing. The columns are
 * still there — as two **guides** in one free layout — and the grips now move them: every page
 * whose edge sits on a guide stretches with it, and nothing else does.
 *
 * Two ways of being on screen:
 *
 * - **Normal view.** No dots. The pages, and the two grips between the columns.
 * - **Edit view.** The dots appear and every page can be picked up. Drop it on a dot where it
 *   fits and it lands (blue); anywhere else it goes back (red). A page that scales has a
 *   corner to drag; a tapped page gets a small bar with its sizes and a way off the board.
 *   The way in is the bottom-left corner — hover it and a pill slides out — or Tab, or the
 *   palette's *Edit layout*. A button that only appears on hover is a button nobody finds, so
 *   it is never only that.
 *
 * **The arithmetic is `layout.ts` and the pages are `pages.ts`.** This file turns dots into
 * pixels and pointer movement back into dots, and saves what somebody did.
 *
 * **Saved twice, trusted once.** Core keeps the layout the same way it keeps the theme, and
 * `localStorage` keeps a copy that the head script in `index.html` hands over before the first
 * paint — so a launch does not flash the default and then jump. Core's answer corrects it.
 *
 * **Drags move `transform` and nothing else** while the pointer is down, and the page being
 * dragged drops its backdrop blur: thirty-pixel blurs repainting under a moving pane is the
 * stutter everybody has seen on glass UIs. Positions are written back when it lands.
 */

import {
  arrange,
  dragGuide,
  fits,
  grid,
  type Grid,
  type Layout,
  limits,
  pin,
  type Placed,
  px,
  rescale,
  type Shape,
  SP,
  type Tier,
  TIERS,
} from './layout.js'
import {
  arrival,
  CORE_PAGES,
  defaultLayout,
  drawLocalStats,
  drawPluginPage,
  frame,
  isLayout,
  type LocalStats,
  moves,
  type PageInfo,
  type PagePane,
  payload,
  type ShellTemps,
  pluginOf,
  pluginPages,
  reconcile,
} from './pages.js'
import { temps } from './desktop.js'
import { el, refreshDriven, type WidgetHost } from './widgets.js'

/** Where the head script leaves the saved layout. Written down twice; `index.html` is the other. */
export const REMEMBERED_LAYOUT = 'alexia.layout'

/** How long the pointer rests in the corner before the pill comes out. Long enough to mean it. */
const HOVER_MS = 150

export interface Board {
  /** Core's answer from `/api/state`. `undefined` is a core that does not know about layouts. */
  adopt(layout: Layout | null | undefined): void
  /** Re-read `/api/plugins`, because one may have been installed, enabled, disabled or removed. */
  refresh(): Promise<void>
  /** Core's `channels` from `/api/state`: how many other ways in are connected. Absent is an older core. */
  reach(channels: number | undefined): void
  edit(on: boolean): void
  editing(): boolean
}

/** The layout the head script found, if it is one. Read once, synchronously, at mount. */
function stashed(): Layout | null {
  try {
    const raw = document.documentElement.dataset.layout ?? localStorage.getItem(REMEMBERED_LAYOUT)
    if (raw === undefined || raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    return isLayout(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function mountBoard(root: HTMLElement, token: string): Board {
  const field = root.querySelector<HTMLElement>('.board-field')!
  const dots = el('div', 'board-dots')
  dots.setAttribute('aria-hidden', 'true')
  field.prepend(dots)

  const send = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const answer = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': token },
      body: JSON.stringify(body),
    })
    return answer.ok ? ((await answer.json()) as Record<string, unknown>) : {}
  }

  // ---- what is here -----------------------------------------------------------------------

  /** The page elements, by id. Core's are in the markup; the rest are made on demand. */
  const elements = new Map<string, HTMLElement>()
  for (const section of field.querySelectorAll<HTMLElement>('[data-page]')) elements.set(section.dataset.page!, section)
  const elementOf = (info: PageInfo): HTMLElement => {
    let section = elements.get(info.id)
    if (!section) {
      section = frame(info.id, info.title)
      field.append(section)
      elements.set(info.id, section)
    }
    return section
  }

  let saved: Layout | null = stashed()
  let panes: PagePane[] = []
  /** Other ways in, as core last counted them. Unknown asks, which is the safe way to be wrong. */
  let channels: number | undefined
  let fromPlugins: PageInfo[] = []
  /** Which plugin pages were here at the last read. Undefined until the first one. */
  let before: Set<string> | undefined
  let known = false

  const available = (): PageInfo[] => [...CORE_PAGES, ...fromPlugins]
  const infoOf = (id: string): PageInfo | undefined => available().find((page) => page.id === id)
  const shapes = (): Record<string, Shape> => Object.fromEntries(available().map((page) => [page.id, page.shape]))

  let g: Grid = grid(root.offsetWidth, root.clientHeight)
  let placed: Placed[] = []
  let editing = false
  let selected: string | undefined

  /** The layout in force: what was saved, or the default for this window. */
  const current = (): Layout =>
    saved ?? defaultLayout(g.cols, g.rows, fromPlugins.map((page) => page.id))

  /** What is saved, written both places. `null` forgets it, which is Reset. */
  function keep(layout: Layout | null): void {
    saved = layout
    try {
      if (layout === null) localStorage.removeItem(REMEMBERED_LAYOUT)
      else localStorage.setItem(REMEMBERED_LAYOUT, JSON.stringify(layout))
    } catch {
      // A cache for the first paint. Core has the real one.
    }
    // Core checks what it is given and keeps the old one when it refuses, with a sentence
    // saying why. That sentence is shown: a layout that silently did not save is one that
    // is gone on the next launch with nothing having said so.
    void fetch('/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': token },
      body: JSON.stringify(payload(layout)),
    })
      .then(async (answer) => {
        if (answer.ok) return
        const said = ((await answer.json().catch(() => ({}))) as { said?: string }).said
        say(said ?? 'That layout could not be saved.')
      })
      .catch(() => undefined)
  }

  /**
   * One change, settled: every drawn page pinned where it is now — so moving one page never
   * reshuffles the rest — and the pages named given the sizes they were just given.
   */
  function settle(now: readonly Placed[], guides?: [number, number]): void {
    const base = rescale(current(), g.cols)
    const pinned = pin(base, now)
    const by = new Map(now.map((p) => [p.id, p]))
    keep({
      ...pinned,
      ...(guides && { guides }),
      pages: pinned.pages.map((p) => {
        const q = by.get(p.id)
        return q ? { ...p, w: q.w, h: q.h } : p
      }),
    })
    render()
  }

  // ---- drawing ------------------------------------------------------------------------------

  /** Which tier each drawn page was last drawn at, so content is rebuilt only on a change. */
  const drawnAs = new Map<string, string>()
  const hosts = new Map<string, WidgetHost>()
  let stats: LocalStats | undefined
  let statsRead = false
  /** The desktop shell's temperature sensors, read beside `stats`. Always undefined in a browser. */
  let shell: ShellTemps | undefined
  /** A reading still on its way, so a slow one is not overtaken by the next tick's. */
  let statsReading = false

  function content(info: PageInfo, section: HTMLElement, tier: Tier | undefined): void {
    const plugin = info.plugin
    if (plugin !== undefined) {
      const pane = panes.find((one) => one.id === plugin)
      if (!pane) return
      const key = `${tier ?? ''}|${JSON.stringify(pane)}`
      if (drawnAs.get(info.id) === key) return
      drawnAs.set(info.id, key)
      const host = drawPluginPage(
        section,
        pane,
        tier,
        send,
        async () => ((await readPlugins()) ?? []).find((one) => one.id === plugin),
        () => void refresh(),
      )
      if (host && moves(pane)) hosts.set(info.id, host)
      else hosts.delete(info.id)
      return
    }
    if (info.id === 'local-stats') {
      const key = `${tier ?? ''}|${JSON.stringify(stats ?? null)}|${JSON.stringify(shell ?? null)}|${String(statsRead)}`
      if (drawnAs.get(info.id) === key) return
      drawnAs.set(info.id, key)
      if (!statsRead) void readStats()
      drawLocalStats(section, statsRead ? stats : 'reading', tier, shell)
    }
  }

  function render(): void {
    g = grid(root.offsetWidth, root.clientHeight)
    const here = new Set(available().map((page) => page.id))
    const layout = current()
    const drawn = { ...layout, pages: layout.pages.filter((p) => here.has(p.id)) }
    placed = arrange(drawn, shapes(), g)
    const on = new Set(placed.map((p) => p.id))

    for (const info of available()) if (on.has(info.id)) elementOf(info)
    for (const [id, section] of elements) {
      const at = placed.find((p) => p.id === id)
      section.hidden = at === undefined
      if (!at) {
        drawnAs.delete(id)
        hosts.delete(id)
        continue
      }
      const box = px(g, at)
      section.style.left = `${String(box.left)}px`
      section.style.top = `${String(box.top)}px`
      section.style.width = `${String(box.width)}px`
      section.style.height = `${String(box.height)}px`
      section.style.transform = ''
      if (at.tier) section.dataset.tier = at.tier
      else delete section.dataset.tier
      section.classList.toggle('picked', editing && selected === id)
      const info = infoOf(id)
      // Content first: a page drawn here replaces its children, and the handles go on top.
      if (info) content(info, section, at.tier)
      chrome(section, id)
    }

    const bottom = Math.max(0, ...placed.map((p) => p.y + p.h))
    field.style.height = `${String(Math.max(root.clientHeight, g.offY * 2 + bottom * SP))}px`
    dots.style.backgroundPosition = `${String(g.offX - SP / 2)}px ${String(g.offY - SP / 2)}px`
    root.classList.toggle('compact', g.compact)
    grips()
    bar()
  }

  // ---- the two grips --------------------------------------------------------------------------

  const gripEls = ([0, 1] as const).map((which) => {
    const grip = el('div', 'grip')
    grip.setAttribute('role', 'separator')
    grip.setAttribute('aria-orientation', 'vertical')
    grip.setAttribute('aria-label', which === 0 ? 'Resize the left column' : 'Resize the right column')
    grip.tabIndex = 0
    grip.append(el('span'))
    field.append(grip)
    const drag = (dx: number, start: readonly Placed[], startGuides: [number, number], draw: boolean): ReturnType<typeof dragGuide> => {
      const moved = dragGuide(start, shapes(), startGuides, which, dx, g.cols)
      if (draw) {
        for (const p of moved.placed) {
          const section = elements.get(p.id)
          if (!section) continue
          const box = px(g, p)
          section.style.left = `${String(box.left)}px`
          section.style.width = `${String(box.width)}px`
          if (p.tier) section.dataset.tier = p.tier
        }
        placeGrip(grip, moved.guides[which], moved.placed)
      }
      return moved
    }
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || g.compact) return
      event.preventDefault()
      grip.setPointerCapture(event.pointerId)
      const scale = root.getBoundingClientRect().width / (root.offsetWidth || 1) || 1
      const sx = event.clientX
      const start = placed
      const startGuides = guidesNow()
      let last = 0
      grip.classList.add('held')
      const move = (ev: PointerEvent): void => {
        const dx = Math.round((ev.clientX - sx) / scale / SP)
        if (dx === last) return
        last = dx
        drag(dx, start, startGuides, true)
      }
      const up = (): void => {
        grip.removeEventListener('pointermove', move)
        grip.removeEventListener('pointerup', up)
        grip.removeEventListener('pointercancel', up)
        grip.classList.remove('held')
        const done = drag(last, start, startGuides, false)
        if (done.moved === 0) render()
        else settle(done.placed, done.guides)
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', up)
      grip.addEventListener('pointercancel', up)
    })
    // The keyboard's grip: one dot per press, saved each time, because there is no "up".
    grip.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const done = drag(event.key === 'ArrowLeft' ? -1 : 1, placed, guidesNow(), false)
      if (done.moved !== 0) settle(done.placed, done.guides)
    })
    return grip
  })

  const guidesNow = (): [number, number] => {
    const layout = rescale(current(), g.cols)
    return [layout.guides[0], layout.guides[1]]
  }

  /** A grip in its gutter, as tall as the pages it would move. Hidden when it moves none. */
  function placeGrip(grip: HTMLElement, at: number, among: readonly Placed[]): void {
    const attached = among.filter((p) => p.x + p.w === at || p.x === at + 1)
    grip.hidden = g.compact || attached.length === 0
    if (grip.hidden) return
    const top = Math.min(...attached.map((p) => p.y))
    const bottom = Math.max(...attached.map((p) => p.y + p.h))
    grip.style.left = `${String(g.offX + at * SP)}px`
    grip.style.top = `${String(g.offY + top * SP)}px`
    grip.style.height = `${String((bottom - top) * SP)}px`
  }

  function grips(): void {
    const guides = guidesNow()
    gripEls.forEach((grip, which) => placeGrip(grip, guides[which]!, placed))
  }

  // ---- edit view: picking a page up ------------------------------------------------------------

  /** The two handles every page carries, shown only in edit view. Made once per page. */
  function chrome(section: HTMLElement, id: string): void {
    const info = infoOf(id)
    if (!info) return
    if (!section.querySelector(':scope > .page-grab')) {
      const grab = el('button', 'page-grab')
      grab.type = 'button'
      grab.setAttribute('aria-label', `Move ${info.title}`)
      grab.addEventListener('pointerdown', (event) => lift(id, 'move', event))
      grab.addEventListener('click', () => select(id))
      grab.addEventListener('keydown', (event) => nudge(id, event))
      const size = el('button', 'page-size')
      size.type = 'button'
      size.setAttribute('aria-label', `Resize ${info.title}`)
      size.tabIndex = -1
      size.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M17 9v8H9"></path></svg>'
      size.addEventListener('pointerdown', (event) => lift(id, 'size', event))
      section.append(grab, size)
    }
    const size = section.querySelector<HTMLElement>(':scope > .page-size')!
    size.hidden = info.shape.scale === undefined || info.shape.fixed === true
    // Content a plugin page draws replaces its children, so the handles go back on top.
    const grab = section.querySelector<HTMLElement>(':scope > .page-grab')!
    if (section.lastElementChild !== size) section.append(grab, size)
  }

  function lift(id: string, mode: 'move' | 'size', event: PointerEvent): void {
    if (!editing || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const section = elements.get(id)
    const start = placed.find((p) => p.id === id)
    const info = infoOf(id)
    if (!section || !start || !info) return
    // Movement is only meaningful on the board; on the one-column stack a page can be
    // sized and removed, and its place is its order.
    if (g.compact && mode === 'move') return
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    // A window zoomed by the webview, or a display at another scale: the pointer moves in
    // screen pixels and the board is drawn in CSS ones. The ratio of the two is the fix.
    const scale = section.getBoundingClientRect().width / (section.offsetWidth || 1) || 1
    const sx = event.clientX
    const sy = event.clientY
    const others = placed.filter((p) => p.id !== id)
    const lim = limits(info.shape)
    let moved = false
    let now = { ...start, ok: true }

    const at = (ev: PointerEvent): typeof now => {
      const dx = Math.round((ev.clientX - sx) / scale / SP)
      const dy = Math.round((ev.clientY - sy) / scale / SP)
      if (dx !== 0 || dy !== 0) moved = true
      const r = { ...start }
      if (mode === 'move') {
        r.x = Math.min(Math.max(0, start.x + dx), Math.max(0, g.cols - r.w))
        r.y = Math.max(0, start.y + dy)
      } else {
        r.w = Math.min(Math.max(start.w + dx, lim.minW), Math.min(lim.maxW, g.cols - start.x))
        r.h = Math.min(Math.max(start.h + dy, lim.minH), lim.maxH)
      }
      return { ...r, ok: fits(others, r.x, r.y, r.w, r.h, g.cols) }
    }

    section.classList.add('lifted')
    const move = (ev: PointerEvent): void => {
      now = at(ev)
      if (!moved) return
      if (mode === 'move') {
        section.style.transform = `translate(${String((now.x - start.x) * SP)}px, ${String((now.y - start.y) * SP)}px)`
      } else {
        section.style.width = `${String(now.w * SP)}px`
        section.style.height = `${String(now.h * SP)}px`
      }
      section.classList.toggle('lands', now.ok)
      section.classList.toggle('blocked', !now.ok)
    }
    const up = (ev: PointerEvent): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      section.classList.remove('lifted', 'lands', 'blocked')
      now = at(ev)
      selected = id
      if (!moved || !now.ok || ev.type === 'pointercancel') {
        // Red is a refusal, and a refused drop goes back where it came from.
        render()
        return
      }
      settle(placed.map((p) => (p.id === id ? { ...p, x: now.x, y: now.y, w: now.w, h: now.h } : p)))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  /** Arrows move the focused page one dot; Shift and an arrow resizes one that scales. */
  function nudge(id: string, event: KeyboardEvent): void {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
    const at = placed.find((p) => p.id === id)
    const info = infoOf(id)
    if (!editing || !step || !at || !info) return
    event.preventDefault()
    const [dx, dy] = step as [number, number]
    const r = { ...at }
    if (event.shiftKey) {
      if (!info.shape.scale || info.shape.fixed) return
      const lim = limits(info.shape)
      r.w = Math.min(Math.max(r.w + dx, lim.minW), lim.maxW)
      r.h = Math.min(Math.max(r.h + dy, lim.minH), lim.maxH)
    } else {
      r.x += dx
      r.y += dy
    }
    const others = placed.filter((p) => p.id !== id)
    if (!fits(others, r.x, r.y, r.w, r.h, g.cols)) return
    selected = id
    settle(placed.map((p) => (p.id === id ? r : p)))
    elements.get(id)?.querySelector<HTMLElement>(':scope > .page-grab')?.focus()
  }

  function select(id: string | undefined): void {
    if (!editing) return
    selected = id
    for (const [one, section] of elements) section.classList.toggle('picked', one === id)
    bar()
  }

  // ---- the page's bar: its sizes, and a way off the board ----------------------------------------

  const pageBar = el('div', 'page-bar panel')
  pageBar.setAttribute('role', 'toolbar')
  pageBar.hidden = true
  field.append(pageBar)

  function bar(): void {
    const at = selected === undefined ? undefined : placed.find((p) => p.id === selected)
    const info = selected === undefined ? undefined : infoOf(selected)
    pageBar.hidden = !editing || !at || !info
    if (pageBar.hidden || !at || !info) return
    pageBar.setAttribute('aria-label', `${info.title} size`)
    const parts: HTMLElement[] = [el('b', undefined, info.title)]
    const tiers = TIERS.filter((t) => info.shape.tiers?.[t] !== undefined)
    if (!info.shape.fixed && tiers.length > 0) {
      const group = el('div', 'page-tiers')
      group.setAttribute('role', 'group')
      group.setAttribute('aria-label', 'Size')
      for (const tier of tiers) {
        const size = info.shape.tiers![tier]!
        const button = el('button', 'page-tier', tier)
        button.type = 'button'
        button.setAttribute('aria-pressed', String(at.tier === tier))
        button.disabled = size[0] > g.cols
        button.addEventListener('click', () => {
          const r = { ...at, w: size[0], h: size[1] }
          // A size that does not fit where the page is goes to the first place it does.
          const others = placed.filter((p) => p.id !== at.id)
          if (fits(others, r.x, r.y, r.w, r.h, g.cols)) settle(placed.map((p) => (p.id === at.id ? r : p)))
          else {
            const base = pin(rescale(current(), g.cols), others)
            keep({ ...base, pages: base.pages.map((p) => (p.id === at.id ? { id: p.id, w: r.w, h: r.h } : p)) })
            render()
          }
        })
        group.append(button)
      }
      parts.push(group)
    }
    const note =
      info.shape.fixed ? 'fixed size'
      : info.shape.scale ? `${String(at.w)}×${String(at.h)}`
      : ''
    parts.push(el('span', 'page-note', note + (at.fitted ? ' · fitted' : '')))
    if (info.removable) {
      const remove = el('button', 'quiet-button', 'Remove')
      remove.type = 'button'
      remove.addEventListener('click', () => {
        if (info.id === 'chat' && !(channels !== undefined && channels > 0)) ask(info)
        else takeOff(info)
      })
      parts.push(remove)
    }
    pageBar.replaceChildren(...parts)
    const box = px(g, at)
    let top = box.top - 52
    if (top < 8) top = box.top + box.height + 10
    pageBar.style.left = `${String(Math.max(8, Math.min(box.left, root.offsetWidth - 320)))}px`
    pageBar.style.top = `${String(top)}px`
  }

  /**
   * Chat is the one page whose absence can leave somebody with no way to talk to her — unless
   * another channel reaches her. Core counts those (`channels` on `/api/state`: enabled plugins
   * providing `channel.chat` with their keys stored), and with one or more the page just comes
   * off. With none, or a core too old to say, it asks — one line, in the bar, where the Remove
   * was pressed.
   */
  function ask(info: PageInfo): void {
    const yes = el('button', 'quiet-button danger', 'Remove')
    yes.type = 'button'
    yes.addEventListener('click', () => takeOff(info))
    const no = el('button', 'quiet-button', 'Keep')
    no.type = 'button'
    no.addEventListener('click', () => bar())
    pageBar.replaceChildren(
      el('span', 'page-note', 'Without Chat she can only be reached through another channel. Add page brings it back.'),
      yes,
      no,
    )
    no.focus()
  }

  function takeOff(info: PageInfo): void {
    if (!info.removable) return
    selected = undefined
    const base = pin(rescale(current(), g.cols), placed)
    keep({ ...base, pages: base.pages.filter((p) => p.id !== info.id) })
    render()
  }

  // ---- the corner, the pill, and Add page ---------------------------------------------------------

  const corner = document.querySelector<HTMLElement>('#corner')!
  const pill = corner.querySelector<HTMLElement>('.edit-pill')!
  const addMenu = document.querySelector<HTMLElement>('#add-menu')!
  const note = document.querySelector<HTMLElement>('#board-note')!
  let hover: number | undefined

  corner.addEventListener('pointerenter', () => {
    window.clearTimeout(hover)
    hover = window.setTimeout(() => corner.classList.add('out'), HOVER_MS)
  })
  corner.addEventListener('pointerleave', () => {
    window.clearTimeout(hover)
    if (!editing) corner.classList.remove('out')
  })

  const pillButton = (label: string, className: string, press: () => void): HTMLButtonElement => {
    const button = el('button', className, label)
    button.type = 'button'
    button.addEventListener('click', press)
    return button
  }

  function drawPill(): void {
    if (!editing) {
      pill.replaceChildren(pillButton('Edit view', 'pill-button', () => edit(true)))
      return
    }
    const add = pillButton('Add page', 'pill-button', () => void toggleAdd())
    add.setAttribute('aria-expanded', String(!addMenu.hidden))
    add.setAttribute('aria-controls', 'add-menu')
    pill.replaceChildren(
      add,
      pillButton('Reset', 'pill-button quiet', () => {
        selected = undefined
        addMenu.hidden = true
        keep(null)
        render()
        drawPill()
      }),
      pillButton('Done', 'pill-button done', () => edit(false)),
    )
  }

  interface Soon {
    id: string
    name: string
    coming_soon?: boolean
  }

  async function toggleAdd(): Promise<void> {
    if (!addMenu.hidden) {
      addMenu.hidden = true
      drawPill()
      return
    }
    const onBoard = new Set(current().pages.map((p) => p.id))
    const rows: HTMLElement[] = available()
      .filter((page) => !onBoard.has(page.id))
      .map((page) =>
        pillButton(page.title, 'add-row', () => {
          addMenu.hidden = true
          place(page)
          drawPill()
        }),
      )
    addMenu.replaceChildren(...rows)
    addMenu.hidden = false
    drawPill()
    // The registry's placeholders: pages that exist as a promise, greyed and not pressable.
    try {
      const shelf = (await (await fetch('/api/library', { headers: { 'x-alexia-token': token } })).json()) as { plugins?: Soon[] }
      for (const soon of (shelf.plugins ?? []).filter((one) => one.coming_soon === true)) {
        const row = el('div', 'add-row soon')
        row.setAttribute('aria-disabled', 'true')
        row.append(el('span', undefined, soon.name), el('span', 'add-soon', 'Coming soon'))
        addMenu.append(row)
      }
    } catch {
      // A registry that is down hides the placeholders and nothing else.
    }
    if (addMenu.childElementCount === 0) addMenu.append(el('p', 'nothing', 'Everything is on the board.'))
  }

  /** Put a page on the board at the first free spot, and say where if that is out of view. */
  function place(page: PageInfo): void {
    const base = pin(rescale(current(), g.cols), placed)
    keep({ ...base, pages: [...base.pages.filter((p) => p.id !== page.id), { id: page.id, ...arrival(page.shape) }] })
    selected = page.id
    render()
    announce(page.id)
  }

  let noteTimer: number | undefined
  /** One line, for three seconds, where it is in nobody's way. */
  function say(line: string): void {
    note.textContent = line
    note.hidden = false
    window.clearTimeout(noteTimer)
    noteTimer = window.setTimeout(() => (note.hidden = true), 3000)
  }

  function announce(id: string): void {
    const info = infoOf(id)
    const at = placed.find((p) => p.id === id)
    if (!info || !at) return
    const below = g.offY + (at.y + at.h) * SP > root.scrollTop + root.clientHeight
    say(below ? `${info.title} page added below — scroll down to see it.` : `${info.title} page added.`)
  }

  function edit(on: boolean): void {
    editing = on
    root.classList.toggle('editing', on)
    corner.classList.toggle('out', on)
    corner.classList.toggle('editing', on)
    if (!on) {
      selected = undefined
      addMenu.hidden = true
    }
    drawPill()
    render()
    if (on) pill.querySelector<HTMLElement>('button')?.focus()
  }

  // ---- reading plugins and local stats -------------------------------------------------------------

  async function readPlugins(): Promise<PagePane[] | undefined> {
    try {
      const answer = await fetch('/api/plugins', { headers: { 'x-alexia-token': token } })
      return ((await answer.json()) as { panes?: PagePane[] }).panes ?? []
    } catch {
      return undefined
    }
  }

  /**
   * `channels` again, because `refresh` runs when Settings closes — the moment a channel may
   * have been enabled, keyed or switched off. A failed read keeps the last answer.
   */
  async function readChannels(): Promise<void> {
    try {
      const answer = await fetch('/api/state', { headers: { 'x-alexia-token': token } })
      const said = ((await answer.json()) as { channels?: unknown }).channels
      channels = typeof said === 'number' ? said : undefined
    } catch {
      // The count only decides whether to ask; asking on stale information is harmless.
    }
  }

  async function refresh(): Promise<void> {
    void readChannels()
    const got = await readPlugins()
    if (got === undefined) return
    panes = got
    fromPlugins = pluginPages(panes)
    const installed = new Set(panes.map((pane) => pane.id))
    // Pages whose plugin has gone lose their element too, so nothing of theirs lingers.
    for (const [id, section] of elements) {
      const plugin = pluginOf(id)
      if (plugin !== undefined && !fromPlugins.some((page) => page.id === id)) {
        section.remove()
        elements.delete(id)
        drawnAs.delete(id)
      }
    }
    if (saved !== null) {
      const squared = reconcile(saved, installed, known ? before : undefined, fromPlugins)
      if (squared.layout !== saved) keep(squared.layout)
      render()
      for (const id of squared.added) announce(id)
    } else render()
    before = new Set(fromPlugins.map((page) => page.id))
    known = true
  }

  async function readStats(): Promise<void> {
    if (statsReading) return
    statsReading = true
    const [read, warm] = await Promise.all([
      fetch('/api/local-stats', { headers: { 'x-alexia-token': token } })
        .then(async (answer) => (answer.ok ? ((await answer.json()) as LocalStats) : undefined))
        .catch(() => undefined),
      temps(),
    ])
    stats = read
    shell = warm
    statsRead = true
    statsReading = false
    render()
  }

  /**
   * The two things on the board that change without anybody touching it: a plugin page's bar or
   * status line, and the machine on Local stats (below). Only while the window is on screen, and
   * only for pages that are actually on the board.
   */
  window.setInterval(() => {
    if (document.visibilityState !== 'visible') return
    for (const host of hosts.values()) void refreshDriven(host)
  }, 3000)

  /**
   * A plugin that crashes while its page is on the board. The supervisor marks it unhealthy the
   * moment it gives up, but nothing tells the page — so without this it went on showing its
   * last good state until something else happened to redraw it, and *Restart* was invisible at
   * exactly the moment it was needed. Only the health is compared, so a quiet board costs one
   * small read every fifteen seconds and no redraw.
   */
  const health = (list: readonly PagePane[]): string =>
    list.map((pane) => `${pane.id}:${pane.state ?? ''}:${pane.reason ?? ''}`).join('|')
  window.setInterval(() => {
    if (document.visibilityState !== 'visible' || !placed.some((p) => pluginOf(p.id) !== undefined)) return
    void readPlugins().then((got) => {
      if (got !== undefined && health(got) !== health(panes)) void refresh()
    })
  }, 15_000)
  /**
   * The machine, every three seconds — and only while Local stats is on the board and the window
   * is on screen. Every reading is a real one on core's side (a CPU difference, `ioreg`, the
   * sensors), so a page nobody can see measures nothing; its history simply starts again when
   * it is next looked at, rather than joining the gap up.
   */
  window.setInterval(() => {
    if (document.visibilityState !== 'visible' || !placed.some((p) => p.id === 'local-stats')) return
    void readStats()
  }, 3000)

  // ---- the window changing size --------------------------------------------------------------------

  let frameAsked = 0
  new ResizeObserver(() => {
    cancelAnimationFrame(frameAsked)
    frameAsked = requestAnimationFrame(render)
  }).observe(root)

  drawPill()
  render()
  root.dataset.ready = 'true'

  return {
    adopt(layout) {
      if (layout === undefined) return
      if (JSON.stringify(layout) === JSON.stringify(saved)) return
      saved = layout
      try {
        if (layout === null) localStorage.removeItem(REMEMBERED_LAYOUT)
        else localStorage.setItem(REMEMBERED_LAYOUT, JSON.stringify(layout))
      } catch {
        // The copy only saves a flash; core has just said what is true.
      }
      render()
    },
    refresh,
    reach(count) {
      channels = count
    },
    edit,
    editing: () => editing,
  }
}

