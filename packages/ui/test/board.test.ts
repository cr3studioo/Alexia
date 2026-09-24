// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { escapeTakes, mountBoard } from '../src/board.js'
import { arrange, dragGuide, fits, grid, type Layout, limits, MARGIN, SP } from '../src/layout.js'
import { mountPalette } from '../src/palette.js'
import {
  CORE_PAGES,
  declOf,
  defaultLayout,
  drawLocalStats,
  drawPluginPage,
  isLayout,
  type MachineStats,
  memoryGB,
  type PagePane,
  pageIdOf,
  payload,
  pluginPages,
  reconcile,
  shapeOf,
  upFor,
} from '../src/pages.js'

/**
 * The board's half that needs no browser: which pages exist, the board somebody sees before
 * arranging anything, and what happens to the layout when a plugin comes, goes or is switched
 * off. The arithmetic under the dragging is `layout.test.ts`.
 *
 * The tests that mount the real board on the real markup run under `happy-dom`, which has no
 * layout engine — so they check what board.ts *writes*, with the window's size stubbed in and
 * the pointer events dispatched by hand: the grips, a page picked up and dropped, a resize.
 */

const ui = join(import.meta.dirname, '..')
const shapes = Object.fromEntries(CORE_PAGES.map((page) => [page.id, page.shape]))

const voice: PagePane = {
  id: 'voice',
  name: 'Voice',
  enabled: true,
  settings: [{ type: 'toggle', key: 'listening', label: 'Listening' }],
  page: { title: 'Voice in/out', sizes: { S: { at: [8, 4], show: ['listening'] }, M: { at: [12, 8], show: ['listening'] } } },
}

test('the default board is the three old columns, and nothing in it touches or breaks a limit', () => {
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
    [1920, 1080],
    [1024, 700],
  ] as const) {
    const g = grid(width, height)
    const layout = defaultLayout(g.cols, g.rows)
    expect(layout.pages.map((p) => p.id)).toEqual(['general', 'chat', 'running', 'steps', 'current-step', 'price'])
    const [a, b] = layout.guides
    const at = Object.fromEntries(layout.pages.map((p) => [p.id, p]))
    // General on the left ending on the first guide, chat between, the rest after the second.
    expect(at.general!.anchor!.x + at.general!.w).toBe(a)
    expect(at.chat!.anchor!.x).toBe(a + 1)
    expect(at.chat!.anchor!.x + at.chat!.w).toBe(b)
    expect(at.running!.anchor!.x).toBe(b + 1)
    // Drawn as asked: every page at its own spot, none fitted, one clear dot between each.
    const placed = arrange(layout, shapes, g)
    for (const p of placed) {
      const lim = limits(shapes[p.id]!)
      expect(p.w, `${p.id} at ${String(width)}`).toBeGreaterThanOrEqual(lim.minW)
      expect(fits(placed.filter((q) => q.id !== p.id), p.x, p.y, p.w, p.h, g.cols), `${p.id} at ${String(width)}`).toBe(true)
    }
    expect(placed.find((p) => p.id === 'general')!.x).toBe(0)
  }
})

test('the guides sit at about a fifth and three quarters across', () => {
  const layout = defaultLayout(100, 40)
  expect(layout.guides).toEqual([22, 72])
})

test('general is the one page that cannot be removed', () => {
  expect(CORE_PAGES.filter((page) => !page.removable).map((page) => page.id)).toEqual(['general'])
  expect(limits(shapes.general!)).toMatchObject({ minW: 10, minH: 16 })
})

test('a plugin page exists while its plugin is installed and enabled, and not otherwise', () => {
  expect(pluginPages([voice]).map((page) => page.id)).toEqual([pageIdOf('voice')])
  expect(pluginPages([{ ...voice, enabled: false }])).toEqual([])
  // Its sizes are the manifest's own.
  expect(pluginPages([voice])[0]!.shape.tiers).toEqual({ S: [8, 4], M: [12, 8] })
})

test('a plugin with a panel and no page gets one M page; one with neither gets none', () => {
  const panelOnly: PagePane = {
    id: 'memory',
    name: 'Memory',
    enabled: true,
    panel: { label: 'Memory', widgets: [{ type: 'graph', key: 'graph', label: 'Graph' }] },
  }
  expect(declOf(panelOnly)?.sizes.M?.show).toEqual(['graph'])
  expect(declOf({ id: 'x', name: 'X', enabled: true })).toBeUndefined()
  // `page: null` is core saying *no page* on purpose, which a panel does not override.
  expect(declOf({ ...panelOnly, page: null })).toBeUndefined()
  expect(shapeOf(declOf(panelOnly)!).scale?.min).toEqual([10, 6])
})

const withVoice = (): Layout => ({
  ...defaultLayout(56, 34),
  pages: [...defaultLayout(56, 34).pages, { id: pageIdOf('voice'), w: 12, h: 8, anchor: { x: 20, y: 30 } }],
})

test('uninstalled: the page leaves the layout completely', () => {
  const squared = reconcile(withVoice(), new Set(), new Set([pageIdOf('voice')]), [])
  expect(squared.dropped).toEqual([pageIdOf('voice')])
  expect(squared.layout.pages.some((p) => p.id === pageIdOf('voice'))).toBe(false)
})

test('disabled: nothing changes in the layout, so enabling it brings it back to the same spot', () => {
  const layout = withVoice()
  const squared = reconcile(layout, new Set(['voice']), new Set([pageIdOf('voice')]), pluginPages([{ ...voice, enabled: false }]))
  expect(squared.layout).toBe(layout)
  // …and the board has no such page to draw, so it is not drawn.
  const drawn = arrange({ ...layout, pages: layout.pages.filter((p) => p.id !== pageIdOf('voice')) }, shapes, grid(1440, 900))
  expect(drawn.some((p) => p.id === pageIdOf('voice'))).toBe(false)
})

test('newly installed in this session: added, unanchored, at its M size', () => {
  const layout = defaultLayout(56, 34)
  const squared = reconcile(layout, new Set(['voice']), new Set(), pluginPages([voice]))
  expect(squared.added).toEqual([pageIdOf('voice')])
  expect(squared.layout.pages.at(-1)).toEqual({ id: pageIdOf('voice'), w: 12, h: 8 })
})

test('a page somebody took off is not put back on the next read, nor on the first read of a session', () => {
  const layout = defaultLayout(56, 34)
  // Seen last time, not on the board: somebody removed it.
  expect(reconcile(layout, new Set(['voice']), new Set([pageIdOf('voice')]), pluginPages([voice])).layout).toBe(layout)
  // First read: nothing to compare with, so nothing is added.
  expect(reconcile(layout, new Set(['voice']), undefined, pluginPages([voice])).layout).toBe(layout)
})

test('core pages are never dropped by a plugin read', () => {
  const layout = defaultLayout(56, 34)
  expect(reconcile(layout, new Set(), new Set(), []).layout).toBe(layout)
})

