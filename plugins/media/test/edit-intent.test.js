// SPDX-License-Identifier: AGPL-3.0-only
import { supportedSamplingSchema } from '@alexia/sdk'
import { describe, expect, test } from 'vitest'
import { compile, slots } from '../edit/compile.js'
import { plan } from '../edit/planner.js'
import { jobSchema } from '../edit/schema.js'
import { parseJob, validateJob } from '../edit/validate.js'

/**
 * From a planner's answer to the words a render receives.
 *
 * The planner is a model and these tests do not run one: they hand the validator and compiler
 * the answers a planner could give, and prove what the editor does with each — runs it, asks,
 * refuses, or asks for a repair. Whether a real local model *gives* the right answer is an
 * evaluation question for the fixture set in Section 12 of the plan, not a unit test.
 */

const slotName = (n) => `Picture ${n}`

/** A complete, valid job, with the fields a case cares about laid over it. */
const job = (over = {}) => ({
  schema_version: '1.1',
  action: 'image_edit',
  target: 'image_1',
  instruction: '',
  references: [],
  preserve: [],
  exclude: [],
  output_style: null,
  needs_clarification: false,
  clarification_question: null,
  confidence: 0.9,
  content_rating: 'sfw',
  named_real_people: [],
  ...over,
})

const ready = (value, selection = ['image_1', 'image_2'], version = '1.1', regions = []) => {
  const result = validateJob(value, { version, selection, regions })
  expect(result.outcome, JSON.stringify(result)).toBe('ready')
  return result
}

describe('schema', () => {
  test('the planner contract is inside the subset private sampling accepts, for both versions', () => {
    expect(supportedSamplingSchema(jobSchema({ version: '1.1', labels: ['image_1', 'image_2', 'image_3'] }))).toBe(true)
    expect(supportedSamplingSchema(jobSchema({ version: '1.2', labels: ['image_1'], regions: ['r1', 'r2'] }))).toBe(true)
    expect(supportedSamplingSchema(jobSchema({ version: '1.2', labels: ['image_1'] }))).toBe(true)
  })

  test('an unknown version is refused rather than flattened', () => {
    expect(() => jobSchema({ version: '1.3', labels: ['image_1'] })).toThrow(/not supported/)
  })
})

describe('structural validation', () => {
  const selection = ['image_1', 'image_2']
  const errors = (value) => validateJob(value, { version: '1.1', selection })

  test('unknown keys are refused at every level', () => {
    expect(errors({ ...job(), seed: 4 }).outcome).toBe('invalid')
    expect(errors(job({ references: [{ image: 'image_2', roles: ['pose'], strength: 1, node: 'X' }] })).outcome).toBe('invalid')
  })

  test('every field must be present, nullable ones as null', () => {
    const missing = job()
    delete missing.output_style
    expect(errors(missing).errors.join()).toMatch(/missing output_style/)
  })

  test('a version other than the negotiated one stops', () => {
    expect(errors(job({ schema_version: '1.2' })).outcome).toBe('invalid')
  })

  test('only selected labels are images — not paths, URLs or other conversations\' pictures', () => {
    for (const image of ['image_3', '/Users/me/a.png', 'https://example.com/a.png']) {
      expect(errors(job({ references: [{ image, roles: ['pose'], strength: 1 }] })).outcome).toBe('invalid')
    }
  })

  test('numbers must be finite and in range; strings and lists are bounded', () => {
    expect(errors(job({ confidence: 1.5 })).outcome).toBe('invalid')
    expect(errors(job({ references: [{ image: 'image_2', roles: ['pose'], strength: -0.1 }] })).outcome).toBe('invalid')
    expect(errors(job({ instruction: 'x'.repeat(4_001) })).outcome).toBe('invalid')
    expect(errors(job({ named_real_people: Array(9).fill('A') })).outcome).toBe('invalid')
    expect(errors(job({ references: [{ image: 'image_2', roles: [], strength: 1 }] })).outcome).toBe('invalid')
  })

  test('repeated entries are refused, not de-duplicated quietly', () => {
    expect(errors(job({ preserve: ['pose', 'pose'] })).outcome).toBe('invalid')
    expect(errors(job({ references: [{ image: 'image_2', roles: ['pose', 'pose'], strength: 1 }] })).outcome).toBe('invalid')
  })

  test('a question is present exactly when one is needed', () => {
    expect(errors(job({ needs_clarification: true })).outcome).toBe('invalid')
    expect(errors(job({ clarification_question: 'Which?' })).outcome).toBe('invalid')
  })

  test('oversized, empty and non-JSON answers never become jobs', () => {
    const ctx = { version: '1.1', selection }
    expect(parseJob('', ctx).outcome).toBe('invalid')
    expect(parseJob('{"schema_version": "1.1",', ctx).outcome).toBe('invalid')
    expect(parseJob(`"${'x'.repeat(40_000)}"`, ctx).errors[0]).toMatch(/exceeds/)
  })
})

