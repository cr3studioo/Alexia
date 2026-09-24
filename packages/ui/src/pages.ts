// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What can be on the board (D199): core's seven pages, and whatever the installed plugins
 * declare.
 *
 * `layout.ts` answers *where*; this file answers *what*. A page here is a name, whether it can
 * be taken off the board, and the shape it allows — the sizes it has content for and the room
 * it can stretch into. The board asks nothing else of a page, which is what lets a plugin's
 * page and the conversation sit on the same dots under the same rules.
 *
 * **Core never names a plugin (invariant 1).** Every plugin page is built from a manifest's
 * `page` (`alexia_protocol` 12), or — for a plugin written before that — from the `panel` it
 * already declared, as a single M page. The *Coming soon* rows in *Add page* come from the
 * registry. Nothing below is a list of plugins typed out.
 *
 * **One of each.** A page is its markup, and the markup carries ids the rest of the shell
 * reads by. Two conversations on one board would be two `#log`s, and `querySelector` would
 * quietly pick the first — so a page is on the board once or not at all.
 *
 * The top half is arithmetic on plain objects, tested without a browser in
 * `board.test.ts`. The bottom half draws the three pages whose content is built here rather
 * than in `index.html`: a plugin's, local stats, and price's second line.
 */

import { COMPACT_BELOW, type Layout, type Shape, type Size, type Tier, type Wanted } from './layout.js'
import { el, widget, type Rendered, type WidgetHost } from './widgets.js'

/** A page the board can hold. */
export interface PageInfo {
  id: string
  title: string
  /** General is the one page that is never taken off: it holds the way back to everything. */
  removable: boolean
  shape: Shape
  /** Whose page it is. Absent for core's own. */
  plugin?: string
}

/** The contract's `page`, as `/api/plugins` sends it. Restated here: the shell has no bundler. */
export interface PageDecl {
  title: string
  sizes: Partial<Record<Tier, { at: [number, number]; show: string[] }>>
  scale?: { min: [number, number]; max?: [number, number] }
  fixed?: boolean
}

/** The part of a `/api/plugins` pane this file reads. */
export interface PagePane {
  id: string
  name: string
  enabled: boolean
  running?: boolean
  /** The supervisor's word for a plugin that crashed past its restarts, when core sends it. */
  state?: string
  /** The supervisor's sentence for why, alongside `state`. */
  reason?: string
  settings?: Rendered[]
  panel?: { label: string; widgets: Rendered[] }
  page?: PageDecl | null
}

/** The prefix that keeps a plugin's page id from ever meeting one of core's. */
const PLUGIN = 'plugin:'

export const pageIdOf = (plugin: string): string => `${PLUGIN}${plugin}`
export const pluginOf = (page: string): string | undefined =>
  page.startsWith(PLUGIN) ? page.slice(PLUGIN.length) : undefined

/**
 * Core's pages. Every one of them scales, with its tiers as the content it switches between
 * — because the two column grips move whatever touches them, and a page that could only be
 * three exact widths would pin a grip in place.
 */
export const CORE_PAGES: readonly PageInfo[] = [
  { id: 'general', title: 'General', removable: false, shape: { scale: { min: [10, 16] } } },
  {
    id: 'chat',
    title: 'Chat',
    removable: true,
    shape: { tiers: { S: [14, 8], M: [18, 14], L: [34, 16] }, scale: { min: [14, 8] } },
  },
  { id: 'running', title: 'Running now', removable: true, shape: { tiers: { S: [8, 3], M: [12, 6] }, scale: { min: [8, 3] } } },
  { id: 'steps', title: 'Steps', removable: true, shape: { tiers: { M: [10, 6], L: [18, 14] }, scale: { min: [10, 6] } } },
  { id: 'current-step', title: 'Current step', removable: true, shape: { scale: { min: [10, 8] } } },
  {
    id: 'price',
    title: 'Price',
    removable: true,
    shape: { tiers: { S: [8, 3], M: [10, 6], L: [16, 8] }, scale: { min: [8, 3] } },
  },
  {
    id: 'local-stats',
    title: 'Local stats',
    removable: true,
    shape: { tiers: { S: [8, 4], M: [14, 10], L: [18, 14] }, scale: { min: [8, 4] } },
  },
]

