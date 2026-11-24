// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  authUrl,
  call,
  challengeOf,
  exchangeCode,
  GoogleError,
  listen,
  NOT_CONNECTED,
  pkce,
  REDIRECT_PATH,
  REFUSED,
  SCOPES,
  Tokens,
} from '../oauth.js'
import { fakeGoogle, settingsOf } from './fake.js'

process.env.ALEXIA_PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const { service, tools } = await import('../index.js')

/** A request to the local listener that fails rather than hangs. */
const hit = (url) => fetch(url, { signal: AbortSignal.timeout(20_000) })

describe('oauth', () => {
  test('pkce_challenge_is_s256', () => {
    // RFC 7636 Appendix B.
    expect(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')

    const pair = pkce()
    expect(pair.method).toBe('S256')
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(pair.challenge).toBe(createHash('sha256').update(pair.verifier).digest('base64url'))
    expect(pair.challenge).not.toContain('=')
    expect(pkce().verifier).not.toBe(pair.verifier)

    const url = new URL(authUrl({ clientId: 'id', redirectUri: 'http://127.0.0.1:1/x', challenge: pair.challenge, state: 's' }))
    expect(url.origin).toBe('https://accounts.google.com')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(pair.challenge)
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(SCOPES)
    // The verifier stays here; only the challenge travels.
    expect(url.toString()).not.toContain(pair.verifier)
  })

  test('state_mismatch_refused', async () => {
    const listener = await listen({ state: 'the-right-state' })
    try {
      let settled = false
      void listener.result.then(
        () => (settled = true),
        () => (settled = true),
      )

      const wrong = await hit(`${listener.redirectUri}?code=stolen&state=another-state`)
      expect(wrong.status).toBe(400)
      expect(await wrong.text()).toContain('not from the sign-in Alexia started')
      const none = await hit(`${listener.redirectUri}?code=stolen`)
      expect(none.status).toBe(400)
      const elsewhere = await hit(`http://127.0.0.1:${listener.port}/elsewhere?code=x&state=the-right-state`)
      expect(elsewhere.status).toBe(404)
      await new Promise((r) => setTimeout(r, 50))
      expect(settled).toBe(false)

      const right = await hit(`${listener.redirectUri}?code=the-code&state=the-right-state`)
      expect(right.status).toBe(200)
      expect(await right.text()).toContain('You can close this tab')
      await expect(listener.result).resolves.toEqual({ code: 'the-code' })
    } finally {
      listener.close()
    }
  }, 60_000)

  test('google saying no ends the sign-in with a sentence', async () => {
    const listener = await listen({ state: 'st' })
    const res = await hit(`${listener.redirectUri}?error=access_denied&state=st`)
    expect(res.status).toBe(200)
    await expect(listener.result).rejects.toThrow(REFUSED)
  }, 60_000)

  test('listener_binds_loopback_only', async () => {
    const listener = await listen({ state: 'st' })
    expect(listener.address).toBe('127.0.0.1')
    expect(listener.port).toBeGreaterThan(0)
    expect(listener.redirectUri).toBe(`http://127.0.0.1:${listener.port}${REDIRECT_PATH}`)

    // One request, then it is gone.
    expect((await hit(`${listener.redirectUri}?code=c&state=st`)).status).toBe(200)
    await listener.result
    await new Promise((r) => setTimeout(r, 200))
    await expect(hit(`${listener.redirectUri}?code=c&state=st`)).rejects.toThrow()

    // And it does not wait for ever.
    const idle = await listen({ state: 'st', timeoutMs: 300 })
    await expect(idle.result).rejects.toThrow('took too long')
    await new Promise((r) => setTimeout(r, 200))
    await expect(hit(`${idle.redirectUri}?code=c&state=st`)).rejects.toThrow()
  }, 60_000)

  test('the code is exchanged with the verifier, and a refresh uses the token endpoint', async () => {
    const google = fakeGoogle()
    const got = await exchangeCode({ fetch: google.fetch, clientId: 'id', clientSecret: 'cs', code: 'c0de', verifier: 'v3rifier', redirectUri: 'http://127.0.0.1:9/x', now: 1000 })
    expect(got).toEqual({ accessToken: google.access, refreshToken: google.refresh, expiresAt: 1000 + 3599_000 })
    const form = new URLSearchParams(google.calls[0].body)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code_verifier')).toBe('v3rifier')
    expect(form.get('redirect_uri')).toBe('http://127.0.0.1:9/x')

    let now = 0
    const { settings } = settingsOf(google)
    const tokens = new Tokens({ read: settings, fetch: google.fetch, clock: () => now })
    expect(await tokens.access()).toBe(google.access)
    expect(await tokens.access()).toBe(google.access)
    expect(google.calls.filter((c) => c.method === 'POST')).toHaveLength(2)
    now = 3599_000 // inside the last minute: refreshed again
    await tokens.access()
    expect(google.calls.filter((c) => c.method === 'POST')).toHaveLength(3)
    expect(new URLSearchParams(google.calls[2].body).get('grant_type')).toBe('refresh_token')
  })

  test('a revoked sign-in and a missing one are sentences, never the body', async () => {
    const google = fakeGoogle()
    const revoked = new Tokens({ read: async () => ({ client_id: 'id', refresh_token: 'not-the-one' }), fetch: google.fetch })
    const error = await revoked.access().catch((e) => e)
    expect(error).toBeInstanceOf(GoogleError)
    expect(error.message).toBe(REFUSED)
    expect(error.message).not.toContain('not-the-one')

    const missing = new Tokens({ read: async () => ({ client_id: 'id' }), fetch: google.fetch })
    await expect(missing.access()).rejects.toThrow(NOT_CONNECTED)

    // An API 401 twice in a row: the sign-in is gone.
    const denied = fakeGoogle((url) => (url.startsWith('https://www.googleapis.com') ? { status: 401, json: { error: 'secret details' } } : undefined))
    const tokens = new Tokens({ read: settingsOf(denied).settings, fetch: denied.fetch })
    const e = await call(tokens, { url: 'https://www.googleapis.com/x' }).catch((x) => x)
    expect(e.message).toBe(REFUSED)
    expect(denied.calls.filter((c) => c.method === 'POST')).toHaveLength(2)
  })

  test('refresh_token_never_in_tool_output', async () => {
    const google = fakeGoogle((url) => {
      if (url.includes('/calendar/v3/')) return { status: 200, json: { items: [{ id: 'e1', summary: 'Deadline thesis', start: { dateTime: '2030-01-01T10:00:00Z' }, end: { dateTime: '2030-01-01T11:00:00Z' } }] } }
      if (url.includes('/messages/m1')) return { status: 200, json: { id: 'm1', threadId: 't1', labelIds: ['INBOX'], snippet: 'hi', payload: { mimeType: 'text/plain', headers: [], body: { data: Buffer.from('hello').toString('base64url') } } } }
      if (url.includes('/messages')) return { status: 200, json: { messages: [{ id: 'm1', threadId: 't1' }] } }
      if (url.includes('people:searchContacts')) return { status: 200, json: { results: [{ person: { names: [{ displayName: 'Ann' }] } }] } }
      return undefined
    })
    const { values, settings } = settingsOf(google, { refresh_token: '' })
    const kept = {}
    const lines = []
    const outputs = []
    const svc = service({
      settings,
      keep: async (key, value) => {
        kept[key] = value
        values[key] = value
      },
      status: async (line) => void lines.push(line),
      fetch: google.fetch,
      clock: () => Date.parse('2030-01-01T08:00:00Z'),
      // The browser: follow Google's page straight back to the listener with a code.
      open: async (link) => {
        const url = new URL(link)
        await hit(`${url.searchParams.get('redirect_uri')}?code=c&state=${url.searchParams.get('state')}`)
        return true
      },
    })

    outputs.push(await svc.calendarEvents({ from: '2030-01-01', to: '2030-01-02' })) // not connected yet
    const connecting = await svc.connect()
    outputs.push(connecting)
    expect(await connecting.finished).toBe(true)
    expect(kept.refresh_token).toBe(google.refresh)
    expect(lines.at(-1)).toBe('● Connected')

    for (const [name, , handler] of tools(svc)) {
      if (name === 'connect') continue
      outputs.push(await handler({ from: '2030-01-01', to: '2030-01-02', id: 'm1', query: 'Ann', title: 'x', start: '2030-01-03', now: Date.parse('2030-01-01T08:00:00Z') }))
    }
    // And a revoked token on the way out.
    values.refresh_token = 'revoked-elsewhere'
    svc.forget()
    outputs.push(await svc.mailList({}))

    expect(outputs.filter((o) => !o.isError).length).toBeGreaterThanOrEqual(7)
    expect(outputs.at(-1).content[0].text).toBe(REFUSED)
    const seen = JSON.stringify([outputs, lines])
    expect(seen).not.toContain(google.refresh)
    expect(seen).not.toContain(google.access)
    expect(seen).not.toContain(values.client_secret)
    expect(seen).not.toContain('revoked-elsewhere')
  }, 60_000)

  test('connect without a host that opens links hands back the link', async () => {
    const google = fakeGoogle()
    const { settings } = settingsOf(google, { refresh_token: '' })
    const svc = service({ settings, keep: async () => {}, fetch: google.fetch, listenMs: 2_000 })
    const result = await svc.connect()
    expect(result.content[0].text).toContain('https://accounts.google.com/')
    expect(result._meta['alexia/card'].url).toMatch(/^https:\/\/accounts\.google\.com\//)
    expect(await result.finished).toBe(false)

    const empty = service({ settings: async () => ({}), keep: async () => {}, fetch: google.fetch })
    const refused = await empty.connect()
    expect(refused.isError).toBe(true)
  }, 60_000)
})
