// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Signing in to Microsoft, and talking to Microsoft Graph once signed in.
 *
 * The owner registers their own public-client app in Microsoft Entra (README). This file runs
 * the **device code flow** Microsoft documents for apps without a browser of their own:
 *
 * 1. `POST /{tenant}/oauth2/v2.0/devicecode` with the client id and the scopes. Microsoft
 *    answers with a short **user code** for a person and a long **device code** for us.
 * 2. The owner opens the verification page anywhere and types the user code.
 * 3. We poll `POST /{tenant}/oauth2/v2.0/token` at the interval Microsoft gave, until it hands
 *    back tokens, says no, or the code runs out.
 *
 * **What is shown, and what never is.** The user code and the verification URL are meant for
 * a person and are shown. The device code, the access token and the refresh token never go
 * into a tool result, a status line, a log line or an error: errors are sentences of our own,
 * never Microsoft's response body. The access token lives in this process's memory only; the
 * refresh token is a `password` setting, so it sits in the system keychain.
 */

export const AUTHORITY = 'https://login.microsoftonline.com'
export const GRAPH = 'https://graph.microsoft.com/v1.0'

/** What the plugin asks for, and nothing more. The README says why each one. P3-24 adds `Mail.Send`. */
export const SCOPES = ['offline_access', 'Calendars.ReadWrite', 'Mail.Read', 'Contacts.Read', 'User.Read']

export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

export const NOT_CONNECTED = 'Microsoft is not connected. Open Plugins › Microsoft 365 › Connect.'
export const REFUSED = 'Microsoft refused the sign-in; connect again.'
export const EXPIRED = 'The sign-in code ran out before it was used. Press Connect again for a new one.'
export const DECLINED = 'The sign-in was declined at Microsoft, so nothing was connected.'
/** The DY-02 limit (PHASE.md *Owner needs* 4), word for word. */
export const CONSENT_REFUSED = 'Your organisation does not allow Alexia to connect. Ask its IT, or use a personal account.'
export const UNREACHABLE = 'Could not reach Microsoft. Check the internet connection and try again.'

/**
 * The AADSTS codes that mean the account's organisation will not let this app in: consent
 * required or refused by policy (65001, 90094, 90095), blocked by Conditional Access (53003),
 * the user not assigned to the app (50105), the tenant blocking users from consenting
 * (90099 — admin approval). A personal account never sees them.
 */
export const CONSENT_CODES = [65001, 90094, 90095, 90099, 53003, 50105]

/** An error whose message is a sentence for a person. Never carries an HTTP body. */
export class MicrosoftError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'MicrosoftError'
    if (status !== undefined) this.status = status
  }
}

/**
 * The tenant from the setting: `common` when empty. A GUID, a domain, `common`,
 * `organizations` or `consumers` — anything else is refused rather than put in a URL.
 */
export function tenantOf(setting) {
  const text = String(setting ?? '').trim()
  if (text === '') return 'common'
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(text)) {
    throw new MicrosoftError('The tenant is not one Microsoft would know: use "common", your organisation’s domain or its tenant ID.')
  }
  return text
}

export const deviceCodeUrl = (tenant) => `${AUTHORITY}/${encodeURIComponent(tenant)}/oauth2/v2.0/devicecode`
export const tokenUrl = (tenant) => `${AUTHORITY}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`

/** The numbers in Microsoft's `error_codes`, or the `AADSTSnnnn` in its description. */
export function errorCodes(json) {
  const listed = Array.isArray(json?.error_codes) ? json.error_codes.map(Number).filter(Number.isFinite) : []
  const said = [...String(json?.error_description ?? '').matchAll(/AADSTS(\d+)/g)].map((m) => Number(m[1]))
  return [...new Set([...listed, ...said])]
}

/**
 * **What a token-endpoint error means**, as a sentence. Never the body: Microsoft's
 * description carries trace and correlation ids, and sometimes the codes themselves.
 */
