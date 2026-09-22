// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto'
import { PLANNER, routes, stature, type Model } from './catalog.js'
import { OLLAMA } from './ollama.js'
import { sent, spent, underHalf, type Rung } from './pool.js'
import type { Judgement, Health } from './health.js'
import { anonymous, chat, PATIENCE, ProviderError, PROVIDERS, type ChatRequest, type Heard, type Provider, type Usage } from './provider.js'
import { redact, summarise } from './redact.js'
import { CORE, type SecretStore } from './secrets.js'
import { HEDGE_AFTER, RETRY_STEP, STAR_WAIT, type Sign } from './provider.js'
import { textOf, type Message, type Outcome, type Source, type Store } from './store.js'
import { floor, PER_TOKEN, size, summary } from './trim.js'
import { affordable, costOf, dollars as money, type Today } from './usage.js'

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

/**
 * **What a plugin's declared floor means in words** (M8-1, `Ask.minTier`). A refusal names
 * the next action, and *T2* is not a thing anybody outside this file has read. `T0` is never
 * a wall — every model is at or above it — and is here so the map is total.
 */
const FLOOR_SAYS: Record<Tier, string> = {
  T0: 'a model',
  T1: 'a hosted model rather than one on this machine',
  T2: 'a paid model',
  T3: 'a frontier model',
}
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
 * that lives in their house**. Slow helpers go near the end, which is what {@link ranking}
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
 * **How much personality a model can be trusted to read** (`plan-personality.md` §2, D160).
 *
 * A personality goes into the system prompt on **every step**, so a 600-word one re-sent
 * fifteen times is 7–8k tokens of a task's budget. On a paid model that is money; on a free
 * one it is context, rate limit, and instructions followed halfway. Three lengths, written in
 * one Adapt call, and this is the axis that decides which of them a given model is handed.
 */
export type Size = 'small' | 'medium' | 'high'

/**
 * **A window this small is a window the personality is competing with** (§2).
 *
 * 32k is the keyless floor's own size, and the number the router already treats as the small
 * end of the catalog. Below it the trace, the tools and the answer are already close together,
 * and six hundred words of standing instruction is the part that gets squeezed out silently.
 * A model that does not publish a window is not judged by it — silence is not smallness, which
 * is the reading every other filter in this file gives it.
 */
export const READS_SHORT = 32_768

/**
 * **Which size this model gets, by capability rather than by price** (§2).
 *
 * The order is *small first*, deliberately, and it is the rule the section states in as many
 * words: **when in doubt, the weaker reader**. A short document handed to a model that could
 * have read the long one costs a little character; the long one handed to a model that cannot
 * hold it costs the whole feature, silently, which is the failure this plan opened with.
 *
 * - **Small** — known to be under {@link PLANNER}B, a window under {@link READS_SHORT}, **any
 *   router** (a different model each time, so plan for the worst one it might be), or a model
 *   whose size nobody publishes *and* that this machine's own record doubts: new and not tried
 *   yet, too many errors, gave bad answers (D161), or a failure still counting against it
 *   (D159). Unknown alone is not enough — most closed models never say.
 * - **High** — a paid model. Not because it is dear, but because a model somebody is billed
 *   for is one that holds a long document and follows it, and it is the one place the full
 *   six hundred words earn their tokens.
 * - **Medium** — everything else: the free hosted models, and this machine's own from 7B up.
 *
 * **Asked of the model a call actually goes to**, as `send` reaches each rung — not of the
 * weakest model in a whole plan. A plan is every model that fits, so its weakest was nearly
 * always a router or a 2B, and the strong model at its head was handed a hundred words.
 */
export function sizeFor(choice: Choice, world: Pick<World, 'health' | 'strikes'>, at: number = Date.now()): Size {
  const { model } = choice
  const known = world.health?.get(`${choice.provider.id}\n${model.id}`)
  const doubted = known?.untested === true || known?.doubted === true || known?.aside !== undefined
  const struck = (sunk(world.strikes ?? [], at).get(`${choice.provider.id}\n${model.id}`) ?? 0) > 0
  if (
    stature(model) === 'small' ||
    (model.context > 0 && model.context < READS_SHORT) ||
    routes(model) ||
    (stature(model) === 'unknown' && (doubted || struck))
  ) {
    return 'small'
  }
  return paid(model.tier) ? 'high' : 'medium'
}

/**
 * **One personality in three lengths** (§2), as the plugin hands it over and core reads it.
 *
 * `high` is required and the other two are not: a row saved before any of this existed has one
 * document and nothing else, and falling back to it for every size is exactly what happened
 * before there were sizes. So an older plugin, an older row, and a hand-written document all
 * behave as they always did rather than as a missing field.
 */
export interface Personality {
  high: string
  small?: string
  medium?: string
}

/**
 * **A personality's lengths out of whatever a plugin sent**, read defensively: a length that is
 * not a string with something in it is no length, and without the long one there is no
 * personality at all. `high` is the long one when it arrived somewhere else — `content`, for
 * `persona.personality`.
 */
export function personalityFrom(fields: Record<string, unknown>, high: unknown = fields.high): Personality | undefined {
  const one = (held: unknown): string | undefined => (typeof held === 'string' && held.trim() !== '' ? held.trim() : undefined)
  const long = one(high)
  if (long === undefined) return undefined
  const small = one(fields.small)
  const medium = one(fields.medium)
  return { high: long, ...(small !== undefined && { small }), ...(medium !== undefined && { medium }) }
}

/**
 * **What a model of this size is actually given, and which size that turned out to be.**
 *
 * Both, because they are not the same question and the trace needs the second one. A plugin
 * that offers one document is handed a `small` verdict and still sends the long one — there is
 * nothing else to send — and a line saying *small* about six hundred words that went out would
 * be the trace lying in the one place it exists to tell the truth. So what comes back is what
 * happened: the text, and the size the text actually is.
 */
export const sizedFor = (personality: Personality, size: Size): { text: string; size: Size } =>
  size === 'small' && personality.small !== undefined ? { text: personality.small, size: 'small' }
  : size !== 'high' && personality.medium !== undefined ? { text: personality.medium, size: 'medium' }
  : { text: personality.high, size: 'high' }

/**
 * **Which rungs of a plan hear a personality at one length** (D189) — *Hear her*, asked to be
 * heard short, medium or full rather than as the chat would.
 *
 * The rungs the chat would give that length to, in the plan's own order: a sample of the full one
 * goes to a model that is given the full one, and a sample of the short one to a model given the
 * short one. **The plan is already the person's**: it was routed under their pins, the slider and
 * the paid switch, so a length only paid models are given is out of reach with paid off — and
 * then the nearest thing is asked rather than nothing. For the full one that is the strongest
 * model the plan has, walked from the capable end; for the others, the plan as it stands. Which
 * of the two happened is `matched`, so the sample can say so.
 */
export function hearingPlan(
  choices: readonly Choice[],
  world: Pick<World, 'health' | 'strikes'>,
  want: Size,
  at: number = Date.now(),
): { choices: Choice[]; matched: boolean } {
  const given = choices.filter((choice) => sizeFor(choice, world, at) === want)
  if (given.length > 0) return { choices: given, matched: true }
  const nearest = want === 'high' ? [...choices].sort(ranking(world, 'capable', at).compare) : [...choices]
  return { choices: nearest, matched: false }
}

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
 * carry it. *Can this account pay* is here since §4 D, where a provider says: OpenRouter's key
 * endpoint says whether the account ever bought credit and how much of the key's limit is left.
 */
export const available = (
  model: Model,
  connected: ReadonlySet<string>,
  spend: Spend,
  /** Providers whose account cannot pay, by their own word (§4 D, *Funded*). Their paid rows are out. */
  unfunded: ReadonlySet<string> = new Set(),
): boolean => connected.has(model.provider) && allowed(model, spend) && !(paid(model.tier) && unfunded.has(model.provider))

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
  /**
   * **Nobody at the screen is waiting on this** (D160, §4 F): a plugin's task, a plugin's request,
   * a daily test — never the chat, and never a button somebody pressed and is watching (Adapt,
   * D161). A free allowance is shared by every free model on an account, so the chat being
   * watched gets first claim on it: background asks providers with no daily ration and this Mac
   * first, a day-limited provider only when nothing else can do the job, and then only the first
   * half of its day.
   */
  background?: boolean
  /**
   * **Models not to ask**, keyed `provider\nmodel` (§4 I): the one somebody just marked a bad
   * answer, when the same question is asked again. Nothing else about the plan changes.
   */
  avoid?: readonly string[]
  /**
   * **The asking plugin wants a model that can do the work, not the cheapest that fits**
   * (M8-1) — read from MCP's `modelPreferences` by {@link wantsCapable}.
   *
   * It is one flag rather than three because a plugin asking for intelligence means all
   * three of these and has no way to ask for them one at a time:
   *
   * 1. **Best-first.** The ranking is walked from the other end on the price axis — paid
   *    before free, the bigger tier, the dearer model — and **only** that axis. `/best` also
   *    turns §8.2's rungs round, which is right for somebody typing *give me the strongest
   *    thing you can reach* and wrong here: a talker is not a better writer than a model with
   *    tools, and a stranger's shared floor is not better than the key you paid for.
   * 2. **Never a router.** A router is a different model each time, 2.6B included ({@link
   *    routes}, D159), so it is not an answer to *give me one that can write*. It is not a
   *    candidate at all here, and a pin on one is ignored rather than obeyed — a pin on a
   *    router is not somebody choosing a model, it is somebody choosing *surprise me*, and
   *    that is the one pin this cannot honour and still mean anything. A pin on a real model
   *    still wins outright, as it does over every other preference.
   * 3. **Never a model Alexia doubts**, while anything else fits: new and not tried yet, too
   *    many errors, bad answers, set aside. The reading D161 already gives *set aside* —
   *    skipped while something else can answer, asked when nothing else can, so this never
   *    turns a button into one that cannot be pressed on a busy evening.
   *
   * **Why this is here and not in the plugin.** The plugin cannot see the model list by
   * design, so *one real model, and not a bad one* is not a thing it can do for itself. It
   * is why the personality adapter asked for `intelligencePriority: 0.8` from the day it was
   * written and was answered by whichever free model a JSON feed happened to list first.
   */
  capable?: boolean
}

