// SPDX-License-Identifier: AGPL-3.0-only
import type { Model } from './catalog.js'
import type { Rung } from './pool.js'
import type { Provider } from './provider.js'
import type { Try } from './store.js'

/**
 * **Whether a model is down right now, by its provider's own published status** — read before a
 * request is spent on it, never while somebody waits.
 *
 * OpenRouter publishes, for every model, each host serving it and how much of the last five
 * minutes, half hour and day that host answered. It needs no key and is not a chat request, so it
 * costs nobody's free requests; and a model every one of whose hosts is failing is a model worth
 * asking after the ones that are up. `qwen/qwen3.8-27b:free` has exactly one host, which is why a
 * single status line can say so much about it.
 *
 * **It adds nothing to the wait for an answer.** `world()` reads the set this holds as it stands,
 * and when that is older than {@link FRESH_FOR} starts a fresh read behind it that nobody awaits:
 * the answer being routed now uses what was known a minute ago, and the next one uses what was
 * found meanwhile. A read that fails, a host with no figure, a model with no hosts listed — all
 * are *not known to be down*, which changes nothing. Nothing here throws.
 *
 * **Only a GET, and only a model id in it.** No key, no words of anybody's; the same public page
 * anybody's browser can open.
 *
 * `status` on each host is not read: what its numbers mean is not published.
 */

/**
 * **Where a provider publishes each model's hosts**, relative to its row's `baseUrl`, with
 * `{model}` for the model's id — keyed by provider id. One provider publishes this today; the day a
 * second does, this belongs on its row in `PROVIDERS` like `usage` and `keyInfo`. Relative to the
 * row's own address, so a provider built by hand in a test is asked on its own fake server.
 */
export const STATUS: Readonly<Record<string, string>> = {
  openrouter: '/models/{model}/endpoints',
}

/**
 * **A host under this share of its last five minutes answered is down** — a percentage, which is
 * how the page gives it. Under half, the host fails more often than it answers.
 *
 * Measured on 22 September 2026: sixteen free OpenRouter models, every host between 89.8 and 100;
 * the worst host serving on `openai/gpt-oss-120b`'s list of twenty-four was at 79.8, and still
 * answered four requests in five. And Qwen 3.8 read 99.6 on a day it said *busy* over and over
 * here, so a full host's 429s seem not to count against the figure: it can say *down*, not
 * *busy*. Half is far enough under everything seen from a host that was serving that only a host
 * that has actually stopped reaches it.
 */
export const DOWN_BELOW = 50

/** **How long one read is trusted**: a minute. The figure is about the last five, and a question every few seconds would read the same page. */
export const FRESH_FOR = 60_000

/** **How long one model's page is waited for**: two seconds. It answered in 0.1–0.8s on 22 September; a page that takes longer tells nothing in time to matter. */
export const LOOK_FOR = 2_000

/**
 * **How many models one read looks at**: five. The ones asked first — a pinned model, then the
 * ones that answered here most lately — are the only ones whose status changes what happens next,
 * and five pages a minute is nothing to the provider.
 */
export const WATCHED = 5

/** One model on one provider whose status to read. */
export interface Watched {
  provider: Provider
  model: string
}

/**
 * **Which models to look at**: on a provider that is a rung now and publishes a status, the pinned
 * model if it is one of that provider's, then the ones that answered here most lately — at most
 * {@link WATCHED}, and only models still in the catalog, since no other is asked.
 */
