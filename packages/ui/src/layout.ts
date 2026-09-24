// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the pages sit on the board (D199).
 *
 * The board is a dot grid: a dot every {@link SP} pixels, and a page's corners sit on dots.
 * Everything a person does to the layout — dragging a page, dragging a corner, dragging one of
 * the two column grips, the window changing size under all of it — is a question this file
 * answers in whole dots, and the shell only ever multiplies by twenty-five.
 *
 * **Arithmetic and nothing else**, for the same reason as `force.ts`: no DOM, no timers, so the
 * whole of it is tested without a browser. The drawing is `board.ts`.
 *
 * Four rules, each of which is a complaint somebody would make if it broke:
 *
 * - **The dots are centred.** A window is rarely a whole number of dots wide, and the spare
 *   pixels are split evenly between the two sides — never fifteen on the left and three on the
 *   right. Same top and bottom.
 * - **Two pages never touch.** One empty dot between any two, which is the gutter, and the
 *   ground showing through it is what separates them. No rules, no borders doing that job.
 * - **A page you placed stays where you put it.** It is laid down first, at its own spot, and
 *   everything that was never placed flows into the gaps around it.
 * - **A page that does not fit is made to fit rather than cut.** One that scales narrows; one
 *   with fixed sizes steps down a size. The layout that was saved is not touched: when the
 *   window grows back, so does the page.
 */

/** Pixels between two dots. */
export const SP = 25
/** The least room kept between the outermost dots and the edge of the window, each side. */
export const MARGIN = 20
/**
 * Below this many dot spaces across, the board stops being a board and becomes one column,
 * page under page — about 740 px, which is the hotkey overlay. A free layout at that width
 * is a layout of slivers.
 */
export const COMPACT_BELOW = 28

export type Tier = 'S' | 'M' | 'L'
export const TIERS: readonly Tier[] = ['S', 'M', 'L']

/** Width then height, in dot spaces. */
export type Size = readonly [number, number]

/** What a page allows. Declared by the page, never by the layout. */
export interface Shape {
  /** The sizes it has content for. A tier left out is a size it does not offer. */
  tiers?: Partial<Record<Tier, Size>>
  /** Free resizing between these. Absent: it snaps to its tiers and nothing between. */
  scale?: { min: Size; max?: Size }
  /** One size, always. */
  fixed?: boolean
}

/** A page as the saved layout holds it: the size somebody asked for, and where, if anywhere. */
export interface Wanted {
  id: string
  w: number
  h: number
  anchor?: { x: number; y: number }
}

/** A page as it is actually drawn in this window. */
export interface Placed {
  id: string
  x: number
  y: number
  w: number
  h: number
  /** Which content it shows at this size. Absent for a page that declares no tiers. */
  tier?: Tier
  /** Drawn smaller than it asked for, because this window is too narrow for what it asked. */
  fitted: boolean
}

export interface Grid {
  /** Dot spaces across and down; there is one more dot than spaces in each direction. */
  cols: number
  rows: number
  /** The first dot's position, in pixels from the window's edge. Equal on both sides. */
  offX: number
  offY: number
  compact: boolean
}

/** What is saved, and what the board is drawn from. */
export interface Layout {
  v: 1
  /** How many dot spaces wide the window was when this was arranged. */
  cols: number
  /** The two column boundaries, as dot positions. Each sits in the gutter between columns. */
  guides: [number, number]
  pages: Wanted[]
}

export function grid(width: number, height: number): Grid {
  const cols = Math.max(0, Math.floor((width - 2 * MARGIN) / SP))
  const rows = Math.max(0, Math.floor((height - 2 * MARGIN) / SP))
  return {
    cols,
    rows,
    offX: (width - cols * SP) / 2,
    offY: (height - rows * SP) / 2,
    compact: cols < COMPACT_BELOW,
  }
}

/** A placed page in pixels, for the shell. */
export function px(g: Grid, p: Placed): { left: number; top: number; width: number; height: number } {
  return { left: g.offX + p.x * SP, top: g.offY + p.y * SP, width: p.w * SP, height: p.h * SP }
}

const tiersOf = (shape: Shape): Tier[] => TIERS.filter((t) => shape.tiers?.[t] !== undefined)

/** The biggest tier whose content fits in this size, or the smallest when none does. */
export function tierFor(shape: Shape, w: number, h: number): Tier | undefined {
  const tiers = tiersOf(shape)
  let tier = tiers[0]
  for (const t of tiers) {
    const [tw, th] = shape.tiers![t]!
    if (tw <= w && th <= h) tier = t
  }
  return tier
}