test('what is saved: the layout, or null to forget it', () => {
  const layout = defaultLayout(56, 34)
  expect(payload(layout)).toEqual({ layout })
  expect(payload(null)).toEqual({ layout: null })
  expect(JSON.parse(JSON.stringify(payload(layout)))).toEqual({ layout })
  expect(isLayout(layout)).toBe(true)
  expect(isLayout({ v: 2, cols: 1, guides: [0, 0], pages: [] })).toBe(false)
  expect(isLayout({ v: 1, cols: 1, guides: [0], pages: [] })).toBe(false)
  expect(isLayout(null)).toBe(false)
})

test('the layout key is the same in the head script and in board.ts', () => {
  const board = readFileSync(join(ui, 'src', 'board.ts'), 'utf8')
  const html = readFileSync(join(ui, 'index.html'), 'utf8')
  const key = /REMEMBERED_LAYOUT = '([^']+)'/.exec(board)?.[1]
  expect(key).toBe('alexia.layout')
  expect(html).toContain(`localStorage.getItem('${key!}')`)
})

test('every core page has its markup, once, and the UI names no plugin', () => {
  const html = readFileSync(join(ui, 'index.html'), 'utf8')
  // Local stats is drawn by pages.ts; every other core page is in the markup.
  for (const page of CORE_PAGES.filter((one) => one.id !== 'local-stats')) {
    expect(html.split(`data-page="${page.id}"`).length - 1, page.id).toBe(1)
  }
  for (const file of ['pages.ts', 'board.ts', 'layout.ts']) {
    const text = readFileSync(join(ui, 'src', file), 'utf8')
    expect(text).not.toMatch(/['"`](voice|memory|media|persona|telegram|vtuber)['"`]/i)
  }
})

test('the board mounts on the real markup, places the default pages, and saves what edit view changes', async () => {
  const html = readFileSync(join(ui, 'index.html'), 'utf8')
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, '')
  const sent: { path: string; body: unknown }[] = []
  vi.stubGlobal('fetch', (path: string, init?: { body?: string }) => {
    if (init?.body !== undefined) sent.push({ path, body: JSON.parse(init.body) })
    const answer = path === '/api/plugins' ? { panes: [voice] } : {}
    return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) })
  })
  const kept = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => kept.set(key, value),
    removeItem: (key: string) => kept.delete(key),
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
    },
  )
  const root = document.querySelector<HTMLElement>('#board')!
  Object.defineProperty(root, 'offsetWidth', { value: 1440 })
  Object.defineProperty(root, 'clientHeight', { value: 900 })

  const board = mountBoard(root, 'token')
  expect(root.dataset.ready).toBe('true')
  const general = root.querySelector<HTMLElement>('[data-page="general"]')!
  expect(general.hidden).toBe(false)
  expect(general.style.left).toBe(`${String(grid(1440, 900).offX)}px`)
  // Local stats is not on the default board.
  expect(root.querySelector('[data-page="local-stats"]')).toBeNull()
  // Both grips are on their guides.
  expect([...root.querySelectorAll<HTMLElement>('.grip')].every((grip) => !grip.hidden)).toBe(true)

  await board.refresh()
  // No saved layout, so the default takes the enabled plugin's page as well, drawn from its manifest.
  const page = root.querySelector<HTMLElement>(`[data-page="${pageIdOf('voice')}"]`)!
  expect(page.hidden).toBe(false)
  expect(page.textContent).toContain('Voice in/out')

  board.edit(true)
  expect(board.editing()).toBe(true)
  const pill = document.querySelector<HTMLElement>('.edit-pill')!
  expect([...pill.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Add page', 'Reset', 'Done'])

  // Chat asks before it goes, and goes when told.
  root.querySelector<HTMLButtonElement>('[data-page="chat"] > .page-grab')!.click()
  const bar = root.querySelector<HTMLElement>('.page-bar')!
  expect(bar.hidden).toBe(false)
  ;[...bar.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!.click()
  expect(bar.textContent).toContain('another channel')
  ;[...bar.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!.click()
  expect(root.querySelector<HTMLElement>('[data-page="chat"]')!.hidden).toBe(true)
  const saved = sent.filter((one) => one.path === '/api/setup').at(-1)!.body as { layout: Layout }
  expect(isLayout(saved.layout)).toBe(true)
  expect(saved.layout.pages.some((p) => p.id === 'chat')).toBe(false)
  expect(localStorage.getItem('alexia.layout')).toBe(JSON.stringify(saved.layout))

  // General has no Remove.
  root.querySelector<HTMLButtonElement>('[data-page="general"] > .page-grab')!.click()
  expect([...bar.querySelectorAll('button')].some((b) => b.textContent === 'Remove')).toBe(false)

  // Reset forgets it, in both places.
  ;[...pill.querySelectorAll('button')].find((b) => b.textContent === 'Reset')!.click()
  expect(sent.at(-1)).toEqual({ path: '/api/setup', body: { layout: null } })
  expect(localStorage.getItem('alexia.layout')).toBeNull()
  expect(root.querySelector<HTMLElement>('[data-page="chat"]')!.hidden).toBe(false)

  // With another channel connected there is nothing to warn about, so Chat just comes off.
  board.reach(1)
  root.querySelector<HTMLButtonElement>('[data-page="chat"] > .page-grab')!.click()
  ;[...bar.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!.click()
  expect(bar.textContent).not.toContain('another channel')
  expect(root.querySelector<HTMLElement>('[data-page="chat"]')!.hidden).toBe(true)

  board.edit(false)
  expect(root.classList.contains('editing')).toBe(false)
  vi.unstubAllGlobals()
})

/**
 * The real board on the real markup at 1440 × 900, with core stubbed: what it posts is kept in
 * `sent`, and `/api/plugins` answers with no plugins so only core pages are on it.
 */
function mountReal(): { board: ReturnType<typeof mountBoard>; root: HTMLElement; sent: { path: string; body: unknown }[] } {
  const html = readFileSync(join(ui, 'index.html'), 'utf8')
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, '')
  const sent: { path: string; body: unknown }[] = []
  vi.stubGlobal('fetch', (path: string, init?: { body?: string }) => {
    if (init?.body !== undefined) sent.push({ path, body: JSON.parse(init.body) })
    const answer = path === '/api/plugins' ? { panes: [] } : path.startsWith('/api/search') ? { hits: [] } : {}
    return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) })
  })
  const kept = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => kept.set(key, value),
    removeItem: (key: string) => kept.delete(key),
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
    },
  )
  const root = document.querySelector<HTMLElement>('#board')!
  Object.defineProperty(root, 'offsetWidth', { value: 1440 })
  Object.defineProperty(root, 'clientHeight', { value: 900 })
  return { board: mountBoard(root, 'token'), root, sent }
}

const pointerEvent = (type: string, target: Element, init: PointerEventInit): void => {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, ...init }))
}

