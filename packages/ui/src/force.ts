// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The force layout the `graph` widget draws (M6-11, D115).
 *
 * **Hand-written, because the page has no bundler and no framework.** The predecessor spent
 * its one heavy dependency here — `react-force-graph-2d`, and d3-force under it — and that
 * is not available to a shell that ships as plain modules.
 *
 * It is arithmetic and nothing else — no DOM, no canvas, no timers — so it can be tested
 * without a browser, which is why it is a file of its own rather than a hundred lines inside
 * `widgets.ts`.
 *
 * **Retuned once it had a real graph in front of it (D115).** The first pass took d3's own
 * constants — link 30, charge −30 — and they are tuned for a few dozen dots with no writing
 * on them. Sixty-three labelled notes drew a hairball: names on top of names, and dragging
 * the one node everything hangs off moved almost nothing. Four things were wrong, and all
 * four are visible in a screenshot:
 *
 * - **The picture recentred itself every tick.** Every node, the one under the cursor
 *   included, was shifted by the centroid's own movement — so a drag was partly undone as
 *   fast as it was made. It is a weak pull toward the middle now, which is what keeps a
 *   loose cluster from wandering off without ever moving what a hand is holding.
 * - **Nothing kept two nodes apart.** Repulsion falls off with distance and gives up long
 *   before two circles overlap, so labels sat on labels. There is a real collision pass now.
 * - **Everything was too close together for text.** A node is drawn with its name beside it,
 *   so the layout has to leave room for a word rather than for a dot.
 * - **A drag cooled the same way as anything else.** d3 holds the temperature up for as long
 *   as a node is held, and that is the whole difference between a graph that follows your
 *   hand and one that shrugs.
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

/** What a spring is happy at. Three times d3's default, because these dots have names on them. */
export const DISTANCE = 90
/** Every node pushes every other away. Negative is a push. */
const CHARGE = -400
/** Closest two nodes may repel from, squared. Without it a near-collision fires them off screen. */
const NEAREST = 400
/** Clear air between two circles, so a name has somewhere to sit. */
const ROOM = 26
/** A weak pull toward the middle, in place of recentring. Small: it shapes, it does not herd. */
const GRAVITY = 0.06
/** How much of its velocity a node keeps each tick. d3's `velocityDecay` is 0.4. */
const KEEP = 0.6
/** How fast it cools toward whatever it is heading for. */
const COOLING = 0.02
/** Cold enough that nothing visible is still moving. */
export const COLD = 0.001
/** Warm from a standing start: a new graph, or one somebody has just let go of. */
export const WARM = 1
/**
 * The temperature a drag holds it at.
 *
 * d3's `alphaTarget`, and the reason its graphs feel alive under a hand: without it the
 * layout cools *while* you are dragging, so a long drag ends with a stiff graph and a
 * stretched fan of links behind the node you moved.
 */
export const HELD = 0.35

/** How big a node is, in world units. Shared with the painter, so what collides is what is drawn. */
export const radius = (node: Pick<Node, 'degree'>): number => 5 + 2.4 * Math.sqrt(node.degree)

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
    const away = DISTANCE * Math.sqrt(0.5 + i)
    node.x = away * Math.cos(i * ANGLE)
    node.y = away * Math.sin(i * ANGLE)
    node.vx = 0
    node.vy = 0
  })
}

/**
 * One tick, and the temperature to run the next one at.
 *
 * `heading` is where the cooling is going: 0 for a graph settling on its own, {@link HELD}
 * while a hand is on it. `shape` is how much wider than tall the frame is, and all it does is
 * pull harder on the short axis — a round cloud in a letterbox wastes half the width, and the
 * fix is one multiplication rather than a second force.
 *
 * The repulsion is every pair, O(n²). A quadtree is what d3 does instead, and it is worth
 * writing the day a plugin hands this thousands of nodes — the stores that draw one today
 * hold hundreds of short rows, which is the same ceiling their own ranking already writes
 * down, and one change would raise both.
 */
export function step(nodes: Node[], links: Link[], alpha: number, heading = 0, shape = 1): number {
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
      const away = dx * dx + dy * dy
      const push = (CHARGE * alpha) / Math.max(away, NEAREST)
      a.vx += dx * push
      a.vy += dy * push
      b.vx -= dx * push
      b.vy -= dy * push

      /**
       * Two circles that overlap are separated **now**, not accelerated apart.
       *
       * Repulsion is a force and forces take time; overlap is a fact about the picture, and
       * a name written across another name is the one failure a reader cannot work around.
       * Half each, and a held node keeps its place — what a hand is holding is where the
       * user put it, so the other one gives way instead.
       */
      const room = radius(a) + radius(b) + ROOM
      const between = Math.hypot(dx, dy)
      if (between >= room || between === 0) continue
      const shove = (room - between) / between
      const mine = a.held === true ? 0 : b.held === true ? 1 : 0.5
      const theirs = b.held === true ? 0 : a.held === true ? 1 : 0.5
      a.x -= dx * shove * mine
      a.y -= dy * shove * mine
      b.x += dx * shove * theirs
      b.y += dy * shove * theirs
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
    // Toward the middle, gently. This is what the centroid shift used to do badly: it kept
    // the picture together by moving everything, including whatever was under the cursor.
    node.vx -= node.x * GRAVITY * alpha
    node.vy -= node.y * GRAVITY * shape * alpha
    node.vx *= KEEP
    node.vy *= KEEP
    node.x += node.vx
    node.y += node.vy
  }

  return alpha + (heading - alpha) * COOLING
}

/** Run it to rest, for a reader who has asked not to be shown motion. */
export function settle(nodes: Node[], links: Link[]): void {
  let alpha = WARM
  while (alpha > COLD) alpha = step(nodes, links, alpha)
}