/**
 * A manifest's `page`, or the page a plugin gets for having a `panel` and no `page`.
 *
 * Core builds that default itself now; this is the same default for a core that does not yet,
 * so a newer shell against an older core still shows a plugin's panel rather than nothing.
 */
export function declOf(pane: PagePane): PageDecl | undefined {
  if (pane.page) return pane.page
  if (pane.page === null || pane.panel === undefined || pane.panel.widgets.length === 0) return undefined
  return {
    title: pane.panel.label,
    sizes: { M: { at: [12, 8], show: pane.panel.widgets.map((one) => one.key) } },
    scale: { min: [10, 6] },
  }
}

/** A manifest's page as a shape the layout understands. */
export function shapeOf(decl: PageDecl): Shape {
  const tiers: Partial<Record<Tier, Size>> = {}
  for (const [tier, size] of Object.entries(decl.sizes) as [Tier, { at: [number, number] } | undefined][]) {
    if (size) tiers[tier] = size.at
  }
  return {
    tiers,
    ...(decl.scale && { scale: { min: decl.scale.min, ...(decl.scale.max && { max: decl.scale.max }) } }),
    ...(decl.fixed === true && { fixed: true }),
  }
}

/**
 * The plugin pages that can be on the board right now: installed **and enabled**. A disabled
 * plugin's page is not here, which is what hides it; its entry in the layout is untouched,
 * which is what brings it back to the same spot.
 */
export function pluginPages(panes: readonly PagePane[]): PageInfo[] {
  return panes.flatMap((pane) => {
    const decl = pane.enabled ? declOf(pane) : undefined
    return decl ? [{ id: pageIdOf(pane.id), title: decl.title, removable: true, shape: shapeOf(decl), plugin: pane.id }] : []
  })
}

/** Where the grips sit on a fresh board: about a fifth and about three quarters across. */
export const GUIDES = [0.22, 0.72] as const

/**
 * The board somebody sees before they have arranged anything: General on the left, the
 * conversation in the middle, and what she is doing on the right — the three columns the
 * shell had before it was a board, so an update does not move anything on anybody.
 *
 * Plugin pages go after, unanchored, into whatever room is left.
 */
export function defaultLayout(cols: number, rows: number, extra: readonly string[] = []): Layout {
  const wide = Math.max(cols, COMPACT_BELOW)
  const tall = Math.max(rows, 24)
  // General keeps its smallest width and the right column keeps ten dots, whatever the
  // fractions say — a guide at 22% of a laptop is a rail too narrow to read.
  const a = Math.max(10, Math.round(wide * GUIDES[0]))
  const b = Math.max(a + 15, Math.min(wide - 11, Math.round(wide * GUIDES[1])))
  const right = { x: b + 1, w: wide - b - 1 }
  const running = 4
  const steps = 9
  const price = 3
  const current = Math.max(8, tall - running - steps - price - 3)
  const pages: Wanted[] = [
    { id: 'general', w: a, h: tall, anchor: { x: 0, y: 0 } },
    { id: 'chat', w: b - a - 1, h: tall, anchor: { x: a + 1, y: 0 } },
    { id: 'running', w: right.w, h: running, anchor: { x: right.x, y: 0 } },
    { id: 'steps', w: right.w, h: steps, anchor: { x: right.x, y: running + 1 } },
    { id: 'current-step', w: right.w, h: current, anchor: { x: right.x, y: running + steps + 2 } },
    { id: 'price', w: right.w, h: price, anchor: { x: right.x, y: running + steps + current + 3 } },
    ...extra.map((id) => ({ id, w: 12, h: 8 })),
  ]
  return { v: 1, cols: wide, guides: [a, b], pages }
}

/** The size a page arrives at: its M, else its first tier, else its smallest. */
export function arrival(shape: Shape): { w: number; h: number } {
  const size = shape.tiers?.M ?? shape.tiers?.S ?? shape.tiers?.L ?? shape.scale?.min ?? [10, 6]
  return { w: size[0], h: size[1] }
}