/** The narrowest and widest, shortest and tallest a page may be. */
export function limits(shape: Shape): { minW: number; maxW: number; minH: number; maxH: number } {
  const sizes = tiersOf(shape).map((t) => shape.tiers![t]!)
  const minW = shape.scale?.min[0] ?? Math.min(...sizes.map((s) => s[0]), Infinity)
  const minH = shape.scale?.min[1] ?? Math.min(...sizes.map((s) => s[1]), Infinity)
  const maxW = shape.fixed ? minW : (shape.scale?.max?.[0] ?? (shape.scale ? Infinity : Math.max(...sizes.map((s) => s[0]), minW)))
  const maxH = shape.fixed ? minH : (shape.scale?.max?.[1] ?? (shape.scale ? Infinity : Math.max(...sizes.map((s) => s[1]), minH)))
  return {
    minW: Number.isFinite(minW) ? minW : 1,
    minH: Number.isFinite(minH) ? minH : 1,
    maxW,
    maxH,
  }
}

/**
 * The size a page is drawn at on a board this big.
 *
 * Within its own limits first — a saved size from an older version of the page can be outside
 * them. Then within the board: a scaling page narrows to the board, a tiered one drops to the
 * biggest tier that is narrow enough. Height is only ever clamped for a scaling page, because
 * the board scrolls and a tiered page's height is part of what its content was drawn for.
 */
export function fit(shape: Shape, want: Wanted, cols: number, rows: number): { w: number; h: number; fitted: boolean } {
  const lim = limits(shape)
  let w = Math.min(Math.max(want.w, lim.minW), lim.maxW)
  let h = Math.min(Math.max(want.h, lim.minH), lim.maxH)
  let fitted = false
  if (w > cols) {
    fitted = true
    if (shape.scale) w = Math.max(lim.minW, cols)
    else {
      const narrow = tiersOf(shape).filter((t) => shape.tiers![t]![0] <= cols)
      const t = narrow[narrow.length - 1] ?? tiersOf(shape)[0]
      if (t) [w, h] = shape.tiers![t]!
    }
  }
  if (shape.scale && h > rows && rows >= lim.minH) {
    h = rows
    fitted = true
  }
  return { w, h, fitted }
}

/** Whether a page can go here: on the board, and one clear dot away from everything else. */
export function fits(others: readonly Placed[], x: number, y: number, w: number, h: number, cols: number): boolean {
  if (x < 0 || y < 0 || x + w > cols) return false
  for (const r of others) {
    if (x < r.x + r.w + 1 && x + w + 1 > r.x && y < r.y + r.h + 1 && y + h + 1 > r.y) return false
  }
  return true
}

/** The first free spot, row by row, preferring one that is inside the window. */
function firstFree(placed: readonly Placed[], w: number, h: number, cols: number, rows: number): { x: number; y: number } {
  for (const limit of [rows - h, Infinity]) {
    for (let y = 0; y <= Math.min(limit, 1000); y++) {
      for (let x = 0; x + w <= cols; x++) if (fits(placed, x, y, w, h, cols)) return { x, y }
    }
  }
  // Only reachable when the page is wider than the board, which `fit` already prevents.
  return { x: 0, y: 0 }
}

/**
 * Lay every page down: the ones somebody placed first, at their spot (pulled in from the right
 * edge, and up from the bottom, when the window is smaller than when they were placed), then
 * the rest into the first gap that fits. Order is kept within each group.
 */
export function pack(pages: readonly Wanted[], shapes: Readonly<Record<string, Shape>>, cols: number, rows: number): Placed[] {
  const placed: Placed[] = []
  const order = [...pages.filter((p) => p.anchor), ...pages.filter((p) => !p.anchor)]
  for (const want of order) {
    const shape = shapes[want.id] ?? {}
    const { w, h, fitted } = fit(shape, want, cols, rows)
    let at: { x: number; y: number } | undefined
    if (want.anchor) {
      const x = Math.min(Math.max(0, want.anchor.x), Math.max(0, cols - w))
      const y = Math.max(0, Math.min(want.anchor.y, rows - h))
      if (fits(placed, x, y, w, h, cols)) at = { x, y }
    }
    at ??= firstFree(placed, w, h, cols, rows)
    placed.push({ id: want.id, x: at.x, y: at.y, w, h, tier: tierFor(shape, w, h), fitted })
  }
  // Back in the order they were given, which is the order they are drawn and tabbed through.
  const index = new Map(pages.map((p, i) => [p.id, i]))
  return placed.sort((a, b) => index.get(a.id)! - index.get(b.id)!)
}

