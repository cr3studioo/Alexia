// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { COLD, DISTANCE, type Link, type Node, place, settle, step, WARM } from '../src/force.js'

/**
 * The layout is the one part of the `graph` widget that is not drawing, and there is no
 * browser in this suite — so this is where it is checked. Three properties, and each one is a
 * picture somebody would complain about if it broke: linked things end up near each other,
 * unlinked things do not pile up, and opening the same panel twice draws the same map.
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

test('a link pulls two nodes to about the distance it wants', () => {
  const { nodes, links } = graph(2, [[0, 1]])
  settle(nodes, links)
  // Not exact: the spring and the repulsion between the same two nodes settle where they
  // cancel, which is a little past the spring's own resting length.
  expect(apart(nodes[0]!, nodes[1]!)).toBeGreaterThan(DISTANCE * 0.5)
  expect(apart(nodes[0]!, nodes[1]!)).toBeLessThan(DISTANCE * 2)
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
  // Only the recentring moves it, and it moves every node by the same amount.
  const centre = nodes.reduce((into, node) => into + node.x, 0)
  expect(Math.abs(centre)).toBeLessThan(1e-6)
  expect(held.vx).toBe(0)
  expect(held.vy).toBe(0)
})
