// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The polite way to read someone else's website: one request to a host at a time and at most
 * one every ten seconds, a plain User-Agent, and the site's `robots.txt` obeyed for the path
 * being watched. The network, the clock and the sleep are handed in so a test never waits.
 */

export const USER_AGENT = 'Alexia page watch (personal use)'
export const HOST_GAP_MS = 10_000
const ROBOTS_KEEP_MS = 6 * 60 * 60_000
const MAX_BODY = 2_000_000

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
 * `deps`: `fetch`, `now()`, `sleep(ms)`, `gapMs`, `timeoutMs`.
 * `request(url, options)` is one throttled request; `get(url)` is a page read that has checked
 * `robots.txt` first and fails on an error status.
 */
export function createFetcher(deps = {}) {
  const doFetch = deps.fetch ?? ((...a) => globalThis.fetch(...a))
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? realSleep
  const gap = deps.gapMs ?? HOST_GAP_MS
  const timeoutMs = deps.timeoutMs ?? 20_000
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

  async function request(raw, options = {}) {
    const url = parseUrl(raw)
    return turn(url.host, async () => {
      let res
      try {
        res = await doFetch(url.href, {
          method: options.method ?? 'GET',
          headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.5', ...options.headers },
          body: options.body,
          redirect: options.redirect ?? 'follow',
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        const why = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'took too long to answer' : 'could not be reached'
        throw new WatchError(`${url.host} ${why}.`)
      }
      let text
      try {
        text = (await res.text()).slice(0, MAX_BODY)
      } catch {
        throw new WatchError(`${url.host} cut the page off.`)
      }
      return { status: res.status, headers: res.headers, text, url: url.href }
    })
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
      const res = await request(`${url.origin}/robots.txt`, { headers: { accept: 'text/plain' } })
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

  /** Read a public page: robots first, then the page. Throws a `WatchError` in plain words. */
  async function get(raw, options = {}) {
    const url = parseUrl(raw)
    if (!(await allowed(url.href))) throw new WatchError(`${url.host} asks not to be read at ${url.pathname}, so I did not.`)
    const res = await request(url.href, options)
    if (res.status < 200 || res.status >= 300) throw new WatchError(`${url.host} answered ${res.status} for ${url.pathname}.`)
    return res
  }

  return { request, get, allowed }
}
