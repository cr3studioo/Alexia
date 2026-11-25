// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { findLoginForm, createPortal } from '../portal.js'

// Built at run time, so no secret-looking literal sits in the file.
const PASSWORD = ['correct', 'horse', 'battery'].join('-')
const BASE = 'https://portal.test'

const LOGIN = `<html><body><h1>Sign in</h1>
<form method="post" action="/session">
  <input type="hidden" name="csrf" value="tok123">
  <input type="text" name="username">
  <input type="password" name="passwd">
  <input type="submit" value="Go">
</form></body></html>`

const headers = (pairs) => {
  const h = new globalThis.Headers()
  for (const [k, v] of pairs) h.append(k, v)
  return h
}

/** A school portal: a login form, a session cookie, and two pages behind it. */
function site({ accept = true } = {}) {
  const seen = []
  const request = async (url, options = {}) => {
    const u = new URL(url)
    const method = options.method ?? 'GET'
    const cookie = options.headers?.cookie ?? ''
    seen.push({ method, path: u.pathname, body: options.body, cookie })
    const reply = (status, text, extra = []) => ({ status, headers: headers(extra), text, url })
    if (u.pathname === '/login') return reply(200, LOGIN, [['set-cookie', 'anon=1; Path=/; HttpOnly']])
    if (u.pathname === '/session' && method === 'POST') {
      const form = new URLSearchParams(options.body)
      if (accept && form.get('username') === 'ann' && form.get('passwd') === PASSWORD && form.get('csrf') === 'tok123') {
        return reply(302, '', [['location', '/home'], ['set-cookie', 'sess=abc; Path=/']])
      }
      return reply(200, `${LOGIN}<p>Wrong user name or password.</p>`)
    }
    if (!cookie.includes('sess=abc')) return reply(200, LOGIN)
    if (u.pathname === '/home') return reply(200, '<html><body><main>Welcome Ann</main></body></html>')
    if (u.pathname === '/grades') return reply(200, '<html><body><nav>Menu</nav><main><p>Math: 1</p><p>Czech: 2</p></main></body></html>')
    return reply(404, 'nope')
  }
  return { request, seen }
}

const cfg = { url: `${BASE}/login`, user: 'ann', password: PASSWORD, pages: ['/grades', '/missing'] }

test('login_then_pages', async () => {
  const s = site()
  const portal = createPortal({ request: s.request })
  const result = await portal.read(cfg)
  expect(result.ok).toBe(true)
  expect(result.pages[0]).toEqual({ url: `${BASE}/grades`, text: 'Math: 1\nCzech: 2' })
  expect(result.pages[1]).toMatchObject({ url: `${BASE}/missing`, error: 'The portal answered 404.' })
  // The only POST is the login form, with its hidden field kept; everything else is a GET.
  const posts = s.seen.filter((r) => r.method !== 'GET')
  expect(posts).toHaveLength(1)
  expect(posts[0].path).toBe('/session')
  expect(new URLSearchParams(posts[0].body).get('csrf')).toBe('tok123')
  // The cookie from the login page rode along with the login, and the session with the pages.
  expect(posts[0].cookie).toContain('anon=1')
  expect(s.seen.find((r) => r.path === '/grades').cookie).toContain('sess=abc')
  // A second visit starts from nothing: no cookie is kept between visits.
  const again = site()
  await createPortal({ request: again.request }).read(cfg)
  expect(again.seen[0].cookie).toBe('')
})

test('failed_login_once_a_day', async () => {
  const s = site({ accept: false })
  let clock = Date.parse('2026-11-25T08:00:00Z')
  let kept = null
  const portal = createPortal({
    request: s.request,
    now: () => clock,
    store: { get: async () => kept, set: async (v) => void (kept = v) },
  })
  const first = await portal.read(cfg)
  expect(first.ok).toBe(false)
  expect(first.reason).toContain('did not accept the sign-in')
  const posts = () => s.seen.filter((r) => r.method === 'POST').length
  expect(posts()).toBe(1)

  // The next rounds in the same day do not touch the portal at all.
  clock += 60 * 60_000
  const second = await portal.read(cfg)
  clock += 2 * 60 * 60_000
  await portal.read(cfg)
  expect(second.ok).toBe(false)
  expect(second.waiting).toBe(true)
  expect(posts()).toBe(1)
  expect(s.seen).toHaveLength(2)

  // One Low notice, with the day in its key.
  const notice = await portal.notice()
  expect(notice).toHaveLength(1)
  expect(notice[0]).toMatchObject({ key: 'pagewatch:portal:login:2026-11-25', urgency: 'low' })

  // Changing the settings clears the wait; so does a new day.
  await portal.reset()
  await portal.read(cfg)
  expect(posts()).toBe(2)
  clock += 25 * 60 * 60_000
  await portal.read(cfg)
  expect(posts()).toBe(3)
  expect((await portal.notice())[0].key).toBe('pagewatch:portal:login:2026-11-26')
})

test('password_never_in_output', async () => {
  const outputs = []
  // A portal that fails in awkward ways, one of which echoes the password in an error.
  const echo = async (url, options = {}) => {
    if (options.method === 'POST') throw new Error(`socket closed while sending ${options.body}`)
    return { status: 200, headers: headers([]), text: LOGIN, url }
  }
  for (const request of [echo, site({ accept: false }).request, site().request]) {
    const portal = createPortal({ request })
    const result = await portal.read(cfg)
    outputs.push(JSON.stringify(result), JSON.stringify(await portal.notice()), String(await portal.refusal()))
  }
  for (const out of outputs) expect(out).not.toContain(PASSWORD)
})

test('a_login_made_of_scripts_says_it_needs_the_browser', async () => {
  const request = async (url) => ({ status: 200, headers: headers([]), text: '<html><body><div id="app"></div><script src="/app.js"></script></body></html>', url })
  const result = await createPortal({ request }).read(cfg)
  expect(result.ok).toBe(false)
  expect(result.reason).toContain('needs the browser')
})

test('a_form_that_posts_to_another_site_is_not_filled_in', async () => {
  const seen = []
  const request = async (url, options = {}) => {
    seen.push(options.method ?? 'GET')
    return { status: 200, headers: headers([]), text: LOGIN.replace('/session', 'https://evil.test/collect'), url }
  }
  const result = await createPortal({ request }).read(cfg)
  expect(result.ok).toBe(false)
  expect(seen).toEqual(['GET'])
})

test('the_login_form_is_found_by_its_password_field', () => {
  const form = findLoginForm(LOGIN, `${BASE}/login`)
  expect(form).toMatchObject({ action: `${BASE}/session`, userField: 'username', passwordField: 'passwd', fields: [['csrf', 'tok123']] })
  expect(findLoginForm('<form action="/search"><input name="q"></form>', BASE)).toBeUndefined()
})

test('http_portal_url_refused_before_any_request', async () => {
  const w = site()
  const portal = createPortal({ request: w.request })
  const result = await portal.read({ ...cfg, url: 'http://portal.test/login' })
  expect(result.ok).toBe(false)
  expect(result.reason).toMatch(/https/)
  expect(w.seen).toEqual([])
})

test('http_login_form_action_refused_password_never_sent', async () => {
  const seen = []
  const request = async (url, options = {}) => {
    seen.push({ method: options.method ?? 'GET', url })
    return { status: 200, headers: headers([]), text: LOGIN.replace('action="/session"', 'action="http://portal.test/session"'), url }
  }
  const result = await createPortal({ request }).read(cfg)
  expect(result.ok).toBe(false)
  expect(result.reason).toMatch(/plain http/)
  expect(seen.map((r) => r.method)).toEqual(['GET'])
})