/**
 * **What core honours of MCP's `modelPreferences`, and what it does not** (M8-1).
 *
 * Three numbers between 0 and 1, and the honest answer is that exactly one of them maps onto
 * a signal this router has. **Intelligence first, and meant**: the largest of the three and
 * at least half, which is the adapter's 0.8/0.3/0.3 and is not a plugin that set all three
 * to 0.5 and moved on. That becomes {@link Ask.capable}.
 *
 * - **`costPriority` is already the answer.** Cheapest-first is what this router does when
 *   nobody says otherwise, so a plugin asking for it is asking for the default and there is
 *   nothing to change. Honoured by being true already.
 * - **`speedPriority` is read and not acted on**, and that is written here rather than left
 *   to be discovered: nothing in the catalog says how fast a model answers. The nearest
 *   thing is D159's strikes, which record a model that timed out *here* and already sink it
 *   for everybody. Inventing a speed order out of size or price would be a guess wearing a
 *   knob's clothing, which is the exact failure M8-1 exists to end.
 * - **`hints` are read and not acted on.** They name models by substring — *claude-3-sonnet*
 *   — which is a plugin choosing a vendor, and the one thing this router will not let a
 *   plugin do: the user's own pins, slider and allowance decide who answers.
 *
 * MCP 2.0.0 marks `modelPreferences` deprecated (SEP-2577, 2026-07-28) in favour of calling
 * a provider directly, which is the one thing a plugin here must never do — so it is
 * honoured while it exists, and the day it leaves the schema this is what has to be replaced.
 */
export const wantsCapable = (prefs?: { intelligencePriority?: number; speedPriority?: number; costPriority?: number }): boolean => {
  const mind = prefs?.intelligencePriority
  return mind !== undefined && mind >= 0.5 && mind > (prefs?.costPriority ?? 0) && mind > (prefs?.speedPriority ?? 0)
}

export interface Choice {
  model: Model
  provider: Provider
  /** The person's own key is on it — see `Rung.keyed`. Absent reads the provider's `auth`. */
  keyed?: boolean
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

export type Verdict =
  | {
      ok: true
      mode: Mode
      choices: Choice[]
      /**
       * **Dollars today's allowance has left, when the allowance is what let paid in** (D186).
       * Handed to {@link send} as `left`, which skips a paid rung whose worst case is more than
       * this. Absent where the allowance does not govern — the slider at *paid only*, somebody
       * saying the words — and where nothing paid could be in the plan at all.
       */
      left?: number
    }
  | {
      ok: false
      mode: Mode
      why: string
      /**
       * **A pause, not a stop** (§4 H): the free models are done — used up, or none can do this —
       * a paid one would answer, and the paid switch is off. The sentence to show beside *Allow
       * switching to a paid model*.
       */
      paused?: string
    }

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
  /**
   * **Whether Automatic may cross into paid by itself** (§4 H): the paid switch is on, or somebody
   * pressed *Allow* in this conversation. `false` is the switch off, which pauses rather than
   * refusing when a paid model would answer. Absent is the old rule, where the daily allowance
   * alone decides — which is also what a world gathered by hand in a test means.
   */
  cross?: boolean
  /**
   * **What failed on this machine in the last day** (D159), from `Store.strikes()`. Absent is
   * nothing failed, which is what a world gathered by hand in a test means.
   */
  strikes?: readonly Strike[]
  /**
   * **What Alexia thinks of each model** (D161), from `judge()` over the 30-day record. Absent is
   * nothing known, which is what a world gathered by hand in a test means.
   */
  health?: Health
  /**
   * **Models reported broken elsewhere** (§4 J), keyed `provider\nmodel`: the hook for a record
   * shared with a server of the owner's, decided later (D160), and empty today. Filled, `judge()`
   * would read it as one more piece of evidence and never as a deletion. Absent is nothing reported.
   */
  reported?: ReadonlySet<string>
  /**
   * **Models whose every host is down right now, by their provider's own published status**, keyed
   * `provider\nmodel`. OpenRouter publishes each model's hosts with their last few minutes of
   * uptime, and reading it spends no request of anybody's. A model in here is asked after every
   * model that is not, and still asked: a status page can be wrong, and a pin is a pin. Absent is
   * nothing known to be down.
   */
  down?: ReadonlySet<string>
}

/** One failure of one model on one provider, as {@link send} recorded it. */
export interface Strike {
  provider: string
  model: string
  at: number
  /** How it went, for the sentence under its row. Absent on a strike made by hand. */
  outcome?: Outcome
}

/**
 * **How long a failure takes to count half as much** (D159).
 *
 * A failure counts one when it happens and halves every hour; a model sinks by what it is
 * carrying, rounded. So one failure sinks a model for an hour, two together for two, four for
 * three, and a model that fails every time it is tried is tried again about every hour and a
 * half — never written off, because a rate limit ends and a free tier resets. An hour because
 * the failures this is for mostly are that short: a per-minute limit, a busy worker, a slow
 * evening. The store forgets a strike after a day.
 */
export const STRIKE_HALF_LIFE = 60 * 60 * 1000

