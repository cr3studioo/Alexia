// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { mountBoard } from '../src/board.js'
import { arrange, fits, grid, type Layout, limits, SP } from '../src/layout.js'
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
 * off. The dragging is `board.ts` and is checked by hand; the arithmetic under it is
 * `layout.test.ts`.
 *
 * The last test mounts the real board on the real markup under `happy-dom`, which has no
 * layout engine — so it checks what board.ts *writes*, with the window's size stubbed in.
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

const pointer = (type: string, target: Element, init: PointerEventInit): void => {
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

test('the ways into edit view:the corner after 150 ms, Tab, a long press on the empty board, the palette (M10-4)', async () => {
  vi.useFakeTimers()
  try {
    const { board, root } = mountReal()
    const corner = document.querySelector<HTMLElement>('#corner')!
    const pill = corner.querySelector<HTMLElement>('.edit-pill')!

    // The pill says one thing out of edit view, and the corner holds it.
    expect([...pill.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Edit view'])

    // Resting in the corner: nothing at 149 ms, the pill at 150. Leaving puts it back.
    pointer('pointerenter', corner, { pointerType: 'mouse' })
    vi.advanceTimersByTime(149)
    expect(corner.classList.contains('out')).toBe(false)
    vi.advanceTimersByTime(1)
    expect(corner.classList.contains('out')).toBe(true)
    pointer('pointerleave', corner, { pointerType: 'mouse' })
    expect(corner.classList.contains('out')).toBe(false)
    // Passing through is not resting.
    pointer('pointerenter', corner, { pointerType: 'mouse' })
    vi.advanceTimersByTime(100)
    pointer('pointerleave', corner, { pointerType: 'mouse' })
    vi.advanceTimersByTime(100)
    expect(corner.classList.contains('out')).toBe(false)

    // Tab: the button is in the tab order while the pill is tucked away, and focusing it
    // brings the pill out — the stylesheet's `:focus-within`, since it is never display:none.
    const button = pill.querySelector<HTMLButtonElement>('button')!
    expect(button.tabIndex).toBe(0)
    expect(button.hidden).toBe(false)
    const css = readFileSync(join(ui, 'app.css'), 'utf8')
    expect(css).toMatch(/\.edit-pill:focus-within\s*\{[^}]*opacity:\s*1/)
    expect(css).toMatch(/#corner\s*\{[^}]*width:\s*48px;[^}]*height:\s*48px;/)
    expect(css).toMatch(/#corner\s*\{[^}]*left:\s*0;[^}]*bottom:\s*0;/)
    button.click()
    expect(board.editing()).toBe(true)
    board.edit(false)

    // A long press on the empty board, on touch. A mouse held there is not one, a finger on a
    // page is not one, and a finger that moves is scrolling.
    const field = root.querySelector<HTMLElement>('.board-field')!
    pointer('pointerdown', field, { pointerType: 'mouse', clientX: 700, clientY: 880 })
    vi.advanceTimersByTime(1000)
    expect(board.editing()).toBe(false)
    pointer('pointerup', field, { pointerType: 'mouse' })

    pointer('pointerdown', root.querySelector('[data-page="chat"]')!, { pointerType: 'touch', clientX: 700, clientY: 200 })
    vi.advanceTimersByTime(1000)
    expect(board.editing()).toBe(false)
    pointer('pointerup', field, { pointerType: 'touch' })

    pointer('pointerdown', field, { pointerType: 'touch', clientX: 700, clientY: 880 })
    pointer('pointermove', field, { pointerType: 'touch', clientX: 700, clientY: 840 })
    vi.advanceTimersByTime(1000)
    expect(board.editing()).toBe(false)
    pointer('pointerup', field, { pointerType: 'touch' })

    pointer('pointerdown', field, { pointerType: 'touch', clientX: 700, clientY: 880 })
    vi.advanceTimersByTime(200)
    pointer('pointerup', field, { pointerType: 'touch' })
    vi.advanceTimersByTime(1000)
    expect(board.editing()).toBe(false)

    pointer('pointerdown', field, { pointerType: 'touch', clientX: 700, clientY: 880 })
    pointer('pointermove', field, { pointerType: 'touch', clientX: 703, clientY: 882 })
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
  pointer('pointerdown', grab, { clientX: 0, clientY: 0 })
  pointer('pointermove', grab, { clientX: SP * 3, clientY: SP * 3 })
  expect(general.classList.contains('lifted')).toBe(false)
  pointer('pointerup', grab, { clientX: SP * 3, clientY: SP * 3 })

  board.edit(true)
  expect(root.classList.contains('editing')).toBe(true) // what shows the dots
  expect(root.querySelector('.board-dots')).not.toBeNull()
  const saves = (): number => sent.filter((one) => one.path === '/api/setup').length
  const before = saves()

  // One dot right puts General against Chat with no clear dot between: red.
  pointer('pointerdown', grab, { clientX: 0, clientY: 0 })
  pointer('pointermove', grab, { clientX: SP, clientY: 0 })
  expect(general.classList.contains('lifted')).toBe(true)
  expect(general.classList.contains('blocked')).toBe(true)
  expect(general.classList.contains('lands')).toBe(false)
  expect(general.style.transform).toBe(`translate(${String(SP)}px, 0px)`)
  // Dropped on red it goes back, and nothing is saved.
  pointer('pointerup', grab, { clientX: SP, clientY: 0 })
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
  pointer('pointerdown', grab, { clientX: 0, clientY: 0 })
  pointer('pointermove', grab, to)
  expect(general.classList.contains('lands')).toBe(true)
  expect(general.classList.contains('blocked')).toBe(false)
  expect(general.style.transform).toBe(`translate(${String(3 * SP)}px, 0px)`)
  pointer('pointerup', grab, to)
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

test('the pill lives in a strip of its own under the board, in both views, so it covers no page (M10-4)', () => {
  const css = readFileSync(join(ui, 'app.css'), 'utf8')
  const rule = (selector: string): string => {
    const at = css.indexOf(`\n${selector} {`)
    expect(at, selector).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }
  // The board stops above the strip, and the strip is as tall as the 48-pixel corner.
  expect(rule('#board')).toMatch(/margin-bottom:\s*var\(--corner-strip\);/)
  expect(css).toMatch(/--corner-strip:\s*3rem;/)
  // The pill sits inside it, and edit view does not move it out over the board.
  expect(rule('.edit-pill')).toMatch(/bottom:\s*var\(--space-1\);/)
  expect(css).not.toMatch(/#corner\.editing[^{]*\{/)
  // The Add page list opens from the strip, above the pill.
  expect(rule('.add-menu')).toMatch(/bottom:\s*calc\(var\(--corner-strip\)/)
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

test('local stats say the last speed with its model, and draw no speed row before one is measured (D199)', () => {
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

test('a plugin the supervisor switched off says why, and Restart asks core to clear it (D199)', async () => {
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
