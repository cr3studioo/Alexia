// SPDX-License-Identifier: AGPL-3.0-only
import { Buffer } from 'node:buffer'

export const WORKFLOW_MAX = 4_000_000

/** Bounded reads and explicit redirects: a key never follows a download onto somebody else's host. */
export async function bytes(url, { fetch = globalThis.fetch, signal, headers = {}, max = WORKFLOW_MAX } = {}) {
  let at = new URL(url)
  const authOrigin = at.origin
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
  for (let redirects = 0; redirects <= 5; redirects++) {
    bounded.throwIfAborted()
    if (at.protocol !== 'https:' || at.username || at.password) throw new Error('Workflow sources require an https address without credentials.')
    const sent = { accept: 'application/json', ...headers }
    if (at.origin !== authOrigin) delete sent.authorization
    const response = await fetch(at.href, { signal: bounded, headers: sent, redirect: 'manual' })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error(`${at.host} redirected without a download address.`)
      at = new URL(location, at)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      const reason = response.status === 401 ? ' — this download requires your own API key'
        : response.status === 403 ? ' — access was refused; check your key and the entry’s access restrictions'
        : response.status === 429 ? ` — rate limited${response.headers.get('retry-after') ? `; retry after ${response.headers.get('retry-after')}` : ''}` : ''
      const error = new Error(`${authOrigin} answered ${response.status}${reason}.`)
      error.status = response.status
      throw error
    }
    if (Number(response.headers.get('content-length')) > max) {
      await response.body?.cancel()
      throw new Error(`That source response exceeds the ${max} byte limit.`)
    }
    if (!response.body) throw new Error('That source returned no body.')
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    try {
      while (true) {
        bounded.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > max) throw new Error(`That source response exceeds the ${max} byte limit.`)
        chunks.push(Buffer.from(value))
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks)
  }
  throw new Error('That source redirected too many times.')
}

export async function json(url, options) {
  const body = await bytes(url, options)
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error(`${new URL(url).host} returned something other than JSON.`)
  }
}

/** Plain text for the library; source descriptions are often HTML. */
export const plain = (text) => String(text ?? '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, (one) => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[one])
  .replace(/\s+/g, ' ').trim()

export function matches(entry, query, task) {
  if (task && entry.task !== task && !(entry.tags ?? []).includes(task)) return false
  const haystack = [entry.title, entry.description, ...(entry.tags ?? [])].join(' ').toLowerCase()
  return String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word))
}
