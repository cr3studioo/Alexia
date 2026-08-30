// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { reaching, type Provider } from './provider.js'

/**
 * What models exist, what they cost, and what they do with what you send them.
 *
 * Fetched from a provider's own list, cached to disk, and diffed — so a new free model is
 * news rather than something you would only find by reading a changelog. It works offline
 * from the cache, and it does not break the day the endpoint changes shape: an entry that
 * makes no sense is skipped, not fatal.
 */

/** Three answers, and "unknown" is one of them. A flag that guesses is worse than no flag. */
export type Honestly = 'yes' | 'no' | 'unknown'

export interface Model {
  id: string
  name: string
  /** The provider row that serves it — what the router needs, not who trained it. */
  provider: string
  /** T0 local · T1 free hosted · T2 small paid · T3 frontier (Alexia.md, *The tiers*). */
  tier: 'T0' | 'T1' | 'T2' | 'T3'
  /** US dollars per million tokens, in and out. Zero is zero, and that is the free tier. */
  priceIn: number
  priceOut: number
  context: number
  supportsTools: boolean
  /** What it can be given: `text`, `image`, `audio`. */
  modality: string[]
  nsfwOk: Honestly
  trainsOnYourData: Honestly
  /**
   * Billions of parameters, when the runner says. Only local models report it, and it is
   * here because G5 needed an axis that `tier` does not have: every model on this machine
   * is `T0` whether it is 1B or 8B, and exactly one of those can plan (D62).
   */
  params?: number
  /**
   * Tokens through this model **everywhere**, over the provider's last published week.
   *
   * Not this machine's usage — the world's, which is the only version of this number that
   * says anything you did not already know. It is the closest thing to a review a model has:
   * a free model nobody sends anything to is a free model with a reason nobody wrote down.
   *
   * Absent rather than zero when the provider does not publish it, which is all of them but
   * one. Zero would sort as *unused* and read as *bad*, and neither is what silence means.
   */
  weekly?: number
}

export interface Snapshot {
  fetchedAt: number
  models: Model[]
  /**
   * What version of {@link parse} wrote these rows.
   *
   * A cache is only as good as the reader that filled it, and this one gains fields: the day
   * `weekly` was added, every model on every existing machine had a perfectly fresh snapshot
   * with no such field in it, and the per-provider clock would have honoured that for a day —
   * or indefinitely on a machine that is rarely open long enough to poll. So a snapshot
   * written by an older parser is stale by definition, whatever its timestamp says.
   *
   * The models are kept and only the clocks are dropped, so the screen shows the old list
   * until the new one lands rather than going empty while somebody is looking at it.
   */
  parsedBy?: number
  /**
   * When each provider's list was last fetched, by provider id.
   *
   * One clock per provider, because there used to be one for all of them: `refresh` compared
   * `fetchedAt` against `maxAge` and returned early, so the *second* provider asked in a day
   * was told its list was fresh when nothing had ever fetched it. With one provider polled at
   * startup that was invisible. It stops being invisible the moment a screen offers a choice
   * between providers, which is what the Models tab is.
   *
   * Optional because a cache written before this existed has no such map, and a provider
   * missing from it reads as never fetched — which is what it is.
   */
  at?: Record<string, number>
}

/** What changed since the last fetch. The news line is built from this, and so is the UI. */
export interface Change {
  added: Model[]
  removed: Model[]
  /** The fetch did not happen: offline, or the provider is having a bad day. Not an error. */
  failed?: string
}

const DAY = 24 * 60 * 60 * 1000

/**
 * Where the line between "small paid" and "frontier" falls, in dollars per million input
 * tokens. A knob rather than a constant on purpose: the number that separates the two moves
 * every few months, and it moves by being edited here.
 */
const FRONTIER_USD_PER_MTOK = 1

