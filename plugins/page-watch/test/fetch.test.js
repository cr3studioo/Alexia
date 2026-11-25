// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { createFetcher, parseRobots, robotsAllows, USER_AGENT, WatchError } from '../fetch.js'

/** A fake network and a fake clock: sleeping moves the clock, so nothing really waits. */
function world(routes) {
  const log = []
  const clock = { t: 1_000_000 }
  const fetch = async (url, init) => {
    log.push({ url, at: clock.t, ua: init.headers['user-agent'] })
    const route = routes[new URL(url).pathname]
    if (!route) return new globalThis.Response('not found', { status: 404 })
    return new globalThis.Response(route.body, { status: route.status ?? 200 })
  }
  const fetcher = createFetcher({
    fetch,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms
    },
  })
  return { fetcher, log, clock }
}

test('one_request_per_host_per_ten_seconds', async () => {
  const w = world({ '/robots.txt': { body: '' }, '/a': { body: 'A' }, '/b': { body: 'B' } })
  // Two pages on one host, asked for at once, and one on another host.
  const [a, b, other] = await Promise.all([
    w.fetcher.get('https://one.test/a'),
    w.fetcher.get('https://one.test/b'),
    w.fetcher.get('https://two.test/a'),
  ])
  expect([a.text, b.text, other.text]).toEqual(['A', 'B', 'A'])
  const one = w.log.filter((r) => r.url.startsWith('https://one.test'))
  // robots.txt, /a and /b: three requests, each at least ten seconds after the one before.
  expect(one.map((r) => new URL(r.url).pathname)).toEqual(['/robots.txt', '/a', '/b'])
  for (let i = 1; i < one.length; i++) expect(one[i].at - one[i - 1].at).toBeGreaterThanOrEqual(10_000)
  // Another host is not held up by the first.
  expect(w.log.find((r) => r.url.startsWith('https://two.test')).at).toBe(1_000_000)
  expect(w.log.every((r) => r.ua === USER_AGENT)).toBe(true)
  expect(USER_AGENT).toBe('Alexia page watch (personal use)')
})

test('robots_disallow_respected', async () => {
  const w = world({
    '/robots.txt': { body: 'User-agent: *\nDisallow: /private/\nAllow: /private/open\n\nUser-agent: Badbot\nDisallow: /\n' },
    '/private/x': { body: 'secret' },
    '/private/open': { body: 'fine' },
    '/public': { body: 'hello' },
  })
  await expect(w.fetcher.get('https://r.test/private/x')).rejects.toThrow(WatchError)
  await expect(w.fetcher.get('https://r.test/private/x')).rejects.toThrow('asks not to be read')
  expect((await w.fetcher.get('https://r.test/private/open')).text).toBe('fine')
  expect((await w.fetcher.get('https://r.test/public')).text).toBe('hello')
  // The forbidden page was never requested, and robots.txt was read once.
  expect(w.log.some((r) => r.url.endsWith('/private/x'))).toBe(false)
  expect(w.log.filter((r) => r.url.endsWith('/robots.txt'))).toHaveLength(1)
})

test('robots_rules_parse', () => {
  const rules = parseRobots('User-agent: alexia\nDisallow: /news$\nDisallow: /tmp/*.pdf\n\nUser-agent: *\nDisallow: /\n')
  // A group that names this agent beats the wildcard one.
  expect(robotsAllows(rules, '/')).toBe(true)
  expect(robotsAllows(rules, '/news')).toBe(false)
  expect(robotsAllows(rules, '/news/today')).toBe(true)
  expect(robotsAllows(rules, '/tmp/a.pdf')).toBe(false)
  expect(robotsAllows(parseRobots('User-agent: *\nDisallow:\n'), '/anything')).toBe(true)
  expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /\n'), '/anything')).toBe(false)
})

test('errors_are_plain_sentences', async () => {
  const w = world({ '/robots.txt': { body: '' }, '/gone': { body: 'x', status: 404 } })
  await expect(w.fetcher.get('https://e.test/gone')).rejects.toThrow('e.test answered 404 for /gone.')
  await expect(w.fetcher.get('ftp://e.test/x')).rejects.toThrow('Only http and https')
  await expect(w.fetcher.get('nonsense')).rejects.toThrow('is not a web address')
  // A server error on robots.txt means "do not read" rather than "read anything".
  const down = world({ '/robots.txt': { body: '', status: 503 }, '/a': { body: 'A' } })
  await expect(down.fetcher.get('https://d.test/a')).rejects.toThrow('asks not to be read')
})
