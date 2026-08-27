// SPDX-License-Identifier: AGPL-3.0-only
import type { Model } from './catalog.js'
import { OLLAMA } from './ollama.js'
import { sent, type Rung } from './pool.js'
import { chat, ProviderError, type ChatRequest, type Provider, type Usage } from './provider.js'
import type { SecretStore } from './secrets.js'
import type { Message, Store } from './store.js'
import { costOf } from './usage.js'

/**
 * Which model, and why that one.
 *
 * Rules, not a classifier — a learned router this early is a trap, and the escape hatch
 * (*try that again with a smarter model*) collects the labelled data a cleverer one would
 * need anyway. Three axes, each independently pinnable, and the cheapest model that
 * satisfies **every** pin wins.
 *
 * Two behaviours here are not negotiable:
 *
 * - **429 goes to the next rung.** A free tier that throttles and then just fails means
 *   free does not mean free, it means broken — and that is the product promise gone.
 * - **A pin is never silently violated.** No model satisfying the pins is a sentence saying
 *   so, never a quiet reach for a cloud model. A privacy pin that escalates by itself is a
 *   betrayal, not a fallback.
 */

export type Tier = 'T0' | 'T1' | 'T2' | 'T3'
const TIERS: Tier[] = ['T0', 'T1', 'T2', 'T3']
const rank = (tier: Tier): number => TIERS.indexOf(tier)
const paid = (tier: Tier): boolean => rank(tier) >= rank('T2')

/** The privacy axis is not one switch: it is a placement policy per capability class. */
export type CapabilityClass = 'text' | 'image' | 'speech' | 'browsing'
export type Placement = Record<CapabilityClass, 'local' | 'cloud'>

/**
 * The three modes, as placements. Combined is not a compromise between the other two — it
 * is each job going to the side that is better at it: hosted models are strong at planning
 * and often free, while a local GPU makes images and speech free forever after one
 * download.
 */
export const MODES: Record<'local' | 'combined' | 'cloud', Placement> = {
  local: { text: 'local', image: 'local', speech: 'local', browsing: 'local' },
  combined: { text: 'cloud', image: 'local', speech: 'local', browsing: 'cloud' },
  cloud: { text: 'cloud', image: 'cloud', speech: 'cloud', browsing: 'cloud' },
}

export interface Pins {
  placement: Placement
  /** `/best` walks the list from the top instead of the bottom. */
  prefer?: 'cheap' | 'best'
  /** `/nsfw`. A model whose content policy is merely *unknown* does not satisfy it. */
  uncensored?: boolean
  /** The user named one. It wins outright, and is the only way past an unknown flag. */
  model?: string
}

/** How much model the work needs. Request shape, kept boring on purpose. */
export type Shape = 'simple' | 'tools' | 'hard'

export interface Ask {
  messages: Message[]
  tools?: { name: string }[]
  /** Which capability class this is, for the placement policy. Text unless told otherwise. */
  class?: CapabilityClass
  /** The asking plugin's declared floor — `min_tier` in its manifest. */
  minTier?: Tier
  /** *Try that again with a smarter model*: everything at or below this tier is out. */
  above?: Tier
}

export interface Choice {
  model: Model
  provider: Provider
}

export type Verdict = { ok: true; choices: Choice[] } | { ok: false; why: string }

/** Everything the router needs to know about the world, gathered by the caller. */
export interface World {
  /** Hosted models, from the catalog. */
  models: readonly Model[]
  /** What is installed locally and reachable. Empty when Ollama is not running. */
  local: readonly Model[]
  /** Hosted providers with a key and requests left, in the pool's order. */
  rungs: readonly Rung[]
}

/**
 * The floor each shape needs, as data. Simple work goes anywhere; hard reasoning stays off
 * a small local model, because a 7–9B model at Q4 is weak at planning.
 *
 * ponytail: that last row is open question G5 — whether a small local model can genuinely
 * *plan* is being tested at M15-1 on this machine. If it can, this becomes `T0` and Local
 * mode becomes a real agent rather than a chat window. One row, deliberately.
 */
const FLOOR: Record<Shape, Tier> = { simple: 'T0', tools: 'T0', hard: 'T1' }

/** Words that mean the work is not a quick answer. Boring, and edited when it is wrong. */
const HARD =
  /\b(refactor|debug|architect|design|prove|derive|optimi[sz]e|why does|step by step|plan (?:out|the))\b/i