/**
 * The narrow window: one column, page under page, in the order given. Every page takes the
 * full width it is allowed, and keeps the height it asked for.
 */
export function stack(pages: readonly Wanted[], shapes: Readonly<Record<string, Shape>>, cols: number): Placed[] {
  let y = 0
  return pages.map((want) => {
    const shape = shapes[want.id] ?? {}
    const lim = limits(shape)
    const fitted = fit(shape, want, cols, Infinity)
    const w = shape.scale ? Math.max(lim.minW, Math.min(cols, lim.maxW)) : fitted.w
    const h = fitted.h
    const p: Placed = { id: want.id, x: 0, y, w, h, tier: tierFor(shape, w, h), fitted: w < want.w }
    y += h + 1
    return p
  })
}

/** Draw the layout in a window of this size: packed, or stacked when the window is narrow. */
export function arrange(layout: Layout, shapes: Readonly<Record<string, Shape>>, g: Grid): Placed[] {
  if (g.compact) return stack(layout.pages, shapes, g.cols)
  return pack(rescale(layout, g.cols).pages, shapes, g.cols, g.rows)
}

/**
 * The same arrangement for a board of a different width: positions, widths and the guides
 * scale in proportion and round to whole dots. Heights do not change — the window's height is
 * a scroll, not a squeeze.
 */
export function rescale(layout: Layout, cols: number): Layout {
  if (layout.cols === cols || layout.cols <= 0) return { ...layout, cols }
  const k = cols / layout.cols
  const at = (n: number): number => Math.round(n * k)
  return {
    v: 1,
    cols,
    guides: [at(layout.guides[0]), at(layout.guides[1])],
    pages: layout.pages.map((p) => ({
      ...p,
      w: Math.max(1, at(p.w)),
      ...(p.anchor ? { anchor: { x: at(p.anchor.x), y: p.anchor.y } } : {}),
    })),
  }
}

/** Every placed page's current spot, written back as its anchor, so one change moves nothing else. */
export function pin(layout: Layout, placed: readonly Placed[]): Layout {
  const at = new Map(placed.map((p) => [p.id, p]))
  return {
    ...layout,
    pages: layout.pages.map((p) => {
      const q = at.get(p.id)
      return q ? { ...p, anchor: { x: q.x, y: q.y } } : p
    }),
  }
}

/**
 * Drag one of the two column grips.
 *
 * A guide sits in a gutter: the pages to its left end on it, the pages to its right start one
 * dot after it. Those are the pages that move with it — the left ones grow or shrink at their
 * right edge, the right ones at their left edge. A page that does not touch the guide is not
 * attached to it and does not move.
 *
 * Returns how far it actually went, which is short of what was asked when a page reaches its
 * smallest or largest size, or would run into a page that is not attached, or the guide would
 * cross the other one. Asking for too much never produces a broken layout; it stops at the
 * last one that was fine.
 */
export function dragGuide(
  placed: readonly Placed[],
  shapes: Readonly<Record<string, Shape>>,
  guides: readonly [number, number],
  which: 0 | 1,
  dx: number,
  cols: number,
): { moved: number; guides: [number, number]; placed: Placed[] } {
  const g = guides[which]
  const left = new Set(placed.filter((p) => p.x + p.w === g).map((p) => p.id))
  const right = new Set(placed.filter((p) => p.x === g + 1).map((p) => p.id))
  const step = Math.sign(dx)
  for (let d = dx; d !== 0; d -= step) {
    const next = g + d
    const other = guides[which === 0 ? 1 : 0]
    if (next < 1 || next > cols - 1) continue
    if (which === 0 ? next >= other - 1 : next <= other + 1) continue
    const moved = placed.map((p) => {
      if (left.has(p.id)) return { ...p, w: p.w + d }
      if (right.has(p.id)) return { ...p, x: p.x + d, w: p.w - d }
      return p
    })
    const ok = moved.every((p) => {
      const lim = limits(shapes[p.id] ?? {})
      if (p.w < lim.minW || p.w > lim.maxW) return false
      return fits(
        moved.filter((q) => q.id !== p.id),
        p.x,
        p.y,
        p.w,
        p.h,
        cols,
      )
    })
    if (!ok) continue
    const out: [number, number] = [guides[0], guides[1]]
    out[which] = next
    return {
      moved: d,
      guides: out,
      placed: moved.map((p) => ({ ...p, tier: tierFor(shapes[p.id] ?? {}, p.w, p.h) })),
    }
  }
  return { moved: 0, guides: [guides[0], guides[1]], placed: [...placed] }
}
