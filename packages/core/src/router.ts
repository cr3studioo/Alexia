// SPDX-License-Identifier: AGPL-3.0-only
import type { Model } from './catalog.js'
import { OLLAMA } from './ollama.js'
import { sent, spent, type Rung } from './pool.js'
import { anonymous, chat, PATIENCE, ProviderError, type ChatRequest, type Provider, type Usage } from './provider.js'
import { redact, summarise } from './redact.js'
import type { SecretStore } from './secrets.js'
import { textOf, type Message, type Store } from './store.js'
import { floor, PER_TOKEN, size, summary } from './trim.js'
import { affordable, costOf, type Today } from './usage.js'

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
 * - **A helper with hands is never swapped for one that only talks, mid-job.** The agentic
 *   sibling of the rule above it. A model on step twelve of twenty that gets tired cannot be
 *   replaced by one that cannot call a tool: the talker cannot pick anything up, and the task
 *   is stranded half-done in a way that reads as the assistant having gone stupid. So running
 *   out of hands is a sentence saying so, never a quieter continuation. The mechanism is the
 *   `needsTools` filter below and nothing else — a request carrying tools never routes to a
 *   model without them — and the loop that meets the refusal stops on it (`agent.ts`).
 */

export type Tier = 'T0' | 'T1' | 'T2' | 'T3'
const TIERS: Tier[] = ['T0', 'T1', 'T2', 'T3']
const rank = (tier: Tier): number => TIERS.indexOf(tier)
/** Which side of the price line a tier sits on. Exported because the caller that has to bound a billed reply needs the same answer this file uses. */
export const paid = (tier: Tier): boolean => rank(tier) >= rank('T2')

/** The privacy axis is not one switch: it is a placement policy per capability class. */
export type CapabilityClass = 'text' | 'image' | 'speech' | 'browsing'
export type Placement = Record<CapabilityClass, 'local' | 'cloud'>

/**
 * The three modes, as placements. Combined is not a compromise between the other two — it
 * is each job going to the side that is better at it: hosted models are strong at planning
 * and often free, while a local GPU makes images and speech free forever after one
 * download.
 *
 * **`cloud` for text means cloud first and then this machine** — local is a rung at the
 * bottom of the cascade rather than a mode you have to be in. It was not one before, and
 * that was the gap: `combined` places `text` here, so a model somebody had already
 * downloaded was not a candidate for a single sentence of the cascade.
 *
 * It reads like a privacy leak and is not one, and the reason is worth writing down because
 * it was got wrong once. **Privacy here is enforced by mode selection, not by cascade
 * order.** Somebody who wants it types `/local`, which places every class local and shuts
 * the cloud cascade off entirely. So the cascade only ever runs for somebody who did not ask
 * for privacy, and the rule below — *a privacy pin that escalates by itself is a betrayal* —
 * is about escalating **past** a local pin. There is no pin here to violate, and nothing
 * escalates: this is the ladder walking downwards.
 *
 * For that person the model on their machine is not *the private one*, it is **a slow helper
 * that lives in their house**. Slow helpers go near the end, which is what {@link cheapest}
 * does with it — behind every keyed free tier, ahead of anything that charges. **Low, not
 * high**: a local 8B loses on latency to every free tier above it, and beats a keyless one
 * throttled to a couple of requests a minute.
 *
 * Text only. Images and speech are already placed local in `combined`, and none of the
 * reasoning above is about them.
 */
export const MODES: Record<'local' | 'combined' | 'cloud', Placement> = {
  local: { text: 'local', image: 'local', speech: 'local', browsing: 'local' },
  combined: { text: 'cloud', image: 'local', speech: 'local', browsing: 'cloud' },
  cloud: { text: 'cloud', image: 'cloud', speech: 'cloud', browsing: 'cloud' },
}

/**
 * Which side of the price line may answer (D112).
 *
 * The fourth axis, and the one that was missing. *Automatic* was a promise about behaviour —
 * the cheapest model that fits — and the word people read it as is **recommended**, which
 * means free to one person, fast to the next, and best to the one paying. Three different
 * expectations of one setting nobody could see or move.
 *
 * `mixed` is what Automatic always did: free first, paid when the free rungs are gone. The
 * two ends are the two things people actually wanted to be able to say, and neither of them
 * was sayable before this.
 */
export type Spend = 'free' | 'mixed' | 'paid'

/** Whether the slider lets this model's side of the price line answer. */
export const allowed = (model: Model, spend: Spend): boolean =>
  spend === 'mixed' || paid(model.tier) === (spend === 'paid')

/**
 * **A model somebody could send a request to right now** (D154): its provider is connected,
 * and the slider lets its side of the price line answer.
 *
 * One function because two readers need the same answer. The Models tab filtered on the
 * provider alone and the router on the provider *and* the slider, so under *free only* the tab
 * listed 348 paid Kilo rows the router would never ask — a list of models that was, row for
 * row, a list of things that would not happen.
 *
 * A price nobody published is already gone by the time a row gets here: `parse()` does not
 * carry it. What is not here yet is *can this account pay* — that needs each provider's balance.
 */
export const available = (model: Model, connected: ReadonlySet<string>, spend: Spend): boolean =>
  connected.has(model.provider) && allowed(model, spend)

