// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from 'vitest'
import { visionProvider } from '../edit/policy/providers.js'
import { decideInputs, decideOutput, decideRequest, SCOPE } from '../edit/policy/rules.js'
import { safety } from '../edit/safety.js'

/**
 * Policy orchestration. **These tests use scripted evidence, so they prove control flow only** —
 * that missing, failed or uncertain evidence stops a job, that hints never lower a rating, that
 * a block is remembered, and that nothing without an evaluation report authorizes anything. They
 * say nothing about whether any real classifier detects what it should; that is the evaluation
 * the plan's release blocker 4 still needs.
 */

const ok = (rating, ages = []) => ({ status: 'ok', rating, people: ages.map((age) => ({ age })) })
const memory = () => {
  const m = new Map()
  // The same key rule core enforces on plugin storage.
  const checked = (k) => {
    if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new Error(`bad key ${k}`)
    return k
  }
  return { get: async (k) => structuredClone(m.get(checked(k))), set: async (k, v) => void m.set(checked(k), structuredClone(v)) }
}
const scripted = (answers, evaluation = { reportId: 'eval_test' }) => ({
  id: 'scripted', version: '1', evaluation,
  assessText: async () => answers.text,
  assessImage: async (image) => answers[image.sha256],
})

describe('rules', () => {
  const allowedRequest = decideRequest({ text: ok('sfw'), hint: { content_rating: 'sfw' } })

  test('standard mode publishes sfw only; adult mode lifts the content and consent limits', () => {
    expect(SCOPE.standard).toEqual({ adultContent: false, sensitiveIdentityEdits: false })
    expect(SCOPE.adult).toEqual({ adultContent: true, sensitiveIdentityEdits: true })
    expect(decideRequest({ text: ok('explicit') })).toMatchObject({ decision: 'blocked', reason: 'input_blocked' })
    expect(decideRequest({ text: ok('explicit'), mode: { adult: true } }).decision).toBe('allowed')
  })

  test('adult mode: adult content of adults is allowed, with no consent question', () => {
    const adult = { adult: true }
    const request = decideRequest({ text: ok('explicit'), mode: adult })
    const inputs = decideInputs({ request, images: [ok('explicit', ['adult'])], hint: { named_real_people: ['Someone'] }, mode: adult })
    expect(inputs.decision).toBe('allowed')
    expect(decideOutput({ inputs, output: ok('explicit', ['adult']), mode: adult }).decision).toBe('allowed')
  })

  test('in every mode, nothing sexual is made of anyone who may be under 18', () => {
    const adult = { adult: true }
    const request = decideRequest({ text: ok('suggestive'), mode: adult })
    expect(decideInputs({ request, images: [ok('sfw', ['minor'])], mode: adult }).reason).toBe('age_uncertain')
    expect(decideInputs({ request, images: [ok('sfw', ['uncertain'])], mode: adult }).reason).toBe('age_uncertain')
    const inputs = decideInputs({ request: decideRequest({ text: ok('sfw'), mode: adult }), images: [ok('sfw', ['adult'])], mode: adult })
    expect(decideOutput({ inputs, output: ok('explicit', ['uncertain']), mode: adult }).reason).toBe('age_uncertain')
    // An ordinary picture of a child, edited ordinarily, is not this rule's business.
    expect(decideOutput({ inputs, output: ok('sfw', ['minor']), mode: adult }).decision).toBe('allowed')
  })

  test('a planner hint raises a rating and never lowers one', () => {
    expect(decideRequest({ text: ok('sfw'), hint: { content_rating: 'explicit' } }).decision).toBe('blocked')
    expect(decideRequest({ text: ok('suggestive'), hint: { content_rating: 'sfw' } }).rating).toBe('suggestive')
  })

  test('missing, failed or inconclusive evidence stops the job', () => {
    expect(decideRequest({ text: null }).reason).toBe('policy_unavailable')
    expect(decideRequest({ text: { status: 'inconclusive', rating: 'sfw', people: [] } }).reason).toBe('policy_unavailable')
    expect(decideInputs({ request: allowedRequest, images: [{ status: 'failed', rating: null, people: null }] }).reason).toBe('policy_unavailable')
    expect(decideInputs({ request: allowedRequest, images: [{ status: 'ok', rating: 'sfw', people: null }] }).reason).toBe('policy_unavailable')
  })

  test('every input counts, including a lighting-only reference', () => {
    expect(decideInputs({ request: allowedRequest, images: [ok('sfw', ['adult']), ok('suggestive')] }).decision).toBe('blocked')
  })

  test('uncertain or minor age blocks anything that is not sfw; an ordinary sfw edit of anyone is allowed', () => {
    expect(decideInputs({ request: allowedRequest, images: [ok('sfw', ['minor'])] }).decision).toBe('allowed')
    const suggestiveRequest = { decision: 'allowed', reason: null, rating: 'suggestive' }
    expect(decideInputs({ request: suggestiveRequest, images: [ok('sfw', ['uncertain'])] }).reason).toBe('age_uncertain')
    expect(decideInputs({ request: suggestiveRequest, images: [ok('sfw', [])] }).reason).toBe('input_blocked')
  })

  test('the output is judged on its own evidence', () => {
    const inputs = decideInputs({ request: allowedRequest, images: [ok('sfw', ['adult'])] })
    expect(decideOutput({ inputs, output: ok('sfw', ['adult']) }).decision).toBe('allowed')
    expect(decideOutput({ inputs, output: ok('suggestive', ['adult']) }).reason).toBe('output_blocked')
    expect(decideOutput({ inputs, output: { status: 'inconclusive', rating: 'sfw', people: [] } }).reason).toBe('policy_unavailable')
  })
})