export function shapeOf(ask: Ask): Shape {
  const last = [...ask.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  if (HARD.test(last) || last.includes('```') || last.length > 400) return 'hard'
  if (ask.tools && ask.tools.length > 0) return 'tools'
  return 'simple'
}

/**
 * The models that satisfy every pin, cheapest first — a plan rather than a pick, because
 * the rung below might be rate-limited in the half-second between choosing and sending.
 */
export function route(ask: Ask, pins: Pins, world: World): Verdict {
  const where = pins.placement[ask.class ?? 'text']
  const connected = new Map(world.rungs.map((rung) => [rung.provider.id, rung.provider]))

  // Local placement means local: a model on this machine, and nothing else. Cloud
  // placement means the APIs, which is what somebody choosing it asked for.
  const pool: Choice[] =
    where === 'local' ?
      world.local.map((model) => ({ model, provider: OLLAMA }))
    : world.models.flatMap((model) => {
        const provider = connected.get(model.provider)
        return provider ? [{ model, provider }] : []
      })

  if (pins.model) {
    // The user named one. Their choice, including past a flag nobody has verified.
    const named = pool.find((c) => c.model.id === pins.model)
    return named ? { ok: true, choices: [named] } : { ok: false, why: `${pins.model} is not available right now.` }
  }

  const shape = shapeOf(ask)
  const floor = [FLOOR[shape], ask.minTier ?? 'T0'].reduce((a, b) => (rank(a) >= rank(b) ? a : b))
  const needsTools = shape === 'tools' || (ask.tools?.length ?? 0) > 0

  const choices = pool
    .filter((c) => rank(c.model.tier) >= rank(floor))
    .filter((c) => ask.above === undefined || rank(c.model.tier) > rank(ask.above))
    .filter((c) => !needsTools || c.model.supportsTools)
    // `unknown` is not a yes. Nothing is routed to an uncensored request on a hunch.
    .filter((c) => !pins.uncensored || c.model.nsfwOk === 'yes')
    .sort(cheapest)

  if (choices.length > 0) return { ok: true, choices: pins.prefer === 'best' ? [...choices].reverse() : choices }
  return { ok: false, why: refusal(where, pins, pool, needsTools) }
}

const cheapest = (a: Choice, b: Choice): number =>
  rank(a.model.tier) - rank(b.model.tier) || a.model.priceIn - b.model.priceIn || a.model.priceOut - b.model.priceOut

/**
 * Why there is nothing, in words that name the next action. This is the half of the
 * router the user actually meets, so it says what is missing and what to type.
 */
function refusal(where: 'local' | 'cloud', pins: Pins, pool: Choice[], needsTools: boolean): string {
  if (where === 'local') {
    if (pool.length === 0) return 'no local model is installed — install one, or type /cloud'
    if (pins.uncensored) return 'no local uncensored model is installed — install one, or type /cloud'
    if (needsTools) return 'no local model here can use tools — install one that can, or type /cloud'
    return 'no local model fits this request — install a larger one, or type /cloud'
  }
  if (pool.length === 0) {
    return 'no provider is connected and nothing has anything left — add a key in settings, or install a local model and type /local'
  }
  if (pins.uncensored) return 'no uncensored model is available from the providers you have connected'
  if (needsTools) return 'none of the models available to you can use tools'
  return 'no model fits this request right now — try again shortly'
}

export interface Answer {
  message: Message
  usage: Usage
  model: Model
  provider: Provider
}

/**
 * Walk the plan until one of them answers.
 *
 * A rung that says 429 is not an error, it is the next rung's turn — and every request is
 * counted against its provider whether or not it worked, because a refused request still
 * counted against the tier that refused it.
 */
export async function send(
  choices: Choice[],
  request: Omit<ChatRequest, 'model'>,
  store: Store,
  secrets: SecretStore,
  hooks: {
    onDelta?: (text: string) => void
    onNote?: (line: string) => void
    /** The hard stop (M1-9). False and the paid rungs are not rungs at all. */
    paidAllowed?: boolean
    /** Who this is for, so spend can be totalled per session and per plugin. */
    session?: number
    plugin?: string
  } = {},
): Promise<Answer> {
  let last: unknown
  let blocked = false
  for (const [at, choice] of choices.entries()) {
    if (paid(choice.model.tier) && hooks.paidAllowed === false) {
      // A cap that is reached does not quietly pick something worse, and it does not
      // quietly spend either. It stops, and the caller says why.
      blocked = true
      continue
    }
    // One plain line before the charge, not after it. Nobody is surprised by a bill from
    // something that did not say anything.
    if (paid(choice.model.tier)) {
      hooks.onNote?.(
        at === 0 ?
          `Using ${choice.model.name}, which costs money — about $${choice.model.priceIn.toFixed(2)} per million words in.`
        : `The free models are used up, so this one goes to ${choice.model.name}, which costs money.`,
      )
    }
    sent(store, choice.provider)
    try {
      const { message, usage } = await chat(
        choice.provider,
        { ...request, model: choice.model.id },
        hooks.onDelta,
        secrets,
      )
      store.recordUsage({
        session: hooks.session,
        plugin: hooks.plugin,
        model: choice.model.id,
        provider: choice.provider.id,
        tokensIn: usage.in,
        tokensOut: usage.out,
        cost: costOf(choice.model, usage),
      })
      return { message, usage, model: choice.model, provider: choice.provider }
    } catch (error) {
      last = error
      // Rate-limited, or the provider is having a moment. Either way the next rung can try.
      const status = error instanceof ProviderError ? error.status : 0
      if (status === 429 || status >= 500) continue
      throw error
    }
  }
  if (blocked && last === undefined) {
    throw new ProviderError(402, 'the monthly cap is reached — raise it in settings, or use a free model')
  }
  throw last ?? new ProviderError(503, 'nothing was available to ask')
}
