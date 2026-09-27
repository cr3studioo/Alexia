// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the pages sit on the board (D204).
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
 *   with fixed sizes steps down a size. The same for height: the board does not scroll, so
 *   pages too tall for the window together shrink until they fit. The layout that was saved is
 *   not touched: when the window grows back, so does the page.
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
  /**
   * How many dot spaces tall it was. Absent in a layout saved before heights scaled with the
   * window; {@link rescale} then takes the pages' own bottom edge as the height they were
   * arranged for, which is what they filled.
   */
  rows?: number
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

/**
 * The biggest tier whose content fits in this size, or the smallest when none does.
 *
 * The height has to fit; the width may be one dot short. A grip dragged a dot past a tier's
 * edge is not somebody asking for less — and for Chat one dot under M was S, which hides every
 * turn but the last. One dot is 25 px of a page three hundred or more across.
 */
export function tierFor(shape: Shape, w: number, h: number): Tier | undefined {
  const tiers = tiersOf(shape)
  let tier = tiers[0]
  for (const t of tiers) {
    const [tw, th] = shape.tiers![t]!
    if (tw <= w + 1 && th <= h) tier = t
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
 * biggest tier that is narrow enough. Height is only ever clamped here for a scaling page taller
 * than the whole board; fitting the pages together into the window's height is {@link squeeze}.
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
    // Still too wide: its smallest tier is wider than the board, or it declares no sizes at
    // all. Squeezed to the board, because the alternative is laid over whatever is at 0, 0.
    if (w > cols) w = Math.max(1, cols)
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
  // Only reachable when the page is wider than the board, which `fit` prevents.
  return { x: 0, y: 0 }
}

/**
 * Lay every page down: the ones somebody placed first, at or near their spot (pulled in from
 * the right edge when the window is narrower than when they were placed — never up from the
 * bottom: a page pulled up runs into the one above it, and a window that is too short is
 * {@link squeeze}'s to fix, by shrinking and keeping every column), then the rest into the
 * first gap that fits. Order is kept within each group.
 *
 * A placed page that something is in the way of is not thrown into the first free gap. On a
 * window narrower than the one it was arranged in, every column still wants at least its
 * smallest width, and the first-free-gap answer scrambled the board — Running now under
 * General, Steps under Chat. Instead the arrangement is kept:
 *
 * - **Across**, a page that was to the right of another on the same line stays to its right,
 *   pushed over when the one before it had to be wider than it was asked to be. When that runs
 *   off the right edge, the page on that line with the most room to give narrows a dot at a
 *   time — one that scales, never below its smallest width.
 * - **Down**, a page that was under another stays under it, pushed down when the one above
 *   had to be taller.
 *
 * Only a page that cannot keep its line even with every page on it at its smallest goes to the
 * first free gap: a window too narrow for the columns it was arranged in.
 */
export function pack(pages: readonly Wanted[], shapes: Readonly<Record<string, Shape>>, cols: number, rows: number): Placed[] {
  interface Item extends Placed {
    /** Where and how big it was asked to be: what "to the right of" and "under" are read from. */
    want: { x: number; y: number; w: number; h: number }
    /** Its anchor pulled in from the right edge: the least `x` it has. */
    from: number
    /** The narrowest it may be made to keep its line. Its width, for a page that does not scale. */
    least: number
  }
  const items: Item[] = []
  for (const want of pages) {
    if (!want.anchor) continue
    const shape = shapes[want.id] ?? {}
    const { w, h, fitted } = fit(shape, want, cols, rows)
    const from = Math.min(Math.max(0, want.anchor.x), Math.max(0, cols - w))
    const y = Math.max(0, want.anchor.y)
    items.push({
      id: want.id,
      x: from,
      y,
      w,
      h,
      fitted,
      want: { x: want.anchor.x, y, w: want.w, h: want.h },
      from,
      least: shape.scale && !shape.fixed ? Math.min(w, limits(shape).minW) : w,
    })
  }

  // Across. Side by side is what was asked, not what is drawn: two pages whose asked rows meet.
  const byX = [...items].sort((a, b) => a.want.x - b.want.x || a.want.y - b.want.y)
  const sameLine = (a: Item, b: Item): boolean => a.want.y < b.want.y + b.want.h + 1 && b.want.y < a.want.y + a.want.h + 1
  const leftOf = new Map(byX.map((p) => [p, byX.filter((q) => q.want.x < p.want.x && sameLine(q, p))]))
  const sweep = (): void => {
    for (const p of byX) p.x = Math.max(p.from, ...leftOf.get(p)!.map((q) => q.x + q.w + 1))
  }
  sweep()
  const homeless = new Set<Item>()
  for (let guard = 0; guard < 10_000; guard++) {
    const over = byX.filter((p) => !homeless.has(p) && p.x + p.w > cols).sort((a, b) => b.x + b.w - (a.x + a.w))[0]
    if (!over) break
    // The pages that decide where this one starts: those right up against it, and theirs.
    const chain = [over]
    for (let i = 0; i < chain.length; i++) {
      const p = chain[i]!
      for (const q of leftOf.get(p)!) if (!chain.includes(q) && q.x + q.w + 1 === p.x) chain.push(q)
    }
    const give = chain.filter((p) => p.w > p.least).sort((a, b) => b.w - b.least - (a.w - a.least))[0]
    if (give) {
      give.w -= 1
      give.fitted = true
    } else {
      // Nothing on its line can give any more, so it cannot stay on that line in this window.
      homeless.add(over)
      for (const [p, list] of leftOf) leftOf.set(p, list.filter((q) => q !== over))
    }
    sweep()
  }

  // Down. A page drawn near another across, after all that, was under it when it was asked.
  const kept = items.filter((p) => !homeless.has(p)).sort((a, b) => a.want.y - b.want.y || a.want.x - b.want.x)
  for (const [i, p] of kept.entries()) {
    const above = kept.slice(0, i).filter((q) => q.x < p.x + p.w + 1 && p.x < q.x + q.w + 1)
    p.y = Math.max(p.y, ...above.map((q) => q.y + q.h + 1))
  }

  const placed: Placed[] = kept.map(({ id, x, y, w, h, fitted }) => ({ id, x, y, w, h, tier: tierFor(shapes[id] ?? {}, w, h), fitted }))
  const rest = [
    ...items.filter((p) => homeless.has(p)).map(({ id, w, h, fitted }) => ({ id, w, h, fitted })),
    ...pages.filter((p) => !p.anchor).map((want) => ({ id: want.id, ...fit(shapes[want.id] ?? {}, want, cols, rows) })),
  ]
  for (const one of rest) {
    const at = firstFree(placed, one.w, one.h, cols, rows)
    placed.push({ ...one, ...at, tier: tierFor(shapes[one.id] ?? {}, one.w, one.h) })
  }
  // Back in the order they were given, which is the order they are drawn and tabbed through.
  const index = new Map(pages.map((p, i) => [p.id, i]))
  return placed.sort((a, b) => index.get(a.id)! - index.get(b.id)!)
}

/**
 * The narrow window: one column, page under page, in the order given. Every page takes the
 * full width it is allowed — the column for one that scales, its widest tier that fits for one
 * that does not — keeps the height it asked for, and is centred when that is not the column.
 */
export function stack(pages: readonly Wanted[], shapes: Readonly<Record<string, Shape>>, cols: number): Placed[] {
  let y = 0
  return pages.map((want) => {
    const shape = shapes[want.id] ?? {}
    const lim = limits(shape)
    const fitted = fit(shape, want, cols, Infinity)
    const w = Math.min(cols, Math.max(fitted.w, lim.maxW))
    const h = fitted.h
    const x = Math.floor((cols - w) / 2)
    const p: Placed = { id: want.id, x, y, w, h, tier: tierFor(shape, w, h), fitted: w < want.w }
    y += h + 1
    return p
  })
}

/**
 * The window is shorter than the pages: make them fit it rather than scroll.
 *
 * Every page keeps its column and its order top to bottom, and moves up until it sits one
 * gutter under whatever is above it. Then, while the lowest page still runs past the bottom,
 * the page with the most room to give on the stack that ends lowest gives one dot — a page
 * that scales loses a dot of height, a tiered one steps down to its next shorter tier. A page
 * never goes below its smallest size; when every page on that stack is already there, this is
 * as short as the board gets and what is left over is the board's to scroll.
 *
 * Nothing here is saved by itself: when the window grows back, so do the pages. Once somebody
 * moves or resizes a page, the board is saved as it is drawn — squeezed sizes included —
 * because the spots they chose were chosen against those sizes.
 */
export function squeeze(placed: readonly Placed[], shapes: Readonly<Record<string, Shape>>, rows: number): Placed[] {
  const bottom = (ps: readonly Placed[]): number => Math.max(0, ...ps.map((p) => p.y + p.h))
  if (bottom(placed) <= rows) return [...placed]
  // Top to bottom. Two pages that share a column were never side by side, so the one that was
  // higher stays higher; the columns are the original widths, which a smaller tier only narrows.
  const now = [...placed].sort((a, b) => a.y - b.y || a.x - b.x).map((p) => ({ ...p }))
  const above = now.map((p, i) => now.slice(0, i).filter((q) => p.x < q.x + q.w + 1 && p.x + p.w + 1 > q.x))
  const lift = (): void => {
    for (const [i, p] of now.entries()) p.y = Math.max(0, ...above[i]!.map((q) => q.y + q.h + 1))
  }
  /** How far a page could still shrink, and the size it goes to next. */
  const smaller = (p: Placed): { room: number; h: number; w: number } | undefined => {
    const shape = shapes[p.id] ?? {}
    if (shape.fixed) return undefined
    const lim = limits(shape)
    if (shape.scale) return p.h > lim.minH ? { room: p.h - lim.minH, h: p.h - 1, w: p.w } : undefined
    const shorter = tiersOf(shape)
      .map((t) => shape.tiers![t]!)
      .filter(([tw, th]) => th < p.h && tw <= p.w)
      .sort((a, b) => b[1] - a[1])[0]
    return shorter ? { room: p.h - lim.minH, h: shorter[1], w: shorter[0] } : undefined
  }
  lift()
  while (bottom(now) > rows) {
    // Every page on a stack that ends lowest: the lowest pages, and whatever each sits right under.
    const low = bottom(now)
    const critical = new Set(now.filter((p) => p.y + p.h === low))
    for (const p of critical) {
      for (const q of above[now.indexOf(p)]!) if (q.y + q.h + 1 === p.y) critical.add(q)
    }
    let best: { p: Placed; to: { room: number; h: number; w: number } } | undefined
    for (const p of critical) {
      const to = smaller(p)
      if (to && (!best || to.room > best.to.room)) best = { p, to }
    }
    if (!best) break
    best.p.h = best.to.h
    best.p.w = best.to.w
    best.p.fitted = true
    lift()
  }
  const index = new Map(placed.map((p, i) => [p.id, i]))
  return now
    .map((p) => ({ ...p, tier: tierFor(shapes[p.id] ?? {}, p.w, p.h) }))
    .sort((a, b) => index.get(a.id)! - index.get(b.id)!)
}

/** The most spare dots under the pages that {@link fill} takes up. More than this was left empty on purpose. */
export const FILL_ROWS = 3

/**
 * The window is a little taller than the pages: the ones that reach the lowest line stretch
 * down to the bottom of the board, so the margin under them is the same as the one above.
 *
 * A layout arranged in one window and drawn in a slightly taller one otherwise ends a dot or
 * two short, and the spare dots all go under it — a gap at the bottom that is not at the top.
 * Only a few dots ({@link FILL_ROWS}); a bigger gap is somebody's, and is left alone. Only the
 * pages on the lowest line, and only those that scale: a short page higher up keeps its size.
 */
export function fill(placed: readonly Placed[], shapes: Readonly<Record<string, Shape>>, rows: number): Placed[] {
  const low = Math.max(0, ...placed.map((p) => p.y + p.h))
  if (placed.length === 0 || low >= rows || rows - low > FILL_ROWS) return [...placed]
  return placed.map((p) => {
    const shape = shapes[p.id] ?? {}
    if (p.y + p.h !== low || !shape.scale || shape.fixed) return p
    const h = Math.min(rows - p.y, limits(shape).maxH)
    return h > p.h ? { ...p, h, tier: tierFor(shape, p.w, h) } : p
  })
}

/**
 * Draw the layout in a window of this size: scaled to it and packed, or stacked when the window
 * is narrow, and fitted to the window's height either way — squeezed when it is still too tall,
 * filled when it is a few dots short.
 */
export function arrange(layout: Layout, shapes: Readonly<Record<string, Shape>>, g: Grid): Placed[] {
  const placed = g.compact ? stack(layout.pages, shapes, g.cols) : pack(rescale(layout, g.cols, g.rows).pages, shapes, g.cols, g.rows)
  return fill(squeeze(placed, shapes, g.rows), shapes, g.rows)
}

/**
 * The same arrangement for a board of a different size: positions, sizes and the guides scale
 * in proportion and round to whole dots. Nothing here is saved; it is how the saved layout is
 * drawn in this window, and the window growing back draws what it drew before.
 *
 * **Edges are what is scaled** — each page's, with the gutter after it — not positions and
 * sizes each rounded their own way. Two pages one dot apart stay one dot apart, and pages that
 * ended on the same line, a column, still do.
 *
 * **Heights scale too**, when `rows` is given. A layout arranged on a laptop and drawn on a big
 * monitor used to keep its heights and leave a third of the screen empty under it, and a
 * shorter window closed every gap somebody had left, because {@link squeeze} lifts. The layout
 * says how tall a board it was arranged on ({@link Layout.rows}). One saved before it said so is
 * taken to have been arranged down to its lowest page, and is only scaled up: a window shorter
 * than that is still squeeze's, as it was when it was saved.
 */
export function rescale(layout: Layout, cols: number, rows?: number): Layout {
  const low = Math.max(0, ...layout.pages.map((p) => (p.anchor ? p.anchor.y + p.h : 0)))
  const tall = layout.rows ?? (rows !== undefined && low > 0 && low < rows ? low : rows)
  // One more than the board on each side: a page's far edge is scaled with the gutter after it,
  // and a page against the right edge has its gutter just past the board — which has to land
  // just past the new board, not a dot beyond it.
  const kx = layout.cols > 0 && cols !== layout.cols ? (cols + 1) / (layout.cols + 1) : 1
  const ky = rows !== undefined && tall !== undefined && tall > 0 && rows !== tall ? (rows + 1) / (tall + 1) : 1
  const sized = { v: 1 as const, cols, ...(rows !== undefined ? { rows } : layout.rows !== undefined && { rows: layout.rows }) }
  if (kx === 1 && ky === 1) return { ...layout, ...sized }
  /** One page along one axis, by its two edges: where it starts, and how far to the gutter after it. */
  const span = (at: number, size: number, k: number): [number, number] => {
    if (k === 1) return [at, size]
    const start = Math.round(at * k)
    return [start, Math.max(1, Math.round((at + size + 1) * k) - start - 1)]
  }
  // A guide is the last dot of the pages to its left, so it goes where their right edge goes.
  const guide = (g: number): number => (kx === 1 ? g : Math.round((g + 1) * kx) - 1)
  return {
    ...sized,
    guides: [guide(layout.guides[0]), guide(layout.guides[1])],
    pages: layout.pages.map((p) => {
      if (!p.anchor) return { ...p, w: kx === 1 ? p.w : Math.max(1, Math.round(p.w * kx)) }
      const [x, w] = span(p.anchor.x, p.w, kx)
      const [y, h] = span(p.anchor.y, p.h, ky)
      return { ...p, w, h, anchor: { x, y } }
    }),
  }
}

/**
 * One page given a new size where it is — the size buttons in edit view.
 *
 * It keeps its top-left corner, or, when that does not work, its top-right one (a page in the
 * right-hand column grows to the left). Pages in the way below it are pushed down, and pages
 * under those, keeping their order; a page beside it or above it is never moved, and nothing
 * is pushed past the bottom of the window. When none of that makes room the answer is
 * `undefined`, and the board says so rather than moving the page somewhere else: a size button
 * that threw the page into the first free gap and reshuffled everything was the complaint.
 */
export function grow(
  placed: readonly Placed[],
  shapes: Readonly<Record<string, Shape>>,
  id: string,
  w: number,
  h: number,
  cols: number,
  rows: number,
): Placed[] | undefined {
  const page = placed.find((p) => p.id === id)
  if (!page || w > cols) return undefined
  const close = (a: Placed, b: Placed): boolean => a.x < b.x + b.w + 1 && b.x < a.x + a.w + 1 && a.y < b.y + b.h + 1 && b.y < a.y + a.h + 1
  const starts = [...new Set([page.x, page.x + page.w - w].map((x) => Math.min(Math.max(0, x), cols - w)))]
  for (const x of starts) {
    const r: Placed = { ...page, x, w, h, tier: tierFor(shapes[id] ?? {}, w, h), fitted: false }
    const done: Placed[] = [r]
    let ok = r.y + r.h <= rows
    for (const q of [...placed].filter((p) => p.id !== id).sort((a, b) => a.y - b.y || a.x - b.x)) {
      if (!ok) break
      const moved = { ...q }
      for (let hit = done.filter((d) => close(d, moved)); hit.length > 0; hit = done.filter((d) => close(d, moved))) {
        // Only what starts at or below the page's own top is pushed; the rest is in the way.
        if (q.y < page.y) {
          ok = false
          break
        }
        moved.y = Math.max(...hit.map((d) => d.y + d.h + 1))
      }
      // A page already past the bottom of a board too short for it is not this change's doing.
      if (moved.y !== q.y && moved.y + moved.h > rows) ok = false
      done.push(moved)
    }
    if (!ok) continue
    const index = new Map(placed.map((p, i) => [p.id, i]))
    return done.sort((a, b) => index.get(a.id)! - index.get(b.id)!)
  }
  return undefined
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
