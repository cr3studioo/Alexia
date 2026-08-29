// SPDX-License-Identifier: AGPL-3.0-only
import type { Model } from './catalog.js'
import { OLLAMA } from './ollama.js'
import { sent, type Rung } from './pool.js'
import { chat, ProviderError, type ChatRequest, type Provider, type Usage } from './provider.js'
import { redact, summarise } from './redact.js'
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
  /**
   * The caller already knows how hard this is, so do not guess from the words.
   *
   * The agent loop (M15-1) is the reason this exists: `shapeOf` reads the last *user*
   * message, which does not change for the twenty steps that follow it — so every step of
   * a task that opened with *"refactor this"* would price as `hard` forever. Turning the
   * crank is not planning, and that difference is where the cost saving lives.
   */
  shape?: Shape
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
 * **How hard the work is no longer picks a tier** (D62). It used to: a `hard` shape floored
 * at `T1`, and since `T0` *means* local, that one row was the sentence "planning never runs
 * on this machine". G5 asked whether that was true, and the answer measured here is no —
 * qwen3:8b at Q4, driven by the M15-1 loop with no hints, listed a folder, read two files,
 * diffed them and answered correctly in three steps.
 *
 * So the row went to `T0`, and then the whole table read `T0, T0, T0` and was doing nothing.
 * A lookup that returns the same answer for every key is drift with a type annotation, so it
 * is gone, and what the shape actually decides is written where it happens: `needsTools`
 * below, and `PLANNER`.
 *
 * The floor that remains is the asking plugin's own `min_tier`, which was always separate.
 */

/**
 * The smallest model trusted to plan, in billions of parameters.
 *
 * This is the axis `tier` could not carry. **Every** local model is `T0` whether it is 1B or
 * 8B, so flipping the row above without this would have handed planning to a 1B — which the
 * measurement says nothing good about. Only local models report a size, so this only ever
 * excludes something on this machine; a hosted model is judged by its tier, as before.
 *
 * Seven because the class measured is 7–9B and the next size down on that machine is 1B.
 * There is no evidence sitting between them, and a threshold that pretends otherwise is a
 * guess wearing a number.
 */
const PLANNER = 7

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

  const shape = ask.shape ?? shapeOf(ask)
  const floor = ask.minTier ?? 'T0'
  const needsTools = shape === 'tools' || (ask.tools?.length ?? 0) > 0

  const choices = pool
    .filter((c) => rank(c.model.tier) >= rank(floor))
    .filter((c) => ask.above === undefined || rank(c.model.tier) > rank(ask.above))
    .filter((c) => !needsTools || c.model.supportsTools)
    // A model that reports its size and is too small to plan does not get planning work.
    // Silence about size is not smallness: a hosted model never says, and is not judged here.
    .filter((c) => shape !== 'hard' || c.model.params === undefined || c.model.params >= PLANNER)
    // `unknown` is not a yes. Nothing is routed to an uncensored request on a hunch.
    .filter((c) => !pins.uncensored || c.model.nsfwOk === 'yes')
    .sort(cheapest)

  if (choices.length > 0) return { ok: true, choices: pins.prefer === 'best' ? [...choices].reverse() : choices }
  return { ok: false, why: refusal(where, pins, pool, needsTools, shape) }
}

/**
 * Cheapest first — and **the tie is the interesting part**, because the free tier is one
 * enormous tie.
 *
 * Tier, then the two prices, was the whole comparator, and every free model matches on all
 * three: `T1`, zero, zero. So the winner among twenty free models was **whichever the
 * catalog happened to list first**, which is a property of a JSON feed rather than a
 * judgement, and *Automatic* — plus the ★ on the models screen, which is defined as what
 * Automatic would pick — inherited it.
 *
 * Found the way these things are found: a personality that reached the model intact and was
 * ignored anyway. The free model at the front of the list could not hold a system prompt,
 * and nothing in this function had an opinion about that.
 *
 * `weekly` is the axis, and it is already fetched. Its own comment is the argument — *a free
 * model nobody sends anything to is a free model with a reason nobody wrote down* — and it
 * is the only quality signal here that comes from outside this machine, so it cannot go
 * stale the way a list of good models written into this file would.
 *
 * **A model whose provider publishes no figure sorts behind one that does**, which is the
 * same way this codebase reads every other silence: `nsfwOk: 'unknown'` does not satisfy an
 * uncensored pin either. Absent is not zero and is not last-because-bad — it is last because
 * unknown, among models that were otherwise going to be ordered by a feed's whim.
 */