describe('semantic validation', () => {
  const selection = ['image_1', 'image_2', 'image_3']
  const outcome = (value) => validateJob(value, { version: '1.1', selection })

  test('a question never renders, whatever else the answer says', () => {
    const asked = outcome(job({ needs_clarification: true, clarification_question: 'Which attributes should I copy?' }))
    expect(asked).toMatchObject({ outcome: 'needs_clarification', question: 'Which attributes should I copy?' })
  })

  test('low confidence asks a deterministic focused question', () => {
    const first = outcome(job({ confidence: 0.4 }))
    expect(first.outcome).toBe('needs_clarification')
    expect(outcome(job({ confidence: 0.4 })).question).toBe(first.question)
    expect(first.question.length).toBeLessThanOrEqual(300)
  })

  test('a role from two pictures is a question, not last-write-wins', () => {
    const r = outcome(job({ references: [
      { image: 'image_2', roles: ['clothing'], strength: 1 },
      { image: 'image_3', roles: ['clothing'], strength: 1 },
    ] }))
    expect(r).toMatchObject({ outcome: 'needs_clarification', reason: 'ambiguous_intent' })
    expect(r.question).toMatch(/image_2 or image_3/)
  })

  test('a role cannot be both kept and replaced, or both taken and excluded', () => {
    expect(outcome(job({ preserve: ['pose'], references: [{ image: 'image_2', roles: ['pose'], strength: 1 }] })).outcome).toBe('needs_clarification')
    expect(outcome(job({
      references: [{ image: 'image_2', roles: ['pose'], strength: 1 }],
      exclude: [{ image: 'image_2', role: 'pose' }],
    })).outcome).toBe('needs_clarification')
  })

  test('identity comes from one picture; blending is refused', () => {
    const r = outcome(job({ references: [
      { image: 'image_2', roles: ['identity'], strength: 1 },
      { image: 'image_3', roles: ['face'], strength: 1 },
    ] }))
    expect(r).toMatchObject({ outcome: 'unsupported', reason: 'unsupported_action' })
  })

  test('replacing identity while keeping it is a question', () => {
    expect(outcome(job({ preserve: ['identity'], references: [{ image: 'image_2', roles: ['identity'], strength: 1 }] })).outcome)
      .toBe('needs_clarification')
  })

  test('text-to-image and area edits are not part of the 1.1 editor', () => {
    expect(outcome(job({ action: 'image_generate', target: null })).reason).toBe('unsupported_action')
    expect(outcome(job({ action: 'inpaint' })).reason).toBe('unsupported_action')
  })

  test('an edit has a target', () => {
    expect(outcome(job({ target: null, instruction: 'warmer' })).outcome).toBe('invalid')
  })

  test('the wording may only mention pictures that will be loaded', () => {
    expect(outcome(job({ instruction: 'make it like image_9' })).outcome).toBe('invalid')
    expect(outcome(job({ instruction: 'use the hat from image_2' })).outcome).toBe('needs_clarification')
  })

  test('an empty edit asks what to change', () => {
    expect(outcome(job()).outcome).toBe('needs_clarification')
  })

  test('selected pictures that contribute nothing are reported unused', () => {
    const r = outcome(job({ references: [
      { image: 'image_2', roles: ['clothing'], strength: 1 },
      { image: 'image_3', roles: ['lighting'], strength: 0 },
    ] }))
    expect(r.unused).toEqual(['image_3'])
  })
})