test('launch paints the kept layout first: the head script hands it over and the first render uses it (M10-3)', () => {
  const html = readFileSync(join(ui, 'index.html'), 'utf8')
  const head = /<head>[\s\S]*?<script>([\s\S]*?)<\/script>/.exec(html)![1]!
  const g = grid(1440, 900)
  const general = { w: 11, h: 20 }
  const kept: Layout = {
    v: 1,
    cols: g.cols,
    guides: defaultLayout(g.cols, g.rows).guides,
    pages: [{ id: 'general', ...general, anchor: { x: 7, y: 3 } }],
  }
  delete document.documentElement.dataset.layout
  // The script as the page runs it, before anything else, reading what the last run left.
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'alexia.layout' ? JSON.stringify(kept) : null),
    setItem: () => undefined,
    removeItem: () => undefined,
  })
  new Function(head)()
  expect(document.documentElement.dataset.layout).toBe(JSON.stringify(kept))

  // Mounted, with nothing asked of core yet, and the board is already where it was left.
  const { root, sent } = mountReal()
  expect(sent).toEqual([])
  const page = root.querySelector<HTMLElement>('[data-page="general"]')!
  expect(page.style.left).toBe(`${String(g.offX + 7 * SP)}px`)
  expect(page.style.top).toBe(`${String(g.offY + 3 * SP)}px`)
  expect(root.querySelector<HTMLElement>('[data-page="chat"]')!.hidden).toBe(true)

  // A copy that is not a layout is not handed over, and the head script does not throw on it.
  delete document.documentElement.dataset.layout
  for (const junk of ['{', '{"v":2,"pages":[]}', 'null']) {
    vi.stubGlobal('localStorage', { getItem: () => junk, setItem: () => undefined, removeItem: () => undefined })
    new Function(head)()
    expect(document.documentElement.dataset.layout).toBeUndefined()
  }
  vi.unstubAllGlobals()
})

