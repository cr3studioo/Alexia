// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The editor's document, turned into the graph `/prompt` accepts.
 *
 * **D123 refused exactly this, and the refusal still stands for what it was about.** It said a
 * hand-written `graphToPrompt` fails on the graphs it would be built for — `Power Lora Loader
 * (rgthree)` storing objects where widget order says scalars, `LoRA Stacker` whose widget count
 * is driven by another widget — and that *a converter that handles the plain cases and fails on
 * these is worse than none, because it fails silently and specifically on the interesting
 * graphs*. Every word of that is still true.
 *
 * **What changed is that silence is not the only option.** The failure D123 feared is a
 * converter that guesses; this one proves or refuses. Widget order is not a heuristic — it is
 * `/object_info`'s own `input_order`, with a slot inserted after any widget the spec marks
 * `control_after_generate`. So the expected number of values is a **number**, and comparing it
 * with the array's length is arithmetic. When they disagree, nothing is emitted and the reason
 * is named.
 *
 * That is the whole design: **every uncertainty is a refusal**, never a default. A bypassed
 * node, a reroute, a subgraph, a class this install does not have, a widget count that does not
 * add up — each one stops the conversion and says which node and why. What comes out the other
 * end is a graph whose every input was read rather than assumed.
 *
 * **It is deliberately not offered for arbitrary graphs.** Its user is ComfyUI's own template
 * catalogue, which is built from core nodes; the workflows somebody assembled from custom node
 * packs are exactly the ones it will refuse, and refusing them is it working.
 */

/** Frontend furniture. These are not nodes the backend has ever heard of. */
const DECORATION = new Set(['Note', 'MarkdownNote'])

/** Types this will not attempt, each because getting it wrong is silent. */
const REFUSED = {
  Reroute: 'a Reroute passes a link through the editor and has no backend node — the wires either side would have to be rejoined',
  PrimitiveNode: 'a Primitive feeds a widget from outside and has no backend node — its value would have to be moved into whatever it feeds',
}

/**
 * **Two spellings of a combo, and both are live on the same install.** Older nodes declare one
 * as a bare list where a type name would be — `[["euler", "heun"], {}]` — and V3 nodes declare
 * it as a named type with the list moved into the options — `["COMBO", { options: […] }]`.
 * Handling only the first read `KSamplerSelect` as having no widgets at all while the workflow
 * held one, which looked exactly like the ambiguity this file refuses on.
 */
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])

/**
 * The inputs of a class that appear in `widgets_values`, in the order they appear.
 *
 * A combo (a list where a type name would be) is a widget. A link type — `MODEL`, `LATENT` —
 * is not. And `control_after_generate: true` means the editor draws a *second* widget after
 * this one, holding `randomize` or `fixed`, which belongs to no input at all and is the reason
 * a seed never changes in an export.
 */
export function widgetOrder(spec) {
  const order = spec?.input_order?.required ?? Object.keys(spec?.input?.required ?? {})
  const optional = spec?.input_order?.optional ?? Object.keys(spec?.input?.optional ?? {})
  const slots = []
  for (const [names, where] of [
    [order, 'required'],
    [optional, 'optional'],
  ]) {
    for (const name of names) {
      const declared = spec?.input?.[where]?.[name]
      if (!Array.isArray(declared)) continue
      const kind = declared[0]
      const isWidget = Array.isArray(kind) || WIDGET_TYPES.has(String(kind).toUpperCase())
      if (!isWidget) continue
      slots.push({ name, spec: declared })
      if (declared[1]?.control_after_generate === true) slots.push({ name: null, spec: undefined })
    }
  }
  return slots
}

const linkOf = (node, name) => (node.inputs ?? []).find((one) => one?.name === name)

/**
 * Convert, or say why not.
 *
 * Returns `{ ok: true, graph }` or `{ ok: false, why: [...] }`. There is no third answer and
 * no partial one: a graph missing a node is a graph that runs and produces the wrong thing.
 */
