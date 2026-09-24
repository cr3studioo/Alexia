// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { mountBoard } from '../src/board.js'
import { arrange, fits, grid, type Layout, limits } from '../src/layout.js'
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