export function watched(
  rungs: readonly Pick<Rung, 'provider'>[],
  models: readonly Pick<Model, 'provider' | 'id'>[],
  tries: readonly Pick<Try, 'provider' | 'model' | 'outcome' | 'at'>[],
  pin?: string,
): Watched[] {
  const publishing = new Map(rungs.filter((rung) => STATUS[rung.provider.id] !== undefined).map((rung) => [rung.provider.id, rung.provider]))
  if (publishing.size === 0) return []
  const listed = new Set(models.filter((one) => publishing.has(one.provider)).map((one) => `${one.provider}\n${one.id}`))
  const picked: Watched[] = []
  const taken = new Set<string>()
  const take = (provider: string, model: string): void => {
    const key = `${provider}\n${model}`
    const row = publishing.get(provider)
    if (row === undefined || !listed.has(key) || taken.has(key) || picked.length >= WATCHED) return
    taken.add(key)
    picked.push({ provider: row, model })
  }
  if (pin !== undefined) for (const provider of publishing.keys()) take(provider, pin)
  const answered = tries.filter((one) => one.outcome === 'answered').sort((a, b) => b.at - a.at)
  for (const one of answered) take(one.provider, one.model)
  return picked
}

/** What one model's page says: every host down, at least one up, or nothing to go on. */
export type Reading = 'down' | 'up' | 'unknown'

/**
 * **Read one endpoints page** (`{ data: { endpoints: [{ uptime_last_5m, … }] } }`). Down only when
 * it lists at least one host and every host has a figure under {@link DOWN_BELOW}; a host without a
 * figure may be the one that is fine, so it makes the page unknown rather than down.
 */
export function reading(body: unknown): Reading {
  const hosts = (body as { data?: { endpoints?: unknown } } | null)?.data?.endpoints
  if (!Array.isArray(hosts) || hosts.length === 0) return 'unknown'
  const figures = hosts.map((host) => (host as { uptime_last_5m?: unknown } | null)?.uptime_last_5m)
  if (figures.some((figure) => typeof figure === 'number' && figure >= DOWN_BELOW)) return 'up'
  return figures.every((figure) => typeof figure === 'number' && Number.isFinite(figure)) ? 'down' : 'unknown'
}

/** One model's page, read; anything that goes wrong is `unknown`. */
async function look(one: Watched, fetcher: typeof fetch): Promise<Reading> {
  const path = STATUS[one.provider.id]
  if (path === undefined) return 'unknown'
  try {
    const id = one.model.split('/').map(encodeURIComponent).join('/')
    const response = await fetcher(`${one.provider.baseUrl}${path.replace('{model}', id)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(LOOK_FOR),
    })
    return response.ok ? reading(await response.json()) : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * **The last read, and the next one started behind it** — see the top of this file. One per
 * running core; `fetch` and the clock are handed in so a test can be the provider and the minute.
 */
export class Uptime {
  readonly #fetch: typeof fetch
  readonly #now: () => number
  #down: ReadonlySet<string> = new Set()
  /** When the set was last read. Never, to start with, so the first ask starts a read. */
  #at = Number.NEGATIVE_INFINITY
  #reading: Promise<void> | undefined

  constructor(options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? Date.now
  }

  /**
   * **The models known to be down**, keyed `provider\nmodel`, as last read — at once, never waited
   * for. When that read is older than {@link FRESH_FOR} and none is running, `watch` is asked which
   * models to look at and a fresh read starts, for the next caller to find.
   */
  down(watch: () => readonly Watched[]): ReadonlySet<string> {
    if (this.#reading === undefined && this.#now() - this.#at >= FRESH_FOR) {
      const wanted = watch().slice(0, WATCHED)
      if (wanted.length > 0) {
        this.#reading = this.#read(wanted)
          .catch(() => undefined)
          .finally(() => (this.#reading = undefined))
      }
    }
    return this.#down
  }

  /** The read in flight, for a test or a shutdown to wait on; resolved at once when there is none. */
  settled(): Promise<void> {
    return this.#reading ?? Promise.resolve()
  }

  async #read(wanted: readonly Watched[]): Promise<void> {
    const found = await Promise.all(
      wanted.map(async (one) => ((await look(one, this.#fetch)) === 'down' ? `${one.provider.id}\n${one.model}` : undefined)),
    )
    this.#down = new Set(found.filter((key) => key !== undefined))
    this.#at = this.#now()
  }
}
