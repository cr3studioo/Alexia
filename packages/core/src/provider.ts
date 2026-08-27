// SPDX-License-Identifier: AGPL-3.0-only
import { CORE, keychain, type SecretStore } from './secrets.js'
import type { Message } from './store.js'

/**
 * One OpenAI-compatible client, and providers as rows rather than files.
 *
 * This is Alexia.md's own mitigation for the exception that lets a model provider live in
 * core at all: **adding a provider must never mean adding code.** Base URL, the keychain
 * entry holding the key, where the model list lives — everything that differs between
 * OpenAI-compatible endpoints, which by now is all of the ones worth having. Skip it and
 * core accretes a vendor integration a month.
 */

export interface Provider {
  id: string
  name: string
  /** Everything before `/chat/completions`. */
  baseUrl: string
  /** Where its model list lives, relative to `baseUrl`. Not every provider has one. */
  models?: string
  /** Sent with every request. A provider that wants attribution headers says so here. */
  headers?: Record<string, string>
  /** A local server, or one the user is already the endpoint of. No key, and none asked for. */
  keyless?: boolean
  /**
   * What its terms say about training on what you send it (D51). Left unset until somebody
   * has actually read them — M1-6 is where that happens, provider by provider. Never
   * inferred from the price, however strongly the price hints.
   */
  trainsOnYourData?: 'yes' | 'no' | 'unknown'
}

/**
 * ponytail: one row, because one is what M1-5 needs to fetch a catalog with. The free-tier
 * pool at M1-6 adds the rest, each with the limits, terms URL and trains-on-your-data flag
 * that D51 makes load-bearing — and those belong with the pool, not scattered ahead of it.
 */
export const PROVIDERS: Provider[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: '/models',
    // OpenRouter attributes traffic to whatever sends these. Being identifiable costs
    // nothing and is the polite half of using somebody's free tier.
    headers: { 'HTTP-Referer': 'https://github.com/cr3studioo/Alexia', 'X-Title': 'Alexia' },
  },
]

/** The keychain entry a provider's key lives in. Core's own scope, which no plugin id can be. */
export const keyOf = (provider: Provider): string => `provider/${provider.id}`

/** A tool as the model is told about it. The agent loop (M15-2) builds these from `tools/list`. */
export interface ToolSpec {
  name: string
  description?: string
  /** JSON Schema. MCP hands one over already, so nothing here rewrites it. */
  parameters?: Record<string, unknown>
}

export interface ChatRequest {
  model: string
  messages: Message[]
  tools?: ToolSpec[]
  maxTokens?: number
  /** The stop control (M15-5). Aborting mid-stream is the point of it. */
  signal?: AbortSignal
}

/** Tokens in and out. What M1-9 turns into money, and the only usage core keeps. */
export interface Usage {
  in: number
  out: number
}

/**
 * A provider said no. The status is on it because the router acts on the number: a 429 is
 * the next rung down, and a 401 is a key the user has to fix.
 */
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface Chunk {
  model?: string
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  choices?: {
    delta?: {
      content?: string
      tool_calls?: {
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
  }[]
}

/**
 * Ask a model. Always streamed, even when nobody is watching the pieces: one code path is
 * less code than two, and the only caller that does not stream is a test.
 *
 * `onDelta` gets the text as it arrives. What comes back is a `Message` — the same shape
 * the history stores and re-sends, so an answer needs no translation to become the next
 * request's context.
 */
export async function chat(
  provider: Provider,
  request: ChatRequest,
  onDelta?: (text: string) => void,
  secrets: SecretStore = keychain,
): Promise<{ message: Message; usage: Usage }> {
  const key = provider.keyless ? undefined : await secrets.get(CORE, keyOf(provider))
  if (!provider.keyless && !key) {
    throw new ProviderError(401, `${provider.name} has no key yet — add one in settings.`)
  }

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key !== undefined && { authorization: `Bearer ${key}` }),
      ...provider.headers,
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages.map(toWire),
      ...(request.tools && { tools: request.tools.map(asFunction) }),
      ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
      stream: true,
      // The only way to be told what a streamed answer cost. A provider that ignores it
      // leaves usage at zero, which is the honest number to show rather than a guess.
      stream_options: { include_usage: true },
    }),
    signal: request.signal,
  })

  if (!response.ok || !response.body) {
    // The body is the provider's own explanation, and it is usually the useful part.
    const said = await response.text().catch(() => '')
    throw new ProviderError(response.status, `${provider.name} said ${response.status}: ${said.slice(0, 200)}`)
  }

  let content = ''
  let model = request.model
  let usage: Usage = { in: 0, out: 0 }
  const calls: ({ id: string; name: string; arguments: string } | undefined)[] = []

  for await (const event of frames(response.body)) {
    if (event === '[DONE]') break
    let chunk: Chunk
    try {
      chunk = JSON.parse(event) as Chunk
    } catch {
      // A frame that is not JSON is a provider having a bad day, not a reason to lose the
      // answer that arrived before it.
      continue
    }
    if (chunk.model) model = chunk.model
    if (chunk.usage) {
      usage = { in: chunk.usage.prompt_tokens ?? 0, out: chunk.usage.completion_tokens ?? 0 }
    }
    const delta = chunk.choices?.[0]?.delta
    if (!delta) continue
    if (delta.content) {
      content += delta.content
      onDelta?.(delta.content)
    }
    for (const call of delta.tool_calls ?? []) {
      // Streamed in pieces and keyed by index: the id and name arrive once, the arguments
      // in fragments that only mean anything concatenated.
      const at = (calls[call.index] ??= { id: '', name: '', arguments: '' })
      if (call.id) at.id = call.id
      if (call.function?.name) at.name = call.function.name
      if (call.function?.arguments) at.arguments += call.function.arguments
    }
  }

  const asked = calls.filter((c) => c !== undefined)
  return {
    message: { role: 'assistant', content, model, ...(asked.length > 0 && { calls: asked }) },
    usage,
  }
}

/** A stored message, in the shape every OpenAI-compatible endpoint takes. */
function toWire(message: Message): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    ...(message.calls && {
      tool_calls: message.calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      })),
    }),
    ...(message.callId !== undefined && { tool_call_id: message.callId }),
  }
}

const asFunction = (tool: ToolSpec): Record<string, unknown> => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? { type: 'object', properties: {} },
  },
})

/**
 * The `data:` payloads of a server-sent event stream, in order. Everything else — comments,
 * event names, the blank lines between frames — is not something any of these endpoints
 * sends anything meaningful in.
 */
async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // A chunk boundary lands mid-line often enough that this is the whole reason for the
    // buffer: yield the complete lines, keep the tail for the next read.
    let cut = buffer.indexOf('\n')
    while (cut !== -1) {
      const line = buffer.slice(0, cut).trim()
      buffer = buffer.slice(cut + 1)
      if (line.startsWith('data:')) yield line.slice('data:'.length).trim()
      cut = buffer.indexOf('\n')
    }
  }
}