export function convert(doc, classes) {
  const why = []
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : undefined
  if (!nodes) return { ok: false, why: ['this is not a workflow the editor saved — it has no nodes'] }
  if (doc.definitions?.subgraphs?.length > 0) {
    return { ok: false, why: ['it contains a subgraph, which is a graph inside a graph and is not flattened here'] }
  }

  // Where every link comes from, so an input can be answered without searching the array each
  // time: link id → [origin node, origin slot].
  const from = new Map()
  for (const link of doc.links ?? []) {
    if (Array.isArray(link)) from.set(Number(link[0]), [String(link[1]), Number(link[2])])
    else if (link && typeof link === 'object') from.set(Number(link.id), [String(link.origin_id), Number(link.origin_slot)])
  }

  const graph = {}
  for (const node of nodes) {
    const type = String(node?.type ?? '')
    if (DECORATION.has(type)) continue
    const id = String(node?.id ?? '')

    if (REFUSED[type]) {
      why.push(`node ${id} is a ${type}: ${REFUSED[type]}`)
      continue
    }
    // Bypassed (2) and muted (4). The editor keeps drawing them and the backend never sees
    // them, so their wires have to be rejoined through matching types — which is the obstacle
    // D123 named, and it is not attempted.
    if (node?.mode === 2 || node?.mode === 4) {
      why.push(`node ${id} (${type}) is ${node.mode === 4 ? 'muted' : 'bypassed'}, and re-joining what ran through it is not attempted`)
      continue
    }
    const spec = classes?.[type]
    if (!spec) {
      why.push(`node ${id} is a ${type}, which is not installed here`)
      continue
    }

    const slots = widgetOrder(spec)
    const values = Array.isArray(node?.widgets_values) ? node.widgets_values : []
    // **The check the whole file exists for.** `widgets_values` is positional and unlabelled, so
    // a count that does not match the class's own widget list means the two are not describing
    // the same thing — which is what a node with a dynamic widget count, or one storing objects
    // where scalars are expected, looks like from here.
    if (values.length !== slots.length) {
      // Anything not a scalar is the rgthree shape: objects in the array, and no order to read.
      const odd = values.some((one) => one !== null && typeof one === 'object')
      why.push(
        `node ${id} (${type}) holds ${values.length} widget value${values.length === 1 ? '' : 's'} where this install's ` +
          `${type} declares ${slots.length}${odd ? ', and some of them are not plain values' : ''} — so which value belongs ` +
          'to which input cannot be read off the order',
      )
      continue
    }

    const inputs = {}
    slots.forEach((slot, at) => {
      if (slot.name === null) return // `control_after_generate`: the editor's, not an input.
      // A widget can be *converted to an input* and driven by a wire. The value stays in the
      // array so the order still reads, and the link wins over it.
      const wired = linkOf(node, slot.name)
      if (wired?.link !== undefined && wired.link !== null && from.has(Number(wired.link))) return
      inputs[slot.name] = values[at]
    })

    for (const input of node.inputs ?? []) {
      const link = from.get(Number(input?.link))
      if (!link) continue
      inputs[String(input.name)] = [link[0], link[1]]
    }

    graph[id] = { class_type: type, inputs, _meta: { title: String(node?.title ?? spec.display_name ?? type) } }
  }

  if (why.length > 0) return { ok: false, why }

  // Last check, and it is the one `/prompt` would otherwise make with a 400: everything a class
  // says it requires has to be there. A missing required input is how a graph gets refused
  // after the person has already been told it was installed.
  for (const [id, node] of Object.entries(graph)) {
    for (const name of Object.keys(classes[node.class_type]?.input?.required ?? {})) {
      if (!(name in node.inputs)) why.push(`node ${id} (${node.class_type}) has nothing for its required input "${name}"`)
    }
  }
  if (why.length > 0) return { ok: false, why }
  if (Object.keys(graph).length === 0) return { ok: false, why: ['there is nothing in it to run'] }
  return { ok: true, graph }
}
