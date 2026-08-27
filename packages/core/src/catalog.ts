// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Provider } from './provider.js'

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
}

export interface Snapshot {
  fetchedAt: number
  models: Model[]
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

export class Catalog {
  #snapshot: Snapshot

  /** `file` is `<cacheDir>/models.json`. Missing, empty or corrupt all mean the same thing. */
  constructor(private readonly file: string) {
    this.#snapshot = read(file) ?? { fetchedAt: 0, models: [] }
  }

  get models(): readonly Model[] {
    return this.#snapshot.models
  }

  /** When the list was last actually fetched. Zero means never, and the UI can say so. */
  get fetchedAt(): number {
    return this.#snapshot.fetchedAt
  }

  /**
   * Fetch, unless what is cached is younger than `maxAge` — which is the daily poll, minus
   * a timer nothing owns yet. The app loop calls this on a schedule from M1-10.
   *
   * A fetch that fails leaves the cache exactly as it was and says why in `failed`. Being
   * offline is an ordinary state for this, not an error worth throwing at anyone.
   */
  async refresh(provider: Provider, maxAge = DAY): Promise<Change> {
    if (!provider.models) return { added: [], removed: [], failed: `${provider.name} has no model list` }
    if (Date.now() - this.#snapshot.fetchedAt < maxAge) return { added: [], removed: [] }

    let models: Model[]
    try {
      // No key: a model list is public, and the first-run flow shows what is free before
      // anyone has connected anything.
      const response = await fetch(`${provider.baseUrl}${provider.models}`, {
        headers: { accept: 'application/json', ...provider.headers },
      })
      if (!response.ok) throw new Error(`${response.status}`)
      models = parse(await response.json(), provider)
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
    this.#snapshot = { fetchedAt: Date.now(), models: [...kept, ...models] }
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

/** What the endpoint actually sent, read defensively. Anything unrecognisable is skipped. */
function parse(payload: unknown, provider: Provider): Model[] {
  const data = (payload as { data?: unknown[] })?.data
  if (!Array.isArray(data)) return []

  return data.flatMap((raw): Model[] => {
    const entry = raw as {
      id?: unknown
      name?: unknown
      context_length?: unknown
      pricing?: { prompt?: unknown; completion?: unknown }
      architecture?: { input_modalities?: unknown }
      supported_parameters?: unknown
      top_provider?: { is_moderated?: unknown }
    }
    if (typeof entry.id !== 'string' || entry.id === '') return []

    const priceIn = perMillion(entry.pricing?.prompt)
    const priceOut = perMillion(entry.pricing?.completion)
    const params = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : []
    const modalities = entry.architecture?.input_modalities
    const moderated = entry.top_provider?.is_moderated

    return [
      {
        id: entry.id,
        name: typeof entry.name === 'string' ? entry.name : entry.id,
        provider: provider.id,
        tier: priceIn === 0 && priceOut === 0 ? 'T1' : priceIn < FRONTIER_USD_PER_MTOK ? 'T2' : 'T3',
        priceIn,
        priceOut,
        context: typeof entry.context_length === 'number' ? entry.context_length : 0,
        supportsTools: params.includes('tools'),
        modality: Array.isArray(modalities) ? modalities.map(String) : ['text'],
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
