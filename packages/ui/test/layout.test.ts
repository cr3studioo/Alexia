// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import {
  arrange,
  COMPACT_BELOW,
  dragGuide,
  fit,
  fits,
  grid,
  type Layout,
  limits,
  MARGIN,
  pack,
  pin,
  type Placed,
  px,
  rescale,
  type Shape,
  SP,
  tierFor,
} from '../src/layout.js'

/**
 * The board's arithmetic, without a browser. Each test is a picture somebody would complain
 * about: margins that differ side to side, two pages touching, a page that forgot where it was
 * put, a grip that drags a page smaller than it can be drawn.
 */

const chat: Shape = { tiers: { S: [14, 8], M: [18, 16], L: [26, 20] }, scale: { min: [14, 8], max: [60, 36] } }
const task: Shape = { tiers: { S: [10, 3], M: [13, 8], L: [18, 12] } }
const voice: Shape = { tiers: { S: [4, 4] }, fixed: true }
const shapes = { chat, task, voice }

const overlaps = (a: Placed, b: Placed): boolean =>
  a.x < b.x + b.w + 1 && a.x + a.w + 1 > b.x && a.y < b.y + b.h + 1 && a.y + a.h + 1 > b.y

test('the dots are centred: the spare pixels split evenly, on an odd width too', () => {
  for (const [w, h] of [
    [1680, 1000],
    [1337, 811],
    [520, 720],
    [521, 719],
  ] as const) {
    const g = grid(w, h)
    const right = w - (g.offX + g.cols * SP)
    const bottom = h - (g.offY + g.rows * SP)
    expect(g.offX).toBeCloseTo(right)
    expect(g.offY).toBeCloseTo(bottom)
    expect(g.offX).toBeGreaterThanOrEqual(MARGIN)
    expect(g.offX).toBeLessThan(MARGIN + SP)
  }
})

test('a narrow window is compact, a desktop one is not', () => {
  expect(grid(740, 540).compact).toBe(grid(740, 540).cols < COMPACT_BELOW)
  expect(grid(520, 720).compact).toBe(true)
  expect(grid(1280, 800).compact).toBe(false)
})

test('px puts a page on its dots', () => {
  const g = grid(1337, 811)
  const r = px(g, { id: 'a', x: 2, y: 3, w: 4, h: 5, fitted: false })
  expect(r).toEqual({ left: g.offX + 50, top: g.offY + 75, width: 100, height: 125 })
})

test('a tier is the biggest one whose content fits', () => {
  expect(tierFor(chat, 30, 22)).toBe('L')
  expect(tierFor(chat, 20, 16)).toBe('M')
  expect(tierFor(chat, 14, 8)).toBe('S')
  expect(tierFor(chat, 10, 4)).toBe('S')
  expect(tierFor({}, 10, 4)).toBeUndefined()
})

test('limits come from the scale when there is one, from the tiers when not, and fixed means one size', () => {
  expect(limits(chat)).toEqual({ minW: 14, maxW: 60, minH: 8, maxH: 36 })
  expect(limits(task)).toEqual({ minW: 10, maxW: 18, minH: 3, maxH: 12 })
  expect(limits(voice)).toEqual({ minW: 4, maxW: 4, minH: 4, maxH: 4 })
})

test('fit: a scaling page narrows, a tiered one steps down, and neither is cut', () => {
  expect(fit(chat, { id: 'chat', w: 26, h: 20 }, 19, 27)).toEqual({ w: 19, h: 20, fitted: true })
  expect(fit(task, { id: 'task', w: 18, h: 12 }, 15, 27)).toEqual({ w: 13, h: 8, fitted: true })
  expect(fit(task, { id: 'task', w: 18, h: 12 }, 40, 27)).toEqual({ w: 18, h: 12, fitted: false })
  // A saved size outside the page's own limits is pulled back in, fitted or not.
  expect(fit(voice, { id: 'voice', w: 9, h: 9 }, 40, 27).w).toBe(4)
  // Narrower than even its smallest tier: squeezed to the board, never wider than it.
  expect(fit(task, { id: 'task', w: 18, h: 12 }, 8, 27)).toEqual({ w: 8, h: 3, fitted: true })
  expect(fit({}, { id: 'x', w: 40, h: 5 }, 28, 27)).toEqual({ w: 28, h: 5, fitted: true })
})