describe('the source request cases', () => {
  const two = ['image_1', 'image_2']

  test('"Put me in her clothes."', () => {
    const { job: j } = ready(job({
      instruction: 'Dress the person in image_1 in the outfit from image_2.',
      references: [{ image: 'image_2', roles: ['clothing'], strength: 1 }],
      preserve: ['identity', 'face', 'body', 'pose'],
    }), two)
    const { instruction } = compile(j, two, { slotName })
    expect(instruction).toBe(
      'Edit Picture 1. Dress the person in Picture 1 in the outfit from Picture 2. ' +
      'Use only the clothing from Picture 2. ' +
      'Keep the identity, facial features, body proportions and pose of Picture 1 unchanged. ' +
      'Do not take the identity, facial features, body proportions and art style from Picture 2. ' +
      'Keep the existing style of Picture 1.',
    )
  })

  test('"Use her clothes and pose on me."', () => {
    const { job: j } = ready(job({
      instruction: 'Put the person in image_1 in the outfit and pose from image_2.',
      references: [{ image: 'image_2', roles: ['pose', 'clothing'], strength: 1 }],
      preserve: ['face', 'identity'],
    }), two)
    const { instruction } = compile(j, two, { slotName })
    expect(instruction).toContain('Use only the clothing and pose from Picture 2.')
    expect(instruction).toContain('Keep the identity and facial features of Picture 1 unchanged.')
  })

  test('"Keep my pose but use her outfit."', () => {
    const { job: j } = ready(job({
      instruction: 'Change the outfit in image_1 to the one from image_2.',
      references: [{ image: 'image_2', roles: ['clothing', 'accessories'], strength: 1 }],
      preserve: ['identity', 'pose'],
    }), two)
    const { instruction } = compile(j, two, { slotName })
    expect(instruction).toContain('Use only the clothing and accessories from Picture 2.')
    expect(instruction).toContain('Keep the identity and pose of Picture 1 unchanged.')
    expect(instruction).not.toMatch(/pose from Picture 2/)
  })

  test('"Only use the lighting from this."', () => {
    const { job: j } = ready(job({
      instruction: 'Relight image_1 to match image_2.',
      references: [{ image: 'image_2', roles: ['lighting'], strength: 1 }],
      preserve: ['identity', 'clothing', 'pose', 'art_style'],
    }), two)
    const { instruction } = compile(j, two, { slotName })
    expect(instruction).toContain('Use only the lighting from Picture 2.')
    expect(instruction).toContain('Do not take the identity, facial features, body proportions and art style from Picture 2.')
  })

  test('"Use image 2\'s outfit and image 3\'s pose." keeps the sources separate', () => {
    const three = ['image_1', 'image_2', 'image_3']
    const { job: j } = ready(job({
      instruction: 'Give the person in image_1 the outfit from image_2 and the pose from image_3.',
      references: [
        { image: 'image_3', roles: ['pose'], strength: 1 },
        { image: 'image_2', roles: ['clothing'], strength: 1 },
      ],
      preserve: ['identity'],
    }), three)
    const { instruction, slots: order } = compile(j, three, { slotName })
    expect(order).toEqual([{ label: 'image_1', slot: 1 }, { label: 'image_2', slot: 2 }, { label: 'image_3', slot: 3 }])
    expect(instruction).toContain('Use only the clothing from Picture 2. Use only the pose from Picture 3.')
  })

  test('"Make me look like this." asks before anything renders', () => {
    expect(validateJob(job({
      instruction: 'Make image_1 look like image_2.',
      needs_clarification: true,
      clarification_question: 'Which parts of image_2 should I copy — the hairstyle, the outfit, the pose, or something else?',
      confidence: 0.3,
    }), { version: '1.1', selection: two, regions: [] }).outcome).toBe('needs_clarification')
  })

  test('three pictures: identity, outfit and lighting with no style carried across', () => {
    const three = ['image_1', 'image_2', 'image_3']
    const { job: j } = ready(job({
      instruction: 'Keep the person from image_1, dress them in the outfit from image_2 and light the scene like image_3.',
      references: [
        { image: 'image_1', roles: ['identity'], strength: 1 },
        { image: 'image_2', roles: ['clothing'], strength: 1 },
        { image: 'image_3', roles: ['lighting'], strength: 0.7 },
      ],
      preserve: ['identity', 'face'],
    }), three)
    const { instruction } = compile(j, three, { slotName })
    expect(instruction).toContain('Do not take the identity, facial features, body proportions and art style from Picture 2.')
    expect(instruction).toContain('Do not take the identity, facial features, body proportions and art style from Picture 3.')
    expect(instruction).toContain('Keep the existing style of Picture 1.')
  })

  test('a literal object edit with no references keeps its details', () => {
    const { job: j } = ready(job({ instruction: 'Make the bag cobalt blue and remove the lamp post.', preserve: ['background'] }), ['image_1'])
    expect(compile(j, ['image_1'], { slotName }).instruction).toBe(
      'Edit Picture 1. Make the bag cobalt blue and remove the lamp post. Keep the background of Picture 1 unchanged. Keep the existing style of Picture 1.',
    )
  })
})

