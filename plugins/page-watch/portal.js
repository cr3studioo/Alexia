// SPDX-License-Identifier: AGPL-3.0-only
import { decodeEntities, htmlToText } from './extract.js'
import { WatchError, parseUrl } from './fetch.js'

/**
 * The owner's school portal, read only: sign in through the login form that is on the page,
 * then read the pages they listed. Cookies live in memory for one visit and are gone after it.
 * The only thing ever submitted is the login form; everything else is a GET.
 *
 * A login that is refused is remembered for a day: no retry until tomorrow, or until the owner
 * changes the settings (`reset`). A portal whose login is built by scripts has no form to find;
 * that needs the browser limb (see the README).
 */

const DAY_MS = 24 * 60 * 60_000
const MAX_REDIRECTS = 6

const REFUSED = 'The portal did not accept the sign-in. Check the user name and password in the settings.'
const NO_FORM = 'The portal login page has no form I can fill in. If it signs in with scripts, it needs the browser (see the README).'

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : undefined
}

/** Every `<form>` with an `<input type=password>`: `{ action, fields, userField, passwordField }` for the first one, or undefined. */
export function findLoginForm(html, baseUrl) {
  for (const [, open, body] of String(html ?? '').matchAll(/(<form\b[^>]*>)([\s\S]*?)<\/form\s*>/gi)) {
    const inputs = [...body.matchAll(/<input\b[^>]*>/gi)].map((m) => m[0])
    const password = inputs.find((i) => (attr(i, 'type') ?? '').toLowerCase() === 'password' && attr(i, 'name'))
    if (!password) continue
    const fields = []
    let userField
    for (const input of inputs) {
      const name = attr(input, 'name')
      const type = (attr(input, 'type') ?? 'text').toLowerCase()
      if (!name || input === password) continue
      if (type === 'hidden') fields.push([name, attr(input, 'value') ?? ''])
      else if (['text', 'email', 'tel'].includes(type)) {
        if (!userField || (!/user|login|email|uname|name/i.test(userField) && /user|login|email|uname|name/i.test(name))) userField = name
      }
    }
    if (!userField) continue
    let action
    try {
      action = new URL(attr(open, 'action') || baseUrl, baseUrl).href
    } catch {
      continue
    }
    return { action, fields, userField, passwordField: attr(password, 'name') }
  }
  return undefined
}

/** Does this page ask the visitor to sign in? */
export const isLoginPage = (html, baseUrl) => findLoginForm(html, baseUrl) !== undefined

/** Cookies as `name=value` pairs from a response's headers. */
function setCookies(headers) {
  if (!headers) return []
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const one = headers.get?.('set-cookie')
  return one ? one.split(/,(?=\s*[^;,=\s]+=)/) : []
}

/**
 * `deps`: `request(url, options)` (the polite fetcher's), `now()`, `store` (`get()` and `set(value)`
 * for the one remembered refusal; memory by default).
 */