test('the ways into edit view: the dock after 150 ms, Tab, a long press on the empty board, the palette (M10-4)', async () => {
  vi.useFakeTimers()
  try {
    const { board, root } = mountReal()
    const corner = document.querySelector<HTMLElement>('#corner')!
    const pill = document.querySelector<HTMLElement>('.edit-pill')!
    const tab = corner.querySelector<HTMLButtonElement>('#edit-tab')!

    // Out of edit view the pill is not there at all; the dock's tab is the way in.
    expect(pill.hidden).toBe(true)
    expect(tab.getAttribute('aria-pressed')).toBe('false')

    // Resting on the dock: nothing at 149 ms, the tabs out at 150. Leaving puts them back.
    pointerEvent('pointerenter', corner, { pointerType: 'mouse' })
    vi.advanceTimersByTime(149)
    expect(corner.classList.contains('out')).toBe(false)
    vi.advanceTimersByTime(1)
    expect(corner.classList.contains('out')).toBe(true)
    pointerEvent('pointerleave', corner, { pointerType: 'mouse' })
    expect(corner.classList.contains('out')).toBe(false)
    // Passing through is not resting.
    pointerEvent('pointerenter', corner, { pointerType: 'mouse' })
    vi.advanceTimersByTime(100)
    pointerEvent('pointerleave', corner, { pointerType: 'mouse' })
    vi.advanceTimersByTime(100)
    expect(corner.classList.contains('out')).toBe(false)

    // Tab: every tab is in the tab order while tucked away, and focusing one brings them out —
    // the stylesheet's `:focus-within`, since they are never display:none.
    expect(tab.tabIndex).toBe(0)
    expect(tab.hidden).toBe(false)
    const css = readFileSync(join(ui, 'app.css'), 'utf8')
    expect(css).toMatch(/\.dock:focus-within \.dock-label\s*\{[^}]*opacity:\s*1/)
    expect(css).toMatch(/#corner\s*\{[^}]*left:\s*0;/)
    tab.click()
    expect(board.editing()).toBe(true)
    expect(tab.getAttribute('aria-pressed')).toBe('true')
    expect(pill.hidden).toBe(false)
    expect([...pill.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Add page', 'Reset', 'Done'])
    // The same tab again is Done.
    tab.click()
    expect(board.editing()).toBe(false)
    expect(pill.hidden).toBe(true)

    // A long press on the empty board, on touch. A mouse held there is not one, a finger on a
    // page is not one, and a finger that moves is scrolling.
    const field = root.querySelector<HTMLElement>('.board-field')!
    pointerEvent('pointerdown', field, { pointerType: 'mouse', clientX: 700, clientY: 880 })
    vi.advanceTimersByTime(1000)
    expect(board.editing()).toBe(false)
    pointerEvent('pointerup', field, { pointerType: 'mouse' })

    pointerEvent('pointerdown', root.querySelector('[data-page="chat"]')!, { pointerType: 'touch', clientX: 700, clientY: 200 })
    vi.advanceTimersByTime(1000)
    expect(board.editing()).toBe(false)
    pointerEvent('pointerup', field, { pointerType: 'touch' })

    pointerEvent('pointerdown', field, { pointerType: 'touch', clientX: 700, clientY: 880 })
    pointerEvent('pointermove', field, { pointerType: 'touch', clientX: 700, clientY: 840 })
    vi.advanceTimersByTime(1000)
    expect(board.editing()).toBe(false)
    pointerEvent('pointerup', field, { pointerType: 'touch' })

    pointerEvent('pointerdown', field, { pointerType: 'touch', clientX: 700, clientY: 880 })
    vi.advanceTimersByTime(200)
    pointerEvent('pointerup', field, { pointerType: 'touch' })
    vi.advanceTimersByTime(1000)
    expect(board.editing()).toBe(false)

    pointerEvent('pointerdown', field, { pointerType: 'touch', clientX: 700, clientY: 880 })
    pointerEvent('pointermove', field, { pointerType: 'touch', clientX: 703, clientY: 882 })
    vi.advanceTimersByTime(500)
    expect(board.editing()).toBe(true)
    expect(root.classList.contains('editing')).toBe(true)
    board.edit(false)

    // The palette's *Edit layout*, the way main.ts registers it.
    const main = readFileSync(join(ui, 'src', 'main.ts'), 'utf8')
    expect(main).toMatch(/label: 'Edit layout',[\s\S]{0,300}board\.edit\(true\)/)
    const palette = mountPalette('token', () => undefined, [
      { label: 'Edit layout', words: ['edit', 'layout'], run: () => board.edit(true) },
    ])
    palette.open()
    const input = document.querySelector<HTMLInputElement>('#palette-input')!
    input.value = 'layout'
    input.dispatchEvent(new Event('input'))
    await vi.advanceTimersByTimeAsync(0)
    const hit = [...document.querySelectorAll<HTMLElement>('#palette-hits .hit')].find((row) =>
      (row.textContent ?? '').includes('Edit layout'),
    )!
    hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(board.editing()).toBe(true)
  } finally {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

test('edit view: a dragged page snaps to dots, is blue where it lands and red where it cannot, and goes back from red (M10-4)', () => {
  const { board, root, sent } = mountReal()
  const general = root.querySelector<HTMLElement>('[data-page="general"]')!
  const grab = general.querySelector<HTMLElement>(':scope > .page-grab')!
  const left = general.style.left
  const top = general.style.top

  // Out of edit view a page does not lift.
  pointerEvent('pointerdown', grab, { clientX: 0, clientY: 0 })
  pointerEvent('pointermove', grab, { clientX: SP * 3, clientY: SP * 3 })
  expect(general.classList.contains('lifted')).toBe(false)
  pointerEvent('pointerup', grab, { clientX: SP * 3, clientY: SP * 3 })

  board.edit(true)
  expect(root.classList.contains('editing')).toBe(true) // what shows the dots
  expect(root.querySelector('.board-dots')).not.toBeNull()
  const saves = (): number => sent.filter((one) => one.path === '/api/setup').length
  const before = saves()

  // One dot right puts General against Chat with no clear dot between: red.
  pointerEvent('pointerdown', grab, { clientX: 0, clientY: 0 })
  pointerEvent('pointermove', grab, { clientX: SP, clientY: 0 })
  expect(general.classList.contains('lifted')).toBe(true)
  expect(general.classList.contains('blocked')).toBe(true)
  expect(general.classList.contains('lands')).toBe(false)
  expect(general.style.transform).toBe(`translate(${String(SP)}px, 0px)`)
  // Dropped on red it goes back, and nothing is saved.
  pointerEvent('pointerup', grab, { clientX: SP, clientY: 0 })
  expect(general.classList.contains('blocked')).toBe(false)
  expect(general.style.transform).toBe('')
  expect([general.style.left, general.style.top]).toEqual([left, top])
  expect(saves()).toBe(before)

  // On a board with room — General at the left edge, Price at the right, nothing between —
  // three dots right is blue and it lands there. The pointer stops between dots and the page
  // snaps to the nearest one.
  const g = grid(1440, 900)
  const drawn = arrange(defaultLayout(g.cols, g.rows), shapes, g)
  const size = (id: string): { w: number; h: number } => drawn.find((p) => p.id === id)!
  const price = size('price')
  board.adopt({
    v: 1,
    cols: g.cols,
    guides: defaultLayout(g.cols, g.rows).guides,
    pages: [
      { id: 'general', w: size('general').w, h: size('general').h, anchor: { x: 0, y: 0 } },
      { id: 'price', w: price.w, h: price.h, anchor: { x: g.cols - price.w, y: 0 } },
    ],
  })
  const priceAt = root.querySelector<HTMLElement>('[data-page="price"]')!.style.left
  const afterAdopt = saves()
  const to = { clientX: 3 * SP + 9, clientY: 11 }
  pointerEvent('pointerdown', grab, { clientX: 0, clientY: 0 })
  pointerEvent('pointermove', grab, to)
  expect(general.classList.contains('lands')).toBe(true)
  expect(general.classList.contains('blocked')).toBe(false)
  expect(general.style.transform).toBe(`translate(${String(3 * SP)}px, 0px)`)
  pointerEvent('pointerup', grab, to)
  expect(saves()).toBe(afterAdopt + 1)
  const saved = (sent.at(-1)!.body as { layout: Layout }).layout
  expect(saved.pages.find((p) => p.id === 'general')!.anchor).toEqual({ x: 3, y: 0 })
  expect(general.style.left).toBe(`${String(g.offX + 3 * SP)}px`)
  expect(general.style.transform).toBe('')
  // Nothing else moved.
  expect(root.querySelector<HTMLElement>('[data-page="price"]')!.style.left).toBe(priceAt)
  board.edit(false)
  vi.unstubAllGlobals()
})

test('Add page can always bring Chat back, even after it was removed with no other channel (M10-4)', () => {
  const { board, root, sent } = mountReal()
  board.edit(true)
  const pill = document.querySelector<HTMLElement>('.edit-pill')!
  const press = (within: Element, label: string): void =>
    [...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!.click()

  // Removing Chat with no channel asks, once, and Keep leaves it where it was.
  const chat = root.querySelector<HTMLElement>('[data-page="chat"]')!
  chat.querySelector<HTMLButtonElement>(':scope > .page-grab')!.click()
  const bar = root.querySelector<HTMLElement>('.page-bar')!
  press(bar, 'Remove')
  expect(bar.textContent).toContain('Add page brings it back')
  press(bar, 'Keep')
  expect(chat.hidden).toBe(false)
  expect(bar.textContent).not.toContain('another channel')
  press(bar, 'Remove')
  press(bar, 'Remove')
  expect(chat.hidden).toBe(true)

  // Chat is on the Add page list, and choosing it puts it back and saves that.
  press(pill, 'Add page')
  const menu = document.querySelector<HTMLElement>('#add-menu')!
  expect(menu.hidden).toBe(false)
  expect([...menu.querySelectorAll('button')].map((b) => b.textContent)).toContain('Chat')
  press(menu, 'Chat')
  expect(chat.hidden).toBe(false)
  expect(menu.hidden).toBe(true)
  const saved = (sent.filter((one) => one.path === '/api/setup').at(-1)!.body as { layout: Layout }).layout
  expect(saved.pages.some((p) => p.id === 'chat')).toBe(true)
  expect(localStorage.getItem('alexia.layout')).toBe(JSON.stringify(saved))
  expect(document.querySelector<HTMLElement>('#board-note')!.textContent).toMatch(/^Chat page added/)
  board.edit(false)
  vi.unstubAllGlobals()
})
test("the selected page's bar is in the window and over no other page: above, below, else inside its own top (M10-4)", () => {
  const { board, root } = mountReal()
  board.edit(true)
  const bar = root.querySelector<HTMLElement>('.page-bar')!
  // happy-dom has no layout, so the bar is the size board.ts assumes without one.
  const high = 44
  const wide = 320
  const boxOf = (el: HTMLElement): { left: number; top: number; right: number; bottom: number } => {
    const left = parseFloat(el.style.left)
    const top = parseFloat(el.style.top)
    const w = el === bar ? wide : parseFloat(el.style.width)
    const h = el === bar ? high : parseFloat(el.style.height)
    return { left, top, right: left + w, bottom: top + h }
  }
  const check = (id: string): { left: number; top: number; right: number; bottom: number } => {
    root.querySelector<HTMLButtonElement>(`[data-page="${id}"] > .page-grab`)!.click()
    expect(bar.hidden, id).toBe(false)
    const b = boxOf(bar)
    expect(b.top, id).toBeGreaterThanOrEqual(0)
    expect(b.bottom, id).toBeLessThanOrEqual(900)
    expect(b.left, id).toBeGreaterThanOrEqual(0)
    expect(b.right, id).toBeLessThanOrEqual(1440)
    for (const other of root.querySelectorAll<HTMLElement>('.board-field > [data-page]')) {
      if (other.dataset.page === id || other.hidden) continue
      const o = boxOf(other)
      const apart = o.left >= b.right || o.right <= b.left || o.top >= b.bottom || o.bottom <= b.top
      expect(apart, `${id}'s bar over ${String(other.dataset.page)}`).toBe(true)
    }
    return b
  }

  // Every page on the default board, the full-height ones included: below those was past the
  // bottom of the window, and below Running now was on top of Steps.
  for (const id of ['general', 'chat', 'running', 'steps', 'current-step', 'price']) check(id)
  const general = boxOf(root.querySelector<HTMLElement>('[data-page="general"]')!)
  expect(check('general').top).toBe(general.top + 8)

  // With room above, it goes above; at the right edge it is kept in from the side.
  const g = grid(1440, 900)
  const price = arrange(defaultLayout(g.cols, g.rows), shapes, g).find((p) => p.id === 'price')!
  board.adopt({
    v: 1,
    cols: g.cols,
    guides: defaultLayout(g.cols, g.rows).guides,
    pages: [
      { id: 'general', w: 11, h: 20, anchor: { x: 0, y: 0 } },
      { id: 'price', w: price.w, h: price.h, anchor: { x: g.cols - price.w, y: 12 } },
    ],
  })
  const priceBox = boxOf(root.querySelector<HTMLElement>('[data-page="price"]')!)
  const b = check('price')
  expect(b.bottom).toBe(priceBox.top - 8)
  expect(b.right).toBeLessThanOrEqual(1440 - 8)
  board.edit(false)
  vi.unstubAllGlobals()
})

test('the board runs to the bottom of the window, and the dock stays in the margin beside it', () => {
  const css = readFileSync(join(ui, 'app.css'), 'utf8')
  const rule = (selector: string): string => {
    const at = css.indexOf(`\n${selector} {`)
    expect(at, selector).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }
  // No strip under the board: its bottom margin is the grid's, the same as the top.
  expect(rule('#board')).not.toMatch(/margin-bottom/)
  expect(css).not.toMatch(/--corner-strip/)
  // A collapsed tab is narrower than the least margin layout.ts keeps beside the board.
  const collapsed = Number(/max-width:\s*(\d+)px/.exec(rule('.dock-tab'))![1])
  expect(collapsed).toBeLessThan(MARGIN)
  // Activity and Settings are in the dock, not on the General page.
  const html = readFileSync(join(ui, 'index.html'), 'utf8')
  const dock = html.slice(html.indexOf('<nav class="dock"'), html.indexOf('</nav>', html.indexOf('<nav class="dock"')))
  for (const id of ['open-control', 'open-settings', 'edit-tab']) expect(dock).toContain(`id="${id}"`)
})

test("Chat's parts each have a row of their own, so hiding the heading at S moves nothing", () => {
  const css = readFileSync(join(ui, 'app.css'), 'utf8')
  const chat = /\n#chat \{[^}]*\}/.exec(css)![0]
  // One column no wider than the page, whatever the composer's minimum is.
  expect(chat).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\);/)
  const areas = /grid-template-areas:([^;]*);/.exec(chat)![1]!.match(/'[a-z]+'/g)!.map((one) => one.slice(1, -1))
  const rows = /grid-template-rows:([^;]*);/.exec(chat)![1]!.trim().split(/\s+(?![^(]*\))/)
  expect(rows.length).toBe(areas.length)
  // The conversation is the one row that stretches.
  expect(rows[areas.indexOf('log')]).toBe('minmax(0, 1fr)')
  expect(rows.filter((row) => row !== 'auto')).toHaveLength(1)
  const parts = [
    ['chat-top', 'top'],
    ['log', 'log'],
    ['prompt', 'prompt'],
    ['paid-note', 'paid'],
    ['note', 'note'],
    ['menu', 'menu'],
    ['attached', 'attached'],
    ['ask', 'ask'],
  ]
  for (const [id, area] of parts) expect(css, id).toMatch(new RegExp(`\\n#${String(id)} \\{\\s*grid-area: ${String(area)};`))
})

test('Current step has its heading, like Running now and Steps', () => {
  const html = readFileSync(join(ui, 'index.html'), 'utf8')
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, '')
  const titles = [
    ['running', 'Running now'],
    ['steps', 'Steps'],
    ['current-step', 'Current step'],
  ]
  for (const [id, title] of titles) {
    const label = document.querySelector(`[data-page="${String(id)}"] > .rail-label`)
    expect(label?.textContent?.trim().startsWith(String(title)), id).toBe(true)
  }
})



/**
 * The real board on the real markup, at a window size the test can change. `resize` is the
 * `ResizeObserver` firing; animation frames run at once, so the redraw is done when it returns.
 */
function mountAt(
  width: number,
  height: number,
  layout?: Layout,
): {
  board: ReturnType<typeof mountBoard>
  root: HTMLElement
  sent: { path: string; body: unknown }[]
  kept: Map<string, string>
  resize: (width: number) => void
} {
  const html = readFileSync(join(ui, 'index.html'), 'utf8')
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, '')
  const sent: { path: string; body: unknown }[] = []
  vi.stubGlobal('fetch', (path: string, init?: { body?: string }) => {
    if (init?.body !== undefined) sent.push({ path, body: JSON.parse(init.body) })
    const answer = path === '/api/plugins' ? { panes: [voice] } : {}
    return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) })
  })
  const kept = new Map<string, string>()
  if (layout) kept.set('alexia.layout', JSON.stringify(layout))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => kept.set(key, value),
    removeItem: (key: string) => kept.delete(key),
  })
  let observed: (() => void) | undefined
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        observed = callback
      }
      observe(): void {}
    },
  )
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => {
    run()
    return 0
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  const root = document.querySelector<HTMLElement>('#board')!
  let wide = width
  Object.defineProperty(root, 'offsetWidth', { configurable: true, get: () => wide })
  Object.defineProperty(root, 'clientHeight', { configurable: true, get: () => height })
  const board = mountBoard(root, 'token')
  return {
    board,
    root,
    sent,
    kept,
    resize: (to) => {
      wide = to
      observed!()
    },
  }
}