/** How far each model on each provider has sunk right now, keyed `provider\nmodel`. Zero is absent. */
export function sunk(strikes: readonly Strike[], at: number = Date.now()): Map<string, number> {
  const carried = new Map<string, number>()
  for (const strike of strikes) {
    const key = `${strike.provider}\n${strike.model}`
    carried.set(key, (carried.get(key) ?? 0) + 0.5 ** (Math.max(0, at - strike.at) / STRIKE_HALF_LIFE))
  }
  return new Map([...carried].map(([key, weight]) => [key, Math.round(weight)] as const).filter(([, level]) => level > 0))
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
 * below, and `PLANNER` (in `catalog.ts`, beside the size it is compared with).
 *
 * The floor that remains is the asking plugin's own `min_tier`, which was always separate.
 */

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
  const avoided = new Set(ask.avoid ?? [])
  const everything: Choice[] = [...hosted.map((row) => row.choice), ...(where === 'local' || kind === 'text' ? here : [])].filter(
    (c) => !avoided.has(`${c.provider.id}\n${c.model.id}`),
  )
  /** What the free-tier ledger believes is spent. A pre-check for Automatic, never a refusal of somebody's own choice. */
  const tired = new Set(hosted.filter((row) => row.out).map((row) => row.choice))
  /** Automatic's order: what failed here lately (D159), what is known of each model (D161), and the rest. */
  const ranked = ranking(world).compare
  /**
   * **Set aside by Alexia** (D161): a whole day of nothing but refusals, three empty answers, a
   * retired model, a keyless provider that now wants a key. Never deleted, and never a reason to
   * refuse a pin — only a reason not to ask while something else can answer.
   */
  const aside = (c: Choice): boolean => world.health?.get(`${c.provider.id}\n${c.model.id}`)?.aside !== undefined
  /** A free choice on a provider that rations its day or month — the requests the chat has first claim to (§4 F). */
  const dayLimited = (c: Choice): boolean => {
    const rung = connected.get(c.provider.id)
    return !paid(c.model.tier) && c.model.tier !== 'T0' && rung !== undefined && (rung.dayLimit !== undefined || rung.monthLimit !== undefined)
  }
  /** Whether background may take this choice at all: not day-limited, or still in the first half of its day. */
  const keptFor = (c: Choice): boolean => {
    const rung = connected.get(c.provider.id)
    return !dayLimited(c) || rung === undefined || underHalf(rung)
  }
  /** Why background stops when what could answer is the chat's half: named by provider. */
  const chatsHalf = (held: readonly Choice[]): string => {
    const names = [...new Set(held.filter((c) => !keptFor(c)).map((c) => c.provider.name))]
    const said = names.length <= 1 ? (names[0] ?? 'those') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`
    return `the rest of today's ${said} requests are kept for your chat`
  }

  /**
   * **One real model, asked for by the plugin that needs one** ({@link Ask.capable}, M8-1).
   *
   * Declared here rather than beside the filters below because the pin is answered first and
   * this is the one preference a pin does not simply win over — see the field's own note.
   */
  const capable = ask.capable === true
  /** A model Alexia has doubts about: new and not tried yet, too many errors, bad answers (D161). */
  const doubted = (c: Choice): boolean => {
    const known = world.health?.get(`${c.provider.id}\n${c.model.id}`)
    return known?.untested === true || known?.doubted === true
  }

  if (pins.model) {
    // The user named one. Their choice, including past a flag nobody has verified — and past
    // the ledger, which is this machine's low copy of somebody else's number (D107). Refusing a
    // pin *before trying it* because the count says spent was the pin failing on a guess.
    //
    // **One model, and the provider picked the way a list picks one** (D159). The same id is
    // often on two providers, and this took whichever the catalog read first — Kilo's keyless
    // floor ahead of the person's own OpenRouter key on this machine. Still one choice: a pin
    // never falls back, not even to the same model somewhere else.
    const [named] = everything.filter((c) => c.model.id === pins.model).sort(listed([pins.model], tired, ranked, aside))
    /**
     * **A pin on a router is not a pin on a model** (M8-1), and it is the only pin
     * {@link Ask.capable} steps around: whoever pinned `openrouter/free` asked for a
     * different free model each time, which cannot also be an answer to *one that can
     * write*. It was this exact pin that answered a 5,825-character description with a
     * 2.6B model and started the personality rebuild.
     *
     * Falling through rather than refusing, because the pin has said nothing about which
     * model this should be — so Automatic's own order below is what is left of it.
     */
    if (!(capable && named !== undefined && routes(named.model))) {
      // A pin is held to the same half for background (§4 F): somebody chose it, but not for this.
      if (named !== undefined && ask.background === true && !keptFor(named)) {
        return { ok: false, mode: 'pinned', why: chatsHalf([named]) }
      }
      return named ?
          { ok: true, mode: 'pinned', choices: [named] }
        : { ok: false, mode: 'pinned', why: `${pins.model} is not available right now.` }
    }
  }

  /**
   * **A list somebody made is the whole plan** (D155). Automatic gets every model the ledger
   * has not written off; a sequence gets exactly its own entries, none of them dropped on the
   * ledger's say-so — when it is the only list somebody wanted, asking and collecting a 429
   * beats skipping a model on a count.
   */
  const order = pins.order ?? []
  const mode: Mode = order.length > 0 ? 'sequence' : 'automatic'
  const floor = ask.minTier ?? 'T0'
  /** At or above the floor the asking plugin declared (M8-1). `T0` is every model. */
  const meetsFloor = (c: Choice): boolean => rank(c.model.tier) >= rank(floor)
  const withHeadroom = everything.filter((c) => !tired.has(c))
  /**
   * **The ledger steps aside when honouring it would leave nothing the floor allows** (D107).
   * *Anything else left* has to mean anything that could answer this: with the free tiers
   * marked spent and a model on this machine still there, a `T1` floor used to find only the
   * local model, refuse it, and tell somebody with two providers connected to connect one.
   */
  const pool: Choice[] =
    mode === 'sequence' ? everything.filter((c) => order.includes(c.model.id))
    : withHeadroom.some(meetsFloor) ? withHeadroom
    : everything

  const shape = ask.shape ?? shapeOf(ask)
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
  /** The switch is off and nobody allowed it in this conversation: paid pauses rather than spends (§4 H). */
  const switchedOff = world.cross === false
  const capped = asked === 'mixed' && where === 'cloud' && (!affordable(world.today) || switchedOff)
  const spend: Spend = capped ? 'free' : asked
  /**
   * The slider's middle, as opposed to somebody having said the words. Both extra rules below
   * are scoped to it — in a list somebody made as much as in Automatic, because they are rules
   * about money rather than about which model (D155 changed the second, not the first).
   */
  const middle = asked === 'mixed'
  /**
   * **What the allowance still has, for `send` to hold each paid rung to** (D186). *Is anything
   * left?* is the only question asked above, and it lets a day with a cent left reach a model
   * whose one reply could cost a dollar — the allowance a line crossed after the fact rather
   * than a limit. Scoped exactly as `capped` is: where the allowance decides whether paid is in
   * the plan, it also decides which paid rung can afford this request.
   */
  const left = asked === 'mixed' && where === 'cloud' && !capped && world.today !== undefined ? world.today.allowance - world.today.spent : undefined

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
  const fitting = (spend: Spend, sidegrades = false, from: readonly Choice[] = pool, routersToo = false): Choice[] =>
    from
      .filter(meetsFloor)
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
      /**
       * **A plugin that asked for a capable model is not handed a router** ({@link Ask.capable}).
       *
       * A filter and not an order, which is the difference between this and the `router` key
       * in {@link ranking}: sorting one last still walks to it when the models above it are
       * busy, and *a different model each time, 2.6B included* is not a worse answer to this
       * question, it is not an answer to it. Applied to a list somebody made as well, for the
       * same reason the pin above is: what a list says about a router is still *surprise me*.
       */
      .filter((c) => !capable || routersToo || !routes(c.model))
      .sort(
        mode === 'sequence' ? listed(order, tired, ranked, aside)
          // `/best` walks Automatic's ranking from the other end, and so does a plugin that
          // asked for a capable model. A list somebody put in order is not a ranking to walk
          // backwards.
        : capable ? ranking(world, 'capable').compare
        : pins.prefer === 'best' ? ranking(world, 'best').compare
        : ranked,
      )

  /**
   * **The chat first** (§4 F). Background asks what has no daily ration — and this Mac — first; only
   * when that fits nothing does a day-limited provider come in, and then only in the first half of
   * its day. A list keeps its own order and is held to the same half.
   */
  const everyone = fitting(spend)
  const background = ask.background === true
  // Free with no ration, not merely no ration: a paid model has none either, and counting it here
  // put money — or, on a plugin's own clock, a refusal — ahead of free requests nobody had used.
  const unrationed =
    background && mode === 'automatic' ? fitting(spend, false, pool.filter((c) => !dayLimited(c) && !paid(c.model.tier))) : []
  const fitted =
    !background ? everyone
    : unrationed.length > 0 ? unrationed
    : everyone.filter(keptFor)
  if (background && fitted.length === 0 && everyone.length > 0) return { ok: false, mode, why: chatsHalf(everyone) }
  /**
   * **Set aside is skipped while anything else fits, and asked when nothing does** (D161) — the
   * reading the ledger already gets: asking and collecting a refusal beats refusing on a guess.
   * Asked of what fits rather than of the pool, so a request only a set-aside model can take (a
   * picture, a long conversation) still reaches it. A list skips its set-aside entries the same
   * way and never loses one; a pin was answered above and ignores this. This narrows D155's
   * *Automatic falls through the whole ranked list* by the models that were failing anyway (D162).
   */
  const kept = fitted.filter((c) => !aside(c))
  const choices = kept.length > 0 ? kept : fitted
  /**
   * **And a model Alexia doubts waits the same way, for a plugin that asked for a capable one**
   * ({@link Ask.capable}, M8-1). Same shape, one step further in: set aside is *skipped while
   * anything else fits* for everybody, and new-and-untried, too-many-errors and gave-bad-answers
   * join it for the plugin that said the work needs a model that can do it.
   *
   * Not a filter, deliberately, and this is where it differs from the router above. A router is
   * not a capable model on its best day; a model with three failures behind it might be the only
   * one awake at eleven at night, and a button that refuses rather than trying it is worse than
   * one that tries it. So this narrows the plan while there is anything to narrow to, and gets
   * out of the way when there is not.
   */
  const sure = capable ? choices.filter((c) => !doubted(c)) : choices
  if (sure.length > 0) return { ok: true, mode, choices: sure, ...(left !== undefined && { left }) }
  if (choices.length > 0) return { ok: true, mode, choices, ...(left !== undefined && { left }) }
  // Was the allowance the wall? Only if opening the price line would actually have produced
  // something — otherwise the real wall is one of the others and saying *set an allowance*
  // sends somebody to spend money on a problem money does not fix.
  const priced = capped && fitting('mixed').length > 0
  // And the other new wall, asked the same way: was everything paid here merely equal to
  // what ran out? Relax the one rule and see whether anything appears.
  const sidegrade = !capped && middle && fitting(spend, true).length > 0
  /**
   * **The wall a plugin asking for a capable model meets** (M8-1), proved the same way the two
   * above are: put the routers back and see whether that was the only thing in the way. Said
   * before every sentence below, because each of those would send somebody to fix a different
   * thing — add a key, move the slider, start a new chat — and none of them is this.
   */
  /**
   * **The floor the asking plugin declared** (M8-1), which is a wall that could not exist
   * before `min_tier` was read: nothing reachable is at or above it. Said in the words a
   * person uses rather than in the tier's name, and asked only when the floor is the whole
   * reason — a `T2` floor on a machine that has paid models and no allowance is the money
   * wall below, not this one.
   */
  if (pool.length > 0 && !pool.some(meetsFloor)) {
    return { ok: false, mode, why: `what asked for this needs ${FLOOR_SAYS[floor]}, and nothing you have connected is one — connect a provider that offers one` }
  }
  if (capable && fitting(spend, false, pool, true).length > 0) {
    return {
      ok: false,
      mode,
      why: 'every model that fits this hands the request on to a different model each time, and this needs one model — pin one on the Models tab, or connect a provider that offers one of its own',
    }
  }
  /**
   * **Why the free models are done, when the switch is what stopped paid** (§4 H): used up, or not
   * one of them can do this — a picture, a long conversation, tools. Said beside *Allow*.
   */
  const pausedWhy = (): string => {
    const free = (mode === 'sequence' ? everything.filter((c) => order.includes(c.model.id)) : everything).filter((c) => !paid(c.model.tier))
    if (free.length === 0) return 'There is no free model to ask.'
    if (fitting('free', false, free).length > 0) return 'The free models are used up.'
    const unseen = carried.filter((kind) => !free.some((c) => c.model.modality.includes(kind)))
    if (unseen.length > 0) {
      return `No free model can be given ${unseen.map((kind) => (kind === 'image' ? 'a picture' : kind === 'audio' ? 'sound' : kind)).join(' or ')}.`
    }
    if (!free.some((c) => fits(c.model, ask.messages))) return 'This conversation is longer than any free model can read.'
    if (needsTools && !free.some((c) => c.model.supportsTools)) return 'No free model can use tools.'
    return 'No free model can do this.'
  }
  return {
    ok: false,
    mode,
    ...(priced && switchedOff && { paused: pausedWhy() }),
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
    // A paid model on an account its provider says cannot pay is not reachable (§4 D, *Funded*):
    // it would only collect a 402 after the plan had been shown to be possible.
    if (paid(model.tier) && rung.funded === false) return []
    const choice: Choice = { model, provider: rung.provider, ...(rung.keyed !== undefined && { keyed: rung.keyed }) }
    return [{ choice, out: spent(rung) && !paid(model.tier) }]
  })
}

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
 * **A keyless provider somebody has pasted a key into is keyed** (D159). It used to sort as
 * the floor, because a `Rung` did not say whether a key was stored: OVHcloud answers
 * anonymously at two requests a minute and at four hundred with a key, and a paid-up Kilo
 * account ranked with a stranger's. The pool reads the keychain for every provider now, and
 * `keyed` on the choice carries the answer; a choice built by hand without it reads `auth`.
 */
const RUNGS = { keyed: 0, machine: 1, floor: 2 } as const
const standing = (choice: Choice): number =>
  choice.model.tier === 'T0' ? RUNGS.machine
  : (choice.keyed ?? !anonymous(choice.provider)) ? RUNGS.keyed
  : RUNGS.floor

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

const STATURE = { big: 0, unknown: 1, small: 2 } as const

/** A ranking key's name: what the Models table's why-line says decided (D161). */
export type RankKey =
  | 'group'
  | 'untested'
  | 'doubted'
  | 'tools'
  | 'struck'
  | 'router'
  | 'ladder'
  | 'tier'
  | 'price'
  | 'size'
  | 'usage'