test('pages keep one clear dot between them', () => {
  const a: Placed = { id: 'a', x: 0, y: 0, w: 4, h: 4, fitted: false }
  expect(fits([a], 4, 0, 2, 2, 20)).toBe(false)
  expect(fits([a], 5, 0, 2, 2, 20)).toBe(true)
  expect(fits([a], 0, 5, 2, 2, 20)).toBe(true)
  expect(fits([a], 19, 0, 2, 2, 20)).toBe(false)
})

test('pack: placed pages stay put, the rest flow around them, and nothing touches', () => {
  const placed = pack(
    [
      { id: 'task', w: 13, h: 8 },
      { id: 'chat', w: 26, h: 20, anchor: { x: 2, y: 2 } },
      { id: 'voice', w: 4, h: 4 },
    ],
    shapes,
    65,
    38,
  )
  expect(placed.map((p) => p.id)).toEqual(['task', 'chat', 'voice'])
  const byId = Object.fromEntries(placed.map((p) => [p.id, p]))
  expect(byId.chat).toMatchObject({ x: 2, y: 2, tier: 'L' })
  for (const a of placed) for (const b of placed) if (a !== b) expect(overlaps(a, b)).toBe(false)
})

test('an anchor past the right edge of a smaller window is pulled in, not dropped', () => {
  const [p] = pack([{ id: 'task', w: 13, h: 8, anchor: { x: 50, y: 0 } }], shapes, 30, 20)
  expect(p).toMatchObject({ x: 17, y: 0 })
})

test('a page with no room in the window goes below it rather than on top of something', () => {
  const placed = pack(
    [
      { id: 'chat', w: 20, h: 10, anchor: { x: 0, y: 0 } },
      { id: 'task', w: 18, h: 12 },
    ],
    shapes,
    20,
    10,
  )
  const task = placed.find((p) => p.id === 'task')!
  expect(task.y).toBeGreaterThanOrEqual(11)
})

test('the one clear dot holds after any pack, however crowded and whatever was asked for', () => {
  // Anchors that collide, anchors past the edge, pages wider than the board: every pair still
  // has its gutter, at every width from compact's edge to a wide monitor.
  const pages = [
    { id: 'chat', w: 26, h: 20, anchor: { x: 3, y: 1 } },
    { id: 'task', w: 18, h: 12, anchor: { x: 5, y: 4 } },
    { id: 'voice', w: 4, h: 4, anchor: { x: 90, y: 0 } },
    { id: 'a', w: 7, h: 3 },
    { id: 'b', w: 12, h: 6, anchor: { x: 20, y: 2 } },
    { id: 'c', w: 40, h: 5 },
    // A page whose smallest size is wider than a narrow board.
    { id: 'wide', w: 34, h: 6 },
  ]
  const wide: Shape = { tiers: { S: [30, 4], M: [34, 6] } }
  for (const cols of [28, 33, 47, 65, 90]) {
    const placed = pack(pages, { ...shapes, wide }, cols, 30)
    expect(placed).toHaveLength(pages.length)
    for (const p of placed) {
      expect(p.x + p.w, `${p.id} at ${String(cols)}`).toBeLessThanOrEqual(cols)
      expect(fits(placed.filter((q) => q.id !== p.id), p.x, p.y, p.w, p.h, cols), `${p.id} at ${String(cols)}`).toBe(true)
    }
  }
})

test('rescale keeps the arrangement in proportion and leaves heights alone', () => {
  const layout: Layout = { v: 1, cols: 64, guides: [16, 48], pages: [{ id: 'chat', w: 32, h: 20, anchor: { x: 17, y: 2 } }] }
  const half = rescale(layout, 32)
  expect(half.guides).toEqual([8, 24])
  expect(half.pages[0]).toEqual({ id: 'chat', w: 16, h: 20, anchor: { x: 9, y: 2 } })
  expect(rescale(layout, 64)).toEqual(layout)
})

