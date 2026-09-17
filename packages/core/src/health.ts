// SPDX-License-Identifier: AGPL-3.0-only
import { PLANNER, routes, stature, type Model } from './catalog.js'
import { TRIES_KEPT, type Outcome, type Seen, type Try } from './store.js'

/**
 * **What Alexia thinks of each model** (D161), from what happened to it on this machine.
 *
 * One function, two readers — the router, which leaves a set-aside model out of a plan and puts
 * a new or doubted one at the bottom of its group, and the Models table, which draws the same
 * tags as chips. The D154 rule: when the table and the router read two functions, the table ends
 * up describing a router that is not there.
 *
 * **Busy is not broken.** Most free failures are an evening's per-minute limits, and a model
 * that was busy an hour ago only sinks (D159's strikes). What sets a model aside is a shape that
 * no rush makes: a whole day of nothing but refusals, three empty answers, *no longer offered*
 * twice, or a keyless provider refusing two of its models for want of a key.
 *
 * **Set aside is never deleted, and one good reply brings a model back.** Everything below is
 * read from the tries since a model's last good reply, so the reply is the reset. Until §4 E's
 * daily test exists, a set-aside model gets that chance only from a pin, a list whose every
 * entry is set aside, an Automatic plan with nothing else in it, or its record ageing out.
 *
 * **A wrong answer is not seen here.** A script sees errors, timeouts and empty answers and
 * cannot tell a right answer from a wrong one; that takes a person pressing *Bad answer* (§4 I).
 *
 * Every number is a named constant beside the reason for it.
 */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/**
 * **How long a model is new**: long enough for OpenRouter's weekly usage figure to cover a whole
 * week of it, which is what places a model once it has answered here.
 */
export const NEW_FOR = 14 * DAY

/** **How long a rate limit makes a model busy.** The same hour D159's strikes halve in. */
export const BUSY_FOR = HOUR

/**
 * **A day-long wall**: at least 3 tries spread over at least 2 hours, all inside one day, none
 * answered. A rush comes in minutes, so three refusals in ten minutes is an evening, not a
 * model. And D159's half-life retries a sinking model about every 90 minutes, so a model that
 * refuses a whole day reaches three spread tries on its own. On this Mac, OVHcloud refused 8 of
 * 8 on 14 September and 2 of 2 on the 15th.
 */
export const WALL = { tries: 3, spread: 2 * HOUR, within: DAY } as const

/**
 * **Empty three times with no good reply between.** A classifier or an image model answers empty
 * every time; one empty answer can be a hiccup.
 */
export const EMPTIES = 3

/** ***No longer offered* twice with no good reply between.** One 404 can be a provider mid-deploy. */
export const GONE = 2

/**
 * **Refused for want of a key**: twice for one model, or once each for two models of the same
 * provider. One model wanting a key is that model (LLM7 answered four of six without one, D158);
 * two means the provider changed (LLM7 on 15 September: two models, two refusals).
 */
export const KEYLESS = { refusals: 2, models: 2 } as const

/** **Said before it happens**: a published retirement date inside this window is a tag. */
export const RETIRING_WITHIN = 30 * DAY

/**
 * **Too many errors**: at least 5 tries in 30 days, and at least half of them failed — busy
 * not counted. Under five the share is luck; at half, every other answer is a switch.
 */
export const DOUBT = { tries: 5, share: 0.5 } as const

/** **Gave bad answers**: two presses in 30 days. One can be the question's fault. */
export const BAD_PRESSES = 2

/** How a tag is drawn: a fact, something to keep an eye on, or a reason it is set aside. */
export type Tone = 'quiet' | 'caution' | 'danger'

export interface Tag {
  says: string
  tone: Tone
}

/** Why a model is set aside, in the words of its tag. */
export type Aside = 'needs a key' | 'retired' | 'answers empty' | 'always busy for you' | 'not answering'