describe('compilation', () => {
  test('a target selected after its reference still occupies slot 1, in graph and prompt alike', () => {
    const selection = ['image_2', 'image_7']
    const { job: j } = ready(job({
      target: 'image_7',
      instruction: 'Put image_7 in the jacket from image_2.',
      references: [{ image: 'image_2', roles: ['clothing'], strength: 1 }],
    }), selection)
    const out = compile(j, selection, { slotName })
    expect(out.slots).toEqual([{ label: 'image_7', slot: 1 }, { label: 'image_2', slot: 2 }])
    expect(out.instruction).toMatch(/^Edit Picture 1\. Put Picture 1 in the jacket from Picture 2\./)
    expect(out.instruction).not.toMatch(/image_/)
  })

  test('a disabled reference is not loaded, and its exclusions are not mentioned', () => {
    const selection = ['image_1', 'image_2', 'image_3']
    const { job: j } = ready(job({
      instruction: 'Warmer light.',
      references: [
        { image: 'image_2', roles: ['lighting'], strength: 1 },
        { image: 'image_3', roles: ['pose'], strength: 0 },
      ],
      exclude: [{ image: 'image_3', role: 'clothing' }],
    }), selection)
    const out = compile(j, selection, { slotName })
    expect(out.slots.map((s) => s.label)).toEqual(['image_1', 'image_2'])
    expect(out.unused).toEqual(['image_3'])
    expect(out.instruction).not.toMatch(/Picture 3/)
  })

  test('the same edit in any order compiles to identical words', () => {
    const selection = ['image_1', 'image_2', 'image_3']
    const a = job({
      instruction: 'Outfit and light.',
      references: [{ image: 'image_2', roles: ['clothing', 'accessories'], strength: 1 }, { image: 'image_3', roles: ['lighting'], strength: 1 }],
      preserve: ['identity', 'pose'],
      exclude: [{ image: 'image_2', role: 'hairstyle' }, { image: 'image_3', role: 'background' }],
    })
    const b = { ...a, references: [{ image: 'image_3', roles: ['lighting'], strength: 1 }, { image: 'image_2', roles: ['accessories', 'clothing'], strength: 1 }],
      preserve: ['pose', 'identity'], exclude: [...a.exclude].reverse() }
    expect(compile(ready(b, selection).job, selection, { slotName })).toEqual(compile(ready(a, selection).job, selection, { slotName }))
  })

  test('named reference style replaces the keep-style clause', () => {
    const { job: j } = ready(job({ instruction: 'Restyle.', references: [{ image: 'image_2', roles: ['art_style'], strength: 1 }] }))
    const { instruction } = compile(j, ['image_1', 'image_2'], { slotName })
    expect(instruction).toContain('Use only the art style from Picture 2.')
    expect(instruction).toContain('Do not take the identity, facial features and body proportions from Picture 2.')
    expect(instruction).not.toContain('Keep the existing style')
  })

  test('compiling needs the profile\'s slot naming, never a guessed one', () => {
    const { job: j } = ready(job({ instruction: 'Warmer.' }), ['image_1'])
    expect(() => compile(j, ['image_1'], {})).toThrow(/slot naming/)
  })

  test('slots ignore the order references were written in', () => {
    expect(slots(job({ target: 'image_3', references: [{ image: 'image_2', roles: ['pose'], strength: 1 }, { image: 'image_1', roles: ['clothing'], strength: 1 }] }), ['image_1', 'image_2', 'image_3']).order)
      .toEqual([{ label: 'image_3', slot: 1 }, { label: 'image_1', slot: 2 }, { label: 'image_2', slot: 3 }])
  })
})