/** Whether a layout read from anywhere — storage, core, a hand-edited file — is one this can draw. */
export function isLayout(value: unknown): value is Layout {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<Layout>
  return (
    v.v === 1 &&
    typeof v.cols === 'number' &&
    Array.isArray(v.guides) &&
    v.guides.length === 2 &&
    v.guides.every((g) => typeof g === 'number') &&
    Array.isArray(v.pages) &&
    v.pages.every((p) => typeof p === 'object' && p !== null && typeof p.id === 'string' && typeof p.w === 'number' && typeof p.h === 'number')
  )
}

/**
 * The layout, squared with which plugins are here now.
 *
 * - **Uninstalled**: the page leaves the layout entirely. A plugin that comes back is a new
 *   install and arrives like one.
 * - **Disabled**: nothing changes here. The board simply has no such page to draw, and the
 *   entry keeps its anchor for the day it is enabled again.
 * - **Newly here** — enabled since the last look, in this session — and not already in the
 *   layout: added, unanchored, so `pack` gives it the first free spot. Only *newly*: a page
 *   somebody took off the board is not put back on the next read just because its plugin is
 *   still there.
 *
 * `before` is undefined on the first read of a session, which adds nothing.
 */
export function reconcile(
  layout: Layout,
  installed: ReadonlySet<string>,
  before: ReadonlySet<string> | undefined,
  now: readonly PageInfo[],
): { layout: Layout; added: string[]; dropped: string[] } {
  const dropped = layout.pages
    .filter((p) => {
      const plugin = pluginOf(p.id)
      return plugin !== undefined && !installed.has(plugin)
    })
    .map((p) => p.id)
  const kept = layout.pages.filter((p) => !dropped.includes(p.id))
  const onBoard = new Set(kept.map((p) => p.id))
  const added = before === undefined ? [] : now.filter((page) => page.plugin !== undefined && !before.has(page.id) && !onBoard.has(page.id))
  if (dropped.length === 0 && added.length === 0) return { layout, added: [], dropped: [] }
  return {
    layout: { ...layout, pages: [...kept, ...added.map((page) => ({ id: page.id, ...arrival(page.shape) }))] },
    added: added.map((page) => page.id),
    dropped,
  }
}

/** What goes to `/api/setup`. `null` is *forget it*, which is what Reset means. */
export const payload = (layout: Layout | null): { layout: Layout | null } => ({ layout })

// ---- the pages drawn here -------------------------------------------------------------------

/** One page's frame, for the pages whose markup is not in `index.html`. */
export function frame(id: string, title: string): HTMLElement {
  const section = el('section', 'page panel')
  section.dataset.page = id
  section.setAttribute('aria-label', title)
  section.hidden = true
  return section
}

const heading = (title: string, right = ''): HTMLElement => {
  const head = el('p', 'rail-label')
  head.append(el('span', undefined, title))
  if (right !== '') head.append(el('span', 'count', right))
  return head
}

/**
 * A plugin's page: the widgets its manifest names for this size, drawn by the renderer every
 * other screen uses — the same `widget()` the plugin's own settings page calls, so a field
 * edited here is the same field, stored once (D86).
 *
 * **Never blank.** A plugin the supervisor gave up on says so and offers to start it again;
 * a size that shows nothing it recognises says that too. An empty glass rectangle is the one
 * thing a page must not be, because nobody can tell it from a page that is still loading.
 */