test('a window made smaller and then bigger again draws exactly what it drew before', () => {
  // The saved layout is what is drawn from, and a resize never writes it — so however lossy
  // the rounding on the way down, the way back up starts from the original, not the rounding.
  const layout: Layout = {
    v: 1,
    cols: 65,
    guides: [17, 45],
    pages: [
      { id: 'chat', w: 27, h: 20, anchor: { x: 18, y: 0 } },
      { id: 'task', w: 17, h: 8, anchor: { x: 0, y: 0 } },
      { id: 'voice', w: 4, h: 4, anchor: { x: 46, y: 0 } },
    ],
  }
  const before = JSON.stringify(layout)
  const wide = grid(1680, 1000)
  const first = arrange(layout, shapes, wide)
  for (const width of [1337, 900, 740, 520]) arrange(layout, shapes, grid(width, 1000))
  expect(arrange(layout, shapes, wide)).toEqual(first)
  expect(JSON.stringify(layout)).toBe(before)
  // And rescale itself comes back to where it started whenever the smaller width can hold it.
  expect(rescale(rescale(layout, 130), 65)).toEqual(layout)
  expect(rescale(rescale(layout, 65), 65)).toEqual(layout)
})

test('arrange stacks the pages in one column on a narrow window without touching the saved layout', () => {
  const layout: Layout = {
    v: 1,
    cols: 65,
    guides: [20, 45],
    pages: [
      { id: 'chat', w: 26, h: 20, anchor: { x: 2, y: 2 } },
      { id: 'voice', w: 4, h: 4, anchor: { x: 40, y: 2 } },
    ],
  }
  const before = JSON.stringify(layout)
  const placed = arrange(layout, shapes, grid(520, 720))
  expect(placed[0]).toMatchObject({ x: 0, y: 0, w: grid(520, 720).cols })
  expect(placed[1]).toMatchObject({ x: 0, y: placed[0]!.h + 1, w: 4 })
  expect(JSON.stringify(layout)).toBe(before)
})

test('pin writes every page’s drawn spot back as its anchor', () => {
  const layout: Layout = { v: 1, cols: 30, guides: [10, 20], pages: [{ id: 'task', w: 13, h: 8 }] }
  const pinned = pin(layout, pack(layout.pages, shapes, 30, 20))
  expect(pinned.pages[0]!.anchor).toEqual({ x: 0, y: 0 })
})

// Three columns: chat on the left ending at guide 20, task in the middle starting at 21.
const columns = (): Placed[] => [
  { id: 'chat', x: 0, y: 0, w: 20, h: 16, tier: 'M', fitted: false },
  { id: 'task', x: 21, y: 0, w: 13, h: 8, tier: 'M', fitted: false },
  { id: 'voice', x: 40, y: 0, w: 4, h: 4, tier: 'S', fitted: false },
]

test('dragging a grip resizes the pages on both sides of it', () => {
  const r = dragGuide(columns(), shapes, [20, 36], 0, 2, 65)
  expect(r.moved).toBe(2)
  expect(r.guides).toEqual([22, 36])
  expect(r.placed.find((p) => p.id === 'chat')).toMatchObject({ x: 0, w: 22 })
  expect(r.placed.find((p) => p.id === 'task')).toMatchObject({ x: 23, w: 11 })
})

test('a grip stops where a page reaches its smallest size', () => {
  // task is 13 wide and can go down to 10, so the guide can move right by 3 and no further.
  const r = dragGuide(columns(), shapes, [20, 36], 0, 8, 65)
  expect(r.moved).toBe(3)
  expect(r.placed.find((p) => p.id === 'task')!.w).toBe(10)
})

test('a grip stops where a page reaches its largest size', () => {
  // task can grow to 18 at most: moving the guide left by 5 and no further.
  const r = dragGuide(columns(), shapes, [20, 36], 0, -9, 65)
  expect(r.moved).toBe(-5)
})

test('a page not touching the guide does not move, and nothing is pushed into it', () => {
  const placed: Placed[] = [
    { id: 'chat', x: 0, y: 0, w: 20, h: 16, tier: 'M', fitted: false },
    { id: 'voice', x: 22, y: 0, w: 4, h: 4, tier: 'S', fitted: false },
  ]
  // chat may grow by one, which still leaves the one clear dot before voice, and not by three.
  const r = dragGuide(placed, shapes, [20, 36], 0, 3, 65)
  expect(r.moved).toBe(1)
  expect(r.placed.find((p) => p.id === 'voice')).toMatchObject({ x: 22 })
})

test('the two grips never cross', () => {
  const r = dragGuide([], shapes, [20, 24], 0, 10, 65)
  expect(r.guides[0]).toBeLessThan(r.guides[1] - 1)
})