export interface Pins {
  placement: Placement
  /** `/best` walks the list from the top instead of the bottom. */
  prefer?: 'cheap' | 'best'
  /** `/nsfw`. A model whose content policy is merely *unknown* does not satisfy it. */
  uncensored?: boolean
  /** The user named one. It wins outright, and is the only way past an unknown flag. */
  model?: string
  /** Free only, free then paid, or paid only. Absent is `mixed`, which is what it always did. */
  spend?: Spend
  /**
   * The user's own running order, by model id, **across both groups** — and when it has
   * anything in it, **the only models that answer** (D155).
   *
   * A short list rather than a full ordering: a catalog with four hundred rows in it is not a
   * thing anybody drags into order, and being made to is how a preference screen turns into a
   * chore nobody finishes. D112 let everything left off it answer behind it, which was
   * backwards: somebody who chose three models did not choose the other four hundred. So a
   * failure falls through this list and stops at its end, and Automatic is the empty list.
   *
   * **The group is a property of the model, not of the list.** A paid model ranked first is
   * still paid, so it sorts behind every free one unless the spend axis says otherwise —
   * which is what stops one drag quietly turning the free tier off.
   */
  order?: string[]
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
  /**
   * **What this request carries besides words** — `image`, `audio` — matched against the
   * `modality` the catalog already collects for every model.
   *
   * That field has existed since the catalog did. It is read off OpenRouter's
   * `input_modalities`, guessed from the `VL` in an OVHcloud id, and taken from Ollama's own
   * capability list — and until this line it was **displayed and never filtered on**. The
   * models screen printed *takes text, image* under a row and nothing else ever asked.
   *
   * **It has no caller yet, and that is the point of adding it now.** Nothing can put a
   * picture in a `Message` — `content` is a `string`, at the store, through `trim.ts` and at
   * the provider boundary — so today there is nothing to route wrong. The day either half of
   * document reading lands, sending a picture to a model that cannot see one is a 400 from
   * somebody else's server arriving at step nine with no explanation attached. This is the
   * same argument, and the same shape, as the spend pin the slider added to this function:
   * *a rule nobody can see is a rule nobody can disagree with.*
   */
  modality?: readonly string[]
}

export interface Choice {
  model: Model
  provider: Provider
}

/**
 * **Three modes, three promises** (D155), and which one a plan was made in.
 *
 * - `automatic` — nobody chose. Falls through the whole ranked list.
 * - `sequence` — somebody listed models in an order. Falls through that list and stops at its end.
 * - `pinned` — somebody chose one model. It answers or it stops; nothing stands in for it.
 *
 * On the verdict rather than inside {@link send}, which walks whatever it is handed: the plan
 * is where the promise is kept, and the mode travels with it so a stop can say whose choice
 * stopped — the person's two, which offer *Use Automatic for this answer*, or Automatic's own.
 */
export type Mode = 'automatic' | 'sequence' | 'pinned'

export type Verdict = { ok: true; mode: Mode; choices: Choice[] } | { ok: false; mode: Mode; why: string }