export function createPortal(deps) {
  const now = deps.now ?? Date.now
  let memory
  const store = deps.store ?? { get: async () => memory, set: async (v) => void (memory = v) }

  /** One visit: a cookie jar that lives and dies with it. */
  function visit(secret) {
    const jar = new Map()
    const scrub = (s) => (secret ? String(s).split(secret).join('…') : String(s))
    const keep = (headers) => {
      for (const line of setCookies(headers)) {
        const [pair, ...flags] = line.split(';')
        const eq = pair.indexOf('=')
        if (eq < 1) continue
        const name = pair.slice(0, eq).trim()
        const value = pair.slice(eq + 1).trim()
        const expired = flags.some((f) => /^\s*max-age\s*=\s*0*$/i.test(f)) || value === ''
        if (expired) jar.delete(name)
        else jar.set(name, value)
      }
    }
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')

    /** A request that follows redirects itself, to the same site only, and always as a GET after the first hop. */
    async function send(start, first = {}) {
      const origin = parseUrl(start).origin
      let url = start
      let options = first
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const res = await deps.request(url, {
          ...options,
          redirect: 'manual',
          headers: { ...(cookie() ? { cookie: cookie() } : {}), ...options.headers },
        })
        keep(res.headers)
        const where = res.status >= 300 && res.status < 400 ? res.headers?.get?.('location') : undefined
        if (!where) return res
        const next = new URL(where, url)
        if (next.origin !== origin) throw new WatchError('The portal sent me to another website, so I stopped.')
        url = next.href
        options = {}
      }
      throw new WatchError('The portal kept redirecting, so I stopped.')
    }
    return { send, scrub }
  }

  /** Sign in and read the pages. `{ ok: true, pages }` or `{ ok: false, reason, refused? }`. Never throws. */
  async function attempt({ url, user, password, pages }) {
    const { send, scrub } = visit(password)
    try {
      const base = parseUrl(url)
      if (base.protocol !== 'https:') return { ok: false, reason: 'The portal address must start with https://, so I did not send a password over plain http.' }
      const front = await send(base.href)
      if (front.status >= 400) return { ok: false, reason: `The portal answered ${front.status}.` }
      const form = findLoginForm(front.text, front.url)
      if (!form) return { ok: false, reason: NO_FORM }
      if (new URL(form.action).protocol !== 'https:') return { ok: false, reason: 'The login form sends the password over plain http, so I did not sign in.' }
      if (new URL(form.action).origin !== base.origin) return { ok: false, reason: 'The login form sends the password to another website, so I did not sign in.' }

      const body = new URLSearchParams(form.fields)
      body.set(form.userField, user)
      body.set(form.passwordField, password)
      const after = await send(form.action, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
      if (after.status >= 400 || isLoginPage(after.text, after.url)) return { ok: false, refused: true, reason: REFUSED }

      const out = []
      for (const path of pages) {
        let target
        try {
          target = new URL(path, base.href)
        } catch {
          out.push({ url: path, error: 'That is not a page address.' })
          continue
        }
        if (target.origin !== base.origin) {
          out.push({ url: target.href, error: 'That page is on another website; only the portal itself is read.' })
          continue
        }
        const res = await send(target.href)
        if (res.status >= 400) out.push({ url: target.href, error: `The portal answered ${res.status}.` })
        else if (isLoginPage(res.text, res.url)) return { ok: false, reason: 'The portal signed me out part way through.' }
        else out.push({ url: target.href, text: htmlToText(res.text) })
      }
      return { ok: true, pages: out }
    } catch (e) {
      return { ok: false, reason: scrub(e instanceof WatchError ? e.message : 'The portal could not be read.') }
    }
  }

  /**
   * Read the portal once, unless a refused login is still being waited out.
   * `cfg`: `{ url, user, password, pages: [path] }`. Nothing here ever retries.
   */
  async function read(cfg) {
    if (!cfg?.url || !cfg.user || !cfg.password) return { ok: false, idle: true, reason: 'The portal is not set up.' }
    const held = await store.get()
    if (held?.failedAt !== undefined && now() - held.failedAt < DAY_MS) return { ok: false, waiting: true, reason: held.reason }
    const result = await attempt(cfg)
    if (result.ok) {
      if (held) await store.set(null)
    } else if (result.refused) {
      await store.set({ failedAt: now(), reason: result.reason })
    }
    return result
  }

  /** The owner changed the settings: try again at the next visit. */
  const reset = () => store.set(null)

  /** One Low notice for a day's refusal, with that day in its key so it is said once. */
  async function notice() {
    const held = await store.get()
    if (held?.failedAt === undefined || now() - held.failedAt >= DAY_MS) return []
    const day = new Date(held.failedAt).toISOString().slice(0, 10)
    return [{ key: `pagewatch:portal:login:${day}`, text: 'I could not sign in to your school portal.', why: held.reason, urgency: 'low' }]
  }

  return { read, reset, notice, refusal: async () => (await store.get())?.reason }
}