describe('orchestration', () => {
  const images = [{ sha256: 'a'.repeat(64) }, { sha256: 'b'.repeat(64) }]
  const run = { runId: 'r1', conversationId: 'c1', request: 'warmer light', hint: { content_rating: 'sfw', named_real_people: [] }, images }

  test('missing or failed runtime assessments cannot publish', async () => {
    for (const provider of [null, scripted({}, null), visionProvider({ sample: async () => ({}) })]) {
      const s = safety({ provider, store: memory() })
      expect((await s.checkInputs(run)).reason).toBe('policy_unavailable')
      expect((await s.checkOutput({ ...run, inputs: { decision: 'allowed', rating: 'sfw' }, output: { sha256: 'c' } })).reason).toBe('policy_unavailable')
    }
  })

  test('a confident runtime provider can assess an edit without a fabricated benchmark report', async () => {
    const provider = visionProvider({ sample: async (request) => ({ stopReason: 'endTurn', content: { type: 'text', text: JSON.stringify(request._meta['alexia/format'].schema.properties.people ? { rating: 'sfw', people: [{ age: 'adult' }], confident: true } : { rating: 'sfw' }) } }) })
    const s = safety({ provider, store: memory() })
    const inputs = await s.checkInputs(run)
    expect(inputs.decision).toBe('allowed')
    expect((await s.checkOutput({ ...run, inputs, output: { mimeType: 'image/png', data: 'AA', sha256: 'c' } })).decision).toBe('allowed')
    expect((await s.decisions('r1')).stages[0].provider.report).toBeNull()
  })

  test('decisions are recorded with categories, not content', async () => {
    const s = safety({ provider: scripted({ text: ok('sfw'), [images[0].sha256]: ok('sfw', ['adult']), [images[1].sha256]: ok('sfw') }), store: memory() })
    const d = await s.checkInputs(run)
    expect(d.decision).toBe('allowed')
    const recorded = JSON.stringify(await s.decisions('r1'))
    expect(recorded).toContain('eval_test')
    expect(recorded).not.toContain('warmer light')
  })

  test('a block is remembered against the exact pictures, for every other tool to see', async () => {
    const s = safety({ provider: scripted({ text: ok('sfw'), [images[0].sha256]: ok('explicit', ['uncertain']), [images[1].sha256]: ok('sfw') }), store: memory() })
    expect((await s.checkInputs(run)).decision).toBe('blocked')
    expect(await s.isBlocked('c1', [images[0].sha256])).toBe(true)
    expect(await s.isBlocked('c2', [images[0].sha256])).toBe(false)
    // Asking again with the same pictures does not re-roll the assessment.
    expect((await s.checkInputs({ ...run, runId: 'r2' })).reason).toBe('input_blocked')
    // In adult mode a content-limit refusal does not follow the pictures; a possible minor would.
    const adultRun = safety({ provider: scripted({ text: ok('explicit'), [images[0].sha256]: ok('explicit', ['adult']), [images[1].sha256]: ok('sfw') }), store: memory() })
    expect((await adultRun.checkInputs({ ...run, runId: 'r3', adult: true })).decision).toBe('allowed')
    await s.forget('c1', ['r1'])
    expect(await s.isBlocked('c1', [images[0].sha256])).toBe(false)
  })
})

