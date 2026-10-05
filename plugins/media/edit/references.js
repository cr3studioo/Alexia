// SPDX-License-Identifier: AGPL-3.0-only
import { parseJob } from './validate.js'

/** The person's explicit slot choices take precedence over the planner's inferred roles. */
export function referenceJob(job, references, attachments) {
  if (!references?.length) return job
  const selected = references.map((reference) => ({
    image: attachments.find((a) => a.id === reference.attachmentId)?.label,
    roles: reference.roles,
    strength: 1,
  }))
  const assigned = new Set(selected.flatMap((reference) => reference.roles))
  const selectedImages = new Set(selected.map((reference) => reference.image))
  const updated = {
    ...job,
    references: [
      ...job.references.filter((reference) => !selectedImages.has(reference.image)).map((reference) => ({
        ...reference, roles: reference.roles.filter((role) => !assigned.has(role)),
      })).filter((reference) => reference.roles.length),
      ...selected,
    ],
    preserve: job.preserve.filter((role) => !assigned.has(role)),
    exclude: job.exclude.filter((reference) => !selected.some((s) => s.image === reference.image && s.roles.includes(reference.role))),
  }
  const checked = parseJob(JSON.stringify(updated), {
    version: job.schema_version,
    selection: attachments.map((a) => a.label),
    regions: job.regions?.map((r) => r.region_id) ?? [],
  })
  if (checked.outcome !== 'ready') throw Object.assign(new Error('The reference roles conflict. Choose one picture for each role, and one picture for the face and identity.'), { code: 'selection_mismatch' })
  return checked.job
}