export function tokenFailure(json, status) {
  const codes = errorCodes(json)
  if (codes.some((c) => CONSENT_CODES.includes(c))) return new MicrosoftError(CONSENT_REFUSED, status)
  const error = String(json?.error ?? '')
  if (error === 'expired_token' || codes.includes(70020)) return new MicrosoftError(EXPIRED, status)
  if (error === 'authorization_declined' || codes.includes(70019) || codes.includes(65004)) return new MicrosoftError(DECLINED, status)
  if (codes.includes(700016) || error === 'unauthorized_client') {
    return new MicrosoftError('Microsoft does not know that client ID, or it is not a public client. Check the app registration (README).', status)
  }
  return new MicrosoftError(REFUSED, status)
}

/** POST a form to Microsoft. Returns `{ status, json }`; a network failure is a sentence. */
async function post(fetchImpl, url, form) {
  let res
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    })
  } catch {
    throw new MicrosoftError(UNREACHABLE)
  }
  let json
  try {
    json = await res.json()
  } catch {
    json = undefined
  }
  return { status: res.status, ok: res.ok, json }
}

/**
 * **Step 1: ask for a code.** Resolves `{ deviceCode, userCode, verificationUri, expiresAt,
 * interval }` — `interval` in ms, at least one second.
 */
export async function startDeviceCode({ fetch: fetchImpl = fetch, clientId, tenant = 'common', scopes = SCOPES, now = Date.now() }) {
  const got = await post(fetchImpl, deviceCodeUrl(tenant), { client_id: clientId, scope: scopes.join(' ') })
  if (!got.ok) {
    if (got.json && typeof got.json === 'object') throw tokenFailure(got.json, got.status)
    throw new MicrosoftError(`Microsoft could not start the sign-in just now (status ${got.status}).`, got.status)
  }
  const j = got.json ?? {}
  if (typeof j.device_code !== 'string' || typeof j.user_code !== 'string' || typeof j.verification_uri !== 'string') {
    throw new MicrosoftError('Microsoft answered the sign-in with something Alexia could not read.')
  }
  const seconds = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
  return {
    deviceCode: j.device_code,
    userCode: j.user_code,
    verificationUri: j.verification_uri,
    expiresAt: now + seconds(j.expires_in, 900) * 1000,
    interval: Math.max(1, seconds(j.interval, 5)) * 1000,
  }
}

const lifetime = (json) => (Number.isFinite(Number(json?.expires_in)) ? Number(json.expires_in) * 1000 : 3600 * 1000)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * **Step 3: poll until done.** Asks the token endpoint every `interval` ms (five seconds more
 * after each `slow_down`, as RFC 8628 §3.5 asks) while Microsoft says `authorization_pending`.
 * Resolves `{ accessToken, refreshToken, expiresAt }`; rejects with a {@link MicrosoftError}
 * when the code runs out ({@link EXPIRED}), the owner says no, the organisation refuses
 * ({@link CONSENT_REFUSED}), or `stopped()` turns true.
 *
 * `sleep` and `clock` are passed in so a test runs the whole loop without waiting.
 */
export async function pollToken({
  fetch: fetchImpl = fetch,
  clientId,
  tenant = 'common',
  deviceCode,
  interval = 5000,
  expiresAt,
  clock = Date.now,
  sleep = wait,
  stopped = () => false,
}) {
  let every = Math.max(1000, interval)
  for (;;) {
    if (clock() >= expiresAt) throw new MicrosoftError(EXPIRED)
    await sleep(every)
    if (stopped()) throw new MicrosoftError('The sign-in was stopped.')
    if (clock() >= expiresAt) throw new MicrosoftError(EXPIRED)
    const got = await post(fetchImpl, tokenUrl(tenant), { grant_type: DEVICE_GRANT, client_id: clientId, device_code: deviceCode })
    if (got.ok) {
      const j = got.json ?? {}
      if (typeof j.access_token !== 'string') throw new MicrosoftError('Microsoft answered the sign-in with something Alexia could not read.')
      if (typeof j.refresh_token !== 'string' || j.refresh_token === '') {
        throw new MicrosoftError('Microsoft signed in but gave no lasting permission. Connect again and allow it to stay signed in.')
      }
      return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: clock() + lifetime(j) }
    }
    const error = String(got.json?.error ?? '')
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') {
      every += 5000
      continue
    }
    if (got.json && typeof got.json === 'object') throw tokenFailure(got.json, got.status)
    throw new MicrosoftError(`Microsoft could not sign in just now (status ${got.status}).`, got.status)
  }
}

