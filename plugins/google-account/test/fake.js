// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'
import { TOKEN_URL } from '../oauth.js'

/**
 * A stand-in for Google. `route(url, init)` returns `{ status, json }`; the token endpoint is
 * answered here unless `route` answers it first. Every call is recorded with its method, URL
 * and parsed body.
 *
 * Token values are made at runtime, so no file holds anything shaped like a real credential.
 */
export function fakeGoogle(route = () => undefined) {
  const access = ['access', randomUUID()].join('-')
  const refresh = ['refresh', randomUUID()].join('-')
  const calls = []
  const fetch = async (input, init = {}) => {
    const url = String(input)
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? init.body : undefined
    calls.push({ url, method, body, headers: init.headers ?? {} })
    let answer = await route(url, { ...init, method })
    if (answer === undefined && url === TOKEN_URL) {
      const form = new URLSearchParams(body)
      answer =
        form.get('grant_type') === 'refresh_token' ?
          form.get('refresh_token') === refresh ?
            { status: 200, json: { access_token: access, expires_in: 3599, token_type: 'Bearer' } }
          : { status: 400, json: { error: 'invalid_grant', error_description: `Token ${form.get('refresh_token')} has been expired or revoked.` } }
        : { status: 200, json: { access_token: access, refresh_token: refresh, expires_in: 3599, token_type: 'Bearer' } }
    }
    if (answer === undefined) answer = { status: 404, json: { error: { code: 404, message: `No route for ${url}` } } }
    if (answer.status === 204) return new Response(null, { status: 204 })
    return new Response(JSON.stringify(answer.json ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, calls, access, refresh }
}

/** Settings as the host would hand them over, connected unless told otherwise. */
export function settingsOf(google, extra = {}) {
  const values = { client_id: 'test-client.apps.googleusercontent.com', client_secret: ['client', 'secret', 'test'].join('-'), refresh_token: google.refresh, calendars: 'primary', ...extra }
  return { values, settings: async () => ({ ...values }) }
}
