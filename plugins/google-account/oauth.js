// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

/**
 * Signing in to Google, and talking to it once signed in.
 *
 * The owner makes their own Desktop OAuth client (README); this file runs the loopback flow
 * Google documents for installed apps: PKCE S256, a one-shot listener on `127.0.0.1` port 0,
 * a `state` that must come back unchanged, then a code exchanged for tokens.
 *
 * **Where the tokens live.** The access token is kept in this process's memory and nowhere
 * else. The refresh token is a `password` setting, so it sits in the system keychain. Neither
 * is ever put in a tool result, a log line or an error: errors are sentences of our own, never
 * Google's response body, and the sign-in URL's query is never logged.
 */

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** What the plugin asks for, and nothing more. The README says why each one. */
export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
]

/** The path Google is sent back to. Anything else on the listener is a 404. */
export const REDIRECT_PATH = '/oauth/google'

/** How long the listener waits for the browser before giving up. */
export const LISTEN_MS = 5 * 60 * 1000

export const NOT_CONNECTED = 'Google is not connected. Open Plugins › Google › Connect.'
export const REFUSED = 'Google refused the sign-in; connect again.'

/** An error whose message is a sentence for a person. Never carries an HTTP body. */
export class GoogleError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'GoogleError'
    if (status !== undefined) this.status = status
  }
}

const base64url = (bytes) => Buffer.from(bytes).toString('base64url')

/** The S256 challenge for a verifier: base64url(sha256(verifier)), no padding (RFC 7636 §4.2). */
export const challengeOf = (verifier) => createHash('sha256').update(verifier, 'ascii').digest('base64url')

/** A fresh PKCE pair. The verifier is 43 characters of base64url, as RFC 7636 asks. */
export function pkce() {
  const verifier = base64url(randomBytes(32))
  return { verifier, challenge: challengeOf(verifier), method: 'S256' }
}

/** A fresh, unguessable `state`. */
export const newState = () => base64url(randomBytes(24))

/** True when two strings are equal, compared in constant time. */
export function sameState(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The consent page's address. `offline` and `consent` so Google hands back a refresh token. */
export function authUrl({ clientId, redirectUri, challenge, state, scopes = SCOPES }) {
  const url = new URL(AUTH_URL)
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  }).toString()
  return url.toString()
}

const PAGE = (title, line) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5">` +
  `<h1 style="font-size:1.3rem">${title}</h1><p>${line}</p></body></html>`

/**
 * **The one-shot loopback listener.** Binds `127.0.0.1` on a port the system picks — never
 * `0.0.0.0`, never `localhost` (which may resolve to another interface) — and accepts exactly
 * one request: the redirect path, carrying the `state` this sign-in made. A wrong path is a
 * 404 and a wrong `state` is refused; neither ends the wait. The first good request (a code,
 * or Google saying no) is answered with a plain page and the listener closes. So does the
 * timeout.
 *
 * Resolves `{ port, redirectUri, result, close }`, where `result` settles with `{ code }` or
 * rejects with a {@link GoogleError}.
 */
export function listen({ state, timeoutMs = LISTEN_MS, path = REDIRECT_PATH } = {}) {
  if (typeof state !== 'string' || state === '') throw new Error('listen needs the state it is waiting for')
  let settle
  const result = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })
  let done = false

  const server = createServer((req, res) => {
    const answer = (status, title, line) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' })
      res.end(PAGE(title, line))
    }
    if (done) return answer(410, 'Already finished', 'This sign-in is over. You can close this tab.')
    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      return answer(400, 'Not understood', 'This address is not one Alexia understands.')
    }
    if (req.method !== 'GET' || url.pathname !== path) return answer(404, 'Not here', 'There is nothing at this address.')
    if (!sameState(url.searchParams.get('state'), state)) {
      return answer(400, 'Not this sign-in', 'This link is not from the sign-in Alexia started. Nothing was changed.')
    }
    const code = url.searchParams.get('code')
    if (url.searchParams.has('error') || !code) {
      answer(200, 'Not connected', 'Google did not connect. You can close this tab and try again from Alexia.')
      finish(new GoogleError(REFUSED))
      return
    }
    answer(200, 'Connected', 'You can close this tab.')
    finish(undefined, { code })
  })

  const timer = setTimeout(() => finish(new GoogleError('The sign-in took too long; connect again.')), timeoutMs)
  timer.unref?.()

  function finish(error, value) {
    if (done) return
    done = true
    clearTimeout(timer)
    // Let the page reach the browser, then stop listening and drop any idle connection.
    server.close()
    setImmediate(() => server.closeAllConnections?.())
    if (error) settle.reject(error)
    else settle.resolve(value)
  }

  // A caller that never awaits `result` (the timeout fired after it gave up) must not crash.
  result.catch(() => {})

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
      const { port, address } = server.address()
      resolve({
        port,
        address,
        redirectUri: `http://127.0.0.1:${port}${path}`,
        result,
        close: () => finish(new GoogleError('The sign-in was stopped.')),
      })
    })
  })
}

