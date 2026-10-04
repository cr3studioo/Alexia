// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The graph a profile runs, rebuilt from the profile every time.
 *
 * **No graph arrives from anywhere.** The envelope carries the profile's identity and the
 * digests of its manifest and graph; this file takes the trusted template from the profile and
 * writes into it only the values its bindings name — the uploaded picture for each slot, the
 * compiled prompt, the seed, the size. A slot with no picture loses its loader node and the
 * links that pointed at it. Model file names come from the profile's artifacts, never from a
 * request.
 */

/**
 * `values` is `{ images: { 1: name, 2?: name, 3?: name }, mask?: name, prompt, negative?, seed,
 * steps, cfg?, width, height }`, every one from the trusted envelope and profile.
 */
export function buildGraph(profile, values) {
  const nodes = structuredClone(profile.graph.nodes)
  for (const b of profile.graph.artifacts ?? []) {
    const artifact = profile.artifacts.find((a) => a.id === b.artifact)
    nodes[b.node].inputs[b.input] = artifact.filename
  }
  const absent = new Set()
  for (const b of profile.graph.bindings) {
    const value = valueOf(b.from, values)
    if (value === undefined) {
      if (b.from.startsWith('image:') && b.from !== 'image:1') {
        absent.add(b.node)
        continue
      }
      if (b.from === 'negative' || b.from === 'cfg') continue
      throw new Error(`The edit is missing ${b.from}.`)
    }
    nodes[b.node].inputs[b.input] = value
  }
  // A picture that is not there takes its loader with it, and every link to that loader.
  for (const id of absent) delete nodes[id]
  for (const node of Object.values(nodes)) {
    for (const [input, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && absent.has(String(value[0]))) delete node.inputs[input]
    }
  }
  const dangling = Object.values(nodes).flatMap((n) => Object.values(n.inputs)).filter((v) => Array.isArray(v) && !nodes[String(v[0])])
  if (dangling.length > 0) throw new Error('The edit graph would be incomplete.')
  return nodes
}

function valueOf(from, values) {
  if (from.startsWith('image:')) return values.images?.[Number(from.slice(6))]
  return values[from]
}

/** Node classes the graph needs that this ComfyUI does not have. */
export const missingNodes = (profile, available) => [...new Set(profile.nodes)].filter((name) => !(name in (available ?? {})))
