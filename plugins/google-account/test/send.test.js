// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { askToSend, NOT_SENT, rawMessage } from '../mail.js'
import { TOKEN_URL } from '../oauth.js'
import { fakeGoogle, settingsOf } from './fake.js'

const here = dirname(fileURLToPath(import.meta.url))
process.env.ALEXIA_PLUGIN_DIR = join(here, '..')
const { GMAIL_SEND, RECONNECT, sendTools, service, tools } = await import('../index.js')

const NOW = Date.parse('2030-03-04T09:00:00Z')

/**
 * The owner, played by a fake host: `answer(params)` is what they do with the question (an MCP
 * `elicitation/create` result, a throw, or a promise that never settles). Every question asked
 * is recorded with its options.
 */
function owner(answer) {
  const asked = []
  const elicit = async (params, options) => {
    asked.push({ params, options })
    return typeof answer === 'function' ? answer(params) : answer
  }
  return { elicit, asked }
}

const YES = { action: 'accept', content: { send: true } }

/** Google answering `messages/send` (and the original's headers, for a reply). */
function gmail() {
  return fakeGoogle((url, init) => {
    const u = new URL(url)
    if (u.hostname !== 'gmail.googleapis.com') return undefined
    if (u.pathname.endsWith('/messages/send') && init.method === 'POST') return { status: 200, json: { id: 'sent-1', threadId: 't-1', labelIds: ['SENT'] } }
    if (u.pathname.endsWith('/messages/orig1')) {
      return {
        status: 200,
        json: {
          id: 'orig1',
          threadId: 't-orig',
          payload: {
            headers: [
              { name: 'Message-ID', value: '<abc@mail.example>' },
              { name: 'References', value: '<root@mail.example>' },
            ],
          },
        },
      }
    }
    return undefined
  })
}

const sends = (google) => google.calls.filter((c) => c.url.includes('gmail.googleapis.com') && c.method === 'POST')