export interface Ranking {
  /** For `sort`: negative when `a` is asked first. */
  compare: (a: Choice, b: Choice) => number
  /** The key that puts `a` below `b`, or nothing when `a` is not below it. */
  decides: (a: Choice, b: Choice) => RankKey | undefined
  /** **The why-line**: one sentence saying why the lower of the two sits below the other. */
  explain: (a: Choice, b: Choice) => string
}

/**
 * **Which axis a ranking key is on**, and therefore who turns it round.
 *
 * It was one boolean, `money`, and two keys were on the wrong side of it — which nobody could
 * see while `/best` was the only thing that turned anything and the two keys in question
 * rarely decided a chat. `Ask.capable` made it visible immediately: asking for a model that
 * can write put a model with no tools first, and the keyless floor's 7B ahead of a 550B model
 * on the person's own key.
 *
 * - `price` — free-before-paid, the tier ladder, the per-token cost. Turning these round is
 *   what *strongest first* means, so both `/best` and {@link Ask.capable} turn them.
 * - `reach` — whether it has hands, and whose key it is on (§8.2's ladder). Nobody turns
 *   these: a talker is not stronger than a model with tools, and a stranger's shared floor is
 *   not a better anything than the key you paid for.
 * - `sure` — what predicts an answer at all: what failed here, whether it is a router, how
 *   big it is, how much the world uses it. Nobody turns these; a bigger, busier model that
 *   answered last time is the better one from either end.
 */
type Axis = 'price' | 'reach' | 'sure'

interface Key {
  name: RankKey
  axis: Axis
  compare: (a: Choice, b: Choice) => number
  /** Why `a` comes after `b` on this key, cheapest first. */
  says: (a: Choice, b: Choice) => string
}

/** Tokens the way a person reads them: 317B, 8.2B, 68M. */
const tokens = (n: number): string => {
  const [unit, size] = n >= 1e12 ? ['T', 1e12] : n >= 1e9 ? ['B', 1e9] : n >= 1e6 ? ['M', 1e6] : n >= 1e3 ? ['k', 1e3] : ['', 1]
  const scaled = n / size
  return `${scaled < 10 && unit !== '' ? scaled.toFixed(1).replace(/\.0$/, '') : String(Math.round(scaled))}${unit}`
}

/** Dollars per million tokens, to the cent unless it costs less than one. */
const dollars = (n: number): string => `$${n === 0 || n >= 0.01 ? n.toFixed(2) : String(n)}`

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
 *
 * **It was not enough on its own** (D159). Only OpenRouter publishes `weekly`, so without an
 * OpenRouter key every free model tied again and `kilo-auto/free`, a router, came first. So a
 * model is now ranked on what predicts a good answer, strongest signal first: what failed on
 * this machine, not a router, the ladder and the price as before, size, then `weekly` lent
 * across providers. Every one of them comes from outside this repo or from this machine.
 *
 * **An ordered list of named keys, each a comparison and a sentence** (D161). The Models table
 * puts a reason under every row, and a reason written anywhere but here would drift from the
 * order it explains. The comparator walks the keys; `explain` returns the sentence of the first
 * key on which two rows differ, which is exactly the key that put one below the other.
 */
export function ranking(
  world: Pick<World, 'strikes' | 'health'>,
  /**
   * Which end to walk from: the default, `/best`, or a plugin that asked for a model that can
   * do the work ({@link Ask.capable}). The last two differ by exactly one axis — see {@link Axis}.
   */
  from: 'cheap' | 'best' | 'capable' = 'cheap',
  at: number = Date.now(),
): Ranking {
  const idOf = (c: Choice): string => `${c.provider.id}\n${c.model.id}`
  /** How far each model on each provider has sunk on what failed here ({@link sunk}). */
  const weights = sunk(world.strikes ?? [], at)
  const struck = (c: Choice): number => weights.get(idOf(c)) ?? 0
  /** How each model's latest failure went, for its sentence. */
  const lately = new Map<string, Outcome | undefined>((world.strikes ?? []).map((one) => [`${one.provider}\n${one.model}`, one.outcome]))
  const judged = (c: Choice): Judgement | undefined => world.health?.get(idOf(c))
  /** Its own usage figure, or one lent to it, or a new model's stand-in. -1 is none, which sorts last. */
  const figure = (c: Choice): number => c.model.weekly ?? judged(c)?.standIn ?? -1

  const keys: Key[] = [
    {
      // The group comes first (D112). Free before paid, whatever else is true of either.
      name: 'group',
      axis: 'price',
      compare: (a, b) => Number(paid(a.model.tier)) - Number(paid(b.model.tier)),
      says: () => 'Costs money, so it comes after every free model.',
    },
    {
      // **Then not tried yet** (D161). A new model starts at the bottom of its group, and its
      // first good reply — to a real question or a daily test — lets the keys below place it.
      name: 'untested',
      axis: 'sure',
      compare: (a, b) => Number(judged(a)?.untested === true) - Number(judged(b)?.untested === true),
      says: () => 'New and not tried yet, so it waits below every model that has answered. One good reply moves it up.',
    },
    {
      // **Then doubted** (D161): too many errors here, or two *Bad answer* presses. Still listed
      // and still asked, after every model in its group that nobody has doubts about.
      name: 'doubted',
      axis: 'sure',
      compare: (a, b) => Number(judged(a)?.doubted === true) - Number(judged(b)?.doubted === true),
      says: (a) =>
        judged(a)?.tags.some((tag) => tag.says === 'gave bad answers') === true ?
          'You marked its answers bad twice in 30 days, so it comes after every model without doubts.'
        : 'At least half of its tries here failed in the last 30 days, so it comes after every model without doubts.',
    },
    {
      /*
       * **Then hands before mouths** (§8.2).
       *
       * §8.1's organising idea: some helpers can call tools and therefore do work, some can
       * only talk, and you ask a helper with hands first — so a model on this machine that can
       * use tools (rung 4) is above a hosted free one that cannot (rung 6), which is what the
       * ladder prints. It does not overrule the filter above it; that one *removes* the talkers
       * when the work needs hands, and this one *orders* them when it does not.
       *
       * None of what follows applies to a list somebody put in order ({@link listed}) except
       * between one model's providers: somebody who dragged a row to the top typed that, and
       * none of this exists to argue with them.
       *
       * Rung 2, the Claude subscription, is not here and cannot be: it is a plugin offering a
       * tool, never a row in `PROVIDERS`, and it ships off (§14.1). A rung the user unlocks by
       * hand is not a rung a shipped cascade can walk onto by itself.
       */
      name: 'tools',
      axis: 'reach',
      compare: (a, b) => Number(!a.model.supportsTools) - Number(!b.model.supportsTools),
      says: () => 'Can only talk, not use tools, so it comes after every model that can.',
    },
    {
      /*
       * **Then what failed on this machine** (D159), the strongest signal there is about *this*
       * person's keys and network, and the only one. A model that timed out a minute ago goes
       * behind the ones that did not, and comes back as the failure ages.
       */
      name: 'struck',
      axis: 'sure',
      compare: (a, b) => struck(a) - struck(b),
      says: (a, b) =>
        `${lately.get(idOf(a)) === 'busy' ? 'Was busy' : 'Failed here'} recently, so it sits below ${b.model.name} for ${struck(a) > 1 ? 'a few hours' : 'about an hour'}.`,
    },
    {
      // **Then not a router** (D159). A router is a different model each time, 2.6B included,
      // so it is asked after every model that is one model. It stays pinnable.
      name: 'router',
      axis: 'sure',
      compare: (a, b) => Number(routes(a.model)) - Number(routes(b.model)),
      says: (a) =>
        `A router: a different ${paid(a.model.tier) ? '' : 'free '}model each time, some of them tiny. Asked after every single model.`,
    },
    {
      /*
       * **Then the ladder**, {@link standing}: keyed, then this machine, then the keyless floor.
       *
       * **`rank` cannot do this job**, which is why it is a key of its own rather than a
       * fall-through: it reads `T0` as the *cheapest* tier, so left to it a local model sorts in
       * front of every keyed free tier — the exact opposite of the rung §8.3 put it on.
       */
      name: 'ladder',
      axis: 'reach',
      compare: (a, b) => standing(a) - standing(b),
      says: (a, b) =>
        standing(a) === RUNGS.machine ? 'Runs on this Mac: free and private, but slow. After the free models on your key.'
        : `No key needed, so shared and rationed for everyone. After ${standing(b) === RUNGS.machine ? 'this Mac’s model' : 'models on your key'}.`,
    },
    {
      name: 'tier',
      axis: 'price',
      compare: (a, b) => rank(a.model.tier) - rank(b.model.tier),
      says: (a, b) =>
        a.model.tier === 'T3' ? 'A frontier model, so it comes after the smaller paid ones.'
        : `A bigger tier than ${b.model.name}, so it comes after it.`,
    },
    {
      name: 'price',
      axis: 'price',
      compare: (a, b) => a.model.priceIn - b.model.priceIn || a.model.priceOut - b.model.priceOut,
      says: (a, b) =>
        a.model.priceIn !== b.model.priceIn ?
          `Costs ${dollars(a.model.priceIn)} per million tokens in, more than ${b.model.name}’s ${dollars(b.model.priceIn)}.`
        : `Costs the same as ${b.model.name} to send, and ${dollars(a.model.priceOut)} per million tokens back, more than its ${dollars(b.model.priceOut)}.`,
    },
    {
      /*
       * **Then what predicts a good answer, among models that cost the same** — which for the
       * free tier is all of them (D159). Size first, read from the id where the provider does
       * not report one ({@link stature}); then `weekly`, borrowed from OpenRouter by every
       * provider serving the same model (`borrow()` in `catalog.ts`). Neither is turned round by
       * `/best`: a bigger, busier model is the better one from either end.
       */
      name: 'size',
      axis: 'sure',
      compare: (a, b) => STATURE[stature(a.model)] - STATURE[stature(b.model)],
      says: (a) =>
        stature(a.model) === 'unknown' ?
          `Its size isn’t published, so it comes after models known to be ${String(PLANNER)}B or more.`
        : `Under ${String(PLANNER)}B${a.model.params === undefined ? ' (read from its name)' : ''}, so it comes after every model not known to be that small.`,
    },
    {
      // A new model that has answered and has no figure yet ranks on its stand-in: the middle of
      // models its size, until its own figure or a lent one replaces it (D161).
      name: 'usage',
      axis: 'sure',
      compare: (a, b) => figure(b) - figure(a),
      says: (a, b) => {
        if (figure(a) < 0) return 'Nobody publishes how much it is used, so it comes after the models that have a figure.'
        const lender = a.model.weeklyFrom
        const its =
          a.model.weekly === undefined ?
            `New here and has answered, so until a usage figure arrives it stands at the middle of models its size, ${tokens(figure(a))} tokens a week`
          : `The world sent it ${tokens(figure(a))} tokens last week${lender === undefined ? '' : ` (figure from ${PROVIDERS.find((one) => one.id === lender)?.name ?? lender})`}`
        return `${its}, fewer than ${b.model.name}’s ${tokens(figure(b))}${b.model.weekly === undefined ? ', the middle of models its size' : ''}.`
      },
    },
  ]

  /**
   * **Who turns which axis round** ({@link Axis}). Walking the whole list backwards put the
   * model that failed a minute ago, and a router, at the top of the strongest-first list, so
   * `sure` is never turned.
   *
   * **`/best` and a plugin asking for a capable model turn only `price`** — paid first, the
   * dearest first. With `reach` turned as well, *write me a personality* on this Mac's own
   * catalog chose a model with no tools, and then the keyless floor's 7B ahead of a 550B model
   * on the owner's OpenRouter key; `/best` did the same, putting a talk-only model ahead of a
   * frontier one with hands. A stranger's shared floor is not a stronger model, it is a cheaper
   * one — the ladder was only on the money half by accident of having been one boolean.
   */
  const way = (key: Key): number => ((from === 'best' || from === 'capable') && key.axis === 'price' ? -1 : 1)
  const deciding = (a: Choice, b: Choice): Key | undefined => keys.find((key) => key.compare(a, b) !== 0)
  return {
    compare: (a, b) => {
      const key = deciding(a, b)
      return key === undefined ? 0 : way(key) * key.compare(a, b)
    },
    decides: (a, b) => {
      const key = deciding(a, b)
      return key !== undefined && way(key) * key.compare(a, b) > 0 ? key.name : undefined
    },
    explain: (a, b) => {
      const key = deciding(a, b)
      if (key === undefined) return `Ties with ${b.model.name} on everything Alexia knows; the provider’s own order decides.`
      // Said about the lower of the two, whichever way round they were handed over.
      const [lower, upper] = way(key) * key.compare(a, b) > 0 ? [a, b] : [b, a]
      if (way(key) < 0) {
        return from === 'best' ?
            `/best turns the money order round, so it comes after ${upper.model.name}.`
          : `What asked for this wants the strongest model, so it comes after ${upper.model.name}.`
      }
      return key.says(lower, upper)
    },
  }
}

