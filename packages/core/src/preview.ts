// SPDX-License-Identifier: AGPL-3.0-only
import type { Model } from './catalog.js'
import { shapeOf, type Shape } from './router.js'
import { CORE } from './secrets.js'
import type { Message, Store } from './store.js'

/**
 * What a task is about to cost, said once, before it starts.
 *
 * **Once at the start, never per step.** A confirmation before every step is how an agent
 * becomes something people click through without reading, and a thing clicked through
 * without reading is worse than no confirmation at all — it launders the decision. So this
 * asks one question, at the only moment the answer can still change anything.
 *
 * **And usually not even that.** The long leash is deliberate (risk 4 in Alexia.md): high
 * ceilings, mostly running free. A preview in front of a task that costs nothing is noise
 * teaching people that Alexia's questions are noise, so the threshold exists to keep the
 * question rare enough to be read.
 */

export interface Ceilings {
  /** Steps in one task. The wall a runaway loop meets before the month's budget does. */
  steps: number
  /** Dollars a month. Undefined is no ceiling, which is the default (M1-9 owns the rest). */
  monthly?: number
  /** Estimated dollars above which a task asks first. Zero would ask about free tasks. */
  askAbove: number
}

/**
 * A long leash, chosen knowingly.
 *
 * 24 steps is more than any honest task here has needed and few enough that a loop calling
 * the same tool forever hits it in seconds rather than in money. Two cents is the smallest
 * number that is not noise: below it the question costs more attention than the money.
 */
export const DEFAULT_CEILINGS: Ceilings = { steps: 24, askAbove: 0.02 }

export const ceilings = (store: Store): Ceilings => ({
  ...DEFAULT_CEILINGS,
  ...((store.kvGet(CORE, 'ceilings') as Partial<Ceilings> | undefined) ?? {}),
})

export const setCeilings = (store: Store, next: Partial<Ceilings>): void =>
  store.kvSet(CORE, 'ceilings', { ...ceilings(store), ...next })

export interface Estimate {
  steps: number
  dollars: number
  /** What it would run on. Named, because *roughly $0.04* invites *on what?* */
  model?: string
}

/**
 * How many steps a request looks like, by shape.
 *
 * Rules, not a predictor — the same choice the router made and for the same reason. These
 * three numbers are wrong in individual cases and roughly right in aggregate, which is all a
 * preview needs to be: nobody decides differently between eleven steps and twelve.
 */
const STEPS: Record<Shape, number> = { simple: 1, tools: 4, hard: 12 }

/**
 * Tokens a step costs, roughly. The context grows as the trace does, so a later step costs
 * more than an early one — which is why this is a sum and not a multiplication.
 *
 * Deliberately an overestimate. A preview that says four cents and charges six is a broken
 * promise; one that says six and charges four is a pleasant surprise.
 */
const BASE_IN = 900
const GROWTH_IN = 700
const OUT_PER_STEP = 250

export function estimate(messages: Message[], model: Model | undefined): Estimate {
  const steps = STEPS[shapeOf({ messages })]
  if (!model) return { steps, dollars: 0 }

  let tokensIn = 0
  for (let step = 0; step < steps; step++) tokensIn += BASE_IN + GROWTH_IN * step
  const dollars = (tokensIn / 1_000_000) * model.priceIn + ((OUT_PER_STEP * steps) / 1_000_000) * model.priceOut
  return { steps, dollars, model: model.name }
}

/** Worth interrupting for? Only when it costs real money. Free work is not a question. */
export const worthAsking = (estimate: Estimate, ceilings: Ceilings): boolean =>
  estimate.dollars > ceilings.askAbove

/**
 * The sentence. Round numbers, the model named, and the step count as *about* — because it
 * is about, and a precise-looking estimate that turns out wrong costs more trust than a
 * vague one that turns out wrong.
 */
export const previewLine = (estimate: Estimate): string =>
  `This looks like about ${String(estimate.steps)} steps${estimate.model ? ` on ${estimate.model}` : ''}, roughly $${estimate.dollars.toFixed(2)}. Continue?`
