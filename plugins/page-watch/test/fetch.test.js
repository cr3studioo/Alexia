// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { createFetcher, isPublicAddress, parseRobots, robotsAllows, USER_AGENT, WatchError } from '../fetch.js'

/** A fake network and a fake clock: sleeping moves the clock, so nothing really waits. */
function world(routes, extra = {}) {
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
    resolve: async () => ['93.184.216.34'],
    ...extra,
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

/** A network whose answers are streams, redirects included, so the redirect and size rules are really exercised. */
function routed(table, extra = {}) {
  const log = []
  const fetch = async (url, init) => {
    log.push({ url, redirect: init.redirect })
    const hit = table[url]
    if (!hit) return new globalThis.Response('not found', { status: 404 })
    if (typeof hit === 'function') return hit()
    return new globalThis.Response(hit.body ?? '', { status: hit.status ?? 200, headers: hit.headers })
  }
  const clock = { t: 5_000_000 }
  const fetcher = createFetcher({ fetch, now: () => clock.t, sleep: async (ms) => void (clock.t += ms), resolve: async () => ['93.184.216.34'], ...extra })
  return { fetcher, log }
}

test('private_and_loopback_addresses_refused', () => {
  for (const bad of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1', 'ff02::1', '[::1]'])
    expect(isPublicAddress(bad), bad).toBe(false)
  for (const good of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])
    expect(isPublicAddress(good), good).toBe(true)
})

test('url_resolving_to_private_address_refused_unless_listed', async () => {
  const table = { 'https://nas.test/robots.txt': { body: '' }, 'https://nas.test/p': { body: 'secret' } }
  const closed = routed(table, { resolve: async () => ['192.168.1.20'] })
  await expect(closed.fetcher.get('https://nas.test/p')).rejects.toThrow(/not a public website/)
  expect(closed.log).toEqual([])
  await expect(routed({}, { resolve: async () => ['93.184.216.34', '10.0.0.5'] }).fetcher.get('https://mixed.test/p')).rejects.toThrow(WatchError)
  await expect(routed({}).fetcher.get('http://127.0.0.1:8080/admin')).rejects.toThrow(/not a public website/)
  await expect(routed({}).fetcher.get('http://[::1]/x')).rejects.toThrow(/not a public website/)
  const open = routed(table, { resolve: async () => ['192.168.1.20'], listed: async (u) => u.href === 'https://nas.test/p' })
  // Only the exact listed URL: the page itself is allowed, a sibling is not.
  await expect(open.fetcher.get('https://nas.test/other')).rejects.toThrow(/not a public website/)
})

test('listed_private_url_may_be_read', async () => {
  // Only the exact page is listed (as index.js does it): its own robots.txt must still be readable.
  const listed = async (u) => u.href === 'https://nas.test/p'
  const w = routed({ 'https://nas.test/robots.txt': { body: '' }, 'https://nas.test/p': { body: 'ok' } }, { resolve: async () => ['192.168.1.20'], listed })
  expect((await w.fetcher.get('https://nas.test/p')).text).toBe('ok')
  expect(w.log.map((r) => r.url)).toEqual(['https://nas.test/robots.txt', 'https://nas.test/p'])
  // Its robots.txt is still obeyed.
  const ruled = routed(
    { 'https://nas.test/robots.txt': { body: ['User-agent: *', 'Disallow: /p'].join(String.fromCharCode(10)) }, 'https://nas.test/p': { body: 'ok' } },
    { resolve: async () => ['192.168.1.20'], listed },
  )
  await expect(ruled.fetcher.get('https://nas.test/p')).rejects.toThrow(/asks not to be read/)
  expect(ruled.log.map((r) => r.url)).toEqual(['https://nas.test/robots.txt'])
  // Listing one page does not open the rest of that host, nor its robots.txt to a direct request.
  await expect(w.fetcher.get('https://nas.test/q')).rejects.toThrow(/not a public website/)
  await expect(w.fetcher.request('https://nas.test/robots.txt')).rejects.toThrow(/not a public website/)
})

test('reserved_ipv6_ranges_refused', () => {
  for (const bad of [
    '::ffff:0:808:808', // ::ffff:0:0:0/96 IPv4-translated
    '::ffff:0:8.8.8.8',
    '64:ff9b:1::808:808', // 64:ff9b:1::/48 local-use NAT64
    '64:ff9b:1:ffff::1',
    'fec0::1', // fec0::/10 site-local
    'feff::1',
    '100::1', // 100::/64 discard
    '100::ffff:ffff:ffff:ffff',
    '2001::1', // 2001::/32 Teredo
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
  ])
    expect(isPublicAddress(bad), bad).toBe(false)
  // Neighbours of those ranges stay public.
  for (const good of ['64:ff9b:2::808:808', '100:0:0:1::1', '2001:1::1', '2001:4860:4860::8888', 'fe00::1'])
    expect(isPublicAddress(good), good).toBe(true)
})

test('address_checked_again_after_the_queue_wait', async () => {
  // The host is public when the request is queued, then turns private while it waits its turn.
  let answer = ['93.184.216.34']
  let flipOnSleep = false
  let slept = 0
  const w = routed(
    { 'https://flip.test/robots.txt': { body: '' }, 'https://flip.test/a': { body: 'A' }, 'https://flip.test/b': { body: 'B' } },
    {
      resolve: async () => answer,
      sleep: async () => {
        slept++
        if (flipOnSleep) answer = ['10.0.0.7']
      },
    },
  )
  expect((await w.fetcher.get('https://flip.test/a')).text).toBe('A')
  flipOnSleep = true
  slept = 0
  // /b passes the first check, then sleeps for the host gap; the sleep flips the answer.
  await expect(w.fetcher.request('https://flip.test/b')).rejects.toThrow(/not a public website/)
  expect(slept).toBe(1)
  expect(w.log.map((r) => r.url)).not.toContain('https://flip.test/b')
})

test('redirect_to_loopback_is_refused', async () => {
  const w = routed({
    'https://pub.test/robots.txt': { body: '' },
    'https://pub.test/go': { status: 302, headers: { location: 'http://127.0.0.1:9/secret' } },
  })
  await expect(w.fetcher.get('https://pub.test/go')).rejects.toThrow(/not a public website/)
  expect(w.log.some((r) => r.url.includes('127.0.0.1'))).toBe(false)
  expect(w.log.every((r) => r.redirect === 'manual')).toBe(true)
})

test('redirect_to_private_dns_name_is_refused', async () => {
  const w = routed(
    { 'https://pub.test/robots.txt': { body: '' }, 'https://pub.test/go': { status: 301, headers: { location: 'https://inner.test/x' } }, 'https://inner.test/x': { body: 'in' } },
    { resolve: async (h) => (h === 'inner.test' ? ['10.0.0.9'] : ['93.184.216.34']) },
  )
  await expect(w.fetcher.get('https://pub.test/go')).rejects.toThrow(/not a public website/)
})

test('redirect_hop_obeys_robots_and_host_gap', async () => {
  const w = routed({
    'https://a.test/robots.txt': { body: '' },
    'https://a.test/go': { status: 302, headers: { location: 'https://b.test/page' } },
    'https://b.test/robots.txt': { body: ['User-agent: *', 'Disallow: /page'].join(String.fromCharCode(10)) },
    'https://b.test/page': { body: 'nope' },
  })
  await expect(w.fetcher.get('https://a.test/go')).rejects.toThrow(/asks not to be read/)
  expect(w.log.map((r) => r.url)).not.toContain('https://b.test/page')
  expect(w.log.map((r) => r.url)).toContain('https://b.test/robots.txt')
})

test('redirect_followed_to_another_public_page', async () => {
  const w = routed({
    'https://a.test/robots.txt': { body: '' },
    'https://a.test/old': { status: 301, headers: { location: '/new' } },
    'https://a.test/new': { body: 'fresh' },
  })
  const res = await w.fetcher.get('https://a.test/old')
  expect(res.text).toBe('fresh')
  expect(res.url).toBe('https://a.test/new')
})

test('redirect_loop_stops', async () => {
  const w = routed({ 'https://a.test/robots.txt': { body: '' }, 'https://a.test/x': { status: 302, headers: { location: '/x' } } })
  await expect(w.fetcher.get('https://a.test/x')).rejects.toThrow(/kept redirecting/)
})

test('body_is_cut_at_the_cap_and_the_stream_stopped', async () => {
  let pulled = 0
  let cancelled = false
  const stream = () =>
    new globalThis.Response(
      new globalThis.ReadableStream({
        pull(controller) {
          pulled++
          // Endless: if the cap did not stop the read, this test would never finish.
          controller.enqueue(new globalThis.TextEncoder().encode('x'.repeat(100_000)))
        },
        cancel() {
          cancelled = true
        },
      }),
      { status: 200 },
    )
  const w = routed({ 'https://big.test/robots.txt': { body: '' }, 'https://big.test/huge': stream })
  const res = await w.fetcher.get('https://big.test/huge')
  expect(res.text.length).toBe(2_000_000)
  expect(cancelled).toBe(true)
  expect(pulled).toBeLessThan(40)
})