/**
 * **A sequence, in the order somebody wrote it** (D155) — within its group, because the group
 * is a property of the model and not of the list (D112): a shortlist is a running order
 * *within* what the slider allowed, never a second, quieter way to start spending money.
 *
 * **A list names models, not providers**, and one id is often served by two: the same
 * Nemotron is on OpenRouter behind your key and on Kilo's keyless floor. Between those two the
 * list has no opinion, so what this machine knows decides first — a copy not set aside (D161),
 * then the one with headroom — and then Automatic's own ranking, which puts your key ahead of
 * the floor. Without that the tie went to whichever provider's list the catalog read first.
 */
const listed =
  (
    order: readonly string[],
    tired: ReadonlySet<Choice>,
    ranked: (a: Choice, b: Choice) => number,
    aside: (c: Choice) => boolean,
  ) =>
  (a: Choice, b: Choice): number =>
    Number(paid(a.model.tier)) - Number(paid(b.model.tier)) ||
    order.indexOf(a.model.id) - order.indexOf(b.model.id) ||
    Number(aside(a)) - Number(aside(b)) ||
    Number(tired.has(a)) - Number(tired.has(b)) ||
    ranked(a, b)

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
  if (capped && world.cross === true && (world.today?.allowance ?? 0) > 0) {
    // The switch is on and today's amount is spent: the allowance stopping it, as it always did (§4 H).
    return `the free models are used up, and today's $${(world.today?.allowance ?? 0).toFixed(2)} for paid models is spent — raise it under the paid switch on the Models tab, or wait for tomorrow`
  }
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

/**
 * **A switch to another model**, with its parts (D160, §4 G): which models could not answer, which
 * one is answering instead, why, and the sentence. Said twice on screen — a pop-up for three
 * seconds, and a line on the answer that is saved with it.
 */
/**
 * **What Alexia is doing right now, while nobody is being answered yet** — the line under the
 * question that replaces a silent `…`. Alexia.md: *silence is what kills, not time.*
 *
 * A stage and the facts of it, never a sentence: the screen owns the words, and every fact here
 * is literally true — the model named is the one being asked, the attempt is the attempt.
 *
 * - `choosing` — working out which models fit this step (the router, the world it reads).
 * - `reading` — reading attached files before anything else happens.
 * - `asking` — a request has gone to `model`.
 * - `retrying` — `model` said it was busy right now, and is being asked again (`attempt` from 2).
 * - `backup` — `model` has been asked as well, because `behind` was `busy` or `slow` to start.
 * - `thinking` — `model` is reasoning and has not written a word yet.
 * - `writing` — `model` is writing the answer.
 * - `tool` — a tool called `name` is running.
 */
export type Phase =
  | { kind: 'choosing' }
  | { kind: 'reading' }
  | { kind: 'asking'; model: string }
  | { kind: 'retrying'; model: string; attempt: number }
  | { kind: 'backup'; model: string; behind: string; why: 'busy' | 'slow' }
  | { kind: 'thinking'; model: string }
  | { kind: 'writing'; model: string }
  | { kind: 'tool'; name: string }

export interface Switch {
  from: string[]
  to: string
  reasons: string[]
  says: string
}

export interface Answer {
  message: Message
  usage: Usage
  model: Model
  provider: Provider
  /** The person's own key was on it, as the plan's choice said — for {@link bubble}. */
  keyed?: boolean
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
  /** How the model record keeps it (D161). */
  outcome: Outcome
}

/** How providers say *this conversation is longer than this model reads*. A 400 that says anything else is about the model. */
const TOO_LONG = /context|too long|too large|too many tokens|maximum.{0,40}tokens|token limit|reduce the length/i
/**
 * **How providers say *that reply ceiling is more than this model writes*** — `max_tokens is too
 * large`, Groq's *must be less than … the `context_window`*. Every one of these also matches
 * {@link TOO_LONG}, and read that way a plugin asking for 4,000 tokens from a model that writes
 * 2,000 was told *this conversation is too long — start a new chat* on its first message, with
 * every model the same size then skipped. It is about the model, so the next one is asked.
 */
const REPLY_CAP = /max_tokens|max_completion_tokens|max_new_tokens|max_output_tokens|maximum output/i
/** …unless it counts the conversation in as well, which is the conversation being too long for the window. */
const COUNTS_INPUT = /messages|prompt|input/i

/**
 * What a thrown error means for the walk, or `undefined` when it is not a provider failing at
 * all — a bug in core, or the stop button — which is thrown on rather than walked past.
 */
export function failed(error: unknown, choice: Choice): Failure | undefined {
  if (!(error instanceof ProviderError)) return undefined
  const { model, provider } = choice
  const { status, trouble } = error
  const of = (reach: Reach, says: string, outcome: Outcome): Failure => ({ choice, reach, status, says, outcome })
  if (status === 401) {
    // With no key of the person's on the request, a provider that answers anonymously is
    // saying that *this model* wants one — the rest of its list still answers.
    if (trouble === 'keyless' && anonymous(provider)) return of('model', `${model.name} needs a ${provider.name} key`, 'needs-key')
    return of('provider', trouble === 'keyless' ? `${provider.name} has no key yet` : `your ${provider.name} key was refused`, 'key-refused')
  }
  if (status === 400 && REPLY_CAP.test(error.message) && !COUNTS_INPUT.test(error.message)) {
    return of('model', `${model.name} cannot write a reply as long as this asks for`, 'failed')
  }
  if (status === 413 || (status === 400 && TOO_LONG.test(error.message))) {
    return of('request', `this conversation is too long for ${model.name}`, 'too-long')
  }
  // The outcome is named here, beside the sentence, so the record and the stop cannot disagree
  // about what happened (D161). No credit is the account's and a connection that could not be
  // made may be this Mac's: both still sink the model, as D159 had them, and neither tags it.
  const slow = trouble === 'slow' || trouble === 'kept' || status === 408
  return of(
    'model',
    trouble === 'slow' ? `${model.name} did not answer within ${String(Math.round((provider.timeoutMs ?? PATIENCE.first) / 1000))} seconds`
    : trouble === 'kept' ? `${model.name} did not answer in ${String(Math.round(Math.max(provider.keptAliveMs ?? PATIENCE.keptAlive, provider.timeoutMs ?? PATIENCE.first) / 1000))} seconds, though ${provider.name} kept the connection open`
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
    slow ? 'slow'
    : trouble === 'unreachable' ? 'unreachable'
    : trouble === 'stalled' || trouble === 'dropped' ? 'failed'
    : status === 402 ? 'no-credit'
    : status === 404 ? 'retired'
    : status === 429 ? 'busy'
    : 'failed',
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
 * **What a provider said about its limits, kept where it applies** (§4 D).
 *
 * Most count per key, so what one answer says is the whole provider's. Groq counts per model: read
 * as the provider's, one model's day running out set every Groq model aside with it, 14,400-a-day
 * ones included. On such a provider a count that reaches nothing is a wait on the one model — until
 * the reset it named, or the end of that minute or day — and a count with some left says nothing
 * about the others.
 */
export function listen(store: Store, choice: Choice, heard: Heard, at: number = Date.now()): void {
  if (choice.provider.limitsPerModel !== true) return store.hear(choice.provider.id, heard, choice.model.id, at)
  const minute = heard.minute !== undefined && heard.minute.remaining <= 0 ? (heard.minute.resets ?? at + 60_000) : 0
  const day = heard.day !== undefined && heard.day.remaining <= 0 ? (heard.day.resets ?? Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), new Date(at).getUTCDate() + 1)) : 0
  const until = Math.max(heard.retryAt ?? 0, minute, day)
  if (until > at) store.hear(choice.provider.id, { retryAt: until }, choice.model.id, at)
}