const pageEl = (root: HTMLElement, id: string): HTMLElement => root.querySelector<HTMLElement>(`[data-page="${id}"]`)!
const pointer = (target: HTMLElement, type: string, x: number, y = 0): void => {
  target.dispatchEvent(new PointerEvent(type, { button: 0, clientX: x, clientY: y, pointerId: 1, bubbles: true }))
}
const saves = (sent: readonly { path: string; body: unknown }[]): Layout[] =>
  sent.filter((one) => one.path === '/api/setup').map((one) => (one.body as { layout: Layout }).layout)
const drawnAt = (root: HTMLElement): string[] =>
  CORE_PAGES.filter((one) => one.id !== 'local-stats').map((one) => {
    const style = pageEl(root, one.id).style
    return `${one.id} ${style.left} ${style.top} ${style.width} ${style.height}`
  })

test('both grips drag, the pages on them follow while the pointer moves, and the guide is saved on letting go', () => {
  const { root, sent } = mountAt(1440, 900)
  const g = grid(1440, 900)
  const layout = defaultLayout(g.cols, g.rows)
  const before = arrange(layout, shapes, g)
  const grips = [...root.querySelectorAll<HTMLElement>('.grip')]
  expect(grips).toHaveLength(2)

  for (const [which, dx] of [
    [0, 2],
    [1, -3],
  ] as const) {
    const start = saves(sent).at(-1) ?? layout
    const drawn = arrange(start, shapes, g)
    const expected = dragGuide(drawn, shapes, start.guides, which, dx, g.cols)
    expect(expected.moved, `grip ${String(which)}`).toBe(dx)
    const count = sent.length

    pointer(grips[which]!, 'pointerdown', 400)
    pointer(grips[which]!, 'pointermove', 400 + dx * SP)
    // Mid-drag: every page on the guide is already drawn at its new edge, and nothing is saved.
    for (const p of expected.placed) {
      const was = drawn.find((q) => q.id === p.id)!
      if (was.x === p.x && was.w === p.w) continue
      expect(pageEl(root, p.id).style.left, `${p.id} on grip ${String(which)}`).toBe(`${String(g.offX + p.x * SP)}px`)
      expect(pageEl(root, p.id).style.width, `${p.id} on grip ${String(which)}`).toBe(`${String(p.w * SP)}px`)
    }
    expect(grips[which]!.style.left).toBe(`${String(g.offX + expected.guides[which] * SP)}px`)
    expect(sent.length).toBe(count)

    pointer(grips[which]!, 'pointerup', 400 + dx * SP)
    const saved = saves(sent).at(-1)!
    expect(saved.guides).toEqual(expected.guides)
    for (const p of expected.placed) {
      expect(saved.pages.find((q) => q.id === p.id)).toMatchObject({ w: p.w, anchor: { x: p.x, y: p.y } })
    }
  }
  // Which pages followed: General and Chat on the first grip, Chat and the right column on the second.
  const after = saves(sent).at(-1)!
  const moved = before.filter((p) => {
    const q = after.pages.find((one) => one.id === p.id)!
    return q.w !== p.w || q.anchor!.x !== p.x
  })
  expect(moved.map((p) => p.id).sort()).toEqual(['chat', 'current-step', 'general', 'price', 'running', 'steps'])
  vi.unstubAllGlobals()
})

