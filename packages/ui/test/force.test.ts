// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { COLD, DISTANCE, HELD, type Link, type Node, place, radius, settle, step, WARM } from '../src/force.js'

/**
 * The layout is the one part of the `graph` widget that is not drawing, and there is no
 * browser in this suite — so this is where it is checked. Every test below is a picture
 * somebody would complain about if it broke, and the last two are complaints that were
 * actually made: names on top of names, and a hub that could be dragged across the screen
 * while the graph hanging off it barely moved (D115).
 */

const graph = (count: number, edges: [number, number][]): { nodes: Node[]; links: Link[] } => {
  const nodes: Node[] = Array.from({ length: count }, (_, i) => ({
    id: String(i),
    label: `node ${String(i)}`,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    degree: 0,
  }))
  const links = edges.map(([a, b]) => ({ source: nodes[a]!, target: nodes[b]! }))
  for (const { source, target } of links) {
    source.degree += 1
    target.degree += 1
  }
  place(nodes)
  return { nodes, links }
}

const apart = (a: Node, b: Node): number => Math.hypot(a.x - b.x, a.y - b.y)

test('a link pulls two nodes together, and the collision pass stops them touching', () => {
  const { nodes, links } = graph(2, [[0, 1]])
  settle(nodes, links)
  const gap = apart(nodes[0]!, nodes[1]!)
  expect(gap).toBeGreaterThan(radius(nodes[0]!) + radius(nodes[1]!))
  expect(gap).toBeLessThan(DISTANCE * 3)
})

test('two nodes with nothing between them push apart rather than pile up', () => {
  const { nodes, links } = graph(2, [])
  settle(nodes, links)
  expect(apart(nodes[0]!, nodes[1]!)).toBeGreaterThan(DISTANCE)
})

test('a cluster ends up nearer itself than the cluster next to it', () => {
  // Two triangles, joined by nothing.
  const { nodes, links } = graph(6, [
    [0, 1],
    [1, 2],
    [2, 0],
    [3, 4],
    [4, 5],
    [5, 3],
  ])
  settle(nodes, links)
  const within = Math.max(apart(nodes[0]!, nodes[1]!), apart(nodes[1]!, nodes[2]!))
  const between = Math.min(apart(nodes[0]!, nodes[3]!), apart(nodes[1]!, nodes[4]!))
  expect(within).toBeLessThan(between)
})

test('the same graph draws the same map twice', () => {
  const edges: [number, number][] = [
    [0, 1],
    [1, 2],
    [0, 3],
  ]
  const first = graph(4, edges)
  const again = graph(4, edges)
  settle(first.nodes, first.links)
  settle(again.nodes, again.links)
  expect(first.nodes.map((n) => [n.x, n.y])).toEqual(again.nodes.map((n) => [n.x, n.y]))
})

/**
 * Nothing overlaps, which the first pass got wrong (D115).
 *
 * Repulsion alone is a force that falls off with distance, so it gives up long before two
 * circles meet — and a node is drawn with its name beside it, so two touching circles are two
 * names written over each other.
 */
test('no two nodes are left on top of each other', () => {
  const edges: [number, number][] = Array.from({ length: 24 }, (_, i) => [0, i + 1])
  const { nodes, links } = graph(25, edges)
  settle(nodes, links)
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const gap = apart(nodes[i]!, nodes[j]!) - radius(nodes[i]!) - radius(nodes[j]!)
      expect(gap, `${String(i)} and ${String(j)}`).toBeGreaterThan(0)
    }
  }
})

/**
 * The complaint this retune came from: dragging the hub moved nothing else (D115).
 *
 * A second of dragging at sixty frames, which is what a hand does, and the things hanging off
 * it have to come along. The old numbers moved a neighbour a few pixels in that time, because
 * the layout cooled while the drag was still happening and the picture recentred itself under
 * the cursor.
 */
test('dragging a hub drags what hangs off it', () => {
  const edges: [number, number][] = Array.from({ length: 20 }, (_, i) => [0, i + 1])
  const { nodes, links } = graph(21, edges)
  settle(nodes, links)

  const hub = nodes[0]!
  const was = nodes.map((node) => ({ x: node.x, y: node.y }))
  hub.held = true
  hub.x += 800
  hub.y += 300
  let alpha = HELD
  for (let i = 0; i < 60; i++) alpha = step(nodes, links, alpha, HELD)

  const moved = nodes.slice(1).map((node, i) => Math.hypot(node.x - was[i + 1]!.x, node.y - was[i + 1]!.y))
  const median = [...moved].sort((a, b) => a - b)[Math.floor(moved.length / 2)]!
  // Most of the way there, not a twitch.
  expect(median).toBeGreaterThan(300)
  // And the drag did not cool off while it was still being made.
  expect(alpha).toBeGreaterThan(HELD * 0.9)
})

test('a held node stays exactly where the hand put it', () => {
  const { nodes, links } = graph(3, [
    [0, 1],
    [1, 2],
  ])
  const held = nodes[0]!
  held.held = true
  held.x = 500
  held.y = -250
  let alpha = WARM
  while (alpha > COLD) alpha = step(nodes, links, alpha)
  // Nothing in the sim may move it: not gravity, not a spring, and not the collision pass —
  // which is the bug the recentring used to be, one thirty-second of every drag undone.
  expect(held.x).toBe(500)
  expect(held.y).toBe(-250)
  expect(held.vx).toBe(0)
  expect(held.vy).toBe(0)
})