/**
 * **The most one rung could bill for a request** (D186): everything sent counted at
 * {@link PER_TOKEN}, which over-counts on purpose, and the whole reply ceiling at the output
 * price. A worst case rather than a guess, because it is held against money somebody set aside.
 */
export const dearest = (model: Model, messages: Message[], request: Pick<ChatRequest, 'tools' | 'maxTokens'>): number =>
  costOf(model, {
    in: Math.ceil((size(messages) + (request.tools === undefined ? 0 : JSON.stringify(request.tools).length)) / PER_TOKEN),
    out: request.maxTokens ?? 0,
  })

/**
 * **A provider that has refused this many models for want of a key, in one walk, is skipped for
 * the rest of it** — unless one of its models showed a sign of life in the same walk.
 *
 * Each such refusal is about one model: a keyless provider answers most of its list anonymously
 * and a few only with a key (D165). But on 18 Sep a single walk asked 116 Kilo models in seventeen
 * seconds, every one of them wanting a key, and ended with no answer — the third in a row is the
 * provider's anonymous door being shut tonight, not three unlucky models. Only for the walk: the
 * record still judges each model on its own, so the one that does answer without a key climbs by
 * answering, and is asked first next time.
 */
export const KEY_REFUSALS = 3

/** Where the salt for {@link conversation} is kept, in core's own settings. */
const SALT = 'session.salt'

/**
 * **The id a sticky provider is sent for one conversation** ({@link Provider.stickySessions}): a
 * salted SHA-256 of the chat's number, cut to 32 characters. The provider can keep a conversation's
 * turns on one host and learns nothing from the id — not which conversation, not how many there
 * are. The salt is made once, on first use, and kept on this machine; without it the hash of *1*
 * would be the same for everybody who has ever opened a first chat.
 */
export function conversation(store: Store, session: number | undefined): string | undefined {
  if (session === undefined) return undefined
  const kept = store.kvGet(CORE, SALT)
  const salt = typeof kept === 'string' && kept !== '' ? kept : randomBytes(16).toString('hex')
  if (salt !== kept) store.kvSet(CORE, SALT, salt)
  return createHash('sha256').update(`${salt}:${String(session)}`).digest('hex').slice(0, 32)
}

/** `6 seconds`, `1 second` — never `0 seconds`, which reads as not having waited at all. */
const inSeconds = (ms: number): string => {
  const whole = Math.max(1, Math.round(ms / 1000))
  return `${String(whole)} second${whole === 1 ? '' : 's'}`
}

/**
 * **One rung while it is being asked** — what {@link send} keeps per model, now that two can be
 * out at once.
 */
interface Asking {
  /** Its place in the plan: the lower wins a tie, and a switch names only what stood ahead of it. */
  at: number
  choice: Choice
  /** What it is sent, already redacted, the same on every attempt. */
  messages: Message[]
  /**
   * - `running` — a request is out.
   * - `resting` — it said it was busy, and is asked again at `resume`.
   * - `done` — it has answered, and the answer is held until it is chosen.
   * - `failed` — it will not answer in this walk.
   * - `lost` — another was chosen while it was being asked. Not a failure: never recorded, never
   *   said, and asked again if the one chosen dies before it finishes.
   */
  stage: 'running' | 'resting' | 'done' | 'failed' | 'lost'
  /** Requests sent to it in this walk, from 1. */
  attempt: number
  /** When it was last launched — what a hedge behind it is measured from. */
  began: number
  resume?: number
  /** Its own stop: cancelling a rung that lost stops only that rung. */
  controller: AbortController
  /** Milliseconds from this attempt going out to its first sign of life, once there has been one. */
  waited?: number
  /** When that sign arrived, for which of two rungs showed one first. */
  signed?: number
  /** When its answer finished, for a rung that finished without a sign — an empty last answer. */
  finished?: number
  reasoned: boolean
  /** Its words not yet on screen, because it has not been chosen. */
  held: string[]
  chosen: boolean
  /** Whether any of its words reached the screen, so a failure now has to clear them (D155). */
  spoke: boolean
  /** Whether `thinking` has been said for it. */
  thought: boolean
  answer?: Awaited<ReturnType<typeof chat>>
  /** Its last busy reply while it is asked again: what is recorded, once, if the wait runs out. */
  busy?: Failure
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
 *
 * **While somebody is waiting, two can be asked at once.** Asked one at a time, a model that hung
 * cost {@link PATIENCE}'s thirty seconds and a gateway's keep-alives two minutes, with a working
 * model behind it the whole time. So a first model that has shown no sign of life after
 * {@link HEDGE_AFTER} has the next free one asked beside it, and a busy one is asked again in place
 * every second or so. Never more than two requests out; never a paid model beside another one,
 * because a cancelled paid request can still be billed. Each rung's words are held until it is
 * chosen: the plan's first model the moment it shows a sign of life, anything else once
 * {@link STAR_WAIT} has passed or the first has failed for good. The one chosen is streamed and
 * the others are cancelled — and a cancel is not a failure, so it is neither recorded nor said.
 *
 * **Only for a person.** The daily test (`trial.ts`) is evidence about one model, and a plugin on
 * its own clock has nobody watching a clock: both walk one rung at a time, as this always did.
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
     * **A switch, as an event** (§4 G). When given, the switch line goes here rather than to
     * `onNote`, so the screen can say it twice and keep it; without it, nothing changes.
     */
    onSwitch?: (event: Switch) => void
    /** **The line before a charge**, in a place of its own (§4 G). Without it, `onNote` has it. */
    onPaid?: (line: string) => void
    /** **What the walk is doing right now** ({@link Phase}), for the line under the question. */
    onPhase?: (phase: Phase) => void
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
    /** Who is asking, for the model record (D161). Absent is a plugin when `plugin` is set, else the chat. */
    source?: Source
    /**
     * **What time it is, for a caller that has its own clock.**
     *
     * Every try this walk makes is written to the record, and until this line it was stamped
     * `Date.now()` regardless of what the caller thought the time was — so a caller that
     * travels (the daily test, `trial.ts`, which takes a `now` and reasons in days) wrote
     * tries into *today* and then read them back as *tomorrow's*. That is not a test-only
     * seam: a record whose timestamps come from a different clock than the queries over it is
     * a record that disagrees with itself about a day boundary.
     *
     * Absent is the wall clock, which is every other caller and is what this always did.
     */
    at?: number
    /**
     * **The messages for one rung, when they depend on which model is asked** (§2).
     *
     * Called just before a rung is asked, never for one that is skipped, and its answer is sent
     * instead of `request.messages`. The personality's three lengths are why: the one a model
     * can hold is a fact about that model, so it is chosen here, per rung, rather than once for
     * a whole plan whose tail — a router, a 2B, this Mac's small model — would otherwise decide
     * what the strong model at its head is told. Absent is the same messages for every rung,
     * which is every other caller.
     */
    messagesFor?: (choice: Choice) => Message[]
    /**
     * **A rung is about to be asked** — called once, after every check that could skip it and
     * just before the request goes. Where a caller records what a rung was sent, it records it
     * here: `messagesFor` is asked before the money check, so a rung it dressed may still be skipped.
     */
    onAsk?: (choice: Choice) => void
    /**
     * **Dollars today's allowance has left** (D186), from the verdict's `left`. A paid rung whose
     * worst case — {@link dearest} — is more than this is not asked, and the walk goes on down
     * the plan to something cheaper or free. Absent is no check, which is every rung the allowance
     * does not govern.
     */
    left?: number
    /**
     * **The clock of a race, for a caller that cannot wait seconds for one** — a test. Absent is
     * {@link HEDGE_AFTER}, {@link STAR_WAIT} and {@link RETRY_STEP}, which is every real caller.
     */
    hedgeAfter?: number
    starWait?: number
    retryStep?: number
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
  /** Providers whose key was refused during this answer — or that wanted one too often ({@link KEY_REFUSALS}). */
  const refused = new Set<string>()
  /** The biggest window that has already proved too small for this conversation. */
  let outgrown: number | undefined
  /** What today's allowance still has for this answer (D186), less anything a rung here has already billed. */
  let left = hooks.left
  /** Whether a paid rung's worst case fits in that — asked of the request as the first rung was dressed. */
  const affords = (choice: Choice, messages: Message[] = request.messages): boolean =>
    !paid(choice.model.tier) || left === undefined || dearest(choice.model, messages, request) <= left
  /** Whether a rung is still worth asking, given what this answer has already ruled out. */
  const open = (choice: Choice): boolean =>
    !unpaid(choice) && !refused.has(choice.provider.id) && (outgrown === undefined || choice.model.context > outgrown)
  /**
   * **Every try is remembered on this machine** (D161), answers included: the record is what
   * sinks a model that just failed (D159) and what, over 30 days, sets one aside. What each
   * outcome counts for is read later — a refused key is kept and never held against the model.
   * A try the stop button or a plugin's cancel ended is not a try of the model, and is not kept;
   * nor is one cancelled because another rung was chosen.
   */
  const source: Source = hooks.source ?? (hooks.plugin !== undefined ? 'plugin' : 'chat')
  const record = (choice: Choice, outcome: Outcome, status: number, waited?: number): void => {
    store.recordTry({
      provider: choice.provider.id,
      model: choice.model.id,
      outcome,
      status,
      source,
      ...(hooks.at !== undefined && { at: hooks.at }),
      ...(waited !== undefined && { waited }),
    })
  }