/**
 * Bumped whenever {@link parse} learns to read a field it used to drop — at 3 and again at 4
 * to drop a row it used to keep, and at 5 to read a second list shape. Both change what a cached snapshot means, and a cache is only as good
 * as the reader that filled it: every machine already holds five negative-priced rows that
 * out-sort the free tier, and they leave on the next poll rather than on the next reinstall.
 *
 * Exported for the tests, which stamp their fixture caches with it. That is not a courtesy:
 * a snapshot they hand `serve()` is the only thing standing between the suite and seven real
 * providers, and a stamp they cannot see the value of is a barrier that quietly falls over
 * the next time this number changes.
 */
export const PARSER = 5

/**
 * **The keyless floor's models, written down rather than fetched.**
 *
 * Everything else in this file discovers what exists. These four rows cannot be discovered
 * correctly, each for its own reason, and they are the rows the whole promise rests on — a
 * conversation on a machine with nothing in its keychain runs on these.
 *
 * - **OVHcloud** publishes one list containing speech, image and embedding models beside the
 *   chat ones, priced at what a *keyed* account pays. Fetched literally, the free floor
 *   arrives tiered as paid. These five are the chat models, priced as the anonymous tier
 *   actually is.
 * - **Tool calling is the reason this matters most.** Nobody but OpenRouter publishes a
 *   `supported_parameters` list, so a discovered row reads `supportsTools: false` and the
 *   agent loop has no hands left once the keyed tiers are gone. `gpt-oss-120b` was probed
 *   from this machine with **no Authorization header at all** on 2026-08-30 and returned a
 *   structured `tool_calls` response. That single fact is what keeps Alexia able to *do*
 *   things rather than only talk about them, all the way down to the no-key floor.
 * - **AI Horde** discovers its roster live from whichever volunteers are awake, and publishes
 *   no window. The three its catalogue names are 32k; the rest arrive saying nothing, which
 *   the router reads as *unknown* rather than as *small*.
 *
 * A seeded row wins over a fetched one of the same id: it was confirmed by hand, and the
 * fetched version's silence about tools and windows is exactly what it exists to fix.
 */
