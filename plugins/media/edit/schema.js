// SPDX-License-Identifier: AGPL-3.0-only
import { PRIVATE_LIMITS } from '@alexia/sdk'

/**
 * The one contract a local planner fills in to describe an image edit: `AlexiaImageJob`.
 *
 * **The same schema is the planner's output format and the structural check of its answer.**
 * It is written in the JSON Schema subset `supportedSamplingSchema` accepts, so the request that
 * constrains the model and the validator that reads the result can never disagree about what a
 * job is. Cross-field rules — which image may supply which role — live in `validate.js`.
 *
 * Every field the model writes is semantic. Nothing here names a file, a node, a checkpoint, a
 * seed or a setting: those come from the trusted envelope core and the profile build, never
 * from planner output.
 */

/** `1.1` is the whole-image foundation; `1.2` adds notes bound to trusted region IDs. */
export const JOB_VERSIONS = ['1.1', '1.2']

export const ACTIONS = ['image_edit', 'image_generate', 'inpaint']

/** Fixed order: the compiler and the normalizer both sort by it, so it is part of the output. */
export const ROLES = [
  'identity', 'face', 'hairstyle', 'expression', 'body', 'clothing', 'accessories', 'pose',
  'composition', 'camera_angle', 'framing', 'lighting', 'background', 'color_palette', 'art_style', 'texture',
]

export const RATINGS = ['sfw', 'suggestive', 'explicit']

/** Below this the planner asks; above it nothing is proven, only allowed to proceed. */
export const CONFIDENCE_FLOOR = 0.6

export const JOB_LIMITS = {
  request: PRIVATE_LIMITS.requestCharacters,
  instruction: 4_000,
  outputStyle: 200,
  question: 300,
  references: PRIVATE_LIMITS.imageInputs,
  rolesPerReference: ROLES.length,
  preserve: ROLES.length,
  exclusions: 48,
  names: 8,
  nameCharacters: 120,
  regions: PRIVATE_LIMITS.regions,
  regionCharacters: PRIVATE_LIMITS.regionCharacters,
  response: PRIVATE_LIMITS.plannerBytes,
}

const nullable = (schema) => ({ ...schema, type: [schema.type, 'null'], ...(schema.enum ? { enum: [...schema.enum, null] } : {}) })

/**
 * The schema for one request's selection.
 *
 * `labels` are the selected images in their displayed order, and every image field is an enum
 * of exactly those labels: a planner constrained by this schema cannot name an image outside
 * the selection, a path or a URL. `regions` are the trusted region IDs the editor created for
 * a `1.2` job; the model may word their instructions but cannot invent or move one.
 */
export function jobSchema({ version, labels, regions = [] }) {
  if (!JOB_VERSIONS.includes(version)) throw new Error(`ImageJob ${version} is not supported.`)
  if (!Array.isArray(labels) || labels.length === 0) throw new Error('An ImageJob schema needs the selected images.')
  const image = { type: 'string', enum: [...labels] }
  const role = { type: 'string', enum: ROLES }
  const text = (max) => ({ type: 'string', maxLength: max })
  const list = (items, max, min = 0) => ({ type: 'array', items, minItems: min, maxItems: max })
  const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })

  const properties = {
    schema_version: { type: 'string', const: version },
    action: { type: 'string', enum: ACTIONS },
    target: nullable(image),
    instruction: text(JOB_LIMITS.instruction),
    references: list(object({
      image,
      roles: list(role, JOB_LIMITS.rolesPerReference, 1),
      strength: { type: 'number', minimum: 0, maximum: 1 },
    }), JOB_LIMITS.references),
    preserve: list(role, JOB_LIMITS.preserve),
    exclude: list(object({ image, role }), JOB_LIMITS.exclusions),
    output_style: nullable(text(JOB_LIMITS.outputStyle)),
    needs_clarification: { type: 'boolean' },
    clarification_question: nullable({ type: 'string', minLength: 1, maxLength: JOB_LIMITS.question }),
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    content_rating: { type: 'string', enum: RATINGS },
    named_real_people: list({ type: 'string', minLength: 1, maxLength: JOB_LIMITS.nameCharacters }, JOB_LIMITS.names),
  }
  if (version === '1.2') {
    // An empty enum is outside the supported subset, so a job with no notes allows no entries.
    properties.regions = regions.length === 0
      ? list(object({ region_id: { type: 'string' }, instruction: text(JOB_LIMITS.regionCharacters) }), 0)
      : list(object({
        region_id: { type: 'string', enum: [...regions] },
        instruction: { type: 'string', minLength: 1, maxLength: JOB_LIMITS.regionCharacters },
      }), Math.min(regions.length, JOB_LIMITS.regions))
  }
  return { title: 'AlexiaImageJob', ...object(properties) }
}