  /** Whether somebody is waiting on this — the only walk that races and asks again (see above). */
  const racing = source !== 'test' && !onItsOwn
  const hedgeAfter = hooks.hedgeAfter ?? HEDGE_AFTER
  const starWait = hooks.starWait ?? STAR_WAIT
  const retryStep = hooks.retryStep ?? RETRY_STEP
  const began = Date.now()
  /**
   * **How long the first model is asked again while it says it is busy.** {@link STAR_WAIT}, and
   * twice that when the plan has nothing else in it — a pin, a list of one — where the only other
   * thing to do is stop. Measured from the start of the walk, not of the retries.
   */
  const deadline = began + (choices.filter((choice) => open(choice)).length === 1 ? 2 : 1) * starWait
  /** The conversation's id for a provider that keeps one conversation on one host; nobody else is sent it. */
  const session = choices.some((choice) => choice.provider.stickySessions === true) ? conversation(store, hooks.session) : undefined
  const phase = (now: Phase): void => hooks.onPhase?.(now)

  /** Where each failure stood in the plan: a switch names only what stood ahead of the answer. */
  const place = new Map<Failure, number>()
  /** Failures already told to the person, so none is said twice. */
  const told = new Set<Failure>()
  /** Failures of a rung that had been chosen — on screen already, so always said. */
  const shown = new Set<Failure>()
  /** Models each provider refused for want of a key in this walk, and providers that showed life. */
  const wantsKey = new Map<string, number>()
  const alive = new Set<string>()

  const runs: Asking[] = []
  /** The next rung of the plan not yet asked or skipped. */
  let next = 0
  /** The first rung asked: the plan's first model, whose priority {@link STAR_WAIT} is. */
  let star: Asking | undefined
  let winner: Asking | undefined
  /** A bug in core, or the stop button — thrown on, never walked past. */
  let fatal: { error: unknown } | undefined
  let halted: { error: unknown } | undefined
  /** The walk is over; anything a cancelled rung still says goes nowhere. */
  let closed = false
  let wake = (): void => undefined

  /**
   * **One line when the answer comes from somewhere else** (D155), said as a rung starts
   * answering rather than as it is asked: a switch announced before it has worked is a
   * promise, and on a rate-limited evening the next three might not keep it. It names what
   * stood ahead of the answer in the plan — a backup that failed behind the first model while
   * the first model answered is nobody's business.
   */
  const switched = (run: Asking): void => {
    const ahead = (failure: Failure): boolean => (place.get(failure) ?? -1) < run.at || shown.has(failure)
    const these = failures.filter((failure) => ahead(failure) && !told.has(failure)).sort((a, b) => (place.get(a) ?? 0) - (place.get(b) ?? 0))
    for (const failure of failures) if (ahead(failure)) told.add(failure)
    if (these.length === 0) return
    const says = `${reasons(these, 'could not answer')} — this answer is from ${run.choice.model.name}.`
    if (hooks.onSwitch !== undefined) {
      hooks.onSwitch({ from: these.map((one) => one.choice.model.name), to: run.choice.model.name, reasons: these.map((one) => one.says), says })
    } else {
      hooks.onNote?.(says)
    }
  }

  /** Words on screen: the chosen rung's, and the first of them are where its switch is said. */
  const deliver = (run: Asking, text: string): void => {
    if (!run.spoke) {
      switched(run)
      phase({ kind: 'writing', model: run.choice.model.name })
    }
    run.spoke = true
    hooks.onDelta?.(text)
  }

  // A daily test (§4 E) is evidence about a model, not somebody's spending: it goes to the
  // record and never into the ledger a person reads their costs from.
  const bill = (run: Asking): void => {
    const usage = run.answer?.usage ?? { in: 0, out: 0 }
    const cost = costOf(run.choice.model, usage)
    if (left !== undefined) left -= cost
    if (source !== 'test') store.recordUsage({
      session: hooks.session,
      plugin: hooks.plugin,
      run: hooks.run,
      model: run.choice.model.id,
      // Who was asked for, which is the plan's first rung whether or not it answered. The
      // two differ exactly when something fell back, and that is the cost worth explaining.
      asked: choices[0]?.model.id ?? run.choice.model.id,
      provider: run.choice.provider.id,
      tokensIn: usage.in,
      tokensOut: usage.out,
      cost,
    })
  }

  /** A rung that will not answer in this walk: kept, recorded, and what it rules out for the rest. */
  const fail = (run: Asking, failure: Failure, recorded = true): void => {
    failures.push(failure)
    place.set(failure, run.at)
    if (run.chosen) shown.add(failure)
    if (recorded) record(run.choice, failure.outcome, failure.status, run.waited)
    run.stage = 'failed'
    if (run.spoke) hooks.onRestart?.()
    if (winner === run) winner = undefined
    const provider = run.choice.provider.id
    if (failure.reach === 'provider') refused.add(provider)
    if (failure.reach === 'request') outgrown = Math.max(outgrown ?? 0, run.choice.model.context)
    if (failure.outcome === 'needs-key') {
      const count = (wantsKey.get(provider) ?? 0) + 1
      wantsKey.set(provider, count)
      if (count >= KEY_REFUSALS && !alive.has(provider)) refused.add(provider)
    }
  }

  /**
   * **Passed over, because another rung was chosen.** Cancelled, and not a failure of anybody's —
   * except the plan's first model, whose switch has to say why it was not the one: busy until the
   * wait ran out is its one try (recorded once, as busy), and merely not started is said and not
   * recorded, because it was never given its full patience.
   */
  const lose = (run: Asking): void => {
    run.controller.abort()
    if (run !== star) {
      run.stage = 'lost'
      return
    }
    if (run.busy !== undefined) return fail(run, run.busy)
    const says = `${run.choice.model.name} had not started answering after ${inSeconds(Date.now() - run.began)}`
    fail(run, { choice: run.choice, reach: 'model', status: 0, says, outcome: 'slow' }, false)
  }

  /** The rung whose words the person gets: its held words go out, and every other request is cancelled. */
  const crown = (run: Asking): void => {
    winner = run
    run.chosen = true
    for (const other of runs) if (other !== run && (other.stage === 'running' || other.stage === 'resting')) lose(other)
    if (run.reasoned && run.held.length === 0 && !run.thought) {
      run.thought = true
      phase({ kind: 'thinking', model: run.choice.model.name })
    }
    const held = run.held
    run.held = []
    for (const text of held) deliver(run, text)
  }

  /**
   * **Who is chosen, if anybody yet.** The first model the moment it shows a sign of life, and
   * alone while {@link STAR_WAIT} lasts and it is still being asked. After that, or once it has
   * failed for good, whichever rung showed a sign first — the lower in the plan on a tie.
   */
  const choose = (): void => {
    if (winner !== undefined) return
    if (star !== undefined && Date.now() < began + starWait && star.stage !== 'failed' && star.stage !== 'lost') {
      if (star.stage === 'done' || star.waited !== undefined) crown(star)
      return
    }
    const when = (run: Asking): number => run.signed ?? run.finished ?? Infinity
    let best: Asking | undefined
    for (const run of runs) {
      if (!(run.stage === 'done' || (run.stage === 'running' && run.signed !== undefined))) continue
      if (best === undefined || when(run) < when(best) || (when(run) === when(best) && run.at < best.at)) best = run
    }
    if (best !== undefined) crown(best)
  }

  /** Whether anything else in this walk could still answer — so an empty reply need not be the answer. */
  const hope = (except: Asking): boolean =>
    runs.some((run) => run !== except && (run.stage === 'running' || run.stage === 'resting' || run.stage === 'done' || (run.stage === 'lost' && open(run.choice)))) ||
    // A rung the allowance will skip is not one that could still answer.
    choices.slice(next).some((choice) => open(choice) && affords(choice))

  /** The pause before asking a busy first model again ({@link RETRY_STEP}): growing, and spread. */
  const pause = (attempt: number): number => retryStep * attempt * (0.75 + Math.random() / 2)

  /** When a busy first model is asked again, or `undefined` when it is not: only a host that is full right now, only while the wait lasts. */
  const again = (run: Asking, error: unknown): number | undefined => {
    if (!racing || run !== star || run.waited !== undefined) return undefined
    if (!(error instanceof ProviderError) || error.trouble !== 'contended') return undefined
    // A `retry-after` is the provider saying when; one past the wait says there is no point.
    const resume = Math.max(Date.now() + pause(run.attempt), error.heard?.retryAt ?? 0)
    return resume < deadline ? resume : undefined
  }

  const answered = (run: Asking, answer: Awaited<ReturnType<typeof chat>>): void => {
    const { message, cut, heard } = answer
    // What the provider said about its limits on this answer (§4 D).
    if (heard !== undefined) listen(store, run.choice, heard)
    run.answer = answer
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
      empty ? `${run.choice.model.name} answered with nothing`
      : cut && !paid(run.choice.model.tier) ? `${run.choice.model.name} ran out of room before finishing`
      : undefined
    const outcome: Outcome = short === undefined ? 'answered' : empty ? 'empty' : 'cut'
    if (short !== undefined && hope(run)) {
      /**
       * **A paid rung that answered with nothing was still billed for it** — a reasoning model
       * can spend two thousand tokens thinking and stream no words. Moving on without writing
       * that down left the day's allowance and the monthly cap short by exactly what it cost,
       * so the next paid rung was held to money that had already gone.
       */
      if (paid(run.choice.model.tier)) bill(run)
      return fail(run, { choice: run.choice, reach: 'model', status: 502, says: short, outcome })
    }
    // Recorded as it finishes, chosen or not: a backup that answered in full did answer.
    record(run.choice, outcome, short === undefined ? 200 : 502, run.waited)
    if (outcome === 'answered') alive.add(run.choice.provider.id)
    run.stage = 'done'
    run.finished = Date.now()
  }

