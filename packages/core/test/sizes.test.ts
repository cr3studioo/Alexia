// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Model } from '../src/catalog.js'
import type { Health, Judgement } from '../src/health.js'
import { READS_SHORT, sizeFor, sizedFor, type Choice, type Personality, type Strike, type World } from '../src/router.js'
import type { Provider } from '../src/provider.js'

/**
 * **`plan-personality.md` §2: three sizes, chosen by capability rather than by price** (D160).
 *
 * A personality goes into the system prompt on every step, so six hundred words across a
 * fifteen-step task is 7–8k tokens re-sent. On a paid model that is money; on a free one it is
 * context, rate limit, and instructions followed halfway — which is the shape of the bug this
 * whole plan opened with, a 5,825-character description answered by a 2.6B model.
 *
 * The rule this file exists to hold is the section's own: **when in doubt, the weaker reader.**
 */

const alpha: Provider = { id: 'alpha', name: 'Alpha', baseUrl: 'http://127.0.0.1:1', rpm: 100, rpd: 100 }

const model = (over: Partial<Model> & Pick<Model, 'id'>): Model => ({
  name: over.id,
  provider: 'alpha',
  tier: 'T1',
  priceIn: 0,
  priceOut: 0,
  context: 131_072,
  supportsTools: true,
  modality: ['text'],
  nsfwOk: 'unknown',
  trainsOnYourData: 'unknown',
  ...over,
})
const pick = (one: Model): Choice => ({ model: one, provider: alpha })
const judgement = (over: Partial<Judgement> = {}): Judgement => ({ tags: [], untested: false, doubted: false, ...over })
const health = (rows: Record<string, Judgement>): Health => new Map(Object.entries(rows))
const world = (over: Partial<World> = {}): Pick<World, 'health' | 'strikes'> => ({ ...over })

const noon = Date.UTC(2026, 8, 19, 12)

test('a paid model gets the long one, and a free hosted model the middle', () => {
  expect(sizeFor(pick(model({ id: 'paid/big', tier: 'T2', priceIn: 1 })), world())).toBe('high')
  expect(sizeFor(pick(model({ id: 'paid/frontier', tier: 'T3', priceIn: 15 })), world())).toBe('high')
  expect(sizeFor(pick(model({ id: 'vendor/free-70b', params: 70 })), world())).toBe('medium')
  // This machine's own, from 7B up: medium, like a free hosted one. Free in a different sense,
  // and the section groups them for what they can read rather than for what they cost.
  expect(sizeFor(pick(model({ id: 'qwen3:8b', tier: 'T0', params: 8 })), world())).toBe('medium')
})

test('known to be small, a short window, or a router: the short one', () => {
  expect(sizeFor(pick(model({ id: 'vendor/tiny-2.6b', params: 2.6 })), world())).toBe('small')
  // A window under 32k is a window the personality is competing with — the trace, the tools and
  // the answer are already close together down there, and six hundred words is what gets
  // squeezed out silently.
  expect(sizeFor(pick(model({ id: 'vendor/cramped', context: READS_SHORT - 1 })), world())).toBe('small')
  expect(sizeFor(pick(model({ id: 'vendor/roomy', context: READS_SHORT })), world())).toBe('medium')
  // Any router, whatever it says about itself: it is a different model each time, so plan for
  // the worst one it might hand the request to.
  expect(sizeFor(pick(model({ id: 'alpha-auto/free', name: 'Alpha Auto', params: 120 })), world())).toBe('small')
  // Even a paid router. The price says nothing about which model actually answers.
  expect(sizeFor(pick(model({ id: 'alpha-auto/pro', name: 'Alpha Auto Pro', tier: 'T2', priceIn: 1 })), world())).toBe('small')
})

test('a size nobody publishes is not smallness on its own — it takes a doubt as well', () => {
  const quiet = model({ id: 'closed/one' })
  // Most closed models never say how big they are, and silence is the middle everywhere else
  // in this codebase. On its own it is not a reason to send her half.
  expect(sizeFor(pick(quiet), world())).toBe('medium')

  const doubts = (one: Partial<Judgement>): Pick<World, 'health'> => ({ health: health({ 'alpha\ncloused': judgement(), 'alpha\nclosed/one': judgement(one) }) })
  expect(sizeFor(pick(quiet), doubts({ untested: true }))).toBe('small')
  expect(sizeFor(pick(quiet), doubts({ doubted: true }))).toBe('small')
  expect(sizeFor(pick(quiet), doubts({ aside: 'answers empty' }))).toBe('small')
  // A failure still counting against it, from D159's strikes.
  const struck: Strike[] = [{ provider: 'alpha', model: 'closed/one', at: noon - 60_000, outcome: 'failed' }]
  expect(sizeFor(pick(quiet), { strikes: struck }, noon)).toBe('small')
  // And once it has aged out, the doubt is gone and so is the reason.
  expect(sizeFor(pick(quiet), { strikes: struck }, noon + 6 * 60 * 60 * 1000)).toBe('medium')

  // A model that says it is big is not demoted by a doubt: the doubt is about whether it
  // answers, and the size is about whether it can read.
  const big = model({ id: 'vendor/free-120b', params: 120 })
  expect(sizeFor(pick(big), doubts({ doubted: true }))).toBe('medium')
})

test('the size is chosen for the model a call goes to, and the loop asks it per rung', () => {
  // It was chosen once per step for the weakest rung in the whole plan — and a plan is every
  // model that fits, so a router or a 2B at its tail decided what the strong model at its head
  // was told. `send` asks each rung's messages just before asking it, so a fallback to a 2B
  // still gets the short one and nothing else does. `sized.test.ts` holds this over the wire.
  const paid = pick(model({ id: 'paid/big', tier: 'T2', priceIn: 1 }))
  const local2b = pick(model({ id: 'gemma:2b', tier: 'T0', params: 2 }))
  expect(sizeFor(paid, world())).toBe('high')
  expect(sizeFor(local2b, world())).toBe('small')
  const agent = readFileSync(join(import.meta.dirname, '..', 'src', 'agent.ts'), 'utf8').replace(/\r\n/g, '\n')
  expect(agent).toMatch(/sizedFor\(options\.personality, sizeFor\(choice, now\)\)/)
  expect(agent).toMatch(/messagesFor: dressed/)
})

test('what is actually sent is what is said, so a one-document personality reads as the long one', () => {
  const three: Personality = { high: 'six hundred words', medium: 'three hundred', small: 'one hundred' }
  expect(sizedFor(three, 'small')).toEqual({ text: 'one hundred', size: 'small' })
  expect(sizedFor(three, 'medium')).toEqual({ text: 'three hundred', size: 'medium' })
  expect(sizedFor(three, 'high')).toEqual({ text: 'six hundred words', size: 'high' })

  // The case every row on this machine is in today: one document, and it is what goes out. A
  // trace saying *small* about six hundred words that were sent would be the record lying in
  // the one place it exists to tell the truth.
  const one: Personality = { high: 'six hundred words' }
  expect(sizedFor(one, 'small')).toEqual({ text: 'six hundred words', size: 'high' })
  expect(sizedFor(one, 'medium')).toEqual({ text: 'six hundred words', size: 'high' })

  // A row with a medium but no small: a small reader gets the medium, which is the next one up.
  const two: Personality = { high: 'six hundred words', medium: 'three hundred' }
  expect(sizedFor(two, 'small')).toEqual({ text: 'three hundred', size: 'medium' })
})
