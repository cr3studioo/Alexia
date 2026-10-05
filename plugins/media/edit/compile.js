// SPDX-License-Identifier: AGPL-3.0-only
import { ROLES } from './schema.js'
import { MENTION, words } from './validate.js'

/**
 * A validated, normalized job to the exact words a render receives, and which picture goes in
 * which slot.
 *
 * **One mapping, used for both.** The target is slot 1, every other contributing picture follows
 * in the order the user selected them, and every label in the text is rewritten through that
 * same map — so `image_7` as the target becomes slot 1 in the graph and in the prompt at once.
 * A picture that contributes nothing is not loaded, and nothing in the prompt refers to it.
 *
 * How a slot is named in a prompt belongs to the profile (it is what Step 0 verifies for each
 * model), so `slotName` comes from there. Nothing here chooses a seed, a size or a node.
 * The same job, selection and profile always produce the same output, byte for byte.
 */

export const COMPILER_VERSION = '1'

/** Taking these from a reference by accident is the failure that matters most, so it is said out loud. */
const GUARDED = ['identity', 'face', 'body', 'art_style']

export function slots(job, selection) {
  const at = (label) => selection.indexOf(label)
  const contributing = [...new Set(job.references.filter((r) => r.strength > 0 && r.image !== job.target).map((r) => r.image))]
    .sort((a, b) => at(a) - at(b))
  const order = [job.target, ...contributing]
  return {
    order: order.map((label, i) => ({ label, slot: i + 1 })),
    unused: selection.filter((label) => !order.includes(label)),
  }
}

/**
 * `{ instruction, passes, slots, unused, compilerVersion }`. `passes` is empty for a whole-image
 * edit; for a `1.2` inpaint it holds one prompt per active region, in displayed order, each of
 * which the run applies as its own masked pass.
 */
export function compile(job, selection, { slotName }) {
  if (typeof slotName !== 'function') throw new Error('Compiling an edit needs the profile\'s slot naming.')
  const { order, unused } = slots(job, selection)
  const name = new Map(order.map(({ label, slot }) => [label, slotName(slot)]))
  const rewrite = (text) => text.replace(MENTION, (label) => name.get(label) ?? label)
  const target = name.get(job.target)
  const list = (roles) => {
    const said = roles.map(words)
    return said.length === 1 ? said[0] : `${said.slice(0, -1).join(', ')} and ${said.at(-1)}`
  }

  const clauses = []
  if (job.instruction !== '') clauses.push(sentence(rewrite(job.instruction)))

  const taken = new Map()
  for (const ref of job.references) {
    if (ref.strength === 0 || ref.image === job.target) continue
    taken.set(ref.image, ref.roles)
    clauses.push(`Use only the ${list(ref.roles)} from ${name.get(ref.image)}.`)
  }
  if (job.preserve.length > 0) clauses.push(`Keep the ${list(job.preserve)} of ${target} unchanged.`)

  for (const [image, roles] of taken) {
    const guard = GUARDED.filter((role) => !roles.includes(role))
    const told = job.exclude.filter((e) => e.image === image && !guard.includes(e.role)).map((e) => e.role)
    const leave = [...guard, ...told].sort((a, b) => ROLES.indexOf(a) - ROLES.indexOf(b))
    if (leave.length > 0) clauses.push(`Do not take the ${list(leave)} from ${name.get(image)}.`)
  }

  const styled = [...taken.values()].some((roles) => roles.includes('art_style'))
  if (job.output_style !== null) clauses.push(`Style: ${sentence(rewrite(job.output_style))}`)
  else if (!styled) clauses.push(`Keep the existing style of ${target}.`)

  const instruction = `Edit ${target}. ${clauses.join(' ')}`.trim()
  const passes = (job.regions ?? []).map((r) => ({
    regionId: r.region_id,
    instruction: `Edit only the selected area of ${target}: ${sentence(rewrite(r.instruction))} Keep everything else unchanged.`,
  }))
  return { compilerVersion: COMPILER_VERSION, instruction, passes, slots: order, unused }
}

const sentence = (text) => /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`