describe('local vision provider', () => {
  const answer = (text, stopReason = 'endTurn') => async (request) => {
    expect(request._meta['alexia/local']).toBe(true)
    return { content: { type: 'text', text }, stopReason }
  }

  test('supports runtime assessments without claiming an evaluation report', () => {
    expect(visionProvider({ sample: answer('{}') }).evaluation).toBeNull()
  })

  test('text rating does not ask for unseen people; images still require their own assessment', async () => {
    const requests = []
    const provider = visionProvider({ sample: async (request) => {
      requests.push(request)
      return { stopReason: 'endTurn', content: { type: 'text', text: JSON.stringify(request._meta['alexia/format'].schema.properties.people ? { rating: 'sfw', people: [], confident: true } : { rating: 'sfw' }) } }
    } })
    expect(await provider.assessText('Change the red square to blue.')).toEqual(ok('sfw'))
    expect(requests[0].systemPrompt).toContain('words only')
    expect(requests[0]._meta['alexia/format'].schema.required).toEqual(['rating'])
    expect(requests[0]._meta['alexia/format'].schema.properties.rating.enum).toContain('uncertain')
    await provider.assessImage({ mimeType: 'image/png', data: 'AA' })
    expect(requests[1].systemPrompt).toContain('one entry per visible person')
    expect(requests[1].messages[0].content[0].type).toBe('image')
  })

  test('uncertain, malformed and truncated text assessments still stop the edit', async () => {
    for (const [text, stop, status] of [
      ['{"rating":"uncertain"}', 'endTurn', 'inconclusive'],
      ['{"rating":"unknown"}', 'endTurn', 'failed'],
      ['{"rating":"sfw","extra":true}', 'endTurn', 'failed'],
      ['{"rating":"sfw"}', 'maxTokens', 'failed'],
    ]) {
      const provider = visionProvider({ sample: answer(text, stop) })
      expect((await provider.assessText('Change the color.')).status).toBe(status)
      expect((await safety({ provider, store: memory() }).checkInputs({ runId: 'r', conversationId: 'c', request: 'Change the color.', images: [] })).reason).toBe('policy_unavailable')
    }
  })

  test('reads a confident answer, and treats doubt or nonsense as no answer', async () => {
    const p = (text, stop) => visionProvider({ sample: answer(text, stop) }).assessImage({ mimeType: 'image/png', data: 'AA' })
    expect(await p('{"rating":"sfw","people":[{"age":"adult"}],"confident":true}')).toEqual(ok('sfw', ['adult']))
    expect((await p('{"rating":"sfw","people":[],"confident":false}')).status).toBe('inconclusive')
    expect((await p('nope')).status).toBe('failed')
    expect((await p('{"rating":"sfw","people":[],"confident":true}', 'maxTokens')).status).toBe('failed')
  })
})