export function drawPluginPage(
  section: HTMLElement,
  pane: PagePane,
  tier: Tier | undefined,
  send: (path: string, body: unknown) => Promise<Record<string, unknown>>,
  fresh: () => Promise<PagePane | undefined>,
  redraw: () => void,
): WidgetHost | undefined {
  const decl = declOf(pane)
  const body = el('div', 'page-body')
  section.replaceChildren(heading(decl?.title ?? pane.name), body)

  if (pane.state === 'unhealthy') {
    const box = el('div', 'lifecycle')
    box.append(el('p', 'hint', pane.reason ?? `${pane.name} stopped and did not come back on its own.`))
    const again = el('button', 'quiet-button', 'Restart')
    again.type = 'button'
    again.addEventListener('click', () => {
      again.disabled = true
      // Core's own way back: the crash tally cleared, and the next call spawns it. Off and on
      // looked like the same thing and was not — neither touches the supervisor's state, so
      // the page came back saying exactly what it said before. `redraw` re-reads the panes,
      // which is what takes this box away.
      void send('/api/plugin', { id: pane.id, action: 'restart' }).finally(redraw)
    })
    box.append(again)
    body.append(box)
    return undefined
  }

  const shown = (tier && decl?.sizes[tier]?.show) ?? decl?.sizes.M?.show ?? []
  const all = [...(pane.settings ?? []), ...(pane.panel?.widgets ?? [])]
  const host: WidgetHost = {
    plugin: pane.id,
    // Its own screen, so a redraw on this page never finds the same field on the Plugins page.
    screen: 'page',
    send,
    root: () => section,
    redraw,
    fresh: async () => {
      const found = await fresh()
      return found === undefined ? [] : [...(found.settings ?? []), ...(found.panel?.widgets ?? [])]
    },
  }
  for (const key of shown) {
    const declared = all.find((one) => one.key === key)
    if (declared) body.append(widget(host, declared))
  }
  if (body.childElementCount === 0) body.append(el('p', 'nothing', `${pane.name} has nothing to show at this size.`))
  return host
}

/** Whether a plugin page has anything that moves, and so is worth re-reading on a timer. */
export const moves = (pane: PagePane): boolean =>
  [...(pane.settings ?? []), ...(pane.panel?.widgets ?? [])].some((one) => one.type === 'progress' || one.type === 'status')

/** How hard the system is working to find memory, in Activity Monitor's words. */
export type Pressure = 'normal' | 'warning' | 'critical'

/** Core's `SystemStats` (`system.ts`), restated: the shell has no bundler. */
export interface MachineStats {
  cpu: { percent: number | null; cores: number; model: string }
  gpu: { percent: number | null }
  memory: { used: number; total: number; pressure: Pressure | null }
  load: [number, number, number] | null
  temperature: number | null
  uptime: number
  history: { cpu: (number | null)[]; gpu: (number | null)[]; memory: (number | null)[] }
}

/** What `/api/local-stats` answers. */
export interface LocalStats {
  running: boolean
  installed: { name: string; size: number }[]
  loaded: { name: string; size: number; vram: number; until: string | null }[]
  speed: { model: string; tokensPerSecond: number } | null
  /** The machine itself. Absent only from a core older than the machine half of this page. */
  system?: MachineStats
}

/** What the desktop shell's sensors say (`desktop.ts`'s `temps()`), restated for the same reason. */
export interface ShellTemps {
  cpu: number | null
  gpu: number | null
  battery: number | null
}