const cheapest = (a: Choice, b: Choice): number =>
  rank(a.model.tier) - rank(b.model.tier) ||
  a.model.priceIn - b.model.priceIn ||
  a.model.priceOut - b.model.priceOut ||
  (b.model.weekly ?? -1) - (a.model.weekly ?? -1)

/**
 * Why there is nothing, in words that name the next action. This is the half of the
 * router the user actually meets, so it says what is missing and what to type.
 */
function refusal(
  where: 'local' | 'cloud',
  pins: Pins,
  pool: Choice[],
  needsTools: boolean,
  shape: Shape,
): string {
  if (where === 'local') {
    if (pool.length === 0) return 'no local model is installed — install one, or type /cloud'
    if (pins.uncensored) return 'no local uncensored model is installed — install one, or type /cloud'
    if (needsTools) return 'no local model here can use tools — install one that can, or type /cloud'
    // The one refusal G5 added: the models are here, they can use tools, and they are too
    // small to be trusted with planning. Say which wall it is, because the fix differs.
    if (shape === 'hard') {
      return `this needs planning, and every local model installed is smaller than ${String(PLANNER)}B — install a larger one, or type /cloud`
    }
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
 *
 * **This is also where a payload is read before it goes** (M7-1). Everything bound for
 * anything but `T0` is stripped of credentials and location here, one line above the send,
 * rather than at a call site somebody has to remember — a rule enforced by whoever remembers
 * is not enforced. There is one `chat()` in this repo and it is below.
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
    /**
     * Which run this charge belongs to (M7-2). Absent is a real answer, not a gap: the
     * checker asked outside a task, or a distillation somebody said yes to afterwards, is a
     * charge with no run and the ledger says so rather than guessing one.
     */
    run?: string
  } = {},
): Promise<Answer> {
  let last: unknown
  let blocked: string | undefined
  /**
   * **A plugin working on its own clock spends nothing but free** (G12, D96).
   *
   * A call attributed to a plugin and belonging to no run is one nobody asked for at the
   * keyboard: a poll loop that found a message, a timer that woke up. M15-7's spend preview
   * — the thing that makes an expensive run somebody's decision — has nobody to show itself
   * to on that path, and the monthly cap is a bound on the total rather than on this. So
   * the ceiling here is a **tier** rather than a number: free tiers and this machine.
   *
   * It is derived rather than declared, and that is the point. A flag at each call site is a
   * flag somebody forgets on the one that matters; `run` is already on the row for M7-2, and
   * *this call belongs to no task* is exactly what it says. The checker keeps its paid path
   * because it runs inside a task and carries that task's id.
   *
   * ponytail: no per-plugin allowance. The day somebody wants their phone answered by a
   * frontier model, the upgrade is a monthly figure granted per plugin on the Library screen
   * and read here — not a second cap mechanism.
   */
  const onItsOwn = hooks.plugin !== undefined && hooks.run === undefined
  for (const [at, choice] of choices.entries()) {
    if (paid(choice.model.tier) && (hooks.paidAllowed === false || onItsOwn)) {
      // A cap that is reached does not quietly pick something worse, and it does not
      // quietly spend either. It stops, and the caller says why — and which wall it was,
      // because *raise your cap* is the wrong advice for the other one.
      blocked =
        onItsOwn ?
          `${hooks.plugin ?? 'a plugin'} works on its own and does not spend money — connect a free provider, or install a local model`
        : 'the monthly cap is reached — raise it in settings, or use a free model'
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
    // `T0` means the model is on this machine (only `ollama.ts` ever writes it), so the
    // payload is not going anywhere and stripping it would cost accuracy to protect against
    // nothing. Everything else is a third party, free tiers most of all.
    const outbound = choice.model.tier === 'T0' ? { messages: request.messages, kinds: [] } : redact(request.messages)
    if (outbound.kinds.length > 0) {
      // Enforcement that says so. Silently editing what somebody wrote is the same
      // surprise as a bill nobody announced.
      hooks.onNote?.(`Stripped before sending to ${choice.model.name}: ${summarise(outbound.kinds)}.`)
    }
    sent(store, choice.provider)
    try {
      const { message, usage } = await chat(
        choice.provider,
        { ...request, messages: outbound.messages, model: choice.model.id },
        hooks.onDelta,
        secrets,
      )
      store.recordUsage({
        session: hooks.session,
        plugin: hooks.plugin,
        run: hooks.run,
        model: choice.model.id,
        // Who was asked for, which is the plan's first rung whether or not it answered. The
        // two differ exactly when something fell back, and that is the cost worth explaining.
        asked: choices[0]?.model.id ?? choice.model.id,
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
  if (blocked !== undefined && last === undefined) throw new ProviderError(402, blocked)
  throw last ?? new ProviderError(503, 'nothing was available to ask')
}