describe('regional 1.2 jobs', () => {
  const regions = ['note_hat', 'note_bag']
  const regional = (over) => job({ schema_version: '1.2', action: 'inpaint', regions: [], ...over })

  test('notes compile to one pass each, in the editor\'s order, whatever order the planner wrote them', () => {
    const { job: j } = ready(regional({ regions: [
      { region_id: 'note_bag', instruction: 'make this blue' },
      { region_id: 'note_hat', instruction: 'make it a straw hat' },
    ] }), ['image_1'], '1.2', regions)
    expect(compile(j, ['image_1'], { slotName }).passes).toEqual([
      { regionId: 'note_hat', instruction: 'Edit only the selected area of Picture 1: make it a straw hat. Keep everything else unchanged.' },
      { regionId: 'note_bag', instruction: 'Edit only the selected area of Picture 1: make this blue. Keep everything else unchanged.' },
    ])
  })

  test('the planner cannot invent a region, and inpaint needs one', () => {
    expect(validateJob(regional({ regions: [{ region_id: 'note_new', instruction: 'x' }] }), { version: '1.2', selection: ['image_1'], regions }).outcome).toBe('invalid')
    expect(validateJob(regional(), { version: '1.2', selection: ['image_1'], regions }).outcome).toBe('invalid')
    expect(validateJob(regional({ action: 'image_edit', instruction: 'x', regions: [{ region_id: 'note_hat', instruction: 'x' }] }), { version: '1.2', selection: ['image_1'], regions }).outcome).toBe('invalid')
  })
})