export const SEEDED: readonly Model[] = [
  // Source: models_plan.md §6.2 "Models:" · ids and windows read from the provider's own
  // list, tool support probed keyless, both 2026-08-30.
  ...(
    [
      ['gpt-oss-120b', 'GPT-OSS 120B', 131_072, true],
      ['Meta-Llama-3_3-70B-Instruct', 'Llama 3.3 70B Instruct', 131_072, true],
      ['gpt-oss-20b', 'GPT-OSS 20B', 131_072, false],
      ['Qwen3.6-27B', 'Qwen3.6 27B', 131_072, false],
      ['Mistral-Small-3.2-24B-Instruct-2506', 'Mistral Small 3.2 24B', 131_072, false],
      ['Qwen2.5-VL-72B-Instruct', 'Qwen2.5 VL 72B', 32_768, false],
    ] as const
  ).map(([id, name, context, supportsTools]) => ({
    id,
    name,
    provider: 'ovhcloud',
    tier: 'T1' as const,
    priceIn: 0,
    priceOut: 0,
    context,
    supportsTools,
    // The vision model takes images; §6.2 names it as the one that does.
    modality: id.includes('VL') ? ['text', 'image'] : ['text'],
    nsfwOk: 'unknown' as const,
    trainsOnYourData: 'unknown' as const,
  })),
  // Source: models_plan.md §6.2 — "Cydonia 24B, Skyfall 31B, Gemma 4 31B (all 32k context,
  // no tools)". Ids read from the live roster 2026-08-30; the provider row's `tools: false`
  // is what covers the workers that are not on this list.
  ...(
    [
      ['aphrodite/TheDrummer/Cydonia-24B-v4.3', 'Cydonia 24B'],
      ['aphrodite/TheDrummer/Skyfall-31B-v4.2', 'Skyfall 31B'],
      ['koboldcpp/gemma-4-31B-it-heretic', 'Gemma 4 31B'],
    ] as const
  ).map(([id, name]) => ({
    id,
    name,
    provider: 'aihorde',
    tier: 'T1' as const,
    priceIn: 0,
    priceOut: 0,
    context: 32_768,
    supportsTools: false,
    modality: ['text'],
    nsfwOk: 'unknown' as const,
    trainsOnYourData: 'unknown' as const,
  })),
  /**
   * Source: models_plan.md §6.6 "NaraRouter" — probed on a zero-balance account 2026-07-09,
   * when these three were the only ids that answered and the rest of the published list was
   * credit- or plan-gated. **Three, and no fetch**, because a gated model that arrives
   * looking free is worse than a short list.
   */
  ...(
    [
      ['mistral-large', 'Mistral Large', 0, true],
      ['mistral-medium-3-5', 'Mistral Medium 3.5', 0, true],
      // A million-token window, which is the largest thing anywhere in this table.
      ['tencent-hy3', 'Tencent HY3', 1_000_000, false],
    ] as const
  ).map(([id, name, context, supportsTools]) => ({
    id,
    name,
    provider: 'nara',
    tier: 'T1' as const,
    priceIn: 0,
    priceOut: 0,
    context,
    supportsTools,
    modality: ['text'],
    nsfwOk: 'unknown' as const,
    trainsOnYourData: 'unknown' as const,
  })),
  /**
   * Source: models_plan.md §6.6 "Cloudflare Workers AI" — the one live id the document names.
   *
   * **Four catalogued ids are dead** and return 400, 403 or 410: `llama-3.3-70b-instruct`,
   * `llama-3.1-8b-instruct`, `gemma-3-12b-it` and `qwen2.5-coder-15b-instruct`. They are not
   * here, and a test says so, because a dead row in a seed list is a rung that fails at the
   * moment somebody needs it rather than at the moment somebody could have noticed.
   */
  {
    id: '@cf/zai-org/glm-4.7-flash',
    name: 'GLM 4.7 Flash',
    provider: 'cloudflare-ai',
    tier: 'T1',
    priceIn: 0,
    priceOut: 0,
    context: 0,
    supportsTools: false,
    modality: ['text'],
    nsfwOk: 'unknown',
    trainsOnYourData: 'unknown',
  },
]

export class Catalog {
  #snapshot: Snapshot

  /** `file` is `<cacheDir>/models.json`. Missing, empty or corrupt all mean the same thing. */
  constructor(private readonly file: string) {
    const found = read(file) ?? { fetchedAt: 0, models: [] }
    // Written by a parser that did not know about a field this one reads: keep the rows,
    // drop every clock, so the next poll is a real fetch rather than a shrug.
    this.#snapshot = found.parsedBy === PARSER ? found : { ...found, fetchedAt: 0, at: undefined }
  }

