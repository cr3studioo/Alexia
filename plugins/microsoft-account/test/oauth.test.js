// SPDX-License-Identifier: AGPL-3.0-only
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  call,
  CONSENT_REFUSED,
  DECLINED,
  DEVICE_GRANT,
  EXPIRED,
  MicrosoftError,
  NOT_CONNECTED,
  pollToken,
  REFUSED,
  SCOPES,
  startDeviceCode,
  tenantOf,
  tokenFailure,
  Tokens,
} from '../oauth.js'
import { fakeMicrosoft, fakeTime, settingsOf } from './fake.js'

process.env.ALEXIA_PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const { service, tools } = await import('../index.js')

const form = (call) => new URLSearchParams(call.body)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('oauth', () => {
  test('device_code_polls_until_done', async () => {
    const ms = fakeMicrosoft(undefined, { pending: 3, interval: 5 })
    const time = fakeTime()
    const code = await startDeviceCode({ fetch: ms.fetch, clientId: 'cid', tenant: 'contoso.onmicrosoft.com', now: time.clock() })
    expect(code).toEqual({
      deviceCode: ms.deviceCode,
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://microsoft.com/devicelogin',
      expiresAt: time.clock() + 900_000,
      interval: 5000,
    })
    const ask = ms.calls[0]
    expect(ask.method).toBe('POST')
    expect(ask.url).toBe('https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/devicecode')
    expect(form(ask).get('client_id')).toBe('cid')
    expect(form(ask).get('scope')).toBe('offline_access Calendars.ReadWrite Mail.Read Contacts.Read User.Read')
    expect(SCOPES).not.toContain('Mail.Send')

    const got = await pollToken({ fetch: ms.fetch, clientId: 'cid', tenant: 'contoso.onmicrosoft.com', ...code, clock: time.clock, sleep: time.sleep })
    expect(got).toEqual({ accessToken: ms.access, refreshToken: ms.refresh, expiresAt: time.clock() + 3599_000 })
    // Three "pending", then the tokens: four polls, each after the interval Microsoft gave.
    expect(ms.polls()).toBe(4)
    expect(time.slept).toEqual([5000, 5000, 5000, 5000])
    const polls = ms.calls.slice(1)
    expect(polls.every((c) => c.url === 'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token')).toBe(true)
    expect(polls.every((c) => form(c).get('grant_type') === DEVICE_GRANT && form(c).get('device_code') === ms.deviceCode)).toBe(true)

    // `slow_down` adds five seconds to every poll after it (RFC 8628 §3.5).
    let n = 0
    const slow = fakeMicrosoft((url) => (url.endsWith('/token') && n++ === 0 ? { status: 400, json: { error: 'slow_down' } } : undefined), { pending: 0 })
    const t2 = fakeTime()
    const c2 = await startDeviceCode({ fetch: slow.fetch, clientId: 'cid', now: t2.clock() })
    await pollToken({ fetch: slow.fetch, clientId: 'cid', ...c2, clock: t2.clock, sleep: t2.sleep })
    expect(t2.slept).toEqual([5000, 10000])
  })

  test('the real wait between polls is the interval, on a real clock', async () => {
    // One second is the smallest interval; two "pending" answers mean three polls and at least
    // two seconds. Generous upper bound for a loaded machine.
    const ms = fakeMicrosoft(undefined, { pending: 2, interval: 1 })
    const code = await startDeviceCode({ fetch: ms.fetch, clientId: 'cid' })
    const started = Date.now()
    const got = await pollToken({ fetch: ms.fetch, clientId: 'cid', ...code })
    const took = Date.now() - started
    expect(got.refreshToken).toBe(ms.refresh)
    expect(took).toBeGreaterThanOrEqual(2900)
    expect(took).toBeLessThan(25_000)
  }, 60_000)

  test('expired_code_says_so', async () => {
    // Microsoft says the code has run out.
    const ms = fakeMicrosoft((url) => (url.endsWith('/token') ? { status: 400, json: { error: 'expired_token', error_description: 'AADSTS70020: The provided value for the input parameter device_code was expired.', error_codes: [70020] } } : undefined))
    const time = fakeTime()
    const code = await startDeviceCode({ fetch: ms.fetch, clientId: 'cid', now: time.clock() })
    const error = await pollToken({ fetch: ms.fetch, clientId: 'cid', ...code, clock: time.clock, sleep: time.sleep }).catch((e) => e)
    expect(error).toBeInstanceOf(MicrosoftError)
    expect(error.message).toBe(EXPIRED)

    // Or the clock passes the code's end while Microsoft still says "pending": we stop asking.
    const forever = fakeMicrosoft(undefined, { pending: 1_000_000, expiresIn: 30, interval: 5 })
    const t2 = fakeTime()
    const c2 = await startDeviceCode({ fetch: forever.fetch, clientId: 'cid', now: t2.clock() })
    await expect(pollToken({ fetch: forever.fetch, clientId: 'cid', ...c2, clock: t2.clock, sleep: t2.sleep })).rejects.toThrow(EXPIRED)
    expect(forever.polls()).toBeLessThanOrEqual(6)

    // Through the Connect button: the status says so, in those words.
    const lines = []
    const svc = service({ ...settingsOf(forever, { refresh_token: '' }), keep: async () => {}, status: async (l) => void lines.push(l), fetch: forever.fetch, clock: t2.clock, sleep: t2.sleep })
    const result = await svc.connect()
    expect(await result.finished).toBe(false)
    expect(lines.at(-1)).toBe(`▲ ${EXPIRED}`)

    // Saying no is its own sentence.
    expect(tokenFailure({ error: 'authorization_declined', error_codes: [70019] }).message).toBe(DECLINED)
  })

  test('consent_refused_sentence', async () => {
    expect(CONSENT_REFUSED).toBe('Your organisation does not allow Alexia to connect. Ask its IT, or use a personal account.')
    const aadsts = (code) => ({
      error: 'invalid_grant',
      error_description: `AADSTS${code}: The user or administrator has not consented to use the application with ID 'x'. Trace ID: 0000 Correlation ID: 1111`,
      error_codes: [code],
      trace_id: '0000',
    })
    for (const code of [65001, 90094, 53003, 50105]) expect(tokenFailure(aadsts(code)).message, String(code)).toBe(CONSENT_REFUSED)
    // The code only in the description still counts.
    expect(tokenFailure({ error: 'invalid_grant', error_description: 'AADSTS65001: consent required' }).message).toBe(CONSENT_REFUSED)
    // A plain revoked token is not the organisation's doing.
    expect(tokenFailure(aadsts(70008)).message).toBe(REFUSED)

    // At the poll: a school tenant refusing the app ends the sign-in with the DY-02 sentence,
    // on the settings screen, and nothing of Microsoft's reply.
    const school = fakeMicrosoft((url) => (url.endsWith('/token') ? { status: 400, json: aadsts(65001) } : undefined), { pending: 0 })
    const time = fakeTime()
    const lines = []
    const svc = service({ ...settingsOf(school, { refresh_token: '', tenant: 'school.example.edu' }), keep: async () => {}, status: async (l) => void lines.push(l), fetch: school.fetch, clock: time.clock, sleep: time.sleep })
    const result = await svc.connect()
    expect(await result.finished).toBe(false)
    expect(lines.at(-1)).toBe(`▲ ${CONSENT_REFUSED}`)
    expect(JSON.stringify(lines)).not.toMatch(/AADSTS|Trace|Correlation/)

    // At a refresh: an organisation that withdraws consent later says the same, in the tool's
    // answer and on the settings screen.
    const later = fakeMicrosoft((url, init) => (url.endsWith('/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token' ? { status: 400, json: aadsts(65001) } : undefined))
    const seen = []
    const svc2 = service({ ...settingsOf(later), keep: async () => {}, status: async (l) => void seen.push(l), fetch: later.fetch })
    const answer = await svc2.mailList({})
    expect(answer).toMatchObject({ isError: true, content: [{ text: CONSENT_REFUSED }] })
    expect(seen).toEqual([`▲ ${CONSENT_REFUSED}`])
  })

  test('refresh rotates, retries a 401 once, and a missing sign-in is a sentence', async () => {
    const rotated = ['rotated', 'refresh', 'token'].join('-')
    let first = true
    const ms = fakeMicrosoft((url, init) => {
      if (url.endsWith('/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token' && first) {
        first = false
        return { status: 200, json: { access_token: 'a1', refresh_token: rotated, expires_in: 3600 } }
      }
      return undefined
    })
    const kept = []
    let now = 0
    const tokens = new Tokens({ read: settingsOf(ms, { tenant: '' }).settings, fetch: ms.fetch, clock: () => now, rotate: async (t) => void kept.push(t) })
    expect(await tokens.access()).toBe('a1')
    expect(kept).toEqual([rotated])
    const refresh = ms.calls[0]
    expect(refresh.url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token')
    expect(form(refresh).get('scope')).toBe(SCOPES.join(' '))
    expect(await tokens.access()).toBe('a1')
    expect(ms.calls).toHaveLength(1)
    now = 3600_000 - 30_000 // inside the last minute: refreshed again
    expect(await tokens.access()).toBe(ms.access)
    expect(ms.calls).toHaveLength(2)

    await expect(new Tokens({ read: async () => ({ client_id: 'id' }), fetch: ms.fetch }).access()).rejects.toThrow(NOT_CONNECTED)

    // Graph 401 twice: the sign-in is gone.
    const denied = fakeMicrosoft((url) => (url.startsWith('https://graph.microsoft.com') ? { status: 401, json: { error: { code: 'InvalidAuthenticationToken', message: 'secret details' } } } : undefined))
    const t2 = new Tokens({ read: settingsOf(denied).settings, fetch: denied.fetch })
    const e = await call(t2, { url: 'https://graph.microsoft.com/v1.0/me' }).catch((x) => x)
    expect(e.message).toBe(REFUSED)
    expect(denied.calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(2)
    expect(denied.calls.filter((c) => c.url.startsWith('https://graph'))).toHaveLength(2)
  })

  test('the tenant is common by default, and nothing odd goes into a URL', () => {
    expect(tenantOf('')).toBe('common')
    expect(tenantOf(undefined)).toBe('common')
    expect(tenantOf(' consumers ')).toBe('consumers')
    expect(tenantOf('9188040d-6c67-4c5b-b112-36a304b66dad')).toBe('9188040d-6c67-4c5b-b112-36a304b66dad')
    for (const bad of ['common/../x', 'evil.com/path', 'a b', '?x=1']) expect(() => tenantOf(bad), bad).toThrow(MicrosoftError)
  })

  test('tokens_never_in_output', async () => {
    const ms = fakeMicrosoft((url) => {
      const u = new URL(url)
      if (u.hostname !== 'graph.microsoft.com') return undefined
      if (u.pathname.endsWith('/me/calendarView')) return { status: 200, json: { value: [{ id: 'e1', subject: 'Deadline thesis', isAllDay: false, start: { dateTime: '2030-03-04T10:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2030-03-04T11:00:00.0000000', timeZone: 'UTC' } }] } }
      if (u.pathname.endsWith('/me/events')) return { status: 201, json: { id: 'new1' } }
      if (u.pathname.includes('/mailFolders/')) return { status: 200, json: { id: `folder-${u.pathname.split('/').at(-1)}` } }
      if (u.pathname.endsWith('/messages/m1')) return { status: 200, json: { id: 'm1', body: { contentType: 'text', content: 'hello' } } }
      if (u.pathname.endsWith('/messages')) return { status: 200, json: { value: [{ id: 'm1', subject: 'Hi', isRead: false, receivedDateTime: '2030-03-04T06:00:00Z' }] } }
      if (u.pathname.endsWith('/me/contacts')) return { status: 200, json: { value: [{ displayName: 'Ann' }] } }
      return undefined
    })
    const { values, settings } = settingsOf(ms, { refresh_token: '' })
    const kept = {}
    const lines = []
    const outputs = []
    const logged = []
    for (const stream of ['error', 'log', 'warn', 'info', 'debug']) {
      vi.spyOn(console, stream).mockImplementation((...args) => void logged.push(args.map(String).join(' ')))
    }
    const time = fakeTime()
    const svc = service({
      settings,
      keep: async (key, value) => {
        kept[key] = value
        values[key] = value
      },
      status: async (line) => void lines.push(line),
      fetch: ms.fetch,
      clock: time.clock,
      sleep: time.sleep,
    })

    outputs.push(await svc.calendarEvents({ from: '2030-03-04', to: '2030-03-05' })) // not connected yet
    const connecting = await svc.connect()
    outputs.push(connecting)
    // The user code and the page are shown: they are for a person.
    expect(connecting.content[0].text).toContain('ABCD-EFGH')
    expect(connecting.content[0].text).toContain('https://microsoft.com/devicelogin')
    expect(connecting._meta['alexia/card']).toEqual({ title: 'Connect Microsoft', fields: { Code: 'ABCD-EFGH' }, url: 'https://microsoft.com/devicelogin' })
    expect(lines).toContain('▲ Open https://microsoft.com/devicelogin and enter the code ABCD-EFGH')
    expect(await connecting.finished).toBe(true)
    expect(kept.refresh_token).toBe(ms.refresh)
    expect(lines.at(-1)).toBe('● Connected')

    for (const [name, , handler] of tools(svc)) {
      if (name === 'connect') continue
      outputs.push(await handler({ from: '2030-03-04', to: '2030-03-05', id: 'm1', query: 'Ann', title: 'x', start: '2030-03-06', now: time.clock() }))
    }
    // And a revoked token on the way out.
    values.refresh_token = 'revoked-elsewhere'
    svc.forget()
    outputs.push(await svc.mailList({}))

    expect(outputs.filter((o) => !o.isError).length).toBeGreaterThanOrEqual(7)
    expect(outputs.at(-1).content[0].text).toBe(REFUSED)
    const seen = JSON.stringify([outputs, lines, logged])
    for (const secret of [ms.refresh, ms.access, ms.deviceCode, 'revoked-elsewhere']) expect(seen).not.toContain(secret)
    // Graph only ever saw the access token as a bearer header.
    const graph = ms.calls.filter((c) => c.url.startsWith('https://graph.microsoft.com'))
    expect(graph.length).toBeGreaterThan(0)
    expect(graph.every((c) => !c.url.includes(ms.access) && !c.url.includes(ms.refresh))).toBe(true)
  })

  test('connect needs a client id, and a sign-in the host will not keep lasts the run', async () => {
    const ms = fakeMicrosoft(undefined, { pending: 0 })
    const refused = await service({ settings: async () => ({}), keep: async () => {}, fetch: ms.fetch }).connect()
    expect(refused.isError).toBe(true)
    expect(ms.calls).toEqual([])

    const bad = await service({ settings: async () => ({ client_id: 'x', tenant: 'a/b' }), keep: async () => {}, fetch: ms.fetch }).connect()
    expect(bad.isError).toBe(true)

    const time = fakeTime()
    const lines = []
    const svc = service({
      ...settingsOf(ms, { refresh_token: '' }),
      keep: async () => {
        throw new Error('settings/set: only status keys')
      },
      status: async (l) => void lines.push(l),
      fetch: ms.fetch,
      clock: time.clock,
      sleep: time.sleep,
    })
    const result = await svc.connect()
    expect(await result.finished).toBe(true)
    expect(lines.at(-1)).toBe('▲ Connected until Alexia restarts: the sign-in could not be saved in the keychain')
    expect(await svc.tokens.connected()).toBe(true)

    // A second press stops the first poll; only the second one speaks.
    const slow = fakeMicrosoft(undefined, { pending: 3 })
    const t2 = fakeTime()
    const said = []
    const twice = service({ ...settingsOf(slow, { refresh_token: '' }), keep: async () => {}, status: async (l) => void said.push(l), fetch: slow.fetch, clock: t2.clock, sleep: t2.sleep })
    const one = await twice.connect()
    const two = await twice.connect()
    expect(await one.finished).toBe(false)
    expect(await two.finished).toBe(true)
    expect(said.at(-1)).toBe('● Connected')
    expect(said).not.toContain('▲ The sign-in was stopped.')
  })
})