/** POST a form to the token endpoint. Never surfaces the body: Google's or ours. */
async function tokenCall(fetchImpl, form) {
  let res
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    })
  } catch {
    throw new GoogleError('Could not reach Google. Check the internet connection and try again.')
  }
  if (res.status === 400 || res.status === 401) throw new GoogleError(REFUSED, res.status)
  if (!res.ok) throw new GoogleError(`Google could not sign in just now (status ${res.status}).`, res.status)
  let json
  try {
    json = await res.json()
  } catch {
    throw new GoogleError('Google answered the sign-in with something Alexia could not read.')
  }
  if (typeof json?.access_token !== 'string') throw new GoogleError(REFUSED)
  return json
}

const lifetime = (json) => (Number.isFinite(Number(json.expires_in)) ? Number(json.expires_in) * 1000 : 3600 * 1000)

/** The code from the listener, exchanged for tokens. */
export async function exchangeCode({ fetch: fetchImpl = fetch, clientId, clientSecret, code, verifier, redirectUri, now = Date.now() }) {
  const json = await tokenCall(fetchImpl, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    redirect_uri: redirectUri,
  })
  if (typeof json.refresh_token !== 'string' || json.refresh_token === '') {
    throw new GoogleError('Google signed in but gave no lasting permission. Remove Alexia at myaccount.google.com/permissions and connect again.')
  }
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: now + lifetime(json) }
}

/** A new access token from the refresh token. */
export async function refreshAccess({ fetch: fetchImpl = fetch, clientId, clientSecret, refreshToken, now = Date.now() }) {
  const json = await tokenCall(fetchImpl, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
  })
  return { accessToken: json.access_token, expiresAt: now + lifetime(json) }
}

/**
 * **The access token, kept in memory only.** `read` returns the current settings
 * (`client_id`, `client_secret`, `refresh_token`); a token is refreshed a minute before it
 * runs out, or when Google says it no longer takes it ({@link forget}).
 */
export class Tokens {
  #access
  #expiresAt = 0
  #pending

  constructor({ read, fetch: fetchImpl = fetch, clock = Date.now }) {
    this.read = read
    this.fetch = fetchImpl
    this.clock = clock
  }

  /** Whether settings hold everything a refresh needs. */
  async connected() {
    const s = await this.read()
    return Boolean(s.client_id && s.refresh_token)
  }

  async access() {
    if (this.#access && this.clock() < this.#expiresAt - 60_000) return this.#access
    // One refresh at a time: a burst of calls shares it.
    this.#pending ??= this.#refresh().finally(() => {
      this.#pending = undefined
    })
    return this.#pending
  }

  async #refresh() {
    const s = await this.read()
    if (!s.client_id || !s.refresh_token) throw new GoogleError(NOT_CONNECTED)
    const got = await refreshAccess({
      fetch: this.fetch,
      clientId: s.client_id,
      clientSecret: s.client_secret,
      refreshToken: s.refresh_token,
      now: this.clock(),
    })
    this.#access = got.accessToken
    this.#expiresAt = got.expiresAt
    return got.accessToken
  }

  /** Hold this one in memory, straight from a sign-in. */
  hold(accessToken, expiresAt) {
    this.#access = accessToken
    this.#expiresAt = expiresAt
  }

  forget() {
    this.#access = undefined
    this.#expiresAt = 0
  }
}

/** The sentence for an API status. Never the body. */
export function apiError(status) {
  if (status === 401) return new GoogleError(REFUSED, status)
  if (status === 403) return new GoogleError('Google did not allow that. Connect again and allow every permission it asks for.', status)
  if (status === 404) return new GoogleError('Google could not find that.', status)
  if (status === 429) return new GoogleError('Google asked Alexia to slow down. Try again in a minute.', status)
  return new GoogleError(`Google could not answer just now (status ${status}).`, status)
}

/**
 * One authorised call. `req` is `{ url, method?, body? }` as the request builders make it.
 * A 401 drops the access token and tries once more with a fresh one; a second 401 means the
 * sign-in itself is gone.
 */
export async function call(tokens, req, fetchImpl = tokens.fetch) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await tokens.access()
    let res
    try {
      res = await fetchImpl(req.url, {
        method: req.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(req.body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(req.body !== undefined && { body: JSON.stringify(req.body) }),
      })
    } catch {
      throw new GoogleError('Could not reach Google. Check the internet connection and try again.')
    }
    if (res.status === 401 && attempt === 0) {
      tokens.forget()
      continue
    }
    if (!res.ok) throw apiError(res.status)
    if (res.status === 204) return {}
    try {
      return await res.json()
    } catch {
      throw new GoogleError('Google answered with something Alexia could not read.')
    }
  }
  throw new GoogleError(REFUSED, 401)
}
