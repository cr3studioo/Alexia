// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { APPROVAL_MS, NEEDS_YES, rawMessage } from '../mail.js'
import { TOKEN_URL } from '../oauth.js'
import { fakeGoogle, settingsOf } from './fake.js'

process.env.ALEXIA_PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const { GMAIL_SEND, RECONNECT, sendTools, service, tools } = await import('../index.js')

const NOW = Date.parse('2030-03-04T09:00:00Z')

/** A token shaped the way the mail desk's `send_draft` makes one, issued at `at`. */
const tokenAt = (at) => `${at}.${randomBytes(24).toString('base64url')}`

/**
 * The mail desk's half, played by a fake: `approve(token, message)` makes a yes for that exact
 * message, and `mail.approval` confirms it once. Every question it was asked is recorded.
 */
function fakeDesk() {
  const yeses = new Map()
  const asked = []
  const capability = async (cap, args) => {
    asked.push({ cap, args })
    if (cap !== 'mail.approval') throw new Error(`unexpected capability ${cap}`)
    const want = yeses.get(args.token)
    yeses.delete(args.token)
    const approved = want !== undefined && want.to === args.to && want.subject === args.subject && want.text === args.text && want.replyTo === args.replyTo
    return { content: [{ type: 'text', text: approved ? 'yes' : 'no' }], structuredContent: { approved } }
  }
  return { capability, asked, approve: (token, message) => yeses.set(token, message) }
}

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

function setup({ clock = () => NOW } = {}) {
  const google = gmail()
  const desk = fakeDesk()
  const lines = []
  const svc = service({
    ...settingsOf(google),
    keep: async () => {},
    status: async (line) => void lines.push(line),
    capability: desk.capability,
    fetch: google.fetch,
    clock,
  })
  return { google, desk, svc, lines }
}

const message = { to: 'Jana Nová <jana@example.cz>', subject: 'Re: Oběd', text: 'Ahoj Jano,\nve čtvrtek to platí.\nPetr' }

describe('mail.send', () => {
  test('refuses_without_token', async () => {
    const { google, desk, svc } = setup()
    for (const approved_draft of [undefined, '', 'yes', `${NOW}.short`, 'I-approve-this-message-trust-me-please-0000']) {
      const result = await svc.mailSend({ ...message, ...(approved_draft !== undefined && { approved_draft }) })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toBe(NEEDS_YES)
    }
    // A well-shaped token the desk never made: the desk says no, and nothing is sent.
    const forged = await svc.mailSend({ ...message, approved_draft: tokenAt(NOW) })
    expect(forged.isError).toBe(true)
    expect(forged.content[0].text).toBe(NEEDS_YES)
    // A real yes for a different message does not cover this one.
    const other = tokenAt(NOW)
    desk.approve(other, { ...message, text: 'Something else' })
    expect((await svc.mailSend({ ...message, approved_draft: other })).content[0].text).toBe(NEEDS_YES)

    expect(sends(google)).toEqual([])
    // Only the two well-shaped tokens got as far as asking the desk.
    expect(desk.asked.length).toBe(2)
  })

  test('sends_with_token_once', async () => {
    const { google, desk, svc } = setup()
    const token = tokenAt(NOW - 1_000)
    desk.approve(token, message)

    const sent = await svc.mailSend({ ...message, approved_draft: token })
    expect(sent.isError).toBeUndefined()
    expect(sent.structuredContent).toEqual({ id: 'sent-1' })
    expect(sent.content[0].text).toBe('Sent to jana@example.cz.')

    const [post] = sends(google)
    expect(post.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
    const raw = Buffer.from(JSON.parse(post.body).raw, 'base64url').toString('utf8')
    const [head, body] = raw.split('\r\n\r\n')
    expect(head).toContain('To: jana@example.cz')
    expect(head).toMatch(/^Subject: =\?UTF-8\?B\?/m)
    expect(head).toContain('Content-Type: text/plain; charset="UTF-8"')
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(message.text.replace(/\n/g, '\r\n'))
    // Sent straight, never by way of Gmail's drafts.
    expect(google.calls.some((c) => c.url.includes('/drafts'))).toBe(false)

    // The same token again: refused here, before the desk or Google hears of it.
    desk.approve(token, message)
    const again = await svc.mailSend({ ...message, approved_draft: token })
    expect(again.isError).toBe(true)
    expect(again.content[0].text).toContain(NEEDS_YES)
    expect(sends(google).length).toBe(1)
    expect(desk.asked.length).toBe(1)

    // A reply threads under the original.
    const reply = tokenAt(NOW)
    const answer = { ...message, replyTo: 'orig1' }
    desk.approve(reply, answer)
    expect((await svc.mailSend({ ...answer, approved_draft: reply })).isError).toBeUndefined()
    const second = sends(google)[1]
    const parsed = JSON.parse(second.body)
    expect(parsed.threadId).toBe('t-orig')
    const replyRaw = Buffer.from(parsed.raw, 'base64url').toString('utf8')
    expect(replyRaw).toContain('In-Reply-To: <abc@mail.example>')
    expect(replyRaw).toContain('References: <root@mail.example> <abc@mail.example>')
  })

  test('token_expires', async () => {
    let now = NOW
    const { google, desk, svc } = setup({ clock: () => now })
    const token = tokenAt(NOW)
    desk.approve(token, message)
    now = NOW + APPROVAL_MS + 1
    const late = await svc.mailSend({ ...message, approved_draft: token })
    expect(late.isError).toBe(true)
    expect(late.content[0].text).toContain(NEEDS_YES)
    expect(late.content[0].text).toContain('ran out')
    // Refused on the clock alone: the desk was never asked, Google never heard.
    expect(desk.asked).toEqual([])
    expect(sends(google)).toEqual([])

    // Just inside the minute still works.
    const fresh = tokenAt(now - APPROVAL_MS + 1_000)
    desk.approve(fresh, message)
    expect((await svc.mailSend({ ...message, approved_draft: fresh })).isError).toBeUndefined()
    // A token dated in the future is no yes at all.
    const ahead = tokenAt(now + 60_000)
    desk.approve(ahead, message)
    expect((await svc.mailSend({ ...message, approved_draft: ahead })).content[0].text).toBe(NEEDS_YES)
    expect(sends(google).length).toBe(1)
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
    const desk = fakeDesk()
    const lines = []
    const fetch = async (input, init) => {
      if (String(input) === TOKEN_URL) {
        return new globalThis.Response(JSON.stringify({ access_token: 'a-b', expires_in: 3599, scope: 'https://www.googleapis.com/auth/gmail.readonly' }), { status: 200 })
      }
      if (String(input).endsWith('/messages/send')) return new globalThis.Response(JSON.stringify({ error: { code: 403 } }), { status: 403 })
      return base.fetch(input, init)
    }
    const svc = service({ ...settingsOf(base), keep: async () => {}, status: async (l) => void lines.push(l), capability: desk.capability, fetch, clock: () => NOW })
    const token = tokenAt(NOW)
    desk.approve(token, message)
    const result = await svc.mailSend({ ...message, approved_draft: token })
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
