// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The polite way to read someone else's website: one request to a host at a time and at most
 * one every ten seconds, a plain User-Agent, and the site's `robots.txt` obeyed for the path
 * being watched. The network, the clock and the sleep are handed in so a test never waits.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export const USER_AGENT = 'Alexia page watch (personal use)'
export const HOST_GAP_MS = 10_000
const ROBOTS_KEEP_MS = 6 * 60 * 60_000
const MAX_BODY = 2_000_000
const MAX_REDIRECTS = 5

/** An IPv6 address as eight 16-bit groups, or undefined if it is not one. */
function ipv6Groups(text) {
  let s = text.replace(/^\[|\]$/g, '').split('%')[0]
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (tail) {
    const p = tail[1].split('.').map(Number)
    if (p.some((n) => n > 255)) return undefined
    s = `${s.slice(0, -tail[1].length)}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest]
  const groups = all.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : Number.NaN))
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : undefined
}

function publicV4(a, b, c) {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

/** Is this an address on the public internet? Loopback, private, link-local and reserved ranges are not. */
export function isPublicAddress(address) {
  const text = String(address).trim().replace(/^\[|\]$/g, '')
  if (isIP(text) === 4) {
    const [a, b, c] = text.split('.').map(Number)
    return publicV4(a, b, c)
  }
  const g = ipv6Groups(text)
  if (!g) return false
  const embedded = (hi, lo) => publicV4(hi >> 8, hi & 255, lo >> 8)
  if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return false // :: and ::1
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible) and 64:ff9b::a.b.c.d (NAT64) carry an IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return embedded(g[6], g[7])
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6], g[7])
  if (g[0] === 0x2002) return embedded(g[1], g[2]) // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return false // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return false // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return false // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false // documentation
  return true
}

/** An error whose message is a sentence the owner can read as it is. */
export class WatchError extends Error {}

/** The parsed `http(s)` URL, or a `WatchError` saying why not. */
export function parseUrl(raw) {
  let url
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    throw new WatchError(`"${String(raw ?? '').slice(0, 80)}" is not a web address.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WatchError('Only http and https addresses can be watched.')
  return url
}

function robotsPattern(path) {
  const anchored = path.endsWith('$')
  const body = (anchored ? path.slice(0, -1) : path).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${body}${anchored ? '$' : ''}`)
}

/** The rules that apply to `agent` in a `robots.txt`: `[{ allow, pattern, length }]`. */
export function parseRobots(text, agent = 'alexia') {
  const groups = []
  let current
  let lastWasAgent = false
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const field = m[1].toLowerCase()
    if (field === 'user-agent') {
      if (!lastWasAgent) {
        current = { agents: [], rules: [] }
        groups.push(current)
      }
      current.agents.push(m[2].toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (!current || (field !== 'disallow' && field !== 'allow')) continue
    // An empty Disallow allows everything: it adds no rule.
    if (m[2] === '') continue
    current.rules.push({ allow: field === 'allow', pattern: robotsPattern(m[2]), length: m[2].length })
  }
  const named = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)))
  const chosen = named.length ? named : groups.filter((g) => g.agents.includes('*'))
  return chosen.flatMap((g) => g.rules)
}

/** May a path (with its query) be read under these rules? The longest match wins; allow wins a tie. */
export function robotsAllows(rules, path) {
  let best
  for (const rule of rules) {
    if (!rule.pattern.test(path)) continue
    if (!best || rule.length > best.length || (rule.length === best.length && rule.allow)) best = rule
  }
  return best ? best.allow : true
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `deps`: `fetch`, `now()`, `sleep(ms)`, `gapMs`, `timeoutMs`, `resolve(host)` (the addresses of a
 * name), `listed(url)` (the owner named this address in the settings, so it may be a private one).
 * Redirects are never followed by the network layer: `get` follows them by hand and checks every hop.
 * `request(url, options)` is one throttled request; `get(url)` is a page read that has checked
 * `robots.txt` first and fails on an error status.
 */
export function createFetcher(deps = {}) {
  const doFetch = deps.fetch ?? ((...a) => globalThis.fetch(...a))
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? realSleep
  const gap = deps.gapMs ?? HOST_GAP_MS
  const timeoutMs = deps.timeoutMs ?? 20_000
  const resolve = deps.resolve ?? (async (host) => (await lookup(host, { all: true })).map((a) => a.address))
  // `listed(url)`: did the owner write exactly this address in the settings? Those may be private.
  const listed = async (url) => Boolean(await deps.listed?.(url))
  const chains = new Map()
  const lastAt = new Map()
  const robots = new Map()
  const reading = new Map()

  /** Run `task` after every earlier request to this host and after the gap since the last one. */
  function turn(host, task) {
    const before = chains.get(host) ?? Promise.resolve()
    const run = before.then(async () => {
      const last = lastAt.get(host)
      if (last !== undefined) {
        const wait = last + gap - now()
        if (wait > 0) await sleep(wait)
      }
      // Stamped before the request, so a slow answer does not shorten the gap that follows.
      lastAt.set(host, now())
      return task()
    })
    chains.set(host, run.catch(() => {}))
    return run
  }

  /** Throws unless the address is on the public internet, or the owner listed exactly this URL. */
  async function checkAddress(url) {
    if (await listed(url)) return
    const refuse = () => new WatchError(`${url.host} is not a public website, so I did not read it. List the exact address in the settings if it is yours.`)
    const bare = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(bare)) {
      if (!isPublicAddress(bare)) throw refuse()
      return
    }
    let found
    try {
      found = await resolve(bare)
    } catch {
      throw new WatchError(`${url.host} could not be found.`)
    }
    if (!found.length || !found.every(isPublicAddress)) throw refuse()
  }

  /** The body, read as a stream that is stopped once the cap is reached. */
  async function readBody(res) {
    if (!res.body?.getReader) return (await res.text()).slice(0, MAX_BODY)
    const reader = res.body.getReader()
    const bytes = new Uint8Array(MAX_BODY)
    let size = 0
    while (size < MAX_BODY) {
      const { done, value } = await reader.read()
      if (done) break
      const take = value.subarray(0, MAX_BODY - size)
      bytes.set(take, size)
      size += take.length
    }
    await reader.cancel().catch(() => {})
    return new globalThis.TextDecoder().decode(bytes.subarray(0, size))
  }

  /** One throttled request that is never followed anywhere: a redirect comes back as it is. */
  async function request(raw, options = {}) {
    const url = parseUrl(raw)
    await checkAddress(url)
    return turn(url.host, async () => {
      let res
      try {
        res = await doFetch(url.href, {
          method: options.method ?? 'GET',
          headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.5', ...options.headers },
          body: options.body,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        const why = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'took too long to answer' : 'could not be reached'
        throw new WatchError(`${url.host} ${why}.`)
      }
      let text
      try {
        text = await readBody(res)
      } catch {
        throw new WatchError(`${url.host} cut the page off.`)
      }
      return { status: res.status, headers: res.headers, text, url: url.href }
    })
  }

  /** Follow redirects by hand: every hop is checked for address and (for pages) robots.txt, and waits its turn on its host. */
  async function follow(raw, options, withRobots) {
    let url = parseUrl(raw)
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // The address first, so a private host is refused as such and never even asked for robots.txt.
      await checkAddress(url)
      if (withRobots && !(await allowed(url.href))) throw new WatchError(`${url.host} asks not to be read at ${url.pathname}, so I did not.`)
      const res = await request(url.href, options)
      const where = res.status >= 300 && res.status < 400 ? res.headers?.get?.('location') : undefined
      if (!where) return res
      try {
        url = parseUrl(new URL(where, url).href)
      } catch {
        throw new WatchError(`${url.host} sent me somewhere that is not a web address.`)
      }
    }
    throw new WatchError(`${url.host} kept redirecting, so I stopped.`)
  }

  /** The rules for a host, kept for a few hours. A server error means "do not read" (RFC 9309). */
  function rulesFor(url) {
    const kept = robots.get(url.origin)
    if (kept && now() - kept.at < ROBOTS_KEEP_MS) return kept.rules
    // Askers that arrive while it is being read share the one request.
    const pending = reading.get(url.origin)
    if (pending) return pending
    const task = readRules(url).finally(() => reading.delete(url.origin))
    reading.set(url.origin, task)
    return task
  }

  async function readRules(url) {
    let rules
    try {
      const res = await follow(`${url.origin}/robots.txt`, { headers: { accept: 'text/plain' } }, false)
      if (res.status >= 500) rules = [{ allow: false, pattern: /^\//, length: 1 }]
      else if (res.status >= 400) rules = []
      else rules = parseRobots(res.text)
    } catch {
      rules = [{ allow: false, pattern: /^\//, length: 1 }]
    }
    robots.set(url.origin, { at: now(), rules })
    return rules
  }

  /** Is this page allowed to be read? */
  async function allowed(raw) {
    const url = parseUrl(raw)
    return robotsAllows(await rulesFor(url), url.pathname + url.search)
  }

  /** Read a public page: robots first, then the page, again on every hop of a redirect. Throws a `WatchError` in plain words. */
  async function get(raw, options = {}) {
    const res = await follow(raw, options, true)
    if (res.status < 200 || res.status >= 300) {
      const u = new URL(res.url)
      throw new WatchError(`${u.host} answered ${res.status} for ${u.pathname}.`)
    }
    return res
  }

  return { request, get, allowed }
}