/** Everything the router needs to know about the world, gathered by the caller. */
export interface World {
  /** Hosted models, from the catalog. */
  models: readonly Model[]
  /** What is installed locally and reachable. Empty when Ollama is not running. */
  local: readonly Model[]
  /** Hosted providers with a key and requests left, in the pool's order. */
  rungs: readonly Rung[]
  /**
   * Today's spending and today's allowance, gathered the same way the rungs are.
   *
   * Absent means nobody gathered it, which is read as *no allowance* rather than as *no
   * limit*. That direction is deliberate: every other rung failure in this router is free,
   * so forgetting one costs a slower answer — forgetting this one would cost money.
   */
  today?: Today
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

/**
 * Will this model's window hold the part of the trace that can never be collapsed away?
 *
 * The floor, not the whole trace: everything above it {@link trim} can summarise, and the
 * ordering that makes this work is route first, then trim to whatever window won. What the
 * floor cannot do is get smaller, so a model that cannot hold it is not a model that gives a
 * shorter answer — it is one that refuses the request outright.
 *
 * **Planning is measured against more than that** (§11.6). A step that turns the crank —
 * read this file, run this command — needs the step it is on and almost nothing else, which
 * is what the floor is. A step that *plans* needs the history as well: what has been tried,
 * what worked, what is left. So the bar for planning is the floor plus the running summary,
 * which is what a trace bottoms out at once {@link trim} has done everything it can.
 *
 * This is the same split §10.6 wanted for money, arriving again for a completely different
 * reason, and it is why a small free model does not become useless as a task grows — **it
 * becomes the cranker**, while planning goes to something with a real window.
 *
 * A model that does not say how big its window is, is not judged here. Silence is not
 * smallness, which is the same reading `params` gets two filters down.
 */
const fits = (model: Model, messages: Message[], planning = false): boolean =>
  model.context <= 0 ||
  (size(floor(messages)) + (planning ? summary(messages).length : 0)) / PER_TOKEN <= model.context

/**
 * Is `a` genuinely above `b` — better at something that matters, worse at nothing?
 *
 * Two axes, and they are the two this whole ladder is built on: how much it can read, and
 * whether it has hands. A model that is merely *different* is above nothing.
 *
 * **Frontier is above free by definition**, which is what the tier ladder is for. The band
 * this question actually exists for is the one under it — a *small paid* model that costs
 * money and is no better than a good free one.
 */
const beats = (a: Model, b: Model): boolean =>
  rank(a.tier) >= rank('T3') ||
  ((a.context > b.context || (a.supportsTools && !b.supportsTools)) &&
    !(a.context < b.context || (b.supportsTools && !a.supportsTools)))

/**
 * **Never pay for a sidegrade.**
 *
 * Cheapest-first will happily buy a paid model no better than the free one that just ran
 * out, and paying for equal quality is the worst outcome on offer here: money spent and
 * nothing bought with it. So on the automatic path a paid model enters only when it is above
 * every free model it would be standing in for — above the best of them, which is what
 * replacing a rung means.
 *
 * Nothing to replace is not a sidegrade: somebody with no free provider connected is not
 * being sold the same thing twice.
 */
const stepUp = (model: Model, replacing: readonly Model[]): boolean =>
  replacing.every((free) => beats(model, free))

/** Words that mean the work is not a quick answer. Boring, and edited when it is wrong. */
const HARD =
  /\b(refactor|debug|architect|design|prove|derive|optimi[sz]e|why does|step by step|plan (?:out|the))\b/i

export function shapeOf(ask: Ask): Shape {
  const found = [...ask.messages].reverse().find((m) => m.role === 'user')
  const last = found === undefined ? '' : textOf(found)
  if (HARD.test(last) || last.includes('```') || last.length > 400) return 'hard'
  if (ask.tools && ask.tools.length > 0) return 'tools'
  return 'simple'
}

/**
 * The models that satisfy every pin, cheapest first — a plan rather than a pick, because
 * the rung below might be rate-limited in the half-second between choosing and sending.
 */
export function route(ask: Ask, pins: Pins, world: World): Verdict {
  const kind = ask.class ?? 'text'
  const where = pins.placement[kind]
  const connected = new Map(world.rungs.map((rung) => [rung.provider.id, rung]))

  // Local placement means local: a model on this machine, and nothing else — the hosted
  // models are not a fallback, they are out. Cloud placement means the APIs **and then this
  // machine**, in that order, for text: the model somebody already downloaded is the last
  // rung of the cascade rather than a mode they have to remember to switch into. See
  // {@link MODES} for why that is not the privacy pin being escalated past — and for why it
  // is text alone, images and speech being placed local by `combined` already.
  const here = world.local.map((model) => ({ model, provider: OLLAMA }))
  const hosted = where === 'local' ? [] : reachable(world, connected)
  const everything: Choice[] = [...hosted.map((row) => row.choice), ...(where === 'local' || kind === 'text' ? here : [])]
  /** What the free-tier ledger believes is spent. A pre-check for Automatic, never a refusal of somebody's own choice. */
  const tired = new Set(hosted.filter((row) => row.out).map((row) => row.choice))

  if (pins.model) {
    // The user named one. Their choice, including past a flag nobody has verified — and past
    // the ledger, which is this machine's low copy of somebody else's number (D107). Refusing a
    // pin *before trying it* because the count says spent was the pin failing on a guess.
    const named = everything.find((c) => c.model.id === pins.model)
    return named ?
        { ok: true, mode: 'pinned', choices: [named] }
      : { ok: false, mode: 'pinned', why: `${pins.model} is not available right now.` }
  }

  /**
   * **A list somebody made is the whole plan** (D155). Automatic gets every model the ledger
   * has not written off; a sequence gets exactly its own entries, the ones the ledger calls
   * spent moved to the end rather than dropped — when it is the only list somebody wanted,
   * asking and collecting a 429 beats skipping a model on a count.
   */
  const order = pins.order ?? []
  const mode: Mode = order.length > 0 ? 'sequence' : 'automatic'
  const withHeadroom = everything.filter((c) => !tired.has(c))
  const pool: Choice[] =
    mode === 'sequence' ? everything.filter((c) => order.includes(c.model.id))
    : withHeadroom.length > 0 ? withHeadroom
    : everything

  const shape = ask.shape ?? shapeOf(ask)
  const floor = ask.minTier ?? 'T0'
  const needsTools = shape === 'tools' || (ask.tools?.length ?? 0) > 0
  /** Anything beyond words. `text` is every model's answer, so asking about it says nothing. */
  const carried = (ask.modality ?? []).filter((kind) => kind !== 'text')
  /**
   * The spend axis is about the price line, and **only the cloud pool has one**.
   *
   * A model on this machine is free in a different sense: nothing is billed and nothing is
   * rate-limited, so there is no paid side of it to prefer and no free tier of it to protect.
   * Applying *paid only* to a local pool would empty it and produce a refusal that reads as a
   * bug — you asked for local, and it told you nothing local costs enough.
   */
  const asked = where === 'cloud' ? (pins.spend ?? 'mixed') : 'mixed'
  /**
   * **Money is a permission, not a rung.** It is not a tier, it does not sit at a fixed place
   * in the cascade, and nothing here reorders anything: `spend` was already a filter and it
   * stays one. What the allowance decides is only whether the *automatic* setting is allowed
   * to cross the price line at all.
   *
   * So `mixed` with nothing allowed for today is `free` — the same pool, the same order, the
   * same refusals — and the day somebody sets an allowance it is `mixed` again. The slider
   * pushed all the way to *paid only* is untouched by this on purpose: that is somebody
   * saying the words, and this exists to stop a router spending on its own, not to argue
   * with a person who typed it.
   */
  const capped = asked === 'mixed' && where === 'cloud' && !affordable(world.today)
  const spend: Spend = capped ? 'free' : asked
  /**
   * The slider's middle, as opposed to somebody having said the words. Both extra rules below
   * are scoped to it — in a list somebody made as much as in Automatic, because they are rules
   * about money rather than about which model (D155 changed the second, not the first).
   */
  const middle = asked === 'mixed'

  /**
   * **Why free failed**, which is the question that decides where money comes in the order —
   * and it is answered rather than positioned, so paid never gets a fixed rung of its own.
   *
   * > *Tired* (429, quota spent) — try **local first**, then pay.
   * > *Incapable* (nothing free has the tools / the context / vision) — **pay now**, because
   * > local is weaker than free and will not do it either.
   *
   * Both fall out of what is already here, which is why neither is a branch. A free tier
   * that is spent is removed from the pool by the ledger, and everything left — a model on
   * this machine included — sorts free-before-paid, so local is simply next. A free tier that
   * is *present and cannot do the job* fails one of the capability filters below; a local
   * model weaker than it fails the same filter for the same reason and is not a candidate,
   * so paid is next. One list plus filters, not a table of cases.
   *
   * (Local **is** in the cloud pool now, at the bottom of the free half — see {@link MODES}.
   * That paragraph was written before it was, claiming it would need nothing here to change,
   * and it did not: the two rules above are the same two rules, and neither is a branch.)
   */

  /**
   * The free models this person actually has, whether or not today's allowance of them is
   * spent — the rung a paid model would be standing in for.
   *
   * Read from the catalog rather than from the pool, because the case this exists for is
   * exactly the one where the ledger has already taken them out of the pool.
   */
  const replacing = world.models.filter((m) => !paid(m.tier) && connected.has(m.provider))

  /**
   * The candidates a given price line leaves. A function rather than a chain, because the
   * question *would money have answered this?* has exactly one honest way to be asked: run
   * the same filters with the line open and see. Inferring it from which filter emptied the
   * list gets the sentence wrong, and the sentence is the half the user meets.
   */
  const fitting = (spend: Spend, sidegrades = false): Choice[] =>
    pool
      .filter((c) => rank(c.model.tier) >= rank(floor))
      .filter((c) => ask.above === undefined || rank(c.model.tier) > rank(ask.above))
      .filter((c) => !needsTools || c.model.supportsTools)
      // What the request carries, against what the model can be given. A model that says
      // nothing about a modality is not offering it — the same way `nsfwOk: 'unknown'` does
      // not satisfy an uncensored pin.
      .filter((c) => carried.every((kind) => c.model.modality.includes(kind)))
      // A window too small for the trace drops out of the pool exactly the way a spent free
      // tier does. `Model.context` has existed since the catalog did and was never once read,
      // and this is the filter whose absence would break the keyless floor first: the models
      // down there are 32k, and a 40k conversation reaching one is a hard failure, not a
      // degraded answer. Filtered out means filtered out — nothing here truncates to fit.
      .filter((c) => fits(c.model, ask.messages, shape === 'hard'))
      // A model that reports its size and is too small to plan does not get planning work.
      // Silence about size is not smallness: a hosted model never says, and is not judged here.
      .filter((c) => shape !== 'hard' || c.model.params === undefined || c.model.params >= PLANNER)
      // `unknown` is not a yes. Nothing is routed to an uncensored request on a hunch.
      .filter((c) => !pins.uncensored || c.model.nsfwOk === 'yes')
      // The slider, and it is a filter rather than a preference: *free only* that reaches for a
      // paid model when the free ones are busy is the setting not existing.
      .filter((c) => allowed(c.model, spend))
      // And a paid model that is no better than the free rung it stands in for is not a
      // rung, it is the same answer for money.
      .filter((c) => sidegrades || !middle || !paid(c.model.tier) || stepUp(c.model, replacing))
      .sort(mode === 'sequence' ? listed(order, tired) : cheapest)

  const choices = fitting(spend)
  if (choices.length > 0) {
    // `/best` walks Automatic's ranking from the other end. A list somebody put in order is
    // not a ranking to walk backwards.
    return { ok: true, mode, choices: pins.prefer === 'best' && mode === 'automatic' ? [...choices].reverse() : choices }
  }
  // Was the allowance the wall? Only if opening the price line would actually have produced
  // something — otherwise the real wall is one of the others and saying *set an allowance*
  // sends somebody to spend money on a problem money does not fix.
  const priced = capped && fitting('mixed').length > 0
  // And the other new wall, asked the same way: was everything paid here merely equal to
  // what ran out? Relax the one rule and see whether anything appears.
  const sidegrade = !capped && middle && fitting(spend, true).length > 0
  return {
    ok: false,
    mode,
    why:
      mode === 'sequence' ?
        outOfOrder(pool, pins, needsTools, spend, ask.messages, priced, sidegrade, carried)
      : refusal(where, pins, pool, needsTools, shape, world, spend, ask.messages, priced, sidegrade, carried),
  }
}

/**
 * The hosted models that can actually be asked, and the two ways the free-tier ledger is
 * allowed to narrow that — neither of which is *all of them*.
 *
 * **A spent tier is spent for free models.** The daily fifty is a limit on what a provider
 * gives away, not on the key: the paid models on the same key are billed against credit and
 * go on working. Dropping the provider whole is what produced the sentence this function
 * exists to stop — *no provider is connected* said to somebody who had connected one.
 *
 * **And the ledger is a pre-check, not an authority.** It is this machine's copy of a number
 * somebody else publishes, and it is deliberately the low one: OpenRouter's fifty a day
 * becomes a thousand the moment you buy credit, and nothing here is told. So when honouring
 * it would leave *nothing at all*, it is not honoured — asking and possibly collecting a 429
 * beats refusing on a guess while a working key sits in the keychain, and the 429 already
 * has somewhere to go ({@link send} walks to the next rung).
 *
 * So this marks rather than filters, and {@link route} decides: Automatic leaves the spent rows
 * out while anything else is left, a sequence tries them last, and a pin ignores the mark.
 */
function reachable(world: World, connected: ReadonlyMap<string, Rung>): { choice: Choice; out: boolean }[] {
  return world.models.flatMap((model) => {
    const rung = connected.get(model.provider)
    if (!rung) return []
    return [{ choice: { model, provider: rung.provider }, out: spent(rung) && !paid(model.tier) }]
  })
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
/**
 * **Which rung of §8.2's ladder a choice stands on**, within its half of it.
 *
 * The ladder is nine rungs and this is the axis that separates them once the hands/mouths
 * split above has cut it in two: *your own keyed free tiers* first, then *the machine in the
 * house*, then *the floor that answers a stranger*. Read straight off two things that are
 * already on the row — `T0` is only ever written by `ollama.ts`, and `auth` already says
 * whether a provider will answer with no key — so no provider is named here and no field
 * exists for the ladder's sake. That is the same rule the table itself is built on.
 *
 * **The order of the two questions matters**: Ollama's row is `auth: 'none'` like the floor's
 * are, so *is it on this machine* has to be asked first or every local model would sort as
 * the floor.
 *
 * **Rungs 1 and 3 are one rung here**, and that is the ladder's own shape rather than a
 * shortcut. §8.2 separates *your own direct free-tier keys* from *OpenRouter free* on the
 * grounds that the aggregator is "a bit worse", and nothing on a provider row says which of
 * the two a row is: the difference is not keyed-versus-keyless, not free-versus-paid, and not
 * a limit. Writing `openrouter` into this file to get it would be the one thing this table
 * exists to prevent, and a field invented for it is a schema decision this file cannot take
 * on its own. So keyed free tiers sort among themselves on the rules underneath — price, then
 * what the world actually uses — and the two rungs are one until somebody says otherwise.
 *
 * **A keyless row somebody has pasted a key into still sorts as the floor**, and that is the
 * other place this is an approximation rather than a reading. OVHcloud answers anonymously at
 * two requests a minute and at four hundred with a key; the pool knows which of those is
 * true and a `Rung` does not carry it, so this cannot. It costs a keyed OVHcloud its place
 * among the keyed tiers and nothing else — it is still above the models that only talk, and
 * still ahead of nothing that charges.
 */
const RUNGS = { keyed: 0, machine: 1, floor: 2 } as const
const standing = (choice: Choice): number =>
  choice.model.tier === 'T0' ? RUNGS.machine
  : anonymous(choice.provider) ? RUNGS.floor
  : RUNGS.keyed

/**
 * **What state this answer leaves the user in** (§8.4), for the one badge on the chat screen.
 *
 * §8.2 gives every rung a sentence and a colour, and §8.4 gives the rule that decides what
 * those sentences may say: **the bubble says what the assistant can *do*, not what it costs.**
 * *Not available for agentic work, just chat* is worth reading; *currently paid* is not —
 * nobody cares that an answer was paid for, they care whether the thing can still pick a file
 * up. So there is no price here and no provider plumbing, and there is not meant to be.
 *
 * Read off {@link standing} and `supportsTools`, which is to say off the two keys the ladder
 * is sorted by. That is the point: a bubble computed from anything else would drift from the
 * order it is describing, and then the screen would be explaining a cascade the router is not
 * walking.
 *
 * **Local says what it is good for rather than where it is** (§8.4): *good for agentic, slow*
 * is one of the three strings that section offers, and all three of them describe capability.
 * The chat-only machine keeps §8.2's own *just chat*, because none of §8.4's three is true of
 * a local model that cannot call a tool — and *just chat* is already a capability tag.
 *
 * **Rungs 2, 3 and 7 are not here.** Rung 2 is the Claude subscription, which ships off and
 * cannot be in a shipped cascade (§14.1). Rungs 3 and 7 are OpenRouter's half of the keyed
 * tiers, which nothing on a provider row distinguishes from any other keyed tier — the same
 * reason {@link standing} does not separate them.
 */
export interface Bubble {
  /** Which rung of §8.2's ladder, for anybody who wants to compare this against the document. */
  rung: number
  /** §8.2's own sentence, or §8.4's where it gives local a better one. */
  says: string
  /**
   * §8.2's colour. `green` is the ordinary state and the shell paints it in no colour at all:
   * this palette has caution and danger and deliberately no green, because a colour on that
   * screen always means something happened. Fine is the absence of one.
   */
  state: 'green' | 'amber' | 'red'
}

export function bubble(choice: Choice): Bubble {
  const where = standing(choice)
  if (choice.model.supportsTools) {
    if (where === RUNGS.machine) return { rung: 4, says: 'good for agentic, slow', state: 'amber' }
    if (where === RUNGS.floor) return { rung: 5, says: 'free floor, still capable', state: 'amber' }
    return { rung: 1, says: 'ready for anything', state: 'green' }
  }
  if (where === RUNGS.machine) return { rung: 8, says: 'just chat', state: 'red' }
  if (where === RUNGS.floor) return { rung: 9, says: 'barely alive, but alive', state: 'red' }
  return { rung: 6, says: 'just chat now', state: 'red' }
}

const cheapest = (a: Choice, b: Choice): number =>
  // The group comes first (D112). Free before paid, whatever else is true of either.
  Number(paid(a.model.tier)) - Number(paid(b.model.tier)) ||
  /*
   * **Then hands before mouths, and then the ladder** (§8.2).
   *
   * Two keys, and between them they are the nine rungs. The first is §8.1's organising
   * idea: some helpers can call tools and therefore do work, some can only talk, and you
   * ask a helper with hands first — so a model on this machine that can use tools (rung 4)
   * is above a hosted free one that cannot (rung 6), which is what the ladder prints. It
   * does not overrule the filter above it; that one *removes* the talkers when the work
   * needs hands, and this one *orders* them when it does not.
   *
   * The second is {@link standing}: keyed, then this machine, then the keyless floor. None
   * of it applies to a list somebody put in order ({@link listed}): somebody who dragged a
   * row to the top typed that, and none of this exists to argue with them.
   *
   * **`rank` cannot do either job**, which is why they are keys of their own rather than a
   * fall-through: it reads `T0` as the *cheapest* tier, so left to it a local model sorts in
   * front of every keyed free tier — the exact opposite of the rung §8.3 put it on.
   *
   * Rung 2, the Claude subscription, is not here and cannot be: it is a plugin offering a
   * tool, never a row in `PROVIDERS`, and it ships off (§14.1). A rung the user unlocks by
   * hand is not a rung a shipped cascade can walk onto by itself.
   */
  Number(!a.model.supportsTools) - Number(!b.model.supportsTools) ||
  standing(a) - standing(b) ||
  rank(a.model.tier) - rank(b.model.tier) ||
  a.model.priceIn - b.model.priceIn ||
  a.model.priceOut - b.model.priceOut ||
  (b.model.weekly ?? -1) - (a.model.weekly ?? -1)

/**
 * **A sequence, in the order somebody wrote it** (D155) — within its group, because the group
 * is a property of the model and not of the list (D112): a shortlist is a running order
 * *within* what the slider allowed, never a second, quieter way to start spending money.
 *
 * One exception to the written order, and it moves nothing out: an entry whose free tier the
 * ledger calls spent is tried after the ones that still have headroom.
 */
const listed =
  (order: readonly string[], tired: ReadonlySet<Choice>) =>
  (a: Choice, b: Choice): number =>
    Number(paid(a.model.tier)) - Number(paid(b.model.tier)) ||
    Number(tired.has(a)) - Number(tired.has(b)) ||
    order.indexOf(a.model.id) - order.indexOf(b.model.id)

/**
 * Why a sequence has nothing to ask, said about **the list** rather than about every model
 * there is. The general refusal's sentences — *connect a provider*, *move the slider* — send
 * somebody to fix the world, when what stopped is a list they wrote; and whatever it says,
 * the stop beside it offers *Use Automatic for this answer*.
 */
function outOfOrder(
  pool: Choice[],
  pins: Pins,
  needsTools: boolean,
  spend: Spend,
  messages: Message[],
  capped: boolean,
  sidegrade: boolean,
  carried: string[],
): string {
  if (pool.length === 0) {
    return 'none of the models in your order can be reached right now — their provider is not connected, or they have left the catalog'
  }
  const unseen = carried.filter((kind) => !pool.some((c) => c.model.modality.includes(kind)))
  if (unseen.length > 0) {
    return `none of the models in your order can be given ${unseen.map((kind) => (kind === 'image' ? 'a picture' : kind === 'audio' ? 'sound' : kind)).join(' or ')}`
  }
  if (!pool.some((c) => fits(c.model, messages))) return 'this conversation is longer than any model in your order can read'
  if (capped) return 'the models in your order that fit this cost money, and Alexia does not spend money on its own until you give it a daily allowance — set one in settings'
  if (sidegrade) return 'the paid models in your order are no better than a free model you already have, so none of them is bought'
  if (pins.uncensored) return 'none of the models in your order is known to be uncensored'
  if (spend !== 'mixed' && !pool.some((c) => paid(c.model.tier) === (spend === 'paid'))) {
    return spend === 'free' ?
        'the models screen is set to free only, and every model in your order costs money'
      : 'the models screen is set to paid only, and every model in your order is free'
  }
  if (needsTools && !pool.some((c) => c.model.supportsTools)) return 'none of the models in your order can use tools, and this needs them'
  return 'none of the models in your order fits this request'
}

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
  world: World,
  spend: Spend,
  messages: Message[],
  capped: boolean,
  sidegrade: boolean,
  carried: string[],
): string {
  /**
   * The wall a picture hits, named before every other one.
   *
   * It is asked first for the same reason the context wall is: every sentence below would
   * send somebody to fix a different thing — add a key, move the slider, install a model —
   * and none of those makes a model that cannot see able to see. `image` and `audio` are
   * spelled as the nouns a person uses rather than as the catalog's field names.
   */
  const unseen = carried.filter((kind) => !pool.some((c) => c.model.modality.includes(kind)))
  if (unseen.length > 0 && pool.length > 0) {
    const said = unseen.map((kind) => (kind === 'image' ? 'a picture' : kind === 'audio' ? 'sound' : kind)).join(' or ')
    return where === 'local' ?
        `no model installed on this machine can be given ${said} — install one that can, or type /cloud`
      : `none of the models available to you can be given ${said} — connect a provider that offers one, or install a local model that can`
  }
  /**
   * The wall whose fix is neither a key nor a slider nor an install of the usual kind: the
   * conversation is simply longer than anything reachable can read. Asked early, because
   * every other sentence below would send somebody looking for the wrong thing — and because
   * the alternative to saying it is a 400 from somebody else's server, arriving at step nine
   * with no explanation attached.
   */
  const tooLong = pool.length > 0 && !pool.some((c) => fits(c.model, messages))
  if (where === 'local') {
    if (pool.length === 0) return 'no local model is installed — install one, or type /cloud'
    if (tooLong) {
      return 'this conversation is longer than any model installed here can read — install one with a bigger context window, or type /cloud'
    }
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
    // Two different walls, and they used to share one sentence — which meant the one thing
    // it told you to do was the one thing you had already done. A key that is in the
    // keychain is never the missing piece, so it is never what this offers.
    if (world.rungs.length === 0) {
      // No *and type /local* on the end of it any more: a model on this machine is a rung of
      // this cascade now, so installing one is the whole of that fix ({@link MODES}).
      return 'no provider is connected — add a key in settings, or install a local model'
    }
    return 'no model list has arrived yet for the provider you connected — open the Models tab to fetch one, or check your connection'
  }
  if (tooLong) {
    return 'this conversation is longer than any model available to you can read — start a new chat, or connect a provider with a bigger context window'
  }
  // The allowance's own wall, said before every wall below it because it is the one that was
  // proved rather than guessed: something paid *would* have answered. *The models screen is
  // set to free only* would be a lie here — nobody set it, the allowance did, and the fix
  // lives on a different screen. Silence about that is the degradation this axis exists to
  // prevent.
  if (capped) {
    return 'the free models are used up, and Alexia does not spend money on its own until you give it a daily allowance — set one in settings, or wait for the free tiers to reset'
  }
  // The sidegrade wall, and it is a refusal on purpose. Waiting for a free tier to reset
  // costs nothing; buying the same thing again costs money and buys nothing.
  if (sidegrade) {
    return 'the free models are used up, and every paid model here is no better than the one that ran out — wait for the free tiers to reset, or connect a provider with something stronger'
  }
  if (pins.uncensored) return 'no uncensored model is available from the providers you have connected'
  /**
   * The slider's own wall, and it names the slider — asked before the tool wall because it is
   * the one that can empty the pool outright, and *none of them can use tools* said about a
   * side of the line the user closed sends somebody looking for the wrong fix.
   */
  const side = pool.filter((c) => paid(c.model.tier) === (spend === 'paid'))
  if (spend !== 'mixed' && side.length === 0) {
    return spend === 'free' ?
        'the models screen is set to free only, and none of the providers you have connected offers a free model — move the slider, or connect one that does'
      : 'the models screen is set to paid only, and nothing you have connected charges for a model — move the slider back'
  }
  if (needsTools) return 'none of the models available to you can use tools'
  if (spend !== 'mixed') {
    return `the models screen is set to ${spend === 'free' ? 'free' : 'paid'} only, and none of those fits this request — move the slider to let the other side answer`
  }
  return 'no model fits this request right now — try again shortly'
}

export interface Answer {
  message: Message
  usage: Usage
  model: Model
  provider: Provider
  /** The reply stopped at `maxTokens` rather than finishing — see `chat()`. */
  cut: boolean
}

/**
 * **How far one failure moves the walk** (D155) — decided once, here, from what came back.
 *
 * - `model` — *this model, right now*: rate-limited, no credit, retired, gated, nobody serving
 *   it, too slow, a connection that failed or dropped, an answer that was empty or cut off.
 *   The next rung may well work.
 * - `provider` — *this provider*: the key was refused. Every rung on it would say the same, so
 *   they are skipped for the rest of the answer, and every other provider can still answer.
 * - `request` — *this request*: the conversation is longer than the model can read. Only a
 *   model with a bigger window is worth asking; a smaller one would refuse it the same way.
 *
 * `send()` used to move on for five statuses and throw on everything else, so no credit, a
 * retired model, a dropped connection or a stream that died halfway all ended the answer with
 * four hundred models still untried.
 */
export type Reach = 'model' | 'provider' | 'request'

export interface Failure {
  choice: Choice
  reach: Reach
  status: number
  /** The reason in plain words, naming the model or its provider. Never a status code. */
  says: string
}

/** How providers say *this conversation is longer than this model reads*. A 400 that says anything else is about the model. */
const TOO_LONG = /context|too long|too large|too many tokens|maximum.{0,40}tokens|token limit|reduce the length/i

/**
 * What a thrown error means for the walk, or `undefined` when it is not a provider failing at
 * all — a bug in core, or the stop button — which is thrown on rather than walked past.
 */
export function failed(error: unknown, choice: Choice): Failure | undefined {
  if (!(error instanceof ProviderError)) return undefined
  const { model, provider } = choice
  const { status, trouble } = error
  const of = (reach: Reach, says: string): Failure => ({ choice, reach, status, says })
  if (status === 401) {
    // With no key of the person's on the request, a provider that answers anonymously is
    // saying that *this model* wants one — the rest of its list still answers.
    if (trouble === 'keyless' && anonymous(provider)) return of('model', `${model.name} needs a ${provider.name} key`)
    return of('provider', trouble === 'keyless' ? `${provider.name} has no key yet` : `your ${provider.name} key was refused`)
  }
  if (status === 413 || (status === 400 && TOO_LONG.test(error.message))) {
    return of('request', `this conversation is too long for ${model.name}`)
  }
  return of(
    'model',
    trouble === 'slow' ? `${model.name} did not answer within ${String(Math.round((provider.timeoutMs ?? PATIENCE.first) / 1000))} seconds`
    : trouble === 'stalled' || trouble === 'dropped' ? `${model.name} stopped answering partway through`
    : trouble === 'unreachable' ? `${provider.name} could not be reached`
    : status === 402 ? `there is no ${provider.name} credit to pay for ${model.name}`
    : status === 403 ? `${provider.name} would not let ${model.name} take this request`
    : status === 404 ? `${model.name} is no longer offered by ${provider.name}`
    : status === 406 ? `nobody is serving ${model.name} right now`
    : status === 408 ? `${model.name} did not answer in time`
    : status === 429 ? `${model.name} is rate-limited right now`
    : status >= 500 ? `${provider.name} could not serve ${model.name} just now`
    : `${provider.name} turned down the request to ${model.name}`,
  )
}

/**
 * A sentence's first letter, when the sentence starts with a word of Alexia's. A model's own
 * name is left as its provider spells it — `gpt-oss-120b` is not `Gpt-oss-120b`.
 */
const capital = (line: string): string =>
  /^(your|there|nobody|this|the)\b/.test(line) ? line.charAt(0).toUpperCase() + line.slice(1) : line

/** Three reasons and a count, joined the way a sentence joins them. */
const reasons = (failures: readonly Failure[], rest: string): string => {
  const told = failures.slice(0, 3).map((one) => one.says)
  const more = failures.length - told.length
  const parts = more > 0 ? [...told, `${String(more)} more ${rest}`] : told
  return capital(parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1) ?? ''}`)
}

/**
 * **The stop, as a sentence** (D155): which models were asked, and why none of them answered.
 * It is the whole of what the person is told, so it names models and reasons and never a status.
 */
export function stopped(failures: readonly Failure[], blocked?: string): string {
  const last = failures.at(-1)
  const lines = [`${reasons(failures, 'could not answer either')}.`]
  if (last?.reach === 'request') lines.push('Nothing left to try reads more than that — start a new chat.')
  if (blocked !== undefined) lines.push(`${capital(blocked)}.`)
  return lines.join(' ')
}

/**
 * Walk the plan until one of them answers.
 *
 * A rung that fails is not an error, it is the next rung's turn — how far the turn moves is
 * {@link failed}'s to say — and every request is counted against its provider whether or not
 * it worked, because a refused request still counted against the tier that refused it.
 *
 * **The plan is the promise.** This walks exactly what it was handed and nothing else: a
 * sequence's plan is its own entries and a pin's is one model, so a failure there stops, with
 * {@link stopped}'s sentence, and never quietly reaches for a model nobody chose (D155).
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
    /**
     * **Throw away what was streamed** (D155). A rung that had already sent words failed, and
     * the answer starts again on the next one — a half-written bubble left on screen would be
     * two models' sentences run together.
     */
    onRestart?: () => void
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
  const failures: Failure[] = []
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
  const unpaid = (choice: Choice): boolean => paid(choice.model.tier) && (hooks.paidAllowed === false || onItsOwn)
  /** Providers whose key was refused during this answer. */
  const refused = new Set<string>()
  /** The biggest window that has already proved too small for this conversation. */
  let outgrown: number | undefined
  /** Whether a rung is still worth asking, given what this answer has already ruled out. */
  const open = (choice: Choice): boolean =>
    !unpaid(choice) && !refused.has(choice.provider.id) && (outgrown === undefined || choice.model.context > outgrown)
  /** How many failures a note has already told the person about. */
  let told = 0

  for (const [at, choice] of choices.entries()) {
    if (unpaid(choice)) {
      // A cap that is reached does not quietly pick something worse, and it does not
      // quietly spend either. It stops, and the caller says why — and which wall it was,
      // because *raise your cap* is the wrong advice for the other one.
      blocked =
        onItsOwn ?
          `${hooks.plugin ?? 'a plugin'} works on its own and does not spend money — connect a free provider, or install a local model`
        : 'the monthly cap is reached — raise it in settings, or use a free model'
      continue
    }
    if (!open(choice)) continue
    /**
     * **Nothing is billed without a ceiling on the reply.** Input tokens can be counted
     * before sending and output tokens cannot, so this is the only thing standing between a
     * paid model and a cost nobody bounded.
     *
     * Loudly, and not as a rung failure. A caller that can reach a paid model and did not
     * say how much reply it is willing to pay for is a bug in that caller, and quietly
     * falling to the next rung would hide it until the bill arrived. Free calls are
     * untouched: there is nothing there to bound.
     */
    if (paid(choice.model.tier) && request.maxTokens === undefined) {
      throw new Error(
        `${choice.model.name} costs money and no maxTokens was set — a billed call must bound its reply.`,
      )
    }
    // One plain line before the charge, not after it. Nobody is surprised by a bill from
    // something that did not say anything. It is also this rung's switch line, so the one
    // below stays quiet for it.
    if (paid(choice.model.tier)) {
      hooks.onNote?.(
        at === 0 ?
          `Using ${choice.model.name}, which costs money — about $${choice.model.priceIn.toFixed(2)} per million words in.`
        : `The free models are used up, so this one goes to ${choice.model.name}, which costs money.`,
      )
      told = failures.length
    }
    /**
     * **One line when the answer comes from somewhere else** (D155), said as this rung starts
     * answering rather than as it is asked: a switch announced before it has worked is a
     * promise, and on a rate-limited evening the next three might not keep it.
     */
    const switched = (): void => {
      if (told < failures.length) {
        hooks.onNote?.(`${reasons(failures.slice(told), 'could not answer')} — this answer is from ${choice.model.name}.`)
      }
      told = failures.length
    }
    let spoke = false
    const onDelta = (text: string): void => {
      if (!spoke) switched()
      spoke = true
      hooks.onDelta?.(text)
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
    // Against the **free tier**, which is the only allowance this ledger knows about. A paid
    // request is billed to credit and spends none of it, and counting it here is how a key
    // with money behind it talked itself out of the pool halfway through a day.
    if (!paid(choice.model.tier)) sent(store, choice.provider)
    const later = choices.slice(at + 1).some(open)
    try {
      const { message, usage, cut } = await chat(
        choice.provider,
        { ...request, messages: outbound.messages, model: choice.model.id },
        onDelta,
        secrets,
      )
      /**
       * **A rung that says nothing has not answered**, and until this it counted as one.
       *
       * The free tier is full of rows that are not chat models — a content-safety classifier,
       * a preview that was withdrawn, a router alias pointing at nothing. They accept the
       * request, return `200`, stream zero tokens, and close. Every check here passed: no
       * throw, no error status, a `Message` with `content: ''`. So `send` returned it, the
       * loop ended `answered`, and **the person got an empty bubble after a long wait** with
       * nothing anywhere saying which model had done it or that anything had gone wrong.
       *
       * Found by attaching a picture, and it was never about pictures: those same models
       * return nothing for a typed sentence too. What the image filter did was narrow the
       * pool to a few hundred rows and put three of them at the top, which is how a fault
       * that had always been there became the ordinary case.
       *
       * A tool call with no prose is a real answer and must not be caught by this — that is
       * most of what the agent loop's turns look like.
       *
       * **A reply cut off at its ceiling is the same kind of failure** (D155), with one
       * exception: a paid one has been billed, and asking the next paid model would pay a
       * second time for an answer that ends at the same ceiling. That one comes back cut, and
       * the caller decides.
       */
      const empty = textOf(message).trim() === '' && (message.calls?.length ?? 0) === 0
      const short =
        empty ? `${choice.model.name} answered with nothing`
        : cut && !paid(choice.model.tier) ? `${choice.model.name} ran out of room before finishing`
        : undefined
      if (short !== undefined && later) {
        failures.push({ choice, reach: 'model', status: 502, says: short })
        if (spoke) hooks.onRestart?.()
        continue
      }
      if (!spoke) switched()
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
      return { message, usage, cut, model: choice.model, provider: choice.provider }
    } catch (error) {
      const failure = failed(error, choice)
      // The stop button, or a bug in core. Neither is somebody else's turn.
      if (failure === undefined || request.signal?.aborted === true) throw error
      failures.push(failure)
      if (spoke) hooks.onRestart?.()
      if (failure.reach === 'provider') refused.add(choice.provider.id)
      if (failure.reach === 'request') outgrown = Math.max(outgrown ?? 0, choice.model.context)
    }
  }
  const last = failures.at(-1)
  if (last === undefined) throw new ProviderError(blocked === undefined ? 503 : 402, blocked ?? 'nothing was available to ask')
  throw new ProviderError(last.status, stopped(failures, blocked))
}