/** Bytes as a person reads them. Models are gigabytes; nobody needs the last three digits. */
export const bytes = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${String(Math.round(n / 1e6))} MB` : `${String(Math.max(0, Math.round(n / 1e3)))} kB`

/**
 * Memory the way the operating system says it: in binary gigabytes, so a 16 GB Mac reads *16 GB*
 * and not the *17.2 GB* its bytes come to in thousands. A whole number stays whole.
 */
export const memoryGB = (n: number): string => {
  const gb = Math.round((n / 2 ** 30) * 10) / 10
  return `${Number.isInteger(gb) ? String(gb) : gb.toFixed(1)} GB`
}

/** *Up for 1h 11min*: the two largest units, because nobody reads the seconds of an uptime. */
export const upFor = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60)
  const [d, h, m] = [Math.floor(minutes / 1440), Math.floor(minutes / 60) % 24, minutes % 60]
  if (d > 0) return `Up for ${String(d)}d ${String(h)}h`
  if (h > 0) return `Up for ${String(h)}h ${String(m)}min`
  return `Up for ${String(m)}min`
}

/**
 * The temperatures there are numbers for, in the order a person looks for them.
 *
 * The shell's sensors first — they are the only source on a Mac or on Windows — and core's
 * reading (Linux's thermal zones) as the processor's figure where the shell has none, which is
 * always the case in a browser. A sensor with no number is not a tile: *— °C* would be a tile
 * saying nothing, and on a Mac with no GPU sensor it would say it forever.
 */
export function temperatures(system: MachineStats | undefined, shell: ShellTemps | undefined): { what: string; celsius: number }[] {
  const all: [string, number | null | undefined][] = [
    ['CPU', shell?.cpu ?? system?.temperature],
    ['GPU', shell?.gpu],
    ['Battery', shell?.battery],
  ]
  return all.flatMap(([what, celsius]) => (typeof celsius === 'number' ? [{ what, celsius: Math.round(celsius) }] : []))
}

const SVG = 'http://www.w3.org/2000/svg'

/**
 * The last few minutes as a line: an inline SVG polyline, `currentColor`, no chart library.
 *
 * The y axis is 0–100 always, not scaled to the readings — a sparkline that stretches a flat
 * 3–5 % to fill its height draws an idle machine as a busy one. Gaps (a reading that could not
 * be taken) are skipped rather than drawn as zero. Fewer than two numbers is no line.
 */
export function sparkline(history: readonly (number | null)[]): SVGSVGElement | undefined {
  const points = history.flatMap((value, i) => (value === null ? [] : [`${String(i)},${String(Math.round((100 - value) * 10) / 10)}`]))
  if (points.length < 2) return undefined
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', 'spark')
  svg.setAttribute('viewBox', `0 0 ${String(Math.max(1, history.length - 1))} 100`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('aria-hidden', 'true')
  const line = document.createElementNS(SVG, 'polyline')
  line.setAttribute('points', points.join(' '))
  line.setAttribute('fill', 'none')
  line.setAttribute('stroke', 'currentColor')
  line.setAttribute('stroke-width', '1.5')
  line.setAttribute('vector-effect', 'non-scaling-stroke')
  svg.append(line)
  return svg
}

const PRESSURE: Record<Pressure, string> = { normal: 'Normal', warning: 'Warning', critical: 'Critical' }
/** The badge's colour is its meaning: the machine's own blue, then caution, then danger. */
const BADGE: Record<Pressure, string> = { normal: 'badge', warning: 'badge warn', critical: 'badge danger' }

/**
 * Local stats (D199): the machine, and what it is doing for the models on it.
 *
 * - **S** is the two numbers that answer *is it the machine?* — the processor's share and the
 *   hottest sensor.
 * - **M** is the whole machine: a tile per temperature there is a number for, a bar each for the
 *   processor, the graphics chip and memory, and memory's pressure — the system's own verdict,
 *   which says more than a percentage does (a Mac at 90 % and *Normal* is fine).
 * - **L** adds the last few minutes as a line under each bar, the local models in memory and
 *   how fast the last one wrote, and how long the machine has been up.
 *
 * `undefined` is *core did not answer*, and is said rather than drawn as a machine with nothing
 * on it. A number that cannot be read on this platform is a row or tile left out, never a zero.
 */
export function drawLocalStats(
  section: HTMLElement,
  stats: LocalStats | undefined | 'reading',
  tier: Tier | undefined,
  shell?: ShellTemps,
): void {
  const body = el('div', 'page-body machine')
  if (stats === 'reading') {
    section.replaceChildren(heading('Local stats'), body)
    body.append(el('p', 'nothing', 'Reading…'))
    return
  }
  section.replaceChildren(heading('Local stats'), body)
  if (stats === undefined) {
    body.append(el('p', 'nothing', 'This machine could not be read just now.'))
    return
  }
  const system = stats.system
  const temps = temperatures(system, shell)
  const percent = (n: number): string => `${String(Math.round(n))} %`

  if (tier === 'S' || tier === undefined) {
    const line = el('div', 'machine-glance')
    const cpu = system?.cpu.percent ?? null
    if (cpu !== null) line.append(figure(percent(cpu), 'CPU'))
    const hottest = temps.reduce<{ what: string; celsius: number } | undefined>((a, b) => (a && a.celsius >= b.celsius ? a : b), undefined)
    if (hottest) line.append(figure(`${String(hottest.celsius)} °C`, hottest.what))
    body.append(line.childElementCount > 0 ? line : el('p', 'nothing', 'Nothing to read on this machine.'))
    return
  }

  if (temps.length > 0) {
    const tiles = el('div', 'machine-temps')
    for (const one of temps) tiles.append(figure(`${String(one.celsius)} °C`, one.what, 'machine-temp'))
    body.append(tiles)
  }
  if (system) {
    const long = tier === 'L'
    const row = (what: string, share: number | null, history: readonly (number | null)[]): void => {
      if (share === null) return
      const line = el('div', 'machine-row')
      const bar = el('div', 'bar')
      const fill = el('span')
      fill.style.width = `${String(Math.min(100, Math.max(0, Math.round(share))))}%`
      bar.append(fill)
      line.append(el('span', 'what', what), bar, el('span', 'value', percent(share)))
      const spark = long ? sparkline(history) : undefined
      if (spark) line.append(spark)
      body.append(line)
    }
    row('CPU', system.cpu.percent, system.history.cpu)
    row('GPU', system.gpu.percent, system.history.gpu)
    const { used, total, pressure } = system.memory
    // *RAM*, not the longer word: the plugin check reads a quoted plugin name in this file as
    // core naming a plugin, and there is one called that. The shorter word is also the one
    // that fits the label column.
    row('RAM', total > 0 ? (used / total) * 100 : null, system.history.memory)
    const said = el('div', 'machine-memory')
    if (pressure) said.append(el('span', BADGE[pressure], PRESSURE[pressure]))
    if (total > 0) said.append(el('span', 'when', `${memoryGB(used)} / ${memoryGB(total)}`))
    if (said.childElementCount > 0) body.append(said)
  }
  if (tier !== 'L') return

  body.append(heading('Ollama', stats.running ? 'running' : ''))
  if (!stats.running) body.append(el('p', 'nothing', 'Ollama is not running, so nothing local is loaded.'))
  else {
    if (stats.loaded.length === 0) body.append(rowOf('Nothing loaded', ''))
    for (const one of stats.loaded) body.append(rowOf(one.name, bytes(one.vram || one.size)))
  }
  // Only when core has measured one. A row saying *—* is a row saying nothing.
  // Rounded and marked as roughly: one answer's speed, not a benchmark, and a decimal would claim otherwise.
  if (stats.speed) body.append(rowOf('Last speed', `≈ ${String(Math.round(stats.speed.tokensPerSecond))} tok/s · ${stats.speed.model}`))
  if (system) body.append(el('p', 'machine-up', upFor(system.uptime)))
}

/** A big number with its name under it: S's glance, and M's temperature tiles. */
const figure = (value: string, what: string, className = 'machine-figure'): HTMLElement => {
  const made = el('div', className)
  made.append(el('span', 'machine-value', value), el('span', 'machine-what', what))
  return made
}

const rowOf = (what: string, right: string): HTMLElement => {
  const row = el('div', 'rail-row')
  row.append(el('span', 'what', what), el('span', 'when', right))
  return row
}

/**
 * Price's second line. The figure itself is `#spend`, which the conversation's code writes
 * as it always has; this adds what the figure is measured against — a bar and a sentence at
 * M, and at L the day and the month side by side.
 */
export function drawPrice(
  root: HTMLElement,
  state: { spent: number; cap?: number; today?: { spent: number; allowance: number } },
): void {
  const money = (n: number): string => `$${n.toFixed(2)}`
  const fill = root.querySelector<HTMLElement>('#spend-bar')!
  const against = root.querySelector<HTMLElement>('#spend-against')!
  const both = root.querySelector<HTMLElement>('#spend-both')!
  const day = state.today && state.today.allowance > 0 ? state.today : undefined
  const of = day ? { spent: day.spent, cap: day.allowance } : state.cap === undefined ? undefined : { spent: state.spent, cap: state.cap }
  fill.style.width = of && of.cap > 0 ? `${String(Math.min(100, Math.round((of.spent / of.cap) * 100)))}%` : '0%'
  against.textContent =
    day ? `of ${money(day.allowance)} allowed today`
    : state.cap === undefined ? 'No monthly cap set.'
    : `of ${money(state.cap)} this month`
  both.textContent =
    `This month ${money(state.spent)}${state.cap === undefined ? '' : ` of ${money(state.cap)}`}` +
    (day ? ` · today ${money(day.spent)} of ${money(day.allowance)}` : '')
}