test('a grip moved from the keyboard goes one dot a press, and is saved each time', () => {
  const { root, sent } = mountAt(1440, 900)
  const grip = root.querySelectorAll<HTMLElement>('.grip')[1]!
  const g = grid(1440, 900)
  const was = defaultLayout(g.cols, g.rows).guides[1]
  grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  expect(saves(sent).at(-1)!.guides[1]).toBe(was - 1)
  grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  expect(saves(sent).at(-1)!.guides[1]).toBe(was - 2)
  vi.unstubAllGlobals()
})

test('a page dragged in edit view moves by transform, blur off, and its spot is written only when it lands', () => {
  const g = grid(1440, 900)
  // The default, with Current step six dots shorter: a gap above Price to drag it into.
  const base = defaultLayout(g.cols, g.rows)
  const layout: Layout = { ...base, pages: base.pages.map((p) => (p.id === 'current-step' ? { ...p, h: p.h - 6 } : p)) }
  const { board, root, sent } = mountAt(1440, 900, layout)
  board.edit(true)
  const price = pageEl(root, 'price')
  const grab = price.querySelector<HTMLElement>(':scope > .page-grab')!
  const start = arrange(layout, shapes, g).find((p) => p.id === 'price')!
  const { left, top } = price.style

  // Past the bottom of the window: the preview stops where `pack` would draw it, not below.
  pointer(grab, 'pointerdown', 600, 600)
  pointer(grab, 'pointermove', 600, 600 + 30 * SP)
  expect(price.style.transform).toBe(`translate(0px, ${String((g.rows - start.h - start.y) * SP)}px)`)
  // Up three dots, into the gap.
  pointer(grab, 'pointermove', 600, 600 - 3 * SP)
  expect(price.style.transform).toBe(`translate(0px, ${String(-3 * SP)}px)`)
  expect(price.style.left).toBe(left)
  expect(price.style.top).toBe(top)
  // `.lifted` is the rule that turns the backdrop blur off (app.css), and `.lands` the blue ring.
  expect(price.classList.contains('lifted')).toBe(true)
  expect(price.classList.contains('lands')).toBe(true)
  expect(saves(sent)).toEqual([])

  pointer(grab, 'pointerup', 600, 600 - 3 * SP)
  expect(price.classList.contains('lifted')).toBe(false)
  expect(price.style.transform).toBe('')
  expect(price.style.top).toBe(`${String(g.offY + (start.y - 3) * SP)}px`)
  expect(saves(sent)).toHaveLength(1)
  expect(saves(sent)[0]!.pages.find((p) => p.id === 'price')!.anchor).toEqual({ x: start.x, y: start.y - 3 })

  // Dropped far below the window: the preview, what is saved and what is drawn all agree.
  const bottom = g.rows - start.h
  pointer(grab, 'pointerdown', 600, 600)
  pointer(grab, 'pointermove', 600, 600 + 200 * SP)
  expect(price.style.transform).toBe(`translate(0px, ${String((bottom - (start.y - 3)) * SP)}px)`)
  pointer(grab, 'pointerup', 600, 600 + 200 * SP)
  expect(saves(sent).at(-1)!.pages.find((p) => p.id === 'price')!.anchor).toEqual({ x: start.x, y: bottom })
  expect(price.style.top).toBe(`${String(g.offY + bottom * SP)}px`)
  vi.unstubAllGlobals()
})

test('a page dropped where it does not fit goes back, and nothing is saved', () => {
  const { board, root, sent } = mountAt(1440, 900)
  board.edit(true)
  const price = pageEl(root, 'price')
  const grab = price.querySelector<HTMLElement>(':scope > .page-grab')!
  const { top } = price.style
  // Up onto Current step.
  pointer(grab, 'pointerdown', 600, 600)
  pointer(grab, 'pointermove', 600, 600 - 4 * SP)
  expect(price.classList.contains('blocked')).toBe(true)
  pointer(grab, 'pointerup', 600, 600 - 4 * SP)
  expect(price.style.transform).toBe('')
  expect(price.style.top).toBe(top)
  expect(saves(sent)).toEqual([])
  vi.unstubAllGlobals()
})

test('every page is on the board once, so no id in the document is ever there twice', async () => {
  const { board, root, resize } = mountAt(1440, 900)
  const unique = (): void => {
    const ids = [...document.querySelectorAll('[id]')].map((one) => one.id)
    expect(ids.length).toBeGreaterThan(50)
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
    for (const page of [...CORE_PAGES.map((one) => one.id), pageIdOf('voice')]) {
      expect(root.querySelectorAll(`[data-page="${page}"]`).length, page).toBeLessThanOrEqual(1)
    }
  }
  unique()
  // Everything that redraws: plugins read (twice), edit view on and off, a resize, the stack.
  await board.refresh()
  await board.refresh()
  expect(pageEl(root, pageIdOf('voice')).hidden).toBe(false)
  unique()
  board.edit(true)
  board.edit(false)
  resize(520)
  resize(1440)
  unique()
  vi.unstubAllGlobals()
})

test('General shows no Remove in its bar, and every other core page does', () => {
  const { board, root } = mountAt(1440, 900)
  board.edit(true)
  const bar = root.querySelector<HTMLElement>('.page-bar')!
  for (const page of CORE_PAGES.filter((one) => one.id !== 'local-stats')) {
    pageEl(root, page.id).querySelector<HTMLButtonElement>(':scope > .page-grab')!.click()
    expect(bar.hidden, page.id).toBe(false)
    const remove = [...bar.querySelectorAll('button')].some((b) => b.textContent === 'Remove')
    expect(remove, page.id).toBe(page.id !== 'general')
  }
  vi.unstubAllGlobals()
})

