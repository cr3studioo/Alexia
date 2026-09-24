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
  auth: 'none',
  /**
   * **Three minutes to the first byte**, where a hosted row gets thirty seconds (D155). The
   * first request loads the model off the disk, and a long conversation is read in full on
   * this machine's own processor before a word comes back — minutes on a laptop with no GPU,
   * and nothing streamed while it happens. Once it is talking, it gets the ordinary gap.
   */
  timeoutMs: 180_000,
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

/** What the Local stats page draws (D204): the models here, and the ones in memory now. */
export interface Local {
  /** Whether Ollama answered at all. `false` is an ordinary state, not an error. */
  running: boolean
  /** Every model on the disk, and how many bytes each one takes there. */
  installed: { name: string; size: number }[]
  /**
   * The models in memory right now (Ollama's `/api/ps`), with how much of each sits in
   * graphics memory and when Ollama will let it go — its own timestamp, passed on as it
   * wrote it, and `null` when it did not say.
   */
  loaded: { name: string; size: number; vram: number; until: string | null }[]
}

/**
 * **The machine's side of local models, read without waking anything** (D204).
 *
 * Two requests, both cheap: `list` is the folder listing and `ps` is what is in memory, and
 * neither loads a model or describes one — which is why this does not go through
 * {@link installed}, whose one `show` per model is the price of knowing what a model can do,
 * and is not worth paying for a page that only says how big things are.
 *
 * **Never throws.** Ollama not being here is the answer for most people, and a page that
 * turned it into an error would be telling them something is broken that was never there.
 * The two are asked separately so an Ollama too old to have `ps` still lists what it has.
 */
export async function local(host: string = HOST): Promise<Local> {
  const ollama = client(host)
  const listed = await ollama.list().catch(() => undefined)
  // Something that answered on Ollama's port with anything but a model list is not an Ollama
  // this can read — said as *not running*, not thrown at a page that polls every few seconds.
  if (listed === undefined || listed === null || !Array.isArray(listed.models)) return { running: false, installed: [], loaded: [] }
  const busy = await ollama.ps().catch(() => undefined)
  const inMemory = Array.isArray(busy?.models) ? busy.models : ([] as ModelResponse[])
  return {
    running: true,
    installed: listed.models.filter(named).map((m) => ({ name: m.name, size: bytes(m.size) })),
    loaded: inMemory.filter(named).map((m) => {
      // Typed as a Date by the client and delivered as the string Ollama sent, which is the
      // form worth passing on anyway: JSON has no dates.
      const until = m.expires_at as unknown
      return {
        name: m.name,
        size: bytes(m.size),
        vram: bytes(m.size_vram),
        until: typeof until === 'string' && until !== '' ? until : null,
      }
    }),
  }
}

/** A row off the wire with a name to show, which is the least a row on the page needs. */
const named = (m: unknown): m is ModelResponse =>
  typeof m === 'object' && m !== null && typeof (m as { name?: unknown }).name === 'string' && (m as { name: string }).name !== ''

/** A byte count off the wire, or 0 for anything that is not one. */
const bytes = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0)

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