  const fell = (run: Asking, error: unknown): void => {
    // The stop button: nobody is waiting, so it is nobody's failure and nobody else's turn.
    if (request.signal?.aborted === true) {
      halted ??= { error }
      return
    }
    // A refusal says the most about limits: *try again in 20 seconds* is on the 429 (§4 D).
    if (error instanceof ProviderError && error.heard !== undefined) listen(store, run.choice, error.heard)
    const failure = failed(error, run.choice)
    // A bug in core. Not somebody else's turn.
    if (failure === undefined) {
      fatal ??= { error }
      return
    }
    const resume = again(run, error)
    if (resume !== undefined) {
      run.stage = 'resting'
      run.resume = resume
      run.busy = failure
      return
    }
    fail(run, failure)
  }

  /** One request to one rung: a first ask, an ask again after a busy reply, or a rung that lost asked again. */
  const ask = (run: Asking, how: { retry?: boolean; behind?: Asking } = {}): void => {
    // Whoever was waiting has stopped: the stop button, or a plugin that gave up (D160). Asked
    // before each request as well as inside `chat()`, so a rung is not counted against its
    // provider for a request that is never going to be sent.
    request.signal?.throwIfAborted()
    run.attempt += 1
    run.stage = 'running'
    delete run.resume
    delete run.waited
    delete run.signed
    run.reasoned = false
    run.thought = false
    run.held = []
    run.controller = new AbortController()
    if (how.retry !== true) run.began = Date.now()
    const signal = request.signal === undefined ? run.controller.signal : AbortSignal.any([request.signal, run.controller.signal])
    const { choice } = run
    // Against the **free tier**, which is the only allowance this ledger knows about. A paid
    // request is billed to credit and spends none of it, and counting it here is how a key
    // with money behind it talked itself out of the pool halfway through a day. Every ask again
    // is a request of its own, and counted as one.
    if (!paid(choice.model.tier)) sent(store, choice.provider)
    const name = choice.model.name
    if (how.retry === true) {
      phase({ kind: 'retrying', model: name, attempt: run.attempt })
    } else {
      hooks.onAsk?.(choice)
      const behind = how.behind
      phase(
        behind === undefined ? { kind: 'asking', model: name }
        : { kind: 'backup', model: name, behind: behind.choice.model.name, why: behind.busy !== undefined ? 'busy' : 'slow' },
      )
    }
    const attempt = run.attempt
    /** Whether what this request says still matters: the walk goes on, and this is the rung's current request. */
    const current = (): boolean => !closed && run.attempt === attempt && run.stage === 'running'
    const settle = (then: () => void): void => {
      if (!current()) return
      try {
        then()
      } catch (error) {
        fatal ??= { error }
      }
      wake()
    }
    void chat(
      choice.provider,
      { ...request, messages: run.messages, model: choice.model.id, signal, ...(session !== undefined && { session }) },
      (text) => {
        if (!current()) return
        if (run.chosen) deliver(run, text)
        else run.held.push(text)
      },
      secrets,
      {
        onSign: (kind: Sign, waited: number) => {
          if (!current()) return
          if (run.waited === undefined) {
            run.waited = waited
            run.signed = Date.now()
          }
          alive.add(choice.provider.id)
          if (kind === 'reasoning') {
            run.reasoned = true
            if (run.chosen && !run.spoke && !run.thought) {
              run.thought = true
              phase({ kind: 'thinking', model: name })
            }
          }
          wake()
        },
      },
    ).then(
      (answer) => settle(() => answered(run, answer)),
      (error: unknown) => settle(() => fell(run, error)),
    )
  }

  /**
   * **The next rung to ask**, after every check that could skip it — or `undefined` when there is
   * none, or when the next is paid and `paidToo` is false: a paid rung is only ever asked alone,
   * so it waits its turn rather than being skipped. A rung that lost comes before anything new.
   */
  const pick = (paidToo: boolean): Asking | undefined => {
    request.signal?.throwIfAborted()
    const lost = runs.filter((run) => run.stage === 'lost' && open(run.choice)).sort((a, b) => a.at - b.at)[0]
    if (lost !== undefined) return lost
    for (; next < choices.length; next++) {
      const at = next
      const choice = choices[at]
      if (choice === undefined) continue
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
      if (paid(choice.model.tier) && !paidToo) return undefined
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
      // What this rung is sent — the same for every rung unless the caller dresses it per model (§2).
      const messages = hooks.messagesFor?.(choice) ?? request.messages
      /**
       * **The day's allowance is a limit, not a line crossed afterwards** (D186). Before a paid rung
       * is asked, the most it could bill — everything sent, and the whole reply ceiling — is held
       * to what today has left; one that could go past it is skipped as the cap skips it, and the
       * walk goes on to a cheaper rung or a free one. Nothing is said unless nothing answers.
       */
      if (left !== undefined && !affords(choice, messages)) {
        blocked = `${choice.model.name} could cost up to ${money(dearest(choice.model, messages, request))} for this and today's allowance has ${money(Math.max(0, left))} left — raise it under the paid switch on the Models tab, or wait for tomorrow`
        continue
      }
      next = at + 1
      // One plain line before the charge, not after it. Nobody is surprised by a bill from
      // something that did not say anything. It is also this rung's switch line, so the one
      // below stays quiet for it.
      if (paid(choice.model.tier)) {
        ;(hooks.onPaid ?? hooks.onNote)?.(
          at === 0 ?
            `Using ${choice.model.name}, which costs money — about $${choice.model.priceIn.toFixed(2)} per million words in.`
          : `The free models are used up, so this one goes to ${choice.model.name}, which costs money.`,
        )
        // Where the switch has a place of its own, it is still said: the charge line is the money,
        // the switch is the model (§4 G). Where it has not, the charge line was the switch line.
        if (hooks.onSwitch === undefined) for (const failure of failures) told.add(failure)
      }
      // `T0` means the model is on this machine (only `ollama.ts` ever writes it), so the
      // payload is not going anywhere and stripping it would cost accuracy to protect against
      // nothing. Everything else is a third party, free tiers most of all.
      const outbound = choice.model.tier === 'T0' ? { messages, kinds: [] } : redact(messages)
      if (outbound.kinds.length > 0) {
        // Enforcement that says so. Silently editing what somebody wrote is the same
        // surprise as a bill nobody announced.
        hooks.onNote?.(`Stripped before sending to ${choice.model.name}: ${summarise(outbound.kinds)}.`)
      }
      const run: Asking = {
        at,
        choice,
        messages: outbound.messages,
        stage: 'running',
        attempt: 0,
        began: Date.now(),
        controller: new AbortController(),
        reasoned: false,
        held: [],
        chosen: false,
        spoke: false,
        thought: false,
      }
      runs.push(run)
      star ??= run
      return run
    }
    return undefined
  }

  /**
   * **Ask whoever should be asked now.** Nothing out: the next rung, paid or free, as this always
   * did. One out, somebody waiting, no answer held, and no sign of life from it after
   * {@link HEDGE_AFTER}: the next free rung beside it — never a paid one, and never beside a paid one.
   */
  const fill = (): void => {
    if (winner !== undefined || runs.some((run) => run.stage === 'done')) return
    const out = runs.filter((run) => run.stage === 'running' || run.stage === 'resting')
    if (out.length === 0) {
      const run = pick(true)
      if (run !== undefined) ask(run)
      return
    }
    const [other] = out
    if (!racing || out.length > 1 || other === undefined || paid(other.choice.model.tier) || other.signed !== undefined) return
    if (Date.now() < other.began + hedgeAfter) return
    const run = pick(false)
    if (run !== undefined) ask(run, { behind: other })
  }

  /** Until something happens: a sign, an answer, a failure, the stop button — or the next moment the clock matters. */
  const rest = async (): Promise<void> => {
    const now = Date.now()
    const moments: number[] = []
    for (const run of runs) if (run.stage === 'resting' && run.resume !== undefined) moments.push(run.resume)
    if (winner === undefined) moments.push(began + starWait)
    const out = runs.filter((run) => run.stage === 'running' || run.stage === 'resting')
    const [only] = out
    if (racing && winner === undefined && out.length === 1 && only !== undefined && only.signed === undefined) moments.push(only.began + hedgeAfter)
    const soonest = Math.min(...moments.filter((moment) => moment > now))
    let timer: ReturnType<typeof setTimeout> | undefined
    await new Promise<void>((resolve) => {
      wake = resolve
      if (Number.isFinite(soonest)) timer = setTimeout(resolve, soonest - now)
    })
    clearTimeout(timer)
    wake = () => undefined
  }

  const finish = (run: Asking, answer: Awaited<ReturnType<typeof chat>>): Answer => {
    const { message, usage, cut } = answer
    if (!run.spoke) switched(run)
    bill(run)
    return {
      message,
      usage,
      cut,
      model: run.choice.model,
      provider: run.choice.provider,
      ...(run.choice.keyed !== undefined && { keyed: run.choice.keyed }),
    }
  }

  const woken = (): void => wake()
  request.signal?.addEventListener('abort', woken)
  try {
    for (;;) {
      if (halted !== undefined) throw halted.error
      request.signal?.throwIfAborted()
      if (fatal !== undefined) throw fatal.error
      const now = Date.now()
      for (const run of runs) if (run.stage === 'resting' && (run.resume ?? 0) <= now) ask(run, { retry: true })
      choose()
      if (winner?.stage === 'done' && winner.answer !== undefined) return finish(winner, winner.answer)
      fill()
      if (winner === undefined && !runs.some((run) => run.stage === 'running' || run.stage === 'resting' || run.stage === 'done')) break
      await rest()
    }
  } finally {
    closed = true
    request.signal?.removeEventListener('abort', woken)
    for (const run of runs) if (run.stage === 'running') run.controller.abort()
  }
  // In the plan's order, whatever order they failed in: two can be out at once.
  const all = [...failures].sort((a, b) => (place.get(a) ?? 0) - (place.get(b) ?? 0))
  const last = all.at(-1)
  if (last === undefined) throw new ProviderError(blocked === undefined ? 503 : 402, blocked ?? 'nothing was available to ask')
  const stop = new ProviderError(last.status, stopped(all, blocked))
  if (refused.size > 0) stop.refused = [...refused]
  if (failures.every((one) => one.outcome === 'unreachable')) stop.offline = true
  throw stop
}
