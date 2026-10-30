// SPDX-License-Identifier: AGPL-3.0-only
import { CORE_CAPABILITIES } from '@alexia/protocol'

type ContextProvider = {
  answers(cap: string): boolean
  capability(cap: string): Promise<{ isError?: boolean; content?: unknown[] }>
}

/** The provider's text, bounded. Any failure is no context: no raw errors in prompts. */
async function read(provider: ContextProvider): Promise<string> {
  try {
    const result = await provider.capability(CORE_CAPABILITIES.currentContext)
    if (result.isError) return ''
    return (result.content ?? []).flatMap((block) => {
      if (typeof block !== 'object' || block === null) return []
      const item = block as { type?: unknown; text?: unknown }
      return item.type === 'text' && typeof item.text === 'string' ? [item.text] : []
    }).join('\n').slice(0, 1500)
  } catch { return '' }
}

/** `work`, or `''` once `timeout` passes. `work` itself keeps going. */
async function within(work: Promise<string>, timeout: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<string>((resolve) => { timer = setTimeout(() => resolve(''), timeout) })])
  } finally { clearTimeout(timer) }
}

/** Optional factual context must never delay or break a conversation. No raw errors in prompts. */
export async function currentContext(provider: ContextProvider, timeout = 2000): Promise<string> {
  if (!provider.answers(CORE_CAPABILITIES.currentContext)) return ''
  return within(read(provider), timeout)
}

/**
 * **Current context, kept between turns.** Only the first ask after start (or after the provider
 * comes back) waits, and then no longer than `timeout`. After that a turn gets the last answer at
 * once, and an answer older than `fresh` is refreshed behind it for the next turn. A provider
 * slower than `timeout` still lands in the cache, so a cold start costs one turn's context, not
 * every turn's wait.
 */
export function cachedContext(provider: ContextProvider, { timeout = 2000, fresh = 60_000, now = Date.now } = {}): () => Promise<string> {
  let kept: { text: string; at: number } | undefined
  let reading: Promise<string> | undefined
  const refresh = (): Promise<string> => reading ??= read(provider).then((text) => {
    kept = { text, at: now() }
    return text
  }).finally(() => { reading = undefined })
  return async () => {
    if (!provider.answers(CORE_CAPABILITIES.currentContext)) { kept = undefined; return '' }
    if (kept === undefined) return within(refresh(), timeout)
    if (now() - kept.at >= fresh) void refresh()
    return kept.text
  }
}
