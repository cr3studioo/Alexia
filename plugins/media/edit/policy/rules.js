// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The decision rules, as pure functions over evidence. No model runs in here.
 *
 * **Evidence is kept separate and never traded.** Content rating, age evidence, identity
 * evidence and consent are four different values. A low explicitness score says nothing about
 * age; a missing face says nothing about adulthood; similarity says nothing about consent; a
 * planner's hint can raise a rating and never lower one.
 *
 * **Missing, failed or inconclusive evidence stops the job.** Every rule below that needs a
 * fact and does not have it answers `blocked` with the reason, not `allowed` with a caveat.
 *
 * **Sexual content involving an identifiable person, and adult content generally, are off.**
 * They stay off until a reviewed age-and-consent design and evaluated local checks exist — the
 * plan's release blocker 4. Until then the only content this editor publishes is assessed
 * `sfw` on every input and the output.
 */

export const RATINGS = ['sfw', 'suggestive', 'explicit']
const rank = (r) => RATINGS.indexOf(r)
const worst = (...ratings) => RATINGS[Math.max(...ratings.filter((r) => r).map(rank))]

/**
 * What each mode permits.
 *
 * **Standard** publishes only `sfw`. **Adult** — the person said they are 18 or older in
 * Settings and typed `/nsfw` — lifts the content limit and the consent check entirely: adult
 * content of anyone is theirs to make on their own computer. **One rule stays in every mode:**
 * nothing sexual is made of anyone who may be under 18. It is the narrowest check there is — it
 * acts only when an edit is not `sfw` *and* a person in it is not clearly an adult.
 */
export const SCOPE = Object.freeze({
  standard: Object.freeze({ adultContent: false, sensitiveIdentityEdits: false }),
  adult: Object.freeze({ adultContent: true, sensitiveIdentityEdits: true }),
})
const scopeOf = (mode) => (mode?.adult === true ? SCOPE.adult : SCOPE.standard)

/**
 * Evidence for one image (or the request text, which has only `rating`):
 * `{ rating: 'sfw'|…|null, people: [{ age: 'adult'|'minor'|'uncertain'|null }] | null, status: 'ok'|'failed'|'inconclusive' }`.
 * `null` means the check that would have said did not run.
 */
export function decideRequest({ hint, text, mode }) {
  if (!text || text.status !== 'ok' || !text.rating) return blocked('policy_unavailable')
  const rating = worst(text.rating, hint?.content_rating)
  if (rating !== 'sfw' && !scopeOf(mode).adultContent) return blocked('input_blocked', rating)
  return allowed(rating)
}

/**
 * Every selected picture, including ones used only for lighting or clothing. Any input showing a
 * person whose age is not confidently adult blocks anything but `sfw`; a sexual request about a
 * named or identifiable person needs consent, which this build cannot record.
 */
export function decideInputs({ request, images, hint, mode }) {
  const scope = scopeOf(mode)
  if (request.decision !== 'allowed') return request
  let rating = request.rating
  for (const image of images) {
    if (!image || image.status !== 'ok' || !image.rating || image.people === null || image.people === undefined) return blocked('policy_unavailable')
    rating = worst(rating, image.rating)
    if (image.people.some((p) => p.age === 'minor') && rating !== 'sfw') return blocked('age_uncertain', rating)
    if (image.people.some((p) => p.age !== 'adult') && rating !== 'sfw') return blocked('age_uncertain', rating)
  }
  if (rating !== 'sfw' && !scope.adultContent) return blocked('input_blocked', rating)
  const identifiable = (hint?.named_real_people?.length ?? 0) > 0 || images.some((i) => i.people.length > 0)
  if (rating !== 'sfw' && identifiable && !scope.sensitiveIdentityEdits) return blocked('consent_missing', rating)
  return allowed(rating)
}

/** The final picture, checked on its own evidence — never inherited from the inputs. */
export function decideOutput({ inputs, output, mode }) {
  if (inputs.decision !== 'allowed') return inputs
  if (!output || output.status !== 'ok' || !output.rating || output.people === null || output.people === undefined) return blocked('policy_unavailable')
  if (output.people.some((p) => p.age !== 'adult') && output.rating !== 'sfw') return blocked('age_uncertain', output.rating)
  if (output.rating !== 'sfw' && !scopeOf(mode).adultContent) return blocked('output_blocked', output.rating)
  return allowed(worst(inputs.rating, output.rating))
}

const allowed = (rating) => ({ decision: 'allowed', reason: null, rating })
const blocked = (reason, rating = null) => ({ decision: 'blocked', reason, rating })

/** One plain sentence per reason, for the person. */
export const MESSAGES = {
  policy_unavailable: 'The safety checks this edit needs are not available on this computer, so it was not made.',
  input_blocked: 'This request or one of its pictures is outside what the editor makes.',
  age_uncertain: 'A person in these pictures could not be confirmed as an adult, so this edit was not made.',
  consent_missing: 'Edits like this to a real person need their recorded consent, which Alexia cannot collect yet.',
  consent_revoked: 'Consent for this edit was withdrawn.',
  output_blocked: 'The edited picture did not pass the safety check and was discarded.',
}