export interface Judgement {
  /** Everything worth a chip, reasons and facts alike, in the order a row shows them. */
  tags: Tag[]
  /** Set aside, and why: Automatic and a list skip it while anything else is left (D161). */
  aside?: Aside
  /** New, and has not answered here yet: the bottom of its group. */
  untested: boolean
  /** Too many errors, or bad answers: below every model in its group without doubts. */
  doubted: boolean
  /**
   * **A usage figure to rank by until a real one arrives**: the middle of models its size, for a
   * new model that has answered once and has no `weekly` of its own or lent. The owner's rule —
   * the first good reply moves it higher, then OpenRouter's figure places it, up or down.
   */
  standIn?: number
}

/** Keyed `provider\nmodel`, like everything else that is about one model on one provider. */
export type Health = ReadonlyMap<string, Judgement>

/** The failures that count against a model's share of errors. Busy is not one of them (D161). */
const ERRORS: ReadonlySet<Outcome> = new Set<Outcome>(['failed', 'slow', 'empty', 'cut', 'retired'])

/**
 * What a day-long wall is built from: refusals, timeouts, dropped streams and errors. Not a
 * connection that could not be made — that is as likely this Mac being offline as the model,
 * and Automatic walks its whole plan on every question, so an evening without a network would
 * set aside every model it tried (D162).
 */
const WALLED: ReadonlySet<Outcome> = new Set<Outcome>(['busy', 'slow', 'failed'])

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (at: number): string => `${String(new Date(at).getUTCDate())} ${MONTHS[new Date(at).getUTCMonth()] ?? ''}`

/**
 * The latest run of tries inside one day that is long and spread enough to be a wall, or nothing.
 * `tries` is oldest first and holds only what a wall is built from.
 */
function wall(tries: readonly Try[]): readonly Try[] | undefined {
  let found: readonly Try[] | undefined
  let start = 0
  for (let end = 0; end < tries.length; end++) {
    const last = tries[end]!
    while (last.at - tries[start]!.at > WALL.within) start++
    if (end - start + 1 >= WALL.tries && last.at - tries[start]!.at >= WALL.spread) found = tries.slice(start, end + 1)
  }
  return found
}

/**
 * Judge every model in `models` on the record (`tries`, oldest first), what this machine has seen
 * of each provider's list, and which providers have a key saved (`keyed`).
 */
