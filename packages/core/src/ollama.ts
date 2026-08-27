// SPDX-License-Identifier: AGPL-3.0-only
import { Ollama, type ModelResponse, type ShowResponse } from 'ollama'
import type { Model } from './catalog.js'
import type { Provider } from './provider.js'

/**
 * T0: the models that run on this machine.
 *
 * Chatting to them needs no code at all — Ollama serves an OpenAI-compatible face, so it is
 * a provider row like any other and `chat()` already speaks it. What is actually here is the
 * part nothing else covers: what is installed, and **pulling one with progress**.
 *
 * The first-run download in Local mode is this code path. Someone is watching a bar move for
 * several gigabytes, having been told this is the private option, and if the bar is a lie
 * they will quit and never come back. Build it as if the progress were the feature.
 */

/** Where Ollama listens. Loopback, and never configurable-by-accident: it runs here or not. */
const HOST = 'http://127.0.0.1:11434'

export const OLLAMA: Provider = {
  id: 'ollama',
  name: 'Ollama',
  // Its OpenAI-compatible face. Deliberately not in `PROVIDERS`: that table is the hosted
  // pool, and a local runner that is not installed must never look like an available rung.
  baseUrl: `${HOST}/v1`,
  keyless: true,
  // The one provider where this is a fact rather than a reading of somebody's terms: the
  // model is on this machine and the request goes to loopback.
  trainsOnYourData: 'no',
}

const client = (host: string): Ollama => new Ollama({ host })

/** Is there an Ollama to talk to? The router asks before it offers T0 as a rung. */
export async function running(host: string = HOST): Promise<boolean> {
  return client(host)
    .list()
    .then(() => true)
    .catch(() => false)
}

/** What is installed, as catalog entries — same shape as every hosted model, priced at zero. */
export async function installed(host: string = HOST): Promise<Model[]> {
  const ollama = client(host)
  const { models } = await ollama.list().catch(() => ({ models: [] as ModelResponse[] }))
  const described = await Promise.all(
    models.map(async (model) => {
      // `list` does not carry context length, whether it can use tools, or even whether it
      // can hold a conversation — and all three decide whether the loop can run on it. One
      // extra call each, tolerated separately: a model that will not describe itself is
      // still a model you can chat to.
      const shown = await ollama.show({ model: model.model }).catch(() => undefined)
      return { model, shown }
    }),
  )

  return described
    // An embedding model is installed like any other and answers a chat request with a 400.
    // Anything that says what it can do and does not say `completion` is not a chat model;
    // anything that would not say is kept, because not knowing is not a reason to hide it.
    .filter(({ shown }) => shown === undefined || shown.capabilities.includes('completion'))
    .map(({ model, shown }) => describe(model, shown))
}

export interface Progress {
  /** Ollama's own words: "pulling manifest", "downloading", "verifying sha256 digest". */
  status: string
  completed: number
  total: number
  /** 0–1, and absent until the size is known — which is the honest state to render as such. */
  fraction?: number
}

/**
 * Pull a model, reporting as it goes. Ollama sends a line per step and the same status
 * repeatedly while bytes move; every one of them is passed on, because the caller drawing
 * the bar is the one that knows how often it wants to repaint.
 */
export async function pull(
  model: string,
  onProgress: (progress: Progress) => void,
  host: string = HOST,
): Promise<void> {
  const stream = await client(host).pull({ model, stream: true })
  for await (const step of stream) {
    const total = step.total ?? 0
    const completed = step.completed ?? 0
    onProgress({ status: step.status, completed, total, ...(total > 0 && { fraction: completed / total }) })
  }
}

function describe(model: ModelResponse, shown?: ShowResponse): Model {
  const capabilities = shown?.capabilities ?? []
  const size = sizeOf(model)
  return {
    id: model.model,
    name: model.name,
    provider: OLLAMA.id,
    tier: 'T0',
    priceIn: 0,
    priceOut: 0,
    context: contextOf(shown),
    supportsTools: capabilities.includes('tools'),
    modality: ['text', ...(capabilities.includes('vision') ? ['image'] : [])],
    // Nothing moderates a model running on your own machine. Whether *it* refuses is the
    // model's business, and not something this can know from the outside.
    nsfwOk: 'unknown',
    trainsOnYourData: 'no',
    ...(size !== undefined && { params: size }),
  }
}

/**
 * `parameter_size` as a number of billions: Ollama writes it `8.2B`, `999.89M`, `1B`.
 * Undefined when it did not say, which the router reads as *do not judge this one on size*.
 */
function sizeOf(model: ModelResponse): number | undefined {
  const said = model.details.parameter_size
  const match = /^([\d.]+)\s*([BM])$/i.exec(said?.trim() ?? '')
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value)) return undefined
  return match[2]?.toUpperCase() === 'M' ? value / 1000 : value
}

/**
 * The context length, which every model family names after itself — `llama.context_length`,
 * `qwen3.context_length`. Found by suffix rather than by a list of families nobody will
 * remember to update. Zero means it did not say.
 */
function contextOf(shown?: ShowResponse): number {
  const info = shown?.model_info as unknown as Record<string, unknown> | undefined
  for (const [key, value] of Object.entries(info ?? {})) {
    if (key.endsWith('.context_length') && typeof value === 'number') return value
  }
  return 0
}