describe('planner', () => {
  const images = (n) => Array.from({ length: n }, (_, i) => ({ label: `image_${i + 1}`, mimeType: 'image/png', data: 'AAAA' }))
  const answering = (...texts) => {
    const calls = []
    const sample = async (request) => {
      calls.push(request)
      const next = texts.shift()
      return typeof next === 'string' ? { content: { type: 'text', text: next }, stopReason: 'endTurn' } : next
    }
    return { calls, sample }
  }
  const good = JSON.stringify(job({ instruction: 'Outfit from image_2.', references: [{ image: 'image_2', roles: ['clothing'], strength: 1 }] }))

  test('asks for one private, schema-constrained completion with no tools or history', async () => {
    const { calls, sample } = answering(good)
    const r = await plan({ request: 'Put me in her clothes', images: images(2), sample })
    expect(r).toMatchObject({ outcome: 'ready', attempts: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0]._meta['alexia/local']).toBe(true)
    expect(calls[0]._meta['alexia/format']).toMatchObject({ name: 'AlexiaImageJob', strict: true })
    expect(calls[0].includeContext).toBe('none')
    expect(calls[0]).not.toHaveProperty('tools')
    expect(calls[0].messages[0].content.filter((c) => c.type === 'image')).toHaveLength(2)
  })

  test('a fourth picture is refused before anything is sampled', async () => {
    const { calls, sample } = answering(good)
    expect(await plan({ request: 'x', images: images(4), sample })).toMatchObject({ outcome: 'failed', reason: 'input_limit' })
    expect(calls).toHaveLength(0)
  })

  test('an over-long request is refused, never truncated', async () => {
    const { calls, sample } = answering(good)
    expect((await plan({ request: 'x'.repeat(8_001), images: images(1), sample })).reason).toBe('request_limit')
    expect(calls).toHaveLength(0)
  })

  test('malformed output gets exactly one repair, with the same schema and pictures', async () => {
    const { calls, sample } = answering('not json', good)
    const r = await plan({ request: 'x', images: images(2), sample })
    expect(r).toMatchObject({ outcome: 'ready', attempts: 2 })
    expect(calls[1]._meta).toEqual(calls[0]._meta)
    expect(calls[1].messages[0]).toEqual(calls[0].messages[0])
    expect(calls[1].messages.at(-1).content.text).toMatch(/not valid JSON/)

    const twice = answering('nope', '{}', good)
    expect(await plan({ request: 'x', images: images(2), sample: twice.sample })).toMatchObject({ outcome: 'failed', reason: 'planner_invalid' })
    expect(twice.calls).toHaveLength(2)
  })

  test('a cut-off answer is never parsed or repaired', async () => {
    const { calls, sample } = answering({ content: { type: 'text', text: good }, stopReason: 'maxTokens' })
    expect(await plan({ request: 'x', images: images(2), sample })).toMatchObject({ outcome: 'failed', reason: 'planner_invalid' })
    expect(calls).toHaveLength(1)
  })

  test('ambiguity is a question and is not retried', async () => {
    const { calls, sample } = answering(JSON.stringify(job({ needs_clarification: true, clarification_question: 'Which parts?', confidence: 0.2 })))
    expect(await plan({ request: 'Make me look like this', images: images(2), sample })).toMatchObject({ outcome: 'needs_clarification', question: 'Which parts?' })
    expect(calls).toHaveLength(1)
  })

  test('the answer to a pending question goes back with the same request', async () => {
    const { calls, sample } = answering(good)
    await plan({ request: 'Make me look like this', answer: 'only the outfit', images: images(2), sample })
    expect(calls[0].messages[0].content.at(-1).text).toMatch(/Request: Make me look like this\nAnswer to your earlier question: only the outfit/)
  })

  test('an unavailable planner and a cancelled request are reported, not retried', async () => {
    let n = 0
    const broken = async () => {
      n++
      throw new Error('no local vision model')
    }
    expect(await plan({ request: 'x', images: images(1), sample: broken })).toMatchObject({ outcome: 'failed', reason: 'planner_unavailable' })
    expect(n).toBe(1)
    const controller = new AbortController()
    controller.abort()
    expect((await plan({ request: 'x', images: images(1), sample: broken, signal: controller.signal })).reason).toBe('cancelled')
    expect(n).toBe(1)
  })

  test('notes on an area need the 1.2 contract', async () => {
    const { calls, sample } = answering(good)
    expect((await plan({ request: 'x', images: images(1), regions: [{ id: 'r1', instruction: 'blue' }], sample })).reason).toBe('schema_unsupported')
    expect(calls).toHaveLength(0)
  })
})
