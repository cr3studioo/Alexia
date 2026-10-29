// SPDX-License-Identifier: AGPL-3.0-only
import { CORE_CAPABILITIES } from '@alexia/protocol'

/** Optional factual context must never delay or break a conversation. No raw errors in prompts. */
export async function currentContext(provider: {
  answers(cap: string): boolean
  capability(cap: string): Promise<{ isError?: boolean; content?: unknown[] }>
}, timeout = 2000): Promise<string> {
  if (!provider.answers(CORE_CAPABILITIES.currentContext)) return ''
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      provider.capability(CORE_CAPABILITIES.currentContext).then((result) => {
        if (result.isError) return ''
        return (result.content ?? []).flatMap((block) => {
          if (typeof block !== 'object' || block === null) return []
          const item = block as { type?: unknown; text?: unknown }
          return item.type === 'text' && typeof item.text === 'string' ? [item.text] : []
        }).join('\n').slice(0, 1500)
      }),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve(''), timeout) }),
    ])
  } catch { return '' } finally { clearTimeout(timer) }
}
