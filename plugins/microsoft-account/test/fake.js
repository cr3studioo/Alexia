// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'
import { AUTHORITY, DEVICE_GRANT } from '../oauth.js'

/**
 * A stand-in for Microsoft. `route(url, init)` returns `{ status, json }`; the identity
 * endpoints (`/devicecode`, `/token`) are answered here unless `route` answers them first.
 * Every call is recorded with its method, URL, body and headers.
 *
 * The device code flow is played out for real: the token endpoint says
 * `authorization_pending` for the first `pending` polls, then hands out tokens. Token and code
 * values are made at runtime, so no file holds anything shaped like a real credential.
 */
export function fakeMicrosoft(route = () => undefined, { pending = 2, expiresIn = 900, interval = 5 } = {}) {
  const access = ['access', randomUUID()].join('-')
  const refresh = ['refresh', randomUUID()].join('-')
  const deviceCode = ['device', randomUUID()].join('-')
  const userCode = 'ABCD-EFGH'
  const calls = []
  let polls = 0
  const fetch = async (input, init = {}) => {
    const url = String(input)
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? init.body : undefined
    calls.push({ url, method, body, headers: init.headers ?? {} })
    let answer = await route(url, { ...init, method })
    if (answer === undefined && url.startsWith(AUTHORITY)) {
      const form = new URLSearchParams(body)
      if (url.endsWith('/oauth2/v2.0/devicecode')) {
        answer = {
          status: 200,
          json: {
            device_code: deviceCode,
            user_code: userCode,
            verification_uri: 'https://microsoft.com/devicelogin',
            expires_in: expiresIn,
            interval,
            message: `To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ${userCode} to authenticate.`,
          },
        }
      } else if (url.endsWith('/oauth2/v2.0/token') && form.get('grant_type') === DEVICE_GRANT) {
        if (form.get('device_code') !== deviceCode) answer = { status: 400, json: { error: 'bad_verification_code', error_codes: [70000] } }
        else if (polls++ < pending) answer = { status: 400, json: { error: 'authorization_pending', error_description: `AADSTS70016: OAuth 2.0 device flow error. Device code ${deviceCode} pending.`, error_codes: [70016] } }
        else answer = { status: 200, json: { token_type: 'Bearer', access_token: access, refresh_token: refresh, expires_in: 3599, scope: 'Calendars.ReadWrite Mail.Read' } }
      } else if (url.endsWith('/oauth2/v2.0/token') && form.get('grant_type') === 'refresh_token') {
        answer =
          form.get('refresh_token') === refresh ?
            { status: 200, json: { token_type: 'Bearer', access_token: access, expires_in: 3599 } }
          : { status: 400, json: { error: 'invalid_grant', error_description: `AADSTS70008: The refresh token ${form.get('refresh_token')} has expired.`, error_codes: [70008] } }
      }
    }
    if (answer === undefined) answer = { status: 404, json: { error: { code: 'ErrorItemNotFound', message: `No route for ${url}` } } }
    if (answer.status === 204) return new globalThis.Response(null, { status: 204 })
    return new globalThis.Response(JSON.stringify(answer.json ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, calls, access, refresh, deviceCode, userCode, polls: () => polls }
}

/** Settings as the host would hand them over, connected unless told otherwise. */
export function settingsOf(ms, extra = {}) {
  const values = { client_id: '11111111-2222-3333-4444-555555555555', tenant: 'common', refresh_token: ms.refresh, ...extra }
  return { values, settings: async () => ({ ...values }) }
}

/** A clock that only moves when the sleeps say so, and the sleep that moves it. */
export function fakeTime(start = Date.parse('2030-03-04T07:00:00Z')) {
  let now = start
  const slept = []
  return {
    clock: () => now,
    sleep: async (ms) => {
      slept.push(ms)
      now += ms
    },
    slept,
    advance: (ms) => {
      now += ms
    },
  }
}