export function judge(
  tries: readonly Try[],
  seen: readonly Seen[],
  models: readonly Model[],
  keyed: ReadonlySet<string>,
  now: number = Date.now(),
  /** `retry-after`s still running, keyed `provider\nmodel` (§4 D): busy until then. */
  waits: ReadonlyMap<string, number> = new Map(),
): Health {
  const kept = tries.filter((one) => one.at <= now && now - one.at <= TRIES_KEPT)
  const record = new Map<string, Try[]>()
  /** Per keyless provider: each model it refused for want of a key, and when it last did. */
  const refused = new Map<string, Map<string, number>>()
  for (const one of kept) {
    const key = `${one.provider}\n${one.model}`
    const mine = record.get(key)
    if (mine === undefined) record.set(key, [one])
    else mine.push(one)
    if (one.outcome === 'needs-key') {
      const models = refused.get(one.provider) ?? new Map<string, number>()
      models.set(one.model, Math.max(models.get(one.model) ?? 0, one.at))
      refused.set(one.provider, models)
    }
  }
  const lists = new Map(seen.map((row) => [`${row.provider}\n${row.model}`, row]))

  /** The median own `weekly` of the models in each size class, worked out once when first asked. */
  const middles = new Map<ReturnType<typeof stature>, number | undefined>()
  const middle = (model: Model): number | undefined => {
    const size = stature(model)
    if (!middles.has(size)) {
      // A row's own figure only, so a model lent to three providers is counted once; never a router's.
      const figures = models
        .filter((one) => one.weekly !== undefined && one.weeklyFrom === undefined && !routes(one) && stature(one) === size)
        .map((one) => one.weekly!)
        .sort((a, b) => a - b)
      const half = Math.floor(figures.length / 2)
      middles.set(
        size,
        figures.length === 0 ? undefined
        : figures.length % 2 === 1 ? figures[half]
        : (figures[half - 1]! + figures[half]!) / 2,
      )
    }
    return middles.get(size)
  }

  const health = new Map<string, Judgement>()
  for (const model of models) {
    const key = `${model.provider}\n${model.id}`
    const mine = record.get(key) ?? []
    const lastGood = mine.findLastIndex((one) => one.outcome === 'answered')
    const answeredAt = lastGood === -1 ? undefined : mine[lastGood]!.at
    /** Everything since the last good reply: the reply is what brings a model back. */
    const since = mine.slice(lastGood + 1)
    const count = (outcome: Outcome): number => since.filter((one) => one.outcome === outcome).length

    const listed = lists.get(key)
    const newish =
      (listed !== undefined && listed.listKnown && now - listed.firstSeen < NEW_FOR) ||
      (model.created !== undefined && now - model.created < NEW_FOR)
    const untested = newish && answeredAt === undefined
    const standIn = newish && answeredAt !== undefined && model.weekly === undefined ? middle(model) : undefined

    const reasons: Aside[] = []
    if (!keyed.has(model.provider)) {
      const byProvider = refused.get(model.provider)
      const latest = byProvider !== undefined && byProvider.size >= KEYLESS.models ? Math.max(...byProvider.values()) : undefined
      if (count('needs-key') >= KEYLESS.refusals || (latest !== undefined && (answeredAt === undefined || answeredAt < latest))) {
        reasons.push('needs a key')
      }
    }
    if (count('retired') >= GONE || listed?.goneAt !== undefined || (model.expires !== undefined && now >= model.expires)) {
      reasons.push('retired')
    }
    if (count('empty') >= EMPTIES) reasons.push('answers empty')
    const walled = wall(since.filter((one) => WALLED.has(one.outcome)))
    if (walled !== undefined) reasons.push(walled.every((one) => one.outcome === 'busy') ? 'always busy for you' : 'not answering')

    const judged = mine.filter((one) => one.outcome === 'answered' || ERRORS.has(one.outcome))
    const errors = judged.length >= DOUBT.tries && judged.filter((one) => one.outcome !== 'answered').length >= judged.length * DOUBT.share
    const bad = mine.filter((one) => one.outcome === 'bad-answer').length >= BAD_PRESSES
    const busy =
      reasons.length === 0 &&
      (since.some((one) => one.outcome === 'busy' && now - one.at < BUSY_FOR) || (waits.get(key) ?? 0) > now)
    const retiring = model.expires !== undefined && now < model.expires && model.expires - now <= RETIRING_WITHIN

    const tags: Tag[] = [
      ...(untested ? [{ says: 'new · not tried yet', tone: 'caution' as const }] : []),
      ...reasons.map((says) => ({ says, tone: 'danger' as const })),
      ...(busy ? [{ says: 'busy', tone: 'caution' as const }] : []),
      ...(errors ? [{ says: 'too many errors', tone: 'caution' as const }] : []),
      ...(bad ? [{ says: 'gave bad answers', tone: 'caution' as const }] : []),
      ...(retiring ? [{ says: `retiring ${day(model.expires!)}`, tone: 'caution' as const }] : []),
      // Facts, so nobody has to open the detail for them. They do nothing the ranking does not.
      ...(routes(model) ? [{ says: 'router', tone: 'quiet' as const }] : []),
      ...(stature(model) === 'small' ? [{ says: `under ${String(PLANNER)}B`, tone: 'quiet' as const }] : []),
      ...(!model.supportsTools ? [{ says: 'talk only', tone: 'quiet' as const }] : []),
      ...(model.trainsOnYourData === 'yes' ? [{ says: 'keeps your words', tone: 'quiet' as const }] : []),
    ]
    health.set(key, {
      tags,
      ...(reasons[0] !== undefined && { aside: reasons[0] }),
      untested,
      doubted: errors || bad,
      ...(standIn !== undefined && { standIn }),
    })
  }
  return health
}
