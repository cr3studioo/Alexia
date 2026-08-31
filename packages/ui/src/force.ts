// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The force layout the `graph` widget draws (M6-11, D115).
 *
 * **Hand-written, because the page has no bundler and no framework.** The predecessor spent
 * its one heavy dependency here — `react-force-graph-2d`, and d3-force under it — and that
 * is not available to a shell that ships as plain modules. What is below is the same four
 * forces d3 uses with the same defaults, which is why a graph laid out here settles into
 * roughly the picture somebody remembers from the old dashboard rather than a different one.
 *
 * It is arithmetic and nothing else — no DOM, no canvas, no timers — so it can be tested
 * without a browser, which is the reason it is a file of its own rather than a hundred lines
 * inside `widgets.ts`.
 */

export interface Node {
  id: string
  label: string
  /** Whatever the plugin's hint says the ring means. Drawn, never simulated. */
  mark?: boolean
  x: number
  y: number
  vx: number
  vy: number
  /** How many links touch it: how hard it holds a spring, and how big it is drawn. */
  degree: number
  /** Held by a pointer. The sim leaves it exactly where the hand put it. */
  held?: boolean
}

export interface Link {
  source: Node
  target: Node
}

/** What a spring is happy at. d3-force's own default, and the old dashboard ran on it. */
export const DISTANCE = 30
/** Every node pushes every other away. Negative is a push; d3's default is -30. */
const CHARGE = -30
/** How much of its velocity a node keeps each tick. d3's `velocityDecay` is 0.4. */
const KEEP = 0.6
/** How fast the whole thing cools. d3's default, which reaches rest in about 300 ticks. */
const COOLING = 0.0228
/** Cold enough that nothing visible is still moving. */
export const COLD = 0.001

/** Warm from a standing start: a new graph, or one somebody has just dragged. */
export const WARM = 1

/**
 * Where a node starts before anything has pushed it.
 *
 * The same phyllotaxis spiral d3 uses, and for the same reason: it fills the plane evenly
 * with no two nodes on top of each other, and it is **deterministic**. Random starts would
 * mean the same memory drew a different picture every time the panel was opened, which is
 * how a map stops being somewhere you recognise.
 */
export function place(nodes: Node[]): void {
  const ANGLE = Math.PI * (3 - Math.sqrt(5))
  nodes.forEach((node, i) => {
    const radius = DISTANCE * Math.sqrt(0.5 + i)
    node.x = radius * Math.cos(i * ANGLE)
    node.y = radius * Math.sin(i * ANGLE)
    node.vx = 0
    node.vy = 0
  })
}

/**
 * One tick, and the alpha to run the next one at.
 *
 * The repulsion is every pair, O(n²). A quadtree is what d3 does instead, and it is worth
 * writing the day a plugin hands this thousands of nodes — the stores that draw one today
 * hold hundreds of short rows, which is the same ceiling their own ranking already writes
 * down, and one change would raise both.
 */
export function step(nodes: Node[], links: Link[], alpha: number): number {
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!
      let dx = b.x - a.x
      let dy = b.y - a.y
      // Two nodes at exactly the same point have no direction to push in, so they are given
      // one. Without this a pair that lands on top of each other stays there forever.
      if (dx === 0 && dy === 0) {
        dx = (i % 7) * 1e-3 + 1e-3
        dy = (j % 5) * 1e-3 + 1e-3
      }
      const push = (CHARGE * alpha) / (dx * dx + dy * dy)
      a.vx += dx * push
      a.vy += dy * push
      b.vx -= dx * push
      b.vy -= dy * push
    }
  }

  for (const { source, target } of links) {
    const dx = target.x + target.vx - (source.x + source.vx)
    const dy = target.y + target.vy - (source.y + source.vy)
    const length = Math.hypot(dx, dy) || 1e-6
    // A spring is weaker the more crowded its ends are, and it pulls the less-connected end
    // further. Both are d3's: a hub with twenty links would otherwise be dragged around by
    // every one of them and the middle of the graph would never hold still.
    const strength = 1 / Math.min(source.degree || 1, target.degree || 1)
    const pull = ((length - DISTANCE) / length) * alpha * strength
    const bias = source.degree / (source.degree + target.degree || 1)
    target.vx -= dx * pull * bias
    target.vy -= dy * pull * bias
    source.vx += dx * pull * (1 - bias)
    source.vy += dy * pull * (1 - bias)
  }

  for (const node of nodes) {
    if (node.held === true) {
      node.vx = 0
      node.vy = 0
      continue
    }
    node.vx *= KEEP
    node.vy *= KEEP
    node.x += node.vx
    node.y += node.vy
  }

  // The whole picture recentred on nothing in particular, so a graph that drifts while it
  // settles is still where the canvas is looking. d3 calls this the centering force.
  if (nodes.length > 0) {
    let cx = 0
    let cy = 0
    for (const node of nodes) {
      cx += node.x
      cy += node.y
    }
    cx /= nodes.length
    cy /= nodes.length
    for (const node of nodes) {
      node.x -= cx
      node.y -= cy
    }
  }

  return alpha + (0 - alpha) * COOLING
}

/** Run it to rest, for a reader who has asked not to be shown motion. */
export function settle(nodes: Node[], links: Link[]): void {
  let alpha = WARM
  while (alpha > COLD) alpha = step(nodes, links, alpha)
}