/**
 * A new access token from the refresh token. Microsoft may hand back a **new** refresh token
 * too (they rotate); it is returned so the caller keeps the newest.
 */
export async function refreshAccess({ fetch: fetchImpl = fetch, clientId, tenant = 'common', refreshToken, scopes = SCOPES, now = Date.now() }) {
  const got = await post(fetchImpl, tokenUrl(tenant), {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
    scope: scopes.join(' '),
  })
  if (!got.ok) {
    if (got.status >= 500) throw new MicrosoftError(`Microsoft could not sign in just now (status ${got.status}).`, got.status)
    throw tokenFailure(got.json ?? {}, got.status)
  }
  const j = got.json ?? {}
  if (typeof j.access_token !== 'string') throw new MicrosoftError(REFUSED)
  return {
    accessToken: j.access_token,
    ...(typeof j.refresh_token === 'string' && j.refresh_token !== '' && j.refresh_token !== refreshToken && { refreshToken: j.refresh_token }),
    expiresAt: now + lifetime(j),
  }
}

/**
 * **The access token, kept in memory only.** `read` returns the current settings
 * (`client_id`, `tenant`, `refresh_token`); a token is refreshed a minute before it runs out,
 * or when Graph says it no longer takes it ({@link forget}). A rotated refresh token goes to
 * `rotate`, which keeps it.
 */
export class Tokens {
  #access
  #expiresAt = 0
  #pending

  constructor({ read, fetch: fetchImpl = fetch, clock = Date.now, rotate = async () => {} }) {
    this.read = read
    this.fetch = fetchImpl
    this.clock = clock
    this.rotate = rotate
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
    if (!s.client_id || !s.refresh_token) throw new MicrosoftError(NOT_CONNECTED)
    const got = await refreshAccess({
      fetch: this.fetch,
      clientId: s.client_id,
      tenant: tenantOf(s.tenant),
      refreshToken: s.refresh_token,
      now: this.clock(),
    })
    this.#access = got.accessToken
    this.#expiresAt = got.expiresAt
    if (got.refreshToken) await this.rotate(got.refreshToken).catch(() => {})
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

/** The sentence for a Graph status. Never the body. */
export function apiError(status) {
  if (status === 401) return new MicrosoftError(REFUSED, status)
  if (status === 403) return new MicrosoftError('Microsoft did not allow that. Connect again and allow every permission it asks for.', status)
  if (status === 404) return new MicrosoftError('Microsoft could not find that.', status)
  if (status === 429) return new MicrosoftError('Microsoft asked Alexia to slow down. Try again in a minute.', status)
  return new MicrosoftError(`Microsoft could not answer just now (status ${status}).`, status)
}

/**
 * One authorised Graph call. `req` is `{ url, method?, body?, headers? }` as the request
 * builders make it. A 401 drops the access token and tries once more with a fresh one; a
 * second 401 means the sign-in itself is gone.
 */
export async function call(tokens, req, fetchImpl = tokens.fetch) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await tokens.access()
    let res
    try {
      res = await fetchImpl(req.url, {
        method: req.method ?? 'GET',
        headers: {
          ...(req.headers ?? {}),
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(req.body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(req.body !== undefined && { body: JSON.stringify(req.body) }),
      })
    } catch {
      throw new MicrosoftError(UNREACHABLE)
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
      throw new MicrosoftError('Microsoft answered with something Alexia could not read.')
    }
  }
  throw new MicrosoftError(REFUSED, 401)
}