  /**
   * Every model the router may choose from: what was fetched, plus the written-down floor.
   *
   * **The seed wins on a clash.** Both halves describe the same model when they overlap, and
   * the seeded half is the one somebody confirmed by hand — a fetched row's silence about
   * tools and windows is the thing it exists to correct, so letting the fetch overwrite it
   * would undo the fix on the first successful poll.
   */
  get models(): readonly Model[] {
    const written = new Set(SEEDED.map((m) => m.id))
    return [...SEEDED, ...this.#snapshot.models.filter((m) => !written.has(m.id))]
  }

  /**
   * What the last poll actually produced, without the written-down floor mixed in.
   *
   * The two are different questions. {@link models} is *what may be chosen*, which includes
   * rows no fetch will ever return; this is *what the endpoints said*, which is what caching,
   * staleness and parsing are all about.
   */
  get fetched(): readonly Model[] {
    return this.#snapshot.models
  }

  /** When the list was last actually fetched. Zero means never, and the UI can say so. */
  get fetchedAt(): number {
    return this.#snapshot.fetchedAt
  }

  /**
   * When this provider's list was last fetched. Zero means never, and the screen says so.
   *
   * A cache written before `at` existed has one timestamp for the whole file, so that is
   * what every provider reads until the next write puts a real map there. It expires within
   * the day like any other, so the upgrade costs at most one stale day and then heals — and
   * it beats the alternative, which is treating a working cache as empty and fetching seven
   * lists the moment somebody installs a new build.
   *
   * The fallback is on `at` being **absent**, never on a provider being missing from it. Once
   * the map exists, a provider not in it has genuinely never been fetched — reading the
   * file's own timestamp there would revive the single clock this replaced, because the
   * first write moves `fetchedAt` to now for everybody.
   */
  fetchedFrom(provider: string): number {
    const { at, fetchedAt } = this.#snapshot
    return at === undefined ? fetchedAt : (at[provider] ?? 0)
  }

  /**
   * Fetch, unless what is cached is younger than `maxAge` — which is the daily poll, minus
   * a timer nothing owns yet. The app loop calls this on a schedule from M1-10.
   *
   * A fetch that fails leaves the cache exactly as it was and says why in `failed`. Being
   * offline is an ordinary state for this, not an error worth throwing at anyone.
   */
  async refresh(provider: Provider, maxAge = DAY, key?: string): Promise<Change> {
    if (!provider.models) return { added: [], removed: [], failed: `${provider.name} has no model list` }
    if (Date.now() - this.fetchedFrom(provider.id) < maxAge) return { added: [], removed: [] }

    let models: Model[]
    try {
      /**
       * The key when there is one, and no key when there is not.
       *
       * This used to send nothing at all, on the stated grounds that a model list is public.
       * That is true of two providers out of six. Measured: OpenRouter and NVIDIA answer
       * 200 to a bare request; Groq says 401, Cerebras 403, Mistral 401, Google 404. So four
       * of them were permanently absent from a catalog that had no way to say why — and the
       * first-run screen showing what is free, which is the reason the unauthenticated
       * request exists, is still exactly what happens before anybody has pasted anything.
       */
      // The same address the chat request would use, built the same way — a row whose base
      // URL carries an account id has to carry it here too, or the model list is the one
      // request that quietly goes somewhere else.
      const reach = reaching(provider, key === '' ? undefined : key)
      const response = await fetch(`${reach.baseUrl}${provider.models}`, {
        headers: {
          accept: 'application/json',
          ...(reach.key !== undefined && reach.key !== '' && { authorization: `Bearer ${reach.key}` }),
          ...provider.headers,
        },
      })
      if (!response.ok) throw new Error(`${response.status}`)
      models = parse(await response.json(), provider, await popularity(provider))
    } catch (error) {
      return { added: [], removed: [], failed: `could not reach ${provider.name}: ${String(error)}` }
    }
    // An empty list is a shape change, not a world where no models exist. Keep the cache.
    if (models.length === 0) {
      return { added: [], removed: [], failed: `${provider.name} returned nothing usable` }
    }

    const before = new Map(this.#snapshot.models.map((m) => [m.id, m]))
    const after = new Map(models.map((m) => [m.id, m]))
    const change: Change = {
      added: models.filter((m) => !before.has(m.id)),
      // Only this provider's rows: another provider's models are not gone because this
      // one did not mention them.
      removed: [...before.values()].filter((m) => m.provider === provider.id && !after.has(m.id)),
    }

    const kept = this.#snapshot.models.filter((m) => m.provider !== provider.id)
    const now = Date.now()
    this.#snapshot = {
      fetchedAt: now,
      models: [...kept, ...models],
      at: { ...this.#snapshot.at, [provider.id]: now },
      parsedBy: PARSER,
    }
    write(this.file, this.#snapshot)
    return change
  }
}

/**
 * The change, as a sentence. Free models first, because that is the one people want to hear
 * about — and nothing at all when nothing happened, so this can be called unconditionally.
 */
export function news(change: Change): string | undefined {
  const free = change.added.filter((m) => m.tier === 'T1')
  const [count, kind] = free.length > 0 ? [free.length, 'free '] : [change.added.length, '']
  if (count === 0) return undefined
  return `${count} new ${kind}model${count === 1 ? ' is' : 's are'} available.`
}

/**
 * What the endpoint actually sent, read defensively. Anything unrecognisable is skipped.
 *
 * **Two shapes, not one.** Everything here speaks OpenAI's `/models`, which guarantees only
 * `data[].id`. OpenRouter then adds pricing, context, modalities and a moderation flag;
 * Groq adds `context_window` and nothing else; Cerebras, Mistral and NVIDIA add nothing at
 * all. This used to read OpenRouter's names only, so every other provider's models arrived
 * priced at zero with a context of zero — which sorts as free and unusable, and is the
 * catalog quietly saying *nothing here is worth asking* about five of the seven rows.
 *
 * So each field is read from whichever key the provider uses, and **absent stays absent**
 * rather than becoming a zero that means something. Nobody publishes prices on a free tier,
 * and a `0` there is the truth; a missing context window is not `0` tokens, it is not said,
 * and the screen prints those two differently.
 */
function parse(payload: unknown, provider: Provider, weekly: ReadonlyMap<string, number> = new Map()): Model[] {
  /**
   * Two envelopes. `data` is what every OpenAI-compatible list uses; `models` is Ollama's own,
   * which one hosted provider serves its list in — and which is the shape Alexia already
   * speaks locally, so reading it here is one fallback rather than a second reader.
   */
  const envelope = payload as { data?: unknown[]; models?: unknown[] }
  const data = envelope.data ?? envelope.models
  if (!Array.isArray(data)) return []

  return data.flatMap((raw): Model[] => {
    const entry = raw as {
      id?: unknown
      /** Ollama's name for the same thing. Its list has no `id` at all. */
      model?: unknown
      name?: unknown
      /** How the usage feed names the same model. Only OpenRouter sends one. */
      canonical_slug?: unknown
      /** OpenRouter's name for it, then Groq's. Nobody else sends one. */
      context_length?: unknown
      context_window?: unknown
      /** How much it can produce. Zero is a model that does not answer in words at all. */
      max_completion_tokens?: unknown
      pricing?: { prompt?: unknown; completion?: unknown }
      architecture?: { input_modalities?: unknown }
      supported_parameters?: unknown
      top_provider?: { is_moderated?: unknown }
    }
    const id = [entry.id, entry.model, entry.name].find((one) => typeof one === 'string' && one !== '')
    if (typeof id !== 'string') return []
    /**
     * **A model that cannot complete anything is not a chat model.**
     *
     * Most providers list only the models this client can talk to. Some list their whole
     * shelf — speech recognition, image generation, embeddings — in the same array, and read
     * literally those become routable text models, so *Automatic* can land a conversation on
     * an image generator. The signal is the provider's own: those rows publish a maximum
     * completion length of zero, because there is no completion to bound.
     *
     * Absent is not zero. Every provider in this table that predates this omits the field
     * entirely, and a missing answer has never meant no here.
     */
    if (entry.max_completion_tokens === 0) return []

    const priceIn = perMillion(entry.pricing?.prompt)
    const priceOut = perMillion(entry.pricing?.completion)
    /**
     * **A negative price is not a price.** OpenRouter prices its own meta-routers —
     * `openrouter/auto` and four siblings — at `-1`, which is their way of saying *varies,
     * because this picks the model for you*. Read as a number it is minus a million dollars
     * per million tokens, which sorts below free and therefore wins **every** automatic
     * choice on the machine, ahead of all 104 genuinely free models.
     *
     * Skipped rather than clamped: zero would make it free, and it would go on winning the
     * tie against every real free model. Routing to a router is Alexia handing back the one
     * decision it exists to make, at a price it cannot show anybody in advance — so a row it
     * cannot price is a row it does not carry.
     */
    if (priceIn < 0 || priceOut < 0) return []
    const params = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : []
    const modalities = entry.architecture?.input_modalities
    const moderated = entry.top_provider?.is_moderated
    const context = [entry.context_length, entry.context_window].find((one) => typeof one === 'number')

    return [
      {
        id,
        name: typeof entry.name === 'string' ? entry.name : id,
        provider: provider.id,
        tier: priceIn === 0 && priceOut === 0 ? 'T1' : priceIn < FRONTIER_USD_PER_MTOK ? 'T2' : 'T3',
        priceIn,
        priceOut,
        context: context ?? 0,
        /**
         * ponytail: only OpenRouter says. Everywhere else this reads false, so the router's
         * tool filter skips those models unless somebody pins one by hand — which the Models
         * tab is now the way to do. Guessing `true` would route real tool calls at a hunch;
         * the upgrade is a `tools` probe per provider, cached beside this, when the auto path
         * needs them.
         */
        supportsTools: params.includes('tools'),
        modality: Array.isArray(modalities) ? modalities.map(String) : ['text'],
        ...(typeof entry.canonical_slug === 'string' &&
          weekly.has(entry.canonical_slug) && { weekly: weekly.get(entry.canonical_slug) }),
        // A moderated endpoint refuses; an unmoderated one does not. A provider that does
        // not say is not assumed either way.
        nsfwOk: typeof moderated === 'boolean' ? (moderated ? 'no' : 'yes') : 'unknown',
        // Never inferred from the price, however tempting. It is whatever the provider's
        // terms actually say, recorded on the provider row once someone has read them.
        trainsOnYourData: provider.trainsOnYourData ?? 'unknown',
      },
    ]
  })
}

/**
 * How much the world put through each of this provider's models last week.
 *
 * Every failure is the empty map, deliberately and at every level: no feed declared, the
 * request refused, the shape changed, a row that makes no sense. This reads an endpoint
 * nobody promised us — the one openrouter.ai's own models page calls, because their
 * published API carries no usage figures and silently ignores the ordering parameter that
 * would imply it does. So the catalog must be exactly as correct without it, and it is: the
 * column is empty, the sort falls through to price, and nothing else notices.
 *
 * Keyed by the provider's own name for a model — `canonical_slug` in the public list, and
 * `permaslug` in this one, which are the same string. The public `id` is not usable as a key:
 * it drops the dated suffix and adds a `:free` variant that the usage feed does not carry.
 */
async function popularity(provider: Provider): Promise<ReadonlyMap<string, number>> {
  const none = new Map<string, number>()
  if (provider.usage === undefined) return none
  try {
    const response = await fetch(provider.usage, { headers: { accept: 'application/json' } })
    if (!response.ok) return none
    const body = (await response.json()) as { data?: { analytics?: unknown } }
    const rows = body.data?.analytics
    if (typeof rows !== 'object' || rows === null) return none

    const found = new Map<string, number>()
    for (const [slug, raw] of Object.entries(rows as Record<string, unknown>)) {
      const row = raw as { total_prompt_tokens?: unknown; total_completion_tokens?: unknown }
      // In and out together: "how much went through it" is one number to the person reading.
      const total = Number(row.total_prompt_tokens ?? 0) + Number(row.total_completion_tokens ?? 0)
      if (Number.isFinite(total) && total > 0) found.set(slug, total)
    }
    return found
  } catch {
    // Offline, or they took it away. Neither is an error worth failing a model list over.
    return none
  }
}

/** Prices arrive as strings, per token. Nobody thinks in those. */
function perMillion(price: unknown): number {
  const n = Number(price)
  return Number.isFinite(n) ? n * 1_000_000 : 0
}

function read(file: string): Snapshot | undefined {
  try {
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Snapshot
    return Array.isArray(snapshot.models) ? snapshot : undefined
  } catch {
    // No cache, or one written by something that crashed halfway. Either way: start empty.
    return undefined
  }
}

function write(file: string, snapshot: Snapshot): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(snapshot))
}
