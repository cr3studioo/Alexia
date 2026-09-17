// SPDX-License-Identifier: AGPL-3.0-only
import { CORE, type SecretStore } from './secrets.js'
import { underHalf } from './pool.js'
import { paid, send, type Choice, type World } from './router.js'
import { SPANS, type Store, type Try } from './store.js'

/**
 * **The daily test message** (D161, `model_plan.md` §4 E).
 *
 * Automatic walks from its first choice and stops at the first answer, so evidence only ever
 * arrives from the top: a new model starts at the bottom and is never asked, and a model Alexia
 * has set aside is never asked again. One tiny test a day is how either earns a reply — the first
 * good reply moves a new model up, and brings a set-aside one back.
 *
 * **What is sent is never the person's.** *Reply with the single word OK.* No conversation, no
 * personality, no words of anybody's, and any reply with text in it is a good reply. It goes only
 * to free models, only while the app runs, never while an answer is on its way, at most
 * {@link TESTS_A_DAY} a day and one per model, and it lands in the model record as a `test` —
 * never in a conversation and never in the spend ledger.
 *
 * *Still open* (`model_plan.md`, Open decisions): whether each free tier's terms allow a daily
 * automated test, which is to be checked before a public release.
 */

/** Exactly this, and nothing else, ever goes out in a test. */
export const TEST_MESSAGE = 'Reply with the single word OK.'

/** At most this many a day, in all: a handful of requests on somebody's free tier, not a crawl. */
export const TESTS_A_DAY = 10

/** Room to answer one word, and to think a little first — most free models are reasoning models. */
const TEST_ROOM = 256

/** What has been tested today, kept under a key for the UTC day, so a restart does not test twice. */
interface Tested {
  day: number
  models: string[]
}

const TESTED = 'tests.today'

/**
 * Which models are due a test, oldest evidence first: free, reachable, and either new and not yet
 * tried or set aside — except a model set aside for wanting a key while no key is saved, which a
 * test would only refuse again. A model gone from its list is not in the catalog to be asked.
 */
export function due(world: World, tries: readonly Try[]): Choice[] {
  const rungs = new Map(world.rungs.map((rung) => [rung.provider.id, rung]))
  const lastTry = new Map<string, number>()
  for (const one of tries) lastTry.set(`${one.provider}\n${one.model}`, one.at)
  return world.models
    .flatMap((model): Choice[] => {
      const rung = rungs.get(model.provider)
      if (rung === undefined || paid(model.tier)) return []
      // A test is the lowest claim on free requests (§4 F): never from the half of a day kept for the chat.
      if (!underHalf(rung)) return []
      const judged = world.health?.get(`${model.provider}\n${model.id}`)
      if (judged === undefined) return []
      const aside = judged.aside !== undefined && !(judged.aside === 'needs a key' && rung.keyed !== true)
      if (!judged.untested && !aside) return []
      return [{ model, provider: rung.provider, ...(rung.keyed !== undefined && { keyed: rung.keyed }) }]
    })
    .sort(
      (a, b) =>
        (lastTry.get(`${a.provider.id}\n${a.model.id}`) ?? 0) - (lastTry.get(`${b.provider.id}\n${b.model.id}`) ?? 0),
    )
}

/**
 * Send today's tests, one at a time, until the day's budget or the due list runs out — or an answer
 * starts streaming, which stops the round where it is. Returns how many went out.
 */
export async function trial(options: {
  world: World
  store: Store
  secrets: SecretStore
  /** Whether somebody is waiting on an answer right now. Asked before every test. */
  busy: () => boolean
  now?: number
}): Promise<number> {
  const { world, store, secrets, busy } = options
  const now = options.now ?? Date.now()
  const today = SPANS[1][1](now)
  const saved = store.kvGet(CORE, TESTED) as Tested | undefined
  const tested: Tested = saved?.day === today ? saved : { day: today, models: [] }
  let sent = 0
  for (const choice of due(world, store.tries(now))) {
    if (tested.models.length >= TESTS_A_DAY || busy()) break
    const key = `${choice.provider.id}\n${choice.model.id}`
    if (tested.models.includes(key)) continue
    tested.models.push(key)
    // Written before it goes, so a crash mid-test does not spend the same model twice in a day.
    store.kvSet(CORE, TESTED, tested)
    sent += 1
    await send([choice], { messages: [{ role: 'user', content: TEST_MESSAGE }], maxTokens: TEST_ROOM }, store, secrets, {
      source: 'test',
    }).catch(() => undefined)
  }
  return sent
}