/** What went out: the decoded `raw` of a send, split into its head and its decoded text. */
function decoded(post) {
  const raw = Buffer.from(JSON.parse(post.body).raw, 'base64url').toString('utf8')
  const [head, body] = raw.split('\r\n\r\n')
  return { head, text: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') }
}

function setup({ answer = YES, elicit, askMs } = {}) {
  const google = gmail()
  const host = owner(answer)
  const lines = []
  const svc = service({
    ...settingsOf(google),
    keep: async () => {},
    status: async (line) => void lines.push(line),
    elicit: elicit === undefined ? host.elicit : elicit === null ? undefined : elicit,
    fetch: google.fetch,
    clock: () => NOW,
    ...(askMs !== undefined && { askMs }),
  })
  return { google, host, svc, lines }
}

const message = { to: 'Jana Nová <jana@example.cz>', subject: 'Re: Oběd', text: 'Ahoj Jano,\nve čtvrtek to platí.\nPetr' }

describe('mail.send', () => {
  test('sends exactly the message the owner was shown, on their yes', async () => {
    const { google, host, svc } = setup()
    const sent = await svc.mailSend(message)
    expect(sent.isError).toBeUndefined()
    expect(sent.structuredContent).toEqual({ sent: true, id: 'sent-1' })
    expect(sent.content[0].text).toBe('Sent to jana@example.cz.')

    // Asked first, once, with the exact recipients, subject and text.
    expect(host.asked.length).toBe(1)
    const [{ params, options }] = host.asked
    expect(params.mode).toBe('form')
    expect(params.message).toBe('Send this email now?\n\nTo: jana@example.cz\nSubject: Re: Oběd\n\nAhoj Jano,\nve čtvrtek to platí.\nPetr')
    expect(params.requestedSchema.required).toEqual(['send'])
    expect(options.timeout).toBeGreaterThan(0)

    const [post] = sends(google)
    expect(post.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
    const out = decoded(post)
    expect(out.head).toContain('To: jana@example.cz')
    expect(out.head).not.toMatch(/^(Cc|Bcc):/im)
    expect(out.head).toMatch(/^Subject: =\?UTF-8\?B\?/m)
    expect(out.head).toContain('Content-Type: text/plain; charset="UTF-8"')
    expect(out.text).toBe(message.text.replace(/\n/g, '\r\n'))
    // Sent straight, never by way of Gmail's drafts.
    expect(google.calls.some((c) => c.url.includes('/drafts'))).toBe(false)

    // A reply threads under the original, and still asks.
    expect((await svc.mailSend({ ...message, replyTo: 'orig1' })).isError).toBeUndefined()
    expect(host.asked.length).toBe(2)
    const parsed = JSON.parse(sends(google)[1].body)
    expect(parsed.threadId).toBe('t-orig')
    const replyRaw = Buffer.from(parsed.raw, 'base64url').toString('utf8')
    expect(replyRaw).toContain('In-Reply-To: <abc@mail.example>')
    expect(replyRaw).toContain('References: <root@mail.example> <abc@mail.example>')
  })

  test('decline, cancel and a yes-less accept send nothing', async () => {
    for (const [answer, reason] of [
      [{ action: 'decline' }, 'no'],
      [{ action: 'accept', content: { send: false } }, 'no'],
      [{ action: 'accept', content: {} }, 'no'],
      [{ action: 'accept' }, 'no'],
      [{ action: 'cancel' }, 'cancel'],
      [{ action: 'something else' }, 'unavailable'],
      [null, 'unavailable'],
    ]) {
      const { google, host, svc } = setup({ answer })
      const result = await svc.mailSend(message)
      expect(result.isError, JSON.stringify(answer)).toBe(true)
      expect(result.structuredContent).toEqual({ sent: false, reason })
      expect(result.content[0].text).toBe(NOT_SENT[reason])
      expect(host.asked.length).toBe(1)
      expect(sends(google)).toEqual([])
    }
  })

  test('no answer in time sends nothing, even if a yes comes later', async () => {
    // The host's own timeout: the request fails with MCP's RequestTimeout.
    const timedOut = setup({ answer: () => Promise.reject(Object.assign(new Error('Request timed out'), { code: -32001 })) })
    const first = await timedOut.svc.mailSend(message)
    expect(first.structuredContent).toEqual({ sent: false, reason: 'timeout' })
    expect(first.content[0].text).toBe(NOT_SENT.timeout)
    expect(sends(timedOut.google)).toEqual([])

    // A host that never answers: the plugin's own clock ends the question, and a yes that
    // arrives after that sends nothing.
    let late
    const silent = setup({ answer: () => new Promise((resolve) => (late = resolve)), askMs: 50 })
    const second = await silent.svc.mailSend(message)
    expect(second.structuredContent).toEqual({ sent: false, reason: 'timeout' })
    expect(silent.host.asked[0].options.timeout).toBe(50)
    late(YES)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sends(silent.google)).toEqual([])
  })

  test('a host that offers no elicitation sends nothing', async () => {
    // No elicit at all, and an SDK that refuses because the client cannot ask.
    const refuse = async () => {
      throw Object.assign(new Error('Client does not support form elicitation.'), { code: 'CapabilityNotSupported' })
    }
    for (const elicit of [null, refuse]) {
      const { google, svc } = setup({ elicit })
      const result = await svc.mailSend(message)
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toEqual({ sent: false, reason: 'unavailable' })
      expect(result.content[0].text).toBe('Not sent: Alexia could not ask you here, and nothing is sent without your yes.')
      expect(sends(google)).toEqual([])
    }
    expect(await askToSend(undefined, { to: ['a@example.com'], subject: '', text: 't' })).toBe('unavailable')
  })

  test('a text changed after the ask is not sent', async () => {
    // While the owner looks, the caller changes its arguments, and the answer carries other
    // values: neither reaches Google. What goes out is what was shown.
    const args = { ...message }
    const { google, host, svc } = setup({
      answer: () => {
        args.text = 'Please wire 5000 EUR to the account below.'
        args.to = 'someone@elsewhere.example'
        args.subject = 'Urgent'
        return { action: 'accept', content: { send: true, text: 'Changed in the answer', to: 'other@elsewhere.example' } }
      },
    })
    expect((await svc.mailSend(args)).isError).toBeUndefined()
    expect(host.asked[0].params.message).toContain(message.text)
    const out = decoded(sends(google)[0])
    expect(out.text).toBe(message.text.replace(/\n/g, '\r\n'))
    expect(out.head).toContain('To: jana@example.cz')
    expect(out.head).not.toContain('elsewhere')
    expect(sends(google).length).toBe(1)
  })

  test('no argument or capability lets a caller skip the ask', async () => {
    // Every old or invented "already approved" argument is ignored: the owner is still asked.
    const tries = [
      { approved_draft: `${NOW}.${'a'.repeat(32)}` },
      { approved: true, confirmed: true, yes: true, skipAsk: true, ask: false, send: true },
      { _meta: { approved: true } },
    ]
    const declined = setup({ answer: { action: 'decline' } })
    const noHost = setup({ elicit: null })
    for (const extra of tries) {
      expect((await declined.svc.mailSend({ ...message, ...extra })).structuredContent).toEqual({ sent: false, reason: 'no' })
      expect((await noHost.svc.mailSend({ ...message, ...extra })).structuredContent).toEqual({ sent: false, reason: 'unavailable' })
    }
    expect(declined.host.asked.length).toBe(tries.length)
    expect(sends(declined.google)).toEqual([])
    expect(sends(noHost.google)).toEqual([])

    // Every send is its own question: a yes is not remembered for the next one.
    const { host, svc } = setup()
    await svc.mailSend(message)
    await svc.mailSend(message)
    expect(host.asked.length).toBe(2)

    // Nothing in the tool or the manifest offers a way around the question.
    const [[, config]] = sendTools(svc)
    expect(JSON.stringify(config.inputSchema)).not.toContain('approved')
    const manifest = JSON.parse(readFileSync(join(here, '..', 'plugin.json'), 'utf8'))
    expect(manifest.requires.map((r) => r.cap)).not.toContain('mail.approval')
    expect(manifest.provides).not.toContain('mail.approval')
  })

  test('bad arguments are refused before the owner is asked', async () => {
    const { google, host, svc } = setup()
    for (const bad of [{ ...message, text: '  ' }, { ...message, to: '' }, { ...message, to: 'not an address' }, { ...message, subject: 'a\r\nBcc: x@example.com' }]) {
      expect((await svc.mailSend(bad)).isError).toBe(true)
    }
    expect(host.asked).toEqual([])
    expect(sends(google)).toEqual([])
  })

  test('annotations_open_world_and_destructive', () => {
    const svc = service({ settings: async () => ({}), keep: async () => {} })
    const all = [...tools(svc), ...sendTools(svc)]
    const senders = all.filter(([, c]) => c._meta?.['alexia/provides']?.includes('mail.send'))
    expect(senders.map(([name]) => name)).toEqual(['mail_send'])
    const [[, config]] = senders
    expect(config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true })
    expect(config._meta['alexia/provides']).toEqual(['mail.send'])
    expect(config.inputSchema).toBeDefined()
    // No other tool is destructive.
    for (const [name, c] of all) if (name !== 'mail_send') expect(c.annotations.destructiveHint, name).toBe(false)
  })

  test('a sign-in without sending says to reconnect', async () => {
    // Google's refresh answer names what the sign-in allows; one from before P3-24 lacks gmail.send.
    const base = fakeGoogle()
    const host = owner(YES)
    const lines = []
    const fetch = async (input, init) => {
      if (String(input) === TOKEN_URL) {
        return new globalThis.Response(JSON.stringify({ access_token: 'a-b', expires_in: 3599, scope: 'https://www.googleapis.com/auth/gmail.readonly' }), { status: 200 })
      }
      if (String(input).endsWith('/messages/send')) return new globalThis.Response(JSON.stringify({ error: { code: 403 } }), { status: 403 })
      return base.fetch(input, init)
    }
    const svc = service({ ...settingsOf(base), keep: async () => {}, status: async (l) => void lines.push(l), elicit: host.elicit, fetch, clock: () => NOW })
    const result = await svc.mailSend(message)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe(RECONNECT)
    expect(lines).toContain(`▲ ${RECONNECT}`)
    await svc.report()
    expect(lines.at(-1)).toBe(`▲ ${RECONNECT}`)
    expect(GMAIL_SEND).toMatch(/gmail\.send$/)
  })

  test('a read gives the headers a reply needs, only when asked', async () => {
    const google = fakeGoogle((url) =>
      url.includes('/messages/m9') ?
        {
          status: 200,
          json: {
            id: 'm9',
            threadId: 't9',
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: 'Jana <jana@example.cz>' },
                { name: 'Reply-To', value: 'office@example.cz' },
                { name: 'Subject', value: 'Oběd' },
              ],
              body: { data: Buffer.from('Ahoj', 'utf8').toString('base64url') },
            },
          },
        }
      : undefined,
    )
    const svc = service({ ...settingsOf(google), keep: async () => {}, fetch: google.fetch })
    expect((await svc.mailRead({ id: 'm9' })).structuredContent).toEqual({ text: 'Ahoj' })
    expect((await svc.mailRead({ id: 'm9', headers: true })).structuredContent).toEqual({
      text: 'Ahoj',
      from: 'Jana <jana@example.cz>',
      to: '',
      subject: 'Oběd',
      threadId: 't9',
      reply_to: 'office@example.cz',
    })
  })

  test('headers cannot be smuggled in', () => {
    expect(() => rawMessage({ to: 'a@example.com\r\nBcc: b@example.com', subject: 's', text: 't' })).toThrow()
    expect(() => rawMessage({ to: 'a@example.com', subject: 's\r\nBcc: b@example.com', text: 't' })).toThrow()
    expect(() => rawMessage({ to: 'not an address', subject: 's', text: 't' })).toThrow()
  })
})