test('a window made narrow and wide again saves nothing and draws the board where it was', () => {
  const g = grid(1680, 1000)
  const layout = defaultLayout(g.cols, g.rows)
  const { root, sent, kept, resize } = mountAt(1680, 1000, layout)
  const first = drawnAt(root)
  for (const width of [1337, 900, 520]) {
    resize(width)
    expect(root.classList.contains('compact')).toBe(grid(width, 1000).compact)
  }
  resize(1680)
  expect(drawnAt(root)).toEqual(first)
  expect(saves(sent)).toEqual([])
  expect(kept.get('alexia.layout')).toBe(JSON.stringify(layout))
  vi.unstubAllGlobals()
})

test('on the one-column stack a change touches only what was changed, never the arrangement', () => {
  const g = grid(1680, 1000)
  const layout = defaultLayout(g.cols, g.rows)
  const { board, root, sent, resize } = mountAt(1680, 1000, layout)
  const first = drawnAt(root)
  resize(520)
  board.edit(true)
  const bar = root.querySelector<HTMLElement>('.page-bar')!

  // Arrows do not move a page on the stack — its place is its order.
  const grab = pageEl(root, 'price').querySelector<HTMLElement>(':scope > .page-grab')!
  grab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  expect(saves(sent)).toEqual([])

  // A size from the bar: that page's size is written, and every anchor and the width are the saved ones.
  grab.click()
  ;[...bar.querySelectorAll('button')].find((b) => b.textContent === 'S')!.click()
  const sized = saves(sent).at(-1)!
  expect(sized.cols).toBe(layout.cols)
  expect(sized.guides).toEqual(layout.guides)
  expect(sized.pages.find((p) => p.id === 'price')).toEqual({ id: 'price', w: 8, h: 3, anchor: layout.pages.find((p) => p.id === 'price')!.anchor })
  for (const p of layout.pages.filter((one) => one.id !== 'price')) expect(sized.pages.find((q) => q.id === p.id)).toEqual(p)

  // Removing one: gone, and nothing else moved.
  pageEl(root, 'steps').querySelector<HTMLButtonElement>(':scope > .page-grab')!.click()
  ;[...bar.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!.click()
  const removed = saves(sent).at(-1)!
  expect(removed.pages.map((p) => p.id)).not.toContain('steps')
  for (const p of sized.pages.filter((one) => one.id !== 'steps')) expect(removed.pages.find((q) => q.id === p.id)).toEqual(p)

  // Wide again: everything that was not changed is where it was.
  board.edit(false)
  resize(1680)
  const unchanged = (rows: string[]): string[] => rows.filter((row) => !/^(price|steps) /.test(row))
  expect(unchanged(drawnAt(root))).toEqual(unchanged(first))
  vi.unstubAllGlobals()
})

test('Escape takes one step back: edit view, then the Settings or Activity sheet, then the window', () => {
  expect(escapeTakes(true, true)).toBe('edit')
  expect(escapeTakes(true, false)).toBe('edit')
  expect(escapeTakes(false, true)).toBe('sheet')
  expect(escapeTakes(false, false)).toBe('window')
  // And the shell does what it says: the sheet step is the one that closes the sheet.
  const main = readFileSync(join(ui, 'src', 'main.ts'), 'utf8')
  const handler = /if \(event\.key === 'Escape'\) \{([\s\S]*?)\n {2}\}/.exec(main)?.[1] ?? ''
  expect(handler).toContain('escapeTakes(board.editing(), sheetOpen())')
  expect(handler).toMatch(/step === 'sheet'\) closeSheet\(\)/)
  expect(main).toMatch(/const sheetOpen = \(\): boolean => document\.body\.dataset\.view === 'settings' \|\| document\.body\.dataset\.view === 'control'/)
})

/** A Mac at rest: every number core can read, and a history of four readings. */
const machine: MachineStats = {
  cpu: { percent: 23.4, cores: 10, model: 'Apple M2 Pro' },
  gpu: { percent: 12 },
  memory: { used: 11.4 * 2 ** 30, total: 16 * 2 ** 30, pressure: 'normal' },
  load: [2, 2, 2],
  temperature: null,
  uptime: 71 * 60,
  history: { cpu: [10, 30, null, 23.4], gpu: [5, 12, 12, 12], memory: [70, 71, 71, 71] },
}
const ollama = { running: true, installed: [], loaded: [{ name: 'qwen3:8b', size: 5e9, vram: 5e9, until: null }], speed: null }
const rowsOf = (section: HTMLElement): string[] =>
  [...section.querySelectorAll('.machine-row .what')].map((one) => one.textContent ?? '')

test('local stats at S are the processor and the hottest sensor, and nothing else', () => {
  const section = document.createElement('section')
  drawLocalStats(section, { ...ollama, system: machine }, 'S', { cpu: 48.6, gpu: null, battery: 30 })
  expect(section.querySelector('.machine-glance')?.textContent).toBe('23 %CPU49 °CCPU')
  expect(section.querySelector('.bar')).toBeNull()
  expect(section.textContent).not.toContain('qwen3:8b')
})

test('local stats at M: a tile per temperature there is a number for, a bar per reading, and memory in words', () => {
  const section = document.createElement('section')
  drawLocalStats(section, { ...ollama, system: machine }, 'M', { cpu: 48.6, gpu: null, battery: 30.2 })
  // No GPU sensor on this machine (Apple Silicon, through sysinfo): no GPU tile, not "— °C".
  expect([...section.querySelectorAll('.machine-temp .machine-what')].map((one) => one.textContent)).toEqual(['CPU', 'Battery'])
  expect(rowsOf(section)).toEqual(['CPU', 'GPU', 'RAM'])
  const bars = [...section.querySelectorAll<HTMLElement>('.machine-row .bar > span')].map((one) => one.style.width)
  expect(bars).toEqual(['23%', '12%', '71%'])
  expect(section.querySelector('.machine-memory .badge')?.textContent).toBe('Normal')
  expect(section.querySelector('.machine-memory')?.textContent).toContain('11.4 GB / 16 GB')
  // The sparklines, the models and the uptime are L's.
  expect(section.querySelector('.spark')).toBeNull()
  expect(section.textContent).not.toContain('Up for')
  expect(section.textContent).not.toContain('qwen3:8b')

  // Pressure the system calls critical is the danger badge; warning is caution.
  drawLocalStats(section, { ...ollama, system: { ...machine, memory: { ...machine.memory, pressure: 'critical' } } }, 'M')
  expect(section.querySelector('.machine-memory .badge')?.className).toBe('badge danger')
  drawLocalStats(section, { ...ollama, system: { ...machine, memory: { ...machine.memory, pressure: 'warning' } } }, 'M')
  expect(section.querySelector('.machine-memory .badge')?.className).toBe('badge warn')
})

