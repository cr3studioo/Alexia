// SPDX-License-Identifier: AGPL-3.0-only
import { CONFIDENCE_FLOOR, JOB_LIMITS, ROLES, jobSchema } from './schema.js'

/**
 * Is a planner's answer a job this editor can run, a question to ask, or neither?
 *
 * Two layers, in order. **Structural** checks the answer against the exact schema the planner
 * was constrained by — the small subset `supportedSamplingSchema` allows, so a few dozen lines
 * rather than a second schema dialect. **Semantic** checks what a schema cannot say: one target,
 * one identity source, no role copied from two places or both kept and replaced.
 *
 * A valid job is not a correct one. Neither schema validity nor the model's confidence proves it
 * understood the request; this only proves it cannot run something the editor never allowed.
 */

const MAX_ERRORS = 8

/** Errors are paths and short sentences — never echoes of the model's text. */
export function structural(value, schema, path = '$', errors = []) {
  const fail = (message) => {
    if (errors.length < MAX_ERRORS) errors.push(`${path}: ${message}`)
    return errors
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : null
  if (types && !types.some((t) => is(value, t))) return fail(`expected ${types.join(' or ')}`)
  if ('const' in schema && value !== schema.const) return fail(`must be ${JSON.stringify(schema.const)}`)
  if (schema.enum && !schema.enum.includes(value)) return fail('is not one of the allowed values')
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`must be at least ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) fail(`must be at most ${schema.maximum}`)
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(`must have at least ${schema.minLength} characters`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(`must have at most ${schema.maxLength} characters`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`must have at least ${schema.minItems} entries`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`must have at most ${schema.maxItems} entries`)
    if (schema.items) value.forEach((item, i) => structural(item, schema.items, `${path}[${i}]`, errors))
  }
  if (is(value, 'object') && schema.properties) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) fail(`missing ${key}`)
    }
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties, key)) structural(entry, schema.properties[key], `${path}.${key}`, errors)
      else if (schema.additionalProperties === false) fail(`unknown field ${JSON.stringify(key.slice(0, 40))}`)
    }
  }
  return errors
}

function is(value, type) {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return Number.isSafeInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

const roleOrder = (a, b) => ROLES.indexOf(a) - ROLES.indexOf(b)
const IDENTITY = ['identity', 'face']

/**
 * The model's raw text to an outcome.
 *
 * `selection` is the immutable ordered list of labels the user selected (`image_7`, `image_9` —
 * membership, never an ordinal bound). `regions` are the trusted region IDs in their displayed
 * order, for `1.2`. Returns `{ outcome: 'ready', job, unused }`, `needs_clarification` with one
 * question, `unsupported`, or `invalid` with bounded errors a single repair attempt can use.
 */
export function parseJob(text, { version, selection, regions = [] }) {
  if (typeof text !== 'string' || text.trim() === '') return invalid('planner_invalid', ['$: empty response'])
  if (Buffer.byteLength(text, 'utf8') > JOB_LIMITS.response) return invalid('planner_invalid', [`$: response exceeds ${JOB_LIMITS.response} bytes`])
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return invalid('planner_invalid', ['$: not valid JSON'])
  }
  return validateJob(value, { version, selection, regions })
}

export function validateJob(value, { version, selection, regions = [] }) {
  const errors = structural(value, jobSchema({ version, labels: selection, regions }))
  if (errors.length > 0) return invalid('planner_invalid', errors)
  return semantic(value, { version, selection, regions })
}

function semantic(job, { version, selection, regions }) {
  const errors = []
  const unique = (items, key, what) => {
    if (new Set(items.map(key)).size !== items.length) errors.push(`${what} must not repeat`)
  }
  unique(job.references, (r) => r.image, '$.references images')
  job.references.forEach((r, i) => unique(r.roles, (x) => x, `$.references[${i}].roles`))
  unique(job.preserve, (x) => x, '$.preserve')
  unique(job.exclude, (e) => `${e.image}/${e.role}`, '$.exclude')
  unique(job.named_real_people, (n) => n.trim().toLowerCase(), '$.named_real_people')
  if (job.needs_clarification !== (job.clarification_question !== null)) {
    errors.push('$.clarification_question must be present exactly when needs_clarification is true')
  }
  if (version === '1.2') {
    unique(job.regions, (r) => r.region_id, '$.regions')
    if (job.action === 'inpaint' && job.regions.length === 0) errors.push('$.regions: inpaint needs at least one region')
    if (job.action !== 'inpaint' && job.regions.length > 0) errors.push('$.regions: only inpaint jobs carry regions')
  }
  if (errors.length > 0) return invalid('planner_invalid', errors.slice(0, MAX_ERRORS))

  // A question stops here: nothing below can make a clarification executable.
  if (job.needs_clarification) return clarify(job.clarification_question)
  if (job.confidence < CONFIDENCE_FLOOR) return clarify(fallbackQuestion(selection))

  if (job.action === 'image_generate') return { outcome: 'unsupported', reason: 'unsupported_action', message: 'This editor changes an attached picture; it does not make a new one from text.' }
  if (job.action === 'inpaint' && version !== '1.2') return { outcome: 'unsupported', reason: 'unsupported_action', message: 'Editing a selected area needs the regional editor.' }
  if (job.target === null) return invalid('planner_invalid', ['$.target: an edit needs exactly one target image'])

  const active = job.references.filter((r) => r.strength > 0)
  const conflict = (message) => clarify(message)

  // One source per role. The target may supply roles too, but then nothing else may.
  const sources = new Map()
  for (const ref of active) {
    for (const role of ref.roles) {
      const other = sources.get(role)
      if (other !== undefined && other !== ref.image) {
        return conflict(`Should the ${words(role)} come from ${other} or ${ref.image}?`)
      }
      sources.set(role, ref.image)
    }
  }
  for (const role of job.preserve) {
    const from = sources.get(role)
    if (from !== undefined && from !== job.target) {
      return conflict(`Should ${job.target} keep its own ${words(role)}, or take it from ${from}?`)
    }
  }
  for (const { image, role } of job.exclude) {
    if (sources.get(role) === image) return conflict(`Should the ${words(role)} from ${image} be used or left out?`)
  }

  // Identity blending is unsupported: at most one image supplies who the subject is.
  const identities = new Set(active.filter((r) => r.roles.some((x) => IDENTITY.includes(x))).map((r) => r.image))
  if (identities.size > 1) return { outcome: 'unsupported', reason: 'unsupported_action', message: 'This editor takes a person\'s identity from one picture at a time; it cannot blend several.' }
  const replaced = [...identities].find((image) => image !== job.target)
  if (replaced && job.preserve.some((x) => IDENTITY.includes(x))) {
    return conflict(`Should ${job.target} keep its own identity, or take it from ${replaced}?`)
  }

  // A label mentioned in the wording must be one that will actually be loaded.
  const loaded = new Set([job.target, ...active.map((r) => r.image)])
  for (const label of mentions(`${job.instruction} ${job.output_style ?? ''} ${(job.regions ?? []).map((r) => r.instruction).join(' ')}`)) {
    if (!selection.includes(label)) return invalid('planner_invalid', [`$.instruction: mentions ${label}, which is not selected`])
    if (!loaded.has(label)) return conflict(`What should be taken from ${label}?`)
  }
  if (job.instruction.trim() === '' && active.every((r) => r.image === job.target) && (job.regions ?? []).length === 0) {
    return clarify('What would you like to change in this picture?')
  }

  return { outcome: 'ready', job: normalize(job, { selection, regions }), unused: selection.filter((l) => !loaded.has(l)) }
}

/**
 * One canonical form, so the same edit always compiles to the same prompt: references in
 * selection order, roles in `ROLES` order, regions in the editor's displayed order.
 */
export function normalize(job, { selection, regions = [] }) {
  const at = (label) => selection.indexOf(label)
  const out = {
    ...job,
    instruction: job.instruction.trim(),
    references: [...job.references]
      .sort((a, b) => at(a.image) - at(b.image))
      .map((r) => ({ image: r.image, roles: [...r.roles].sort(roleOrder), strength: r.strength })),
    preserve: [...job.preserve].sort(roleOrder),
    exclude: [...job.exclude].sort((a, b) => at(a.image) - at(b.image) || roleOrder(a.role, b.role)),
    output_style: job.output_style?.trim() || null,
  }
  if (job.regions) {
    out.regions = [...job.regions]
      .sort((a, b) => regions.indexOf(a.region_id) - regions.indexOf(b.region_id))
      .map((r) => ({ region_id: r.region_id, instruction: r.instruction.trim() }))
  }
  return out
}

/** `image_N` tokens in free text; the compiler rewrites exactly these through the slot map. */
export const MENTION = /\bimage_[1-9][0-9]*\b/g
export const mentions = (text) => [...new Set(text.match(MENTION) ?? [])]

export const words = (role) => ({ face: 'facial features', body: 'body proportions' })[role] ?? role.replaceAll('_', ' ')

/** When the planner was unsure and wrote nothing useful, ask the same focused question every time. */
export function fallbackQuestion(selection) {
  const list = selection.length === 1 ? selection[0] : `${selection.slice(0, -1).join(', ')} and ${selection.at(-1)}`
  return selection.length === 1
    ? `What would you like to change in ${list}?`
    : `Which picture should be changed, and what should come from ${list} — for example the clothing, pose, lighting or identity?`
}

function clarify(question) {
  return { outcome: 'needs_clarification', reason: 'ambiguous_intent', question: question.slice(0, JOB_LIMITS.question) }
}

function invalid(reason, errors) {
  return { outcome: 'invalid', reason, errors: errors.map((e) => e.slice(0, 200)) }
}