test('local stats leave out what this platform cannot read, rather than drawing it as nothing', () => {
  const section = document.createElement('section')
  const bare: MachineStats = { ...machine, gpu: { percent: null }, memory: { ...machine.memory, pressure: null } }
  // A browser (no shell) on a Mac: no temperature anywhere, so no tiles at all.
  drawLocalStats(section, { ...ollama, system: bare }, 'M')
  expect(section.querySelector('.machine-temps')).toBeNull()
  expect(rowsOf(section)).toEqual(['CPU', 'RAM'])
  expect(section.querySelector('.badge')).toBeNull()
  // Linux: core's own thermal reading stands in for the processor where the shell has none.
  drawLocalStats(section, { ...ollama, system: { ...bare, temperature: 61.3 } }, 'M')
  expect(section.querySelector('.machine-temps')?.textContent).toBe('61 °CCPU')
  // The shell's reading wins where it has one.
  drawLocalStats(section, { ...ollama, system: { ...bare, temperature: 61.3 } }, 'S', { cpu: 70, gpu: 75, battery: null })
  expect(section.querySelector('.machine-glance')?.textContent).toBe('23 %CPU75 °CGPU')
})

test('local stats at L add the last few minutes, the models in memory, and how long the machine has been up', () => {
  const section = document.createElement('section')
  drawLocalStats(section, { ...ollama, system: machine, speed: { model: 'qwen3:8b', tokensPerSecond: 29.6 } }, 'L')
  const sparks = [...section.querySelectorAll('.machine-row .spark polyline')]
  expect(sparks).toHaveLength(3)
  // 0–100 on the y axis whatever the readings, and the gap skipped rather than drawn as zero.
  expect(sparks[0]!.getAttribute('points')).toBe('0,90 1,70 3,76.6')
  expect(sparks[0]!.getAttribute('stroke')).toBe('currentColor')
  expect(section.textContent).toContain('qwen3:8b')
  expect(section.textContent).toContain('≈ 30 tok/s · qwen3:8b')
  expect(section.querySelector('.machine-up')?.textContent).toBe('Up for 1h 11min')

  // One reading is no line.
  drawLocalStats(section, { ...ollama, system: { ...machine, history: { cpu: [5], gpu: [], memory: [null, 50] } } }, 'L')
  expect(section.querySelector('.spark')).toBeNull()
})

test('local stats say the last speed with its model, and draw no speed row before one is measured (D204)', () => {
  const section = document.createElement('section')
  drawLocalStats(section, { ...ollama, system: machine }, 'L')
  expect(section.textContent).not.toContain('Last speed')

  drawLocalStats(section, { ...ollama, system: machine, speed: { model: 'qwen3:8b', tokensPerSecond: 29.6 } }, 'L')
  expect(section.textContent).toContain('Last speed')

  // No Ollama is said at L, and the machine is still there above it.
  drawLocalStats(section, { running: false, installed: [], loaded: [], speed: null, system: machine }, 'L')
  expect(section.textContent).toContain('Ollama is not running')
  expect(rowsOf(section)).toEqual(['CPU', 'GPU', 'RAM'])
})

test('uptime and memory read the way the operating system says them', () => {
  expect(upFor(59)).toBe('Up for 0min')
  expect(upFor(71 * 60)).toBe('Up for 1h 11min')
  expect(upFor(3 * 86400 + 4 * 3600 + 120)).toBe('Up for 3d 4h')
  expect(memoryGB(16 * 2 ** 30)).toBe('16 GB')
  expect(memoryGB(11.44 * 2 ** 30)).toBe('11.4 GB')
})

test('a plugin the supervisor switched off says why, and Restart asks core to clear it (D204)', async () => {
  const section = document.createElement('section')
  const sent: { path: string; body: unknown }[] = []
  const redraw = vi.fn()
  const pane: PagePane = {
    ...voice,
    state: 'unhealthy',
    reason: 'Voice stopped 3 times in a minute, so Alexia has switched it off.',
  }
  drawPluginPage(
    section,
    pane,
    'M',
    (path, body) => {
      sent.push({ path, body })
      return Promise.resolve({ ok: true })
    },
    () => Promise.resolve(undefined),
    redraw,
  )
  expect(section.textContent).toContain('3 times in a minute')
  const again = [...section.querySelectorAll('button')].find((b) => b.textContent === 'Restart')!
  again.click()
  expect(again.disabled).toBe(true)
  await vi.waitFor(() => expect(redraw).toHaveBeenCalled())
  expect(sent).toEqual([{ path: '/api/plugin', body: { id: 'voice', action: 'restart' } }])
})

/**
 * M10-G on the real board: nothing installed, then voice arriving, switched off, and gone —
 * once on a board nobody has arranged, and once on one somebody has.
 */
for (const arranged of [false, true]) {
  test(`plugins come and go on ${arranged ? 'an arranged' : 'a never-arranged'} board: added, hidden with its spot kept, gone (D204)`, async () => {
    const html = readFileSync(join(ui, 'index.html'), 'utf8')
    document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, '')
    let here: PagePane[] = []
    const sent: { path: string; body: unknown }[] = []
    vi.stubGlobal('fetch', (path: string, init?: { body?: string }) => {
      if (init?.body !== undefined) sent.push({ path, body: JSON.parse(init.body) })
      const answer = path === '/api/plugins' ? { panes: here } : {}
      return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) })
    })
    const kept = new Map<string, string>()
    if (arranged) kept.set('alexia.layout', JSON.stringify(defaultLayout(56, 34)))
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => kept.set(key, value),
      removeItem: (key: string) => kept.delete(key),
    })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
      },
    )
    const root = document.querySelector<HTMLElement>('#board')!
    Object.defineProperty(root, 'offsetWidth', { value: 1440 })
    Object.defineProperty(root, 'clientHeight', { value: 900 })
    const note = document.querySelector<HTMLElement>('#board-note')!
    const board = mountBoard(root, 'token')
    const shown = (): string[] => [...root.querySelectorAll<HTMLElement>('[data-page]')].filter((s) => !s.hidden).map((s) => s.dataset.page!)
    const savedIds = (): string[] => (JSON.parse(kept.get('alexia.layout') ?? '{"pages":[]}') as Layout).pages.map((p) => p.id)
    const id = pageIdOf('voice')

    // Nothing installed: only core's pages, and nothing said.
    await board.refresh()
    expect(shown().every((page) => CORE_PAGES.some((core) => core.id === page))).toBe(true)
    expect(shown()).toContain('general')
    expect(note.hidden).toBe(true)

    // Voice installed and enabled: its page, announced, somewhere it fits.
    here = [voice]
    await board.refresh()
    expect(shown()).toContain(id)
    expect(note.hidden).toBe(false)
    expect(note.textContent).toMatch(/^Voice in\/out page added/)
    if (arranged) expect(savedIds()).toContain(id)

    // Switched off: not drawn, and an arranged board keeps its entry for the day it is back.
    here = [{ ...voice, enabled: false }]
    await board.refresh()
    expect(shown()).not.toContain(id)
    if (arranged) expect(savedIds()).toContain(id)

    // Deleted: gone from the board, and from what is kept.
    here = []
    await board.refresh()
    expect(root.querySelector(`[data-page="${id}"]`)).toBeNull()
    expect(savedIds()).not.toContain(id)
    if (arranged) expect((sent.filter((one) => one.path === '/api/setup').at(-1)!.body as { layout: Layout }).layout.pages.map((p) => p.id)).not.toContain(id)
    vi.unstubAllGlobals()
  })
}
